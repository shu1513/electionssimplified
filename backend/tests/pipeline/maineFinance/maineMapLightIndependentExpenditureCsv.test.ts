import { describe, expect, it } from "vitest";
import {
  MAINE_MAPLIGHT_INDEPENDENT_EXPENDITURE_HEADERS as HEADERS,
  parseMaineMapLightIndependentExpenditureCsv as parse,
} from "../../../src/pipeline/maineFinance/maineMapLightIndependentExpenditureCsv.js";

type Column = (typeof HEADERS)[number];
const activity = (character: string) => `a_${character.repeat(26)}`;
const filer = (character: string) => `f_${character.repeat(26)}`;
function row(
  overrides: Partial<Record<Column, string>> = {},
): Record<Column, string> {
  return {
    "Transaction ID": activity("a"),
    "Filer ID": filer("b"),
    "Filer Name": "Example PAC",
    "Transaction Type": "independent_expenditure",
    "Transaction Date": "2026-10-09",
    "Total Transaction Amount": "$100.00",
    Description: "Mail",
    "Contact Type": "Business",
    "Contact Name": "Example Printer",
    "Contact Street Address 1": "",
    "Contact Street Address 2": "",
    "Contact City": "",
    "Contact State": "",
    "Contact Zip": "",
    Purpose: "Candidate mail",
    "Candidate Name": "Alex Example",
    "Candidate ID": filer("c"),
    "Support or Oppose": "support",
    "Amount Spent on Candidate": "$100.00",
    ...overrides,
  };
}
const quote = (value: string) =>
  /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
function csv(rows: Record<Column, string>[], newline = "\n"): string {
  return [
    HEADERS.join(","),
    ...rows.map((item) => HEADERS.map((key) => quote(item[key])).join(",")),
  ].join(newline);
}

describe("Maine MapLight independent expenditure allocation facts", () => {
  it("uses candidate allocation, not the whole payment, and retains each association", () => {
    const parsed = parse(
      csv([
        row({
          "Total Transaction Amount": "$53,348.55",
          "Amount Spent on Candidate": "$30,000.00",
        }),
        row({
          "Total Transaction Amount": "$53,348.55",
          "Amount Spent on Candidate": "$23,348.55",
          "Candidate ID": filer("d"),
          "Candidate Name": "Casey Example",
          "Support or Oppose": "oppose",
        }),
      ]),
    );
    expect(
      parsed.map((item) => [
        item.occurrence,
        item.supportOppose,
        item.amountSpentOnCandidateCents,
      ]),
    ).toEqual([
      [1, "support", 3000000],
      [2, "oppose", 2334855],
    ]);
    expect(parsed[0].totalTransactionAmountCents).toBe(5334855);
    expect(parsed[0].totalTransactionAmount).toBe("$53,348.55");
    expect(parsed[0]).not.toHaveProperty("rawFields");
    expect(parsed[0]).not.toHaveProperty("contactStreetAddress1");
    expect(parsed[0]).not.toHaveProperty("contactName");
    expect(parsed[0]).not.toHaveProperty("contactType");
  });

  it("retains unassigned candidate IDs without inventing identity", () => {
    expect(parse(csv([row({ "Candidate ID": "" })]))[0].candidateId).toBeNull();
  });

  it("retains signed and zero facts without treating them as accepted refunds or money", () => {
    const parsed = parse(
      csv([
        row({
          "Total Transaction Amount": "-$10.00",
          "Amount Spent on Candidate": "-$10.00",
        }),
        row({
          "Transaction ID": activity("d"),
          "Total Transaction Amount": "$0.00",
          "Amount Spent on Candidate": "$0.00",
        }),
        row({
          "Transaction ID": activity("e"),
          "Total Transaction Amount": "$-5.00",
          "Amount Spent on Candidate": "$-5.00",
        }),
      ]),
    );
    expect(parsed.map((item) => item.amountSpentOnCandidateCents)).toEqual([
      -1000, 0, -500,
    ]);
  });

  it("preserves equal amounts on distinct transaction IDs", () => {
    expect(
      parse(csv([row(), row({ "Transaction ID": activity("d") })])),
    ).toHaveLength(2);
  });

  it("accepts quoted commas, escaped quotes and multiline financial descriptions", () => {
    const input = row({ Description: 'Mail, "quoted"\r\nsecond line' });
    expect(parse(`\uFEFF${csv([input], "\r\n")}\r\n`)[0].description).toBe(
      input.Description,
    );
  });

  it("returns header-only facts without asserting complete zero", () => {
    expect(parse(HEADERS.join(","))).toEqual([]);
  });

  it.each([
    ["missing header", HEADERS.slice(1).join(",")],
    [
      "unspaced header",
      HEADERS.join(",").replace("Transaction ID", "TransactionID"),
    ],
    ["reordered header", [...HEADERS].reverse().join(",")],
    ["HTML error", "<html>Error</html>"],
    ["empty", ""],
  ])("rejects %s", (_reason, input) => {
    expect(() => parse(input)).toThrow("unexpected 19-column header");
  });

  it.each([
    ["short", csv([row()]).slice(0, -1)],
    ["extra", `${csv([row()])},extra`],
    [
      "blank interior",
      `${HEADERS.join(",")}\n\n${csv([row()]).split("\n")[1]}`,
    ],
  ])("rejects %s records without silently omitting them", (_reason, input) => {
    expect(() => parse(input)).toThrow();
  });

  it.each(['abc"def', '"unterminated', '"closed"extra'])(
    "rejects malformed CSV quoting",
    (bad) => {
      const cells = HEADERS.map((key) => quote(row()[key]));
      cells[6] = bad;
      expect(() => parse(`${HEADERS.join(",")}\n${cells.join(",")}`)).toThrow();
    },
  );

  it.each([
    "2026-02-29",
    "2025-04-31",
    "2026-00-09",
    "2026-13-01",
    "10/09/2026",
    "2026-1-01",
  ])("rejects invalid civil date %s", (date) => {
    expect(() => parse(csv([row({ "Transaction Date": date })]))).toThrow(
      "invalid transaction date",
    );
  });
  it("accepts a real leap day", () => {
    expect(
      parse(csv([row({ "Transaction Date": "2024-02-29" })]))[0]
        .transactionDate,
    ).toBe("2024-02-29");
  });

  it.each([
    "$1,00.00",
    "$100",
    "$100.001",
    "1e2",
    "$100.0",
    " 100.00",
    "NaN",
    "$90071992547410.00",
  ])("rejects non-exact money without echoing raw fields", (amount) => {
    expect(() =>
      parse(csv([row({ "Total Transaction Amount": amount })])),
    ).toThrow(/invalid exact-cent amount|range/);
  });

  it.each(["returned_independent_expenditure", "contribution", ""])(
    "rejects unsupported type %s",
    (type) => {
      expect(() => parse(csv([row({ "Transaction Type": type })]))).toThrow(
        "unsupported transaction type",
      );
    },
  );
  it.each(["SUPPORT", "Support", "unknown", ""])(
    "rejects unsupported stance %s",
    (stance) => {
      expect(() => parse(csv([row({ "Support or Oppose": stance })]))).toThrow(
        "unsupported direction",
      );
    },
  );

  it("rejects missing or wrong-namespace source IDs", () => {
    for (const field of ["Transaction ID", "Filer ID"] as const) {
      expect(() => parse(csv([row({ [field]: "" })]))).toThrow(
        "invalid source ID",
      );
    }
    expect(() => parse(csv([row({ "Candidate ID": activity("c") })]))).toThrow(
      "invalid source ID",
    );
  });

  it("rejects exact duplicate allocation keys rather than economically deduping", () => {
    expect(() => parse(csv([row(), row()]))).toThrow(
      "duplicate allocation key",
    );
    expect(() =>
      parse(csv([row({ "Candidate ID": "" }), row({ "Candidate ID": "" })])),
    ).toThrow("duplicate allocation key");
  });

  it("rejects conflicting repeated transaction facts", () => {
    for (const field of [
      "Description",
      "Contact Name",
      "Contact Street Address 1",
      "Filer ID",
      "Transaction Date",
    ] as const) {
      const second = row({
        "Candidate ID": filer("d"),
        "Candidate Name": "Casey Example",
        "Amount Spent on Candidate": "$50.00",
      });
      second[field] =
        field === "Filer ID"
          ? filer("e")
          : field === "Transaction Date"
            ? "2026-10-10"
            : "changed";
      expect(() =>
        parse(csv([row({ "Amount Spent on Candidate": "$50.00" }), second])),
      ).toThrow("conflicting whole-transaction fields");
    }
  });

  it("rejects changed names for an existing candidate or filer ID", () => {
    expect(() =>
      parse(
        csv([
          row(),
          row({
            "Transaction ID": activity("d"),
            "Candidate Name": "Changed Example",
          }),
        ]),
      ),
    ).toThrow("conflicting candidate identity");
    expect(() =>
      parse(
        csv([
          row(),
          row({ "Transaction ID": activity("d"), "Filer Name": "Changed PAC" }),
        ]),
      ),
    ).toThrow("conflicting filer identity");
  });

  it("does not expose rejected raw values in diagnostics", () => {
    const privateMarker = "PRIVATE_SOURCE_FIELD";
    try {
      parse(csv([row({ "Amount Spent on Candidate": privateMarker })]));
      expect.fail("Invalid amount should throw");
    } catch (error) {
      expect(String(error)).toContain("invalid exact-cent amount");
      expect(String(error)).not.toContain(privateMarker);
    }
  });

  it("rejects missing allocations and over-allocation rather than guessing shares", () => {
    for (const amount of ["$99.99", "$100.01"]) {
      expect(() =>
        parse(csv([row({ "Amount Spent on Candidate": amount })])),
      ).toThrow("candidate allocations do not equal whole transaction");
    }
  });
});
