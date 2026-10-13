import { describe, expect, it } from "vitest";
import {
  aggregateSanFranciscoCommitteeCash,
  type SanFranciscoCommitteeCashOccurrence,
} from "../../src/pipeline/sanFranciscoFinance/sanFranciscoCommitteeCashAggregator.js";

function row(
  overrides: Partial<SanFranciscoCommitteeCashOccurrence> = {},
): SanFranciscoCommitteeCashOccurrence {
  return {
    occurrenceId: "source:1",
    formType: "A",
    transactionCode: null,
    entityCode: "COM",
    reportedName: "Example Committee",
    reportedCommitteeId: "reported-id",
    amountCents: 50_000,
    memoCode: false,
    ...overrides,
  };
}
function aggregate(
  scheduleARows: SanFranciscoCommitteeCashOccurrence[],
  scheduleEReturnRows: SanFranciscoCommitteeCashOccurrence[] = [],
  unpairedCashF497Rows: SanFranciscoCommitteeCashOccurrence[] = [],
) {
  return aggregateSanFranciscoCommitteeCash({
    scheduleARows,
    scheduleEReturnRows,
    unpairedCashF497Rows,
  });
}
const returned = (
  overrides: Partial<SanFranciscoCommitteeCashOccurrence> = {},
) =>
  row({
    occurrenceId: "return:1",
    formType: "E",
    transactionCode: "RFD",
    amountCents: 20_000,
    ...overrides,
  });

describe("aggregateSanFranciscoCommitteeCash (synthetic qualified source facts)", () => {
  it("nets signed A and exact E/RFD while counting distinct positive gifts", () => {
    const result = aggregate(
      [
        row(),
        row({ occurrenceId: "source:2" }),
        row({ occurrenceId: "source:3", amountCents: -10_000 }),
      ],
      [returned()],
    );
    expect(result.positions[0]).toMatchObject({
      amountCents: 70_000,
      contributionCount: 2,
      giftOccurrenceIds: ["source:1", "source:2"],
      returnOccurrenceIds: ["return:1", "source:3"],
    });
    expect(result.totalAmountCents).toBe(70_000);
  });
  it("retains negative and zero donor positions before reader filtering", () => {
    expect(
      aggregate([row({ amountCents: -500 })]).positions[0]!.amountCents,
    ).toBe(-500);
    expect(
      aggregate([row()], [returned({ amountCents: 50_000 })]).positions[0],
    ).toMatchObject({ amountCents: 0, contributionCount: 1 });
  });
  it("allows an explicit typed return-only donor position without guessing the original gift", () => {
    expect(aggregate([], [returned()]).positions[0]).toMatchObject({
      amountCents: -20_000,
      contributionCount: 0,
    });
  });
  it("uses only exact COM/SCC, excluding known party/individual/organization classes", () => {
    const rows = ["IND", "PTY", "OTH"].map((entityCode, i) =>
      row({
        occurrenceId: `other:${i}`,
        entityCode,
        reportedName: "PAC Name Hint",
      }),
    );
    const result = aggregate([...rows, row({ entityCode: "SCC" })]);
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0]!.sourceReportedClass).toBe("SCC");
    expect(result.diagnostics.excludedOtherClassCount).toBe(3);
  });
  it("does not claim candidate-looking COM is a narrow PAC or infer subtype exclusions", () => {
    expect(
      aggregate([row({ reportedName: "Example Candidate for Office 2026" })])
        .positions[0]!.sourceReportedClass,
    ).toBe("COM");
  });
  it("excludes memo, C in-kind, B1 loan and ordinary E payments", () => {
    const result = aggregate(
      [
        row({ memoCode: true }),
        row({ occurrenceId: "c", formType: "C" }),
        row({ occurrenceId: "b", formType: "B1" }),
      ],
      [returned({ occurrenceId: "e", transactionCode: "OFF" })],
    );
    expect(result.positions).toEqual([]);
    expect(result.diagnostics).toEqual({
      excludedMemoCount: 1,
      excludedOtherFormCount: 3,
      excludedOtherClassCount: 0,
    });
  });
  it("includes only the caller-authorized unpaired monetary F497 set", () => {
    const result = aggregate(
      [row()],
      [],
      [row({ occurrenceId: "late:1", formType: "F497P1" })],
    );
    expect(result.positions[0]).toMatchObject({
      amountCents: 100_000,
      contributionCount: 2,
    });
  });
  it("keeps reported IDs as evidence without merging differently named donors", () => {
    const result = aggregate([
      row(),
      row({ occurrenceId: "other", reportedName: "Other Committee" }),
    ]);
    expect(result.positions).toHaveLength(2);
    expect(
      result.positions.every((p) => p.committeeId.startsWith("reported:COM:")),
    ).toBe(true);
  });
  it("retains conflicting reported gift IDs without claiming legal identity", () => {
    const result = aggregate([
      row(),
      row({ occurrenceId: "second", reportedCommitteeId: "other-id" }),
    ]);
    expect(result.positions[0]!.reportedCommitteeIds).toEqual([
      "other-id",
      "reported-id",
    ]);
    expect(result.positions[0]!.amountCents).toBe(100_000);
  });
  it("groups case/whitespace names but retains punctuation and original display", () => {
    const result = aggregate([
      row({ reportedName: "Example-Committee" }),
      row({ occurrenceId: "space", reportedName: "Example Committee" }),
      row({ occurrenceId: "case", reportedName: "EXAMPLE  COMMITTEE" }),
    ]);
    expect(result.positions).toHaveLength(2);
    expect(
      result.positions.find((p) =>
        p.committeeId.endsWith(":EXAMPLE COMMITTEE"),
      ),
    ).toMatchObject({
      amountCents: 100_000,
      committeeName: "EXAMPLE  COMMITTEE",
    });
  });
  it("refuses cross-class return ambiguity instead of leaving a separate refund group", () => {
    expect(() =>
      aggregate(
        [row(), row({ occurrenceId: "scc", entityCode: "SCC" })],
        [returned()],
      ),
    ).toThrow(/class\/name ambiguity/);
  });
  it("refuses same-name return with incompatible reported IDs", () => {
    expect(() =>
      aggregate([row()], [returned({ reportedCommitteeId: "different" })]),
    ).toThrow(/reported ID ambiguity/);
  });
  it("allows missing optional reported IDs when class/name ownership is exact", () => {
    expect(
      aggregate([row({ reportedCommitteeId: null })], [returned()])
        .totalAmountCents,
    ).toBe(30_000);
  });
  it.each([null, "", "   "])(
    "refuses missing relevant donor name %s",
    (reportedName) => {
      expect(() => aggregate([row({ reportedName })])).toThrow(
        /donor unavailable/,
      );
    },
  );
  it.each(["ORG", "PAC", "null", "unknown", null])(
    "refuses unknown source class %s for both cash gifts and returns",
    (entityCode) => {
      expect(() => aggregate([row({ entityCode })])).toThrow(
        /class unavailable/,
      );
      expect(() => aggregate([row()], [returned({ entityCode })])).toThrow(
        /class unavailable/,
      );
    },
  );
  it("does not use a memo flag to hide an unknown financial source class", () => {
    expect(() =>
      aggregate([row({ entityCode: "unknown", memoCode: true })]),
    ).toThrow(/class unavailable/);
  });
  it("refuses unknown return class rather than assume noncommittee", () => {
    expect(() => aggregate([row()], [returned({ entityCode: null })])).toThrow(
      /return class unavailable/,
    );
  });
  it.each([1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "refuses unsafe cents %s",
    (amountCents) => {
      expect(() => aggregate([row({ amountCents })])).toThrow(/not safe cents/);
    },
  );
  it("refuses aggregate overflow even if each source amount is safe", () => {
    expect(() =>
      aggregate([
        row({ amountCents: Number.MAX_SAFE_INTEGER }),
        row({ occurrenceId: "overflow", amountCents: 1 }),
      ]),
    ).toThrow(/sum exceeds/);
  });
  it("refuses negative E/F497 reversals rather than infer net semantics", () => {
    expect(() => aggregate([], [returned({ amountCents: -1 })])).toThrow(
      /reversal/,
    );
    expect(() =>
      aggregate([], [], [row({ formType: "F497P1", amountCents: -1 })]),
    ).toThrow(/reversal/);
  });
  it("refuses duplicate IDs even on equal or excluded source elements", () => {
    expect(() => aggregate([row(), row()])).toThrow(/unique source occurrence/);
    expect(() => aggregate([row(), row({ memoCode: true })])).toThrow(
      /unique source occurrence/,
    );
    expect(() =>
      aggregate([row()], [returned({ occurrenceId: "source:1" })]),
    ).toThrow(/unique source occurrence/);
  });
  it("keeps equal dollars with different occurrence IDs and is order deterministic", () => {
    const rows = [
      row(),
      row({ occurrenceId: "other", reportedName: "Another Committee" }),
      row({ occurrenceId: "second" }),
    ];
    expect(aggregate(rows)).toEqual(aggregate([...rows].reverse()));
    expect(
      aggregate(rows).positions.find(
        (p) => p.committeeName === "Example Committee",
      )!.contributionCount,
    ).toBe(2);
  });
  it("never caps the reported positions or counts", () => {
    const result = aggregate(
      Array.from({ length: 26 }, (_, i) =>
        row({ occurrenceId: `gift:${i}`, reportedName: `Committee ${i}` }),
      ),
    );
    expect(result.positions).toHaveLength(26);
    expect(result.totalAmountCents).toBe(26 * 50_000);
  });
});
