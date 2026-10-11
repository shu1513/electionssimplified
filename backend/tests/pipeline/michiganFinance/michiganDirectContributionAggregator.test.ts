import { describe, expect, it } from "vitest";

import {
  aggregateMichiganDirectContributions,
  isMichiganDirectDonorSupportReceipt,
  isMichiganLoanReceipt,
  isMichiganTotalReceipt,
  michiganElectionCycleStartYear,
} from "../../../src/pipeline/michiganFinance/michiganDirectContributionAggregator.js";
import type { MichiganMitnLegacyContributionRow } from "../../../src/pipeline/michiganFinance/michiganMitnLegacyRowTypes.js";
import type { MichiganMitnCommitteeSearchRow } from "../../../src/pipeline/michiganFinance/michiganMitnPublicSearchClient.js";

function contribution(
  overrides: Partial<MichiganMitnLegacyContributionRow> = {}
): MichiganMitnLegacyContributionRow {
  return {
    doc_seq_no: "100",
    page_no: "1",
    contribution_id: "200",
    cont_detail_id: "300",
    doc_stmnt_year: "2022",
    doc_type_desc: "Post-General",
    com_legal_name: "WHITMER FOR GOVERNOR",
    common_name: "Whitmer for Governor",
    cfr_com_id: "514456",
    com_type: "CAN",
    can_first_name: "GRETCHEN",
    can_last_name: "WHITMER",
    contribtype: "Individual",
    f_name: "JANE",
    l_name_or_org: "DOE",
    address: "1 Main",
    city: "Lansing",
    state: "MI",
    zip: "48901",
    occupation: "Attorney",
    employer: "Law Firm",
    received_date: "10/01/2022",
    amount: "250.00",
    aggregate: "250.00",
    extra_desc: "",
    ...overrides,
  };
}

describe("michiganDirectContributionAggregator", () => {

  it("treats padded numeric committee IDs as the same receiving and donor identity", () => {
    const input = {
      electionYear: 2022,
      contributionRows: [contribution({ f_name: "", l_name_or_org: "Registered Political PAC", amount: "12250.00" })],
      committeeRegistryRows: [{
        committeeId: "0508347", committeeName: "Registered Political PAC", committeeType: "Independent", status: "Active",
      }],
    };
    const canonical = aggregateMichiganDirectContributions({ ...input, committeeId: "514456" });
    const padded = aggregateMichiganDirectContributions({ ...input, committeeId: "0514456" });
    expect(padded).toEqual(canonical);
    expect(padded.summary.directContributionTotal).toBe(12250);
    expect(padded.pacDonors?.[0]).toMatchObject({ committeeId: "508347", amount: 12250 });
  });

  it("aggregates direct donor support by occupation and contribution size", () => {
    const sourceUrl = "https://www.michigan.gov/sos/example/2022_mi_cfr.7z";
    const result = aggregateMichiganDirectContributions({
      committeeId: "514456",
      electionYear: 2022,
      sourceUrl,
      contributionRows: [
        contribution({ amount: "100.00", occupation: "Attorney" }),
        contribution({
          cont_detail_id: "301",
          amount: "$250.00",
          occupation: "Attorney",
          l_name_or_org: "ROE",
        }),
        contribution({
          cont_detail_id: "302",
          amount: "5,000.00",
          occupation: "Teacher",
          l_name_or_org: "SMITH",
        }),
      ],
    });

    expect(result).toEqual({
      summary: {
        totalReceipts: 5350,
        directContributionTotal: 5350,
        candidateLoanTotal: 0,
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
    const result = aggregateMichiganDirectContributions({
      committeeId: "514456",
      electionYear: 2022,
      contributionRows: [
        contribution({ cont_detail_id: "R1", amount: "100", occupation: "Attorney" }),
        contribution({ cont_detail_id: "R2", amount: "200", occupation: "Attorney" }),
        contribution({
          cont_detail_id: "R3",
          amount: "300",
          occupation: "Attorney",
          l_name_or_org: "ROE",
        }),
      ],
    });

    expect(result.directBreakdowns.filter((row) => row.categoryType === "occupation")).toEqual([
      expect.objectContaining({ categoryName: "Attorney", amount: 600, contributorCount: 2 }),
    ]);
    expect(result.directBreakdowns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ categoryType: "contribution_size", categoryName: "$100-$249", amount: 300 }),
        expect.objectContaining({ categoryType: "contribution_size", categoryName: "$250-$499", amount: 300 }),
      ])
    );
  });

  it("matches committee IDs case-insensitively and does not emit employer breakdowns", () => {
    const result = aggregateMichiganDirectContributions({
      committeeId: " abc123 ",
      electionYear: 2022,
      contributionRows: [
        contribution({
          cfr_com_id: "ABC123",
          amount: "300",
          occupation: "Attorney",
          employer: "Law Firm",
        }),
        contribution({
          cfr_com_id: "OTHER",
          amount: "900",
          occupation: "Doctor",
          employer: "Hospital",
        }),
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
      result.directBreakdowns.every((row) => row.categoryType === "occupation" || row.categoryType === "contribution_size")
    ).toBe(true);
  });

  it("sums cents without floating-point drift", () => {
    const result = aggregateMichiganDirectContributions({
      committeeId: "514456",
      electionYear: 2022,
      contributionRows: [
        contribution({ amount: "0.10", occupation: "Engineer" }),
        contribution({ amount: "0.20", occupation: "Engineer" }),
      ],
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
    expect(michiganElectionCycleStartYear(2022)).toBe(2021);

    const result = aggregateMichiganDirectContributions({
      committeeId: "514456",
      electionYear: 2022,
      contributionRows: [
        contribution({ received_date: "12/31/2020", amount: "100" }),
        contribution({ received_date: "1/1/2021", amount: "200" }),
        contribution({ received_date: "2022-11-01", amount: "300" }),
        contribution({ received_date: "1/1/2023", amount: "400" }),
      ],
    });

    expect(result.summary.totalReceipts).toBe(500);
    expect(result.summary.directContributionTotal).toBe(500);
    expect(result.matchedContributionRowCount).toBe(4);
    expect(result.includedContributionRowCount).toBe(2);
    expect(result.skippedContributionRowCount).toBe(2);
  });

  it("keeps non-donor receipt types out of direct donor breakdowns", () => {
    const result = aggregateMichiganDirectContributions({
      committeeId: "514456",
      electionYear: 2022,
      contributionRows: [
        contribution({ amount: "500", contribtype: "Individual", occupation: "Attorney" }),
        contribution({ cont_detail_id: "loan", amount: "1000", contribtype: "Loan", occupation: "Business Owner" }),
        contribution({ cont_detail_id: "refund", amount: "250", contribtype: "Refund", occupation: "Accountant" }),
      ],
    });

    expect(result.summary).toEqual({
      totalReceipts: 1750,
      directContributionTotal: 500,
      candidateLoanTotal: 1000,
      sourceUrl: null,
    });
    expect(result.matchedContributionRowCount).toBe(3);
    expect(result.includedContributionRowCount).toBe(1);
    expect(result.skippedContributionRowCount).toBe(2);
    expect(result.directBreakdowns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ categoryType: "occupation", categoryName: "Attorney", amount: 500 }),
      ])
    );
    expect(result.directBreakdowns.some((row) => row.categoryName === "Business Owner")).toBe(false);
  });

  it("sums loan receipts separately using the real MiTN type strings", () => {
    const result = aggregateMichiganDirectContributions({
      committeeId: "514456",
      electionYear: 2022,
      contributionRows: [
        contribution({ amount: "500", contribtype: "Direct Contributions", occupation: "Attorney" }),
        contribution({ cont_detail_id: "l1", amount: "30000", contribtype: "Direct Contributions - Loan" }),
        contribution({ cont_detail_id: "l2", amount: "200", contribtype: "In-Kind Contributions - Loan" }),
        // Excluded from direct but NOT a loan: must never inflate the loan total.
        contribution({ cont_detail_id: "r1", amount: "250", contribtype: "Refund" }),
      ],
    });

    expect(result.summary.totalReceipts).toBe(30950);
    expect(result.summary.directContributionTotal).toBe(500);
    expect(result.summary.candidateLoanTotal).toBe(30200);

    expect(
      isMichiganLoanReceipt({
        row: contribution({ contribtype: "Direct Contributions - Loan" }),
        electionYear: 2022,
      })
    ).toBe(true);
    expect(
      isMichiganLoanReceipt({ row: contribution({ contribtype: "Refund" }), electionYear: 2022 })
    ).toBe(false);
    // A word-boundary match, not substring: LOAN inside another word must not count.
    expect(
      isMichiganLoanReceipt({ row: contribution({ contribtype: "Sloane Foundation" }), electionYear: 2022 })
    ).toBe(false);
  });

  it("classifies only positive same-cycle committee rows as total and direct receipts", () => {
    const valid = contribution({ amount: "250", contribtype: "Individual" });
    expect(isMichiganTotalReceipt({ row: valid, electionYear: 2022 })).toBe(true);
    expect(isMichiganDirectDonorSupportReceipt({ row: valid, electionYear: 2022 })).toBe(true);

    const excludedRows = [
      contribution({ cfr_com_id: "" }),
      contribution({ amount: "0" }),
      contribution({ amount: "-10" }),
      contribution({ amount: "not a number" }),
      contribution({ received_date: "2020-12-31" }),
      contribution({ contribtype: "Loan" }),
    ];
    for (const excludedRow of excludedRows) {
      if (excludedRow.contribtype === "Loan") {
        expect(isMichiganTotalReceipt({ row: excludedRow, electionYear: 2022 })).toBe(true);
        expect(isMichiganDirectDonorSupportReceipt({ row: excludedRow, electionYear: 2022 })).toBe(false);
      } else {
        expect(isMichiganTotalReceipt({ row: excludedRow, electionYear: 2022 })).toBe(false);
        expect(isMichiganDirectDonorSupportReceipt({ row: excludedRow, electionYear: 2022 })).toBe(false);
      }
    }
  });

  it("limits occupation breakdowns without dropping contribution-size buckets", () => {
    const result = aggregateMichiganDirectContributions({
      committeeId: "514456",
      electionYear: 2022,
      maxBreakdownsPerCategory: 1,
      contributionRows: [
        contribution({ occupation: "Engineer", amount: "100" }),
        contribution({ occupation: "Teacher", amount: "300" }),
        contribution({ occupation: "Doctor", amount: "600" }),
      ],
    });

    expect(result.directBreakdowns.filter((row) => row.categoryType === "occupation")).toEqual([
      expect.objectContaining({ categoryName: "Doctor", amount: 600 }),
    ]);
    expect(result.directBreakdowns.filter((row) => row.categoryType === "contribution_size")).toHaveLength(3);
  });

  it("validates required aggregation inputs", () => {
    expect(() =>
      aggregateMichiganDirectContributions({ committeeId: " ", electionYear: 2022, contributionRows: [] })
    ).toThrow("Michigan committee id is required");
    expect(() =>
      aggregateMichiganDirectContributions({ committeeId: "514456", electionYear: 2019, contributionRows: [] })
    ).toThrow("Invalid Michigan MiTN legacy archive year");
    expect(() =>
      aggregateMichiganDirectContributions({
        committeeId: "514456",
        electionYear: 2022,
        contributionRows: [],
        maxBreakdownsPerCategory: 0,
      })
    ).toThrow("maxBreakdownsPerCategory");
  });
});

describe("Michigan direct PAC donors", () => {
  const uawName = "UAW MICHIGAN VOLUNTARY POLITICAL ACTION COMMITTEE";
  const sourceUrl = "https://mi-boe.entellitrak.com/etk-mi-boe-prod/page.request.do?page=page.miboeCommitteeContributionAnalysisPublicSearch";
  const registry = (overrides: Partial<MichiganMitnCommitteeSearchRow> = {}): MichiganMitnCommitteeSearchRow => ({
    committeeId: "508347",
    committeeType: "Independent",
    committeeName: uawName,
    status: "Active",
    ...overrides,
  });
  const uawReceipt = (overrides: Partial<MichiganMitnLegacyContributionRow> = {}) => contribution({
    cfr_com_id: "521495",
    received_date: "07/18/2026",
    f_name: "",
    l_name_or_org: uawName,
    amount: "12250.00",
    // MiTN's itemized receipt type does not identify the contributor as a person.
    contribtype: "Individual",
    occupation: "",
    ...overrides,
  });

  it("matches the typed UAW registry identity for the official $12,250 receipt without changing raised or buckets", () => {
    const input = {
      committeeId: "521495",
      electionYear: 2026,
      sourceUrl,
      contributionRows: [uawReceipt()],
    };
    const original = aggregateMichiganDirectContributions(input);
    const result = aggregateMichiganDirectContributions({
      ...input,
      committeeRegistryRows: [
        registry(),
        registry({ committeeId: " 508347 ", committeeName: uawName.toLowerCase(), committeeType: " independent " }),
      ],
    });

    expect(result.pacDonors).toEqual([{
      committeeId: "508347",
      committeeName: uawName,
      committeeType: "Independent",
      amount: 12250,
      contributionCount: 1,
      sourceUrl,
    }]);
    const { pacDonors: _pacDonors, ...withoutDonors } = result;
    expect(withoutDonors).toEqual(original);
    expect(result.summary.directContributionTotal).toBe(12250);
    expect(result.directBreakdowns).toEqual([
      expect.objectContaining({ categoryType: "contribution_size", categoryName: "$5,000+", amount: 12250 }),
    ]);
  });

  it("preserves unavailable registry state but emits an empty collection for a verified empty registry", () => {
    const input = { committeeId: "521495", electionYear: 2026, contributionRows: [uawReceipt()] };
    const unavailable = aggregateMichiganDirectContributions(input);
    expect(unavailable.pacDonors).toBeUndefined();
    expect(Object.hasOwn(unavailable, "pacDonors")).toBe(false);
    expect(aggregateMichiganDirectContributions({ ...input, committeeRegistryRows: [] }).pacDonors).toEqual([]);
  });

  it.each([
    "Independent",
    "Independent Expenditure",
    "Political",
    "Caucus",
    "Qualifying Political Party",
    "State Political Party",
    "County Political Party",
    "District Political Party",
  ])("accepts the official %s committee type", (committeeType) => {
    const result = aggregateMichiganDirectContributions({
      committeeId: "521495",
      electionYear: 2026,
      contributionRows: [uawReceipt()],
      committeeRegistryRows: [registry({ committeeType })],
    });
    expect(result.pacDonors).toEqual([
      expect.objectContaining({ committeeId: "508347", committeeType, amount: 12250 }),
    ]);
  });

  it("excludes loans, refunds, invalid money, wrong recipients, and dates outside the existing cycle", () => {
    const result = aggregateMichiganDirectContributions({
      committeeId: "521495",
      electionYear: 2026,
      committeeRegistryRows: [registry()],
      contributionRows: [
        uawReceipt({ amount: "100", received_date: "2025-01-01" }),
        uawReceipt({ amount: "1000", contribtype: "Direct Contributions - Loan" }),
        uawReceipt({ amount: "500", contribtype: "Refund" }),
        uawReceipt({ amount: "400", contribtype: "Transfer" }),
        uawReceipt({ amount: "300", received_date: "2024-12-31" }),
        uawReceipt({ amount: "200", received_date: "2027-01-01" }),
        uawReceipt({ amount: "150", received_date: "" }),
        uawReceipt({ amount: "999", cfr_com_id: "OTHER" }),
        uawReceipt({ amount: "0" }),
        uawReceipt({ amount: "-10" }),
        uawReceipt({ amount: "bad" }),
      ],
    });
    expect(result.pacDonors).toEqual([
      expect.objectContaining({ amount: 100, contributionCount: 1 }),
    ]);
    expect(result.summary.directContributionTotal).toBe(100);
    expect(result.summary.candidateLoanTotal).toBe(1000);
    expect(result.includedContributionRowCount).toBe(1);
  });

  it("requires the full normalized receipt name and does not guess a PAC from organization-like names", () => {
    const result = aggregateMichiganDirectContributions({
      committeeId: "521495",
      electionYear: 2026,
      committeeRegistryRows: [
        registry({ committeeId: "PAC1", committeeName: "Michigan Good Government PAC" }),
        registry({ committeeId: "PAC2", committeeName: "Good Government PAC" }),
        registry({ committeeId: "CAN", committeeType: "Candidate", committeeName: "Jane Doe" }),
        registry({ committeeId: "BAL", committeeType: "Ballot Question", committeeName: "Local Ballot Committee" }),
        registry({ committeeId: "UNKNOWN", committeeType: "Unknown", committeeName: "Unknown PAC" }),
        registry({ committeeId: "SHORT", committeeType: "Qualifying", committeeName: "Short Type Party" }),
      ],
      contributionRows: [
        uawReceipt({ f_name: " Míchigan ", l_name_or_org: "good-government   PAC", amount: "125" }),
        uawReceipt({ f_name: "Jane", l_name_or_org: "Doe", amount: "500" }),
        uawReceipt({ l_name_or_org: "Local Ballot Committee", amount: "500" }),
        uawReceipt({ l_name_or_org: "Unknown PAC", amount: "500" }),
        uawReceipt({ l_name_or_org: "Short Type Party", amount: "500" }),
        uawReceipt({ l_name_or_org: "Unregistered Political Action Committee", amount: "500" }),
        uawReceipt({ l_name_or_org: "Another Organization LLC", amount: "500" }),
        uawReceipt({ f_name: "John", l_name_or_org: "Smith", amount: "500" }),
      ],
    });
    expect(result.pacDonors).toEqual([{
      committeeId: "PAC1",
      committeeName: "Michigan Good Government PAC",
      committeeType: "Independent",
      amount: 125,
      contributionCount: 1,
      sourceUrl: null,
    }]);
    expect(result.summary.directContributionTotal).toBe(3625);
  });

  it.each(["Independent", "Candidate", "Ballot Question"])(
    "withholds an ambiguous same-name registry identity including a %s collision",
    (committeeType) => {
      const result = aggregateMichiganDirectContributions({
        committeeId: "521495",
        electionYear: 2026,
        contributionRows: [uawReceipt()],
        committeeRegistryRows: [
          registry(),
          registry({ committeeId: "OTHER", committeeType, committeeName: uawName.toLowerCase() }),
          registry(),
        ],
      });
      expect(result.pacDonors).toEqual([]);
      expect(result.summary.directContributionTotal).toBe(12250);
    }
  );

  it("withholds conflicting registry types for the same ID and name", () => {
    expect(aggregateMichiganDirectContributions({
      committeeId: "521495",
      electionYear: 2026,
      contributionRows: [uawReceipt()],
      committeeRegistryRows: [registry(), registry({ committeeType: "Candidate" })],
    }).pacDonors).toEqual([]);
  });

  it("sums eligible receipt cents and counts receipts by committee ID, retaining existing occupation behavior", () => {
    const result = aggregateMichiganDirectContributions({
      committeeId: "521495",
      electionYear: 2026,
      contributionRows: [
        uawReceipt({ amount: "0.10", occupation: "Business Owner" }),
        uawReceipt({ amount: "0.20", occupation: "Business Owner", cont_detail_id: "second" }),
      ],
      committeeRegistryRows: [registry({ status: "Inactive" })],
    });
    expect(result.pacDonors).toEqual([
      expect.objectContaining({ amount: 0.3, contributionCount: 2 }),
    ]);
    expect(result.directBreakdowns).toContainEqual(
      expect.objectContaining({ categoryType: "occupation", categoryName: "Business Owner", amount: 0.3 })
    );
  });
});
