import { describe, expect, it } from "vitest";

import {
  MASSACHUSETTS_FINANCE_ELIGIBLE_OFFICE_KEYS,
  isMassachusettsFinanceEligibleElectionRow,
  isMassachusettsFinanceEligibleOffice,
  mapMassachusettsOcpfOffice,
  massachusettsMunicipalFinanceCityForGeoid,
  normalizeMassachusettsOcpfDistrict,
  normalizeMassachusettsOcpfOfficeLabel,
  toMassachusettsFinanceOfficeKey,
  toMassachusettsOcpfOfficeSearchInput,
} from "../../../src/pipeline/massachusettsFinance/massachusettsFinanceEligibleOffices.js";

describe("massachusettsFinanceEligibleOffices", () => {
  it("keeps a conservative explicit Massachusetts finance office allowlist", () => {
    expect(MASSACHUSETTS_FINANCE_ELIGIBLE_OFFICE_KEYS).toEqual([
      "statewide::Governor",
      "statewide::Lieutenant Governor",
      "statewide::Secretary of State",
      "statewide::Attorney General",
      "statewide::State Treasurer",
      "statewide::State Auditor",
      "state_upper::State Senator",
      "state_lower::State Lower Chamber Legislator",
      "place::Mayor",
      "place::City Council Member",
    ]);
  });

  it("allows every explicit eligible office and rejects broad-scope guesses", () => {
    for (const key of MASSACHUSETTS_FINANCE_ELIGIBLE_OFFICE_KEYS) {
      const [officeScope, officeCanonicalName] = key.split("::");
      expect(isMassachusettsFinanceEligibleOffice({ officeScope, officeCanonicalName })).toBe(true);
    }

    expect(
      isMassachusettsFinanceEligibleOffice({
        officeScope: "statewide",
        officeCanonicalName: "Governor's Council Member",
      })
    ).toBe(false);
    expect(
      isMassachusettsFinanceEligibleOffice({
        officeScope: "statewide",
        officeCanonicalName: "State Supreme Court Justice",
      })
    ).toBe(false);
    expect(
      isMassachusettsFinanceEligibleOffice({
        officeScope: "county",
        officeCanonicalName: "Sheriff",
      })
    ).toBe(false);
    expect(
      isMassachusettsFinanceEligibleOffice({
        officeScope: "state_lower",
        officeCanonicalName: "State Senator",
      })
    ).toBe(false);
  });

  it("builds trimmed office keys and rejects missing parts", () => {
    expect(
      toMassachusettsFinanceOfficeKey({
        officeScope: " statewide ",
        officeCanonicalName: " Governor ",
      })
    ).toBe("statewide::Governor");
    expect(toMassachusettsFinanceOfficeKey({ officeScope: "", officeCanonicalName: "Governor" })).toBeNull();
    expect(toMassachusettsFinanceOfficeKey({ officeScope: "statewide", officeCanonicalName: " " })).toBeNull();
  });

  it("normalizes OCPF office labels and districts conservatively", () => {
    expect(normalizeMassachusettsOcpfOfficeLabel(" Statewide,   Governor ")).toBe("STATEWIDE GOVERNOR");
    expect(normalizeMassachusettsOcpfOfficeLabel("Statewide, Lt. Governor.")).toBe("STATEWIDE LT GOVERNOR");
    expect(normalizeMassachusettsOcpfOfficeLabel("   ")).toBeNull();
    expect(normalizeMassachusettsOcpfDistrict(" 3rd   Suffolk District ")).toBe("3 SUFFOLK");
    expect(normalizeMassachusettsOcpfDistrict("2nd Bristol & Plymouth")).toBe("2 BRISTOL PLYMOUTH");
    expect(normalizeMassachusettsOcpfDistrict("   ")).toBeNull();
    // Catalog district names and OCPF filer labels canonicalize to the same
    // bare-number county-list form — this equality is what auto-link relies
    // on for every legislative candidate.
    expect(normalizeMassachusettsOcpfDistrict("Third Suffolk District (2024); Massachusetts")).toBe(
      normalizeMassachusettsOcpfDistrict("3rd Suffolk")
    );
    expect(normalizeMassachusettsOcpfDistrict("First Essex and Middlesex District (2024); Massachusetts")).toBe(
      normalizeMassachusettsOcpfDistrict("1st Essex & Middlesex")
    );
    expect(normalizeMassachusettsOcpfDistrict("Middlesex and Norfolk District (2024); Massachusetts")).toBe(
      normalizeMassachusettsOcpfDistrict("Middlesex and Norfolk")
    );
    // Hyphenated catalog names equal OCPF comma/ampersand county lists.
    expect(normalizeMassachusettsOcpfDistrict("Berkshire-Hampden-Franklin-Hampshire District (2024); Massachusetts")).toBe(
      normalizeMassachusettsOcpfDistrict("Berkshire, Hampden, Franklin & Hampshire")
    );
    expect(normalizeMassachusettsOcpfDistrict("Thirty-Seventh Middlesex")).toBe("37 MIDDLESEX");
    // Distinct districts stay distinct.
    expect(normalizeMassachusettsOcpfDistrict("First Suffolk")).not.toBe(
      normalizeMassachusettsOcpfDistrict("Second Suffolk")
    );
  });

  it("maps safe OCPF statewide office labels to canonical app offices", () => {
    expect(mapMassachusettsOcpfOffice({ officeSought: "Statewide, Governor" })).toEqual({
      officeScope: "statewide",
      officeCanonicalName: "Governor",
      officeKey: "statewide::Governor",
      ocpfOffice: "Statewide, Governor",
      requiresDistrict: false,
      district: null,
    });
    expect(mapMassachusettsOcpfOffice({ officeSought: "Statewide, Secretary of Commonwealth" })).toMatchObject({
      officeScope: "statewide",
      officeCanonicalName: "Secretary of State",
      ocpfOffice: "Statewide, Secretary of State",
    });
    expect(mapMassachusettsOcpfOffice({ officeSought: "Statewide, Treasurer" })).toMatchObject({
      officeCanonicalName: "State Treasurer",
    });
    expect(mapMassachusettsOcpfOffice({ officeSought: "Statewide, Auditor" })).toMatchObject({
      officeCanonicalName: "State Auditor",
    });
    expect(mapMassachusettsOcpfOffice({ officeSought: "Lt. Governor" })).toMatchObject({
      officeCanonicalName: "Lieutenant Governor",
    });
  });

  it("maps legislative OCPF labels and requires district text", () => {
    expect(mapMassachusettsOcpfOffice({ officeSought: "Senate, 2nd Bristol & Plymouth" })).toEqual({
      officeScope: "state_upper",
      officeCanonicalName: "State Senator",
      officeKey: "state_upper::State Senator",
      ocpfOffice: "Senate",
      requiresDistrict: true,
      district: "2 BRISTOL PLYMOUTH",
    });
    expect(mapMassachusettsOcpfOffice({ officeSought: "House, 3rd Suffolk" })).toEqual({
      officeScope: "state_lower",
      officeCanonicalName: "State Lower Chamber Legislator",
      officeKey: "state_lower::State Lower Chamber Legislator",
      ocpfOffice: "House",
      requiresDistrict: true,
      district: "3 SUFFOLK",
    });

    expect(mapMassachusettsOcpfOffice({ officeSought: "Senate" })).toBeNull();
    expect(mapMassachusettsOcpfOffice({ officeSought: "House,   " })).toBeNull();
  });

  it("maps app canonical offices to OCPF search inputs", () => {
    expect(
      toMassachusettsOcpfOfficeSearchInput({
        officeScope: "statewide",
        officeCanonicalName: "Attorney General",
      })
    ).toEqual({ ocpfOffice: "Statewide, Attorney General", district: null });
    expect(
      toMassachusettsOcpfOfficeSearchInput({
        officeScope: "statewide",
        officeCanonicalName: "Secretary of State",
      })
    ).toEqual({ ocpfOffice: "Statewide, Secretary of State", district: null });
    expect(
      toMassachusettsOcpfOfficeSearchInput({
        officeScope: "state_upper",
        officeCanonicalName: "State Senator",
        district: "2nd Bristol & Plymouth District",
      })
    ).toEqual({ ocpfOffice: "Senate", district: "2 BRISTOL PLYMOUTH" });
    expect(
      toMassachusettsOcpfOfficeSearchInput({
        officeScope: "state_lower",
        officeCanonicalName: "State Lower Chamber Legislator",
        district: "3rd Suffolk",
      })
    ).toEqual({ ocpfOffice: "House", district: "3 SUFFOLK" });
  });

  it("maps municipal OCPF labels for enabled cities with the city in the district slot", () => {
    expect(mapMassachusettsOcpfOffice({ officeSought: "Mayoral, Boston" })).toEqual({
      officeScope: "place",
      officeCanonicalName: "Mayor",
      officeKey: "place::Mayor",
      ocpfOffice: "Mayoral",
      requiresDistrict: true,
      district: "BOSTON",
    });
    expect(mapMassachusettsOcpfOffice({ officeSought: "City Councilor, Boston" })).toEqual({
      officeScope: "place",
      officeCanonicalName: "City Council Member",
      officeKey: "place::City Council Member",
      ocpfOffice: "City Councilor",
      requiresDistrict: true,
      district: "BOSTON",
    });
    // Parsing keeps every city; the search-input side enforces the allowlist,
    // so a Worcester filer can never equal a Boston expected district.
    expect(mapMassachusettsOcpfOffice({ officeSought: "Mayoral, Worcester" })).toMatchObject({
      district: "WORCESTER",
    });
    expect(mapMassachusettsOcpfOffice({ officeSought: "Mayoral,   " })).toBeNull();
  });

  it("builds municipal search inputs only for allowlisted cities", () => {
    expect(
      toMassachusettsOcpfOfficeSearchInput({
        officeScope: "place",
        officeCanonicalName: "Mayor",
        district: "Boston",
      })
    ).toEqual({ ocpfOffice: "Mayoral", district: "BOSTON" });
    expect(
      toMassachusettsOcpfOfficeSearchInput({
        officeScope: "place",
        officeCanonicalName: "City Council Member",
        district: "BOSTON",
      })
    ).toEqual({ ocpfOffice: "City Councilor", district: "BOSTON" });
    expect(
      toMassachusettsOcpfOfficeSearchInput({
        officeScope: "place",
        officeCanonicalName: "Mayor",
        district: "Worcester",
      })
    ).toBeNull();
    expect(
      toMassachusettsOcpfOfficeSearchInput({
        officeScope: "place",
        officeCanonicalName: "Mayor",
      })
    ).toBeNull();
  });

  it("gates municipal election rows by place district GEOID", () => {
    expect(massachusettsMunicipalFinanceCityForGeoid("2507000")).toBe("BOSTON");
    expect(massachusettsMunicipalFinanceCityForGeoid("0667000")).toBeNull();

    const bostonMayorRow = {
      district_type: "place",
      geoid_compact: "2507000",
      office_scope: "place",
      office_canonical_name: "Mayor",
    };
    expect(isMassachusettsFinanceEligibleElectionRow(bostonMayorRow)).toBe(true);
    expect(
      isMassachusettsFinanceEligibleElectionRow({ ...bostonMayorRow, geoid_compact: "2582000" })
    ).toBe(false);
    expect(
      isMassachusettsFinanceEligibleElectionRow({ ...bostonMayorRow, district_type: "county" })
    ).toBe(false);
    expect(
      isMassachusettsFinanceEligibleElectionRow({ ...bostonMayorRow, office_canonical_name: "Town Council Member" })
    ).toBe(false);
    // Non-place offices keep the pure office-key behavior with no GEOID input.
    expect(
      isMassachusettsFinanceEligibleElectionRow({
        district_type: "state",
        geoid_compact: "25",
        office_scope: "statewide",
        office_canonical_name: "Governor",
      })
    ).toBe(true);
  });

  it("rejects unsafe OCPF labels and incomplete app search inputs", () => {
    expect(mapMassachusettsOcpfOffice({ officeSought: "Governor's Council, 1st District" })).toBeNull();
    expect(mapMassachusettsOcpfOffice({ officeSought: "District Attorney, Suffolk" })).toBeNull();
    expect(mapMassachusettsOcpfOffice({ officeSought: "Mayor, Boston" })).toBeNull();
    expect(mapMassachusettsOcpfOffice({ officeSought: "" })).toBeNull();

    expect(
      toMassachusettsOcpfOfficeSearchInput({
        officeScope: "state_upper",
        officeCanonicalName: "State Senator",
      })
    ).toBeNull();
    expect(
      toMassachusettsOcpfOfficeSearchInput({
        officeScope: "statewide",
        officeCanonicalName: "Governor's Council Member",
      })
    ).toBeNull();
  });

  it("maps OCPF's live treasurer label to the State Treasurer office", () => {
    expect(mapMassachusettsOcpfOffice({ officeSought: "Statewide, Treasurer of the Commonwealth" })).toMatchObject({
      officeCanonicalName: "State Treasurer",
      ocpfOffice: "Statewide, Treasurer",
      district: null,
    });
  });
});
