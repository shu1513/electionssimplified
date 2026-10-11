import type { Pool, PoolClient } from "pg";

import type { FinanceLabelClassification } from "./financeLabelClassifier.js";
import { upsertFinanceLabelClassification } from "./financeIndustryClassificationService.js";
import type { StandardStateFinanceTables } from "./standardStateFinanceBallotLookupLoader.js";
import {
  MANUAL_PROTECTED_LINK_RETURNING,
  assertLinkWriteNotBlocked,
  manualProtectedLinkAssignments,
  type ManualProtectedLinkRow,
} from "./manualLinkProtection.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type PoolLikeQueryable = Queryable & {
  connect?: () => Promise<PoolClient>;
};
type ClientLikeQueryable = Queryable & {
  release?: () => void;
};

export type StandardStateFinanceLinkStatus = "active" | "inactive";
export type StandardStateFinanceDirectCategoryType = "occupation" | "contribution_size";
export type StandardStateFinanceOutsideCategoryType = "donor" | "industry";
export type StandardStateFinanceSupportOppose = "support" | "oppose";

export type StandardStateFinanceLinkInput = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  candidateNameNormalized: string;
  officeName: string;
  district?: string | null;
  committeeId: string;
  committeeName: string;
  linkStatus?: StandardStateFinanceLinkStatus;
  linkSource?: string;
  sourceUrl?: string | null;
  lastVerifiedAt?: Date | null;
};

export type StandardStateFinanceSummaryInput = {
  totalReceipts?: number | null;
  directContributionTotal?: number | null;
  totalDisbursements?: number | null;
  cashOnHand?: number | null;
  outsideSupportTotal?: number | null;
  outsideOpposeTotal?: number | null;
  sourceUrl?: string | null;
};

export type StandardStateFinanceDirectBreakdownInput<
  TCategoryType extends string = StandardStateFinanceDirectCategoryType,
> = {
  categoryType: TCategoryType;
  categoryName: string;
  amount: number;
  contributorCount?: number | null;
  sourceUrl?: string | null;
};

export type StandardStateFinanceOutsideGroupInput = {
  committeeId: string;
  committeeName: string;
  supportOppose: StandardStateFinanceSupportOppose;
  amount: number;
  sourceUrl?: string | null;
};

export type StandardStateFinanceOutsideGroupBreakdownInput = {
  committeeId: string;
  supportOppose: StandardStateFinanceSupportOppose;
  categoryType: StandardStateFinanceOutsideCategoryType;
  categoryName: string;
  amount: number;
  contributorCount?: number | null;
  sourceUrl?: string | null;
};

export type StandardStateFinanceSnapshotInput<
  TDirectCategoryType extends string = StandardStateFinanceDirectCategoryType,
> = {
  db: Queryable;
  link: StandardStateFinanceLinkInput;
  syncedAt?: Date;
  summary?: StandardStateFinanceSummaryInput;
  directBreakdowns?: readonly StandardStateFinanceDirectBreakdownInput<TDirectCategoryType>[];
  outsideGroups?: readonly StandardStateFinanceOutsideGroupInput[];
  outsideGroupBreakdowns?: readonly StandardStateFinanceOutsideGroupBreakdownInput[];
  classifications?: readonly FinanceLabelClassification[];
  // Writes a state-only summary column inside the same transaction, right
  // after the shared summary upsert (D.C. public_funds_received).
  afterSummaryWrite?: (input: { db: Queryable; linkId: string; electionYear: number }) => Promise<void>;
};

export type StandardStateFinanceSnapshotWriteResult = {
  linkId: string;
  summaryWritten: boolean;
  directBreakdownsWritten: number;
  outsideGroupsWritten: number;
  outsideGroupBreakdownsWritten: number;
};

export type StandardStateFinanceSnapshotWriter<
  TDirectCategoryType extends string = StandardStateFinanceDirectCategoryType,
> = {
  upsertLink(input: { db: Queryable; link: StandardStateFinanceLinkInput }): Promise<{ linkId: string }>;
  replaceSnapshot(
    input: StandardStateFinanceSnapshotInput<TDirectCategoryType>
  ): Promise<StandardStateFinanceSnapshotWriteResult>;
};

export type StandardStateFinanceSummaryColumn =
  | "total_receipts"
  | "direct_contribution_total"
  | "total_disbursements"
  | "cash_on_hand"
  | "outside_support_total"
  | "outside_oppose_total"
  | "source_url";

export type StandardStateFinanceSummaryUpdateMode = "replace" | "preserveWhenNull";

export type StandardStateFinanceOutsideGroupValidation = "none" | "presence" | "pairing";

/** Custom direct-category types require a matching runtime allowlist. */
type StandardStateFinanceDirectCategoryConfig<TCategoryType extends string> =
  [TCategoryType] extends [StandardStateFinanceDirectCategoryType]
    ? [StandardStateFinanceDirectCategoryType] extends [TCategoryType]
      ? { directCategoryTypes?: readonly TCategoryType[] }
      : { directCategoryTypes: readonly TCategoryType[] }
    : { directCategoryTypes: readonly TCategoryType[] };

const SUMMARY_COLUMNS: readonly StandardStateFinanceSummaryColumn[] = [
  "total_receipts",
  "direct_contribution_total",
  "total_disbursements",
  "cash_on_hand",
  "outside_support_total",
  "outside_oppose_total",
  "source_url",
];

function assertIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error(`Invalid standard finance table identifier: ${value}`);
  return value;
}

function assertIdentityColumn(label: string, kind: "link" | "outside-group", value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid ${label} ${kind} identity column: ${value}`);
  }
  return value;
}

function requireNonEmpty(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmed;
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

// Cash on hand is a signed BALANCE, not a flow: an indebted campaign
// legitimately reports negative cash (live-hit on Georgia 2026 candidates).
// Signed acceptance is OPT-IN per state because each state's summaries table
// carries its own amounts CHECK — a state whose schema still pins
// cash_on_hand >= 0 must keep failing in the writer with a clear message
// instead of surfacing a constraint rollback (Georgia enables this together
// with migration 231).
function normalizeNullableSignedAmount(value: number | null | undefined, fieldName: string): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number`);
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

export function createStandardStateFinanceSnapshotWriter<
  TDirectCategoryType extends string = StandardStateFinanceDirectCategoryType,
>(config: {
  /** Human-readable name used in error messages, e.g. "Texas" or "Houston". */
  label: string;
  tables: StandardStateFinanceTables;
  /**
   * Reject election years below this floor. Every wrapper declares its state's
   * floor explicitly — the floors range from 1980 to 2021 across states, so
   * there is deliberately no default.
   */
  minElectionYear: number;
  /**
   * Per-column summary upsert behavior. "preserveWhenNull" (the default for
   * every column) keeps the stored value when the incoming value is NULL;
   * "replace" always overwrites, including with NULL.
   */
  summaryUpdatePolicy?: Partial<Record<StandardStateFinanceSummaryColumn, StandardStateFinanceSummaryUpdateMode>>;
  /**
   * Accept negative cashOnHand (a signed balance — campaign debt). Enable
   * only for states whose summaries-table amounts CHECK allows it; the
   * default keeps the writer's clear validation error for everyone else.
   */
  allowNegativeCashOnHand?: boolean;
  /**
   * How outside-group breakdowns must relate to outside groups in the same
   * snapshot. "presence" requires at least one group when breakdowns are
   * supplied; "pairing" additionally requires each breakdown's
   * (committeeId, supportOppose) to match a supplied group. Default "none".
   */
  outsideGroupValidation?: StandardStateFinanceOutsideGroupValidation;
  /**
   * Optional committee-id normalization (e.g. whitespace collapse, upper-
   * casing) applied everywhere a committee id is written or compared: the
   * link upsert, outside-group and outside-breakdown upserts, stale-delete
   * keep lists, and pairing validation keys. Runs on the trimmed value after
   * the non-empty check. Default: identity.
   */
  normalizeCommitteeId?: (value: string) => string;
  /**
   * Protect operator-curated links across a candidate + election, not only
   * on the incoming link's conflict row. For automatic writes, an exact
   * active manual identity is reused, an exact disabled manual identity
   * fails closed, and a different active manual identity blocks the write.
   * Default false so existing state wrappers keep their current behavior.
   */
  manualLinkProtection?: boolean;
  /**
   * When set, an incoming active link with this linkSource deactivates every
   * other active link with the same source for the same candidate +
   * election, inside the snapshot transaction (bulk-import supersession, as
   * in Maine/Maryland). Applies to replaceSnapshot only, not upsertLink.
   */
  supersededLinkSource?: string;
  /**
   * Column names for the outside-group identity in the outside-groups and
   * outside-group-breakdowns tables. Defaults match the canonical schema:
   * id "committee_id", name "committee_name". Sponsor-identity states
   * (e.g. Oregon's sponsor_id/sponsor_name) override both. Input fields stay
   * committeeId/committeeName — wrappers map state-specific field names onto
   * them. Interpolated into SQL, so validated as identifiers at construction.
   */
  outsideGroupIdentityColumns?: {
    id?: string;
    name?: string;
  };
  /**
   * Column names for the committee identity in the links table. Defaults
   * match the canonical schema: id "committee_id", name "committee_name".
   * Renamed-link states override the id (DC's committee_key) or both (Alaska's
   * candidate_filer_id/candidate_filer_name). The id column is part of the
   * link upsert's conflict target. Input fields stay committeeId /
   * committeeName — wrappers map state-specific field names onto them.
   * Interpolated into SQL, so validated as identifiers at construction.
   */
  linkIdentityColumns?: {
    id?: string;
    name?: string;
  };
} & StandardStateFinanceDirectCategoryConfig<TDirectCategoryType>): StandardStateFinanceSnapshotWriter<
  TDirectCategoryType
> {
  const label = config.label;
  const tables = Object.fromEntries(
    Object.entries(config.tables).map(([name, value]) => [name, assertIdentifier(value)])
  ) as StandardStateFinanceTables;
  if (!Number.isInteger(config.minElectionYear) || config.minElectionYear < 1900 || config.minElectionYear > 2100) {
    throw new Error(`Invalid ${label} finance minimum election year: ${config.minElectionYear}`);
  }
  const minElectionYear = config.minElectionYear;
  const directCategoryTypes = new Set<string>(
    config.directCategoryTypes ?? ["occupation", "contribution_size"]
  );
  if (directCategoryTypes.size === 0 || [...directCategoryTypes].some((value) => value.trim().length === 0)) {
    throw new Error(`Invalid ${label} finance direct category types`);
  }
  const outsideGroupValidation = config.outsideGroupValidation ?? "none";
  const normalizeCommitteeId = config.normalizeCommitteeId ?? ((value: string) => value);
  const manualLinkProtection = config.manualLinkProtection ?? false;
  // The superseded-source literal is interpolated into SQL (states pin the
  // three-parameter deactivation statement), so restrict it to identifier-safe
  // characters at construction time.
  if (config.supersededLinkSource !== undefined && !/^[a-z][a-z0-9_]*$/.test(config.supersededLinkSource)) {
    throw new Error(`Invalid ${label} superseded link source: ${config.supersededLinkSource}`);
  }
  const supersededLinkSource = config.supersededLinkSource;
  // Interpolated into SQL like the table names, so identifier-validate both.
  const outsideIdColumn = assertIdentityColumn(label, "outside-group", config.outsideGroupIdentityColumns?.id ?? "committee_id");
  const outsideNameColumn = assertIdentityColumn(
    label,
    "outside-group",
    config.outsideGroupIdentityColumns?.name ?? "committee_name"
  );
  const linkIdColumn = assertIdentityColumn(label, "link", config.linkIdentityColumns?.id ?? "committee_id");
  const linkNameColumn = assertIdentityColumn(label, "link", config.linkIdentityColumns?.name ?? "committee_name");

  function normalizeElectionYear(value: number): number {
    if (!Number.isInteger(value) || value < minElectionYear || value > 2100) {
      throw new Error(`Invalid ${label} finance election year: ${value}`);
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
      throw new Error(`Invalid ${label} finance timestamp`);
    }
    return value.toISOString();
  }

  function normalizeNullableCount(value: number | null | undefined): number | null {
    if (value === undefined || value === null) {
      return null;
    }
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${label} finance contributor count must be a nonnegative integer`);
    }
    return value;
  }

  function validateLinkInput(link: StandardStateFinanceLinkInput): void {
    requireNonEmpty(link.candidateId, "candidate id");
    requireNonEmpty(link.electionId, "election id");
    normalizeElectionYear(link.electionYear);
    requireNonEmpty(link.candidateNameNormalized, `${label} finance candidate name`);
    requireNonEmpty(link.officeName, `${label} finance office name`);
    requireNonEmpty(link.committeeId, `${label} committee id`);
    requireNonEmpty(link.committeeName, `${label} committee name`);
    normalizeNullableDate(link.lastVerifiedAt);
  }

  async function withTransaction<T>(db: Queryable, work: (tx: Queryable) => Promise<T>): Promise<T> {
    if (!canOpenTransaction(db)) {
      if (isClientLikeQueryable(db)) {
        throw new Error(`${label} finance snapshot writes must receive a Pool, not a PoolClient`);
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

  // A 'manual' link_source marks an operator-curated row; machine syncs and
  // auto-linkers hitting the same (candidate, election, identity) triple must
  // not reclassify it or flip its status (auto-link selects on "no active
  // link", so without the status guard it would resurrect an operator-disabled
  // row). Same semantics as the bespoke writers' manual-link protection (`M`
  // in docs/finance-module-capability-matrix.md).
  async function upsertLink(input: {
    db: Queryable;
    link: StandardStateFinanceLinkInput;
  }): Promise<{ linkId: string }> {
    validateLinkInput(input.link);

    const candidateId = requireNonEmpty(input.link.candidateId, "candidate id");
    const electionId = requireNonEmpty(input.link.electionId, "election id");
    const electionYear = normalizeElectionYear(input.link.electionYear);
    const committeeId = normalizeCommitteeId(
      requireNonEmpty(input.link.committeeId, `${label} committee id`)
    );
    const linkSource = input.link.linkSource ?? "manual";
    const lastVerifiedAt = normalizeNullableDate(input.link.lastVerifiedAt);

    if (manualLinkProtection && linkSource !== "manual") {
      const manual = await input.db.query<{
        id: string;
        committee_id: string;
        link_status: string;
        election_year: number;
      }>(
        `SELECT id::text, ${linkIdColumn} AS committee_id, link_status, election_year FROM public.${tables.links} WHERE candidate_id=$1::uuid AND election_id=$2::uuid AND link_source='manual'`,
        [candidateId, electionId]
      );
      const sameCommittee = manual.rows.find(
        (row) => normalizeCommitteeId(row.committee_id) === committeeId
      );
      if (sameCommittee) {
        if (sameCommittee.link_status !== "active") {
          throw new Error(`${label} automatic finance link matches an operator-disabled manual link`);
        }
        if (sameCommittee.election_year !== electionYear) {
          throw new Error(
            `${label} automatic finance link year ${electionYear} does not match the protected manual link year ${sameCommittee.election_year}`
          );
        }
        if (lastVerifiedAt) {
          await input.db.query(
            `UPDATE public.${tables.links} SET last_verified_at=$2::timestamptz WHERE id=$1::uuid`,
            [sameCommittee.id, lastVerifiedAt]
          );
        }
        return { linkId: sameCommittee.id };
      }
      if (manual.rows.some((row) => row.link_status === "active")) {
        throw new Error(`${label} automatic finance link conflicts with protected manual link`);
      }
    }

    const protectedUpsertWhere = manualLinkProtection
      ? `\n      WHERE ${tables.links}.link_source <> 'manual' OR EXCLUDED.link_source = 'manual'`
      : "";

    const result = await input.db.query<ManualProtectedLinkRow>(
      `
      INSERT INTO public.${tables.links} (
        candidate_id,
        election_id,
        election_year,
        candidate_name_normalized,
        office_name,
        district,
        ${linkIdColumn},
        ${linkNameColumn},
        link_status,
        link_source,
        source_url,
        last_verified_at
      )
      VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz)
      ON CONFLICT (candidate_id, election_id, ${linkIdColumn})
      DO UPDATE SET
        candidate_name_normalized = EXCLUDED.candidate_name_normalized,
        office_name = EXCLUDED.office_name,
        district = EXCLUDED.district,
        ${linkNameColumn} = EXCLUDED.${linkNameColumn},
        ${manualProtectedLinkAssignments(tables.links)},
        source_url = EXCLUDED.source_url,
        last_verified_at = EXCLUDED.last_verified_at${protectedUpsertWhere}
      RETURNING ${MANUAL_PROTECTED_LINK_RETURNING}
    `,
      [
        candidateId,
        electionId,
        electionYear,
        requireNonEmpty(input.link.candidateNameNormalized, `${label} finance candidate name`),
        requireNonEmpty(input.link.officeName, `${label} finance office name`),
        normalizeOptionalText(input.link.district),
        committeeId,
        requireNonEmpty(input.link.committeeName, `${label} committee name`),
        input.link.linkStatus ?? "active",
        linkSource,
        normalizeOptionalText(input.link.sourceUrl),
        lastVerifiedAt,
      ]
    );

    assertLinkWriteNotBlocked(label, result.rows[0], linkSource, electionYear);
    const linkId = result.rows[0]?.id;
    if (!linkId) {
      if (manualLinkProtection) {
        throw new Error(
          `${label} finance link upsert wrote no row — blocked by a concurrent protected manual link`
        );
      }
      throw new Error(`${label} finance link upsert did not return an id`);
    }
    return { linkId };
  }

  const summaryUpdateClauses = SUMMARY_COLUMNS.map((column) => {
    const mode = config.summaryUpdatePolicy?.[column] ?? "preserveWhenNull";
    return mode === "replace"
      ? `${column} = EXCLUDED.${column}`
      : `${column} = COALESCE(EXCLUDED.${column}, ${tables.summaries}.${column})`;
  }).join(",\n        ");

  async function upsertSummary(input: {
    db: Queryable;
    linkId: string;
    electionYear: number;
    summary: StandardStateFinanceSummaryInput;
    syncedAt: Date;
  }): Promise<void> {
    await input.db.query(
      `
      INSERT INTO public.${tables.summaries} (
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
        ${summaryUpdateClauses},
        last_synced_at = EXCLUDED.last_synced_at
    `,
      [
        requireNonEmpty(input.linkId, `${label} finance link id`),
        normalizeElectionYear(input.electionYear),
        normalizeNullableAmount(input.summary.totalReceipts, "total receipts"),
        normalizeNullableAmount(input.summary.directContributionTotal, "direct contribution total"),
        normalizeNullableAmount(input.summary.totalDisbursements, "total disbursements"),
        config.allowNegativeCashOnHand
          ? normalizeNullableSignedAmount(input.summary.cashOnHand, "cash on hand")
          : normalizeNullableAmount(input.summary.cashOnHand, "cash on hand"),
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
    breakdown: StandardStateFinanceDirectBreakdownInput<TDirectCategoryType>;
    syncedAt: Date;
  }): Promise<void> {
    await input.db.query(
      `
      INSERT INTO public.${tables.directBreakdowns} (
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
        requireNonEmpty(input.linkId, `${label} finance link id`),
        normalizeElectionYear(input.electionYear),
        input.breakdown.categoryType,
        requireNonEmpty(input.breakdown.categoryName, `${label} finance direct breakdown category`),
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
    group: StandardStateFinanceOutsideGroupInput;
    syncedAt: Date;
  }): Promise<void> {
    await input.db.query(
      `
      INSERT INTO public.${tables.outsideGroups} (
        link_id,
        election_year,
        ${outsideIdColumn},
        ${outsideNameColumn},
        support_oppose,
        amount,
        source_url,
        last_synced_at
      )
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::timestamptz)
      ON CONFLICT (link_id, election_year, ${outsideIdColumn}, support_oppose)
      DO UPDATE SET
        ${outsideNameColumn} = EXCLUDED.${outsideNameColumn},
        amount = EXCLUDED.amount,
        source_url = EXCLUDED.source_url,
        last_synced_at = EXCLUDED.last_synced_at
    `,
      [
        requireNonEmpty(input.linkId, `${label} finance link id`),
        normalizeElectionYear(input.electionYear),
        normalizeCommitteeId(requireNonEmpty(input.group.committeeId, `${label} outside group committee id`)),
        requireNonEmpty(input.group.committeeName, `${label} outside group committee name`),
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
    breakdown: StandardStateFinanceOutsideGroupBreakdownInput;
    syncedAt: Date;
  }): Promise<void> {
    await input.db.query(
      `
      INSERT INTO public.${tables.outsideGroupBreakdowns} (
        link_id,
        election_year,
        ${outsideIdColumn},
        support_oppose,
        category_type,
        category_name,
        amount,
        contributor_count,
        source_url,
        last_synced_at
      )
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)
      ON CONFLICT (link_id, election_year, ${outsideIdColumn}, support_oppose, category_type, category_name)
      DO UPDATE SET
        amount = EXCLUDED.amount,
        contributor_count = EXCLUDED.contributor_count,
        source_url = EXCLUDED.source_url,
        last_synced_at = EXCLUDED.last_synced_at
    `,
      [
        requireNonEmpty(input.linkId, `${label} finance link id`),
        normalizeElectionYear(input.electionYear),
        normalizeCommitteeId(requireNonEmpty(input.breakdown.committeeId, `${label} outside breakdown committee id`)),
        input.breakdown.supportOppose,
        input.breakdown.categoryType,
        requireNonEmpty(input.breakdown.categoryName, `${label} outside breakdown category`),
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
    breakdowns: readonly StandardStateFinanceDirectBreakdownInput<TDirectCategoryType>[];
  }): Promise<void> {
    const keys = input.breakdowns.map((breakdown) => ({
      category_type: breakdown.categoryType,
      category_name: requireNonEmpty(breakdown.categoryName, `${label} finance direct breakdown category`),
    }));

    await input.db.query(
      `
      DELETE FROM public.${tables.directBreakdowns}
      WHERE link_id = $1::uuid
        AND election_year = $2
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset($3::jsonb) AS keep(
            category_type text,
            category_name text
          )
          WHERE keep.category_type = ${tables.directBreakdowns}.category_type
            AND keep.category_name = ${tables.directBreakdowns}.category_name
        )
    `,
      [requireNonEmpty(input.linkId, `${label} finance link id`), normalizeElectionYear(input.electionYear), JSON.stringify(keys)]
    );
  }

  async function deleteStaleOutsideGroupBreakdowns(input: {
    db: Queryable;
    linkId: string;
    electionYear: number;
    breakdowns: readonly StandardStateFinanceOutsideGroupBreakdownInput[];
  }): Promise<void> {
    const keys = input.breakdowns.map((breakdown) => ({
      // Key name must match the recordset column alias below.
      [outsideIdColumn]: normalizeCommitteeId(
        requireNonEmpty(breakdown.committeeId, `${label} outside breakdown committee id`)
      ),
      support_oppose: breakdown.supportOppose,
      category_type: breakdown.categoryType,
      category_name: requireNonEmpty(breakdown.categoryName, `${label} outside breakdown category`),
    }));

    await input.db.query(
      `
      DELETE FROM public.${tables.outsideGroupBreakdowns}
      WHERE link_id = $1::uuid
        AND election_year = $2
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset($3::jsonb) AS keep(
            ${outsideIdColumn} text,
            support_oppose text,
            category_type text,
            category_name text
          )
          WHERE keep.${outsideIdColumn} = ${tables.outsideGroupBreakdowns}.${outsideIdColumn}
            AND keep.support_oppose = ${tables.outsideGroupBreakdowns}.support_oppose
            AND keep.category_type = ${tables.outsideGroupBreakdowns}.category_type
            AND keep.category_name = ${tables.outsideGroupBreakdowns}.category_name
        )
    `,
      [requireNonEmpty(input.linkId, `${label} finance link id`), normalizeElectionYear(input.electionYear), JSON.stringify(keys)]
    );
  }

  async function deleteStaleOutsideGroups(input: {
    db: Queryable;
    linkId: string;
    electionYear: number;
    groups: readonly StandardStateFinanceOutsideGroupInput[];
  }): Promise<void> {
    const keys = input.groups.map((group) => ({
      // Key name must match the recordset column alias below.
      [outsideIdColumn]: normalizeCommitteeId(requireNonEmpty(group.committeeId, `${label} outside group committee id`)),
      support_oppose: group.supportOppose,
    }));

    await input.db.query(
      `
      DELETE FROM public.${tables.outsideGroups}
      WHERE link_id = $1::uuid
        AND election_year = $2
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset($3::jsonb) AS keep(
            ${outsideIdColumn} text,
            support_oppose text
          )
          WHERE keep.${outsideIdColumn} = ${tables.outsideGroups}.${outsideIdColumn}
            AND keep.support_oppose = ${tables.outsideGroups}.support_oppose
        )
    `,
      [requireNonEmpty(input.linkId, `${label} finance link id`), normalizeElectionYear(input.electionYear), JSON.stringify(keys)]
    );
  }

  function validateDirectBreakdowns(
    input: StandardStateFinanceSnapshotInput<TDirectCategoryType>
  ): void {
    for (const breakdown of input.directBreakdowns ?? []) {
      if (!directCategoryTypes.has(breakdown.categoryType)) {
        throw new Error(
          `${label} finance direct breakdown category type is not allowed: ${breakdown.categoryType}`
        );
      }
    }
  }

  function validateOutsideGroupBreakdowns(
    input: StandardStateFinanceSnapshotInput<TDirectCategoryType>
  ): void {
    if (outsideGroupValidation === "none") {
      return;
    }
    const breakdownCount = input.outsideGroupBreakdowns?.length ?? 0;
    if (breakdownCount === 0) {
      return;
    }
    if ((input.outsideGroups?.length ?? 0) === 0) {
      throw new Error(`${label} outside group breakdowns require outside groups in the same snapshot`);
    }
    if (outsideGroupValidation !== "pairing") {
      return;
    }
    const groupKeys = new Set(
      (input.outsideGroups ?? []).map(
        (group) =>
          `${normalizeCommitteeId(requireNonEmpty(group.committeeId, `${label} outside group committee id`))}\u0000${group.supportOppose}`
      )
    );
    for (const breakdown of input.outsideGroupBreakdowns ?? []) {
      const key = `${normalizeCommitteeId(requireNonEmpty(breakdown.committeeId, `${label} outside breakdown committee id`))}\u0000${breakdown.supportOppose}`;
      if (!groupKeys.has(key)) {
        throw new Error(`${label} outside group breakdowns must reference outside groups in the same snapshot`);
      }
    }
  }

  async function deactivateSupersededLinks(input: {
    db: Queryable;
    link: StandardStateFinanceLinkInput;
    activeLinkId: string;
  }): Promise<void> {
    if (supersededLinkSource === undefined) {
      return;
    }
    if ((input.link.linkStatus ?? "active") !== "active" || (input.link.linkSource ?? "manual") !== supersededLinkSource) {
      return;
    }

    await input.db.query(
      `
      UPDATE public.${tables.links}
      SET link_status = 'inactive'
      WHERE candidate_id = $1::uuid
        AND election_id = $2::uuid
        AND id <> $3::uuid
        AND link_status = 'active'
        AND link_source = '${supersededLinkSource}'
    `,
      [
        requireNonEmpty(input.link.candidateId, "candidate id"),
        requireNonEmpty(input.link.electionId, "election id"),
        requireNonEmpty(input.activeLinkId, `${label} finance link id`),
      ]
    );
  }

  async function replaceSnapshot(
    input: StandardStateFinanceSnapshotInput<TDirectCategoryType>
  ): Promise<StandardStateFinanceSnapshotWriteResult> {
    const syncedAt = input.syncedAt ?? new Date();
    if (Number.isNaN(syncedAt.getTime())) {
      throw new Error(`Invalid ${label} finance sync timestamp`);
    }
    validateLinkInput(input.link);
    validateDirectBreakdowns(input);
    validateOutsideGroupBreakdowns(input);
    const electionYear = normalizeElectionYear(input.link.electionYear);

    return await withTransaction(input.db, async (db) => {
      const { linkId } = await upsertLink({ db, link: input.link });
      await deactivateSupersededLinks({ db, link: input.link, activeLinkId: linkId });
      if (input.summary) {
        await upsertSummary({ db, linkId, electionYear, summary: input.summary, syncedAt });
        await input.afterSummaryWrite?.({ db, linkId, electionYear });
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
        outsideGroupsWritten: input.outsideGroups?.length ?? 0,
        outsideGroupBreakdownsWritten: input.outsideGroupBreakdowns?.length ?? 0,
      };
    });
  }

  return { upsertLink, replaceSnapshot };
}
