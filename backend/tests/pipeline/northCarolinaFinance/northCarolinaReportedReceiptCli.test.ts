import { describe, expect, it } from "vitest";
import { parseSyncDueNorthCarolinaReportedReceiptsArgs as parse } from "../../../src/scripts/syncDueNorthCarolinaReportedReceipts.js";

describe("reported receipt CLI", () => {
  it("parses both value forms without source selection or a force bypass", () => {
    expect(parse(["--dry-run", "--refresh", "--cache-dir", "/private/cache", "--max-candidates=5", "--election-year", "2026", "--lookback-days=0", "--lookahead-days", "730", "--stale-after-days=7"]))
      .toEqual({ dryRun: true, refresh: true, cacheDir: "/private/cache", maxCandidates: 5, electionYear: 2026,
        electionLookbackDays: 0, electionLookaheadDays: 730, staleAfterDays: 7 });
  });
  it.each([
    ["--dryrun"], ["--dry-run=true"], ["--force"], ["--candidate-id=x"], ["--committee-id=x"], ["--now=x"], ["write"],
    ["--cache-dir"], ["--cache-dir="], ["--max-candidates=0"], ["--max-candidates=9007199254740993"],
    ["--election-year", "2026", "--election-year=2026"], ["--lookback-days=-1"], ["--lookahead-days=1.5"],
    ["--cache-dir=x", "--cache-dir=y"],
  ])("rejects unsafe or ambiguous options %j", (...args) => expect(() => parse(args)).toThrow());
});
