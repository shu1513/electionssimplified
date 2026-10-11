import { APP_NAME } from "../../constants/brand.js";
import { inflateRawSync } from "node:zlib";

import type { MichiganMitnLegacyContributionRow } from "./michiganMitnLegacyRowTypes.js";

/**
 * Client for the Michigan Transparency Network public search
 * (mi-boe.entellitrak.com) — the ONLY source of post-April-2025 campaign
 * finance filings. The legacy yearly .7z archives are frozen; MiTN has no
 * bulk download, but its htmx search endpoints answer plain HTTP POSTs:
 *
 * - committee search: POST page.miboeCommitteePublicSearch&action=search with
 *   `option=committee` + the full form.* field set (server rejects partial
 *   bodies with "The attempted search is not allowed").
 * - contribution export: POST page.miboeContributionPublicSearch&action=export
 *   returns an .xlsx attachment with every matching contribution row
 *   (verified live: one committee-year of 1,475 records in one response).
 *
 * All request shapes were captured from the live site on 2026-07-26.
 */
export const MICHIGAN_MITN_PUBLIC_SEARCH_BASE_URL =
  "https://mi-boe.entellitrak.com/etk-mi-boe-prod/page.request.do";

const COMMITTEE_SEARCH_PAGE = "page.miboeCommitteePublicSearch";
const CONTRIBUTION_SEARCH_PAGE = "page.miboeContributionPublicSearch";

/** MiTN committee-type select values (captured from the live form). */
export const MICHIGAN_MITN_COMMITTEE_TYPE_CANDIDATE = "13";

/** MiTN office-sought select values (captured from the live form). */
export const MICHIGAN_MITN_OFFICE_SOUGHT_IDS: ReadonlyMap<string, string> = new Map([
  ["Governor", "121"],
  ["Lieutenant Governor", "137"],
  ["Secretary of State", "138"],
  ["Attorney General", "161"],
  ["State Senate", "162"],
  ["State House", "127"],
]);

/**
 * MiTN campaign-statement-year select values (captured from the live form).
 * The ids are arbitrary database keys, not years — never compute them.
 */
export const MICHIGAN_MITN_STATEMENT_YEAR_IDS: ReadonlyMap<number, string> = new Map([
  [2022, "39"],
  [2023, "38"],
  [2024, "37"],
  [2025, "69"],
  [2026, "76"],
]);

export type MichiganMitnFetchFn = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  }
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

function requestHeaders(page: string): Record<string, string> {
  const pageUrl = `${MICHIGAN_MITN_PUBLIC_SEARCH_BASE_URL}?page=${page}`;
  return {
    "user-agent": `Mozilla/5.0 (${APP_NAME} campaign finance sync)`,
    "content-type": "application/x-www-form-urlencoded",
    "hx-request": "true",
    origin: new URL(MICHIGAN_MITN_PUBLIC_SEARCH_BASE_URL).origin,
    referer: pageUrl,
  };
}

export type MichiganMitnCommitteeSearchInput = {
  candidateLastName?: string;
  committeeName?: string;
  committeeId?: string;
  /** Omit for candidate searches; an empty value searches every registry type. */
  committeeType?: string;
  candidateFirstName?: string | null;
  /** Canonical MiTN office label (a MICHIGAN_MITN_OFFICE_SOUGHT_IDS key). */
  officeSought?: string | null;
  fetchFn: MichiganMitnFetchFn;
};

export type MichiganMitnCommitteeSearchRow = {
  committeeId: string;
  committeeType: string;
  committeeName: string;
  status: string;
  /** Source internal ID used only by the public Filings section. */
  registryInternalId?: string;
};

/**
 * The server rejects bodies missing the full field set, so every form.* key
 * is always present (empty when unused) — exactly what the live form sends.
 */
function committeeSearchBody(input: MichiganMitnCommitteeSearchInput): string {
  const officeSoughtId = input.officeSought
    ? (MICHIGAN_MITN_OFFICE_SOUGHT_IDS.get(input.officeSought) ?? "")
    : "";
  const params = new URLSearchParams([
    ["sortColumn", "createdOn"],
    ["sortDirection", "desc"],
    ["form.committeeId", input.committeeId?.trim() ?? ""],
    ["form.committeeType", input.committeeType ?? MICHIGAN_MITN_COMMITTEE_TYPE_CANDIDATE],
    ["form.committeeStatus", ""],
    ["form.committeeName", input.committeeName?.trim() ?? ""],
    ["form.committeeAcronym", ""],
    ["form.candidateFirstName", input.candidateFirstName?.trim() ?? ""],
    ["form.candidateMiddleName", ""],
    ["form.candidateLastName", input.candidateLastName?.trim() ?? ""],
    ["form.countyOfResidence", ""],
    ["form.party", ""],
    ["form.county", ""],
    ["form.congressionalDistrict", ""],
    ["form.officeSought", officeSoughtId],
    ["form.officeSoughtDistrict", ""],
    ["form.officeHeld", ""],
    ["form.officeHeldDistrict", ""],
    ["form.termExpirationDateBegin", ""],
    ["form.termExpirationDateEnd", ""],
    ["form.sponsoringOrganization", ""],
    ["option", "committee"],
  ]);
  return params.toString();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function stripTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function parseMichiganMitnCommitteeSearchHtml(html: string): MichiganMitnCommitteeSearchRow[] {
  if (/The attempted search is not allowed/i.test(html)) {
    throw new Error("Michigan MiTN committee search rejected the request shape");
  }
  if (/narrow the search criteria/i.test(html)) {
    throw new Error("Michigan MiTN committee search exceeded the response row cap");
  }

  const rows: MichiganMitnCommitteeSearchRow[] = [];
  const seen = new Set<string>();
  for (const rowMatch of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...(rowMatch[1] ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) =>
      stripTags(cell[1] ?? "")
    );
    if (cells.length < 4) {
      continue;
    }
    const [committeeId, committeeType, committeeName, status] = cells;
    if (!committeeId || !/^\d+$/.test(committeeId) || !committeeName) {
      continue;
    }
    if (seen.has(committeeId)) {
      continue;
    }
    seen.add(committeeId);
    rows.push({
      committeeId,
      committeeType: committeeType ?? "",
      committeeName,
      status: status ?? "",
      ...(() => {
        const internalId = /parameters:\s*\{\s*id:\s*(\d+)\s*\}/.exec(rowMatch[0]);
        return internalId ? { registryInternalId: internalId[1]! } : {};
      })(),
    });
  }
  return rows;
}

export async function fetchMichiganMitnCommitteeSearch(
  input: MichiganMitnCommitteeSearchInput
): Promise<MichiganMitnCommitteeSearchRow[]> {
  const url = `${MICHIGAN_MITN_PUBLIC_SEARCH_BASE_URL}?page=${COMMITTEE_SEARCH_PAGE}&action=search`;
  const response = await input.fetchFn(url, {
    method: "POST",
    headers: requestHeaders(COMMITTEE_SEARCH_PAGE),
    body: committeeSearchBody(input),
  });
  if (!response.ok) {
    throw new Error(`Michigan MiTN committee search failed: status ${response.status}`);
  }
  return parseMichiganMitnCommitteeSearchHtml(await response.text());
}

export type MichiganMitnContributionExportInput = {
  committeeId: string;
  statementYear: number;
  fetchFn: MichiganMitnFetchFn;
};

export async function fetchMichiganMitnContributionExportXlsx(
  input: MichiganMitnContributionExportInput
): Promise<Buffer> {
  const statementYearId = MICHIGAN_MITN_STATEMENT_YEAR_IDS.get(input.statementYear);
  if (!statementYearId) {
    throw new Error(`No Michigan MiTN statement-year id for ${input.statementYear}`);
  }
  const committeeId = input.committeeId.trim();
  if (!/^\d+$/.test(committeeId)) {
    throw new Error(`Invalid Michigan MiTN committee id: ${input.committeeId}`);
  }
  const url = `${MICHIGAN_MITN_PUBLIC_SEARCH_BASE_URL}?page=${CONTRIBUTION_SEARCH_PAGE}&action=export`;
  // The receipt export accepts numeric IDs, even where registry IDs retain
  // leading zeros. An artificial padded link can otherwise return zero rows
  // (verified Hawkins 0521495 vs 521495; Donni 608867 finds source 0608867).
  const exportCommitteeId = committeeId.replace(/^0+(?=\d)/, "");
  const body = new URLSearchParams([
    ["form.committeeId", exportCommitteeId],
    ["form.contributionType", "individual"],
    ["form.campaignStatementYear", statementYearId],
  ]).toString();
  const response = await input.fetchFn(url, {
    method: "POST",
    headers: requestHeaders(CONTRIBUTION_SEARCH_PAGE),
    body,
  });
  if (!response.ok) {
    throw new Error(`Michigan MiTN contribution export failed: status ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.subarray(0, 2).toString("latin1") !== "PK") {
    throw new Error("Michigan MiTN contribution export did not return an xlsx attachment");
  }
  return buffer;
}

// --- Committee resolution via the public search ----------------------------

export type MichiganMitnSearchResolution =
  | { status: "matched"; committeeId: string; committeeName: string }
  | { status: "unmatched"; reason: "unsupported_office" | "no_active_candidate_committee" }
  | { status: "ambiguous"; matches: MichiganMitnCommitteeSearchRow[] };

const NAME_SUFFIX_PATTERN = /^(?:JR|SR|II|III|IV|V)\.?$/i;

/**
 * First/last tokens for the search filters: parenthetical nicknames dropped,
 * generational suffixes stripped, hyphenated last names kept whole.
 */
export function splitMichiganCandidateNameForSearch(displayName: string): {
  firstName: string;
  lastName: string;
} {
  const tokens = displayName
    .replace(/\([^()]*\)/g, " ")
    .replace(/["“”]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  while (tokens.length > 1 && NAME_SUFFIX_PATTERN.test(tokens[tokens.length - 1]!)) {
    tokens.pop();
  }
  return {
    firstName: tokens[0] ?? "",
    lastName: tokens.length > 1 ? tokens[tokens.length - 1]! : "",
  };
}

/**
 * Resolves a candidate's committee from the MiTN public committee search:
 * candidate first + last name and the race's office as SERVER-side filters,
 * then require exactly one ACTIVE candidate committee. Zero or several stay
 * unresolved — no guessing between committees.
 */
export async function resolveMichiganMitnCommitteeViaSearch(input: {
  candidateName: string;
  /** Canonical MiTN office label (a MICHIGAN_MITN_OFFICE_SOUGHT_IDS key). */
  mitnOffice: string;
  fetchFn: MichiganMitnFetchFn;
}): Promise<MichiganMitnSearchResolution> {
  if (!MICHIGAN_MITN_OFFICE_SOUGHT_IDS.has(input.mitnOffice)) {
    return { status: "unmatched", reason: "unsupported_office" };
  }
  const { firstName, lastName } = splitMichiganCandidateNameForSearch(input.candidateName);
  if (!firstName || !lastName) {
    return { status: "unmatched", reason: "no_active_candidate_committee" };
  }
  const rows = await fetchMichiganMitnCommitteeSearch({
    candidateLastName: lastName,
    candidateFirstName: firstName,
    officeSought: input.mitnOffice,
    fetchFn: input.fetchFn,
  });
  const activeCandidateCommittees = rows.filter(
    (row) => row.status.trim().toUpperCase() === "ACTIVE" && row.committeeType.trim().toUpperCase() === "CANDIDATE"
  );
  if (activeCandidateCommittees.length === 1) {
    const match = activeCandidateCommittees[0]!;
    return { status: "matched", committeeId: match.committeeId, committeeName: match.committeeName };
  }
  if (activeCandidateCommittees.length === 0) {
    return { status: "unmatched", reason: "no_active_candidate_committee" };
  }
  return { status: "ambiguous", matches: activeCandidateCommittees };
}

// --- Minimal xlsx reading -------------------------------------------------
//
// The MiTN export writes every cell as an inline string, so the worksheet is
// self-contained and a dependency-free reader is enough. (The `xlsx` package
// is deliberately not used: it is not installed, and the Oregon modules that
// import it are the long-standing test-suite failures.)

type ZipEntry = { fileName: string; data: Buffer };

function readZipEntries(buffer: Buffer): ZipEntry[] {
  // End-of-central-directory record: scan back for its signature.
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error("Michigan MiTN xlsx: missing zip end-of-central-directory record");
  }
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);

  const entries: ZipEntry[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("Michigan MiTN xlsx: malformed zip central directory");
    }
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const fileName = buffer.subarray(cursor + 46, cursor + 46 + fileNameLength).toString("utf8");

    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const data =
      compressionMethod === 0 ? Buffer.from(raw) : compressionMethod === 8 ? inflateRawSync(raw) : null;
    if (data === null) {
      throw new Error(`Michigan MiTN xlsx: unsupported zip compression method ${compressionMethod}`);
    }
    entries.push({ fileName, data });

    cursor += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function columnIndexFromCellRef(ref: string): number {
  let index = 0;
  for (const char of ref) {
    if (char < "A" || char > "Z") {
      break;
    }
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

export function parseMichiganMitnExportXlsxRows(buffer: Buffer): string[][] {
  const entries = readZipEntries(buffer);
  const sheet = entries.find((entry) => entry.fileName === "xl/worksheets/sheet1.xml");
  if (!sheet) {
    throw new Error("Michigan MiTN xlsx: missing xl/worksheets/sheet1.xml");
  }
  const xml = sheet.data.toString("utf8");

  const rows: string[][] = [];
  for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cellMatch of (rowMatch[1] ?? "").matchAll(
      /<c r="([A-Z]+)\d+"[^>]*?(?:\/>|>(?:<is><t[^>]*>([\s\S]*?)<\/t><\/is>|<v>([\s\S]*?)<\/v>)?<\/c>)/g
    )) {
      const columnIndex = columnIndexFromCellRef(cellMatch[1] ?? "");
      if (columnIndex < 0) {
        continue;
      }
      while (cells.length < columnIndex) {
        cells.push("");
      }
      cells[columnIndex] = decodeHtmlEntities((cellMatch[2] ?? cellMatch[3] ?? "").trim());
    }
    rows.push(cells);
  }
  return rows;
}

// --- Deduplication ---------------------------------------------------------

/**
 * Live exports repeat every receipt of an amended statement — once from the
 * original filing and once from the amendment (verified live: a 2025 export
 * carried 5,003 rows over 2,505 unique receipt ids, doubling the total).
 * Dedupe raw export rows by Receipt ID, preferring the AMENDED document (it
 * is the corrected filing — 7 of Nesbitt's amended receipts changed amounts),
 * and drop child rows outright (Record Type 2 = itemizations of a parent
 * receipt; summing them double-counts). Amendments can also span statement
 * years, so callers must dedupe across the whole cycle, not per export.
 */
export function dedupeMichiganMitnExportRows(rows: readonly (readonly string[])[]): string[][] {
  if (rows.length === 0) {
    return [];
  }
  const header = rows[0] ?? [];
  const receiptIdColumn = header.findIndex((label) => label.trim() === "Receipt ID");
  const documentTypeColumn = header.findIndex((label) => label.trim() === "Document Type");
  const recordTypeColumn = header.findIndex((label) => label.trim().startsWith("Record Type"));
  if (receiptIdColumn < 0) {
    throw new Error("Michigan MiTN export: missing Receipt ID column");
  }

  const isAmended = (row: readonly string[]): boolean =>
    documentTypeColumn >= 0 && /AMENDED/i.test(row[documentTypeColumn] ?? "");

  const bestByReceiptId = new Map<string, readonly string[]>();
  const order: string[] = [];
  for (const row of rows.slice(1)) {
    if (recordTypeColumn >= 0) {
      const recordType = (row[recordTypeColumn] ?? "").trim();
      if (recordType && recordType !== "1") {
        continue;
      }
    }
    const receiptId = (row[receiptIdColumn] ?? "").trim();
    if (!receiptId) {
      continue;
    }
    const previous = bestByReceiptId.get(receiptId);
    if (!previous) {
      bestByReceiptId.set(receiptId, row);
      order.push(receiptId);
      continue;
    }
    if (isAmended(row) || !isAmended(previous)) {
      // A newer row wins unless it would replace an amendment with an
      // original: amended > original, later > earlier within the same class.
      bestByReceiptId.set(receiptId, row);
    }
  }
  return [
    [...header],
    ...order.map((receiptId) => [...(bestByReceiptId.get(receiptId) ?? [])]),
  ];
}

/** Minimum receipt schema; addresses and other descriptive columns are optional. */
export const MICHIGAN_MITN_REQUIRED_CONTRIBUTION_HEADERS = [
  "Record Type (1=Parent, 2=Child)",
  "Receipt ID",
  "Filing Status (C=Complete,I=Incomplete)",
  "Document Type",
  "Document Statement Year",
  "Document Statement Type",
  "Receiving Committee Name",
  "Receiving Committee ID#",
  "Receiving Committee Type",
  "Type of Contribution",
  "Contributor First Name",
  "Organization Name/Contributor Last Name",
  "Date of Contribution",
  "Amount of Contribution",
] as const;

export function validateMichiganMitnContributionExportHeader(rows: readonly (readonly string[])[]): void {
  const header = rows[0]?.map((name) => name.trim()) ?? [];
  const names = new Set(header);
  const missing = MICHIGAN_MITN_REQUIRED_CONTRIBUTION_HEADERS.filter((name) => !names.has(name));
  if (missing.length || names.size !== header.length) {
    throw new Error(`Michigan MiTN contribution export has missing or duplicate required headers: ${missing.join(", ")}`);
  }
}

// --- Mapping to the legacy row shape --------------------------------------

const EXPORT_HEADER_TO_FIELD: ReadonlyMap<string, keyof MichiganMitnLegacyContributionRow> = new Map([
  ["Receipt ID", "contribution_id"],
  ["Document Statement Year", "doc_stmnt_year"],
  ["Document Statement Type", "doc_type_desc"],
  ["Receiving Committee Name", "com_legal_name"],
  ["Receiving Committee ID#", "cfr_com_id"],
  ["Receiving Candidate First Name", "can_first_name"],
  ["Receiving Candidate Last Name", "can_last_name"],
  ["Type of Contribution", "contribtype"],
  ["Contributor First Name", "f_name"],
  ["Organization Name/Contributor Last Name", "l_name_or_org"],
  ["Contributor Address", "address"],
  ["Contributor City", "city"],
  ["Contributor State", "state"],
  ["Contributor Zip", "zip"],
  ["Contributor Occupation", "occupation"],
  ["Contributor Employer", "employer"],
  ["Date of Contribution", "received_date"],
  ["Amount of Contribution", "amount"],
  ["Cumulative from this person/org", "aggregate"],
]);

/** The export writes long-form committee types; the legacy rows use codes. */
const EXPORT_COMMITTEE_TYPE_TO_LEGACY: ReadonlyMap<string, string> = new Map([
  ["Candidate", "CAN"],
  ["Ballot Question", "BAL"],
  ["Independent", "IND"],
  ["Independent Expenditure", "IND"],
  ["Caucus", "CAU"],
  ["Political", "POL"],
]);

function emptyLegacyContributionRow(): MichiganMitnLegacyContributionRow {
  return {
    doc_seq_no: "",
    page_no: "",
    contribution_id: "",
    cont_detail_id: "",
    doc_stmnt_year: "",
    doc_type_desc: "",
    com_legal_name: "",
    common_name: "",
    cfr_com_id: "",
    com_type: "",
    can_first_name: "",
    can_last_name: "",
    contribtype: "",
    f_name: "",
    l_name_or_org: "",
    address: "",
    city: "",
    state: "",
    zip: "",
    occupation: "",
    employer: "",
    received_date: "",
    amount: "",
    aggregate: "",
    extra_desc: "",
  };
}

/**
 * Maps MiTN export rows onto the legacy contribution-row shape so every
 * downstream consumer (resolver, aggregators, sync, writer) works unchanged.
 */
export function michiganMitnExportRowsToLegacyContributionRows(
  rows: readonly (readonly string[])[]
): MichiganMitnLegacyContributionRow[] {
  validateMichiganMitnContributionExportHeader(rows);
  const header = rows[0] ?? [];
  const fieldByColumn = new Map<number, keyof MichiganMitnLegacyContributionRow>();
  let committeeTypeColumn = -1;
  header.forEach((label, columnIndex) => {
    const trimmed = label.trim();
    const field = EXPORT_HEADER_TO_FIELD.get(trimmed);
    if (field) {
      fieldByColumn.set(columnIndex, field);
    }
    if (trimmed === "Receiving Committee Type") {
      committeeTypeColumn = columnIndex;
    }
  });
  if (fieldByColumn.size === 0) {
    throw new Error("Michigan MiTN export: no recognized header columns");
  }

  const mapped: MichiganMitnLegacyContributionRow[] = [];
  for (const row of rows.slice(1)) {
    if (row.every((cell) => !cell.trim())) {
      continue;
    }
    const legacyRow = emptyLegacyContributionRow();
    for (const [columnIndex, field] of fieldByColumn) {
      legacyRow[field] = (row[columnIndex] ?? "").trim();
    }
    if (committeeTypeColumn >= 0) {
      const exportType = (row[committeeTypeColumn] ?? "").trim();
      legacyRow.com_type = EXPORT_COMMITTEE_TYPE_TO_LEGACY.get(exportType) ?? exportType;
    }
    mapped.push(legacyRow);
  }
  return mapped;
}
