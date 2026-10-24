import { describe, expect, it } from "vitest";

import {
  parseSyncDueWisconsinCandidateFinanceScriptArgs,
  toSyncDueWisconsinCandidateFinanceScriptOutput,
} from "../../src/scripts/syncDueWisconsinCandidateFinance.js";

describe("syncDueWisconsinCandidateFinance script", () => {
  it("parses optional flags", () => {
    expect(
      parseSyncDueWisconsinCandidateFinanceScriptArgs([
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

  it("defaults to a disabled-by-flag safe option set", () => {
    expect(parseSyncDueWisconsinCandidateFinanceScriptArgs([])).toMatchObject({
      dryRun: false,
      force: false,
    });
  });

  it("rejects malformed numeric flags strictly", () => {
    expect(() => parseSyncDueWisconsinCandidateFinanceScriptArgs(["--max-candidates=10abc"])).toThrow(
      "Invalid --max-candidates value"
    );
    expect(() => parseSyncDueWisconsinCandidateFinanceScriptArgs(["--stale-after-days=0"])).toThrow(
      "Invalid --stale-after-days value"
    );
    expect(() => parseSyncDueWisconsinCandidateFinanceScriptArgs(["--lookahead-days=5.5"])).toThrow(
      "Invalid --lookahead-days value"
    );
  });

  it("rejects missing and duplicate option values", () => {
    expect(() => parseSyncDueWisconsinCandidateFinanceScriptArgs(["--stale-after-days"])).toThrow(
      "Missing --stale-after-days value"
    );
    expect(() => parseSyncDueWisconsinCandidateFinanceScriptArgs(["--lookback-days", "--force"])).toThrow(
      "Missing --lookback-days value"
    );
    expect(() =>
      parseSyncDueWisconsinCandidateFinanceScriptArgs(["--max-candidates=10", "--max-candidates", "20"])
    ).toThrow("Provide --max-candidates at most once");
  });

  it("rejects digit-only values above Number.MAX_SAFE_INTEGER instead of rounding them", () => {
    expect(() => parseSyncDueWisconsinCandidateFinanceScriptArgs(["--max-candidates=9007199254740993"])).toThrow(
      "Invalid --max-candidates value: 9007199254740993"
    );
  });

  it("requires cash-only scope for candidate or year targeting", () => {
    expect(()=>parseSyncDueWisconsinCandidateFinanceScriptArgs(["--election-year=2026"])).toThrow("requires --committee-cash-only");
    expect(()=>parseSyncDueWisconsinCandidateFinanceScriptArgs(["--committee-cash-only","--candidate-id=bad"])).toThrow("UUID");
    expect(()=>parseSyncDueWisconsinCandidateFinanceScriptArgs(["--committee-cash-only","--election-year=2200"])).toThrow("range");
    expect(parseSyncDueWisconsinCandidateFinanceScriptArgs(["--committee-cash-only","--refresh-committee-cash","--refresh-cache","--election-year=2026","--raw-cache-dir=/private/cache"])).toMatchObject({committeeCashOnly:true,refreshCommitteeCash:true,refreshCache:true,electionYear:2026,rawDataCacheDir:"/private/cache"});
  });
  it("formats script output", () => {
    const output = toSyncDueWisconsinCandidateFinanceScriptOutput({
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
        autoLinkAttemptedCount: 2,
        autoLinkLinkedCount: 1,
        results: [
          {
            candidateId: "candidate-1",
            electionId: "election-1",
            electionYear: 2026,
            filerId: "FERG--101",
            committeeId: "12345",
            ok: true,
          },
        ],
      },
    });

    expect(output).toMatchObject({
      type: "wisconsin_candidate_finance_due_sync",
      started_at: "2026-01-02T03:04:05.000Z",
      dry_run: true,
      result: {
        dueCandidateCount: 3,
        selectedCandidateCount: 2,
        autoLinkAttemptedCount: 2,
        autoLinkLinkedCount: 1,
      },
    });
    expect(typeof output.ts).toBe("string");
  });
});
