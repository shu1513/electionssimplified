import { describe, expect, it } from "vitest";
import { aggregateMissouriCommitteeMonetaryReceipts } from "../../../src/pipeline/missouriFinance/missouriCommitteeMonetaryReceiptAggregator.js";
import type { MissouriMecContributionRow, MissouriMecReportInventoryRow } from "../../../src/pipeline/missouriFinance/missouriMecParsers.js";

const window = { cycleStart: "2026-08-05", cycleEnd: "2026-11-03" };
function report(overrides: Partial<MissouriMecReportInventoryRow> = {}): MissouriMecReportInventoryRow {
  return { reportId: "1", report: "October Quarterly Report", dateFiled: "2026-10-15", isAmended: false,
    lineageKey: "OCTOBER QUARTERLY REPORT", ...overrides };
}
function receipt(overrides: Partial<MissouriMecContributionRow> = {}): MissouriMecContributionRow {
  return { mecid: "C123456", committeeName: "Example recipient", report: "October Quarterly Report",
    contributorCommittee: "Example Committee", contributorCompany: null, contributorLastName: null,
    contributorFirstName: null, employer: null, occupation: null, contributionDate: "2026-09-01",
    amountCents: 10000, contributionKind: "Monetary", ...overrides };
}
const amended = () => report({ reportId: "2", report: "AMENDED October Quarterly Report", isAmended: true,
  dateFiled: "2026-10-16" });
function aggregate(rows: MissouriMecContributionRow[], inventory = [report()]) {
  return aggregateMissouriCommitteeMonetaryReceipts({ ...window, contributionRows: rows, inventory });
}

describe("Missouri reported committee monetary receipts", () => {
  it("uses the explicit committee payer field, never company names or individuals", () => {
    const result = aggregate([
      receipt(),
      receipt({ contributorCommittee: null, contributorCompany: "Example PAC", amountCents: 90000 }),
      receipt({ contributorCommittee: null, contributorLastName: "Example", contributorFirstName: "Person", contributionKind: "Unrecognized" }),
      receipt({ contributorCommittee: "Other Committee", contributorCompany: "Different company", amountCents: 5000 }),
      receipt({ contributionKind: "In-Kind", amountCents: 3000 }),
    ]);
    expect(result).toMatchObject({ status: "qualified", totalAmountCents: 15000, includedReceiptRowCount: 2,
      matchedCommitteeRowCount: 3, excludedNonCommitteeRowCount: 2, inKindRowCount: 1 });
    if (result.status !== "qualified") throw new Error("Expected qualified result");
    expect(result.committees.map((row) => row.reportedCommitteeName)).toEqual(["Example Committee", "Other Committee"]);
  });

  it("preserves repeated source occurrences while aggregating conservative filed names", () => {
    const result = aggregate([receipt(), receipt(), receipt({ contributorCommittee: "  EXAMPLE   COMMITTEE  " })]);
    expect(result).toMatchObject({ status: "qualified", totalAmountCents: 30000, includedReceiptRowCount: 3,
      committees: [{ reportedCommitteeName: "Example Committee", reportedNameKey: "EXAMPLE COMMITTEE", amountCents: 30000, receiptCount: 3 }] });
  });

  it("selects an equal amended multiset without deduplicating repeated receipts", () => {
    const result = aggregate([receipt(), receipt(), receipt({ report: amended().report }), receipt({ report: amended().report })], [report(), amended()]);
    expect(result).toMatchObject({ status: "qualified", sourceRowCount: 4, canonicalRowCount: 2,
      totalAmountCents: 20000, includedReceiptRowCount: 2, committees: [{ receiptCount: 2, amountCents: 20000 }] });
  });

  it("holds a differing relevant amendment instead of adding or guessing replacement", () => {
    const result = aggregate([receipt(), receipt({ report: amended().report, amountCents: 5000 })], [report(), amended()]);
    expect(result).toMatchObject({ status: "held", reason: "unresolved_receipt_lineage",
      relevantUnresolvedLineageCount: 1, excludedLineageRowCount: 2, excludedLineageAmountCents: 15000, lineageDiagnosticCodes: ["ambiguous_amendment"] });
    expect(result).not.toHaveProperty("committees");
    expect(result).not.toHaveProperty("totalAmountCents");
  });

  it("holds an amendment that moves a relevant receipt across the cycle boundary", () => {
    const movedOut = aggregate([receipt(), receipt({ report: amended().report, contributionDate: "2026-08-01" })], [report(), amended()]);
    expect(movedOut).toMatchObject({ status: "held", reason: "unresolved_receipt_lineage", lineageDiagnosticCodes: ["ambiguous_amendment"] });
    const movedIn = aggregate([receipt({ contributionDate: "2026-08-01" }), receipt({ report: amended().report })], [report(), amended()]);
    expect(movedIn).toMatchObject({ status: "held", reason: "unresolved_receipt_lineage", lineageDiagnosticCodes: ["ambiguous_amendment"] });
  });

  it("counts only in-cycle rows of an exactly restated lineage", () => {
    const result = aggregate([receipt(), receipt({ contributionDate: "2026-08-01" }),
      receipt({ report: amended().report }), receipt({ report: amended().report, contributionDate: "2026-08-01" })], [report(), amended()]);
    expect(result).toMatchObject({ status: "qualified", totalAmountCents: 10000, canonicalRowCount: 1, inCycleRowCount: 2, outsideCycleRowCount: 2 });
  });

  it.each(["missing_inventory", "unexpected_amendment"])("holds relevant %s without exposing lineage text", (kind) => {
    const privateName = "SYNTHETIC_PRIVATE_NAME";
    const row = kind === "missing_inventory" ? receipt({ contributorCommittee: privateName, report: "Other Report" })
      : receipt({ contributorCommittee: privateName, report: amended().report });
    const result = aggregate([row]);
    expect(result).toMatchObject({ status: "held", reason: "unresolved_receipt_lineage", relevantUnresolvedLineageCount: 1 });
    expect(JSON.stringify(result)).not.toContain(privateName);
    expect(JSON.stringify(result)).not.toContain("Other Report");
  });

  it("does not hold separately qualified committees for unrelated person-only lineage", () => {
    const result = aggregate([receipt(), receipt({ contributorCommittee: null, contributorLastName: "Example", report: "Other Report" })]);
    expect(result).toMatchObject({ status: "qualified", totalAmountCents: 10000, canonicalRowCount: 1, relevantUnresolvedLineageCount: 0 });
  });

  it("does not hold monetary receipts for an unrelated in-kind-only unresolved lineage", () => {
    const result = aggregate([receipt(), receipt({ contributionKind: "In-Kind", report: "Other Report" })]);
    expect(result).toMatchObject({ status: "qualified", totalAmountCents: 10000, relevantUnresolvedLineageCount: 0 });
  });

  it.each(["Credit", "Monetary!!!", "In Kind"])("holds unknown eligible receipt kind %s", (kind) => {
    expect(aggregate([receipt({ contributionKind: kind })])).toMatchObject({ status: "held", reason: "unknown_eligible_kind" });
  });

  it("holds negative eligible monetary adjustments only", () => {
    expect(aggregate([receipt({ amountCents: -1 })])).toMatchObject({ status: "held", reason: "negative_eligible_adjustment" });
    expect(aggregate([receipt({ contributorCommittee: null, amountCents: -1 }), receipt({ contributionKind: "In-Kind", amountCents: -1 })]))
      .toMatchObject({ status: "qualified", totalAmountCents: 0, excludedNonCommitteeRowCount: 1, inKindRowCount: 1 });
  });

  it("counts explicit zero monetary occurrences separately from positive receipt groups", () => {
    expect(aggregate([receipt({ amountCents: 0 }), receipt({ amountCents: 0 })]))
      .toMatchObject({ status: "qualified", totalAmountCents: 0, committees: [], zeroMonetaryRowCount: 2,
        includedReceiptRowCount: 0, matchedCommitteeRowCount: 2 });
  });

  it("uses the inclusive primary-to-general receipt-date window", () => {
    const result = aggregate([receipt({ contributionDate: "2026-08-04", amountCents: -1 }), receipt({ contributionDate: "2026-08-05" }),
      receipt({ contributionDate: "2026-11-03" }), receipt({ contributionDate: "2026-11-04", contributionKind: "Credit" })]);
    expect(result).toMatchObject({ status: "qualified", totalAmountCents: 20000, inCycleRowCount: 2,
      outsideCycleRowCount: 2, includedReceiptRowCount: 2 });
  });

  it("returns genuine qualified empty only with a valid source inventory", () => {
    expect(aggregate([])).toMatchObject({ status: "qualified", committees: [], totalAmountCents: 0, sourceRowCount: 0 });
    expect(aggregate([receipt({ contributorCommittee: null, contributorCompany: "Example business" })]))
      .toMatchObject({ status: "qualified", committees: [], totalAmountCents: 0, excludedNonCommitteeRowCount: 1 });
    expect(aggregate([], [])).toMatchObject({ status: "held", reason: "invalid_report_inventory" });
  });

  it.each([
    { amountCents: Number.NaN }, { amountCents: 1.1 }, { amountCents: Number.MAX_SAFE_INTEGER + 1 },
    { contributionDate: "2026-02-30" }, { report: "" }, { mecid: "bad" },
    { contributorCommittee: "bad\u0000name" }, { employer: undefined },
  ])("validates source rows before any cycle or payer filter", (override) => {
    const row = receipt({ contributorCommittee: null, contributionDate: "2020-01-01", ...override } as Partial<MissouriMecContributionRow>);
    expect(aggregate([receipt(), row])).toMatchObject({ status: "held", reason: "invalid_source_row" });
  });

  it("rejects mixed receiving committees rather than merging their financial scope", () => {
    expect(aggregate([receipt(), receipt({ mecid: "C654321" })])).toMatchObject({ status: "held", reason: "invalid_source_row" });
  });

  it("rejects malformed inventory before accepting a zero", () => {
    expect(aggregate([], [report({ dateFiled: "2026-02-30" })])).toMatchObject({ status: "held", reason: "invalid_report_inventory" });
    expect(aggregate([], [report({ lineageKey: "WRONG" })])).toMatchObject({ status: "held", reason: "invalid_report_inventory" });
  });

  it("holds unsafe group and total cent sums", () => {
    expect(aggregate([receipt({ amountCents: Number.MAX_SAFE_INTEGER }), receipt({ amountCents: 1 })]))
      .toMatchObject({ status: "held", reason: "unsafe_cent_total" });
    expect(aggregate([receipt({ amountCents: Number.MAX_SAFE_INTEGER }), receipt({ contributorCommittee: "Other Committee", amountCents: 1 })]))
      .toMatchObject({ status: "held", reason: "unsafe_cent_total" });
  });

  it("holds invalid cycle bounds with safe diagnostics", () => {
    expect(aggregateMissouriCommitteeMonetaryReceipts({ ...window, cycleStart: "2026-11-04", inventory: [report()], contributionRows: [] }))
      .toMatchObject({ status: "held", reason: "invalid_cycle" });
  });
});
