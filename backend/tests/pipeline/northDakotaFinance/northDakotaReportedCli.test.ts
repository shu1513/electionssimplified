import { describe, expect, it } from "vitest";
import { parseNorthDakotaReportedArgs } from "../../../src/scripts/syncDueNorthDakotaReportedFinance.js";
describe("North Dakota independent CLI arguments", () => {
  it("defaults to the ordinary bounded job and accepts explicit source refresh", () => {
    expect(parseNorthDakotaReportedArgs([])).toEqual({ dryRun: false, refresh: false, cacheDir: undefined, maxCandidates: undefined });
    expect(parseNorthDakotaReportedArgs(["--dry-run", "--refresh", "--max-candidates=25", "--cache-dir", "/private/cache"])).toMatchObject({ dryRun: true, refresh: true, maxCandidates: 25, cacheDir: "/private/cache" });
  });
  it.each([["--max-candidates=0"], ["--max-candidates=1.5"], ["--max-candidates=1001"], ["--max-candidates=2", "--max-candidates=3"], ["--unknown"]])("rejects ambiguous or invalid input: %o", args => {
    expect(() => parseNorthDakotaReportedArgs(args)).toThrow();
  });
});
