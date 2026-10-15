import { describe, expect, it } from "vitest";
import { parseMarylandLegacyFinancialControls } from "../../../src/pipeline/marylandFinance/marylandLegacyReportFinancialControls";
import type {
  MarylandPdfCell,
  MarylandPdfPage,
} from "../../../src/pipeline/marylandFinance/marylandReportPdfGeometry";
const receipts = [
  "Contributions – Schd 1, Col A",
  "Ticket Purchases – Schd 1, Col B",
  "Federal Committees – Schd 1, Col C",
  "Political Clubs – Schd 1, Col D",
  "MD Candidate and Slate Accounts – Schd 1A, Col E",
  "MD Party Central Committees – Schd 1A, Col F",
  "MD Political Action Committees – Schd 1A, Col G",
  "Non-Federal Out-of-State Committees – Schd 1A, Col H",
  "Other – Schd 1B, Col I",
  "Loans – Schd 3, Col K",
];
const expenses = [
  "Salaries & Other Compensation – Schd 2, Col N",
  "Rent & Other Office Expenses – Schd 2, Col O",
  "Field Expenses – Schd 2, Col P",
  "Media – Schd 2, Col Q",
  "Printing & Campaign Materials – Schd 2, Col R",
  "Direct Mailing by Mail House – Schd 2, Col S",
  "Postage – Schd 2, Col T",
  "Purchase of Equipment – Schd 2, Col U",
  "Fundraising Expenses – Schd 2, Col V",
  "Transfers Out – Schd 2, Col W",
  "Loan Repayment – Schd 2, Col X",
  "Other – Schd 2, Col Y",
  "Returned Contribution – Schd 2, Col Z",
];
const receiptY = [
  340.455, 354.456, 368.706, 383.706, 397.714, 421.73, 436.73, 451.73, 475.746,
  489.996, 504.746,
];
const expenseY = [
  340.455, 355.205, 369.455, 383.706, 398.705, 413.705, 427.955, 442.206,
  457.205, 472.205, 487.205, 501.455, 517.205, 531.955,
];
const cell = (
  text: string,
  left: number,
  right: number,
  baselineTop: number,
): MarylandPdfCell => ({ text, left, right, baselineTop, height: 9 });
const money = (n: number) =>
  `$${n < 0 ? "-" : ""}${Math.floor(Math.abs(n) / 100)}.${String(Math.abs(n) % 100).padStart(2, "0")}`;
type MutablePage = Omit<MarylandPdfPage, "cells" | "borders"> & {
  cells: MarylandPdfCell[];
  borders: MarylandPdfPage["borders"][number][];
};
function rectangle(
  p: MutablePage,
  left: number,
  right: number,
  top: number,
  bottom: number,
  openTop = false,
) {
  p.borders.push(
    { x1: left, x2: left, y1: top, y2: bottom },
    { x1: right, x2: right, y1: top, y2: bottom },
    { x1: left, x2: right, y1: bottom, y2: bottom },
  );
  if (!openTop) p.borders.push({ x1: left, x2: right, y1: top, y2: top });
}
function row(
  p: MutablePage,
  label: string,
  value: number | null,
  left: number,
  split: number,
  right: number,
  top: number,
  bottom: number,
  wrap = false,
) {
  rectangle(p, left, split, top, bottom);
  rectangle(p, split, right, top, bottom);
  if (wrap) {
    const cut = label.endsWith("Col E") ? label.length - 1 : label.length - 5;
    p.cells.push(
      cell(label.slice(0, cut).trim(), left + 1.718, split - 4, top + 10),
      cell(label.slice(cut).trim(), left + 1.718, left + 35, top + 20),
    );
  } else p.cells.push(cell(label, left + 1.718, split - 4, top + 10));
  if (value !== null)
    p.cells.push(cell(money(value), split + 5, right - 2, top + 10));
}
function fixture() {
  const page1: MutablePage = {
    pageNumber: 1,
    width: 612,
    height: 792,
    cells: [],
    borders: [],
  };
  const page2: MutablePage = {
    pageNumber: 2,
    width: 612,
    height: 792,
    cells: [],
    borders: [],
  };
  const receiptAmounts = [10000, 100, 200, 300, 400, 500, 600, 700, 800, 900];
  const expenseAmounts = expenses.map((_, i) => (i + 1) * 100);
  page1.cells.push(cell("Part 2", 20.736, 48.52, 217.104));
  rectangle(page1, 21.712, 399.463, 267.543, 294.293);
  rectangle(page1, 399.463, 590.013, 267.543, 294.293);
  page1.cells.push(
    cell(
      "*As of the report transaction ending date.",
      23.472,
      220.152,
      278.592,
    ),
    cell("Total", 23.472, 47.36, 289.752),
    cell("$99.00", 524.304, 588.238, 278.592),
  );
  receipts.forEach((label, i) =>
    row(
      page1,
      label,
      receiptAmounts[i]!,
      21.178,
      229.728,
      301.478,
      receiptY[i]!,
      receiptY[i + 1]!,
      i === 4 || i === 7,
    ),
  );
  expenses.forEach((label, i) =>
    row(
      page1,
      label,
      expenseAmounts[i]!,
      310.077,
      518.627,
      590.377,
      expenseY[i]!,
      expenseY[i + 1]!,
    ),
  );
  rectangle(page2, 19.012, 292.908, 112.725, 326.654);
  const totalReceipts = receiptAmounts.reduce((a, b) => a + b, 0),
    totalExpenditures = expenseAmounts.reduce((a, b) => a + b, 0);
  const cash = [
    20000,
    totalReceipts,
    totalExpenditures,
    20000 + totalReceipts - totalExpenditures,
  ];
  const summaryY = [
    [117.724, 135.724],
    [171.724, 189.724],
    [215.974, 233.974],
    [263.024, 281.024],
  ];
  [
    "Prior Balance",
    "Total Receipts",
    "Total Expenditures",
    "Cash Balance",
  ].forEach((label, i) => {
    const [top, bottom] = summaryY[i]!;
    rectangle(page2, 108.073, 180.073, top!, bottom!, true);
    page2.cells.push(
      cell(label, 23.4, 105, top! + 10),
      cell(money(cash[i]!), 120.528, 178.0676, top! + 10),
    );
  });
  page2.cells.push(
    cell("+", 141.408, 147.2474, 158.136),
    cell("-", 142.632, 145.9617, 206.088),
    cell("=", 141.408, 147.2474, 251.16),
  );
  row(
    page2,
    "Value of In-Kind Contributions – Schd 1B, Col J",
    3000,
    301.502,
    522.292,
    594.042,
    114.721,
    129.631,
  );
  row(
    page2,
    "Value of In-Kind Expenditures – Schd 2, Col AA",
    400,
    301.502,
    522.292,
    594.042,
    129.631,
    144.541,
  );
  page2.cells.push(
    cell("Part 6", 303.264, 331.05, 162.672),
    cell("Administrative", 329.328, 398.78, 181.608),
    cell("Electoral", 330.264, 372.5, 260.664),
  );
  const labels = [
    "Outstanding Loan Balance – Schd 3, Col L",
    "Outstanding Bills Due – Schd 3, Col M",
    "Total Outstanding Obligations",
  ];
  labels.forEach((label, i) =>
    row(
      page2,
      label,
      [1000, 300, 1300][i]!,
      301.502,
      522.292,
      594.042,
      [194.02, 210.82, 228.82][i]!,
      [210.82, 228.82, 246.57][i]!,
    ),
  );
  labels.forEach((label, i) =>
    row(
      page2,
      label,
      i < 2 ? null : 0,
      302.582,
      523.372,
      595.122,
      [267.872, 284.672, 302.672][i]!,
      [284.672, 302.672, 320.422][i]!,
    ),
  );
  return { page1, page2 };
}
function replaceMoney(
  p: MutablePage,
  left: number,
  baseline: number,
  text: string,
) {
  p.cells = p.cells.map((c) =>
    Math.abs(c.left - left) < 0.01 && Math.abs(c.baselineTop - baseline) < 0.01
      ? { ...c, text }
      : c,
  );
}

describe("Maryland legacy financial control source facts", () => {
  it("retains 36 positions with 34 control amounts, signed source roles, real loans and unknown blanks", () => {
    const result = parseMarylandLegacyFinancialControls(fixture());
    expect(result.part2Total).toEqual({
      printedLabel: "Total",
      printedTemporalCaption: "*As of the report transaction ending date.",
      amountCents: 9900,
    });
    expect(result.receiptControls).toHaveLength(10);
    expect(result.expenseControls).toHaveLength(13);
    expect(result.receiptControls.at(-1)).toMatchObject({
      schedule: "3",
      column: "K",
      amountCents: 900,
    });
    expect(result.expenseControls.at(-1)).toMatchObject({
      column: "Z",
      amountCents: 1300,
    });
    expect(result.inKind).toEqual({
      contributionsCents: 3000,
      expendituresCents: 400,
    });
    expect(result.obligations.administrative).toEqual({
      loanBalanceCents: 1000,
      billsDueCents: 300,
      totalCents: 1300,
    });
    expect(result.obligations.electoral).toEqual({
      loanBalanceCents: null,
      billsDueCents: null,
      totalCents: 0,
    });
    expect(result.equations.electoralDebtSum).toBe("not_evaluable");
    expect(result.anonymousContributionsCents).toBeNull();
    expect(result.returnedInKindCents).toBeNull();
    expect(result).not.toHaveProperty("current");
    expect(result).not.toHaveProperty("qualified");
  });
  it("assembles both wrapped E/H captions from complete painted cells regardless of input order", () => {
    const f = fixture();
    f.page1.cells.reverse();
    const result = parseMarylandLegacyFinancialControls(f);
    expect(result.receiptControls[4]!.printedLabel).toBe(receipts[4]);
    expect(result.receiptControls[7]!.printedLabel).toBe(receipts[7]);
  });
  it.each([4, 7])(
    "holds a missing wrapped continuation at receipt index %s",
    (i) => {
      const f = fixture();
      f.page1.cells = f.page1.cells.filter(
        (c) => Math.abs(c.baselineTop - (receiptY[i]! + 20)) > 0.01,
      );
      expect(() => parseMarylandLegacyFinancialControls(f)).toThrow("label");
    },
  );
  it("holds same-total money with a changed financial class caption", () => {
    const f = fixture();
    f.page1.cells.find((c) => c.text === receipts[0])!.text =
      "Other – Schd 1, Col A";
    expect(() => parseMarylandLegacyFinancialControls(f)).toThrow("label");
  });
  it("never turns an unknown Electoral amount-cell value into a blank or zero", () => {
    const f = fixture();
    f.page2.cells.push(cell("unknown", 528.372, 590, 277.872));
    expect(() => parseMarylandLegacyFinancialControls(f)).toThrow("currency");
  });
  it("evaluates separately reported nonzero Electoral debt without merging Administrative controls", () => {
    const f = fixture();
    f.page2.cells.push(
      cell("$1.00", 528.372, 593, 277.872),
      cell("$2.00", 528.372, 593, 294.672),
    );
    replaceMoney(f.page2, 528.372, 312.672, "$3.00");
    const r = parseMarylandLegacyFinancialControls(f);
    expect(r.obligations.electoral).toEqual({
      loanBalanceCents: 100,
      billsDueCents: 200,
      totalCents: 300,
    });
    expect(r.obligations.administrative.totalCents).toBe(1300);
    expect(r.equations.electoralDebtSum).toBe(true);
  });
  it("holds an inconsistent Electoral sum when both components are printed", () => {
    const f = fixture();
    f.page2.cells.push(
      cell("$1.00", 528.372, 593, 277.872),
      cell("$2.00", 528.372, 593, 294.672),
    );
    expect(() => parseMarylandLegacyFinancialControls(f)).toThrow("arithmetic");
  });
  it("retains a signed cash balance without zero clamping", () => {
    const f = fixture();
    replaceMoney(f.page2, 120.528, 127.724, "$-100.00");
    replaceMoney(f.page2, 120.528, 273.024, "$-46.00");
    expect(
      parseMarylandLegacyFinancialControls(f).cashSummary.cashBalanceCents,
    ).toBe(-4600);
  });
  it.each([127.724, 181.724, 225.974, 273.024])(
    "holds a changed summary equation input at %s",
    (baseline) => {
      const f = fixture();
      replaceMoney(f.page2, 120.528, baseline, "$1.00");
      expect(() => parseMarylandLegacyFinancialControls(f)).toThrow(
        "arithmetic",
      );
    },
  );
  it("holds an Administrative debt sum mismatch", () => {
    const f = fixture();
    replaceMoney(f.page2, 527.292, 238.82, "$1.00");
    expect(() => parseMarylandLegacyFinancialControls(f)).toThrow("arithmetic");
  });
  it("holds a removed cash U-edge despite intact outer box", () => {
    const f = fixture();
    f.page2.borders = f.page2.borders.filter(
      (b) => !(b.x1 === 108.073 && b.x2 === 108.073 && b.y1 === 117.724),
    );
    expect(() => parseMarylandLegacyFinancialControls(f)).toThrow("border");
  });
  it("holds an outer cash-block edge loss", () => {
    const f = fixture();
    f.page2.borders = f.page2.borders.filter(
      (b) => !(b.x1 === 19.012 && b.y1 === 112.725),
    );
    expect(() => parseMarylandLegacyFinancialControls(f)).toThrow("border");
  });
  it("holds a label-cell border loss while its amount rectangle survives", () => {
    const f = fixture();
    f.page1.borders = f.page1.borders.filter(
      (b) => !(b.x1 === 21.178 && b.x2 === 229.728 && b.y1 === 340.455),
    );
    expect(() => parseMarylandLegacyFinancialControls(f)).toThrow("border");
  });
  it("allows overlapping painted horizontal segments to cover the actual full cell", () => {
    const f = fixture();
    f.page1.borders = f.page1.borders.filter(
      (b) => !(b.x1 === 21.178 && b.x2 === 229.728 && b.y1 === 340.455),
    );
    f.page1.borders.push(
      { x1: 21.178, x2: 130, y1: 340.455, y2: 340.455 },
      { x1: 120, x2: 229.728, y1: 340.455, y2: 340.455 },
    );
    expect(
      parseMarylandLegacyFinancialControls(f).receiptControls,
    ).toHaveLength(10);
  });
  it.each(["+", "-", "="])(
    "holds a missing or changed printed %s operator",
    (operator) => {
      const f = fixture();
      f.page2.cells = f.page2.cells.filter((c) => c.text !== operator);
      expect(() => parseMarylandLegacyFinancialControls(f)).toThrow("operator");
    },
  );
  it("holds crossed financial cells", () => {
    const f = fixture();
    f.page1.cells.find((c) => c.text === receipts[0])!.right = 240;
    expect(() => parseMarylandLegacyFinancialControls(f)).toThrow("geometry");
  });
  it("holds duplicate money, an extra field and missing money", () => {
    const duplicate = fixture();
    duplicate.page1.cells.push({
      ...duplicate.page1.cells.find(
        (c) => c.left === 234.728 && Math.abs(c.baselineTop - 350.455) < 0.01,
      )!,
    });
    expect(() => parseMarylandLegacyFinancialControls(duplicate)).toThrow(
      "currency",
    );
    const extra = fixture();
    extra.page1.cells.push(cell("extra", 232, 295, 354.45));
    expect(() => parseMarylandLegacyFinancialControls(extra)).toThrow();
    const missing = fixture();
    missing.page1.cells = missing.page1.cells.filter(
      (c) => !(c.left === 234.728 && Math.abs(c.baselineTop - 350.455) < 0.01),
    );
    expect(() => parseMarylandLegacyFinancialControls(missing)).toThrow(
      "currency",
    );
  });
  it.each(["$1.001", "$01.00", "$90,071,992,547,410.00", "not source money"])(
    "holds malformed/unsafe currency with static errors",
    (text) => {
      const f = fixture();
      f.page1.cells.find(
        (c) => c.left === 234.728 && Math.abs(c.baselineTop - 350.455) < 0.01,
      )!.text = text;
      expect(() => parseMarylandLegacyFinancialControls(f)).toThrow(
        "Maryland legacy report controls: currency",
      );
      try {
        parseMarylandLegacyFinancialControls(f);
      } catch (e) {
        expect(String(e)).not.toContain(text);
      }
    },
  );
  it("holds changed section captions and wrong page geometry", () => {
    const f = fixture();
    f.page2.cells.find((c) => c.text === "Electoral")!.text = "Administrative";
    expect(() => parseMarylandLegacyFinancialControls(f)).toThrow("label");
    const wrong = fixture();
    wrong.page2.width = 595;
    expect(() => parseMarylandLegacyFinancialControls(wrong)).toThrow(
      "geometry",
    );
  });
  it.each([
    [1, 240, 289, 530],
    [2, 200, 275, 180],
    [2, 530, 590, 250],
    [2, 530, 590, 332],
  ])(
    "holds unused currency outside expected rows on page %s",
    (number, left, right, y) => {
      const f = fixture();
      const page = number === 1 ? f.page1 : f.page2;
      page.cells.push(cell("$1.00", left, right, y));
      expect(() => parseMarylandLegacyFinancialControls(f)).toThrow();
    },
  );
  it("preserves legitimate financial instructions in the right cash panel", () => {
    const f = fixture();
    f.page2.cells.push(
      cell("Total of Part 3 Receipts", 187.992, 271.574, 181.032),
    );
    expect(
      parseMarylandLegacyFinancialControls(f).cashSummary.totalReceiptsCents,
    ).toBe(14500);
  });
  it.each(["table_top", "table_bottom", "summary_top", "mixed_baseline"])(
    "holds vertically crossed or mispaired cells: %s",
    (kind) => {
      const f = fixture();
      if (kind === "table_top")
        f.page1.cells.find(
          (c) => c.left === 234.728 && Math.abs(c.baselineTop - 350.455) < 0.01,
        )!.height = 20;
      if (kind === "table_bottom")
        f.page1.cells.find(
          (c) => c.left === 234.728 && Math.abs(c.baselineTop - 350.455) < 0.01,
        )!.baselineTop = 355;
      if (kind === "summary_top")
        f.page2.cells.find((c) => c.left === 120.528)!.height = 20;
      if (kind === "mixed_baseline")
        f.page1.cells.find(
          (c) => c.left === 234.728 && Math.abs(c.baselineTop - 350.455) < 0.01,
        )!.baselineTop += 2;
      expect(() => parseMarylandLegacyFinancialControls(f)).toThrow("geometry");
    },
  );
  function addItemization(f: ReturnType<typeof fixture>) {
    const p = f.page2;
    p.cells.push(cell("Contributions", 266.256, 344.909, 591.648));
    for (const [label, left, baseline] of [
      ["Date", 19.296, 671.136],
      ["Received", 19.296, 682.296],
      ["Name and Address of Contributor", 91.296, 671.136],
      ["Aggregate to", 329.328, 671.136],
      ["Date", 329.328, 682.296],
      ["Paid by", 401.328, 671.136],
      ["Contributions", 509.328, 671.136],
      ["Amount", 509.328, 682.296],
    ] as const)
      p.cells.push(
        cell(label, left, left + Math.min(label.length * 4, 165), baseline),
      );
    const xs = [17.56, 89.31, 269.31, 327.36, 399.36, 507.36, 593.06];
    for (let i = 0; i < xs.length - 1; i++)
      rectangle(p, xs[i]!, xs[i + 1]!, 660.085, 686.405);
    rectangle(p, 327.36, 399.36, 686.405, 723.636);
    rectangle(p, 507.36, 593.06, 686.405, 723.636);
    p.cells.push(
      cell("$30.00", 352.8, 397.28, 697.488),
      cell("$5.00", 560, 591.24, 697.488),
    );
  }
  it("separates real itemized amount and aggregate cells by exact section/header/paint rather than value", () => {
    const f = fixture();
    addItemization(f);
    const result = parseMarylandLegacyFinancialControls(f);
    expect(result.receiptControls).toHaveLength(10);
    expect(result.cashSummary.totalReceiptsCents).toBe(14500);
    expect(result).not.toHaveProperty("itemizedReceipts");
  });
  it.each(["title", "header", "border", "duplicate", "extra"])(
    "holds unsupported itemization structure: %s",
    (kind) => {
      const f = fixture();
      addItemization(f);
      if (kind === "title")
        f.page2.cells.find((c) => c.left === 266.256)!.text = "Expenditures";
      if (kind === "header")
        f.page2.cells.find((c) => c.text === "Paid by")!.text = "unknown";
      if (kind === "border")
        f.page2.borders = f.page2.borders.filter(
          (b) => !(b.x1 === 327.36 && b.y1 === 686.405),
        );
      if (kind === "duplicate")
        f.page2.cells.push(cell("$5.00", 560, 591.24, 697.488));
      if (kind === "extra") f.page2.cells.push(cell("$1.00", 200, 275, 180));
      expect(() => parseMarylandLegacyFinancialControls(f)).toThrow();
    },
  );
  it("holds changed Part2 temporal caption, missing Total or amount, and does not invent a cash equation", () => {
    const f = fixture();
    f.page1.cells.find((c) => c.text.startsWith("*As"))!.text =
      "*As of an unknown date.";
    expect(() => parseMarylandLegacyFinancialControls(f)).toThrow("label");
    const missing = fixture();
    missing.page1.cells = missing.page1.cells.filter((c) => c.text !== "Total");
    expect(() => parseMarylandLegacyFinancialControls(missing)).toThrow(
      "label",
    );
    const missingAmount = fixture();
    missingAmount.page1.cells = missingAmount.page1.cells.filter(
      (c) => c.left !== 524.304,
    );
    expect(() => parseMarylandLegacyFinancialControls(missingAmount)).toThrow(
      "currency",
    );
    expect(
      parseMarylandLegacyFinancialControls(fixture()).part2Total.amountCents,
    ).toBe(9900);
  });
  it.each(["$ 1.00", "$1e3"])(
    "holds apparent-dollar gap fields before itemization role assignment: %s",
    (text) => {
      const f = fixture();
      f.page2.cells.push(cell(text, 200, 240, 400));
      expect(() => parseMarylandLegacyFinancialControls(f)).toThrow();
    },
  );
  it.each(["$ 1.00", "$1e3"])(
    "holds apparent-dollar gaps after genuine itemization assignment: %s",
    (text) => {
      const f = fixture();
      addItemization(f);
      f.page2.cells.push(cell(text, 200, 240, 400));
      expect(() => parseMarylandLegacyFinancialControls(f)).toThrow("currency");
    },
  );
  it.each(["$ 1.00", "$1e3"])(
    "holds apparent-dollar fields on page1 and keeps itemized currency lexemes strict: %s",
    (text) => {
      const gap = fixture();
      gap.page1.cells.push(cell(text, 200, 240, 550));
      expect(() => parseMarylandLegacyFinancialControls(gap)).toThrow(
        "currency",
      );
      const itemized = fixture();
      addItemization(itemized);
      itemized.page2.cells.find((c) => c.left === 560)!.text = text;
      expect(() => parseMarylandLegacyFinancialControls(itemized)).toThrow(
        "currency",
      );
    },
  );
});
