import { aggregateDenverReportedCommitteeCash } from "./denverReportedCommitteeCash.js";
// Phase 3 per-candidate sync: pulls one linked filer's cycle money from
// SearchLight, proves the fixture-pinned composition rules against the live
// responses, and writes one all-or-nothing snapshot.
//
// Fail-closed contract (the SF/SJ pattern): every health-check failure THROWS
// before replaceDenverCandidateFinanceSnapshot is called, so the prior
// snapshot survives untouched. A committee that affirmatively reports zero
// activity (registered, no transactions yet — the expected cycle-36 state
// right after qualification) writes a zero snapshot: "the source says
// nothing" and "the source is broken" are different outcomes.
//
// Checks proven on every sync (fixture-pinned in Phase 0, loan identity
// verified live 2026-08-13 on Walker/Padgett cycle 26 — the overview's
// private figure INCLUDES candidate loans, getContributionsTotalByCommittee
// EXCLUDES them):
//   1. Feed reconciliation: the entity-filtered transaction sweep's
//      Monetary + In-Kind sum plus its Loan sum equals the overview's
//      private figure, and its Fair Elections Payments sum equals the
//      overview's FEF figure — cent exact, so the published receipts/direct
//      split is transaction-proven.
//   2. Endpoint composition: getContributionsTotalByCommittee = the sweep's
//      donor sum + FEF sum (the endpoint is loan-free on both sides).
//   3. Outside lists sum to the overview IE figures (inside the aggregator).
//   4. Identity: the registrant is still on the cycle list, the filer echoes
//      its id, and the registration committee is still on the filer's set.
// Cash on hand = closingBalance of the latest in-force period report for the
// cycle (Phase 0 findings 4-5); null when the committee has not filed one.
// The FEF disclosure is a source-level loader note, not a per-candidate
// column, so this sync computes no coverage note.

import type { Pool, PoolClient } from "pg";
import {
  getDenverCandidatesByElectionCycle,
  getDenverContributionsTotalCents,
  getDenverExpendituresTotalCents,
  getDenverFiler,
  getDenverFilingsByCommittee,
  getDenverFilingSummary,
  getDenverFinancialOverview,
  selectLatestDenverFilings,
  sweepDenverContributionTransactions,
  DENVER_SEARCHLIGHT_MAX_PAGE_SIZE,
  type DenverCycleCandidate,
  type DenverSearchlightClientOptions,
} from "./denverSearchlightClient.js";
import { aggregateDenverDirectContributions } from "./denverDirectFinanceAggregator.js";
import { aggregateDenverOutsideSpending } from "./denverOutsideSpendingAggregator.js";
import { DENVER_FINANCE_SOURCE_URL } from "./denverCandidateFinanceAutoLink.js";
import { normalizeDenverTextKey } from "./denverCandidateCommitteeResolver.js";
import { replaceDenverCandidateFinanceSnapshot } from "./denverFinanceWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type PoolLike = Queryable & { connect: () => Promise<PoolClient> };

// Anomaly bound, the SF constants: an order-of-magnitude receipts drop on a
// re-sync aborts the write; floored at $1,000 stored so micro-committees
// cannot trip it on rounding noise. Denver's standard-shape summaries carry
// no reported_through, so there is no filing-regression check — the drop
// bound is the only previous-vs-new gate.
const ANOMALY_MIN_STORED_CENTS = 100_000;
const ANOMALY_DROP_FACTOR = 10;

/** Exact "[-]dollars.cc" text (numeric(16,2)) into integer cents; null passes. */
function dollarsTextToCents(value: string | null): number | null {
  if (value === null) return null;
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error(`Unparseable stored dollar amount: ${value}`);
  const sign = match[1] === "-" ? -1 : 1;
  return (
    sign * (Number(match[2]) * 100 + Number((match[3] ?? "0").padEnd(2, "0")))
  );
}

function usd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export type DenverCandidateFinanceSyncResult = {
  written: boolean;
  /** Full receipts: donor contributions + candidate loans + FEF. */
  totalReceiptsCents: number;
  /** Donor money only (Monetary + In-Kind) — the published raised figure. */
  directContributionCents: number;
  fefFundingCents: number;
  /** Candidate loans (signed net) — inside receipts, outside raised. */
  loanCents: number;
  totalDisbursementsCents: number;
  cashOnHandCents: number | null;
  outsideSupportCents: number;
  outsideOpposeCents: number;
  reportedCommitteeCashGroupCount: number;
  reportedCommitteeCashCents: number;
  reportedCommitteeCashGiftCount: number;
  directBreakdownCount: number;
  outsideGroupCount: number;
  contributionRowCount: number;
  entityFilteredRowCount: number;
};

export async function syncDenverCandidateFinance(input: {
  db: PoolLike;
  candidateId: string;
  electionId: string;
  electionYear: number;
  candidateDisplayName: string;
  /** Link facts (office/committee identity stay the link's, not re-derived). */
  officeName: string;
  district: string | null;
  filerId: number;
  committeeName: string;
  electionCycleId: number;
  /** Cycle registration list, prefetched once per batch run. */
  cycleRegistrants?: readonly DenverCycleCandidate[];
  /** Operator override for the previous-vs-new drop bound only. */
  bypassAnomalyCheck?: boolean;
  dryRun?: boolean;
  now?: Date;
  clientOptions?: DenverSearchlightClientOptions;
}): Promise<DenverCandidateFinanceSyncResult> {
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime()))
    throw new Error("Invalid Denver finance sync timestamp");
  const options = input.clientOptions ?? {};
  const { filerId, electionCycleId } = input;

  // --- Identity. The transaction search filters by SearchLight's candidate
  // name string, so the registrant row supplies the name the feed knows; a
  // linked filer missing from the cycle list means the registration was
  // withdrawn or the source broke — either way, keep the prior snapshot.
  const registrants =
    input.cycleRegistrants ??
    (await getDenverCandidatesByElectionCycle(electionCycleId, options));
  const registrant = registrants.find((row) => row.filerId === filerId);
  if (!registrant)
    throw new Error(
      `Denver filer ${filerId} is no longer on the cycle ${electionCycleId} registration list; refusing to overwrite the prior snapshot`,
    );
  const filer = await getDenverFiler(filerId, options);
  if (filer.filerId !== filerId)
    throw new Error(
      `Denver filer endpoint echoes ${filer.filerId} for filer ${filerId}`,
    );
  if (!filer.committeeIds.includes(registrant.committeeId))
    throw new Error(
      `Denver registration committee ${registrant.committeeId} is not on filer ${filerId}'s committee list [${filer.committeeIds.join(", ")}]`,
    );
  const committeeEntityIds = filer.committeeIds;

  // --- Totals. The contributions endpoint EXCLUDES loans, the overview's
  // private figure INCLUDES them (verified live: Walker cycle 26), so full
  // receipts = overview private + FEF, and the endpoint is reconciled
  // loan-free against the feed below (check 2).
  const contributionsEndpointCents = await getDenverContributionsTotalCents(
    { filerId, electionCycleId },
    options,
  );
  const totalDisbursementsCents = await getDenverExpendituresTotalCents(
    { filerId, electionCycleId },
    options,
  );
  const overview = await getDenverFinancialOverview(
    { filerId, electionCycleId },
    options,
  );
  const totalReceiptsCents =
    overview.campaignContributionsToCandidateCents +
    overview.fairElectionsFundToCandidateCents;

  // --- Transaction sweep + feed reconciliation (check 1) + endpoint
  // composition (check 2). ---
  const sweep = await sweepDenverContributionTransactions(
    {
      candidateName: registrant.fullName,
      electionCycleIds: [electionCycleId],
    },
    { ...options, pageSize: DENVER_SEARCHLIGHT_MAX_PAGE_SIZE },
  );
  const direct = aggregateDenverDirectContributions({
    rows: sweep.rows,
    committeeEntityIds,
  });
  if (
    direct.directContributionCents + direct.loanCents !==
    overview.campaignContributionsToCandidateCents
  )
    throw new Error(
      `Denver direct-contribution feed sum ${usd(direct.directContributionCents)} + loans ${usd(direct.loanCents)} != overview private figure ${usd(overview.campaignContributionsToCandidateCents)} for filer ${filerId}`,
    );
  if (direct.fefFundingCents !== overview.fairElectionsFundToCandidateCents)
    throw new Error(
      `Denver FEF feed sum ${usd(direct.fefFundingCents)} != overview FEF figure ${usd(overview.fairElectionsFundToCandidateCents)} for filer ${filerId}`,
    );
  if (
    contributionsEndpointCents !==
    direct.directContributionCents + direct.fefFundingCents
  )
    throw new Error(
      `Denver receipts composition failed for filer ${filerId}: contributions endpoint ${usd(contributionsEndpointCents)} != feed donor sum ${usd(direct.directContributionCents)} + FEF ${usd(direct.fefFundingCents)}`,
    );

  const reportedCommitteeCash = aggregateDenverReportedCommitteeCash({ rows: sweep.rows, committeeEntityIds });

  // --- Outside spending (check 3 inside). ---
  const outside = await aggregateDenverOutsideSpending({
    filerId,
    electionCycleId,
    overview,
    options,
  });

  // --- Cash on hand: latest in-force period report for THIS cycle. The
  // filings endpoint is filer-scoped (every entity id returns the identical
  // set — Phase 0 finding 1), so query one entity id and filter by cycle.
  // Event-based filings (null period) are excluded before selection.
  const filings = (
    await getDenverFilingsByCommittee(
      { committeeEntityId: committeeEntityIds[0]! },
      options,
    )
  ).filter(
    (filing) =>
      filing.filerId === filerId &&
      filing.electionCycleId === electionCycleId &&
      filing.filingPeriodId !== null,
  );
  let cashOnHandCents: number | null = null;
  if (filings.length > 0) {
    const inForce = selectLatestDenverFilings(filings);
    const latest = inForce[inForce.length - 1]!;
    cashOnHandCents = (
      await getDenverFilingSummary(latest.filingId, options)
    ).closingBalanceCents;
  }

  // --- Previous-vs-new drop bound (baseline = this filer's active link). ---
  const stored = await input.db.query<{ total_receipts: string | null }>(
    `SELECT summary.total_receipts::text FROM public.denver_candidate_finance_summaries summary JOIN public.denver_candidate_finance_links link ON link.id=summary.link_id WHERE link.candidate_id=$1::uuid AND link.election_id=$2::uuid AND summary.election_year=$3 AND link.link_status='active' AND link.filer_id=$4`,
    [input.candidateId, input.electionId, input.electionYear, String(filerId)],
  );
  const storedReceiptsCents = dollarsTextToCents(
    stored.rows[0]?.total_receipts ?? null,
  );
  if (
    !input.bypassAnomalyCheck &&
    storedReceiptsCents !== null &&
    storedReceiptsCents >= ANOMALY_MIN_STORED_CENTS &&
    totalReceiptsCents < storedReceiptsCents / ANOMALY_DROP_FACTOR
  )
    throw new Error(
      `Denver total receipts collapsed for filer ${filerId}: ${usd(storedReceiptsCents)} -> ${usd(totalReceiptsCents)} (pass bypassAnomalyCheck to override)`,
    );

  const directBreakdowns = direct.breakdowns.map((row) => ({
    ...row,
    sourceUrl: DENVER_FINANCE_SOURCE_URL,
  }));
  const outsideGroups = outside.groups.map((group) => ({
    ...group,
    sourceUrl: DENVER_FINANCE_SOURCE_URL,
  }));

  if (!input.dryRun)
    await replaceDenverCandidateFinanceSnapshot({
      db: input.db,
      link: {
        candidateId: input.candidateId,
        electionId: input.electionId,
        electionYear: input.electionYear,
        candidateNameNormalized: normalizeDenverTextKey(
          input.candidateDisplayName,
        ),
        officeName: input.officeName,
        district: input.district,
        filerId,
        committeeEntityIds,
        committeeName: input.committeeName,
        linkStatus: "active",
        linkSource: "searchlight",
        sourceUrl: DENVER_FINANCE_SOURCE_URL,
        lastVerifiedAt: now,
      },
      summary: {
        totalReceiptsCents,
        // Donor money only: loans and FEF are published as their own stats
        // rather than folded into raised.
        directContributionTotalCents: direct.directContributionCents,
        totalDisbursementsCents,
        cashOnHandCents,
        loansReceivedCents: direct.loanCents,
        publicFundsReceivedCents: overview.fairElectionsFundToCandidateCents,
        outsideSupportCents: outside.supportTotalCents,
        outsideOpposeCents: outside.opposeTotalCents,
        sourceUrl: DENVER_FINANCE_SOURCE_URL,
      },
      directBreakdowns,
      outsideGroups,
      reportedCommitteeCash,
      syncedAt: now,
    });

  return {
    written: !input.dryRun,
    totalReceiptsCents,
    directContributionCents: direct.directContributionCents,
    fefFundingCents: overview.fairElectionsFundToCandidateCents,
    loanCents: direct.loanCents,
    totalDisbursementsCents,
    cashOnHandCents,
    outsideSupportCents: outside.supportTotalCents,
    outsideOpposeCents: outside.opposeTotalCents,
    reportedCommitteeCashGroupCount: reportedCommitteeCash.donors.length,
    reportedCommitteeCashCents: reportedCommitteeCash.amountCents,
    reportedCommitteeCashGiftCount: reportedCommitteeCash.contributionCount,
    directBreakdownCount: directBreakdowns.length,
    outsideGroupCount: outsideGroups.length,
    contributionRowCount: sweep.rows.length,
    entityFilteredRowCount: direct.entityFilteredRowCount,
  };
}
