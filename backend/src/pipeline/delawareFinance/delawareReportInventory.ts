// Delaware filed-report inventory: canonical per-period selection and
// election-period window resolution (docs/plans/plan-delaware-finance.md facts 3 + 5).
//
// PDF footer versions repeat across unrelated reports and cannot choose an
// amendment. This cover-only path accepts a sole document per filing calendar,
// under either Original or Amended, and preserves ambiguity otherwise. The
// current-account pointer alone does not identify every historical period.
// Everything here fails closed: ambiguous editions,
// unparseable dates, chain breaks, or window misalignment throw instead of
// producing a partial inventory.

import type { DelawareFiledReportRow, DelawareReportCover } from "./delawareCfrsParsers.js";

export class DelawareReportInventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelawareReportInventoryError";
  }
}

/**
 * The three CFRS artifacts render the SAME filing period under different
 * names (receipts CSV "2024 2024  General Election 11/05/2024 30 Day",
 * filed-report grid "2024 30 Day 2024 General Election 11/05/2024",
 * expenses CSV "2024 30 Day General"; annuals differ in whitespace only —
 * verified by 1:1 amount pairing on the 2026-08-27 probe run). Normalize to
 * "(year) (Annual | 30 Day | 8 Day)( General | Primary | Special)" before
 * any cross-artifact match. Unrecognizable names throw — an unknown period
 * shape is drift, not data.
 */
export function delawareFilingPeriodKey(name: string): string {
  const year = /\b(?:19|20)\d{2}\b/.exec(name)?.[0];
  const day = /\b(30|8)\s*Day\b/i.exec(name);
  const kind = /annual/i.test(name) ? "Annual" : day === null ? null : `${day[1]} Day`;
  if (year === undefined || kind === null) {
    throw new DelawareReportInventoryError(`unrecognizable Delaware filing-period name: "${name}"`);
  }
  const election = /general/i.test(name)
    ? " General"
    : /primary/i.test(name)
      ? " Primary"
      : /special/i.test(name)
        ? " Special"
        : "";
  if (kind !== "Annual" && election === "") {
    throw new DelawareReportInventoryError(
      `Delaware election-report period name carries no election kind: "${name}"`
    );
  }
  return `${year} ${kind}${election}`;
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** MM/DD/YYYY (as printed on report covers) -> real ISO date; throws otherwise. */
export function delawareCoverDateToIso(value: string | null): string {
  const match = value === null ? null : /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (match === null) {
    throw new DelawareReportInventoryError(`unparseable Delaware cover date: "${value}"`);
  }
  const iso = `${match[3]}-${match[1]}-${match[2]}`;
  if (!isValidIsoDate(iso)) {
    throw new DelawareReportInventoryError(`invalid Delaware cover date: "${value}"`);
  }
  return iso;
}

export type DelawareCanonicalReport = {
  filingPeriodName: string;
  periodKey: string;
  filingCalendarId: number;
  /** Optional template footer metadata, never edition-selection authority. */
  documentVersion: number | null;
  /** ISO reporting-period bounds from the canonical cover. */
  periodFrom: string;
  periodTo: string;
  beginningBalanceCents: number;
  receiptsCents: number;
  expendituresCents: number;
  endingBalanceCents: number;
};

/**
 * Requires a sole report per FilingCalendarID and
 * validates the whole inventory: unambiguous documents, parseable periods,
 * one period key per calendar entry, sequential non-overlapping periods,
 * and a fully continuous balance chain (each beginning balance equals the
 * prior canonical ending balance). Returns the canonical reports sorted by
 * period start.
 */
export function buildDelawareCanonicalReportInventory(
  reports: readonly { row: DelawareFiledReportRow; cover: DelawareReportCover }[]
): DelawareCanonicalReport[] {
  if (reports.length === 0) {
    throw new DelawareReportInventoryError("no filed reports to build an inventory from");
  }
  const byCalendar = new Map<number, { row: DelawareFiledReportRow; cover: DelawareReportCover }[]>();
  for (const report of reports) {
    if (report.row.document === null) {
      throw new DelawareReportInventoryError(
        `filed report [${report.row.filingPeriodName}] has no document — cannot participate in cover selection`
      );
    }
    const key = report.row.document.filingCalendarId;
    const list = byCalendar.get(key) ?? [];
    list.push(report);
    byCalendar.set(key, list);
  }

  const canonical: DelawareCanonicalReport[] = [];
  for (const [filingCalendarId, entries] of byCalendar) {
    if (entries.length !== 1) {
      throw new DelawareReportInventoryError(
        `ambiguous report editions for filing calendar ${filingCalendarId}: ${entries.length} entries need financial currentness proof`
      );
    }
    const winner = entries[0]!;
    canonical.push({
      filingPeriodName: winner.row.filingPeriodName,
      periodKey: delawareFilingPeriodKey(winner.row.filingPeriodName),
      filingCalendarId,
      documentVersion: winner.cover.documentVersion,
      periodFrom: delawareCoverDateToIso(winner.cover.reportingPeriodFrom),
      periodTo: delawareCoverDateToIso(winner.cover.reportingPeriodTo),
      beginningBalanceCents: winner.cover.beginningBalanceCents,
      receiptsCents: winner.cover.receiptsCents,
      expendituresCents: winner.cover.expendituresCents,
      endingBalanceCents: winner.cover.endingBalanceCents,
    });
  }

  canonical.sort((left, right) => left.periodFrom.localeCompare(right.periodFrom));

  const periodKeys = new Set<string>();
  for (const report of canonical) {
    if (periodKeys.has(report.periodKey)) {
      throw new DelawareReportInventoryError(
        `two canonical reports share the filing period key "${report.periodKey}"`
      );
    }
    periodKeys.add(report.periodKey);
  }
  for (let index = 0; index < canonical.length; index += 1) {
    const report = canonical[index]!;
    if (report.periodTo < report.periodFrom) {
      throw new DelawareReportInventoryError(
        `report [${report.filingPeriodName}] period runs backwards (${report.periodFrom}..${report.periodTo})`
      );
    }
    if (index > 0) {
      const previous = canonical[index - 1]!;
      if (report.periodFrom <= previous.periodTo) {
        throw new DelawareReportInventoryError(
          `reports [${previous.filingPeriodName}] and [${report.filingPeriodName}] overlap ` +
            `(${previous.periodFrom}..${previous.periodTo} vs ${report.periodFrom}..${report.periodTo})`
        );
      }
      if (report.beginningBalanceCents !== previous.endingBalanceCents) {
        throw new DelawareReportInventoryError(
          `balance chain break between [${previous.filingPeriodName}] (ending ${previous.endingBalanceCents}c) ` +
            `and [${report.filingPeriodName}] (beginning ${report.beginningBalanceCents}c)`
        );
      }
    }
  }
  return canonical;
}

export type DelawareElectionPeriodWindow = {
  /** ISO date the window opens (inclusive). */
  windowStart: string;
  /** December31 following the general election (§8002(11)a). */
  windowEnd: string;
  /** Latest actually published report end; not the statutory window end. */
  publishedThrough: string;
  /** Canonical reports fully inside the window, in period order. */
  reports: DelawareCanonicalReport[];
  /** Legacy report-history rule used for windowStart; not office-history proof. */
  basis: "post_prior_election" | "committee_first_report";
};

/**
 * Resolves the § 8002(11) election-period window from the canonical
 * inventory alone:
 *
 * - If the committee filed 30-Day/8-Day election reports for a PRIOR
 *   election (period ending before Jan 1 of the election year), the current
 *   period starts Jan 1 after that prior election's year — the statute's
 *   elected-incumbent rule, and the same boundary that keeps an
 *   office-spanning committee's old-era money out (Meyer's 2022
 *   county-executive money stays out of a 2024 window).
 * - Otherwise the committee's whole history is this candidacy (the
 *   challenger case: the period opens with the first contribution, which is
 *   where the first report starts).
 *
 * The primary/general split in §8002(11)a4 concerns contribution limits.
 * The finance window spans both and ends December31 after the general
 * election, including the final annual report filed the next January.
 * Fails closed when any canonical report STRADDLES the window
 * start (a report that mixes prior-period and current-period money cannot
 * be split — plan: ambiguous window -> no publication).
 *
 * Known limitation, deliberate: report-era office history is NOT
 * recoverable from CFRS artifacts — the filed-report and CSV Office
 * columns render the committee's CURRENT registration on every historical
 * row (verified live: all 20 Meyer reports, county-era included, show
 * "State Office - Governor"). So a per-report office filter is impossible;
 * this date rule is the conservative mechanical form (money raised for the
 * current race before the prior election's reports closed is excluded),
 * and current-registration office evidence is enforced by the resolver's
 * office-filtered search plus the sync's office gate.
 */
export function resolveDelawareElectionPeriodWindow(input: {
  electionDate: string;
  canonicalReports: readonly DelawareCanonicalReport[];
}): DelawareElectionPeriodWindow {
  if (!isValidIsoDate(input.electionDate)) {
    throw new DelawareReportInventoryError(`invalid election date: "${input.electionDate}"`);
  }
  if (input.canonicalReports.length === 0) {
    throw new DelawareReportInventoryError("cannot resolve a window from an empty inventory");
  }
  const electionYear = Number.parseInt(input.electionDate.slice(0, 4), 10);
  const windowEnd = `${electionYear}-12-31`;
  const janFirstOfElectionYear = `${electionYear}-01-01`;
  const priorElectionReports = input.canonicalReports.filter(
    (report) => report.periodKey.includes("Day") && report.periodTo < janFirstOfElectionYear
  );
  let windowStart: string;
  let basis: DelawareElectionPeriodWindow["basis"];
  if (priorElectionReports.length > 0) {
    const lastPrior = priorElectionReports[priorElectionReports.length - 1]!;
    const priorYear = Number.parseInt(lastPrior.periodTo.slice(0, 4), 10);
    windowStart = `${priorYear + 1}-01-01`;
    basis = "post_prior_election";
  } else {
    windowStart = input.canonicalReports[0]!.periodFrom;
    basis = "committee_first_report";
  }

  const reports: DelawareCanonicalReport[] = [];
  for (const report of input.canonicalReports) {
    if (report.periodTo < windowStart) {
      continue;
    }
    if (report.periodFrom < windowStart) {
      throw new DelawareReportInventoryError(
        `report [${report.filingPeriodName}] straddles the window start ${windowStart} ` +
          `(${report.periodFrom}..${report.periodTo}) — ambiguous window, not publishable`
      );
    }
    if (report.periodTo > windowEnd) {
      if (report.periodFrom <= windowEnd) {
        throw new DelawareReportInventoryError(
          `report [${report.filingPeriodName}] straddles the window end ${windowEnd} — ambiguous window, not publishable`
        );
      }
      continue;
    }
    reports.push(report);
  }
  if (reports.length === 0) {
    throw new DelawareReportInventoryError(
      `no canonical report lies inside the window ${windowStart}..${windowEnd}`
    );
  }
  return { windowStart, windowEnd, publishedThrough: reports.at(-1)!.periodTo, reports, basis };
}
