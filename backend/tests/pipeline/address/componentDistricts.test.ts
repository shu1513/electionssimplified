import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { lookupAddressDistricts } from "../../../src/pipeline/address/addressDistrictLookup.js";
import { resolveAddressDistrictKeysFromGeographies } from "../../../src/pipeline/address/addressDistrictResolver.js";
import { stateBaselineContestRank } from "../../../src/pipeline/address/ballotContestRank.js";
import { OfficeMatcher } from "../../../src/pipeline/elections/officeMatcher.js";

// Census geocoder answer for Manchester City Hall (layers=all, trimmed to the
// layers the resolver reads).
const MANCHESTER_GEOGRAPHIES = {
  States: [{ GEOID: "33", MTFCC: "G4000", NAME: "New Hampshire" }],
  "119th Congressional Districts": [{ GEOID: "3301", MTFCC: "G5200", NAME: "Congressional District 1" }],
  "2024 State Legislative Districts - Upper": [{ GEOID: "33020", MTFCC: "G5210", NAME: "State Senate District 20" }],
  "2024 State Legislative Districts - Lower": [
    { GEOID: "33523", MTFCC: "G5220", NAME: "State House District Hillsborough 23" },
  ],
  Counties: [{ GEOID: "33011", MTFCC: "G4020", NAME: "Hillsborough County" }],
  "Incorporated Places": [{ GEOID: "3345140", MTFCC: "G4110", NAME: "Manchester city" }],
  "County Subdivisions": [{ GEOID: "3301145140", MTFCC: "G4040", NAME: "Manchester city" }],
  "Census Tracts": [{ GEOID: "33011200400", MTFCC: "G5020", NAME: "Census Tract 2004" }],
};

const MIGRATION_302_SQL = readFileSync(
  new URL("../../../../db/migrations/302_add_nh_executive_council_and_floterial_districts.sql", import.meta.url),
  "utf8"
);

// The VALUES rows of the INSERT INTO <table> statement.
function valuesRows(table: string): string[] {
  const start = MIGRATION_302_SQL.indexOf(`INSERT INTO ${table} `);
  expect(start, table).toBeGreaterThanOrEqual(0);
  const body = MIGRATION_302_SQL.slice(start, MIGRATION_302_SQL.indexOf(";\n", start));
  return body.split("\n").filter((line) => line.startsWith("    ("));
}

describe("resolver: county subdivisions", () => {
  it("returns the town as a component key, never as a district key", () => {
    const resolution = resolveAddressDistrictKeysFromGeographies(MANCHESTER_GEOGRAPHIES);

    expect(resolution.component_keys).toEqual([{ component_type: "county_subdivision", geoid: "3301145140" }]);
    expect(resolution.district_keys.map((key) => key.district_type)).toEqual([
      "statewide",
      "us_house",
      "state_upper",
      "state_lower",
      "county",
      "place",
    ]);
    expect(resolution.warnings).toEqual([]);
  });

  it("falls back to the layer name when the feature has no MTFCC", () => {
    const resolution = resolveAddressDistrictKeysFromGeographies({
      "County Subdivisions": [{ GEOID: "3301145140", NAME: "Manchester city" }],
    });

    expect(resolution.component_keys).toEqual([{ component_type: "county_subdivision", geoid: "3301145140" }]);
    expect(resolution.district_keys).toEqual([]);
  });
});

describe("lookupAddressDistricts: component-built districts", () => {
  const row = (overrides: Record<string, unknown>) => ({
    name: "x",
    state: "NH",
    state_fips: "33",
    population: 1000,
    representation_power_score: null,
    ...overrides,
  });

  it("checks the base House district and the town, and returns the districts they build", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        row({
          id: "base-23",
          district_type: "state_lower",
          geoid_compact: "33523",
          requested_district_type: "state_lower",
          requested_geoid_compact: "33523",
        }),
        row({
          id: "council-4",
          district_type: "state_executive_council",
          geoid_compact: "33EC4",
          requested_district_type: null,
          requested_geoid_compact: null,
        }),
        row({
          id: "floterial-40",
          district_type: "state_lower",
          geoid_compact: "33540",
          requested_district_type: null,
          requested_geoid_compact: null,
        }),
      ],
    });

    const result = await lookupAddressDistricts(
      { query },
      [
        { district_type: "state_lower", geoid_compact: "33523" },
        { district_type: "county", geoid_compact: "33011" },
      ],
      [{ component_type: "county_subdivision", geoid: "3301145140" }]
    );

    expect(query.mock.calls[0]?.[0]).toContain("JOIN public.district_components AS dc");
    expect(query.mock.calls[0]?.[1]).toEqual([
      ["state_lower", "county"],
      ["33523", "33011"],
      ["state_lower", "county_subdivision"],
      ["33523", "3301145140"],
    ]);
    expect(result.districts.map((district) => district.id)).toEqual(["base-23", "council-4", "floterial-40"]);
    // Found-through-components rows never count as answering a requested key.
    expect(result.missing_district_keys).toEqual([{ district_type: "county", geoid_compact: "33011" }]);
  });

  it("skips the component join when the address has no possible component", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });

    await lookupAddressDistricts({ query }, [{ district_type: "statewide", geoid_compact: "33" }]);

    expect(query.mock.calls[0]?.[0]).not.toContain("district_components");
    expect(query.mock.calls[0]?.[1]).toEqual([["statewide"], ["33"]]);
  });
});

describe("migration 302 data", () => {
  it("puts each of New Hampshire's 259 towns in exactly one of 5 balanced council districts", () => {
    const towns = valuesRows("nh_council_towns").map((line) => {
      const match = /^\s+\((\d), '(\d{10})', '((?:[^']|'')+)', (\d+)\)/.exec(line);
      expect(match, line).not.toBeNull();
      return { council: Number(match![1]), geoid: match![2], name: match![3], population: Number(match![4]) };
    });

    expect(towns).toHaveLength(259);
    expect(new Set(towns.map((town) => town.geoid)).size).toBe(259);
    expect(towns.every((town) => town.geoid.startsWith("33"))).toBe(true);

    const totals = [1, 2, 3, 4, 5].map((council) =>
      towns.filter((town) => town.council === council).reduce((sum, town) => sum + town.population, 0)
    );
    const ideal = totals.reduce((sum, value) => sum + value, 0) / 5;
    for (const total of totals) {
      expect(Math.abs(total - ideal) / ideal).toBeLessThan(0.02);
    }

    // Manchester is in District 4 (RSA 662:2, IV), Nashua in District 5.
    expect(towns.find((town) => town.geoid === "3301145140")?.council).toBe(4);
    expect(towns.find((town) => town.geoid === "3301150260")?.council).toBe(5);
  });

  it("builds the 39 floterials from whole base districts of their own county", () => {
    const floterials = valuesRows("nh_floterials").map((line) => {
      const match = /^\s+\('(\d{5})', '(\w+)', +(\d+), (\d), +(\d+), ARRAY\[([^\]]+)\]::text\[\]\)/.exec(line);
      expect(match, line).not.toBeNull();
      return {
        geoid: match![1],
        seats: Number(match![4]),
        bases: [...match![6].matchAll(/'(\d{5})'/g)].map((base) => base[1]),
      };
    });

    expect(floterials).toHaveLength(39);
    const allBases = floterials.flatMap((floterial) => floterial.bases);
    // A base district belongs to at most one floterial.
    expect(new Set(allBases).size).toBe(allBases.length);
    for (const floterial of floterials) {
      expect(floterial.bases.length).toBeGreaterThanOrEqual(2);
      for (const base of floterial.bases) {
        expect(base.slice(0, 3)).toBe(floterial.geoid.slice(0, 3));
        expect(floterials.some((other) => other.geoid === base)).toBe(false);
      }
    }

    // Manchester's three floterials (RSA 662:5, VI): wards 8, 6, 9 / 12, 10,
    // 1, 11, 3 / 2, 4, 5, 7.
    const byGeoid = new Map(floterials.map((floterial) => [floterial.geoid, floterial]));
    expect(byGeoid.get("33539")?.bases).toEqual(["33515", "33516", "33520"]);
    expect(byGeoid.get("33540")?.bases).toEqual(["33518", "33519", "33521", "33522", "33523"]);
    expect(byGeoid.get("33541")?.bases).toEqual(["33517", "33524", "33525", "33526"]);
    expect(byGeoid.get("33540")?.seats).toBe(4);
  });

  it("keeps any district type another migration added when it widens the checks", () => {
    expect(MIGRATION_302_SQL).toContain("'state_executive_council' = ANY (allowed)");
    expect(MIGRATION_302_SQL).not.toMatch(/ADD CONSTRAINT chk_district_type CHECK \(\s*district_type IN/);
  });
});

describe("Executive Councilor office", () => {
  it("matches any title on a council district to the councilor seat", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM public.office_title_aliases")) {
        return { rows: [] };
      }
      return { rows: [{ id: "office-councilor", canonical_name: "Executive Councilor" }] };
    });
    const matcher = new OfficeMatcher({ query } as never);

    for (const title of ["Executive Councilor District 4", "Executive Council - District 4"]) {
      const result = await matcher.resolve({
        scope: "state_executive_council",
        districtName: "Executive Council District 4; New Hampshire",
        state: "NH",
        officialBallotTitle: title,
        discoveryContestFamily: "non_judicial_office",
      });
      expect(result.officeId, title).toBe("office-councilor");
    }
  });

  it("ranks the councilor race between statewide offices and the state senate", () => {
    const rank = (scope: string) =>
      stateBaselineContestRank({
        official_ballot_title: "Office",
        race_type: "office",
        discovery_contest_family: "non_judicial_office",
        district: {
          id: "11111111-1111-4111-8111-111111111111",
          district_type: scope,
          geoid_compact: "33EC4",
          name: "Executive Council District 4; New Hampshire",
          state: "NH",
          state_fips: "33",
          representation_power_score: null,
          population: null,
        },
        office: null,
      } as never);

    expect(rank("statewide")).toBeLessThan(rank("state_executive_council"));
    expect(rank("state_executive_council")).toBeLessThan(rank("state_upper"));
  });
});
