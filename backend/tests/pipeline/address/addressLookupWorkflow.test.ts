import { describe, expect, it, vi } from "vitest";

import { resolveAddressToDistricts } from "../../../src/pipeline/address/addressResolverService.js";

const BALDWIN_PARK_ADDRESS = "3921 Harlan Ave Baldwin Park CA 91706";
const BALDWIN_PARK_MATCHED_ADDRESS = "3921 HARLAN AVE, BALDWIN PARK, CA, 91706";
const BALDWIN_PARK_GEOGRAPHIES = {
  States: [{ GEOID: "06", NAME: "California", MTFCC: "G4000" }],
  "119th Congressional Districts": [{ GEOID: "0631", NAME: "Congressional District 31", MTFCC: "G5200" }],
  "2024 State Legislative Districts - Upper": [{ GEOID: "06022", NAME: "State Senate District 22", MTFCC: "G5210" }],
  "2024 State Legislative Districts - Lower": [{ GEOID: "06048", NAME: "Assembly District 48", MTFCC: "G5220" }],
  Counties: [{ GEOID: "06037", NAME: "Los Angeles County", MTFCC: "G4020" }],
  "Incorporated Places": [{ GEOID: "0603666", NAME: "Baldwin Park city", MTFCC: "G4110" }],
  "Unified School Districts": [{ GEOID: "0603690", NAME: "Baldwin Park Unified School District", MTFCC: "G5420" }],
  "2020 Census Blocks": [{ GEOID: "060374049021006", NAME: "Block 1006", MTFCC: "G5040" }],
  "2020 Census ZIP Code Tabulation Areas": [{ GEOID: "91706", NAME: "ZCTA5 91706", MTFCC: "G6350" }],
};

const EXPECTED_BALDWIN_PARK_KEYS = [
  { district_type: "statewide", geoid_compact: "06" },
  { district_type: "us_house", geoid_compact: "0638" },
  { district_type: "state_upper", geoid_compact: "06022" },
  { district_type: "state_lower", geoid_compact: "06048" },
  { district_type: "county", geoid_compact: "06037" },
  { district_type: "place", geoid_compact: "0603666" },
  { district_type: "school_unified", geoid_compact: "0603690" },
];

describe("address lookup workflow", () => {
  it("resolves the Baldwin Park fixture into expected district keys and DB districts", async () => {
    const geocodeAddress = vi.fn().mockResolvedValue({
      matched_address: BALDWIN_PARK_MATCHED_ADDRESS,
      coordinates: { lat: 34.082500135664, lng: -117.981072355887 },
      address_match_count: 1,
      geographies: BALDWIN_PARK_GEOGRAPHIES,
    });
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: "district-ca",
          district_type: "statewide",
          geoid_compact: "06",
          name: "California",
          state: "CA",
          state_fips: "06",
          population: 39287377,
          representation_power_score: null,
          requested_district_type: "statewide",
          requested_geoid_compact: "06",
        },
        {
          id: "district-house-38",
          district_type: "us_house",
          geoid_compact: "0638",
          name: "Congressional District 38",
          state: "CA",
          state_fips: "06",
          population: 760000,
          representation_power_score: "72.10",
          requested_district_type: "us_house",
          requested_geoid_compact: "0638",
        },
        {
          id: "district-senate-22",
          district_type: "state_upper",
          geoid_compact: "06022",
          name: "State Senate District 22",
          state: "CA",
          state_fips: "06",
          population: 988000,
          representation_power_score: null,
          requested_district_type: "state_upper",
          requested_geoid_compact: "06022",
        },
        {
          id: "district-assembly-48",
          district_type: "state_lower",
          geoid_compact: "06048",
          name: "Assembly District 48",
          state: "CA",
          state_fips: "06",
          population: 494000,
          representation_power_score: null,
          requested_district_type: "state_lower",
          requested_geoid_compact: "06048",
        },
        {
          id: "district-la-county",
          district_type: "county",
          geoid_compact: "06037",
          name: "Los Angeles County",
          state: "CA",
          state_fips: "06",
          population: 9876482,
          representation_power_score: "12.30",
          requested_district_type: "county",
          requested_geoid_compact: "06037",
        },
        {
          id: "district-baldwin-park",
          district_type: "place",
          geoid_compact: "0603666",
          name: "Baldwin Park city",
          state: "CA",
          state_fips: "06",
          population: 70000,
          representation_power_score: null,
          requested_district_type: "place",
          requested_geoid_compact: "0603666",
        },
      ],
    });

    // California is one of the states redrawn for November 2026: the geocoder
    // still answers CA-31 (119th layer) for Baldwin Park, and the injected
    // 120th-layer lookup returns CA-38, which is what the live layer says.
    const lookupUsHouse120thDistrict = vi.fn(async () => ({ geoid: "0638", name: "Congressional District 38", mtfcc: "G5200" }));
    const result = await resolveAddressToDistricts({ query }, BALDWIN_PARK_ADDRESS, { geocodeAddress, lookupUsHouse120thDistrict });

    expect(lookupUsHouse120thDistrict).toHaveBeenCalledWith({ lat: 34.082500135664, lng: -117.981072355887 });

    expect(geocodeAddress).toHaveBeenCalledWith(BALDWIN_PARK_ADDRESS);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual([
      ["statewide", "us_house", "state_upper", "state_lower", "county", "place", "school_unified"],
      ["06", "0638", "06022", "06048", "06037", "0603666", "0603690"],
    ]);
    expect(result.matched_address).toBe(BALDWIN_PARK_MATCHED_ADDRESS);
    expect(result.district_keys.map(({ district_type, geoid_compact }) => ({ district_type, geoid_compact }))).toEqual(
      EXPECTED_BALDWIN_PARK_KEYS
    );
    expect(result.district_keys.every((key) => key.source === "mtfcc")).toBe(true);
    expect(result.districts.map(({ district_type, geoid_compact }) => ({ district_type, geoid_compact }))).toEqual(
      EXPECTED_BALDWIN_PARK_KEYS.slice(0, 6)
    );
    expect(result.missing_district_keys).toEqual([{ district_type: "school_unified", geoid_compact: "0603690" }]);
    expect(result.warnings).toEqual([]);
  });
});
