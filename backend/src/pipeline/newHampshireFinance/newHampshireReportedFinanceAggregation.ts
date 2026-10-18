import { normalizeNewHampshireCandidateAlias } from "./newHampshireOutsideSpendingAggregator.js";
import { nhSourceCents, nhSourceHold, nhSourceInteger, nhSourceText } from "./newHampshireReportedSourceGraph.js";
import { isVerifiedNewHampshireReportedSource, type NewHampshireReportedSourcePacket } from "./newHampshireReportedSourceCache.js";

export type NewHampshireReportedCommitteeGroup = {
  reportedName: string; reportedNameKey: string; amountCents: number; contributionCount: number;
};
export type NewHampshireReportedCommitteeAggregation = {
  totalAmountCents: number; contributionCount: number; excludedCurrentRowCount: number;
  groups: NewHampshireReportedCommitteeGroup[];
};
export type NewHampshireReportedIeGroup = {
  reportedSpenderId: string; reportedSpenderName: string; supportOppose: "support" | "oppose";
  amountCents: number; expenditureCount: number;
};
export type NewHampshireReportedIeAggregation = {
  supportTotalCents: number; opposeTotalCents: number; expenditureCount: number;
  matchedTargetRowCount: number; nonPositiveRowCount: number; groups: NewHampshireReportedIeGroup[];
};
function add(a: number, b: number): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) nhSourceHold("money_sum_overflow");
  return sum;
}
function packet(source: NewHampshireReportedSourcePacket, kind: "committee" | "ie"): void {
  if (!isVerifiedNewHampshireReportedSource(source) || source.kind !== kind || source.sourceRowCount !== source.currentRows.length + source.historicalRowCount ||
    !Number.isSafeInteger(source.sourceRowCount) || !Number.isSafeInteger(source.historicalRowCount) || source.historicalRowCount < 0) nhSourceHold("aggregation_source_mismatch");
}

/** Reported Political Committee code only. This is gross current monetary and
 * in-kind receipts before later returns, not legal PAC identity or net money. */
export function aggregateNewHampshireReportedCommitteeReceipts(source: NewHampshireReportedSourcePacket): NewHampshireReportedCommitteeAggregation {
  packet(source, "committee");
  const groups = new Map<string, NewHampshireReportedCommitteeGroup>();
  let totalAmountCents = 0, contributionCount = 0, excludedCurrentRowCount = 0;
  for (const row of source.currentRows) {
    const cents = nhSourceCents(row.transactionAmount);
    if (row.transactionSourceTypeCode !== "TPAC" || !["MTCB", "INKIND"].includes(String(row.transactionSubTypeCode)) ||
      typeof row.transactionSubType === "string" && /unitemized/i.test(row.transactionSubType) || cents === 0) {
      excludedCurrentRowCount++; continue;
    }
    if (cents < 0) nhSourceHold("negative_reported_committee_receipt");
    const name = nhSourceText(row.sourceName), key = name.toUpperCase();
    const group = groups.get(key) ?? { reportedName: name, reportedNameKey: key, amountCents: 0, contributionCount: 0 };
    group.amountCents = add(group.amountCents, cents); group.contributionCount++;
    // Stable display spelling, independent of the source's row order.
    if (name.localeCompare(group.reportedName) < 0) group.reportedName = name;
    groups.set(key, group); totalAmountCents = add(totalAmountCents, cents); contributionCount++;
  }
  return { totalAmountCents, contributionCount, excludedCurrentRowCount,
    groups: [...groups.values()].sort((a, b) => b.amountCents - a.amountCents || a.reportedNameKey.localeCompare(b.reportedNameKey)) };
}

/** No display cap here: totals, counts and every group persist before the
 * reader limits visible details. A target alias must be unique in the ballot. */
export function aggregateNewHampshireReportedIe(input: {
  source: NewHampshireReportedSourcePacket; candidateAliases: readonly string[]; ambiguousAliases?: ReadonlySet<string>;
}): NewHampshireReportedIeAggregation {
  packet(input.source, "ie");
  const aliases = new Set(input.candidateAliases.map(normalizeNewHampshireCandidateAlias).filter(Boolean));
  if (!aliases.size || [...aliases].some(alias => input.ambiguousAliases?.has(alias))) nhSourceHold("ambiguous_candidate_target");
  const groups = new Map<string, NewHampshireReportedIeGroup>();
  let supportTotalCents = 0, opposeTotalCents = 0, expenditureCount = 0, matchedTargetRowCount = 0, nonPositiveRowCount = 0;
  for (const row of input.source.currentRows) {
    if (!aliases.has(normalizeNewHampshireCandidateAlias(nhSourceText(row.candidateMeasure)))) continue;
    matchedTargetRowCount++;
    const amount = nhSourceCents(row.transactionAmount);
    if (amount < 0) nhSourceHold("negative_reported_ie");
    if (amount === 0) { nonPositiveRowCount++; continue; }
    const stance = row.stance === "Support" ? "support" : row.stance === "Oppose" ? "oppose" : nhSourceHold("unsupported_ie_stance");
    const id = String(nhSourceInteger(row.filerEntityId)), name = nhSourceText(row.filerName), key = `${id}:${stance}`;
    const group = groups.get(key) ?? { reportedSpenderId: id, reportedSpenderName: name, supportOppose: stance, amountCents: 0, expenditureCount: 0 };
    group.amountCents = add(group.amountCents, amount); group.expenditureCount++;
    if (name.localeCompare(group.reportedSpenderName) < 0) group.reportedSpenderName = name;
    groups.set(key, group); expenditureCount++;
    if (stance === "support") supportTotalCents = add(supportTotalCents, amount); else opposeTotalCents = add(opposeTotalCents, amount);
  }
  return { supportTotalCents, opposeTotalCents, expenditureCount, matchedTargetRowCount, nonPositiveRowCount,
    groups: [...groups.values()].sort((a, b) => b.amountCents - a.amountCents || a.reportedSpenderId.localeCompare(b.reportedSpenderId) || a.supportOppose.localeCompare(b.supportOppose)) };
}
