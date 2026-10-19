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
  it("records a component failure and still runs the legacy job", async () => {
    vi.stubEnv("KENTUCKY_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("KENTUCKY_REPORTED_IE_ENABLED", "true");
    reported.mockRejectedValue(new Error('relation "public.ky_reported_finance_components" does not exist'));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = { query: vi.fn(async () => ({ rows: [] })), connect: vi.fn() };
    const result = await syncDueKentuckyCandidateFinance({
      db: db as any,
      dryRun: true,
      autoLinkMissingLinks: false,
      syncKentuckyCandidateFinanceFn: vi.fn(),
    });
    error.mockRestore();
    expect(result.reported).toBeUndefined();
    expect(result.reportedError).toContain("ky_reported_finance_components");
    expect(result.dueCandidateCount).toBe(0);
    expect(db.query).toHaveBeenCalled();
  });
});
