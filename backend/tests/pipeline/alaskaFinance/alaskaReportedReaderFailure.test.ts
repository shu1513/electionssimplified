import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  legacy: new Map([
    [
      "synthetic",
      { source: "ALASKA_APOC", direct_campaign: { total_raised: 12345 } },
    ],
  ]),
  overlay: vi.fn(),
}));
vi.mock(
  "../../../src/pipeline/finance/standardStateFinanceBallotLookupLoader.js",
  () => ({
    loadStandardStateFinanceSummariesByCandidateElection: async () =>
      mocks.legacy,
  }),
);
vi.mock("../../../src/pipeline/alaskaFinance/alaskaReportedReader.js", () => ({
  overlayAlaskaReportedFinance: mocks.overlay,
}));
import { loadAlaskaCandidateFinanceSummariesByCandidateElection } from "../../../src/pipeline/alaskaFinance/alaskaCandidateFinanceBallotLookup.js";
describe("Alaska native reader availability", () => {
  it("retains valid legacy money when the native query fails", async () => {
    mocks.overlay.mockRejectedValueOnce(
      Error("synthetic native storage unavailable"),
    );
    const result = await loadAlaskaCandidateFinanceSummariesByCandidateElection(
      {} as never,
      [],
      [],
    );
    expect(result).toBe(mocks.legacy);
    expect(result.get("synthetic")?.direct_campaign.total_raised).toBe(12345);
  });
  it("returns the native overlay when its query succeeds", async () => {
    const native = new Map();
    mocks.overlay.mockResolvedValueOnce(native);
    expect(
      await loadAlaskaCandidateFinanceSummariesByCandidateElection(
        {} as never,
        [],
        [],
      ),
    ).toBe(native);
  });
});
