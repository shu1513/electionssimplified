import { describe, expect, it } from "vitest";

import { resolveCandidateResearchMode } from "../../src/ai/candidateResearchMode.js";

describe("resolveCandidateResearchMode on us_house rows", () => {
  it("keeps the House seat in federal House mode", () => {
    expect(
      resolveCandidateResearchMode({
        districtType: "us_house",
        officialBallotTitle: "Representative to the 120th United States Congress - District 2",
      })
    ).toBe("federal_us_house");
  });

  it("treats Colorado's congressional-district regent and State Board seats as state offices", () => {
    // These share the us_house row and say "Congressional District", but
    // their candidates have no FEC filings.
    for (const title of [
      "Regent of the University of Colorado - Congressional District 2",
      "State Board of Education Member - Congressional District 1",
    ]) {
      expect(resolveCandidateResearchMode({ districtType: "us_house", officialBallotTitle: title })).toBe(
        "state_level"
      );
    }
  });
});
