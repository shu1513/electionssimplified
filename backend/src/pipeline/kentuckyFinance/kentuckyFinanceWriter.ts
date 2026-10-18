import type { Pool, PoolClient } from "pg";
import { isKentuckyReportedIeEnabled } from "../../config/featureFlags.js";

import type { FinanceLabelClassification } from "../finance/financeLabelClassifier.js";
import { upsertFinanceLabelClassification } from "../finance/financeIndustryClassificationService.js";
import {
  MANUAL_PROTECTED_LINK_RETURNING,
  assertLinkWriteNotBlocked,
  manualProtectedLinkAssignments,
  type ManualProtectedLinkRow,
} from "../finance/manualLinkProtection.js";

export type KentuckyFinanceLinkStatus = "active" | "inactive";
export type KentuckyFinanceLinkSource = "manual" | "kref_public_search";
export type KentuckyFinanceDirectCategoryType = "occupation" | "contribution_size";
export type KentuckyFinanceOutsideCategoryType = "donor" | "industry";
export type KentuckyFinanceSupportOppose = "support" | "oppose";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & {
  connect: () => Promise<PoolClient>;
};
type ClientLikeQueryable = Queryable & {
  release?: () => void;
};

export type KentuckyFinanceLinkInput = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  candidateNameNormalized: string;
  officeName: string;
  district?: string | null;
  candidateKey: string;
  committeeKey: string;
  committeeName: string;
  linkStatus?: KentuckyFinanceLinkStatus;
  linkSource?: KentuckyFinanceLinkSource;
  sourceUrl?: string | null;
  lastVerifiedAt?: Date | null;
};

export type KentuckyFinanceSummaryInput = {
  totalReceipts?: number | null;
  directContributionTotal?: number | null;
  totalDisbursements?: number | null;
  cashOnHand?: number | null;
  outsideSupportTotal?: number | null;
  outsideOpposeTotal?: number | null;
  sourceUrl?: string | null;
};

export type KentuckyFinanceDirectBreakdownInput = {
  categoryType: KentuckyFinanceDirectCategoryType;
  categoryName: string;
  amount: number;
  contributorCount?: number | null;
  sourceUrl?: string | null;
};

export type KentuckyFinanceOutsideGroupInput = {
  committeeKey: string;
  committeeName: string;
  supportOppose: KentuckyFinanceSupportOppose;
  amount: number;
  sourceUrl?: string | null;
};

export type KentuckyFinanceOutsideGroupBreakdownInput = {
  committeeKey: string;
  supportOppose: KentuckyFinanceSupportOppose;
  categoryType: KentuckyFinanceOutsideCategoryType;
  categoryName: string;
  amount: number;
  contributorCount?: number | null;
  sourceUrl?: string | null;
};

export type KentuckyFinanceSnapshotInput = {
  db: ConnectableQueryable;
  link: KentuckyFinanceLinkInput;
  syncedAt?: Date;
  summary?: KentuckyFinanceSummaryInput;
  directBreakdowns?: readonly KentuckyFinanceDirectBreakdownInput[];
  outsideGroups?: readonly KentuckyFinanceOutsideGroupInput[];
  outsideGroupBreakdowns?: readonly KentuckyFinanceOutsideGroupBreakdownInput[];
  classifications?: readonly FinanceLabelClassification[];
};

export type KentuckyFinanceSnapshotWriteResult = {
  linkId: string;
  summaryWritten: boolean;
  directBreakdownsWritten: number;
  outsideGroupsWritten: number;
  outsideGroupBreakdownsWritten: number;
};

function requireNonEmpty(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmed;
}

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new Error(`Invalid Kentucky finance election year: ${value}`);
  }
  return value;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

function normalizeNullableDate(value: Date | null | undefined): string | null {
  if (!value) {
    return null;
  }
  if (Number.isNaN(value.getTime())) {
    throw new Error("Invalid Kentucky finance timestamp");
  }
  return value.toISOString();
}

function normalizeAmount(value: number, fieldName: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be a nonnegative number`);
  }
  return value;
}

function normalizeNullableAmount(value: number | null | undefined, fieldName: string): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  return normalizeAmount(value, fieldName);
}

function normalizeNullableSignedAmount(value: number | null | undefined, fieldName: string): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number`);
  }
  return value;
}

function normalizeNullableCount(value: number | null | undefined): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("Kentucky finance contributor count must be a nonnegative integer");
  }
  return value;
}

function canOpenTransaction(db: Queryable): db is ConnectableQueryable {
  return (
    typeof (db as ConnectableQueryable).connect === "function" &&
    typeof (db as ClientLikeQueryable).release !== "function"
  );
}

function isClientLikeQueryable(db: Queryable): db is ClientLikeQueryable {
  return typeof (db as ClientLikeQueryable).release === "function";
}

function validateKentuckyFinanceLinkInput(link: KentuckyFinanceLinkInput): void {
  requireNonEmpty(link.candidateId, "candidate id");
  requireNonEmpty(link.electionId, "election id");
  normalizeElectionYear(link.electionYear);
  requireNonEmpty(link.candidateNameNormalized, "Kentucky finance candidate name");
  requireNonEmpty(link.officeName, "Kentucky finance office name");
  requireNonEmpty(link.candidateKey, "Kentucky candidate key");
  requireNonEmpty(link.committeeKey, "Kentucky committee key");
  requireNonEmpty(link.committeeName, "Kentucky committee name");
  normalizeNullableDate(link.lastVerifiedAt);
}

function outsideGroupKey(group: Pick<KentuckyFinanceOutsideGroupInput, "committeeKey" | "supportOppose">): string {
  return `${normalizeKey(group.committeeKey)}\u0000${group.supportOppose}`;
}

function validateKentuckyFinanceSnapshotInput(input: KentuckyFinanceSnapshotInput): void {
  validateKentuckyFinanceLinkInput(input.link);
  if (input.outsideGroupBreakdowns && !input.outsideGroups) {
    throw new Error("Kentucky outside group breakdowns require outside groups in the same snapshot");
  }
  if (input.outsideGroupBreakdowns?.length) {
    const groupKeys = new Set((input.outsideGroups ?? []).map(outsideGroupKey));
    for (const breakdown of input.outsideGroupBreakdowns) {
      if (!groupKeys.has(outsideGroupKey(breakdown))) {
        throw new Error("Kentucky outside group breakdowns require matching outside groups in the same snapshot");
      }
    }
  }
}

async function withKentuckyFinanceTransaction<T>(db: Queryable, work: (tx: Queryable) => Promise<T>): Promise<T> {
  if (!canOpenTransaction(db)) {
    if (isClientLikeQueryable(db)) {
      throw new Error("Kentucky finance snapshot writes must receive a Pool, not a PoolClient");
    }
    throw new Error("Kentucky finance snapshot writes must receive a Pool");
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function upsertKentuckyFinanceLink(input: {
  db: Queryable;
  link: KentuckyFinanceLinkInput;
}): Promise<{ linkId: string }> {
  validateKentuckyFinanceLinkInput(input.link);

  const result = await input.db.query<ManualProtectedLinkRow>(
    `
      INSERT INTO public.ky_candidate_finance_links (
        candidate_id,
        election_id,
        election_year,
        candidate_name_normalized,
        office_name,
        district,
        candidate_key,
        committee_key,
        committee_name,
        link_status,
        link_source,
        source_url,
        last_verified_at
      )
      VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz)
      ON CONFLICT (candidate_id, election_id, committee_key)
      DO UPDATE SET
        candidate_name_normalized = EXCLUDED.candidate_name_normalized,
        office_name = EXCLUDED.office_name,
        district = EXCLUDED.district,
        candidate_key = EXCLUDED.candidate_key,
        committee_name = EXCLUDED.committee_name,
        ${manualProtectedLinkAssignments("ky_candidate_finance_links")},
        source_url = EXCLUDED.source_url,
        last_verified_at = EXCLUDED.last_verified_at
      RETURNING ${MANUAL_PROTECTED_LINK_RETURNING}
    `,
    [
      requireNonEmpty(input.link.candidateId, "candidate id"),
      requireNonEmpty(input.link.electionId, "election id"),
      normalizeElectionYear(input.link.electionYear),
      requireNonEmpty(input.link.candidateNameNormalized, "Kentucky finance candidate name"),
      requireNonEmpty(input.link.officeName, "Kentucky finance office name"),
      normalizeOptionalText(input.link.district),
      normalizeKey(requireNonEmpty(input.link.candidateKey, "Kentucky candidate key")),
      normalizeKey(requireNonEmpty(input.link.committeeKey, "Kentucky committee key")),
      requireNonEmpty(input.link.committeeName, "Kentucky committee name"),
      input.link.linkStatus ?? "active",
      input.link.linkSource ?? "manual",
      normalizeOptionalText(input.link.sourceUrl),
      normalizeNullableDate(input.link.lastVerifiedAt),
    ]
  );

  assertLinkWriteNotBlocked("Kentucky", result.rows[0], input.link.linkSource ?? "manual", input.link.electionYear);
  const linkId = result.rows[0]?.id;
  if (!linkId) {
    throw new Error("Kentucky finance link upsert did not return an id");
  }
  return { linkId };
}

async function upsertSummary(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  summary: KentuckyFinanceSummaryInput;
  syncedAt: Date;
}): Promise<void> {
  const preserveOutside = input.electionYear === 2026 && isKentuckyReportedIeEnabled();
  await input.db.query(
    `
      INSERT INTO public.ky_candidate_finance_summaries (
        link_id,
        election_year,
        total_receipts,
        direct_contribution_total,
        total_disbursements,
        cash_on_hand,
        outside_support_total,
        outside_oppose_total,
        source_url,
        last_synced_at
      )
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)
      ON CONFLICT (link_id, election_year)
      DO UPDATE SET
        total_receipts = EXCLUDED.total_receipts,
        direct_contribution_total = EXCLUDED.direct_contribution_total,
        total_disbursements = EXCLUDED.total_disbursements,
        cash_on_hand = EXCLUDED.cash_on_hand,
        outside_support_total = CASE WHEN $11::boolean THEN ky_candidate_finance_summaries.outside_support_total ELSE EXCLUDED.outside_support_total END,
        outside_oppose_total = CASE WHEN $11::boolean THEN ky_candidate_finance_summaries.outside_oppose_total ELSE EXCLUDED.outside_oppose_total END,
        source_url = EXCLUDED.source_url,
        last_synced_at = EXCLUDED.last_synced_at
    `,
    [
      requireNonEmpty(input.linkId, "Kentucky finance link id"),
      normalizeElectionYear(input.electionYear),
      normalizeNullableAmount(input.summary.totalReceipts, "total receipts"),
      normalizeNullableAmount(input.summary.directContributionTotal, "direct contribution total"),
      normalizeNullableAmount(input.summary.totalDisbursements, "total disbursements"),
      normalizeNullableSignedAmount(input.summary.cashOnHand, "cash on hand"),
      preserveOutside ? null : normalizeNullableAmount(input.summary.outsideSupportTotal, "outside support total"),
      preserveOutside ? null : normalizeNullableAmount(input.summary.outsideOpposeTotal, "outside oppose total"),
      normalizeOptionalText(input.summary.sourceUrl),
      input.syncedAt.toISOString(),
      preserveOutside,
    ]
  );
}

async function upsertDirectBreakdown(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  breakdown: KentuckyFinanceDirectBreakdownInput;
  syncedAt: Date;
}): Promise<void> {
  await input.db.query(
    `
      INSERT INTO public.ky_candidate_finance_direct_breakdowns (
        link_id,
        election_year,
        category_type,
        category_name,
        amount,
        contributor_count,
        source_url,
        last_synced_at
      )
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::timestamptz)
      ON CONFLICT (link_id, election_year, category_type, category_name)
      DO UPDATE SET
        amount = EXCLUDED.amount,
        contributor_count = EXCLUDED.contributor_count,
        source_url = EXCLUDED.source_url,
        last_synced_at = EXCLUDED.last_synced_at
    `,
    [
      requireNonEmpty(input.linkId, "Kentucky finance link id"),
      normalizeElectionYear(input.electionYear),
      input.breakdown.categoryType,
      requireNonEmpty(input.breakdown.categoryName, "Kentucky finance direct breakdown category"),
      normalizeAmount(input.breakdown.amount, "direct breakdown amount"),
      normalizeNullableCount(input.breakdown.contributorCount),
      normalizeOptionalText(input.breakdown.sourceUrl),
      input.syncedAt.toISOString(),
    ]
  );
}

async function upsertOutsideGroup(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  group: KentuckyFinanceOutsideGroupInput;
  syncedAt: Date;
}): Promise<void> {
  await input.db.query(
    `
      INSERT INTO public.ky_candidate_finance_outside_groups (
        link_id,
        election_year,
        committee_key,
        committee_name,
        support_oppose,
        amount,
        source_url,
        last_synced_at
      )
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::timestamptz)
      ON CONFLICT (link_id, election_year, committee_key, support_oppose)
      DO UPDATE SET
        committee_name = EXCLUDED.committee_name,
        amount = EXCLUDED.amount,
        source_url = EXCLUDED.source_url,
        last_synced_at = EXCLUDED.last_synced_at
    `,
    [
      requireNonEmpty(input.linkId, "Kentucky finance link id"),
      normalizeElectionYear(input.electionYear),
      normalizeKey(requireNonEmpty(input.group.committeeKey, "Kentucky outside group committee key")),
      requireNonEmpty(input.group.committeeName, "Kentucky outside group committee name"),
      input.group.supportOppose,
      normalizeAmount(input.group.amount, "outside group amount"),
      normalizeOptionalText(input.group.sourceUrl),
      input.syncedAt.toISOString(),
    ]
  );
}

async function upsertOutsideGroupBreakdown(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  breakdown: KentuckyFinanceOutsideGroupBreakdownInput;
  syncedAt: Date;
}): Promise<void> {
  await input.db.query(
    `
      INSERT INTO public.ky_candidate_finance_outside_group_breakdowns (
        link_id,
        election_year,
        committee_key,
        support_oppose,
        category_type,
        category_name,
        amount,
        contributor_count,
        source_url,
        last_synced_at
      )
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)
      ON CONFLICT (link_id, election_year, committee_key, support_oppose, category_type, category_name)
      DO UPDATE SET
        amount = EXCLUDED.amount,
        contributor_count = EXCLUDED.contributor_count,
        source_url = EXCLUDED.source_url,
        last_synced_at = EXCLUDED.last_synced_at
    `,
    [
      requireNonEmpty(input.linkId, "Kentucky finance link id"),
      normalizeElectionYear(input.electionYear),
      normalizeKey(requireNonEmpty(input.breakdown.committeeKey, "Kentucky outside breakdown committee key")),
      input.breakdown.supportOppose,
      input.breakdown.categoryType,
      requireNonEmpty(input.breakdown.categoryName, "Kentucky outside breakdown category"),
      normalizeAmount(input.breakdown.amount, "outside group breakdown amount"),
      normalizeNullableCount(input.breakdown.contributorCount),
      normalizeOptionalText(input.breakdown.sourceUrl),
      input.syncedAt.toISOString(),
    ]
  );
}

async function deleteStaleDirectBreakdowns(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  breakdowns: readonly KentuckyFinanceDirectBreakdownInput[];
}): Promise<void> {
  const keys = input.breakdowns.map((breakdown) => ({
    category_type: breakdown.categoryType,
    category_name: requireNonEmpty(breakdown.categoryName, "Kentucky finance direct breakdown category"),
  }));

  await input.db.query(
    `
      DELETE FROM public.ky_candidate_finance_direct_breakdowns
      WHERE link_id = $1::uuid
        AND election_year = $2
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset($3::jsonb) AS keep(
            category_type text,
            category_name text
          )
          WHERE keep.category_type = ky_candidate_finance_direct_breakdowns.category_type
            AND keep.category_name = ky_candidate_finance_direct_breakdowns.category_name
        )
    `,
    [requireNonEmpty(input.linkId, "Kentucky finance link id"), normalizeElectionYear(input.electionYear), JSON.stringify(keys)]
  );
}

async function deleteStaleOutsideGroupBreakdowns(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  breakdowns: readonly KentuckyFinanceOutsideGroupBreakdownInput[];
}): Promise<void> {
  const keys = input.breakdowns.map((breakdown) => ({
    committee_key: normalizeKey(requireNonEmpty(breakdown.committeeKey, "Kentucky outside breakdown committee key")),
    support_oppose: breakdown.supportOppose,
    category_type: breakdown.categoryType,
    category_name: requireNonEmpty(breakdown.categoryName, "Kentucky outside breakdown category"),
  }));

  await input.db.query(
    `
      DELETE FROM public.ky_candidate_finance_outside_group_breakdowns
      WHERE link_id = $1::uuid
        AND election_year = $2
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset($3::jsonb) AS keep(
            committee_key text,
            support_oppose text,
            category_type text,
            category_name text
          )
          WHERE keep.committee_key = ky_candidate_finance_outside_group_breakdowns.committee_key
            AND keep.support_oppose = ky_candidate_finance_outside_group_breakdowns.support_oppose
            AND keep.category_type = ky_candidate_finance_outside_group_breakdowns.category_type
            AND keep.category_name = ky_candidate_finance_outside_group_breakdowns.category_name
        )
    `,
    [requireNonEmpty(input.linkId, "Kentucky finance link id"), normalizeElectionYear(input.electionYear), JSON.stringify(keys)]
  );
}

async function deleteStaleOutsideGroups(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  groups: readonly KentuckyFinanceOutsideGroupInput[];
}): Promise<void> {
  const keys = input.groups.map((group) => ({
    committee_key: normalizeKey(requireNonEmpty(group.committeeKey, "Kentucky outside group committee key")),
    support_oppose: group.supportOppose,
  }));

  await input.db.query(
    `
      DELETE FROM public.ky_candidate_finance_outside_groups
      WHERE link_id = $1::uuid
        AND election_year = $2
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset($3::jsonb) AS keep(
            committee_key text,
            support_oppose text
          )
          WHERE keep.committee_key = ky_candidate_finance_outside_groups.committee_key
            AND keep.support_oppose = ky_candidate_finance_outside_groups.support_oppose
        )
    `,
    [requireNonEmpty(input.linkId, "Kentucky finance link id"), normalizeElectionYear(input.electionYear), JSON.stringify(keys)]
  );
}

export async function replaceKentuckyCandidateFinanceSnapshot(
  input: KentuckyFinanceSnapshotInput
): Promise<KentuckyFinanceSnapshotWriteResult> {
  const syncedAt = input.syncedAt ?? new Date();
  if (Number.isNaN(syncedAt.getTime())) {
    throw new Error("Invalid Kentucky finance sync timestamp");
  }
  validateKentuckyFinanceSnapshotInput(input);
  const electionYear = normalizeElectionYear(input.link.electionYear);

  return await withKentuckyFinanceTransaction(input.db, async (db) => {
    const { linkId } = await upsertKentuckyFinanceLink({ db, link: input.link });
    if (input.summary) {
      await upsertSummary({ db, linkId, electionYear, summary: input.summary, syncedAt });
    }

    for (const breakdown of input.directBreakdowns ?? []) {
      await upsertDirectBreakdown({ db, linkId, electionYear, breakdown, syncedAt });
    }
    await deleteStaleDirectBreakdowns({ db, linkId, electionYear, breakdowns: input.directBreakdowns ?? [] });

    const preserveOutside = electionYear === 2026 && isKentuckyReportedIeEnabled();
    if (!preserveOutside) {
      for (const group of input.outsideGroups ?? []) {
        await upsertOutsideGroup({ db, linkId, electionYear, group, syncedAt });
      }
      for (const breakdown of input.outsideGroupBreakdowns ?? []) {
        await upsertOutsideGroupBreakdown({ db, linkId, electionYear, breakdown, syncedAt });
      }
      await deleteStaleOutsideGroupBreakdowns({ db, linkId, electionYear, breakdowns: input.outsideGroupBreakdowns ?? [] });
      await deleteStaleOutsideGroups({ db, linkId, electionYear, groups: input.outsideGroups ?? [] });
    }

    for (const classification of input.classifications ?? []) {
      await upsertFinanceLabelClassification({ db, classification });
    }

    return {
      linkId,
      summaryWritten: Boolean(input.summary),
      directBreakdownsWritten: input.directBreakdowns?.length ?? 0,
      outsideGroupsWritten: preserveOutside ? 0 : input.outsideGroups?.length ?? 0,
      outsideGroupBreakdownsWritten: preserveOutside ? 0 : input.outsideGroupBreakdowns?.length ?? 0,
    };
  });
}
