import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import { unzipSync } from "fflate";
import { Pool } from "pg";

import { fetchCensusJsonWithKeyRotation } from "../config/censusApi.js";
import { getPipelineEnv } from "../config/env.js";
import { STATE_FIPS_BY_ABBREVIATION } from "../constants/usStates.js";

// Load of the ZCTA -> state legislative district crosswalk into
// address_zcta_legislative (docs/plans/partial-address-scope.md). Like the
// place crosswalk this stores a DECISION: a ZCTA gets a lower-chamber
// (upper-chamber) district only when EVERY resident of the ZCTA lives in
// that one district, so the ZIP partial-ballot path can offer the district's
// races without guessing.
//
// Why residents and not land: ZCTAs are built from census blocks, and rural
// ZCTAs routinely include uninhabited blocks (wilderness, water) that fall in
// a neighbouring district — ZCTA 99826 (Gustavus, AK) has 19% of its land in
// House District 2 and 100% of its residents in House District 3. Land-share
// containment would leave such ZIPs with no legislative race for no good
// reason; population containment is exact for the people who actually vote.
//
// Sources, all 2020 Census blocks:
// - ZCTA <-> block relationship file (which blocks make up each ZCTA);
// - 2024 state legislative block equivalency files (which district each
//   block belongs to, whole-block, as tabulated by the Census Bureau);
// - 2020 Census P1_001N total population per block (Census Data API).
//
// Rule (per ZCTA, per chamber; the chambers are decided independently):
// - the ZCTA has at least one resident;
// - every block with residents maps to the same district — a block with
//   residents and no district (a state without that chamber, a "ZZZ"
//   unassigned code, or a block the equivalency file lacks) disqualifies;
// - no block with residents is one the state's plan SPLITS between
//   districts (the Bureau allocates such a block whole to one district for
//   tabulation; the real line runs through it, so residents on the far side
//   would get the wrong race — SPLIT_BLOCK_GEOIDS lists them from the
//   Bureau's block-split PDFs).
//
// Usage:
//   npm run import:zcta-legislative-crosswalk -- --data-dir /path/to/cache
//
// --data-dir keeps the downloads (the relationship file alone is ~1 GB) so a
// second run — the same load against another database — reads them from
// disk instead of fetching again. Re-run after any state redraws its
// legislative districts, with the matching equivalency files.

export const ZCTA_BLOCK_RELATIONSHIP_URL =
  "https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_tabblock20_natl.txt";

// 2024 State Legislative District Block Equivalency Files; the "National"
// member of each zip covers every state that has the chamber.
// https://www.census.gov/geographies/mapping-files/2025/dec/rdo/2024-state-legislative-bef.html
export const SLDL_BLOCK_EQUIVALENCY_ZIP_URL =
  "https://www2.census.gov/programs-surveys/decennial/rdo/mapping-files/2025/2024-state-legislative-bef/sldl24.zip";
export const SLDU_BLOCK_EQUIVALENCY_ZIP_URL =
  "https://www2.census.gov/programs-surveys/decennial/rdo/mapping-files/2025/2024-state-legislative-bef/sldu24.zip";
const SLDL_NATIONAL_MEMBER = "NationalSLDL24.txt";
const SLDU_NATIONAL_MEMBER = "NationalSLDU24.txt";

// 2020 Decennial Census Redistricting Data (P.L. 94-171): total population
// of every block in one state. The geography must be written exactly like
// this — `in=state:XX&in=county:*` is rejected as an unsupported hierarchy.
function blockPopulationUrl(stateFips: string): string {
  return `https://api.census.gov/data/2020/dec/pl?get=P1_001N&for=block:*&in=state:${stateFips}%20county:*`;
}

const DOWNLOAD_TIMEOUT_MS = 20 * 60_000;

// Blocks the 2024 plans split between two districts, from the Bureau's lists
// (2024_SLDL_BlockSplits.pdf, 2024_SLDU_BlockSplits.pdf next to the
// equivalency files: Colorado, Minnesota, North Dakota, Pennsylvania and
// Washington lower; Colorado, Delaware, Minnesota, North Dakota and
// Washington upper). Union of both chambers — a resident of any of these
// blocks may be on either side of a line, so neither chamber is decided for
// a ZCTA that contains one.
export const SPLIT_BLOCK_GEOIDS: readonly string[] = [
  "080010090012030", "080010094072006", "080010094073008", "080010094073010",
  "080010096072000", "080299650021004", "080299650021013", "080350139142006",
  "080350139142018", "080350140133016", "080410038021048", "080410038021050",
  "080410045172021", "080410046033051", "080410067011010", "080410067011020",
  "080459519024035", "080770011024010", "080770011024014", "080770012001028",
  "080770013023019", "080770013023037", "080770013032004", "080770013032005",
  "080770013032012", "080770014023000", "080770019001044", "080770019001049",
  "080770019003049", "080770019003051", "081230007031028", "081230007052044",
  "081230019141072", "081230021051054", "100030147051002", "270131713002003",
  "270131713002009", "270530261032000", "380150106003011", "380150106003034",
  "380150111051021", "380150111051027", "380150111051034", "380170405093011",
  "380350108061005", "380350109001000", "380350109001001", "380590203021025",
  "380590203021050", "380590204001095", "380590204001096", "380590204001139",
  "380590204001142", "380899633002002", "381059535001524", "381059537012044",
  "421010257002008", "530770018011075", "530770018012077", "530770018013012",
  "530770020042004", "530770020042005",
];

// The relationship file's columns the import reads, validated against the
// header so a layout change fails loudly instead of loading wrong columns.
const RELATIONSHIP_COLUMNS = ["GEOID_ZCTA5_20", "GEOID_TABBLOCK_20"] as const;

const FIVE_DIGITS = /^[0-9]{5}$/;
const FIFTEEN_DIGITS = /^[0-9]{15}$/;
// State FIPS + the 3-character district code (digits, letters, "-" for
// Vermont's "A-1" style codes) — the same shape as districts.geoid_compact.
const LEGISLATIVE_GEOID = /^[0-9]{2}[0-9A-Z-]{3}$/;
// The equivalency files mark blocks outside every district (water) with ZZZ.
const UNASSIGNED_DISTRICT_CODE = "ZZZ";

// Verified against the 2026-10-08 build: 33,791 ZCTAs, 24,132 rows — 18,228
// with a lower-chamber district and 22,949 with an upper-chamber one. The
// guard band refuses to replace existing data with an implausible result —
// a truncated download or a changed layout must fail loudly, not load
// quietly.
const MIN_PLAUSIBLE_ROWS = 15_000;
const MAX_PLAUSIBLE_ROWS = 35_000;

export type ZctaLegislativeRow = {
  zcta5: string;
  state_lower_geoid: string | null;
  state_upper_geoid: string | null;
};

// ---------------------------------------------------------------------------
// Block lookups. 8.2 million blocks nationally: parallel typed arrays sorted
// by block GEOID (a 15-digit integer fits a double exactly) and binary
// search keep this at a few hundred MB instead of a Map per source.
// ---------------------------------------------------------------------------

export class BlockLookup {
  private readonly geoids: Float64Array;
  private readonly values: Uint32Array;

  constructor(geoids: Float64Array, values: Uint32Array) {
    if (geoids.length !== values.length) {
      throw new Error("block lookup arrays differ in length");
    }
    const order = new Uint32Array(geoids.length);
    for (let index = 0; index < order.length; index += 1) {
      order[index] = index;
    }
    order.sort((a, b) => geoids[a] - geoids[b]);
    this.geoids = new Float64Array(geoids.length);
    this.values = new Uint32Array(values.length);
    for (let index = 0; index < order.length; index += 1) {
      this.geoids[index] = geoids[order[index]];
      this.values[index] = values[order[index]];
      if (index > 0 && this.geoids[index] === this.geoids[index - 1]) {
        throw new Error(`block ${formatBlockGeoid(this.geoids[index])} appears twice`);
      }
    }
  }

  get size(): number {
    return this.geoids.length;
  }

  /** The stored value for a block, or undefined when the block is absent. */
  get(blockGeoid: number): number | undefined {
    let low = 0;
    let high = this.geoids.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const candidate = this.geoids[middle];
      if (candidate === blockGeoid) {
        return this.values[middle];
      }
      if (candidate < blockGeoid) {
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return undefined;
  }
}

function formatBlockGeoid(geoid: number): string {
  return String(geoid).padStart(15, "0");
}

export function parseBlockGeoid(text: string, context: string): number {
  if (!FIFTEEN_DIGITS.test(text)) {
    throw new Error(`${context}: invalid block GEOID "${text}"`);
  }
  return Number(text);
}

export type BlockDistricts = {
  lookup: BlockLookup;
  /** District GEOID (state FIPS + code) per lookup value; null = unassigned. */
  geoids: (string | null)[];
};

/**
 * Parses one national block equivalency file ("GEOID,SLDLST" or
 * "GEOID,SLDUST" header, one block per line) into a block -> district lookup.
 * The district GEOID is the block's state FIPS plus the file's code, which
 * is how districts.geoid_compact spells the same district.
 */
export function parseBlockEquivalencyFile(text: string): BlockDistricts {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = withoutBom.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new Error("block equivalency file is empty");
  }
  const header = lines[0].split(",");
  if (header.length !== 2 || header[0] !== "GEOID" || !/^SLD[LU]ST$/.test(header[1])) {
    throw new Error(`block equivalency file header is not GEOID,SLDLST or GEOID,SLDUST; got: ${lines[0]}`);
  }

  const geoids = new Float64Array(lines.length - 1);
  const values = new Uint32Array(lines.length - 1);
  const districtGeoids: (string | null)[] = [];
  const valueByDistrict = new Map<string, number>();
  for (let index = 1; index < lines.length; index += 1) {
    const fields = lines[index].split(",");
    if (fields.length !== 2) {
      throw new Error(`line ${index + 1}: expected 2 fields, got ${fields.length}`);
    }
    const blockGeoid = parseBlockGeoid(fields[0].trim(), `line ${index + 1}`);
    const code = fields[1].trim();
    const districtGeoid = code === UNASSIGNED_DISTRICT_CODE ? null : `${fields[0].slice(0, 2)}${code}`;
    if (districtGeoid !== null && !LEGISLATIVE_GEOID.test(districtGeoid)) {
      throw new Error(`line ${index + 1}: invalid district code "${code}"`);
    }
    const key = districtGeoid ?? "";
    let value = valueByDistrict.get(key);
    if (value === undefined) {
      value = districtGeoids.length;
      districtGeoids.push(districtGeoid);
      valueByDistrict.set(key, value);
    }
    geoids[index - 1] = blockGeoid;
    values[index - 1] = value;
  }
  return { lookup: new BlockLookup(geoids, values), geoids: districtGeoids };
}

export type BlockPopulationEntry = { blockGeoid: number; population: number };

/**
 * Parses one state's Census Data API response (a JSON array of rows, header
 * first: P1_001N, state, county, tract, block) into block populations.
 */
export function parseBlockPopulationResponse(payload: unknown, stateFips: string): BlockPopulationEntry[] {
  if (!Array.isArray(payload) || payload.length === 0 || !Array.isArray(payload[0])) {
    throw new Error(`state ${stateFips}: population response is not a JSON table`);
  }
  const header = payload[0] as unknown[];
  const column = (name: string): number => {
    const index = header.indexOf(name);
    if (index < 0) {
      throw new Error(`state ${stateFips}: population response lacks column ${name}; got: ${header.join(",")}`);
    }
    return index;
  };
  const populationIndex = column("P1_001N");
  const stateIndex = column("state");
  const countyIndex = column("county");
  const tractIndex = column("tract");
  const blockIndex = column("block");

  const entries: BlockPopulationEntry[] = [];
  for (let rowIndex = 1; rowIndex < payload.length; rowIndex += 1) {
    const row = payload[rowIndex] as unknown[];
    if (!Array.isArray(row) || row.length !== header.length) {
      throw new Error(`state ${stateFips}: population row ${rowIndex} is malformed`);
    }
    const geoidText = `${row[stateIndex]}${row[countyIndex]}${row[tractIndex]}${row[blockIndex]}`;
    const blockGeoid = parseBlockGeoid(geoidText, `state ${stateFips} row ${rowIndex}`);
    if (!geoidText.startsWith(stateFips)) {
      throw new Error(`state ${stateFips}: population row ${rowIndex} is for block ${geoidText}`);
    }
    const population = Number(row[populationIndex]);
    if (!Number.isInteger(population) || population < 0) {
      throw new Error(`state ${stateFips}: invalid population "${String(row[populationIndex])}" for block ${geoidText}`);
    }
    entries.push({ blockGeoid, population });
  }
  return entries;
}

export function buildPopulationLookup(entries: readonly BlockPopulationEntry[]): BlockLookup {
  const geoids = new Float64Array(entries.length);
  const values = new Uint32Array(entries.length);
  entries.forEach((entry, index) => {
    geoids[index] = entry.blockGeoid;
    values[index] = entry.population;
  });
  return new BlockLookup(geoids, values);
}

// ---------------------------------------------------------------------------
// The containment decision.
// ---------------------------------------------------------------------------

type ChamberTally = {
  /** Residents per district GEOID. */
  byDistrict: Map<string, number>;
  /** Residents of blocks with no district in this chamber. */
  unassigned: number;
};

type ZctaTally = {
  population: number;
  /** Residents of blocks a plan splits between districts. */
  splitBlockPopulation: number;
  lower: ChamberTally;
  upper: ChamberTally;
};

export type ZctaBlockObservation = {
  zcta5: string;
  population: number;
  lowerGeoid: string | null;
  upperGeoid: string | null;
  isSplitBlock: boolean;
};

function tallyChamber(tally: ChamberTally, districtGeoid: string | null, population: number): void {
  if (districtGeoid === null) {
    tally.unassigned += population;
    return;
  }
  tally.byDistrict.set(districtGeoid, (tally.byDistrict.get(districtGeoid) ?? 0) + population);
}

/** The one district every resident lives in, or null when there is none. */
function decideChamber(tally: ChamberTally, zcta: ZctaTally): string | null {
  if (zcta.population === 0 || zcta.splitBlockPopulation > 0 || tally.unassigned > 0) {
    return null;
  }
  if (tally.byDistrict.size !== 1) {
    return null;
  }
  const [districtGeoid] = tally.byDistrict.keys();
  return districtGeoid;
}

/**
 * Accumulates one observation per (ZCTA, block) and decides each ZCTA's
 * districts. Blocks without residents never influence the decision: they are
 * exactly the wilderness and water that makes land-share containment fail.
 */
export class ZctaLegislativeAccumulator {
  private readonly tallies = new Map<string, ZctaTally>();

  add(observation: ZctaBlockObservation): void {
    let tally = this.tallies.get(observation.zcta5);
    if (!tally) {
      tally = {
        population: 0,
        splitBlockPopulation: 0,
        lower: { byDistrict: new Map(), unassigned: 0 },
        upper: { byDistrict: new Map(), unassigned: 0 },
      };
      this.tallies.set(observation.zcta5, tally);
    }
    if (observation.population === 0) {
      return;
    }
    tally.population += observation.population;
    if (observation.isSplitBlock) {
      tally.splitBlockPopulation += observation.population;
    }
    tallyChamber(tally.lower, observation.lowerGeoid, observation.population);
    tallyChamber(tally.upper, observation.upperGeoid, observation.population);
  }

  get zctasSeen(): number {
    return this.tallies.size;
  }

  /** One row per ZCTA with at least one decided chamber, sorted by ZCTA. */
  rows(): ZctaLegislativeRow[] {
    const rows: ZctaLegislativeRow[] = [];
    for (const [zcta5, tally] of this.tallies) {
      const lower = decideChamber(tally.lower, tally);
      const upper = decideChamber(tally.upper, tally);
      if (lower !== null || upper !== null) {
        rows.push({ zcta5, state_lower_geoid: lower, state_upper_geoid: upper });
      }
    }
    rows.sort((a, b) => (a.zcta5 < b.zcta5 ? -1 : 1));
    return rows;
  }
}

export type RelationshipColumnIndexes = { zcta: number; block: number; width: number };

/** Validates the relationship file header and returns the columns to read. */
export function parseRelationshipHeader(headerLine: string): RelationshipColumnIndexes {
  const withoutBom = headerLine.charCodeAt(0) === 0xfeff ? headerLine.slice(1) : headerLine;
  const header = withoutBom.split("|");
  const columnIndex = new Map(header.map((name, index) => [name, index]));
  for (const column of RELATIONSHIP_COLUMNS) {
    if (!columnIndex.has(column)) {
      throw new Error(`relationship file header is missing column ${column}; got: ${header.join("|")}`);
    }
  }
  return {
    zcta: columnIndex.get("GEOID_ZCTA5_20")!,
    block: columnIndex.get("GEOID_TABBLOCK_20")!,
    width: header.length,
  };
}

export type RelationshipSources = {
  lower: BlockDistricts;
  upper: BlockDistricts;
  population: BlockLookup;
  splitBlocks: ReadonlySet<number>;
};

/**
 * Feeds one relationship-file data line to the accumulator. Returns false
 * for the blank-ZCTA records (block territory outside every ZCTA), which the
 * ZIP path cannot use.
 */
export function observeRelationshipLine(
  line: string,
  lineNumber: number,
  columns: RelationshipColumnIndexes,
  sources: RelationshipSources,
  accumulator: ZctaLegislativeAccumulator
): boolean {
  const fields = line.split("|");
  if (fields.length !== columns.width) {
    throw new Error(`line ${lineNumber}: expected ${columns.width} fields, got ${fields.length}`);
  }
  const zcta5 = fields[columns.zcta].trim();
  if (zcta5.length === 0) {
    return false;
  }
  if (!FIVE_DIGITS.test(zcta5)) {
    throw new Error(`line ${lineNumber}: invalid ZCTA "${zcta5}"`);
  }
  const blockGeoid = parseBlockGeoid(fields[columns.block].trim(), `line ${lineNumber}`);
  const lowerValue = sources.lower.lookup.get(blockGeoid);
  const upperValue = sources.upper.lookup.get(blockGeoid);
  accumulator.add({
    zcta5,
    population: sources.population.get(blockGeoid) ?? 0,
    lowerGeoid: lowerValue === undefined ? null : sources.lower.geoids[lowerValue],
    upperGeoid: upperValue === undefined ? null : sources.upper.geoids[upperValue],
    isSplitBlock: sources.splitBlocks.has(blockGeoid),
  });
  return true;
}

// ---------------------------------------------------------------------------
// Downloads (cached under --data-dir when given).
// ---------------------------------------------------------------------------

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// AbortSignal.timeout's timer is unref'd, so it bounds the whole download
// (headers and body) without keeping the process alive afterwards.
async function fetchWithTimeout(url: string): Promise<Response> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok || response.body === null) {
    throw new Error(`download failed: ${url} status=${response.status} ${response.statusText}`);
  }
  return response;
}

async function downloadBytes(url: string, cachePath: string | null): Promise<Uint8Array> {
  if (cachePath !== null && (await fileExists(cachePath))) {
    console.log(`Reading ${cachePath}`);
    return new Uint8Array(await readFile(cachePath));
  }
  console.log(`Downloading ${url}`);
  const response = await fetchWithTimeout(url);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (cachePath !== null) {
    await writeFile(cachePath, bytes);
  }
  return bytes;
}

async function readEquivalencyZip(url: string, member: string, cachePath: string | null): Promise<string> {
  const files = unzipSync(await downloadBytes(url, cachePath));
  const bytes = files[member];
  if (!bytes) {
    throw new Error(`${url} has no ${member}; members: ${Object.keys(files).join(", ")}`);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

async function loadBlockPopulations(dataDir: string | null, apiKeys: readonly string[]): Promise<BlockLookup> {
  const stateFipsList = [...new Set(Object.values(STATE_FIPS_BY_ABBREVIATION))].sort();
  const entries: BlockPopulationEntry[] = [];
  for (const stateFips of stateFipsList) {
    const cachePath = dataDir === null ? null : `${dataDir}/block-population-${stateFips}.json`;
    let payload: unknown;
    if (cachePath !== null && (await fileExists(cachePath))) {
      payload = JSON.parse(await readFile(cachePath, "utf8")) as unknown;
    } else {
      console.log(`Fetching 2020 block populations for state ${stateFips}`);
      payload = await fetchCensusJsonWithKeyRotation(blockPopulationUrl(stateFips), apiKeys);
      if (cachePath !== null) {
        await writeFile(cachePath, JSON.stringify(payload));
      }
    }
    // No spread: a state has up to ~700k blocks, far past the argument limit.
    for (const entry of parseBlockPopulationResponse(payload, stateFips)) {
      entries.push(entry);
    }
  }
  return buildPopulationLookup(entries);
}

async function relationshipLines(dataDir: string | null): Promise<AsyncIterable<string>> {
  const cachePath = dataDir === null ? null : `${dataDir}/tab20_zcta520_tabblock20_natl.txt`;
  if (cachePath !== null && (await fileExists(cachePath))) {
    console.log(`Reading ${cachePath}`);
    return createInterface({ input: createReadStream(cachePath, "utf8"), crlfDelay: Infinity });
  }
  console.log(`Downloading ${ZCTA_BLOCK_RELATIONSHIP_URL}`);
  const response = await fetchWithTimeout(ZCTA_BLOCK_RELATIONSHIP_URL);
  const body = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
  if (cachePath !== null) {
    // Stream to disk first so a second run finds the file; the parse then
    // reads it back rather than holding a gigabyte in memory.
    const { pipeline } = await import("node:stream/promises");
    const { createWriteStream } = await import("node:fs");
    await pipeline(body, createWriteStream(cachePath));
    return createInterface({ input: createReadStream(cachePath, "utf8"), crlfDelay: Infinity });
  }
  body.setEncoding("utf8");
  return createInterface({ input: body, crlfDelay: Infinity });
}

export async function buildZctaLegislativeRows(
  lines: AsyncIterable<string>,
  sources: RelationshipSources
): Promise<{ rows: ZctaLegislativeRow[]; zctas_seen: number; data_lines: number }> {
  const accumulator = new ZctaLegislativeAccumulator();
  let columns: RelationshipColumnIndexes | null = null;
  let lineNumber = 0;
  let dataLines = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (line.length === 0) {
      continue;
    }
    if (columns === null) {
      columns = parseRelationshipHeader(line);
      continue;
    }
    if (observeRelationshipLine(line, lineNumber, columns, sources, accumulator)) {
      dataLines += 1;
    }
  }
  if (columns === null) {
    throw new Error("relationship file is empty");
  }
  return { rows: accumulator.rows(), zctas_seen: accumulator.zctasSeen, data_lines: dataLines };
}

async function main(): Promise<void> {
  const dataDirFlagIndex = process.argv.indexOf("--data-dir");
  const dataDir = dataDirFlagIndex >= 0 ? process.argv[dataDirFlagIndex + 1] : null;
  if (dataDirFlagIndex >= 0 && !dataDir) {
    throw new Error("--data-dir requires a path argument");
  }
  if (dataDir !== null) {
    await mkdir(dataDir, { recursive: true });
  }
  const env = getPipelineEnv();

  const cachePath = (name: string): string | null => (dataDir === null ? null : `${dataDir}/${name}`);
  const lower = parseBlockEquivalencyFile(
    await readEquivalencyZip(SLDL_BLOCK_EQUIVALENCY_ZIP_URL, SLDL_NATIONAL_MEMBER, cachePath("sldl24.zip"))
  );
  const upper = parseBlockEquivalencyFile(
    await readEquivalencyZip(SLDU_BLOCK_EQUIVALENCY_ZIP_URL, SLDU_NATIONAL_MEMBER, cachePath("sldu24.zip"))
  );
  console.log(`${lower.lookup.size} blocks with a lower-chamber district; ${upper.lookup.size} with an upper-chamber district`);
  const population = await loadBlockPopulations(dataDir, env.CENSUS_API_KEYS);
  console.log(`${population.size} blocks with a 2020 population`);
  const splitBlocks = new Set(SPLIT_BLOCK_GEOIDS.map((geoid) => parseBlockGeoid(geoid, "SPLIT_BLOCK_GEOIDS")));

  const built = await buildZctaLegislativeRows(await relationshipLines(dataDir), { lower, upper, population, splitBlocks });
  const lowerCount = built.rows.filter((row) => row.state_lower_geoid !== null).length;
  const upperCount = built.rows.filter((row) => row.state_upper_geoid !== null).length;
  console.log(
    `${built.zctas_seen} ZCTAs in the file (${built.data_lines} block records); ${built.rows.length} rows: ${lowerCount} with a lower-chamber district, ${upperCount} with an upper-chamber district`
  );
  if (built.rows.length < MIN_PLAUSIBLE_ROWS || built.rows.length > MAX_PLAUSIBLE_ROWS) {
    throw new Error(
      `built ${built.rows.length} rows, outside the plausible band [${MIN_PLAUSIBLE_ROWS}, ${MAX_PLAUSIBLE_ROWS}]; refusing to replace existing data`
    );
  }

  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const client = await pool.connect();
  try {
    // Truncate-and-reload in one transaction: readers see the old data until
    // commit, and any failure leaves the previous load untouched.
    await client.query("BEGIN");
    await client.query("TRUNCATE public.address_zcta_legislative");
    const BATCH = 5_000;
    for (let offset = 0; offset < built.rows.length; offset += BATCH) {
      const batch = built.rows.slice(offset, offset + BATCH);
      await client.query(
        `
          INSERT INTO public.address_zcta_legislative (zcta5, state_lower_geoid, state_upper_geoid)
          SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
        `,
        [
          batch.map((row) => row.zcta5),
          batch.map((row) => row.state_lower_geoid),
          batch.map((row) => row.state_upper_geoid),
        ]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }

  console.log(`Loaded ${built.rows.length} rows into address_zcta_legislative`);
}

// Only run as a CLI; tests import the parsers and the accumulator directly.
if (process.argv[1]?.endsWith("importZctaLegislativeCrosswalk.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
