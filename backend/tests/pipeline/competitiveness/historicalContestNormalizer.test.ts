import { describe, expect, it } from "vitest";

import {
  normalizeMedslHistoricalContestMargins,
  type MedslHistoricalContestCandidateRow,
} from "../../../src/pipeline/competitiveness/historicalContestNormalizer.js";

function row(overrides: Partial<MedslHistoricalContestCandidateRow>): MedslHistoricalContestCandidateRow {
  return {
    year: 2024,
    state_po: "CA",
    state_fips: "06",
    office: "US HOUSE",
    district: "31",
    candidatevotes: 0,
    totalvotes: 0,
    party_simplified: null,
    ...overrides,
  };
}

describe("historicalContestNormalizer", () => {
  it("normalizes MEDSL candidate rows into historical contest margin records", () => {
    const result = normalizeMedslHistoricalContestMargins({
      source: "MIT_2024",
      sourceUrl: "https://github.com/MEDSL/2024-elections-official",
      rows: [
        row({ candidatevotes: "109200", totalvotes: "200000", party_simplified: "DEMOCRAT" }),
        row({ candidatevotes: "90800", totalvotes: "200000", party_simplified: "REPUBLICAN" }),
        row({ candidatevotes: "0", totalvotes: "200000", party_simplified: "OTHER" }),
      ],
    });

    expect(result.skippedRows).toEqual([]);
    expect(result.records).toEqual([
      {
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
        candidate_lines: [
          { votes: 109_200, party: "DEMOCRAT" },
          { votes: 90_800, party: "REPUBLICAN" },
          { votes: 0, party: "OTHER" },
        ],
      },
    ]);
  });

  it("keeps every candidate line sorted by votes so a multi-seat lookup can re-rank", () => {
    // A two-seat district: the top two both won, so the seat-deciding
    // margin is line [1] vs line [2], which only the full list can give.
    const result = normalizeMedslHistoricalContestMargins({
      source: "MIT_2024",
      rows: [
        row({ office: "STATE HOUSE", district: "47", candidate: "A", candidatevotes: 40, totalvotes: 100, party_simplified: "REPUBLICAN" }),
        row({ office: "STATE HOUSE", district: "47", candidate: "B", candidatevotes: 20, totalvotes: 100, party_simplified: "DEMOCRAT" }),
        row({ office: "STATE HOUSE", district: "47", candidate: "C", candidatevotes: 30, totalvotes: 100, party_simplified: "REPUBLICAN" }),
        row({ office: "STATE HOUSE", district: "47", candidate: "D", candidatevotes: 10, totalvotes: 100, party_simplified: "DEMOCRAT" }),
      ],
    });

    expect(result.records[0]?.candidate_lines).toEqual([
      { votes: 40, party: "REPUBLICAN" },
      { votes: 30, party: "REPUBLICAN" },
      { votes: 20, party: "DEMOCRAT" },
      { votes: 10, party: "DEMOCRAT" },
    ]);
    // The stored pair is still the single-seat reading (1st vs 2nd).
    expect(result.records[0]).toMatchObject({ winner_votes: 40, runner_up_votes: 30, margin_percent: 10 });
  });

  it("aggregates fusion-voting party lines by candidate name before calculating margins", () => {
    const result = normalizeMedslHistoricalContestMargins({
      source: "MIT_2024",
      rows: [
        row({
          state_po: "NY",
          state_fips: "36",
          district: "10",
          candidate: "Jane Smith",
          candidatevotes: 110_000,
          totalvotes: 210_000,
          party_simplified: "DEMOCRAT",
        }),
        row({
          state_po: "NY",
          state_fips: "36",
          district: "10",
          candidate: " Jane   Smith ",
          candidatevotes: 10_000,
          totalvotes: 210_000,
          party_simplified: "WORKING FAMILIES",
        }),
        row({
          state_po: "NY",
          state_fips: "36",
          district: "10",
          candidate: "John Jones",
          candidatevotes: 90_000,
          totalvotes: 210_000,
          party_simplified: "REPUBLICAN",
        }),
      ],
    });

    expect(result.skippedRows).toEqual([]);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      state: "NY",
      state_fips: "36",
      district_key: "3610",
      winner_party: "DEMOCRAT",
      runner_up_party: "REPUBLICAN",
      winner_votes: 120_000,
      runner_up_votes: 90_000,
      margin_percent: 14.29,
      competitiveness_label: "somewhat_competitive",
    });
  });

  it("keeps unnamed candidate rows separate instead of merging blank names", () => {
    const result = normalizeMedslHistoricalContestMargins({
      source: "MIT_2024",
      rows: [
        row({ candidate: "", candidatevotes: 60, totalvotes: 100, party_simplified: "DEMOCRAT" }),
        row({ candidate: " ", candidatevotes: 25, totalvotes: 100, party_simplified: "OTHER" }),
        row({ candidate: "Republican Candidate", candidatevotes: 15, totalvotes: 100, party_simplified: "REPUBLICAN" }),
      ],
    });

    expect(result.records[0]).toMatchObject({
      winner_party: "DEMOCRAT",
      runner_up_party: "OTHER",
      winner_votes: 60,
      runner_up_votes: 25,
      margin_percent: 35,
      competitiveness_label: "safe",
    });
  });

  it("normalizes statewide MIT districts to the state GEOID", () => {
    const result = normalizeMedslHistoricalContestMargins({
      source: "MIT_2024",
      rows: [
        row({
          office: "US SENATE",
          district: "STATEWIDE",
          candidatevotes: 5_100_000,
          totalvotes: 10_000_000,
          party_simplified: "DEMOCRAT",
        }),
        row({
          office: "US SENATE",
          district: "STATEWIDE",
          candidatevotes: 4_900_000,
          totalvotes: 10_000_000,
          party_simplified: "REPUBLICAN",
        }),
      ],
    });

    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      office_type: "US_SENATE",
      district_type: "statewide",
      district_key: "06",
      mit_district: "STATEWIDE",
      margin_percent: 2,
      competitiveness_label: "toss_up",
    });
  });

  it("does not mark statewide contests stale after redistricting", () => {
    const result = normalizeMedslHistoricalContestMargins({
      source: "MIT_2020",
      staleAfterRedistricting: true,
      rows: [
        row({
          office: "GOVERNOR",
          district: "STATEWIDE",
          candidatevotes: 5_100_000,
          totalvotes: 10_000_000,
          party_simplified: "DEMOCRAT",
        }),
        row({
          office: "GOVERNOR",
          district: "STATEWIDE",
          candidatevotes: 4_900_000,
          totalvotes: 10_000_000,
          party_simplified: "REPUBLICAN",
        }),
      ],
    });

    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      office_type: "GOVERNOR",
      district_type: "statewide",
      stale_after_redistricting: false,
    });
  });

  it("normalizes safe statewide executive MIT office labels exactly", () => {
    const result = normalizeMedslHistoricalContestMargins({
      source: "MIT_2024",
      staleAfterRedistricting: true,
      rows: [
        row({
          office: "STATE TREASURER",
          district: "STATEWIDE",
          candidate: "Treasurer Candidate",
          candidatevotes: 550_000,
          totalvotes: 1_000_000,
          party_simplified: "DEMOCRAT",
        }),
        row({
          office: "STATE TREASURER",
          district: "STATEWIDE",
          candidate: "Other Treasurer Candidate",
          candidatevotes: 450_000,
          totalvotes: 1_000_000,
          party_simplified: "REPUBLICAN",
        }),
        row({
          office: "ATTORNEY GENERAL",
          district: "STATEWIDE",
          candidate: "Attorney Candidate",
          candidatevotes: 510_000,
          totalvotes: 1_000_000,
          party_simplified: "DEMOCRAT",
        }),
        row({
          office: "ATTORNEY GENERAL",
          district: "STATEWIDE",
          candidate: "Other Attorney Candidate",
          candidatevotes: 490_000,
          totalvotes: 1_000_000,
          party_simplified: "REPUBLICAN",
        }),
        row({
          office: "LABOR COMMISSIONER",
          district: "STATEWIDE",
          candidate: "Labor Candidate",
          candidatevotes: 580_000,
          totalvotes: 1_000_000,
          party_simplified: "DEMOCRAT",
        }),
        row({
          office: "LABOR COMMISSIONER",
          district: "STATEWIDE",
          candidate: "Other Labor Candidate",
          candidatevotes: 420_000,
          totalvotes: 1_000_000,
          party_simplified: "REPUBLICAN",
        }),
        row({
          office: "LAND COMMISSIONER",
          district: "STATEWIDE",
          candidate: "Land Candidate",
          candidatevotes: 570_000,
          totalvotes: 1_000_000,
          party_simplified: "DEMOCRAT",
        }),
        row({
          office: "LAND COMMISSIONER",
          district: "STATEWIDE",
          candidate: "Other Land Candidate",
          candidatevotes: 430_000,
          totalvotes: 1_000_000,
          party_simplified: "REPUBLICAN",
        }),
      ],
    });

    expect(result.skippedRows).toEqual([]);
    expect(result.records).toHaveLength(4);
    expect(result.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          office_type: "STATE_TREASURER",
          district_type: "statewide",
          district_key: "06",
          mit_office: "STATE TREASURER",
          mit_district: "STATEWIDE",
          stale_after_redistricting: false,
          margin_percent: 10,
        }),
        expect.objectContaining({
          office_type: "ATTORNEY_GENERAL",
          district_type: "statewide",
          district_key: "06",
          mit_office: "ATTORNEY GENERAL",
          mit_district: "STATEWIDE",
          stale_after_redistricting: false,
          margin_percent: 2,
        }),
        expect.objectContaining({
          office_type: "LABOR_COMMISSIONER",
          district_type: "statewide",
          district_key: "06",
          mit_office: "LABOR COMMISSIONER",
          mit_district: "STATEWIDE",
          stale_after_redistricting: false,
          margin_percent: 16,
        }),
        expect.objectContaining({
          office_type: "LAND_COMMISSIONER",
          district_type: "statewide",
          district_key: "06",
          mit_office: "LAND COMMISSIONER",
          mit_district: "STATEWIDE",
          stale_after_redistricting: false,
          margin_percent: 14,
        }),
      ])
    );
  });

  it("normalizes selected exact statewide executive label variants", () => {
    const result = normalizeMedslHistoricalContestMargins({
      source: "MIT_2024",
      rows: [
        row({
          office: "TREASURER OF STATE",
          district: "STATEWIDE",
          candidate: "Candidate One",
          candidatevotes: 60,
          totalvotes: 100,
          party_simplified: "DEMOCRAT",
        }),
        row({
          office: "TREASURER OF STATE",
          district: "STATEWIDE",
          candidate: "Candidate Two",
          candidatevotes: 40,
          totalvotes: 100,
          party_simplified: "REPUBLICAN",
        }),
        row({
          office: "STATE CONTROLLER",
          district: "STATEWIDE",
          candidate: "Controller Candidate",
          candidatevotes: 55,
          totalvotes: 100,
          party_simplified: "DEMOCRAT",
        }),
        row({
          office: "STATE CONTROLLER",
          district: "STATEWIDE",
          candidate: "Other Controller Candidate",
          candidatevotes: 45,
          totalvotes: 100,
          party_simplified: "REPUBLICAN",
        }),
        row({
          office: "COMMISSIONER OF INSURANCE",
          district: "STATEWIDE",
          candidate: "Insurance Candidate",
          candidatevotes: 53,
          totalvotes: 100,
          party_simplified: "DEMOCRAT",
        }),
        row({
          office: "COMMISSIONER OF INSURANCE",
          district: "STATEWIDE",
          candidate: "Other Insurance Candidate",
          candidatevotes: 47,
          totalvotes: 100,
          party_simplified: "REPUBLICAN",
        }),
        row({
          office: "COMMISSIONER OF LABOR AND INDUSTRIES",
          district: "STATEWIDE",
          candidate: "Labor Candidate",
          candidatevotes: 56,
          totalvotes: 100,
          party_simplified: "DEMOCRAT",
        }),
        row({
          office: "COMMISSIONER OF LABOR AND INDUSTRIES",
          district: "STATEWIDE",
          candidate: "Other Labor Candidate",
          candidatevotes: 44,
          totalvotes: 100,
          party_simplified: "REPUBLICAN",
        }),
        row({
          office: "COMMISSIONER OF THE GENERAL LAND OFFICE",
          district: "STATEWIDE",
          candidate: "Land Candidate",
          candidatevotes: 54,
          totalvotes: 100,
          party_simplified: "DEMOCRAT",
        }),
        row({
          office: "COMMISSIONER OF THE GENERAL LAND OFFICE",
          district: "STATEWIDE",
          candidate: "Other Land Candidate",
          candidatevotes: 46,
          totalvotes: 100,
          party_simplified: "REPUBLICAN",
        }),
      ],
    });

    expect(result.skippedRows).toEqual([]);
    expect(result.records.map((record) => record.office_type).sort()).toEqual([
      "COMMISSIONER_OF_INSURANCE",
      "COMPTROLLER",
      "LABOR_COMMISSIONER",
      "LAND_COMMISSIONER",
      "STATE_TREASURER",
    ]);
  });

  it("normalizes canonical countywide office labels with county FIPS districts", () => {
    const result = normalizeMedslHistoricalContestMargins({
      source: "MIT_2024",
      staleAfterRedistricting: true,
      rows: [
        row({
          state_po: "WA",
          state_fips: "53",
          office: "COUNTY SHERIFF",
          district: "53011",
          candidate: "Sheriff Candidate",
          candidatevotes: 56_000,
          totalvotes: 100_000,
          party_simplified: "DEMOCRAT",
        }),
        row({
          state_po: "WA",
          state_fips: "53",
          office: "COUNTY SHERIFF",
          district: "53011",
          candidate: "Other Sheriff Candidate",
          candidatevotes: 44_000,
          totalvotes: 100_000,
          party_simplified: "REPUBLICAN",
        }),
        row({
          state_po: "WA",
          state_fips: "53",
          office: "DISTRICT ATTORNEY",
          district: "53033",
          candidate: "Prosecutor Candidate",
          candidatevotes: 52_000,
          totalvotes: 100_000,
          party_simplified: "DEMOCRAT",
        }),
        row({
          state_po: "WA",
          state_fips: "53",
          office: "DISTRICT ATTORNEY",
          district: "53033",
          candidate: "Other Prosecutor Candidate",
          candidatevotes: 48_000,
          totalvotes: 100_000,
          party_simplified: "REPUBLICAN",
        }),
      ],
    });

    expect(result.skippedRows).toEqual([]);
    expect(result.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "WA",
          state_fips: "53",
          office_type: "COUNTY_SHERIFF",
          district_type: "county",
          district_key: "53011",
          mit_office: "COUNTY SHERIFF",
          mit_district: "53011",
          margin_percent: 12,
          stale_after_redistricting: false,
        }),
        expect.objectContaining({
          state: "WA",
          state_fips: "53",
          office_type: "DISTRICT_ATTORNEY",
          district_type: "county",
          district_key: "53033",
          mit_office: "DISTRICT ATTORNEY",
          mit_district: "53033",
          margin_percent: 4,
          stale_after_redistricting: false,
        }),
      ])
    );
  });

  it("does not normalize generic, local, or ambiguous statewide executive-looking office labels", () => {
    const result = normalizeMedslHistoricalContestMargins({
      source: "MIT_2024",
      rows: [
        row({ office: "TREASURER", district: "STATEWIDE", candidatevotes: 60, totalvotes: 100 }),
        row({ office: "COUNTY TREASURER", district: "STATEWIDE", candidatevotes: 60, totalvotes: 100 }),
        row({ office: "AUDITOR", district: "STATEWIDE", candidatevotes: 60, totalvotes: 100 }),
        row({ office: "COUNTY AUDITOR", district: "STATEWIDE", candidatevotes: 60, totalvotes: 100 }),
        row({ office: "CONTROLLER", district: "STATEWIDE", candidatevotes: 60, totalvotes: 100 }),
        row({ office: "COMMISSIONER", district: "STATEWIDE", candidatevotes: 60, totalvotes: 100 }),
        row({ office: "LABOR", district: "STATEWIDE", candidatevotes: 60, totalvotes: 100 }),
        row({ office: "LAND", district: "STATEWIDE", candidatevotes: 60, totalvotes: 100 }),
        row({ office: "PUBLIC LANDS BOARD", district: "STATEWIDE", candidatevotes: 60, totalvotes: 100 }),
        row({ office: "CORPORATION COMMISSIONER", district: "STATEWIDE", candidatevotes: 60, totalvotes: 100 }),
        row({ office: "PUBLIC SERVICE COMMISSIONER", district: "STATEWIDE", candidatevotes: 60, totalvotes: 100 }),
        row({ office: "PRESIDENT, PUBLIC SERVICE COMMISSION", district: "STATEWIDE", candidatevotes: 60, totalvotes: 100 }),
        row({ office: "REGISTERED VOTERS", district: "STATEWIDE", candidatevotes: 60, totalvotes: 100 }),
      ],
    });

    expect(result.records).toEqual([]);
    expect(result.skippedRows.map((skipped) => skipped.reason)).toEqual([
      "unsupported_office",
      "invalid_district",
      "unsupported_office",
      "invalid_district",
      "unsupported_office",
      "unsupported_office",
      "unsupported_office",
      "unsupported_office",
      "unsupported_office",
      "unsupported_office",
      "unsupported_office",
      "unsupported_office",
      "unsupported_office",
    ]);
  });

  it("skips recognized offices that are outside the source allowlist", () => {
    const result = normalizeMedslHistoricalContestMargins({
      source: "MIT_2024",
      officeTypes: ["GOVERNOR"],
      rows: [
        row({
          office: "US PRESIDENT",
          district: "STATEWIDE",
          candidate: "Presidential Candidate",
          candidatevotes: 6_000_000,
          totalvotes: 10_000_000,
          party_simplified: "DEMOCRAT",
        }),
        row({
          office: "US PRESIDENT",
          district: "STATEWIDE",
          candidate: "Other Presidential Candidate",
          candidatevotes: 4_000_000,
          totalvotes: 10_000_000,
          party_simplified: "REPUBLICAN",
        }),
        row({
          office: "GOVERNOR",
          district: "STATEWIDE",
          candidate: "Governor Candidate",
          candidatevotes: 5_500_000,
          totalvotes: 10_000_000,
          party_simplified: "DEMOCRAT",
        }),
        row({
          office: "GOVERNOR",
          district: "STATEWIDE",
          candidate: "Other Governor Candidate",
          candidatevotes: 4_500_000,
          totalvotes: 10_000_000,
          party_simplified: "REPUBLICAN",
        }),
      ],
    });

    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      office_type: "GOVERNOR",
      district_type: "statewide",
      district_key: "06",
      margin_percent: 10,
    });
    expect(result.skippedRows).toHaveLength(2);
    expect(result.skippedRows.map((skipped) => skipped.reason)).toEqual([
      "excluded_office",
      "excluded_office",
    ]);
  });

  it("normalizes state legislative districts to five-character compact GEOIDs", () => {
    const result = normalizeMedslHistoricalContestMargins({
      source: "MIT_2024",
      staleAfterRedistricting: true,
      rows: [
        row({
          office: "STATE SENATE",
          district: "22",
          candidatevotes: 60_000,
          totalvotes: 100_000,
          party_simplified: "DEMOCRAT",
        }),
        row({
          office: "STATE SENATE",
          district: "022",
          candidatevotes: 40_000,
          totalvotes: 100_000,
          party_simplified: "REPUBLICAN",
        }),
      ],
    });

    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      office_type: "STATE_SENATE",
      district_type: "state_upper",
      district_key: "06022",
      mit_district: "022",
      margin_percent: 20,
      competitiveness_label: "safe",
      stale_after_redistricting: true,
    });
  });

  it("uses party_detailed when party_simplified is blank", () => {
    const result = normalizeMedslHistoricalContestMargins({
      source: "MIT_2024",
      rows: [
        row({ candidatevotes: 60, totalvotes: 100, party_simplified: "", party_detailed: "Democratic-Farmer-Labor" }),
        row({ candidatevotes: 40, totalvotes: 100, party_simplified: "Republican" }),
      ],
    });

    expect(result.records[0]?.winner_party).toBe("DEMOCRATIC-FARMER-LABOR");
    expect(result.records[0]?.runner_up_party).toBe("REPUBLICAN");
  });

  it("handles uncontested contests by comparing the winner against zero runner-up votes", () => {
    const result = normalizeMedslHistoricalContestMargins({
      source: "MIT_2024",
      rows: [
        row({
          office: "GOVERNOR",
          district: "STATEWIDE",
          candidatevotes: 100,
          totalvotes: 100,
          party_simplified: "DEMOCRAT",
        }),
      ],
    });

    expect(result.records[0]).toMatchObject({
      runner_up_party: null,
      runner_up_votes: 0,
      margin_percent: 100,
      competitiveness_label: "safe",
    });
  });

  it("reports contest-level invalid vote totals as skipped rows", () => {
    const result = normalizeMedslHistoricalContestMargins({
      source: "MIT_2024",
      rows: [
        row({ candidate: "Candidate One", candidatevotes: 60, totalvotes: 100, party_simplified: "DEMOCRAT" }),
        row({ candidate: "Candidate Two", candidatevotes: 50, totalvotes: 100, party_simplified: "REPUBLICAN" }),
      ],
    });

    expect(result.records).toEqual([]);
    expect(result.skippedRows).toHaveLength(2);
    expect(result.skippedRows.map((skipped) => skipped.reason)).toEqual(["invalid_votes", "invalid_votes"]);
    expect(result.skippedRows.map((skipped) => skipped.row.candidate)).toEqual(["Candidate One", "Candidate Two"]);
  });

  it("skips unsupported and malformed rows without throwing", () => {
    const result = normalizeMedslHistoricalContestMargins({
      source: "MIT_2024",
      rows: [
        row({ office: "SHERIFF", candidatevotes: 100, totalvotes: 200 }),
        row({ stage: "PRI", candidatevotes: 100, totalvotes: 200 }),
        row({ state_fips: "99", candidatevotes: 100, totalvotes: 200 }),
        row({ district: "AT-LARGE", candidatevotes: 100, totalvotes: 200 }),
        row({ candidatevotes: "10abc", totalvotes: 200 }),
      ],
    });

    expect(result.records).toEqual([]);
    expect(result.skippedRows.map((skipped) => skipped.reason)).toEqual([
      "unsupported_office",
      "non_general_stage",
      "invalid_state",
      "invalid_district",
      "invalid_votes",
    ]);
  });

  it("marks every row skipped when source is blank", () => {
    const result = normalizeMedslHistoricalContestMargins({
      source: " ",
      rows: [row({ candidatevotes: 100, totalvotes: 200 })],
    });

    expect(result.records).toEqual([]);
    expect(result.skippedRows).toHaveLength(1);
    expect(result.skippedRows[0]?.reason).toBe("invalid_source");
  });
});
