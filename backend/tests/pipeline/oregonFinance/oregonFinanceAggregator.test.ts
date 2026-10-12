import { describe, expect, it } from "vitest";

import {
  aggregateOregonDirectContributions,
  aggregateOregonOutsideGroupContributions,
  aggregateOregonOutsideSpending,
} from "../../../src/pipeline/oregonFinance/oregonFinanceAggregator.js";
import type { OregonOrestarTransactionDetail } from "../../../src/pipeline/oregonFinance/oregonOrestarParser.js";

function detail(overrides: Partial<OregonOrestarTransactionDetail> = {}): OregonOrestarTransactionDetail {
  return {
    transactionId: "4458653",
    transactionDate: "10/12/2022",
    transactionType: "Contribution",
    transactionSubType: "Cash Contribution",
    filedDate: "10/13/2022",
    amount: 10_000,
    aggregate: 10_000,
    processStatus: "Original",
    purpose: null,
    filerCommitteeName: "Friends of Tina Kotek",
    filerCommitteeId: "4792",
    addressBookType: "Individual",
    contributorPayeeName: "John Ramsbacher",
    address: "123 Main St",
    occupation: "Partner",
    employerName: "A&A Health Services LLC",
    outsideAssociations: [],
    sourceUrl: "https://secure.sos.state.or.us/orestar/gotoPublicTransactionDetail.do?tranRsn=4458653",
    ...overrides,
  };
}

describe("oregonFinanceAggregator", () => {
  it("aggregates candidate direct contribution occupations and contribution sizes", () => {
    const result = aggregateOregonDirectContributions({
      committeeId: "4792",
      electionYear: 2022,
      transactionDetails: [
        detail({ transactionId: "1", amount: 10_000, occupation: "Partner", contributorPayeeName: "John Ramsbacher" }),
        detail({ transactionId: "2", amount: 150, occupation: "Teacher", contributorPayeeName: "Pat Lane" }),
        detail({ transactionId: "3", amount: 300, occupation: "Teacher", contributorPayeeName: "Alex Reed" }),
        detail({ transactionId: "4", amount: 99.99, occupation: "Retired", contributorPayeeName: "Sam Dale" }),
        detail({ transactionId: "5", amount: 1_000, filerCommitteeId: "99999" }),
        // Prior cycle year: Oregon money is raised across [electionYear - 1,
        // electionYear], so this row must count toward the totals.
        detail({ transactionId: "6", amount: 1_000, transactionDate: "01/01/2021" }),
        detail({ transactionId: "7", amount: -25 }),
        detail({ transactionId: "8", transactionSubType: "Refund", amount: 25 }),
        // Outside the two-year cycle: stays excluded.
        detail({ transactionId: "9", amount: 5_000, transactionDate: "12/31/2020" }),
      ],
      sourceUrl: "https://secure.sos.state.or.us/orestar/gotoPublicTransactionSearch.do",
    });

    expect(result.summary).toEqual({
      directContributionTotal: 11_549.99,
      sourceUrl: "https://secure.sos.state.or.us/orestar/gotoPublicTransactionSearch.do",
    });
    expect(result.matchedContributionRowCount).toBe(8);
    expect(result.includedContributionRowCount).toBe(5);
    expect(result.skippedContributionRowCount).toBe(3);
    expect(result.directBreakdowns).toEqual([
      expect.objectContaining({ categoryType: "occupation", categoryName: "Partner", amount: 11_000, contributorCount: 1 }),
      expect.objectContaining({ categoryType: "occupation", categoryName: "Teacher", amount: 450, contributorCount: 2 }),
      expect.objectContaining({ categoryType: "occupation", categoryName: "Retired", amount: 99.99, contributorCount: 1 }),
      expect.objectContaining({ categoryType: "contribution_size", categoryName: "$5,000+", amount: 10_000, contributorCount: 1 }),
      expect.objectContaining({ categoryType: "contribution_size", categoryName: "$1,000-$4,999", amount: 1_000, contributorCount: 1 }),
      expect.objectContaining({ categoryType: "contribution_size", categoryName: "$250-$499", amount: 300, contributorCount: 1 }),
      expect.objectContaining({ categoryType: "contribution_size", categoryName: "$100-$249", amount: 150, contributorCount: 1 }),
      expect.objectContaining({ categoryType: "contribution_size", categoryName: "$1-$99", amount: 99.99, contributorCount: 1 }),
    ]);
  });

  it("aggregates outside spending by exact target committee ID and association amount", () => {
    const result = aggregateOregonOutsideSpending({
      candidateCommitteeId: "4792",
      electionYear: 2022,
      transactionDetails: [
        detail({
          transactionId: "4406263",
          transactionType: "Expenditure",
          transactionSubType: "Independent Expenditure",
          filerCommitteeName: "2022 Our Oregon Voter Guide",
          filerCommitteeId: "22333",
          amount: 200_000,
          contributorPayeeName: "Mail Vendor",
          outsideAssociations: [
            {
              associationType: "in_kind_expenditure",
              supportOppose: "support",
              targetCommitteeName: "Friends of Tina Kotek",
              targetCommitteeId: "4792",
              amount: 67_766.61,
              rawText: "In-Kind Expenditure - Friends of Tina Kotek (4792) - $67,766.61",
            },
            {
              associationType: "independent_expenditure",
              supportOppose: "support",
              targetCommitteeName: "Friends of Tina Kotek",
              targetCommitteeId: "4792",
              amount: 67_766.61,
              rawText: "Independent Expenditure in Support - Friends of Tina Kotek (4792) - $67,766.61",
            },
            {
              associationType: "independent_expenditure",
              supportOppose: "support",
              targetCommitteeName: "Friends of Tina Kotek",
              targetCommitteeId: null,
              amount: 50_000,
              rawText: "Independent Expenditure in Support - Friends of Tina Kotek - $50,000.00",
            },
            {
              associationType: "independent_expenditure",
              supportOppose: "oppose",
              targetCommitteeName: "Friends of Christine Drazan",
              targetCommitteeId: "22000",
              amount: 25_000,
              rawText: "Independent Expenditure in Opposition - Friends of Christine Drazan (22000) - $25,000.00",
            },
          ],
        }),
        detail({
          transactionId: "4406264",
          transactionType: "Expenditure",
          transactionSubType: "Independent Expenditure",
          filerCommitteeName: "Oregon Future PAC",
          filerCommitteeId: "55555",
          amount: 75_000,
          outsideAssociations: [
            {
              associationType: "independent_expenditure",
              supportOppose: "oppose",
              targetCommitteeName: "Friends of Tina Kotek",
              targetCommitteeId: "4792",
              amount: 75_000,
              rawText: "Independent Expenditure in Opposition - Friends of Tina Kotek (4792) - $75,000.00",
            },
          ],
        }),
      ],
    });

    expect(result.summary).toEqual({
      outsideSupportTotal: 67_766.61,
      outsideOpposeTotal: 75_000,
      sourceUrl: null,
    });
    expect(result.matchedExpenditureRowCount).toBe(2);
    expect(result.includedAssociationCount).toBe(2);
    expect(result.skippedAssociationCount).toBe(3);
    expect(result.outsideGroups).toEqual([
      expect.objectContaining({
        sponsorId: "55555",
        sponsorName: "Oregon Future PAC",
        supportOppose: "oppose",
        amount: 75_000,
      }),
      expect.objectContaining({
        sponsorId: "22333",
        sponsorName: "2022 Our Oregon Voter Guide",
        supportOppose: "support",
        amount: 67_766.61,
      }),
    ]);
  });

  it("uses a normalized sponsor committee name when ORESTAR omits the sponsor committee ID", () => {
    const result = aggregateOregonOutsideSpending({
      candidateCommitteeId: "4792",
      electionYear: 2022,
      transactionDetails: [
        detail({
          transactionId: "4406263",
          transactionType: "Expenditure",
          transactionSubType: "Independent Expenditure",
          filerCommitteeName: "2022 Our Oregon Voter Guide",
          filerCommitteeId: null,
          amount: 67_766.61,
          outsideAssociations: [
            {
              associationType: "independent_expenditure",
              supportOppose: "support",
              targetCommitteeName: "Friends of Tina Kotek",
              targetCommitteeId: "4792",
              amount: 67_766.61,
              rawText: "Independent Expenditure in Support - Friends of Tina Kotek (4792) - $67,766.61",
            },
          ],
        }),
      ],
    });

    expect(result.outsideGroups).toEqual([
      expect.objectContaining({
        sponsorId: "2022 OUR OREGON VOTER GUIDE",
        sponsorName: "2022 Our Oregon Voter Guide",
        supportOppose: "support",
        amount: 67_766.61,
      }),
    ]);
  });

  it("backtraces outside-group organization donors into donor and industry breakdowns", () => {
    const outsideGroups = aggregateOregonOutsideSpending({
      candidateCommitteeId: "4792",
      electionYear: 2022,
      transactionDetails: [
        detail({
          transactionId: "4406263",
          transactionType: "Expenditure",
          transactionSubType: "Independent Expenditure",
          filerCommitteeName: "2022 Our Oregon Voter Guide",
          filerCommitteeId: "22333",
          amount: 67_766.61,
          outsideAssociations: [
            {
              associationType: "independent_expenditure",
              supportOppose: "support",
              targetCommitteeName: "Friends of Tina Kotek",
              targetCommitteeId: "4792",
              amount: 67_766.61,
              rawText: "Independent Expenditure in Support - Friends of Tina Kotek (4792) - $67,766.61",
            },
          ],
        }),
      ],
    }).outsideGroups;

    const result = aggregateOregonOutsideGroupContributions({
      electionYear: 2022,
      outsideGroups,
      transactionDetails: [
        detail({
          transactionId: "5001",
          filerCommitteeName: "2022 Our Oregon Voter Guide",
          filerCommitteeId: "22333",
          contributorPayeeName: "SEIU Local 503",
          addressBookType: "Labor Organization",
          amount: 15_000,
        }),
        detail({
          transactionId: "5002",
          filerCommitteeName: "2022 Our Oregon Voter Guide",
          filerCommitteeId: "22333",
          contributorPayeeName: "SEIU Local 503",
          addressBookType: "Labor Organization",
          amount: 20_000,
        }),
        detail({
          transactionId: "5003",
          filerCommitteeName: "2022 Our Oregon Voter Guide",
          filerCommitteeId: "22333",
          contributorPayeeName: "Sierra Club",
          addressBookType: "Organization",
          amount: 30_000,
        }),
        detail({
          transactionId: "5004",
          filerCommitteeName: "2022 Our Oregon Voter Guide",
          filerCommitteeId: "22333",
          contributorPayeeName: "Jane Person",
          addressBookType: "Individual",
          amount: 50_000,
        }),
      ],
    });

    expect(result.matchedContributionRowCount).toBe(4);
    expect(result.includedContributionRowCount).toBe(3);
    expect(result.skippedContributionRowCount).toBe(1);
    expect(result.outsideGroupBreakdowns).toEqual([
      expect.objectContaining({
        sponsorId: "22333",
        sponsorName: "2022 Our Oregon Voter Guide",
        supportOppose: "support",
        categoryType: "donor",
        categoryName: "SEIU Local 503",
        amount: 35_000,
      }),
      expect.objectContaining({
        sponsorId: "22333",
        categoryType: "donor",
        categoryName: "Sierra Club",
        amount: 30_000,
      }),
      expect.objectContaining({
        sponsorId: "22333",
        categoryType: "industry",
        categoryName: "labor_unions",
        amount: 35_000,
        contributorCount: 1,
      }),
      expect.objectContaining({
        sponsorId: "22333",
        categoryType: "industry",
        categoryName: "environmental_group",
        amount: 30_000,
        contributorCount: 1,
      }),
    ]);
  });

  it("skips side-specific outside donor backtrace when a sponsor supports and opposes the candidate", () => {
    const result = aggregateOregonOutsideGroupContributions({
      electionYear: 2022,
      outsideGroups: [
        {
          sponsorId: "22333",
          sponsorName: "2022 Our Oregon Voter Guide",
          supportOppose: "support",
          amount: 67_766.61,
          sourceUrl: null,
        },
        {
          sponsorId: "22333",
          sponsorName: "2022 Our Oregon Voter Guide",
          supportOppose: "oppose",
          amount: 1_000,
          sourceUrl: null,
        },
      ],
      transactionDetails: [
        detail({
          filerCommitteeName: "2022 Our Oregon Voter Guide",
          filerCommitteeId: "22333",
          contributorPayeeName: "SEIU Local 503",
          addressBookType: "Labor Organization",
          amount: 25_000,
        }),
      ],
    });

    expect(result.matchedContributionRowCount).toBe(1);
    expect(result.includedContributionRowCount).toBe(0);
    expect(result.skippedContributionRowCount).toBe(1);
    expect(result.outsideGroupBreakdowns).toEqual([]);
  });

  it("validates aggregation inputs", () => {
    expect(() =>
      aggregateOregonDirectContributions({ committeeId: "", electionYear: 2022, transactionDetails: [] })
    ).toThrow("Oregon committee ID is required");
    expect(() =>
      aggregateOregonOutsideSpending({ candidateCommitteeId: "4792", electionYear: 1999, transactionDetails: [] })
    ).toThrow("Invalid Oregon finance aggregation election year");
    expect(() =>
      aggregateOregonOutsideGroupContributions({
        electionYear: 2022,
        outsideGroups: [],
        transactionDetails: [],
        minIndustryAmount: -1,
      })
    ).toThrow("minIndustryAmount");
  });
});
