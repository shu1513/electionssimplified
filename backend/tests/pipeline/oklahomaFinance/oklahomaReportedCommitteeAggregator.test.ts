import { describe, expect, it } from "vitest";
import { aggregateOklahomaReportedCommittees as aggregate, OKLAHOMA_REPORTED_COMMITTEE_CLASSES } from "../../../src/pipeline/oklahomaFinance/oklahomaReportedCommitteeAggregator.js";
import { OKLAHOMA_GUARDIAN_CONTRIBUTION_COLUMNS, type OklahomaGuardianContributionRow } from "../../../src/pipeline/oklahomaFinance/oklahomaGuardianContributionReader.js";
const row = (values: Partial<OklahomaGuardianContributionRow> = {}): OklahomaGuardianContributionRow => ({
  ...Object.fromEntries(OKLAHOMA_GUARDIAN_CONTRIBUTION_COLUMNS.map(k => [k, ""])),
  "Receipt ID": "1", "Org ID": "100", "Committee Type": "Candidate Committee", "Receipt Source Type": "Political Action Committee (Registered)",
  "Receipt Type": "Monetary", "Receipt Date": "10/1/2026 12:00:00 AM", "Receipt Amount": "1,250.01", "Last Name": "Example PAC", Amended: "N", ...values,
} as OklahomaGuardianContributionRow);
const run = (rows: OklahomaGuardianContributionRow[]) => aggregate({ organizationId: "100", electionYear: 2026, rows });
describe("Oklahoma reported committee receipt foundation", () => {
  it("retains every literal reported committee class before any display cap", () => {
    const result = run(OKLAHOMA_REPORTED_COMMITTEE_CLASSES.map((source, i) => row({ "Receipt ID": String(i + 1), "Receipt Source Type": source })));
    expect(result.cents).toBe(1_000_008); expect(result.occurrences).toBe(8); expect(result.groups).toHaveLength(8);
    expect(result.groups.map(g => g.sourceClass).sort()).toEqual([...OKLAHOMA_REPORTED_COMMITTEE_CLASSES].sort());
  });
  it("counts equal legitimate occurrences separately and preserves exact cents", () => {
    const result = run([row(), row({ "Receipt ID": "2", "Receipt Type": "In-Kind" })]);
    expect(result.cents).toBe(250_002); expect(result.groups[0]?.occurrences).toBe(2); expect(result.groups).toHaveLength(1);
  });
  it("uses donor class independently of the candidate receiver's class", () => {
    expect(run([row({ "Receipt Source Type": "Business", "Last Name": "Example Association" }), row({ "Receipt ID": "2", "Receipt Source Type": "Individual" })]).cents).toBe(0);
  });
  it("groups reported name tuples without fabricating legal donor IDs", () => {
    const result = run([row(), row({ "Receipt ID": "2", "Last Name": " example   pac " }), row({ "Receipt ID": "3", "First Name": "Chapter" })]);
    expect(result.groups).toHaveLength(2); expect(result.groups[0]?.cents).toBe(250_002); expect(result.groups[1]?.name).toBe("Example PAC, Chapter");
  });
  it("limits donations to the reported two-calendar-year cycle", () => {
    expect(run([row({ "Receipt Date": "12/31/2024" }), row({ "Receipt ID": "2", "Receipt Date": "1/1/2025" }), row({ "Receipt ID": "3", "Receipt Date": "1/1/2027" })]).cents).toBe(125_001);
  });
  it("excludes explicit loans, transfers and separately reported refunds", () => {
    expect(run(["Loan", "Transfer In", "Transfer-In", "Refund"].map((type, i) => row({ "Receipt ID": String(i), "Receipt Type": type }))).cents).toBe(0);
  });
  it.each([
    [{ Amended: "Y" }, "committee_correction"], [{ "Receipt Amount": "-10" }, "nonpositive_committee_donation"],
    [{ "Receipt Amount": "0" }, "nonpositive_committee_donation"], [{ "Receipt Amount": "1.001" }, "invalid_money"],
    [{ "Receipt Amount": "1$00" }, "invalid_money"], [{ "Receipt Amount": "1,2" }, "invalid_money"],
    [{ "Receipt Amount": "999999999999999" }, "unsafe_money"], [{ "Receipt Date": "2/30/2026" }, "invalid_date"],
    [{ "Receipt Type": "Other" }, "unsupported_committee_receipt_type"], [{ "Last Name": "" }, "missing_committee_name"],
    [{ "Receipt Source Type": "", "Last Name": "Unresolved PAC" }, "unresolved_committee_class"],
    [{ "Receipt Source Type": "Future Committee Class" }, "unresolved_committee_class"],
    [{ "Committee Type": "Political Action Committee" }, "receiving_class"], [{ "Receipt ID": "" }, "receipt_identity"],
  ] as const)("holds the entire receiver on unsupported evidence %j", (bad, code) => {
    expect(() => run([row(), row({ "Receipt ID": "2", ...bad })])).toThrow(code);
  });
  it("rejects repeated native receipt identities instead of deduplicating money", () => { expect(() => run([row(), row()])).toThrow("receipt_identity"); });
  it("rejects a sum beyond safe integer cents even when each donation fits", () => {
    expect(() => run([row({ "Receipt Amount": "45035996273704.96" }), row({ "Receipt ID": "2", "Receipt Amount": "45035996273704.96" })])).toThrow("unsafe_money");
  });
  it("ignores other receivers without importing their errors or money", () => {
    expect(run([row(), row({ "Org ID": "200", Amended: "Y", "Receipt Amount": "999999999" })]).cents).toBe(125_001);
  });
});
