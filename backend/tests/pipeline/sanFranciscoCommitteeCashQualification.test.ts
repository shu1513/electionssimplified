import { describe, expect, it } from "vitest";
import { qualifySanFranciscoCommitteeCash } from "../../src/pipeline/sanFranciscoFinance/sanFranciscoCommitteeCashQualification.js";
import type {
  SanFranciscoFilingIndexRow,
  SanFranciscoItemizedTransactionRow,
  SanFranciscoSummaryRow,
} from "../../src/pipeline/sanFranciscoFinance/sanFranciscoOpenDataClient.js";

const filing = (): SanFranciscoFilingIndexRow => ({
  filingNid: "chain",
  filingActivityNid: "amendment2",
  fppcId: "1483804",
  filingDate: "2026-07-31",
  periodStart: "2026-01-01",
  periodEnd: "2026-06-30",
  currentStatus: "Most Recent Amendment",
  hasEfileContent: true,
  rejected: false,
});
const summary = (): SanFranciscoSummaryRow => ({
  filingNid: "chain",
  filingActivityNid: "amendment2",
  fppcId: "1483804",
  filingIdNumber: "2",
  filingType: "Amendment",
  formType: "FPPC460",
  periodStart: "2026-01-01",
  periodEnd: "2026-06-30",
  monetaryContributionsCents: 15000,
  line2Cents: 0,
  contributionsCents: 15000,
  expendituresCents: 2000,
  endingCashCents: 13000,
  outstandingDebtsCents: 0,
  loansReceivedCents: 0,
  syncFlag: true,
  scheduleAItemizedCents: 15000,
  scheduleEItemizedCents: 2000,
});
const row = (
  overrides: Partial<SanFranciscoItemizedTransactionRow> = {},
): SanFranciscoItemizedTransactionRow => ({
  filingNid: "chain",
  filingActivityNid: "amendment2",
  fppcId: "1483804",
  elementNid: "gift",
  transactionId: "INC1",
  formType: "A",
  transactionDate: "2026-03-01T00:00:00.000",
  contributorFirstName: null,
  contributorLastName: "Example Committee",
  occupation: null,
  employer: null,
  city: null,
  state: null,
  zip: null,
  entityCode: "COM",
  calculatedAmountCents: 10000,
  transactionAmount1Cents: 10000,
  memoCode: false,
  isItemized: true,
  crossReferenceMatch: null,
  crossReferenceSchedule: null,
  supportOpposeCode: null,
  transactionCode: null,
  reportedCommitteeId: "reported1",
  transactionDescription: null,
  ...overrides,
});
function input() {
  return {
    fppcId: "1483804",
    electionYear: 2026,
    windowStart: "2025-01-01",
    windowEnd: "2026-12-31",
    currentFilings: [filing()],
    summaryRows: [summary()],
    transactions: [
      row(),
      row({
        elementNid: "person",
        entityCode: "IND",
        contributorLastName: "Synthetic Individual",
        calculatedAmountCents: 5000,
      }),
      row({
        elementNid: "return",
        formType: "E",
        transactionCode: "RFD",
        calculatedAmountCents: 2000,
      }),
    ],
  };
}

describe("qualifySanFranciscoCommitteeCash synthetic current source controls", () => {
  it("accepts exact current amendment and whole monetary A/E controls", () => {
    const result = qualifySanFranciscoCommitteeCash(input());
    expect(result.positions[0]).toMatchObject({
      amountCents: 8000,
      contributionCount: 1,
    });
    expect(result.reports[0]).toMatchObject({
      filingActivityNid: "amendment2",
      aOccurrenceIds: ["gift", "person"],
      eOccurrenceIds: ["return"],
    });
  });
  it("preserves exact duplicate-valued gifts with distinct source element IDs", () => {
    const x = input();
    x.transactions.push(row({ elementNid: "gift2" }));
    x.summaryRows[0]!.scheduleAItemizedCents = 25000;
    expect(qualifySanFranciscoCommitteeCash(x).positions[0]).toMatchObject({
      amountCents: 18000,
      contributionCount: 2,
    });
  });
  it("uses reported IDs as evidence, not a self or legal identity key", () => {
    const x = input();
    x.transactions[0]!.reportedCommitteeId = x.fppcId;
    x.transactions[2]!.reportedCommitteeId = x.fppcId;
    expect(qualifySanFranciscoCommitteeCash(x).positions[0]!.amountCents).toBe(
      8000,
    );
  });
  it("does not include anonymous summary money in named positions", () => {
    const x = input();
    x.summaryRows[0]!.monetaryContributionsCents = 16500;
    expect(qualifySanFranciscoCommitteeCash(x).totalAmountCents).toBe(8000);
  });
  it("keeps zero/negative exact return positions", () => {
    const x = input();
    x.transactions[2]!.calculatedAmountCents = 12000;
    x.summaryRows[0]!.scheduleEItemizedCents = 12000;
    expect(qualifySanFranciscoCommitteeCash(x).positions[0]!.amountCents).toBe(
      -2000,
    );
  });
  it.each(["summary", "row"])("rejects superseded %s edition", (kind) => {
    const x = input();
    if (kind === "summary") x.summaryRows[0]!.filingActivityNid = "original1";
    else x.transactions[0]!.filingActivityNid = "original1";
    expect(() => qualifySanFranciscoCommitteeCash(x)).toThrow(
      /edition mismatch|current edition/,
    );
  });
  it("refuses a missing current report or a duplicate summary", () => {
    const x = input();
    x.summaryRows = [];
    expect(() => qualifySanFranciscoCommitteeCash(x)).toThrow(
      /missing current summary/,
    );
    const y = input();
    y.summaryRows.push(summary());
    expect(() => qualifySanFranciscoCommitteeCash(y)).toThrow(/mismatch/);
  });
  it("rejects wrong receiving IDs, unsynced and ambiguous current authorities", () => {
    for (const mutate of [
      (x: ReturnType<typeof input>) => {
        x.transactions[0]!.fppcId = "9999999";
      },
      (x: ReturnType<typeof input>) => {
        x.summaryRows[0]!.syncFlag = null;
      },
      (x: ReturnType<typeof input>) => {
        x.currentFilings.push(filing());
      },
      (x: ReturnType<typeof input>) => {
        x.currentFilings[0]!.hasEfileContent = false;
      },
    ]) {
      const x = input();
      mutate(x);
      expect(() => qualifySanFranciscoCommitteeCash(x)).toThrow();
    }
  });
  it.each(["A", "E"])(
    "rejects missing or changed whole %s controls",
    (kind) => {
      const x = input();
      if (kind === "A") x.summaryRows[0]!.scheduleAItemizedCents = 14999;
      else x.summaryRows[0]!.scheduleEItemizedCents = undefined;
      expect(() => qualifySanFranciscoCommitteeCash(x)).toThrow(/controls/);
    },
  );
  it("rejects lost ordinary expenses even if committee returns still match", () => {
    const x = input();
    x.summaryRows[0]!.scheduleEItemizedCents = 2200;
    expect(() => qualifySanFranciscoCommitteeCash(x)).toThrow(/whole A\/E/);
  });
  it("excludes memo occurrences consistently from complete controls", () => {
    const x = input();
    x.transactions.push(row({ elementNid: "memo", memoCode: true }));
    expect(qualifySanFranciscoCommitteeCash(x).totalAmountCents).toBe(8000);
  });
  it.each(["memo", "itemized", "name", "date", "duplicate"])(
    "rejects unresolved source %s",
    (kind) => {
      const x = input();
      if (kind === "memo") x.transactions[0]!.memoCode = null;
      if (kind === "itemized") x.transactions[0]!.isItemized = null;
      if (kind === "name") x.transactions[0]!.contributorLastName = null;
      if (kind === "date") x.transactions[0]!.transactionDate = "2026-02-31";
      if (kind === "duplicate") x.transactions[1]!.elementNid = "gift";
      expect(() => qualifySanFranciscoCommitteeCash(x)).toThrow();
    },
  );
  it.each(["2026-03-01garbage", "2026-03-01T99:00:00", "2026-03-01T00:60:00"])(
    "refuses malformed full source date %s",
    (transactionDate) => {
      const x = input();
      x.transactions[0]!.transactionDate = transactionDate;
      expect(() => qualifySanFranciscoCommitteeCash(x)).toThrow(/date/);
    },
  );
  it("refuses boundary reports and out-of-period transactions rather than narrowing", () => {
    const x = input();
    x.windowStart = "2026-02-01";
    expect(() => qualifySanFranciscoCommitteeCash(x)).toThrow(/period exceeds/);
    const y = input();
    y.transactions[0]!.transactionDate = "2025-12-31";
    expect(() => qualifySanFranciscoCommitteeCash(y)).toThrow(/date exceeds/);
  });
  it("refuses offsetting out-of-window activity even when aggregate controls match", () => {
    const x = input();
    x.transactions.push(
      row({
        elementNid: "outside1",
        transactionDate: "2027-01-01",
        calculatedAmountCents: 5000,
      }),
      row({
        elementNid: "outside2",
        transactionDate: "2027-01-01",
        calculatedAmountCents: -5000,
      }),
    );
    expect(() => qualifySanFranciscoCommitteeCash(x)).toThrow(/date exceeds/);
  });
  it("preserves an unproved committee F497 occurrence rather than applying loose ID dedupe", () => {
    const x = input();
    x.transactions.push(
      row({
        elementNid: "late",
        formType: "F497P1",
        filingNid: "late-chain",
        filingActivityNid: "late-edition",
      }),
    );
    expect(() => qualifySanFranciscoCommitteeCash(x)).toThrow(
      /late occurrence needs/,
    );
  });
  it.each([null, "", "ORG", "PAC", "unknown"])(
    "rejects a late contribution with unavailable donor class %s even with zero A/E controls",
    (entityCode) => {
      const x = input();
      x.summaryRows[0]!.scheduleAItemizedCents = 0;
      x.summaryRows[0]!.scheduleEItemizedCents = 0;
      x.transactions = [row({ formType: "F497P1", entityCode })];
      expect(() => qualifySanFranciscoCommitteeCash(x)).toThrow(
        /class unavailable/,
      );
    },
  );
  it.each(["IND", "OTH", "PTY", "COM", "SCC"])(
    "rejects an unknown late memo role for class %s",
    (entityCode) => {
      const x = input();
      x.transactions.push(
        row({
          elementNid: "late",
          formType: "F497P1",
          entityCode,
          memoCode: null,
        }),
      );
      expect(() => qualifySanFranciscoCommitteeCash(x)).toThrow(
        /memo role unavailable/,
      );
    },
  );
  it.each(["IND", "OTH", "PTY"])(
    "excludes a known noncommittee late contribution: %s",
    (entityCode) => {
      const x = input();
      x.transactions.push(
        row({ elementNid: "late", formType: "F497P1", entityCode }),
      );
      expect(qualifySanFranciscoCommitteeCash(x).totalAmountCents).toBe(8000);
    },
  );
  it("excludes a confirmed committee late memo occurrence", () => {
    const x = input();
    x.transactions.push(
      row({ elementNid: "late", formType: "F497P1", memoCode: true }),
    );
    expect(qualifySanFranciscoCommitteeCash(x).totalAmountCents).toBe(8000);
  });
  it("refuses possible untyped returns and ambiguous exact donor ownership", () => {
    const x = input();
    x.transactions[2]!.transactionCode = "OTHER";
    x.transactions[2]!.transactionDescription = "Returned contribution";
    expect(() => qualifySanFranciscoCommitteeCash(x)).toThrow(
      /possible return/,
    );
    const y = input();
    y.transactions[2]!.reportedCommitteeId = "different";
    expect(() => qualifySanFranciscoCommitteeCash(y)).toThrow(/ID ambiguity/);
  });
  it("refuses a differently classified RFD exactly naming a reported committee", () => {
    const x = input();
    x.transactions[2]!.entityCode = "OTH";
    expect(() => qualifySanFranciscoCommitteeCash(x)).toThrow(
      /return class contradicts/,
    );
  });
  it.each(["ORG", "PAC", "null", "unknown", null])(
    "preserves the cash component for unknown gift/return class %s",
    (entityCode) => {
      const gift = input();
      gift.transactions[0]!.entityCode = entityCode;
      expect(() => qualifySanFranciscoCommitteeCash(gift)).toThrow(
        /class unavailable/,
      );
      const returned = input();
      returned.transactions[2]!.entityCode = entityCode;
      returned.transactions[2]!.contributorLastName =
        "Different Reported Owner";
      expect(() => qualifySanFranciscoCommitteeCash(returned)).toThrow(
        /class unavailable/,
      );
    },
  );
  it.each(["unknown", null])(
    "retains ordinary E rows with unknown class %s in whole expense controls",
    (entityCode) => {
      const x = input();
      x.transactions[2]!.transactionCode = "OFC";
      x.transactions[2]!.entityCode = entityCode;
      const result = qualifySanFranciscoCommitteeCash(x);
      expect(result.totalAmountCents).toBe(10_000);
      expect(result.reports[0]!.eOccurrenceIds).toEqual(["return"]);
    },
  );
  it("is occurrence-preserving and deterministic under source order changes", () => {
    const x = input();
    expect(qualifySanFranciscoCommitteeCash(x)).toEqual(
      qualifySanFranciscoCommitteeCash({
        ...x,
        transactions: [...x.transactions].reverse(),
      }),
    );
  });
});
