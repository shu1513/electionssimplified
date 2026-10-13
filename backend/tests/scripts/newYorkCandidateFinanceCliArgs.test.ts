import { describe, expect, it } from "vitest";
import { parseSyncDueNewYorkCandidateFinanceScriptArgs } from "../../src/scripts/syncDueNewYorkCandidateFinance.js";

const candidateId = "11111111-1111-1111-1111-111111111111";
describe("New York finance targeted refresh CLI", () => {
  it("accepts explicit candidate/year scope and a fresh-source rerun", () => {
    expect(
      parseSyncDueNewYorkCandidateFinanceScriptArgs([
        `--candidate-id=${candidateId}`,
        "--year",
        "2026",
        "--refresh",
        "--dry-run",
      ]),
    ).toMatchObject({
      candidateId,
      electionYear: 2026,
      refresh: true,
      dryRun: true,
      force: false,
    });
  });
  it.each([
    ["--candidate-id", "invalid"],
    ["--candidate-id"],
    ["--candidate-id="],
    ["--candidate-id", candidateId, "--candidate-id", candidateId],
    ["--year=1999"],
    ["--year=2101"],
    ["--year=2026x"],
    ["--refresh=false"],
    ["--refesh"],
  ])("rejects malformed scope before any sync: %s", (...args) => {
    expect(() => parseSyncDueNewYorkCandidateFinanceScriptArgs(args)).toThrow();
  });
});
