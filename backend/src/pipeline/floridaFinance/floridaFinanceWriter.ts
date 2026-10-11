import type { Pool, PoolClient } from "pg";
import {
  prepareFloridaCommitteeDonorFinance,
  assertFloridaCommitteeDonorLocalOwnership,
  writeFloridaCommitteeDonorFinance,
  type FloridaCommitteeDonorFinanceInput,
} from "./floridaCommitteeDonorWriter.js";

import type { FinanceLabelClassification } from "../finance/financeLabelClassifier.js";
import { upsertFinanceLabelClassification } from "../finance/financeIndustryClassificationService.js";
import type {
  FloridaOutsideGroupSupportConfidence,
  FloridaOutsideGroupSupportSource,
} from "./floridaOutsideGroupSupportResolver.js";
import {
  MANUAL_PROTECTED_LINK_RETURNING,
  assertLinkWriteNotBlocked,
  manualProtectedLinkAssignments,
  type ManualProtectedLinkRow,
} from "../finance/manualLinkProtection.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type PoolLikeQueryable = Queryable & {
  connect?: () => Promise<PoolClient>;
};
type ClientLikeQueryable = Queryable & {
  release?: () => void;
};

export type FloridaFinanceLinkStatus = "active" | "inactive";
export type FloridaFinanceLinkSource = "manual" | "dos_export";
export type FloridaFinanceDirectCategoryType = "occupation" | "contribution_size";
export type FloridaFinanceOutsideCategoryType = "donor" | "industry";
export type FloridaFinanceSupportOppose = "support" | "oppose";

export type FloridaFinanceLinkInput = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  candidateNameNormalized: string;
  officeName: string;
  district?: string | null;
  committeeId: string;
  committeeName: string;
  linkStatus?: FloridaFinanceLinkStatus;
  linkSource?: FloridaFinanceLinkSource;
  sourceUrl?: string | null;
  lastVerifiedAt?: Date | null;
};

export type FloridaFinanceSummaryInput = {
  totalReceipts?: number | null;
  directContributionTotal?: number | null;
  totalDisbursements?: number | null;
  cashOnHand?: number | null;
  outsideSupportTotal?: number | null;
  outsideOpposeTotal?: number | null;
  sourceUrl?: string | null;
};

export type FloridaFinanceDirectBreakdownInput = {
  categoryType: FloridaFinanceDirectCategoryType;
  categoryName: string;
  amount: number;
  contributorCount?: number | null;
  sourceUrl?: string | null;
};

export type FloridaFinanceOutsideGroupInput = {
  committeeId: string;
  committeeName: string;
  supportOppose: FloridaFinanceSupportOppose;
  amount: number;
  sourceUrl?: string | null;
};

export type FloridaFinanceOutsideGroupBreakdownInput = {
  committeeId: string;
  supportOppose: FloridaFinanceSupportOppose;
  categoryType: FloridaFinanceOutsideCategoryType;
  categoryName: string;
  amount: number;
  contributorCount?: number | null;
  sourceUrl?: string | null;
};

export type FloridaOutsideGroupSupportLinkInput = {
  candidateElectionId: string;
  committeeId?: string | null;
  committeeName: string;
  supportOppose: FloridaFinanceSupportOppose;
  confidence?: FloridaOutsideGroupSupportConfidence;
  amount?: number | null;
  evidenceUrl?: string | null;
  evidenceNote?: string | null;
  linkSource?: FloridaOutsideGroupSupportSource;
};

export type FloridaOutsideGroupSupportLinkRow = Required<
  Pick<FloridaOutsideGroupSupportLinkInput, "candidateElectionId" | "committeeName" | "supportOppose">
> & {
  id: string;
  committeeId: string | null;
  confidence: FloridaOutsideGroupSupportConfidence;
  amount: number | null;
  evidenceUrl: string | null;
  evidenceNote: string | null;
  linkSource: FloridaOutsideGroupSupportSource;
};

export type FloridaFinanceSnapshotInput = {
  db: Queryable;
  link: FloridaFinanceLinkInput;
  syncedAt?: Date;
  summary?: FloridaFinanceSummaryInput;
  directBreakdowns?: readonly FloridaFinanceDirectBreakdownInput[];
  outsideGroups?: readonly FloridaFinanceOutsideGroupInput[];
  outsideGroupBreakdowns?: readonly FloridaFinanceOutsideGroupBreakdownInput[];
  outsideGroupSupportLinks?: readonly FloridaOutsideGroupSupportLinkInput[];
  classifications?: readonly FinanceLabelClassification[];
  pacFinance?: FloridaCommitteeDonorFinanceInput;
};

export type FloridaFinanceSnapshotWriteResult = {
  linkId: string;
  summaryWritten: boolean;
  directBreakdownsWritten: number;
  outsideGroupsWritten: number;
  outsideGroupBreakdownsWritten: number;
  outsideGroupSupportLinksWritten: number;
  pacDonorsWritten?: number;
};

function requireNonEmpty(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmed;
}

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 1996 || value > 2100) {
    throw new Error(`Invalid Florida finance election year: ${value}`);
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

function normalizeNullableDate(value: Date | null | undefined): string | null {
  if (!value) {
    return null;
  }
  if (Number.isNaN(value.getTime())) {
    throw new Error("Invalid Florida finance timestamp");
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
    throw new Error("Florida finance contributor count must be a nonnegative integer");
  }
  return value;
}

function normalizeSupportConfidence(
  value: FloridaOutsideGroupSupportConfidence | undefined
): FloridaOutsideGroupSupportConfidence {
  if (value === undefined || value === "high" || value === "medium" || value === "low") {
    return value ?? "high";
  }
  throw new Error(`Invalid Florida outside group support confidence: ${value}`);
}

function normalizeSupportLinkSource(
  value: FloridaOutsideGroupSupportSource | undefined
): FloridaOutsideGroupSupportSource {
  if (value === undefined || value === "manual" || value === "name_heuristic" || value === "independent_expenditure") {
    return value ?? "manual";
  }
  throw new Error(`Invalid Florida outside group support link source: ${value}`);
}

function validateOutsideGroupSupportLinkInput(link: FloridaOutsideGroupSupportLinkInput): void {
  requireNonEmpty(link.candidateElectionId, "candidate election id");
  if (link.committeeId !== undefined && link.committeeId !== null) {
    requireNonEmpty(link.committeeId, "Florida outside group support committee id");
  }
  requireNonEmpty(link.committeeName, "Florida outside group support committee name");
  normalizeSupportConfidence(link.confidence);
  normalizeSupportLinkSource(link.linkSource);
  normalizeNullableAmount(link.amount, "outside group support amount");
}

function canOpenTransaction(db: Queryable): db is PoolLikeQueryable & { connect: () => Promise<PoolClient> } {
  return (
    typeof (db as PoolLikeQueryable).connect === "function" &&
    typeof (db as ClientLikeQueryable).release !== "function"
  );
}

function isClientLikeQueryable(db: Queryable): db is ClientLikeQueryable {
  return typeof (db as ClientLikeQueryable).release === "function";
}

function validateFloridaFinanceLinkInput(link: FloridaFinanceLinkInput): void {
  requireNonEmpty(link.candidateId, "candidate id");
  requireNonEmpty(link.electionId, "election id");
  normalizeElectionYear(link.electionYear);
  requireNonEmpty(link.candidateNameNormalized, "Florida finance candidate name");
  requireNonEmpty(link.officeName, "Florida finance office name");
  requireNonEmpty(link.committeeId, "Florida committee id");
  requireNonEmpty(link.committeeName, "Florida committee name");
  normalizeNullableDate(link.lastVerifiedAt);
}

async function withFloridaFinanceTransaction<T>(db: Queryable, work: (tx: Queryable) => Promise<T>): Promise<T> {
  if (!canOpenTransaction(db)) {
    if (isClientLikeQueryable(db)) {
      throw new Error("Florida finance snapshot writes must receive a Pool, not a PoolClient");
    }
    throw new Error("Florida finance snapshot writes must receive a transaction-capable Pool");
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

export async function upsertFloridaFinanceLink(input: {
  db: Queryable;
  link: FloridaFinanceLinkInput;
}): Promise<{ linkId: string }> {
  validateFloridaFinanceLinkInput(input.link);

  const result = await input.db.query<ManualProtectedLinkRow>(
    `
      INSERT INTO public.fl_candidate_finance_links (
        candidate_id,
        election_id,
        election_year,
        candidate_name_normalized,
        office_name,
        district,
        committee_id,
        committee_name,
        link_status,
        link_source,
        source_url,
        last_verified_at
      )
      VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz)
      ON CONFLICT (candidate_id, election_id, committee_id)
      DO UPDATE SET
        candidate_name_normalized = EXCLUDED.candidate_name_normalized,
        office_name = EXCLUDED.office_name,
        district = EXCLUDED.district,
        committee_name = EXCLUDED.committee_name,
        ${manualProtectedLinkAssignments("fl_candidate_finance_links")},
        source_url = EXCLUDED.source_url,
        last_verified_at = EXCLUDED.last_verified_at
      RETURNING ${MANUAL_PROTECTED_LINK_RETURNING}
    `,
    [
      requireNonEmpty(input.link.candidateId, "candidate id"),
      requireNonEmpty(input.link.electionId, "election id"),
      normalizeElectionYear(input.link.electionYear),
      requireNonEmpty(input.link.candidateNameNormalized, "Florida finance candidate name"),
      requireNonEmpty(input.link.officeName, "Florida finance office name"),
      normalizeOptionalText(input.link.district),
      requireNonEmpty(input.link.committeeId, "Florida committee id"),
      requireNonEmpty(input.link.committeeName, "Florida committee name"),
      input.link.linkStatus ?? "active",
      input.link.linkSource ?? "manual",
      normalizeOptionalText(input.link.sourceUrl),
      normalizeNullableDate(input.link.lastVerifiedAt),
    ]
  );

  assertLinkWriteNotBlocked("Florida", result.rows[0], input.link.linkSource ?? "manual", input.link.electionYear);
  const linkId = result.rows[0]?.id;
  if (!linkId) {
    throw new Error("Florida finance link upsert did not return an id");
  }
  return { linkId };
}

export async function upsertFloridaOutsideGroupSupportLink(input: {
  db: Queryable;
  link: FloridaOutsideGroupSupportLinkInput;
}): Promise<{ id: string }> {
  validateOutsideGroupSupportLinkInput(input.link);
  const committeeId = normalizeOptionalText(input.link.committeeId);
  const conflictTarget = committeeId
    ? "(candidate_election_id, committee_id, support_oppose, link_source) WHERE committee_id IS NOT NULL"
    : "(candidate_election_id, committee_name, support_oppose, link_source) WHERE committee_id IS NULL";

  const result = await input.db.query<{ id: string }>(
    `
      INSERT INTO public.fl_candidate_finance_outside_group_links (
        candidate_election_id,
        committee_id,
        committee_name,
        support_oppose,
        confidence,
        amount,
        evidence_url,
        evidence_note,
        link_source
      )
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT ${conflictTarget}
      DO UPDATE SET
        committee_id = EXCLUDED.committee_id,
        committee_name = EXCLUDED.committee_name,
        confidence = EXCLUDED.confidence,
        amount = COALESCE(EXCLUDED.amount, fl_candidate_finance_outside_group_links.amount),
        evidence_url = COALESCE(EXCLUDED.evidence_url, fl_candidate_finance_outside_group_links.evidence_url),
        evidence_note = COALESCE(EXCLUDED.evidence_note, fl_candidate_finance_outside_group_links.evidence_note)
      RETURNING id
    `,
    [
      requireNonEmpty(input.link.candidateElectionId, "candidate election id"),
      committeeId,
      requireNonEmpty(input.link.committeeName, "Florida outside group support committee name"),
      input.link.supportOppose,
      normalizeSupportConfidence(input.link.confidence),
      normalizeNullableAmount(input.link.amount, "outside group support amount"),
      normalizeOptionalText(input.link.evidenceUrl),
      normalizeOptionalText(input.link.evidenceNote),
      normalizeSupportLinkSource(input.link.linkSource),
    ]
  );

  const id = result.rows[0]?.id;
  if (!id) {
    throw new Error("Florida outside group support link upsert did not return an id");
  }
  return { id };
}

export async function listFloridaOutsideGroupSupportLinks(input: {
  db: Queryable;
  candidateElectionId: string;
}): Promise<FloridaOutsideGroupSupportLinkRow[]> {
  const result = await input.db.query<{
    id: string;
    candidate_election_id: string;
    committee_id: string | null;
    committee_name: string;
    support_oppose: FloridaFinanceSupportOppose;
    confidence: FloridaOutsideGroupSupportConfidence;
    amount: string | number | null;
    evidence_url: string | null;
    evidence_note: string | null;
    link_source: FloridaOutsideGroupSupportSource;
  }>(
    `
      SELECT
        id::text,
        candidate_election_id::text,
        committee_id,
        committee_name,
        support_oppose,
        confidence,
        amount,
        evidence_url,
        evidence_note,
        link_source
      FROM public.fl_candidate_finance_outside_group_links
      WHERE candidate_election_id = $1::uuid
      ORDER BY
        CASE confidence
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          ELSE 3
        END,
        committee_name ASC,
        support_oppose ASC
    `,
    [requireNonEmpty(input.candidateElectionId, "candidate election id")]
  );

  return result.rows.map((row) => ({
    id: row.id,
    candidateElectionId: row.candidate_election_id,
    committeeId: row.committee_id,
    committeeName: row.committee_name,
    supportOppose: row.support_oppose,
    confidence: row.confidence,
    amount: row.amount === null ? null : Number(row.amount),
    evidenceUrl: row.evidence_url,
    evidenceNote: row.evidence_note,
    linkSource: row.link_source,
  }));
}

async function upsertSummary(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  summary: FloridaFinanceSummaryInput;
  syncedAt: Date;
}): Promise<void> {
  await input.db.query(
    `
      INSERT INTO public.fl_candidate_finance_summaries (
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
        outside_support_total = COALESCE(EXCLUDED.outside_support_total, fl_candidate_finance_summaries.outside_support_total),
        outside_oppose_total = COALESCE(EXCLUDED.outside_oppose_total, fl_candidate_finance_summaries.outside_oppose_total),
        source_url = EXCLUDED.source_url,
        last_synced_at = EXCLUDED.last_synced_at
    `,
    [
      requireNonEmpty(input.linkId, "Florida finance link id"),
      normalizeElectionYear(input.electionYear),
      normalizeNullableAmount(input.summary.totalReceipts, "total receipts"),
      normalizeNullableAmount(input.summary.directContributionTotal, "direct contribution total"),
      normalizeNullableAmount(input.summary.totalDisbursements, "total disbursements"),
      normalizeNullableAmount(input.summary.cashOnHand, "cash on hand"),
      normalizeNullableAmount(input.summary.outsideSupportTotal, "outside support total"),
      normalizeNullableAmount(input.summary.outsideOpposeTotal, "outside oppose total"),
      normalizeOptionalText(input.summary.sourceUrl),
      input.syncedAt.toISOString(),
    ]
  );
}

async function upsertDirectBreakdown(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  breakdown: FloridaFinanceDirectBreakdownInput;
  syncedAt: Date;
}): Promise<void> {
  await input.db.query(
    `
      INSERT INTO public.fl_candidate_finance_direct_breakdowns (
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
      requireNonEmpty(input.linkId, "Florida finance link id"),
      normalizeElectionYear(input.electionYear),
      input.breakdown.categoryType,
      requireNonEmpty(input.breakdown.categoryName, "Florida finance direct breakdown category"),
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
  group: FloridaFinanceOutsideGroupInput;
  syncedAt: Date;
}): Promise<void> {
  await input.db.query(
    `
      INSERT INTO public.fl_candidate_finance_outside_groups (
        link_id,
        election_year,
        committee_id,
        committee_name,
        support_oppose,
        amount,
        source_url,
        last_synced_at
      )
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::timestamptz)
      ON CONFLICT (link_id, election_year, committee_id, support_oppose)
      DO UPDATE SET
        committee_name = EXCLUDED.committee_name,
        amount = EXCLUDED.amount,
        source_url = EXCLUDED.source_url,
        last_synced_at = EXCLUDED.last_synced_at
    `,
    [
      requireNonEmpty(input.linkId, "Florida finance link id"),
      normalizeElectionYear(input.electionYear),
      requireNonEmpty(input.group.committeeId, "Florida outside group committee id"),
      requireNonEmpty(input.group.committeeName, "Florida outside group committee name"),
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
  breakdown: FloridaFinanceOutsideGroupBreakdownInput;
  syncedAt: Date;
}): Promise<void> {
  await input.db.query(
    `
      INSERT INTO public.fl_candidate_finance_outside_group_breakdowns (
        link_id,
        election_year,
        committee_id,
        support_oppose,
        category_type,
        category_name,
        amount,
        contributor_count,
        source_url,
        last_synced_at
      )
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)
      ON CONFLICT (link_id, election_year, committee_id, support_oppose, category_type, category_name)
      DO UPDATE SET
        amount = EXCLUDED.amount,
        contributor_count = EXCLUDED.contributor_count,
        source_url = EXCLUDED.source_url,
        last_synced_at = EXCLUDED.last_synced_at
    `,
    [
      requireNonEmpty(input.linkId, "Florida finance link id"),
      normalizeElectionYear(input.electionYear),
      requireNonEmpty(input.breakdown.committeeId, "Florida outside breakdown committee id"),
      input.breakdown.supportOppose,
      input.breakdown.categoryType,
      requireNonEmpty(input.breakdown.categoryName, "Florida outside breakdown category"),
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
  breakdowns: readonly FloridaFinanceDirectBreakdownInput[];
}): Promise<void> {
  const keys = input.breakdowns.map((breakdown) => ({
    category_type: breakdown.categoryType,
    category_name: requireNonEmpty(breakdown.categoryName, "Florida finance direct breakdown category"),
  }));

  await input.db.query(
    `
      DELETE FROM public.fl_candidate_finance_direct_breakdowns
      WHERE link_id = $1::uuid
        AND election_year = $2
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset($3::jsonb) AS keep(
            category_type text,
            category_name text
          )
          WHERE keep.category_type = fl_candidate_finance_direct_breakdowns.category_type
            AND keep.category_name = fl_candidate_finance_direct_breakdowns.category_name
        )
    `,
    [requireNonEmpty(input.linkId, "Florida finance link id"), normalizeElectionYear(input.electionYear), JSON.stringify(keys)]
  );
}

async function deleteStaleOutsideGroupBreakdowns(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  breakdowns: readonly FloridaFinanceOutsideGroupBreakdownInput[];
}): Promise<void> {
  const keys = input.breakdowns.map((breakdown) => ({
    committee_id: requireNonEmpty(breakdown.committeeId, "Florida outside breakdown committee id"),
    support_oppose: breakdown.supportOppose,
    category_type: breakdown.categoryType,
    category_name: requireNonEmpty(breakdown.categoryName, "Florida outside breakdown category"),
  }));

  await input.db.query(
    `
      DELETE FROM public.fl_candidate_finance_outside_group_breakdowns
      WHERE link_id = $1::uuid
        AND election_year = $2
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset($3::jsonb) AS keep(
            committee_id text,
            support_oppose text,
            category_type text,
            category_name text
          )
          WHERE keep.committee_id = fl_candidate_finance_outside_group_breakdowns.committee_id
            AND keep.support_oppose = fl_candidate_finance_outside_group_breakdowns.support_oppose
            AND keep.category_type = fl_candidate_finance_outside_group_breakdowns.category_type
            AND keep.category_name = fl_candidate_finance_outside_group_breakdowns.category_name
        )
    `,
    [requireNonEmpty(input.linkId, "Florida finance link id"), normalizeElectionYear(input.electionYear), JSON.stringify(keys)]
  );
}

async function deleteStaleOutsideGroups(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  groups: readonly FloridaFinanceOutsideGroupInput[];
}): Promise<void> {
  const keys = input.groups.map((group) => ({
    committee_id: requireNonEmpty(group.committeeId, "Florida outside group committee id"),
    support_oppose: group.supportOppose,
  }));

  await input.db.query(
    `
      DELETE FROM public.fl_candidate_finance_outside_groups
      WHERE link_id = $1::uuid
        AND election_year = $2
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset($3::jsonb) AS keep(
            committee_id text,
            support_oppose text
          )
          WHERE keep.committee_id = fl_candidate_finance_outside_groups.committee_id
            AND keep.support_oppose = fl_candidate_finance_outside_groups.support_oppose
        )
    `,
    [requireNonEmpty(input.linkId, "Florida finance link id"), normalizeElectionYear(input.electionYear), JSON.stringify(keys)]
  );
}

async function deleteStaleOutsideGroupSupportLinks(input: {
  db: Queryable;
  links: readonly FloridaOutsideGroupSupportLinkInput[];
}): Promise<void> {
  const keys = input.links.map((link) => {
    validateOutsideGroupSupportLinkInput(link);
    return {
      candidate_election_id: requireNonEmpty(link.candidateElectionId, "candidate election id"),
      committee_id: normalizeOptionalText(link.committeeId),
      committee_name: requireNonEmpty(link.committeeName, "Florida outside group support committee name"),
      support_oppose: link.supportOppose,
      link_source: normalizeSupportLinkSource(link.linkSource),
    };
  });

  await input.db.query(
    `
      WITH keep AS (
        SELECT
          candidate_election_id,
          committee_id,
          committee_name,
          support_oppose,
          link_source
        FROM jsonb_to_recordset($1::jsonb) AS x(
          candidate_election_id text,
          committee_id text,
          committee_name text,
          support_oppose text,
          link_source text
        )
      ),
      scope AS (
        SELECT DISTINCT candidate_election_id, link_source
        FROM keep
      )
      DELETE FROM public.fl_candidate_finance_outside_group_links AS existing
      USING scope
      WHERE existing.candidate_election_id = scope.candidate_election_id::uuid
        AND existing.link_source = scope.link_source
        AND NOT EXISTS (
          SELECT 1
          FROM keep
          WHERE existing.candidate_election_id = keep.candidate_election_id::uuid
            AND existing.support_oppose = keep.support_oppose
            AND existing.link_source = keep.link_source
            AND (
              (keep.committee_id IS NOT NULL AND existing.committee_id = keep.committee_id)
              OR (
                keep.committee_id IS NULL
                AND existing.committee_id IS NULL
                AND existing.committee_name = keep.committee_name
              )
            )
        )
    `,
    [JSON.stringify(keys)]
  );
}

export async function replaceFloridaCandidateFinanceSnapshot(
  input: FloridaFinanceSnapshotInput
): Promise<FloridaFinanceSnapshotWriteResult> {
  const { db: originalDb, ...data } = input;
  input = { db: originalDb, ...structuredClone(data) };
  const syncedAt = input.syncedAt ?? new Date();
  if (Number.isNaN(syncedAt.getTime())) {
    throw new Error("Invalid Florida finance sync timestamp");
  }
  validateFloridaFinanceLinkInput(input.link);
  const electionYear = normalizeElectionYear(input.link.electionYear);

  const preparedPac = input.pacFinance === undefined ? undefined
    : await prepareFloridaCommitteeDonorFinance({ pacFinance: input.pacFinance, link: input.link });
  return await withFloridaFinanceTransaction(input.db, async (db) => {
    if (preparedPac) await assertFloridaCommitteeDonorLocalOwnership({ db, prepared: preparedPac, link: input.link });
    const { linkId } = await upsertFloridaFinanceLink({ db, link: input.link });
    if (input.summary) {
      const summary =
        input.outsideGroups === undefined
          ? input.summary
          : {
              ...input.summary,
              outsideSupportTotal: input.summary.outsideSupportTotal ?? 0,
              outsideOpposeTotal: input.summary.outsideOpposeTotal ?? 0,
            };
      await upsertSummary({ db, linkId, electionYear, summary, syncedAt });
    }

    const pacDonorsWritten = preparedPac ? await writeFloridaCommitteeDonorFinance({
      db, linkId, electionYear, syncedAt, prepared: preparedPac,
    }) : undefined;

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
    if (input.outsideGroupBreakdowns) {
      await deleteStaleOutsideGroupBreakdowns({
        db,
        linkId,
        electionYear,
        breakdowns: input.outsideGroupBreakdowns,
      });
    }
    if (input.outsideGroups) {
      await deleteStaleOutsideGroups({ db, linkId, electionYear, groups: input.outsideGroups });
    }

    for (const supportLink of input.outsideGroupSupportLinks ?? []) {
      await upsertFloridaOutsideGroupSupportLink({ db, link: supportLink });
    }
    if (input.outsideGroupSupportLinks) {
      await deleteStaleOutsideGroupSupportLinks({ db, links: input.outsideGroupSupportLinks });
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
      outsideGroupSupportLinksWritten: input.outsideGroupSupportLinks?.length ?? 0,
      ...(pacDonorsWritten === undefined ? {} : { pacDonorsWritten }),
    };
  });
}
