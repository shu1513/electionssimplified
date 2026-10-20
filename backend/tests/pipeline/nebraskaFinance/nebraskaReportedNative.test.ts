import { describe, expect, it } from "vitest";
import {
  NEBRASKA_NATIVE_URLS,
  neCents,
  neCsv,
  neDate,
  neDocument,
  neForm,
  neIeCsv,
  neReceiptPage,
  type NebraskaReceiptScope,
} from "../../../src/pipeline/nebraskaFinance/nebraskaReportedNative.js";

const scope: NebraskaReceiptScope = {
  start: "2025-01-01",
  end: "2025-03-31",
  contributorClass: "pac",
};
const encode = (s: string): Uint8Array => new TextEncoder().encode(s);
function form(contents: string, contributor = "PAC-Independent"): string {
  return `<form method="post" action="${NEBRASKA_NATIVE_URLS.committee}">
    <input name="__VIEWSTATE" value="synthetic-state"><input name="__EVENTVALIDATION" value="synthetic-validation">
    <input type="button" name="ctl$Contribution_SearchButton$ctl01">
    <select name="ctl$OrganizationCodeHook$ctl01"><option value="candidate" selected>Candidate Committee</option></select>
    <select name="ctl$DonorPayeeCodeHook$ctl01"><option value="typed" selected>${contributor}</option></select>
    <input name="ctl$DateFrom$ctl01" value="01/01/2025"><input name="ctl$DateThrough$ctl01" value="03/31/2025">
    ${contents}</form>`;
}
const headers = [
  "Contributor or Source",
  "City, State",
  "Transaction/Contribution Type",
  "Description",
  "Amount",
  "Date",
  "Filer/Recipient",
  "&nbsp;",
];
function receiptTables(
  receiverUrl = "OrganizationDetail.aspx?OrganizationID=101",
  nestedPager = false,
): string {
  const pager = nestedPager
    ? `<tr><td colspan="8"><table><tr>${Array.from({ length: 8 }, (_, n) => `<td>${n + 1}</td>`).join("")}</tr></table></td></tr>`
    : "";
  return `<table><tr><th>Summary Groupings</th><th>Total</th></tr><tr><td>Monetary</td><td>$125.00</td></tr></table>
    <table><tr>${headers.map((s) => `<th>${s}</th>`).join("")}</tr><tr>
    <td><a href="OrganizationDetail.aspx?OrganizationID=202">Synthetic Shared Name</a></td>
    <td>Synthetic City, NE</td><td>Monetary</td><td></td><td>$125.00</td><td>01/02/2025</td>
    <td><a href="${receiverUrl}">Synthetic Shared Name</a></td><td></td></tr>${pager}</table>`;
}
function page(html: string) {
  return neForm(
    neDocument(encode(html), NEBRASKA_NATIVE_URLS.committee),
    "committee",
  );
}
const ieHeaders = [
  "Payee or Recipient or In-Kind Contributor",
  "Transaction/Expense Type",
  "Description",
  "Amount",
  "Current Balance",
  "Date",
  "Filer/Payer/Transaction Source",
  "Support/Oppose",
  "Candidate Name or Ballot Issue",
  "Jurisdiction/Office/District or Ballot Description",
  "Other Party",
];
function ie(rows: string[][]): Uint8Array {
  return encode(
    [ieHeaders, ...rows]
      .map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(","))
      .join("\r\n") + "\r\n",
  );
}
function allocation(
  amount = "25.0000",
  target = "Synthetic Candidate",
): string[] {
  return [
    "Synthetic Vendor",
    "Independent Expenditure",
    "",
    amount,
    "0.0000",
    "01/02/2025",
    "Synthetic Spender",
    "SUPPORT",
    target,
    "NEBRASKA - STATE LEGISLATURE - District 1",
    "",
  ];
}

describe("Nebraska current native monetary parsing", () => {
  it("parses publisher currency and four-decimal serialization without rounding", () => {
    expect(neCents("$1,234.56")).toBe(123456);
    expect(neCents("1234.5600")).toBe(123456);
    expect(neCents("$-1,234.5600")).toBe(-123456);
    expect(neCents("0.0000")).toBe(0);
  });
  it.each(["1.0001", "1.2340", "12,34.00", "NaN", "1e3", "900719925474099.00"])(
    "rejects unsafe or ambiguous cents: %s",
    (value) => {
      expect(() => neCents(value)).toThrow();
    },
  );
  it("checks calendar values rather than normalizing invalid dates", () => {
    expect(neDate("2/29/2024")).toBe("2024-02-29");
    expect(() => neDate("2/29/2025")).toThrow(/date_value/);
    expect(() => neDate("2026-13-01")).toThrow(/date_value/);
    expect(() => neDate("01-02-2026")).toThrow(/date_format/);
  });
  it("preserves quoted CSV content and rejects truncated or duplicate-column data", () => {
    expect(
      neCsv(encode('A,B\r\n"Synthetic ""Committee""","two\nlines"\r\n')).rows,
    ).toEqual([['Synthetic "Committee"', "two\nlines"]]);
    expect(() => neCsv(encode('A,B\n"unfinished,B'))).toThrow(
      /csv_unterminated/,
    );
    expect(() => neCsv(encode("A,A\n1,2\n"))).toThrow(/csv_columns/);
    expect(() => neCsv(encode('A,B\n"closed"unexpected,2\n'))).toThrow(
      /csv_after_quote/,
    );
  });
});

describe("Nebraska typed receipt pages", () => {
  it("excludes an eight-cell nested pager and binds the receiving column's ID", () => {
    const p = neReceiptPage(page(form(receiptTables(undefined, true))), scope);
    expect(p.receipts).toHaveLength(1);
    expect(p.receipts[0]?.receivingId).toBe("101");
    expect(p.receipts[0]?.amountCents).toBe(12500);
    expect(p.summaryCents).toBe(12500);
    expect(p.explicitEmpty).toBe(false);
  });
  it("requires the actual contributor filter, including on a no-records page", () => {
    const empty =
      "<p>Please correct the following errors: No records found for this search criteria.</p>";
    expect(() => neReceiptPage(page(form(empty, "")), scope)).toThrow(
      /native_type_scope/,
    );
    expect(neReceiptPage(page(form(empty)), scope).explicitEmpty).toBe(true);
  });
  it("does not convert a generic error, missing grid or CAPTCHA to zero", () => {
    expect(() =>
      neReceiptPage(
        page(form("<p>Please correct the following errors: Invalid date.</p>")),
        scope,
      ),
    ).toThrow(/native_receipt_grids/);
    expect(() =>
      neReceiptPage(page(form("<p>Temporarily unavailable</p>")), scope),
    ).toThrow(/native_receipt_grids/);
    expect(() =>
      page("<form method='post'>Human verification required</form>"),
    ).toThrow();
  });
  it("rejects a source response whose displayed date scope changed", () => {
    expect(() =>
      neReceiptPage(
        page(
          form(receiptTables()).replace(
            'value="03/31/2025"',
            'value="12/31/2025"',
          ),
        ),
        scope,
      ),
    ).toThrow(/native_date_scope/);
  });
  it("rejects a financial identity link on another origin", () => {
    expect(() =>
      neReceiptPage(
        page(
          form(
            receiptTables(
              "https://example.invalid/OrganizationDetail.aspx?OrganizationID=101",
            ),
          ),
        ),
        scope,
      ),
    ).toThrow(/native_origin/);
  });
});

describe("Nebraska exported independent-expenditure allocations", () => {
  it("retains separate equal-valued allocations and repeated reported rows", () => {
    const rows = neIeCsv(
      ie([
        allocation(),
        allocation(),
        allocation("50.0000", "Other Synthetic Candidate"),
      ]),
      2026,
    );
    expect(rows).toHaveLength(3);
    expect(rows.reduce((sum, row) => sum + row.amountCents, 0)).toBe(10000);
  });
  it("retains unattributed expense evidence without inventing target or stance", () => {
    const row = allocation();
    row[7] = "";
    row[8] = "";
    row[9] = "";
    expect(neIeCsv(ie([row]), 2026)[0]).toMatchObject({
      targetName: "",
      officeDistrict: "",
      stance: null,
      amountCents: 2500,
    });
  });
  it("holds historical offsets, out-of-cycle rows and lost type filters", () => {
    expect(() => neIeCsv(ie([allocation("-25.0000")]), 2026)).toThrow(
      /negative_current_ie/,
    );
    const old = allocation();
    old[5] = "12/31/2024";
    expect(() => neIeCsv(ie([old]), 2026)).toThrow(/ie_date_scope/);
    const direct = allocation();
    direct[1] = "Direct contribution";
    expect(() => neIeCsv(ie([direct]), 2026)).toThrow(/ie_transaction_type/);
  });
});
