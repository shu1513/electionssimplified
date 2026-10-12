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

import { isDeepStrictEqual } from "node:util";
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
  DelawareCfrsClientError,
  type DelawareCfrsResponseCapture,
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
  parseDelawareThirdPartyReceiptsCsv,
  type DelawareCommitteeGridRow,
  type DelawareFiledReportRow,
} from "./delawareCfrsParsers.js";
import {
  storeDelawareCfrsCommitteeArtifacts,
  type DelawareCfrsCommitteeArtifactManifest,
  type DelawareCfrsReportPdfInput,
} from "./delawareCfrsArtifactCache.js";

import {
  closeDelawareNativeLedger,
  decodeDelawareReceiptNativePage,
  decodeDelawareExpenseNativePage,
  type DelawareNativeLedger,
  type DelawareNativeLedgerPage,
} from "./delawareNativeLedger.js";

import type {
  DelawareOutsidePayerScope,
  DelawareOutsideCandidateScope,
  DelawareOutsideSourcePacket,
} from "./delawareThirdPartyOutsideSource.js";

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
    throw new Error(
      `CF_ID ${cfId} spans ${byMember.size} registry MemberIDs — identity ambiguous, not acquiring`
    );
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

function requireRowCount(
  label: string,
  rowCount: number,
  malformedRowCount: number,
  total: number | null
): number {
  if (malformedRowCount > 0) {
    throw new Error(
      `${label} CSV contains ${malformedRowCount} malformed row(s) — export drift, not acquiring`
    );
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
  const searchUrl = buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.filedReportsSearch, {
    ...DELAWARE_CFRS_THEME_QUERY,
  });
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
    throw new Error(
      `filed-reports grid incomplete: ${rows.length} rows rendered vs total ${total} — not acquiring`
    );
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
  const receiptsSearchUrl = buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.receiptsSearch, {
    ...DELAWARE_CFRS_THEME_QUERY,
  });
  const receiptsWarmupUrl = buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.receiptsEntry);
  await session.get(receiptsWarmupUrl);
  const receiptsTotal = await searchWithTransientZeroRetry(
    () =>
      session.postForm(
        receiptsSearchUrl,
        buildDelawareReceiptsSearchFields({
          txtReceivingRegistrant: committeeName,
          MemberId: String(memberId),
        }),
        { referer: receiptsWarmupUrl }
      ),
    "receipts",
    log
  );
  const receiptsCsv = await exportCsv(
    session,
    DELAWARE_CFRS_PAGES.receiptsExportCsv,
    receiptsSearchUrl,
    "receipts"
  );
  const receipts = parseDelawareReceiptsCsv(receiptsCsv);
  const receiptsSearchTotal = requireRowCount(
    "receipts",
    receipts.rows.length,
    receipts.malformedRowCount,
    receiptsTotal
  );
  for (const row of receipts.rows) {
    if (row.CF_ID !== cfId) {
      throw new Error(
        `receipts export carries CF_ID ${row.CF_ID}, expected ${cfId} — search mis-scoped, not acquiring`
      );
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
  const expensesCsv = await exportCsv(
    session,
    DELAWARE_CFRS_PAGES.expensesExportCsv,
    expensesSearchUrl,
    "expenses"
  );
  const expenses = parseDelawareExpensesCsv(expensesCsv);
  const expensesSearchTotal = requireRowCount(
    "expenses",
    expenses.rows.length,
    expenses.malformedRowCount,
    expensesTotal
  );
  for (const row of expenses.rows) {
    if (row["CF ID"] !== cfId) {
      throw new Error(
        `expenses export carries CF ID ${row["CF ID"]}, expected ${cfId} — search mis-scoped, not acquiring`
      );
    }
  }
  log(`[acquire ${cfId}] expenses: ${expenses.rows.length} rows`);

  // Filed reports (all editions) and every attached report PDF. The
  // cover-only sync refuses ambiguous editions; footer values cannot select.
  const filedReports = await fetchFiledReports(session, memberId, committeeName, log);
  for (const row of filedReports.rows) {
    if (row.cfId !== cfId) {
      throw new Error(
        `filed-report row carries CF_ID ${row.cfId}, expected ${cfId} — search mis-scoped, not acquiring`
      );
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

export type DelawareCfrsCandidateSourcePacketInput = {
  cfId: string;
  memberId: number;
  committeeName: string;
  /** Explicit null requests whole Member history with blank dates; neither mode certifies a legal cycle. */
  requestWindow: { start: string; end: string } | null;
  sessionOptions?: DelawareCfrsSessionOptions;
};
export type DelawareCfrsCandidateSourcePacket = {
  sourceCaptures: readonly DelawareCfrsResponseCapture[];
  registryRows: readonly Readonly<Record<string, unknown>>[];
  organizationUrls: readonly string[];
  diagnostics: readonly string[];
  requestWindow: { start: string; end: string } | null;
  queryScope: { kind: "bounded_window"; start: string; end: string } | { kind: "whole_member" };
  allVersionReportRows: readonly DelawareFiledReportRow[];
  latestAccountReportRows: readonly DelawareFiledReportRow[];
  reportPdfs: readonly DelawareCfrsReportPdfInput[];
  receiptsCsv: string;
  expensesCsv: string;
  receiptRenderedCount: number;
  expenseRenderedCount: number;
  receipts: DelawareNativeLedger;
  expenses: DelawareNativeLedger;
};
function packetDate(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value + "T00:00:00Z")) ||
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value
  )
    throw new Error("Invalid Delaware packet request date");
  return `${value.slice(5, 7)}/${value.slice(8, 10)}/${value.slice(0, 4)}`;
}
function observedOrganizationUrls(html: string, memberId: number, type: "01" | "04" = "01"): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])([^"']+)\1[^>]*>/gi)) {
    const raw = match[2]!.replace(/&amp;|&#38;/g, "&");
    if (!raw.startsWith("/Public/ShowReview?")) continue;
    const u = new URL(raw, buildDelawareCfrsUrl("/"));
    // The published link has spaces before '&'. Only trim individual public
    // query controls; names and financial source fields are never changed.
    const values = Object.fromEntries([...u.searchParams].map(([k, v]) => [k, v.trim()]));
    if (values.memberID !== String(memberId) || values.ftype !== "SO") continue;
    const keys = ["memberID", "memVersID", "cTypeCode", "ftype", "fpath", "fname", "isPublic"];
    if (
      u.origin !== new URL(buildDelawareCfrsUrl("/")).origin ||
      u.username ||
      u.password ||
      u.hash ||
      [...u.searchParams].length !== keys.length ||
      Object.keys(values).length !== keys.length ||
      keys.some((k) => !Object.hasOwn(values, k)) ||
      values.cTypeCode !== type ||
      !/^[1-9]\d*$/.test(values.memVersID!) ||
      !Number.isSafeInteger(Number(values.memVersID)) ||
      values.fpath !== "" ||
      values.fname !== "" ||
      values.isPublic !== "true"
    )
      throw new Error("Invalid observed Delaware organization link");
    found.add(buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.statementOfOrganization, values));
  }
  return [...found];
}
async function fetchPacketReportInventory(
  session: DelawareCfrsSession,
  memberId: number,
  name: string,
  cfId: string,
  current: boolean
): Promise<DelawareFiledReportRow[]> {
  const searchUrl = buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.filedReportsSearch, {
    ...DELAWARE_CFRS_THEME_QUERY,
  });
  await session.get(buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.filedReportsSearch));
  await session.postForm(searchUrl, {
    ...buildDelawareFiledReportsSearchFields({ MemberId: String(memberId), txtCommitteeName: name }),
    ...(current ? { hdnViewCurrent: "true", chkViewCurrReport: "on" } : {}),
  });
  const rows: DelawareFiledReportRow[] = [];
  let total: number | null = null;
  for (let page = 1; page <= MAX_GRID_PAGES; page++) {
    const response = await session.get(
      buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.filedReportsGridJson, {
        ajax: "True",
        "Grid-page": String(page),
        "Grid-orderBy": "~",
        "Grid-groupBy": "~",
        "Grid-filter": "~",
        "Grid-size": String(GRID_PAGE_SIZE),
        theme: "vista",
      }),
      { referer: searchUrl }
    );
    const parsed = parseDelawareFiledReportsHtml(response.text());
    if (
      parsed.total === null ||
      !Number.isSafeInteger(parsed.total) ||
      parsed.total < 0 ||
      (total !== null && total !== parsed.total) ||
      parsed.rows.length > GRID_PAGE_SIZE
    )
      throw new Error("Invalid/changed Delaware packet report count");
    total = parsed.total;
    if (
      parsed.rows.some(
        (r) =>
          r.cfId !== cfId ||
          r.committeeName.trim() !== name ||
          !r.document ||
          r.document.memberId !== memberId
      )
    )
      throw new Error("Wrong/missing Delaware packet report identity");
    rows.push(...parsed.rows);
    if (rows.length > total) throw new Error("Repeated/incomplete Delaware packet report pages");
    if (rows.length === total) {
      const ids = rows.map((r) => r.document!.publicReportFileName);
      if (new Set(ids).size !== ids.length) throw new Error("Duplicate Delaware packet report identity");
      return rows;
    }
    if (parsed.rows.length !== GRID_PAGE_SIZE) throw new Error("Incomplete Delaware packet report page");
  }
  throw new Error("Delaware packet report page cap");
}
async function fetchPacketNativePages(
  session: DelawareCfrsSession,
  kind: "receipts" | "expenses"
): Promise<{ pageNumber: number; pageSize: number; page: DelawareNativeLedgerPage }[]> {
  const pages: { pageNumber: number; pageSize: number; page: DelawareNativeLedgerPage }[] = [];
  for (let page = 1; page <= MAX_GRID_PAGES; page++) {
    const response = await session.postForm(
      buildDelawareCfrsUrl(
        kind === "receipts" ? DELAWARE_CFRS_PAGES.receiptsGridJson : DELAWARE_CFRS_PAGES.expensesGridJson,
        { "Grid-size": "15", theme: "vista" }
      ),
      { page: String(page), size: String(GRID_PAGE_SIZE), orderBy: "", groupBy: "", filter: "" },
      { xhr: true }
    );
    const decoded = (kind === "receipts" ? decodeDelawareReceiptNativePage : decodeDelawareExpenseNativePage)(
      response.text()
    );
    pages.push({ pageNumber: page, pageSize: GRID_PAGE_SIZE, page: decoded });
    if (decoded.rows.length < GRID_PAGE_SIZE) {
      return pages;
    }
  }
  throw new Error(`Delaware packet ${kind} native page cap`);
}
async function fetchPacketNativeLedger(
  session: DelawareCfrsSession,
  kind: "receipts" | "expenses",
  renderedCount: number,
  csvLoader: () => Promise<string>
): Promise<{ csv: string; ledger: DelawareNativeLedger }> {
  const pages = await fetchPacketNativePages(session, kind);
  const csv = await csvLoader();
  return { csv, ledger: closeDelawareNativeLedger({ pages, renderedCount, csv }) };
}
function packetSession(options: DelawareCfrsSessionOptions) {
  const sourceCaptures: DelawareCfrsResponseCapture[] = [];
  const observer = options.onResponseCapture;
  const session = createDelawareCfrsSession({
    ...options,
    onResponseCapture: async (c) => {
      sourceCaptures.push({
        ...c,
        body: Buffer.from(c.body),
        financeFields: c.financeFields === null ? null : { ...c.financeFields },
      });
      await observer?.(c);
    },
  });
  return { session, sourceCaptures };
}
async function fetchPacketOwnerSource(
  session: DelawareCfrsSession,
  scope: { cfId: string; memberId: number; committeeName: string; type: "01" | "04" }
) {
  const { cfId, memberId, committeeName, type } = scope;
  await session.get(buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.committeeSearch));
  const searched = await session.postForm(
    buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.committeeSearchPost, { ...DELAWARE_CFRS_THEME_QUERY }),
    buildDelawareCommitteeSearchFields({ CommitteeType: type, txtCommitteeID: cfId })
  );
  const registryRows: Readonly<Record<string, unknown>>[] = [];
  let total: number | null = null;
  let exhausted = false;
  for (let page = 1; page <= MAX_GRID_PAGES; page++) {
    const response = await session.postForm(
      buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.committeeGridJson, { ...DELAWARE_CFRS_THEME_QUERY }),
      { page: String(page), size: String(GRID_PAGE_SIZE), orderBy: "", groupBy: "", filter: "" },
      { xhr: true }
    );
    const parsed = parseDelawareCommitteeGridJson(response.text());
    if (
      parsed.total === null ||
      !Number.isSafeInteger(parsed.total) ||
      parsed.total < 0 ||
      (total !== null && total !== parsed.total) ||
      parsed.rows.length > GRID_PAGE_SIZE
    )
      throw new Error("Invalid/changed Delaware packet registry count");
    total = parsed.total;
    registryRows.push(...(structuredClone(JSON.parse(response.text()).data) as Record<string, unknown>[]));
    if (registryRows.length > total) throw new Error("Repeated Delaware packet registry pages");
    if (registryRows.length === total) {
      exhausted = true;
      break;
    }
    if (parsed.rows.length !== GRID_PAGE_SIZE) throw new Error("Incomplete Delaware packet registry pages");
  }
  if (!exhausted) throw new Error("Delaware packet registry page cap");
  const matches = registryRows.filter((r) => r.Committee_Id === cfId);
  if (
    !matches.length ||
    matches.some(
      (r) =>
        r.MemberID !== memberId ||
        r.CommitteeTypeCode !== type ||
        typeof r.CommitteeName !== "string" ||
        r.CommitteeName.trim() !== committeeName
    )
  )
    throw new Error("Delaware packet registry receiver mismatch");
  const organizationUrls = observedOrganizationUrls(searched.text(), memberId, type);
  const diagnostics: string[] = [];
  const observedVersions = new Set<number>();
  for (const organizationUrl of organizationUrls) {
    const sourceVersion = Number(new URL(organizationUrl).searchParams.get("memVersID"));
    if (!matches.some((r) => r.MemberVersID === sourceVersion))
      throw new Error("Observed Delaware SO link is absent from full registry");
    observedVersions.add(sourceVersion);
    await session.get(organizationUrl);
  }
  if (!organizationUrls.length)
    diagnostics.push("No observed organization links; identity authority unavailable.");
  if (matches.some((r) => !observedVersions.has(Number(r.MemberVersID))))
    diagnostics.push("Registry editions lack observed SO links; identity authority unresolved.");
  return { registryRows, organizationUrls, diagnostics };
}
/**
 * Fetches source observations and structurally closed ledgers only. Does not
 * certify legal cycle, current report editions, PAC money or outside money;
 * does not write an artifact cache or database. Existing acquire defaults stay separate.
 */
export async function fetchDelawareCfrsCandidateSourcePacket(
  original: DelawareCfrsCandidateSourcePacketInput
): Promise<DelawareCfrsCandidateSourcePacket> {
  const input = {
    ...original,
    requestWindow: original.requestWindow === null ? null : { ...original.requestWindow },
    sessionOptions: { ...original.sessionOptions },
  };
  const { cfId, memberId } = input;
  const committeeName = input.committeeName.trim();
  if (
    !/^01\d{6}$/.test(cfId) ||
    !Number.isSafeInteger(memberId) ||
    memberId <= 0 ||
    !committeeName ||
    (input.requestWindow !== null && input.requestWindow.start > input.requestWindow.end)
  )
    throw new Error("Invalid Delaware candidate packet scope");
  const start = input.requestWindow === null ? "" : packetDate(input.requestWindow.start),
    end = input.requestWindow === null ? "" : packetDate(input.requestWindow.end);
  const { session, sourceCaptures } = packetSession(input.sessionOptions);
  const { registryRows, organizationUrls, diagnostics } = await fetchPacketOwnerSource(session, {
    cfId,
    memberId,
    committeeName,
    type: "01",
  });
  const allVersionReportRows = await fetchPacketReportInventory(
    session,
    memberId,
    committeeName,
    cfId,
    false
  );
  const latestAccountReportRows = await fetchPacketReportInventory(
    session,
    memberId,
    committeeName,
    cfId,
    true
  );
  const reportPdfs = await fetchReportPdfs(
    session,
    [...allVersionReportRows, ...latestAccountReportRows],
    memberId
  );
  packetPdfsValid(reportPdfs);
  const receiptSearchUrl = buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.receiptsSearch, {
    ...DELAWARE_CFRS_THEME_QUERY,
  });
  const receiptEntryUrl = buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.receiptsEntry);
  await session.get(receiptEntryUrl);
  const receiptRenderedCount = await searchWithTransientZeroRetry(
    () =>
      session.postForm(
        receiptSearchUrl,
        buildDelawareReceiptsSearchFields({
          MemberId: String(memberId),
          txtReceivingRegistrant: committeeName,
          dtStartDate: start,
          dtEndDate: end,
        }),
        { referer: receiptEntryUrl }
      ),
    "packet receipts",
    () => {}
  );
  if (receiptRenderedCount === null) throw new Error("Missing Delaware packet receipts count");
  const receipts = await fetchPacketNativeLedger(session, "receipts", receiptRenderedCount, () =>
    exportCsv(session, DELAWARE_CFRS_PAGES.receiptsExportCsv, receiptSearchUrl, "packet receipts")
  );
  const expenseSearchUrl = buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.expensesSearchPost, {
    ...DELAWARE_CFRS_THEME_QUERY,
  });
  await session.get(buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.expensesSearch));
  const expenseRenderedCount = await searchWithTransientZeroRetry(
    () =>
      session.postForm(
        expenseSearchUrl,
        buildDelawareExpensesSearchFields({
          MemberId: String(memberId),
          txtRegistrant: committeeName,
          CommitteeType: "01",
          dtStartDate: start,
          dtEndDate: end,
        })
      ),
    "packet expenses",
    () => {}
  );
  if (expenseRenderedCount === null) throw new Error("Missing Delaware packet expenses count");
  const expenses = await fetchPacketNativeLedger(session, "expenses", expenseRenderedCount, () =>
    exportCsv(session, DELAWARE_CFRS_PAGES.expensesExportCsv, expenseSearchUrl, "packet expenses")
  );
  for (const [ledger, field] of [
    [receipts.ledger, "WC_ID"],
    [expenses.ledger, "CCF_ID"],
  ] as const)
    if (
      ledger.rows.some(
        (r) =>
          r.rawFields[field] !== cfId ||
          (input.requestWindow !== null &&
            (r.date < input.requestWindow.start || r.date > input.requestWindow.end))
      )
    )
      throw new Error("Delaware packet financial row outside requested account/window");
  return {
    sourceCaptures,
    registryRows,
    organizationUrls,
    diagnostics,
    requestWindow: input.requestWindow,
    queryScope: input.requestWindow === null
      ? { kind: "whole_member" }
      : { kind: "bounded_window", ...input.requestWindow },
    allVersionReportRows,
    latestAccountReportRows,
    reportPdfs,
    receiptsCsv: receipts.csv,
    expensesCsv: expenses.csv,
    receiptRenderedCount,
    expenseRenderedCount,
    receipts: receipts.ledger,
    expenses: expenses.ledger,
  };
}

export type DelawareCfrsThirdPartySourcePacketInput = {
  payer: DelawareOutsidePayerScope;
  candidate: DelawareOutsideCandidateScope;
  sessionOptions?: DelawareCfrsSessionOptions;
};
export type DelawareCfrsThirdPartySourcePacketResult = {
  packet?: DelawareOutsideSourcePacket;
  sourceCaptures: readonly DelawareCfrsResponseCapture[];
  diagnostics: readonly string[];
};
function packetNativeUnion(pages: readonly { page: DelawareNativeLedgerPage }[]) {
  const rows: DelawareNativeLedgerPage["rows"][number][] = [];
  const byId = new Map<number, DelawareNativeLedgerPage["rows"][number]>();
  pages.forEach((p, i) =>
    p.page.rows.forEach((r, j) => {
      const previous = byId.get(r.transactionId);
      if (previous) {
        if (
          j !== 0 ||
          i === 0 ||
          pages[i - 1]!.page.rows.at(-1)?.transactionId !== r.transactionId ||
          !isDeepStrictEqual(previous.rawFields, r.rawFields)
        )
          throw new Error("Conflicting/repeated Delaware packet native ID");
      } else {
        byId.set(r.transactionId, r);
        rows.push(r);
      }
    })
  );
  return rows;
}
function packetPdfsValid(pdfs: readonly DelawareCfrsReportPdfInput[]) {
  if (
    pdfs.some(
      (p) => p.body.byteLength > 4 * 1024 * 1024 || p.body.subarray(0, 5).toString("ascii") !== "%PDF-"
    )
  )
    throw new Error("Invalid/bounded Delaware packet PDF bytes");
}
/** Observed source facets only. Does not verify a current financial generation or write cache/DB. */
export async function fetchDelawareCfrsThirdPartySourcePacket(
  original: DelawareCfrsThirdPartySourcePacketInput
): Promise<DelawareCfrsThirdPartySourcePacketResult> {
  const input = {
    payer: { ...original.payer },
    candidate: { ...original.candidate },
    sessionOptions: { ...original.sessionOptions },
  };
  const p = input.payer,
    c = input.candidate;
  p.committeeName = p.committeeName.trim();
  c.receivingCommitteeName = c.receivingCommitteeName.trim();
  if (
    !/^04\d{6}$/.test(p.cfId) ||
    p.committeeType !== "04" ||
    !Number.isSafeInteger(p.memberId) ||
    p.memberId <= 0 ||
    !p.committeeName ||
    !/^01\d{6}$/.test(c.receivingCfId) ||
    !Number.isSafeInteger(c.receivingMemberId) ||
    c.receivingMemberId <= 0 ||
    !c.receivingCommitteeName
  )
    throw new Error("Invalid Delaware third-party packet owner scope");
  const { session, sourceCaptures } = packetSession(input.sessionOptions);
  const diagnostics: string[] = [];
  let operationName = "payer identity";
  // Bound by actual operation callbacks, never by rewritten timestamps or assumed phases.
  const take = async <T>(operation: () => Promise<T>) => {
    const start = sourceCaptures.length;
    const value = await operation();
    return { value, captures: sourceCaptures.slice(start).filter((c) => c.status === 200) };
  };
  try {
    const payerOwner = await take(() => fetchPacketOwnerSource(session, { ...p, type: "04" }));
    operationName = "receiver identity";
    const receiverOwner = await take(() =>
      fetchPacketOwnerSource(session, {
        cfId: c.receivingCfId,
        memberId: c.receivingMemberId,
        committeeName: c.receivingCommitteeName,
        type: "01",
      })
    );
    diagnostics.push(...payerOwner.value.diagnostics, ...receiverOwner.value.diagnostics);
    operationName = "payer all-version inventory";
    const all = await take(() =>
      fetchPacketReportInventory(session, p.memberId, p.committeeName, p.cfId, false)
    );
    operationName = "payer latest-account inventory";
    const latest = await take(() =>
      fetchPacketReportInventory(session, p.memberId, p.committeeName, p.cfId, true)
    );
    operationName = "payer PDFs";
    const payerPdfs = await take(() => fetchReportPdfs(session, [...all.value, ...latest.value], p.memberId));
    packetPdfsValid(payerPdfs.value);
    operationName = "receiver all-version inventory";
    const receiverReports = await take(() =>
      fetchPacketReportInventory(
        session,
        c.receivingMemberId,
        c.receivingCommitteeName,
        c.receivingCfId,
        false
      )
    );
    operationName = "receiver PDFs";
    const receiverPdfs = await take(() =>
      fetchReportPdfs(session, receiverReports.value, c.receivingMemberId)
    );
    packetPdfsValid(receiverPdfs.value);
    const receiptUrl = buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.receiptsSearch, {
      ...DELAWARE_CFRS_THEME_QUERY,
    });
    const receiptEntry = buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.receiptsEntry);
    operationName = "generic Member receipts";
    const generic = await take(async () => {
      await session.get(receiptEntry);
      const count = await searchWithTransientZeroRetry(
        () =>
          session.postForm(
            receiptUrl,
            buildDelawareReceiptsSearchFields({
              MemberId: String(p.memberId),
              txtReceivingRegistrant: p.committeeName,
            }),
            { referer: receiptEntry }
          ),
        "third-party generic receipts",
        () => {}
      );
      if (count === null) throw new Error("Missing generic Member receipt rendered count");
      const rows = packetNativeUnion(await fetchPacketNativePages(session, "receipts"));
      if (
        rows.length !== count ||
        rows.some(
          (r) =>
            r.rawFields.WC_ID !== p.cfId ||
            typeof r.rawFields.ReceivingCommitteeName !== "string" ||
            r.rawFields.ReceivingCommitteeName.trim() !== p.committeeName
        )
      )
        throw new Error("Generic Member native receipt count/owner mismatch");
      return count;
    });
    operationName = "TP8 receipts";
    const tp = await take(async () => {
      await session.get(receiptEntry);
      const count = await searchWithTransientZeroRetry(
        () =>
          session.postForm(
            receiptUrl,
            {
              ...buildDelawareReceiptsSearchFields({
                MemberId: String(p.memberId),
                txtReceivingRegistrant: p.committeeName,
                hdnTP: "1",
              }),
              chkTP: "3",
            },
            { referer: receiptEntry }
          ),
        "third-party TP8 receipts",
        () => {}
      );
      const exported = await exportCsv(
        session,
        DELAWARE_CFRS_PAGES.receiptsThirdPartyExportCsv,
        receiptUrl,
        "TP8 receipts"
      );
      const decoded = parseDelawareThirdPartyReceiptsCsv(exported);
      if (
        count === null ||
        decoded.malformedRowCount ||
        decoded.rows.length !== count ||
        count !== generic.value ||
        decoded.rows.some((r) => r["Receiving Committee"].trim() !== p.committeeName)
      )
        throw new Error("TP8 receipt rendered/count/owner mismatch");
      return count;
    });
    const expenseUrl = buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.expensesSearchPost, {
      ...DELAWARE_CFRS_THEME_QUERY,
    });
    operationName = "payer expenses";
    const expenses = await take(async () => {
      await session.get(buildDelawareCfrsUrl(DELAWARE_CFRS_PAGES.expensesSearch));
      const count = await searchWithTransientZeroRetry(
        () =>
          session.postForm(
            expenseUrl,
            buildDelawareExpensesSearchFields({
              MemberId: String(p.memberId),
              txtRegistrant: p.committeeName,
              CommitteeType: "04",
            })
          ),
        "third-party expenses",
        () => {}
      );
      if (count === null) throw new Error("Missing third-party expense rendered count");
      const ledger = await fetchPacketNativeLedger(session, "expenses", count, () =>
        exportCsv(session, DELAWARE_CFRS_PAGES.expensesExportCsv, expenseUrl, "third-party expenses")
      );
      if (
        ledger.ledger.rows.some(
          (r) =>
            r.rawFields.CCF_ID !== p.cfId ||
            typeof r.rawFields.RegistrantName !== "string" ||
            r.rawFields.RegistrantName.trim() !== p.committeeName
        )
      )
        throw new Error("Third-party expense owner mismatch");
      return count;
    });
    const packet: DelawareOutsideSourcePacket = {
      registry: payerOwner.captures.filter(
        (c) => new URL(c.url).pathname !== DELAWARE_CFRS_PAGES.statementOfOrganization
      ),
      payerOrganization: payerOwner.captures.filter(
        (c) => new URL(c.url).pathname === DELAWARE_CFRS_PAGES.statementOfOrganization
      ),
      receiverIdentity: receiverOwner.captures,
      candidateCycleAuthority: [...receiverReports.captures, ...receiverPdfs.captures],
      allVersionReports: all.captures,
      latestAccountReport: latest.captures,
      genericMemberReceipts: generic.captures,
      thirdPartyReceiptExport: tp.captures,
      expenses: expenses.captures,
      reportPdfs: payerPdfs.captures,
    };
    return { packet, sourceCaptures, diagnostics };
  } catch (error) {
    if (error instanceof DelawareCfrsClientError && error.code === "capture_error") throw error;
    return {
      sourceCaptures,
      diagnostics: [
        ...diagnostics,
        `Delaware third-party packet ${operationName} failed (${error instanceof DelawareCfrsClientError ? error.code : "invalid source facts"}).`,
      ],
    };
  }
}
