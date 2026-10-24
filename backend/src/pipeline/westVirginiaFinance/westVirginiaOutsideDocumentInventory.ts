// Phase 3 acquisition: every registered independent-expenditure (104) and
// electioneering-communication (105) committee's document store, filtered to
// IE / EC report documents received in the harvested years, downloaded once
// (content-addressed by SHA-256) into the CFRS cache. This is the only live
// portal caller on the outside-documents path; extraction and sync read the
// inventory file and the PDFs, never the portal.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  downloadWestVirginiaPresignedFile,
  getAllWestVirginiaOrgDocuments,
  getWestVirginiaDocumentDownloadUrl,
  type WestVirginiaCfrsClientOptions,
  type WestVirginiaCommitteeRow,
  type WestVirginiaOrgDocumentRow,
} from "./westVirginiaCfrsClient.js";
import { readWestVirginiaCommitteeRegistryArtifact } from "./westVirginiaCfrsRegistryCache.js";
import {
  isWestVirginiaIndependentExpenditureDocument,
  westVirginiaDocumentReceivedYear,
} from "./westVirginiaPhaseZero.js";

export const WEST_VIRGINIA_OUTSIDE_COMMITTEE_TYPE_CODES = ["104", "105"] as const;
const SCOPE = "registered_iec_ecc_ie_documents";
const VERSION = 1;
const PAGE_SIZE = 5_000;

export type WestVirginiaOutsideDocumentEntry = {
  orgID: number;
  entityId: string;
  orgName: string;
  orgTypeCode: string;
  orgStatus: string;
  documentID: number;
  documentName: string;
  documentType: string;
  receivedDate: string;
  receivedYear: number;
  s3DocName: string;
  /** Relative to the cache dir. */
  filePath: string;
  bytes: number;
  sha256: string;
};

export type WestVirginiaOutsideDocumentInventory = {
  version: 1;
  scope: typeof SCOPE;
  years: number[];
  registrySha256: string;
  downloadedAt: string;
  committees: { orgID: number; entityId: string; orgName: string; orgTypeCode: string; orgStatus: string; documentCount: number; ieDocumentCount: number }[];
  documents: WestVirginiaOutsideDocumentEntry[];
};

export type WestVirginiaOutsideDocumentInventoryRefreshResult = {
  cacheDir: string;
  inventoryPath: string;
  committeeCount: number;
  documentCount: number;
  downloaded: number;
  reused: number;
  /** Cached files discarded because the remote object path changed. */
  replaced: number;
  inventory: WestVirginiaOutsideDocumentInventory;
};

function hash(value: Uint8Array | string) { return createHash("sha256").update(value).digest("hex"); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid West Virginia outside document inventory object");
  return value as Record<string, unknown>;
}
function integer(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error("Invalid West Virginia outside document inventory integer");
  return value as number;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Invalid West Virginia outside document inventory text");
  return value;
}

export function westVirginiaOutsideDocumentInventoryPaths(cacheDir: string) {
  const root = resolve(cacheDir);
  const documentsDir = resolve(root, "outside-documents");
  return { cacheDir: root, documentsDir, inventoryPath: resolve(documentsDir, "inventory.json") };
}

export function isWestVirginiaOutsideCommittee(row: Pick<WestVirginiaCommitteeRow, "orgTypeCode">): boolean {
  return (WEST_VIRGINIA_OUTSIDE_COMMITTEE_TYPE_CODES as readonly string[]).includes(row.orgTypeCode);
}

function parseEntry(value: unknown): WestVirginiaOutsideDocumentEntry {
  const row = object(value);
  const sha256 = text(row.sha256);
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid West Virginia outside document sha256");
  const filePath = text(row.filePath);
  if (filePath.startsWith("/") || filePath.includes("..")) throw new Error("Invalid West Virginia outside document path");
  return {
    orgID: integer(row.orgID, 1), entityId: text(row.entityId), orgName: text(row.orgName),
    orgTypeCode: text(row.orgTypeCode), orgStatus: text(row.orgStatus),
    documentID: integer(row.documentID, 1), documentName: text(row.documentName), documentType: text(row.documentType),
    receivedDate: text(row.receivedDate), receivedYear: integer(row.receivedYear, 2000),
    s3DocName: text(row.s3DocName), filePath, bytes: integer(row.bytes, 1), sha256,
  };
}

export function parseWestVirginiaOutsideDocumentInventory(value: unknown): WestVirginiaOutsideDocumentInventory {
  const body = object(value);
  if (body.version !== VERSION || body.scope !== SCOPE) throw new Error("Unsupported West Virginia outside document inventory");
  if (!Array.isArray(body.years) || !body.years.length || !Array.isArray(body.documents) || !Array.isArray(body.committees)) {
    throw new Error("Invalid West Virginia outside document inventory body");
  }
  const documents = body.documents.map(parseEntry);
  const ids = new Set(documents.map((d) => `${d.orgID}:${d.documentID}`));
  if (ids.size !== documents.length) throw new Error("Duplicate West Virginia outside document entries");
  return {
    version: 1, scope: SCOPE, years: body.years.map((y) => integer(y, 2000)),
    registrySha256: text(body.registrySha256), downloadedAt: text(body.downloadedAt),
    committees: body.committees.map((c) => {
      const row = object(c);
      return { orgID: integer(row.orgID, 1), entityId: text(row.entityId), orgName: text(row.orgName), orgTypeCode: text(row.orgTypeCode),
        orgStatus: text(row.orgStatus), documentCount: integer(row.documentCount), ieDocumentCount: integer(row.ieDocumentCount) };
    }),
    documents,
  };
}

/** Reads the inventory and verifies every listed PDF is present with its recorded hash. */
export async function readWestVirginiaOutsideDocumentInventory(input: { cacheDir: string }): Promise<{
  inventory: WestVirginiaOutsideDocumentInventory; inventoryPath: string; cacheDir: string;
}> {
  const paths = westVirginiaOutsideDocumentInventoryPaths(input.cacheDir);
  const inventory = parseWestVirginiaOutsideDocumentInventory(JSON.parse(await readFile(paths.inventoryPath, "utf8")));
  for (const entry of inventory.documents) {
    const bytes = await readFile(resolve(paths.cacheDir, entry.filePath));
    if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) {
      throw new Error(`West Virginia outside document checksum mismatch: ${entry.filePath}`);
    }
  }
  return { inventory, inventoryPath: paths.inventoryPath, cacheDir: paths.cacheDir };
}

async function existingFile(path: string): Promise<{ bytes: number; sha256: string } | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) return null;
    const bytes = await readFile(path);
    return { bytes: bytes.length, sha256: hash(bytes) };
  } catch { return null; }
}

export async function refreshWestVirginiaOutsideDocumentInventory(input: {
  cacheDir: string;
  years: readonly number[];
  clientOptions?: WestVirginiaCfrsClientOptions;
  fetchDocuments?: typeof getAllWestVirginiaOrgDocuments;
  mintUrl?: typeof getWestVirginiaDocumentDownloadUrl;
  download?: typeof downloadWestVirginiaPresignedFile;
  now?: Date;
  log?: (line: string) => void;
}): Promise<WestVirginiaOutsideDocumentInventoryRefreshResult> {
  const years = [...new Set(input.years.map((y) => integer(y, 2000)))].sort((a, b) => a - b);
  if (!years.length) throw new Error("West Virginia outside document refresh needs at least one received year");
  const paths = westVirginiaOutsideDocumentInventoryPaths(input.cacheDir);
  await mkdir(paths.documentsDir, { recursive: true, mode: 0o700 });
  const registry = await readWestVirginiaCommitteeRegistryArtifact({ cacheDir: paths.cacheDir });
  const committees = registry.rows.filter(isWestVirginiaOutsideCommittee)
    .sort((a, b) => a.orgID - b.orgID);
  if (!committees.length) throw new Error("West Virginia registry holds no IEC/ECC committees");
  const fetchDocuments = input.fetchDocuments ?? getAllWestVirginiaOrgDocuments;
  const mintUrl = input.mintUrl ?? getWestVirginiaDocumentDownloadUrl;
  const download = input.download ?? downloadWestVirginiaPresignedFile;
  const log = input.log ?? (() => {});

  // A cached PDF is reused only when the previous inventory recorded the same
  // remote object for that document; a changed s3DocName means re-download.
  let previousByDocument = new Map<string, string>();
  try {
    const previous = parseWestVirginiaOutsideDocumentInventory(JSON.parse(await readFile(paths.inventoryPath, "utf8")));
    previousByDocument = new Map(previous.documents.map((entry) => [`${entry.orgID}:${entry.documentID}`, entry.s3DocName]));
  } catch { /* first run or unreadable inventory: nothing is reused */ }
  const documents: WestVirginiaOutsideDocumentEntry[] = [];
  const committeeSummaries: WestVirginiaOutsideDocumentInventory["committees"] = [];
  let downloaded = 0, reused = 0, replaced = 0;
  for (const committee of committees) {
    const rows = await fetchDocuments({ orgID: committee.orgID, pageSize: PAGE_SIZE }, input.clientOptions);
    for (const row of rows) {
      if (row.orgID !== committee.orgID) throw new Error(`West Virginia document store returned orgID ${row.orgID} for ${committee.orgID}`);
    }
    const inScope = rows.filter((row): row is WestVirginiaOrgDocumentRow & { receivedYear: number } => {
      const year = westVirginiaDocumentReceivedYear(row);
      return isWestVirginiaIndependentExpenditureDocument(row) && year !== null && years.includes(year);
    });
    const orgName = committee.orgName?.trim() || `Committee ${committee.orgID}`;
    committeeSummaries.push({
      orgID: committee.orgID, entityId: committee.entityId, orgName, orgTypeCode: committee.orgTypeCode,
      orgStatus: committee.orgStatus, documentCount: rows.length, ieDocumentCount: inScope.length,
    });
    for (const row of inScope) {
      const relative = `outside-documents/${committee.orgID}/${row.documentID}.pdf`;
      const absolute = resolve(paths.cacheDir, relative);
      const sameRemote = previousByDocument.get(`${committee.orgID}:${row.documentID}`) === row.s3DocName;
      let file = sameRemote ? await existingFile(absolute) : null;
      if (file) reused += 1;
      else {
        if (!sameRemote && previousByDocument.has(`${committee.orgID}:${row.documentID}`)) {
          replaced += 1;
          log(`remote object changed for ${relative}; re-downloading`);
        }
        const url = await mintUrl(row.s3DocName, input.clientOptions);
        const tmp = `${absolute}.${process.pid}.part`;
        const result = await download({ url, outputPath: tmp }, input.clientOptions);
        if (result.bytesWritten === 0) { await rm(tmp, { force: true }); throw new Error(`Empty West Virginia document ${row.documentID}`); }
        await rename(tmp, absolute);
        file = { bytes: result.bytesWritten, sha256: result.sha256 };
        downloaded += 1;
        log(`downloaded ${relative} (${result.bytesWritten} bytes)`);
      }
      documents.push({
        orgID: committee.orgID, entityId: committee.entityId, orgName, orgTypeCode: committee.orgTypeCode, orgStatus: committee.orgStatus,
        documentID: row.documentID, documentName: row.documentName, documentType: row.documentType,
        receivedDate: row.receivedDate, receivedYear: westVirginiaDocumentReceivedYear(row)!,
        s3DocName: row.s3DocName, filePath: relative, bytes: file.bytes, sha256: file.sha256,
      });
    }
  }
  documents.sort((a, b) => a.orgID - b.orgID || a.documentID - b.documentID);
  const now = input.now ?? new Date();
  const inventory: WestVirginiaOutsideDocumentInventory = {
    version: 1, scope: SCOPE, years, registrySha256: registry.metadata.sha256, downloadedAt: now.toISOString(),
    committees: committeeSummaries, documents,
  };
  parseWestVirginiaOutsideDocumentInventory(inventory);
  const tmp = `${paths.inventoryPath}.${process.pid}.part`;
  await writeFile(tmp, JSON.stringify(inventory, null, 2), { mode: 0o600 });
  await rename(tmp, paths.inventoryPath);
  return { cacheDir: paths.cacheDir, inventoryPath: paths.inventoryPath, committeeCount: committees.length,
    documentCount: documents.length, downloaded, reused, replaced, inventory };
}
