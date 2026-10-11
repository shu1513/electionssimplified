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
import {
  validateTennesseePacSourceProvenance,
  isTennesseeCampId,
  type TennesseeFinancePacDonor,
  type TennesseePacSourceProvenance,
} from "./tennesseePacDonorAggregator.js";
import {
  mergeTennesseeOutsideReportEvidence,
  summarizeTennesseeOutsideReportProvenance,
  type TennesseeOutsideCandidateContext,
  type TennesseeVerifiedOutsideReportEvidence,
  type TennesseeOutsideEvidenceUpdate,
} from "./tennesseeOutsideReportEvidence.js";

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
  pacDonors?: readonly TennesseeFinancePacDonor[];
  pacSourceProvenance?: TennesseePacSourceProvenance;
  outsideReportEvidence?: {
    candidateContext: TennesseeOutsideCandidateContext;
    verifiedReports: readonly TennesseeVerifiedOutsideReportEvidence[];
  };
};

export type TennesseeFinanceSnapshotWriteResult = {
  linkId: string;
  summaryWritten: boolean;
  directBreakdownsWritten: number;
  outsideGroupsWritten: number;
  outsideGroupBreakdownsWritten: number;
  pacDonorsWritten: number;
  outsideEvidenceAccepted?: boolean;
  outsideEvidenceDiagnostics?: string[];
  outsideSupportTotal?: number | null;
  outsideOpposeTotal?: number | null;
};

export type TennesseeVerifiedFinanceSnapshot = Pick<TennesseeFinanceSnapshotInput,
  "summary" | "directBreakdowns" | "pacDonors" | "pacSourceProvenance" | "outsideReportEvidence"> & {
    diagnostics: readonly string[];
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
  if (input.outsideReportEvidence) {
    const context = input.outsideReportEvidence.candidateContext;
    if (input.outsideGroups !== undefined || input.outsideGroupBreakdowns !== undefined
      || input.summary?.outsideSupportTotal !== undefined || input.summary?.outsideOpposeTotal !== undefined) {
      throw new Error("Tennessee verified outside reports cannot mix with an unverified outside snapshot");
    }
    if (context.candidateId !== input.link.candidateId || context.electionId !== input.link.electionId
      || context.campCandidateId !== input.link.campCandidateId || context.electionYear !== input.link.electionYear
      || context.officeName !== input.link.officeName || context.district !== (input.link.district ?? null)) {
      throw new Error("Tennessee outside report context does not match its finance link");
    }
  }
  if ((input.pacDonors !== undefined) !== (input.pacSourceProvenance !== undefined)) {
    throw new Error("Tennessee PAC donors require source provenance in the same snapshot");
  }
  if (input.pacDonors !== undefined && input.pacSourceProvenance !== undefined) {
    validateTennesseePacSourceProvenance({
      provenance: input.pacSourceProvenance, donors: input.pacDonors,
      candidateId: input.link.candidateId, electionId: input.link.electionId,
      campCandidateId: input.link.campCandidateId, electionYear: input.link.electionYear,
      officeName: input.link.officeName,district: input.link.district,
      candidateNameNormalized: input.link.candidateNameNormalized,ownerName: input.link.ownerName,
    });
  }
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
  const ambiguousSentinel = input.link.linkStatus === "ambiguous" && input.link.campCandidateId === "AMBIGUOUS";
  if (!isTennesseeCampId(input.link.campCandidateId) && !ambiguousSentinel) throw new Error("Invalid canonical Tennessee CAMP candidate id");
  const result = await input.db.query<ManualProtectedLinkRow>(
    `
      WITH link_write_lock AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text || ':' || $2::uuid::text,0))
      ), camp_write_lock AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(hashtextextended('tn-camp:' || $7::text || ':' || $3::text,0))
        FROM link_write_lock
      )
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
      SELECT $1::uuid, $2::uuid, $3::integer, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::timestamptz
      FROM camp_write_lock
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

/**
 * A diagnostics-only sync accepted nothing and preserved every stored
 * component. Advance the summary's sync time anyway so the due query rotates
 * this link behind the others instead of re-selecting it every run. A row
 * created here carries no totals, and the ballot reader omits such a card.
 */
export async function recordTennesseeCandidateFinanceSyncAttempt(input: {
  db: Queryable;
  link: Pick<TennesseeFinanceLinkInput, "candidateId" | "electionId" | "electionYear" | "campCandidateId">;
  syncedAt: Date;
}): Promise<{ recorded: boolean }> {
  if (Number.isNaN(input.syncedAt.getTime())) {
    throw new Error("Invalid Tennessee finance sync timestamp");
  }
  const electionYear = normalizeElectionYear(input.link.electionYear);
  const link = await input.db.query<{ id: string }>(
    `
      SELECT id
      FROM public.tn_candidate_finance_links
      WHERE candidate_id = $1::uuid
        AND election_id = $2::uuid
        AND camp_candidate_id = $3
        AND link_status = 'active'
    `,
    [
      requireNonEmpty(input.link.candidateId, "candidate id"),
      requireNonEmpty(input.link.electionId, "election id"),
      requireNonEmpty(input.link.campCandidateId, "Tennessee CAMP candidate id"),
    ]
  );
  const linkId = link.rows[0]?.id;
  if (!linkId) {
    return { recorded: false };
  }
  await input.db.query(
    `
      INSERT INTO public.tn_candidate_finance_summaries (link_id, election_year, last_synced_at)
      VALUES ($1::uuid, $2, $3::timestamptz)
      ON CONFLICT (link_id, election_year)
      DO UPDATE SET last_synced_at = EXCLUDED.last_synced_at
    `,
    [linkId, electionYear, input.syncedAt.toISOString()]
  );
  return { recorded: true };
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
        total_receipts = CASE WHEN $11::boolean THEN EXCLUDED.total_receipts
          ELSE tn_candidate_finance_summaries.total_receipts END,
        direct_contribution_total = CASE WHEN $12::boolean THEN EXCLUDED.direct_contribution_total
          ELSE tn_candidate_finance_summaries.direct_contribution_total END,
        outside_support_total = CASE WHEN $9::boolean THEN EXCLUDED.outside_support_total
          ELSE tn_candidate_finance_summaries.outside_support_total END,
        outside_oppose_total = CASE WHEN $10::boolean THEN EXCLUDED.outside_oppose_total
          ELSE tn_candidate_finance_summaries.outside_oppose_total END,
        source_url = CASE WHEN $13::boolean THEN EXCLUDED.source_url
          ELSE tn_candidate_finance_summaries.source_url END,
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
      input.summary.totalReceipts !== undefined,
      input.summary.directContributionTotal !== undefined,
      input.summary.sourceUrl !== undefined,
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

type StoredOutsideOwner = {
  id: string;
  election_year: number;
  outside_support_total: string | number | null;
  outside_oppose_total: string | number | null;
  outside_report_provenance: unknown;
  has_outside_money: boolean;
};

function storedOutsideCents(value: string | number | null): number | null {
  if (value === null) return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new Error("Invalid stored Tennessee outside amount");
  const cents = BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Unsafe stored Tennessee outside amount");
  return Number(cents);
}

async function prepareOutsideEvidenceUpdate(input: {
  db: Queryable;
  linkId: string;
  link: TennesseeFinanceLinkInput;
  evidence: NonNullable<TennesseeFinanceSnapshotInput["outsideReportEvidence"]>;
}): Promise<{ update?: TennesseeOutsideEvidenceUpdate; diagnostics: string[] }> {
  const preserve = (message: string) => ({ diagnostics: [`Outside evidence preserved: ${message}`] });
  if (!input.evidence.verifiedReports.length) return preserve("no verified current report closures");
  const owners = await input.db.query<StoredOutsideOwner>(`
    SELECT link.id::text,link.election_year,summary.outside_support_total,summary.outside_oppose_total,
      summary.outside_report_provenance,
      (coalesce(summary.outside_support_total,0)>0 OR coalesce(summary.outside_oppose_total,0)>0
        OR EXISTS (SELECT 1 FROM public.tn_candidate_finance_outside_groups g
          WHERE g.link_id=link.id AND g.election_year=link.election_year AND g.amount>0)
        OR EXISTS (SELECT 1 FROM public.tn_candidate_finance_outside_group_breakdowns b
          WHERE b.link_id=link.id AND b.election_year=link.election_year AND b.amount>0)) AS has_outside_money
    FROM public.tn_candidate_finance_links link LEFT JOIN public.tn_candidate_finance_summaries summary
      ON summary.link_id=link.id AND summary.election_year=link.election_year
    WHERE link.link_status='active' AND (
      (link.candidate_id=$1::uuid AND link.election_id=$2::uuid)
      OR (link.camp_candidate_id=$3 AND link.election_year=$4 AND link.candidate_id<>$1::uuid))
    ORDER BY link.id FOR UPDATE OF link`, [input.link.candidateId,input.link.electionId,input.link.campCandidateId,input.link.electionYear]);
  if (owners.rows.length !== 1 || owners.rows[0]?.id !== input.linkId
    || owners.rows[0].election_year !== input.link.electionYear) return preserve("outside owner is ambiguous across active links");
  const owner = owners.rows[0]!;
  if (owner.outside_report_provenance == null && owner.has_outside_money) {
    return preserve("legacy positive outside money lacks compatible report provenance");
  }
  if (owner.outside_report_provenance != null) {
    const expected = summarizeTennesseeOutsideReportProvenance(owner.outside_report_provenance);
    if (!expected.result) return { diagnostics: expected.diagnostics };
    const groups = await input.db.query<{
      committee_key: string; committee_name: string; support_oppose: string; amount: string | number;
      expenditure_count: number | null; source_url: string | null;
    }>(`SELECT committee_key,committee_name,support_oppose,amount,expenditure_count,source_url
      FROM public.tn_candidate_finance_outside_groups WHERE link_id=$1::uuid AND election_year=$2`,
    [input.linkId,input.link.electionYear]);
    try {
      const groupKey = (group: { committeeKey: string; supportOppose: string }) => `${group.committeeKey}:${group.supportOppose}`;
      const stored = groups.rows.map(row => ({ committeeKey: row.committee_key, committeeName: row.committee_name,
        supportOppose: row.support_oppose, cents: storedOutsideCents(row.amount), expenditureCount: row.expenditure_count,
        sourceUrl: row.source_url })).sort((a, b) => groupKey(a).localeCompare(groupKey(b)));
      const expectedGroups = expected.result.outsideGroups.map(({ amount, ...group }) => ({ ...group, cents: storedOutsideCents(amount) }))
        .sort((a, b) => groupKey(a).localeCompare(groupKey(b)));
      // Compare values independently of object key insertion order.
      const project = (group: typeof stored[number]) => [group.committeeKey,group.committeeName,group.supportOppose,
        group.cents,group.expenditureCount,group.sourceUrl];
      if (storedOutsideCents(owner.outside_support_total) !== storedOutsideCents(expected.result.supportTotal)
        || storedOutsideCents(owner.outside_oppose_total) !== storedOutsideCents(expected.result.opposeTotal)
        || JSON.stringify(stored.map(project)) !== JSON.stringify(expectedGroups.map(project))
        || (owner.has_outside_money && !expected.result.outsideGroups.length)) {
        return preserve("stored outside materialization disagrees with its report authority");
      }
    } catch { return preserve("stored outside materialization is invalid"); }
  }
  return mergeTennesseeOutsideReportEvidence({ ...input.evidence, prior: owner.outside_report_provenance });
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
    const evidence = input.outsideReportEvidence ? await prepareOutsideEvidenceUpdate({
      db,linkId,link: input.link,evidence: input.outsideReportEvidence,
    }) : undefined;
    const summary = evidence?.update ? { ...input.summary,
      outsideSupportTotal: evidence.update.supportTotal, outsideOpposeTotal: evidence.update.opposeTotal } : input.summary;
    const outsideGroups = evidence?.update?.outsideGroups ?? input.outsideGroups;
    // Changed report authority invalidates an independently unbound old spender breakdown.
    const outsideGroupBreakdowns = evidence?.update ? [] : input.outsideGroupBreakdowns;
    if (summary) {
      await upsertSummary({ db, linkId, electionYear, summary, syncedAt });
    }
    if (evidence?.update) {
      await db.query(`UPDATE public.tn_candidate_finance_summaries SET outside_report_provenance=$3::jsonb
        WHERE link_id=$1::uuid AND election_year=$2`, [linkId,electionYear,JSON.stringify(evidence.update.provenance)]);
    }
    for (const breakdown of input.directBreakdowns ?? []) {
      await upsertDirectBreakdown({ db, linkId, electionYear, breakdown, syncedAt });
    }
    if (input.directBreakdowns) {
      await deleteStaleDirectBreakdowns({ db, linkId, electionYear, breakdowns: input.directBreakdowns });
    }
    for (const group of outsideGroups ?? []) {
      await upsertOutsideGroup({ db, linkId, electionYear, group, syncedAt });
    }
    for (const breakdown of outsideGroupBreakdowns ?? []) {
      await upsertOutsideGroupBreakdown({ db, linkId, electionYear, breakdown, syncedAt });
    }
    if (outsideGroupBreakdowns || outsideGroups) {
      await deleteStaleOutsideGroupBreakdowns({
        db,
        linkId,
        electionYear,
        breakdowns: outsideGroupBreakdowns ?? [],
      });
    }
    if (outsideGroups) {
      await deleteStaleOutsideGroups({ db, linkId, electionYear, groups: outsideGroups });
    }

    if (input.pacDonors !== undefined && input.pacSourceProvenance !== undefined) {
      await db.query(`INSERT INTO public.tn_candidate_finance_summaries
        (link_id,election_year,pac_source_provenance,last_synced_at)
        VALUES ($1::uuid,$2,$3::jsonb,$4::timestamptz)
        ON CONFLICT (link_id,election_year) DO UPDATE SET
          pac_source_provenance=EXCLUDED.pac_source_provenance,last_synced_at=EXCLUDED.last_synced_at`,
      [linkId, electionYear, JSON.stringify(input.pacSourceProvenance), syncedAt.toISOString()]);
      for (const donor of input.pacDonors) {
        await db.query(`INSERT INTO public.tn_candidate_finance_pac_donors
          (link_id,election_year,committee_id,committee_name,committee_type,amount,contribution_count,source_url,last_synced_at)
          VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz)
          ON CONFLICT (link_id,election_year,committee_id) DO UPDATE SET
            committee_name=EXCLUDED.committee_name,committee_type=EXCLUDED.committee_type,
            amount=EXCLUDED.amount,contribution_count=EXCLUDED.contribution_count,
            source_url=EXCLUDED.source_url,last_synced_at=EXCLUDED.last_synced_at`,
        [linkId,electionYear,donor.committeeId,donor.committeeName,donor.committeeType,
          donor.amount,donor.contributionCount,donor.sourceUrl,syncedAt.toISOString()]);
      }
      await db.query(`DELETE FROM public.tn_candidate_finance_pac_donors
        WHERE link_id=$1::uuid AND election_year=$2 AND NOT (committee_id = ANY($3::text[]))`,
      [linkId,electionYear,input.pacDonors.map(donor => donor.committeeId)]);
    }

    for (const classification of input.classifications ?? []) {
      await upsertFinanceLabelClassification({ db, classification });
    }

    return {
      linkId,
      summaryWritten: Boolean(summary),
      directBreakdownsWritten: input.directBreakdowns?.length ?? 0,
      outsideGroupsWritten: outsideGroups?.length ?? 0,
      outsideGroupBreakdownsWritten: outsideGroupBreakdowns?.length ?? 0,
      pacDonorsWritten: input.pacDonors?.length ?? 0,
      ...(evidence ? { outsideEvidenceAccepted: Boolean(evidence.update), outsideEvidenceDiagnostics: evidence.diagnostics } : {}),
      ...(evidence?.update ? { outsideSupportTotal: evidence.update.supportTotal, outsideOpposeTotal: evidence.update.opposeTotal } : {}),
    };
  });
}
