import { describe, expect, it } from "vitest";

import {
  aggregateDistrictOfColumbiaDirectContributions,
  districtOfColumbiaElectionCycleStartYear,
  isDistrictOfColumbiaDirectDonorSupportReceipt,
  isDistrictOfColumbiaTotalReceipt,
} from "../../../src/pipeline/districtOfColumbiaFinance/districtOfColumbiaDirectContributionAggregator.js";
import type { DistrictOfColumbiaOcfContributionRecord } from "../../../src/pipeline/districtOfColumbiaFinance/districtOfColumbiaOcfClient.js";

function contribution(
  overrides: Partial<DistrictOfColumbiaOcfContributionRecord> = {}
): DistrictOfColumbiaOcfContributionRecord {
  return {
    committeeName: "Bowser for Mayor",
    committeeKey: "BOWSER FOR MAYOR",
    contributorName: "Jane Doe",
    contributorType: "Individual",
    employer: "Acme",
    occupation: "Attorney",
    amount: 250,
    date: "01/10/2026",
    ...overrides,
  };
}

describe("districtOfColumbiaDirectContributionAggregator", () => {
  it("aggregates direct donor support by occupation and contribution size", () => {
    const sourceUrl = "https://efiling.ocf.dc.gov/DataDownload/Export?exportType=CSV";
    const result = aggregateDistrictOfColumbiaDirectContributions({
      committeeKey: "bowser for mayor",
      electionYear: 2026,
      sourceUrl,
      contributionRecords: [
        contribution({ amount: 100, occupation: "Attorney" }),
        contribution({ amount: 250, occupation: "Attorney", contributorName: "John Roe" }),
        contribution({ amount: 5_000, occupation: "Teacher", contributorName: "Pat Smith" }),
      ],
    });

    expect(result).toEqual({
      summary: {
        totalReceipts: 5350,
        directContributionTotal: 5350,
        publicFundsReceived: null,
        sourceUrl,
      },
      directBreakdowns: [
        {
          categoryType: "occupation",
          categoryName: "Teacher",
          amount: 5000,
          contributorCount: 1,
          sourceUrl,
        },
        {
          categoryType: "occupation",
          categoryName: "Attorney",
          amount: 350,
          contributorCount: 2,
          sourceUrl,
        },
        {
          categoryType: "contribution_size",
          categoryName: "$5,000+",
          amount: 5000,
          contributorCount: 1,
          sourceUrl,
        },
        {
          categoryType: "contribution_size",
          categoryName: "$250-$499",
          amount: 250,
          contributorCount: 1,
          sourceUrl,
        },
        {
          categoryType: "contribution_size",
          categoryName: "$100-$249",
          amount: 100,
          contributorCount: 1,
          sourceUrl,
        },
      ],
      matchedContributionRowCount: 3,
      includedContributionRowCount: 3,
      skippedContributionRowCount: 0,
    });
  });

  it("counts distinct contributors instead of contribution rows", () => {
    const result = aggregateDistrictOfColumbiaDirectContributions({
      committeeKey: "BOWSER FOR MAYOR",
      electionYear: 2026,
      contributionRecords: [
        contribution({ amount: 100, occupation: "Attorney", contributorName: "Jane Doe" }),
        contribution({ amount: 200, occupation: "Attorney", contributorName: "Jane Doe" }),
        contribution({ amount: 300, occupation: "Attorney", contributorName: "John Roe" }),
      ],
    });

    expect(result.directBreakdowns.filter((row) => row.categoryType === "occupation")).toEqual([
      expect.objectContaining({ categoryName: "Attorney", amount: 600, contributorCount: 2 }),
    ]);
    expect(result.directBreakdowns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          categoryType: "contribution_size",
          categoryName: "$100-$249",
          amount: 300,
          contributorCount: 1,
        }),
        expect.objectContaining({
          categoryType: "contribution_size",
          categoryName: "$250-$499",
          amount: 300,
          contributorCount: 1,
        }),
      ])
    );
  });

  it("matches committee keys case-insensitively and can derive them from committee name", () => {
    const result = aggregateDistrictOfColumbiaDirectContributions({
      committeeKey: " bowser for mayor ",
      electionYear: 2026,
      contributionRecords: [
        contribution({ committeeKey: undefined, committeeName: "BOWSER FOR MAYOR", amount: 300, occupation: "Attorney" }),
        contribution({ committeeName: "Other Committee", committeeKey: "OTHER COMMITTEE", amount: 900, occupation: "Doctor" }),
      ],
    });

    expect(result.summary.totalReceipts).toBe(300);
    expect(result.matchedContributionRowCount).toBe(1);
    expect(result.includedContributionRowCount).toBe(1);
    expect(result.directBreakdowns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ categoryType: "occupation", categoryName: "Attorney", amount: 300 }),
      ])
    );
    expect(
      result.directBreakdowns.every(
        (row) => row.categoryType === "occupation" || row.categoryType === "contribution_size"
      )
    ).toBe(true);
  });

  it("sums cents without floating-point drift", () => {
    const result = aggregateDistrictOfColumbiaDirectContributions({
      committeeKey: "BOWSER FOR MAYOR",
      electionYear: 2026,
      contributionRecords: [contribution({ amount: 0.1, occupation: "Engineer" }), contribution({ amount: 0.2, occupation: "Engineer" })],
    });

    expect(result.summary.totalReceipts).toBe(0.3);
    expect(result.summary.directContributionTotal).toBe(0.3);
    expect(result.directBreakdowns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ categoryType: "occupation", categoryName: "Engineer", amount: 0.3 }),
        expect.objectContaining({ categoryType: "contribution_size", categoryName: "$1-$99", amount: 0.3 }),
      ])
    );
  });

  it("filters to the two-year election cycle ending in the election year", () => {
    expect(districtOfColumbiaElectionCycleStartYear(2026)).toBe(2025);

    const result = aggregateDistrictOfColumbiaDirectContributions({
      committeeKey: "BOWSER FOR MAYOR",
      electionYear: 2026,
      contributionRecords: [
        contribution({ date: "12/31/2024", amount: 100 }),
        contribution({ date: "1/1/2025", amount: 200 }),
        contribution({ date: "2026-11-01", amount: 300 }),
        contribution({ date: "1/1/2027", amount: 400 }),
      ],
    });

    expect(result.summary.totalReceipts).toBe(500);
    expect(result.summary.directContributionTotal).toBe(500);
    expect(result.matchedContributionRowCount).toBe(4);
    expect(result.includedContributionRowCount).toBe(2);
    expect(result.skippedContributionRowCount).toBe(2);
  });

  it("uses explicit election_year when present", () => {
    const result = aggregateDistrictOfColumbiaDirectContributions({
      committeeKey: "BOWSER FOR MAYOR",
      electionYear: 2026,
      contributionRecords: [
        contribution({ date: "01/01/2024", electionYear: 2026, amount: 100 }),
        contribution({ date: "01/01/2026", electionYear: 2024, amount: 200 }),
        contribution({ date: undefined, electionYear: 2026, amount: 300 }),
      ],
    });

    expect(result.summary.totalReceipts).toBe(400);
    expect(result.includedContributionRowCount).toBe(2);
    expect(result.skippedContributionRowCount).toBe(1);
  });

  it("treats positive OCF contribution rows as total receipts and direct donor support", () => {
    const record = contribution({ amount: 250, date: "01/10/2026" });
    expect(isDistrictOfColumbiaTotalReceipt({ record, electionYear: 2026 })).toBe(true);
    expect(isDistrictOfColumbiaDirectDonorSupportReceipt({ record, electionYear: 2026 })).toBe(true);
    expect(isDistrictOfColumbiaTotalReceipt({ record: contribution({ amount: -10 }), electionYear: 2026 })).toBe(false);
    expect(isDistrictOfColumbiaTotalReceipt({ record: contribution({ date: "01/10/2024" }), electionYear: 2026 })).toBe(
      false
    );
  });

  it("skips zero, negative, missing-cycle, and wrong-committee rows", () => {
    const result = aggregateDistrictOfColumbiaDirectContributions({
      committeeKey: "BOWSER FOR MAYOR",
      electionYear: 2026,
      contributionRecords: [
        contribution({ amount: 0 }),
        contribution({ amount: -10 }),
        contribution({ date: undefined, electionYear: undefined, amount: 100 }),
        contribution({ committeeKey: "OTHER", amount: 600 }),
        contribution({ amount: 250 }),
      ],
    });

    expect(result.summary.totalReceipts).toBe(250);
    expect(result.summary.directContributionTotal).toBe(250);
    expect(result.matchedContributionRowCount).toBe(4);
    expect(result.includedContributionRowCount).toBe(1);
    expect(result.skippedContributionRowCount).toBe(3);
  });

  it("limits occupation breakdowns without dropping contribution-size buckets", () => {
    const result = aggregateDistrictOfColumbiaDirectContributions({
      committeeKey: "BOWSER FOR MAYOR",
      electionYear: 2026,
      maxBreakdownsPerCategory: 1,
      contributionRecords: [
        contribution({ occupation: "Engineer", amount: 100 }),
        contribution({ occupation: "Teacher", amount: 300 }),
        contribution({ occupation: "Doctor", amount: 600 }),
      ],
    });

    expect(result.directBreakdowns.filter((row) => row.categoryType === "occupation")).toEqual([
      expect.objectContaining({ categoryName: "Doctor", amount: 600 }),
    ]);
    expect(result.directBreakdowns.filter((row) => row.categoryType === "contribution_size")).toHaveLength(3);
  });

  it("validates required aggregation inputs", () => {
    expect(() =>
      aggregateDistrictOfColumbiaDirectContributions({
        committeeKey: " ",
        electionYear: 2026,
        contributionRecords: [],
      })
    ).toThrow("D.C. committee key is required");

    expect(() =>
      aggregateDistrictOfColumbiaDirectContributions({
        committeeKey: "BOWSER FOR MAYOR",
        electionYear: 1999,
        contributionRecords: [],
      })
    ).toThrow("Invalid D.C. direct contribution aggregation election year");

    expect(() =>
      aggregateDistrictOfColumbiaDirectContributions({
        committeeKey: "BOWSER FOR MAYOR",
        electionYear: 2026,
        contributionRecords: [],
        maxBreakdownsPerCategory: 0,
      })
    ).toThrow("Invalid D.C. direct contribution aggregation maxBreakdownsPerCategory");
  });
});
