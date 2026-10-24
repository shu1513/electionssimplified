import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  classifyErtsSearchResult,
  ertsUsDateToIso,
  parseErtsCf8IndexPage,
  parseErtsCf8Pager,
  parseErtsContributionExport,
  parseErtsCsv,
  parseErtsFilingListPage,
  parseErtsFilingVersionsPage,
  parseErtsMoneyToCents,
  parseErtsOrganizationSearchPage,
  parseErtsSummaryGroupings,
  readErtsCf2SummaryValues,
  ERTS_CONTRIBUTION_EXPORT_COLUMNS,
  ERTS_CONTRIBUTION_TYPE_CODES,
} from "../../../src/pipeline/rhodeIslandFinance/rhodeIslandErtsParsers.js";

import { selectErtsCycleCf2Filings } from "../../../src/pipeline/rhodeIslandFinance/rhodeIslandErtsArtifactAcquisition.js";

// Fixtures are trimmed captures of the live ERTS pages taken during the PR 3
// acquisition spike (2026-08-13). They pin the shapes the spike proved so a
// silent portal change shows up as a test failure rather than as wrong money.
function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../fixtures/rhodeIslandFinance/${name}`, import.meta.url)), "utf8");
}

describe("parseErtsMoneyToCents", () => {
  it("reads the portal's and the CF-2's money formats", () => {
    expect(parseErtsMoneyToCents("$ 1,019,993.37")).toBe(101_999_337);
    expect(parseErtsMoneyToCents("202,028.63")).toBe(20_202_863);
    expect(parseErtsMoneyToCents("0")).toBe(0);
    // CF-2 page 1 prints negative amounts in parentheses.
    expect(parseErtsMoneyToCents("(3,500.00)")).toBe(-350_000);
    // The detail export prints four decimals.
    expect(parseErtsMoneyToCents("250.0000")).toBe(25_000);
    expect(parseErtsMoneyToCents("1063.5000")).toBe(106_350);
  });

  it("rejects sub-cent precision rather than rounding it away", () => {
    expect(parseErtsMoneyToCents("250.0050")).toBeNull();
  });

  it("returns null for anything that is not an amount", () => {
    expect(parseErtsMoneyToCents("")).toBeNull();
    expect(parseErtsMoneyToCents("Total")).toBeNull();
    expect(parseErtsMoneyToCents("04/01/2026")).toBeNull();
  });
});

describe("ertsUsDateToIso", () => {
  it("reads zero-padded and single-digit US dates", () => {
    expect(ertsUsDateToIso("04/01/2026")).toBe("2026-04-01");
    expect(ertsUsDateToIso("1/1/1900")).toBe("1900-01-01");
  });

  it("rejects malformed and impossible dates", () => {
    expect(ertsUsDateToIso("2026-04-01")).toBeNull();
    expect(ertsUsDateToIso("13/01/2026")).toBeNull();
    expect(ertsUsDateToIso("02/30/2026")).toBeNull();
    expect(ertsUsDateToIso("")).toBeNull();
  });
});

describe("parseErtsSummaryGroupings", () => {
  it("reads the contribution report's official per-type totals", () => {
    const totals = parseErtsSummaryGroupings(fixture("contribution-report-summary.html"), "dgrReport");
    expect(Object.fromEntries(totals)).toEqual({
      Individual: 24_126_429,
      PAC: 1_245_000,
      "Interest Received": 511_677,
      "In-Kind - Individual": 350_800,
      "Other Receipt": 11_395,
    });
  });

  it("reads the expenditure report's total", () => {
    const totals = parseErtsSummaryGroupings(fixture("expenditure-report-summary.html"), "dgrExpenditureSummary");
    expect(Object.fromEntries(totals)).toEqual({ "Campaign Expenditure": 94_543_457 });
  });
});

describe("parseErtsCsv", () => {
  it("parses the detail export with its pinned column list", () => {
    const rows = parseErtsCsv(fixture("contribution-export-sample.csv"));
    expect(rows[0]).toEqual([...ERTS_CONTRIBUTION_EXPORT_COLUMNS]);
    expect(rows).toHaveLength(5);
    const contDesc = rows[0].indexOf("ContDesc");
    // Every itemized type the export can carry must exist in the pinned
    // vocabulary, or decision 13's mapping table has a hole.
    for (const row of rows.slice(1)) {
      expect(ERTS_CONTRIBUTION_TYPE_CODES[row[contDesc]]).toBeTypeOf("number");
    }
  });

  it("keeps commas inside quoted fields", () => {
    expect(parseErtsCsv('a,b\n1,"Murray, Paul S."\n')).toEqual([
      ["a", "b"],
      ["1", "Murray, Paul S."],
    ]);
  });
});

describe("parseErtsContributionExport", () => {
  it("types the export rows, treating 1/1/1900 as no deposit date", () => {
    const rows = parseErtsContributionExport(fixture("contribution-export-sample.csv"));
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      contributionId: "1063890",
      contributionType: "Individual",
      receiptDateIso: "2026-04-01",
      depositDateIso: null,
      amountCents: 25_000,
      mpfMatchAmountCents: 0,
      fullName: "Murray, Paul S.",
      employerName: "Cultivating RI",
      incomplete: false,
      transType: "Contribution",
    });
    expect(rows[2].amountCents).toBe(114_953);
  });

  it("fails closed when the pinned header drifts", () => {
    expect(() => parseErtsContributionExport("ContributionID,Amount\n1,250.0000\n")).toThrow(
      /export header changed/
    );
  });

  it("fails closed on an unparseable amount", () => {
    const csv = fixture("contribution-export-sample.csv").replace("250.0000", "n/a");
    expect(() => parseErtsContributionExport(csv)).toThrow(/unparseable amount or receipt date/);
  });
});

describe("parseErtsFilingListPage", () => {
  const rows = parseErtsFilingListPage(fixture("organization-filings.html"));

  it("reads filed and unfiled rows with their amendment state and View links", () => {
    expect(rows).toHaveLength(4);
    const unfiled = rows[0];
    expect(unfiled).toMatchObject({ reportType: "2026 MPF-2 Primary Day", filedAt: "", filingId: null, formName: null });
    const amended = rows.find((row) => row.amended);
    expect(amended).toMatchObject({
      reportType: "2025 On-Going Qrtly (4th)",
      periodBegin: "10/01/2025",
      periodEnd: "12/31/2025",
      status: "Received by BOE",
      filingId: "230557",
      formName: "RICF2",
    });
    expect(amended?.filedAt).toMatch(/^Feb\s+2 2026/);
    expect(amended?.amendmentSelectUrl).toContain("FilingAmendmentSelect.aspx");
  });

  it("distinguishes CF-2 filings from MPF forms by FormName", () => {
    expect(rows.filter((row) => row.formName === "RICF2")).toHaveLength(2);
    expect(rows.filter((row) => row.formName === "RIMPF2")).toHaveLength(1);
  });

  function registrationRow(input: { title?: string; begin?: string; end?: string; filed?: boolean; form?: string; link?: boolean } = {}) {
    const filed = input.filed !== false;
    const link = input.link ?? filed;
    const href = `https://secure.ricampaignfinance.com/RhodeIslandCF/Candidate/FilingAmendmentSelect.aspx?X=T&amp;FilingID=41&amp;FormName=${input.form ?? "RICF1"}`;
    return `<tr><td>${input.title ?? "Amendment of Organization"}</td><td>${input.begin ?? ""}</td><td>${input.end ?? ""}</td><td></td><td>${filed ? "Received by BOE" : "Not Filed"}</td><td>${filed ? "Jan 2 2026 1:00PM" : ""}</td><td>No</td><td>${link ? `<a href="${href}">View</a>` : ""}</td></tr>`;
  }
  function registrationPage(row: string) {
    return `<table id="grdSearchResults">${row}</table>`;
  }

  it.each(["Notice of Organization - (CF-1)", "Amendment of Organization"])("preserves a filed %s with no reporting period", title => {
    expect(parseErtsFilingListPage(registrationPage(registrationRow({ title })))).toEqual([
      expect.objectContaining({ reportType: title, periodBegin: "", periodEnd: "", filingId: "41", formName: "RICF1", filedAt: "Jan 2 2026 1:00PM" }),
    ]);
  });

  it("preserves a known unfiled registration without inventing dates or a filing id", () => {
    expect(parseErtsFilingListPage(registrationPage(registrationRow({ filed: false })))).toEqual([
      expect.objectContaining({ periodBegin: "", periodEnd: "", filedAt: "", filingId: null, formName: null }),
    ]);
  });

  it.each([
    { title: "Unknown report" }, { form: "RICF2" }, { begin: "01/01/2026" },
    { end: "not a date" }, { link: false }, { filed: false, link: true },
  ])("continues to reject an unqualified nonperiod record %o", input => {
    expect(() => parseErtsFilingListPage(registrationPage(registrationRow(input)))).toThrow(/does not match the pinned shape/);
  });

  it("leaves CF-2 selection unchanged while retaining known registration metadata", () => {
    const html = fixture("organization-filings.html").replace("</table>", registrationRow() + registrationRow({ filed: false }) + "</table>");
    const all = parseErtsFilingListPage(html);
    const selection = selectErtsCycleCf2Filings({ rows: all, cycleBeginIso: "2025-01-01", cycleEndIso: "2026-12-31" });
    expect(all).toHaveLength(6);
    expect(selection.selected.map(row => row.filingId).sort()).toEqual(["230557", "239295"]);
    expect(selection.nonCf2FiledRowCount).toBe(2);
    expect(selection.unfiledRowCount).toBe(2);
  });

  it("throws on a data-like row whose period no longer parses", () => {
    // A silently dropped filing would silently drop its reporting period.
    const drifted = fixture("organization-filings.html").replace("10/01/2025", "Oct 1, 2025");
    expect(() => parseErtsFilingListPage(drifted)).toThrow(/does not match the pinned shape/);
  });
});

describe("parseErtsFilingVersionsPage", () => {
  it("lists versions oldest-first with their generated PDFs", () => {
    const versions = parseErtsFilingVersionsPage(fixture("filing-amendments-230557.html"));
    expect(versions).toHaveLength(2);
    expect(versions[0].amendmentLabel).toBe("");
    expect(versions[1].amendmentLabel).toBe("Amended");
    expect(versions.every((version) => /\/ExportDocs\/2235-RICF2-230557-[0-9a-f-]+\.pdf$/.test(version.pdfUrl))).toBe(
      true
    );
  });

  it("throws on a data row without a PDF link instead of promoting an older version", () => {
    // Dropping the LATEST row would make the previous filing read as
    // "in force" — stale totals, silently.
    const drifted = fixture("filing-amendments-230557.html").replace(
      /href="[^"]*c3881961[^"]*"/,
      'href="/broken/link"'
    );
    expect(() => parseErtsFilingVersionsPage(drifted)).toThrow(/no \/ExportDocs\/ PDF link/);
  });
});

describe("parseErtsOrganizationSearchPage", () => {
  // Live shape (contrib-orgresults capture, 2026-08-13): name select link
  // ($lnkOrgID), address, city, state, status, then a full-width pager row.
  function searchRow(target: string, name: string, status: string): string {
    return (
      `<tr class="GridItem"><td><span><a id="x" href="javascript:__doPostBack('${target}','')">${name}</a></span></td>` +
      `<td>12 HILLSIDE ROAD</td><td>CUMBERLAND</td><td>RI</td><td>${status}</td></tr>`
    );
  }
  const header = "<tr class=\"GridHeader\"><td>Organization Name</td><td>Address</td><td>City</td><td>State</td><td>Status</td></tr>";

  it("reads name, postback target, and status; a bare pager means one page", () => {
    const html =
      '<table id="dgdOrgSearchResults">' +
      header +
      searchRow("dgdOrgSearchResults$ctl03$lnkOrgID", "DANIEL J MCKEE", "Active") +
      searchRow("dgdOrgSearchResults$ctl04$lnkOrgID", "TIMOTHY L MCKEE", "Inactive") +
      '<tr align="right"><td colspan="5"><span>1</span></td></tr>' +
      "</table>";
    expect(parseErtsOrganizationSearchPage(html)).toEqual({
      rows: [
        {
          organizationName: "DANIEL J MCKEE",
          postbackTarget: "dgdOrgSearchResults$ctl03$lnkOrgID",
          status: "Active",
        },
        {
          organizationName: "TIMOTHY L MCKEE",
          postbackTarget: "dgdOrgSearchResults$ctl04$lnkOrgID",
          status: "Inactive",
        },
      ],
      hasMorePages: false,
    });
  });

  it("flags a pager with page links as an incomplete slice", () => {
    const html =
      '<table id="dgdOrgSearchResults">' +
      header +
      searchRow("dgdOrgSearchResults$ctl03$lnkOrgID", "JOHN SMITH", "Active") +
      "<tr align=\"right\"><td colspan=\"5\"><span>1</span>&nbsp;<a href=\"javascript:__doPostBack('dgdOrgSearchResults$ctl29$ctl01','')\">2</a></td></tr>" +
      "</table>";
    expect(parseErtsOrganizationSearchPage(html)).toMatchObject({ hasMorePages: true });
  });

  it("throws on a data-like row that fails the pinned shape", () => {
    // A silently dropped row is a committee the resolver never sees.
    const html =
      '<table id="dgdOrgSearchResults">' +
      header +
      "<tr class=\"GridItem\"><td>DANIEL J MCKEE</td><td>12 HILLSIDE ROAD</td><td>CUMBERLAND</td><td>RI</td><td>Active</td></tr>" +
      "</table>";
    expect(() => parseErtsOrganizationSearchPage(html)).toThrow(/pinned shape/);
  });
});

describe("readErtsCf2SummaryValues", () => {
  // CF-2 page 1 is a two-column form: the ending-balance amount sits on the
  // same baseline as an unrelated left-column label, so "nearest amount to the
  // right" is what makes the mapping correct.
  const items = [
    { text: "7. Interest Received", x: 48, y: 327 },
    { text: "3,373.87", x: 254, y: 327 },
    { text: "$ 1,110,487.44", x: 526, y: 327 },
    { text: "6. Report of In-Kind Contributions", x: 300, y: 357 },
    { text: "31.00", x: 559, y: 357 },
    { text: "1. Beginning Cash Balance", x: 24, y: 471 },
    { text: "$ 1,019,993.37", x: 232, y: 471 },
  ];

  it("binds each label to the nearest amount on its baseline", () => {
    const values = readErtsCf2SummaryValues(items, [
      "1. Beginning Cash Balance",
      "7. Interest Received",
      "6. Report of In-Kind Contributions",
    ]);
    expect(values.get("7. Interest Received")).toBe(337_387);
    expect(values.get("6. Report of In-Kind Contributions")).toBe(3_100);
    expect(values.get("1. Beginning Cash Balance")).toBe(101_999_337);
  });

  it("omits labels the page does not carry", () => {
    expect(readErtsCf2SummaryValues(items, ["11. Matching Public Funds"]).size).toBe(0);
  });
});

describe("parseErtsCf8IndexPage", () => {
  it("reads the Other Filings grid and absolutizes the scan links", () => {
    const rows = parseErtsCf8IndexPage(fixture("cf8-index-page1.html"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.scannedUrl?.startsWith("https://www.ricampaignfinance.com/ReportsScanned/"))).toBe(
      true
    );
    // Filing type drives decision 6's gate: only INDEPENDENT EXPENDITURE rows
    // can ever produce candidate outside rows.
    expect(rows.some((row) => row.filingType === "INDEPENDENT EXPENDITURE")).toBe(true);
    expect(rows.every((row) => row.filedDate !== "" && row.organizationName !== "")).toBe(true);
  });

  it("throws on a data-like row whose filed date no longer parses", () => {
    // A silently dropped row is a silently missed outside-spending filing.
    const drifted = fixture("cf8-index-page1.html").replace("Aug 12 2026", "08/12/2026");
    expect(() => parseErtsCf8IndexPage(drifted)).toThrow(/does not match the pinned shape/);
  });
});

describe("classifyErtsSearchResult", () => {
  const expenseEmpty = '<span id="lblNoReportMsg">There were no reports found, please try your search again.</span>';
  it("recognizes the native expense empty marker only in the expense context", () => {
    expect(classifyErtsSearchResult(expenseEmpty, "dgrExpenditure")).toBe("no_rows");
    expect(classifyErtsSearchResult(expenseEmpty, "dgrContribution")).toBe("unreadable");
  });
  it.each([
    expenseEmpty.replace('id="lblNoReportMsg"', 'id="other"'),
    expenseEmpty.replace("There were no reports found, please try your search again.", "There were no reports found."),
    "<p>There were no reports found, please try your search again.</p>",
    "<p>No Contributions were found for the Search criteria you entered.</p>",
    "<p>No Records were found for the Search criteria you entered.</p>",
  ])("rejects a generic or wrong-context expense empty page", (html) => {
    expect(classifyErtsSearchResult(html, "dgrExpenditure")).toBe("unreadable");
  });
  it("recognizes a result grid, the portal's no-rows message, and nothing else", () => {
    expect(classifyErtsSearchResult('<table id="dgrContribution"><tr></tr></table>', "dgrContribution")).toBe("rows");
    expect(
      classifyErtsSearchResult("<p>No Contributions were found for the Search criteria you entered</p>", "dgrContribution")
    ).toBe("no_rows");
    // A Cloudflare challenge or error page must never read as "no rows" —
    // that verdict is what lets a type's absence from the export be accepted.
    expect(classifyErtsSearchResult("<html><body>Checking your browser…</body></html>", "dgrContribution")).toBe(
      "unreadable"
    );
    expect(classifyErtsSearchResult("", "dgrContribution")).toBe("unreadable");
  });
});

describe("parseErtsCf8Pager", () => {
  it("reads the current page and the numbered pager links", () => {
    const pager = parseErtsCf8Pager(fixture("cf8-index-page1.html"));
    expect(pager.currentPage).toBe(1);
    expect(pager.links.map((link) => link.label)).toEqual(["2", "3", "4", "5", "6", "7", "8", "9", "10", "..."]);
    // Control ids are positional, so page "2" is ctl01 — following ids in
    // order would walk backwards into page 1.
    expect(pager.links[0].target).toBe("dgdCF8FilingList$ctl14$ctl01");
  });
});
