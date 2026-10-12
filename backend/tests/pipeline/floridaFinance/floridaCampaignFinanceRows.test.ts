import { describe, expect, it } from "vitest";

import {
  parseFloridaContributionFixedWidth,
  parseFloridaContributionTsv,
  type FloridaContributionFixedWidthField,
} from "../../../src/pipeline/floridaFinance/floridaCampaignFinanceRows.js";

describe("floridaCampaignFinanceRows", () => {
  it("parses Florida contribution TSV exports with quoted fields", () => {
    const rows = parseFloridaContributionTsv(
      [
        "Candidate/Committee\tDate\tAmount\tTyp\tContributor Name\tAddress\tCity\tState\tZip\tOccupation\tInkind Desc",
        '"Friends of Jane Doe"\t9/15/2026\t"$1,000.50"\tCHE\t"Smith, Pat"\t"1 Main St"\tTallahassee\tFL\t32301\tAttorney\t',
        '"Friends of Jane Doe"\t2026-09-16\t250\tCHE\t"Acme ""Energy"" LLC"\t2 Main St\tMiami\tFL\t33101\t\t',
      ].join("\n"),
      {
        electionCode: "20261103-GEN",
        sourceUrl: "https://dos.elections.myflorida.com/cgi-bin/contrib.exe",
      }
    );

    expect(rows).toEqual([
      {
        recipientName: "Friends of Jane Doe",
        contributionDate: "9/15/2026",
        amount: "$1,000.50",
        transactionType: "CHE",
        contributorName: "Smith, Pat",
        address: "1 Main St",
        city: "Tallahassee",
        state: "FL",
        zip: "32301",
        occupation: "Attorney",
        inKindDescription: "",
        electionCode: "20261103-GEN",
        sourceUrl: "https://dos.elections.myflorida.com/cgi-bin/contrib.exe",
      },
      expect.objectContaining({
        contributorName: 'Acme "Energy" LLC',
        amount: "250",
        occupation: "",
      }),
    ]);
  });

  it("rejects TSV exports without the required identifying columns", () => {
    expect(() => parseFloridaContributionTsv("Date\tAmount\n9/15/2026\t100")).toThrow(
      "Florida contribution TSV is missing required headers"
    );
  });

  it("retains the combined location from the actual nine-column public export", () => {
    const rows = parseFloridaContributionTsv([
      "Candidate/Committee\tDate\tAmount\tTyp\tContributor Name\tAddress\tCity State Zip\tOccupation\tInkind Desc",
      "Jane Doe\t08/03/2026\t1000.00\tCHE\tExample PAC\t1 Main St\tTALLAHASSEE FL 32301-1234\tPOLITICAL COMMITTEE\t",
      "Jane Doe\t08/04/2026\t100.00\tCHE\tDonor\t2 Main St\tTORONTO ON M5V 2T6\t\t",
    ].join("\n"));

    expect(rows[0]).toMatchObject({
      cityStateZip: "TALLAHASSEE FL 32301-1234",
      city: "", state: "", zip: "",
      contributorName: "Example PAC", transactionType: "CHE", amount: "1000.00",
    });
    expect(rows[1].cityStateZip).toBe("TORONTO ON M5V 2T6");
  });

  it("preserves signed refunds and identical occurrences with combined locations", () => {
    const gift = "Jane Doe\t06/17/2025\t1000.00\tCHE\tExample PAC\t1 Main St\tMIAMI FL 33101\t\t";
    const rows = parseFloridaContributionTsv([
      "Candidate/Committee\tDate\tAmount\tTyp\tContributor Name\tAddress\tCityStateZip\tOccupation\tInkind Desc",
      gift,
      gift,
      "Jane Doe\t03/30/2026\t-500.00\tREF\tExample PAC\t1 Main St\tMIAMI FL 33101\t\t",
    ].join("\n"));

    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual(rows[1]);
    expect(rows[2]).toMatchObject({
      amount: "-500.00", transactionType: "REF", cityStateZip: "MIAMI FL 33101",
    });
  });

  it("retains combined and separate source columns independently", () => {
    const [row] = parseFloridaContributionTsv([
      "Candidate/Committee\tDate\tAmount\tContributor Name\tCity\tState\tZip\tCity State Zip",
      "Jane Doe\t08/03/2026\t1000\tDonor\tMiami\tFL\t33101\tMIAMI FL 33101-1234",
    ].join("\n"));
    expect(row).toMatchObject({ city: "Miami", state: "FL", zip: "33101", cityStateZip: "MIAMI FL 33101-1234" });
  });

  it("parses Florida contribution fixed-width exports with supplied field positions", () => {
    const fixed = (value: string, width: number) => value.padEnd(width, " ");
    const fields: FloridaContributionFixedWidthField[] = [
      { key: "recipientName", start: 0, end: 24 },
      { key: "contributionDate", start: 24, end: 34 },
      { key: "amount", start: 34, end: 44 },
      { key: "transactionType", start: 44, end: 48 },
      { key: "contributorName", start: 48, end: 68 },
      { key: "address", start: 68, end: 83 },
      { key: "city", start: 83, end: 96 },
      { key: "state", start: 96, end: 98 },
      { key: "zip", start: 98, end: 103 },
      { key: "occupation", start: 103, end: 119 },
      { key: "inKindDescription", start: 119, end: 139 },
    ];
    const rows = parseFloridaContributionFixedWidth(
      [
        "HEADER LINE",
        [
          fixed("Friends of Jane Doe", 24),
          fixed("09/15/2026", 10),
          fixed("1000.50", 10),
          fixed("CHE", 4),
          fixed("Smith, Pat", 20),
          fixed("1 Main St", 15),
          fixed("Tallahassee", 13),
          fixed("FL", 2),
          fixed("32301", 5),
          fixed("Attorney", 16),
          fixed("", 20),
        ].join(""),
      ].join("\n"),
      {
        fields,
        headerLines: 1,
        electionCode: "20261103-GEN",
        sourceUrl: "https://dos.elections.myflorida.com/cgi-bin/contrib.exe",
      }
    );

    expect(rows).toEqual([
      {
        recipientName: "Friends of Jane Doe",
        contributionDate: "09/15/2026",
        amount: "1000.50",
        transactionType: "CHE",
        contributorName: "Smith, Pat",
        address: "1 Main St",
        city: "Tallahassee",
        state: "FL",
        zip: "32301",
        occupation: "Attorney",
        inKindDescription: "",
        electionCode: "20261103-GEN",
        sourceUrl: "https://dos.elections.myflorida.com/cgi-bin/contrib.exe",
      },
    ]);
  });

  it("rejects fixed-width exports without required field positions", () => {
    expect(() =>
      parseFloridaContributionFixedWidth("Friends of Jane Doe", {
        fields: [{ key: "recipientName", start: 0, end: 20 }],
      })
    ).toThrow("Florida contribution fixed-width export is missing required fields");
  });
});
