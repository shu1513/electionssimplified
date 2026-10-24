// Link writes and the all-or-nothing snapshot writer (plan Phase 1). Copy of
// the Denver writer's semantics (itself the San José copy) — one active link
// per (candidate, election); a manual active link is protected (a matching
// automatic link reuses it, a conflicting one errors); an active upsert
// deactivates other automatic links first — over the standard five-table
// column shape, because Phase 3 reads through
// standardStateFinanceBallotLookupLoader / standardStateFinanceDueListQuery
// as-is.
//
// Austin identity: there is no filer id. filer_key is the normalized filer
// name (austinFinanceKeys.ts) and is DERIVED here from filer_name, so a
// caller can never pair a key with a name it did not come from; filer_name
// keeps the exact Socrata spelling because the sync queries Report Detail
// with `filer_name = '<that string>'` — so a matching automatic write
// refreshes it even on a protected manual link (a source spelling is known
// to exist; an operator-typed one may not). Outside spenders are the same
// story (spender_key derived from spender_name).
//
// Snapshot semantics: the caller stages every component and calls
// replaceAustinCandidateFinanceSnapshot only when all of them passed
// source-health checks — the write is one transaction, so a summary can
// never coexist with breakdowns or outside groups from a different as-of.
// Source unavailable → the caller does not call this at all and the prior
// snapshot survives untouched. Omitted outside or committee components preserve
// prior detail; explicit qualified empty components clear it. Source affirmatively reports no qualifying
// data → the caller passes zero totals and empty arrays and the
// delete-and-insert clears the stale detail rows (outside-group deletes
// cascade into outside_group_breakdowns).

import type { Pool, PoolClient } from "pg";

import type { AustinReportedCommitteeCash } from "./austinReportedCommitteeCash.js";
import type { FinanceLabelClassification } from "../finance/financeLabelClassifier.js";
import { upsertFinanceLabelClassification } from "../finance/financeIndustryClassificationService.js";
import { normalizeAustinFinanceTextKey } from "./austinFinanceKeys.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type PoolLike = Queryable & { connect: () => Promise<PoolClient> };

export type AustinFinanceLinkSource = "manual" | "austin_clerk";

export type AustinFinanceLinkInput = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  candidateNameNormalized: string;
  officeName: string;
  district?: string | null;
  /** Exact Report Detail `filer_name` / Contributions `recipient`, e.g. "Watson, Kirk P.". */
  filerName: string;
  linkStatus?: "active" | "needs_review" | "inactive";
  linkSource?: AustinFinanceLinkSource;
  sourceUrl?: string | null;
  lastVerifiedAt?: Date | null;
};

// All snapshot amounts arrive as integer cents (the aggregators' unit) and
// are converted to exact dollar strings at the database boundary.
export type AustinFinanceSummaryInput = {
  /** Σ `contrib_total` over the cycle's effective reports. */
  totalReceiptsCents: number | null;
  /** Same figure — Austin has no non-donor receipts to split out. */
  directContributionTotalCents: number | null;
  /** Σ `expend_total` over the same effective reports. */
  totalDisbursementsCents: number | null;
  /** `contrib_balance` of the latest effective report — a signed balance. */
  cashOnHandCents: number | null;
  outsideSupportCents?: number | null;
  outsideOpposeCents?: number | null;
  sourceUrl: string | null;
};

export type AustinDirectBreakdownInput = {
  categoryType: "occupation" | "contribution_size";
  categoryName: string;
  amountCents: number;
  contributorCount: number | null;
  sourceUrl?: string | null;
};

export type AustinOutsideGroupInput = {
  /** DCE `paid_by` display spelling; the key is derived from it. */
  spenderName: string;
  supportOppose: "support" | "oppose";
  amountCents: number;
  sourceUrl?: string | null;
};

export type AustinOutsideGroupBreakdownInput = {
  /** Must match a supplied outside group's spender (same normalizer). */
  spenderName: string;
  supportOppose: "support" | "oppose";
  categoryType: "donor" | "industry";
  categoryName: string;
  amountCents: number;
  contributorCount: number | null;
  sourceUrl?: string | null;
};

const text = (value: string, label: string): string => {
  const result = value.trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
};
const optional = (value: string | null | undefined): string | null =>
  value?.trim() || null;
// Name → key. A name that normalizes to nothing (punctuation only) has no
// identity and must fail here, not as an opaque CHECK rollback.
const keyOf = (name: string, label: string): string => {
  const key = normalizeAustinFinanceTextKey(name);
  if (!key) throw new Error(`${label} has no identity after normalization`);
  return key;
};
const count = (value: number | null, label: string): number | null => {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${label} must be a nonnegative integer`);
  return value;
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

export async function upsertAustinFinanceLink(input: {
  db: Queryable;
  link: AustinFinanceLinkInput;
}): Promise<{ linkId: string }> {
  const link = input.link;
  const linkStatus = link.linkStatus ?? "active";
  const linkSource = link.linkSource ?? "manual";
  const filerName = text(link.filerName, "filer name");
  const filerKey = keyOf(filerName, "filer name");
  // Manual protection applies to EVERY automatic write, not only active
  // upserts, and probes manual rows of ANY status: an operator-disabled
  // (inactive/needs_review) manual link with this filer key is the
  // ON CONFLICT target row, and the upsert would otherwise silently
  // resurrect it as active/austin_clerk.
  if (linkSource === "austin_clerk") {
    const manual = await input.db.query<{
      id: string;
      filer_key: string;
      link_status: string;
    }>(
      `SELECT id::text,filer_key,link_status FROM public.atx_candidate_finance_links WHERE candidate_id=$1::uuid AND election_id=$2::uuid AND link_source='manual'`,
      [link.candidateId, link.electionId],
    );
    const sameFiler = manual.rows.find((row) => row.filer_key === filerKey);
    if (sameFiler) {
      if (sameFiler.link_status !== "active")
        throw new Error(
          "Austin automatic finance link matches an operator-disabled manual link",
        );
      // An exact filer match IS a Socrata verification of the manual link:
      // refresh filer_name to the source spelling and advance
      // last_verified_at — and nothing else, the row stays the operator's.
      // filer_name is the sync's exact-match query key, not operator
      // judgment (the identity they chose is the key, which matched): an
      // automatic spelling comes from Report Detail rows and is known to
      // exist there, an operator-typed one ("Watson Kirk P") may not — same
      // reasoning as Denver refreshing entity ids on a protected row.
      await input.db.query(
        `UPDATE public.atx_candidate_finance_links SET filer_name=$2,last_verified_at=COALESCE($3::timestamptz,last_verified_at) WHERE id=$1::uuid`,
        [sameFiler.id, filerName, link.lastVerifiedAt?.toISOString() ?? null],
      );
      return { linkId: sameFiler.id };
    }
    // A disabled manual link with a DIFFERENT filer key does not block a new
    // automatic identity — the operator disabled that association, not the
    // candidate. Only an active manual link conflicts.
    if (manual.rows.some((row) => row.link_status === "active"))
      throw new Error(
        "Austin automatic finance link conflicts with protected manual link",
      );
  }
  if (linkStatus === "active")
    await input.db.query(
      `UPDATE public.atx_candidate_finance_links SET link_status='inactive' WHERE candidate_id=$1::uuid AND election_id=$2::uuid AND filer_key<>$3 AND link_status='active' AND link_source<>'manual'`,
      [link.candidateId, link.electionId, filerKey],
    );
  // The DO UPDATE's WHERE is the DB-enforced backstop for the probe above:
  // the probe and this upsert are separate statements, so a manual row
  // created or disabled in between would otherwise be rewritten by an
  // unconditional DO UPDATE. Manual writes may update manual rows; an
  // automatic write against a manual target updates nothing, RETURNING
  // comes back empty, and the throw below aborts the write (same guard the
  // Denver/San José/San Diego writers carry).
  const result = await input.db.query<{ id: string }>(
    `INSERT INTO public.atx_candidate_finance_links (candidate_id,election_id,election_year,candidate_name_normalized,office_name,district,filer_key,filer_name,link_status,link_source,source_url,last_verified_at) VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz) ON CONFLICT (candidate_id,election_id,filer_key) DO UPDATE SET election_year=EXCLUDED.election_year,candidate_name_normalized=EXCLUDED.candidate_name_normalized,office_name=EXCLUDED.office_name,district=EXCLUDED.district,filer_name=EXCLUDED.filer_name,link_status=EXCLUDED.link_status,link_source=EXCLUDED.link_source,source_url=EXCLUDED.source_url,last_verified_at=EXCLUDED.last_verified_at WHERE atx_candidate_finance_links.link_source<>'manual' OR EXCLUDED.link_source='manual' RETURNING id::text`,
    [
      text(link.candidateId, "candidate id"),
      text(link.electionId, "election id"),
      link.electionYear,
      text(link.candidateNameNormalized, "candidate name"),
      text(link.officeName, "office name"),
      optional(link.district),
      filerKey,
      filerName,
      linkStatus,
      linkSource,
      optional(link.sourceUrl),
      link.lastVerifiedAt?.toISOString() ?? null,
    ],
  );
  if (!result.rows[0]?.id)
    throw new Error(
      "Austin finance link upsert wrote no row — blocked by a concurrent protected manual link",
    );
  return { linkId: result.rows[0].id };
}

/**
 * Writes one candidate's complete finance snapshot — link, summary, direct
 * breakdowns, outside group amounts, and per-spender funder breakdowns — in
 * a single transaction. See the header comment for the staging contract; any
 * validation failure (negative flow, blank name, breakdown without its
 * group) rolls the whole snapshot back.
 */
export async function replaceAustinCandidateFinanceSnapshot(input: {
  db: PoolLike;
  link: AustinFinanceLinkInput;
  summary: AustinFinanceSummaryInput;
  directBreakdowns: readonly AustinDirectBreakdownInput[];
  outsideGroups?: readonly AustinOutsideGroupInput[];
  reportedCommitteeCash?: AustinReportedCommitteeCash;
  outsideGroupBreakdowns?: readonly AustinOutsideGroupBreakdownInput[];
  /**
   * Donor-label industry classifications behind the breakdowns, persisted to
   * the shared `finance_label_classifications` cache (the ballot-lookup
   * evidence join reads industries off that table; the guarded upsert never
   * degrades a manual verdict — see upsertFinanceLabelClassification).
   */
  classifications?: readonly FinanceLabelClassification[];
  syncedAt?: Date;
}): Promise<{ linkId: string }> {
  if (typeof input.db.connect !== "function")
    throw new Error("Austin finance snapshot writes require a Pool");
  const syncedAt = (input.syncedAt ?? new Date()).toISOString();
  // Pairing check before any statement runs: every breakdown must sit under
  // a group in the SAME snapshot (the FK would reject it anyway, but as an
  // opaque constraint error after the deletes already ran).
  const groupKeys = new Set(
    (input.outsideGroups ?? []).map(
      (group) =>
        `${keyOf(group.spenderName, "spender name")}|${group.supportOppose}`,
    ),
  );
  for (const row of input.outsideGroupBreakdowns ?? []) {
    const key = `${keyOf(row.spenderName, "spender name")}|${row.supportOppose}`;
    if (!groupKeys.has(key))
      throw new Error(
        `Austin outside group breakdown has no matching outside group: ${row.spenderName} (${row.supportOppose})`,
      );
  }
  const cash = input.reportedCommitteeCash;
  if (cash) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cash.reportedThrough) ||
      !Number.isFinite(Date.parse(cash.reportedThrough)) || new Date(cash.reportedThrough).toISOString().slice(0, 10) !== cash.reportedThrough)
      throw new Error("Austin committee cash requires a valid report date");
    const keys = new Set<string>();
    let total = 0, gifts = 0;
    for (const donor of cash.donors) {
      if (donor.committeeKey !== keyOf(donor.committeeName, "committee name") || keys.has(donor.committeeKey) ||
        !Number.isSafeInteger(donor.amountCents) || donor.amountCents <= 0 ||
        !Number.isSafeInteger(donor.contributionCount) || donor.contributionCount <= 0)
        throw new Error("Austin committee cash has invalid reported groups");
      keys.add(donor.committeeKey); total += donor.amountCents; gifts += donor.contributionCount;
    }
    if (!Number.isSafeInteger(total) || !Number.isSafeInteger(gifts) || total !== cash.amountCents || gifts !== cash.contributionCount)
      throw new Error("Austin committee cash source counts and cents do not close");
  }
  const client = await input.db.connect();
  try {
    await client.query("BEGIN");
    const { linkId } = await upsertAustinFinanceLink({
      db: client,
      link: input.link,
    });
    const year = input.link.electionYear;
    await client.query(
      `INSERT INTO public.atx_candidate_finance_summaries (link_id,election_year,total_receipts,direct_contribution_total,total_disbursements,cash_on_hand,outside_support_total,outside_oppose_total,source_url,last_synced_at) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz) ON CONFLICT (link_id,election_year) DO UPDATE SET total_receipts=EXCLUDED.total_receipts,direct_contribution_total=EXCLUDED.direct_contribution_total,total_disbursements=EXCLUDED.total_disbursements,cash_on_hand=EXCLUDED.cash_on_hand,outside_support_total=CASE WHEN $11::boolean THEN EXCLUDED.outside_support_total ELSE atx_candidate_finance_summaries.outside_support_total END,outside_oppose_total=CASE WHEN $12::boolean THEN EXCLUDED.outside_oppose_total ELSE atx_candidate_finance_summaries.outside_oppose_total END,source_url=EXCLUDED.source_url,last_synced_at=EXCLUDED.last_synced_at`,
      [
        linkId,
        year,
        centsToDollars(input.summary.totalReceiptsCents, "total receipts"),
        centsToDollars(
          input.summary.directContributionTotalCents,
          "direct contribution total",
        ),
        centsToDollars(
          input.summary.totalDisbursementsCents,
          "total disbursements",
        ),
        centsToDollars(input.summary.cashOnHandCents, "cash on hand", {
          allowNegative: true,
        }),
        centsToDollars(input.summary.outsideSupportCents ?? null, "outside support"),
        centsToDollars(input.summary.outsideOpposeCents ?? null, "outside oppose"),
        optional(input.summary.sourceUrl),
        syncedAt,
        input.summary.outsideSupportCents !== undefined,
        input.summary.outsideOpposeCents !== undefined,
      ],
    );
    await client.query(
      `DELETE FROM public.atx_candidate_finance_direct_breakdowns WHERE link_id=$1::uuid AND election_year=$2`,
      [linkId, year],
    );
    for (const row of input.directBreakdowns)
      await client.query(
        `INSERT INTO public.atx_candidate_finance_direct_breakdowns (link_id,election_year,category_type,category_name,amount,contributor_count,source_url,last_synced_at) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::timestamptz)`,
        [
          linkId,
          year,
          row.categoryType,
          text(row.categoryName, "category name"),
          centsToDollars(row.amountCents, "breakdown amount"),
          count(row.contributorCount, "contributor count"),
          optional(row.sourceUrl),
          syncedAt,
        ],
      );
    // Omitted outside detail preserves all prior groups and their clocks.
    if (input.outsideGroups !== undefined) await client.query(
      `DELETE FROM public.atx_candidate_finance_outside_groups WHERE link_id=$1::uuid AND election_year=$2`,
      [linkId, year],
    );
    // Plain inserts: the aggregator already groups per (spender identity,
    // direction) — a unique-key collision here is a caller bug and should
    // abort the snapshot, not be papered over.
    for (const group of input.outsideGroups ?? [])
      await client.query(
        `INSERT INTO public.atx_candidate_finance_outside_groups (link_id,election_year,spender_key,spender_name,support_oppose,amount,source_url,last_synced_at) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::timestamptz)`,
        [
          linkId,
          year,
          keyOf(group.spenderName, "spender name"),
          text(group.spenderName, "spender name"),
          group.supportOppose,
          centsToDollars(group.amountCents, "outside amount"),
          optional(group.sourceUrl),
          syncedAt,
        ],
      );
    for (const row of input.outsideGroupBreakdowns ?? [])
      await client.query(
        `INSERT INTO public.atx_candidate_finance_outside_group_breakdowns (link_id,election_year,spender_key,support_oppose,category_type,category_name,amount,contributor_count,source_url,last_synced_at) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz)`,
        [
          linkId,
          year,
          keyOf(row.spenderName, "spender name"),
          row.supportOppose,
          row.categoryType,
          text(row.categoryName, "category name"),
          centsToDollars(row.amountCents, "outside breakdown amount"),
          count(row.contributorCount, "contributor count"),
          optional(row.sourceUrl),
          syncedAt,
        ],
      );
    if (cash) {
      await client.query(`INSERT INTO public.atx_candidate_finance_pac_sources
        (link_id,election_year,amount_cents,contribution_count,group_count,reported_through,observed_at)
        VALUES ($1::uuid,$2,$3::bigint,$4,$5,$6::date,$7::timestamptz)
        ON CONFLICT (link_id,election_year) DO UPDATE SET amount_cents=EXCLUDED.amount_cents,
          contribution_count=EXCLUDED.contribution_count,group_count=EXCLUDED.group_count,
          reported_through=EXCLUDED.reported_through,observed_at=EXCLUDED.observed_at`,
      [linkId, year, String(cash.amountCents), cash.contributionCount, cash.donors.length, cash.reportedThrough, syncedAt]);
      await client.query(`DELETE FROM public.atx_candidate_finance_pac_donors WHERE link_id=$1::uuid AND election_year=$2`, [linkId, year]);
      for (const donor of cash.donors) await client.query(`INSERT INTO public.atx_candidate_finance_pac_donors
        (link_id,election_year,committee_key,committee_name,amount_cents,contribution_count)
        VALUES ($1::uuid,$2,$3,$4,$5::bigint,$6)`,
      [linkId, year, donor.committeeKey, donor.committeeName, String(donor.amountCents), donor.contributionCount]);
    }
    for (const classification of input.classifications ?? [])
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
