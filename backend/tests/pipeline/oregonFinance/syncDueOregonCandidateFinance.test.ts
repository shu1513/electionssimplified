import { describe, expect, it } from "vitest";
import { parseSyncDueOregonCandidateFinanceScriptArgs } from "../../../src/scripts/syncDueOregonCandidateFinance.js";

describe("Oregon scoped post-deadline CLI", () => {
  it("distinguishes enabling sync from forcing a fresh due selection", () => {
    expect(parseSyncDueOregonCandidateFinanceScriptArgs(["--force"]).refresh).toBeUndefined();
    expect(parseSyncDueOregonCandidateFinanceScriptArgs([
      "--force", "--refresh", "--no-auto-link", "--candidate-id=AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      "--election-year", "2026", "--max-candidates=1",
      "--raw-cache-dir", "/tmp/oregon-public-cache",
    ])).toMatchObject({
      force: true, refresh: true, autoLinkMissingLinks: false,
      candidateId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", electionYear: 2026, maxCandidates: 1,
      rawCacheDir: "/tmp/oregon-public-cache",
    });
  });

  it.each([
    ["--candidate-id=invalid"], ["--candidate-id"], ["--election-year=1999"], ["--election-year=2101"],
    ["--election-year=2026.5"], ["--election-year=2026", "--election-year=2027"],
    ["--candidate-id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "--candidate-id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    ["--refresh=true"], ["--no-auto-link=false"], ["--refesh"],
    ["--raw-cache-dir"], ["--raw-cache-dir="], ["--raw-cache-dir=a", "--raw-cache-dir=b"],
  ])("rejects invalid, duplicated or mistyped scope: %j", (args) => {
    expect(() => parseSyncDueOregonCandidateFinanceScriptArgs(args)).toThrow();
  });
});
