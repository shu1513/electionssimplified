import { describe, expect, it } from "vitest";

import {
  aggregateMinnesotaReportedCommitteeCash,
  MinnesotaReportedCommitteeCashHoldError,
  type MinnesotaReportedCommitteeCashHoldReason,
} from "../../../src/pipeline/minnesotaFinance/minnesotaReportedCommitteeCashAggregator.js";
import type { MinnesotaCampaignFinanceCsvRow } from "../../../src/pipeline/minnesotaFinance/minnesotaCampaignFinanceArtifactReader.js";

function receipt(overrides: Partial<MinnesotaCampaignFinanceCsvRow> = {}): MinnesotaCampaignFinanceCsvRow {
  return {
    "Recipient reg num": "10001", "Recipient type": "PCC", Year: "2026",
    "Contrib type": "Political Committee/Fund", "Contrib Reg Num": "30001",
    Contributor: "Example Committee", "Receipt type": "Contribution", "In kind?": "No",
    "Receipt date": "2026-09-01", Amount: "10.0000", ...overrides,
  };
}
function aggregate(rows: readonly MinnesotaCampaignFinanceCsvRow[]) {
  return aggregateMinnesotaReportedCommitteeCash({ rows, committeeId: "10001", electionYear: 2026 });
}
function expectHold(row: MinnesotaCampaignFinanceCsvRow, reason: MinnesotaReportedCommitteeCashHoldReason) {
  let thrown: unknown;
  try { aggregate([row]); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(MinnesotaReportedCommitteeCashHoldError);
  expect((thrown as MinnesotaReportedCommitteeCashHoldError).reason).toBe(reason);
}

describe("Minnesota reported committee cash aggregator", () => {
  it("preserves equal source occurrences and adds exact cents, including leading-dot amounts", () => {
    const equal = receipt({ Amount: "100.0000" });
    const result = aggregate([equal, equal, receipt({ Amount: ".2500" }), receipt({ Amount: "1.2300", Year: "2025" })]);
    expect(result).toEqual({
      donors: [{ reportedCommitteeId: "30001", reportedCommitteeName: "Example Committee", amountCents: 20_148, contributionCount: 4 }],
      totalAmountCents: 20_148, matchedContributionRowCount: 4, includedContributionRowCount: 4,
      excludedContributionRowCount: 0, excludedUnknownClassRowCount: 0, zeroContributionRowCount: 0,
    });
  });

  it("excludes other receiving accounts, years, native contributor classes, noncontributions and in-kind gifts", () => {
    const rows = [receipt(), receipt({ "Recipient reg num": "99999", "Contrib type": "Future Unknown" }), receipt({ Year: "2024", Amount: "invalid" }),
      ...["Individual", "Candidate Committee", "Party Unit", "Lobbyist", "Self", "Other", "Registered with Hennepin County"]
        .map((type) => receipt({ "Contrib type": type, "Receipt date": "invalid" })),
      ...["Miscellaneous Income", "Miscellaneous", "MiscellaneousIncome", "Loan Payable", "Loan Receivable"]
        .map((type) => receipt({ "Receipt type": type })),
      receipt({ "In kind?": "Yes" }), receipt({ "Recipient type": "PTU" }), receipt({ "Recipient type": "PCF" })];
    const result = aggregate(rows);
    expect(result.donors).toHaveLength(1);
    expect(result.totalAmountCents).toBe(1000);
    expect(result.matchedContributionRowCount).toBe(17);
    expect(result.excludedContributionRowCount).toBe(16);
    expect(result.includedContributionRowCount).toBe(1);
  });

  it("does not hold explicitly excluded rows over unrelated unknown roles or invalid dates", () => {
    const result = aggregate([
      receipt({ "Contrib type": "Unknown/Null", "Receipt type": "Loan Payable", "Receipt date": "invalid" }),
      receipt({ "Recipient type": "unknown", "Contrib type": "Other", Amount: "invalid" }),
      receipt({ "Contrib type": "unknown", "In kind?": "Yes", Contributor: "" }),
    ]);
    expect(result.excludedContributionRowCount).toBe(3);
    expect(result.excludedUnknownClassRowCount).toBe(0);
    expect(result.donors).toEqual([]);
  });

  it("omits native blank/Unknown/Null classes with a coverage count without suppressing explicit committee gifts", () => {
    const result = aggregate([
      receipt(),
      receipt({ "Contrib type": "", Amount: "invalid", "Contrib Reg Num": "", "Receipt date": "invalid" }),
      receipt({ "Contrib type": "Unknown/Null", Amount: "invalid", Contributor: "" }),
      receipt({ "Contrib type": "Unknown/Null", "Receipt type": "Loan Payable" }),
      receipt({ "Contrib type": "", "In kind?": "Yes" }),
      receipt({ "Contrib type": "", Year: "2024" }),
    ]);
    expect(result.totalAmountCents).toBe(1000);
    expect(result.includedContributionRowCount).toBe(1);
    expect(result.excludedContributionRowCount).toBe(5);
    expect(result.excludedUnknownClassRowCount).toBe(2);
    expect(result.donors).toHaveLength(1);
  });

  it("holds an absent contributor class property and genuinely new classes", () => {
    const row = receipt(); delete row["Contrib type"];
    expectHold(row, "unknown_contributor_type");
    expectHold(receipt({ "Contrib type": "Future Class" }), "unknown_contributor_type");
  });

  it("keeps reported name/account variations distinct while normalizing incidental whitespace and Unicode representation", () => {
    const result = aggregate([
      receipt({ Contributor: " Caf\u00e9 Committee " }), receipt({ Contributor: "Cafe\u0301  Committee" }),
      receipt({ Contributor: "CAF\u00c9 COMMITTEE" }), receipt({ Contributor: "Caf\u00e9 Committee Inc." }),
      receipt({ Contributor: "Caf\u00e9 Committee", "Contrib Reg Num": "30002" }),
    ]);
    expect(result.donors).toHaveLength(4);
    expect(result.donors.find((d) => d.reportedCommitteeName === "Caf\u00e9 Committee" && d.reportedCommitteeId === "30001"))
      .toMatchObject({ amountCents: 2000, contributionCount: 2 });
    expect(result.donors.filter((d) => d.reportedCommitteeId === "30002")).toHaveLength(1);
  });

  it("counts explicit zeros without inventing a donor group or gift occurrence", () => {
    const result = aggregate([receipt({ Amount: ".0000" }), receipt({ Amount: "-0.0000" })]);
    expect(result.donors).toEqual([]);
    expect(result.totalAmountCents).toBe(0);
    expect(result.zeroContributionRowCount).toBe(2);
    expect(result.includedContributionRowCount).toBe(0);
  });

  it.each([
    ["Recipient type", "Future Recipient", "unknown_recipient_type"],
    ["Receipt type", "Future Receipt", "unknown_receipt_type"],
    ["In kind?", "", "unknown_in_kind_flag"],
    ["Year", "", "invalid_reporting_year"],
    ["Contrib Reg Num", "TBSN", "invalid_reported_donor_account"],
    ["Contrib Reg Num", "", "invalid_reported_donor_account"],
    ["Contributor", "", "invalid_reported_donor_name"],
    ["Contributor", "Example\nCommittee", "invalid_reported_donor_name"],
    ["Receipt date", "2026-02-30", "invalid_receipt_date"],
    ["Receipt date", "9/1/2026", "invalid_receipt_date"],
    ["Amount", "-1.0000", "negative_cash_contribution"],
    ["Amount", "1.0001", "non_cent_precision"],
    ["Amount", "(1.00)", "invalid_amount"],
    ["Amount", "1e3", "invalid_amount"],
    ["Amount", "", "invalid_amount"],
  ] as const)("holds potentially included rows with %s=%s without exposing source values", (field, value, reason) => {
    expectHold(receipt({ [field]: value }), reason);
  });

  it("uses reporting Year authority rather than replacing it with receipt-date year", () => {
    const result = aggregate([receipt({ Year: "2025", "Receipt date": "2026-01-02" }), receipt({ Year: "2026", "Receipt date": "2027-01-02" })]);
    expect(result.includedContributionRowCount).toBe(2);
    expect(result.totalAmountCents).toBe(2000);
  });

  it("rejects unsafe individual, group and component totals instead of rounding", () => {
    expectHold(receipt({ Amount: "90071992547409.92" }), "unsafe_amount");
    expect(() => aggregate([receipt({ Amount: "90071992547409.90" }), receipt({ Amount: ".02" })]))
      .toThrow("Minnesota reported committee cash held: unsafe_amount");
    expect(() => aggregate([receipt({ Amount: "90071992547409.90" }), receipt({ Amount: ".02", "Contrib Reg Num": "30002" })]))
      .toThrow("Minnesota reported committee cash held: unsafe_amount");
  });

  it("emits only constant safe hold diagnostics and validates missing receiving selectors", () => {
    const secret = "Synthetic Private Donor";
    expect(() => aggregate([receipt({ Contributor: secret, Amount: "not money" })]))
      .toThrow(/^Minnesota reported committee cash held: invalid_amount$/);
    const row = receipt(); delete row["Recipient reg num"];
    expectHold(row, "missing_recipient_account");
    expect(() => aggregateMinnesotaReportedCommitteeCash({ rows: [], committeeId: "not numeric", electionYear: 2026 }))
      .toThrow("invalid_receiving_account");
    expect(() => aggregateMinnesotaReportedCommitteeCash({ rows: [], committeeId: "10001", electionYear: 2026.5 }))
      .toThrow("invalid_election_year");
  });
});
