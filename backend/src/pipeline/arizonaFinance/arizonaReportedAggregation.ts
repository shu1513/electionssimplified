import { azAdd, azCanonical, azCents, azHash, azHold, type ArizonaReportedKind, type ArizonaReportedNativeRow } from "./arizonaReportedCore.js";

export const AZ_NATIVE_INCOME_CLASSES: Readonly<Record<string, string>> = Object.freeze({
  "1": "Contribution from Candidate or Family", "2": "Contribution from Individuals", "5": "In-State Contributions $100 or Less",
  "6": "In-Kind Cont. Candidate or Family", "7": "In-Kind Cont. from Individual", "10": "CCEC $5 Qualifying Contribution",
  "12": "Receive CCEC Funding", "13": "Receive Interest/Dividends", "16": "Receive Loan from Candidate or Family Member",
  "17": "Receive Loan from Individual", "20": "Transfer in Surplus from Prev Committee", "42": "Refund Candidate or Family Contribution",
  "43": "Refund Contribution from Individual", "56": "Submit $5 Qualifying Contributions to SOS", "57": "Refund CCEC Funding",
  "59": "Payment on Candidate/Family Loan", "60": "Payment on Individual Loan", "114": "Contributions from Candidate Committees",
  "115": "Contributions from PACs", "116": "Contributions from Parties", "117": "Contributions from Partnerships",
  "118": "Contributions from Corps and LLCs", "119": "Contributions from Labor Organizations", "120": "Non-Contribution Income",
  "128": "Refund Contributions from Candidate Committees", "184": "Candidate Committee In-Kind Contrib",
  "185": "PAC In-Kind Contribution", "190": "Non-Contribution In-Kind Income",
});
export const AZ_NATIVE_IE_CLASSES: Readonly<Record<string, string>> = Object.freeze({
  "215": "Ind. Expend. (Non-Recall) - cash", "216": "Refund Ind. Expend. (Non-Recall) - cash", "217": "Ind. Expend. (Non-Recall) - credit",
});
const COMMITTEE_CODES = new Set(["114", "115", "116", "128", "184", "185"]);
export type ArizonaReportedGroup = { key: string; name: string; sourceClass: string; stance: "direct" | "support" | "oppose"; cents: number; occurrences: number };
export type ArizonaReportedAggregation = {
  groups: ArizonaReportedGroup[]; sourceRows: number; includedRows: number; excludedRows: number;
  sourceCents: number; excludedCents: number; totalCents: number; positiveCents: number; returnedCents: number;
  supportCents: number; opposeCents: number; groupsHash: string;
};
function blank(): ArizonaReportedAggregation {
  return { groups: [], sourceRows: 0, includedRows: 0, excludedRows: 0, sourceCents: 0, excludedCents: 0,
    totalCents: 0, positiveCents: 0, returnedCents: 0, supportCents: 0, opposeCents: 0, groupsHash: "" };
}
/** Group reported labels, not inferred legal donor identities. All source
 * occurrences survive classification, including signed returns and zeros. */
export function aggregateArizonaReportedCommittee(rows: readonly ArizonaReportedNativeRow[]): ArizonaReportedAggregation {
  const a = blank(), groups = new Map<string, ArizonaReportedGroup>();
  for (const r of rows) {
    if (AZ_NATIVE_INCOME_CLASSES[r.typeId] !== r.typeName) azHold("unknown_income_class");
    const cents = azCents(r.units); a.sourceRows++; a.sourceCents = azAdd(a.sourceCents, cents);
    if (!COMMITTEE_CODES.has(r.typeId)) { a.excludedRows++; a.excludedCents = azAdd(a.excludedCents, cents); continue; }
    if (!r.name?.trim()) azHold("missing_committee_label");
    if (r.typeId === "128" && cents > 0) azHold("unresolved_committee_return_sign");
    if (r.typeId !== "128" && cents < 0) azHold("unqualified_negative_committee_receipt");
    const name = r.name.normalize("NFKC").replace(/\s+/g, " ").trim(), key = "committee:" + azHash(name.toUpperCase()),
      group = groups.get(key) ?? { key, name, sourceClass: "reported_committee", stance: "direct" as const, cents: 0, occurrences: 0 };
    if (name.localeCompare(group.name) < 0) group.name = name;
    group.cents = azAdd(group.cents, cents); group.occurrences++;
    groups.set(key, group); a.includedRows++; a.totalCents = azAdd(a.totalCents, cents);
    if (cents < 0) a.returnedCents = azAdd(a.returnedCents, -cents); else a.positiveCents = azAdd(a.positiveCents, cents);
  }
  if ([...groups.values()].some(g => g.cents < 0)) azHold("negative_committee_label_net");
  a.groups = [...groups.values()].sort((x, y) => x.key.localeCompare(y.key));
  a.groupsHash = azHash(azCanonical(a.groups));
  validateArizonaReportedClosure(a, "committee"); return a;
}
export function aggregateArizonaReportedIe(support: readonly ArizonaReportedNativeRow[], oppose: readonly ArizonaReportedNativeRow[]): ArizonaReportedAggregation {
  const a = blank(), groups = new Map<string, ArizonaReportedGroup>();
  for (const [stance, rows] of [["support", support], ["oppose", oppose]] as const) for (const r of rows) {
    if (AZ_NATIVE_IE_CLASSES[r.typeId] !== r.typeName) azHold("unknown_ie_class");
    // The portal exposes a positive refund amount. Until its reduction is
    // reconciled, retain the whole candidate's previous qualified component.
    if (r.typeId === "216") azHold("unqualified_ie_refund");
    const cents = azCents(r.units);
    if (cents <= 0 || r.committeeId === "0") azHold("unqualified_ie_amount_or_filer");
    const key = `ie:${r.committeeId}:${stance}`, group = groups.get(key) ?? {
      key, name: r.committeeName, sourceClass: "reported_independent_expenditure", stance, cents: 0, occurrences: 0 };
    if (group.name !== r.committeeName) azHold("conflicting_ie_filer_labels");
    group.cents = azAdd(group.cents, cents); group.occurrences++; groups.set(key, group);
    a.sourceRows++; a.includedRows++; a.sourceCents = azAdd(a.sourceCents, cents); a.totalCents = azAdd(a.totalCents, cents);
    a.positiveCents = azAdd(a.positiveCents, cents);
    if (stance === "support") a.supportCents = azAdd(a.supportCents, cents); else a.opposeCents = azAdd(a.opposeCents, cents);
  }
  a.groups = [...groups.values()].sort((x, y) => x.key.localeCompare(y.key));
  a.groupsHash = azHash(azCanonical(a.groups));
  validateArizonaReportedClosure(a, "ie"); return a;
}
export function validateArizonaReportedClosure(a: ArizonaReportedAggregation, kind: ArizonaReportedKind): void {
  if (!a || !Array.isArray(a.groups) || !["committee", "ie"].includes(kind)) azHold("component_closure");
  if (a.groups.some(g => !g || typeof g !== "object" || typeof g.key !== "string")) azHold("stored_group");
  if (azCanonical(Object.keys(a).sort()) !== azCanonical(["groups", "sourceRows", "includedRows", "excludedRows", "sourceCents", "excludedCents", "totalCents", "positiveCents", "returnedCents", "supportCents", "opposeCents", "groupsHash"].sort()) ||
    typeof a.groupsHash !== "string" || a.groupsHash !== azHash(azCanonical([...a.groups].sort((x, y) => x.key.localeCompare(y.key))))) azHold("component_group_digest");
  for (const k of ["sourceRows", "includedRows", "excludedRows", "sourceCents", "excludedCents", "totalCents", "positiveCents", "returnedCents", "supportCents", "opposeCents"] as const)
    if (!Number.isSafeInteger(a[k]) || (!k.endsWith("Cents") && (a[k] < 0 || a[k] > 20000))) azHold("component_control_integer");
  if ([a.totalCents, a.positiveCents, a.returnedCents, a.supportCents, a.opposeCents].some(n => n < 0) ||
    a.sourceRows !== a.includedRows + a.excludedRows || a.sourceCents !== azAdd(a.totalCents, a.excludedCents) ||
    a.totalCents !== a.positiveCents - a.returnedCents) azHold("component_totals");
  let cents = 0, occurrences = 0, support = 0, oppose = 0; const keys = new Set<string>();
  for (const g of a.groups) {
    if (!g || typeof g.key !== "string" || !g.key || keys.has(g.key) || typeof g.name !== "string" || !g.name.trim() ||
      !Number.isSafeInteger(g.cents) || g.cents < 0 || !Number.isSafeInteger(g.occurrences) || g.occurrences < 1 || g.occurrences > 20000 ||
      g.sourceClass !== (kind === "committee" ? "reported_committee" : "reported_independent_expenditure") ||
      (kind === "committee" ? g.stance !== "direct" || g.key !== "committee:" + azHash(g.name.normalize("NFKC").replace(/\s+/g, " ").trim().toUpperCase()) :
        !["support", "oppose"].includes(g.stance) || !/^ie:[1-9]\d*:(?:support|oppose)$/.test(g.key) || !g.key.endsWith(":" + g.stance))) azHold("stored_group");
    keys.add(g.key); cents = azAdd(cents, g.cents); occurrences = azAdd(occurrences, g.occurrences);
    if (g.stance === "support") support = azAdd(support, g.cents); if (g.stance === "oppose") oppose = azAdd(oppose, g.cents);
  }
  if (cents !== a.totalCents || occurrences !== a.includedRows || support !== a.supportCents || oppose !== a.opposeCents ||
    (kind === "committee" ? support !== 0 || oppose !== 0 : a.excludedRows !== 0 || a.returnedCents !== 0 || a.totalCents !== support + oppose)) azHold("stored_group_closure");
  // Canonical serialization also rejects malformed non-JSON controls before
  // persistence; callers never use an aggregation as source authority.
  azCanonical(a);
}
