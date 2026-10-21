import { describe, expect, it } from "vitest";
import {
  akAdd,
  akCandidateChoice,
  akCents,
  akColumn,
  akDate,
  akDocument,
  akField,
  akForm,
  akGrid,
  akMoneyRows,
  akPersonMatches,
  akRenderedText,
  akSetChoice,
  akSubmittedDay,
  ALASKA_REPORTED_URLS,
} from "../../../src/pipeline/alaskaFinance/alaskaReportedNative.js";

// Synthetic source documents only. No government record is a test fixture.
const controls = `<input type="hidden" name="__EVENTTARGET" value="old"><input type="hidden" name="__EVENTARGUMENT" value="old">
<input type="hidden" name="__VIEWSTATE" value="synthetic-state">
<select name="M$C$csfFilter$ddlReportYear"><option value="-1">Any</option><option value="2026" selected>2026</option></select>
<select name="M$C$csfFilter$ddlStatus"><option value="Default">Complete, Not Amended</option></select>
<input type="submit" name="M$C$csfFilter$btnSearch" value="Search">`;
const page = (body: string) =>
  new TextEncoder().encode(
    `<html><body><form>${controls}${body}</form></body></html>`,
  );

describe("Alaska native source controls", () => {
  it("retains signed cents and rejects fractional cents, malformed grouping and overflow", () => {
    expect(akCents("($1,234.50)")).toBe(-123450);
    expect(akCents("$-2.3400")).toBe(-234);
    expect(akAdd(akCents("1.25"), akCents("-1.25"))).toBe(0);
    for (const amount of [
      "1.001",
      "1,23.00",
      "1e3",
      "(-1.00)",
      "$--1",
      "90071992547410.00",
    ])
      expect(() => akCents(amount)).toThrow();
    expect(() => akAdd(Number.MAX_SAFE_INTEGER, 1)).toThrow("amount_overflow");
  });
  it("validates filing calendar dates and keeps them separate from observation clocks", () => {
    expect(akDate("2/29/2024")).toBe("2024-02-29");
    expect(akSubmittedDay("1/2/2025 11:59:02 PM")).toBe("2025-01-02");
    for (const date of [
      "2/29/2025",
      "2026-04-31",
      "10/20/26",
      "2026-01-01T00:00:00Z",
    ])
      expect(() => akDate(date)).toThrow();
    expect(() => akSubmittedDay("1/2/2025 25:99:00")).toThrow(
      "registration_time_value",
    );
  });
  it("uses the explicit candidate-choice year rather than a filing-year fallback", () => {
    expect(akCandidateChoice("2024 - Example Person")).toEqual({
      year: 2024,
      name: "Example Person",
    });
    for (const value of ["Example Person", "-1 - Example Person", "2026 - "])
      expect(() => akCandidateChoice(value)).toThrow("candidate_choice_year");
  });
  it("preserves conflicting middle evidence and resolves a shared nickname only with formal evidence", () => {
    expect(
      akPersonMatches(["Pat Example"], "Patricia Example", ["Patricia"]),
    ).toBe(true);
    expect(
      akPersonMatches(["Pat Example"], "Patrick Example", ["Patricia"]),
    ).toBe(false);
    expect(
      akPersonMatches(
        ["Jordan A Example", "Jordan Example"],
        "Jordan B Example",
      ),
    ).toBe(false);
    expect(akPersonMatches(["Jordan Example"], "Jordan Another")).toBe(false);
  });
  it("posts only published choices and preserves actual hidden state", () => {
    const form = akForm(page(""), ALASKA_REPORTED_URLS.ie);
    akSetChoice(form, "ddlReportYear", "-1");
    expect(form.fields.get("__VIEWSTATE")).toBe("synthetic-state");
    expect(form.fields.has("__LASTFOCUS")).toBe(false);
    expect(() => akSetChoice(form, "ddlReportYear", "2028")).toThrow(
      "unpublished_source_filter",
    );
  });
  it("resolves real relative report links against the report page, without inventing a single-page count", () => {
    const grid = akGrid(
      page(
        `<table id="M_C_grid_ctl00"><thead><tr><th>Filer Name</th><th>Filer</th><th>Status</th></tr></thead><tbody><tr class="rgRow"><td>Example Submitter</td><td>Example Spender</td><td><a href="../Common/View.aspx?ID=991001&amp;ViewType=IE">Filed</a></td></tr></tbody></table>`,
      ),
      ALASKA_REPORTED_URLS.ie,
    );
    expect(grid.rows[0]?.href).toBe(
      "https://aws.state.ak.us/ApocReports/Common/View.aspx?ID=991001&ViewType=IE",
    );
    expect(grid.rows[0]?.cells[akColumn(grid.headers, "Filer")]).toBe(
      "Example Spender",
    );
    expect(grid.total).toBeNull();
    expect(() => akColumn(["Filer Type", "Filer Type"], "Filer Type")).toThrow(
      "native_column",
    );
    expect(akColumn(["Filer Type", "Filer Type"], "Filer Type", 0)).toBe(0);
  });
  it("rejects a missing financial column or a link outside the government origin", () => {
    const invalid = (href: string, cell: string) =>
      page(
        `<table id="M_C_grid_ctl00"><tr><th>Amount</th><th>Status</th></tr><tr class="rgRow">${cell}<td><a href="${href}">Filed</a></td></tr></table>`,
      );
    expect(() =>
      akGrid(
        invalid(
          "https://example.invalid/ApocReports/Common/View.aspx?ID=991001&amp;ViewType=IE",
          "<td>$1.00</td>",
        ),
        ALASKA_REPORTED_URLS.ie,
      ),
    ).toThrow("source_origin");
    expect(() =>
      akGrid(
        invalid("../Common/View.aspx?ID=991001&amp;ViewType=IE", ""),
        ALASKA_REPORTED_URLS.ie,
      ),
    ).toThrow("native_grid_row");
  });
  it("treats repeated identical field headers as evidence but rejects conflicting values", () => {
    const document = (second: string) =>
      akDocument(
        page(
          `<div>Report Type:<span>Thirty Day Report</span></div><div>Report Type:<span>${second}</span></div>`,
        ),
        ALASKA_REPORTED_URLS.campaign,
      );
    expect(akField(document("Thirty Day Report"), "Report Type:")).toBe(
      "Thirty Day Report",
    );
    expect(() => akField(document("Seven Day Report"), "Report Type:")).toThrow(
      "native_field_ambiguous",
    );
  });
  it("reads complete native income rows and interprets address breaks without repairing originals", () => {
    const document = akDocument(
      page(
        `<table id="tblIncome"><tr><th>Date Received</th><th>Payment Method</th><th>Contributor</th><th>Details</th><th>Amount</th></tr><tr><td>1/2/2026</td><td>Check</td><td>Example PAC<br>12 Example Way<br>Example City, AK 99001</td><td></td><td>$12.34</td></tr><tr><td>1/3/2026</td><td>Check</td><td>Another Example</td><td></td><td>-$1.00</td></tr></table>`,
      ),
      ALASKA_REPORTED_URLS.campaign,
    );
    const rows = akMoneyRows(document, "tblIncome", 5);
    expect(rows).toHaveLength(2);
    expect(akRenderedText(rows[0]![2]!)).toBe(
      "Example PAC 12 Example Way Example City, AK 99001",
    );
    expect(
      rows.reduce((sum, row) => sum + akCents(row[4]!.textContent!), 0),
    ).toBe(1134);
    document
      .querySelector("#tblIncome")!
      .insertAdjacentHTML(
        "beforeend",
        "<tr><td>unexpected financial row</td></tr>",
      );
    expect(() => akMoneyRows(document, "tblIncome", 5)).toThrow(
      "unrecognized_native_money_row",
    );
  });
  it("checks native total rows and distinguishes explicit empty tables from malformed rows", () => {
    const header =
      "<tr><th>Date</th><th>Method</th><th>Name</th><th>Details</th><th>Amount</th></tr>";
    const doc = (body: string) =>
      akDocument(
        page(`<table id="tblIncome">${header}${body}</table>`),
        ALASKA_REPORTED_URLS.campaign,
      );
    const empty = '<tr><td colspan="5">No Income / Nothing to Report</td></tr>';
    const total = (amount: string) =>
      `<tr><td colspan="2"></td><td colspan="2">Income Total:</td><td>${amount}</td></tr>`;
    expect(akMoneyRows(doc(empty + total("$0.00")), "tblIncome", 5)).toEqual(
      [],
    );
    expect(() =>
      akMoneyRows(doc(empty + total("$1.00")), "tblIncome", 5),
    ).toThrow("native_itemized_total");
    expect(() =>
      akMoneyRows(
        doc(
          empty +
            "<tr><td>1/1/2026</td><td>Cash</td><td>Example</td><td></td><td>$0.00</td></tr>",
        ),
        "tblIncome",
        5,
      ),
    ).toThrow("mixed_empty_money_table");
  });
});
