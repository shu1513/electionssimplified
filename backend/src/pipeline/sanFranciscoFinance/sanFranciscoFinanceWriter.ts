// Link/relation writes (Phase 3) and the all-or-nothing snapshot writer
// (Phase 5). Upsert semantics mirror the Los Angeles writer: one active link
// per (candidate, election); a manual active link is protected — a matching
// automatic link reuses it, a conflicting one errors; an active upsert
// deactivates other automatic links first.
//
// Snapshot semantics (plan Phase 5): the caller stages every component and
// calls replaceSanFranciscoCandidateFinanceSnapshot only when all of them
// passed source-health checks — the write is one transaction, so a summary
// can never coexist with breakdowns or outside groups from a different
// as-of. Source unavailable → the caller does not call this at all and the
// prior snapshot survives untouched; source affirmatively reports no
// qualifying data → the caller passes zero totals and empty arrays and the
// delete-and-insert clears the stale detail rows.

import type { Pool, PoolClient } from "pg";
import type { FinanceLabelClassification } from "../finance/financeLabelClassifier.js";
import { upsertFinanceLabelClassification } from "../finance/financeIndustryClassificationService.js";
import type { SanFranciscoCommitteeCashPosition } from "./sanFranciscoCommitteeCashAggregator.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type PoolLike = Queryable & { connect: () => Promise<PoolClient> };

export type SanFranciscoFinanceLinkInput = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  candidateNameNormalized: string;
  contestCode: string;
  fppcId: string;
  filerNid: string;
  committeeName: string;
  linkStatus?: "active" | "needs_review" | "inactive";
  linkSource?: "manual" | "sfec_dashboard";
  sourceUrl?: string | null;
  lastVerifiedAt?: Date | null;
};

export type SanFranciscoOutsideCommitteeLinkInput = {
  /** Real FPPC id, or the resolver's synthetic "name:…" identity. */
  spenderFppcId: string;
  spenderName: string;
  supportOppose: "support" | "oppose";
  sourceUrl?: string | null;
};

// All snapshot amounts arrive as integer cents (the aggregators' unit) and
// are converted to exact dollar strings at the database boundary.
export type SanFranciscoFinanceSummaryInput = {
  /** Manifest funds figure — INCLUDES public-financing money (gate identity). */
  totalRaisedCents: number | null;
  /**
   * Donor contributions only (no loans, no public funds). The read path
   * prefers this for total_raised so "Raised" and "Public funds" stay
   * disjoint stats on the card; totalRaisedCents stays the reconciliation
   * figure matching the SFEC dashboard headline.
   */
  directContributionCents: number | null;
  totalSpentCents: number | null;
  cashOnHandCents: number | null;
  debtsOwedCents: number | null;
  loansReceivedCents: number | null;
  publicFundsReceivedCents: number | null;
  outsideSupportCents: number | null;
  outsideOpposeCents: number | null;
  methodologyVersion: string;
  sourceUrl: string | null;
  /** ISO date the balances are reported through (latest 460 period end). */
  reportedThrough: string | null;
};

export type SanFranciscoDirectBreakdownInput = {
  categoryType: "occupation" | "employer" | "industry" | "contribution_size";
  categoryName: string;
  amountCents: number;
  contributorCount: number | null;
  sourceUrl?: string | null;
};

export type SanFranciscoOutsideGroupInput = {
  /** Real FPPC id, or the resolver's synthetic "name:…" identity. */
  spenderFppcId: string;
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
// Exact cents → "dollars.cc" string; string arithmetic, never binary floats.
// Negative amounts throw: every stored figure is a nonnegative total (refunds
// are already netted inside the aggregates), and throwing aborts the snapshot
// transaction so the prior snapshot survives.
const centsToDollars = (cents: number | null, label: string): string | null => {
  if (cents === null) return null;
  if (!Number.isSafeInteger(cents))
    throw new Error(`${label} must be integer cents`);
  if (cents < 0) throw new Error(`${label} must be nonnegative`);
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
};

function signedCentsToDollars(cents: number): string {
  if (!Number.isSafeInteger(cents))
    throw new Error("committee cash must be integer cents");
  const magnitude = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.trunc(magnitude / 100)}.${String(magnitude % 100).padStart(2, "0")}`;
}

export async function upsertSanFranciscoFinanceLink(input: {
  db: Queryable;
  link: SanFranciscoFinanceLinkInput;
}): Promise<{ linkId: string }> {
  const link = input.link;
  const linkStatus = link.linkStatus ?? "active";
  const linkSource = link.linkSource ?? "manual";
  // The trimmed fppcId drives the manual-link comparison, the deactivation
  // predicate, and the INSERT alike — a padded input must match a stored id,
  // never slip past the probe and reach the stored row through ON CONFLICT.
  const fppcId = text(link.fppcId, "FPPC id");
  // Manual protection applies to EVERY automatic write, not only active
  // upserts, and probes manual rows of ANY status: an operator-disabled
  // (inactive/needs_review) manual link with this fppc_id is the
  // ON CONFLICT target row, and the upsert would otherwise silently
  // rewrite it to sfec_dashboard.
  if (linkSource === "sfec_dashboard") {
    const manual = await input.db.query<{
      id: string;
      fppc_id: string;
      link_status: string;
    }>(
      `SELECT id::text,fppc_id,link_status FROM public.sfc_candidate_finance_links WHERE candidate_id=$1::uuid AND election_id=$2::uuid AND link_source='manual'`,
      [link.candidateId, link.electionId],
    );
    const sameCommittee = manual.rows.find((row) => row.fppc_id === fppcId);
    if (sameCommittee) {
      if (sameCommittee.link_status !== "active")
        throw new Error(
          "San Francisco automatic finance link matches an operator-disabled manual link",
        );
      // An exact committee match IS a manifest verification of the manual
      // link, so advance last_verified_at (and nothing else — the row
      // stays the operator's). Without this the batch's stale-election
      // selector, which drives off active links' last_verified_at, would
      // treat the election as stale on every run forever.
      if (link.lastVerifiedAt)
        await input.db.query(
          `UPDATE public.sfc_candidate_finance_links SET last_verified_at=$2::timestamptz WHERE id=$1::uuid`,
          [sameCommittee.id, link.lastVerifiedAt.toISOString()],
        );
      return { linkId: sameCommittee.id };
    }
    // A disabled manual link with a DIFFERENT fppc_id does not block a new
    // automatic identity — the operator disabled that association, not the
    // candidate. Only an active manual link conflicts.
    if (manual.rows.some((row) => row.link_status === "active"))
      throw new Error(
        "San Francisco automatic finance link conflicts with protected manual link",
      );
  }
  if (linkStatus === "active")
    await input.db.query(
      `UPDATE public.sfc_candidate_finance_links SET link_status='inactive' WHERE candidate_id=$1::uuid AND election_id=$2::uuid AND fppc_id<>$3 AND link_status='active' AND link_source<>'manual'`,
      [link.candidateId, link.electionId, fppcId],
    );
  // The conflict guard is the race backstop: a row an operator flips to
  // manual between the probe and this statement blocks the update (no id
  // returned, the throw below aborts) instead of being rewritten.
  const result = await input.db.query<{ id: string }>(
    `INSERT INTO public.sfc_candidate_finance_links (candidate_id,election_id,election_year,candidate_name_normalized,contest_code,fppc_id,filer_nid,committee_name,link_status,link_source,source_url,last_verified_at) VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz) ON CONFLICT (candidate_id,election_id,fppc_id) DO UPDATE SET election_year=EXCLUDED.election_year,candidate_name_normalized=EXCLUDED.candidate_name_normalized,contest_code=EXCLUDED.contest_code,filer_nid=EXCLUDED.filer_nid,committee_name=EXCLUDED.committee_name,link_status=EXCLUDED.link_status,link_source=EXCLUDED.link_source,source_url=EXCLUDED.source_url,last_verified_at=EXCLUDED.last_verified_at WHERE sfc_candidate_finance_links.link_source<>'manual' OR EXCLUDED.link_source='manual' RETURNING id::text`,
    [
      text(link.candidateId, "candidate id"),
      text(link.electionId, "election id"),
      link.electionYear,
      text(link.candidateNameNormalized, "candidate name"),
      text(link.contestCode, "contest code"),
      fppcId,
      text(link.filerNid, "filer nid"),
      text(link.committeeName, "committee name"),
      linkStatus,
      linkSource,
      optional(link.sourceUrl),
      link.lastVerifiedAt?.toISOString() ?? null,
    ],
  );
  if (!result.rows[0]?.id)
    throw new Error(
      "San Francisco finance link upsert wrote no row — blocked by a concurrent protected manual link",
    );
  return { linkId: result.rows[0].id };
}

/**
 * Flags active automatic links of one election whose committee is no longer
 * in the manifest contest: needs_review, never deletion — the money history
 * is real, the disappearance needs a human eye (repo rollover, committee
 * re-registration, upstream edit). Manual links are never touched. Returns
 * the flagged link ids.
 */
export async function flagSanFranciscoFinanceLinksMissingFromManifest(input: {
  db: Queryable;
  electionId: string;
  presentFppcIds: readonly string[];
}): Promise<string[]> {
  const result = await input.db.query<{ id: string }>(
    `UPDATE public.sfc_candidate_finance_links SET link_status='needs_review' WHERE election_id=$1::uuid AND link_status='active' AND link_source='sfec_dashboard' AND NOT (fppc_id=ANY($2::text[])) RETURNING id::text`,
    [input.electionId, [...input.presentFppcIds]],
  );
  return result.rows.map((row) => row.id);
}

/**
 * Replaces one candidate's outside-spending relation rows for one election
 * with the manifest's current set (delete-and-insert; relations are identity
 * rows fully owned by the manifest snapshot). Callers wrap the batch in a
 * transaction when atomicity across candidates matters.
 */
export async function replaceSanFranciscoOutsideCommitteeLinks(input: {
  db: Queryable;
  candidateId: string;
  electionId: string;
  electionYear: number;
  relations: readonly SanFranciscoOutsideCommitteeLinkInput[];
  lastVerifiedAt: Date;
}): Promise<void> {
  await input.db.query(
    `DELETE FROM public.sfc_candidate_finance_outside_committee_links WHERE candidate_id=$1::uuid AND election_id=$2::uuid`,
    [input.candidateId, input.electionId],
  );
  for (const relation of input.relations)
    await input.db.query(
      // DO NOTHING: two id-less manifest entries can normalize to one
      // synthetic spender identity; the relation is identical, keep the first.
      `INSERT INTO public.sfc_candidate_finance_outside_committee_links (candidate_id,election_id,election_year,spender_fppc_id,spender_name,support_oppose,relation_source,source_url,last_verified_at) VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,'sfec_dashboard',$7,$8::timestamptz) ON CONFLICT (candidate_id,election_id,spender_fppc_id,support_oppose) DO NOTHING`,
      [
        input.candidateId,
        input.electionId,
        input.electionYear,
        text(relation.spenderFppcId, "spender FPPC id"),
        text(relation.spenderName, "spender name"),
        relation.supportOppose,
        optional(relation.sourceUrl),
        input.lastVerifiedAt.toISOString(),
      ],
    );
}

/**
 * Writes one candidate's complete finance snapshot — link, summary, direct
 * breakdowns, outside group amounts, and any industry-label classifications —
 * in a single transaction. See the header comment for the staging contract;
 * any validation failure (negative amount, blank name) rolls the whole
 * snapshot back.
 */
export async function replaceSanFranciscoCandidateFinanceSnapshot(input: {
  db: PoolLike;
  link: SanFranciscoFinanceLinkInput;
  summary: SanFranciscoFinanceSummaryInput;
  directBreakdowns: readonly SanFranciscoDirectBreakdownInput[];
  outsideGroups: readonly SanFranciscoOutsideGroupInput[];
  /** Omitted when acquisition/qualification failed; preserve previous rows. */
  committeeCash?: {
    positions: readonly SanFranciscoCommitteeCashPosition[];
    reportedThrough: string;
    sourceUrl: string;
  };
  classifications?: readonly FinanceLabelClassification[];
  syncedAt?: Date;
}): Promise<{ linkId: string }> {
  if (typeof input.db.connect !== "function")
    throw new Error("San Francisco finance snapshot writes require a Pool");
  const syncedAt = (input.syncedAt ?? new Date()).toISOString();
  const client = await input.db.connect();
  try {
    await client.query("BEGIN");
    // Serialize this candidate-election's snapshots before identity and
    // component replacement. A slower earlier fetch must not replace a
    // snapshot accepted by a newer run while acquisition was in progress.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
      `sfc-finance:${input.link.candidateId}:${input.link.electionId}`,
    ]);
    const previous = await client.query<{
      last_synced_at: string;
      reported_through: string | null;
    }>(
      `SELECT s.last_synced_at::text,s.reported_through::text FROM public.sfc_candidate_finance_summaries s JOIN public.sfc_candidate_finance_links l ON l.id=s.link_id WHERE l.candidate_id=$1::uuid AND l.election_id=$2::uuid AND l.fppc_id=$3 AND l.link_status='active' AND s.election_year=$4`,
      [
        input.link.candidateId,
        input.link.electionId,
        input.link.fppcId.trim(),
        input.link.electionYear,
      ],
    );
    for (const row of previous.rows) {
      if (
        Date.parse(row.last_synced_at) > Date.parse(syncedAt) ||
        (row.reported_through !== null &&
          (input.summary.reportedThrough === null ||
            row.reported_through > input.summary.reportedThrough))
      )
        throw new Error(
          "San Francisco finance snapshot would replace newer stored coverage",
        );
    }
    const { linkId } = await upsertSanFranciscoFinanceLink({
      db: client,
      link: input.link,
    });
    const year = input.link.electionYear;
    await client.query(
      `INSERT INTO public.sfc_candidate_finance_summaries (link_id,election_year,total_receipts,direct_contribution_total,total_disbursements,cash_on_hand,debts_owed,loans_received,public_funds_received,outside_support_total,outside_oppose_total,methodology_version,source_url,reported_through,last_synced_at) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::date,$15::timestamptz) ON CONFLICT (link_id,election_year) DO UPDATE SET total_receipts=EXCLUDED.total_receipts,direct_contribution_total=EXCLUDED.direct_contribution_total,total_disbursements=EXCLUDED.total_disbursements,cash_on_hand=EXCLUDED.cash_on_hand,debts_owed=EXCLUDED.debts_owed,loans_received=EXCLUDED.loans_received,public_funds_received=EXCLUDED.public_funds_received,outside_support_total=EXCLUDED.outside_support_total,outside_oppose_total=EXCLUDED.outside_oppose_total,methodology_version=EXCLUDED.methodology_version,source_url=EXCLUDED.source_url,reported_through=EXCLUDED.reported_through,last_synced_at=EXCLUDED.last_synced_at`,
      [
        linkId,
        year,
        centsToDollars(input.summary.totalRaisedCents, "total raised"),
        centsToDollars(
          input.summary.directContributionCents,
          "direct contributions",
        ),
        centsToDollars(input.summary.totalSpentCents, "total spent"),
        centsToDollars(input.summary.cashOnHandCents, "cash on hand"),
        centsToDollars(input.summary.debtsOwedCents, "debts owed"),
        centsToDollars(input.summary.loansReceivedCents, "loans received"),
        centsToDollars(input.summary.publicFundsReceivedCents, "public funds"),
        centsToDollars(input.summary.outsideSupportCents, "outside support"),
        centsToDollars(input.summary.outsideOpposeCents, "outside oppose"),
        text(input.summary.methodologyVersion, "methodology version"),
        optional(input.summary.sourceUrl),
        input.summary.reportedThrough,
        syncedAt,
      ],
    );
    await client.query(
      `DELETE FROM public.sfc_candidate_finance_direct_breakdowns WHERE link_id=$1::uuid AND election_year=$2`,
      [linkId, year],
    );
    for (const row of input.directBreakdowns)
      await client.query(
        `INSERT INTO public.sfc_candidate_finance_direct_breakdowns (link_id,election_year,category_type,category_name,amount,contributor_count,source_url,last_synced_at) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::timestamptz)`,
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
      `DELETE FROM public.sfc_candidate_finance_outside_groups WHERE link_id=$1::uuid AND election_year=$2`,
      [linkId, year],
    );
    // Plain inserts: the headline aggregator already groups per
    // (spender, direction), so a unique-key collision here is a caller bug
    // and should abort the snapshot, not be papered over.
    for (const group of input.outsideGroups)
      await client.query(
        `INSERT INTO public.sfc_candidate_finance_outside_groups (link_id,election_year,spender_fppc_id,spender_name,support_oppose,amount,source_url,last_synced_at) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::timestamptz)`,
        [
          linkId,
          year,
          text(group.spenderFppcId, "spender FPPC id"),
          text(group.spenderName, "spender name"),
          group.supportOppose,
          centsToDollars(group.amountCents, "outside amount"),
          optional(group.sourceUrl),
          syncedAt,
        ],
      );
    if (input.committeeCash !== undefined) {
      const cash = input.committeeCash;
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(cash.reportedThrough) ||
        new Date(`${cash.reportedThrough}T00:00:00Z`)
          .toISOString()
          .slice(0, 10) !== cash.reportedThrough
      )
        throw new Error(
          "Invalid San Francisco committee cash reported-through date",
        );
      const sourceUrl = text(cash.sourceUrl, "committee cash source URL");
      await client.query(
        `DELETE FROM public.sfc_candidate_finance_pac_donors WHERE link_id=$1::uuid AND election_year=$2`,
        [linkId, year],
      );
      for (const position of cash.positions) {
        if (
          !["COM", "SCC"].includes(position.sourceReportedClass) ||
          !Number.isSafeInteger(position.contributionCount) ||
          position.contributionCount < 0 ||
          position.reportedCommitteeIds.some(
            (id) => typeof id !== "string" || !id.trim(),
          )
        )
          throw new Error("Invalid San Francisco committee cash evidence");
        await client.query(
          `INSERT INTO public.sfc_candidate_finance_pac_donors (link_id,election_year,committee_id,committee_name,source_reported_class,reported_committee_ids,amount,contribution_count,source_url,reported_through,last_synced_at) VALUES ($1::uuid,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::date,$11::timestamptz)`,
          [
            linkId,
            year,
            text(position.committeeId, "committee cash key"),
            text(position.committeeName, "committee cash name"),
            position.sourceReportedClass,
            JSON.stringify(position.reportedCommitteeIds),
            signedCentsToDollars(position.amountCents),
            position.contributionCount,
            sourceUrl,
            cash.reportedThrough,
            syncedAt,
          ],
        );
      }
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
