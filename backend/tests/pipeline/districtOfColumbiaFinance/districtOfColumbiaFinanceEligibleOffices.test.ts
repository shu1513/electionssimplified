import { describe, expect, it } from "vitest";

import {
  DISTRICT_OF_COLUMBIA_FINANCE_ELIGIBLE_OFFICE_KEYS,
  isDistrictOfColumbiaFinanceEligibleOffice,
  mapDistrictOfColumbiaOcfOffice,
  normalizeDistrictOfColumbiaOcfOfficeLabel,
  normalizeDistrictOfColumbiaOcfSeat,
  toDistrictOfColumbiaFinanceOfficeKey,
  toDistrictOfColumbiaOcfOfficeSearchInput,
} from "../../../src/pipeline/districtOfColumbiaFinance/districtOfColumbiaFinanceEligibleOffices.js";

describe("districtOfColumbiaFinanceEligibleOffices", () => {
  it("keeps a narrow explicit D.C. finance office allowlist", () => {
    expect(DISTRICT_OF_COLUMBIA_FINANCE_ELIGIBLE_OFFICE_KEYS).toEqual([
      "place::Mayor",
      "place::City Council Member",
      "state_upper::City Council Member",
      "statewide::Attorney General",
    ]);
    expect(
      isDistrictOfColumbiaFinanceEligibleOffice({ officeScope: "state_upper", officeCanonicalName: "State Senator" })
    ).toBe(false);
  });

  it("allows every explicit eligible office and rejects broad-scope guesses", () => {
    for (const key of DISTRICT_OF_COLUMBIA_FINANCE_ELIGIBLE_OFFICE_KEYS) {
      const [officeScope, officeCanonicalName] = key.split("::");
      expect(isDistrictOfColumbiaFinanceEligibleOffice({ officeScope, officeCanonicalName })).toBe(true);
    }

    expect(
      isDistrictOfColumbiaFinanceEligibleOffice({
        officeScope: "statewide",
        officeCanonicalName: "Governor",
      })
    ).toBe(false);
    expect(
      isDistrictOfColumbiaFinanceEligibleOffice({
        officeScope: "place",
        officeCanonicalName: "City Treasurer",
      })
    ).toBe(false);
    expect(
      isDistrictOfColumbiaFinanceEligibleOffice({
        officeScope: "county",
        officeCanonicalName: "County Commissioner",
      })
    ).toBe(false);
    expect(
      isDistrictOfColumbiaFinanceEligibleOffice({
        officeScope: "school_unified",
        officeCanonicalName: "School Board Member",
      })
    ).toBe(false);
  });

  it("builds trimmed office keys and rejects missing parts", () => {
    expect(
      toDistrictOfColumbiaFinanceOfficeKey({
        officeScope: " place ",
        officeCanonicalName: " Mayor ",
      })
    ).toBe("place::Mayor");
    expect(toDistrictOfColumbiaFinanceOfficeKey({ officeScope: "", officeCanonicalName: "Mayor" })).toBeNull();
    expect(toDistrictOfColumbiaFinanceOfficeKey({ officeScope: "place", officeCanonicalName: " " })).toBeNull();
  });

  it("normalizes OCF office labels and seats conservatively", () => {
    expect(normalizeDistrictOfColumbiaOcfOfficeLabel(" chairman   of the council ")).toBe("CHAIRMAN OF THE COUNCIL");
    expect(normalizeDistrictOfColumbiaOcfOfficeLabel("D.C. Attorney General")).toBe("DC ATTORNEY GENERAL");
    expect(normalizeDistrictOfColumbiaOcfOfficeLabel("   ")).toBeNull();

    expect(normalizeDistrictOfColumbiaOcfSeat("At Large")).toBe("AT-LARGE");
    expect(normalizeDistrictOfColumbiaOcfSeat("citywide")).toBe("AT-LARGE");
    expect(normalizeDistrictOfColumbiaOcfSeat("Ward 4")).toBe("WARD 4");
    expect(normalizeDistrictOfColumbiaOcfSeat("W 8")).toBe("WARD 8");
    expect(normalizeDistrictOfColumbiaOcfSeat("09")).toBeNull();
    expect(normalizeDistrictOfColumbiaOcfSeat("ANC 2B")).toBeNull();
  });

  it("maps safe OCF citywide office labels to canonical app offices", () => {
    expect(mapDistrictOfColumbiaOcfOffice({ office: "Mayor" })).toEqual({
      officeScope: "place",
      officeCanonicalName: "Mayor",
      officeKey: "place::Mayor",
      ocfOffice: "Mayor",
      requiresSeat: false,
      seat: null,
    });
    expect(mapDistrictOfColumbiaOcfOffice({ office: "Attorney General" })).toEqual({
      officeScope: "statewide",
      officeCanonicalName: "Attorney General",
      officeKey: "statewide::Attorney General",
      ocfOffice: "Attorney General",
      requiresSeat: false,
      seat: null,
    });
    expect(mapDistrictOfColumbiaOcfOffice({ office: "Chairperson of the Council" })).toMatchObject({
      officeScope: "place",
      officeCanonicalName: "City Council Member",
      ocfOffice: "Chairman of the Council",
      requiresSeat: false,
      seat: null,
    });
  });

  it("requires seats for ward or at-large council offices", () => {
    expect(mapDistrictOfColumbiaOcfOffice({ office: "Councilmember", seat: "Ward 7" })).toEqual({
      officeScope: "place",
      officeCanonicalName: "City Council Member",
      officeKey: "place::City Council Member",
      ocfOffice: "Councilmember",
      requiresSeat: true,
      seat: "WARD 7",
    });
    expect(mapDistrictOfColumbiaOcfOffice({ office: "Member of the Council", seat: "At-Large" })).toMatchObject({
      officeKey: "place::City Council Member",
      seat: "AT-LARGE",
    });

    expect(mapDistrictOfColumbiaOcfOffice({ office: "Councilmember" })).toBeNull();
  });

  it("maps app canonical offices to OCF search inputs", () => {
    expect(
      toDistrictOfColumbiaOcfOfficeSearchInput({
        officeScope: "place",
        officeCanonicalName: "Mayor",
      })
    ).toEqual({ ocfOffice: "Mayor", seat: null });
    expect(
      toDistrictOfColumbiaOcfOfficeSearchInput({
        officeScope: "statewide",
        officeCanonicalName: "Attorney General",
      })
    ).toEqual({ ocfOffice: "Attorney General", seat: null });
    expect(
      toDistrictOfColumbiaOcfOfficeSearchInput({
        officeScope: "place",
        officeCanonicalName: "City Council Member",
        seat: "Ward 2",
      })
    ).toEqual({ ocfOffice: "Councilmember", seat: "WARD 2" });
    // Ward seats sit on DC's state_upper ward rows (migration 320).
    expect(
      toDistrictOfColumbiaOcfOfficeSearchInput({
        officeScope: "state_upper",
        officeCanonicalName: "City Council Member",
        seat: "Ward 5 Member of the Council Ward 5 (2024); District of Columbia",
      })
    ).toEqual({ ocfOffice: "Councilmember", seat: "WARD 5" });
    expect(
      toDistrictOfColumbiaOcfOfficeSearchInput({
        officeScope: "place",
        officeCanonicalName: "City Council Member",
        seat: "Chairperson of the Council",
      })
    ).toEqual({ ocfOffice: "Chairman of the Council", seat: null });
  });

  it("rejects unsafe OCF labels and incomplete app search inputs", () => {
    expect(mapDistrictOfColumbiaOcfOffice({ office: "Advisory Neighborhood Commissioner", seat: "2B" })).toBeNull();
    expect(mapDistrictOfColumbiaOcfOffice({ office: "United States Delegate" })).toBeNull();
    expect(mapDistrictOfColumbiaOcfOffice({ office: "Shadow Senator" })).toBeNull();
    expect(mapDistrictOfColumbiaOcfOffice({ office: "State Board of Education", seat: "Ward 3" })).toBeNull();
    expect(mapDistrictOfColumbiaOcfOffice({ office: "" })).toBeNull();

    expect(
      toDistrictOfColumbiaOcfOfficeSearchInput({
        officeScope: "place",
        officeCanonicalName: "City Council Member",
      })
    ).toBeNull();
    expect(
      toDistrictOfColumbiaOcfOfficeSearchInput({
        officeScope: "place",
        officeCanonicalName: "City Treasurer",
      })
    ).toBeNull();
    expect(
      toDistrictOfColumbiaOcfOfficeSearchInput({
        officeScope: "statewide",
        officeCanonicalName: "State Board of Education Member",
        seat: "At Large",
      })
    ).toBeNull();
  });
});
