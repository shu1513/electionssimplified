import { describe, expect, it } from "vitest";

import { DELAWARE_SUB_100_AGGREGATE_TYPE, type DelawareReceiptCsvRow } from "../../../src/pipeline/delawareFinance/delawareCfrsParsers.js";
import { reconcileDelawareCoversPerPeriod } from "../../../src/pipeline/delawareFinance/delawareCoverReconciliation.js";
import { aggregateDelawareDirectFinance } from "../../../src/pipeline/delawareFinance/delawareDirectContributionAggregator.js";
import type { DelawareCanonicalReport } from "../../../src/pipeline/delawareFinance/delawareReportInventory.js";

function receiptRow(input: {
  period?: string;
  amount: string;
  contributionType?: string;
  contributorType?: string;
  occupation?: string;
  name?: string;
}): DelawareReceiptCsvRow {
  return {
    "Contribution Date": "06/30/2026",
    "Contributor Name": input.name ?? "Jane Donor",
    "Contributor Address Line 1": "",
    "Contributor Address Line 2": "",
    "Contributor City": "",
    "Contributor State": "",
    "Contributor Zip": "19801",
    "Contributor Type": input.contributorType ?? "Individual",
    "Employer Name": "",
    "Employer Occupation": input.occupation ?? "",
    "Contribution Type": input.contributionType ?? "Check",
    "Contribution Amount": input.amount,
    CF_ID: "01005311",
    "Receiving Committee": "Example for Delaware",
    "Filing Period": input.period ?? "2026 2026  General Election 11/03/2026 30 Day",
    Office: "(Attorney General)",
    "Fixed Asset": "No",
  };
}

const WINDOW = new Set(["2026 30 Day General"]);

describe("aggregateDelawareDirectFinance", () => {
  it("counts the current Electronic Fund Transfer cash label without guessing refund semantics", () => {
    const rows = [
      receiptRow({ amount: "500.0000", contributionType: "Electronic Fund Transfer", occupation: "Teacher" }),
      receiptRow({ amount: "-100.0000", contributionType: "Electronic Fund Transfer" }),
      receiptRow({ amount: "25.0000", contributionType: "EFT" }),
      receiptRow({ amount: "9758.3800", contributionType: "Refund/Rebate", contributorType: "Business/Group/Organization" }),
    ];
    const result = aggregateDelawareDirectFinance({ receiptRows: rows, windowPeriodKeys: WINDOW });
    expect(result.directContributionCents).toBe(425_00);
    expect(result.windowRowTotalCents).toBe(10_183_38);
    expect(result.negativeOrZeroRowCount).toBe(1);
    expect(result.unrecognizedContributionTypes).toEqual(["Refund/Rebate"]);
    expect(result.unrecognizedContributionTypeRowCount).toBe(1);
    expect(result.breakdowns).toContainEqual({ categoryType: "occupation", categoryName: "Teacher", amount: 500, contributorCount: 1 });
    expect(rows[0]!["Contribution Type"]).toBe("Electronic Fund Transfer");
  });

  it("applies the fact-2 money model: loans/other income out, in-kind and aggregates in", () => {
    const result = aggregateDelawareDirectFinance({
      receiptRows: [
        receiptRow({ amount: "500.0000", occupation: "Attorney" }),
        receiptRow({ amount: "1200.0000", contributionType: "Credit Card", occupation: "Attorney", name: "Second Donor" }),
        receiptRow({ amount: "250.0000", contributionType: "In-Kind" }),
        receiptRow({ amount: "10000.0000", contributionType: "Candidate Loan", contributorType: "Self (Candidate)" }),
        receiptRow({ amount: "45.0000", contributionType: "Other Income" }),
        receiptRow({
          amount: "63.1800",
          contributionType: DELAWARE_SUB_100_AGGREGATE_TYPE,
          contributorType: DELAWARE_SUB_100_AGGREGATE_TYPE,
        }),
        // Refund: subtracts from the direct total, never enters buckets.
        receiptRow({ amount: "-100.0000", name: "Refunded Donor" }),
        // Out-of-window row is ignored entirely.
        receiptRow({ amount: "999.0000", period: "2025 Annual" }),
      ],
      windowPeriodKeys: WINDOW,
    });

    expect(result.windowRowTotalCents).toBe(500_00 + 1_200_00 + 250_00 + 10_000_00 + 45_00 + 63_18 - 100_00);
    expect(result.directContributionCents).toBe(500_00 + 1_200_00 + 250_00 + 63_18 - 100_00);
    expect(result.candidateLoanCents).toBe(10_000_00);
    expect(result.otherIncomeCents).toBe(45_00);
    expect(result.inKindCents).toBe(250_00);
    expect(result.sub100AggregateCents).toBe(63_18);
    expect(result.negativeOrZeroRowCount).toBe(1);
    expect(result.unrecognizedContributionTypeRowCount).toBe(0);

    const buckets = result.breakdowns.filter((entry) => entry.categoryType === "contribution_size");
    expect(buckets).toEqual([
      { categoryType: "contribution_size", categoryName: "$1,000-$4,999", amount: 1_200, contributorCount: 1 },
      { categoryType: "contribution_size", categoryName: "$500-$999", amount: 500, contributorCount: 1 },
    ]);
    const occupations = result.breakdowns.filter((entry) => entry.categoryType === "occupation");
    expect(occupations).toEqual([
      { categoryType: "occupation", categoryName: "Attorney", amount: 1_700, contributorCount: 2 },
    ]);
  });

  it("keeps undisclosed occupations out of the chart entirely and counts drift", () => {
    const result = aggregateDelawareDirectFinance({
      receiptRows: [
        receiptRow({ amount: "500.0000" }),
        receiptRow({ amount: "200.0000", contributorType: "Corporation/Partnership/Other Entity", occupation: "Ignored" }),
        receiptRow({ amount: "75.0000", contributionType: "Wire Transfer" }),
      ],
      windowPeriodKeys: WINDOW,
    });
    expect(result.breakdowns.filter((entry) => entry.categoryType === "occupation")).toEqual([]);
    expect(result.unrecognizedContributionTypeRowCount).toBe(1);
    expect(result.unrecognizedContributionTypes).toEqual(["Wire Transfer"]);
    // The unrecognized row is excluded from the direct total (the sync fails
    // closed on it anyway), but still moves the window row total.
    expect(result.directContributionCents).toBe(700_00);
    expect(result.windowRowTotalCents).toBe(775_00);
  });
});

describe("reconcileDelawareCoversPerPeriod", () => {
  const canonical: DelawareCanonicalReport[] = [
    {
      filingPeriodName: "2026 30 Day 2026 General Election 11/03/2026",
      periodKey: "2026 30 Day General",
      filingCalendarId: 1,
      documentVersion: 1,
      periodFrom: "2026-01-01",
      periodTo: "2026-10-05",
      beginningBalanceCents: 0,
      receiptsCents: 700_00,
      expendituresCents: 300_00,
      endingBalanceCents: 400_00,
    },
  ];

  it("matches when every period reconciles cent-exact on both sides", () => {
    const result = reconcileDelawareCoversPerPeriod({
      canonicalReports: canonical,
      receiptRows: [receiptRow({ amount: "500.0000" }), receiptRow({ amount: "200.0000" })],
      expenseRows: [
        {
          "Expenditure Date": "07/01/2026",
          "Payee Name": "Vendor",
          "Payee Address Line 1": "",
          "Payee Address Line 2": "",
          "Payee City": "",
          "Payee State": "",
          "Payee Zip": "",
          "Payee Type": "Business/Group/Organization",
          "Amount($)": "300.0000",
          "CF ID": "01005311",
          "Committee Name": "Example for Delaware",
          "Expense Category": "Media",
          "Expense Purpose": "Ads",
          "Expense Method": "Check",
          "Filing Period": "2026 30 Day General",
          "Fixed Asset": "No",
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.periods).toHaveLength(1);
  });

  it("flags a period whose CSV sum disagrees with the cover, and CSV periods with no cover", () => {
    const result = reconcileDelawareCoversPerPeriod({
      canonicalReports: canonical,
      receiptRows: [
        receiptRow({ amount: "500.0000" }),
        receiptRow({ amount: "999.0000", period: "2025 Annual" }),
      ],
      expenseRows: [],
    });
    expect(result.ok).toBe(false);
    expect(result.mismatchedPeriods.map((period) => period.periodKey).sort()).toEqual([
      "2025 Annual",
      "2026 30 Day General",
    ]);
  });
});
