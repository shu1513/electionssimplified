import { describe, expect, it } from "vitest";

import {
  checkKansasScheduleA,
  checkKansasScheduleB,
  parseKansasCfrGridCurrentPage,
  parseKansasCfrGridRows,
  parseKansasContributionExportRows,
  parseKansasHiddenFields,
  parseKansasMoneyCents,
  parseKansasOcrMoneyCents,
  parseKansasRecordCount,
  parseKansasReportCover,
  parseKansasScheduleARows,
  parseKansasScheduleATotals,
  parseKansasScheduleBRows,
  parseKansasScheduleBTotals,
  parseKansasScheduleCTotals,
  reconcileKansasCoverArithmetic,
} from "../../../src/pipeline/kansasFinance/kansasCfrViewerParsers.js";

describe("parseKansasHiddenFields", () => {
  it("collects hidden inputs including empty and entity-encoded values", () => {
    const html = `
      <input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="AbC&#43;dE=" />
      <input type="hidden" name="__VIEWSTATEENCRYPTED" id="__VIEWSTATEENCRYPTED" value="" />
      <input type="hidden" name="__SCROLLPOSITIONX" id="__SCROLLPOSITIONX" value="0" />
      <input type="text" name="txtLastName" value="ignored" />`;
    expect(parseKansasHiddenFields(html)).toEqual({
      __VIEWSTATE: "AbC+dE=",
      __VIEWSTATEENCRYPTED: "",
      __SCROLLPOSITIONX: "0",
    });
  });
});

describe("parseKansasMoneyCents", () => {
  it.each([
    ["$3,077.59", 307759],
    ["$ 4350.00", 435000],
    ["$0", 0],
    ["$ 0", 0],
    ["1600.00", 160000],
    ["$412,630.21", 41263021],
    // Live Schmidt 2026 credit-card refund rows use accounting negatives.
    ["($4,000.00)", -400000],
    ["( $4,000.00 )", -400000],
  ])("parses %s", (raw, cents) => {
    expect(parseKansasMoneyCents(raw)).toBe(cents);
  });

  it.each([[""], ["view/print"], ["$1,23.45"], ["$1.2"], ["$1,000.001"], ["($1.2)"], ["()"]])(
    "rejects %s",
    (raw) => {
      expect(parseKansasMoneyCents(raw)).toBeNull();
    }
  );
});

describe("parseKansasOcrMoneyCents", () => {
  it("parses clean OCR amounts as certain", () => {
    expect(parseKansasOcrMoneyCents("$ 359,633.00")).toEqual({ cents: 35963300, uncertain: false });
  });

  it("normalizes a comma-as-decimal read (live: '$ 138,270 ,00')", () => {
    expect(parseKansasOcrMoneyCents("$ 138,270 ,00")).toEqual({ cents: 13827000, uncertain: false });
  });

  it("marks trailing border-artifact digits as uncertain (live: '$2,550.001')", () => {
    expect(parseKansasOcrMoneyCents("$2,550.001")).toEqual({ cents: 255000, uncertain: true });
  });

  it("returns null when the decimal point cannot be located", () => {
    expect(parseKansasOcrMoneyCents("$58.741.00")).toBeNull();
    expect(parseKansasOcrMoneyCents("$")).toBeNull();
  });
});

describe("parseKansasRecordCount", () => {
  it("reads the lblRecordCount span (the phrase sits outside the span)", () => {
    const html = `<strong>\n<span id="lblRecordCount">4285</span>\nrecord(s) found.\n</strong>`;
    expect(parseKansasRecordCount(html)).toBe(4285);
    expect(parseKansasRecordCount('<span id="lblRecordCount">1,234</span>')).toBe(1234);
    expect(parseKansasRecordCount("<p>nothing here</p>")).toBeNull();
  });
});

describe("parseKansasContributionExportRows", () => {
  // Synthetic contributor identities on the live markup shape: K.S.A.
  // 25-4154(d) restricts reuse of names copied from Kansas filings, so no
  // real contributor name or address is committed.
  it("groups id-stamped spans into rows", () => {
    const html = `
      <span id="lblCandName_0">Example Candidate</span>
      <span id="lblContributor_0">Sample Individual</span>
      <span id="lblCity_0">Anytown</span>
      <span id="lblState_0">KS</span>
      <span id="lblZip_0">00000</span>
      <span id="lblOccupation_0">Not Employed</span>
      <span id="lblIndustry_0"></span>
      <span id="lblDate_0">02/08/2026</span>
      <span id="lblTypeofTender_0">Credit Card</span>
      <span id="lblAmount_0">$250.00</span>
      <span id="lblInKindAmount_0"></span>
      <span id="lblInKindDescription_0"></span>
      <span id="lblStartDate_0">01/01/2026</span>
      <span id="lblEndDate_0">07/23/2026</span>
      <span id="lblCandName_1">Example Candidate</span>
      <span id="lblContributor_1">Sample Trade Association PAC</span>
      <span id="lblCity_1">Anytown</span>
      <span id="lblState_1">KS</span>
      <span id="lblZip_1">00000</span>
      <span id="lblOccupation_1"></span>
      <span id="lblIndustry_1"></span>
      <span id="lblDate_1">07/23/2026</span>
      <span id="lblTypeofTender_1">Check</span>
      <span id="lblAmount_1"></span>
      <span id="lblInKindAmount_1">$1,000.00</span>
      <span id="lblInKindDescription_1">Mailer</span>
      <span id="lblStartDate_1">01/01/2026</span>
      <span id="lblEndDate_1">07/23/2026</span>`;
    const rows = parseKansasContributionExportRows(html);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      contributorName: "Sample Individual",
      occupation: "Not Employed",
      amountCents: 25000,
      inKindAmountCents: null,
    });
    expect(rows[1]).toMatchObject({
      contributorName: "Sample Trade Association PAC",
      occupation: "",
      amountCents: null,
      inKindAmountCents: 100000,
      inKindDescription: "Mailer",
    });
  });
});

const COVER_HTML = `
  <input id="chkAmended" type="checkbox" name="chkAmended" disabled="disabled" />
  <input id="chkTermination" type="checkbox" name="chkTermination" disabled="disabled" checked="checked" />
  <span id="lblCandOrgName">Dale R Helwig</span>
  <span id="lblOfficeSoughtName">State Representative</span>
  <span id="lblDistrictNo">1</span>
  <span id="lblFileStartDate">1/1/2026</span>
  <span id="lblFileEndDate">7/23/2026</span>
  <span id="lblCashBeginning">$3,077.59</span>
  <span id="lblTotalContributions">$4,350.00</span>
  <span id="lblCashThisPeriod">$7,427.59</span>
  <span id="lblTotalExpenditures">$1,860.65</span>
  <span id="lblCashOnHandClose">$5,566.94</span>
  <span id="lblInKindContributions">$0.00</span>
  <span id="lblOtherTransactions">1600.00</span>
  <span id="lblElectronicSignature">Electronically filed on:  7/27/2026 8:54:06 AM</span>`;

describe("parseKansasReportCover", () => {
  it("parses the live cover shape and its checkboxes", () => {
    const cover = parseKansasReportCover(COVER_HTML);
    expect(cover).toMatchObject({
      candidateName: "Dale R Helwig",
      officeSought: "State Representative",
      district: "1",
      amended: false,
      termination: true,
      electronicallyFiledOn: "7/27/2026 8:54:06 AM",
      cashBeginningCents: 307759,
      totalContributionsCents: 435000,
      cashAvailableCents: 742759,
      totalExpendituresCents: 186065,
      cashCloseCents: 556694,
      inKindCents: 0,
      otherTransactionsCents: 160000,
    });
    expect(reconcileKansasCoverArithmetic(cover)).toBe(true);
  });

  it("fails arithmetic when a line is off by one cent", () => {
    const cover = parseKansasReportCover(
      COVER_HTML.replace("$5,566.94", "$5,566.95")
    );
    expect(reconcileKansasCoverArithmetic(cover)).toBe(false);
  });
});

describe("schedule totals", () => {
  it("parses Schedule A totals (live '$ 4350.00' / '$ 0' shapes)", () => {
    const html = `
      <span id="lblTotalItemized">$ 4350.00</span>
      <span id="lblTotalUnitemized">$ 0</span>
      <span id="lblPoliticalMaterials">$ 0</span>
      <span id="lblContributorUnknown">$ 0</span>
      <span id="lblTotalReceipts">$ 4350.00</span>`;
    expect(parseKansasScheduleATotals(html)).toEqual({
      totalItemizedCents: 435000,
      totalUnitemizedCents: 0,
      politicalMaterialsCents: 0,
      contributorUnknownCents: 0,
      totalReceiptsCents: 435000,
    });
  });

  it("parses Schedule C totals", () => {
    const html = `
      <span id="lblTotalItemizedExpenditures">$ 1860.65</span>
      <span id="lblTotalUnitemized">$ 0</span>
      <span id="lblTotalExpenditures">$ 1860.65</span>`;
    expect(parseKansasScheduleCTotals(html)).toEqual({
      totalItemizedCents: 186065,
      totalUnitemizedCents: 0,
      totalExpendituresCents: 186065,
    });
  });
});

// Synthetic Schedule A page mirroring the live e-filed shape (entity row with
// a one-line name and blank occupation; person row with the form's two source
// lines and a voluntary occupation; accounting-style refund). Names and
// addresses are invented — never paste live contributor rows (25-4154(d)).
const SCHEDULE_A_HTML = `
<table width='98%' cellpadding='2' cellspacing='0' border='1' >
<tr>
<th align="left" class="bold10" rowspan="2" valign='middle'>Date</th>
<th class='bold10' align='left' valign='middle' rowspan='2'>Name and Address<br />of Contributor</th>
<th class='bold10' align='left' valign='middle' colspan='1'>Type of Payment</th>
<th class='bold10' align='left' valign='middle' rowspan='2'>Occupation of Individual Giving<br /> More Than $150</th>
<th class='bold10' align='left' valign='middle' rowspan='2'>Primary Total</th>
<th class='bold10'  align='left' valign='middle' rowspan='2'>General Total</th>
<th class='bold10' align='left' valign='middle' rowspan='2'>Amount</th>
</tr>
<tr>
<td valign='top' align='left' class='plain9'>Cash, Check, Loan, E-funds, Other</td>
</tr>
<tr>
<td align="left" class="plain8" valign="middle" width="80px">
07/23/26</td>
<td valign='middle' align='left' class='plain8' width="220px">
Prairie Wind Growers &amp; Millers PAC
<br />
<span id="Repeater2_lblAddress_0">100 Example Pkwy<br /></span>
Suite 4<br />
Sampleton&nbsp;
KS&nbsp;
<span id="Repeater2_lblZip_0">66000</span>
</td>
<td valign='middle' align='left' class='plain8' width="180px">
Check
</td>
<td valign='middle' align='left' class='plain8' width="175px">
<br />
</td>
<td valign='middle' align='right' class='plain8'  style="width:160px">$1,000.00</td>
<td valign='middle' align='right' class='plain8'  style="width:160px">$0.00</td>
<td valign='middle' align='right' class='plain8'  style="width:160px">
$500.00
</td>
</tr>
<tr>
<td align="left" class="plain8" valign="middle" width="80px">
07/07/26</td>
<td valign='middle' align='left' class='plain8' width="220px">
Testy
Fixture
<br />
<span id="Repeater2_lblAddress_1">201 Placeholder Rd</span>
<br />
Sampleton&nbsp;
KS&nbsp;
<span id="Repeater2_lblZip_1">66000</span>
</td>
<td valign='middle' align='left' class='plain8' width="180px">
Cash
</td>
<td valign='middle' align='left' class='plain8' width="175px">
Retired<br />
</td>
<td valign='middle' align='right' class='plain8'  style="width:160px">$100.00</td>
<td valign='middle' align='right' class='plain8'  style="width:160px">$0.00</td>
<td valign='middle' align='right' class='plain8'  style="width:160px">
$100.00
</td>
</tr>
<tr>
<td align="left" class="plain8" valign="middle" width="80px">
06/30/26</td>
<td valign='middle' align='left' class='plain8' width="220px">
Sample
Donor
<br />
<span id="Repeater2_lblAddress_2">1 Nowhere Ln</span>
<br />
Sampleton&nbsp;
KS&nbsp;
<span id="Repeater2_lblZip_2">66000</span>
</td>
<td valign='middle' align='left' class='plain8' width="180px">
E-funds
</td>
<td valign='middle' align='left' class='plain8' width="175px">
Farmer<br />
</td>
<td valign='middle' align='right' class='plain8'  style="width:160px">$200.00</td>
<td valign='middle' align='right' class='plain8'  style="width:160px">$0.00</td>
<td valign='middle' align='right' class='plain8'  style="width:160px">
($50.00)
</td>
</tr>
</table>
<table width='98%' border='1' cellpadding='2' cellspacing='0'>
<tr>
<td align="left"  class="bold9" colspan="9" valign="top">Total Itemized Receipts for Period</td>
<td align="right" class="plain10" valign="top" width="110px">
$<span id="lblTotalItemized" title="Total Itemized Receipts for Period">550.00</span>
</td>
</tr>
<tr>
<td align='left' class='bold9' colspan='9' valign=top>Total Unitemized Contributions ($50 or less)</td>
<td class='plain10' align='right' valign='top' width="110px">
$<span id="lblTotalUnitemized" title="Total Unitemized Contributions ($50 or less)">25.00</span>
</td>
</tr>
<tr>
<td align="left" class="bold9" colspan="9" valign="top">Sale of Political Materials (Unitemized)</td>
<td align="right" class="plain10" valign="top" width="110px">
$<span id="lblPoliticalMaterials" title="Sale of Political Materials (Unitemized)">0</span>
</td>
</tr>
<tr>
<td align="left" class="bold9" colspan="9" valign="top">Total Contributions When Contributor Not Known</td>
<td align="right" class="plain10" valign="top" width="110px">
$<span id="lblContributorUnknown" title="Total Contributions When Contributor Not Known">0</span>
</td>
</tr>
<tr>
<td align='left' class='bold9' colspan='9' valign='middle' bgcolor='#bbbbbb'>TOTAL RECEIPTS THIS PERIOD</td>
<td align='right' class='plain10' valign='top' width="110px">
$<span id="lblTotalReceipts" title="Total Receipts This Period">575.00</span>
</td>
</tr>
</table>`;

describe("parseKansasScheduleARows", () => {
  it("parses the live row shape: entity and person names, blank/voluntary occupation, refunds", () => {
    const parsed = parseKansasScheduleARows(SCHEDULE_A_HTML);
    expect(parsed.malformedRowCount).toBe(0);
    expect(parsed.rows).toEqual([
      {
        index: 0,
        date: "07/23/26",
        contributorName: "Prairie Wind Growers & Millers PAC",
        addressLines: ["100 Example Pkwy", "Suite 4", "Sampleton KS 66000"],
        zip: "66000",
        tenderType: "Check",
        occupation: "",
        primaryTotalCents: 100000,
        generalTotalCents: 0,
        amountCents: 50000,
      },
      {
        index: 1,
        date: "07/07/26",
        contributorName: "Testy Fixture",
        addressLines: ["201 Placeholder Rd", "Sampleton KS 66000"],
        zip: "66000",
        tenderType: "Cash",
        occupation: "Retired",
        primaryTotalCents: 10000,
        generalTotalCents: 0,
        amountCents: 10000,
      },
      {
        index: 2,
        date: "06/30/26",
        contributorName: "Sample Donor",
        addressLines: ["1 Nowhere Ln", "Sampleton KS 66000"],
        zip: "66000",
        tenderType: "E-funds",
        occupation: "Farmer",
        primaryTotalCents: 20000,
        generalTotalCents: 0,
        amountCents: -5000,
      },
    ]);
  });

  it("ignores header rows and reports a row with the wrong cell count as malformed", () => {
    const html = `
      <tr><th>Date</th><th>Name and Address<br />of Contributor</th></tr>
      <tr>
        <td>07/01/26</td>
        <td>Someone<br /><span id="Repeater2_lblAddress_0">1 St</span><br />Town&nbsp;KS&nbsp;<span id="Repeater2_lblZip_0">66000</span></td>
        <td>Check</td>
        <td><br /></td>
        <td>$10.00</td>
        <td>$10.00</td>
      </tr>`;
    expect(parseKansasScheduleARows(html)).toEqual({ rows: [], malformedRowCount: 1 });
  });

  it("returns no rows for an empty schedule (totals only)", () => {
    const html = `<table><tr><th>Date</th></tr></table>
      <span id="lblTotalItemized">0</span><span id="lblTotalUnitemized">0</span>`;
    expect(parseKansasScheduleARows(html)).toEqual({ rows: [], malformedRowCount: 0 });
  });
});

describe("checkKansasScheduleA", () => {
  it("passes when the row sum equals lblTotalItemized and the totals identity holds", () => {
    const parsed = parseKansasScheduleARows(SCHEDULE_A_HTML);
    const totals = parseKansasScheduleATotals(SCHEDULE_A_HTML);
    expect(totals.totalItemizedCents).toBe(55000);
    expect(checkKansasScheduleA(parsed, totals)).toEqual({
      rowsParsed: true,
      itemizedSumMatchesTotal: true,
      totalsArithmeticOk: true,
    });
  });

  it("fails the sum check by one cent and the identity check when a line is missing", () => {
    const parsed = parseKansasScheduleARows(SCHEDULE_A_HTML);
    const totals = parseKansasScheduleATotals(SCHEDULE_A_HTML);
    expect(checkKansasScheduleA(parsed, { ...totals, totalItemizedCents: 55001 })).toMatchObject({
      rowsParsed: true,
      itemizedSumMatchesTotal: false,
    });
    expect(checkKansasScheduleA(parsed, { ...totals, politicalMaterialsCents: null })).toMatchObject({
      totalsArithmeticOk: false,
    });
  });

  it("fails closed when a row amount does not parse or a row is malformed", () => {
    const totals = parseKansasScheduleATotals(SCHEDULE_A_HTML);
    const unparsed = parseKansasScheduleARows(SCHEDULE_A_HTML.replace("($50.00)", "TBD"));
    expect(unparsed.rows[2]!.amountCents).toBeNull();
    expect(checkKansasScheduleA(unparsed, totals)).toMatchObject({ rowsParsed: false, itemizedSumMatchesTotal: false });
    expect(checkKansasScheduleA({ rows: [], malformedRowCount: 1 }, totals)).toMatchObject({
      rowsParsed: false,
      itemizedSumMatchesTotal: false,
    });
  });
});

// Synthetic Schedule B page mirroring the live e-filed shape (Governor 2026,
// captured 2026-09-03): five cells per row, an entity with a blank
// occupation and an address span that ends in <br />, a person with a
// suite line and a zip+4, an under-$100 itemized row. Names and addresses
// are invented (25-4154(d)).
const SCHEDULE_B_HTML = `
<table cellspacing='0' cellpadding='2' align='center' width='98%'>
<tr>
<td align='right' class='plain9' style="width: 79px"><b><span id="Repeater1_lblType_0">Candidate:</span></b></td>
<td align='left' class='bold9'>
Example

Candidate
</td>
</tr>
</table>
<table width='98%' cellpadding='2' cellspacing='0' border='1'>
<tr>
<th align="left" class="bold10" rowspan="1" valign="middle">Date</th>
<th class='bold10' align='left' valign='middle' rowspan='1'>Name&nbsp;and Address<br />of Contributor</th>
<th class='bold10' align='left' valign='middle' rowspan='1'>Occupation of Individual Giving<br />More Than $150</th>
<th class='bold10' align='left' valign='middle' rowspan='1'>Description of<br />In-Kind<br />Contribution</th>
<th class='bold10' align='left' valign='middle' rowspan='1'>Value of<br />In-Kind<br />Contribution</th>
</tr>
<tr>
<td align="left" class="plain8" valign="middle" width="80px">
01/30/26</td>
<td valign='middle' align='left' class='plain8' width="220px">


Sample Sign Company<br />
<span id="Repeater2_lblAddress_0">PO Box 1<br /></span>
<br />
Sampleton&nbsp;
MO&nbsp;
<span id="Repeater2_lblZip_0">63000</span></td>
<td valign='middle' align='left' class='plain8' width="180px">
<br />
</td>
<td align="left" class="plain8" valign="middle" width="180px">
Donation of Signs</td>
<td align="right" class="plain8" valign="middle" width="130px">
$715.76</td>
</tr>
<tr>
<td align="left" class="plain8" valign="middle" width="80px">
05/14/26</td>
<td valign='middle' align='left' class='plain8' width="220px">
Testy
Fixture<br />
<span id="Repeater2_lblAddress_1">1 Example St<br /></span>
# 22<br />
Sampleton&nbsp;
KS&nbsp;
<span id="Repeater2_lblZip_1">66000-1234</span></td>
<td valign='middle' align='left' class='plain8' width="180px">
Attorney<br />
</td>
<td align="left" class="plain8" valign="middle" width="180px">
Food and Drink</td>
<td align="right" class="plain8" valign="middle" width="130px">
$150.00</td>
</tr>
<tr>
<td align="left" class="plain8" valign="middle" width="80px">
05/19/26</td>
<td valign='middle' align='left' class='plain8' width="220px">
Sample
Donor<br />
<span id="Repeater2_lblAddress_2">2 Example St</span>
<br />
Sampleton&nbsp;
KS&nbsp;
<span id="Repeater2_lblZip_2">66000</span></td>
<td valign='middle' align='left' class='plain8' width="180px">
Retired<br />
</td>
<td align="left" class="plain8" valign="middle" width="180px">
Food and Drink</td>
<td align="right" class="plain8" valign="middle" width="130px">
$50.00</td>
</tr>
</table>
<table width='98%' border='1' cellpadding='2' cellspacing='0'>
<tr>
<td align="left" class="bold9" colspan="6" valign="top">Total Itemized (over $100) In-Kind Contributions</td>
<td align="right" class="plain10" valign="top" width="110px">$<span id="lblTotalItemized" title="Total Itemized (over $100) In-Kind Contributions">915.76</span></td>
</tr>
<tr>
<td align="left" class="bold9" colspan="6" valign="top">Total Unitemized ($100 or less) In-Kind Contributions</td>
<td align="right" class="plain10" valign="top" width="110px">$<span id="lblTotalUnitemized" title="Total Unitemized (100 or less) In-Kind Contributions textbox">60.81</span></td>
</tr>
<tr>
<td align='left' class='bold9' colspan="6" valign='middle' bgcolor='#bbbbbb'>TOTAL IN-KIND CONTRIBUTIONS THIS PERIOD</td>
<td align='right' class='plain10' valign='top' width="110px">$<span id="lblTotalInKind" title="Total In-Kind Contributions This Period">976.57</span></td>
</tr>
</table>`;

describe("parseKansasScheduleBRows", () => {
  it("parses the live row shape: entity and person names, occupation, description, zip+4", () => {
    const parsed = parseKansasScheduleBRows(SCHEDULE_B_HTML);
    expect(parsed.malformedRowCount).toBe(0);
    expect(parsed.rows).toEqual([
      {
        index: 0,
        date: "01/30/26",
        contributorName: "Sample Sign Company",
        addressLines: ["PO Box 1", "Sampleton MO 63000"],
        zip: "63000",
        occupation: "",
        description: "Donation of Signs",
        valueCents: 71576,
      },
      {
        index: 1,
        date: "05/14/26",
        contributorName: "Testy Fixture",
        addressLines: ["1 Example St", "# 22", "Sampleton KS 66000-1234"],
        zip: "66000-1234",
        occupation: "Attorney",
        description: "Food and Drink",
        valueCents: 15000,
      },
      {
        index: 2,
        date: "05/19/26",
        contributorName: "Sample Donor",
        addressLines: ["2 Example St", "Sampleton KS 66000"],
        zip: "66000",
        occupation: "Retired",
        description: "Food and Drink",
        valueCents: 5000,
      },
    ]);
  });

  it("reports a Schedule A-shaped row (seven cells) as malformed instead of misreading it", () => {
    expect(parseKansasScheduleBRows(SCHEDULE_A_HTML)).toEqual({ rows: [], malformedRowCount: 3 });
    expect(parseKansasScheduleARows(SCHEDULE_B_HTML)).toEqual({ rows: [], malformedRowCount: 3 });
  });

  it("returns no rows for an empty schedule (live: a report with no in-kind)", () => {
    const html = `<table><tr><th>Date</th></tr></table>
      <span id="lblTotalItemized">0</span><span id="lblTotalUnitemized">0</span><span id="lblTotalInKind">0.00</span>`;
    expect(parseKansasScheduleBRows(html)).toEqual({ rows: [], malformedRowCount: 0 });
    expect(parseKansasScheduleBTotals(html)).toEqual({ totalItemizedCents: 0, totalUnitemizedCents: 0, totalInKindCents: 0 });
  });
});

describe("checkKansasScheduleB", () => {
  it("passes when the row sum equals lblTotalItemized and itemized + unitemized = total in-kind", () => {
    const parsed = parseKansasScheduleBRows(SCHEDULE_B_HTML);
    const totals = parseKansasScheduleBTotals(SCHEDULE_B_HTML);
    expect(totals).toEqual({ totalItemizedCents: 91576, totalUnitemizedCents: 6081, totalInKindCents: 97657 });
    expect(checkKansasScheduleB(parsed, totals)).toEqual({ rowsParsed: true, itemizedSumMatchesTotal: true, totalsArithmeticOk: true });
  });

  it("fails the sum check by one cent, the identity when a line is missing, and closed on an unparsed value", () => {
    const parsed = parseKansasScheduleBRows(SCHEDULE_B_HTML);
    const totals = parseKansasScheduleBTotals(SCHEDULE_B_HTML);
    expect(checkKansasScheduleB(parsed, { ...totals, totalItemizedCents: 91577 })).toMatchObject({ itemizedSumMatchesTotal: false });
    expect(checkKansasScheduleB(parsed, { ...totals, totalUnitemizedCents: null })).toMatchObject({ totalsArithmeticOk: false });
    const unparsed = parseKansasScheduleBRows(SCHEDULE_B_HTML.replace("$50.00", "TBD"));
    expect(unparsed.rows[2]!.valueCents).toBeNull();
    expect(checkKansasScheduleB(unparsed, totals)).toMatchObject({ rowsParsed: false, itemizedSumMatchesTotal: false });
    expect(checkKansasScheduleB({ rows: [], malformedRowCount: 1 }, totals)).toMatchObject({ rowsParsed: false });
  });
});

describe("parseKansasCfrGridRows", () => {
  it("retains the IndividualEntity paper filed date without inventing currentness or a durable ID", () => {
    const html = `
      <span id="gvIndividualEntity_lblPaperDate_0">10/08/2026</span>
      <a id="gvIndividualEntity_lnkbtnName_0" href="javascript:__doPostBack(&#39;gvIndividualEntity$ctl02$lnkbtnName&#39;,&#39;&#39;)">EXAMPLE SPENDER</a>
      <img id="gvIndividualEntity_paper_0" title="Paper Filing" src="../../images/pdficon_small.gif" />
      <span id="gvIndividualEntity_labelOfficeSought_0">INDIVIDUAL ENTITY</span>
      <span id="gvIndividualEntity_lblDistrictNumber_0"></span>`;
    expect(parseKansasCfrGridRows(html, "gvIndividualEntity")).toEqual([{
      index: 0, fileDate: "10/08/2026", amendmentDate: "", amendmentNo: "",
      name: "EXAMPLE SPENDER", officeSought: "INDIVIDUAL ENTITY", district: "",
      channel: "paper", postbackTarget: "gvIndividualEntity$ctl02$lnkbtnName",
    }]);
    // The fallback must not displace the existing Candidate source date fields.
    const oldFields = `<span id="gvIndividualEntity_lblOriginalDate_0">08/19/2026</span>` + html;
    expect(parseKansasCfrGridRows(oldFields, "gvIndividualEntity")[0]?.fileDate).toBe("08/19/2026");
    const efileField = `<span id="gvIndividualEntity_lblDate_0">07/27/2026</span>` + oldFields;
    expect(parseKansasCfrGridRows(efileField, "gvIndividualEntity")[0]?.fileDate).toBe("07/27/2026");
  });
  it("classifies e-filed and paper rows (live grid shapes)", () => {
    const html = `
      <span id="grdviewCfrResults_lblDate_0">07/27/2026</span>
      <span id="grdviewCfrResults_lblAmendmentDate_0"></span>
      <a id="grdviewCfrResults_lnkbtnLastName_0" href="javascript:__doPostBack(&#39;grdviewCfrResults$ctl02$lnkbtnLastName&#39;,&#39;&#39;)">Helwig</a>
      <a id="grdviewCfrResults_lnkbtnFirstName_0" href="javascript:__doPostBack(&#39;grdviewCfrResults$ctl02$lnkbtnFirstName&#39;,&#39;&#39;)">Dale</a>
      <span id="grdviewCfrResults_labelOfficeSought_0">STATE REPRESENTATIVE</span>
      <span id="grdviewCfrResults_lblDistrictNumber_0">/ 1</span>
      <span id="grdviewCfrResults_lblOriginalDate_1">07/27/2026</span>
      <span id="grdviewCfrResults_lblAmendmentDate_1">08/06/2026</span>
      <a id="grdviewCfrResults_LinkButton1_1" title="open filing with Adobe Acrobat in a new window" href="javascript:__doPostBack(&#39;grdviewCfrResults$ctl03$LinkButton1&#39;,&#39;&#39;)">HENDERSON FRANK</a>
      <img id="grdviewCfrResults_paper_1" title="Paper Filing" src="../../images/pdficon_small.gif" />
      <span id="grdviewCfrResults_lblAmendmentNo_1">2</span>`;
    const rows = parseKansasCfrGridRows(html, "grdviewCfrResults");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      fileDate: "07/27/2026",
      name: "Helwig Dale",
      officeSought: "STATE REPRESENTATIVE",
      district: "1",
      amendmentNo: "",
      channel: "efile",
      postbackTarget: "grdviewCfrResults$ctl02$lnkbtnLastName",
    });
    expect(rows[1]).toMatchObject({
      fileDate: "07/27/2026",
      amendmentDate: "08/06/2026",
      name: "HENDERSON FRANK",
      amendmentNo: "2",
      channel: "paper",
      postbackTarget: "grdviewCfrResults$ctl03$LinkButton1",
    });
  });
});

describe("parseKansasCfrGridCurrentPage", () => {
  // Live pager markup 2026-08-28: the current page is the only bare
  // <td><span>N</span></td>; every other page is a Page$N postback link.
  const pagerRow = (cells: string) =>
    `<tr><td colspan="5"><table><tr>${cells}</tr></table></td></tr>`;
  const link = (page: number) =>
    `<td><a href="javascript:__doPostBack(&#39;grdviewCfrResults&#39;,&#39;Page$${page}&#39;)">${page}</a></td>`;

  it("reads the current page from live-shaped pager rows", () => {
    const page1 = pagerRow(`<td><span>1</span></td>${link(2)}${link(3)}${link(11)}`);
    expect(parseKansasCfrGridCurrentPage(page1, "grdviewCfrResults")).toBe(1);
    const page2 = pagerRow(`${link(1)}<td><span>2</span></td>${link(3)}`);
    expect(parseKansasCfrGridCurrentPage(page2, "grdviewCfrResults")).toBe(2);
  });

  it("returns null when no pager is rendered (single-page results)", () => {
    expect(
      parseKansasCfrGridCurrentPage('<span id="grdviewCfrResults_lblDate_0">07/27/2026</span>', "grdviewCfrResults")
    ).toBeNull();
  });

  it("returns null on an ambiguous pager instead of guessing", () => {
    const ambiguous = pagerRow(`<td><span>1</span></td><td><span>2</span></td>${link(3)}`);
    expect(parseKansasCfrGridCurrentPage(ambiguous, "grdviewCfrResults")).toBeNull();
  });

  it("ignores another grid's pager", () => {
    const other = pagerRow(`<td><span>4</span></td>${link(5)}`).replaceAll(
      "grdviewCfrResults",
      "gvIndividualEntity"
    );
    expect(parseKansasCfrGridCurrentPage(other, "gvIndividualEntity")).toBe(4);
    expect(parseKansasCfrGridCurrentPage(other, "grdviewCfrResults")).toBeNull();
  });
});
