import { describe, expect, it } from "vitest";

import {
  WASHINGTON_FINANCE_ELIGIBLE_OFFICE_KEYS,
  isWashingtonFinanceEligibleOffice,
  mapWashingtonPdcOffice,
  normalizeWashingtonPdcJurisdiction,
  normalizeWashingtonPdcLegislativeDistrict,
  normalizeWashingtonPdcOfficeLabel,
  normalizeWashingtonPdcPosition,
  parseWashingtonPositionFromBallotTitle,
  toWashingtonFinanceOfficeKey,
  toWashingtonPdcOfficeSearchInput,
} from "../../../src/pipeline/washingtonFinance/washingtonFinanceEligibleOffices.js";

describe("washingtonFinanceEligibleOffices", () => {
  it("keeps a conservative explicit Washington finance office allowlist", () => {
    expect(WASHINGTON_FINANCE_ELIGIBLE_OFFICE_KEYS).toEqual([
      "statewide::Governor",
      "statewide::Lieutenant Governor",
      "statewide::Secretary of State",
      "statewide::Attorney General",
      "statewide::State Treasurer",
      "statewide::State Auditor",
      "statewide::Land Commissioner",
      "statewide::Commissioner of Insurance",
      "statewide::Superintendent of Public Instruction",
      "statewide::State Level Judge",
      "state_upper::State Senator",
      "state_lower::State Lower Chamber Legislator",
      "place::Mayor",
      "place::City Council Member",
      "place::Municipal Attorney",
      "place::Place Level Judge",
    ]);
  });

  it("allows every explicit eligible office and rejects broad-scope guesses", () => {
    for (const key of WASHINGTON_FINANCE_ELIGIBLE_OFFICE_KEYS) {
      const [officeScope, officeCanonicalName] = key.split("::");
      expect(isWashingtonFinanceEligibleOffice({ officeScope, officeCanonicalName })).toBe(true);
    }

    expect(
      isWashingtonFinanceEligibleOffice({
        officeScope: "statewide",
        officeCanonicalName: "Public Service Commissioner",
      })
    ).toBe(false);
    expect(
      isWashingtonFinanceEligibleOffice({
        officeScope: "statewide",
        officeCanonicalName: "State Supreme Court Justice",
      })
    ).toBe(false);
    expect(
      isWashingtonFinanceEligibleOffice({
        officeScope: "county",
        officeCanonicalName: "County Commissioner",
      })
    ).toBe(false);
    expect(
      isWashingtonFinanceEligibleOffice({
        officeScope: "state_lower",
        officeCanonicalName: "State Senator",
      })
    ).toBe(false);
  });

  it("builds trimmed office keys and rejects missing parts", () => {
    expect(
      toWashingtonFinanceOfficeKey({
        officeScope: " statewide ",
        officeCanonicalName: " Governor ",
      })
    ).toBe("statewide::Governor");
    expect(toWashingtonFinanceOfficeKey({ officeScope: "", officeCanonicalName: "Governor" })).toBeNull();
    expect(toWashingtonFinanceOfficeKey({ officeScope: "statewide", officeCanonicalName: " " })).toBeNull();
  });

  it("normalizes PDC office labels and legislative districts conservatively", () => {
    expect(normalizeWashingtonPdcOfficeLabel(" public   lands commissioner ")).toBe("PUBLIC LANDS COMMISSIONER");
    expect(normalizeWashingtonPdcOfficeLabel("   ")).toBeNull();
    expect(normalizeWashingtonPdcLegislativeDistrict("1")).toBe("01");
    expect(normalizeWashingtonPdcLegislativeDistrict("01")).toBe("01");
    expect(normalizeWashingtonPdcLegislativeDistrict("LD 7")).toBe("07");
    expect(normalizeWashingtonPdcLegislativeDistrict("Leg District 12")).toBe("12");
    expect(normalizeWashingtonPdcLegislativeDistrict("53012")).toBeNull();
    expect(normalizeWashingtonPdcLegislativeDistrict("0")).toBeNull();
  });

  it("maps safe PDC statewide office labels to canonical app offices", () => {
    expect(mapWashingtonPdcOffice({ office: "PUBLIC LANDS COMMISSIONER" })).toEqual({
      officeScope: "statewide",
      officeCanonicalName: "Land Commissioner",
      officeKey: "statewide::Land Commissioner",
      pdcOffice: "PUBLIC LANDS COMMISSIONER",
      requiresLegislativeDistrict: false,
      legislativeDistrict: null,
      requiresJurisdiction: false,
      jurisdiction: null,
      position: null,
    });
    expect(mapWashingtonPdcOffice({ office: "INSURANCE COMMISSIONER" })).toMatchObject({
      officeScope: "statewide",
      officeCanonicalName: "Commissioner of Insurance",
      pdcOffice: "INSURANCE COMMISSIONER",
    });
    expect(mapWashingtonPdcOffice({ office: "SUPERINTENDENT OF PUBLIC INSTRUCTION" })).toMatchObject({
      officeCanonicalName: "Superintendent of Public Instruction",
    });
    // PDC 2026: Supreme Court races file as "STATE SUPREME COURT JUSTICE".
    expect(mapWashingtonPdcOffice({ office: "STATE SUPREME COURT JUSTICE", position: "1" })).toMatchObject({
      officeScope: "statewide",
      officeCanonicalName: "State Level Judge",
      officeKey: "statewide::State Level Judge",
    });
  });

  it("requires districts for PDC legislative offices", () => {
    expect(mapWashingtonPdcOffice({ office: "STATE SENATOR", legislativeDistrict: "3" })).toEqual({
      officeScope: "state_upper",
      officeCanonicalName: "State Senator",
      officeKey: "state_upper::State Senator",
      pdcOffice: "STATE SENATOR",
      requiresLegislativeDistrict: true,
      legislativeDistrict: "03",
      requiresJurisdiction: false,
      jurisdiction: null,
      position: null,
    });
    expect(mapWashingtonPdcOffice({ office: "STATE REPRESENTATIVE", legislativeDistrict: "04" })).toEqual({
      officeScope: "state_lower",
      officeCanonicalName: "State Lower Chamber Legislator",
      officeKey: "state_lower::State Lower Chamber Legislator",
      pdcOffice: "STATE REPRESENTATIVE",
      requiresLegislativeDistrict: true,
      legislativeDistrict: "04",
      requiresJurisdiction: false,
      jurisdiction: null,
      position: null,
    });

    expect(mapWashingtonPdcOffice({ office: "STATE SENATOR" })).toBeNull();
    expect(mapWashingtonPdcOffice({ office: "STATE REPRESENTATIVE", legislativeDistrict: "   " })).toBeNull();
  });

  it("maps app canonical offices to PDC search inputs", () => {
    expect(
      toWashingtonPdcOfficeSearchInput({
        officeScope: "statewide",
        officeCanonicalName: "Attorney General",
      })
    ).toEqual({
      pdcOffice: "ATTORNEY GENERAL",
      legislativeDistrict: null,
      requiresJurisdiction: false,
      jurisdiction: null,
      position: null,
    });
    expect(
      toWashingtonPdcOfficeSearchInput({
        officeScope: "statewide",
        officeCanonicalName: "Land Commissioner",
      })
    ).toEqual({
      pdcOffice: "PUBLIC LANDS COMMISSIONER",
      legislativeDistrict: null,
      requiresJurisdiction: false,
      jurisdiction: null,
      position: null,
    });
    expect(
      toWashingtonPdcOfficeSearchInput({
        officeScope: "state_lower",
        officeCanonicalName: "State Lower Chamber Legislator",
        legislativeDistrict: "9",
      })
    ).toEqual({
      pdcOffice: "STATE REPRESENTATIVE",
      legislativeDistrict: "09",
      requiresJurisdiction: false,
      jurisdiction: null,
      position: null,
    });
  });

  it("collapses PDC and VoteApp jurisdiction labels to one bare city key", () => {
    expect(normalizeWashingtonPdcJurisdiction("CITY OF SEATTLE")).toBe("SEATTLE");
    expect(normalizeWashingtonPdcJurisdiction("Seattle city, Washington")).toBe("SEATTLE");
    expect(normalizeWashingtonPdcJurisdiction("SEATTLE MUNICIPAL COURT")).toBe("SEATTLE");
    expect(normalizeWashingtonPdcJurisdiction("CITY OF AUBURN *")).toBe("AUBURN");
    expect(normalizeWashingtonPdcJurisdiction("TOWN OF STEILACOOM")).toBe("STEILACOOM");
    expect(normalizeWashingtonPdcJurisdiction("Federal Way city, Washington")).toBe("FEDERAL WAY");
    expect(normalizeWashingtonPdcJurisdiction("   ")).toBeNull();
    expect(normalizeWashingtonPdcJurisdiction(null)).toBeNull();
  });

  it("preserves place names that legitimately end in City or Town", () => {
    // Electric City and Coulee City are real WA municipalities: the
    // jurisdiction-type word may only be stripped alongside the state name,
    // never as a bare trailing token.
    expect(normalizeWashingtonPdcJurisdiction("CITY OF ELECTRIC CITY")).toBe("ELECTRIC CITY");
    expect(normalizeWashingtonPdcJurisdiction("Electric City city, Washington")).toBe("ELECTRIC CITY");
    expect(normalizeWashingtonPdcJurisdiction("ELECTRIC CITY MUNICIPAL COURT")).toBe("ELECTRIC CITY");
    expect(normalizeWashingtonPdcJurisdiction("TOWN OF COULEE CITY")).toBe("COULEE CITY");
    expect(normalizeWashingtonPdcJurisdiction("Coulee City town, Washington")).toBe("COULEE CITY");

    // Idempotent: the auto-link path normalizes once and the resolver
    // normalizes that result again.
    for (const raw of ["CITY OF ELECTRIC CITY", "Electric City city, Washington", "Seattle city, Washington"]) {
      const once = normalizeWashingtonPdcJurisdiction(raw);
      expect(normalizeWashingtonPdcJurisdiction(once)).toBe(once);
    }
  });

  it("normalizes PDC seat positions and parses ballot-title seats", () => {
    expect(normalizeWashingtonPdcPosition("5")).toBe("5");
    expect(normalizeWashingtonPdcPosition("05")).toBe("5");
    expect(normalizeWashingtonPdcPosition("Position 7")).toBe("7");
    // Composite seats (live 2025/26: Spokane, Puyallup, Camas, Chehalis, Deer
    // Park) keep every coordinate so District 1 Position 2 can never match
    // District 3 Position 2.
    expect(normalizeWashingtonPdcPosition("City Council Member District 3, Position 2")).toBe("3-2");
    expect(normalizeWashingtonPdcPosition("City Council Member District 1, Position 2 ")).toBe("1-2");
    expect(normalizeWashingtonPdcPosition("City Council Member Ward 3, Position 2")).toBe("3-2");
    expect(normalizeWashingtonPdcPosition("City Council Member At-Large Position 2")).toBe("2");
    expect(normalizeWashingtonPdcPosition("CITY COUNCIL MEMBER Position 6")).toBe("6");
    // No numbered seat token at all: seat requirement is disabled, not failed.
    expect(normalizeWashingtonPdcPosition("City Council Member At-Large Position")).toBeNull();
    expect(normalizeWashingtonPdcPosition("")).toBeNull();

    expect(parseWashingtonPositionFromBallotTitle("City of Seattle Council District No. 5")).toBe("5");
    expect(parseWashingtonPositionFromBallotTitle("Seattle Municipal Court Judge Position No. 5")).toBe("5");
    expect(parseWashingtonPositionFromBallotTitle("Council Position 9")).toBe("9");
    expect(parseWashingtonPositionFromBallotTitle("Council District No. 3, Position No. 2")).toBe("3-2");
    expect(parseWashingtonPositionFromBallotTitle("Mayor")).toBeNull();
    expect(parseWashingtonPositionFromBallotTitle(null)).toBeNull();
  });

  it("maps PDC city offices with a jurisdiction and rejects them without one", () => {
    expect(
      mapWashingtonPdcOffice({ office: "CITY COUNCIL MEMBER", jurisdiction: "CITY OF SEATTLE", position: "5" })
    ).toEqual({
      officeScope: "place",
      officeCanonicalName: "City Council Member",
      officeKey: "place::City Council Member",
      pdcOffice: "CITY COUNCIL MEMBER",
      requiresLegislativeDistrict: false,
      legislativeDistrict: null,
      requiresJurisdiction: true,
      jurisdiction: "SEATTLE",
      position: "5",
    });
    expect(
      mapWashingtonPdcOffice({ office: "MUNICIPAL COURT JUDGE", jurisdiction: "SEATTLE MUNICIPAL COURT", position: "5" })
    ).toMatchObject({
      officeCanonicalName: "Place Level Judge",
      jurisdiction: "SEATTLE",
      position: "5",
    });
    expect(mapWashingtonPdcOffice({ office: "MAYOR", jurisdiction: "CITY OF TACOMA" })).toMatchObject({
      officeCanonicalName: "Mayor",
      jurisdiction: "TACOMA",
      position: null,
    });
    expect(mapWashingtonPdcOffice({ office: "CITY ATTORNEY", jurisdiction: "CITY OF SEATTLE" })).toMatchObject({
      officeCanonicalName: "Municipal Attorney",
      jurisdiction: "SEATTLE",
    });

    expect(mapWashingtonPdcOffice({ office: "MAYOR" })).toBeNull();
    expect(mapWashingtonPdcOffice({ office: "CITY COUNCIL MEMBER", jurisdiction: "  " })).toBeNull();
  });

  it("maps app place offices to PDC search inputs and requires the district name", () => {
    expect(
      toWashingtonPdcOfficeSearchInput({
        officeScope: "place",
        officeCanonicalName: "City Council Member",
        jurisdiction: "Seattle city, Washington",
        position: "5",
      })
    ).toEqual({
      pdcOffice: "CITY COUNCIL MEMBER",
      legislativeDistrict: null,
      requiresJurisdiction: true,
      jurisdiction: "SEATTLE",
      position: "5",
    });
    expect(
      toWashingtonPdcOfficeSearchInput({
        officeScope: "place",
        officeCanonicalName: "Place Level Judge",
        jurisdiction: "Seattle city, Washington",
        position: "5",
      })
    ).toMatchObject({ pdcOffice: "MUNICIPAL COURT JUDGE", jurisdiction: "SEATTLE", position: "5" });
    expect(
      toWashingtonPdcOfficeSearchInput({
        officeScope: "place",
        officeCanonicalName: "Mayor",
        jurisdiction: "Seattle city, Washington",
      })
    ).toMatchObject({ pdcOffice: "MAYOR", jurisdiction: "SEATTLE", position: null });

    expect(
      toWashingtonPdcOfficeSearchInput({
        officeScope: "place",
        officeCanonicalName: "Mayor",
      })
    ).toBeNull();
  });

  it("rejects unsafe PDC labels and incomplete app search inputs", () => {
    expect(mapWashingtonPdcOffice({ office: "PUBLIC UTILITY COMMISSIONER" })).toBeNull();
    expect(mapWashingtonPdcOffice({ office: "APPEALS COURT JUDGE" })).toBeNull();
    expect(mapWashingtonPdcOffice({ office: "COUNTY SHERIFF" })).toBeNull();
    expect(mapWashingtonPdcOffice({ office: "" })).toBeNull();

    expect(
      toWashingtonPdcOfficeSearchInput({
        officeScope: "state_lower",
        officeCanonicalName: "State Lower Chamber Legislator",
      })
    ).toBeNull();
    expect(
      toWashingtonPdcOfficeSearchInput({
        officeScope: "statewide",
        officeCanonicalName: "State Supreme Court Justice",
      })
    ).toBeNull();
  });
});
