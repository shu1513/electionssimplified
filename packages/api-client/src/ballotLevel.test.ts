import { describe, expect, it } from "vitest";

import { ballotLevel } from "./ballotLevel";

describe("ballotLevel", () => {
  it("keys on office scope with district type as the fallback", () => {
    expect(ballotLevel("us_house", "us_house", "non_judicial_office")).toBe("federal");
    expect(ballotLevel("statewide", "statewide", "us_senate")).toBe("federal");
    expect(ballotLevel(undefined, "county", "ballot_measure")).toBe("county");
    expect(ballotLevel("school_unified", "school_unified")).toBe("city");
  });

  it("puts Colorado's congressional-district board seats under State", () => {
    // Their offices are scope "us_house" (one seat per congressional
    // district), but they are state offices.
    expect(ballotLevel("us_house", "us_house", "non_judicial_office", "State Board of Regents Member")).toBe("state");
    expect(ballotLevel("us_house", "us_house", "non_judicial_office", "State Board of Education Member")).toBe(
      "state"
    );
    expect(ballotLevel("us_house", "us_house", "non_judicial_office", "United States Representative")).toBe(
      "federal"
    );
  });
});
