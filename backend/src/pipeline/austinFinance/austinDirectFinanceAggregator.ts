// Direct-finance aggregation for Austin (plan Phase 3). Input is everything
// Socrata holds for ONE linked filer — every Report Detail row under the
// exact `filer_name` and every Contributions row under the same string as
// `recipient` — plus the link's election date and office code. The
// aggregator scopes both to the cycle and applies the plan's rules:
//   - cycle reports = the effective regular/correction reports
//     (selectAustinEffectiveReports: dedupe by report id, latest filing per
//     period, corrections supersede) whose election tag AND parsed office
//     code match the link — a filer's rows for another seat or another
//     cycle are a different race (Bowen: MAYOR 2024, District 8 2026);
//   - raised = Σ cover `contrib_total`, spent = Σ cover `expend_total`
//     (Houston-style cover arithmetic; a null cover figure is $0 for that
//     report — verified live: null covers carry no itemized rows);
//   - a kept ATX.7 special report (not yet re-reported by a regular report)
//     has no cover totals, so its itemized rows are added to raised;
//   - cash on hand = `contrib_balance` of the latest cycle report, null when
//     that report carries none (never an older report's balance);
//   - itemized rows exclude PLEDGES and misfiled EXPENDITURES: `contrib_total`
//     counts money received, a "Pledged Contribution" is not (live
//     2026-08-19 — Anderson D1: cover $26,797.00 = 193 monetary rows, 5
//     pledge rows $1,570 outside it), and "Political Expenditures From
//     Political Contribution" rows are outflows filed on the wrong schedule
//     (Vela D4 2023-H2: cover $63,030.00 = 188 monetary rows exactly once
//     the two $5,152.44 expenditure rows are set aside). Every other type
//     counts;
//   - reconciliation, every sync: per cycle report, the counted itemized
//     rows may never EXCEED the cover `contrib_total` — that would mean the
//     buckets count money the filer did not report receiving — and a filer
//     with reported contributions but no itemized rows at all is a broken
//     source, not an empty breakdown; both throw so the prior snapshot
//     survives. Rows may fall SHORT of the cover: 41 live filers checked
//     (2024 + 2026 cycles) — 34 reconcile to the cent, 7 carry small
//     unitemized remainders ($0.02 to $677) that the covers include and the
//     schedule does not list. That gap is reported, never invented;
//   - occupation buckets: INDIVIDUAL donors only; size buckets: positive
//     rows only (the LA/Denver precedent); rows whose donor IS the filer
//     (self-funding, plan gotcha 8) count in the totals but never in a
//     bucket. Bucket boundaries are the shared LA set — Austin's $500 cap
//     means the top buckets stay empty, which is a true statement.

import { aggregateAustinReportedCommitteeCash, type AustinReportedCommitteeCash } from "./austinReportedCommitteeCash.js";
import { normalizeAustinFinanceTextKey } from "./austinFinanceKeys.js";
import {
  parseAustinOfficeSoughtCode,
  type AustinOfficeCode,
} from "./austinFinanceEligibleOffices.js";
import type { AustinDirectBreakdownInput } from "./austinFinanceWriter.js";
import {
  selectAustinEffectiveReports,
  type AustinContributionRow,
  type AustinPeriodReportDetailRow,
  type AustinReportDetailRow,
} from "./austinSocrataClient.js";

export const AUSTIN_DEFAULT_MAX_OCCUPATION_BREAKDOWNS = 20;

/** LA bucket boundaries, in cents (a $250.00 row lands in $250-$499). */
function contributionSizeBucket(cents: number): string {
  if (cents < 10_000) return "$1-$99";
  if (cents < 25_000) return "$100-$249";
  if (cents < 50_000) return "$250-$499";
  if (cents < 100_000) return "$500-$999";
  if (cents < 500_000) return "$1,000-$4,999";
  return "$5,000+";
}

/**
 * Contribution types that are not money received: pledges (promises) and
 * expenditures misfiled on the contributions schedule.
 */
export function isAustinNonReceiptContributionType(value: string | null): boolean {
  const type = (value ?? "").trim().toUpperCase();
  return /^PLEDGED\b/.test(type) || /\bEXPENDITURE/.test(type);
}

function usd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export type AustinDirectAggregation = {
  /** Effective regular/correction reports for the cycle, by period (periods always present). */
  cycleReports: AustinPeriodReportDetailRow[];
  /** ATX.7 reports for the cycle not yet re-reported by a regular report. */
  keptSpecialReports: AustinPeriodReportDetailRow[];
  totalRaisedCents: number;
  totalSpentCents: number;
  /** Null when no cycle report carries a balance. */
  cashOnHandCents: number | null;
  breakdowns: AustinDirectBreakdownInput[];
  reportedCommitteeCash: AustinReportedCommitteeCash;
  /** Counted itemized rows on cycle reports (pledges/expenditures set aside). */
  itemizedRowCount: number;
  /** Pledge / misfiled-expenditure rows set aside. */
  nonReceiptRowCount: number;
  /** Σ (cover − itemized) over cycle reports: reported but not listed. */
  unitemizedCents: number;
  /** Rows whose donor is the filer — in the totals, out of the buckets. */
  selfRowCount: number;
};

export function aggregateAustinDirectFinance(input: {
  /** Every Report Detail row for the filer (exact `filer_name`). */
  reports: readonly AustinReportDetailRow[];
  /** Every Contributions row for the filer (exact `recipient`). */
  contributions: readonly AustinContributionRow[];
  /** The linked filer's exact spelling — self-donor detection. */
  filerName: string;
  electionDate: string;
  officeCode: AustinOfficeCode;
  maxOccupationBreakdowns?: number;
}): AustinDirectAggregation {
  const limit =
    input.maxOccupationBreakdowns ?? AUSTIN_DEFAULT_MAX_OCCUPATION_BREAKDOWNS;
  if (!Number.isInteger(limit) || limit <= 0)
    throw new Error(`Invalid Austin occupation breakdown limit: ${limit}`);
  const inCycle = (row: AustinReportDetailRow): boolean =>
    row.electionDate === input.electionDate &&
    parseAustinOfficeSoughtCode(row.officeSought) === input.officeCode;
  // Supersession runs over ALL of the filer's reports BEFORE the cycle
  // filter, on purpose: a report is filed per filer and period, not per
  // race, so the only way one period can carry two election tags is a
  // correction that re-tagged it — and then the correction must win and the
  // original must count nowhere. Filtering first would make both effective,
  // one per race, and count the same money twice. (Live 2026-08-19: no
  // (filer, period) group in Report Detail carries two tags or offices.)
  const selection = selectAustinEffectiveReports(input.reports);
  const cycleReports = selection.effective.filter(inCycle);
  const keptSpecialReports = selection.keptSpecial.filter(inCycle);
  if (cycleReports.length === 0 && keptSpecialReports.length === 0)
    throw new Error(
      `Austin filer ${JSON.stringify(input.filerName)} has no effective report for ${input.officeCode} / ${input.electionDate}; refusing to write a snapshot`,
    );

  // Itemized rows on counted reports, non-receipts set aside.
  const countedReportIds = new Set([
    ...cycleReports.map((row) => row.reportId),
    ...keptSpecialReports.map((row) => row.reportId),
  ]);
  const filerKey = normalizeAustinFinanceTextKey(input.filerName);
  const itemizedByReport = new Map<string, number>();
  const counted: AustinContributionRow[] = [];
  let nonReceiptRowCount = 0;
  for (const row of input.contributions) {
    if (!countedReportIds.has(row.reportId)) continue;
    if (isAustinNonReceiptContributionType(row.contributionType)) {
      nonReceiptRowCount += 1;
      continue;
    }
    counted.push(row);
    itemizedByReport.set(
      row.reportId,
      (itemizedByReport.get(row.reportId) ?? 0) + row.amountCents,
    );
  }

  // Cover reconciliation (regular/correction reports only — a special
  // report has no cover figure to reconcile against).
  const overages: string[] = [];
  let unitemizedCents = 0;
  let coverCents = 0;
  for (const report of cycleReports) {
    const cover = report.contribTotalCents ?? 0;
    const itemized = itemizedByReport.get(report.reportId) ?? 0;
    coverCents += cover;
    if (itemized > cover)
      overages.push(
        `${report.reportId}: itemized ${usd(itemized)} exceeds cover ${usd(cover)}`,
      );
    else unitemizedCents += cover - itemized;
  }
  if (overages.length > 0)
    throw new Error(
      `Austin itemized contributions exceed the cover totals for ${JSON.stringify(input.filerName)}: ${overages.join("; ")}`,
    );
  if (coverCents > 0 && counted.length === 0)
    throw new Error(
      `Austin filer ${JSON.stringify(input.filerName)} reports ${usd(coverCents)} in contributions but no itemized rows were returned; refusing to write empty breakdowns`,
    );

  // Totals: covers for regular reports, itemized rows for kept specials.
  let totalRaisedCents = 0;
  let totalSpentCents = 0;
  for (const report of cycleReports) {
    totalRaisedCents += report.contribTotalCents ?? 0;
    totalSpentCents += report.expendTotalCents ?? 0;
  }
  for (const report of keptSpecialReports) {
    totalRaisedCents += itemizedByReport.get(report.reportId) ?? 0;
    totalSpentCents += report.expendTotalCents ?? 0;
  }
  // Cash on hand: the latest cycle report's balance, and ONLY that one
  // (selectAustinEffectiveReports orders by period_from; ties are one
  // period, so the later filing wins there too). A null balance on the
  // latest report publishes null — an older report's balance is stale
  // money, not current cash (PR #763 review).
  const cashOnHandCents =
    cycleReports[cycleReports.length - 1]?.contribBalanceCents ?? null;

  // Buckets.
  const occupations = new Map<
    string,
    { name: string; cents: number; count: number }
  >();
  const sizes = new Map<string, { cents: number; count: number }>();
  let selfRowCount = 0;
  for (const row of counted) {
    if (normalizeAustinFinanceTextKey(row.donor) === filerKey) {
      selfRowCount += 1;
      continue;
    }
    if (row.donorType === "INDIVIDUAL") {
      const occupationName = row.occupation?.replace(/\s+/g, " ").trim();
      if (occupationName) {
        const key = occupationName.toUpperCase();
        const current = occupations.get(key) ?? {
          name: occupationName,
          cents: 0,
          count: 0,
        };
        current.cents += row.amountCents;
        current.count += row.amountCents > 0 ? 1 : 0;
        occupations.set(key, current);
      }
    }
    if (row.amountCents > 0) {
      const bucket = contributionSizeBucket(row.amountCents);
      const current = sizes.get(bucket) ?? { cents: 0, count: 0 };
      current.cents += row.amountCents;
      current.count += 1;
      sizes.set(bucket, current);
    }
  }
  const breakdowns: AustinDirectBreakdownInput[] = [
    ...[...occupations.values()]
      .filter((value) => value.cents > 0)
      .sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name))
      .slice(0, limit)
      .map((value) => ({
        categoryType: "occupation" as const,
        categoryName: value.name,
        amountCents: value.cents,
        contributorCount: value.count,
      })),
    ...[...sizes]
      .filter(([, value]) => value.cents > 0)
      .sort((a, b) => b[1].cents - a[1].cents || a[0].localeCompare(b[0]))
      .map(([bucket, value]) => ({
        categoryType: "contribution_size" as const,
        categoryName: bucket,
        amountCents: value.cents,
        contributorCount: value.count,
      })),
  ];
  return {
    reportedCommitteeCash: aggregateAustinReportedCommitteeCash({ contributions: counted, reports: [...cycleReports, ...keptSpecialReports], filerName: input.filerName }),
    cycleReports,
    keptSpecialReports,
    totalRaisedCents,
    totalSpentCents,
    cashOnHandCents,
    breakdowns,
    itemizedRowCount: counted.length,
    nonReceiptRowCount,
    unitemizedCents,
    selfRowCount,
  };
}
