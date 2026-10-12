import { describe, expect, it } from "vitest";
import { aggregateFloridaNetCommitteeDonors, type FloridaCashDonorResolution } from "../../../src/pipeline/floridaFinance/floridaNetCommitteeDonorAggregator.js";
import type { FloridaContributionRow } from "../../../src/pipeline/floridaFinance/floridaCampaignFinanceRows.js";

const identity: FloridaCashDonorResolution = {
  kind: "committee", committeeId: "64858", committeeName: "Florida HIV AIDS PAC", committeeType: "PAC",
  sourceUrl: "https://dos.elections.myflorida.com/committees/ComDetail.asp?account=64858",
};
function row(overrides: Partial<FloridaContributionRow> = {}): FloridaContributionRow {
  return {
    recipientName: "TANT ALLISON", contributionDate: "03/03/2025", amount: "500.00", transactionType: "CHE",
    contributorName: "Florida HIV AIDS PAC", address: "1 Test St", city: "", state: "", zip: "",
    cityStateZip: "TALLAHASSEE FL 32301", occupation: "", inKindDescription: "", ...overrides,
  };
}
function aggregate(rows: FloridaContributionRow[], resolveDonor = (_row: FloridaContributionRow): FloridaCashDonorResolution => identity) {
  return aggregateFloridaNetCommitteeDonors({
    contributionRows: rows, recipientNames: ["TANT ALLISON"], selfContributorNames: ["TANT ALLISON"],
    windowStart: "2025-01-01", windowEnd: "2026-10-11", resolveDonor,
  });
}

describe("Florida current net committee donors", () => {
  it("nets the published gift/refund pattern and counts positive reported occurrences", () => {
    const result = aggregate([
      row(), row({ contributionDate: "10/20/2025", amount: "1000.00" }),
      row({ contributionDate: "03/30/2026", amount: "-500.00", transactionType: "REF" }),
    ]);
    expect(result).toMatchObject({
      status: "accepted", netCommitteeAmount: 1000,
      donors: [{ amount: 1000, grossAmount: 1500, refundAmount: 500, contributionCount: 2, refundCount: 1 }],
    });
  });

  it("retains identical cash occurrences and excludes identical in-kind occurrences", () => {
    const result = aggregate([row(), row(), row({ transactionType: "INK" }), row({ transactionType: "INK" })]);
    expect(result).toMatchObject({ status: "accepted", donors: [{ amount: 1000, contributionCount: 2 }] });
  });

  it("does not require refunds to appear after their gifts in the export", () => {
    expect(aggregate([row({ amount: "-500", transactionType: "REF" }), row()]))
      .toMatchObject({ status: "accepted", donors: [], netCommitteeAmount: 0 });
  });

  it("excludes source carryover, loans, interest, self cash and out-of-window gifts", () => {
    const result = aggregate([
      row(), row({ amount: "20000", transactionType: "COF" }), row({ transactionType: "LOA" }),
      row({ transactionType: "INT" }), row({ contributorName: "TANT ALLISON", amount: "5000" }),
      row({ contributionDate: "12/31/2024", amount: "9000" }),
      row({ contributionDate: "10/12/2026", amount: "9000" }),
    ]);
    expect(result).toMatchObject({ status: "accepted", donors: [{ amount: 500, contributionCount: 1 }] });
  });

  it("keeps unmatched positive cash unclassified but never ignores an unmatched refund", () => {
    const unmatched = (): FloridaCashDonorResolution => ({ kind: "unmatched" });
    expect(aggregate([row()], unmatched)).toEqual({
      status: "accepted", donors: [], netCommitteeAmount: 0,
      unclassifiedPositiveCashAmount: 500, unclassifiedPositiveCashCount: 1,
    });
    expect(aggregate([row({ amount: "-500", transactionType: "REF" })], unmatched))
      .toEqual({ status: "preserve", reason: "unresolved_refund_identity" });
  });

  it("preserves the component when a matching legal name is ambiguous", () => {
    expect(aggregate([row()], () => ({ kind: "unresolved", reason: "same_name_accounts" })))
      .toEqual({ status: "preserve", reason: "donor_identity:same_name_accounts" });
  });

  it("keeps actual party/committee types and excludes a verified entity outside scope", () => {
    const result = aggregate([row(), row({ contributorName: "Party", amount: "1000" }), row({ contributorName: "IXO" })],
      (gift) => gift.contributorName === "IXO" ? { kind: "excluded" }
        : gift.contributorName === "Party" ? { ...identity, kind: "committee", committeeId: "4700", committeeName: "Party", committeeType: "PTY" } : identity);
    expect(result).toMatchObject({ status: "accepted", donors: [{ committeeType: "PTY", amount: 1000 }, { committeeType: "PAC", amount: 500 }] });
  });

  it("rejects conflicting identities for one source account", () => {
    let calls = 0;
    expect(aggregate([row(), row()], () => ++calls === 1 ? identity : { ...identity, kind: "committee", committeeName: "Different Committee" }))
      .toEqual({ status: "preserve", reason: "conflicting_committee_identity" });
  });

  it.each([
    [{ amount: "-1", transactionType: "CHE" }, "invalid_cash_sign"],
    [{ amount: "500", transactionType: "REF" }, "invalid_cash_sign"],
    [{ amount: "0", transactionType: "CHE" }, "invalid_cash_sign"],
    [{ amount: "1.005" }, "invalid_contribution_cents"],
    [{ amount: "$500" }, "invalid_contribution_cents"],
    [{ amount: "90071992547410.00" }, "invalid_contribution_cents"],
    [{ transactionType: "MUC" }, "unknown_contribution_type"],
    [{ contributionDate: "02/30/2026" }, "invalid_contribution_date"],
    [{ recipientName: "TANT ALISON" }, "recipient_mismatch"],
    [{ contributorName: "" }, "missing_cash_donor_name"],
    [{ amount: "-500", transactionType: "INK" }, "negative_non_refund"],
  ] as const)("preserves malformed or unsupported financial source values %j", (changes, reason) => {
    expect(aggregate([row(changes)])).toEqual({ status: "preserve", reason });
  });

  it("preserves a negative window net instead of clamping or importing an older gift", () => {
    expect(aggregate([
      row({ contributionDate: "12/31/2024", amount: "1000" }),
      row({ amount: "-500", transactionType: "REF" }),
    ])).toEqual({ status: "preserve", reason: "negative_committee_net" });
  });

  it("rejects a reversed reporting window before aggregation", () => {
    expect(aggregateFloridaNetCommitteeDonors({
      contributionRows: [], recipientNames: ["TANT ALLISON"], selfContributorNames: [],
      windowStart: "2026-10-11", windowEnd: "2025-01-01", resolveDonor: () => identity,
    })).toEqual({ status: "preserve", reason: "invalid_scope" });
  });
});
