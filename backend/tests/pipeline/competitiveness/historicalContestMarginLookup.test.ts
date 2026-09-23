import { describe, expect, it, vi } from "vitest";

import {
  calculateWeightedHistoricalContestMargin,
  HISTORICAL_CONTEST_WEIGHTED_MARGIN_METHOD,
  HISTORICAL_CONTEST_WEIGHTED_MARGIN_WEIGHTS,
  lookupHistoricalContestMarginRows,
  lookupHistoricalContestMargins,
  rerankHistoricalContestMarginForSeats,
  type HistoricalContestMarginLookupRecord,
} from "../../../src/pipeline/competitiveness/historicalContestMarginLookup.js";

function marginRow(
  overrides: Partial<HistoricalContestMarginLookupRecord> = {}
): HistoricalContestMarginLookupRecord {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    lookup_id: "ca-governor",
    source: "MIT_2024",
    source_url: "https://example.test/source.csv",
    election_year: 2024,
    state: "CA",
    state_fips: "06",
    office_type: "GOVERNOR",
    district_type: "statewide",
    district_key: "06",
    mit_office: "GOVERNOR",
    mit_district: "STATEWIDE",
    winner_party: "DEMOCRAT",
    runner_up_party: "REPUBLICAN",
    winner_votes: 600,
    runner_up_votes: 400,
    total_votes: 1000,
    margin_percent: 20,
    competitiveness_label: "safe",
    stale_after_redistricting: false,
    imported_at: "2026-06-14 12:00:00+00",
    candidate_lines: null,
    seats_ranked: 1,
    ...overrides,
  };
}

describe("historicalContestMarginLookup", () => {
  it("defines the weighted last-three margin contract", () => {
    expect(HISTORICAL_CONTEST_WEIGHTED_MARGIN_METHOD).toBe("weighted_last_3");
    expect(HISTORICAL_CONTEST_WEIGHTED_MARGIN_WEIGHTS).toEqual([0.5, 0.3, 0.2]);
  });

  it("calculates weighted margins from the latest three contests with 50-30-20 weights", () => {
    expect(
      calculateWeightedHistoricalContestMargin([
        marginRow({ id: "2022", election_year: 2022, margin_percent: 20, competitiveness_label: "safe" }),
        marginRow({ id: "2018", election_year: 2018, margin_percent: 10, competitiveness_label: "competitive" }),
        marginRow({ id: "2014", election_year: 2014, margin_percent: 2, competitiveness_label: "toss_up" }),
      ])
    ).toMatchObject({
      lookup_id: "ca-governor",
      method: "weighted_last_3",
      weights: [0.5, 0.3, 0.2],
      election_years: [2022, 2018, 2014],
      margin_percent: 13.4,
      competitiveness_label: "somewhat_competitive",
      stale_after_redistricting: false,
      contests_used: [
        { election_year: 2022, margin_percent: 20, weight: 0.5 },
        { election_year: 2018, margin_percent: 10, weight: 0.3 },
        { election_year: 2014, margin_percent: 2, weight: 0.2 },
      ],
    });
  });

  it("renormalizes weights when only two contests exist", () => {
    expect(
      calculateWeightedHistoricalContestMargin([
        marginRow({ id: "2022", election_year: 2022, margin_percent: 20 }),
        marginRow({ id: "2018", election_year: 2018, margin_percent: 4, competitiveness_label: "very_competitive" }),
      ])
    ).toMatchObject({
      weights: [0.625, 0.375],
      election_years: [2022, 2018],
      margin_percent: 14,
      competitiveness_label: "somewhat_competitive",
      contests_used: [
        { election_year: 2022, weight: 0.625 },
        { election_year: 2018, weight: 0.375 },
      ],
    });
  });

  it("uses one contest as a pass-through weighted result", () => {
    expect(
      calculateWeightedHistoricalContestMargin([
        marginRow({ election_year: 2022, margin_percent: 4, competitiveness_label: "very_competitive" }),
      ])
    ).toMatchObject({
      weights: [1],
      election_years: [2022],
      margin_percent: 4,
      competitiveness_label: "very_competitive",
      contests_used: [{ election_year: 2022, weight: 1 }],
    });
  });

  it("sorts contests newest first and ignores rows after the first three", () => {
    expect(
      calculateWeightedHistoricalContestMargin([
        marginRow({ id: "2014", election_year: 2014, margin_percent: 2 }),
        marginRow({ id: "2010", election_year: 2010, margin_percent: 100 }),
        marginRow({ id: "2022", election_year: 2022, margin_percent: 20 }),
        marginRow({ id: "2018", election_year: 2018, margin_percent: 10 }),
      ])
    ).toMatchObject({
      election_years: [2022, 2018, 2014],
      margin_percent: 13.4,
    });
  });

  it("returns null when no historical contests are available", () => {
    expect(calculateWeightedHistoricalContestMargin([])).toBeNull();
  });

  it("does not query when no inputs can be mapped to historical contest keys", async () => {
    const query = vi.fn();

    const result = await lookupHistoricalContestMargins({ query } as never, [
      {
        lookupId: "county-commissioner",
        officeCanonicalName: "County Commissioner",
        districtType: "county",
        geoidCompact: "06037",
        stateFips: "06",
      },
      {
        lookupId: "blank",
        officeCanonicalName: "United States Representative",
        districtType: "county",
        geoidCompact: "06037",
        stateFips: "06",
      },
    ]);

    expect(result.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("builds batch lookup keys for supported current elections", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await lookupHistoricalContestMargins({ query } as never, [
      {
        lookupId: "house-ca-31",
        officeCanonicalName: "United States Representative",
        districtType: "us_house",
        geoidCompact: "0631",
        stateFips: "06",
        currentElectionYear: 2026,
        maxElectionYear: 2024,
      },
      {
        lookupId: "ca-senate",
        officeCanonicalName: "United States Senator",
        districtType: "statewide",
        geoidCompact: "06",
        stateFips: "06",
      },
    ]);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("jsonb_to_recordset");
    expect(query.mock.calls[0]?.[0]).toContain("ROW_NUMBER() OVER");
    expect(query.mock.calls[0]?.[0]).toContain("WHERE row_rank <= $2");
    expect(query.mock.calls[0]?.[1]?.[1]).toBe(HISTORICAL_CONTEST_WEIGHTED_MARGIN_WEIGHTS.length);
    expect(JSON.parse(query.mock.calls[0]?.[1]?.[0] as string)).toEqual([
      {
        lookup_id: "house-ca-31",
        min_election_year: 2022,
        max_election_year: 2024,
        state: "CA",
        state_fips: "06",
        office_type: "US_HOUSE",
        district_type: "us_house",
        district_key: "0631",
        mit_office: "US HOUSE",
        mit_district: "031",
      },
      {
        lookup_id: "ca-senate",
        min_election_year: null,
        max_election_year: null,
        state: "CA",
        state_fips: "06",
        office_type: "US_SENATE",
        district_type: "statewide",
        district_key: "06",
        mit_office: "US SENATE",
        mit_district: "STATEWIDE",
      },
    ]);
  });

  it("filters district history to the same post-redistricting cycle", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await lookupHistoricalContestMargins({ query } as never, [
      {
        lookupId: "house-ca-31-2032",
        officeCanonicalName: "United States Representative",
        districtType: "us_house",
        geoidCompact: "0631",
        stateFips: "06",
        currentElectionYear: 2032,
        maxElectionYear: 2031,
      },
    ]);

    expect(query.mock.calls[0]?.[0]).toContain("hcm.election_year >= key.min_election_year");
    expect(JSON.parse(query.mock.calls[0]?.[1]?.[0] as string)).toEqual([
      {
        lookup_id: "house-ca-31-2032",
        min_election_year: 2032,
        max_election_year: 2031,
        state: "CA",
        state_fips: "06",
        office_type: "US_HOUSE",
        district_type: "us_house",
        district_key: "0631",
        mit_office: "US HOUSE",
        mit_district: "031",
      },
    ]);
  });

  it("applies the same post-redistricting floor to state legislative weighted row lookups", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await lookupHistoricalContestMarginRows({ query } as never, [
      {
        lookupId: "ca-state-senate-22",
        officeCanonicalName: "State Senator",
        districtType: "state_upper",
        geoidCompact: "06022",
        stateFips: "06",
        currentElectionYear: 2026,
        maxElectionYear: 2024,
      },
      {
        lookupId: "ca-state-house-48",
        officeCanonicalName: "State Lower Chamber Legislator",
        districtType: "state_lower",
        geoidCompact: "06048",
        stateFips: "06",
        currentElectionYear: 2026,
        maxElectionYear: 2024,
      },
    ]);

    expect(JSON.parse(query.mock.calls[0]?.[1]?.[0] as string)).toEqual([
      {
        lookup_id: "ca-state-senate-22",
        min_election_year: 2022,
        max_election_year: 2024,
        state: "CA",
        state_fips: "06",
        office_type: "STATE_SENATE",
        district_type: "state_upper",
        district_key: "06022",
        mit_office: "STATE SENATE",
        mit_district: "022",
      },
      {
        lookup_id: "ca-state-house-48",
        min_election_year: 2022,
        max_election_year: 2024,
        state: "CA",
        state_fips: "06",
        office_type: "STATE_HOUSE",
        district_type: "state_lower",
        district_key: "06048",
        mit_office: "STATE HOUSE",
        mit_district: "048",
      },
    ]);
  });

  it("does not apply redistricting floors to statewide or county historical lookups", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await lookupHistoricalContestMarginRows({ query } as never, [
      {
        lookupId: "ca-governor",
        officeCanonicalName: "Governor",
        districtType: "statewide",
        geoidCompact: "06",
        stateFips: "06",
        currentElectionYear: 2026,
        maxElectionYear: 2024,
      },
      {
        lookupId: "la-sheriff",
        officeCanonicalName: "Sheriff",
        districtType: "county",
        geoidCompact: "06037",
        stateFips: "06",
        currentElectionYear: 2026,
        maxElectionYear: 2024,
      },
    ]);

    expect(JSON.parse(query.mock.calls[0]?.[1]?.[0] as string)).toEqual([
      {
        lookup_id: "ca-governor",
        min_election_year: null,
        max_election_year: 2024,
        state: "CA",
        state_fips: "06",
        office_type: "GOVERNOR",
        district_type: "statewide",
        district_key: "06",
        mit_office: "GOVERNOR",
        mit_district: "STATEWIDE",
      },
      {
        lookup_id: "la-sheriff",
        min_election_year: null,
        max_election_year: 2024,
        state: "CA",
        state_fips: "06",
        office_type: "COUNTY_SHERIFF",
        district_type: "county",
        district_key: "06037",
        mit_office: "COUNTY SHERIFF",
        mit_district: "06037",
      },
    ]);
  });

  it("returns matched historical margin rows keyed by lookup ID", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          lookup_id: "house-ca-31",
          source: "MIT_2024",
          source_url: "https://github.com/MEDSL/2024-elections-official",
          election_year: 2024,
          state: "CA",
          state_fips: "06",
          office_type: "US_HOUSE",
          district_type: "us_house",
          district_key: "0631",
          mit_office: "US HOUSE",
          mit_district: "031",
          winner_party: "DEMOCRAT",
          runner_up_party: "REPUBLICAN",
          winner_votes: "109200",
          runner_up_votes: "90800",
          total_votes: "200000",
          margin_percent: "9.20",
          competitiveness_label: "competitive",
          stale_after_redistricting: false,
          imported_at: "2026-06-14 12:00:00+00",
        },
      ],
    });

    const result = await lookupHistoricalContestMargins({ query } as never, [
      {
        lookupId: "house-ca-31",
        officeCanonicalName: "United States Representative",
        districtType: "us_house",
        geoidCompact: "0631",
        stateFips: "06",
      },
    ]);

    expect(result.get("house-ca-31")).toEqual({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      lookup_id: "house-ca-31",
      source: "MIT_2024",
      source_url: "https://github.com/MEDSL/2024-elections-official",
      election_year: 2024,
      state: "CA",
      state_fips: "06",
      office_type: "US_HOUSE",
      district_type: "us_house",
      district_key: "0631",
      mit_office: "US HOUSE",
      mit_district: "031",
      winner_party: "DEMOCRAT",
      runner_up_party: "REPUBLICAN",
      winner_votes: 109_200,
      runner_up_votes: 90_800,
      total_votes: 200_000,
      margin_percent: 9.2,
      competitiveness_label: "competitive",
      stale_after_redistricting: false,
      imported_at: "2026-06-14 12:00:00+00",
      candidate_lines: null,
      seats_ranked: 1,
    });
  });

  it("re-ranks a matched row for a multi-seat election so the margin is the last seat's", async () => {
    // Two seats: lines [0] and [1] both won. The stored 1st-vs-2nd pair says
    // "competitive" (50-40 of 102 = 9.8 points); the seat-deciding 2nd-vs-3rd
    // gap is 40-12 = 27.45 points, "safe".
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          lookup_id: "nd-house-47",
          source: "MIT_2024",
          source_url: null,
          election_year: 2024,
          state: "ND",
          state_fips: "38",
          office_type: "STATE_HOUSE",
          district_type: "state_lower",
          district_key: "38047",
          mit_office: "STATE HOUSE",
          mit_district: "047",
          winner_party: "REPUBLICAN",
          runner_up_party: "REPUBLICAN",
          winner_votes: "50",
          runner_up_votes: "40",
          total_votes: "102",
          margin_percent: "9.80",
          competitiveness_label: "competitive",
          stale_after_redistricting: false,
          imported_at: "2026-06-14 12:00:00+00",
          candidate_lines: [
            { votes: 50, party: "REPUBLICAN" },
            { votes: 40, party: "REPUBLICAN" },
            { votes: 12, party: "DEMOCRAT" },
          ],
        },
      ],
    });

    const result = await lookupHistoricalContestMarginRows({ query } as never, [
      {
        lookupId: "nd-house-47",
        officeCanonicalName: "State Lower Chamber Legislator",
        districtType: "state_lower",
        geoidCompact: "38047",
        stateFips: "38",
        seatsToFill: 2,
      },
    ]);

    expect(result.get("nd-house-47")?.[0]).toMatchObject({
      winner_party: "REPUBLICAN",
      runner_up_party: "DEMOCRAT",
      winner_votes: 40,
      runner_up_votes: 12,
      margin_percent: 27.45,
      competitiveness_label: "safe",
      seats_ranked: 2,
    });
  });

  it("keeps the stored pair when the row has no candidate lines or the election fills one seat", () => {
    const legacy = marginRow({ candidate_lines: null });
    expect(rerankHistoricalContestMarginForSeats(legacy, 2)).toBe(legacy);

    const withLines = marginRow({
      candidate_lines: [
        { votes: 600, party: "DEMOCRAT" },
        { votes: 400, party: "REPUBLICAN" },
      ],
    });
    expect(rerankHistoricalContestMarginForSeats(withLines, 1)).toBe(withLines);
    expect(rerankHistoricalContestMarginForSeats(withLines, null)).toBe(withLines);
  });

  it("grades a past multi-seat contest with no loser as safe", () => {
    // Two candidates for two seats: the last winner is measured against
    // zero, the same reading the single-seat path gives an unopposed race.
    const record = rerankHistoricalContestMarginForSeats(
      marginRow({
        candidate_lines: [
          { votes: 600, party: "DEMOCRAT" },
          { votes: 400, party: "REPUBLICAN" },
        ],
      }),
      2
    );
    expect(record).toMatchObject({
      winner_votes: 400,
      runner_up_votes: 0,
      runner_up_party: null,
      margin_percent: 40,
      competitiveness_label: "safe",
      seats_ranked: 2,
    });
  });

  it("returns up to three matched historical margin rows per lookup ID", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          lookup_id: "ca-governor",
          source: "MIT_2022",
          source_url: "https://example.test/2022.csv",
          election_year: 2022,
          state: "CA",
          state_fips: "06",
          office_type: "GOVERNOR",
          district_type: "statewide",
          district_key: "06",
          mit_office: "GOVERNOR",
          mit_district: "STATEWIDE",
          winner_party: "DEMOCRAT",
          runner_up_party: "REPUBLICAN",
          winner_votes: "600",
          runner_up_votes: "400",
          total_votes: "1000",
          margin_percent: "20.00",
          competitiveness_label: "safe",
          stale_after_redistricting: false,
          imported_at: "2026-06-14 12:00:00+00",
        },
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          lookup_id: "ca-governor",
          source: "MIT_2018",
          source_url: "https://example.test/2018.csv",
          election_year: 2018,
          state: "CA",
          state_fips: "06",
          office_type: "GOVERNOR",
          district_type: "statewide",
          district_key: "06",
          mit_office: "GOVERNOR",
          mit_district: "STATEWIDE",
          winner_party: "DEMOCRAT",
          runner_up_party: "REPUBLICAN",
          winner_votes: "550",
          runner_up_votes: "450",
          total_votes: "1000",
          margin_percent: "10.00",
          competitiveness_label: "competitive",
          stale_after_redistricting: false,
          imported_at: "2026-06-14 12:00:00+00",
        },
        {
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          lookup_id: "ca-governor",
          source: "MIT_2014",
          source_url: "https://example.test/2014.csv",
          election_year: 2014,
          state: "CA",
          state_fips: "06",
          office_type: "GOVERNOR",
          district_type: "statewide",
          district_key: "06",
          mit_office: "GOVERNOR",
          mit_district: "STATEWIDE",
          winner_party: "DEMOCRAT",
          runner_up_party: "REPUBLICAN",
          winner_votes: "510",
          runner_up_votes: "490",
          total_votes: "1000",
          margin_percent: "2.00",
          competitiveness_label: "toss_up",
          stale_after_redistricting: false,
          imported_at: "2026-06-14 12:00:00+00",
        },
      ],
    });

    const result = await lookupHistoricalContestMarginRows({ query } as never, [
      {
        lookupId: "ca-governor",
        officeCanonicalName: "Governor",
        districtType: "statewide",
        geoidCompact: "06",
        stateFips: "06",
        maxElectionYear: 2024,
      },
    ]);

    expect(result.get("ca-governor")?.map((row) => row.election_year)).toEqual([2022, 2018, 2014]);
    expect(result.get("ca-governor")?.map((row) => row.margin_percent)).toEqual([20, 10, 2]);
  });

  it("keeps the compatibility lookup returning only the latest row", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          lookup_id: "ca-governor",
          source: "MIT_2022",
          source_url: "https://example.test/2022.csv",
          election_year: 2022,
          state: "CA",
          state_fips: "06",
          office_type: "GOVERNOR",
          district_type: "statewide",
          district_key: "06",
          mit_office: "GOVERNOR",
          mit_district: "STATEWIDE",
          winner_party: "DEMOCRAT",
          runner_up_party: "REPUBLICAN",
          winner_votes: "600",
          runner_up_votes: "400",
          total_votes: "1000",
          margin_percent: "20.00",
          competitiveness_label: "safe",
          stale_after_redistricting: false,
          imported_at: "2026-06-14 12:00:00+00",
        },
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          lookup_id: "ca-governor",
          source: "MIT_2018",
          source_url: "https://example.test/2018.csv",
          election_year: 2018,
          state: "CA",
          state_fips: "06",
          office_type: "GOVERNOR",
          district_type: "statewide",
          district_key: "06",
          mit_office: "GOVERNOR",
          mit_district: "STATEWIDE",
          winner_party: "DEMOCRAT",
          runner_up_party: "REPUBLICAN",
          winner_votes: "550",
          runner_up_votes: "450",
          total_votes: "1000",
          margin_percent: "10.00",
          competitiveness_label: "competitive",
          stale_after_redistricting: false,
          imported_at: "2026-06-14 12:00:00+00",
        },
      ],
    });

    const result = await lookupHistoricalContestMargins({ query } as never, [
      {
        lookupId: "ca-governor",
        officeCanonicalName: "Governor",
        districtType: "statewide",
        geoidCompact: "06",
        stateFips: "06",
      },
    ]);

    expect(result.get("ca-governor")?.election_year).toBe(2022);
  });

  it("dedupes repeated lookup IDs after trimming", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await lookupHistoricalContestMargins({ query } as never, [
      {
        lookupId: " house-ca-31 ",
        officeCanonicalName: "United States Representative",
        districtType: "us_house",
        geoidCompact: "0631",
        stateFips: "06",
      },
      {
        lookupId: "house-ca-31",
        officeCanonicalName: "United States Representative",
        districtType: "us_house",
        geoidCompact: "0631",
        stateFips: "06",
      },
    ]);

    expect(JSON.parse(query.mock.calls[0]?.[1]?.[0] as string)).toHaveLength(1);
  });
});
