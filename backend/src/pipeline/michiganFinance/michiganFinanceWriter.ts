import type { Pool, PoolClient } from "pg";

import type { FinanceLabelClassification } from "../finance/financeLabelClassifier.js";
import { upsertFinanceLabelClassification } from "../finance/financeIndustryClassificationService.js";
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

export type MichiganFinanceLinkStatus = "active" | "inactive";
export type MichiganFinanceLinkSource = "manual" | "mitn_public_search";
export type MichiganFinanceDirectCategoryType = "occupation" | "contribution_size";
export type MichiganFinanceOutsideCategoryType = "donor" | "industry";
export type MichiganFinanceSupportOppose = "support" | "oppose";

export type MichiganFinanceLinkInput = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  candidateNameNormalized: string;
  officeName: string;
  district?: string | null;
  committeeId: string;
  committeeName: string;
  linkStatus?: MichiganFinanceLinkStatus;
  linkSource?: MichiganFinanceLinkSource;
  sourceUrl?: string | null;
  lastVerifiedAt?: Date | null;
};

export type MichiganFinanceSummaryInput = {
  totalReceipts?: number | null;
  directContributionTotal?: number | null;
  candidateLoanTotal?: number | null;
  totalDisbursements?: number | null;
  cashOnHand?: number | null;
  outsideSupportTotal?: number | null;
  outsideOpposeTotal?: number | null;
  sourceUrl?: string | null;
};

export type MichiganFinanceDirectBreakdownInput = {
  categoryType: MichiganFinanceDirectCategoryType;
  categoryName: string;
  amount: number;
  contributorCount?: number | null;
  sourceUrl?: string | null;
};

export type MichiganFinanceOutsideGroupInput = {
  committeeId: string;
  committeeName: string;
  supportOppose: MichiganFinanceSupportOppose;
  amount: number;
  sourceUrl?: string | null;
};

export type MichiganFinanceOutsideGroupBreakdownInput = {
  committeeId: string;
  supportOppose: MichiganFinanceSupportOppose;
  categoryType: MichiganFinanceOutsideCategoryType;
  categoryName: string;
  amount: number;
  contributorCount?: number | null;
  sourceUrl?: string | null;
};

export type MichiganFinancePacDonorInput = {
  committeeId: string;
  committeeName: string;
  committeeType: string;
  amount: number;
  contributionCount: number;
  sourceUrl?: string | null;
};

export type MichiganFinanceSnapshotInput = {
  db: Queryable;
  link: MichiganFinanceLinkInput;
  syncedAt?: Date;
  summary?: MichiganFinanceSummaryInput;
  directBreakdowns?: readonly MichiganFinanceDirectBreakdownInput[];
  outsideGroups?: readonly MichiganFinanceOutsideGroupInput[];
  outsideGroupBreakdowns?: readonly MichiganFinanceOutsideGroupBreakdownInput[];
  classifications?: readonly FinanceLabelClassification[];
  /** Verified outside totals cover every active target committee for this candidate/election. */
  candidateElectionOutsideSnapshot?: boolean;
  /** Omitted preserves prior PAC donors; an empty list clears them. */
  pacDonors?: readonly MichiganFinancePacDonorInput[];
};

export type MichiganFinanceSnapshotWriteResult = {
  linkId: string;
  summaryWritten: boolean;
  directBreakdownsWritten: number;
  outsideGroupsWritten: number;
  outsideGroupBreakdownsWritten: number;
  pacDonorsWritten?: number;
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
    throw new Error(`Invalid Michigan finance election year: ${value}`);
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
    throw new Error("Invalid Michigan finance timestamp");
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
    throw new Error("Michigan finance contributor count must be a nonnegative integer");
  }
  return value;
}

function normalizePacDonorCount(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("Michigan PAC donor contribution count must be a nonnegative integer");
  }
  return value;
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

function validateMichiganFinanceLinkInput(link: MichiganFinanceLinkInput): void {
  requireNonEmpty(link.candidateId, "candidate id");
  requireNonEmpty(link.electionId, "election id");
  normalizeElectionYear(link.electionYear);
  requireNonEmpty(link.candidateNameNormalized, "Michigan finance candidate name");
  requireNonEmpty(link.officeName, "Michigan finance office name");
  requireNonEmpty(link.committeeId, "Michigan committee id");
  requireNonEmpty(link.committeeName, "Michigan committee name");
  normalizeNullableDate(link.lastVerifiedAt);
}

function validateMichiganFinanceSnapshotInput(input: MichiganFinanceSnapshotInput): void {
  validateMichiganFinanceLinkInput(input.link);
  for (const donor of input.pacDonors ?? []) {
    requireNonEmpty(donor.committeeId, "Michigan PAC donor committee id");
    requireNonEmpty(donor.committeeName, "Michigan PAC donor committee name");
    requireNonEmpty(donor.committeeType, "Michigan PAC donor committee type");
    normalizeAmount(donor.amount, "PAC donor amount");
    normalizePacDonorCount(donor.contributionCount);
  }
  const outsideBreakdownCount = input.outsideGroupBreakdowns?.length ?? 0;
  const outsideGroupCount = input.outsideGroups?.length ?? 0;
  if (outsideBreakdownCount > 0 && outsideGroupCount === 0) {
    throw new Error("Michigan outside group breakdowns require outside groups in the same snapshot");
  }
  if (outsideBreakdownCount > 0) {
    const groupKeys = new Set(
      (input.outsideGroups ?? []).map(
        (group) =>
          `${requireNonEmpty(group.committeeId, "Michigan outside group committee id")}\u0000${group.supportOppose}`
      )
    );
    for (const breakdown of input.outsideGroupBreakdowns ?? []) {
      const key = `${requireNonEmpty(breakdown.committeeId, "Michigan outside breakdown committee id")}\u0000${breakdown.supportOppose}`;
      if (!groupKeys.has(key)) {
        throw new Error("Michigan outside group breakdowns must reference outside groups in the same snapshot");
      }
    }
  }
}

async function withMichiganFinanceTransaction<T>(db: Queryable, work: (tx: Queryable) => Promise<T>): Promise<T> {
  if (!canOpenTransaction(db)) {
    if (isClientLikeQueryable(db)) {
      throw new Error("Michigan finance snapshot writes must receive a Pool, not a PoolClient");
    }
    try {
      await db.query("BEGIN");
      const result = await work(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await db.query("ROLLBACK");
      } catch {
        // Preserve the original write failure.
      }
      throw error;
    }
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

export async function upsertMichiganFinanceLink(input: {
  db: Queryable;
  link: MichiganFinanceLinkInput;
}): Promise<{ linkId: string }> {
  validateMichiganFinanceLinkInput(input.link);

  const result = await input.db.query<ManualProtectedLinkRow>(
    `
      INSERT INTO public.mi_candidate_finance_links (
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
        ${manualProtectedLinkAssignments("mi_candidate_finance_links")},
        source_url = EXCLUDED.source_url,
        last_verified_at = EXCLUDED.last_verified_at
      RETURNING ${MANUAL_PROTECTED_LINK_RETURNING}
    `,
    [
      requireNonEmpty(input.link.candidateId, "candidate id"),
      requireNonEmpty(input.link.electionId, "election id"),
      normalizeElectionYear(input.link.electionYear),
      requireNonEmpty(input.link.candidateNameNormalized, "Michigan finance candidate name"),
      requireNonEmpty(input.link.officeName, "Michigan finance office name"),
      normalizeOptionalText(input.link.district),
      requireNonEmpty(input.link.committeeId, "Michigan committee id"),
      requireNonEmpty(input.link.committeeName, "Michigan committee name"),
      input.link.linkStatus ?? "active",
      input.link.linkSource ?? "manual",
      normalizeOptionalText(input.link.sourceUrl),
      normalizeNullableDate(input.link.lastVerifiedAt),
    ]
  );

  assertLinkWriteNotBlocked("Michigan", result.rows[0], input.link.linkSource ?? "manual", input.link.electionYear);
  const linkId = result.rows[0]?.id;
  if (!linkId) {
    throw new Error("Michigan finance link upsert did not return an id");
  }
  return { linkId };
}

export async function deactivateMichiganFinanceLinksForCandidateElection(input: {
  db: Queryable;
  candidateId: string;
  electionId: string;
  electionYear: number;
  verifiedAt?: Date | null;
}): Promise<number> {
  const result = await input.db.query(
    `
      UPDATE public.mi_candidate_finance_links
      SET link_status = 'inactive',
          last_verified_at = $4::timestamptz
      WHERE candidate_id = $1::uuid
        AND election_id = $2::uuid
        AND election_year = $3
        AND link_status = 'active'
        AND link_source IS DISTINCT FROM 'manual'
    `,
    [
      requireNonEmpty(input.candidateId, "candidate id"),
      requireNonEmpty(input.electionId, "election id"),
      normalizeElectionYear(input.electionYear),
      normalizeNullableDate(input.verifiedAt),
    ]
  );
  return typeof result.rowCount === "number" ? result.rowCount : 0;
}

async function upsertSummary(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  summary: MichiganFinanceSummaryInput;
  syncedAt: Date;
}): Promise<void> {
  await input.db.query(
    `
      INSERT INTO public.mi_candidate_finance_summaries (
        link_id,
        election_year,
        total_receipts,
        direct_contribution_total,
        candidate_loan_total,
        total_disbursements,
        cash_on_hand,
        outside_support_total,
        outside_oppose_total,
        source_url,
        last_synced_at
      )
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)
      ON CONFLICT (link_id, election_year)
      DO UPDATE SET
        total_receipts = EXCLUDED.total_receipts,
        direct_contribution_total = EXCLUDED.direct_contribution_total,
        candidate_loan_total = EXCLUDED.candidate_loan_total,
        total_disbursements = EXCLUDED.total_disbursements,
        cash_on_hand = EXCLUDED.cash_on_hand,
        outside_support_total = COALESCE(
          EXCLUDED.outside_support_total,
          mi_candidate_finance_summaries.outside_support_total
        ),
        outside_oppose_total = COALESCE(
          EXCLUDED.outside_oppose_total,
          mi_candidate_finance_summaries.outside_oppose_total
        ),
        source_url = EXCLUDED.source_url,
        last_synced_at = EXCLUDED.last_synced_at
    `,
    [
      requireNonEmpty(input.linkId, "Michigan finance link id"),
      normalizeElectionYear(input.electionYear),
      normalizeNullableAmount(input.summary.totalReceipts, "total receipts"),
      normalizeNullableAmount(input.summary.directContributionTotal, "direct contribution total"),
      normalizeNullableAmount(input.summary.candidateLoanTotal, "candidate loan total"),
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
  breakdown: MichiganFinanceDirectBreakdownInput;
  syncedAt: Date;
}): Promise<void> {
  await input.db.query(
    `
      INSERT INTO public.mi_candidate_finance_direct_breakdowns (
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
      requireNonEmpty(input.linkId, "Michigan finance link id"),
      normalizeElectionYear(input.electionYear),
      input.breakdown.categoryType,
      requireNonEmpty(input.breakdown.categoryName, "Michigan finance direct breakdown category"),
      normalizeAmount(input.breakdown.amount, "direct breakdown amount"),
      normalizeNullableCount(input.breakdown.contributorCount),
      normalizeOptionalText(input.breakdown.sourceUrl),
      input.syncedAt.toISOString(),
    ]
  );
}

async function upsertPacDonor(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  donor: MichiganFinancePacDonorInput;
  syncedAt: Date;
}): Promise<void> {
  await input.db.query(
    `
      INSERT INTO public.mi_candidate_finance_pac_donors (
        link_id,
        election_year,
        committee_id,
        committee_name,
        committee_type,
        amount,
        contribution_count,
        source_url,
        last_synced_at
      )
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)
      ON CONFLICT (link_id, election_year, committee_id)
      DO UPDATE SET
        committee_name = EXCLUDED.committee_name,
        committee_type = EXCLUDED.committee_type,
        amount = EXCLUDED.amount,
        contribution_count = EXCLUDED.contribution_count,
        source_url = EXCLUDED.source_url,
        last_synced_at = EXCLUDED.last_synced_at
    `,
    [
      requireNonEmpty(input.linkId, "Michigan finance link id"),
      normalizeElectionYear(input.electionYear),
      requireNonEmpty(input.donor.committeeId, "Michigan PAC donor committee id"),
      requireNonEmpty(input.donor.committeeName, "Michigan PAC donor committee name"),
      requireNonEmpty(input.donor.committeeType, "Michigan PAC donor committee type"),
      normalizeAmount(input.donor.amount, "PAC donor amount"),
      normalizePacDonorCount(input.donor.contributionCount),
      normalizeOptionalText(input.donor.sourceUrl),
      input.syncedAt.toISOString(),
    ]
  );
}

async function deleteStalePacDonors(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  donors: readonly MichiganFinancePacDonorInput[];
}): Promise<void> {
  const keep = input.donors.map((donor) => requireNonEmpty(donor.committeeId, "Michigan PAC donor committee id"));
  await input.db.query(
    `
      DELETE FROM public.mi_candidate_finance_pac_donors
      WHERE link_id = $1::uuid
        AND election_year = $2
        AND NOT (committee_id = ANY($3::text[]))
    `,
    [requireNonEmpty(input.linkId, "Michigan finance link id"), normalizeElectionYear(input.electionYear), keep]
  );
}

async function upsertOutsideGroup(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  group: MichiganFinanceOutsideGroupInput;
  syncedAt: Date;
}): Promise<void> {
  await input.db.query(
    `
      INSERT INTO public.mi_candidate_finance_outside_groups (
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
      requireNonEmpty(input.linkId, "Michigan finance link id"),
      normalizeElectionYear(input.electionYear),
      requireNonEmpty(input.group.committeeId, "Michigan outside group committee id"),
      requireNonEmpty(input.group.committeeName, "Michigan outside group committee name"),
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
  breakdown: MichiganFinanceOutsideGroupBreakdownInput;
  syncedAt: Date;
}): Promise<void> {
  await input.db.query(
    `
      INSERT INTO public.mi_candidate_finance_outside_group_breakdowns (
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
      requireNonEmpty(input.linkId, "Michigan finance link id"),
      normalizeElectionYear(input.electionYear),
      requireNonEmpty(input.breakdown.committeeId, "Michigan outside breakdown committee id"),
      input.breakdown.supportOppose,
      input.breakdown.categoryType,
      requireNonEmpty(input.breakdown.categoryName, "Michigan outside breakdown category"),
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
  breakdowns: readonly MichiganFinanceDirectBreakdownInput[];
}): Promise<void> {
  const keys = input.breakdowns.map((breakdown) => ({
    category_type: breakdown.categoryType,
    category_name: requireNonEmpty(breakdown.categoryName, "Michigan finance direct breakdown category"),
  }));

  await input.db.query(
    `
      DELETE FROM public.mi_candidate_finance_direct_breakdowns
      WHERE link_id = $1::uuid
        AND election_year = $2
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset($3::jsonb) AS keep(
            category_type text,
            category_name text
          )
          WHERE keep.category_type = mi_candidate_finance_direct_breakdowns.category_type
            AND keep.category_name = mi_candidate_finance_direct_breakdowns.category_name
        )
    `,
    [requireNonEmpty(input.linkId, "Michigan finance link id"), normalizeElectionYear(input.electionYear), JSON.stringify(keys)]
  );
}

async function deleteStaleOutsideGroupBreakdowns(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  breakdowns: readonly MichiganFinanceOutsideGroupBreakdownInput[];
}): Promise<void> {
  const keys = input.breakdowns.map((breakdown) => ({
    committee_id: requireNonEmpty(breakdown.committeeId, "Michigan outside breakdown committee id"),
    support_oppose: breakdown.supportOppose,
    category_type: breakdown.categoryType,
    category_name: requireNonEmpty(breakdown.categoryName, "Michigan outside breakdown category"),
  }));

  await input.db.query(
    `
      DELETE FROM public.mi_candidate_finance_outside_group_breakdowns
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
          WHERE keep.committee_id = mi_candidate_finance_outside_group_breakdowns.committee_id
            AND keep.support_oppose = mi_candidate_finance_outside_group_breakdowns.support_oppose
            AND keep.category_type = mi_candidate_finance_outside_group_breakdowns.category_type
            AND keep.category_name = mi_candidate_finance_outside_group_breakdowns.category_name
        )
    `,
    [requireNonEmpty(input.linkId, "Michigan finance link id"), normalizeElectionYear(input.electionYear), JSON.stringify(keys)]
  );
}

async function deleteStaleOutsideGroups(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  groups: readonly MichiganFinanceOutsideGroupInput[];
}): Promise<void> {
  const keys = input.groups.map((group) => ({
    committee_id: requireNonEmpty(group.committeeId, "Michigan outside group committee id"),
    support_oppose: group.supportOppose,
  }));

  await input.db.query(
    `
      DELETE FROM public.mi_candidate_finance_outside_groups
      WHERE link_id = $1::uuid
        AND election_year = $2
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset($3::jsonb) AS keep(
            committee_id text,
            support_oppose text
          )
          WHERE keep.committee_id = mi_candidate_finance_outside_groups.committee_id
            AND keep.support_oppose = mi_candidate_finance_outside_groups.support_oppose
        )
    `,
    [requireNonEmpty(input.linkId, "Michigan finance link id"), normalizeElectionYear(input.electionYear), JSON.stringify(keys)]
  );
}

async function propagateCandidateElectionOutsideSnapshot(input: {
  db: Queryable; link: MichiganFinanceLinkInput; selectedLinkId: string;
  electionYear: number; supportTotal: number; opposeTotal: number;
  groups: readonly MichiganFinanceOutsideGroupInput[];
  breakdowns: readonly MichiganFinanceOutsideGroupBreakdownInput[]; syncedAt: Date;
}): Promise<void> {
  const siblings = await input.db.query<{ id: string }>(`
    SELECT id::text AS id
    FROM public.mi_candidate_finance_links
    WHERE candidate_id = $1::uuid
      AND election_id = $2::uuid
      AND election_year = $3
      AND link_status = 'active'
      AND id <> $4::uuid
    ORDER BY id
  `, [input.link.candidateId, input.link.electionId, input.electionYear, input.selectedLinkId]);
  for (const sibling of siblings.rows) {
    const linkId = requireNonEmpty(sibling.id, "Michigan sibling finance link id");
    if (linkId === input.selectedLinkId) continue;
    // Outside-only inserts must not suppress the sibling's due receipt sync.
    // Existing direct money, provenance and receipt freshness remain untouched.
    await input.db.query(`
      INSERT INTO public.mi_candidate_finance_summaries (
        link_id, election_year, outside_support_total, outside_oppose_total, last_synced_at
      )
      VALUES ($1::uuid, $2, $3, $4, $5::timestamptz)
      ON CONFLICT (link_id, election_year)
      DO UPDATE SET
        outside_support_total = EXCLUDED.outside_support_total,
        outside_oppose_total = EXCLUDED.outside_oppose_total
    `, [linkId, input.electionYear,
      normalizeAmount(input.supportTotal, "outside support total"),
      normalizeAmount(input.opposeTotal, "outside oppose total"), new Date(0).toISOString()]);
    for (const group of input.groups) {
      await upsertOutsideGroup({ db: input.db, linkId, electionYear: input.electionYear, group, syncedAt: input.syncedAt });
    }
    for (const breakdown of input.breakdowns) {
      await upsertOutsideGroupBreakdown({ db: input.db, linkId, electionYear: input.electionYear, breakdown, syncedAt: input.syncedAt });
    }
    await deleteStaleOutsideGroupBreakdowns({ db: input.db, linkId, electionYear: input.electionYear, breakdowns: input.breakdowns });
    await deleteStaleOutsideGroups({ db: input.db, linkId, electionYear: input.electionYear, groups: input.groups });
  }
}

export async function replaceMichiganCandidateFinanceSnapshot(
  input: MichiganFinanceSnapshotInput
): Promise<MichiganFinanceSnapshotWriteResult> {
  const syncedAt = input.syncedAt ?? new Date();
  if (Number.isNaN(syncedAt.getTime())) {
    throw new Error("Invalid Michigan finance sync timestamp");
  }
  validateMichiganFinanceSnapshotInput(input);
  const electionYear = normalizeElectionYear(input.link.electionYear);

  return await withMichiganFinanceTransaction(input.db, async (db) => {
    const { linkId } = await upsertMichiganFinanceLink({ db, link: input.link });
    if (input.summary) {
      await upsertSummary({ db, linkId, electionYear, summary: input.summary, syncedAt });
    }

    for (const breakdown of input.directBreakdowns ?? []) {
      await upsertDirectBreakdown({ db, linkId, electionYear, breakdown, syncedAt });
    }
    if (input.directBreakdowns) {
      await deleteStaleDirectBreakdowns({ db, linkId, electionYear, breakdowns: input.directBreakdowns });
    }

    const pacDonors = input.pacDonors?.filter((donor) => donor.amount > 0);
    for (const donor of pacDonors ?? []) {
      await upsertPacDonor({ db, linkId, electionYear, donor, syncedAt });
    }
    if (pacDonors) {
      await deleteStalePacDonors({ db, linkId, electionYear, donors: pacDonors });
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

    if (input.candidateElectionOutsideSnapshot === true &&
        input.outsideGroups !== undefined && input.outsideGroupBreakdowns !== undefined &&
        input.summary?.outsideSupportTotal != null && input.summary.outsideOpposeTotal != null) {
      await propagateCandidateElectionOutsideSnapshot({
        db, link: input.link, selectedLinkId: linkId, electionYear,
        supportTotal: input.summary.outsideSupportTotal, opposeTotal: input.summary.outsideOpposeTotal,
        groups: input.outsideGroups, breakdowns: input.outsideGroupBreakdowns, syncedAt,
      });
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
      ...(pacDonors ? { pacDonorsWritten: pacDonors.length } : {}),
    };
  });
}
