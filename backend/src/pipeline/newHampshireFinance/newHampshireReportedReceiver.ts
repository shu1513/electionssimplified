import { parseNewHampshireFilingEntityRow } from "./newHampshireCfsClient.js";
import { resolveNewHampshireCandidateFilerPreferringActive } from "./newHampshireCandidateFilerResolver.js";
import { newHampshireReportedRegistration, nhSourceGuid, nhSourceHold, type NewHampshireReportedBase } from "./newHampshireReportedSourceGraph.js";
import type { NewHampshireFinanceLinkSource } from "./newHampshireFinanceWriter.js";
import { normalizeNewHampshireCandidateAlias } from "./newHampshireOutsideSpendingAggregator.js";

export type NewHampshireReportedReceiver = {
  linkId: string; candidateId: string; electionId: string; electionYear: number; electionDate: string;
  candidateName: string; candidateAliases: string[]; officeScope: string; officeName: string; district: string | null;
  filingEntityId: number; filerName: string; linkSource: NewHampshireFinanceLinkSource;
};

const normalized = new WeakMap<NewHampshireReportedBase, ReturnType<typeof parseNewHampshireFilingEntityRow>[]>();
function registrations(base: NewHampshireReportedBase) {
  let rows = normalized.get(base);
  if (!rows) { rows = base.registry.map(parseNewHampshireFilingEntityRow); normalized.set(base, rows); }
  return rows;
}
export function newHampshireAmbiguousSourceTargetAliases(base: NewHampshireReportedBase): Set<string> {
  const owners = new Map<string, Set<number>>();
  for (const row of registrations(base)) {
    // A person and their candidate committee can have separate filing IDs.
    // Person-level CAN duplicates are independent ambiguity evidence; linked
    // committee registrations are checked against the full ballot separately.
    if (row.filerTypeCode !== "CAN") continue;
    const name = row.candidateName ?? [row.firstName,row.lastName].filter(Boolean).join(" ");
    const key = normalizeNewHampshireCandidateAlias(name); if (!key) continue;
    const ids = owners.get(key) ?? new Set<number>(); ids.add(row.filingEntityId); owners.set(key, ids);
  }
  return new Set([...owners].filter(([,ids])=>ids.size>1).map(([key])=>key));
}
export function qualifyNewHampshireReportedReceiver(receiver: NewHampshireReportedReceiver, base: NewHampshireReportedBase): {
  registrationGuid: string; candidateAliases: string[];
} {
  if (base.electionYear !== receiver.electionYear) nhSourceHold("receiving_cycle_changed");
  // IE target aliases come only from the resolver, which drops a name shared
  // across races in the registry (linked or not). Seeding with the receiver's
  // own names would restore those exclusions; an empty set holds IE instead.
  const rows = registrations(base), candidateAliases = new Set<string>();
  const matched = new Set<number>();
  for (const name of receiver.candidateAliases) {
    const result = resolveNewHampshireCandidateFilerPreferringActive({ candidateName: name,
      electionCycleId: base.electionCycleId, officeScope: receiver.officeScope, officeName: receiver.officeName,
      district: receiver.district, filingEntityRows: rows });
    if (result.status === "matched") {
      matched.add(result.filingEntityId);
      if (result.filingEntityId === receiver.filingEntityId) for (const alias of result.candidateAliases) candidateAliases.add(alias);
    }
  }
  if (matched.size !== 1 || !matched.has(receiver.filingEntityId)) nhSourceHold("receiving_registration_changed");
  return { registrationGuid: nhSourceGuid(newHampshireReportedRegistration(base, receiver.filingEntityId).guid), candidateAliases: [...candidateAliases] };
}
