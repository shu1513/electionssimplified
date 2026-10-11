import type { Pool, PoolClient } from "pg";

import type { FinanceLabelClassification } from "../finance/financeLabelClassifier.js";
import { upsertFinanceLabelClassification } from "../finance/financeIndustryClassificationService.js";
import {
  MANUAL_PROTECTED_LINK_RETURNING,
  assertLinkWriteNotBlocked,
  manualProtectedLinkAssignments,
  type ManualProtectedLinkRow,
} from "../finance/manualLinkProtection.js";
import { assertSnapshotDbIsNotPoolClient } from "../finance/financeWriterPoolGuard.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & {
  connect?: () => Promise<PoolClient>;
};

export type TennesseeFinanceLinkStatus = "active" | "inactive" | "ambiguous";
export type TennesseeFinanceLinkSource = "manual" | "tncamp_search";
export type TennesseeFinanceDirectCategoryType = "occupation" | "contribution_size";
export type TennesseeFinanceOutsideCategoryType = "donor" | "employer" | "occupation" | "industry";
export type TennesseeFinanceSupportOppose = "support" | "oppose";

export type TennesseeFinanceLinkInput = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  candidateNameNormalized: string;
  officeName: string;
  district?: string | null;
  campCandidateId: string;
  ownerName: string;
  committeeName?: string | null;
  linkStatus?: TennesseeFinanceLinkStatus;
  linkSource?: TennesseeFinanceLinkSource;
  sourceUrl?: string | null;
  reportListUrl?: string | null;
  lastVerifiedAt?: Date | null;
};

export type TennesseeFinanceSummaryInput = {
  totalReceipts?: number | null;
  directContributionTotal?: number | null;
  outsideSupportTotal?: number | null;
  outsideOpposeTotal?: number | null;
  sourceUrl?: string | null;
};

export type TennesseeFinanceDirectBreakdownInput = {
  categoryType: TennesseeFinanceDirectCategoryType;
  categoryName: string;
  amount: number;
  contributorCount?: number | null;
  sourceUrl?: string | null;
};

export type TennesseeFinanceOutsideGroupInput = {
  committeeKey: string;
  committeeName: string;
  supportOppose: TennesseeFinanceSupportOppose;
  amount: number;
  expenditureCount?: number | null;
  sourceUrl?: string | null;
};

export type TennesseeFinanceOutsideGroupBreakdownInput = {
  committeeKey: string;
  supportOppose: TennesseeFinanceSupportOppose;
  categoryType: TennesseeFinanceOutsideCategoryType;
  categoryName: string;
  amount: number;
  contributorCount?: number | null;
  sourceUrl?: string | null;
};

export type TennesseeFinanceSnapshotInput = {
  db: Queryable;
  link: TennesseeFinanceLinkInput;
  syncedAt?: Date;
  summary?: TennesseeFinanceSummaryInput;
  directBreakdowns?: readonly TennesseeFinanceDirectBreakdownInput[];
  outsideGroups?: readonly TennesseeFinanceOutsideGroupInput[];
  outsideGroupBreakdowns?: readonly TennesseeFinanceOutsideGroupBreakdownInput[];
  classifications?: readonly FinanceLabelClassification[];
};

export type TennesseeFinanceSnapshotWriteResult = {
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
    throw new Error(`Invalid Tennessee finance election year: ${value}`);
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

function normalizeCommitteeKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

function normalizeNullableDate(value: Date | null | undefined): string | null {
  if (!value) {
    return null;
  }
  if (Number.isNaN(value.getTime())) {
    throw new Error("Invalid Tennessee finance timestamp");
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

function normalizeNullableCount(value: number | null | undefined): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("Tennessee finance contributor count must be a nonnegative integer");
  }
  return value;
}

function outsideGroupKey(group: Pick<TennesseeFinanceOutsideGroupInput, "committeeKey" | "supportOppose">): string {
  return `${normalizeCommitteeKey(group.committeeKey)}\u0000${group.supportOppose}`;
}

function validateTennesseeFinanceSnapshotInput(input: TennesseeFinanceSnapshotInput): void {
  if (input.outsideGroupBreakdowns && !input.outsideGroups) {
    throw new Error("Tennessee outside group breakdowns require outside groups in the same snapshot");
  }
  if (input.outsideGroupBreakdowns?.length) {
    const groupKeys = new Set((input.outsideGroups ?? []).map(outsideGroupKey));
    for (const breakdown of input.outsideGroupBreakdowns) {
      if (!groupKeys.has(outsideGroupKey(breakdown))) {
        throw new Error("Tennessee outside group breakdowns require matching outside groups in the same snapshot");
      }
    }
  }
}

function canOpenTransaction(db: Queryable): db is ConnectableQueryable & { connect: () => Promise<PoolClient> } {
  return typeof (db as ConnectableQueryable).connect === "function";
}

async function withTennesseeFinanceTransaction<T>(db: Queryable, work: (tx: Queryable) => Promise<T>): Promise<T> {
  assertSnapshotDbIsNotPoolClient("Tennessee", db);
  if (!canOpenTransaction(db)) {
    return await work(db);
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

export async function upsertTennesseeFinanceLink(input: {
  db: Queryable;
  link: TennesseeFinanceLinkInput;
}): Promise<{ linkId: string }> {
  const result = await input.db.query<ManualProtectedLinkRow>(
    `
      INSERT INTO public.tn_candidate_finance_links (
        candidate_id,
        election_id,
        election_year,
        candidate_name_normalized,
        office_name,
        district,
        camp_candidate_id,
        owner_name,
        committee_name,
        link_status,
        link_source,
        source_url,
        report_list_url,
        last_verified_at
      )
      VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::timestamptz)
      ON CONFLICT (candidate_id, election_id, camp_candidate_id)
      DO UPDATE SET
        candidate_name_normalized = EXCLUDED.candidate_name_normalized,
        office_name = EXCLUDED.office_name,
        district = EXCLUDED.district,
        owner_name = EXCLUDED.owner_name,
        committee_name = EXCLUDED.committee_name,
        ${manualProtectedLinkAssignments("tn_candidate_finance_links")},
        source_url = EXCLUDED.source_url,
        report_list_url = EXCLUDED.report_list_url,
        last_verified_at = EXCLUDED.last_verified_at
      RETURNING ${MANUAL_PROTECTED_LINK_RETURNING}
    `,
    [
      requireNonEmpty(input.link.candidateId, "candidate id"),
      requireNonEmpty(input.link.electionId, "election id"),
      normalizeElectionYear(input.link.electionYear),
      requireNonEmpty(input.link.candidateNameNormalized, "Tennessee finance candidate name"),
      requireNonEmpty(input.link.officeName, "Tennessee finance office name"),
      normalizeOptionalText(input.link.district),
      requireNonEmpty(input.link.campCandidateId, "Tennessee CAMP candidate id"),
      requireNonEmpty(input.link.ownerName, "Tennessee CAMP owner name"),
      normalizeOptionalText(input.link.committeeName),
      input.link.linkStatus ?? "active",
      input.link.linkSource ?? "manual",
      normalizeOptionalText(input.link.sourceUrl),
      normalizeOptionalText(input.link.reportListUrl),
      normalizeNullableDate(input.link.lastVerifiedAt),
    ]
  );

  assertLinkWriteNotBlocked("Tennessee", result.rows[0], input.link.linkSource ?? "manual", input.link.electionYear);
  const linkId = result.rows[0]?.id;
  if (!linkId) {
    throw new Error("Tennessee finance link upsert did not return an id");
  }
  return { linkId };
}

async function upsertSummary(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  summary: TennesseeFinanceSummaryInput;
  syncedAt: Date;
}): Promise<void> {
  await input.db.query(
    `
      INSERT INTO public.tn_candidate_finance_summaries (
        link_id,
        election_year,
        total_receipts,
        direct_contribution_total,
        outside_support_total,
        outside_oppose_total,
        source_url,
        last_synced_at
      )
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::timestamptz)
      ON CONFLICT (link_id, election_year)
      DO UPDATE SET
        total_receipts = EXCLUDED.total_receipts,
        direct_contribution_total = EXCLUDED.direct_contribution_total,
        outside_support_total = CASE WHEN $9::boolean THEN EXCLUDED.outside_support_total
          ELSE tn_candidate_finance_summaries.outside_support_total END,
        outside_oppose_total = CASE WHEN $10::boolean THEN EXCLUDED.outside_oppose_total
          ELSE tn_candidate_finance_summaries.outside_oppose_total END,
        source_url = EXCLUDED.source_url,
        last_synced_at = EXCLUDED.last_synced_at
    `,
    [
      requireNonEmpty(input.linkId, "Tennessee finance link id"),
      normalizeElectionYear(input.electionYear),
      normalizeNullableAmount(input.summary.totalReceipts, "total receipts"),
      normalizeNullableAmount(input.summary.directContributionTotal, "direct contribution total"),
      normalizeNullableAmount(input.summary.outsideSupportTotal, "outside support total"),
      normalizeNullableAmount(input.summary.outsideOpposeTotal, "outside oppose total"),
      normalizeOptionalText(input.summary.sourceUrl),
      input.syncedAt.toISOString(),
      input.summary.outsideSupportTotal !== undefined,
      input.summary.outsideOpposeTotal !== undefined,
    ]
  );
}

async function upsertDirectBreakdown(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  breakdown: TennesseeFinanceDirectBreakdownInput;
  syncedAt: Date;
}): Promise<void> {
  await input.db.query(
    `
      INSERT INTO public.tn_candidate_finance_direct_breakdowns (
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
      requireNonEmpty(input.linkId, "Tennessee finance link id"),
      normalizeElectionYear(input.electionYear),
      input.breakdown.categoryType,
      requireNonEmpty(input.breakdown.categoryName, "Tennessee finance direct breakdown category"),
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
  group: TennesseeFinanceOutsideGroupInput;
  syncedAt: Date;
}): Promise<void> {
  await input.db.query(
    `
      INSERT INTO public.tn_candidate_finance_outside_groups (
        link_id,
        election_year,
        committee_key,
        committee_name,
        support_oppose,
        amount,
        expenditure_count,
        source_url,
        last_synced_at
      )
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)
      ON CONFLICT (link_id, election_year, committee_key, support_oppose)
      DO UPDATE SET
        committee_name = EXCLUDED.committee_name,
        amount = EXCLUDED.amount,
        expenditure_count = EXCLUDED.expenditure_count,
        source_url = EXCLUDED.source_url,
        last_synced_at = EXCLUDED.last_synced_at
    `,
    [
      requireNonEmpty(input.linkId, "Tennessee finance link id"),
      normalizeElectionYear(input.electionYear),
      normalizeCommitteeKey(requireNonEmpty(input.group.committeeKey, "Tennessee outside group committee key")),
      requireNonEmpty(input.group.committeeName, "Tennessee outside group committee name"),
      input.group.supportOppose,
      normalizeAmount(input.group.amount, "outside group amount"),
      normalizeNullableCount(input.group.expenditureCount),
      normalizeOptionalText(input.group.sourceUrl),
      input.syncedAt.toISOString(),
    ]
  );
}

async function upsertOutsideGroupBreakdown(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  breakdown: TennesseeFinanceOutsideGroupBreakdownInput;
  syncedAt: Date;
}): Promise<void> {
  await input.db.query(
    `
      INSERT INTO public.tn_candidate_finance_outside_group_breakdowns (
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
      requireNonEmpty(input.linkId, "Tennessee finance link id"),
      normalizeElectionYear(input.electionYear),
      normalizeCommitteeKey(requireNonEmpty(input.breakdown.committeeKey, "Tennessee outside breakdown committee key")),
      input.breakdown.supportOppose,
      input.breakdown.categoryType,
      requireNonEmpty(input.breakdown.categoryName, "Tennessee outside breakdown category"),
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
  breakdowns: readonly TennesseeFinanceDirectBreakdownInput[];
}): Promise<void> {
  const keys = input.breakdowns.map((breakdown) => ({
    category_type: breakdown.categoryType,
    category_name: requireNonEmpty(breakdown.categoryName, "Tennessee finance direct breakdown category"),
  }));
  await input.db.query(
    `
      DELETE FROM public.tn_candidate_finance_direct_breakdowns
      WHERE link_id = $1::uuid
        AND election_year = $2
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset($3::jsonb) AS keep(
            category_type text,
            category_name text
          )
          WHERE keep.category_type = tn_candidate_finance_direct_breakdowns.category_type
            AND keep.category_name = tn_candidate_finance_direct_breakdowns.category_name
        )
    `,
    [requireNonEmpty(input.linkId, "Tennessee finance link id"), normalizeElectionYear(input.electionYear), JSON.stringify(keys)]
  );
}

async function deleteStaleOutsideGroups(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  groups: readonly TennesseeFinanceOutsideGroupInput[];
}): Promise<void> {
  const keys = input.groups.map((group) => ({
    committee_key: normalizeCommitteeKey(requireNonEmpty(group.committeeKey, "Tennessee outside group committee key")),
    support_oppose: group.supportOppose,
  }));
  await input.db.query(
    `
      DELETE FROM public.tn_candidate_finance_outside_groups
      WHERE link_id = $1::uuid
        AND election_year = $2
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset($3::jsonb) AS keep(
            committee_key text,
            support_oppose text
          )
          WHERE keep.committee_key = tn_candidate_finance_outside_groups.committee_key
            AND keep.support_oppose = tn_candidate_finance_outside_groups.support_oppose
        )
    `,
    [requireNonEmpty(input.linkId, "Tennessee finance link id"), normalizeElectionYear(input.electionYear), JSON.stringify(keys)]
  );
}

async function deleteStaleOutsideGroupBreakdowns(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  breakdowns: readonly TennesseeFinanceOutsideGroupBreakdownInput[];
}): Promise<void> {
  const keys = input.breakdowns.map((breakdown) => ({
    committee_key: normalizeCommitteeKey(requireNonEmpty(breakdown.committeeKey, "Tennessee outside breakdown committee key")),
    support_oppose: breakdown.supportOppose,
    category_type: breakdown.categoryType,
    category_name: requireNonEmpty(breakdown.categoryName, "Tennessee outside breakdown category"),
  }));
  await input.db.query(
    `
      DELETE FROM public.tn_candidate_finance_outside_group_breakdowns
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
          WHERE keep.committee_key = tn_candidate_finance_outside_group_breakdowns.committee_key
            AND keep.support_oppose = tn_candidate_finance_outside_group_breakdowns.support_oppose
            AND keep.category_type = tn_candidate_finance_outside_group_breakdowns.category_type
            AND keep.category_name = tn_candidate_finance_outside_group_breakdowns.category_name
        )
    `,
    [requireNonEmpty(input.linkId, "Tennessee finance link id"), normalizeElectionYear(input.electionYear), JSON.stringify(keys)]
  );
}

export async function replaceTennesseeCandidateFinanceSnapshot(
  input: TennesseeFinanceSnapshotInput
): Promise<TennesseeFinanceSnapshotWriteResult> {
  const syncedAt = input.syncedAt ?? new Date();
  if (Number.isNaN(syncedAt.getTime())) {
    throw new Error("Invalid Tennessee finance sync timestamp");
  }
  validateTennesseeFinanceSnapshotInput(input);
  const electionYear = normalizeElectionYear(input.link.electionYear);

  return await withTennesseeFinanceTransaction(input.db, async (db) => {
    const { linkId } = await upsertTennesseeFinanceLink({ db, link: input.link });
    if (input.summary) {
      await upsertSummary({ db, linkId, electionYear, summary: input.summary, syncedAt });
    }
    for (const breakdown of input.directBreakdowns ?? []) {
      await upsertDirectBreakdown({ db, linkId, electionYear, breakdown, syncedAt });
    }
    if (input.directBreakdowns) {
      await deleteStaleDirectBreakdowns({ db, linkId, electionYear, breakdowns: input.directBreakdowns });
    }
    for (const group of input.outsideGroups ?? []) {
      await upsertOutsideGroup({ db, linkId, electionYear, group, syncedAt });
    }
    for (const breakdown of input.outsideGroupBreakdowns ?? []) {
      await upsertOutsideGroupBreakdown({ db, linkId, electionYear, breakdown, syncedAt });
    }
    if (input.outsideGroupBreakdowns || input.outsideGroups) {
      await deleteStaleOutsideGroupBreakdowns({
        db,
        linkId,
        electionYear,
        breakdowns: input.outsideGroupBreakdowns ?? [],
      });
    }
    if (input.outsideGroups) {
      await deleteStaleOutsideGroups({ db, linkId, electionYear, groups: input.outsideGroups });
    }

    for (const classification of input.classifications ?? []) {
      await upsertFinanceLabelClassification({ db, classification });
    }

    return {
      linkId,
      summaryWritten: Boolean(input.summary),
      directBreakdownsWritten: input.directBreakdowns?.length ?? 0,
      outsideGroupsWritten: input.outsideGroups?.length ?? 0,
      outsideGroupBreakdownsWritten: input.outsideGroupBreakdowns?.length ?? 0,
    };
  });
}
