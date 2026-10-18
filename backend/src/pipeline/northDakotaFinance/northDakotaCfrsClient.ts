import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import tls from "node:tls";

import { Agent } from "undici";

import { NORTH_DAKOTA_CFRS_INTERMEDIATE_CA_PEM } from "./northDakotaCfrsIntermediateCa.js";

// North Dakota's CFRS portal (launched 2026-01-01) is the same Civix-family
// "Ethics Solution" product West Virginia runs: anonymous JSON API under
// /api/Public-Service, isSuccess/responseData envelopes, daily bulk CSVs
// behind a presigned-S3 mint step. Every contract below was verified live
// from plain Node on 2026-09-01.
export const NORTH_DAKOTA_CFRS_PUBLIC_SERVICE_BASE_URL = "https://cfrs.sos.nd.gov/api/Public-Service";

// The WAF returns 403 for non-browser user agents on every path including
// /api (verified live 2026-09-01: curl UA -> 403 HTML), so the client pins a
// desktop-browser UA plus the portal's own Origin/Referer.
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

export const NORTH_DAKOTA_CFRS_FETCH_TIMEOUT_MS = 120_000;
const DEFAULT_PAGE_SIZE = 2_000;
const MAX_PAGE_SIZE = 5_000;
const MAX_JSON_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_FILE_RESPONSE_BYTES = 512 * 1024 * 1024;
// The catalog held 19 artifacts at probe time; a bare {} body returns only the
// first 10, so pageSize is mandatory.
const CATALOG_PAGE_SIZE = 500;

// Query selectors for the transaction search. They are NOT trusted as row
// classifiers: every returned row is classified from its own orgType /
// transactionTypeDesc fields. Codes verified live from registry + transaction
// rows (101 candidate committee, 102 PAC, 103 party committee, 104 IE
// committee).
export const NORTH_DAKOTA_ORG_TYPE_CODES = {
  candidateCommittee: "101",
  politicalActionCommittee: "102",
  partyCommittee: "103",
  independentExpenditureCommittee: "104",
} as const;

/** Registry `orgType` of a candidate filer (376 of 601 registry rows live 2026-09-01). */
export const NORTH_DAKOTA_CANDIDATE_COMMITTEE_ORG_TYPE = "Candidate/Candidate Committee";

export type NorthDakotaCfrsClientErrorCode = "invalid_request" | "network_error" | "http_error" | "bad_response";

export class NorthDakotaCfrsClientError extends Error {
  constructor(
    public readonly code: NorthDakotaCfrsClientErrorCode,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "NorthDakotaCfrsClientError";
  }
}

export type NorthDakotaCfrsClientOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
  /** Save the genuine complete body before HTTP/schema validation. The
   * observer receives copies and cannot change the client's interpretation.
   * An archival failure aborts the request rather than publishing an
   * unrecorded response as a source observation. */
  onJsonResponse?: (capture: NorthDakotaCfrsJsonCapture) => void | Promise<void>;
};

export type NorthDakotaCfrsJsonCapture = {
  url: string;
  responseUrl: string;
  method: "GET" | "POST";
  requestBody: Record<string, unknown> | null;
  status: number;
  contentType: string | null;
  startedAt: string;
  completedAt: string;
  bytes: Uint8Array;
};

// Presigned S3 URLs embed temporary credentials in the query string; only the
// origin+path ever appears in errors or logs.
export function redactPresignedUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<unparseable-url>";
  }
}

// --- TLS fallback -----------------------------------------------------------
// cfrs.sos.nd.gov serves its leaf certificate twice and no intermediate, so a
// request through default trust fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE.
// The client tries normal system trust first and only then retries with
// Node's bundled roots plus the pinned public intermediate (verification stays
// enabled). The fallback dispatcher is cached for the rest of the process, and
// uses are counted so a fixed chain is observable.

const TLS_FALLBACK_ERROR_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);

let fallbackAgent: Agent | null = null;
let fallbackUseCount = 0;
let preferFallback = false;

export function getNorthDakotaTlsFallbackUseCount(): number {
  return fallbackUseCount;
}

function getFallbackAgent(): Agent {
  if (!fallbackAgent) {
    fallbackAgent = new Agent({
      connect: { ca: [...tls.rootCertificates, NORTH_DAKOTA_CFRS_INTERMEDIATE_CA_PEM] },
    });
  }
  return fallbackAgent;
}

function isTlsChainError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const cause = (error as { cause?: unknown }).cause;
  const code =
    typeof cause === "object" && cause !== null
      ? (cause as { code?: unknown }).code
      : (error as { code?: unknown }).code;
  return typeof code === "string" && TLS_FALLBACK_ERROR_CODES.has(code);
}

type FetchRequestInit = RequestInit & { dispatcher?: Agent };

async function fetchWithTlsFallback(
  url: string,
  init: RequestInit,
  options?: NorthDakotaCfrsClientOptions
): Promise<Response> {
  // A caller-supplied fetchImpl (tests) bypasses the dispatcher machinery.
  if (options?.fetchImpl) {
    return options.fetchImpl(url, init);
  }
  if (preferFallback) {
    fallbackUseCount += 1;
    return fetch(url, { ...init, dispatcher: getFallbackAgent() } as FetchRequestInit);
  }
  try {
    return await fetch(url, init);
  } catch (error) {
    if (!isTlsChainError(error)) throw error;
    const response = await fetch(url, { ...init, dispatcher: getFallbackAgent() } as FetchRequestInit);
    preferFallback = true;
    fallbackUseCount += 1;
    return response;
  }
}

// --- shared validation helpers ---------------------------------------------

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new NorthDakotaCfrsClientError("invalid_request", `Invalid ${label}: ${value}`);
  }
  return value;
}

function requirePageSize(value: number | undefined): number {
  const pageSize = value ?? DEFAULT_PAGE_SIZE;
  requirePositiveInteger(pageSize, "North Dakota CFRS page size");
  if (pageSize > MAX_PAGE_SIZE) {
    throw new NorthDakotaCfrsClientError(
      "invalid_request",
      `North Dakota CFRS page size exceeds ${MAX_PAGE_SIZE}: ${pageSize}`
    );
  }
  return pageSize;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new NorthDakotaCfrsClientError("bad_response", `Invalid North Dakota CFRS ${label}`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new NorthDakotaCfrsClientError("bad_response", `Invalid North Dakota CFRS ${label}`);
  }
  return value.trim();
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function requiredFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new NorthDakotaCfrsClientError("bad_response", `Invalid North Dakota CFRS ${label}`);
  }
  return value;
}

function requiredInteger(value: unknown, label: string): number {
  const parsed = requiredFiniteNumber(value, label);
  if (!Number.isInteger(parsed)) {
    throw new NorthDakotaCfrsClientError("bad_response", `Invalid North Dakota CFRS ${label}`);
  }
  return parsed;
}

function nullableInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

// --- request + envelope -----------------------------------------------------

async function requestJsonEnvelope(input: {
  method: "GET" | "POST";
  endpoint: string;
  body?: Record<string, unknown>;
  options?: NorthDakotaCfrsClientOptions;
}): Promise<Record<string, unknown>> {
  if (!/^[A-Za-z][A-Za-z0-9/]+$/.test(input.endpoint)) {
    throw new NorthDakotaCfrsClientError("invalid_request", `Invalid North Dakota CFRS endpoint: ${input.endpoint}`);
  }
  const timeoutMs = input.options?.timeoutMs ?? NORTH_DAKOTA_CFRS_FETCH_TIMEOUT_MS;
  requirePositiveInteger(timeoutMs, "North Dakota CFRS timeout");
  const userAgent = input.options?.userAgent?.trim() || DEFAULT_USER_AGENT;
  const url = `${NORTH_DAKOTA_CFRS_PUBLIC_SERVICE_BASE_URL}/${input.endpoint}`;
  const startedAt = new Date().toISOString();

  let response: Response;
  try {
    response = await fetchWithTlsFallback(
      url,
      {
        method: input.method,
        headers: {
          Accept: "application/json, text/plain, */*",
          ...(input.method === "POST" ? { "Content-Type": "application/json" } : {}),
          Origin: "https://cfrs.sos.nd.gov",
          Referer: "https://cfrs.sos.nd.gov/",
          "User-Agent": userAgent,
        },
        ...(input.method === "POST" ? { body: JSON.stringify(input.body ?? {}) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      },
      input.options
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new NorthDakotaCfrsClientError(
      "network_error",
      `North Dakota CFRS request failed (${input.endpoint}): ${message}`
    );
  }

  const declaredLength = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_RESPONSE_BYTES) {
    throw new NorthDakotaCfrsClientError(
      "bad_response",
      `North Dakota CFRS ${input.endpoint} exceeded ${MAX_JSON_RESPONSE_BYTES} bytes`
    );
  }
  // A stall or reset while the body streams rejects here, not in fetch above;
  // keep it inside the typed-error contract.
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new NorthDakotaCfrsClientError(
      "network_error",
      `North Dakota CFRS response read failed (${input.endpoint}): ${message}`
    );
  }
  if (bytes.byteLength > MAX_JSON_RESPONSE_BYTES) {
    throw new NorthDakotaCfrsClientError(
      "bad_response",
      `North Dakota CFRS ${input.endpoint} exceeded ${MAX_JSON_RESPONSE_BYTES} bytes`
    );
  }
  if (input.options?.onJsonResponse) {
    await input.options.onJsonResponse({
      url,
      responseUrl: response.url,
      method: input.method,
      requestBody: input.method === "POST" ? structuredClone(input.body ?? {}) : null,
      status: response.status,
      contentType: response.headers.get("content-type"),
      startedAt,
      completedAt: new Date().toISOString(),
      bytes: bytes.slice(),
    });
  }
  const text = new TextDecoder().decode(bytes);

  if (!response.ok) {
    throw new NorthDakotaCfrsClientError(
      "http_error",
      `North Dakota CFRS ${input.endpoint} returned HTTP ${response.status}`,
      response.status
    );
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  // An HTML body here is the WAF block page — fail closed rather than parse.
  if (!contentType.includes("application/json")) {
    throw new NorthDakotaCfrsClientError(
      "bad_response",
      `North Dakota CFRS ${input.endpoint} returned unexpected content type: ${contentType || "missing"}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new NorthDakotaCfrsClientError("bad_response", `North Dakota CFRS ${input.endpoint} returned invalid JSON`);
  }
  const envelope = objectValue(parsed, "response envelope");
  if (envelope.isSuccess !== true) {
    const message = nullableString(envelope.message);
    throw new NorthDakotaCfrsClientError(
      "bad_response",
      `North Dakota CFRS ${input.endpoint} failed${message ? `: ${message}` : ""}`
    );
  }
  return envelope;
}

type NorthDakotaPage<T> = { totalRecords: number; rows: T[] };

function parsePageEnvelope<T>(
  envelope: Record<string, unknown>,
  parseRow: (value: unknown) => T
): NorthDakotaPage<T> {
  const responseData = objectValue(envelope.responseData, "responseData");
  const totalRecords = requiredInteger(responseData.totalRecords, "totalRecords");
  if (totalRecords < 0) {
    throw new NorthDakotaCfrsClientError("bad_response", "Invalid North Dakota CFRS totalRecords");
  }
  const data = responseData.data;
  if (data === null || data === undefined) {
    return { totalRecords, rows: [] };
  }
  if (!Array.isArray(data)) {
    throw new NorthDakotaCfrsClientError("bad_response", "Invalid North Dakota CFRS page data");
  }
  return { totalRecords, rows: data.map(parseRow) };
}

async function getAllPages<T>(input: {
  pageSize: number;
  getPage: (pageNumber: number) => Promise<NorthDakotaPage<T>>;
}): Promise<T[]> {
  const rows: T[] = [];
  let expectedTotal: number | null = null;
  for (let pageNumber = 1; ; pageNumber += 1) {
    const page = await input.getPage(pageNumber);
    if (expectedTotal === null) {
      expectedTotal = page.totalRecords;
    } else if (page.totalRecords !== expectedTotal) {
      throw new NorthDakotaCfrsClientError(
        "bad_response",
        `North Dakota CFRS totalRecords changed during pagination: ${expectedTotal} -> ${page.totalRecords}`
      );
    }
    rows.push(...page.rows);
    if (rows.length >= expectedTotal) {
      if (rows.length !== expectedTotal) {
        throw new NorthDakotaCfrsClientError(
          "bad_response",
          `North Dakota CFRS pagination returned ${rows.length} rows for totalRecords ${expectedTotal}`
        );
      }
      return rows;
    }
    if (page.rows.length === 0 || page.rows.length > input.pageSize) {
      throw new NorthDakotaCfrsClientError("bad_response", "North Dakota CFRS pagination ended inconsistently");
    }
  }
}

// --- data-download catalog --------------------------------------------------

export type NorthDakotaDataDownloadCatalogRow = {
  id: number;
  /** Observed values: Contributions, Expenditures, Filed reports,
   * Registrations, Reporting Schedules (no Loans/Debts/IE files listed). */
  dataType: string;
  year: string;
  s3ReportFilePath: string;
};

function parseCatalogRow(value: unknown): NorthDakotaDataDownloadCatalogRow {
  const row = objectValue(value, "catalog row");
  return {
    id: requiredInteger(row.id, "catalog id"),
    dataType: requiredString(row.dataType, "catalog dataType"),
    year: requiredString(row.year, "catalog year"),
    s3ReportFilePath: requiredString(row.s3ReportFilePath, "catalog s3ReportFilePath"),
  };
}

export async function getNorthDakotaDataDownloadCatalog(
  options?: NorthDakotaCfrsClientOptions
): Promise<NorthDakotaDataDownloadCatalogRow[]> {
  const envelope = await requestJsonEnvelope({
    method: "POST",
    endpoint: "AccessReport/getDataDownloadDataList",
    body: { pageNumber: 1, pageSize: CATALOG_PAGE_SIZE },
    options,
  });
  const page = parsePageEnvelope(envelope, parseCatalogRow);
  if (page.rows.length !== page.totalRecords) {
    throw new NorthDakotaCfrsClientError(
      "bad_response",
      `North Dakota CFRS catalog returned ${page.rows.length} rows for totalRecords ${page.totalRecords}`
    );
  }
  return page.rows;
}

// The catalog id goes in the PATH (the query-parameter form 404s). The
// envelope also carries CloudFront policy fields; only fileUrl is used.
export async function getNorthDakotaDataDownloadFileUrl(
  catalogId: number,
  options?: NorthDakotaCfrsClientOptions
): Promise<string> {
  const envelope = await requestJsonEnvelope({
    method: "POST",
    endpoint: `AccessReport/getDataDownloadfile/${requirePositiveInteger(catalogId, "catalog id")}`,
    body: {},
    options,
  });
  const responseData = objectValue(envelope.responseData, "download-file responseData");
  const fileUrl = requiredString(responseData.fileUrl, "download fileUrl");
  if (!fileUrl.startsWith("https://")) {
    throw new NorthDakotaCfrsClientError("bad_response", "North Dakota CFRS download fileUrl is not https");
  }
  return fileUrl;
}

// --- presigned-file download ------------------------------------------------

export type NorthDakotaPresignedDownloadResult = {
  redactedUrl: string;
  contentType: string | null;
  outputPath: string;
  bytesWritten: number;
  sha256: string;
};

export async function downloadNorthDakotaPresignedFile(
  input: { url: string; outputPath: string },
  options?: NorthDakotaCfrsClientOptions
): Promise<NorthDakotaPresignedDownloadResult> {
  const redactedUrl = redactPresignedUrl(input.url);
  const timeoutMs = options?.timeoutMs ?? NORTH_DAKOTA_CFRS_FETCH_TIMEOUT_MS;
  requirePositiveInteger(timeoutMs, "North Dakota CFRS timeout");
  const fetchImpl = options?.fetchImpl ?? fetch;

  let response: Response;
  try {
    // The S3 host serves a valid public chain; no UA or CA workarounds here.
    response = await fetchImpl(input.url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new NorthDakotaCfrsClientError(
      "network_error",
      `North Dakota CFRS presigned download failed (${redactedUrl}): ${message}`
    );
  }
  if (!response.ok || !response.body) {
    throw new NorthDakotaCfrsClientError(
      "http_error",
      `North Dakota CFRS presigned download returned HTTP ${response.status} (${redactedUrl})`,
      response.status
    );
  }

  // Bulk files carry contributor street addresses: restricted directory and
  // file modes, never logged.
  const outputPath = resolve(input.outputPath);
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  const hash = createHash("sha256");
  let bytesWritten = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesWritten += chunk.byteLength;
      if (bytesWritten > MAX_FILE_RESPONSE_BYTES) {
        callback(
          new NorthDakotaCfrsClientError(
            "bad_response",
            `North Dakota CFRS presigned download exceeded ${MAX_FILE_RESPONSE_BYTES} bytes (${redactedUrl})`
          )
        );
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const source = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);
  const bodyTimeout = setTimeout(() => {
    source.destroy(
      new NorthDakotaCfrsClientError(
        "network_error",
        `North Dakota CFRS presigned download body timed out after ${timeoutMs}ms (${redactedUrl})`
      )
    );
  }, timeoutMs);

  try {
    await pipeline(source, meter, createWriteStream(outputPath, { mode: 0o600 }));
    await chmod(outputPath, 0o600);
    const outputStat = await stat(outputPath);
    if (!outputStat.isFile() || outputStat.size === 0 || outputStat.size !== bytesWritten) {
      throw new NorthDakotaCfrsClientError(
        "bad_response",
        `North Dakota CFRS presigned download wrote an invalid artifact: ${bytesWritten} bytes (${redactedUrl})`
      );
    }
  } catch (error) {
    await rm(outputPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    clearTimeout(bodyTimeout);
  }

  return {
    redactedUrl,
    contentType: response.headers.get("content-type"),
    outputPath,
    bytesWritten,
    sha256: hash.digest("hex"),
  };
}

// --- committee registry -----------------------------------------------------

// The registry row also carries orgAddress and officerName; neither is read.
export type NorthDakotaCommitteeRow = {
  orgID: number;
  /** 10 digits; the first three are the org type code and the whole value
   * equals the bulk-CSV RegistrantID. */
  entityId: string;
  orgName: string | null;
  candidateName: string | null;
  orgType: string;
  orgTypeCode: string;
  orgSubType: string | null;
  orgSubTypeCode: string | null;
  /** e.g. "2026 Election - Statewide" */
  election: string | null;
  office: string | null;
  district: string | null;
  party: string | null;
  orgStatus: string;
  registrationYear: string | null;
};

function parseCommitteeRow(value: unknown): NorthDakotaCommitteeRow {
  const row = objectValue(value, "committee row");
  const entityId = requiredString(row.entityId, "committee entityId");
  if (!/^\d{10}$/.test(entityId)) {
    throw new NorthDakotaCfrsClientError("bad_response", `Invalid North Dakota CFRS entityId: ${entityId}`);
  }
  return {
    orgID: requiredInteger(row.orgID, "committee orgID"),
    entityId,
    orgName: nullableString(row.orgName),
    candidateName: nullableString(row.candidateName),
    orgType: requiredString(row.orgType, "committee orgType"),
    orgTypeCode: requiredString(row.orgTypeCode, "committee orgTypeCode"),
    orgSubType: nullableString(row.orgSubType),
    orgSubTypeCode: nullableString(row.orgSubTypeCode),
    election: nullableString(row.election),
    office: nullableString(row.office),
    district: nullableString(row.district),
    party: nullableString(row.party),
    orgStatus: requiredString(row.orgStatus, "committee orgStatus"),
    registrationYear: nullableString(row.registrationYear),
  };
}

export async function getAllNorthDakotaCommittees(
  input: { pageSize?: number } = {},
  options?: NorthDakotaCfrsClientOptions
): Promise<NorthDakotaCommitteeRow[]> {
  const pageSize = requirePageSize(input.pageSize);
  return getAllPages({
    pageSize,
    getPage: async (pageNumber) => {
      const envelope = await requestJsonEnvelope({
        method: "POST",
        endpoint: "Committee/getPublicCandidatesCommitteeDataList",
        body: { pageNumber, pageSize },
        options,
      });
      return parsePageEnvelope(envelope, parseCommitteeRow);
    },
  });
}

// --- transaction search -----------------------------------------------------

// The response row also carries contributor street address fields
// (addressLine1/2, city, zipCode, contributorAddress, employerAddress); none
// is read. contributorPayeeName is kept only for per-donor aggregation and is
// never logged.
export type NorthDakotaTransactionRow = {
  transactionID: number;
  entityID: string;
  orgID: number;
  committeeName: string | null;
  candidateName: string | null;
  transactionAmount: number;
  transactionDate: string;
  filedDate: string | null;
  entityTypeDesc: string | null;
  transactionCategoryDesc: string | null;
  transactionTypeDesc: string | null;
  transactionPurpose: string | null;
  contributorPayeeName: string | null;
  contributorPayeeID: number | null;
  employerName: string | null;
  employerOccupation: string | null;
  /** The committee x counterparty year-to-date aggregate as of this row's
   * report (a donor's running total on CON rows, a payee's on IE rows) —
   * neither a report total nor a committee total. Verified 2026-09-01. */
  transactionTotalYTD: string | null;
  amendedFlag: boolean;
  reportVersionID: string | null;
  reportFileName: string | null;
  s3ReportFilePath: string | null;
  stanceDescription: string | null;
  candidateNameAssocation: string | null;
  electionYear: number | null;
  orgType: string | null;
};

function parseTransactionRow(value: unknown): NorthDakotaTransactionRow {
  const row = objectValue(value, "transaction row");
  return {
    transactionID: requiredInteger(row.transactionID, "transactionID"),
    entityID: requiredString(row.entityID, "transaction entityID"),
    orgID: requiredInteger(row.orgID, "transaction orgID"),
    committeeName: nullableString(row.committeeName),
    candidateName: nullableString(row.candidateName),
    transactionAmount: requiredFiniteNumber(row.transactionAmount, "transactionAmount"),
    transactionDate: requiredString(row.transactionDate, "transactionDate"),
    filedDate: nullableString(row.filedDate),
    entityTypeDesc: nullableString(row.entityTypeDesc),
    transactionCategoryDesc: nullableString(row.transactionCategoryDesc),
    transactionTypeDesc: nullableString(row.transactionTypeDesc),
    transactionPurpose: nullableString(row.transactionPurpose),
    contributorPayeeName: nullableString(row.contributorPayeeName),
    contributorPayeeID: nullableInteger(row.contributorPayeeID),
    employerName: nullableString(row.employerName),
    employerOccupation: nullableString(row.employerOccupation),
    transactionTotalYTD: nullableString(row.transactionTotalYTD),
    amendedFlag: row.amendedFlag === true,
    reportVersionID: nullableString(row.reportVersionID),
    reportFileName: nullableString(row.reportFileName),
    s3ReportFilePath: nullableString(row.s3ReportFilePath),
    stanceDescription: nullableString(row.stanceDescription),
    candidateNameAssocation: nullableString(row.candidateNameAssocation),
    electionYear: nullableInteger(row.electionYear),
    orgType: nullableString(row.orgType),
  };
}

export type NorthDakotaTransactionCategory = "CON" | "EXP" | "IE";

export type NorthDakotaTransactionSearchInput = {
  transactionCategory: NorthDakotaTransactionCategory;
  /** Required for "IE": without it the server silently falls through to the
   * full transaction set (verified live: 52 rows with orgTypeCode 104, 6,027
   * without). Unknown VALUES never error — assert against known fixtures. */
  orgTypeCode?: string;
  transactionYear?: number;
  pageSize?: number;
};

export async function getAllNorthDakotaTransactions(
  input: NorthDakotaTransactionSearchInput,
  options?: NorthDakotaCfrsClientOptions
): Promise<NorthDakotaTransactionRow[]> {
  if (input.orgTypeCode !== undefined && !/^\d{3}$/.test(input.orgTypeCode)) {
    throw new NorthDakotaCfrsClientError(
      "invalid_request",
      `North Dakota CFRS transaction search orgTypeCode must be 3 digits, got: ${input.orgTypeCode}`
    );
  }
  if (input.transactionCategory === "IE" && input.orgTypeCode === undefined) {
    throw new NorthDakotaCfrsClientError(
      "invalid_request",
      "North Dakota CFRS IE search requires orgTypeCode (the server otherwise returns every transaction)"
    );
  }
  const pageSize = requirePageSize(input.pageSize);
  const baseBody: Record<string, unknown> = {
    transactionCategory: input.transactionCategory,
    sortColumn: "transactionDate",
    sortDirection: "DESC",
    transactionYear:
      input.transactionYear === undefined ? "" : String(requirePositiveInteger(input.transactionYear, "transactionYear")),
  };
  if (input.orgTypeCode !== undefined) baseBody.orgTypeCode = input.orgTypeCode;

  return getAllPages({
    pageSize,
    getPage: async (pageNumber) => {
      const envelope = await requestJsonEnvelope({
        method: "POST",
        endpoint: "CommitteeTransactions/getAllPublicTransactionDataList",
        body: { ...baseBody, pageNumber, pageSize },
        options,
      });
      return parsePageEnvelope(envelope, parseTransactionRow);
    },
  });
}

// --- portal chart totals ----------------------------------------------------

// Bare GET endpoints with no parameters (query parameters 400). Each returns
// all-years totals (2025 + 2026 at probe time) broken down by contributor/
// recipient type and by committee type — the reconciliation control for the
// bulk-CSV sums.
export type NorthDakotaChartKind = "contributions" | "expenditures" | "independentExpenditures";

const CHART_ENDPOINTS: Record<NorthDakotaChartKind, string> = {
  contributions: "CommitteeTransactions/getContributionChartData",
  expenditures: "CommitteeTransactions/getExpenditureChartData",
  independentExpenditures: "CommitteeTransactions/getIndependentExpenditureChartData",
};

export type NorthDakotaChartSeries = {
  name: string;
  totalAmount: number;
  data: Array<{ description: string; amount: number }>;
};

function parseChartSeries(value: unknown): NorthDakotaChartSeries {
  const series = objectValue(value, "chart series");
  const data = series.data;
  if (!Array.isArray(data)) {
    throw new NorthDakotaCfrsClientError("bad_response", "Invalid North Dakota CFRS chart series data");
  }
  return {
    name: requiredString(series.name, "chart series name"),
    totalAmount: requiredFiniteNumber(series.totalAmount, "chart series totalAmount"),
    data: data.map((entry) => {
      const point = objectValue(entry, "chart point");
      return {
        description: requiredString(point.description, "chart point description"),
        amount: requiredFiniteNumber(point.amount, "chart point amount"),
      };
    }),
  };
}

export async function getNorthDakotaChartData(
  kind: NorthDakotaChartKind,
  options?: NorthDakotaCfrsClientOptions
): Promise<NorthDakotaChartSeries[]> {
  const envelope = await requestJsonEnvelope({ method: "GET", endpoint: CHART_ENDPOINTS[kind], options });
  const responseData = envelope.responseData;
  if (!Array.isArray(responseData)) {
    throw new NorthDakotaCfrsClientError("bad_response", "Invalid North Dakota CFRS chart responseData");
  }
  return responseData.map(parseChartSeries);
}
