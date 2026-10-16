import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("georgiaCandidateFinanceSyncScheduler", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.GEORGIA_CAMPAIGN_FINANCE_ENABLED;
    delete process.env.GEORGIA_CAMPAIGN_FINANCE_SYNC_ENABLED;
    delete process.env.GEORGIA_REPORTED_IE_ENABLED;
    delete process.env.GEORGIA_REPORTED_COMMITTEE_CONTRIBUTIONS_ENABLED;
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
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    process.env.GEORGIA_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.GEORGIA_CAMPAIGN_FINANCE_SYNC_ENABLED = "false";
    const Pool = vi.fn();
    vi.doMock("pg", () => ({ Pool }));

    const { runGeorgiaCandidateFinanceSyncJob } = await import(
      "../../src/scheduler/georgiaCandidateFinanceSyncScheduler.js"
    );

    const result = await runGeorgiaCandidateFinanceSyncJob({
      triggeredBy: "daily",
      maxCandidates: 10,
      staleAfterDays: 7,
    });

    expect(result).toEqual({
      enabled: false,
      force: false,
      triggeredBy: "daily",
      dryRun: false,
      now: "2026-08-01T00:00:00.000Z",
      staleAfterDays: 7,
      maxCandidates: 10,
      dueCandidateCount: 0,
      selectedCandidateCount: 0,
      syncedCandidateCount: 0,
      failedCandidateCount: 0,
      autoLinkAttemptedCount: 0,
      autoLinkLinkedCount: 0,
      independentExpenditureStoreError: null,
      results: [],
    });
    expect(Pool).not.toHaveBeenCalled();
  });

  it("rejects unsafe integer job options that Number() rounding could smuggle in", async () => {
    process.env.GEORGIA_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.GEORGIA_CAMPAIGN_FINANCE_SYNC_ENABLED = "true";
    const Pool = vi.fn();
    vi.doMock("pg", () => ({ Pool }));

    const { runGeorgiaCandidateFinanceSyncJob } = await import(
      "../../src/scheduler/georgiaCandidateFinanceSyncScheduler.js"
    );

    await expect(
      runGeorgiaCandidateFinanceSyncJob({ triggeredBy: "manual", maxCandidates: 2 ** 53 })
    ).rejects.toThrow("Invalid Georgia finance sync scheduler maxCandidates");
    // Stability needs two consecutive equal passes — 1 can never converge.
    await expect(
      runGeorgiaCandidateFinanceSyncJob({ triggeredBy: "manual", maxPasses: 1 })
    ).rejects.toThrow("stability needs at least 2");
    expect(Pool).not.toHaveBeenCalled();
  });

  it("does not let force bypass the master Georgia finance flag", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    process.env.GEORGIA_CAMPAIGN_FINANCE_ENABLED = "false";
    process.env.GEORGIA_CAMPAIGN_FINANCE_SYNC_ENABLED = "true";
    const Pool = vi.fn();
    vi.doMock("pg", () => ({ Pool }));

    const { runGeorgiaCandidateFinanceSyncJob } = await import(
      "../../src/scheduler/georgiaCandidateFinanceSyncScheduler.js"
    );

    const result = await runGeorgiaCandidateFinanceSyncJob({
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

  it("runs the due Georgia finance sync when enabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    process.env.GEORGIA_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.GEORGIA_CAMPAIGN_FINANCE_SYNC_ENABLED = "true";

    const end = vi.fn().mockResolvedValue(undefined);
    const pool = { query: vi.fn(), end };
    const syncDueGeorgiaCandidateFinance = vi.fn().mockResolvedValue({
      dryRun: true,
      now: "2026-08-01T00:00:00.000Z",
      staleAfterDays: 3,
      maxCandidates: 2,
      dueCandidateCount: 4,
      selectedCandidateCount: 2,
      syncedCandidateCount: 2,
      failedCandidateCount: 0,
      autoLinkAttemptedCount: 0,
      autoLinkLinkedCount: 0,
      independentExpenditureStoreError: null,
      results: [],
    });

    vi.doMock("pg", () => ({ Pool: vi.fn(() => pool) }));
    mockEnv();
    vi.doMock("../../src/pipeline/georgiaFinance/georgiaCandidateFinanceBatchSync.js", () => ({
      syncDueGeorgiaCandidateFinance,
    }));

    const { runGeorgiaCandidateFinanceSyncJob } = await import(
      "../../src/scheduler/georgiaCandidateFinanceSyncScheduler.js"
    );

    const result = await runGeorgiaCandidateFinanceSyncJob({
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
    });
    expect(syncDueGeorgiaCandidateFinance).toHaveBeenCalledWith(
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
    process.env.GEORGIA_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.GEORGIA_CAMPAIGN_FINANCE_SYNC_DAILY_CRON = "55 10 * * *";
    process.env.GEORGIA_CAMPAIGN_FINANCE_SYNC_DAILY_TZ = "America/New_York";
    mockEnv();

    const queueInstance = {
      upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
      removeJobScheduler: vi.fn().mockResolvedValue(true),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const Queue = vi.fn(() => queueInstance);
    vi.doMock("bullmq", () => ({ Queue, Worker: vi.fn() }));

    const { upsertRecurringGeorgiaCandidateFinanceSyncJobs } = await import(
      "../../src/scheduler/georgiaCandidateFinanceSyncScheduler.js"
    );

    await upsertRecurringGeorgiaCandidateFinanceSyncJobs({
      maxCandidates: 5,
      maxPasses: 7,
    });

    expect(queueInstance.upsertJobScheduler).toHaveBeenCalledWith(
      "georgia_candidate_finance_sync_daily",
      {
        pattern: "55 10 * * *",
        tz: "America/New_York",
      },
      expect.objectContaining({
        name: "georgia_candidate_finance_sync_due",
        data: expect.objectContaining({
          maxCandidates: 5,
          maxPasses: 7,
          triggeredBy: "daily",
        }),
      })
    );
    expect(queueInstance.close).toHaveBeenCalledTimes(1);
  });

  it("removes recurring jobs when the master Georgia finance flag is disabled", async () => {
    process.env.GEORGIA_CAMPAIGN_FINANCE_ENABLED = "false";
    mockEnv();

    const queueInstance = {
      removeJobScheduler: vi.fn().mockResolvedValue(true),
      upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const Queue = vi.fn(() => queueInstance);
    vi.doMock("bullmq", () => ({ Queue, Worker: vi.fn() }));

    const { upsertRecurringGeorgiaCandidateFinanceSyncJobs } = await import(
      "../../src/scheduler/georgiaCandidateFinanceSyncScheduler.js"
    );

    await upsertRecurringGeorgiaCandidateFinanceSyncJobs();

    expect(queueInstance.removeJobScheduler).toHaveBeenCalledWith("georgia_candidate_finance_sync_daily");
    expect(queueInstance.removeJobScheduler).toHaveBeenCalledWith("georgia_reported_finance_sync_daily");
    expect(queueInstance.upsertJobScheduler).not.toHaveBeenCalled();
    expect(queueInstance.close).toHaveBeenCalledTimes(1);
  });

  it("enqueues manual jobs with requested options", async () => {
    process.env.GEORGIA_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.GEORGIA_CAMPAIGN_FINANCE_SYNC_ENABLED = "false";
    mockEnv();

    const queueInstance = {
      add: vi.fn().mockResolvedValue({ id: "georgia-finance-job-1" }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const Queue = vi.fn(() => queueInstance);
    vi.doMock("bullmq", () => ({ Queue, Worker: vi.fn() }));

    const { enqueueManualGeorgiaCandidateFinanceSyncJob } = await import(
      "../../src/scheduler/georgiaCandidateFinanceSyncScheduler.js"
    );

    await expect(
      enqueueManualGeorgiaCandidateFinanceSyncJob({
        dryRun: true,
        force: true,
        maxCandidates: 3,
        electionLookbackDays: 21,
      })
    ).resolves.toBe("georgia-finance-job-1");

    expect(queueInstance.add).toHaveBeenCalledWith(
      "georgia_candidate_finance_sync_due",
      expect.objectContaining({
        dryRun: true,
        force: true,
        maxCandidates: 3,
        electionLookbackDays: 21,
        triggeredBy: "manual",
      }),
      expect.any(Object)
    );
    expect(queueInstance.close).toHaveBeenCalledTimes(1);
  });

  it("rejects manual job IDs that collide with scheduler sentinel return values", async () => {
    process.env.GEORGIA_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.GEORGIA_CAMPAIGN_FINANCE_SYNC_ENABLED = "false";
    mockEnv();

    const queueInstance = {
      add: vi.fn().mockResolvedValue({ id: "disabled" }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const Queue = vi.fn(() => queueInstance);
    vi.doMock("bullmq", () => ({ Queue, Worker: vi.fn() }));

    const { enqueueManualGeorgiaCandidateFinanceSyncJob } = await import(
      "../../src/scheduler/georgiaCandidateFinanceSyncScheduler.js"
    );

    await expect(
      enqueueManualGeorgiaCandidateFinanceSyncJob({ force: true }, { jobId: "disabled" })
    ).rejects.toThrow("Georgia finance sync scheduler jobId uses a reserved value");
    await expect(
      enqueueManualGeorgiaCandidateFinanceSyncJob({ force: true }, { jobId: "unknown" })
    ).rejects.toThrow("Georgia finance sync scheduler jobId uses a reserved value");

    expect(queueInstance.add).not.toHaveBeenCalled();
    expect(queueInstance.close).toHaveBeenCalledTimes(2);
  });

  function enableReported(ie: boolean, committee: boolean) {
    process.env.CANDIDATE_FINANCE_ENABLED = "true";
    process.env.GEORGIA_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.GEORGIA_REPORTED_IE_ENABLED = String(ie);
    process.env.GEORGIA_REPORTED_COMMITTEE_CONTRIBUTIONS_ENABLED = String(committee);
  }

  function mockQueue() {
    mockEnv();
    const queue = { upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
      removeJobScheduler: vi.fn().mockResolvedValue(true), close: vi.fn().mockResolvedValue(undefined) };
    vi.doMock("bullmq", () => ({ Queue: vi.fn(() => queue), Worker: vi.fn() }));
    return queue;
  }

  async function mockWorker() {
    mockEnv();
    let processor!: (job: { name: string; data?: Record<string, unknown> }) => Promise<unknown>;
    const Worker = vi.fn((_name, callback, _options) => { processor = callback; return {}; });
    vi.doMock("bullmq", () => ({ Queue: vi.fn(), Worker }));
    const pool = { query: vi.fn(), end: vi.fn().mockResolvedValue(undefined) };
    const Pool = vi.fn(() => pool);
    vi.doMock("pg", () => ({ Pool }));
    const legacy = vi.fn().mockResolvedValue({ selectedCandidateCount: 1 });
    const reported = vi.fn().mockResolvedValue({ enabled: true, selectedCount: 1, attemptedCount: 0 });
    vi.doMock("../../src/pipeline/georgiaFinance/georgiaCandidateFinanceBatchSync.js", () => ({ syncDueGeorgiaCandidateFinance: legacy }));
    vi.doMock("../../src/pipeline/georgiaFinance/georgiaReportedFinanceBatchSync.js", () => ({ syncDueGeorgiaReportedFinance: reported }));
    const scheduler = await import("../../src/scheduler/georgiaCandidateFinanceSyncScheduler.js");
    scheduler.createGeorgiaCandidateFinanceSyncSchedulerWorker();
    return { processor, Worker, Pool, pool, legacy, reported, scheduler };
  }

  it.each([[true, false], [false, true], [true, true]])("installs a separate reported job for child gates IE=%s committee=%s while preserving legacy scheduling", async (ie, committee) => {
    enableReported(ie, committee);
    process.env.GEORGIA_CAMPAIGN_FINANCE_SYNC_ENABLED = "false";
    const queue = mockQueue();
    const { upsertRecurringGeorgiaCandidateFinanceSyncJobs } = await import("../../src/scheduler/georgiaCandidateFinanceSyncScheduler.js");
    await upsertRecurringGeorgiaCandidateFinanceSyncJobs();
    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(2);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith("georgia_candidate_finance_sync_daily", expect.any(Object),
      expect.objectContaining({ name: "georgia_candidate_finance_sync_due" }));
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith("georgia_reported_finance_sync_daily", expect.any(Object),
      expect.objectContaining({ name: "georgia_reported_finance_sync_due", data: expect.objectContaining({ triggeredBy: "daily" }) }));
    expect(queue.removeJobScheduler).not.toHaveBeenCalled();
    expect(queue.close).toHaveBeenCalledTimes(1);
  });

  it("removes only the reported schedule when child gates are off", async () => {
    enableReported(false, false);
    const queue = mockQueue();
    const { upsertRecurringGeorgiaCandidateFinanceSyncJobs } = await import("../../src/scheduler/georgiaCandidateFinanceSyncScheduler.js");
    await upsertRecurringGeorgiaCandidateFinanceSyncJobs();
    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith("georgia_candidate_finance_sync_daily", expect.any(Object), expect.any(Object));
    expect(queue.removeJobScheduler).toHaveBeenCalledWith("georgia_reported_finance_sync_daily");
    expect(queue.removeJobScheduler).not.toHaveBeenCalledWith("georgia_candidate_finance_sync_daily");
  });

  it("does not install the reported schedule through a disabled global parent", async () => {
    enableReported(true, true);
    process.env.CANDIDATE_FINANCE_ENABLED = "false";
    const queue = mockQueue();
    const { upsertRecurringGeorgiaCandidateFinanceSyncJobs } = await import("../../src/scheduler/georgiaCandidateFinanceSyncScheduler.js");
    await upsertRecurringGeorgiaCandidateFinanceSyncJobs();
    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(queue.removeJobScheduler).toHaveBeenCalledWith("georgia_reported_finance_sync_daily");
  });

  it("preserves the requested dry-run mode for the separate reported recurring job", async () => {
    enableReported(true, false);
    const queue = mockQueue();
    const { upsertRecurringGeorgiaCandidateFinanceSyncJobs } = await import("../../src/scheduler/georgiaCandidateFinanceSyncScheduler.js");
    await upsertRecurringGeorgiaCandidateFinanceSyncJobs({ dryRun: true });
    const reported = queue.upsertJobScheduler.mock.calls.find(call => call[0] === "georgia_reported_finance_sync_daily");
    expect(reported?.[2]).toMatchObject({ name: "georgia_reported_finance_sync_due", data: { dryRun: true, triggeredBy: "daily" } });
  });

  it("dispatches reported work independently while the legacy sync flag stays off", async () => {
    enableReported(true, false);
    process.env.GEORGIA_CAMPAIGN_FINANCE_SYNC_ENABLED = "false";
    process.env.DATABASE_URL = "postgresql://localhost:5432/synthetic_scheduler_test";
    const { processor, Pool, pool, legacy, reported } = await mockWorker();
    expect(await processor({ name: "georgia_candidate_finance_sync_due", data: { triggeredBy: "daily" } })).toMatchObject({ enabled: false });
    expect(Pool).not.toHaveBeenCalled();
    const data = { dryRun: true, refresh: true, cacheDir: "scratch/synthetic-georgia-cache", filingYear: 2026,
      electionYear: 2026, maxCandidates: 7, staleAfterDays: 3, electionLookbackDays: 30, electionLookaheadDays: 550 };
    expect(await processor({ name: "georgia_reported_finance_sync_due", data })).toMatchObject({ enabled: true, selectedCount: 1 });
    expect(Pool).toHaveBeenCalledTimes(1);
    expect(reported).toHaveBeenCalledWith({ db: pool, ...data });
    expect(legacy).not.toHaveBeenCalled();
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it("keeps legacy dispatch available with both reported gates off", async () => {
    enableReported(false, false);
    process.env.GEORGIA_CAMPAIGN_FINANCE_SYNC_ENABLED = "true";
    const { processor, legacy, reported, pool } = await mockWorker();
    expect(await processor({ name: "georgia_candidate_finance_sync_due", data: { triggeredBy: "daily" } })).toMatchObject({ enabled: true });
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(reported).not.toHaveBeenCalled();
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it.each(["children", "state", "global"])("disabled reported dispatch with %s off does not construct a DB pool or call either batch", async mode => {
    enableReported(mode !== "children", mode !== "children");
    if (mode === "state") process.env.GEORGIA_CAMPAIGN_FINANCE_ENABLED = "false";
    if (mode === "global") process.env.CANDIDATE_FINANCE_ENABLED = "false";
    delete process.env.DATABASE_URL;
    const { processor, Pool, legacy, reported } = await mockWorker();
    expect(await processor({ name: "georgia_reported_finance_sync_due", data: { force: true } })).toEqual({ enabled: false });
    expect(Pool).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled(); expect(reported).not.toHaveBeenCalled();
  });

  it("rejects an unknown job name before DB access and keeps queue concurrency one", async () => {
    enableReported(true, true);
    const { processor, Worker, Pool, legacy, reported } = await mockWorker();
    expect(Worker).toHaveBeenCalledWith("georgia_candidate_finance_sync_maintenance", expect.any(Function),
      expect.objectContaining({ concurrency: 1 }));
    await expect(processor({ name: "unexpected_job", data: {} })).rejects.toThrow("Unknown Georgia finance sync job name");
    expect(Pool).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled(); expect(reported).not.toHaveBeenCalled();
  });

  it("closes the reported DB pool when its independent batch fails", async () => {
    enableReported(false, true);
    process.env.DATABASE_URL = "postgresql://localhost:5432/synthetic_scheduler_test";
    const { processor, pool, legacy, reported } = await mockWorker();
    reported.mockRejectedValueOnce(new Error("Synthetic batch unavailable"));
    await expect(processor({ name: "georgia_reported_finance_sync_due", data: { dryRun: true } })).rejects.toThrow("Synthetic batch unavailable");
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled();
  });

});
