import { describe, expect, it } from "vitest";

import {
  normalizeMissouriMecElectionDate,
  parseMissouriMecCandidateExport,
  parseMissouriMecCandidateExportWithDiagnostics,
  parseMissouriMecCommitteeIdentity,
  parseMissouriMecCommitteeActivityRows,
  parseMissouriMecCommitteeInfo,
  parseMissouriMecContributionExport,
  parseMissouriMecExpenditureExport,
  parseMissouriMecFullDisclosureCount,
  parseMissouriMecOutsideSpendingExport,
  parseMissouriMecOutsideSpendingGridPage,
  parseMissouriMecOutsideSpenderIdentities,
  parseMissouriMecReportInventory,
  parseMissouriMecReportYears,
} from "../../../src/pipeline/missouriFinance/missouriMecParsers.js";

describe("missouriMecParsers", () => {
  it("requires an explicit consistent full-disclosure count, including zero", () => {
    expect(parseMissouriMecFullDisclosureCount("<span>Full Disclosure Reports (1,234)</span>")).toBe(1234);
    expect(parseMissouriMecFullDisclosureCount("Full Disclosure <b>Reports</b> (0)")).toBe(0);
    expect(parseMissouriMecFullDisclosureCount("Full Disclosure Reports (12) Full Disclosure Reports (12)")).toBe(12);
    expect(() => parseMissouriMecFullDisclosureCount("No records found")).toThrow("Missing Missouri MEC");
    expect(() => parseMissouriMecFullDisclosureCount("Full Disclosure Reports (0) Full Disclosure Reports (1)")).toThrow("Conflicting Missouri MEC");
    for (const value of ["-1", "1,23", "1.5", "9007199254740992", "private source value"]) {
      expect(() => parseMissouriMecFullDisclosureCount(`Full Disclosure Reports (${value})`)).toThrow("Invalid Missouri MEC full-disclosure result count");
    }
  });

  it("parses the pinned candidate-by-election Excel export", () => {
    const html = `
      <table>
        <tr><th>MECID</th><th>Committee Name</th><th>Candidate Name</th><th>Party</th><th>Office Sought</th><th>Status</th></tr>
        <tr><td>C221944</td><td>Forward With Farnan</td><td>Jeff Farnan</td><td>R</td><td>State Representative - District 1 - Missouri House of Representatives</td><td>A</td></tr>
      </table>
    `;

    expect(parseMissouriMecCandidateExport(html)).toEqual([
      {
        mecid: "C221944",
        committeeName: "Forward With Farnan",
        candidateName: "Jeff Farnan",
        party: "R",
        officeSought: "State Representative - District 1 - Missouri House of Representatives",
        status: "A",
      },
    ]);
  });

  it("fails closed when the candidate export schema drifts", () => {
    expect(() =>
      parseMissouriMecCandidateExport(
        "<table><tr><th>MECID</th><th>Candidate Name</th></tr><tr><td>C221944</td><td>Jeff Farnan</td></tr></table>"
      )
    ).toThrow("Unexpected Missouri MEC candidate export header");
  });

  it.each([
    "<table><tr><th>MECID</th></tr>",
    "<table><tr><th>MECID</th></tr><tr><td>private value</td></table>",
    "<table><tr><th>MECID</th></tr><tr><td>private value</tr></table>",
    "<table><tr><th>MECID</td></tr></table>",
    "<table><tr><th><table></table></th></tr></table>",
  ])("rejects an incomplete table before accepting its closed prefix", (html) => {
    expect(() => parseMissouriMecContributionExport(html)).toThrow("Incomplete or malformed Missouri MEC export table");
  });

  it("counts but excludes candidate exemption registrations from committee resolution", () => {
    const html = `<table><tr>${[
      "MECID", "Committee Name", "Candidate Name", "Party", "Office Sought", "Status",
    ].map((value) => `<th>${value}</th>`).join("")}</tr><tr>${[
      "C264258E", "Jim Kalberloh", "Jim Kalberloh", "", "State Representative District 45", "Terminated",
    ].map((value) => `<td>${value}</td>`).join("")}</tr></table>`;
    expect(parseMissouriMecCandidateExportWithDiagnostics(html)).toEqual({
      rows: [], sourceRowCount: 1, excludedExemptionRegistrationCount: 1,
    });
    expect(parseMissouriMecCandidateExport(html)).toEqual([]);
  });

  it("parses aligned Committee Info election-history evidence", () => {
    const html = `
      <span id="ContentPlaceHolder_ContentPlaceHolder1_lblMECID">C221944</span>
      <span id="ContentPlaceHolder_ContentPlaceHolder1_lblCommName">Forward With Farnan</span>
      <span id="ContentPlaceHolder_ContentPlaceHolder1_lblCandName">Jeff Farnan</span>
      <span id="ContentPlaceHolder_ContentPlaceHolder1_gvElecHistory_lblElecYear_0">11/3/2026</span>
      <span id="ContentPlaceHolder_ContentPlaceHolder1_gvElecHistory_lblElectionType_0">General Election</span>
      <span id="ContentPlaceHolder_ContentPlaceHolder1_gvElecHistory_lblSub_0">State Representative</span>
      <span id="ContentPlaceHolder_ContentPlaceHolder1_gvElecHistory_lblPolSub_0">Missouri House of Representatives</span>
      <span id="ContentPlaceHolder_ContentPlaceHolder1_gvElecHistory_lblElecYear_1">8/4/2026</span>
      <span id="ContentPlaceHolder_ContentPlaceHolder1_gvElecHistory_lblElectionType_1">Primary Election</span>
      <span id="ContentPlaceHolder_ContentPlaceHolder1_gvElecHistory_lblSub_1">State Representative</span>
      <span id="ContentPlaceHolder_ContentPlaceHolder1_gvElecHistory_lblPolSub_1">Missouri House of Representatives</span>
    `;

    expect(parseMissouriMecCommitteeInfo(html)).toEqual({
      mecid: "C221944",
      committeeName: "Forward With Farnan",
      candidateName: "Jeff Farnan",
      electionHistory: [
        {
          electionDate: "2026-11-03",
          electionType: "General Election",
          office: "State Representative",
          politicalSubdivision: "Missouri House of Representatives",
        },
        {
          electionDate: "2026-08-04",
          electionType: "Primary Election",
          office: "State Representative",
          politicalSubdivision: "Missouri House of Representatives",
        },
      ],
      sourceUrl: "https://www.mec.mo.gov/MEC/Campaign_Finance/CommInfo.aspx?MECID=C221944",
    });
  });

  it("keeps old election-history rows whose source subdivision is blank", () => {
    const html = `
      <span id="x_lblMECID">C180076</span><span id="x_lblCommName">Example Committee</span><span id="x_lblCandName">Jane Doe</span>
      <span id="x_gvElecHistory_lblElecYear_0">11/3/2026</span>
      <span id="x_gvElecHistory_lblElectionType_0">General Election</span>
      <span id="x_gvElecHistory_lblSub_0">State Representative</span>
      <span id="x_gvElecHistory_lblPolSub_0">Missouri House of Representatives</span>
      <span id="x_gvElecHistory_lblElecYear_1">11/6/2018</span>
      <span id="x_gvElecHistory_lblElectionType_1">General Election</span>
      <span id="x_gvElecHistory_lblSub_1">Circuit Judge</span>
      <span id="x_gvElecHistory_lblPolSub_1"></span>
    `;
    expect(parseMissouriMecCommitteeInfo(html).electionHistory[1]).toEqual({
      electionDate: "2018-11-06", electionType: "General Election", office: "Circuit Judge", politicalSubdivision: "",
    });
  });

  it("parses a non-candidate committee identity without election history", () => {
    expect(parseMissouriMecCommitteeIdentity(
      '<span id="x_lblMECID">C123456</span><span id="x_lblCommName">Example PAC</span>'
    )).toEqual({ mecid: "C123456", committeeName: "Example PAC" });
  });

  it("parses the exact MECID/name committee-activity table", () => {
    const html = `<table id="x_gvAdvanced"><tr>${[
      "Status Date", "MECID", "Committee Name", "Committee Type", "Committee Candidate", "Committee Status",
    ].map((value) => `<th>${value}</th>`).join("")}</tr><tr>${[
      "8/19/2026", "C123456", "Example PAC", "Political Action", "", "Active",
    ].map((value) => `<td>${value}</td>`).join("")}</tr></table>`;
    expect(parseMissouriMecCommitteeActivityRows(html)).toEqual([{
      statusDate: "2026-08-19", mecid: "C123456", committeeName: "Example PAC",
      committeeType: "Political Action", committeeCandidate: null, committeeStatus: "Active",
    }]);
  });

  it("recognizes exemption registrations without treating their suffixed IDs as committee MECIDs", () => {
    const html = `<table id="x_gvAdvanced"><tr>${[
      "Status Date", "MECID", "Committee Name", "Committee Type", "Committee Candidate", "Committee Status",
    ].map((value) => `<th>${value}</th>`).join("")}</tr><tr>${[
      "7/6/2026", "C264187E", "Charles Bisignano", "Exemption", "Charles Bisignano", "Terminated",
    ].map((value) => `<td>${value}</td>`).join("")}</tr></table>`;
    expect(parseMissouriMecCommitteeActivityRows(html)).toEqual([{
      statusDate: "2026-07-06", mecid: null, committeeName: "Charles Bisignano",
      committeeType: "Exemption", committeeCandidate: "Charles Bisignano", committeeStatus: "Terminated",
    }]);
  });

  it("rejects misaligned Committee Info history instead of pairing wrong rows", () => {
    const html = `
      <span id="x_lblMECID">C221944</span><span id="x_lblCommName">Forward With Farnan</span><span id="x_lblCandName">Jeff Farnan</span>
      <span id="x_gvElecHistory_lblElecYear_0">11/3/2026</span>
      <span id="x_gvElecHistory_lblElectionType_0">General Election</span>
      <span id="x_gvElecHistory_lblSub_0">State Representative</span>
    `;
    expect(() => parseMissouriMecCommitteeInfo(html)).toThrow("Misaligned Missouri MEC election history");
  });

  it("normalizes real MEC dates and rejects rollover dates", () => {
    expect(normalizeMissouriMecElectionDate("4/2/2024")).toBe("2024-04-02");
    expect(() => normalizeMissouriMecElectionDate("2/30/2026")).toThrow("Invalid Missouri MEC election date");
  });

  it("parses pinned contribution/expenditure exports without retaining addresses", () => {
    const contributions = `<table><tr>${[
      "MECID", "Committee", "Report", "Contributor-Committee", "Contributor-Company", "Contributor-Last Name",
      "Contributor-First Name", "Address1", "Address2", "City", "State", "Zip", "Employer", "Occupation",
      "Contribution Date", "Contribution Amount", "Monetary/In-Kind", "Committee",
    ].map((value) => `<th>${value}</th>`).join("")}</tr><tr>${[
      "C263985", "Example Committee", "July Quarterly Report", "", "", "Doe", "Jane", "10 Private St", "",
      "Jefferson City", "MO", "65101", "Example LLC", "Engineer", "8/5/2026", "$1,234.56", "Monetary", "Candidate",
    ].map((value) => `<td>${value}</td>`).join("")}</tr></table>`;
    expect(parseMissouriMecContributionExport(contributions)).toEqual([expect.objectContaining({
      mecid: "C263985", report: "July Quarterly Report", contributionDate: "2026-08-05",
      amountCents: 123456, employer: "Example LLC", occupation: "Engineer",
      trailingCommitteeField: "Candidate",
    })]);
    expect(parseMissouriMecContributionExport(contributions)[0]).not.toHaveProperty("address1");
    for (const malformed of ["$1,23.45", "$12,34,567.89", "$1,.00"]) {
      expect(() => parseMissouriMecContributionExport(contributions.replace("$1,234.56", malformed)))
        .toThrow("Invalid Missouri MEC contribution amount");
    }

    const expenditures = `<table><tr>${[
      "MECID", "Committee Name", "Report", "Expenditure-Last Name", "Expenditure-First Name", "Expenditure-Company",
      "Expenditure-Address1", "Expenditure-Address2", "Expenditure-City", "Expenditure-State", "Expenditure-Zip",
      "Expenditure Purpose", "Expenditure Date", "Expenditure Amount", "Expenditure Type",
    ].map((value) => `<th>${value}</th>`).join("")}</tr><tr>${[
      "C263985", "Example Committee", "July Quarterly Report", "", "", "Printer", "20 Private St", "", "Columbia",
      "MO", "65201", "Signs", "9/1/2026", "($25.00)", "Paid",
    ].map((value) => `<td>${value}</td>`).join("")}</tr></table>`;
    expect(parseMissouriMecExpenditureExport(expenditures)).toEqual([expect.objectContaining({
      amountCents: -2500, expenditureDate: "2026-09-01", expenditureType: "Paid",
    })]);
  });

  it("parses the pinned outside-spending export with explicit stances", () => {
    const html = `<table><tr>${[
      "Candidates Name and Address", "Office Sought", "Support/Oppose", "Date", "Amount",
      "Reporting Committee", "Report",
    ].map((value) => `<th>${value}</th>`).join("")}</tr><tr>${[
      "Jane Doe 10 Private St Jefferson City MO 65101", "District 1 Missouri House of Representatives",
      "Support", "10/20/2026", "$1,234.56", "Example PAC", "8 Day Before General Election-11/3/2026",
    ].map((value) => `<td>${value}</td>`).join("")}</tr></table>`;

    expect(parseMissouriMecOutsideSpendingExport(html)).toEqual([{
      candidateNameAndAddress: "Jane Doe 10 Private St Jefferson City MO 65101",
      officeSought: "District 1 Missouri House of Representatives",
      supportOppose: "Support",
      expenditureDate: "2026-10-20",
      amountCents: 123456,
      reportingCommittee: "Example PAC",
      report: "8 Day Before General Election-11/3/2026",
    }]);
    expect(() => parseMissouriMecOutsideSpendingExport(html.replace(">Support<", ">Favor<"))).toThrow(
      "Incomplete Missouri MEC outside-spending export row"
    );
  });

  it("parses aligned outside-spending grid rows and their exact committee postbacks", () => {
    const html = `
      <span id="x_grvExpenditures_lblName_0">Jane Doe 10 Private St</span>
      <span id="x_grvExpenditures_lblSought_0">State Representative</span>
      <span id="x_grvExpenditures_lblSupp_0">Oppose</span>
      <span id="x_grvExpenditures_lblDate_0">10/20/2026</span>
      <span id="x_grvExpenditures_lblAmount_0">$25.00</span>
      <a id="x_grvExpenditures_lbtnCommittee_0" href="javascript:__doPostBack(&#39;ctl00$grid$ctl02$lbtnCommittee&#39;,&#39;&#39;)">Example PAC</a>
      <span id="x_grvExpenditures_lblReport_0">24 Hour Expenditure Report-11/3/2026 General</span>
      <span id="x_grvExpenditures_CurrentPage"><b><font color="White">2</font></b></span>
      <a id="x_grvExpenditures_lbtnNextPage" href="javascript:__doPostBack(&#39;ctl00$grid$ctl28$lbtnNextPage&#39;,&#39;&#39;)">Next</a>`;
    expect(parseMissouriMecOutsideSpendingGridPage(html)).toEqual({
      currentPage: 2,
      nextPageEventTarget: "ctl00$grid$ctl28$lbtnNextPage",
      rows: [{
        candidateNameAndAddress: "Jane Doe 10 Private St", officeSought: "State Representative",
        supportOppose: "Oppose", expenditureDate: "2026-10-20", amountCents: 2500,
        reportingCommittee: "Example PAC", report: "24 Hour Expenditure Report-11/3/2026 General",
        committeeEventTarget: "ctl00$grid$ctl02$lbtnCommittee",
      }],
    });
    expect(() => parseMissouriMecOutsideSpendingGridPage(html.replace("lblReport_0", "missing_0"))).toThrow(
      "Misaligned Missouri MEC outside-spending grid"
    );
  });

  it("validates outside-spender identity artifacts", () => {
    expect(parseMissouriMecOutsideSpenderIdentities('[{"reportingCommittee":"Example PAC","mecid":"c123456"}]')).toEqual([
      { reportingCommittee: "Example PAC", mecid: "C123456" },
    ]);
    expect(() => parseMissouriMecOutsideSpenderIdentities(
      '[{"reportingCommittee":"Example PAC","mecid":"C123456"},{"reportingCommittee":"Example PAC","mecid":"C654321"}]'
    )).toThrow("Duplicate Missouri MEC outside-spender identity");
    expect(parseMissouriMecOutsideSpenderIdentities('[{"reportingCommittee":"Broken Link PAC","mecid":null}]')).toEqual([
      { reportingCommittee: "Broken Link PAC", mecid: null },
    ]);
  });

  it("parses any expanded report grid index and fails on misalignment", () => {
    const years = `<span id="x_grvReportOutside_lblYear_0">2026</span><span id="x_grvReportOutside_lblYear_1">2025</span>`;
    expect(parseMissouriMecReportYears(years)).toEqual([
      { year: 2026, expandControlName: "grvReportOutside$ctl02$ImgRptRight" },
      { year: 2025, expandControlName: "grvReportOutside$ctl03$ImgRptRight" },
    ]);
    const inventory = `<a id="x_grvReports_2_hlink_0" data-CPID="274835"></a>
      <span id="x_grvReports_2_lblReport_0">AMENDED April Quarterly Report</span>
      <span id="x_grvReports_2_lblDateReceived_0">4/15/2026</span>`;
    expect(parseMissouriMecReportInventory(inventory)).toEqual([{
      reportId: "274835", report: "AMENDED April Quarterly Report", dateFiled: "2026-04-15",
      isAmended: true, lineageKey: "APRIL QUARTERLY REPORT",
    }]);
    expect(() => parseMissouriMecReportInventory(inventory.replace("lblDateReceived", "missing"))).toThrow("Misaligned");
  });
});
