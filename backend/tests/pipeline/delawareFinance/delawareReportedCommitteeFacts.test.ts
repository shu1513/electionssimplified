import { describe, expect, it } from "vitest";
import type { DelawareNativeLedger, DelawareNativeLedgerRow } from "../../../src/pipeline/delawareFinance/delawareNativeLedger.js";
import { aggregateDelawareReportedCommitteeFacts as aggregate } from "../../../src/pipeline/delawareFinance/delawareReportedCommitteeFacts.js";

const CF = "01006635";
const row = (id: number, amount: number, rawFields: Record<string, unknown>): DelawareNativeLedgerRow => ({
  transactionId: id, date: "2026-09-01", amountCents: amount, rawFields,
});
const receipt = (id: number, amount: number, overrides: Record<string, unknown> = {}) => row(id, amount, {
  WC_ID: CF, ContributionType: "Check", ContributorType: "Political Action Committee",
  ContributorName: "Example PAC, Inc.", ...overrides,
});
const expense = (id: number, amount: number, overrides: Record<string, unknown> = {}) => row(id, amount, {
  CCF_ID: CF, ExpenseCategory: "Return Contributions", PayeeType: "Political Action Committee",
  PayeeName: "Example PAC, Inc.", ExpenseMethod: "Check", ...overrides,
});
const ledger = (kind: "receipts" | "expenses", rows: DelawareNativeLedgerRow[]): DelawareNativeLedger => ({
  kind, rows, physicalRowCount: rows.length, transportOverlapCount: 0, advisoryTotals: [], rawRowFingerprint: kind,
});
const facts = (receipts: DelawareNativeLedgerRow[], expenses: DelawareNativeLedgerRow[] = []) => aggregate({
  receipts: ledger("receipts", receipts), expenses: ledger("expenses", expenses),
  receivingCfId: CF, receivingCommitteeName: "Friends of Example",
});

describe("Delaware reported committee facts", () => {
  it("retains distinct equal gifts, exact punctuation, in-kind and signed returns", () => {
    const result = facts([
      receipt(1, 60000), receipt(2, 60000), receipt(3, 25000, { ContributionType: "In-Kind" }), receipt(4, -10000),
    ], [expense(5, 15000)]);
    expect(result.donors).toHaveLength(1);
    expect(result.donors[0]).toMatchObject({
      reportedName: "Example PAC, Inc.", cashCents: 95000, inKindCents: 25000,
      giftTransactionIds: [1, 2, 3], refundTransactionIds: [4, 5],
    });
    expect(result.donors[0]!.reportedIdentity).toMatch(/^reported:[a-f0-9]{64}$/);
    expect(result.unresolvedReturnIds).toEqual([]);
  });
  it("does not promote business, union or unknown financial types by name", () => {
    const result = facts([
      receipt(1, 10000, { ContributorType: "Business/Group/Organization" }),
      receipt(2, 10000, { ContributorType: "Labor Union" }),
      receipt(3, 10000, { ContributionType: "New Unknown Mechanism" }),
    ]);
    expect(result.donors).toEqual([]);
    expect(result.unresolvedReceiptIds).toEqual([1, 2, 3]);
  });

  it("retains the observed Political Committee class and aggregate-class source IDs", () => {
    const aggregateClass = "Total of Contributions not exceeding $100";
    const result = facts([
      receipt(1, 60000, { ContributorType: "Political Committee" }),
      receipt(2, 1000, { ContributorType: aggregateClass, ContributionType: "Cash" }),
      receipt(3, 11200, { ContributorType: aggregateClass, ContributionType: aggregateClass }),
    ]);
    expect(result.donors).toHaveLength(1);
    expect(result.donors[0]).toMatchObject({ reportedContributorType: "Political Committee", cashCents: 60000 });
    expect(result.reportedAggregateReceiptIds).toEqual([2, 3]);
    expect(result.unresolvedReceiptIds).toEqual([]);
    expect(result.donors[0]!.giftTransactionIds).toEqual([1]);
  });
  it("keeps financial vendor refunds separate and individual returns out of PAC net", () => {
    const result = facts([
      receipt(1, 530000), receipt(2, 975838, { ContributorName: "Vendor", ContributionType: "Refund/Rebate", ContributorType: "Corporation/Partnership/Other Entity" }),
    ], [expense(3, 120000, { PayeeName: "Richard Example", PayeeType: "Individual" })]);
    expect(result.donors[0]!.cashCents).toBe(530000);
    expect(result.nonGiftReceiptIds).toEqual([2]);
    expect(result.unresolvedReturnIds).toEqual([]);
  });
  it("exposes unknown return ownership and conflicting source classes", () => {
    const result = facts([receipt(1, 60000)], [
      expense(2, 10000, { PayeeName: "Other PAC" }), expense(3, 10000, { PayeeType: "Individual" }),
      expense(4, 10000, { ExpenseMethod: "Unknown" }),
    ]);
    expect(result.unresolvedReturnIds).toEqual([2, 3, 4]);
    expect(result.donors[0]!.cashCents).toBe(60000);
  });
  it("keeps committee classes distinct, uncapped, without guessed legal IDs", () => {
    const result = facts(Array.from({ length: 8 }, (_, index) => receipt(index + 1, 10000, {
      ContributorName: `Committee ${index}`, ContributorType: index % 2 ? "Candidate Committee" : "PAC",
    })));
    expect(result.donors).toHaveLength(8);
    expect(result.donors.reduce((total, donor) => total + donor.cashCents, 0)).toBe(80000);
    expect(result.donors.every((donor) => !("registeredCfId" in donor))).toBe(true);
  });
  it("does not silently classify a possible self receipt or coerce negative net", () => {
    const result = facts([receipt(1, 10000), receipt(2, 10000, { ContributorName: "Friends of Example" })], [expense(3, 25000)]);
    expect(result.possibleSelfReceiptIds).toEqual([2]);
    expect(result.donors[0]!.cashCents).toBe(-15000);
  });
  it("rejects wrong receiving scopes", () => {
    expect(() => facts([receipt(1, 10000, { WC_ID: "01000000" })])).toThrow(/receiver mismatch/);
    expect(() => facts([receipt(1, 10000)], [expense(2, 1000, { CCF_ID: "01000000" })])).toThrow(/receiver mismatch/);
  });
});
