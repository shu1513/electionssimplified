import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());

import { syncDueDelawareCandidateFinance } from "../../../src/pipeline/delawareFinance/delawareCandidateFinanceBatchSync.js";
import type { DelawareCandidateFinanceDueRow } from "../../../src/pipeline/delawareFinance/delawareCandidateFinanceDueList.js";

function dueRow(overrides: Partial<DelawareCandidateFinanceDueRow> = {}): DelawareCandidateFinanceDueRow {
  return {
    candidateId: "c1",
    electionId: "e1",
    candidateName: "Jane Example",
    electionYear: 2026,
    electionDate: "2026-11-03",
    officeScope: "statewide",
    officeName: "Attorney General",
    district: null,
    cfId: "01009999",
    committeeName: "Jane Example for Delaware",
    linkSource: "cfrs_portal",
    sourceUrl: null,
    lastSyncedAt: null,
    ...overrides,
  };
}

const db = { query: vi.fn(), connect: vi.fn() } as never;

describe("syncDueDelawareCandidateFinance", () => {
  it("auto-links, acquires artifacts, syncs each due row, and isolates per-candidate failures", async () => {
    // The per-run force stands in for the refresh env var but never for the
    // base flag (established force semantics).
    vi.stubEnv("DELAWARE_CAMPAIGN_FINANCE_ENABLED", "true");
    const autoLinkFn = vi.fn().mockResolvedValue([{ candidateId: "cX", electionId: "eX", status: "linked" }]);
    const acquireArtifactsFn = vi.fn().mockResolvedValue({ receiptRowCount: 2 });
    const syncCandidateFn = vi
      .fn()
      .mockResolvedValueOnce({ dryRun: false, totalReceipts: 700 })
      .mockRejectedValueOnce(new Error("No Delaware CFRS artifact bundle cached for CF_ID 01008888"));
    const listDueRowsFn = vi.fn().mockResolvedValue({
      rows: [dueRow(), dueRow({ candidateId: "c2", cfId: "01008888" })],
      totalDueRows: 2,
    });

    const result = await syncDueDelawareCandidateFinance({
      db,
      now: new Date("2026-08-28T00:00:00.000Z"),
      forceRawDataRefresh: true,
      cacheDir: "/tmp/de-cache",
      autoLinkFn,
      listDueRowsFn,
      acquireArtifactsFn,
      syncCandidateFn,
      log: () => {},
    });

    expect(autoLinkFn).toHaveBeenCalledTimes(1);
    expect(acquireArtifactsFn).toHaveBeenCalledTimes(2);
    expect(acquireArtifactsFn.mock.calls[0]?.[0]).toMatchObject({
      cfId: "01009999",
      cacheDir: "/tmp/de-cache",
    });
    expect(result.attempted).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.candidates[1]?.error).toContain("No Delaware CFRS artifact bundle cached");
    expect(syncCandidateFn.mock.calls[0]?.[0]).toMatchObject({ candidateId: "c1", dryRun: false });
  });

  it("acquires once per CF_ID and records an acquisition failure per candidate", async () => {
    vi.stubEnv("DELAWARE_CAMPAIGN_FINANCE_ENABLED", "true");
    const acquireArtifactsFn = vi.fn().mockRejectedValue(new Error("CFRS request failed after 3 attempts"));
    const syncCandidateFn = vi.fn().mockResolvedValue({ dryRun: false });
    const listDueRowsFn = vi.fn().mockResolvedValue({
      rows: [dueRow(), dueRow({ candidateId: "c2", electionId: "e2" })],
      totalDueRows: 2,
    });

    const result = await syncDueDelawareCandidateFinance({
      db,
      forceRawDataRefresh: true,
      autoLinkMissingLinks: false,
      listDueRowsFn,
      acquireArtifactsFn,
      syncCandidateFn,
      log: () => {},
    });

    // Same CF_ID on both rows: the failed fetch is attempted once, the first
    // row fails on it, the second row still syncs against the cache.
    expect(acquireArtifactsFn).toHaveBeenCalledTimes(1);
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.candidates[0]?.error).toContain("CFRS request failed");
    expect(syncCandidateFn).toHaveBeenCalledTimes(1);
  });

  it("skips auto-link and acquisition on dry runs and continues when the auto-link pass fails", async () => {
    vi.stubEnv("DELAWARE_CAMPAIGN_FINANCE_ENABLED", "true");
    const autoLinkFn = vi.fn().mockRejectedValue(new Error("portal down"));
    const acquireArtifactsFn = vi.fn();
    const syncCandidateFn = vi.fn().mockResolvedValue({ dryRun: true });
    const listDueRowsFn = vi.fn().mockResolvedValue({ rows: [], totalDueRows: 0 });

    const dry = await syncDueDelawareCandidateFinance({
      db,
      dryRun: true,
      forceRawDataRefresh: true,
      autoLinkFn,
      listDueRowsFn: vi.fn().mockResolvedValue({ rows: [dueRow()], totalDueRows: 1 }),
      acquireArtifactsFn,
      syncCandidateFn,
      log: () => {},
    });
    expect(autoLinkFn).not.toHaveBeenCalled();
    expect(acquireArtifactsFn).not.toHaveBeenCalled();
    expect(dry.attempted).toBe(1);

    const live = await syncDueDelawareCandidateFinance({
      db,
      forceRawDataRefresh: true,
      autoLinkFn,
      listDueRowsFn,
      acquireArtifactsFn,
      log: () => {},
    });
    expect(autoLinkFn).toHaveBeenCalledTimes(1);
    expect(live.autoLinkResults).toEqual([]);
  });

  it("never contacts the live portal when the raw-data-refresh flag is off", async () => {
    vi.stubEnv("DELAWARE_CAMPAIGN_FINANCE_ENABLED", "true");
    const autoLinkFn = vi.fn();
    const acquireArtifactsFn = vi.fn();
    const syncCandidateFn = vi.fn().mockResolvedValue({ dryRun: false });
    const listDueRowsFn = vi.fn().mockResolvedValue({ rows: [dueRow()], totalDueRows: 1 });
    const messages: string[] = [];

    const result = await syncDueDelawareCandidateFinance({
      db,
      autoLinkFn,
      listDueRowsFn,
      acquireArtifactsFn,
      syncCandidateFn,
      log: (message) => messages.push(message),
    });
    expect(autoLinkFn).not.toHaveBeenCalled();
    expect(acquireArtifactsFn).not.toHaveBeenCalled();
    expect(syncCandidateFn).toHaveBeenCalledTimes(1);
    expect(result.autoLinkResults).toEqual([]);
    expect(
      messages.some((message) =>
        message.includes("live CFRS passes (auto-link, artifact acquisition) skipped")
      )
    ).toBe(true);
  });
  it.each([{ candidateId: "11111111-1111-4111-8111-111111111111" }, { electionYear: 2026 }])(
    "skips unrelated autolink and passes explicit SQL scope: %j",
    async (scope) => {
      vi.stubEnv("DELAWARE_CAMPAIGN_FINANCE_ENABLED", "true");
      const autoLinkFn = vi.fn();
      const acquireArtifactsFn = vi.fn().mockResolvedValue({});
      const syncCandidateFn = vi.fn().mockResolvedValue({ dryRun: false });
      const listDueRowsFn = vi.fn().mockResolvedValue({ rows: [dueRow()], totalDueRows: 1 });
      await syncDueDelawareCandidateFinance({
        db,
        ...scope,
        refresh: true,
        electionLookbackDays: 100,
        forceRawDataRefresh: true,
        autoLinkFn,
        acquireArtifactsFn,
        syncCandidateFn,
        listDueRowsFn,
        log: () => {},
      });
      expect(autoLinkFn).not.toHaveBeenCalled();
      expect(listDueRowsFn.mock.calls[0]?.[1]).toMatchObject({
        ...scope,
        refresh: true,
        electionLookbackDays: 100,
      });
      expect(acquireArtifactsFn).toHaveBeenCalledTimes(1);
    }
  );

  it("refresh does not authorize the live portal and force does not request refresh", async () => {
    vi.stubEnv("DELAWARE_CAMPAIGN_FINANCE_ENABLED", "true");
    const autoLinkFn = vi.fn();
    const acquireArtifactsFn = vi.fn();
    const syncCandidateFn = vi.fn().mockResolvedValue({ dryRun: false });
    const listDueRowsFn = vi.fn().mockResolvedValue({ rows: [dueRow()], totalDueRows: 1 });
    await syncDueDelawareCandidateFinance({
      db,
      refresh: true,
      autoLinkFn,
      acquireArtifactsFn,
      syncCandidateFn,
      listDueRowsFn,
      log: () => {},
    });
    expect(autoLinkFn).not.toHaveBeenCalled();
    expect(acquireArtifactsFn).not.toHaveBeenCalled();
    expect(listDueRowsFn.mock.calls[0]?.[1]).toMatchObject({ refresh: true, electionLookbackDays: 39 });
    listDueRowsFn.mockClear();
    await syncDueDelawareCandidateFinance({
      db,
      forceRawDataRefresh: true,
      autoLinkMissingLinks: false,
      listDueRowsFn,
      acquireArtifactsFn: vi.fn().mockResolvedValue({}),
      syncCandidateFn,
      log: () => {},
    });
    expect(listDueRowsFn.mock.calls[0]?.[1]).not.toHaveProperty("refresh");
  });

  it("a scoped refresh dry run never auto-links, acquires or writes", async () => {
    vi.stubEnv("DELAWARE_CAMPAIGN_FINANCE_ENABLED", "true");
    const autoLinkFn = vi.fn();
    const acquireArtifactsFn = vi.fn();
    const syncCandidateFn = vi.fn().mockResolvedValue({ dryRun: true });
    await syncDueDelawareCandidateFinance({
      db,
      candidateId: "11111111-1111-4111-8111-111111111111",
      electionYear: 2026,
      refresh: true,
      dryRun: true,
      forceRawDataRefresh: true,
      autoLinkFn,
      acquireArtifactsFn,
      syncCandidateFn,
      listDueRowsFn: vi.fn().mockResolvedValue({ rows: [dueRow()], totalDueRows: 1 }),
      log: () => {},
    });
    expect(autoLinkFn).not.toHaveBeenCalled();
    expect(acquireArtifactsFn).not.toHaveBeenCalled();
    expect(syncCandidateFn.mock.calls[0]?.[0]).toMatchObject({ dryRun: true });
  });

  it.each([
    { candidateId: "bad" },
    { electionYear: 2025 },
    { maxCandidates: 0 },
    { electionLookbackDays: -1 },
  ])("rejects bad selection before source calls: %j", async (scope) => {
    const autoLinkFn = vi.fn();
    const listDueRowsFn = vi.fn();
    await expect(
      syncDueDelawareCandidateFinance({ db, ...scope, forceRawDataRefresh: true, autoLinkFn, listDueRowsFn })
    ).rejects.toThrow("Invalid Delaware finance");
    expect(autoLinkFn).not.toHaveBeenCalled();
    expect(listDueRowsFn).not.toHaveBeenCalled();
  });
});
