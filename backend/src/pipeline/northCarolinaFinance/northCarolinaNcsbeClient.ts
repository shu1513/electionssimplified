import {
  parseNcsbeCommitteeSearchPage,
  parseNcsbeDocumentListPage,
  parseNcsbeExpendituresPage,
  parseNcsbeReceiptsPage,
  parseNcsbeReportDetailPage,
  type NcsbeCommitteeSearchRow,
  type NcsbeDocumentRow,
  type NcsbeExpenditureRow,
  type NcsbeReceiptRow,
  type NcsbeReportDetail,
} from "./northCarolinaNcsbeParsers.js";

// HTTP client for the NCSBE portal. Every route lives here and nowhere else
// (docs/plans/north_carolina_plan.md decision 10 — the state is actively replacing this
// early-2000s ASP.NET app, so route changes must be one-module migrations).
// Transport is fail-closed per decision 9: bodies are validated by shape
// (the server labels real JSON `text/html`), transaction fetches page until
// the row count equals `recordCountKey`, and any mismatch fails the report.
//
// Retrieval is polite by construction (decision 10): one request in flight,
// a fixed delay before every request after the first, bounded retries with
// backoff, and a descriptive user agent. ~60 spike requests at 2 s pacing
// drew zero blocks or 429s; full-cycle scale is unproven, so the pacing is
// not negotiable.

export const NCSBE_PORTAL_BASE_URL = "https://cf.ncsbe.gov";

export const DEFAULT_NCSBE_USER_AGENT = "VoteApp election research (https://electionssimplified.com)";

// Delay before each request after the first. The spike ran at 2 s.
export const DEFAULT_NCSBE_REQUEST_SPACING_MS = 2_000;

export const DEFAULT_NCSBE_REQUEST_TIMEOUT_MS = 90_000;

// The server ignores pageSize and always serves 300-row pages (spike results
// item 1; still true of the redesigned grid handlers, checked live
// 2026-10-10 on a 121,132-row report). It is sent with the observed fixed
// size anyway.
export const NCSBE_TRANSACTION_PAGE_SIZE = 300;

// The three IE doc-type codes (decision 3): unregistered IE reports,
// registered-committee IE informational reports, and electioneering reports.
export const NCSBE_IE_DOC_TYPE_CODES = ["IRIEX", "IRCIX", "RPIER"] as const;

// Sanity ceiling on a report's claimed row count. The largest real report the
// spike saw was 121,124 rows (~404 pages); a corrupted or absurd
// recordCountKey must fail the report instead of driving a paced fetch loop
// for hours.
export const NCSBE_MAX_TRANSACTION_ROWS = 1_000_000;

function requireNcsbeReportId(reportId: string): string {
  const trimmed = reportId.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid NCSBE report id: ${JSON.stringify(reportId)}`);
  }
  return trimmed;
}

function requireNcsbeOrgGroupId(orgGroupId: number): number {
  if (!Number.isInteger(orgGroupId) || orgGroupId <= 0) {
    throw new Error(`Invalid NCSBE OrgGroupID: ${orgGroupId}`);
  }
  return orgGroupId;
}

export function requireNcsbeYear(year: number): number {
  if (!Number.isInteger(year) || year < 1990 || year > 2100) {
    throw new Error(`Invalid NCSBE year: ${year}`);
  }
  return year;
}

export function ncsbeCommitteeSearchUrl(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error("NCSBE committee search needs a non-empty name");
  }
  return (
    `${NCSBE_PORTAL_BASE_URL}/CFOrgLkup/CommitteeGeneralResult/?name=${encodeURIComponent(trimmed)}` +
    "&useOrgName=True&useCandName=True&useInHouseName=True&useAcronym=False"
  );
}

export function ncsbeDocumentInventoryUrl(input: { orgGroupId: number; sboeId: string }): string {
  const sboeId = input.sboeId.trim();
  if (sboeId.length === 0) {
    throw new Error("NCSBE document inventory needs a non-empty SBoEID");
  }
  return (
    `${NCSBE_PORTAL_BASE_URL}/CFOrgLkup/DocumentGeneralResult/` +
    `?OGID=${requireNcsbeOrgGroupId(input.orgGroupId)}&SID=${encodeURIComponent(sboeId)}`
  );
}

export function ncsbeReportDetailUrl(reportId: string): string {
  return `${NCSBE_PORTAL_BASE_URL}/CFOrgLkup/ReportDetail/?RID=${requireNcsbeReportId(reportId)}&TP=ALL`;
}

// Transaction rows come from the report page's own Kendo grid read handlers
// (portal redesign seen live 2026-10-10; the old GetReceipts/GetExpenditures
// routes now 404). They only answer a POST carrying the page number and an
// anti-forgery token — query-string paging is ignored — so the page lives in
// the form (ncsbeTransactionForm), not the URL.
export function ncsbeReceiptsUrl(reportId: string): string {
  return `${NCSBE_PORTAL_BASE_URL}/CFOrgLkup/ReportDetail?rid=${requireNcsbeReportId(reportId)}&handler=ReadReceipts`;
}

export function ncsbeExpendituresUrl(reportId: string): string {
  return (
    `${NCSBE_PORTAL_BASE_URL}/CFOrgLkup/ReportDetail?rid=${requireNcsbeReportId(reportId)}` +
    "&handler=ReadExpenditures"
  );
}

// `page` is the 0-based cache page index. The handler numbers pages from 1
// and serves page 1 for page 0, so sending the index unshifted would fetch
// the first page twice.
export function ncsbeTransactionForm(page: number, antiForgeryToken: string): NcsbeFormBody {
  if (!Number.isInteger(page) || page < 0) {
    throw new Error(`Invalid NCSBE transaction page: ${page}`);
  }
  if (antiForgeryToken.trim().length === 0) {
    throw new Error("NCSBE transaction fetch needs an anti-forgery token");
  }
  return {
    page: String(page + 1),
    pageSize: String(NCSBE_TRANSACTION_PAGE_SIZE),
    __RequestVerificationToken: antiForgeryToken,
  };
}

// The report page's hidden form token. The grid handlers reject a POST
// without it (HTTP 400); it is paired with the antiforgery cookie the same
// GET set, which the default transport keeps.
export function extractNcsbeAntiForgeryToken(html: string): string {
  const match = /name="__RequestVerificationToken"[^>]*\svalue="([^"]+)"/.exec(html);
  if (!match) {
    throw new Error("NCSBE report page has no anti-forgery token");
  }
  return match[1]!;
}

export function ncsbeCsvExportUrl(reportId: string, title: string): string {
  return (
    `${NCSBE_PORTAL_BASE_URL}/CFOrgLkup/ExportDetailResults/?ReportID=${requireNcsbeReportId(reportId)}` +
    `&Type=ALL&Title=${encodeURIComponent(title)}`
  );
}

// The doc-type codes must be single-quoted or the portal serves an error page
// (decision 9). encodeURIComponent would keep the quotes literal, which the
// portal also rejects — the %27 encoding is load-bearing and pinned here.
export function ncsbeIeDocTypeInventoryUrl(year: number): string {
  const reports = NCSBE_IE_DOC_TYPE_CODES.map((code) => `%27${code}%27`).join(",");
  return `${NCSBE_PORTAL_BASE_URL}/CFDocLkup/DocumentResult/?year=${requireNcsbeYear(year)}&reports=${reports}`;
}

export type NcsbeHttpResponse = {
  status: number;
  body: string;
};

// Present = POST these fields form-encoded; absent = GET.
export type NcsbeFormBody = Record<string, string>;

export type NcsbeFetchFn = (url: string, form?: NcsbeFormBody) => Promise<NcsbeHttpResponse>;

export type NcsbeTransport = {
  fetchText: (url: string, form?: NcsbeFormBody) => Promise<string>;
};

// Keeps the portal's cookies (the antiforgery cookie the grid handlers check)
// for the life of the transport.
function defaultNcsbeFetch(userAgent: string, timeoutMs: number): NcsbeFetchFn {
  const cookies = new Map<string, string>();
  return async (url: string, form?: NcsbeFormBody) => {
    const headers: Record<string, string> = { "User-Agent": userAgent, Accept: "*/*" };
    if (cookies.size > 0) {
      headers.Cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    }
    if (form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    const response = await fetch(url, {
      method: form ? "POST" : "GET",
      headers,
      body: form ? new URLSearchParams(form).toString() : undefined,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    for (const setCookie of response.headers.getSetCookie()) {
      const pair = setCookie.split(";", 1)[0]!;
      const separator = pair.indexOf("=");
      if (separator > 0) {
        cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
      }
    }
    return { status: response.status, body: await response.text() };
  };
}

// One request in flight, spacing before every request after the first,
// bounded retries with linear backoff. Retries cover transient failures only
// (network errors, 429, 5xx); other statuses fail immediately — a 404 will
// not become a 200 by asking again.
export function createNcsbeTransport(
  options: {
    fetch?: NcsbeFetchFn;
    sleep?: (ms: number) => Promise<void>;
    spacingMs?: number;
    maxAttempts?: number;
    retryBackoffMs?: number;
    userAgent?: string;
    timeoutMs?: number;
    log?: (message: string) => void;
  } = {}
): NcsbeTransport {
  const spacingMs = options.spacingMs ?? DEFAULT_NCSBE_REQUEST_SPACING_MS;
  const maxAttempts = options.maxAttempts ?? 3;
  const retryBackoffMs = options.retryBackoffMs ?? 5_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const fetchFn =
    options.fetch ??
    defaultNcsbeFetch(
      options.userAgent ?? DEFAULT_NCSBE_USER_AGENT,
      options.timeoutMs ?? DEFAULT_NCSBE_REQUEST_TIMEOUT_MS
    );

  let queue: Promise<unknown> = Promise.resolve();
  let anyRequestStarted = false;

  return {
    fetchText: (url: string, form?: NcsbeFormBody) => {
      const run = queue.then(async () => {
        let lastError: Error | null = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          if (anyRequestStarted) {
            await sleep(attempt === 1 ? spacingMs : attempt * retryBackoffMs);
          }
          anyRequestStarted = true;
          try {
            const response = await fetchFn(url, form);
            if (response.status === 200) {
              return response.body;
            }
            const failure = new Error(`NCSBE request failed with HTTP ${response.status}: ${url}`);
            if (response.status !== 429 && response.status < 500) {
              throw failure;
            }
            lastError = failure;
          } catch (error) {
            if ((error as Error).message.startsWith("NCSBE request failed with HTTP ")) {
              throw error;
            }
            lastError = error as Error;
          }
          options.log?.(`NCSBE attempt ${attempt}/${maxAttempts} failed for ${url}: ${lastError.message}`);
        }
        throw new Error(`NCSBE request failed after ${maxAttempts} attempts: ${url} — ${lastError?.message}`);
      });
      // Later requests wait for this one to settle, success or failure.
      queue = run.catch(() => {});
      return run;
    },
  };
}

// --- High-level fetches (raw body + parsed rows) ----------------------------
// Each returns the raw body alongside the parsed result: the acquisition
// stores exactly the bytes that were fetched and validated, and the sync
// re-parses from the cache (decision 10 — retrieval stays separate from
// parsing).

export type NcsbeFetchedPage<Parsed> = {
  url: string;
  body: string;
  parsed: Parsed;
};

export async function fetchNcsbeCommitteeSearch(
  transport: NcsbeTransport,
  name: string
): Promise<NcsbeFetchedPage<NcsbeCommitteeSearchRow[]>> {
  const url = ncsbeCommitteeSearchUrl(name);
  const body = await transport.fetchText(url);
  return { url, body, parsed: parseNcsbeCommitteeSearchPage(body) };
}

export async function fetchNcsbeDocumentInventory(
  transport: NcsbeTransport,
  input: { orgGroupId: number; sboeId: string }
): Promise<NcsbeFetchedPage<NcsbeDocumentRow[]>> {
  const url = ncsbeDocumentInventoryUrl(input);
  const body = await transport.fetchText(url);
  return { url, body, parsed: parseNcsbeDocumentListPage(body) };
}

export async function fetchNcsbeIeDocTypeInventory(
  transport: NcsbeTransport,
  year: number
): Promise<NcsbeFetchedPage<NcsbeDocumentRow[]>> {
  const url = ncsbeIeDocTypeInventoryUrl(year);
  const body = await transport.fetchText(url);
  return { url, body, parsed: parseNcsbeDocumentListPage(body) };
}

export async function fetchNcsbeReportDetail(
  transport: NcsbeTransport,
  reportId: string
): Promise<NcsbeFetchedPage<NcsbeReportDetail>> {
  const url = ncsbeReportDetailUrl(reportId);
  const body = await transport.fetchText(url);
  return { url, body, parsed: parseNcsbeReportDetailPage(body) };
}

export type NcsbeTransactionPageFetch = {
  // 0-based cache page index (the wire page is page + 1).
  page: number;
  url: string;
  body: string;
  rowCount: number;
};

export type NcsbeTransactionFetchResult<Row> = {
  reportId: string;
  kind: "receipts" | "expenditures";
  recordCount: number;
  pages: NcsbeTransactionPageFetch[];
  rows: Row[];
};

// Pages 0.. until the fetched row count equals the report's recordCountKey.
// Both completeness AND page layout are the contract (decision 9): a
// drifting recordCountKey or a page that is not exactly min(300, remaining)
// rows fails the report closed rather than caching a transaction set whose
// layout downstream page math would misread.
async function fetchNcsbeTransactionPagesInternal<Row>(
  transport: NcsbeTransport,
  input: { reportId: string; kind: "receipts" | "expenditures"; antiForgeryToken: string },
  urlFor: (reportId: string) => string,
  parsePage: (body: string) => { recordCount: number; rows: Row[] }
): Promise<NcsbeTransactionFetchResult<Row>> {
  const reportId = requireNcsbeReportId(input.reportId);
  const pages: NcsbeTransactionPageFetch[] = [];
  const rows: Row[] = [];
  let recordCount: number | null = null;
  const url = urlFor(reportId);

  for (let page = 0; ; page += 1) {
    const body = await transport.fetchText(url, ncsbeTransactionForm(page, input.antiForgeryToken));
    const parsed = parsePage(body);
    if (recordCount === null) {
      if (parsed.recordCount > NCSBE_MAX_TRANSACTION_ROWS) {
        throw new Error(
          `NCSBE ${input.kind} report ${reportId}: recordCountKey ${parsed.recordCount} exceeds the ` +
            `sanity ceiling of ${NCSBE_MAX_TRANSACTION_ROWS}`
        );
      }
      recordCount = parsed.recordCount;
    } else if (parsed.recordCount !== recordCount) {
      throw new Error(
        `NCSBE ${input.kind} report ${reportId}: recordCountKey changed mid-fetch ` +
          `(${recordCount} -> ${parsed.recordCount} on page ${page})`
      );
    }
    // The spike pinned the page contract: fixed 300-row disjoint pages, so
    // every page must deliver exactly min(300, remaining) rows. Enforcing
    // that here (not just total completeness) keeps downstream
    // ceil(recordCountKey / 300) page math — the cache skip check and the
    // sync's page enumeration — valid by construction, and hard-bounds this
    // loop even at the recordCountKey ceiling (~3,334 pages).
    const expectedRowCount = Math.min(NCSBE_TRANSACTION_PAGE_SIZE, recordCount - rows.length);
    if (parsed.rows.length !== expectedRowCount) {
      throw new Error(
        `NCSBE ${input.kind} report ${reportId}: page ${page} returned ${parsed.rows.length} rows, ` +
          `expected ${expectedRowCount} under the fixed ${NCSBE_TRANSACTION_PAGE_SIZE}-row page contract ` +
          `(${rows.length} of ${recordCount} fetched)`
      );
    }
    pages.push({ page, url, body, rowCount: parsed.rows.length });
    rows.push(...parsed.rows);
    if (rows.length === recordCount) {
      return { reportId, kind: input.kind, recordCount, pages, rows };
    }
  }
}

// `antiForgeryToken` comes from the same transport's report page fetch
// (extractNcsbeAntiForgeryToken on fetchNcsbeReportDetail's body).
export function fetchNcsbeReceiptPages(
  transport: NcsbeTransport,
  reportId: string,
  antiForgeryToken: string
): Promise<NcsbeTransactionFetchResult<NcsbeReceiptRow>> {
  return fetchNcsbeTransactionPagesInternal(
    transport,
    { reportId, kind: "receipts", antiForgeryToken },
    ncsbeReceiptsUrl,
    parseNcsbeReceiptsPage
  );
}

export function fetchNcsbeExpenditurePages(
  transport: NcsbeTransport,
  reportId: string,
  antiForgeryToken: string
): Promise<NcsbeTransactionFetchResult<NcsbeExpenditureRow>> {
  return fetchNcsbeTransactionPagesInternal(
    transport,
    { reportId, kind: "expenditures", antiForgeryToken },
    ncsbeExpendituresUrl,
    parseNcsbeExpendituresPage
  );
}
