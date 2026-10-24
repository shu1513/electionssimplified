import type { DenverReportedCommitteeCash } from "./denverReportedCommitteeCash.js";
import { normalizeDenverTextKey } from "./denverCandidateCommitteeResolver.js";
// Link writes and the all-or-nothing snapshot writer (plan Phase 1). Copy of
// the San José writer's semantics — one active link per (candidate,
// election); a manual active link is protected (a matching automatic link
// reuses it, a conflicting one errors); an active upsert deactivates other
// automatic links first — over the standard five-table column shape, because
// Phase 3 reads through standardStateFinanceBallotLookupLoader /
// standardStateFinanceDueListQuery as-is.
//
// Denver identity: filer_id (SearchLight's stable filer number) plus the
// mutable committee entity ids from api/Filer/filer/{id}. Entity ids are API
// facts, not operator judgment, so a matching automatic write refreshes them
// even on a protected manual link — the Phase 3 transaction-feed row filter
// (every row's entity id must be in this set) breaks if they go stale.
//
// Snapshot semantics: the caller stages every component and calls
// replaceDenverCandidateFinanceSnapshot only when all of them passed
// source-health checks — the write is one transaction, so a summary can
// never coexist with breakdowns or outside groups from a different as-of.
// Source unavailable → the caller does not call this at all and the prior
// snapshot survives untouched; source affirmatively reports no qualifying
// data → the caller passes zero totals and empty arrays and the
// delete-and-insert clears the stale detail rows (outside-group deletes
// cascade into the v1-empty outside_group_breakdowns table).

import type { Pool, PoolClient } from "pg";

type Queryable = Pick<Pool | PoolClient, "query">;
type PoolLike = Queryable & { connect: () => Promise<PoolClient> };

export type DenverFinanceLinkInput = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  candidateNameNormalized: string;
  officeName: string;
  district?: string | null;
  /** SearchLight filerId — the canonical stable identity, e.g. 658. */
  filerId: number;
  /** Committee entity ids from the Filer endpoint; never empty. */
  committeeEntityIds: readonly number[];
  committeeName: string;
  linkStatus?: "active" | "needs_review" | "inactive";
  linkSource?: "manual" | "searchlight";
  sourceUrl?: string | null;
  lastVerifiedAt?: Date | null;
};

// All snapshot amounts arrive as integer cents (the aggregators' unit) and
// are converted to exact dollar strings at the database boundary.
export type DenverFinanceSummaryInput = {
  /** All cycle receipts: donor money + candidate loans + FEF matching. */
  totalReceiptsCents: number | null;
  /** Donor money only (Monetary + In-Kind) — the published raised figure. */
  directContributionTotalCents: number | null;
  /** getExpendituresTotalByCommittee — already includes FEF-funded spending. */
  totalDisbursementsCents: number | null;
  /** Signed balance — Johnston's 2023 year-end legitimately closes negative. */
  cashOnHandCents: number | null;
  /** `Loan` subtype: candidate self-funding, inside receipts, outside raised. */
  loansReceivedCents: number | null;
  /** `Fair Elections Payments`: city matching, inside receipts, outside raised. */
  publicFundsReceivedCents: number | null;
  outsideSupportCents: number | null;
  outsideOpposeCents: number | null;
  sourceUrl: string | null;
};

export type DenverDirectBreakdownInput = {
  categoryType: "occupation" | "contribution_size";
  categoryName: string;
  amountCents: number;
  contributorCount: number | null;
  sourceUrl?: string | null;
};

export type DenverOutsideGroupInput = {
  /** Resolved search uniqueId, e.g. "Ind787" — never a raw spender name. */
  spenderId: string;
  spenderName: string;
  supportOppose: "support" | "oppose";
  amountCents: number;
  sourceUrl?: string | null;
};

const text = (value: string, label: string): string => {
  const result = value.trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
};
const optional = (value: string | null | undefined): string | null =>
  value?.trim() || null;
const filerIdText = (value: number): string => {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error("Denver filer id must be a positive integer");
  return String(value);
};
const entityIds = (values: readonly number[]): number[] => {
  if (!values.length)
    throw new Error("Denver committee entity ids are required");
  for (const value of values)
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error("Denver committee entity ids must be positive integers");
  return [...values];
};
// The aggregated spender lists carry no id; the resolver derives the search
// uniqueId or fails the candidate closed. A raw name (or a non-IE uniqueId
// like "com658") landing here is a wiring bug — reject it before the schema
// CHECK turns it into an opaque constraint rollback.
const spenderIdText = (value: string): string => {
  const result = value.trim();
  if (!/^Ind[0-9]+$/.test(result))
    throw new Error(
      'Denver outside spender id must be a resolved "Ind…" uniqueId',
    );
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

export async function upsertDenverFinanceLink(input: {
  db: Queryable;
  link: DenverFinanceLinkInput;
}): Promise<{ linkId: string }> {
  const link = input.link;
  const linkStatus = link.linkStatus ?? "active";
  const linkSource = link.linkSource ?? "manual";
  const filerId = filerIdText(link.filerId);
  const committeeEntityIds = entityIds(link.committeeEntityIds);
  // Manual protection applies to EVERY automatic write, not only active
  // upserts, and probes manual rows of ANY status: an operator-disabled
  // (inactive/needs_review) manual link with this filer id is the
  // ON CONFLICT target row, and the upsert would otherwise silently
  // resurrect it as active/searchlight.
  if (linkSource === "searchlight") {
    const manual = await input.db.query<{
      id: string;
      filer_id: string;
      link_status: string;
    }>(
      `SELECT id::text,filer_id,link_status FROM public.denver_candidate_finance_links WHERE candidate_id=$1::uuid AND election_id=$2::uuid AND link_source='manual'`,
      [link.candidateId, link.electionId],
    );
    const sameFiler = manual.rows.find((row) => row.filer_id === filerId);
    if (sameFiler) {
      if (sameFiler.link_status !== "active")
        throw new Error(
          "Denver automatic finance link matches an operator-disabled manual link",
        );
      // An exact filer match IS a SearchLight verification of the manual
      // link: refresh the mutable entity ids (API facts the row filter
      // depends on) and advance last_verified_at — and nothing else, the
      // row stays the operator's.
      await input.db.query(
        `UPDATE public.denver_candidate_finance_links SET committee_entity_ids=$2::int[],last_verified_at=COALESCE($3::timestamptz,last_verified_at) WHERE id=$1::uuid`,
        [
          sameFiler.id,
          committeeEntityIds,
          link.lastVerifiedAt?.toISOString() ?? null,
        ],
      );
      return { linkId: sameFiler.id };
    }
    // A disabled manual link with a DIFFERENT filer id does not block a new
    // automatic identity — the operator disabled that association, not the
    // candidate. Only an active manual link conflicts.
    if (manual.rows.some((row) => row.link_status === "active"))
      throw new Error(
        "Denver automatic finance link conflicts with protected manual link",
      );
  }
  if (linkStatus === "active")
    await input.db.query(
      `UPDATE public.denver_candidate_finance_links SET link_status='inactive' WHERE candidate_id=$1::uuid AND election_id=$2::uuid AND filer_id<>$3 AND link_status='active' AND link_source<>'manual'`,
      [link.candidateId, link.electionId, filerId],
    );
  // The DO UPDATE's WHERE is the DB-enforced backstop for the probe above:
  // the probe and this upsert are separate statements, so a manual row
  // created or disabled in between would otherwise be rewritten by an
  // unconditional DO UPDATE. Manual writes may update manual rows; an
  // automatic write against a manual target updates nothing, RETURNING
  // comes back empty, and the throw below aborts the write (same guard the
  // San José/San Diego writers carry).
  const result = await input.db.query<{ id: string }>(
    `INSERT INTO public.denver_candidate_finance_links (candidate_id,election_id,election_year,candidate_name_normalized,office_name,district,filer_id,committee_entity_ids,committee_name,link_status,link_source,source_url,last_verified_at) VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8::int[],$9,$10,$11,$12,$13::timestamptz) ON CONFLICT (candidate_id,election_id,filer_id) DO UPDATE SET election_year=EXCLUDED.election_year,candidate_name_normalized=EXCLUDED.candidate_name_normalized,office_name=EXCLUDED.office_name,district=EXCLUDED.district,committee_entity_ids=EXCLUDED.committee_entity_ids,committee_name=EXCLUDED.committee_name,link_status=EXCLUDED.link_status,link_source=EXCLUDED.link_source,source_url=EXCLUDED.source_url,last_verified_at=EXCLUDED.last_verified_at WHERE denver_candidate_finance_links.link_source<>'manual' OR EXCLUDED.link_source='manual' RETURNING id::text`,
    [
      text(link.candidateId, "candidate id"),
      text(link.electionId, "election id"),
      link.electionYear,
      text(link.candidateNameNormalized, "candidate name"),
      text(link.officeName, "office name"),
      optional(link.district),
      filerId,
      committeeEntityIds,
      text(link.committeeName, "committee name"),
      linkStatus,
      linkSource,
      optional(link.sourceUrl),
      link.lastVerifiedAt?.toISOString() ?? null,
    ],
  );
  if (!result.rows[0]?.id)
    throw new Error(
      "Denver finance link upsert wrote no row — blocked by a concurrent protected manual link",
    );
  return { linkId: result.rows[0].id };
}

/**
 * Writes one candidate's complete finance snapshot — link, summary, direct
 * breakdowns, and outside group amounts — in a single transaction. See the
 * header comment for the staging contract; any validation failure (negative
 * flow, blank name, unresolved spender id) rolls the whole snapshot back.
 */
export async function replaceDenverCandidateFinanceSnapshot(input: {
  db: PoolLike;
  link: DenverFinanceLinkInput;
  summary: DenverFinanceSummaryInput;
  directBreakdowns: readonly DenverDirectBreakdownInput[];
  outsideGroups: readonly DenverOutsideGroupInput[];
  reportedCommitteeCash?: DenverReportedCommitteeCash;
  syncedAt?: Date;
}): Promise<{ linkId: string }> {
  if (typeof input.db.connect !== "function")
    throw new Error("Denver finance snapshot writes require a Pool");
  const syncedAt = (input.syncedAt ?? new Date()).toISOString();
  const cash = input.reportedCommitteeCash;
  if (cash) {
    if (cash.donors.length > 0 && cash.transactionThrough === null) throw new Error("Denver committee cash requires transaction date evidence");
    if (cash.transactionThrough !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(cash.transactionThrough) ||
      !Number.isFinite(Date.parse(cash.transactionThrough)) || new Date(cash.transactionThrough).toISOString().slice(0, 10) !== cash.transactionThrough))
      throw new Error("Denver committee cash requires a valid transaction date");
    const keys = new Set<string>();
    let total = 0, gifts = 0;
    for (const donor of cash.donors) {
      if (!donor.committeeKey || donor.committeeKey !== normalizeDenverTextKey(donor.committeeName) || keys.has(donor.committeeKey) ||
        !Number.isSafeInteger(donor.amountCents) || donor.amountCents <= 0 ||
        !Number.isSafeInteger(donor.contributionCount) || donor.contributionCount <= 0)
        throw new Error("Denver committee cash has invalid reported groups");
      keys.add(donor.committeeKey); total += donor.amountCents; gifts += donor.contributionCount;
    }
    if (!Number.isSafeInteger(total) || !Number.isSafeInteger(gifts) || total !== cash.amountCents || gifts !== cash.contributionCount)
      throw new Error("Denver committee cash source counts and cents do not close");
  }
  const client = await input.db.connect();
  try {
    await client.query("BEGIN");
    const { linkId } = await upsertDenverFinanceLink({
      db: client,
      link: input.link,
    });
    const year = input.link.electionYear;
    // The link upsert holds its row lock until commit, serializing writers
    // before this full-precision source-clock comparison.
    if (cash) {
      const prior = await client.query<{ newer: boolean }>(`SELECT observed_at > $3::timestamptz newer
        FROM public.denver_candidate_finance_pac_sources WHERE link_id=$1::uuid AND election_year=$2 FOR UPDATE`,
      [linkId, year, syncedAt]);
      if (prior.rows.some(row => row.newer)) throw new Error("Denver older committee cash observation cannot replace a newer snapshot");
    }

    await client.query(
      `INSERT INTO public.denver_candidate_finance_summaries (link_id,election_year,total_receipts,direct_contribution_total,total_disbursements,cash_on_hand,loans_received,public_funds_received,outside_support_total,outside_oppose_total,source_url,last_synced_at) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz) ON CONFLICT (link_id,election_year) DO UPDATE SET total_receipts=EXCLUDED.total_receipts,direct_contribution_total=EXCLUDED.direct_contribution_total,total_disbursements=EXCLUDED.total_disbursements,cash_on_hand=EXCLUDED.cash_on_hand,loans_received=EXCLUDED.loans_received,public_funds_received=EXCLUDED.public_funds_received,outside_support_total=EXCLUDED.outside_support_total,outside_oppose_total=EXCLUDED.outside_oppose_total,source_url=EXCLUDED.source_url,last_synced_at=EXCLUDED.last_synced_at`,
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
        // Signed: a net-negative loan balance (repayments beyond draws in one
        // cycle) is a real feed outcome, same rule as the aggregator's sums.
        centsToDollars(input.summary.loansReceivedCents, "loans received", {
          allowNegative: true,
        }),
        centsToDollars(
          input.summary.publicFundsReceivedCents,
          "public funds received",
        ),
        centsToDollars(input.summary.outsideSupportCents, "outside support"),
        centsToDollars(input.summary.outsideOpposeCents, "outside oppose"),
        optional(input.summary.sourceUrl),
        syncedAt,
      ],
    );
    await client.query(
      `DELETE FROM public.denver_candidate_finance_direct_breakdowns WHERE link_id=$1::uuid AND election_year=$2`,
      [linkId, year],
    );
    for (const row of input.directBreakdowns)
      await client.query(
        `INSERT INTO public.denver_candidate_finance_direct_breakdowns (link_id,election_year,category_type,category_name,amount,contributor_count,source_url,last_synced_at) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::timestamptz)`,
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
    await client.query(
      `DELETE FROM public.denver_candidate_finance_outside_groups WHERE link_id=$1::uuid AND election_year=$2`,
      [linkId, year],
    );
    // Plain inserts: the aggregator already groups per (spender identity,
    // direction) — a unique-key collision here is a caller bug and should
    // abort the snapshot, not be papered over.
    for (const group of input.outsideGroups)
      await client.query(
        `INSERT INTO public.denver_candidate_finance_outside_groups (link_id,election_year,spender_id,spender_name,support_oppose,amount,source_url,last_synced_at) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::timestamptz)`,
        [
          linkId,
          year,
          spenderIdText(group.spenderId),
          text(group.spenderName, "spender name"),
          group.supportOppose,
          centsToDollars(group.amountCents, "outside amount"),
          optional(group.sourceUrl),
          syncedAt,
        ],
      );
    if (cash) {
      await client.query(`INSERT INTO public.denver_candidate_finance_pac_sources
        (link_id,election_year,amount_cents,contribution_count,group_count,transaction_through,observed_at)
        VALUES ($1::uuid,$2,$3::bigint,$4,$5,$6::date,$7::timestamptz)
        ON CONFLICT (link_id,election_year) DO UPDATE SET amount_cents=EXCLUDED.amount_cents,
          contribution_count=EXCLUDED.contribution_count,group_count=EXCLUDED.group_count,
          transaction_through=EXCLUDED.transaction_through,observed_at=EXCLUDED.observed_at`,
      [linkId, year, String(cash.amountCents), cash.contributionCount, cash.donors.length, cash.transactionThrough, syncedAt]);
      await client.query(`DELETE FROM public.denver_candidate_finance_pac_donors WHERE link_id=$1::uuid AND election_year=$2`, [linkId, year]);
      for (const donor of cash.donors) await client.query(`INSERT INTO public.denver_candidate_finance_pac_donors
        (link_id,election_year,committee_key,committee_name,amount_cents,contribution_count)
        VALUES ($1::uuid,$2,$3,$4,$5::bigint,$6)`,
      [linkId, year, donor.committeeKey, donor.committeeName, String(donor.amountCents), donor.contributionCount]);
    }
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
