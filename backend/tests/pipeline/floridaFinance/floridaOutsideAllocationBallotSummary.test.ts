import { afterEach, describe, expect, it, vi } from "vitest";
import { loadFloridaOutsideAllocationCards } from "../../../src/pipeline/floridaFinance/floridaOutsideAllocationBallotSummary.js";
import { loadFloridaCandidateFinanceSummariesByCandidateElection } from "../../../src/pipeline/floridaFinance/floridaFinanceBallotSummary.js";
const request = { candidate_id: "candidate", election_id: "election" };
const row = { ...request, payer_account: "90001", payer_name: "Example Committee", support_amount: "525.00", source_url: "https://dos.elections.myflorida.com/committees/ComDetail.asp?account=90001", last_synced_at: "2026-10-11T22:00:00Z" };
afterEach(() => vi.unstubAllEnvs());
describe("Florida explicit outside allocation cards", () => {
  it.each([false, true])("ordinary reader adds explicit groups only when legacy totals remain unknown (legacy=%s)", async legacy => {
    vi.stubEnv("FLORIDA_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi.fn().mockImplementation(async (sql: string) => ({ rows:
      sql.includes("public.fl_candidate_finance_summaries") ? [{ ...request, committee_id: "LOCAL_EXAMPLE", election_year: 2026,
        total_receipts: "1000.00", direct_contribution_total: "1000.00", total_disbursements: null, cash_on_hand: null,
        outside_support_total: legacy ? "900.00" : null, outside_oppose_total: null, source_url: null, last_synced_at: row.last_synced_at }]
      : sql.includes("public.fl_candidate_finance_ie_sources") ? [row] : [] }));
    const cards = await loadFloridaCandidateFinanceSummariesByCandidateElection({ query }, [request], [{ election_id: request.election_id, state: "FL" }]);
    const outside = cards.get("candidate\u0000election")?.outside_spending;
    expect(outside?.support_total).toBe(legacy ? 900 : null);
    expect(outside?.oppose_total).toBeNull();
    expect(outside?.top_supporting_groups).toHaveLength(legacy ? 0 : 1);
    if (legacy) expect(outside?.outside_coverage_note).toBeUndefined();
    else expect(outside?.outside_coverage_note).toContain("incomplete");
    expect(cards.get("candidate\u0000election")?.direct_campaign?.total_raised).toBe(1000);
  });
  it("returns named explicit groups and a partial-coverage note, without headline total fields", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    const cards = await loadFloridaOutsideAllocationCards({ query }, [request]);
    const card = cards.get("candidate\u0000election");
    expect(card?.groups).toEqual([{ committee_id: "90001", committee_name: row.payer_name, support_oppose: "support", amount: 525, source_url: row.source_url }]);
    expect(card?.coverageNote).toContain("totals are unavailable");
    expect(card).not.toHaveProperty("support_total");
    expect(query.mock.calls[0][0]).toContain("source.candidate_election_id = candidate_election.id");
    expect(query.mock.calls[0][0]).toContain("link.link_status = 'active'");
  });
  it("keeps a checked empty payer component separate from candidate-wide zero", async () => {
    const cards = await loadFloridaOutsideAllocationCards({ query: vi.fn().mockResolvedValue({ rows: [{ ...row, support_amount: "0.00" }] }) }, [request]);
    expect(cards.get("candidate\u0000election")?.groups).toEqual([]);
    expect(cards.get("candidate\u0000election")?.coverageNote).toContain("incomplete");
  });
  it("caps displayed groups while retaining checked-component coverage", async () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({ ...row, payer_account: String(90001 + index) }));
    const cards = await loadFloridaOutsideAllocationCards({ query: vi.fn().mockResolvedValue({ rows }) }, [request]);
    expect(cards.get("candidate\u0000election")?.groups).toHaveLength(5);
  });
  it("unknown source supplies no card; empty request supplies no query", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    expect((await loadFloridaOutsideAllocationCards({ query }, [request])).size).toBe(0);
    query.mockClear(); expect((await loadFloridaOutsideAllocationCards({ query }, [])).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});
