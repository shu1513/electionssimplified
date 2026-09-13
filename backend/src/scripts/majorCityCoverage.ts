import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import {
  DEFAULT_MANUAL_RESEARCH_DEMAND_HORIZON_DAYS,
  findResearchGapsForDistricts,
  MANUAL_RESEARCH_DEMAND_STAGES,
  type ManualResearchDemandStage,
  type ResearchGap,
} from "../pipeline/address/manualResearchDemand.js";
import { readStrictFlagValue, readStrictPositiveIntegerFlag } from "../utils/cliFlags.js";
import { usLatestLocalDateIso } from "../utils/usLocalDate.js";
import { assertKnownCliFlags, type CliFlagSpec } from "./manualCliFlags.js";

// Research coverage for the largest US cities (major-cities.tsv, Census
// 2025 estimates). A city's ballot is built from every district that
// overlaps it — county, state legislative, congressional, school, statewide —
// not just the city row, so `build-map` resolves that overlap set from the
// Census TIGERweb polygons once and stores it in city-districts.json.
// `report` then re-derives every open research gap on those districts from
// live data (the same gap queries the demand ledger uses, plus districts
// whose elections were never searched) so a research session can work a
// city top-down: election discovery -> rosters -> profiles -> records.
//
// Overlap is decided by sampling a grid of points inside the city polygon
// and keeping districts that contain at least one sample. A raw polygon
// intersect returns boundary slivers (verified live: NYC picked up Nassau
// and Westchester counties and every NJ district across the Hudson), and
// TIGERweb cannot compute intersection areas, so point sampling is the
// filter. `city_share` is the fraction of samples inside each district.

type Queryable = Pick<Pool, "query">;

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../manual-research/major-cities");
const CITIES_PATH = path.join(DATA_DIR, "major-cities.tsv");
const MAP_PATH = path.join(DATA_DIR, "city-districts.json");

const TIGERWEB = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb";
const SAMPLE_GRIDS = [60, 90, 130, 180];
const MIN_SAMPLE_POINTS = 2_000;
const BUILD_CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 90_000;
const FETCH_ATTEMPTS = 3;

type DistrictType =
  | "statewide"
  | "county"
  | "place"
  | "us_house"
  | "state_upper"
  | "state_lower"
  | "school_unified"
  | "school_secondary"
  | "school_elementary";

// Layer ids are the "BAS 2026" group on each TIGERweb service: 119th
// Congress + 2024 state legislative districts, matching districts.geoid_compact.
const DISTRICT_LAYERS: ReadonlyArray<{ district_type: DistrictType; service: string; layer: number }> = [
  { district_type: "us_house", service: "Legislative", layer: 4 },
  { district_type: "state_upper", service: "Legislative", layer: 5 },
  { district_type: "state_lower", service: "Legislative", layer: 6 },
  { district_type: "county", service: "State_County", layer: 1 },
  { district_type: "school_unified", service: "School", layer: 5 },
  { district_type: "school_secondary", service: "School", layer: 6 },
  { district_type: "school_elementary", service: "School", layer: 7 },
];

type PlaceLayerKind = "place" | "cdp" | "cousub";
const PLACE_LAYERS: ReadonlyArray<{ kind: PlaceLayerKind; layer: number }> = [
  { kind: "place", layer: 4 },
  { kind: "cdp", layer: 5 },
  { kind: "cousub", layer: 1 },
];
const PLACE_SERVICE = "Places_CouSub_ConCity_SubMCD";

export type CityRow = {
  name: string;
  state: string;
  population_2025: number;
  lat: number;
  lon: number;
};

export type MappedDistrict = {
  district_type: DistrictType;
  geoid_compact: string;
  name: string;
  city_share: number;
};

export type CityDistrictMap = CityRow & {
  place_geoid: string | null;
  place_layer: PlaceLayerKind | null;
  place_name: string | null;
  sample_points: number;
  slivers_dropped: number;
  districts: MappedDistrict[];
  built_at: string;
};

type EsriPolygon = { rings: number[][][] };
type EsriFeature<A> = { attributes: A; geometry?: EsriPolygon };
type EsriQueryResponse<A> = { features?: EsriFeature<A>[]; exceededTransferLimit?: boolean; error?: { message?: string } };
type GeoAttributes = { GEOID: string; NAME: string; STATE?: string };

export function cityKey(city: Pick<CityRow, "name" | "state">): string {
  return `${city.name}, ${city.state}`;
}

export function readCities(filePath: string = CITIES_PATH): CityRow[] {
  const lines = readFileSync(filePath, "utf8").split("\n").filter((line) => line.trim().length > 0);
  const [header, ...rows] = lines;
  const columns = header.split("\t");
  const index = (column: string): number => {
    const position = columns.indexOf(column);
    if (position < 0) {
      throw new Error(`major-cities.tsv is missing column ${column}`);
    }
    return position;
  };
  const nameAt = index("name");
  const stateAt = index("state");
  const popAt = index("population_2025");
  const latAt = index("lat");
  const lonAt = index("lon");
  return rows.map((line) => {
    const cells = line.split("\t");
    return {
      name: cells[nameAt].trim(),
      state: cells[stateAt].trim().toUpperCase(),
      population_2025: Number.parseInt(cells[popAt], 10),
      lat: Number.parseFloat(cells[latAt]),
      lon: Number.parseFloat(cells[lonAt]),
    };
  });
}

function readMap(): Map<string, CityDistrictMap> {
  if (!existsSync(MAP_PATH)) {
    return new Map();
  }
  const parsed = JSON.parse(readFileSync(MAP_PATH, "utf8")) as { cities: CityDistrictMap[] };
  return new Map(parsed.cities.map((city) => [cityKey(city), city]));
}

function writeMap(map: Map<string, CityDistrictMap>): void {
  const cities = [...map.values()].sort((a, b) => b.population_2025 - a.population_2025);
  // Temp + rename so an interrupted build never leaves half-written JSON
  // that readMap cannot resume from.
  const tempPath = `${MAP_PATH}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify({ cities }, null, 2)}\n`);
  renameSync(tempPath, MAP_PATH);
}

async function fetchJson<T>(url: string, body?: URLSearchParams): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: body ? "POST" : "GET",
        headers: body ? { "content-type": "application/x-www-form-urlencoded" } : undefined,
        body,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${url}`);
      }
      const json = (await response.json()) as T & { error?: { message?: string } };
      if (json.error) {
        throw new Error(`TIGERweb error from ${url}: ${json.error.message ?? "unknown"}`);
      }
      return json;
    } catch (error) {
      lastError = error;
      if (attempt < FETCH_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function queryLayer<A>(
  service: string,
  layer: number,
  params: Record<string, string>
): Promise<EsriQueryResponse<A>> {
  const body = new URLSearchParams({ f: "json", outSR: "4326", ...params });
  return fetchJson<EsriQueryResponse<A>>(`${TIGERWEB}/${service}/MapServer/${layer}/query`, body);
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

async function findCityPolygon(
  city: CityRow,
  stateFips: string
): Promise<{ kind: PlaceLayerKind; feature: EsriFeature<GeoAttributes> } | null> {
  const wanted = normalizeName(city.name);
  const geometryParams = { returnGeometry: "true", geometryPrecision: "4", outFields: "GEOID,NAME,STATE" };
  const escaped = city.name.replace(/'/g, "''");
  // The list's coordinates are minute-precision and can fall just outside
  // the polygon (Bakersfield, Eugene landed in the surrounding CCD), so a
  // name search backs up the point lookup on every layer before moving on.
  const lookups: Array<Record<string, string>> = [
    { geometry: `${city.lon},${city.lat}`, geometryType: "esriGeometryPoint", inSR: "4326", spatialRel: "esriSpatialRelIntersects" },
    { where: `STATE='${stateFips}' AND NAME LIKE '${escaped}%'` },
  ];
  // A same-named place elsewhere in the state (Clinton village vs Clinton
  // township, MI) must not win the name search: the polygon has to sit
  // around the listed coordinates.
  const nearCity = (feature: EsriFeature<GeoAttributes>): boolean => {
    const box = boundingBox(feature.geometry as EsriPolygon);
    const pad = 0.05;
    return city.lon >= box.minX - pad && city.lon <= box.maxX + pad && city.lat >= box.minY - pad && city.lat <= box.maxY + pad;
  };
  const matches: Array<{ kind: PlaceLayerKind; feature: EsriFeature<GeoAttributes> }> = [];
  for (const { kind, layer } of PLACE_LAYERS) {
    for (const lookup of lookups) {
      const response = await queryLayer<GeoAttributes>(PLACE_SERVICE, layer, { ...lookup, ...geometryParams });
      const hit = (response.features ?? []).find(
        (feature) => feature.geometry && normalizeName(feature.attributes.NAME).includes(wanted) && nearCity(feature)
      );
      if (hit?.geometry) {
        matches.push({ kind, feature: hit });
        break;
      }
    }
    if (kind === "place" && matches.length > 0) {
      return matches[0];
    }
  }
  // A New Jersey township is the municipality; its same-named CDP is only
  // the built-up part. A CCD (Census county division) is never a government.
  const township = matches.find((m) => m.kind === "cousub" && /township|town$|borough|municipality/i.test(m.feature.attributes.NAME));
  return township ?? matches.find((m) => m.kind === "cdp") ?? matches[0] ?? null;
}

export function pointInPolygon(lon: number, lat: number, polygon: EsriPolygon): boolean {
  let inside = false;
  for (const ring of polygon.rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

function boundingBox(polygon: EsriPolygon): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const ring of polygon.rings) {
    for (const [x, y] of ring) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return { minX, minY, maxX, maxY };
}

export function samplePoints(polygon: EsriPolygon): Array<[number, number]> {
  const { minX, minY, maxX, maxY } = boundingBox(polygon);
  // Irregular cities (Los Angeles' neck to San Pedro) fill little of their
  // bounding box, so densify the grid until enough samples land inside.
  let points: Array<[number, number]> = [];
  for (const grid of SAMPLE_GRIDS) {
    points = [];
    for (let i = 0; i < grid; i += 1) {
      const lon = minX + ((i + 0.5) / grid) * (maxX - minX);
      for (let j = 0; j < grid; j += 1) {
        const lat = minY + ((j + 0.5) / grid) * (maxY - minY);
        if (pointInPolygon(lon, lat, polygon)) {
          points.push([lon, lat]);
        }
      }
    }
    if (points.length >= MIN_SAMPLE_POINTS) {
      break;
    }
  }
  return points;
}

async function buildCity(city: CityRow, stateFips: string): Promise<CityDistrictMap> {
  const found = await findCityPolygon(city, stateFips);
  const districts: MappedDistrict[] = [{ district_type: "statewide", geoid_compact: stateFips, name: city.state, city_share: 1 }];
  const base = { ...city, built_at: new Date().toISOString() };
  if (!found?.feature.geometry) {
    return { ...base, place_geoid: null, place_layer: null, place_name: null, sample_points: 0, slivers_dropped: 0, districts };
  }
  const polygon = found.feature.geometry;
  const points = samplePoints(polygon);
  districts.push({
    district_type: "place",
    geoid_compact: found.feature.attributes.GEOID,
    name: found.feature.attributes.NAME,
    city_share: 1,
  });
  let sliversDropped = 0;
  const geometry = JSON.stringify({ rings: polygon.rings, spatialReference: { wkid: 4326 } });
  for (const { district_type, service, layer } of DISTRICT_LAYERS) {
    const response = await queryLayer<GeoAttributes>(service, layer, {
      geometry,
      geometryType: "esriGeometryPolygon",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      where: `STATE='${stateFips}'`,
      outFields: "GEOID,NAME,STATE",
      returnGeometry: "true",
      geometryPrecision: "4",
    });
    if (response.exceededTransferLimit) {
      console.error(`warning: ${cityKey(city)} ${district_type} hit the TIGERweb transfer limit; overlap set may be incomplete`);
    }
    for (const feature of response.features ?? []) {
      if (!feature.geometry) {
        continue;
      }
      const hits = points.reduce((count, [lon, lat]) => count + (pointInPolygon(lon, lat, feature.geometry as EsriPolygon) ? 1 : 0), 0);
      if (hits === 0) {
        sliversDropped += 1;
        continue;
      }
      districts.push({
        district_type,
        geoid_compact: feature.attributes.GEOID,
        name: feature.attributes.NAME,
        city_share: Number((hits / points.length).toFixed(4)),
      });
    }
  }
  return {
    ...base,
    place_geoid: found.feature.attributes.GEOID,
    place_layer: found.kind,
    place_name: found.feature.attributes.NAME,
    sample_points: points.length,
    slivers_dropped: sliversDropped,
    districts,
  };
}

async function loadStateFips(db: Queryable): Promise<Map<string, string>> {
  const result = await db.query<{ state: string; geoid_compact: string }>(
    `SELECT state, geoid_compact FROM public.districts WHERE district_type = 'statewide'`
  );
  return new Map(result.rows.map((row) => [row.state, row.geoid_compact]));
}

type CityFilter = { city?: string; state?: string; limit?: number };

function selectCities(cities: CityRow[], filter: CityFilter): CityRow[] {
  let selected = cities;
  if (filter.city) {
    const wanted = filter.city.toLowerCase();
    selected = selected.filter((city) => cityKey(city).toLowerCase() === wanted || city.name.toLowerCase() === wanted);
  }
  if (filter.state) {
    selected = selected.filter((city) => city.state === filter.state);
  }
  if (filter.limit !== undefined) {
    selected = selected.slice(0, filter.limit);
  }
  return selected;
}

async function runBuildMap(db: Queryable, argv: readonly string[]): Promise<void> {
  const filter = readCityFilter(argv);
  const force = argv.includes("--force");
  const cities = selectCities(readCities(), filter);
  const stateFips = await loadStateFips(db);
  const map = readMap();
  const pending = cities.filter((city) => force || !map.has(cityKey(city)));
  const skipped = cities.length - pending.length;
  for (const city of pending) {
    if (!stateFips.has(city.state)) {
      throw new Error(`No statewide district row for ${city.state}; cannot resolve ${cityKey(city)}`);
    }
  }
  let built = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < pending.length) {
      const city = pending[next];
      next += 1;
      const key = cityKey(city);
      const entry = await buildCity(city, stateFips.get(city.state) as string);
      map.set(key, entry);
      writeMap(map);
      built += 1;
      console.error(
        `[${built}/${pending.length}] ${key}: ${entry.place_layer ?? "NO POLYGON"} ${entry.place_geoid ?? ""} districts=${entry.districts.length} samples=${entry.sample_points} slivers=${entry.slivers_dropped}`
      );
    }
  };
  await Promise.all(Array.from({ length: BUILD_CONCURRENCY }, () => worker()));
  console.log(JSON.stringify({ built, skipped, mapped: map.size, mapPath: MAP_PATH }, null, 2));
}

export type CoverageStage = ManualResearchDemandStage | "election_discovery" | "roster_deferral_due";
export const COVERAGE_STAGES: readonly CoverageStage[] = [
  "election_discovery",
  "roster_deferral_due",
  ...MANUAL_RESEARCH_DEMAND_STAGES,
];

type DbDistrict = {
  id: string;
  district_type: string;
  geoid_compact: string;
  name: string;
  state: string;
  last_elections_searched_at: string | null;
};

export type CoverageGap = Omit<ResearchGap, "stage"> & {
  stage: CoverageStage;
  district_type: string;
  district_name: string;
  city_share: number;
};

export type CityCoverage = {
  city: string;
  state: string;
  population_2025: number;
  place_in_db: boolean;
  place_layer: PlaceLayerKind | null;
  districts_mapped: number;
  districts_missing_in_db: Array<{ district_type: string; geoid_compact: string; name: string }>;
  districts_stale_180d: number;
  gap_counts: Partial<Record<CoverageStage, number>>;
  gaps?: CoverageGap[];
};

export type CoverageReport = {
  asOfDate: string;
  horizonDays: number;
  minShare: number;
  cities: CityCoverage[];
  totals_by_stage: Partial<Record<CoverageStage, number>>;
  totals_by_state: Record<string, Partial<Record<CoverageStage, number>>>;
};

async function loadDbDistricts(db: Queryable, wanted: MappedDistrict[]): Promise<Map<string, DbDistrict>> {
  const keys = [...new Map(wanted.map((d) => [`${d.district_type}:${d.geoid_compact}`, d])).values()];
  const result = await db.query<DbDistrict>(
    `
      SELECT d.id::text AS id, d.district_type, d.geoid_compact, d.name, d.state,
        d.last_elections_searched_at::text AS last_elections_searched_at
      FROM public.districts AS d
      JOIN unnest($1::text[], $2::text[]) AS k(district_type, geoid_compact)
        ON k.district_type = d.district_type AND k.geoid_compact = d.geoid_compact
    `,
    [keys.map((k) => k.district_type), keys.map((k) => k.geoid_compact)]
  );
  return new Map(result.rows.map((row) => [`${row.district_type}:${row.geoid_compact}`, row]));
}

async function loadOpenElectionsDeferrals(db: Queryable, asOfDate: string): Promise<Set<string>> {
  const result = await db.query<{ district_id: string }>(
    `
      SELECT DISTINCT district_id::text AS district_id
      FROM public.manual_research_deferrals
      WHERE status = 'deferred' AND stage = 'elections' AND blocked_until > $1::date
    `,
    [asOfDate]
  );
  return new Set(result.rows.map((row) => row.district_id));
}

type DueRosterDeferral = {
  id: string;
  district_id: string;
  election_id: string | null;
  blocked_until: string;
  reason: string;
  label: string;
  election_date: string | null;
};

// A roster deferral past its date is a "candidate list not final" that can
// now be retried. The roster gap query only surfaces it when the election
// has zero candidate links; a partial roster keeps the row hidden there.
async function loadDueRosterDeferrals(db: Queryable, asOfDate: string, districtIds: string[]): Promise<DueRosterDeferral[]> {
  const result = await db.query<DueRosterDeferral>(
    `
      SELECT m.id::text AS id, m.district_id::text AS district_id, m.election_id::text AS election_id,
        m.blocked_until::text AS blocked_until, m.reason,
        COALESCE(e.official_ballot_title, m.district_name_snapshot) AS label,
        e.election_date::text AS election_date
      FROM public.manual_research_deferrals AS m
      LEFT JOIN public.elections AS e ON e.id = m.election_id
      WHERE m.status = 'deferred'
        AND m.stage = 'candidate_roster'
        AND m.blocked_until <= $1::date
        AND m.district_id = ANY($2::uuid[])
      ORDER BY m.blocked_until ASC
    `,
    [asOfDate, districtIds]
  );
  return result.rows;
}

function bump(counts: Partial<Record<CoverageStage, number>>, stage: CoverageStage): void {
  counts[stage] = (counts[stage] ?? 0) + 1;
}

export async function buildCoverageReport(
  db: Queryable,
  input: { asOfDate: string; horizonDays: number; minShare: number; stage?: CoverageStage; detail: boolean } & CityFilter
): Promise<CoverageReport> {
  const cities = selectCities(readCities(), input);
  const map = readMap();
  const entries = cities.map((city) => {
    const entry = map.get(cityKey(city));
    if (!entry) {
      throw new Error(`${cityKey(city)} is not in city-districts.json; run manual:city-coverage:build-map first`);
    }
    return entry;
  });
  const dbDistricts = await loadDbDistricts(
    db,
    entries.flatMap((entry) => entry.districts)
  );
  const openElectionsDeferrals = await loadOpenElectionsDeferrals(db, input.asOfDate);

  // district id -> every city it overlaps (a county or CD serves many cities)
  const cityIndexesByDistrictId = new Map<string, Array<{ cityIndex: number; share: number }>>();
  entries.forEach((entry, cityIndex) => {
    for (const district of entry.districts) {
      if (district.city_share < input.minShare) {
        continue;
      }
      const row = dbDistricts.get(`${district.district_type}:${district.geoid_compact}`);
      if (!row) {
        continue;
      }
      const list = cityIndexesByDistrictId.get(row.id) ?? [];
      list.push({ cityIndex, share: district.city_share });
      cityIndexesByDistrictId.set(row.id, list);
    }
  });
  const districtIds = [...cityIndexesByDistrictId.keys()];
  const dbById = new Map([...dbDistricts.values()].map((row) => [row.id, row]));
  const ledgerGaps = await findResearchGapsForDistricts(db, {
    districtIds,
    asOfDate: input.asOfDate,
    horizonDays: input.horizonDays,
  });
  const dueRosterDeferrals = await loadDueRosterDeferrals(db, input.asOfDate, districtIds);

  const staleCutoff = new Date(input.asOfDate);
  staleCutoff.setDate(staleCutoff.getDate() - 180);
  const perCity: CityCoverage[] = entries.map((entry) => {
    const missing = entry.districts
      .filter((d) => d.city_share >= input.minShare && !dbDistricts.has(`${d.district_type}:${d.geoid_compact}`))
      .map((d) => ({ district_type: d.district_type, geoid_compact: d.geoid_compact, name: d.name }));
    return {
      city: entry.name,
      state: entry.state,
      population_2025: entry.population_2025,
      place_in_db: entry.place_geoid !== null && dbDistricts.has(`place:${entry.place_geoid}`),
      place_layer: entry.place_layer,
      districts_mapped: entry.districts.filter((d) => d.city_share >= input.minShare).length,
      districts_missing_in_db: missing,
      districts_stale_180d: 0,
      gap_counts: {},
      ...(input.detail ? { gaps: [] } : {}),
    };
  });

  // A unit is one (stage, target): a statewide candidate sits on every
  // city's ballot but is one research unit, so per-city counts and totals
  // both dedupe on that key.
  const seenByCity = perCity.map(() => new Set<string>());
  const uniqueByStage = new Map<CoverageStage, Set<string>>();
  const uniqueByState = new Map<string, Map<CoverageStage, Set<string>>>();
  const attach = (gap: Omit<CoverageGap, "district_id" | "district_type" | "district_name" | "city_share">, districtIds: string[]): void => {
    if (input.stage && gap.stage !== input.stage) {
      return;
    }
    const key = `${gap.stage}:${gap.target_id}`;
    for (const districtId of districtIds) {
      const row = dbById.get(districtId);
      for (const { cityIndex, share } of cityIndexesByDistrictId.get(districtId) ?? []) {
        if (seenByCity[cityIndex].has(key)) {
          continue;
        }
        seenByCity[cityIndex].add(key);
        const city = perCity[cityIndex];
        bump(city.gap_counts, gap.stage);
        city.gaps?.push({
          ...gap,
          district_id: districtId,
          district_type: row?.district_type ?? "",
          district_name: row?.name ?? "",
          city_share: share,
        });
        (uniqueByStage.get(gap.stage) ?? uniqueByStage.set(gap.stage, new Set()).get(gap.stage))?.add(gap.target_id);
        const stateStages = uniqueByState.get(city.state) ?? uniqueByState.set(city.state, new Map()).get(city.state);
        (stateStages?.get(gap.stage) ?? stateStages?.set(gap.stage, new Set()).get(gap.stage))?.add(gap.target_id);
      }
    }
  };

  // The profile/records gap queries keep one district per candidate
  // (DISTINCT ON candidate); a candidate on ballots in two districts must
  // reach both districts' cities.
  const candidateIds = ledgerGaps
    .filter((gap) => gap.stage === "candidate_profile" || gap.stage === "candidate_records")
    .map((gap) => gap.target_id);
  const districtsByCandidate = new Map<string, string[]>();
  if (candidateIds.length > 0) {
    const result = await db.query<{ candidate_id: string; district_id: string }>(
      `
        SELECT DISTINCT ce.candidate_id::text AS candidate_id, e.district_id::text AS district_id
        FROM public.candidate_elections AS ce
        JOIN public.elections AS e ON e.id = ce.election_id
        WHERE ce.candidate_id = ANY($1::uuid[])
          AND e.district_id = ANY($2::uuid[])
          AND e.race_type = 'office'
          AND e.election_date >= $3::date
          AND (e.election_date - $3::date)::int <= $4::int
          AND ce.status <> 'withdrawn'
      `,
      [[...new Set(candidateIds)], districtIds, input.asOfDate, input.horizonDays]
    );
    for (const row of result.rows) {
      districtsByCandidate.set(row.candidate_id, [...(districtsByCandidate.get(row.candidate_id) ?? []), row.district_id]);
    }
  }

  for (const [districtId, row] of dbById) {
    if (!cityIndexesByDistrictId.has(districtId)) {
      continue;
    }
    if (row.last_elections_searched_at === null) {
      if (!openElectionsDeferrals.has(districtId)) {
        attach(
          {
            stage: "election_discovery",
            target_id: districtId,
            election_id: null,
            state: row.state,
            label: row.name,
            election_date: null,
          },
          [districtId]
        );
      }
    } else if (new Date(row.last_elections_searched_at) < staleCutoff) {
      for (const { cityIndex } of cityIndexesByDistrictId.get(districtId) ?? []) {
        perCity[cityIndex].districts_stale_180d += 1;
      }
    }
  }
  for (const gap of ledgerGaps) {
    const { district_id, ...unit } = gap;
    attach(unit, districtsByCandidate.get(gap.target_id) ?? [district_id]);
  }
  for (const deferral of dueRosterDeferrals) {
    attach(
      {
        stage: "roster_deferral_due",
        target_id: deferral.id,
        election_id: deferral.election_id,
        state: dbById.get(deferral.district_id)?.state ?? "",
        label: `${deferral.label} — deferred until ${deferral.blocked_until}: ${deferral.reason}`,
        election_date: deferral.election_date,
      },
      [deferral.district_id]
    );
  }

  const totalsByStage: Partial<Record<CoverageStage, number>> = {};
  for (const [stage, targets] of uniqueByStage) {
    totalsByStage[stage] = targets.size;
  }
  const totalsByState: Record<string, Partial<Record<CoverageStage, number>>> = {};
  for (const [state, stages] of uniqueByState) {
    totalsByState[state] = Object.fromEntries([...stages].map(([stage, targets]) => [stage, targets.size]));
  }
  for (const city of perCity) {
    city.gaps?.sort((a, b) => a.stage.localeCompare(b.stage) || (a.election_date ?? "").localeCompare(b.election_date ?? ""));
  }
  return {
    asOfDate: input.asOfDate,
    horizonDays: input.horizonDays,
    minShare: input.minShare,
    cities: perCity,
    totals_by_stage: totalsByStage,
    totals_by_state: totalsByState,
  };
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function reportToCsv(report: CoverageReport): string {
  const header = [
    "city", "state", "population_2025", "stage", "district_type", "district_name", "district_id",
    "target_id", "election_id", "label", "election_date", "city_share",
  ];
  const lines = [header.join(",")];
  for (const city of report.cities) {
    for (const gap of city.gaps ?? []) {
      lines.push(
        [
          city.city, city.state, city.population_2025, gap.stage, gap.district_type, gap.district_name, gap.district_id,
          gap.target_id, gap.election_id, gap.label, gap.election_date, gap.city_share,
        ]
          .map(csvCell)
          .join(",")
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function readCityFilter(argv: readonly string[]): CityFilter {
  const state = readStrictFlagValue(argv, "--state");
  if (state !== null && !/^[A-Za-z]{2}$/.test(state.trim())) {
    throw new Error(`--state must be a two-letter state code, got: ${state}`);
  }
  return {
    city: readStrictFlagValue(argv, "--city") ?? undefined,
    state: state?.trim().toUpperCase(),
    limit: readStrictPositiveIntegerFlag(argv, "--limit") ?? undefined,
  };
}

async function runReport(db: Queryable, argv: readonly string[]): Promise<void> {
  const format = readStrictFlagValue(argv, "--format") ?? "json";
  if (format !== "json" && format !== "csv") {
    throw new Error(`--format must be json or csv, got: ${format}`);
  }
  const rawStage = readStrictFlagValue(argv, "--stage");
  if (rawStage !== null && !COVERAGE_STAGES.includes(rawStage as CoverageStage)) {
    throw new Error(`Invalid --stage: ${rawStage}. Expected one of ${COVERAGE_STAGES.join(", ")}.`);
  }
  const rawShare = readStrictFlagValue(argv, "--min-share");
  const minShare = rawShare === null ? 0 : Number.parseFloat(rawShare);
  if (!Number.isFinite(minShare) || minShare < 0 || minShare > 1) {
    throw new Error(`--min-share must be between 0 and 1, got: ${rawShare}`);
  }
  const report = await buildCoverageReport(db, {
    ...readCityFilter(argv),
    asOfDate: usLatestLocalDateIso(),
    horizonDays: readStrictPositiveIntegerFlag(argv, "--horizon-days") ?? DEFAULT_MANUAL_RESEARCH_DEMAND_HORIZON_DAYS,
    minShare,
    stage: (rawStage as CoverageStage | null) ?? undefined,
    detail: format === "csv" || argv.includes("--detail"),
  });
  process.stdout.write(format === "csv" ? reportToCsv(report) : `${JSON.stringify(report, null, 2)}\n`);
}

function usage(): string {
  return [
    "Major-city research coverage (read-only against the database).",
    "",
    "Usage: npm run manual:city-coverage:<command> -- [flags]",
    "",
    "Commands:",
    "  build-map  Resolve each city's overlapping districts from Census TIGERweb into city-districts.json.",
    "             [--city \"Name, ST\"] [--state XX] [--limit <n>] [--force]",
    "  report     Open research gaps per city, largest city first.",
    `             [--city \"Name, ST\"] [--state XX] [--limit <n>] [--stage ${COVERAGE_STAGES.join("|")}]`,
    "             [--format json|csv] [--detail] [--min-share <0-1>] [--horizon-days <n>]",
  ].join("\n");
}

const FLAG_SPECS: Record<string, readonly CliFlagSpec[]> = {
  "build-map": [
    { name: "--city", value: "both" },
    { name: "--state", value: "both" },
    { name: "--limit", value: "both" },
    { name: "--force", value: "none" },
  ],
  report: [
    { name: "--city", value: "both" },
    { name: "--state", value: "both" },
    { name: "--limit", value: "both" },
    { name: "--stage", value: "both" },
    { name: "--format", value: "both" },
    { name: "--detail", value: "none" },
    { name: "--min-share", value: "both" },
    { name: "--horizon-days", value: "both" },
  ],
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv.find((token) => !token.startsWith("--"));
  if (!command || argv.includes("--help")) {
    console.log(usage());
    return;
  }
  const specs = FLAG_SPECS[command];
  if (!specs) {
    throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
  assertKnownCliFlags(`manual:city-coverage:${command}`, argv.filter((token) => token !== command), specs);
  loadProjectEnv();
  const pool = new Pool({ connectionString: requireEnv("DATABASE_URL") });
  try {
    if (command === "build-map") {
      await runBuildMap(pool, argv);
    } else {
      await runReport(pool, argv);
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("major-city coverage CLI failed:", message);
    process.exitCode = 1;
  });
}
