import { createHash } from "node:crypto";

import type { AddressDistrictKey, AddressDistrictResolverWarning } from "./addressDistrictResolver.js";
import type { CensusAddressCoordinates } from "./censusAddressGeocoder.js";

// v2: the hashed key input gained the geocoder layers dimension. The version
// tracks key-derivation changes so orphaned generations stay identifiable
// (e.g. SCAN address_lookup:v1:* to sweep them on the small noeviction Redis).
// v3: cached district keys now carry the 120th-Congress House override for
// the states redrawn for November 2026 (usHouse2026Redistricting.ts); v2
// entries hold 119th-layer House keys that are wrong in those states, so
// they must miss rather than age out over 14 days.
export const ADDRESS_LOOKUP_CACHE_KEY_PREFIX = "address_lookup:v3:";
export const DEFAULT_ADDRESS_LOOKUP_CACHE_TTL_SECONDS = 14 * 24 * 60 * 60;

export type AddressLookupCacheClient = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
};

export type AddressLookupCacheValue = {
  matched_address: string;
  coordinates: CensusAddressCoordinates;
  address_match_count: number;
  district_keys: AddressDistrictKey[];
  warnings: AddressDistrictResolverWarning[];
  cached_at: string;
};

function normalizeAddressForCache(address: string): string {
  return address.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeCacheContext(value: string): string {
  return value.trim();
}

export function buildAddressLookupCacheKey(input: {
  address: string;
  benchmark: string;
  vintage: string;
  layers: string;
}): string {
  const normalized = JSON.stringify({
    address: normalizeAddressForCache(input.address),
    benchmark: normalizeCacheContext(input.benchmark),
    vintage: normalizeCacheContext(input.vintage),
    // The layers parameter shapes which geographies the geocoder returns, so
    // cached district keys are only valid for the layers they were fetched
    // with — a config change must miss rather than reuse 14-day-old results.
    layers: normalizeCacheContext(input.layers),
  });
  const hash = createHash("sha256").update(normalized).digest("hex");
  return `${ADDRESS_LOOKUP_CACHE_KEY_PREFIX}${hash}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCoordinates(value: unknown): value is CensusAddressCoordinates {
  return isRecord(value) && typeof value.lat === "number" && typeof value.lng === "number";
}

function isCachedValue(value: unknown): value is AddressLookupCacheValue {
  return (
    isRecord(value) &&
    typeof value.matched_address === "string" &&
    isCoordinates(value.coordinates) &&
    typeof value.address_match_count === "number" &&
    Array.isArray(value.district_keys) &&
    Array.isArray(value.warnings) &&
    typeof value.cached_at === "string"
  );
}

export async function readAddressLookupCache(
  cache: Pick<AddressLookupCacheClient, "get">,
  key: string
): Promise<AddressLookupCacheValue | null> {
  const raw = await cache.get(key);
  if (!raw) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isCachedValue(parsed)) {
    return null;
  }
  return parsed;
}

export async function writeAddressLookupCache(
  cache: Pick<AddressLookupCacheClient, "set">,
  key: string,
  value: Omit<AddressLookupCacheValue, "cached_at">,
  ttlSeconds = DEFAULT_ADDRESS_LOOKUP_CACHE_TTL_SECONDS
): Promise<void> {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(`ttlSeconds must be a positive integer: ${ttlSeconds}`);
  }
  await cache.set(
    key,
    JSON.stringify({
      ...value,
      cached_at: new Date().toISOString(),
    } satisfies AddressLookupCacheValue),
    { EX: ttlSeconds }
  );
}
