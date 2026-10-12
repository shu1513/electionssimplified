import type { Pool, PoolClient } from "pg";

import type { FinanceLabelClassification } from "../finance/financeLabelClassifier.js";
import { normalizeNewYorkFunderKey } from "./newYorkOutsideGroupContributionAggregator.js";
import { upsertFinanceLabelClassification } from "../finance/financeIndustryClassificationService.js";
import {
  MANUAL_PROTECTED_LINK_RETURNING,
  assertLinkWriteNotBlocked,
  manualProtectedLinkAssignments,
  manualProtectedRetireCondition,
  type ManualProtectedLinkRow,
} from "../finance/manualLinkProtection.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & {
  connect: () => Promise<PoolClient>;
};
type ClientLikeQueryable = Queryable & {
  release?: () => void;
};

export type NewYorkFinanceLinkStatus = "active" | "inactive";
export type NewYorkFinanceLinkSource = "manual" | "ny_soda_api";
// occupation is deliberately absent: NYSBOE never collects it.
export type NewYorkFinanceDirectCategoryType =
  "contribution_size" | "contributor_type" | "donor" | "industry";
export type NewYorkFinanceOutsideCategoryType = "donor" | "industry";
export type NewYorkFinanceSupportOppose = "support" | "oppose";

export type NewYorkFinanceLinkInput = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  candidateNameNormalized: string;
  officeName: string;
  district?: string | null;
  filerId: string;
  filerName: string;
  linkStatus?: NewYorkFinanceLinkStatus;
  linkSource?: NewYorkFinanceLinkSource;
  sourceUrl?: string | null;
  lastVerifiedAt?: Date | null;
};

export type NewYorkFinanceSummaryInput = {
  totalReceipts?: number | null;
  directContributionTotal?: number | null;
  totalDisbursements?: number | null;
  cashOnHand?: number | null;
  outsideSupportTotal?: number | null;
  outsideOpposeTotal?: number | null;
  sourceUrl?: string | null;
};

export type NewYorkFinanceDirectBreakdownInput = {
  categoryType: NewYorkFinanceDirectCategoryType;
  categoryName: string;
  amount: number;
  contributorCount?: number | null;
  sourceUrl?: string | null;
};

export type NewYorkFinanceOutsideGroupInput = {
  filerId: string;
  filerName: string;
  supportOppose: NewYorkFinanceSupportOppose;
  amount: number;
  sourceUrl?: string | null;
};

export type NewYorkFinanceOutsideGroupBreakdownInput = {
  filerId: string;
  supportOppose: NewYorkFinanceSupportOppose;
  categoryType: NewYorkFinanceOutsideCategoryType;
  categoryName: string;
  amount: number;
  contributorCount?: number | null;
  sourceUrl?: string | null;
};

/** Gross reported cash receipts, not legal PAC identity or net/refund authority. */
export type NewYorkFinancePacDonorInput = {
  committeeId: string;
  committeeName: string;
  sourceReportedClass: "Political Action Committee (PAC)";
  amount: number;
  contributionCount: number;
  sourceUrl?: string | null;
};

export type NewYorkFinanceSnapshotInput = {
  db: ConnectableQueryable;
  link: NewYorkFinanceLinkInput;
  syncedAt?: Date;
  summary?: NewYorkFinanceSummaryInput;
  directBreakdowns?: readonly NewYorkFinanceDirectBreakdownInput[];
  outsideGroups?: readonly NewYorkFinanceOutsideGroupInput[];
  outsideGroupBreakdowns?: readonly NewYorkFinanceOutsideGroupBreakdownInput[];
  /** upsert retains absent groups/breakdowns from earlier source observations. */
  outsideWriteMode?: "replace" | "upsert";
  classifications?: readonly FinanceLabelClassification[];
  /** undefined preserves; [] is an explicit caller-qualified complete component replacement. */
  pacDonors?: readonly NewYorkFinancePacDonorInput[];
};

export type NewYorkFinanceSnapshotWriteResult = {
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
    throw new Error(`Invalid New York finance election year: ${value}`);
  }
  return value;
}

function normalizeOptionalText(
  value: string | null | undefined,
): string | null {
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
    throw new Error("Invalid New York finance timestamp");
  }
  return value.toISOString();
}

function normalizeAmount(value: number, fieldName: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be a nonnegative number`);
  }
  return value;
}

function normalizeNullableAmount(
  value: number | null | undefined,
  fieldName: string,
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  return normalizeAmount(value, fieldName);
}

function normalizeNullableCount(
  value: number | null | undefined,
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      "New York finance contributor count must be a nonnegative integer",
    );
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

function validateNewYorkFinanceLinkInput(link: NewYorkFinanceLinkInput): void {
  requireNonEmpty(link.candidateId, "candidate id");
  requireNonEmpty(link.electionId, "election id");
  normalizeElectionYear(link.electionYear);
  requireNonEmpty(
    link.candidateNameNormalized,
    "New York finance candidate name",
  );
  requireNonEmpty(link.officeName, "New York finance office name");
  requireNonEmpty(link.filerId, "New York filer id");
  requireNonEmpty(link.filerName, "New York filer name");
  normalizeNullableDate(link.lastVerifiedAt);
}

function validateNewYorkFinanceSnapshotInput(
  input: NewYorkFinanceSnapshotInput,
): void {
  validateNewYorkFinanceLinkInput(input.link);
  if (
    input.outsideWriteMode !== undefined &&
    input.outsideWriteMode !== "replace" &&
    input.outsideWriteMode !== "upsert"
  )
    throw new Error("Invalid New York outside write mode");
  if (input.pacDonors !== undefined) {
    if (!Array.isArray(input.pacDonors))
      throw new Error("Invalid New York PAC donor snapshot");
    const ids = new Set<string>();
    for (const donor of input.pacDonors) {
      const name = requireNonEmpty(
        donor.committeeName,
        "New York PAC reported name",
      );
      if (
        donor.committeeId !== `reported:${normalizeNewYorkFunderKey(name)}` ||
        ids.has(donor.committeeId)
      )
        throw new Error(
          "New York PAC donor identity must be a unique exact reported-name key",
        );
      ids.add(donor.committeeId);
      if (donor.sourceReportedClass !== "Political Action Committee (PAC)")
        throw new Error(
          "New York PAC donor requires the literal reported PAC class",
        );
      const cents = Math.round(donor.amount * 100);
      if (
        !Number.isFinite(donor.amount) ||
        donor.amount < 0 ||
        !Number.isSafeInteger(cents) ||
        Math.abs(donor.amount * 100 - cents) > 0.000001
      )
        throw new Error(
          "New York PAC donor amount must be nonnegative safe exact cents",
        );
      if (
        !Number.isSafeInteger(donor.contributionCount) ||
        donor.contributionCount < 0
      )
        throw new Error(
          "New York PAC gift count must be a nonnegative safe integer",
        );
      normalizeOptionalText(donor.sourceUrl);
    }
  }
  if (input.outsideGroupBreakdowns && !input.outsideGroups) {
    throw new Error(
      "New York outside group breakdowns require outside groups in the same snapshot",
    );
  }
}

async function withNewYorkFinanceTransaction<T>(
  db: Queryable,
  work: (tx: Queryable) => Promise<T>,
): Promise<T> {
  if (!canOpenTransaction(db)) {
    if (isClientLikeQueryable(db)) {
      throw new Error(
        "New York finance snapshot writes must receive a Pool, not a PoolClient",
      );
    }
    throw new Error("New York finance snapshot writes must receive a Pool");
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

export async function upsertNewYorkFinanceLink(input: {
  db: Queryable;
  link: NewYorkFinanceLinkInput;
}): Promise<{ linkId: string }> {
  validateNewYorkFinanceLinkInput(input.link);

  // Retire, upsert, and the operator-disabled check are one unit: if the
  // proposed identity turns out to be a manual row an operator disabled, the
  // retirement of the candidate's other active link must roll back with the
  // rejection, or the candidate ends up with no active link. A Pool (the
  // auto-linker) opens its own transaction; a client is already inside one
  // (snapshot writes).
  if (canOpenTransaction(input.db)) {
    return withNewYorkFinanceTransaction(input.db, (tx) =>
      writeNewYorkFinanceLink({ db: tx, link: input.link }),
    );
  }
  return writeNewYorkFinanceLink(input);
}

async function writeNewYorkFinanceLink(input: {
  db: Queryable;
  link: NewYorkFinanceLinkInput;
}): Promise<{ linkId: string }> {
  // Only one active link may exist per candidate/election (partial unique
  // index). When a candidate switches authorized committees the new filer_id
  // upserts a fresh row, so any other active link must be retired first or
  // the write fails and leaves stale finance data behind.
  if ((input.link.linkStatus ?? "active") === "active") {
    await input.db.query(
      `
        UPDATE public.ny_candidate_finance_links
        SET link_status = 'inactive'
        WHERE candidate_id = $1::uuid
          AND election_id = $2::uuid
          AND filer_id <> $3
          AND link_status = 'active'
          AND ${manualProtectedRetireCondition("$4")}
      `,
      [
        requireNonEmpty(input.link.candidateId, "candidate id"),
        requireNonEmpty(input.link.electionId, "election id"),
        requireNonEmpty(input.link.filerId, "New York filer id"),
        input.link.linkSource ?? "manual",
      ],
    );
  }

  const result = await input.db.query<ManualProtectedLinkRow>(
    `
      INSERT INTO public.ny_candidate_finance_links (
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
        ${manualProtectedLinkAssignments("ny_candidate_finance_links")},
        source_url = EXCLUDED.source_url,
        last_verified_at = EXCLUDED.last_verified_at
      RETURNING ${MANUAL_PROTECTED_LINK_RETURNING}
    `,
    [
      requireNonEmpty(input.link.candidateId, "candidate id"),
      requireNonEmpty(input.link.electionId, "election id"),
      normalizeElectionYear(input.link.electionYear),
      requireNonEmpty(
        input.link.candidateNameNormalized,
        "New York finance candidate name",
      ),
      requireNonEmpty(input.link.officeName, "New York finance office name"),
      normalizeOptionalText(input.link.district),
      requireNonEmpty(input.link.filerId, "New York filer id"),
      requireNonEmpty(input.link.filerName, "New York filer name"),
      input.link.linkStatus ?? "active",
      input.link.linkSource ?? "manual",
      normalizeOptionalText(input.link.sourceUrl),
      normalizeNullableDate(input.link.lastVerifiedAt),
    ],
  );

  assertLinkWriteNotBlocked(
    "New York",
    result.rows[0],
    input.link.linkSource ?? "manual",
    input.link.electionYear,
  );
  const linkId = result.rows[0]?.id;
  if (!linkId) {
    throw new Error("New York finance link upsert did not return an id");
  }
  return { linkId };
}

async function upsertSummary(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  summary: NewYorkFinanceSummaryInput;
  syncedAt: Date;
}): Promise<void> {
  await input.db.query(
    `
      INSERT INTO public.ny_candidate_finance_summaries (
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
        total_receipts = COALESCE(EXCLUDED.total_receipts, ny_candidate_finance_summaries.total_receipts),
        direct_contribution_total = COALESCE(EXCLUDED.direct_contribution_total, ny_candidate_finance_summaries.direct_contribution_total),
        total_disbursements = COALESCE(EXCLUDED.total_disbursements, ny_candidate_finance_summaries.total_disbursements),
        cash_on_hand = COALESCE(EXCLUDED.cash_on_hand, ny_candidate_finance_summaries.cash_on_hand),
        outside_support_total = COALESCE(EXCLUDED.outside_support_total, ny_candidate_finance_summaries.outside_support_total),
        outside_oppose_total = COALESCE(EXCLUDED.outside_oppose_total, ny_candidate_finance_summaries.outside_oppose_total),
        source_url = COALESCE(EXCLUDED.source_url, ny_candidate_finance_summaries.source_url),
        last_synced_at = EXCLUDED.last_synced_at
    `,
    [
      requireNonEmpty(input.linkId, "New York finance link id"),
      normalizeElectionYear(input.electionYear),
      normalizeNullableAmount(input.summary.totalReceipts, "total receipts"),
      normalizeNullableAmount(
        input.summary.directContributionTotal,
        "direct contribution total",
      ),
      normalizeNullableAmount(
        input.summary.totalDisbursements,
        "total disbursements",
      ),
      normalizeNullableAmount(input.summary.cashOnHand, "cash on hand"),
      normalizeNullableAmount(
        input.summary.outsideSupportTotal,
        "outside support total",
      ),
      normalizeNullableAmount(
        input.summary.outsideOpposeTotal,
        "outside oppose total",
      ),
      normalizeOptionalText(input.summary.sourceUrl),
      input.syncedAt.toISOString(),
    ],
  );
}

async function upsertDirectBreakdown(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  breakdown: NewYorkFinanceDirectBreakdownInput;
  syncedAt: Date;
}): Promise<void> {
  await input.db.query(
    `
      INSERT INTO public.ny_candidate_finance_direct_breakdowns (
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
      requireNonEmpty(input.linkId, "New York finance link id"),
      normalizeElectionYear(input.electionYear),
      input.breakdown.categoryType,
      requireNonEmpty(
        input.breakdown.categoryName,
        "New York finance direct breakdown category",
      ),
      normalizeAmount(input.breakdown.amount, "direct breakdown amount"),
      normalizeNullableCount(input.breakdown.contributorCount),
      normalizeOptionalText(input.breakdown.sourceUrl),
      input.syncedAt.toISOString(),
    ],
  );
}

async function upsertOutsideGroup(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  group: NewYorkFinanceOutsideGroupInput;
  syncedAt: Date;
}): Promise<void> {
  await input.db.query(
    `
      INSERT INTO public.ny_candidate_finance_outside_groups (
        link_id,
        election_year,
        filer_id,
        filer_name,
        support_oppose,
        amount,
        source_url,
        last_synced_at
      )
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::timestamptz)
      ON CONFLICT (link_id, election_year, filer_id, support_oppose)
      DO UPDATE SET
        filer_name = EXCLUDED.filer_name,
        amount = EXCLUDED.amount,
        source_url = EXCLUDED.source_url,
        last_synced_at = EXCLUDED.last_synced_at
    `,
    [
      requireNonEmpty(input.linkId, "New York finance link id"),
      normalizeElectionYear(input.electionYear),
      requireNonEmpty(input.group.filerId, "New York outside group filer id"),
      requireNonEmpty(
        input.group.filerName,
        "New York outside group filer name",
      ),
      input.group.supportOppose,
      normalizeAmount(input.group.amount, "outside group amount"),
      normalizeOptionalText(input.group.sourceUrl),
      input.syncedAt.toISOString(),
    ],
  );
}

async function upsertOutsideGroupBreakdown(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  breakdown: NewYorkFinanceOutsideGroupBreakdownInput;
  syncedAt: Date;
}): Promise<void> {
  await input.db.query(
    `
      INSERT INTO public.ny_candidate_finance_outside_group_breakdowns (
        link_id,
        election_year,
        filer_id,
        support_oppose,
        category_type,
        category_name,
        amount,
        contributor_count,
        source_url,
        last_synced_at
      )
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)
      ON CONFLICT (link_id, election_year, filer_id, support_oppose, category_type, category_name)
      DO UPDATE SET
        amount = EXCLUDED.amount,
        contributor_count = EXCLUDED.contributor_count,
        source_url = EXCLUDED.source_url,
        last_synced_at = EXCLUDED.last_synced_at
    `,
    [
      requireNonEmpty(input.linkId, "New York finance link id"),
      normalizeElectionYear(input.electionYear),
      requireNonEmpty(
        input.breakdown.filerId,
        "New York outside breakdown filer id",
      ),
      input.breakdown.supportOppose,
      input.breakdown.categoryType,
      requireNonEmpty(
        input.breakdown.categoryName,
        "New York outside breakdown category",
      ),
      normalizeAmount(input.breakdown.amount, "outside group breakdown amount"),
      normalizeNullableCount(input.breakdown.contributorCount),
      normalizeOptionalText(input.breakdown.sourceUrl),
      input.syncedAt.toISOString(),
    ],
  );
}

async function deleteStaleDirectBreakdowns(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  breakdowns: readonly NewYorkFinanceDirectBreakdownInput[];
}): Promise<void> {
  const keys = input.breakdowns.map((breakdown) => ({
    category_type: breakdown.categoryType,
    category_name: requireNonEmpty(
      breakdown.categoryName,
      "New York finance direct breakdown category",
    ),
  }));

  await input.db.query(
    `
      DELETE FROM public.ny_candidate_finance_direct_breakdowns
      WHERE link_id = $1::uuid
        AND election_year = $2
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset($3::jsonb) AS keep(
            category_type text,
            category_name text
          )
          WHERE keep.category_type = ny_candidate_finance_direct_breakdowns.category_type
            AND keep.category_name = ny_candidate_finance_direct_breakdowns.category_name
        )
    `,
    [
      requireNonEmpty(input.linkId, "New York finance link id"),
      normalizeElectionYear(input.electionYear),
      JSON.stringify(keys),
    ],
  );
}

async function deleteStaleOutsideGroupBreakdowns(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  breakdowns: readonly NewYorkFinanceOutsideGroupBreakdownInput[];
}): Promise<void> {
  const keys = input.breakdowns.map((breakdown) => ({
    filer_id: requireNonEmpty(
      breakdown.filerId,
      "New York outside breakdown filer id",
    ),
    support_oppose: breakdown.supportOppose,
    category_type: breakdown.categoryType,
    category_name: requireNonEmpty(
      breakdown.categoryName,
      "New York outside breakdown category",
    ),
  }));

  await input.db.query(
    `
      DELETE FROM public.ny_candidate_finance_outside_group_breakdowns
      WHERE link_id = $1::uuid
        AND election_year = $2
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset($3::jsonb) AS keep(
            filer_id text,
            support_oppose text,
            category_type text,
            category_name text
          )
          WHERE keep.filer_id = ny_candidate_finance_outside_group_breakdowns.filer_id
            AND keep.support_oppose = ny_candidate_finance_outside_group_breakdowns.support_oppose
            AND keep.category_type = ny_candidate_finance_outside_group_breakdowns.category_type
            AND keep.category_name = ny_candidate_finance_outside_group_breakdowns.category_name
        )
    `,
    [
      requireNonEmpty(input.linkId, "New York finance link id"),
      normalizeElectionYear(input.electionYear),
      JSON.stringify(keys),
    ],
  );
}

async function deleteStaleOutsideGroups(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  groups: readonly NewYorkFinanceOutsideGroupInput[];
}): Promise<void> {
  const keys = input.groups.map((group) => ({
    filer_id: requireNonEmpty(group.filerId, "New York outside group filer id"),
    support_oppose: group.supportOppose,
  }));

  await input.db.query(
    `
      DELETE FROM public.ny_candidate_finance_outside_groups
      WHERE link_id = $1::uuid
        AND election_year = $2
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset($3::jsonb) AS keep(
            filer_id text,
            support_oppose text
          )
          WHERE keep.filer_id = ny_candidate_finance_outside_groups.filer_id
            AND keep.support_oppose = ny_candidate_finance_outside_groups.support_oppose
        )
    `,
    [
      requireNonEmpty(input.linkId, "New York finance link id"),
      normalizeElectionYear(input.electionYear),
      JSON.stringify(keys),
    ],
  );
}

async function replacePacDonors(input: {
  db: Queryable;
  linkId: string;
  electionYear: number;
  donors: readonly NewYorkFinancePacDonorInput[];
  syncedAt: Date;
}): Promise<void> {
  for (const donor of input.donors) {
    await input.db.query(
      `
      INSERT INTO public.ny_candidate_finance_pac_donors
        (link_id, election_year, committee_id, committee_name, source_reported_class,
         amount, contribution_count, source_url, last_synced_at)
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)
      ON CONFLICT (link_id, election_year, committee_id) DO UPDATE SET
        committee_name=EXCLUDED.committee_name,
        source_reported_class=EXCLUDED.source_reported_class,
        amount=EXCLUDED.amount, contribution_count=EXCLUDED.contribution_count,
        source_url=EXCLUDED.source_url, last_synced_at=EXCLUDED.last_synced_at`,
      [
        input.linkId,
        input.electionYear,
        donor.committeeId,
        donor.committeeName.trim(),
        donor.sourceReportedClass,
        donor.amount,
        donor.contributionCount,
        normalizeOptionalText(donor.sourceUrl),
        input.syncedAt.toISOString(),
      ],
    );
  }
  await input.db.query(
    `
    DELETE FROM public.ny_candidate_finance_pac_donors
    WHERE link_id=$1::uuid AND election_year=$2
      AND NOT (committee_id = ANY($3::text[]))`,
    [input.linkId, input.electionYear, input.donors.map((d) => d.committeeId)],
  );
}

export async function replaceNewYorkCandidateFinanceSnapshot(
  input: NewYorkFinanceSnapshotInput,
): Promise<NewYorkFinanceSnapshotWriteResult> {
  // Retain one caller generation before connect/transaction awaits. Pool methods are not cloned.
  const { db: database, ...data } = input;
  input = { db: database, ...structuredClone(data) };
  const syncedAt = input.syncedAt ?? new Date();
  if (Number.isNaN(syncedAt.getTime())) {
    throw new Error("Invalid New York finance sync timestamp");
  }
  validateNewYorkFinanceSnapshotInput(input);
  const electionYear = normalizeElectionYear(input.link.electionYear);

  return await withNewYorkFinanceTransaction(input.db, async (db) => {
    const { linkId } = await upsertNewYorkFinanceLink({ db, link: input.link });
    if (input.summary) {
      await upsertSummary({
        db,
        linkId,
        electionYear,
        summary: input.summary,
        syncedAt,
      });
    }

    for (const breakdown of input.directBreakdowns ?? []) {
      await upsertDirectBreakdown({
        db,
        linkId,
        electionYear,
        breakdown,
        syncedAt,
      });
    }
    if (input.directBreakdowns) {
      await deleteStaleDirectBreakdowns({
        db,
        linkId,
        electionYear,
        breakdowns: input.directBreakdowns,
      });
    }

    for (const group of input.outsideGroups ?? []) {
      await upsertOutsideGroup({ db, linkId, electionYear, group, syncedAt });
    }
    for (const breakdown of input.outsideGroupBreakdowns ?? []) {
      await upsertOutsideGroupBreakdown({
        db,
        linkId,
        electionYear,
        breakdown,
        syncedAt,
      });
    }
    if (input.outsideGroupBreakdowns && input.outsideWriteMode !== "upsert") {
      await deleteStaleOutsideGroupBreakdowns({
        db,
        linkId,
        electionYear,
        breakdowns: input.outsideGroupBreakdowns,
      });
    }
    if (input.outsideGroups && input.outsideWriteMode !== "upsert") {
      await deleteStaleOutsideGroups({
        db,
        linkId,
        electionYear,
        groups: input.outsideGroups,
      });
    }

    if (input.pacDonors !== undefined) {
      await replacePacDonors({
        db,
        linkId,
        electionYear,
        donors: input.pacDonors,
        syncedAt,
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
      ...(input.pacDonors !== undefined
        ? { pacDonorsWritten: input.pacDonors.length }
        : {}),
    };
  });
}
