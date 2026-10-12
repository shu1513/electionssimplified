import { describe, expect, it } from "vitest";
import {
  closeDelawareNativeLedger,
  decodeDelawareExpenseNativePage,
  decodeDelawareReceiptNativePage,
  DELAWARE_NATIVE_EXPENSE_FIELDS,
  DELAWARE_NATIVE_RECEIPT_FIELDS,
  projectDelawareNativeExpenseCsvRow,
  projectDelawareNativeReceiptCsvRow,
  type DelawareNativeLedgerPage,
} from "../../../src/pipeline/delawareFinance/delawareNativeLedger.js";
import {
  DELAWARE_EXPENSE_CSV_COLUMNS,
  DELAWARE_RECEIPT_CSV_COLUMNS,
} from "../../../src/pipeline/delawareFinance/delawareCfrsParsers.js";

function receipt(id = 1, overrides: Record<string, unknown> = {}) {
  return {
    ...Object.fromEntries(
      DELAWARE_NATIVE_RECEIPT_FIELDS.map((key) => [key, ""]),
    ),
    ContributionType: "Check",
    TransactionDate: "/Date(1786507200000)/",
    Transaction_id: id,
    ContributorName: "Example Committee, Inc.",
    ContributionAmount: 600,
    ContributorType: "Political Action Committee",
    ReceivingCommitteeName: "Example Candidate",
    GabId: "123456",
    WC_ID: "01000001",
    Office: null,
    Branch: null,
    District: "District 38 (State Representative)",
    FilingPeriodName: "2026 30 Day General",
    EmployerAddress: null,
    EmployerAddressLine1: null,
    Fund_Type: null,
    Fixed_Asset: "No",
    FileAmendedVersion: "12 Aug 2026 Version 0.012:00AM",
    AddressLine1: "1 Example St",
    City: "Example",
    State_Code: "DE",
    Zip_Code: "19901",
    ...overrides,
  };
}
function expense(id = 1, overrides: Record<string, unknown> = {}) {
  return {
    ...Object.fromEntries(
      DELAWARE_NATIVE_EXPENSE_FIELDS.map((key) => [key, ""]),
    ),
    Transaction_Id: id,
    RegistrantName: "Example Candidate",
    PayeeName: "Example Vendor",
    PayeeType: "Corporation, Partnership, and Other Entity",
    TransactionDate: "/Date(1786507200000)/",
    ExpenseAmount: 123.45,
    ExpenseCategory: "Other Expenses",
    ExpensePurpose: "Other",
    ExpenseMethod: "Check",
    District: null,
    FilingYear: null,
    CommitteeID: null,
    FilingPeriodName: "2026 30 Day General",
    Comments: null,
    Fund_Type: null,
    Fixed_Asset: "No",
    CCF_ID: "01000001",
    FileAmendedVersion: "12 Aug 2026 Version 0.012:00AM",
    AddressLine1: "2 Example St",
    City: "Example",
    State: "DE",
    ZipCode: "19901",
    ...overrides,
  };
}
function page(
  rows: Record<string, unknown>[],
  kind: "receipts" | "expenses" = "receipts",
  total: unknown = 0,
) {
  const json = JSON.stringify({ data: rows, total });
  return kind === "receipts"
    ? decodeDelawareReceiptNativePage(json)
    : decodeDelawareExpenseNativePage(json);
}
function csv(p: DelawareNativeLedgerPage) {
  const columns =
    p.kind === "receipts"
      ? DELAWARE_RECEIPT_CSV_COLUMNS
      : DELAWARE_EXPENSE_CSV_COLUMNS;
  const dateKey =
    p.kind === "receipts" ? "Contribution Date" : "Expenditure Date";
  const amountKey = p.kind === "receipts" ? "Contribution Amount" : "Amount($)";
  const rows = p.rows.map((row) => {
    const projected =
      p.kind === "receipts"
        ? projectDelawareNativeReceiptCsvRow(row)
        : projectDelawareNativeExpenseCsvRow(row);
    const [year, month, day] = projected[dateKey]!.split("-");
    projected[dateKey] = Number(month) + "/" + Number(day) + "/" + year;
    projected[amountKey] = (Number(projected[amountKey]) / 100).toFixed(4);
    return columns.map((key) => projected[key]).join(",");
  });
  return columns.join(",") + ",\n" + rows.join("\n") + "\n";
}
function close(
  p: DelawareNativeLedgerPage,
  sourceCsv = csv(p),
  renderedCount = p.rows.length,
) {
  return closeDelawareNativeLedger({
    pages: [{ pageNumber: 1, pageSize: 500, page: p }],
    renderedCount,
    csv: sourceCsv,
  });
}

describe("Delaware native schema and full-field preservation", () => {
  it("retains nullable and additional source fields without interpreting them as false", () => {
    const input = receipt(1, {
      AdditionalSourceField: { marker: "raw" },
      Fund_Type: null,
    });
    const result = page([input], "receipts", 999999);
    expect(result.rows[0]!.rawFields).toEqual(input);
    expect(result.rows[0]!.rawFields.Fund_Type).toBeNull();
    expect(result.advisoryTotal).toBe(999999);
    expect(result.rows[0]!.date).toBe("2026-08-12");
    input.ContributorName = "Changed externally";
    expect(result.rows[0]!.rawFields.ContributorName).toBe(
      "Example Committee, Inc.",
    );
    expect(Object.isFrozen(result.rows[0]!.rawFields)).toBe(true);
  });
  it("rejects missing published fields instead of silently accepting a partial row", () => {
    const row: Record<string, unknown> = receipt();
    delete row.EmployerName;
    expect(() => page([row])).toThrow(/required published field/);
  });
  it.each([null, {}, "not JSON"])(
    "requires explicit data array for %j",
    (data) => {
      const raw =
        data === "not JSON" ? data : JSON.stringify({ data, total: 0 });
      expect(() => decodeDelawareReceiptNativePage(raw)).toThrow();
    },
  );
  it("rejects changed identifier, amount, date, and fixed-asset field types", () => {
    for (const changes of [
      { Transaction_id: "1" },
      { ContributionAmount: "600.0000" },
      { TransactionDate: "2026-08-12" },
      { Fixed_Asset: false },
    ]) {
      expect(() => page([receipt(1, changes)])).toThrow();
    }
  });
  it("retains signed exact cents but rejects sub-cent rounding", () => {
    expect(
      page([receipt(1, { ContributionAmount: -12.34 })]).rows[0]!.amountCents,
    ).toBe(-1234);
    expect(() => page([receipt(1, { ContributionAmount: 12.345 })])).toThrow(
      /sub-cent/,
    );
  });
  it("preserves explicit expense return fields and source comments", () => {
    const result = page(
      [
        expense(7, {
          ExpenseCategory: "Return Contributions",
          PayeeType: "Individual",
          Comments: "Source note",
        }),
      ],
      "expenses",
    );
    expect(result.rows[0]!.rawFields.ExpenseCategory).toBe(
      "Return Contributions",
    );
    expect(result.rows[0]!.rawFields.Comments).toBe("Source note");
  });
});

describe("complete native transport closure", () => {
  it("ignores advisory total and proves cardinality against rendered and CSV sources", () => {
    const p = page([receipt(1), receipt(2)], "receipts", 7152);
    expect(close(p).rows).toHaveLength(2);
    expect(close(p).advisoryTotals).toEqual([7152]);
    expect(() => close(p, csv(p), 3)).toThrow(/logical count/);
  });
  it("accepts a genuine short single page at its actual smaller request size", () => {
    const p = page([expense(1)], "expenses", 0);
    const result = closeDelawareNativeLedger({
      pages: [{ pageNumber: 1, pageSize: 100, page: p }],
      renderedCount: 1,
      csv: csv(p),
    });
    expect(result.rows).toHaveLength(1);
    expect(() =>
      closeDelawareNativeLedger({
        pages: [{ pageNumber: 1, pageSize: 1, page: p }],
        renderedCount: 1,
        csv: csv(p),
      }),
    ).toThrow(/terminal/);
  });
  it("rejects invalid single-page request limits", () => {
    const p = page([receipt(1)]);
    for (const size of [0, 501, 1.5, NaN]) {
      expect(() =>
        closeDelawareNativeLedger({
          pages: [{ pageNumber: 1, pageSize: size, page: p }],
          renderedCount: 1,
          csv: csv(p),
        }),
      ).toThrow();
    }
  });
  it("retains equal gifts having different stable transaction IDs", () => {
    const result = close(page([receipt(1), receipt(2)]));
    expect(result.rows.map((row) => row.transactionId)).toEqual([1, 2]);
    expect(result.transportOverlapCount).toBe(0);
  });
  it("only unions exact stable-ID full-field page-boundary transport overlap", () => {
    const first = page(
      Array.from({ length: 500 }, (_, index) => receipt(index + 1)),
    );
    const last = page([receipt(500), receipt(501)]);
    const full = page([receipt(501)]);
    const sourceCsv =
      csv(first).trimEnd() + "\n" + csv(full).split("\n").slice(1).join("\n");
    const result = closeDelawareNativeLedger({
      pages: [
        { pageNumber: 1, pageSize: 500, page: first },
        { pageNumber: 2, pageSize: 500, page: last },
      ],
      renderedCount: 501,
      csv: sourceCsv,
    });
    expect(result.rows).toHaveLength(501);
    expect(result.physicalRowCount).toBe(502);
    expect(result.transportOverlapCount).toBe(1);
  });
  it("rejects conflicting repeated IDs including changed fields absent from CSV", () => {
    const first = page(
      Array.from({ length: 500 }, (_, index) => receipt(index + 1)),
    );
    const last = page([
      receipt(500, { EmployerAddress: "Changed published native field" }),
    ]);
    expect(() =>
      closeDelawareNativeLedger({
        pages: [
          { pageNumber: 1, pageSize: 500, page: first },
          { pageNumber: 2, pageSize: 500, page: last },
        ],
        renderedCount: 500,
        csv: csv(first),
      }),
    ).toThrow(/Conflicting/);
  });
  it("rejects same-page repeated ID rather than calling it an economic duplicate", () => {
    expect(() => close(page([receipt(1), receipt(1)]))).toThrow(
      /page-boundary/,
    );
  });
  it("rejects missing page, wrong size, short middle page, and missing terminal page", () => {
    const full = page(
      Array.from({ length: 500 }, (_, index) => receipt(index + 1)),
    );
    const short = page([receipt(501)]);
    for (const pages of [
      [{ pageNumber: 1, pageSize: 500, page: full }],
      [{ pageNumber: 1, pageSize: 100, page: short }],
      [
        { pageNumber: 1, pageSize: 500, page: full },
        { pageNumber: 3, pageSize: 500, page: short },
      ],
      [
        { pageNumber: 1, pageSize: 500, page: short },
        { pageNumber: 2, pageSize: 500, page: short },
      ],
    ]) {
      expect(() =>
        closeDelawareNativeLedger({
          pages,
          renderedCount: 501,
          csv: csv(short),
        }),
      ).toThrow();
    }
  });
  it("permits explicit empty transport without claiming financial zero", () => {
    const result = close(page([]));
    expect(result.rows).toEqual([]);
    expect(result).not.toHaveProperty("totalReceipts");
  });
});

describe("full CSV/native published identity projection", () => {
  it("uses exact observed comma projection and native District for CSV Office", () => {
    const p = page([
      receipt(1, {
        AddressLine1: "1 Example St, Suite 2",
        Zip_Ext: "1234",
        ContributorType: "Corporation, Partnership, and Other Entity",
      }),
    ]);
    const result = close(p);
    expect(result.rows[0]!.rawFields.ContributorName).toContain(",");
    expect(projectDelawareNativeReceiptCsvRow(result.rows[0]!)["Office"]).toBe(
      "District 38 (State Representative)",
    );
    expect(
      projectDelawareNativeReceiptCsvRow(result.rows[0]!)["Contributor Zip"],
    ).toBe("19901-1234");
  });
  it("retains the published hyphen for a nonempty whitespace ZIP extension", () => {
    const p = page([receipt(1, { Zip_Ext: "    " })]);
    expect(
      projectDelawareNativeReceiptCsvRow(p.rows[0]!)["Contributor Zip"],
    ).toBe("19901-");
    expect(close(p).rows).toHaveLength(1);
  });
  it("checks employer and address identity even when all money sums still match", () => {
    const p = page([receipt(1)]);
    const modified = page([receipt(1, { EmployerName: "Different employer" })]);
    expect(() => close(p, csv(modified))).toThrow(/full published/i);
    const differentAddress = page([
      receipt(1, { AddressLine2: "Different source line" }),
    ]);
    expect(() => close(p, csv(differentAddress))).toThrow(/full published/i);
  });
  it("does not accept alternate punctuation or a legal-name alias", () => {
    const p = page([receipt(1)]);
    const changed = csv(p).replace(
      "Example Committee  Inc.",
      "Example Committee Inc",
    );
    expect(() => close(p, changed)).toThrow(/multiset/);
  });
  it("compares expense purpose, method, category and signed amounts", () => {
    const p = page(
      [
        expense(1, {
          ExpenseAmount: -123.45,
          ExpensePurpose: "Printing (buttons,shirts)",
        }),
      ],
      "expenses",
    );
    expect(close(p).rows[0]!.amountCents).toBe(-12345);
    const changed = csv(p).replace(
      "Printing (buttons shirts)",
      "Different purpose",
    );
    expect(() => close(p, changed)).toThrow(/multiset/);
  });
  it("fingerprints every raw field while tolerating JSON object key order", () => {
    const original = receipt();
    const reordered = Object.fromEntries(Object.entries(original).reverse());
    expect(close(page([original])).rawRowFingerprint).toBe(
      close(page([reordered])).rawRowFingerprint,
    );
    const changed = receipt(1, {
      EmployerAddress: "New native-only source value",
    });
    expect(close(page([changed])).rawRowFingerprint).not.toBe(
      close(page([original])).rawRowFingerprint,
    );
  });
});
