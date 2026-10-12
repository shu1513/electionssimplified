import { describe, expect, it } from "vitest";

import {
  parseSyncDueMaineCandidateFinanceScriptArgs,
  toSyncDueMaineCandidateFinanceScriptOutput,
} from "../../src/scripts/syncDueMaineCandidateFinance.js";

describe("syncDueMaineCandidateFinance script", () => {
  it("parses optional flags", () => {
    expect(
      parseSyncDueMaineCandidateFinanceScriptArgs([
        "--dry-run",
        "--force",
        "--max-candidates=12",
        "--stale-after-days",
        "3",
        "--lookback-days=10",
        "--lookahead-days=365",
        "--raw-cache-dir=/tmp/maine-cfis",
      ]),
    ).toEqual({
      dryRun: true,
      force: true,
      maxCandidates: 12,
      staleAfterDays: 3,
      electionLookbackDays: 10,
      electionLookaheadDays: 365,
      rawCacheDir: "/tmp/maine-cfis",
    });
  });

  it("defaults to AI industry classification enabled", () => {
    expect(parseSyncDueMaineCandidateFinanceScriptArgs([])).toMatchObject({
      dryRun: false,
      force: false,
    });
  });

  it("rejects malformed numeric flags strictly", () => {
    expect(() =>
      parseSyncDueMaineCandidateFinanceScriptArgs(["--max-candidates=10abc"]),
    ).toThrow("Invalid --max-candidates value");
    expect(() =>
      parseSyncDueMaineCandidateFinanceScriptArgs(["--stale-after-days=0"]),
    ).toThrow("Invalid --stale-after-days value");
    expect(() =>
      parseSyncDueMaineCandidateFinanceScriptArgs(["--lookahead-days=5.5"]),
    ).toThrow("Invalid --lookahead-days value");
  });

  it("rejects missing or duplicate option values", () => {
    expect(() =>
      parseSyncDueMaineCandidateFinanceScriptArgs(["--stale-after-days"]),
    ).toThrow("Missing --stale-after-days value");
    expect(() =>
      parseSyncDueMaineCandidateFinanceScriptArgs([
        "--lookback-days",
        "--force",
      ]),
    ).toThrow("Missing --lookback-days value");
    expect(() =>
      parseSyncDueMaineCandidateFinanceScriptArgs(["--raw-cache-dir", "   "]),
    ).toThrow("Missing --raw-cache-dir value");
    expect(() =>
      parseSyncDueMaineCandidateFinanceScriptArgs([
        "--max-candidates=10",
        "--max-candidates",
        "20",
      ]),
    ).toThrow("Provide --max-candidates at most once");
    expect(() =>
      parseSyncDueMaineCandidateFinanceScriptArgs([
        "--raw-cache-dir=/tmp/a",
        "--raw-cache-dir=/tmp/b",
      ]),
    ).toThrow("Provide --raw-cache-dir at most once");
  });

  it("rejects unknown flags before starting a sync", () => {
    expect(() =>
      parseSyncDueMaineCandidateFinanceScriptArgs(["--max-canddates=1"]),
    ).toThrow("Unknown Maine candidate finance due sync flag: --max-canddates");
    expect(() =>
      parseSyncDueMaineCandidateFinanceScriptArgs(["--unknown", "value"]),
    ).toThrow("Unknown Maine candidate finance due sync flag: --unknown");
  });
  it("separates source refresh and explicit candidate/year scope from force", () => {
    const sourceUrl = `https://www.mainecampaignfinancedisclosure.com/public/filers/f_${"a".repeat(26)}/filings/d_${"b".repeat(26)}`;
    expect(
      parseSyncDueMaineCandidateFinanceScriptArgs([
        "--refresh",
        "--year=2026",
        "--candidate-id=11111111-1111-1111-1111-111111111111",
        `--report-urls=${sourceUrl}`,
      ]),
    ).toMatchObject({
      force: false,
      refresh: true,
      electionYear: 2026,
      candidateId: "11111111-1111-1111-1111-111111111111",
      mapLightReportUrls: [sourceUrl],
    });
    expect(
      parseSyncDueMaineCandidateFinanceScriptArgs(["--force"]),
    ).not.toHaveProperty("refresh");
    expect(
      parseSyncDueMaineCandidateFinanceScriptArgs(["--resync"]),
    ).toMatchObject({ resync: true, force: false });
    expect(
      parseSyncDueMaineCandidateFinanceScriptArgs(["--resync"]),
    ).not.toHaveProperty("refresh");
  });
  it.each([
    ["--candidate-id=bad"],
    ["--year=9999"],
    ["--report-urls=https://evil.example/"],
    [
      "--report-urls=https://www.mainecampaignfinancedisclosure.com/public/filers/f_aaaaaaaaaaaaaaaaaaaaaaaaaa/filings/d_bbbbbbbbbbbbbbbbbbbbbbbbbb?secret=opaque",
    ],
    [
      "--legacy",
      "--report-urls=https://www.mainecampaignfinancedisclosure.com/public/filers/f_aaaaaaaaaaaaaaaaaaaaaaaaaa/filings/d_bbbbbbbbbbbbbbbbbbbbbbbbbb",
    ],
  ])("rejects invalid modern scope %s", (flags) => {
    expect(() => parseSyncDueMaineCandidateFinanceScriptArgs(flags)).toThrow();
  });

  it("formats script output", () => {
    const output = toSyncDueMaineCandidateFinanceScriptOutput({
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
      type: "maine_candidate_finance_due_sync",
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
