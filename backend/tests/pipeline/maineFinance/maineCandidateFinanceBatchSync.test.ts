import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  listDueMaineCandidateFinanceSyncRows,
  syncDueMaineCandidateFinance,
  type MaineContributionDataForYear,
  type MaineExpenditureDataForYear,
} from "../../../src/pipeline/maineFinance/maineCandidateFinanceBatchSync.js";
import {
  getMaineCfisArtifactCachePaths,
  refreshMaineCfisArtifactCache,
} from "../../../src/pipeline/maineFinance/maineCfisArtifactCache.js";
import {
  MAINE_CFIS_CONTRIBUTION_COLUMNS,
  type MaineCfisContributionRow,
  type MaineCfisExpenditureRow,
} from "../../../src/pipeline/maineFinance/maineCfisArtifactReader.js";

const CANDIDATE_ID = "11111111-1111-1111-1111-111111111111";
const ELECTION_ID = "22222222-2222-2222-2222-222222222222";
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "voteapp-me-batch-sync-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function contribution(
  overrides: Partial<MaineCfisContributionRow> = {},
): MaineCfisContributionRow {
  return {
    OrgID: "1001",
    LegacyID: "618",
    "Committee Name": "Paul for Maine",
    "Candidate Name": "Reagan LeeAnn Paul",
    "Receipt Amount": "100.0000",
    "Receipt Date": "03/11/2024",
    Office: "Representative",
    District: "37",
    "Last Name": "Voter",
    "First Name": "Pat",
    "Middle Name": "",
    Suffix: "",
    Address1: "100 Main St",
    Address2: "",
    City: "Augusta",
    State: "ME",
    Zip: "04330",
    Description: "",
    "Receipt ID": "R-1",
    "Filed Date": "03/15/2024",
    "Report Name": "2024 Pre-General",
    "Receipt Source Type": "Individual",
    "Receipt Type": "Monetary (Itemized)",
    "Committee Type": "Candidate Committee",
    Amended: "N",
    Employer: "LARGAY LAW OFFICES, P.A.",
    Occupation: "Attorney/Legal",
    "Occupation Comment": "",
    "Employment Information Requested": "N",
    "Forgiven Loan": "N",
    ElectionType: "General",
    ...overrides,
  };
}

function expenditure(
  overrides: Partial<MaineCfisExpenditureRow> = {},
): MaineCfisExpenditureRow {
  return {
    "Election Year": "2024",
    OrgID: "242",
    LegacyID: "611",
    "Committee Type": "Political Action Committee",
    "Committee Name": "ASSOCIATED BUILDERS AND CONTRACTORS OF MAINE PAC",
    "Candidate Name": "",
    Jurisdiction: "STATE",
    Office: "",
    District: "",
    Party: "",
    IncumbentStatus: "",
    "Financing Type": "",
    "Payee Last Name": "MEDIA VENDOR LLC",
    "Payee First Name": "",
    "Payee Middle Name": "",
    Suffix: "",
    Address1: "100 Main St",
    Address2: "",
    City: "Augusta",
    State: "ME",
    Zip: "04330",
    "Expenditure ID": "E-1",
    "Expenditure Date": "10/03/2024",
    "Expenditure Purpose": "Independent Expenditure",
    "Expenditure Amount": "1600.0000",
    Explanation: "Digital ads",
    "Date Filed": "10/04/2024",
    Amended: "N",
    "IE Report": "Y",
    "24-Hour Report": "Y",
    "Report Name": "2024 24-Hour IE",
    "Operating Expense": "N",
    "Support/Oppose Ballot Question": "",
    "Support/Oppose Candidate": "Support",
    "Ballot Question Number": "",
    "Ballot Question Description/Title": "",
    Candidate: "Paul, Reagan LeeAnn",
    "Candidate ID": "481737",
    "Candidate Jurisdiction": "STATE",
    "Candidate Office": "Representative",
    "Candidate District": "37",
    "Candidate Party": "Republican",
    "Candidate IncumbentStatus": "",
    "Candidate Financing Type": "",
    ...overrides,
  };
}

function contributionCsv(rows: readonly MaineCfisContributionRow[]): string {
  const escape = (value: string): string =>
    /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const lines = rows.map((row) =>
    MAINE_CFIS_CONTRIBUTION_COLUMNS.map((column) =>
      escape(row[column] ?? ""),
    ).join(","),
  );
  return (
    [MAINE_CFIS_CONTRIBUTION_COLUMNS.join(","), ...lines].join("\n") + "\n"
  );
}

async function writeContributionArtifact(input: {
  cacheDir: string;
  filingYear: number;
  rows: readonly MaineCfisContributionRow[];
}): Promise<void> {
  const paths = getMaineCfisArtifactCachePaths({
    cacheDir: input.cacheDir,
    filingYear: input.filingYear,
    artifactKind: "contributions",
  });
  const csv = contributionCsv(input.rows);
  await writeFile(paths.filePath, csv, "utf8");
  await writeFile(
    paths.metadataPath,
    JSON.stringify({
      version: 1,
      artifact: { filingYear: input.filingYear, artifactKind: "contributions" },
      filePath: paths.filePath,
      metadataPath: paths.metadataPath,
      downloadedAt: "2026-06-25T00:00:00.000Z",
      remote: {
        filingYear: input.filingYear,
        artifactKind: "contributions",
        url: "https://mainecampaignfinance.com/api/DataDownload/CSVDownloadReport",
        requestBody: { year: input.filingYear, transactionType: "CON" },
        contentLength: Buffer.byteLength(csv, "utf8"),
        contentType: "application/octet-stream",
        contentDisposition: `attachment; filename=CON_${input.filingYear}.csv`,
        etag: null,
        lastModified: null,
      },
      bytesWritten: Buffer.byteLength(csv, "utf8"),
    }),
    "utf8",
  );
}

function dueDbRow() {
  return {
    candidate_id: CANDIDATE_ID,
    election_id: ELECTION_ID,
    candidate_name: "Reagan LeeAnn Paul",
    election_year: 2024,
    office_scope: "state_lower",
    office_name: "Representative",
    district: "37",
    committee_id: "1001",
    committee_name: "Paul for Maine",
    source_url: "https://mainecampaignfinance.com/",
    last_synced_at: null,
    total_due_rows: "1",
  };
}

describe("maineCandidateFinanceBatchSync", () => {
  it("lists due Maine candidate finance rows", async () => {
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [dueDbRow()] }),
    };

    await expect(
      listDueMaineCandidateFinanceSyncRows(db, {
        now: new Date("2026-06-25T12:00:00.000Z"),
        staleAfterDays: 7,
        maxCandidates: 10,
        electionLookbackDays: 1,
        electionLookaheadDays: 730,
      }),
    ).resolves.toEqual({
      rows: [
        {
          candidateId: CANDIDATE_ID,
          electionId: ELECTION_ID,
          candidateName: "Reagan LeeAnn Paul",
          electionYear: 2024,
          officeScope: "state_lower",
          officeName: "Representative",
          district: "37",
          committeeId: "1001",
          committeeName: "Paul for Maine",
          sourceUrl: "https://mainecampaignfinance.com/",
          lastSyncedAt: null,
        },
      ],
      totalDueRows: 1,
    });
    const sql = String(db.query.mock.calls[0]?.[0]);
    expect(sql).toContain("FROM public.me_candidate_finance_links AS link");
    expect(sql).toContain("district.state = 'ME'");
  });

  it("syncs due Maine candidates with injected contribution and expenditure rows", async () => {
    const contributionRows = [
      contribution(),
      contribution({
        OrgID: "242",
        "Committee Name": "ASSOCIATED BUILDERS AND CONTRACTORS OF MAINE PAC",
        "Candidate Name": "",
        "Receipt ID": "PAC-1",
        "Last Name": "OLD CONSTRUCTION COMPANY LLC",
        "First Name": "",
        "Receipt Source Type": "Business/Organization",
        "Committee Type": "Political Action Committee",
      }),
    ];
    const contributionData: MaineContributionDataForYear = {
      year: 2024,
      filePath: "/tmp/CON_2024.csv",
      sourceUrl:
        "https://mainecampaignfinance.com/api/DataDownload/CSVDownloadReport",
      rowsByCommitteeId: new Map([
        ["1001", [contributionRows[0] as MaineCfisContributionRow]],
        ["242", [contributionRows[1] as MaineCfisContributionRow]],
      ]),
    };
    const expenditureData: MaineExpenditureDataForYear = {
      year: 2024,
      filePath: "/tmp/EXP_2024.csv",
      sourceUrl:
        "https://mainecampaignfinance.com/api/DataDownload/CSVDownloadReport",
      rows: [expenditure()],
    };
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [dueDbRow()] }),
      connect: vi.fn(),
    };
    const syncResult = {
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      electionYear: 2024,
      dryRun: false,
      resolution: { status: "matched", committeeId: "1001" },
      linkWritten: true,
      summaryWritten: true,
      directBreakdownsWritten: 2,
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 2,
      totalReceipts: 100,
      directContributionTotal: 100,
      outsideSupportTotal: 1600,
      outsideOpposeTotal: 0,
      matchedContributionRowCount: 1,
      includedContributionRowCount: 1,
      skippedContributionRowCount: 0,
      matchedExpenditureRowCount: 1,
      includedExpenditureRowCount: 1,
      skippedExpenditureRowCount: 0,
      matchedOutsideContributionRowCount: 1,
      includedOutsideContributionRowCount: 1,
      skippedOutsideContributionRowCount: 0,
    };
    const syncFn = vi.fn().mockResolvedValue(syncResult);

    const result = await syncDueMaineCandidateFinance({
      sourceMode: "legacy",
      db,
      now: new Date("2026-06-25T12:00:00.000Z"),
      maxCandidates: 10,
      staleAfterDays: 7,
      autoLinkMissingLinks: false,
      contributionDataByYear: new Map([[2024, contributionData]]),
      expenditureDataByYear: new Map([[2024, expenditureData]]),
      syncMaineCandidateFinanceFn: syncFn,
    });

    expect(result).toEqual({
      dryRun: false,
      now: "2026-06-25T12:00:00.000Z",
      staleAfterDays: 7,
      maxCandidates: 10,
      dueCandidateCount: 1,
      selectedCandidateCount: 1,
      syncedCandidateCount: 1,
      failedCandidateCount: 0,
      results: [
        {
          candidateId: CANDIDATE_ID,
          electionId: ELECTION_ID,
          electionYear: 2024,
          committeeId: "1001",
          ok: true,
          result: syncResult,
        },
      ],
    });
    expect(syncFn).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        candidateName: "Reagan LeeAnn Paul",
        electionYear: 2024,
        officeScope: "state_lower",
        officeName: "Representative",
        district: "37",
        contributionRows,
        expenditureRows: expenditureData.rows,
        trustedCommittee: {
          committeeId: "1001",
          committeeName: "Paul for Maine",
          sourceUrl: "https://mainecampaignfinance.com/",
        },
      }),
    );
  });

  it("merges cached artifacts from both cycle filing years into one sync", async () => {
    // Maine CFIS keys bulk files by receipt year: money for a 2024 election is
    // split across CON_2023 and CON_2024. Both must reach the sync.
    const rawDataCacheDir = await makeTempDir();
    const duplicateAcrossYears = contribution({
      "Receipt ID": "R-BOTH",
      "Receipt Date": "12/20/2023",
      "Receipt Amount": "50.0000",
    });
    await writeContributionArtifact({
      cacheDir: rawDataCacheDir,
      filingYear: 2023,
      rows: [
        contribution({ "Receipt ID": "R-2023", "Receipt Date": "12/15/2023" }),
        duplicateAcrossYears,
      ],
    });
    await writeContributionArtifact({
      cacheDir: rawDataCacheDir,
      filingYear: 2024,
      rows: [
        contribution({ "Receipt ID": "R-2024", "Receipt Date": "03/11/2024" }),
        { ...duplicateAcrossYears, "Filed Date": "03/20/2024" },
      ],
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [dueDbRow()] }),
      connect: vi.fn(),
    };
    const syncFn = vi.fn().mockResolvedValue({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      electionYear: 2024,
      dryRun: false,
    });

    const result = await syncDueMaineCandidateFinance({
      sourceMode: "legacy",
      db,
      now: new Date("2026-06-25T12:00:00.000Z"),
      maxCandidates: 10,
      staleAfterDays: 7,
      autoLinkMissingLinks: false,
      rawDataCacheDir,
      syncMaineCandidateFinanceFn: syncFn,
    });

    expect(result.syncedCandidateCount).toBe(1);
    expect(syncFn).toHaveBeenCalledTimes(1);
    const receiptIds = (
      syncFn.mock.calls[0]?.[0]?.contributionRows as MaineCfisContributionRow[]
    ).map((row) => row["Receipt ID"]);
    expect(receiptIds.sort()).toEqual(["R-2023", "R-2024", "R-BOTH"]);
    expect(
      (
        syncFn.mock.calls[0]?.[0]
          ?.contributionRows as MaineCfisContributionRow[]
      ).find((row) => row["Receipt ID"] === "R-BOTH")?.["Filed Date"],
    ).toBe("03/20/2024");
  });

  it("reads artifacts written by the real cache refresher (scheduler/script path)", async () => {
    // End-to-end guarantee for the refresh -> sync chain: artifacts written by
    // refreshMaineCfisArtifactCache (what the scheduler job and refresh script
    // run) must satisfy the cycle loader's metadata validation.
    const rawDataCacheDir = await makeTempDir();
    const csvByYear = new Map<number, string>([
      [
        2023,
        contributionCsv([
          contribution({
            "Receipt ID": "R-2023",
            "Receipt Date": "12/15/2023",
          }),
        ]),
      ],
      [
        2024,
        contributionCsv([
          contribution({
            "Receipt ID": "R-2024",
            "Receipt Date": "03/11/2024",
          }),
        ]),
      ],
    ]);
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { year: number };
      const csv = csvByYear.get(body.year);
      if (!csv) {
        throw new Error(`Unexpected Maine CFIS request year: ${body.year}`);
      }
      return new Response(csv, { status: 200 });
    };
    for (const filingYear of [2023, 2024]) {
      await refreshMaineCfisArtifactCache({
        filingYear,
        artifactKind: "contributions",
        cacheDir: rawDataCacheDir,
        fetchImpl,
      });
    }
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [dueDbRow()] }),
      connect: vi.fn(),
    };
    const syncFn = vi.fn().mockResolvedValue({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      electionYear: 2024,
      dryRun: false,
    });

    const result = await syncDueMaineCandidateFinance({
      sourceMode: "legacy",
      db,
      now: new Date("2026-06-25T12:00:00.000Z"),
      maxCandidates: 10,
      staleAfterDays: 7,
      autoLinkMissingLinks: false,
      rawDataCacheDir,
      syncMaineCandidateFinanceFn: syncFn,
    });

    expect(result.syncedCandidateCount).toBe(1);
    const receiptIds = (
      syncFn.mock.calls[0]?.[0]?.contributionRows as MaineCfisContributionRow[]
    ).map((row) => row["Receipt ID"]);
    expect(receiptIds.sort()).toEqual(["R-2023", "R-2024"]);
  });

  it("does not ingest cached raw artifacts without matching metadata", async () => {
    const rawDataCacheDir = await makeTempDir();
    // The cycle loader reads filing years [electionYear - 1, electionYear] in
    // order, so the first artifact it validates for a 2024 election is 2023.
    const paths = getMaineCfisArtifactCachePaths({
      cacheDir: rawDataCacheDir,
      filingYear: 2023,
      artifactKind: "contributions",
    });
    await writeFile(
      paths.filePath,
      "OrgID,Committee Name\n1001,Paul for Maine\n",
      "utf8",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [dueDbRow()] }),
      connect: vi.fn(),
    };
    const syncFn = vi.fn();

    const result = await syncDueMaineCandidateFinance({
      sourceMode: "legacy",
      db,
      now: new Date("2026-06-25T12:00:00.000Z"),
      maxCandidates: 10,
      staleAfterDays: 7,
      autoLinkMissingLinks: false,
      rawDataCacheDir,
      syncMaineCandidateFinanceFn: syncFn,
    });

    expect(result.failedCandidateCount).toBe(1);
    expect(result.results[0]).toMatchObject({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      ok: false,
      error: expect.stringContaining("artifact metadata missing or invalid"),
    });
    expect(syncFn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "Maine CFIS expenditure artifact unavailable; syncing direct finance without outside spending:",
      expect.stringContaining("Maine CFIS expenditure artifact not found"),
    );
  });
});
