import { describe, expect, it } from "vitest";

import { hasSpecialSeatMarker, isShadowDelegationTitle, isUsSenateOfficeTitle } from "../../src/utils/senateOffice.js";

describe("senateOffice utils", () => {
  it("detects U.S. Senate office titles", () => {
    expect(isUsSenateOfficeTitle("United States Senator")).toBe(true);
    expect(isUsSenateOfficeTitle("U.S. Senator (Unexpired Term)")).toBe(true);
    expect(isUsSenateOfficeTitle("Governor")).toBe(false);
  });

  it("does not treat DC's statehood (shadow) delegation as a seat in Congress", () => {
    for (const title of ["United States Senator (Shadow)", "U.S. Shadow Senator", "Statehood Senator"]) {
      expect(isShadowDelegationTitle(title)).toBe(true);
      expect(isUsSenateOfficeTitle(title)).toBe(false);
    }
    expect(isShadowDelegationTitle("United States Representative (Shadow)")).toBe(true);
    expect(isShadowDelegationTitle("United States Senator")).toBe(false);
    expect(isShadowDelegationTitle("Shadow Lake Township Supervisor")).toBe(false);
  });

  it("detects special seat markers", () => {
    expect(
      hasSpecialSeatMarker({
        official_ballot_title: "United States Senator (Unexpired Term)",
        description: "Fills a vacancy for remainder of term.",
        election_stage: "general",
      })
    ).toBe(true);

    expect(
      hasSpecialSeatMarker({
        official_ballot_title: "United States Senator",
        description: "Regular six-year term.",
        election_stage: "general",
      })
    ).toBe(false);
  });
});
