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

export type PennsylvaniaFinanceLinkStatus = "active" | "inactive";
export type PennsylvaniaFinanceLinkSource = "manual" | "pa_bulk";
export type PennsylvaniaFinanceDirectCategoryType = "occupation" | "contribution_size";
export type PennsylvaniaFinanceOutsideCategoryType = "donor" | "industry";
export type PennsylvaniaFinanceSupportOppose = "support" | "oppose";

export type PennsylvaniaFinanceLinkInput = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  candidateNameNormalized: string;
  officeName: string;
  district?: string | null;
  filerId: string;
  filerName: string;
  linkStatus?: PennsylvaniaFinanceLinkStatus;
  linkSource?: PennsylvaniaFinanceLinkSource;
  sourceUrl?: string | null;
  lastVerifiedAt?: Date | null;
};

export type PennsylvaniaFinanceSummaryInput = {
  totalReceipts?: number | null;
  directContributionTotal?: number | null;
  totalDisbursements?: number | null;
  cashOnHand?: number | null;
  outsideSupportTotal?: number | null;
  outsideOpposeTotal?: number | null;
  sourceUrl?: string | null;
};

export type PennsylvaniaFinanceDirectBreakdownInput = {
  categoryType: PennsylvaniaFinanceDirectCategoryType;
  categoryName: string;
  amount: number;
  contributorCount?: number | null;
  sourceUrl?: string | null;
};

export type PennsylvaniaFinanceOutsideGroupInput = {
  groupId: string;
  groupName: string;
  supportOppose: PennsylvaniaFinanceSupportOppose;
  amount: number;
  sourceUrl?: string | null;
};

export type PennsylvaniaFinanceOutsideGroupBreakdownInput = {
  groupId: string;
  supportOppose: PennsylvaniaFinanceSupportOppose;
  categoryType: PennsylvaniaFinanceOutsideCategoryType;
  categoryName: string;
  amount: number;
  contributorCount?: number | null;
  sourceUrl?: string | null;
};

export type PennsylvaniaFinancePacDonorInput = {
  committeeId: string;
  committeeName: string;
  amount: number;
  contributionCount: number;
  sourceUrl?: string | null;
};

export type PennsylvaniaFinanceSnapshotInput = {
  db: Queryable;
  link: PennsylvaniaFinanceLinkInput;
  syncedAt?: Date;
  summary?: PennsylvaniaFinanceSummaryInput;
  directBreakdowns?: readonly PennsylvaniaFinanceDirectBreakdownInput[];
  // When given, replaces the link's committee donors for the cycle.
  pacDonors?: readonly PennsylvaniaFinancePacDonorInput[];
  outsideGroups?: readonly PennsylvaniaFinanceOutsideGroupInput[];
  outsideGroupBreakdowns?: readonly PennsylvaniaFinanceOutsideGroupBreakdownInput[];
  classifications?: readonly FinanceLabelClassification[];
};

export type PennsylvaniaFinanceSnapshotWriteResult = {
  linkId: string;
  summaryWritten: boolean;
  directBreakdownsWritten: number;
  pacDonorsWritten: number;
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
    throw new Error(`Invalid Pennsylvania finance election year: ${value}`);
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
    throw new Error("Invalid Pennsylvania finance timestamp");
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
    throw new Error("Pennsylvania finance contributor count must be a nonnegative integer");
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

function validatePennsylvaniaFinanceLinkInput(link: PennsylvaniaFinanceLinkInput): void {
  requireNonEmpty(link.candidateId, "candidate id");
  requireNonEmpty(link.electionId, "election id");
  normalizeElectionYear(link.electionYear);
  requireNonEmpty(link.candidateNameNormalized, "Pennsylvania finance candidate name");
  requireNonEmpty(link.officeName, "Pennsylvania finance office name");
  requireNonEmpty(link.filerId, "Pennsylvania filer id");
  requireNonEmpty(link.filerName, "Pennsylvania filer name");
  normalizeNullableDate(link.lastVerifiedAt);
}

function validatePennsylvaniaFinanceSnapshotInput(input: PennsylvaniaFinanceSnapshotInput): void {
  validatePennsylvaniaFinanceLinkInput(input.link);
  const outsideBreakdownCount = input.outsideGroupBreakdowns?.length ?? 0;
  const outsideGroupCount = input.outsideGroups?.length ?? 0;
  if (outsideBreakdownCount > 0 && outsideGroupCount === 0) {
    throw new Error("Pennsylvania outside group breakdowns require outside groups in the same snapshot");
  }
  if (outsideBreakdownCount > 0) {
    const groupKeys = new Set(
      (input.outsideGroups ?? []).map(
        (group) => `${requireNonEmpty(group.groupId, "Pennsylvania outside group id")}\u0000${group.supportOppose}`
      )
    );
    for (const breakdown of input.outsideGroupBreakdowns ?? []) {
      const key = `${requireNonEmpty(breakdown.groupId, "Pennsylvania outside breakdown group id")}\u0000${breakdown.supportOppose}`;
      if (!groupKeys.has(key)) {
        throw new Error("Pennsylvania outside group breakdowns must reference outside groups in the same snapshot");
      }
    }
  }
}

async function withPennsylvaniaFinanceTransaction<T>(db: Queryable, work: (tx: Queryable) => Promise<T>): Promise<T> {
  if (!canOpenTransaction(db)) {
    if (isClientLikeQueryable(db)) {
      throw new Error("Pennsylvania finance snapshot writes must receive a Pool, not a PoolClient");
    }
    throw new Error("Pennsylvania finance snapshot writes must receive a connect-capable Pool");
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

export async function upsertPennsylvaniaFinanceLink(input: {
  db: Queryable;
  link: PennsylvaniaFinanceLinkInput;
}): Promise<{ linkId: string }> {
  validatePennsylvaniaFinanceLinkInput(input.link);

  const result = await input.db.query<ManualProtectedLinkRow>(
    `
      INSERT INTO public.pa_candidate_finance_links (
        candidate_id,
        election_id,
        election_year,
        candidate_name_normalized,
        office_name,
        district,
        filer_id,
        filer_name,
        link_status,
        link_source,
        source_url,
        last_verified_at
      )
      VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz)
      ON CONFLICT (candidate_id, election_id, filer_id)
      DO UPDATE SET
        candidate_name_normalized = EXCLUDED.candidate_name_normalized,
        office_name = EXCLUDED.office_name,
        district = EXCLUDED.district,
        filer_name = EXCLUDED.filer_name,
        ${manualProtectedLinkAssignments("pa_candidate_finance_links")},
        source_url = EXCLUDED.source_url,
        last_verified_at = EXCLUDED.last_verified_at
      RETURNING ${MANUAL_PROTECTED_LINK_RETURNING}
    `,
    [
      requireNonEmpty(input.link.candidateId, "candidate id"),
      requireNonEmpty(input.link.electionId, "election id"),
      normalizeElectionYear(input.link.electionYear),
      requireNonEmpty(input.link.candidateNameNormalized, "Pennsylvania finance candidate name"),
      requireNonEmpty(input.link.officeName, "Pennsylvania finance office name"),
      normalizeOptionalText(input.link.district),
      requireNonEmpty(input.link.filerId, "Pennsylvania filer id"),
      requireNonEmpty(input.link.filerName, "Pennsylvania filer name"),
      input.link.linkStatus ?? "active",
      input.link.linkSource ?? "manual",
      normalizeOptionalText(input.link.sourceUrl),
      normalizeNullableDate(input.link.lastVerifiedAt),
    ]
  );

  assertLinkWriteNotBlocked("Pennsylvania", result.rows[0], input.link.linkSource ?? "manual", input.link.electionYear);
  const linkId = result.rows[0]?.id;
  if (!linkId) {
    throw new Error("Pennsylvania finance link upsert did not return an id");
  }
  return { linkId };
}

export async function deactivatePennsylvaniaFinanceLinksForCandidateElection(input: {
  db: Queryable;
  candidateId: string;
  electionId: string;
  electionYear: number;
  verifiedAt?: Date | null;
}): Promise<number> {
  const result = await input.db.query(
    `
      UPDATE public.pa_candidate_finance_links
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
  summary: PennsylvaniaFinanceSummaryInput;
  syncedAt: Date;
}): Promise<void> {
  await input.db.query(
    `
      INSERT INTO public.pa_candidate_finance_summaries (
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
        outside_support_total = COALESCE(
          EXCLUDED.outside_support_total,
          pa_candidate_finance_summaries.outside_support_total
        ),
        outside_oppose_total = COALESCE(
          EXCLUDED.outside_oppose_total,
          pa_candidate_finance_summaries.outside_oppose_total
        ),
        source_url = EXCLUDED.source_url,
        last_synced_at = EXCLUDED.last_synced_at
    `,
    [
      requireNonEmpty(input.linkId, "Pennsylvania finance link id"),
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
  breakdown: PennsylvaniaFinanceDirectBreakdownInput;
  syncedAt: Date;
}): Promise<void> {
  await input.db.query(
    `
      INSERT INTO public.pa_candidate_finance_direct_breakdowns (
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
      requireNonEmpty(input.linkId, "Pennsylvania finance link id"),
      normalizeElectionYear(input.electionYear),
      input.breakdown.categoryType,
      requireNonEmpty(input.breakdown.categoryName, "Pennsylvania finance direct breakdown category"),
      normalizeAmount(input.breakdown.amount, "direct breakdown amount"),
      normalizeNullableCount(input.breakdown.contributorCount),
      normalizeOptionalText(input.breakdown.sourceUrl),
      input.syncedAt.toISOString(),
    ]
  );
}

function normalizeCount(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a nonnegative integer`);
  }
  return value;
}

async function upsertPacDonor(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  donor: PennsylvaniaFinancePacDonorInput;
  syncedAt: Date;
}): Promise<void> {
  await input.db.query(
    `
      INSERT INTO public.pa_candidate_finance_pac_donors (
        link_id,
        election_year,
        committee_id,
        committee_name,
        amount,
        contribution_count,
        source_url,
        last_synced_at
      )
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::timestamptz)
      ON CONFLICT (link_id, election_year, committee_id)
      DO UPDATE SET
        committee_name = EXCLUDED.committee_name,
        amount = EXCLUDED.amount,
        contribution_count = EXCLUDED.contribution_count,
        source_url = EXCLUDED.source_url,
        last_synced_at = EXCLUDED.last_synced_at
    `,
    [
      requireNonEmpty(input.linkId, "Pennsylvania finance link id"),
      normalizeElectionYear(input.electionYear),
      requireNonEmpty(input.donor.committeeId, "Pennsylvania PAC donor committee id"),
      requireNonEmpty(input.donor.committeeName, "Pennsylvania PAC donor committee name"),
      normalizeAmount(input.donor.amount, "PAC donor amount"),
      normalizeCount(input.donor.contributionCount, "PAC donor contribution count"),
      normalizeOptionalText(input.donor.sourceUrl),
      input.syncedAt.toISOString(),
    ]
  );
}

async function deleteStalePacDonors(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  donors: readonly PennsylvaniaFinancePacDonorInput[];
}): Promise<void> {
  const keep = input.donors.map((donor) => requireNonEmpty(donor.committeeId, "Pennsylvania PAC donor committee id"));
  await input.db.query(
    `
      DELETE FROM public.pa_candidate_finance_pac_donors
      WHERE link_id = $1::uuid
        AND election_year = $2
        AND NOT (committee_id = ANY($3::text[]))
    `,
    [requireNonEmpty(input.linkId, "Pennsylvania finance link id"), normalizeElectionYear(input.electionYear), keep]
  );
}

async function upsertOutsideGroup(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  group: PennsylvaniaFinanceOutsideGroupInput;
  syncedAt: Date;
}): Promise<void> {
  await input.db.query(
    `
      INSERT INTO public.pa_candidate_finance_outside_groups (
        link_id,
        election_year,
        group_id,
        group_name,
        support_oppose,
        amount,
        source_url,
        last_synced_at
      )
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::timestamptz)
      ON CONFLICT (link_id, election_year, group_id, support_oppose)
      DO UPDATE SET
        group_name = EXCLUDED.group_name,
        amount = EXCLUDED.amount,
        source_url = EXCLUDED.source_url,
        last_synced_at = EXCLUDED.last_synced_at
    `,
    [
      requireNonEmpty(input.linkId, "Pennsylvania finance link id"),
      normalizeElectionYear(input.electionYear),
      requireNonEmpty(input.group.groupId, "Pennsylvania outside group id"),
      requireNonEmpty(input.group.groupName, "Pennsylvania outside group name"),
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
  breakdown: PennsylvaniaFinanceOutsideGroupBreakdownInput;
  syncedAt: Date;
}): Promise<void> {
  await input.db.query(
    `
      INSERT INTO public.pa_candidate_finance_outside_group_breakdowns (
        link_id,
        election_year,
        group_id,
        support_oppose,
        category_type,
        category_name,
        amount,
        contributor_count,
        source_url,
        last_synced_at
      )
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)
      ON CONFLICT (link_id, election_year, group_id, support_oppose, category_type, category_name)
      DO UPDATE SET
        amount = EXCLUDED.amount,
        contributor_count = EXCLUDED.contributor_count,
        source_url = EXCLUDED.source_url,
        last_synced_at = EXCLUDED.last_synced_at
    `,
    [
      requireNonEmpty(input.linkId, "Pennsylvania finance link id"),
      normalizeElectionYear(input.electionYear),
      requireNonEmpty(input.breakdown.groupId, "Pennsylvania outside breakdown group id"),
      input.breakdown.supportOppose,
      input.breakdown.categoryType,
      requireNonEmpty(input.breakdown.categoryName, "Pennsylvania outside breakdown category"),
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
  breakdowns: readonly PennsylvaniaFinanceDirectBreakdownInput[];
}): Promise<void> {
  const keys = input.breakdowns.map((breakdown) => ({
    category_type: breakdown.categoryType,
    category_name: requireNonEmpty(breakdown.categoryName, "Pennsylvania finance direct breakdown category"),
  }));

  await input.db.query(
    `
      DELETE FROM public.pa_candidate_finance_direct_breakdowns
      WHERE link_id = $1::uuid
        AND election_year = $2
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset($3::jsonb) AS keep(
            category_type text,
            category_name text
          )
          WHERE keep.category_type = pa_candidate_finance_direct_breakdowns.category_type
            AND keep.category_name = pa_candidate_finance_direct_breakdowns.category_name
        )
    `,
    [requireNonEmpty(input.linkId, "Pennsylvania finance link id"), normalizeElectionYear(input.electionYear), JSON.stringify(keys)]
  );
}

async function deleteStaleOutsideGroupBreakdowns(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  breakdowns: readonly PennsylvaniaFinanceOutsideGroupBreakdownInput[];
}): Promise<void> {
  const keys = input.breakdowns.map((breakdown) => ({
    group_id: requireNonEmpty(breakdown.groupId, "Pennsylvania outside breakdown group id"),
    support_oppose: breakdown.supportOppose,
    category_type: breakdown.categoryType,
    category_name: requireNonEmpty(breakdown.categoryName, "Pennsylvania outside breakdown category"),
  }));

  await input.db.query(
    `
      DELETE FROM public.pa_candidate_finance_outside_group_breakdowns
      WHERE link_id = $1::uuid
        AND election_year = $2
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset($3::jsonb) AS keep(
            group_id text,
            support_oppose text,
            category_type text,
            category_name text
          )
          WHERE keep.group_id = pa_candidate_finance_outside_group_breakdowns.group_id
            AND keep.support_oppose = pa_candidate_finance_outside_group_breakdowns.support_oppose
            AND keep.category_type = pa_candidate_finance_outside_group_breakdowns.category_type
            AND keep.category_name = pa_candidate_finance_outside_group_breakdowns.category_name
        )
    `,
    [requireNonEmpty(input.linkId, "Pennsylvania finance link id"), normalizeElectionYear(input.electionYear), JSON.stringify(keys)]
  );
}

async function deleteStaleOutsideGroups(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  groups: readonly PennsylvaniaFinanceOutsideGroupInput[];
}): Promise<void> {
  const keys = input.groups.map((group) => ({
    group_id: requireNonEmpty(group.groupId, "Pennsylvania outside group id"),
    support_oppose: group.supportOppose,
  }));

  await input.db.query(
    `
      DELETE FROM public.pa_candidate_finance_outside_groups
      WHERE link_id = $1::uuid
        AND election_year = $2
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset($3::jsonb) AS keep(
            group_id text,
            support_oppose text
          )
          WHERE keep.group_id = pa_candidate_finance_outside_groups.group_id
            AND keep.support_oppose = pa_candidate_finance_outside_groups.support_oppose
        )
    `,
    [requireNonEmpty(input.linkId, "Pennsylvania finance link id"), normalizeElectionYear(input.electionYear), JSON.stringify(keys)]
  );
}

export async function replacePennsylvaniaCandidateFinanceSnapshot(
  input: PennsylvaniaFinanceSnapshotInput
): Promise<PennsylvaniaFinanceSnapshotWriteResult> {
  const syncedAt = input.syncedAt ?? new Date();
  if (Number.isNaN(syncedAt.getTime())) {
    throw new Error("Invalid Pennsylvania finance sync timestamp");
  }
  validatePennsylvaniaFinanceSnapshotInput(input);
  const electionYear = normalizeElectionYear(input.link.electionYear);

  return await withPennsylvaniaFinanceTransaction(input.db, async (db) => {
    const { linkId } = await upsertPennsylvaniaFinanceLink({ db, link: input.link });
    if (input.summary) {
      await upsertSummary({ db, linkId, electionYear, summary: input.summary, syncedAt });
    }

    for (const breakdown of input.directBreakdowns ?? []) {
      await upsertDirectBreakdown({ db, linkId, electionYear, breakdown, syncedAt });
    }
    if (input.directBreakdowns) {
      await deleteStaleDirectBreakdowns({ db, linkId, electionYear, breakdowns: input.directBreakdowns });
    }

    // Donors with a zero total are not stored (the table requires amount > 0).
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

    for (const classification of input.classifications ?? []) {
      await upsertFinanceLabelClassification({ db, classification });
    }

    return {
      linkId,
      summaryWritten: Boolean(input.summary),
      directBreakdownsWritten: input.directBreakdowns?.length ?? 0,
      pacDonorsWritten: pacDonors?.length ?? 0,
      outsideGroupsWritten: input.outsideGroups?.length ?? 0,
      outsideGroupBreakdownsWritten: input.outsideGroupBreakdowns?.length ?? 0,
    };
  });
}
