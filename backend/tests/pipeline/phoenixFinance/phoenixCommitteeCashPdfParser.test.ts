import { describe, expect, it } from "vitest";
import { parsePhoenixCommitteeCashReport } from "../../../src/pipeline/phoenixFinance/phoenixCommitteeCashPdfParser.js";
import type {
  PhoenixPdfLine,
  PhoenixPdfPage,
} from "../../../src/pipeline/phoenixFinance/phoenixReportPdfParser.js";

const line = (y: number, ...cells: [number, string][]): PhoenixPdfLine => ({
  y,
  cells: cells.map(([x, text]) => ({ x, text })),
  text: cells.map(([, text]) => text).join(" "),
});
const money = (cents: number) =>
  `${cents < 0 ? "(" : ""}$${(Math.abs(cents) / 100).toFixed(2)}${cents < 0 ? ")" : ""}`;
function summary(gifts = 150000, refunds = 10000): PhoenixPdfPage {
  return {
    pageNumber: 2,
    lines: [
      line(739, [495, "CAN-25-4"]),
      line(710, [28, "SUMMARY OF RECEIPTS (Schedule A)"]),
      line(592, [67, "(e) Political Action Committees"], [415, money(gifts)]),
      line(
        503,
        [67, "(l) Refunds Given Back to Contributors"],
        [417, money(refunds)],
      ),
      line(311, [67, "(e) Political Action Committees"], [506, "$999.00"]),
    ],
  };
}
function schedule(
  kind: "e" | "l",
  rows: { name: string; cents: number; date?: string }[],
  pageNumber = kind === "e" ? 43 : 45,
  ordinal = 1,
  count = 1,
  total = rows.reduce((sum, row) => sum + row.cents, 0),
): PhoenixPdfPage {
  const lines = [
    line(739, [495, "CAN-25-4"]),
    line(704, [
      28,
      kind === "e"
        ? "MONETARY CONTRIBUTIONS FROM POLITICAL ACTION COMMITTEES: SCHEDULE A(1)(e)"
        : "REFUNDS GIVEN BACK TO CONTRIBUTORS: SCHEDULE A(1)(l)",
    ]),
  ];
  rows.forEach((row, i) => {
    const y = 631 - i * 104;
    lines.push(
      line(
        y,
        [
          58,
          kind === "e" ? "Committee Name" : "Name Date Contribution Refunded",
        ],
        [371, money(row.cents)],
        [441, "$7000.00"],
        [510, "$9000.00"],
      ),
    );
    lines.push(
      kind === "e"
        ? line(y - 12, [58, row.name])
        : line(y - 12, [58, row.name], [259, row.date ?? "04/14/2026"]),
    );
    lines.push(line(y - 26, [58, "Street Address"]));
    // Sanitized fixtures deliberately contain no address values.
    lines.push(
      line(y - 76, [
        58,
        kind === "e"
          ? "Committee ID Number Date Contribution Received"
          : "ID Number (if applicable) Date of Original Contribution",
      ]),
    );
    lines.push(
      line(y - 87, [
        kind === "e" ? 186 : 258,
        kind === "e" ? (row.date ?? "04/30/2026") : "03/26/2026",
      ]),
    );
  });
  lines.push(
    ordinal === count
      ? line(
          620 - rows.length * 104,
          [61, "Enter total only if last page of schedule"],
          [441, money(total)],
          [510, "$9900.00"],
        )
      : line(620 - rows.length * 104, [
          61,
          "Enter total only if last page of schedule",
        ]),
  );
  lines.push(
    line(35, [250, `SCHEDULE A(1)(${kind}), page ${ordinal} of ${count}`]),
  );
  return { pageNumber, lines };
}
const fixture = () => [
  summary(),
  schedule("e", [
    { name: "Example PAC", cents: 100000 },
    { name: "Second PAC", cents: 50000 },
  ]),
  schedule("l", [{ name: "Unclassified reported contributor", cents: 10000 }]),
];
const cell = (pages: PhoenixPdfPage[], page: number, row: number, x: number) =>
  pages
    .find((p) => p.pageNumber === page)!
    .lines[row]!.cells.find((c) => c.x === x)!;
function refresh(pages: PhoenixPdfPage[]) {
  for (const page of pages)
    for (const row of page.lines)
      row.text = row.cells.map((c) => c.text).join(" ");
  return pages;
}

describe("Phoenix source-only committee cash positioned parser", () => {
  it("binds literal roles, header COPID, current amounts and raw civil dates independently of cumulative/equity amounts", () => {
    const result = parsePhoenixCommitteeCashReport(fixture());
    expect(result).toMatchObject({
      receivingCopId: "CAN-25-4",
      controls: { pacCashCents: 150000, returnedCashCents: 10000 },
      pacGifts: [
        {
          role: "pac_gift",
          schedule: "A1e",
          pageNumber: 43,
          rowOrdinal: 1,
          rawName: "Example PAC",
          rawDate: "04/30/2026",
          amountCents: 100000,
        },
        { amountCents: 50000, rowOrdinal: 2 },
      ],
      returns: [
        {
          role: "returned_contribution",
          rawDate: "04/14/2026",
          rawName: "Unclassified reported contributor",
          amountCents: 10000,
        },
      ],
    });
    expect(result.returns[0]).not.toHaveProperty("committeeType");
  });
  it.each(["CAN-07-01", "CAN-09-06", "PAC-04-01"])(
    "retains the exact published zero-padded receiving COPID %s",
    (copId) => {
      const pages = fixture();
      for (const page of pages) page.lines[0]!.cells[0]!.text = copId;
      expect(
        parsePhoenixCommitteeCashReport(refresh(pages)).receivingCopId,
      ).toBe(copId);
    },
  );
  it.each(["CAN-07-0", "CAN-07-00", "PAC-04-000", "CAN-07-01x", "CAN-7-01"])(
    "rejects malformed or zero receiving COPID %s",
    (copId) => {
      const pages = fixture();
      for (const page of pages) page.lines[0]!.cells[0]!.text = copId;
      expect(() => parsePhoenixCommitteeCashReport(refresh(pages))).toThrow(
        /COPID/,
      );
    },
  );
  it("retains identical gifts as separate physical occurrences", () => {
    const rows = [
      { name: "Example PAC", cents: 10000 },
      { name: "Example PAC", cents: 10000 },
    ];
    expect(
      parsePhoenixCommitteeCashReport([
        summary(20000, 0),
        schedule("e", rows),
      ]).pacGifts.map((row) => row.rowOrdinal),
    ).toEqual([1, 2]);
  });
  it("closes multipage schedules and excludes footer cumulative totals", () => {
    const result = parsePhoenixCommitteeCashReport([
      summary(20000, 0),
      schedule("e", [{ name: "Same PAC", cents: 10000 }], 43, 1, 2),
      schedule("e", [{ name: "Same PAC", cents: 10000 }], 44, 2, 2, 20000),
    ]);
    expect(
      result.pacGifts.map((row) => [row.pageNumber, row.amountCents]),
    ).toEqual([
      [43, 10000],
      [44, 10000],
    ]);
  });
  it("preserves wrapped source name words before the Street Address boundary", () => {
    const pages = fixture();
    pages[1]!.lines.splice(4, 0, line(613, [58, "Committee Chapter 4"]));
    expect(parsePhoenixCommitteeCashReport(pages).pacGifts[0]!.rawName).toBe(
      "Example PAC Committee Chapter 4",
    );
  });
  it("retains balanced parenthesized signs as source facts without inferring reversal economics", () => {
    const result = parsePhoenixCommitteeCashReport([
      summary(-10000, 0),
      schedule("e", [{ name: "Example PAC", cents: -10000 }]),
    ]);
    expect(result.pacGifts[0]!.amountCents).toBe(-10000);
  });
  it("can report explicit zero controls without inventing a no-activity/currentness marker", () => {
    expect(parsePhoenixCommitteeCashReport([summary(0, 0)])).toEqual({
      receivingCopId: "CAN-25-4",
      pacGifts: [],
      returns: [],
      controls: { pacCashCents: 0, returnedCashCents: 0 },
    });
  });
  it.each([
    "$1,00.00",
    "($1000.00",
    "$1000.00)",
    "$01.00",
    "$1000.001",
    "$90071992547409.92",
  ])("rejects malformed or unsafe source amount %s", (value) => {
    const pages = fixture();
    cell(pages, 43, 2, 371).text = value;
    expect(() => parsePhoenixCommitteeCashReport(refresh(pages))).toThrow();
  });
  it.each([
    "02/29/2025",
    "04/31/2026",
    "13/01/2026",
    "4/30/2026",
    "00/01/2026",
  ])("rejects invalid raw civil date %s", (value) => {
    const pages = fixture();
    cell(pages, 43, 6, 186).text = value;
    expect(() => parsePhoenixCommitteeCashReport(refresh(pages))).toThrow(
      /date/,
    );
  });
  it("accepts a real leap-day civil date without retiming", () => {
    expect(
      parsePhoenixCommitteeCashReport([
        summary(10000, 0),
        schedule("e", [
          { name: "Example PAC", cents: 10000, date: "02/29/2024" },
        ]),
      ]).pacGifts[0]!.rawDate,
    ).toBe("02/29/2024");
  });
  it.each([
    "missing PAC page",
    "missing return page",
    "missing cash control",
    "duplicate cash control",
    "wrong receiving ID",
    "missing receiving ID",
    "missing footer",
    "incomplete pagination",
    "shifted current column",
    "hidden lower money",
    "missing name boundary",
    "missing name",
    "missing receipt date label",
    "in-kind heading",
    "control mismatch",
    "duplicate physical page",
  ])("refuses %s", (mutation) => {
    const pages = fixture();
    const gift = pages[1]!;
    switch (mutation) {
      case "missing PAC page":
        pages.splice(1, 1);
        break;
      case "missing return page":
        pages.pop();
        break;
      case "missing cash control":
        pages[0]!.lines.splice(2, 1);
        break;
      case "duplicate cash control":
        pages[0]!.lines.push(structuredClone(pages[0]!.lines[2]!));
        break;
      case "wrong receiving ID":
        gift.lines[0]!.cells[0]!.text = "CAN-25-5";
        break;
      case "missing receiving ID":
        gift.lines.shift();
        break;
      case "missing footer":
        gift.lines.pop();
        break;
      case "incomplete pagination":
        gift.lines.at(-1)!.cells[0]!.text = "SCHEDULE A(1)(e), page 1 of 2";
        break;
      case "shifted current column":
        cell(pages, 43, 2, 371).x = 425;
        break;
      case "hidden lower money":
        gift.lines.splice(4, 0, line(611, [441, "$0.00"]));
        break;
      case "missing name boundary":
        gift.lines[4]!.cells[0]!.text = "Unrecognized field";
        break;
      case "missing name":
        gift.lines[3]!.cells = [];
        break;
      case "missing receipt date label":
        gift.lines[5]!.cells[0]!.text = "Unknown date field";
        break;
      case "in-kind heading":
        gift.lines[1]!.cells[0]!.text =
          "IN-KIND CONTRIBUTIONS FROM POLITICAL ACTION COMMITTEES: SCHEDULE A(1)(e)";
        break;
      case "control mismatch":
        cell(pages, 2, 2, 415).text = "$1501.00";
        break;
      case "duplicate physical page":
        pages.push(structuredClone(gift));
        break;
    }
    expect(() => parsePhoenixCommitteeCashReport(refresh(pages))).toThrow();
  });
  it("refuses a same-baseline fourth financial occurrence instead of silently ignoring it", () => {
    const pages = fixture();
    pages[1]!.lines[2]!.cells.push({ x: 550, text: "$0.00" });
    expect(() => parsePhoenixCommitteeCashReport(refresh(pages))).toThrow(
      /columns/,
    );
  });
  it("rejects a schedule-footer page whose financial heading is missing", () => {
    const pages = fixture();
    const extra = schedule("e", [{ name: "Unparsed PAC", cents: 10000 }], 44);
    extra.lines.splice(1, 1);
    expect(() => parsePhoenixCommitteeCashReport([...pages, extra])).toThrow(
      /heading/,
    );
  });
  it("rejects unsupported plain numbers in the financial columns", () => {
    const pages = fixture();
    pages[1]!.lines.splice(4, 0, line(611, [441, "100.00"]));
    expect(() => parsePhoenixCommitteeCashReport(pages)).toThrow(/unparsed/);
  });
  it("ignores explicitly different candidate/party/in-kind schedule classes", () => {
    const irrelevant = schedule(
      "e",
      [{ name: "Not a cash PAC", cents: 99999 }],
      50,
    );
    irrelevant.lines[1]!.cells[0]!.text =
      "IN-KIND CONTRIBUTIONS FROM POLITICAL ACTION COMMITTEES: SCHEDULE A(5)(e)";
    irrelevant.lines.at(-1)!.cells[0]!.text = "SCHEDULE A(5)(e), page 1 of 1";
    expect(
      parsePhoenixCommitteeCashReport(refresh([...fixture(), irrelevant]))
        .pacGifts,
    ).toHaveLength(2);
  });
});
