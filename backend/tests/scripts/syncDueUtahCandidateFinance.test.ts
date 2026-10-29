import { describe, expect, it } from "vitest";

import {
  parseSyncDueUtahCandidateFinanceScriptArgs,
  toSyncDueUtahCandidateFinanceScriptOutput,
} from "../../src/scripts/syncDueUtahCandidateFinance.js";

describe("syncDueUtahCandidateFinance script", () => {
  it("parses optional flags", () => {
    expect(
      parseSyncDueUtahCandidateFinanceScriptArgs([
        "--dry-run",
        "--force",
        "--max-candidates=12",
        "--stale-after-days",
        "3",
        "--lookback-days=10",
        "--lookahead-days=365",
        "--raw-cache-dir=/tmp/utah-disclosures",
        "--refresh-cache",
      ])
    ).toEqual({
      dryRun: true,
      force: true,
      maxCandidates: 12,
      staleAfterDays: 3,
      electionLookbackDays: 10,
      electionLookaheadDays: 365,
      rawCacheDir: "/tmp/utah-disclosures",
      refreshCache: true,
    });
  });

  it("defaults to a disabled-by-flag safe option set", () => {
    expect(parseSyncDueUtahCandidateFinanceScriptArgs([])).toMatchObject({
      dryRun: false,
      force: false,
      refreshCache: false,
    });
  });

  it("rejects malformed numeric flags strictly", () => {
    expect(() => parseSyncDueUtahCandidateFinanceScriptArgs(["--max-candidates=10abc"])).toThrow(
      "Invalid --max-candidates value"
    );
    expect(() => parseSyncDueUtahCandidateFinanceScriptArgs(["--stale-after-days=0"])).toThrow(
      "Invalid --stale-after-days value"
    );
    expect(() => parseSyncDueUtahCandidateFinanceScriptArgs(["--lookahead-days=5.5"])).toThrow(
      "Invalid --lookahead-days value"
    );
  });

  it("rejects missing or duplicate option values", () => {
    expect(() => parseSyncDueUtahCandidateFinanceScriptArgs(["--stale-after-days"])).toThrow(
      "Missing --stale-after-days value"
    );
    expect(() => parseSyncDueUtahCandidateFinanceScriptArgs(["--lookback-days", "--force"])).toThrow(
      "Missing --lookback-days value"
    );
    expect(() => parseSyncDueUtahCandidateFinanceScriptArgs(["--raw-cache-dir", "   "])).toThrow(
      "Missing --raw-cache-dir value"
    );
    expect(() =>
      parseSyncDueUtahCandidateFinanceScriptArgs(["--raw-cache-dir=/tmp/a", "--raw-cache-dir=/tmp/b"])
    ).toThrow("Provide --raw-cache-dir at most once");
  });

  it("rejects digit-only values above Number.MAX_SAFE_INTEGER instead of rounding them", () => {
    expect(() => parseSyncDueUtahCandidateFinanceScriptArgs(["--max-candidates=9007199254740993"])).toThrow(
      "Invalid --max-candidates value: 9007199254740993"
    );
  });

  it("formats script output", () => {
    const output = toSyncDueUtahCandidateFinanceScriptOutput({
      startedAt: new Date("2026-01-02T03:04:05.000Z"),
      options: {
        dryRun: true,
        force: false,
        maxCandidates: 2,
        refreshCache: false,
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
      type: "utah_candidate_finance_due_sync",
      started_at: "2026-01-02T03:04:05.000Z",
      dry_run: true,
      refresh_cache: false,
      result: {
        dueCandidateCount: 3,
        selectedCandidateCount: 2,
      },
    });
    expect(typeof output.ts).toBe("string");
  });
});

it("parses explicit independent component scope without weakening source filters", () => {
  expect(parseSyncDueUtahCandidateFinanceScriptArgs(["--committee-cash-only","--refresh-committee-cash","--candidate-id=11111111-1111-4111-8111-111111111111","--year=2026"]))
    .toMatchObject({committeeCashOnly:true,refreshCommitteeCash:true,candidateId:"11111111-1111-4111-8111-111111111111",electionYear:2026});
  expect(()=>parseSyncDueUtahCandidateFinanceScriptArgs(["--candidate-id=invalid"])).toThrow("Invalid --candidate-id");
  expect(()=>parseSyncDueUtahCandidateFinanceScriptArgs(["--year=9999"])).toThrow("Invalid --year");
});

it("parses independent IE controls and rejects incompatible component-only flags",()=>{
 expect(parseSyncDueUtahCandidateFinanceScriptArgs(["--ie-only","--refresh-ie","--ie-network","--year=2026"])).toMatchObject({ieOnly:true,refreshIe:true,ieNetwork:true,electionYear:2026});
 expect(()=>parseSyncDueUtahCandidateFinanceScriptArgs(["--ie-only","--committee-cash-only"])).toThrow("mutually exclusive");
});
