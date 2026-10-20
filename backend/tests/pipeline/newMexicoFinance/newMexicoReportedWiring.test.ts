import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ native: vi.fn(), annual: vi.fn() }));
vi.mock(
  "../../../src/pipeline/newMexicoFinance/newMexicoReportedBatchSync.js",
  () => ({ syncDueNewMexicoReportedFinance: mocks.native }),
);
vi.mock(
  "../../../src/pipeline/finance/standardStateFinanceDueListQuery.js",
  () => ({ createStandardStateFinanceDueListQuery: () => mocks.annual }),
);
import { syncDueNewMexicoCandidateFinance } from "../../../src/pipeline/newMexicoFinance/newMexicoCandidateFinanceBatchSync.js";
beforeEach(() => {
  vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "true");
  vi.stubEnv("NEW_MEXICO_CAMPAIGN_FINANCE_ENABLED", "true");
  vi.stubEnv("NEW_MEXICO_REPORTED_IE_ENABLED", "true");
  vi.stubEnv("NEW_MEXICO_REPORTED_COMMITTEE_ENABLED", "false");
  mocks.native.mockReset();
  mocks.annual.mockReset();
  mocks.native.mockResolvedValue({ writtenComponents: 1 });
  mocks.annual.mockResolvedValue({ totalDueRows: 0, rows: [] });
});
afterEach(() => vi.unstubAllEnvs());
describe("New Mexico ordinary batch integration", () => {
  const db = { query: vi.fn(), connect: vi.fn() };
  it("finishes native work even when annual direct selection subsequently fails", async () => {
    const order: string[] = [];
    mocks.native.mockImplementation(async () => {
      order.push("native_committed");
      return { writtenComponents: 1 };
    });
    mocks.annual.mockImplementation(async () => {
      order.push("annual_failed");
      throw Error("Synthetic annual failure");
    });
    await expect(
      syncDueNewMexicoCandidateFinance({
        db: db as never,
        autoLinkMissingLinks: false,
      }),
    ).rejects.toThrow("Synthetic annual failure");
    expect(order).toEqual(["native_committed", "annual_failed"]);
    expect(mocks.native).toHaveBeenCalledWith(
      expect.objectContaining({ electionLookbackDays: undefined }),
    );
  });
  it("continues ordinary annual work after a native source outage", async () => {
    mocks.native.mockRejectedValue(Error("Synthetic source outage"));
    const result = await syncDueNewMexicoCandidateFinance({
      db: db as never,
      autoLinkMissingLinks: false,
    });
    expect(mocks.annual).toHaveBeenCalledOnce();
    expect(result.syncedCandidateCount).toBe(0);
  });
  it("preserves the existing result shape with both native gates disabled", async () => {
    vi.stubEnv("NEW_MEXICO_REPORTED_IE_ENABLED", "false");
    const result = await syncDueNewMexicoCandidateFinance({
      db: db as never,
      autoLinkMissingLinks: false,
    });
    expect(mocks.native).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("reportedFinance");
  });
});
