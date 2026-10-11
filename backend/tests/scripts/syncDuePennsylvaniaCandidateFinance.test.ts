import { describe, expect, it } from "vitest";

import {
  parseSyncDuePennsylvaniaCandidateFinanceScriptArgs,
  toSyncDuePennsylvaniaCandidateFinanceScriptOutput,
} from "../../src/scripts/syncDuePennsylvaniaCandidateFinance.js";

describe("syncDuePennsylvaniaCandidateFinance script", () => {
  it("parses optional flags", () => {
    expect(
      parseSyncDuePennsylvaniaCandidateFinanceScriptArgs([
        "--dry-run",
        "--force",
        "--max-candidates=12",
        "--stale-after-days",
        "3",
        "--lookback-days=10",
        "--lookahead-days=365",
        "--raw-cache-dir=/tmp/pa-cf",
        "--raw-extracted-dir=/tmp/pa-cf/2022",
        "--skip-outside-spending",
      ])
    ).toEqual({
      dryRun: true,
      force: true,
      skipOutsideSpending: true,
      maxCandidates: 12,
      staleAfterDays: 3,
      electionLookbackDays: 10,
      electionLookaheadDays: 365,
      rawCacheDir: "/tmp/pa-cf",
      rawExtractedDir: "/tmp/pa-cf/2022",
    });
  });

  it("defaults to AI industry classification enabled", () => {
    expect(parseSyncDuePennsylvaniaCandidateFinanceScriptArgs([])).toMatchObject({
      dryRun: false,
      force: false,
      skipOutsideSpending: false,
    });
  });

  it("rejects malformed numeric flags strictly", () => {
    expect(() => parseSyncDuePennsylvaniaCandidateFinanceScriptArgs(["--max-candidates=10abc"])).toThrow(
      "Invalid --max-candidates value"
    );
    expect(() => parseSyncDuePennsylvaniaCandidateFinanceScriptArgs(["--stale-after-days=0"])).toThrow(
      "Invalid --stale-after-days value"
    );
    expect(() => parseSyncDuePennsylvaniaCandidateFinanceScriptArgs(["--lookahead-days=5.5"])).toThrow(
      "Invalid --lookahead-days value"
    );
  });

  it("rejects missing or duplicate option values", () => {
    expect(() => parseSyncDuePennsylvaniaCandidateFinanceScriptArgs(["--stale-after-days"])).toThrow(
      "Missing --stale-after-days value"
    );
    expect(() => parseSyncDuePennsylvaniaCandidateFinanceScriptArgs(["--lookback-days", "--force"])).toThrow(
      "Missing --lookback-days value"
    );
    expect(() => parseSyncDuePennsylvaniaCandidateFinanceScriptArgs(["--raw-cache-dir", "   "])).toThrow(
      "Missing --raw-cache-dir value"
    );
    expect(() =>
      parseSyncDuePennsylvaniaCandidateFinanceScriptArgs([
        "--raw-extracted-dir=/tmp/a",
        "--raw-extracted-dir=/tmp/b",
      ])
    ).toThrow("Provide --raw-extracted-dir at most once");
  });

  it("rejects digit-only values above Number.MAX_SAFE_INTEGER instead of rounding them", () => {
    expect(() => parseSyncDuePennsylvaniaCandidateFinanceScriptArgs(["--max-candidates=9007199254740993"])).toThrow(
      "Invalid --max-candidates value: 9007199254740993"
    );
  });

  it("formats script output", () => {
    const output = toSyncDuePennsylvaniaCandidateFinanceScriptOutput({
      startedAt: new Date("2026-01-02T03:04:05.000Z"),
      options: {
        dryRun: true,
        force: false,
        maxCandidates: 2,
      },
      result: {
        dryRun: true,
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
      type: "pennsylvania_candidate_finance_due_sync",
      started_at: "2026-01-02T03:04:05.000Z",
      dry_run: true,
      result: {
        dueCandidateCount: 3,
        selectedCandidateCount: 2,
      },
    });
    expect(typeof output.ts).toBe("string");
  });
});
