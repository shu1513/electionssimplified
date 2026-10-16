/** NC regular-report sources need one coherent receiving generation. The
 * legacy per-file cache cannot bind inventories, amendments and CSV controls;
 * this state-only adapter leaves that shared/legacy contract unchanged. */
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  ncsbeDocumentInventoryUrl, ncsbeExpendituresUrl, ncsbeReceiptsUrl, ncsbeReportDetailUrl,
  NCSBE_TRANSACTION_PAGE_SIZE,
} from "./northCarolinaNcsbeClient.js";
import {
  getNcsbeArtifactPaths, NCSBE_ARTIFACT_SCHEMA_VERSION, validateNcsbeArtifactBody,
  type NcsbeArtifactKey, type NcsbeArtifactManifest,
} from "./northCarolinaNcsbeArtifactCache.js";
import { ncsbeSourceDocumentMetadata, selectNcsbeCycleReportRows } from "./northCarolinaNcsbeArtifactAcquisition.js";
import {
  NORTH_CAROLINA_SBOEID_PATTERN, NCSBE_PARSER_VERSION, parseNcsbeDocumentListPage, extractNcsbeEmbeddedJson,
  parseNcsbeExpendituresPage, parseNcsbeReceiptsPage, parseNcsbeReportDetailPage,
  type NcsbeDocumentRow,
} from "./northCarolinaNcsbeParsers.js";
import { selectNorthCarolinaDirectCycleReportRows } from "./northCarolinaDirectContributionAggregator.js";
import { selectNcsbeCurrentFilings } from "./northCarolinaReportSelector.js";
import { validateNorthCarolinaReportedReceiptSource, extractNorthCarolinaNativeExportUrl } from "./northCarolinaReportedReceiptSource.js";
import {
  aggregateNorthCarolinaReportedCommitteeReceipts,
  type NorthCarolinaReportedCommitteeReceiptHoldReason,
} from "./northCarolinaReportedCommitteeReceiptAggregator.js";
import type { Binding, CaptureScope, Facts, Generation, Manifest, Original, Pointer, Qualified, Scope } from "./northCarolinaReportedReceiptSourceTypes.js";
export type { Generation } from "./northCarolinaReportedReceiptSourceTypes.js";

export const DEFAULT_NC_REPORTED_RECEIPT_CACHE_DIR = "scratch/north-carolina-reported-receipts";
export const NORTH_CAROLINA_REPORTED_RECEIPT_LIMITS = Object.freeze({
  maxRequests: 1000, maxTotalBytes: 256 * 1024 * 1024, maxBodyBytes: 16 * 1024 * 1024,
  maxCaptureMs: 30 * 60_000, requestTimeoutMs: 90_000, requestSpacingMs: 2_000,
});
const MANIFEST_BYTES = 1024 * 1024, FUTURE_MS = 5 * 60_000, LEASE_MS = 40 * 60_000;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const HOLD_REASONS: ReadonlySet<string> = new Set([
  "receiving_committee", "election_year", "inventory_identity", "inventory_period", "current_lineage", "current_image_only",
  "no_current_reports", "current_report_set", "report_identity", "typed_receipt_controls", "receipt_shape", "payment_type",
  "prior_receipt", "negative_monetary_receipt", "reported_name", "unsafe_integer",
]);
export class NorthCarolinaReportedReceiptSourceError extends Error {
  readonly holdReason?: NorthCarolinaReportedCommitteeReceiptHoldReason;
  constructor(readonly code: "invalid_scope" | "locked" | "unavailable" | "held" | "stale_generation" = "unavailable",
    holdReason?: NorthCarolinaReportedCommitteeReceiptHoldReason) {
    super("North Carolina reported receipt source unavailable");
    this.name = "NorthCarolinaReportedReceiptSourceError";
    if (code === "held" && holdReason && HOLD_REASONS.has(holdReason)) this.holdReason = holdReason;
  }
}
const fail = (code: NorthCarolinaReportedReceiptSourceError["code"] = "unavailable"): never => { throw new NorthCarolinaReportedReceiptSourceError(code); };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value: unknown): string => JSON.stringify(value, (_, v: unknown) => v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown, low = 0): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= low;
const exactKeys = (v: object, keys: string[]) => same(Object.keys(v).sort(), [...keys].sort());
const iso = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const validId = (v: unknown): v is string => typeof v === "string" && /^[1-9]\d*$/.test(v) && Number.isSafeInteger(Number(v));
function scope(input: Scope): { root: string; directory: string } {
  if (!input || typeof input.receivingCommitteeId !== "string" || !NORTH_CAROLINA_SBOEID_PATTERN.test(input.receivingCommitteeId)
    || !input.receivingCommitteeId.includes("-C-") || !integer(input.electionYear, 2000) || input.electionYear > 2100
    || input.cacheDir !== undefined && (typeof input.cacheDir !== "string" || input.cacheDir.trim() === "")) fail("invalid_scope");
  const root = resolve(input.cacheDir ?? DEFAULT_NC_REPORTED_RECEIPT_CACHE_DIR);
  return { root, directory: join(root, input.receivingCommitteeId, String(input.electionYear)) };
}
function captureScope(input: CaptureScope): void { scope(input); if (!integer(input.orgGroupId, 1)) fail("invalid_scope"); }
function validateBinding(b: Binding): void {
  if (!record(b)) fail();
  if (b.role === "inventory_open" || b.role === "inventory_close") { if (!exactKeys(b, ["role"])) fail(); }
  else if (b.role === "report_cover" || b.role === "native_csv") { if (!exactKeys(b, ["role", "reportId"]) || !validId(b.reportId)) fail(); }
  else if (b.role === "receipt_page" || b.role === "expenditure_page") {
    if (!exactKeys(b, ["role", "reportId", "page"]) || !validId(b.reportId) || !integer(b.page) || b.page > 3333) fail();
  } else fail();
}
/** Methods are implied by the role. The recorder separately checks POST form geometry in memory. */
export function validateNorthCarolinaReportedReceiptOriginalUrl(input: { scope: CaptureScope; binding: Binding; url: string }): void {
  try {
    captureScope(input.scope); validateBinding(input.binding);
    if (typeof input.url !== "string" || /[\u0000-\u0020\\]/.test(input.url)) fail();
    const u = new URL(input.url), b = input.binding;
    if (u.origin !== "https://cf.ncsbe.gov" || u.username || u.password || u.hash) fail();
    if (b.role === "inventory_open" || b.role === "inventory_close") {
      if (input.url !== ncsbeDocumentInventoryUrl({ sboeId: input.scope.receivingCommitteeId, orgGroupId: input.scope.orgGroupId })) fail();
    } else if (b.role === "report_cover") { if (input.url !== ncsbeReportDetailUrl(b.reportId)) fail(); }
    else if (b.role === "receipt_page") { if (input.url !== ncsbeReceiptsUrl(b.reportId)) fail(); }
    else if (b.role === "expenditure_page") { if (input.url !== ncsbeExpendituresUrl(b.reportId)) fail(); }
    else {
      if (u.pathname !== "/CFOrgLkup/ReportDetail" || !("reportId" in b)) return fail();
      const expected = new Map([["handler", "Export"], ["RID", b.reportId], ["TP", "ALL"], ["sid", ""], ["cn", ""]]);
      if ([...u.searchParams].length !== expected.size) fail();
      for (const [key, value] of expected) if (u.searchParams.getAll(key).length !== 1 || u.searchParams.get(key) !== value) fail();
    }
  } catch (error) { if (error instanceof NorthCarolinaReportedReceiptSourceError) throw error; fail(); }
}
async function directory(path: string, create = false): Promise<void> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  if (create) await chmod(path, 0o700);
  else if ((stat.mode & 0o777) !== 0o700) fail();
}
async function directories(input: Scope, create = false): Promise<string> {
  const p = scope(input);
  for (const path of [p.root, join(p.root, input.receivingCommitteeId), p.directory]) await directory(path, create);
  return p.directory;
}
async function boundedFile(path: string, limit: number): Promise<Buffer> {
  const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await h.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > limit || stat.size < 0) fail();
    const bytes = await h.readFile();
    if (bytes.length !== stat.size || bytes.length > limit) fail();
    return bytes;
  } finally { await h.close(); }
}
function decode(bytes: Buffer): string { try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return fail(); } }
function json(bytes: Buffer): unknown { try { return JSON.parse(decode(bytes)); } catch { return fail(); } }
function binding(original: Original): Binding {
  if (original.role === "inventory_open" || original.role === "inventory_close") return { role: original.role };
  if (original.role === "report_cover" || original.role === "native_csv") return { role: original.role, reportId: original.reportId };
  if (original.role === "receipt_page" || original.role === "expenditure_page") return { role: original.role, reportId: original.reportId, page: original.page };
  return fail();
}
const bindingKey = (b: Binding) => canonical(b);
function validateManifest(value: unknown, input: Scope, generation: string): Manifest {
  if (!record(value) || !exactKeys(value, ["version", "generation", "receivingCommitteeId", "electionYear", "orgGroupId", "sourceRetrievedAt", "sourceCompletedAt", "originals"])
    || value.version !== 1 || value.generation !== generation || !UUID.test(generation) || value.receivingCommitteeId !== input.receivingCommitteeId
    || value.electionYear !== input.electionYear || !integer(value.orgGroupId, 1) || !Array.isArray(value.originals)
    || value.originals.length < 2 || value.originals.length > NORTH_CAROLINA_REPORTED_RECEIPT_LIMITS.maxRequests
    || !iso(value.sourceRetrievedAt) || !iso(value.sourceCompletedAt)) fail();
  const m = value as unknown as Manifest;
  let previousEnd = -Infinity, bytes = 0;
  const keys = new Set<string>();
  for (const [i, original] of m.originals.entries()) {
    if (!record(original)) fail();
    const b = binding(original); validateBinding(b);
    const keysForBinding = Object.keys(b);
    if (!exactKeys(original, [...keysForBinding, "ordinal", "file", "url", "status", "eof", "byteSize", "sha256", "startedAt", "completedAt"])
      || original.ordinal !== i + 1 || original.file !== `originals/${String(i + 1).padStart(4, "0")}.raw`
      || original.status !== 200 || original.eof !== true || !integer(original.byteSize)
      || original.byteSize > NORTH_CAROLINA_REPORTED_RECEIPT_LIMITS.maxBodyBytes || typeof original.sha256 !== "string" || !HASH.test(original.sha256)
      || !iso(original.startedAt) || !iso(original.completedAt) || Date.parse(original.startedAt) < previousEnd
      || Date.parse(original.completedAt) < Date.parse(original.startedAt)
      || Date.parse(original.completedAt) - Date.parse(original.startedAt) > NORTH_CAROLINA_REPORTED_RECEIPT_LIMITS.requestTimeoutMs
      || Date.parse(original.startedAt) - Date.parse(m.sourceRetrievedAt) > NORTH_CAROLINA_REPORTED_RECEIPT_LIMITS.maxCaptureMs
      || Date.parse(original.completedAt) > Date.now() + FUTURE_MS) fail();
    validateNorthCarolinaReportedReceiptOriginalUrl({ scope: { ...input, orgGroupId: m.orgGroupId }, binding: b, url: original.url });
    if (keys.has(bindingKey(b))) fail(); keys.add(bindingKey(b));
    previousEnd = Date.parse(original.completedAt); bytes += original.byteSize;
  }
  if (bytes > NORTH_CAROLINA_REPORTED_RECEIPT_LIMITS.maxTotalBytes || m.originals[0]!.role !== "inventory_open"
    || m.originals.at(-1)!.role !== "inventory_close" || m.sourceRetrievedAt !== m.originals[0]!.startedAt
    || m.sourceCompletedAt !== m.originals.at(-1)!.completedAt) fail();
  return m;
}
function pointer(value: unknown): Pointer {
  if (!record(value) || !exactKeys(value, ["version", "generation", "manifestSha256"]) || value.version !== 1
    || typeof value.generation !== "string" || !UUID.test(value.generation) || typeof value.manifestSha256 !== "string" || !HASH.test(value.manifestSha256)) fail();
  return value as Pointer;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
}

const missing = (e: unknown) => record(e) && e.code === "ENOENT";
async function safe<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (e) { if (e instanceof NorthCarolinaReportedReceiptSourceError) throw e; return fail(); }
}
/** The ordinary producer writes here first. Restrict its private tree before
 * replay; readers never follow manifests to arbitrary paths. */
async function ordinaryTree(path: string, makePrivate: boolean): Promise<Set<string>> {
  const files = new Set<string>(); let count = 0;
  async function walk(p: string): Promise<void> {
    if (++count > NORTH_CAROLINA_REPORTED_RECEIPT_LIMITS.maxRequests * 4) fail();
    const stat = await lstat(p);
    if (stat.isSymbolicLink()) fail();
    if (stat.isDirectory()) {
      if (makePrivate) await chmod(p, 0o700); else if ((stat.mode & 0o777) !== 0o700) fail();
      for (const child of await readdir(p)) await walk(join(p, child));
    } else if (stat.isFile()) {
      if (stat.size > NORTH_CAROLINA_REPORTED_RECEIPT_LIMITS.maxBodyBytes) fail();
      if (makePrivate) await chmod(p, 0o600); else if ((stat.mode & 0o777) !== 0o600) fail();
      files.add(p);
    } else fail();
  }
  await walk(path); return files;
}

function inventoryPopulation(html: string): string[] {
  const marker = html.includes("var data = ") ? "var data = " : '\"data\":{\"Data\":';
  if (!html.includes(marker) && html.includes('id="divNoResults"')) return [];
  const rows: unknown = JSON.parse(extractNcsbeEmbeddedJson({ html, marker, open: "[", label: "inventory" }).raw);
  if (!Array.isArray(rows) || rows.some((row) => !record(row))) return fail();
  return rows.map(canonical).sort();
}
async function readGeneration(input: Scope, p: Pointer): Promise<Qualified> {
  const base = await directories(input), gen = join(base, `generation-${p.generation}`);
  await directory(gen); await directory(join(gen, "originals"));
  const ordinary = join(gen, "ordinary-cache"); await directory(ordinary);
  const manifestBytes = await boundedFile(join(gen, "manifest.json"), MANIFEST_BYTES);
  if (hash(manifestBytes) !== p.manifestSha256) fail();
  const m = validateManifest(json(manifestBytes), input, p.generation);
  const bodies = new Map<string, { original: Original; body: string }>();
  const originalsFiles = await readdir(join(gen, "originals"));
  if (!same(originalsFiles.sort(), m.originals.map((o) => o.file.slice("originals/".length)).sort())) fail();
  for (const o of m.originals) {
    const bytes = await boundedFile(join(gen, o.file), NORTH_CAROLINA_REPORTED_RECEIPT_LIMITS.maxBodyBytes);
    if (bytes.length !== o.byteSize || hash(bytes) !== o.sha256) fail();
    bodies.set(bindingKey(binding(o)), { original: o, body: decode(bytes) });
  }
  const expected = new Set<string>();
  function take(b: Binding) {
    const key = bindingKey(b), value = bodies.get(key);
    if (!value || expected.has(key)) fail(); expected.add(key); return value!;
  }
  const opening = take({ role: "inventory_open" }), closing = take({ role: "inventory_close" });
  const inventory = parseNcsbeDocumentListPage(opening.body);
  parseNcsbeDocumentListPage(closing.body);
  if (!same(inventoryPopulation(opening.body), inventoryPopulation(closing.body))) fail();
  const ordinaryRows = new Map<string, NcsbeDocumentRow>();
  for (const row of selectNcsbeCycleReportRows({ rows: inventory, cycleYear: input.electionYear }).selected)
    if (!ordinaryRows.has(row.dataLink!)) ordinaryRows.set(row.dataLink!, row);
  const ordinaryFiles = await ordinaryTree(ordinary, false), expectedOrdinaryFiles = new Set<string>();
  async function cacheBody(key: NcsbeArtifactKey, raw: { original: Original; body: string }, row?: NcsbeDocumentRow): Promise<void> {
    const paths = getNcsbeArtifactPaths({ cacheDir: ordinary, key });
    expectedOrdinaryFiles.add(paths.filePath); expectedOrdinaryFiles.add(paths.manifestPath);
    const bytes = await boundedFile(paths.filePath, NORTH_CAROLINA_REPORTED_RECEIPT_LIMITS.maxBodyBytes);
    if (bytes.length !== raw.original.byteSize || hash(bytes) !== raw.original.sha256 || decode(bytes) !== raw.body) fail();
    const value = json(await boundedFile(paths.manifestPath, MANIFEST_BYTES));
    if (!record(value) || !exactKeys(value, ["version", "parserVersion", "key", "url", "filePath", "manifestPath", "retrievedAt", "sha256", "byteSize", "rowCount", "recordCountKey", "sourceDocument"])) fail();
    const cached = value as unknown as NcsbeArtifactManifest;
    const shape = validateNcsbeArtifactBody(key, raw.body);
    if (cached.version !== NCSBE_ARTIFACT_SCHEMA_VERSION || cached.parserVersion !== NCSBE_PARSER_VERSION
      || !same(cached.key, key) || cached.filePath !== paths.filePath || cached.manifestPath !== paths.manifestPath
      || cached.url !== raw.original.url || cached.sha256 !== raw.original.sha256 || cached.byteSize !== bytes.length
      || !iso(cached.retrievedAt) || cached.rowCount !== shape.rowCount || cached.recordCountKey !== shape.recordCountKey
      || !same(cached.sourceDocument, row ? ncsbeSourceDocumentMetadata(row) : null)) fail();
  }
  await cacheBody({ type: "document_inventory", sboeId: input.receivingCommitteeId }, opening);
  const reports = new Map<string, { cover: string; pages: { page: number; body: string }[] }>();
  let lastOrdinaryOrdinal = 1;
  for (const [reportId, row] of ordinaryRows) {
    const cover = take({ role: "report_cover", reportId });
    if (cover.original.ordinal <= lastOrdinaryOrdinal || parseNcsbeReportDetailPage(cover.body).cover.reportId !== reportId) fail();
    await cacheBody({ type: "report_cover", reportId }, cover, row);
    let previous = cover.original.ordinal;
    const receiptPages: { page: number; body: string }[] = [];
    for (const role of ["receipt_page", "expenditure_page"] as const) {
      let total: number | undefined, pageCount = 1;
      for (let page = 0; page < pageCount; page++) {
        const raw = take({ role, reportId, page });
        if (raw.original.ordinal <= previous) fail(); previous = raw.original.ordinal;
        const parsed = role === "receipt_page" ? parseNcsbeReceiptsPage(raw.body) : parseNcsbeExpendituresPage(raw.body);
        if (!integer(parsed.recordCount) || parsed.recordCount > 1_000_000 || total !== undefined && total !== parsed.recordCount) fail();
        total = parsed.recordCount; pageCount = Math.max(1, Math.ceil(total / NCSBE_TRANSACTION_PAGE_SIZE));
        if (parsed.rows.length !== Math.min(NCSBE_TRANSACTION_PAGE_SIZE, total - page * NCSBE_TRANSACTION_PAGE_SIZE)) fail();
        await cacheBody({ type: "report_transactions", reportId, kind: role === "receipt_page" ? "receipts" : "expenditures", page }, raw, row);
        if (role === "receipt_page") receiptPages.push({ page, body: raw.body });
      }
    }
    lastOrdinaryOrdinal = previous; reports.set(reportId, { cover: cover.body, pages: receiptPages });
  }
  if (!same([...ordinaryFiles].sort(), [...expectedOrdinaryFiles].sort())) fail();
  const scoped = inventory.filter((r) => r.sboeId === input.receivingCommitteeId || r.sboeId === null || r.sboeId.trim() === "");
  const cycle = selectNorthCarolinaDirectCycleReportRows({ rows: scoped, electionYear: input.electionYear });
  const current = selectNcsbeCurrentFilings({ rows: cycle.rows });
  if (cycle.rows.some((r) => r.sboeId !== input.receivingCommitteeId)) throw new NorthCarolinaReportedReceiptSourceError("held", "inventory_identity");
  if (current.quarantinedGroups.length) throw new NorthCarolinaReportedReceiptSourceError("held", "current_lineage");
  if (current.supersededUnavailable.length) throw new NorthCarolinaReportedReceiptSourceError("held", "current_image_only");
  if (!current.selected.length) throw new NorthCarolinaReportedReceiptSourceError("held", "no_current_reports");
  const validated = [];
  for (const filing of current.selected) {
    const reportId = filing.reportId!, r = reports.get(reportId); if (!r) return fail();
    const csv = take({ role: "native_csv", reportId });
    if (csv.original.ordinal <= lastOrdinaryOrdinal || csv.original.ordinal >= closing.original.ordinal
      || csv.original.url !== extractNorthCarolinaNativeExportUrl({ reportId, coverHtml: r.cover })) fail();
    validated.push(validateNorthCarolinaReportedReceiptSource({ reportId, coverHtml: r.cover, exportCsv: csv.body, receiptPages: r.pages }));
  }
  if (expected.size !== bodies.size) fail();
  const aggregation = aggregateNorthCarolinaReportedCommitteeReceipts({ receivingCommitteeId: input.receivingCommitteeId,
    electionYear: input.electionYear, inventoryRows: inventory, reports: validated });
  if (aggregation.status !== "qualified") throw new NorthCarolinaReportedReceiptSourceError("held", aggregation.reason);
  const source: Facts = {
    receivingCommitteeId: input.receivingCommitteeId, electionYear: input.electionYear, sourceGeneration: m.generation,
    sourceRetrievedAt: m.sourceRetrievedAt, sourceCompletedAt: m.sourceCompletedAt, sourceUrl: "https://cf.ncsbe.gov/CFOrgLkup/",
    sourceReceiptOccurrenceCount: aggregation.diagnostics.sourceOccurrenceCount, sourceReportCount: aggregation.diagnostics.reportCount,
    sourceByteSize: m.originals.reduce((n, o) => n + o.byteSize, 0), sourceManifestSha256: p.manifestSha256,
    sourceControls: m.originals,
  };
  return deepFreeze({ aggregation, source });
}

export async function readNorthCarolinaReportedReceiptSource(input: Scope): Promise<Qualified | null> {
  return safe(async () => {
    const base = scope(input).directory;
    try { await directories(input); await lstat(join(base, "current.json")); } catch (e) { if (missing(e)) return null; throw e; }
    return readGeneration(input, pointer(json(await boundedFile(join(base, "current.json"), MANIFEST_BYTES))));
  });
}

type State = { scope: CaptureScope; handle: FileHandle; token: string; lockPath: string; originals: Original[]; bytes: number; closed: boolean; busy: boolean; finalized: boolean };
const states = new WeakMap<Generation, State>();
function state(g: Generation): State { const s = states.get(g); if (!s || s.closed || s.finalized) return fail(); return s; }
async function ownsLease(s: State): Promise<void> {
  const held = await s.handle.stat(), disk = await lstat(s.lockPath);
  if (!disk.isFile() || disk.isSymbolicLink() || held.ino !== disk.ino || held.dev !== disk.dev
    || Date.now() - held.mtimeMs > LEASE_MS || (disk.mode & 0o777) !== 0o600) fail("locked");
  const contents = json(await boundedFile(s.lockPath, 4096));
  if (!record(contents) || contents.token !== s.token) fail("locked");
}
export async function beginNorthCarolinaReportedReceiptGeneration(input: CaptureScope): Promise<Generation> {
  return safe(async () => {
    captureScope(input); const captured = { ...input }, base = await directories(captured, true), lockPath = join(base, "refresh.lock");
    let h: FileHandle;
    try { h = await open(lockPath, "wx", 0o600); }
    catch (e) {
      if (!record(e) || e.code !== "EEXIST") throw e;
      // Serialize stale recovery. Contention or an abandoned recovery guard
      // fails closed; it is never recursively reclaimed.
      const recoveryPath = join(base, "recovery.lock");
      let recovery: FileHandle;
      try { recovery = await open(recoveryPath, "wx", 0o600); } catch { return fail("locked"); }
      try {
        const before = await lstat(lockPath);
        if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o777) !== 0o600 || Date.now() - before.mtimeMs <= LEASE_MS) fail("locked");
        await unlink(lockPath);
        try { h = await open(lockPath, "wx", 0o600); } catch { return fail("locked"); }
      } finally { await recovery.close(); await unlink(recoveryPath); }
    }
    const token = randomUUID();
    try {
      await h.writeFile(JSON.stringify({ version: 1, token, createdAt: new Date().toISOString() }));
      const generation = randomUUID(), dir = join(base, `generation-${generation}`);
      await mkdir(dir, { mode: 0o700 }); await mkdir(join(dir, "originals"), { mode: 0o700 }); await mkdir(join(dir, "ordinary-cache"), { mode: 0o700 });
      const g = Object.freeze({ generation, directory: dir, ordinaryCacheDir: join(dir, "ordinary-cache") }) as Generation;
      states.set(g, { scope: captured, handle: h, token, lockPath, originals: [], bytes: 0, closed: false, busy: false, finalized: false });
      return g;
    } catch (e) { await h.close().catch(() => {}); await unlink(lockPath).catch(() => {}); throw e; }
  });
}
export async function appendNorthCarolinaReportedReceiptOriginal(input: {
  generation: Generation; binding: Binding; url: string; status: number; eof: boolean; bytes: Buffer; startedAt: Date; completedAt: Date;
}): Promise<Readonly<Original>> {
  return safe(async () => {
    const s = state(input.generation); if (s.busy) fail(); s.busy = true;
    try {
      if (!Buffer.isBuffer(input.bytes) || !(input.startedAt instanceof Date) || !(input.completedAt instanceof Date)) fail();
      const bytes = Buffer.from(input.bytes), startedAt = input.startedAt.toISOString(), completedAt = input.completedAt.toISOString();
      const copiedBinding = { ...input.binding } as Binding;
      await ownsLease(s); validateBinding(copiedBinding);
      validateNorthCarolinaReportedReceiptOriginalUrl({ scope: s.scope, binding: input.binding, url: input.url });
      if (!Buffer.isBuffer(input.bytes) || !integer(input.status) || input.status > 599 || typeof input.eof !== "boolean"
        || !(input.startedAt instanceof Date) || !(input.completedAt instanceof Date)) fail();
      const ordinal = s.originals.length + 1;
      if (ordinal > NORTH_CAROLINA_REPORTED_RECEIPT_LIMITS.maxRequests || bytes.length > NORTH_CAROLINA_REPORTED_RECEIPT_LIMITS.maxBodyBytes
        || s.bytes + bytes.length > NORTH_CAROLINA_REPORTED_RECEIPT_LIMITS.maxTotalBytes) fail();
      const original: Original = deepFreeze({ ...copiedBinding, ordinal, file: `originals/${String(ordinal).padStart(4, "0")}.raw`,
        url: input.url, status: input.status, eof: input.eof, byteSize: bytes.length, sha256: hash(bytes), startedAt, completedAt });
      await writeFile(join(input.generation.directory, original.file), bytes, { flag: "wx", mode: 0o600 });
      s.originals.push(original); s.bytes += bytes.length;
      // This diagnostic journal also preserves failed/partial genuine bodies.
      // It has no publication authority and is never accepted by the reader.
      const temp = join(input.generation.directory, `journal-${randomUUID()}.tmp`);
      await writeFile(temp, JSON.stringify({ version: 1, originals: s.originals }), { flag: "wx", mode: 0o600 });
      await rename(temp, join(input.generation.directory, "capture-journal.json"));
      return original;
    } finally { s.busy = false; }
  });
}
export async function finalizeNorthCarolinaReportedReceiptGeneration(g: Generation): Promise<Qualified> {
  return safe(async () => {
    const s = state(g); if (s.busy) fail(); s.busy = true;
    try {
      await ownsLease(s);
      if (!s.originals.length) fail();
      const manifest: Manifest = { version: 1, generation: g.generation, receivingCommitteeId: s.scope.receivingCommitteeId,
        electionYear: s.scope.electionYear, orgGroupId: s.scope.orgGroupId, sourceRetrievedAt: s.originals[0]!.startedAt,
        sourceCompletedAt: s.originals.at(-1)!.completedAt, originals: [...s.originals] };
      const bytes = Buffer.from(JSON.stringify(manifest)); if (bytes.length > MANIFEST_BYTES) fail();
      validateManifest(manifest, s.scope, g.generation);
      await ordinaryTree(g.ordinaryCacheDir, true);
      await writeFile(join(g.directory, "manifest.json"), bytes, { flag: "wx", mode: 0o600 });
      const p: Pointer = { version: 1, generation: g.generation, manifestSha256: hash(bytes) };
      const qualified = await readGeneration(s.scope, p);
      const previous = await readNorthCarolinaReportedReceiptSource(s.scope);
      if (previous && previous.source.sourceRetrievedAt >= qualified.source.sourceRetrievedAt) fail("stale_generation");
      await ownsLease(s);
      const base = scope(s.scope).directory, temp = join(base, `current-${randomUUID()}.tmp`);
      await writeFile(temp, JSON.stringify(p), { flag: "wx", mode: 0o600 });
      await rename(temp, join(base, "current.json"));
      s.finalized = true; return qualified;
    } finally { s.busy = false; }
  });
}
export async function closeNorthCarolinaReportedReceiptGeneration(g: Generation): Promise<void> {
  return safe(async () => {
    const s = states.get(g); if (!s || s.closed) return;
    if (s.busy) fail("locked");
    try {
      // Failed ordinary captures may have installed files before source
      // qualification failed. Retain them with the same private permissions.
      let leaseFailure: unknown;
      try { await ownsLease(s); } catch (error) { leaseFailure = error; }
      try { await ordinaryTree(g.ordinaryCacheDir, true); }
      catch (error) { if (!leaseFailure) throw error; }
      finally { if (!leaseFailure) await unlink(s.lockPath); }
      if (leaseFailure) throw leaseFailure;
    } finally { s.closed = true; await s.handle.close(); }
  });
}
