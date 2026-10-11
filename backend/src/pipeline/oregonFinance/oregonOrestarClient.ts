import {
  isOregonOrestarBlockedPage,
  OREGON_ORESTAR_BASE_URL,
  OREGON_ORESTAR_TRANSACTION_SEARCH_URL,
  parseOregonOrestarSearchForm,
  parseOregonOrestarTransactionDetail,
  parseOregonOrestarTransactionSearchResults,
  type OregonOrestarSearchForm,
  type OregonOrestarTransactionDetail,
  type OregonOrestarTransactionSearchResultRow,
  type OregonOrestarTransactionSearchResults,
} from "./oregonOrestarParser.js";
import {
  parseOregonOrestarCommitteeExport,
  type OregonOrestarCommitteeDirectoryRow,
} from "./oregonOrestarCommitteeExport.js";
import { parseOregonOrestarTransactionExport } from "./oregonOrestarTransactionExport.js";

export type OregonOrestarFetchResponse = {
  ok: boolean;
  status: number;
  statusText?: string;
  headers?: Pick<Headers, "get"> & {
    getSetCookie?: () => string[];
  };
  text: () => Promise<string>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
};

export type OregonOrestarFetch = (
  url: string,
  init?: RequestInit
) => Promise<OregonOrestarFetchResponse>;

export type OregonOrestarClientOptions = {
  fetchFn?: OregonOrestarFetch;
  userAgent?: string;
  timeoutMs?: number;
  /** Pause before each ORESTAR request; keeps long detail crawls under the portal's rate limit. */
  requestDelayMs?: number;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_USER_AGENT = "voteApp Oregon campaign finance sync";
const GENERIC_SEARCH_URL = new URL(OREGON_ORESTAR_TRANSACTION_SEARCH_URL).toString();
const OREGON_ORESTAR_CSRF_GUARD_SCRIPT_URL = `${OREGON_ORESTAR_BASE_URL}/orestar/JavaScriptServlet`;
const OREGON_ORESTAR_COMMITTEE_SEARCH_URL = `${OREGON_ORESTAR_BASE_URL}/orestar/GotoSearchByElection.do`;
// ORESTAR stops committee searches at this many rows (results page and export).
const OREGON_ORESTAR_COMMITTEE_SEARCH_ROW_CAP = 999;

function parseAllowedOrestarUrl(url: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(url, OREGON_ORESTAR_TRANSACTION_SEARCH_URL);
  } catch {
    return null;
  }
  return parsed.origin === OREGON_ORESTAR_BASE_URL ? parsed : null;
}

function normalizeAllowedOrestarUrl(url: string): string {
  const parsed = parseAllowedOrestarUrl(url);
  if (!parsed) {
    throw new Error(`Oregon ORESTAR URL must use ${OREGON_ORESTAR_BASE_URL}`);
  }
  return parsed.toString();
}

function htmlAttribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag);
  return match?.[1]?.replace(/&amp;/gi, "&") ?? null;
}

function hiddenInputValue(html: string, name: string): string | null {
  const inputTags = html.match(/<input\b[^>]*>/gi) ?? [];
  for (const tag of inputTags) {
    if (htmlAttribute(tag, "name") === name) {
      return htmlAttribute(tag, "value")?.trim() || null;
    }
  }
  return null;
}

function parseOregonCommitteeSearchForm(
  html: string,
  sourceUrl: string
): OregonOrestarSearchForm {
  const formTags = html.match(/<form\b[^>]*>/gi) ?? [];
  const formTag = formTags.find(
    (tag) => htmlAttribute(tag, "name") === "CommitteeSearchDynaFormSecond"
  );
  if (!formTag) {
    throw new Error("ORESTAR committee search form not found");
  }
  const action = htmlAttribute(formTag, "action");
  if (!action) {
    throw new Error("ORESTAR committee search form action not found");
  }
  const actionUrl = normalizeAllowedOrestarUrl(new URL(action, sourceUrl).toString());
  return {
    actionUrl,
    csrfToken: hiddenInputValue(html, "OWASP_CSRFTOKEN"),
    cookieHeader: null,
    sessionId: actionUrl.match(/;JSESSIONID_ORESTAR=([^/?#]+)/i)?.[1] ?? null,
  };
}

function parseOregonCommitteeSearchResults(html: string, sourceUrl: string): {
  resultCount: number | null;
  exportUrl: string | null;
} {
  const text = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ");
  // Live pages (Oct 2026) say "Results : 669 found for the above search
  // criteria"; older pages said "N records found".
  const countMatch = /Results\s*:\s*([0-9,]+)\s+(?:records?\s+)?found/i.exec(text);
  const links = html.match(/<a\b[^>]*>/gi) ?? [];
  const exportHref = links
    .map((tag) => htmlAttribute(tag, "href"))
    .find((href): href is string => Boolean(href && /(?:^|\/)XcelSooSearch(?:[?;#]|$)/i.test(href)));
  return {
    resultCount: countMatch?.[1]
      ? Number.parseInt(countMatch[1].replace(/,/g, ""), 10)
      : null,
    exportUrl: exportHref
      ? normalizeAllowedOrestarUrl(new URL(exportHref, sourceUrl).toString())
      : null,
  };
}

function getFetch(fetchFn: OregonOrestarFetch | undefined): OregonOrestarFetch {
  if (fetchFn) {
    return fetchFn;
  }
  if (typeof globalThis.fetch !== "function") {
    throw new Error("fetch is not available for Oregon ORESTAR requests");
  }
  return globalThis.fetch.bind(globalThis) as OregonOrestarFetch;
}

function requestHeaders(userAgent: string | undefined, extraHeaders: HeadersInit = {}): HeadersInit {
  return {
    "user-agent": userAgent?.trim() || DEFAULT_USER_AGENT,
    accept: "text/html,application/xhtml+xml",
    ...extraHeaders,
  };
}

function responseCookies(response: OregonOrestarFetchResponse): string[] {
  const getSetCookie = response.headers?.getSetCookie;
  if (typeof getSetCookie === "function") {
    return getSetCookie.call(response.headers);
  }
  const setCookie = response.headers?.get("set-cookie");
  return setCookie ? [setCookie] : [];
}

function cookieHeader(cookies: readonly string[]): string | null {
  const pairs = cookies
    .map((cookie) => cookie.split(";")[0]?.trim() ?? "")
    .filter(Boolean);
  return pairs.length > 0 ? pairs.join("; ") : null;
}

async function awaitOrestarRequestDelay(options: OregonOrestarClientOptions): Promise<void> {
  const requestDelayMs = options.requestDelayMs ?? 0;
  if (!Number.isInteger(requestDelayMs) || requestDelayMs < 0) {
    throw new Error(`Invalid Oregon ORESTAR requestDelayMs: ${options.requestDelayMs}`);
  }
  if (requestDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, requestDelayMs));
  }
}

async function fetchOrestarHtmlPage(
  url: string,
  options: OregonOrestarClientOptions = {},
  init: RequestInit = {}
): Promise<{ html: string; cookies: string[] }> {
  const requestUrl = normalizeAllowedOrestarUrl(url);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid Oregon ORESTAR timeoutMs: ${options.timeoutMs}`);
  }
  await awaitOrestarRequestDelay(options);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await getFetch(options.fetchFn)(requestUrl, {
      ...init,
      headers: requestHeaders(options.userAgent, init.headers),
      signal: controller.signal,
    });
    const html = await response.text();
    if (!response.ok) {
      throw new Error(`ORESTAR request failed ${response.status} ${response.statusText ?? ""}`.trim());
    }
    if (isOregonOrestarBlockedPage(html)) {
      throw new Error("ORESTAR request blocked by cyber-security page");
    }
    return { html, cookies: responseCookies(response) };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`ORESTAR request timed out after ${timeoutMs}ms for ${requestUrl}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOrestarHtml(url: string, options: OregonOrestarClientOptions = {}): Promise<string> {
  return (await fetchOrestarHtmlPage(url, options)).html;
}

async function fetchOrestarCsrfToken(input: {
  cookies: readonly string[];
  referer: string;
  options?: OregonOrestarClientOptions;
}): Promise<string> {
  const cookie = cookieHeader(input.cookies);
  const { html } = await fetchOrestarHtmlPage(
    OREGON_ORESTAR_CSRF_GUARD_SCRIPT_URL,
    input.options,
    {
      method: "POST",
      headers: {
        accept: "text/plain,*/*",
        "FETCH-CSRF-TOKEN": "1",
        referer: input.referer,
        ...(cookie ? { cookie } : {}),
      },
    }
  );
  const rawToken = html.trim();
  const separatorIndex = rawToken.indexOf(":");
  const tokenName = separatorIndex >= 0 ? rawToken.slice(0, separatorIndex) : rawToken;
  const tokenValue = separatorIndex >= 0 ? rawToken.slice(separatorIndex + 1) : "";
  if (tokenName !== "OWASP_CSRFTOKEN" || !tokenValue.trim()) {
    throw new Error("ORESTAR transaction search CSRF token not found");
  }
  return tokenValue.trim();
}

function isTransactionDetailUrl(url: string): boolean {
  return parseAllowedOrestarUrl(url)?.pathname === "/orestar/gotoPublicTransactionDetail.do";
}

function isGenericSearchUrl(url: string): boolean {
  return parseAllowedOrestarUrl(url)?.toString() === GENERIC_SEARCH_URL;
}

function formatOregonDate(year: number, month: number, day: number): string {
  return `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}/${year}`;
}

function assertOregonSearchElectionYear(electionYear: number): void {
  if (!Number.isInteger(electionYear) || electionYear < 2000 || electionYear > 2100) {
    throw new Error(`Invalid Oregon ORESTAR electionYear: ${electionYear}`);
  }
}

function buildOregonTransactionSearchFormData(input: {
  electionYear: number;
  csrfToken: string;
  committeeText?: string;
  committeeId?: string;
  pageIdx?: number;
  /** ORESTAR cneSearchTranType code, e.g. "C" = Contribution, "E" = Expenditure. */
  transactionTypeCode?: string;
}): URLSearchParams {
  assertOregonSearchElectionYear(input.electionYear);
  const pageIdx = input.pageIdx ?? 0;
  const params = new URLSearchParams();
  params.set("cneSearchButtonName", pageIdx > 0 ? "next" : "search");
  params.set("cneSearchPageIdx", String(pageIdx));
  params.set("cneSearchContributorTypeName", "");
  params.set("cneSearchTranTypeName", "");
  params.set("cneSearchTranSubTypeName", "");
  params.set("cneSearchTranPurposeName", "");
  params.set("cneSearchFilerCommitteeId", input.committeeId ?? "");
  params.set("cneSearchFilerCommitteeTxt", input.committeeText ?? "");
  params.set("cneSearchFilerCommitteeTxtSearchType", "C");
  // Oregon candidates raise money across the full two-year cycle, so the
  // window must span [electionYear - 1 .. electionYear] (an election-year-only
  // window returns ~nothing mid-cycle; same class of bug as Maine PR #375 and
  // Kentucky PR #379).
  params.set("cneSearchTranStartDate", formatOregonDate(input.electionYear - 1, 1, 1));
  params.set("cneSearchTranEndDate", formatOregonDate(input.electionYear, 12, 31));
  params.set("cneSearchTranFiledStartDate", "");
  params.set("cneSearchTranFiledEndDate", "");
  params.set("transactionId", "");
  params.set("cneSearchTranType", input.transactionTypeCode ?? "");
  params.set("cneSearchTranAmountFrom", "");
  params.set("cneSearchTranAmountTo", "");
  params.set("cneSearchContributorTxt", "");
  params.set("cneSearchContributorTxtSearchType", "C");
  params.set("cneSearchContributorType", "");
  params.set("addressLine1", "");
  params.set("city", "");
  params.set("state", "");
  params.set("zip", "");
  params.set("zipPlusFour", "");
  params.set("occupation", "");
  params.set("employer", "");
  params.set("employerCity", "");
  params.set("employerState", "");
  params.set("OWASP_CSRFTOKEN", input.csrfToken);
  return params;
}

export async function getOregonOrestarSearchForm(
  options: OregonOrestarClientOptions = {}
): Promise<OregonOrestarSearchForm> {
  const page = await fetchOrestarHtmlPage(OREGON_ORESTAR_TRANSACTION_SEARCH_URL, options);
  const form = parseOregonOrestarSearchForm(page.html, OREGON_ORESTAR_TRANSACTION_SEARCH_URL);
  const pageCookieHeader = cookieHeader(page.cookies);
  if (form.csrfToken) {
    return {
      ...form,
      cookieHeader: pageCookieHeader,
    };
  }
  return {
    ...form,
    cookieHeader: pageCookieHeader,
    csrfToken: await fetchOrestarCsrfToken({
      cookies: page.cookies,
      referer: OREGON_ORESTAR_TRANSACTION_SEARCH_URL,
      options,
    }),
  };
}

async function getOregonOrestarCommitteeSearchForm(
  options: OregonOrestarClientOptions = {}
): Promise<OregonOrestarSearchForm> {
  const page = await fetchOrestarHtmlPage(OREGON_ORESTAR_COMMITTEE_SEARCH_URL, options);
  const form = parseOregonCommitteeSearchForm(page.html, OREGON_ORESTAR_COMMITTEE_SEARCH_URL);
  const pageCookieHeader = cookieHeader(page.cookies);
  if (form.csrfToken) {
    return { ...form, cookieHeader: pageCookieHeader };
  }
  return {
    ...form,
    cookieHeader: pageCookieHeader,
    csrfToken: await fetchOrestarCsrfToken({
      cookies: page.cookies,
      referer: OREGON_ORESTAR_COMMITTEE_SEARCH_URL,
      options,
    }),
  };
}

async function postOregonTransactionSearchPage(input: {
  form: OregonOrestarSearchForm;
  formData: URLSearchParams;
  options?: OregonOrestarClientOptions;
}): Promise<OregonOrestarTransactionSearchResults> {
  const { html } = await fetchOrestarHtmlPage(
    input.form.actionUrl,
    input.options,
    {
      method: "POST",
      headers: {
        accept: "text/html,application/xhtml+xml",
        "content-type": "application/x-www-form-urlencoded",
        referer: OREGON_ORESTAR_TRANSACTION_SEARCH_URL,
        ...(input.form.cookieHeader ? { cookie: input.form.cookieHeader } : {}),
      },
      body: input.formData.toString(),
    }
  );
  return parseOregonOrestarTransactionSearchResults(html, input.form.actionUrl);
}

export async function getOregonOrestarCandidateSearchRows(input: {
  candidateName: string;
  electionYear: number;
  options?: OregonOrestarClientOptions;
}): Promise<OregonOrestarTransactionSearchResultRow[]> {
  const candidateName = input.candidateName.trim();
  if (!candidateName) {
    throw new Error("Oregon ORESTAR candidate search requires candidateName");
  }
  const form = await getOregonOrestarSearchForm(input.options);
  if (!form.csrfToken) {
    throw new Error("ORESTAR transaction search CSRF token not found");
  }
  const results = await postOregonTransactionSearchPage({
    form,
    formData: buildOregonTransactionSearchFormData({
      electionYear: input.electionYear,
      csrfToken: form.csrfToken,
      committeeText: candidateName,
    }),
    options: input.options,
  });
  return results.rows;
}

export async function getOregonOrestarCommitteeTransactionDetails(input: {
  committeeId: string;
  electionYear: number;
  maxDetails?: number;
  maxPages?: number;
  options?: OregonOrestarClientOptions;
}): Promise<OregonOrestarTransactionDetail[]> {
  const committeeId = input.committeeId.trim();
  if (!/^\d+$/.test(committeeId)) {
    throw new Error(`Oregon ORESTAR committee transaction search requires a numeric committeeId: ${input.committeeId}`);
  }
  const maxDetails = input.maxDetails ?? 500;
  if (!Number.isInteger(maxDetails) || maxDetails <= 0) {
    throw new Error(`Invalid Oregon ORESTAR maxDetails: ${input.maxDetails}`);
  }
  const maxPages = input.maxPages ?? 40;
  if (!Number.isInteger(maxPages) || maxPages <= 0) {
    throw new Error(`Invalid Oregon ORESTAR maxPages: ${input.maxPages}`);
  }

  const form = await getOregonOrestarSearchForm(input.options);
  if (!form.csrfToken) {
    throw new Error("ORESTAR transaction search CSRF token not found");
  }

  // ORESTAR search results paginate by re-POSTing the form with an
  // incremented cneSearchPageIdx (the "Next" control is a form submit, not a
  // link, so result pages have no followable next-page URL).
  //
  // The contract is complete-or-throw: a summary persisted from a partial
  // crawl silently understates a candidate's money, so any sign of an
  // incomplete result set (committee larger than maxDetails, a repeated or
  // degraded page, a row the parser could not link to its detail page) fails
  // the sync and leaves the candidate due instead.
  const details: OregonOrestarTransactionDetail[] = [];
  const seenTransactionIds = new Set<string>();
  let expectedResultCount: number | null = null;
  for (let pageIdx = 0; pageIdx < maxPages; pageIdx += 1) {
    const results = await postOregonTransactionSearchPage({
      form,
      formData: buildOregonTransactionSearchFormData({
        electionYear: input.electionYear,
        csrfToken: form.csrfToken,
        committeeId,
        pageIdx,
      }),
      options: input.options,
    });
    if (pageIdx === 0) {
      expectedResultCount = results.resultCount;
      if (expectedResultCount !== null && expectedResultCount > maxDetails) {
        throw new Error(
          `ORESTAR committee ${committeeId} has ${expectedResultCount} transactions, more than maxDetails=${maxDetails}; refusing to persist a truncated total`
        );
      }
    }
    if (results.rows.length === 0) {
      // A linked committee was matched through its own transactions, so a
      // rowless FIRST page with no "Results : N records found" marker is a
      // soft-blocked/degraded portal response, not an empty committee. Fail
      // closed instead of writing a silent $0 summary.
      if (pageIdx === 0 && results.resultCount === null) {
        throw new Error(
          `ORESTAR returned an empty search page for committee ${committeeId}; treating as blocked rather than $0`
        );
      }
      break;
    }
    let newRowCount = 0;
    for (const row of results.rows) {
      if (seenTransactionIds.has(row.transactionId)) {
        continue;
      }
      seenTransactionIds.add(row.transactionId);
      newRowCount += 1;
      if (!row.detailUrl) {
        // Still counts as a new row so pagination keeps advancing; the
        // completeness check below fails the crawl over the missing detail.
        continue;
      }
      details.push(await getOregonOrestarTransactionDetail({ url: row.detailUrl, options: input.options }));
    }
    if (newRowCount === 0) {
      // The portal served a page of already-seen rows; stop rather than loop,
      // and let the completeness check decide whether the crawl is whole.
      break;
    }
    if (expectedResultCount !== null && seenTransactionIds.size >= expectedResultCount) {
      break;
    }
  }
  if (expectedResultCount !== null && details.length < expectedResultCount) {
    throw new Error(
      `ORESTAR returned ${details.length} of ${expectedResultCount} transactions for committee ${committeeId}; refusing to persist a truncated total`
    );
  }
  return details;
}

async function fetchOrestarBytes(
  url: string,
  options: OregonOrestarClientOptions = {},
  init: RequestInit = {}
): Promise<Uint8Array> {
  const requestUrl = normalizeAllowedOrestarUrl(url);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid Oregon ORESTAR timeoutMs: ${options.timeoutMs}`);
  }
  await awaitOrestarRequestDelay(options);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await getFetch(options.fetchFn)(requestUrl, {
      ...init,
      headers: requestHeaders(options.userAgent, init.headers),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`ORESTAR request failed ${response.status} ${response.statusText ?? ""}`.trim());
    }
    if (typeof response.arrayBuffer !== "function") {
      throw new Error("ORESTAR fetch response does not support arrayBuffer()");
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`ORESTAR request timed out after ${timeoutMs}ms for ${requestUrl}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Loads a committee's contribution transactions through the XcelCNESearch
 * export: one search POST (filtered to cneSearchTranType=C over the two-year
 * cycle window) plus one workbook download, instead of one detail-page fetch
 * per transaction. Three requests total regardless of committee size — the
 * per-detail crawl tripped the portal's WAF on large filers (a 4,214-row
 * committee would need ~4,300 requests).
 *
 * Same complete-or-throw contract as the crawl: the parsed workbook must
 * account for every record the search page reported, or the sync fails and
 * the candidate stays due.
 */
export async function getOregonOrestarCommitteeContributionDetailsFromExport(input: {
  committeeId: string;
  electionYear: number;
  options?: OregonOrestarClientOptions;
}): Promise<OregonOrestarTransactionDetail[]> {
  const committeeId = input.committeeId.trim();
  if (!/^\d+$/.test(committeeId)) {
    throw new Error(`Oregon ORESTAR committee transaction export requires a numeric committeeId: ${input.committeeId}`);
  }
  const form = await getOregonOrestarSearchForm(input.options);
  if (!form.csrfToken) {
    throw new Error("ORESTAR transaction search CSRF token not found");
  }
  const results = await postOregonTransactionSearchPage({
    form,
    formData: buildOregonTransactionSearchFormData({
      electionYear: input.electionYear,
      csrfToken: form.csrfToken,
      committeeId,
      transactionTypeCode: "C",
    }),
    options: input.options,
  });
  if (results.resultCount === null) {
    // A results page always states "Results : N records found"; its absence
    // means a soft-blocked/degraded response. Fail closed rather than writing
    // a silent $0 summary (same guard as the crawl path).
    throw new Error(
      `ORESTAR returned a search page without a result count for committee ${committeeId}; treating as blocked rather than $0`
    );
  }
  if (results.resultCount === 0) {
    return [];
  }
  if (!results.exportUrl) {
    throw new Error(`ORESTAR search results for committee ${committeeId} did not include an export link`);
  }
  const bytes = await fetchOrestarBytes(results.exportUrl, input.options, {
    headers: {
      accept: "application/vnd.ms-excel,*/*",
      referer: form.actionUrl,
      ...(form.cookieHeader ? { cookie: form.cookieHeader } : {}),
    },
  });
  const details = parseOregonOrestarTransactionExport({
    data: bytes,
    // The search was filtered to cneSearchTranType=C, so every exported row is
    // a Contribution by the portal's own taxonomy.
    transactionType: "Contribution",
    sourceUrl: OREGON_ORESTAR_TRANSACTION_SEARCH_URL,
    expectedCommitteeId: committeeId,
  });
  if (details.length !== results.resultCount) {
    throw new Error(
      `ORESTAR export returned ${details.length} of ${results.resultCount} transactions for committee ${committeeId}; refusing to persist a truncated total`
    );
  }
  return details;
}

/**
 * Loads every active candidate committee from the Statement of Organization
 * directory. Committee type is an independent by-election search criterion,
 * so CANDALL covers every election year without the AJAX-populated election
 * selector: one form GET, optional CSRF POST, one search POST, one export GET.
 */
export async function getOregonOrestarCandidateCommitteeDirectory(input: {
  /**
   * Limits the search to committees active in this year. Without it the
   * all-years search hits ORESTAR's row cap and silently drops most
   * committees (live Oct 2026: 999 rows starting with 2006 committees, while
   * yearActive=2026 alone returns 669).
   */
  yearActive?: number;
  options?: OregonOrestarClientOptions;
} = {}): Promise<OregonOrestarCommitteeDirectoryRow[]> {
  const form = await getOregonOrestarCommitteeSearchForm(input.options);
  if (!form.csrfToken) {
    throw new Error("ORESTAR committee search CSRF token not found");
  }

  const formData = new URLSearchParams();
  formData.set("yearActive", input.yearActive === undefined ? "" : String(input.yearActive));
  formData.set("election", "");
  formData.set("filerType", "CANDALL");
  formData.set("committeeOffice", "");
  formData.set("locationLevel", "");
  formData.set("partyAffiliation", "");
  formData.set("controlledCommCanLastName", "");
  formData.set("discontinuedSOO", "false");
  formData.set("approvedSOO", "on");
  formData.set("pendingApprovalSOO", "on");
  formData.set("insufficientSOO", "on");
  formData.set("resolvedSOO", "on");
  formData.set("rejectedSOO", "false");
  formData.set("buttonName", "electionSearch");
  formData.set("search", "Submit");
  formData.set("OWASP_CSRFTOKEN", form.csrfToken);

  const { html } = await fetchOrestarHtmlPage(form.actionUrl, input.options, {
    method: "POST",
    headers: {
      accept: "text/html,application/xhtml+xml",
      "content-type": "application/x-www-form-urlencoded",
      referer: OREGON_ORESTAR_COMMITTEE_SEARCH_URL,
      ...(form.cookieHeader ? { cookie: form.cookieHeader } : {}),
    },
    body: formData.toString(),
  });
  const results = parseOregonCommitteeSearchResults(html, form.actionUrl);
  if (results.resultCount === null) {
    throw new Error(
      "ORESTAR committee search page omitted its result count; treating as blocked rather than using a partial directory"
    );
  }
  if (results.resultCount === 0) {
    return [];
  }
  if (results.resultCount >= OREGON_ORESTAR_COMMITTEE_SEARCH_ROW_CAP) {
    // The page and the export both stop at the cap, so the row-count check
    // below would pass on a truncated directory.
    throw new Error(
      `ORESTAR committee search hit its ${OREGON_ORESTAR_COMMITTEE_SEARCH_ROW_CAP}-row cap; refusing to use a truncated directory`
    );
  }
  if (!results.exportUrl) {
    throw new Error("ORESTAR committee search results did not include an export link");
  }

  const bytes = await fetchOrestarBytes(results.exportUrl, input.options, {
    headers: {
      accept: "application/vnd.ms-excel,*/*",
      referer: form.actionUrl,
      ...(form.cookieHeader ? { cookie: form.cookieHeader } : {}),
    },
  });
  // The export can repeat a committee (live Oct 2026: 675 rows for 669
  // committees, e.g. Sue Rieke Smith's committee five times) while the page
  // counts committees, so keep one row per committee ID.
  const rowsByCommitteeId = new Map<string, OregonOrestarCommitteeDirectoryRow>();
  for (const row of parseOregonOrestarCommitteeExport(bytes)) {
    if (!rowsByCommitteeId.has(row.filerCommitteeId)) {
      rowsByCommitteeId.set(row.filerCommitteeId, row);
    }
  }
  const rows = [...rowsByCommitteeId.values()];
  if (rows.length !== results.resultCount) {
    throw new Error(
      `ORESTAR committee export returned ${rows.length} of ${results.resultCount} rows; refusing to use a truncated directory`
    );
  }
  return rows;
}

export async function getOregonOrestarTransactionSearchResults(input: {
  url: string;
  options?: OregonOrestarClientOptions;
}): Promise<OregonOrestarTransactionSearchResults> {
  const html = await fetchOrestarHtml(input.url, input.options);
  return parseOregonOrestarTransactionSearchResults(html, input.url);
}

export async function getOregonOrestarTransactionDetail(input: {
  url: string;
  options?: OregonOrestarClientOptions;
}): Promise<OregonOrestarTransactionDetail> {
  const html = await fetchOrestarHtml(input.url, input.options);
  return parseOregonOrestarTransactionDetail(html, input.url);
}

export async function getOregonOrestarTransactionDetailsFromSourceUrl(input: {
  sourceUrl: string | null | undefined;
  maxDetails?: number;
  options?: OregonOrestarClientOptions;
}): Promise<OregonOrestarTransactionDetail[]> {
  const sourceUrl = input.sourceUrl?.trim();
  if (!sourceUrl || isGenericSearchUrl(sourceUrl)) {
    throw new Error("Oregon ORESTAR source URL must point to a transaction detail or populated search result");
  }
  if (isTransactionDetailUrl(sourceUrl)) {
    return [await getOregonOrestarTransactionDetail({ url: sourceUrl, options: input.options })];
  }

  const maxDetails = input.maxDetails ?? 500;
  if (!Number.isInteger(maxDetails) || maxDetails <= 0) {
    throw new Error(`Invalid Oregon ORESTAR maxDetails: ${input.maxDetails}`);
  }

  const details: OregonOrestarTransactionDetail[] = [];
  const visitedPageUrls = new Set<string>();
  let pageUrl: string | null = sourceUrl;
  while (pageUrl && details.length < maxDetails) {
    if (visitedPageUrls.has(pageUrl)) {
      break;
    }
    visitedPageUrls.add(pageUrl);
    const searchResults = await getOregonOrestarTransactionSearchResults({
      url: pageUrl,
      options: input.options,
    });
    for (const row of searchResults.rows) {
      if (!row.detailUrl || details.length >= maxDetails) {
        continue;
      }
      details.push(await getOregonOrestarTransactionDetail({ url: row.detailUrl, options: input.options }));
    }
    pageUrl = searchResults.nextPageUrl;
  }
  return details;
}
