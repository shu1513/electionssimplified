import { afterEach, describe, expect, it, vi } from "vitest";
const reported = vi.hoisted(() => vi.fn());
vi.mock(
  "../../../src/pipeline/kentuckyFinance/kentuckyReportedBatchSync.js",
  () => ({ syncDueKentuckyReportedFinance: reported }),
);
import { syncDueKentuckyCandidateFinance } from "../../../src/pipeline/kentuckyFinance/kentuckyCandidateFinanceBatchSync.js";
afterEach(() => vi.unstubAllEnvs());
describe("Kentucky ordinary job integration", () => {
  it("runs independent components even when every legacy summary is fresh", async () => {
    vi.stubEnv("KENTUCKY_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("KENTUCKY_REPORTED_IE_ENABLED", "true");
    const componentResult = { enabled: true, dryRun: true, selectedCount: 25 };
    reported.mockResolvedValue(componentResult);
    const db = { query: vi.fn(async () => ({ rows: [] })), connect: vi.fn() },
      legacy = vi.fn();
    const result = await syncDueKentuckyCandidateFinance({
      db: db as any,
      dryRun: true,
      autoLinkMissingLinks: false,
      syncKentuckyCandidateFinanceFn: legacy,
    });
    expect(reported).toHaveBeenCalledOnce();
    expect(result.reported).toBe(componentResult);
    expect(result.dueCandidateCount).toBe(0);
    expect(legacy).not.toHaveBeenCalled();
  });
});
