import { describe, expect, it } from "vitest";

import { measureFundingIsEmpty, measureFundingSharedNote } from "./measureFunding";
import type { BallotMeasureFunding, BallotMeasureFundingSide } from "./types";

const DONOR = { name: "Brian Heywood", amount: 606_869, type: "individual" as const };

function side(overrides: Partial<BallotMeasureFundingSide> = {}): BallotMeasureFundingSide {
  return { shared_with_other_measures: false, top_donors: [], source_urls: [], ...overrides };
}

function funding(overrides: Partial<BallotMeasureFunding> = {}): BallotMeasureFunding {
  return { as_of: "2026-09-17", support: side(), oppose: side(), ...overrides };
}

describe("measureFundingSharedNote", () => {
  it("warns when the donors' money went to groups that also work on other measures", () => {
    expect(measureFundingSharedNote(side({ shared_with_other_measures: true, top_donors: [DONOR] }))).toBe(
      "Some of this money went to groups that also work on other measures."
    );
  });

  it("stays quiet when nothing is shared or there are no donors to qualify", () => {
    expect(measureFundingSharedNote(side({ top_donors: [DONOR] }))).toBeNull();
    expect(measureFundingSharedNote(side({ shared_with_other_measures: true }))).toBeNull();
  });
});

describe("measureFundingIsEmpty", () => {
  it("is true only when neither side has a donor", () => {
    expect(measureFundingIsEmpty(funding())).toBe(true);
    expect(measureFundingIsEmpty(funding({ oppose: side({ top_donors: [DONOR] }) }))).toBe(false);
  });
});
