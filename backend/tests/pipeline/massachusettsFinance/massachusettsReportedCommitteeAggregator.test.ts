import { describe, expect, it } from "vitest";
import {
  aggregateMassachusettsReportedCommittees as aggregate,
  maReportedCents,
  maReportedDay,
  type MassachusettsReportedReceipt,
} from "../../../src/pipeline/massachusettsFinance/massachusettsReportedCommitteeAggregator.js";

const receipt = (patch: Record<string, unknown> = {}): MassachusettsReportedReceipt => ({
  id: "synthetic-receipt-1", reportId: 1, filerCpfId: 12345, contributorCpfId: 99999,
  date: "10/1/2026", amount: "$100.01", recordTypeId: 202, recordTypeDescription: "Committee",
  fullNameReverse: "Example Committee", isTransfer: false, isPreviousYearContribution: false,
  linkedRefundGuid: null, ...patch,
});
const run = (rows: readonly MassachusettsReportedReceipt[]) => aggregate({
  receivingCpfId: "12345", electionYear: 2026, observedDay: "2026-10-19", rows,
});

describe("Massachusetts explicit reported committee contributions", () => {
  it("combines cash and in-kind in exact cents without a display cap", () => {
    const rows = Array.from({ length: 60 }, (_, i) => receipt({ id: String(i + 1), fullNameReverse: `Example ${i}`, contributorCpfId: 0 }));
    rows.push(receipt({ id: "inkind", recordTypeId: 402, fullNameReverse: "Example 0", contributorCpfId: 0 }));
    const a = run(rows);
    expect(a).toMatchObject({ cents: 610061, occurrences: 61 });
    expect(a.groups).toHaveLength(60);
    expect(a.groups[0]).toMatchObject({ name: "Example 0", cents: 20002, occurrences: 2 });
  });
  it("preserves reported labels without requiring a registered donor ID", () => {
    const a = run([receipt({ contributorCpfId: 0, fullNameReverse: "  Example  Party Committee  " })]);
    expect(a.groups[0]).toMatchObject({ name: "Example Party Committee", sourceClass: "Committee" });
    expect(JSON.parse(a.groups[0]!.key)).toEqual(["Committee", "", "EXAMPLE PARTY COMMITTEE"]);
  });
  it("does not merge distinct native contacts or reported aliases", () => {
    expect(run([receipt(), receipt({ id: "2", contributorCpfId: 88888 }), receipt({ id: "3", fullNameReverse: "Example Committee Fund" })]).groups).toHaveLength(3);
  });
  it.each([201, 203, 204, 205, 206, 207, 210, 220, 401, 403, 404, 420])("does not promote type %i by its name", type => {
    expect(run([receipt({ recordTypeId: type, fullNameReverse: "REGISTERED PAC COMMITTEE" })]).cents).toBe(0);
  });
  it.each([299, 999, "202", undefined])("holds unsupported class %s before returning a known subtotal", type => {
    expect(() => run([receipt(), receipt({ id: "2", recordTypeId: type })])).toThrow(/unknown_receipt_type/);
  });
  it("excludes transfers, explicit prior-year contributions and earlier calendar years", () => {
    expect(run([receipt(), receipt({ id: "2", isTransfer: true }), receipt({ id: "3", isPreviousYearContribution: true }), receipt({ id: "4", date: "12/31/2025" })])).toMatchObject({ cents: 10001, occurrences: 1 });
  });
  it.each(["-$1.00", "($1.00)", "$0.00"])("holds a whole receiver for committee donation %s", amount => {
    expect(() => run([receipt(), receipt({ id: "2", amount })])).toThrow(/nonpositive_committee_donation/);
  });
  it.each([
    [{ linkedRefundGuid: "synthetic-refund" }, /refund_link/],
    [{ isTransfer: null }, /accounting_flags/],
    [{ isPreviousYearContribution: undefined }, /accounting_flags/],
    [{ fullNameReverse: " " }, /committee_name/],
    [{ fullNameReverse: "Bad\u0000Name" }, /committee_name/],
    [{ contributorCpfId: "99999" }, /reported_donor_identity/],
    [{ contributorCpfId: undefined }, /reported_donor_identity/],
    [{ filerCpfId: 54321 }, /receiving_identity/],
    [{ reportId: 0 }, /receiving_identity/],
    [{ date: "10/20/2026" }, /future_receipt/],
  ] as const)("rejects unresolved row evidence %#", (patch, code) => {
    expect(() => run([receipt(patch)])).toThrow(code);
  });
  it("requires receiving ledger identity and preserves legitimate separate occurrences", () => {
    expect(() => run([])).toThrow(/ledger_missing/);
    expect(() => run([receipt(), receipt()])).toThrow(/receipt_identity/);
    expect(run([receipt(), receipt({ id: "2" })])).toMatchObject({ cents: 20002, occurrences: 2 });
  });
  it.each([["$1,234.56", 123456], ["0.01", 1], ["($10.01)", -1001], ["-$10.01", -1001], ["$1.2", 120]] as const)("parses native money %s", (text, cents) => {
    expect(maReportedCents(text)).toBe(cents);
  });
  it.each(["1,23.45", "1.005", "NaN", "1e3", "$", "90071992547409.92", 100.01])("rejects malformed or unsafe money %s", value => {
    expect(() => maReportedCents(value)).toThrow();
  });
  it("retains the source calendar date instead of converting through UTC", () => {
    expect(maReportedDay("2025-12-31T23:30:00-05:00")).toBe("2025-12-31");
    expect(maReportedDay("10/1/2026")).toBe("2026-10-01");
  });
  it.each(["2/29/2026", "13/1/2026", "2026-02-30", "2026-01-01T24:00:00Z", "2026-01-01T12:60:00Z"])("holds invalid native date %s", value => {
    expect(() => maReportedDay(value)).toThrow(/date_format/);
  });
});
