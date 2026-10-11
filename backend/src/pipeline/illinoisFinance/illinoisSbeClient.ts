import {
  parseIllinoisSbeContributionRecordsCsv,
  parseIllinoisSbeExpenditureRecordsCsv,
  hasIllinoisSbeExportCapWarning,
} from "./illinoisSbeCsvReader.js";
import type {
  IllinoisSbeContributionRecord,
  IllinoisSbeExpenditureRecord,
  IllinoisSbeSupportOppose,
} from "./illinoisSbeCsvReader.js";

export {
  getIllinoisSbeExportCapStatus,
  hasIllinoisSbeExportCapWarning,
  illinoisSbeContributionRecordFromRow,
  illinoisSbeExpenditureRecordFromRow,
  ILLINOIS_SBE_EXPORT_ROW_CAP,
  parseIllinoisSbeContributionRecordsCsv,
  parseIllinoisSbeCsvRows,
  parseIllinoisSbeExpenditureRecordsCsv,
  planIllinoisSbeExportPartitions,
  splitIllinoisSbeAmountWindow,
  splitIllinoisSbeDateWindow,
} from "./illinoisSbeCsvReader.js";
export type {
  IllinoisSbeContributionRecord,
  IllinoisSbeCsvRow,
  IllinoisSbeExportCapStatus,
  IllinoisSbeExportPartitionPlan,
  IllinoisSbeExportPartitionWindow,
  IllinoisSbeExpenditureRecord,
  IllinoisSbePartitionAmountWindow,
  IllinoisSbePartitionDateWindow,
  IllinoisSbeReportSourceFields,
  IllinoisSbeSupportOppose,
} from "./illinoisSbeCsvReader.js";

export const ILLINOIS_SBE_BASE_URL = "https://www.elections.il.gov";
export const ILLINOIS_SBE_CAMPAIGN_DISCLOSURE_BASE_URL = `${ILLINOIS_SBE_BASE_URL}/CampaignDisclosure`;
export const ILLINOIS_SBE_DEFAULT_TIMEOUT_MS = 30_000;

export const ILLINOIS_SBE_CONTRIBUTION_ALL_SEARCH_URL =
  `${ILLINOIS_SBE_CAMPAIGN_DISCLOSURE_BASE_URL}/ContributionSearchByAllContributions.aspx`;
export const ILLINOIS_SBE_CONTRIBUTION_CANDIDATE_SEARCH_URL =
  `${ILLINOIS_SBE_CAMPAIGN_DISCLOSURE_BASE_URL}/ContributionSearchByCandidates.aspx`;
export const ILLINOIS_SBE_CONTRIBUTION_COMMITTEE_SEARCH_URL =
  `${ILLINOIS_SBE_CAMPAIGN_DISCLOSURE_BASE_URL}/ContributionSearchByCommittees.aspx`;
export const ILLINOIS_SBE_EXPENDITURE_ALL_SEARCH_URL =
  `${ILLINOIS_SBE_CAMPAIGN_DISCLOSURE_BASE_URL}/ExpenditureSearchByAllExpenditures.aspx`;

type HtmlFormFields = Map<string, string>;

export type IllinoisSbeClientErrorCode =
  | "invalid_request"
  | "network_error"
  | "http_error"
  | "bad_response";

export class IllinoisSbeClientError extends Error {
  constructor(
    public readonly code: IllinoisSbeClientErrorCode,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "IllinoisSbeClientError";
  }
}

export type IllinoisSbeClientOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type IllinoisSbeDateWindow = {
  fromDate?: string | null;
  toDate?: string | null;
};

export type IllinoisSbeCandidateContributionSearchInput = {
  candidateLastName: string;
  candidateFirstName?: string | null;
  electionYear?: number | null;
  electionType?: string | null;
  contributionType?: IllinoisSbeContributionType | null;
};

export type IllinoisSbeCommitteeContributionSearchInput = {
  committeeName?: string | null;
  committeeId?: string | null;
  contributionType?: IllinoisSbeContributionType | null;
};

export type IllinoisSbeIndependentExpenditureSearchInput = IllinoisSbeDateWindow & {
  candidateName: string;
  supportOppose?: IllinoisSbeSupportOppose | null;
  office?: string | null;
};

export type IllinoisSbeContributionType =
  | "All Types"
  | "Individual Contributions"
  | "Transfers In"
  | "Loans Received"
  | "Other Receipts"
  | "In-Kind Contributions";

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function normalizeDate(value: string | null | undefined, fieldName: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) {
    return "";
  }
  if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(normalized)) {
    throw new IllinoisSbeClientError("invalid_request", `${fieldName} must use m/d/yyyy format`);
  }
  return normalized;
}

function requireNonEmpty(value: string | null | undefined, fieldName: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new IllinoisSbeClientError("invalid_request", `${fieldName} is required`);
  }
  return trimmed;
}

function normalizeElectionYear(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new IllinoisSbeClientError("invalid_request", `Invalid Illinois election year: ${value}`);
  }
  return String(value);
}

function normalizeSupportOppose(value: IllinoisSbeSupportOppose | null | undefined): string {
  if (!value) {
    return "";
  }
  return value === "support" ? "Supporting" : "Opposing";
}

function getResponseSetCookies(headers: Headers): string[] {
  const maybeGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  const direct = maybeGetSetCookie.getSetCookie?.() ?? [];
  if (direct.length > 0) {
    return direct;
  }
  const combined = headers.get("set-cookie");
  return combined ? splitIllinoisSbeSetCookieHeader(combined) : [];
}

export function splitIllinoisSbeSetCookieHeader(value: string): string[] {
  const cookies: string[] = [];
  let start = 0;
  let inQuotedValue = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\"" && value[index - 1] !== "\\") {
      inQuotedValue = !inQuotedValue;
      continue;
    }
    if (char === "," && !inQuotedValue && isSetCookieDelimiter(value, index + 1)) {
      const cookie = value.slice(start, index).trim();
      if (cookie) {
        cookies.push(cookie);
      }
      start = index + 1;
    }
  }

  const lastCookie = value.slice(start).trim();
  if (lastCookie) {
    cookies.push(lastCookie);
  }
  return cookies;
}

function isSetCookieDelimiter(value: string, start: number): boolean {
  let index = start;
  while (index < value.length && /\s/.test(value[index] ?? "")) {
    index += 1;
  }
  const nameStart = index;
  while (index < value.length && !/[;,=\s]/.test(value[index] ?? "")) {
    index += 1;
  }
  while (index < value.length && /\s/.test(value[index] ?? "")) {
    index += 1;
  }
  return index > nameStart && value[index] === "=";
}

function mergeCookies(existingCookieHeader: string | undefined, setCookies: readonly string[]): string | undefined {
  const cookies = new Map<string, string>();
  for (const cookie of existingCookieHeader?.split(/;\s*/) ?? []) {
    const separatorIndex = cookie.indexOf("=");
    if (separatorIndex > 0) {
      cookies.set(cookie.slice(0, separatorIndex), cookie.slice(separatorIndex + 1));
    }
  }
  for (const setCookie of setCookies) {
    const [cookie] = setCookie.split(";", 1);
    const separatorIndex = cookie?.indexOf("=") ?? -1;
    if (cookie && separatorIndex > 0) {
      cookies.set(cookie.slice(0, separatorIndex), cookie.slice(separatorIndex + 1));
    }
  }
  const cookieHeader = [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
  return cookieHeader || undefined;
}

async function fetchIllinoisSbe(
  url: string,
  init: RequestInit,
  options: IllinoisSbeClientOptions
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? ILLINOIS_SBE_DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await (options.fetchImpl ?? fetch)(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new IllinoisSbeClientError("network_error", `Illinois SBE request timed out after ${timeoutMs}ms for ${url}`);
    }
    throw new IllinoisSbeClientError(
      "network_error",
      `Illinois SBE request failed for ${url}: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function assertOk(response: Response, context: string): Promise<void> {
  if (!response.ok) {
    throw new IllinoisSbeClientError(
      "http_error",
      `Illinois SBE ${context} failed: ${response.status} ${response.statusText}`,
      response.status
    );
  }
}

export function decodeIllinoisSbeText(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  const sample = bytes.subarray(0, Math.min(bytes.length, 200));
  const nullOddCount = sample.filter((byte, index) => index % 2 === 1 && byte === 0).length;
  if (sample.length > 20 && nullOddCount > sample.length / 4) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // The official bulk registry contains Windows-1252 names, not UTF-8.
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

function htmlDecode(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function parseAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const attributePattern = /([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of tag.matchAll(attributePattern)) {
    const name = match[1]?.toLowerCase();
    if (!name || name === "input" || name === "select" || name === "option") {
      continue;
    }
    attributes[name] = htmlDecode(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function readInputFields(html: string): HtmlFormFields {
  const fields: HtmlFormFields = new Map();
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    const attributes = parseAttributes(match[0]);
    const name = attributes.name;
    if (!name) {
      continue;
    }
    const type = attributes.type?.toLowerCase() ?? "text";
    // A browser submits only the clicked button; Search is added explicitly below.
    if (["submit", "reset", "button", "image", "file"].includes(type) || "disabled" in attributes) {
      continue;
    }
    if ((type === "radio" || type === "checkbox") && !("checked" in attributes)) {
      continue;
    }
    fields.set(name, attributes.value ?? "");
  }
  return fields;
}

function readSelectedFields(html: string, fields: HtmlFormFields): void {
  for (const match of html.matchAll(/<select\b[^>]*>([\s\S]*?)<\/select>/gi)) {
    const attributes = parseAttributes(match[0]);
    const name = attributes.name;
    if (!name) {
      continue;
    }
    let selectedValue: string | null = null;
    let firstValue: string | null = null;
    for (const optionMatch of match[1].matchAll(/<option\b[^>]*>/gi)) {
      const optionAttributes = parseAttributes(optionMatch[0]);
      const value = optionAttributes.value ?? "";
      firstValue ??= value;
      if ("selected" in optionAttributes) {
        selectedValue = value;
        break;
      }
    }
    fields.set(name, selectedValue ?? firstValue ?? "");
  }
}

function buildFormFields(html: string): HtmlFormFields {
  const fields = readInputFields(html);
  readSelectedFields(html, fields);
  for (const [name, value] of fields) {
    if (value.trim().toLowerCase() === "m/d/yyyy") {
      fields.set(name, "");
    }
  }
  return fields;
}

function toFormBody(fields: HtmlFormFields): string {
  const params = new URLSearchParams();
  for (const [name, value] of fields) {
    params.set(name, value);
  }
  return params.toString();
}

function absoluteUrl(url: string, baseUrl: string): string {
  return new URL(url, baseUrl).toString();
}

class IllinoisSbeSession {
  private cookieHeader: string | undefined;

  constructor(private readonly options: IllinoisSbeClientOptions) {}

  async getText(url: string, context: string): Promise<{ text: string; url: string }> {
    const headers = new Headers({
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "user-agent": "Mozilla/5.0 (compatible; voteApp Illinois campaign finance/1.0)",
    });
    if (this.cookieHeader) {
      headers.set("cookie", this.cookieHeader);
    }
    const response = await fetchIllinoisSbe(url, { headers }, this.options);
    await assertOk(response, context);
    this.cookieHeader = mergeCookies(this.cookieHeader, getResponseSetCookies(response.headers));
    return { text: decodeIllinoisSbeText(await response.arrayBuffer()), url: response.url };
  }

  async postForm(
    url: string,
    html: string,
    input: {
      context: string;
      fields?: Record<string, string>;
      eventTarget?: string;
      submit?: { name: string; value: string };
      accept?: string;
    }
  ): Promise<{ text: string; url: string }> {
    const fields = buildFormFields(html);
    if (input.eventTarget !== undefined) {
      fields.set("__EVENTTARGET", input.eventTarget);
      fields.set("__EVENTARGUMENT", "");
    }
    for (const [name, value] of Object.entries(input.fields ?? {})) {
      fields.set(name, value);
    }
    if (input.submit) {
      fields.set(input.submit.name, input.submit.value);
    }

    const body = toFormBody(fields);
    const headers = new Headers({
      accept: input.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "content-type": "application/x-www-form-urlencoded",
      origin: ILLINOIS_SBE_BASE_URL,
      referer: url,
      "user-agent": "Mozilla/5.0 (compatible; voteApp Illinois campaign finance/1.0)",
    });
    if (this.cookieHeader) {
      headers.set("cookie", this.cookieHeader);
    }
    const response = await fetchIllinoisSbe(
      url,
      {
        method: "POST",
        headers,
        body,
      },
      this.options
    );
    await assertOk(response, input.context);
    this.cookieHeader = mergeCookies(this.cookieHeader, getResponseSetCookies(response.headers));
    const text = decodeIllinoisSbeText(await response.arrayBuffer());
    if (text.trim().length === 0) {
      throw new IllinoisSbeClientError(
        "bad_response",
        `Illinois SBE returned an empty response for ${input.context}; the site may require a browser challenge session`
      );
    }
    return { text, url: response.url };
  }
}

async function openDownloadList(input: {
  session: IllinoisSbeSession;
  resultUrl: string;
  resultHtml: string;
}): Promise<{ text: string; url: string }> {
  if (!input.resultHtml.includes("ContentPlaceHolder1_lnkDownloadList")) {
    throw new IllinoisSbeClientError(
      "bad_response",
      "Illinois SBE search did not expose a download-list link; " +
        "the live backend export flow may be blocked or returning a non-export page. " +
        "Use Illinois SBE CSV artifact mode for production syncs."
    );
  }
  return input.session.postForm(input.resultUrl, input.resultHtml, {
    context: "download-list postback",
    eventTarget: "ctl00$ContentPlaceHolder1$lnkDownloadList",
  });
}

async function downloadCsvFromDownloadList(input: {
  session: IllinoisSbeSession;
  downloadUrl: string;
  downloadHtml: string;
}): Promise<string> {
  if (!input.downloadHtml.includes("ContentPlaceHolder1_btnCSV")) {
    throw new IllinoisSbeClientError("bad_response", "Illinois SBE download page did not expose a CSV link");
  }
  const response = await input.session.postForm(input.downloadUrl, input.downloadHtml, {
    context: "CSV download postback",
    eventTarget: "ctl00$ContentPlaceHolder1$btnCSV",
    accept: "text/csv,text/plain;q=0.9,*/*;q=0.1",
  });
  return response.text;
}

async function submitAndDownloadCsv(input: {
  session: IllinoisSbeSession;
  searchUrl: string;
  searchHtml: string;
  fields: Record<string, string>;
  submit: { name: string; value: string };
}): Promise<{ csv: string; resultUrl: string; downloadUrl: string }> {
  const result = await input.session.postForm(input.searchUrl, input.searchHtml, {
    context: "search request",
    fields: input.fields,
    submit: input.submit,
  });
  if (hasIllinoisSbeExportCapWarning(result.text)) {
    throw new IllinoisSbeClientError("bad_response", "Illinois SBE search export is capped");
  }
  const downloadPage = await openDownloadList({
    session: input.session,
    resultUrl: result.url,
    resultHtml: result.text,
  });
  const csv = await downloadCsvFromDownloadList({
    session: input.session,
    downloadUrl: absoluteUrl(downloadPage.url, result.url),
    downloadHtml: downloadPage.text,
  });
  return { csv, resultUrl: result.url, downloadUrl: downloadPage.url };
}

export async function fetchIllinoisSbeCandidateContributionsCsv(
  input: IllinoisSbeCandidateContributionSearchInput,
  options: IllinoisSbeClientOptions = {}
): Promise<string> {
  const session = new IllinoisSbeSession(options);
  const page = await session.getText(ILLINOIS_SBE_CONTRIBUTION_CANDIDATE_SEARCH_URL, "candidate contribution search page");
  const result = await submitAndDownloadCsv({
    session,
    searchUrl: page.url,
    searchHtml: page.text,
    fields: {
      "ctl00$ContentPlaceHolder1$txtCanElectYear": normalizeElectionYear(input.electionYear),
      "ctl00$ContentPlaceHolder1$ddlCanElectType": input.electionType?.trim() || "All Types",
      "ctl00$ContentPlaceHolder1$ddlCanLastNameSearchType": "Contains",
      "ctl00$ContentPlaceHolder1$txtCanLastName": requireNonEmpty(input.candidateLastName, "candidate last name"),
      "ctl00$ContentPlaceHolder1$ddlCanFirstNameSearchType": "Contains",
      "ctl00$ContentPlaceHolder1$txtCanFirstName": input.candidateFirstName?.trim() ?? "",
    },
    submit: {
      name: "ctl00$ContentPlaceHolder1$btnCanSubmit",
      value: "Search",
    },
  });
  parseIllinoisSbeContributionRecordsCsv(result.csv);
  return result.csv;
}

export async function fetchIllinoisSbeCommitteeContributionsCsv(
  input: IllinoisSbeCommitteeContributionSearchInput,
  options: IllinoisSbeClientOptions = {}
): Promise<string> {
  if (!input.committeeName?.trim() && !input.committeeId?.trim()) {
    throw new IllinoisSbeClientError("invalid_request", "committeeName or committeeId is required");
  }
  const session = new IllinoisSbeSession(options);
  const page = await session.getText(ILLINOIS_SBE_CONTRIBUTION_COMMITTEE_SEARCH_URL, "committee contribution search page");
  const result = await submitAndDownloadCsv({
    session,
    searchUrl: page.url,
    searchHtml: page.text,
    fields: {
      "ctl00$ContentPlaceHolder1$ddlCmteNameSearchType": "Contains",
      "ctl00$ContentPlaceHolder1$txtCmteName": input.committeeName?.trim() ?? "",
      "ctl00$ContentPlaceHolder1$txtCmteID": input.committeeId?.trim() ?? "",
    },
    submit: {
      name: "ctl00$ContentPlaceHolder1$btnSubmit",
      value: "Search",
    },
  });
  parseIllinoisSbeContributionRecordsCsv(result.csv);
  return result.csv;
}

export async function fetchIllinoisSbeIndependentExpendituresCsv(
  input: IllinoisSbeIndependentExpenditureSearchInput,
  options: IllinoisSbeClientOptions = {}
): Promise<string> {
  const session = new IllinoisSbeSession(options);
  const page = await session.getText(ILLINOIS_SBE_EXPENDITURE_ALL_SEARCH_URL, "independent expenditure search page");
  const result = await submitAndDownloadCsv({
    session,
    searchUrl: page.url,
    searchHtml: page.text,
    fields: {
      "ctl00$ContentPlaceHolder1$ddlExpenditureType": "Independent Expenditures",
      "ctl00$ContentPlaceHolder1$ddlCandidateNameSearchType": "Contains",
      "ctl00$ContentPlaceHolder1$txtCandidateName": requireNonEmpty(input.candidateName, "candidate name"),
      "ctl00$ContentPlaceHolder1$ddlOfficeSearchType": "Contains",
      "ctl00$ContentPlaceHolder1$txtOffice": input.office?.trim() ?? "",
      "ctl00$ContentPlaceHolder1$radSupportingOpposing": normalizeSupportOppose(input.supportOppose),
      "ctl00$ContentPlaceHolder1$txtExpendedDate": normalizeDate(input.fromDate, "fromDate"),
      "ctl00$ContentPlaceHolder1$txtExpendedDateThru": normalizeDate(input.toDate, "toDate"),
    },
    submit: {
      name: "ctl00$ContentPlaceHolder1$btnSubmit",
      value: "Search",
    },
  });
  parseIllinoisSbeExpenditureRecordsCsv(result.csv);
  return result.csv;
}

export async function fetchIllinoisSbeCandidateContributionRecords(
  input: IllinoisSbeCandidateContributionSearchInput,
  options: IllinoisSbeClientOptions = {}
): Promise<IllinoisSbeContributionRecord[]> {
  const csv = await fetchIllinoisSbeCandidateContributionsCsv(input, options);
  return parseIllinoisSbeContributionRecordsCsv(csv, ILLINOIS_SBE_CONTRIBUTION_CANDIDATE_SEARCH_URL);
}

export async function fetchIllinoisSbeCommitteeContributionRecords(
  input: IllinoisSbeCommitteeContributionSearchInput,
  options: IllinoisSbeClientOptions = {}
): Promise<IllinoisSbeContributionRecord[]> {
  const csv = await fetchIllinoisSbeCommitteeContributionsCsv(input, options);
  return parseIllinoisSbeContributionRecordsCsv(csv, ILLINOIS_SBE_CONTRIBUTION_COMMITTEE_SEARCH_URL);
}

export async function fetchIllinoisSbeIndependentExpenditureRecords(
  input: IllinoisSbeIndependentExpenditureSearchInput,
  options: IllinoisSbeClientOptions = {}
): Promise<IllinoisSbeExpenditureRecord[]> {
  const csv = await fetchIllinoisSbeIndependentExpendituresCsv(input, options);
  return parseIllinoisSbeExpenditureRecordsCsv(csv, ILLINOIS_SBE_EXPENDITURE_ALL_SEARCH_URL);
}
