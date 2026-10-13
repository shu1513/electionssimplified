// Link writes and the all-or-nothing snapshot writer (docs/plans/plan-phoenix-finance.md
// Phase 1). Upsert semantics mirror the San José writer: one active link per
// (candidate, election); a manual active link is protected — a matching
// automatic link reuses it, a conflicting one errors; an active upsert
// deactivates other automatic links first.
//
// Snapshot components share one transaction. Direct data is replaced after
// its source-health checks. Outside groups are optional: omission preserves,
// and the default upsert retains payers absent from an incomplete observation.
// Explicit replace is reserved for complete replacement authority. Outside
// summary omission preserves, while explicit null records unknown coverage.

// Phoenix vs San José: committee identity is the COP ID (new one each
// election cycle — never parse district or cycle from its digits), there is
// no "Pending" placeholder to reject, the link carries the portal's own
// election cycle (Apr 1 odd year → Mar 31 two years later), and the summary
// carries outside_coverage_note (four outside channels; unmeasured channels
// are disclosed, and nothing-measured stays NULL, never zero).

import type { Pool, PoolClient } from "pg";
import type { FinanceLabelClassification } from "../finance/financeLabelClassifier.js";
import { upsertFinanceLabelClassification } from "../finance/financeIndustryClassificationService.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type PoolLike = Queryable & { connect: () => Promise<PoolClient> };

export type PhoenixFinanceLinkInput = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  candidateNameNormalized: string;
  /** City of Phoenix COP ID (e.g. "CAN-25-4"); uppercased before every use. */
  copId: string;
  committeeName: string;
  /** Registration ElectionCycle string (the portal's cycle identity). */
  portalCycleName: string;
  /** ISO dates bounding the portal cycle (e.g. 2025-04-01 → 2027-03-31). */
  portalCycleStart: string;
  portalCycleEnd: string;
  linkStatus?: "active" | "needs_review" | "inactive";
  linkSource?: "manual" | "efiling_portal";
  sourceUrl?: string | null;
  lastVerifiedAt?: Date | null;
};

// All snapshot amounts arrive as integer cents (the aggregators' unit) and
// are converted to exact dollar strings at the database boundary.
export type PhoenixFinanceSummaryInput = {
  /** Σ Schedule A line 1(m) net monetary contributions over canonical reports. */
  totalRaisedCents: number | null;
  /** Σ Schedule B line 16 cash over canonical reports. */
  totalSpentCents: number | null;
  /** Latest cover (d) closing balance — signed; may legitimately be negative. */
  cashOnHandCents: number | null;
  debtsOwedCents: number | null;
  loansReceivedCents: number | null;
  outsideSupportCents?: number | null;
  outsideOpposeCents?: number | null;
  /** One sentence naming what the direct totals do NOT cover; null = complete. */
  directCoverageNote: string | null;
  /** Same disclosure for the outside totals (unmeasured/curated channels). */
  outsideCoverageNote: string | null;
  methodologyVersion: string;
  sourceUrl: string | null;
  /** ISO date the balances are reported through (latest covered period end). */
  reportedThrough: string | null;
};

export type PhoenixDirectBreakdownInput = {
  categoryType: "occupation" | "employer" | "industry" | "contribution_size";
  categoryName: string;
  amountCents: number;
  contributorCount: number | null;
  sourceUrl?: string | null;
};

export type PhoenixOutsideGroupInput = {
  /** COP ID for portal PACs; curated channels define their own identifier. */
  spenderFilerId: string;
  spenderName: string;
  supportOppose: "support" | "oppose";
  amountCents: number;
  expenditureCount: number | null;
  sourceUrl?: string | null;
};

const text = (value: string, label: string): string => {
  const result = value.trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
};
const optional = (value: string | null | undefined): string | null =>
  value?.trim() || null;
const isoDate = (value: string, label: string): string => {
  const result = text(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result))
    throw new Error(`${label} must be an ISO date (YYYY-MM-DD)`);
  return result;
};
// Exact cents → "dollars.cc" string; string arithmetic, never binary floats.
// Flows must be nonnegative (refunds are already netted inside the
// aggregates) and throwing aborts the snapshot transaction so the prior
// snapshot survives; cash on hand is a signed balance and passes negatives
// through (Math.trunc keeps the sign, e.g. -4200 → "-42.00").
const centsToDollars = (
  cents: number | null,
  label: string,
  options?: { allowNegative?: boolean },
): string | null => {
  if (cents === null) return null;
  if (!Number.isSafeInteger(cents))
    throw new Error(`${label} must be integer cents`);
  if (cents < 0 && !options?.allowNegative)
    throw new Error(`${label} must be nonnegative`);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
};

export async function upsertPhoenixFinanceLink(input: {
  db: Queryable;
  link: PhoenixFinanceLinkInput;
}): Promise<{ linkId: string }> {
  const link = input.link;
  const linkStatus = link.linkStatus ?? "active";
  const linkSource = link.linkSource ?? "manual";
  // Trimmed and uppercased once, then the single value used for the manual
  // probe, the deactivation predicate, and the INSERT — a padded or
  // re-cased id must match a stored id, not slip past the probe and reach
  // the manual row through ON CONFLICT (the DB CHECK enforces uppercase on
  // stored rows).
  const copId = text(link.copId, "COP id").toUpperCase();
  // Every INSERT parameter is validated and normalized BEFORE any statement
  // runs: callers hand this a plain Queryable (the auto-link passes a Pool,
  // where each statement autocommits), so a validation throw between the
  // deactivation UPDATE and the INSERT would leave the candidate with no
  // active link until the next run. The two cycle dates are shape-checked
  // here for the same reason — a bad string must not become a DB cast error
  // after the deactivation already committed.
  const insertParams = [
    text(link.candidateId, "candidate id"),
    text(link.electionId, "election id"),
    link.electionYear,
    text(link.candidateNameNormalized, "candidate name"),
    copId,
    text(link.committeeName, "committee name"),
    text(link.portalCycleName, "portal cycle name"),
    isoDate(link.portalCycleStart, "portal cycle start"),
    isoDate(link.portalCycleEnd, "portal cycle end"),
    linkStatus,
    linkSource,
    optional(link.sourceUrl),
    link.lastVerifiedAt?.toISOString() ?? null,
  ];
  // Manual protection applies to EVERY automatic write, not only active
  // upserts, and probes manual rows of ANY status: an operator-disabled
  // (inactive/needs_review) manual link with this cop_id is the
  // ON CONFLICT target row, and the upsert would otherwise silently
  // resurrect it as active/efiling_portal.
  if (linkSource === "efiling_portal") {
    const manual = await input.db.query<{
      id: string;
      cop_id: string;
      link_status: string;
    }>(
      `SELECT id::text,cop_id,link_status FROM public.phx_candidate_finance_links WHERE candidate_id=$1::uuid AND election_id=$2::uuid AND link_source='manual'`,
      [link.candidateId, link.electionId],
    );
    const sameCop = manual.rows.find((row) => row.cop_id === copId);
    if (sameCop) {
      if (sameCop.link_status !== "active")
        throw new Error(
          "Phoenix automatic finance link matches an operator-disabled manual link",
        );
      // An exact committee match IS a portal verification of the manual
      // link, so advance last_verified_at (and nothing else — the row
      // stays the operator's). Without this a stale-election selector
      // driving off active links' last_verified_at would treat the
      // election as stale on every run forever.
      if (link.lastVerifiedAt)
        await input.db.query(
          `UPDATE public.phx_candidate_finance_links SET last_verified_at=$2::timestamptz WHERE id=$1::uuid`,
          [sameCop.id, link.lastVerifiedAt.toISOString()],
        );
      return { linkId: sameCop.id };
    }
    // A disabled manual link with a DIFFERENT cop_id does not block a new
    // automatic identity — the operator disabled that association, not the
    // candidate. Only an active manual link conflicts.
    if (manual.rows.some((row) => row.link_status === "active"))
      throw new Error(
        "Phoenix automatic finance link conflicts with protected manual link",
      );
  }
  if (linkStatus === "active")
    await input.db.query(
      `UPDATE public.phx_candidate_finance_links SET link_status='inactive' WHERE candidate_id=$1::uuid AND election_id=$2::uuid AND cop_id<>$3 AND link_status='active' AND link_source<>'manual'`,
      [link.candidateId, link.electionId, copId],
    );
  // The DO UPDATE's WHERE is the DB-enforced backstop for the probe above:
  // the probe and this upsert are separate statements, so a manual row
  // created or disabled in between would otherwise be rewritten by an
  // unconditional DO UPDATE. Manual writes may update manual rows; an
  // automatic write against a manual target updates nothing, RETURNING
  // comes back empty, and the throw below aborts the write.
  const result = await input.db.query<{ id: string }>(
    `INSERT INTO public.phx_candidate_finance_links (candidate_id,election_id,election_year,candidate_name_normalized,cop_id,committee_name,portal_cycle_name,portal_cycle_start,portal_cycle_end,link_status,link_source,source_url,last_verified_at) VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8::date,$9::date,$10,$11,$12,$13::timestamptz) ON CONFLICT (candidate_id,election_id,cop_id) DO UPDATE SET election_year=EXCLUDED.election_year,candidate_name_normalized=EXCLUDED.candidate_name_normalized,committee_name=EXCLUDED.committee_name,portal_cycle_name=EXCLUDED.portal_cycle_name,portal_cycle_start=EXCLUDED.portal_cycle_start,portal_cycle_end=EXCLUDED.portal_cycle_end,link_status=EXCLUDED.link_status,link_source=EXCLUDED.link_source,source_url=EXCLUDED.source_url,last_verified_at=EXCLUDED.last_verified_at WHERE phx_candidate_finance_links.link_source<>'manual' OR EXCLUDED.link_source='manual' RETURNING id::text`,
    insertParams,
  );
  if (!result.rows[0]?.id)
    throw new Error(
      "Phoenix finance link upsert wrote no row — blocked by a concurrent protected manual link",
    );
  return { linkId: result.rows[0].id };
}

/**
 * Writes one candidate's supplied finance components — link, summary, direct
 * breakdowns, optional outside groups, and industry-label classifications —
 * in a single transaction. See the header comment for the staging contract;
 * any validation failure (negative flow, blank name) rolls the whole
 * snapshot back.
 */
export async function replacePhoenixCandidateFinanceSnapshot(input: {
  db: PoolLike;
  link: PhoenixFinanceLinkInput;
  summary: PhoenixFinanceSummaryInput;
  directBreakdowns: readonly PhoenixDirectBreakdownInput[];
  /** Omitted means unavailable; an empty upsert does not establish absence. */
  outsideGroups?: readonly PhoenixOutsideGroupInput[];
  /** Replace requires complete authority; normal partial city coverage upserts. */
  outsideWriteMode?: "upsert" | "replace";
  classifications?: readonly FinanceLabelClassification[];
  syncedAt?: Date;
}): Promise<{ linkId: string }> {
  if (typeof input.db.connect !== "function")
    throw new Error("Phoenix finance snapshot writes require a Pool");
  // Retain one caller generation before any asynchronous database work.
  const snapshot = structuredClone({
    link: input.link,
    summary: input.summary,
    directBreakdowns: input.directBreakdowns,
    outsideGroups: input.outsideGroups,
    outsideWriteMode: input.outsideWriteMode ?? "upsert",
    classifications: input.classifications,
  });
  if (
    snapshot.outsideWriteMode !== "upsert" &&
    snapshot.outsideWriteMode !== "replace"
  )
    throw new Error("Phoenix outside write mode is invalid");
  const outsideKeys = new Set<string>();
  for (const group of snapshot.outsideGroups ?? []) {
    const key = JSON.stringify([
      text(group.spenderFilerId, "spender filer id"),
      text(group.spenderName, "spender name"),
      group.supportOppose,
    ]);
    if (group.supportOppose !== "support" && group.supportOppose !== "oppose")
      throw new Error("Phoenix outside direction is invalid");
    centsToDollars(group.amountCents, "outside amount");
    if (group.amountCents <= 0)
      throw new Error("Phoenix outside amount must be positive");
    if (
      group.expenditureCount !== null &&
      (!Number.isSafeInteger(group.expenditureCount) ||
        group.expenditureCount <= 0)
    )
      throw new Error(
        "Phoenix outside expenditure count must be positive integer or null",
      );
    if (outsideKeys.has(key))
      throw new Error("Phoenix outside group key is repeated");
    outsideKeys.add(key);
  }
  for (const [value, label] of [
    [snapshot.summary.outsideSupportCents, "outside support"],
    [snapshot.summary.outsideOpposeCents, "outside oppose"],
  ] as const)
    if (value !== undefined) centsToDollars(value, label);
  const syncedAt = (input.syncedAt ?? new Date()).toISOString();
  const client = await input.db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `phx-finance:${snapshot.link.candidateId}:${snapshot.link.electionYear}`,
    ]);
    const prior = await client.query<{ last_synced_at: Date | string }>(
      `SELECT s.last_synced_at FROM public.phx_candidate_finance_summaries s JOIN public.phx_candidate_finance_links l ON l.id=s.link_id WHERE l.candidate_id=$1::uuid AND l.election_id=$2::uuid AND s.election_year=$3 FOR UPDATE OF s`,
      [
        snapshot.link.candidateId,
        snapshot.link.electionId,
        snapshot.link.electionYear,
      ],
    );
    if (
      prior.rows.some((row) => {
        const previous = new Date(row.last_synced_at).getTime();
        return !Number.isFinite(previous) || previous > Date.parse(syncedAt);
      })
    )
      throw new Error(
        "Phoenix finance snapshot is older than the stored observation",
      );
    const { linkId } = await upsertPhoenixFinanceLink({
      db: client,
      link: snapshot.link,
    });
    const year = snapshot.link.electionYear;
    await client.query(
      `INSERT INTO public.phx_candidate_finance_summaries (link_id,election_year,total_raised,total_spent,cash_on_hand,debts_owed,loans_received,outside_support_total,outside_oppose_total,direct_coverage_note,outside_coverage_note,methodology_version,source_url,reported_through,last_synced_at) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::date,$15::timestamptz) ON CONFLICT (link_id,election_year) DO UPDATE SET total_raised=EXCLUDED.total_raised,total_spent=EXCLUDED.total_spent,cash_on_hand=EXCLUDED.cash_on_hand,debts_owed=EXCLUDED.debts_owed,loans_received=EXCLUDED.loans_received,outside_support_total=CASE WHEN $16::boolean THEN phx_candidate_finance_summaries.outside_support_total ELSE EXCLUDED.outside_support_total END,outside_oppose_total=CASE WHEN $17::boolean THEN phx_candidate_finance_summaries.outside_oppose_total ELSE EXCLUDED.outside_oppose_total END,direct_coverage_note=EXCLUDED.direct_coverage_note,outside_coverage_note=EXCLUDED.outside_coverage_note,methodology_version=EXCLUDED.methodology_version,source_url=EXCLUDED.source_url,reported_through=EXCLUDED.reported_through,last_synced_at=EXCLUDED.last_synced_at`,
      [
        linkId,
        year,
        centsToDollars(snapshot.summary.totalRaisedCents, "total raised"),
        centsToDollars(snapshot.summary.totalSpentCents, "total spent"),
        centsToDollars(snapshot.summary.cashOnHandCents, "cash on hand", {
          allowNegative: true,
        }),
        centsToDollars(snapshot.summary.debtsOwedCents, "debts owed"),
        centsToDollars(snapshot.summary.loansReceivedCents, "loans received"),
        centsToDollars(
          snapshot.summary.outsideSupportCents ?? null,
          "outside support",
        ),
        centsToDollars(
          snapshot.summary.outsideOpposeCents ?? null,
          "outside oppose",
        ),
        optional(snapshot.summary.directCoverageNote),
        optional(snapshot.summary.outsideCoverageNote),
        text(snapshot.summary.methodologyVersion, "methodology version"),
        optional(snapshot.summary.sourceUrl),
        snapshot.summary.reportedThrough,
        syncedAt,
        snapshot.summary.outsideSupportCents === undefined,
        snapshot.summary.outsideOpposeCents === undefined,
      ],
    );
    await client.query(
      `DELETE FROM public.phx_candidate_finance_direct_breakdowns WHERE link_id=$1::uuid AND election_year=$2`,
      [linkId, year],
    );
    for (const row of snapshot.directBreakdowns)
      await client.query(
        `INSERT INTO public.phx_candidate_finance_direct_breakdowns (link_id,election_year,category_type,category_name,amount,contributor_count,source_url,last_synced_at) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::timestamptz)`,
        [
          linkId,
          year,
          row.categoryType,
          text(row.categoryName, "category name"),
          centsToDollars(row.amountCents, "breakdown amount"),
          row.contributorCount,
          optional(row.sourceUrl),
          syncedAt,
        ],
      );
    if (
      snapshot.outsideGroups !== undefined &&
      snapshot.outsideWriteMode === "replace"
    )
      await client.query(
        `DELETE FROM public.phx_candidate_finance_outside_groups WHERE link_id=$1::uuid AND election_year=$2`,
        [linkId, year],
      );
    // Positive known allocations refresh their exact stored group key;
    // absent payers or directions survive a partial observation.
    for (const group of snapshot.outsideGroups ?? [])
      await client.query(
        `INSERT INTO public.phx_candidate_finance_outside_groups (link_id,election_year,spender_filer_id,spender_name,support_oppose,amount,expenditure_count,source_url,last_synced_at) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz) ON CONFLICT (link_id,election_year,spender_filer_id,spender_name,support_oppose) DO UPDATE SET amount=EXCLUDED.amount,expenditure_count=EXCLUDED.expenditure_count,source_url=EXCLUDED.source_url,last_synced_at=EXCLUDED.last_synced_at`,
        [
          linkId,
          year,
          text(group.spenderFilerId, "spender filer id"),
          text(group.spenderName, "spender name"),
          group.supportOppose,
          centsToDollars(group.amountCents, "outside amount"),
          group.expenditureCount,
          optional(group.sourceUrl),
          syncedAt,
        ],
      );
    for (const classification of snapshot.classifications ?? [])
      await upsertFinanceLabelClassification({ db: client, classification });
    await client.query("COMMIT");
    return { linkId };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}
