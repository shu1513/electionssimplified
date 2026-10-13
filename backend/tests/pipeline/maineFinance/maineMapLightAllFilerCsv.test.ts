import { describe, expect, it } from "vitest";
import {
  MAINE_MAPLIGHT_ALL_FILER_HEADERS as HEADERS,
  MAINE_MAPLIGHT_ALL_FILER_SOURCE_ROLES as ROLES,
  parseMaineMapLightAllFilerCsv as parse,
} from "../../../src/pipeline/maineFinance/maineMapLightAllFilerCsv.js";

type Column = (typeof HEADERS)[number];
const activity = (letter: string) => `a_${letter.repeat(26)}`;
const filer = (letter: string) => `f_${letter.repeat(26)}`;
function row(
  overrides: Partial<Record<Column, string>> = {},
): Record<Column, string> {
  return {
    "Transaction ID": activity("a"),
    "Filer ID": filer("b"),
    "Filer Name": "Example Campaign",
    "First Name": "Alex",
    "Last Name": "Example",
    "Filer Office": "Senator",
    "Filer District": "14",
    "Filer County": "Example County",
    "Transaction Type": "contribution - monetary",
    "Transaction Date": "2026-08-25",
    Amount: "$500.00",
    Election: "2026 General Election",
    Description: "Reported receipt",
    "Contact Type": "political_action_committee",
    "Contact Name": "Example Employee PAC",
    "Contact Street Address 1": "",
    "Contact Street Address 2": "",
    "Contact City": "",
    "Contact State": "",
    "Contact Zip": "",
    Occupation: "",
    "Occupation Other": "",
    "Employer Name": "",
    Purpose: "",
    "Expenditure Targets": "",
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

describe("Maine MapLight all-filer financial source facts", () => {
  it("retains source financial identities and roles without inventing authority", () => {
    const input = row({
      Purpose: "Source purpose",
      "Expenditure Targets": "Literal source target",
    });
    const parsed = parse(csv([input]))[0];
    expect(parsed).toEqual({
      occurrence: 1,
      transactionId: activity("a"),
      filerId: filer("b"),
      filerName: "Example Campaign",
      filerFirstName: "Alex",
      filerLastName: "Example",
      filerOffice: "Senator",
      filerDistrict: "14",
      filerCounty: "Example County",
      sourceRole: "contribution - monetary",
      transactionDate: "2026-08-25",
      amount: "$500.00",
      amountCents: 50000,
      election: "2026 General Election",
      description: "Reported receipt",
      counterpartyClass: "political_action_committee",
      counterpartyName: "Example Employee PAC",
      purpose: "Source purpose",
      expenditureTargets: "Literal source target",
    });
    for (const omitted of [
      "donorFilerId",
      "originalTransactionId",
      "version",
      "status",
      "current",
      "acceptedMoney",
    ]) {
      expect(parsed).not.toHaveProperty(omitted);
    }
  });

  it.each(ROLES)("preserves the literal source role %s", (sourceRole) => {
    expect(
      parse(csv([row({ "Transaction Type": sourceRole })]))[0].sourceRole,
    ).toBe(sourceRole);
  });

  it("does not negate returned amounts or treat returns as gifts", () => {
    const parsed = parse(
      csv([
        row({
          "Transaction Type": "returned - returned_expenditure",
          Amount: "$5,025.00",
        }),
      ]),
    )[0];
    expect(parsed.sourceRole).toBe("returned - returned_expenditure");
    expect(parsed.amountCents).toBe(502500);
    expect(parsed.expenditureTargets).toBe("");
    expect(parsed).not.toHaveProperty("originalTransactionId");
  });

  it("preserves explicit signed and zero source facts", () => {
    const parsed = parse(
      csv([
        row({ Amount: "-$5.00" }),
        row({ "Transaction ID": activity("c"), Amount: "$0.00" }),
        row({ "Transaction ID": activity("d"), Amount: "$-1.25" }),
      ]),
    );
    expect(parsed.map((item) => [item.occurrence, item.amountCents])).toEqual([
      [1, -500],
      [2, 0],
      [3, -125],
    ]);
  });

  it("parses the observed dollar-prefixed cents-only source amounts exactly", () => {
    expect(parse(csv([row({ Amount: "$.42" })]))[0]).toMatchObject({
      amount: "$.42",
      amountCents: 42,
    });
    expect(parse(csv([row({ Amount: "-$.42" })]))[0].amountCents).toBe(-42);
    expect(() => parse(csv([row({ Amount: ".42" })]))).toThrow(
      "invalid exact-cent amount",
    );
  });

  it("retains equal gifts with different source IDs and their full names", () => {
    const parsed = parse(
      csv([row(), row({ "Transaction ID": activity("c") })]),
    );
    expect(parsed).toHaveLength(2);
    expect(parsed.map((item) => item.occurrence)).toEqual([1, 2]);
    expect(
      parsed.every((item) => item.counterpartyName === "Example Employee PAC"),
    ).toBe(true);
  });

  it("preserves blank and unknown counterparty class without promotion or invented name", () => {
    expect(
      parse(csv([row({ "Contact Type": "", "Contact Name": "" })]))[0],
    ).toMatchObject({ counterpartyClass: "", counterpartyName: "" });
    expect(
      parse(csv([row({ "Contact Type": "unreviewed_source_class" })]))[0]
        .counterpartyClass,
    ).toBe("unreviewed_source_class");
  });

  it("does not export any contact addresses, employer or occupation", () => {
    const privateMarker = "RESTRICTED_SYNTHETIC_FIELD";
    const input = row();
    for (const key of [
      "Contact Street Address 1",
      "Contact Street Address 2",
      "Contact City",
      "Contact State",
      "Contact Zip",
      "Occupation",
      "Occupation Other",
      "Employer Name",
    ] as const)
      input[key] = privateMarker;
    const parsed = parse(csv([input]))[0];
    expect(JSON.stringify(parsed)).not.toContain(privateMarker);
    expect(parsed).not.toHaveProperty("rawFields");
    expect(parsed).not.toHaveProperty("contactAddress");
  });

  it("keeps exact punctuation, quotes and multiline source identities", () => {
    const input = row({
      "Contact Name": 'Example "Workers", PAC',
      Description: "first\r\nsecond",
    });
    expect(parse(`\uFEFF${csv([input], "\r\n")}\r\n`)[0]).toMatchObject({
      counterpartyName: input["Contact Name"],
      description: input.Description,
    });
  });

  it("does not infer election year or target identities from source text", () => {
    const parsed = parse(
      csv([
        row({
          Election: "",
          "Expenditure Targets": "Alex Example; Casey Example",
        }),
      ]),
    )[0];
    expect(parsed.election).toBe("");
    expect(parsed.expenditureTargets).toBe("Alex Example; Casey Example");
    expect(parsed).not.toHaveProperty("electionYear");
    expect(parsed).not.toHaveProperty("candidateId");
  });

  it("allows header-only facts without a financial zero claim", () => {
    expect(parse(HEADERS.join(","))).toEqual([]);
  });

  it.each([
    ["missing", HEADERS.slice(1).join(",")],
    ["extra", `${HEADERS.join(",")},Additional`],
    ["reordered", [...HEADERS].reverse().join(",")],
    ["unspaced", HEADERS.join(",").replace("Transaction ID", "TransactionID")],
    ["HTML", "<html>Unavailable</html>"],
  ])("rejects %s headers", (_label, input) => {
    expect(() => parse(input)).toThrow("unexpected 25-column header");
  });

  it("rejects short, extra and blank records rather than silently dropping them", () => {
    const record = HEADERS.map((key) => quote(row()[key]));
    for (const cells of [record.slice(0, -1), [...record, "extra"]]) {
      expect(() => parse(`${HEADERS.join(",")}\n${cells.join(",")}`)).toThrow(
        "unexpected data-record width",
      );
    }
    expect(() => parse(`${HEADERS.join(",")}\n\n${record.join(",")}`)).toThrow(
      "unexpected data-record width",
    );
  });

  it.each(['bad"quote', '"open', '"closed"extra'])(
    "rejects malformed quotes",
    (bad) => {
      const cells = HEADERS.map((key) => quote(row()[key]));
      cells[12] = bad;
      expect(() => parse(`${HEADERS.join(",")}\n${cells.join(",")}`)).toThrow();
    },
  );

  it.each([
    "2026-02-29",
    "2026-09-31",
    "2026-00-01",
    "2026-13-01",
    "08/25/2026",
  ])("rejects invalid date %s", (date) => {
    expect(() => parse(csv([row({ "Transaction Date": date })]))).toThrow(
      "invalid transaction date",
    );
  });
  it("accepts a genuine leap day", () => {
    expect(
      parse(csv([row({ "Transaction Date": "2024-02-29" })]))[0]
        .transactionDate,
    ).toBe("2024-02-29");
  });

  it.each([
    "$5,02.50",
    "$500",
    "$500.001",
    "$.5",
    "$90071992547410.00",
    "NaN",
    "1e2",
  ])("rejects non-exact amount %s", (amount) => {
    expect(() => parse(csv([row({ Amount: amount })]))).toThrow(
      /invalid exact-cent amount|range/,
    );
  });

  it("rejects exact and conflicting duplicate transaction IDs", () => {
    expect(() => parse(csv([row(), row()]))).toThrow(
      "duplicate transaction ID",
    );
    expect(() => parse(csv([row(), row({ Amount: "$501.00" })]))).toThrow(
      "duplicate transaction ID",
    );
  });

  it("rejects missing or incompatible source identity namespaces", () => {
    for (const field of ["Transaction ID", "Filer ID"] as const)
      expect(() => parse(csv([row({ [field]: "" })]))).toThrow(
        "invalid source ID",
      );
    expect(() => parse(csv([row({ "Transaction ID": filer("a") })]))).toThrow(
      "invalid source ID",
    );
    expect(() => parse(csv([row({ "Filer ID": activity("b") })]))).toThrow(
      "invalid source ID",
    );
    expect(() => parse(csv([row({ "Filer Name": " " })]))).toThrow(
      "missing source identity text",
    );
  });

  it("rejects conflicting full filer identity for one source ID", () => {
    for (const field of [
      "Filer Name",
      "First Name",
      "Last Name",
      "Filer Office",
      "Filer District",
      "Filer County",
    ] as const) {
      expect(() =>
        parse(
          csv([
            row(),
            row({ "Transaction ID": activity("c"), [field]: "changed" }),
          ]),
        ),
      ).toThrow("conflicting filer identity");
    }
  });

  it("rejects unsupported source role drift without guessing mechanism", () => {
    for (const role of [
      "contribution",
      "returned - independent_expenditure",
      "debt - repayment",
      "",
    ]) {
      expect(() => parse(csv([row({ "Transaction Type": role })]))).toThrow(
        "unsupported source role",
      );
    }
  });

  it("keeps all error messages static without rejected raw identities or contact fields", () => {
    const marker = "PRIVATE_REJECTED_SOURCE";
    try {
      parse(
        csv([
          row({ "Transaction ID": marker, "Contact Street Address 1": marker }),
        ]),
      );
      expect.fail("Invalid source identity must reject");
    } catch (error) {
      expect(String(error)).toContain("invalid source ID");
      expect(String(error)).not.toContain(marker);
    }
  });
});
