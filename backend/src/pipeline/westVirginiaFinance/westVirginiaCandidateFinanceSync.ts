// West Virginia per-candidate finance sync (plan Phase 1). CACHE-ONLY: it
// never touches the live portal — the refresh CLI (its own flag) fills the
// artifact cache. Every gate runs before anything is written and every gate
// fails closed, preserving the prior snapshot:
//   1. eligible office + valid entityId + Nov-2026-scope election year;
//   2. the candidacy window resolves from REPS cycle membership (fact 5);
//   3. every window year's contributions, expenditures and API artifacts are
//      cached and parse clean (a missing year is a missing year, never an
//      empty one);
//   4. per year, the committee's CSV rows and API rows reconcile cent-exact
//      and multiset-exact on (date, amount, category) — the committee-level
//      amendment evidence Phase 0 pinned (fact 3), re-proved on every run so
//      a CSV that ever starts carrying superseded versions stops publication;
//   5. no category / contributor-type / expenditure-type value outside the
//      pinned vocabulary.
// Unavailable outside acquisition preserves accepted spending; electronic IE
// and paper source coverage are separate from direct receipts.

import { resolve } from "node:path";

import type { Pool, PoolClient } from "pg";

import type { WestVirginiaCommitteeRow, WestVirginiaTransactionRow } from "./westVirginiaCfrsClient.js";
import {
  DEFAULT_WEST_VIRGINIA_CFRS_CACHE_DIR,
  readWestVirginiaApiContributionsArtifact,
  readWestVirginiaBulkArtifact,
} from "./westVirginiaCfrsArtifactCache.js";
import {
  parseWestVirginiaContributionCsv,
  parseWestVirginiaExpenditureCsv,
  parseWestVirginiaReportingScheduleCsv,
  type WestVirginiaContributionCsvRow,
  type WestVirginiaExpenditureCsvRow,
  type WestVirginiaReportingScheduleCsvRow,
} from "./westVirginiaCfrsCsv.js";
import { normalizeWestVirginiaCandidateNameForStorage } from "./westVirginiaCandidateCommitteeResolver.js";
import {
  WEST_VIRGINIA_CONTRIBUTION_FILE_CATEGORIES,
  aggregateWestVirginiaDirectFinance,
  type WestVirginiaDirectFinanceAggregationResult,
} from "./westVirginiaDirectContributionAggregator.js";
import { isWestVirginiaFinanceEligibleOffice } from "./westVirginiaFinanceEligibleOffices.js";
import {
  WEST_VIRGINIA_CFRS_SOURCE_URL,
  normalizeWestVirginiaEntityId,
  replaceWestVirginiaCandidateFinanceSnapshot,
  type WestVirginiaFinanceLinkSource,
  type WestVirginiaFinanceOutsideGroupInput,
} from "./westVirginiaFinanceWriter.js";
import { aggregateWestVirginiaElectronicOutsideSpending, type WestVirginiaElectronicOutsideSpendingResult } from "./westVirginiaElectronicOutsideSpendingAggregator.js";
import { readWestVirginiaElectronicOutsideSpendingArtifact } from "./westVirginiaElectronicOutsideSpendingCache.js";
import { validateWestVirginiaPreviouslyPublishedIe, type WestVirginiaStoredOutsideEvidence } from "./westVirginiaElectronicOutsideSpendingPersistenceGuard.js";
import {
  aggregateWestVirginiaDocumentOutsideSpending,
  assertWestVirginiaOutsideLedgerMatchesInventory,
  readWestVirginiaOutsideDocumentLedger,
  type WestVirginiaDocumentIeProvenance,
  type WestVirginiaDocumentOutsideSpendingResult,
  type WestVirginiaOutsideDocumentLedger,
} from "./westVirginiaOutsideDocumentLedger.js";
import { readWestVirginiaOutsideDocumentInventory } from "./westVirginiaOutsideDocumentInventory.js";
import { readWestVirginiaCommitteeRegistryArtifact } from "./westVirginiaCfrsRegistryCache.js";
import { reconcileWestVirginiaCommitteeDonors, type WestVirginiaCommitteeDonorReconciliation } from "./westVirginiaCommitteeDonorReconciliation.js";
import { reconcileWestVirginiaCommittee } from "./westVirginiaPhaseZero.js";
import {
  resolveWestVirginiaCandidateCycleWindow,
  westVirginiaCycleWindowYears,
  westVirginiaScheduleYearsForElection,
  type WestVirginiaCycleWindow,
} from "./westVirginiaReportingCycleWindows.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & { connect: () => Promise<PoolClient> };

export class WestVirginiaCandidateFinanceSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WestVirginiaCandidateFinanceSyncError";
  }
}

export type WestVirginiaFinanceArtifactLoader = {
  scheduleRows: (year: number) => Promise<WestVirginiaReportingScheduleCsvRow[]>;
  contributionRows: (year: number) => Promise<WestVirginiaContributionCsvRow[]>;
  expenditureRows: (year: number) => Promise<WestVirginiaExpenditureCsvRow[]>;
  apiContributionRows: (year: number) => Promise<WestVirginiaTransactionRow[]>;
  /** Missing registry preserves committee donor rows while direct receipts remain usable. */
  registryRows?: () => Promise<WestVirginiaCommitteeRow[]>;
  electronicOutsideData?: () => Promise<Awaited<ReturnType<typeof readWestVirginiaElectronicOutsideSpendingArtifact>>>;
  /** Reviewed F-7b / EC document ledger, already checked against the PDF inventory. Missing preserves stored document IE. */
  outsideDocumentLedger?: () => Promise<WestVirginiaOutsideDocumentLedger>;
};

function requireClean<T>(label: string, result: { rows: T[]; errors: { line: number; reason: string }[] }): T[] {
  if (result.errors.length > 0) {
    throw new WestVirginiaCandidateFinanceSyncError(
      `cached ${label} artifact has ${result.errors.length} row errors (line ${result.errors[0]!.line}: ${result.errors[0]!.reason})`
    );
  }
  return result.rows;
}

/** Reads and parses each cached artifact once per (kind, year); no live fetches. */
export function createWestVirginiaFinanceArtifactLoader(cacheDir?: string): WestVirginiaFinanceArtifactLoader {
  const resolvedCacheDir = resolve(
    cacheDir ??
      (process.env.WEST_VIRGINIA_CFRS_RAW_DATA_CACHE_DIR?.trim() || DEFAULT_WEST_VIRGINIA_CFRS_CACHE_DIR)
  );
  const memo = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    let entry = memo.get(key) as Promise<T> | undefined;
    if (entry === undefined) {
      entry = load();
      memo.set(key, entry);
    }
    return entry;
  };
  const bulkText = (kind: "contributions" | "expenditures" | "reporting_schedules", year: number) =>
    readWestVirginiaBulkArtifact({ kind, year, cacheDir: resolvedCacheDir }).then((read) => read.csvText);
  return {
    electronicOutsideData: () => once("electronic-ie", () => readWestVirginiaElectronicOutsideSpendingArtifact({ cacheDir: resolvedCacheDir })),
    outsideDocumentLedger: () => once("outside-documents", async () => {
      const [ledger, inventory] = await Promise.all([
        readWestVirginiaOutsideDocumentLedger(),
        readWestVirginiaOutsideDocumentInventory({ cacheDir: resolvedCacheDir }),
      ]);
      assertWestVirginiaOutsideLedgerMatchesInventory(ledger, inventory.inventory);
      return ledger;
    }),
    registryRows: () => once("registry", async () => (await readWestVirginiaCommitteeRegistryArtifact({ cacheDir: resolvedCacheDir })).rows),
    scheduleRows: (year) =>
      once(`reps:${year}`, async () =>
        requireClean(`reporting-schedules ${year}`, parseWestVirginiaReportingScheduleCsv(await bulkText("reporting_schedules", year)))
      ),
    contributionRows: (year) =>
      once(`con:${year}`, async () =>
        requireClean(`contributions ${year}`, parseWestVirginiaContributionCsv(await bulkText("contributions", year)))
      ),
    expenditureRows: (year) =>
      once(`exp:${year}`, async () =>
        requireClean(`expenditures ${year}`, parseWestVirginiaExpenditureCsv(await bulkText("expenditures", year)))
      ),
    apiContributionRows: (year) =>
      once(`api:${year}`, async () =>
        (await readWestVirginiaApiContributionsArtifact({ year, cacheDir: resolvedCacheDir })).rows
      ),
  };
}

export type WestVirginiaYearReconciliation = {
  year: number;
  csvRowCount: number;
  apiRowCount: number;
  csvTotalCents: number;
  apiTotalCents: number;
  amendedApiRowCount: number;
};

export type WestVirginiaCandidateFinanceSyncResult = {
  dryRun: boolean;
  status: "synced";
  entityId: string;
  window: Pick<WestVirginiaCycleWindow, "reportingCycle" | "windowStart" | "windowEnd">;
  windowYears: number[];
  /** False when the window holds no rows for the committee; totals are then null. */
  reportedActivity: boolean;
  totalReceipts: number | null;
  directContributionTotal: number | null;
  totalDisbursements: number | null;
  reconciliation: WestVirginiaYearReconciliation[];
  aggregation: Omit<WestVirginiaDirectFinanceAggregationResult, "breakdowns" | "pacDonors">;
  committeeDonorReconciliation: WestVirginiaCommitteeDonorReconciliation[];
  pacDonorCount: number | null;
  committeeRegistryError?: string;
  pacDonorsWritten?: number;
  outsideDiagnostics: string[];
  outsideSupportTotal: number | null;
  outsideOpposeTotal: number | null;
  outsideElectronicCount: number;
  outsideDocumentCount: number;
  outsideGroupsWritten: number;
  outsideSourceSha256?: string;
  breakdownCounts: { occupation: number; industry: number; contribution_size: number };
  summaryWritten: boolean;
  directBreakdownsWritten: number;
};

export async function syncWestVirginiaCandidateFinance(input: {
  db: ConnectableQueryable;
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district?: string | null;
  link: {
    entityId: string;
    committeeName: string;
    linkSource: WestVirginiaFinanceLinkSource;
    sourceUrl?: string | null;
  };
  now?: Date;
  dryRun?: boolean;
  cacheDir?: string;
  loadArtifacts?: WestVirginiaFinanceArtifactLoader;
  maxOccupationBreakdowns?: number;
}): Promise<WestVirginiaCandidateFinanceSyncResult> {
  const candidateName = input.candidateName.trim();
  if (!candidateName) {
    throw new WestVirginiaCandidateFinanceSyncError("candidateName is required");
  }
  const committeeName = input.link.committeeName.trim();
  if (!committeeName) {
    throw new WestVirginiaCandidateFinanceSyncError("link.committeeName is required");
  }
  if (!isWestVirginiaFinanceEligibleOffice({ officeScope: input.officeScope, officeCanonicalName: input.officeName })) {
    throw new WestVirginiaCandidateFinanceSyncError(
      `office ${input.officeScope}::${input.officeName} is not West Virginia-finance eligible`
    );
  }
  let entityId: string;
  try {
    entityId = normalizeWestVirginiaEntityId(input.link.entityId);
  } catch (error) {
    throw new WestVirginiaCandidateFinanceSyncError(error instanceof Error ? error.message : String(error));
  }
  if (!Number.isSafeInteger(input.electionYear) || input.electionYear < 2026 || input.electionYear > 2100) {
    throw new WestVirginiaCandidateFinanceSyncError(`invalid election year: ${input.electionYear}`);
  }
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime())) {
    throw new WestVirginiaCandidateFinanceSyncError("invalid now");
  }
  const dryRun = input.dryRun === true;
  const loader = input.loadArtifacts ?? createWestVirginiaFinanceArtifactLoader(input.cacheDir);
  let committeeRegistryRows: WestVirginiaCommitteeRow[] | undefined;
  let committeeRegistryError: string | undefined;
  if (loader.registryRows) {
    try {
      committeeRegistryRows = await loader.registryRows();
    } catch (error) {
      committeeRegistryError = error instanceof Error ? error.message : String(error);
    }
  }
  const committeeDonorReconciliation: WestVirginiaCommitteeDonorReconciliation[] = [];

  // --- Window (fact 5): union of the cycle's periods across the schedule
  // files that can carry them. A missing schedule file fails closed rather
  // than silently shortening the window.
  const scheduleRows: WestVirginiaReportingScheduleCsvRow[] = [];
  for (const year of westVirginiaScheduleYearsForElection(input.electionYear)) {
    scheduleRows.push(...(await loader.scheduleRows(year)));
  }
  const window = resolveWestVirginiaCandidateCycleWindow({ scheduleRows, electionYear: input.electionYear });
  const windowYears = westVirginiaCycleWindowYears(window);

  // --- Artifacts + per-year CSV<->API reconciliation (fact 3).
  const contributionRows: WestVirginiaContributionCsvRow[] = [];
  const expenditureRows: WestVirginiaExpenditureCsvRow[] = [];
  const apiRows: WestVirginiaTransactionRow[] = [];
  const reconciliation: WestVirginiaYearReconciliation[] = [];
  for (const year of windowYears) {
    const yearContributions = await loader.contributionRows(year);
    const yearExpenditures = await loader.expenditureRows(year);
    const yearApiRows = await loader.apiContributionRows(year);
    const check = reconcileWestVirginiaCommittee({
      entityId,
      csvRows: yearContributions,
      apiRows: yearApiRows,
      contributionCategories: WEST_VIRGINIA_CONTRIBUTION_FILE_CATEGORIES,
    });
    if (!check.totalsMatch || !check.multisetMatch) {
      throw new WestVirginiaCandidateFinanceSyncError(
        `${year} contributions do not reconcile for ${entityId}: CSV ${check.csvRowCount} rows / ${check.csvTotalCents}c ` +
          `vs API ${check.apiRowCount} rows / ${check.apiTotalCents}c (only-in-CSV ${check.onlyInCsv}, only-in-API ${check.onlyInApi})`
      );
    }
    if (committeeRegistryRows !== undefined) {
      committeeDonorReconciliation.push(reconcileWestVirginiaCommitteeDonors({
        entityId, csvRows: yearContributions, apiRows: yearApiRows, window,
      }));
    }
    reconciliation.push({
      year,
      csvRowCount: check.csvRowCount,
      apiRowCount: check.apiRowCount,
      csvTotalCents: check.csvTotalCents,
      apiTotalCents: check.apiTotalCents,
      amendedApiRowCount: check.amendedApiRowCount,
    });
    contributionRows.push(...yearContributions);
    expenditureRows.push(...yearExpenditures);
    apiRows.push(...yearApiRows);
  }

  // --- Aggregation (facts 1, 2, 10); unknown vocabulary fails closed.
  const aggregation = aggregateWestVirginiaDirectFinance({
    entityId,
    window,
    contributionRows,
    expenditureRows,
    apiRows,
    committeeRegistryRows,
    maxOccupationBreakdowns: input.maxOccupationBreakdowns,
  });
  const unrecognized = [
    ...aggregation.unrecognizedContributionCategories.map((value) => `contribution category "${value}"`),
    ...aggregation.unrecognizedContributorTypes.map((value) => `contributor type "${value}"`),
    ...aggregation.unrecognizedExpenditureTypes.map((value) => `expenditure type "${value}"`),
  ];
  if (unrecognized.length > 0) {
    throw new WestVirginiaCandidateFinanceSyncError(
      `unrecognized values in window for ${entityId}: ${unrecognized.join(", ")}`
    );
  }
  // The summaries table pins every amount >= 0; a net-negative total means
  // returns exceeded receipts in the window, which is an evidence problem to
  // look at, not a number to publish.
  if (aggregation.totalReceiptsCents < 0 || aggregation.directContributionCents < 0 || aggregation.totalDisbursementsCents < 0) {
    throw new WestVirginiaCandidateFinanceSyncError(
      `negative window total for ${entityId}: receipts ${aggregation.totalReceiptsCents}c, ` +
        `direct ${aggregation.directContributionCents}c, disbursements ${aggregation.totalDisbursementsCents}c`
    );
  }

  // A committee with no in-window contribution or expenditure rows has not
  // reported anything the cache can see — live 2026-09-03, 21 of the 25 such
  // committees registered in 2026 (the registry gives the year only), so few
  // or no filings were due yet. That is missing information, not a $0
  // campaign, so the totals publish as NULL (the
  // loader shows "unavailable") and the breakdowns stay empty. The summary
  // row is still written so the due list treats the candidate as synced.
  const reportedActivity = aggregation.contributionRowCount + aggregation.expenditureRowCount > 0;
  const totalReceipts = reportedActivity ? aggregation.totalReceiptsCents / 100 : null;
  const directContributionTotal = reportedActivity ? aggregation.directContributionCents / 100 : null;
  const totalDisbursements = reportedActivity ? aggregation.totalDisbursementsCents / 100 : null;
  const sourceUrl = input.link.sourceUrl ?? WEST_VIRGINIA_CFRS_SOURCE_URL;
  const { breakdowns: aggregatedBreakdowns, pacDonors, ...aggregationSummary } = aggregation;
  const breakdowns = reportedActivity ? aggregatedBreakdowns : [];

  // Electronic IE has independent source gates. Failure preserves accepted
  // outside data while reconciled direct receipts and donors can still update.
  let outsideResult: WestVirginiaElectronicOutsideSpendingResult | undefined;
  let outsideSourceSha256: string | undefined;
  let electronicArtifactSha256: string | undefined;
  const outsideDiagnostics: string[] = [];
  if (loader.electronicOutsideData) {
    try {
      const artifact = await loader.electronicOutsideData();
      if (windowYears.some((year) => !artifact.metadata.years.includes(year))) {
        throw new Error("West Virginia electronic IE cache does not cover every cycle year");
      }
      outsideResult = aggregateWestVirginiaElectronicOutsideSpending({
        candidateName, entityId, electionYear: input.electionYear,
        officeScope: input.officeScope, officeName: input.officeName, district: input.district,
        window, registryRows: artifact.registryRows, transactionRows: artifact.rows,
        currentFilingsByOrg: artifact.currentFilingsByOrg,
      });
      outsideDiagnostics.push(...outsideResult.diagnostics);
      if (outsideResult.summary) electronicArtifactSha256 = artifact.metadata.sha256;
    } catch (error) {
      outsideResult = undefined;
      outsideDiagnostics.push(error instanceof Error ? error.message : String(error));
    }
  }
  // Document (F-7b / EC) evidence from the reviewed ledger. The ledger loader
  // fails closed when a reviewed PDF changed or the inventory is missing, which
  // preserves stored document rows; an explicit non-accepted review decision is
  // the only way a published document row may disappear.
  let documentResult: WestVirginiaDocumentOutsideSpendingResult | undefined;
  let documentLedger: WestVirginiaOutsideDocumentLedger | undefined;
  if (loader.outsideDocumentLedger) {
    try {
      documentLedger = await loader.outsideDocumentLedger();
      documentResult = aggregateWestVirginiaDocumentOutsideSpending({
        candidateNameNormalized: normalizeWestVirginiaCandidateNameForStorage(candidateName),
        officeName: input.officeName, district: input.district, window, ledger: documentLedger, sourceUrl: WEST_VIRGINIA_CFRS_SOURCE_URL,
      });
    } catch (error) {
      documentResult = undefined;
      outsideDiagnostics.push(error instanceof Error ? error.message : String(error));
    }
  }
  const electronicOk = outsideResult?.summary !== undefined;
  const documentsOk = documentResult !== undefined;
  const electronicProvenance = electronicOk ? outsideResult!.provenance : [];
  const documentProvenance: WestVirginiaDocumentIeProvenance[] = documentsOk ? documentResult!.provenance : [];
  // An electronic-side failure that is not the benign "no rows" outcome must not
  // let a documents-only write drop stored electronic rows: the stored-evidence
  // guard below throws in that case and the whole outside write is skipped.
  let outside: { supportTotal: number | null; opposeTotal: number | null; groups: WestVirginiaFinanceOutsideGroupInput[] } | undefined;
  let outsideWithdrawnByReview = false;
  if (electronicOk || documentsOk) {
    try {
      const previous = await input.db.query<WestVirginiaStoredOutsideEvidence>(
        `SELECT outside_group.committee_id, outside_group.support_oppose, outside_group.source_transactions
         FROM public.wv_candidate_finance_outside_groups outside_group
         JOIN public.wv_candidate_finance_links link ON link.id = outside_group.link_id
         WHERE link.candidate_id = $1::uuid AND link.election_id = $2::uuid
           AND link.link_status = 'active' AND outside_group.election_year = $3`,
        [input.candidateId, input.electionId, input.electionYear]
      );
      const nothingCurrent = electronicProvenance.length + documentProvenance.length === 0;
      if (nothingCurrent && previous.rows.length === 0) throw new Error("no_outside_evidence_for_candidate");
      validateWestVirginiaPreviouslyPublishedIe({
        previousGroups: previous.rows, currentProvenance: electronicProvenance, currentDocumentProvenance: documentProvenance,
        explicitlyUnpublishedDocumentIds: new Set((documentLedger?.entries ?? [])
          .filter((entry) => entry.reviewStatus !== "accepted").map((entry) => entry.documentID)),
      });
      // The guard passed with nothing current: every stored row was a document
      // row that the ledger now lists as review/rejected (electronic rows would
      // have thrown). Clear the published spending and set totals to unavailable.
      if (nothingCurrent) {
        outsideWithdrawnByReview = true;
        outsideDiagnostics.push("outside_spending_withdrawn_by_ledger_review");
      }
      const merged = new Map<string, WestVirginiaFinanceOutsideGroupInput & { cents: number }>();
      const add = (group: { committeeId: string; committeeName: string; supportOppose: "support" | "oppose"; amount: number; sourceUrl: string | null },
        rows: readonly Record<string, unknown>[]) => {
        const key = `${group.committeeId}\0${group.supportOppose}`;
        const current = merged.get(key) ?? { ...group, amount: 0, cents: 0, sourceTransactions: [] as Record<string, unknown>[] };
        if (current.committeeName !== group.committeeName) throw new Error(`outside spender ${group.committeeId} name differs between electronic and document evidence`);
        current.cents += Math.round(group.amount * 100);
        current.sourceTransactions = [...current.sourceTransactions, ...rows];
        merged.set(key, current);
      };
      for (const group of outsideResult?.summary?.groups ?? []) {
        add(group, electronicProvenance.filter((row) => row.spenderEntityId === group.committeeId && row.supportOppose === group.supportOppose).map((row) => ({ ...row })));
      }
      for (const group of documentResult?.groups ?? []) {
        add(group, documentProvenance.filter((row) => row.spenderEntityId === group.committeeId && row.supportOppose === group.supportOppose).map((row) => ({ ...row })));
      }
      const groups = [...merged.values()].map(({ cents, ...group }) => ({ ...group, amount: cents / 100 }))
        .sort((left, right) => right.amount - left.amount || left.committeeId.localeCompare(right.committeeId) || left.supportOppose.localeCompare(right.supportOppose));
      const sum = (stance: "support" | "oppose") => groups.filter((g) => g.supportOppose === stance).reduce((total, g) => total + Math.round(g.amount * 100), 0) / 100;
      outside = nothingCurrent
        ? { supportTotal: null, opposeTotal: null, groups: [] }
        : { supportTotal: sum("support"), opposeTotal: sum("oppose"), groups };
      if (electronicOk) outsideSourceSha256 = electronicArtifactSha256;
    } catch (error) {
      outside = undefined;
      outsideDiagnostics.push(error instanceof Error ? error.message : String(error));
    }
  }
  const outsideGroups: WestVirginiaFinanceOutsideGroupInput[] | undefined = outside?.groups;

  let summaryWritten = false;
  let directBreakdownsWritten = 0;
  let pacDonorsWritten: number | undefined;
  let outsideGroupsWritten = 0;
  if (!dryRun) {
    const writeResult = await replaceWestVirginiaCandidateFinanceSnapshot({
      db: input.db,
      link: {
        candidateId: input.candidateId,
        electionId: input.electionId,
        electionYear: input.electionYear,
        candidateNameNormalized: normalizeWestVirginiaCandidateNameForStorage(candidateName),
        officeName: input.officeName,
        district: input.district ?? null,
        entityId,
        committeeName,
        linkStatus: "active",
        linkSource: input.link.linkSource,
        sourceUrl,
        lastVerifiedAt: now,
      },
      syncedAt: now,
      pacDonors,
      outsideGroups,
      ...(outsideWithdrawnByReview ? { outsideWithdrawnByReview: true } : {}),
      summary: { totalReceipts, directContributionTotal, totalDisbursements, sourceUrl,
        outsideSupportTotal: outside?.supportTotal, outsideOpposeTotal: outside?.opposeTotal },
      directBreakdowns: breakdowns.map((breakdown) => ({
        categoryType: breakdown.categoryType,
        categoryName: breakdown.categoryName,
        amount: breakdown.amount,
        contributorCount: breakdown.contributorCount,
        sourceUrl,
      })),
    });
    summaryWritten = writeResult.summaryWritten;
    directBreakdownsWritten = writeResult.directBreakdownsWritten;
    pacDonorsWritten = writeResult.pacDonorsWritten;
    outsideGroupsWritten = writeResult.outsideGroupsWritten;
  }

  return {
    dryRun,
    status: "synced",
    entityId,
    window: { reportingCycle: window.reportingCycle, windowStart: window.windowStart, windowEnd: window.windowEnd },
    windowYears,
    reportedActivity,
    totalReceipts,
    directContributionTotal,
    totalDisbursements,
    reconciliation,
    aggregation: aggregationSummary,
    committeeDonorReconciliation,
    outsideDiagnostics,
    outsideSupportTotal: outside?.supportTotal ?? null,
    outsideOpposeTotal: outside?.opposeTotal ?? null,
    outsideElectronicCount: outside ? electronicProvenance.length : 0,
    outsideDocumentCount: outside ? documentProvenance.length : 0,
    outsideGroupsWritten,
    ...(outsideSourceSha256 === undefined ? {} : { outsideSourceSha256 }),
    pacDonorCount: pacDonors?.length ?? null,
    ...(committeeRegistryError === undefined ? {} : { committeeRegistryError }),
    ...(pacDonorsWritten === undefined ? {} : { pacDonorsWritten }),
    breakdownCounts: {
      occupation: breakdowns.filter((breakdown) => breakdown.categoryType === "occupation").length,
      industry: breakdowns.filter((breakdown) => breakdown.categoryType === "industry").length,
      contribution_size: breakdowns.filter((breakdown) => breakdown.categoryType === "contribution_size").length,
    },
    summaryWritten,
    directBreakdownsWritten,
  };
}
