import { describe, expect, it } from "vitest";

import {
  isOregonOrestarCommitteeExportWorkbook,
  parseOregonOrestarCommitteeExport,
} from "../../../src/pipeline/oregonFinance/oregonOrestarCommitteeExport.js";
import {
  buildOregonOrestarCommitteeExportWorkbook,
  OREGON_COMMITTEE_EXPORT_FIXTURE_HEADERS,
} from "./orestarExportFixture.js";

describe("oregonOrestarCommitteeExport", () => {
  it("parses committee identity and structured candidate fields from a real BIFF8 workbook", () => {
    const workbook = buildOregonOrestarCommitteeExportWorkbook([
      {
        "Committee Id": 21727,
        "Committee Name": "Courtney Bangs PAC",
        "Committee Type": "CC",
        "Candidate Office": "State Representative District 32",
        "Candidate First Name": "Courtney",
        "Candidate Last Name": "Bangs",
        "Active Election": "2026 General Election",
      },
    ]);

    expect(isOregonOrestarCommitteeExportWorkbook(workbook)).toBe(true);
    expect(parseOregonOrestarCommitteeExport(workbook)).toEqual([
      {
        filerCommitteeId: "21727",
        filerCommitteeName: "Courtney Bangs PAC",
        committeeUrl: "https://secure.sos.state.or.us/orestar/sooDetail.do?cneCommitteeId=21727",
        committeeType: "CC",
        candidateFirstName: "Courtney",
        candidateLastName: "Bangs",
        candidateOffice: "State Representative District 32",
        activeElection: "2026 General Election",
      },
    ]);
  });

  it("parses the .xlsx workbook ORESTAR serves since Oct 2026", () => {
    const workbook = buildOregonOrestarCommitteeExportWorkbook(
      [
        {
          "Committee Id": 24397,
          "Committee Name": "Committee to Elect Sue Rieke Smith",
          "Committee Type": "CC",
          "Candidate Office": "26th District",
          "Candidate First Name": "Sue",
          "Candidate Last Name": "Rieke Smith",
          "Active Election": "2026 General Election",
        },
      ],
      OREGON_COMMITTEE_EXPORT_FIXTURE_HEADERS,
      "xlsx"
    );

    expect(isOregonOrestarCommitteeExportWorkbook(workbook)).toBe(true);
    expect(parseOregonOrestarCommitteeExport(workbook)).toMatchObject([
      { filerCommitteeId: "24397", candidateFirstName: "Sue", candidateLastName: "Rieke Smith" },
    ]);
  });

  it("fails closed on HTML, missing columns, and unusable committee rows", () => {
    const html = new TextEncoder().encode("<html>Please Contact Us</html>");
    expect(() => parseOregonOrestarCommitteeExport(html)).toThrow("is not an .xls workbook");

    const missingHeaderWorkbook = buildOregonOrestarCommitteeExportWorkbook(
      [{ "Committee Id": 1, "Committee Name": "Test", "Committee Type": "CC" }],
      OREGON_COMMITTEE_EXPORT_FIXTURE_HEADERS.filter((header) => header !== "Active Election")
    );
    expect(() => parseOregonOrestarCommitteeExport(missingHeaderWorkbook)).toThrow(
      "missing required columns: Active Election"
    );

    const invalidRowWorkbook = buildOregonOrestarCommitteeExportWorkbook([
      {
        "Committee Id": " ",
        "Committee Name": "Test",
        "Committee Type": "CC",
      },
    ]);
    expect(() => parseOregonOrestarCommitteeExport(invalidRowWorkbook)).toThrow(
      "row 2 is unusable: invalid Committee Id"
    );
  });
});
