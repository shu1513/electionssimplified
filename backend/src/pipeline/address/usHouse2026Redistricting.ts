// U.S. House district override for the states that vote on redrawn lines in
// November 2026.
//
// The Census geocoder (censusAddressGeocoder.ts) answers every vintage with
// the "119th Congressional Districts" layer — the lines used in 2024. Nine
// states adopted new congressional maps after that and use them for the
// November 3, 2026 election, so for an address in those states the geocoder
// hands back the race the voter's 2024 district number had, not the race on
// their ballot. District NUMBERS survive in every one of these states (each
// kept its seat count), so the `districts` rows keyed "4705" etc. stay valid;
// only which polygon an address falls in changed.
//
// TIGERweb publishes the new lines as "120th Congressional Districts"
// (Legislative MapServer layer 0, "January 1, 2026 vintage"). Verified live
// 2026-09-16: Memphis City Hall resolves to TN-9 on the 119th layer and TN-5
// on the 120th, and every one of the nine states below has changed district
// polygons in that layer while control states (VA, GA, NY) are identical.
//
// The override is OPT-IN PER STATE, never "use the 120th layer everywhere":
// the same layer also carries Missouri's 2025 map, which the Missouri Supreme
// Court blocked on 2026-09-03 (the U.S. Supreme Court declined to intervene
// 2026-09-10), so Missouri votes on its 2022 lines in November and the 119th
// answer is the correct one there. Add a state here only once its new map is
// in force for the next House election.
//
// A failed lookup FAILS the address resolution, with the geocoder's own error
// class, so the API answers "upstream trouble, retry" (502/503) exactly as it
// does when the geocoder itself is down. The alternative — dropping the House
// key and serving the rest — is a silently incomplete ballot: the public
// response carries no warnings, the client shows no partial banner, and a
// guest signup would save the incomplete district set.
import type { AddressDistrictKey, AddressDistrictResolution } from "./addressDistrictResolver.js";
import {
  type CensusAddressCoordinates,
  type CensusAddressGeocoderOptions,
  CensusAddressGeocoderError,
  geocodeAddressWithCensusFallbacks,
} from "./censusAddressGeocoder.js";

export const TIGERWEB_US_HOUSE_120TH_QUERY_URL =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer/0/query";
export const US_HOUSE_120TH_LAYER_NAME = "120th Congressional Districts";
export const DEFAULT_US_HOUSE_120TH_LOOKUP_TIMEOUT_MS = 30_000;

// State FIPS codes whose November 2026 House election uses lines adopted after
// the 119th map. Status checked 2026-09-16 (docs in the PR that added this):
// - 01 Alabama: 2026 law; Milligan injunction lifted 2026-06-02
// - 06 California: Prop 50 (2025-11-04), upheld
// - 12 Florida: law signed 2026-05-04
// - 22 Louisiana: law passed 2026-05-29 (challenges pending, map in force)
// - 37 North Carolina: law 2025-10-22, panel approved 2025-11-26
// - 39 Ohio: Redistricting Commission map 2025-10-31
// - 47 Tennessee: law signed 2026-05-07; preliminary injunction denied 2026-07-24
// - 48 Texas: law signed 2025-08-29; Supreme Court stayed the block 2025-12-04
// - 49 Utah: court-ordered map 2025-11-10
// Deliberately absent: 29 Missouri (2025 map blocked, old lines in use).
export const US_HOUSE_2026_REDRAWN_STATE_FIPS: ReadonlySet<string> = new Set([
  "01",
  "06",
  "12",
  "22",
  "37",
  "39",
  "47",
  "48",
  "49",
]);

/**
 * The ACS district loader names House rows "(119th Congress)"; the label is
 * user-visible ("Elections in Congressional District 5 (119th Congress),
 * Tennessee"). For the redrawn states the row now stands for the 120th-map
 * seat, so the loader and migration 282 relabel it. Other states keep the
 * ACS name.
 */
export function relabelUsHouseDistrictNameFor2026(stateFips: string, name: string): string {
  if (!US_HOUSE_2026_REDRAWN_STATE_FIPS.has(stateFips)) {
    return name;
  }
  return name.replace(/\(119th Congress\)/, "(120th Congress)");
}

export type UsHouse120thDistrict = {
  geoid: string;
  name: string | null;
  mtfcc: string | null;
};

export type UsHouse120thLookup = (coordinates: CensusAddressCoordinates) => Promise<UsHouse120thDistrict | null>;

export type UsHouse120thLookupOptions = {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isUsHouseKeyInRedrawnState(key: AddressDistrictKey): boolean {
  return key.district_type === "us_house" && US_HOUSE_2026_REDRAWN_STATE_FIPS.has(key.geoid_compact.slice(0, 2));
}

/** True when the resolved keys hold a House district the 119th layer got wrong. */
export function usHouseKeyNeedsRedistrictingOverride(keys: readonly AddressDistrictKey[]): AddressDistrictKey | null {
  return keys.find(isUsHouseKeyInRedrawnState) ?? null;
}

/**
 * Point-in-polygon lookup against TIGERweb's 120th Congressional Districts
 * layer. Resolves null when the point falls in no district (open water, or a
 * coordinate outside the country); throws a CensusAddressGeocoderError for
 * transport or shape problems so callers treat it like the geocoder itself.
 */
export async function lookupUsHouse120thDistrict(
  coordinates: CensusAddressCoordinates,
  options: UsHouse120thLookupOptions = {}
): Promise<UsHouse120thDistrict | null> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_US_HOUSE_120TH_LOOKUP_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new CensusAddressGeocoderError("invalid_address", `timeoutMs must be a positive integer, got ${timeoutMs}`);
  }
  if (!Number.isFinite(coordinates.lat) || !Number.isFinite(coordinates.lng)) {
    throw new CensusAddressGeocoderError("invalid_address", "coordinates must be finite numbers");
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const url = new URL(TIGERWEB_US_HOUSE_120TH_QUERY_URL);
  url.searchParams.set("geometry", `${coordinates.lng},${coordinates.lat}`);
  url.searchParams.set("geometryType", "esriGeometryPoint");
  url.searchParams.set("inSR", "4326");
  url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
  url.searchParams.set("outFields", "GEOID,NAME,MTFCC,STATE");
  url.searchParams.set("returnGeometry", "false");
  url.searchParams.set("f", "json");

  // The timer covers the whole exchange, body included: a response whose
  // headers arrive but whose body stalls must abort too (same shape as
  // fetchCensusGeocoderPayload).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let status: number;
  let bodyText: string;
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
    status = response.status;
    bodyText = await response.text();
  } catch (error) {
    if (isAbortError(error)) {
      throw new CensusAddressGeocoderError("timeout", `TIGERweb 120th district lookup timed out after ${timeoutMs}ms`);
    }
    throw new CensusAddressGeocoderError(
      "network_error",
      `TIGERweb 120th district lookup failed: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    clearTimeout(timeout);
  }

  if (status < 200 || status >= 300) {
    throw new CensusAddressGeocoderError("http_error", `TIGERweb 120th district lookup returned HTTP ${status}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new CensusAddressGeocoderError("bad_response", "TIGERweb 120th district lookup returned non-JSON");
  }
  if (!isRecord(body)) {
    throw new CensusAddressGeocoderError("bad_response", "TIGERweb 120th district lookup returned a non-object body");
  }
  // ArcGIS reports its own failures as HTTP 200 with an `error` member.
  if (isRecord(body.error)) {
    throw new CensusAddressGeocoderError(
      "http_error",
      `TIGERweb 120th district lookup error: ${readString(body.error, "message") ?? "unknown"}`
    );
  }
  const features = body.features;
  if (!Array.isArray(features)) {
    throw new CensusAddressGeocoderError("bad_response", "TIGERweb 120th district lookup response has no features array");
  }
  const matches = features.map((feature) => (isRecord(feature) ? feature.attributes : null)).filter(isRecord);
  if (matches.length === 0) {
    return null;
  }
  // A point ON a shared edge intersects both polygons and ArcGIS returns
  // them in no guaranteed order (verified live: 25/25 boundary vertices of
  // TN-5 answered two districts). Callers pass an interior point for that
  // reason (see locateCensusBlockInteriorPoint); if two districts still come
  // back, refuse rather than pick one at random.
  const geoids = new Set(matches.map((attributes) => readString(attributes, "GEOID")));
  if (geoids.size > 1) {
    throw new CensusAddressGeocoderError(
      "bad_response",
      `TIGERweb 120th district lookup point lies on a district boundary: ${[...geoids].join(", ")}`
    );
  }
  const attributes = matches[0];
  const geoid = readString(attributes, "GEOID");
  if (!geoid || !/^\d{4}$/.test(geoid)) {
    throw new CensusAddressGeocoderError("bad_response", `TIGERweb 120th district feature has no 4-digit GEOID: ${geoid}`);
  }
  return {
    geoid,
    name: readString(attributes, "NAME"),
    mtfcc: readString(attributes, "MTFCC"),
  };
}

// The one-line geocoder places an address ON the street centerline and
// records which side it is on (`tigerLine.side`); district boundaries follow
// those same centerlines, so a centerline point on a boundary street sits on
// the shared edge and matches both districts. The geocoder's own geography
// answer already accounts for the side, and the ACS vintages carry no block
// layer, so this asks the Census2020 vintage for the address's census block
// and uses the block's interior point — a block never straddles a district.
// Null when the geocoder cannot place the address in a block (the caller then
// falls back to the address point); upstream failures propagate like the
// main geocode's.
export const CENSUS_BLOCK_GEOCODER_VINTAGE = "Census2020_Current";
export const CENSUS_BLOCK_GEOCODER_LAYERS = "Census Blocks";

function parseSignedDegrees(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export function readCensusBlockInteriorPoint(geographies: unknown): CensusAddressCoordinates | null {
  if (!isRecord(geographies)) {
    return null;
  }
  const blocks = geographies[CENSUS_BLOCK_GEOCODER_LAYERS];
  const block = Array.isArray(blocks) ? blocks.find(isRecord) : null;
  if (!block) {
    return null;
  }
  const lat = parseSignedDegrees(block.INTPTLAT);
  const lng = parseSignedDegrees(block.INTPTLON);
  return lat === null || lng === null ? null : { lat, lng };
}

export async function locateCensusBlockInteriorPoint(
  address: string,
  options: CensusAddressGeocoderOptions = {}
): Promise<CensusAddressCoordinates | null> {
  try {
    const located = await geocodeAddressWithCensusFallbacks(address, {
      ...options,
      vintage: CENSUS_BLOCK_GEOCODER_VINTAGE,
      layers: CENSUS_BLOCK_GEOCODER_LAYERS,
    });
    return readCensusBlockInteriorPoint(located.geographies);
  } catch (error) {
    if (error instanceof CensusAddressGeocoderError && error.code === "not_found") {
      return null;
    }
    throw error;
  }
}

/**
 * Replace the geocoder's 119th-layer House key with the 120th-layer answer for
 * addresses in the redrawn states. Addresses elsewhere pass through untouched
 * and never trigger a lookup. Throws (CensusAddressGeocoderError) when the
 * lookup fails or answers nothing usable — see the module comment for why a
 * partial result is not served.
 */
export async function applyUsHouse2026Redistricting(
  resolution: AddressDistrictResolution,
  coordinates: CensusAddressCoordinates,
  lookup: UsHouse120thLookup
): Promise<AddressDistrictResolution> {
  const staleKey = usHouseKeyNeedsRedistrictingOverride(resolution.district_keys);
  if (!staleKey) {
    return resolution;
  }
  const stateFips = staleKey.geoid_compact.slice(0, 2);

  const located = await lookup(coordinates);
  if (!located) {
    throw new CensusAddressGeocoderError(
      "bad_response",
      `TIGERweb 120th district lookup matched no district for a point the geocoder placed in ${staleKey.geoid_compact}`
    );
  }
  if (located.geoid.slice(0, 2) !== stateFips) {
    throw new CensusAddressGeocoderError(
      "bad_response",
      `TIGERweb 120th district ${located.geoid} is outside the geocoded state ${stateFips}`
    );
  }

  const replacement: AddressDistrictKey = {
    district_type: "us_house",
    geoid_compact: located.geoid,
    source: located.mtfcc?.toUpperCase() === "G5200" ? "mtfcc" : "layer_name",
    layer_name: US_HOUSE_120TH_LAYER_NAME,
    ...(located.mtfcc ? { mtfcc: located.mtfcc } : {}),
    ...(located.name ? { name: located.name } : {}),
  };
  // Keep the resolver's ordering (statewide, us_house, state_upper, ...):
  // the stale key is swapped in place rather than appended.
  return {
    district_keys: resolution.district_keys.map((key) => (key === staleKey ? replacement : key)),
    warnings: resolution.warnings,
  };
}
