import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  fetchMichiganMitnCommitteeSearch,
  MICHIGAN_MITN_PUBLIC_SEARCH_BASE_URL,
  type MichiganMitnFetchFn,
} from "./michiganMitnPublicSearchClient.js";
import type { MichiganMitnLegacyExpenditureRow } from "./michiganMitnLegacyRowTypes.js";
import {
  MICHIGAN_MITN_IE_EXPORT_HEADER,
  dedupeMichiganMitnIndependentExpenditureExportRows,
  michiganMitnIndependentExpenditureExportRowsToLegacy,
} from "./michiganMitnSupplementalData.js";

export type MichiganMitnFiling = {
  documentType: string;
  statementYear: number | null;
  documentName: string;
  sequenceNumber: string;
  refersToSequenceNumber: string;
  coverageBegin: string;
  coverageEnd: string;
  receivedDate: string;
  status: string;
};

const FINANCIAL_TYPES = new Set([
  "Campaign Statements", "Amended Campaign Statements",
  "Immediate Disclosure Reports", "Amended Immediate Disclosure Reports",
]);

function text(html: string): string {
  return html.replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

/** Parse only the mobile cards; desktop markup repeats the same filings. */
export function parseMichiganMitnFilingsHtml(html: string): {
  filings: MichiganMitnFiling[]; first: number; last: number; total: number;
} {
  const cards = /<ul\b[^>]*class="block sm:hidden"[^>]*>([\s\S]*?)<\/ul>/.exec(html)?.[1];
  const range = /<span[^>]*>\s*([\d,]+)\s*<\/span>\s*-\s*<span[^>]*>\s*([\d,]+)\s*<\/span>\s*of\s*<span[^>]*>\s*([\d,]+)\s*<\/span>/.exec(html);
  if (!cards || !range) throw new Error("Michigan MiTN filing manifest is missing records or pagination");
  const filings: MichiganMitnFiling[] = [];
  for (const card of cards.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)) {
    const fields = new Map<string, string>();
    const rawFields = new Map<string, string>();
    for (const field of card[1]!.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/g)) {
      const label = text(field[1]!);
      if (fields.has(label)) throw new Error("Michigan MiTN filing manifest has duplicate field labels");
      fields.set(label, text(field[2]!));
      rawFields.set(label, field[2]!);
    }
    const documentType = fields.get("Document Type") ?? "";
    if (!documentType) throw new Error("Michigan MiTN filing manifest has an unrecognized record");
    const dates = (label: string) => [...(rawFields.get(label) ?? "").matchAll(/datetime="(\d{4}-\d{2}-\d{2})"/g)].map((m) => m[1]!);
    const coverage = dates("Coverge Period").length ? dates("Coverge Period") : dates("Coverage Period");
    const yearText = fields.get("Statement Year") ?? "";
    const filing: MichiganMitnFiling = {
      documentType,
      statementYear: /^\d{4}$/.test(yearText) ? Number(yearText) : null,
      documentName: fields.get("Document Name") ?? "",
      sequenceNumber: fields.get("Sequence Number") ?? "",
      refersToSequenceNumber: fields.get("Refers to Seq No") ?? "",
      coverageBegin: coverage[0] ?? "", coverageEnd: coverage[1] ?? "",
      receivedDate: dates("Date Received")[0] ?? "",
      status: fields.get("Status") ?? "",
    };
    if (FINANCIAL_TYPES.has(documentType) && (!filing.statementYear || !filing.documentName ||
        !filing.sequenceNumber || !filing.receivedDate || !filing.status)) {
      throw new Error("Michigan MiTN filing manifest has incomplete financial filing metadata");
    }
    filings.push(filing);
  }
  const first = Number(range[1]!.replace(/,/g, "")), last = Number(range[2]!.replace(/,/g, "")), total = Number(range[3]!.replace(/,/g, ""));
  if (first < 1 || last < first || total < last || filings.length !== last - first + 1) {
    throw new Error("Michigan MiTN filing manifest pagination does not match its records");
  }
  return { filings, first, last, total };
}

function committeeIdentity(id: string): string {
  if (!/^\d+$/.test(id)) throw new Error("Michigan MiTN IE period has an invalid committee ID");
  return id.replace(/^0+(?=\d)/, "");
}
function periodKey(committeeId: string, year: number, name: string): string {
  if (!name.trim()) throw new Error("Michigan MiTN IE period is missing its statement name");
  return `${committeeIdentity(committeeId)}:${year}:${name.trim().replace(/\s+/g, " ").toUpperCase()}`;
}
function validateTable(rows: readonly (readonly string[])[]): void {
  if (rows[0]?.length !== MICHIGAN_MITN_IE_EXPORT_HEADER.length ||
      MICHIGAN_MITN_IE_EXPORT_HEADER.some((name, i) => rows[0]?.[i] !== name)) {
    throw new Error("Michigan MiTN filing policy received unexpected expense export headers");
  }
}

/** Shared labels can cover separate elections; only identical economics are interchangeable. */
function equivalentOriginalPeriods(
  originals: readonly MichiganMitnFiling[], full: string[][], amended: string[][]
): boolean {
  const validDate = (value: string) => {
    const date = new Date(`${value}T00:00:00Z`);
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  const periods = [...originals].sort((a, b) => a.coverageBegin.localeCompare(b.coverageBegin));
  if (periods.some((filing, i) => filing.documentType !== "Campaign Statements" ||
      !validDate(filing.coverageBegin) || !validDate(filing.coverageEnd) || filing.coverageBegin > filing.coverageEnd ||
      (i > 0 && periods[i - 1]!.coverageEnd >= filing.coverageBegin))) return false;
  const economicRows = (rows: string[][]) => dedupeMichiganMitnIndependentExpenditureExportRows([
    [...MICHIGAN_MITN_IE_EXPORT_HEADER], ...rows,
  ]).slice(1).map((row) => JSON.stringify(row.filter((_, i) => ![2, 3, 4].includes(i)))).sort();
  const left = economicRows(full), right = economicRows(amended);
  return left.length > 0 && left.length === right.length && left.every((row, i) => row === right[i]);
}

/** Whole-period replacement removes expenses deleted from the original statement. */
export function selectMichiganMitnCurrentExpenditureRows(input: {
  statementYears: readonly number[];
  rawRows: readonly (readonly string[])[];
  amendedRows: readonly (readonly string[])[];
  filingsByCommittee: ReadonlyMap<string, readonly MichiganMitnFiling[]>;
}): string[][] {
  validateTable(input.rawRows); validateTable(input.amendedRows);
  const years = new Set(input.statementYears);
  const group = (rows: readonly (readonly string[])[]) => {
    const result = new Map<string, string[][]>();
    for (const raw of rows.slice(1)) {
      if (raw.every((cell) => !cell.trim())) continue;
      const row = MICHIGAN_MITN_IE_EXPORT_HEADER.map((_, i) => raw[i]?.trim() ?? "");
      if (!/^\d{4}$/.test(row[3]!) || !years.has(Number(row[3]))) {
        throw new Error("Michigan MiTN IE export contains an unexpected statement year");
      }
      const key = periodKey(row[7]!, Number(row[3]), row[4]!);
      result.set(key, [...(result.get(key) ?? []), row]);
    }
    return result;
  };
  const full = group(input.rawRows), amended = group(input.amendedRows);
  const selected: string[][] = [[...MICHIGAN_MITN_IE_EXPORT_HEADER]];
  const periodKeys = new Set([...full.keys(), ...amended.keys()]);
  for (const key of periodKeys) {
    const sample = full.get(key)?.[0] ?? amended.get(key)![0]!;
    const committeeId = committeeIdentity(sample[7]!);
    const manifest = input.filingsByCommittee.get(committeeId);
    if (!manifest) throw new Error(`Michigan MiTN has no complete filing manifest for committee ${committeeId}`);
    const financial = manifest.filter((filing) => FINANCIAL_TYPES.has(filing.documentType) &&
      filing.statementYear !== null && periodKey(committeeId, filing.statementYear, filing.documentName) === key);
    if (!financial.length || financial.some((filing) => !["Submitted", "Reviewed"].includes(filing.status))) {
      throw new Error(`Michigan MiTN period ${key} has missing or unresolved filings`);
    }
    const originals = financial.filter((filing) => !filing.documentType.startsWith("Amended "));
    const amendments = financial.filter((filing) => filing.documentType.startsWith("Amended "));
    if (!originals.length || amendments.length > 1) {
      throw new Error(`Michigan MiTN period ${key} has ambiguous original or amendment versions`);
    }
    const amendment = amendments[0];
    if (!amendment) {
      if (amended.has(key)) throw new Error(`Michigan MiTN period ${key} has unverified amended expenses`);
      selected.push(...(full.get(key) ?? []));
      continue;
    }
    const referenced = originals.filter((filing) => filing.sequenceNumber === amendment.refersToSequenceNumber);
    if (referenced.length !== 1) throw new Error(`Michigan MiTN period ${key} has an unresolved amendment reference or coverage`);
    const original = referenced[0]!;
    if (amendment.documentType !== "Amended Campaign Statements" || original.documentType !== "Campaign Statements") {
      throw new Error(`Michigan MiTN period ${key} has an unsupported amended immediate report`);
    }
    if (amendment.refersToSequenceNumber !== original.sequenceNumber ||
        !original.coverageBegin || !original.coverageEnd ||
        amendment.coverageBegin !== original.coverageBegin || amendment.coverageEnd !== original.coverageEnd ||
        amendment.receivedDate < original.receivedDate) {
      throw new Error(`Michigan MiTN period ${key} has an unresolved amendment reference or coverage`);
    }
    // Pre-primary and pre-general can both be named "Pre-Election CS". A
    // whole-label replacement is safe only when it cannot remove or change
    // any eligible economic record from the other original coverage periods.
    if (originals.length !== 1 && !equivalentOriginalPeriods(originals, full.get(key) ?? [], amended.get(key) ?? [])) {
      throw new Error(`Michigan MiTN period ${key} has ambiguous original filing coverage for amendment replacement`);
    }
    // The manifest proves amendment existence even when its IE schedule is empty.
    selected.push(...(amended.get(key) ?? []));
  }
  return selected;
}

type ManifestSnapshot = {
  version: 1; committeeId: string; registryInternalId: string; exportFingerprint: string;
  retrievedAt: string; pages: string[];
};

function completeManifest(pages: readonly string[]): MichiganMitnFiling[] {
  if (!pages.length) throw new Error("Michigan MiTN filing manifest is empty");
  const all: MichiganMitnFiling[] = [];
  const seen = new Map<string, string>();
  let loaded = 0;
  let total: number | undefined;
  for (const html of pages) {
    const page = parseMichiganMitnFilingsHtml(html);
    if ((total !== undefined && page.total !== total) || page.first !== loaded + 1) {
      throw new Error("Michigan MiTN filing manifest pagination changed or skipped records");
    }
    total = page.total;
    loaded = page.last;
    for (const filing of page.filings) {
      if (filing.sequenceNumber) {
        const fingerprint = JSON.stringify(filing);
        const previous = seen.get(filing.sequenceNumber);
        if (previous !== undefined) {
          if (previous !== fingerprint) throw new Error("Michigan MiTN filing manifest has conflicting repeated filing sequences");
          // Identical migrated history can occur twice in the source registry.
          // Pagination still counts both raw records; identity counts one filing.
          continue;
        }
        seen.set(filing.sequenceNumber, fingerprint);
      }
      all.push(filing);
    }
  }
  if (loaded !== total) throw new Error("Michigan MiTN filing manifest is incomplete");
  return all;
}

type FilingManifestInput = {
  /** Preserve the source ID, including leading zeroes, for the server query. */
  committeeId: string; rawCacheDir: string; refresh?: boolean;
  exportFingerprint: string; fetchFn: MichiganMitnFetchFn;
};

async function acquireManifest(input: FilingManifestInput): Promise<{
  filings: MichiganMitnFiling[]; filename: string; snapshot?: ManifestSnapshot;
}> {
  const committeeId = committeeIdentity(input.committeeId);
  if (!/^[a-f0-9]{64}$/.test(input.exportFingerprint)) throw new Error("Michigan MiTN manifest requires an export SHA256 fingerprint");
  const filename = path.join(input.rawCacheDir, "filing-manifests", input.exportFingerprint, `${committeeId}.json`);
  if (!input.refresh) {
    // Never combine old exports with a freshly fetched amendment registry.
    let snapshot: ManifestSnapshot;
    try { snapshot = JSON.parse(await readFile(filename, "utf8")) as ManifestSnapshot; }
    catch { throw new Error(`Michigan MiTN committee ${committeeId} needs a full export/manifest refresh`); }
    if (snapshot.version !== 1 || snapshot.committeeId !== committeeId ||
        snapshot.exportFingerprint !== input.exportFingerprint || !Array.isArray(snapshot.pages) ||
        snapshot.pages.some((page) => typeof page !== "string")) {
      throw new Error(`Michigan MiTN committee ${committeeId} has a mismatched cached filing snapshot`);
    }
    return { filename, filings: completeManifest(snapshot.pages) };
  }
  const matches = (await fetchMichiganMitnCommitteeSearch({ committeeId: input.committeeId,
    committeeType: "", fetchFn: input.fetchFn }))
    .filter((committee) => committeeIdentity(committee.committeeId) === committeeId);
  if (matches.length !== 1 || !matches[0]!.registryInternalId || !/^\d+$/.test(matches[0]!.registryInternalId!)) {
    throw new Error(`Michigan MiTN committee ${committeeId} has an ambiguous or missing registry identity`);
  }
  const internalId = matches[0]!.registryInternalId!;
  const pages: string[] = [];
  let loaded = 0;
  let expectedTotal: number | undefined;
  for (let currentPage = 1; currentPage <= 1000; currentPage++) {
    const url = `${MICHIGAN_MITN_PUBLIC_SEARCH_BASE_URL}?page=page.miboeCommitteePublicSearch&action=showCommitteeSection`;
    const response = await input.fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "hx-request": "true",
        origin: new URL(MICHIGAN_MITN_PUBLIC_SEARCH_BASE_URL).origin,
        referer: `${MICHIGAN_MITN_PUBLIC_SEARCH_BASE_URL}?page=page.miboeCommitteePublicSearch` },
      body: new URLSearchParams({ section: "filings", parameters: JSON.stringify({ id: Number(internalId) }),
        perPage: "100", currentPage: String(currentPage), sortColumn: "sequenceNumber", sortDirection: "desc" }).toString(),
    });
    if (!response.ok) throw new Error(`Michigan MiTN filing registry failed: status ${response.status}`);
    const html = await response.text();
    const page = parseMichiganMitnFilingsHtml(html);
    if (expectedTotal !== undefined && page.total !== expectedTotal) throw new Error("Michigan MiTN filing manifest pagination changed");
    expectedTotal = page.total;
    if (page.first !== loaded + 1) throw new Error("Michigan MiTN filing registry skipped or repeated a page");
    pages.push(html); loaded = page.last;
    if (loaded === page.total) break;
    if (currentPage === 1000) throw new Error("Michigan MiTN filing registry exceeded its pagination limit");
  }
  const filings = completeManifest(pages);
  return { filename, filings, snapshot: { version: 1, committeeId, registryInternalId: internalId,
    exportFingerprint: input.exportFingerprint, retrievedAt: new Date().toISOString(), pages } };
}

async function saveManifest(filename: string, snapshot: ManifestSnapshot): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(snapshot), "utf8");
  await rename(temporary, filename);
}

/** Complete raw filing history tied to the exact export snapshot supplied by its caller. */
export async function fetchMichiganMitnFilingManifest(input: FilingManifestInput): Promise<MichiganMitnFiling[]> {
  const result = await acquireManifest(input);
  if (result.snapshot) await saveManifest(result.filename, result.snapshot);
  return result.filings;
}

export async function fetchMichiganMitnCurrentExpenditureRows(input: {
  statementYears: number[]; rawRows: string[][]; amendedRows: string[][];
  rawCacheDir: string; refresh?: boolean; fetchFn: MichiganMitnFetchFn;
}): Promise<MichiganMitnLegacyExpenditureRow[]> {
  validateTable(input.rawRows); validateTable(input.amendedRows);
  const sourceIds = new Map<string, string>();
  for (const row of [...input.rawRows.slice(1), ...input.amendedRows.slice(1)]) {
    if (!row.some((cell) => cell.trim())) continue;
    const sourceId = row[7]?.trim() ?? "";
    const key = committeeIdentity(sourceId);
    if (!sourceIds.has(key)) sourceIds.set(key, sourceId);
  }
  const fingerprint = createHash("sha256").update(JSON.stringify({
    statementYears: input.statementYears, rawRows: input.rawRows, amendedRows: input.amendedRows,
  })).digest("hex");
  const manifests = new Map<string, MichiganMitnFiling[]>();
  const pending: { filename: string; snapshot: ManifestSnapshot }[] = [];
  for (const [committeeId, sourceId] of sourceIds) {
    const result = await acquireManifest({ ...input, committeeId: sourceId, exportFingerprint: fingerprint });
    manifests.set(committeeId, result.filings);
    if (result.snapshot) pending.push({ filename: result.filename, snapshot: result.snapshot });
  }
  const selected = selectMichiganMitnCurrentExpenditureRows({ ...input, filingsByCommittee: manifests });
  const rows = michiganMitnIndependentExpenditureExportRowsToLegacy(selected);
  // Retain raw HTML only after every period passes. Fingerprints also prevent a
  // partial cache commit from pairing newer manifests with older workbooks.
  for (const { filename, snapshot } of pending) await saveManifest(filename, snapshot);
  return rows;
}
