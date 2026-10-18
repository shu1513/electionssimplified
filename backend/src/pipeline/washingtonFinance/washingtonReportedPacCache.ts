import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { acquireWashingtonReportedPacSource, validateWashingtonPacScope, washingtonPacRequestUrl, waPacHold, waPacObject,
  WashingtonPacSourceError, type WashingtonPacRequest, type WashingtonPacScope } from "./washingtonReportedPacSource.js";

export const DEFAULT_WASHINGTON_PAC_CACHE_DIR = "scratch/washington-campaign-finance/reported";
export type WashingtonPacControl = { file: string; sha256: string; byteSize: number; status: number; eof: boolean;
  contentType: string; startedAt: string; completedAt: string };
type Capture = { request: WashingtonPacRequest; responseUrl: string; control: WashingtonPacControl };
type Reference = { manifest: string; sha256: string };
type Manifest = { version: 1; scope: WashingtonPacScope; outcome: "qualified" | "held"; records: Capture[]; heldReason?: string };
export type WashingtonPacSourcePacket = Awaited<ReturnType<typeof acquireWashingtonReportedPacSource>> & {
  sourceRetrievedAt: string; sourceCompletedAt: string; sourceManifestSha256: string;
  sourceByteSize: number; sourceControls: WashingtonPacControl[];
};
const packets = new WeakSet<object>();
export const isVerifiedWashingtonPacSource = (v: unknown): v is WashingtonPacSourcePacket => !!v && typeof v === "object" && packets.has(v);
const HASH = /^[a-f0-9]{64}$/;
const GENERATION = /^generation-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MAX_BYTES = 128 * 1024 * 1024, MAX_RESPONSE = 16 * 1024 * 1024;
const hash = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
const canonical = (v: unknown): string => JSON.stringify(v, (_, x) => x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
function freeze<T extends object>(v: T): T { for (const x of Object.values(v)) if (x && typeof x === "object" && !Object.isFrozen(x)) freeze(x); return Object.freeze(v); }
function pointerName(scope: WashingtonPacScope): string { validateWashingtonPacScope(scope); return `pac-${hash(canonical(scope))}.latest.json`; }
function reference(v: unknown): Reference {
  const r = waPacObject(v);
  if (typeof r.manifest !== "string" || typeof r.sha256 !== "string" || !HASH.test(r.sha256)) waPacHold("invalid_cache_reference");
  const [generation, file, extra] = r.manifest.split("/");
  if (!generation || !GENERATION.test(generation) || file !== "manifest.json" || extra !== undefined) waPacHold("invalid_cache_reference");
  return { manifest: r.manifest, sha256: r.sha256 };
}
async function directory(path: string) {
  const s = await lstat(path); if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o777) !== 0o700) waPacHold("unsafe_cache_directory");
}
async function bytes(path: string, max: number) {
  const s = await lstat(path); if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o777) !== 0o600 || s.size < 1 || s.size > max) waPacHold("unsafe_cache_file");
  const b = await readFile(path); if (b.length !== s.size) waPacHold("cache_file_changed"); return b;
}
function decode(b: Uint8Array): unknown { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b)); } catch { return waPacHold("invalid_cache_json"); } }
const isIso = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;

export function validateWashingtonPacSourceFacts(v: Pick<WashingtonPacSourcePacket,
  "sourceRetrievedAt" | "sourceCompletedAt" | "sourceManifestSha256" | "sourceByteSize" | "sourceControls">, now = Date.now()) {
  if (!isIso(v.sourceRetrievedAt) || !isIso(v.sourceCompletedAt) || Date.parse(v.sourceRetrievedAt) > Date.parse(v.sourceCompletedAt) ||
    Date.parse(v.sourceCompletedAt) > now || !HASH.test(v.sourceManifestSha256) || !Number.isSafeInteger(v.sourceByteSize) ||
    v.sourceByteSize < 1 || v.sourceByteSize > MAX_BYTES || !Array.isArray(v.sourceControls) || v.sourceControls.length < 8 || v.sourceControls.length > 400) waPacHold("invalid_source_facts");
  let end = -Infinity, size = 0, generation: string | undefined;
  for (const [index, control] of v.sourceControls.entries()) {
    if (!control || typeof control.file !== "string") waPacHold("invalid_source_control");
    const [dir, file, extra] = control.file.split("/"); generation ??= dir;
    if (!dir || !GENERATION.test(dir) || dir !== generation || file !== `${String(index + 1).padStart(4, "0")}.raw` || extra !== undefined ||
      !HASH.test(control.sha256) || !Number.isSafeInteger(control.byteSize) || control.byteSize < 1 || control.byteSize > MAX_RESPONSE ||
      control.status !== 200 || control.eof !== true || !/^application\/json(?:;|$)/i.test(control.contentType) ||
      !isIso(control.startedAt) || !isIso(control.completedAt) || Date.parse(control.startedAt) < end || Date.parse(control.startedAt) > Date.parse(control.completedAt)) waPacHold("invalid_source_control");
    end = Date.parse(control.completedAt); size += control.byteSize;
  }
  if (size !== v.sourceByteSize || v.sourceControls[0]!.startedAt !== v.sourceRetrievedAt || v.sourceControls.at(-1)!.completedAt !== v.sourceCompletedAt) waPacHold("source_control_total_mismatch");
}
async function open(root: string, scope: WashingtonPacScope) {
  await directory(root);
  let pointer: Uint8Array;
  try { pointer = await bytes(resolve(root, pointerName(scope)), 4096); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  const ref = reference(decode(pointer)), gen = ref.manifest.split("/")[0]!; await directory(resolve(root, gen));
  const raw = await bytes(resolve(root, ref.manifest), 4 * 1024 * 1024);
  if (hash(raw) !== ref.sha256) waPacHold("manifest_hash_mismatch");
  const manifest = waPacObject(decode(raw)) as unknown as Manifest;
  if (manifest.version !== 1 || manifest.outcome !== "qualified" || canonical(manifest.scope) !== canonical(scope) ||
    !Array.isArray(manifest.records) || manifest.records.length < 8 || manifest.records.length > 400) waPacHold("cache_scope_mismatch");
  return { ref, gen, manifest };
}
export async function readWashingtonPacSourceHint(input: WashingtonPacScope & { cacheDir?: string }) {
  try {
    const s = await open(resolve(input.cacheDir ?? DEFAULT_WASHINGTON_PAC_CACHE_DIR), { filerId: input.filerId, committeeId: input.committeeId, electionYear: input.electionYear });
    if (!s) return null;
    const at = s.manifest.records[0]?.control?.startedAt;
    if (!isIso(at) || Date.parse(at) > Date.now()) waPacHold("invalid_cache_hint");
    return { retrievedAt: at, manifestSha256: s.ref.sha256 };
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; if (e instanceof WashingtonPacSourceError) throw e; return waPacHold("cache_io_unavailable"); }
}
/** A hint cannot authorize money. Every financial packet replays the full
 * native query graph against unchanged original bytes and real clocks. */
export async function readWashingtonPacSource(input: WashingtonPacScope & { cacheDir?: string }): Promise<WashingtonPacSourcePacket | null> {
  try {
    const root = resolve(input.cacheDir ?? DEFAULT_WASHINGTON_PAC_CACHE_DIR), scope = { filerId: input.filerId, committeeId: input.committeeId, electionYear: input.electionYear };
    const source = await open(root, scope); if (!source) return null;
    const controls = source.manifest.records.map(r => r.control), facts = { sourceRetrievedAt: controls[0]!.startedAt,
      sourceCompletedAt: controls.at(-1)!.completedAt, sourceManifestSha256: source.ref.sha256,
      sourceByteSize: controls.reduce((n, c) => n + c.byteSize, 0), sourceControls: controls };
    if (controls.some((c, i) => c.file !== `${source.gen}/${String(i + 1).padStart(4, "0")}.raw`)) waPacHold("capture_generation_mismatch");
    validateWashingtonPacSourceFacts(facts);
    let index = 0;
    const result = await acquireWashingtonReportedPacSource(async wanted => {
      const record = source.manifest.records[index++];
      if (!record || canonical(record.request) !== canonical(wanted) || record.responseUrl !== washingtonPacRequestUrl(wanted)) waPacHold("request_replay_mismatch");
      const control = record.control, raw = await bytes(resolve(root, control.file), MAX_RESPONSE);
      if (raw.length !== control.byteSize || hash(raw) !== control.sha256) waPacHold("original_hash_mismatch");
      const rows = decode(raw); if (!Array.isArray(rows)) waPacHold("invalid_native_page"); return { rows, sha256: control.sha256 };
    }, scope);
    if (index !== source.manifest.records.length) waPacHold("unconsumed_capture_records");
    const packet = freeze({ ...result, ...facts }); packets.add(packet); return packet;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; if (e instanceof WashingtonPacSourceError) throw e; return waPacHold("cache_io_unavailable"); }
}

/** Production callers use native fetch and pacing. Test injection affects
 * transport only; the same source graph and original-byte replay still run. */
export function createWashingtonPacSourceProducer(options: { cacheDir?: string; fetchImpl?: typeof fetch; minimumGapMs?: number } = {}) {
  const root = resolve(options.cacheDir ?? DEFAULT_WASHINGTON_PAC_CACHE_DIR), gap = options.minimumGapMs ?? 1000;
  if (!Number.isSafeInteger(gap) || gap < 0 || gap > 60_000) waPacHold("invalid_source_pacing");
  const deadline = Date.now() + 15 * 60_000; let requests = 0, totalBytes = 0, lastEnd = 0;
  return { async refresh(scope: WashingtonPacScope): Promise<WashingtonPacSourcePacket | null> {
    validateWashingtonPacScope(scope); await mkdir(root, { recursive: true, mode: 0o700 }); await directory(root);
    const gen = `generation-${randomUUID()}`; await mkdir(resolve(root, gen), { mode: 0o700 });
    const manifest: Manifest = { version: 1, scope, outcome: "held", records: [] }; let failure: unknown;
    try {
      await acquireWashingtonReportedPacSource(async request => {
        if (++requests > 400 || Date.now() >= deadline) waPacHold("source_request_budget");
        await delay(Math.max(0, gap - (Date.now() - lastEnd)));
        if (Date.now() >= deadline) waPacHold("source_request_budget");
        const url = washingtonPacRequestUrl(request), requestedAt = new Date().toISOString();
        const response = await (options.fetchImpl ?? fetch)(url, { method: "GET", redirect: "manual",
          headers: { accept: "application/json", "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(Math.max(1, Math.min(45_000, deadline - Date.now()))) });
        const chunks: Buffer[] = []; let length = 0, eof = !response.body;
        const reader = response.body?.getReader();
        if (reader) for (;;) { const part = await reader.read(); if (part.done) { eof = true; break; }
          length += part.value.length; totalBytes += part.value.length;
          if (length > MAX_RESPONSE || totalBytes > MAX_BYTES) { await reader.cancel(); waPacHold("source_byte_budget"); } chunks.push(Buffer.from(part.value)); }
        const raw = Buffer.concat(chunks), completedAt = new Date().toISOString(); lastEnd = Date.parse(completedAt);
        const file = `${gen}/${String(manifest.records.length + 1).padStart(4, "0")}.raw`, contentType = response.headers.get("content-type") ?? "";
        // Keep genuine failure bodies too; they never move the qualified pointer.
        await writeFile(resolve(root, file), raw, { flag: "wx", mode: 0o600 });
        const sha256 = hash(raw);
        manifest.records.push({ request, responseUrl: response.url, control: { file, sha256, byteSize: raw.length,
          status: response.status, eof, contentType, startedAt: requestedAt, completedAt } });
        if (response.status !== 200 || !eof || response.url !== url || !/^application\/json(?:;|$)/i.test(contentType) || !raw.length) waPacHold("native_transport_unavailable");
        const rows = decode(raw); if (!Array.isArray(rows)) waPacHold("invalid_native_page"); return { rows, sha256 };
      }, scope);
      manifest.outcome = "qualified";
    } catch (e) { failure = e instanceof WashingtonPacSourceError ? e : new WashingtonPacSourceError("source_transport_unavailable"); manifest.heldReason = (failure as WashingtonPacSourceError).code; }
    const raw = Buffer.from(JSON.stringify(manifest)), ref = { manifest: `${gen}/manifest.json`, sha256: hash(raw) };
    await writeFile(resolve(root, ref.manifest), raw, { flag: "wx", mode: 0o600 });
    if (failure) throw failure;
    const target = resolve(root, pointerName(scope)), temporary = `${target}.tmp-${randomUUID()}`;
    await writeFile(temporary, JSON.stringify(ref), { flag: "wx", mode: 0o600 }); await rename(temporary, target);
    return readWashingtonPacSource({ ...scope, cacheDir: root });
  } };
}
