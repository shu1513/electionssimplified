import { describe, expect, it } from "vitest";

import { DEFAULT_CANDIDATE_FINANCE_BATCH_SIZE } from "../../src/pipeline/finance/candidateFinanceBatchSync.js";
import {
  DEFAULT_OPEN_FEC_LARGE_DRAIN_REQUEST_INTERVAL_MS,
  createOpenFecPacingPlan,
  parseSyncDueCandidateFinanceScriptArgs,
  toSyncDueCandidateFinanceScriptOutput,
} from "../../src/scripts/syncDueCandidateFinance.js";

describe("syncDueCandidateFinance script", () => {
  it("parses optional flags", () => {
    expect(
      parseSyncDueCandidateFinanceScriptArgs([
        "--dry-run",
        "--include-outside",
        "--max-candidates=12",
        "--stale-after-days",
        "3",
        "--lookback-days=10",
        "--lookahead-days=365",
        "--per-page=25",
        "--top-groups",
        "8",
        "--timeout-ms=5000",
        "--request-interval-ms=3700",
        "--include-contributors",
        "--bulk-data-dir=/tmp/fec-bulk",
        "--contributor-candidate-ids=H4CA00002, S4CA00001",
      ])
    ).toEqual({
      dryRun: true,
      includeOutside: true,
      includeContributors: true,
      contributorsOnly: false,
      bulkDataDirectory: "/tmp/fec-bulk",
      contributorCandidateIds: ["H4CA00002", "S4CA00001"],
      maxCandidates: 12,
      staleAfterDays: 3,
      electionLookbackDays: 10,
      electionLookaheadDays: 365,
      perPage: 25,
      outsideGroupLimit: 8,
      timeoutMs: 5000,
      requestIntervalMs: 3700,
    });
  });

  it("rejects malformed numeric flags strictly", () => {
    expect(() => parseSyncDueCandidateFinanceScriptArgs(["--max-candidates=10abc"])).toThrow(
      "Invalid --max-candidates value"
    );
    expect(() => parseSyncDueCandidateFinanceScriptArgs(["--stale-after-days=0"])).toThrow(
      "Invalid --stale-after-days value"
    );
    expect(() => parseSyncDueCandidateFinanceScriptArgs(["--request-interval-ms=-1"])).toThrow(
      "Invalid --request-interval-ms value"
    );
    expect(() => parseSyncDueCandidateFinanceScriptArgs(["--request-interval-ms=1.5"])).toThrow(
      "Invalid --request-interval-ms value"
    );
    expect(() => parseSyncDueCandidateFinanceScriptArgs(["--max-candidates=9007199254740992"])).toThrow(
      "Invalid --max-candidates value"
    );
  });

  it("allows explicitly disabling request pacing", () => {
    expect(parseSyncDueCandidateFinanceScriptArgs(["--request-interval-ms=0"])).toMatchObject({
      requestIntervalMs: 0,
    });
  });

  it("enables quota-safe pacing by default for a large drain", () => {
    const pacing = createOpenFecPacingPlan({
      dryRun: false,
      includeOutside: false,
      maxCandidates: 283,
    });

    expect(DEFAULT_OPEN_FEC_LARGE_DRAIN_REQUEST_INTERVAL_MS).toBe(4000);
    expect(pacing.requestIntervalMs).toBe(4000);
    expect(pacing.rateLimiter).toEqual(expect.any(Function));
  });

  it("keeps a normal small batch fast when the interval flag is omitted", () => {
    expect(
      createOpenFecPacingPlan({
        dryRun: false,
        includeOutside: false,
      })
    ).toEqual({ requestIntervalMs: 0 });

    expect(
      createOpenFecPacingPlan({
        dryRun: false,
        includeOutside: false,
        maxCandidates: 5,
      })
    ).toEqual({ requestIntervalMs: 0 });
  });

  it("applies automatic pacing strictly above the normal batch-size boundary", () => {
    expect(
      createOpenFecPacingPlan({
        dryRun: false,
        includeOutside: false,
        maxCandidates: DEFAULT_CANDIDATE_FINANCE_BATCH_SIZE,
      })
    ).toEqual({ requestIntervalMs: 0 });

    const pacing = createOpenFecPacingPlan({
      dryRun: false,
      includeOutside: false,
      maxCandidates: DEFAULT_CANDIDATE_FINANCE_BATCH_SIZE + 1,
    });
    expect(pacing.requestIntervalMs).toBe(DEFAULT_OPEN_FEC_LARGE_DRAIN_REQUEST_INTERVAL_MS);
    expect(pacing.rateLimiter).toEqual(expect.any(Function));
  });

  it("preserves explicit pacing disable and positive overrides for large drains", () => {
    expect(
      createOpenFecPacingPlan({
        dryRun: false,
        includeOutside: false,
        maxCandidates: 283,
        requestIntervalMs: 0,
      })
    ).toEqual({ requestIntervalMs: 0 });

    const pacing = createOpenFecPacingPlan({
      dryRun: false,
      includeOutside: false,
      maxCandidates: 283,
      requestIntervalMs: 250,
    });
    expect(pacing.requestIntervalMs).toBe(250);
    expect(pacing.rateLimiter).toEqual(expect.any(Function));
  });

  it("formats script output", () => {
    const output = toSyncDueCandidateFinanceScriptOutput({
      startedAt: new Date("2026-01-02T03:04:05.000Z"),
      options: {
        dryRun: true,
        includeOutside: true,
        maxCandidates: 2,
      },
      requestIntervalMs: 250,
      result: {
        dryRun: true,
        includeOutside: true,
        now: "2026-01-02T03:04:05.000Z",
        staleAfterDays: 7,
        maxCandidates: 2,
        dueCandidateCount: 3,
        selectedCandidateCount: 2,
        syncedCandidateCount: 1,
        failedCandidateCount: 1,
        results: [],
      },
    });

    expect(output).toMatchObject({
      type: "candidate_finance_due_sync",
      started_at: "2026-01-02T03:04:05.000Z",
      dry_run: true,
      include_outside: true,
      request_interval_ms: 250,
      result: {
        dueCandidateCount: 3,
        selectedCandidateCount: 2,
      },
    });
    expect(typeof output.ts).toBe("string");
  });
});
