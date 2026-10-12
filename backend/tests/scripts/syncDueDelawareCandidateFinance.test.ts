import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pool: { query: vi.fn(), connect: vi.fn(), end: vi.fn() },
  batch: vi.fn(),
  enabled: vi.fn(),
}));
vi.mock("pg", () => ({
  Pool: vi.fn(function () {
    return mocks.pool;
  }),
}));
vi.mock("../../src/config/env.js", () => ({ loadProjectEnv: vi.fn() }));
vi.mock("../../src/config/featureFlags.js", () => ({ isDelawareCampaignFinanceSyncEnabled: mocks.enabled }));
vi.mock("../../src/pipeline/delawareFinance/delawareCandidateFinanceBatchSync.js", () => ({
  syncDueDelawareCandidateFinance: mocks.batch,
}));

import {
  parseDelawareSyncDueArgs,
  runSyncDueDelawareCandidateFinance,
} from "../../src/scripts/syncDueDelawareCandidateFinance.js";
const ID = "11111111-1111-4111-8111-111111111111";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.batch.mockResolvedValue({ attempted: 0, failed: 0 });
  mocks.enabled.mockReturnValue(false);
  vi.stubEnv("DATABASE_URL", "postgresql:///voteapp?host=/tmp&connect_timeout=5");
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Delaware scoped finance CLI", () => {
  it("preserves dry-run defaults and keeps force separate from refresh", () => {
    expect(parseDelawareSyncDueArgs([])).toMatchObject({
      maxCandidates: 10,
      autoLinkMissingLinks: true,
      write: false,
      force: false,
      refresh: false,
      electionLookbackDays: undefined,
    });
    expect(parseDelawareSyncDueArgs(["--force"])).toMatchObject({ force: true, refresh: false });
    expect(parseDelawareSyncDueArgs(["--refresh"])).toMatchObject({ force: false, refresh: true });
  });
  it("forwards scope, fresh selection and January lookback with dryRun true", async () => {
    await runSyncDueDelawareCandidateFinance([
      "--candidate-id",
      ID,
      "--election-year",
      "2026",
      "--refresh",
      "--lookback-days",
      "100",
      "--max",
      "1",
    ]);
    expect(mocks.batch).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: ID,
        electionYear: 2026,
        refresh: true,
        electionLookbackDays: 100,
        maxCandidates: 1,
        dryRun: true,
        forceRawDataRefresh: false,
      })
    );
    expect(mocks.enabled).not.toHaveBeenCalled();
    expect(mocks.pool.query).not.toHaveBeenCalled();
    expect(mocks.pool.end).toHaveBeenCalledTimes(1);
  });
  it("refresh alone cannot authorize writes", async () => {
    await expect(runSyncDueDelawareCandidateFinance(["--refresh", "--write"])).rejects.toThrow(
      "writes are disabled"
    );
    expect(mocks.enabled).toHaveBeenCalledWith(false);
    expect(mocks.batch).not.toHaveBeenCalled();
  });
  it("keeps the local-only guard for explicit writes", async () => {
    mocks.enabled.mockReturnValue(true);
    vi.stubEnv("DATABASE_URL", "postgresql://example.invalid/voteapp");
    await expect(runSyncDueDelawareCandidateFinance(["--write", "--force", "--refresh"])).rejects.toThrow();
    expect(mocks.batch).not.toHaveBeenCalled();
  });
  it.each([
    ["--candidate-id", "bad"],
    ["--candidate-id"],
    ["--election-year", "2025"],
    ["--election-year", "2101"],
    ["--election-year", "2026x"],
    ["--election-year", "2026.5"],
    ["--max", "1junk"],
    ["--max", "1.5"],
    ["--stale-days", "0"],
    ["--lookback-days", "-1"],
    ["--lookback-days", "2147483648"],
    ["--refresh=true"],
    ["--refresh", "--refresh"],
    ["--max", "1", "--max", "2"],
    ["--lookback-days"],
    ["--candidate-id=" + ID],
    ["--unknown"],
    ["positional"],
  ])("rejects malformed flags before any orchestration: %j", async (args) => {
    await expect(runSyncDueDelawareCandidateFinance(args)).rejects.toThrow();
    expect(mocks.batch).not.toHaveBeenCalled();
    expect(mocks.pool.query).not.toHaveBeenCalled();
  });
});
