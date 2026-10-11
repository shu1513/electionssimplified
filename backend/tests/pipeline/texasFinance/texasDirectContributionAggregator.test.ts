import { describe, expect, it } from "vitest";

import {
  aggregateTexasDirectContributions,
  isTexasDirectDonorSupportReceipt,
  isTexasTotalReceipt,
  texasElectionCycleStartYear,
} from "../../../src/pipeline/texasFinance/texasDirectContributionAggregator.js";
import { TEXAS_TEC_FILER_COLUMNS, type TexasTecFilerRow, type TexasTecContributionRow } from "../../../src/pipeline/texasFinance/texasTecCsvDatabaseReader.js";

let fixtureReceiptId = 10000;

function contribution(overrides: Partial<TexasTecContributionRow> = {}): TexasTecContributionRow {
  return {
    recordType: "CONTRIB",
    formTypeCd: "COH",
    schedFormTypeCd: "A1",
    reportInfoIdent: "9001",
    receivedDt: "20261001",
    infoOnlyFlag: "",
    filerIdent: "00012345",
    filerTypeCd: "COH",
    filerName: "ABBOTT, GREG",
    contributionInfoId: String(fixtureReceiptId++),
    contributionDt: "20260915",
    contributionAmount: "250.00",
    contributionDescr: "",
    contributorPersentTypeCd: "INDIVIDUAL",
    contributorNameOrganization: "",
    contributorNameLast: "DOE",
    contributorNameFirst: "JANE",
    contributorStreetStateCd: "TX",
    contributorEmployer: "ACME",
    contributorOccupation: "Engineer",
    contributorJobTitle: "Engineer",
    ...overrides,
  };
}

describe("texasDirectContributionAggregator", () => {
  it("aggregates direct donor support by occupation and contribution size", () => {
    const sourceUrl = "https://prd.tecprd.ethicsefile.com/public/cf/public/TEC_CF_CSV.zip";
    const result = aggregateTexasDirectContributions({
      committeeId: "00012345",
      electionYear: 2026,
      sourceUrl,
      contributionRows: [
        contribution({ contributionAmount: "100.00", contributorOccupation: "Attorney" }),
        contribution({
          contributionInfoId: "1002",
          contributionAmount: "$250.00",
          contributorOccupation: "Attorney",
          contributorNameLast: "ROE",
        }),
        contribution({
          contributionInfoId: "1003",
          contributionAmount: "5,000.00",
          contributorOccupation: "Teacher",
          contributorNameLast: "SMITH",
        }),
      ],
    });

    expect(result).toEqual({
      summary: {
        totalReceipts: 5350,
        directContributionTotal: 5350,
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
    const result = aggregateTexasDirectContributions({
      committeeId: "00012345",
      electionYear: 2026,
      contributionRows: [
        contribution({ contributionInfoId: "R1", contributionAmount: "100", contributorOccupation: "Attorney" }),
        contribution({ contributionInfoId: "R2", contributionAmount: "200", contributorOccupation: "Attorney" }),
        contribution({
          contributionInfoId: "R3",
          contributionAmount: "300",
          contributorOccupation: "Attorney",
          contributorNameLast: "ROE",
        }),
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

  it("matches committee IDs case-insensitively and does not emit employer breakdowns", () => {
    const result = aggregateTexasDirectContributions({
      committeeId: " abc123 ",
      electionYear: 2026,
      contributionRows: [
        contribution({
          filerIdent: "ABC123",
          contributionAmount: "300",
          contributorOccupation: "Attorney",
          contributorEmployer: "Law Firm",
        }),
        contribution({
          filerIdent: "OTHER",
          contributionAmount: "900",
          contributorOccupation: "Doctor",
          contributorEmployer: "Hospital",
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

  it("aggregates direct receipts from additional safe receipt committee IDs", () => {
    const result = aggregateTexasDirectContributions({
      committeeId: "00012345",
      committeeIds: ["00051153"],
      electionYear: 2026,
      contributionRows: [
        contribution({
          filerIdent: "00012345",
          contributionAmount: "100",
          contributorOccupation: "Attorney",
        }),
        contribution({
          filerIdent: "00051153",
          filerTypeCd: "SPAC",
          contributionAmount: "900",
          contributorOccupation: "Engineer",
          contributorNameLast: "ROE",
        }),
        contribution({
          filerIdent: "00099991",
          contributionAmount: "5000",
          contributorOccupation: "Doctor",
        }),
      ],
    });

    expect(result.summary.totalReceipts).toBe(1000);
    expect(result.summary.directContributionTotal).toBe(1000);
    expect(result.matchedContributionRowCount).toBe(2);
    expect(result.directBreakdowns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ categoryType: "occupation", categoryName: "Engineer", amount: 900 }),
        expect.objectContaining({ categoryType: "occupation", categoryName: "Attorney", amount: 100 }),
      ])
    );
  });

  it("sums cents without floating-point drift", () => {
    const result = aggregateTexasDirectContributions({
      committeeId: "00012345",
      electionYear: 2026,
      contributionRows: [
        contribution({ contributionAmount: "0.10", contributorOccupation: "Engineer" }),
        contribution({ contributionAmount: "0.20", contributorOccupation: "Engineer" }),
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
    expect(texasElectionCycleStartYear(2026)).toBe(2025);

    const result = aggregateTexasDirectContributions({
      committeeId: "00012345",
      electionYear: 2026,
      contributionRows: [
        contribution({ contributionDt: "20241231", contributionAmount: "100" }),
        contribution({ contributionDt: "20250101", contributionAmount: "200" }),
        contribution({ contributionDt: "2026-11-01", contributionAmount: "300" }),
        contribution({ contributionDt: "1/1/2027", contributionAmount: "400" }),
      ],
    });

    expect(result.summary.totalReceipts).toBe(500);
    expect(result.summary.directContributionTotal).toBe(500);
    expect(result.matchedContributionRowCount).toBe(4);
    expect(result.includedContributionRowCount).toBe(2);
    expect(result.skippedContributionRowCount).toBe(2);
  });

  it("classifies Texas candidate-officeholder contribution rows as total and direct receipts", () => {
    const row = contribution({ filerTypeCd: "COH", contributionAmount: "250" });
    expect(isTexasTotalReceipt({ row, electionYear: 2026 })).toBe(true);
    expect(isTexasDirectDonorSupportReceipt({ row, electionYear: 2026 })).toBe(true);

    const excludedRows = [
      contribution({ filerTypeCd: "SPAC" }),
      contribution({ contributionAmount: "0" }),
      contribution({ contributionAmount: "-10" }),
      contribution({ contributionAmount: "not a number" }),
      contribution({ infoOnlyFlag: "Y" }),
      contribution({ contributionDt: "20240101" }),
    ];
    for (const excludedRow of excludedRows) {
      expect(isTexasTotalReceipt({ row: excludedRow, electionYear: 2026 })).toBe(false);
      expect(isTexasDirectDonorSupportReceipt({ row: excludedRow, electionYear: 2026 })).toBe(false);
    }
  });

  it("keeps total receipts aligned with direct donor support for Texas contribution rows", () => {
    const result = aggregateTexasDirectContributions({
      committeeId: "00012345",
      electionYear: 2026,
      contributionRows: [
        contribution({ contributionAmount: "1000", contributorOccupation: "Attorney" }),
        contribution({ contributionAmount: "5000", infoOnlyFlag: "Y", contributorOccupation: "Candidate" }),
      ],
    });

    expect(result.summary.totalReceipts).toBe(1000);
    expect(result.summary.directContributionTotal).toBe(1000);
    expect(result.directBreakdowns).toEqual([
      {
        categoryType: "occupation",
        categoryName: "Attorney",
        amount: 1000,
        contributorCount: 1,
        sourceUrl: null,
      },
      {
        categoryType: "contribution_size",
        categoryName: "$1,000-$4,999",
        amount: 1000,
        contributorCount: 1,
        sourceUrl: null,
      },
    ]);
    expect(result.skippedContributionRowCount).toBe(1);
  });

  it("skips invalid rows and blank occupations while keeping contribution-size totals", () => {
    const result = aggregateTexasDirectContributions({
      committeeId: "00012345",
      electionYear: 2026,
      contributionRows: [
        contribution({ contributionAmount: "250", contributorOccupation: "" }),
        contribution({ contributionAmount: "-100", contributorOccupation: "Attorney" }),
        contribution({ contributionAmount: "bad", contributorOccupation: "Doctor" }),
        contribution({ filerTypeCd: "SPAC", contributionAmount: "500", contributorOccupation: "Engineer" }),
        contribution({ contributionDt: "20240101", contributionAmount: "600", contributorOccupation: "Teacher" }),
      ],
    });

    expect(result.summary.totalReceipts).toBe(250);
    expect(result.summary.directContributionTotal).toBe(250);
    expect(result.includedContributionRowCount).toBe(1);
    expect(result.skippedContributionRowCount).toBe(4);
    expect(result.directBreakdowns).toEqual([
      {
        categoryType: "contribution_size",
        categoryName: "$250-$499",
        amount: 250,
        contributorCount: 1,
        sourceUrl: null,
      },
    ]);
  });

  it("limits occupation breakdowns without trimming contribution-size buckets", () => {
    const result = aggregateTexasDirectContributions({
      committeeId: "00012345",
      electionYear: 2026,
      maxBreakdownsPerCategory: 2,
      contributionRows: [
        contribution({ contributionAmount: "10", contributorOccupation: "A", contributorNameLast: "A" }),
        contribution({ contributionAmount: "100", contributorOccupation: "B", contributorNameLast: "B" }),
        contribution({ contributionAmount: "250", contributorOccupation: "C", contributorNameLast: "C" }),
      ],
    });

    expect(result.directBreakdowns.filter((row) => row.categoryType === "occupation")).toEqual([
      expect.objectContaining({ categoryName: "C", amount: 250 }),
      expect.objectContaining({ categoryName: "B", amount: 100 }),
    ]);
    expect(result.directBreakdowns.filter((row) => row.categoryType === "contribution_size")).toHaveLength(3);
  });

  it("rejects invalid inputs", () => {
    expect(() =>
      aggregateTexasDirectContributions({
        committeeId: " ",
        electionYear: 2026,
        contributionRows: [],
      })
    ).toThrow("Texas committee id is required");

    expect(() =>
      aggregateTexasDirectContributions({
        committeeId: "00012345",
        electionYear: 2013,
        contributionRows: [],
      })
    ).toThrow("Invalid Texas direct contribution aggregation election year");

    expect(() =>
      aggregateTexasDirectContributions({
        committeeId: "00012345",
        electionYear: 2026,
        contributionRows: [],
        maxBreakdownsPerCategory: 0,
      })
    ).toThrow("Invalid Texas direct contribution aggregation maxBreakdownsPerCategory");
  });
});

describe("Texas typed direct PAC donors", () => {
  function registry(overrides: Partial<TexasTecFilerRow> = {}): TexasTecFilerRow {
    return {
      ...Object.fromEntries(TEXAS_TEC_FILER_COLUMNS.map((field) => [field, ""])),
      filerIdent: "00015672", filerTypeCd: "MPAC", filerName: "Wholesale Beer Distributors of Texas PAC",
      filerNameOrganization: "Wholesale Beer Distributors of Texas PAC", committeeStatusCd: "ACTIVE",
      ...overrides,
    } as TexasTecFilerRow;
  }
  function pacReceipt(overrides: Partial<TexasTecContributionRow> = {}) {
    return contribution({
      contributionInfoId: "149504415", reportInfoIdent: "101030822", contributionDt: "20260401",
      contributionAmount: "2500", infoOnlyFlag: "N", contributorPersentTypeCd: "ENTITY",
      contributorNameOrganization: "Wholesale Beer Distributors of Texas PAC", contributorNameFirst: "",
      contributorNameLast: "", contributorOccupation: "", contributorEmployer: "",
      contributorOosPacFlag: "N", contributorPacFein: "", ...overrides,
    });
  }
  function aggregate(rows: TexasTecContributionRow[], committeeRegistryRows: TexasTecFilerRow[] | undefined = [registry()]) {
    return aggregateTexasDirectContributions({ committeeId: "00012345", electionYear: 2026,
      contributionRows: rows, committeeRegistryRows, sourceUrl: "official-source" });
  }

  it("identifies a unique typed MPAC while keeping raised and contribution-size totals unchanged", () => {
    const rows = [pacReceipt(), pacReceipt({ contributionInfoId: "149504416", contributionAmount: "1250" }), contribution()];
    const result = aggregate(rows);
    expect(result.summary).toEqual(aggregateTexasDirectContributions({ committeeId: "00012345", electionYear: 2026,
      contributionRows: rows, sourceUrl: "official-source" }).summary);
    expect(result.summary.totalReceipts).toBe(4000);
    expect(result.pacDonors).toEqual([{ committeeId: "00015672", committeeName: "Wholesale Beer Distributors of Texas PAC",
      committeeType: "MPAC", totalAmount: 3750, contributionCount: 2, sourceUrl: "official-source" }]);
    expect(result.directBreakdowns.filter((row) => row.categoryType === "contribution_size").reduce((sum, row) => sum + row.amount, 0)).toBe(4000);
  });

  it.each(["GPAC", "MPAC", "SPAC", "JSPC", "SCPC", "CEC", "MCEC", "PTYCORP", "LEG"])("accepts authoritative committee type %s", (type) => {
    expect(aggregate([pacReceipt()], [registry({ filerTypeCd: type, committeeStatusCd: "TERMINATED" })]).pacDonors)
      .toEqual([expect.objectContaining({ committeeType: type, totalAmount: 2500 })]);
  });

  it.each(["ASIFSPAC", "DCE", "COH", "JCOH", "SCC", "SPK", "ENTITY"])("excludes donor type %s", (type) => {
    expect(aggregate([pacReceipt()], [registry({ filerTypeCd: type })]).pacDonors).toEqual([]);
  });

  it("tests uniqueness before type or status filtering, including the same ID with different types", () => {
    for (const competing of [registry({ filerIdent: "00099999" }), registry({ filerTypeCd: "COH" }),
      registry({ filerIdent: "00099999", filerTypeCd: "COH", committeeStatusCd: "TERMINATED" })]) {
      expect(aggregate([pacReceipt()], [registry(), competing]).pacDonors).toEqual([]);
    }
    expect(aggregate([pacReceipt()], [registry(), registry()]).pacDonors).toHaveLength(1);
  });

  it("matches exact normalized full registry name/organization aliases and keeps generic entities unresolved", () => {
    const rows = [pacReceipt({ contributorNameOrganization: "  Wholesale Beer Distributors of Texas PAC!! " }),
      pacReceipt({ contributionInfoId: "other", contributorNameOrganization: "Unregistered PAC" }),
      contribution({ contributorEmployer: "Wholesale Beer Distributors of Texas PAC" })];
    expect(aggregate(rows, [registry({ filerName: "Another registered display name" })]).pacDonors)
      .toEqual([expect.objectContaining({ totalAmount: 2500, contributionCount: 1 })]);
  });

  it("uses explicit source OOS PAC flag plus valid FEC identity independently of ambiguous TEC names", () => {
    const result = aggregate([pacReceipt({ contributorNameOrganization: "DRIVE Committee",
      contributorOosPacFlag: "Y", contributorPacFein: "C00032979" })], [
        registry({ filerName: "DRIVE Committee", filerNameOrganization: "", filerIdent: "00032979" }),
        registry({ filerName: "DRIVE Committee", filerNameOrganization: "", filerIdent: "00099999" }),
      ]);
    expect(result.pacDonors).toEqual([{ committeeId: "fec:C00032979", committeeName: "DRIVE Committee",
      committeeType: "OOS_PAC", totalAmount: 2500, contributionCount: 1, sourceUrl: "official-source" }]);
  });

  it.each([
    { contributorOosPacFlag: "Y", contributorPacFein: "" },
    { contributorOosPacFlag: "Y", contributorPacFein: "123456789" },
    { contributorOosPacFlag: "Y", contributorPacFein: "C1234567" },
    { contributorOosPacFlag: "N", contributorPacFein: "C00032979" },
    { contributorOosPacFlag: "", contributorPacFein: "C00032979" },
    { contributorOosPacFlag: "YES", contributorPacFein: "C00032979" },
    { contributorOosPacFlag: "Y", contributorPacFein: "C00032979", contributorNameOrganization: "" },
  ])("keeps contradictory or incomplete OOS evidence unresolved: %j", (fields) => {
    expect(aggregate([pacReceipt(fields)]).pacDonors).toEqual([]);
  });

  it("preserves output when registry unavailable, but permits OOS identification with an explicitly complete empty registry", () => {
    const rows = [pacReceipt({ contributorOosPacFlag: "Y", contributorPacFein: "C00032979" })];
    const unavailable = aggregateTexasDirectContributions({ committeeId: "00012345", electionYear: 2026, contributionRows: rows });
    expect(unavailable).not.toHaveProperty("pacDonors");
    expect(aggregate(rows, []).pacDonors).toEqual([expect.objectContaining({ committeeId: "fec:C00032979" })]);
    expect(aggregate([pacReceipt()], []).pacDonors).toEqual([]);
  });

  it("does not classify excluded dates, superseded, negative, zero or wrong receiving committee receipts", () => {
    expect(aggregate([
      pacReceipt({ contributionDt: "20241231" }), pacReceipt({ infoOnlyFlag: "Y" }),
      pacReceipt({ contributionAmount: "-100" }), pacReceipt({ contributionAmount: "0" }),
      pacReceipt({ filerIdent: "other" }),
    ]).pacDonors).toEqual([]);
  });

  it("deduplicates current receipt IDs across report copies and counts two distinct gifts once each", () => {
    const row = pacReceipt();
    const result = aggregate([row, { ...row, reportInfoIdent: "101099999", receivedDt: "20261011" },
      pacReceipt({ contributionInfoId: "149504416" }), { ...row, infoOnlyFlag: "Y", contributionAmount: "9999" }]);
    expect(result.summary.totalReceipts).toBe(5000);
    expect(result.pacDonors).toEqual([expect.objectContaining({ totalAmount: 5000, contributionCount: 2 })]);
    expect(result.includedContributionRowCount).toBe(2);
  });

  it("rejects conflicting current receipt identities rather than choosing an amount or donor", () => {
    expect(() => aggregate([pacReceipt(), pacReceipt({ contributionAmount: "9999" })])).toThrow("Conflicting current Texas receipt");
    expect(() => aggregate([pacReceipt(), pacReceipt({ contributorNameOrganization: "Different donor" })])).toThrow("Conflicting current Texas receipt");
  });
});
