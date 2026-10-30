export const MASSACHUSETTS_OCPF_API_BASE_URL = "https://api.ocpf.us";
export const MASSACHUSETTS_OCPF_DEFAULT_TIMEOUT_MS = 30_000;
// /search/items answers 400 "Search too broad" above 50,000 (observed 2026-10-30).
export const MASSACHUSETTS_OCPF_DEFAULT_ITEM_LIMIT = 50_000;
export const MASSACHUSETTS_OCPF_MAX_ITEM_LIMIT = 50_000;
export const MASSACHUSETTS_OCPF_DEFAULT_RETRY_COUNT = 5;
export const MASSACHUSETTS_OCPF_DEFAULT_RETRY_DELAY_MS = 2_000;
export const MASSACHUSETTS_OCPF_MAX_RETRY_DELAY_MS = 60_000;
export const MASSACHUSETTS_OCPF_DEFAULT_REPORT_LIMIT = 1_000;
export const MASSACHUSETTS_OCPF_MAX_REPORT_LIMIT = 10_000;

export type MassachusettsOcpfClientErrorCode =
  | "invalid_request"
  | "network_error"
  | "http_error"
  | "bad_response";

export class MassachusettsOcpfClientError extends Error {
  constructor(
    public readonly code: MassachusettsOcpfClientErrorCode,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "MassachusettsOcpfClientError";
  }

  retryAfterMs?: number;
}

export type MassachusettsOcpfClientOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Retries after 429/5xx answers; 0 disables. */
  retryCount?: number;
  /** First retry delay; doubles per attempt unless Retry-After says otherwise. */
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type MassachusettsOcpfCandidateFiler = {
  cpfId: string;
  filerName: string;
  filerNameReverse?: string;
  committeeName?: string;
  officeSought?: string;
  accountTypeCode?: string;
  accountTypeDescription?: string;
  isCandidate: boolean | null;
  isActive: boolean | null;
};

export type MassachusettsOcpfCandidateFilerSearchInput = {
  searchPhrase: string;
};

export type MassachusettsOcpfCandidateReport = {
  cpfId: string;
  filerName: string;
  filerNameReverse?: string;
  officeSought?: string;
  receiptsYtd?: number;
  expendituresYtd?: number;
  cashOnHand?: number;
  bankReportId?: number;
  isWinner: boolean | null;
  sourceUrl?: string;
};

export type MassachusettsOcpfStatewideReportsInput = {
  electionYear: number;
  onBallot?: boolean;
  limit?: number;
};

export type MassachusettsOcpfLegislativeReportsInput = {
  electionYear: number;
};

export type MassachusettsOcpfMunicipalReportsInput = {
  electionYear: number;
};

export type MassachusettsOcpfContributionItemsInput = {
  candidateCpfId: string;
  electionYear: number;
  limit?: number;
};

export type MassachusettsOcpfContributionItem = {
  itemId?: string;
  reportId?: number;
  cpfId?: string;
  filerName?: string;
  contributorName?: string;
  contributorType?: string;
  occupation?: string;
  employer?: string;
  recordTypeDescription?: string;
  amount: number;
  date?: string;
  sourceUrl?: string;
};

export type MassachusettsOcpfIepacReportSummary = {
  reportId: number;
  cpfId?: string;
  committeeName?: string;
  reportYear?: number;
  reportType?: string;
  reportingPeriod?: string;
  candidateListing?: string;
  candidateSpendingBreakdown?: string;
  receiptsTotal?: number;
  expendituresTotal?: number;
  sourceUrl?: string;
};

export type MassachusettsOcpfReportDetailInput = {
  reportId: number;
};

export type MassachusettsOcpfReceiptItem = {
  contributorName?: string;
  contributorType?: string;
  recordTypeDescription?: string;
  amount: number;
  date?: string;
  sourceUrl?: string;
};

export type MassachusettsOcpfExpenditureItem = {
  affectedCandidateName?: string;
  relatedCpfId?: string;
  isSupported: boolean | null;
  recordTypeDescription?: string;
  ieInfo?: string;
  amount: number;
  date?: string;
  sourceUrl?: string;
};

export type MassachusettsOcpfReportDetail = MassachusettsOcpfIepacReportSummary & {
  receipts: MassachusettsOcpfReceiptItem[];
  expenditures: MassachusettsOcpfExpenditureItem[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function normalizeNonEmptyString(value: string, fieldName: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) {
    throw new MassachusettsOcpfClientError("invalid_request", `${fieldName} is required`);
  }
  return normalized;
}

function normalizeCpfId(value: string | number | null | undefined, fieldName = "Massachusetts OCPF CPF ID"): string {
  const normalized = String(value ?? "").trim();
  if (!/^\d+$/.test(normalized)) {
    throw new MassachusettsOcpfClientError("invalid_request", `${fieldName} must be numeric`);
  }
  return normalized;
}

function normalizeReportId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new MassachusettsOcpfClientError("invalid_request", `Invalid Massachusetts OCPF report id: ${value}`);
  }
  return value;
}

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new MassachusettsOcpfClientError("invalid_request", `Invalid Massachusetts OCPF election year: ${value}`);
  }
  return value;
}

function normalizeLimit(value: number | undefined, defaultValue: number, maxValue: number, fieldName: string): number {
  const normalized = value ?? defaultValue;
  if (!Number.isInteger(normalized) || normalized <= 0 || normalized > maxValue) {
    throw new MassachusettsOcpfClientError(
      "invalid_request",
      `${fieldName} must be an integer between 1 and ${maxValue}`
    );
  }
  return normalized;
}

function getString(row: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function parseAmountString(value: string): number | null {
  const trimmed = value.trim();
  const negative = /^\(.*\)$/.test(trimmed);
  const normalized = trimmed.replace(/[($,)\s]/g, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) {
    return null;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.round((negative ? -Math.abs(parsed) : parsed) * 100) / 100;
}

function getNumber(row: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.round(value * 100) / 100;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = parseAmountString(value);
      if (parsed !== null) {
        return parsed;
      }
    }
  }
  return undefined;
}

function getInteger(row: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "number" && Number.isSafeInteger(value)) {
      return value;
    }
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      const parsed = Number.parseInt(value.trim(), 10);
      if (Number.isSafeInteger(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function getBoolean(row: Record<string, unknown>, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "yes", "y", "1"].includes(normalized)) {
        return true;
      }
      if (["false", "no", "n", "0"].includes(normalized)) {
        return false;
      }
    }
  }
  return null;
}

function extractUrl(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    const hrefMatch = /href=["']([^"']+)["']/i.exec(value);
    return (hrefMatch?.[1] ?? value).trim();
  }
  if (isRecord(value)) {
    return getString(value, "url", "href");
  }
  return undefined;
}

function extractSourceUrl(row: Record<string, unknown>): string | undefined {
  return (
    getString(row, "ocpfUsReportLink", "ocpf_us_report_link", "reportUrl", "report_url", "url") ??
    extractUrl(row.sourceLink) ??
    extractUrl(row.source_link)
  );
}

// OCPF is inconsistent about wrappers: filer search and the mayoral feed are
// flat arrays, while the statewide, legislative-depository, and city-council
// YTD feeds wrap rows as {reports: [...], summary: {...}} (verified live
// 2026-08-10).
function arrayPayload(payload: unknown, context: string): Record<string, unknown>[] {
  const maybeArray = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.items)
      ? payload.items
      : isRecord(payload) && Array.isArray(payload.reports)
        ? payload.reports
        : null;
  if (!maybeArray) {
    throw new MassachusettsOcpfClientError("bad_response", `Massachusetts OCPF ${context} response was not an array`);
  }
  return maybeArray.filter(isRecord);
}

function isRetryableMassachusettsOcpfStatus(status: number): boolean {
  return status === 429 || status === 503 || status === 502 || status === 504;
}

function parseRetryAfterMs(header: string | null): number | undefined {
  const raw = header?.trim();
  if (!raw) {
    return undefined;
  }
  if (/^\d+$/.test(raw)) {
    return Number(raw) * 1000;
  }
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

// The timer stays referenced: an unreferenced one let the process exit mid-retry
// once the event loop had nothing else pending (observed 2026-10-30).
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchMassachusettsOcpfJson(url: string, options: MassachusettsOcpfClientOptions = {}): Promise<unknown> {
  const retryCount = Math.max(0, Math.floor(options.retryCount ?? MASSACHUSETTS_OCPF_DEFAULT_RETRY_COUNT));
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? MASSACHUSETTS_OCPF_DEFAULT_RETRY_DELAY_MS);
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchMassachusettsOcpfJsonOnce(url, options);
    } catch (error) {
      if (
        !(error instanceof MassachusettsOcpfClientError) ||
        error.status === undefined ||
        !isRetryableMassachusettsOcpfStatus(error.status) ||
        attempt >= retryCount
      ) {
        throw error;
      }
      const backoffMs = Math.min(retryDelayMs * 2 ** attempt, MASSACHUSETTS_OCPF_MAX_RETRY_DELAY_MS);
      const delayMs = Math.min(
        Math.max(error.retryAfterMs ?? 0, backoffMs),
        MASSACHUSETTS_OCPF_MAX_RETRY_DELAY_MS
      );
      console.warn(
        `Massachusetts OCPF request retrying after HTTP ${error.status} (attempt ${attempt + 1} of ${retryCount}, ${delayMs}ms): ${url}`
      );
      await sleep(delayMs);
    }
  }
}

async function fetchMassachusettsOcpfJsonOnce(
  url: string,
  options: MassachusettsOcpfClientOptions = {}
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? MASSACHUSETTS_OCPF_DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response | null = null;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      headers: { accept: "application/json,text/plain;q=0.9,*/*;q=0.1" },
      signal: controller.signal,
    });
    if (!response.ok) {
      const failure = new MassachusettsOcpfClientError(
        "http_error",
        `Massachusetts OCPF request failed: ${response.status} ${response.statusText}`,
        response.status
      );
      failure.retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      throw failure;
    }

    return await response.json();
  } catch (error) {
    if (error instanceof MassachusettsOcpfClientError) {
      throw error;
    }
    if (isAbortError(error)) {
      throw new MassachusettsOcpfClientError(
        "network_error",
        `Massachusetts OCPF request timed out after ${timeoutMs}ms for ${url}`
      );
    }
    if (response) {
      throw new MassachusettsOcpfClientError(
        "bad_response",
        `Massachusetts OCPF response was not valid JSON for ${url}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    throw new MassachusettsOcpfClientError(
      "network_error",
      `Massachusetts OCPF request failed for ${url}: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    clearTimeout(timeout);
  }
}

export function buildMassachusettsOcpfApiUrl(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {}
): string {
  if (!path.startsWith("/")) {
    throw new MassachusettsOcpfClientError("invalid_request", `Massachusetts OCPF API path must start with /: ${path}`);
  }
  const url = new URL(path, MASSACHUSETTS_OCPF_API_BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export function buildMassachusettsOcpfCandidateFilerSearchUrl(
  input: MassachusettsOcpfCandidateFilerSearchInput
): string {
  return buildMassachusettsOcpfApiUrl("/filers/listings/A", {
    searchPhrase: normalizeNonEmptyString(input.searchPhrase, "Massachusetts OCPF filer search phrase"),
  });
}

export function buildMassachusettsOcpfStatewideReportsUrl(input: MassachusettsOcpfStatewideReportsInput): string {
  return buildMassachusettsOcpfApiUrl(`/reports/statewide/ytd/${normalizeElectionYear(input.electionYear)}`, {
    onBallot: input.onBallot ?? true,
    PageSize: normalizeLimit(
      input.limit,
      MASSACHUSETTS_OCPF_DEFAULT_REPORT_LIMIT,
      MASSACHUSETTS_OCPF_MAX_REPORT_LIMIT,
      "Massachusetts OCPF report limit"
    ),
  });
}

export function buildMassachusettsOcpfLegislativeReportsUrl(input: MassachusettsOcpfLegislativeReportsInput): string {
  // /reports/legislative/{year} always answers 200 with an empty array (the
  // API's catch-all shape); the depository YTD path is the real feed.
  return buildMassachusettsOcpfApiUrl(`/reports/legislative/depository/ytd/${normalizeElectionYear(input.electionYear)}`);
}

export function buildMassachusettsOcpfMayoralReportsUrl(input: MassachusettsOcpfMunicipalReportsInput): string {
  return buildMassachusettsOcpfApiUrl(`/reports/mayoral/depository/${normalizeElectionYear(input.electionYear)}`);
}

export function buildMassachusettsOcpfCityCouncilReportsUrl(input: MassachusettsOcpfMunicipalReportsInput): string {
  return buildMassachusettsOcpfApiUrl(`/reports/cc/ytd/${normalizeElectionYear(input.electionYear)}`);
}

export function buildMassachusettsOcpfContributionItemsUrl(input: MassachusettsOcpfContributionItemsInput): string {
  const electionYear = normalizeElectionYear(input.electionYear);
  return buildMassachusettsOcpfApiUrl("/search/items", {
    cpfId: normalizeCpfId(input.candidateCpfId),
    startDate: `1/1/${electionYear}`,
    endDate: `12/31/${electionYear}`,
    pageSize: normalizeLimit(
      input.limit,
      MASSACHUSETTS_OCPF_DEFAULT_ITEM_LIMIT,
      MASSACHUSETTS_OCPF_MAX_ITEM_LIMIT,
      "Massachusetts OCPF item limit"
    ),
    sortField: "date",
  });
}

export function buildMassachusettsOcpfIepacReportSummariesUrl(electionYear: number): string {
  return buildMassachusettsOcpfApiUrl(`/miscreports/iepacs/reports/${normalizeElectionYear(electionYear)}`);
}

export function buildMassachusettsOcpfReportDetailUrl(reportId: number): string {
  return buildMassachusettsOcpfApiUrl(`/report/${normalizeReportId(reportId)}`);
}

function parseCandidateFiler(row: Record<string, unknown>): MassachusettsOcpfCandidateFiler | null {
  const cpfId = getString(row, "cpfId", "cpf_id");
  const filerName = getString(row, "filerName", "filerFullName", "filer_full_name", "name");
  if (!cpfId || !filerName) {
    return null;
  }
  return {
    cpfId,
    filerName,
    filerNameReverse: getString(row, "filerNameReverse", "filer_full_name_reverse"),
    committeeName: getString(row, "committeeName", "committee_name"),
    officeSought: getString(row, "officeSought", "office_sought", "office"),
    accountTypeCode: getString(row, "accountTypeCode", "account_type_code"),
    accountTypeDescription: getString(row, "accountTypeDescription", "account_type_description"),
    isCandidate: getBoolean(row, "isCandidate", "is_candidate"),
    isActive: getBoolean(row, "isActive", "is_active", "active"),
  };
}

function parseCandidateReport(row: Record<string, unknown>): MassachusettsOcpfCandidateReport | null {
  const cpfId = getString(row, "cpfId", "cpf_id");
  const filerName = getString(row, "filerName", "filerFullName", "filer_full_name");
  if (!cpfId || !filerName) {
    return null;
  }
  return {
    cpfId,
    filerName,
    filerNameReverse: getString(row, "filerNameReverse", "filer_full_name_reverse"),
    officeSought: getString(row, "officeSought", "office_sought", "office"),
    receiptsYtd: getNumber(row, "receiptsYtdNumeric", "receipts_ytd_numeric", "receiptsYtd", "receipts_ytd"),
    expendituresYtd: getNumber(
      row,
      "expendituresYtdNumeric",
      "expenditures_ytd_numeric",
      "expendituresYtd",
      "expenditures_ytd"
    ),
    cashOnHand: getNumber(row, "currentCashOnHandNumeric", "current_cash_on_hand_numeric", "currentCashOnHand", "current_cash_on_hand"),
    bankReportId: getInteger(row, "bankReportId", "bank_report_id"),
    isWinner: getBoolean(row, "isWinner", "is_winner"),
    sourceUrl: extractSourceUrl(row),
  };
}

function parseContributionItem(row: Record<string, unknown>): MassachusettsOcpfContributionItem | null {
  const amount = getNumber(row, "amountValue", "amount_value", "amount", "receiptAmount", "receipt_amount");
  if (amount === undefined) {
    return null;
  }
  return {
    itemId: getString(row, "id", "itemId", "item_id"),
    reportId: getInteger(row, "reportId", "report_id"),
    cpfId: getString(row, "cpfId", "cpf_id", "filerCpfId", "filer_cpf_id"),
    filerName: getString(row, "filerName", "filerFullName", "filer_full_name", "filerFullNameReverse"),
    contributorName: getString(
      row,
      "contributorName",
      "contributor_name",
      "fullName",
      "full_name",
      "fullNameReverse",
      "name"
    ),
    contributorType: getString(row, "contributorType", "contributor_type", "contributorTypeDescription"),
    occupation: getString(row, "occupation", "contributorOccupation", "contributor_occupation"),
    employer: getString(row, "employer", "contributorEmployer", "contributor_employer"),
    recordTypeDescription: getString(row, "recordTypeDescription", "record_type_description"),
    amount,
    date: getString(row, "date", "transactionDate", "transaction_date", "receiptDate", "receipt_date"),
    sourceUrl: extractSourceUrl(row),
  };
}

function parseIepacReportSummary(row: Record<string, unknown>): MassachusettsOcpfIepacReportSummary | null {
  const reportId = getInteger(row, "reportId", "report_id", "bankReportId", "bank_report_id");
  if (!reportId) {
    return null;
  }
  return {
    reportId,
    cpfId: getString(row, "cpfId", "cpf_id"),
    committeeName: getString(row, "committeeName", "committee_name", "filerName", "filer_full_name"),
    reportYear: getInteger(row, "reportYear", "report_year"),
    reportType: getString(row, "reportType", "report_type", "reportTypeDescription"),
    reportingPeriod: getString(row, "reportingPeriod", "reporting_period"),
    candidateListing: getString(row, "candidateListing", "candidate_listing"),
    candidateSpendingBreakdown: getString(row, "candidateSpendingBreakdown", "candidate_spending_breakdown"),
    receiptsTotal: getNumber(row, "receiptTotalNumeric", "receipt_total_numeric", "receiptsTotal", "receipts_total"),
    expendituresTotal: getNumber(
      row,
      "expenditureTotalNumeric",
      "expenditure_total_numeric",
      "expendituresTotal",
      "expenditures_total"
    ),
    sourceUrl: extractSourceUrl(row),
  };
}

function parseReceiptItem(row: Record<string, unknown>): MassachusettsOcpfReceiptItem | null {
  const amount = getNumber(row, "amountValue", "amount_value", "amount", "receiptAmount", "receipt_amount");
  if (amount === undefined) {
    return null;
  }
  return {
    contributorName: getString(
      row,
      "contributorName",
      "contributor_name",
      "fullName",
      "full_name",
      "fullNameReverse",
      "name"
    ),
    contributorType: getString(row, "contributorType", "contributor_type", "contributorTypeDescription"),
    recordTypeDescription: getString(row, "recordTypeDescription", "record_type_description"),
    amount,
    date: getString(row, "date", "transactionDate", "transaction_date", "receiptDate", "receipt_date"),
    sourceUrl: extractSourceUrl(row),
  };
}

function parseExpenditureItem(row: Record<string, unknown>): MassachusettsOcpfExpenditureItem | null {
  const amount = getNumber(row, "amountValue", "amount_value", "amount", "expenditureAmount", "expenditure_amount");
  if (amount === undefined) {
    return null;
  }
  return {
    affectedCandidateName: getString(row, "affectedCandidateName", "affected_candidate_name"),
    relatedCpfId: getString(row, "relatedCpfId", "related_cpf_id"),
    isSupported: getBoolean(row, "isSupported", "is_supported"),
    recordTypeDescription: getString(row, "recordTypeDescription", "record_type_description"),
    ieInfo: getString(row, "ieInfo", "ie_info"),
    amount,
    date: getString(row, "date", "transactionDate", "transaction_date", "expenditureDate", "expenditure_date"),
    sourceUrl: extractSourceUrl(row),
  };
}

export async function searchMassachusettsOcpfCandidateFilers(
  input: MassachusettsOcpfCandidateFilerSearchInput,
  options: MassachusettsOcpfClientOptions = {}
): Promise<MassachusettsOcpfCandidateFiler[]> {
  const payload = await fetchMassachusettsOcpfJson(buildMassachusettsOcpfCandidateFilerSearchUrl(input), options);
  return arrayPayload(payload, "candidate filer search").map(parseCandidateFiler).filter((row) => row !== null);
}

export async function getMassachusettsOcpfStatewideCandidateReports(
  input: MassachusettsOcpfStatewideReportsInput,
  options: MassachusettsOcpfClientOptions = {}
): Promise<MassachusettsOcpfCandidateReport[]> {
  const payload = await fetchMassachusettsOcpfJson(buildMassachusettsOcpfStatewideReportsUrl(input), options);
  return arrayPayload(payload, "statewide candidate reports").map(parseCandidateReport).filter((row) => row !== null);
}

export async function getMassachusettsOcpfLegislativeCandidateReports(
  input: MassachusettsOcpfLegislativeReportsInput,
  options: MassachusettsOcpfClientOptions = {}
): Promise<MassachusettsOcpfCandidateReport[]> {
  const payload = await fetchMassachusettsOcpfJson(buildMassachusettsOcpfLegislativeReportsUrl(input), options);
  return arrayPayload(payload, "legislative candidate reports").map(parseCandidateReport).filter((row) => row !== null);
}

export async function getMassachusettsOcpfMayoralCandidateReports(
  input: MassachusettsOcpfMunicipalReportsInput,
  options: MassachusettsOcpfClientOptions = {}
): Promise<MassachusettsOcpfCandidateReport[]> {
  const payload = await fetchMassachusettsOcpfJson(buildMassachusettsOcpfMayoralReportsUrl(input), options);
  return arrayPayload(payload, "mayoral candidate reports").map(parseCandidateReport).filter((row) => row !== null);
}

export async function getMassachusettsOcpfCityCouncilCandidateReports(
  input: MassachusettsOcpfMunicipalReportsInput,
  options: MassachusettsOcpfClientOptions = {}
): Promise<MassachusettsOcpfCandidateReport[]> {
  const payload = await fetchMassachusettsOcpfJson(buildMassachusettsOcpfCityCouncilReportsUrl(input), options);
  return arrayPayload(payload, "city council candidate reports").map(parseCandidateReport).filter((row) => row !== null);
}

export async function getMassachusettsOcpfContributionItems(
  input: MassachusettsOcpfContributionItemsInput,
  options: MassachusettsOcpfClientOptions = {}
): Promise<MassachusettsOcpfContributionItem[]> {
  const limit = normalizeLimit(
    input.limit,
    MASSACHUSETTS_OCPF_DEFAULT_ITEM_LIMIT,
    MASSACHUSETTS_OCPF_MAX_ITEM_LIMIT,
    "Massachusetts OCPF item limit"
  );
  const payload = await fetchMassachusettsOcpfJson(buildMassachusettsOcpfContributionItemsUrl({ ...input, limit }), options);
  const rows = arrayPayload(payload, "contribution items");
  if (rows.length >= limit) {
    throw new MassachusettsOcpfClientError(
      "bad_response",
      `Massachusetts OCPF contribution items reached the ${limit} row limit; refusing partial data`
    );
  }
  return rows.map(parseContributionItem).filter((row) => row !== null);
}

export async function getMassachusettsOcpfIepacReportSummaries(
  electionYear: number,
  options: MassachusettsOcpfClientOptions = {}
): Promise<MassachusettsOcpfIepacReportSummary[]> {
  const payload = await fetchMassachusettsOcpfJson(buildMassachusettsOcpfIepacReportSummariesUrl(electionYear), options);
  return arrayPayload(payload, "IEPAC report summaries").map(parseIepacReportSummary).filter((row) => row !== null);
}

export async function getMassachusettsOcpfReportDetail(
  input: MassachusettsOcpfReportDetailInput,
  options: MassachusettsOcpfClientOptions = {}
): Promise<MassachusettsOcpfReportDetail> {
  const payload = await fetchMassachusettsOcpfJson(buildMassachusettsOcpfReportDetailUrl(input.reportId), options);
  if (!isRecord(payload)) {
    throw new MassachusettsOcpfClientError("bad_response", "Massachusetts OCPF report detail response was not an object");
  }

  const summary = parseIepacReportSummary({ ...payload, reportId: input.reportId });
  if (!summary) {
    throw new MassachusettsOcpfClientError("bad_response", "Massachusetts OCPF report detail was missing report id");
  }

  const receiptRows = Array.isArray(payload.receipts) ? payload.receipts.filter(isRecord) : [];
  const expenditureRows = Array.isArray(payload.expenditures) ? payload.expenditures.filter(isRecord) : [];
  return {
    ...summary,
    receipts: receiptRows.map(parseReceiptItem).filter((row) => row !== null),
    expenditures: expenditureRows.map(parseExpenditureItem).filter((row) => row !== null),
  };
}
