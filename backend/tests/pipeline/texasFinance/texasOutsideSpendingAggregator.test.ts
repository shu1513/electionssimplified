import { describe, expect, it } from "vitest";

import {
  aggregateTexasOutsideSpending,
  supportOpposeFromTexasSpacPosition,
  type TexasOutsideSpendingAggregationInput,
} from "../../../src/pipeline/texasFinance/texasOutsideSpendingAggregator.js";
import type {
  TexasTecCandidateRow,
  TexasTecExpenditureRow,
  TexasTecSpacRow,
  TexasTecPurposeRow,
} from "../../../src/pipeline/texasFinance/texasTecCsvDatabaseReader.js";

function candidate(overrides: Partial<TexasTecCandidateRow> = {}): TexasTecCandidateRow {
  return {
    recordType: "CAND",
    reportInfoIdent: "R1",
    infoOnlyFlag: "N",
    formTypeCd: "SPAC",
    schedFormTypeCd: "F1",
    politicalExpendCd: "",
    filerIdent: "7001",
    filerTypeCd: "SPAC",
    filerName: "Texans for Example",
    expendInfoId: "E1",
    expendDt: "20261015",
    expendAmount: "70000.00",
    expendDescr: "Direct campaign expenditure",
    candidatePersentTypeCd: "INDIVIDUAL",
    candidateNameOrganization: "",
    candidateNameLast: "ABBOTT",
    candidateNameFirst: "GREG",
    candidateSeekOfficeCd: "GOVERNOR",
    candidateSeekOfficeDistrict: "",
    candidateSeekOfficePlace: "",
    candidateSeekOfficeDescr: "Governor",
    candidateSeekOfficeCountyCd: "",
    candidateSeekOfficeCountyDescr: "",
    ...overrides,
  };
}

function expenditure(overrides: Partial<TexasTecExpenditureRow> = {}): TexasTecExpenditureRow {
  return {
    recordType: "EXPEND",
    formTypeCd: "SPAC",
    schedFormTypeCd: "F1",
    reportInfoIdent: "R1",
    receivedDt: "20261016",
    infoOnlyFlag: "N",
    filerIdent: "7001",
    filerTypeCd: "SPAC",
    filerName: "Texans for Example",
    expendInfoId: "E1",
    expendDt: "20261015",
    expendAmount: "70000.00",
    expendDescr: "Direct campaign expenditure",
    expendCatCd: "ADV",
    expendCatDescr: "Advertising",
    politicalExpendCd: "DIRECT",
    payeePersentTypeCd: "ENTITY",
    payeeNameOrganization: "Vendor LLC",
    payeeNameLast: "",
    payeeNameFirst: "",
    ...overrides,
  };
}

function spac(overrides: Partial<TexasTecSpacRow> = {}): TexasTecSpacRow {
  return {
    recordType: "SPAC",
    spacFilerIdent: "7001",
    spacFilerTypeCd: "SPAC",
    spacFilerName: "Texans for Example",
    spacFilerNameShort: "",
    spacCommitteeStatusCd: "ACTIVE",
    spacPositionCd: "SUPPORT",
    candidateFilerIdent: "00012345",
    candidateFilerTypeCd: "COH",
    candidateFilerName: "ABBOTT, GREG",
    candidateFilerpersStatusCd: "CURRENT",
    candidateSeekOfficeCd: "GOVERNOR",
    candidateSeekOfficeDistrict: "",
    candidateSeekOfficePlace: "",
    candidateSeekOfficeDescr: "Governor",
    candidateSeekOfficeCountyCd: "",
    candidateSeekOfficeCountyDescr: "",
    ...overrides,
  };
}

function purpose(overrides: Partial<TexasTecPurposeRow> = {}): TexasTecPurposeRow {
  return {
    recordType: "CVR3", formTypeCd: "GPAC", reportInfoIdent: "R1", receivedDt: "20261016", infoOnlyFlag: "N",
    filerIdent: "7001", filerTypeCd: "GPAC", filerName: "Texans for Example", committeeActivityId: "P1",
    subjectCategoryCd: "CANDIDATE", subjectPositionCd: "SUPPORT", subjectDescr: "", subjectElectionDt: "",
    activitySeekOfficeCd: "GOVERNOR", activitySeekOfficeDistrict: "", activitySeekOfficePlace: "",
    activitySeekOfficeDescr: "Governor", activitySeekOfficeCountyCd: "", activitySeekOfficeCountyDescr: "",
    commActivityName: "Abbott, Greg", ...overrides,
  };
}

function gpacInput(overrides: Partial<TexasOutsideSpendingAggregationInput> = {}): TexasOutsideSpendingAggregationInput {
  return {
    candidateName: "Greg Abbott", candidateCommitteeId: "00012345", officeScope: "statewide", officeName: "Governor",
    electionYear: 2026, spacRows: [], purposeRows: [purpose()],
    candidateRows: [candidate({ filerTypeCd: "GPAC", formTypeCd: "GPAC" })],
    expenditureRows: [expenditure({ filerTypeCd: "GPAC", formTypeCd: "GPAC", politicalExpendCd: "" })],
    ...overrides,
  };
}

describe("texasOutsideSpendingAggregator", () => {
  it("aggregates outside support and opposition only when SPAC relationship and expenditure rows agree", () => {
    const sourceUrl = "https://prd.tecprd.ethicsefile.com/public/cf/public/TEC_CF_CSV.zip";
    const result = aggregateTexasOutsideSpending({
      candidateName: "Greg Abbott",
      candidateCommitteeId: "00012345",
      officeScope: "statewide",
      officeName: "Governor",
      electionYear: 2026,
      sourceUrl,
      spacRows: [
        spac(),
        spac({
          spacFilerIdent: "7002",
          spacFilerName: "Texas Accountability PAC",
          spacPositionCd: "OPPOSE",
        }),
      ],
      expenditureRows: [
        expenditure({ expendAmount: "70000.00" }),
        expenditure({ expendInfoId: "E2", expendAmount: "30,000.25" }),
        expenditure({
          filerIdent: "7002",
          filerName: "Texas Accountability PAC",
          expendInfoId: "E3",
          expendAmount: "5000",
        }),
        expenditure({
          filerIdent: "9000",
          filerName: "Unrelated PAC",
          expendInfoId: "E4",
          expendAmount: "999999",
        }),
      ],
      candidateRows: [
        candidate({ expendAmount: "70000.00" }),
        candidate({ expendInfoId: "E2", expendAmount: "30,000.25" }),
        candidate({
          filerIdent: "7002",
          filerName: "Texas Accountability PAC",
          expendInfoId: "E3",
          expendAmount: "5000",
        }),
        candidate({
          filerIdent: "9000",
          filerName: "Unrelated PAC",
          expendInfoId: "E4",
          expendAmount: "999999",
        }),
        candidate({
          filerIdent: "7001",
          expendInfoId: "E5",
          candidateNameLast: "PAXTON",
          candidateNameFirst: "KEN",
          expendAmount: "888888",
        }),
      ],
    });

    expect(result).toEqual({
      summary: {
        supportTotal: 100000.25,
        opposeTotal: 5000,
        groups: [
          {
            committeeId: "7001",
            committeeName: "Texans for Example",
            supportOppose: "support",
            amount: 100000.25,
            sourceUrl,
          },
          {
            committeeId: "7002",
            committeeName: "Texas Accountability PAC",
            supportOppose: "oppose",
            amount: 5000,
            sourceUrl,
          },
        ],
        sourceUrl,
      },
      firstNameConflict: false,
      matchedCandidateExpenditureRowCount: 4,
      includedCandidateExpenditureRowCount: 3,
      skippedCandidateExpenditureRowCount: 1,
    });
  });

  it("rejects a candidate row whose middle name contradicts the candidate", () => {
    // TEC has no middle-name column, so a middle typed into the first-name
    // field is the only evidence there is; the first+last key collapses it
    // away and would attribute another Abbott's outside money.
    const conflicting = aggregateTexasOutsideSpending({
      candidateName: "Greg W. Abbott",
      candidateCommitteeId: "00012345",
      officeScope: "statewide",
      officeName: "Governor",
      electionYear: 2026,
      spacRows: [spac()],
      expenditureRows: [expenditure()],
      candidateRows: [candidate({ candidateNameFirst: "GREG R" })],
    });
    expect(conflicting).toMatchObject({ summary: null, matchedCandidateExpenditureRowCount: 0 });

    // A candidate with no middle of its own still falls back to first+last.
    const middleless = aggregateTexasOutsideSpending({
      candidateName: "Greg Abbott",
      candidateCommitteeId: "00012345",
      officeScope: "statewide",
      officeName: "Governor",
      electionYear: 2026,
      spacRows: [spac()],
      expenditureRows: [expenditure()],
      candidateRows: [candidate({ candidateNameFirst: "GREG R" })],
    });
    expect(middleless.matchedCandidateExpenditureRowCount).toBe(1);
    expect(middleless.summary?.supportTotal).toBe(70000);

    // An initial corroborating the full middle keeps matching.
    const corroborating = aggregateTexasOutsideSpending({
      candidateName: "Greg W. Abbott",
      candidateCommitteeId: "00012345",
      officeScope: "statewide",
      officeName: "Governor",
      electionYear: 2026,
      spacRows: [spac()],
      expenditureRows: [expenditure()],
      candidateRows: [candidate({ candidateNameFirst: "GREG WAYNE" })],
    });
    expect(corroborating.summary?.supportTotal).toBe(70000);
  });

  it("matches nickname purpose rows but only counts spenders related to the linked committee", () => {
    // "Pat Smith" expands to PATRICK SMITH and PATRICIA SMITH on the VoteApp
    // side. The unrelated spender's PATRICIA row name-matches but cannot
    // contribute money (no SPAC position on the linked committee), so it is
    // skipped — and it must not trip the conflicting-first-name abort either,
    // which only consults rows from related spenders.
    const result = aggregateTexasOutsideSpending({
      candidateName: "Pat Smith",
      candidateCommitteeId: "00012345",
      officeScope: "statewide",
      officeName: "Governor",
      electionYear: 2026,
      spacRows: [spac({ candidateFilerName: "SMITH, PATRICK" })],
      expenditureRows: [
        expenditure({ expendAmount: "70000.00" }),
        expenditure({
          filerIdent: "9000",
          filerName: "Unrelated PAC",
          expendInfoId: "E6",
          expendAmount: "40000.00",
        }),
      ],
      candidateRows: [
        candidate({
          candidateNameLast: "SMITH",
          candidateNameFirst: "PATRICK",
          expendAmount: "70000.00",
        }),
        candidate({
          filerIdent: "9000",
          filerName: "Unrelated PAC",
          expendInfoId: "E6",
          candidateNameLast: "SMITH",
          candidateNameFirst: "PATRICIA",
          expendAmount: "40000.00",
        }),
      ],
    });

    expect(result).toMatchObject({
      summary: {
        supportTotal: 70000,
        opposeTotal: 0,
      },
      matchedCandidateExpenditureRowCount: 2,
      includedCandidateExpenditureRowCount: 1,
      skippedCandidateExpenditureRowCount: 1,
    });
    expect(result.summary?.groups).toHaveLength(1);
    expect(result.summary?.groups[0]).toMatchObject({ committeeId: "7001", supportOppose: "support" });
  });

  it("refuses to aggregate when matched rows span conflicting formal first names", () => {
    // A spender related to the linked committee filed purpose rows for both
    // PATRICK and PATRICIA: positive evidence the expanded key set caught two
    // people. The whole aggregation aborts rather than combining their money.
    const result = aggregateTexasOutsideSpending({
      candidateName: "Pat Smith",
      candidateCommitteeId: "00012345",
      officeScope: "statewide",
      officeName: "Governor",
      electionYear: 2026,
      spacRows: [spac({ candidateFilerName: "SMITH, PATRICK" })],
      expenditureRows: [
        expenditure({ expendAmount: "70000.00" }),
        expenditure({ expendInfoId: "E6", expendAmount: "40000.00" }),
      ],
      candidateRows: [
        candidate({
          candidateNameLast: "SMITH",
          candidateNameFirst: "PATRICK",
          expendAmount: "70000.00",
        }),
        candidate({
          expendInfoId: "E6",
          candidateNameLast: "SMITH",
          candidateNameFirst: "PATRICIA",
          expendAmount: "40000.00",
        }),
      ],
    });

    expect(result).toEqual({
      summary: null,
      firstNameConflict: true,
      matchedCandidateExpenditureRowCount: 2,
      includedCandidateExpenditureRowCount: 0,
      skippedCandidateExpenditureRowCount: 2,
    });
  });

  it("ignores conflicting-name rows that cannot contribute money", () => {
    // The related spender's PATRICIA row is out of cycle, so it can never be
    // included; a row that cannot contribute must not abort Patrick's valid
    // current-cycle totals. Purpose rows span all years, so stale rows naming
    // a prior-cycle namesake are the common case, not the edge case.
    const result = aggregateTexasOutsideSpending({
      candidateName: "Pat Smith",
      candidateCommitteeId: "00012345",
      officeScope: "statewide",
      officeName: "Governor",
      electionYear: 2026,
      spacRows: [spac({ candidateFilerName: "SMITH, PATRICK" })],
      expenditureRows: [
        expenditure({ expendAmount: "70000.00" }),
        expenditure({ expendInfoId: "E6", expendDt: "20220301", expendAmount: "40000.00" }),
      ],
      candidateRows: [
        candidate({
          candidateNameLast: "SMITH",
          candidateNameFirst: "PATRICK",
          expendAmount: "70000.00",
        }),
        candidate({
          expendInfoId: "E6",
          expendDt: "20220301",
          candidateNameLast: "SMITH",
          candidateNameFirst: "PATRICIA",
          expendAmount: "40000.00",
        }),
      ],
    });

    expect(result).toMatchObject({
      summary: { supportTotal: 70000, opposeTotal: 0 },
      matchedCandidateExpenditureRowCount: 2,
      includedCandidateExpenditureRowCount: 1,
      skippedCandidateExpenditureRowCount: 1,
    });
  });

  it("still aggregates when matched rows only differ by formal spelling of one name", () => {
    // STEPHEN and STEVEN are spellings of the same name, not two people.
    const result = aggregateTexasOutsideSpending({
      candidateName: "Steve Weir",
      candidateCommitteeId: "00012345",
      officeScope: "statewide",
      officeName: "Governor",
      electionYear: 2026,
      spacRows: [spac({ candidateFilerName: "WEIR, STEPHEN" })],
      expenditureRows: [
        expenditure({ expendAmount: "70000.00" }),
        expenditure({ expendInfoId: "E6", expendAmount: "40000.00" }),
      ],
      candidateRows: [
        candidate({
          candidateNameLast: "WEIR",
          candidateNameFirst: "STEPHEN",
          expendAmount: "70000.00",
        }),
        candidate({
          expendInfoId: "E6",
          candidateNameLast: "WEIR",
          candidateNameFirst: "STEVEN",
          expendAmount: "40000.00",
        }),
      ],
    });

    expect(result).toMatchObject({
      summary: { supportTotal: 110000, opposeTotal: 0 },
      matchedCandidateExpenditureRowCount: 2,
      includedCandidateExpenditureRowCount: 2,
      skippedCandidateExpenditureRowCount: 0,
    });
  });

  it("refuses contradictory CAND/EXPN economics instead of choosing a source row", () => {
    expect(() => aggregateTexasOutsideSpending({
      candidateName: "Greg Abbott", candidateCommitteeId: "00012345", officeScope: "statewide", officeName: "Governor",
      electionYear: 2026, spacRows: [spac()], expenditureRows: [expenditure({ expendAmount: "1200.00" })],
      candidateRows: [candidate({ expendAmount: "999999.00", expendDt: "20261014" })],
    })).toThrow("Conflicting Texas CAND/EXPN economics");
  });

  it("requires exact target office and legislative district matches", () => {
    const result = aggregateTexasOutsideSpending({
      candidateName: "Jane Doe",
      candidateCommitteeId: "00022222",
      officeScope: "state_lower",
      officeName: "State Representative",
      district: "52",
      electionYear: 2026,
      spacRows: [
        spac({
          spacFilerIdent: "8001",
          spacFilerName: "House Future PAC",
          candidateFilerIdent: "00022222",
          candidateFilerName: "DOE, JANE",
          candidateSeekOfficeCd: "STATEREP",
          candidateSeekOfficeDistrict: "52",
          candidateSeekOfficeDescr: "State Representative",
        }),
      ],
      expenditureRows: [
        expenditure({ filerIdent: "8001", filerName: "House Future PAC", expendInfoId: "H1", expendAmount: "1000" }),
        expenditure({ filerIdent: "8001", filerName: "House Future PAC", expendInfoId: "H2", expendAmount: "2000" }),
      ],
      candidateRows: [
        candidate({
          filerIdent: "8001",
          filerName: "House Future PAC",
          expendInfoId: "H1",
          expendAmount: "1000",
          candidateNameLast: "DOE",
          candidateNameFirst: "JANE",
          candidateSeekOfficeCd: "STATEREP",
          candidateSeekOfficeDistrict: "52",
          candidateSeekOfficeDescr: "State Representative",
        }),
        candidate({
          filerIdent: "8001",
          filerName: "House Future PAC",
          expendInfoId: "H2",
          expendAmount: "2000",
          candidateNameLast: "DOE",
          candidateNameFirst: "JANE",
          candidateSeekOfficeCd: "STATEREP",
          candidateSeekOfficeDistrict: "53",
          candidateSeekOfficeDescr: "State Representative",
        }),
      ],
    });

    expect(result).toMatchObject({
      summary: {
        supportTotal: 1000,
        opposeTotal: 0,
        groups: [expect.objectContaining({ committeeId: "8001", amount: 1000 })],
      },
      matchedCandidateExpenditureRowCount: 1,
      includedCandidateExpenditureRowCount: 1,
      skippedCandidateExpenditureRowCount: 0,
    });
  });

  it("skips assist, missing relationship, ambiguous relationship, missing joined expenditure, info-only, bad amount, and wrong cycle", () => {
    const result = aggregateTexasOutsideSpending({
      candidateName: "Greg Abbott",
      candidateCommitteeId: "00012345",
      officeScope: "statewide",
      officeName: "Governor",
      electionYear: 2026,
      spacRows: [
        spac({ spacFilerIdent: "7001", spacPositionCd: "ASSIST" }),
        spac({ spacFilerIdent: "7003", spacFilerName: "Conflicted PAC", spacPositionCd: "SUPPORT" }),
        spac({ spacFilerIdent: "7003", spacFilerName: "Conflicted PAC", spacPositionCd: "OPPOSE" }),
      ],
      expenditureRows: [
        expenditure({ expendInfoId: "A1", expendAmount: "1000" }),
        expenditure({ filerIdent: "7003", filerName: "Conflicted PAC", expendInfoId: "A2", expendAmount: "2000" }),
        expenditure({ expendInfoId: "A4", expendAmount: "3000", infoOnlyFlag: "Y" }),
        expenditure({ expendInfoId: "A5", expendAmount: "4000" }),
        expenditure({ expendInfoId: "A6", expendAmount: "5000" }),
      ],
      candidateRows: [
        candidate({ expendInfoId: "A1", expendAmount: "1000" }),
        candidate({ filerIdent: "7003", filerName: "Conflicted PAC", expendInfoId: "A2", expendAmount: "2000" }),
        candidate({ filerIdent: "7004", filerName: "No Relationship PAC", expendInfoId: "A3", expendAmount: "3000" }),
        candidate({ expendInfoId: "A4", expendAmount: "3000" }),
        candidate({ expendInfoId: "A5", expendAmount: "bad" }),
        candidate({ expendInfoId: "A6", expendAmount: "5000", expendDt: "20240101" }),
      ],
    });

    expect(result).toEqual({
      summary: null,
      firstNameConflict: false,
      matchedCandidateExpenditureRowCount: 6,
      includedCandidateExpenditureRowCount: 0,
      skippedCandidateExpenditureRowCount: 6,
    });
  });

  it("maps only support and oppose SPAC positions", () => {
    expect(supportOpposeFromTexasSpacPosition("Support")).toBe("support");
    expect(supportOpposeFromTexasSpacPosition("OPPOSE")).toBe("oppose");
    expect(supportOpposeFromTexasSpacPosition("Assist")).toBeNull();
    expect(supportOpposeFromTexasSpacPosition("Neutral")).toBeNull();
  });

  it("handles empty candidate names and validates unsupported inputs", () => {
    expect(
      aggregateTexasOutsideSpending({
        candidateName: "   ",
        candidateCommitteeId: "00012345",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        candidateRows: [candidate()],
        expenditureRows: [expenditure()],
        spacRows: [spac()],
      })
    ).toEqual({
      summary: null,
      firstNameConflict: false,
      matchedCandidateExpenditureRowCount: 0,
      includedCandidateExpenditureRowCount: 0,
      skippedCandidateExpenditureRowCount: 0,
    });

    expect(() =>
      aggregateTexasOutsideSpending({
        candidateName: "Greg Abbott",
        candidateCommitteeId: " ",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        candidateRows: [],
        expenditureRows: [],
        spacRows: [],
      })
    ).toThrow("Texas candidate committee id is required");

    expect(() =>
      aggregateTexasOutsideSpending({
        candidateName: "Greg Abbott",
        candidateCommitteeId: "00012345",
        officeScope: "statewide",
        officeName: "Mayor",
        electionYear: 2026,
        candidateRows: [],
        expenditureRows: [],
        spacRows: [],
      })
    ).toThrow("Unsupported Texas outside spending office");

    expect(() =>
      aggregateTexasOutsideSpending({
        candidateName: "Jane Doe",
        candidateCommitteeId: "00022222",
        officeScope: "state_lower",
        officeName: "State Representative",
        electionYear: 2026,
        candidateRows: [],
        expenditureRows: [],
        spacRows: [],
      })
    ).toThrow("Texas outside spending district is required");

    expect(() =>
      aggregateTexasOutsideSpending({
        candidateName: "Greg Abbott",
        candidateCommitteeId: "00012345",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2013,
        candidateRows: [],
        expenditureRows: [],
        spacRows: [],
      })
    ).toThrow("Invalid Texas outside spending aggregation election year");

    expect(() =>
      aggregateTexasOutsideSpending({
        candidateName: "Greg Abbott",
        candidateCommitteeId: "00012345",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        maxGroups: 0,
        candidateRows: [],
        expenditureRows: [],
        spacRows: [],
      })
    ).toThrow("Invalid Texas outside spending aggregation maxGroups");
  });
});


describe("Texas current report-specific outside spending", () => {
  it("attributes verified Abbott consulting expense to the sole beneficiary without a SPAC link or political flag", () => {
    const fields = { filerIdent: "00085824", filerName: "Coalition Por For Texas PAC", filerTypeCd: "GPAC",
      formTypeCd: "GPAC", reportInfoIdent: "101069341", receivedDt: "20261005", expendInfoId: "106420958",
      expendDt: "20260916", expendAmount: "35000.00", expendCatCd: "CONSULT", expendDescr: "Grassroots Consutling",
      politicalExpendCd: "" };
    const result = aggregateTexasOutsideSpending(gpacInput({ candidateCommitteeId: "00019652",
      candidateRows: [candidate(fields)],
      expenditureRows: [expenditure({ ...fields, payeeNameOrganization: "Apex Canvassing & Consulting LLC" })],
      purposeRows: [purpose({ filerIdent: fields.filerIdent, filerName: fields.filerName, reportInfoIdent: fields.reportInfoIdent })],
    }));
    expect(result).toMatchObject({ summary: { supportTotal: 35000, opposeTotal: 0,
      groups: [{ committeeId: "00085824", committeeName: "Coalition Por For Texas PAC", amount: 35000 }] },
      includedCandidateExpenditureRowCount: 1 });
  });

  it("uses MPAC report direction and requires CAND and PURPOSE to name the same person", () => {
    const result = aggregateTexasOutsideSpending(gpacInput({
      candidateRows: [candidate({ filerTypeCd: "MPAC" })], expenditureRows: [expenditure({ filerTypeCd: "MPAC" })],
      purposeRows: [purpose({ filerTypeCd: "MPAC", subjectPositionCd: "OPPOSE" })],
    }));
    expect(result.summary).toMatchObject({ supportTotal: 0, opposeTotal: 70000 });
    expect(aggregateTexasOutsideSpending(gpacInput({ candidateName: "Pat Smith",
      candidateRows: [candidate({ filerTypeCd: "GPAC", candidateNameFirst: "PATRICK", candidateNameLast: "SMITH" })],
      purposeRows: [purpose({ commActivityName: "Smith, Patricia" })],
    })).summary).toBeNull();
  });

  it.each([ ["SUPPORT", "OPPOSE", "SUPPORT"], ["OPPOSE", "SUPPORT", "SUPPORT"], ["SUPPORT", "SUPPORT", "OPPOSE"] ])(
    "refuses conflicting report directions regardless of duplicate/order %j", (...directions) => {
      expect(() => aggregateTexasOutsideSpending(gpacInput({ purposeRows: directions.map((subjectPositionCd) => purpose({ subjectPositionCd })) })))
        .toThrow("Conflicting Texas PURPOSE directions");
    }
  );

  it("uses corroborating SPAC direction but refuses conflicting PURPOSE and excludes ASSIST", () => {
    const base = { candidateRows: [candidate()], expenditureRows: [expenditure()], spacRows: [spac()] };
    expect(aggregateTexasOutsideSpending(gpacInput({ ...base, purposeRows: [purpose({ filerTypeCd: "SPAC" })] })).summary?.supportTotal).toBe(70000);
    expect(() => aggregateTexasOutsideSpending(gpacInput({ ...base,
      purposeRows: [purpose({ filerTypeCd: "SPAC", subjectPositionCd: "OPPOSE" })],
    }))).toThrow("Conflicting Texas PURPOSE/SPAC directions");
    expect(aggregateTexasOutsideSpending(gpacInput({ ...base,
      purposeRows: [purpose({ filerTypeCd: "SPAC", subjectPositionCd: "ASSIST" })],
    })).summary).toBeNull();
  });

  it.each(["candidate", "expenditure", "purpose"])("excludes superseded %s rows", (table) => {
    const input = gpacInput();
    if (table === "candidate") input.candidateRows = input.candidateRows.map((row) => ({ ...row, infoOnlyFlag: "Y" }));
    if (table === "expenditure") input.expenditureRows = input.expenditureRows.map((row) => ({ ...row, infoOnlyFlag: "Y" }));
    if (table === "purpose") input.purposeRows = input.purposeRows!.map((row) => ({ ...row, infoOnlyFlag: "Y" }));
    if (table === "expenditure") {
      expect(() => aggregateTexasOutsideSpending(input)).toThrow("Missing current Texas EXPN join");
    } else {
      expect(aggregateTexasOutsideSpending(input).summary).toBeNull();
    }
  });

  it("does not choose a superseded first record over the current record", () => {
    const input = gpacInput();
    input.expenditureRows = [{ ...input.expenditureRows[0]!, infoOnlyFlag: "Y", expendAmount: "1" }, ...input.expenditureRows];
    input.candidateRows = [{ ...input.candidateRows[0]!, infoOnlyFlag: "Y", candidateNameFirst: "KEN", candidateNameLast: "PAXTON" }, ...input.candidateRows];
    expect(aggregateTexasOutsideSpending(input).summary?.supportTotal).toBe(70000);
  });

  it("joins exact report IDs rather than cross-pairing an expense ID from another report", () => {
    const input = gpacInput({ expenditureRows: [expenditure({ filerTypeCd: "GPAC", reportInfoIdent: "R2" })] });
    expect(() => aggregateTexasOutsideSpending(input)).toThrow("Missing current Texas EXPN join");
    expect(aggregateTexasOutsideSpending(gpacInput({ purposeRows: [purpose({ reportInfoIdent: "R2" })] })).summary).toBeNull();
  });

  it("refuses incomplete current EXPN acquisition after verifying an applicable target and direction", () => {
    expect(() => aggregateTexasOutsideSpending(gpacInput({ expenditureRows: [] })))
      .toThrow("Missing current Texas EXPN join for applicable CAND");
    // An absent join for an unrelated office has no candidate-money claim.
    const input = gpacInput({ expenditureRows: [] });
    input.candidateRows = input.candidateRows.map((row) => ({ ...row, candidateSeekOfficeCd: "STATESEN", candidateSeekOfficeDistrict: "22" }));
    expect(aggregateTexasOutsideSpending(input).summary).toBeNull();
  });

  it("refuses competing current reports for an expense instead of double counting", () => {
    const input = gpacInput();
    input.expenditureRows = [...input.expenditureRows, { ...input.expenditureRows[0]!, reportInfoIdent: "R2" }];
    expect(() => aggregateTexasOutsideSpending(input)).toThrow("Conflicting current Texas reports for expense");
  });

  it("dedupes repeated current economic rows and beneficiary links even when link IDs differ", () => {
    const input = gpacInput();
    input.candidateRows = [...input.candidateRows, { ...input.candidateRows[0]!, expendPersentId: "another-link" }];
    input.expenditureRows = [...input.expenditureRows, { ...input.expenditureRows[0]! }];
    expect(aggregateTexasOutsideSpending(input)).toMatchObject({ summary: { supportTotal: 70000 },
      matchedCandidateExpenditureRowCount: 2, includedCandidateExpenditureRowCount: 1, skippedCandidateExpenditureRowCount: 1 });
  });

  it.each([false, true])("refuses conflicting current EXPN rows in either order (%s)", (reverse) => {
    const input = gpacInput();
    const rows = [...input.expenditureRows, { ...input.expenditureRows[0]!, expendAmount: "123" }];
    input.expenditureRows = reverse ? rows.reverse() : rows;
    expect(() => aggregateTexasOutsideSpending(input)).toThrow("Conflicting current Texas expenditure rows");
  });

  it("detects EXPN classification conflicts before choosing a donations or consulting row", () => {
    const input = gpacInput();
    input.expenditureRows = [{ ...input.expenditureRows[0]!, expendCatCd: "DONATIONS" }, ...input.expenditureRows];
    expect(() => aggregateTexasOutsideSpending(input)).toThrow("Conflicting current Texas expenditure rows");
  });

  it("excludes shared expenses including a beneficiary outside the due candidates and office", () => {
    const input = gpacInput();
    input.candidateRows = [...input.candidateRows, { ...input.candidateRows[0]!, candidateNameFirst: "KEN", candidateNameLast: "PAXTON",
      candidateSeekOfficeCd: "ATTYGEN", candidateSeekOfficeDescr: "Attorney General" }];
    expect(aggregateTexasOutsideSpending(input)).toMatchObject({ summary: null,
      matchedCandidateExpenditureRowCount: 1, includedCandidateExpenditureRowCount: 0, skippedCandidateExpenditureRowCount: 1 });
  });

  it.each(["DONATIONS", "CONTRIBUTION", "IN-KIND"])("excludes direct gifts identified by source category/description (%s)", (kind) => {
    const input = gpacInput();
    input.expenditureRows = input.expenditureRows.map((row) => ({ ...row,
      expendCatCd: kind === "DONATIONS" ? "DONATIONS" : "OTHER",
      expendDescr: kind === "IN-KIND" ? "In-kind contribution" : "Contribution",
    }));
    expect(aggregateTexasOutsideSpending(input).summary).toBeNull();
  });

  it.each(["F2", "F3", "F4", "I"])("excludes unverified expenditure schedule %s", (schedFormTypeCd) => {
    const input = gpacInput();
    input.candidateRows = input.candidateRows.map((row) => ({ ...row, schedFormTypeCd }));
    input.expenditureRows = input.expenditureRows.map((row) => ({ ...row, schedFormTypeCd }));
    expect(aggregateTexasOutsideSpending(input).summary).toBeNull();
  });

  it("excludes self spenders across receiving committees, self payees and explicitly nonpolitical expenses", () => {
    expect(aggregateTexasOutsideSpending(gpacInput({ candidateCommitteeIds: ["7001"] })).summary).toBeNull();
    const input = gpacInput();
    input.expenditureRows = input.expenditureRows.map((row) => ({ ...row, payeePersentTypeCd: "INDIVIDUAL",
      payeeNameFirst: "Greg", payeeNameLast: "Abbott", payeeNameOrganization: "" }));
    expect(aggregateTexasOutsideSpending(input).summary).toBeNull();
    input.expenditureRows = input.expenditureRows.map((row) => ({ ...row, politicalExpendCd: "N" }));
    expect(aggregateTexasOutsideSpending(input).summary).toBeNull();
  });

  it("requires source sought offices and rejects explicit unrelated codes even with misleading descriptions", () => {
    const input = gpacInput();
    input.candidateRows = input.candidateRows.map((row) => ({ ...row, candidateSeekOfficeCd: "SPK" }));
    expect(aggregateTexasOutsideSpending(input).matchedCandidateExpenditureRowCount).toBe(0);
    expect(aggregateTexasOutsideSpending(gpacInput({ purposeRows: [purpose({ activitySeekOfficeCd: "STATESEN", activitySeekOfficeDistrict: "22" })] })).summary).toBeNull();
  });

  it("allows blank purpose election date but rejects explicit wrong election and invalid dates", () => {
    expect(aggregateTexasOutsideSpending(gpacInput()).summary?.supportTotal).toBe(70000);
    expect(aggregateTexasOutsideSpending(gpacInput({ purposeRows: [purpose({ subjectElectionDt: "20241105" })] })).summary).toBeNull();
    expect(() => aggregateTexasOutsideSpending(gpacInput({ purposeRows: [purpose({ subjectElectionDt: "20260230" })] })))
      .toThrow("Invalid Texas PURPOSE election date");
    const input = gpacInput();
    input.candidateRows = input.candidateRows.map((row) => ({ ...row, expendDt: "20260230" }));
    expect(() => aggregateTexasOutsideSpending(input)).toThrow("Invalid Texas candidate expenditure date");
  });

  it("refuses applicable missing identity and source economy without affecting unrelated old-cycle rows", () => {
    const input = gpacInput();
    input.candidateRows = input.candidateRows.map((row) => ({ ...row, reportInfoIdent: "" }));
    input.spacRows = [spac()];
    input.candidateRows = input.candidateRows.map((row) => ({ ...row, filerTypeCd: "SPAC" }));
    expect(() => aggregateTexasOutsideSpending(input)).toThrow("report and expense identifiers are required");
    const old = gpacInput();
    old.candidateRows = old.candidateRows.map((row) => ({ ...row, expendDt: "20240101", expendAmount: "bad" }));
    expect(aggregateTexasOutsideSpending(old).summary).toBeNull();
  });
});
