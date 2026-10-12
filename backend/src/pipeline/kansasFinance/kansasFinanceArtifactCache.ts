// Kansas finance artifact cache (docs/plans/plan-kansas-finance.md, Phase 1).
//
// Follows the Missouri/Montana filesystem cache pattern (sha256 manifests,
// atomic tmp-rename writes, 0700/0600 modes, gitignored scratch dir) with
// the Kansas-specific requirement from the plan: artifact versions are
// IMMUTABLE — changed bytes at the same key become a NEW version that
// records which sha it supersedes; prior versions stay readable. A
// `latest.json` pointer names the current version.
//
// The cache is content-agnostic on purpose: Phase 1 bodies are a mix of
// scanned PDFs, viewer export tables, and index HTML, and their parsers'
// validation belongs to the Phase 2 readers. Integrity here is byte-level
// (sha256 verified on every read). Viewer exports carry contributor PII
// (K.S.A. 25-4154(d)) — the restricted modes are load-bearing and the
// directory must never be committed.

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const DEFAULT_KANSAS_FINANCE_CACHE_DIR = "scratch/kansas-campaign-finance/artifacts";
export const KANSAS_FINANCE_ARTIFACT_SCHEMA_VERSION = 1;

export type KansasFinanceArtifactKind =
  /** Original paper PDF opened from the SOS IndividualEntity viewer. */
  | "viewer_pdf"
  /** Scanned filing PDF from the CFAScanned tree (id = path under the tree). */
  | "kpdc_pdf"
  /** CFAScanned link-tree index page (id = path under the tree). */
  | "kpdc_index"
  /** Viewer btnExport table body (id = the search recipe's label). */
  | "viewer_export"
  /** Viewer-rendered report HTML (id = the walk recipe's label). */
  | "viewer_report_html";

export type KansasFinanceArtifactKey = {
  kind: KansasFinanceArtifactKind;
  /**
   * Stable caller-chosen identifier; may contain "/" to mirror source
   * trees (e.g. "House/2026ElecCycle/202607/H001DH_202607.pdf").
   */
  id: string;
};

export type KansasFinanceArtifactManifest = {
  version: typeof KANSAS_FINANCE_ARTIFACT_SCHEMA_VERSION;
  key: KansasFinanceArtifactKey;
  sourceUrl: string;
  retrievedAt: string;
  sha256: string;
  byteSize: number;
  /**
   * sha256 of the version that was latest when these bytes were FIRST
   * stored (null for a key's first version). Manifests are immutable, so
   * after a reversion to older bytes this records first-occurrence
   * lineage, not the current pointer — `latest.json` holds currency.
   */
  supersedes: string | null;
};

const KINDS = new Set<KansasFinanceArtifactKind>([
  "viewer_pdf",
  "kpdc_pdf",
  "kpdc_index",
  "viewer_export",
  "viewer_report_html",
]);

function normalizeKey(key: KansasFinanceArtifactKey): KansasFinanceArtifactKey {
  if (!KINDS.has(key.kind)) {
    throw new Error(`Invalid Kansas finance artifact kind: ${String(key.kind)}`);
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(key.id) ||
    key.id.includes("..") ||
    key.id.includes("//") ||
    key.id.endsWith("/")
  ) {
    throw new Error(`Invalid Kansas finance artifact id: ${key.id}`);
  }
  return { kind: key.kind, id: key.id };
}

function keyDir(cacheDir: string, key: KansasFinanceArtifactKey): string {
  return resolve(cacheDir, key.kind, key.id);
}

function sha256Hex(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

async function atomicWrite(path: string, body: Buffer | string, mode: number): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, body, { mode });
  try {
    await rename(temporary, path);
    await chmod(path, mode);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function readLatestSha(dir: string): Promise<string | null> {
  try {
    const pointer = JSON.parse(await readFile(resolve(dir, "latest.json"), "utf8")) as {
      sha256?: unknown;
    };
    if (typeof pointer.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(pointer.sha256)) {
      throw new Error(`Corrupt latest.json in ${dir}`);
    }
    return pointer.sha256;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Store one fetched artifact. Byte-identical to the current version →
 * nothing is written and `changed` is false. New bytes → a new immutable
 * version is written (`supersedes` = the sha that was latest at that
 * moment) and `latest.json` repointed. Bytes govern identity: a version's
 * files are written exactly ONCE — if the source REVERTS to bytes seen
 * before (A→B→A), only `latest.json` is repointed and A keeps its original
 * manifest (first-occurrence retrievedAt and supersedes), so history never
 * cycles. `changed` is true whenever the latest pointer moved, which is
 * what triggers renormalization downstream.
 */
export async function storeKansasFinanceArtifact(input: {
  cacheDir?: string;
  key: KansasFinanceArtifactKey;
  sourceUrl: string;
  body: Buffer | Uint8Array | string;
  retrievedAt?: Date;
}): Promise<{ manifest: KansasFinanceArtifactManifest; changed: boolean }> {
  const key = normalizeKey(input.key);
  const retrievedAt = input.retrievedAt ?? new Date();
  if (Number.isNaN(retrievedAt.getTime())) {
    throw new Error("Invalid Kansas finance artifact timestamp");
  }
  const body = Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body as Uint8Array | string);
  if (body.byteLength === 0) {
    throw new Error(`Refusing to store empty Kansas finance artifact: ${key.kind} ${key.id}`);
  }
  const sha256 = sha256Hex(body);
  const dir = keyDir(input.cacheDir ?? DEFAULT_KANSAS_FINANCE_CACHE_DIR, key);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const latestSha = await readLatestSha(dir);
  if (latestSha === sha256) {
    const existing = await readKansasFinanceArtifact({ cacheDir: input.cacheDir, key });
    return { manifest: existing.manifest, changed: false };
  }
  // A reversion to previously-seen bytes reuses that version untouched —
  // rewriting its manifest would destroy its original timestamp and make
  // the supersession record cyclic.
  const previous = await tryReadVersion(dir, key, sha256);
  if (previous !== null) {
    await atomicWrite(resolve(dir, "latest.json"), `${JSON.stringify({ sha256 }, null, 2)}\n`, 0o600);
    return { manifest: previous.manifest, changed: true };
  }
  const manifest: KansasFinanceArtifactManifest = {
    version: KANSAS_FINANCE_ARTIFACT_SCHEMA_VERSION,
    key,
    sourceUrl: input.sourceUrl,
    retrievedAt: retrievedAt.toISOString(),
    sha256,
    byteSize: body.byteLength,
    supersedes: latestSha,
  };
  await atomicWrite(resolve(dir, `v-${sha256}.bin`), body, 0o600);
  await atomicWrite(resolve(dir, `v-${sha256}.manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  await atomicWrite(resolve(dir, "latest.json"), `${JSON.stringify({ sha256 }, null, 2)}\n`, 0o600);
  return { manifest, changed: true };
}

async function tryReadVersion(
  dir: string,
  key: KansasFinanceArtifactKey,
  sha256: string
): Promise<{ body: Buffer; manifest: KansasFinanceArtifactManifest } | null> {
  let body: Buffer;
  let manifest: KansasFinanceArtifactManifest;
  try {
    [body, manifest] = await Promise.all([
      readFile(resolve(dir, `v-${sha256}.bin`)),
      readFile(resolve(dir, `v-${sha256}.manifest.json`), "utf8").then(
        (value) => JSON.parse(value) as KansasFinanceArtifactManifest
      ),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (
    manifest.version !== KANSAS_FINANCE_ARTIFACT_SCHEMA_VERSION ||
    manifest.key.kind !== key.kind ||
    manifest.key.id !== key.id ||
    manifest.sha256 !== sha256 ||
    manifest.byteSize !== body.byteLength ||
    sha256Hex(body) !== sha256
  ) {
    throw new Error(`Corrupt Kansas finance artifact: ${key.kind} ${key.id} ${sha256}`);
  }
  return { body, manifest };
}

async function readVersion(
  dir: string,
  key: KansasFinanceArtifactKey,
  sha256: string
): Promise<{ body: Buffer; manifest: KansasFinanceArtifactManifest }> {
  const version = await tryReadVersion(dir, key, sha256);
  if (version === null) {
    throw new Error(`Missing Kansas finance artifact version: ${key.kind} ${key.id} ${sha256}`);
  }
  return version;
}

/** Read the latest version of an artifact; sha256 is verified byte-for-byte. */
export async function readKansasFinanceArtifact(input: {
  cacheDir?: string;
  key: KansasFinanceArtifactKey;
}): Promise<{ body: Buffer; manifest: KansasFinanceArtifactManifest }> {
  const key = normalizeKey(input.key);
  const dir = keyDir(input.cacheDir ?? DEFAULT_KANSAS_FINANCE_CACHE_DIR, key);
  const latestSha = await readLatestSha(dir);
  if (latestSha === null) {
    throw new Error(`Missing Kansas finance artifact: ${key.kind} ${key.id}`);
  }
  return readVersion(dir, key, latestSha);
}

/** Read one specific immutable version (supersession-chain walks). */
export async function readKansasFinanceArtifactVersion(input: {
  cacheDir?: string;
  key: KansasFinanceArtifactKey;
  sha256: string;
}): Promise<{ body: Buffer; manifest: KansasFinanceArtifactManifest }> {
  const key = normalizeKey(input.key);
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) {
    throw new Error(`Invalid Kansas finance artifact sha256: ${input.sha256}`);
  }
  return readVersion(keyDir(input.cacheDir ?? DEFAULT_KANSAS_FINANCE_CACHE_DIR, key), key, input.sha256);
}
