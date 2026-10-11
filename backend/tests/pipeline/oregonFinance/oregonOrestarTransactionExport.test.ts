import { describe, expect, it } from "vitest";

import {
  isOregonOrestarExportWorkbook,
  parseOregonOrestarTransactionExport,
} from "../../../src/pipeline/oregonFinance/oregonOrestarTransactionExport.js";
import { buildOregonOrestarExportWorkbook } from "./orestarExportFixture.js";

describe("oregonOrestarTransactionExport", () => {
  it("maps export rows onto transaction details, normalizing mixed cell types", () => {
    const data = buildOregonOrestarExportWorkbook([
      {
        "Tran Id": "5699168",
        "Tran Date": "06/22/2026",
        "Tran Status": "Original",
        Filer: "Friends of Andrea Valderrama",
        "Contributor/Payee": "Union Pacific Railroad",
        "Sub Type": "Cash Contribution",
        Amount: 500,
        "Aggregate Amount": 500,
        "Filer Id": "18462",
        "Filed Date": "06/24/2026",
        "Book Type": "Business Entity",
      },
      {
        // Numeric Tran Id / Filer Id cells and a $-formatted amount string
        // must normalize the same way as their text/number counterparts.
        "Tran Id": 5699169,
        "Tran Date": "03/05/2025",
        Filer: "Friends of Andrea Valderrama",
        "Contributor/Payee": "Jane Donor",
        "Sub Type": "Cash Contribution",
        Amount: "$1,250.00",
        "Filer Id": 18462,
        "Occptn Txt": "Teacher",
        "Emp Name": "Portland Public Schools",
      },
    ]);

    const details = parseOregonOrestarTransactionExport({
      data,
      transactionType: "Contribution",
      sourceUrl: "https://secure.sos.state.or.us/orestar/gotoPublicTransactionSearch.do",
    });

    expect(details).toHaveLength(2);
    expect(details[0]).toMatchObject({
      transactionId: "5699168",
      transactionDate: "06/22/2026",
      transactionType: "Contribution",
      transactionSubType: "Cash Contribution",
      filedDate: "06/24/2026",
      amount: 500,
      aggregate: 500,
      processStatus: "Original",
      filerCommitteeName: "Friends of Andrea Valderrama",
      filerCommitteeId: "18462",
      addressBookType: "Business Entity",
      contributorPayeeName: "Union Pacific Railroad",
      occupation: null,
      employerName: null,
      outsideAssociations: [],
      sourceUrl: "https://secure.sos.state.or.us/orestar/gotoPublicTransactionSearch.do",
    });
    expect(details[1]).toMatchObject({
      transactionId: "5699169",
      amount: 1_250,
      filerCommitteeId: "18462",
      occupation: "Teacher",
      employerName: "Portland Public Schools",
    });
  });

  it("reads the .xlsx workbook ORESTAR serves since Oct 2026", () => {
    const data = buildOregonOrestarExportWorkbook(
      [
        {
          "Tran Id": "5699168",
          "Tran Date": "06/22/2026",
          Filer: "Friends of Andrea Valderrama",
          "Contributor/Payee": "Union Pacific Railroad",
          "Sub Type": "Cash Contribution",
          Amount: 500,
          "Filer Id": "18462",
        },
      ],
      undefined,
      "xlsx"
    );

    expect(isOregonOrestarExportWorkbook(data)).toBe(true);
    expect(parseOregonOrestarTransactionExport({ data, expectedCommitteeId: "18462" })).toMatchObject([
      { transactionId: "5699168", amount: 500, filerCommitteeId: "18462" },
    ]);
  });

  it("returns an empty list for a workbook with only a header row", () => {
    expect(parseOregonOrestarTransactionExport({ data: buildOregonOrestarExportWorkbook([]) })).toEqual([]);
  });

  it("rejects workbooks missing required columns", () => {
    const data = buildOregonOrestarExportWorkbook(
      [{ "Tran Id": "1", "Tran Date": "01/01/2026" }],
      ["Tran Id", "Tran Date", "Filer"]
    );
    expect(() => parseOregonOrestarTransactionExport({ data })).toThrow(
      "ORESTAR export is missing required columns: Filer Id, Contributor/Payee, Sub Type, Amount"
    );
  });

  it("rejects rows the aggregator would silently drop, naming the spreadsheet row", () => {
    const usableRow = {
      "Tran Id": "5500001",
      "Tran Date": "10/12/2025",
      Filer: "Friends of Tina Kotek",
      "Contributor/Payee": "Jane Donor",
      "Sub Type": "Cash Contribution",
      Amount: 100,
      "Filer Id": "4792",
    } as const;

    const cases: { overrides: Record<string, string | number>; expected: string }[] = [
      { overrides: { "Tran Id": "" }, expected: "row 3 is unusable (missing Tran Id)" },
      { overrides: { "Filer Id": "" }, expected: "row 3 is unusable (missing Filer Id)" },
      {
        // A date exported as a raw Excel serial is non-blank but yields no
        // year, so the aggregator's cycle check would drop it.
        overrides: { "Tran Date": 45942 },
        expected: 'row 3 is unusable (unparseable Tran Date "45942")',
      },
      { overrides: { "Tran Date": "" }, expected: 'row 3 is unusable (unparseable Tran Date null)' },
      { overrides: { Amount: "n/a" }, expected: "row 3 is unusable (unparseable Amount null)" },
      // Number("") / Number("   ") / Number("$") are all 0, so these would
      // otherwise masquerade as a genuine $0 row and pass the guard.
      { overrides: { Amount: "" }, expected: "row 3 is unusable (unparseable Amount null)" },
      { overrides: { Amount: "   " }, expected: "row 3 is unusable (unparseable Amount null)" },
      { overrides: { Amount: "$" }, expected: "row 3 is unusable (unparseable Amount null)" },
      { overrides: { Amount: "," }, expected: "row 3 is unusable (unparseable Amount null)" },
    ];

    for (const { overrides, expected } of cases) {
      const data = buildOregonOrestarExportWorkbook([usableRow, { ...usableRow, ...overrides }]);
      expect(() => parseOregonOrestarTransactionExport({ data })).toThrow(expected);
    }
  });

  it("rejects rows filed by a different committee than the one searched", () => {
    const data = buildOregonOrestarExportWorkbook([
      {
        "Tran Id": "5500001",
        "Tran Date": "10/12/2025",
        Filer: "Some Other Committee",
        "Contributor/Payee": "Jane Donor",
        "Sub Type": "Cash Contribution",
        Amount: 100,
        "Filer Id": "9999",
      },
    ]);

    expect(() => parseOregonOrestarTransactionExport({ data, expectedCommitteeId: "4792" })).toThrow(
      "Filer Id 9999 does not match requested committee 4792"
    );
    // Without an expected committee the parser stays usable for arbitrary exports.
    expect(parseOregonOrestarTransactionExport({ data })).toHaveLength(1);
  });

  it("keeps refunds and non-positive amounts, which the aggregator excludes by business rule", () => {
    const data = buildOregonOrestarExportWorkbook([
      {
        "Tran Id": "5500001",
        "Tran Date": "10/12/2025",
        Filer: "Friends of Tina Kotek",
        "Contributor/Payee": "Jane Donor",
        "Sub Type": "Refunds and Rebates",
        Amount: -50,
        "Filer Id": "4792",
      },
      {
        "Tran Id": "5500002",
        "Tran Date": "10/13/2025",
        Filer: "Friends of Tina Kotek",
        "Contributor/Payee": "Sam Giver",
        "Sub Type": "Cash Contribution",
        Amount: 0,
        "Filer Id": "4792",
      },
    ]);

    // These are real rows, not corruption — throwing on them would break
    // legitimate syncs and break the row-count completeness check.
    expect(parseOregonOrestarTransactionExport({ data, expectedCommitteeId: "4792" })).toMatchObject([
      { transactionId: "5500001", amount: -50, transactionSubType: "Refunds and Rebates" },
      { transactionId: "5500002", amount: 0 },
    ]);
  });

  it("keeps a zero written as text, which is a known amount rather than a blank cell", () => {
    // The guard must separate "genuinely zero" from "we could not read it";
    // both reach the aggregator as 0, so only the parser can tell them apart.
    const data = buildOregonOrestarExportWorkbook([
      {
        "Tran Id": "5500003",
        "Tran Date": "10/14/2025",
        Filer: "Friends of Tina Kotek",
        "Contributor/Payee": "Pat Payer",
        "Sub Type": "Cash Contribution",
        Amount: "$0.00",
        "Filer Id": "4792",
      },
    ]);

    expect(parseOregonOrestarTransactionExport({ data, expectedCommitteeId: "4792" })).toMatchObject([
      { transactionId: "5500003", amount: 0 },
    ]);
  });

  it("rejects bytes that are not an .xls workbook (blocked-page HTML)", () => {
    const html = new TextEncoder().encode("<html><body>blocked</body></html>");
    expect(isOregonOrestarExportWorkbook(html)).toBe(false);
    expect(() => parseOregonOrestarTransactionExport({ data: html })).toThrow(
      "ORESTAR export response is not an .xls workbook"
    );
  });
});
