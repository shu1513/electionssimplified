import { createHash } from "node:crypto";

import {
  dedupeMichiganMitnExportRows,
  validateMichiganMitnContributionExportHeader,
  type MichiganMitnFetchFn,
} from "./michiganMitnPublicSearchClient.js";
import { fetchMichiganMitnFilingManifest, type MichiganMitnFiling } from "./michiganMitnFilingPolicy.js";
import { DEFAULT_MICHIGAN_MITN_RAW_CACHE_DIR } from "./michiganMitnSupplementalData.js";

const FINANCIAL_TYPES = new Set([
  "Campaign Statements", "Amended Campaign Statements",
  "Immediate Disclosure Reports", "Amended Immediate Disclosure Reports",
]);

function committeeIdentity(value: string): string {
  const id = value.trim();
  if (!/^\d+$/.test(id)) throw new Error("Michigan MiTN contribution policy has an invalid committee ID");
  return id.replace(/^0+(?=\d)/, "");
}

function periodKey(year: number, name: string): string {
  if (!name.trim()) throw new Error("Michigan MiTN contribution period is missing its statement name");
  return `${year}:${name.trim().replace(/\s+/g, " ").toUpperCase()}`;
}

function validateReceiptDate(value: string): void {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) throw new Error("Michigan MiTN contribution export has an invalid receipt date");
  const [, month, day, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) {
    throw new Error("Michigan MiTN contribution export has an invalid receipt date");
  }
}

/**
 * Select a whole current statement before receipt deduplication. Keeping an
 * original receipt absent from an amendment would resurrect a deleted donor.
 * Ambiguous periods throw so callers preserve the entire candidate snapshot.
 */
export function selectMichiganMitnCurrentContributionRows(input: {
  committeeId: string;
  statementYears: readonly number[];
  rawRows: readonly (readonly string[])[];
  filings: readonly MichiganMitnFiling[];
}): string[][] {
  validateMichiganMitnContributionExportHeader(input.rawRows);
  const header = input.rawRows[0]!.map((name) => name.trim());
  const index = new Map(header.map((name, i) => [name, i]));
  const field = (row: readonly string[], name: string) => row[index.get(name)!] ?? "";
  const years = new Set(input.statementYears);
  const committeeId = committeeIdentity(input.committeeId);
  const periods = new Map<string, { originals: string[][]; amended: string[][] }>();
  for (const raw of input.rawRows.slice(1)) {
    if (raw.every((value) => !value.trim())) continue;
    const row = header.map((_, i) => raw[i]?.trim() ?? "");
    const recordType = field(row, "Record Type (1=Parent, 2=Child)");
    if (recordType === "2") continue;
    if (recordType !== "1" || !field(row, "Receipt ID")) {
      throw new Error("Michigan MiTN contribution export has an invalid parent receipt identity");
    }
    if (committeeIdentity(field(row, "Receiving Committee ID#")) !== committeeId) {
      throw new Error("Michigan MiTN contribution export contains a different receiving committee");
    }
    const yearText = field(row, "Document Statement Year");
    if (!/^\d{4}$/.test(yearText) || !years.has(Number(yearText))) {
      throw new Error("Michigan MiTN contribution export contains an unexpected statement year");
    }
    const documentType = field(row, "Document Type");
    if (!FINANCIAL_TYPES.has(documentType)) {
      throw new Error("Michigan MiTN contribution export contains an unsupported financial document type");
    }
    for (const name of ["Receiving Committee Name", "Receiving Committee Type", "Type of Contribution"]) {
      if (!field(row, name)) throw new Error(`Michigan MiTN contribution export is missing ${name}`);
    }
    validateReceiptDate(field(row, "Date of Contribution"));
    const amount = field(row, "Amount of Contribution").replace(/[$,]/g, "");
    if (!/^-?\d+(?:\.\d{1,4})?$/.test(amount) || !Number.isFinite(Number(amount))) {
      throw new Error("Michigan MiTN contribution export has an invalid receipt amount");
    }
    const key = periodKey(Number(yearText), field(row, "Document Statement Type"));
    const period = periods.get(key) ?? { originals: [], amended: [] };
    (documentType.startsWith("Amended ") ? period.amended : period.originals).push(row);
    periods.set(key, period);
  }
  const selected: string[][] = [header];
  for (const [key, period] of periods) {
    const financial = input.filings.filter((filing) => FINANCIAL_TYPES.has(filing.documentType) &&
      filing.statementYear !== null && periodKey(filing.statementYear, filing.documentName) === key);
    if (!financial.length || financial.some((filing) => !["Submitted", "Reviewed"].includes(filing.status))) {
      throw new Error(`Michigan MiTN receipt period ${key} has missing or unresolved filings`);
    }
    const originals = financial.filter((filing) => !filing.documentType.startsWith("Amended "));
    const amendments = financial.filter((filing) => filing.documentType.startsWith("Amended "));
    if (!originals.length || amendments.length > 1 || (amendments.length === 1 && originals.length !== 1)) {
      throw new Error(`Michigan MiTN receipt period ${key} has ambiguous original or amendment versions`);
    }
    const original = originals[0]!;
    const amendment = amendments[0];
    const rows = amendment ? period.amended : period.originals;
    if (!amendment && period.amended.length) {
      throw new Error(`Michigan MiTN receipt period ${key} has unverified amended receipts`);
    }
    if (amendment && (
      amendment.documentType !== `Amended ${original.documentType}` ||
      amendment.refersToSequenceNumber !== original.sequenceNumber ||
      !original.coverageBegin || !original.coverageEnd ||
      amendment.coverageBegin !== original.coverageBegin || amendment.coverageEnd !== original.coverageEnd ||
      amendment.receivedDate < original.receivedDate
    )) {
      throw new Error(`Michigan MiTN receipt period ${key} has an unresolved amendment reference or coverage`);
    }
    const expectedDocumentTypes = new Set(amendment ? [amendment.documentType] : originals.map((filing) => filing.documentType));
    if (rows.some((row) => !expectedDocumentTypes.has(field(row, "Document Type")))) {
      throw new Error(`Michigan MiTN receipt period ${key} mixes financial document types`);
    }
    selected.push(...rows);
  }
  // A repeated receipt in vetted statements may be identical. A conflicting
  // economic row still lacks a provable version and must not win by file order.
  const ignored = new Set(["Filing Status (C=Complete,I=Incomplete)", "Document Type", "Document Statement Year", "Document Statement Type"]);
  const receipts = new Map<string, string>();
  for (const row of selected.slice(1)) {
    const id = field(row, "Receipt ID");
    const fingerprint = JSON.stringify(row.filter((_, i) => !ignored.has(header[i]!)));
    if (receipts.has(id) && receipts.get(id) !== fingerprint) {
      throw new Error(`Michigan MiTN contribution export has conflicting current receipt ${id}`);
    }
    receipts.set(id, fingerprint);
  }
  return dedupeMichiganMitnExportRows(selected);
}

export async function fetchMichiganMitnCurrentContributionRows(input: {
  committeeId: string;
  statementYears: number[];
  rawRows: string[][];
  rawCacheDir?: string;
  fetchFn: MichiganMitnFetchFn;
}): Promise<string[][]> {
  validateMichiganMitnContributionExportHeader(input.rawRows);
  if (input.rawRows.slice(1).every((row) => row.every((value) => !value.trim()))) {
    return [input.rawRows[0]!.map((name) => name.trim())];
  }
  // Registry searches use the public source spelling, which can differ from
  // our linked identifier's leading zeros. Validate identity before querying.
  const header = input.rawRows[0]!.map((name) => name.trim());
  const receivingIdIndex = header.indexOf("Receiving Committee ID#");
  const recordTypeIndex = header.indexOf("Record Type (1=Parent, 2=Child)");
  const expectedId = committeeIdentity(input.committeeId);
  const sourceIds = new Set<string>();
  for (const row of input.rawRows.slice(1)) {
    if (row.every((value) => !value.trim())) continue;
    const recordType = row[recordTypeIndex]?.trim();
    if (recordType === "2") continue;
    if (recordType !== "1") throw new Error("Michigan MiTN contribution export has an invalid parent receipt identity");
    const sourceId = row[receivingIdIndex]?.trim() ?? "";
    if (committeeIdentity(sourceId) !== expectedId) {
      throw new Error("Michigan MiTN contribution export contains a different receiving committee");
    }
    sourceIds.add(sourceId);
  }
  if (!sourceIds.size) return [header];
  if (sourceIds.size !== 1) throw new Error("Michigan MiTN contribution export has ambiguous receiving committee source IDs");
  const sourceCommitteeId = [...sourceIds][0]!;
  const exportFingerprint = createHash("sha256").update(JSON.stringify({
    committeeId: committeeIdentity(input.committeeId), statementYears: input.statementYears, rawRows: input.rawRows,
  })).digest("hex");
  const filings = await fetchMichiganMitnFilingManifest({
    committeeId: sourceCommitteeId,
    rawCacheDir: input.rawCacheDir ?? DEFAULT_MICHIGAN_MITN_RAW_CACHE_DIR,
    refresh: true,
    exportFingerprint,
    fetchFn: input.fetchFn,
  });
  return selectMichiganMitnCurrentContributionRows({ ...input, filings });
}
