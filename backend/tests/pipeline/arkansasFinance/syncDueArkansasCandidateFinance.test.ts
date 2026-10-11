import { describe, expect, it } from "vitest";

import { parseSyncDueArkansasCandidateFinanceScriptArgs } from "../../../src/scripts/syncDueArkansasCandidateFinance.js";

describe("parseSyncDueArkansasCandidateFinanceScriptArgs", () => {
  it("parses the supported flags with unset numbers left to the batch defaults", () => {
    expect(parseSyncDueArkansasCandidateFinanceScriptArgs([])).toEqual({
      dryRun: false,
      force: false,
      refresh: false,
      candidateId: undefined,
      electionYear: undefined,
      rawCacheDir: undefined,
      dnsFallback: false,
      autoLinkMissingLinks: true,
      maxCandidates: undefined,
      staleAfterDays: undefined,
      electionLookbackDays: undefined,
      electionLookaheadDays: undefined,
    });
    expect(
      parseSyncDueArkansasCandidateFinanceScriptArgs([
        "--dry-run",
        "--force",
        "--dns-fallback",
        "--no-auto-link",
        "--max-candidates=3",
        "--stale-after-days",
        "1",
        "--lookback-days=40",
        "--lookahead-days=800",
      ])
    ).toEqual({
      dryRun: true,
      force: true,
      refresh: false,
      candidateId: undefined,
      electionYear: undefined,
      rawCacheDir: undefined,
      dnsFallback: true,
      autoLinkMissingLinks: false,
      maxCandidates: 3,
      staleAfterDays: 1,
      electionLookbackDays: 40,
      electionLookaheadDays: 800,
    });
  });

  it("keeps force separate from fresh source selection and parses safe candidate/year scope", () => {
    const candidateId = "11111111-1111-4111-8111-111111111111";
    expect(parseSyncDueArkansasCandidateFinanceScriptArgs([
      "--force", "--refresh", `--candidate-id=${candidateId}`, "--election-year=2026",
    ])).toMatchObject({ force: true, refresh: true, candidateId, electionYear: 2026, autoLinkMissingLinks: false });
    expect(parseSyncDueArkansasCandidateFinanceScriptArgs(["--force"])).toMatchObject({ force: true, refresh: false });
    for (const args of [["--candidate-id=wrong"], ["--election-year=2025"], ["--election-year=2101"],
      ["--candidate-id=11111111-1111-4111-8111-111111111111", "--candidate-id=11111111-1111-4111-8111-111111111111"]]) {
      expect(() => parseSyncDueArkansasCandidateFinanceScriptArgs(args)).toThrow();
    }
  });

  it("rejects unknown flags and bad numbers", () => {
    expect(() => parseSyncDueArkansasCandidateFinanceScriptArgs(["--cache-dir=x"])).toThrow(/cache-dir/);
    expect(() => parseSyncDueArkansasCandidateFinanceScriptArgs(["--max-candidates=0"])).toThrow(/--max-candidates/);
    expect(() => parseSyncDueArkansasCandidateFinanceScriptArgs(["--raw-cache-dir=relative"])).toThrow(/absolute/);
    expect(parseSyncDueArkansasCandidateFinanceScriptArgs(["--raw-cache-dir=/tmp/arkansas-source"])).toMatchObject({ rawCacheDir: "/tmp/arkansas-source" });
  });
});
