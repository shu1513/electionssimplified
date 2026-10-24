import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadWestVirginiaCandidateFinanceSummariesByCandidateElection } from "../../../src/pipeline/westVirginiaFinance/westVirginiaBallotLookupFinanceLoader.js";
const candidateId = "11111111-1111-4111-8111-111111111111", electionId = "22222222-2222-4222-8222-222222222222";
const candidates = [{ candidate_id: candidateId, election_id: electionId }];
const elections = [{ election_id: electionId, state: "WV", office_scope: "state_lower", office_canonical_name: "State Lower Chamber Legislator" }];
function donor(overrides: Record<string, unknown> = {}) {
  return { candidate_id: candidateId, election_id: electionId, committee_id: "1020001470", committee_name: "Unsorted WV Committee",
    committee_type: "102", amount: "5600", source_url: null, industry_slug: null, classification_source: null, confidence: null, ...overrides };
}
function dbFor(rows: unknown[], summaries = true) {
  return { query: vi.fn(async (sql: string) => {
    if (sql.includes("wv_candidate_finance_pac_donors")) return { rows };
    if (sql.includes("wv_candidate_finance_summaries")) return { rows: summaries ? [{
      candidate_id: candidateId, election_id: electionId, committee_id: null, election_year: 2026,
      direct_contribution_total: "5850", total_receipts: "10850", total_disbursements: "400",
      cash_on_hand: null, outside_support_total: null, outside_oppose_total: null, last_synced_at: "2026-10-11",
    }] : [] };
    return { rows: [] };
  }) };
}
describe("WV committee donor reader", () => {
  beforeEach(() => vi.stubEnv("WEST_VIRGINIA_CAMPAIGN_FINANCE_ENABLED", "true"));
  afterEach(() => vi.unstubAllEnvs());
  it("renders unknown typed gifts while keeping Raised and unavailable outside separate", async () => {
    const db = dbFor([donor(), donor({ committee_id: "1020001446", amount: 250 })]);
    const result = [...(await loadWestVirginiaCandidateFinanceSummariesByCandidateElection(db, candidates, elections)).values()][0]!;
    expect(result.direct_campaign.total_raised).toBe(5850);
    expect(result.outside_spending.support_total).toBeNull();
    expect(result.direct_campaign.pac_money_by_interest![0]).toMatchObject({ interest: "unclassified", interest_name: "Not yet sorted", amount: 5850, pac_count: 2 });
    const sql = db.query.mock.calls.find(([s]) => s.includes("wv_candidate_finance_pac_donors"))![0];
    expect(sql).toContain("sum(donor.amount) AS amount");
    expect(sql).toContain("link.link_status = 'active'");
    expect(sql).toContain("donor.election_year = link.election_year");
    expect(sql).toContain("GROUP BY selected.candidate_id, selected.election_id, donor.committee_id");
    expect(result.direct_campaign.direct_coverage_note).toContain("unique registry match");
    expect(result.outside_spending.outside_coverage_note).toContain("filers without a registered committee is not covered");
  });
  it("hides trusted candidate/leadership classifications but retains low-confidence unknowns and party donors", async () => {
    const result = [...(await loadWestVirginiaCandidateFinanceSummariesByCandidateElection(dbFor([
      donor({ industry_slug: "leadership_pacs", classification_source: "manual", confidence: "low" }),
      donor({ committee_id: "1020002222", industry_slug: "candidate_committees", classification_source: "ai", confidence: "high" }),
      donor({ committee_id: "1020003333", amount: 750, industry_slug: "candidate_committees", classification_source: "rule", confidence: "low" }),
      donor({ committee_id: "1030002641", committee_type: "103", committee_name: "WV Party Committee", amount: 300,
        industry_slug: "republican_party_groups", classification_source: "manual", confidence: "high" }),
    ]), candidates, elections)).values()][0]!;
    expect(result.direct_campaign.pac_money_by_interest).toMatchObject([
      { interest: "unclassified", amount: 750, pac_count: 1 },
      { interest: "republican_party_groups", amount: 300, pac_count: 1 },
    ]);
  });
  it("caps details after full totals and excludes invalid source types defensively", async () => {
    const rows = Array.from({ length: 7 }, (_, i) => donor({ committee_id: String(1020001000 + i), amount: 100 + i }));
    rows.push(donor({ committee_type: "101", amount: 100000 }), donor({ committee_type: "104", amount: 100000 }), donor({ amount: -100000 }));
    const result = [...(await loadWestVirginiaCandidateFinanceSummariesByCandidateElection(dbFor(rows), candidates, elections)).values()][0]!;
    const interest = result.direct_campaign.pac_money_by_interest![0]!;
    expect(interest).toMatchObject({ amount: 721, pac_count: 7 });
    expect(interest.pacs.map(p => p.amount)).toEqual([106, 105, 104, 103, 102]);
  });
  it("skips donor query when disabled or no finance summary exists", async () => {
    const db = dbFor([], false);
    expect((await loadWestVirginiaCandidateFinanceSummariesByCandidateElection(db, candidates, elections)).size).toBe(0);
    expect(db.query).toHaveBeenCalledOnce();
    vi.stubEnv("WEST_VIRGINIA_CAMPAIGN_FINANCE_ENABLED", "false");
    expect((await loadWestVirginiaCandidateFinanceSummariesByCandidateElection(db, candidates, elections)).size).toBe(0);
    expect(db.query).toHaveBeenCalledOnce();
  });
});
