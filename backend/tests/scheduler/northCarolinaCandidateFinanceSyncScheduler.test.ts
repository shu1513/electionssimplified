import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("northCarolinaCandidateFinanceSyncScheduler", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.NORTH_CAROLINA_CAMPAIGN_FINANCE_ENABLED;
    delete process.env.NORTH_CAROLINA_CAMPAIGN_FINANCE_SYNC_ENABLED;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("rejects unsafe integer job options that Number() rounding could smuggle in", async () => {
    process.env.NORTH_CAROLINA_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.NORTH_CAROLINA_CAMPAIGN_FINANCE_SYNC_ENABLED = "true";
    const Pool = vi.fn();
    vi.doMock("pg", () => ({ Pool }));

    const { runNorthCarolinaCandidateFinanceSyncJob } = await import(
      "../../src/scheduler/northCarolinaCandidateFinanceSyncScheduler.js"
    );

    await expect(
      runNorthCarolinaCandidateFinanceSyncJob({ triggeredBy: "manual", maxCandidates: 2 ** 53 })
    ).rejects.toThrow("Invalid North Carolina finance sync scheduler maxCandidates");
    expect(Pool).not.toHaveBeenCalled();
  });
});

describe("independent NC reported receipt scheduler", () => {
  const originalEnv = { ...process.env };
  const reportedName = "north_carolina_reported_receipt_finance_sync_due";
  const reportedId = "north_carolina_reported_receipt_finance_sync_daily";
  const legacyName = "north_carolina_candidate_finance_sync_due";
  const legacyId = "north_carolina_candidate_finance_sync_daily";
  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks(); process.env = { ...originalEnv };
    process.env.CANDIDATE_FINANCE_ENABLED = "true";
    process.env.NORTH_CAROLINA_CAMPAIGN_FINANCE_ENABLED = "true";
    process.env.NORTH_CAROLINA_CAMPAIGN_FINANCE_SYNC_ENABLED = "false";
    process.env.NORTH_CAROLINA_REPORTED_COMMITTEE_RECEIPTS_ENABLED = "true";
    process.env.DATABASE_URL = "postgresql://synthetic-only.invalid/scheduler";
  });
  afterEach(() => { vi.useRealTimers(); process.env = { ...originalEnv }; vi.resetModules(); });
  function mockRuntime(allowLegacyEnv = false) {
    const getPipelineEnv = vi.fn(() => {
      if (!allowLegacyEnv) throw new Error("Unexpected legacy environment access");
      return { REDIS_URL: "redis://synthetic-only.invalid:6379/0", DATABASE_URL: "postgresql://legacy-synthetic.invalid/scheduler" };
    });
    vi.doMock("../../src/config/env.js", () => ({ getPipelineEnv }));
    const pool = { query: vi.fn(), end: vi.fn().mockResolvedValue(undefined) }, Pool = vi.fn(() => pool);
    vi.doMock("pg", () => ({ Pool }));
    const legacy = vi.fn().mockResolvedValue({ selectedCandidateCount: 1 });
    const reported = vi.fn().mockResolvedValue({ enabled: true, attemptedCount: 1, qualifiedCount: 1, writtenCount: 1 });
    vi.doMock("../../src/pipeline/northCarolinaFinance/northCarolinaCandidateFinanceBatchSync.js", () => ({ syncDueNorthCarolinaCandidateFinance: legacy }));
    vi.doMock("../../src/pipeline/northCarolinaFinance/northCarolinaReportedReceiptFinanceBatchSync.js", () => ({ syncDueNorthCarolinaReportedReceiptFinance: reported }));
    return { getPipelineEnv, pool, Pool, legacy, reported };
  }
  async function runtime() {
    const mocks = mockRuntime();
    return { ...mocks, scheduler: await import("../../src/scheduler/northCarolinaCandidateFinanceSyncScheduler.js") };
  }
  async function queueRuntime() {
    const mocks = mockRuntime(true), queue = { upsertJobScheduler: vi.fn().mockResolvedValue(undefined), removeJobScheduler: vi.fn().mockResolvedValue(true), close: vi.fn().mockResolvedValue(undefined) };
    vi.doMock("bullmq", () => ({ Queue: vi.fn(() => queue), Worker: vi.fn() }));
    return { ...mocks, queue, scheduler: await import("../../src/scheduler/northCarolinaCandidateFinanceSyncScheduler.js") };
  }
  async function workerRuntime() {
    const mocks = mockRuntime(true); let processor!: (job: { name: string; data?: Record<string, unknown> }) => Promise<unknown>;
    const Worker = vi.fn((_queueName, callback, _options) => { processor = callback; return {}; });
    vi.doMock("bullmq", () => ({ Queue: vi.fn(), Worker }));
    const scheduler = await import("../../src/scheduler/northCarolinaCandidateFinanceSyncScheduler.js");
    scheduler.createNorthCarolinaCandidateFinanceSyncSchedulerWorker();
    return { ...mocks, scheduler, processor, Worker };
  }

  it.each(["CANDIDATE_FINANCE_ENABLED", "NORTH_CAROLINA_CAMPAIGN_FINANCE_ENABLED", "NORTH_CAROLINA_REPORTED_COMMITTEE_RECEIPTS_ENABLED"])("disabled %s cannot be bypassed by force and touches no env/Pool/batch", async flag => {
    process.env[flag] = "false"; delete process.env.DATABASE_URL;
    const { scheduler, Pool, getPipelineEnv, legacy, reported } = await runtime();
    expect(await scheduler.runNorthCarolinaReportedReceiptFinanceSyncJob({ force: true })).toEqual({ enabled: false });
    expect(Pool).not.toHaveBeenCalled(); expect(getPipelineEnv).not.toHaveBeenCalled(); expect(legacy).not.toHaveBeenCalled(); expect(reported).not.toHaveBeenCalled();
  });
  it("defaults the child gate off without env/Pool construction", async () => {
    delete process.env.NORTH_CAROLINA_REPORTED_COMMITTEE_RECEIPTS_ENABLED;
    const { scheduler, Pool, getPipelineEnv } = await runtime(); expect(await scheduler.runNorthCarolinaReportedReceiptFinanceSyncJob()).toEqual({ enabled: false });
    expect(Pool).not.toHaveBeenCalled(); expect(getPipelineEnv).not.toHaveBeenCalled();
  });
  it("uses only process DATABASE_URL and preserves new options independently of the old direct gate", async () => {
    const { scheduler, Pool, pool, getPipelineEnv, reported, legacy } = await runtime();
    const data = { dryRun: true, refresh: true, cacheDir: "scratch/synthetic-receipts", electionYear: 2026, maxCandidates: 5, staleAfterDays: 7, electionLookbackDays: 0, electionLookaheadDays: 730, force: true };
    expect(await scheduler.runNorthCarolinaReportedReceiptFinanceSyncJob(data)).toMatchObject({ enabled: true, writtenCount: 1 });
    expect(Pool).toHaveBeenCalledWith({ connectionString: process.env.DATABASE_URL });
    expect(reported).toHaveBeenCalledWith({ db: pool, dryRun: true, refresh: true, cacheDir: data.cacheDir, electionYear: 2026, maxCandidates: 5, staleAfterDays: 7, electionLookbackDays: 0, electionLookaheadDays: 730 });
    expect(getPipelineEnv).not.toHaveBeenCalled(); expect(legacy).not.toHaveBeenCalled(); expect(pool.end).toHaveBeenCalledOnce();
  });
  it("rejects missing process DATABASE_URL without loading environment files or constructing a pool", async () => {
    delete process.env.DATABASE_URL; const { scheduler, Pool, getPipelineEnv, reported } = await runtime();
    await expect(scheduler.runNorthCarolinaReportedReceiptFinanceSyncJob()).rejects.toThrow("DATABASE_URL is required for North Carolina reported receipt finance sync");
    expect(Pool).not.toHaveBeenCalled(); expect(getPipelineEnv).not.toHaveBeenCalled(); expect(reported).not.toHaveBeenCalled();
  });
  it.each([
    { maxCandidates: 2 ** 53 }, { maxCandidates: 100001 }, { staleAfterDays: 0 }, { electionLookbackDays: -1 }, { electionLookaheadDays: NaN },
    { electionYear: 1999 }, { electionYear: 2101 }, { electionYear: 2026.5 }, { cacheDir: " " }, { refresh: "true" }, { dryRun: "true" },
  ])("rejects invalid reported job options before env/Pool access: %j", async data => {
    const { scheduler, Pool, getPipelineEnv, reported } = await runtime();
    await expect(scheduler.runNorthCarolinaReportedReceiptFinanceSyncJob(data as never)).rejects.toThrow("Invalid North Carolina reported receipt scheduler option");
    expect(Pool).not.toHaveBeenCalled(); expect(getPipelineEnv).not.toHaveBeenCalled(); expect(reported).not.toHaveBeenCalled();
  });
  it("closes the process-configured pool when the independent batch fails", async () => {
    const { scheduler, pool, reported } = await runtime(); reported.mockRejectedValueOnce(new Error("Synthetic reported batch failure"));
    await expect(scheduler.runNorthCarolinaReportedReceiptFinanceSyncJob()).rejects.toThrow("Synthetic reported batch failure"); expect(pool.end).toHaveBeenCalledOnce();
  });
  it("adds the independent recurring definition even while the old sync gate is off, preserving the legacy payload", async () => {
    process.env.NORTH_CAROLINA_CAMPAIGN_FINANCE_SYNC_DAILY_CRON = "20 9 * * *"; process.env.NORTH_CAROLINA_CAMPAIGN_FINANCE_SYNC_DAILY_TZ = "America/New_York";
    const { scheduler, queue } = await queueRuntime();
    await scheduler.upsertRecurringNorthCarolinaCandidateFinanceSyncJobs({ dryRun: true, force: true, maxCandidates: 5, staleAfterDays: 7, rawDataCacheDir: "scratch/synthetic-old", cacheDir: "scratch/synthetic-new", refresh: true, electionYear: 2026 });
    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(2);
    const legacy = queue.upsertJobScheduler.mock.calls.find(c => c[0] === legacyId)![2];
    expect(legacy).toEqual({ name: legacyName, data: { dryRun: true, force: true, maxCandidates: 5, staleAfterDays: 7, electionLookbackDays: undefined, electionLookaheadDays: undefined, rawDataCacheDir: "scratch/synthetic-old", triggeredBy: "daily" }, opts: { removeOnComplete: 1000, removeOnFail: 1000 } });
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(reportedId, { pattern: "20 9 * * *", tz: "America/New_York" }, { name: reportedName, data: { triggeredBy: "daily", dryRun: true, refresh: true, cacheDir: "scratch/synthetic-new", electionYear: 2026, maxCandidates: 5, staleAfterDays: 7, electionLookbackDays: undefined, electionLookaheadDays: undefined }, opts: { removeOnComplete: 1000, removeOnFail: 1000 } });
    expect(queue.removeJobScheduler).not.toHaveBeenCalled(); expect(queue.close).toHaveBeenCalledOnce();
  });
  it.each(["CANDIDATE_FINANCE_ENABLED", "NORTH_CAROLINA_REPORTED_COMMITTEE_RECEIPTS_ENABLED"])("removes only reported schedule with %s off while retaining legacy scheduling", async flag => {
    process.env[flag] = "false"; const { scheduler, queue } = await queueRuntime(); await scheduler.upsertRecurringNorthCarolinaCandidateFinanceSyncJobs();
    expect(queue.removeJobScheduler).toHaveBeenCalledWith(reportedId); expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(legacyId, expect.any(Object), expect.any(Object)); expect(queue.close).toHaveBeenCalledOnce();
  });
  it("removes both recurring definitions when the state master is off", async () => {
    process.env.NORTH_CAROLINA_CAMPAIGN_FINANCE_ENABLED = "false"; const { scheduler, queue } = await queueRuntime(); await scheduler.upsertRecurringNorthCarolinaCandidateFinanceSyncJobs();
    expect(queue.removeJobScheduler).toHaveBeenCalledWith(legacyId); expect(queue.removeJobScheduler).toHaveBeenCalledWith(reportedId); expect(queue.upsertJobScheduler).not.toHaveBeenCalled(); expect(queue.close).toHaveBeenCalledOnce();
  });
  it("closes the queue on reported schedule failure", async () => {
    const { scheduler, queue } = await queueRuntime(); queue.upsertJobScheduler.mockImplementation(async id => { if (id === reportedId) throw new Error("Synthetic schedule failure"); });
    await expect(scheduler.upsertRecurringNorthCarolinaCandidateFinanceSyncJobs()).rejects.toThrow("Synthetic schedule failure"); expect(queue.close).toHaveBeenCalledOnce();
  });
  it("dispatches both named jobs on the same concurrency-one worker", async () => {
    const { processor, Worker, Pool, pool, legacy, reported, getPipelineEnv } = await workerRuntime(); getPipelineEnv.mockClear();
    expect(Worker).toHaveBeenCalledWith("north_carolina_candidate_finance_sync_maintenance", expect.any(Function), expect.objectContaining({ concurrency: 1 }));
    expect(await processor({ name: legacyName, data: { triggeredBy: "daily" } })).toMatchObject({ enabled: false }); expect(Pool).not.toHaveBeenCalled();
    expect(await processor({ name: reportedName, data: { dryRun: true, electionYear: 2026 } })).toMatchObject({ enabled: true }); expect(reported).toHaveBeenCalledOnce(); expect(legacy).not.toHaveBeenCalled(); expect(getPipelineEnv).not.toHaveBeenCalled(); expect(pool.end).toHaveBeenCalledOnce();
  });
  it("preserves legacy dispatch when reported gate is off", async () => {
    process.env.NORTH_CAROLINA_CAMPAIGN_FINANCE_SYNC_ENABLED = "true"; process.env.NORTH_CAROLINA_REPORTED_COMMITTEE_RECEIPTS_ENABLED = "false";
    const { processor, legacy, reported, pool } = await workerRuntime(); expect(await processor({ name: legacyName, data: { triggeredBy: "daily", dryRun: true } })).toMatchObject({ enabled: true });
    expect(legacy).toHaveBeenCalledOnce(); expect(reported).not.toHaveBeenCalled(); expect(pool.end).toHaveBeenCalledOnce();
  });
  it("ignores force on disabled reported worker dispatch and rejects unknown names before DB/env access", async () => {
    process.env.NORTH_CAROLINA_REPORTED_COMMITTEE_RECEIPTS_ENABLED = "false";
    const { processor, Pool, reported, legacy, getPipelineEnv } = await workerRuntime(); getPipelineEnv.mockClear();
    expect(await processor({ name: reportedName, data: { force: true } })).toEqual({ enabled: false });
    await expect(processor({ name: "synthetic_unknown_job", data: {} })).rejects.toThrow("Unknown North Carolina finance sync job name");
    expect(Pool).not.toHaveBeenCalled(); expect(reported).not.toHaveBeenCalled(); expect(legacy).not.toHaveBeenCalled(); expect(getPipelineEnv).not.toHaveBeenCalled();
  });
});
