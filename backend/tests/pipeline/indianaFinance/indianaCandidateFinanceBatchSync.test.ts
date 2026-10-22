import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  listDueIndianaCandidateFinanceSyncRows,
  syncDueIndianaCandidateFinance,
  type IndianaContributionDataForYear,
} from "../../../src/pipeline/indianaFinance/indianaCandidateFinanceBatchSync.js";
import { getIndianaCampaignFinanceArtifactCachePaths } from "../../../src/pipeline/indianaFinance/indianaCampaignFinanceArtifactCache.js";
import {
  INDIANA_CAMPAIGN_FINANCE_CONTRIBUTION_COLUMNS,
  indianaCampaignFinanceCsvFileName,
  type IndianaCampaignFinanceContributionRow,
} from "../../../src/pipeline/indianaFinance/indianaCampaignFinanceReader.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function contributionCsv(rows: readonly IndianaCampaignFinanceContributionRow[]): string {
  const escape = (value: string): string => (/[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  return [
    INDIANA_CAMPAIGN_FINANCE_CONTRIBUTION_COLUMNS.join(","),
    ...rows.map((row) =>
      INDIANA_CAMPAIGN_FINANCE_CONTRIBUTION_COLUMNS.map((column) => escape(row[column])).join(",")
    ),
  ].join("\n");
}

async function writeContributionArtifact(cacheDir: string, year: number, rows: readonly IndianaCampaignFinanceContributionRow[]) {
  const paths = getIndianaCampaignFinanceArtifactCachePaths({ cacheDir, year, artifactKind: "contribution" });
  const memberName = indianaCampaignFinanceCsvFileName({ year, artifactKind: "contribution" });
  await writeFile(paths.zipPath, Buffer.from(zipSync({ [memberName]: strToU8(contributionCsv(rows)) })));
}

function createMockDb(rows: unknown[] = []) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  };
}

function contribution(overrides: Partial<IndianaCampaignFinanceContributionRow> = {}): IndianaCampaignFinanceContributionRow {
  return {
    FileNumber: "422",
    CommitteeType: "Candidate",
    Committee: "Diego for Indiana",
    CandidateName: "Cesar Diego Morales",
    ContributorType: "Individual",
    Name: "Jane Doe",
    Address: "100 Main St",
    City: "Indianapolis",
    State: "IN",
    Zip: "46204",
    Occupation: "Attorney/Legal",
    Type: "Direct",
    Description: "",
    Amount: "250.0000",
    ContributionDate: "2026-02-17 00:00:00",
    Received_By: "Treasurer",
    Amended: "0",
    ...overrides,
  };
}

function contributionDataForYear(input: {
  year: number;
  sourceUrl?: string;
  rows?: IndianaCampaignFinanceContributionRow[];
  rowsByCommitteeId: Map<string, IndianaCampaignFinanceContributionRow[]>;
}): IndianaContributionDataForYear {
  const rows = input.rows ?? [...input.rowsByCommitteeId.values()].flat();
  return {
    year: input.year,
    zipPath: `/tmp/${input.year}_ContributionData.csv.zip`,
    sourceUrl:
      input.sourceUrl ??
      `https://campaignfinance.in.gov/PublicSite/Docs/BulkDataDownloads/${input.year}_ContributionData.csv.zip`,
    rows,
    rowsByCommitteeId: input.rowsByCommitteeId,
  };
}

describe("indianaCandidateFinanceBatchSync", () => {
  it.each([false, true])("isolates native discovery failures unless native-only=%s", async (nativePacOnly) => {
    vi.stubEnv("INDIANA_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("INDIANA_NATIVE_PAC_ENABLED", "true");
    const error = new Error("native due query timeout");
    const db = {
      connect: vi.fn(),
      query: vi.fn(async (sql: string) => {
        if (sql.includes("in_native_pac_sources")) throw error;
        return { rows: [{
          candidate_id: CANDIDATE_ID, election_id: ELECTION_ID,
          candidate_name: "Cesar Diego Morales", election_year: 2026,
          office_scope: "state_upper", office_name: "State Senator", district: "30",
          committee_id: "422", committee_name: "Diego for Indiana",
          source_url: null, last_synced_at: null, total_due_rows: "1",
        }] };
      }),
    };
    const sync = vi.fn().mockResolvedValue({ summaryWritten: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pending = syncDueIndianaCandidateFinance({
      db: db as never, nativePacOnly, autoLinkMissingLinks: false,
      now: new Date("2026-10-21T12:00:00.000Z"),
      syncIndianaCandidateFinanceFn: sync,
      contributionDataByYear: new Map([[2026, contributionDataForYear({
        year: 2026, rowsByCommitteeId: new Map([["422", [contribution()]]]),
      })]]),
    });
    if (nativePacOnly) {
      await expect(pending).rejects.toBe(error);
      expect(sync).not.toHaveBeenCalled();
      expect(db.query).toHaveBeenCalledTimes(1);
    } else {
      expect(await pending).toMatchObject({ syncedCandidateCount: 1, failedCandidateCount: 0 });
      expect(sync).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        "Indiana native PAC sync failed; continuing with legacy finance:", error.message,
      );
    }
  });
  it("lists due Indiana finance sync rows from explicit active links", async () => {
    const db = createMockDb([
      {
        candidate_id: CANDIDATE_ID,
        election_id: ELECTION_ID,
        candidate_name: "Cesar Diego Morales",
        election_year: 2026,
        office_scope: "state_upper",
        office_name: "State Senator",
        district: "30",
        committee_id: "422",
        committee_name: "Diego for Indiana",
        source_url: "https://campaignfinance.in.gov/PublicSite/Reporting/DataDownload.aspx",
        last_synced_at: null,
        total_due_rows: "1",
      },
    ]);

    const result = await listDueIndianaCandidateFinanceSyncRows(db, {
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
          candidateName: "Cesar Diego Morales",
          electionYear: 2026,
          officeScope: "state_upper",
          officeName: "State Senator",
          district: "30",
          committeeId: "422",
          committeeName: "Diego for Indiana",
          sourceUrl: "https://campaignfinance.in.gov/PublicSite/Reporting/DataDownload.aspx",
          lastSyncedAt: null,
        },
      ],
    });

    const sql = String(db.query.mock.calls[0]?.[0]);
    expect(sql).toContain("FROM public.in_candidate_finance_links AS link");
    expect(sql).toContain("link.link_status = 'active'");
    expect(sql).toContain("district.state = 'IN'");
    expect(sql).toContain("election.race_type = 'office'");
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

  it("syncs selected due links with cached yearly contribution rows and continues after failures", async () => {
    const db = createMockDb([
      {
        candidate_id: CANDIDATE_ID,
        election_id: ELECTION_ID,
        candidate_name: "Cesar Diego Morales",
        election_year: 2026,
        office_scope: "state_upper",
        office_name: "State Senator",
        district: "30",
        committee_id: "422",
        committee_name: "Diego for Indiana",
        source_url: "https://campaignfinance.in.gov/PublicSite/Reporting/DataDownload.aspx",
        last_synced_at: null,
        total_due_rows: "2",
      },
      {
        candidate_id: "33333333-3333-4333-8333-333333333333",
        election_id: "44444444-4444-4444-8444-444444444444",
        candidate_name: "Jane Doe",
        election_year: 2026,
        office_scope: "statewide",
        office_name: "Governor",
        district: null,
        committee_id: "9001",
        committee_name: "DOE FOR GOVERNOR",
        source_url: null,
        last_synced_at: null,
        total_due_rows: "2",
      },
    ]);
    const syncIndianaCandidateFinanceFn = vi
      .fn()
      .mockResolvedValueOnce({
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        electionYear: 2026,
        dryRun: false,
        resolution: { status: "matched", committeeId: "422" },
        linkWritten: true,
        summaryWritten: true,
        directBreakdownsWritten: 3,
        totalReceipts: 100,
        directContributionTotal: 90,
        matchedContributionRowCount: 1,
        includedContributionRowCount: 1,
        skippedContributionRowCount: 0,
      })
      .mockRejectedValueOnce(new Error("Indiana row parse failed"));
    const row = contribution({ FileNumber: "422", Amount: "100.0000" });
    const pacRow = contribution({
      FileNumber: "777",
      CommitteeType: "Political Action Committee",
      Committee: "HOOSIERS PAC",
      CandidateName: "",
      ContributorType: "Organization",
      Name: "Acme Health",
      Amount: "500.0000",
    });

    const result = await syncDueIndianaCandidateFinance({
      db,
      syncIndianaCandidateFinanceFn,
      now: new Date("2026-06-01T00:00:00.000Z"),
      maxCandidates: 2,
      staleAfterDays: 3,
      electionLookbackDays: 30,
      autoLinkMissingLinks: false,
      contributionDataByYear: new Map([
        [
          2026,
          contributionDataForYear({
            year: 2026,
            rows: [row, pacRow],
            rowsByCommitteeId: new Map([["422", [row]]]),
          }),
        ],
      ]),
    });

    expect(result).toMatchObject({
      dryRun: false,
      now: "2026-06-01T00:00:00.000Z",
      staleAfterDays: 3,
      maxCandidates: 2,
      dueCandidateCount: 2,
      selectedCandidateCount: 2,
      syncedCandidateCount: 1,
      failedCandidateCount: 1,
    });
    expect(result.results[0]).toMatchObject({
      ok: true,
      committeeId: "422",
      result: {
        totalReceipts: 100,
        directContributionTotal: 90,
      },
    });
    expect(result.results[1]).toMatchObject({
      ok: false,
      committeeId: "9001",
      error: "Indiana row parse failed",
    });
    expect(syncIndianaCandidateFinanceFn).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        candidateName: "Cesar Diego Morales",
        electionYear: 2026,
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "30",
        linkedCommittee: {
          committeeId: "422",
          committeeName: "Diego for Indiana",
        },
        sourceUrl: "https://campaignfinance.in.gov/PublicSite/Reporting/DataDownload.aspx",
        contributionRows: [row, pacRow],
        contributionSourceUrl:
          "https://campaignfinance.in.gov/PublicSite/Docs/BulkDataDownloads/2026_ContributionData.csv.zip",
      })
    );
  });

  it("records artifact load failures per year without blocking other due years", async () => {
    const successfulCandidateId = "55555555-5555-4555-8555-555555555555";
    const successfulElectionId = "66666666-6666-4666-8666-666666666666";
    const db = createMockDb([
      {
        candidate_id: CANDIDATE_ID,
        election_id: ELECTION_ID,
        candidate_name: "Cesar Diego Morales",
        election_year: 2025,
        office_scope: "state_upper",
        office_name: "State Senator",
        district: "30",
        committee_id: "422",
        committee_name: "Diego for Indiana",
        source_url: null,
        last_synced_at: null,
        total_due_rows: "2",
      },
      {
        candidate_id: successfulCandidateId,
        election_id: successfulElectionId,
        candidate_name: "Jane Doe",
        election_year: 2026,
        office_scope: "statewide",
        office_name: "Governor",
        district: null,
        committee_id: "9001",
        committee_name: "DOE FOR GOVERNOR",
        source_url: null,
        last_synced_at: null,
        total_due_rows: "2",
      },
    ]);
    const row = contribution({ FileNumber: "9001", Amount: "100.0000" });
    const syncIndianaCandidateFinanceFn = vi.fn().mockResolvedValue({
      candidateId: successfulCandidateId,
      electionId: successfulElectionId,
      electionYear: 2026,
      dryRun: false,
      resolution: { status: "matched", committeeId: "9001" },
      linkWritten: true,
      summaryWritten: true,
      directBreakdownsWritten: 3,
      totalReceipts: 100,
      directContributionTotal: 90,
      matchedContributionRowCount: 1,
      includedContributionRowCount: 1,
      skippedContributionRowCount: 0,
    });

    const result = await syncDueIndianaCandidateFinance({
      db,
      syncIndianaCandidateFinanceFn,
      now: new Date("2026-06-01T00:00:00.000Z"),
      rawDataCacheDir: "/tmp/voteapp-missing-indiana-campaign-finance-cache",
      autoLinkMissingLinks: false,
      contributionDataByYear: new Map([
        [
          2026,
          contributionDataForYear({
            year: 2026,
            rows: [row],
            rowsByCommitteeId: new Map([["9001", [row]]]),
          }),
        ],
      ]),
    });

    expect(result).toMatchObject({
      selectedCandidateCount: 2,
      syncedCandidateCount: 1,
      failedCandidateCount: 1,
    });
    expect(result.results[0]).toMatchObject({
      ok: false,
      candidateId: CANDIDATE_ID,
      electionYear: 2025,
      committeeId: "422",
    });
    expect(result.results[0]?.error).toContain("Indiana campaign finance contribution ZIP not found for 2024");
    expect(result.results[1]).toMatchObject({
      ok: true,
      candidateId: successfulCandidateId,
      electionYear: 2026,
      committeeId: "9001",
    });
    expect(syncIndianaCandidateFinanceFn).toHaveBeenCalledTimes(1);
  });

  it("auto-links missing candidates before listing due rows", async () => {
    const row = contribution({ FileNumber: "422", Amount: "100.0000" });
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              candidate_id: CANDIDATE_ID,
              election_id: ELECTION_ID,
              candidate_name: "Cesar Diego Morales",
              election_year: 2026,
              office_scope: "state_upper",
              office_name: "State Senator",
              district: "30",
            },
          ],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [{ id: "link-1" }], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [
            {
              candidate_id: CANDIDATE_ID,
              election_id: ELECTION_ID,
              candidate_name: "Cesar Diego Morales",
              election_year: 2026,
              office_scope: "state_upper",
              office_name: "State Senator",
              district: "30",
              committee_id: "422",
              committee_name: "Diego for Indiana",
              source_url: "https://campaignfinance.in.gov/PublicSite/Reporting/DataDownload.aspx",
              last_synced_at: null,
              total_due_rows: "1",
            },
          ],
          rowCount: 1,
        }),
    };
    const syncIndianaCandidateFinanceFn = vi.fn().mockResolvedValue({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      electionYear: 2026,
      dryRun: false,
      resolution: { status: "matched", committeeId: "422" },
      linkWritten: true,
      summaryWritten: true,
      directBreakdownsWritten: 3,
      totalReceipts: 100,
      directContributionTotal: 90,
      matchedContributionRowCount: 1,
      includedContributionRowCount: 1,
      skippedContributionRowCount: 0,
    });

    const result = await syncDueIndianaCandidateFinance({
      db,
      syncIndianaCandidateFinanceFn,
      now: new Date("2026-06-01T00:00:00.000Z"),
      contributionDataByYear: new Map([
        [
          2026,
          contributionDataForYear({
            year: 2026,
            sourceUrl: "https://campaignfinance.in.gov/PublicSite/Reporting/DataDownload.aspx",
            rows: [row],
            rowsByCommitteeId: new Map([["422", [row]]]),
          }),
        ],
      ]),
    });

    expect(result).toMatchObject({
      dueCandidateCount: 1,
      selectedCandidateCount: 1,
      syncedCandidateCount: 1,
      failedCandidateCount: 0,
    });
    expect(db.query).toHaveBeenCalledTimes(3);
    expect(String(db.query.mock.calls[0]?.[0])).toContain("FROM public.candidate_elections AS candidate_election");
    expect(String(db.query.mock.calls[1]?.[0])).toContain("INSERT INTO public.in_candidate_finance_links");
    expect(String(db.query.mock.calls[2]?.[0])).toContain("FROM public.in_candidate_finance_links AS link");
    expect(syncIndianaCandidateFinanceFn).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        electionYear: 2026,
        linkedCommittee: {
          committeeId: "422",
          committeeName: "Diego for Indiana",
        },
        contributionRows: [row],
      })
    );
  });

  it("auto-links and syncs money found only in the prior cycle-year artifact", async () => {
    const rawDataCacheDir = await mkdtemp(join(tmpdir(), "voteapp-in-cycle-"));
    tempDirs.push(rawDataCacheDir);
    const priorYearRow = contribution({
      Amount: "250.0000",
      ContributionDate: "2025-10-15 00:00:00",
      Description: "Prior-year receipt",
    });
    const duplicateAcrossYears = contribution({
      Amount: "50.0000",
      ContributionDate: "2025-11-15 00:00:00",
      Description: "Same official row in both exports",
    });
    await writeContributionArtifact(rawDataCacheDir, 2025, [priorYearRow, duplicateAcrossYears]);
    await writeContributionArtifact(rawDataCacheDir, 2026, [duplicateAcrossYears]);

    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{
            candidate_id: CANDIDATE_ID,
            election_id: ELECTION_ID,
            candidate_name: "Cesar Diego Morales",
            election_year: 2026,
            office_scope: "state_upper",
            office_name: "State Senator",
            district: "30",
          }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [{ id: "link-1" }], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [{
            candidate_id: CANDIDATE_ID,
            election_id: ELECTION_ID,
            candidate_name: "Cesar Diego Morales",
            election_year: 2026,
            office_scope: "state_upper",
            office_name: "State Senator",
            district: "30",
            committee_id: "422",
            committee_name: "Diego for Indiana",
            source_url: "https://campaignfinance.in.gov/PublicSite/Reporting/DataDownload.aspx",
            last_synced_at: null,
            total_due_rows: "1",
          }],
          rowCount: 1,
        }),
    };
    const syncFn = vi.fn().mockResolvedValue({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      electionYear: 2026,
      totalReceipts: 250,
      directContributionTotal: 250,
    });
    const result = await syncDueIndianaCandidateFinance({
      db,
      now: new Date("2026-06-01T00:00:00.000Z"),
      rawDataCacheDir,
      syncIndianaCandidateFinanceFn: syncFn,
    });
    expect(result).toMatchObject({ syncedCandidateCount: 1, failedCandidateCount: 0 });
    expect(String(db.query.mock.calls[1]?.[0])).toContain("INSERT INTO public.in_candidate_finance_links");
    expect(syncFn).toHaveBeenCalledWith(
      expect.objectContaining({
        contributionRows: [priorYearRow, duplicateAcrossYears],
        contributionSourceUrl: expect.stringContaining("/2025_ContributionData.csv.zip"),
      })
    );
  });
});
