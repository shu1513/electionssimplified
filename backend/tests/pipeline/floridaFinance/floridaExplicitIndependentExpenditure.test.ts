import { describe, expect, it } from "vitest";
import {
  decodeFloridaEfsExpenditureElectionContext,
  decodeFloridaNativeExpenditureTsv,
  FLORIDA_NATIVE_EXPENDITURE_HEADERS,
  matchFloridaExplicitIndependentExpenditure,
  parseFloridaExplicitIePurpose,
  parseFloridaExplicitIndependentExpenditureTarget,
  type FloridaNativeExpenditure,
  type FloridaVerifiedExplicitIeTarget,
} from "../../../src/pipeline/floridaFinance/floridaExplicitIndependentExpenditure.js";

const header = FLORIDA_NATIVE_EXPENDITURE_HEADERS.join("\t");
function native(cells: readonly string[][]): string {
  return `${header}\r\n${cells.map((row) => row.join("\t")).join("\r\n")}\r\n`;
}
const maplesCells = [
  "2026", "SG3", "03/23/2026", "525.00", "BUZZ360, LLC",
  "Fixture address", "Fixture city/state/zip", "TEXT MESSAGES; PRO-JON MAPLES, HD-87", "IEC",
];
const falikCells = [
  "2026", "P7", "08/11/2026", "9750.00", "GO VIRAL",
  "Fixture address", "Fixture city/state/zip",
  "DIGITAL ADVERTISING TO SUPPORT GREG FALIK OSCEOLA COUNTY SCHOOL BOARD DISTRICT 1", "IEC",
];
function row(cells = maplesCells): FloridaNativeExpenditure {
  return decodeFloridaNativeExpenditureTsv(native([cells]))[0];
}
function reportHtml(overrides: Record<string, string> = {}, amended = false): string {
  const fields = {
    lblID: "83500", lblFullName: "RSLC - Florida", lblReportIdentifier: "Report: 2026 - SG3 - 57",
    lblCoveragePeriod: "3/20/2026-3/24/2026", lblElectionID: "2026 Special Election - Senate 14 &amp; House 87",
    lblFileStatus: "Filed Report", lblReviewStatus: "Reviewed", lblCompletenessStatus: "Complete Detail Records",
    lblQueuedItems: "0", lblCntExp: "1", lblDateFiled: "3/25/2026 10:56:38 AM",
    lblDateReviewed: "3/25/2026", lblPrintDate: "10/11/2026 4:36:28 PM", ...overrides,
  };
  return `<html><body>${Object.entries(fields).map(([key, value]) => `<span id="${key}">${value}</span>`).join("")}
    <input id="chkAmended" type="checkbox" disabled="disabled" ${amended ? 'checked="checked"' : ""}>
    <input id="chkWaiver" type="checkbox" disabled="disabled"></body></html>`;
}
function localMaples(type: "general" | "primary" = "general"): FloridaVerifiedExplicitIeTarget {
  return {
    candidateId: "85f32162-36df-49e9-a297-1a7904bd21d9",
    electionId: type === "general" ? "e3f1bcd4-55c8-485c-9d4f-66b6eb285000" : "fb8ef5cf-37e7-41ff-b522-540743077889",
    candidateName: "Jon Maples", electionYear: 2026, electionType: type,
    electionDescription: `2026 ${type === "general" ? "General" : "Primary"} Election`,
    officeScope: "state_lower", officeName: "State Lower Chamber Legislator", district: "87",
  };
}
function syntheticInput() {
  // Deliberately synthetic protocol fixture; never represents an acquired/local eligible positive.
  const cells = [
    "2026", "G4", "09/30/2026", "525.00", "EXAMPLE VENDOR", "Fixture address", "Fixture city/state/zip",
    "TEXT MESSAGES; PRO-JOHN EXAMPLE, HD-87", "IEC",
  ];
  const target = { ...localMaples(), candidateId: "synthetic-candidate", electionId: "synthetic-election", candidateName: "John Example" };
  return {
    row: row(cells),
    reportContext: decodeFloridaEfsExpenditureElectionContext(reportHtml({
      lblReportIdentifier: "Report: 2026 - G4 - 102", lblCoveragePeriod: "9/26/2026-10/2/2026",
      lblElectionID: "2026 General Election",
    })),
    verifiedTarget: target,
  };
}

describe("Florida native expenditure TSV foundation", () => {
  it("extracts a purpose discovery lead without inventing report or financial metadata", () => {
    expect(parseFloridaExplicitIePurpose(maplesCells[7])).toMatchObject({ status: "parsed",
      target: { candidateName: "JON MAPLES", district: "87", officeScope: "state_lower" } });
    expect(parseFloridaExplicitIePurpose("TEXT MESSAGES; PRO-JON MAPLES AND JOHN EXAMPLE, HD-87"))
      .toMatchObject({ status: "unmatched" });
    const negative = [...maplesCells]; negative[3] = "-525.00";
    expect(parseFloridaExplicitIndependentExpenditureTarget(row(negative)))
      .toMatchObject({ reason: "not_positive_ie_occurrence" });
  });
  it("retains full financial fields and repeated identical filed occurrences", () => {
    const decoded = decodeFloridaNativeExpenditureTsv(native([falikCells, falikCells]));
    expect(decoded).toHaveLength(2);
    expect(decoded.map((r) => r.occurrence)).toEqual([0, 1]);
    expect(decoded[0]).toMatchObject({ reportYear: 2026, reportType: "P7", date: "2026-08-11", amountCents: 975000 });
    expect(decoded[0].purpose).toBe(falikCells[7]);
    expect(decoded[0].purpose.length).toBeGreaterThan(40);
    expect(decoded[0].rawFields).toEqual(Object.fromEntries(FLORIDA_NATIVE_EXPENDITURE_HEADERS.map((key, i) => [key, falikCells[i]])));
    expect(decoded[0].rawFields).toEqual(decoded[1].rawFields);
  });
  it("retains signed and nonIEC source records for later policy, without promoting them", () => {
    const negative = [...maplesCells]; negative[3] = "-525.00";
    const nonIe = [...maplesCells]; nonIe[8] = "REF";
    expect(row(negative).amountCents).toBe(-52500);
    expect(parseFloridaExplicitIndependentExpenditureTarget(row(negative))).toMatchObject({ reason: "not_positive_ie_occurrence" });
    expect(parseFloridaExplicitIndependentExpenditureTarget(row(nonIe))).toMatchObject({ reason: "not_unqualified_candidate_ie" });
  });
  it("decodes header-only as empty rows with no financial completeness/zero claim", () => {
    expect(decodeFloridaNativeExpenditureTsv(`${header}\r\n`)).toEqual([]);
  });
  it.each(["525.001", "5,25.00", "NaN", "$525.00", "525", "9007199254740992.00"])("rejects malformed/unsafe cents %s", (amount) => {
    const cells = [...maplesCells]; cells[3] = amount;
    expect(() => row(cells)).toThrow(/exact cents/);
  });
  it.each(["02/29/2026", "13/01/2026", "02/30/2026", "2026-03-23"])("rejects invalid native date %s", (date) => {
    const cells = [...maplesCells]; cells[2] = date;
    expect(() => row(cells)).toThrow("civil date");
  });
  it("rejects missing fields, extra fields, wrong header, HTML suffix and embedded controls", () => {
    for (const raw of [native([maplesCells.slice(0, -1)]), native([[...maplesCells, "extra"]]), native([maplesCells]).replace("Purpose", "Note"), native([maplesCells])+"<html>error</html>\n", native([maplesCells]).replace("BUZZ360", "BUZZ\u0000")]) {
      expect(() => decodeFloridaNativeExpenditureTsv(raw)).toThrow();
    }
  });
});

describe("source-witnessed explicit IE target phrases", () => {
  it.each([
    ["DATA SUPPORTING JOHN EXAMPLE (HD-80)", "state_lower", "80"],
    ["MAILER & PHONE BANKS SUPPORTING JANE EXAMPLE (SD-39)", "state_upper", "39"],
  ])("parses complete single-target legislative allocations: %s", (purpose, scope, district) => {
    expect(parseFloridaExplicitIePurpose(purpose)).toMatchObject({ status: "parsed", target: {
      officeScope: scope, district, supportOppose: "support",
    } });
  });
  it.each([
    "DATA SUPPORTING JOHN EXAMPLE AND JANE EXAMPLE (HD-80)",
    "DATA SUPPORTING JOHN EXAMPLE (HD-80) AND JANE EXAMPLE (HD-81)",
    "DATA SUPPORTING JOHN EXAMPLE (SD-41)",
    "MAILER & PHONE BANKS SUPPORTING JANE EXAMPLE (HD-121)",
    "DATA SUPPORTING JOHN EXAMPLE (HD-080)",
    "DATA OPPOSING JOHN EXAMPLE (HD-80)",
    "DATA SUPPORTING JOHN EXAMPLE (HD-80) GENERAL ELECTION",
    "MAILER & PHONE BANKS SUPPORTING JOHN EXAMPLE",
  ])("preserves unsupported/pooled/truncated legislative purpose: %s", purpose => {
    expect(parseFloridaExplicitIePurpose(purpose)).toMatchObject({ status: "unmatched" });
  });
  it("parses the genuine RSLC purpose without converting its Special election into General", () => {
    expect(parseFloridaExplicitIndependentExpenditureTarget(row())).toEqual({
      status: "parsed", target: { candidateName: "JON MAPLES", supportOppose: "support", officeScope: "state_lower", officeName: "State Lower Chamber Legislator", district: "87", county: null, grammar: "pro_house" },
    });
  });
  it.each([
    [falikCells[7], "GREG FALIK", "OSCEOLA", "1"],
    ["DIGITAL ADVERTISING TO SUPPORT ALFREDA DENSON-BUTLER DUVAL COUNTY SCHOOL BOARD DISTRICT 4", "ALFREDA DENSON-BUTLER", "DUVAL", "4"],
    ["DIGITAL ADVERTISING TO SUPPORT MELISSA LOPEZ MARANTES ORANGE COUNTY SCHOOL BOARD DISTRICT 1", "MELISSA LOPEZ MARANTES", "ORANGE", "1"],
    ["DIGITAL ADVERTISING TO SUPPORT ANGIE GALLO ORANGE COUNTY SCHOOL BOARD AT-LARGE", "ANGIE GALLO", "ORANGE", null],
    ["DIGITAL ADVERTISING TO SUPPORT GLORIA O'NEAL ORANGE COUNTY SCHOOL BOARD DISTRICT 2", "GLORIA O'NEAL", "ORANGE", "2"],
    ["EMAIL MESSAGING IN SUPPORT OF GREG FALIK OSCEOLA COUNTY SCHOOL BOARD DISTRICT 1", "GREG FALIK", "OSCEOLA", "1"],
  ])("parses complete genuine school-board purpose %s", (purpose, candidateName, county, district) => {
    expect(parseFloridaExplicitIndependentExpenditureTarget({ ...row(falikCells), purpose })).toMatchObject({
      status: "parsed", target: { candidateName, county, district, officeScope: "county_school_board", supportOppose: "support" },
    });
  });
  it.each([
    "CANVASSING", falikCells[7].slice(0, 40), "TEXT MESSAGES; PRO-JON MAPLES AND JANE DOE, HD-87",
    "TEXT MESSAGES; PRO-JON MAPLES, HD-87; OPPOSE OTHER CANDIDATE", "TEXT MESSAGES; PRO-JON MAPLES, HD-87 / HD-88",
    "TEXT MESSAGES; PRO-JON MAPLES, HD-87 SHARED COST", "TEXT MESSAGES; PRO-JON MAPLES, HD-0",
    "TEXT MESSAGES; PRO-JON MAPLES, HD-121", "TEXT MESSAGES; PRO-MAPLES, HD-87",
    "DIGITAL ADVERTISING TO SUPPORT GREG FALIK AND JANE DOE OSCEOLA COUNTY SCHOOL BOARD DISTRICT 1",
    "DIGITAL ADVERTISING TO OPPOSE GREG FALIK OSCEOLA COUNTY SCHOOL BOARD DISTRICT 1",
  ])("preserves unsupported/generic/shared target purpose %s", (purpose) => {
    expect(parseFloridaExplicitIndependentExpenditureTarget({ ...row(), purpose }).status).toBe("unmatched");
  });
  it.each(["IEI", "ECC", "CAN", "MON", "REF", "UNKNOWN", "IEC R"])("does not promote expense type %s", (typeAndReimbursement) => {
    expect(parseFloridaExplicitIndependentExpenditureTarget({ ...row(), typeAndReimbursement }).status).toBe("unmatched");
  });
});

describe("independent EFS election context and exact verified target gate", () => {
  it("decodes the genuine Special context and all financial status fields", () => {
    expect(decodeFloridaEfsExpenditureElectionContext(reportHtml())).toMatchObject({
      account: "83500", sequence: 57, reportYear: 2026, reportType: "SG3", electionYear: 2026,
      electionType: "special", electionDescription: "2026 Special Election - Senate 14 & House 87",
      periodStart: "2026-03-20", periodEnd: "2026-03-24", expenseCount: 1, queued: 0, amended: false,
    });
  });
  it.each(["general", "primary"] as const)("rejects actual Maples Special spending against existing local %s election", (type) => {
    const result = matchFloridaExplicitIndependentExpenditure({ row: row(), reportContext: decodeFloridaEfsExpenditureElectionContext(reportHtml()), verifiedTarget: localMaples(type) });
    expect(result).toEqual({ status: "unmatched", reason: "source_target_election_context_mismatch" });
  });
  it("retains actual school-board source target while rejecting state-cohort eligibility", () => {
    const reportContext = decodeFloridaEfsExpenditureElectionContext(reportHtml({ lblID: "93271", lblReportIdentifier: "Report: 2026 - P7 - 2", lblCoveragePeriod: "8/1/2026-8/13/2026", lblElectionID: "2026 General Election", lblCntExp: "5" }));
    expect(matchFloridaExplicitIndependentExpenditure({ row: row(falikCells), reportContext, verifiedTarget: localMaples() })).toMatchObject({ reason: "noneligible_source_target_office" });
  });
  it("classifies a synthetic positive only when supplied independent identity matches, without claiming financial completeness", () => {
    const input = syntheticInput();
    expect(matchFloridaExplicitIndependentExpenditure(input)).toMatchObject({ status: "matched", amountCents: 52500, candidateId: "synthetic-candidate" });
    expect(matchFloridaExplicitIndependentExpenditure(input)).not.toHaveProperty("complete");
  });
  it("does not reject a currently processed amended context solely for missing expenseIDs", () => {
    const input = syntheticInput(); input.reportContext.amended = true;
    expect(matchFloridaExplicitIndependentExpenditure(input).status).toBe("matched");
  });
  it.each([
    ["candidateName", "John Middle Example", "source_target_full_name_mismatch"],
    ["candidateName", "Johnny Example", "source_target_full_name_mismatch"],
    ["district", "88", "source_target_office_or_seat_mismatch"],
    ["officeName", "State Senator", "source_target_office_or_seat_mismatch"],
    ["officeScope", "state_upper", "source_target_office_or_seat_mismatch"],
    ["electionYear", 2024, "source_target_election_context_mismatch"],
    ["electionDescription", "2026 General Election - Other Context", "source_target_election_context_mismatch"],
  ])("preserves exact verified target mismatch %s", (key, value, reason) => {
    const input = syntheticInput(); Object.assign(input.verifiedTarget, { [key]: value });
    expect(matchFloridaExplicitIndependentExpenditure(input)).toMatchObject({ status: "unmatched", reason });
  });
  it("does not borrow source report year/type from the matched target", () => {
    const input = syntheticInput(); input.row.reportType = "SG3";
    expect(matchFloridaExplicitIndependentExpenditure(input)).toMatchObject({ reason: "row_report_identity_mismatch" });
    input.row.reportType = "G4"; input.row.reportYear = 2025;
    expect(matchFloridaExplicitIndependentExpenditure(input)).toMatchObject({ reason: "row_report_identity_mismatch" });
  });
  it("keeps context decoder strict for incomplete, duplicated, unknown or malformed evidence", () => {
    for (const html of [reportHtml().replace("</html>", ""), reportHtml()+ '<span id="lblID">83500</span>', reportHtml({ lblElectionID: "2026 Election" }), reportHtml({ lblCntExp: "unknown" }), reportHtml({ lblCoveragePeriod: "3/25/2026-3/24/2026" }), reportHtml().replace('id="chkAmended"', 'id="other"')]) {
      expect(() => decodeFloridaEfsExpenditureElectionContext(html)).toThrow();
    }
  });
  it("does not reinterpret data-checked as the actual amendment checkbox", () => {
    const context = decodeFloridaEfsExpenditureElectionContext(reportHtml().replace('id="chkAmended"', 'id="chkAmended" data-checked="checked"'));
    expect(context.amended).toBe(false);
    expect(decodeFloridaEfsExpenditureElectionContext(reportHtml({}, true)).amended).toBe(true);
  });
  it("rejects a zero-expense report as the context of a positive row", () => {
    const input = syntheticInput(); input.reportContext.expenseCount = 0;
    expect(matchFloridaExplicitIndependentExpenditure(input)).toMatchObject({ reason: "unusable_current_report_status" });
  });
  it("preserves incomplete current status instead of assuming a positive report is usable", () => {
    const input = syntheticInput(); input.reportContext.queued = 1;
    expect(matchFloridaExplicitIndependentExpenditure(input)).toMatchObject({ reason: "unusable_current_report_status" });
  });
});
