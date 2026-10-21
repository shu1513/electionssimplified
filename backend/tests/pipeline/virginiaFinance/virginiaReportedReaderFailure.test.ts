import { afterEach, describe, expect, it, vi } from "vitest";
const overlay = vi.hoisted(() => vi.fn());
vi.mock(
  "../../../src/pipeline/virginiaFinance/virginiaReportedReader.js",
  () => ({ overlayVirginiaReportedFinance: overlay }),
);
import { loadVirginiaCandidateFinanceSummariesByCandidateElection as load } from "../../../src/pipeline/virginiaFinance/virginiaBallotLookupFinanceLoader.js";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe("Virginia native query failures", () => {
  it("preserves the legacy map when the native query fails", async () => {
    vi.stubEnv("VIRGINIA_CAMPAIGN_FINANCE_ENABLED", "true");
    let before: unknown;
    overlay.mockImplementationOnce(async (_db, summaries) => {
      before = summaries;
      throw Error("synthetic unavailable");
    });
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: "synthetic-person",
            election_id: "synthetic-election",
            committee_id: "synthetic-receiving",
            election_year: 2026,
            total_receipts: "12345",
            direct_contribution_total: "12345",
            source_url: "https://cfreports.elections.virginia.gov/",
            last_synced_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const r = await load(
      { query } as never,
      [{ candidate_id: "synthetic-person", election_id: "synthetic-election" }],
      [
        {
          election_id: "synthetic-election",
          state: "VA",
          office_scope: "state_lower",
          office_canonical_name: "State Lower Chamber Legislator",
        },
      ],
    );
    expect(r).toBe(before);
    expect(r.size).toBe(1);
    const preserved = [...r.values()][0]!;
    expect(preserved.direct_campaign.total_raised).toBe(12345);
    expect(preserved.last_synced_at).toBe("2026-01-01T00:00:00.000Z");
  });
  it("allows native-only cards and respects the state master", async () => {
    vi.stubEnv("VIRGINIA_CAMPAIGN_FINANCE_ENABLED", "true");
    const native = new Map();
    overlay.mockResolvedValueOnce(native);
    expect(await load({} as never, [], [])).toBe(native);
    vi.stubEnv("VIRGINIA_CAMPAIGN_FINANCE_ENABLED", "false");
    overlay.mockClear();
    expect((await load({} as never, [], [])).size).toBe(0);
    expect(overlay).not.toHaveBeenCalled();
  });
});
