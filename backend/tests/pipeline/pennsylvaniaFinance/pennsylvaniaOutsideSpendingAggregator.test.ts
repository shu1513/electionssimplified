import { describe, expect, it } from "vitest";

import {
  aggregatePennsylvaniaOutsideSpending,
  supportOpposeFromPennsylvaniaIndependentExpenditureRow,
} from "../../../src/pipeline/pennsylvaniaFinance/pennsylvaniaOutsideSpendingAggregator.js";
import type { PennsylvaniaCampaignFinanceFilerRow } from "../../../src/pipeline/pennsylvaniaFinance/pennsylvaniaCampaignFinanceReader.js";
import type { PennsylvaniaIndependentExpenditureRow } from "../../../src/pipeline/pennsylvaniaFinance/pennsylvaniaIndependentExpenditureClient.js";

function filerRow(overrides: Partial<PennsylvaniaCampaignFinanceFilerRow> = {}): PennsylvaniaCampaignFinanceFilerRow {
  return {
    CampaignfinanceID: "100",
    FILERID: "PAC123",
    EYEAR: "2026",
    SubmittedDate: "20260501",
    CYCLE: "2",
    AMMEND: "",
    TERMINATE: "",
    FILERTYPE: "4",
    FILERNAME: "PENNSYLVANIANS FOR ACTION",
    OFFICE: "",
    DISTRICT: "",
    PARTY: "",
    ADDRESS1: "",
    ADDRESS2: "",
    CITY: "",
    STATE: "PA",
    ZIPCODE: "",
    COUNTY: "",
    PHONE: "",
    BEGINNING: "",
    MONETARY: "",
    INKIND: "",
    ...overrides,
  };
}

function ieRow(overrides: Partial<PennsylvaniaIndependentExpenditureRow> = {}): PennsylvaniaIndependentExpenditureRow {
  return {
    CandidateQuestion: "Jane Doe",
    Organization: "Pennsylvanians for Action",
    Amount: "10000.00",
    IsSupported: true,
    IsOpposed: false,
    ElectionID: "2026G",
    ...overrides,
  };
}

describe("pennsylvaniaOutsideSpendingAggregator", () => {
  it("derives support and oppose from PA IE flags conservatively", () => {
    expect(supportOpposeFromPennsylvaniaIndependentExpenditureRow(ieRow({ IsSupported: "Y", IsOpposed: "N" }))).toBe(
      "support"
    );
    expect(supportOpposeFromPennsylvaniaIndependentExpenditureRow(ieRow({ IsSupported: false, IsOpposed: true }))).toBe(
      "oppose"
    );
    expect(supportOpposeFromPennsylvaniaIndependentExpenditureRow(ieRow({ IsSupported: true, IsOpposed: true }))).toBe(
      null
    );
    expect(supportOpposeFromPennsylvaniaIndependentExpenditureRow(ieRow({ IsSupported: false, IsOpposed: false }))).toBe(
      null
    );
  });

  it("groups PA independent expenditures by organization and stance", () => {
    const sourceUrl = "https://www.campaignfinanceonline.pa.gov/pages/IndependentExpenditures.aspx";
    const result = aggregatePennsylvaniaOutsideSpending({
      candidateName: "Jane Doe",
      electionYear: 2026,
      sourceUrl,
      electionId: "2026G",
      expenditureRows: [
        ieRow({ Amount: "$10,000.00" }),
        ieRow({ Amount: "2500", Organization: "Pennsylvanians   for Action" }),
        ieRow({
          Organization: "Future PA PAC",
          Amount: "5000",
          IsSupported: false,
          IsOpposed: true,
        }),
        ieRow({ CandidateQuestion: "John Roe", Amount: "999999" }),
        ieRow({ Amount: "-1" }),
      ],
    });

    expect(result).toEqual({
      summary: {
        supportTotal: 12500,
        opposeTotal: 5000,
        sourceUrl,
        electionId: "2026G",
        groups: [
          {
            groupId: "PENNSYLVANIANS FOR ACTION",
            groupName: "Pennsylvanians for Action",
            supportOppose: "support",
            amount: 12500,
            sourceUrl,
            electionId: "2026G",
          },
          {
            groupId: "FUTURE PA PAC",
            groupName: "Future PA PAC",
            supportOppose: "oppose",
            amount: 5000,
            sourceUrl,
            electionId: "2026G",
          },
        ],
      },
      matchedExpenditureRowCount: 4,
      includedExpenditureRowCount: 3,
      skippedExpenditureRowCount: 1,
    });
  });

  it("prefers a matched PA filer id for the outside group id", () => {
    const result = aggregatePennsylvaniaOutsideSpending({
      candidateName: "Jane Doe",
      electionYear: 2026,
      electionId: "2026G",
      expenditureRows: [ieRow()],
      filerRows: [filerRow()],
    });

    expect(result.summary?.groups).toEqual([
      {
        groupId: "PAC123",
        groupName: "Pennsylvanians for Action",
        supportOppose: "support",
        amount: 10000,
        sourceUrl: null,
        electionId: "2026G",
      },
    ]);
  });

  it("does not include rows with empty normalized group ids in totals", () => {
    const result = aggregatePennsylvaniaOutsideSpending({
      candidateName: "Jane Doe",
      electionYear: 2026,
      expenditureRows: [
        ieRow({ Organization: "!!!", Amount: "10000.00" }),
        ieRow({ Organization: "Pennsylvanians for Action", Amount: "2500.00" }),
      ],
    });

    expect(result).toMatchObject({
      summary: {
        supportTotal: 2500,
        opposeTotal: 0,
        groups: [
          {
            groupId: "PENNSYLVANIANS FOR ACTION",
            amount: 2500,
          },
        ],
      },
      matchedExpenditureRowCount: 2,
      includedExpenditureRowCount: 1,
      skippedExpenditureRowCount: 1,
    });
  });

  it("matches the live target wording and the candidate's formal first name", () => {
    const result = aggregatePennsylvaniaOutsideSpending({
      candidateName: "Josh Shapiro",
      electionYear: 2026,
      expenditureRows: [
        ieRow({
          CandidateQuestion: "JOSH SHAPIRO FOR GOVERNOR OF PENNSYLVANIA",
          Organization: "IBEW LOCAL 98 COMMITTEE ON POLITICAL EDUCATION",
          Amount: 444.96,
          IsSupported: "YES",
          IsOpposed: "NO",
        }),
        ieRow({ CandidateQuestion: "JOSHUA SHAPIRO", Organization: "KEYSTONE FUND", Amount: 100, IsSupported: "NO", IsOpposed: "YES" }),
        ieRow({ CandidateQuestion: "JOSH SHAPIRO", Organization: "KEYSTONE FUND", Amount: 50, IsSupported: "YES", IsOpposed: "NO" }),
      ],
    });

    expect(result.matchedExpenditureRowCount).toBe(3);
    expect(result.summary).toMatchObject({ supportTotal: 494.96, opposeTotal: 100 });
    expect(result.summary?.groups.map((group) => [group.groupName, group.supportOppose, group.amount])).toEqual([
      ["IBEW LOCAL 98 COMMITTEE ON POLITICAL EDUCATION", "support", 444.96],
      ["KEYSTONE FUND", "oppose", 100],
      ["KEYSTONE FUND", "support", 50],
    ]);
  });

  it("returns no summary when no candidate targets match", () => {
    const result = aggregatePennsylvaniaOutsideSpending({
      candidateName: "Jane Doe",
      electionYear: 2026,
      expenditureRows: [ieRow({ CandidateQuestion: "John Roe" })],
    });

    expect(result).toEqual({
      summary: null,
      matchedExpenditureRowCount: 0,
      includedExpenditureRowCount: 0,
      skippedExpenditureRowCount: 0,
    });
  });
});
