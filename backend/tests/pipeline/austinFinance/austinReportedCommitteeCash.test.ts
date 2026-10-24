import { describe, expect, it } from "vitest";
import { aggregateAustinReportedCommitteeCash } from "../../../src/pipeline/austinFinance/austinReportedCommitteeCash.js";
import type { AustinContributionRow, AustinPeriodReportDetailRow } from "../../../src/pipeline/austinFinance/austinSocrataClient.js";
const report = { reportId: "R1", periodFrom: "2026-01-01", periodTo: "2026-06-30" } as AustinPeriodReportDetailRow;
const receipt = (id: string, overrides: Partial<AustinContributionRow> = {}): AustinContributionRow => ({
  transactionId: id, reportId: "R1", recipient: "Example, Alex", donor: "Example Workers PAC", donorType: "ENTITY",
  contributionType: "Monetary Political Contribution", amountCents: 50_000, contributionDate: "2026-03-01",
  occupation: null, employer: null, reportFiled: null, correction: false, reportUrl: null, ...overrides,
});
const aggregate = (contributions: AustinContributionRow[]) => aggregateAustinReportedCommitteeCash({ contributions, reports: [report], filerName: "Example, Alex" });
describe("Austin reported committee cash", () => {
  it("keeps equal same-day native gifts and groups normalized reported names", () => {
    const result = aggregate([receipt("a"), receipt("b", { donor: "EXAMPLE WORKERS PAC" })]);
    expect(result.amountCents).toBe(100_000);
    expect(result.contributionCount).toBe(2);
    expect(result.donors).toEqual([{ committeeKey: "EXAMPLE WORKERS PAC", committeeName: "Example Workers PAC", amountCents: 100_000, contributionCount: 2 }]);
    expect(result.reportedThrough).toBe("2026-06-30");
  });
  it("requires both ENTITY typing and Pennsylvania's blank-occupation name evidence", () => {
    expect(aggregate([receipt("a", { donorType: "INDIVIDUAL" }), receipt("b", { occupation: "Attorney" }),
      receipt("c", { donor: "Example Company" }), receipt("d", { donorType: null })]).donors).toEqual([]);
    expect(aggregate([receipt("e", { donor: "Example Union" })]).contributionCount).toBe(1);
  });
  it("excludes in-kind, pledges, loans and self receipts", () => {
    expect(aggregate([receipt("a", { contributionType: "Non-Monetary (In-Kind) Political Contribution" }),
      receipt("b", { contributionType: "Pledged Contribution" }), receipt("c", { contributionType: "Loan" }),
      receipt("d", { donor: "Example, Alex" })]).amountCents).toBe(0);
  });
  it("rejects duplicate native IDs instead of silently merging occurrences", () => {
    expect(() => aggregate([receipt("a"), receipt("a")])).toThrow("native receipt identity");
  });
  it("holds signed cash and out-of-period or unselected receipts", () => {
    expect(() => aggregate([receipt("a", { amountCents: -1 })])).toThrow("source review");
    expect(() => aggregate([receipt("a", { contributionDate: "2025-12-31" })])).toThrow("period");
    expect(() => aggregate([receipt("a", { reportId: "R2" })])).toThrow("unselected report");
  });
  it("rejects unsafe arithmetic rather than rounding", () => {
    expect(() => aggregate([receipt("a", { amountCents: Number.MAX_SAFE_INTEGER }), receipt("b")])).toThrow("precision");
  });
});
