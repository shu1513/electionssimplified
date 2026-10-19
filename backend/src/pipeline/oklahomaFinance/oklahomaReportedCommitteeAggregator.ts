import type { OklahomaGuardianContributionRow } from "./oklahomaGuardianContributionReader.js";

export const OKLAHOMA_REPORTED_COMMITTEE_CLASSES = [
  "Candidate Committee (Registered)", "Candidate Committee (Not Registered)",
  "Political Action Committee (Registered)", "Political Action Committee (Not Registered)",
  "Political Party Committee (Registered)", "Political Party Committee (Not Registered)",
  "Special Function Committee (Registered)", "Special Function Committee (Not Registered)",
] as const;
export type OklahomaReportedCommitteeClass = typeof OKLAHOMA_REPORTED_COMMITTEE_CLASSES[number];
export type OklahomaReportedCommitteeGroup = {
  /** Reported name/class key, not a legal donor registration ID. */
  key: string; name: string; sourceClass: OklahomaReportedCommitteeClass; cents: number; occurrences: number;
};
export class OklahomaReportedCommitteeHold extends Error {
  constructor(public readonly code: string) { super(`Oklahoma reported committee receipts held: ${code}`); }
}
function hold(code: string): never { throw new OklahomaReportedCommitteeHold(code); }
const literal = (value: string): string => value.normalize("NFC").trim().replace(/\s+/g, " ");
const knownClasses = new Set<string>(OKLAHOMA_REPORTED_COMMITTEE_CLASSES);
function add(a: number, b: number): number {
  const n = a + b;
  if (!Number.isSafeInteger(n)) hold("unsafe_money");
  return n;
}
function cents(raw: string): number {
  if (!/^-?\$?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(raw.trim())) hold("invalid_money");
  const text = raw.trim().replace(/[$,]/g, "");
  const negative = text.startsWith("-"), [whole, fraction = ""] = (negative ? text.slice(1) : text).split(".");
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(value)) hold("unsafe_money");
  return negative ? -value : value;
}
function yearOfDate(raw: string): number {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:\s*[AP]M)?)?$/.exec(raw.trim());
  if (!m) hold("invalid_date");
  const month = Number(m[1]), day = Number(m[2]), year = Number(m[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) hold("invalid_date");
  return year;
}
function nameParts(row: OklahomaGuardianContributionRow): string[] {
  return [row["Last Name"], row["First Name"], row["Middle Name"], row.Suffix].map(literal);
}

/** Pure foundation only. Source qualification and current receiving identity are
 * separate prerequisites; arbitrary rows confer no financial write authority.
 * Until correction authority is established, any affected donation holds the
 * entire receiver. No grouping/display limit can turn a hold into a subtotal. */
export function aggregateOklahomaReportedCommittees(input: {
  organizationId: string; electionYear: number; rows: readonly OklahomaGuardianContributionRow[];
}): { cents: number; occurrences: number; groups: OklahomaReportedCommitteeGroup[] } {
  if (!/^\d+$/.test(input.organizationId) || !Number.isInteger(input.electionYear) || input.electionYear < 2014 || input.electionYear > 2100) hold("receiving_context");
  const selected = input.rows.filter(r => r["Org ID"].trim() === input.organizationId), ids = new Set<string>();
  const groups = new Map<string, OklahomaReportedCommitteeGroup>();
  let total = 0, occurrences = 0;
  for (const row of selected) {
    if (row["Committee Type"].trim() !== "Candidate Committee") hold("receiving_class");
    const id = row["Receipt ID"].trim();
    if (!id || ids.has(id)) hold("receipt_identity");
    ids.add(id);
    const sourceClass = row["Receipt Source Type"].trim(), parts = nameParts(row);
    if (!knownClasses.has(sourceClass)) {
      if (/\b(?:COMMITTEE|PAC|POLITICAL)\b/i.test(sourceClass) || (!sourceClass && /\b(?:COMMITTEE|PAC|POLITICAL)\b/i.test(parts.join(" ")))) hold("unresolved_committee_class");
      continue;
    }
    const type = row["Receipt Type"].trim();
    if (["Loan", "Refund", "Transfer In", "Transfer-In"].includes(type)) continue;
    if (!["Monetary", "In-Kind"].includes(type)) hold("unsupported_committee_receipt_type");
    const year = yearOfDate(row["Receipt Date"]);
    if (year < input.electionYear - 1 || year > input.electionYear) continue;
    if (row.Amended.trim() !== "N") hold("committee_correction");
    const amount = cents(row["Receipt Amount"]);
    if (amount <= 0) hold("nonpositive_committee_donation");
    if (!parts[0]) hold("missing_committee_name");
    const name = parts[1] || parts[2] || parts[3] ? `${parts[0]}, ${parts.slice(1).filter(Boolean).join(" ")}` : parts[0];
    const key = JSON.stringify([sourceClass, ...parts.map(p => p.toUpperCase())]);
    const group = groups.get(key) ?? { key, name, sourceClass: sourceClass as OklahomaReportedCommitteeClass, cents: 0, occurrences: 0 };
    group.cents = add(group.cents, amount); group.occurrences++; groups.set(key, group);
    total = add(total, amount); occurrences++;
  }
  return { cents: total, occurrences, groups: [...groups.values()].sort((a, b) => b.cents - a.cents || a.key.localeCompare(b.key)) };
}
