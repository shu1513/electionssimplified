import {
  classifyErtsSearchResult,
  ertsUsDateToIso,
  ERTS_CONTRIBUTION_RESULT_GRID_ID,
  ERTS_FILING_LIST_GRID_ID,
  ERTS_FILING_VERSIONS_GRID_ID,
  ERTS_PUBLIC_BASE_URL,
  parseErtsCf8IndexPage,
  parseErtsCf8Pager,
  parseErtsCf8FiledDate,
  parseErtsFilingListPage,
  parseErtsFilingVersionsPage,
  parseErtsOrganizationSearchPage,
  stripErtsTags,
  type ErtsCf8IndexRow,
  type ErtsFilingRow,
  type ErtsFilingVersion,
  type ErtsOrganizationSearchRow,
} from "./rhodeIslandErtsParsers.js";

// HTTP client for the ERTS portal. Every route lives here and nowhere else so
// a portal change is a one-module migration (north carolina decision-10
// discipline). Transport is fail-closed (docs/plans/rhode_island_plan.md decision 3): the
// portal answers a rejected search with a 200 redirect back to the search
// page, so every fetch validates its body against the expected page marker —
// a login page, error page, or challenge page must never read as data.
//
// Retrieval is polite by construction: one request in flight, a fixed delay
// before every request after the first, bounded retries with backoff on
// transient failures only, and a descriptive user agent. The PR 3 spike ran
// ~80 requests at 2 s pacing and drew zero blocks; the portal is a
// single-server ASP.NET app, so the pacing is not negotiable.
//
// Two transport modes, both proven by the spike:
//   - Stateless GETs: `Reporting/TransactionReport.aspx` and
//     `Reporting/ExpenditureReport.aspx` serve byte-identical results with no
//     cookie and no prior search.
//   - Session-scoped WebForms: organization discovery (5 posts on
//     Contributions.aspx) and the org filing list (the portal carries the
//     selected organization across its tabs in the same session). A cookie
//     jar plus hidden-field/`<select>` echo makes those postbacks valid.

export { ERTS_PUBLIC_BASE_URL };

export const DEFAULT_ERTS_USER_AGENT = "VoteApp election research (https://electionssimplified.com)";

// Delay before every request after the first (north carolina transport
// discipline; spike-proven at 2 s).
export const DEFAULT_ERTS_REQUEST_SPACING_MS = 2_000;

export const DEFAULT_ERTS_REQUEST_TIMEOUT_MS = 120_000;

// --- Transport ---------------------------------------------------------------

export type ErtsHttpResponse = {
  status: number;
  finalUrl: string;
  contentType: string;
  body: Uint8Array;
};

export type ErtsFetchFn = (url: string, body?: URLSearchParams) => Promise<ErtsHttpResponse>;

export type ErtsTransport = {
  fetch: (url: string, body?: URLSearchParams) => Promise<ErtsHttpResponse>;
};

/**
 * The portal's session cookies belong to the portal only. Every URL this
 * client fetches is either built here from pinned routes or echoed from
 * portal HTML — and an echoed URL must never be able to carry the session
 * to another host (or trigger a request to an internal one).
 */
export function isErtsPortalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && /^(www\.|secure\.)?ricampaignfinance\.com$/i.test(parsed.hostname) &&
      !parsed.username && !parsed.password && !parsed.port;
  } catch {
    return false;
  }
}

function defaultErtsFetch(userAgent: string, timeoutMs: number, beforeRedirect: () => Promise<void>): ErtsFetchFn {
  const cookies = new Map<string, string>();
  return async (url: string, body?: URLSearchParams) => {
    let currentUrl = url;
    let currentBody = body;
    for (let hop = 0; hop < 6; hop += 1) {
      if (!isErtsPortalUrl(currentUrl)) throw new Error("ERTS request URL is outside the HTTPS portal");
      const cookieHeader = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
      const response = await fetch(currentUrl, {
        method: currentBody ? "POST" : "GET",
        headers: {
          "User-Agent": userAgent,
          Accept: "*/*",
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          ...(currentBody ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        body: currentBody,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      for (const setCookie of response.headers.getSetCookie?.() ?? []) {
        const pair = setCookie.split(";", 1)[0];
        const separator = pair.indexOf("=");
        if (separator > 0) cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error("ERTS redirect has no location");
        const next = new URL(location, currentUrl);
        // Empty windows redirect to a published HTTP search URL. Upgrade
        // before any request; never follow a downgrade or send the session
        // outside the pinned portal hosts.
        if (next.protocol === "http:") next.protocol = "https:";
        if (!isErtsPortalUrl(next.href)) throw new Error("ERTS redirect is outside the HTTPS portal");
        currentUrl = next.href;
        if (![307, 308].includes(response.status)) currentBody = undefined;
        if (hop < 5) await beforeRedirect();
        continue;
      }
      return {
        status: response.status,
        finalUrl: response.url,
        contentType: response.headers.get("content-type") ?? "",
        body: bytes,
      };
    }
    throw new Error("ERTS redirect limit exceeded");
  };
}

// One request in flight, spacing before every request after the first,
// bounded retries with linear backoff. Retries cover transient failures only
// (network errors, 429, 5xx); other statuses fail immediately — a 404 will
// not become a 200 by asking again. The cookie jar lives inside the fetch
// function, so a fresh transport is a fresh portal session.
export function createErtsTransport(
  options: {
    fetch?: ErtsFetchFn;
    sleep?: (ms: number) => Promise<void>;
    spacingMs?: number;
    maxAttempts?: number;
    retryBackoffMs?: number;
    userAgent?: string;
    timeoutMs?: number;
    log?: (message: string) => void;
  } = {}
): ErtsTransport {
  const spacingMs = options.spacingMs ?? DEFAULT_ERTS_REQUEST_SPACING_MS;
  const maxAttempts = options.maxAttempts ?? 3;
  const retryBackoffMs = options.retryBackoffMs ?? 5_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const fetchFn =
    options.fetch ??
    defaultErtsFetch(
      options.userAgent ?? DEFAULT_ERTS_USER_AGENT,
      options.timeoutMs ?? DEFAULT_ERTS_REQUEST_TIMEOUT_MS,
      () => sleep(spacingMs)
    );

  let queue: Promise<unknown> = Promise.resolve();
  let anyRequestStarted = false;

  return {
    fetch: (url, body) => {
      const run = queue.then(async () => {
        let lastError: Error | null = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          if (anyRequestStarted) {
            await sleep(attempt === 1 ? spacingMs : attempt * retryBackoffMs);
          }
          anyRequestStarted = true;
          try {
            const response = await fetchFn(url, body);
            if (response.status === 200) return response;
            const failure = new Error(`ERTS request failed with HTTP ${response.status}: ${url}`);
            if (response.status !== 429 && response.status < 500) throw failure;
            lastError = failure;
          } catch (error) {
            if ((error as Error).message.startsWith("ERTS request failed with HTTP ")) throw error;
            lastError = error as Error;
          }
          options.log?.(`ERTS attempt ${attempt}/${maxAttempts} failed for ${url}: ${lastError.message}`);
        }
        throw new Error(`ERTS request failed after ${maxAttempts} attempts: ${url} — ${lastError?.message}`);
      });
      queue = run.catch(() => {});
      return run;
    },
  };
}

const decoder = new TextDecoder("utf-8");

export function decodeErtsBody(body: Uint8Array): string {
  return decoder.decode(body);
}

// --- WebForms helpers --------------------------------------------------------

function decodeHtmlAttr(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function ertsHiddenFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of html.matchAll(/<input\b[^>]*type=["']hidden["'][^>]*>/gi)) {
    const name = /\bname=["']([^"']+)["']/i.exec(match[0])?.[1];
    if (!name) continue;
    fields[decodeHtmlAttr(name)] = decodeHtmlAttr(/\bvalue=["']([^"']*)["']/i.exec(match[0])?.[1] ?? "");
  }
  return fields;
}

/**
 * ASP.NET rejects a postback that drops a `<select>` the page rendered, so
 * the selected (or first) option of every dropdown rides along.
 */
export function ertsSelectDefaults(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const select of html.matchAll(/<select\b[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/select>/gi)) {
    let chosen: string | null = null;
    let first: string | null = null;
    for (const option of select[2].matchAll(/<option\b([^>]*)>/gi)) {
      const value = decodeHtmlAttr(/\bvalue=["']([^"']*)["']/i.exec(option[1])?.[1] ?? "");
      if (first === null) first = value;
      if (/\bselected\b/i.test(option[1])) chosen = value;
    }
    fields[decodeHtmlAttr(select[1])] = chosen ?? first ?? "";
  }
  return fields;
}

export function ertsPostBody(html: string, overrides: Record<string, string>): URLSearchParams {
  return new URLSearchParams({ ...ertsSelectDefaults(html), ...ertsHiddenFields(html), ...overrides });
}

/**
 * Fail closed (decision 3): a page that does not carry its expected marker is
 * an error, never an empty result.
 */
export function requireErtsPage(html: string, marker: string, context: string): string {
  if (!html.includes(marker)) {
    const message = /No [A-Za-z]+ were found for the Search criteria you entered/.exec(stripErtsTags(html))?.[0];
    throw new Error(`${context}: response did not contain ${JSON.stringify(marker)}${message ? ` — ${message}` : ""}`);
  }
  return html;
}

// --- Report URLs (stateless GETs) --------------------------------------------

export function requireErtsOrgId(orgId: string): string {
  const trimmed = orgId.trim();
  if (!/^\d+$/.test(trimmed)) throw new Error(`Invalid ERTS organization key: ${JSON.stringify(orgId)}`);
  return trimmed;
}

export function requireErtsUsDate(value: string, label: string): string {
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(value) || ertsUsDateToIso(value) === null) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * The contribution report URL exactly as the portal's own search redirect
 * builds it. Verified stateless on 2026-08-13: served identically with no
 * cookie and no prior search.
 */
export function ertsContributionReportUrl(input: {
  orgId: string;
  begin: string;
  end: string;
  contributionTypeCode?: number;
}): string {
  return (
    `${ERTS_PUBLIC_BASE_URL}Reporting/TransactionReport.aspx?OrgID=${requireErtsOrgId(input.orgId)}` +
    `&BeginDate=${requireErtsUsDate(input.begin, "BeginDate")}&EndDate=${requireErtsUsDate(input.end, "EndDate")}` +
    `&LastName=&FirstName=&ContType=${input.contributionTypeCode ?? 0}&State=&City=&ZIPCode=&EmployerName=` +
    "&Amount=0&ReportType=Contrib&CFStatus=F&MPFStatus=A&Level=S&SumBy=Type" +
    "&Sort1=ReceiptDate&Direct1=asc&Sort2=None&Direct2=asc&Sort3=None&Direct3=asc" +
    "&Site=Public&Incomplete=A&ContSource=CF"
  );
}

/** Expenditures live on their own report page with their own parameter set. */
export function ertsExpenditureReportUrl(input: { orgId: string; begin: string; end: string }): string {
  return (
    `${ERTS_PUBLIC_BASE_URL}Reporting/ExpenditureReport.aspx?OrgID=${requireErtsOrgId(input.orgId)}` +
    `&BeginDate=${requireErtsUsDate(input.begin, "BeginDate")}&EndDate=${requireErtsUsDate(input.end, "EndDate")}` +
    "&LastName=&FirstName=&ContType=0&State=&City=&ZIPCode=&Amount=0&ReportType=Expend" +
    "&CFStatus=F&MPFStatus=F&Level=S&SumBy=Type&Sort1=None&Direct1=asc&Sort2=None&Direct2=asc" +
    "&Sort3=None&Direct3=asc&Site=Public&Incomplete=A&ContSource=CF"
  );
}

// --- High-level fetches ------------------------------------------------------
// Each returns the raw body alongside anything parsed from it: the
// acquisition stores exactly the bytes that were fetched and validated, and
// the sync re-parses from the cache (retrieval stays separate from parsing).

export type ErtsFetchedPage = { url: string; html: string };

/**
 * A transaction report page for one org + window. `classification` is
 * "no_rows" for a window with no transactions of the searched kind — a valid,
 * cacheable state — and an unreadable page throws.
 */
export async function fetchErtsReportPage(
  transport: ErtsTransport,
  input: { url: string; resultGridId: string; context: string }
): Promise<ErtsFetchedPage & { classification: "rows" | "no_rows" }> {
  const html = decodeErtsBody((await transport.fetch(input.url)).body);
  const classification = classifyErtsSearchResult(html, input.resultGridId);
  if (classification === "unreadable") {
    throw new Error(`${input.context}: response was neither a result grid nor a no-rows page`);
  }
  return { url: input.url, html, classification };
}

export function fetchErtsContributionReport(
  transport: ErtsTransport,
  input: { orgId: string; begin: string; end: string; contributionTypeCode?: number }
): Promise<ErtsFetchedPage & { classification: "rows" | "no_rows" }> {
  return fetchErtsReportPage(transport, {
    url: ertsContributionReportUrl(input),
    resultGridId: ERTS_CONTRIBUTION_RESULT_GRID_ID,
    context: `ERTS contribution report (OrgID ${input.orgId}, ${input.begin}-${input.end})`,
  });
}

export function fetchErtsExpenditureReport(
  transport: ErtsTransport,
  input: { orgId: string; begin: string; end: string }
): Promise<ErtsFetchedPage & { classification: "rows" | "no_rows" }> {
  // The expenditure result grid id ("dgrExpenditure") is a prefix of the
  // summary grid id, so its presence check matches either — both only render
  // on a real result page, which is what the check is for.
  return fetchErtsReportPage(transport, {
    url: ertsExpenditureReportUrl(input),
    resultGridId: "dgrExpenditure",
    context: `ERTS expenditure report (OrgID ${input.orgId}, ${input.begin}-${input.end})`,
  });
}

/**
 * The `txtPage` URL is echoed from portal HTML, so it is pinned to the one
 * route the portal has ever served (the live URL prints `http:` and is
 * upgraded) — an unexpected host or path throws instead of being fetched
 * with the session attached.
 */
export function requireErtsDownloadFileUrl(rawUrl: string): string {
  const upgraded = rawUrl.replace(/^http:/, "https:");
  let parsed: URL;
  try {
    parsed = new URL(upgraded);
  } catch {
    throw new Error(`ERTS export returned an unparseable DownloadFile URL: ${rawUrl}`);
  }
  if (!isErtsPortalUrl(upgraded) || parsed.pathname !== "/RIPublic/Reporting/DownloadFile.aspx") {
    throw new Error(`ERTS export returned a DownloadFile URL outside the pinned portal route: ${rawUrl}`);
  }
  return upgraded;
}

/**
 * The detail-export round-trip: three hops, all load-bearing (spike result 3).
 *   1. `lnkExport` postback on the report page generates a temp file and
 *      answers with a script carrying a `DownloadFile.aspx` URL;
 *   2. that page renders a `hypFileDownload` postback link;
 *   3. the postback answers with the CSV bytes.
 * The `path=` parameter is a server-side share path — echoed verbatim from
 * the portal's own script, never constructed here.
 */
export async function fetchErtsTransactionExportCsv(
  transport: ErtsTransport,
  input: { reportUrl: string; reportHtml: string }
): Promise<{ url: string; csv: string }> {
  const exportResponse = await transport.fetch(
    input.reportUrl,
    ertsPostBody(input.reportHtml, { __EVENTTARGET: "lnkExport", __EVENTARGUMENT: "" })
  );
  const exportHtml = decodeErtsBody(exportResponse.body);
  const downloadUrl = /txtPage\s*=\s*'([^']+)'/.exec(exportHtml)?.[1];
  if (!downloadUrl) throw new Error("ERTS export postback did not return a DownloadFile URL");
  const secureDownloadUrl = requireErtsDownloadFileUrl(downloadUrl);

  const downloadHtml = requireErtsPage(
    decodeErtsBody((await transport.fetch(secureDownloadUrl)).body),
    "hypFileDownload",
    "ERTS download page"
  );

  const fileResponse = await transport.fetch(
    secureDownloadUrl,
    ertsPostBody(downloadHtml, { __EVENTTARGET: "hypFileDownload", __EVENTARGUMENT: "" })
  );
  const csv = decodeErtsBody(fileResponse.body);
  if (/^\s*</.test(csv)) throw new Error("ERTS file download returned HTML instead of CSV bytes");
  return { url: secureDownloadUrl, csv };
}

// --- Organization discovery (session-scoped WebForms) ------------------------

export type ErtsOrganizationSearch = {
  url: string;
  html: string;
  rows: ErtsOrganizationSearchRow[];
  // True when the result grid paginates; the rows are an incomplete slice.
  hasMorePages: boolean;
};

/**
 * The portal's organization search (Contributions.aspx, session-scoped):
 * entry page, search panel, then the last-name search — three requests. The
 * result rows are the resolver's evidence (PR 5); selecting a row afterwards
 * requires the SAME transport, whose session now holds this result grid.
 *
 * A page without the result grid fails closed: the portal's no-results shape
 * was never captured live, so "no organizations" cannot yet be told apart
 * from a drifted or challenge page (pin the marker at the PR 9 live run if
 * it ever appears).
 */
export async function searchErtsOrganizations(
  transport: ErtsTransport,
  input: { lastName: string }
): Promise<ErtsOrganizationSearch> {
  const searchUrl = `${ERTS_PUBLIC_BASE_URL}Contributions.aspx`;
  const entry = decodeErtsBody((await transport.fetch(searchUrl)).body);

  const panelHtml = requireErtsPage(
    decodeErtsBody(
      (await transport.fetch(searchUrl, ertsPostBody(entry, { lnkSearchOrg: "New Organization Search" }))).body
    ),
    "txtOrgLastName",
    "ERTS organization search panel"
  );

  const resultsHtml = requireErtsPage(
    decodeErtsBody(
      (
        await transport.fetch(
          searchUrl,
          ertsPostBody(panelHtml, { txtOrgLastName: input.lastName, lnkSubSearchOrg: "Search" })
        )
      ).body
    ),
    "dgdOrgSearchResults",
    "ERTS organization search results"
  );

  const page = parseErtsOrganizationSearchPage(resultsHtml);
  return { url: searchUrl, html: resultsHtml, rows: page.rows, hasMorePages: page.hasMorePages };
}

/**
 * Select one search-result row and read the numeric Board key off the dated
 * search's redirect — the only place the portal ever prints an OrgID. Two
 * requests, valid only against the transport and results page of the
 * `searchErtsOrganizations` call that produced the postback target. As a
 * side effect the session now has this organization selected, which is what
 * makes the Filings tab reachable (`fetchErtsOrganizationFilings`).
 */
export async function selectErtsOrganizationOrgId(
  transport: ErtsTransport,
  input: { searchResultsHtml: string; postbackTarget: string; begin: string; end: string }
): Promise<string> {
  const searchUrl = `${ERTS_PUBLIC_BASE_URL}Contributions.aspx`;
  const selectedHtml = decodeErtsBody(
    (
      await transport.fetch(
        searchUrl,
        ertsPostBody(input.searchResultsHtml, { __EVENTTARGET: input.postbackTarget, __EVENTARGUMENT: "" })
      )
    ).body
  );

  const searchResponse = await transport.fetch(
    searchUrl,
    ertsPostBody(selectedHtml, { txtDateFrom: input.begin, txtDateTo: input.end, btnSearch: "Search" })
  );
  const orgId = new URL(searchResponse.finalUrl).searchParams.get("OrgID");
  if (!orgId || !/^\d+$/.test(orgId)) {
    throw new Error(`ERTS search redirect carried no numeric OrgID: ${searchResponse.finalUrl}`);
  }
  return orgId;
}

export type ErtsOrganizationDiscovery = {
  orgId: string;
  organizationName: string;
  // Every organization name the search offered — resolver evidence (PR 5).
  candidates: string[];
  // The dgdOrgSearchResults page, cacheable as the search snapshot.
  searchResultsUrl: string;
  searchResultsHtml: string;
};

/**
 * The exact-name path from a known organization name to its numeric Board
 * key: search, select the exactly matching row, read `OrgID` off the dated
 * search's redirect. Five requests per organization.
 *
 * Two registrations can lawfully share a name (old vs new committee), and
 * row order carries no identity evidence — an ambiguous exact name fails
 * here; the production resolver disambiguates with real evidence or not at
 * all (spike review round, fix d). A paginated search is tolerated on
 * purpose: the caller pins the expected OrgID (acquisition's identity gate),
 * so a same-name row hiding on a later page cannot select the wrong
 * organization — only first-time identity decisions (the resolver) must
 * refuse pagination.
 */
export async function discoverErtsOrganization(
  transport: ErtsTransport,
  input: { lastName: string; organizationName: string; begin: string; end: string }
): Promise<ErtsOrganizationDiscovery> {
  const search = await searchErtsOrganizations(transport, { lastName: input.lastName });
  const candidates = search.rows.map((row) => row.organizationName);
  const exactMatches = search.rows
    .filter((row) => row.organizationName.toUpperCase() === input.organizationName.toUpperCase())
    .map((row) => row.postbackTarget);
  if (exactMatches.length === 0) {
    throw new Error(
      `ERTS organization search for ${JSON.stringify(input.lastName)} did not offer ` +
        `${JSON.stringify(input.organizationName)} (offered: ${candidates.join(", ") || "nothing"})`
    );
  }
  if (exactMatches.length > 1) {
    throw new Error(
      `ERTS organization search offered ${exactMatches.length} organizations named ` +
        `${JSON.stringify(input.organizationName)} — ambiguous, refusing to pick by row order`
    );
  }

  const orgId = await selectErtsOrganizationOrgId(transport, {
    searchResultsHtml: search.html,
    postbackTarget: exactMatches[0]!,
    begin: input.begin,
    end: input.end,
  });
  return {
    orgId,
    organizationName: input.organizationName,
    candidates,
    searchResultsUrl: search.url,
    searchResultsHtml: search.html,
  };
}

/**
 * The org filing grid. Session-scoped: valid only after
 * `discoverErtsOrganization` selected the organization on the SAME transport
 * (the portal carries the selection across its tabs).
 */
export async function fetchErtsOrganizationFilings(
  transport: ErtsTransport
): Promise<ErtsFetchedPage & { rows: ErtsFilingRow[] }> {
  const url = `${ERTS_PUBLIC_BASE_URL}Filings.aspx`;
  const html = requireErtsPage(
    decodeErtsBody((await transport.fetch(url)).body),
    ERTS_FILING_LIST_GRID_ID,
    "ERTS organization filing list"
  );
  return { url, html, rows: parseErtsFilingListPage(html) };
}

// --- Filing versions + PDFs --------------------------------------------------

export function ertsFilingVersionsUrl(input: { filingId: string; formName: string }): string {
  if (!/^\d+$/.test(input.filingId)) {
    throw new Error(`Invalid ERTS filing id: ${JSON.stringify(input.filingId)}`);
  }
  if (!/^[A-Za-z0-9]+$/.test(input.formName)) {
    throw new Error(`Invalid ERTS form name: ${JSON.stringify(input.formName)}`);
  }
  return (
    "https://secure.ricampaignfinance.com/RhodeIslandCF/Candidate/FilingAmendmentSelect.aspx" +
    `?X=T&FilingID=${input.filingId}&FormName=${input.formName}`
  );
}

/** Public, no login (spike result 5); works for unamended filings too — every filed row links here. */
export async function fetchErtsFilingVersions(
  transport: ErtsTransport,
  input: { filingId: string; formName: string }
): Promise<ErtsFetchedPage & { versions: ErtsFilingVersion[] }> {
  const url = ertsFilingVersionsUrl(input);
  const html = requireErtsPage(
    decodeErtsBody((await transport.fetch(url)).body),
    ERTS_FILING_VERSIONS_GRID_ID,
    `ERTS amendment list for filing ${input.filingId}`
  );
  const versions = parseErtsFilingVersionsPage(html);
  if (versions.length === 0) {
    throw new Error(`ERTS amendment list for filing ${input.filingId} rendered no version rows`);
  }
  return { url, html, versions };
}

/** A generated report PDF under /ExportDocs/ (text-layer; spike result 5). */
export async function fetchErtsFilingPdf(
  transport: ErtsTransport,
  pdfUrl: string
): Promise<{ url: string; pdf: Uint8Array }> {
  if (!/^https:\/\/(www\.)?ricampaignfinance\.com\/ExportDocs\/[^?#]+\.pdf$/i.test(pdfUrl)) {
    throw new Error(`Refusing to fetch a non-ExportDocs PDF URL: ${pdfUrl}`);
  }
  const response = await transport.fetch(pdfUrl);
  const pdf = response.body;
  if (pdf.length < 5 || String.fromCharCode(...pdf.slice(0, 5)) !== "%PDF-") {
    throw new Error(`ERTS filing PDF did not start with %PDF-: ${pdfUrl}`);
  }
  return { url: pdfUrl, pdf };
}

// --- CF-8 "Other Filings" index traversal ------------------------------------

export type ErtsCf8Traversal = {
  // Raw page bodies in traversal order — the cacheable artifact set.
  pages: { page: number; url: string; html: string }[];
  rows: ErtsCf8IndexRow[];
  descending: boolean;
  reachedBoundary: boolean;
};

// Hard bound on pager traversal; the live grid held 5 cycle pages of ~19
// years of filings, so 25 pages is far past any real cycle boundary.
export const ERTS_CF8_MAX_PAGES = 25;

/**
 * Walk the pager (decision 3c): advance by rendered page label — the control
 * ids are positional and walking them in order revisits page 1 (spike result
 * 7) — and stop once an entire page predates the cycle start. Dates must
 * descend page over page or the traversal is not trustworthy; the caller
 * enforces `descending`/`reachedBoundary` before caching anything.
 */
export async function traverseErtsCf8Index(
  transport: ErtsTransport,
  input: { cycleStartMs: number }
): Promise<ErtsCf8Traversal> {
  const url = `${ERTS_PUBLIC_BASE_URL}Homepage.aspx`;
  let html = requireErtsPage(
    decodeErtsBody((await transport.fetch(url)).body),
    "dgdCF8FilingList",
    "ERTS CF-8 index"
  );
  const pages: ErtsCf8Traversal["pages"] = [];
  const rows: ErtsCf8IndexRow[] = [];
  let descending = true;
  let reachedBoundary = false;
  let previousOldest = Number.POSITIVE_INFINITY;
  const visitedPages = new Set<number>();

  while (pages.length < ERTS_CF8_MAX_PAGES) {
    const pager = parseErtsCf8Pager(html);
    if (pager.currentPage !== null && visitedPages.has(pager.currentPage)) break;
    if (pager.currentPage !== null) visitedPages.add(pager.currentPage);

    const pageRows = parseErtsCf8IndexPage(html);
    pages.push({ page: pager.currentPage ?? pages.length + 1, url, html });
    rows.push(...pageRows);
    const dates = pageRows.map((row) => parseErtsCf8FiledDate(row.filedDate)).filter((value) => !Number.isNaN(value));
    const oldest = dates.length > 0 ? Math.min(...dates) : Number.NaN;
    const newest = dates.length > 0 ? Math.max(...dates) : Number.NaN;
    if (!Number.isNaN(newest) && newest > previousOldest) descending = false;
    if (!Number.isNaN(oldest)) previousOldest = oldest;
    if (!Number.isNaN(newest) && newest < input.cycleStartMs) {
      reachedBoundary = true;
      break;
    }

    const wanted = pager.currentPage === null ? null : String(pager.currentPage + 1);
    const nextTarget =
      (wanted === null ? undefined : pager.links.find((link) => link.label === wanted)?.target) ??
      pager.links.find((link) => link.label === "...")?.target;
    if (!nextTarget) break;
    html = decodeErtsBody(
      (await transport.fetch(url, ertsPostBody(html, { __EVENTTARGET: nextTarget, __EVENTARGUMENT: "" }))).body
    );
  }
  return { pages, rows, descending, reachedBoundary };
}
