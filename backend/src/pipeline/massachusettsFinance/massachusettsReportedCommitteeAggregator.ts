/** Pure reported-label arithmetic. Original-source completeness, current
 * receiving context and publication gates are separate prerequisites. */
export class MassachusettsReportedHold extends Error {
  constructor(public readonly code: string) {
    super(`Massachusetts reported finance held: ${code}`);
  }
}
export function maReportedHold(code: string): never {
  throw new MassachusettsReportedHold(code);
}
export const maReportedLiteral = (value: string): string =>
  value.normalize("NFC").trim().replace(/\s+/g, " ");
export function maReportedAdd(a: number, b: number): number {
  const value = a + b;
  if (![a, b, value].every(Number.isSafeInteger)) maReportedHold("unsafe_money");
  return value;
}
/** Native currency strings, never parseFloat or binary floating-point sums. */
export function maReportedCents(value: unknown): number {
  if (typeof value !== "string") maReportedHold("money_format");
  let text = value.trim(), negative = false;
  if (text.startsWith("(") && text.endsWith(")")) {
    negative = true;
    text = text.slice(1, -1);
  } else if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1);
  }
  const match = /^\$?(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) maReportedHold("money_format");
  const cents = BigInt(match[1]!.replace(/,/g, "")) * 100n +
    BigInt((match[2] ?? "").padEnd(2, "0"));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) maReportedHold("unsafe_money");
  return Number(cents) * (negative ? -1 : 1);
}
/** Keep the calendar date as filed, rather than shifting it through UTC. */
export function maReportedDay(value: unknown): string {
  if (typeof value !== "string") maReportedHold("date_format");
  const text = value.trim(), slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.exec(text);
  if (!slash && !iso) maReportedHold("date_format");
  const year = Number(slash ? slash[3] : iso![1]),
    month = Number(slash ? slash[1] : iso![2]),
    day = Number(slash ? slash[2] : iso![3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day ||
    (iso?.[4] !== undefined && (Number(iso[4]) > 23 || Number(iso[5]) > 59 || Number(iso[6]) > 59 || !Number.isFinite(Date.parse(text)))))
    maReportedHold("date_format");
  return date.toISOString().slice(0, 10);
}

export type MassachusettsReportedReceipt = Readonly<Record<string, unknown>>;
export type MassachusettsReportedCommitteeGroup = {
  key: string;
  name: string;
  sourceClass: "Committee";
  cents: number;
  occurrences: number;
};
// Native /search/recordTypes/A. 299 is a query selector (Registered PACs),
// not a demonstrated transaction class, and must never silently become one.
const knownNonCommitteeTypes = new Set([201, 203, 204, 205, 206, 207, 210, 220, 401, 403, 404, 420]);
function nativeId(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)) return value;
  return maReportedHold("receipt_identity");
}

/** Gross positive itemized monetary/in-kind committee contributions dated in
 * 2026, before separately reported expenditure-side returns. Transfers are
 * excluded. Prior-year flags require report-year authority, not an inferred
 * exclusion of a late filing. Unresolved refund links or
 * nonpositive committee donations hold the receiver, never a partial subtotal.
 * Reported labels and native contact IDs do not assert legal donor identity. */
export function aggregateMassachusettsReportedCommittees(input: {
  receivingCpfId: string;
  electionYear: number;
  observedDay: string;
  rows: readonly MassachusettsReportedReceipt[];
}): { cents: number; occurrences: number; groups: MassachusettsReportedCommitteeGroup[] } {
  if (!/^[1-9]\d*$/.test(input.receivingCpfId) || !Number.isSafeInteger(Number(input.receivingCpfId)) ||
    input.electionYear !== 2026 || maReportedDay(input.observedDay) !== input.observedDay)
    maReportedHold("receiving_context");
  if (!input.rows.length) maReportedHold("receiving_ledger_missing");
  const seen = new Set<string>(), groups = new Map<string, MassachusettsReportedCommitteeGroup>();
  let cents = 0, occurrences = 0;
  for (const row of input.rows) {
    if (typeof row.filerCpfId !== "number" || String(row.filerCpfId) !== input.receivingCpfId ||
      !Number.isSafeInteger(row.reportId) || (row.reportId as number) <= 0)
      maReportedHold("receipt_receiving_identity");
    const id = nativeId(row.id);
    if (seen.has(id)) maReportedHold("receipt_identity");
    seen.add(id);
    const date = maReportedDay(row.date);
    if (date > input.observedDay) maReportedHold("future_receipt");
    if (!date.startsWith("2026-")) continue;
    if (knownNonCommitteeTypes.has(row.recordTypeId as number)) continue;
    if (row.recordTypeId !== 202 && row.recordTypeId !== 402) maReportedHold("unknown_receipt_type");
    if (typeof row.isTransfer !== "boolean" || typeof row.isPreviousYearContribution !== "boolean")
      maReportedHold("receipt_accounting_flags");
    if (row.isTransfer) continue;
    if (row.isPreviousYearContribution) maReportedHold("previous_year_requires_authority");
    if (row.linkedRefundGuid !== null && row.linkedRefundGuid !== "")
      maReportedHold("refund_link_requires_authority");
    const amount = maReportedCents(row.amount);
    if (amount <= 0) maReportedHold("nonpositive_committee_donation");
    if (typeof row.fullNameReverse !== "string") maReportedHold("committee_name");
    const name = maReportedLiteral(row.fullNameReverse);
    if (!name || /[\u0000-\u001f\u007f]/.test(name)) maReportedHold("committee_name");
    let sourceId = "";
    if (row.contributorCpfId !== null && row.contributorCpfId !== 0) {
      if (typeof row.contributorCpfId !== "number" || !Number.isSafeInteger(row.contributorCpfId) || row.contributorCpfId <= 0)
        maReportedHold("reported_donor_identity");
      sourceId = String(row.contributorCpfId);
    }
    const key = JSON.stringify(["Committee", sourceId, name.toUpperCase()]),
      group = groups.get(key) ?? { key, name, sourceClass: "Committee" as const, cents: 0, occurrences: 0 };
    group.cents = maReportedAdd(group.cents, amount);
    group.occurrences++;
    groups.set(key, group);
    cents = maReportedAdd(cents, amount);
    occurrences++;
  }
  return { cents, occurrences, groups: [...groups.values()].sort((a, b) => b.cents - a.cents || a.key.localeCompare(b.key)) };
}
