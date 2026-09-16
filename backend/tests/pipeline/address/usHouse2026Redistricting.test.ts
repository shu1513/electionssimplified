import { describe, expect, it, vi } from "vitest";

import type { AddressDistrictKey } from "../../../src/pipeline/address/addressDistrictResolver.js";
import { CensusAddressGeocoderError } from "../../../src/pipeline/address/censusAddressGeocoder.js";
import {
  applyUsHouse2026Redistricting,
  locateCensusBlockInteriorPoint,
  lookupUsHouse120thDistrict,
  readCensusBlockInteriorPoint,
  relabelUsHouseDistrictNameFor2026,
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

describe("relabelUsHouseDistrictNameFor2026", () => {
  it("relabels the ACS 119th name only in the redrawn states", () => {
    expect(relabelUsHouseDistrictNameFor2026("47", "Congressional District 5 (119th Congress), Tennessee")).toBe(
      "Congressional District 5 (120th Congress), Tennessee"
    );
    expect(relabelUsHouseDistrictNameFor2026("51", "Congressional District 4 (119th Congress), Virginia")).toBe(
      "Congressional District 4 (119th Congress), Virginia"
    );
    expect(relabelUsHouseDistrictNameFor2026("29", "Congressional District 5 (119th Congress), Missouri")).toBe(
      "Congressional District 5 (119th Congress), Missouri"
    );
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

  it("refuses a point that matches two districts instead of picking one", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        features: [
          { attributes: { GEOID: "4705", NAME: "Congressional District 5", MTFCC: "G5200" } },
          { attributes: { GEOID: "4709", NAME: "Congressional District 9", MTFCC: "G5200" } },
        ],
      })
    );
    await expect(lookupUsHouse120thDistrict(MEMPHIS, { fetchImpl })).rejects.toMatchObject({
      code: "bad_response",
      message: expect.stringContaining("district boundary: 4705, 4709"),
    });
    // The same district twice is not ambiguous.
    const duplicate = vi.fn(async () =>
      jsonResponse({ features: [{ attributes: { GEOID: "4705" } }, { attributes: { GEOID: "4705" } }] })
    );
    await expect(lookupUsHouse120thDistrict(MEMPHIS, { fetchImpl: duplicate })).resolves.toMatchObject({ geoid: "4705" });
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

  it("keeps the timeout armed while the body is still streaming", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async (_url: URL, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal;
        return {
          status: 200,
          text: () =>
            new Promise<string>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
            }),
        } as unknown as Response;
      });
      const pending = lookupUsHouse120thDistrict(MEMPHIS, { fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 10 });
      const settled = expect(pending).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(20);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects non-finite coordinates before fetching", async () => {
    const fetchImpl = vi.fn();
    await expect(lookupUsHouse120thDistrict({ lat: Number.NaN, lng: 0 }, { fetchImpl })).rejects.toBeInstanceOf(
      CensusAddressGeocoderError
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("census block interior point", () => {
  it("reads the block's INTPTLAT/INTPTLON in the geocoder's signed-degree format", () => {
    expect(
      readCensusBlockInteriorPoint({
        "Census Blocks": [{ GEOID: "471570042001012", INTPTLAT: "+35.1493568", INTPTLON: "-090.0518881" }],
      })
    ).toEqual({ lat: 35.1493568, lng: -90.0518881 });
    expect(readCensusBlockInteriorPoint({ Counties: [{ GEOID: "47157" }] })).toBeNull();
    expect(readCensusBlockInteriorPoint({ "Census Blocks": [{ GEOID: "x", INTPTLAT: "n/a" }] })).toBeNull();
    expect(readCensusBlockInteriorPoint(null)).toBeNull();
  });

  it("asks the Census2020 vintage for the block layer and returns null on not_found", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        result: {
          input: {},
          addressMatches: [
            {
              matchedAddress: "125 N MAIN ST, MEMPHIS, TN, 38103",
              coordinates: { x: -90.051553690438, y: 35.148558377868 },
              geographies: { "Census Blocks": [{ GEOID: "471570042001012", INTPTLAT: "+35.1493568", INTPTLON: "-090.0518881" }] },
            },
          ],
        },
      })
    );
    await expect(locateCensusBlockInteriorPoint("125 N Main St, Memphis, TN 38103", { fetchImpl })).resolves.toEqual({
      lat: 35.1493568,
      lng: -90.0518881,
    });
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.searchParams.get("vintage")).toBe("Census2020_Current");
    expect(url.searchParams.get("layers")).toBe("Census Blocks");

    const notFound = vi.fn(async () => jsonResponse({ result: { input: {}, addressMatches: [] } }));
    await expect(locateCensusBlockInteriorPoint("125 N Main St, Memphis, TN 38103", { fetchImpl: notFound })).resolves.toBeNull();

    const down = vi.fn(async () => jsonResponse({}, 503));
    await expect(locateCensusBlockInteriorPoint("125 N Main St, Memphis, TN 38103", { fetchImpl: down })).rejects.toMatchObject({
      code: "http_error",
    });
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
    await expect(applyUsHouse2026Redistricting(resolution, MEMPHIS, lookup)).resolves.toBe(resolution);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("fails the resolution with the geocoder error class when the lookup fails", async () => {
    // Never a partial ballot: the API maps this to the same retryable
    // upstream error a geocoder outage produces.
    const lookup = vi.fn(async () => {
      throw new CensusAddressGeocoderError("timeout", "TIGERweb timed out");
    });
    await expect(
      applyUsHouse2026Redistricting({ district_keys: [stale, county], warnings: [] }, MEMPHIS, lookup)
    ).rejects.toMatchObject({ name: "CensusAddressGeocoderError", code: "timeout" });
  });

  it("treats no match and a cross-state answer as failures too", async () => {
    await expect(
      applyUsHouse2026Redistricting({ district_keys: [stale], warnings: [] }, MEMPHIS, vi.fn(async () => null))
    ).rejects.toMatchObject({ code: "bad_response", message: expect.stringContaining("matched no district") });

    await expect(
      applyUsHouse2026Redistricting(
        { district_keys: [stale], warnings: [] },
        MEMPHIS,
        vi.fn(async () => ({ geoid: "0501", name: null, mtfcc: null }))
      )
    ).rejects.toMatchObject({ code: "bad_response", message: expect.stringContaining("outside the geocoded state 47") });
  });
});
