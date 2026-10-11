import { describe, expect, it } from "vitest";

import { aggregateConnecticutDirectContributions } from "../../../src/pipeline/connecticutFinance/connecticutDirectContributionAggregator.js";
import type { ConnecticutEcrisArtifactRow } from "../../../src/pipeline/connecticutFinance/connecticutEcrisArtifactReader.js";

function receipt(overrides: Partial<ConnecticutEcrisArtifactRow> = {}): ConnecticutEcrisArtifactRow {
  return {
    Committee: "ACKERT FOR THE 8TH",
    "Contributor Name": "Carolyn Gerrity",
    District: "8",
    "Office Sought": "State Representative",
    Employer: "RTX-Pratt Whitney",
    "Receipt Type": "Itemized Contributions from Individuals",
    "Committee Type": "Candidate Committee",
    "Transaction Date": "03/31/2026",
    "File To State": "04/01/2026",
    Amount: "50.00",
    "Receipt State": "Original",
    Occupation: "Business Manager",
    ElectionYear: "2026",
    "Committee ID": "14376",
    "Candidate First Name": "Timothy",
    "Candidate Middle Intial": "J",
    "Candidate Last Name": "Ackert",
    ...overrides,
  };
}

describe("connecticutDirectContributionAggregator", () => {
  it("aggregates direct receipts by occupation and contribution size", () => {
    const result = aggregateConnecticutDirectContributions({
      committeeId: "14376",
      electionYear: 2026,
      sourceUrl: "https://seec.ct.gov/portal/ecris/CurPreYears",
      receiptRows: [
        receipt({ Amount: "100.00", Occupation: "Attorney" }),
        receipt({ Amount: "$250.00", Occupation: "Attorney" }),
        receipt({ Amount: "5,000.00", Occupation: "Teacher" }),
      ],
    });

    expect(result).toEqual({
      summary: {
        totalReceipts: 5350,
        sourceUrl: "https://seec.ct.gov/portal/ecris/CurPreYears",
      },
      directBreakdowns: [
        {
          categoryType: "occupation",
          categoryName: "Teacher",
          amount: 5000,
          contributorCount: 1,
          sourceUrl: "https://seec.ct.gov/portal/ecris/CurPreYears",
        },
        {
          categoryType: "occupation",
          categoryName: "Attorney",
          amount: 350,
          contributorCount: 2,
          sourceUrl: "https://seec.ct.gov/portal/ecris/CurPreYears",
        },
        {
          categoryType: "contribution_size",
          categoryName: "$5,000+",
          amount: 5000,
          contributorCount: 1,
          sourceUrl: "https://seec.ct.gov/portal/ecris/CurPreYears",
        },
        {
          categoryType: "contribution_size",
          categoryName: "$250-$499",
          amount: 250,
          contributorCount: 1,
          sourceUrl: "https://seec.ct.gov/portal/ecris/CurPreYears",
        },
        {
          categoryType: "contribution_size",
          categoryName: "$100-$249",
          amount: 100,
          contributorCount: 1,
          sourceUrl: "https://seec.ct.gov/portal/ecris/CurPreYears",
        },
      ],
      pacDonors: [],
      matchedReceiptRowCount: 3,
      includedReceiptRowCount: 3,
      skippedReceiptRowCount: 0,
    });
  });

  it("matches committee IDs case-insensitively and does not emit employer breakdowns", () => {
    const result = aggregateConnecticutDirectContributions({
      committeeId: " abc123 ",
      electionYear: 2026,
      receiptRows: [
        receipt({ "Committee ID": "ABC123", Amount: "300", Occupation: "Attorney", Employer: "Law Firm" }),
        receipt({ "Committee ID": "OTHER", Amount: "900", Occupation: "Doctor", Employer: "Hospital" }),
      ],
    });

    expect(result.summary.totalReceipts).toBe(300);
    expect(result.matchedReceiptRowCount).toBe(1);
    expect(result.includedReceiptRowCount).toBe(1);
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
    const result = aggregateConnecticutDirectContributions({
      committeeId: "14376",
      electionYear: 2026,
      receiptRows: [
        receipt({ Amount: "0.10", Occupation: "Engineer" }),
        receipt({ Amount: "0.20", Occupation: "Engineer" }),
      ],
    });

    expect(result.summary.totalReceipts).toBe(0.3);
    expect(result.directBreakdowns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ categoryType: "occupation", categoryName: "Engineer", amount: 0.3 }),
        expect.objectContaining({ categoryType: "contribution_size", categoryName: "$1-$99", amount: 0.3 }),
      ])
    );
  });

  it("uses ElectionYear instead of transaction-date heuristics", () => {
    const result = aggregateConnecticutDirectContributions({
      committeeId: "14376",
      electionYear: 2026,
      receiptRows: [
        receipt({ "Transaction Date": "01/01/2024", ElectionYear: "2026", Amount: "100" }),
        receipt({ "Transaction Date": "11/01/2026", ElectionYear: "2026", Amount: "200" }),
        receipt({ "Transaction Date": "01/01/2026", ElectionYear: "2024", Amount: "300" }),
      ],
    });

    expect(result.summary.totalReceipts).toBe(300);
    expect(result.matchedReceiptRowCount).toBe(3);
    expect(result.includedReceiptRowCount).toBe(2);
    expect(result.skippedReceiptRowCount).toBe(1);
  });

  it("skips malformed, zero, negative, wrong-year, and non-candidate-committee rows", () => {
    const result = aggregateConnecticutDirectContributions({
      committeeId: "14376",
      electionYear: 2026,
      receiptRows: [
        receipt({ Amount: "0" }),
        receipt({ Amount: "-10" }),
        receipt({ Amount: "not money" }),
        receipt({ ElectionYear: "not a year", Amount: "100" }),
        receipt({ "Committee Type": "Exploratory Committee", Amount: "500" }),
        receipt({ "Committee ID": "OTHER", Amount: "600" }),
        receipt({ Amount: "250" }),
      ],
    });

    expect(result.summary.totalReceipts).toBe(250);
    expect(result.matchedReceiptRowCount).toBe(6);
    expect(result.includedReceiptRowCount).toBe(1);
    expect(result.skippedReceiptRowCount).toBe(5);
  });

  it("limits occupation breakdowns without dropping contribution-size buckets", () => {
    const result = aggregateConnecticutDirectContributions({
      committeeId: "14376",
      electionYear: 2026,
      maxBreakdownsPerCategory: 1,
      receiptRows: [
        receipt({ Occupation: "Engineer", Amount: "100" }),
        receipt({ Occupation: "Teacher", Amount: "300" }),
        receipt({ Occupation: "Doctor", Amount: "600" }),
      ],
    });

    expect(result.directBreakdowns.filter((row) => row.categoryType === "occupation")).toEqual([
      expect.objectContaining({ categoryName: "Doctor", amount: 600 }),
    ]);
    expect(result.directBreakdowns.filter((row) => row.categoryType === "contribution_size")).toHaveLength(3);
  });

  it("validates required aggregation inputs", () => {
    expect(() =>
      aggregateConnecticutDirectContributions({
        committeeId: " ",
        electionYear: 2026,
        receiptRows: [],
      })
    ).toThrow("Connecticut committee id is required");

    expect(() =>
      aggregateConnecticutDirectContributions({
        committeeId: "14376",
        electionYear: 2007,
        receiptRows: [],
      })
    ).toThrow("Invalid Connecticut direct contribution aggregation election year");

    expect(() =>
      aggregateConnecticutDirectContributions({
        committeeId: "14376",
        electionYear: 2026,
        receiptRows: [],
        maxBreakdownsPerCategory: 0,
      })
    ).toThrow("Invalid Connecticut direct contribution aggregation maxBreakdownsPerCategory");
  });
});

describe("Connecticut declared committee donors", () => {
  it("merges C1 donors by registry or normalized name without changing receipt totals", () => {
    const result = aggregateConnecticutDirectContributions({
      committeeId: "14376", electionYear: 2026,
      committeeRegistry: [{ committeeId: "900", committeeName: "Workers & Teachers PAC", committeeType: "Political Committee" }],
      receiptRows: [
        receipt({ "Contributor Name": "workers and teachers PAC", "Receipt Type": "Contributions from Other Committees", Amount: "100.01" }),
        receipt({ "Contributor Name": "Workers & Teachers PAC", "Receipt Type": "Contributions from Other Committees", Amount: "50.02" }),
        receipt({ "Contributor Name": "Unknown Local Committee", "Receipt Type": "Contributions from Other Committees", Amount: "20" }),
        receipt({ "Contributor Name": "Individual PAC Surname", Amount: "30" }),
        receipt({ "Contributor Name": "Company PAC", "Receipt Type": "Loans", Amount: "10" }),
        receipt({ "Contributor Name": "Bad PAC", "Receipt Type": "Contributions from Other Committees", Amount: "-10" }),
        receipt({ "Contributor Name": "Old PAC", "Receipt Type": "Contributions from Other Committees", ElectionYear: "2024" }),
        receipt({ "Contributor Name": "Other recipient", "Committee ID": "555", "Receipt Type": "Contributions from Other Committees" }),
      ],
    });
    expect(result.summary.totalReceipts).toBe(210.03);
    expect(result.directBreakdowns.filter((b) => b.categoryType === "contribution_size").reduce((sum, b) => sum + b.amount, 0)).toBeCloseTo(210.03);
    expect(result.pacDonors).toEqual([
      { committeeId: "900", committeeName: "Workers & Teachers PAC", committeeType: "Political Committee", amount: 150.03, contributionCount: 2, sourceUrl: null },
      { committeeId: "UNKNOWN LOCAL COMMITTEE", committeeName: "Unknown Local Committee", committeeType: null, amount: 20, contributionCount: 1, sourceUrl: null },
    ]);
  });

  it("retains source-backed campaign transfers and does not assert an ambiguous registry identity", () => {
    const result = aggregateConnecticutDirectContributions({
      committeeId: "14376", electionYear: 2026,
      committeeRegistry: [
        { committeeId: "101", committeeName: "Khan 2026", committeeType: "Exploratory Committee" },
        { committeeId: "102", committeeName: "Shared Name", committeeType: "Candidate Committee" },
        { committeeId: "103", committeeName: "Shared Name", committeeType: "Exploratory Committee" },
      ],
      receiptRows: [
        receipt({ "Contributor Name": "Khan 2026", "Receipt Type": "Contributions from Other Committees", Amount: "20000" }),
        receipt({ "Contributor Name": "Shared Name", "Receipt Type": "Contributions from Other Committees", Amount: "50" }),
      ],
    });
    expect(result.pacDonors).toMatchObject([
      { committeeId: "101", committeeType: "Exploratory Committee", amount: 20000 },
      { committeeId: "SHARED NAME", committeeType: "Ambiguous Committee", amount: 50 },
    ]);
  });
});

it("recognizes a unique shortened Elect campaign name without overriding exact registrations", () => {
  const result = aggregateConnecticutDirectContributions({
    committeeId: "14376", electionYear: 2026,
    committeeRegistry: [
      { committeeId: "14172", committeeName: "Elect Cheryl 79", committeeType: "Candidate Committee" },
      { committeeId: "22", committeeName: "Elect Shared Name", committeeType: "Candidate Committee" },
      { committeeId: "23", committeeName: "Shared Name", committeeType: "Political Committee" },
    ],
    receiptRows: [
      receipt({ "Contributor Name": "Cheryl 79", "Receipt Type": "Contributions from Other Committees", Amount: "1981.25" }),
      receipt({ "Contributor Name": "Shared Name", "Receipt Type": "Contributions from Other Committees", Amount: "50" }),
    ],
  });
  expect(result.pacDonors).toMatchObject([
    { committeeId: "14172", committeeName: "Elect Cheryl 79", committeeType: "Candidate Committee", amount: 1981.25 },
    { committeeId: "23", committeeType: "Political Committee", amount: 50 },
  ]);
});
