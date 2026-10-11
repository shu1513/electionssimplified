import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { createInflateRaw } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const EOCD_MIN_LENGTH = 22;
const EOCD_MAX_COMMENT_LENGTH = 65_535;
const ZIP64_EXTENDED_INFORMATION_EXTRA_FIELD_ID = 0x0001;

export const TEXAS_TEC_FILERS_CSV_FILE_NAME = "filers.csv";
export const TEXAS_TEC_CANDIDATES_CSV_FILE_NAME = "cand.csv";
export const TEXAS_TEC_SPACS_CSV_FILE_NAME = "spacs.csv";
export const TEXAS_TEC_PURPOSE_CSV_FILE_NAME = "purpose.csv";

export const TEXAS_TEC_CONTRIBUTION_CSV_FILE_PATTERN = /^contribs_\d+\.csv$/;
export const TEXAS_TEC_EXPENDITURE_CSV_FILE_PATTERN = /^expend_\d+\.csv$/;

export const TEXAS_TEC_FILER_COLUMNS = [
  "recordType",
  "filerIdent",
  "filerTypeCd",
  "filerName",
  "committeeStatusCd",
  "filerFilerpersStatusCd",
  "contestSeekOfficeCd",
  "contestSeekOfficeDistrict",
  "contestSeekOfficePlace",
  "contestSeekOfficeDescr",
  "contestSeekOfficeCountyCd",
  "contestSeekOfficeCountyDescr",
  "filerPersentTypeCd",
  "filerNameOrganization",
  "filerNameLast",
  "filerNameFirst",
  "filerNameShort",
] as const;

export const TEXAS_TEC_CONTRIBUTION_COLUMNS = [
  "recordType",
  "formTypeCd",
  "schedFormTypeCd",
  "reportInfoIdent",
  "receivedDt",
  "infoOnlyFlag",
  "filerIdent",
  "filerTypeCd",
  "filerName",
  "contributionInfoId",
  "contributionDt",
  "contributionAmount",
  "contributionDescr",
  "contributorPersentTypeCd",
  "contributorNameOrganization",
  "contributorNameLast",
  "contributorNameFirst",
  "contributorStreetStateCd",
  "contributorEmployer",
  "contributorOccupation",
  "contributorJobTitle",
  "contributorOosPacFlag",
  "contributorPacFein",
] as const;

export const TEXAS_TEC_CANDIDATE_COLUMNS = [
  "recordType",
  "formTypeCd",
  "schedFormTypeCd",
  "reportInfoIdent",
  "receivedDt",
  "infoOnlyFlag",
  "filerIdent",
  "filerTypeCd",
  "filerName",
  "expendInfoId",
  "expendPersentId",
  "expendDt",
  "expendAmount",
  "expendDescr",
  "expendCatCd",
  "expendCatDescr",
  "itemizeFlag",
  "politicalExpendCd",
  "reimburseIntendedFlag",
  "srcCorpContribFlag",
  "capitalLivingexpFlag",
  "candidatePersentTypeCd",
  "candidateNameOrganization",
  "candidateNameLast",
  "candidateNameSuffixCd",
  "candidateNameFirst",
  "candidateNamePrefixCd",
  "candidateNameShort",
  "candidateHoldOfficeCd",
  "candidateHoldOfficeDistrict",
  "candidateHoldOfficePlace",
  "candidateHoldOfficeDescr",
  "candidateHoldOfficeCountyCd",
  "candidateHoldOfficeCountyDescr",
  "candidateSeekOfficeCd",
  "candidateSeekOfficeDistrict",
  "candidateSeekOfficePlace",
  "candidateSeekOfficeDescr",
  "candidateSeekOfficeCountyCd",
  "candidateSeekOfficeCountyDescr",
] as const;

export const TEXAS_TEC_EXPENDITURE_COLUMNS = [
  "recordType",
  "formTypeCd",
  "schedFormTypeCd",
  "reportInfoIdent",
  "receivedDt",
  "infoOnlyFlag",
  "filerIdent",
  "filerTypeCd",
  "filerName",
  "expendInfoId",
  "expendDt",
  "expendAmount",
  "expendDescr",
  "expendCatCd",
  "expendCatDescr",
  "politicalExpendCd",
  "payeePersentTypeCd",
  "payeeNameOrganization",
  "payeeNameLast",
  "payeeNameFirst",
] as const;

export const TEXAS_TEC_SPAC_COLUMNS = [
  "recordType",
  "spacFilerIdent",
  "spacFilerTypeCd",
  "spacFilerName",
  "spacFilerNameShort",
  "spacCommitteeStatusCd",
  "spacPositionCd",
  "candidateFilerIdent",
  "candidateFilerTypeCd",
  "candidateFilerName",
  "candidateFilerpersStatusCd",
  "candidateSeekOfficeCd",
  "candidateSeekOfficeDistrict",
  "candidateSeekOfficePlace",
  "candidateSeekOfficeDescr",
  "candidateSeekOfficeCountyCd",
  "candidateSeekOfficeCountyDescr",
] as const;

export const TEXAS_TEC_PURPOSE_COLUMNS = [
  "recordType",
  "formTypeCd",
  "reportInfoIdent",
  "receivedDt",
  "infoOnlyFlag",
  "filerIdent",
  "filerTypeCd",
  "filerName",
  "committeeActivityId",
  "subjectCategoryCd",
  "subjectPositionCd",
  "subjectDescr",
  "subjectElectionDt",
  "activitySeekOfficeCd",
  "activitySeekOfficeDistrict",
  "activitySeekOfficePlace",
  "activitySeekOfficeDescr",
  "activitySeekOfficeCountyCd",
  "activitySeekOfficeCountyDescr",
  "commActivityName",
] as const;

export type TexasTecCsvDatabaseZipCompressionMethod = "stored" | "deflated" | `unsupported_${number}`;

export type TexasTecCsvDatabaseZipEntry = {
  fileName: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: TexasTecCsvDatabaseZipCompressionMethod;
  isDirectory: boolean;
};

type InternalZipEntry = TexasTecCsvDatabaseZipEntry & {
  compressionMethodCode: number;
  localHeaderOffset: number;
  encrypted: boolean;
};

export type TexasTecCsvRow = Record<string, string>;
export type TexasTecCsvRowPredicate = (row: TexasTecCsvRow) => boolean;
export type TexasTecFilerRow = Record<(typeof TEXAS_TEC_FILER_COLUMNS)[number], string>;
export type TexasTecContributionRow = Record<Exclude<(typeof TEXAS_TEC_CONTRIBUTION_COLUMNS)[number], "contributorOosPacFlag" | "contributorPacFein">, string> & {
  contributorOosPacFlag?: string;
  contributorPacFein?: string;
};
export type TexasTecCandidateRow = Record<(typeof TEXAS_TEC_CANDIDATE_COLUMNS)[number], string>;
export type TexasTecExpenditureRow = Record<(typeof TEXAS_TEC_EXPENDITURE_COLUMNS)[number], string>;
export type TexasTecSpacRow = Record<(typeof TEXAS_TEC_SPAC_COLUMNS)[number], string>;
export type TexasTecPurposeRow = Record<(typeof TEXAS_TEC_PURPOSE_COLUMNS)[number], string>;

export function texasTecContributionCsvFileName(partition: number): string {
  return `contribs_${normalizeTexasTecCsvPartition(partition)}.csv`;
}

export function texasTecExpenditureCsvFileName(partition: number): string {
  return `expend_${normalizeTexasTecCsvPartition(partition)}.csv`;
}

export function normalizeTexasTecCsvPartition(partition: number): string {
  if (!Number.isSafeInteger(partition) || partition < 0) {
    throw new Error(`Invalid Texas TEC CSV partition: ${partition}`);
  }
  return String(partition).padStart(2, "0");
}

function normalizePositiveInteger(value: number | undefined, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid Texas TEC CSV database ${fieldName}: ${value}`);
  }
  return value;
}

function compressionMethodName(method: number): TexasTecCsvDatabaseZipCompressionMethod {
  if (method === 0) {
    return "stored";
  }
  if (method === 8) {
    return "deflated";
  }
  return `unsupported_${method}`;
}

function readZip64Number(value: bigint, fieldName: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Texas TEC ZIP64 ${fieldName} is too large for the lightweight reader`);
  }
  return Number(value);
}

function readZip64ExtendedInformation(input: {
  extraField: Buffer;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  fileName: string;
}): { compressedSize: number; uncompressedSize: number; localHeaderOffset: number } {
  let offset = 0;
  while (offset + 4 <= input.extraField.length) {
    const headerId = input.extraField.readUInt16LE(offset);
    const dataSize = input.extraField.readUInt16LE(offset + 2);
    const dataStart = offset + 4;
    const dataEnd = dataStart + dataSize;
    if (dataEnd > input.extraField.length) {
      break;
    }

    if (headerId === ZIP64_EXTENDED_INFORMATION_EXTRA_FIELD_ID) {
      let dataOffset = dataStart;
      const nextZip64Value = (fieldName: string): number => {
        if (dataOffset + 8 > dataEnd) {
          throw new Error(`Texas TEC ZIP64 ${fieldName} is missing for ${input.fileName}`);
        }
        const value = readZip64Number(input.extraField.readBigUInt64LE(dataOffset), fieldName);
        dataOffset += 8;
        return value;
      };

      return {
        uncompressedSize:
          input.uncompressedSize === 0xffffffff
            ? nextZip64Value("uncompressed size")
            : input.uncompressedSize,
        compressedSize:
          input.compressedSize === 0xffffffff ? nextZip64Value("compressed size") : input.compressedSize,
        localHeaderOffset:
          input.localHeaderOffset === 0xffffffff
            ? nextZip64Value("local header offset")
            : input.localHeaderOffset,
      };
    }

    offset = dataEnd;
  }

  if (
    input.compressedSize === 0xffffffff ||
    input.uncompressedSize === 0xffffffff ||
    input.localHeaderOffset === 0xffffffff
  ) {
    throw new Error(`ZIP64 Texas TEC entry is missing extended information: ${input.fileName}`);
  }

  return {
    compressedSize: input.compressedSize,
    uncompressedSize: input.uncompressedSize,
    localHeaderOffset: input.localHeaderOffset,
  };
}

async function readFileRange(path: string, position: number, length: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead !== length) {
      throw new Error(`Unable to read Texas TEC ZIP range at ${position}`);
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

function findEndOfCentralDirectory(tail: Buffer): number {
  for (let offset = tail.length - EOCD_MIN_LENGTH; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== EOCD_SIGNATURE) {
      continue;
    }
    const commentLength = tail.readUInt16LE(offset + 20);
    if (offset + EOCD_MIN_LENGTH + commentLength === tail.length) {
      return offset;
    }
  }
  throw new Error("Texas TEC ZIP end-of-central-directory record not found");
}

async function readCentralDirectory(path: string): Promise<Buffer> {
  const fileStat = await stat(path);
  if (!fileStat.isFile()) {
    throw new Error(`Texas TEC CSV database ZIP path is not a file: ${path}`);
  }
  if (fileStat.size < EOCD_MIN_LENGTH) {
    throw new Error(`Texas TEC CSV database ZIP is too small: ${path}`);
  }

  const tailLength = Math.min(fileStat.size, EOCD_MIN_LENGTH + EOCD_MAX_COMMENT_LENGTH);
  const tail = await readFileRange(path, fileStat.size - tailLength, tailLength);
  const eocdOffset = findEndOfCentralDirectory(tail);

  const diskNumber = tail.readUInt16LE(eocdOffset + 4);
  const centralDirectoryDisk = tail.readUInt16LE(eocdOffset + 6);
  if (diskNumber !== 0 || centralDirectoryDisk !== 0) {
    throw new Error("Multi-disk Texas TEC ZIP archives are not supported");
  }

  const centralDirectorySize = tail.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = tail.readUInt32LE(eocdOffset + 16);
  if (centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
    throw new Error("ZIP64 Texas TEC archives are not supported by the lightweight reader");
  }
  if (centralDirectoryOffset + centralDirectorySize > fileStat.size) {
    throw new Error("Texas TEC ZIP central directory points outside the archive");
  }

  return await readFileRange(path, centralDirectoryOffset, centralDirectorySize);
}

function parseCentralDirectory(buffer: Buffer): InternalZipEntry[] {
  const entries: InternalZipEntry[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error(`Invalid Texas TEC ZIP central directory entry at offset ${offset}`);
    }

    const flags = buffer.readUInt16LE(offset + 8);
    const compressionMethodCode = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraFieldLength = buffer.readUInt16LE(offset + 30);
    const fileCommentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileNameStart = offset + 46;
    const fileNameEnd = fileNameStart + fileNameLength;
    const fileName = buffer.toString("utf8", fileNameStart, fileNameEnd).replace(/\\/g, "/");
    const extraField = buffer.subarray(fileNameEnd, fileNameEnd + extraFieldLength);

    const zip64Values = readZip64ExtendedInformation({
      extraField,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      fileName,
    });

    entries.push({
      fileName,
      compressedSize: zip64Values.compressedSize,
      uncompressedSize: zip64Values.uncompressedSize,
      compressionMethod: compressionMethodName(compressionMethodCode),
      compressionMethodCode,
      isDirectory: fileName.endsWith("/"),
      localHeaderOffset: zip64Values.localHeaderOffset,
      encrypted: (flags & 0x1) === 0x1,
    });

    offset = fileNameEnd + extraFieldLength + fileCommentLength;
  }

  return entries;
}

async function readZipEntries(path: string): Promise<InternalZipEntry[]> {
  return parseCentralDirectory(await readCentralDirectory(path));
}

export async function listTexasTecCsvDatabaseZipEntries(
  zipPath: string
): Promise<TexasTecCsvDatabaseZipEntry[]> {
  return (await readZipEntries(zipPath)).map(({ compressionMethodCode, localHeaderOffset, encrypted, ...entry }) => entry);
}

async function readEntryDataOffset(zipPath: string, entry: InternalZipEntry): Promise<number> {
  const localHeader = await readFileRange(zipPath, entry.localHeaderOffset, 30);
  if (localHeader.readUInt32LE(0) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error(`Invalid Texas TEC ZIP local header for ${entry.fileName}`);
  }
  const fileNameLength = localHeader.readUInt16LE(26);
  const extraFieldLength = localHeader.readUInt16LE(28);
  return entry.localHeaderOffset + 30 + fileNameLength + extraFieldLength;
}

function normalizeCsvHeader(value: string): string {
  return value.replace(/^\uFEFF/, "").trim();
}

function requireColumns(headers: readonly string[], requiredColumns: readonly string[] | undefined, tableLabel: string): void {
  if (!requiredColumns) {
    return;
  }
  const headerSet = new Set(headers.map(normalizeCsvHeader));
  const missing = requiredColumns.filter((column) => !headerSet.has(column));
  if (missing.length > 0) {
    throw new Error(`Missing required Texas TEC ${tableLabel} CSV column: ${missing[0]}`);
  }
}

function rowObjectFromCells(headers: readonly string[], cells: readonly string[]): TexasTecCsvRow {
  return Object.fromEntries(headers.map((header, index) => [header || `column_${index + 1}`, cells[index]?.trim() ?? ""]));
}

async function streamTexasTecCsvRows(input: {
  zipPath: string;
  entry: InternalZipEntry;
  predicate?: TexasTecCsvRowPredicate;
  maxRows?: number;
  requiredColumns?: readonly string[];
  tableLabel: string;
}): Promise<TexasTecCsvRow[]> {
  if (input.entry.encrypted) {
    throw new Error(`Encrypted Texas TEC ZIP entries are not supported: ${input.entry.fileName}`);
  }
  if (input.entry.compressionMethodCode !== 0 && input.entry.compressionMethodCode !== 8) {
    throw new Error(
      `Unsupported Texas TEC ZIP compression method ${input.entry.compressionMethodCode} for ${input.entry.fileName}`
    );
  }
  if (input.entry.compressedSize === 0) {
    throw new Error(`Texas TEC CSV entry is empty: ${input.entry.fileName}`);
  }

  const dataOffset = await readEntryDataOffset(input.zipPath, input.entry);
  const source = createReadStream(input.zipPath, {
    start: dataOffset,
    end: dataOffset + input.entry.compressedSize - 1,
  });
  const stream = input.entry.compressionMethodCode === 8 ? source.pipe(createInflateRaw()) : source;
  const decoder = new StringDecoder("utf8");

  return await new Promise((resolve, reject) => {
    const rows: TexasTecCsvRow[] = [];
    let headers: string[] | null = null;
    let row: string[] = [];
    let field = "";
    let inQuotes = false;
    let pendingQuoteInQuotedField = false;
    let settled = false;

    const rejectOnce = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    const resolveOnce = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(rows);
    };

    const consumeCompletedRow = (cells: string[]): void => {
      if (!cells.some((value) => value.trim().length > 0)) {
        return;
      }
      if (!headers) {
        headers = cells.map(normalizeCsvHeader);
        requireColumns(headers, input.requiredColumns, input.tableLabel);
        return;
      }
      if (input.maxRows !== undefined && rows.length >= input.maxRows) {
        return;
      }

      const parsedRow = rowObjectFromCells(headers, cells);
      if (!input.predicate || input.predicate(parsedRow)) {
        rows.push(parsedRow);
        if (input.maxRows !== undefined && rows.length >= input.maxRows) {
          source.destroy();
          if (stream !== source) {
            stream.destroy();
          }
          resolveOnce();
        }
      }
    };

    const finishCurrentRow = (): void => {
      row.push(field);
      consumeCompletedRow(row);
      row = [];
      field = "";
    };

    const processText = (text: string, isFinal = false): void => {
      let index = 0;
      if (pendingQuoteInQuotedField) {
        pendingQuoteInQuotedField = false;
        if (text[0] === '"') {
          field += '"';
          index = 1;
        } else {
          inQuotes = false;
        }
      }

      for (; index < text.length && !settled; index += 1) {
        const char = text[index];
        const next = text[index + 1];

        if (inQuotes) {
          if (char === '"' && next === '"') {
            field += '"';
            index += 1;
          } else if (char === '"' && next === undefined && !isFinal) {
            pendingQuoteInQuotedField = true;
          } else if (char === '"') {
            inQuotes = false;
          } else {
            field += char;
          }
          continue;
        }

        if (char === '"') {
          inQuotes = true;
          continue;
        }

        if (char === ",") {
          row.push(field);
          field = "";
          continue;
        }

        if (char === "\n") {
          finishCurrentRow();
          continue;
        }

        if (char === "\r") {
          continue;
        }

        field += char;
      }

      if (isFinal && pendingQuoteInQuotedField) {
        pendingQuoteInQuotedField = false;
        inQuotes = false;
      }
    };

    stream.on("data", (chunk: Buffer) => {
      try {
        processText(decoder.write(chunk));
      } catch (error) {
        rejectOnce(error instanceof Error ? error : new Error(String(error)));
        source.destroy();
        if (stream !== source) {
          stream.destroy();
        }
      }
    });
    stream.on("end", () => {
      if (settled) {
        return;
      }
      try {
        processText(decoder.end(), true);
        if (inQuotes) {
          throw new Error(`Texas TEC CSV has an unterminated quoted field: ${input.entry.fileName}`);
        }
        if (field.length > 0 || row.length > 0) {
          finishCurrentRow();
        }
        resolveOnce();
      } catch (error) {
        rejectOnce(error instanceof Error ? error : new Error(String(error)));
      }
    });
    stream.on("error", (error: Error) => rejectOnce(error));
  });
}

export async function readTexasTecCsvDatabaseTableRows(input: {
  zipPath: string;
  fileName: string;
  predicate?: TexasTecCsvRowPredicate;
  maxRows?: number;
  requiredColumns?: readonly string[];
  tableLabel?: string;
}): Promise<TexasTecCsvRow[]> {
  const maxRows = normalizePositiveInteger(input.maxRows, "maxRows");
  const entries = await readZipEntries(input.zipPath);
  const entry = entries.find((candidate) => candidate.fileName === input.fileName);
  if (!entry || entry.isDirectory) {
    throw new Error(`Texas TEC CSV table not found in ZIP: ${input.fileName}`);
  }

  return await streamTexasTecCsvRows({
    zipPath: input.zipPath,
    entry,
    predicate: input.predicate,
    maxRows,
    requiredColumns: input.requiredColumns,
    tableLabel: input.tableLabel ?? input.fileName,
  });
}

export async function listTexasTecContributionCsvFileNames(zipPath: string): Promise<string[]> {
  return (await listTexasTecCsvDatabaseZipEntries(zipPath))
    .filter((entry) => !entry.isDirectory && TEXAS_TEC_CONTRIBUTION_CSV_FILE_PATTERN.test(entry.fileName))
    .map((entry) => entry.fileName)
    .sort((left, right) => Number(left.match(/_(\d+)\.csv$/)![1]) - Number(right.match(/_(\d+)\.csv$/)![1]) || left.localeCompare(right));
}

export async function listTexasTecExpenditureCsvFileNames(zipPath: string): Promise<string[]> {
  return (await listTexasTecCsvDatabaseZipEntries(zipPath))
    .filter((entry) => !entry.isDirectory && TEXAS_TEC_EXPENDITURE_CSV_FILE_PATTERN.test(entry.fileName))
    .map((entry) => entry.fileName)
    .sort((left, right) => Number(left.match(/_(\d+)\.csv$/)![1]) - Number(right.match(/_(\d+)\.csv$/)![1]) || left.localeCompare(right));
}

async function readTexasTecTypedRows<TColumns extends readonly string[]>(input: {
  zipPath: string;
  fileName: string;
  columns: TColumns;
  tableLabel: string;
  predicate?: (row: Record<TColumns[number], string>) => boolean;
  maxRows?: number;
}): Promise<Record<TColumns[number], string>[]> {
  const rows = await readTexasTecCsvDatabaseTableRows({
    zipPath: input.zipPath,
    fileName: input.fileName,
    requiredColumns: input.columns,
    tableLabel: input.tableLabel,
    predicate: input.predicate as TexasTecCsvRowPredicate | undefined,
    maxRows: input.maxRows,
  });
  return rows as Record<TColumns[number], string>[];
}

export async function readTexasTecFilerRows(input: {
  zipPath: string;
  predicate?: (row: TexasTecFilerRow) => boolean;
  maxRows?: number;
}): Promise<TexasTecFilerRow[]> {
  return await readTexasTecTypedRows({
    zipPath: input.zipPath,
    fileName: TEXAS_TEC_FILERS_CSV_FILE_NAME,
    columns: TEXAS_TEC_FILER_COLUMNS,
    tableLabel: "filer",
    predicate: input.predicate,
    maxRows: input.maxRows,
  });
}

export async function readTexasTecContributionRows(input: {
  zipPath: string;
  fileName: string;
  predicate?: (row: TexasTecContributionRow) => boolean;
  maxRows?: number;
}): Promise<TexasTecContributionRow[]> {
  if (!TEXAS_TEC_CONTRIBUTION_CSV_FILE_PATTERN.test(input.fileName)) {
    throw new Error(`Invalid Texas TEC contribution CSV file name: ${input.fileName}`);
  }
  return await readTexasTecTypedRows({
    zipPath: input.zipPath,
    fileName: input.fileName,
    columns: TEXAS_TEC_CONTRIBUTION_COLUMNS,
    tableLabel: "contribution",
    predicate: input.predicate,
    maxRows: input.maxRows,
  });
}

export async function readTexasTecCandidateRows(input: {
  zipPath: string;
  predicate?: (row: TexasTecCandidateRow) => boolean;
  maxRows?: number;
}): Promise<TexasTecCandidateRow[]> {
  return await readTexasTecTypedRows({
    zipPath: input.zipPath,
    fileName: TEXAS_TEC_CANDIDATES_CSV_FILE_NAME,
    columns: TEXAS_TEC_CANDIDATE_COLUMNS,
    tableLabel: "candidate",
    predicate: input.predicate,
    maxRows: input.maxRows,
  });
}

export async function readTexasTecExpenditureRows(input: {
  zipPath: string;
  fileName: string;
  predicate?: (row: TexasTecExpenditureRow) => boolean;
  maxRows?: number;
}): Promise<TexasTecExpenditureRow[]> {
  if (!TEXAS_TEC_EXPENDITURE_CSV_FILE_PATTERN.test(input.fileName)) {
    throw new Error(`Invalid Texas TEC expenditure CSV file name: ${input.fileName}`);
  }
  return await readTexasTecTypedRows({
    zipPath: input.zipPath,
    fileName: input.fileName,
    columns: TEXAS_TEC_EXPENDITURE_COLUMNS,
    tableLabel: "expenditure",
    predicate: input.predicate,
    maxRows: input.maxRows,
  });
}

export async function readTexasTecSpacRows(input: {
  zipPath: string;
  predicate?: (row: TexasTecSpacRow) => boolean;
  maxRows?: number;
}): Promise<TexasTecSpacRow[]> {
  return await readTexasTecTypedRows({
    zipPath: input.zipPath,
    fileName: TEXAS_TEC_SPACS_CSV_FILE_NAME,
    columns: TEXAS_TEC_SPAC_COLUMNS,
    tableLabel: "SPAC",
    predicate: input.predicate,
    maxRows: input.maxRows,
  });
}

export async function readTexasTecPurposeRows(input: {
  zipPath: string;
  predicate?: (row: TexasTecPurposeRow) => boolean;
  maxRows?: number;
}): Promise<TexasTecPurposeRow[]> {
  return await readTexasTecTypedRows({
    zipPath: input.zipPath,
    fileName: TEXAS_TEC_PURPOSE_CSV_FILE_NAME,
    columns: TEXAS_TEC_PURPOSE_COLUMNS,
    tableLabel: "purpose",
    predicate: input.predicate,
    maxRows: input.maxRows,
  });
}
