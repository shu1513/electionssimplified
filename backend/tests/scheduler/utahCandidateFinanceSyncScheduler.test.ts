import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("utahCandidateFinanceSyncScheduler", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.UTAH_CAMPAIGN_FINANCE_ENABLED;
    delete process.env.UTAH_CAMPAIGN_FINANCE_SYNC_ENABLED;
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
    process.env.UTAH_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.UTAH_CAMPAIGN_FINANCE_SYNC_ENABLED = "false";
    const Pool = vi.fn();
    vi.doMock("pg", () => ({ Pool }));

    const { runUtahCandidateFinanceSyncJob } = await import(
      "../../src/scheduler/utahCandidateFinanceSyncScheduler.js"
    );

    const result = await runUtahCandidateFinanceSyncJob({
      triggeredBy: "daily",
      maxCandidates: 10,
      staleAfterDays: 7,
    });

    expect(result).toEqual({
      enabled: false,
      force: false,
      triggeredBy: "daily",
      dryRun: false,
      now: "2026-06-01T00:00:00.000Z",
      staleAfterDays: 7,
      maxCandidates: 10,
      dueCandidateCount: 0,
      selectedCandidateCount: 0,
      syncedCandidateCount: 0,
      failedCandidateCount: 0,
      autoLinkAttemptedCount: 0,
      autoLinkLinkedCount: 0,
      results: [],
    });
    expect(Pool).not.toHaveBeenCalled();
  });

  it("does not let force bypass the master Utah finance flag", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    process.env.UTAH_CAMPAIGN_FINANCE_ENABLED = "false";
    process.env.UTAH_CAMPAIGN_FINANCE_SYNC_ENABLED = "true";
    const Pool = vi.fn();
    vi.doMock("pg", () => ({ Pool }));

    const { runUtahCandidateFinanceSyncJob } = await import(
      "../../src/scheduler/utahCandidateFinanceSyncScheduler.js"
    );

    const result = await runUtahCandidateFinanceSyncJob({
      triggeredBy: "manual",
      force: true,
      maxCandidates: 10,
      staleAfterDays: 7,
    });

    expect(result).toMatchObject({
      enabled: false,
      force: true,
      triggeredBy: "manual",
      dueCandidateCount: 0,
      selectedCandidateCount: 0,
    });
    expect(Pool).not.toHaveBeenCalled();
  });

  it("runs due Utah finance sync when enabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    process.env.UTAH_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.UTAH_CAMPAIGN_FINANCE_SYNC_ENABLED = "true";

    const end = vi.fn().mockResolvedValue(undefined);
    const pool = { query: vi.fn(), end };
    const syncDueUtahCandidateFinance = vi.fn().mockResolvedValue({
      dryRun: true,
      now: "2026-06-01T00:00:00.000Z",
      staleAfterDays: 3,
      maxCandidates: 2,
      dueCandidateCount: 4,
      selectedCandidateCount: 2,
      syncedCandidateCount: 2,
      failedCandidateCount: 0,
      results: [],
    });

    vi.doMock("pg", () => ({ Pool: vi.fn(() => pool) }));
    mockEnv();
    vi.doMock("../../src/pipeline/utahFinance/utahCandidateFinanceBatchSync.js", () => ({
      syncDueUtahCandidateFinance,
    }));

    const { runUtahCandidateFinanceSyncJob } = await import(
      "../../src/scheduler/utahCandidateFinanceSyncScheduler.js"
    );

    const result = await runUtahCandidateFinanceSyncJob({
      dryRun: true,
      maxCandidates: 2,
      staleAfterDays: 3,
      electionLookbackDays: 14,
      rawDataCacheDir: "/tmp/utah-cache",
      refreshCache: true,
      triggeredBy: "manual",
    });

    expect(result).toMatchObject({
      enabled: true,
      force: false,
      triggeredBy: "manual",
      dryRun: true,
      selectedCandidateCount: 2,
    });
    expect(syncDueUtahCandidateFinance).toHaveBeenCalledWith(
      expect.objectContaining({
        db: pool,
        dryRun: true,
        maxCandidates: 2,
        staleAfterDays: 3,
        electionLookbackDays: 14,
        rawDataCacheDir: "/tmp/utah-cache",
        refreshCache: true,
      })
    );
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("upserts recurring jobs with configured queue payload", async () => {
    process.env.UTAH_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.UTAH_CAMPAIGN_FINANCE_SYNC_DAILY_CRON = "15 9 * * *";
    process.env.UTAH_CAMPAIGN_FINANCE_SYNC_DAILY_TZ = "America/Denver";
    mockEnv();

    const queueInstance = {
      upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const Queue = vi.fn(() => queueInstance);
    vi.doMock("bullmq", () => ({ Queue, Worker: vi.fn() }));

    const { upsertRecurringUtahCandidateFinanceSyncJobs } = await import(
      "../../src/scheduler/utahCandidateFinanceSyncScheduler.js"
    );

    await upsertRecurringUtahCandidateFinanceSyncJobs({
      maxCandidates: 5,
      rawDataCacheDir: "/tmp/utah-cache",
      refreshCache: true,
    });

    expect(queueInstance.upsertJobScheduler).toHaveBeenCalledWith(
      "utah_candidate_finance_sync_daily",
      {
        pattern: "15 9 * * *",
        tz: "America/Denver",
      },
      expect.objectContaining({
        name: "utah_candidate_finance_sync_due",
        data: expect.objectContaining({
          maxCandidates: 5,
          rawDataCacheDir: "/tmp/utah-cache",
          refreshCache: true,
          triggeredBy: "daily",
        }),
      })
    );
    expect(queueInstance.close).toHaveBeenCalledTimes(1);
  });

  it("removes the recurring scheduler when the master Utah finance flag is disabled", async () => {
    process.env.UTAH_CAMPAIGN_FINANCE_ENABLED = "false";
    mockEnv();

    const queueInstance = {
      removeJobScheduler: vi.fn().mockResolvedValue(true),
      upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const Queue = vi.fn(() => queueInstance);
    vi.doMock("bullmq", () => ({ Queue, Worker: vi.fn() }));

    const { upsertRecurringUtahCandidateFinanceSyncJobs } = await import(
      "../../src/scheduler/utahCandidateFinanceSyncScheduler.js"
    );

    await upsertRecurringUtahCandidateFinanceSyncJobs();

    expect(queueInstance.removeJobScheduler).toHaveBeenCalledWith("utah_candidate_finance_sync_daily");
    expect(queueInstance.upsertJobScheduler).not.toHaveBeenCalled();
  });

  it("enqueues manual jobs with a deterministic linked-election job id", async () => {
    process.env.UTAH_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.UTAH_CAMPAIGN_FINANCE_SYNC_ENABLED = "true";
    mockEnv();

    const queueInstance = {
      add: vi.fn().mockResolvedValue({ id: "utah-finance-job-1" }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const Queue = vi.fn(() => queueInstance);
    vi.doMock("bullmq", () => ({ Queue, Worker: vi.fn() }));

    const {
      buildUtahCandidateFinanceLinkedElectionSyncJobId,
      enqueueManualUtahCandidateFinanceSyncJob,
    } = await import("../../src/scheduler/utahCandidateFinanceSyncScheduler.js");

    const jobId = buildUtahCandidateFinanceLinkedElectionSyncJobId(new Date("2026-11-03T23:00:00.000Z"));
    await expect(
      enqueueManualUtahCandidateFinanceSyncJob(
        {},
        { jobId }
      )
    ).resolves.toBe("utah-finance-job-1");

    expect(jobId).toBe("utah-candidate-finance-linked-election-sync-2026-11-03");
    expect(queueInstance.add).toHaveBeenCalledWith(
      "utah_candidate_finance_sync_due",
      expect.objectContaining({
        triggeredBy: "manual",
      }),
      expect.objectContaining({ jobId })
    );
  });
});
