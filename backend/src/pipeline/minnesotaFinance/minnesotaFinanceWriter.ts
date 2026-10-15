import type { Pool, PoolClient } from "pg";
import {
  validateMinnesotaCommitteeCashSnapshot,
  writeMinnesotaCommitteeCash,
  type MinnesotaCommitteeCashSnapshot,
} from "./minnesotaCommitteeCashWriter.js";
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

export type MinnesotaFinanceLinkStatus = "active" | "inactive";
export type MinnesotaFinanceLinkSource = "manual" | "mn_board";
export type MinnesotaFinanceOutsideCategoryType = "donor" | "industry";
export type MinnesotaFinanceSupportOppose = "support" | "oppose";

export type MinnesotaFinanceLinkInput = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  candidateNameNormalized: string;
  officeName: string;
  district?: string | null;
  committeeId: string;
  committeeName: string;
  linkStatus?: MinnesotaFinanceLinkStatus;
  linkSource?: MinnesotaFinanceLinkSource;
  sourceUrl?: string | null;
  lastVerifiedAt?: Date | null;
};

export type MinnesotaFinanceSummaryInput = {
  totalReceipts?: number | null;
  directContributionTotal?: number | null;
  totalDisbursements?: number | null;
  cashOnHand?: number | null;
  outsideSupportTotal?: number | null;
  outsideOpposeTotal?: number | null;
  sourceUrl?: string | null;
};

export type MinnesotaFinanceOutsideGroupInput = {
  committeeId: string;
  committeeName: string;
  supportOppose: MinnesotaFinanceSupportOppose;
  amount: number;
  sourceUrl?: string | null;
};

export type MinnesotaFinanceOutsideGroupBreakdownInput = {
  committeeId: string;
  supportOppose: MinnesotaFinanceSupportOppose;
  categoryType: MinnesotaFinanceOutsideCategoryType;
  categoryName: string;
  amount: number;
  contributorCount?: number | null;
  sourceUrl?: string | null;
};

export type MinnesotaFinanceSnapshotInput = {
  db: Queryable;
  link: MinnesotaFinanceLinkInput;
  syncedAt?: Date;
  summary?: MinnesotaFinanceSummaryInput;
  outsideGroups?: readonly MinnesotaFinanceOutsideGroupInput[];
  outsideGroupBreakdowns?: readonly MinnesotaFinanceOutsideGroupBreakdownInput[];
  /** Omit when unavailable; supplied snapshots replace only this component. */
  reportedCommitteeCash?: MinnesotaCommitteeCashSnapshot;
};

export type MinnesotaFinanceSnapshotWriteResult = {
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
    throw new Error(`Invalid Minnesota finance election year: ${value}`);
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
    throw new Error("Invalid Minnesota finance timestamp");
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
    throw new Error("Minnesota finance contributor count must be a nonnegative integer");
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

function validateMinnesotaFinanceLinkInput(link: MinnesotaFinanceLinkInput): void {
  requireNonEmpty(link.candidateId, "candidate id");
  requireNonEmpty(link.electionId, "election id");
  normalizeElectionYear(link.electionYear);
  requireNonEmpty(link.candidateNameNormalized, "Minnesota finance candidate name");
  requireNonEmpty(link.officeName, "Minnesota finance office name");
  requireNonEmpty(link.committeeId, "Minnesota committee id");
  requireNonEmpty(link.committeeName, "Minnesota committee name");
  normalizeNullableDate(link.lastVerifiedAt);
}

function validateMinnesotaFinanceSnapshotInput(input: MinnesotaFinanceSnapshotInput): void {
  validateMinnesotaFinanceLinkInput(input.link);
  if (input.reportedCommitteeCash !== undefined) validateMinnesotaCommitteeCashSnapshot(input.reportedCommitteeCash);
  const outsideBreakdownCount = input.outsideGroupBreakdowns?.length ?? 0;
  const outsideGroupCount = input.outsideGroups?.length ?? 0;
  if (outsideBreakdownCount > 0 && outsideGroupCount === 0) {
    throw new Error("Minnesota outside group breakdowns require outside groups in the same snapshot");
  }
  if (outsideBreakdownCount > 0) {
    const groupKeys = new Set(
      (input.outsideGroups ?? []).map(
        (group) =>
          `${requireNonEmpty(group.committeeId, "Minnesota outside group committee id")}\u0000${group.supportOppose}`
      )
    );
    for (const breakdown of input.outsideGroupBreakdowns ?? []) {
      const key = `${requireNonEmpty(breakdown.committeeId, "Minnesota outside breakdown committee id")}\u0000${breakdown.supportOppose}`;
      if (!groupKeys.has(key)) {
        throw new Error("Minnesota outside group breakdowns must reference outside groups in the same snapshot");
      }
    }
  }
}

async function withMinnesotaFinanceTransaction<T>(db: Queryable, work: (tx: Queryable) => Promise<T>): Promise<T> {
  if (!canOpenTransaction(db)) {
    if (isClientLikeQueryable(db)) {
      throw new Error("Minnesota finance snapshot writes must receive a Pool, not a PoolClient");
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

export async function upsertMinnesotaFinanceLink(input: {
  db: Queryable;
  link: MinnesotaFinanceLinkInput;
}): Promise<{ linkId: string }> {
  validateMinnesotaFinanceLinkInput(input.link);

  const result = await input.db.query<ManualProtectedLinkRow>(
    `
      INSERT INTO public.mn_candidate_finance_links (
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
        ${manualProtectedLinkAssignments("mn_candidate_finance_links")},
        source_url = EXCLUDED.source_url,
        last_verified_at = EXCLUDED.last_verified_at
      RETURNING ${MANUAL_PROTECTED_LINK_RETURNING}
    `,
    [
      requireNonEmpty(input.link.candidateId, "candidate id"),
      requireNonEmpty(input.link.electionId, "election id"),
      normalizeElectionYear(input.link.electionYear),
      requireNonEmpty(input.link.candidateNameNormalized, "Minnesota finance candidate name"),
      requireNonEmpty(input.link.officeName, "Minnesota finance office name"),
      normalizeOptionalText(input.link.district),
      requireNonEmpty(input.link.committeeId, "Minnesota committee id"),
      requireNonEmpty(input.link.committeeName, "Minnesota committee name"),
      input.link.linkStatus ?? "active",
      input.link.linkSource ?? "manual",
      normalizeOptionalText(input.link.sourceUrl),
      normalizeNullableDate(input.link.lastVerifiedAt),
    ]
  );

  assertLinkWriteNotBlocked("Minnesota", result.rows[0], input.link.linkSource ?? "manual", input.link.electionYear);
  const linkId = result.rows[0]?.id;
  if (!linkId) {
    throw new Error("Minnesota finance link upsert did not return an id");
  }
  return { linkId };
}

async function upsertSummary(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  summary: MinnesotaFinanceSummaryInput;
  syncedAt: Date;
}): Promise<void> {
  await input.db.query(
    `
      INSERT INTO public.mn_candidate_finance_summaries (
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
        total_receipts = COALESCE(EXCLUDED.total_receipts, mn_candidate_finance_summaries.total_receipts),
        direct_contribution_total = COALESCE(EXCLUDED.direct_contribution_total, mn_candidate_finance_summaries.direct_contribution_total),
        total_disbursements = COALESCE(EXCLUDED.total_disbursements, mn_candidate_finance_summaries.total_disbursements),
        cash_on_hand = COALESCE(EXCLUDED.cash_on_hand, mn_candidate_finance_summaries.cash_on_hand),
        outside_support_total = COALESCE(EXCLUDED.outside_support_total, mn_candidate_finance_summaries.outside_support_total),
        outside_oppose_total = COALESCE(EXCLUDED.outside_oppose_total, mn_candidate_finance_summaries.outside_oppose_total),
        source_url = COALESCE(EXCLUDED.source_url, mn_candidate_finance_summaries.source_url),
        last_synced_at = EXCLUDED.last_synced_at
    `,
    [
      requireNonEmpty(input.linkId, "Minnesota finance link id"),
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

async function upsertOutsideGroup(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  group: MinnesotaFinanceOutsideGroupInput;
  syncedAt: Date;
}): Promise<void> {
  await input.db.query(
    `
      INSERT INTO public.mn_candidate_finance_outside_groups (
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
      requireNonEmpty(input.linkId, "Minnesota finance link id"),
      normalizeElectionYear(input.electionYear),
      requireNonEmpty(input.group.committeeId, "Minnesota outside group committee id"),
      requireNonEmpty(input.group.committeeName, "Minnesota outside group committee name"),
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
  breakdown: MinnesotaFinanceOutsideGroupBreakdownInput;
  syncedAt: Date;
}): Promise<void> {
  await input.db.query(
    `
      INSERT INTO public.mn_candidate_finance_outside_group_breakdowns (
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
      requireNonEmpty(input.linkId, "Minnesota finance link id"),
      normalizeElectionYear(input.electionYear),
      requireNonEmpty(input.breakdown.committeeId, "Minnesota outside breakdown committee id"),
      input.breakdown.supportOppose,
      input.breakdown.categoryType,
      requireNonEmpty(input.breakdown.categoryName, "Minnesota outside breakdown category"),
      normalizeAmount(input.breakdown.amount, "outside group breakdown amount"),
      normalizeNullableCount(input.breakdown.contributorCount),
      normalizeOptionalText(input.breakdown.sourceUrl),
      input.syncedAt.toISOString(),
    ]
  );
}

async function deleteStaleOutsideGroups(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  groups: readonly MinnesotaFinanceOutsideGroupInput[];
}): Promise<void> {
  const keys = input.groups.map((group) => ({
    committee_id: requireNonEmpty(group.committeeId, "Minnesota outside group committee id"),
    support_oppose: group.supportOppose,
  }));

  await input.db.query(
    `
      DELETE FROM public.mn_candidate_finance_outside_groups
      WHERE link_id = $1::uuid
        AND election_year = $2
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset($3::jsonb) AS keep(
            committee_id text,
            support_oppose text
          )
          WHERE keep.committee_id = mn_candidate_finance_outside_groups.committee_id
            AND keep.support_oppose = mn_candidate_finance_outside_groups.support_oppose
        )
    `,
    [requireNonEmpty(input.linkId, "Minnesota finance link id"), normalizeElectionYear(input.electionYear), JSON.stringify(keys)]
  );
}

async function deleteStaleOutsideGroupBreakdowns(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  breakdowns: readonly MinnesotaFinanceOutsideGroupBreakdownInput[];
}): Promise<void> {
  const keys = input.breakdowns.map((breakdown) => ({
    committee_id: requireNonEmpty(breakdown.committeeId, "Minnesota outside breakdown committee id"),
    support_oppose: breakdown.supportOppose,
    category_type: breakdown.categoryType,
    category_name: requireNonEmpty(breakdown.categoryName, "Minnesota outside breakdown category"),
  }));

  await input.db.query(
    `
      DELETE FROM public.mn_candidate_finance_outside_group_breakdowns
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
          WHERE keep.committee_id = mn_candidate_finance_outside_group_breakdowns.committee_id
            AND keep.support_oppose = mn_candidate_finance_outside_group_breakdowns.support_oppose
            AND keep.category_type = mn_candidate_finance_outside_group_breakdowns.category_type
            AND keep.category_name = mn_candidate_finance_outside_group_breakdowns.category_name
        )
    `,
    [requireNonEmpty(input.linkId, "Minnesota finance link id"), normalizeElectionYear(input.electionYear), JSON.stringify(keys)]
  );
}

export async function replaceMinnesotaCandidateFinanceSnapshot(
  input: MinnesotaFinanceSnapshotInput
): Promise<MinnesotaFinanceSnapshotWriteResult> {
  const syncedAt = input.syncedAt ?? new Date();
  if (Number.isNaN(syncedAt.getTime())) {
    throw new Error("Invalid Minnesota finance sync timestamp");
  }
  validateMinnesotaFinanceSnapshotInput(input);
  const electionYear = normalizeElectionYear(input.link.electionYear);

  return await withMinnesotaFinanceTransaction(input.db, async (db) => {
    const { linkId } = await upsertMinnesotaFinanceLink({ db, link: input.link });
    if (input.summary) {
      await upsertSummary({ db, linkId, electionYear, summary: input.summary, syncedAt });
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

    if (input.reportedCommitteeCash !== undefined) {
      await writeMinnesotaCommitteeCash({ db, linkId, electionYear, snapshot: input.reportedCommitteeCash, syncedAt });
    }

    return {
      linkId,
      summaryWritten: Boolean(input.summary),
      directBreakdownsWritten: 0,
      outsideGroupsWritten: input.outsideGroups?.length ?? 0,
      outsideGroupBreakdownsWritten: input.outsideGroupBreakdowns?.length ?? 0,
    };
  });
}
