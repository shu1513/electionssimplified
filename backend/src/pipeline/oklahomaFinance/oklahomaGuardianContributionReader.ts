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

// A closing quote is only a closing quote when the field actually ends there.
function isQuotedFieldTerminator(next: string | undefined): boolean {
  return next === undefined || next === "," || next === "\n" || next === "\r";
}

function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const next = csv[index + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        // `""` is an escaped quote, except when the field ends right after it:
        // Guardian writes nicknames as `"COLATA "JODY""` without doubling the
        // inner quotes, so `""` + terminator is one literal quote + the close.
        field += '"';
        index += 1;
        if (isQuotedFieldTerminator(csv[index + 1])) {
          inQuotes = false;
        }
      } else if (char === '"' && isQuotedFieldTerminator(next)) {
        inQuotes = false;
      } else {
        // A quote that does not end the field is literal (same nickname case).
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
      row = [];
      field = "";
      continue;
    }

    if (char === "\r") {
      continue;
    }

    field += char;
  }

  if (inQuotes) {
    throw new Error("Oklahoma Guardian contribution CSV has an unterminated quoted field");
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((cells) => cells.some((cell) => cell.trim().length > 0));
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
    // A `""` pair ended the chunk; whether it also closed the field depends
    // on the next chunk's first character.
    let pendingDoubledQuote = false;
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
          if (text[1] === undefined && !isFinal) {
            pendingDoubledQuote = true;
          } else if (isQuotedFieldTerminator(text[1])) {
            inQuotes = false;
          }
        } else if (isQuotedFieldTerminator(text[0])) {
          inQuotes = false;
        } else {
          field += '"';
        }
      } else if (pendingDoubledQuote) {
        pendingDoubledQuote = false;
        if (isQuotedFieldTerminator(text[0])) {
          inQuotes = false;
        }
      }

      for (; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];

        if (inQuotes) {
          if (char === '"' && next === '"') {
            // Same `""` rule as parseCsvRows: escaped quote unless the field
            // ends right after it (Guardian's undoubled nickname quotes).
            const after = text[index + 2];
            field += '"';
            index += 1;
            if (after === undefined && !isFinal) {
              pendingDoubledQuote = true;
            } else if (isQuotedFieldTerminator(after)) {
              inQuotes = false;
            }
          } else if (char === '"' && next === undefined && !isFinal) {
            pendingQuoteInQuotedField = true;
          } else if (char === '"' && isQuotedFieldTerminator(next)) {
            inQuotes = false;
          } else {
            // A quote that does not end the field is literal.
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

      if (isFinal && (pendingQuoteInQuotedField || pendingDoubledQuote)) {
        pendingQuoteInQuotedField = false;
        pendingDoubledQuote = false;
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
          throw new Error("Oklahoma Guardian contribution CSV has an unterminated quoted field");
        }
        if (field.length > 0 || row.length > 0) {
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
