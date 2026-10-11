import { describe, expect, it, vi } from "vitest";

import { syncTexasCandidateFinance } from "../../../src/pipeline/texasFinance/texasCandidateFinanceSync.js";
import { TEXAS_TEC_PURPOSE_COLUMNS } from "../../../src/pipeline/texasFinance/texasTecCsvDatabaseReader.js";
import type {
  TexasTecPurposeRow,
  TexasTecCandidateRow,
  TexasTecContributionRow,
  TexasTecExpenditureRow,
  TexasTecFilerRow,
  TexasTecSpacRow,
} from "../../../src/pipeline/texasFinance/texasTecCsvDatabaseReader.js";

const CANDIDATE_ID = "11111111-1111-1111-1111-111111111111";
const ELECTION_ID = "22222222-2222-2222-2222-222222222222";
const LINK_ID = "33333333-3333-3333-3333-333333333333";
const SOURCE_URL = "https://prd.tecprd.ethicsefile.com/public/cf/public/TEC_CF_CSV.zip";

function createMockDb() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ id: LINK_ID }], rowCount: 1 }),
  };
}

function filer(overrides: Partial<TexasTecFilerRow> = {}): TexasTecFilerRow {
  return {
    recordType: "FILER",
    filerIdent: "00012345",
    filerTypeCd: "COH",
    filerName: "ABBOTT, GREG",
    committeeStatusCd: "ACTIVE",
    filerFilerpersStatusCd: "CURRENT",
    contestSeekOfficeCd: "GOVERNOR",
    contestSeekOfficeDistrict: "",
    contestSeekOfficePlace: "",
    contestSeekOfficeDescr: "Governor",
    contestSeekOfficeCountyCd: "",
    contestSeekOfficeCountyDescr: "",
    filerPersentTypeCd: "INDIVIDUAL",
    filerNameOrganization: "",
    filerNameLast: "ABBOTT",
    filerNameFirst: "GREG",
    filerNameShort: "",
    ...overrides,
  };
}

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
    contributionInfoId: "1001",
    contributionDt: "20260915",
    contributionAmount: "100.00",
    contributionDescr: "",
    contributorPersentTypeCd: "INDIVIDUAL",
    contributorNameOrganization: "",
    contributorNameLast: "DOE",
    contributorNameFirst: "JANE",
    contributorStreetStateCd: "TX",
    contributorEmployer: "ACME",
    contributorOccupation: "Attorney",
    contributorJobTitle: "Attorney",
    ...overrides,
  };
}

function candidate(overrides: Partial<TexasTecCandidateRow> = {}): TexasTecCandidateRow {
  return {
    recordType: "CAND",
    reportInfoIdent: "R1",
    infoOnlyFlag: "N",
    schedFormTypeCd: "F1",
    filerIdent: "7001",
    filerTypeCd: "SPAC",
    filerName: "Texans for Example",
    expendInfoId: "E1",
    expendDt: "20261015",
    expendAmount: "1200.00",
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
    expendAmount: "1200.00",
    expendDescr: "Direct campaign expenditure",
    expendCatCd: "ADV",
    expendCatDescr: "Advertising",
    politicalExpendCd: "",
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

function baseInput() {
  return {
    purposeRows: [],
    candidateId: CANDIDATE_ID,
    electionId: ELECTION_ID,
    candidateName: "Greg Abbott",
    electionYear: 2026,
    officeScope: "statewide",
    officeName: "Governor",
    sourceUrl: SOURCE_URL,
    contributionSourceUrl: SOURCE_URL,
    outsideSourceUrl: SOURCE_URL,
    now: new Date("2026-02-03T04:05:06.000Z"),
  };
}

describe("texasCandidateFinanceSync", () => {
  it("resolves a candidate committee, aggregates direct and outside data, and writes a snapshot", async () => {
    const db = createMockDb();

    const result = await syncTexasCandidateFinance({
      db,
      ...baseInput(),
      filerRows: [filer()],
      contributionRows: [
        contribution({ contributionAmount: "100.00", contributorOccupation: "Attorney" }),
        contribution({
          contributionInfoId: "1002",
          contributionAmount: "250.00",
          contributorOccupation: "Teacher",
          contributorNameLast: "ROE",
        }),
        contribution({
          filerIdent: "7001",
          filerTypeCd: "SPAC",
          filerName: "Texans for Example",
          contributionInfoId: "OUT1",
          contributionAmount: "25000.00",
          contributorPersentTypeCd: "ENTITY",
          contributorNameOrganization: "Energy Transfer LLC",
          contributorNameLast: "",
          contributorNameFirst: "",
          contributorOccupation: "",
        }),
        contribution({
          filerIdent: "OTHER",
          filerName: "Other Committee",
          contributionAmount: "900.00",
          contributorOccupation: "Doctor",
        }),
      ],
      candidateRows: [candidate({ expendAmount: "1200.00" })],
      expenditureRows: [expenditure({ expendAmount: "1200.00" })],
      spacRows: [spac()],
    });

    expect(result).toMatchObject({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      electionYear: 2026,
      dryRun: false,
      linkWritten: true,
      summaryWritten: true,
      directBreakdownsWritten: 4,
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 2,
      totalReceipts: 350,
      directContributionTotal: 350,
      outsideSupportTotal: 1200,
      outsideOpposeTotal: 0,
      matchedContributionRowCount: 2,
      includedContributionRowCount: 2,
      skippedContributionRowCount: 0,
      matchedCandidateExpenditureRowCount: 1,
      includedCandidateExpenditureRowCount: 1,
      skippedCandidateExpenditureRowCount: 0,
      matchedOutsideContributionRowCount: 1,
      includedOutsideContributionRowCount: 1,
      skippedOutsideContributionRowCount: 0,
      resolution: {
        status: "matched",
        committeeId: "00012345",
        committeeName: "ABBOTT, GREG",
      },
    });

    expect(db.query).toHaveBeenCalledTimes(16);
    expect(String(db.query.mock.calls[0]?.[0])).toContain("FROM public.finance_label_classifications");
    expect(db.query.mock.calls[1]?.[0]).toBe("BEGIN");
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");

    const linkCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.tx_candidate_finance_links")
    );
    expect(linkCall?.[1]).toEqual([
      CANDIDATE_ID,
      ELECTION_ID,
      2026,
      "GREG ABBOTT",
      "Governor",
      null,
      "00012345",
      "ABBOTT, GREG",
      "active",
      "tec_bulk",
      SOURCE_URL,
      "2026-02-03T04:05:06.000Z",
    ]);

    const summaryCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.tx_candidate_finance_summaries")
    );
    expect(summaryCall?.[1]).toEqual([
      LINK_ID,
      2026,
      350,
      350,
      null,
      null,
      1200,
      0,
      SOURCE_URL,
      "2026-02-03T04:05:06.000Z",
    ]);

    expect(
      db.query.mock.calls.filter((call) =>
        String(call[0]).includes("INSERT INTO public.tx_candidate_finance_direct_breakdowns")
      )
    ).toHaveLength(4);
    expect(
      db.query.mock.calls.filter((call) =>
        String(call[0]).includes("INSERT INTO public.tx_candidate_finance_outside_groups")
      )
    ).toHaveLength(1);
    const outsideBreakdownCalls = db.query.mock.calls.filter((call) =>
      String(call[0]).includes("INSERT INTO public.tx_candidate_finance_outside_group_breakdowns")
    );
    expect(outsideBreakdownCalls).toHaveLength(2);
    expect(outsideBreakdownCalls.map((call) => call[1])).toEqual([
      [
        LINK_ID,
        2026,
        "7001",
        "support",
        "donor",
        "Energy Transfer LLC",
        25000,
        1,
        SOURCE_URL,
        "2026-02-03T04:05:06.000Z",
      ],
      [
        LINK_ID,
        2026,
        "7001",
        "support",
        "industry",
        "oil_gas_energy",
        25000,
        1,
        SOURCE_URL,
        "2026-02-03T04:05:06.000Z",
      ],
    ]);
    const classificationCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.finance_label_classifications")
    );
    expect(classificationCall?.[1]).toEqual([
      "Energy Transfer LLC",
      "donor",
      "ENERGY TRANSFER",
      "oil_gas_energy",
      "high",
      "rule",
    ]);
  });

  it("classifies every outside donor but caps the persisted donor rows per group", async () => {
    const db = createMockDb();

    // Cap of 1: the smaller Continental donor must be dropped from the WRITTEN
    // donor rows, yet still feed the classifications and the rebuilt
    // oil_gas_energy industry total.
    const result = await syncTexasCandidateFinance({
      db,
      ...baseInput(),
      outsideMaxBreakdownsPerCategory: 1,
      filerRows: [filer()],
      contributionRows: [
        contribution({ contributionAmount: "100.00", contributorOccupation: "Attorney" }),
        contribution({
          filerIdent: "7001",
          filerTypeCd: "SPAC",
          filerName: "Texans for Example",
          contributionInfoId: "OUT1",
          contributionAmount: "50000.00",
          contributorPersentTypeCd: "ENTITY",
          contributorNameOrganization: "Energy Transfer LLC",
          contributorNameLast: "",
          contributorNameFirst: "",
          contributorOccupation: "",
        }),
        contribution({
          filerIdent: "7001",
          filerTypeCd: "SPAC",
          filerName: "Texans for Example",
          contributionInfoId: "OUT2",
          contributionAmount: "25000.00",
          contributorPersentTypeCd: "ENTITY",
          contributorNameOrganization: "Continental Resources Inc",
          contributorNameLast: "",
          contributorNameFirst: "",
          contributorOccupation: "",
        }),
      ],
      candidateRows: [candidate({ expendAmount: "1200.00" })],
      expenditureRows: [expenditure({ expendAmount: "1200.00" })],
      spacRows: [spac()],
    });

    // 1 capped donor row + 1 industry row built from BOTH donors.
    expect(result.outsideGroupBreakdownsWritten).toBe(2);
    const breakdownInsertParams = db.query.mock.calls
      .filter((call) => String(call[0]).includes("tx_candidate_finance_outside_group_breakdowns"))
      .flatMap((call) => (Array.isArray(call[1]) ? call[1] : []));
    expect(breakdownInsertParams).toContain("Energy Transfer LLC");
    expect(breakdownInsertParams).not.toContain("Continental Resources Inc");
    // The rebuilt industry total covers the dropped donor too.
    expect(breakdownInsertParams).toContain("oil_gas_energy");
    expect(breakdownInsertParams).toContain(75000);
    // Both donors persisted classification rows.
    const classificationParams = db.query.mock.calls
      .filter((call) => String(call[0]).includes("INSERT INTO public.finance_label_classifications"))
      .flatMap((call) => (Array.isArray(call[1]) ? call[1] : []));
    expect(classificationParams).toContain("Energy Transfer LLC");
    expect(classificationParams).toContain("Continental Resources Inc");
  });

  it("aggregates but does not write in dry-run mode", async () => {
    const db = createMockDb();

    const result = await syncTexasCandidateFinance({
      db,
      ...baseInput(),
      dryRun: true,
      filerRows: [filer()],
      contributionRows: [contribution({ contributionAmount: "250.00" })],
      candidateRows: [candidate({ expendAmount: "500.00" })],
      expenditureRows: [expenditure({ expendAmount: "500.00" })],
      spacRows: [spac()],
    });

    expect(result).toMatchObject({
      dryRun: true,
      linkWritten: false,
      summaryWritten: false,
      directBreakdownsWritten: 0,
      outsideGroupsWritten: 0,
      totalReceipts: 250,
      directContributionTotal: 250,
      outsideSupportTotal: 500,
      resolution: { status: "matched", committeeId: "00012345" },
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("uses the shared classifier for high-dollar unknown outside organization donors", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (String(sql).includes("FROM public.finance_label_classifications AS classification")) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{ id: LINK_ID }], rowCount: 1 };
      }),
    };
    const financeIndustryClassifier = vi.fn(async ({ labels }) =>
      labels.map((label) => ({
        rawLabel: label.rawLabel,
        labelType: label.labelType,
        normalizedLabel: label.normalizedLabel,
        industrySlug: "technology" as const,
        confidence: "medium" as const,
        classificationSource: "ai" as const,
        matchedRule: null,
      }))
    );

    const result = await syncTexasCandidateFinance({
      db,
      ...baseInput(),
      filerRows: [filer()],
      contributionRows: [
        contribution({ contributionAmount: "100.00", contributorOccupation: "Attorney" }),
        contribution({
          filerIdent: "7001",
          filerTypeCd: "SPAC",
          filerName: "Texans for Example",
          contributionInfoId: "OUT1",
          contributionAmount: "30000.00",
          contributorPersentTypeCd: "ENTITY",
          contributorNameOrganization: "Bluebonnet Strategic Holdings",
          contributorNameLast: "",
          contributorNameFirst: "",
          contributorOccupation: "",
        }),
      ],
      candidateRows: [candidate({ expendAmount: "1200.00" })],
      expenditureRows: [expenditure({ expendAmount: "1200.00" })],
      spacRows: [spac()],
      financeIndustryClassifier,
      aiClassificationMinAmount: 25_000,
    });

    expect(result).toMatchObject({
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 2,
      matchedOutsideContributionRowCount: 1,
      includedOutsideContributionRowCount: 1,
    });
    expect(financeIndustryClassifier).toHaveBeenCalledWith({
      labels: [
        expect.objectContaining({
          rawLabel: "Bluebonnet Strategic Holdings",
          labelType: "donor",
          amount: 30000,
        }),
      ],
    });

    const outsideBreakdownCalls = db.query.mock.calls.filter((call) =>
      String(call[0]).includes("INSERT INTO public.tx_candidate_finance_outside_group_breakdowns")
    );
    expect(outsideBreakdownCalls.map((call) => call[1])).toEqual(
      expect.arrayContaining([
        [
          LINK_ID,
          2026,
          "7001",
          "support",
          "industry",
          "technology",
          30000,
          1,
          SOURCE_URL,
          "2026-02-03T04:05:06.000Z",
        ],
      ])
    );

    const classificationCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.finance_label_classifications")
    );
    expect(classificationCall?.[1]).toEqual([
      "Bluebonnet Strategic Holdings",
      "donor",
      expect.any(String),
      "technology",
      "medium",
      "ai",
    ]);
  });

  it("does not write when committee resolution is unmatched", async () => {
    const db = createMockDb();

    const result = await syncTexasCandidateFinance({
      db,
      ...baseInput(),
      candidateName: "Different Candidate",
      filerRows: [filer()],
      contributionRows: [contribution({ contributionAmount: "250.00" })],
      candidateRows: [candidate({ expendAmount: "500.00" })],
      expenditureRows: [expenditure({ expendAmount: "500.00" })],
      spacRows: [spac()],
    });

    expect(result).toMatchObject({
      linkWritten: false,
      summaryWritten: false,
      directBreakdownsWritten: 0,
      outsideGroupsWritten: 0,
      totalReceipts: null,
      directContributionTotal: null,
      outsideSupportTotal: null,
      resolution: { status: "unmatched", reason: "no_candidate_committee_match" },
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("refuses to write anything when outside rows reveal a first-name identity conflict", async () => {
    // "Pat Smith" is stored-linked to Patrick's committee, but a related
    // spender's includable purpose rows name both PATRICK and PATRICIA. The
    // sync must not persist zeroed outside totals and an empty group set over
    // a previously stored snapshot; it writes nothing and flags the conflict.
    const db = createMockDb();

    const result = await syncTexasCandidateFinance({
      db,
      ...baseInput(),
      candidateName: "Pat Smith",
      filerRows: [],
      contributionRows: [contribution({ contributionAmount: "250.00" })],
      candidateRows: [
        candidate({ candidateNameLast: "SMITH", candidateNameFirst: "PATRICK", expendAmount: "500.00" }),
        candidate({
          expendInfoId: "E2",
          candidateNameLast: "SMITH",
          candidateNameFirst: "PATRICIA",
          expendAmount: "400.00",
        }),
      ],
      expenditureRows: [
        expenditure({ expendAmount: "500.00" }),
        expenditure({ expendInfoId: "E2", expendAmount: "400.00" }),
      ],
      spacRows: [spac({ candidateFilerName: "SMITH, PATRICK" })],
      trustedCommittee: {
        committeeId: "00012345",
        committeeName: "Pat Smith Campaign",
      },
    });

    expect(result).toMatchObject({
      outsideIdentityConflict: true,
      linkWritten: false,
      summaryWritten: false,
      directBreakdownsWritten: 0,
      outsideGroupsWritten: 0,
      outsideSupportTotal: null,
      outsideOpposeTotal: null,
      matchedCandidateExpenditureRowCount: 2,
      includedCandidateExpenditureRowCount: 0,
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("uses a trusted linked committee without re-resolving by candidate name", async () => {
    const db = createMockDb();

    const result = await syncTexasCandidateFinance({
      db,
      ...baseInput(),
      candidateName: "Updated Display Name",
      filerRows: [],
      contributionRows: [
        contribution({
          filerIdent: "00051153",
          filerTypeCd: "SPAC",
          contributionAmount: "250.00",
          contributorOccupation: "Attorney",
        }),
      ],
      trustedCommittee: {
        committeeId: "00012345",
        committeeName: "ABBOTT, GREG",
        receiptCommitteeIds: ["00051153"],
        sourceUrl: SOURCE_URL,
      },
    });

    expect(result).toMatchObject({
      linkWritten: true,
      summaryWritten: true,
      totalReceipts: 250,
      directContributionTotal: 250,
      outsideSupportTotal: null,
      outsideOpposeTotal: null,
      resolution: {
        status: "matched",
        committeeId: "00012345",
        committeeName: "ABBOTT, GREG",
        receiptCommitteeIds: ["00012345", "00051153"],
      },
    });

    const linkCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.tx_candidate_finance_links")
    );
    expect(linkCall?.[1]).toEqual([
      CANDIDATE_ID,
      ELECTION_ID,
      2026,
      "UPDATED DISPLAY NAME",
      "Governor",
      null,
      "00012345",
      "ABBOTT, GREG",
      "active",
      "tec_bulk",
      SOURCE_URL,
      "2026-02-03T04:05:06.000Z",
    ]);
  });

  it("leaves outside totals null when outside rows are omitted", async () => {
    const db = createMockDb();

    const result = await syncTexasCandidateFinance({
      db,
      ...baseInput(),
      filerRows: [filer()],
      contributionRows: [contribution({ contributionAmount: "250.00" })],
    });

    expect(result).toMatchObject({
      outsideSupportTotal: null,
      outsideOpposeTotal: null,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
      matchedCandidateExpenditureRowCount: 0,
      matchedOutsideContributionRowCount: 0,
    });
    const summaryCall = db.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.tx_candidate_finance_summaries")
    );
    expect(summaryCall?.[1]).toEqual([
      LINK_ID,
      2026,
      250,
      250,
      null,
      null,
      null,
      null,
      SOURCE_URL,
      "2026-02-03T04:05:06.000Z",
    ]);
  });
  it("preserves outside snapshots when PURPOSE was not acquired", async () => {
    const db = createMockDb();
    const result = await syncTexasCandidateFinance({
      db, ...baseInput(), purposeRows: undefined, filerRows: [filer()],
      contributionRows: [contribution()], candidateRows: [candidate()],
      expenditureRows: [expenditure()], spacRows: [spac()],
    });
    expect(result.outsideSupportTotal).toBeNull();
    expect(db.query.mock.calls.some(call => /INSERT|DELETE/.test(String(call[0])) &&
      String(call[0]).includes("tx_candidate_finance_outside"))).toBe(false);
  });

  it("clears outside groups and breakdowns only with complete valid empty data", async () => {
    const db = createMockDb();
    const result = await syncTexasCandidateFinance({
      db, ...baseInput(), filerRows: [filer()], contributionRows: [contribution()],
      candidateRows: [], expenditureRows: [], spacRows: [], purposeRows: [],
    });
    expect(result.outsideSupportTotal).toBe(0);
    expect(result.outsideOpposeTotal).toBe(0);
    expect(db.query.mock.calls.some(call => String(call[0]).includes("DELETE FROM public.tx_candidate_finance_outside_groups"))).toBe(true);
    expect(db.query.mock.calls.some(call => String(call[0]).includes("DELETE FROM public.tx_candidate_finance_outside_group_breakdowns"))).toBe(true);
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("rejects a verified applicable GPAC expense missing its current EXPN without writing", async () => {
    const db = createMockDb();
    const purpose = Object.fromEntries(TEXAS_TEC_PURPOSE_COLUMNS.map(column => [column, ""]));
    await expect(syncTexasCandidateFinance({
      db, ...baseInput(), filerRows: [filer()], contributionRows: [contribution()],
      candidateRows: [candidate({ filerTypeCd: "GPAC" })], expenditureRows: [], spacRows: [],
      purposeRows: [{ ...purpose, recordType: "PURPOSE", reportInfoIdent: "R1", infoOnlyFlag: "N",
        filerIdent: "7001", filerTypeCd: "GPAC", subjectCategoryCd: "CANDIDATE",
        subjectPositionCd: "SUPPORT", commActivityName: "Abbott, Greg", activitySeekOfficeCd: "GOVERNOR" } as TexasTecPurposeRow],
    })).rejects.toThrow(/missing|Missing/);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("passes typed donor rows to the writer without adding PAC amounts to receipts twice", async () => {
    const db = createMockDb();
    const result = await syncTexasCandidateFinance({
      db, ...baseInput(), filerRows: [filer()],
      contributionRows: [contribution({ contributionAmount: "2500.00", contributorPersentTypeCd: "ENTITY",
        contributorNameOrganization: "Example Civic Committee", contributorNameFirst: "", contributorNameLast: "" })],
      committeeRegistryRows: [filer({ filerIdent: "00015672", filerTypeCd: "MPAC",
        filerName: "Example Civic Committee", filerNameOrganization: "Example Civic Committee" })],
    });
    expect(result.directContributionTotal).toBe(2500);
    expect(result.totalReceipts).toBe(2500);
    const inserts = db.query.mock.calls.filter(call => String(call[0]).includes("INSERT INTO public.tx_candidate_finance_pac_donors"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.[1]).toEqual(expect.arrayContaining(["00015672", "MPAC", 2500, 1]));
  });

});
