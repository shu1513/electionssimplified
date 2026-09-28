import { describe, expect, it } from "vitest";

import { extractSubDistrictSeat } from "../../src/pipeline/elections/subDistrictSeat.js";
import { toJurisdictionKey } from "../../src/pipeline/elections/atLargeBoardSeats.js";

describe("extractSubDistrictSeat", () => {
  it("extracts the ward from Louisiana justice-of-the-peace and constable titles", () => {
    expect(
      extractSubDistrictSeat("Justice of the Peace Justice of the Peace Ward 3, Blanchard Dist.", "Justice of the Peace")
    ).toBe("Ward 3");
    expect(extractSubDistrictSeat("Constable(s) Justice of the Peace Ward 10", "Constable")).toBe("Ward 10");
  });

  it("keeps every geographic designator in title order", () => {
    // East Baton Rouge titles the seat by ward AND district (live).
    expect(extractSubDistrictSeat("Justice of the Peace Ward 2, District 3", "Justice of the Peace")).toBe(
      "Ward 2, District 3"
    );
  });

  it("extracts commission and legislature districts across title dialects", () => {
    expect(extractSubDistrictSeat("PITT COUNTY BOARD OF COMMISSIONERS DISTRICT 06", "County Commissioner")).toBe(
      "District 06"
    );
    expect(extractSubDistrictSeat("Niagara County Legislator, District 13", "County Supervisor")).toBe("District 13");
    expect(extractSubDistrictSeat("CHEROKEE COUNTY BOARD OF COMMISSIONERS DISTRICT I", "County Commissioner")).toBe(
      "District I"
    );
    expect(extractSubDistrictSeat("County Council District No. 5", "City Council Member")).toBe("District No. 5");
    expect(extractSubDistrictSeat("Travis County Commissioner, Precinct 2", "County Commissioner")).toBe("Precinct 2");
    expect(extractSubDistrictSeat("Constable, Precinct 1", "Constable")).toBe("Precinct 1");
  });

  it("extracts lettered districts", () => {
    expect(extractSubDistrictSeat("County Commissioner District E", "County Commissioner")).toBe("District E");
    expect(extractSubDistrictSeat("County Council District A", "County Supervisor")).toBe("District A");
    expect(extractSubDistrictSeat("FORSYTH COUNTY BOARD OF COMMISSIONERS DISTRICT B", "County Commissioner")).toBe(
      "District B"
    );
  });

  it("extracts the district from Arizona special-district boards on the county row", () => {
    // The word "District" inside the board's own name must not be read as the seat.
    expect(
      extractSubDistrictSeat(
        "Maricopa County Community College District Governing Board Member, District 3",
        "Community College Trustee"
      )
    ).toBe("District 3");
    expect(
      extractSubDistrictSeat(
        "Maricopa County Special Health Care District Board of Directors Member, District 4",
        "County Hospital Trustee"
      )
    ).toBe("District 4");
    expect(
      extractSubDistrictSeat(
        "East Valley Institute of Technology Governing Board Member, District 7",
        "Career and Technical Education District Board Member"
      )
    ).toBe("District 7");
    expect(
      extractSubDistrictSeat(
        "Maricopa County Community College District Governing Board Member, At-Large",
        "Community College Trustee"
      )
    ).toBeNull();
  });

  it("stays silent on at-large seat numbering rather than inventing a warning", () => {
    // Utah commissions elect seats A/B/C countywide; Florida city commissions
    // elect numbered seats at large. Neither is a sub-jurisdiction electorate.
    expect(extractSubDistrictSeat("Utah County Commission Seat A", "County Commissioner")).toBeNull();
    expect(extractSubDistrictSeat("City Commission Seat 4", "City Council Member")).toBeNull();
    expect(extractSubDistrictSeat("Pierce County District Court Position No. 2", "County Supervisor")).toBeNull();
  });

  it("stays silent when the title says the seat is at large", () => {
    expect(extractSubDistrictSeat("Jackson County Legislator 1st District At-Large", "County Supervisor")).toBeNull();
    expect(extractSubDistrictSeat("County Council At Large A", "City Council Member")).toBeNull();
  });

  it("stays silent for offices whose seats share one countywide electorate", () => {
    // Judicial division/seat numbering — every county voter votes in these.
    expect(extractSubDistrictSeat("NC District Court Judge District 26 Seat 20", "County Level Judge")).toBeNull();
    expect(extractSubDistrictSeat("General Sessions Civil Court Division 2", "County Level Judge")).toBeNull();
    expect(
      extractSubDistrictSeat("Associate Circuit Judge, Division 11, Boone County, Missouri", "County Level Judge")
    ).toBeNull();
  });

  it("stays silent when the designator belongs to the office name", () => {
    expect(extractSubDistrictSeat("Clerk of the District Court", "Clerk of Court")).toBeNull();
    expect(extractSubDistrictSeat("District Attorney 1st Judicial District Court", "District Attorney")).toBeNull();
    expect(
      extractSubDistrictSeat("Soil and Water Conservation District Supervisor", "Soil and Water Conservation District Supervisor")
    ).toBeNull();
  });

  it("does not read a jurisdiction name as a seat", () => {
    // "District Heights" (MD) is a city, not a district seat: the designator
    // only counts when a number follows it.
    expect(extractSubDistrictSeat("District Heights City Council Member", "City Council Member")).toBeNull();
  });

  it("returns null for untitled, office-less, and undesignated races", () => {
    expect(extractSubDistrictSeat("County Commissioner", "County Commissioner")).toBeNull();
    expect(extractSubDistrictSeat("County Commissioner District 4", null)).toBeNull();
    expect(extractSubDistrictSeat("", "County Commissioner")).toBeNull();
  });

  describe("jurisdictions that elect numbered seats countywide", () => {
    const nc = (county: string) => ({ state: "NC", districtName: `${county} County, North Carolina` });
    const fl = (county: string) => ({ state: "FL", districtName: `${county} County, Florida` });

    it("stays silent where the district is only a residency requirement", () => {
      // NCACC lists these as "by district at large" — the whole county votes.
      expect(extractSubDistrictSeat("ANSON COUNTY BOARD OF COMMISSIONERS DISTRICT 02", "County Commissioner", nc("Anson"))).toBeNull();
      expect(
        extractSubDistrictSeat("RANDOLPH COUNTY BOARD OF COMMISSIONERS DISTRICT 02", "County Commissioner", nc("Randolph"))
      ).toBeNull();
      // Florida's default: countywide ballot, district residency only.
      expect(extractSubDistrictSeat("County Commissioner District 4", "County Commissioner", fl("Polk"))).toBeNull();
      // Whole-state rules.
      expect(
        extractSubDistrictSeat("County Commissioner District 2", "County Commissioner", {
          state: "ID",
          districtName: "Ada County, Idaho",
        })
      ).toBeNull();
      expect(
        extractSubDistrictSeat("County Commissioner District 1", "County Commissioner", {
          state: "IN",
          districtName: "Hendricks County, Indiana",
        })
      ).toBeNull();
    });

    it("still flags counties that elect their districts for real", () => {
      // NCACC "purely by district".
      expect(
        extractSubDistrictSeat("PITT COUNTY BOARD OF COMMISSIONERS DISTRICT 06", "County Commissioner", nc("Pitt"))
      ).toBe("District 06");
      // Florida single-member counties.
      expect(extractSubDistrictSeat("County Commissioner District 5", "County Commissioner", fl("Miami-Dade"))).toBe(
        "District 5"
      );
      // Indiana's county COUNCIL is districted for real, unlike its commission.
      expect(
        extractSubDistrictSeat("County Council - District 1", "County Supervisor", {
          state: "IN",
          districtName: "Allen County, Indiana",
        })
      ).toBe("District 1");
    });

    it("splits Hillsborough and Pinellas by district number, in opposite directions", () => {
      // Hillsborough: 1-4 single-member, 5-7 countywide.
      expect(
        extractSubDistrictSeat("Hillsborough County Commissioner, District 2", "County Commissioner", fl("Hillsborough"))
      ).toBe("District 2");
      expect(
        extractSubDistrictSeat("Hillsborough County Commissioner, District 7", "County Commissioner", fl("Hillsborough"))
      ).toBeNull();
      // Pinellas is inverted: 1-3 countywide, 4-7 single-member.
      expect(extractSubDistrictSeat("County Commissioner, District 2", "County Commissioner", fl("Pinellas"))).toBeNull();
      expect(extractSubDistrictSeat("County Commissioner, District 6", "County Commissioner", fl("Pinellas"))).toBe(
        "District 6"
      );
    });

    it("follows Orange County NC's electorate between the primary and the general", () => {
      // NCACC: its districted seats run "purely by district" in the primary and
      // "by district at large" in the general, so the same seat flips.
      const orange = { state: "NC", districtName: "Orange County, North Carolina" };
      const title = "ORANGE COUNTY BOARD OF COMMISSIONERS DISTRICT 01";
      expect(extractSubDistrictSeat(title, "County Commissioner", { ...orange, electionStage: "primary" })).toBe(
        "District 01"
      );
      expect(
        extractSubDistrictSeat(title, "County Commissioner", { ...orange, electionStage: "general" })
      ).toBeNull();
      // Unknown stage stays silent: a wrong warning is worse than a missing one.
      expect(extractSubDistrictSeat(title, "County Commissioner", orange)).toBeNull();
    });

    it("stays silent for cities that elect their districts citywide", () => {
      // Cape Coral council members qualify by district but are elected at
      // large; Crestview's charter puts all three precinct seats on every
      // city voter's ballot.
      expect(
        extractSubDistrictSeat("Cape Coral City Council District 1", "City Council Member", {
          state: "FL",
          districtName: "Cape Coral city, Florida",
        })
      ).toBeNull();
      expect(
        extractSubDistrictSeat("Crestview City Council Precinct 1", "City Council Member", {
          state: "FL",
          districtName: "Crestview city, Florida",
        })
      ).toBeNull();
    });

    it("still flags cities whose districts are real", () => {
      expect(
        extractSubDistrictSeat("Council Member for District 10", "City Council Member", {
          state: "TX",
          districtName: "Fort Worth city, Texas",
        })
      ).toBe("District 10");
      // Same state as Cape Coral, different city — the rule is per city.
      expect(
        extractSubDistrictSeat("Gainesville City Commission District 2", "City Council Member", {
          state: "FL",
          districtName: "Gainesville city, Florida",
        })
      ).toBe("District 2");
    });

    it("does not eat a city whose name ends in the type word", () => {
      // Census writes the place type in lower case ("Kansas City city"), so a
      // case-insensitive strip would reduce this to "Kansas".
      expect(toJurisdictionKey("Kansas City city, Missouri")).toBe("Kansas City");
      expect(toJurisdictionKey("Cape Coral city, Florida")).toBe("Cape Coral");
      expect(toJurisdictionKey("Anson County, North Carolina")).toBe("Anson");
      expect(toJurisdictionKey("St. Tammany Parish, Louisiana")).toBe("St. Tammany");
    });

    it("leaves non-board offices in those same counties alone", () => {
      // The countywide-board rule is about county boards, not ward seats that
      // happen to sit in a listed state.
      expect(
        extractSubDistrictSeat("Constable Justice of the Peace Ward 2", "Constable", {
          state: "NC",
          districtName: "Anson County, North Carolina",
        })
      ).toBe("Ward 2");
    });

    it("keeps flagging when the caller passes no jurisdiction", () => {
      expect(extractSubDistrictSeat("County Commissioner District 4", "County Commissioner")).toBe("District 4");
    });
  });

  it("is stable across calls despite module-level global patterns", () => {
    const title = "County Commissioner District 4";
    expect(extractSubDistrictSeat(title, "County Commissioner")).toBe("District 4");
    expect(extractSubDistrictSeat(title, "County Commissioner")).toBe("District 4");
    expect(extractSubDistrictSeat(title, "County Commissioner")).toBe("District 4");
  });
});
