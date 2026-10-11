import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  decodeNcsbeHtmlEntities,
  extractNcsbeEmbeddedJson,
  isNcsbeLegalExpenseFundSboeId,
  ncsbeAmountToCents,
  normalizeNcsbeText,
  parseNcsbeCommitteeSearchPage,
  parseNcsbeDate,
  parseNcsbeDocumentListPage,
  parseNcsbeExpendituresPage,
  parseNcsbeReceiptsPage,
  parseNcsbeReportDetailPage,
  NCSBE_COVER_SECTIONS,
  NORTH_CAROLINA_SBOEID_PATTERN,
} from "../../../src/pipeline/northCarolinaFinance/northCarolinaNcsbeParsers.js";

// Fixtures are real portal bytes captured during the 2026-08-07 acquisition
// spike (see docs/plans/north_carolina_plan.md "Acquisition spike results"); the pinned
// numbers below reproduce the spike's verified money numbers. One deliberate
// deviation: individual contributors' street addresses (Street1/Street2, and
// the +4 zip suffix) are redacted from the receipts fixture — they are public
// record but do not belong in the repo; every field the pipeline consumes is
// untouched.
function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../fixtures/northCarolinaFinance/${name}`, import.meta.url)),
    "utf8"
  );
}

describe("parseNcsbeDate", () => {
  it("parses portal MM/DD/YYYY dates", () => {
    expect(parseNcsbeDate("02/24/2026")).toEqual({ raw: "02/24/2026", iso: "2026-02-24", implausible: false });
  });

  it("treats empty dates as missing, not implausible", () => {
    expect(parseNcsbeDate("")).toEqual({ raw: "", iso: null, implausible: false });
    expect(parseNcsbeDate(null)).toEqual({ raw: "", iso: null, implausible: false });
  });

  it("flags the live year-3026 landmine as implausible with no iso", () => {
    expect(parseNcsbeDate("06/01/3026")).toEqual({ raw: "06/01/3026", iso: null, implausible: true });
  });

  it("flags unparseable dates as implausible", () => {
    expect(parseNcsbeDate("2026-02-24").implausible).toBe(true);
    expect(parseNcsbeDate("13/40/2026").implausible).toBe(true);
  });

  it("rejects impossible calendar dates instead of minting nonexistent ISO days", () => {
    expect(parseNcsbeDate("02/31/2026")).toEqual({ raw: "02/31/2026", iso: null, implausible: true });
    expect(parseNcsbeDate("02/29/2025")).toEqual({ raw: "02/29/2025", iso: null, implausible: true });
    expect(parseNcsbeDate("04/31/2026").implausible).toBe(true);
    // Real leap day stays valid.
    expect(parseNcsbeDate("02/29/2024")).toEqual({ raw: "02/29/2024", iso: "2024-02-29", implausible: false });
  });
});

describe("entity decoding", () => {
  it("decodes the &nbsp; placeholder the portal embeds inside JSON values", () => {
    expect(decodeNcsbeHtmlEntities("&nbsp;")).toBe(" ");
    expect(normalizeNcsbeText("&nbsp;")).toBeNull();
    expect(normalizeNcsbeText("A &amp; B")).toBe("A & B");
  });
});

describe("ncsbeAmountToCents", () => {
  it("converts portal four-decimal amounts exactly", () => {
    expect(ncsbeAmountToCents(6073.24, "test")).toBe(607324);
    expect(ncsbeAmountToCents(31829.1, "test")).toBe(3182910);
  });

  it("rejects non-numeric amounts", () => {
    expect(() => ncsbeAmountToCents("25", "test")).toThrow(/not a finite number/);
  });
});

describe("SBoEID pattern", () => {
  it("matches committee and county ids and classifies legal-expense funds", () => {
    expect(NORTH_CAROLINA_SBOEID_PATTERN.test("STA-JV516O-C-001")).toBe(true);
    expect(NORTH_CAROLINA_SBOEID_PATTERN.test("133-JJ01S7-C-001")).toBe(true);
    expect(NORTH_CAROLINA_SBOEID_PATTERN.test("No Id")).toBe(false);
    expect(isNcsbeLegalExpenseFundSboeId("STA-0S1QL6-F-001")).toBe(true);
    expect(isNcsbeLegalExpenseFundSboeId("STA-JV516O-C-001")).toBe(false);
  });
});

describe("extractNcsbeEmbeddedJson", () => {
  it("fails closed on a page without the marker (the portal's HTML error pages)", () => {
    expect(() =>
      extractNcsbeEmbeddedJson({ html: "<html><body>error</body></html>", marker: "var data = ", open: "[", label: "test" })
    ).toThrow(/marker .* not found/);
  });

  it("fails closed on an unterminated literal", () => {
    expect(() =>
      extractNcsbeEmbeddedJson({ html: 'var data = [{"a": "b"', marker: "var data = ", open: "[", label: "test" })
    ).toThrow(/unterminated/);
  });
});

describe("parseNcsbeCommitteeSearchPage", () => {
  it("parses the single-committee search result", () => {
    const rows = parseNcsbeCommitteeSearchPage(fixture("committee-search-gadson.html"));
    expect(rows).toEqual([
      {
        orgName: "GADSON FOR NORTH CAROLINA (GADSON, MARCUS)",
        sboeId: "STA-JV516O-C-001",
        oldId: null,
        candName: "MARCUS GADSON",
        statusDesc: "ACTIVE (NON-EXEMPT)",
        orgGroupId: 57190,
      },
    ]);
  });

  it("parses a multi-row result with F-type ids, &nbsp; names, and closed statuses", () => {
    const rows = parseNcsbeCommitteeSearchPage(fixture("committee-search-pierce.html"));
    expect(rows).toHaveLength(21);
    const legalFund = rows.find((row) => row.sboeId === "STA-0S1QL6-F-001");
    expect(legalFund).toMatchObject({
      orgName: "PIERCE LEGAL FUND (PIERCE, RONALD L)",
      // The portal renders the missing candidate name as the literal &nbsp;.
      candName: null,
      statusDesc: "CLOSED",
      orgGroupId: 31707,
    });
    expect(rows.every((row) => Number.isInteger(row.orgGroupId))).toBe(true);
  });

  it("parses the redesigned Kendo-grid result page (live 2026-10-10)", () => {
    // Trimmed from the live "Longest" search: rows now sit in the grid
    // config's inline data source instead of `var data = [...]`.
    const html =
      '<div id="gridCommitteeResults"></div><script>kendo.syncReady(function(){jQuery("#gridCommitteeResults")' +
      '.kendoGrid({"dataSource":{"transport":{"read":{"url":""}},"schema":{"data":"Data","total":"Total"},' +
      '"data":{"Data":[{"OrgName":"TIM LONGEST FOR NORTH CAROLINA (LONGEST, TIMOTHY WORTH, JR.)",' +
      '"SBoEID":"STA-P80279-C-001","OldID":null,"CandName":"TIMOTHY WORTH LONGEST JR",' +
      '"StatusDesc":"ACTIVE (NON-EXEMPT)","OrgGroupID":49685,"Link":null}],"Total":1}}});});</script>';
    expect(parseNcsbeCommitteeSearchPage(html)).toEqual([
      {
        orgName: "TIM LONGEST FOR NORTH CAROLINA (LONGEST, TIMOTHY WORTH, JR.)",
        sboeId: "STA-P80279-C-001",
        oldId: null,
        candName: "TIMOTHY WORTH LONGEST JR",
        statusDesc: "ACTIVE (NON-EXEMPT)",
        orgGroupId: 49685,
      },
    ]);
  });

  it("reads the redesigned no-results page as an empty result", () => {
    const html = '<div id="divNoResults" class="text-center"><b>No committees found.</b></div>';
    expect(parseNcsbeCommitteeSearchPage(html)).toEqual([]);
    expect(() => parseNcsbeCommitteeSearchPage("<html><body>error</body></html>")).toThrow(/not found/);
  });
});

describe("parseNcsbeDocumentListPage", () => {
  it("parses the per-committee inventory with data/image link split", () => {
    const rows = parseNcsbeDocumentListPage(fixture("document-inventory-gadson.html"));
    expect(rows).toHaveLength(10);
    expect(rows.filter((row) => row.dataLink !== null)).toHaveLength(3);
    const q1 = rows.find((row) => row.dataLink === "229931");
    expect(q1).toMatchObject({
      committeeName: "GADSON FOR NORTH CAROLINA",
      sboeId: "STA-JV516O-C-001",
      reportYear: 2026,
      documentType: "Disclosure Report",
      reportType: "First Quarter",
      isAmendment: false,
      imageLink: "ViewDocumentImage/?DID=334226",
    });
    expect(q1?.periodStartDate.iso).toBe("2026-01-01");
    expect(q1?.periodEndDate.iso).toBe("2026-02-14");
    expect(q1?.dataImportDate.iso).toBe("2026-02-24");
  });

  it("parses the redesigned Kendo-grid inventory page (live 2026-10-10)", () => {
    const html =
      '<script>jQuery("#grid").kendoGrid({"dataSource":{"schema":{"data":"Data","total":"Total"},' +
      '"data":{"Data":[{"ImageReceiptDate":"07/08/2026","DataImportDate":"07/08/2026",' +
      '"CommitteeName":"TIM LONGEST FOR NORTH CAROLINA","SBoEID":"STA-P80279-C-001","ReportYear":2026,' +
      '"DocumentType":"Disclosure Report","ReportType":"Second Quarter","IsAmendment":"N",' +
      '"PeriodStartDate":"02/15/2026","PeriodEndDate":"06/30/2026","ImageType":"IMAGE","DataType":"DATA",' +
      '"DataLink":"231820","ImageLink":"ViewDocumentImage/?DID=338303"}],"Total":1}}});</script>';
    const rows = parseNcsbeDocumentListPage(html);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sboeId: "STA-P80279-C-001", reportType: "Second Quarter", dataLink: "231820" });
  });

  it("surfaces the live year-3026 period date as implausible instead of trusting it", () => {
    const rows = parseNcsbeDocumentListPage(fixture("document-inventory-carolina-federation.html"));
    expect(rows).toHaveLength(29);
    const landmine = rows.filter((row) => row.periodEndDate.implausible);
    expect(landmine).toHaveLength(1);
    expect(landmine[0]?.periodEndDate).toEqual({ raw: "06/01/3026", iso: null, implausible: true });
  });

  it("keeps blank IsAmendment as null (correspondence noise rows), Y/N as booleans", () => {
    const rows = parseNcsbeDocumentListPage(fixture("document-inventory-carolina-federation.html"));
    const blanks = rows.filter((row) => row.isAmendment === null);
    expect(blanks).toHaveLength(4);
    expect(blanks.every((row) => row.documentType.startsWith("Committee Correspondence"))).toBe(true);
    expect(rows.filter((row) => row.isAmendment === true)).toHaveLength(5);
  });

  it("parses the statewide IE doc-type inventory and nulls the literal No Id", () => {
    const rows = parseNcsbeDocumentListPage(fixture("ie-doc-type-inventory-2026.html"));
    expect(rows).toHaveLength(95);
    // Spike-verified 2026 split: 72 structured, 23 image-only.
    expect(rows.filter((row) => row.dataLink !== null)).toHaveLength(72);
    expect(rows.filter((row) => row.isAmendment === true)).toHaveLength(4);
    expect(rows.filter((row) => row.sboeId === null)).toHaveLength(58);
    expect(rows.some((row) => row.sboeId?.toUpperCase() === "NO ID")).toBe(false);
  });
});

describe("parseNcsbeReportDetailPage", () => {
  it("parses the cover and exactly one 34-section summary grid", () => {
    const detail = parseNcsbeReportDetailPage(fixture("report-cover-gadson-229931.html"));
    expect(detail.cover).toMatchObject({
      // The page names itself — the only field that reliably answers "are
      // these the bytes I asked for?" (present on all 770 live-run covers).
      reportId: "229931",
      boeId: "STA-JV516O-C-001",
      orgName: "Gadson for North Carolina",
      entityTypeDesc: "Candidate Committee",
      fullReportName: "2026 First Quarter",
    });
    expect(detail.cover.beginDate.iso).toBe("2026-01-01");
    expect(detail.cover.endDate.iso).toBe("2026-02-14");
    expect(detail.cover.filedDate.iso).toBe("2026-02-24");
    expect(detail.summarySections).toHaveLength(34);

    const bySection = new Map(detail.summarySections.map((row) => [row.section, row]));
    // Spike-verified money pins (Gadson Q1 2026).
    expect(bySection.get("Total Receipts")?.periodCents).toBe(607324);
    expect(bySection.get("Total Receipts")?.cycleCents).toBe(4011512);
    expect(bySection.get("Total Expenditures")?.periodCents).toBe(2474378);
    expect(bySection.get("Cash on Hand at End of Reporting Period")?.periodCents).toBe(1315856);
    expect(bySection.get("Contributions from Individuals")?.periodCents).toBe(546324);
    expect(bySection.get("Aggregated Contributions from Individuals")?.periodCents).toBe(11000);
  });

  it("accepts a live cover whose BoeID is null", () => {
    // PR 9's live run: ~40% of committee reports serve "BoeID":null, which the
    // spike's fixtures never showed. Nothing downstream reads it — committee
    // identity comes from the inventory row — so the report must still parse.
    const detail = parseNcsbeReportDetailPage(fixture("report-cover-hairston-231912-null-boeid.html"));
    expect(detail.cover.boeId).toBeNull();
    expect(detail.cover.orgName).toBe("COMMITTEE TO ELECT ELMA HAIRSTON");
    expect(detail.summarySections).toHaveLength(34);
  });

  it("pins all 34 section strings", () => {
    const detail = parseNcsbeReportDetailPage(fixture("report-cover-gadson-229931.html"));
    for (const row of detail.summarySections) {
      expect(NCSBE_COVER_SECTIONS.get(row.sequence)).toBe(row.section);
    }
  });

  it("fails closed on an unknown summary section", () => {
    const html = fixture("report-cover-gadson-229931.html").replace(
      '"Section":"Total Receipts"',
      '"Section":"Total Recieptz"'
    );
    expect(() => parseNcsbeReportDetailPage(html)).toThrow(/unknown section/);
  });

  it("fails closed when no summary grid is present", () => {
    expect(() => parseNcsbeReportDetailPage('var dataCover = {"BoeID":"X","OrgName":"Y"};')).toThrow(
      /expected exactly one summary grid, found 0/
    );
  });

  it("fails closed on a truncated summary grid — all 34 sections are required", () => {
    const html = fixture("report-cover-gadson-229931.html").replace(
      /\{"Sequence":60,"Section":"Total Receipts"[^}]*\},/,
      ""
    );
    expect(() => parseNcsbeReportDetailPage(html)).toThrow(/33 of 34 sections .*missing sequences: 60/);
  });

  it("fails closed on a duplicated summary section", () => {
    const html = fixture("report-cover-gadson-229931.html").replace(
      /(\{"Sequence":60,"Section":"Total Receipts"[^}]*\},)/,
      "$1$1"
    );
    expect(() => parseNcsbeReportDetailPage(html)).toThrow(/repeats a section sequence/);
  });
});

describe("parseNcsbeReceiptsPage", () => {
  it("parses the Gadson Q1 receipts and reproduces the official total", () => {
    const page = parseNcsbeReceiptsPage(fixture("receipts-gadson-229931-p0.json"));
    expect(page.recordCount).toBe(19);
    expect(page.rows).toHaveLength(19);
    // Sum of itemized + aggregated rows equals the cover's Total Receipts.
    expect(page.rows.reduce((sum, row) => sum + row.amountCents, 0)).toBe(607324);
    // The trailing space in "IND " is real portal vocabulary — kept verbatim.
    expect(new Set(page.rows.map((row) => row.receiptTypeCode))).toEqual(new Set(["IND ", "PPTY"]));
    expect(page.rows.filter((row) => row.isAggregated)).toHaveLength(4);
    expect(page.rows[0]).toMatchObject({
      groupId: 22219365,
      isAggregated: true,
      amountCents: 2500,
      sumToDateCents: 2500,
      receiptTypeCode: "IND ",
    });
  });

  it("parses a noncommittee IE filer's disclosed-funder receipts", () => {
    const page = parseNcsbeReceiptsPage(fixture("ie-receipts-advance-232624-p0.json"));
    expect(page.recordCount).toBe(1);
    expect(page.rows[0]).toMatchObject({
      orgName: "ROLLING SEA FUND",
      amountCents: 2450600,
      receiptTypeDesc: "Donation",
      receiptTypeCode: "DON ",
      isAggregated: false,
    });
  });

  it("parses an empty page past the end without losing the record count", () => {
    const page = parseNcsbeReceiptsPage(fixture("receipts-berger-229249-p1-empty.json"));
    expect(page.recordCount).toBe(111);
    expect(page.rows).toHaveLength(0);
  });

  it("fails closed on an HTML error body (the portal returns HTTP 200 for those)", () => {
    expect(() => parseNcsbeReceiptsPage("<html><body>An error occurred</body></html>")).toThrow(
      /does not parse/
    );
  });

  it("fails closed on JSON without the Data.results envelope", () => {
    expect(() => parseNcsbeReceiptsPage('{"ok":true}')).toThrow(/Data is not an object/);
  });
});

describe("parseNcsbeExpendituresPage", () => {
  it("parses the Advance NC IE report: IEAmount is the per-target amount, never Amount", () => {
    const page = parseNcsbeExpendituresPage(fixture("ie-expenditures-advance-232624-p0.json"));
    expect(page.recordCount).toBe(39);
    expect(page.rows).toHaveLength(39);
    // Spike-verified decision-4 pin: IEAmount sums to the official total;
    // Amount repeats the vendor invoice per target and overstates by ~$20K.
    expect(page.rows.reduce((sum, row) => sum + (row.ieAmountCents ?? 0), 0)).toBe(2930630);
    expect(page.rows.reduce((sum, row) => sum + row.amountCents, 0)).toBe(4930629);
    expect(page.rows.every((row) => row.expenditureTypeDesc === "Independent Expenditure")).toBe(true);
    expect(page.rows.every((row) => row.declaration === "Support")).toBe(true);
    // Federal and out-of-scope target strings arrive in the same report and
    // are filtered at matching time (decision 5), not parse time.
    const offices = new Set(page.rows.map((row) => row.officeSought));
    expect(offices).toEqual(
      new Set(["House", "US HOUSE OF REPRESENTATIVES", "U.S. HOUSE OF REPRESENTATIVES", "County/Municipal"])
    );
  });

  it("parses the registered-committee IE row where IEAmount is null and Amount holds the value", () => {
    const page = parseNcsbeExpendituresPage(fixture("ie-expenditures-carolina-federation-p0.json"));
    expect(page.recordCount).toBe(1);
    expect(page.rows[0]).toMatchObject({
      orgName: "THE PIVOT GROUP",
      amountCents: 1050000,
      ieAmountCents: null,
      expenditureTypeDesc: "Independent Expenditure",
      candidate: "RODNEY PIERCE",
      officeSought: "NC HOUSE 27",
      declaration: "Support",
    });
  });
});
