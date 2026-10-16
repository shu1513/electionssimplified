import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ ie: vi.fn(), contributions: vi.fn(), factory: vi.fn() }));
vi.mock("../../../src/pipeline/georgiaFinance/georgiaReportedFinanceSourceCache.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../../src/pipeline/georgiaFinance/georgiaReportedFinanceSourceCache.js")>(),
  createGeorgiaReportedFinanceSourceProducer: calls.factory,
}));
import { GeorgiaReportedFinanceSourceCacheError } from "../../../src/pipeline/georgiaFinance/georgiaReportedFinanceSourceCache.js";
import { parseRefreshGeorgiaReportedFinanceSourcesArgs, refreshGeorgiaReportedFinanceSources }
  from "../../../src/scripts/refreshGeorgiaReportedFinanceSources.js";
const options = { cacheDir: "/private/test-cache", filingYear: 2026, electionYear: 2026, force: false };
const facts = { sourceRetrievedAt: "2026-10-15T00:00:00.000Z", sourceCompletedAt: "2026-10-15T00:01:00.000Z",
  sourceRowCount: 2, sourceByteSize: 1000, sourceControls: [{}] };
beforeEach(() => {
  calls.factory.mockReturnValue({ refreshIe: calls.ie, refreshContributions: calls.contributions });
  calls.ie.mockResolvedValue(facts); calls.contributions.mockResolvedValue(facts);
  vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "true"); vi.stubEnv("GEORGIA_CAMPAIGN_FINANCE_ENABLED", "true");
  vi.stubEnv("GEORGIA_ETHICS_RAW_DATA_REFRESH_ENABLED", "true");
  vi.stubEnv("GEORGIA_REPORTED_IE_ENABLED", "false"); vi.stubEnv("GEORGIA_REPORTED_COMMITTEE_CONTRIBUTIONS_ENABLED", "false");
});
afterEach(() => vi.unstubAllEnvs());
describe("Georgia ordinary reported source refresh", () => {
  it("returns before source access when both publication gates are off, including force", async () => {
    expect(await refreshGeorgiaReportedFinanceSources({ ...options, force: true })).toMatchObject({ enabled: false });
    expect(calls.factory).not.toHaveBeenCalled();
  });
  it("requires raw refresh authorization separately", async () => {
    vi.stubEnv("GEORGIA_REPORTED_IE_ENABLED", "true"); vi.stubEnv("GEORGIA_ETHICS_RAW_DATA_REFRESH_ENABLED", "false");
    expect(await refreshGeorgiaReportedFinanceSources(options)).toMatchObject({ enabled: false });
    expect(calls.factory).not.toHaveBeenCalled();
  });
  it("acquires only the enabled source and retains its observation clock", async () => {
    vi.stubEnv("GEORGIA_REPORTED_IE_ENABLED", "true");
    expect(await refreshGeorgiaReportedFinanceSources(options)).toMatchObject({ enabled: true,
      results: [{ component: "ie", status: "refreshed", sourceRetrievedAt: facts.sourceRetrievedAt },
        { component: "contributions", status: "disabled" }] });
    expect(calls.ie).toHaveBeenCalledWith({ filingYear: 2026, electionYear: 2026 });
    expect(calls.contributions).not.toHaveBeenCalled();
  });
  it("continues independent acquisition after an expected source failure", async () => {
    vi.stubEnv("GEORGIA_REPORTED_IE_ENABLED", "true"); vi.stubEnv("GEORGIA_REPORTED_COMMITTEE_CONTRIBUTIONS_ENABLED", "true");
    calls.ie.mockRejectedValue(new GeorgiaReportedFinanceSourceCacheError());
    expect(await refreshGeorgiaReportedFinanceSources(options)).toMatchObject({ enabled: true,
      results: [{ component: "ie", status: "unavailable" }, { component: "contributions", status: "refreshed" }] });
    expect(calls.contributions).toHaveBeenCalledTimes(1);
  });
  it("does not conceal programming errors or accept candidate-selection flags", async () => {
    vi.stubEnv("GEORGIA_REPORTED_IE_ENABLED", "true"); calls.ie.mockRejectedValue(new TypeError("bug"));
    await expect(refreshGeorgiaReportedFinanceSources(options)).rejects.toThrow("bug");
    expect(() => parseRefreshGeorgiaReportedFinanceSourcesArgs(["--candidate-id", "known-positive"])).toThrow();
  });
});
