import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  captureMarylandPublicIndependentExpenditurePost,
  MarylandCurrentCycleExportError,
  type MarylandCurrentCycleCapture,
} from "./marylandCurrentCycleExportClient.js";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nil = "00000000-0000-0000-0000-000000000000";
type Scope = { electionCycle: string; pageNumber: number };
type Row = Readonly<Record<string, unknown>>;
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const fail = (): never => {
  throw new MarylandCurrentCycleExportError(
    "invalid_independent_expenditure_page",
  );
};
const guid = (v: unknown) =>
  typeof v === "string" && GUID.test(v) && v.toLowerCase() !== nil;
const positiveInteger = (v: unknown) =>
  Number.isSafeInteger(v) && (v as number) > 0;

/** Exact pristine statewide public filter. Undefined source filters stay absent. */
export function buildMarylandPublicIndependentExpenditureRequest(input: Scope) {
  if (
    !record(input) ||
    Reflect.ownKeys(input).length !== 2 ||
    !Object.hasOwn(input, "electionCycle") ||
    !Object.hasOwn(input, "pageNumber") ||
    typeof input.electionCycle !== "string" ||
    !/^[1-9]\d*$/.test(input.electionCycle) ||
    !Number.isSafeInteger(Number(input.electionCycle)) ||
    !positiveInteger(input.pageNumber)
  )
    throw new MarylandCurrentCycleExportError("invalid_request");
  return Object.freeze({
    filerName: null,
    candidateMeasure: null,
    stance: null,
    ReportType: null,
    payeeName: null,
    officeSought: null,
    electionCycle: input.electionCycle,
    purpose: null,
    filerType: null,
    accountStatus: null,
    toDate: null,
    fromDate: null,
    transactionCategory: null,
    electionYear: null,
    fundType: null,
    committeeStatusCode: null,
    pageNumber: input.pageNumber,
    pageSize: 100 as const,
    sortBy: "TransactionDate" as const,
    sortType: "desc" as const,
  });
}
export type MarylandPublicIndependentExpenditureRequest = ReturnType<
  typeof buildMarylandPublicIndependentExpenditureRequest
>;
export type MarylandPublicIndependentExpenditureCapture =
  MarylandCurrentCycleCapture<MarylandPublicIndependentExpenditureRequest>;

function checkedRequest(value: MarylandPublicIndependentExpenditureRequest) {
  if (!record(value))
    throw new MarylandCurrentCycleExportError("invalid_request");
  const expected = buildMarylandPublicIndependentExpenditureRequest({
    electionCycle: value.electionCycle,
    pageNumber: value.pageNumber,
  });
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== Object.keys(expected).length ||
    keys.some(
      (k) =>
        typeof k !== "string" ||
        !Object.hasOwn(expected, k) ||
        value[k as keyof typeof value] !== expected[k as keyof typeof expected],
    )
  )
    throw new MarylandCurrentCycleExportError("invalid_request");
  return expected;
}
function civilTimestamp(v: unknown): boolean {
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(v) ||
    v.startsWith("0000")
  )
    return false;
  const ms = Date.parse(`${v}Z`);
  if (!Number.isFinite(ms)) return false;
  return (
    new Date(ms).toISOString() ===
    `${v.slice(0, 19)}.${(v.split(".")[1] ?? "").padEnd(3, "0")}Z`
  );
}
function exactCents(v: unknown): boolean {
  if (typeof v !== "number" || !Number.isFinite(v)) return false;
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(v));
  if (!match) return false;
  const cents =
    (BigInt(match[2]!) * 100n + BigInt((match[3] ?? "").padEnd(2, "0"))) *
    (match[1] ? -1n : 1n);
  return (
    cents >= BigInt(Number.MIN_SAFE_INTEGER) &&
    cents <= BigInt(Number.MAX_SAFE_INTEGER) &&
    Math.round(v * 100) === Number(cents)
  );
}
/** Allocation identity, never parent-only identity. Editions remain distinct. */
function allocationEditionKey(row: Row): string {
  return JSON.stringify([
    String(row.candidateMeasureGuid).toLowerCase(),
    String(row.transactionGuid).toLowerCase(),
    row.transactionVersionID,
    String(row.reportGuId).toLowerCase(),
    row.reportVersionId,
  ]);
}
export function marylandPublicIndependentExpenditureOccurrenceKey(
  row: Row,
): string {
  return JSON.stringify([
    String(row.candidateMeasureGuid).toLowerCase(),
    String(row.transactionGuid).toLowerCase(),
    row.transactionVersionID,
    String(row.reportGuId).toLowerCase(),
    row.reportVersionId,
    row.candidateGuid === null ? null : String(row.candidateGuid).toLowerCase(),
  ]);
}
/** Transient private rows only; no currentness, role inference or financial acceptance. */
export function decodeMarylandPublicIndependentExpenditurePage(
  value: unknown,
  request: MarylandPublicIndependentExpenditureRequest,
) {
  const scope = checkedRequest(request);
  if (
    !record(value) ||
    value.succeeded !== true ||
    value.error !== null ||
    !record(value.data)
  )
    return fail();
  const data = value.data;
  if (
    !Number.isSafeInteger(data.totalItems) ||
    (data.totalItems as number) < 0 ||
    !Array.isArray(data.items) ||
    !Number.isSafeInteger(data.pageNumber) ||
    !Number.isSafeInteger(data.pageSize) ||
    !(
      (data.pageNumber === 0 && data.pageSize === 0) ||
      (data.pageNumber === scope.pageNumber && data.pageSize === 100)
    )
  )
    return fail();
  const totalItems = data.totalItems as number,
    offset = (scope.pageNumber - 1) * 100;
  if (
    !Number.isSafeInteger(offset) ||
    (scope.pageNumber > 1 && offset >= totalItems) ||
    data.items.length !== Math.min(100, Math.max(0, totalItems - offset))
  )
    return fail();
  const seen = new Set<string>(),
    editions = new Map<string, string>();
  const rows: Row[] = [];
  for (const raw of data.items) {
    if (
      !record(raw) ||
      ![
        raw.filerRegistrationGuid,
        raw.transactionGuid,
        raw.reportGuId,
        raw.candidateMeasureGuid,
      ].every(guid) ||
      !(raw.candidateGuid === null || guid(raw.candidateGuid)) ||
      !(
        raw.parentTransactionGuid === null || guid(raw.parentTransactionGuid)
      ) ||
      ![
        raw.transactionId,
        raw.transactionVersionID,
        raw.reportId,
        raw.reportVersionId,
        raw.filingEntityId,
        raw.electionCycleId,
      ].every(positiveInteger) ||
      String(raw.electionCycleId) !== scope.electionCycle ||
      !positiveInteger(raw.electionYear) ||
      (raw.electionYear as number) > 9999 ||
      ![raw.isCandidateActivity, raw.isActive, raw.isAmended].every(
        (v) => typeof v === "boolean",
      ) ||
      !exactCents(raw.amountApplied) ||
      !exactCents(raw.transactionAmount) ||
      ![raw.transactionDate, raw.filedDate, raw.createdDate].every(
        civilTimestamp,
      ) ||
      ![
        "committeeName",
        "committeeType",
        "committeeTypeCode",
        "candidateBallotIssueName",
        "position",
        "positionCode",
        "expenditureType",
        "expenditureTypeCode",
        "fundType",
        "fundTypeCode",
        "report",
        "reportTypeCode",
        "transactionStatusCode",
      ].every((k) => typeof raw[k] === "string" && (raw[k] as string).trim()) ||
      typeof raw.officeSought !== "string" ||
      !(raw.officeSoughtId === null || positiveInteger(raw.officeSoughtId))
    )
      return fail();
    const key = marylandPublicIndependentExpenditureOccurrenceKey(raw);
    const edition = allocationEditionKey(raw);
    if (
      seen.has(key) ||
      (editions.has(edition) && editions.get(edition) !== key)
    )
      return fail();
    seen.add(key);
    editions.set(edition, key);
    // JSON originals are detached from decoder callers, including unknown fields.
    rows.push(Object.freeze(structuredClone(raw)));
  }
  return Object.freeze({
    rows: Object.freeze(rows),
    totalItems,
    sourcePageNumber: data.pageNumber as number,
    sourcePageSize: data.pageSize as number,
  });
}

type PageOptions = Scope & {
  outputPath: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  onCapture?: (
    capture: MarylandPublicIndependentExpenditureCapture,
  ) => void | Promise<void>;
};
async function readPage(capture: MarylandPublicIndependentExpenditureCapture) {
  try {
    const bytes = await readFile(capture.outputPath);
    if (
      bytes.length !== capture.byteCount ||
      createHash("sha256").update(bytes).digest("hex") !== capture.sha256
    )
      return fail();
    return decodeMarylandPublicIndependentExpenditurePage(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      capture.requestBody,
    );
  } catch {
    throw new MarylandCurrentCycleExportError(
      "invalid_independent_expenditure_page",
      capture,
    );
  }
}
/** CLI-safe metadata only. The original response remains in its private file. */
export async function fetchMarylandPublicIndependentExpenditurePage(
  input: PageOptions,
) {
  const request = buildMarylandPublicIndependentExpenditureRequest({
    electionCycle: input.electionCycle,
    pageNumber: input.pageNumber,
  });
  const capture = await captureMarylandPublicIndependentExpenditurePost(
    request,
    input,
  );
  const page = await readPage(capture);
  return Object.freeze({
    capture,
    totalItems: page.totalItems,
    physicalCount: page.rows.length,
    sourcePageNumber: page.sourcePageNumber,
    sourcePageSize: page.sourcePageSize,
  });
}
export class MarylandPublicIndependentExpenditureCensusError extends Error {
  constructor(
    public readonly code:
      | "invalid_request"
      | "page_limit"
      | "count_drift"
      | "duplicate_occurrence"
      | "conflicting_allocation"
      | "total_byte_limit"
      | "census_timeout",
  ) {
    super(`Maryland native allocation census: ${code}`);
  }
}
/** Sequential complete observed census. No cache activation or financial verdict. */
export async function acquireMarylandPublicIndependentExpenditureCensus(
  input: Omit<PageOptions, "pageNumber" | "outputPath"> & {
    outputDirectory: string;
    maxPages?: number;
    maxTotalBytes?: number;
    totalTimeoutMs?: number;
    onProgress?: (facts: {
      completedPages: number;
      requestedPages: number;
      physicalRows: number;
      declaredRows: number;
    }) => void | Promise<void>;
  },
) {
  const scope = buildMarylandPublicIndependentExpenditureRequest({
    electionCycle: input.electionCycle,
    pageNumber: 1,
  });
  const maxPages = input.maxPages ?? 1500,
    maxTotalBytes = input.maxTotalBytes ?? 512 * 1024 * 1024,
    totalTimeoutMs = input.totalTimeoutMs ?? 60 * 60 * 1000,
    timeoutMs = input.timeoutMs ?? 30000,
    maxBytes = input.maxBytes ?? 4 * 1024 * 1024;
  const bad = (
    code: ConstructorParameters<
      typeof MarylandPublicIndependentExpenditureCensusError
    >[0],
  ): never => {
    throw new MarylandPublicIndependentExpenditureCensusError(code);
  };
  if (
    !positiveInteger(maxPages) ||
    maxPages > 1500 ||
    !positiveInteger(maxTotalBytes) ||
    maxTotalBytes > 1024 * 1024 * 1024 ||
    !positiveInteger(totalTimeoutMs) ||
    totalTimeoutMs > 60 * 60 * 1000 ||
    !positiveInteger(timeoutMs) ||
    timeoutMs > 30000 ||
    !positiveInteger(maxBytes) ||
    maxBytes > 4 * 1024 * 1024 ||
    typeof input.outputDirectory !== "string" ||
    !input.outputDirectory.trim()
  )
    bad("invalid_request");
  const fetchImpl = input.fetchImpl ?? fetch,
    observer = input.onCapture,
    progress = input.onProgress;
  const directory = resolve(input.outputDirectory);
  await mkdir(directory, { mode: 0o700 });
  const journalPath = join(directory, "captures.private.jsonl"),
    journal = await open(journalPath, "wx", 0o600);
  await journal.chmod(0o600);
  const startedAt = new Date().toISOString(),
    deadlineAt = performance.now() + totalTimeoutMs;
  const controller = new AbortController();
  let rejectDeadline!: (e: Error) => void;
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  void deadline.catch(() => {});
  const timer = setTimeout(() => {
    controller.abort();
    rejectDeadline(
      new MarylandPublicIndependentExpenditureCensusError("census_timeout"),
    );
  }, totalTimeoutMs);
  const remaining = () => Math.floor(deadlineAt - performance.now());
  const boundedFetch: typeof fetch = (url, init) =>
    fetchImpl(url, {
      ...init,
      signal: AbortSignal.any([
        controller.signal,
        ...(init?.signal ? [init.signal] : []),
      ]),
    });
  const identities = new Set<string>(),
    editions = new Map<string, string>();
  let declaredRows: number | undefined,
    requestedPages = 1,
    physicalRows = 0,
    completedPages = 0,
    capturedBytes = 0;
  try {
    for (let pageNumber = 1; pageNumber <= requestedPages; pageNumber++) {
      if (remaining() < 1) bad("census_timeout");
      if (capturedBytes >= maxTotalBytes) bad("total_byte_limit");
      const request = Object.freeze({ ...scope, pageNumber });
      const capture = await captureMarylandPublicIndependentExpenditurePost(
        request,
        {
          outputPath: join(
            directory,
            `page-${String(pageNumber).padStart(4, "0")}.original.json`,
          ),
          fetchImpl: boundedFetch,
          timeoutMs: Math.min(timeoutMs, remaining()),
          maxBytes: Math.min(maxBytes, maxTotalBytes - capturedBytes),
          onCapture: async (c) => {
            capturedBytes += c.byteCount;
            await Promise.race([
              Promise.resolve().then(async () => {
                await journal.appendFile(`${JSON.stringify(c)}\n`);
                await observer?.(c);
              }),
              deadline,
            ]);
          },
        },
      );
      const page = await readPage(capture);
      if (declaredRows === undefined) {
        declaredRows = page.totalItems;
        requestedPages = Math.max(1, Math.ceil(declaredRows / 100));
        if (requestedPages > maxPages) bad("page_limit");
      } else if (page.totalItems !== declaredRows) bad("count_drift");
      for (const row of page.rows) {
        const key = marylandPublicIndependentExpenditureOccurrenceKey(row);
        const edition = allocationEditionKey(row);
        if (identities.has(key)) bad("duplicate_occurrence");
        if (editions.has(edition) && editions.get(edition) !== key)
          bad("conflicting_allocation");
        identities.add(key);
        editions.set(edition, key);
      }
      physicalRows += page.rows.length;
      completedPages++;
      await Promise.race([
        Promise.resolve().then(() =>
          progress?.({
            completedPages,
            requestedPages,
            physicalRows,
            declaredRows: declaredRows!,
          }),
        ),
        deadline,
      ]);
      if (remaining() < 1) bad("census_timeout");
    }
    if (physicalRows !== declaredRows) bad("count_drift");
    await journal.sync();
    if (remaining() < 1) bad("census_timeout");
    return Object.freeze({
      outputDirectory: directory,
      journalPath,
      startedAt,
      completedAt: new Date().toISOString(),
      declaredRows,
      physicalRows,
      requestedPages,
      completedPages,
      capturedBytes,
    });
  } catch (error) {
    if (remaining() < 1 || controller.signal.aborted) bad("census_timeout");
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
    await journal.close();
  }
}
