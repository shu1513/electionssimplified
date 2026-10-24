import type { LosAngelesContributionRecord } from "./losAngelesOpenDataClient.js";
import { normalizeLosAngelesCandidateName } from "./losAngelesCandidateCommitteeResolver.js";
import { personNamesMatchWithMiddleEvidence } from "../finance/personNameMiddleEvidence.js";
import { firstNamesConflict } from "../finance/personFirstNameNicknames.js";

export function normalizeLosAngelesCommitteeKey(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase()
    .replace(/&/g, " AND ").replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
export type LosAngelesReportedCommitteeCash = {
  donors: { committeeKey: string; committeeName: string; amountCents: number; contributionCount: number }[];
  amountCents: number; contributionCount: number; reportedThrough: string | null; receivingCommitteeIds: string[];
};
export function losAngelesReceivingCommitteeIds(anchor: string, scope?: readonly string[]): string[] {
  const ids = [...(scope ?? [anchor])].sort();
  if (!ids.length || ids.length > 2 || new Set(ids).size !== ids.length || !ids.includes(anchor) || ids.some(id => !/^\d{4,12}$/.test(id)))
    throw new Error("Invalid Los Angeles receiving committee scope");
  return ids;
}
const NAME_RULE = /\b(PAC|POLITICAL|COMMITTEE|UNION|ASSOCIATION|LEAGUE|COUNCIL)\b/;
function date(value: string): string {
  const day = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0,10) !== day)
    throw new Error("Los Angeles cash has an invalid report or receipt date");
  return day;
}
/** Gross itemized Schedule A cash under reported labels, never registry PAC
 * identity. The caller has already closed every receiving ledger to the
 * whole-cycle headline. Equal native publication occurrences stay distinct.
 */
export function aggregateLosAngelesReportedCommitteeCash(input: {
  records: readonly LosAngelesContributionRecord[]; receivingCommitteeIds: readonly string[];
  candidateName: string; electionYear: number; reportedThrough?: string | null;
}): LosAngelesReportedCommitteeCash {
  const ids = losAngelesReceivingCommitteeIds(input.receivingCommitteeIds[0] ?? "", input.receivingCommitteeIds);
  const owned = new Set(ids), ownNames = new Set(input.records.map(row => normalizeLosAngelesCommitteeKey(row.committeeName)));
  const seen = new Set<string>(), groups = new Map<string, LosAngelesReportedCommitteeCash["donors"][number]>();
  let amountCents = 0, contributionCount = 0, reportedThrough: string | null = input.reportedThrough ? date(input.reportedThrough) : null;
  for (const row of input.records) {
    if (!owned.has(row.committeeId) || !row.sourceRowId || seen.has(row.sourceRowId))
      throw new Error("Los Angeles cash has a foreign, missing or duplicate native publication row");
    seen.add(row.sourceRowId);
    if (!row.electionDate || date(row.electionDate).slice(0,4) !== String(input.electionYear))
      throw new Error("Los Angeles cash has a different election year");
    if (row.candidateName && !personNamesMatchWithMiddleEvidence({ candidateName: input.candidateName,
      rowNames: [row.candidateName], normalizePersonName: normalizeLosAngelesCandidateName,
      firstNamesEquivalent: (a,b) => !firstNamesConflict(a,b) }))
      throw new Error("Los Angeles receiving ledger has a conflicting candidate label");
    if (row.periodEndDate) { const end = date(row.periodEndDate); if (reportedThrough === null || end > reportedThrough) reportedThrough = end; }
    const key = normalizeLosAngelesCommitteeKey(row.contributorName);
    if (row.schedule !== "A" || row.contributionType !== "Monetary Contributions (Itemized)" ||
      row.occupation?.trim() || !NAME_RULE.test(key) || ownNames.has(key)) continue;
    if (!row.contributionDate || !row.periodBeginDate || !row.periodEndDate || date(row.contributionDate) < date(row.periodBeginDate) || date(row.contributionDate) > date(row.periodEndDate))
      throw new Error("Los Angeles identified cash falls outside its reported period");
    if (row.memo?.trim() || row.amountPaidOrForgiven !== 0)
      throw new Error("Los Angeles identified cash has unresolved memo or repayment treatment");
    const cents = Math.round(row.amount * 100);
    if (!Number.isFinite(row.amount) || !Number.isSafeInteger(cents) || Math.abs(row.amount * 100 - cents) > 0.0001 || cents < 0)
      throw new Error("Los Angeles signed or imprecise committee cash requires source review");
    if (!cents) continue;
    const group = groups.get(key) ?? { committeeKey: key, committeeName: row.contributorName.trim(), amountCents: 0, contributionCount: 0 };
    group.amountCents += cents; group.contributionCount++; amountCents += cents; contributionCount++;
    if (!Number.isSafeInteger(group.amountCents) || !Number.isSafeInteger(amountCents)) throw new Error("Los Angeles cash exceeds safe cent precision");
    groups.set(key, group);
  }
  return { donors: [...groups.values()].sort((a,b) => b.amountCents-a.amountCents || a.committeeKey.localeCompare(b.committeeKey)),
    amountCents, contributionCount, reportedThrough, receivingCommitteeIds: ids };
}
