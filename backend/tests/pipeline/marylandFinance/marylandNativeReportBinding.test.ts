import { describe, expect, it } from "vitest";
import { bindMarylandNativeReportOccurrences } from "../../../src/pipeline/marylandFinance/marylandNativeReportBinding.js";
import { buildMarylandPublicReportInventoryRequest, decodeMarylandPublicReportInventory } from "../../../src/pipeline/marylandFinance/marylandPublicReportClient.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const REPORT = "22222222-2222-4222-8222-222222222222";
const id = (n: number) => `${String(n).padStart(8, "0")}-3333-4333-8333-333333333333`;
const request = buildMarylandPublicReportInventoryRequest({ filerRegistrationGuid: OWNER, electionCycleId: "12023", pageNumber: 1 });
function report(overrides: Record<string, unknown> = {}) {
  const p = { reportGuid: REPORT, reportVersionId: 2, reportName: "Published report", reportVersion: "Amended", reportVersionCode: "RPTAMD",
    reportType: "Campaign Finance Report", reportTypeCode: "FPCFR", filingEntityId: 1, filerRegistrationGuid: OWNER,
    committeeType: "Candidate Committee", committeeTypeCode: "CC", officeSought: "Governor", officeSoughtId: 40,
    jurisdiction: "State", jurisdictionId: 1, reportingCycle: "2023-2026", reportingCycleId: 12023, reportingYear: 2026,
    startDate: "2025-01-09T00:00:00", endDate: "2026-01-14T00:00:00", dueDate: "2026-01-28T00:00:00",
    filedDate: "2026-01-26T12:00:00", zeroActivity: false, hasChild: true };
  const children = [1, 2].map(v => ({ filerReportGuid: REPORT, filerReportVersionID: v, totalRows: 2,
    reportName: p.reportName, reportType: "Disclosure Report", startDate: p.startDate, endDate: p.endDate, dueDate: p.dueDate,
    filedDate: v === 2 ? p.filedDate : "2026-01-25T12:00:00", isCompleted: true, isPaperFile: false,
    generateStatus: "Completed", generateStatusCode: "GRCOMP", reportStatus: `Version ${v}` }));
  return decodeMarylandPublicReportInventory({ succeeded: true, error: null,
    data: { items: [{ ...p, childResults: children, ...overrides }], totalItems: 1 } }, request).reports[0]!;
}
function row(n = 1, overrides: Record<string, unknown> = {}) {
  return { filerRegistrationGuid: OWNER, electionCycleId: 12023, reportGuid: REPORT, reportVersionId: 1,
    transactionGuid: id(n), transactionVersionID: 1, transactionDate: "2025-06-01T00:00:00",
    transactionTypeCode: "TCON", isReturn: false, transactionAmount: 25, ...overrides };
}
const bind = (rows = [row()], reports = [report()]) => bindMarylandNativeReportOccurrences({ request, reports, nativeRows: rows });

describe("Maryland native report occurrence binding", () => {
  it("keeps historical pointers and equal distinct gifts, including refunds by their return date", () => {
    const rows = [row(), row(2), row(3, { reportVersionId: 2 }),
      row(4, { isReturn: true, transactionTypeCode: "TRCON", transactionDate: "2026-01-14T00:00:00", parentTransactionDate: "2024-01-01T00:00:00" })];
    const result = bind(rows);
    expect(result).toMatchObject({ physicalCount: 4, historicalRowCount: 3 });
    expect(result.reports[0]!.rows).toEqual(rows);
    expect(Object.isFrozen(result.reports[0]!.rows)).toBe(true);
    expect(result).not.toHaveProperty("qualified");
  });
  it.each([
    { filerRegistrationGuid: REPORT }, { electionCycleId: 12019 }, { transactionDate: "2025-02-30T00:00:00" },
    { transactionTypeCode: "TRCON" }, { transactionGuid: "" },
  ])("holds malformed occurrence scope/identity/date: %j", override => {
    expect(() => bind([row(1, override)])).toThrow("invalid_occurrence");
  });
  it("holds missing lineage and repeated occurrences rather than selecting the max version or deduplicating", () => {
    expect(() => bind([row(1, { reportVersionId: 3 })])).toThrow("unresolved_report");
    expect(() => bind([row(), row()])).toThrow("duplicate_occurrence");
    expect(() => bind([row()], [report(), report()])).toThrow("duplicate_report");
  });
  it("requires dates inside both the historical edition and its paired current report", () => {
    expect(() => bind([row(1, { transactionDate: "2025-01-08T00:00:00" })])).toThrow("period");
    expect(() => bind([row(1, { transactionDate: "2026-01-15T00:00:00" })])).toThrow("period");
    const p = report(), historical = { ...p.childResults![0]!, startDate: "2025-07-01T00:00:00" };
    expect(() => bind([row()], [{ ...p, childResults: [historical, p.childResults![1]!] }])).toThrow("period");
    const earlier = { ...p.childResults![0]!, startDate: "2024-01-01T00:00:00" };
    expect(() => bind([row(1, { transactionDate: "2024-06-01T00:00:00" })], [{ ...p, childResults: [earlier, p.childResults![1]!] }])).toThrow("period");
  });
  it("holds an edition claimed by two distinct parents", () => {
    const p = report(), second = { ...p, reportGuid: id(9), childResults: [p.childResults![0]!,
      { ...p.childResults![1]!, filerReportGuid: id(9) }] };
    expect(() => bind([row()], [p, second])).toThrow("ambiguous_lineage");
  });
  it("retains empty report buckets and inactive rows as facts without claiming absence or accepting money", () => {
    expect(bind([]).reports[0]!.rows).toEqual([]);
    expect(bind([row(1, { isActive: false })]).reports[0]!.rows[0]).toMatchObject({ isActive: false });
  });
});
