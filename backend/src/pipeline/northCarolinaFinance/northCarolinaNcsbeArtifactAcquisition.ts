import {
  extractNcsbeAntiForgeryToken,
  fetchNcsbeDocumentInventory,
  fetchNcsbeExpenditurePages,
  fetchNcsbeIeDocTypeInventory,
  fetchNcsbeReceiptPages,
  fetchNcsbeReportDetail,
  NCSBE_TRANSACTION_PAGE_SIZE,
  type NcsbeTransport,
} from "./northCarolinaNcsbeClient.js";
import {
  getNcsbeArtifactStatus,
  storeNcsbeArtifact,
  type NcsbeArtifactKey,
  type NcsbeSourceDocumentMetadata,
} from "./northCarolinaNcsbeArtifactCache.js";
import {
  isNcsbeReportYearInCycle,
  NCSBE_NO_TOTAL_REPORT_TYPES,
  type NcsbeDocumentRow,
} from "./northCarolinaNcsbeParsers.js";

// Acquisition for NCSBE portal artifacts (docs/plans/north_carolina_plan.md "Required
// artifacts per cycle Y"). Retrieval only: report ids are discovered from the
// inventories each run — never hardcoded (decision 10) — fetched
// sequentially through the paced transport, validated, hashed, and installed
// in the cache. Nothing here writes to the database.
//
// Report selection for aggregation (decision 8 amendment logic) does NOT
// live here: the acquisition caches every structured disclosure report whose
// period touches the cycle window, amendments and originals alike, so the
// selector can run offline against a complete artifact set.

export type NcsbeAcquisitionCommittee = {
  sboeId: string;
  orgGroupId: number;
};

// A document-inventory row is fetchable when it is a structured disclosure
// report; period overlap with the Y−1..Y window decides inclusion (extra
// spike finding: match by period, not a report-type whitelist). Rows whose
// period bounds are missing or implausible — the portal holds a live year-
// 3026 date — fall back to `ReportYear`: inside the window they are INCLUDED
// and counted (a data-entry typo must widen the fetch, never silently narrow
// it), outside it they are excluded and counted separately. Without that
// fallback a long-lived committee's undated 1990s filings are all fetched
// (PR 9 run: SURRY REC's twelve 1989–1994 rows), and they use a pre-2007
// cover vocabulary that fails the 34-section pin — which would then fail the
// whole spender's funder leg on artifacts that can never exist.
export function selectNcsbeCycleReportRows(input: {
  rows: readonly NcsbeDocumentRow[];
  cycleYear: number;
}): {
  selected: NcsbeDocumentRow[];
  unusablePeriodRowCount: number;
  excludedNoTotalReportRowCount: number;
  excludedUndatedOutOfCycleRowCount: number;
} {
  const cycleStartIso = `${input.cycleYear - 1}-01-01`;
  const cycleEndIso = `${input.cycleYear}-12-31`;
  const selected: NcsbeDocumentRow[] = [];
  let unusablePeriodRowCount = 0;
  let excludedNoTotalReportRowCount = 0;
  let excludedUndatedOutOfCycleRowCount = 0;
  for (const row of input.rows) {
    if (row.documentType !== "Disclosure Report" || row.dataLink === null) {
      continue;
    }
    // Pinned no-total forms (48-Hour Notice): nothing on them is usable —
    // no cover totals, and their receipts re-appear on the covering regular
    // report — so fetching them only burns requests and fails the cover pin.
    if (row.reportType !== null && NCSBE_NO_TOTAL_REPORT_TYPES.has(row.reportType)) {
      excludedNoTotalReportRowCount += 1;
      continue;
    }
    const startIso = row.periodStartDate.iso;
    const endIso = row.periodEndDate.iso;
    if (startIso === null || endIso === null) {
      unusablePeriodRowCount += 1;
      if (isNcsbeReportYearInCycle(row.reportYear, input.cycleYear)) {
        selected.push(row);
      } else {
        excludedUndatedOutOfCycleRowCount += 1;
      }
      continue;
    }
    if (startIso <= cycleEndIso && endIso >= cycleStartIso) {
      selected.push(row);
    }
  }
  return {
    selected,
    unusablePeriodRowCount,
    excludedNoTotalReportRowCount,
    excludedUndatedOutOfCycleRowCount,
  };
}

export function ncsbeSourceDocumentMetadata(row: NcsbeDocumentRow): NcsbeSourceDocumentMetadata {
  return {
    committeeName: row.committeeName,
    sboeId: row.sboeId,
    reportYear: row.reportYear,
    documentType: row.documentType,
    reportType: row.reportType,
    isAmendment: row.isAmendment,
    imageReceiptDate: row.imageReceiptDate.raw,
    dataImportDate: row.dataImportDate.raw,
    periodStartDate: row.periodStartDate.raw,
    periodEndDate: row.periodEndDate.raw,
  };
}

function expectedTransactionPageCount(recordCountKey: number): number {
  return Math.max(1, Math.ceil(recordCountKey / NCSBE_TRANSACTION_PAGE_SIZE));
}

// A report is skippable when its whole artifact set is "ready" and EVERY
// artifact — cover and each transaction page — was fetched for the same
// DataImportDate the inventory reports now. The portal's import date is the
// freshness signal (Ohio's date-modified skip, per report), and requiring it
// on every page means a mixed-vintage snapshot (however it was produced) can
// never satisfy the skip — it is re-fetched instead.
export async function isNcsbeReportCached(input: {
  cacheDir: string;
  row: NcsbeDocumentRow;
}): Promise<boolean> {
  const reportId = input.row.dataLink;
  if (reportId === null) {
    return false;
  }
  const importDate = input.row.dataImportDate.raw;
  const cover = await getNcsbeArtifactStatus({
    cacheDir: input.cacheDir,
    key: { type: "report_cover", reportId },
  });
  if (cover.status !== "ready" || cover.manifest?.sourceDocument?.dataImportDate !== importDate) {
    return false;
  }
  for (const kind of ["receipts", "expenditures"] as const) {
    const firstPage = await getNcsbeArtifactStatus({
      cacheDir: input.cacheDir,
      key: { type: "report_transactions", reportId, kind, page: 0 },
    });
    if (
      firstPage.status !== "ready" ||
      !firstPage.manifest ||
      firstPage.manifest.recordCountKey === null ||
      firstPage.manifest.sourceDocument?.dataImportDate !== importDate
    ) {
      return false;
    }
    const pageCount = expectedTransactionPageCount(firstPage.manifest.recordCountKey);
    for (let page = 1; page < pageCount; page += 1) {
      const pageStatus = await getNcsbeArtifactStatus({
        cacheDir: input.cacheDir,
        key: { type: "report_transactions", reportId, kind, page },
      });
      if (pageStatus.status !== "ready" || pageStatus.manifest?.sourceDocument?.dataImportDate !== importDate) {
        return false;
      }
    }
  }
  return true;
}

export type NcsbeReportFetchSummary = {
  reportId: string;
  reportType: string | null;
  requestCount: number;
  receiptRowCount: number;
  expenditureRowCount: number;
};

// Fetches one structured report — cover + complete receipt and expenditure
// page sets — and installs artifacts only after EVERY fetch has succeeded.
// A transport or validation failure mid-report therefore leaves the previous
// snapshot fully intact instead of a mixed-vintage cover/receipts/expenditure
// set (which the per-page DataImportDate check in isNcsbeReportCached would
// otherwise have to catch after the fact). Any failure throws — the caller
// isolates it so one bad report cannot abandon the run.
export async function acquireNcsbeReport(input: {
  transport: NcsbeTransport;
  cacheDir: string;
  row: NcsbeDocumentRow;
  retrievedAt?: Date;
}): Promise<NcsbeReportFetchSummary> {
  const reportId = input.row.dataLink;
  if (reportId === null) {
    throw new Error("NCSBE acquisition asked to fetch an image-only inventory row");
  }
  const sourceDocument = ncsbeSourceDocumentMetadata(input.row);

  // Phase 1: fetch everything. Nothing is written yet.
  const cover = await fetchNcsbeReportDetail(input.transport, reportId);
  const antiForgeryToken = extractNcsbeAntiForgeryToken(cover.body);
  const receipts = await fetchNcsbeReceiptPages(input.transport, reportId, antiForgeryToken);
  const expenditures = await fetchNcsbeExpenditurePages(input.transport, reportId, antiForgeryToken);

  // Phase 2: install. Only local validated writes remain; a crash here still
  // leaves per-page import dates that isNcsbeReportCached refuses to skip.
  await storeNcsbeArtifact({
    cacheDir: input.cacheDir,
    key: { type: "report_cover", reportId },
    url: cover.url,
    body: cover.body,
    sourceDocument,
    retrievedAt: input.retrievedAt,
  });
  for (const page of receipts.pages) {
    await storeNcsbeArtifact({
      cacheDir: input.cacheDir,
      key: { type: "report_transactions", reportId, kind: "receipts", page: page.page },
      url: page.url,
      body: page.body,
      sourceDocument,
      retrievedAt: input.retrievedAt,
    });
  }
  for (const page of expenditures.pages) {
    await storeNcsbeArtifact({
      cacheDir: input.cacheDir,
      key: { type: "report_transactions", reportId, kind: "expenditures", page: page.page },
      url: page.url,
      body: page.body,
      sourceDocument,
      retrievedAt: input.retrievedAt,
    });
  }

  return {
    reportId,
    reportType: input.row.reportType,
    requestCount: 1 + receipts.pages.length + expenditures.pages.length,
    receiptRowCount: receipts.rows.length,
    expenditureRowCount: expenditures.rows.length,
  };
}

export type NcsbeCommitteeAcquisitionResult = {
  sboeId: string;
  orgGroupId: number;
  inventoryRowCount: number;
  selectedReportCount: number;
  unusablePeriodRowCount: number;
  excludedNoTotalReportRowCount: number;
  excludedUndatedOutOfCycleRowCount: number;
  fetched: NcsbeReportFetchSummary[];
  skippedReportIds: string[];
  failures: Array<{ reportId: string; message: string }>;
};

export type NcsbeIeAcquisitionResult = {
  years: number[];
  // Row counts across both year inventories — the same filing can appear in
  // more than one inventory, so these are NOT distinct-filing counts; the
  // deduplicated fetch set is what `fetched`/`skippedReportIds` describe, and
  // the coverage-gap table is built from the cached inventories at
  // aggregation time.
  inventoryRowCount: number;
  structuredRowCount: number;
  imageOnlyRowCount: number;
  fetched: NcsbeReportFetchSummary[];
  skippedReportIds: string[];
  failures: Array<{ reportId: string; message: string }>;
};

export type NcsbeAcquisitionResult = {
  cycleYear: number;
  cacheDir: string;
  committees: NcsbeCommitteeAcquisitionResult[];
  committeeFailures: Array<{ sboeId: string; message: string }>;
  ie: NcsbeIeAcquisitionResult | null;
  // Set when the IE pass itself failed (e.g. an inventory fetch) — committee
  // results above are preserved, matching the per-committee isolation.
  ieFailure: { message: string } | null;
};

async function acquireReportSet(input: {
  transport: NcsbeTransport;
  cacheDir: string;
  rows: readonly NcsbeDocumentRow[];
  force: boolean;
  retrievedAt?: Date;
  log?: (message: string) => void;
  label: string;
}): Promise<{
  fetched: NcsbeReportFetchSummary[];
  skippedReportIds: string[];
  failures: Array<{ reportId: string; message: string }>;
}> {
  const fetched: NcsbeReportFetchSummary[] = [];
  const skippedReportIds: string[] = [];
  const failures: Array<{ reportId: string; message: string }> = [];
  const seenReportIds = new Set<string>();

  for (const row of input.rows) {
    const reportId = row.dataLink;
    if (reportId === null || seenReportIds.has(reportId)) {
      continue;
    }
    seenReportIds.add(reportId);
    try {
      if (!input.force && (await isNcsbeReportCached({ cacheDir: input.cacheDir, row }))) {
        skippedReportIds.push(reportId);
        continue;
      }
      const summary = await acquireNcsbeReport({
        transport: input.transport,
        cacheDir: input.cacheDir,
        row,
        retrievedAt: input.retrievedAt,
      });
      fetched.push(summary);
      input.log?.(
        `${input.label} report ${reportId} (${row.reportType ?? row.documentType}): ` +
          `${summary.receiptRowCount} receipts, ${summary.expenditureRowCount} expenditures, ` +
          `${summary.requestCount} requests`
      );
    } catch (error) {
      // One bad report must not abandon the rest; its cached snapshot, if
      // any, is left untouched.
      failures.push({ reportId, message: (error as Error).message });
      input.log?.(`${input.label} report ${reportId}: FAILED — ${(error as Error).message}`);
    }
  }
  return { fetched, skippedReportIds, failures };
}

export async function acquireNcsbeCommitteeArtifacts(input: {
  transport: NcsbeTransport;
  cacheDir: string;
  cycleYear: number;
  committee: NcsbeAcquisitionCommittee;
  force?: boolean;
  retrievedAt?: Date;
  log?: (message: string) => void;
}): Promise<NcsbeCommitteeAcquisitionResult> {
  const inventory = await fetchNcsbeDocumentInventory(input.transport, {
    orgGroupId: input.committee.orgGroupId,
    sboeId: input.committee.sboeId,
  });
  await storeNcsbeArtifact({
    cacheDir: input.cacheDir,
    key: { type: "document_inventory", sboeId: input.committee.sboeId },
    url: inventory.url,
    body: inventory.body,
    retrievedAt: input.retrievedAt,
  });

  const {
    selected,
    unusablePeriodRowCount,
    excludedNoTotalReportRowCount,
    excludedUndatedOutOfCycleRowCount,
  } = selectNcsbeCycleReportRows({
    rows: inventory.parsed,
    cycleYear: input.cycleYear,
  });
  const reportSet = await acquireReportSet({
    transport: input.transport,
    cacheDir: input.cacheDir,
    rows: selected,
    force: input.force ?? false,
    retrievedAt: input.retrievedAt,
    log: input.log,
    label: input.committee.sboeId,
  });

  return {
    sboeId: input.committee.sboeId,
    orgGroupId: input.committee.orgGroupId,
    inventoryRowCount: inventory.parsed.length,
    selectedReportCount: selected.length,
    unusablePeriodRowCount,
    excludedNoTotalReportRowCount,
    excludedUndatedOutOfCycleRowCount,
    ...reportSet,
  };
}

// IE doc-type inventories cover both cycle years; every structured row is
// fetched (cover + expenditures + receipts — receipts carry noncommittee
// filers' disclosed-funder rows, decision 6). Image-only rows are counted
// for the coverage-gap table, never fetched (no OCR, decision 13).
export async function acquireNcsbeIeArtifacts(input: {
  transport: NcsbeTransport;
  cacheDir: string;
  cycleYear: number;
  force?: boolean;
  retrievedAt?: Date;
  log?: (message: string) => void;
}): Promise<NcsbeIeAcquisitionResult> {
  const years = [input.cycleYear - 1, input.cycleYear];
  const allRows: NcsbeDocumentRow[] = [];
  for (const year of years) {
    const inventory = await fetchNcsbeIeDocTypeInventory(input.transport, year);
    await storeNcsbeArtifact({
      cacheDir: input.cacheDir,
      key: { type: "ie_doc_type_inventory", year },
      url: inventory.url,
      body: inventory.body,
      retrievedAt: input.retrievedAt,
    });
    allRows.push(...inventory.parsed);
    input.log?.(`IE inventory ${year}: ${inventory.parsed.length} filings`);
  }

  const structuredRows = allRows.filter((row) => row.dataLink !== null);
  const reportSet = await acquireReportSet({
    transport: input.transport,
    cacheDir: input.cacheDir,
    rows: structuredRows,
    force: input.force ?? false,
    retrievedAt: input.retrievedAt,
    log: input.log,
    label: "IE",
  });

  return {
    years,
    inventoryRowCount: allRows.length,
    structuredRowCount: structuredRows.length,
    imageOnlyRowCount: allRows.length - structuredRows.length,
    ...reportSet,
  };
}

export async function acquireNcsbeCycleArtifacts(input: {
  transport: NcsbeTransport;
  cacheDir: string;
  cycleYear: number;
  committees: readonly NcsbeAcquisitionCommittee[];
  includeIe?: boolean;
  force?: boolean;
  retrievedAt?: Date;
  log?: (message: string) => void;
}): Promise<NcsbeAcquisitionResult> {
  const committees: NcsbeCommitteeAcquisitionResult[] = [];
  const committeeFailures: Array<{ sboeId: string; message: string }> = [];
  for (const committee of input.committees) {
    try {
      committees.push(
        await acquireNcsbeCommitteeArtifacts({
          transport: input.transport,
          cacheDir: input.cacheDir,
          cycleYear: input.cycleYear,
          committee,
          force: input.force,
          retrievedAt: input.retrievedAt,
          log: input.log,
        })
      );
    } catch (error) {
      committeeFailures.push({ sboeId: committee.sboeId, message: (error as Error).message });
      input.log?.(`Committee ${committee.sboeId}: FAILED — ${(error as Error).message}`);
    }
  }

  let ie: NcsbeIeAcquisitionResult | null = null;
  let ieFailure: { message: string } | null = null;
  if (input.includeIe ?? true) {
    try {
      ie = await acquireNcsbeIeArtifacts({
        transport: input.transport,
        cacheDir: input.cacheDir,
        cycleYear: input.cycleYear,
        force: input.force,
        retrievedAt: input.retrievedAt,
        log: input.log,
      });
    } catch (error) {
      // An IE inventory failure must not throw away the committee results —
      // same isolation as a failing committee.
      ieFailure = { message: (error as Error).message };
      input.log?.(`IE acquisition: FAILED — ${(error as Error).message}`);
    }
  }

  return {
    cycleYear: input.cycleYear,
    cacheDir: input.cacheDir,
    committees,
    committeeFailures,
    ie,
    ieFailure,
  };
}
