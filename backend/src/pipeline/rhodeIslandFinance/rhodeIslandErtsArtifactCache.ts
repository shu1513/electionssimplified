import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  extractErtsPdfPageItems,
  countErtsPdfPages,
  parseErtsContributionExport,
  parseErtsCf8IndexPage,
  parseErtsFilingListPage,
  parseErtsFilingVersionsPage,
  parseErtsOrganizationSearchRows,
  parseErtsSummaryGroupings,
  classifyErtsSearchResult,
  ERTS_CF8_INDEX_GRID_ID,
  ERTS_CONTRIBUTION_RESULT_GRID_ID,
  ERTS_CONTRIBUTION_SUMMARY_GRID_ID,
  ERTS_EXPENDITURE_RESULT_GRID_ID,
  ERTS_EXPENDITURE_SUMMARY_GRID_ID,
  ERTS_FILING_LIST_GRID_ID,
  ERTS_ORG_SEARCH_GRID_ID,
  RHODE_ISLAND_ERTS_PARSER_VERSION,
} from "./rhodeIslandErtsParsers.js";

// Artifact cache for ERTS portal fetches (north carolina cache pattern:
// validate → SHA-256 → atomic install + manifest). The acquisition hands each
// fetched body to this module, which re-validates it against the pinned
// parser for its artifact type, hashes it, and atomically installs bytes plus
// manifest. The finance sync reads the cache only and never touches the
// portal. Rhode Island artifacts are many small per-organization fetches —
// report pages, exports, filing lists, CF-2 PDFs — keyed by artifact type +
// portal ids.
//
// Unlike the NCSBE cache, bodies here are not all text: CF-2 version PDFs are
// binary, so the cache operates on bytes throughout and callers decode text
// artifacts themselves.

export const DEFAULT_RHODE_ISLAND_ERTS_CACHE_DIR = "scratch/rhode-island-campaign-finance/erts-cache";

// Bumped whenever a manifest field changes, so a stale snapshot is
// re-validated rather than trusted.
export const RHODE_ISLAND_ERTS_ARTIFACT_SCHEMA_VERSION = 1;

export type ErtsArtifactKey =
  | { type: "organization_search"; query: string }
  | { type: "organization_filings"; orgId: string }
  | { type: "filing_versions"; filingId: string }
  | { type: "filing_pdf"; filingId: string; guid: string }
  | { type: "contribution_report"; orgId: string; beginIso: string; endIso: string }
  | { type: "expenditure_report"; orgId: string; beginIso: string; endIso: string }
  | { type: "contribution_export"; orgId: string; beginIso: string; endIso: string }
  | { type: "cf8_index_page"; page: number }
  | { type: "cf8_scan"; guid: string };

function slugifyErtsQuery(query: string): string {
  const slug = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length === 0) {
    throw new Error(`ERTS organization-search query has no cacheable slug: ${JSON.stringify(query)}`);
  }
  // The readable slug is lossy, so a hash of the exact query keeps distinct
  // searches in distinct files.
  const queryHash = createHash("sha256").update(query, "utf8").digest("hex").slice(0, 8);
  return `${slug}-${queryHash}`;
}

function requireNumericId(value: string, label: string): string {
  if (!/^\d+$/.test(value)) {
    throw new Error(`ERTS ${label} is not numeric: ${JSON.stringify(value)}`);
  }
  return value;
}

function requireIsoDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`ERTS ${label} is not an ISO date: ${JSON.stringify(value)}`);
  }
  return value;
}

function requirePdfGuid(value: string): string {
  // GUIDs from /ExportDocs/ URLs; validated so a path traversal is
  // structurally impossible even though the value comes from parsed portal
  // data.
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`ERTS filing PDF guid is not a GUID: ${JSON.stringify(value)}`);
  }
  return value.toLowerCase();
}

function reportWindowDir(orgId: string, beginIso: string, endIso: string): string {
  return (
    `org/${requireNumericId(orgId, "organization key")}/report/` +
    `${requireIsoDate(beginIso, "period begin")}_${requireIsoDate(endIso, "period end")}`
  );
}

// Relative artifact path under the cache directory.
export function ertsArtifactRelativePath(key: ErtsArtifactKey): string {
  switch (key.type) {
    case "organization_search":
      return `organization-search/${slugifyErtsQuery(key.query)}.html`;
    case "organization_filings":
      return `org/${requireNumericId(key.orgId, "organization key")}/filings.html`;
    case "filing_versions":
      return `filing/${requireNumericId(key.filingId, "filing id")}/versions.html`;
    case "filing_pdf":
      return `filing/${requireNumericId(key.filingId, "filing id")}/${requirePdfGuid(key.guid)}.pdf`;
    case "cf8_scan":
      return `cf8-scans/${requirePdfGuid(key.guid)}.pdf`;
    case "contribution_report":
      return `${reportWindowDir(key.orgId, key.beginIso, key.endIso)}/contributions.html`;
    case "expenditure_report":
      return `${reportWindowDir(key.orgId, key.beginIso, key.endIso)}/expenditures.html`;
    case "contribution_export":
      return `${reportWindowDir(key.orgId, key.beginIso, key.endIso)}/contributions.csv`;
    case "cf8_index_page":
      if (!Number.isInteger(key.page) || key.page < 1) {
        throw new Error(`ERTS cf8_index_page page is invalid: ${key.page}`);
      }
      return `cf8-index/page-${key.page}.html`;
  }
}

export type ErtsArtifactPaths = {
  cacheDir: string;
  filePath: string;
  manifestPath: string;
};

export function getErtsArtifactPaths(input: { cacheDir: string; key: ErtsArtifactKey }): ErtsArtifactPaths {
  const cacheDir = resolve(input.cacheDir);
  const filePath = resolve(cacheDir, ertsArtifactRelativePath(input.key));
  return { cacheDir, filePath, manifestPath: `${filePath}.manifest.json` };
}

// Provenance recorded with an artifact. Raw portal strings — interpretation
// happens at selection/aggregation time, not here. Every field is optional
// because different artifact types carry different context.
export type ErtsArtifactSourceMetadata = {
  organizationName?: string | null;
  reportType?: string | null;
  periodBegin?: string | null;
  periodEnd?: string | null;
  filedAt?: string | null;
  amended?: boolean | null;
  amendmentLabel?: string | null;
  // Report pages only: "rows" or "no_rows" as classified at fetch time.
  classification?: string | null;
  // CF-8 index pages only: how many pages the run installed, so the sync
  // reads exactly pages 1..N of one vintage and never mixes in a stale
  // higher-numbered page from an older, longer traversal.
  cf8PageCount?: number | null;
};

export type ErtsArtifactManifest = {
  version: typeof RHODE_ISLAND_ERTS_ARTIFACT_SCHEMA_VERSION;
  parserVersion: number;
  key: ErtsArtifactKey;
  url: string;
  filePath: string;
  manifestPath: string;
  retrievedAt: string;
  sha256: string;
  byteSize: number;
  // Rows validated in this artifact: search rows, filing rows, versions,
  // summary groupings, export rows, CF-8 rows — or PDF page-1 text items.
  rowCount: number;
  source: ErtsArtifactSourceMetadata | null;
};

const utf8 = new TextDecoder("utf-8", { fatal: true });

function bodyToBuffer(body: string | Uint8Array): Buffer {
  return typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
}

// Re-validates the body against the pinned parser for its artifact type and
// returns the validated row count. A body that stopped matching the pinned
// shape can never be installed. Async because PDF validation reads the text
// layer (a scanned image PDF has none and must fail — the CF-2 totals
// mapping depends on it).
export async function validateErtsArtifactBody(key: ErtsArtifactKey, body: string | Uint8Array): Promise<number> {
  if (key.type === "cf8_scan") {
    const bytes = bodyToBuffer(body);
    if (bytes.toString("latin1", 0, 5) !== "%PDF-" || !/%%EOF\s*$/u.test(bytes.toString("latin1", Math.max(0, bytes.length - 1024))))
      throw new Error("ERTS scanned PDF original is incomplete");
    return countErtsPdfPages(new Uint8Array(bytes));
  }
  if (key.type === "filing_pdf") {
    const bytes = bodyToBuffer(body);
    if (bytes.length < 5 || bytes.toString("latin1", 0, 5) !== "%PDF-") {
      throw new Error("ERTS filing PDF body does not start with %PDF-");
    }
    const items = await extractErtsPdfPageItems(new Uint8Array(bytes));
    if (items.length === 0) {
      throw new Error("ERTS filing PDF has no text layer on page 1");
    }
    return items.length;
  }

  const text = utf8.decode(bodyToBuffer(body));
  const requireMarker = (marker: string): void => {
    if (!text.includes(marker)) {
      throw new Error(`ERTS ${key.type} body does not contain its ${JSON.stringify(marker)} grid`);
    }
  };
  switch (key.type) {
    case "organization_search":
      requireMarker(ERTS_ORG_SEARCH_GRID_ID);
      return parseErtsOrganizationSearchRows(text).length;
    case "organization_filings":
      requireMarker(ERTS_FILING_LIST_GRID_ID);
      return parseErtsFilingListPage(text).length;
    case "filing_versions": {
      requireMarker("grdAmendments");
      const versions = parseErtsFilingVersionsPage(text);
      if (versions.length === 0) {
        throw new Error("ERTS filing_versions body rendered no version rows");
      }
      return versions.length;
    }
    case "contribution_report":
    case "expenditure_report": {
      const resultGridId =
        key.type === "contribution_report" ? ERTS_CONTRIBUTION_RESULT_GRID_ID : ERTS_EXPENDITURE_RESULT_GRID_ID;
      const summaryGridId =
        key.type === "contribution_report" ? ERTS_CONTRIBUTION_SUMMARY_GRID_ID : ERTS_EXPENDITURE_SUMMARY_GRID_ID;
      const classification = classifyErtsSearchResult(text, resultGridId);
      if (classification === "unreadable") {
        throw new Error(`ERTS ${key.type} body is neither a result grid nor a no-rows page`);
      }
      // A no-rows window is a valid, cacheable state with zero groupings.
      if (classification === "no_rows") {
        return 0;
      }
      // A page with itemized rows must also carry the official summary block
      // — the summary, not the rows, is the totals source (decision 2), so a
      // drifted summary grid must fail here rather than cache a page a sync
      // could read as zero totals.
      const groupings = parseErtsSummaryGroupings(text, summaryGridId);
      if (groupings.size === 0) {
        throw new Error(`ERTS ${key.type} body has a result grid but no readable summary groupings`);
      }
      return groupings.size;
    }
    case "contribution_export":
      return parseErtsContributionExport(text).length;
    case "cf8_index_page": {
      requireMarker(ERTS_CF8_INDEX_GRID_ID);
      const rows = parseErtsCf8IndexPage(text);
      if (rows.length === 0) {
        throw new Error("ERTS cf8_index_page body rendered no filing rows");
      }
      return rows.length;
    }
  }
}

export function hashErtsArtifactBody(body: string | Uint8Array): { sha256: string; byteSize: number } {
  const buffer = bodyToBuffer(body);
  return { sha256: createHash("sha256").update(buffer).digest("hex"), byteSize: buffer.byteLength };
}

async function writeFileAtomically(path: string, content: Buffer | string): Promise<void> {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, content);
  try {
    await rename(tmpPath, path);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

// Validates the body, then atomically installs bytes + manifest. Validation
// runs before anything is replaced, so a bad fetch can never destroy a good
// snapshot.
export async function storeErtsArtifact(input: {
  cacheDir: string;
  key: ErtsArtifactKey;
  url: string;
  body: string | Uint8Array;
  source?: ErtsArtifactSourceMetadata | null;
  retrievedAt?: Date;
}): Promise<ErtsArtifactManifest> {
  const retrievedAt = input.retrievedAt ?? new Date();
  if (Number.isNaN(retrievedAt.getTime())) {
    throw new Error("Invalid ERTS artifact retrieval timestamp");
  }
  const rowCount = await validateErtsArtifactBody(input.key, input.body);
  const { sha256, byteSize } = hashErtsArtifactBody(input.body);
  const paths = getErtsArtifactPaths(input);

  await mkdir(dirname(paths.filePath), { recursive: true });
  await writeFileAtomically(paths.filePath, bodyToBuffer(input.body));

  const manifest: ErtsArtifactManifest = {
    version: RHODE_ISLAND_ERTS_ARTIFACT_SCHEMA_VERSION,
    parserVersion: RHODE_ISLAND_ERTS_PARSER_VERSION,
    key: input.key,
    url: input.url,
    filePath: paths.filePath,
    manifestPath: paths.manifestPath,
    retrievedAt: retrievedAt.toISOString(),
    sha256,
    byteSize,
    rowCount,
    source: input.source ?? null,
  };
  // Two renames, so a crash between them leaves new bytes with the old
  // manifest; the SHA-256 re-check in getErtsArtifactStatus surfaces that as
  // "stale" (these artifacts are small enough to hash on every status call).
  await writeFileAtomically(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function readErtsArtifactManifest(manifestPath: string): Promise<ErtsArtifactManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as Partial<ErtsArtifactManifest>;
    if (
      parsed.version !== RHODE_ISLAND_ERTS_ARTIFACT_SCHEMA_VERSION ||
      typeof parsed.parserVersion !== "number" ||
      typeof parsed.url !== "string" ||
      typeof parsed.sha256 !== "string" ||
      typeof parsed.byteSize !== "number" ||
      typeof parsed.rowCount !== "number" ||
      typeof parsed.retrievedAt !== "string" ||
      typeof parsed.key !== "object" ||
      parsed.key === null
    ) {
      return null;
    }
    return parsed as ErtsArtifactManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    console.warn(`Unexpected error reading ERTS artifact manifest at ${manifestPath}:`, error);
    return null;
  }
}

export type ErtsArtifactStatus = {
  key: ErtsArtifactKey;
  filePath: string;
  // "ready" — the bytes hash to the manifest's SHA-256, the manifest's key
  // identifies this artifact, and the current parser validated it; "stale" —
  // any of those no longer holds; "missing" — not fetched yet.
  status: "ready" | "stale" | "missing";
  manifest: ErtsArtifactManifest | null;
  // Present only when status is "ready", so callers never re-read bytes the
  // hash check already loaded. Text artifacts decode with utf8; PDFs are
  // consumed as bytes.
  bytes: Buffer | null;
};

// The manifest must describe the artifact that was asked for — a manifest
// copied or renamed into another key's path must read as stale, not ready.
function manifestKeyMatches(manifest: ErtsArtifactManifest, key: ErtsArtifactKey): boolean {
  try {
    return manifest.key.type === key.type && ertsArtifactRelativePath(manifest.key) === ertsArtifactRelativePath(key);
  } catch {
    return false;
  }
}

export async function getErtsArtifactStatus(input: {
  cacheDir: string;
  key: ErtsArtifactKey;
}): Promise<ErtsArtifactStatus> {
  const paths = getErtsArtifactPaths(input);
  const manifest = await readErtsArtifactManifest(paths.manifestPath);
  let bytes: Buffer | null = null;
  try {
    bytes = await readFile(paths.filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const base = { key: input.key, filePath: paths.filePath };
  if (!manifest || bytes === null) {
    return { ...base, status: "missing", manifest, bytes: null };
  }
  // Full SHA-256 re-check on every status call: these artifacts are the
  // source of truth for money — a same-size corruption or a torn two-rename
  // install must never read as "ready".
  const { sha256, byteSize } = hashErtsArtifactBody(bytes);
  if (
    sha256 !== manifest.sha256 ||
    byteSize !== manifest.byteSize ||
    manifest.parserVersion !== RHODE_ISLAND_ERTS_PARSER_VERSION ||
    !manifestKeyMatches(manifest, input.key)
  ) {
    return { ...base, status: "stale", manifest, bytes: null };
  }
  return { ...base, status: "ready", manifest, bytes };
}

// Reads a cached artifact for the sync. Fail-closed: a missing or stale
// artifact throws — the sync must never aggregate from bytes the manifest no
// longer vouches for.
export async function readErtsArtifact(input: {
  cacheDir: string;
  key: ErtsArtifactKey;
}): Promise<{ bytes: Buffer; manifest: ErtsArtifactManifest }> {
  const status = await getErtsArtifactStatus(input);
  if (status.status !== "ready" || !status.manifest || status.bytes === null) {
    throw new Error(`ERTS artifact ${ertsArtifactRelativePath(input.key)} is ${status.status}`);
  }
  return { bytes: status.bytes, manifest: status.manifest };
}

/** Text artifacts decoded as UTF-8; scanned and text-layer PDFs stay binary. */
export async function readErtsTextArtifact(input: {
  cacheDir: string;
  key: ErtsArtifactKey;
}): Promise<{ text: string; manifest: ErtsArtifactManifest }> {
  if (input.key.type === "filing_pdf" || input.key.type === "cf8_scan") {
    throw new Error("ERTS PDF artifacts are binary; read bytes instead");
  }
  const { bytes, manifest } = await readErtsArtifact(input);
  return { text: utf8.decode(bytes), manifest };
}
