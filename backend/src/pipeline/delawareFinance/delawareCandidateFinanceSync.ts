// Delaware candidate finance sync (docs/plans/plan-delaware-finance.md, Phase 1).
//
// CACHE-ONLY: this module never touches the live portal — acquisition is a
// separate layer behind DELAWARE_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED.
// Every fact-6 gate runs before anything is written, and every gate fails
// closed (plan acceptance list): committee identity, CSV count == stored
// search total, per-report cash identity + chain (inventory), per-period
// cover reconciliation, unambiguous window, no unrecognized contribution
// types. This direct-only path has no accepted outside component; the writer
// preserves stored outside data and the loader states incomplete coverage.

import type { Pool, PoolClient } from "pg";

import {
  extractDelawareReportCover,
  type DelawareFiledReportRow,
  type DelawareReportCover,
} from "./delawareCfrsParsers.js";
import {
  readDelawareCfrsCommitteeArtifacts,
  type DelawareCfrsCommitteeArtifacts,
} from "./delawareCfrsArtifactCache.js";
import { reconcileDelawareCoversPerPeriod } from "./delawareCoverReconciliation.js";
import {
  aggregateDelawareDirectFinance,
  type DelawareDirectFinanceAggregationResult,
} from "./delawareDirectContributionAggregator.js";
import { isDelawareFinanceEligibleOffice, toDelawareCfrsOfficeSearch } from "./delawareFinanceEligibleOffices.js";
import {
  normalizeDelawareCfId,
  replaceDelawareCandidateFinanceSnapshot,
  type DelawareFinanceLinkSource,
} from "./delawareFinanceWriter.js";
import { normalizeDelawareCandidateNameForStorage } from "./delawareCandidateCommitteeResolver.js";
import {
  buildDelawareCanonicalReportInventory,
  resolveDelawareElectionPeriodWindow,
  type DelawareElectionPeriodWindow,
} from "./delawareReportInventory.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & { connect: () => Promise<PoolClient> };

export type DelawareCandidateFinanceSyncResult = {
  dryRun: boolean;
  window: Pick<DelawareElectionPeriodWindow, "windowStart" | "windowEnd" | "publishedThrough" | "basis">;
  windowPeriodKeys: string[];
  totalReceipts: number;
  directContributionTotal: number;
  totalDisbursements: number;
  cashOnHand: number;
  linkWritten: boolean;
  summaryWritten: boolean;
  directBreakdownsWritten: number;
  aggregation: DelawareDirectFinanceAggregationResult;
};

export class DelawareCandidateFinanceSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelawareCandidateFinanceSyncError";
  }
}

function requireText(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new DelawareCandidateFinanceSyncError(`${label} is required`);
  }
  return trimmed;
}

export async function syncDelawareCandidateFinance(input: {
  db: ConnectableQueryable;
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  /** ISO general-election date; the finance cycle continues through December31. */
  electionDate: string;
  officeScope: string;
  officeName: string;
  district?: string | null;
  committee: {
    cfId: string;
    committeeName: string;
    linkSource: DelawareFinanceLinkSource;
    sourceUrl?: string | null;
  };
  cacheDir?: string;
  artifacts?: DelawareCfrsCommitteeArtifacts;
  now?: Date;
  dryRun?: boolean;
  maxOccupationBreakdowns?: number;
  /** Injectable for tests; defaults to the real PDF cover extractor. */
  extractReportCover?: (pdfBytes: Uint8Array) => Promise<DelawareReportCover>;
}): Promise<DelawareCandidateFinanceSyncResult> {
  const candidateName = requireText(input.candidateName, "candidateName");
  const officeScope = requireText(input.officeScope, "officeScope");
  const officeName = requireText(input.officeName, "officeName");
  const committeeName = requireText(input.committee.committeeName, "committee.committeeName");
  if (!isDelawareFinanceEligibleOffice({ officeScope, officeCanonicalName: officeName })) {
    throw new DelawareCandidateFinanceSyncError(
      `office ${officeScope}::${officeName} is not Delaware-finance eligible`
    );
  }
  const cfId = normalizeDelawareCfId(input.committee.cfId);
  if (!Number.isSafeInteger(input.electionYear) || input.electionYear < 2026 || input.electionYear > 2100) {
    throw new DelawareCandidateFinanceSyncError(`invalid election year: ${input.electionYear}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.electionDate) || Number.parseInt(input.electionDate.slice(0, 4), 10) !== input.electionYear) {
    throw new DelawareCandidateFinanceSyncError(
      `election date ${input.electionDate} does not match election year ${input.electionYear}`
    );
  }
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime())) {
    throw new DelawareCandidateFinanceSyncError("invalid now");
  }

  const artifacts =
    input.artifacts ?? (await readDelawareCfrsCommitteeArtifacts({ cacheDir: input.cacheDir, cfId }));

  // --- Committee identity gates. ---
  if (artifacts.manifest.cfId !== cfId) {
    throw new DelawareCandidateFinanceSyncError(
      `artifact bundle is for CF_ID ${artifacts.manifest.cfId}, expected ${cfId}`
    );
  }
  for (const row of artifacts.receiptRows) {
    if (row.CF_ID !== cfId) {
      throw new DelawareCandidateFinanceSyncError(`receipt row carries CF_ID ${row.CF_ID}, expected ${cfId}`);
    }
  }
  for (const row of artifacts.expenseRows) {
    if (row["CF ID"] !== cfId) {
      throw new DelawareCandidateFinanceSyncError(`expense row carries CF ID ${row["CF ID"]}, expected ${cfId}`);
    }
  }
  for (const row of artifacts.filedReportRows) {
    if (row.cfId !== cfId) {
      throw new DelawareCandidateFinanceSyncError(`filed-report row carries CF ID ${row.cfId}, expected ${cfId}`);
    }
    if (row.document !== null && row.document.memberId !== artifacts.manifest.memberId) {
      throw new DelawareCandidateFinanceSyncError(
        `filed-report document MemberID ${row.document.memberId} does not match bundle MemberID ${artifacts.manifest.memberId}`
      );
    }
  }

  // --- Office gate. The filed-report Office column reflects the
  // committee's CURRENT registration on every historical row (live-proven:
  // all 20 Meyer reports render "State Office - Governor", county-era rows
  // included), so report-era office history is NOT recoverable from the
  // artifacts. This gate verifies the current registration matches the
  // target office — defense in depth on top of the resolver's
  // office-filtered search; old-era money is excluded by the window rule. ---
  const officeSearch = toDelawareCfrsOfficeSearch({ officeScope, officeName, district: input.district });
  if (officeSearch === null) {
    throw new DelawareCandidateFinanceSyncError(
      `cannot derive the CFRS office for ${officeScope}::${officeName} (district ${input.district ?? "none"})`
    );
  }
  const officeNeedle = officeSearch.officeLabel.toLowerCase();
  for (const row of artifacts.filedReportRows) {
    if (!row.office.toLowerCase().includes(officeNeedle)) {
      throw new DelawareCandidateFinanceSyncError(
        `filed-report row [${row.filingPeriodName}] carries office "${row.office}", ` +
          `which does not match the target office "${officeSearch.officeLabel}" — committee registration mismatch`
      );
    }
  }

  // --- Acquisition completeness gates (count == stored-search total). ---
  if (artifacts.receiptsMalformedRowCount !== 0 || artifacts.expensesMalformedRowCount !== 0) {
    throw new DelawareCandidateFinanceSyncError(
      `malformed CSV rows in bundle: receipts=${artifacts.receiptsMalformedRowCount}, expenses=${artifacts.expensesMalformedRowCount}`
    );
  }
  if (artifacts.receiptRows.length !== artifacts.manifest.receiptsSearchTotal) {
    throw new DelawareCandidateFinanceSyncError(
      `receipts CSV rows (${artifacts.receiptRows.length}) != stored-search total (${artifacts.manifest.receiptsSearchTotal})`
    );
  }
  if (artifacts.expenseRows.length !== artifacts.manifest.expensesSearchTotal) {
    throw new DelawareCandidateFinanceSyncError(
      `expenses CSV rows (${artifacts.expenseRows.length}) != stored-search total (${artifacts.manifest.expensesSearchTotal})`
    );
  }
  if (artifacts.filedReportsGridTotal !== null && artifacts.filedReportsGridTotal !== artifacts.filedReportRows.length) {
    throw new DelawareCandidateFinanceSyncError(
      `filed-report rows (${artifacts.filedReportRows.length}) != grid total (${artifacts.filedReportsGridTotal})`
    );
  }

  // --- Cover extraction (per-report cash identity enforced inside). ---
  const extractCover = input.extractReportCover ?? extractDelawareReportCover;
  const pdfByFileName = new Map(artifacts.reportPdfs.map((pdf) => [pdf.publicReportFileName, pdf]));
  const reportsWithCovers: { row: DelawareFiledReportRow; cover: DelawareReportCover }[] = [];
  for (const row of artifacts.filedReportRows) {
    if (row.document === null) {
      throw new DelawareCandidateFinanceSyncError(
        `filed report [${row.filingPeriodName}] has no document — cannot verify covers`
      );
    }
    const pdf = pdfByFileName.get(row.document.publicReportFileName);
    if (pdf === undefined) {
      throw new DelawareCandidateFinanceSyncError(
        `bundle is missing the PDF for report [${row.filingPeriodName}] (${row.document.publicReportFileName})`
      );
    }
    reportsWithCovers.push({ row, cover: await extractCover(new Uint8Array(pdf.body)) });
  }

  // --- Canonical inventory, per-period reconciliation, window. ---
  const canonicalReports = buildDelawareCanonicalReportInventory(reportsWithCovers);
  const reconciliation = reconcileDelawareCoversPerPeriod({
    canonicalReports,
    receiptRows: artifacts.receiptRows,
    expenseRows: artifacts.expenseRows,
  });
  if (!reconciliation.ok) {
    const detail = reconciliation.mismatchedPeriods
      .map(
        (period) =>
          `[${period.periodKey}] receipts ${period.csvReceiptsCents}c vs ${period.coverReceiptsCents ?? "no cover"}, ` +
          `expenses ${period.csvExpensesCents}c vs ${period.coverExpendituresCents ?? "no cover"}`
      )
      .join("; ");
    throw new DelawareCandidateFinanceSyncError(`per-period cover reconciliation failed: ${detail}`);
  }
  const window = resolveDelawareElectionPeriodWindow({ electionDate: input.electionDate, canonicalReports });
  const windowPeriodKeys = new Set(window.reports.map((report) => report.periodKey));

  // --- Aggregation + donor identity (fact 6). ---
  const aggregation = aggregateDelawareDirectFinance({
    receiptRows: artifacts.receiptRows,
    windowPeriodKeys,
    maxOccupationBreakdowns: input.maxOccupationBreakdowns,
  });
  if (aggregation.unrecognizedContributionTypeRowCount > 0) {
    throw new DelawareCandidateFinanceSyncError(
      `unrecognized Contribution Types in window: ${aggregation.unrecognizedContributionTypes.join(", ")}`
    );
  }
  const windowCoverReceiptsCents = window.reports.reduce((sum, report) => sum + report.receiptsCents, 0);
  const windowCoverExpendituresCents = window.reports.reduce((sum, report) => sum + report.expendituresCents, 0);
  if (aggregation.windowRowTotalCents !== windowCoverReceiptsCents) {
    throw new DelawareCandidateFinanceSyncError(
      `window donor identity failed: CSV rows sum to ${aggregation.windowRowTotalCents}c, ` +
        `window covers sum to ${windowCoverReceiptsCents}c`
    );
  }

  // cash_on_hand is the CURRENT cash position — the ending balance of the
  // latest canonical cover (plan fact 2, verbatim), deliberately NOT
  // window-scoped: pairing the election window's raised/spent totals with
  // the latest known cash is the standard finance-summary semantic (FEC
  // style). Pre-election the two coincide; after the election the window
  // totals stay frozen while cash tracks the newest filed report.
  const cashOnHandCents = canonicalReports[canonicalReports.length - 1]!.endingBalanceCents;
  const totalReceipts = windowCoverReceiptsCents / 100;
  const directContributionTotal = aggregation.directContributionCents / 100;
  const totalDisbursements = windowCoverExpendituresCents / 100;
  const cashOnHand = cashOnHandCents / 100;

  let summaryWritten = false;
  let directBreakdownsWritten = 0;
  if (input.dryRun !== true) {
    const writeResult = await replaceDelawareCandidateFinanceSnapshot({
      db: input.db,
      link: {
        candidateId: input.candidateId,
        electionId: input.electionId,
        electionYear: input.electionYear,
        candidateNameNormalized: normalizeDelawareCandidateNameForStorage(candidateName),
        officeName,
        district: input.district ?? null,
        committeeId: cfId,
        committeeName,
        linkStatus: "active",
        linkSource: input.committee.linkSource,
        sourceUrl: input.committee.sourceUrl ?? artifacts.manifest.sourceUrl,
        lastVerifiedAt: now,
      },
      syncedAt: now,
      summary: {
        totalReceipts,
        directContributionTotal,
        totalDisbursements,
        cashOnHand,
        sourceUrl: input.committee.sourceUrl ?? artifacts.manifest.sourceUrl,
      },
      directBreakdowns: aggregation.breakdowns.map((breakdown) => ({
        categoryType: breakdown.categoryType,
        categoryName: breakdown.categoryName,
        amount: breakdown.amount,
        contributorCount: breakdown.contributorCount,
      })),
    });
    summaryWritten = writeResult.summaryWritten;
    directBreakdownsWritten = writeResult.directBreakdownsWritten;
  }

  return {
    dryRun: input.dryRun === true,
    window: { windowStart: window.windowStart, windowEnd: window.windowEnd, publishedThrough: window.publishedThrough, basis: window.basis },
    windowPeriodKeys: [...windowPeriodKeys].sort(),
    totalReceipts,
    directContributionTotal,
    totalDisbursements,
    cashOnHand,
    linkWritten: input.dryRun !== true,
    summaryWritten,
    directBreakdownsWritten,
    aggregation,
  };
}
