/** Georgia's native IE JSON passes and Windows-1252 contribution export need
 * original-packet replay, not the shared finance module's financial-row writer.
 * Only a fully revalidated immutable generation may replace the current pointer.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  createGeorgiaEthicsTransport,
  fetchGeorgiaIndependentExpenditureRows,
  GEORGIA_ETHICS_RECORDS_SEARCH_URL,
  type GeorgiaIndependentExpenditureRow,
} from "./georgiaEthicsClient.js";
import {
  parseGeorgiaReportedContributionExport,
  type GeorgiaReportedContributionExport,
} from "./georgiaReportedContributionExport.js";

export const DEFAULT_GEORGIA_REPORTED_FINANCE_CACHE_DIR = "scratch/georgia-reported-finance";
const IE_URL = "https://api-peachfile.ethics.ga.gov/api/PublicIndependentExpenditureDetails/GetIndependentExpenditureDetails";
const CSV_URL = "https://api-peachfile.ethics.ga.gov/api/ExportPublicData/GetExportPublicDownloadData";
const MIB = 1024 * 1024;
const IE_BYTES = 32 * MIB;
const IE_BODY_BYTES = 2 * MIB;
const CSV_BYTES = 160 * MIB;
const COMBINED_BYTES = 180 * MIB;
const CAPTURE_MS = 4 * 60_000;
const SAFE_ERROR = "Georgia reported finance source cache unavailable";
export const GEORGIA_REPORTED_FINANCE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
type Kind = "ie" | "contributions";
type Scope = { cacheDir?: string; filingYear: number; electionYear: number };
type RefreshScope = Omit<Scope, "cacheDir">;

export class GeorgiaReportedFinanceSourceCacheError extends Error {
  constructor(public readonly code: "unavailable" | "locked" | "invalid_scope" = "unavailable") {
    super(SAFE_ERROR);
    this.name = "GeorgiaReportedFinanceSourceCacheError";
  }
}
export type GeorgiaReportedSourceControl = {
  file: string;
  sha256: string;
  byteSize: number;
  startedAt: string;
  completedAt: string;
  status: number;
  contentType: string;
};
export type GeorgiaReportedSourceFacts = {
  filingYear: number;
  electionYear: number;
  sourceRetrievedAt: string;
  sourceCompletedAt: string;
  sourceUrl: string;
  sourceRowCount: number;
  sourceByteSize: number;
  sourceManifestSha256: string;
  sourceControls: readonly GeorgiaReportedSourceControl[];
};
export type GeorgiaReportedIeSource = GeorgiaReportedSourceFacts & {
  rows: readonly GeorgiaIndependentExpenditureRow[];
  nativeTotal: number;
  passCount: 2;
};
export type GeorgiaReportedContributionSource = GeorgiaReportedSourceFacts & GeorgiaReportedContributionExport;
type Capture = GeorgiaReportedSourceControl & { eof: true };
type Manifest = {
  version: 1;
  kind: Kind;
  filingYear: number;
  electionYear: number;
  sourceRowCount: number;
  nativeTotal: number | null;
  passCount: number | null;
  captures: Capture[];
};
type Pointer = { version: 1; generation: string; manifestSha256: string };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function unavailable(): never { throw new GeorgiaReportedFinanceSourceCacheError(); }
const isHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const isYear = (value: number) => Number.isInteger(value) && value >= 2026 && value <= 2100;
function scopePath(input: Scope, kind: Kind): string {
  if (!isYear(input.filingYear) || !isYear(input.electionYear)) {
    throw new GeorgiaReportedFinanceSourceCacheError("invalid_scope");
  }
  return join(resolve(input.cacheDir ?? DEFAULT_GEORGIA_REPORTED_FINANCE_CACHE_DIR), `${kind}-${input.filingYear}-${input.electionYear}`);
}
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory()) unavailable();
  await chmod(path, 0o700);
}
async function boundedFile(path: string, maximum: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum || stat.size < 1) unavailable();
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size || bytes.length > maximum) unavailable();
    return bytes;
  } finally { await handle.close(); }
}
function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
function validContentType(kind: Kind, contentType: unknown): contentType is string {
  if (typeof contentType !== "string" || contentType.length > 256) return false;
  return kind === "ie"
    ? /^application\/(?:[a-z0-9.+-]+\+)?json(?:;|$)/i.test(contentType)
    : /^(?:text\/csv|application\/(?:csv|octet-stream|vnd\.ms-excel))(?:;|$)/i.test(contentType);
}
function validTime(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
}
function validateManifest(value: unknown, input: Scope, kind: Kind): Manifest {
  const m = value as Manifest;
  if (!m || m.version !== 1 || m.kind !== kind || m.filingYear !== input.filingYear || m.electionYear !== input.electionYear
    || !Number.isSafeInteger(m.sourceRowCount) || m.sourceRowCount <= 0 || !Array.isArray(m.captures)
    || m.captures.length < 1 || m.captures.length > (kind === "ie" ? 64 : 1)
    || (kind === "ie" ? m.passCount !== 2 || m.nativeTotal !== m.sourceRowCount : m.passCount !== null || m.nativeTotal !== null)) unavailable();
  let bytes = 0;
  let previousCompleted = -Infinity;
  for (let i = 0; i < m.captures.length; i++) {
    const c = m.captures[i]!;
    if (!c || c.file !== `${String(i + 1).padStart(4, "0")}.raw` || !isHash(c.sha256) || c.status !== 200 || c.eof !== true
      || !Number.isSafeInteger(c.byteSize) || c.byteSize <= 0 || c.byteSize > (kind === "ie" ? IE_BODY_BYTES : CSV_BYTES)
      || !validContentType(kind, c.contentType) || !validTime(c.startedAt) || !validTime(c.completedAt)
      || Date.parse(c.completedAt) < Date.parse(c.startedAt) || Date.parse(c.startedAt) < previousCompleted) unavailable();
    previousCompleted = Date.parse(c.completedAt);
    bytes += c.byteSize;
  }
  if (bytes > (kind === "ie" ? IE_BYTES : CSV_BYTES)) unavailable();
  return m;
}

// Replay through the production client/transport. No network and no substitute
// row parser: native count authority is required here even though legacy callers
// may still accept responses that predate totalItems.
async function qualifyIe(originals: readonly Buffer[]) {
  let index = 0;
  let nativeTotal: number | null = null;
  const transport = createGeorgiaEthicsTransport({
    spacingMs: 0,
    maxAttempts: 1,
    fetch: async () => {
      const bytes = originals[index++];
      if (!bytes) return unavailable();
      const envelope = decodeJson(bytes) as { data?: { totalItems?: unknown } };
      const count = envelope?.data?.totalItems;
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0) unavailable();
      if (nativeTotal !== null && count !== nativeTotal) unavailable();
      nativeTotal = count;
      return { status: 200, body: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    },
  });
  const result = await fetchGeorgiaIndependentExpenditureRows(transport, "peachfile", { maxPasses: 2 });
  if (index !== originals.length || result.passCount !== 2 || result.rows.length !== nativeTotal) unavailable();
  return { rows: result.rows, nativeTotal: nativeTotal!, passCount: 2 as const };
}
async function readGeneration(input: Scope, kind: Kind, pointer: Pointer): Promise<GeorgiaReportedIeSource | GeorgiaReportedContributionSource> {
  if (!pointer || pointer.version !== 1 || !/^generation-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(pointer.generation)
    || !isHash(pointer.manifestSha256)) unavailable();
  const directory = join(scopePath(input, kind), pointer.generation);
  if (!(await lstat(directory)).isDirectory()) unavailable();
  const manifestBytes = await boundedFile(join(directory, "manifest.json"), 128 * 1024);
  if (hash(manifestBytes) !== pointer.manifestSha256) unavailable();
  const manifest = validateManifest(decodeJson(manifestBytes), input, kind);
  const originals: Buffer[] = [];
  for (const capture of manifest.captures) {
    const bytes = await boundedFile(join(directory, capture.file), kind === "ie" ? IE_BODY_BYTES : CSV_BYTES);
    if (bytes.length !== capture.byteSize || hash(bytes) !== capture.sha256) unavailable();
    originals.push(bytes);
  }
  const facts: GeorgiaReportedSourceFacts = {
    filingYear: input.filingYear, electionYear: input.electionYear,
    sourceRetrievedAt: manifest.captures[0]!.startedAt,
    sourceCompletedAt: manifest.captures.at(-1)!.completedAt,
    sourceUrl: GEORGIA_ETHICS_RECORDS_SEARCH_URL,
    sourceRowCount: manifest.sourceRowCount,
    sourceByteSize: manifest.captures.reduce((sum, c) => sum + c.byteSize, 0),
    sourceManifestSha256: pointer.manifestSha256,
    sourceControls: manifest.captures.map(({ eof: _eof, ...c }) => ({ ...c, file: `${pointer.generation}/${c.file}` })),
  };
  if (kind === "ie") {
    const result = await qualifyIe(originals);
    if (result.nativeTotal !== manifest.nativeTotal) unavailable();
    return { ...facts, ...result };
  }
  const result = parseGeorgiaReportedContributionExport({ bytes: originals[0]!, filingYear: input.filingYear, electionYear: input.electionYear });
  if (result.diagnostics.logicalRecordCount !== manifest.sourceRowCount) unavailable();
  return { ...facts, ...result };
}
async function readSource(input: Scope, kind: Kind) {
  try {
    const pointerPath = join(scopePath(input, kind), "current.json");
    // Only an absent pointer is unavailable-without-error. Missing originals,
    // manifests or malformed present pointers must not fall back to old packets.
    try { await lstat(pointerPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    const pointer = decodeJson(await boundedFile(pointerPath, 4096)) as Pointer;
    return await readGeneration(input, kind, pointer);
  } catch (error) {
    if (error instanceof GeorgiaReportedFinanceSourceCacheError) throw error;
    throw new GeorgiaReportedFinanceSourceCacheError();
  }
}
export async function readGeorgiaReportedIeSource(input: Scope): Promise<GeorgiaReportedIeSource | null> {
  return readSource(input, "ie") as Promise<GeorgiaReportedIeSource | null>;
}
export async function readGeorgiaReportedContributionSource(input: Scope): Promise<GeorgiaReportedContributionSource | null> {
  return readSource(input, "contributions") as Promise<GeorgiaReportedContributionSource | null>;
}

/** One producer shares pacing and the combined budget across both independent
 * refreshes. fetchImpl injects HTTP only for tests; no row/acceptance overrides.
 */
export function createGeorgiaReportedFinanceSourceProducer(input: { cacheDir?: string; fetchImpl?: typeof fetch } = {}) {
  let totalBytes = 0;
  let captureStart: number | null = null;
  let lastRequestStart = 0;
  let requestQueue: Promise<unknown> = Promise.resolve();
  const sourceFetch = input.fetchImpl ?? fetch;
  function request<T>(fn: () => Promise<T>): Promise<T> {
    const pending = requestQueue.then(async () => {
      const wait = 2000 - (Date.now() - lastRequestStart);
      if (wait > 0) await new Promise<void>(resolve => setTimeout(resolve, wait));
      captureStart ??= Date.now();
      if (Date.now() - captureStart >= CAPTURE_MS) unavailable();
      lastRequestStart = Date.now();
      return fn();
    });
    requestQueue = pending.catch(() => {});
    return pending;
  }
  async function refresh(scope: RefreshScope, kind: Kind) {
    const fullScope = { ...scope, cacheDir: input.cacheDir };
    const directory = scopePath(fullScope, kind);
    const root = resolve(input.cacheDir ?? DEFAULT_GEORGIA_REPORTED_FINANCE_CACHE_DIR);
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    const lockPath = join(root, `${kind}-${scope.filingYear}.lock`);
    try {
      await privateDirectory(root);
      try { lock = await open(lockPath, "wx", 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new GeorgiaReportedFinanceSourceCacheError("locked");
        throw error;
      }
      await privateDirectory(directory);
      const generation = `generation-${randomUUID()}`;
      const generationDirectory = join(directory, generation);
      await mkdir(generationDirectory, { mode: 0o700 });
      const captures: Capture[] = [];
      const originals: Buffer[] = [];
      let sourceBytes = 0;
      let sourceRequests = 0;
      const capture = (url: string, body: string) => request(async () => {
        if (url !== (kind === "ie" ? IE_URL : CSV_URL) || ++sourceRequests > (kind === "ie" ? 64 : 1)) unavailable();
        const startedAt = new Date().toISOString();
        const remaining = CAPTURE_MS - (Date.now() - captureStart!);
        if (remaining <= 0) unavailable();
        const response = await sourceFetch(url, {
          method: "POST", redirect: "manual",
          headers: { "Content-Type": "application/json", Accept: kind === "ie" ? "application/json" : "text/csv", "User-Agent": GEORGIA_REPORTED_FINANCE_USER_AGENT },
          body, signal: AbortSignal.timeout(Math.min(remaining, kind === "ie" ? 45_000 : 120_000)),
        });
        if (response.redirected || (response.url !== "" && response.url !== url)) unavailable();
        const reader = response.body?.getReader();
        if (!reader) unavailable();
        const chunks: Uint8Array[] = [];
        let byteSize = 0;
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            byteSize += next.value.byteLength;
            sourceBytes += next.value.byteLength;
            totalBytes += next.value.byteLength;
            if (byteSize > (kind === "ie" ? IE_BODY_BYTES : CSV_BYTES) ||
              sourceBytes > (kind === "ie" ? IE_BYTES : CSV_BYTES) || totalBytes > COMBINED_BYTES) unavailable();
            chunks.push(next.value);
          }
        } catch (error) { void reader.cancel().catch(() => {}); throw error; }
        const bytes = Buffer.concat(chunks);
        const completedAt = new Date().toISOString();
        const entry: Capture = { file: `${String(captures.length + 1).padStart(4, "0")}.raw`,
          byteSize, sha256: hash(bytes), startedAt, completedAt, status: response.status,
          contentType: response.headers.get("content-type") ?? "", eof: true };
        await writeFile(join(generationDirectory, entry.file), bytes, { mode: 0o600, flag: "wx" });
        captures.push(entry);
        originals.push(bytes);
        // Failed complete responses remain restricted originals with a safe
        // metadata journal; this journal can never authorize a financial read.
        await writeFile(join(generationDirectory, "capture-journal.json"), JSON.stringify({ captures }), { mode: 0o600 });
        const declaredLength = response.headers.get("content-length");
        // Fetch exposes decoded bytes; compressed Content-Length counts wire bytes.
        if (declaredLength !== null && !response.headers.get("content-encoding")
          && (!/^\d+$/.test(declaredLength) || Number(declaredLength) !== byteSize)) unavailable();
        if (response.status !== 200 || !validContentType(kind, entry.contentType) || byteSize === 0) unavailable();
        return bytes;
      });
      let sourceRowCount: number;
      let nativeTotal: number | null = null;
      let passCount: number | null = null;
      if (kind === "ie") {
        const transport = createGeorgiaEthicsTransport({ maxAttempts: 1,
          fetch: async (url, body) => ({ status: 200, body: new TextDecoder("utf-8", { fatal: true }).decode(await capture(url, body)) }),
        });
        await fetchGeorgiaIndependentExpenditureRows(transport, "peachfile", { maxPasses: 2 });
        const result = await qualifyIe(originals);
        sourceRowCount = result.rows.length; nativeTotal = result.nativeTotal; passCount = result.passCount;
      } else {
        const bytes = await capture(CSV_URL, JSON.stringify({ transactionTypeCode: "TCON", type: "CSV", filingYear: String(scope.filingYear) }));
        const result = parseGeorgiaReportedContributionExport({ bytes, ...scope });
        sourceRowCount = result.diagnostics.logicalRecordCount;
      }
      const manifest: Manifest = { version: 1, kind, ...scope, sourceRowCount, nativeTotal, passCount, captures };
      validateManifest(manifest, fullScope, kind);
      const manifestBytes = Buffer.from(JSON.stringify(manifest));
      await writeFile(join(generationDirectory, "manifest.json"), manifestBytes, { mode: 0o600, flag: "wx" });
      const pointer: Pointer = { version: 1, generation, manifestSha256: hash(manifestBytes) };
      // Re-read staged files, including every original hash and native parser,
      // before publishing. Prior committed generations are never deleted.
      const result = await readGeneration(fullScope, kind, pointer);
      const temporaryPointer = join(directory, `.${randomUUID()}.tmp`);
      await writeFile(temporaryPointer, JSON.stringify(pointer), { mode: 0o600, flag: "wx" });
      await rename(temporaryPointer, join(directory, "current.json"));
      return result;
    } catch (error) {
      if (error instanceof GeorgiaReportedFinanceSourceCacheError) throw error;
      throw new GeorgiaReportedFinanceSourceCacheError();
    } finally {
      // Cleanup after a committed rename must not turn success into a reported
      // failure. A failed unlink leaves a fail-closed lock for operator repair.
      if (lock) { await lock.close().catch(() => {}); await unlink(lockPath).catch(() => {}); }
    }
  }
  return {
    refreshIe: (scope: RefreshScope) => refresh(scope, "ie") as Promise<GeorgiaReportedIeSource>,
    refreshContributions: (scope: RefreshScope) => refresh(scope, "contributions") as Promise<GeorgiaReportedContributionSource>,
  };
}
