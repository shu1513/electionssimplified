import { describe, expect, it } from "vitest";
import type { GeorgiaIndependentExpenditureRow } from "../../../src/pipeline/georgiaFinance/georgiaEthicsClient.js";
import type { GeorgiaReportedContributionExport } from "../../../src/pipeline/georgiaFinance/georgiaReportedContributionExport.js";
import {
  aggregateGeorgiaReportedIe,
  aggregateGeorgiaReportedCommitteeContributions,
} from "../../../src/pipeline/georgiaFinance/georgiaReportedFinanceAggregation.js";

function ie(overrides: Partial<GeorgiaIndependentExpenditureRow> = {}): GeorgiaIndependentExpenditureRow {
  return { guid: "transaction", transactionId: 1, amountApplied: 100, filerRegistrationGuid: "spender",
    filerName: "Example Reporting Committee", filerReportGuid: null, timedFiledReportGuid: "timed",
    filerReportVersionId: 1, transactionDate: "2025-01-01", transactionStatusCode: "TPEN",
    transactionTypeCode: "TIE", electionYear: 2026,
    candidateMeasures: [{ candidateMeasureTitle: "Candidate", stance: "Support", reasonTypeCode: "CAN",
      filerRegistrationGuid: "candidate" }], ...overrides };
}
const aggregate = (rows: GeorgiaIndependentExpenditureRow[]) => aggregateGeorgiaReportedIe({ rows,
  registrationGuid: "candidate", electionYear: 2026 });

describe("Georgia independent reported IE controls", () => {
  it("keeps timed-only rows and source-allocated years despite older transaction dates", () => {
    expect(aggregate([ie()])).toMatchObject({ status: "qualified", supportTotalCents: 10000,
      expenditureCount: 1, groups: [{ expenditureCount: 1, amountCents: 10000 }] });
  });
  it("retains all groups before display caps", () => {
    const rows = Array.from({ length: 70 }, (_, i) => ie({ transactionId: i + 1, filerRegistrationGuid: `spender-${i}` }));
    const result = aggregate(rows);
    expect(result).toMatchObject({ status: "qualified", supportTotalCents: 700000, expenditureCount: 70 });
    if (result.status === "qualified") expect(result.groups).toHaveLength(70);
  });
  it("preserves different native-ID occurrences and groups both stances", () => {
    const target = ie().candidateMeasures[0]!;
    expect(aggregate([ie(), ie({ transactionId: 2 }), ie({ transactionId: 3,
      candidateMeasures: [{ ...target, stance: "Oppose" }] })])).toMatchObject({ status: "qualified",
      supportTotalCents: 20000, opposeTotalCents: 10000, expenditureCount: 3 });
  });
  it("excludes multi-target allocation with amount controls", () => {
    expect(aggregate([ie({ candidateMeasures: [...ie().candidateMeasures,
      { ...ie().candidateMeasures[0]!, filerRegistrationGuid: "other" }] })])).toMatchObject({
      status: "qualified", supportTotalCents: 0, expenditureCount: 0, multiTargetRowCount: 1,
      multiTargetAmountCents: 10000, groups: [],
    });
  });
  it("distinguishes a real scoped zero from missing/unknown candidate data", () => {
    expect(aggregate([ie({ candidateMeasures: [] })])).toMatchObject({ status: "qualified", groups: [], supportTotalCents: 0 });
    expect(aggregate([ie({ electionYear: null })])).toMatchObject({ status: "held" });
    expect(aggregate([ie({ electionYear: 2024, transactionStatusCode: "old-unknown" })])).toMatchObject({
      status: "qualified", otherAllocationYearRowCount: 1, supportTotalCents: 0,
    });
  });
  it.each([
    { amountApplied: 1.001 }, { amountApplied: -1 }, { transactionStatusCode: "NEW" },
    { transactionTypeCode: "TCON" }, { filerName: null }, { filerRegistrationGuid: null },
    { candidateMeasures: [{ ...ie().candidateMeasures[0]!, stance: null }] },
  ])("holds the affected candidate for unsupported financial shape %j", change => {
    expect(aggregate([ie(change)])).toMatchObject({ status: "held" });
  });
  it("holds duplicate IDs and uses the native registration for name variants", () => {
    expect(aggregate([ie(), ie()])).toMatchObject({ status: "held" });
    const rows = [ie(), ie({ transactionId: 2, filerName: "Different reported name" })];
    expect(aggregate(rows)).toMatchObject({ status: "qualified", supportTotalCents: 20000,
      groups: [{ reportedSpenderName: "Different reported name", expenditureCount: 2 }] });
    expect(aggregate([...rows].reverse())).toEqual(aggregate(rows));
  });
  it("holds safe-cent sum overflow", () => {
    const amountApplied = 40_000_000_000_000;
    expect(aggregate([ie({ amountApplied }), ie({ transactionId: 2, amountApplied }),
      ie({ transactionId: 3, amountApplied })])).toMatchObject({ status: "held", reason: "unsafe_cent_sum" });
  });
});

type Contribution = GeorgiaReportedContributionExport["rowsByReceivingCommitteeId"] extends ReadonlyMap<string, readonly (infer R)[]> ? R : never;
function contribution(overrides: Partial<Contribution> = {}): Contribution {
  return { transactionId: "1", receivingCommitteeId: "10", contributorType: "Non-Candidate Committee",
    contributorName: "Example Committee", amountCents: 10000, allocatedElectionYear: 2026,
    transactionDate: "01/01/2026", amended: "N", periodicReportName: "Report", periodicReportFiledDate: "01/02/2026",
    timedReportName: null, timedReportFiledDate: null, ...overrides };
}
function committees(rows: Contribution[], held = false) {
  return aggregateGeorgiaReportedCommitteeContributions({ receivingCommitteeId: "10", electionYear: 2026,
    source: { rowsByReceivingCommitteeId: new Map([["10", rows]]), heldReceivingCommitteeIds: new Set(held ? ["10"] : []) } });
}
describe("Georgia native reported committee contribution grouping", () => {
  it("keeps native roles and different-ID equal contributions", () => {
    expect(committees([contribution(), contribution({ transactionId: "2" }), contribution({ transactionId: "3",
      contributorType: "Candidate / Candidate Committee" })])).toMatchObject({ status: "qualified",
      totalAmountCents: 30000, contributionCount: 3, groups: [
        { reportedClass: "Non-Candidate Committee", amountCents: 20000, contributionCount: 2 },
        { reportedClass: "Candidate / Candidate Committee", amountCents: 10000, contributionCount: 1 },
      ] });
  });
  it("checks an affected-owner hold before allowing zero", () => {
    expect(committees([])).toMatchObject({ status: "qualified", totalAmountCents: 0, groups: [] });
    expect(committees([], true)).toMatchObject({ status: "held", reason: "receiving_export_held" });
  });
  it("rejects duplicate, wrong receiver and wrong allocated year rows", () => {
    expect(committees([contribution(), contribution()])).toMatchObject({ status: "held" });
    expect(committees([contribution({ receivingCommitteeId: "11" })])).toMatchObject({ status: "held" });
    expect(committees([contribution({ allocatedElectionYear: 2028 })])).toMatchObject({ status: "held" });
  });
});
