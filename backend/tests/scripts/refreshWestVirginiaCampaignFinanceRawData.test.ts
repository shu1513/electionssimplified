import { describe, expect, it, vi } from "vitest";

import {
  parseRefreshWestVirginiaCampaignFinanceRawDataScriptArgs as parseArgs,
  runRefreshWestVirginiaCampaignFinanceRawDataScript,
} from "../../src/scripts/refreshWestVirginiaCampaignFinanceRawData.js";

const REPS_HEADER = "ElectionName,ReportingCycle,ReportingPeriodDescription,FormType,ReportType,BeginDate,Enddate,DueDate";
const SCHEDULE_CSV: Record<number, string> = {
  2025: `${REPS_HEADER}\n2026 Election,2026 Candidate Election Cycle,2025 3rd Quarter Report,Campaign Financial Statement,Quarterly,2025-07-01,2025-09-30,2025-10-07\n`,
  2026: `${REPS_HEADER}\n2026 Election,2026 Candidate Election Cycle,2026 General Report,Campaign Financial Statement,General,2026-10-01,2026-10-18,2026-10-23\n`,
  2027: `${REPS_HEADER}\n2026 Election,2026 Candidate Election Cycle,2026 4th Quarter Report,Campaign Financial Statement,Quarterly,2026-10-19,2026-12-31,2027-01-07\n`,
};

describe("refreshWestVirginiaCampaignFinanceRawData script", () => {
  it("parses the narrow raw-refresh contract", () => {
    expect(
      parseArgs(["--election-year=2026", "--election-year=2028", "--cache-dir=/cache", "--timeout-ms=5000", "--force"])
    ).toEqual({
      electionYears: [2026, 2028],
      cacheDir: "/cache",
      timeoutMs: 5000,
      force: true,
      acceptEmpty: false,
    });
    expect(parseArgs([])).toMatchObject({ electionYears: [new Date().getUTCFullYear()], force: false, acceptEmpty: false });
    expect(parseArgs(["--election-year=2026", "--election-year=2026"])).toMatchObject({ electionYears: [2026] });
  });

  it("rejects malformed and unknown arguments", () => {
    expect(() => parseArgs(["--election-year=26"])).toThrow("Invalid --election-year value");
    expect(() => parseArgs(["--election-year=2012"])).toThrow("Invalid West Virginia CFRS artifact year");
    expect(() => parseArgs(["--timeout-ms=0"])).toThrow("Invalid --timeout-ms value");
    expect(() => parseArgs(["--year=2026"])).toThrow("Unknown West Virginia CFRS raw data refresh flag");
    expect(() => parseArgs(["--force=true"])).toThrow("Boolean flag does not accept a value");
    expect(() => parseArgs(["--cache-dir=/a", "--cache-dir=/b"])).toThrow("Provide --cache-dir at most once");
  });

  it("rejects a flag given without a value instead of crashing on the missing token", () => {
    expect(() => parseArgs(["--cache-dir"])).toThrow("Missing --cache-dir value");
    expect(() => parseArgs(["--cache-dir", "--dry-run"])).toThrow("Missing --cache-dir value");
  });

  it("refreshes the three schedule files, resolves the window, then every window year's data artifacts", async () => {
    const refreshed: string[] = [];
    const fakeRefresh = (kind: string, year: number) => {
      refreshed.push(`${kind}:${year}`);
      return Promise.resolve({
        status: "downloaded" as const,
        cacheDir: "/cache",
        filePath: `/cache/${kind}_${year}`,
        metadataPath: `/cache/${kind}_${year}.metadata.json`,
        previous: null,
        current: {
          version: 1 as const,
          artifact: { kind, year },
          filePath: `/cache/${kind}_${year}`,
          metadataPath: `/cache/${kind}_${year}.metadata.json`,
          downloadedAt: "2026-09-01T00:00:00.000Z",
          source: { catalogId: null, s3ReportFilePath: null, dataType: null },
          bytes: 1,
          sha256: "0".repeat(64),
          recordCount: 1,
          recoveredRowCount: 0,
        },
      } as never);
    };
    const result = await runRefreshWestVirginiaCampaignFinanceRawDataScript({
      options: { electionYears: [2026], cacheDir: "/cache", force: true, acceptEmpty: false, timeoutMs: undefined },
      refreshRegistry: vi.fn(async () => ({
        status: "downloaded", filePath: "/cache/REGISTRY.hash.json",
        current: { recordCount: 2977, sha256: "1".repeat(64), downloadedAt: "2026-10-11T00:00:00Z", sourceUrl: "official-registry" },
      })) as never,
      refreshIE: vi.fn(async () => ({
        status: "downloaded", filePath: "/cache/ELECTRONIC_IE.hash.json",
        current: { scope: "electronic_regular_report_ie", years: [2025, 2026], recordCount: 1, sha256: "2".repeat(64), registrySha256: "1".repeat(64) },
      })) as never,
      fetchCatalog: vi.fn(async () => []),
      refreshBulk: vi.fn(async (input: { kind: string; year: number }) => fakeRefresh(input.kind, input.year)) as never,
      refreshApi: vi.fn(async (input: { year: number }) => fakeRefresh("api_contributions", input.year)) as never,
      readBulk: vi.fn(async (input: { year: number }) => ({ csvText: SCHEDULE_CSV[input.year]! })) as never,
    });
    expect(result.windows).toEqual([
      {
        election_year: 2026,
        reporting_cycle: "2026 Candidate Election Cycle",
        window_start: "2025-07-01",
        window_end: "2026-12-31",
        window_years: [2025, 2026],
      },
    ]);
    expect(refreshed).toEqual([
      "reporting_schedules:2025",
      "reporting_schedules:2026",
      "reporting_schedules:2027",
      "contributions:2025",
      "expenditures:2025",
      "api_contributions:2025",
      "contributions:2026",
      "expenditures:2026",
      "api_contributions:2026",
    ]);
    expect(result.artifacts).toHaveLength(9);
  });

  it("refreshes one year-independent registry snapshot across multiple election years", async () => {
    const refreshIE = vi.fn(async () => ({
      status: "downloaded", filePath: "/cache/ELECTRONIC_IE.hash.json",
      current: { scope: "electronic_regular_report_ie", years: [2025, 2026, 2027, 2028, 2029], recordCount: 1, sha256: "2".repeat(64), registrySha256: "1".repeat(64) },
    })) as never;
    const refreshRegistry = vi.fn(async () => ({
      status: "downloaded", filePath: "/cache/REGISTRY.hash.json",
      current: { recordCount: 2977, sha256: "1".repeat(64), downloadedAt: "2026-10-11T00:00:00Z", sourceUrl: "official-registry" },
    })) as never;
    const refreshBulk = vi.fn(async ({ kind, year }: { kind: string; year: number }) => ({
      status: "downloaded", filePath: `/cache/${kind}_${year}`,
      current: { artifact: { kind, year }, recordCount: 1, recoveredRowCount: 0, sha256: "0".repeat(64) },
    })) as never;
    const result = await runRefreshWestVirginiaCampaignFinanceRawDataScript({
      options: { electionYears: [2026, 2028], cacheDir: "/cache", force: true, acceptEmpty: false, timeoutMs: 1234 },
      clientOptions: { userAgent: "test-agent" },
      fetchCatalog: vi.fn(async () => []), refreshRegistry, refreshBulk, refreshIE,
      refreshApi: vi.fn(async ({ year }: { year: number }) => ({
        status: "downloaded", filePath: `/cache/api_${year}`,
        current: { artifact: { kind: "api_contributions", year }, recordCount: 1, recoveredRowCount: 0, sha256: "0".repeat(64) },
      })) as never,
      readBulk: vi.fn(async ({ year }: { year: number }) => ({
        csvText: `${REPS_HEADER}\n${year < 2027 ? 2026 : 2028} Election,${year < 2027 ? 2026 : 2028} Candidate Election Cycle,${year} Quarter,Campaign Financial Statement,Quarterly,${year}-01-01,${year}-12-31,${year + 1}-01-07\n`,
      })) as never,
    });
    expect(refreshIE).toHaveBeenCalledTimes(1);
    expect(refreshIE).toHaveBeenCalledWith({
      years: [2025, 2026, 2027, 2028, 2029], cacheDir: "/cache", clientOptions: { userAgent: "test-agent", timeoutMs: 1234 },
    });
    expect(result.electronic_ie).toMatchObject({ scope: "electronic_regular_report_ie", record_count: 1 });
    expect(refreshRegistry).toHaveBeenCalledTimes(1);
    expect(refreshRegistry).toHaveBeenCalledWith({ cacheDir: "/cache", clientOptions: { userAgent: "test-agent", timeoutMs: 1234 } });
    expect(result.registry).toEqual({ status: "downloaded", file_path: "/cache/REGISTRY.hash.json", record_count: 2977,
      sha256: "1".repeat(64), downloaded_at: "2026-10-11T00:00:00Z", source_url: "official-registry" });
    expect(result.registry).not.toHaveProperty("year");
    expect(result.artifacts.some((artifact) => String(artifact.kind) === "committee_registry")).toBe(false);
  });

  it("fails visibly before year artifacts when registry acquisition fails", async () => {
    const refreshBulk = vi.fn();
    await expect(runRefreshWestVirginiaCampaignFinanceRawDataScript({
      options: { electionYears: [2026], cacheDir: "/cache", force: true, acceptEmpty: true, timeoutMs: undefined },
      refreshIE: vi.fn(async () => ({
        status: "downloaded", filePath: "/cache/ELECTRONIC_IE.hash.json",
        current: { scope: "electronic_regular_report_ie", years: [2025, 2026], recordCount: 1, sha256: "2".repeat(64), registrySha256: "1".repeat(64) },
      })) as never,
      fetchCatalog: vi.fn(async () => []),
      refreshRegistry: vi.fn(async () => { throw new Error("registry source incomplete"); }),
      refreshBulk,
    })).rejects.toThrow("registry source incomplete");
    expect(refreshBulk).not.toHaveBeenCalled();
  });

  it("fails visibly after direct artifacts if the electronic IE generation is inconsistent", async () => {
    const refreshIE = vi.fn(async () => { throw new Error("IE generation changed"); });
    const bulk = vi.fn(async ({ kind, year }: { kind: string; year: number }) => ({
      status: "downloaded", filePath: "/cache/mock",
      current: { artifact: { kind, year }, recordCount: 1, recoveredRowCount: 0, sha256: "0".repeat(64) },
    })) as never;
    await expect(runRefreshWestVirginiaCampaignFinanceRawDataScript({
      options: { electionYears: [2026], cacheDir: "/cache", force: true, acceptEmpty: true, timeoutMs: undefined },
      fetchCatalog: vi.fn(async () => []),
      refreshRegistry: vi.fn(async () => ({ status: "downloaded", filePath: "/cache/registry",
        current: { recordCount: 1, sha256: "1".repeat(64), downloadedAt: "2026-10-11", sourceUrl: "official" } })) as never,
      refreshIE, refreshBulk: bulk,
      refreshApi: vi.fn(async ({ year }: { year: number }) => ({
        status: "downloaded", filePath: "/cache/api",
        current: { artifact: { kind: "api_contributions", year }, recordCount: 1, recoveredRowCount: 0, sha256: "0".repeat(64) },
      })) as never,
      readBulk: vi.fn(async ({ year }: { year: number }) => ({ csvText: SCHEDULE_CSV[year]! })) as never,
    })).rejects.toThrow("IE generation changed");
    expect(refreshIE).toHaveBeenCalledOnce();
    expect(bulk).toHaveBeenCalled();
  });

});
