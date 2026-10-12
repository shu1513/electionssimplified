import { describe, expect, it } from "vitest";

import {
  DELAWARE_SUB_100_AGGREGATE_TYPE,
  DelawareCfrsParseError,
  extractDelawareGridTotal,
  parseDelawareAmountCents,
  parseDelawareCommitteeGridJson,
  parseDelawareCurrencyCents,
  parseDelawareExpensesCsv,
  parseDelawareFiledReportsHtml,
  parseDelawareJsonDateMs,
  parseDelawareReceiptsCsv,
  parseDelawareThirdPartyReceiptsCsv,
  parseDelawareRegistrantSuggestions,
  parseDelawareTpAffiliations,
} from "../../../src/pipeline/delawareFinance/delawareCfrsParsers.js";

// Sanitized fixture: real header shape (dangling comma -> trailing empty
// header cell), receipt rows do NOT echo the trailing cell (17 cells vs 18
// header cells) — pinned from the live export 2026-08-26. Addresses replaced.
// The export is NOT RFC CSV: a double quote is literal data (a real row
// carries `Kevin O"Connell`) and fields never contain commas or newlines.
const RECEIPTS_CSV = [
  "Contribution Date,Contributor Name,Contributor Address Line 1,Contributor Address Line 2,Contributor City,Contributor State,Contributor Zip,Contributor Type,Employer Name,Employer Occupation,Contribution Type,Contribution Amount,CF_ID,Receiving Committee,Filing Period,Office,Fixed Asset,",
  '6/30/2024,Example O"Person,1 Example St,,Wilmington,DE,19801,Individual,,,Credit Card,500.0000,01005311,Example for Delaware,2024 2024 Primary Election 09/10/2024 30 Day,(Governor),No',
  `12/31/2024,Aggregate Filer,,,,,,${DELAWARE_SUB_100_AGGREGATE_TYPE},,,${DELAWARE_SUB_100_AGGREGATE_TYPE},63.1800,01005311,Example for Delaware,2024 Annual,(Governor),No`,
].join("\r\n");

// Expense rows DO echo the trailing empty cell (both header and rows 17 cells).
const EXPENSES_CSV = [
  "Expenditure Date,Payee Name,Payee Address Line 1,Payee Address Line 2,Payee City,Payee State,Payee Zip,Payee Type,Amount($),CF ID,Committee Name,Expense Category,Expense Purpose,Expense Method,Filing Period,Fixed Asset,",
  "9/12/2022,Example Vendor,2 Example Rd,,Hockessin,DE,19707-    ,Individual,325.0000,01005311,Example for Delaware,Fund Raiser,Fundraiser -General Expenses,Credit Card,2022 Annual,No,",
].join("\r\n");

// Sanitized from the live ShowReview markup (2026-08-26): inner table with
// <th> header row, striped <td> data rows, pager footer.
const AFFILIATION_HTML = `
<tr><td align="left" class="tdheader">Affiliated Candidate Information
</td></tr>
<tr><td align="right" colspan="6" id="CommittessList"><!-- Success -->
<table id='ViewCandiate'><thead><tr id='ListRow'><th><span>Candidate Committee Name</span></th><th><span>Candidate Name</span></th><th><span>Office Sought Name</span></th><th><span>PartyAffiliationName</span></th><th><span>Position</span></th><th><span>Status</span></th></tr></thead>
<tbody><tr class='bgwhite'><td>Example for Governor</td><td>Example One</td><td>Governor</td><td>Democratic</td><td>Oppose</td><td>Active</td></tr>
<tr class='bggrey'><td>Other for Delaware</td><td>Example Two</td><td>Governor</td><td>Democratic</td><td>Support</td><td>Active</td></tr></tbody></table>
<table id='tblFooterRow'><tr><td class='bgfooter'><div><ul><li class='pageinfo'>Displaying page 1 of 1, records 1 to 2 of 2</li></ul></div></td></tr></table>
</td></tr>
<tr><td>Name of Party if entire ticket is supported</td></tr>`;

const EMPTY_AFFILIATION_HTML = `
Affiliated Candidate Information
<table id='ViewCandiate'><thead><tr><th>Candidate Committee Name</th><th>Candidate Name</th><th>Office Sought Name</th><th>PartyAffiliationName</th><th>Position</th><th>Status</th></tr></thead>
<tbody><tr><td colspan='6'>No records to view.</td></tr></tbody></table>
Name of Party if entire ticket is supported`;

describe("delawareCfrsParsers", () => {
  it("keeps the eight-column third-party funder export separate from candidate receipts", () => {
    const body = [
      "Contribution Date,Contributor Name,Contributor Address,Employer Name,Filed Reports,Employer Occupation,Contribution Amount,Receiving Committee,",
      "8/7/2026,Example Funder,Sanitized Address,,18 Aug 2026 Filing 1.0,,525000.0000,Example Third Party,",
    ].join("\r\n");
    const parsed = parseDelawareThirdPartyReceiptsCsv(body);
    expect(parsed.malformedRowCount).toBe(0);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]!["Contribution Amount"]).toBe("525000.0000");
    expect(parsed.rows[0]).not.toHaveProperty("Contributor Type");
    expect(parsed.rows[0]).not.toHaveProperty("CF_ID");
    expect(() => parseDelawareReceiptsCsv(body)).toThrow(/header drift/);
    expect(() => parseDelawareThirdPartyReceiptsCsv(RECEIPTS_CSV)).toThrow(/header drift/);
    expect(() => parseDelawareThirdPartyReceiptsCsv(body.replace("Filed Reports", "Filing Period"))).toThrow(/header drift/);
    expect(parseDelawareThirdPartyReceiptsCsv(`${body}\r\n8/8/2026,broken`)).toMatchObject({ malformedRowCount: 1 });
  });

  it("parses the receipts CSV (rows one cell short of the dangling-comma header)", () => {
    const parsed = parseDelawareReceiptsCsv(RECEIPTS_CSV);
    expect(parsed.malformedRowCount).toBe(0);
    expect(parsed.rows).toHaveLength(2);
    const first = parsed.rows[0]!;
    expect(first["Contributor Name"]).toBe('Example O"Person');
    expect(first["Contribution Amount"]).toBe("500.0000");
    expect(first["Contributor Type"]).toBe("Individual");
    expect(first["Employer Occupation"]).toBe("");
    const aggregate = parsed.rows[1]!;
    expect(aggregate["Contributor Type"]).toBe(DELAWARE_SUB_100_AGGREGATE_TYPE);
    expect(aggregate["Contributor Name"]).toBe("Aggregate Filer");
  });

  it("parses the expenses CSV (rows echo the trailing empty cell)", () => {
    const parsed = parseDelawareExpensesCsv(EXPENSES_CSV);
    expect(parsed.malformedRowCount).toBe(0);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]!["Payee Name"]).toBe("Example Vendor");
    expect(parsed.rows[0]!["Amount($)"]).toBe("325.0000");
  });

  it("fails closed on header drift and empty bodies", () => {
    expect(() => parseDelawareReceiptsCsv("A,B,C\n1,2,3")).toThrow(DelawareCfrsParseError);
    expect(() => parseDelawareReceiptsCsv("   ")).toThrow(DelawareCfrsParseError);
    // A receipts body that is actually an HTML error page must not parse.
    expect(() => parseDelawareReceiptsCsv("<html><body>Session expired</body></html>")).toThrow();
  });

  it("parses CFRS amounts to exact cents and rejects drift", () => {
    expect(parseDelawareAmountCents("500.0000")).toBe(50_000);
    expect(parseDelawareAmountCents("63.1800")).toBe(6_318);
    expect(parseDelawareAmountCents("-63.1800")).toBe(-6_318);
    expect(parseDelawareAmountCents("0.0000")).toBe(0);
    expect(parseDelawareAmountCents("123")).toBe(12_300);
    expect(parseDelawareAmountCents("123.4")).toBe(12_340);
    expect(() => parseDelawareAmountCents("1,000.0000")).toThrow(DelawareCfrsParseError);
    expect(() => parseDelawareAmountCents("$500.00")).toThrow(DelawareCfrsParseError);
    expect(() => parseDelawareAmountCents("500.0050")).toThrow(DelawareCfrsParseError);
    expect(() => parseDelawareAmountCents("")).toThrow(DelawareCfrsParseError);
  });

  it("parses PDF currency tokens", () => {
    expect(parseDelawareCurrencyCents("$243,160.00")).toBe(24_316_000);
    expect(parseDelawareCurrencyCents("$0.00")).toBe(0);
    expect(parseDelawareCurrencyCents("($12.34)")).toBe(-1_234);
    expect(parseDelawareCurrencyCents("-$12.34")).toBe(-1_234);
    expect(parseDelawareCurrencyCents("$1234.56")).toBe(123_456);
    expect(parseDelawareCurrencyCents("N/A")).toBeNull();
    expect(parseDelawareCurrencyCents("04006103")).toBeNull();
    // Malformed shapes a layout drift could produce must not count as amounts.
    expect(parseDelawareCurrencyCents("$12.34)")).toBeNull();
    expect(parseDelawareCurrencyCents("($12.34")).toBeNull();
    expect(parseDelawareCurrencyCents("$1,,2.00")).toBeNull();
    expect(parseDelawareCurrencyCents("$12,34.00")).toBeNull();
  });

  it("extracts the stored-search total from the results page grid config", () => {
    const html = `<script>jQuery('#Grid').tGrid({columns:[{"title":"x"}], pageSize:15, total:7425, currentPage:1, ajax:{"selectUrl":"/Public/_ViewReceiptsCustom?Grid-size=15"}});</script>`;
    expect(extractDelawareGridTotal(html)).toBe(7425);
    expect(extractDelawareGridTotal(html, "GridResults_TP")).toBeNull();
    expect(extractDelawareGridTotal("<html>no grid</html>")).toBeNull();
  });

  it("parses committee grid JSON rows", () => {
    const parsed = parseDelawareCommitteeGridJson(
      JSON.stringify({
        data: [
          {
            MemberID: 642221,
            Committee_Id: "04006103",
            CommitteeName: "Citizens for a New Delaware Way 3rd Party Advertiser",
            CommitteeTypeCode: "04",
            CommitteeType: "3rd Party Advertiser",
            CommitteeStatus: "Active",
            OfficeSought: "",
            DistrictName: "",
            County: "",
            RegisteredDateStr: "5/30/2024",
            Formtype: "SO",
          },
        ],
        total: 71,
      })
    );
    expect(parsed.total).toBe(71);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({ memberId: 642221, cfId: "04006103", committeeTypeCode: "04" });
    expect(() => parseDelawareCommitteeGridJson(JSON.stringify({ data: [{ MemberID: "nope" }] }))).toThrow(
      DelawareCfrsParseError
    );
    expect(() => parseDelawareCommitteeGridJson("<html>")).toThrow(DelawareCfrsParseError);
  });

  it("parses filed-report rows from the rendered grid page", () => {
    // Sanitized from the live _ViewFiledReports page (2026-08-26): server-
    // rendered tbody rows; the document link args arrive entity-encoded.
    const html = `<script>jQuery('#Grid').tGrid({columns:[], pageSize:15, total:2});</script>
<table><thead><tr><th>Filing Period</th></tr></thead><tbody>
<tr><td>2025 Annual</td><td> <a style=color:blue;cursor:hand; onclick=downloadReport(&#39;CampaignFinanceReport_Prelim_558171_1262_abc.pdf&#39;,&#39;558171&#39;,&#39;1262&#39;) > Original Financial Statement &nbsp;&nbsp; </a> </td><td>01005311</td><td>Meyer for Delaware</td><td>Candidate Committee</td><td>01/02/2026</td><td>2025</td><td>(Governor)</td><td>Active</td></tr>
<tr><td>2024 2024 General Election 11/05/2024 30 Day</td><td>Amended Financial Statement</td><td>01005311</td><td>Meyer for Delaware</td><td>Candidate Committee</td><td>11/01/2024</td><td>2024</td><td>(Governor)</td><td>Active</td></tr>
</tbody></table>`;
    const parsed = parseDelawareFiledReportsHtml(html);
    expect(parsed.total).toBe(2);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({
      filingPeriodName: "2025 Annual",
      reportName: "Original Financial Statement",
      cfId: "01005311",
      dateFiled: "01/02/2026",
      document: { publicReportFileName: "CampaignFinanceReport_Prelim_558171_1262_abc.pdf", memberId: 558171, filingCalendarId: 1262 },
    });
    expect(parsed.rows[1]!.document).toBeNull();
    expect(parsed.rows[1]!.reportName).toBe("Amended Financial Statement");
    expect(() => parseDelawareFiledReportsHtml("<html>no grid</html>")).toThrow(DelawareCfrsParseError);
  });

  it("scopes filed-report rows to the #Grid wrapper, ignoring earlier tbodys", () => {
    // The live page renders the search form and layout tables before the
    // Telerik wrapper <div id="Grid"> — a tbody up there must never be
    // parsed as the filing inventory.
    const html = `<script>jQuery('#Grid').tGrid({columns:[], pageSize:15, total:1});</script>
<table id="layout"><tbody><tr><td>nav</td><td>a</td><td>b</td><td>c</td><td>d</td><td>e</td><td>f</td><td>g</td><td>h</td></tr></tbody></table>
<div id="GridResults"><div class="t-widget t-grid" id="Grid"><table><thead><tr><th>Filing Period</th></tr></thead><tbody>
<tr><td>2025 Annual</td><td>Original Financial Statement</td><td>01005311</td><td>Meyer for Delaware</td><td>Candidate Committee</td><td>01/02/2026</td><td>2025</td><td>(Governor)</td><td>Active</td></tr>
</tbody></table></div></div>`;
    const parsed = parseDelawareFiledReportsHtml(html);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]!.filingPeriodName).toBe("2025 Annual");
    expect(parsed.rows[0]!.cfId).toBe("01005311");
  });

  it("parses /Date()/ values and registrant suggestions", () => {
    expect(parseDelawareJsonDateMs("/Date(1704171600000)/")).toBe(1_704_171_600_000);
    expect(parseDelawareJsonDateMs("2024-01-02")).toBeNull();
    expect(parseDelawareJsonDateMs(1704171600000)).toBeNull();

    const suggestions = parseDelawareRegistrantSuggestions(
      "Meyer for Delaware(Active)|558171\nFriends of James Meyers(Closed)|451706\n"
    );
    expect(suggestions).toEqual([
      { name: "Meyer for Delaware", status: "Active", memberId: 558171 },
      { name: "Friends of James Meyers", status: "Closed", memberId: 451706 },
    ]);
    expect(() => parseDelawareRegistrantSuggestions("garbage line")).toThrow(DelawareCfrsParseError);
  });

  it("parses TP affiliation tables, including the empty and drifted cases", () => {
    const rows = parseDelawareTpAffiliations(AFFILIATION_HTML);
    expect(rows).toEqual([
      {
        candidateCommitteeName: "Example for Governor",
        candidateName: "Example One",
        officeSought: "Governor",
        party: "Democratic",
        position: "Oppose",
        status: "Active",
      },
      {
        candidateCommitteeName: "Other for Delaware",
        candidateName: "Example Two",
        officeSought: "Governor",
        party: "Democratic",
        position: "Support",
        status: "Active",
      },
    ]);
    expect(parseDelawareTpAffiliations(EMPTY_AFFILIATION_HTML)).toEqual([]);
    expect(() => parseDelawareTpAffiliations("<html>unrelated page</html>")).toThrow(DelawareCfrsParseError);
    expect(() =>
      parseDelawareTpAffiliations(AFFILIATION_HTML.replace(">Oppose<", ">Maybe<"))
    ).toThrow(/unexpected Position/);
  });
});
