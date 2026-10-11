import { describe, expect, it } from "vitest";

import {
  TENNESSEE_FINANCE_ELIGIBLE_OFFICE_KEYS,
  isTennesseeFinanceEligibleOffice,
  normalizeTennesseeCampDistrict,
  tennesseeCampOfficeLabelForAppOffice,
  tennesseeCampOfficeLabelsForLinkOffice,
  toTennesseeCampOfficeSearchInput,
} from "../../../src/pipeline/tennesseeFinance/tennesseeFinanceEligibleOffices.js";

describe("tennesseeFinanceEligibleOffices", () => {
  it("keeps a conservative explicit Tennessee finance office allowlist", () => {
    expect(TENNESSEE_FINANCE_ELIGIBLE_OFFICE_KEYS).toEqual([
      "statewide::Governor",
      "state_upper::State Senator",
      "state_lower::State Lower Chamber Legislator",
    ]);
  });

  it("maps eligible app offices to CAMP office selections", () => {
    expect(toTennesseeCampOfficeSearchInput({ officeScope: "statewide", officeCanonicalName: "Governor" })).toEqual({
      officeSelection: "2",
    });
    expect(toTennesseeCampOfficeSearchInput({ officeScope: "state_upper", officeCanonicalName: "State Senator" })).toEqual({
      officeSelection: "3",
    });
    expect(
      toTennesseeCampOfficeSearchInput({
        officeScope: "state_lower",
        officeCanonicalName: "State Lower Chamber Legislator",
      })
    ).toEqual({ officeSelection: "4" });
    expect(toTennesseeCampOfficeSearchInput({ officeScope: "judicial", officeCanonicalName: "Supreme Court" })).toBeNull();
  });

  it("labels and filters eligible offices", () => {
    expect(isTennesseeFinanceEligibleOffice({ officeScope: "statewide", officeCanonicalName: "Governor" })).toBe(true);
    expect(isTennesseeFinanceEligibleOffice({ officeScope: "statewide", officeCanonicalName: "Attorney General" })).toBe(false);
    expect(tennesseeCampOfficeLabelForAppOffice({ officeScope: "state_upper", officeCanonicalName: "State Senator" })).toBe(
      "Senate"
    );
  });

  it("maps stored link office names to CAMP office labels", () => {
    expect(tennesseeCampOfficeLabelsForLinkOffice("State Lower Chamber Legislator")).toEqual(["HOUSE", "HOUSE OF REPRESENTATIVES"]);
    expect(tennesseeCampOfficeLabelsForLinkOffice(" state  representative ")).toEqual(["HOUSE", "HOUSE OF REPRESENTATIVES"]);
    expect(tennesseeCampOfficeLabelsForLinkOffice("State Senator")).toEqual(["SENATE"]);
    expect(tennesseeCampOfficeLabelsForLinkOffice("Attorney General")).toEqual([]);
  });

  it("normalizes Tennessee CAMP districts conservatively", () => {
    expect(normalizeTennesseeCampDistrict("04")).toBe("4");
    expect(normalizeTennesseeCampDistrict("House 51")).toBe("51");
    expect(normalizeTennesseeCampDistrict("")).toBeNull();
  });
});
