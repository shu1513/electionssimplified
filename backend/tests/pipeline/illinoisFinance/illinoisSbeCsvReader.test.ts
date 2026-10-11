import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseIllinoisSbeContributionRecordsCsv,
  parseIllinoisSbeExpenditureRecordsCsv,
} from "../../../src/pipeline/illinoisFinance/illinoisSbeCsvReader.js";

const fixture = (name: string) => readFileSync(new URL(`../../fixtures/illinoisFinance/${name}`, import.meta.url), "utf8");
const modernContribution = fixture("contributions-modern.csv");
const modernExpenditure = fixture("expenditures-modern.csv");

// Public current export headers and economic/report fields; address fields removed.
describe("Illinois SBE validated modern discovery CSV", () => {
  it("retains the current Balkema PAC gift and exact report source fields", () => {
    expect(parseIllinoisSbeContributionRecordsCsv(modernContribution, "fixture://current-q2")).toEqual([
      expect.objectContaining({
        committeeId: "39503", contributorName: "Community BancPac", recipientCommitteeName: "Balkema for State Senate",
        amount: 1000, receivedDate: "6/12/2026", contributionType: "Transfer In", documentName: "Quarterly",
        reportingPeriodStart: "4/1/2026", reportingPeriodEnd: "6/30/2026", reportReceivedDate: "7/9/2026",
        sourceUrl: "fixture://current-q2", contributorAddress: null,
      }),
    ]);
    expect(parseIllinoisSbeContributionRecordsCsv(modernContribution.replace("39503,", "039503,"))[0].committeeId).toBe("039503");
  });

  it("retains the published Bailey expense without inventing a person target", () => {
    expect(parseIllinoisSbeExpenditureRecordsCsv(modernExpenditure)).toEqual([
      expect.objectContaining({
        committeeId: "615", payeeName: "Team Concept", amount: 66.5, expendedDate: "9/9/2026",
        expenditureType: "Independent Expenditure", expendingCommitteeName: "Kane County Republican Central Cmte",
        candidateName: "Bailey for Illinois", officeDistrict: "Illinois Governor", supportOppose: "support",
        purpose: "Printing", documentName: "Quarterly", reportingPeriodStart: "7/1/2026",
        reportingPeriodEnd: "9/30/2026", reportReceivedDate: "10/7/2026",
      }),
    ]);
  });

  it("continues to parse validated legacy fixtures and their empty table", () => {
    expect(parseIllinoisSbeContributionRecordsCsv(fixture("contributions.csv"))).toHaveLength(3);
    expect(parseIllinoisSbeExpenditureRecordsCsv(fixture("expenditures.csv"))).toHaveLength(3);
    expect(parseIllinoisSbeContributionRecordsCsv(fixture("contributions-empty.csv"))).toEqual([]);
  });

  it.each(["", "<html><body>No records</body></html>", "Amount,Unknown\n1000,x", modernContribution.replace("ContributedBy", "UnverifiedDonorAlias")])("rejects an unrecognized response rather than returning zero", (csv) => {
    expect(() => parseIllinoisSbeContributionRecordsCsv(csv)).toThrow("unrecognized schema");
  });

  it("does not accept a modern header-only response as complete empty coverage", () => {
    expect(() => parseIllinoisSbeContributionRecordsCsv(modernContribution.split("\n")[0] + "\n")).toThrow("header-only");
    expect(() => parseIllinoisSbeExpenditureRecordsCsv(modernExpenditure.split("\n")[0] + "\n")).toThrow("header-only");
  });

  it("rejects incomplete, extra and duplicate columns", () => {
    const [header, row] = modernContribution.trimEnd().split("\n");
    for (const csv of [header + "\n" + row.split(",").slice(0, -1).join(","), header + "\n" + row + ",extra", header.replace("Employer", "Occupation") + "\n" + row]) {
      expect(() => parseIllinoisSbeContributionRecordsCsv(csv)).toThrow();
    }
  });

  it.each(["garbage", "Infinity", "1e3", " ", "1.234", "1,00", "(bad)", "9007199254740992"])("rejects invalid money %s without silently dropping the receipt", (amount) => {
    const [header, row] = modernContribution.trimEnd().split("\n");
    const fields = row.split(","); fields[4] = amount.includes(",") ? `"${amount}"` : amount;
    expect(() => parseIllinoisSbeContributionRecordsCsv(header + "\n" + fields.join(","))).toThrow("invalid amount");
  });

  it("rejects invalid expenditure amounts and capped exports", () => {
    expect(() => parseIllinoisSbeExpenditureRecordsCsv(modernExpenditure.replace(",66.5,", ",garbage,"))).toThrow("invalid amount");
    const [header, row] = modernContribution.trimEnd().split("\n");
    expect(() => parseIllinoisSbeContributionRecordsCsv(header + "\n" + (row + "\n").repeat(25_000))).toThrow("capped");
    expect(() => parseIllinoisSbeContributionRecordsCsv(modernContribution + "The maximum number of records available for download is 25,000.")).toThrow("capped");
  });
});
