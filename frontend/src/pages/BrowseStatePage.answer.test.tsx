import { describe, expect, it } from "vitest";
import type { BrowseStateResponse } from "@voteapp/api-client";
import { stateAnswerText } from "./BrowseStatePage";

const KENTUCKY: BrowseStateResponse = {
  state: "KY",
  name: "Kentucky",
  districts: [
    { id: "d-place", name: "Franklin city, Kentucky", district_type: "place", election_count: 1, upcoming_election_count: 0, next_election_date: null },
    { id: "d-county", name: "Simpson County, Kentucky", district_type: "county", election_count: 3, upcoming_election_count: 2, next_election_date: "2026-11-03" },
    { id: "d-state", name: "Kentucky", district_type: "statewide", election_count: 2, upcoming_election_count: 1, next_election_date: "2026-05-19" },
  ],
};

describe("stateAnswerText", () => {
  it("sums the upcoming races, counts districts, and names the soonest election day", () => {
    expect(stateAnswerText(KENTUCKY)).toBe(
      "Elections Simplified tracks 3 upcoming elections across 3 districts in Kentucky, covering statewide, congressional, state legislative, county, city, and school board races. " +
        "The next election day is May 19, 2026. Each district page lists its races, the candidates, and their records."
    );
  });

  it("reads as past coverage when nothing is upcoming", () => {
    const past: BrowseStateResponse = {
      ...KENTUCKY,
      districts: [{ id: "d-place", name: "Franklin city, Kentucky", district_type: "place", election_count: 1, upcoming_election_count: 0, next_election_date: null }],
    };
    expect(stateAnswerText(past)).toBe(
      "Elections Simplified has researched 1 past election across 1 district in Kentucky, with no upcoming election on file yet. " +
        "Coverage spans statewide, congressional, state legislative, county, city, and school board races."
    );
  });
});
