import type {
  MarylandPdfCell,
  MarylandPdfPage,
} from "./marylandReportPdfGeometry.js";

export type MarylandFinancialControl = {
  number: number;
  printedLabel: string;
  printedOperator: "+" | "-" | "=";
  amountCents: number;
};
export type MarylandModernFinancialControls = {
  schema: "modern_numbered_26";
  controls: readonly MarylandFinancialControl[];
  anonymousTransactionCount: number;
  equations: {
    cashNet: true;
    expensesNet: true;
    loanObligationSubtotal: true;
    loanObligationEnding: true;
    inKindNet: true;
    inKindExpenseNet: true;
  };
};
export class MarylandFinancialControlError extends Error {
  constructor(
    public readonly code:
      | "geometry"
      | "ordinal"
      | "label"
      | "operator"
      | "border"
      | "currency"
      | "arithmetic",
  ) {
    super(`Maryland report controls: ${code}`);
  }
}
const labels: readonly string[] = [
  "Contributions (Total from Section 1)",
  "Anonymous Contributions * Number of Transactions:",
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
const operators = [
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
] as const;
const baselines = [
  130.46, 150.46, 170.46, 190.46, 250.46, 270.46, 290.46, 310.46, 330.46,
  380.46, 400.46, 420.46, 440.46, 460.46, 480.46, 500.46, 520.46, 542.46,
  594.46, 614.46, 634.46, 654.46, 674.46, 694.46, 714.46, 734.46,
];
const clean = (s: string) => s.trim().replace(/\s+/g, " ");
const center = (c: MarylandPdfCell) => c.baselineTop - c.height * 0.3;
const near = (a: number, b: number) => Math.abs(a - b) < 0.02;
function fail(code: MarylandFinancialControlError["code"]): never {
  throw new MarylandFinancialControlError(code);
}
function currency(s: string) {
  const m = /^\$(-?)(0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)\.(\d{2})$/.exec(s);
  if (!m) fail("currency");
  const result =
    (Number(m[2]!.replaceAll(",", "")) * 100 + Number(m[3])) * (m[1] ? -1 : 1);
  if (!Number.isSafeInteger(result)) fail("currency");
  return result;
}
function exactSum(values: readonly number[]) {
  let result = 0;
  for (const value of values) {
    result += value;
    if (!Number.isSafeInteger(result)) fail("arithmetic");
  }
  return result;
}
function horizontalCoverage(
  page: MarylandPdfPage,
  y: number,
  left: number,
  right: number,
) {
  const segments = page.borders
    .filter((b) => Math.abs(b.y1 - b.y2) < 0.001 && near(b.y1, y))
    .map((b) => [Math.min(b.x1, b.x2), Math.max(b.x1, b.x2)] as const)
    .sort((a, b) => a[0] - b[0]);
  let covered = left;
  for (const [start, end] of segments) {
    if (end < covered) continue;
    if (start > covered + 0.02) break;
    covered = Math.max(covered, end);
    if (covered >= right - 0.02) return true;
  }
  return false;
}

/** Aggregate source controls only. This proves neither report ownership,
 * currentness, period coverage, donor identity nor accepted financial money. */
export function parseMarylandModernFinancialControls(
  page: MarylandPdfPage,
): MarylandModernFinancialControls {
  if (
    page.pageNumber !== 3 ||
    page.width !== 595 ||
    page.height !== 853 ||
    page.cells.length > 40_000 ||
    page.borders.length > 200_000 ||
    page.cells.some(
      (c) =>
        !clean(c.text) ||
        ![c.left, c.right, c.baselineTop, c.height].every(Number.isFinite) ||
        c.right <= c.left ||
        c.height <= 0 ||
        c.left < 0 ||
        c.right > 596 ||
        center(c) < 0 ||
        center(c) > 853,
    ) ||
    page.borders.some((b) => !Object.values(b).every(Number.isFinite))
  )
    fail("geometry");
  const ordinals = page.cells.filter(
    (c) =>
      c.left >= 20 &&
      c.right <= 55 &&
      /^[+-]?\d+(?:[.,]\d+)?[.)]?$/.test(clean(c.text)),
  );
  if (ordinals.length !== 26) fail("ordinal");
  const seen = new Set<number>();
  const controls: MarylandFinancialControl[] = [];
  let anonymousTransactionCount = -1;
  for (const ordinal of ordinals) {
    if (!/^(?:[1-9]|1[0-9]|2[0-6])[.]?$/.test(clean(ordinal.text)))
      fail("ordinal");
    const number = Number(clean(ordinal.text).replace(/[.]$/, ""));
    if (
      seen.has(number) ||
      !near(ordinal.left, 24) ||
      Math.abs(ordinal.baselineTop - baselines[number - 1]!) > 0.02
    )
      fail("ordinal");
    seen.add(number);
    const y = center(ordinal);
    const horizontal = page.borders
      .filter(
        (b) =>
          Math.abs(b.y1 - b.y2) < 0.001 &&
          Math.min(b.x1, b.x2) <= 490.02 &&
          Math.max(b.x1, b.x2) >= 573.98,
      )
      .map((b) => b.y1);
    const above = horizontal.filter((v) => v < y),
      below = horizontal.filter((v) => v > y);
    if (!above.length || !below.length) fail("border");
    const top = Math.max(...above),
      bottom = Math.min(...below);
    if (bottom - top < 15 || bottom - top > 28) fail("border");
    for (const [left, right] of [
      [20, 55],
      [55, 460],
      [460, 490],
      [490, 574],
    ]) {
      if (
        !horizontalCoverage(page, top, left!, right!) ||
        !horizontalCoverage(page, bottom, left!, right!)
      )
        fail("border");
    }
    for (const x of [20, 55, 460, 490, 574]) {
      if (
        !page.borders.some(
          (b) =>
            Math.abs(b.x1 - b.x2) < 0.001 &&
            near(b.x1, x) &&
            Math.min(b.y1, b.y2) <= top + 0.02 &&
            Math.max(b.y1, b.y2) >= bottom - 0.02,
        )
      )
        fail("border");
    }
    const row = page.cells.filter((c) => center(c) > top && center(c) < bottom);
    const inside = (left: number, right: number) =>
      row
        .filter(
          (c) => c.left > left && c.left < right && c.right <= right + 0.01,
        )
        .sort((a, b) => a.baselineTop - b.baselineTop || a.left - b.left);
    if (
      row.some(
        (c) =>
          c.left >= 20 &&
          c.left < 574 &&
          ![
            [20, 55],
            [55, 460],
            [460, 490],
            [490, 574],
          ].some(
            ([left, right]) =>
              c.left > left! && c.left < right! && c.right <= right! + 0.01,
          ),
      )
    )
      fail("geometry");
    const numberCells = inside(20, 55);
    if (numberCells.length !== 1 || numberCells[0] !== ordinal) fail("ordinal");
    const labelCells = inside(55, 460).sort((a, b) =>
      number === 18
        ? a.baselineTop - b.baselineTop || a.left - b.left
        : a.left - b.left,
    );
    if (number === 18) {
      if (
        labelCells.length !== 2 ||
        labelCells.some(
          (c, i) =>
            !near(c.left, 59) ||
            !near(c.baselineTop, i === 0 ? 536.64 : 548.28),
        )
      )
        fail("label");
    } else if (
      labelCells.some(
        (c) => Math.abs(c.baselineTop - ordinal.baselineTop) > 0.8,
      )
    )
      fail("label");
    const printed = clean(labelCells.map((c) => c.text).join(" "));
    const printedLabel = printed;
    if (number === 2) {
      const match =
        /^Anonymous Contributions \* Number of Transactions: (0|[1-9]\d*)$/.exec(
          printed,
        );
      if (!match) fail("label");
      anonymousTransactionCount = Number(match[1]);
      if (!Number.isSafeInteger(anonymousTransactionCount)) fail("label");
    } else if (printed !== labels[number - 1]) fail("label");
    const operatorCells = inside(460, 490);
    if (
      operatorCells.length !== 1 ||
      Math.abs(operatorCells[0]!.baselineTop - ordinal.baselineTop) > 0.8 ||
      clean(operatorCells[0]!.text) !== operators[number - 1]
    )
      fail("operator");
    const money = inside(490, 574);
    if (
      money.length !== 1 ||
      Math.abs(money[0]!.baselineTop - ordinal.baselineTop) > 0.8 ||
      !near(money[0]!.right, 570)
    )
      fail("currency");
    controls.push({
      number,
      printedLabel,
      printedOperator: operators[number - 1]!,
      amountCents: currency(clean(money[0]!.text)),
    });
  }
  controls.sort((a, b) => a.number - b.number);
  const v = (number: number) => controls[number - 1]!.amountCents;
  if (
    v(4) !== exactSum([v(1), v(2), -v(3)]) ||
    v(9) !== exactSum([v(5), v(6), v(7), -v(8)]) ||
    v(13) !== exactSum([v(10), v(11), v(12)]) ||
    v(18) !== exactSum([v(13), -v(14), -v(15), -v(16), -v(17)]) ||
    v(23) !== exactSum([v(19), v(20), -v(21), -v(22)]) ||
    v(26) !== exactSum([v(24), -v(25)])
  )
    fail("arithmetic");
  return {
    schema: "modern_numbered_26",
    controls,
    anonymousTransactionCount,
    equations: {
      cashNet: true,
      expensesNet: true,
      loanObligationSubtotal: true,
      loanObligationEnding: true,
      inKindNet: true,
      inKindExpenseNet: true,
    },
  };
}
