import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import tls from "node:tls";

import { Agent } from "undici";

import { WEST_VIRGINIA_CFRS_INTERMEDIATE_CA_PEM } from "./westVirginiaCfrsIntermediateCa.js";

// Two ASP.NET services behind one host. Data lives on Public-Service; the
// document presigned-link endpoint lives on Common-Service.
export const WEST_VIRGINIA_CFRS_PUBLIC_SERVICE_BASE_URL = "https://cfrs.wvsos.gov/api/Public-Service";
export const WEST_VIRGINIA_CFRS_COMMON_SERVICE_BASE_URL = "https://cfrs.wvsos.gov/api/Common-Service";

// The WAF returns 403 for non-browser user agents on every path including
// /api (verified live 2026-08-26), so the client pins a desktop-browser UA.
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

export const WEST_VIRGINIA_CFRS_FETCH_TIMEOUT_MS = 120_000;
const DEFAULT_PAGE_SIZE = 2_000;
const MAX_PAGE_SIZE = 5_000;
const MAX_JSON_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_FILE_RESPONSE_BYTES = 512 * 1024 * 1024;
const CATALOG_PAGE_SIZE = 5_000;

// The selectors on the transaction search are unstable query modes, not
// filters: orgTypeCode is mandatory and every returned row must still be
// classified from its own response fields.
export const WEST_VIRGINIA_ORG_TYPE_CODES = {
  stateCandidate: "101",
  statePac: "102",
  independentExpenditureCommittee: "104",
} as const;

export type WestVirginiaCfrsClientErrorCode =
  | "invalid_request"
  | "network_error"
  | "http_error"
  | "bad_response";

export class WestVirginiaCfrsClientError extends Error {
  constructor(
    public readonly code: WestVirginiaCfrsClientErrorCode,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "WestVirginiaCfrsClientError";
  }
}

export type WestVirginiaCfrsClientOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
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
// cfrs.wvsos.gov serves an incomplete certificate chain, so the first request
// through default trust fails with an issuer-verification error. The client
// tries normal system trust first and only then retries with Node's bundled
// roots plus the pinned public intermediate (verification stays enabled).
// The fallback dispatcher is cached for the rest of the process, and uses are
// counted so a fixed chain is observable.

const TLS_FALLBACK_ERROR_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);

let fallbackAgent: Agent | null = null;
let fallbackUseCount = 0;
let preferFallback = false;

export function getWestVirginiaTlsFallbackUseCount(): number {
  return fallbackUseCount;
}

function getFallbackAgent(): Agent {
  if (!fallbackAgent) {
    fallbackAgent = new Agent({
      connect: { ca: [...tls.rootCertificates, WEST_VIRGINIA_CFRS_INTERMEDIATE_CA_PEM] },
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
  options?: WestVirginiaCfrsClientOptions
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
    throw new WestVirginiaCfrsClientError("invalid_request", `Invalid ${label}: ${value}`);
  }
  return value;
}

function requirePageSize(value: number | undefined): number {
  const pageSize = value ?? DEFAULT_PAGE_SIZE;
  requirePositiveInteger(pageSize, "West Virginia CFRS page size");
  if (pageSize > MAX_PAGE_SIZE) {
    throw new WestVirginiaCfrsClientError(
      "invalid_request",
      `West Virginia CFRS page size exceeds ${MAX_PAGE_SIZE}: ${pageSize}`
    );
  }
  return pageSize;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WestVirginiaCfrsClientError("bad_response", `Invalid West Virginia CFRS ${label}`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WestVirginiaCfrsClientError("bad_response", `Invalid West Virginia CFRS ${label}`);
  }
  return value.trim();
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function requiredFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WestVirginiaCfrsClientError("bad_response", `Invalid West Virginia CFRS ${label}`);
  }
  return value;
}

function requiredInteger(value: unknown, label: string): number {
  const parsed = requiredFiniteNumber(value, label);
  if (!Number.isInteger(parsed)) {
    throw new WestVirginiaCfrsClientError("bad_response", `Invalid West Virginia CFRS ${label}`);
  }
  return parsed;
}

// --- HTTP + envelope --------------------------------------------------------

async function requestJsonEnvelope(input: {
  baseUrl: string;
  endpoint: string;
  body: Record<string, unknown>;
  method?: "POST" | "GET";
  options?: WestVirginiaCfrsClientOptions;
}): Promise<Record<string, unknown>> {
  if (!/^[A-Za-z][A-Za-z0-9/]+$/.test(input.endpoint)) {
    throw new WestVirginiaCfrsClientError("invalid_request", `Invalid West Virginia CFRS endpoint: ${input.endpoint}`);
  }
  const timeoutMs = input.options?.timeoutMs ?? WEST_VIRGINIA_CFRS_FETCH_TIMEOUT_MS;
  requirePositiveInteger(timeoutMs, "West Virginia CFRS timeout");
  const userAgent = input.options?.userAgent?.trim() || DEFAULT_USER_AGENT;
  const url = `${input.baseUrl}/${input.endpoint}`;

  let response: Response;
  try {
    response = await fetchWithTlsFallback(
      url,
      {
        method: input.method ?? "POST",
        headers: {
          Accept: "application/json, text/plain, */*",
          "Content-Type": "application/json",
          Origin: "https://cfrs.wvsos.gov",
          Referer: "https://cfrs.wvsos.gov/",
          "User-Agent": userAgent,
        },
        body: input.method === "GET" ? undefined : JSON.stringify(input.body),
        signal: AbortSignal.timeout(timeoutMs),
      },
      input.options
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WestVirginiaCfrsClientError(
      "network_error",
      `West Virginia CFRS request failed (${input.endpoint}): ${message}`
    );
  }

  const declaredLength = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_RESPONSE_BYTES) {
    throw new WestVirginiaCfrsClientError(
      "bad_response",
      `West Virginia CFRS ${input.endpoint} exceeded ${MAX_JSON_RESPONSE_BYTES} bytes`
    );
  }
  // A stall or reset while the body streams rejects here, not in fetch above;
  // keep it inside the typed-error contract.
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WestVirginiaCfrsClientError(
      "network_error",
      `West Virginia CFRS response read failed (${input.endpoint}): ${message}`
    );
  }
  if (bytes.byteLength > MAX_JSON_RESPONSE_BYTES) {
    throw new WestVirginiaCfrsClientError(
      "bad_response",
      `West Virginia CFRS ${input.endpoint} exceeded ${MAX_JSON_RESPONSE_BYTES} bytes`
    );
  }
  const text = new TextDecoder().decode(bytes);

  if (!response.ok) {
    throw new WestVirginiaCfrsClientError(
      "http_error",
      `West Virginia CFRS ${input.endpoint} returned HTTP ${response.status}`,
      response.status
    );
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  // An HTML body here is the WAF block page — fail closed rather than parse.
  if (!contentType.includes("application/json")) {
    throw new WestVirginiaCfrsClientError(
      "bad_response",
      `West Virginia CFRS ${input.endpoint} returned unexpected content type: ${contentType || "missing"}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WestVirginiaCfrsClientError("bad_response", `West Virginia CFRS ${input.endpoint} returned invalid JSON`);
  }
  const envelope = objectValue(parsed, "response envelope");
  if (envelope.isSuccess !== true) {
    const message = nullableString(envelope.message);
    throw new WestVirginiaCfrsClientError(
      "bad_response",
      `West Virginia CFRS ${input.endpoint} failed${message ? `: ${message}` : ""}`
    );
  }
  return envelope;
}

type WestVirginiaPage<T> = { totalRecords: number; rows: T[] };

function parsePageEnvelope<T>(
  envelope: Record<string, unknown>,
  parseRow: (value: unknown) => T
): WestVirginiaPage<T> {
  const responseData = objectValue(envelope.responseData, "responseData");
  const totalRecords = requiredInteger(responseData.totalRecords, "totalRecords");
  if (totalRecords < 0) {
    throw new WestVirginiaCfrsClientError("bad_response", "Invalid West Virginia CFRS totalRecords");
  }
  const data = responseData.data;
  if (data === null || data === undefined) {
    return { totalRecords, rows: [] };
  }
  if (!Array.isArray(data)) {
    throw new WestVirginiaCfrsClientError("bad_response", "Invalid West Virginia CFRS page data");
  }
  return { totalRecords, rows: data.map(parseRow) };
}

async function getAllPages<T>(input: {
  pageSize: number;
  getPage: (pageNumber: number) => Promise<WestVirginiaPage<T>>;
}): Promise<T[]> {
  const rows: T[] = [];
  let expectedTotal: number | null = null;
  for (let pageNumber = 1; ; pageNumber += 1) {
    const page = await input.getPage(pageNumber);
    if (expectedTotal === null) {
      expectedTotal = page.totalRecords;
    } else if (page.totalRecords !== expectedTotal) {
      throw new WestVirginiaCfrsClientError(
        "bad_response",
        `West Virginia CFRS totalRecords changed during pagination: ${expectedTotal} -> ${page.totalRecords}`
      );
    }
    rows.push(...page.rows);
    if (rows.length >= expectedTotal) {
      if (rows.length !== expectedTotal) {
        throw new WestVirginiaCfrsClientError(
          "bad_response",
          `West Virginia CFRS pagination returned ${rows.length} rows for totalRecords ${expectedTotal}`
        );
      }
      return rows;
    }
    if (page.rows.length === 0 || page.rows.length > input.pageSize) {
      throw new WestVirginiaCfrsClientError("bad_response", "West Virginia CFRS pagination ended inconsistently");
    }
  }
}

// --- data-download catalog --------------------------------------------------

export type WestVirginiaDataDownloadType = "CON" | "EXP" | "DEB" | "LOAN" | "REG" | "REPS" | "FREP";

export type WestVirginiaDataDownloadCatalogRow = {
  id: number;
  dataType: string;
  year: string;
  s3ReportFilePath: string;
};

function parseCatalogRow(value: unknown): WestVirginiaDataDownloadCatalogRow {
  const row = objectValue(value, "catalog row");
  return {
    id: requiredInteger(row.id, "catalog id"),
    dataType: requiredString(row.dataType, "catalog dataType"),
    year: requiredString(row.year, "catalog year"),
    s3ReportFilePath: requiredString(row.s3ReportFilePath, "catalog s3ReportFilePath"),
  };
}

export async function getWestVirginiaDataDownloadCatalog(
  input: { dataType?: WestVirginiaDataDownloadType; year?: number } = {},
  options?: WestVirginiaCfrsClientOptions
): Promise<WestVirginiaDataDownloadCatalogRow[]> {
  // A bare {} returns zero rows — pageNumber/pageSize are mandatory.
  const body: Record<string, unknown> = { pageNumber: 1, pageSize: CATALOG_PAGE_SIZE };
  if (input.dataType) body.dataType = input.dataType;
  if (input.year !== undefined) body.year = String(requirePositiveInteger(input.year, "catalog year"));
  const envelope = await requestJsonEnvelope({
    baseUrl: WEST_VIRGINIA_CFRS_PUBLIC_SERVICE_BASE_URL,
    endpoint: "AccessReport/getDataDownloadDataList",
    body,
    options,
  });
  const page = parsePageEnvelope(envelope, parseCatalogRow);
  if (page.rows.length !== page.totalRecords) {
    throw new WestVirginiaCfrsClientError(
      "bad_response",
      `West Virginia CFRS catalog returned ${page.rows.length} rows for totalRecords ${page.totalRecords}`
    );
  }
  return page.rows;
}

export async function getWestVirginiaDataDownloadFileUrl(
  catalogId: number,
  options?: WestVirginiaCfrsClientOptions
): Promise<string> {
  const envelope = await requestJsonEnvelope({
    baseUrl: WEST_VIRGINIA_CFRS_PUBLIC_SERVICE_BASE_URL,
    endpoint: `AccessReport/getDataDownloadfile/${requirePositiveInteger(catalogId, "catalog id")}`,
    body: {},
    options,
  });
  const responseData = objectValue(envelope.responseData, "download-file responseData");
  const fileUrl = requiredString(responseData.fileUrl, "download fileUrl");
  if (!fileUrl.startsWith("https://")) {
    throw new WestVirginiaCfrsClientError("bad_response", "West Virginia CFRS download fileUrl is not https");
  }
  return fileUrl;
}

// --- document store ---------------------------------------------------------

export type WestVirginiaOrgDocumentRow = {
  orgID: number;
  documentID: number;
  documentName: string;
  documentType: string;
  registrantID: string;
  receivedDate: string;
  s3DocName: string;
};

function parseOrgDocumentRow(value: unknown): WestVirginiaOrgDocumentRow {
  const row = objectValue(value, "org document row");
  return {
    orgID: requiredInteger(row.orgID, "document orgID"),
    documentID: requiredInteger(row.documentID, "documentID"),
    documentName: requiredString(row.documentName, "documentName"),
    documentType: requiredString(row.documentType, "documentType"),
    registrantID: requiredString(row.registrantID, "document registrantID"),
    receivedDate: requiredString(row.receivedDate, "document receivedDate"),
    s3DocName: requiredString(row.s3DocName, "document s3DocName"),
  };
}

export async function getAllWestVirginiaOrgDocuments(
  input: { orgID: number; pageSize?: number },
  options?: WestVirginiaCfrsClientOptions
): Promise<WestVirginiaOrgDocumentRow[]> {
  const orgID = requirePositiveInteger(input.orgID, "orgID");
  const pageSize = requirePageSize(input.pageSize);
  return getAllPages({
    pageSize,
    getPage: async (pageNumber) => {
      const envelope = await requestJsonEnvelope({
        baseUrl: WEST_VIRGINIA_CFRS_PUBLIC_SERVICE_BASE_URL,
        endpoint: "Committee/getAllPublicOrgDocumentDataList",
        body: { orgID, pageNumber, pageSize },
        options,
      });
      return parsePageEnvelope(envelope, parseOrgDocumentRow);
    },
  });
}

// Common-Service, not Public-Service. responseData is the presigned URL string.
export async function getWestVirginiaDocumentDownloadUrl(
  s3FilePath: string,
  options?: WestVirginiaCfrsClientOptions
): Promise<string> {
  const path = s3FilePath.trim();
  if (!path || path.includes("://")) {
    throw new WestVirginiaCfrsClientError("invalid_request", `Invalid West Virginia CFRS s3FilePath: ${path}`);
  }
  const envelope = await requestJsonEnvelope({
    baseUrl: WEST_VIRGINIA_CFRS_COMMON_SERVICE_BASE_URL,
    endpoint: "AmazonCloudFront/getDownloadLinkWithoutCookies",
    body: { s3FilePath: path },
    options,
  });
  const url = requiredString(envelope.responseData, "document download url");
  if (!url.startsWith("https://")) {
    throw new WestVirginiaCfrsClientError("bad_response", "West Virginia CFRS document download url is not https");
  }
  return url;
}

// --- presigned-file download ------------------------------------------------

export type WestVirginiaPresignedDownloadResult = {
  redactedUrl: string;
  contentType: string | null;
  outputPath: string;
  bytesWritten: number;
  sha256: string;
};

export async function downloadWestVirginiaPresignedFile(
  input: { url: string; outputPath: string },
  options?: WestVirginiaCfrsClientOptions
): Promise<WestVirginiaPresignedDownloadResult> {
  const redactedUrl = redactPresignedUrl(input.url);
  const timeoutMs = options?.timeoutMs ?? WEST_VIRGINIA_CFRS_FETCH_TIMEOUT_MS;
  requirePositiveInteger(timeoutMs, "West Virginia CFRS timeout");
  const fetchImpl = options?.fetchImpl ?? fetch;

  let response: Response;
  try {
    // The S3 host serves a valid public chain; no UA or CA workarounds here.
    response = await fetchImpl(input.url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WestVirginiaCfrsClientError(
      "network_error",
      `West Virginia CFRS presigned download failed (${redactedUrl}): ${message}`
    );
  }
  if (!response.ok || !response.body) {
    throw new WestVirginiaCfrsClientError(
      "http_error",
      `West Virginia CFRS presigned download returned HTTP ${response.status} (${redactedUrl})`,
      response.status
    );
  }

  const outputPath = resolve(input.outputPath);
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  const hash = createHash("sha256");
  let bytesWritten = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesWritten += chunk.byteLength;
      if (bytesWritten > MAX_FILE_RESPONSE_BYTES) {
        callback(
          new WestVirginiaCfrsClientError(
            "bad_response",
            `West Virginia CFRS presigned download exceeded ${MAX_FILE_RESPONSE_BYTES} bytes (${redactedUrl})`
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
      new WestVirginiaCfrsClientError(
        "network_error",
        `West Virginia CFRS presigned download body timed out after ${timeoutMs}ms (${redactedUrl})`
      )
    );
  }, timeoutMs);

  try {
    await pipeline(source, meter, createWriteStream(outputPath, { mode: 0o600 }));
    await chmod(outputPath, 0o600);
    const outputStat = await stat(outputPath);
    if (!outputStat.isFile() || outputStat.size === 0 || outputStat.size !== bytesWritten) {
      throw new WestVirginiaCfrsClientError(
        "bad_response",
        `West Virginia CFRS presigned download wrote an invalid artifact: ${bytesWritten} bytes (${redactedUrl})`
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

export type WestVirginiaCommitteeRow = {
  orgID: number;
  entityId: string;
  /** Blank on ~243 registry rows (mostly terminated candidate-only
   * registrations without a committee). */
  orgName: string | null;
  candidateName: string | null;
  orgType: string;
  orgTypeCode: string;
  orgSubType: string | null;
  office: string | null;
  district: string | null;
  party: string | null;
  election: string | null;
  registrationYear: string | null;
  orgStatus: string;
};

function parseCommitteeRow(value: unknown): WestVirginiaCommitteeRow {
  const row = objectValue(value, "committee row");
  const entityId = requiredString(row.entityId, "committee entityId");
  if (!/^\d{10}$/.test(entityId)) {
    throw new WestVirginiaCfrsClientError("bad_response", `Invalid West Virginia CFRS entityId: ${entityId}`);
  }
  return {
    orgID: requiredInteger(row.orgID, "committee orgID"),
    entityId,
    orgName: nullableString(row.orgName),
    candidateName: nullableString(row.candidateName),
    orgType: requiredString(row.orgType, "committee orgType"),
    orgTypeCode: requiredString(row.orgTypeCode, "committee orgTypeCode"),
    orgSubType: nullableString(row.orgSubType),
    office: nullableString(row.office),
    district: nullableString(row.district),
    party: nullableString(row.party),
    election: nullableString(row.election),
    registrationYear: nullableString(row.registrationYear),
    orgStatus: requiredString(row.orgStatus, "committee orgStatus"),
  };
}

export async function getAllWestVirginiaCommittees(
  input: { pageSize?: number } = {},
  options?: WestVirginiaCfrsClientOptions
): Promise<WestVirginiaCommitteeRow[]> {
  const pageSize = requirePageSize(input.pageSize);
  return getAllPages({
    pageSize,
    getPage: async (pageNumber) => {
      const envelope = await requestJsonEnvelope({
        baseUrl: WEST_VIRGINIA_CFRS_PUBLIC_SERVICE_BASE_URL,
        endpoint: "Committee/getPublicCandidatesCommitteeDataList",
        body: { pageNumber, pageSize },
        options,
      });
      return parsePageEnvelope(envelope, parseCommitteeRow);
    },
  });
}

// --- current filings and amendment history ---------------------------------
// The public profile lists only current versions. Its history endpoint lists
// prior versions, excluding the current row (verified report 32245: v2/v1).

export type WestVirginiaFilingHistoryRow = {
  reportID: number;
  reportVersionID: number;
  registrantID: string;
  committeeName: string;
  reportFileName: string;
  reportFormType: string;
  startDate: string;
  endDate: string;
  dueDate: string;
  filedDate: string;
  reportStatus: "Original" | "Amended";
  documentBarCode: string;
};

export type WestVirginiaCurrentFilingRow = WestVirginiaFilingHistoryRow & { orgID: number };

function filingDate(value: unknown, label: string): string {
  const date = requiredString(value, label);
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/.exec(date);
  if (!match) throw new WestVirginiaCfrsClientError("bad_response", `Invalid West Virginia CFRS ${label}`);
  const day = date.slice(0, 10);
  const timestamp = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== day) {
    throw new WestVirginiaCfrsClientError("bad_response", `Invalid West Virginia CFRS ${label}`);
  }
  return date;
}

function positiveResponseInteger(value: unknown, label: string): number {
  const number = requiredInteger(value, label);
  if (number <= 0) throw new WestVirginiaCfrsClientError("bad_response", `Invalid West Virginia CFRS ${label}`);
  return number;
}

function parseFilingHistoryRow(value: unknown): WestVirginiaFilingHistoryRow {
  const row = objectValue(value, "filing row");
  const startDate = filingDate(row.startDate, "filing startDate");
  const endDate = filingDate(row.endDate, "filing endDate");
  if (startDate.slice(0, 10) > endDate.slice(0, 10)) {
    throw new WestVirginiaCfrsClientError("bad_response", "West Virginia CFRS filing period is reversed");
  }
  const reportStatus = requiredString(row.reportStatus, "filing reportStatus");
  if (reportStatus !== "Original" && reportStatus !== "Amended") {
    throw new WestVirginiaCfrsClientError("bad_response", `Unsupported West Virginia CFRS filing status: ${reportStatus}`);
  }
  const registrantID = requiredString(row.registrantID, "filing registrantID");
  if (!/^\d{10}$/.test(registrantID)) {
    throw new WestVirginiaCfrsClientError("bad_response", "Invalid West Virginia CFRS filing registrantID");
  }
  const documentBarCode = requiredString(row.documentBarCode, "filing documentBarCode");
  if (!/^[A-Za-z0-9]+$/.test(documentBarCode)) {
    throw new WestVirginiaCfrsClientError("bad_response", "Invalid West Virginia CFRS filing documentBarCode");
  }
  return {
    reportID: positiveResponseInteger(row.reportID, "filing reportID"),
    reportVersionID: positiveResponseInteger(row.reportVersionID, "filing reportVersionID"),
    registrantID,
    committeeName: requiredString(row.committeeName, "filing committeeName"),
    reportFileName: requiredString(row.reportFileName, "filing reportFileName"),
    reportFormType: requiredString(row.reportFormType, "filing reportFormType"),
    startDate, endDate,
    dueDate: filingDate(row.dueDate, "filing dueDate"),
    filedDate: filingDate(row.filedDate, "filing filedDate"),
    reportStatus, documentBarCode,
  };
}

export async function getAllWestVirginiaCurrentFilings(
  input: { orgID: number; pageSize?: number },
  options?: WestVirginiaCfrsClientOptions
): Promise<WestVirginiaCurrentFilingRow[]> {
  const orgID = requirePositiveInteger(input.orgID, "orgID");
  const pageSize = requirePageSize(input.pageSize);
  const rows = await getAllPages({
    pageSize,
    getPage: async (pageNumber) => {
      const envelope = await requestJsonEnvelope({
        baseUrl: WEST_VIRGINIA_CFRS_PUBLIC_SERVICE_BASE_URL,
        endpoint: "AccessReport/getAllFiledReportDataList",
        body: { orgID, pageNumber, pageSize, sortColumn: "filedDate", sortDirection: "desc" },
        options,
      });
      const data = objectValue(envelope.responseData, "current filings responseData");
      if (!Array.isArray(data.data)) {
        throw new WestVirginiaCfrsClientError("bad_response", "West Virginia CFRS current filings data must be an explicit array");
      }
      return parsePageEnvelope(envelope, (value) => {
        const row = objectValue(value, "current filing row");
        const rowOrgID = positiveResponseInteger(row.orgID, "filing orgID");
        if (rowOrgID !== orgID) {
          throw new WestVirginiaCfrsClientError("bad_response", "West Virginia CFRS current filing belongs to another orgID");
        }
        return { ...parseFilingHistoryRow(row), orgID: rowOrgID };
      });
    },
  });
  const seen = new Set<number>();
  for (const row of rows) {
    if (seen.has(row.reportID)) {
      throw new WestVirginiaCfrsClientError("bad_response", `Duplicate West Virginia CFRS current reportID: ${row.reportID}`);
    }
    seen.add(row.reportID);
  }
  return rows;
}

export async function getWestVirginiaFilingAmendmentHistory(
  reportID: number,
  options?: WestVirginiaCfrsClientOptions
): Promise<WestVirginiaFilingHistoryRow[]> {
  requirePositiveInteger(reportID, "reportID");
  const envelope = await requestJsonEnvelope({
    baseUrl: WEST_VIRGINIA_CFRS_PUBLIC_SERVICE_BASE_URL,
    endpoint: `AccessReport/getOrgFiledReportAmendHistory/${reportID}`,
    method: "GET", body: {}, options,
  });
  if (!Array.isArray(envelope.responseData)) {
    throw new WestVirginiaCfrsClientError("bad_response", "West Virginia CFRS filing history must be an explicit array");
  }
  const rows = envelope.responseData.map(parseFilingHistoryRow);
  const seen = new Set<number>();
  for (const row of rows) {
    if (row.reportID !== reportID || seen.has(row.reportVersionID)) {
      throw new WestVirginiaCfrsClientError("bad_response", "West Virginia CFRS filing history has mismatched or duplicate versions");
    }
    seen.add(row.reportVersionID);
  }
  return rows;
}

// --- transaction search -----------------------------------------------------

export type WestVirginiaTransactionRow = {
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
  employerName: string | null;
  employerOccupation: string | null;
  transactionTotalYTD: string | null;
  amendedFlag: boolean;
  reportVersionID: string | null;
  reportFileName: string | null;
  s3ReportFilePath: string | null;
  stanceDescription: string | null;
  candidateNameAssocation: string | null;
  ballotMeasureDescription: string | null;
  orgType: string | null;
  /** Target election year, independent of transaction year or spender registration. */
  electionYear?: number | null;
};

function parseTransactionRow(value: unknown): WestVirginiaTransactionRow {
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
    employerName: nullableString(row.employerName),
    employerOccupation: nullableString(row.employerOccupation),
    transactionTotalYTD: nullableString(row.transactionTotalYTD),
    amendedFlag: row.amendedFlag === true,
    reportVersionID: nullableString(row.reportVersionID),
    reportFileName: nullableString(row.reportFileName),
    s3ReportFilePath: nullableString(row.s3ReportFilePath),
    stanceDescription: nullableString(row.stanceDescription),
    candidateNameAssocation: nullableString(row.candidateNameAssocation),
    ballotMeasureDescription: nullableString(row.ballotMeasureDescription),
    orgType: nullableString(row.orgType),
    // Older/raw direct artifacts may omit this field. Invalid outside evidence
    // becomes unavailable; only the IE classifier requires a valid target year.
    electionYear:
      typeof row.electionYear === "number" && Number.isInteger(row.electionYear) &&
      row.electionYear >= 2000 && row.electionYear <= 2100 ? row.electionYear : null,
  };
}

export type WestVirginiaTransactionSearchInput = {
  orgTypeCode: string;
  transactionCategory?: "CON" | "EXP" | "IE";
  transactionYear?: number;
  orgName?: string;
  pageSize?: number;
};

export async function getAllWestVirginiaTransactions(
  input: WestVirginiaTransactionSearchInput,
  options?: WestVirginiaCfrsClientOptions
): Promise<WestVirginiaTransactionRow[]> {
  const orgTypeCode = input.orgTypeCode.trim();
  if (!/^\d{3}$/.test(orgTypeCode)) {
    throw new WestVirginiaCfrsClientError(
      "invalid_request",
      `West Virginia CFRS transaction search requires a 3-digit orgTypeCode, got: ${input.orgTypeCode}`
    );
  }
  const pageSize = requirePageSize(input.pageSize);
  const baseBody: Record<string, unknown> = {
    orgTypeCode,
    sortColumn: "transactionDate",
    sortDirection: "desc",
  };
  if (input.transactionCategory) baseBody.transactionCategory = input.transactionCategory;
  if (input.transactionYear !== undefined) {
    baseBody.transactionYear = String(requirePositiveInteger(input.transactionYear, "transactionYear"));
  }
  if (input.orgName?.trim()) baseBody.orgName = input.orgName.trim();

  return getAllPages({
    pageSize,
    getPage: async (pageNumber) => {
      const envelope = await requestJsonEnvelope({
        baseUrl: WEST_VIRGINIA_CFRS_PUBLIC_SERVICE_BASE_URL,
        endpoint: "CommitteeTransactions/getAllPublicTransactionDataList",
        body: { ...baseBody, pageNumber, pageSize },
        options,
      });
      if (input.transactionCategory === "IE") {
        const responseData = objectValue(envelope.responseData, "responseData");
        if (!Array.isArray(responseData.data)) {
          throw new WestVirginiaCfrsClientError(
            "bad_response",
            "West Virginia CFRS IE transaction search requires explicit array data, including empty results"
          );
        }
      }
      return parsePageEnvelope(envelope, parseTransactionRow);
    },
  });
}
