import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createOhioCommitteeReceiptAccumulator, OhioCommitteeReceiptError, ohioCommitteeHold, strictOhioCommitteeCents,
  type OhioCommitteeReportCover } from "./ohioCommitteeReceipts.js";
import { parseOhioSosCsvFile } from "./ohioSosCsv.js";
import { DEFAULT_OHIO_SOS_CACHE_DIR, OHIO_SOS_FILE_TRANSFER_PAGE_URL, ohioSosCycleArtifacts, type OhioSosProductKey } from "./ohioSosArtifactCache.js";
import * as bulk from "./ohioSosBulkFiles.js";

export const DEFAULT_OHIO_COMMITTEE_CACHE_DIR = "scratch/ohio-campaign-finance/reported-committee";
const MAX_TOTAL = 512 * 1024 * 1024, MAX_FILE = 256 * 1024 * 1024, HASH = /^[a-f0-9]{64}$/;
const GENERATION = /^generation-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
export const ohioCommitteeCanonical = (v: unknown): string => JSON.stringify(v, (_, x) => x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
const isIso = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const object = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== "object" || Array.isArray(v)) ohioCommitteeHold("invalid_source_object"); return v as Record<string, unknown>; };
const year = (y: number) => { if (!Number.isInteger(y) || y < 2000 || y > 2100) ohioCommitteeHold("invalid_cycle"); return y; };
const requiredRoles = (y: number) => ohioSosCycleArtifacts(year(y)).filter(r =>
  ["candidate_list", "pac_list", "candidate_cover", "pac_cover", "party_cover", "candidate_contributions"].includes(r.productKey));
export type OhioCommitteeSourceControl = {
  fileName: string; productKey: OhioSosProductKey; transactionYear: number | null; byteSize: number; rowCount: number;
  sha256: string; nativeManifestSha256: string; retrievedAt: string;
};
type Capture = { version: 1; cycleYear: number; nativeFingerprint: string; controls: OhioCommitteeSourceControl[] };
export type OhioCommitteeSourceFacts = {
  cycleYear: number; nativeFingerprint: string; sourceManifestSha256: string; sourceByteSize: number;
  sourceRetrievedAt: string; sourceCompletedAt: string; sourceControls: OhioCommitteeSourceControl[];
};
type Book = ReturnType<ReturnType<typeof createOhioCommitteeReceiptAccumulator>["finish"]>;
const verified = new WeakMap<object, { book: Book; candidates: readonly bulk.OhioSosCandidateCommitteeListRow[] }>();
export type OhioCommitteeSourcePacket = Readonly<OhioCommitteeSourceFacts>;
const fingerprint = (c: OhioCommitteeSourceControl[]) => sha(ohioCommitteeCanonical(c));
function freeze<T extends object>(v: T): T { for (const x of Object.values(v)) if (x && typeof x === "object" && !Object.isFrozen(x)) freeze(x); return Object.freeze(v); }
export function isVerifiedOhioCommitteeSource(v: unknown): v is OhioCommitteeSourcePacket { return !!v && typeof v === "object" && verified.has(v); }
export function ohioCommitteeSourceCandidates(p: OhioCommitteeSourcePacket) {
  const data = verified.get(p); if (!data) ohioCommitteeHold("unverified_source_packet"); return data.candidates;
}
export function ohioCommitteeSourceComponent(p: OhioCommitteeSourcePacket, committeeId: string) {
  const data = verified.get(p); if (!data) ohioCommitteeHold("unverified_source_packet"); return freeze(data.book.component(committeeId));
}
async function directory(path: string) {
  const s = await lstat(path); if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o777) !== 0o700) ohioCommitteeHold("unsafe_source_directory");
}
async function bytes(path: string, max: number) {
  const s = await lstat(path); if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o777) !== 0o600 || s.size < 1 || s.size > max) ohioCommitteeHold("unsafe_source_file");
  const raw = await readFile(path); if (raw.length !== s.size) ohioCommitteeHold("source_file_changed"); return raw;
}
function decode(raw: Uint8Array) { try { return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw))); } catch { return ohioCommitteeHold("invalid_source_json"); } }
async function originalHash(path: string) {
  const s = await lstat(path); if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o777) !== 0o600 || s.size < 1 || s.size > MAX_FILE) ohioCommitteeHold("unsafe_source_file");
  const { hashOhioSosFile } = await import("./ohioSosArtifactCache.js"); return hashOhioSosFile(path);
}
function validateControl(c: OhioCommitteeSourceControl, role: ReturnType<typeof requiredRoles>[number]) {
  if (!c || c.fileName !== role.fileName || c.productKey !== role.productKey || c.transactionYear !== (role.transactionYear ?? null) ||
    !Number.isSafeInteger(c.byteSize) || c.byteSize < 1 || c.byteSize > MAX_FILE || !Number.isSafeInteger(c.rowCount) || c.rowCount < 1 || c.rowCount > 5_000_000 ||
    typeof c.sha256 !== "string" || !HASH.test(c.sha256) || typeof c.nativeManifestSha256 !== "string" || !HASH.test(c.nativeManifestSha256) || !isIso(c.retrievedAt) || Date.parse(c.retrievedAt) > Date.now()) ohioCommitteeHold("invalid_source_control");
}
export function validateOhioCommitteeSourceFacts(v: OhioCommitteeSourceFacts) {
  const roles = requiredRoles(v.cycleYear);
  if (!Array.isArray(v.sourceControls) || v.sourceControls.length !== roles.length || typeof v.sourceManifestSha256 !== "string" || !HASH.test(v.sourceManifestSha256) ||
    typeof v.nativeFingerprint !== "string" || !HASH.test(v.nativeFingerprint)) ohioCommitteeHold("invalid_source_facts");
  for (const [i, c] of v.sourceControls.entries()) validateControl(c, roles[i]!);
  const clocks = v.sourceControls.map(c => c.retrievedAt).sort(), size = v.sourceControls.reduce((n, c) => n + c.byteSize, 0);
  if (size !== v.sourceByteSize || size > MAX_TOTAL || v.sourceRetrievedAt !== clocks[0] || v.sourceCompletedAt !== clocks.at(-1) ||
    Date.parse(v.sourceCompletedAt) - Date.parse(v.sourceRetrievedAt) > 36 * 3600000 || fingerprint(v.sourceControls) !== v.nativeFingerprint) ohioCommitteeHold("source_control_closure");
}
function validateNativeManifest(m: Record<string, unknown>, c: OhioCommitteeSourceControl) {
  if (m.version !== 1 || m.productKey !== c.productKey || m.fileName !== c.fileName || m.transactionYear !== c.transactionYear ||
    m.fileTransferPageUrl !== OHIO_SOS_FILE_TRANSFER_PAGE_URL || m.retrievedAt !== c.retrievedAt || m.sha256 !== c.sha256 ||
    m.byteSize !== c.byteSize || m.rowCount !== c.rowCount || m.malformedRowCount !== 0 || m.encoding !== "windows-1252") ohioCommitteeHold("native_manifest_mismatch");
}
async function nativeControls(cycleYear: number, nativeRoot: string) {
  await directory(nativeRoot); const controls: OhioCommitteeSourceControl[] = [];
  for (const role of requiredRoles(cycleYear)) {
    const raw = await bytes(join(nativeRoot, role.fileName + ".manifest.json"), 4 * 1024 * 1024), m = decode(raw);
    const c = { fileName: role.fileName, productKey: role.productKey, transactionYear: role.transactionYear ?? null,
      byteSize: m.byteSize, rowCount: m.rowCount, sha256: m.sha256, retrievedAt: m.retrievedAt,
      nativeManifestSha256: sha(raw) } as OhioCommitteeSourceControl;
    validateControl(c, role); validateNativeManifest(m, c);
    if (m.filePath !== join(nativeRoot, role.fileName) || m.manifestPath !== join(nativeRoot, role.fileName + ".manifest.json")) ohioCommitteeHold("native_manifest_path_mismatch");
    controls.push(c);
  }
  return controls;
}
export async function readOhioCommitteeNativeHint(cycleYear: number) {
  try { return fingerprint(await nativeControls(cycleYear, resolve(process.env.OHIO_SOS_RAW_DATA_CACHE_DIR?.trim() || DEFAULT_OHIO_SOS_CACHE_DIR))); }
  catch { return null; }
}
type Reference = { manifest: string; sha256: string };
async function open(cycleYear: number, root: string) {
  try { await directory(root); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  let raw: Buffer;
  try { raw = await bytes(join(root, `latest-${year(cycleYear)}.json`), 4096); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  const ref = decode(raw) as unknown as Reference, parts = typeof ref.manifest === "string" ? ref.manifest.split("/") : [];
  if (parts.length !== 2 || !GENERATION.test(parts[0]!) || parts[1] !== "manifest.json" || !HASH.test(ref.sha256)) ohioCommitteeHold("invalid_capture_reference");
  const generation = join(root, parts[0]!); await directory(generation);
  const body = await bytes(join(generation, "manifest.json"), 4 * 1024 * 1024);
  if (sha(body) !== ref.sha256) ohioCommitteeHold("capture_manifest_hash_mismatch");
  const m = decode(body) as unknown as Capture;
  if (m.version !== 1 || m.cycleYear !== cycleYear || !Array.isArray(m.controls)) ohioCommitteeHold("capture_scope_mismatch");
  const clocks = m.controls.map(c => c.retrievedAt).sort(), facts: OhioCommitteeSourceFacts = { cycleYear,
    sourceManifestSha256: ref.sha256, nativeFingerprint: m.nativeFingerprint, sourceControls: m.controls,
    sourceByteSize: m.controls.reduce((n, c) => n + c.byteSize, 0), sourceRetrievedAt: clocks[0]!, sourceCompletedAt: clocks.at(-1)! };
  validateOhioCommitteeSourceFacts(facts); return { generation, facts };
}
export async function readOhioCommitteeSourceHint(input: { cycleYear: number; cacheDir?: string }) {
  try { const s = await open(input.cycleYear, resolve(input.cacheDir ?? DEFAULT_OHIO_COMMITTEE_CACHE_DIR));
    return s ? { nativeFingerprint: s.facts.nativeFingerprint, manifestSha256: s.facts.sourceManifestSha256, retrievedAt: s.facts.sourceRetrievedAt, completedAt: s.facts.sourceCompletedAt } : null;
  } catch (e) { if (e instanceof OhioCommitteeReceiptError) throw e; return ohioCommitteeHold("source_hint_unavailable"); }
}

export async function readOhioCommitteeSource(input: { cycleYear: number; cacheDir?: string }): Promise<OhioCommitteeSourcePacket | null> {
  try {
    const s = await open(input.cycleYear, resolve(input.cacheDir ?? DEFAULT_OHIO_COMMITTEE_CACHE_DIR)); if (!s) return null;
    async function read<T>(c: OhioCommitteeSourceControl, family: bulk.OhioSosBulkFileFamily<T>, visit: (r: T, fields: string[]) => void) {
      const meta = await bytes(join(s!.generation, c.fileName + ".manifest.json"), 4 * 1024 * 1024);
      if (sha(meta) !== c.nativeManifestSha256) ohioCommitteeHold("native_manifest_hash_mismatch"); validateNativeManifest(decode(meta), c);
      const path = join(s!.generation, c.fileName), h = await originalHash(path);
      if (h.sha256 !== c.sha256 || h.byteSize !== c.byteSize) ohioCommitteeHold("native_original_hash_mismatch"); let count = 0;
      await parseOhioSosCsvFile(path, { label: family.label, expectedHeader: family.header, visit: fields => { count++; visit(family.mapRow(fields), fields); } });
      if (count !== c.rowCount) ohioCommitteeHold("native_row_count_mismatch");
    }
    const candidates: bulk.OhioSosCandidateCommitteeListRow[] = [], pacs: bulk.OhioSosPacCommitteeListRow[] = [],
      covers: OhioCommitteeReportCover[] = [], pacCovers: bulk.OhioSosCoverPageRow[] = [], partyCovers: bulk.OhioSosCoverPageRow[] = [], controls = s.facts.sourceControls;
    await read(controls[0]!, bulk.OHIO_SOS_CANDIDATE_LIST_FAMILY, r => candidates.push(freeze(r)));
    await read(controls[1]!, bulk.OHIO_SOS_PAC_LIST_FAMILY, r => pacs.push(r));
    await read(controls[2]!, bulk.OHIO_SOS_CANDIDATE_COVER_FAMILY, (r, fields) => {
      const cover: OhioCommitteeReportCover = { ...r };
      for (const [key, column] of [["totalContributionsCents", "TOTAL_CONTRIBUTIONS"], ["valueInkindReceivedCents", "VALUE_INKIND_RECEIVED"]] as const) {
        try { cover[key] = strictOhioCommitteeCents(fields[bulk.OHIO_SOS_CANDIDATE_COVER_HEADER.indexOf(column)]); }
        catch { cover.invalidCommitteeMoney = true; }
      }
      covers.push(cover);
    });
    await read(controls[3]!, bulk.OHIO_SOS_PAC_COVER_FAMILY, r => pacCovers.push(r));
    await read(controls[4]!, bulk.OHIO_SOS_PARTY_COVER_FAMILY, r => partyCovers.push(r));
    const accumulator = createOhioCommitteeReceiptAccumulator({ electionYear: input.cycleYear, candidateListRows: candidates, pacListRows: pacs,
      candidateCoverRows: covers, pacCoverRows: pacCovers, partyCoverRows: partyCovers });
    for (const c of controls.slice(5)) await read(c, bulk.OHIO_SOS_CANDIDATE_CONTRIBUTIONS_FAMILY, (r, fields) => {
      try { r.amountCents = strictOhioCommitteeCents(fields[bulk.OHIO_SOS_CANDIDATE_CONTRIBUTIONS_HEADER.indexOf("AMOUNT")]); } catch { r.amountCents = null; }
      accumulator.add(r, c.transactionYear!);
    });
    for (const c of controls) { const h = await originalHash(join(s.generation, c.fileName));
      if (h.sha256 !== c.sha256 || h.byteSize !== c.byteSize) ohioCommitteeHold("source_changed_during_replay"); }
    const packet = freeze({ ...s.facts }); verified.set(packet, { book: accumulator.finish(), candidates: Object.freeze(candidates) }); return packet;
  } catch (e) { if (e instanceof OhioCommitteeReceiptError) throw e; return ohioCommitteeHold("source_replay_unavailable"); }
}

/** Imports already-acquired native originals. Network acquisition stays in
 * the separately gated attended Ohio raw-refresh workflow. Copying originals
 * preserves their actual clocks and never creates a newer financial date. */
export async function captureOhioCommitteeSource(input: { cycleYear: number; cacheDir?: string; nativeCacheDir?: string }): Promise<OhioCommitteeSourcePacket> {
  const root = resolve(input.cacheDir ?? DEFAULT_OHIO_COMMITTEE_CACHE_DIR), nativeRoot = resolve(input.nativeCacheDir ?? (process.env.OHIO_SOS_RAW_DATA_CACHE_DIR?.trim() || DEFAULT_OHIO_SOS_CACHE_DIR));
  const controls = await nativeControls(input.cycleYear, nativeRoot), nativeFingerprint = fingerprint(controls);
  try { if ((await readOhioCommitteeSourceHint(input))?.nativeFingerprint === nativeFingerprint) {
    const existing = await readOhioCommitteeSource(input); if (existing) return existing;
  } } catch (e) { if (!(e instanceof OhioCommitteeReceiptError)) throw e; /* New verified originals can repair a corrupt saved capture. */ }
  await mkdir(root, { recursive: true, mode: 0o700 }); await directory(root);
  const gen = `generation-${randomUUID()}`, generation = join(root, gen); await mkdir(generation, { mode: 0o700 });
  for (const c of controls) {
    const h = await originalHash(join(nativeRoot, c.fileName));
    if (h.sha256 !== c.sha256 || h.byteSize !== c.byteSize) ohioCommitteeHold("native_original_hash_mismatch");
    await copyFile(join(nativeRoot, c.fileName), join(generation, c.fileName));
    const raw = await bytes(join(nativeRoot, c.fileName + ".manifest.json"), 4 * 1024 * 1024);
    if (sha(raw) !== c.nativeManifestSha256) ohioCommitteeHold("native_manifest_changed");
    await writeFile(join(generation, c.fileName + ".manifest.json"), raw, { flag: "wx", mode: 0o600 });
  }
  if (fingerprint(await nativeControls(input.cycleYear, nativeRoot)) !== nativeFingerprint) ohioCommitteeHold("native_source_changed");
  const body = JSON.stringify({ version: 1, cycleYear: input.cycleYear, nativeFingerprint, controls } satisfies Capture);
  await writeFile(join(generation, "manifest.json"), body, { flag: "wx", mode: 0o600 });
  // Validate/replay before installing the public pointer. A provisional
  // pointer exists only in this private generation, so failure keeps latest.
  const reference = JSON.stringify({ manifest: `${gen}/manifest.json`, sha256: sha(body) }), staging = join(root, `staging-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  // readOhioCommitteeSource resolves generation paths under its cache root.
  // Install the generation into the isolated staging root for qualification.
  await rename(generation, join(staging, gen));
  await writeFile(join(staging, `latest-${input.cycleYear}.json`), reference, { flag: "wx", mode: 0o600 });
  const packet = await readOhioCommitteeSource({ cycleYear: input.cycleYear, cacheDir: staging });
  if (!packet) ohioCommitteeHold("source_qualification_failed");
  await rename(join(staging, gen), generation);
  const temporary = join(root, `latest-${input.cycleYear}.tmp-${randomUUID()}`);
  await writeFile(temporary, reference, { flag: "wx", mode: 0o600 }); await rename(temporary, join(root, `latest-${input.cycleYear}.json`));
  return packet;
}
