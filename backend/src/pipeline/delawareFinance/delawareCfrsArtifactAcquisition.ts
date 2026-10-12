// Delaware CFRS artifact acquisition (docs/plans/plan-delaware-finance.md Phase 2).
//
// The one component that touches the live portal for money data: it runs the
// probe-proven choreography for a single committee and lands the result as an
// atomic artifact-cache bundle (staged in full, then swapped in). The sync
// stays strictly cache-only — anything this layer cannot prove it fetched
// completely is thrown away, never cached.
//
// Flow, one fresh session per committee (searches are session-bound server
// state; the session's single-flight queue keeps them ordered):
//   1. Registry lookup: type-01 committee search + grid JSON, filtered
//      client-side by CF_ID -> the committee's MemberID (acquisition key,
//      never in product tables) and current registered name. The client-side
//      filter means correctness never depends on the portal honoring the
//      txtCommitteeID field — worst case the full type-01 registry pages
//      through (the probe-proven path) and the filter still lands.
//   2. Receipts search POST + full CSV export; 3. expenses likewise;
//   4. filed-reports search + rendered grid; 5. every report PDF.
//   6. Store the bundle (parsers re-validate; manifest commits it).
//
// The results page sometimes renders total:0 transiently on a valid search
// (portal quirk, seen three times live 2026-08-27) — every search here
// re-POSTs up to MAX_SEARCH_ATTEMPTS times before a zero total is believed,
// and the CSV row count must equal the final rendered total or the bundle is
// rejected (a persistent transient zero can never cache a truncated bundle).
//
// PII: receipts exports carry contributor street addresses — bodies go
// straight into the restricted cache and are never logged.

import {
  DELAWARE_CFRS_EXPORT_QUERY,
  DELAWARE_CFRS_PAGES,
  DELAWARE_CFRS_THEME_QUERY,
  buildDelawareCfrsUrl,
  buildDelawareCommitteeSearchFields,
  buildDelawareExpensesSearchFields,
  buildDelawareFiledReportsSearchFields,
  buildDelawareReceiptsSearchFields,
  createDelawareCfrsSession,
  looksLikeDelawareCfrsHtml,
  type DelawareCfrsResponse,
  type DelawareCfrsSession,
  type DelawareCfrsSessionOptions,
} from "./delawareCfrsClient.js";
import {
  extractDelawareGridTotal,
  parseDelawareCommitteeGridJson,
  parseDelawareExpensesCsv,
  parseDelawareFiledReportsHtml,
  parseDelawareReceiptsCsv,
  type DelawareCommitteeGridRow,
  type DelawareFiledReportRow,
} from "./delawareCfrsParsers.js";
import {
  storeDelawareCfrsCommitteeArtifacts,
  type DelawareCfrsCommitteeArtifactManifest,
  type DelawareCfrsReportPdfInput,
} from "./delawareCfrsArtifactCache.js";

const MAX_SEARCH_ATTEMPTS = 3;
const GRID_PAGE_SIZE = 500;
const MAX_GRID_PAGES = 40;

export type DelawareCfrsAcquisitionInput = {
  cfId: string;
  cacheDir?: string;
  sessionOptions?: DelawareCfrsSessionOptions;
  retrievedAt?: Date;
  log?: (message: string) => void;
  storeFn?: typeof storeDelawareCfrsCommitteeArtifacts;
};

export type DelawareCfrsAcquisitionResult = {
  manifest: DelawareCfrsCommitteeArtifactManifest;
  committeeName: string;
  receiptRowCount: number;
  expenseRowCount: number;
  filedReportCount: number;
  reportPdfCount: number;
};

/**
 * Registry lookup: CF_ID -> { memberId, committeeName }. The search narrows
 * by txtCommitteeID as a hint, but identity is decided by the client-side
 * CF_ID filter over the paged grid rows. One row per statement version —
 * the last row per member carries the current registration, so it wins.
 */
async function resolveCommitteeRegistration(
  session: DelawareCfrsSession,
  cfId: string
): Promise<{ memberId: number; committeeName: string }> {
  await session.get(buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.committeeSearch));
  await session.postForm(
    buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.committeeSearchPost, { ...DELAWARE_CFRS_THEME_QUERY }),
    buildDelawareCommitteeSearchFields({ CommitteeType: "01", txtCommitteeID: cfId })
  );
  const byMember = new Map<number, DelawareCommitteeGridRow>();
  let registryExhausted = false;
  for (let page = 1; page <= MAX_GRID_PAGES; page += 1) {
    const gridResponse = await session.postForm(
      buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.committeeGridJson, { ...DELAWARE_CFRS_THEME_QUERY }),
      { page: String(page), size: String(GRID_PAGE_SIZE), orderBy: "", groupBy: "", filter: "" },
      { xhr: true }
    );
    const parsed = parseDelawareCommitteeGridJson(gridResponse.text());
    for (const row of parsed.rows) {
      if (row.cfId === cfId) {
        byMember.set(row.memberId, row);
      }
    }
    if (parsed.rows.length < GRID_PAGE_SIZE) {
      registryExhausted = true;
      break;
    }
  }
  // A full final page means the cap ended the sweep, not the data — a later
  // page could still carry the (or a conflicting) CF_ID row.
  if (!registryExhausted) {
    throw new Error(
      `committee registry sweep hit the ${MAX_GRID_PAGES}-page cap without exhausting the grid — not resolving CF_ID ${cfId}`
    );
  }
  if (byMember.size === 0) {
    throw new Error(`no CFRS type-01 registry row carries CF_ID ${cfId}`);
  }
  if (byMember.size > 1) {
    throw new Error(`CF_ID ${cfId} spans ${byMember.size} registry MemberIDs — identity ambiguous, not acquiring`);
  }
  const row = [...byMember.values()][0]!;
  return { memberId: row.memberId, committeeName: row.committeeName };
}

/**
 * POSTs a search up to MAX_SEARCH_ATTEMPTS times, re-POSTing whenever the
 * results page renders a missing or zero grid total (the transient-`total:0`
 * portal quirk). Returns the last rendered total — a genuinely empty result
 * still comes back as 0 and is judged by the caller's count==total gate.
 */
async function searchWithTransientZeroRetry(
  post: () => Promise<DelawareCfrsResponse>,
  label: string,
  log: (message: string) => void
): Promise<number | null> {
  let total: number | null = null;
  for (let attempt = 1; attempt <= MAX_SEARCH_ATTEMPTS; attempt += 1) {
    const response = await post();
    total = extractDelawareGridTotal(response.text());
    if (total !== null && total > 0) {
      return total;
    }
    if (attempt < MAX_SEARCH_ATTEMPTS) {
      log(`[${label}] search rendered total=${total} (transient portal quirk) — re-POSTing the search`);
    }
  }
  return total;
}

async function exportCsv(
  session: DelawareCfrsSession,
  exportPath: string,
  refererUrl: string,
  label: string
): Promise<string> {
  const response = await session.get(buildDelawareCfrsUrl(exportPath, { ...DELAWARE_CFRS_EXPORT_QUERY }), {
    referer: refererUrl,
  });
  const text = response.text();
  if (looksLikeDelawareCfrsHtml(text)) {
    throw new Error(`${label} export answered HTML, not CSV — stored search lost or portal drift`);
  }
  return text;
}

function requireRowCount(label: string, rowCount: number, malformedRowCount: number, total: number | null): number {
  if (malformedRowCount > 0) {
    throw new Error(`${label} CSV contains ${malformedRowCount} malformed row(s) — export drift, not acquiring`);
  }
  if (total === null) {
    throw new Error(`${label} search page rendered no grid total — layout drift, not acquiring`);
  }
  if (rowCount !== total) {
    throw new Error(`${label} CSV rows (${rowCount}) != rendered search total (${total}) — not acquiring`);
  }
  return total;
}

async function fetchFiledReports(
  session: DelawareCfrsSession,
  memberId: number,
  committeeName: string,
  log: (message: string) => void
): Promise<{ html: string; rows: DelawareFiledReportRow[] }> {
  const searchUrl = buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.filedReportsSearch, { ...DELAWARE_CFRS_THEME_QUERY });
  let html = "";
  let rows: DelawareFiledReportRow[] = [];
  let total: number | null = null;
  for (let attempt = 1; attempt <= MAX_SEARCH_ATTEMPTS; attempt += 1) {
    await session.get(buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.filedReportsSearch));
    await session.postForm(
      searchUrl,
      buildDelawareFiledReportsSearchFields({ txtCommitteeName: committeeName, MemberId: String(memberId) })
    );
    const gridResponse = await session.get(
      buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.filedReportsGridJson, {
        ajax: "True",
        "Grid-page": "1",
        "Grid-orderBy": "~",
        "Grid-groupBy": "~",
        "Grid-filter": "~",
        "Grid-size": String(GRID_PAGE_SIZE),
        theme: "vista",
      }),
      { referer: searchUrl }
    );
    html = gridResponse.text();
    const parsed = parseDelawareFiledReportsHtml(html);
    rows = parsed.rows;
    total = parsed.total;
    if (rows.length > 0) {
      break;
    }
    if (attempt < MAX_SEARCH_ATTEMPTS) {
      log(`[filed-reports] grid rendered ${rows.length} rows (total=${total}) — re-POSTing the search`);
    }
  }
  // The grid config always carries a numeric total live; a missing one is
  // layout drift, and without it a truncated slice would pass silently.
  if (total === null) {
    throw new Error("filed-reports grid rendered no total — layout drift, not acquiring");
  }
  // Grid-size renders the whole slice for any real candidate committee
  // (2 reports/year); a bigger result would be silent truncation.
  if (rows.length !== total) {
    throw new Error(`filed-reports grid incomplete: ${rows.length} rows rendered vs total ${total} — not acquiring`);
  }
  return { html, rows };
}

async function fetchReportPdfs(
  session: DelawareCfrsSession,
  rows: readonly DelawareFiledReportRow[],
  memberId: number
): Promise<DelawareCfrsReportPdfInput[]> {
  const byFileName = new Map<string, { filingCalendarId: number }>();
  for (const row of rows) {
    // The sync unconditionally rejects a bundle whose report rows lack a
    // document (covers are unverifiable) — caching one could only replace a
    // syncable bundle with a guaranteed-failing one, so gate here instead.
    if (row.document === null) {
      throw new Error(
        `filed report [${row.filingPeriodName}] has no document link — covers unverifiable, not acquiring`
      );
    }
    if (row.document.memberId !== memberId) {
      throw new Error(
        `filed-report document MemberID ${row.document.memberId} does not match registry MemberID ${memberId}`
      );
    }
    const existing = byFileName.get(row.document.publicReportFileName);
    if (existing !== undefined && existing.filingCalendarId !== row.document.filingCalendarId) {
      throw new Error(
        `report file ${row.document.publicReportFileName} claims two FilingCalendarIDs — lineage ambiguous, not acquiring`
      );
    }
    byFileName.set(row.document.publicReportFileName, { filingCalendarId: row.document.filingCalendarId });
  }
  const pdfs: DelawareCfrsReportPdfInput[] = [];
  for (const [publicReportFileName, { filingCalendarId }] of byFileName) {
    const response = await session.get(
      buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.filedReportPdf, {
        FileName: publicReportFileName,
        CommitteeID: String(memberId),
        FilingCalendarID: String(filingCalendarId),
      })
    );
    if (!(response.contentType ?? "").includes("pdf")) {
      throw new Error(
        `report download for ${publicReportFileName} answered ${response.contentType ?? "no content-type"}, not a PDF`
      );
    }
    pdfs.push({ publicReportFileName, filingCalendarId, body: response.body });
  }
  return pdfs;
}

/**
 * Fetches one committee's complete artifact set from the live portal and
 * commits it to the artifact cache. Every gate throws before the store call,
 * and the store itself stages then swaps — a failed acquisition always
 * leaves the previous bundle (if any) untouched.
 */
export async function acquireDelawareCfrsCommitteeArtifacts(
  input: DelawareCfrsAcquisitionInput
): Promise<DelawareCfrsAcquisitionResult> {
  const cfId = input.cfId.trim();
  if (!/^\d{8}$/.test(cfId)) {
    throw new Error(`Invalid Delaware CF_ID for acquisition: ${input.cfId}`);
  }
  const log = input.log ?? ((message: string) => console.log(message));
  const session = createDelawareCfrsSession(input.sessionOptions ?? {});

  const { memberId, committeeName } = await resolveCommitteeRegistration(session, cfId);
  log(`[acquire ${cfId}] registry: MemberID ${memberId}, committee "${committeeName}"`);

  // Receipts: warmup GET -> full-field search POST (transient-zero retry) ->
  // full CSV export of the stored search.
  const receiptsSearchUrl = buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.receiptsSearch, { ...DELAWARE_CFRS_THEME_QUERY });
  const receiptsWarmupUrl = buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.receiptsEntry);
  await session.get(receiptsWarmupUrl);
  const receiptsTotal = await searchWithTransientZeroRetry(
    () =>
      session.postForm(
        receiptsSearchUrl,
        buildDelawareReceiptsSearchFields({ txtReceivingRegistrant: committeeName, MemberId: String(memberId) }),
        { referer: receiptsWarmupUrl }
      ),
    "receipts",
    log
  );
  const receiptsCsv = await exportCsv(session, DELAWARE_CFRS_PAGES.receiptsExportCsv, receiptsSearchUrl, "receipts");
  const receipts = parseDelawareReceiptsCsv(receiptsCsv);
  const receiptsSearchTotal = requireRowCount("receipts", receipts.rows.length, receipts.malformedRowCount, receiptsTotal);
  for (const row of receipts.rows) {
    if (row.CF_ID !== cfId) {
      throw new Error(`receipts export carries CF_ID ${row.CF_ID}, expected ${cfId} — search mis-scoped, not acquiring`);
    }
  }
  log(`[acquire ${cfId}] receipts: ${receipts.rows.length} rows`);

  // Expenses: warmup GET -> OtherSearch POST (transient-zero retry) -> export.
  const expensesSearchUrl = buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.expensesSearchPost, {
    ...DELAWARE_CFRS_THEME_QUERY,
  });
  await session.get(buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.expensesSearch));
  const expensesTotal = await searchWithTransientZeroRetry(
    () =>
      session.postForm(
        expensesSearchUrl,
        buildDelawareExpensesSearchFields({ txtRegistrant: committeeName, MemberId: String(memberId) })
      ),
    "expenses",
    log
  );
  const expensesCsv = await exportCsv(session, DELAWARE_CFRS_PAGES.expensesExportCsv, expensesSearchUrl, "expenses");
  const expenses = parseDelawareExpensesCsv(expensesCsv);
  const expensesSearchTotal = requireRowCount("expenses", expenses.rows.length, expenses.malformedRowCount, expensesTotal);
  for (const row of expenses.rows) {
    if (row["CF ID"] !== cfId) {
      throw new Error(`expenses export carries CF ID ${row["CF ID"]}, expected ${cfId} — search mis-scoped, not acquiring`);
    }
  }
  log(`[acquire ${cfId}] expenses: ${expenses.rows.length} rows`);

  // Filed reports (all editions) and every attached report PDF. The
  // cover-only sync refuses ambiguous editions; footer values cannot select.
  const filedReports = await fetchFiledReports(session, memberId, committeeName, log);
  for (const row of filedReports.rows) {
    if (row.cfId !== cfId) {
      throw new Error(`filed-report row carries CF_ID ${row.cfId}, expected ${cfId} — search mis-scoped, not acquiring`);
    }
  }
  const reportPdfs = await fetchReportPdfs(session, filedReports.rows, memberId);
  log(`[acquire ${cfId}] filed reports: ${filedReports.rows.length} rows, ${reportPdfs.length} PDFs`);

  const store = input.storeFn ?? storeDelawareCfrsCommitteeArtifacts;
  const manifest = await store({
    cacheDir: input.cacheDir,
    cfId,
    memberId,
    sourceUrl: receiptsSearchUrl,
    receiptsCsv,
    receiptsSearchTotal,
    expensesCsv,
    expensesSearchTotal,
    filedReportsHtml: filedReports.html,
    reportPdfs,
    retrievedAt: input.retrievedAt,
  });
  return {
    manifest,
    committeeName,
    receiptRowCount: receipts.rows.length,
    expenseRowCount: expenses.rows.length,
    filedReportCount: filedReports.rows.length,
    reportPdfCount: reportPdfs.length,
  };
}
