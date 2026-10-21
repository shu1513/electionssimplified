import { describe, expect, it } from "vitest";

import { parseSyncDueKansasCandidateFinanceScriptArgs } from "../../src/scripts/syncDueKansasCandidateFinance.js";

describe("parseSyncDueKansasCandidateFinanceScriptArgs", () => {
  it("parses the supported flags with unset numbers left to the batch defaults", () => {
    expect(parseSyncDueKansasCandidateFinanceScriptArgs([])).toEqual({
      dryRun: false,
      force: false,
      refresh: false,
      candidateId: undefined,
      electionYear: undefined,
      ieObservationFile: undefined,
      ieCacheDir: undefined,
      maxCandidates: undefined,
      staleAfterDays: undefined,
      electionLookbackDays: undefined,
      electionLookaheadDays: undefined,
    });
    expect(
      parseSyncDueKansasCandidateFinanceScriptArgs([
        "--dry-run",
        "--force",
        "--max-candidates=3",
        "--stale-after-days",
        "1",
        "--lookback-days=40",
        "--lookahead-days=800",
      ]),
    ).toEqual({
      dryRun: true,
      force: true,
      refresh: false,
      candidateId: undefined,
      electionYear: undefined,
      ieObservationFile: undefined,
      ieCacheDir: undefined,
      maxCandidates: 3,
      staleAfterDays: 1,
      electionLookbackDays: 40,
      electionLookaheadDays: 800,
    });
  });

  it("rejects unknown flags, positionals, and bad numbers", () => {
    expect(() =>
      parseSyncDueKansasCandidateFinanceScriptArgs(["--aggregate"]),
    ).toThrow("Unknown Kansas candidate finance due sync flag");
    expect(() =>
      parseSyncDueKansasCandidateFinanceScriptArgs(["dry-run"]),
    ).toThrow("Unexpected positional argument");
    expect(() =>
      parseSyncDueKansasCandidateFinanceScriptArgs(["--max-candidates=0"]),
    ).toThrow("Invalid --max-candidates value");
    // The flag guard runs first, so a value flag with no value never reaches readValueFlag.
    expect(() =>
      parseSyncDueKansasCandidateFinanceScriptArgs([
        "--dry-run",
        "--max-candidates",
      ]),
    ).toThrow("Missing --max-candidates value");
    expect(() =>
      parseSyncDueKansasCandidateFinanceScriptArgs(["--max-candidates="]),
    ).toThrow("Missing --max-candidates value");
    expect(() =>
      parseSyncDueKansasCandidateFinanceScriptArgs([
        "--max-candidates=1",
        "--max-candidates=2",
      ]),
    ).toThrow("at most once");
  });

  it("takes --stale-after-days 0 as a deliberate full resync", () => {
    expect(
      parseSyncDueKansasCandidateFinanceScriptArgs(["--stale-after-days=0"])
        .staleAfterDays,
    ).toBe(0);
    expect(() =>
      parseSyncDueKansasCandidateFinanceScriptArgs(["--stale-after-days=-1"]),
    ).toThrow("Invalid --stale-after-days value");
    expect(() =>
      parseSyncDueKansasCandidateFinanceScriptArgs(["--lookback-days=0"]),
    ).toThrow("Invalid --lookback-days value: 0");
  });
  it("validates refresh and candidate/year scope independently of the flag override", () => {
    expect(
      parseSyncDueKansasCandidateFinanceScriptArgs([
        "--refresh",
        "--candidate-id=1c513426-c0ab-4fea-a3ae-d43e6302aec1",
        "--election-year=2026",
      ]),
    ).toMatchObject({
      refresh: true,
      force: false,
      candidateId: "1c513426-c0ab-4fea-a3ae-d43e6302aec1",
      electionYear: 2026,
    });
    expect(() =>
      parseSyncDueKansasCandidateFinanceScriptArgs(["--candidate-id=invalid"]),
    ).toThrow("UUID");
    expect(() =>
      parseSyncDueKansasCandidateFinanceScriptArgs(["--election-year=3000"]),
    ).toThrow("year");
  });
  it("accepts the saved browser observation and restricted cache directory inline", () => {
    expect(
      parseSyncDueKansasCandidateFinanceScriptArgs([
        "--ie-observation-file=/saved/source.json",
        "--ie-cache-dir=/local/cache",
      ]),
    ).toMatchObject({
      ieObservationFile: "/saved/source.json",
      ieCacheDir: "/local/cache",
    });
  });
});

it("accepts a private committee-only source path without changing force semantics", () => {
  expect(
    parseSyncDueKansasCandidateFinanceScriptArgs([
      "--committee-only",
      "--committee-observation-dir",
      "/private/synthetic",
      "--force",
    ]),
  ).toMatchObject({
    committeeOnly: true,
    committeeObservationDir: "/private/synthetic",
    force: true,
  });
});
