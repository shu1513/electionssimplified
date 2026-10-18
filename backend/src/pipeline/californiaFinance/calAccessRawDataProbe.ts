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
const DEFAULT_MAX_ROWS_PER_FILE = 5;
const DEFAULT_MAX_FILES = 20;
const DEFAULT_MAX_BYTES_PER_FILE = 2_000_000;

export type CalAccessZipCompressionMethod = "stored" | "deflated" | `unsupported_${number}`;

export type CalAccessRawDataZipEntry = {
  fileName: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: CalAccessZipCompressionMethod;
  isDirectory: boolean;
};

type InternalZipEntry = CalAccessRawDataZipEntry & {
  compressionMethodCode: number;
  localHeaderOffset: number;
  encrypted: boolean;
};

export type CalAccessRawDataFileSample = {
  fileName: string;
  delimiter: "tab";
  encoding: "utf8";
  headers: string[];
  rows: string[][];
  rowObjects: Record<string, string>[];
  truncated: boolean;
};
export type CalAccessRawDataRow = Record<string, string>;

export type CalAccessRawDataProbeInput = {
  zipPath: string;
  selectedFileNames?: readonly string[];
  selectedFileNamePatterns?: readonly RegExp[];
  maxRowsPerFile?: number;
  maxFiles?: number;
  maxBytesPerFile?: number;
};

export type CalAccessRawDataProbeResult = {
  zipPath: string;
  entries: CalAccessRawDataZipEntry[];
  samples: CalAccessRawDataFileSample[];
  missingFileNames: string[];
};

function normalizePositiveInteger(value: number | undefined, fallback: number, fieldName: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid CAL-ACCESS raw data probe ${fieldName}: ${value}`);
  }
  return normalized;
}

function compressionMethodName(method: number): CalAccessZipCompressionMethod {
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
    throw new Error(`CAL-ACCESS ZIP64 ${fieldName} is too large for the lightweight probe`);
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
          throw new Error(`CAL-ACCESS ZIP64 ${fieldName} is missing for ${input.fileName}`);
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
    throw new Error(`ZIP64 CAL-ACCESS entry is missing extended information: ${input.fileName}`);
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
      throw new Error(`Unable to read CAL-ACCESS ZIP range at ${position}`);
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
  throw new Error("CAL-ACCESS ZIP end-of-central-directory record not found");
}

async function readCentralDirectory(path: string): Promise<Buffer> {
  const fileStat = await stat(path);
  if (!fileStat.isFile()) {
    throw new Error(`CAL-ACCESS raw data ZIP path is not a file: ${path}`);
  }
  if (fileStat.size < EOCD_MIN_LENGTH) {
    throw new Error(`CAL-ACCESS raw data ZIP is too small: ${path}`);
  }

  const tailLength = Math.min(fileStat.size, EOCD_MIN_LENGTH + EOCD_MAX_COMMENT_LENGTH);
  const tail = await readFileRange(path, fileStat.size - tailLength, tailLength);
  const eocdOffset = findEndOfCentralDirectory(tail);

  const diskNumber = tail.readUInt16LE(eocdOffset + 4);
  const centralDirectoryDisk = tail.readUInt16LE(eocdOffset + 6);
  if (diskNumber !== 0 || centralDirectoryDisk !== 0) {
    throw new Error("Multi-disk CAL-ACCESS ZIP archives are not supported");
  }

  const centralDirectorySize = tail.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = tail.readUInt32LE(eocdOffset + 16);
  if (centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
    throw new Error("ZIP64 CAL-ACCESS archives are not supported by the lightweight probe");
  }
  if (centralDirectoryOffset + centralDirectorySize > fileStat.size) {
    throw new Error("CAL-ACCESS ZIP central directory points outside the archive");
  }

  return await readFileRange(path, centralDirectoryOffset, centralDirectorySize);
}

function parseCentralDirectory(buffer: Buffer): InternalZipEntry[] {
  const entries: InternalZipEntry[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error(`Invalid CAL-ACCESS ZIP central directory entry at offset ${offset}`);
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

export async function listCalAccessRawDataZipEntries(zipPath: string): Promise<CalAccessRawDataZipEntry[]> {
  return (await readZipEntries(zipPath)).map(({ compressionMethodCode, localHeaderOffset, encrypted, ...entry }) => entry);
}

/** Open one checked entry for callers that must consume the complete table. */
export async function openCalAccessRawDataTableStream(zipPath:string,fileName:string){
  const matches=(await readZipEntries(zipPath)).filter(e=>e.fileName===fileName),entry=matches[0];
  if(matches.length!==1||!entry||entry.isDirectory||entry.encrypted||![0,8].includes(entry.compressionMethodCode)||entry.compressedSize===0)
    throw new Error("Missing, ambiguous or unsupported CAL-ACCESS table");
  const start=await readEntryDataOffset(zipPath,entry),source=createReadStream(zipPath,{start,end:start+entry.compressedSize-1});
  const stream=entry.compressionMethodCode===8?source.pipe(createInflateRaw()):source;
  source.on("error",error=>stream.destroy(error));return {source,stream,entry};
}

async function readEntryDataOffset(zipPath: string, entry: InternalZipEntry): Promise<number> {
  const localHeader = await readFileRange(zipPath, entry.localHeaderOffset, 30);
  if (localHeader.readUInt32LE(0) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error(`Invalid CAL-ACCESS ZIP local header for ${entry.fileName}`);
  }
  const fileNameLength = localHeader.readUInt16LE(26);
  const extraFieldLength = localHeader.readUInt16LE(28);
  return entry.localHeaderOffset + 30 + fileNameLength + extraFieldLength;
}

function countLines(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  return value.split(/\n/).length - 1;
}

async function readEntryTextSample(input: {
  zipPath: string;
  entry: InternalZipEntry;
  maxRowsPerFile: number;
  maxBytesPerFile: number;
}): Promise<{ text: string; truncated: boolean }> {
  if (input.entry.encrypted) {
    throw new Error(`Encrypted CAL-ACCESS ZIP entries are not supported: ${input.entry.fileName}`);
  }
  if (input.entry.compressionMethodCode !== 0 && input.entry.compressionMethodCode !== 8) {
    throw new Error(
      `Unsupported CAL-ACCESS ZIP compression method ${input.entry.compressionMethodCode} for ${input.entry.fileName}`
    );
  }

  const dataOffset = await readEntryDataOffset(input.zipPath, input.entry);
  if (input.entry.compressedSize === 0) {
    return { text: "", truncated: false };
  }
  const source = createReadStream(input.zipPath, {
    start: dataOffset,
    end: dataOffset + input.entry.compressedSize - 1,
  });
  const stream = input.entry.compressionMethodCode === 8 ? source.pipe(createInflateRaw()) : source;
  const decoder = new StringDecoder("utf8");
  // Read one row beyond the requested sample so truncated=true means there is more data.
  const requiredLineBreaks = input.maxRowsPerFile + 2;

  return await new Promise((resolve, reject) => {
    let text = "";
    let byteCount = 0;
    let settled = false;

    const finish = (truncated: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      source.destroy();
      if (stream !== source) {
        stream.destroy();
      }
      resolve({ text: text + decoder.end(), truncated });
    };

    stream.on("data", (chunk: Buffer) => {
      byteCount += chunk.length;
      text += decoder.write(chunk);
      if (countLines(text) >= requiredLineBreaks) {
        finish(true);
        return;
      }
      if (byteCount > input.maxBytesPerFile) {
        finish(true);
      }
    });
    stream.on("end", () => finish(false));
    stream.on("error", (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function parseTabDelimitedSample(input: {
  fileName: string;
  text: string;
  maxRowsPerFile: number;
  truncated: boolean;
}): CalAccessRawDataFileSample {
  const normalized = input.text.replace(/^\uFEFF/, "");
  if (normalized.length === 0) {
    return {
      fileName: input.fileName,
      delimiter: "tab",
      encoding: "utf8",
      headers: [],
      rows: [],
      rowObjects: [],
      truncated: input.truncated,
    };
  }
  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, ""))
    .filter((line, index, allLines) => line.length > 0 || index < allLines.length - 1);
  const headers = (lines[0] ?? "").split("\t").map((header) => header.trim());
  const rows = lines
    .slice(1, input.maxRowsPerFile + 1)
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t"));
  const rowObjects = rows.map((row) =>
    Object.fromEntries(headers.map((header, index) => [header || `column_${index + 1}`, row[index] ?? ""]))
  );

  return {
    fileName: input.fileName,
    delimiter: "tab",
    encoding: "utf8",
    headers,
    rows,
    rowObjects,
    truncated: input.truncated || lines.length > input.maxRowsPerFile + 1,
  };
}

function rowObjectFromValues(headers: readonly string[], row: readonly string[]): CalAccessRawDataRow {
  return Object.fromEntries(headers.map((header, index) => [header || `column_${index + 1}`, row[index] ?? ""]));
}

export async function readCalAccessRawDataTableRows(input: {
  zipPath: string;
  fileName: string;
  predicate?: (row: CalAccessRawDataRow) => boolean;
  maxRows?: number;
}): Promise<CalAccessRawDataRow[]> {
  const maxRows = input.maxRows;
  if (maxRows !== undefined && (!Number.isInteger(maxRows) || maxRows <= 0)) {
    throw new Error(`Invalid CAL-ACCESS raw data maxRows: ${maxRows}`);
  }

  const entries = await readZipEntries(input.zipPath);
  const entry = entries.find((candidate) => candidate.fileName === input.fileName);
  if (!entry || entry.isDirectory) {
    throw new Error(`CAL-ACCESS raw data table not found in ZIP: ${input.fileName}`);
  }
  if (entry.encrypted) {
    throw new Error(`Encrypted CAL-ACCESS ZIP entries are not supported: ${entry.fileName}`);
  }
  if (entry.compressionMethodCode !== 0 && entry.compressionMethodCode !== 8) {
    throw new Error(
      `Unsupported CAL-ACCESS ZIP compression method ${entry.compressionMethodCode} for ${entry.fileName}`
    );
  }
  if (entry.compressedSize === 0) {
    return [];
  }

  const dataOffset = await readEntryDataOffset(input.zipPath, entry);
  const source = createReadStream(input.zipPath, {
    start: dataOffset,
    end: dataOffset + entry.compressedSize - 1,
  });
  const stream = entry.compressionMethodCode === 8 ? source.pipe(createInflateRaw()) : source;
  const decoder = new StringDecoder("utf8");

  return await new Promise((resolve, reject) => {
    const rows: CalAccessRawDataRow[] = [];
    let buffer = "";
    let headers: string[] | null = null;
    let settled = false;

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      source.destroy();
      if (stream !== source) {
        stream.destroy();
      }
      resolve(rows);
    };

    const processLine = (rawLine: string): void => {
      const line = rawLine.replace(/\r$/, "");
      if (headers === null) {
        headers = line.replace(/^\uFEFF/, "").split("\t").map((header) => header.trim());
        return;
      }
      if (line.length === 0) {
        return;
      }
      const row = rowObjectFromValues(headers, line.split("\t"));
      if (!input.predicate || input.predicate(row)) {
        rows.push(row);
        if (maxRows !== undefined && rows.length >= maxRows) {
          finish();
        }
      }
    };

    const processBuffer = (final: boolean): void => {
      const lines = buffer.split(/\n/);
      buffer = final ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        if (settled) {
          return;
        }
        processLine(line);
      }
      if (final && buffer.length > 0 && !settled) {
        processLine(buffer);
      }
    };

    stream.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      buffer += decoder.write(chunk);
      processBuffer(false);
    });
    stream.on("end", () => {
      if (settled) {
        return;
      }
      buffer += decoder.end();
      processBuffer(true);
      finish();
    });
    stream.on("error", (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function selectEntries(input: {
  entries: InternalZipEntry[];
  selectedFileNames: readonly string[];
  selectedFileNamePatterns: readonly RegExp[];
  maxFiles: number;
}): { selected: InternalZipEntry[]; missingFileNames: string[] } {
  const byName = new Map(input.entries.map((entry) => [entry.fileName, entry]));
  const selected = new Map<string, InternalZipEntry>();
  const missingFileNames: string[] = [];

  for (const fileName of input.selectedFileNames) {
    const entry = byName.get(fileName);
    if (!entry || entry.isDirectory) {
      missingFileNames.push(fileName);
      continue;
    }
    selected.set(entry.fileName, entry);
  }

  for (const pattern of input.selectedFileNamePatterns) {
    for (const entry of input.entries) {
      pattern.lastIndex = 0;
      if (!entry.isDirectory && pattern.test(entry.fileName)) {
        selected.set(entry.fileName, entry);
      }
    }
  }

  return { selected: [...selected.values()].slice(0, input.maxFiles), missingFileNames };
}

export async function probeCalAccessRawDataZip(
  input: CalAccessRawDataProbeInput
): Promise<CalAccessRawDataProbeResult> {
  const maxRowsPerFile = normalizePositiveInteger(
    input.maxRowsPerFile,
    DEFAULT_MAX_ROWS_PER_FILE,
    "maxRowsPerFile"
  );
  const maxFiles = normalizePositiveInteger(input.maxFiles, DEFAULT_MAX_FILES, "maxFiles");
  const maxBytesPerFile = normalizePositiveInteger(
    input.maxBytesPerFile,
    DEFAULT_MAX_BYTES_PER_FILE,
    "maxBytesPerFile"
  );
  const internalEntries = await readZipEntries(input.zipPath);
  const entries = internalEntries.map(({ compressionMethodCode, localHeaderOffset, encrypted, ...entry }) => entry);
  const { selected, missingFileNames } = selectEntries({
    entries: internalEntries,
    selectedFileNames: input.selectedFileNames ?? [],
    selectedFileNamePatterns: input.selectedFileNamePatterns ?? [],
    maxFiles,
  });

  const samples: CalAccessRawDataFileSample[] = [];
  for (const entry of selected) {
    const textSample = await readEntryTextSample({
      zipPath: input.zipPath,
      entry,
      maxRowsPerFile,
      maxBytesPerFile,
    });
    samples.push(
      parseTabDelimitedSample({
        fileName: entry.fileName,
        text: textSample.text,
        maxRowsPerFile,
        truncated: textSample.truncated,
      })
    );
  }

  return {
    zipPath: input.zipPath,
    entries,
    samples,
    missingFileNames,
  };
}
