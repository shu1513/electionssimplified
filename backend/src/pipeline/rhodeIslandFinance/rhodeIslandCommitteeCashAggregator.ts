import {
  ERTS_CONTRIBUTION_TYPE_CODES,
  type ErtsContributionExportRow,
} from "./rhodeIslandErtsParsers.js";

export class RhodeIslandCommitteeCashHold extends Error {
  constructor(readonly code: string) {
    super(`Rhode Island committee cash held: ${code}`);
  }
}
export function riCommitteeCashCheck(value: unknown, code: string): asserts value {
  if (!value) throw new RhodeIslandCommitteeCashHold(code);
}
const check: typeof riCommitteeCashCheck = riCommitteeCashCheck;
function add(left: number, right: number): number {
  const sum = left + right;
  check(Number.isSafeInteger(left) && Number.isSafeInteger(right) && Number.isSafeInteger(sum), "unsafe_cent_sum");
  return sum;
}
function day(value: string): string {
  check(/^\d{4}-\d{2}-\d{2}$/.test(value), "calendar_date");
  const parsed = new Date(`${value}T00:00:00Z`);
  check(Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value, "calendar_date");
  return value;
}
export type RhodeIslandCommitteeCashPeriod = {
  beginIso: string;
  endIso: string;
  groupings: ReadonlyMap<string, number>;
  cf2PacCents: number;
  cf2PartyCents: number;
};
export type RhodeIslandCommitteeCashDonor = {
  key: string;
  name: string;
  sourceClass: "PAC" | "Party";
  amountCents: number;
  contributionCount: number;
};

/** Gross positive itemized PAC/Party cash as currently filed. This does not
 * subtract expenditure-side returns or infer a registered donor identity.
 * A writable packet additionally requires verified cache/current CF-2 evidence.
 * No partial subtotal is returned on unknown types, signed committee receipts,
 * ambiguous IDs/periods or unreconciled exports. Equal gifts remain occurrences.
 */
export function aggregateRhodeIslandCommitteeCash(input: {
  electionYear: number;
  observedDay: string;
  periods: readonly RhodeIslandCommitteeCashPeriod[];
  rows: readonly ErtsContributionExportRow[];
}) {
  check(input.electionYear === 2026, "unsupported_cycle");
  day(input.observedDay);
  const start = `${input.electionYear - 1}-01-01`, end = `${input.electionYear}-12-31`;
  const periods = [...input.periods].sort((a, b) => a.beginIso.localeCompare(b.beginIso));
  check(periods.length > 0 && periods[0]!.beginIso === start, "incomplete_period_coverage");
  for (const [index, period] of periods.entries()) {
    day(period.beginIso); day(period.endIso);
    check(period.beginIso <= period.endIso && period.endIso <= end && period.endIso <= input.observedDay, "period_scope");
    if (index) {
      const afterPrevious = new Date(`${periods[index - 1]!.endIso}T00:00:00Z`);
      afterPrevious.setUTCDate(afterPrevious.getUTCDate() + 1);
      check(afterPrevious.toISOString().slice(0, 10) === period.beginIso, "incomplete_period_coverage");
    }
  }
  const totals = periods.map(() => new Map<string, number>()), ids = new Set<string>();
  const donors = new Map<string, RhodeIslandCommitteeCashDonor>();
  let selectedOccurrences = 0, totalCents = 0;
  for (const row of input.rows) {
    check(/^\d+$/.test(row.contributionId) && !ids.has(row.contributionId), "receipt_identity");
    ids.add(row.contributionId);
    day(row.receiptDateIso);
    check(row.receiptDateIso <= input.observedDay && row.transType === "Contribution", "receipt_scope");
    check(Object.hasOwn(ERTS_CONTRIBUTION_TYPE_CODES, row.contributionType), "unknown_receipt_type");
    const matches = periods.map((p, i) => p.beginIso <= row.receiptDateIso && row.receiptDateIso <= p.endIso ? i : -1).filter(i => i >= 0);
    check(matches.length === 1, "receipt_period_membership");
    const periodTotals = totals[matches[0]!]!;
    periodTotals.set(row.contributionType, add(periodTotals.get(row.contributionType) ?? 0, row.amountCents));
    if (row.contributionType !== "PAC" && row.contributionType !== "Party") continue;
    check(row.amountCents > 0 && row.mpfMatchAmountCents === 0, "unqualified_committee_money");
    const name = row.fullName.normalize("NFC").trim().replace(/\s+/g, " ");
    check(name.length > 0 && name.length <= 500 && !/[\u0000-\u001f\u007f-\u009f\uFFFD]/u.test(name), "reported_committee_name");
    const key = JSON.stringify([row.contributionType, name.toUpperCase()]);
    const donor = donors.get(key) ?? { key, name, sourceClass: row.contributionType, amountCents: 0, contributionCount: 0 };
    donor.amountCents = add(donor.amountCents, row.amountCents);
    donor.contributionCount++;
    donors.set(key, donor);
    selectedOccurrences++;
    totalCents = add(totalCents, row.amountCents);
  }
  for (const [index, period] of periods.entries()) {
    const exported = totals[index]!;
    for (const type of new Set([...exported.keys(), ...period.groupings.keys()])) {
      check(Object.hasOwn(ERTS_CONTRIBUTION_TYPE_CODES, type), "unknown_summary_or_return_type");
      const reported = period.groupings.get(type) ?? 0;
      check(Number.isSafeInteger(reported) && (exported.get(type) ?? 0) === reported, "whole_export_summary_mismatch");
    }
    check(add(period.groupings.get("PAC") ?? 0, period.groupings.get("Aggregate - PAC") ?? 0) === period.cf2PacCents &&
      add(period.groupings.get("Party") ?? 0, period.groupings.get("Aggregate - Party") ?? 0) === period.cf2PartyCents,
    "cf2_committee_cash_mismatch");
  }
  return {
    totalCents, selectedOccurrences, receivingRows: input.rows.length,
    coverageThrough: periods[periods.length - 1]!.endIso,
    donors: [...donors.values()].sort((a, b) => b.amountCents - a.amountCents || a.key.localeCompare(b.key)),
  };
}
