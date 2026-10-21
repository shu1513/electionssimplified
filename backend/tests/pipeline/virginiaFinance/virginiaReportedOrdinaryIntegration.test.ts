import { describe, expect, it, vi } from "vitest";
const reported = vi.hoisted(() => vi.fn());
vi.mock(
  "../../../src/pipeline/virginiaFinance/virginiaReportedBatchSync.js",
  () => ({ syncDueVirginiaReportedFinance: reported }),
);
import { syncDueVirginiaCandidateFinance } from "../../../src/pipeline/virginiaFinance/virginiaCandidateFinanceBatchSync.js";
describe("Virginia ordinary job integration", () => {
  it("records a native component failure and still runs the legacy job", async () => {
    reported.mockRejectedValue(
      new Error('relation "public.va_reported_finance_components" does not exist'),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = { query: vi.fn(async () => ({ rows: [] })), connect: vi.fn() };
    const result = await syncDueVirginiaCandidateFinance({
      db: db as never,
      dryRun: true,
      autoLinkMissingLinks: false,
      syncVirginiaCandidateFinanceFn: vi.fn(),
    });
    error.mockRestore();
    expect(reported).toHaveBeenCalledOnce();
    expect(result.reported).toBeUndefined();
    expect(result.reportedError).toContain("va_reported_finance_components");
    expect(result.dueCandidateCount).toBe(0);
    expect(db.query).toHaveBeenCalled();
  });
});
