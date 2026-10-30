export const VERMONT_CAMPAIGN_FINANCE_API_BASE_URL = "https://api.campaignfinance.vermont.gov/api";
export const VERMONT_CAMPAIGN_FINANCE_DEFAULT_TIMEOUT_MS = 30_000;
export const VERMONT_CAMPAIGN_FINANCE_DEFAULT_PAGE_SIZE = 100;
export const VERMONT_CAMPAIGN_FINANCE_MAX_PAGE_SIZE = 1_000;

export type VermontCampaignFinanceClientErrorCode =
  | "invalid_request"
  | "network_error"
  | "http_error"
  | "bad_response";

export class VermontCampaignFinanceClientError extends Error {
  constructor(
    public readonly code: VermontCampaignFinanceClientErrorCode,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "VermontCampaignFinanceClientError";
  }
}

export type VermontCampaignFinanceClientOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type VermontTransactionSortType = "asc" | "desc" | "ASC" | "DESC";

export type VermontTransactionSearchInput = {
  pageNumber?: number;
  pageSize?: number;
  sortBy?: string;
  sortType?: VermontTransactionSortType;
  transactionTypeCode?: "TCON" | "TEXP" | string;
  filerRegistrationGuid?: string;
  filerName?: string;
  electionYear?: number;
  electionId?: number;
  transactionAmountMin?: number;
  transactionAmountMax?: number;
  /** Inclusive YYYY-MM-DD transaction-date bounds (API fields fromDate/toDate). */
  fromDate?: string;
  toDate?: string;
};

export type VermontPagedResult<T> = {
  items: T[];
  totalItems: number;
};

export type VermontContributionRow = {
  transactionId: number;
  transactionVersionId: number | null;
  guid: string;
  filerRegistrationGuid: string;
  filerName: string;
  transactionAmount: number;
  transactionDate: string | null;
  sourceName: string | null;
  sourceFirstName: string | null;
  sourceLastName: string | null;
  sourceMiddleName: string | null;
  transactionSource: string | null;
  transactionSourceTypeCode: string | null;
  transactionSubTypeCode: string | null;
  transactionSubTypeDescription: string | null;
  filerTypeCode: string | null;
  filerTypeDescription: string | null;
  electionYear: number | null;
  electionCycle: string | null;
  electionId: number | null;
  officeId: number | null;
  officeType: string | null;
  entityId: number | null;
  reportName: string | null;
  candidateFirstName: string | null;
  candidateLastName: string | null;
  candidateMiddleName: string | null;
  occupation: string | null;
  employer: string | null;
  filingYear: number | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  stateCode: string | null;
  zipCode: string | null;
  filerReportGuid?: string | null;
  timedFiledReportGuid?: string | null;
  transactionTypeCode?: string | null;
  hasChild?: boolean | null;
};

export type VermontExpenditureRow = {
  transactionId: number;
  transactionVersionId: number | null;
  guid: string;
  filerRegistrationGuid: string;
  filerName: string;
  transactionAmount: number;
  transactionDate: string | null;
  transactionCategoryCode: string | null;
  transactionCategoryDescription: string | null;
  expenditurePurpose: string | null;
  description: string | null;
  isStanceSupport: boolean | null;
  payeeType: string | null;
  sourceName: string | null;
  transactionSource: string | null;
  filerTypeCode: string | null;
  filerTypeDescription: string | null;
  electionYear: number | null;
  electionCycle: string | null;
  electionId: number | null;
  officeId: number | null;
  officeType: string | null;
  entityId: number | null;
  reportName: string | null;
  candidateMentioned: string | null;
  candidateFirstName: string | null;
  candidateLastName: string | null;
  candidateMiddleName: string | null;
  sourceAddressLine1: string | null;
  sourceAddressLine2: string | null;
  sourceCity: string | null;
  sourceState: string | null;
  sourceZipCode: string | null;
  filerReportGuid?: string | null;
  timedFiledReportGuid?: string | null;
  transactionTypeCode?: string | null;
  transactionSubTypeCode?: string | null;
  isMassMedia?: boolean | null;
  hasChild?: boolean | null;
};

export type VermontTransactionDetail = {
  transactionId: number;
  transactionVersionId: number | null;
  guid: string;
  transactionTypeCode: string | null;
  transactionTypeDescription: string | null;
  transactionSubTypeCode: string | null;
  transactionSubTypeDescription: string | null;
  transactionSourceTypeCode: string | null;
  transactionSourceTypeDescription: string | null;
  transactionSource: string | null;
  transactionDate: string | null;
  filerName: string | null;
  contributor: string | null;
  valueOfNonMoneyItem: number | null;
  transactionCategoryDescription: string | null;
  electionYear: number | null;
  comments: string | null;
};

export type VermontContributionCategory = {
  amount: number;
  transactionSourceTypeCode: string;
  transactionSourceType: string;
};

export type VermontOfficeSoughtLookupItem = {
  value: string;
  officeId: number;
  name: string;
  code: string | null;
};

export type VermontElectionLookupItem = {
  electionId: number;
  name: string;
};

export type VermontFiledReportRow = {
  filerReportGuid: string;
  filerFilingCalendarGuid: string;
  filerReportVersionId: number;
  reportName: string;
  reportType: string;
  reportStatus: string;
  reportVersion: string;
  startDate: string;
  endDate: string;
  dueDate: string;
  filedDate: string;
  isPaperFile: boolean;
  hasChild: boolean;
};

type VermontApiEnvelope = {
  data?: unknown;
  succeeded?: unknown;
  error?: unknown;
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

function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("..")) {
    throw new VermontCampaignFinanceClientError("invalid_request", `Invalid Vermont campaign finance endpoint: ${endpoint}`);
  }
  return trimmed;
}

export function buildVermontCampaignFinanceApiUrl(endpoint: string): string {
  return new URL(normalizeEndpoint(endpoint), `${VERMONT_CAMPAIGN_FINANCE_API_BASE_URL}/`).toString();
}

function normalizePositiveInteger(value: number | undefined, fallback: number, fieldName: string, max: number): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0 || normalized > max) {
    throw new VermontCampaignFinanceClientError(
      "invalid_request",
      `${fieldName} must be an integer between 1 and ${max}`
    );
  }
  return normalized;
}

function normalizeOptionalInteger(value: number | undefined, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new VermontCampaignFinanceClientError("invalid_request", `${fieldName} must be a positive integer`);
  }
  return value;
}

function normalizeOptionalAmount(value: number | undefined, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value)) {
    throw new VermontCampaignFinanceClientError("invalid_request", `${fieldName} must be a finite number`);
  }
  return value;
}

function normalizeOptionalIsoDate(value: string | undefined, fieldName: string): string | undefined {
  const text = normalizeOptionalText(value);
  if (text === undefined) {
    return undefined;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new VermontCampaignFinanceClientError("invalid_request", `${fieldName} must be YYYY-MM-DD`);
  }
  return text;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeSortType(
  value: VermontTransactionSortType | undefined,
): "asc" | "desc" {
  const normalized = (value ?? "desc").toLowerCase();
  if (normalized !== "asc" && normalized !== "desc") {
    throw new VermontCampaignFinanceClientError(
      "invalid_request",
      "Invalid Vermont transaction sortType",
    );
  }
  return normalized;
}

function assertEndpointTransactionType(input: {
  transactionTypeCode: string | undefined;
  expectedTransactionTypeCode: "TCON" | "TEXP";
  endpointName: string;
}): void {
  const transactionTypeCode = normalizeOptionalText(input.transactionTypeCode);
  if (!transactionTypeCode || transactionTypeCode === input.expectedTransactionTypeCode) {
    return;
  }
  throw new VermontCampaignFinanceClientError(
    "invalid_request",
    `${input.endpointName} requires transactionTypeCode ${input.expectedTransactionTypeCode}`
  );
}

export function buildVermontTransactionSearchPayload(
  input: VermontTransactionSearchInput,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    pageNumber: normalizePositiveInteger(
      input.pageNumber,
      1,
      "Vermont campaign finance pageNumber",
      100_000,
    ),
    pageSize: normalizePositiveInteger(
      input.pageSize,
      VERMONT_CAMPAIGN_FINANCE_DEFAULT_PAGE_SIZE,
      "Vermont campaign finance pageSize",
      VERMONT_CAMPAIGN_FINANCE_MAX_PAGE_SIZE,
    ),
    sortBy: normalizeOptionalText(input.sortBy) ?? "TransactionDate",
    sortType: normalizeSortType(input.sortType),
  };

  const transactionTypeCode = normalizeOptionalText(input.transactionTypeCode);
  if (transactionTypeCode) {
    payload.transactionTypeCode = transactionTypeCode;
  }

  const filerRegistrationGuid = normalizeOptionalText(
    input.filerRegistrationGuid,
  );
  if (filerRegistrationGuid) {
    payload.filerRegistrationGuid = filerRegistrationGuid;
  }

  const filerName = normalizeOptionalText(input.filerName);
  if (filerName) {
    payload.filerName = filerName;
  }

  const electionYear = normalizeOptionalInteger(
    input.electionYear,
    "Vermont campaign finance electionYear",
  );
  if (electionYear !== undefined) {
    payload.electionYear = electionYear;
  }

  const fromDate = normalizeOptionalIsoDate(input.fromDate, "Vermont campaign finance fromDate");
  if (fromDate) {
    payload.fromDate = fromDate;
  }
  const toDate = normalizeOptionalIsoDate(input.toDate, "Vermont campaign finance toDate");
  if (toDate) {
    payload.toDate = toDate;
  }

  const electionId = normalizeOptionalInteger(
    input.electionId,
    "Vermont campaign finance electionId",
  );
  if (electionId !== undefined) {
    // The public UI/API uses electionID. electionId is silently ignored.
    payload.electionID = electionId;
  }

  const transactionAmountMin = normalizeOptionalAmount(
    input.transactionAmountMin,
    "Vermont campaign finance transactionAmountMin",
  );
  if (transactionAmountMin !== undefined) {
    payload.transactionAmountMin = transactionAmountMin;
  }

  const transactionAmountMax = normalizeOptionalAmount(
    input.transactionAmountMax,
    "Vermont campaign finance transactionAmountMax",
  );
  if (transactionAmountMax !== undefined) {
    payload.transactionAmountMax = transactionAmountMax;
  }

  return payload;
}

function getString(row: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

function getNumber(row: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null) return parseVermontMoneyAmount(value, key);
  }
  return null;
}

function parseVermontMoneyAmount(value: unknown, field: string): number {
  const fail = () => new VermontCampaignFinanceClientError("bad_response", `Invalid Vermont campaign finance ${field}`);
  const lexeme = typeof value === "number" && Number.isFinite(value) ? String(value) :
    typeof value === "string" ? value.trim() : "";
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(lexeme);
  if (!match) throw fail();
  const cents = (BigInt(match[2]!) * 100n + BigInt((match[3] ?? "").padEnd(2, "0"))) * (match[1] ? -1n : 1n);
  if (cents < -BigInt(Number.MAX_SAFE_INTEGER) || cents > BigInt(Number.MAX_SAFE_INTEGER)) throw fail();
  const amount = Number(cents) / 100;
  const roundTrip = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(amount));
  if (!roundTrip) throw fail();
  const roundTripCents = (BigInt(roundTrip[2]!) * 100n + BigInt((roundTrip[3] ?? "").padEnd(2, "0"))) * (roundTrip[1] ? -1n : 1n);
  // Preserve exact source cents through the number-valued DTO and downstream cents conversion.
  if (roundTripCents !== cents || BigInt(Math.round(amount * 100)) !== cents) throw fail();
  return amount;
}

function getInteger(
  row: Record<string, unknown>,
  ...keys: string[]
): number | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "number" && Number.isSafeInteger(value)) return value;
    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
      const parsed = Number(value.trim());
      if (Number.isSafeInteger(parsed)) return parsed;
    }
  }
  return null;
}

function requireTransactionAmount(row: Record<string, unknown>): number {
  return parseVermontMoneyAmount(row.transactionAmount, "transactionAmount");
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

function requireString(row: Record<string, unknown>, fieldName: string, ...keys: string[]): string {
  const value = getString(row, ...keys);
  if (!value) {
    throw new VermontCampaignFinanceClientError("bad_response", `Missing Vermont campaign finance ${fieldName}`);
  }
  return value;
}

function requireInteger(row: Record<string, unknown>, fieldName: string, ...keys: string[]): number {
  const value = getInteger(row, ...keys);
  if (value === null) {
    throw new VermontCampaignFinanceClientError("bad_response", `Missing Vermont campaign finance ${fieldName}`);
  }
  return value;
}

function parseEnvelope(payload: unknown, context: string): VermontApiEnvelope {
  if (!isRecord(payload)) {
    throw new VermontCampaignFinanceClientError("bad_response", `Vermont ${context} response was not an object`);
  }
  if (payload.succeeded === false) {
    const message = typeof payload.error === "string" ? payload.error : `Vermont ${context} request was not successful`;
    throw new VermontCampaignFinanceClientError("bad_response", message);
  }
  return payload;
}

function parsePagedData<T>(
  payload: unknown,
  context: string,
  parseRow: (row: Record<string, unknown>) => T | null,
): VermontPagedResult<T> {
  const envelope = parseEnvelope(payload, context);
  if (!isRecord(envelope.data) || !Array.isArray(envelope.data.items)) {
    throw new VermontCampaignFinanceClientError(
      "bad_response",
      `Vermont ${context} response did not include data.items`,
    );
  }
  const totalItems = getInteger(envelope.data, "totalItems");
  if (
    envelope.succeeded !== true ||
    totalItems === null ||
    totalItems < 0 ||
    totalItems < envelope.data.items.length
  ) {
    throw new VermontCampaignFinanceClientError(
      "bad_response",
      `Invalid Vermont ${context} declared row count or success`,
    );
  }
  return {
    items: envelope.data.items.map((row, index) => {
      const parsed = isRecord(row) ? parseRow(row) : null;
      if (!parsed) {
        throw new VermontCampaignFinanceClientError(
          "bad_response",
          `Invalid Vermont ${context} physical row ${index + 1}`,
        );
      }
      return parsed;
    }),
    totalItems,
  };
}

function parseArrayData<T>(
  payload: unknown,
  context: string,
  parseRow: (row: Record<string, unknown>) => T | null
): T[] {
  const envelope = parseEnvelope(payload, context);
  if (!Array.isArray(envelope.data)) {
    throw new VermontCampaignFinanceClientError("bad_response", `Vermont ${context} response did not include a data array`);
  }
  return envelope.data.filter(isRecord).flatMap((row) => {
    const parsed = parseRow(row);
    return parsed ? [parsed] : [];
  });
}

function parseObjectData<T>(
  payload: unknown,
  context: string,
  parseRow: (row: Record<string, unknown>) => T
): T {
  const envelope = parseEnvelope(payload, context);
  if (!isRecord(envelope.data)) {
    throw new VermontCampaignFinanceClientError("bad_response", `Vermont ${context} response did not include a data object`);
  }
  return parseRow(envelope.data);
}

async function postVermontCampaignFinanceJson(
  endpoint: string,
  body: Record<string, unknown>,
  options: VermontCampaignFinanceClientOptions = {}
): Promise<unknown> {
  return fetchVermontCampaignFinanceJson(endpoint, options, {
    method: "POST",
    body,
  });
}

async function getVermontCampaignFinanceJson(
  endpoint: string,
  options: VermontCampaignFinanceClientOptions = {}
): Promise<unknown> {
  return fetchVermontCampaignFinanceJson(endpoint, options, {
    method: "GET",
  });
}

async function fetchVermontCampaignFinanceJson(
  endpoint: string,
  options: VermontCampaignFinanceClientOptions,
  request: { method: "GET" } | { method: "POST"; body: Record<string, unknown> }
): Promise<unknown> {
  const url = buildVermontCampaignFinanceApiUrl(endpoint);
  const timeoutMs = options.timeoutMs ?? VERMONT_CAMPAIGN_FINANCE_DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response | null = null;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      method: request.method,
      headers: {
        accept: "application/json,text/plain;q=0.9,*/*;q=0.1",
        ...(request.method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(request.method === "POST" ? { body: JSON.stringify(request.body) } : {}),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new VermontCampaignFinanceClientError(
        "http_error",
        `Vermont campaign finance request failed: ${response.status} ${response.statusText}`,
        response.status
      );
    }
    return await response.json();
  } catch (error) {
    if (error instanceof VermontCampaignFinanceClientError) {
      throw error;
    }
    if (isAbortError(error)) {
      throw new VermontCampaignFinanceClientError(
        "network_error",
        `Vermont campaign finance request timed out after ${timeoutMs}ms for ${url}`
      );
    }
    if (response) {
      throw new VermontCampaignFinanceClientError(
        "bad_response",
        `Vermont campaign finance response was not valid JSON for ${url}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    throw new VermontCampaignFinanceClientError(
      "network_error",
      `Vermont campaign finance request failed for ${url}: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    clearTimeout(timeout);
  }
}

function parseContributionRow(
  row: Record<string, unknown>,
): VermontContributionRow | null {
  const transactionId = getInteger(row, "transactionID", "transactionId");
  const guid = getString(row, "guid");
  const filerRegistrationGuid = getString(row, "filerRegistrationGuid");
  const filerName = getString(row, "filerName");
  const transactionAmount = requireTransactionAmount(row);
  if (
    transactionId === null ||
    transactionId <= 0 ||
    !guid ||
    !filerRegistrationGuid ||
    !filerName
  ) {
    return null;
  }

  return {
    transactionId,
    transactionVersionId: getInteger(
      row,
      "transactionVersionID",
      "transactionVersionId",
    ),
    guid,
    filerRegistrationGuid,
    filerName,
    transactionAmount,
    transactionDate: getString(row, "transactionDate", "sortTransactionDate"),
    sourceName: getString(row, "sourceName"),
    sourceFirstName: getString(row, "firstName", "sourceFirstName"),
    sourceLastName: getString(row, "lastName", "sourceLastName"),
    sourceMiddleName: getString(row, "middleName", "sourceMiddleName"),
    transactionSource: getString(row, "transactionSource"),
    transactionSourceTypeCode: getString(row, "transactionSourceTypeCode"),
    transactionSubTypeCode: getString(row, "transactionSubTypeCode"),
    transactionSubTypeDescription: getString(
      row,
      "transactionSubTypeDescription",
    ),
    filerTypeCode: getString(row, "filerTypeCode"),
    filerTypeDescription: getString(row, "filerTypeDescription"),
    electionYear: getInteger(row, "electionYear"),
    electionCycle: getString(row, "electionCycle"),
    electionId: getInteger(row, "electionId"),
    officeId: getInteger(row, "officeID", "officeId"),
    officeType: getString(row, "officeType"),
    entityId: getInteger(row, "entityId", "entityID"),
    reportName: getString(row, "reportName"),
    candidateFirstName: getString(row, "candidateFirstName"),
    candidateLastName: getString(row, "candidateLastName"),
    candidateMiddleName: getString(row, "candidateMiddleName"),
    occupation: getString(
      row,
      "occupation",
      "occupationCode",
      "sourceOccupation",
    ),
    employer: getString(row, "employer", "sourceEmployer"),
    filingYear: getInteger(row, "filingYear"),
    addressLine1: getString(row, "addressLine1"),
    addressLine2: getString(row, "addressLine2"),
    city: getString(row, "city"),
    stateCode: getString(row, "stateCode"),
    zipCode: getString(row, "zipCode"),
    ...(Object.hasOwn(row, "filerReportGuid") ? { filerReportGuid: getString(row, "filerReportGuid") } : {}),
    ...(Object.hasOwn(row, "timedFiledReportGuid") ? { timedFiledReportGuid: getString(row, "timedFiledReportGuid") } : {}),
    ...(Object.hasOwn(row, "transactionTypeCode") ? { transactionTypeCode: getString(row, "transactionTypeCode") } : {}),
    ...(Object.hasOwn(row, "hasChild") ? { hasChild: getBoolean(row, "hasChild") } : {}),
  };
}

function parseExpenditureRow(
  row: Record<string, unknown>,
): VermontExpenditureRow | null {
  const transactionId = getInteger(row, "transactionID", "transactionId");
  const guid = getString(row, "guid");
  const filerRegistrationGuid = getString(row, "filerRegistrationGuid");
  const filerName = getString(row, "filerName");
  const transactionAmount = requireTransactionAmount(row);
  if (
    transactionId === null ||
    transactionId <= 0 ||
    !guid ||
    !filerRegistrationGuid ||
    !filerName
  ) {
    return null;
  }

  return {
    transactionId,
    transactionVersionId: getInteger(
      row,
      "transactionVersionID",
      "transactionVersionId",
    ),
    guid,
    filerRegistrationGuid,
    filerName,
    transactionAmount,
    transactionDate: getString(row, "transactionDate", "sortTransactionDate"),
    transactionCategoryCode: getString(row, "transactionCategoryCode"),
    transactionCategoryDescription: getString(
      row,
      "transactionCategoryDescription",
    ),
    expenditurePurpose: getString(row, "expenditurePurpose"),
    description: getString(row, "description"),
    isStanceSupport: getBoolean(row, "isStanceSupport"),
    payeeType: getString(row, "payeeType"),
    sourceName: getString(row, "sourceName"),
    transactionSource: getString(row, "transactionSource"),
    filerTypeCode: getString(row, "filerTypeCode"),
    filerTypeDescription: getString(row, "filerTypeDescription"),
    electionYear: getInteger(row, "electionYear"),
    electionCycle: getString(row, "electionCycle"),
    electionId: getInteger(row, "electionId"),
    officeId: getInteger(row, "officeID", "officeId"),
    officeType: getString(row, "officeType"),
    entityId: getInteger(row, "entityId", "entityID"),
    reportName: getString(row, "reportName"),
    candidateMentioned: getString(row, "candidateMentioned"),
    candidateFirstName: getString(row, "candidateFirstName"),
    candidateLastName: getString(row, "candidateLastName"),
    candidateMiddleName: getString(row, "candidateMiddleName"),
    sourceAddressLine1: getString(row, "sourceAddressLine1"),
    sourceAddressLine2: getString(row, "sourceAddressLine2"),
    sourceCity: getString(row, "sourceCity"),
    sourceState: getString(row, "sourceState"),
    sourceZipCode: getString(row, "sourceZipCode"),
    ...(Object.hasOwn(row, "filerReportGuid") ? { filerReportGuid: getString(row, "filerReportGuid") } : {}),
    ...(Object.hasOwn(row, "timedFiledReportGuid") ? { timedFiledReportGuid: getString(row, "timedFiledReportGuid") } : {}),
    ...(Object.hasOwn(row, "transactionTypeCode") ? { transactionTypeCode: getString(row, "transactionTypeCode") } : {}),
    ...(Object.hasOwn(row, "transactionSubTypeCode") ? { transactionSubTypeCode: getString(row, "transactionSubTypeCode") } : {}),
    ...(Object.hasOwn(row, "isMassMedia") ? { isMassMedia: getBoolean(row, "isMassMedia") } : {}),
    ...(Object.hasOwn(row, "hasChild") ? { hasChild: getBoolean(row, "hasChild") } : {}),
  };
}

function parseTransactionDetail(row: Record<string, unknown>): VermontTransactionDetail {
  return {
    transactionId: requireInteger(row, "transactionID", "transactionID", "transactionId"),
    transactionVersionId: getInteger(row, "transactionVersionID", "transactionVersionId"),
    guid: requireString(row, "guid", "guid"),
    transactionTypeCode: getString(row, "transactionTypeCode"),
    transactionTypeDescription: getString(row, "transactionTypeDescription"),
    transactionSubTypeCode: getString(row, "transactionSubTypeCode"),
    transactionSubTypeDescription: getString(row, "transactionSubTypeDesc", "transactionSubTypeDescription"),
    transactionSourceTypeCode: getString(row, "transactionSourceTypeCode"),
    transactionSourceTypeDescription: getString(row, "transactionSourceTypeDesc", "transactionSourceTypeDescription"),
    transactionSource: getString(row, "transactionSource"),
    transactionDate: getString(row, "transactionDate"),
    filerName: getString(row, "filerName"),
    contributor: getString(row, "contributor"),
    valueOfNonMoneyItem: getNumber(row, "valueOfNonMoneyItem"),
    transactionCategoryDescription: getString(row, "transactionCategoryDesc", "transactionCategoryDescription"),
    electionYear: getInteger(row, "electionYear"),
    comments: getString(row, "comments"),
  };
}

function parseContributionCategory(row: Record<string, unknown>): VermontContributionCategory | null {
  const amount = getNumber(row, "amount");
  const transactionSourceTypeCode = getString(row, "transactionSourceTypeCode");
  const transactionSourceType = getString(row, "transactionSourceType");
  if (amount === null || !transactionSourceTypeCode || !transactionSourceType) {
    return null;
  }
  return { amount, transactionSourceTypeCode, transactionSourceType };
}

function parseOfficeSoughtLookupItem(row: Record<string, unknown>): VermontOfficeSoughtLookupItem | null {
  const value = getString(row, "value");
  const officeId = getInteger(row, "value", "officeID", "officeId");
  const name = getString(row, "name");
  if (!value || officeId === null || !name) {
    return null;
  }
  return {
    value,
    officeId,
    name,
    code: getString(row, "code"),
  };
}

export async function getVermontContributionDetails(
  input: VermontTransactionSearchInput = {},
  options?: VermontCampaignFinanceClientOptions
): Promise<VermontPagedResult<VermontContributionRow>> {
  assertEndpointTransactionType({
    transactionTypeCode: input.transactionTypeCode,
    expectedTransactionTypeCode: "TCON",
    endpointName: "Vermont contribution details",
  });
  const payload = buildVermontTransactionSearchPayload({ ...input, transactionTypeCode: "TCON" });
  const response = await postVermontCampaignFinanceJson(
    "PublicTransactionDetails/GetContributionsDetails",
    payload,
    options
  );
  return parsePagedData(response, "contribution details", parseContributionRow);
}

export async function getVermontExpenditureDetails(
  input: VermontTransactionSearchInput = {},
  options?: VermontCampaignFinanceClientOptions
): Promise<VermontPagedResult<VermontExpenditureRow>> {
  assertEndpointTransactionType({
    transactionTypeCode: input.transactionTypeCode,
    expectedTransactionTypeCode: "TEXP",
    endpointName: "Vermont expenditure details",
  });
  const payload = buildVermontTransactionSearchPayload({ ...input, transactionTypeCode: "TEXP" });
  const response = await postVermontCampaignFinanceJson(
    "PublicTransactionDetails/GetExpenditureDetails",
    payload,
    options
  );
  return parsePagedData(response, "expenditure details", parseExpenditureRow);
}

export async function getVermontTransactionDetailsByGuid(
  transactionGuid: string,
  options?: VermontCampaignFinanceClientOptions
): Promise<VermontTransactionDetail> {
  const guid = normalizeOptionalText(transactionGuid);
  if (!guid) {
    throw new VermontCampaignFinanceClientError("invalid_request", "Vermont transactionGuid is required");
  }
  const response = await postVermontCampaignFinanceJson(
    "PublicTransactionDetails/GetTransactionDetailsByGuid",
    { transactionGuid: guid },
    options
  );
  return parseObjectData(response, "transaction detail", parseTransactionDetail);
}

export async function getVermontContributionCategoriesByFilerRegistrationGuid(
  filerRegistrationGuid: string,
  options?: VermontCampaignFinanceClientOptions
): Promise<VermontContributionCategory[]> {
  const guid = normalizeOptionalText(filerRegistrationGuid);
  if (!guid) {
    throw new VermontCampaignFinanceClientError("invalid_request", "Vermont filerRegistrationGuid is required");
  }
  const response = await postVermontCampaignFinanceJson(
    "PublicFilerDetails/GetContributionsCategoriesDetails",
    { filerRegistrationGuid: guid },
    options
  );
  const envelope = parseEnvelope(response, "contribution categories");
  if (envelope.succeeded !== true || !Array.isArray(envelope.data)) {
    throw new VermontCampaignFinanceClientError("bad_response", "Invalid Vermont contribution category array");
  }
  return envelope.data.map((row) => {
    const category = isRecord(row) ? parseContributionCategory(row) : null;
    if (!category) throw new VermontCampaignFinanceClientError("bad_response", "Invalid Vermont contribution category row");
    return category;
  });
}

export async function getVermontOfficeSoughtLookup(
  options?: VermontCampaignFinanceClientOptions
): Promise<VermontOfficeSoughtLookupItem[]> {
  const response = await getVermontCampaignFinanceJson("PublicLookup/GetOfficeSoughtLookup", options);
  return parseArrayData(response, "office sought lookup", parseOfficeSoughtLookupItem);
}

export async function getVermontFiledReports(
  input: { filerRegistrationGuid: string; pageNumber?: number; pageSize?: number },
  options?: VermontCampaignFinanceClientOptions
): Promise<VermontPagedResult<VermontFiledReportRow>> {
  const guid = normalizeOptionalText(input.filerRegistrationGuid);
  if (!guid) throw new VermontCampaignFinanceClientError("invalid_request", "Vermont filerRegistrationGuid is required");
  const response = await postVermontCampaignFinanceJson("PublicFilerDetails/GetPublicFilerProfileFiling", {
    filerRegistrationGuid: guid,
    pageNumber: normalizePositiveInteger(input.pageNumber, 1, "Vermont report pageNumber", 100_000),
    pageSize: normalizePositiveInteger(input.pageSize, 1000, "Vermont report pageSize", 1000),
    sortBy: "",
    sortType: "",
  }, options);
  return parsePagedData(response, "filed reports", (row) => {
    const filerReportVersionId = requireInteger(row, "report version ID", "filerReportVersionID");
    if (filerReportVersionId <= 0 || typeof row.isPaperFile !== "boolean" || typeof row.hasChild !== "boolean") {
      throw new VermontCampaignFinanceClientError("bad_response", "Invalid Vermont report version/paper/child metadata");
    }
    return {
      filerReportGuid: requireString(row, "filed report GUID", "filerReportGuid"),
      filerFilingCalendarGuid: requireString(row, "filing calendar GUID", "filerFilingCalendarGuid"),
      filerReportVersionId,
      reportName: requireString(row, "report name", "reportName"),
      reportType: requireString(row, "report type", "reportType"),
      reportStatus: requireString(row, "report status", "reportStatus"),
      reportVersion: requireString(row, "report version", "reportVersion"),
      startDate: requireString(row, "report start date", "startDate"),
      endDate: requireString(row, "report end date", "endDate"),
      dueDate: requireString(row, "report due date", "dueDate"),
      filedDate: requireString(row, "report filed date", "filedDate"),
      isPaperFile: row.isPaperFile,
      hasChild: row.hasChild,
    };
  });
}

export async function getVermontElectionLookup(
  options?: VermontCampaignFinanceClientOptions,
): Promise<VermontElectionLookupItem[]> {
  const response = await getVermontCampaignFinanceJson(
    "PublicLookup/GetElectionLookup?key=&fromReadonly=true",
    options,
  );
  const envelope = parseEnvelope(response, "election lookup");
  if (envelope.succeeded !== true || !Array.isArray(envelope.data)) {
    throw new VermontCampaignFinanceClientError(
      "bad_response",
      "Invalid Vermont election lookup",
    );
  }
  const ids = new Set<number>();
  return envelope.data.map((row) => {
    if (!isRecord(row))
      throw new VermontCampaignFinanceClientError(
        "bad_response",
        "Invalid Vermont election lookup row",
      );
    const electionId = requireInteger(row, "election lookup ID", "value");
    const name = requireString(row, "election lookup name", "name");
    if (electionId <= 0 || ids.has(electionId)) {
      throw new VermontCampaignFinanceClientError(
        "bad_response",
        "Duplicate or invalid Vermont election lookup ID",
      );
    }
    ids.add(electionId);
    return { electionId, name };
  });
}

/** Resolves the published election context, not a transaction/report date window. */
export function resolveVermontElectionLookup(
  items: readonly VermontElectionLookupItem[],
  input: { electionDate: string; electionType: "general" | "primary" },
): VermontElectionLookupItem {
  const date = new Date(`${input.electionDate}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(input.electionDate) ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== input.electionDate ||
    !["general", "primary"].includes(input.electionType)
  ) {
    throw new VermontCampaignFinanceClientError(
      "invalid_request",
      "Invalid Vermont election date/type context",
    );
  }
  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const expected = `${date.getUTCFullYear()} ${monthNames[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, "0")} - ${input.electionType === "general" ? "General" : "Primary"} Election`;
  const matches = items.filter(
    (item) => item.name.replace(/\s+/g, " ").trim() === expected,
  );
  if (matches.length !== 1) {
    throw new VermontCampaignFinanceClientError(
      "bad_response",
      `Vermont election lookup has ${matches.length} exact date/type matches`,
    );
  }
  return matches[0]!;
}
