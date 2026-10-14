import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("vermontCandidateFinanceSyncScheduler", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.VERMONT_CAMPAIGN_FINANCE_ENABLED;
    delete process.env.VERMONT_CAMPAIGN_FINANCE_SYNC_ENABLED;
    delete process.env.VERMONT_COMMITTEE_CASH_SYNC_ENABLED;
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

  it.each([true, false])("returns a disabled no-op result with the configured cash mode (%s)", async (committeeCashOnly) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    process.env.VERMONT_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.VERMONT_CAMPAIGN_FINANCE_SYNC_ENABLED = "false";
    process.env.VERMONT_COMMITTEE_CASH_SYNC_ENABLED = String(committeeCashOnly);
    const Pool = vi.fn();
    vi.doMock("pg", () => ({ Pool }));

    const { runVermontCandidateFinanceSyncJob } = await import(
      "../../src/scheduler/vermontCandidateFinanceSyncScheduler.js"
    );

    const result = await runVermontCandidateFinanceSyncJob({
      triggeredBy: "daily",
      maxCandidates: 10,
      staleAfterDays: 7,
    });

    expect(result).toEqual({
      enabled: false,
      force: false,
      triggeredBy: "daily",
      dryRun: false,
      committeeCashOnly,
      now: "2026-06-01T00:00:00.000Z",
      staleAfterDays: 7,
      maxCandidates: 10,
      dueCandidateCount: 0,
      selectedCandidateCount: 0,
      syncedCandidateCount: 0,
      failedCandidateCount: 0,
      autoLinkAttemptedCount: 0,
      autoLinkLinkedCount: 0,
      autoLinkFailedCount: 0,
      autoLinkResults: [],
      results: [],
    });
    expect(Pool).not.toHaveBeenCalled();
  });

  it("does not let force bypass the master Vermont finance flag", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    process.env.VERMONT_CAMPAIGN_FINANCE_ENABLED = "false";
    process.env.VERMONT_CAMPAIGN_FINANCE_SYNC_ENABLED = "true";
    const Pool = vi.fn();
    vi.doMock("pg", () => ({ Pool }));

    const { runVermontCandidateFinanceSyncJob } = await import(
      "../../src/scheduler/vermontCandidateFinanceSyncScheduler.js"
    );

    const result = await runVermontCandidateFinanceSyncJob({
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

  it("runs the due Vermont finance sync when enabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    process.env.VERMONT_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.VERMONT_CAMPAIGN_FINANCE_SYNC_ENABLED = "true";

    const end = vi.fn().mockResolvedValue(undefined);
    const pool = { query: vi.fn(), connect: vi.fn(), end };
    const syncDueVermontCandidateFinance = vi.fn().mockResolvedValue({
      dryRun: true,
      committeeCashOnly: true,
      now: "2026-06-01T00:00:00.000Z",
      staleAfterDays: 3,
      maxCandidates: 2,
      dueCandidateCount: 4,
      selectedCandidateCount: 2,
      syncedCandidateCount: 2,
      failedCandidateCount: 0,
      autoLinkAttemptedCount: 0,
      autoLinkLinkedCount: 0,
      autoLinkFailedCount: 0,
      autoLinkResults: [],
      results: [],
    });

    vi.doMock("pg", () => ({ Pool: vi.fn(() => pool) }));
    mockEnv();
    vi.doMock("../../src/pipeline/vermontFinance/vermontCandidateFinanceBatchSync.js", () => ({
      syncDueVermontCandidateFinance,
    }));

    const { runVermontCandidateFinanceSyncJob } = await import(
      "../../src/scheduler/vermontCandidateFinanceSyncScheduler.js"
    );

    const result = await runVermontCandidateFinanceSyncJob({
      dryRun: true,
      maxCandidates: 2,
      staleAfterDays: 3,
      electionLookbackDays: 14,
      triggeredBy: "manual",
    });

    expect(result).toMatchObject({
      enabled: true,
      force: false,
      triggeredBy: "manual",
      dryRun: true,
      selectedCandidateCount: 2,
      committeeCashOnly: true,
    });
    expect(syncDueVermontCandidateFinance).toHaveBeenCalledWith(
      expect.objectContaining({
        db: pool,
        dryRun: true,
        maxCandidates: 2,
        staleAfterDays: 3,
        electionLookbackDays: 14,
      })
    );
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("upserts recurring jobs with configured queue payload", async () => {
    process.env.VERMONT_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.VERMONT_CAMPAIGN_FINANCE_SYNC_DAILY_CRON = "15 9 * * *";
    process.env.VERMONT_CAMPAIGN_FINANCE_SYNC_DAILY_TZ = "America/Los_Angeles";
    mockEnv();

    const queueInstance = {
      upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const Queue = vi.fn(() => queueInstance);
    vi.doMock("bullmq", () => ({ Queue, Worker: vi.fn() }));

    const { upsertRecurringVermontCandidateFinanceSyncJobs } = await import(
      "../../src/scheduler/vermontCandidateFinanceSyncScheduler.js"
    );

    await upsertRecurringVermontCandidateFinanceSyncJobs({ maxCandidates: 5 });

    expect(queueInstance.upsertJobScheduler).toHaveBeenCalledWith(
      "vermont_candidate_finance_sync_daily",
      {
        pattern: "15 9 * * *",
        tz: "America/Los_Angeles",
      },
      expect.objectContaining({
        name: "vermont_candidate_finance_sync_due",
        data: expect.objectContaining({
          maxCandidates: 5,
          triggeredBy: "daily",
        }),
      })
    );
    expect(queueInstance.close).toHaveBeenCalledTimes(1);
  });

  it("removes the recurring scheduler when the master Vermont finance flag is disabled", async () => {
    process.env.VERMONT_CAMPAIGN_FINANCE_ENABLED = "false";
    mockEnv();

    const queueInstance = {
      removeJobScheduler: vi.fn().mockResolvedValue(true),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const Queue = vi.fn(() => queueInstance);
    vi.doMock("bullmq", () => ({ Queue, Worker: vi.fn() }));

    const { upsertRecurringVermontCandidateFinanceSyncJobs } = await import(
      "../../src/scheduler/vermontCandidateFinanceSyncScheduler.js"
    );

    await upsertRecurringVermontCandidateFinanceSyncJobs();

    expect(queueInstance.removeJobScheduler).toHaveBeenCalledWith("vermont_candidate_finance_sync_daily");
    expect(queueInstance.close).toHaveBeenCalledTimes(1);
  });

  it("enqueues manual jobs with a deterministic linked-election job id", async () => {
    process.env.VERMONT_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.VERMONT_CAMPAIGN_FINANCE_SYNC_ENABLED = "true";
    mockEnv();

    const queueInstance = {
      add: vi.fn().mockResolvedValue({ id: "vermont-finance-job-1" }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const Queue = vi.fn(() => queueInstance);
    vi.doMock("bullmq", () => ({ Queue, Worker: vi.fn() }));

    const { buildVermontCandidateFinanceLinkedElectionSyncJobId, enqueueManualVermontCandidateFinanceSyncJob } =
      await import("../../src/scheduler/vermontCandidateFinanceSyncScheduler.js");

    const jobId = buildVermontCandidateFinanceLinkedElectionSyncJobId(new Date("2026-11-03T23:00:00.000Z"));
    await expect(enqueueManualVermontCandidateFinanceSyncJob({ maxCandidates: 5 }, { jobId })).resolves.toBe(
      "vermont-finance-job-1"
    );

    expect(jobId).toBe("vermont-candidate-finance-linked-election-sync-2026-11-03");
    expect(queueInstance.add).toHaveBeenCalledWith(
      "vermont_candidate_finance_sync_due",
      expect.objectContaining({
        maxCandidates: 5,
        triggeredBy: "manual",
      }),
      expect.objectContaining({ jobId })
    );
  });

  it("does not enqueue manual jobs when the master Vermont finance flag is disabled", async () => {
    process.env.VERMONT_CAMPAIGN_FINANCE_ENABLED = "false";
    process.env.VERMONT_CAMPAIGN_FINANCE_SYNC_ENABLED = "true";
    mockEnv();

    const queueInstance = {
      add: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const Queue = vi.fn(() => queueInstance);
    vi.doMock("bullmq", () => ({ Queue, Worker: vi.fn() }));

    const { enqueueManualVermontCandidateFinanceSyncJob } = await import(
      "../../src/scheduler/vermontCandidateFinanceSyncScheduler.js"
    );

    await expect(enqueueManualVermontCandidateFinanceSyncJob({ force: true })).resolves.toBe("disabled");
    expect(Queue).not.toHaveBeenCalled();
  });

  it("does not enqueue manual jobs when Vermont finance sync is disabled and not forced", async () => {
    process.env.VERMONT_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.VERMONT_CAMPAIGN_FINANCE_SYNC_ENABLED = "false";
    mockEnv();

    const queueInstance = {
      add: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const Queue = vi.fn(() => queueInstance);
    vi.doMock("bullmq", () => ({ Queue, Worker: vi.fn() }));

    const { enqueueManualVermontCandidateFinanceSyncJob } = await import(
      "../../src/scheduler/vermontCandidateFinanceSyncScheduler.js"
    );

    await expect(enqueueManualVermontCandidateFinanceSyncJob()).resolves.toBe("disabled");
    expect(Queue).not.toHaveBeenCalled();
  });

  it("uses Worker-only maxRetriesPerRequest while leaving queue connections standard", async () => {
    process.env.VERMONT_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.VERMONT_CAMPAIGN_FINANCE_SYNC_ENABLED = "true";
    mockEnv("redis://:secret@localhost:6380/7");

    const workerInstance = { close: vi.fn().mockResolvedValue(undefined) };
    const queueInstance = { add: vi.fn().mockResolvedValue({ id: "job-1" }), close: vi.fn().mockResolvedValue(undefined) };
    const Queue = vi.fn(() => queueInstance);
    const Worker = vi.fn(() => workerInstance);
    vi.doMock("bullmq", () => ({ Queue, Worker }));

    const { createVermontCandidateFinanceSyncSchedulerWorker, enqueueManualVermontCandidateFinanceSyncJob } =
      await import("../../src/scheduler/vermontCandidateFinanceSyncScheduler.js");

    await enqueueManualVermontCandidateFinanceSyncJob({ force: true });
    const worker = createVermontCandidateFinanceSyncSchedulerWorker();

    expect(Queue.mock.calls[0]?.[1]?.connection).toMatchObject({
      host: "localhost",
      port: 6380,
      db: 7,
      password: "secret",
    });
    expect(Queue.mock.calls[0]?.[1]?.connection).not.toHaveProperty("maxRetriesPerRequest");
    expect(Worker.mock.calls[0]?.[2]?.connection).toMatchObject({
      host: "localhost",
      port: 6380,
      db: 7,
      password: "secret",
      maxRetriesPerRequest: null,
    });
    await worker.close();
  });
});
