import { describe, expect, it } from "vitest";

import { measureFundingIsEmpty, measureFundingSharedNote } from "./measureFunding";
import type { BallotMeasureFunding, BallotMeasureFundingSide } from "./types";

function side(overrides: Partial<BallotMeasureFundingSide> = {}): BallotMeasureFundingSide {
  return { total_raised: 0, shared_with_other_measures_raised: 0, top_donors: [], source_urls: [], ...overrides };
}

function funding(overrides: Partial<BallotMeasureFunding> = {}): BallotMeasureFunding {
  return { as_of: "2026-09-17", support: side(), oppose: side(), ...overrides };
}

describe("measureFundingSharedNote", () => {
  it("says how much came from groups that also work on other measures", () => {
    expect(measureFundingSharedNote(side({ total_raised: 5_006_868.25, shared_with_other_measures_raised: 3_727_713.25 }))).toBe(
      "$3,727,713 of this was raised by groups that also work on other measures."
    );
  });

  it("stays quiet when the shared part is small or the side is empty", () => {
    expect(measureFundingSharedNote(side({ total_raised: 8_057_060.18, shared_with_other_measures_raised: 7_573.61 }))).toBeNull();
    expect(measureFundingSharedNote(side())).toBeNull();
  });

  it("uses plain wording when all of the money is shared", () => {
    expect(measureFundingSharedNote(side({ total_raised: 100, shared_with_other_measures_raised: 100 }))).toBe(
      "The groups that raised this also work on other measures."
    );
  });
});

describe("measureFundingIsEmpty", () => {
  it("is true only when neither side reported money", () => {
    expect(measureFundingIsEmpty(funding())).toBe(true);
    expect(measureFundingIsEmpty(funding({ oppose: side({ total_raised: 1 }) }))).toBe(false);
  });
});
