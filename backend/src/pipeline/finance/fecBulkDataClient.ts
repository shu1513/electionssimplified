import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";

// Downloads and reads the FEC bulk data ZIP files
// (https://www.fec.gov/data/browse-data/?tab=bulk-data). The files are free,
// need no API key and have no request quota. The largest one (individual
// contributions) is over 2 GB, so files go to disk and are read as a stream.

export const FEC_BULK_DOWNLOAD_BASE_URL = "https://www.fec.gov/files/bulk-downloads";
export const DEFAULT_FEC_BULK_DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1000;

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const DEFLATE_COMPRESSION_METHOD = 8;
// fec.gov answers requests without a browser-style user agent with 403.
const FEC_BULK_USER_AGENT = "Mozilla/5.0 (compatible; VoteApp finance sync)";

export type FecBulkFileKind = "committee_master" | "candidate_committee_linkage" | "committee_contributions" | "individual_contributions";

type FecBulkFileSpec = {
  zipPrefix: string;
  entryName: string;
};

const FEC_BULK_FILES: Record<FecBulkFileKind, FecBulkFileSpec> = {
  committee_master: { zipPrefix: "cm", entryName: "cm.txt" },
  candidate_committee_linkage: { zipPrefix: "ccl", entryName: "ccl.txt" },
  committee_contributions: { zipPrefix: "pas2", entryName: "itpas2.txt" },
  individual_contributions: { zipPrefix: "indiv", entryName: "itcont.txt" },
};

/** FEC cycles are named for their even, ending year. */
export function fecCycleForElectionYear(electionYear: number): number {
  if (!Number.isInteger(electionYear) || electionYear < 1980 || electionYear > 2100) {
    throw new Error(`Invalid election year for FEC bulk data: ${electionYear}`);
  }
  return electionYear % 2 === 0 ? electionYear : electionYear + 1;
}

export function fecBulkZipFileName(kind: FecBulkFileKind, cycle: number): string {
  return `${FEC_BULK_FILES[kind].zipPrefix}${String(cycle % 100).padStart(2, "0")}.zip`;
}

export function fecBulkFileUrl(kind: FecBulkFileKind, cycle: number): string {
  return `${FEC_BULK_DOWNLOAD_BASE_URL}/${cycle}/${fecBulkZipFileName(kind, cycle)}`;
}

/**
 * Downloads one bulk ZIP into `directory` and returns its path. A file that
 * is already there is reused, so a caller that keeps the directory can run
 * several syncs from one download.
 */
export async function downloadFecBulkFile(input: {
  kind: FecBulkFileKind;
  cycle: number;
  directory: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}): Promise<string> {
  await mkdir(input.directory, { recursive: true });
  const zipPath = join(input.directory, fecBulkZipFileName(input.kind, input.cycle));
  const existing = await stat(zipPath).catch(() => null);
  if (existing && existing.size > 0) {
    return zipPath;
  }

  const url = fecBulkFileUrl(input.kind, input.cycle);
  const response = await (input.fetchFn ?? fetch)(url, {
    headers: { "User-Agent": FEC_BULK_USER_AGENT },
    signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_FEC_BULK_DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    throw new Error(`FEC bulk download failed for ${url}: HTTP ${response.status}`);
  }

  // Write to a temporary name first so an interrupted download is never
  // mistaken for a complete file on the next run.
  const partialPath = `${zipPath}.partial`;
  try {
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(partialPath));
    await rename(partialPath, zipPath);
  } catch (error) {
    await rm(partialPath, { force: true });
    throw error;
  }
  return zipPath;
}

async function readFirstEntryDataOffset(zipPath: string, expectedEntryName: string): Promise<number> {
  const handle = await open(zipPath, "r");
  try {
    const header = Buffer.alloc(30);
    await handle.read(header, 0, 30, 0);
    if (header.readUInt32LE(0) !== LOCAL_FILE_HEADER_SIGNATURE) {
      throw new Error(`Not a ZIP file: ${zipPath}`);
    }
    if (header.readUInt16LE(8) !== DEFLATE_COMPRESSION_METHOD) {
      throw new Error(`Unsupported ZIP compression method in ${zipPath}`);
    }
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    const name = Buffer.alloc(nameLength);
    await handle.read(name, 0, nameLength, 30);
    if (name.toString("utf8") !== expectedEntryName) {
      throw new Error(`Expected ${expectedEntryName} as the first entry of ${zipPath}, found ${name.toString("utf8")}`);
    }
    return 30 + nameLength + extraLength;
  } finally {
    await handle.close();
  }
}

/**
 * Streams the lines of a bulk ZIP's data file. Every FEC bulk ZIP puts the
 * full data file first (the individual-contributions ZIP then repeats the
 * same rows split by date, which must not be read again). The inflater stops
 * at the end of the first entry, so the rest of the archive is ignored.
 */
export async function readFecBulkFileLines(input: {
  kind: FecBulkFileKind;
  zipPath: string;
  onLine: (line: string) => void;
}): Promise<number> {
  const dataOffset = await readFirstEntryDataOffset(input.zipPath, FEC_BULK_FILES[input.kind].entryName);
  const source = createReadStream(input.zipPath, { start: dataOffset });
  const inflater = createInflateRaw();
  inflater.once("end", () => source.destroy());
  source.on("error", (error) => inflater.destroy(error));
  source.pipe(inflater);

  let lineCount = 0;
  const lines = createInterface({ input: inflater.setEncoding("latin1"), crlfDelay: Infinity });
  // Whether readline passes an input-stream error on to this loop depends on
  // the Node version. Catch it here so a corrupt or truncated archive always
  // fails the read and can never pass for a short but complete file.
  let streamError: Error | null = null;
  inflater.on("error", (error: Error) => {
    streamError = error;
    lines.close();
  });
  for await (const line of lines) {
    if (line.length === 0) {
      continue;
    }
    lineCount += 1;
    input.onLine(line);
  }
  if (streamError) {
    throw streamError;
  }
  return lineCount;
}
