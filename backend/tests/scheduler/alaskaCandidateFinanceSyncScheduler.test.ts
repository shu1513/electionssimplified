import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("alaskaCandidateFinanceSyncScheduler", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.ALASKA_CAMPAIGN_FINANCE_ENABLED;
    delete process.env.ALASKA_CAMPAIGN_FINANCE_SYNC_ENABLED;
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  function mockEnv(redisUrl = "redis://localhost:6379/0") {
    vi.doMock("../../src/config/env.js", () => ({
      getPipelineEnv: () => ({
        DATABASE_URL: "postgresql://localhost:5432/test",
        REDIS_URL: redisUrl,
        AI_PROVIDER: "openai",
        AI_MODEL: "gpt-5.4-mini",
        AI_TIMEOUT_MS: 90000,
        ANTHROPIC_WEB_SEARCH_MAX_USES: 3,
        STATE_RESOURCES_PROMPT_VERSION: "state_resources_v2",
        CENSUS_API_KEYS: [],
      }),
    }));
  }

  it("returns a disabled no-op result when the sync flag is off and not forced", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    process.env.ALASKA_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.ALASKA_CAMPAIGN_FINANCE_SYNC_ENABLED = "false";
    const Pool = vi.fn();
    vi.doMock("pg", () => ({ Pool }));

    const { runAlaskaCandidateFinanceSyncJob } = await import(
      "../../src/scheduler/alaskaCandidateFinanceSyncScheduler.js"
    );

    const result = await runAlaskaCandidateFinanceSyncJob({
      triggeredBy: "daily",
      maxCandidates: 10,
      staleAfterDays: 7,
    });

    expect(result).toEqual({
      enabled: false,
      force: false,
      triggeredBy: "daily",
      dataSource: null,
      dryRun: true,
      now: "2026-06-01T00:00:00.000Z",
      staleAfterDays: 7,
      maxCandidates: 10,
      dueCandidateCount: 0,
      selectedCandidateCount: 0,
      syncedCandidateCount: 0,
      identityConflictCandidateCount: 0,
      failedCandidateCount: 0,
      autoLinkAttemptedCount: 0,
      autoLinkLinkedCount: 0,
      autoLinkResults: [],
      results: [],
    });
    expect(Pool).not.toHaveBeenCalled();
  });

  it("runs the due Alaska finance sync with loaded APOC data when enabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    process.env.ALASKA_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.ALASKA_CAMPAIGN_FINANCE_SYNC_ENABLED = "true";

    const end = vi.fn().mockResolvedValue(undefined);
    const pool = { query: vi.fn(), end };
    const loadAlaskaApocFinanceData = vi.fn().mockResolvedValue({
      apocData: {
        incomeRows: [],
        independentExpenditureRows: [],
        independentContributionRows: [],
        incomeSourceUrl: "https://example.test/income.csv",
      },
      metadata: {
        mode: "live",
        income_source_url: "https://example.test/income.csv",
        independent_expenditure_source_url: null,
        independent_contribution_source_url: null,
        income_csv_path: null,
        independent_expenditures_csv_path: null,
        independent_contributions_csv_path: null,
        timeout_ms: 1000,
        retry_count: 1,
        retry_delay_ms: 0,
        request_spacing_ms: 0,
      },
    });
    const syncDueAlaskaCandidateFinance = vi.fn().mockImplementation(async (input) => {
      await input.loadApocData();
      return {
      dryRun: false,
      now: "2026-06-01T00:00:00.000Z",
      staleAfterDays: 3,
      maxCandidates: 2,
      dueCandidateCount: 4,
      selectedCandidateCount: 2,
      syncedCandidateCount: 2,
      failedCandidateCount: 0,
      autoLinkAttemptedCount: 0,
      autoLinkLinkedCount: 0,
      autoLinkResults: [],
      results: [],
    }; });

    vi.doMock("pg", () => ({ Pool: vi.fn(() => pool) }));
    mockEnv();
    vi.doMock("../../src/pipeline/alaskaFinance/alaskaApocDataSource.js", () => ({
      loadAlaskaApocFinanceData,
    }));
    vi.doMock("../../src/pipeline/alaskaFinance/alaskaCandidateFinanceBatchSync.js", () => ({
      syncDueAlaskaCandidateFinance,
    }));

    const { runAlaskaCandidateFinanceSyncJob } = await import(
      "../../src/scheduler/alaskaCandidateFinanceSyncScheduler.js"
    );

    const result = await runAlaskaCandidateFinanceSyncJob({
      dryRun: false,
      autoLinkMissingLinks: true,
      dataSourceMode: "live",
      incomeUrl: "https://example.test/income.csv",
      timeoutMs: 1000,
      retryCount: 1,
      retryDelayMs: 0,
      requestSpacingMs: 0,
      maxCandidates: 2,
      staleAfterDays: 3,
      triggeredBy: "manual",
    });

    expect(result).toMatchObject({
      enabled: true,
      dryRun: false,
      dataSource: {
        mode: "live",
        income_source_url: "https://example.test/income.csv",
      },
      selectedCandidateCount: 2,
    });
    expect(loadAlaskaApocFinanceData).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "live",
        incomeUrl: "https://example.test/income.csv",
        timeoutMs: 1000,
        retryCount: 1,
      }),
      expect.objectContaining({ logger: expect.objectContaining({ warn: expect.any(Function) }) })
    );
    expect(syncDueAlaskaCandidateFinance).toHaveBeenCalledWith(
      expect.objectContaining({
        db: pool,
        dryRun: false,
        maxCandidates: 2,
        staleAfterDays: 3,
        autoLinkMissingLinks: true,
      })
    );
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid scheduler APOC data source env values", async () => {
    process.env.ALASKA_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.ALASKA_CAMPAIGN_FINANCE_SYNC_ENABLED = "true";
    process.env.ALASKA_APOC_DATA_SOURCE = "spreadsheet";
    const end = vi.fn().mockResolvedValue(undefined);
    const pool = { query: vi.fn(), end };

    vi.doMock("pg", () => ({ Pool: vi.fn(() => pool) }));
    mockEnv();

    const { runAlaskaCandidateFinanceSyncJob } = await import(
      "../../src/scheduler/alaskaCandidateFinanceSyncScheduler.js"
    );

    await expect(runAlaskaCandidateFinanceSyncJob({ triggeredBy: "manual" })).rejects.toThrow(
      "Invalid ALASKA_APOC_DATA_SOURCE value: spreadsheet"
    );
    expect(end).not.toHaveBeenCalled();
  });

  it("rejects default CSV scheduler runs without an income CSV path", async () => {
    process.env.ALASKA_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.ALASKA_CAMPAIGN_FINANCE_SYNC_ENABLED = "true";
    const Pool = vi.fn();

    vi.doMock("pg", () => ({ Pool }));
    mockEnv();

    const { runAlaskaCandidateFinanceSyncJob } = await import(
      "../../src/scheduler/alaskaCandidateFinanceSyncScheduler.js"
    );

    await expect(runAlaskaCandidateFinanceSyncJob({ triggeredBy: "manual" })).rejects.toThrow(
      "Alaska finance sync scheduler CSV data source requires incomeCsvPath or ALASKA_APOC_INCOME_CSV_PATH"
    );
    expect(Pool).not.toHaveBeenCalled();
  });

  it("upserts recurring jobs as dry-run by default with scheduler backoff", async () => {
    process.env.ALASKA_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.ALASKA_CAMPAIGN_FINANCE_SYNC_DAILY_CRON = "15 9 * * *";
    process.env.ALASKA_CAMPAIGN_FINANCE_SYNC_DAILY_TZ = "America/Anchorage";
    mockEnv();

    const queueInstance = {
      upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const Queue = vi.fn(() => queueInstance);
    vi.doMock("bullmq", () => ({ Queue, Worker: vi.fn() }));

    const { upsertRecurringAlaskaCandidateFinanceSyncJobs } = await import(
      "../../src/scheduler/alaskaCandidateFinanceSyncScheduler.js"
    );

    await upsertRecurringAlaskaCandidateFinanceSyncJobs({
      maxCandidates: 5,
      incomeCsvPath: "/tmp/income.csv",
    });

    expect(queueInstance.upsertJobScheduler).toHaveBeenCalledWith(
      "alaska_candidate_finance_sync_daily",
      {
        pattern: "15 9 * * *",
        tz: "America/Anchorage",
      },
      expect.objectContaining({
        name: "alaska_candidate_finance_sync_due",
        data: expect.objectContaining({
          dryRun: true,
          autoLinkMissingLinks: false,
          maxCandidates: 5,
          incomeCsvPath: "/tmp/income.csv",
          triggeredBy: "daily",
        }),
        opts: expect.objectContaining({
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 60000,
          },
        }),
      })
    );
    expect(queueInstance.close).toHaveBeenCalledTimes(1);
  });

  it("enqueues manual jobs with auto-link suppressed during dry-run", async () => {
    process.env.ALASKA_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.ALASKA_CAMPAIGN_FINANCE_SYNC_ENABLED = "true";
    mockEnv();

    const queueInstance = {
      add: vi.fn().mockResolvedValue({ id: "alaska-finance-job-1" }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const Queue = vi.fn(() => queueInstance);
    vi.doMock("bullmq", () => ({ Queue, Worker: vi.fn() }));

    const { buildAlaskaCandidateFinanceLinkedElectionSyncJobId, enqueueManualAlaskaCandidateFinanceSyncJob } =
      await import("../../src/scheduler/alaskaCandidateFinanceSyncScheduler.js");

    const jobId = buildAlaskaCandidateFinanceLinkedElectionSyncJobId(new Date("2026-11-03T23:00:00.000Z"));
    await expect(
      enqueueManualAlaskaCandidateFinanceSyncJob({ autoLinkMissingLinks: true, incomeCsvPath: "/tmp/income.csv" }, { jobId })
    ).resolves.toBe("alaska-finance-job-1");

    expect(jobId).toBe("alaska-candidate-finance-linked-election-sync-2026-11-03");
    expect(queueInstance.add).toHaveBeenCalledWith(
      "alaska_candidate_finance_sync_due",
      expect.objectContaining({
        dryRun: true,
        autoLinkMissingLinks: false,
        triggeredBy: "manual",
      }),
      expect.objectContaining({ jobId })
    );
  });
});
