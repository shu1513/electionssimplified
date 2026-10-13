// Kansas per-candidate finance sync (docs/plans/plan-kansas-finance.md, Phase 4 step 3).
// The link is the input (auto-link or an operator wrote it). This builds the
// candidate's period ledger from the live SOS CFR viewer with the canonical
// reports' Schedules A and B, adds the transcribed covers of its paper
// versions (kansasPaperCoverOverrides.ts), aggregates
// (kansasDirectContributionAggregator), and replaces the snapshot. Any
// failure throws so the prior snapshot survives (the plan's "retain
// last-good snapshot on refresh failure"): a link that no longer resolves,
// an incomplete ledger, a paper version with no transcribed cover, a cover
// or schedule that does not reconcile, or a negative figure.
//
// What is written:
//   total_receipts            = sum of cover line 2 (contributions and other receipts)
//   direct_contribution_total = line 2 + line 6 (in-kind) - Schedule A Loan/Refund
//                               rows; null when a counted cover came without
//                               schedules (the loan share is then unknown)
//   total_disbursements       = sum of cover line 4
//   cash_on_hand              = line 5 of the latest canonical report (null when negative)
//   direct breakdowns         = occupation + contribution_size buckets (dollars only)
// A cycle with no filed report writes a summary with null figures (the
// candidate is synced — nothing is reported — and drops out of the due
// list), never $0. In-kind is a contribution but not a receipt, so the
// direct total can exceed total receipts.
//
// Outside leg (Phase 5): only accepted transcribed rows replace outside
// figures/groups. Missing, quarantined, shared or unavailable evidence preserves
// the prior component. A loader failure does not block valid direct totals.
// The existing direct ownership/completeness gate still runs first.

import type { Pool, PoolClient } from "pg";

import { KANSAS_CFR_LINK_SOURCE_URL } from "./kansasCandidateFinanceAutoLink.js";
import { buildKansasCandidateLedger } from "./kansasCandidateLedger.js";
import type { KansasCfrSessionOptions } from "./kansasCfrViewerClient.js";
import {
  aggregateKansasDirectFinance,
  type KansasDirectFinance,
  type KansasItemizedContributions,
} from "./kansasDirectContributionAggregator.js";
import { createKansasFilingPoolLoader, type KansasFilingPoolLoader } from "./kansasFilingSearch.js";
import { kansasCfrOfficeForRace } from "./kansasFinanceEligibleOffices.js";
import {
  normalizeKansasFilerKey,
  normalizeKansasNameForStorage,
  replaceKansasCandidateFinanceSnapshot,
  type KansasFinanceLinkSource,
  type KansasFinanceSnapshotWriteResult,
  type KansasFinanceSnapshotInput,
} from "./kansasFinanceWriter.js";
import {
  aggregateKansasOutsideSpending,
  createKansasOutsideRowLoader,
  type KansasOutsideRowLoader,
} from "./kansasOutsideSpendingAggregator.js";
import {
  kansasPaperCoverOverridesToCovers,
  loadKansasPaperCoverOverrides,
  type KansasPaperCoverLoader,
} from "./kansasPaperCoverOverrides.js";
import { createKansasKpdcRowLoader, type KansasKpdcRowLoader } from "./kansasPaperInventory.js";
import { kansasReportingPeriods, type KansasPeriodStatus } from "./kansasReportInventory.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & { connect: () => Promise<PoolClient> };

export class KansasCandidateFinanceSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KansasCandidateFinanceSyncError";
  }
}

export type KansasCandidateFinanceSyncInput = {
  db: ConnectableQueryable;
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district?: string | null;
  link: {
    /** The viewer search recipe (ks_candidate_finance_links.committee_id). */
    committeeId: string;
    committeeName: string;
    linkSource: KansasFinanceLinkSource;
    sourceUrl?: string | null;
  };
  now?: Date;
  dryRun?: boolean;
  maxOccupationBreakdowns?: number;
  sessionOptions?: KansasCfrSessionOptions;
  /** Memoized per-office enumeration; a batch shares one across every candidate. */
  loadFilingPool?: KansasFilingPoolLoader;
  /** Memoized KPDC candidate trees (paper rows); a batch shares one. */
  loadKpdcRows?: KansasKpdcRowLoader;
  /** Transcribed paper covers (ks_candidate_finance_paper_covers); consulted only when the viewer shows paper rows. Defaults to `db`. */
  loadPaperCovers?: KansasPaperCoverLoader;
  /** Transcribed IE rows of the cycle (ks_candidate_finance_outside_rows); a batch shares one memoized loader. Defaults to `db`. */
  loadOutsideRows?: KansasOutsideRowLoader;
  buildLedger?: typeof buildKansasCandidateLedger;
};

export type KansasOutsideSpendingSummary =
  | { status: "unavailable"; reasons: string[] }
  | { status: "none_found" }
  | { status: "unpublishable"; reasons: string[] }
  | { status: "partial_unallocated"; reasons: string[] }
  | { status: "ok"; supportTotal: number; opposeTotal: number; groupCount: number; statementCount: number };

export type KansasCandidateFinanceSyncResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  dryRun: boolean;
  /** "no_filed_report": every period accounted for, none by a report — null figures written. */
  status: "synced" | "no_filed_report";
  committeeId: string;
  /** Period key -> ledger status, cycle order. */
  periods: Record<string, KansasPeriodStatus>;
  totalReceipts: number | null;
  directContributionTotal: number | null;
  totalDisbursements: number | null;
  cashOnHand: number | null;
  /** Coverage in cents (the aggregator's itemized figures without the buckets); null when no schedules were read. */
  coverage: Omit<KansasItemizedContributions, "breakdowns"> | null;
  breakdownCounts: { occupation: number; contribution_size: number };
  diagnostics: string[];
  /** Outside leg: the transcribed IE rows naming this recipe. */
  outside: KansasOutsideSpendingSummary;
  summaryWritten: boolean;
  directBreakdownsWritten: number;
  outsideGroupsWritten: number;
};

function requireNonEmpty(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new KansasCandidateFinanceSyncError(`${fieldName} is required`);
  return trimmed;
}

function dollars(cents: number, fieldName: string): number {
  // The summaries table pins every amount >= 0; a negative sum is an
  // evidence problem to look at, not a number to publish.
  if (!Number.isSafeInteger(cents)) throw new KansasCandidateFinanceSyncError(`${fieldName} is not an integer cent amount`);
  if (cents < 0) throw new KansasCandidateFinanceSyncError(`${fieldName} is negative (${cents} cents)`);
  return cents / 100;
}

type KansasSnapshotFigures = {
  status: KansasCandidateFinanceSyncResult["status"];
  summary: { totalReceipts: number | null; directContributionTotal: number | null; totalDisbursements: number | null; cashOnHand: number | null };
  breakdowns: KansasItemizedContributions["breakdowns"];
  coverage: KansasCandidateFinanceSyncResult["coverage"];
  diagnostics: string[];
};

/** The publishable figures of an aggregate, or a thrown blocker. Pure. */
export function kansasSnapshotFigures(finance: KansasDirectFinance): KansasSnapshotFigures {
  if (finance.status === "unpublishable") {
    throw new KansasCandidateFinanceSyncError(`unpublishable: ${finance.reasons.join("; ")}`);
  }
  if (finance.status === "no_filed_report") {
    return {
      status: "no_filed_report",
      summary: { totalReceipts: null, directContributionTotal: null, totalDisbursements: null, cashOnHand: null },
      breakdowns: [],
      coverage: null,
      diagnostics: [],
    };
  }
  const { itemized } = finance;
  const coverage =
    itemized === null
      ? null
      : {
          contributionCents: itemized.contributionCents,
          occupationCoveredCents: itemized.occupationCoveredCents,
          unitemizedCents: itemized.unitemizedCents,
          nonContributionReceiptCents: itemized.nonContributionReceiptCents,
        };
  return {
    status: "synced",
    summary: {
      totalReceipts: dollars(finance.totalReceiptsCents, "total receipts"),
      directContributionTotal:
        itemized === null
          ? null
          : dollars(finance.totalReceiptsCents + finance.inKindCents - itemized.nonContributionReceiptCents, "direct contribution total"),
      totalDisbursements: dollars(finance.totalDisbursementsCents, "total disbursements"),
      cashOnHand: finance.cashOnHandCents === null ? null : dollars(finance.cashOnHandCents, "cash on hand"),
    },
    breakdowns: itemized?.breakdowns ?? [],
    coverage,
    diagnostics: [...finance.diagnostics, ...(itemized === null ? ["no breakdowns: direct contribution total not reported"] : [])],
  };
}

export async function syncKansasCandidateFinance(input: KansasCandidateFinanceSyncInput): Promise<KansasCandidateFinanceSyncResult> {
  const candidateId = requireNonEmpty(input.candidateId, "candidate id");
  const electionId = requireNonEmpty(input.electionId, "election id");
  const candidateName = requireNonEmpty(input.candidateName, "candidate name");
  const officeName = requireNonEmpty(input.officeName, "office name");
  const committeeName = requireNonEmpty(input.link.committeeName, "link committee name");
  if (!Number.isInteger(input.electionYear) || input.electionYear < 2024 || input.electionYear > 2100) {
    throw new KansasCandidateFinanceSyncError(`invalid election year: ${input.electionYear}`);
  }
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new KansasCandidateFinanceSyncError("invalid now");
  const dryRun = input.dryRun === true;
  const office = kansasCfrOfficeForRace({ officeScope: input.officeScope, officeCanonicalName: officeName });
  if (office === null) {
    throw new KansasCandidateFinanceSyncError(`office ${input.officeScope}::${officeName} is not Kansas-finance eligible`);
  }

  const buildLedger = input.buildLedger ?? buildKansasCandidateLedger;
  const ledger = await buildLedger({
    target: { committeeId: input.link.committeeId, committeeName, office, electionYear: input.electionYear },
    now,
    loadFilingPool: input.loadFilingPool ?? createKansasFilingPoolLoader({ now, sessionOptions: input.sessionOptions }),
    loadKpdcRows: input.loadKpdcRows ?? createKansasKpdcRowLoader(),
    openSchedules: true,
  });
  if (ledger.status !== "resolved") {
    throw new KansasCandidateFinanceSyncError(`link ${input.link.committeeId} does not resolve in the viewer: ${ledger.reason}`);
  }

  // A paper version has no viewer cover; a transcribed one stands in
  // (totals only). Loaded only when the ledger counts a paper version
  // (KPDC versions exist only for a candidate the viewer shows paper rows
  // for), and each transcribed filename must be a scan the tree lists for
  // this candidate — the header alone cannot tell whose scan it is.
  const recipe = normalizeKansasFilerKey(input.link.committeeId);
  const loadPaperCovers =
    input.loadPaperCovers ?? ((committeeId, electionYear) => loadKansasPaperCoverOverrides(input.db, committeeId, electionYear));
  const countsPaperVersion = ledger.ledger.entries.some((entry) => entry.canonical?.channel === "paper");
  const paperOverrides = countsPaperVersion ? await loadPaperCovers(recipe, input.electionYear) : [];
  const paperCovers = kansasPaperCoverOverridesToCovers({
    overrides: paperOverrides,
    periods: kansasReportingPeriods(office, input.electionYear),
    candidateFileNames: ledger.paper?.status === "resolved" ? ledger.paper.fileNames : [],
  });

  // The gate is the candidate's completeness (ledger AND every paper row explained), not the ledger's alone.
  const figures = kansasSnapshotFigures(
    aggregateKansasDirectFinance({
      ledger: { ...ledger.ledger, complete: ledger.complete },
      covers: [...ledger.reports, ...paperCovers],
      maxOccupationBreakdowns: input.maxOccupationBreakdowns,
    })
  );
  if (paperOverrides.length > 0) {
    figures.diagnostics.push(`transcribed paper covers: ${paperOverrides.map((override) => override.sourceFileName).join(", ")}`);
  }
  const sourceUrl = input.link.sourceUrl?.trim() || KANSAS_CFR_LINK_SOURCE_URL;

  // Direct ownership/completeness remains the gate at this foundation step.
  // A failure in the independent outside leg cannot erase its last-good data.
  const loadOutsideRows = input.loadOutsideRows ?? createKansasOutsideRowLoader(input.db);
  let outsideSummary: KansasOutsideSpendingSummary;
  let outsideGroups: KansasFinanceSnapshotInput["outsideGroups"];
  try {
    const outside = aggregateKansasOutsideSpending({ rows: await loadOutsideRows(input.electionYear), targetCommitteeId: recipe });
    outsideSummary = outside.status === "ok"
      ? {
          status: "ok",
          supportTotal: dollars(outside.supportCents, "outside support total"),
          opposeTotal: dollars(outside.opposeCents, "outside oppose total"),
          groupCount: outside.groups.length,
          statementCount: outside.statementCount,
        }
      : outside;
    outsideGroups = outside.status === "ok"
      ? outside.groups.map((group) => ({
          committeeId: group.committeeId,
          committeeName: group.committeeName,
          supportOppose: group.supportOppose,
          amount: dollars(group.amountCents, `outside group ${group.committeeName}`),
          sourceUrl: group.sourceUrl,
        }))
      : undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown outside source failure";
    outsideSummary = { status: "unavailable", reasons: [reason] };
    figures.diagnostics.push(`outside unavailable: ${reason}`);
  }

  let write: KansasFinanceSnapshotWriteResult | null = null;
  if (!dryRun) {
    write = await replaceKansasCandidateFinanceSnapshot({
      db: input.db,
      link: {
        candidateId,
        electionId,
        electionYear: input.electionYear,
        candidateNameNormalized: normalizeKansasNameForStorage(candidateName),
        officeName,
        district: input.district ?? null,
        committeeId: input.link.committeeId,
        committeeName,
        linkStatus: "active",
        linkSource: input.link.linkSource,
        sourceUrl,
        lastVerifiedAt: now,
      },
      syncedAt: now,
      summary: {
        ...figures.summary,
        ...(outsideSummary.status === "ok"
          ? { outsideSupportTotal: outsideSummary.supportTotal, outsideOpposeTotal: outsideSummary.opposeTotal }
          : {}),
        sourceUrl,
      },
      // Direct breakdowns keep their existing filed-data/zero semantics.
      directBreakdowns: figures.breakdowns.map((breakdown) => ({
        categoryType: breakdown.categoryType,
        categoryName: breakdown.categoryName,
        amount: breakdown.amountCents / 100,
        sourceUrl,
      })),
      outsideGroups,
    });
  }

  return {
    candidateId,
    electionId,
    electionYear: input.electionYear,
    dryRun,
    status: figures.status,
    committeeId: input.link.committeeId,
    periods: Object.fromEntries(ledger.ledger.entries.map((entry) => [entry.period.key, entry.status])),
    ...figures.summary,
    coverage: figures.coverage,
    breakdownCounts: {
      occupation: figures.breakdowns.filter((breakdown) => breakdown.categoryType === "occupation").length,
      contribution_size: figures.breakdowns.filter((breakdown) => breakdown.categoryType === "contribution_size").length,
    },
    diagnostics: figures.diagnostics,
    outside: outsideSummary,
    summaryWritten: write?.summaryWritten ?? false,
    directBreakdownsWritten: write?.directBreakdownsWritten ?? 0,
    outsideGroupsWritten: write?.outsideGroupsWritten ?? 0,
  };
}
