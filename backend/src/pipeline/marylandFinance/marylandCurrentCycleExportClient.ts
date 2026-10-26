import { validateMarylandPublicCommitteeRequest, type MarylandPublicCommitteeRequest } from "./marylandPublicCommitteeClient.js";
import {
  buildMarylandPublicIndependentExpenditureRequest,
  type MarylandPublicIndependentExpenditureRequest,
} from "./marylandPublicIndependentExpenditureClient.js";
import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildMarylandPublicContributionRequest, type MarylandPublicContributionRequest } from "./marylandPublicContributionClient.js";
import {
  buildMarylandPublicReportInventoryRequest,
  validateMarylandPublishedReportPdfRequest,
  type MarylandPublicReportInventoryRequest,
  type MarylandPublishedReportPdfRequest,
} from "./marylandPublicReportClient.js";

const API = "https://api-campaignfinance.maryland.gov/api/";
const EXPORT_URL = `${API}ExportPublicData/GetExportPublicDownloadData`;
const CYCLES_URL = `${API}PublicLookup/GetAllFilingCycleList`;
const DEFAULT_EXPORT_BYTES = 384 * 1024 * 1024;
const MAX_EXPORT_BYTES = 1024 * 1024 * 1024;
const MAX_LOOKUP_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
const FORMATS = {
  contributions: { code: "TCOC", base: "Contributions and Loan Download" },
  expenditures: { code: "TEXC", base: "Expenditure Download Data" },
  committees: { code: "TCMC", base: "Committee Download" },
} as const;
export type MarylandCurrentCycleArtifactKind = keyof typeof FORMATS;
export type MarylandCurrentCycleExportRequest = Readonly<{
  filingYear: "0";
  transactionTypeCode: "TCOC" | "TEXC" | "TCMC";
  type: "CSV";
  fileName: string;
}>;
export type MarylandCurrentCycleExportErrorCode =
  | "invalid_request"
  | "output_exists"
  | "output_error"
  | "request_failed"
  | "timeout"
  | "body_limit"
  | "missing_body"
  | "http_status"
  | "body_read_failed"
  | "capture_callback_failed"
  | "invalid_cycle_lookup"
  | "invalid_committee_page"
  | "invalid_independent_expenditure_page"
  | "invalid_contribution_page"
  | "invalid_contribution_detail"
  | "invalid_report_inventory"
  | "invalid_report_document";
export type MarylandCurrentCycleCapture<
  T = MarylandCurrentCycleExportRequest | null,
  M extends "POST" | "GET" = "POST",
> = Readonly<{
  url: string;
  method: M;
  requestBody: T;
  outputPath: string;
  startedAt: string;
  completedAt: string;
  httpStatus: number | null;
  byteCount: number;
  sha256: string;
  bodyComplete: boolean;
  errorCode: MarylandCurrentCycleExportErrorCode | null;
}>;
export class MarylandCurrentCycleExportError extends Error {
  constructor(
    public readonly code: MarylandCurrentCycleExportErrorCode,
    public readonly capture?: MarylandCurrentCycleCapture<unknown, "POST" | "GET">,
  ) {
    super(`Maryland current-cycle source: ${code}`);
    this.name = "MarylandCurrentCycleExportError";
  }
}
type Options<T = MarylandCurrentCycleExportRequest | null, M extends "POST" | "GET" = "POST"> = {
  outputPath: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  onCapture?: (capture: MarylandCurrentCycleCapture<T, M>) => void | Promise<void>;
};

/** Exact observed Angular filename format, in this client's local timezone.
 * Its date is presentation only; it is neither a source cutoff nor cycle authority. */
export function buildMarylandCurrentCycleExportRequest(
  artifactKind: MarylandCurrentCycleArtifactKind,
  date = new Date(),
): MarylandCurrentCycleExportRequest {
  const format = FORMATS[artifactKind];
  if (
    !Object.hasOwn(FORMATS, artifactKind) ||
    !format ||
    !(date instanceof Date) ||
    !Number.isFinite(date.getTime())
  )
    throw new MarylandCurrentCycleExportError("invalid_request");
  const pad = (n: number) => String(n).padStart(2, "0");
  const hour = date.getHours();
  const local = `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${date.getFullYear()}, ${hour % 12 || 12}:${pad(date.getMinutes())} ${hour < 12 ? "AM" : "PM"}`;
  return Object.freeze({
    filingYear: "0",
    transactionTypeCode: format.code,
    type: "CSV",
    fileName: `${format.base}_${local}`,
  });
}

/** Writes a new private original, including partial/error bodies. It never
 * activates a cache, deletes a failed original, or overwrites an existing path. */
async function captureRequest<T extends Readonly<Record<string, unknown>> | null, M extends "POST" | "GET">(
  method: M,
  url: string,
  requestBody: T,
  options: Options<T, M>,
  defaultBytes: number,
  maximum: number,
): Promise<MarylandCurrentCycleCapture<T, M>> {
  const maxBytes = options.maxBytes ?? defaultBytes,
    timeoutMs = options.timeoutMs ?? TIMEOUT_MS,
    fetchImpl = options.fetchImpl ?? fetch,
    onCapture = options.onCapture;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > maximum ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > TIMEOUT_MS ||
    typeof options.outputPath !== "string" ||
    !options.outputPath.trim()
  )
    throw new MarylandCurrentCycleExportError("invalid_request");
  const outputPath = resolve(options.outputPath);
  let file;
  try {
    file = await open(outputPath, "wx", 0o600);
    await file.chmod(0o600);
  } catch (error) {
    if (file) await file.close().catch(() => {});
    const code = (error as NodeJS.ErrnoException).code;
    throw new MarylandCurrentCycleExportError(
      code === "EEXIST" ? "output_exists" : "output_error",
    );
  }
  const hash = createHash("sha256");
  let byteCount = 0,
    httpStatus: number | null = null,
    bodyComplete = false;
  let errorCode: MarylandCurrentCycleExportErrorCode | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let completedAt: string | undefined;
  const startedAt = new Date().toISOString(),
    controller = new AbortController();
  let timedOut = false;
  let stage: "request" | "read" | "write" | "sync" = "request";
  let rejectDeadline!: (error: MarylandCurrentCycleExportError) => void;
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    completedAt ??= new Date().toISOString();
    controller.abort();
    void reader?.cancel().catch(() => {});
    rejectDeadline(new MarylandCurrentCycleExportError("timeout"));
  }, timeoutMs);
  try {
    const response = await Promise.race([
      fetchImpl(url, {
        method,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          accept: "text/csv,application/json,*/*;q=0.1",
          "user-agent": "Mozilla/5.0",
        },
        ...(method === "POST" ? { body: JSON.stringify(requestBody) } : {}),
      }),
      deadline,
    ]);
    httpStatus = response.status;
    if (!response.body)
      throw new MarylandCurrentCycleExportError("missing_body");
    reader = response.body.getReader();
    while (true) {
      stage = "read";
      const item = await Promise.race([reader.read(), deadline]);
      if (timedOut) throw new MarylandCurrentCycleExportError("timeout");
      if (item.done) {
        bodyComplete = true;
        completedAt = new Date().toISOString();
        break;
      }
      if (!(item.value instanceof Uint8Array))
        throw new MarylandCurrentCycleExportError("body_read_failed");
      const chunk = new Uint8Array(item.value);
      const remaining = maxBytes - byteCount;
      const bytes = chunk.subarray(0, Math.max(0, remaining));
      let offset = 0;
      while (offset < bytes.byteLength) {
        stage = "write";
        const written = await file.write(
          bytes,
          offset,
          bytes.byteLength - offset,
        );
        if (!written.bytesWritten)
          throw new MarylandCurrentCycleExportError("output_error");
        hash.update(bytes.subarray(offset, offset + written.bytesWritten));
        byteCount += written.bytesWritten;
        offset += written.bytesWritten;
      }
      if (chunk.byteLength > remaining)
        throw new MarylandCurrentCycleExportError("body_limit");
    }
    clearTimeout(timer);
    stage = "sync";
    await file.sync();
    if (httpStatus < 200 || httpStatus >= 300) errorCode = "http_status";
  } catch (error) {
    errorCode =
      error instanceof MarylandCurrentCycleExportError
        ? error.code
        : timedOut
          ? "timeout"
          : stage === "request"
            ? "request_failed"
            : stage === "read"
              ? "body_read_failed"
              : "output_error";
    completedAt ??= new Date().toISOString();
    controller.abort();
    void reader?.cancel().catch(() => {});
  } finally {
    clearTimeout(timer);
    try {
      reader?.releaseLock();
    } catch {
      errorCode ??= "body_read_failed";
    }
    try {
      await file.close();
    } catch {
      errorCode ??= "output_error";
    }
  }
  const captured = Object.freeze({
    url,
    method,
    requestBody,
    outputPath,
    startedAt,
    completedAt: completedAt ?? new Date().toISOString(),
    httpStatus,
    byteCount,
    sha256: hash.digest("hex"),
    bodyComplete,
    errorCode,
  });
  try {
    await onCapture?.(captured);
  } catch {
    throw new MarylandCurrentCycleExportError(
      "capture_callback_failed",
      captured,
    );
  }
  if (errorCode) throw new MarylandCurrentCycleExportError(errorCode, captured);
  return captured;
}

function capturePost<T extends Readonly<Record<string, unknown>> | null>(
  url: string, requestBody: T, options: Options<T>, defaultBytes: number, maximum: number,
): Promise<MarylandCurrentCycleCapture<T>> {
  return captureRequest("POST", url, requestBody, options, defaultBytes, maximum);
}

/** Closed official authorities; no arbitrary URL, account selector or form body. */
export async function captureMarylandPublishedGovernorContextGet(
  kind: "general_roster" | "election_dates",
  options: Options<null, "GET">,
): Promise<MarylandCurrentCycleCapture<null, "GET">> {
  const urls = {
    general_roster: "https://elections.maryland.gov/elections/2026/general_candidates/2026_GG_statewide_candidatelist.html",
    election_dates: "https://elections.maryland.gov/candidacy/ballot.html",
  } as const;
  if (typeof kind !== "string" || !Object.hasOwn(urls, kind) || (options.timeoutMs ?? 30_000) > 30_000)
    throw new MarylandCurrentCycleExportError("invalid_request");
  return captureRequest("GET", urls[kind], null, { ...options, timeoutMs: options.timeoutMs ?? 30_000 },
    MAX_LOOKUP_BYTES, MAX_LOOKUP_BYTES);
}

export function downloadMarylandCurrentCycleExport(
  input: Options & { artifactKind: MarylandCurrentCycleArtifactKind },
): Promise<MarylandCurrentCycleCapture<MarylandCurrentCycleExportRequest>> {
  return capturePost(
    EXPORT_URL,
    buildMarylandCurrentCycleExportRequest(input.artifactKind),
    input,
    DEFAULT_EXPORT_BYTES,
    MAX_EXPORT_BYTES,
  );
}

/** Closed public endpoint; shared original-byte transport, no arbitrary URL. */
export function captureMarylandPublicContributionPost(
  request: MarylandPublicContributionRequest,
  options: Options<MarylandPublicContributionRequest>,
): Promise<MarylandCurrentCycleCapture<MarylandPublicContributionRequest>> {
  if (!request || typeof request !== "object" || Array.isArray(request))
    throw new MarylandCurrentCycleExportError("invalid_request");
  const keys = Reflect.ownKeys(request);
  const snapshot = { ...request };
  const detached = buildMarylandPublicContributionRequest({
    filerRegistrationGuid: snapshot.filerRegistrationGuid,
    electionCycle: snapshot.electionCycle,
    pageNumber: snapshot.pageNumber,
    pageSize: snapshot.pageSize,
    isReturn: snapshot.isReturn,
    sortType: snapshot.sortType,
    fromDate: snapshot.fromDate,
    toDate: snapshot.toDate,
  });
  if (keys.length !== Object.keys(detached).length || keys.some(key =>
    typeof key !== "string" || !Object.hasOwn(detached, key) ||
    snapshot[key as keyof typeof snapshot] !== detached[key as keyof typeof detached]))
    throw new MarylandCurrentCycleExportError("invalid_request");
  if ((options.timeoutMs ?? 30_000) > 30_000)
    throw new MarylandCurrentCycleExportError("invalid_request");
  return capturePost(
    `${API}PublicGrid/GetContributionList`,
    detached,
    { ...options, timeoutMs: options.timeoutMs ?? 30_000 },
    MAX_LOOKUP_BYTES,
    MAX_LOOKUP_BYTES,
  );
}

export function buildMarylandPublicContributionDetailRequest(transactionGuid: string) {
  if (typeof transactionGuid !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(transactionGuid) ||
    transactionGuid === "00000000-0000-0000-0000-000000000000")
    throw new MarylandCurrentCycleExportError("invalid_request");
  return Object.freeze({transactionGuid, transactionTypeCode: "TCON" as const});
}
export type MarylandPublicContributionDetailRequest = ReturnType<typeof buildMarylandPublicContributionDetailRequest>;
/** Exact published contribution popup request. A numeric parent ID is never
 * converted to a GUID or transmitted under a guessed alternate endpoint. */
export function captureMarylandPublicContributionDetailPost(
  request: MarylandPublicContributionDetailRequest,
  options: Options<MarylandPublicContributionDetailRequest>,
) {
  if (!request || typeof request !== "object" || Array.isArray(request))
    throw new MarylandCurrentCycleExportError("invalid_request");
  const keys = Reflect.ownKeys(request), snapshot = {...request};
  const detached = buildMarylandPublicContributionDetailRequest(snapshot.transactionGuid);
  if (keys.length !== 2 || keys.some(key => typeof key !== "string" ||
    !Object.hasOwn(detached, key) || snapshot[key as keyof typeof snapshot] !== detached[key as keyof typeof detached]) ||
    (options.timeoutMs ?? 30_000) > 30_000)
    throw new MarylandCurrentCycleExportError("invalid_request");
  return capturePost(`${API}PublicTransactionDetails/GetTransactionDetailsByGuid`, detached,
    {...options, timeoutMs: options.timeoutMs ?? 30_000}, MAX_LOOKUP_BYTES, MAX_LOOKUP_BYTES);
}

/** The public IE popup uses the combined TIECOM parent role. TIEXP versus
 * TECOM belongs to the returned subtype; neither this request nor the filer
 * class qualifies an amount as independent spending. */
export function buildMarylandPublicOutsideDetailRequest(transactionGuid: string) {
  if (typeof transactionGuid !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(transactionGuid) ||
    transactionGuid === "00000000-0000-0000-0000-000000000000")
    throw new MarylandCurrentCycleExportError("invalid_request");
  return Object.freeze({ transactionGuid, transactionTypeCode: "TIECOM" as const });
}
export type MarylandPublicOutsideDetailRequest = ReturnType<typeof buildMarylandPublicOutsideDetailRequest>;

export function buildMarylandPublicOutsideReturnedChildrenRequest(input: {
  transactionGuid: string; transactionId: number; pageNumber: number;
}) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
    Reflect.ownKeys(input).length !== 3 ||
    Reflect.ownKeys(input).some(k => !["transactionGuid", "transactionId", "pageNumber"].includes(String(k))) ||
    !Number.isSafeInteger(input.transactionId) || input.transactionId < 1 ||
    !Number.isSafeInteger(input.pageNumber) || input.pageNumber < 1)
    throw new MarylandCurrentCycleExportError("invalid_request");
  const parent = buildMarylandPublicOutsideDetailRequest(input.transactionGuid);
  // Current default popup page is1/10. Its optional sort values are undefined,
  // so normal JSON omits them; empty strings are not substituted.
  return Object.freeze({ pageNumber: input.pageNumber, pageSize: 10 as const,
    transactionID: input.transactionId, transactionType: "TIECOM" as const,
    transactionGuid: parent.transactionGuid });
}
export type MarylandPublicOutsideReturnedChildrenRequest = ReturnType<typeof buildMarylandPublicOutsideReturnedChildrenRequest>;

function sameOutsideRequest(value: unknown, expected: Readonly<Record<string, unknown>>) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value), row = value as Record<string, unknown>;
  return keys.length === Object.keys(expected).length && keys.every(k =>
    typeof k === "string" && Object.hasOwn(expected, k) && row[k] === expected[k]);
}
export function captureMarylandPublicOutsideDetailPost(
  request: MarylandPublicOutsideDetailRequest, options: Options<MarylandPublicOutsideDetailRequest>,
) {
  if (!request || typeof request !== "object" || Array.isArray(request))
    throw new MarylandCurrentCycleExportError("invalid_request");
  const detached = buildMarylandPublicOutsideDetailRequest(request.transactionGuid);
  if (!sameOutsideRequest(request, detached) || (options.timeoutMs ?? 30_000) > 30_000)
    throw new MarylandCurrentCycleExportError("invalid_request");
  return capturePost(`${API}PublicTransactionDetails/GetTransactionDetailsByGuid`, detached,
    { ...options, timeoutMs: options.timeoutMs ?? 30_000 }, MAX_LOOKUP_BYTES, MAX_LOOKUP_BYTES);
}
export function captureMarylandPublicOutsideReturnedChildrenPost(
  request: MarylandPublicOutsideReturnedChildrenRequest,
  options: Options<MarylandPublicOutsideReturnedChildrenRequest>,
) {
  if (!request || typeof request !== "object" || Array.isArray(request))
    throw new MarylandCurrentCycleExportError("invalid_request");
  const detached = buildMarylandPublicOutsideReturnedChildrenRequest({
    transactionGuid: request.transactionGuid, transactionId: request.transactionID,
    pageNumber: request.pageNumber,
  });
  if (!sameOutsideRequest(request, detached) || (options.timeoutMs ?? 30_000) > 30_000)
    throw new MarylandCurrentCycleExportError("invalid_request");
  return capturePost(`${API}PublicTransactionDetails/GetChildTransactionDetails`, detached,
    { ...options, timeoutMs: options.timeoutMs ?? 30_000 }, MAX_LOOKUP_BYTES, MAX_LOOKUP_BYTES);
}

export function captureMarylandPublicReportInventoryPost(
  request: MarylandPublicReportInventoryRequest,
  options: Options<MarylandPublicReportInventoryRequest>,
) {
  if (!request || typeof request !== "object" || Array.isArray(request))
    throw new MarylandCurrentCycleExportError("invalid_request");
  const keys = Reflect.ownKeys(request), snapshot = { ...request };
  const detached = buildMarylandPublicReportInventoryRequest(snapshot);
  if (keys.length !== Object.keys(detached).length || keys.some(key => typeof key !== "string" ||
    !Object.hasOwn(detached, key) || snapshot[key as keyof typeof snapshot] !== detached[key as keyof typeof detached]) ||
    (options.timeoutMs ?? 30_000) > 30_000)
    throw new MarylandCurrentCycleExportError("invalid_request");
  return capturePost(`${API}PublicFilerDetails/GetCfPublicProfileFiling`, detached,
    { ...options, timeoutMs: options.timeoutMs ?? 30_000 }, MAX_LOOKUP_BYTES, MAX_LOOKUP_BYTES);
}

export function captureMarylandPublishedReportPdfPost(
  request: MarylandPublishedReportPdfRequest,
  options: Options<MarylandPublishedReportPdfRequest>,
) {
  return capturePost(`${API}PublicFiledReportAndDownload/DownloadDocument`,
    validateMarylandPublishedReportPdfRequest(request), { ...options }, 64 * 1024 * 1024, 64 * 1024 * 1024);
}

export type MarylandPublishedFilingCycle = Readonly<{
  value: string;
  name: string;
  isDefault: boolean;
}>;
/** A literal public lookup fact, not a financial-currentness or election match. */
export function decodeMarylandPublishedFilingCycles(value: unknown): {
  cycles: readonly MarylandPublishedFilingCycle[];
  defaultCycle: MarylandPublishedFilingCycle;
} {
  const fail = (): never => {
    throw new MarylandCurrentCycleExportError("invalid_cycle_lookup");
  };
  if (!value || typeof value !== "object") return fail();
  const envelope = value as Record<string, unknown>;
  if (
    envelope.succeeded !== true ||
    envelope.error !== null ||
    !Array.isArray(envelope.data) ||
    !envelope.data.length
  )
    return fail();
  const seen = new Set<string>();
  const cycles = envelope.data.map((raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
    const row = raw as Record<string, unknown>;
    const years =
      typeof row.name === "string" ? /^(\d{4})-(\d{4})$/.exec(row.name) : null;
    if (
      typeof row.value !== "string" ||
      !/^[1-9]\d*$/.test(row.value) ||
      seen.has(row.value) ||
      !years ||
      Number(years[1]) < 1 ||
      Number(years[2]) < Number(years[1]) ||
      typeof row.isDefault !== "boolean"
    )
      return fail();
    seen.add(row.value);
    return Object.freeze({
      value: row.value,
      name: row.name as string,
      isDefault: row.isDefault,
    });
  });
  const defaults = cycles.filter((row) => row.isDefault);
  if (defaults.length !== 1) return fail();
  return Object.freeze({
    cycles: Object.freeze(cycles),
    defaultCycle: defaults[0]!,
  });
}
export async function getMarylandCurrentFilingCycles(input: Options): Promise<{
  capture: MarylandCurrentCycleCapture<null>;
  cycles: readonly MarylandPublishedFilingCycle[];
  defaultCycle: MarylandPublishedFilingCycle;
}> {
  const capture = await capturePost(
    CYCLES_URL,
    null,
    input,
    MAX_LOOKUP_BYTES,
    MAX_LOOKUP_BYTES,
  );
  try {
    const raw = await readFile(capture.outputPath);
    if (
      raw.byteLength !== capture.byteCount ||
      createHash("sha256").update(raw).digest("hex") !== capture.sha256
    )
      throw new Error("changed original");
    const decoded = decodeMarylandPublishedFilingCycles(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
    );
    return Object.freeze({ capture, ...decoded });
  } catch {
    throw new MarylandCurrentCycleExportError("invalid_cycle_lookup", capture);
  }
}

/** Closed exact statewide allocation route; no owner or additional filters. */
export function captureMarylandPublicIndependentExpenditurePost(
  request: MarylandPublicIndependentExpenditureRequest,
  options: Options<MarylandPublicIndependentExpenditureRequest>,
) {
  if (!request || typeof request !== "object" || Array.isArray(request))
    throw new MarylandCurrentCycleExportError("invalid_request");
  const keys = Reflect.ownKeys(request), snapshot = { ...request };
  const detached = buildMarylandPublicIndependentExpenditureRequest({
    electionCycle: snapshot.electionCycle,
    pageNumber: snapshot.pageNumber,
  });
  if (
    keys.length !== Object.keys(detached).length ||
    keys.some(key => typeof key !== "string" || !Object.hasOwn(detached, key) ||
      snapshot[key as keyof typeof snapshot] !== detached[key as keyof typeof detached]) ||
    (options.timeoutMs ?? 30_000) > 30_000
  ) throw new MarylandCurrentCycleExportError("invalid_request");
  return capturePost(
    `${API}PublicGrid/GetIndependentExpenditureList`,
    detached,
    { ...options, timeoutMs: options.timeoutMs ?? 30_000 },
    MAX_LOOKUP_BYTES,
    MAX_LOOKUP_BYTES,
  );
}

/** Exact all-status numeric or literal-name public registration route. */
export function captureMarylandPublicCommitteePost(request: MarylandPublicCommitteeRequest, options: Options<MarylandPublicCommitteeRequest>) {
  const detached = validateMarylandPublicCommitteeRequest(request);
  if ((options.timeoutMs ?? 30_000) > 30_000) throw new MarylandCurrentCycleExportError("invalid_request");
  return capturePost(`${API}PublicGrid/GetCommitteeList`, detached, { ...options, timeoutMs: options.timeoutMs ?? 30_000 }, MAX_LOOKUP_BYTES, MAX_LOOKUP_BYTES);
}
