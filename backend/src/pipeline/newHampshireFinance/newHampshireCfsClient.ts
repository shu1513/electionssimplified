import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

export const NEW_HAMPSHIRE_CFS_API_BASE_URL = "https://cfsapi.sos.nh.gov/api";

export const NEW_HAMPSHIRE_CFS_ENDPOINTS = {
  bulkExport: "ExportData/GetExportPublicDownloadData",
  electionCycles: "Lookup/GetElectionLookupData",
  filingEntities: "PublicFilerDetails/GetFilingEntityDetails",
  receipts: "PublicTransactionDetails/GetPublicContributionDetails",
  expenditures: "PublicTransactionDetails/GetPublicExpenditureDetails",
  publicFilingProfile: "PublicFilerDetails/GetPublicFilerProfileFiling",
  publicFilingHistory: "PublicFilerDetails/GetPublicFilerProfileChildFilingDetails",
} as const;

export type NewHampshireCfsTransactionTypeCode = "TCON" | "TEXP";

export type NewHampshireCfsClientErrorCode =
  | "invalid_request"
  | "network_error"
  | "http_error"
  | "bad_response";

export class NewHampshireCfsClientError extends Error {
  constructor(
    public readonly code: NewHampshireCfsClientErrorCode,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "NewHampshireCfsClientError";
  }
}

export type NewHampshireCfsClientOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
};

export type NewHampshireCfsBulkDownloadResult = {
  url: string;
  requestBody: {
    type: "CSV";
    filingYear: number;
    transactionTypeCode: NewHampshireCfsTransactionTypeCode;
  };
  contentType: string | null;
  contentDisposition: string | null;
  contentEncoding: string | null;
  responseDate: string | null;
  outputPath: string;
  bytesWritten: number;
  sha256: string;
};

export type NewHampshireElectionCycle = {
  value: number;
  name: string;
  dueDate: string | null;
};

export type NewHampshireFilingEntityRow = {
  registrationGuid: string;
  filingEntityId: number;
  filerName: string;
  candidateName: string | null;
  firstName: string | null;
  lastName: string | null;
  committeeName: string | null;
  filerTypeCode: string;
  filerSubTypeCode: string | null;
  filerSubTypeName: string | null;
  officeName: string | null;
  county: string | null;
  district: string | null;
  electionCycleId: number;
  electionYear: number;
  electionCycle: string;
  status: string;
};

export type NewHampshireReceiptRow = {
  transactionId: number;
  transactionVersionId: number;
  guid: string;
  filerReportId: number;
  filerReportVersionId: number;
  filerEntityId: number;
  filerName: string;
  transactionAmount: number;
  transactionDate: string;
  transactionTypeDescription: string;
  transactionSubType: string | null;
  transactionSubTypeCode: string;
  reportName: string;
  reportVersion: boolean;
  reportVersionFilter: string;
  reportVersionDescription: string | null;
  isAmended: boolean;
  electionCycle: string | null;
  employerName: string | null;
  occupation: string | null;
};

export type NewHampshireIndependentExpenditureRow = {
  transactionId: number;
  transactionVersionId: number;
  guid: string;
  filerReportId: number | null;
  filerReportVersionId: number | null;
  filerEntityId: number;
  filerName: string;
  transactionAmount: number;
  transactionDate: string;
  reportName: string | null;
  reportVersion: boolean;
  reportVersionFilter: string | null;
  isAmended: boolean;
  transactionTypeCode: string;
  transactionSubTypeCode: string;
  candidateMeasure: string | null;
  stance: string | null;
  electionCycle: string | null;
  transactionCategory: string | null;
};

export type NewHampshireCfsPage<T> = {
  items: T[];
  totalItems: number;
};

export type NewHampshireReceiptSearchInput = {
  pageNumber?: number;
  pageSize?: number;
  filerName: string;
  electionCycleId: number;
};

export type NewHampshireFilingEntitySearchInput = {
  pageNumber?: number;
  pageSize?: number;
  electionCycleId: number;
};

export type NewHampshireIndependentExpenditureSearchInput = {
  pageNumber?: number;
  pageSize?: number;
  electionCycleId: number;
};

export const NEW_HAMPSHIRE_CFS_FETCH_TIMEOUT_MS = 120_000;
// Akamai currently rejects Node's default and descriptive bot user agents.
// This minimal compatibility token plus the public SPA Origin/Referer is the
// request shape the anonymous API accepts (verified live 2026-08-19).
const DEFAULT_USER_AGENT = "Mozilla/5.0";
const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 1_000;
const MAX_JSON_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_CSV_RESPONSE_BYTES = 128 * 1024 * 1024;

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new NewHampshireCfsClientError("invalid_request", `Invalid ${label}: ${value}`);
  }
  return value;
}

function requirePageSize(value: number | undefined): number {
  const pageSize = value ?? DEFAULT_PAGE_SIZE;
  requirePositiveInteger(pageSize, "New Hampshire CFS page size");
  if (pageSize > MAX_PAGE_SIZE) {
    throw new NewHampshireCfsClientError(
      "invalid_request",
      `New Hampshire CFS page size exceeds ${MAX_PAGE_SIZE}: ${pageSize}`
    );
  }
  return pageSize;
}

function requireFilingYear(value: number): number {
  if (!Number.isInteger(value) || value < 2016 || value > 2100) {
    throw new NewHampshireCfsClientError("invalid_request", `Invalid New Hampshire CFS filing year: ${value}`);
  }
  return value;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new NewHampshireCfsClientError("bad_response", `Invalid New Hampshire CFS ${label}`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new NewHampshireCfsClientError("bad_response", `Invalid New Hampshire CFS ${label}`);
  }
  return value.trim();
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new NewHampshireCfsClientError("bad_response", `Invalid New Hampshire CFS ${label}`);
  }
  return value;
}

function requiredInteger(value: unknown, label: string): number {
  const parsed = requiredNumber(value, label);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new NewHampshireCfsClientError("bad_response", `Invalid New Hampshire CFS ${label}`);
  }
  return parsed;
}

function nullablePositiveInteger(value: unknown, label: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  return requiredInteger(value, label);
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function buildUrl(endpoint: string): string {
  if (!/^[A-Za-z][A-Za-z0-9/]+$/.test(endpoint)) {
    throw new NewHampshireCfsClientError("invalid_request", `Invalid New Hampshire CFS endpoint: ${endpoint}`);
  }
  return `${NEW_HAMPSHIRE_CFS_API_BASE_URL}/${endpoint}`;
}

async function postResponse(input: {
  endpoint: string;
  body: Record<string, unknown>;
  expectedContentType: "json" | "csv";
  options?: NewHampshireCfsClientOptions;
}): Promise<Response> {
  const fetchImpl = input.options?.fetchImpl ?? fetch;
  const timeoutMs = input.options?.timeoutMs ?? NEW_HAMPSHIRE_CFS_FETCH_TIMEOUT_MS;
  const userAgent = input.options?.userAgent?.trim() || DEFAULT_USER_AGENT;
  requirePositiveInteger(timeoutMs, "New Hampshire CFS timeout");

  let response: Response;
  try {
    response = await fetchImpl(buildUrl(input.endpoint), {
      method: "POST",
      redirect: "manual",
      headers: {
        Accept: input.expectedContentType === "json" ? "application/json, text/plain, */*" : "text/csv, */*",
        "Content-Type": "application/json",
        Origin: "https://cfs.sos.nh.gov",
        Referer: "https://cfs.sos.nh.gov/",
        "User-Agent": userAgent,
      },
      body: JSON.stringify(input.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new NewHampshireCfsClientError("network_error", `New Hampshire CFS request failed: ${message}`);
  }

  if (response.status !== 200) {
    throw new NewHampshireCfsClientError(
      "http_error",
      `New Hampshire CFS request returned HTTP ${response.status}: ${input.endpoint}`,
      response.status
    );
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const validContentType =
    input.expectedContentType === "json" ? contentType.includes("application/json") : contentType.includes("text/csv");
  if (!validContentType) {
    throw new NewHampshireCfsClientError(
      "bad_response",
      `New Hampshire CFS ${input.endpoint} returned unexpected content type: ${contentType || "missing"}`
    );
  }

  return response;
}

async function postCaptured(input: {
  endpoint: string;
  body: Record<string, unknown>;
  expectedContentType: "json" | "csv";
  options?: NewHampshireCfsClientOptions;
}): Promise<{ bytes: Uint8Array; httpStatus: number; eof: true; responseUrl: string }> {
  const response = await postResponse(input);

  const maxBytes = input.expectedContentType === "json" ? MAX_JSON_RESPONSE_BYTES : MAX_CSV_RESPONSE_BYTES;
  const reader = response.body?.getReader();
  if (!reader) {
    throw new NewHampshireCfsClientError("bad_response", "New Hampshire CFS response body missing");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new NewHampshireCfsClientError(
          "bad_response",
          `New Hampshire CFS ${input.endpoint} exceeded ${maxBytes} bytes`
        );
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof NewHampshireCfsClientError) throw error;
    throw new NewHampshireCfsClientError(
      "network_error",
      `New Hampshire CFS ${input.endpoint} response body incomplete`
    );
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, httpStatus: response.status, eof: true, responseUrl: response.url };
}

async function post(input: Parameters<typeof postCaptured>[0]): Promise<Uint8Array> {
  return (await postCaptured(input)).bytes;
}

function buildBulkDownloadRequestBody(input: {
  filingYear: number;
  transactionTypeCode: NewHampshireCfsTransactionTypeCode;
}): NewHampshireCfsBulkDownloadResult["requestBody"] {
  return {
    type: "CSV",
    filingYear: requireFilingYear(input.filingYear),
    transactionTypeCode: input.transactionTypeCode,
  };
}

function parseJsonEnvelope(bytes: Uint8Array, endpoint: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new NewHampshireCfsClientError("bad_response", `New Hampshire CFS ${endpoint} returned invalid JSON`);
  }
  const envelope = objectValue(parsed, "response envelope");
  if (envelope.succeeded !== true) {
    const error = typeof envelope.error === "object" && envelope.error !== null
      ? (envelope.error as Record<string, unknown>).message
      : null;
    throw new NewHampshireCfsClientError(
      "bad_response",
      `New Hampshire CFS ${endpoint} failed${typeof error === "string" ? `: ${error}` : ""}`
    );
  }
  return envelope;
}

async function postJson(
  endpoint: string,
  body: Record<string, unknown>,
  options?: NewHampshireCfsClientOptions
): Promise<Record<string, unknown>> {
  return parseJsonEnvelope(await post({ endpoint, body, expectedContentType: "json", options }), endpoint);
}

/** Return original response bytes for the immutable raw-data cache. */
export async function downloadNewHampshirePublicReportPage(
  input: ({ kind: "profile"; registrationGuid: string } | { kind: "history"; reportGuid: string }) & {
    pageNumber?: number;
    pageSize?: number;
  },
  options?: NewHampshireCfsClientOptions
): Promise<{
  bytes: Uint8Array;
  envelope: Record<string, unknown>;
  requestedAt: string;
  completedAt: string;
  httpStatus: number;
  eof: true;
  responseUrl: string;
}> {
  const selector = input.kind === "profile" ? input.registrationGuid : input.reportGuid;
  if (typeof selector !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(selector)) {
    throw new NewHampshireCfsClientError("invalid_request", "Invalid New Hampshire public filing GUID");
  }
  const pageNumber = requirePositiveInteger(input.pageNumber ?? 1, "New Hampshire CFS page number");
  const pageSize = requirePageSize(input.pageSize);
  const endpoint = input.kind === "profile"
    ? NEW_HAMPSHIRE_CFS_ENDPOINTS.publicFilingProfile
    : NEW_HAMPSHIRE_CFS_ENDPOINTS.publicFilingHistory;
  const body = input.kind === "profile"
    ? { filerRegistrationGuid: selector, pageNumber, pageSize, sortBy: "", sortType: "" }
    : { filerReportGuid: selector, pageNumber, pageSize, sortBy: null, sortType: null, showFilingHistory: true };
  const requestedAt = new Date().toISOString();
  const captured = await postCaptured({ endpoint, body, expectedContentType: "json", options });
  const { bytes } = captured;
  const completedAt = new Date().toISOString();
  const envelope = parseJsonEnvelope(bytes, endpoint);
  const page = parsePage(envelope, (value) => objectValue(value, "public filing"));
  if (page.items.length > pageSize || page.items.length > page.totalItems) {
    throw new NewHampshireCfsClientError("bad_response", "Invalid New Hampshire public filing page count");
  }
  return { ...captured, envelope, requestedAt, completedAt };
}

function parsePage<T>(envelope: Record<string, unknown>, parseItem: (value: unknown) => T): NewHampshireCfsPage<T> {
  const data = objectValue(envelope.data, "page data");
  if (!Array.isArray(data.items)) {
    throw new NewHampshireCfsClientError("bad_response", "Invalid New Hampshire CFS page items");
  }
  const totalItems = requiredNumber(data.totalItems, "page totalItems");
  if (!Number.isInteger(totalItems) || totalItems < 0) {
    throw new NewHampshireCfsClientError("bad_response", "Invalid New Hampshire CFS page totalItems");
  }
  return { items: data.items.map(parseItem), totalItems };
}

function parseReceiptRow(value: unknown): NewHampshireReceiptRow {
  const row = objectValue(value, "receipt row");
  return {
    transactionId: requiredInteger(row.transactionId, "receipt transactionId"),
    transactionVersionId: requiredInteger(row.transactionVersionId, "receipt transactionVersionId"),
    guid: requiredString(row.guid, "receipt guid"),
    filerReportId: requiredInteger(row.filerReportId, "receipt filerReportId"),
    filerReportVersionId: requiredInteger(row.filerReportVersionId, "receipt filerReportVersionId"),
    filerEntityId: requiredInteger(row.filerEntityId, "receipt filerEntityId"),
    filerName: requiredString(row.filerName, "receipt filerName"),
    transactionAmount: requiredNumber(row.transactionAmount, "receipt transactionAmount"),
    transactionDate: requiredString(row.transactionDate, "receipt transactionDate"),
    transactionTypeDescription: requiredString(row.transactionTypeDesc, "receipt transactionTypeDesc"),
    transactionSubType: nullableString(row.transactionSubType),
    transactionSubTypeCode: requiredString(row.transactionSubTypeCode, "receipt transactionSubTypeCode"),
    reportName: requiredString(row.reportName, "receipt reportName"),
    reportVersion: booleanValue(row.reportVersion),
    reportVersionFilter: requiredString(row.reportVersionFilter, "receipt reportVersionFilter"),
    reportVersionDescription: nullableString(row.reportVersionDesc),
    isAmended: booleanValue(row.isAmended),
    electionCycle: nullableString(row.electionCycle),
    employerName: nullableString(row.employerName),
    occupation: nullableString(row.occupation),
  };
}

function parseFilingEntityRow(value: unknown): NewHampshireFilingEntityRow {
  const row = objectValue(value, "filing-entity row");
  return {
    registrationGuid: requiredString(row.guid, "filing-entity guid"),
    filingEntityId: requiredInteger(row.filerEntityId, "filing-entity filerEntityId"),
    filerName: requiredString(row.filerName, "filing-entity filerName"),
    candidateName: nullableString(row.firstnameLastname),
    firstName: nullableString(row.firstName),
    lastName: nullableString(row.lastName),
    committeeName: nullableString(row.committeeName),
    filerTypeCode: requiredString(row.filerTypeCode, "filing-entity filerTypeCode"),
    filerSubTypeCode: nullableString(row.filerSubTypeCode),
    filerSubTypeName: nullableString(row.filerSubTypeName),
    officeName: nullableString(row.officeSoughtName),
    county: nullableString(row.town),
    district: nullableString(row.districtName),
    electionCycleId: requiredInteger(row.electionId, "filing-entity electionId"),
    electionYear: requiredInteger(row.electionYear, "filing-entity electionYear"),
    electionCycle: requiredString(row.electionCycle, "filing-entity electionCycle"),
    status: requiredString(row.filerStatus, "filing-entity filerStatus"),
  };
}

function parseIndependentExpenditureRow(value: unknown): NewHampshireIndependentExpenditureRow {
  const row = objectValue(value, "independent-expenditure row");
  const filerReportId = nullablePositiveInteger(row.filerReportId, "IE filerReportId");
  const filerReportVersionId = nullablePositiveInteger(
    row.filerReportVersionId,
    "IE filerReportVersionId"
  );
  if ((filerReportId === null) !== (filerReportVersionId === null)) {
    throw new NewHampshireCfsClientError(
      "bad_response",
      "Invalid New Hampshire CFS IE report identity"
    );
  }
  return {
    transactionId: requiredInteger(row.transactionId, "IE transactionId"),
    transactionVersionId: requiredInteger(row.transactionVersionId, "IE transactionVersionId"),
    guid: requiredString(row.guid, "IE guid"),
    filerReportId,
    filerReportVersionId,
    filerEntityId: requiredInteger(row.filerEntityId, "IE filerEntityId"),
    filerName: requiredString(row.filerName, "IE filerName"),
    transactionAmount: requiredNumber(row.transactionAmount, "IE transactionAmount"),
    transactionDate: requiredString(row.transactionDate, "IE transactionDate"),
    reportName: nullableString(row.reportName),
    reportVersion: booleanValue(row.reportVersion),
    reportVersionFilter: nullableString(row.reportVersionFilter),
    isAmended: booleanValue(row.isAmended),
    transactionTypeCode: requiredString(row.transactionTypeCode, "IE transactionTypeCode"),
    transactionSubTypeCode: requiredString(row.transactionSubTypeCode, "IE transactionSubTypeCode"),
    candidateMeasure: nullableString(row.candidateMeasure),
    stance: nullableString(row.stance),
    electionCycle: nullableString(row.electionCycle),
    transactionCategory: nullableString(row.transactionCategory),
  };
}

export async function downloadNewHampshireCfsBulkCsv(
  input: { filingYear: number; transactionTypeCode: NewHampshireCfsTransactionTypeCode },
  options?: NewHampshireCfsClientOptions
): Promise<string> {
  const requestBody = buildBulkDownloadRequestBody(input);
  const bytes = await post({
    endpoint: NEW_HAMPSHIRE_CFS_ENDPOINTS.bulkExport,
    body: requestBody,
    expectedContentType: "csv",
    options,
  });
  return new TextDecoder().decode(bytes);
}

export async function downloadNewHampshireCfsBulkCsvToFile(
  input: {
    filingYear: number;
    transactionTypeCode: NewHampshireCfsTransactionTypeCode;
    outputPath: string;
  },
  options?: NewHampshireCfsClientOptions
): Promise<NewHampshireCfsBulkDownloadResult> {
  const requestBody = buildBulkDownloadRequestBody(input);
  const response = await postResponse({
    endpoint: NEW_HAMPSHIRE_CFS_ENDPOINTS.bulkExport,
    body: requestBody,
    expectedContentType: "csv",
    options,
  });
  if (!response.body) {
    throw new NewHampshireCfsClientError(
      "bad_response",
      "New Hampshire CFS bulk export response did not include a body"
    );
  }

  const outputPath = resolve(input.outputPath);
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  const hash = createHash("sha256");
  let bytesWritten = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesWritten += chunk.byteLength;
      if (bytesWritten > MAX_CSV_RESPONSE_BYTES) {
        callback(
          new NewHampshireCfsClientError(
            "bad_response",
            `New Hampshire CFS ${NEW_HAMPSHIRE_CFS_ENDPOINTS.bulkExport} exceeded ${MAX_CSV_RESPONSE_BYTES} bytes`
          )
        );
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const source = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);
  const timeoutMs = options?.timeoutMs ?? NEW_HAMPSHIRE_CFS_FETCH_TIMEOUT_MS;
  const bodyTimeout = setTimeout(() => {
    source.destroy(
      new NewHampshireCfsClientError(
        "network_error",
        `New Hampshire CFS bulk export body timed out after ${timeoutMs}ms`
      )
    );
  }, timeoutMs);

  try {
    await pipeline(source, meter, createWriteStream(outputPath, { mode: 0o600 }));
    // createWriteStream's mode does not tighten a pre-existing path.
    await chmod(outputPath, 0o600);
    const outputStat = await stat(outputPath);
    if (!outputStat.isFile() || outputStat.size === 0 || outputStat.size !== bytesWritten) {
      throw new NewHampshireCfsClientError(
        "bad_response",
        `New Hampshire CFS bulk export wrote an invalid artifact: ${bytesWritten} bytes`
      );
    }
  } catch (error) {
    await rm(outputPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    clearTimeout(bodyTimeout);
  }

  return {
    url: buildUrl(NEW_HAMPSHIRE_CFS_ENDPOINTS.bulkExport),
    requestBody,
    contentType: response.headers.get("content-type"),
    contentDisposition: response.headers.get("content-disposition"),
    contentEncoding: response.headers.get("content-encoding"),
    responseDate: response.headers.get("date"),
    outputPath,
    bytesWritten,
    sha256: hash.digest("hex"),
  };
}

export async function getNewHampshireElectionCycles(
  options?: NewHampshireCfsClientOptions
): Promise<NewHampshireElectionCycle[]> {
  const envelope = await postJson(NEW_HAMPSHIRE_CFS_ENDPOINTS.electionCycles, { key: "" }, options);
  if (!Array.isArray(envelope.data)) {
    throw new NewHampshireCfsClientError("bad_response", "Invalid New Hampshire CFS election-cycle data");
  }
  return envelope.data.map((value) => {
    const row = objectValue(value, "election-cycle row");
    return {
      value: requiredInteger(row.value, "election-cycle value"),
      name: requiredString(row.name, "election-cycle name"),
      dueDate: nullableString(row.dueDate),
    };
  });
}

export async function getNewHampshireReceiptPage(
  input: NewHampshireReceiptSearchInput,
  options?: NewHampshireCfsClientOptions
): Promise<NewHampshireCfsPage<NewHampshireReceiptRow>> {
  const filerName = input.filerName.trim();
  if (!filerName) {
    throw new NewHampshireCfsClientError("invalid_request", "New Hampshire receipt search requires filerName");
  }
  const envelope = await postJson(
    NEW_HAMPSHIRE_CFS_ENDPOINTS.receipts,
    {
      pageNumber: requirePositiveInteger(input.pageNumber ?? 1, "New Hampshire CFS page number"),
      pageSize: requirePageSize(input.pageSize),
      sortBy: null,
      sortType: null,
      transactionTypeCode: "TCON",
      filerName,
      electionCycle: String(requirePositiveInteger(input.electionCycleId, "New Hampshire election-cycle ID")),
    },
    options
  );
  return parsePage(envelope, parseReceiptRow);
}

export async function getNewHampshireFilingEntityPage(
  input: NewHampshireFilingEntitySearchInput,
  options?: NewHampshireCfsClientOptions
): Promise<NewHampshireCfsPage<NewHampshireFilingEntityRow>> {
  const envelope = await postJson(
    NEW_HAMPSHIRE_CFS_ENDPOINTS.filingEntities,
    {
      pageNumber: requirePositiveInteger(input.pageNumber ?? 1, "New Hampshire CFS page number"),
      pageSize: requirePageSize(input.pageSize),
      sortBy: "FilerName",
      sortType: "asc",
      filerTypeCode: "",
      filerName: null,
      filingEntityId: null,
      politicalPartyCode: null,
      OfficeSought: null,
      CommitteeMakingIE: null,
      filerSubTypeCode: null,
      totalRaisedMax: null,
      totalRaisedMin: null,
      totalSpentMax: null,
      totalSpentMin: null,
      balanceFundsMax: null,
      balanceFundsMin: null,
      accountStatus: null,
      filerSearchTypeCode: null,
      transactionSourceTypeCode: null,
      electionCycle: String(
        requirePositiveInteger(input.electionCycleId, "New Hampshire election-cycle ID")
      ),
      county: null,
      officeType: null,
    },
    options
  );
  return parsePage(envelope, parseFilingEntityRow);
}

export async function getNewHampshireIndependentExpenditurePage(
  input: NewHampshireIndependentExpenditureSearchInput,
  options?: NewHampshireCfsClientOptions
): Promise<NewHampshireCfsPage<NewHampshireIndependentExpenditureRow>> {
  const envelope = await postJson(
    NEW_HAMPSHIRE_CFS_ENDPOINTS.expenditures,
    {
      pageNumber: requirePositiveInteger(input.pageNumber ?? 1, "New Hampshire CFS page number"),
      pageSize: requirePageSize(input.pageSize),
      sortBy: null,
      sortType: null,
      transactionTypeCode: "TEXP",
      transactionSearch: "TIE",
      electionCycle: String(requirePositiveInteger(input.electionCycleId, "New Hampshire election-cycle ID")),
    },
    options
  );
  return parsePage(envelope, parseIndependentExpenditureRow);
}

async function getAllPages<T>(input: {
  pageSize: number;
  getPage: (pageNumber: number) => Promise<NewHampshireCfsPage<T>>;
}): Promise<T[]> {
  const items: T[] = [];
  let expectedTotal: number | null = null;
  for (let pageNumber = 1; ; pageNumber += 1) {
    const page = await input.getPage(pageNumber);
    if (expectedTotal === null) {
      expectedTotal = page.totalItems;
    } else if (page.totalItems !== expectedTotal) {
      throw new NewHampshireCfsClientError(
        "bad_response",
        `New Hampshire CFS totalItems changed during pagination: ${expectedTotal} -> ${page.totalItems}`
      );
    }
    items.push(...page.items);
    if (items.length >= expectedTotal) {
      if (items.length !== expectedTotal) {
        throw new NewHampshireCfsClientError(
          "bad_response",
          `New Hampshire CFS pagination returned ${items.length} rows for totalItems ${expectedTotal}`
        );
      }
      return items;
    }
    if (page.items.length === 0 || page.items.length > input.pageSize) {
      throw new NewHampshireCfsClientError("bad_response", "New Hampshire CFS pagination ended inconsistently");
    }
  }
}

export async function getAllNewHampshireReceipts(
  input: Omit<NewHampshireReceiptSearchInput, "pageNumber">,
  options?: NewHampshireCfsClientOptions
): Promise<NewHampshireReceiptRow[]> {
  const pageSize = requirePageSize(input.pageSize);
  return getAllPages({
    pageSize,
    getPage: (pageNumber) => getNewHampshireReceiptPage({ ...input, pageNumber, pageSize }, options),
  });
}

export async function getAllNewHampshireFilingEntities(
  input: Omit<NewHampshireFilingEntitySearchInput, "pageNumber">,
  options?: NewHampshireCfsClientOptions
): Promise<NewHampshireFilingEntityRow[]> {
  const pageSize = requirePageSize(input.pageSize);
  return getAllPages({
    pageSize,
    getPage: (pageNumber) =>
      getNewHampshireFilingEntityPage({ ...input, pageNumber, pageSize }, options),
  });
}

export async function getAllNewHampshireIndependentExpenditures(
  input: Omit<NewHampshireIndependentExpenditureSearchInput, "pageNumber">,
  options?: NewHampshireCfsClientOptions
): Promise<NewHampshireIndependentExpenditureRow[]> {
  const pageSize = requirePageSize(input.pageSize);
  return getAllPages({
    pageSize,
    getPage: (pageNumber) =>
      getNewHampshireIndependentExpenditurePage({ ...input, pageNumber, pageSize }, options),
  });
}
