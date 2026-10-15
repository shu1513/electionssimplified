import { describe, expect, it } from "vitest";

import {
  parseSyncDueMarylandCandidateFinanceScriptArgs,
  toSyncDueMarylandCandidateFinanceScriptOutput,
} from "../../src/scripts/syncDueMarylandCandidateFinance.js";

describe("syncDueMarylandCandidateFinance script", () => {
  it("parses optional flags", () => {
    expect(
      parseSyncDueMarylandCandidateFinanceScriptArgs([
        "--dry-run",
        "--force",
        "--max-candidates=12",
        "--stale-after-days",
        "3",
        "--lookback-days=10",
        "--lookahead-days=365",
        "--raw-cache-dir=/tmp/maryland-cfs",
        "--committee-packets-file=/private/maryland/packets.json",
      ])
    ).toEqual({
      dryRun: true,
      force: true,
      maxCandidates: 12,
      staleAfterDays: 3,
      electionLookbackDays: 10,
      electionLookaheadDays: 365,
      rawCacheDir: "/tmp/maryland-cfs",
      committeePacketsFile:"/private/maryland/packets.json",
    });
  });

  it("defaults to AI industry classification enabled", () => {
    expect(parseSyncDueMarylandCandidateFinanceScriptArgs([])).toMatchObject({
      dryRun: false,
      force: false,
    });
  });

  it("rejects malformed numeric flags strictly", () => {
    expect(() => parseSyncDueMarylandCandidateFinanceScriptArgs(["--max-candidates=10abc"])).toThrow(
      "Invalid --max-candidates value"
    );
    expect(() => parseSyncDueMarylandCandidateFinanceScriptArgs(["--stale-after-days=0"])).toThrow(
      "Invalid --stale-after-days value"
    );
    expect(() => parseSyncDueMarylandCandidateFinanceScriptArgs(["--lookahead-days=5.5"])).toThrow(
      "Invalid --lookahead-days value"
    );
  });

  it("rejects missing or duplicate option values", () => {
    expect(() => parseSyncDueMarylandCandidateFinanceScriptArgs(["--stale-after-days"])).toThrow(
      "Missing --stale-after-days value"
    );
    expect(() => parseSyncDueMarylandCandidateFinanceScriptArgs(["--lookback-days", "--force"])).toThrow(
      "Missing --lookback-days value"
    );
    expect(() => parseSyncDueMarylandCandidateFinanceScriptArgs(["--raw-cache-dir", "   "])).toThrow(
      "Missing --raw-cache-dir value"
    );
    expect(() =>
      parseSyncDueMarylandCandidateFinanceScriptArgs(["--max-candidates=10", "--max-candidates", "20"])
    ).toThrow("Provide --max-candidates at most once");
    expect(() =>
      parseSyncDueMarylandCandidateFinanceScriptArgs(["--raw-cache-dir=/tmp/a", "--raw-cache-dir=/tmp/b"])
    ).toThrow("Provide --raw-cache-dir at most once");
    expect(()=>parseSyncDueMarylandCandidateFinanceScriptArgs(["--committee-packets-file"])).toThrow("Missing --committee-packets-file value");
    expect(()=>parseSyncDueMarylandCandidateFinanceScriptArgs(["--committee-packets-file=/private/a","--committee-packets-file=/private/b"])).toThrow("Provide --committee-packets-file at most once");
  });

  it("rejects unknown flags before starting a sync", () => {
    expect(() => parseSyncDueMarylandCandidateFinanceScriptArgs(["--max-canddates=1"])).toThrow(
      "Unknown Maryland candidate finance due sync flag: --max-canddates"
    );
    expect(() => parseSyncDueMarylandCandidateFinanceScriptArgs(["--unknown", "value"])).toThrow(
      "Unknown Maryland candidate finance due sync flag: --unknown"
    );
  });

  it("formats script output", () => {
    const output = toSyncDueMarylandCandidateFinanceScriptOutput({
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
        nativeOutsideObservation: { status: "preserve", diagnostics: ["finance_sync_disabled"] },
      },
    });

    expect(output).toMatchObject({
      type: "maryland_candidate_finance_due_sync",
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
