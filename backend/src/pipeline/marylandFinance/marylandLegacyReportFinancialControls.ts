import type {
  MarylandPdfCell,
  MarylandPdfPage,
} from "./marylandReportPdfGeometry.js";

export type MarylandLegacyScheduleControl = {
  schedule: string;
  column: string;
  printedLabel: string;
  amountCents: number;
};
export type MarylandLegacyFinancialControls = {
  schema: "legacy_parts_3_4_5_6";
  part2Total: {
    printedLabel: "Total";
    printedTemporalCaption: "*As of the report transaction ending date.";
    amountCents: number;
  };
  receiptControls: readonly MarylandLegacyScheduleControl[];
  expenseControls: readonly MarylandLegacyScheduleControl[];
  cashSummary: {
    priorBalanceCents: number;
    totalReceiptsCents: number;
    totalExpendituresCents: number;
    cashBalanceCents: number;
  };
  inKind: { contributionsCents: number; expendituresCents: number };
  obligations: {
    administrative: {
      loanBalanceCents: number;
      billsDueCents: number;
      totalCents: number;
    };
    electoral: {
      loanBalanceCents: number | null;
      billsDueCents: number | null;
      totalCents: number;
    };
  };
  anonymousContributionsCents: null;
  returnedInKindCents: null;
  equations: {
    receiptsSum: true;
    expensesSum: true;
    cashBalance: true;
    administrativeDebtSum: true;
    electoralDebtSum: true | "not_evaluable";
  };
};
export class MarylandLegacyFinancialControlError extends Error {
  constructor(
    public readonly code:
      "geometry" | "label" | "border" | "currency" | "operator" | "arithmetic",
  ) {
    super(`Maryland legacy report controls: ${code}`);
  }
}
function fail(code: MarylandLegacyFinancialControlError["code"]): never {
  throw new MarylandLegacyFinancialControlError(code);
}
const clean = (s: string) => s.trim().replace(/\s+/g, " ");
const near = (a: number, b: number) => Math.abs(a - b) < 0.02;
const center = (c: MarylandPdfCell) => c.baselineTop - c.height * 0.3;
type Box = {
  left: number;
  split: number;
  right: number;
  top: number;
  bottom: number;
};
const receiptLabels = [
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
const expenseLabels = [
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
const debtLabels = [
  "Outstanding Loan Balance – Schd 3, Col L",
  "Outstanding Bills Due – Schd 3, Col M",
  "Total Outstanding Obligations",
];
function pageValid(p: MarylandPdfPage, number: number) {
  if (
    p.pageNumber !== number ||
    p.width !== 612 ||
    p.height !== 792 ||
    p.cells.length > 40_000 ||
    p.borders.length > 200_000 ||
    p.cells.some(
      (c) =>
        typeof c.text !== "string" ||
        !clean(c.text) ||
        ![c.left, c.right, c.baselineTop, c.height].every(Number.isFinite) ||
        c.right <= c.left ||
        c.height <= 0 ||
        c.left < 0 ||
        c.right > 613 ||
        center(c) < 0 ||
        center(c) > 792,
    ) ||
    p.borders.some((b) => !Object.values(b).every(Number.isFinite))
  )
    fail("geometry");
}
function horizontal(
  p: MarylandPdfPage,
  y: number,
  left: number,
  right: number,
) {
  const segments = p.borders
    .filter((b) => near(b.y1, b.y2) && near(b.y1, y))
    .map((b) => [Math.min(b.x1, b.x2), Math.max(b.x1, b.x2)])
    .sort((a, b) => a[0]! - b[0]!);
  let end = left;
  for (const [a, b] of segments) {
    if (b! < end) continue;
    if (a! > end + 0.02) break;
    end = Math.max(end, b!);
    if (end >= right - 0.02) return true;
  }
  return false;
}
function vertical(p: MarylandPdfPage, x: number, top: number, bottom: number) {
  return p.borders.some(
    (b) =>
      near(b.x1, b.x2) &&
      near(b.x1, x) &&
      Math.min(b.y1, b.y2) <= top + 0.02 &&
      Math.max(b.y1, b.y2) >= bottom - 0.02,
  );
}
function rectangle(
  p: MarylandPdfPage,
  left: number,
  right: number,
  top: number,
  bottom: number,
  openTop = false,
) {
  if (
    (!openTop && !horizontal(p, top, left, right)) ||
    !horizontal(p, bottom, left, right) ||
    !vertical(p, left, top, bottom) ||
    !vertical(p, right, top, bottom)
  )
    fail("border");
}
function currency(text: string) {
  const m = /^\$(-?)(0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)\.(\d{2})$/.exec(
    clean(text),
  );
  if (!m) fail("currency");
  const cents =
    (Number(m[2]!.replaceAll(",", "")) * 100 + Number(m[3])) * (m[1] ? -1 : 1);
  if (!Number.isSafeInteger(cents)) fail("currency");
  return cents;
}
function sum(values: readonly number[]) {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) fail("arithmetic");
  }
  return total;
}
function rowCells(p: MarylandPdfPage, box: Box, seen: Set<MarylandPdfCell>) {
  const cells = p.cells.filter(
    (c) =>
      center(c) > box.top &&
      center(c) < box.bottom &&
      c.right > box.left &&
      c.left < box.right,
  );
  for (const c of cells) {
    if (
      c.baselineTop - c.height < box.top - 0.02 ||
      c.baselineTop > box.bottom + 0.02 ||
      c.left <= box.left ||
      c.right > box.right + 0.01 ||
      (c.left < box.split && c.right > box.split + 0.01)
    )
      fail("geometry");
    seen.add(c);
  }
  return cells;
}
function labelText(cells: readonly MarylandPdfCell[]) {
  // Baselines can differ slightly within a line; preserve physical lines and left-to-right order.
  return [...cells]
    .sort((a, b) =>
      Math.abs(a.baselineTop - b.baselineTop) > 0.8
        ? a.baselineTop - b.baselineTop
        : a.left - b.left,
    )
    .map((c) => clean(c.text))
    .join(" ");
}
function tableControl(
  p: MarylandPdfPage,
  box: Box,
  expected: string,
  seen: Set<MarylandPdfCell>,
  blankAllowed = false,
) {
  rectangle(p, box.left, box.split, box.top, box.bottom);
  rectangle(p, box.split, box.right, box.top, box.bottom);
  const cells = rowCells(p, box, seen);
  if (labelText(cells.filter((c) => c.left < box.split)) !== expected)
    fail("label");
  const amounts = cells.filter((c) => c.left >= box.split);
  if (amounts.length === 0 && blankAllowed) return null;
  if (amounts.length !== 1) fail("currency");
  if (
    Math.abs(
      amounts[0]!.baselineTop -
        Math.min(
          ...cells.filter((c) => c.left < box.split).map((c) => c.baselineTop),
        ),
    ) > 0.8
  )
    fail("geometry");
  return currency(amounts[0]!.text);
}
function scheduleControl(
  p: MarylandPdfPage,
  box: Box,
  expected: string,
  seen: Set<MarylandPdfCell>,
): MarylandLegacyScheduleControl {
  const amountCents = tableControl(p, box, expected, seen);
  const match = /Schd ([1-3][AB]?), Col ([A-Z]+)$/.exec(expected)!;
  return {
    schedule: match[1]!,
    column: match[2]!,
    printedLabel: expected,
    amountCents: amountCents!,
  };
}
function rejectUnused(
  p: MarylandPdfPage,
  seen: Set<MarylandPdfCell>,
  left: number,
  right: number,
  top: number,
  bottom: number,
) {
  if (
    p.cells.some(
      (c) =>
        !seen.has(c) &&
        c.right > left &&
        c.left < right &&
        center(c) > top &&
        center(c) < bottom,
    )
  )
    fail("geometry");
}
function exactCaption(
  p: MarylandPdfPage,
  text: string,
  left: number,
  baseline: number,
) {
  const found = p.cells.filter(
    (c) => near(c.left, left) && near(c.baselineTop, baseline),
  );
  if (found.length !== 1 || clean(found[0]!.text) !== text) fail("label");
}

function markKnownItemization(
  page: MarylandPdfPage,
  seen: Set<MarylandPdfCell>,
) {
  if (!page.cells.some((c) => clean(c.text).startsWith("$") && !seen.has(c)))
    return;
  // These are source field roles only. Neither monetary cell becomes a control or accepted receipt.
  exactCaption(page, "Contributions", 266.256, 591.648);
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
    exactCaption(page, label, left, baseline);
  const columns = [17.56, 89.31, 269.31, 327.36, 399.36, 507.36, 593.06];
  for (let i = 0; i < columns.length - 1; i++)
    rectangle(page, columns[i]!, columns[i + 1]!, 660.085, 686.405);
  for (const [left, right] of [
    [327.36, 399.36],
    [507.36, 593.06],
  ] as const) {
    rectangle(page, left, right, 686.405, 723.636);
    const values = page.cells.filter(
      (c) =>
        center(c) > 686.405 &&
        center(c) < 723.636 &&
        c.right > left &&
        c.left < right,
    );
    if (values.length !== 1) fail("currency");
    const value = values[0]!;
    if (
      value.left <= left ||
      value.right > right + 0.01 ||
      value.baselineTop - value.height < 686.405 - 0.02 ||
      value.baselineTop > 723.636 + 0.02
    )
      fail("geometry");
    currency(value.text);
    seen.add(value);
  }
}

/** Aggregate source facts only: no owner, report edition, cycle, cash-gift or donor acceptance authority. */
export function parseMarylandLegacyFinancialControls(input: {
  page1: MarylandPdfPage;
  page2: MarylandPdfPage;
}): MarylandLegacyFinancialControls {
  const { page1, page2 } = input;
  pageValid(page1, 1);
  pageValid(page2, 2);
  const seen1 = new Set<MarylandPdfCell>(),
    seen2 = new Set<MarylandPdfCell>();
  exactCaption(page1, "Part 2", 20.736, 217.104);
  const part2TotalCents = tableControl(
    page1,
    {
      left: 21.712,
      split: 399.463,
      right: 590.013,
      top: 267.543,
      bottom: 294.293,
    },
    "*As of the report transaction ending date. Total",
    seen1,
  )!;
  const receiptControls = receiptLabels.map((label, i) =>
    scheduleControl(
      page1,
      {
        left: 21.178,
        split: 229.728,
        right: 301.478,
        top: receiptY[i]!,
        bottom: receiptY[i + 1]!,
      },
      label,
      seen1,
    ),
  );
  const expenseControls = expenseLabels.map((label, i) =>
    scheduleControl(
      page1,
      {
        left: 310.077,
        split: 518.627,
        right: 590.377,
        top: expenseY[i]!,
        bottom: expenseY[i + 1]!,
      },
      label,
      seen1,
    ),
  );
  rejectUnused(page1, seen1, 20.928, 301.728, 340.205, 504.996);
  rejectUnused(page1, seen1, 309.827, 590.627, 340.205, 532.205);
  rectangle(page2, 19.012, 292.908, 112.725, 326.654);
  const summaryLabels = [
    "Prior Balance",
    "Total Receipts",
    "Total Expenditures",
    "Cash Balance",
  ];
  const summaryY = [
    [117.724, 135.724],
    [171.724, 189.724],
    [215.974, 233.974],
    [263.024, 281.024],
  ];
  const cash = summaryLabels.map((label, i) => {
    const [top, bottom] = summaryY[i]!;
    rectangle(page2, 108.073, 180.073, top!, bottom!, true);
    const cells = rowCells(
      page2,
      {
        left: 19.012,
        split: 108.073,
        right: 180.073,
        top: top!,
        bottom: bottom!,
      },
      seen2,
    );
    if (labelText(cells.filter((c) => c.left < 108.073)) !== label)
      fail("label");
    const amounts = cells.filter((c) => c.left >= 108.073);
    if (amounts.length !== 1) fail("currency");
    if (
      Math.abs(
        amounts[0]!.baselineTop -
          Math.min(
            ...cells.filter((c) => c.left < 108.073).map((c) => c.baselineTop),
          ),
      ) > 0.8
    )
      fail("geometry");
    return currency(amounts[0]!.text);
  });
  for (const [operator, left, baseline] of [
    ["+", 141.408, 158.136],
    ["-", 142.632, 206.088],
    ["=", 141.408, 251.16],
  ] as const) {
    const found = page2.cells.filter(
      (c) =>
        c.left >= 108.073 &&
        c.right <= 180.073 &&
        near(c.baselineTop, baseline),
    );
    if (
      found.length !== 1 ||
      clean(found[0]!.text) !== operator ||
      !near(found[0]!.left, left)
    )
      fail("operator");
    seen2.add(found[0]!);
  }
  rejectUnused(page2, seen2, 19.012, 180.073, 112.725, 326.654);
  const inKind = [
    "Value of In-Kind Contributions – Schd 1B, Col J",
    "Value of In-Kind Expenditures – Schd 2, Col AA",
  ].map((label, i) =>
    tableControl(
      page2,
      {
        left: 301.502,
        split: 522.292,
        right: 594.042,
        top: [114.721, 129.631][i]!,
        bottom: [129.631, 144.541][i]!,
      },
      label,
      seen2,
    )!,
  );
  exactCaption(page2, "Part 6", 303.264, 162.672);
  exactCaption(page2, "Administrative", 329.328, 181.608);
  exactCaption(page2, "Electoral", 330.264, 260.664);
  const administrative = debtLabels.map((label, i) =>
    tableControl(
      page2,
      {
        left: 301.502,
        split: 522.292,
        right: 594.042,
        top: [194.02, 210.82, 228.82][i]!,
        bottom: [210.82, 228.82, 246.57][i]!,
      },
      label,
      seen2,
    )!,
  );
  const electoral = debtLabels.map((label, i) =>
    tableControl(
      page2,
      {
        left: 302.582,
        split: 523.372,
        right: 595.122,
        top: [267.872, 284.672, 302.672][i]!,
        bottom: [284.672, 302.672, 320.422][i]!,
      },
      label,
      seen2,
      i < 2,
    ),
  );
  rejectUnused(page2, seen2, 301.502, 594.042, 114.721, 144.541);
  rejectUnused(page2, seen2, 301.502, 594.042, 194.02, 246.57);
  rejectUnused(page2, seen2, 302.582, 595.122, 267.872, 320.422);
  // The source contains 34 aggregate currency controls and two structurally distinct itemized values.
  markKnownItemization(page2, seen2);
  // A newly printed monetary control in panel gaps or the instruction half must hold.
  for (const [page, seen] of [
    [page1, seen1],
    [page2, seen2],
  ] as const) {
    if (page.cells.some((c) => clean(c.text).startsWith("$") && !seen.has(c)))
      fail("currency");
  }
  if (
    sum(receiptControls.map((c) => c.amountCents)) !== cash[1] ||
    sum(expenseControls.map((c) => c.amountCents)) !== cash[2] ||
    sum([cash[0]!, cash[1]!, -cash[2]!]) !== cash[3] ||
    sum([administrative[0]!, administrative[1]!]) !== administrative[2]
  )
    fail("arithmetic");
  const electoralDebtSum =
    electoral[0] === null || electoral[1] === null ? "not_evaluable" : true;
  if (
    electoralDebtSum === true &&
    sum([electoral[0]!, electoral[1]!]) !== electoral[2]
  )
    fail("arithmetic");
  return {
    schema: "legacy_parts_3_4_5_6",
    part2Total: {
      printedLabel: "Total",
      printedTemporalCaption: "*As of the report transaction ending date.",
      amountCents: part2TotalCents,
    },
    receiptControls,
    expenseControls,
    cashSummary: {
      priorBalanceCents: cash[0]!,
      totalReceiptsCents: cash[1]!,
      totalExpendituresCents: cash[2]!,
      cashBalanceCents: cash[3]!,
    },
    inKind: { contributionsCents: inKind[0]!, expendituresCents: inKind[1]! },
    obligations: {
      administrative: {
        loanBalanceCents: administrative[0]!,
        billsDueCents: administrative[1]!,
        totalCents: administrative[2]!,
      },
      electoral: {
        loanBalanceCents: electoral[0]!,
        billsDueCents: electoral[1]!,
        totalCents: electoral[2]!,
      },
    },
    anonymousContributionsCents: null,
    returnedInKindCents: null,
    equations: {
      receiptsSum: true,
      expensesSum: true,
      cashBalance: true,
      administrativeDebtSum: true,
      electoralDebtSum,
    },
  };
}
