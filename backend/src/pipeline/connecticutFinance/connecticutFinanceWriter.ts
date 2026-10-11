import type { Pool, PoolClient } from "pg";
import type { ConnecticutFinancePacDonor } from "./connecticutDirectContributionAggregator.js";
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

export type ConnecticutFinanceLinkStatus = "active" | "needs_review" | "inactive";
export type ConnecticutFinanceLinkSource = "manual" | "ecris_bulk" | "ecris_search";
export type ConnecticutFinanceDirectCategoryType = "occupation" | "contribution_size";

export type ConnecticutFinanceLinkInput = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  candidateNameNormalized: string;
  officeName: string;
  district?: string | null;
  committeeId: string;
  committeeName: string;
  linkStatus?: ConnecticutFinanceLinkStatus;
  linkSource?: ConnecticutFinanceLinkSource;
  sourceUrl?: string | null;
  lastVerifiedAt?: Date | null;
};

export type ConnecticutFinanceSummaryInput = {
  totalReceipts?: number | null;
  totalDisbursements?: number | null;
  outsideSupportTotal?: number | null;
  outsideOpposeTotal?: number | null;
  sourceUrl?: string | null;
};

export type ConnecticutFinanceDirectBreakdownInput = {
  categoryType: ConnecticutFinanceDirectCategoryType;
  categoryName: string;
  amount: number;
  contributorCount?: number | null;
  sourceUrl?: string | null;
};

export type ConnecticutFinanceSupportOppose = "support" | "oppose";

export type ConnecticutFinanceOutsideGroupInput = {
  committeeId: string;
  committeeName: string;
  supportOppose: ConnecticutFinanceSupportOppose;
  amount: number;
  sourceUrl?: string | null;
};

export type ConnecticutFinanceSnapshotInput = {
  db: Queryable;
  link: ConnecticutFinanceLinkInput;
  syncedAt?: Date;
  summary?: ConnecticutFinanceSummaryInput;
  /** Omit when unavailable; pass [] after a successful aggregation with no breakdowns. */
  directBreakdowns?: readonly ConnecticutFinanceDirectBreakdownInput[];
  /** Omit to preserve; a successful empty aggregation clears stale committee donors. */
  pacDonors?: readonly ConnecticutFinancePacDonor[];
  /** Omit when unavailable; pass [] after a successful aggregation with no outside groups. */
  outsideGroups?: readonly ConnecticutFinanceOutsideGroupInput[];
};

export type ConnecticutFinanceSnapshotWriteResult = {
  linkId: string;
  summaryWritten: boolean;
  directBreakdownsWritten: number;
  outsideGroupsWritten: number;
  pacDonorsWritten: number;
};

function requireNonEmpty(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmed;
}

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2008 || value > 2100) {
    throw new Error(`Invalid Connecticut finance election year: ${value}`);
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
    throw new Error("Invalid Connecticut finance timestamp");
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
    throw new Error("Connecticut finance contributor count must be a nonnegative integer");
  }
  return value;
}

function canOpenTransaction(db: Queryable): db is ConnectableQueryable & { connect: () => Promise<PoolClient> } {
  return typeof (db as ConnectableQueryable).connect === "function";
}

function validateConnecticutFinanceLinkInput(link: ConnecticutFinanceLinkInput): void {
  requireNonEmpty(link.candidateId, "candidate id");
  requireNonEmpty(link.electionId, "election id");
  normalizeElectionYear(link.electionYear);
  requireNonEmpty(link.candidateNameNormalized, "Connecticut finance candidate name");
  requireNonEmpty(link.officeName, "Connecticut finance office name");
  requireNonEmpty(link.committeeId, "Connecticut committee id");
  requireNonEmpty(link.committeeName, "Connecticut committee name");
  normalizeNullableDate(link.lastVerifiedAt);
}

async function withConnecticutFinanceTransaction<T>(db: Queryable, work: (tx: Queryable) => Promise<T>): Promise<T> {
  assertSnapshotDbIsNotPoolClient("Connecticut", db);
  if (!canOpenTransaction(db)) {
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

export async function upsertConnecticutFinanceLink(input: {
  db: Queryable;
  link: ConnecticutFinanceLinkInput;
}): Promise<{ linkId: string }> {
  const result = await input.db.query<ManualProtectedLinkRow>(
    `
      INSERT INTO public.ct_candidate_finance_links (
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
        ${manualProtectedLinkAssignments("ct_candidate_finance_links")},
        source_url = EXCLUDED.source_url,
        last_verified_at = EXCLUDED.last_verified_at
      RETURNING ${MANUAL_PROTECTED_LINK_RETURNING}
    `,
    [
      requireNonEmpty(input.link.candidateId, "candidate id"),
      requireNonEmpty(input.link.electionId, "election id"),
      normalizeElectionYear(input.link.electionYear),
      requireNonEmpty(input.link.candidateNameNormalized, "Connecticut finance candidate name"),
      requireNonEmpty(input.link.officeName, "Connecticut finance office name"),
      normalizeOptionalText(input.link.district),
      requireNonEmpty(input.link.committeeId, "Connecticut committee id"),
      requireNonEmpty(input.link.committeeName, "Connecticut committee name"),
      input.link.linkStatus ?? "active",
      input.link.linkSource ?? "manual",
      normalizeOptionalText(input.link.sourceUrl),
      normalizeNullableDate(input.link.lastVerifiedAt),
    ]
  );

  assertLinkWriteNotBlocked("Connecticut", result.rows[0], input.link.linkSource ?? "manual", input.link.electionYear);
  const linkId = result.rows[0]?.id;
  if (!linkId) {
    throw new Error("Connecticut finance link upsert did not return an id");
  }
  return { linkId };
}

async function upsertSummary(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  summary: ConnecticutFinanceSummaryInput;
  syncedAt: Date;
}): Promise<void> {
  await input.db.query(
    `
      INSERT INTO public.ct_candidate_finance_summaries (
        link_id,
        election_year,
        total_receipts,
        total_disbursements,
        outside_support_total,
        outside_oppose_total,
        source_url,
        last_synced_at
      )
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::timestamptz)
      ON CONFLICT (link_id, election_year)
      DO UPDATE SET
        total_receipts = COALESCE(EXCLUDED.total_receipts, ct_candidate_finance_summaries.total_receipts),
        total_disbursements = COALESCE(EXCLUDED.total_disbursements, ct_candidate_finance_summaries.total_disbursements),
        outside_support_total = COALESCE(EXCLUDED.outside_support_total, ct_candidate_finance_summaries.outside_support_total),
        outside_oppose_total = COALESCE(EXCLUDED.outside_oppose_total, ct_candidate_finance_summaries.outside_oppose_total),
        source_url = COALESCE(EXCLUDED.source_url, ct_candidate_finance_summaries.source_url),
        last_synced_at = EXCLUDED.last_synced_at
    `,
    [
      requireNonEmpty(input.linkId, "Connecticut finance link id"),
      normalizeElectionYear(input.electionYear),
      normalizeNullableAmount(input.summary.totalReceipts, "total receipts"),
      normalizeNullableAmount(input.summary.totalDisbursements, "total disbursements"),
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
  breakdown: ConnecticutFinanceDirectBreakdownInput;
  syncedAt: Date;
}): Promise<void> {
  await input.db.query(
    `
      INSERT INTO public.ct_candidate_finance_direct_breakdowns (
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
      requireNonEmpty(input.linkId, "Connecticut finance link id"),
      normalizeElectionYear(input.electionYear),
      input.breakdown.categoryType,
      requireNonEmpty(input.breakdown.categoryName, "Connecticut finance direct breakdown category"),
      normalizeAmount(input.breakdown.amount, "direct breakdown amount"),
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
  breakdowns: readonly ConnecticutFinanceDirectBreakdownInput[];
}): Promise<void> {
  const keys = input.breakdowns.map((breakdown) => ({
    category_type: breakdown.categoryType,
    category_name: requireNonEmpty(breakdown.categoryName, "Connecticut finance direct breakdown category"),
  }));
  await input.db.query(
    `
      DELETE FROM public.ct_candidate_finance_direct_breakdowns
      WHERE link_id = $1::uuid
        AND election_year = $2
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset($3::jsonb) AS keep(
            category_type text,
            category_name text
          )
          WHERE keep.category_type = ct_candidate_finance_direct_breakdowns.category_type
            AND keep.category_name = ct_candidate_finance_direct_breakdowns.category_name
        )
    `,
    [requireNonEmpty(input.linkId, "Connecticut finance link id"), normalizeElectionYear(input.electionYear), JSON.stringify(keys)]
  );
}

function normalizeOutsideGroupKey(group: ConnecticutFinanceOutsideGroupInput): {
  committee_id: string;
  support_oppose: ConnecticutFinanceSupportOppose;
} {
  if (group.supportOppose !== "support" && group.supportOppose !== "oppose") {
    throw new Error(`Invalid Connecticut finance outside group stance: ${String(group.supportOppose)}`);
  }
  return {
    committee_id: requireNonEmpty(group.committeeId, "Connecticut outside group committee id"),
    support_oppose: group.supportOppose,
  };
}

async function upsertOutsideGroup(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  group: ConnecticutFinanceOutsideGroupInput;
  syncedAt: Date;
}): Promise<void> {
  const key = normalizeOutsideGroupKey(input.group);
  await input.db.query(
    `
      INSERT INTO public.ct_candidate_finance_outside_groups (
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
      requireNonEmpty(input.linkId, "Connecticut finance link id"),
      normalizeElectionYear(input.electionYear),
      key.committee_id,
      requireNonEmpty(input.group.committeeName, "Connecticut outside group committee name"),
      key.support_oppose,
      normalizeAmount(input.group.amount, "outside group amount"),
      normalizeOptionalText(input.group.sourceUrl),
      input.syncedAt.toISOString(),
    ]
  );
}

async function deleteStaleOutsideGroups(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  groups: readonly ConnecticutFinanceOutsideGroupInput[];
}): Promise<void> {
  const keys = input.groups.map(normalizeOutsideGroupKey);
  await input.db.query(
    `
      DELETE FROM public.ct_candidate_finance_outside_groups
      WHERE link_id = $1::uuid
        AND election_year = $2
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset($3::jsonb) AS keep(
            committee_id text,
            support_oppose text
          )
          WHERE keep.committee_id = ct_candidate_finance_outside_groups.committee_id
            AND keep.support_oppose = ct_candidate_finance_outside_groups.support_oppose
        )
    `,
    [requireNonEmpty(input.linkId, "Connecticut finance link id"), normalizeElectionYear(input.electionYear), JSON.stringify(keys)]
  );
}

async function replacePacDonors(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  donors: readonly ConnecticutFinancePacDonor[];
  syncedAt: Date;
}): Promise<void> {
  for (const donor of input.donors) {
    if (!Number.isFinite(donor.amount) || donor.amount <= 0) {
      throw new Error("Connecticut committee donor amount must be positive");
    }
    const count = normalizeNullableCount(donor.contributionCount);
    await input.db.query(
      `
        INSERT INTO public.ct_candidate_finance_pac_donors (
          link_id, election_year, committee_id, committee_name, committee_type,
          amount, contribution_count, source_url, last_synced_at
        ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)
        ON CONFLICT (link_id, election_year, committee_id) DO UPDATE SET
          committee_name = EXCLUDED.committee_name,
          committee_type = EXCLUDED.committee_type,
          amount = EXCLUDED.amount,
          contribution_count = EXCLUDED.contribution_count,
          source_url = EXCLUDED.source_url,
          last_synced_at = EXCLUDED.last_synced_at
      `,
      [
        input.linkId, input.electionYear,
        requireNonEmpty(donor.committeeId, "Connecticut committee donor id"),
        requireNonEmpty(donor.committeeName, "Connecticut committee donor name"),
        normalizeOptionalText(donor.committeeType), donor.amount, count,
        normalizeOptionalText(donor.sourceUrl), input.syncedAt.toISOString(),
      ]
    );
  }
  await input.db.query(
    `DELETE FROM public.ct_candidate_finance_pac_donors
     WHERE link_id = $1::uuid AND election_year = $2
       AND NOT (committee_id = ANY($3::text[]))`,
    [input.linkId, input.electionYear, input.donors.map((donor) => donor.committeeId.trim())]
  );
}

export async function replaceConnecticutCandidateFinanceSnapshot(
  input: ConnecticutFinanceSnapshotInput
): Promise<ConnecticutFinanceSnapshotWriteResult> {
  const syncedAt = input.syncedAt ?? new Date();
  if (Number.isNaN(syncedAt.getTime())) {
    throw new Error("Invalid Connecticut finance sync timestamp");
  }
  validateConnecticutFinanceLinkInput(input.link);
  const electionYear = normalizeElectionYear(input.link.electionYear);

  return await withConnecticutFinanceTransaction(input.db, async (db) => {
    const { linkId } = await upsertConnecticutFinanceLink({ db, link: input.link });
    if (input.summary) {
      await upsertSummary({ db, linkId, electionYear, summary: input.summary, syncedAt });
    }

    for (const breakdown of input.directBreakdowns ?? []) {
      await upsertDirectBreakdown({ db, linkId, electionYear, breakdown, syncedAt });
    }
    if (input.directBreakdowns) {
      await deleteStaleDirectBreakdowns({ db, linkId, electionYear, breakdowns: input.directBreakdowns });
    }

    if (input.pacDonors) {
      await replacePacDonors({ db, linkId, electionYear, donors: input.pacDonors, syncedAt });
    }

    for (const group of input.outsideGroups ?? []) {
      await upsertOutsideGroup({ db, linkId, electionYear, group, syncedAt });
    }
    if (input.outsideGroups) {
      await deleteStaleOutsideGroups({ db, linkId, electionYear, groups: input.outsideGroups });
    }

    return {
      linkId,
      summaryWritten: Boolean(input.summary),
      directBreakdownsWritten: input.directBreakdowns?.length ?? 0,
      outsideGroupsWritten: input.outsideGroups?.length ?? 0,
      pacDonorsWritten: input.pacDonors?.length ?? 0,
    };
  });
}
