import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTennesseeCandidateFinanceSummariesByCandidateElection } from "../../../src/pipeline/tennesseeFinance/tennesseeBallotLookupFinanceLoader.js";

afterEach(() => vi.unstubAllEnvs());
const candidateId = "11111111-1111-4111-8111-111111111111";
const electionId = "22222222-2222-4222-8222-222222222222";
const candidates = [{ candidate_id: candidateId, election_id: electionId }];
const elections = [{ election_id: electionId, state: "TN", office_scope: "state_upper", office_canonical_name: "State Senator" }];
const sourceUrl = "https://apps.tn.gov/tncamp/search/pub/report_full.htm?reportId=123786";
function donor(overrides: Record<string, unknown> = {}) {
  return { candidate_id: candidateId, election_id: electionId, committee_id: "reported:EXAMPLE PAC",
    committee_name: "Example PAC", committee_type: "Political Action Committee", amount: "1000.00",
    source_url: sourceUrl, industry_slug: null, classification_source: null, confidence: null, ...overrides };
}
function database(donors: unknown[]) {
  return { query: vi.fn(async (sql: string) => {
    if (sql.includes("tn_candidate_finance_pac_donors")) return { rows: donors };
    if (sql.includes("tn_candidate_finance_summaries")) return { rows: [{
      candidate_id: candidateId, election_id: electionId, committee_id: "794", election_year: 2026,
      total_receipts: "5000.00", direct_contribution_total: "5000.00",
      outside_support_total: null, outside_oppose_total: null, source_url: sourceUrl,
      last_synced_at: "2026-10-11T12:00:00.000Z",
    }] };
    return { rows: [] };
  }) };
}
async function read(rows: unknown[]) {
  vi.stubEnv("TENNESSEE_CAMPAIGN_FINANCE_ENABLED", "true");
  const db = database(rows);
  const summary = [...(await loadTennesseeCandidateFinanceSummariesByCandidateElection(db, candidates, elections)).values()][0]!;
  return { db, summary };
}
describe("Tennessee typed PAC card", () => {
  it("reads typed donors across active links without adding them to Raised", async () => {
    const { db, summary } = await read([donor()]);
    expect(summary.direct_campaign.total_raised).toBe(5000);
    expect(summary.outside_spending.support_total).toBeNull();
    expect(summary.direct_campaign.pac_money_by_interest).toEqual([{ interest: "unclassified",
      interest_name: "Not yet sorted", amount: 1000, pac_count: 1,
      pacs: [{ committee_id: "reported:EXAMPLE PAC", committee_name: "Example PAC", amount: 1000, source_url: sourceUrl }] }]);
    expect(summary.direct_campaign.direct_coverage_note).toContain("identical reported names");
    const sql = db.query.mock.calls.find(([sql]) => sql.includes("tn_candidate_finance_pac_donors"))![0];
    expect(sql).toContain("donor.election_year=link.election_year");
    expect(sql).toContain("link.link_status='active'");
    expect(sql).toContain("sum(donor.amount) AS amount");
    expect(sql).not.toContain("LIMIT");
  });
  it("sums all seven donors before capping displayed names at five", async () => {
    const { summary } = await read(Array.from({ length: 7 }, (_, i) => donor({
      committee_id: String(100 + i), committee_name: "Source label " + i, amount: String(100 + i),
    })));
    expect(summary.direct_campaign.pac_money_by_interest?.[0]).toMatchObject({ amount: 721, pac_count: 7 });
    expect(summary.direct_campaign.pac_money_by_interest?.[0]?.pacs.map(p => p.amount)).toEqual([106, 105, 104, 103, 102]);
  });
  it("uses trusted cached classifications, hides shared excluded interests, retains unsorted names", async () => {
    const { summary } = await read([
      donor({ industry_slug: "healthcare", classification_source: "manual", confidence: "low" }),
      donor({ committee_id: "123", committee_name: "Unsorted Example", amount: 500, industry_slug: "technology", classification_source: "ai", confidence: "medium" }),
      donor({ committee_id: "456", industry_slug: "leadership_pacs", classification_source: "ai", confidence: "high" }),
      donor({ committee_id: "789", committee_type: "Principal Campaign Committee", amount: 99999 }),
    ]);
    expect(summary.direct_campaign.pac_money_by_interest?.map(p => [p.interest, p.amount])).toEqual([["healthcare", 1000], ["unclassified", 500]]);
    expect(summary.direct_campaign.total_raised).toBe(5000);
  });
  it("omits an empty or invalid donor card while leaving outside unavailable", async () => {
    const { summary } = await read([donor({ amount: 0 }), donor({ amount: -1 }), donor({ amount: "invalid" })]);
    expect(summary.direct_campaign).not.toHaveProperty("pac_money_by_interest");
    expect(summary.outside_spending.oppose_total).toBeNull();
  });
  it.each(["disabled", "ineligible"])("avoids queries for %s requests", async mode => {
    vi.stubEnv("TENNESSEE_CAMPAIGN_FINANCE_ENABLED", mode === "disabled" ? "false" : "true");
    const db = database([donor()]);
    const selected = mode === "ineligible" ? [{ ...elections[0]!, office_scope: "federal", office_canonical_name: "United States Senator" }] : elections;
    expect((await loadTennesseeCandidateFinanceSummariesByCandidateElection(db, candidates, selected)).size).toBe(0);
    expect(db.query).not.toHaveBeenCalled();
  });
});
