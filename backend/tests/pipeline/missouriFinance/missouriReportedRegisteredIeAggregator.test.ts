import { describe, expect, it } from "vitest";
import { aggregateMissouriReportedRegisteredIe as aggregate } from "../../../src/pipeline/missouriFinance/missouriReportedRegisteredIeAggregator.js";
import type { MissouriMecOutsideSpendingRow } from "../../../src/pipeline/missouriFinance/missouriMecParsers.js";
const context = { candidateName: "Jane Doe", officeName: "State Lower Chamber Legislator", district: "1", cycleStart: "2026-08-05", cycleEnd: "2026-11-03" };
function row(extra: Partial<MissouriMecOutsideSpendingRow> = {}): MissouriMecOutsideSpendingRow {
  return { candidateNameAndAddress: "Jane A Doe 10 Private St", officeSought: "District 1 Missouri House of Representatives",
    supportOppose: "Support", expenditureDate: "2026-10-20", amountCents: 10000, reportingCommittee: "Example committee",
    report: "8 Day Before General Election-11/3/2026", ...extra };
}
const run = (rows: MissouriMecOutsideSpendingRow[]) => aggregate({ ...context, rows });
describe("reported registered IE aggregation", () => {
  it("includes native reported committees without any identity lookup and separates stances", () => {
    const result = run([row(), row({ supportOppose: "Oppose", amountCents: 2500 })]);
    expect(result).toMatchObject({ status: "qualified", supportAmountCents: 10000, opposeAmountCents: 2500,
      sourceRowCount: 2, matchedRowCount: 2, includedExpenditureRowCount: 2 });
    if (result.status !== "qualified") throw new Error("Expected qualified fixture");
    expect(result.groups.map(g => [g.reportedNameKey, g.supportOppose, g.amountCents, g.expenditureCount])).toEqual([
      ["EXAMPLE COMMITTEE", "support", 10000, 1], ["EXAMPLE COMMITTEE", "oppose", 2500, 1] ]);
    expect(result.groups.every(g => g.reportedCommitteeId === undefined)).toBe(true);
  });
  it("preserves equal occurrences within one native version and never caps storage groups", () => {
    const result = run([row(), row(), ...Array.from({ length: 55 }, (_, i) => row({ reportingCommittee: `Other committee ${i}`, amountCents: 100 }))]);
    expect(result).toMatchObject({ status: "qualified", supportAmountCents: 25500, includedExpenditureRowCount: 57 });
    if (result.status !== "qualified") throw new Error("Expected qualified fixture");
    expect(result.groups).toHaveLength(56);
    expect(result.groups.find(g => g.reportedNameKey === "EXAMPLE COMMITTEE")).toMatchObject({ amountCents: 20000, expenditureCount: 2 });
  });
  it("keeps repeated occurrences in a sole visible amended version", () => {
    const result = run([row({ report: "AMENDED October Quarterly Report" }), row({ report: "AMENDED October Quarterly Report" })]);
    expect(result).toMatchObject({ status: "qualified", supportAmountCents: 20000, includedExpenditureRowCount: 2 });
  });
  it.each(["amount", "stance", "date_outside"] as const)("holds base/amended coexistence despite changed %s", mode => {
    const amended = row({ report: "AMENDED 8 Day Before General Election-11/3/2026" });
    if (mode === "amount") amended.amountCents = 12500;
    if (mode === "stance") amended.supportOppose = "Oppose";
    if (mode === "date_outside") amended.expenditureDate = "2026-07-01";
    const result = run([row(), amended]);
    expect(result).toMatchObject({ status: "held", reason: "unresolved_report_lineage" });
    expect(result).not.toHaveProperty("groups"); expect(result).not.toHaveProperty("supportAmountCents");
  });
  it.each(["AMENDED AMENDED October Quarterly Report", "October Quarterly Report (AMENDED)", "CORRECTED October Quarterly Report"])(
    "holds ambiguous native version marker %s", report => {
      expect(run([row({ report })])).toMatchObject({ status: "held", reason: "unresolved_report_lineage" });
    });
  it("holds unknown timely/periodic overlap for the affected native spender", () => {
    expect(run([row({ report: "24 Hour Expenditure Report-11/3/2026" }), row({ report: "October Quarterly Report", amountCents: 12500 })]))
      .toMatchObject({ status: "held", reason: "timely_overlap_unresolved", timelyOverlapRowCount: 2 });
    expect(run([row({ report: "24 Hour Expenditure Report-11/3/2026" }), row({ report: "October Quarterly Report", reportingCommittee: "Another committee" })]))
      .toMatchObject({ status: "qualified", supportAmountCents: 20000 });
  });
  it("holds same-date cross-report periodic uncertainty without an amount or stance loophole", () => {
    expect(run([row({ report: "October Quarterly Report" }), row({ report: "8 Day Before General Election", amountCents: 12500, supportOppose: "Oppose" })]))
      .toMatchObject({ status: "held", reason: "unresolved_report_lineage" });
    expect(run([row({ report: "October Quarterly Report", expenditureDate: "2026-09-01" }), row({ report: "8 Day Before General Election", expenditureDate: "2026-10-20" })]))
      .toMatchObject({ status: "qualified", includedExpenditureRowCount: 2 });
  });
  it("recognizes a spaced timely caption before permitting periodic overlap", () => {
    expect(run([row({ report: "24 - Hour Expenditure Report" }), row({ report: "October Quarterly Report" })]))
      .toMatchObject({ status: "held", reason: "timely_overlap_unresolved" });
  });
  it("limits lineage holds to the candidate/office/window affected", () => {
    expect(run([row(), row({ reportingCommittee: "Other", expenditureDate: "2026-07-01", report: "October Quarterly Report" }),
      row({ reportingCommittee: "Other", expenditureDate: "2026-07-02", report: "AMENDED October Quarterly Report" }),
      row({ candidateNameAndAddress: "Other Person 20 Private St", report: "AMENDED 8 Day Before General Election-11/3/2026" })]))
      .toMatchObject({ status: "qualified", candidateNameRowCount: 3, outsideCycleRowCount: 2, matchedRowCount: 1, supportAmountCents: 10000 });
  });
  it("keeps exact primary/general boundaries and explicit zero rows", () => {
    expect(run([row({ expenditureDate: "2026-08-04" }), row({ expenditureDate: "2026-08-05", amountCents: 0 }),
      row({ expenditureDate: "2026-11-03", amountCents: 1 }), row({ expenditureDate: "2026-11-04" })]))
      .toMatchObject({ status: "qualified", sourceRowCount: 4, candidateNameRowCount: 4, outsideCycleRowCount: 2,
        matchedRowCount: 2, zeroAmountRowCount: 1, includedExpenditureRowCount: 1, supportAmountCents: 1 });
  });
  it("distinguishes qualified empty from a held adjustment", () => {
    expect(run([])).toMatchObject({ status: "qualified", groups: [], supportAmountCents: 0, opposeAmountCents: 0 });
    expect(run([row({ amountCents: 0 })])).toMatchObject({ status: "qualified", groups: [], zeroAmountRowCount: 1 });
    expect(run([row({ amountCents: -1 })])).toMatchObject({ status: "held", reason: "negative_eligible_adjustment" });
  });
  it.each(["nan", "unsafe", "stance", "date", "empty_report"] as const)("validates the complete source before filtering %s", mode => {
    const unrelated = row({ candidateNameAndAddress: "Other Person 20 Private St" });
    if (mode === "nan") unrelated.amountCents = NaN;
    if (mode === "unsafe") unrelated.amountCents = Number.MAX_SAFE_INTEGER + 1;
    if (mode === "stance") unrelated.supportOppose = "Unknown" as never;
    if (mode === "date") unrelated.expenditureDate = "2026-02-30";
    if (mode === "empty_report") unrelated.report = "";
    expect(run([row(), unrelated])).toMatchObject({ status: "held", reason: "invalid_source_row" });
  });
  it("holds unsafe same-stance and cross-stance cent totals", () => {
    expect(run([row({ amountCents: Number.MAX_SAFE_INTEGER }), row({ amountCents: 1 })]))
      .toMatchObject({ status: "held", reason: "unsafe_cent_total" });
    expect(run([row({ amountCents: Number.MAX_SAFE_INTEGER }), row({ supportOppose: "Oppose", amountCents: 1 })]))
      .toMatchObject({ status: "held", reason: "unsafe_cent_total" });
  });
  it("holds an unsupported target rather than inventing zero from a matcher with no office rule", () => {
    expect(aggregate({ ...context, officeName: "Unsupported office", rows: [] })).toMatchObject({ status: "held", reason: "invalid_target" });
    expect(aggregate({ ...context, officeName: " State Lower Chamber Legislator ", rows: [row()] })).toMatchObject({ status: "qualified", supportAmountCents: 10000 });
  });
  it("retains bounded middle-name and explicit conflicting district rejection", () => {
    expect(aggregate({ ...context, candidateName: "Jane B Doe", rows: [row()] })).toMatchObject({ status: "qualified", matchedRowCount: 0 });
    expect(run([row({ officeSought: "State Representative District 2" }), row({ officeSought: "U.S. Representative District 1" })]))
      .toMatchObject({ status: "qualified", candidateOfficeMismatchRowCount: 2, matchedRowCount: 0 });
  });
});
