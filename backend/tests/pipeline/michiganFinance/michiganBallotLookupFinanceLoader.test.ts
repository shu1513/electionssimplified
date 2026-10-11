import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { candidateElectionKey } from "../../../src/pipeline/address/ballotLookupFinanceShared.js";
import { loadMichiganCandidateFinanceSummariesByCandidateElection } from "../../../src/pipeline/michiganFinance/michiganBallotLookupFinanceLoader.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const KEY = candidateElectionKey(CANDIDATE_ID, ELECTION_ID);
const SOURCE_URL = "https://example.test/official-michigan-report";
const candidates = [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID }];
const elections = [{ election_id: ELECTION_ID, state: "MI", office_scope: "statewide", office_canonical_name: "Governor" }];
const summaryRow = {
  candidate_id: CANDIDATE_ID, election_id: ELECTION_ID, committee_id: null, election_year: 2026,
  total_receipts: "1000.00", direct_contribution_total: "900.00", candidate_loan_total: null,
  total_disbursements: null, cash_on_hand: null, outside_support_total: null, outside_oppose_total: null,
  source_url: SOURCE_URL, last_synced_at: "2026-10-01T00:00:00Z",
};
function donor(change: Record<string, unknown> = {}) {
  return { candidate_id: CANDIDATE_ID, election_id: ELECTION_ID, committee_id: "pac-1",
    committee_name: "Unsorted Michigan PAC", committee_type: "Independent", amount: "150.25", source_url: null,
    industry_slug: null, classification_source: null, confidence: null, ...change };
}
function mockDb(pacRows: unknown[] = [], summaries: unknown[] = [summaryRow]) {
  return { query: vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes("public.mi_candidate_finance_pac_donors")) return { rows: pacRows };
    if (sql.includes("public.mi_candidate_finance_summaries")) return { rows: summaries };
    return { rows: [] };
  }) };
}

describe("michiganBallotLookupFinanceLoader PAC donors", () => {
  beforeEach(() => { vi.stubEnv("MICHIGAN_CAMPAIGN_FINANCE_ENABLED", "true"); vi.stubEnv("AI_API_CALLS_ALLOWED", "false"); });
  afterEach(() => vi.unstubAllEnvs());

  it("sums a donor across active links/year and retains unknown interests", async () => {
    // This row is the grouped result of receipts to two receiving links.
    const db = mockDb([donor({ amount: "350.25" }), donor({ committee_id: "pac-2", amount: "100.00" })]);
    const result = await loadMichiganCandidateFinanceSummariesByCandidateElection(db, candidates, elections);
    const pacCall = db.query.mock.calls.find(([sql]) => sql.includes("public.mi_candidate_finance_pac_donors"));
    expect(pacCall?.[1]).toEqual([JSON.stringify(candidates)]);
    const sql = pacCall![0];
    expect(sql).toContain("sum(donor.amount) AS amount");
    expect(sql).toContain("link.link_status = 'active'");
    expect(sql).toContain("donor.election_year = link.election_year");
    expect(sql).toContain("GROUP BY selected.candidate_id, selected.election_id, donor.committee_id");
    expect(sql).toContain("classification.label_type = 'committee'");
    const summary = result.get(KEY)!;
    expect(summary.controlled_committee_id).toBeNull();
    expect(summary.direct_campaign.pac_money_by_interest).toEqual([{
      interest: "unclassified", interest_name: "Not yet sorted", amount: 450.25, pac_count: 2,
      pacs: [
        { committee_id: "pac-1", committee_name: "Unsorted Michigan PAC", amount: 350.25, source_url: expect.stringContaining("michigan.gov") },
        { committee_id: "pac-2", committee_name: "Unsorted Michigan PAC", amount: 100, source_url: expect.stringContaining("michigan.gov") },
      ],
    }]);
    expect(summary.direct_campaign.total_raised).toBe(900);
    expect(summary.outside_spending.support_total).toBeNull();
  });

  it("uses stored committee classifications and exact shared rules", async () => {
    const db = mockDb([
      donor({ industry_slug: "healthcare", classification_source: "manual", confidence: "medium", source_url: SOURCE_URL }),
      donor({ committee_id: "pac-2", committee_name: "Microsoft", amount: "200.00" }),
    ]);
    const result = await loadMichiganCandidateFinanceSummariesByCandidateElection(db, candidates, elections);
    expect(result.get(KEY)?.direct_campaign.pac_money_by_interest).toMatchObject([
      { interest: "technology", amount: 200, pac_count: 1 },
      { interest: "healthcare", amount: 150.25, pac_count: 1, pacs: [{ source_url: SOURCE_URL }] },
    ]);
  });

  it("leaves broad or unknown-source classifications unsorted", async () => {
    const db = mockDb([
      donor({ committee_name: "Michigan Technology Initiative", industry_slug: "technology", classification_source: "rule", confidence: "medium" }),
      donor({ committee_id: "pac-2", industry_slug: "healthcare", classification_source: "unknown", confidence: "high" }),
    ]);
    const result = await loadMichiganCandidateFinanceSummariesByCandidateElection(db, candidates, elections);
    expect(result.get(KEY)?.direct_campaign.pac_money_by_interest).toMatchObject([
      { interest: "unclassified", amount: 300.5, pac_count: 2 },
    ]);
  });

  it("excludes candidate, ballot-question and unknown types regardless of name/classification", async () => {
    const db = mockDb(["Candidate", "Ballot Question", "Unknown"].map((type, i) => donor({
      committee_id: String(i), committee_type: type, committee_name: "Microsoft", industry_slug: "technology", confidence: "high",
    })));
    const result = await loadMichiganCandidateFinanceSummariesByCandidateElection(db, candidates, elections);
    expect(result.get(KEY)?.direct_campaign.pac_money_by_interest).toBeUndefined();
  });

  it.each(["Independent", "Independent Expenditure", "Political", "Caucus", "Qualifying Political Party", "State Political Party", "County Political Party", "District Political Party"])("accepts declared %s donors", async (type) => {
    const result = await loadMichiganCandidateFinanceSummariesByCandidateElection(mockDb([donor({ committee_type: type })]), candidates, elections);
    expect(result.get(KEY)?.direct_campaign.pac_money_by_interest?.[0]?.pac_count).toBe(1);
  });

  it("hides trusted excluded interests while retaining unknown and typed party donors", async () => {
    const db = mockDb([
      donor({ committee_id: "manual-hidden", committee_name: "Source Alpha PAC", amount: "5000.00", industry_slug: "leadership_pacs", classification_source: "manual", confidence: "low" }),
      donor({ committee_id: "ai-hidden", committee_name: "Source Beta PAC", amount: "2000.00", industry_slug: "candidate_committees", classification_source: "ai", confidence: "high" }),
      donor({ committee_id: "rule-hidden", committee_name: "Source Gamma PAC", amount: "1000.00", industry_slug: "leadership_pacs", classification_source: "rule", confidence: "high" }),
      donor({ committee_id: "low-hidden", committee_name: "Source Delta PAC", amount: "750.00", industry_slug: "candidate_committees", classification_source: "rule", confidence: "low" }),
      donor({ committee_id: "unknown", committee_name: "Source Epsilon PAC", amount: "200.00" }),
      donor({ committee_id: "party", committee_name: "Source Party Committee", committee_type: "State Political Party", amount: "300.00", industry_slug: "democratic_party_groups", classification_source: "manual", confidence: "high" }),
    ]);
    const result = await loadMichiganCandidateFinanceSummariesByCandidateElection(db, candidates, elections);
    const summary = result.get(KEY)!;
    expect(summary.direct_campaign.total_raised).toBe(900);
    expect(summary.direct_campaign.pac_money_by_interest).toMatchObject([
      { interest: "unclassified", interest_name: "Not yet sorted", amount: 950, pac_count: 2, pacs: [{ committee_id: "low-hidden" }, { committee_id: "unknown" }] },
      { interest: "democratic_party_groups", amount: 300, pac_count: 1, pacs: [{ committee_id: "party" }] },
    ]);
    expect(summary.direct_campaign.pac_money_by_interest).toHaveLength(2);
    expect(summary.direct_campaign.pac_money_by_interest?.map((interest) => interest.interest)).not.toEqual(expect.arrayContaining(["leadership_pacs", "candidate_committees"]));
  });

  it("caps detail without losing the full interest amount or committee count", async () => {
    const rows = Array.from({ length: 7 }, (_, i) => donor({ committee_id: `pac-${i}`, amount: i + 1 }));
    const result = await loadMichiganCandidateFinanceSummariesByCandidateElection(mockDb(rows), candidates, elections);
    const interest = result.get(KEY)?.direct_campaign.pac_money_by_interest?.[0];
    expect(interest).toMatchObject({ amount: 28, pac_count: 7 });
    expect(interest?.pacs).toHaveLength(5);
    expect(interest?.pacs.map((pac) => pac.amount)).toEqual([7, 6, 5, 4, 3]);
  });

  it("does not query donors without summaries or when disabled", async () => {
    const db = mockDb([], []);
    await expect(loadMichiganCandidateFinanceSummariesByCandidateElection(db, candidates, elections)).resolves.toEqual(new Map());
    expect(db.query).toHaveBeenCalledOnce();
    vi.stubEnv("MICHIGAN_CAMPAIGN_FINANCE_ENABLED", "false");
    await expect(loadMichiganCandidateFinanceSummariesByCandidateElection(db, candidates, elections)).resolves.toEqual(new Map());
    expect(db.query).toHaveBeenCalledOnce();
  });
});
