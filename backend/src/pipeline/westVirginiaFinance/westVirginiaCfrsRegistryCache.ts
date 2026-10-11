import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  getAllWestVirginiaCommittees,
  WEST_VIRGINIA_CFRS_PUBLIC_SERVICE_BASE_URL,
  type WestVirginiaCfrsClientOptions,
  type WestVirginiaCommitteeRow,
} from "./westVirginiaCfrsClient.js";

const VERSION = 1;
const PAGE_SIZE = 5_000;
const SCOPE = "all_types_all_statuses_all_elections";
const SOURCE_URL = `${WEST_VIRGINIA_CFRS_PUBLIC_SERVICE_BASE_URL}/Committee/getPublicCandidatesCommitteeDataList`;

type RegistryBody = {
  version: 1;
  scope: typeof SCOPE;
  request: { pageSize: number };
  rows: WestVirginiaCommitteeRow[];
};

export type WestVirginiaCommitteeRegistryMetadata = {
  version: 1;
  artifact: "committee_registry";
  scope: typeof SCOPE;
  request: { pageSize: number };
  sourceUrl: string;
  filePath: string;
  metadataPath: string;
  downloadedAt: string;
  bytes: number;
  sha256: string;
  recordCount: number;
};

export type WestVirginiaCommitteeRegistryRefreshResult = {
  status: "downloaded" | "unchanged";
  cacheDir: string;
  filePath: string;
  metadataPath: string;
  previous: WestVirginiaCommitteeRegistryMetadata | null;
  current: WestVirginiaCommitteeRegistryMetadata;
};

const NULLABLE_FIELDS = [
  "orgName", "candidateName", "orgSubType", "office", "district",
  "party", "election", "registrationYear",
] as const;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid West Virginia registry object");
  return value as Record<string, unknown>;
}

function validateRows(value: unknown): WestVirginiaCommitteeRow[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("West Virginia registry snapshot must contain rows");
  for (const valueRow of value) {
    const row = object(valueRow);
    if (!Number.isSafeInteger(row.orgID) || Number(row.orgID) <= 0 ||
        typeof row.entityId !== "string" || !/^\d{10}$/.test(row.entityId)) {
      throw new Error("Invalid West Virginia registry committee identity");
    }
    for (const field of ["orgType", "orgTypeCode", "orgStatus"] as const) {
      if (typeof row[field] !== "string" || !row[field].trim()) {
        throw new Error(`Invalid West Virginia registry ${field}`);
      }
    }
    for (const field of NULLABLE_FIELDS) {
      if (row[field] !== null && typeof row[field] !== "string") {
        throw new Error(`Invalid West Virginia registry ${field}`);
      }
    }
  }
  // All identities, aliases and source multiplicities are retained. Neither
  // active status nor an election year is a donor-identity filter.
  return value as WestVirginiaCommitteeRow[];
}

function canonicalRows(rows: WestVirginiaCommitteeRow[]): WestVirginiaCommitteeRow[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).sort(([left], [right]) => left.localeCompare(right))) as WestVirginiaCommitteeRow)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function paths(cacheDir: string) {
  const directory = resolve(cacheDir);
  return { cacheDir: directory, metadataPath: resolve(directory, "REGISTRY.metadata.json") };
}

function contentPath(cacheDir: string, sha256: string) {
  return resolve(cacheDir, `REGISTRY.${sha256}.json`);
}

function hash(bytes: string | Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeAtomically(path: string, data: string) {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, data, { mode: 0o600 });
    await chmod(temporary, 0o600);
    // Rename preserves the private mode; perform no fallible work after the
    // pointer commit that could report failure after publishing valid data.
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function parseMetadata(value: unknown, cacheDir: string): WestVirginiaCommitteeRegistryMetadata {
  const metadata = object(value);
  const expected = paths(cacheDir);
  if (metadata.version !== VERSION || metadata.artifact !== "committee_registry" ||
      metadata.scope !== SCOPE || object(metadata.request).pageSize !== PAGE_SIZE ||
      Object.keys(object(metadata.request)).length !== 1 ||
      metadata.sourceUrl !== SOURCE_URL || typeof metadata.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(metadata.sha256) ||
      metadata.filePath !== contentPath(expected.cacheDir, metadata.sha256) ||
      metadata.metadataPath !== expected.metadataPath ||
      typeof metadata.downloadedAt !== "string" || Number.isNaN(Date.parse(metadata.downloadedAt)) ||
      !Number.isSafeInteger(metadata.bytes) || Number(metadata.bytes) <= 0 ||
      !Number.isSafeInteger(metadata.recordCount) || Number(metadata.recordCount) <= 0) {
    throw new Error("Invalid West Virginia registry cache metadata");
  }
  return metadata as unknown as WestVirginiaCommitteeRegistryMetadata;
}

/** Cache-only read; acquisition failures never become an empty donor registry. */
export async function readWestVirginiaCommitteeRegistryArtifact(input: { cacheDir: string }): Promise<{
  metadata: WestVirginiaCommitteeRegistryMetadata;
  rows: WestVirginiaCommitteeRow[];
}> {
  const { cacheDir, metadataPath } = paths(input.cacheDir);
  try {
    const metadata = parseMetadata(JSON.parse(await readFile(metadataPath, "utf8")), cacheDir);
    const bytes = await readFile(metadata.filePath);
    if (bytes.length !== metadata.bytes || hash(bytes) !== metadata.sha256) {
      throw new Error("West Virginia registry cache checksum mismatch");
    }
    const body = object(JSON.parse(bytes.toString("utf8")));
    if (body.version !== VERSION || body.scope !== SCOPE ||
        object(body.request).pageSize !== PAGE_SIZE || Object.keys(object(body.request)).length !== 1) {
      throw new Error("Invalid West Virginia registry request scope");
    }
    const rows = validateRows(body.rows);
    if (rows.length !== metadata.recordCount) throw new Error("West Virginia registry cache record count mismatch");
    return { metadata, rows };
  } catch (error) {
    throw new Error(`West Virginia registry cache unavailable at ${metadataPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** One full paginated request with no type, status or donor election filters. */
export async function refreshWestVirginiaCommitteeRegistryArtifact(input: {
  cacheDir: string;
  clientOptions?: WestVirginiaCfrsClientOptions;
  fetchCommittees?: typeof getAllWestVirginiaCommittees;
  now?: Date;
}): Promise<WestVirginiaCommitteeRegistryRefreshResult> {
  const cache = paths(input.cacheDir);
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error("Invalid West Virginia registry refresh timestamp");
  let previous: WestVirginiaCommitteeRegistryMetadata | null = null;
  try { previous = (await readWestVirginiaCommitteeRegistryArtifact({ cacheDir: cache.cacheDir })).metadata; }
  catch { /* A fresh validated acquisition may repair a missing/corrupt cache. */ }
  const rows = canonicalRows(validateRows(await (input.fetchCommittees ?? getAllWestVirginiaCommittees)(
    { pageSize: PAGE_SIZE }, input.clientOptions
  )));
  const body: RegistryBody = { version: VERSION, scope: SCOPE, request: { pageSize: PAGE_SIZE }, rows };
  const serialized = JSON.stringify(body);
  const sha256 = hash(serialized);
  const filePath = contentPath(cache.cacheDir, sha256);
  const current: WestVirginiaCommitteeRegistryMetadata = {
    version: VERSION, artifact: "committee_registry", scope: SCOPE, request: { pageSize: PAGE_SIZE },
    sourceUrl: SOURCE_URL, filePath, metadataPath: cache.metadataPath,
    downloadedAt: now.toISOString(), bytes: Buffer.byteLength(serialized), sha256, recordCount: rows.length,
  };
  // Content is committed before the metadata pointer. A failed acquisition or
  // content write cannot displace the last good snapshot.
  await mkdir(cache.cacheDir, { recursive: true, mode: 0o700 });
  await chmod(cache.cacheDir, 0o700);
  await writeAtomically(filePath, serialized);
  await writeAtomically(cache.metadataPath, JSON.stringify(current, null, 2));
  return { status: previous?.sha256 === sha256 ? "unchanged" : "downloaded", ...cache, filePath, previous, current };
}
