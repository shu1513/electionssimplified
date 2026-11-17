import { describe, expect, it, vi } from "vitest";

import { lookupAddressDistricts } from "../../../src/pipeline/address/addressDistrictLookup.js";

describe("lookupAddressDistricts", () => {
  it("returns empty output without querying when there are no keys", async () => {
    const query = vi.fn();

    await expect(lookupAddressDistricts({ query }, [])).resolves.toEqual({
      districts: [],
      missing_district_keys: [],
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("queries public.districts by district_type and geoid_compact arrays", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          id: "district-ca",
          district_type: "statewide",
          geoid_compact: "06",
          name: "California",
          state: "CA",
          state_fips: "06",
          population: 39287377,
          representation_power_score: "42.50",
          requested_district_type: "statewide",
          requested_geoid_compact: "06",
        },
        {
          id: "district-la",
          district_type: "county",
          geoid_compact: "06037",
          name: "Los Angeles County",
          state: "CA",
          state_fips: "06",
          population: 9876482,
          representation_power_score: null,
          requested_district_type: "county",
          requested_geoid_compact: "06037",
        },
      ],
    });

    const result = await lookupAddressDistricts({ query }, [
      { district_type: "statewide", geoid_compact: "06" },
      { district_type: "county", geoid_compact: "06037" },
    ]);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("FROM unnest($1::text[], $2::text[])");
    expect(query.mock.calls[0]?.[0]).toContain("JOIN public.districts AS d");
    expect(query.mock.calls[0]?.[1]).toEqual([
      ["statewide", "county"],
      ["06", "06037"],
      ["county"],
      ["06037"],
    ]);
    expect(result).toEqual({
      districts: [
        {
          id: "district-ca",
          district_type: "statewide",
          geoid_compact: "06",
          name: "California",
          state: "CA",
          state_fips: "06",
          population: 39287377,
          representation_power_score: 42.5,
        },
        {
          id: "district-la",
          district_type: "county",
          geoid_compact: "06037",
          name: "Los Angeles County",
          state: "CA",
          state_fips: "06",
          population: 9876482,
          representation_power_score: null,
        },
      ],
      missing_district_keys: [],
    });
  });

  it("dedupes input keys and reports missing district keys", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          id: "district-la",
          district_type: "county",
          geoid_compact: "06037",
          name: "Los Angeles County",
          state: "CA",
          state_fips: "06",
          population: 9876482,
          representation_power_score: 10,
          requested_district_type: "county",
          requested_geoid_compact: "06037",
        },
      ],
    });

    const result = await lookupAddressDistricts({ query }, [
      { district_type: "county", geoid_compact: "06037" },
      { district_type: "county", geoid_compact: "06037" },
      { district_type: "place", geoid_compact: "0603666" },
    ]);

    expect(query.mock.calls[0]?.[1]).toEqual([
      ["county", "place"],
      ["06037", "0603666"],
      ["county"],
      ["06037"],
    ]);
    expect(result.districts.map((district) => district.id)).toEqual(["district-la"]);
    expect(result.missing_district_keys).toEqual([
      { district_type: "place", geoid_compact: "0603666" },
    ]);
  });

  it("accepts keys returned by the address district resolver", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          id: "district-us-house",
          district_type: "us_house",
          geoid_compact: "0631",
          name: "Congressional District 31",
          state: "CA",
          state_fips: "06",
          population: 761000,
          representation_power_score: "73.20",
          requested_district_type: "us_house",
          requested_geoid_compact: "0631",
        },
      ],
    });

    const result = await lookupAddressDistricts({ query }, [
      {
        district_type: "us_house",
        geoid_compact: "0631",
        source: "mtfcc",
        layer_name: "119th Congressional Districts",
        mtfcc: "G5200",
      },
    ]);

    expect(result.districts).toEqual([
      {
        id: "district-us-house",
        district_type: "us_house",
        geoid_compact: "0631",
        name: "Congressional District 31",
        state: "CA",
        state_fips: "06",
        population: 761000,
        representation_power_score: 73.2,
      },
    ]);
  });

  it("collapses a non-government row onto the district that holds the elections", async () => {
    // An Arlington, Virginia address geocodes into both the counties layer
    // (51013) and the incorporated-places layer (Arlington CDP, 5103000). The
    // CDP is a Census statistical geography with no government, so the query
    // resolves it to Arlington County and the caller must see the county once.
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          id: "arlington-county",
          district_type: "county",
          geoid_compact: "51013",
          name: "Arlington County, Virginia",
          state: "VA",
          state_fips: "51",
          population: 236254,
          representation_power_score: null,
          requested_district_type: "county",
          requested_geoid_compact: "51013",
        },
        {
          id: "arlington-county",
          district_type: "county",
          geoid_compact: "51013",
          name: "Arlington County, Virginia",
          state: "VA",
          state_fips: "51",
          population: 236254,
          representation_power_score: null,
          requested_district_type: "place",
          requested_geoid_compact: "5103000",
        },
      ],
    });

    const result = await lookupAddressDistricts({ query }, [
      { district_type: "county", geoid_compact: "51013" },
      { district_type: "place", geoid_compact: "5103000" },
    ]);

    expect(query.mock.calls[0]?.[0]).toContain("LEFT JOIN public.districts AS owner");
    expect(result.districts).toEqual([
      {
        id: "arlington-county",
        district_type: "county",
        geoid_compact: "51013",
        name: "Arlington County, Virginia",
        state: "VA",
        state_fips: "51",
        population: 236254,
        representation_power_score: null,
      },
    ]);
    // The CDP key resolved to a row; it is not missing just because the row
    // handed back carries the county identity.
    expect(result.missing_district_keys).toEqual([]);
  });

  it("skips blank geoid keys before querying", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });

    await lookupAddressDistricts({ query }, [
      { district_type: "county", geoid_compact: " " },
      { district_type: "statewide", geoid_compact: "06" },
    ]);

    expect(query.mock.calls[0]?.[1]).toEqual([["statewide"], ["06"]]);
  });
});
