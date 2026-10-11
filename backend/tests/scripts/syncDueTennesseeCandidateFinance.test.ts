import { describe, expect, it } from "vitest";

import {
  parseSyncDueTennesseeCandidateFinanceScriptArgs,
  toSyncDueTennesseeCandidateFinanceScriptOutput,
} from "../../src/scripts/syncDueTennesseeCandidateFinance.js";

describe("syncDueTennesseeCandidateFinance script", () => {
  it("parses scoped source-proof and fresh cohort flags", () => {
    expect(parseSyncDueTennesseeCandidateFinanceScriptArgs(["--candidate-id=b13cdb24-792f-4f80-8231-64e83fe9118d",
      "--election-year=2026","--raw-cache-dir=/tmp/tn-proof","--no-auto-link"])).toMatchObject({
      candidateId:"b13cdb24-792f-4f80-8231-64e83fe9118d",electionYear:2026,rawCacheDir:"/tmp/tn-proof",autoLinkMissingLinks:false,
    });
    expect(()=>parseSyncDueTennesseeCandidateFinanceScriptArgs(["--candidate-id=invalid"])).toThrow("Invalid --candidate-id");
    expect(()=>parseSyncDueTennesseeCandidateFinanceScriptArgs(["--election-year=2101"])).toThrow("Invalid --election-year");
    expect(()=>parseSyncDueTennesseeCandidateFinanceScriptArgs(["--raw-cache-dir=relative"])).toThrow("must be absolute");
  });
  it("parses optional flags", () => {
    expect(
      parseSyncDueTennesseeCandidateFinanceScriptArgs([
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
    expect(parseSyncDueTennesseeCandidateFinanceScriptArgs([])).toMatchObject({
      dryRun: false,
      force: false,
    });
  });

  it("rejects malformed numeric flags strictly", () => {
    expect(() => parseSyncDueTennesseeCandidateFinanceScriptArgs(["--max-candidates=10abc"])).toThrow(
      "Invalid --max-candidates value"
    );
    expect(() => parseSyncDueTennesseeCandidateFinanceScriptArgs(["--stale-after-days=0"])).toThrow(
      "Invalid --stale-after-days value"
    );
    expect(() => parseSyncDueTennesseeCandidateFinanceScriptArgs(["--lookahead-days=5.5"])).toThrow(
      "Invalid --lookahead-days value"
    );
  });

  it("rejects missing and duplicate option values", () => {
    expect(() => parseSyncDueTennesseeCandidateFinanceScriptArgs(["--stale-after-days"])).toThrow(
      "Missing --stale-after-days value"
    );
    expect(() => parseSyncDueTennesseeCandidateFinanceScriptArgs(["--lookback-days", "--force"])).toThrow(
      "Missing --lookback-days value"
    );
    expect(() =>
      parseSyncDueTennesseeCandidateFinanceScriptArgs(["--max-candidates=10", "--max-candidates", "20"])
    ).toThrow("Provide --max-candidates at most once");
  });

  it("rejects unknown flags and positional arguments", () => {
    expect(() => parseSyncDueTennesseeCandidateFinanceScriptArgs(["--dryrun"])).toThrow("Unknown option: --dryrun");
    expect(() => parseSyncDueTennesseeCandidateFinanceScriptArgs(["candidate-1"])).toThrow(
      "Unexpected positional argument: candidate-1"
    );
  });

  it("formats script output", () => {
    const output = toSyncDueTennesseeCandidateFinanceScriptOutput({
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
            campCandidateId: "1234",
            ok: true,
          },
        ],
      },
    });

    expect(output).toMatchObject({
      type: "tennessee_candidate_finance_due_sync",
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
