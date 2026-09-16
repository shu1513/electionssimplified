import { describe, expect, it, vi } from "vitest";

import type { AddressDistrictKey } from "../../../src/pipeline/address/addressDistrictResolver.js";
import { CensusAddressGeocoderError } from "../../../src/pipeline/address/censusAddressGeocoder.js";
import {
  applyUsHouse2026Redistricting,
  lookupUsHouse120thDistrict,
  US_HOUSE_2026_REDRAWN_STATE_FIPS,
  US_HOUSE_120TH_LAYER_NAME,
  usHouseKeyNeedsRedistrictingOverride,
} from "../../../src/pipeline/address/usHouse2026Redistricting.js";

const MEMPHIS = { lat: 35.148558377868, lng: -90.051553690438 };

function key(overrides: Partial<AddressDistrictKey> & Pick<AddressDistrictKey, "district_type" | "geoid_compact">): AddressDistrictKey {
  return { source: "mtfcc", layer_name: "119th Congressional Districts", mtfcc: "G5200", ...overrides };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("US_HOUSE_2026_REDRAWN_STATE_FIPS", () => {
  it("lists the nine states voting on new lines and excludes Missouri's blocked map", () => {
    expect([...US_HOUSE_2026_REDRAWN_STATE_FIPS].sort()).toEqual(["01", "06", "12", "22", "37", "39", "47", "48", "49"]);
    expect(US_HOUSE_2026_REDRAWN_STATE_FIPS.has("29")).toBe(false);
  });
});

describe("usHouseKeyNeedsRedistrictingOverride", () => {
  it("finds the House key only for a redrawn state", () => {
    const tennessee = key({ district_type: "us_house", geoid_compact: "4709" });
    expect(usHouseKeyNeedsRedistrictingOverride([key({ district_type: "county", geoid_compact: "47157" }), tennessee])).toBe(
      tennessee
    );
    expect(usHouseKeyNeedsRedistrictingOverride([key({ district_type: "us_house", geoid_compact: "5107" })])).toBeNull();
    expect(usHouseKeyNeedsRedistrictingOverride([key({ district_type: "state_upper", geoid_compact: "47029" })])).toBeNull();
  });
});

describe("lookupUsHouse120thDistrict", () => {
  it("queries the 120th layer by point and returns the district attributes", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        features: [{ attributes: { GEOID: "4705", NAME: "Congressional District 5", MTFCC: "G5200", STATE: "47" } }],
      })
    );

    await expect(lookupUsHouse120thDistrict(MEMPHIS, { fetchImpl })).resolves.toEqual({
      geoid: "4705",
      name: "Congressional District 5",
      mtfcc: "G5200",
    });
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.pathname).toContain("/TIGERweb/Legislative/MapServer/0/query");
    expect(url.searchParams.get("geometry")).toBe("-90.051553690438,35.148558377868");
    expect(url.searchParams.get("geometryType")).toBe("esriGeometryPoint");
    expect(url.searchParams.get("inSR")).toBe("4326");
    expect(url.searchParams.get("returnGeometry")).toBe("false");
  });

  it("returns null when the point matches no district", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ features: [] }));
    await expect(lookupUsHouse120thDistrict(MEMPHIS, { fetchImpl })).resolves.toBeNull();
  });

  it("maps HTTP, ArcGIS, malformed, and timeout failures to geocoder error codes", async () => {
    await expect(
      lookupUsHouse120thDistrict(MEMPHIS, { fetchImpl: vi.fn(async () => jsonResponse({}, 503)) })
    ).rejects.toMatchObject({ name: "CensusAddressGeocoderError", code: "http_error" });
    await expect(
      lookupUsHouse120thDistrict(MEMPHIS, {
        fetchImpl: vi.fn(async () => jsonResponse({ error: { code: 400, message: "Invalid geometry" } })),
      })
    ).rejects.toMatchObject({ code: "http_error", message: expect.stringContaining("Invalid geometry") });
    await expect(
      lookupUsHouse120thDistrict(MEMPHIS, { fetchImpl: vi.fn(async () => jsonResponse({ features: [{ attributes: { GEOID: "47" } }] })) })
    ).rejects.toMatchObject({ code: "bad_response" });
    await expect(
      lookupUsHouse120thDistrict(MEMPHIS, {
        fetchImpl: vi.fn(async () => new Response("<html>", { status: 200 })),
      })
    ).rejects.toMatchObject({ code: "bad_response" });
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    await expect(
      lookupUsHouse120thDistrict(MEMPHIS, {
        fetchImpl: vi.fn(async () => {
          throw abortError;
        }),
      })
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("rejects non-finite coordinates before fetching", async () => {
    const fetchImpl = vi.fn();
    await expect(lookupUsHouse120thDistrict({ lat: Number.NaN, lng: 0 }, { fetchImpl })).rejects.toBeInstanceOf(
      CensusAddressGeocoderError
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("applyUsHouse2026Redistricting", () => {
  const county = key({ district_type: "county", geoid_compact: "47157", layer_name: "Counties", mtfcc: "G4020" });
  const stale = key({ district_type: "us_house", geoid_compact: "4709", name: "Congressional District 9" });
  const senate = key({ district_type: "state_upper", geoid_compact: "47029", mtfcc: "G5210" });

  it("swaps the 119th House key for the 120th answer in place", async () => {
    const lookup = vi.fn(async () => ({ geoid: "4705", name: "Congressional District 5", mtfcc: "G5200" }));
    const result = await applyUsHouse2026Redistricting({ district_keys: [stale, county, senate], warnings: [] }, MEMPHIS, lookup);

    expect(lookup).toHaveBeenCalledWith(MEMPHIS);
    expect(result.override_failed).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.district_keys).toEqual([
      {
        district_type: "us_house",
        geoid_compact: "4705",
        source: "mtfcc",
        layer_name: US_HOUSE_120TH_LAYER_NAME,
        mtfcc: "G5200",
        name: "Congressional District 5",
      },
      county,
      senate,
    ]);
  });

  it("never calls the lookup outside the redrawn states", async () => {
    const lookup = vi.fn();
    const virginia = key({ district_type: "us_house", geoid_compact: "5107" });
    const resolution = { district_keys: [virginia], warnings: [] };
    await expect(applyUsHouse2026Redistricting(resolution, MEMPHIS, lookup)).resolves.toEqual({
      ...resolution,
      override_failed: false,
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("drops the stale House key and warns on the 120th layer when the lookup fails", async () => {
    const lookup = vi.fn(async () => {
      throw new CensusAddressGeocoderError("timeout", "TIGERweb timed out");
    });
    const result = await applyUsHouse2026Redistricting({ district_keys: [stale, county], warnings: [] }, MEMPHIS, lookup);

    expect(result.override_failed).toBe(true);
    expect(result.district_keys).toEqual([county]);
    expect(result.warnings).toEqual([
      {
        layer_name: US_HOUSE_120TH_LAYER_NAME,
        geoid: "4709",
        mtfcc: "G5200",
        reason: "120th district lookup failed: TIGERweb timed out",
      },
    ]);
  });

  it("treats no match and a cross-state answer as failures too", async () => {
    const none = await applyUsHouse2026Redistricting(
      { district_keys: [stale], warnings: [] },
      MEMPHIS,
      vi.fn(async () => null)
    );
    expect(none).toMatchObject({ override_failed: true, district_keys: [] });
    expect(none.warnings[0]?.reason).toContain("no 120th Congressional District");

    const wrongState = await applyUsHouse2026Redistricting(
      { district_keys: [stale], warnings: [] },
      MEMPHIS,
      vi.fn(async () => ({ geoid: "0501", name: null, mtfcc: null }))
    );
    expect(wrongState).toMatchObject({ override_failed: true, district_keys: [] });
    expect(wrongState.warnings[0]?.reason).toContain("outside the geocoded state 47");
  });
});
