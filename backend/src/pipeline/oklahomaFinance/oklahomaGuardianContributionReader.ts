import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { createInflateRaw } from "node:zlib";

import { normalizeOklahomaGuardianContributionYear } from "./oklahomaGuardianContributionArtifactCache.js";

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

export const OKLAHOMA_GUARDIAN_CONTRIBUTION_COLUMNS = [
  "Receipt ID",
  "Org ID",
  "Receipt Type",
  "Receipt Date",
  "Receipt Amount",
  "Description",
  "Receipt Source Type",
  "Last Name",
  "First Name",
  "Middle Name",
  "Suffix",
  "Address 1",
  "Address 2",
  "City",
  "State",
  "Zip",
  "Filed Date",
  "Committee Type",
  "Committee Name",
  "Candidate Name",
  "Amended",
  "Employer",
  "Occupation",
] as const;

export type OklahomaGuardianContributionRow = Record<
  (typeof OKLAHOMA_GUARDIAN_CONTRIBUTION_COLUMNS)[number],
  string
>;

export type OklahomaGuardianContributionRowPredicate = (row: OklahomaGuardianContributionRow) => boolean;

export function oklahomaGuardianContributionCsvFileName(year: number): string {
  return `${normalizeOklahomaGuardianContributionYear(year)}_ContributionLoanExtract.csv`;
}

function normalizePositiveInteger(value: number | undefined, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid Oklahoma Guardian contribution ${fieldName}: ${value}`);
  }
  return value;
}

async function readFileRange(path: string, position: number, length: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead !== length) {
      throw new Error(`Unable to read Oklahoma Guardian ZIP range at ${position}`);
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
  throw new Error("Oklahoma Guardian ZIP end-of-central-directory record not found");
}

async function readCentralDirectory(path: string): Promise<Buffer> {
  const fileStat = await stat(path);
  if (!fileStat.isFile()) {
    throw new Error(`Oklahoma Guardian contribution ZIP path is not a file: ${path}`);
  }
  if (fileStat.size < EOCD_MIN_LENGTH) {
    throw new Error(`Oklahoma Guardian contribution ZIP is too small: ${path}`);
  }

  const tailLength = Math.min(fileStat.size, EOCD_MIN_LENGTH + EOCD_MAX_COMMENT_LENGTH);
  const tail = await readFileRange(path, fileStat.size - tailLength, tailLength);
  const eocdOffset = findEndOfCentralDirectory(tail);

  const diskNumber = tail.readUInt16LE(eocdOffset + 4);
  const centralDirectoryDisk = tail.readUInt16LE(eocdOffset + 6);
  if (diskNumber !== 0 || centralDirectoryDisk !== 0) {
    throw new Error("Multi-disk Oklahoma Guardian ZIP archives are not supported");
  }

  const centralDirectorySize = tail.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = tail.readUInt32LE(eocdOffset + 16);
  if (centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
    throw new Error("ZIP64 Oklahoma Guardian archives are not supported by the lightweight reader");
  }
  if (centralDirectoryOffset + centralDirectorySize > fileStat.size) {
    throw new Error("Oklahoma Guardian ZIP central directory points outside the archive");
  }

  return await readFileRange(path, centralDirectoryOffset, centralDirectorySize);
}

function parseCentralDirectory(buffer: Buffer): InternalZipEntry[] {
  const entries: InternalZipEntry[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error(`Invalid Oklahoma Guardian ZIP central directory entry at offset ${offset}`);
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
      throw new Error(`ZIP64 Oklahoma Guardian entry is not supported: ${fileName}`);
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
    throw new Error(`Invalid Oklahoma Guardian ZIP local header for ${entry.fileName}`);
  }
  const fileNameLength = localHeader.readUInt16LE(26);
  const extraFieldLength = localHeader.readUInt16LE(28);
  return entry.localHeaderOffset + 30 + fileNameLength + extraFieldLength;
}

const UNTERMINATED_QUOTE_ERROR = "Oklahoma Guardian contribution CSV has an unterminated quoted field";

function isFieldTerminator(char: string | undefined): boolean {
  return char === undefined || char === "," || char === "\n" || char === "\r";
}

type CsvParseTail = {
  row: string[];
  field: string;
  inQuotes: boolean;
};

type CsvTextParse = {
  rows: string[][];
  // [start, end) offset of each completed row in the input text.
  spans: Array<[number, number]>;
  // Parser state for the row still open when the text ended.
  tail: CsvParseTail;
  // Offset where that open row starts.
  tailStart: number;
};

// In tolerant mode, does the field close right after a `""` pair? Guardian's
// `"COLATA "JODY""` ends a field with `""` + the next quoted field. Only a
// line end or the start of the next quoted field counts: Guardian quotes
// every field, so `""` + bare comma is still an escaped quote inside a field
// that continues (`"ACME ""NORTH"", INC"`). `after` undefined means the text
// ended: closed at end of input, unknown (stay open) at a chunk boundary.
function tolerantDoubledQuoteCloses(after: string | undefined, afterNext: string | undefined, atEnd: boolean): boolean {
  if (after === undefined) {
    return atEnd;
  }
  return after === "\n" || after === "\r" || (after === "," && afterNext === '"');
}

// Standard RFC-4180 parsing; `tolerant` is the recovery mode used from the
// first row the standard pass could not split. Guardian exports leave inner
// quotes undoubled (`"JAMES "JIM'"`, `"COLATA "JODY""`), which flips the
// quote state and mis-splits every later row, so recovery has to run from
// the defect to the end of the input. In tolerant mode a quote inside a
// quoted field is literal unless the field ends there, and `""` closes the
// field when the next quoted field starts right after it. Rows before the
// first defect never see tolerant mode, so valid `""` escapes before a comma
// (`"ACME ""NORTH"", INC"`) keep their standard meaning there.
function parseCsvText(csv: string, tolerant: boolean): CsvTextParse {
  const rows: string[][] = [];
  const spans: Array<[number, number]> = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let rowStart = 0;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const next = csv[index + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
        if (tolerant && tolerantDoubledQuoteCloses(csv[index + 1], csv[index + 2], true)) {
          inQuotes = false;
        }
      } else if (char === '"' && (!tolerant || isFieldTerminator(next))) {
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
      row.push(field);
      rows.push(row);
      spans.push([rowStart, index + 1]);
      row = [];
      field = "";
      rowStart = index + 1;
      continue;
    }

    if (char === "\r") {
      continue;
    }

    field += char;
  }

  return { rows, spans, tail: { row, field, inQuotes }, tailStart: rowStart };
}

// Closes out the row left open at end of input: still inside quotes is a
// real defect and fails the file; otherwise it is the last row.
function pushCsvTail(rows: string[][], tail: CsvParseTail): void {
  if (tail.inQuotes) {
    throw new Error(UNTERMINATED_QUOTE_ERROR);
  }
  if (tail.field.length > 0 || tail.row.length > 0) {
    rows.push([...tail.row, tail.field]);
  }
}

function isBlankCsvRow(cells: readonly string[]): boolean {
  return !cells.some((cell) => cell.trim().length > 0);
}

function parseCsvRows(csv: string): string[][] {
  const parsed = parseCsvText(csv, false);
  const expectedCellCount = parsed.rows[0]?.length;
  const firstBadIndex = parsed.rows.findIndex(
    (cells, index) => index > 0 && cells.length !== expectedCellCount && !isBlankCsvRow(cells)
  );

  let rows: string[][];
  if (firstBadIndex < 0 && !parsed.tail.inQuotes) {
    rows = parsed.rows;
    pushCsvTail(rows, parsed.tail);
  } else {
    // Re-parse from the first defect to the end of input in tolerant mode.
    const keep = firstBadIndex >= 0 ? firstBadIndex : parsed.rows.length;
    const recoverFrom = firstBadIndex >= 0 ? parsed.spans[firstBadIndex]![0] : parsed.tailStart;
    const recovered = parseCsvText(csv.slice(recoverFrom), true);
    const recoveredRows = [...recovered.rows];
    pushCsvTail(recoveredRows, recovered.tail);
    // Tolerant mode is a heuristic; a recovered row that still does not fit
    // the header fails the file (same rule as the streaming reader).
    const badRecovered = recoveredRows.find((cells) => cells.length !== expectedCellCount && !isBlankCsvRow(cells));
    if (badRecovered) {
      throw new Error(csvRowWidthError(badRecovered.length, expectedCellCount ?? 0));
    }
    rows = [...parsed.rows.slice(0, keep), ...recoveredRows];
  }

  return rows.filter((cells) => !isBlankCsvRow(cells));
}

function csvRowWidthError(actual: number, expected: number): string {
  return `Oklahoma Guardian contribution CSV row has ${actual} cells, expected ${expected}`;
}

function normalizeCsvHeader(value: string): string {
  return value.replace(/^\uFEFF/, "").trim();
}

function buildHeaderIndex(header: readonly string[]): Map<string, number> {
  return new Map(header.map((name, index) => [normalizeCsvHeader(name), index]));
}

function requireContributionColumn(headerIndex: ReadonlyMap<string, number>, column: string): number {
  const index = headerIndex.get(column);
  if (index === undefined) {
    throw new Error(`Missing required Oklahoma Guardian contribution CSV column: ${column}`);
  }
  return index;
}

function cell(cells: readonly string[], index: number): string {
  return cells[index]?.trim() ?? "";
}

function rowObjectFromCells(
  cells: readonly string[],
  indexes: Record<(typeof OKLAHOMA_GUARDIAN_CONTRIBUTION_COLUMNS)[number], number>
): OklahomaGuardianContributionRow {
  return Object.fromEntries(
    OKLAHOMA_GUARDIAN_CONTRIBUTION_COLUMNS.map((column) => [column, cell(cells, indexes[column])])
  ) as OklahomaGuardianContributionRow;
}

export function parseOklahomaGuardianContributionCsv(csv: string): OklahomaGuardianContributionRow[] {
  const rows = parseCsvRows(csv);
  const header = rows[0];
  if (!header) {
    return [];
  }

  const headerIndex = buildHeaderIndex(header);
  const indexes = Object.fromEntries(
    OKLAHOMA_GUARDIAN_CONTRIBUTION_COLUMNS.map((column) => [
      column,
      requireContributionColumn(headerIndex, column),
    ])
  ) as Record<(typeof OKLAHOMA_GUARDIAN_CONTRIBUTION_COLUMNS)[number], number>;

  return rows.slice(1).map((cells) => rowObjectFromCells(cells, indexes));
}

async function streamOklahomaGuardianContributionRows(input: {
  zipPath: string;
  entry: InternalZipEntry;
  predicate?: OklahomaGuardianContributionRowPredicate;
  maxRows?: number;
}): Promise<OklahomaGuardianContributionRow[]> {
  if (input.entry.encrypted) {
    throw new Error(`Encrypted Oklahoma Guardian ZIP entries are not supported: ${input.entry.fileName}`);
  }
  if (input.entry.compressionMethodCode !== 0 && input.entry.compressionMethodCode !== 8) {
    throw new Error(
      `Unsupported Oklahoma Guardian ZIP compression method ${input.entry.compressionMethodCode} for ${input.entry.fileName}`
    );
  }
  if (input.entry.compressedSize === 0) {
    return [];
  }

  const dataOffset = await readEntryDataOffset(input.zipPath, input.entry);
  const source = createReadStream(input.zipPath, {
    start: dataOffset,
    end: dataOffset + input.entry.compressedSize - 1,
  });
  const stream = input.entry.compressionMethodCode === 8 ? source.pipe(createInflateRaw()) : source;
  const decoder = new StringDecoder("utf8");

  return await new Promise((resolve, reject) => {
    const rows: OklahomaGuardianContributionRow[] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;
    let pendingQuoteInQuotedField = false;
    // Raw text of the row being assembled, kept so a row the standard parse
    // cannot split (see parseCsvText) can be re-parsed in tolerant mode;
    // from that row on the stream stays in tolerant mode.
    let rawRow = "";
    let tolerant = false;
    let headerCellCount: number | null = null;
    let headerIndexes: Record<(typeof OKLAHOMA_GUARDIAN_CONTRIBUTION_COLUMNS)[number], number> | null = null;
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
      if (!headerIndexes) {
        const headerIndex = buildHeaderIndex(cells);
        headerCellCount = cells.length;
        headerIndexes = Object.fromEntries(
          OKLAHOMA_GUARDIAN_CONTRIBUTION_COLUMNS.map((column) => [
            column,
            requireContributionColumn(headerIndex, column),
          ])
        ) as Record<(typeof OKLAHOMA_GUARDIAN_CONTRIBUTION_COLUMNS)[number], number>;
        return;
      }
      if (input.maxRows !== undefined && rows.length >= input.maxRows) {
        return;
      }

      const parsedRow = rowObjectFromCells(cells, headerIndexes);
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

    // Rows produced by tolerant recovery must still fit the header.
    const consumeRecoveredRow = (cells: string[]): void => {
      if (headerCellCount !== null && cells.length !== headerCellCount && !isBlankCsvRow(cells)) {
        throw new Error(csvRowWidthError(cells.length, headerCellCount));
      }
      consumeCompletedRow(cells);
    };

    const finishCurrentRow = (): void => {
      row.push(field);
      const cells = row;
      const raw = rawRow;
      row = [];
      field = "";
      rawRow = "";
      if (headerCellCount !== null && cells.length !== headerCellCount && !isBlankCsvRow(cells)) {
        if (tolerant) {
          throw new Error(csvRowWidthError(cells.length, headerCellCount));
        }
        // Re-parse this row in tolerant mode and continue the stream from
        // wherever that reading leaves off (it may end mid-field).
        tolerant = true;
        const recovered = parseCsvText(raw, true);
        for (const recoveredCells of recovered.rows) {
          consumeRecoveredRow(recoveredCells);
        }
        row = recovered.tail.row;
        field = recovered.tail.field;
        inQuotes = recovered.tail.inQuotes;
        return;
      }
      consumeCompletedRow(cells);
    };

    const processText = (text: string, isFinal = false): void => {
      let index = 0;
      if (pendingQuoteInQuotedField) {
        pendingQuoteInQuotedField = false;
        if (text[0] === '"') {
          field += '"';
          rawRow += '"';
          index = 1;
          if (tolerant && tolerantDoubledQuoteCloses(text[1], text[2], isFinal)) {
            inQuotes = false;
          }
        } else if (!tolerant || isFieldTerminator(text[0])) {
          inQuotes = false;
        } else {
          field += '"';
        }
      }

      for (; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];
        rawRow += char;

        if (inQuotes) {
          if (char === '"' && next === '"') {
            field += '"';
            rawRow += '"';
            index += 1;
            if (tolerant && tolerantDoubledQuoteCloses(text[index + 1], text[index + 2], isFinal)) {
              inQuotes = false;
            }
          } else if (char === '"' && next === undefined && !isFinal) {
            pendingQuoteInQuotedField = true;
          } else if (char === '"' && (!tolerant || isFieldTerminator(next))) {
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
      if (settled) {
        return;
      }
      try {
        processText(decoder.write(chunk));
      } catch (error) {
        rejectOnce(error instanceof Error ? error : new Error(String(error)));
        stream.destroy();
      }
    });

    stream.on("end", () => {
      if (settled) {
        return;
      }
      try {
        processText(decoder.end(), true);
        if (inQuotes) {
          // The parse ran off the end inside a quote: recover the open row in
          // tolerant mode, or fail the file if that mode is already on.
          if (tolerant) {
            throw new Error(UNTERMINATED_QUOTE_ERROR);
          }
          tolerant = true;
          const recovered = parseCsvText(rawRow, true);
          rawRow = "";
          for (const recoveredCells of recovered.rows) {
            consumeRecoveredRow(recoveredCells);
          }
          if (recovered.tail.inQuotes) {
            throw new Error(UNTERMINATED_QUOTE_ERROR);
          }
          row = recovered.tail.row;
          field = recovered.tail.field;
          inQuotes = false;
          if (field.length > 0 || row.length > 0) {
            finishCurrentRow();
          }
        } else if (field.length > 0 || row.length > 0) {
          finishCurrentRow();
        }
        resolveOnce();
      } catch (error) {
        rejectOnce(error instanceof Error ? error : new Error(String(error)));
      }
    });

    stream.on("error", (error: Error) => {
      if (!settled) {
        rejectOnce(error);
      }
    });
  });
}

export async function readOklahomaGuardianContributionRows(input: {
  zipPath: string;
  year: number;
  predicate?: OklahomaGuardianContributionRowPredicate;
  maxRows?: number;
}): Promise<OklahomaGuardianContributionRow[]> {
  const year = normalizeOklahomaGuardianContributionYear(input.year);
  const maxRows = normalizePositiveInteger(input.maxRows, "maxRows");
  const fileName = oklahomaGuardianContributionCsvFileName(year);
  const entries = await readZipEntries(input.zipPath);
  const entry = entries.find((candidate) => candidate.fileName === fileName);
  if (!entry || entry.isDirectory) {
    throw new Error(`Oklahoma Guardian contribution CSV not found in ZIP: ${fileName}`);
  }

  return await streamOklahomaGuardianContributionRows({
    zipPath: input.zipPath,
    entry,
    predicate: input.predicate,
    maxRows,
  });
}
