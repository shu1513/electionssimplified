import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { lookupAddressDistricts } from "../../../src/pipeline/address/addressDistrictLookup.js";
import { stateBaselineContestRank } from "../../../src/pipeline/address/ballotContestRank.js";
import { OfficeMatcher } from "../../../src/pipeline/elections/officeMatcher.js";

const MIGRATION_397_SQL = readFileSync(
  new URL("../../../../db/migrations/397_add_mississippi_state_board_districts.sql", import.meta.url),
  "utf8"
);

function valuesRows(table: string): string[] {
  const start = MIGRATION_397_SQL.indexOf(`INSERT INTO ${table} `);
  expect(start, table).toBeGreaterThanOrEqual(0);
  const body = MIGRATION_397_SQL.slice(start, MIGRATION_397_SQL.indexOf(";\n", start));
  return body.split("\n").filter((line) => line.startsWith("    ("));
}

describe("migration 397 data", () => {
  it("puts each of Mississippi's 82 counties in exactly one of the three districts", () => {
    const counties = valuesRows("ms_board_counties").map((line) => {
      const match = /^\s+\((\d), '(\d{5})', '([^']+)'\)/.exec(line);
      expect(match, line).not.toBeNull();
      return { district: Number(match![1]), geoid: match![2], name: match![3] };
    });

    expect(counties).toHaveLength(82);
    expect(new Set(counties.map((county) => county.geoid)).size).toBe(82);
    expect(counties.every((county) => county.geoid.startsWith("28"))).toBe(true);
    // Miss. Code 9-3-1: 22 Central, 27 Southern, 33 Northern counties.
    expect([1, 2, 3].map((district) => counties.filter((county) => county.district === district).length)).toEqual([
      22, 27, 33,
    ]);
    expect(counties.find((county) => county.name === "Hinds")?.district).toBe(1);
    expect(counties.find((county) => county.name === "Harrison")?.district).toBe(2);
    expect(counties.find((county) => county.name === "DeSoto")?.district).toBe(3);
  });

  it("gives the three districts populations that add up to the state total", () => {
    const districts = valuesRows("ms_board_districts").map((line) => {
      const match = /^\s+\((\d), '(\w+)', (\d+)\)/.exec(line);
      expect(match, line).not.toBeNull();
      return { number: Number(match![1]), label: match![2], population: Number(match![3]) };
    });

    expect(districts.map((district) => district.label)).toEqual(["Central", "Southern", "Northern"]);
    expect(districts.reduce((sum, district) => sum + district.population, 0)).toBe(2_946_779);
  });

  it("widens the checks from their current value lists", () => {
    expect(MIGRATION_397_SQL).toContain("'state_board' = ANY (allowed)");
    expect(MIGRATION_397_SQL).toContain("'county' = ANY (allowed)");
  });
});

describe("lookupAddressDistricts: county-built districts", () => {
  it("checks the county as a component and returns the board district", async () => {
    const row = (overrides: Record<string, unknown>) => ({
      name: "x",
      state: "MS",
      state_fips: "28",
      population: 1000,
      representation_power_score: null,
      ...overrides,
    });
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        row({
          id: "hinds",
          district_type: "county",
          geoid_compact: "28049",
          requested_district_type: "county",
          requested_geoid_compact: "28049",
        }),
        row({
          id: "board-central",
          district_type: "state_board",
          geoid_compact: "28SB1",
          requested_district_type: null,
          requested_geoid_compact: null,
        }),
      ],
    });

    const result = await lookupAddressDistricts({ query }, [
      { district_type: "statewide", geoid_compact: "28" },
      { district_type: "county", geoid_compact: "28049" },
    ]);

    expect(query.mock.calls[0]?.[0]).toContain("JOIN public.district_components AS dc");
    expect(query.mock.calls[0]?.[1]).toEqual([
      ["statewide", "county"],
      ["28", "28049"],
      ["county"],
      ["28049"],
    ]);
    expect(result.districts.map((district) => district.id)).toEqual(["hinds", "board-central"]);
    expect(result.missing_district_keys).toEqual([{ district_type: "statewide", geoid_compact: "28" }]);
  });
});

describe("state_board offices", () => {
  const offices = [
    { id: "office-psc", canonical_name: "Public Service Commissioner" },
    { id: "office-transportation", canonical_name: "Transportation Commissioner" },
  ];
  const aliases = [
    { office_id: "office-psc", normalized_alias: "public service commissioner" },
    { office_id: "office-transportation", normalized_alias: "transportation commissioner" },
  ];

  it("matches each board's printed ballot title to its own office", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM public.office_title_aliases")) {
        return { rows: aliases };
      }
      return { rows: offices };
    });
    const matcher = new OfficeMatcher({ query } as never);

    const cases: Array<[string, string]> = [
      ["Public Service Commissioner - Northern District", "office-psc"],
      ["Transportation Commissioner - Central District", "office-transportation"],
    ];
    for (const [title, officeId] of cases) {
      const result = await matcher.resolve({
        scope: "state_board",
        districtName: "Northern District (Supreme Court District 3); Mississippi",
        state: "MS",
        officialBallotTitle: title,
        discoveryContestFamily: "non_judicial_office",
      });
      expect(result.officeId, title).toBe(officeId);
    }
  });

  it("ranks the board races between statewide offices and the state senate", () => {
    const rank = (scope: string) =>
      stateBaselineContestRank({
        official_ballot_title: "Office",
        race_type: "office",
        discovery_contest_family: "non_judicial_office",
        district: {
          id: "11111111-1111-4111-8111-111111111111",
          district_type: scope,
          geoid_compact: "28SB3",
          name: "Northern District (Supreme Court District 3); Mississippi",
          state: "MS",
          state_fips: "28",
          representation_power_score: null,
          population: null,
        },
        office: null,
      } as never);

    expect(rank("statewide")).toBeLessThan(rank("state_board"));
    expect(rank("state_board")).toBeLessThan(rank("state_upper"));
  });
});
