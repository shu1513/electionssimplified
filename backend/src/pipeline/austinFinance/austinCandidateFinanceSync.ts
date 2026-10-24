// Phase 3 per-candidate sync: pulls one linked filer's cycle money from the
// City of Austin Socrata datasets, proves the plan's composition rules
// against the live rows, and writes one all-or-nothing snapshot.
//
// Fail-closed contract (the SF/SJ/Denver pattern): every health-check
// failure THROWS before replaceAustinCandidateFinanceSnapshot is called, so
// the prior snapshot survives untouched. A filer whose reports affirmatively
// say "$0 raised, $0 spent" writes a zero snapshot: "the source says
// nothing" and "the source is broken" are different outcomes.
//
// Checks proven on every sync:
//   1. The filer still has an effective report for THIS election date and
//      office code (a filer whose rows moved to another seat, or a Socrata
//      outage returning nothing, keeps the prior snapshot).
//   2. Per cycle report, the itemized contribution rows never exceed the
//      cover `contrib_total`, and reported contributions come with itemized
//      rows (inside the direct aggregator).
//   3. The DCE and Committee Purpose datasets returned rows at all — an
//      empty dataset would silently zero every candidate's outside spending.
//   4. Previous-vs-new receipts drop bound (the SF constants).
// Cash on hand = `contrib_balance` of the latest cycle report.
//
// Phase 3b: every attributed outside group also gets funder breakdowns —
// entity donors from the spender's own receipts inside the same window
// (austinPacFunderAggregator) plus industry rows from the shared label
// classifier (rules + cached manual verdicts; an AI classifier is injectable
// but never wired by default). A funder fetch failure fails the candidate
// closed like every other source failure.

import type { Pool, PoolClient } from "pg";

import {
  classifyFinanceLabel,
  normalizeFinanceLabel,
  type FinanceLabelClassification,
} from "../finance/financeLabelClassifier.js";
import {
  financeClassificationKey,
  mergeFinanceLabelClassification,
  resolveFinanceIndustryClassifications,
  type FinanceIndustryClassifier,
} from "../finance/financeIndustryClassificationService.js";
import { aggregateAustinDirectFinance } from "./austinDirectFinanceAggregator.js";
import {
  aggregateAustinOutsideSpending,
  type AustinReportFacts,
} from "./austinOutsideSpendingAggregator.js";
import {
  aggregateAustinPacFunders,
  type AustinPacFunderDonor,
} from "./austinPacFunderAggregator.js";
import { AUSTIN_FINANCE_LINK_SOURCE_URL } from "./austinCandidateFinanceAutoLink.js";
import {
  isAustinFinanceSupportedElectionDate,
  type AustinOfficeCode,
} from "./austinFinanceEligibleOffices.js";
import { normalizeAustinFinanceTextKey } from "./austinFinanceKeys.js";
import {
  replaceAustinCandidateFinanceSnapshot,
  type AustinOutsideGroupBreakdownInput,
} from "./austinFinanceWriter.js";
import {
  defaultAustinSocrataClientOptions,
  getAustinCommitteePurposeRows,
  getAustinContributionRowsByRecipient,
  getAustinContributionRowsByRecipientBetween,
  getAustinDirectCampaignExpenditureRows,
  getAustinReportDetailRowsByFiler,
  getAustinReportDetailRowsByReportIds,
  requireIsoDate,
  type AustinCommitteePurposeRow,
  type AustinContributionRow,
  type AustinDirectCampaignExpenditureRow,
  type AustinSocrataClientOptions,
} from "./austinSocrataClient.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type PoolLike = Queryable & { connect: () => Promise<PoolClient> };

// Anomaly bound, the SF constants: an order-of-magnitude receipts drop on a
// re-sync aborts the write; floored at $1,000 stored so micro-campaigns
// cannot trip it on rounding noise.
const ANOMALY_MIN_STORED_CENTS = 100_000;
const ANOMALY_DROP_FACTOR = 10;

// PAC funder breakdowns (Phase 3b). Donor display rows per (spender,
// direction) are capped like Houston's; classification and the industry
// totals always see every donor. The AI threshold is in DOLLARS (the shared
// service's unit) and only matters when a classifier is injected — none is
// by default, so classification is rules + the shared cache table.
const MAX_DONOR_BREAKDOWNS_PER_GROUP = 50;
const DEFAULT_AI_MIN_AMOUNT_DOLLARS = 25_000;

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

/**
 * The two small city-wide datasets plus the Report Detail facts (form type,
 * period) of every report they reference, fetched once per batch run.
 */
export type AustinOutsideDatasets = {
  dceRows: AustinDirectCampaignExpenditureRow[];
  purposeRows: AustinCommitteePurposeRow[];
  reportsById: Map<string, AustinReportFacts>;
};

export async function loadAustinOutsideDatasets(
  options: AustinSocrataClientOptions = defaultAustinSocrataClientOptions(),
): Promise<AustinOutsideDatasets> {
  const dceRows = await getAustinDirectCampaignExpenditureRows(options);
  const purposeRows = await getAustinCommitteePurposeRows(options);
  // Check 3: both datasets hold hundreds of rows; an empty answer is a
  // broken source, not a city with no outside spending.
  if (dceRows.length === 0)
    throw new Error("Austin Direct Campaign Expenditures dataset returned no rows; refusing to zero outside spending");
  if (purposeRows.length === 0)
    throw new Error("Austin Committee Purpose dataset returned no rows; refusing to zero outside spending");
  const reportIds = [
    ...dceRows.map((row) => row.reportId),
    ...purposeRows.flatMap((row) => (row.reportId === null ? [] : [row.reportId])),
  ];
  const reports = await getAustinReportDetailRowsByReportIds(reportIds, options);
  // Report Detail covers filings from 2023 on; every live DCE/purpose report
  // resolves today (182/182 on 2026-08-19). Zero hits for hundreds of ids is
  // a broken join, not a gap.
  if (reports.length === 0)
    throw new Error(`Austin Report Detail returned no rows for ${new Set(reportIds).size} referenced PAC reports; refusing to aggregate outside spending`);
  const reportsById = new Map<string, AustinReportFacts>();
  for (const report of reports)
    reportsById.set(report.reportId, {
      formTypeCode: report.formTypeCode,
      periodFrom: report.periodFrom,
      periodTo: report.periodTo,
      dateFiled: report.dateFiled,
    });
  return { dceRows, purposeRows, reportsById };
}

/** One outside spender's receipt rows plus the report facts behind them. */
export type AustinPacReceipts = {
  contributions: AustinContributionRow[];
  reportsById: Map<string, AustinReportFacts>;
};

/**
 * Contributions received by one outside spender inside the cycle window
 * (`recipient` = the DCE `paid_by` spelling — verified live: the two
 * datasets share the filer's exact name), plus the spender's COMPLETE
 * Report Detail picture by `filer_name`, not just the reports behind the
 * rows: a correction that deleted every receipt of its period has no rows
 * to reference it, and it must still supersede (PR #770 review). Fetched
 * per attributed spender; the row lists are small (a payroll-deduction PAC
 * would not be, which is why the fetch is window-bounded server-side).
 *
 * Fail-closed: a receipt row on a report the filer query cannot see means
 * the two datasets disagree about the spender's name — refuse to aggregate
 * rather than skip the correction rule for that row (live 2026-08-19: all
 * six DCE spenders with receipts resolve every row's report by filer).
 */
export async function loadAustinPacReceipts(
  input: { spenderName: string; windowFrom: string; windowTo: string },
  options: AustinSocrataClientOptions = defaultAustinSocrataClientOptions(),
): Promise<AustinPacReceipts> {
  const contributions = await getAustinContributionRowsByRecipientBetween(
    { recipient: input.spenderName, fromDate: input.windowFrom, toDate: input.windowTo },
    options,
  );
  const reports = await getAustinReportDetailRowsByFiler(input.spenderName, options);
  const reportsById = new Map<string, AustinReportFacts>();
  for (const report of reports)
    if (!reportsById.has(report.reportId))
      reportsById.set(report.reportId, {
        formTypeCode: report.formTypeCode,
        periodFrom: report.periodFrom,
        periodTo: report.periodTo,
        dateFiled: report.dateFiled,
      });
  const missing = [...new Set(contributions.map((row) => row.reportId))].filter(
    (id) => !reportsById.has(id),
  );
  if (missing.length > 0)
    throw new Error(
      `Austin spender ${JSON.stringify(input.spenderName)} has receipt rows on reports its filer name cannot see (${missing.join(", ")}); refusing to aggregate funders`,
    );
  return { contributions, reportsById };
}

/**
 * Donor + industry rows for one outside group. Donor display rows are
 * capped, industry totals are summed over EVERY donor in integer cents (the
 * shared build helper works in float dollars, so the sums live here) — and
 * every industry row keeps at least its top donor persisted even past the
 * cap: the shared read side shows an industry's evidence ONLY from persisted
 * donor rows, so an industry made entirely of tail donors would otherwise
 * render with no named evidence (PR #770 review). `donors` must be sorted
 * amount-descending (the funder aggregator's contract).
 */
export function buildAustinPacFunderBreakdownRows(input: {
  spenderName: string;
  supportOppose: "support" | "oppose";
  donors: readonly AustinPacFunderDonor[];
  classifications: ReadonlyMap<string, FinanceLabelClassification>;
}): AustinOutsideGroupBreakdownInput[] {
  const industries = new Map<
    string,
    { amountCents: number; donorCount: number; topDonor: AustinPacFunderDonor }
  >();
  for (const donor of input.donors) {
    const classification = input.classifications.get(
      financeClassificationKey("donor", normalizeFinanceLabel(donor.donorName, "donor")),
    );
    if (!classification?.industrySlug) continue;
    // First donor seen per slug is its largest (amount-descending input).
    const current = industries.get(classification.industrySlug) ?? {
      amountCents: 0,
      donorCount: 0,
      topDonor: donor,
    };
    current.amountCents += donor.amountCents;
    current.donorCount += 1;
    industries.set(classification.industrySlug, current);
  }
  const displayedDonors = input.donors.slice(0, MAX_DONOR_BREAKDOWNS_PER_GROUP);
  const displayedKeys = new Set(displayedDonors.map((donor) => donor.donorKey));
  for (const { topDonor } of industries.values())
    if (!displayedKeys.has(topDonor.donorKey)) {
      displayedDonors.push(topDonor);
      displayedKeys.add(topDonor.donorKey);
    }
  return [
    ...displayedDonors.map((donor) => ({
      spenderName: input.spenderName,
      supportOppose: input.supportOppose,
      categoryType: "donor" as const,
      categoryName: donor.donorName,
      amountCents: donor.amountCents,
      contributorCount: 1,
      sourceUrl: AUSTIN_FINANCE_LINK_SOURCE_URL,
    })),
    ...[...industries]
      .sort((a, b) => b[1].amountCents - a[1].amountCents || a[0].localeCompare(b[0]))
      .map(([slug, value]) => ({
        spenderName: input.spenderName,
        supportOppose: input.supportOppose,
        categoryType: "industry" as const,
        categoryName: slug,
        amountCents: value.amountCents,
        contributorCount: value.donorCount,
        sourceUrl: AUSTIN_FINANCE_LINK_SOURCE_URL,
      })),
  ];
}

export type AustinCandidateFinanceSyncResult = {
  written: boolean;
  reportedCommitteeCashGroupCount: number;
  reportedCommitteeCashCents: number;
  reportedCommitteeCashGiftCount: number;
  outsideComponentPreserved: boolean;
  totalRaisedCents: number;
  totalSpentCents: number;
  cashOnHandCents: number | null;
  outsideSupportCents: number;
  outsideOpposeCents: number;
  directBreakdownCount: number;
  outsideGroupCount: number;
  cycleReportCount: number;
  keptSpecialReportCount: number;
  itemizedRowCount: number;
  nonReceiptRowCount: number;
  /** Reported on covers but not itemized on the schedule (Σ over cycle reports). */
  unitemizedCents: number;
  /** ISO window the outside spending was scoped to. */
  outsideWindow: { from: string; to: string };
  /** Excluded outside dollars, by reason (see austinOutsideSpendingAggregator). */
  outsideMultiTargetCents: number;
  outsideUndirectedCents: number;
  outsideUndirectedSpenders: string[];
  outsideAmbiguousDirectionCents: number;
  outsideSelfCents: number;
  /** Donor + industry rows written under the outside groups (Phase 3b). */
  outsideGroupBreakdownCount: number;
  /** Entity donors behind those rows, across all groups (uncapped). */
  pacDonorCount: number;
  /** PAC receipts out of funder scope, across all groups: individuals... */
  pacIndividualCents: number;
  /** ...and entity money under PAC/committee-shaped names. */
  pacIneligibleOrgCents: number;
};

export async function syncAustinCandidateFinance(input: {
  db: PoolLike;
  candidateId: string;
  electionId: string;
  electionYear: number;
  candidateDisplayName: string;
  /** Link facts (office/filer identity stay the link's, not re-derived). */
  officeName: string;
  district: string | null;
  filerName: string;
  /** Election facts from the elections row (batch sync resolves them). */
  electionDate: string;
  officeCode: AustinOfficeCode;
  /** City-wide DCE + purpose rows, prefetched once per batch run. */
  outsideDatasets?: AustinOutsideDatasets;
  /** Operator override for the previous-vs-new drop bound only. */
  bypassAnomalyCheck?: boolean;
  /** AI industry classifier — never wired by default (aiCallGuard policy). */
  financeIndustryClassifier?: FinanceIndustryClassifier;
  /** Dollars a donor label must reach before the classifier sees it. */
  aiClassificationMinAmount?: number;
  /** Test seam for the per-spender receipts fetch. */
  loadPacReceiptsFn?: typeof loadAustinPacReceipts;
  dryRun?: boolean;
  now?: Date;
  clientOptions?: AustinSocrataClientOptions;
}): Promise<AustinCandidateFinanceSyncResult> {
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime()))
    throw new Error("Invalid Austin finance sync timestamp");
  const electionDate = requireIsoDate(input.electionDate, "election date");
  if (!isAustinFinanceSupportedElectionDate(electionDate))
    throw new Error(
      `Austin finance election date ${electionDate} is not in the v1 allowlist`,
    );
  const options = input.clientOptions ?? defaultAustinSocrataClientOptions();
  const filerName = input.filerName.trim();
  if (!filerName) throw new Error("Austin finance sync requires the link's filer name");

  // --- Direct money: every report and every itemized row under the exact
  // filer string, scoped to the cycle inside the aggregator (check 1 + 2).
  const reports = await getAustinReportDetailRowsByFiler(filerName, options);
  const contributions = await getAustinContributionRowsByRecipient(filerName, options);
  const direct = aggregateAustinDirectFinance({
    reports,
    contributions,
    filerName,
    electionDate,
    officeCode: input.officeCode,
  });

  // --- Outside spending, scoped to the span of the cycle's reports (the
  // Phase 0 window) extended through election day: DCE rows carry no
  // election tag, and the same candidate can run for the same seat in
  // consecutive cycles (Qadri D9 2022 and 2026), so the date window is what
  // separates cycles.
  // Every counted report carries a period by type (the selector ignores
  // period-less rows), and the aggregator has already thrown when the cycle
  // has no report at all — the guard below only defends that contract.
  const cycleReports = [...direct.cycleReports, ...direct.keptSpecialReports];
  const windowFrom = cycleReports.map((row) => row.periodFrom).sort()[0];
  const latestPeriodTo = cycleReports.map((row) => row.periodTo).sort().at(-1);
  if (windowFrom === undefined || latestPeriodTo === undefined)
    throw new Error(
      `Austin filer ${JSON.stringify(filerName)} has no cycle report period to scope outside spending by`,
    );
  const windowTo = latestPeriodTo > electionDate ? latestPeriodTo : electionDate;
  const datasets = input.outsideDatasets ?? (await loadAustinOutsideDatasets(options));
  const outside = aggregateAustinOutsideSpending({
    dceRows: datasets.dceRows,
    purposeRows: datasets.purposeRows,
    reportsById: datasets.reportsById,
    candidateDisplayName: input.candidateDisplayName,
    filerName,
    officeCode: input.officeCode,
    electionDate,
    windowFrom,
    windowTo,
  });

  // An empty qualified subset with unresolved candidate payments cannot
  // replace previous outside evidence or claim a new financial zero.
  const preserveOutside = outside.groups.length === 0 && (outside.multiTargetCents !== 0 ||
    outside.undirectedCents !== 0 || outside.ambiguousDirectionCents !== 0 || outside.rowsWithoutSpender > 0);

  // --- Previous-vs-new drop bound (baseline = this filer's active link).
  const filerKey = normalizeAustinFinanceTextKey(filerName);
  const stored = await input.db.query<{ total_receipts: string | null }>(
    `SELECT summary.total_receipts::text FROM public.atx_candidate_finance_summaries summary JOIN public.atx_candidate_finance_links link ON link.id=summary.link_id WHERE link.candidate_id=$1::uuid AND link.election_id=$2::uuid AND summary.election_year=$3 AND link.link_status='active' AND link.filer_key=$4`,
    [input.candidateId, input.electionId, input.electionYear, filerKey],
  );
  const storedReceiptsCents = dollarsTextToCents(
    stored.rows[0]?.total_receipts ?? null,
  );
  if (
    !input.bypassAnomalyCheck &&
    storedReceiptsCents !== null &&
    storedReceiptsCents >= ANOMALY_MIN_STORED_CENTS &&
    direct.totalRaisedCents < storedReceiptsCents / ANOMALY_DROP_FACTOR
  )
    throw new Error(
      `Austin total receipts collapsed for filer ${JSON.stringify(filerName)}: ${usd(storedReceiptsCents)} -> ${usd(direct.totalRaisedCents)} (pass bypassAnomalyCheck to override)`,
    );

  const directBreakdowns = direct.breakdowns.map((row) => ({
    ...row,
    sourceUrl: AUSTIN_FINANCE_LINK_SOURCE_URL,
  }));
  const outsideGroups = outside.groups.map((group) => ({
    ...group,
    sourceUrl: AUSTIN_FINANCE_LINK_SOURCE_URL,
  }));

  // --- PAC funder breakdowns (Phase 3b): who gave to each attributed
  // spender inside the same window. Donor rows are the industry evidence
  // the shared read side joins on; industry rows are its top-5 display.
  const loadPacReceipts = input.loadPacReceiptsFn ?? loadAustinPacReceipts;
  const classifications = new Map<string, FinanceLabelClassification>();
  const fundersByGroup: {
    group: (typeof outside.groups)[number];
    donors: ReturnType<typeof aggregateAustinPacFunders>["donors"];
  }[] = [];
  let pacIndividualCents = 0;
  let pacIneligibleOrgCents = 0;
  for (const group of outside.groups) {
    const receipts = await loadPacReceipts(
      { spenderName: group.spenderName, windowFrom, windowTo },
      options,
    );
    const funders = aggregateAustinPacFunders({
      contributions: receipts.contributions,
      reportsById: receipts.reportsById,
      windowFrom,
      windowTo,
    });
    pacIndividualCents += funders.individualCents;
    pacIneligibleOrgCents += funders.ineligibleOrgCents;
    fundersByGroup.push({ group, donors: funders.donors });
    for (const donor of funders.donors)
      mergeFinanceLabelClassification(
        classifications,
        classifyFinanceLabel({ rawLabel: donor.donorName, labelType: "donor" }),
      );
  }
  // Cached manual/AI verdicts outrank the fresh rule results (skipped on dry
  // runs — the service's own contract); the classifier is normally absent.
  await resolveFinanceIndustryClassifications({
    db: input.db,
    directBreakdowns: [],
    outsideBreakdowns: fundersByGroup.flatMap(({ group, donors }) =>
      donors.map((donor) => ({
        committeeId: normalizeAustinFinanceTextKey(group.spenderName),
        supportOppose: group.supportOppose,
        categoryType: "donor",
        categoryName: donor.donorName,
        amount: donor.amountCents / 100,
      })),
    ),
    classifications,
    classifier: input.financeIndustryClassifier,
    minAmount: input.aiClassificationMinAmount ?? DEFAULT_AI_MIN_AMOUNT_DOLLARS,
    dryRun: input.dryRun === true,
  });
  const outsideGroupBreakdowns: AustinOutsideGroupBreakdownInput[] = [];
  let pacDonorCount = 0;
  for (const { group, donors } of fundersByGroup) {
    pacDonorCount += donors.length;
    outsideGroupBreakdowns.push(
      ...buildAustinPacFunderBreakdownRows({
        spenderName: group.spenderName,
        supportOppose: group.supportOppose,
        donors,
        classifications,
      }),
    );
  }

  if (!input.dryRun)
    await replaceAustinCandidateFinanceSnapshot({
      db: input.db,
      link: {
        candidateId: input.candidateId,
        electionId: input.electionId,
        electionYear: input.electionYear,
        candidateNameNormalized: normalizeAustinFinanceTextKey(
          input.candidateDisplayName,
        ),
        officeName: input.officeName,
        district: input.district,
        filerName,
        linkStatus: "active",
        // Always the automatic source: on a protected manual link with this
        // filer the writer refreshes filer_name + last_verified_at only and
        // the snapshot attaches to the operator's row (Phase 1 contract).
        linkSource: "austin_clerk",
        sourceUrl: AUSTIN_FINANCE_LINK_SOURCE_URL,
        lastVerifiedAt: now,
      },
      summary: {
        totalReceiptsCents: direct.totalRaisedCents,
        directContributionTotalCents: direct.totalRaisedCents,
        totalDisbursementsCents: direct.totalSpentCents,
        cashOnHandCents: direct.cashOnHandCents,
        outsideSupportCents: preserveOutside ? undefined : outside.supportTotalCents,
        outsideOpposeCents: preserveOutside ? undefined : outside.opposeTotalCents,
        sourceUrl: AUSTIN_FINANCE_LINK_SOURCE_URL,
      },
      directBreakdowns,
      outsideGroups: preserveOutside ? undefined : outsideGroups,
      outsideGroupBreakdowns: preserveOutside ? undefined : outsideGroupBreakdowns,
      reportedCommitteeCash: direct.reportedCommitteeCash,
      // Only classifications worth caching (the Houston filter): a resolved
      // slug, or a non-unknown source recording a deliberate verdict.
      classifications: [...classifications.values()].filter(
        (classification) =>
          Boolean(classification.normalizedLabel) &&
          (classification.industrySlug !== null ||
            classification.classificationSource !== "unknown") &&
          financeClassificationKey(
            classification.labelType,
            classification.normalizedLabel,
          ).length > 1,
      ),
      syncedAt: now,
    });

  return {
    written: !input.dryRun,
    reportedCommitteeCashGroupCount: direct.reportedCommitteeCash.donors.length,
    reportedCommitteeCashCents: direct.reportedCommitteeCash.amountCents,
    reportedCommitteeCashGiftCount: direct.reportedCommitteeCash.contributionCount,
    outsideComponentPreserved: preserveOutside,
    totalRaisedCents: direct.totalRaisedCents,
    totalSpentCents: direct.totalSpentCents,
    cashOnHandCents: direct.cashOnHandCents,
    outsideSupportCents: outside.supportTotalCents,
    outsideOpposeCents: outside.opposeTotalCents,
    directBreakdownCount: directBreakdowns.length,
    outsideGroupCount: outsideGroups.length,
    cycleReportCount: direct.cycleReports.length,
    keptSpecialReportCount: direct.keptSpecialReports.length,
    itemizedRowCount: direct.itemizedRowCount,
    nonReceiptRowCount: direct.nonReceiptRowCount,
    unitemizedCents: direct.unitemizedCents,
    outsideWindow: { from: windowFrom, to: windowTo },
    outsideMultiTargetCents: outside.multiTargetCents,
    outsideUndirectedCents: outside.undirectedCents,
    outsideUndirectedSpenders: outside.undirectedSpenders,
    outsideAmbiguousDirectionCents: outside.ambiguousDirectionCents,
    outsideSelfCents: outside.selfCents,
    outsideGroupBreakdownCount: outsideGroupBreakdowns.length,
    pacDonorCount,
    pacIndividualCents,
    pacIneligibleOrgCents,
  };
}
