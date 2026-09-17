// Generates the newsroom-embed pilot manifest the frontend ships with.
//
// Input:  backend/manual-research/major-cities/embed-pilot.json — the hand-kept
//         list of reviewed cities (slug, name, state, election date, review
//         date, official source URL, enabled flag), reviewed states (the same
//         fields keyed by the two-letter state code, resolving to the
//         statewide district so the box shows only statewide races), plus the
//         allowed publisher codes.
// Output: frontend/src/data/embedPilotCities.ts — the same cities with their
//         district UUIDs resolved from the database, so the embed page can
//         call the ballot lookup without touching the city map at runtime.
//
// The city map (city-districts.json) stores Census codes, not database ids;
// this is the one place that resolution happens. A city whose districts are
// not all in the database, or that needs more district ids than the public
// ballot endpoint accepts, fails the build rather than shipping a partial
// list. Run `npm run embed:pilot-manifest` in backend/ and commit the output.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool } from "pg";

import { MAX_BALLOT_DISTRICT_IDS } from "../api/apiValidation.js";
import { loadProjectEnv } from "../config/env.js";
import { readStrictFlagValue } from "../utils/cliFlags.js";
import { cityKey, loadDbDistricts, readMap, type MappedDistrict } from "./majorCityCoverage.js";
import { assertKnownCliFlags, type CliFlagSpec } from "./manualCliFlags.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(HERE, "../../manual-research/major-cities/embed-pilot.json");
const OUTPUT_PATH = path.resolve(HERE, "../../../frontend/src/data/embedPilotCities.ts");

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SLUG_LENGTH = 48;

type PilotCityInput = {
  slug: string;
  name: string;
  state: string;
  election_date: string;
  review_date: string;
  official_source_url: string;
  enabled: boolean;
};

type PilotStateInput = Omit<PilotCityInput, "slug" | "name">;

type PilotConfig = {
  publishers: string[];
  cities: PilotCityInput[];
  states: PilotStateInput[];
};

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

export type PilotCityOutput = PilotCityInput & {
  kind: "city" | "state";
  district_ids: string[];
};

function fail(message: string): never {
  throw new Error(message);
}

export function readConfig(filePath: string): PilotConfig {
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail(`${filePath}: top level must be an object`);
  }
  const { publishers, cities } = parsed as Record<string, unknown>;
  if (!Array.isArray(publishers) || !publishers.every((p) => typeof p === "string")) {
    fail(`${filePath}: "publishers" must be an array of strings`);
  }
  if (!Array.isArray(cities)) {
    fail(`${filePath}: "cities" must be an array`);
  }
  const rawStates = (parsed as Record<string, unknown>).states ?? [];
  if (!Array.isArray(rawStates)) {
    fail(`${filePath}: "states" must be an array when present`);
  }
  for (const code of publishers as string[]) {
    if (!SLUG.test(code) || code.length > MAX_SLUG_LENGTH) {
      fail(`${filePath}: publisher code "${code}" must be lowercase letters, digits and single hyphens`);
    }
  }
  const seen = new Set<string>();
  const parsedCities = (cities as unknown[]).map((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      fail(`${filePath}: cities[${index}] must be an object`);
    }
    const c = raw as Record<string, unknown>;
    const str = (key: string): string => {
      const value = c[key];
      if (typeof value !== "string" || value.trim().length === 0) {
        fail(`${filePath}: cities[${index}].${key} must be a non-empty string`);
      }
      return value.trim();
    };
    const slug = str("slug");
    if (!SLUG.test(slug) || slug.length > MAX_SLUG_LENGTH) {
      fail(`${filePath}: cities[${index}].slug "${slug}" must be lowercase letters, digits and single hyphens`);
    }
    if (seen.has(slug)) {
      fail(`${filePath}: duplicate slug "${slug}"`);
    }
    seen.add(slug);
    const electionDate = str("election_date");
    const reviewDate = str("review_date");
    if (!ISO_DATE.test(electionDate) || !ISO_DATE.test(reviewDate)) {
      fail(`${filePath}: cities[${index}] dates must be YYYY-MM-DD`);
    }
    const url = str("official_source_url");
    if (!url.startsWith("https://")) {
      fail(`${filePath}: cities[${index}].official_source_url must start with https://`);
    }
    if (typeof c.enabled !== "boolean") {
      fail(`${filePath}: cities[${index}].enabled must be true or false`);
    }
    return {
      slug,
      name: str("name"),
      state: str("state").toUpperCase(),
      election_date: electionDate,
      review_date: reviewDate,
      official_source_url: url,
      enabled: c.enabled,
    };
  });
  const parsedStates = (rawStates as unknown[]).map((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      fail(`${filePath}: states[${index}] must be an object`);
    }
    const c = raw as Record<string, unknown>;
    const str = (key: string): string => {
      const value = c[key];
      if (typeof value !== "string" || value.trim().length === 0) {
        fail(`${filePath}: states[${index}].${key} must be a non-empty string`);
      }
      return value.trim();
    };
    const state = str("state").toUpperCase();
    if (!STATE_NAMES[state]) {
      fail(`${filePath}: states[${index}].state "${state}" is not a two-letter US state code`);
    }
    const slug = state.toLowerCase();
    if (seen.has(slug)) {
      fail(`${filePath}: duplicate code "${slug}" (a city slug and a state code collide)`);
    }
    seen.add(slug);
    const electionDate = str("election_date");
    const reviewDate = str("review_date");
    if (!ISO_DATE.test(electionDate) || !ISO_DATE.test(reviewDate)) {
      fail(`${filePath}: states[${index}] dates must be YYYY-MM-DD`);
    }
    const url = str("official_source_url");
    if (!url.startsWith("https://")) {
      fail(`${filePath}: states[${index}].official_source_url must start with https://`);
    }
    if (typeof c.enabled !== "boolean") {
      fail(`${filePath}: states[${index}].enabled must be true or false`);
    }
    return { state, election_date: electionDate, review_date: reviewDate, official_source_url: url, enabled: c.enabled };
  });
  return { publishers: [...(publishers as string[])].sort(), cities: parsedCities, states: parsedStates };
}

/** A state entry resolves to the one statewide district row, so the box lists
 * governor, U.S. Senate, other statewide offices, and state measures only. */
async function resolveState(pool: Pool, input: PilotStateInput): Promise<PilotCityOutput> {
  const result = await pool.query<{ id: string }>(
    `SELECT id::text AS id FROM public.districts WHERE district_type = 'statewide' AND state = $1`,
    [input.state]
  );
  if (result.rows.length !== 1) {
    fail(`${input.state.toLowerCase()}: expected exactly one statewide district row for ${input.state}, found ${result.rows.length}`);
  }
  return {
    slug: input.state.toLowerCase(),
    name: STATE_NAMES[input.state]!,
    kind: "state",
    ...input,
    district_ids: [result.rows[0]!.id],
  };
}

async function resolveCity(
  pool: Pool,
  input: PilotCityInput,
  wanted: MappedDistrict[]
): Promise<PilotCityOutput> {
  const dbDistricts = await loadDbDistricts(pool, wanted);
  const missing = wanted.filter((d) => !dbDistricts.has(`${d.district_type}:${d.geoid_compact}`));
  if (missing.length > 0) {
    const list = missing.map((d) => `${d.district_type} ${d.geoid_compact} (${d.name})`).join(", ");
    fail(`${input.slug}: ${missing.length} mapped district(s) are not in the database: ${list}`);
  }
  // Stable order (type, then code) so regenerating produces no spurious diff.
  const ordered = [...wanted].sort(
    (a, b) => a.district_type.localeCompare(b.district_type) || a.geoid_compact.localeCompare(b.geoid_compact)
  );
  const districtIds = ordered.map((d) => dbDistricts.get(`${d.district_type}:${d.geoid_compact}`)!.id);
  if (districtIds.length > MAX_BALLOT_DISTRICT_IDS) {
    fail(
      `${input.slug}: ${districtIds.length} districts exceed the ballot endpoint limit of ${MAX_BALLOT_DISTRICT_IDS}; not a pilot city`
    );
  }
  return { ...input, kind: "city", district_ids: districtIds };
}

export function renderManifest(publishers: string[], cities: PilotCityOutput[]): string {
  const byslug: Record<string, PilotCityOutput> = {};
  for (const city of cities) {
    byslug[city.slug] = city;
  }
  return [
    "// GENERATED by `npm run embed:pilot-manifest` in backend/ — do not edit by hand.",
    "// Source: backend/manual-research/major-cities/embed-pilot.json plus the",
    "// district ids resolved from the database at generation time.",
    "",
    "export type EmbedPilotCity = {",
    "  slug: string;",
    "  name: string;",
    "  state: string;",
    "  election_date: string;",
    "  review_date: string;",
    "  official_source_url: string;",
    "  enabled: boolean;",
    "  /** city = every race that touches the city; state = statewide races only. */",
    "  kind: \"city\" | \"state\";",
    "  district_ids: string[];",
    "};",
    "",
    `export const EMBED_PILOT_PUBLISHERS: readonly string[] = ${JSON.stringify(publishers, null, 2)};`,
    "",
    `export const EMBED_PILOT_CITIES: Readonly<Record<string, EmbedPilotCity>> = ${JSON.stringify(byslug, null, 2)};`,
    "",
  ].join("\n");
}

const FLAG_SPECS: CliFlagSpec[] = [
  { name: "--config", value: "both" },
  { name: "--min-share", value: "both" },
];

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  assertKnownCliFlags("embed:pilot-manifest", argv, FLAG_SPECS);
  const configPath = readStrictFlagValue(argv, "--config") ?? CONFIG_PATH;
  const rawShare = readStrictFlagValue(argv, "--min-share");
  const minShare = rawShare === null ? 0 : Number.parseFloat(rawShare);
  if (!Number.isFinite(minShare) || minShare < 0 || minShare > 1) {
    fail(`--min-share must be between 0 and 1, got: ${rawShare}`);
  }

  const config = readConfig(configPath);
  const map = readMap();
  loadProjectEnv();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    fail("Missing required env var: DATABASE_URL");
  }
  const pool = new Pool({ connectionString });
  const cities: PilotCityOutput[] = [];
  try {
    for (const input of config.cities) {
      const entry = map.get(cityKey(input));
      if (!entry) {
        fail(`${input.slug}: ${cityKey(input)} is not in city-districts.json; run manual:city-coverage:build-map first`);
      }
      const wanted = entry.districts.filter((d) => d.city_share >= minShare);
      cities.push(await resolveCity(pool, input, wanted));
    }
    for (const input of config.states) {
      cities.push(await resolveState(pool, input));
    }
  } finally {
    await pool.end();
  }

  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, renderManifest(config.publishers, cities));
  console.log(`wrote ${path.relative(process.cwd(), OUTPUT_PATH)}: ${cities.length} entries, ${config.publishers.length} publishers`);
  for (const city of cities) {
    console.log(`  ${city.slug} (${city.kind}): ${city.district_ids.length} districts, enabled=${city.enabled}`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("embed pilot manifest failed:", message);
    process.exitCode = 1;
  });
}
