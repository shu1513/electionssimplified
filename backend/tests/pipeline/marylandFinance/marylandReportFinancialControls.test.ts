import { describe, expect, it } from "vitest";
import { parseMarylandModernFinancialControls } from "../../../src/pipeline/marylandFinance/marylandReportFinancialControls";
import type {
  MarylandPdfCell,
  MarylandPdfPage,
} from "../../../src/pipeline/marylandFinance/marylandReportPdfGeometry";

const labels = [
  "Contributions (Total from Section 1)",
  "Anonymous Contributions * Number of Transactions: 3",
  "Returned Contributions (Total from Section 2)",
  "Total Contributions",
  "Expenditures (Total from Section 3)",
  "Loan Payments",
  "Outstanding Obligations Payments",
  "Returned Expenditures (Total from Section 4)",
  "Total Expenditures",
  "Outstanding Balance from Previous Reporting Period",
  "Loans Received During this Reporting Period (Total from Section 5)",
  "Outstanding Obligations Received During this Reporting Period (Total from Section 6)",
  "Subtotal",
  "Loan Payments Made During this Reporting Period (Total from Section 5)",
  "Loan Amount Forgiven During this Reporting Period (Total from Section 5)",
  "Outstanding Obligations Payments Made During this Reporting Period (Total from Section 6)",
  "Outstanding Obligations Forgiven During this Reporting Period (Total from Section 6)",
  "Total Loan and Outstanding Obligation Amount Due at the End of This Reporting Period",
  "In-Kind Contributions (Total from Section 1)",
  "Coordinated In-Kind Contributions (Total from Section 1)",
  "Returned In-Kind Contributions (Total from Section 2)",
  "Returned Coordinated In-Kind Contributions (Total from Section 2)",
  "Total In-Kind Contributions",
  "In-Kind Expenditures (Total from Section 3)",
  "Returned In-Kind Expenditures (Total from Section 4)",
  "Total In-Kind Expenditures",
];
const ys = [
  130.46, 150.46, 170.46, 190.46, 250.46, 270.46, 290.46, 310.46, 330.46,
  380.46, 400.46, 420.46, 440.46, 460.46, 480.46, 500.46, 520.46, 542.46,
  594.46, 614.46, 634.46, 654.46, 674.46, 694.46, 714.46, 734.46,
];
const ops = [
  "+",
  "+",
  "-",
  "=",
  "+",
  "+",
  "+",
  "-",
  "=",
  "+",
  "+",
  "+",
  "=",
  "-",
  "-",
  "-",
  "-",
  "=",
  "+",
  "+",
  "-",
  "-",
  "=",
  "+",
  "-",
  "=",
];
const amounts = [
  10000, 125, 250, 9875, 2000, 100, 50, 25, 2125, 700, 3000, 200, 3900, 100,
  200, 50, 25, 3525, 500, 50, 25, 10, 515, 400, 50, 350,
];
function money(cents: number) {
  return `$${cents < 0 ? "-" : ""}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
}
const cell = (
  text: string,
  left: number,
  right: number,
  y: number,
): MarylandPdfCell => ({ text, left, right, baselineTop: y, height: 10 });
function fixture(): MarylandPdfPage {
  const cells: MarylandPdfCell[] = [],
    borders: MarylandPdfPage["borders"][number][] = [];
  for (let i = 0; i < 26; i++) {
    const y = ys[i]!,
      top = y - 15.46,
      bottom = i === 17 ? 551 : y + 4.54;
    cells.push(
      cell(String(i + 1), 24, 35, y),
      cell(ops[i]!, 472.08, 477.92, y),
      cell(money(amounts[i]!), 525, 570, y),
    );
    if (i === 17)
      cells.push(
        cell(
          "Total Loan and Outstanding Obligation Amount Due at the End of This Reporting",
          59,
          442.92,
          536.64,
        ),
        cell("Period", 59, 90.12, 548.28),
      );
    else cells.push(cell(labels[i]!, 59, 59 + labels[i]!.length * 4, y));
    for (const [left, right] of [
      [20, 55],
      [55, 460],
      [460, 490],
      [490, 574],
    ]) {
      borders.push(
        { x1: left!, x2: right!, y1: top, y2: top },
        { x1: left!, x2: right!, y1: bottom, y2: bottom },
      );
    }
    borders.push(
      ...[20, 55, 460, 490, 574].map((x) => ({
        x1: x,
        x2: x,
        y1: top,
        y2: bottom,
      })),
    );
  }
  return { pageNumber: 3, width: 595, height: 853, cells, borders };
}
function mutate(
  page: MarylandPdfPage,
  number: number,
  column: "label" | "money" | "operator",
  text: string,
) {
  const left = column === "label" ? 59 : column === "operator" ? 472.08 : 525;
  page.cells = page.cells.map((c) =>
    c.left === left && Math.abs(c.baselineTop - ys[number - 1]!) < 0.01
      ? { ...c, text }
      : c,
  );
}

describe("Maryland modern printed financial controls", () => {
  it("retains all26 source controls, anonymous count and real nonzero loan/obligation facts", () => {
    const result = parseMarylandModernFinancialControls(fixture());
    expect(result.controls).toHaveLength(26);
    expect(result.anonymousTransactionCount).toBe(3);
    expect(result.controls[10]!.amountCents).toBe(3000);
    expect(result.controls[17]).toEqual({
      number: 18,
      printedLabel: labels[17],
      printedOperator: "=",
      amountCents: 3525,
    });
    expect(Object.values(result.equations)).toEqual(Array(6).fill(true));
    expect(result).not.toHaveProperty("current");
    expect(result).not.toHaveProperty("qualified");
  });
  it("assembles exact split labels without treating split text as another control", () => {
    const p = fixture();
    const original = p.cells.find(
      (c) => c.left === 59 && c.baselineTop === ys[0],
    )!;
    p.cells = p.cells.filter((c) => c !== original);
    p.cells = [
      ...p.cells,
      cell("Contributions", 59, 115, ys[0]!),
      cell("(Total from Section 1)", 120, 215, ys[0]! - 0.01),
    ];
    expect(
      parseMarylandModernFinancialControls(p).controls[0]!.printedLabel,
    ).toBe(labels[0]);
  });
  it("retains signed printed net controls when refunds exceed cash receipts", () => {
    const p = fixture();
    mutate(p, 1, "money", "$0.50");
    mutate(p, 2, "money", "$0.00");
    mutate(p, 3, "money", "$1.00");
    mutate(p, 4, "money", "$-0.50");
    expect(
      parseMarylandModernFinancialControls(p).controls[3]!.amountCents,
    ).toBe(-50);
  });
  it("rejects missing and duplicate ordinals", () => {
    const missing = fixture();
    missing.cells = missing.cells.filter(
      (c) => !(c.left === 24 && c.baselineTop === ys[0]),
    );
    expect(() => parseMarylandModernFinancialControls(missing)).toThrow(
      "ordinal",
    );
    const duplicate = fixture();
    duplicate.cells = [...duplicate.cells, cell("1", 24, 35, ys[0]!)];
    expect(() => parseMarylandModernFinancialControls(duplicate)).toThrow(
      "ordinal",
    );
  });
  it("rejects a complete additional ruled control27 rather than ignoring it", () => {
    const p = fixture();
    const y = 754.46,
      top = y - 15.46,
      bottom = y + 4.54;
    p.cells = [
      ...p.cells,
      cell("27", 24, 35, y),
      cell("Unexpected control", 59, 150, y),
      cell("=", 472.08, 477.92, y),
      cell("$0.00", 525, 570, y),
    ];
    for (const [left, right] of [
      [20, 55],
      [55, 460],
      [460, 490],
      [490, 574],
    ]) {
      p.borders = [
        ...p.borders,
        { x1: left!, x2: right!, y1: top, y2: top },
        { x1: left!, x2: right!, y1: bottom, y2: bottom },
      ];
    }
    p.borders = [
      ...p.borders,
      ...[20, 55, 460, 490, 574].map((x) => ({
        x1: x,
        x2: x,
        y1: top,
        y2: bottom,
      })),
    ];
    expect(() => parseMarylandModernFinancialControls(p)).toThrow("ordinal");
  });
  it.each(["0", "27", "01", "1.0", "+1"])(
    "rejects noncanonical printed ordinal %s",
    (text) => {
      const p = fixture();
      p.cells = p.cells.map((c) =>
        c.left === 24 && c.baselineTop === ys[0] ? { ...c, text } : c,
      );
      expect(() => parseMarylandModernFinancialControls(p)).toThrow("ordinal");
    },
  );
  it("rejects changed label or operator despite unchanged control money", () => {
    const p = fixture();
    mutate(p, 1, "label", labels[2]!);
    expect(() => parseMarylandModernFinancialControls(p)).toThrow("label");
    const q = fixture();
    mutate(q, 3, "operator", "+");
    expect(() => parseMarylandModernFinancialControls(q)).toThrow("operator");
  });
  it("requires control18 exact wrapped caption and correctly bordered cells", () => {
    const p = fixture();
    p.cells = [...p.cells, cell("Invented ending balance", 59, 180, ys[17]!)];
    expect(() => parseMarylandModernFinancialControls(p)).toThrow("label");
    const q = fixture();
    q.borders = q.borders.filter(
      (b) => !(b.x1 === 490 && b.x2 === 490 && b.y1 === 527),
    );
    expect(() => parseMarylandModernFinancialControls(q)).toThrow("border");
    const blank = fixture();
    blank.cells = blank.cells.filter(
      (c) => !(c.left === 59 && [536.64, 548.28].includes(c.baselineTop)),
    );
    expect(() => parseMarylandModernFinancialControls(blank)).toThrow("label");
  });
  it("rejects unpainted cells and column-crossing or duplicate currency", () => {
    const p = fixture();
    p.borders = [];
    expect(() => parseMarylandModernFinancialControls(p)).toThrow("border");
    const q = fixture();
    q.cells = q.cells.map((c) =>
      c.left === 525 && c.baselineTop === ys[0] ? { ...c, left: 480 } : c,
    );
    expect(() => parseMarylandModernFinancialControls(q)).toThrow("geometry");
    const r = fixture();
    r.cells = [...r.cells, cell("$0.00", 535, 570, ys[0]!)];
    expect(() => parseMarylandModernFinancialControls(r)).toThrow("currency");
  });
  it("requires label horizontal edges even when the amount rectangle and verticals remain", () => {
    const p = fixture();
    p.borders = p.borders.filter(
      (b) =>
        !(
          b.x1 === 55 &&
          b.x2 === 460 &&
          (Math.abs(b.y1 - 115) < 0.01 || Math.abs(b.y1 - 135) < 0.01)
        ),
    );
    expect(() => parseMarylandModernFinancialControls(p)).toThrow("border");
  });
  it("accepts overlapping full-table painted segments that cover all four cell intervals", () => {
    const p = fixture();
    p.borders = p.borders.filter((b) => b.x1 === b.x2);
    for (let i = 0; i < 26; i++) {
      const top = ys[i]! - 15.46,
        bottom = i === 17 ? 551 : ys[i]! + 4.54;
      for (const y of [top, bottom])
        p.borders = [
          ...p.borders,
          { x1: 20, x2: 300, y1: y, y2: y },
          { x1: 299, x2: 574, y1: y, y2: y },
        ];
    }
    expect(parseMarylandModernFinancialControls(p).controls).toHaveLength(26);
  });
  it("rejects malformed/unsafe money without echoing the source value", () => {
    for (const text of [
      "PRIVATE_BAD_CURRENCY",
      "$1,00.00",
      "$90071992547410.00",
    ]) {
      const p = fixture();
      mutate(p, 1, "money", text);
      expect(() => parseMarylandModernFinancialControls(p)).toThrow(
        "Maryland report controls: currency",
      );
      try {
        parseMarylandModernFinancialControls(p);
      } catch (e) {
        expect(String(e)).not.toContain(text);
      }
    }
  });
  it.each([4, 9, 13, 18, 23, 26])(
    "rejects printed equation mismatch at control%d",
    (number) => {
      const p = fixture();
      mutate(p, number, "money", money(amounts[number - 1]! + 1));
      expect(() => parseMarylandModernFinancialControls(p)).toThrow(
        "arithmetic",
      );
    },
  );
  it("rejects malformed anonymous count and page/geometry drift", () => {
    const p = fixture();
    mutate(
      p,
      2,
      "label",
      "Anonymous Contributions * Number of Transactions: unknown",
    );
    expect(() => parseMarylandModernFinancialControls(p)).toThrow("label");
    expect(() =>
      parseMarylandModernFinancialControls({
        ...fixture(),
        width: 612,
        height: 792,
      }),
    ).toThrow("geometry");
    expect(() =>
      parseMarylandModernFinancialControls({ ...fixture(), pageNumber: 2 }),
    ).toThrow("geometry");
  });
});
