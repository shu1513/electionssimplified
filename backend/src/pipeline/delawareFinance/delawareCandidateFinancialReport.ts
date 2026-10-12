import {
  parseDelawareAmountCents,
  parseDelawareCurrencyCents,
  type DelawareReportCover,
} from "./delawareCfrsParsers.js";
import {
  extractDelawareThirdPartyFinancialPdf,
  type DelawareThirdPartyPdfCell as Cell,
  type DelawareThirdPartyPdfExtraction as Extraction,
  type DelawareThirdPartyPdfPage as Page,
} from "./delawareThirdPartyFinancialReport.js";

export type DelawareCandidateScheduleName =
  | "receipts"
  | "expenditures"
  | "inKindReceipts"
  | "inKindExpenditures"
  | "loansReceived"
  | "loansOutstanding"
  | "reimbursementsReceived"
  | "reimbursementsPaid"
  | "assets"
  | "assetsEliminated";
export type DelawareCandidatePdfOccurrence = {
  occurrence: number;
  pageNumber: number;
  pageNumbers: readonly number[];
  date: string;
  /** Complete published column text. This is not a donor classification. */
  columns: Readonly<Record<string, string>>;
  monetaryColumns: Readonly<Record<string, number>>;
  rawCells: readonly (Cell & { pageNumber: number })[];
};
export type DelawareCandidatePdfSchedule = {
  rows: readonly DelawareCandidatePdfOccurrence[];
  controls: Readonly<Record<string, number>>;
};
export type DelawareCandidateFinancialReport = {
  pdfSha256: string;
  byteCount: number;
  accountNumber: string;
  organizationName: string;
  periodStart: string;
  periodEnd: string;
  reportDate: string;
  cover: DelawareReportCover;
  supplementaryCoverControls: {
    assetsCents: number;
    assetsEliminatedCents: number;
    loansOutstandingCents: number;
  };
  schedules: Readonly<
    Record<DelawareCandidateScheduleName, DelawareCandidatePdfSchedule>
  >;
  /** Untouched positioned facts also retain instructions, legends and empty schedules. */
  sourcePages: readonly Page[];
};

type Line = { y: number; cells: Cell[]; text: string };
type Column = {
  key: string;
  min: number;
  max: number;
  header: string;
  money?: boolean;
};
type Control = { key: string; label: RegExp; moneyKeys: readonly string[] };
type Definition = {
  key: DelawareCandidateScheduleName;
  title: string;
  columns: readonly Column[];
  controls: readonly Control[];
  dateKey?: string;
};
const clean = (value: string) => value.replace(/\s+/gu, " ").trim();
function fail(message: string): never {
  throw new Error(`Delaware candidate PDF: ${message}`);
}
function civil(raw: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  if (!match) fail("invalid civil date");
  const value = `${match[3]}-${match[1]}-${match[2]}`;
  const milliseconds = Date.parse(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString().slice(0, 10) !== value
  )
    fail("invalid civil date");
  return value;
}
function money(raw: string): number {
  if (parseDelawareCurrencyCents(raw) === null)
    fail("invalid positioned money");
  return parseDelawareAmountCents(
    (raw.startsWith("(") || raw.includes("-") ? "-" : "") +
      raw.replace(/[$,()\-]/g, ""),
  );
}
const isMoney = (raw: string) => /^(?:-?\$|\(-?\$)/.test(raw);
function sum(values: readonly number[]): number {
  const value = values.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(value)) fail("unsafe monetary sum");
  return value;
}
function lines(page: Page): Line[] {
  const rows: Line[] = [];
  for (const cell of [...page.cells].sort((a, b) => b.y - a.y || a.x - b.x)) {
    let line = rows.find((row) => Math.abs(row.y - cell.y) < 1.5);
    if (!line) rows.push((line = { y: cell.y, cells: [], text: "" }));
    line.cells.push(cell);
  }
  return rows.map((line) => {
    line.cells.sort((a, b) => a.x - b.x);
    return {
      ...line,
      text: clean(line.cells.map((cell) => cell.text).join(" ")),
    };
  });
}
function unique(rows: readonly Line[], pattern: RegExp, label: string): Line {
  const matches = rows.filter((row) => pattern.test(row.text));
  if (matches.length !== 1) fail(`missing/ambiguous ${label}`);
  return matches[0]!;
}
function amountAt(line: Line, minimum: number, maximum = 760): number {
  const found = line.cells.filter(
    (cell) => cell.x >= minimum && cell.x < maximum && isMoney(cell.text),
  );
  if (found.length !== 1) fail("missing/shifted monetary column");
  return money(found[0]!.text);
}
const col = (
  key: string,
  min: number,
  max: number,
  header: string,
  monetary = false,
): Column => ({ key, min, max, header, money: monetary });
const receiptControls: readonly Control[] = [
  {
    key: "itemizedCents",
    label: /^TOTAL ITEMIZED RECEIPTS\b/,
    moneyKeys: ["itemizedCents"],
  },
  {
    key: "anonymousCents",
    label: /^TOTAL OF CONTRIBUTIONS NOT EXCEEDING \$100\b/,
    moneyKeys: ["anonymousCents"],
  },
  {
    key: "grandCents",
    label: /^GRAND TOTAL RECEIPTS\b/,
    moneyKeys: ["grandCents"],
  },
];
const expenseControls: readonly Control[] = [
  {
    key: "itemizedCents",
    label: /^TOTAL ITEMIZED EXPENDITURES\b/,
    moneyKeys: ["itemizedCents"],
  },
  {
    key: "anonymousCents",
    label: /^TOTAL OF EXPENDITURES NOT EXCEEDING \$100\b/,
    moneyKeys: ["anonymousCents"],
  },
  {
    key: "grandCents",
    label: /^GRAND TOTAL EXPENDITURES\b/,
    moneyKeys: ["grandCents"],
  },
];
const definitions: readonly Definition[] = [
  {
    key: "receipts",
    title: "SCHEDULE A - TOTAL RECEIPTS",
    columns: [
      col("date", 38, 140, "Date Received"),
      col("name", 140, 326, "Contributor Name"),
      col("address", 326, 549, "Contributor Mailing Address"),
      col("aggregate", 549, 649, "Aggregate Amount", true),
      col("amount", 649, 760, "Amount Received", true),
    ],
    controls: receiptControls,
  },
  {
    key: "expenditures",
    title: "SCHEDULE B - TOTAL EXPENDITURES",
    columns: [
      col("date", 38, 128, "Date Expended"),
      col("name", 128, 276, "Payee Name"),
      col("address", 276, 432, "Payee Mailing Address"),
      col("vendor", 432, 593, "Vendor"),
      col("aggregate", 593, 673, "Aggregate Amount", true),
      col("amount", 673, 760, "Amount Expended", true),
    ],
    controls: expenseControls,
  },
  {
    key: "inKindReceipts",
    title: "SCHEDULE C-1 - TOTAL IN-KIND RECEIPTS",
    columns: [
      col("date", 38, 140, "Date Received"),
      col("name", 140, 340, "Contributor Name"),
      col("address", 340, 546, "Contributor Mailing Address"),
      col("description", 546, 648, "Description of Contribution"),
      col("amount", 648, 760, "Est. Amount Received", true),
    ],
    controls: [
      {
        key: "itemizedCents",
        label: /^TOTAL ITEMIZED IN-KIND CONTRIBUTIONS\b/,
        moneyKeys: ["itemizedCents"],
      },
      {
        key: "anonymousCents",
        label: /^TOTAL OF IN-KIND CONTRIBUTIONS NOT EXCEEDING \$100\b/,
        moneyKeys: ["anonymousCents"],
      },
      {
        key: "grandCents",
        label: /^GRAND TOTAL RECEIPTS\b/,
        moneyKeys: ["grandCents"],
      },
    ],
  },
  {
    key: "inKindExpenditures",
    title: "SCHEDULE C-2 - TOTAL IN-KIND EXPENDITURES",
    columns: [
      col("date", 38, 128, "Date Expended"),
      col("name", 128, 276, "Person or Activity Name"),
      col(
        "address",
        276,
        432,
        "Person or Activity Location or Mailing Address",
      ),
      col("vendor", 432, 568, "Vendor"),
      col("description", 568, 660, "Description of Expenditure"),
      col("amount", 660, 760, "Est. Amount Expended", true),
    ],
    controls: [
      {
        key: "itemizedCents",
        label: /^TOTAL ITEMIZED IN-KIND EXPENDITURES\b/,
        moneyKeys: ["itemizedCents"],
      },
      {
        key: "anonymousCents",
        label: /^TOTAL OF IN-KIND EXPENDITURES NOT EXCEEDING \$100\b/,
        moneyKeys: ["anonymousCents"],
      },
      {
        key: "grandCents",
        label: /^GRAND TOTAL EXPENDITURES\b/,
        moneyKeys: ["grandCents"],
      },
    ],
  },
  {
    key: "loansReceived",
    title: "SCHEDULE D-1 - TOTAL LOANS RECEIVED AND DEBTS INCURRED",
    columns: [
      col("transactionId", 38, 108, "Transaction Id"),
      col("date", 108, 176, "Date Received"),
      col("lender", 176, 326, "Lender"),
      col("endorser", 326, 474, "Endorser"),
      col("security", 474, 620, "Description of Security"),
      col("interestRate", 620, 664, "Int. Rate"),
      col("amount", 664, 760, "Amount Received", true),
    ],
    controls: [
      {
        key: "totalCents",
        label: /^TOTAL LOANS RECEIVED\b/,
        moneyKeys: ["totalCents"],
      },
    ],
  },
  {
    key: "loansOutstanding",
    title: "SCHEDULE D-2 - TOTAL LOANS AND DEBTS OUTSTANDING",
    columns: [
      col("transactionId", 38, 100, "Transaction Id"),
      col("date", 100, 171, "Date Received"),
      col("lender", 171, 277, "Lender"),
      col("endorser", 277, 401, "Endorser"),
      col("description", 401, 536, "Description"),
      col("interestRate", 536, 577, "Int Rate"),
      col("previous", 577, 638, "Previous Loan Balance", true),
      col("payments", 638, 699, "Payments Made", true),
      col("balance", 699, 760, "Balance", true),
    ],
    controls: [
      {
        key: "totalCents",
        label: /^TOTAL LOANS\b/,
        moneyKeys: ["previousCents", "paymentsCents", "balanceCents"],
      },
    ],
  },
  {
    key: "reimbursementsReceived",
    title: "SCHEDULE E - INTER COMMITTEE (SHARED) EXPENSES",
    columns: [
      col("date", 38, 128, "Date Received"),
      col("name", 128, 276, "Reimburser"),
      col("description", 276, 490, "Description of Activity"),
      col("activityDate", 490, 574, "Activity Date"),
      col("expense", 574, 660, "Total Expense", true),
      col("amount", 660, 760, "Reimbursement", true),
    ],
    controls: [
      {
        key: "totalCents",
        label: /^TOTAL REIMBURSEMENTS RECEIVED\b/,
        moneyKeys: ["expenseCents", "totalCents"],
      },
    ],
  },
  {
    key: "reimbursementsPaid",
    title: "SCHEDULE E - INTER COMMITTEE (SHARED) EXPENSES",
    columns: [
      col("date", 38, 128, "Date Paid"),
      col("name", 128, 276, "Payee"),
      col("description", 276, 490, "Description of Activity"),
      col("activityDate", 490, 574, "Activity Date"),
      col("expense", 574, 660, "Total Expense", true),
      col("amount", 660, 760, "Reimbursement", true),
    ],
    controls: [
      {
        key: "totalCents",
        label: /^TOTAL REIMBURSEMENTS PAID\b/,
        moneyKeys: ["expenseCents", "totalCents"],
      },
    ],
  },
  {
    key: "assets",
    title: "SCHEDULE F - NON-CASH ASSETS",
    columns: [
      col("date", 38, 128, "Date Received"),
      col("description", 128, 395, "Description of Asset"),
      col("location", 395, 660, "Location of Asset (Physical Address)"),
      col("amount", 660, 760, "Value of Asset", true),
    ],
    controls: [
      {
        key: "totalCents",
        label: /^TOTAL ASSET VALUE\b/,
        moneyKeys: ["totalCents"],
      },
    ],
  },
  {
    key: "assetsEliminated",
    title: "SCHEDULE G - ELIMINATION OF ASSETS",
    columns: [
      col("date", 38, 128, "Date Eliminated"),
      col("description", 128, 395, "Description of Asset"),
      col("disposition", 395, 660, "Disposition of Asset"),
      col("amount", 660, 760, "Value of Asset", true),
    ],
    controls: [
      {
        key: "totalCents",
        label: /^TOTAL ASSETS ELIMINATED\b/,
        moneyKeys: ["totalCents"],
      },
    ],
  },
];

function headerBottom(page: Page, definition: Definition): number {
  // Published multi-line labels can extend 22.2pt below the date header.
  const dateColumn = definition.columns.find(
    (column) => column.key === "date",
  )!;
  const anchors = page.cells.filter(
    (cell) =>
      cell.text === dateColumn.header &&
      cell.x >= dateColumn.min &&
      cell.x < dateColumn.max,
  );
  if (anchors.length !== 1) fail(`missing/ambiguous ${definition.key} header`);
  const anchor = anchors[0]!;
  const firstBodyY = Math.max(
    -Infinity,
    ...page.cells
      .filter(
        (cell) =>
          cell.y < anchor.y &&
          ((cell.x >= dateColumn.min &&
            cell.x < dateColumn.max &&
            /^\d{2}\/\d{2}\/\d{4}$/.test(cell.text)) ||
            /^(?:TOTAL|GRAND TOTAL)\b/.test(cell.text)),
      )
      .map((cell) => cell.y),
  );
  const header = page.cells.filter(
    (cell) =>
      cell.y <= anchor.y + 6 &&
      cell.y >= Math.max(anchor.y - 23, firstBodyY + 1.5),
  );
  for (const column of definition.columns) {
    const fragments = header
      .filter((cell) => cell.x >= column.min && cell.x < column.max)
      .sort((a, b) => b.y - a.y || a.x - b.x);
    if (clean(fragments.map((cell) => cell.text).join(" ")) !== column.header)
      fail(`shifted/unknown ${definition.key} ${column.key} header`);
  }
  return Math.min(...header.map((cell) => cell.y)) - 8;
}
function parseSchedule(
  pages: readonly Page[],
  definition: Definition,
): DelawareCandidatePdfSchedule {
  const first = pages[0]!;
  const top = headerBottom(first, definition);
  const pageLines = pages.map((page) => lines(page));
  for (const page of pages.slice(1)) {
    if (
      page.cells.some(
        (cell) =>
          (cell.y <= 90 || cell.y >= 515) &&
          (isMoney(cell.text) || /^\d{2}\/\d{2}\/\d{4}$/.test(cell.text)),
      )
    )
      fail(`shifted ${definition.key} continuation financial text`);
  }
  const controlCells = new Set<Cell>();
  const controlPositions: number[] = [];
  const controls: Record<string, number> = {};
  let firstControl: { page: number; y: number } | undefined;
  for (const control of definition.controls) {
    const found = pageLines.flatMap((rows, page) =>
      rows
        .filter((row) => control.label.test(row.text))
        .map((row) => ({ row, page })),
    );
    if (found.length !== 1) fail(`missing/ambiguous ${definition.key} control`);
    const match = found[0]!;
    for (const cell of match.row.cells) controlCells.add(cell);
    controlPositions.push(match.page * 612 + 612 - match.row.y);
    if (
      !firstControl ||
      match.page < firstControl.page ||
      (match.page === firstControl.page && match.row.y > firstControl.y)
    )
      firstControl = { page: match.page, y: match.row.y };
    const amounts = match.row.cells
      .filter((cell) => isMoney(cell.text))
      .sort((a, b) => a.x - b.x);
    if (
      amounts.length !== control.moneyKeys.length ||
      amounts.some((cell, index) => {
        const bounds =
          amounts.length === 3
            ? [577, 638, 699, 760]
            : amounts.length === 2
              ? [574, 660, 760]
              : [definition.columns.at(-1)!.min, 760];
        return cell.x < bounds[index]! || cell.x >= bounds[index + 1]!;
      })
    )
      fail(`shifted ${definition.key} controls`);
    for (const [index, key] of control.moneyKeys.entries())
      controls[key] = money(amounts[index]!.text);
  }
  if (
    controlPositions.some(
      (position, index) =>
        index > 0 && position <= controlPositions[index - 1]!,
    )
  )
    fail(`reordered ${definition.key} controls`);
  for (const [index, page] of pages.entries()) {
    for (const row of pageLines[index]!) {
      if (
        row.y <= 90 ||
        row.y >= (index === 0 ? top : 515) ||
        !firstControl ||
        index < firstControl.page ||
        (index === firstControl.page && row.y > firstControl.y + 1.5)
      )
        continue;
      if (row.cells.every((cell) => controlCells.has(cell))) continue;
      if (
        /^\(TOTAL SHOULD ALSO APPEAR ON PAGE 2, STATEMENT OF ACCOUNT BALANCE, ITEM (?:[2-3][A-I]|[56])\.?\)$/.test(
          row.text,
        )
      )
        continue;
      if (
        definition.key === "loansOutstanding" &&
        [
          "(TOTAL PAYMENTS MADE SHOULD ALSO APPEAR ON PAGE 2, STATEMENT OF ACCT BALANCE, ITEM 3H.",
          "TOTAL LOAN BALANCE SHOULD ALSO APPEAR ON PAGE 2, STATEMENT OF ACCT BALANCE, ITEM 7.)",
        ].includes(row.text)
      )
        continue;
      fail(`unbound ${definition.key} text after controls`);
    }
  }
  const source = pages
    .flatMap((page, index) =>
      page.cells
        .filter(
          (cell) =>
            cell.y > 90 &&
            cell.y < (index === 0 ? top : 515) &&
            (!firstControl ||
              index < firstControl.page ||
              (index === firstControl.page && cell.y > firstControl.y + 1.5)),
        )
        .map((cell) => ({
          ...cell,
          pageNumber: page.pageNumber,
          position: index * 612 + 612 - cell.y,
        })),
    )
    .sort((a, b) => a.position - b.position || a.x - b.x);
  const dateColumn = definition.columns.find(
    (column) => column.key === "date",
  )!;
  const dates = source.filter(
    (cell) =>
      cell.x >= dateColumn.min &&
      cell.x < dateColumn.max &&
      /^\d{2}\/\d{2}\/\d{4}$/.test(cell.text),
  );
  if (source.length && !dates.length)
    fail(`unbound ${definition.key} financial text`);
  if (
    dates.length &&
    source.some((cell) => cell.position < dates[0]!.position - 1.5)
  )
    fail(`orphan ${definition.key} continuation`);
  const rows: DelawareCandidatePdfOccurrence[] = dates.map(
    (date, occurrence) => {
      const next = dates[occurrence + 1];
      const cells = source.filter(
        (cell) =>
          cell.position >= date.position - 1.5 &&
          (!next || cell.position < next.position - 1.5),
      );
      if (
        cells.some(
          (cell) =>
            !definition.columns.some(
              (column) => cell.x >= column.min && cell.x < column.max,
            ),
        )
      )
        fail(`unbound ${definition.key} column`);
      const columns: Record<string, string> = {};
      const monetaryColumns: Record<string, number> = {};
      for (const column of definition.columns) {
        const values = cells.filter(
          (cell) => cell.x >= column.min && cell.x < column.max,
        );
        columns[column.key] = clean(values.map((cell) => cell.text).join(" "));
        if (column.money) {
          if (
            values.length !== 1 ||
            Math.abs(values[0]!.position - date.position) > 1.5
          )
            fail(`missing/shifted ${definition.key} row amount`);
          monetaryColumns[column.key] = money(values[0]!.text);
        }
      }
      if (
        cells.filter(
          (cell) => cell.x >= dateColumn.min && cell.x < dateColumn.max,
        ).length !== 1
      )
        fail(`ambiguous ${definition.key} date column`);
      if (columns.activityDate) civil(columns.activityDate);
      if (
        columns.transactionId !== undefined &&
        !/^\d+$/.test(columns.transactionId)
      )
        fail(`invalid ${definition.key} transaction ID`);
      const principal = columns.name ?? columns.lender ?? columns.description;
      if (!principal) fail(`incomplete ${definition.key} row identity`);
      // Anonymous published itemized rows may explicitly omit an address.
      // Preserve the blank source column; downstream binding decides eligibility.
      return {
        occurrence,
        pageNumber: date.pageNumber,
        pageNumbers: [...new Set(cells.map((cell) => cell.pageNumber))],
        date: civil(date.text),
        columns,
        monetaryColumns,
        rawCells: cells.map(({ position: _position, ...cell }) => cell),
      };
    },
  );
  const total = (key: string) =>
    sum(rows.map((row) => row.monetaryColumns[key]!));
  if (controls.itemizedCents !== undefined) {
    if (
      total("amount") !== controls.itemizedCents ||
      sum([controls.itemizedCents, controls.anonymousCents!]) !==
        controls.grandCents
    )
      fail(`${definition.key} row/control mismatch`);
  } else if (definition.key === "loansOutstanding") {
    for (const key of ["previous", "payments", "balance"])
      if (total(key) !== controls[`${key}Cents`])
        fail(`${definition.key} row/control mismatch`);
  } else {
    if (total("amount") !== controls.totalCents)
      fail(`${definition.key} row/control mismatch`);
    if (
      controls.expenseCents !== undefined &&
      total("expense") !== controls.expenseCents
    )
      fail(`${definition.key} expense/control mismatch`);
  }
  return { rows, controls };
}

/** Source facts only. Report labels/footer versions confer no current-version authority. */
export function parseDelawareCandidateFinancialReport(
  input: Extraction,
): DelawareCandidateFinancialReport {
  const extraction = structuredClone(input);
  const { pages, cover } = extraction;
  if (
    !/^[a-f0-9]{64}$/.test(extraction.sha256) ||
    !Number.isSafeInteger(extraction.byteCount) ||
    extraction.byteCount < 5 ||
    pages.length < 11 ||
    pages.length > 100 ||
    cover.method !== "rows"
  )
    fail("incomplete positioned extraction");
  for (const [index, page] of pages.entries()) {
    if (
      page.pageNumber !== index + 1 ||
      page.width !== 792 ||
      page.height !== 612 ||
      !page.cells.length ||
      page.cells.some(
        (cell) =>
          !cell.text.trim() ||
          ![cell.x, cell.y, cell.width, cell.height].every(Number.isFinite),
      )
    )
      fail("invalid positioned page");
    if (
      page.cells.filter(
        (cell) =>
          cell.text === `Page ${index + 1} of ${pages.length}` && cell.y < 80,
      ).length !== 1
    )
      fail("missing/mismatched printed page sequence");
  }
  const first = lines(pages[0]!);
  const label = (pattern: RegExp, minimum: number, maximum = 760) => {
    const row = unique(first, pattern, "cover identity");
    const values = row.cells.filter(
      (cell) => cell.x >= minimum && cell.x < maximum,
    );
    if (values.length !== 1) fail("ambiguous cover identity value");
    return values[0]!.text;
  };
  const accountNumber = label(/^ACCOUNT NUMBER\b/, 150, 400);
  if (!/^01\d{6}$/.test(accountNumber)) fail("not a candidate account");
  const organizationName = label(/^FULL ORGANIZATION NAME:/, 165);
  const reportDate = civil(label(/^ACCOUNT NUMBER\b/, 550));
  const periodStart = civil(label(/^REPORTING PERIOD START\b/, 165, 400));
  const periodEnd = civil(label(/^REPORTING PERIOD START\b/, 550));
  if (
    periodStart > periodEnd ||
    !cover.reportingPeriodFrom ||
    !cover.reportingPeriodTo ||
    civil(cover.reportingPeriodFrom) !== periodStart ||
    civil(cover.reportingPeriodTo) !== periodEnd
  )
    fail("inconsistent cover period");
  const validatePageContext = (page: Page, shortYearAllowed: boolean) => {
    const heading = lines(page);
    const account = unique(heading, /^ACCOUNT NUMBER\b/, "schedule account");
    if (
      account.cells.filter((cell) => cell.text === accountNumber).length !== 1
    )
      fail("schedule account mismatch");
    const period = unique(heading, /REPORTING PERIOD\s*:/, "schedule period");
    const dates = page.cells
      .filter(
        (cell) =>
          cell.x > 470 &&
          Math.abs(cell.y - period.y) < 3 &&
          /^\d{2}\/\d{2}\/(?:\d{4}|\d{2})$/.test(cell.text),
      )
      .sort((a, b) => a.x - b.x);
    if (
      dates.length !== 2 ||
      dates.some((cell, index) => {
        const expected = index === 0 ? periodStart : periodEnd;
        return cell.text.length === 10
          ? civil(cell.text) !== expected
          : !shortYearAllowed ||
              cell.text !==
                `${expected.slice(5, 7)}/${expected.slice(8, 10)}/${expected.slice(2, 4)}`;
      })
    )
      fail("schedule period mismatch");
  };
  for (const page of pages.slice(1)) {
    if (
      page.cells.some((cell) =>
        /^ACCOUNT NUMBER|^REPORTING PERIOD/.test(cell.text),
      )
    )
      validatePageContext(
        page,
        page.cells.some((cell) => cell.text === "SCHEDULE F - NON-CASH ASSETS"),
      );
  }
  const titles = [
    ...new Set(definitions.map((definition) => definition.title)),
  ];
  const starts = titles.map((title) => {
    const matches = pages.flatMap((page, index) =>
      page.cells
        .filter((cell) => cell.y > 450 && cell.text === title)
        .map(() => index),
    );
    if (matches.length !== 1) fail(`missing/ambiguous ${title}`);
    return matches[0]!;
  });
  if (
    starts[0] !== 2 ||
    starts.some((start, index) => index > 0 && start <= starts[index - 1]!)
  )
    fail("missing/reordered schedule section");
  const schedules = {} as Record<
    DelawareCandidateScheduleName,
    DelawareCandidatePdfSchedule
  >;
  for (const definition of definitions) {
    const sectionIndex = titles.indexOf(definition.title);
    const start = starts[sectionIndex]!;
    const end = starts[sectionIndex + 1] ?? pages.length;
    const section = pages.slice(start, end);
    validatePageContext(section[0]!, definition.key === "assets");
    // E contains two independently headed and controlled tables on the same source page.
    if (definition.key.startsWith("reimbursements")) {
      if (section.length !== 1)
        fail("unsupported shared-expense continuation layout");
      const page = section[0]!;
      const received = definition.key === "reimbursementsReceived";
      const header = page.cells.find(
        (cell) => cell.text === (received ? "Date Received" : "Date Paid"),
      );
      if (!header) fail("missing reimbursement header");
      const control = unique(
        lines(page),
        definition.controls[0]!.label,
        "reimbursement control",
      );
      const subset = {
        ...page,
        cells: page.cells.filter(
          (cell) => cell.y <= header.y + 2 && cell.y >= control.y - 1.5,
        ),
      };
      schedules[definition.key] = parseSchedule([subset], definition);
    } else schedules[definition.key] = parseSchedule(section, definition);
  }
  const balance = lines(pages[cover.pageNumber - 1]!);
  unique(balance, /^STATEMENT OF ACCOUNT BALANCE$/, "balance heading");
  for (const [pattern, value] of [
    [/(?:^|\s)1\. BEGINNING BALANCE\b/, cover.beginningBalanceCents],
    [/SUBTOTAL \(Total of A,B,C,D\)/, cover.receiptsCents],
    [/SUBTOTAL \(Total of F,G,H,I\)/, cover.expendituresCents],
    [/(?:^|\s)4\. ENDING BALANCE\b/, cover.endingBalanceCents],
  ] as const)
    if (
      amountAt(unique(balance, pattern, "named cover control"), 600) !== value
    )
      fail("named cover mismatch");
  const supplementaryCoverControls = {
    assetsCents: amountAt(
      unique(
        balance,
        /^5\. VALUE OF NON-CASH ASSETS \(From Schedule F\)/,
        "asset cover control",
      ),
      600,
    ),
    assetsEliminatedCents: amountAt(
      unique(
        balance,
        /^6\. VALUE OF DISPOSED\/TRANSFERRED ASSETS \(From Schedule G\)/,
        "eliminated asset cover control",
      ),
      600,
    ),
    loansOutstandingCents: amountAt(
      unique(
        balance,
        /^7\. VALUE OF LOANS AT END OF PERIOD \(Loan Balance From Schedule D-2\)/,
        "outstanding loan cover control",
      ),
      600,
    ),
  };
  if (
    supplementaryCoverControls.assetsCents !==
      schedules.assets.controls.totalCents ||
    supplementaryCoverControls.assetsEliminatedCents !==
      schedules.assetsEliminated.controls.totalCents ||
    supplementaryCoverControls.loansOutstandingCents !==
      schedules.loansOutstanding.controls.balanceCents
  )
    fail("supplementary cover/schedule mismatch");
  const mapping = [
    [/^A\. SCHEDULE A - TOTAL RECEIPTS\b/, "receipts", "grandCents"],
    [
      /^B\. SCHEDULE C-1 - TOTAL IN-KIND RECEIPTS\b/,
      "inKindReceipts",
      "grandCents",
    ],
    [
      /^C\. SCHEDULE D-1 - TOTAL LOANS RECEIVED\b/,
      "loansReceived",
      "totalCents",
    ],
    [
      /^D\. SCHEDULE E - TOTAL EXPENSE REIMBURSEMENTS RECEIVED\b/,
      "reimbursementsReceived",
      "totalCents",
    ],
    [/^F\. SCHEDULE B - TOTAL EXPENDITURES\b/, "expenditures", "grandCents"],
    [
      /^G\. SCHEDULE C-2 - TOTAL IN-KIND EXPENDITURES\b/,
      "inKindExpenditures",
      "grandCents",
    ],
    [
      /^H\. SCHEDULE D-2 - LOAN AND DEBT PAYMENTS\b/,
      "loansOutstanding",
      "paymentsCents",
    ],
    [
      /^I\. SCHEDULE E - INTER COMMITTEE \(SHARED\) EXPENSES\b/,
      "reimbursementsPaid",
      "totalCents",
    ],
  ] as const;
  for (const [pattern, key, control] of mapping)
    if (
      amountAt(unique(balance, pattern, "cover schedule control"), 600) !==
      schedules[key].controls[control]
    )
      fail(`cover/${key} mismatch`);
  if (
    sum([
      cover.beginningBalanceCents,
      cover.receiptsCents,
      -cover.expendituresCents,
    ]) !== cover.endingBalanceCents ||
    sum(
      mapping
        .slice(0, 4)
        .map(([, key, control]) => schedules[key].controls[control]!),
    ) !== cover.receiptsCents ||
    sum(
      mapping
        .slice(4)
        .map(([, key, control]) => schedules[key].controls[control]!),
    ) !== cover.expendituresCents
  )
    fail("cover arithmetic mismatch");
  return {
    pdfSha256: extraction.sha256,
    byteCount: extraction.byteCount,
    accountNumber,
    organizationName,
    periodStart,
    periodEnd,
    reportDate,
    cover,
    supplementaryCoverControls,
    schedules,
    sourcePages: pages,
  };
}
export async function readDelawareCandidateFinancialReport(
  bytes: Uint8Array,
): Promise<DelawareCandidateFinancialReport> {
  return parseDelawareCandidateFinancialReport(
    await extractDelawareThirdPartyFinancialPdf(bytes),
  );
}
