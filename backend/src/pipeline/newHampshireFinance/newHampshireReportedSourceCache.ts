import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { downloadNewHampshirePublicJson, NEW_HAMPSHIRE_CFS_API_BASE_URL, NEW_HAMPSHIRE_CFS_ENDPOINTS } from "./newHampshireCfsClient.js";
import { acquireNewHampshireReportedBase, acquireNewHampshireReportedIe, acquireNewHampshireReportedReceipts,
  nhSourceHold, nhSourceInteger, nhSourceObject, NewHampshireReportedSourceError,
  type NewHampshireNativeRequest, type NewHampshireReportedBase, type NewHampshireReportedRows,
  type NewHampshireSourceRequest } from "./newHampshireReportedSourceGraph.js";

export const DEFAULT_NEW_HAMPSHIRE_REPORTED_CACHE_DIR = "scratch/new-hampshire-campaign-finance/reported";
export const NEW_HAMPSHIRE_REPORTED_SOURCE_URL = "https://cfs.sos.nh.gov/";
type Kind = "base" | "committee" | "ie";
export type NewHampshireSourceReference = { manifest: string; sha256: string };
export type NewHampshireSourceControl = {
  file: string; sha256: string; byteSize: number; status: number; eof: true;
  contentType: string; startedAt: string; completedAt: string;
};
type RecordCapture = { request: NewHampshireNativeRequest; control: NewHampshireSourceControl; responseUrl: string };
type Scope = { kind: Kind; electionYear: number; filingEntityId?: number; base?: NewHampshireSourceReference };
type Manifest = { version: 1; scope: Scope; outcome: "qualified" | "held"; records: RecordCapture[]; heldReason?: string };
export type NewHampshireBasePacket = NewHampshireReportedBase & {
  reference: NewHampshireSourceReference; controls: NewHampshireSourceControl[];
};
export type NewHampshireReportedSourcePacket = NewHampshireReportedRows & {
  kind: "committee" | "ie"; electionYear: number; filingEntityId: number | null;
  base: NewHampshireBasePacket; reference: NewHampshireSourceReference;
  sourceUrl: string; sourceRetrievedAt: string; sourceCompletedAt: string;
  sourceBaseRetrievedAt: string; sourceManifestSha256: string; sourceByteSize: number;
  sourceControls: NewHampshireSourceControl[];
};
const verifiedPackets = new WeakSet<object>();
function immutable<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) immutable(child);
  }
  return Object.freeze(value);
}
/** Financial aggregation accepts only an unchanged packet produced by a
 * full original-byte cache replay in this process. */
export function isVerifiedNewHampshireReportedSource(value: unknown): value is NewHampshireReportedSourcePacket {
  return !!value && typeof value === "object" && verifiedPackets.has(value);
}
const GENERATION = /^generation-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_RESPONSE = 32 * 1024 * 1024;
function year(n: number): number {
  if (!Number.isSafeInteger(n) || n < 2016 || n > 2100) nhSourceHold("invalid_cache_year");
  return n;
}
function iso(v: unknown): v is string {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
}
function canonical(v: unknown): string {
  const order = (x: unknown): unknown => Array.isArray(x) ? x.map(order) : x && typeof x === "object"
    ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)).map(([k, y]) => [k, order(y)])) : x;
  return JSON.stringify(order(v));
}
function pointerName(scope: Scope): string {
  year(scope.electionYear);
  return `${scope.kind}-${scope.electionYear}${scope.kind === "committee" ? `-${nhSourceInteger(scope.filingEntityId)}` : ""}.latest.json`;
}
async function privateDirectory(path: string): Promise<void> {
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o700) nhSourceHold("unsafe_cache_directory");
}
async function privateBytes(path: string, maximum: number): Promise<Buffer> {
  const st = await lstat(path);
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o600 || st.size === 0 || st.size > maximum) nhSourceHold("unsafe_cache_file");
  const bytes = await readFile(path);
  if (bytes.length !== st.size) nhSourceHold("cache_file_changed");
  return bytes;
}
function json(bytes: Uint8Array) {
  try { return nhSourceObject(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
  catch (e) { if (e instanceof NewHampshireReportedSourceError) throw e; return nhSourceHold("invalid_cache_json"); }
}
function reference(value: unknown): NewHampshireSourceReference {
  const r = nhSourceObject(value);
  if (typeof r.manifest !== "string" || typeof r.sha256 !== "string" || !HASH.test(r.sha256)) nhSourceHold("invalid_cache_reference");
  const [generation, filename, extra] = r.manifest.split("/");
  if (!generation || !GENERATION.test(generation) || filename !== "manifest.json" || extra !== undefined) nhSourceHold("invalid_cache_reference");
  return { manifest: r.manifest, sha256: r.sha256 };
}
async function pointer(root: string, scope: Scope): Promise<NewHampshireSourceReference | null> {
  try {
    await privateDirectory(root);
    return reference(json(await privateBytes(resolve(root, pointerName(scope)), 4096)));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
async function loaded(root: string, ref: NewHampshireSourceReference, expected: Pick<Scope, "kind" | "electionYear" | "filingEntityId">) {
  ref = reference(ref); await privateDirectory(root);
  const generation = ref.manifest.split("/")[0]!;
  await privateDirectory(resolve(root, generation));
  const bytes = await privateBytes(resolve(root, ref.manifest), 4 * 1024 * 1024);
  if (hash(bytes) !== ref.sha256) nhSourceHold("manifest_hash_mismatch");
  const m = json(bytes);
  const scope = nhSourceObject(m.scope);
  if (m.version !== 1 || m.outcome !== "qualified" || scope.kind !== expected.kind || scope.electionYear !== expected.electionYear ||
    scope.filingEntityId !== expected.filingEntityId || !Array.isArray(m.records) || m.records.length === 0 || m.records.length > 400) nhSourceHold("cache_scope_mismatch");
  const records = m.records as RecordCapture[];
  let index = 0, previous = -Infinity, bytesTotal = 0;
  const controls: NewHampshireSourceControl[] = [];
  const request: NewHampshireSourceRequest = async wanted => {
    const record = records[index++];
    if (!record || canonical(record.request) !== canonical(wanted)) nhSourceHold("request_replay_mismatch");
    const c = record.control;
    if (!c || c.file !== `${generation}/${String(index).padStart(4, "0")}.raw` || !HASH.test(c.sha256) ||
      !Number.isSafeInteger(c.byteSize) || c.byteSize < 1 || c.byteSize > MAX_RESPONSE || c.status !== 200 || c.eof !== true ||
      !iso(c.startedAt) || !iso(c.completedAt) || Date.parse(c.startedAt) < previous || Date.parse(c.completedAt) < Date.parse(c.startedAt) ||
      Date.parse(c.completedAt) > Date.now() || typeof c.contentType !== "string" || !/^application\/json(?:;|$)/i.test(c.contentType) ||
      record.responseUrl !== `${NEW_HAMPSHIRE_CFS_API_BASE_URL}/${NEW_HAMPSHIRE_CFS_ENDPOINTS[wanted.endpoint]}`) nhSourceHold("invalid_capture_control");
    previous = Date.parse(c.completedAt); bytesTotal += c.byteSize;
    if (bytesTotal > MAX_BYTES) nhSourceHold("cache_byte_budget");
    const raw = await privateBytes(resolve(root, c.file), MAX_RESPONSE);
    if (raw.length !== c.byteSize || hash(raw) !== c.sha256) nhSourceHold("original_hash_mismatch");
    controls.push(c);
    return { envelope: json(raw), sha256: c.sha256 };
  };
  return { manifest: m as unknown as Manifest, request, controls,
    finish() { if (index !== records.length) nhSourceHold("unconsumed_capture_records"); } };
}
async function readBaseReference(root: string, ref: NewHampshireSourceReference, electionYear: number): Promise<NewHampshireBasePacket> {
  const source = await loaded(root, ref, { kind: "base", electionYear });
  if (source.manifest.scope.base !== undefined) nhSourceHold("invalid_base_reference");
  const base = await acquireNewHampshireReportedBase(source.request, electionYear); source.finish();
  return { ...base, reference: ref, controls: source.controls };
}
export async function readNewHampshireReportedBase(input: { cacheDir?: string; electionYear: number }): Promise<NewHampshireBasePacket | null> {
  try {
    const root = resolve(input.cacheDir ?? DEFAULT_NEW_HAMPSHIRE_REPORTED_CACHE_DIR);
    const ref = await pointer(root, { kind: "base", electionYear: input.electionYear });
    return ref ? await readBaseReference(root, ref, input.electionYear) : null;
  } catch (error) {
    if (error instanceof NewHampshireReportedSourceError) throw error;
    return nhSourceHold("cache_io_unavailable");
  }
}

/** Scheduling hint only. Money still requires full original-byte replay. */
export async function readNewHampshireReportedSourceHint(input: {
  cacheDir?: string; kind: "committee" | "ie"; electionYear: number; filingEntityId?: number;
}): Promise<{ manifestSha256: string; retrievedAt: string } | null> {
  try {
    const root = resolve(input.cacheDir ?? DEFAULT_NEW_HAMPSHIRE_REPORTED_CACHE_DIR);
    const scope = { kind: input.kind, electionYear: input.electionYear,
      ...(input.kind === "committee" ? { filingEntityId: nhSourceInteger(input.filingEntityId) } : {}) };
    const ref = await pointer(root, scope);
    if (!ref) return null;
    const source = await loaded(root, ref, scope);
    const control = source.manifest.records[0]?.control;
    if (!control || !iso(control.startedAt) || Date.parse(control.startedAt) > Date.now()) nhSourceHold("invalid_cache_hint");
    return { manifestSha256: ref.sha256, retrievedAt: control.startedAt };
  } catch (error) {
    if (error instanceof NewHampshireReportedSourceError) throw error;
    return nhSourceHold("cache_io_unavailable");
  }
}
export async function readNewHampshireReportedSource(input: {
  cacheDir?: string; kind: "committee" | "ie"; electionYear: number; filingEntityId?: number;
}): Promise<NewHampshireReportedSourcePacket | null> {
  try {
  const root = resolve(input.cacheDir ?? DEFAULT_NEW_HAMPSHIRE_REPORTED_CACHE_DIR);
  const scope = { kind: input.kind, electionYear: input.electionYear, ...(input.kind === "committee" ? { filingEntityId: nhSourceInteger(input.filingEntityId) } : {}) };
  const ref = await pointer(root, scope);
  if (!ref) return null;
  const source = await loaded(root, ref, scope);
  const base = await readBaseReference(root, reference(source.manifest.scope.base), input.electionYear);
  const result = input.kind === "committee"
    ? await acquireNewHampshireReportedReceipts(source.request, base, nhSourceInteger(input.filingEntityId))
    : await acquireNewHampshireReportedIe(source.request, base);
  source.finish();
  const first = source.controls[0]!, last = source.controls.at(-1)!;
  const baseEnd = Date.parse(base.controls.at(-1)!.completedAt);
  if (Date.parse(first.startedAt) < baseEnd || Date.parse(first.startedAt) - baseEnd > 86_400_000) nhSourceHold("base_observation_outside_capture");
  const controls = [...base.controls, ...source.controls];
  const packet: NewHampshireReportedSourcePacket = immutable({ ...result, kind: input.kind, electionYear: input.electionYear,
    filingEntityId: input.kind === "committee" ? input.filingEntityId! : null,
    base, reference: ref, sourceUrl: NEW_HAMPSHIRE_REPORTED_SOURCE_URL,
    sourceRetrievedAt: first.startedAt, sourceCompletedAt: last.completedAt,
    sourceBaseRetrievedAt: base.controls[0]!.startedAt, sourceManifestSha256: ref.sha256,
    sourceByteSize: controls.reduce((sum, c) => sum + c.byteSize, 0), sourceControls: controls });
  verifiedPackets.add(packet);
  return packet;
  } catch (error) {
    if (error instanceof NewHampshireReportedSourceError) throw error;
    return nhSourceHold("cache_io_unavailable");
  }
}

/** One producer per ordinary batch shares only transport budgets. Every
 * component has its own immutable generation and qualified latest pointer. */
export function createNewHampshireReportedSourceProducer(options: { cacheDir?: string; fetchImpl?: typeof fetch; minimumGapMs?: number } = {}) {
  const root = resolve(options.cacheDir ?? DEFAULT_NEW_HAMPSHIRE_REPORTED_CACHE_DIR);
  const gap = options.minimumGapMs ?? 1000;
  if (!Number.isSafeInteger(gap) || gap < 0 || gap > 60_000) nhSourceHold("invalid_source_pacing");
  const deadline = Date.now() + 15 * 60_000;
  let requests = 0, totalBytes = 0, lastEnd = 0;
  async function produce<T>(scope: Scope, graph: (request: NewHampshireSourceRequest) => Promise<T>): Promise<NewHampshireSourceReference> {
    pointerName(scope);
    await mkdir(root, { recursive: true, mode: 0o700 }); await privateDirectory(root);
    const generation = `generation-${randomUUID()}`;
    await mkdir(resolve(root, generation), { mode: 0o700 });
    const manifest: Manifest = { version: 1, scope, outcome: "held", records: [] };
    let failure: unknown;
    try {
      await graph(async request => {
        if (++requests > 400 || Date.now() >= deadline) nhSourceHold("source_request_budget");
        await delay(Math.max(0, gap - (Date.now() - lastEnd)));
        if (Date.now() >= deadline) nhSourceHold("source_request_budget");
        const capture = await downloadNewHampshirePublicJson(request, { fetchImpl: options.fetchImpl, timeoutMs: Math.min(45_000, deadline - Date.now()) });
        lastEnd = Date.parse(capture.completedAt); totalBytes += capture.bytes.length;
        if (totalBytes > MAX_BYTES) nhSourceHold("source_byte_budget");
        const url = `${NEW_HAMPSHIRE_CFS_API_BASE_URL}/${NEW_HAMPSHIRE_CFS_ENDPOINTS[request.endpoint]}`;
        if (capture.httpStatus !== 200 || capture.eof !== true || capture.responseUrl !== url ||
          typeof capture.contentType !== "string" || !/^application\/json(?:;|$)/i.test(capture.contentType)) nhSourceHold("native_transport_mismatch");
        const file = `${generation}/${String(manifest.records.length + 1).padStart(4, "0")}.raw`;
        const sha256 = hash(capture.bytes);
        await writeFile(resolve(root, file), capture.bytes, { flag: "wx", mode: 0o600 });
        manifest.records.push({ request, responseUrl: capture.responseUrl, control: { file, sha256,
          byteSize: capture.bytes.length, status: capture.httpStatus, eof: capture.eof, contentType: capture.contentType,
          startedAt: capture.requestedAt, completedAt: capture.completedAt } });
        return { envelope: capture.envelope, sha256 };
      });
      manifest.outcome = "qualified";
    } catch (error) {
      failure = error instanceof NewHampshireReportedSourceError ? error : new NewHampshireReportedSourceError("source_transport_unavailable");
      manifest.heldReason = (failure as NewHampshireReportedSourceError).code;
    }
    const bytes = Buffer.from(JSON.stringify(manifest));
    const ref = { manifest: `${generation}/manifest.json`, sha256: hash(bytes) };
    await writeFile(resolve(root, ref.manifest), bytes, { flag: "wx", mode: 0o600 });
    if (failure) throw failure;
    const target = resolve(root, pointerName(scope)), temporary = `${target}.tmp-${randomUUID()}`;
    await writeFile(temporary, JSON.stringify(ref), { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
    return ref;
  }
  return {
    async refreshBase(electionYear: number) {
      year(electionYear);
      await produce({ kind: "base", electionYear }, request => acquireNewHampshireReportedBase(request, electionYear));
      return readNewHampshireReportedBase({ cacheDir: root, electionYear });
    },
    async refreshComponent(input: { kind: "committee" | "ie"; electionYear: number; base: NewHampshireSourceReference; filingEntityId?: number }) {
      const base = await readBaseReference(root, input.base, input.electionYear);
      const baseEnd = Date.parse(base.controls.at(-1)!.completedAt);
      if (Date.now() < baseEnd || Date.now() - baseEnd > 86_400_000) nhSourceHold("stale_base_observation");
      const scope: Scope = { kind: input.kind, electionYear: year(input.electionYear), base: input.base,
        ...(input.kind === "committee" ? { filingEntityId: nhSourceInteger(input.filingEntityId) } : {}) };
      await produce(scope, request => input.kind === "committee"
        ? acquireNewHampshireReportedReceipts(request, base, nhSourceInteger(input.filingEntityId))
        : acquireNewHampshireReportedIe(request, base));
      return readNewHampshireReportedSource({ ...input, cacheDir: root });
    },
  };
}
