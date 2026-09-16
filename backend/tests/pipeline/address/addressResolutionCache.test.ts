import { describe, expect, it, vi } from "vitest";

import {
  ADDRESS_LOOKUP_CACHE_KEY_PREFIX,
  DEFAULT_ADDRESS_LOOKUP_CACHE_TTL_SECONDS,
  buildAddressLookupCacheKey,
  readAddressLookupCache,
  writeAddressLookupCache,
} from "../../../src/pipeline/address/addressResolutionCache.js";

describe("addressResolutionCache", () => {
  it("builds a stable sha key without embedding the raw address", () => {
    const key = buildAddressLookupCacheKey({
      address: " 3921   Harlan Ave Baldwin Park CA 91706 ",
      benchmark: "Public_AR_Current",
      vintage: "ACS2024_Current",
      layers: "all",
    });
    const sameKey = buildAddressLookupCacheKey({
      address: "3921 harlan ave baldwin park ca 91706",
      benchmark: "Public_AR_Current",
      vintage: "ACS2024_Current",
      layers: "all",
    });

    expect(key).toBe(sameKey);
    expect(key).toMatch(new RegExp(`^${ADDRESS_LOOKUP_CACHE_KEY_PREFIX}[a-f0-9]{64}$`));
    expect(key).not.toContain("Harlan");
    expect(key).not.toContain("3921");
  });

  it("keys on the layers configuration so a layers change cannot reuse stale results", () => {
    const base = {
      address: "3921 harlan ave baldwin park ca 91706",
      benchmark: "Public_AR_Current",
      vintage: "ACS2024_Current",
    };

    expect(buildAddressLookupCacheKey({ ...base, layers: "all" })).not.toBe(
      buildAddressLookupCacheKey({ ...base, layers: "54,56" })
    );
  });

  it("writes JSON with TTL and reads it back", async () => {
    const store = new Map<string, string>();
    const cache = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
        return "OK";
      }),
    };

    await writeAddressLookupCache(
      cache,
      "address_lookup:v3:test",
      {
        matched_address: "3921 HARLAN AVE, BALDWIN PARK, CA, 91706",
        coordinates: { lat: 34.08, lng: -117.98 },
        address_match_count: 1,
        district_keys: [
          {
            district_type: "county",
            geoid_compact: "06037",
            source: "mtfcc",
            layer_name: "Counties",
            mtfcc: "G4020",
            name: "Los Angeles County",
          },
        ],
        warnings: [],
      },
      60
    );

    expect(cache.set).toHaveBeenCalledWith("address_lookup:v3:test", expect.any(String), { EX: 60 });
    await expect(readAddressLookupCache(cache, "address_lookup:v3:test")).resolves.toMatchObject({
      matched_address: "3921 HARLAN AVE, BALDWIN PARK, CA, 91706",
      coordinates: { lat: 34.08, lng: -117.98 },
      address_match_count: 1,
      district_keys: [{ district_type: "county", geoid_compact: "06037" }],
      warnings: [],
    });
  });

  it("returns null for malformed cached payloads", async () => {
    const cache = { get: vi.fn(async () => "not-json") };

    await expect(readAddressLookupCache(cache, "address_lookup:v3:test")).resolves.toBeNull();
  });

  it("uses the default TTL when none is provided", async () => {
    const cache = { set: vi.fn(async () => "OK") };

    await writeAddressLookupCache(cache, "address_lookup:v3:test", {
      matched_address: "matched",
      coordinates: { lat: 1, lng: 2 },
      address_match_count: 1,
      district_keys: [],
      warnings: [],
    });

    expect(cache.set).toHaveBeenCalledWith("address_lookup:v3:test", expect.any(String), {
      EX: DEFAULT_ADDRESS_LOOKUP_CACHE_TTL_SECONDS,
    });
  });
});
