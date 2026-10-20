import { hiAdd, hiCents, hiDay, hiHold, hiLiteral, hiNameKey, hiRequired, hiText } from "./hawaiiReportedCore.js";

export type HawaiiPublishedRow = Record<string, unknown>;
export type HawaiiCommitteeEvidence = "declared_noncandidate" | "declared_party" | "registry_and_sender" | "explicit_committee_name";
export type HawaiiReportedCommitteeGroup = {
  key: string; name: string; sourceClass: string; evidence: HawaiiCommitteeEvidence; cents: number; occurrences: number;
};
export type HawaiiReportedClassControl = { rows: number; cents: number; includedRows: number; includedCents: number };
export type HawaiiReportedCommitteeAggregation = {
  sourceRows: number; ledgerCents: number; includedRows: number; totalCents: number;
  classControls: Record<string, HawaiiReportedClassControl>; groups: HawaiiReportedCommitteeGroup[];
};

const CLASSES = new Set(["Noncandidate Committee", "Political Party", "Candidate", "Individual", "Immediate Family", "Other Entity"]);
// A generic union/company/association is not automatically a political committee.
const EXPLICIT_COMMITTEE = /\b(?:PAC|POLITICAL\s+(?:ACTION\s+)?(?:COMMITTEE|FUND)|(?:DEMOCRATIC|REPUBLICAN)\s+(?:PARTY|COMMITTEE))\b/i;
const PLACEHOLDER = /^(?:UNKNOWN|UNIDENTIFIED|UNITEMIZED(?: CONTRIBUTIONS)?|NOT PROVIDED|NOT AVAILABLE|REDACTED|N\/A|NONE)$/i;
const emptyEmployment = (value: unknown): boolean => value === undefined || ["", "N/A", "NA", "NONE", "NOT APPLICABLE"].includes(hiText(value).toUpperCase());

/** Pure foundation only. Writer authority additionally requires genuine source,
 * receiving-seat and native cover qualification. No caller-supplied rows or
 * successful aggregation object can authorize a financial write. */
export function aggregateHawaiiReportedCommittees(input: {
  receivingCommitteeId: string; electionPeriod: string; windowStart: string; windowEnd: string; asOfDay: string;
  rows: readonly HawaiiPublishedRow[];
  registeredNoncandidateNames: ReadonlySet<string>;
  corroboratedSenderNames: ReadonlySet<string>;
}): HawaiiReportedCommitteeAggregation {
  const id = hiRequired(input.receivingCommitteeId), period = hiRequired(input.electionPeriod);
  const start = hiDay(input.windowStart), end = hiDay(input.windowEnd), asOf = hiDay(input.asOfDay);
  if (!/^20\d\d-20\d\d$/.test(period) || ![2, 4].includes(Number(period.slice(-4)) - Number(period.slice(0, 4)))
    || start > end || asOf < start || start.slice(0, 4) !== period.slice(0, 4) || end.slice(0, 4) !== period.slice(-4)) hiHold("receiving_period");
  const rows = input.rows.filter(row => row.reg_no === id && row.election_period === period);
  if (!rows.length) hiHold("receiving_ledger_missing");
  const seen = new Set<string>(), groups = new Map<string, HawaiiReportedCommitteeGroup>();
  const controls: Record<string, HawaiiReportedClassControl> = {};
  let ledgerCents = 0, includedRows = 0, totalCents = 0;
  for (const row of rows) {
    const occurrence = hiRequired(row.source_row_id), sourceClass = hiRequired(row.contributor_type);
    if (seen.has(occurrence)) hiHold("published_row_identity");
    seen.add(occurrence);
    if (!CLASSES.has(sourceClass)) hiHold("unknown_contributor_class");
    const date = hiDay(row.date), amount = hiCents(row.amount), name = hiRequired(row.contributor_name);
    if (date < start || date > end || date > asOf) hiHold("receipt_window");
    if (amount <= 0) hiHold("receipt_correction");
    if (!["Y", "N"].includes(hiRequired(row.non_monetary_yes_or_no))) hiHold("receipt_kind");
    if (PLACEHOLDER.test(name)) hiHold("unresolved_contributor_name");
    const control = controls[sourceClass] ?? { rows: 0, cents: 0, includedRows: 0, includedCents: 0 };
    control.rows++; control.cents = hiAdd(control.cents, amount); controls[sourceClass] = control;
    ledgerCents = hiAdd(ledgerCents, amount);
    // Candidate is a distinct, unresolved source class. Neither a shared name
    // nor registration of a candidate establishes a committee donor.
    if (sourceClass === "Candidate") hiHold("candidate_donor_class_unresolved");
    const nameKey = hiNameKey(name);
    let evidence: HawaiiCommitteeEvidence | null = null;
    if (sourceClass === "Noncandidate Committee") evidence = "declared_noncandidate";
    else if (sourceClass === "Political Party") evidence = "declared_party";
    else if (sourceClass === "Other Entity") {
      if (input.registeredNoncandidateNames.has(nameKey)) {
        if (!input.corroboratedSenderNames.has(nameKey)) hiHold("uncorroborated_registered_entity");
        evidence = "registry_and_sender";
      } else if (EXPLICIT_COMMITTEE.test(name)) {
        if (!emptyEmployment(row.employer) || !emptyEmployment(row.occupation)) hiHold("contradictory_entity_employment");
        evidence = "explicit_committee_name";
      }
    } else if (EXPLICIT_COMMITTEE.test(name) || input.registeredNoncandidateNames.has(nameKey)) hiHold("contradictory_contributor_class");
    if (!evidence) continue;
    const key = JSON.stringify([sourceClass, evidence, nameKey]);
    const group = groups.get(key) ?? { key, name: hiLiteral(name), sourceClass, evidence, cents: 0, occurrences: 0 };
    group.cents = hiAdd(group.cents, amount); group.occurrences++; groups.set(key, group);
    control.includedRows++; control.includedCents = hiAdd(control.includedCents, amount);
    totalCents = hiAdd(totalCents, amount); includedRows++;
  }
  return { sourceRows: rows.length, ledgerCents, includedRows, totalCents, classControls: controls,
    groups: [...groups.values()].sort((a, b) => b.cents - a.cents || a.key.localeCompare(b.key)) };
}
