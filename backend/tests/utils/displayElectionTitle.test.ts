import { describe, expect, it } from "vitest";

import { displayElectionTitle } from "../../src/utils/displayElectionTitle.js";
import { normalizeElectionTitleKey } from "../../src/utils/normalizeElectionTitleKey.js";

describe("displayElectionTitle", () => {
  it("title-cases titles stored in capital letters", () => {
    expect(displayElectionTitle("BUNCOMBE COUNTY SHERIFF")).toBe("Buncombe County Sheriff");
    expect(displayElectionTitle("REPRESENTATIVE TO THE ASSEMBLY DISTRICT 33")).toBe(
      "Representative to the Assembly District 33"
    );
    expect(displayElectionTitle("PITT COUNTY BOARD OF COMMISSIONERS DISTRICT 06")).toBe(
      "Pitt County Board of Commissioners District 06"
    );
    expect(displayElectionTitle("GASTON COUNTY BOARD OF EDUCATION AT-LARGE")).toBe(
      "Gaston County Board of Education At-Large"
    );
    expect(displayElectionTitle("MAYOR")).toBe("Mayor");
  });

  it("returns titles that contain lowercase letters unchanged", () => {
    for (const title of [
      "Buncombe County Sheriff",
      "Frisco ISD Board of Trustees, Place 3",
      "BUNCOMBE COUNTY Sheriff",
      "Statewide Amendment 1: LIEUTENANT GOVERNOR VACANCY",
      "",
      "2026",
    ]) {
      expect(displayElectionTitle(title)).toBe(title);
    }
  });

  it("keeps connecting words lowercase inside the title only", () => {
    expect(displayElectionTitle("REPRESENTATIVE IN GENERAL ASSEMBLY DISTRICT 5")).toBe(
      "Representative in General Assembly District 5"
    );
    expect(displayElectionTitle("CIRCUIT CLERK AND EX-OFFICIO RECORDER OF DEEDS")).toBe(
      "Circuit Clerk and Ex-Officio Recorder of Deeds"
    );
    expect(displayElectionTitle("THE VILLAGE OF KALEVA CLERK")).toBe("The Village of Kaleva Clerk");
    expect(displayElectionTitle("COUNTY COMMISSION - AT LARGE")).toBe("County Commission - At Large");
    expect(displayElectionTitle("PROPOSITION NO. 1 — THE LEVY FOR SAFETY AND SECURITY")).toBe(
      "Proposition No. 1 — The Levy for Safety and Security"
    );
    expect(displayElectionTitle("QUESTION 2: TO AMEND THE CHARTER")).toBe("Question 2: To Amend the Charter");
    expect(displayElectionTitle("VIL CLERK (THE VILLAGE OF KALEVA)")).toBe("Vil Clerk (The Village of Kaleva)");
    expect(displayElectionTitle("WICHITA BOARD MEMBER AT LARGE")).toBe("Wichita Board Member At Large");
  });

  it("keeps known abbreviations upper case", () => {
    expect(displayElectionTitle("US HOUSE OF REPRESENTATIVES DISTRICT 02")).toBe(
      "US House of Representatives District 02"
    );
    expect(displayElectionTitle("U.S. SENATOR")).toBe("U.S. Senator");
    expect(displayElectionTitle("FRISCO ISD BOARD OF TRUSTEES, PLACE 3")).toBe(
      "Frisco ISD Board of Trustees, Place 3"
    );
    expect(displayElectionTitle("WICHITA USD 259 BOARD MEMBER")).toBe("Wichita USD 259 Board Member");
    expect(displayElectionTitle("HARRIS COUNTY MUD 55 DIRECTOR")).toBe("Harris County MUD 55 Director");
    expect(displayElectionTitle("TRAVIS COUNTY ESD 2 COMMISSIONER")).toBe("Travis County ESD 2 Commissioner");
    expect(displayElectionTitle("CHEROKEE COUNTY BOARD OF COMMISSIONERS DISTRICT IV")).toBe(
      "Cherokee County Board of Commissioners District IV"
    );
    expect(displayElectionTitle("CHEROKEE COUNTY BOARD OF EDUCATION DISTRICT II")).toBe(
      "Cherokee County Board of Education District II"
    );
    expect(displayElectionTitle("SUPERIOR COURT JUDGE DIVISION III")).toBe("Superior Court Judge Division III");
    expect(displayElectionTitle("CI-132")).toBe("CI-132");
    expect(displayElectionTitle("SALE OF BEVERAGES BETWEEN 10:00 A.M. AND 12:00 MIDNIGHT.")).toBe(
      "Sale of Beverages Between 10:00 A.M. and 12:00 Midnight."
    );
  });

  it("keeps a state postal code upper case when it is a whole word", () => {
    expect(displayElectionTitle("NC STATE SENATE DISTRICT 41")).toBe("NC State Senate District 41");
    expect(displayElectionTitle("STATE SENATE (NC) DISTRICT 41")).toBe("State Senate (NC) District 41");
    // Codes that double as title words follow the ordinary rules.
    expect(displayElectionTitle("LA CROSSE COUNTY SHERIFF")).toBe("La Crosse County Sheriff");
    expect(displayElectionTitle("JUDGE DISTRICT CT (5TH DISTRICT) - INCUMBENT POSITION")).toBe(
      "Judge District Ct (5th District) - Incumbent Position"
    );
  });

  it("capitalizes each side of a hyphen or slash", () => {
    expect(displayElectionTitle("ROWAN-SALISBURY BOARD OF EDUCATION")).toBe("Rowan-Salisbury Board of Education");
    expect(displayElectionTitle("COUNTY TREASURER/SUPT. OF SCHOOLS")).toBe("County Treasurer/Supt. of Schools");
    expect(displayElectionTitle("JUDGE DISTRICT COURT - NON-INCUMBENT POSITION")).toBe(
      "Judge District Court - Non-Incumbent Position"
    );
    expect(displayElectionTitle("BOARD OF EDUCATION TO SERVE A FULL 4-YEAR TERM")).toBe(
      "Board of Education to Serve A Full 4-Year Term"
    );
  });

  it("keeps numbers as stored and lowers ordinal suffixes", () => {
    expect(displayElectionTitle("NC SUPERIOR COURT JUDGE DISTRICT 24D SEAT 01")).toBe(
      "NC Superior Court Judge District 24D Seat 01"
    );
    expect(displayElectionTitle("NC DISTRICT COURT JUDGE DISTRICT 24 SEAT 06 (UNEXPIRED)")).toBe(
      "NC District Court Judge District 24 Seat 06 (Unexpired)"
    );
    expect(displayElectionTitle("3RD SENATE")).toBe("3rd Senate");
    expect(displayElectionTitle("COMMISSIONER DISTRICT #2")).toBe("Commissioner District #2");
  });

  it("handles name prefixes and apostrophes", () => {
    expect(displayElectionTitle("MCDOWELL COUNTY SHERIFF")).toBe("McDowell County Sheriff");
    expect(displayElectionTitle("MACON COUNTY SHERIFF")).toBe("Macon County Sheriff");
    expect(displayElectionTitle("O'BRIEN COUNTY ATTORNEY")).toBe("O'Brien County Attorney");
    expect(displayElectionTitle("COMMISSIONER'S COURT PRECINCT 1")).toBe("Commissioner's Court Precinct 1");
  });

  it("changes letter case only, so the identity key is the same", () => {
    for (const title of [
      "PITT COUNTY BOARD OF COMMISSIONERS DISTRICT 06",
      "JUDGE OF THE SUPERIOR COURT, OFFICE NO. 02",
      "COUNTY TREASURER/SUPT. OF SCHOOLS",
      "PROPOSITION NO. 1 — REPLACEMENT CAPITAL LEVY FOR SAFETY, SECURITY AND TECHNOLOGY",
    ]) {
      const displayed = displayElectionTitle(title);
      expect(displayed.toUpperCase()).toBe(title);
      expect(normalizeElectionTitleKey(displayed)).toBe(normalizeElectionTitleKey(title));
    }
  });
});
