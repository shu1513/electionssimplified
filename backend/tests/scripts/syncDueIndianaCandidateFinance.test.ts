import { describe, expect, it } from "vitest";

import {
  parseSyncDueIndianaCandidateFinanceScriptArgs,
  toSyncDueIndianaCandidateFinanceScriptOutput,
} from "../../src/scripts/syncDueIndianaCandidateFinance.js";

describe("syncDueIndianaCandidateFinance script", () => {
  it("parses due-sync flags", () => {
    expect(
      parseSyncDueIndianaCandidateFinanceScriptArgs([
        "--dry-run",
        "--force",
        "--max-candidates=10",
        "--stale-after-days",
        "3",
        "--lookback-days=2",
        "--lookahead-days",
        "30",
        "--raw-cache-dir=/tmp/in",
        "--raw-zip",
        "/tmp/in.zip",
      ])
    ).toEqual({
      dryRun: true,
      force: true,
      nativePacOnly: false,
      nativePacLinkId: undefined,
      maxCandidates: 10,
      staleAfterDays: 3,
      electionLookbackDays: 2,
      electionLookaheadDays: 30,
      rawCacheDir: "/tmp/in",
      rawZipPath: "/tmp/in.zip",
    });
  });

  it("uses safe defaults", () => {
    expect(parseSyncDueIndianaCandidateFinanceScriptArgs([])).toEqual({
      dryRun: false,
      force: false,
      nativePacOnly: false,
      nativePacLinkId: undefined,
      maxCandidates: undefined,
      staleAfterDays: undefined,
      electionLookbackDays: undefined,
      electionLookaheadDays: undefined,
      rawCacheDir: undefined,
      rawZipPath: undefined,
    });
  });

  it("accepts a scoped native component run", () => {
    expect(parseSyncDueIndianaCandidateFinanceScriptArgs([
      "--native-pac-only", "--native-pac-link-id=11111111-1111-4111-8111-111111111111",
    ])).toMatchObject({ nativePacOnly: true, nativePacLinkId: "11111111-1111-4111-8111-111111111111" });
  });

  it("rejects invalid repeated or missing flags", () => {
    expect(() => parseSyncDueIndianaCandidateFinanceScriptArgs(["--max-candidates=10abc"])).toThrow(
      "Invalid --max-candidates value"
    );
    expect(() => parseSyncDueIndianaCandidateFinanceScriptArgs(["--stale-after-days=0"])).toThrow(
      "Invalid --stale-after-days value"
    );
    expect(() => parseSyncDueIndianaCandidateFinanceScriptArgs(["--lookahead-days=5.5"])).toThrow(
      "Invalid --lookahead-days value"
    );
    expect(() => parseSyncDueIndianaCandidateFinanceScriptArgs(["--raw-cache-dir", "   "])).toThrow(
      "Missing --raw-cache-dir value"
    );
    expect(() =>
      parseSyncDueIndianaCandidateFinanceScriptArgs(["--max-candidates=10", "--max-candidates", "20"])
    ).toThrow("Provide --max-candidates at most once");
    expect(() => parseSyncDueIndianaCandidateFinanceScriptArgs(["--unknown"])).toThrow(
      "Unknown Indiana campaign finance flag: --unknown"
    );
    expect(() => parseSyncDueIndianaCandidateFinanceScriptArgs(["--dry-run=true"])).toThrow(
      "Flag --dry-run does not accept a value"
    );
    expect(() => parseSyncDueIndianaCandidateFinanceScriptArgs(["extra"])).toThrow(
      "Unexpected Indiana campaign finance argument: extra"
    );
  });

  it("rejects digit-only values above Number.MAX_SAFE_INTEGER instead of rounding them", () => {
    expect(() => parseSyncDueIndianaCandidateFinanceScriptArgs(["--max-candidates=9007199254740993"])).toThrow(
      "Invalid --max-candidates value: 9007199254740993"
    );
  });

  it("formats JSON output", () => {
    const output = toSyncDueIndianaCandidateFinanceScriptOutput({
      startedAt: new Date("2026-06-01T00:00:00.000Z"),
      options: parseSyncDueIndianaCandidateFinanceScriptArgs(["--dry-run"]),
      result: {
        dryRun: true,
        now: "2026-06-01T00:00:00.000Z",
        staleAfterDays: 7,
        maxCandidates: 25,
        dueCandidateCount: 1,
        selectedCandidateCount: 1,
        syncedCandidateCount: 1,
        failedCandidateCount: 0,
        results: [],
      },
    });

    expect(output).toMatchObject({
      type: "indiana_candidate_finance_due_sync",
      started_at: "2026-06-01T00:00:00.000Z",
      dry_run: true,
      result: {
        dueCandidateCount: 1,
      },
    });
  });
});
