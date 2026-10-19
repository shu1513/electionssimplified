import { describe, expect, it } from "vitest";
import { maReceiptSweep, maSameReceiptSweeps, maSameHeader, maCurrentReport, maReportItems } from "../../../src/pipeline/massachusettsFinance/massachusettsReportedNative.js";
import { aggregateMassachusettsNativeIe, validateMassachusettsReportedClosure } from "../../../src/pipeline/massachusettsFinance/massachusettsReportedAggregation.js";
import type { MassachusettsReportedReceiver } from "../../../src/pipeline/massachusettsFinance/massachusettsReportedReceiver.js";
const receiver = { entityId: "1001", candidateName: "Ada Smith", fullName: "Ada Smith" } as MassachusettsReportedReceiver;
const expense = (patch = {}) => ({ id: 1, reportId: 11, amount: "$123.45", date: "10/10/2026", relatedCpfId: 1001,
  affectedCandidateName: "Smith, Ada", isSupported: true, recordTypeDescription: "Independent Expenditure", ...patch });
const parent = (patch = {}) => ({ reportId: 11, cpfId: 2001, committeeName: "Example PAC", expenditureTotal: "$123.45",
  expenditureItemizedTotal: "$123.45", expenditureUnitemizedTotal: "$0.00", expenditures: [expense()], ...patch });
const aggregate = (v: any) => aggregateMassachusettsNativeIe(receiver, [{ iepac: true, value: v }], "2026-10-19");
describe("Massachusetts native currentness and full ledger controls", () => {
  const page = (items: any[], count = items.length, total = count) => ({ items, summary: { count, total } });
  const row = (id: number) => ({ id: String(id), amount: "$1.00" });
  it("closes one-based row-offset pages, including an incomplete last page", () => {
    expect(maReceiptSweep([page(Array.from({ length: 500 }, (_, i) => row(i)), 501), page([row(500)], 501)])).toHaveLength(501);
  });
  it("retains native numeric item IDs without treating them as duplicates", () => {
    const a = [{ id: 1, amount: "$1.00" }, { id: 2, amount: "$1.00" }];
    expect(maReceiptSweep([page(a)])).toEqual(a);
    expect(() => maSameReceiptSweeps(a,[...a].reverse())).not.toThrow();
    expect(() => maReceiptSweep([page([a[0],{...a[0],id:"1"}])])).toThrow();
  });
  it.each([
    ["duplicate overlapping pages", () => [page(Array.from({ length: 500 }, (_, i) => row(i)), 501), page([row(0)], 501)]],
    ["missing final page", () => [page(Array.from({ length: 500 }, (_, i) => row(i)), 501)]],
    ["changing count", () => [page(Array.from({ length: 500 }, (_, i) => row(i)), 501), page([row(500)], 1)]],
    ["money not count", () => [page([row(1)], 1, 2)]],
    ["empty unbound ledger", () => [page([], 0, 0)]],
    ["missing item amount", () => [page([{ id: "x" }])]],
  ] as const)("holds %s", (_, make) => expect(() => maReceiptSweep(make())).toThrow());
  it("compares all fields in both full sweeps before selection", () => {
    const a = [row(1), row(2)];
    expect(() => maSameReceiptSweeps(a, [...a].reverse())).not.toThrow();
    expect(() => maSameReceiptSweeps(a, [row(1), { ...row(2), amount: "$2.00" }])).toThrow();
  });
  it("rejects capped and duplicate report membership", () => {
    expect(() => maReportItems({ items: [{ reportId: 1 }, { reportId: 1 }], summary: { count: 2 } })).toThrow();
    expect(() => maReportItems({ items: [{ reportId: 1 }], summary: { count: 2 } })).toThrow();
  });
  it("requires explicit native currentness, not highest ID or filing date", () => {
    expect(() => maCurrentReport({ reportId: 11, reportYear: 2026, isIePacReport: true, isDraft: false, isAmended: true }, true, 2026)).toThrow();
    expect(() => maCurrentReport({ reportId: 11, reportType: "IE", reportStatus: "A", amendedByReportId: 12 }, false, 2026)).toThrow();
    expect(() => maCurrentReport({ reportId: 11, reportType: "IE", reportStatus: "C", amendedByReportId: 0 }, false, 2026)).not.toThrow();
  });
  it("missing header values cannot authorize a cached financial body", () => {
    expect(maSameHeader({ reportId: 1 }, { reportId: 1 }, true)).toBe(false);
  });
});
describe("Massachusetts native IE allocations", () => {
  it("allocates exact cents by native receiving CPF and stance", () => {
    const a = aggregate(parent()); expect(a.supportCents).toBe(12345); expect(a.includedRows).toBe(1);
    expect(() => validateMassachusettsReportedClosure(a, "ie")).not.toThrow();
  });
  it("ordinary contacts are reported payers, not registered CPF identities", () => {
    const a = aggregateMassachusettsNativeIe(receiver, [{ iepac: false, value: { reportId: 11, cpfId: 9999,
      filingEntityFull: "Example organization", expenditureTotal: "$123.45", expenditures: [{ id: 1, reportId: 11,
        amount: "$123.45", date: "10/10/2026", relatedCandidateCpfId: 1001, relatedCandidateName: "Ada Smith", expenditurePosition: "Opposed" }] } }], "2026-10-19");
    expect(a.opposeCents).toBe(12345); expect(JSON.parse(a.groups[0]!.key)[1]).toBe("");
  });
  it.each([
    ["unreconciled parent", () => parent({ expenditureTotal: "$999.00" })],
    ["missing preliminary amount", () => parent({ expenditures: [expense({ amount: null })] })],
    ["zero preliminary amount", () => parent({ expenditureTotal: "$0.00", expenditureItemizedTotal: "$0.00", expenditures: [expense({ amount: "$0.00" })] })],
    ["unitemized allocation", () => parent({ expenditureUnitemizedTotal: "$1.00" })],
    ["missing stance", () => parent({ expenditures: [expense({ isSupported: null })] })],
    ["missing native target", () => parent({ expenditures: [expense({ relatedCpfId: null })] })],
    ["contradictory target", () => parent({ expenditures: [expense({ relatedCpfId: 1002 })] })],
    ["joint target", () => parent({ expenditures: [expense({ affectedCandidateName: "Ada Smith and Alex Doe" })] })],
    ["contradictory printed person", () => parent({ expenditures: [expense({ affectedCandidateName: "Alex Doe" })] })],
    ["future payment", () => parent({ expenditures: [expense({ date: "10/20/2026" })] })],
    ["duplicate expense", () => parent({ expenditures: [expense(), expense()], expenditureTotal: "$246.90", expenditureItemizedTotal: "$246.90" })],
    ["non-IE type", () => parent({ expenditures: [expense({ recordTypeDescription: "Electioneering" })] })],
  ] as const)("holds receiver for %s", (_, make) => expect(() => aggregate(make())).toThrow());
  it("vetoes printed targets that contradict the full name, not only the display name", () => {
    const run = (r: Partial<MassachusettsReportedReceiver>, printed: string) =>
      aggregateMassachusettsNativeIe({ ...receiver, ...r } as MassachusettsReportedReceiver, [{ iepac: true, value: parent({ expenditures: [expense({ affectedCandidateName: printed })] }) }], "2026-10-19");
    expect(() => run({ fullName: "Ada A Smith" }, "Ada B Smith")).toThrow();
    expect(() => run({ fullName: "Ada Smith Jr" }, "Smith, Ada Sr")).toThrow();
    expect(() => run({ candidateName: "Ada A Smith", fullName: "Ada Smith" }, "Smith, Ada B")).toThrow();
    expect(run({ fullName: "Ada A Smith" }, "Smith, Ada Andrea").supportCents).toBe(12345);
    expect(run({ candidateName: "Addie Smith", fullName: "Ada Smith" }, "Smith, Ada").supportCents).toBe(12345);
  });
  it("does not hold an unrelated named receiver for another bad parent", () => {
    expect(aggregate(parent({ expenditureTotal: "$999", expenditures: [expense({ relatedCpfId: 1002, affectedCandidateName: "Alex Doe" })] })).totalCents).toBe(0);
  });
  it("retains late-filed calendar payments after year end", () => {
    expect(aggregateMassachusettsNativeIe(receiver, [{ iepac: true, value: parent() }], "2027-01-23").supportCents).toBe(12345);
  });
  it("validates the full collection beyond display caps", () => {
    const a = aggregate(parent());
    expect(() => validateMassachusettsReportedClosure({ ...a, groups: [...a.groups, ...a.groups] }, "ie")).toThrow();
    expect(() => validateMassachusettsReportedClosure({ ...a, totalCents: 1 }, "ie")).toThrow();
  });
});
