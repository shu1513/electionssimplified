import { describe, expect, it } from "vitest";

import { stateBaselineContestRank } from "../../../src/pipeline/address/ballotContestRank.js";
import type { BallotLookupElectionSummary } from "../../../src/pipeline/address/ballotLookup.js";

type RankInput = Pick<
  BallotLookupElectionSummary,
  "race_type" | "discovery_contest_family" | "district" | "office" | "official_ballot_title"
>;

function input(overrides: {
  race_type?: string;
  contest_family?: string | null;
  office_scope?: string | null;
  district_type?: string;
  title?: string;
}): RankInput {
  return {
    official_ballot_title: overrides.title ?? "Office Title",
    race_type: (overrides.race_type ?? "office") as RankInput["race_type"],
    discovery_contest_family: (overrides.contest_family ??
      "non_judicial_office") as RankInput["discovery_contest_family"],
    district: {
      id: "11111111-1111-4111-8111-111111111111",
      district_type: (overrides.district_type ?? "county") as RankInput["district"]["district_type"],
      geoid_compact: "06037",
      name: "Los Angeles County",
      state: "CA",
      state_fips: "06",
      representation_power_score: null,
      population: null,
    },
    office: overrides.office_scope
      ? {
          id: "12121212-1212-4212-8212-121212121212",
          scope: overrides.office_scope as NonNullable<RankInput["office"]>["scope"],
          canonical_name: "Office",
          summary: "",
        }
      : null,
  };
}

describe("stateBaselineContestRank", () => {
  it("ranks the generic ballot order: federal, statewide, legislature, county, municipal, school, measures", () => {
    const ranks = [
      input({ office_scope: "presidential" }),
      input({ office_scope: "statewide", contest_family: "us_senate" }),
      input({ office_scope: "us_house" }),
      input({ office_scope: "statewide" }),
      input({ office_scope: "state_upper" }),
      input({ office_scope: "state_lower" }),
      input({ office_scope: "county" }),
      input({ office_scope: "place" }),
      input({ office_scope: "school_unified" }),
      input({ race_type: "ballot_measure", contest_family: "ballot_measure", office_scope: null }),
    ].map(stateBaselineContestRank);

    const sorted = [...ranks].sort((a, b) => a - b);
    expect(ranks).toEqual(sorted);
    // Strictly increasing: every tier is distinct.
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it("ranks ALL judicial races as a late block: after school, before unknown and measures, higher courts first", () => {
    const statewideJudge = stateBaselineContestRank(
      input({ office_scope: "statewide", contest_family: "judicial_office" })
    );
    const stateUpperJudge = stateBaselineContestRank(
      input({ office_scope: "state_upper", contest_family: "judicial_office" })
    );
    const stateLowerJudge = stateBaselineContestRank(
      input({ office_scope: "state_lower", contest_family: "judicial_office" })
    );
    const countyJudge = stateBaselineContestRank(
      input({ office_scope: "county", contest_family: "judicial_office" })
    );
    const placeJudge = stateBaselineContestRank(
      input({ office_scope: "place", contest_family: "judicial_office" })
    );

    // The whole block sits after every non-judicial office (majority US
    // pattern: retention sections and nonpartisan judicial sections print
    // after the partisan offices).
    expect(statewideJudge).toBeGreaterThan(stateBaselineContestRank(input({ office_scope: "school_unified" })));
    // Wider scopes first inside the block.
    expect(statewideJudge).toBeLessThan(stateUpperJudge);
    expect(stateUpperJudge).toBeLessThan(stateLowerJudge);
    expect(stateLowerJudge).toBeLessThan(countyJudge);
    expect(countyJudge).toBeLessThan(placeJudge);
    // Still before the unknown-scope sink and measures.
    expect(placeJudge).toBeLessThan(stateBaselineContestRank(input({ office_scope: "something_new" })));
    expect(placeJudge).toBeLessThan(
      stateBaselineContestRank(input({ race_type: "ballot_measure", office_scope: null }))
    );
    // A judicial race with an unmodeled scope stays in the judicial block.
    const unknownJudge = stateBaselineContestRank(
      input({ office_scope: "something_new", contest_family: "judicial_office" })
    );
    expect(unknownJudge).toBeGreaterThan(placeJudge);
    expect(unknownJudge).toBeLessThan(stateBaselineContestRank(input({ office_scope: "something_new" })));
  });

  it("orders same-tier judicial races supreme, then appeals, then everything else — never by title alphabet", () => {
    const supreme = stateBaselineContestRank(
      input({
        office_scope: "statewide",
        contest_family: "judicial_office",
        title: "Justice of the Supreme Court Seat 2",
      })
    );
    const appeals = stateBaselineContestRank(
      input({
        office_scope: "statewide",
        contest_family: "judicial_office",
        title: "Judge of the Court of Appeals Seat 4",
      })
    );
    const other = stateBaselineContestRank(
      input({
        office_scope: "county",
        contest_family: "judicial_office",
        title: "District Court Judge District 26 Seat 13",
      })
    );
    // Alphabetically "Court of Appeals" precedes "Supreme" — the court
    // offset must beat the generic title tie-break.
    expect(supreme).toBeLessThan(appeals);
    // Offsets stay inside their scope tier: a statewide non-supreme court
    // never crosses into the next judicial tier.
    expect(appeals).toBeLessThan(
      stateBaselineContestRank(input({ office_scope: "state_upper", contest_family: "judicial_office" }))
    );
    // The offset applies within lower tiers too (county "Supreme Court"
    // exists — NY's trial court — and prints before other county courts).
    const countySupreme = stateBaselineContestRank(
      input({
        office_scope: "county",
        contest_family: "judicial_office",
        title: "Supreme Court Justice 5th Judicial District",
      })
    );
    expect(countySupreme).toBeLessThan(other);
    // Court words in a NON-judicial race change nothing.
    expect(
      stateBaselineContestRank(input({ office_scope: "county", title: "Clerk of the Supreme Court" }))
    ).toBe(stateBaselineContestRank(input({ office_scope: "county" })));
  });

  it("ranks Colorado's congressional-district board seats after statewide offices, not with the House seat", () => {
    const board = input({ office_scope: "us_house" });
    board.office = { ...board.office!, canonical_name: "State Board of Regents Member" };
    const rank = stateBaselineContestRank(board);
    expect(rank).toBeGreaterThan(stateBaselineContestRank(input({ office_scope: "statewide" })));
    expect(rank).toBeLessThan(stateBaselineContestRank(input({ office_scope: "state_upper" })));
  });

  it("falls back to the district type when the office is unresolved", () => {
    expect(stateBaselineContestRank(input({ office_scope: null, district_type: "us_house" }))).toBe(
      stateBaselineContestRank(input({ office_scope: "us_house" }))
    );
  });

  it("sorts unknown scopes just above measures instead of throwing", () => {
    const unknown = stateBaselineContestRank(input({ office_scope: "something_new" }));
    expect(unknown).toBeGreaterThan(stateBaselineContestRank(input({ office_scope: "school_unified" })));
    expect(unknown).toBeLessThan(
      stateBaselineContestRank(input({ race_type: "ballot_measure", office_scope: null }))
    );
  });
});
