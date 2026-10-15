import { createHash } from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  captureMarylandPublicCommitteePost,
  MarylandCurrentCycleExportError,
  type MarylandCurrentCycleCapture,
} from "./marylandCurrentCycleExportClient.js";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0;
const guid = (v: unknown) =>
  typeof v === "string" &&
  GUID.test(v) &&
  v.toLowerCase() !== "00000000-0000-0000-0000-000000000000";
export type MarylandCommitteeQuery =
  | { kind: "numeric"; filingEntityId: number }
  | { kind: "name"; committeeName: string };
type Scope = { query: MarylandCommitteeQuery; pageNumber: number };
/** Exact public all-status/type/year filter. Numeric input type is explicit. */
export function buildMarylandPublicCommitteeRequest(input: Scope) {
  if (
    !record(input) ||
    Reflect.ownKeys(input).length !== 2 ||
    !record(input.query) ||
    !integer(input.pageNumber)
  )
    throw new MarylandCurrentCycleExportError("invalid_request");
  const q = input.query;
  if (
    Reflect.ownKeys(q).length !== 2 ||
    (q.kind === "numeric"
      ? !integer(q.filingEntityId)
      : q.kind !== "name" ||
        typeof q.committeeName !== "string" ||
        !q.committeeName.trim()) ||
    Reflect.ownKeys(input).some((k) => k !== "query" && k !== "pageNumber") ||
    Reflect.ownKeys(q).some(
      (k) =>
        k !== "kind" &&
        k !== (q.kind === "numeric" ? "filingEntityId" : "committeeName"),
    )
  )
    throw new MarylandCurrentCycleExportError("invalid_request");
  return Object.freeze({
    pageNumber: input.pageNumber,
    pageSize: 100 as const,
    sortBy: "CommitteeName" as const,
    sortType: "asc" as const,
    filerName:
      q.kind === "numeric" ? String(q.filingEntityId) : q.committeeName,
    ...(q.kind === "numeric" ? { filingEntityId: q.filingEntityId } : {}),
    violation: null,
    officeSought: null,
    officeType: null,
    committeeType: null,
    chairPersonName: null,
    treasurerName: null,
    accountStatus: null,
    jurisdictionIsStateOrIsCounty: null,
    committeeMakingIE: null,
    jurisdictionId: null,
    districtTypeDesc: null,
    electionCycle: null,
    electionType: null,
    electionYear: null,
  });
}
export type MarylandPublicCommitteeRequest = ReturnType<
  typeof buildMarylandPublicCommitteeRequest
>;
export type MarylandPublicCommitteeCapture =
  MarylandCurrentCycleCapture<MarylandPublicCommitteeRequest>;
export function validateMarylandPublicCommitteeRequest(
  value: MarylandPublicCommitteeRequest,
) {
  if (!record(value))
    throw new MarylandCurrentCycleExportError("invalid_request");
  const expected = buildMarylandPublicCommitteeRequest({
    pageNumber: value.pageNumber,
    query: Object.hasOwn(value, "filingEntityId")
      ? { kind: "numeric", filingEntityId: value.filingEntityId! }
      : { kind: "name", committeeName: value.filerName },
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
const instant = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  !v.startsWith("0000") &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const fail = (): never => {
  throw new MarylandCurrentCycleExportError("invalid_committee_page");
};
export function marylandPublicCommitteeOccurrenceKey(
  row: Readonly<Record<string, unknown>>,
) {
  return JSON.stringify([
    String(row.filerRegistrationGuid).toLowerCase(),
    row.filingEntityId,
    String(row.registrationDocumentGuid).toLowerCase(),
  ]);
}
/** Complete physical source rows, not a selected current/legal edition. */
export function decodeMarylandPublicCommitteePage(
  value: unknown,
  request: MarylandPublicCommitteeRequest,
) {
  const scope = validateMarylandPublicCommitteeRequest(request);
  if (
    !record(value) ||
    value.succeeded !== true ||
    value.error !== null ||
    !record(value.data)
  )
    return fail();
  const d = value.data,
    offset = (scope.pageNumber - 1) * 100;
  if (
    !Number.isSafeInteger(d.totalItems) ||
    (d.totalItems as number) < 0 ||
    !Array.isArray(d.items) ||
    !Number.isSafeInteger(offset) ||
    (scope.pageNumber > 1 && offset >= (d.totalItems as number)) ||
    d.items.length !==
      Math.min(100, Math.max(0, (d.totalItems as number) - offset)) ||
    !(
      (d.pageNumber === 0 && d.pageSize === 0) ||
      (d.pageNumber === scope.pageNumber && d.pageSize === 100)
    )
  )
    return fail();
  const seen = new Set<string>();
  const rows: Readonly<Record<string, unknown>>[] = [];
  for (const row of d.items) {
    if (
      !record(row) ||
      ![row.filerRegistrationGuid, row.registrationDocumentGuid].every(guid) ||
      !integer(row.filingEntityId) ||
      (Object.hasOwn(scope, "filingEntityId") &&
        row.filingEntityId !== scope.filingEntityId) ||
      !integer(row.officeSoughtId) ||
      !integer(row.jurisdictionId) ||
      !integer(row.registrationYear) ||
      (row.registrationYear as number) > 9999 ||
      typeof row.isActive !== "boolean" ||
      ![
        "committeeName",
        "candidateName",
        "committeeType",
        "committeeTypeCode",
        "officeSought",
        "jurisdiction",
        "partyAffiliation",
        "accountStatus",
        "accountStatusCode",
        "electionYears",
        "electionCycleID",
        "electionTypeCodes",
        "elections",
      ].every((k) => typeof row[k] === "string") ||
      !(row.committeeName as string).trim() ||
      !(row.committeeTypeCode as string).trim() ||
      ![
        "registrationSubmittalDate",
        "registrationApprovalDate",
        "registrationTerminatedDate",
        "lastRegistrationAmendedDate",
      ].every((k) => row[k] === null || typeof row[k] === "string")
    )
      return fail();
    const key = marylandPublicCommitteeOccurrenceKey(row);
    if (seen.has(key)) return fail();
    seen.add(key);
    rows.push(Object.freeze(structuredClone(row)));
  }
  return Object.freeze({
    rows: Object.freeze(rows),
    totalItems: d.totalItems as number,
    sourcePageNumber: d.pageNumber as number,
    sourcePageSize: d.pageSize as number,
  });
}
type Options = Scope & {
  outputPath: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  onCapture?: (capture: MarylandPublicCommitteeCapture) => void | Promise<void>;
};
export async function readMarylandPublicCommitteeCapture(
  capture: MarylandPublicCommitteeCapture,
) {
  const expected = validateMarylandPublicCommitteeRequest(capture.requestBody);
  if (
    capture.url !==
      "https://api-campaignfinance.maryland.gov/api/PublicGrid/GetCommitteeList" ||
    capture.method !== "POST" ||
    capture.httpStatus !== 200 ||
    capture.bodyComplete !== true ||
    capture.errorCode !== null ||
    !integer(capture.byteCount) ||
    capture.byteCount > 4 * 1024 * 1024 ||
    !instant(capture.startedAt) ||
    !instant(capture.completedAt) ||
    Date.parse(capture.startedAt) > Date.parse(capture.completedAt)
  )
    return fail();
  try {
    const info = await stat(capture.outputPath);
    if (!info.isFile() || info.size !== capture.byteCount) return fail();
    const bytes = await readFile(capture.outputPath);
    if (
      bytes.length !== capture.byteCount ||
      createHash("sha256").update(bytes).digest("hex") !== capture.sha256
    )
      return fail();
    return decodeMarylandPublicCommitteePage(
      JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)),
      expected,
    );
  } catch {
    throw new MarylandCurrentCycleExportError(
      "invalid_committee_page",
      capture,
    );
  }
}
/** Safe result; source identities and contacts remain in the private original. */
export async function fetchMarylandPublicCommitteePage(input: Options) {
  const request = buildMarylandPublicCommitteeRequest({
    query: input.query,
    pageNumber: input.pageNumber,
  });
  const capture = await captureMarylandPublicCommitteePost(request, input);
  const page = await readMarylandPublicCommitteeCapture(capture);
  return Object.freeze({
    capture,
    totalItems: page.totalItems,
    physicalCount: page.rows.length,
    sourcePageNumber: page.sourcePageNumber,
    sourcePageSize: page.sourcePageSize,
  });
}
export class MarylandPublicCommitteeCensusError extends Error {
  constructor(
    public readonly code:
      | "invalid_request"
      | "page_limit"
      | "count_drift"
      | "duplicate_occurrence"
      | "conflicting_account"
      | "census_timeout"
      | "total_byte_limit",
  ) {
    super(`Maryland registration census: ${code}`);
  }
}
/** Finite numeric/literal-name search only. No full-state registry or financial verdict. */
export async function acquireMarylandPublicCommitteeCensus(
  input: Omit<Options, "pageNumber" | "outputPath"> & {
    outputDirectory: string;
    maxPages?: number;
    totalTimeoutMs?: number;
    maxTotalBytes?: number;
  },
) {
  const scope = buildMarylandPublicCommitteeRequest({
      query: input.query,
      pageNumber: 1,
    }),
    maxPages = input.maxPages ?? 40,
    totalTimeoutMs = input.totalTimeoutMs ?? 600000,
    maxTotalBytes = input.maxTotalBytes ?? 128 * 1024 * 1024,
    timeoutMs = input.timeoutMs ?? 30000,
    maxBytes = input.maxBytes ?? 4 * 1024 * 1024,
    fetchImpl = input.fetchImpl ?? fetch,
    observer = input.onCapture;
  const bad = (
    code: ConstructorParameters<typeof MarylandPublicCommitteeCensusError>[0],
  ): never => {
    throw new MarylandPublicCommitteeCensusError(code);
  };
  if (
    !integer(maxPages) ||
    maxPages > 40 ||
    !integer(totalTimeoutMs) ||
    totalTimeoutMs > 600000 ||
    !integer(maxTotalBytes) ||
    maxTotalBytes > 160 * 1024 * 1024 ||
    !integer(timeoutMs) ||
    timeoutMs > 30000 ||
    !integer(maxBytes) ||
    maxBytes > 4 * 1024 * 1024 ||
    typeof input.outputDirectory !== "string" ||
    !input.outputDirectory.trim()
  )
    bad("invalid_request");
  const directory = resolve(input.outputDirectory);
  await mkdir(directory, { mode: 0o700 });
  const journalPath = join(directory, "captures.private.jsonl"),
    journal = await open(journalPath, "wx", 0o600);
  await journal.chmod(0o600);
  const startedAt = new Date().toISOString(),
    end = performance.now() + totalTimeoutMs,
    controller = new AbortController();
  let reject!: (e: Error) => void;
  const deadline = new Promise<never>((_, r) => {
    reject = r;
  });
  void deadline.catch(() => {});
  const timer = setTimeout(() => {
    controller.abort();
    reject(new MarylandPublicCommitteeCensusError("census_timeout"));
  }, totalTimeoutMs);
  const boundedFetch: typeof fetch = (u, i) =>
    fetchImpl(u, {
      ...i,
      signal: AbortSignal.any([
        controller.signal,
        ...(i?.signal ? [i.signal] : []),
      ]),
    });
  let declaredRows: number | undefined,
    requestedPages = 1,
    completedPages = 0,
    physicalRows = 0,
    capturedBytes = 0;
  const ids = new Set<string>(),
    accounts = new Map<string, unknown>();
  try {
    for (let n = 1; n <= requestedPages; n++) {
      const remaining = Math.floor(end - performance.now());
      if (remaining < 1) bad("census_timeout");
      if (capturedBytes >= maxTotalBytes) bad("total_byte_limit");
      const capture = await captureMarylandPublicCommitteePost(
        Object.freeze({ ...scope, pageNumber: n }),
        {
          outputPath: join(
            directory,
            `page-${String(n).padStart(4, "0")}.original.json`,
          ),
          fetchImpl: boundedFetch,
          timeoutMs: Math.min(timeoutMs, remaining),
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
      const p = await readMarylandPublicCommitteeCapture(capture);
      if (declaredRows === undefined) {
        declaredRows = p.totalItems;
        requestedPages = Math.max(1, Math.ceil(declaredRows / 100));
        if (requestedPages > maxPages) bad("page_limit");
      } else if (p.totalItems !== declaredRows) bad("count_drift");
      for (const r of p.rows) {
        const key = marylandPublicCommitteeOccurrenceKey(r);
        if (ids.has(key)) bad("duplicate_occurrence");
        ids.add(key);
        const account = String(r.filerRegistrationGuid).toLowerCase();
        if (accounts.has(account) && accounts.get(account) !== r.filingEntityId)
          bad("conflicting_account");
        accounts.set(account, r.filingEntityId);
      }
      physicalRows += p.rows.length;
      completedPages++;
      if (performance.now() >= end) bad("census_timeout");
    }
    await journal.sync();
    if (performance.now() >= end) bad("census_timeout");
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
  } catch (e) {
    if (controller.signal.aborted || performance.now() >= end)
      bad("census_timeout");
    throw e;
  } finally {
    clearTimeout(timer);
    controller.abort();
    await journal.close();
  }
}
