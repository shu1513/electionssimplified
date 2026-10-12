import { createHash } from "node:crypto";
import {
  extractDelawareReportCover,
  parseDelawareAmountCents,
  parseDelawareCurrencyCents,
  type DelawareReportCover,
} from "./delawareCfrsParsers.js";

export type DelawareThirdPartyPdfCell = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
};
export type DelawareThirdPartyPdfPage = {
  pageNumber: number;
  width: number;
  height: number;
  cells: readonly DelawareThirdPartyPdfCell[];
};
export type DelawareThirdPartyPdfExtraction = {
  sha256: string;
  byteCount: number;
  pages: readonly DelawareThirdPartyPdfPage[];
  cover: DelawareReportCover;
};
export type DelawareThirdPartyPdfTarget = {
  direction: "support" | "oppose";
  candidateName: string;
  officeKind: "State Office";
  officeName: string;
  party: string;
  literal: string;
};
export type DelawareThirdPartyPdfOccurrence = {
  occurrence: number;
  pageNumber: number;
  date: string;
  name: string;
  address: string;
  vendor: string;
  aggregateCents: number;
  amountCents: number;
  target: DelawareThirdPartyPdfTarget | null;
  targetDiagnostic: string | null;
  rawCells: readonly DelawareThirdPartyPdfCell[];
};
export type DelawareThirdPartyFinancialReport = {
  pdfSha256: string;
  byteCount: number;
  accountNumber: string;
  organizationName: string;
  periodStart: string;
  periodEnd: string;
  reportDate: string;
  cover: DelawareReportCover;
  receipts: readonly DelawareThirdPartyPdfOccurrence[];
  expenditures: readonly DelawareThirdPartyPdfOccurrence[];
  controls: {
    receipts: {
      itemizedCents: number;
      anonymousCents: number;
      grandCents: number;
    };
    expenditures: {
      itemizedCents: number;
      anonymousCents: number;
      grandCents: number;
    };
  };
  /** Published totals only. Nonzero/negative controls require a separate source policy. */
  /** Artifact-only complete supplemental text; totals alone cannot prove no offsetting activity. */
  supplementalSourcePages: readonly DelawareThirdPartyPdfPage[];
  supplementalTotals: Readonly<
    Record<
      | "inKindReceipts"
      | "inKindExpenditures"
      | "loansReceived"
      | "loansOutstanding"
      | "reimbursementsReceived"
      | "reimbursementsPaid"
      | "assets"
      | "assetsEliminated",
      readonly number[]
    >
  >;
};
const clean = (s: string) => s.replace(/\s+/gu, " ").trim();
function fail(s: string): never {
  throw new Error(`Delaware third-party PDF: ${s}`);
}
function civil(s: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (!m) fail("invalid civil date");
  const value = `${m[3]}-${m[1]}-${m[2]}`;
  if (
    !Number.isFinite(Date.parse(value + "T00:00:00Z")) ||
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value
  )
    fail("invalid civil date");
  return value;
}
function money(s: string): number {
  if (parseDelawareCurrencyCents(s) === null) fail("invalid positioned money");
  const negative = s.startsWith("(") || s.includes("-");
  return parseDelawareAmountCents(
    (negative ? "-" : "") + s.replace(/[$,()\-]/g, ""),
  );
}
const moneyToken = (s: string) => /^(?:-?\$|\(-?\$)/.test(s);
function sum(values: readonly number[]): number {
  const total = values.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(total)) fail("unsafe monetary sum");
  return total;
}
type Line = { y: number; cells: DelawareThirdPartyPdfCell[]; text: string };
function lines(p: DelawareThirdPartyPdfPage): Line[] {
  const rows: Line[] = [];
  for (const c of p.cells) {
    let row = rows.find((r) => Math.abs(r.y - c.y) < 1.5);
    if (!row) {
      row = { y: c.y, cells: [], text: "" };
      rows.push(row);
    }
    row.cells.push(c);
  }
  return rows
    .sort((a, b) => b.y - a.y)
    .map((r) => ({
      ...r,
      cells: r.cells.sort((a, b) => a.x - b.x),
      text: clean(r.cells.map((c) => c.text).join(" ")),
    }));
}
function unique(ls: readonly Line[], re: RegExp, label: string): Line {
  const found = ls.filter((l) => re.test(l.text));
  if (found.length !== 1) fail(`missing/ambiguous ${label}`);
  return found[0]!;
}
function amountAt(line: Line, minX: number, maxX = 760): number {
  const cells = line.cells.filter(
    (c) => c.x >= minX && c.x < maxX && moneyToken(c.text),
  );
  if (cells.length !== 1) fail("missing/shifted amount column");
  return money(cells[0]!.text);
}
function pageFor(
  pages: readonly DelawareThirdPartyPdfPage[],
  title: string,
): DelawareThirdPartyPdfPage {
  const found = pages.filter((p) =>
    p.cells.some((c) => c.y > 450 && clean(c.text) === title),
  );
  if (found.length !== 1) fail(`missing/unsupported continuation ${title}`);
  return found[0]!;
}
function targetFrom(nameLines: readonly Line[]): {
  name: string;
  target: DelawareThirdPartyPdfTarget | null;
  targetDiagnostic: string | null;
} {
  const starts = nameLines
    .map((l, i) => (/^(?:Support|Oppose) of\b/.test(l.text) ? i : -1))
    .filter((i) => i >= 0);
  if (!starts.length)
    return {
      name: clean(nameLines.map((l) => l.text).join(" ")),
      target: null,
      targetDiagnostic: "No explicit single-target financial caption.",
    };
  const prefix = clean(
    nameLines
      .slice(0, starts[0])
      .map((l) => l.text)
      .join(" "),
  );
  const literal = clean(
    nameLines
      .slice(starts[0])
      .map((l) => l.text)
      .join(" "),
  );
  const match =
    /^(Support|Oppose) of (.+) - (State Office) - (.+) - (.+)$/.exec(literal);
  if (starts.length !== 1 || !prefix || !match)
    return {
      name: prefix || clean(nameLines.map((l) => l.text).join(" ")),
      target: null,
      targetDiagnostic:
        "Multiple or unsupported target captions remain unallocated.",
    };
  return {
    name: prefix,
    target: {
      direction: match[1] === "Support" ? "support" : "oppose",
      candidateName: match[2]!,
      officeKind: "State Office",
      officeName: match[4]!,
      party: match[5]!,
      literal,
    },
    targetDiagnostic: null,
  };
}
function schedule(
  p: DelawareThirdPartyPdfPage,
  kind: "receipts" | "expenditures",
) {
  const ls = lines(p),
    isReceipt = kind === "receipts";
  const itemized = unique(
    ls,
    isReceipt ? /^TOTAL ITEMIZED RECEIPTS\b/ : /^TOTAL ITEMIZED EXPENDITURES\b/,
    "itemized control",
  );
  const anonymous = unique(
    ls,
    isReceipt
      ? /^TOTAL OF CONTRIBUTIONS NOT EXCEEDING \$100\b/
      : /^TOTAL OF EXPENDITURES NOT EXCEEDING \$100\b/,
    "anonymous control",
  );
  const grand = unique(
    ls,
    isReceipt ? /^GRAND TOTAL RECEIPTS\b/ : /^GRAND TOTAL EXPENDITURES\b/,
    "grand control",
  );
  const headers = isReceipt
    ? ([
        [/^Date Received$/, 40, 130],
        [/^Contributor Name$/, 140, 325],
        [/^Contributor Mailing Address$/, 326, 548],
        [/^Aggregate Amount$/, 549, 649],
        [/^Amount Received$/, 649, 760],
      ] as const)
    : ([
        [/^Date Expended$/, 38, 128],
        [/^Payee Name$/, 128, 276],
        [/^Payee Mailing Address$/, 276, 432],
        [/^Vendor$/, 432, 593],
        [/^Aggregate$/, 593, 673],
        [/^Expended$/, 673, 760],
      ] as const);
  for (const [re, lo, hi] of headers)
    if (
      p.cells.filter(
        (c) =>
          re.test(clean(c.text)) && c.x >= lo && c.x < hi && c.y > itemized.y,
      ).length !== 1
    )
      fail("missing/shifted schedule column header");
  const head = p.cells.find((c) => headers[0][0].test(clean(c.text)))!;
  const body = p.cells.filter(
    (c) => c.y < head.y - 8 && c.y > itemized.y + 1.5,
  );
  const dates = body
    .filter(
      (c) =>
        c.x >= 38 &&
        c.x < (isReceipt ? 140 : 128) &&
        /^\d{2}\/\d{2}\/\d{4}$/.test(c.text),
    )
    .sort((a, b) => b.y - a.y);
  const rows: DelawareThirdPartyPdfOccurrence[] = [];
  const used = new Set<DelawareThirdPartyPdfCell>();
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i]!,
      bottom = dates[i + 1]?.y ?? itemized.y;
    const cells = body.filter((c) => c.y <= d.y + 1.5 && c.y > bottom + 1.5);
    cells.forEach((c) => used.add(c));
    const ranges = isReceipt ? [140, 326, 549, 649] : [128, 276, 432, 593, 673];
    const nameCells = cells.filter(
      (c) => c.x >= ranges[0]! && c.x < ranges[1]!,
    );
    const nameLines = lines({ ...p, cells: nameCells });
    const parsed = isReceipt
      ? {
          name: clean(nameLines.map((l) => l.text).join(" ")),
          target: null,
          targetDiagnostic: null,
        }
      : targetFrom(nameLines);
    const address = clean(
      lines({
        ...p,
        cells: cells.filter((c) => c.x >= ranges[1]! && c.x < ranges[2]!),
      })
        .map((l) => l.text)
        .join(" "),
    );
    const vendor = isReceipt
      ? ""
      : clean(
          lines({ ...p, cells: cells.filter((c) => c.x >= 432 && c.x < 593) })
            .map((l) => l.text)
            .join(" "),
        );
    const financialCells = cells.filter(
      (c) => c.x >= (isReceipt ? 549 : 593) && c.x < 760,
    );
    if (
      financialCells.length !== 2 ||
      financialCells.some((c) => Math.abs(c.y - d.y) >= 1.5)
    )
      fail("additional/unaligned financial cells in itemized row");
    const amounts = {
      y: d.y,
      cells: cells.filter((c) => Math.abs(c.y - d.y) < 1.5),
      text: "",
    };
    const aggregateCents = amountAt(
        amounts,
        isReceipt ? 549 : 593,
        isReceipt ? 649 : 673,
      ),
      amountCents = amountAt(amounts, isReceipt ? 649 : 673);
    if (
      !parsed.name ||
      !address ||
      cells.filter((c) => c.x >= 38 && c.x < (isReceipt ? 140 : 128)).length !==
        1
    )
      fail("incomplete financial row identity");
    rows.push({
      occurrence: i,
      pageNumber: p.pageNumber,
      date: civil(d.text),
      ...parsed,
      address,
      vendor,
      aggregateCents,
      amountCents,
      rawCells: cells,
    });
  }
  if (body.some((c) => !used.has(c)))
    fail("unbound financial text in schedule body");
  const control = {
    itemizedCents: amountAt(itemized, 650),
    anonymousCents: amountAt(anonymous, 650),
    grandCents: amountAt(grand, 650),
  };
  if (
    sum(rows.map((r) => r.amountCents)) !== control.itemizedCents ||
    sum([control.itemizedCents, control.anonymousCents]) !== control.grandCents
  )
    fail("schedule row/control mismatch");
  return { rows, control };
}

/** Bounded source extraction. Returns facts only; no report-current/local money authority. */
export async function extractDelawareThirdPartyFinancialPdf(
  bytes: Uint8Array,
): Promise<DelawareThirdPartyPdfExtraction> {
  // Retain one byte generation before dynamic imports/PDF extraction can yield.
  bytes = new Uint8Array(bytes);
  if (
    bytes.byteLength < 5 ||
    bytes.byteLength > 4 * 1024 * 1024 ||
    Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-"
  )
    fail("invalid PDF bytes/size");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
  });
  const pages: DelawareThirdPartyPdfPage[] = [];
  let count = 0;
  try {
    const pdf = await task.promise;
    if (pdf.numPages < 1 || pdf.numPages > 100) fail("page limit");
    for (let n = 1; n <= pdf.numPages; n++) {
      const p = await pdf.getPage(n);
      if (
        p.rotate !== 0 ||
        p.view[0] !== 0 ||
        p.view[1] !== 0 ||
        p.view[2] !== 792 ||
        p.view[3] !== 612
      )
        fail("unsupported page geometry");
      const content = await p.getTextContent();
      const cells: DelawareThirdPartyPdfCell[] = [];
      for (const item of content.items) {
        if (!("str" in item) || !clean(item.str)) continue;
        const [a, b, c, d, x, y] = item.transform;
        if (
          ![a, b, c, d, x, y, item.width, item.height].every(Number.isFinite) ||
          Math.abs(b!) > 0.001 ||
          Math.abs(c!) > 0.001
        )
          fail("unsupported text geometry");
        cells.push({
          text: clean(item.str),
          x: x!,
          y: y!,
          width: item.width,
          height: item.height,
        });
        if (++count > 100000) fail("text limit");
      }
      if (!cells.length) fail("image-only/empty source page");
      pages.push({ pageNumber: n, width: 792, height: 612, cells });
    }
  } finally {
    await task.destroy();
  }
  return {
    sha256,
    byteCount: bytes.byteLength,
    pages,
    cover: await extractDelawareReportCover(new Uint8Array(bytes)),
  };
}
export function parseDelawareThirdPartyFinancialReport(
  extraction: DelawareThirdPartyPdfExtraction,
): DelawareThirdPartyFinancialReport {
  extraction = structuredClone(extraction);
  const { pages, cover } = extraction;
  if (
    !/^[a-f0-9]{64}$/.test(extraction.sha256) ||
    !Number.isSafeInteger(extraction.byteCount) ||
    extraction.byteCount < 5 ||
    pages.length < 11 ||
    cover.method !== "rows"
  )
    fail("incomplete positioned report extraction");
  for (const [index, p] of pages.entries())
    if (
      p.pageNumber !== index + 1 ||
      p.width !== 792 ||
      p.height !== 612 ||
      !p.cells.length ||
      p.cells.some(
        (c) =>
          !c.text.trim() ||
          ![c.x, c.y, c.width, c.height].every(Number.isFinite),
      )
    )
      fail("invalid positioned page");
  const first = lines(pages[0]!);
  const label = (re: RegExp, min: number, max = 760) => {
    const row = unique(first, re, "cover identity");
    const cells = row.cells.filter((c) => c.x >= min && c.x < max);
    if (cells.length !== 1) fail("ambiguous cover identity value");
    return cells[0]!.text;
  };
  const accountNumber = label(/^ACCOUNT NUMBER\b/, 150, 400),
    organizationName = label(/^FULL ORGANIZATION NAME:/, 165),
    reportDate = civil(label(/^ACCOUNT NUMBER\b/, 550));
  if (!/^04\d{6}$/.test(accountNumber)) fail("not a third-party account");
  const periodStart = civil(label(/^REPORTING PERIOD START\b/, 165, 400)),
    periodEnd = civil(label(/^REPORTING PERIOD START\b/, 550));
  if (
    periodStart > periodEnd ||
    cover.reportingPeriodFrom === null ||
    cover.reportingPeriodTo === null ||
    civil(cover.reportingPeriodFrom) !== periodStart ||
    civil(cover.reportingPeriodTo) !== periodEnd
  )
    fail("inconsistent report period");
  for (const p of pages.slice(1)) {
    const ls = lines(p),
      account = unique(ls, /^ACCOUNT NUMBER\b/, "account");
    if (account.cells.filter((c) => c.text === accountNumber).length !== 1)
      fail("schedule account mismatch");
    const period = unique(ls, /REPORTING PERIOD\s*:/, "period");
    // This published template places two period fields up to 2.45pt apart.
    const dates = p.cells
      .filter(
        (c) =>
          c.x > 470 &&
          Math.abs(c.y - period.y) < 3 &&
          /^\d{2}\/\d{2}\/(?:\d{4}|\d{2})$/.test(c.text),
      )
      .sort((a, b) => a.x - b.x);
    const matches = (raw: string, expected: string) =>
      raw.length === 10
        ? civil(raw) === expected
        : // Schedule F prints only YY; bind it to the full-date cover, never infer a century.
          p.cells.some((c) => c.text === "SCHEDULE F - NON-CASH ASSETS") &&
          raw ===
            `${expected.slice(5, 7)}/${expected.slice(8, 10)}/${expected.slice(2, 4)}`;
    if (
      dates.length !== 2 ||
      !matches(dates[0]!.text, periodStart) ||
      !matches(dates[1]!.text, periodEnd)
    )
      fail("schedule period mismatch");
  }
  const receipts = schedule(
      pageFor(pages, "SCHEDULE A - TOTAL RECEIPTS"),
      "receipts",
    ),
    expenditures = schedule(
      pageFor(pages, "SCHEDULE B - TOTAL EXPENDITURES"),
      "expenditures",
    );
  const balance = lines(pages[cover.pageNumber - 1]!);
  unique(balance, /^STATEMENT OF ACCOUNT BALANCE$/, "balance heading");
  const named = [
    [/(?:^|\s)1\. BEGINNING BALANCE\b/, cover.beginningBalanceCents],
    [/SUBTOTAL \(Total of A,B,C,D\)/, cover.receiptsCents],
    [/SUBTOTAL \(Total of F,G,H,I\)/, cover.expendituresCents],
    [/(?:^|\s)4\. ENDING BALANCE\b/, cover.endingBalanceCents],
  ] as const;
  if (
    named.some(
      ([re, cents]) =>
        amountAt(unique(balance, re, "named balance control"), 600) !== cents,
    ) ||
    sum([
      cover.beginningBalanceCents,
      cover.receiptsCents,
      -cover.expendituresCents,
    ]) !== cover.endingBalanceCents
  )
    fail("inconsistent named cover controls");
  if (
    amountAt(
      unique(balance, /^A\. SCHEDULE A - TOTAL RECEIPTS\b/, "receipt cover"),
      600,
    ) !== receipts.control.grandCents ||
    amountAt(
      unique(
        balance,
        /^F\. SCHEDULE B - TOTAL EXPENDITURES\b/,
        "expense cover",
      ),
      600,
    ) !== expenditures.control.grandCents
  )
    fail("cover/schedule mismatch");
  const totals = (title: string, re: RegExp, count: number) => {
    const line = unique(
      lines(pageFor(pages, title)),
      re,
      "supplemental control",
    );
    const cells = line.cells
      .filter((c) => c.x > 590 && moneyToken(c.text))
      .sort((a, b) => a.x - b.x);
    if (cells.length !== count) fail("missing supplemental total");
    return cells.map((c) => money(c.text));
  };
  return {
    pdfSha256: extraction.sha256,
    byteCount: extraction.byteCount,
    accountNumber,
    organizationName,
    periodStart,
    periodEnd,
    reportDate,
    cover,
    receipts: receipts.rows,
    expenditures: expenditures.rows,
    controls: {
      receipts: receipts.control,
      expenditures: expenditures.control,
    },
    supplementalSourcePages: pages.filter((p) =>
      p.cells.some(
        (c) => c.y > 450 && /^SCHEDULE (?:C-[12]|D-[12]|[EFG]) - /.test(c.text),
      ),
    ),
    supplementalTotals: {
      inKindReceipts: totals(
        "SCHEDULE C-1 - TOTAL IN-KIND RECEIPTS",
        /^GRAND TOTAL RECEIPTS\b/,
        1,
      ),
      inKindExpenditures: totals(
        "SCHEDULE C-2 - TOTAL IN-KIND EXPENDITURES",
        /^GRAND TOTAL EXPENDITURES\b/,
        1,
      ),
      loansReceived: totals(
        "SCHEDULE D-1 - TOTAL LOANS RECEIVED AND DEBTS INCURRED",
        /^TOTAL LOANS RECEIVED\b/,
        1,
      ),
      loansOutstanding: totals(
        "SCHEDULE D-2 - TOTAL LOANS AND DEBTS OUTSTANDING",
        /^TOTAL LOANS\b/,
        3,
      ),
      reimbursementsReceived: totals(
        "SCHEDULE E - INTER COMMITTEE (SHARED) EXPENSES",
        /^TOTAL REIMBURSEMENTS RECEIVED\b/,
        2,
      ),
      reimbursementsPaid: totals(
        "SCHEDULE E - INTER COMMITTEE (SHARED) EXPENSES",
        /^TOTAL REIMBURSEMENTS PAID\b/,
        2,
      ),
      assets: totals("SCHEDULE F - NON-CASH ASSETS", /^TOTAL ASSET VALUE\b/, 1),
      assetsEliminated: totals(
        "SCHEDULE G - ELIMINATION OF ASSETS",
        /^TOTAL ASSETS ELIMINATED\b/,
        1,
      ),
    },
  };
}
export async function readDelawareThirdPartyFinancialReport(
  bytes: Uint8Array,
): Promise<DelawareThirdPartyFinancialReport> {
  return parseDelawareThirdPartyFinancialReport(
    await extractDelawareThirdPartyFinancialPdf(bytes),
  );
}
