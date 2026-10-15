import { createHash } from "node:crypto";

/** Source controls only. These facts establish neither report edition nor currentness. */
export type VermontControlPdfCell = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
};
export type VermontControlPdfPage = {
  pageNumber: number;
  width: number;
  height: number;
  cells: readonly VermontControlPdfCell[];
};
export type VermontReportControlFacts = {
  receivingFilerName: string;
  candidateFullName: string;
  officeName: string;
  electionLabel: string;
  reportName: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  originalFiledDate: string | null;
  summary: {
    beginningBalanceCents: number;
    surplusPreviousCampaignCents: number;
    monetaryContributionsPeriodCents: number;
    monetaryContributionsCycleCents: number;
    monetaryExpendituresPeriodCents: number;
    monetaryExpendituresCycleCents: number;
    endingBalanceCents: number;
  };
  controls: {
    cashOver100Cents: number;
    cash100OrLessCents: number;
    loansReceivedCents: number;
    refundedContributionsCents: number;
    totalMonetaryContributionsCents: number;
    monetaryExpendituresCents: number;
    loanPaymentsCents: number;
    refundedExpendituresCents: number;
    totalMonetaryExpendituresCents: number;
    massMediaExpendituresCents: number;
    refundedMassMediaExpendituresCents: number;
    totalMassMediaExpendituresCents: number | null;
    loanOutstandingBeginningCents: number;
    loanReceivedSummaryCents: number;
    loanSubtotalCents: number;
    loanPaymentsSummaryCents: number;
    loanForgivenCents: number;
    loanOutstandingEndingCents: number;
    inKindContributionsCents: number;
    refundedInKindContributionsCents: number;
    totalInKindContributionsCents: number;
    inKindExpendituresCents: number;
    refundedInKindExpendituresCents: number;
    totalInKindExpendituresCents: number;
    inKindTransactionBalanceCents: number;
  };
  counts: {
    cashOver100: number | null;
    cash100OrLess: number | null;
    loansReceived: number | null;
    monetaryExpenditures: number | null;
    massMediaExpenditures: number | null;
  };
};
const clean = (value: string) => value.replace(/\s+/gu, " ").trim();
function fail(label: string): never {
  throw new Error(`Vermont report control PDF: ${label}`);
}
function one<T>(values: readonly T[], label: string): T {
  if (values.length !== 1) fail(`missing or ambiguous ${label}`);
  return values[0]!;
}
function civil(raw: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  if (!m) fail("invalid civil date");
  const value = `${m[3]}-${m[1]}-${m[2]}`;
  const n = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(n) || new Date(n).toISOString().slice(0, 10) !== value)
    fail("invalid civil date");
  return value;
}
function money(raw: string): number {
  const m = /^(-?)\$((?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+))\.(\d{2})$/.exec(
    raw,
  );
  if (!m) fail("invalid currency control");
  const cents = BigInt(m[2]!.replaceAll(",", "")) * 100n + BigInt(m[3]!);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) fail("unsafe currency control");
  return (m[1] ? -1 : 1) * Number(cents);
}
const looksMoney = (cell: VermontControlPdfCell) => /^[-(]?\$/.test(cell.text);
function sum(...values: number[]): number {
  let result = 0;
  for (const value of values) {
    result += value;
    if (!Number.isSafeInteger(result)) fail("unsafe control arithmetic");
  }
  return result;
}
function equal(actual: number, expected: number, label: string) {
  if (actual !== expected) fail(`inconsistent ${label}`);
}
function labelAt(
  page: VermontControlPdfPage,
  value: string,
  minX: number,
  maxX: number,
  minY = 0,
): VermontControlPdfCell {
  return one(
    page.cells.filter(
      (c) => c.text === value && c.x >= minX && c.x < maxX && c.y >= minY,
    ),
    value,
  );
}
function field(
  page: VermontControlPdfPage,
  label: VermontControlPdfCell,
  minX: number,
  maxX: number,
  nullable = false,
): string | null {
  const values = page.cells.filter(
    (c) => c.x >= minX && c.x < maxX && Math.abs(c.y - label.y) <= 1.5,
  );
  if (!values.length && nullable) return null;
  if (values.some((c) => c.x + c.width > maxX + 1))
    fail("shifted identity or date column");
  return one(values, "identity or date value").text;
}

/** Uses the observed A4 cover, summary and detailed-summary columns, not free-text order. */
export function parseVermontReportControlPages(
  input: readonly VermontControlPdfPage[],
): VermontReportControlFacts {
  const pages = input.map((p) => ({
    ...p,
    cells: p.cells.map((c) => ({ ...c, text: clean(c.text) })),
  }));
  if (
    pages.length !== 3 ||
    pages.some(
      (p, i) =>
        p.pageNumber !== i + 1 ||
        p.width !== 595 ||
        p.height !== 842 ||
        !p.cells.length,
    )
  )
    fail("unsupported control-page geometry");
  for (const p of pages)
    for (const c of p.cells) {
      if (
        !c.text ||
        ![c.x, c.y, c.width, c.height].every(Number.isFinite) ||
        c.width < 0 ||
        c.height <= 0 ||
        c.x < 0 ||
        c.y < 0 ||
        c.x + c.width > p.width + 1 ||
        c.y + c.height > p.height + 1
      )
        fail("invalid positioned cell");
    }
  const cover = pages[0]!;
  const summaryPage = pages[1]!;
  const detail = pages[2]!;
  const candidateFullName = field(
    cover,
    labelAt(cover, "Candidate Name", 20, 140, 650),
    140,
    430,
  )!;
  const officeName = field(
    cover,
    labelAt(cover, "Office Sought", 20, 140, 650),
    140,
    430,
  )!;
  const electionLabel = field(
    cover,
    labelAt(cover, "Election Cycle:", 20, 140),
    190,
    570,
  )!;
  const reportName = field(
    cover,
    labelAt(cover, "Report Name:", 20, 140),
    190,
    570,
  )!;
  labelAt(cover, "Reporting Period:", 20, 140);
  const periodStart = civil(
    field(cover, labelAt(cover, "Start Date:", 190, 260), 270, 370)!,
  );
  const periodEnd = civil(
    field(cover, labelAt(cover, "End Date:", 370, 470), 480, 570)!,
  );
  const dueDate = civil(
    field(cover, labelAt(cover, "Due Date:", 190, 260), 270, 370)!,
  );
  const filed = field(
    cover,
    labelAt(cover, "Original Filed Date:", 370, 470),
    480,
    570,
    true,
  );
  const originalFiledDate = filed === null ? null : civil(filed);
  if (periodStart > periodEnd) fail("reversed reporting period");
  // The source includes a separate system title above these two running-header lines.
  function runningOwner(p: VermontControlPdfPage): string {
    const heading = one(
      p.cells.filter(
        (c) => c.text === reportName && c.x >= 440 && c.y >= 780 && c.y < 810,
      ),
      "running report heading",
    );
    return one(
      p.cells.filter(
        (c) =>
          c.x >= 440 &&
          Math.abs(c.x - heading.x) <= 1 &&
          c.y - heading.y >= 9 &&
          c.y - heading.y <= 12,
      ),
      "filer header",
    ).text;
  }
  const receivingFilerName = runningOwner(cover);
  for (const p of [summaryPage, detail]) {
    if (runningOwner(p) !== receivingFilerName)
      fail("conflicting control-page identity");
  }
  labelAt(summaryPage, "SECTION 5: SUMMARY PAGE", 20, 300);
  labelAt(summaryPage, "THIS PERIOD", 300, 435);
  labelAt(summaryPage, "CAMPAIGN TO DATE", 450, 575);
  const consumedSummary = new Set<VermontControlPdfCell>();
  function summaryAmount(prefix: string, cycle = false): number {
    const label = one(
      summaryPage.cells.filter(
        (c) => c.x >= 20 && c.x < 300 && c.text.startsWith(prefix),
      ),
      prefix,
    );
    const candidates = summaryPage.cells.filter(
      (c) => looksMoney(c) && Math.abs(c.y - label.y) <= 6,
    );
    const amount = one(
      candidates.filter((c) => (cycle ? c.x >= 450 : c.x >= 310 && c.x < 440)),
      "summary money column",
    );
    const edge = cycle ? 570 : 426;
    if (
      Math.abs(amount.x + amount.width - edge) > 1.2 ||
      amount.x < (cycle ? 450 : 310)
    )
      fail("shifted summary money column");
    consumedSummary.add(amount);
    return money(amount.text);
  }
  const summary = {
    beginningBalanceCents: summaryAmount(
      "A. Beginning Balance at the Start of the Reporting Period",
    ),
    surplusPreviousCampaignCents: summaryAmount(
      "A1. Surplus Amount from Previous Campaign",
      true,
    ),
    monetaryContributionsPeriodCents: summaryAmount(
      "B. Total Monetary Contributions",
    ),
    monetaryContributionsCycleCents: summaryAmount(
      "B. Total Monetary Contributions",
      true,
    ),
    monetaryExpendituresPeriodCents: summaryAmount(
      "C. Total Monetary Expenditures",
    ),
    monetaryExpendituresCycleCents: summaryAmount(
      "C. Total Monetary Expenditures",
      true,
    ),
    endingBalanceCents: summaryAmount(
      "D. Ending Balance at the End of the Reporting Period",
    ),
  };
  // A-D contains exactly these seven controls; a shifted or extra amount cannot hide.
  const yTop = labelAt(summaryPage, "Monetary Transactions", 20, 300).y;
  const yBottom =
    one(
      summaryPage.cells.filter(
        (c) => c.text.startsWith("D. Ending Balance") && c.x < 300,
      ),
      "ending label",
    ).y - 10;
  if (
    summaryPage.cells.some(
      (c) =>
        looksMoney(c) &&
        c.y < yTop &&
        c.y >= yBottom &&
        !consumedSummary.has(c),
    )
  )
    fail("unbound summary money");
  const detailMoney = new Set<VermontControlPdfCell>();
  const rowYs = new Map<number, number>();
  const captions = [
    "Monetary Contributions over $100",
    "Monetary Contributions $100 or less",
    "Loans Received During this Reporting Period",
    "Refunded Contributions",
    "Total Monetary Contributions",
    "Monetary Expenditures",
    "Loan Payments",
    "Refunded Expenditures",
    "Total Monetary Expenditures",
    "Expenditures used in a Mass Media Activity",
    "Refunded Expenditures used in a Mass Media Activity",
    "Total Mass Media Expenditures",
    "Outstanding Balance from Previous Reporting Period",
    "Loans Received During this Reporting Period",
    "Subtotal",
    "Loan Payments Made During this Reporting Period",
    "Loan Amount Forgiven During this Reporting Period",
    "Loan Amount Due at the End of This Reporting Period",
    "In-Kind (Non-Money) Contributions",
    "Refunded In-Kind (Non-Money) Contributions",
    "Total In-Kind (Non-Money) Contributions",
    "In-Kind (Non-Money) Expenditures",
    "Refunded In-Kind (Non-Money) Expenditures",
    "Total In-Kind (Non-Money) Expenditures",
    "Total In-Kind (Non-Money) Transaction Balance",
  ];
  function rowAmount(n: number, nullable = false): number | null {
    const anchor = one(
      detail.cells.filter((c) => c.x >= 20 && c.x < 42 && c.text === `${n}.`),
      "numbered financial control",
    );
    rowYs.set(n, anchor.y);
    const label = detail.cells
      .filter((c) => c.x >= 42 && c.x < 300 && Math.abs(c.y - anchor.y) <= 6)
      .sort((a, b) => b.y - a.y || a.x - b.x)
      .map((c) => c.text)
      .join(" ");
    if (!label.startsWith(captions[n - 1]!))
      fail("unsupported numbered control caption");
    const candidates = detail.cells.filter(
      (c) => looksMoney(c) && c.x >= 300 && Math.abs(c.y - anchor.y) <= 6,
    );
    if (!candidates.length && nullable) return null;
    const amount = one(candidates, "detailed money column");
    if (
      amount.x < 450 ||
      Math.min(
        Math.abs(amount.x + amount.width - 569),
        Math.abs(amount.x + amount.width - 570),
      ) > 1.2
    )
      fail("shifted detailed money column");
    detailMoney.add(amount);
    return money(amount.text);
  }
  const values = captions.map((_, i) => rowAmount(i + 1, i === 11));
  if (
    detail.cells.some(
      (c) =>
        looksMoney(c) &&
        c.x >= 300 &&
        c.y >= 110 &&
        c.y <= 740 &&
        !detailMoney.has(c),
    )
  )
    fail("unbound detailed money");
  function count(n: number, caption: string): number | null {
    const y = rowYs.get(n)!;
    const cells = detail.cells
      .filter((c) => c.x >= 300 && c.x < 430 && Math.abs(c.y - y) <= 1.5)
      .sort((a, b) => a.x - b.x);
    if (cells.some((c) => c.x + c.width > 430)) fail("shifted count column");
    const raw = cells.map((c) => c.text).join(" ");
    if (raw === caption) return null;
    if (!raw.startsWith(caption)) fail("missing count label");
    const value = raw.slice(caption.length).trim();
    if (!/^(?:0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)))
      fail("invalid count control");
    return Number(value);
  }
  const v = (n: number) => values[n - 1]! as number;
  const controls = {
    cashOver100Cents: v(1),
    cash100OrLessCents: v(2),
    loansReceivedCents: v(3),
    refundedContributionsCents: v(4),
    totalMonetaryContributionsCents: v(5),
    monetaryExpendituresCents: v(6),
    loanPaymentsCents: v(7),
    refundedExpendituresCents: v(8),
    totalMonetaryExpendituresCents: v(9),
    massMediaExpendituresCents: v(10),
    refundedMassMediaExpendituresCents: v(11),
    totalMassMediaExpendituresCents: values[11]!,
    loanOutstandingBeginningCents: v(13),
    loanReceivedSummaryCents: v(14),
    loanSubtotalCents: v(15),
    loanPaymentsSummaryCents: v(16),
    loanForgivenCents: v(17),
    loanOutstandingEndingCents: v(18),
    inKindContributionsCents: v(19),
    refundedInKindContributionsCents: v(20),
    totalInKindContributionsCents: v(21),
    inKindExpendituresCents: v(22),
    refundedInKindExpendituresCents: v(23),
    totalInKindExpendituresCents: v(24),
    inKindTransactionBalanceCents: v(25),
  };
  equal(v(5), sum(v(1), v(2), v(3), -v(4)), "monetary contribution controls");
  equal(v(9), sum(v(6), v(7), -v(8)), "monetary expenditure controls");
  if (values[11] !== null)
    equal(v(12), sum(v(10), -v(11)), "mass-media controls");
  equal(v(15), sum(v(13), v(14)), "loan subtotal");
  equal(v(18), sum(v(15), -v(16), -v(17)), "loan ending balance");
  equal(v(3), v(14), "loan receipt controls");
  equal(v(7), v(16), "loan payment controls");
  equal(v(21), sum(v(19), -v(20)), "in-kind contribution controls");
  equal(v(24), sum(v(22), -v(23)), "in-kind expenditure controls");
  equal(v(25), sum(v(21), -v(24)), "in-kind balance");
  equal(
    summary.monetaryContributionsPeriodCents,
    v(5),
    "receipt summary agreement",
  );
  equal(
    summary.monetaryExpendituresPeriodCents,
    v(9),
    "expense summary agreement",
  );
  equal(
    summary.endingBalanceCents,
    sum(summary.beginningBalanceCents, v(5), -v(9)),
    "period balance",
  );
  equal(
    summary.endingBalanceCents,
    sum(
      summary.surplusPreviousCampaignCents,
      summary.monetaryContributionsCycleCents,
      -summary.monetaryExpendituresCycleCents,
    ),
    "campaign balance",
  );
  return {
    receivingFilerName,
    candidateFullName,
    officeName,
    electionLabel,
    reportName,
    periodStart,
    periodEnd,
    dueDate,
    originalFiledDate,
    summary,
    controls,
    counts: {
      cashOver100: count(1, "Number of Transactions:"),
      cash100OrLess: count(2, "Number of Contributors:"),
      loansReceived: count(3, "Number of Transactions:"),
      monetaryExpenditures: count(6, "Number of Transactions:"),
      massMediaExpenditures: count(10, "Number of Transactions:"),
    },
  };
}

/** Copies untouched bytes before awaiting; returns no contact-bearing pages or editions. */
export async function readVermontReportControlPdf(input: Uint8Array): Promise<
  VermontReportControlFacts & {
    pdfSha256: string;
    byteCount: number;
    pageCount: number;
  }
> {
  const bytes = new Uint8Array(input);
  if (
    bytes.length < 5 ||
    bytes.length > 20 * 1024 * 1024 ||
    Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-"
  )
    fail("invalid PDF bytes or size");
  const pdfSha256 = createHash("sha256").update(bytes).digest("hex");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
  });
  try {
    const pdf = await task.promise;
    if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 3)
      fail("missing control pages");
    const pages: VermontControlPdfPage[] = [];
    for (let n = 1; n <= 3; n++) {
      const page = await pdf.getPage(n);
      if (
        page.rotate !== 0 ||
        page.view[0] !== 0 ||
        page.view[1] !== 0 ||
        page.view[2] !== 595 ||
        page.view[3] !== 842
      )
        fail("unsupported control-page geometry");
      const content = await page.getTextContent();
      const cells: VermontControlPdfCell[] = [];
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
          text: item.str,
          x: x!,
          y: y!,
          width: item.width,
          height: item.height,
        });
        if (cells.length > 10000) fail("control text limit");
      }
      pages.push({ pageNumber: n, width: 595, height: 842, cells });
    }
    return {
      ...parseVermontReportControlPages(pages),
      pdfSha256,
      byteCount: bytes.length,
      pageCount: pdf.numPages,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Vermont report control PDF:")
    )
      throw error;
    fail("could not extract source PDF");
  } finally {
    await task.destroy();
  }
}
