import { open, stat } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

import {
  type IndianaCampaignFinanceArtifactKind,
  normalizeIndianaCampaignFinanceArtifactIdentity,
} from "./indianaCampaignFinanceArtifactCache.js";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const EOCD_MIN_LENGTH = 22;
const EOCD_MAX_COMMENT_LENGTH = 65_535;

type InternalZipEntry = {
  fileName: string;
  compressedSize: number;
  compressionMethodCode: number;
  isDirectory: boolean;
  localHeaderOffset: number;
  encrypted: boolean;
};

export const INDIANA_CAMPAIGN_FINANCE_CONTRIBUTION_COLUMNS = [
  "FileNumber",
  "CommitteeType",
  "Committee",
  "CandidateName",
  "ContributorType",
  "Name",
  "Address",
  "City",
  "State",
  "Zip",
  "Occupation",
  "Type",
  "Description",
  "Amount",
  "ContributionDate",
  "Received_By",
  "Amended",
] as const;

export const INDIANA_CAMPAIGN_FINANCE_EXPENDITURE_COLUMNS = [
  "FileNumber",
  "CommitteeType",
  "Committee",
  "CandidateName",
  "ExpenditureCode",
  "Name",
  "Address",
  "City",
  "State",
  "Zip",
  "Occupation",
  "OfficeSought",
  "ExpenditureType",
  "Description",
  "Purpose",
  "Amount",
  "Expenditure_Date",
  "Amended",
] as const;

export type IndianaCampaignFinanceContributionRow = Record<
  (typeof INDIANA_CAMPAIGN_FINANCE_CONTRIBUTION_COLUMNS)[number],
  string
>;
export type IndianaCampaignFinanceExpenditureRow = Record<
  (typeof INDIANA_CAMPAIGN_FINANCE_EXPENDITURE_COLUMNS)[number],
  string
>;

export type IndianaCampaignFinanceContributionRowPredicate = (
  row: IndianaCampaignFinanceContributionRow
) => boolean;
export type IndianaCampaignFinanceExpenditureRowPredicate = (
  row: IndianaCampaignFinanceExpenditureRow
) => boolean;

function officialArtifactPart(kind: IndianaCampaignFinanceArtifactKind): string {
  return kind === "contribution" ? "ContributionData" : "ExpenditureData";
}

export function indianaCampaignFinanceCsvFileName(input: {
  year: number;
  artifactKind: IndianaCampaignFinanceArtifactKind;
}): string {
  const artifact = normalizeIndianaCampaignFinanceArtifactIdentity(input);
  return `${artifact.year}_${officialArtifactPart(artifact.artifactKind)}.csv`;
}

function normalizePositiveInteger(value: number | undefined, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid Indiana campaign finance ${fieldName}: ${value}`);
  }
  return value;
}

async function readFileRange(path: string, position: number, length: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead !== length) {
      throw new Error(`Unable to read Indiana campaign finance ZIP range at ${position}`);
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

function findEndOfCentralDirectory(tail: Buffer): number {
  for (let offset = tail.length - EOCD_MIN_LENGTH; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  throw new Error("Indiana campaign finance ZIP end-of-central-directory record not found");
}

async function readCentralDirectory(path: string): Promise<Buffer> {
  const fileStat = await stat(path);
  if (!fileStat.isFile()) {
    throw new Error(`Indiana campaign finance ZIP path is not a file: ${path}`);
  }
  if (fileStat.size < EOCD_MIN_LENGTH) {
    throw new Error(`Indiana campaign finance ZIP is too small: ${path}`);
  }

  const tailLength = Math.min(fileStat.size, EOCD_MIN_LENGTH + EOCD_MAX_COMMENT_LENGTH);
  const tail = await readFileRange(path, fileStat.size - tailLength, tailLength);
  const eocdOffset = findEndOfCentralDirectory(tail);
  const diskNumber = tail.readUInt16LE(eocdOffset + 4);
  const centralDirectoryDisk = tail.readUInt16LE(eocdOffset + 6);
  if (diskNumber !== 0 || centralDirectoryDisk !== 0) {
    throw new Error("Multi-disk Indiana campaign finance ZIP archives are not supported");
  }

  const centralDirectorySize = tail.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = tail.readUInt32LE(eocdOffset + 16);
  if (centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
    throw new Error("ZIP64 Indiana campaign finance archives are not supported by the lightweight reader");
  }
  if (centralDirectoryOffset + centralDirectorySize > fileStat.size) {
    throw new Error("Indiana campaign finance ZIP central directory points outside the archive");
  }
  return await readFileRange(path, centralDirectoryOffset, centralDirectorySize);
}

function parseCentralDirectory(buffer: Buffer): InternalZipEntry[] {
  const entries: InternalZipEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error(`Invalid Indiana campaign finance ZIP central directory entry at offset ${offset}`);
    }

    const flags = buffer.readUInt16LE(offset + 8);
    const compressionMethodCode = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraFieldLength = buffer.readUInt16LE(offset + 30);
    const fileCommentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileNameStart = offset + 46;
    const fileNameEnd = fileNameStart + fileNameLength;
    const fileName = buffer.toString("utf8", fileNameStart, fileNameEnd).replace(/\\/g, "/");

    if (compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new Error(`ZIP64 Indiana campaign finance entry is not supported: ${fileName}`);
    }

    entries.push({
      fileName,
      compressedSize,
      compressionMethodCode,
      isDirectory: fileName.endsWith("/"),
      localHeaderOffset,
      encrypted: (flags & 0x1) === 0x1,
    });
    offset = fileNameEnd + extraFieldLength + fileCommentLength;
  }
  return entries;
}

async function readZipEntries(path: string): Promise<InternalZipEntry[]> {
  return parseCentralDirectory(await readCentralDirectory(path));
}

async function readEntryDataOffset(zipPath: string, entry: InternalZipEntry): Promise<number> {
  const localHeader = await readFileRange(zipPath, entry.localHeaderOffset, 30);
  if (localHeader.readUInt32LE(0) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error(`Invalid Indiana campaign finance ZIP local header for ${entry.fileName}`);
  }
  const fileNameLength = localHeader.readUInt16LE(26);
  const extraFieldLength = localHeader.readUInt16LE(28);
  return entry.localHeaderOffset + 30 + fileNameLength + extraFieldLength;
}

export function parseIndianaCampaignFinanceCsvRows(csv: string): string[][] {
  const text = csv.replace(/^\uFEFF/, ""), rows: string[][] = [];
  let row: string[] = [], field = "", state: "start" | "plain" | "quoted" | "closed" = "start";
  const finishField = () => { row.push(field); field = ""; state = "start"; };
  const finishRow = () => { finishField(); rows.push(row); row = []; };
  for (let index = 0; index < text.length; index++) {
    const char = text[index], next = text[index + 1];
    if (state === "quoted") {
      if (char === '"' && next === '"') { field += '"'; index++; }
      else if (char === '"') state = "closed";
      else field += char;
      continue;
    }
    if (char === ",") { finishField(); continue; }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && next === "\n") index++;
      finishRow(); continue;
    }
    if (state === "closed") throw new Error("Indiana campaign finance CSV has text after a closing quote");
    if (char === '"') {
      if (state !== "start") throw new Error("Indiana campaign finance CSV has a quote in an unquoted field");
      state = "quoted"; continue;
    }
    field += char; state = "plain";
  }
  if (state === "quoted") throw new Error("Indiana campaign finance CSV has an unterminated quoted field");
  if (field.length > 0 || row.length > 0 || state === "closed") finishRow();
  return rows.filter(cells => cells.some(cell => cell.trim().length > 0));
}

function normalizeCsvHeader(value: string): string {
  return value.replace(/^\uFEFF/, "").trim();
}

function buildHeaderIndex(header: readonly string[]): Map<string, number> {
  return new Map(header.map((name, index) => [normalizeCsvHeader(name), index]));
}

function requireColumn(headerIndex: ReadonlyMap<string, number>, column: string): number {
  const index = headerIndex.get(column);
  if (index === undefined) {
    throw new Error(`Missing required Indiana campaign finance CSV column: ${column}`);
  }
  return index;
}

function cell(cells: readonly string[], index: number): string {
  return cells[index]?.trim() ?? "";
}

function rowObjectFromCells<const Columns extends readonly string[]>(
  cells: readonly string[],
  columns: Columns,
  indexes: Record<Columns[number], number>
): Record<Columns[number], string> {
  const row = {} as Record<Columns[number], string>;
  for (const column of columns as readonly Columns[number][]) {
    row[column] = cell(cells, indexes[column]);
  }
  return row;
}

function parseTypedRows<const Columns extends readonly string[]>(input: {
  csv: string;
  columns: Columns;
  predicate?: (row: Record<Columns[number], string>) => boolean;
  maxRows?: number;
}): Record<Columns[number], string>[] {
  const maxRows = normalizePositiveInteger(input.maxRows, "maxRows");
  const rows = parseIndianaCampaignFinanceCsvRows(input.csv);
  const header = rows[0];
  if (!header) {
    return [];
  }
  if (new Set(header.map(normalizeCsvHeader)).size !== header.length) {
    throw new Error("Indiana campaign finance CSV has duplicate columns");
  }
  if (rows.slice(1).some(cells => cells.length !== header.length)) {
    throw new Error("Indiana campaign finance CSV row width does not match its header");
  }
  const headerIndex = buildHeaderIndex(header);
  const indexes = Object.fromEntries(
    input.columns.map((column) => [column, requireColumn(headerIndex, column)])
  ) as Record<Columns[number], number>;

  const result: Record<Columns[number], string>[] = [];
  for (const cells of rows.slice(1)) {
    const row = rowObjectFromCells(cells, input.columns, indexes);
    if (input.predicate && !input.predicate(row)) {
      continue;
    }
    result.push(row);
    if (maxRows !== undefined && result.length >= maxRows) {
      break;
    }
  }
  return result;
}

async function readCsvFromZip(input: {
  zipPath: string;
  year: number;
  artifactKind: IndianaCampaignFinanceArtifactKind;
}): Promise<string> {
  const expectedFileName = indianaCampaignFinanceCsvFileName({
    year: input.year,
    artifactKind: input.artifactKind,
  }).toLowerCase();
  const entries = await readZipEntries(input.zipPath);
  const entry = entries.find((candidate) => !candidate.isDirectory && candidate.fileName.toLowerCase() === expectedFileName);
  if (!entry) {
    throw new Error(`Indiana campaign finance ZIP did not contain expected CSV: ${expectedFileName}`);
  }
  if (entry.encrypted) {
    throw new Error(`Indiana campaign finance ZIP entry is encrypted: ${entry.fileName}`);
  }
  if (entry.compressionMethodCode !== 0 && entry.compressionMethodCode !== 8) {
    throw new Error(`Unsupported Indiana campaign finance ZIP compression method: ${entry.compressionMethodCode}`);
  }

  const dataOffset = await readEntryDataOffset(input.zipPath, entry);
  const compressed = await readFileRange(input.zipPath, dataOffset, entry.compressedSize);
  const csvBuffer = entry.compressionMethodCode === 0 ? compressed : inflateRawSync(compressed);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(csvBuffer); }
  catch { throw new Error("Indiana campaign finance CSV is not valid UTF-8"); }
}

export async function readIndianaCampaignFinanceContributionRows(input: {
  zipPath: string;
  year: number;
  predicate?: IndianaCampaignFinanceContributionRowPredicate;
  maxRows?: number;
}): Promise<IndianaCampaignFinanceContributionRow[]> {
  const csv = await readCsvFromZip({
    zipPath: input.zipPath,
    year: input.year,
    artifactKind: "contribution",
  });
  return parseTypedRows({
    csv,
    columns: INDIANA_CAMPAIGN_FINANCE_CONTRIBUTION_COLUMNS,
    predicate: input.predicate,
    maxRows: input.maxRows,
  }) as IndianaCampaignFinanceContributionRow[];
}

export async function readIndianaCampaignFinanceExpenditureRows(input: {
  zipPath: string;
  year: number;
  predicate?: IndianaCampaignFinanceExpenditureRowPredicate;
  maxRows?: number;
}): Promise<IndianaCampaignFinanceExpenditureRow[]> {
  const csv = await readCsvFromZip({
    zipPath: input.zipPath,
    year: input.year,
    artifactKind: "expenditure",
  });
  return parseTypedRows({
    csv,
    columns: INDIANA_CAMPAIGN_FINANCE_EXPENDITURE_COLUMNS,
    predicate: input.predicate,
    maxRows: input.maxRows,
  }) as IndianaCampaignFinanceExpenditureRow[];
}
