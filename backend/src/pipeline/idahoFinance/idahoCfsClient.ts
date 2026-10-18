// Idaho Sunshine (Civix CFIS) anonymous JSON client. Request and response
// contracts verified live 2026-09-01; see backend/docs/idaho-campaign-finance.md.

import { decodeIdahoCfsCsv } from "./idahoCfsCsv.js";

export const IDAHO_CFS_API_BASE_URL = "https://api-sunshine.voteidaho.gov/api";
export const IDAHO_CFS_PUBLIC_SITE_URL = "https://sunshine.voteidaho.gov";

export const IDAHO_CFS_ENDPOINTS = {
  bulkExport: "ExportData/GetExportPublicDownloadData",
  candidateRegistrations: "PublicFilerDetails/GetCandidateDetails",
  contributions: "PublicTransactionDetails/GetContributionsDetails",
  independentExpenditures: "PublicIndependentExpenditureDetails/GetIndependentExpenditureDetails",
} as const;

export type IdahoCfsTransactionTypeCode = "TCON" | "TEXP";

export type IdahoCfsClientErrorCode = "invalid_request" | "network_error" | "http_error" | "bad_response";

export class IdahoCfsClientError extends Error {
  constructor(
    public readonly code: IdahoCfsClientErrorCode,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "IdahoCfsClientError";
  }
}

export type IdahoCfsClientOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
};

// One row of the public candidate grid: one registration per candidate per
// election cycle. totalRaised/totalSpent are the state's official cycle totals.
export type IdahoCandidateRegistrationRow = {
  registrationGuid: string;
  entityGuid: string;
  filerEntityId: number;
  filerRegistrationId: number;
  filerName: string;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  committeeName: string | null;
  office: string | null;
  districtType: string | null;
  district: string | null;
  jurisdiction: string | null;
  // House seat (A/B) or county-commissioner district number; null elsewhere.
  seatZone: string | null;
  party: string | null;
  partyCode: string | null;
  electionYear: number;
  filingCycleId: number;
  status: string;
  statusCode: string;
  totalRaised: number;
  totalSpent: number;
  balanceOfFunds: number;
  isLegacyRecord: boolean;
};

// One current-version contribution transaction from the public search.
export type IdahoContributionRow = {
  guid: string;
  transactionId: number;
  transactionVersionId: number;
  filerReportId: number;
  filerReportVersionId: number;
  filerReportGuid: string | null;
  filerRegistrationGuid: string;
  filerEntityId: number;
  filerName: string;
  transactionAmount: number;
  // MM/DD/YYYY as served.
  transactionDate: string;
  transactionTypeCode: string;
  transactionSubTypeCode: string;
  sourceTypeCode: string | null;
  sourceName: string | null;
  contributorCity: string | null;
  contributorState: string | null;
  stateType: string | null;
  electionYear: number;
  electionTypeCode: string | null;
  reportName: string | null;
  timedReport: string | null;
  filedDate: string | null;
};

// One target allocation of an independent expenditure (a transaction split
// across several candidates yields one row per candidate).
export type IdahoIndependentExpenditureRow = {
  guid: string;
  candidateMeasure: string;
  officeSought: string | null;
  amountApplied: number;
  // ISO date-time as served (2026-08-24T00:00:00).
  transactionDate: string;
  filerName: string;
  filerRegistrationGuid: string | null;
  candidateMeasureFilerRegistrationGuid: string | null;
  reportName: string | null;
  timedReport: string | null;
  purpose: string | null;
  stance: string;
  sourceName: string | null;
  isNonRegisteredEntity: boolean;
  isCandidateNonRegisteredEntity: boolean;
  transactionTypeCode: string;
};

export type IdahoCfsPage<T> = {
  items: T[];
  totalItems: number;
};

export type IdahoCandidateRegistrationSearchInput = {
  pageNumber?: number;
  pageSize?: number;
};

export type IdahoContributionSearchInput = {
  pageNumber?: number;
  pageSize?: number;
  // The service filters by filer name only; its filerRegistrationGuid body
  // field is ignored (verified live), so callers filter rows by
  // filerRegistrationGuid themselves.
  filerName: string;
};

export type IdahoIndependentExpenditureSearchInput = {
  pageNumber?: number;
  pageSize?: number;
};

export const IDAHO_CFS_FETCH_TIMEOUT_MS = 120_000;
// The edge rejects library user agents (Python-urllib → 403); a minimal
// browser token plus the public SPA Origin/Referer is accepted.
const DEFAULT_USER_AGENT = "Mozilla/5.0";
const DEFAULT_PAGE_SIZE = 500;
// 5,000 (candidate grid), 10,000 (contribution search), and 50,000 (IE
// list: 9,899 of 9,899 rows served in one page, 2026-09-03) verified live.
const MAX_PAGE_SIZE = 50_000;
const MAX_JSON_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_CSV_RESPONSE_BYTES = 128 * 1024 * 1024;

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new IdahoCfsClientError("invalid_request", `Invalid ${label}: ${value}`);
  }
  return value;
}

function requirePageSize(value: number | undefined): number {
  const pageSize = value ?? DEFAULT_PAGE_SIZE;
  requirePositiveInteger(pageSize, "Idaho CFS page size");
  if (pageSize > MAX_PAGE_SIZE) {
    throw new IdahoCfsClientError("invalid_request", `Idaho CFS page size exceeds ${MAX_PAGE_SIZE}: ${pageSize}`);
  }
  return pageSize;
}

// The new system lists 2020+; only 2023+ carry real data.
function requireFilingYear(value: number): number {
  if (!Number.isInteger(value) || value < 2020 || value > 2100) {
    throw new IdahoCfsClientError("invalid_request", `Invalid Idaho CFS filing year: ${value}`);
  }
  return value;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new IdahoCfsClientError("bad_response", `Invalid Idaho CFS ${label}`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new IdahoCfsClientError("bad_response", `Invalid Idaho CFS ${label}`);
  }
  return value.trim();
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new IdahoCfsClientError("bad_response", `Invalid Idaho CFS ${label}`);
  }
  return value;
}

function requiredInteger(value: unknown, label: string): number {
  const parsed = requiredNumber(value, label);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new IdahoCfsClientError("bad_response", `Invalid Idaho CFS ${label}`);
  }
  return parsed;
}

// The grid serves electionYear as "2026"; the transaction search serves 2026.
function requiredYear(value: unknown, label: string): number {
  const raw = typeof value === "string" ? value.trim() : value;
  const parsed = typeof raw === "string" && /^\d{4}$/.test(raw) ? Number(raw) : raw;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 2000 || parsed > 2100) {
    throw new IdahoCfsClientError("bad_response", `Invalid Idaho CFS ${label}`);
  }
  return parsed;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function buildUrl(endpoint: string): string {
  if (!/^[A-Za-z][A-Za-z0-9/]+$/.test(endpoint)) {
    throw new IdahoCfsClientError("invalid_request", `Invalid Idaho CFS endpoint: ${endpoint}`);
  }
  return `${IDAHO_CFS_API_BASE_URL}/${endpoint}`;
}

async function post(input: {
  endpoint: string;
  body: Record<string, unknown>;
  expectedContentType: "json" | "csv";
  options?: IdahoCfsClientOptions;
}): Promise<Uint8Array> {
  const fetchImpl = input.options?.fetchImpl ?? fetch;
  const timeoutMs = input.options?.timeoutMs ?? IDAHO_CFS_FETCH_TIMEOUT_MS;
  const userAgent = input.options?.userAgent?.trim() || DEFAULT_USER_AGENT;
  requirePositiveInteger(timeoutMs, "Idaho CFS timeout");

  let response: Response;
  try {
    response = await fetchImpl(buildUrl(input.endpoint), {
      method: "POST",
      headers: {
        Accept: input.expectedContentType === "json" ? "application/json, text/plain, */*" : "text/csv, */*",
        "Content-Type": "application/json",
        Origin: IDAHO_CFS_PUBLIC_SITE_URL,
        Referer: `${IDAHO_CFS_PUBLIC_SITE_URL}/`,
        "User-Agent": userAgent,
      },
      body: JSON.stringify(input.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new IdahoCfsClientError("network_error", `Idaho CFS request failed: ${message}`);
  }

  if (!response.ok) {
    throw new IdahoCfsClientError(
      "http_error",
      `Idaho CFS request returned HTTP ${response.status}: ${input.endpoint}`,
      response.status
    );
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const validContentType =
    input.expectedContentType === "json" ? contentType.includes("application/json") : contentType.includes("text/csv");
  if (!validContentType) {
    throw new IdahoCfsClientError(
      "bad_response",
      `Idaho CFS ${input.endpoint} returned unexpected content type: ${contentType || "missing"}`
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const maxBytes = input.expectedContentType === "json" ? MAX_JSON_RESPONSE_BYTES : MAX_CSV_RESPONSE_BYTES;
  if (bytes.byteLength > maxBytes) {
    throw new IdahoCfsClientError("bad_response", `Idaho CFS ${input.endpoint} exceeded ${maxBytes} bytes`);
  }
  return bytes;
}

async function postJson(
  endpoint: string,
  body: Record<string, unknown>,
  options?: IdahoCfsClientOptions
): Promise<Record<string, unknown>> {
  const bytes = await post({ endpoint, body, expectedContentType: "json", options });
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new IdahoCfsClientError("bad_response", `Idaho CFS ${endpoint} returned invalid JSON`);
  }
  const envelope = objectValue(parsed, "response envelope");
  if (envelope.succeeded !== true) {
    const error =
      typeof envelope.error === "object" && envelope.error !== null
        ? (envelope.error as Record<string, unknown>).message
        : null;
    throw new IdahoCfsClientError(
      "bad_response",
      `Idaho CFS ${endpoint} failed${typeof error === "string" ? `: ${error}` : ""}`
    );
  }
  return envelope;
}

function parsePage<T>(envelope: Record<string, unknown>, parseItem: (value: unknown) => T): IdahoCfsPage<T> {
  const data = objectValue(envelope.data, "page data");
  if (!Array.isArray(data.items)) {
    throw new IdahoCfsClientError("bad_response", "Invalid Idaho CFS page items");
  }
  const totalItems = requiredNumber(data.totalItems, "page totalItems");
  if (!Number.isInteger(totalItems) || totalItems < 0) {
    throw new IdahoCfsClientError("bad_response", "Invalid Idaho CFS page totalItems");
  }
  return { items: data.items.map(parseItem), totalItems };
}

function parseCandidateRegistrationRow(value: unknown): IdahoCandidateRegistrationRow {
  const row = objectValue(value, "candidate-registration row");
  return {
    registrationGuid: requiredString(row.guid, "candidate-registration guid"),
    entityGuid: requiredString(row.entityGuid, "candidate-registration entityGuid"),
    filerEntityId: requiredInteger(row.filerEntityID, "candidate-registration filerEntityID"),
    filerRegistrationId: requiredInteger(row.filerRegistrationId, "candidate-registration filerRegistrationId"),
    filerName: requiredString(row.filerName, "candidate-registration filerName"),
    firstName: nullableString(row.firstName),
    middleName: nullableString(row.middleName),
    lastName: nullableString(row.lastName),
    committeeName: nullableString(row.committeeName),
    office: nullableString(row.office),
    districtType: nullableString(row.districtType),
    district: nullableString(row.cityDistrict),
    jurisdiction: nullableString(row.jurisdiction),
    seatZone: nullableString(row.seatZone),
    party: nullableString(row.politicalParty),
    partyCode: nullableString(row.politicalPartyCode),
    electionYear: requiredYear(row.electionYear, "candidate-registration electionYear"),
    filingCycleId: requiredInteger(row.filingCycleId, "candidate-registration filingCycleId"),
    status: requiredString(row.filerStatus, "candidate-registration filerStatus"),
    statusCode: requiredString(row.filerStatusCode, "candidate-registration filerStatusCode"),
    totalRaised: requiredNumber(row.totalRaised, "candidate-registration totalRaised"),
    totalSpent: requiredNumber(row.totalSpent, "candidate-registration totalSpent"),
    balanceOfFunds: requiredNumber(row.balanceOfFunds, "candidate-registration balanceOfFunds"),
    isLegacyRecord: booleanValue(row.isLegacyRecord),
  };
}

// Original-byte component replay uses the same native registration contract.
export { parseCandidateRegistrationRow as parseIdahoCandidateRegistrationRow };

function parseContributionRow(value: unknown): IdahoContributionRow {
  const row = objectValue(value, "contribution row");
  return {
    guid: requiredString(row.guid, "contribution guid"),
    transactionId: requiredInteger(row.transactionId, "contribution transactionId"),
    transactionVersionId: requiredInteger(row.transactionVersionId, "contribution transactionVersionId"),
    filerReportId: requiredInteger(row.filerReportId, "contribution filerReportId"),
    filerReportVersionId: requiredInteger(row.filerReportVersionId, "contribution filerReportVersionId"),
    filerReportGuid: nullableString(row.filerReportGuid),
    filerRegistrationGuid: requiredString(row.filerRegistrationGuid, "contribution filerRegistrationGuid"),
    filerEntityId: requiredInteger(row.filerEntityId, "contribution filerEntityId"),
    filerName: requiredString(row.filerName, "contribution filerName"),
    transactionAmount: requiredNumber(row.transactionAmount, "contribution transactionAmount"),
    transactionDate: requiredString(row.transactionDate, "contribution transactionDate"),
    transactionTypeCode: requiredString(row.transactionTypeCode, "contribution transactionTypeCode"),
    transactionSubTypeCode: requiredString(row.transactionSubTypeCode, "contribution transactionSubTypeCode"),
    sourceTypeCode: nullableString(row.transactionSourceTypeCode),
    sourceName: nullableString(row.sourceName),
    contributorCity: nullableString(row.contributorCity),
    contributorState: nullableString(row.contributorState),
    stateType: nullableString(row.stateType),
    electionYear: requiredYear(row.electionYear, "contribution electionYear"),
    electionTypeCode: nullableString(row.electionTypeCode),
    reportName: nullableString(row.reportName),
    timedReport: nullableString(row.timedReport),
    filedDate: nullableString(row.filedDate),
  };
}

function parseIndependentExpenditureRow(value: unknown): IdahoIndependentExpenditureRow {
  const row = objectValue(value, "independent-expenditure row");
  return {
    guid: requiredString(row.guid, "IE guid"),
    candidateMeasure: requiredString(row.candidateMeasure, "IE candidateMeasure"),
    officeSought: nullableString(row.officeSought),
    amountApplied: requiredNumber(row.amountApplied, "IE amountApplied"),
    transactionDate: requiredString(row.transactionDate, "IE transactionDate"),
    filerName: requiredString(row.filerName, "IE filerName"),
    filerRegistrationGuid: nullableString(row.filerRegistrationGuid),
    candidateMeasureFilerRegistrationGuid: nullableString(row.candidateMeasureFilerRegistrationGuid),
    reportName: nullableString(row.reportName),
    timedReport: nullableString(row.timedReport),
    purpose: nullableString(row.purpose),
    stance: requiredString(row.stance, "IE stance"),
    sourceName: nullableString(row.sourceName),
    isNonRegisteredEntity: booleanValue(row.isNonRegisteredEntity),
    isCandidateNonRegisteredEntity: booleanValue(row.isCandidateNonRegisteredEntity),
    transactionTypeCode: requiredString(row.transactionTypeCode, "IE transactionTypeCode"),
  };
}

export async function downloadIdahoCfsBulkCsv(
  input: { filingYear: number; transactionTypeCode: IdahoCfsTransactionTypeCode },
  options?: IdahoCfsClientOptions
): Promise<string> {
  const bytes = await post({
    endpoint: IDAHO_CFS_ENDPOINTS.bulkExport,
    body: {
      type: "CSV",
      filingYear: requireFilingYear(input.filingYear),
      transactionTypeCode: input.transactionTypeCode,
    },
    expectedContentType: "csv",
    options,
  });
  return decodeIdahoCfsCsv(bytes);
}

export async function getIdahoCandidateRegistrationPage(
  input: IdahoCandidateRegistrationSearchInput,
  options?: IdahoCfsClientOptions
): Promise<IdahoCfsPage<IdahoCandidateRegistrationRow>> {
  const envelope = await postJson(
    IDAHO_CFS_ENDPOINTS.candidateRegistrations,
    {
      pageNumber: requirePositiveInteger(input.pageNumber ?? 1, "Idaho CFS page number"),
      pageSize: requirePageSize(input.pageSize),
      sortBy: null,
      sortType: null,
    },
    options
  );
  return parsePage(envelope, parseCandidateRegistrationRow);
}

export async function getIdahoContributionPage(
  input: IdahoContributionSearchInput,
  options?: IdahoCfsClientOptions
): Promise<IdahoCfsPage<IdahoContributionRow>> {
  const filerName = input.filerName.trim();
  if (!filerName) {
    throw new IdahoCfsClientError("invalid_request", "Idaho contribution search requires filerName");
  }
  const envelope = await postJson(
    IDAHO_CFS_ENDPOINTS.contributions,
    {
      pageNumber: requirePositiveInteger(input.pageNumber ?? 1, "Idaho CFS page number"),
      pageSize: requirePageSize(input.pageSize),
      sortBy: "TransactionDate",
      sortType: "desc",
      transactionTypeCode: "TCON",
      filerName,
      sourceName: null,
      transactionAmountMax: null,
      transactionAmountMin: null,
      sourceTypeCode: null,
      committeeType: null,
      transactionSubTypeCode: null,
      electionID: null,
      reportName: null,
      toDate: null,
      fromDate: null,
      electionType: null,
      electionYear: null,
      filerRegistrationGuid: null,
    },
    options
  );
  return parsePage(envelope, parseContributionRow);
}

export async function getIdahoIndependentExpenditurePage(
  input: IdahoIndependentExpenditureSearchInput,
  options?: IdahoCfsClientOptions
): Promise<IdahoCfsPage<IdahoIndependentExpenditureRow>> {
  const envelope = await postJson(
    IDAHO_CFS_ENDPOINTS.independentExpenditures,
    {
      pageNumber: requirePositiveInteger(input.pageNumber ?? 1, "Idaho CFS page number"),
      pageSize: requirePageSize(input.pageSize),
      sortBy: null,
      sortType: null,
    },
    options
  );
  return parsePage(envelope, parseIndependentExpenditureRow);
}

async function getAllPages<T>(input: {
  pageSize: number;
  getPage: (pageNumber: number) => Promise<IdahoCfsPage<T>>;
}): Promise<T[]> {
  const items: T[] = [];
  let expectedTotal: number | null = null;
  for (let pageNumber = 1; ; pageNumber += 1) {
    const page = await input.getPage(pageNumber);
    if (expectedTotal === null) {
      expectedTotal = page.totalItems;
    } else if (page.totalItems !== expectedTotal) {
      throw new IdahoCfsClientError(
        "bad_response",
        `Idaho CFS totalItems changed during pagination: ${expectedTotal} -> ${page.totalItems}`
      );
    }
    items.push(...page.items);
    if (items.length >= expectedTotal) {
      if (items.length !== expectedTotal) {
        throw new IdahoCfsClientError(
          "bad_response",
          `Idaho CFS pagination returned ${items.length} rows for totalItems ${expectedTotal}`
        );
      }
      return items;
    }
    if (page.items.length === 0 || page.items.length > input.pageSize) {
      throw new IdahoCfsClientError("bad_response", "Idaho CFS pagination ended inconsistently");
    }
  }
}

export async function getAllIdahoCandidateRegistrations(
  input: Omit<IdahoCandidateRegistrationSearchInput, "pageNumber"> = {},
  options?: IdahoCfsClientOptions
): Promise<IdahoCandidateRegistrationRow[]> {
  const pageSize = requirePageSize(input.pageSize);
  return getAllPages({
    pageSize,
    getPage: (pageNumber) => getIdahoCandidateRegistrationPage({ pageNumber, pageSize }, options),
  });
}

export async function getAllIdahoContributions(
  input: Omit<IdahoContributionSearchInput, "pageNumber">,
  options?: IdahoCfsClientOptions
): Promise<IdahoContributionRow[]> {
  const pageSize = requirePageSize(input.pageSize);
  return getAllPages({
    pageSize,
    getPage: (pageNumber) => getIdahoContributionPage({ ...input, pageNumber, pageSize }, options),
  });
}

export async function getAllIdahoIndependentExpenditures(
  input: Omit<IdahoIndependentExpenditureSearchInput, "pageNumber"> = {},
  options?: IdahoCfsClientOptions
): Promise<IdahoIndependentExpenditureRow[]> {
  const pageSize = requirePageSize(input.pageSize);
  return getAllPages({
    pageSize,
    getPage: (pageNumber) => getIdahoIndependentExpenditurePage({ pageNumber, pageSize }, options),
  });
}

// The transaction search matches the registration's filer name as
// "First Middle Last" (the SPA's filerFirstMiddleLastNameSearch form).
export function idahoRegistrationSearchName(registration: {
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  filerName: string;
}): string {
  const parts = [registration.firstName, registration.middleName, registration.lastName].filter(
    (part): part is string => part !== null && part.length > 0
  );
  return parts.length > 0 ? parts.join(" ") : registration.filerName;
}

const REGISTRATION_GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The grid serves guids lowercase; lowercase defensively so link identity,
// artifact paths, and IE target comparisons never split on case.
export function normalizeIdahoRegistrationGuid(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!REGISTRATION_GUID_PATTERN.test(normalized)) {
    throw new Error(`Invalid Idaho registration guid: ${JSON.stringify(value)}`);
  }
  return normalized;
}

// Public candidate profile for one registration (deep link verified live).
export function idahoRegistrationProfileUrl(registrationGuid: string): string {
  return `${IDAHO_CFS_PUBLIC_SITE_URL}/public/cf/candidateprofile?guid=${normalizeIdahoRegistrationGuid(registrationGuid)}&tabName=CAN&isLegacy=false`;
}
