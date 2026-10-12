import { describe, expect, it } from "vitest";

import { oregonVerifiedCandidateOfficeLine } from "../../../src/pipeline/oregonFinance/oregonVerifiedCandidateContext.js";

describe("verified Oregon candidate office context", () => {
  it("binds the local House label to Baker's published receiving office and seat", () => {
    expect(oregonVerifiedCandidateOfficeLine({ officeName: "State Lower Chamber Legislator", district: "40" }))
      .toBe("State Representative, 40th District");
    expect(oregonVerifiedCandidateOfficeLine({ officeName: "State Representative", district: "20" }))
      .toBe("State Representative, 20th District");
  });

  it("keeps Senate and House contexts distinct", () => {
    expect(oregonVerifiedCandidateOfficeLine({ officeName: "State Senator", district: "21" }))
      .toBe("State Senator, 21st District");
    expect(oregonVerifiedCandidateOfficeLine({ officeName: "State Lower Chamber Legislator", district: "21" }))
      .toBe("State Representative, 21st District");
  });

  it("preserves exact published ordinal endings", () => {
    for (const [district, line] of [["2", "2nd"], ["3", "3rd"], ["11", "11th"], ["12", "12th"], ["13", "13th"], ["23", "23rd"]]) {
      expect(oregonVerifiedCandidateOfficeLine({ officeName: "State Senator", district }))
        .toBe(`State Senator, ${line} District`);
    }
  });

  it("rejects unknown, missing and noncanonical legislative seats", () => {
    for (const district of [null, "", "0", "020", "20A", "20.0", " 20", "9007199254740992"]) {
      expect(oregonVerifiedCandidateOfficeLine({ officeName: "State Lower Chamber Legislator", district })).toBeNull();
    }
  });

  it("binds statewide offices only without a district", () => {
    for (const officeName of ["Governor", "Secretary of State", "Attorney General", "State Treasurer"]) {
      expect(oregonVerifiedCandidateOfficeLine({ officeName, district: null })).toBe(officeName);
      expect(oregonVerifiedCandidateOfficeLine({ officeName, district: "1" })).toBeNull();
      expect(oregonVerifiedCandidateOfficeLine({ officeName, district: "Statewide" })).toBeNull();
    }
  });

  it("does not infer unofficial office aliases or inherited object properties", () => {
    for (const officeName of ["State Rep.", "House", "Senator", "State Upper Chamber Legislator", "toString", "constructor"]) {
      expect(oregonVerifiedCandidateOfficeLine({ officeName, district: "20" })).toBeNull();
    }
  });
});
