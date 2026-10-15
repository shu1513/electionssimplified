import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("marylandCandidateFinanceSyncScheduler", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.MARYLAND_CAMPAIGN_FINANCE_ENABLED;
    delete process.env.MARYLAND_CAMPAIGN_FINANCE_SYNC_ENABLED;
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

  it("returns a disabled no-op result when the sync flag is off", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    process.env.MARYLAND_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.MARYLAND_CAMPAIGN_FINANCE_SYNC_ENABLED = "false";
    const Pool = vi.fn();
    vi.doMock("pg", () => ({ Pool }));

    const { runMarylandCandidateFinanceSyncJob } = await import(
      "../../src/scheduler/marylandCandidateFinanceSyncScheduler.js"
    );

    const result = await runMarylandCandidateFinanceSyncJob({
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
      results: [],
      nativeOutsideObservation: { status: "preserve", diagnostics: ["finance_sync_disabled"] },
    });
    expect(Pool).not.toHaveBeenCalled();
  });

  it("does not let force bypass the master Maryland finance flag", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    process.env.MARYLAND_CAMPAIGN_FINANCE_ENABLED = "false";
    process.env.MARYLAND_CAMPAIGN_FINANCE_SYNC_ENABLED = "true";
    const Pool = vi.fn();
    vi.doMock("pg", () => ({ Pool }));

    const { runMarylandCandidateFinanceSyncJob } = await import(
      "../../src/scheduler/marylandCandidateFinanceSyncScheduler.js"
    );

    const result = await runMarylandCandidateFinanceSyncJob({
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

  it("runs the due Maryland finance sync when enabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    process.env.MARYLAND_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.MARYLAND_CAMPAIGN_FINANCE_SYNC_ENABLED = "true";

    const end = vi.fn().mockResolvedValue(undefined);
    const pool = { query: vi.fn(), end };
    const syncDueMarylandCandidateFinance = vi.fn().mockResolvedValue({
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
    vi.doMock("../../src/pipeline/marylandFinance/marylandCandidateFinanceBatchSync.js", () => ({
      syncDueMarylandCandidateFinance,
    }));

    const { runMarylandCandidateFinanceSyncJob } = await import(
      "../../src/scheduler/marylandCandidateFinanceSyncScheduler.js"
    );

    const result = await runMarylandCandidateFinanceSyncJob({
      dryRun: true,
      maxCandidates: 2,
      staleAfterDays: 3,
      electionLookbackDays: 14,
      rawDataCacheDir: "/tmp/maryland-cfs",
      triggeredBy: "manual",
    });

    expect(result).toMatchObject({
      enabled: true,
      force: false,
      triggeredBy: "manual",
      dryRun: true,
      selectedCandidateCount: 2,
    });
    expect(syncDueMarylandCandidateFinance).toHaveBeenCalledWith(
      expect.objectContaining({
        db: pool,
        dryRun: true,
        maxCandidates: 2,
        staleAfterDays: 3,
        electionLookbackDays: 14,
        rawDataCacheDir: "/tmp/maryland-cfs",
      })
    );
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("upserts recurring jobs with configured queue payload", async () => {
    process.env.MARYLAND_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.MARYLAND_CAMPAIGN_FINANCE_SYNC_DAILY_CRON = "50 9 * * *";
    process.env.MARYLAND_CAMPAIGN_FINANCE_SYNC_DAILY_TZ = "America/New_York";
    mockEnv();

    const queueInstance = {
      upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const Queue = vi.fn(() => queueInstance);
    vi.doMock("bullmq", () => ({ Queue, Worker: vi.fn() }));

    const { upsertRecurringMarylandCandidateFinanceSyncJobs } = await import(
      "../../src/scheduler/marylandCandidateFinanceSyncScheduler.js"
    );

    await upsertRecurringMarylandCandidateFinanceSyncJobs({
      maxCandidates: 5,
      rawDataCacheDir: "/tmp/maryland-cfs",
    });

    expect(queueInstance.upsertJobScheduler).toHaveBeenCalledWith(
      "maryland_candidate_finance_sync_daily",
      {
        pattern: "50 9 * * *",
        tz: "America/New_York",
      },
      expect.objectContaining({
        name: "maryland_candidate_finance_sync_due",
        data: expect.objectContaining({
          maxCandidates: 5,
          rawDataCacheDir: "/tmp/maryland-cfs",
          triggeredBy: "daily",
        }),
      })
    );
    expect(queueInstance.close).toHaveBeenCalledTimes(1);
  });

  it("removes recurring jobs when the master Maryland finance flag is disabled", async () => {
    process.env.MARYLAND_CAMPAIGN_FINANCE_ENABLED = "false";
    mockEnv();

    const queueInstance = {
      removeJobScheduler: vi.fn().mockResolvedValue(true),
      upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const Queue = vi.fn(() => queueInstance);
    vi.doMock("bullmq", () => ({ Queue, Worker: vi.fn() }));

    const { upsertRecurringMarylandCandidateFinanceSyncJobs } = await import(
      "../../src/scheduler/marylandCandidateFinanceSyncScheduler.js"
    );

    await upsertRecurringMarylandCandidateFinanceSyncJobs();

    expect(queueInstance.removeJobScheduler).toHaveBeenCalledWith("maryland_candidate_finance_sync_daily");
    expect(queueInstance.upsertJobScheduler).not.toHaveBeenCalled();
    expect(queueInstance.close).toHaveBeenCalledTimes(1);
  });

  it("enqueues manual jobs with requested options", async () => {
    process.env.MARYLAND_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.MARYLAND_CAMPAIGN_FINANCE_SYNC_ENABLED = "false";
    mockEnv();

    const queueInstance = {
      add: vi.fn().mockResolvedValue({ id: "maryland-finance-job-1" }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const Queue = vi.fn(() => queueInstance);
    vi.doMock("bullmq", () => ({ Queue, Worker: vi.fn() }));

    const { enqueueManualMarylandCandidateFinanceSyncJob } = await import(
      "../../src/scheduler/marylandCandidateFinanceSyncScheduler.js"
    );

    await expect(
      enqueueManualMarylandCandidateFinanceSyncJob({
        dryRun: true,
        force: true,
        maxCandidates: 3,
        electionLookbackDays: 21,
        rawDataCacheDir: "/tmp/maryland-cfs",
      })
    ).resolves.toBe("maryland-finance-job-1");

    expect(queueInstance.add).toHaveBeenCalledWith(
      "maryland_candidate_finance_sync_due",
      expect.objectContaining({
        dryRun: true,
        force: true,
        maxCandidates: 3,
        electionLookbackDays: 21,
        rawDataCacheDir: "/tmp/maryland-cfs",
        triggeredBy: "manual",
      }),
      expect.any(Object)
    );
    expect(queueInstance.close).toHaveBeenCalledTimes(1);
  });

  it("rejects manual job IDs that collide with scheduler sentinel return values", async () => {
    process.env.MARYLAND_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.MARYLAND_CAMPAIGN_FINANCE_SYNC_ENABLED = "false";
    mockEnv();

    const queueInstance = {
      add: vi.fn().mockResolvedValue({ id: "disabled" }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const Queue = vi.fn(() => queueInstance);
    vi.doMock("bullmq", () => ({ Queue, Worker: vi.fn() }));

    const { enqueueManualMarylandCandidateFinanceSyncJob } = await import(
      "../../src/scheduler/marylandCandidateFinanceSyncScheduler.js"
    );

    await expect(
      enqueueManualMarylandCandidateFinanceSyncJob({ force: true }, { jobId: "disabled" })
    ).rejects.toThrow("Maryland finance sync scheduler jobId uses a reserved value");
    await expect(
      enqueueManualMarylandCandidateFinanceSyncJob({ force: true }, { jobId: "unknown" })
    ).rejects.toThrow("Maryland finance sync scheduler jobId uses a reserved value");

    expect(queueInstance.add).not.toHaveBeenCalled();
    expect(queueInstance.close).toHaveBeenCalledTimes(2);
  });
});
