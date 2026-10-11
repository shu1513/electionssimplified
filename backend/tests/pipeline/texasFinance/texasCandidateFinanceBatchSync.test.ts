import { describe, expect, it, vi } from "vitest";

import {
  listDueTexasCandidateFinanceSyncRows,
  syncDueTexasCandidateFinance,
  type TexasTecDataForBatchSync,
} from "../../../src/pipeline/texasFinance/texasCandidateFinanceBatchSync.js";
import type {
  TexasTecCandidateRow,
  TexasTecContributionRow,
  TexasTecExpenditureRow,
  TexasTecFilerRow,
  TexasTecSpacRow,
} from "../../../src/pipeline/texasFinance/texasTecCsvDatabaseReader.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_URL = "https://prd.tecprd.ethicsefile.com/public/cf/public/TEC_CF_CSV.zip";

function createMockDb(rows: unknown[] = []) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  };
}

function dueRow(overrides: Record<string, unknown> = {}) {
  return {
    candidate_id: CANDIDATE_ID,
    election_id: ELECTION_ID,
    candidate_name: "Greg Abbott",
    election_year: 2026,
    office_scope: "statewide",
    office_name: "Governor",
    district: null,
    committee_id: "00012345",
    committee_name: "ABBOTT, GREG",
    source_url: SOURCE_URL,
    last_synced_at: null,
    total_due_rows: "1",
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

function tecData(overrides: Partial<TexasTecDataForBatchSync> = {}): TexasTecDataForBatchSync {
  return {
    zipPath: "/tmp/TEC_CF_CSV.zip",
    sourceUrl: SOURCE_URL,
    contributionRows: [contribution()],
    candidateRows: [candidate()],
    expenditureRows: [expenditure()],
    filerRows: [],
    spacRows: [spac()],
    purposeRows: [],
    receiptCommitteeIdsByCandidateElectionKey: new Map(),
    ...overrides,
  };
}

describe("texasCandidateFinanceBatchSync", () => {
  it("lists due Texas finance sync rows from explicit active links", async () => {
    const db = createMockDb([dueRow()]);

    const result = await listDueTexasCandidateFinanceSyncRows(db, {
      now: new Date("2026-06-01T00:00:00.000Z"),
      staleAfterDays: 7,
      maxCandidates: 25,
      electionLookbackDays: 30,
      electionLookaheadDays: 730,
    });

    expect(result).toEqual({
      totalDueRows: 1,
      rows: [
        {
          candidateId: CANDIDATE_ID,
          electionId: ELECTION_ID,
          candidateName: "Greg Abbott",
          electionYear: 2026,
          officeScope: "statewide",
          officeName: "Governor",
          district: null,
          committeeId: "00012345",
          committeeName: "ABBOTT, GREG",
          sourceUrl: SOURCE_URL,
          lastSyncedAt: null,
        },
      ],
    });

    const sql = String(db.query.mock.calls[0]?.[0]);
    expect(sql).toContain("FROM public.tx_candidate_finance_links AS link");
    expect(sql).toContain("link.link_status = 'active'");
    expect(sql).toContain("district.state = 'TX'");
    expect(sql).toContain("election.race_type = 'office'");
    expect(sql).toContain("election.election_date >= (($1::timestamptz AT TIME ZONE 'UTC')::date - make_interval(days => $4::int))");
    expect(sql).toContain("candidate_election.status NOT IN ('withdrawn', 'lost')");
    expect(sql).toContain("(office.scope || '::' || office.canonical_name) = ANY($6::text[])");
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "2026-06-01T00:00:00.000Z",
      7,
      25,
      30,
      730,
      expect.arrayContaining(["statewide::Governor", "state_upper::State Senator"]),
    ]);
  });

  it("uses a one-day post-election grace window by default for due selection", async () => {
    const db = createMockDb();

    await syncDueTexasCandidateFinance({
      db,
      syncTexasCandidateFinanceFn: vi.fn(),
      now: new Date("2026-06-01T00:00:00.000Z"),
      autoLinkMissingLinks: false,
    });

    expect(String(db.query.mock.calls[0]?.[0])).toContain(
      "election.election_date >= (($1::timestamptz AT TIME ZONE 'UTC')::date - make_interval(days => $4::int))"
    );
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "2026-06-01T00:00:00.000Z",
      7,
      25,
      1,
      730,
      expect.arrayContaining(["statewide::Governor", "state_upper::State Senator"]),
    ]);
  });

  it("syncs selected due links with injected TEC rows", async () => {
    const db = createMockDb([dueRow()]);
    const data = tecData({
      receiptCommitteeIdsByCandidateElectionKey: new Map([[`${CANDIDATE_ID}\u0000${ELECTION_ID}`, ["00012345", "00051153"]]]),
    });
    const syncTexasCandidateFinanceFn = vi.fn().mockResolvedValue({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      electionYear: 2026,
      dryRun: false,
      resolution: { status: "matched", committeeId: "00012345" },
      linkWritten: true,
      summaryWritten: true,
      directBreakdownsWritten: 3,
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 2,
      totalReceipts: 100,
      directContributionTotal: 100,
      outsideSupportTotal: 1200,
      outsideOpposeTotal: 0,
      matchedContributionRowCount: 1,
      includedContributionRowCount: 1,
      skippedContributionRowCount: 0,
      matchedCandidateExpenditureRowCount: 1,
      includedCandidateExpenditureRowCount: 1,
      skippedCandidateExpenditureRowCount: 0,
      matchedOutsideContributionRowCount: 0,
      includedOutsideContributionRowCount: 0,
      skippedOutsideContributionRowCount: 0,
    });

    const result = await syncDueTexasCandidateFinance({
      db,
      syncTexasCandidateFinanceFn,
      now: new Date("2026-06-01T00:00:00.000Z"),
      maxCandidates: 2,
      staleAfterDays: 3,
      electionLookbackDays: 30,
      tecData: data,
      autoLinkMissingLinks: false,
    });

    expect(result).toMatchObject({
      dryRun: false,
      now: "2026-06-01T00:00:00.000Z",
      staleAfterDays: 3,
      maxCandidates: 2,
      dueCandidateCount: 1,
      selectedCandidateCount: 1,
      syncedCandidateCount: 1,
      failedCandidateCount: 0,
    });
    expect(result.results[0]).toMatchObject({
      ok: true,
      committeeId: "00012345",
      result: {
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        totalReceipts: 100,
      },
    });
    expect(syncTexasCandidateFinanceFn).toHaveBeenCalledTimes(1);
    expect(syncTexasCandidateFinanceFn).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        candidateName: "Greg Abbott",
        electionYear: 2026,
        officeScope: "statewide",
        officeName: "Governor",
        district: null,
        sourceUrl: SOURCE_URL,
        contributionSourceUrl: SOURCE_URL,
        outsideSourceUrl: SOURCE_URL,
        contributionRows: data.contributionRows,
        candidateRows: data.candidateRows,
        expenditureRows: data.expenditureRows,
        spacRows: data.spacRows,
        purposeRows: data.purposeRows,
        committeeRegistryRows: data.filerRows,
        trustedCommittee: {
          committeeId: "00012345",
          committeeName: "ABBOTT, GREG",
          receiptCommitteeIds: ["00012345", "00051153"],
          sourceUrl: SOURCE_URL,
        },
      })
    );
  });

  it("records TEC artifact load failures instead of calling the candidate sync", async () => {
    const db = createMockDb([dueRow()]);
    const syncTexasCandidateFinanceFn = vi.fn();

    const result = await syncDueTexasCandidateFinance({
      db,
      syncTexasCandidateFinanceFn,
      now: new Date("2026-06-01T00:00:00.000Z"),
      rawDataCacheDir: "/tmp/missing-texas-tec-cache",
      autoLinkMissingLinks: false,
    });

    expect(result).toMatchObject({
      dueCandidateCount: 1,
      selectedCandidateCount: 1,
      syncedCandidateCount: 0,
      failedCandidateCount: 1,
    });
    expect(result.results[0]).toMatchObject({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      committeeId: "00012345",
      ok: false,
    });
    expect(result.results[0]?.error).toContain("Texas TEC CSV database ZIP not found");
    expect(syncTexasCandidateFinanceFn).not.toHaveBeenCalled();
  });

  it("auto-links missing Texas finance links before listing due rows", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        const text = String(sql);
        if (text.includes("FROM public.candidate_elections AS candidate_election")) {
          return {
            rows: [
              {
                candidate_id: CANDIDATE_ID,
                election_id: ELECTION_ID,
                candidate_name: "Greg Abbott",
                election_year: 2026,
                office_scope: "statewide",
                office_name: "Governor",
                district: null,
              },
            ],
            rowCount: 1,
          };
        }
        if (text.includes("INSERT INTO public.tx_candidate_finance_links")) {
          return { rows: [{ id: "link-1" }], rowCount: 1 };
        }
        if (text.includes("FROM public.tx_candidate_finance_links AS link")) {
          return {
            rows: [dueRow()],
            rowCount: 1,
          };
        }
        throw new Error(`Unexpected query: ${text}`);
      }),
    };
    const syncTexasCandidateFinanceFn = vi.fn().mockResolvedValue({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      electionYear: 2026,
      dryRun: false,
      resolution: { status: "matched", committeeId: "00012345" },
      linkWritten: true,
      summaryWritten: true,
      directBreakdownsWritten: 3,
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 2,
      totalReceipts: 100,
      directContributionTotal: 100,
      outsideSupportTotal: 1200,
      outsideOpposeTotal: 0,
      matchedContributionRowCount: 1,
      includedContributionRowCount: 1,
      skippedContributionRowCount: 0,
      matchedCandidateExpenditureRowCount: 1,
      includedCandidateExpenditureRowCount: 1,
      skippedCandidateExpenditureRowCount: 0,
      matchedOutsideContributionRowCount: 0,
      includedOutsideContributionRowCount: 0,
      skippedOutsideContributionRowCount: 0,
    });

    const result = await syncDueTexasCandidateFinance({
      db,
      syncTexasCandidateFinanceFn,
      now: new Date("2026-06-01T00:00:00.000Z"),
      tecData: tecData({
        filerRows: [filer()],
      }),
    });

    expect(result).toMatchObject({
      dueCandidateCount: 1,
      selectedCandidateCount: 1,
      syncedCandidateCount: 1,
      failedCandidateCount: 0,
    });
    expect(db.query).toHaveBeenCalledTimes(3);
    expect(String(db.query.mock.calls[0]?.[0])).toContain("FROM public.candidate_elections AS candidate_election");
    expect(String(db.query.mock.calls[1]?.[0])).toContain("INSERT INTO public.tx_candidate_finance_links");
    expect(String(db.query.mock.calls[2]?.[0])).toContain("FROM public.tx_candidate_finance_links AS link");
    expect(syncTexasCandidateFinanceFn).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        electionYear: 2026,
        trustedCommittee: expect.objectContaining({
          committeeId: "00012345",
          committeeName: "ABBOTT, GREG",
        }),
      })
    );
  });

  it("validates positive integer options", async () => {
    const db = createMockDb();

    await expect(
      syncDueTexasCandidateFinance({
        db,
        maxCandidates: 0,
        autoLinkMissingLinks: false,
      })
    ).rejects.toThrow("Invalid Texas finance batch sync maxCandidates");
    await expect(
      syncDueTexasCandidateFinance({
        db,
        staleAfterDays: -1,
        autoLinkMissingLinks: false,
      })
    ).rejects.toThrow("Invalid Texas finance batch sync staleAfterDays");
  });
});
