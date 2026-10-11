import { describe, expect, it } from "vitest";

import {
  parseSyncDueMichiganCandidateFinanceScriptArgs,
  toSyncDueMichiganCandidateFinanceScriptOutput,
} from "../../src/scripts/syncDueMichiganCandidateFinance.js";

describe("syncDueMichiganCandidateFinance script", () => {
  it("parses optional flags", () => {
    expect(
      parseSyncDueMichiganCandidateFinanceScriptArgs([
        "--dry-run",
        "--force",
        "--max-candidates=12",
        "--stale-after-days",
        "3",
        "--lookback-days=10",
        "--lookahead-days=365",
      ])
    ).toEqual({
      dryRun: true,
      force: true,
      maxCandidates: 12,
      staleAfterDays: 3,
      electionLookbackDays: 10,
      electionLookaheadDays: 365,
    });
  });

  it("parses supplemental raw cache and refresh options", () => {
    expect(parseSyncDueMichiganCandidateFinanceScriptArgs([
      "--raw-cache-dir", "/local/mitn", "--refresh-supplemental-data",
    ])).toMatchObject({ rawDataCacheDir: "/local/mitn", refreshSupplementalData: true });
    expect(() => parseSyncDueMichiganCandidateFinanceScriptArgs(["--raw-cache-dir"])).toThrow(
      "Missing --raw-cache-dir value"
    );
  });

  it("defaults to normal sync without supplemental force refresh", () => {
    expect(parseSyncDueMichiganCandidateFinanceScriptArgs([])).toMatchObject({
      dryRun: false,
      force: false,
    });
  });

  it("rejects malformed numeric flags strictly", () => {
    expect(() => parseSyncDueMichiganCandidateFinanceScriptArgs(["--max-candidates=10abc"])).toThrow(
      "Invalid --max-candidates value"
    );
    expect(() => parseSyncDueMichiganCandidateFinanceScriptArgs(["--stale-after-days=0"])).toThrow(
      "Invalid --stale-after-days value"
    );
    expect(() => parseSyncDueMichiganCandidateFinanceScriptArgs(["--lookahead-days=5.5"])).toThrow(
      "Invalid --lookahead-days value"
    );
  });

  it("rejects digit-only values above Number.MAX_SAFE_INTEGER instead of rounding them", () => {
    expect(() => parseSyncDueMichiganCandidateFinanceScriptArgs(["--max-candidates=9007199254740993"])).toThrow(
      "Invalid --max-candidates value: 9007199254740993"
    );
  });

  it("rejects missing or duplicate option values", () => {
    expect(() => parseSyncDueMichiganCandidateFinanceScriptArgs(["--stale-after-days"])).toThrow(
      "Missing --stale-after-days value"
    );
    expect(() => parseSyncDueMichiganCandidateFinanceScriptArgs(["--lookback-days", "--force"])).toThrow(
      "Missing --lookback-days value"
    );
  });

  it("formats script output", () => {
    const output = toSyncDueMichiganCandidateFinanceScriptOutput({
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
      type: "michigan_candidate_finance_due_sync",
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
