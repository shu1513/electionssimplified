import {
  PHOENIX_PORTAL_BASE_URL,
  PHOENIX_REPORT_PACKAGE_GUID,
  phoenixCandidateCycleForDate,
} from "./phoenixEfilingClient.js";
import { aggregatePhoenixDirectFinance } from "./phoenixDirectFinanceAggregator.js";
import {
  parsePhoenixReportPages,
  type PhoenixPdfPage,
  type PhoenixParsedReport,
} from "./phoenixReportPdfParser.js";
import {
  parsePhoenixCommitteeCashReport,
  type PhoenixCommitteeCashReport,
} from "./phoenixCommitteeCashPdfParser.js";

export type PhoenixCommitteeCashObservation = {
  /** Complete source-scoped arrays, acquired by phoenixGridAll. No paging or
   * version precedence is inferred from row SubmittedDate metadata. */
  grids: {
    contributors: readonly Record<string, unknown>[];
    expenditures: readonly Record<string, unknown>[];
    loans: readonly Record<string, unknown>[];
    noActivityContributors: readonly Record<string, unknown>[];
    noActivityExpenditures: readonly Record<string, unknown>[];
  };
  reports: readonly {
    reportPackageId: string;
    pages: readonly PhoenixPdfPage[];
  }[];
};
export type PhoenixCommitteeCashPosition = {
  committeeId: string;
  committeeName: string;
  committeeType: "Political Action Committee";
  grossCents: number;
  refundCents: number;
  netCents: number;
  contributionCount: number;
  refundCount: number;
  sourceUrl: string;
};
export type PhoenixCommitteeCashQualificationInput = {
  copId: string;
  committeeName: string;
  officeSought: string;
  portalCycleStart: string;
  portalCycleEnd: string;
  before: PhoenixCommitteeCashObservation;
  after: PhoenixCommitteeCashObservation;
  priorReportPeriods?: readonly { periodFrom: string; periodTo: string }[];
};

function fail(reason: string): never {
  throw new Error(`Phoenix committee cash qualification: ${reason}`);
}
function name(value: string): string {
  return value.normalize("NFKC").toUpperCase().replace(/\s+/gu, " ").trim();
}
function cents(value: number): number {
  if (!Number.isSafeInteger(value)) return fail("unsafe cents");
  return value;
}
function add(a: number, b: number): number {
  return cents(a + b);
}
function iso(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return fail("invalid period date");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    return fail("invalid period date");
  return value;
}
function next(value: string): string {
  return new Date(new Date(`${iso(value)}T00:00:00Z`).getTime() + 86400000)
    .toISOString()
    .slice(0, 10);
}
function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return fail("unsupported full source field");
}
function multiset(rows: readonly Record<string, unknown>[]): string {
  return JSON.stringify(rows.map(canonical).sort());
}
function sourceCop(row: Record<string, unknown>): string {
  if (typeof row.COPID !== "string") return fail("missing source COPID");
  const value = row.COPID.trim().toUpperCase();
  if (!/^(?:CAN|PAC)-\d{2}-[1-9]\d*$/.test(value))
    return fail("malformed source COPID");
  return value;
}
function ids(
  observation: PhoenixCommitteeCashObservation,
  copId: string,
): Set<string> {
  const result = new Set<string>();
  for (const key of [
    "contributors",
    "expenditures",
    "loans",
    "noActivityContributors",
    "noActivityExpenditures",
  ] as const) {
    const rows = observation.grids[key];
    if (!Array.isArray(rows)) return fail("missing source census");
    for (const row of rows) {
      const actualCop = sourceCop(row);
      // The public filter is a prefix search. Full raw rows still participate
      // in paired equality; foreign packages never become this receiver's money.
      if (actualCop !== copId) {
        if (!actualCop.startsWith(copId))
          return fail("unexplained foreign source COPID");
        continue;
      }
      if (
        typeof row.ReportPackageId !== "string" ||
        !PHOENIX_REPORT_PACKAGE_GUID.test(row.ReportPackageId) ||
        /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(row.ReportPackageId)
      )
        return fail("source census owner/package mismatch");
      const pointer = row.RecentReport;
      if (
        pointer !== undefined &&
        pointer !== null &&
        pointer !== "" &&
        (typeof pointer !== "string" ||
          !PHOENIX_REPORT_PACKAGE_GUID.test(pointer) ||
          (!/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(pointer) &&
            pointer.toLowerCase() !== row.ReportPackageId.toLowerCase()))
      ) {
        return fail("unexplained current report pointer");
      }
      result.add(row.ReportPackageId.toLowerCase());
    }
  }
  return result;
}
function headerId(pages: readonly PhoenixPdfPage[], copId: string) {
  for (const page of pages) {
    const values = page.lines
      .filter((line) => line.y > 700)
      .flatMap((line) => line.cells.map((cell) => cell.text))
      .filter((text) => /^(?:CAN|PAC)-\d{2}-[1-9]\d*$/.test(text));
    if (values.length !== 1 || values[0] !== copId)
      return fail("PDF receiving COPID mismatch");
  }
}
function civilDate(raw: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  if (!match) return fail("invalid occurrence date");
  return iso(`${match[3]}-${match[1]}-${match[2]}`);
}
function within(raw: string, from: string, to: string): void {
  const date = civilDate(raw);
  if (date < from || date > to) return fail("occurrence outside report period");
}

type Report = {
  reportPackageId: string;
  parsed: PhoenixParsedReport;
  cash: PhoenixCommitteeCashReport;
};
function reports(
  observation: PhoenixCommitteeCashObservation,
  expected: Set<string>,
  input: PhoenixCommitteeCashQualificationInput,
): Report[] {
  const seen = new Set<string>();
  const parsed: Report[] = [];
  for (const report of observation.reports) {
    const id = report.reportPackageId.toLowerCase();
    if (!expected.has(id) || seen.has(id))
      return fail("PDF package coverage mismatch");
    seen.add(id);
    headerId(report.pages, input.copId);
    const covers = report.pages.filter((page) =>
      page.lines.some((line) =>
        /FINANCIAL SUMMARY \(required\)/.test(line.text),
      ),
    );
    if (covers.length !== 1) return fail("ambiguous financial cover");
    const ownerLines = covers[0]!.lines.filter((line) =>
      /^Committee Information: Committee Name: /.test(line.text),
    );
    if (
      ownerLines.length !== 1 ||
      name(
        ownerLines[0]!.text.replace(
          /^Committee Information: Committee Name: /,
          "",
        ),
      ) !== name(input.committeeName)
    )
      return fail("PDF owner name mismatch");
    const core = parsePhoenixReportPages(report.pages);
    if (
      core.cover.officeSought === null ||
      name(core.cover.officeSought) !== name(input.officeSought)
    )
      return fail("PDF office mismatch");
    iso(core.cover.periodFrom);
    iso(core.cover.periodTo);
    if (core.cover.periodFrom > core.cover.periodTo)
      return fail("reversed report period");
    for (const value of [
      core.cover.beginCents,
      core.cover.closeCents,
      core.cover.receiptsPeriodCents,
      core.cover.disbursementsPeriodCents,
      core.line16CashCents,
      core.receipts.line13CashCents,
      core.receipts.line2eCents,
      core.receipts.otherCashCents,
      ...Object.values(core.receipts.line1),
    ])
      cents(value);
    if (
      core.cover.receiptsCycleCents === null ||
      core.cover.disbursementsCycleCents === null
    )
      return fail("missing cycle controls");
    cents(core.cover.receiptsCycleCents);
    cents(core.cover.disbursementsCycleCents);
    const noActivityIds = new Set(
      [
        ...observation.grids.noActivityContributors,
        ...observation.grids.noActivityExpenditures,
      ]
        .filter((row) => sourceCop(row) === input.copId)
        .map((row) => String(row.ReportPackageId).toLowerCase()),
    );
    let cash: PhoenixCommitteeCashReport;
    if (core.noActivity) {
      if (!noActivityIds.has(id))
        return fail("unqualified cover-only no-activity report");
      cash = {
        receivingCopId: input.copId,
        pacGifts: [],
        returns: [],
        controls: { pacCashCents: 0, returnedCashCents: 0 },
      };
    } else cash = parsePhoenixCommitteeCashReport(report.pages);
    const line = core.receipts.line1;
    const individualA = core.a1aEntries.reduce(
      (sum, row) => add(sum, cents(row.amountCents)),
      0,
    );
    const individualC = core.a1cEntries.reduce(
      (sum, row) => add(sum, cents(row.amountCents)),
      0,
    );
    if (
      ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].reduce(
        (sum, key) => add(sum, cents(line[key]!)),
        0,
      ) !== line.k ||
      add(line.k!, -line.l!) !== line.m ||
      add(
        add(line.m!, core.receipts.line2eCents),
        core.receipts.otherCashCents,
      ) !== core.receipts.line13CashCents ||
      core.receipts.line13CashCents !== core.cover.receiptsPeriodCents ||
      core.line16CashCents !== core.cover.disbursementsPeriodCents ||
      add(
        add(core.cover.beginCents, core.cover.receiptsPeriodCents),
        -core.cover.disbursementsPeriodCents,
      ) !== core.cover.closeCents ||
      individualA !== line.a ||
      individualC !== line.c
    )
      return fail("unreconciled full report financial controls");
    if (
      cash.controls.pacCashCents !== core.receipts.line1.e ||
      cash.controls.returnedCashCents !== core.receipts.line1.l
    )
      return fail("committee schedule/core controls mismatch");
    for (const row of [...core.a1aEntries, ...core.a1cEntries]) {
      cents(row.amountCents);
      // Individual schedules establish reported class, not PAC money/date ownership.
      civilDate(row.date);
    }
    for (const row of [...cash.pacGifts, ...cash.returns])
      within(row.rawDate, core.cover.periodFrom, core.cover.periodTo);
    parsed.push({ reportPackageId: id, parsed: core, cash });
  }
  if (seen.size !== expected.size || !seen.size)
    return fail("incomplete PDF package set");
  return parsed.sort(
    (a, b) =>
      a.parsed.cover.periodFrom.localeCompare(b.parsed.cover.periodFrom) ||
      a.reportPackageId.localeCompare(b.reportPackageId),
  );
}

/** Qualifies named PAC cash only. The caller owns authentic public acquisition,
 * raw capture retention and current local candidate eligibility. Failure never
 * authorizes deletion of this component or suppresses independent IE evidence. */
export function qualifyPhoenixCommitteeCash(
  input: PhoenixCommitteeCashQualificationInput,
) {
  if (
    !/^CAN-\d{2}-[1-9]\d*$/.test(input.copId) ||
    !name(input.committeeName) ||
    !name(input.officeSought)
  )
    return fail("invalid receiving context");
  iso(input.portalCycleStart);
  iso(input.portalCycleEnd);
  const cycle = phoenixCandidateCycleForDate(input.portalCycleStart);
  if (
    input.portalCycleStart !== `${cycle.startYear}-04-01` ||
    input.portalCycleEnd !== `${cycle.startYear + 2}-03-31`
  )
    return fail("invalid portal cycle");
  const beforeIds = ids(input.before, input.copId);
  const afterIds = ids(input.after, input.copId);
  if (
    JSON.stringify([...beforeIds].sort()) !==
    JSON.stringify([...afterIds].sort())
  )
    return fail("changed package census");
  for (const key of [
    "contributors",
    "expenditures",
    "loans",
    "noActivityContributors",
    "noActivityExpenditures",
  ] as const) {
    if (multiset(input.before.grids[key]) !== multiset(input.after.grids[key]))
      return fail("changed full source census");
  }
  const opening = reports(input.before, beforeIds, input);
  const closing = reports(input.after, afterIds, input);
  for (const report of input.before.reports) {
    const paired = input.after.reports.find(
      (item) =>
        item.reportPackageId.toLowerCase() ===
        report.reportPackageId.toLowerCase(),
    );
    if (!paired || canonical(report.pages) !== canonical(paired.pages))
      return fail("changed full positioned report");
  }
  // No selection by report label, submitted date, or maximum GUID.
  for (let i = 1; i < closing.length; i++) {
    if (
      closing[i]!.parsed.cover.periodFrom <=
      closing[i - 1]!.parsed.cover.periodTo
    )
      return fail("overlapping or multiple report editions");
  }
  const current = closing.filter(
    (report) =>
      report.parsed.cover.periodTo >= input.portalCycleStart &&
      report.parsed.cover.periodFrom <= input.portalCycleEnd,
  );
  if (
    !current.length ||
    current[0]!.parsed.cover.periodFrom !== input.portalCycleStart ||
    current.some(
      (report) =>
        report.parsed.cover.periodFrom < input.portalCycleStart ||
        report.parsed.cover.periodTo > input.portalCycleEnd,
    )
  )
    return fail("incomplete cycle boundary");
  for (let i = 1; i < current.length; i++)
    if (
      current[i]!.parsed.cover.periodFrom !==
      next(current[i - 1]!.parsed.cover.periodTo)
    )
      return fail("report period gap");
  for (const prior of input.priorReportPeriods ?? []) {
    iso(prior.periodFrom);
    iso(prior.periodTo);
    if (
      !closing.some(
        (report) =>
          report.parsed.cover.periodFrom === prior.periodFrom &&
          report.parsed.cover.periodTo === prior.periodTo,
      )
    )
      return fail("prior report period disappeared");
  }
  const direct = aggregatePhoenixDirectFinance({
    copId: input.copId,
    portalCycleStart: input.portalCycleStart,
    portalCycleEnd: input.portalCycleEnd,
    reports: closing.map((report) => ({
      reportPackageId: report.reportPackageId,
      reportName: report.parsed.cover.reportName,
      submittedDateMs: 0,
      parsed: report.parsed,
    })),
  });
  if (direct.violations.length)
    return fail(`financial controls/${direct.violations[0]!.type}`);
  let receiptSum = 0,
    spentSum = 0;
  for (const report of current) {
    receiptSum = add(receiptSum, report.parsed.cover.receiptsPeriodCents);
    spentSum = add(spentSum, report.parsed.cover.disbursementsPeriodCents);
    if (
      report.parsed.cover.receiptsCycleCents !== receiptSum ||
      report.parsed.cover.disbursementsCycleCents !== spentSum
    )
      return fail("cycle controls not reconciled");
  }
  const classes = new Map<string, Set<"individual" | "pac">>();
  const label = (raw: string, role: "individual" | "pac") => {
    const key = name(raw);
    if (!key) return fail("empty source donor name");
    const values = classes.get(key) ?? new Set();
    values.add(role);
    classes.set(key, values);
  };
  for (const report of opening) {
    for (const row of [
      ...report.parsed.a1aEntries,
      ...report.parsed.a1cEntries,
    ])
      label(row.name, "individual");
    for (const row of report.cash.pacGifts) label(row.rawName, "pac");
  }
  const positions = new Map<string, PhoenixCommitteeCashPosition>();
  const position = (raw: string, id: string) => {
    const key = name(raw);
    let value = positions.get(key);
    if (!value) {
      value = {
        committeeId: `reported:${key}`,
        committeeName: raw,
        committeeType: "Political Action Committee",
        grossCents: 0,
        refundCents: 0,
        netCents: 0,
        contributionCount: 0,
        refundCount: 0,
        sourceUrl: `${PHOENIX_PORTAL_BASE_URL}/CampaignFinance/Reports/PrintReport/${id}`,
      };
      positions.set(key, value);
    }
    return value;
  };
  for (const report of current) {
    for (const gift of report.cash.pacGifts) {
      const value = position(gift.rawName, report.reportPackageId);
      value.grossCents = add(value.grossCents, gift.amountCents);
      if (gift.amountCents > 0) value.contributionCount++;
    }
    for (const returned of report.cash.returns) {
      if (returned.amountCents < 0) return fail("unknown return reversal");
      const roles = classes.get(name(returned.rawName));
      if (!roles || roles.size !== 1)
        return fail("ambiguous or unknown returned contributor class");
      if (roles.has("pac")) {
        const value = position(returned.rawName, report.reportPackageId);
        value.refundCents = add(value.refundCents, returned.amountCents);
        if (returned.amountCents > 0) value.refundCount++;
      }
    }
  }
  for (const value of positions.values()) {
    value.netCents = add(value.grossCents, -value.refundCents);
    if (value.contributionCount > 2147483647 || value.refundCount > 2147483647)
      return fail("unsafe occurrence count");
  }
  const individualDateOutliers = current.reduce(
    (count, report) =>
      count +
      [...report.parsed.a1aEntries, ...report.parsed.a1cEntries].filter(
        (row) => {
          const date = civilDate(row.date);
          return (
            date < report.parsed.cover.periodFrom ||
            date > report.parsed.cover.periodTo
          );
        },
      ).length,
    0,
  );
  return {
    positions: [...positions.values()].sort((a, b) =>
      a.committeeId.localeCompare(b.committeeId),
    ),
    reportPeriods: current.map((report) => ({
      reportPackageId: report.reportPackageId,
      periodFrom: report.parsed.cover.periodFrom,
      periodTo: report.parsed.cover.periodTo,
    })),
    reportedThrough: current.at(-1)!.parsed.cover.periodTo,
    diagnostics: [
      "Named monetary PAC positions from complete paired published report schedules; later cycle periods remain unreported.",
      ...(individualDateOutliers
        ? [
            `${individualDateOutliers} source-typed individual date outlier(s) retained as class evidence only; named PAC amounts unaffected.`,
          ]
        : []),
    ],
  };
}
