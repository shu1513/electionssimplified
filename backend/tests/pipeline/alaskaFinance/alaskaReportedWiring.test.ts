import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ native: vi.fn() }));
vi.mock(
  "../../../src/pipeline/alaskaFinance/alaskaReportedBatchSync.js",
  () => ({ syncDueAlaskaReportedFinance: mocks.native }),
);
import { syncDueAlaskaCandidateFinance } from "../../../src/pipeline/alaskaFinance/alaskaCandidateFinanceBatchSync.js";
beforeEach(() => mocks.native.mockReset());
describe("Alaska native acquisition before direct finance", () => {
  it("retains completed native work when the lazy direct source fails", async () => {
    const order: string[] = [],
      reported = { enabled: true, writtenComponents: 1 };
    mocks.native.mockImplementation(async () => {
      order.push("native");
      return reported;
    });
    const result = await syncDueAlaskaCandidateFinance({
      db: {} as never,
      loadApocData: async () => {
        order.push("direct");
        throw Error("synthetic unavailable direct source");
      },
    });
    expect(order).toEqual(["native", "direct"]);
    expect(result).toMatchObject({
      reported,
      legacySourceUnavailable: true,
      syncedCandidateCount: 0,
    });
  });
  it("preserves the legacy failure when native components are disabled or failed", async () => {
    for (const reported of [
      { enabled: false },
      { enabled: true, failure: "synthetic due query timeout" },
    ]) {
      mocks.native.mockResolvedValue(reported);
      await expect(
        syncDueAlaskaCandidateFinance({
          db: {} as never,
          loadApocData: async () => {
            throw Error("synthetic unavailable direct source");
          },
        }),
      ).rejects.toThrow("synthetic unavailable direct source");
    }
  });
  it("runs the legacy sync after a failed native due query", async () => {
    mocks.native.mockResolvedValue({ enabled: true, failure: "synthetic due query timeout" });
    const result = await syncDueAlaskaCandidateFinance({
      db: { query: async () => ({ rows: [] }) } as never,
      loadApocData: async () => ({
        incomeRows: [],
        independentExpenditureRows: [],
        independentContributionRows: [],
      }) as never,
    });
    expect(result).toMatchObject({
      reported: { failure: "synthetic due query timeout" },
      dueCandidateCount: 0,
    });
    expect(result.legacySourceUnavailable).toBeUndefined();
  });
});
