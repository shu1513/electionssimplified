import { Pool, type PoolClient } from "pg";

import { COUNTY_GEOIDS_50_PLUS_DC_2024, COUNTY_GEOIDS_50_PLUS_DC_2024_SET } from "../../constants/countyGeoids2024.js";
import {
  PLACE_GEOIDS_50_PLUS_DC_2024,
  PLACE_GEOIDS_50_PLUS_DC_2024_SET,
} from "../../constants/placeGeoids2024.js";
import {
  SCHOOL_UNIFIED_GEOIDS_50_PLUS_DC_2024,
  SCHOOL_UNIFIED_GEOIDS_50_PLUS_DC_2024_SET,
} from "../../constants/schoolUnifiedGeoids2024.js";
import {
  SCHOOL_SECONDARY_GEOIDS_2024,
  SCHOOL_SECONDARY_GEOIDS_2024_SET,
  SCHOOL_SECONDARY_STATE_FIPS_2024,
} from "../../constants/schoolSecondaryGeoids2024.js";
import {
  SCHOOL_ELEMENTARY_GEOIDS_2024,
  SCHOOL_ELEMENTARY_GEOIDS_2024_SET,
  SCHOOL_ELEMENTARY_STATE_FIPS_2024,
} from "../../constants/schoolElementaryGeoids2024.js";
import {
  STATE_UPPER_GEOIDS_2024,
  STATE_UPPER_GEOIDS_2024_SET,
  STATE_UPPER_STATE_FIPS_2024,
} from "../../constants/stateUpperGeoids2024.js";
import {
  STATE_LOWER_GEOIDS_2024,
  STATE_LOWER_GEOIDS_2024_SET,
  STATE_LOWER_STATE_FIPS_2024,
} from "../../constants/stateLowerGeoids2024.js";
import { fetchCensusJsonWithKeyRotation, readCensusApiKeysFromEnv } from "../../config/censusApi.js";
import { loadProjectEnv } from "../../config/env.js";
import { STATE_ABBR_BY_FIPS, getStateAbbreviationByFips, normalizeFips } from "../../constants/usStates.js";
import { REPRESENTATION_RULER_K } from "../address/votePower.js";

import { relabelUsHouseDistrictNameFor2026 } from "../address/usHouse2026Redistricting.js";

export const DISTRICTS_ACS_YEAR = 2024;
export const CENSUS_STATES_DISTRICTS_URL = `https://api.census.gov/data/${DISTRICTS_ACS_YEAR}/acs/acs5?get=NAME,B01001_001E&for=state:*`;
export const CENSUS_US_HOUSE_DISTRICTS_URL = `https://api.census.gov/data/${DISTRICTS_ACS_YEAR}/acs/acs5?get=NAME,B01001_001E&for=congressional+district:*`;
export const CENSUS_COUNTY_DISTRICTS_URL = `https://api.census.gov/data/${DISTRICTS_ACS_YEAR}/acs/acs5?get=NAME,B01001_001E&for=county:*`;
export const CENSUS_PLACE_DISTRICTS_URL = `https://api.census.gov/data/${DISTRICTS_ACS_YEAR}/acs/acs5?get=NAME,B01001_001E&for=place:*`;
export const CENSUS_SCHOOL_UNIFIED_DISTRICTS_URL = `https://api.census.gov/data/${DISTRICTS_ACS_YEAR}/acs/acs5?get=NAME,B01001_001E&for=school+district+(unified):*`;
export const CENSUS_SCHOOL_SECONDARY_DISTRICTS_URL = `https://api.census.gov/data/${DISTRICTS_ACS_YEAR}/acs/acs5?get=NAME,B01001_001E&for=school+district+(secondary):*`;
export const CENSUS_SCHOOL_ELEMENTARY_DISTRICTS_URL = `https://api.census.gov/data/${DISTRICTS_ACS_YEAR}/acs/acs5?get=NAME,B01001_001E&for=school+district+(elementary):*`;
export const CENSUS_STATE_UPPER_DISTRICTS_URL_PATTERN = `https://api.census.gov/data/${DISTRICTS_ACS_YEAR}/acs/acs5?get=NAME,B01001_001E&for=state+legislative+district+(upper+chamber):*&in=state:{state_fips}`;
export const CENSUS_STATE_LOWER_DISTRICTS_URL_PATTERN = `https://api.census.gov/data/${DISTRICTS_ACS_YEAR}/acs/acs5?get=NAME,B01001_001E&for=state+legislative+district+(lower+chamber):*&in=state:{state_fips}`;
export const EXPECTED_COUNTY_ROWS_50_PLUS_DC_2024 = COUNTY_GEOIDS_50_PLUS_DC_2024.length;
export const EXPECTED_PLACE_ROWS_50_PLUS_DC_2024 = PLACE_GEOIDS_50_PLUS_DC_2024.length;
export const EXPECTED_SCHOOL_UNIFIED_ROWS_50_PLUS_DC_2024 = SCHOOL_UNIFIED_GEOIDS_50_PLUS_DC_2024.length;
export const EXPECTED_SCHOOL_SECONDARY_ROWS_2024 = SCHOOL_SECONDARY_GEOIDS_2024.length;
export const EXPECTED_SCHOOL_ELEMENTARY_ROWS_2024 = SCHOOL_ELEMENTARY_GEOIDS_2024.length;
export const EXPECTED_STATE_UPPER_ROWS_2024 = STATE_UPPER_GEOIDS_2024.length;
export const EXPECTED_STATE_LOWER_ROWS_2024 = STATE_LOWER_GEOIDS_2024.length;
const CENSUS_FETCH_TIMEOUT_MS = 30_000;

function buildStateUpperDistrictsUrl(stateFips: string): string {
  return CENSUS_STATE_UPPER_DISTRICTS_URL_PATTERN.replace("{state_fips}", stateFips);
}

function buildStateLowerDistrictsUrl(stateFips: string): string {
  return CENSUS_STATE_LOWER_DISTRICTS_URL_PATTERN.replace("{state_fips}", stateFips);
}

export type DistrictLoadType =
  | "state"
  | "state_upper"
  | "state_lower"
  | "us_house"
  | "county"
  | "place"
  | "school_unified"
  | "school_secondary"
  | "school_elementary";

export type DistrictLoadOptions = {
  type: DistrictLoadType;
  dryRun?: boolean;
};

type DistrictRow = {
  geoid_compact: string;
  name: string;
  state: string;
  state_fips: string;
  district_type:
    | "statewide"
    | "state_upper"
    | "state_lower"
    | "us_house"
    | "county"
    | "place"
    | "school_unified"
    | "school_secondary"
    | "school_elementary";
  population: number;
};

type DistrictCodeColumnName = "geoid_compact" | "fips_code";

type ExistingDistrictRecord = {
  name: string;
  state: string;
  state_fips: string;
  population: number;
};

type DistrictLoadSummary = {
  type: DistrictLoadType;
  sourceUrl: string;
  totalCandidates: number;
  inserted: number;
  updated: number;
  skipped: number;
  dryRun: boolean;
};

function parsePopulation(value: string): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid population value from Census: ${value}`);
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid population value from Census: ${value}`);
  }
  return parsed;
}

/**
 * Parses the Census state endpoint into districts rows for the statewide district_type.
 */
export function parseStateDistrictRows(data: unknown): DistrictRow[] {
  if (!Array.isArray(data) || data.length < 2) {
    throw new Error("Unexpected Census response format: expected array with header and rows");
  }

  const rows = data.slice(1);
  const result: DistrictRow[] = [];

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 3) {
      continue;
    }

    const [nameRaw, populationRaw, stateRaw] = row;
    if (typeof nameRaw !== "string" || typeof populationRaw !== "string" || typeof stateRaw !== "string") {
      continue;
    }

    const stateFips = normalizeFips(stateRaw.trim());
    if (!Object.hasOwn(STATE_ABBR_BY_FIPS, stateFips)) {
      // Excludes territories and keeps 50 states + DC.
      continue;
    }

    const stateAbbreviation = getStateAbbreviationByFips(stateFips);
    result.push({
      geoid_compact: stateFips,
      name: nameRaw.trim(),
      state: stateAbbreviation,
      state_fips: stateFips,
      district_type: "statewide",
      population: parsePopulation(populationRaw.trim()),
    });
  }

  const expected = Object.keys(STATE_ABBR_BY_FIPS).length;
  const allFips = result.map((item) => item.state_fips);
  const distinctFips = new Set(allFips);
  if (allFips.length !== distinctFips.size) {
    const duplicates = [...new Set(allFips.filter((fips, index, all) => all.indexOf(fips) !== index))].sort();
    throw new Error(`Duplicate state rows returned by Census: ${duplicates.join(", ")}`);
  }
  if (distinctFips.size !== expected) {
    const missing = Object.keys(STATE_ABBR_BY_FIPS)
      .sort()
      .filter((fips) => !distinctFips.has(fips));
    throw new Error(`Expected ${expected} state rows (50 + DC), got ${distinctFips.size}. Missing: ${missing.join(", ")}`);
  }

  return result.sort((a, b) => a.state_fips.localeCompare(b.state_fips));
}

/**
 * Parses Census state legislative upper chamber rows into state_upper districts.
 * - Coverage is all 50 states + DC for 2024.
 * - District code is 3-char SLDU and may be alphanumeric (e.g., "00I").
 * - Uses compact geoid format: {state_fips}{SLDU}, e.g. "0200I", "06001", "11005".
 */
export function parseStateUpperDistrictRows(data: unknown): DistrictRow[] {
  if (!Array.isArray(data) || data.length < 2) {
    throw new Error("Unexpected Census response format: expected array with header and rows");
  }

  const rows = data.slice(1);
  const result: DistrictRow[] = [];

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 4) {
      continue;
    }

    const [nameRaw, populationRaw, stateRaw, districtRaw] = row;
    if (
      typeof nameRaw !== "string" ||
      typeof populationRaw !== "string" ||
      typeof stateRaw !== "string" ||
      typeof districtRaw !== "string"
    ) {
      continue;
    }

    const stateFips = normalizeFips(stateRaw.trim());
    if (!Object.hasOwn(STATE_ABBR_BY_FIPS, stateFips)) {
      continue;
    }

    const districtCode = districtRaw.trim().toUpperCase();
    if (!/^[0-9A-Z]{3}$/.test(districtCode)) {
      throw new Error(`Unexpected upper chamber district code from Census: ${districtRaw}`);
    }

    const population = parsePopulation(populationRaw.trim());
    result.push({
      geoid_compact: `${stateFips}${districtCode}`,
      name: nameRaw.trim(),
      state: getStateAbbreviationByFips(stateFips),
      state_fips: stateFips,
      district_type: "state_upper",
      population,
    });
  }

  const expectedStateSet = new Set(STATE_UPPER_STATE_FIPS_2024);
  const distinctFips = new Set(result.map((item) => item.state_fips));
  const missingStates = STATE_UPPER_STATE_FIPS_2024.filter((fips) => !distinctFips.has(fips));
  const unexpectedStates = [...distinctFips].filter((fips) => !expectedStateSet.has(fips)).sort();
  if (missingStates.length > 0 || unexpectedStates.length > 0) {
    throw new Error(
      `State upper district coverage mismatch for 2024: expected=${expectedStateSet.size}, actual=${distinctFips.size}, missing=${missingStates.length}${missingStates.length > 0 ? ` [${missingStates.join(", ")}]` : ""}, unexpected=${unexpectedStates.length}${unexpectedStates.length > 0 ? ` [${unexpectedStates.join(", ")}]` : ""}`
    );
  }

  const geoids = result.map((item) => item.geoid_compact);
  const distinctGeoids = new Set(geoids);
  if (geoids.length !== distinctGeoids.size) {
    const duplicates = [...new Set(geoids.filter((geoid, index, all) => all.indexOf(geoid) !== index))].sort();
    throw new Error(`Duplicate state upper district rows returned by Census: ${duplicates.join(", ")}`);
  }

  if (result.length !== EXPECTED_STATE_UPPER_ROWS_2024) {
    throw new Error(`Expected ${EXPECTED_STATE_UPPER_ROWS_2024} state upper district rows for 2024, got ${result.length}`);
  }

  const missingGeoids = STATE_UPPER_GEOIDS_2024.filter((geoid) => !distinctGeoids.has(geoid));
  const unexpectedGeoids = [...distinctGeoids].filter((geoid) => !STATE_UPPER_GEOIDS_2024_SET.has(geoid)).sort();
  if (missingGeoids.length > 0 || unexpectedGeoids.length > 0) {
    const missingPreview = missingGeoids.slice(0, 10).join(", ");
    const unexpectedPreview = unexpectedGeoids.slice(0, 10).join(", ");
    throw new Error(
      `State upper district GEOID set mismatch for 2024: missing=${missingGeoids.length}${missingPreview ? ` [${missingPreview}]` : ""}, unexpected=${unexpectedGeoids.length}${unexpectedPreview ? ` [${unexpectedPreview}]` : ""}`
    );
  }

  return result.sort((a, b) => a.geoid_compact.localeCompare(b.geoid_compact));
}

/**
 * Parses Census state legislative lower chamber rows into state_lower districts.
 * - Coverage is states with lower chambers for 2024 (excludes DC + Nebraska).
 * - District code is 3-char SLDL and may be alphanumeric/hyphen (e.g., "A-1").
 * - Uses compact geoid format: {state_fips}{SLDL}, e.g. "01001", "50A-1".
 */
export function parseStateLowerDistrictRows(data: unknown): DistrictRow[] {
  if (!Array.isArray(data) || data.length < 2) {
    throw new Error("Unexpected Census response format: expected array with header and rows");
  }

  const rows = data.slice(1);
  const result: DistrictRow[] = [];

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 4) {
      continue;
    }

    const [nameRaw, populationRaw, stateRaw, districtRaw] = row;
    if (
      typeof nameRaw !== "string" ||
      typeof populationRaw !== "string" ||
      typeof stateRaw !== "string" ||
      typeof districtRaw !== "string"
    ) {
      continue;
    }

    const stateFips = normalizeFips(stateRaw.trim());
    if (!Object.hasOwn(STATE_ABBR_BY_FIPS, stateFips)) {
      continue;
    }

    const districtCode = districtRaw.trim().toUpperCase();
    if (!/^[0-9A-Z-]{3}$/.test(districtCode)) {
      throw new Error(`Unexpected lower chamber district code from Census: ${districtRaw}`);
    }

    const population = parsePopulation(populationRaw.trim());
    result.push({
      geoid_compact: `${stateFips}${districtCode}`,
      name: nameRaw.trim(),
      state: getStateAbbreviationByFips(stateFips),
      state_fips: stateFips,
      district_type: "state_lower",
      population,
    });
  }

  const expectedStateSet = new Set(STATE_LOWER_STATE_FIPS_2024);
  const distinctFips = new Set(result.map((item) => item.state_fips));
  const missingStates = STATE_LOWER_STATE_FIPS_2024.filter((fips) => !distinctFips.has(fips));
  const unexpectedStates = [...distinctFips].filter((fips) => !expectedStateSet.has(fips)).sort();
  if (missingStates.length > 0 || unexpectedStates.length > 0) {
    throw new Error(
      `State lower district coverage mismatch for 2024: expected=${expectedStateSet.size}, actual=${distinctFips.size}, missing=${missingStates.length}${missingStates.length > 0 ? ` [${missingStates.join(", ")}]` : ""}, unexpected=${unexpectedStates.length}${unexpectedStates.length > 0 ? ` [${unexpectedStates.join(", ")}]` : ""}`
    );
  }

  const geoids = result.map((item) => item.geoid_compact);
  const distinctGeoids = new Set(geoids);
  if (geoids.length !== distinctGeoids.size) {
    const duplicates = [...new Set(geoids.filter((geoid, index, all) => all.indexOf(geoid) !== index))].sort();
    throw new Error(`Duplicate state lower district rows returned by Census: ${duplicates.join(", ")}`);
  }

  if (result.length !== EXPECTED_STATE_LOWER_ROWS_2024) {
    throw new Error(`Expected ${EXPECTED_STATE_LOWER_ROWS_2024} state lower district rows for 2024, got ${result.length}`);
  }

  const missingGeoids = STATE_LOWER_GEOIDS_2024.filter((geoid) => !distinctGeoids.has(geoid));
  const unexpectedGeoids = [...distinctGeoids].filter((geoid) => !STATE_LOWER_GEOIDS_2024_SET.has(geoid)).sort();
  if (missingGeoids.length > 0 || unexpectedGeoids.length > 0) {
    const missingPreview = missingGeoids.slice(0, 10).join(", ");
    const unexpectedPreview = unexpectedGeoids.slice(0, 10).join(", ");
    throw new Error(
      `State lower district GEOID set mismatch for 2024: missing=${missingGeoids.length}${missingPreview ? ` [${missingPreview}]` : ""}, unexpected=${unexpectedGeoids.length}${unexpectedPreview ? ` [${unexpectedPreview}]` : ""}`
    );
  }

  return result.sort((a, b) => a.geoid_compact.localeCompare(b.geoid_compact));
}

/**
 * Parses Census congressional district rows into us_house districts.
 * - Keeps 50 states + DC.
 * - Excludes "ZZ" not-defined aggregate rows.
 * - Uses compact geoid format: {state_fips}{district_code}, e.g. "0601", "0200", "1198".
 */
export function parseUsHouseDistrictRows(data: unknown): DistrictRow[] {
  if (!Array.isArray(data) || data.length < 2) {
    throw new Error("Unexpected Census response format: expected array with header and rows");
  }

  const rows = data.slice(1);
  const result: DistrictRow[] = [];

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 4) {
      continue;
    }

    const [nameRaw, populationRaw, stateRaw, districtRaw] = row;
    if (
      typeof nameRaw !== "string" ||
      typeof populationRaw !== "string" ||
      typeof stateRaw !== "string" ||
      typeof districtRaw !== "string"
    ) {
      continue;
    }

    const stateFips = normalizeFips(stateRaw.trim());
    if (!Object.hasOwn(STATE_ABBR_BY_FIPS, stateFips)) {
      // Excludes territories and keeps 50 states + DC.
      continue;
    }

    const districtCode = districtRaw.trim().toUpperCase();
    if (districtCode === "ZZ") {
      // Census aggregate: "Congressional Districts not defined".
      continue;
    }
    if (!/^\d{2}$/.test(districtCode)) {
      throw new Error(`Unexpected congressional district code from Census: ${districtRaw}`);
    }

    const population = parsePopulation(populationRaw.trim());
    if (population <= 0) {
      throw new Error(`Invalid congressional district population from Census: ${populationRaw}`);
    }

    const stateAbbreviation = getStateAbbreviationByFips(stateFips);
    result.push({
      geoid_compact: `${stateFips}${districtCode}`,
      // ACS 2024 labels every seat "(119th Congress)"; the states redrawn for
      // November 2026 are relabeled to the 120th so the loader does not undo
      // migration 282 on its next run.
      name: relabelUsHouseDistrictNameFor2026(stateFips, nameRaw.trim()),
      state: stateAbbreviation,
      state_fips: stateFips,
      district_type: "us_house",
      population,
    });
  }

  const expectedStates = Object.keys(STATE_ABBR_BY_FIPS).length;
  const distinctFips = new Set(result.map((item) => item.state_fips));
  if (distinctFips.size !== expectedStates) {
    const missing = Object.keys(STATE_ABBR_BY_FIPS)
      .sort()
      .filter((fips) => !distinctFips.has(fips));
    throw new Error(
      `Expected congressional district rows for ${expectedStates} states (50 + DC), got ${distinctFips.size}. Missing: ${missing.join(", ")}`
    );
  }

  const geoids = result.map((item) => item.geoid_compact);
  const distinctGeoids = new Set(geoids);
  if (geoids.length !== distinctGeoids.size) {
    const duplicates = [...new Set(geoids.filter((geoid, index, all) => all.indexOf(geoid) !== index))].sort();
    throw new Error(`Duplicate congressional district rows returned by Census: ${duplicates.join(", ")}`);
  }

  return result.sort((a, b) => a.geoid_compact.localeCompare(b.geoid_compact));
}

/**
 * Parses Census county rows into county districts.
 * - Keeps 50 states + DC.
 * - Excludes territories (e.g., Puerto Rico).
 * - Uses compact geoid format: {state_fips}{county_code}, e.g. "06037", "11001".
 */
export function parseCountyDistrictRows(data: unknown): DistrictRow[] {
  if (!Array.isArray(data) || data.length < 2) {
    throw new Error("Unexpected Census response format: expected array with header and rows");
  }

  const rows = data.slice(1);
  const result: DistrictRow[] = [];

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 4) {
      continue;
    }

    const [nameRaw, populationRaw, stateRaw, countyRaw] = row;
    if (
      typeof nameRaw !== "string" ||
      typeof populationRaw !== "string" ||
      typeof stateRaw !== "string" ||
      typeof countyRaw !== "string"
    ) {
      continue;
    }

    const stateFips = normalizeFips(stateRaw.trim());
    if (!Object.hasOwn(STATE_ABBR_BY_FIPS, stateFips)) {
      // Excludes territories and keeps 50 states + DC.
      continue;
    }

    const countyCode = countyRaw.trim();
    if (!/^\d{3}$/.test(countyCode)) {
      throw new Error(`Unexpected county code from Census: ${countyRaw}`);
    }

    const population = parsePopulation(populationRaw.trim());
    if (population <= 0) {
      throw new Error(`Invalid county population from Census: ${populationRaw}`);
    }

    result.push({
      geoid_compact: `${stateFips}${countyCode}`,
      name: nameRaw.trim(),
      state: getStateAbbreviationByFips(stateFips),
      state_fips: stateFips,
      district_type: "county",
      population,
    });
  }

  const expectedStates = Object.keys(STATE_ABBR_BY_FIPS).length;
  const distinctFips = new Set(result.map((item) => item.state_fips));
  if (distinctFips.size !== expectedStates) {
    const missing = Object.keys(STATE_ABBR_BY_FIPS)
      .sort()
      .filter((fips) => !distinctFips.has(fips));
    throw new Error(
      `Expected county rows for ${expectedStates} states (50 + DC), got ${distinctFips.size}. Missing: ${missing.join(", ")}`
    );
  }

  const geoids = result.map((item) => item.geoid_compact);
  const distinctGeoids = new Set(geoids);
  if (geoids.length !== distinctGeoids.size) {
    const duplicates = [...new Set(geoids.filter((geoid, index, all) => all.indexOf(geoid) !== index))].sort();
    throw new Error(`Duplicate county rows returned by Census: ${duplicates.join(", ")}`);
  }

  if (result.length !== EXPECTED_COUNTY_ROWS_50_PLUS_DC_2024) {
    throw new Error(
      `Expected ${EXPECTED_COUNTY_ROWS_50_PLUS_DC_2024} county rows for 2024 (50 + DC), got ${result.length}`
    );
  }

  const missingGeoids = COUNTY_GEOIDS_50_PLUS_DC_2024.filter((geoid) => !distinctGeoids.has(geoid));
  const unexpectedGeoids = [...distinctGeoids].filter((geoid) => !COUNTY_GEOIDS_50_PLUS_DC_2024_SET.has(geoid)).sort();
  if (missingGeoids.length > 0 || unexpectedGeoids.length > 0) {
    const missingPreview = missingGeoids.slice(0, 10).join(", ");
    const unexpectedPreview = unexpectedGeoids.slice(0, 10).join(", ");
    throw new Error(
      `County GEOID set mismatch for 2024 (50 + DC): missing=${missingGeoids.length}${missingPreview ? ` [${missingPreview}]` : ""}, unexpected=${unexpectedGeoids.length}${unexpectedPreview ? ` [${unexpectedPreview}]` : ""}`
    );
  }

  return result.sort((a, b) => a.geoid_compact.localeCompare(b.geoid_compact));
}

/**
 * Parses Census place rows into place districts.
 * - Keeps 50 states + DC.
 * - Excludes territories (e.g., Puerto Rico).
 * - Uses compact geoid format: {state_fips}{place_code}, e.g. "0600100", "1150000".
 * - Allows zero population rows present in official Census place payloads.
 */
export function parsePlaceDistrictRows(data: unknown): DistrictRow[] {
  if (!Array.isArray(data) || data.length < 2) {
    throw new Error("Unexpected Census response format: expected array with header and rows");
  }

  const rows = data.slice(1);
  const result: DistrictRow[] = [];

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 4) {
      continue;
    }

    const [nameRaw, populationRaw, stateRaw, placeRaw] = row;
    if (
      typeof nameRaw !== "string" ||
      typeof populationRaw !== "string" ||
      typeof stateRaw !== "string" ||
      typeof placeRaw !== "string"
    ) {
      continue;
    }

    const stateFips = normalizeFips(stateRaw.trim());
    if (!Object.hasOwn(STATE_ABBR_BY_FIPS, stateFips)) {
      // Excludes territories and keeps 50 states + DC.
      continue;
    }

    const placeCode = placeRaw.trim();
    if (!/^\d{5}$/.test(placeCode)) {
      throw new Error(`Unexpected place code from Census: ${placeRaw}`);
    }

    const population = parsePopulation(populationRaw.trim());
    result.push({
      geoid_compact: `${stateFips}${placeCode}`,
      name: nameRaw.trim(),
      state: getStateAbbreviationByFips(stateFips),
      state_fips: stateFips,
      district_type: "place",
      population,
    });
  }

  const expectedStates = Object.keys(STATE_ABBR_BY_FIPS).length;
  const distinctFips = new Set(result.map((item) => item.state_fips));
  if (distinctFips.size !== expectedStates) {
    const missing = Object.keys(STATE_ABBR_BY_FIPS)
      .sort()
      .filter((fips) => !distinctFips.has(fips));
    throw new Error(
      `Expected place rows for ${expectedStates} states (50 + DC), got ${distinctFips.size}. Missing: ${missing.join(", ")}`
    );
  }

  const geoids = result.map((item) => item.geoid_compact);
  const distinctGeoids = new Set(geoids);
  if (geoids.length !== distinctGeoids.size) {
    const duplicates = [...new Set(geoids.filter((geoid, index, all) => all.indexOf(geoid) !== index))].sort();
    throw new Error(`Duplicate place rows returned by Census: ${duplicates.join(", ")}`);
  }

  if (result.length !== EXPECTED_PLACE_ROWS_50_PLUS_DC_2024) {
    throw new Error(
      `Expected ${EXPECTED_PLACE_ROWS_50_PLUS_DC_2024} place rows for 2024 (50 + DC), got ${result.length}`
    );
  }

  const missingGeoids = PLACE_GEOIDS_50_PLUS_DC_2024.filter((geoid) => !distinctGeoids.has(geoid));
  const unexpectedGeoids = [...distinctGeoids].filter((geoid) => !PLACE_GEOIDS_50_PLUS_DC_2024_SET.has(geoid)).sort();
  if (missingGeoids.length > 0 || unexpectedGeoids.length > 0) {
    const missingPreview = missingGeoids.slice(0, 10).join(", ");
    const unexpectedPreview = unexpectedGeoids.slice(0, 10).join(", ");
    throw new Error(
      `Place GEOID set mismatch for 2024 (50 + DC): missing=${missingGeoids.length}${missingPreview ? ` [${missingPreview}]` : ""}, unexpected=${unexpectedGeoids.length}${unexpectedPreview ? ` [${unexpectedPreview}]` : ""}`
    );
  }

  return result.sort((a, b) => a.geoid_compact.localeCompare(b.geoid_compact));
}

/**
 * Parses Census unified school district rows into school_unified districts.
 * - Keeps 50 states + DC.
 * - Excludes territories (e.g., Puerto Rico).
 * - Excludes 99999 "Remainder of <state>" aggregate rows.
 * - Uses compact geoid format: {state_fips}{district_code}, e.g. "0100030", "1100030".
 * - Allows zero population rows present in official payloads.
 */
export function parseSchoolUnifiedDistrictRows(data: unknown): DistrictRow[] {
  if (!Array.isArray(data) || data.length < 2) {
    throw new Error("Unexpected Census response format: expected array with header and rows");
  }

  const rows = data.slice(1);
  const result: DistrictRow[] = [];

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 4) {
      continue;
    }

    const [nameRaw, populationRaw, stateRaw, districtRaw] = row;
    if (
      typeof nameRaw !== "string" ||
      typeof populationRaw !== "string" ||
      typeof stateRaw !== "string" ||
      typeof districtRaw !== "string"
    ) {
      continue;
    }

    const stateFips = normalizeFips(stateRaw.trim());
    if (!Object.hasOwn(STATE_ABBR_BY_FIPS, stateFips)) {
      // Excludes territories and keeps 50 states + DC.
      continue;
    }

    const districtCode = districtRaw.trim();
    if (!/^\d{5}$/.test(districtCode)) {
      throw new Error(`Unexpected unified school district code from Census: ${districtRaw}`);
    }
    if (districtCode === "99999") {
      // Census aggregate row: "Remainder of <state>".
      continue;
    }

    const population = parsePopulation(populationRaw.trim());
    result.push({
      geoid_compact: `${stateFips}${districtCode}`,
      name: nameRaw.trim(),
      state: getStateAbbreviationByFips(stateFips),
      state_fips: stateFips,
      district_type: "school_unified",
      population,
    });
  }

  const expectedStates = Object.keys(STATE_ABBR_BY_FIPS).length;
  const distinctFips = new Set(result.map((item) => item.state_fips));
  if (distinctFips.size !== expectedStates) {
    const missing = Object.keys(STATE_ABBR_BY_FIPS)
      .sort()
      .filter((fips) => !distinctFips.has(fips));
    throw new Error(
      `Expected unified school district rows for ${expectedStates} states (50 + DC), got ${distinctFips.size}. Missing: ${missing.join(", ")}`
    );
  }

  const geoids = result.map((item) => item.geoid_compact);
  const distinctGeoids = new Set(geoids);
  if (geoids.length !== distinctGeoids.size) {
    const duplicates = [...new Set(geoids.filter((geoid, index, all) => all.indexOf(geoid) !== index))].sort();
    throw new Error(`Duplicate unified school district rows returned by Census: ${duplicates.join(", ")}`);
  }

  if (result.length !== EXPECTED_SCHOOL_UNIFIED_ROWS_50_PLUS_DC_2024) {
    throw new Error(
      `Expected ${EXPECTED_SCHOOL_UNIFIED_ROWS_50_PLUS_DC_2024} unified school district rows for 2024 (50 + DC), got ${result.length}`
    );
  }

  const missingGeoids = SCHOOL_UNIFIED_GEOIDS_50_PLUS_DC_2024.filter((geoid) => !distinctGeoids.has(geoid));
  const unexpectedGeoids = [...distinctGeoids]
    .filter((geoid) => !SCHOOL_UNIFIED_GEOIDS_50_PLUS_DC_2024_SET.has(geoid))
    .sort();
  if (missingGeoids.length > 0 || unexpectedGeoids.length > 0) {
    const missingPreview = missingGeoids.slice(0, 10).join(", ");
    const unexpectedPreview = unexpectedGeoids.slice(0, 10).join(", ");
    throw new Error(
      `Unified school district GEOID set mismatch for 2024 (50 + DC): missing=${missingGeoids.length}${missingPreview ? ` [${missingPreview}]` : ""}, unexpected=${unexpectedGeoids.length}${unexpectedPreview ? ` [${unexpectedPreview}]` : ""}`
    );
  }

  return result.sort((a, b) => a.geoid_compact.localeCompare(b.geoid_compact));
}

/**
 * Parses Census secondary school district rows into school_secondary districts.
 * - Keeps only supported states in this endpoint's 2024 coverage.
 * - Excludes territories.
 * - Excludes 99999 "Remainder of <state>" aggregate rows.
 * - Uses compact geoid format: {state_fips}{district_code}, e.g. "0602630", "1704170".
 * - Allows zero population rows present in official payloads.
 */
export function parseSchoolSecondaryDistrictRows(data: unknown): DistrictRow[] {
  if (!Array.isArray(data) || data.length < 2) {
    throw new Error("Unexpected Census response format: expected array with header and rows");
  }

  const rows = data.slice(1);
  const result: DistrictRow[] = [];

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 4) {
      continue;
    }

    const [nameRaw, populationRaw, stateRaw, districtRaw] = row;
    if (
      typeof nameRaw !== "string" ||
      typeof populationRaw !== "string" ||
      typeof stateRaw !== "string" ||
      typeof districtRaw !== "string"
    ) {
      continue;
    }

    const stateFips = normalizeFips(stateRaw.trim());
    if (!Object.hasOwn(STATE_ABBR_BY_FIPS, stateFips)) {
      // Excludes territories.
      continue;
    }

    const districtCode = districtRaw.trim();
    if (!/^\d{5}$/.test(districtCode)) {
      throw new Error(`Unexpected secondary school district code from Census: ${districtRaw}`);
    }
    if (districtCode === "99999") {
      // Census aggregate row: "Remainder of <state>".
      continue;
    }

    const population = parsePopulation(populationRaw.trim());
    result.push({
      geoid_compact: `${stateFips}${districtCode}`,
      name: nameRaw.trim(),
      state: getStateAbbreviationByFips(stateFips),
      state_fips: stateFips,
      district_type: "school_secondary",
      population,
    });
  }

  const expectedStateSet = new Set(SCHOOL_SECONDARY_STATE_FIPS_2024);
  const distinctFips = new Set(result.map((item) => item.state_fips));
  const missingStates = SCHOOL_SECONDARY_STATE_FIPS_2024.filter((fips) => !distinctFips.has(fips));
  const unexpectedStates = [...distinctFips].filter((fips) => !expectedStateSet.has(fips)).sort();
  if (missingStates.length > 0 || unexpectedStates.length > 0) {
    throw new Error(
      `Secondary school district state coverage mismatch for 2024: expected=${expectedStateSet.size}, actual=${distinctFips.size}, missing=${missingStates.length}${missingStates.length > 0 ? ` [${missingStates.join(", ")}]` : ""}, unexpected=${unexpectedStates.length}${unexpectedStates.length > 0 ? ` [${unexpectedStates.join(", ")}]` : ""}`
    );
  }

  const geoids = result.map((item) => item.geoid_compact);
  const distinctGeoids = new Set(geoids);
  if (geoids.length !== distinctGeoids.size) {
    const duplicates = [...new Set(geoids.filter((geoid, index, all) => all.indexOf(geoid) !== index))].sort();
    throw new Error(`Duplicate secondary school district rows returned by Census: ${duplicates.join(", ")}`);
  }

  if (result.length !== EXPECTED_SCHOOL_SECONDARY_ROWS_2024) {
    throw new Error(
      `Expected ${EXPECTED_SCHOOL_SECONDARY_ROWS_2024} secondary school district rows for 2024, got ${result.length}`
    );
  }

  const missingGeoids = SCHOOL_SECONDARY_GEOIDS_2024.filter((geoid) => !distinctGeoids.has(geoid));
  const unexpectedGeoids = [...distinctGeoids].filter((geoid) => !SCHOOL_SECONDARY_GEOIDS_2024_SET.has(geoid)).sort();
  if (missingGeoids.length > 0 || unexpectedGeoids.length > 0) {
    const missingPreview = missingGeoids.slice(0, 10).join(", ");
    const unexpectedPreview = unexpectedGeoids.slice(0, 10).join(", ");
    throw new Error(
      `Secondary school district GEOID set mismatch for 2024: missing=${missingGeoids.length}${missingPreview ? ` [${missingPreview}]` : ""}, unexpected=${unexpectedGeoids.length}${unexpectedPreview ? ` [${unexpectedPreview}]` : ""}`
    );
  }

  return result.sort((a, b) => a.geoid_compact.localeCompare(b.geoid_compact));
}

/**
 * Parses Census elementary school district rows into school_elementary districts.
 * - Keeps only supported states in this endpoint's 2024 coverage.
 * - Excludes territories.
 * - Excludes 99999 "Remainder of <state>" aggregate rows.
 * - Uses compact geoid format: {state_fips}{district_code}, e.g. "0602610", "0406300".
 */
export function parseSchoolElementaryDistrictRows(data: unknown): DistrictRow[] {
  if (!Array.isArray(data) || data.length < 2) {
    throw new Error("Unexpected Census response format: expected array with header and rows");
  }

  const rows = data.slice(1);
  const result: DistrictRow[] = [];

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 4) {
      continue;
    }

    const [nameRaw, populationRaw, stateRaw, districtRaw] = row;
    if (
      typeof nameRaw !== "string" ||
      typeof populationRaw !== "string" ||
      typeof stateRaw !== "string" ||
      typeof districtRaw !== "string"
    ) {
      continue;
    }

    const stateFips = normalizeFips(stateRaw.trim());
    if (!Object.hasOwn(STATE_ABBR_BY_FIPS, stateFips)) {
      // Excludes territories.
      continue;
    }

    const districtCode = districtRaw.trim();
    if (!/^\d{5}$/.test(districtCode)) {
      throw new Error(`Unexpected elementary school district code from Census: ${districtRaw}`);
    }
    if (districtCode === "99999") {
      // Census aggregate row: "Remainder of <state>".
      continue;
    }

    const population = parsePopulation(populationRaw.trim());
    result.push({
      geoid_compact: `${stateFips}${districtCode}`,
      name: nameRaw.trim(),
      state: getStateAbbreviationByFips(stateFips),
      state_fips: stateFips,
      district_type: "school_elementary",
      population,
    });
  }

  const expectedStateSet = new Set(SCHOOL_ELEMENTARY_STATE_FIPS_2024);
  const distinctFips = new Set(result.map((item) => item.state_fips));
  const missingStates = SCHOOL_ELEMENTARY_STATE_FIPS_2024.filter((fips) => !distinctFips.has(fips));
  const unexpectedStates = [...distinctFips].filter((fips) => !expectedStateSet.has(fips)).sort();
  if (missingStates.length > 0 || unexpectedStates.length > 0) {
    throw new Error(
      `Elementary school district state coverage mismatch for 2024: expected=${expectedStateSet.size}, actual=${distinctFips.size}, missing=${missingStates.length}${missingStates.length > 0 ? ` [${missingStates.join(", ")}]` : ""}, unexpected=${unexpectedStates.length}${unexpectedStates.length > 0 ? ` [${unexpectedStates.join(", ")}]` : ""}`
    );
  }

  const geoids = result.map((item) => item.geoid_compact);
  const distinctGeoids = new Set(geoids);
  if (geoids.length !== distinctGeoids.size) {
    const duplicates = [...new Set(geoids.filter((geoid, index, all) => all.indexOf(geoid) !== index))].sort();
    throw new Error(`Duplicate elementary school district rows returned by Census: ${duplicates.join(", ")}`);
  }

  if (result.length !== EXPECTED_SCHOOL_ELEMENTARY_ROWS_2024) {
    throw new Error(
      `Expected ${EXPECTED_SCHOOL_ELEMENTARY_ROWS_2024} elementary school district rows for 2024, got ${result.length}`
    );
  }

  const missingGeoids = SCHOOL_ELEMENTARY_GEOIDS_2024.filter((geoid) => !distinctGeoids.has(geoid));
  const unexpectedGeoids = [...distinctGeoids]
    .filter((geoid) => !SCHOOL_ELEMENTARY_GEOIDS_2024_SET.has(geoid))
    .sort();
  if (missingGeoids.length > 0 || unexpectedGeoids.length > 0) {
    const missingPreview = missingGeoids.slice(0, 10).join(", ");
    const unexpectedPreview = unexpectedGeoids.slice(0, 10).join(", ");
    throw new Error(
      `Elementary school district GEOID set mismatch for 2024: missing=${missingGeoids.length}${missingPreview ? ` [${missingPreview}]` : ""}, unexpected=${unexpectedGeoids.length}${unexpectedPreview ? ` [${unexpectedPreview}]` : ""}`
    );
  }

  return result.sort((a, b) => a.geoid_compact.localeCompare(b.geoid_compact));
}

async function fetchCensusRows(url: string, censusApiKeys: readonly string[]): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CENSUS_FETCH_TIMEOUT_MS);

  try {
    return await fetchCensusJsonWithKeyRotation(url, censusApiKeys, controller.signal);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Census API request timed out after ${CENSUS_FETCH_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchStateDistrictRows(censusApiKeys: readonly string[]): Promise<DistrictRow[]> {
  const data = await fetchCensusRows(CENSUS_STATES_DISTRICTS_URL, censusApiKeys);
  return parseStateDistrictRows(data);
}

async function fetchStateUpperDistrictRows(censusApiKeys: readonly string[]): Promise<DistrictRow[]> {
  const combinedRows: unknown[] = [["NAME", "B01001_001E", "state", "state legislative district (upper chamber)"]];

  for (const stateFips of STATE_UPPER_STATE_FIPS_2024) {
    const stateData = await fetchCensusRows(buildStateUpperDistrictsUrl(stateFips), censusApiKeys);
    if (!Array.isArray(stateData) || stateData.length < 2) {
      throw new Error(`Unexpected Census response format for upper chamber state ${stateFips}`);
    }

    combinedRows.push(...stateData.slice(1));
  }

  return parseStateUpperDistrictRows(combinedRows);
}

async function fetchStateLowerDistrictRows(censusApiKeys: readonly string[]): Promise<DistrictRow[]> {
  const combinedRows: unknown[] = [["NAME", "B01001_001E", "state", "state legislative district (lower chamber)"]];

  for (const stateFips of STATE_LOWER_STATE_FIPS_2024) {
    const stateData = await fetchCensusRows(buildStateLowerDistrictsUrl(stateFips), censusApiKeys);
    if (!Array.isArray(stateData) || stateData.length < 2) {
      throw new Error(`Unexpected Census response format for lower chamber state ${stateFips}`);
    }

    combinedRows.push(...stateData.slice(1));
  }

  return parseStateLowerDistrictRows(combinedRows);
}

async function fetchUsHouseDistrictRows(censusApiKeys: readonly string[]): Promise<DistrictRow[]> {
  const data = await fetchCensusRows(CENSUS_US_HOUSE_DISTRICTS_URL, censusApiKeys);
  return parseUsHouseDistrictRows(data);
}

async function fetchCountyDistrictRows(censusApiKeys: readonly string[]): Promise<DistrictRow[]> {
  const data = await fetchCensusRows(CENSUS_COUNTY_DISTRICTS_URL, censusApiKeys);
  return parseCountyDistrictRows(data);
}

async function fetchPlaceDistrictRows(censusApiKeys: readonly string[]): Promise<DistrictRow[]> {
  const data = await fetchCensusRows(CENSUS_PLACE_DISTRICTS_URL, censusApiKeys);
  return parsePlaceDistrictRows(data);
}

async function fetchSchoolUnifiedDistrictRows(censusApiKeys: readonly string[]): Promise<DistrictRow[]> {
  const data = await fetchCensusRows(CENSUS_SCHOOL_UNIFIED_DISTRICTS_URL, censusApiKeys);
  return parseSchoolUnifiedDistrictRows(data);
}

async function fetchSchoolSecondaryDistrictRows(censusApiKeys: readonly string[]): Promise<DistrictRow[]> {
  const data = await fetchCensusRows(CENSUS_SCHOOL_SECONDARY_DISTRICTS_URL, censusApiKeys);
  return parseSchoolSecondaryDistrictRows(data);
}

async function fetchSchoolElementaryDistrictRows(censusApiKeys: readonly string[]): Promise<DistrictRow[]> {
  const data = await fetchCensusRows(CENSUS_SCHOOL_ELEMENTARY_DISTRICTS_URL, censusApiKeys);
  return parseSchoolElementaryDistrictRows(data);
}

async function detectDistrictCodeColumn(pool: Pool): Promise<DistrictCodeColumnName> {
  const result = await pool.query<{ column_name: string }>(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'districts'
        AND column_name IN ('geoid_compact', 'fips_code')
    `
  );

  const columns = new Set(result.rows.map((row) => row.column_name));
  if (columns.has("geoid_compact")) {
    return "geoid_compact";
  }
  if (columns.has("fips_code")) {
    return "fips_code";
  }

  throw new Error("districts table is missing both geoid_compact and fips_code columns");
}

async function loadExistingDistrict(
  client: PoolClient,
  codeColumn: DistrictCodeColumnName,
  districtType: string,
  geoidCompact: string
): Promise<ExistingDistrictRecord | null> {
  const result = await client.query<ExistingDistrictRecord>(
    `
      SELECT name, state, state_fips, population
      FROM public.districts
      WHERE district_type = $1
        AND ${codeColumn} = $2
      LIMIT 1
    `,
    [districtType, geoidCompact]
  );

  return result.rows[0] ?? null;
}

function isSameDistrict(existing: ExistingDistrictRecord, next: DistrictRow): boolean {
  return (
    existing.name === next.name &&
    existing.state === next.state &&
    existing.state_fips === next.state_fips &&
    existing.population === next.population
  );
}

async function insertDistrict(client: PoolClient, codeColumn: DistrictCodeColumnName, row: DistrictRow): Promise<void> {
  await client.query(
    `
      INSERT INTO public.districts
        (${codeColumn}, name, state, state_fips, district_type, population, last_researched)
      VALUES
        ($1, $2, $3, $4, $5, $6, now())
    `,
    [row.geoid_compact, row.name, row.state, row.state_fips, row.district_type, row.population]
  );
}

async function updateDistrict(client: PoolClient, codeColumn: DistrictCodeColumnName, row: DistrictRow): Promise<void> {
  await client.query(
    `
      UPDATE public.districts
      SET name = $3,
          state = $4,
          state_fips = $5,
          population = $6,
          last_researched = now()
      WHERE district_type = $1
        AND ${codeColumn} = $2
    `,
    [row.district_type, row.geoid_compact, row.name, row.state, row.state_fips, row.population]
  );
}

async function deleteDistrict(
  client: PoolClient,
  codeColumn: DistrictCodeColumnName,
  districtType: DistrictRow["district_type"],
  geoidCompact: string
): Promise<boolean> {
  const result = await client.query(
    `
      DELETE FROM public.districts AS d
      WHERE d.district_type = $1
        AND d.${codeColumn} = $2
        AND NOT EXISTS (
          SELECT 1
          FROM public.elections AS e
          WHERE e.district_id = d.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.ballot_measures AS p
          WHERE p.district_id = d.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.user_districts AS ud
          WHERE ud.district_id = d.id
            AND ud.district_type = d.district_type
        )
    `,
    [districtType, geoidCompact]
  );

  return (result.rowCount ?? 0) > 0;
}

/**
 * Recomputes representation_power_score for every district row using the
 * state-anchored fixed-ruler model (docs/plans/vote-power-state-anchored-representation.md):
 *   score_i = 50 + 50 * ln(state_pop / pop_i) / ln(K),  clamped to [50, 100]
 * where state_pop is the population of the district's own state (its
 * 'statewide' row) and K = REPRESENTATION_RULER_K.
 *
 * Why this model:
 * - Answers "how much stronger is one vote here than a statewide vote?" —
 *   the comparison users actually make between races on one ballot.
 * - A statewide race is the 50 ("average") baseline; smaller districts score
 *   higher; representation alone can never grade below average.
 * - K is a fixed constant, not a DB extreme, so scores never drift when new
 *   (tiny) districts are imported later.
 * - The 50 floor also absorbs data errors where a district's population
 *   exceeds its state's.
 *
 * Districts whose state has no positive-population statewide row, or with no
 * positive population themselves, score NULL (representation "unknown").
 *
 * Exported for the standalone districts:recompute-representation script,
 * which reruns exactly this statement without a Census reload (model change
 * rollouts, prod promotion). Returns the number of rows whose score changed.
 */
export async function recomputeRepresentationPowerScores(client: PoolClient): Promise<number> {
  const result = await client.query(
    `
      WITH state_populations AS (
        -- One deterministic anchor per state: the schema's uniqueness key is
        -- (district_type, geoid_compact), so nothing structurally forbids two
        -- statewide rows for one state_fips. MAX() collapses any such
        -- duplicate to one deterministic population; ballotLookup's
        -- explanation subselect applies the same largest-population rule.
        SELECT state_fips, MAX(population::numeric) AS population
        FROM public.districts
        WHERE district_type = 'statewide'
          AND population IS NOT NULL
          AND population > 0
        GROUP BY state_fips
      ),
      scored AS (
        SELECT
          d.id,
          CASE
            WHEN d.population IS NULL OR d.population <= 0 THEN NULL::numeric
            WHEN sp.population IS NULL THEN NULL::numeric
            ELSE ROUND(
              LEAST(
                100::numeric,
                GREATEST(
                  50::numeric,
                  50::numeric
                    + 50::numeric * LN(sp.population / d.population::numeric)
                    / LN($1::numeric)
                )
              ),
              2
            )
          END AS representation_power_score
        FROM public.districts AS d
        LEFT JOIN state_populations AS sp ON sp.state_fips = d.state_fips
      )
      UPDATE public.districts
      SET representation_power_score = scored.representation_power_score
      FROM scored
      WHERE public.districts.id = scored.id
        AND public.districts.representation_power_score IS DISTINCT FROM scored.representation_power_score
    `,
    [REPRESENTATION_RULER_K]
  );
  return result.rowCount ?? 0;
}

/**
 * Loads districts from Census into the districts table.
 * Supported types:
 * - state -> statewide rows (2024 state:* endpoint)
 * - state_upper -> state legislative upper chamber rows (2024 ...upper+chamber... endpoint, one call per state)
 * - state_lower -> state legislative lower chamber rows (2024 ...lower+chamber... endpoint, one call per state with lower chamber)
 * - us_house -> congressional district rows (2024 congressional+district:* endpoint)
 * - county -> county rows (2024 county:* endpoint)
 * - place -> place rows (2024 place:* endpoint)
 * - school_unified -> unified school district rows (2024 school+district+(unified):* endpoint)
 * - school_secondary -> secondary school district rows (2024 school+district+(secondary):* endpoint)
 * - school_elementary -> elementary school district rows (2024 school+district+(elementary):* endpoint)
 */
export async function runDistrictsLoader(options: DistrictLoadOptions): Promise<DistrictLoadSummary> {
  loadProjectEnv();
  const censusApiKeys = readCensusApiKeysFromEnv(process.env);
  if (censusApiKeys.length === 0) {
    throw new Error("At least one Census API key is required (CENSUS_API_KEY_1, _2, or _3).");
  }

  const dryRun = Boolean(options.dryRun);
  let sourceUrl: string;
  let rows: DistrictRow[];
  if (options.type === "state") {
    sourceUrl = CENSUS_STATES_DISTRICTS_URL;
    rows = await fetchStateDistrictRows(censusApiKeys);
  } else if (options.type === "state_upper") {
    sourceUrl = CENSUS_STATE_UPPER_DISTRICTS_URL_PATTERN;
    rows = await fetchStateUpperDistrictRows(censusApiKeys);
  } else if (options.type === "state_lower") {
    sourceUrl = CENSUS_STATE_LOWER_DISTRICTS_URL_PATTERN;
    rows = await fetchStateLowerDistrictRows(censusApiKeys);
  } else if (options.type === "us_house") {
    sourceUrl = CENSUS_US_HOUSE_DISTRICTS_URL;
    rows = await fetchUsHouseDistrictRows(censusApiKeys);
  } else if (options.type === "county") {
    sourceUrl = CENSUS_COUNTY_DISTRICTS_URL;
    rows = await fetchCountyDistrictRows(censusApiKeys);
  } else if (options.type === "place") {
    sourceUrl = CENSUS_PLACE_DISTRICTS_URL;
    rows = await fetchPlaceDistrictRows(censusApiKeys);
  } else if (options.type === "school_unified") {
    sourceUrl = CENSUS_SCHOOL_UNIFIED_DISTRICTS_URL;
    rows = await fetchSchoolUnifiedDistrictRows(censusApiKeys);
  } else if (options.type === "school_secondary") {
    sourceUrl = CENSUS_SCHOOL_SECONDARY_DISTRICTS_URL;
    rows = await fetchSchoolSecondaryDistrictRows(censusApiKeys);
  } else if (options.type === "school_elementary") {
    sourceUrl = CENSUS_SCHOOL_ELEMENTARY_DISTRICTS_URL;
    rows = await fetchSchoolElementaryDistrictRows(censusApiKeys);
  } else {
    throw new Error(`Unsupported districts load type: ${options.type}`);
  }

  if (dryRun) {
    return {
      type: options.type,
      sourceUrl,
      totalCandidates: rows.length,
      inserted: 0,
      updated: 0,
      skipped: rows.length,
      dryRun: true,
    };
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim().length === 0) {
    throw new Error("DATABASE_URL is required for districts loader");
  }
  const pool = new Pool({ connectionString: databaseUrl });

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  try {
    const codeColumn = await detectDistrictCodeColumn(pool);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`districts_loader:${options.type}`]);
      for (const row of rows) {
        if (row.population === 0) {
          const deleted = await deleteDistrict(client, codeColumn, row.district_type, row.geoid_compact);
          if (deleted) {
            updated += 1;
          } else {
            skipped += 1;
          }
          continue;
        }

        const existing = await loadExistingDistrict(client, codeColumn, row.district_type, row.geoid_compact);
        if (!existing) {
          await insertDistrict(client, codeColumn, row);
          inserted += 1;
          continue;
        }

        if (isSameDistrict(existing, row)) {
          skipped += 1;
          continue;
        }

        await updateDistrict(client, codeColumn, row);
        updated += 1;
      }

      await recomputeRepresentationPowerScores(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }

  return {
    type: options.type,
    sourceUrl,
    totalCandidates: rows.length,
    inserted,
    updated,
    skipped,
    dryRun: false,
  };
}
