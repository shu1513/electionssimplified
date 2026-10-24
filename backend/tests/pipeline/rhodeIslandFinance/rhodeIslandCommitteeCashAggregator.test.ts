import { describe, expect, it } from "vitest";
import { aggregateRhodeIslandCommitteeCash as aggregate, type RhodeIslandCommitteeCashPeriod } from "../../../src/pipeline/rhodeIslandFinance/rhodeIslandCommitteeCashAggregator.js";
import type { ErtsContributionExportRow } from "../../../src/pipeline/rhodeIslandFinance/rhodeIslandErtsParsers.js";

function receipt(patch: Partial<ErtsContributionExportRow> = {}): ErtsContributionExportRow {
  return { contributionId: "1", contributionType: "PAC", receiptDateIso: "2026-04-01", depositDateIso: null,
    amountCents: 100_000, mpfMatchAmountCents: 0, firstName: "", lastName: "", fullName: "Example PAC",
    employerName: "", incomplete: false, receiptDesc: "Check", transType: "Contribution", ...patch };
}
function input(rows = [receipt()]) {
  const grouped = new Map<string, number>();
  for (const row of rows) grouped.set(row.contributionType, (grouped.get(row.contributionType) ?? 0) + row.amountCents);
  return { electionYear: 2026, observedDay: "2026-10-24", rows, periods: [{
    beginIso: "2025-01-01", endIso: "2026-10-05", groupings: grouped,
    cf2PacCents: (grouped.get("PAC") ?? 0) + (grouped.get("Aggregate - PAC") ?? 0),
    cf2PartyCents: (grouped.get("Party") ?? 0) + (grouped.get("Aggregate - Party") ?? 0),
  }] satisfies RhodeIslandCommitteeCashPeriod[] };
}
describe("Rhode Island gross reported committee cash", () => {
  it("uses only native itemized PAC/Party cash; equal gifts keep distinct native occurrences", () => {
    const result = aggregate(input([
      receipt(), receipt({ contributionId: "2" }),
      receipt({ contributionId: "3", contributionType: "Party", fullName: "Example party" }),
      ...["Individual", "Aggregate - PAC", "Aggregate - Party", "In-Kind - PAC", "Loan Proceeds - PAC", "Matching Public Funds"].map((contributionType, i) =>
        receipt({ contributionId: String(10 + i), contributionType })),
    ]));
    expect(result).toMatchObject({ totalCents: 300_000, selectedOccurrences: 3, receivingRows: 9, coverageThrough: "2026-10-05" });
    expect(result.donors).toEqual([
      expect.objectContaining({ sourceClass: "PAC", amountCents: 200_000, contributionCount: 2 }),
      expect.objectContaining({ sourceClass: "Party", amountCents: 100_000, contributionCount: 1 }),
    ]);
  });
  it("closes a native negative expenditure-side return without netting gross committee receipts", () => {
    const rows = [receipt(), receipt({ contributionId: "2", contributionType: "Refund of Contribution", transType: "Expenditure", amountCents: -10_000 })];
    expect(aggregate(input(rows))).toMatchObject({ totalCents: 100_000, selectedOccurrences: 1, receivingRows: 2 });
  });
  it.each([
    { transType: "Contribution" }, { amountCents: 10_000 }, { amountCents: 0 },
    { mpfMatchAmountCents: 1 }, { contributionType: "Unknown Return" },
  ])("holds an unverified return shape %o", patch => {
    const returned = receipt({ contributionId: "2", contributionType: "Refund of Contribution", transType: "Expenditure", amountCents: -10_000, ...patch });
    expect(() => aggregate(input([receipt(), returned]))).toThrow(/committee cash held/);
  });
  it("combines case/space variants but preserves reported class and punctuation distinctions", () => {
    const result = aggregate(input([receipt(), receipt({ contributionId: "2", fullName: " example  pac " }),
      receipt({ contributionId: "3", fullName: "Example-PAC" }), receipt({ contributionId: "4", contributionType: "Party" })]));
    expect(result.donors).toHaveLength(3);
    expect(result.donors[0]!.contributionCount).toBe(2);
  });
  it.each([
    { contributionId: "" }, { contributionId: "not-an-id" }, { receiptDateIso: "2026-02-30" },
    { receiptDateIso: "2026-10-06" }, { transType: "Return" }, { contributionType: "Unknown Committee" },
    { amountCents: 0 }, { amountCents: -100 }, { amountCents: 0.5 },
    { mpfMatchAmountCents: 100 }, { fullName: " " }, { fullName: "bad\u0000name" },
  ])("holds the entire component on an unqualified receipt", patch => {
    expect(() => aggregate(input([receipt(patch)]))).toThrow(/committee cash held/);
  });
  it("rejects duplicate native IDs even when rows are identical", () => {
    expect(() => aggregate(input([receipt(), receipt()]))).toThrow(/receipt_identity/);
  });
  it("rejects missing itemized rows despite matching total receipts elsewhere", () => {
    const value = input(); value.periods[0]!.groupings.set("PAC", 200_000); value.periods[0]!.cf2PacCents = 200_000;
    expect(() => aggregate(value)).toThrow(/whole_export_summary_mismatch/);
  });
  it("holds unqualified summary-only refunds instead of publishing a partial positive subtotal", () => {
    const value = input(); value.periods[0]!.groupings.set("Refund of Contribution", -10_000);
    expect(() => aggregate(value)).toThrow(/unknown_summary_or_return_type/);
  });
  it("requires the separately reported PAC and Party CF-2 cash lines", () => {
    const value = input(); value.periods[0]!.cf2PacCents++;
    expect(() => aggregate(value)).toThrow(/cf2_committee_cash_mismatch/);
  });
  it.each(["2025-01-02", "2024-12-31"])("requires complete cycle opening coverage", beginIso => {
    const value = input(); value.periods[0]!.beginIso = beginIso;
    expect(() => aggregate(value)).toThrow(/incomplete_period_coverage/);
  });
  it("rejects gaps, overlaps and future certified periods", () => {
    const value = input(); value.periods[0]!.endIso = "2025-12-31";
    value.periods.push({ ...value.periods[0]!, beginIso: "2026-01-02", endIso: "2026-10-05" });
    expect(() => aggregate(value)).toThrow(/incomplete_period_coverage/);
    value.periods[1]!.beginIso = "2025-12-31";
    expect(() => aggregate(value)).toThrow(/incomplete_period_coverage/);
    value.periods[1]!.beginIso = "2026-01-01"; value.periods[1]!.endIso = "2026-10-25";
    expect(() => aggregate(value)).toThrow(/period_scope/);
  });
  it("accepts a genuine complete empty filed scope but refuses missing periods", () => {
    expect(aggregate(input([]))).toMatchObject({ totalCents: 0, selectedOccurrences: 0, donors: [] });
    const value = input([]); value.periods = [];
    expect(() => aggregate(value)).toThrow(/incomplete_period_coverage/);
  });
  it("refuses unsafe cent sums", () => {
    expect(() => aggregate(input([receipt({ amountCents: Number.MAX_SAFE_INTEGER }), receipt({ contributionId: "2" })])))
      .toThrow(/unsafe_cent_sum/);
  });
});
