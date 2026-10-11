import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  getAllWestVirginiaTransactions, getAllWestVirginiaCurrentFilings,
  WEST_VIRGINIA_CFRS_PUBLIC_SERVICE_BASE_URL,
  type WestVirginiaCfrsClientOptions, type WestVirginiaCommitteeRow,
  type WestVirginiaCurrentFilingRow, type WestVirginiaTransactionRow,
} from "./westVirginiaCfrsClient.js";
import { readWestVirginiaCommitteeRegistryArtifact } from "./westVirginiaCfrsRegistryCache.js";

const SCOPE = "electronic_regular_report_ie";
const MODES = ["102", "103", "104", "105"] as const;
const PAGE_SIZE = 5_000;
const SOURCE_URL = WEST_VIRGINIA_CFRS_PUBLIC_SERVICE_BASE_URL + "/CommitteeTransactions/getAllPublicTransactionDataList";

type QueryCount = { orgTypeCode: string; transactionYear: number; returnedRowCount: number; actualIeRowCount: number };
type FilingInventory = { orgID: number; rows: WestVirginiaCurrentFilingRow[] };
type Body = {
  version: 1; scope: typeof SCOPE; years: number[];
  request: { modes: string[]; transactionCategory: "IE"; pageSize: number };
  registrySha256: string; registryRows: WestVirginiaCommitteeRow[];
  rows: WestVirginiaTransactionRow[]; filingsByOrg: FilingInventory[];
};

export type WestVirginiaElectronicOutsideSpendingMetadata = {
  version: 1; artifact: "electronic_ie"; scope: typeof SCOPE; years: number[];
  request: Body["request"]; sourceUrl: string; registrySha256: string;
  queryCounts: { before: QueryCount[]; after: QueryCount[] };
  filePath: string; metadataPath: string; downloadedAt: string;
  bytes: number; sha256: string; recordCount: number;
};
export type WestVirginiaElectronicOutsideSpendingRefreshResult = {
  status: "downloaded" | "unchanged"; cacheDir: string; filePath: string; metadataPath: string;
  previous: WestVirginiaElectronicOutsideSpendingMetadata | null;
  current: WestVirginiaElectronicOutsideSpendingMetadata;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid WV electronic IE cache object");
  return value as Record<string, unknown>;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])
  );
  return value;
}
function fingerprint(value: unknown) { return JSON.stringify(canonical(value)); }
function sortedRows<T>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => fingerprint(a).localeCompare(fingerprint(b)));
}
function hash(value: string | Uint8Array) { return createHash("sha256").update(value).digest("hex"); }
function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}
function nonempty(value: unknown): value is string { return typeof value === "string" && !!value.trim(); }
function day(value: unknown): string {
  if (!nonempty(value) || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value)) {
    throw new Error("Invalid WV electronic IE manifest date");
  }
  const date = value.slice(0, 10);
  const parsed = Date.parse(date + "T00:00:00Z");
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date) throw new Error("Invalid WV electronic IE manifest date");
  return date;
}
function yearsFor(value: unknown): number[] {
  if (!Array.isArray(value) || !value.length || value.some((year) => !integer(year, 2015) || year > 2100)) {
    throw new Error("Invalid WV electronic IE years");
  }
  return [...new Set(value as number[])].sort((a, b) => a - b);
}
function validateRequest(value: unknown) {
  const request = object(value);
  if (fingerprint(request.modes) !== fingerprint(MODES) || request.transactionCategory !== "IE" ||
      request.pageSize !== PAGE_SIZE || Object.keys(request).length !== 3) throw new Error("Invalid WV electronic IE request scope");
}
function validateRegistry(value: unknown, sha256: unknown): WestVirginiaCommitteeRow[] {
  if (!Array.isArray(value) || !value.length || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error("Invalid WV electronic IE registry");
  }
  for (const item of value) {
    const row = object(item);
    if (!integer(row.orgID, 1) || typeof row.entityId !== "string" || !/^\d{10}$/.test(row.entityId) ||
        !nonempty(row.orgType) || !nonempty(row.orgTypeCode) || !nonempty(row.orgStatus)) throw new Error("Invalid WV electronic IE registry identity");
    for (const field of ["orgName", "candidateName", "orgSubType", "office", "district", "party", "election", "registrationYear"]) {
      if (row[field] !== null && typeof row[field] !== "string") throw new Error("Invalid WV electronic IE registry " + field);
    }
  }
  // Embedded rows must reconstruct the verified registry artifact exactly.
  const registryBody = { version: 1, scope: "all_types_all_statuses_all_elections", request: { pageSize: PAGE_SIZE }, rows: value };
  if (hash(JSON.stringify(registryBody)) !== sha256) throw new Error("WV electronic IE embedded registry checksum mismatch");
  return value as WestVirginiaCommitteeRow[];
}
function validateTransactions(value: unknown): WestVirginiaTransactionRow[] {
  if (!Array.isArray(value)) throw new Error("Invalid WV electronic IE transaction array");
  for (const item of value) {
    const row = object(item);
    if (!integer(row.transactionID, 1) || !integer(row.orgID, 1) ||
        typeof row.entityID !== "string" || !/^\d{10}$/.test(row.entityID) ||
        typeof row.transactionAmount !== "number" || !Number.isFinite(row.transactionAmount) ||
        !nonempty(row.transactionDate) || row.transactionTypeDesc !== "Independent Expenditures" ||
        typeof row.amendedFlag !== "boolean") throw new Error("Invalid WV electronic IE transaction shape");
    for (const field of ["committeeName", "candidateName", "filedDate", "entityTypeDesc", "transactionCategoryDesc",
      "transactionPurpose", "contributorPayeeName", "employerName", "employerOccupation", "transactionTotalYTD",
      "reportVersionID", "reportFileName", "s3ReportFilePath", "stanceDescription", "candidateNameAssocation",
      "ballotMeasureDescription", "orgType"]) {
      if (row[field] !== null && typeof row[field] !== "string") throw new Error("Invalid WV electronic IE transaction " + field);
    }
    if (row.electionYear !== null && row.electionYear !== undefined &&
        (!integer(row.electionYear, 2000) || row.electionYear > 2100)) throw new Error("Invalid WV electronic IE target year");
  }
  return value as WestVirginiaTransactionRow[];
}
function validateFilings(value: unknown, orgID: number): WestVirginiaCurrentFilingRow[] {
  if (!Array.isArray(value)) throw new Error("Invalid WV electronic IE filing manifest");
  const reportIDs = new Set<number>();
  for (const item of value) {
    const row = object(item);
    if (row.orgID !== orgID || !integer(row.reportID, 1) || !integer(row.reportVersionID, 1) ||
        typeof row.registrantID !== "string" || !/^\d{10}$/.test(row.registrantID) ||
        !nonempty(row.committeeName) || !nonempty(row.reportFileName) || !nonempty(row.reportFormType) ||
        (row.reportStatus !== "Original" && row.reportStatus !== "Amended") ||
        typeof row.documentBarCode !== "string" || !/^[A-Za-z0-9]+$/.test(row.documentBarCode) ||
        reportIDs.has(row.reportID)) throw new Error("Invalid WV electronic IE current filing identity");
    reportIDs.add(row.reportID);
    if (day(row.startDate) > day(row.endDate)) throw new Error("Reversed WV electronic IE current filing period");
    day(row.filedDate); day(row.dueDate);
  }
  return sortedRows(value as WestVirginiaCurrentFilingRow[]);
}
function orgIDs(rows: WestVirginiaTransactionRow[]): number[] {
  return [...new Set(rows.map((row) => row.orgID))].sort((a, b) => a - b);
}
function validateInventories(value: unknown, rows: WestVirginiaTransactionRow[]): FilingInventory[] {
  if (!Array.isArray(value)) throw new Error("Invalid WV electronic IE org manifests");
  const inventories = value.map((item) => {
    const entry = object(item);
    if (!integer(entry.orgID, 1)) throw new Error("Invalid WV electronic IE manifest orgID");
    return { orgID: entry.orgID, rows: validateFilings(entry.rows, entry.orgID) };
  }).sort((a, b) => a.orgID - b.orgID);
  if (fingerprint(inventories.map((entry) => entry.orgID)) !== fingerprint(orgIDs(rows))) {
    throw new Error("WV electronic IE org inventory does not match transactions");
  }
  return inventories;
}
function validateCounts(value: unknown, years: number[]): QueryCount[] {
  if (!Array.isArray(value) || value.length !== years.length * MODES.length) throw new Error("Invalid WV electronic IE query coverage counts");
  const seen = new Set<string>();
  for (const item of value) {
    const count = object(item);
    const key = String(count.orgTypeCode) + ":" + String(count.transactionYear);
    if (!MODES.includes(count.orgTypeCode as typeof MODES[number]) || !years.includes(Number(count.transactionYear)) ||
        !integer(count.transactionYear) || !integer(count.returnedRowCount) || !integer(count.actualIeRowCount) ||
        count.actualIeRowCount > count.returnedRowCount || seen.has(key)) throw new Error("Invalid WV electronic IE query count");
    seen.add(key);
  }
  return value as QueryCount[];
}
function paths(cacheDir: string) {
  const directory = resolve(cacheDir);
  return { cacheDir: directory, metadataPath: resolve(directory, "ELECTRONIC_IE.metadata.json") };
}
function contentPath(cacheDir: string, sha256: string) { return resolve(cacheDir, "ELECTRONIC_IE." + sha256 + ".json"); }
async function writeAtomically(path: string, data: string) {
  const temporary = path + ".tmp-" + randomUUID();
  try {
    await writeFile(temporary, data, { mode: 0o600 }); await chmod(temporary, 0o600); await rename(temporary, path);
  } catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
}

/** Reads one complete electronic-query generation only; never calls the portal. */
export async function readWestVirginiaElectronicOutsideSpendingArtifact(input: { cacheDir: string }): Promise<{
  metadata: WestVirginiaElectronicOutsideSpendingMetadata;
  rows: WestVirginiaTransactionRow[];
  registryRows: WestVirginiaCommitteeRow[];
  currentFilingsByOrg: Map<number, WestVirginiaCurrentFilingRow[]>;
}> {
  const cache = paths(input.cacheDir);
  try {
    const metadata = object(JSON.parse(await readFile(cache.metadataPath, "utf8")));
    const years = yearsFor(metadata.years);
    validateRequest(metadata.request);
    if (metadata.version !== 1 || metadata.artifact !== "electronic_ie" || metadata.scope !== SCOPE ||
        fingerprint(metadata.years) !== fingerprint(years) || metadata.sourceUrl !== SOURCE_URL ||
        typeof metadata.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(metadata.sha256) ||
        metadata.metadataPath !== cache.metadataPath || metadata.filePath !== contentPath(cache.cacheDir, metadata.sha256) ||
        !integer(metadata.bytes, 1) || !integer(metadata.recordCount) || !nonempty(metadata.downloadedAt) ||
        Number.isNaN(Date.parse(metadata.downloadedAt))) throw new Error("Invalid WV electronic IE cache metadata");
    const counts = object(metadata.queryCounts);
    validateCounts(counts.before, years); validateCounts(counts.after, years);
    const bytes = await readFile(String(metadata.filePath));
    if (bytes.length !== metadata.bytes || hash(bytes) !== metadata.sha256) throw new Error("WV electronic IE cache checksum mismatch");
    const body = object(JSON.parse(bytes.toString("utf8")));
    validateRequest(body.request);
    if (body.version !== 1 || body.scope !== SCOPE || fingerprint(body.years) !== fingerprint(years) ||
        body.registrySha256 !== metadata.registrySha256) throw new Error("Invalid WV electronic IE generation scope");
    const registryRows = validateRegistry(body.registryRows, body.registrySha256);
    const rows = validateTransactions(body.rows);
    if (rows.length !== metadata.recordCount) throw new Error("WV electronic IE cache record count mismatch");
    const inventories = validateInventories(body.filingsByOrg, rows);
    return { metadata: metadata as unknown as WestVirginiaElectronicOutsideSpendingMetadata, rows, registryRows,
      currentFilingsByOrg: new Map(inventories.map((entry) => [entry.orgID, entry.rows])) };
  } catch (error) {
    throw new Error("WV electronic IE cache unavailable at " + cache.metadataPath + ": " + (error instanceof Error ? error.message : String(error)));
  }
}

/** Two complete harvests bracketed by complete current filing inventories. */
export async function refreshWestVirginiaElectronicOutsideSpendingArtifact(input: {
  years: readonly number[]; cacheDir: string; clientOptions?: WestVirginiaCfrsClientOptions;
  fetchTransactions?: typeof getAllWestVirginiaTransactions;
  fetchCurrentFilings?: typeof getAllWestVirginiaCurrentFilings;
  readRegistry?: typeof readWestVirginiaCommitteeRegistryArtifact; now?: Date;
}): Promise<WestVirginiaElectronicOutsideSpendingRefreshResult> {
  const cache = paths(input.cacheDir);
  const years = yearsFor(input.years);
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error("Invalid WV electronic IE refresh timestamp");
  let previous: WestVirginiaElectronicOutsideSpendingMetadata | null = null;
  try { previous = (await readWestVirginiaElectronicOutsideSpendingArtifact({ cacheDir: cache.cacheDir })).metadata; }
  catch { /* A validated fresh generation can repair a missing/corrupt artifact. */ }
  const registry = await (input.readRegistry ?? readWestVirginiaCommitteeRegistryArtifact)({ cacheDir: cache.cacheDir });
  const registryRows = validateRegistry(registry.rows, registry.metadata.sha256);
  const harvest = async () => {
    const all: WestVirginiaTransactionRow[] = [];
    const counts: QueryCount[] = [];
    for (const year of years) for (const mode of MODES) {
      const returned = await (input.fetchTransactions ?? getAllWestVirginiaTransactions)({
        orgTypeCode: mode, transactionCategory: "IE", transactionYear: year, pageSize: PAGE_SIZE,
      }, input.clientOptions);
      if (!Array.isArray(returned)) throw new Error("WV electronic IE harvest must return an explicit array");
      const actual = validateTransactions(returned.filter((row) => row.transactionTypeDesc === "Independent Expenditures"));
      counts.push({ orgTypeCode: mode, transactionYear: year, returnedRowCount: returned.length, actualIeRowCount: actual.length });
      all.push(...actual);
    }
    // Exact query-mode copies are one row; retain differing versions/economics
    // for the current-report acceptance guard rather than guessing a winner.
    const unique = new Map(all.map((row) => [fingerprint(row), row]));
    return { rows: sortedRows([...unique.values()]), counts };
  };
  const manifests = async (ids: number[]) => {
    const inventories: FilingInventory[] = [];
    for (const orgID of ids) inventories.push({ orgID, rows: validateFilings(
      await (input.fetchCurrentFilings ?? getAllWestVirginiaCurrentFilings)({ orgID, pageSize: PAGE_SIZE }, input.clientOptions), orgID
    ) });
    return inventories;
  };
  const before = await harvest();
  const ids = orgIDs(before.rows);
  const filingsBefore = await manifests(ids);
  const after = await harvest();
  if (fingerprint(ids) !== fingerprint(orgIDs(after.rows)) || fingerprint(before.rows) !== fingerprint(after.rows)) {
    throw new Error("WV electronic IE transactions or spender inventory changed during acquisition");
  }
  const filingsAfter = await manifests(ids);
  if (fingerprint(filingsBefore) !== fingerprint(filingsAfter)) throw new Error("WV electronic IE current filings changed during acquisition");
  if (previous && previous.recordCount > 0 && after.rows.length === 0) {
    throw new Error("WV electronic IE empty replacement requires independent current-report zero evidence");
  }
  const body: Body = { version: 1, scope: SCOPE, years,
    request: { modes: [...MODES], transactionCategory: "IE", pageSize: PAGE_SIZE },
    registrySha256: registry.metadata.sha256, registryRows, rows: after.rows, filingsByOrg: filingsAfter };
  const serialized = JSON.stringify(body);
  const sha256 = hash(serialized);
  const filePath = contentPath(cache.cacheDir, sha256);
  const current: WestVirginiaElectronicOutsideSpendingMetadata = {
    version: 1, artifact: "electronic_ie", scope: SCOPE, years, request: body.request, sourceUrl: SOURCE_URL,
    registrySha256: registry.metadata.sha256, queryCounts: { before: before.counts, after: after.counts },
    filePath, metadataPath: cache.metadataPath, downloadedAt: now.toISOString(),
    bytes: Buffer.byteLength(serialized), sha256, recordCount: after.rows.length,
  };
  await mkdir(cache.cacheDir, { recursive: true, mode: 0o700 }); await chmod(cache.cacheDir, 0o700);
  await writeAtomically(filePath, serialized);
  await writeAtomically(cache.metadataPath, JSON.stringify(current, null, 2));
  return { status: previous?.sha256 === sha256 ? "unchanged" : "downloaded", ...cache, filePath, previous, current };
}
