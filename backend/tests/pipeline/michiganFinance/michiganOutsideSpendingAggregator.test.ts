import { describe, expect, it } from "vitest";

import {
  aggregateMichiganOutsideSpending,
  isMichiganIndependentExpenditureSchedule,
  supportOpposeFromMichiganSuppOpp,
} from "../../../src/pipeline/michiganFinance/michiganOutsideSpendingAggregator.js";
import type { MichiganMitnLegacyExpenditureRow } from "../../../src/pipeline/michiganFinance/michiganMitnLegacyRowTypes.js";

function expenditure(overrides: Partial<MichiganMitnLegacyExpenditureRow> = {}): MichiganMitnLegacyExpenditureRow {
  return {
    doc_seq_no: "100",
    doc_stmnt_year: "2022",
    doc_type_desc: "Post-General",
    com_legal_name: "GET MICHIGAN WORKING AGAIN (SUPERPAC)",
    common_name: "Get Michigan Working Again",
    cfr_com_id: "520012",
    com_type: "IND",
    schedule_desc: "Independent Expenditure",
    supp_opp: "2",
    can_or_ballot: "GRETCHEN WHITMER",
    _column_29: "GOVERNOR",
    amount: "863076.75",
    ...overrides,
  };
}

describe("michiganOutsideSpendingAggregator", () => {


  it("aggregates the union of verified target committees into one candidate snapshot", () => {
    const result = aggregateMichiganOutsideSpending({
      candidateName: "Joseph Fox", targetCommitteeNames: ["Joseph Fox for State Senator", "Friends of Joseph Fox"],
      officeScope: "state_upper", officeName: "State Senator", district: "33", electionYear: 2026,
      expenditureRows: [
        expenditure({ doc_stmnt_year: "2026", target_committee_name: "Joseph Fox for State Senator",
          target_office: "State Senate", amount: "100.00", supp_opp: "S" }),
        expenditure({ doc_stmnt_year: "2026", target_committee_name: "Friends of Joseph Fox",
          target_office: "State Senate", amount: "200.00", supp_opp: "S" }),
      ],
    });
    expect(result.summary).toMatchObject({ supportTotal: 300, opposeTotal: 0,
      groups: [expect.objectContaining({ amount: 300 })] });
  });

  it("matches modern exact verified committee targets with explicit office", () => {
    const result = aggregateMichiganOutsideSpending({
      candidateName: "Joseph Fox", targetCommitteeName: "Joseph Fox for State Senator",
      officeScope: "state_upper", officeName: "State Senator", district: "33", electionYear: 2026,
      expenditureRows: [
        expenditure({
          doc_stmnt_year: "2026", can_or_ballot: "Candidate",
          target_committee_name: "Joseph Fox for State Senator", target_office: "State Senate",
          _column_29: "", amount: "231165.00", supp_opp: "O",
        }),
        expenditure({
          doc_stmnt_year: "2026", target_committee_name: "Joseph Fox for State Senator",
          target_office: "State House", amount: "999999.00",
        }),
        expenditure({
          doc_stmnt_year: "2026", target_committee_name: "Other Joseph Fox Committee",
          target_office: "State Senate", amount: "999999.00",
        }),
      ],
    });
    expect(result.summary).toMatchObject({ supportTotal: 0, opposeTotal: 231165 });
    expect(result.includedExpenditureRowCount).toBe(1);
    expect(result.skippedExpenditureRowCount).toBe(1);
  });

  it("does not infer a modern target from a person name without registry validation", () => {
    const result = aggregateMichiganOutsideSpending({
      candidateName: "Joseph Fox", officeScope: "state_upper", officeName: "State Senator",
      district: "33", electionYear: 2026, expenditureRows: [
        expenditure({
          doc_stmnt_year: "2026", can_or_ballot: "Joseph Fox",
          target_committee_name: "Joseph Fox for State Senator", target_office: "State Senate",
          _column_29: "State Senate 33", amount: "231165.00",
        }),
      ],
    });
    expect(result.summary).toBeNull();
    expect(result.includedExpenditureRowCount).toBe(0);
  });

  it("maps Michigan support/oppose values conservatively", () => {
    expect(supportOpposeFromMichiganSuppOpp("1")).toBe("support");
    expect(supportOpposeFromMichiganSuppOpp("support")).toBe("support");
    expect(supportOpposeFromMichiganSuppOpp("for")).toBe("support");
    expect(supportOpposeFromMichiganSuppOpp("2")).toBe("oppose");
    expect(supportOpposeFromMichiganSuppOpp("oppose")).toBe("oppose");
    expect(supportOpposeFromMichiganSuppOpp("against")).toBe("oppose");
    expect(supportOpposeFromMichiganSuppOpp("assist")).toBeNull();
    expect(supportOpposeFromMichiganSuppOpp("")).toBeNull();
  });

  it("detects independent expenditure schedules only", () => {
    expect(isMichiganIndependentExpenditureSchedule("Independent Expenditure")).toBe(true);
    expect(isMichiganIndependentExpenditureSchedule("INDEPENDENT EXPENDITURES")).toBe(true);
    expect(isMichiganIndependentExpenditureSchedule("INDEPENDEN")).toBe(true);
    expect(isMichiganIndependentExpenditureSchedule("Direct Expenditure")).toBe(false);
    expect(isMichiganIndependentExpenditureSchedule("Contribution")).toBe(false);
  });

  it("aggregates exact candidate independent expenditures into support and oppose groups", () => {
    const sourceUrl = "https://www.michigan.gov/sos/example/2022_mi_cfr.7z";
    const result = aggregateMichiganOutsideSpending({
      candidateName: "Gretchen Whitmer",
      officeScope: "statewide",
      officeName: "Governor",
      electionYear: 2022,
      sourceUrl,
      expenditureRows: [
        expenditure(),
        expenditure({
          doc_seq_no: "101",
          cfr_com_id: "520012",
          amount: "100.25",
        }),
        expenditure({
          doc_seq_no: "102",
          cfr_com_id: "600001",
          com_legal_name: "WORKING FAMILIES FOR WHITMER",
          common_name: "Working Families for Whitmer",
          supp_opp: "1",
          amount: "200000.00",
        }),
        expenditure({
          doc_seq_no: "103",
          can_or_ballot: "OTHER PERSON",
          amount: "999999.00",
        }),
      ],
    });

    expect(result).toEqual({
      summary: {
        supportTotal: 200000,
        opposeTotal: 863177,
        groups: [
          {
            committeeId: "520012",
            committeeName: "GET MICHIGAN WORKING AGAIN (SUPERPAC)",
            supportOppose: "oppose",
            amount: 863177,
            sourceUrl,
          },
          {
            committeeId: "600001",
            committeeName: "WORKING FAMILIES FOR WHITMER",
            supportOppose: "support",
            amount: 200000,
            sourceUrl,
          },
        ],
        sourceUrl,
      },
      matchedExpenditureRowCount: 3,
      includedExpenditureRowCount: 3,
      skippedExpenditureRowCount: 0,
    });
  });

  it("skips rows missing explicit direction, independent-expenditure schedule, positive amount, or cycle year", () => {
    const result = aggregateMichiganOutsideSpending({
      candidateName: "Gretchen Whitmer",
      officeScope: "statewide",
      officeName: "Governor",
      electionYear: 2022,
      expenditureRows: [
        expenditure({ supp_opp: "" }),
        expenditure({ schedule_desc: "Direct Expenditure" }),
        expenditure({ amount: "0" }),
        expenditure({ amount: "-10" }),
        expenditure({ amount: "not a number" }),
        expenditure({ doc_stmnt_year: "2020" }),
        expenditure({ cfr_com_id: "" }),
        expenditure({ com_legal_name: "", common_name: "" }),
      ],
    });

    expect(result).toEqual({
      summary: null,
      matchedExpenditureRowCount: 8,
      includedExpenditureRowCount: 0,
      skippedExpenditureRowCount: 8,
    });
  });

  it("requires eligible office and legislative district before aggregation", () => {
    expect(
      aggregateMichiganOutsideSpending({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "State Treasurer",
        electionYear: 2022,
        expenditureRows: [expenditure({ can_or_ballot: "JANE DOE" })],
      })
    ).toEqual({
      summary: null,
      matchedExpenditureRowCount: 0,
      includedExpenditureRowCount: 0,
      skippedExpenditureRowCount: 0,
    });

    expect(
      aggregateMichiganOutsideSpending({
        candidateName: "Jane Doe",
        officeScope: "state_upper",
        officeName: "State Senator",
        electionYear: 2022,
        expenditureRows: [expenditure({ can_or_ballot: "JANE DOE" })],
      })
    ).toEqual({
      summary: null,
      matchedExpenditureRowCount: 0,
      includedExpenditureRowCount: 0,
      skippedExpenditureRowCount: 0,
    });
  });

  it("matches comma-form candidate names without substring matching", () => {
    const result = aggregateMichiganOutsideSpending({
      candidateName: "Gretchen Whitmer",
      officeScope: "statewide",
      officeName: "Governor",
      electionYear: 2022,
      expenditureRows: [
        expenditure({ can_or_ballot: "WHITMER, GRETCHEN" }),
        expenditure({ doc_seq_no: "other", can_or_ballot: "WHITMERSON, GRETCHEN" }),
      ],
    });

    expect(result.summary?.opposeTotal).toBe(863076.75);
    expect(result.matchedExpenditureRowCount).toBe(1);
    expect(result.includedExpenditureRowCount).toBe(1);
  });

  it("rejects an expenditure target whose middle name contradicts the candidate", () => {
    // Same office and cycle — only the middle evidence differs. Without the
    // middle gate this row was credited to the wrong Whitmer.
    expect(
      aggregateMichiganOutsideSpending({
        candidateName: "Gretchen A. Whitmer",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2022,
        expenditureRows: [expenditure({ can_or_ballot: "WHITMER, GRETCHEN B" })],
      })
    ).toMatchObject({ summary: null, matchedExpenditureRowCount: 0 });
  });

  it("accepts an initial that corroborates the full middle name", () => {
    expect(
      aggregateMichiganOutsideSpending({
        candidateName: "Gretchen A. Whitmer",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2022,
        expenditureRows: [expenditure({ can_or_ballot: "WHITMER, GRETCHEN ANN" })],
      })
    ).toMatchObject({ matchedExpenditureRowCount: 1, includedExpenditureRowCount: 1 });
  });

  it("still falls back to first+last when a side lacks middle info", () => {
    expect(
      aggregateMichiganOutsideSpending({
        candidateName: "Gretchen Whitmer",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2022,
        expenditureRows: [expenditure({ can_or_ballot: "WHITMER, GRETCHEN B" })],
      })
    ).toMatchObject({ matchedExpenditureRowCount: 1, includedExpenditureRowCount: 1 });
  });

  it("reads a bare trailing V as a middle initial, not a generational suffix", () => {
    // GENERATIONAL_SUFFIX_RANK deliberately excludes "V": a trailing "V" is far
    // more often a middle initial than a fifth generation, so the resolver's
    // normalizePersonName must keep it as middle evidence on EITHER side.
    const matchedRows = (candidateName: string, target: string): number =>
      aggregateMichiganOutsideSpending({
        candidateName,
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2022,
        expenditureRows: [expenditure({ can_or_ballot: target })],
      }).matchedExpenditureRowCount;

    expect(matchedRows("Gretchen V. Whitmer", "WHITMER, GRETCHEN B")).toBe(0);
    expect(matchedRows("Gretchen B. Whitmer", "WHITMER, GRETCHEN V")).toBe(0);
    expect(matchedRows("Gretchen V. Whitmer", "WHITMER, GRETCHEN V")).toBe(1);
    expect(matchedRows("Gretchen Whitmer", "WHITMER, GRETCHEN V")).toBe(1);
  });

  it("skips same-name outside spending for a different office", () => {
    const result = aggregateMichiganOutsideSpending({
      candidateName: "Gretchen Whitmer",
      officeScope: "statewide",
      officeName: "Governor",
      electionYear: 2022,
      expenditureRows: [expenditure({ _column_29: "STATE SENATE DISTRICT 7" })],
    });

    expect(result).toMatchObject({
      summary: null,
      matchedExpenditureRowCount: 1,
      includedExpenditureRowCount: 0,
      skippedExpenditureRowCount: 1,
    });
  });

  it("requires matching legislative districts for outside spending", () => {
    const result = aggregateMichiganOutsideSpending({
      candidateName: "Jane Doe",
      officeScope: "state_upper",
      officeName: "State Senator",
      district: "7",
      electionYear: 2022,
      expenditureRows: [expenditure({ can_or_ballot: "JANE DOE", _column_29: "STATE SENATE DISTRICT 8" })],
    });

    expect(result.summary).toBeNull();
    expect(result.matchedExpenditureRowCount).toBe(1);
    expect(result.includedExpenditureRowCount).toBe(0);
  });

  it("limits groups without changing summary totals", () => {
    const result = aggregateMichiganOutsideSpending({
      candidateName: "Gretchen Whitmer",
      officeScope: "statewide",
      officeName: "Governor",
      electionYear: 2022,
      maxGroups: 1,
      expenditureRows: [
        expenditure({ cfr_com_id: "1", com_legal_name: "A", amount: "100" }),
        expenditure({ cfr_com_id: "2", com_legal_name: "B", supp_opp: "1", amount: "200" }),
      ],
    });

    expect(result.summary?.supportTotal).toBe(200);
    expect(result.summary?.opposeTotal).toBe(100);
    expect(result.summary?.groups).toEqual([
      expect.objectContaining({ committeeId: "2", committeeName: "B", amount: 200 }),
    ]);
  });

  it("allows future election years and validates maxGroups", () => {
    expect(
      aggregateMichiganOutsideSpending({
        candidateName: "Gretchen Whitmer",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        expenditureRows: [],
      })
    ).toMatchObject({
      summary: null,
      matchedExpenditureRowCount: 0,
    });

    expect(() =>
      aggregateMichiganOutsideSpending({
        candidateName: "Gretchen Whitmer",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2022,
        maxGroups: 0,
        expenditureRows: [],
      })
    ).toThrow("maxGroups");
  });
});
