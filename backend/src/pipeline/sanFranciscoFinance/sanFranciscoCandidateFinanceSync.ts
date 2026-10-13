import { getSanFranciscoCommitteePublicFunds } from "./sanFranciscoCommitteePublicFundsClient.js";
// Phase 6 per-candidate sync: manifest fetch, DataSF fetches, aggregation,
// deterministic + cached-manual industry classification (NO classifier is
// ever injected — SF finance sync performs zero AI calls; unresolved labels
// land in finance_label_classifications as 'unknown' rows, which is the
// manual industry-label due queue), source-health checks, then one
// all-or-nothing snapshot write.
//
// Fail-closed contract: every health-check failure THROWS before
// replaceSanFranciscoCandidateFinanceSnapshot is called, so the prior
// snapshot survives untouched. A source that affirmatively reports no
// qualifying data (zero-funds committee with no filings) writes a zero
// snapshot instead — "the source says nothing" and "the source is broken"
// are deliberately different outcomes.

import type { Pool, PoolClient } from "pg";
import {
  classifyFinanceLabel,
  type FinanceLabelClassification,
} from "../finance/financeLabelClassifier.js";
import {
  buildFinanceIndustryBreakdownsFromClassifications,
  mergeFinanceLabelClassification,
  resolveFinanceIndustryClassifications,
} from "../finance/financeIndustryClassificationService.js";
import {
  getSanFranciscoContestManifest,
  type SanFranciscoContestManifest,
  type SanFranciscoDashboardManifestClientOptions,
} from "./sanFranciscoDashboardManifestClient.js";
import {
  getSanFranciscoCommitteeCurrentForm460Filings,
  getSanFranciscoCommitteeItemizedTransactions,
  getSanFranciscoCommitteeSummaryRows,
  getSanFranciscoDatasetFreshness,
  getSanFranciscoPublicFundsApproved,
  moneyStringToCents,
  SAN_FRANCISCO_SUMMARY_TOTALS_DATASET_ID,
  SAN_FRANCISCO_TRANSACTIONS_DATASET_ID,
  type SanFranciscoDatasetFreshness,
  type SanFranciscoOpenDataClientOptions,
} from "./sanFranciscoOpenDataClient.js";
import {
  aggregateSanFranciscoDirectContributions,
  SAN_FRANCISCO_DIRECT_CONTRIBUTION_FORM_TYPES,
} from "./sanFranciscoDirectContributionAggregator.js";
import { aggregateSanFranciscoBalances } from "./sanFranciscoBalanceAggregator.js";
import { aggregateSanFranciscoHeadlineTotals } from "./sanFranciscoHeadlineTotals.js";
import { acquireSanFranciscoCommitteeCash } from "./sanFranciscoCommitteeCashAcquisition.js";
import type { SanFranciscoQualifiedCommitteeCash } from "./sanFranciscoCommitteeCashQualification.js";
import {
  matchSanFranciscoPublicFunds,
  sanFranciscoPublicFundsDistrictForContest,
} from "./sanFranciscoPublicFundsMatcher.js";
import { normalizeSanFranciscoCandidateNameForStorage } from "./sanFranciscoCandidateCommitteeResolver.js";
import {
  replaceSanFranciscoCandidateFinanceSnapshot,
  type SanFranciscoDirectBreakdownInput,
} from "./sanFranciscoFinanceWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type PoolLike = Queryable & { connect: () => Promise<PoolClient> };

/**
 * Recorded with every snapshot (Phase 0 decision). Bump when the proven
 * composition rules change — the formula itself lives on
 * sanFranciscoDirectContributionAggregator.ts and the balance/public-funds
 * modules, all gated by the Phase 4 entry gate.
 */
export const SAN_FRANCISCO_FINANCE_METHODOLOGY_VERSION = "sf-2026.1";

// DataSF refreshes nightly; the filings index itself lands a filing ~1 day
// after receipt and the summary/transactions extracts follow. A current
// e-filed Form 460 that is still absent from the summary dataset this many
// days after its filing date means the extract is stale or wedged for this
// committee — abort rather than write balances that ignore a known filing.
const FILING_INDEX_GRACE_DAYS = 5;
// A nightly pipeline whose newest data_loaded_at is older than this has
// stalled dataset-wide; writes would silently freeze on old data.
const MAX_DATASET_AGE_DAYS = 7;
// Anomaly bound: an order-of-magnitude drop in donor money on an unchanged
// filing set (same reported-through date) aborts the write. Floors at
// $1,000 stored so micro-committees cannot trip it on rounding noise.
const ANOMALY_MIN_STORED_CENTS = 100_000;
const ANOMALY_DROP_FACTOR = 10;
// Probe-proven transaction window: the committee's own filing periods
// widened by a month on both sides (SF committees are per-election, so full
// history stays one contest; the client requires explicit bounds).
const TRANSACTION_WINDOW_PAD_DAYS = 31;

const DAY_MS = 86_400_000;

/** Day-granularity UTC parse of "YYYY-MM-DD…" source timestamps. */
const dayMs = (value: string): number =>
  Date.parse(`${value.slice(0, 10)}T00:00:00.000Z`);

const shiftIsoDate = (isoDate: string, days: number): string =>
  new Date(dayMs(isoDate) + days * DAY_MS).toISOString().slice(0, 10);

export type SanFranciscoSourceFreshness = {
  summary: SanFranciscoDatasetFreshness;
  transactions: SanFranciscoDatasetFreshness;
};

/**
 * Dataset-level source health, checked once per run (the batch sync checks
 * once and threads the result through every candidate). Retains record upload
 * age and metadata checks; per-filing coverage is validated separately.
 * DataSF defines data_as_of as the date a record was added to its source,
 * not a shared extraction generation. Different form streams can have
 * different record-date maxima without an incomplete refresh.
 */
export async function checkSanFranciscoSourceFreshness(input: {
  now: Date;
  openDataClientOptions?: SanFranciscoOpenDataClientOptions;
}): Promise<SanFranciscoSourceFreshness> {
  const [summary, transactions] = await Promise.all([
    getSanFranciscoDatasetFreshness(
      SAN_FRANCISCO_SUMMARY_TOTALS_DATASET_ID,
      input.openDataClientOptions,
    ),
    getSanFranciscoDatasetFreshness(
      SAN_FRANCISCO_TRANSACTIONS_DATASET_ID,
      input.openDataClientOptions,
    ),
  ]);
  const describe = (
    label: string,
    freshness: SanFranciscoDatasetFreshness,
  ): void => {
    if (!freshness.dataAsOf || !freshness.dataLoadedAt)
      throw new Error(
        `San Francisco ${label} dataset reports no freshness metadata`,
      );
    const loadedMs = dayMs(freshness.dataLoadedAt);
    const asOfMs = dayMs(freshness.dataAsOf);
    if (Number.isNaN(loadedMs) || Number.isNaN(asOfMs))
      throw new Error(
        `San Francisco ${label} dataset has unparseable freshness metadata: ${freshness.dataAsOf} / ${freshness.dataLoadedAt}`,
      );
    if (input.now.getTime() - loadedMs > MAX_DATASET_AGE_DAYS * DAY_MS)
      throw new Error(
        `San Francisco ${label} dataset is stale: last loaded ${freshness.dataLoadedAt}`,
      );
  };
  describe("summary-totals", summary);
  describe("transactions", transactions);
  return { summary, transactions };
}

export type SanFranciscoCandidateFinanceSyncResult = {
  linkWritten: boolean;
  directBreakdownCount: number;
  outsideGroupCount: number;
  /** Manifest funds figure, cents — includes public-financing money. */
  totalRaisedCents: number;
  /** Donor money only: manifest funds minus matched public funds, cents. */
  directContributionCents: number;
  publicFundsStatus: "matched" | "none" | "no_program";
  publicFundsCents: number | null;
  /**
   * Manifest funds minus the raw-path reconstruction (itemized + unitemized
   * + line 2 + public funds), cents. Nonzero residuals are post-cutoff
   * timing or 497-only money (Phase 4 gate result); large ones are drift.
   */
  reconciliationDifferenceCents: number;
  form460Filings: number;
  reportedThrough: string | null;
  committeeCashStatus: "qualified" | "unavailable";
  committeeCashPositionCount: number;
  committeeCashTotalCents: number | null;
  committeeCashError?: string;
};

export async function syncSanFranciscoCandidateFinance(input: {
  db: PoolLike;
  candidateId: string;
  electionId: string;
  electionYear: number;
  /** "YYYY-MM-DD" — manifest locator and public-funds key. */
  electionDate: string;
  contestCode: string;
  /** The linked controlled committee (active sfc_candidate_finance_links row). */
  fppcId: string;
  /** Batch-cached contest manifest; fetched when absent. */
  manifest?: SanFranciscoContestManifest;
  /** Batch-level freshness result; checked here when absent. */
  sourceFreshness?: SanFranciscoSourceFreshness;
  manifestClientOptions?: SanFranciscoDashboardManifestClientOptions;
  openDataClientOptions?: SanFranciscoOpenDataClientOptions;
  /** Operator override for the previous-vs-new anomaly bound only. */
  bypassAnomalyCheck?: boolean;
  dryRun?: boolean;
  now?: Date;
}): Promise<SanFranciscoCandidateFinanceSyncResult> {
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime()))
    throw new Error("Invalid San Francisco finance sync timestamp");
  const manifest =
    input.manifest ??
    (await getSanFranciscoContestManifest(
      { electionDate: input.electionDate, contestCode: input.contestCode },
      input.manifestClientOptions,
    ));
  // The committee left the manifest: the auto-link's wholesale election
  // refresh flags such links needs_review; until then, fail this candidate
  // loudly rather than write headline figures for a vanished committee.
  const manifestCandidate = manifest.candidates.find(
    (candidate) => candidate.fppcId === input.fppcId,
  );
  if (!manifestCandidate)
    throw new Error(
      `Linked San Francisco committee ${input.fppcId} is missing from the ${input.contestCode} manifest`,
    );
  const headline = aggregateSanFranciscoHeadlineTotals({
    manifest,
    candidate: manifestCandidate,
  });

  if (!input.sourceFreshness)
    await checkSanFranciscoSourceFreshness({
      now,
      openDataClientOptions: input.openDataClientOptions,
    });

  // --- Per-committee source health. ---
  const summaryRows = await getSanFranciscoCommitteeSummaryRows(
    { fppcId: input.fppcId },
    input.openDataClientOptions,
  );
  const unsyncedFilings = summaryRows
    .filter((row) => row.syncFlag !== true)
    .map((row) => row.filingIdNumber);
  if (unsyncedFilings.length > 0)
    throw new Error(
      `San Francisco summary filings for committee ${input.fppcId} are not transaction-synced (sync_flag): ${unsyncedFilings.join(", ")}`,
    );
  const indexRows = await getSanFranciscoCommitteeCurrentForm460Filings(
    { fppcId: input.fppcId },
    input.openDataClientOptions,
  );
  const summaryFilingNids = new Set(summaryRows.map((row) => row.filingNid));
  const coverageCutoff = shiftIsoDate(
    now.toISOString(),
    -FILING_INDEX_GRACE_DAYS,
  );
  // An uncovered chain with no filing_date cannot be grace-evaluated, so it
  // counts as missing — tolerating it would be a fail-open hole in this gate.
  const missingFilings = indexRows.filter(
    (row) =>
      !summaryFilingNids.has(row.filingNid) &&
      (row.filingDate === null || row.filingDate.slice(0, 10) < coverageCutoff),
  );
  if (missingFilings.length > 0)
    throw new Error(
      `San Francisco summary dataset is missing current Form 460 filings the filings index shows for committee ${input.fppcId}: ${missingFilings.map((row) => row.filingNid).join(", ")}`,
    );

  // --- Public funds (Mayor/Supervisor program only). ---
  const district = sanFranciscoPublicFundsDistrictForContest(input.contestCode);
  let publicFundsStatus: "matched" | "none" | "no_program" = "no_program";
  let publicFundsCents: number | null = null;
  let publicFundsApprovalCents: number[] = [];
  if (district !== null) {
    const publicFundsRows = await getSanFranciscoPublicFundsApproved(
      { electionDate: input.electionDate, district },
      input.openDataClientOptions,
    );
    const match = matchSanFranciscoPublicFunds({
      rows: publicFundsRows,
      candidateName: manifestCandidate.candidateName,
      district,
    });
    // A wrong public-funds figure is worse than none — and with the funds
    // identity (manifest funds includes public money) a missing figure
    // would corrupt direct_contribution_total too, so ambiguity aborts.
    if (match.status === "ambiguous")
      throw new Error(
        `San Francisco public-funds match is ambiguous for ${manifestCandidate.candidateName} (district ${district}): ${match.matchedNames.join(" / ")}`,
      );
    publicFundsStatus = match.status;
    publicFundsCents = match.publicFundsCents;
    publicFundsApprovalCents = match.approvalCents;
  }

  // --- Balances and direct contributions. ---
  const balances = aggregateSanFranciscoBalances(summaryRows);
  const periodDates = summaryRows
    .flatMap((row) => [row.periodStart, row.periodEnd])
    .filter((value): value is string => value !== null)
    .map((value) => value.slice(0, 10))
    .sort();
  if (periodDates.length === 0 && manifestCandidate.fundsCents > 0)
    throw new Error(
      `San Francisco committee ${input.fppcId} has manifest funds but no filings in the summary dataset`,
    );
  const transactionRows =
    periodDates.length === 0
      ? []
      : await getSanFranciscoCommitteeItemizedTransactions(
          {
            fppcId: input.fppcId,
            formTypes: [...SAN_FRANCISCO_DIRECT_CONTRIBUTION_FORM_TYPES],
            transactionDateFrom: shiftIsoDate(
              periodDates[0]!,
              -TRANSACTION_WINDOW_PAD_DAYS,
            ),
            transactionDateTo: shiftIsoDate(
              periodDates[periodDates.length - 1]!,
              TRANSACTION_WINDOW_PAD_DAYS,
            ),
            // Schedule B1 loan rows are undated; without this the late-loan
            // exclusion could never fire.
            includeUndatedTransactions: true,
          },
          input.openDataClientOptions,
        );
  let direct = aggregateSanFranciscoDirectContributions({
    rows: transactionRows,
    publicFundsApprovalCents,
  });

  const line2Cents = summaryRows.reduce(
    (sum, row) => sum + (row.line2Cents ?? 0),
    0,
  );
  const contributionReconstruction = () =>
    direct.itemizedCents +
    direct.unitemizedCents +
    direct.unitemizedNonmonetaryCents +
    line2Cents;
  // An unmatched city disbursement can itself make the donor reconstruction
  // equal manifest funds. Equality is not proof that public financing is zero.
  const hasUnqualifiedCityLate = transactionRows.some(
    (row) =>
      row.formType === "F497P1" &&
      row.memoCode !== true &&
      (row.contributorLastName ?? "").toUpperCase().includes("CITY AND COUN"),
  );
  if (
    publicFundsStatus === "none" &&
    (manifestCandidate.fundsCents !== contributionReconstruction() ||
      hasUnqualifiedCityLate)
  ) {
    // The public approvals name can differ from the manifest person (actual Manny/Emanuel).
    // The official exact account publication binds public funds without guessing a nickname.
    const publication = await getSanFranciscoCommitteePublicFunds(
      {
        electionDate: input.electionDate,
        contestCode: input.contestCode,
        candidate: manifestCandidate,
      },
      input.manifestClientOptions,
    );
    const qualifiedDirect = aggregateSanFranciscoDirectContributions({
      rows: transactionRows,
      publicFundsApprovalCents: [publication.publicFundsCents],
    });
    const qualifiedContributions =
      qualifiedDirect.itemizedCents +
      qualifiedDirect.unitemizedCents +
      qualifiedDirect.unitemizedNonmonetaryCents +
      line2Cents;
    if (
      publication.contributionCents !== qualifiedContributions ||
      publication.expenditureCents !== manifestCandidate.expensesCents ||
      manifestCandidate.fundsCents !==
        publication.contributionCents + publication.publicFundsCents
    )
      throw new Error(
        "San Francisco exact-account public-funds publication does not reconcile with source contributions and manifest",
      );
    direct = qualifiedDirect;
    publicFundsStatus = "matched";
    publicFundsCents = publication.publicFundsCents;
    publicFundsApprovalCents = [publication.publicFundsCents];
  }
  // Donor money excludes exact source-qualified public funding; never infer a name alias.
  const directContributionCents =
    manifestCandidate.fundsCents - (publicFundsCents ?? 0);
  if (directContributionCents < 0)
    throw new Error(
      `San Francisco public funds exceed manifest funds for committee ${input.fppcId}`,
    );
  const reconciliationDifferenceCents =
    manifestCandidate.fundsCents -
    (contributionReconstruction() + (publicFundsCents ?? 0));
  const reportedThrough = balances.latestFilingPeriodEnd?.slice(0, 10) ?? null;

  // --- Previous-vs-new anomaly bounds. ---
  // Baseline = the snapshot previously written for THIS committee's active
  // link only: deactivated links from an earlier relink keep their summary
  // rows, and comparing against another committee's totals would both
  // false-abort valid syncs and mask real collapses. A relink therefore
  // starts with no baseline, which is correct — different committee,
  // legitimately different totals.
  const stored = await input.db.query<{
    direct_contribution_total: string | null;
    reported_through: string | null;
  }>(
    `SELECT summary.direct_contribution_total::text,summary.reported_through::text reported_through FROM public.sfc_candidate_finance_summaries summary JOIN public.sfc_candidate_finance_links link ON link.id=summary.link_id WHERE link.candidate_id=$1::uuid AND link.election_id=$2::uuid AND summary.election_year=$3 AND link.link_status='active' AND link.fppc_id=$4`,
    [input.candidateId, input.electionId, input.electionYear, input.fppcId],
  );
  const storedRow = stored.rows[0];
  const storedReportedThrough = storedRow?.reported_through ?? null;
  if (storedReportedThrough !== null) {
    // Filing history never shrinks: a snapshot reported through a LATER
    // date than today's latest filing means the summary dataset lost
    // filings — abort. Deliberately NOT overridable by bypassAnomalyCheck:
    // that flag covers the drop bound only, and a true regression is a
    // source catastrophe no sync should write through.
    if (reportedThrough === null || reportedThrough < storedReportedThrough)
      throw new Error(
        `San Francisco filing history went backwards for committee ${input.fppcId}: stored through ${storedReportedThrough}, now ${reportedThrough ?? "no filings"}`,
      );
    const storedDirectCents = moneyStringToCents(
      storedRow?.direct_contribution_total,
    );
    if (
      !input.bypassAnomalyCheck &&
      storedDirectCents !== null &&
      storedDirectCents >= ANOMALY_MIN_STORED_CENTS &&
      reportedThrough === storedReportedThrough &&
      directContributionCents < storedDirectCents / ANOMALY_DROP_FACTOR
    )
      throw new Error(
        `San Francisco direct-contribution total collapsed on an unchanged filing set for committee ${input.fppcId}: ${storedDirectCents} -> ${directContributionCents} cents (pass bypassAnomalyCheck to override)`,
      );
  }

  // --- Deterministic + cached-manual industry classification only. ---
  // No classifier parameter exists on purpose: SF finance sync makes zero
  // AI calls. Unknown results persist through the snapshot write and form
  // the manual industry-label due queue.
  //
  // Industries derive from the aggregator's TOP-20 employer rows — the Los
  // Angeles semantics, kept identical on purpose. The resulting industry
  // rows are stored-only enrichment in this card path (direct industries
  // are deliberately not displayed, see the Phase 8 plan note), and the
  // top-20 bound keeps the manual-classification queue focused on labels
  // big enough to matter; widening to the full employer map is a product
  // decision to take for LA and SF together, not an SF-only divergence.
  const classifications = new Map<string, FinanceLabelClassification>();
  const employerRows = direct.breakdowns.filter(
    (row) => row.categoryType === "employer",
  );
  for (const row of employerRows)
    mergeFinanceLabelClassification(
      classifications,
      classifyFinanceLabel({
        rawLabel: row.categoryName,
        labelType: "employer",
      }),
    );
  // Amounts stay integer cents through the unit-agnostic service; the AI
  // threshold is irrelevant with no classifier.
  const classifiableEmployerRows = employerRows.map((row) => ({
    categoryType: row.categoryType,
    categoryName: row.categoryName,
    amount: row.amountCents,
    contributorCount: row.contributorCount,
  }));
  await resolveFinanceIndustryClassifications({
    db: input.db,
    directBreakdowns: classifiableEmployerRows,
    outsideBreakdowns: [],
    classifications,
    classifier: undefined,
    minAmount: 0,
    dryRun: Boolean(input.dryRun),
  });
  const industryCents = new Map<string, { cents: number; count: number }>();
  for (const row of buildFinanceIndustryBreakdownsFromClassifications({
    directBreakdowns: classifiableEmployerRows,
    outsideBreakdowns: [],
    classifications,
  }).directIndustryBreakdowns) {
    const current = industryCents.get(row.categoryName) ?? {
      cents: 0,
      count: 0,
    };
    current.cents += row.amount;
    current.count += row.contributorCount ?? 0;
    industryCents.set(row.categoryName, current);
  }
  const directBreakdowns: SanFranciscoDirectBreakdownInput[] = [
    ...direct.breakdowns.map((row) => ({
      categoryType: row.categoryType,
      categoryName: row.categoryName,
      amountCents: row.amountCents,
      contributorCount: row.contributorCount,
    })),
    ...[...industryCents]
      .sort((a, b) => b[1].cents - a[1].cents || a[0].localeCompare(b[0]))
      .map(([categoryName, value]) => ({
        categoryType: "industry" as const,
        categoryName,
        amountCents: value.cents,
        contributorCount: value.count,
      })),
  ];

  // Named cash qualification is independent of the established headline/IE
  // path. Unavailable or ambiguous named evidence preserves prior positions.
  let committeeCash: SanFranciscoQualifiedCommitteeCash | undefined;
  let committeeCashError: string | undefined;
  try {
    committeeCash = await acquireSanFranciscoCommitteeCash({
      fppcId: input.fppcId,
      electionYear: input.electionYear,
      expectedSummaryRows: summaryRows,
      options: input.openDataClientOptions,
    });
  } catch (error) {
    committeeCashError =
      error instanceof Error
        ? error.message
        : "SF committee cash acquisition failed";
  }

  if (!input.dryRun)
    await replaceSanFranciscoCandidateFinanceSnapshot({
      db: input.db,
      link: {
        candidateId: input.candidateId,
        electionId: input.electionId,
        electionYear: input.electionYear,
        candidateNameNormalized: normalizeSanFranciscoCandidateNameForStorage(
          manifestCandidate.candidateName,
        ),
        contestCode: input.contestCode,
        fppcId: manifestCandidate.fppcId,
        filerNid: manifestCandidate.filerNid,
        committeeName: manifestCandidate.committeeName,
        linkStatus: "active",
        linkSource: "sfec_dashboard",
        sourceUrl: manifest.sourceUrl,
        lastVerifiedAt: now,
      },
      summary: {
        totalRaisedCents: manifestCandidate.fundsCents,
        directContributionCents,
        totalSpentCents: manifestCandidate.expensesCents,
        cashOnHandCents: balances.cashOnHandCents,
        debtsOwedCents: balances.debtsOwedCents,
        loansReceivedCents: balances.loansReceivedCents,
        publicFundsReceivedCents: publicFundsCents,
        outsideSupportCents: headline.outsideSupportCents,
        outsideOpposeCents: headline.outsideOpposeCents,
        methodologyVersion: SAN_FRANCISCO_FINANCE_METHODOLOGY_VERSION,
        sourceUrl: manifest.sourceUrl,
        reportedThrough,
      },
      directBreakdowns,
      outsideGroups: headline.groups.map((group) => ({
        spenderFppcId: group.spenderId,
        spenderName: group.spenderName,
        supportOppose: group.supportOppose,
        amountCents: group.amountCents,
        sourceUrl: group.sourceUrl,
      })),
      classifications: [...classifications.values()],
      ...(committeeCash
        ? {
            committeeCash: {
              positions: committeeCash.positions,
              reportedThrough: committeeCash.windowEnd,
              sourceUrl: "https://data.sfgov.org/d/pitq-e56w",
            },
          }
        : {}),
      syncedAt: now,
    });

  return {
    linkWritten: !input.dryRun,
    directBreakdownCount: directBreakdowns.length,
    outsideGroupCount: headline.groups.length,
    totalRaisedCents: manifestCandidate.fundsCents,
    directContributionCents,
    publicFundsStatus,
    publicFundsCents,
    committeeCashStatus: committeeCash ? "qualified" : "unavailable",
    committeeCashPositionCount: committeeCash?.positions.length ?? 0,
    committeeCashTotalCents: committeeCash?.totalAmountCents ?? null,
    ...(committeeCashError ? { committeeCashError } : {}),
    reconciliationDifferenceCents,
    form460Filings: balances.form460Filings,
    reportedThrough,
  };
}
