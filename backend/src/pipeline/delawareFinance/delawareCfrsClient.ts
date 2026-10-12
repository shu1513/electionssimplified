import { createHash } from "node:crypto";

// Delaware CFRS portal client (docs/plans/plan-delaware-finance.md).
//
// cfrs.elections.delaware.gov is a classic ASP.NET MVC + Telerik app (the old
// PCC/CRIS platform Maryland ran before moving to the Civix bulk API). All
// public data flows through session-bound searches: a search POST stores its
// result in the server session (cookie jar mandatory), and the matching CSV
// export GET streams the FULL result set of that stored search. Probed live
// 2026-08-26; every pinned path and field set below came from those pages.
// This client is the module's single fetch layer:
// - HTTPS to exactly cfrs.elections.delaware.gov. No auth, no CAPTCHA, no WAF
//   observed — but responses still fail closed: the portal answers malformed
//   or incomplete form POSTs with the literal body "Unable to process the
//   request." (detected here), and an export that answers with HTML instead
//   of CSV is drift, not data (callers assert via looksLikeHtml).
// - One request in flight per session, courteous spacing, bounded retries on
//   transient failures only (network, 429, 5xx). Searches mutate session
//   state, so a search POST and its export GET must run back-to-back on one
//   session — the single-flight queue guarantees ordering within a session;
//   never share a session across concurrent search flows.
// - Redirects are never followed automatically: the portal 302s on wrong
//   entry points (POST /Public/ViewExpenses -> HandleUnknown was the probe's
//   first failure mode) and a silent follow would hide the drift.
// - PII: receipt exports carry contributor street addresses. This layer
//   returns raw bytes; callers keep artifacts in restricted storage and must
//   never log or persist address fields (plan privacy rules).

export const DELAWARE_CFRS_BASE_URL = "https://cfrs.elections.delaware.gov";

/** Public pages and endpoints exercised by the probe (verified live 2026-08-26). */
export const DELAWARE_CFRS_PAGES = {
  /** Current receipts entry page; GET initializes the native ledger session. */
  receiptsEntry: "/Public/ViewReceiptsMain",
  /** Receipts search POST target (distinct from the Main entry page). */
  receiptsSearch: "/Public/ViewReceipts",
  /** Receipts CSV export of the session's stored receipts search. */
  receiptsExportCsv: "/Public/ExportCSVNew",
  /** Third-party search renders a separate eight-column funder export. */
  receiptsThirdPartyExportCsv: "/Public/ExportCSVNew_TP",
  /**
   * Receipts grid JSON of the stored search (form-encoded POST: page/size/
   * orderBy/groupBy/filter). Its `total` is unstable and its row shape is
   * NOT a pinned contract — probe-advisory evidence only (rows carry
   * Transaction_id + FileAmendedVersion, which the CSV lacks).
   */
  receiptsGridJson: "/Public/_ViewReceiptsCustom",
  /** Expenses search form (GET only — the search POSTs elsewhere, see below). */
  expensesSearch: "/Public/ViewExpenses",
  /** Expenses search POST target. POSTing to ViewExpenses itself 302s to HandleUnknown. */
  expensesSearchPost: "/Public/OtherSearch",
  /** Expenses CSV export of the session's stored expenses search. */
  expensesExportCsv: "/Public/ExportExpensestoCsv",
  /** Committee search form (GET warms the session). */
  committeeSearch: "/Public/ViewCommittees",
  /** Committee search POST target. */
  committeeSearchPost: "/Public/Search",
  /** Committee registry grid JSON (form-encoded POST: page/size/orderBy/groupBy/filter). */
  committeeGridJson: "/Public/_ViewCommittees",
  /**
   * Office-dropdown cascade (verified live 2026-08-28): POST OfficeType(+
   * CountyCode) -> the ddlOfficeSought <select> HTML for that office type.
   */
  bindOffice: "/Public/BindOffice",
  /** District-dropdown cascade: POST OfficeType+CountyCode+Office -> ddljurisdiction <select> HTML. */
  getDistricts: "/Public/GetDistricts",
  /** Filed-reports search form (GET warms the session; POST runs the search). */
  filedReportsSearch: "/Public/ViewFiledReports",
  /** Filed-reports grid JSON for the session's stored search (GET with ajax=True). */
  filedReportsGridJson: "/Public/_ViewFiledReports",
  /** Report PDF download: FileName + CommitteeID (MemberID) + FilingCalendarID. */
  filedReportPdf: "/Public/FiledReports",
  /** Statement-of-organization detail (renders the TP candidate-affiliation table). */
  statementOfOrganization: "/Public/ShowReview",
  /** Registrant name autocomplete: q=<name> -> "Name(Status)|MemberId" lines. */
  findRegistrants: "/Public/FindRegistrants",
} as const;

/** Query string every search POST carries (matches the portal's own form action). */
export const DELAWARE_CFRS_THEME_QUERY = { theme: "vista" } as const;

/**
 * Query string of the CSV export links as rendered on the results pages. The
 * export streams the whole stored result set regardless of these paging
 * values, but they are sent verbatim to match the portal's own links.
 */
export const DELAWARE_CFRS_EXPORT_QUERY = {
  page: "1",
  orderBy: "~",
  filter: "~",
  "Grid-size": "15",
  theme: "vista",
} as const;

export const DEFAULT_DELAWARE_CFRS_USER_AGENT = "VoteApp election research (https://electionssimplified.com)";
export const DEFAULT_DELAWARE_CFRS_REQUEST_SPACING_MS = 1_500;
export const DEFAULT_DELAWARE_CFRS_REQUEST_TIMEOUT_MS = 120_000;
// The statewide-year receipts CSV (36,718 rows in 2024) is ~6 MB; report PDFs
// are ~130 KB. Anything past this bound is drift, not data.
export const DELAWARE_CFRS_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/**
 * The portal's fail-closed sentinel: incomplete or malformed search POSTs
 * (any missing form field) answer 200 with exactly this body.
 */
export const DELAWARE_CFRS_ERROR_SENTINEL = "Unable to process the request.";

export function isDelawareCfrsErrorBody(body: string): boolean {
  if (body.trim() === DELAWARE_CFRS_ERROR_SENTINEL) {
    return true;
  }
  // Some endpoints (e.g. ShowReview without the expected session context)
  // wrap the same sentinel in a script alert + redirect instead.
  return body.length < 4_096 && body.includes(`alert('${DELAWARE_CFRS_ERROR_SENTINEL}')`);
}

/** Cheap drift check for endpoints that must NOT answer with an HTML page. */
export function looksLikeDelawareCfrsHtml(body: string): boolean {
  return /^\s*(?:<!DOCTYPE|<html|<form|<div|<table)/i.test(body);
}

export type DelawareCfrsClientErrorCode =
  "invalid_request" | "network_error" | "http_error" | "portal_rejection" | "bad_response" | "capture_error";

export class DelawareCfrsClientError extends Error {
  constructor(
    public readonly code: DelawareCfrsClientErrorCode,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "DelawareCfrsClientError";
  }
}

export function buildDelawareCfrsUrl(path: string, query?: Record<string, string>): string {
  const url = new URL(path, DELAWARE_CFRS_BASE_URL);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * Full receipts-search field set. Every field must be present (blank when
 * unused) or the portal answers the error sentinel — probed live 2026-08-26.
 * The hdn* fields mirror what the page's own submit JS copies from the
 * dropdowns before posting.
 */
export function buildDelawareReceiptsSearchFields(
  overrides: Partial<Record<DelawareReceiptsSearchField, string>> = {}
): Record<string, string> {
  const fields: Record<DelawareReceiptsSearchField, string> = {
    txtReceivingRegistrant: "",
    MemberId: "",
    ContributorType: "",
    ContributionType: "",
    txtContributorName: "",
    txtFirstName: "",
    txtStreet: "",
    txtTown: "",
    ddlState: "",
    txtZipCode: "",
    txtZipExt: "",
    FilingYear: "",
    FilingPeriodName: "",
    ddlEmployerOccupation: "",
    dtStartDate: "",
    dtEndDate: "",
    txtAmountRangeFrom: "",
    txtAmountRangeTo: "",
    ddlOffice: "",
    hdnddlOffice: "",
    ddlCounty: "",
    hdnddlCounty: "",
    ddlOfficeSought: "",
    hdnddlOfficeSought: "",
    ddljurisdiction: "",
    hdnddljurisdiction: "",
    hdnFixedAssets: "",
    hdnTP: "",
    btnSearch: "Search",
    ...overrides,
  };
  return fields;
}

export type DelawareReceiptsSearchField =
  | "txtReceivingRegistrant"
  | "MemberId"
  | "ContributorType"
  | "ContributionType"
  | "txtContributorName"
  | "txtFirstName"
  | "txtStreet"
  | "txtTown"
  | "ddlState"
  | "txtZipCode"
  | "txtZipExt"
  | "FilingYear"
  | "FilingPeriodName"
  | "ddlEmployerOccupation"
  | "dtStartDate"
  | "dtEndDate"
  | "txtAmountRangeFrom"
  | "txtAmountRangeTo"
  | "ddlOffice"
  | "hdnddlOffice"
  | "ddlCounty"
  | "hdnddlCounty"
  | "ddlOfficeSought"
  | "hdnddlOfficeSought"
  | "ddljurisdiction"
  | "hdnddljurisdiction"
  | "hdnFixedAssets"
  | "hdnTP"
  | "btnSearch";

/** Full expenses-search field set (POSTs to /Public/OtherSearch — see DELAWARE_CFRS_PAGES). */
export function buildDelawareExpensesSearchFields(
  overrides: Partial<Record<DelawareExpensesSearchField, string>> = {}
): Record<string, string> {
  const fields: Record<DelawareExpensesSearchField, string> = {
    txtRegistrant: "",
    MemberId: "",
    txtCommitteeID: "",
    committeeNameData: "",
    // Actual select names observed 2026-10-11. The older *Data names below
    // are container aliases and cannot substitute for these controls.
    CommitteeType: "",
    FilingYear: "",
    FilingPeriodName: "",
    ddlPayeeType: "",
    ddlState: "",
    ddlExpenCategory: "",
    ddlExpensePurpose: "",
    CommitteeTypeData: "",
    payeeTypeData: "",
    txtPayeeFirstName: "",
    txtPayeeLastName: "",
    txtStreet: "",
    txtTown: "",
    txtZipCode: "",
    txtZipExt: "",
    filingYearData: "",
    expenseCategoryData: "",
    expensePruposeData: "", // portal's own misspelling — pinned verbatim
    dtStartDate: "",
    dtEndDate: "",
    txtAmountfrom: "",
    txtAmountto: "",
    hdnFixedAssets: "",
    hdnTP: "",
    Submit: "Search",
    ...overrides,
  };
  return fields;
}

export type DelawareExpensesSearchField =
  | "txtRegistrant"
  | "MemberId"
  | "txtCommitteeID"
  | "committeeNameData"
  | "CommitteeType"
  | "FilingYear"
  | "FilingPeriodName"
  | "ddlPayeeType"
  | "ddlState"
  | "ddlExpenCategory"
  | "ddlExpensePurpose"
  | "CommitteeTypeData"
  | "payeeTypeData"
  | "txtPayeeFirstName"
  | "txtPayeeLastName"
  | "txtStreet"
  | "txtTown"
  | "txtZipCode"
  | "txtZipExt"
  | "filingYearData"
  | "expenseCategoryData"
  | "expensePruposeData"
  | "dtStartDate"
  | "dtEndDate"
  | "txtAmountfrom"
  | "txtAmountto"
  | "hdnFixedAssets"
  | "hdnTP"
  | "Submit";

/** Full committee-search field set (POSTs to /Public/Search). Type codes: 01 candidate, 02 PAC, 03 political, 04 3rd-party advertiser, 05 certificate of intention. */
export function buildDelawareCommitteeSearchFields(
  overrides: Partial<Record<DelawareCommitteeSearchField, string>> = {}
): Record<string, string> {
  const fields: Record<DelawareCommitteeSearchField, string> = {
    txtCommitteeName: "",
    txtCommitteeID: "",
    txtAcronym: "",
    hdnAcronymId: "",
    txtResOfficer: "",
    hdnPersonID: "",
    MemberId: "",
    CommitteeType: "",
    FormType: "",
    CommitteeStatus: "",
    ddlOffice: "",
    hdnddlOffice: "",
    ddlCounty: "",
    hdnddlCounty: "",
    ddlOfficeSought: "",
    hdnddlOfficeSought: "",
    ddljurisdiction: "",
    hdnddljurisdiction: "",
    dtStartDate: "",
    dtEndDate: "",
    dtCloseStartDate: "",
    dtCloseEndDate: "",
    rdGroup: "",
    btnSearch: "Search",
    ...overrides,
  };
  return fields;
}

export type DelawareCommitteeSearchField =
  | "txtCommitteeName"
  | "txtCommitteeID"
  | "txtAcronym"
  | "hdnAcronymId"
  | "txtResOfficer"
  | "hdnPersonID"
  | "MemberId"
  | "CommitteeType"
  | "FormType"
  | "CommitteeStatus"
  | "ddlOffice"
  | "hdnddlOffice"
  | "ddlCounty"
  | "hdnddlCounty"
  | "ddlOfficeSought"
  | "hdnddlOfficeSought"
  | "ddljurisdiction"
  | "hdnddljurisdiction"
  | "dtStartDate"
  | "dtEndDate"
  | "dtCloseStartDate"
  | "dtCloseEndDate"
  | "rdGroup"
  | "btnSearch";

/** Full filed-reports search field set (POSTs to /Public/ViewFiledReports). */
export function buildDelawareFiledReportsSearchFields(
  overrides: Partial<Record<DelawareFiledReportsSearchField, string>> = {}
): Record<string, string> {
  const fields: Record<DelawareFiledReportsSearchField, string> = {
    txtCommitteeName: "",
    MemberId: "",
    txtCommitteeID: "",
    CommitteeType: "",
    ddlElectiontype: "",
    FilingPeriodName: "",
    ReportName: "",
    ddlOffice: "",
    hdnddlOffice: "",
    ddlCounty: "",
    hdnddlCounty: "",
    ddlOfficeSought: "",
    hdnddlOfficeSought: "",
    ddljurisdiction: "",
    hdnddljurisdiction: "",
    dtStartDate: "",
    dtEndDate: "",
    dtCloseStartDate: "",
    dtCloseEndDate: "",
    hdnCommitteeName: "",
    hdnFilingPeriodName: "",
    hdnReportName: "",
    hdnViewCurrent: "",
    hdnTP: "",
    btnSearch: "Search",
    ...overrides,
  };
  return fields;
}

export type DelawareFiledReportsSearchField =
  | "txtCommitteeName"
  | "MemberId"
  | "txtCommitteeID"
  | "CommitteeType"
  | "ddlElectiontype"
  | "FilingPeriodName"
  | "ReportName"
  | "ddlOffice"
  | "hdnddlOffice"
  | "ddlCounty"
  | "hdnddlCounty"
  | "ddlOfficeSought"
  | "hdnddlOfficeSought"
  | "ddljurisdiction"
  | "hdnddljurisdiction"
  | "dtStartDate"
  | "dtEndDate"
  | "dtCloseStartDate"
  | "dtCloseEndDate"
  | "hdnCommitteeName"
  | "hdnFilingPeriodName"
  | "hdnReportName"
  | "hdnViewCurrent"
  | "hdnTP"
  | "btnSearch";

export type DelawareCfrsResponse = {
  status: number;
  contentType: string | null;
  contentDisposition: string | null;
  redirectLocation: string | null;
  body: Buffer;
  text: () => string;
};

export type DelawareCfrsFetchFn = (
  url: string,
  init: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    redirect: "manual";
    signal: AbortSignal;
  }
) => Promise<Response>;

/** An observed bounded HTTP response, not a financial completeness assertion. */
export type DelawareCfrsResponseCapture = {
  /** Detached original bytes; never aliases the returned response body. */
  body: Buffer;
  /** Actual request URL when unredacted; otherwise only its safe projection. */
  url: string;
  method: "GET" | "POST";
  financeFields: Readonly<Record<string, string>> | null;
  requestScopeRedacted: boolean;
  attempt: number;
  startedAt: string;
  completedAt: string;
  status: number;
  contentType: string | null;
  byteCount: number;
  sha256: string;
};

export type DelawareCfrsSessionOptions = {
  fetchImpl?: DelawareCfrsFetchFn;
  sleep?: (ms: number) => Promise<void>;
  spacingMs?: number;
  maxAttempts?: number;
  retryBackoffMs?: number;
  userAgent?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  log?: (message: string) => void;
  /** Awaited for each bounded response before error classification. Failure is nonretryable. */
  onResponseCapture?: (capture: DelawareCfrsResponseCapture) => void | Promise<void>;
};

export type DelawareCfrsSession = {
  get: (url: string, options?: { referer?: string; xhr?: boolean }) => Promise<DelawareCfrsResponse>;
  postForm: (
    url: string,
    fields: Record<string, string>,
    options?: { referer?: string; xhr?: boolean }
  ) => Promise<DelawareCfrsResponse>;
};

// Source finance controls only. No headers, cookies, credentials, CSRF,
// postal/street filters or opaque fields are copied into request metadata.
const CAPTURE_FINANCE_FIELDS = new Set([
  "txtReceivingRegistrant",
  "txtRegistrant",
  "txtCommitteeName",
  "txtCommitteeID",
  "txtContributorName",
  "txtFirstName",
  "txtPayeeFirstName",
  "txtPayeeLastName",
  "CommitteeType",
  "CommitteeStatus",
  "FormType",
  "ContributorType",
  "ContributionType",
  "FilingYear",
  "FilingPeriodName",
  "ReportName",
  "ddlElectiontype",
  "dtStartDate",
  "dtEndDate",
  "dtCloseStartDate",
  "dtCloseEndDate",
  "ddlOffice",
  "hdnddlOffice",
  "ddlCounty",
  "hdnddlCounty",
  "ddlOfficeSought",
  "hdnddlOfficeSought",
  "ddljurisdiction",
  "hdnddljurisdiction",
  "hdnCommitteeName",
  "hdnFilingPeriodName",
  "hdnReportName",
  "hdnViewCurrent",
  "chkViewCurrReport",
  "hdnTP",
  "chkTP",
  "hdnFixedAssets",
  "ddlPayeeType",
  "ddlExpenCategory",
  "ddlExpensePurpose",
  "CommitteeTypeData",
  "filingYearData",
  "expenseCategoryData",
  "expensePruposeData",
  "payeeTypeData",
  "committeeNameData",
  "btnSearch",
  "Submit",
  "rdGroup",
  "page",
  "size",
  "orderBy",
  "groupBy",
  "theme",
  "ajax",
  "Grid-page",
  "Grid-size",
  "Grid-orderBy",
  "Grid-groupBy",
  "q",
  "ftype",
  "isPublic",
]);
const CAPTURE_PUBLIC_ID_FIELDS = new Set([
  "MemberId",
  "MemberID",
  "memberID",
  "CommitteeID",
  "CommitteeId",
  "FilingCalendarID",
  "memVersID",
  "cTypeCode",
]);
const CAPTURE_PATHS: ReadonlySet<string> = new Set(["/", ...Object.values(DELAWARE_CFRS_PAGES)]);

function captureFieldAllowed(key: string, value: string): boolean {
  if (key === "FileName") return /^CampaignFinanceReport_[A-Za-z0-9_-]+\.pdf$/.test(value);
  if (key === "fpath" || key === "fname") return value === "";
  if (key === "filter" || key === "Grid-filter") return value === "" || value === "~";
  if (CAPTURE_PUBLIC_ID_FIELDS.has(key)) return value === "" || /^\d+$/.test(value);
  return CAPTURE_FINANCE_FIELDS.has(key);
}

function captureRequestScope(
  url: string,
  body: string | undefined
): Pick<DelawareCfrsResponseCapture, "url" | "financeFields" | "requestScopeRedacted"> {
  const parsed = new URL(url);
  let requestScopeRedacted = parsed.hash !== "" || !CAPTURE_PATHS.has(parsed.pathname);
  parsed.hash = "";
  if (!CAPTURE_PATHS.has(parsed.pathname)) parsed.pathname = "/";
  for (const [key, value] of [...parsed.searchParams]) {
    if (!captureFieldAllowed(key, value)) {
      parsed.searchParams.delete(key);
      requestScopeRedacted = true;
    }
  }
  const financeFields: Record<string, string> | null = body === undefined ? null : {};
  if (financeFields !== null) {
    for (const [key, value] of new URLSearchParams(body)) {
      if (captureFieldAllowed(key, value)) financeFields[key] = value;
      // Blank excluded form controls activate no filter and contain no secret.
      // A nonblank excluded value makes this capture unusable as full scope.
      else if (value !== "") requestScopeRedacted = true;
    }
  }
  return { url: requestScopeRedacted ? parsed.toString() : url, financeFields, requestScopeRedacted };
}

/** Cookie jar: single host, session lifetime — name/value only, attributes ignored. */
function parseSetCookieHeader(header: string): { name: string; value: string } | null {
  const pair = header.split(";", 1)[0] ?? "";
  const separator = pair.indexOf("=");
  if (separator <= 0) {
    return null;
  }
  return { name: pair.slice(0, separator).trim(), value: pair.slice(separator + 1).trim() };
}

/**
 * A session owns a cookie jar (ASP.NET_SessionId + friends) and a
 * single-flight request queue with courteous spacing. Searches store their
 * results in this session on the server — run each search POST and its
 * export GET back-to-back on one session, and never share a session across
 * concurrent search flows.
 */
export function createDelawareCfrsSession(options: DelawareCfrsSessionOptions = {}): DelawareCfrsSession {
  const spacingMs = options.spacingMs ?? DEFAULT_DELAWARE_CFRS_REQUEST_SPACING_MS;
  const maxAttempts = options.maxAttempts ?? 3;
  const retryBackoffMs = options.retryBackoffMs ?? 5_000;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DELAWARE_CFRS_REQUEST_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DELAWARE_CFRS_MAX_RESPONSE_BYTES;
  const userAgent = options.userAgent ?? DEFAULT_DELAWARE_CFRS_USER_AGENT;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const fetchImpl: DelawareCfrsFetchFn = options.fetchImpl ?? ((url, init) => fetch(url, init));

  const onResponseCapture = options.onResponseCapture;
  const cookies = new Map<string, string>();
  let queue: Promise<unknown> = Promise.resolve();
  let anyRequestStarted = false;

  function requireCfrsUrl(url: string): void {
    if (!url.startsWith(`${DELAWARE_CFRS_BASE_URL}/`)) {
      throw new DelawareCfrsClientError(
        "invalid_request",
        onResponseCapture === undefined
          ? `not a cfrs.elections.delaware.gov URL: ${url}`
          : "not a cfrs.elections.delaware.gov URL"
      );
    }
  }

  async function performOnce(
    url: string,
    method: "GET" | "POST",
    body: string | undefined,
    referer: string | undefined,
    xhr: boolean,
    attempt: number
  ): Promise<DelawareCfrsResponse> {
    const headers: Record<string, string> = { "User-Agent": userAgent };
    if (referer !== undefined) {
      headers.Referer = referer;
    }
    if (xhr) {
      headers["X-Requested-With"] = "XMLHttpRequest";
    }
    if (cookies.size > 0) {
      headers.Cookie = [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    }
    if (method === "POST") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }

    const displayUrl = onResponseCapture === undefined ? url : captureRequestScope(url, body).url;
    let response: Response;
    const startedAt = onResponseCapture === undefined ? "" : new Date().toISOString();
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DelawareCfrsClientError(
        "network_error",
        `CFRS request failed: ${method} ${displayUrl}${onResponseCapture === undefined ? ` — ${message}` : ""}`
      );
    }

    for (const header of response.headers.getSetCookie()) {
      const cookie = parseSetCookieHeader(header);
      if (cookie !== null) {
        cookies.set(cookie.name, cookie.value);
      }
    }

    // Reject a declared oversize before buffering; the post-read check below
    // still covers responses without a Content-Length. (The limit is drift
    // detection on a single-flight client, not DoS defense.)
    const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isSafeInteger(declaredLength) && declaredLength > maxResponseBytes) {
      throw new DelawareCfrsClientError(
        "bad_response",
        `CFRS response declares ${declaredLength} bytes, over the ${maxResponseBytes} limit: ${displayUrl}`
      );
    }

    let bytes: ArrayBuffer;
    try {
      bytes = await response.arrayBuffer();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DelawareCfrsClientError(
        "network_error",
        `CFRS response body read failed: ${displayUrl}${onResponseCapture === undefined ? ` — ${message}` : ""}`
      );
    }
    if (bytes.byteLength > maxResponseBytes) {
      throw new DelawareCfrsClientError(
        "bad_response",
        `CFRS response exceeds ${maxResponseBytes} bytes (${bytes.byteLength}): ${displayUrl}`
      );
    }

    const completedAt = onResponseCapture === undefined ? "" : new Date().toISOString();
    const buffer = onResponseCapture === undefined ? Buffer.from(bytes) : Buffer.from(new Uint8Array(bytes));
    const result: DelawareCfrsResponse = {
      status: response.status,
      contentType: response.headers.get("content-type"),
      contentDisposition: response.headers.get("content-disposition"),
      redirectLocation: response.headers.get("location"),
      body: buffer,
      text: () => buffer.toString("utf-8"),
    };

    if (onResponseCapture !== undefined) {
      const captured: DelawareCfrsResponseCapture = {
        body: Buffer.from(buffer),
        ...captureRequestScope(url, body),
        method,
        attempt,
        startedAt,
        completedAt,
        status: result.status,
        contentType: result.contentType,
        byteCount: buffer.byteLength,
        sha256: createHash("sha256").update(buffer).digest("hex"),
      };
      try {
        await onResponseCapture(captured);
      } catch (error) {
        const failed = new DelawareCfrsClientError(
          "capture_error",
          "CFRS response capture failed",
          result.status
        );
        failed.cause = error;
        throw failed;
      }
    }

    // The portal's own fail-closed sentinel: a 200 whose whole body is
    // "Unable to process the request." means the POST was malformed (usually
    // a missing form field) — never data, never retryable.
    if (isDelawareCfrsErrorBody(result.text())) {
      throw new DelawareCfrsClientError(
        "portal_rejection",
        `CFRS rejected the request ("${DELAWARE_CFRS_ERROR_SENTINEL}") — malformed or incomplete form POST: ${displayUrl}`,
        response.status
      );
    }

    if (response.status >= 400) {
      throw new DelawareCfrsClientError(
        "http_error",
        `CFRS request failed with HTTP ${response.status}: ${displayUrl}`,
        response.status
      );
    }
    return result;
  }

  function enqueue(
    url: string,
    method: "GET" | "POST",
    body: string | undefined,
    referer: string | undefined,
    xhr: boolean
  ): Promise<DelawareCfrsResponse> {
    try {
      requireCfrsUrl(url);
    } catch (error) {
      return Promise.reject(error);
    }
    const displayUrl = onResponseCapture === undefined ? url : captureRequestScope(url, body).url;
    const run = queue.then(async () => {
      let lastError: Error | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (anyRequestStarted) {
          await sleep(attempt === 1 ? spacingMs : attempt * retryBackoffMs);
        }
        anyRequestStarted = true;
        try {
          return await performOnce(url, method, body, referer, xhr, attempt);
        } catch (error) {
          if (error instanceof DelawareCfrsClientError) {
            const retryable =
              error.code === "network_error" ||
              (error.code === "http_error" && (error.status === 429 || (error.status ?? 0) >= 500));
            if (!retryable) {
              throw error;
            }
            lastError = error;
          } else {
            lastError = error as Error;
          }
        }
        options.log?.(
          `CFRS attempt ${attempt}/${maxAttempts} failed for ${displayUrl}: ${lastError.message}`
        );
      }
      throw new DelawareCfrsClientError(
        "network_error",
        `CFRS request failed after ${maxAttempts} attempts: ${displayUrl} — ${lastError?.message}`
      );
    });
    // Later requests wait for this one to settle, success or failure.
    queue = run.catch(() => {});
    return run;
  }

  return {
    get: (url, getOptions) => enqueue(url, "GET", undefined, getOptions?.referer, getOptions?.xhr ?? false),
    postForm: (url, fields, postOptions) => {
      const params = new URLSearchParams();
      for (const [name, value] of Object.entries(fields)) {
        params.append(name, value);
      }
      return enqueue(url, "POST", params.toString(), postOptions?.referer, postOptions?.xhr ?? false);
    },
  };
}
