import type { DenverContributionTransaction } from "./denverSearchlightClient.js";
import { normalizeDenverTextKey } from "./denverCandidateCommitteeResolver.js";

// Verified public contact types: Individual=1, Organization=2, Committee=3.
// Generic UNION/ASSOCIATION names are insufficient: current receipts include
// a credit union. Only explicit political naming admits an Organization.
const POLITICAL_NAME = /\b(PAC|POLITICAL|SMALL DONOR COMMITTEE|SDC)\b/;
export type DenverReportedCommitteeCash = {
  donors: { committeeKey: string; committeeName: string; amountCents: number; contributionCount: number }[];
  amountCents: number; contributionCount: number; transactionThrough: string | null;
};
export function aggregateDenverReportedCommitteeCash(input: {
  rows: readonly DenverContributionTransaction[]; committeeEntityIds: readonly number[];
}): DenverReportedCommitteeCash {
  const ids = new Set(input.committeeEntityIds);
  if (!ids.size) throw new Error("Denver committee cash requires receiving entity identities");
  const groups = new Map<string, DenverReportedCommitteeCash["donors"][number]>(), seen = new Set<number>();
  let amountCents = 0, contributionCount = 0, transactionThrough: string | null = null;
  for (const row of input.rows) {
    if (!ids.has(row.recipientCommitteeId)) continue;
    if (!Number.isSafeInteger(row.transactionId) || row.transactionId <= 0 || seen.has(row.transactionId))
      throw new Error("Denver committee cash has duplicate or missing native receipt identity");
    seen.add(row.transactionId);
    if (row.date) {
      const date = row.date.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)
        throw new Error("Denver committee cash has an invalid transaction date");
      if (transactionThrough === null || date > transactionThrough) transactionThrough = date;
    }
    if (row.transactionSubType !== "Monetary") continue;
    const name = row.organizationName?.trim() || row.contributorName?.trim() || "", key = normalizeDenverTextKey(name);
    const political = POLITICAL_NAME.test(key);
    if (political && row.contactTypeId === null) throw new Error("Denver political receipt has no reported contact type");
    if (row.contactTypeId !== 3 && !(row.contactTypeId === 2 && !row.contributorOccupation?.trim() && political)) continue;
    if (!key || !row.date) throw new Error("Denver identified committee receipt requires a name and date");
    if (row.organizationName?.trim() && row.contributorName?.trim() && normalizeDenverTextKey(row.organizationName) !== normalizeDenverTextKey(row.contributorName))
      throw new Error("Denver identified committee receipt has conflicting reported names");
    if (!Number.isSafeInteger(row.amountCents) || row.amountCents < 0)
      throw new Error("Denver signed or imprecise committee cash requires source review");
    if (!row.amountCents) continue;
    const group = groups.get(key) ?? { committeeKey: key, committeeName: name, amountCents: 0, contributionCount: 0 };
    group.amountCents += row.amountCents; group.contributionCount++; amountCents += row.amountCents; contributionCount++;
    if (!Number.isSafeInteger(group.amountCents) || !Number.isSafeInteger(amountCents)) throw new Error("Denver committee cash exceeds safe cent precision");
    groups.set(key, group);
  }
  return { donors: [...groups.values()].sort((a,b) => b.amountCents-a.amountCents || a.committeeKey.localeCompare(b.committeeKey)), amountCents, contributionCount, transactionThrough };
}
