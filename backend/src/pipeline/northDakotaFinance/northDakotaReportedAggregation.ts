import { personNamesMatchWithMiddleEvidence } from "../finance/personNameMiddleEvidence.js";
import { normalizeNorthDakotaCandidateNameForStorage, stripNorthDakotaHonorific } from "./northDakotaCandidateCommitteeResolver.js";
import type { NorthDakotaCommitteeRow, NorthDakotaTransactionRow } from "./northDakotaCfrsClient.js";
import type { NorthDakotaContributionCsvRow } from "./northDakotaCfrsCsv.js";
import { NORTH_DAKOTA_CONTRIBUTION_FILE_CATEGORIES } from "./northDakotaDirectContributionAggregator.js";
import { apiAmountToCents, reconcileNorthDakotaCommittee } from "./northDakotaPhaseZero.js";

export class NorthDakotaReportedHold extends Error {
  constructor(public readonly code: string) { super(`North Dakota reported finance held: ${code}`); }
}
export function ndHold(code: string): never { throw new NorthDakotaReportedHold(code); }
export const ndLiteral = (v: string | null | undefined): string => (v ?? "").normalize("NFC").trim().replace(/\s+/g, " ").toUpperCase();
export function ndAdd(a: number, b: number): number {
  const n = a + b;
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(n)) ndHold("unsafe_money");
  return n;
}
export const ndCommitteeClass = (s: string | null): s is "Committee/PAC" | "Party Committee" => s === "Committee/PAC" || s === "Party Committee";

/** Receiving labels corroborate an already equal native ID and committee label.
 * Missing middles are acceptable; contradictory middle/suffix evidence is not.
 * This must never be applied to an organization donor's name. */
export function ndReceivingPersonMatches(a: string | null, b: string | null): boolean {
  if (!ndLiteral(a) || !ndLiteral(b)) return ndLiteral(a) === ndLiteral(b);
  return personNamesMatchWithMiddleEvidence({
    candidateName: stripNorthDakotaHonorific(a!), rowNames: [stripNorthDakotaHonorific(b!)],
    normalizePersonName: value => normalizeNorthDakotaCandidateNameForStorage(value).replace(/\b(JR|SR|II|III|IV)\b/g, " ").replace(/\s+/g, " ").trim(),
  });
}

export type NorthDakotaReportedCommitteeGroup = {
  key: string;
  name: string;
  sourceClass: "Committee/PAC" | "Party Committee";
  cents: number;
  occurrences: number;
};

/** Complete CSV/API controls precede selecting one candidate or capping names.
 * Equal legitimate occurrences remain separate. API transaction IDs must be
 * unique; unpopulated version/status fields confer no amendment authority. */
export function validateNorthDakotaReportedContributions(input: {
  year: number;
  csv: readonly NorthDakotaContributionCsvRow[];
  api: readonly NorthDakotaTransactionRow[];
  registry: readonly NorthDakotaCommitteeRow[];
}): void {
  const registry = new Map(input.registry.map(r => [r.entityId, r]));
  if (registry.size !== input.registry.length || !registry.size) ndHold("registry_identity");
  const ids = new Set<number>();
  for (const r of input.api) {
    if (!Number.isSafeInteger(r.transactionID) || r.transactionID <= 0 || ids.has(r.transactionID)) ndHold("transaction_identity");
    ids.add(r.transactionID);
    const registered = registry.get(r.entityID);
    if (!registered || registered.orgID !== r.orgID || ndLiteral(registered.orgName) !== ndLiteral(r.committeeName) || !ndReceivingPersonMatches(registered.candidateName, r.candidateName)) ndHold("api_receiving_identity");
    if (r.transactionTypeDesc !== "Contributions" || !r.transactionDate.startsWith(`${input.year}-`) || !Number.isSafeInteger(apiAmountToCents(r.transactionAmount))) ndHold("contribution_dataset");
  }
  for (const r of input.csv) {
    const registered = registry.get(r.registrantId);
    if (!registered || r.recovered || ndLiteral(registered.orgName) !== ndLiteral(r.committeeName) || !ndReceivingPersonMatches(registered.candidateName, r.candidateName)) ndHold("csv_receiving_identity");
    if (r.transactionType !== "Contributions" || !r.transactionDate.startsWith(`${input.year}-`) || !NORTH_DAKOTA_CONTRIBUTION_FILE_CATEGORIES.has(r.transactionCategory) || !Number.isSafeInteger(r.amountCents)) ndHold("contribution_dataset");
  }
  const receivers = new Set([...input.csv.map(r => r.registrantId), ...input.api.map(r => r.entityID)]);
  for (const entityId of receivers) {
    const check = reconcileNorthDakotaCommittee({ entityId, csvRows: input.csv, apiRows: input.api });
    if (!check.totalsMatch || !check.multisetMatch) ndHold("contribution_multiset");
  }
  const literalTuple = (r: NorthDakotaContributionCsvRow | NorthDakotaTransactionRow): string => {
    const api = "transactionID" in r;
    return JSON.stringify([
      api ? r.entityID : r.registrantId, r.transactionDate.slice(0, 10), api ? apiAmountToCents(r.transactionAmount) : r.amountCents,
      api ? r.transactionCategoryDesc : r.transactionCategory, api ? r.entityTypeDesc : r.contributorType,
      ndLiteral(r.committeeName), ndLiteral(api ? r.contributorPayeeName : r.contributorName), ndLiteral(r.employerName), (r.filedDate ?? "").slice(0, 10),
    ]);
  };
  const csv = input.csv.filter(r => ndCommitteeClass(r.contributorType)).map(literalTuple).sort();
  const api = input.api.filter(r => ndCommitteeClass(r.entityTypeDesc)).map(literalTuple).sort();
  if (JSON.stringify(csv) !== JSON.stringify(api)) ndHold("named_committee_multiset");
  for (const r of input.csv.filter(r => ndCommitteeClass(r.contributorType))) {
    const matches = input.registry.filter(s => ndLiteral(s.orgName) === ndLiteral(r.contributorName));
    if (!ndLiteral(r.contributorName) || matches.length !== 1 || matches[0]!.orgType !== r.contributorType) ndHold("reported_donor_registry_class");
  }
}

/** Reported committee cash/in-kind receipts, signed and before separate returns.
 * Source contact IDs are deliberately never joined to filer registry IDs. */
export function aggregateNorthDakotaReportedCommittees(input: {
  entityId: string;
  windowStart: string;
  windowEnd: string;
  rows: readonly NorthDakotaContributionCsvRow[];
}): { cents: number; occurrences: number; groups: NorthDakotaReportedCommitteeGroup[] } {
  const groups = new Map<string, NorthDakotaReportedCommitteeGroup>();
  let cents = 0, occurrences = 0;
  for (const r of input.rows) {
    if (r.registrantId !== input.entityId || r.transactionDate < input.windowStart || r.transactionDate > input.windowEnd || !ndCommitteeClass(r.contributorType) || !["Monetary", "In-Kind"].includes(r.transactionCategory)) continue;
    if (r.recovered || !ndLiteral(r.contributorName)) ndHold("reported_donor_shape");
    const key = JSON.stringify([r.contributorType, ndLiteral(r.contributorName)]);
    const g = groups.get(key) ?? { key, name: r.contributorName.trim().replace(/\s+/g, " "), sourceClass: r.contributorType, cents: 0, occurrences: 0 };
    g.cents = ndAdd(g.cents, r.amountCents); g.occurrences++; groups.set(key, g);
    cents = ndAdd(cents, r.amountCents); occurrences++;
  }
  return { cents, occurrences, groups: [...groups.values()].sort((a, b) => b.cents - a.cents || a.key.localeCompare(b.key)) };
}
