import { describe, expect, it, vi } from "vitest";

import {
  aggregateNewYorkDirectContributions,
  collectNewYorkDirectCampaign,
} from "../../../src/pipeline/newYorkFinance/newYorkDirectContributionAggregator.js";
import type { NewYorkCommitteeReceiptRow } from "../../../src/pipeline/newYorkFinance/newYorkSodaClient.js";

function receipt(overrides: Partial<NewYorkCommitteeReceiptRow>): NewYorkCommitteeReceiptRow {
  return {
    entityName: "",
    entityFirstName: "Jane",
    entityLastName: "Donor",
    contributorType: "Individual",
    scheduleAbbrev: "A",
    amount: 50,
    ...overrides,
  };
}

describe("aggregateNewYorkDirectContributions", () => {
  it("builds size, type, and org-donor breakdowns; lumps count toward totals only", () => {
    const result = aggregateNewYorkDirectContributions({
      receipts: [
        receipt({ amount: 50 }),
        receipt({ entityFirstName: "Alex", amount: 120 }),
        receipt({ entityFirstName: "Sam", amount: 5_000 }),
        // Organization donor (Schedule B, type often absent).
        receipt({
          entityName: "Uber Technologies Inc.",
          entityFirstName: "",
          entityLastName: "",
          contributorType: null,
          scheduleAbbrev: "B",
          amount: 41_200,
        }),
        receipt({
          entityName: "UBER  TECHNOLOGIES INC.",
          entityFirstName: "",
          entityLastName: "",
          contributorType: "Corporation",
          scheduleAbbrev: "B",
          amount: 8_800,
        }),
        // Unitemized lump: no identity, no type.
        receipt({ entityFirstName: "", entityLastName: "", contributorType: null, amount: 472_748 }),
      ],
    });

    expect(result.directContributionTotal).toBe(527_918);
    expect(result.receiptRowCount).toBe(6);
    expect(result.lumpRowCount).toBe(1);

    const byType = (categoryType: string) => result.breakdowns.filter((row) => row.categoryType === categoryType);
    expect(byType("contribution_size")).toEqual([
      expect.objectContaining({ categoryName: "$5,000+", amount: 55_000, contributorCount: 3 }),
      expect.objectContaining({ categoryName: "$100-$249", amount: 120, contributorCount: 1 }),
      expect.objectContaining({ categoryName: "$1-$99", amount: 50, contributorCount: 1 }),
    ]);
    expect(byType("contributor_type")).toEqual([
      expect.objectContaining({ categoryName: "Corporation", amount: 8_800 }),
      expect.objectContaining({ categoryName: "Individual", amount: 5_170, contributorCount: 3 }),
    ]);
    // Both Uber spellings merge under one donor.
    expect(byType("donor")).toEqual([
      expect.objectContaining({ categoryName: "Uber Technologies Inc.", amount: 50_000, contributorCount: 2 }),
    ]);
  });

  it("caps each category at the limit and rejects invalid limits", () => {
    const receipts = Array.from({ length: 4 }, (_unused, index) =>
      receipt({ entityFirstName: `Donor${index}`, amount: (index + 1) * 1_000 })
    );
    const result = aggregateNewYorkDirectContributions({ receipts, maxBreakdownsPerCategory: 1 });
    expect(result.breakdowns.filter((row) => row.categoryType === "contribution_size")).toHaveLength(1);
    expect(() => aggregateNewYorkDirectContributions({ receipts: [], maxBreakdownsPerCategory: 0 })).toThrow(
      "Invalid New York direct breakdown limit"
    );
  });
});

describe("collectNewYorkDirectCampaign", () => {
  it("fetches receipts and the expenditure total for the linked committee", async () => {
    const getCommitteeItemizedReceipts = vi.fn(async () => [receipt({ amount: 100 })]);
    const getCommitteeExpenditureTotal = vi.fn(async () => 3_706_000.56);

    const result = await collectNewYorkDirectCampaign(
      { filerId: "16851", electionYear: 2026, cycleYears: 4 },
      {},
      { getCommitteeItemizedReceipts, getCommitteeExpenditureTotal }
    );

    expect(getCommitteeItemizedReceipts).toHaveBeenCalledWith(
      { filerId: "16851", electionYear: 2026, cycleYears: 4 },
      {}
    );
    expect(getCommitteeExpenditureTotal).toHaveBeenCalledWith(
      { filerId: "16851", electionYear: 2026, cycleYears: 4 },
      {}
    );
    expect(result).toMatchObject({
      directContributionTotal: 100,
      totalDisbursements: 3_706_000.56,
      receiptRowCount: 1,
    });
  });
});


describe("explicit New York reported PAC cash positions", () => {
  const pac = (overrides: Partial<NewYorkCommitteeReceiptRow> = {}) => receipt({ entityName: "Example Registered PAC", entityFirstName: "", entityLastName: "", contributorType: "Political Action Committee (PAC)", scheduleAbbrev: "C", amount: 100, ...overrides });
  it("returns typed reported-name identities and retains equal gifts with distinct source IDs", () => {
    const result = aggregateNewYorkDirectContributions({ receipts: [pac({ filingTransId: "1", transNumber: "T1" }), pac({ filingTransId: "2", transNumber: "T2" })] });
    expect(result.pacDonors).toEqual([{ committeeId: "reported:EXAMPLE REGISTERED PAC", committeeName: "Example Registered PAC", sourceReportedClass: "Political Action Committee (PAC)", amount: 200, contributionCount: 2, sourceUrl: "https://data.ny.gov/d/e9ss-239a" }]);
    expect(result.directContributionTotal).toBe(200); // No PAC addition on top of Raised.
    expect(result.pacDonors[0]).not.toHaveProperty("registeredFilerId");
    expect(result).not.toHaveProperty("refundNet");
    expect(result).not.toHaveProperty("latestVersion");
  });
  it("aggregates every explicit PAC receipt independently of generic donor display caps", () => {
    const inputs = [pac({ entityName: "Example PAC A", amount: 25 }), pac({ entityName: "Example PAC B", amount: 50 }), pac({ entityName: "Example PAC C", amount: 75 }), receipt({ entityName: "Example Corporation", entityFirstName: "", entityLastName: "", contributorType: "Corporation", scheduleAbbrev: "B", amount: 10000 })];
    const result = aggregateNewYorkDirectContributions({ receipts: inputs, maxBreakdownsPerCategory: 1 });
    expect(result.breakdowns.filter(row => row.categoryType === "donor")).toHaveLength(1);
    expect(result.pacDonors).toHaveLength(3);
    expect(result.pacDonors.reduce((sum,row) => sum + row.amount,0)).toBe(150);
    expect(result.pacDonors.reduce((sum,row) => sum + row.contributionCount,0)).toBe(3);
  });
  it("normalizes only source-name case/whitespace and retains deterministic original spelling", () => {
    const inputs = [pac({ entityName: "Example  PAC", amount: 0.29 }), pac({ entityName: "EXAMPLE PAC", amount: 0.01 })];
    const first = aggregateNewYorkDirectContributions({ receipts: inputs }).pacDonors;
    expect(first).toEqual(aggregateNewYorkDirectContributions({ receipts: [...inputs].reverse() }).pacDonors);
    expect(first[0]).toMatchObject({ committeeId: "reported:EXAMPLE PAC", committeeName: "EXAMPLE PAC", amount: 0.3, contributionCount: 2 });
    const punctuation = aggregateNewYorkDirectContributions({ receipts: [pac({ entityName: "Example-PAC" }), pac({ entityName: "Example PAC" })] }).pacDonors;
    expect(punctuation).toHaveLength(2);
  });
  it.each(["PAC", "Political Committee", "Corporation", "Union", "Association", "Individual", "Candidate/Candidate Spouse", null])("does not promote source class %s by a PAC-looking name", contributorType => {
    expect(aggregateNewYorkDirectContributions({ receipts: [pac({ contributorType })] }).pacDonors).toEqual([]);
  });
  it.each(["A", "B", "C"])("includes exact source PAC class in cash schedule %s", scheduleAbbrev => {
    expect(aggregateNewYorkDirectContributions({ receipts: [pac({ scheduleAbbrev })] }).pacDonors[0].amount).toBe(100);
  });
  it("excludes in-kind and refund schedules instead of inflating cash or guessing nets", () => {
    const result = aggregateNewYorkDirectContributions({ receipts: [pac({ amount: 100 }), pac({ scheduleAbbrev: "D", amount: 50 }), pac({ scheduleAbbrev: "M", amount: 25 })] });
    expect(result.pacDonors[0]).toMatchObject({ amount: 100, contributionCount: 1 });
    // This source-only supplement does not redefine the existing all-receipt total.
    expect(result.directContributionTotal).toBe(175);
  });
  it("uses the explicit source class rather than the generic organization-shape heuristic", () => {
    const result = aggregateNewYorkDirectContributions({ receipts: [pac({ entityFirstName: "Source structured field", entityLastName: "Source structured field" })] });
    expect(result.pacDonors[0].amount).toBe(100);
    expect(result.breakdowns.filter(row => row.categoryType === "donor")).toEqual([]);
  });
  it.each(["filingTransId", "transNumber"] as const)("refuses repeated present %s rather than deduplicating or guessing editions", field => {
    const inputs = [pac({ filingTransId: "1", transNumber: "T1" }), pac({ filingTransId: "2", transNumber: "T2", [field]: field === "filingTransId" ? "1" : "T1" })];
    expect(() => aggregateNewYorkDirectContributions({ receipts: inputs })).toThrow("repeated source transaction identity");
  });
  it("refuses duplicate IDs across different reported PAC names too", () => {
    expect(() => aggregateNewYorkDirectContributions({ receipts: [pac({ filingTransId: "1" }), pac({ entityName: "Different PAC", filingTransId: "1" })] })).toThrow("repeated source transaction identity");
  });
  it("supports legacy synthetic receipts with no transaction keys without economic deduplication", () => {
    expect(aggregateNewYorkDirectContributions({ receipts: [pac(), pac()] }).pacDonors[0]).toMatchObject({ amount: 200, contributionCount: 2 });
  });
  it("refuses unnamed, malformed identity or unsafe exact PAC source cash", () => {
    expect(() => aggregateNewYorkDirectContributions({ receipts: [pac({ entityName: "  " })] })).toThrow("reported donor name");
    expect(() => aggregateNewYorkDirectContributions({ receipts: [pac({ filingTransId: " " })] })).toThrow("invalid source transaction identity");
    for (const amount of [-1, NaN, Infinity, 0.001, 90071992547409.92]) expect(() => aggregateNewYorkDirectContributions({ receipts: [pac({ amount })] })).toThrow("safe positive exact-cent");
    expect(aggregateNewYorkDirectContributions({ receipts: [pac({ amount: 0 })] }).pacDonors).toEqual([]);
  });
  it("passes uncapped PAC output through normal direct collection without extra acquisitions", async () => {
    const getCommitteeItemizedReceipts = vi.fn(async () => [pac({ filingTransId: "1", transNumber: "T1" })]);
    const getCommitteeExpenditureTotal = vi.fn(async () => 0);
    const result = await collectNewYorkDirectCampaign({ filerId: "123", electionYear: 2026, cycleYears: 2, maxBreakdownsPerCategory: 1 }, {}, { getCommitteeItemizedReceipts, getCommitteeExpenditureTotal });
    expect(result.pacDonors[0]).toMatchObject({ amount: 100, contributionCount: 1 });
    expect(getCommitteeItemizedReceipts).toHaveBeenCalledTimes(1);
    expect(getCommitteeExpenditureTotal).toHaveBeenCalledTimes(1);
  });
});
