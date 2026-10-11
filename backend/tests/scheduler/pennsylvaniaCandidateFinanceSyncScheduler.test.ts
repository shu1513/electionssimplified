import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("pennsylvaniaCandidateFinanceSyncScheduler", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.PENNSYLVANIA_CAMPAIGN_FINANCE_ENABLED;
    delete process.env.PENNSYLVANIA_CAMPAIGN_FINANCE_SYNC_ENABLED;
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
    process.env.PENNSYLVANIA_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.PENNSYLVANIA_CAMPAIGN_FINANCE_SYNC_ENABLED = "false";
    const Pool = vi.fn();
    vi.doMock("pg", () => ({ Pool }));

    const { runPennsylvaniaCandidateFinanceSyncJob } = await import(
      "../../src/scheduler/pennsylvaniaCandidateFinanceSyncScheduler.js"
    );

    const result = await runPennsylvaniaCandidateFinanceSyncJob({
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
      autoLinkAttemptedCount: 0,
      autoLinkLinkedCount: 0,
      dueCandidateCount: 0,
      selectedCandidateCount: 0,
      syncedCandidateCount: 0,
      failedCandidateCount: 0,
      outsideSpendingFetchedYears: [],
      outsideSpendingFetchErrors: {},
      results: [],
    });
    expect(Pool).not.toHaveBeenCalled();
  });

  it("upserts recurring jobs with configured queue payload", async () => {
    process.env.PENNSYLVANIA_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.PENNSYLVANIA_CAMPAIGN_FINANCE_SYNC_DAILY_CRON = "30 9 * * *";
    process.env.PENNSYLVANIA_CAMPAIGN_FINANCE_SYNC_DAILY_TZ = "America/New_York";
    mockEnv();

    const queueInstance = {
      upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const Queue = vi.fn(() => queueInstance);
    vi.doMock("bullmq", () => ({ Queue, Worker: vi.fn() }));

    const { upsertRecurringPennsylvaniaCandidateFinanceSyncJobs } = await import(
      "../../src/scheduler/pennsylvaniaCandidateFinanceSyncScheduler.js"
    );

    await upsertRecurringPennsylvaniaCandidateFinanceSyncJobs({
      maxCandidates: 5,
      rawDataExtractedDir: "/tmp/pa-cf/2022",
    });

    expect(queueInstance.upsertJobScheduler).toHaveBeenCalledWith(
      "pennsylvania_candidate_finance_sync_daily",
      {
        pattern: "30 9 * * *",
        tz: "America/New_York",
      },
      expect.objectContaining({
        name: "pennsylvania_candidate_finance_sync_due",
        data: expect.objectContaining({
          maxCandidates: 5,
          rawDataExtractedDir: "/tmp/pa-cf/2022",
          triggeredBy: "daily",
        }),
      })
    );
    expect(queueInstance.close).toHaveBeenCalledTimes(1);
  });

  it("enqueues manual jobs with requested options", async () => {
    process.env.PENNSYLVANIA_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.PENNSYLVANIA_CAMPAIGN_FINANCE_SYNC_ENABLED = "false";
    mockEnv();

    const queueInstance = {
      add: vi.fn().mockResolvedValue({ id: "pennsylvania-finance-job-1" }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const Queue = vi.fn(() => queueInstance);
    vi.doMock("bullmq", () => ({ Queue, Worker: vi.fn() }));

    const { enqueueManualPennsylvaniaCandidateFinanceSyncJob } = await import(
      "../../src/scheduler/pennsylvaniaCandidateFinanceSyncScheduler.js"
    );

    await expect(
      enqueueManualPennsylvaniaCandidateFinanceSyncJob({
        dryRun: true,
        force: true,
        maxCandidates: 3,
        electionLookbackDays: 21,
        rawDataExtractedDir: "/tmp/pa-cf/2022",
        rawDataCacheDir: "/tmp/pa-cf",
      })
    ).resolves.toBe("pennsylvania-finance-job-1");

    expect(queueInstance.add).toHaveBeenCalledWith(
      "pennsylvania_candidate_finance_sync_due",
      expect.objectContaining({
        dryRun: true,
        force: true,
        maxCandidates: 3,
        electionLookbackDays: 21,
        rawDataExtractedDir: "/tmp/pa-cf/2022",
        rawDataCacheDir: "/tmp/pa-cf",
        triggeredBy: "manual",
      }),
      expect.any(Object)
    );
    expect(queueInstance.close).toHaveBeenCalledTimes(1);
  });
});
