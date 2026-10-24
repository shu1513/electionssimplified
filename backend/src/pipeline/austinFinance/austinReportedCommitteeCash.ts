import type { AustinContributionRow, AustinPeriodReportDetailRow } from "./austinSocrataClient.js";
import { normalizeAustinFinanceTextKey } from "./austinFinanceKeys.js";

// Pennsylvania's name rule, narrowed to reported ENTITY donors with no
// occupation. Austin supplies no registry identity in this receipt dataset.
const COMMITTEE_NAME = /\b(PAC|POLITICAL|COMMITTEE|UNION|ASSOCIATION|LEAGUE|COUNCIL)\b/;

export type AustinReportedCommitteeCashDonor = {
  committeeKey: string;
  committeeName: string;
  amountCents: number;
  contributionCount: number;
};
export type AustinReportedCommitteeCash = {
  donors: AustinReportedCommitteeCashDonor[];
  amountCents: number;
  contributionCount: number;
  reportedThrough: string;
};

/** Receipts already selected by direct finance's effective-report and cycle
 * gates. Preserve distinct native occurrences, including equal same-day gifts.
 * This is gross monetary cash, not in-kind value or a net position.
 */
export function aggregateAustinReportedCommitteeCash(input: {
  contributions: readonly AustinContributionRow[];
  reports: readonly AustinPeriodReportDetailRow[];
  filerName: string;
}): AustinReportedCommitteeCash {
  const reports = new Map(input.reports.map(row => [row.reportId, row]));
  const reportedThrough = input.reports.map(row => row.periodTo).sort().at(-1);
  if (!reportedThrough) throw new Error("Austin committee cash requires qualified report periods");
  const groups = new Map<string, AustinReportedCommitteeCashDonor>();
  const seen = new Set<string>();
  let amountCents = 0, contributionCount = 0;
  for (const row of input.contributions) {
    if (!row.transactionId || seen.has(row.transactionId))
      throw new Error("Austin committee cash has duplicate or missing native receipt identity");
    seen.add(row.transactionId);
    if (row.recipient !== input.filerName) throw new Error("Austin committee cash has a different receiving filer");
    if (!reports.has(row.reportId)) throw new Error("Austin committee cash has an unselected report");
    const key = normalizeAustinFinanceTextKey(row.donor);
    if (row.donorType !== "ENTITY" || row.occupation?.trim() || !COMMITTEE_NAME.test(key) ||
      key === normalizeAustinFinanceTextKey(input.filerName) ||
      row.contributionType?.trim().toUpperCase() !== "MONETARY POLITICAL CONTRIBUTION") continue;
    const report = reports.get(row.reportId)!;
    if (!row.contributionDate || row.contributionDate < report.periodFrom || row.contributionDate > report.periodTo)
      throw new Error("Austin committee cash receipt falls outside its selected report period");
    if (!Number.isSafeInteger(row.amountCents) || row.amountCents < 0)
      throw new Error("Austin signed or imprecise committee cash requires source review");
    if (row.amountCents === 0) continue;
    const group = groups.get(key) ?? { committeeKey: key, committeeName: row.donor.trim(), amountCents: 0, contributionCount: 0 };
    group.amountCents += row.amountCents;
    group.contributionCount++;
    amountCents += row.amountCents;
    contributionCount++;
    if (!Number.isSafeInteger(group.amountCents) || !Number.isSafeInteger(amountCents))
      throw new Error("Austin committee cash exceeds safe cent precision");
    groups.set(key, group);
  }
  return { donors: [...groups.values()].sort((a, b) => b.amountCents - a.amountCents || a.committeeKey.localeCompare(b.committeeKey)),
    amountCents, contributionCount, reportedThrough };
}
