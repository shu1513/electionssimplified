import { afterEach, describe, expect, it, vi } from "vitest";

import { loadOregonCandidateFinanceSummariesByCandidateElection } from "../../../src/pipeline/oregonFinance/oregonBallotLookupFinanceLoader.js";

afterEach(() => vi.unstubAllEnvs());
const candidateId = "11111111-1111-4111-8111-111111111111";
const electionId = "22222222-2222-4222-8222-222222222222";
const sourceUrl = "https://secure.sos.state.or.us/orestar/sooDetail.do?cneCommitteeId=169";
const candidates = [{ candidate_id: candidateId, election_id: electionId }];
const elections = [{ election_id: electionId, state: "OR", office_scope: "state_lower",
  office_canonical_name: "State Lower Chamber Legislator" }];

function donor(overrides: Record<string, unknown> = {}) {
  return { candidate_id: candidateId, election_id: electionId, committee_id: "169",
    committee_name: "Known source PAC", committee_type: "Political Action Committee", amount: "1500.00",
    source_url: sourceUrl, industry_slug: null, classification_source: null, confidence: null, ...overrides };
}
function database(rows: unknown[]) {
  return { query: vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes("or_candidate_finance_pac_donors")) return { rows };
    if (sql.includes("or_candidate_finance_summaries")) return { rows: [{
      candidate_id: candidateId, election_id: electionId, committee_id: "21892", election_year: 2026,
      total_receipts: "80000.00", direct_contribution_total: "80000.00", total_disbursements: null,
      cash_on_hand: null, outside_support_total: null, outside_oppose_total: null, source_url: sourceUrl,
      last_synced_at: "2026-10-11T19:00:00.000Z",
    }] };
    return { rows: [] };
  }) };
}
async function read(rows: unknown[]) {
  vi.stubEnv("OREGON_CAMPAIGN_FINANCE_ENABLED", "true");
  const db = database(rows);
  const summaries = await loadOregonCandidateFinanceSummariesByCandidateElection(db, candidates, elections);
  return { db, summary: [...summaries.values()][0]! };
}

describe("Oregon named registered PAC reader", () => {
  it("shows named PAC receipts as a subset without adding them to Raised", async () => {
    const { db, summary } = await read([donor(), donor({ committee_id: "23238", committee_name: "Evergreen PAC", amount: "10000.00" })]);
    expect(summary.direct_campaign.total_raised).toBe(80000);
    expect(summary.direct_campaign.pac_money_by_interest).toEqual([{
      interest: "unclassified", interest_name: "Not yet sorted", amount: 11500, pac_count: 2,
      pacs: [
        { committee_id: "23238", committee_name: "Evergreen PAC", amount: 10000, source_url: sourceUrl },
        { committee_id: "169", committee_name: "Known source PAC", amount: 1500, source_url: sourceUrl },
      ],
    }]);
    expect(summary.direct_campaign.direct_coverage_note).toContain("Anonymous small-contribution totals remain unclassified");
    expect(summary.outside_spending.support_total).toBeNull();
    expect(summary.outside_spending.oppose_total).toBeNull();
    const sql = db.query.mock.calls.find(([sql]) => sql.includes("or_candidate_finance_pac_donors"))![0];
    expect(sql).toContain("link.link_status = 'active'");
    expect(sql).toContain("donor.election_year = link.election_year");
    expect(sql).toContain("sum(donor.amount) AS amount");
    expect(sql).toContain("GROUP BY selected.candidate_id, selected.election_id, donor.committee_id");
    expect(sql).not.toContain("LIMIT");
  });

  it("retains source-classified candidate-controlled PACs despite federal hidden classifications", async () => {
    const { summary } = await read([
      donor({ committee_id: "101", committee_name: "Friends of a Candidate PAC", industry_slug: "candidate_committees", classification_source: "manual" }),
      donor({ committee_id: "102", industry_slug: "leadership_pacs", classification_source: "ai", confidence: "high" }),
      donor({ committee_id: "103", committee_type: "Candidate Committee", amount: "99999.00" }),
    ]);
    expect(summary.direct_campaign.pac_money_by_interest?.[0]).toMatchObject({ interest: "unclassified", amount: 3000, pac_count: 2 });
  });

  it("uses trusted stored interest classifications and preserves low-confidence unknowns", async () => {
    const { summary } = await read([
      donor({ committee_id: "101", industry_slug: "technology", classification_source: "manual", confidence: "low" }),
      donor({ committee_id: "102", industry_slug: "labor_unions", classification_source: "rule", confidence: "high" }),
      donor({ committee_id: "103", industry_slug: "healthcare", classification_source: "ai", confidence: "low" }),
    ]);
    expect(summary.direct_campaign.pac_money_by_interest?.map(p => p.interest).sort())
      .toEqual(["labor_unions", "technology", "unclassified"]);
  });

  it("sums every distinct PAC before capping displayed names at five", async () => {
    const { summary } = await read(Array.from({ length: 7 }, (_, i) => donor({
      committee_id: String(300 + i), committee_name: "Source PAC " + i, amount: String(100 + i),
    })));
    expect(summary.direct_campaign.pac_money_by_interest?.[0]).toMatchObject({ amount: 721, pac_count: 7 });
    expect(summary.direct_campaign.pac_money_by_interest?.[0]?.pacs.map(p => p.amount)).toEqual([106, 105, 104, 103, 102]);
  });

  it("ranks complete interest totals before showing five interest groups", async () => {
    const interests = ["technology", "healthcare", "construction", "education", "labor_unions", "agriculture_and_food", "finance_investment"];
    const { summary } = await read(interests.map((interest, i) => donor({
      committee_id: String(400 + i), amount: String(100 + i), industry_slug: interest, classification_source: "manual",
    })));
    expect(summary.direct_campaign.pac_money_by_interest?.map(p => p.amount)).toEqual([106, 105, 104, 103, 102]);
  });

  it("omits unknown, empty, nonpositive and wrongly typed PAC cards", async () => {
    for (const rows of [[], [donor({ amount: "0" })], [donor({ amount: "NaN" })], [donor({ committee_type: "Candidate Committee" })]]) {
      const { summary } = await read(rows);
      expect(summary.direct_campaign.pac_money_by_interest).toBeUndefined();
      expect(summary.direct_campaign.direct_coverage_note).toBeUndefined();
      expect(summary.direct_campaign.total_raised).toBe(80000);
    }
  });

  it("performs no source or DB lookup when finance is disabled or state scope differs", async () => {
    vi.stubEnv("OREGON_CAMPAIGN_FINANCE_ENABLED", "false");
    const db = database([]);
    expect((await loadOregonCandidateFinanceSummariesByCandidateElection(db, candidates, elections)).size).toBe(0);
    vi.stubEnv("OREGON_CAMPAIGN_FINANCE_ENABLED", "true");
    expect((await loadOregonCandidateFinanceSummariesByCandidateElection(db, candidates, [{ ...elections[0]!, state: "WA" }])).size).toBe(0);
    expect(db.query).not.toHaveBeenCalled();
  });
});
