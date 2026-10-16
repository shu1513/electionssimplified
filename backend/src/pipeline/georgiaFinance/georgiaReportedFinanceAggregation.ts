import { isGeorgiaRecognizedTransactionStatus, type GeorgiaIndependentExpenditureRow } from "./georgiaEthicsClient.js";
import type { GeorgiaReportedContributionExport } from "./georgiaReportedContributionExport.js";

// Georgia's legacy aggregator caps persisted groups and treats malformed
// candidate rows as exclusions. These independent reported components need
// complete uncapped cent controls and an affected-candidate hold; extending
// the shared snapshot factory would change unrelated state contracts.
export type GeorgiaReportedIeGroup = {
  reportedSpenderId: string; reportedSpenderName: string;
  supportOppose: "support" | "oppose"; amountCents: number; expenditureCount: number;
};
export type GeorgiaReportedIeAggregation = {
  status: "qualified"; groups: GeorgiaReportedIeGroup[];
  sourceRowCount: number; candidateTargetRowCount: number; expenditureCount: number;
  otherAllocationYearRowCount: number; multiTargetRowCount: number; multiTargetAmountCents: number;
  supportTotalCents: number; opposeTotalCents: number;
};
export type GeorgiaReportedCommitteeGroup = {
  reportedName: string; reportedNameKey: string; reportedClass: "Non-Candidate Committee" | "Candidate / Candidate Committee";
  amountCents: number; contributionCount: number;
};
export type GeorgiaReportedCommitteeAggregation = {
  status: "qualified"; groups: GeorgiaReportedCommitteeGroup[]; contributionCount: number; totalAmountCents: number;
};
type Held = { status: "held"; reason: "invalid_candidate_ie_row" | "unsafe_cent_sum" | "receiving_export_held" | "invalid_reported_contribution" };
const clean = (s: string) => s.normalize("NFC").trim().replace(/\s+/gu, " ");
const text = (s: unknown): s is string => typeof s === "string" && s.trim() !== "" && !/[\u0000-\u001f\u007f]/u.test(s);
const exactCents = (n: number): number | null => {
  const cents = Math.round(n * 100);
  return Number.isFinite(n) && Number.isSafeInteger(cents) && cents / 100 === n ? cents : null;
};
class UnsafeCentSum extends Error {}
function add(a: number, b: number): number {
  const n = a + b; if (!Number.isSafeInteger(n)) throw new UnsafeCentSum(); return n;
}

export function aggregateGeorgiaReportedIe(input: {
  rows: readonly GeorgiaIndependentExpenditureRow[]; registrationGuid: string; electionYear: number;
}): GeorgiaReportedIeAggregation | Held {
  const guid = input.registrationGuid.trim().toLowerCase();
  if (!guid) return { status: "held", reason: "invalid_candidate_ie_row" };
  const groups = new Map<string, GeorgiaReportedIeGroup>();
  let candidateTargetRowCount = 0, expenditureCount = 0, otherAllocationYearRowCount = 0;
  let multiTargetRowCount = 0, multiTargetAmountCents = 0, supportTotalCents = 0, opposeTotalCents = 0;
  const ids = new Set<number>();
  try {
    for (const row of input.rows) {
      if (!row.candidateMeasures.some(target => target.filerRegistrationGuid?.trim().toLowerCase() === guid)) continue;
      candidateTargetRowCount++;
      if (!Number.isInteger(row.electionYear)) {
        return { status: "held", reason: "invalid_candidate_ie_row" };
      }
      if (row.electionYear !== input.electionYear) { otherAllocationYearRowCount++; continue; }
      if (row.transactionTypeCode?.trim() !== "TIE" || !isGeorgiaRecognizedTransactionStatus("peachfile", row.transactionStatusCode)) {
        return { status: "held", reason: "invalid_candidate_ie_row" };
      }
      const amountCents = exactCents(row.amountApplied);
      if (amountCents === null || amountCents <= 0 || !Number.isSafeInteger(row.transactionId) || row.transactionId <= 0 ||
        ids.has(row.transactionId)) return { status: "held", reason: "invalid_candidate_ie_row" };
      ids.add(row.transactionId);
      if (row.candidateMeasures.length !== 1) {
        multiTargetRowCount++; multiTargetAmountCents = add(multiTargetAmountCents, amountCents); continue;
      }
      const target = row.candidateMeasures[0]!;
      const stance = target.stance?.trim().toUpperCase();
      if (target.reasonTypeCode?.trim() !== "CAN" || (stance !== "SUPPORT" && stance !== "OPPOSE") ||
        !text(row.filerRegistrationGuid) || !text(row.filerName)) return { status: "held", reason: "invalid_candidate_ie_row" };
      const supportOppose = stance === "SUPPORT" ? "support" : "oppose";
      const reportedSpenderId = row.filerRegistrationGuid.trim().toLowerCase();
      const reportedSpenderName = clean(row.filerName);
      const key = `${reportedSpenderId}\u0000${supportOppose}`;
      const old = groups.get(key);
      // The native registration identifies this reported spender even when
      // two rows use different name spellings. Pick a stable reported label.
      const label = old && old.reportedSpenderName.localeCompare(reportedSpenderName) < 0
        ? old.reportedSpenderName : reportedSpenderName;
      groups.set(key, { reportedSpenderId, reportedSpenderName: label, supportOppose,
        amountCents: add(old?.amountCents ?? 0, amountCents), expenditureCount: add(old?.expenditureCount ?? 0, 1) });
      expenditureCount = add(expenditureCount, 1);
      if (supportOppose === "support") supportTotalCents = add(supportTotalCents, amountCents);
      else opposeTotalCents = add(opposeTotalCents, amountCents);
    }
    add(supportTotalCents, opposeTotalCents);
  } catch (error) {
    if (error instanceof UnsafeCentSum) return { status: "held", reason: "unsafe_cent_sum" };
    throw error;
  }
  return { status: "qualified", sourceRowCount: input.rows.length, groups: [...groups.values()].sort((a, b) =>
    b.amountCents - a.amountCents || a.reportedSpenderId.localeCompare(b.reportedSpenderId) || a.supportOppose.localeCompare(b.supportOppose)),
  candidateTargetRowCount, expenditureCount, otherAllocationYearRowCount, multiTargetRowCount, multiTargetAmountCents,
  supportTotalCents, opposeTotalCents };
}

export function aggregateGeorgiaReportedCommitteeContributions(input: {
  source: Pick<GeorgiaReportedContributionExport, "rowsByReceivingCommitteeId" | "heldReceivingCommitteeIds">;
  receivingCommitteeId: string;
  electionYear: number;
}): GeorgiaReportedCommitteeAggregation | Held {
  if (input.source.heldReceivingCommitteeIds.has(input.receivingCommitteeId)) return { status: "held", reason: "receiving_export_held" };
  const rows = input.source.rowsByReceivingCommitteeId.get(input.receivingCommitteeId) ?? [];
  const groups = new Map<string, GeorgiaReportedCommitteeGroup>();
  const ids = new Set<string>();
  let contributionCount = 0, totalAmountCents = 0;
  try {
    for (const row of rows) {
      const transactionId = String(row.transactionId);
      if (row.receivingCommitteeId !== input.receivingCommitteeId || row.allocatedElectionYear !== input.electionYear || ids.has(transactionId) ||
        !text(row.contributorName) || !Number.isSafeInteger(row.amountCents) || row.amountCents <= 0 ||
        !["Non-Candidate Committee", "Candidate / Candidate Committee"].includes(row.contributorType)) {
        return { status: "held", reason: "invalid_reported_contribution" };
      }
      ids.add(transactionId);
      const reportedName = clean(row.contributorName), reportedNameKey = reportedName.toUpperCase();
      const key = `${row.contributorType}\u0000${reportedNameKey}`;
      const old = groups.get(key);
      groups.set(key, { reportedName: old?.reportedName ?? reportedName, reportedNameKey, reportedClass: row.contributorType,
        amountCents: add(old?.amountCents ?? 0, row.amountCents), contributionCount: add(old?.contributionCount ?? 0, 1) });
      contributionCount = add(contributionCount, 1); totalAmountCents = add(totalAmountCents, row.amountCents);
    }
  } catch (error) {
    if (error instanceof UnsafeCentSum) return { status: "held", reason: "unsafe_cent_sum" };
    throw error;
  }
  return { status: "qualified", groups: [...groups.values()].sort((a, b) => b.amountCents - a.amountCents ||
    a.reportedClass.localeCompare(b.reportedClass) || a.reportedNameKey.localeCompare(b.reportedNameKey)),
  contributionCount, totalAmountCents };
}
