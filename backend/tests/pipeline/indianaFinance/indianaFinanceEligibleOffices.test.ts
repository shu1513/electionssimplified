import { describe, expect, it } from "vitest";

import {
  isIndianaFinanceEligibleOffice,
  toIndianaFinanceOfficeKey,
} from "../../../src/pipeline/indianaFinance/indianaFinanceEligibleOffices.js";

describe("indianaFinanceEligibleOffices", () => {
  it("allows only the explicit Indiana finance office set", () => {
    expect(isIndianaFinanceEligibleOffice({ officeScope: "statewide", officeCanonicalName: "Governor" })).toBe(true);
    expect(isIndianaFinanceEligibleOffice({ officeScope: "statewide", officeCanonicalName: "Attorney General" })).toBe(true);
    expect(isIndianaFinanceEligibleOffice({ officeScope: "statewide", officeCanonicalName: "Comptroller" })).toBe(true);
    expect(isIndianaFinanceEligibleOffice({ officeScope: "state_upper", officeCanonicalName: "State Senator" })).toBe(true);
    expect(
      isIndianaFinanceEligibleOffice({
        officeScope: "state_lower",
        officeCanonicalName: "State Lower Chamber Legislator",
      })
    ).toBe(true);

    expect(isIndianaFinanceEligibleOffice({ officeScope: "statewide", officeCanonicalName: "United States Senator" })).toBe(
      false
    );
    expect(isIndianaFinanceEligibleOffice({ officeScope: "county", officeCanonicalName: "Sheriff" })).toBe(false);
    expect(isIndianaFinanceEligibleOffice({ officeScope: "local", officeCanonicalName: "Mayor" })).toBe(false);
  });

  it("builds stable office keys only from non-empty labels", () => {
    expect(toIndianaFinanceOfficeKey({ officeScope: " statewide ", officeCanonicalName: " Governor " })).toBe(
      "statewide::Governor"
    );
    expect(toIndianaFinanceOfficeKey({ officeScope: " ", officeCanonicalName: "Governor" })).toBeNull();
    expect(toIndianaFinanceOfficeKey({ officeScope: "statewide", officeCanonicalName: null })).toBeNull();
  });
});
