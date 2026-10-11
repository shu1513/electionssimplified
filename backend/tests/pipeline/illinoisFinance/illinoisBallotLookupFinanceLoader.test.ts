import { afterEach, describe, expect, it, vi } from "vitest";

import { loadIllinoisCandidateFinanceSummariesByCandidateElection } from "../../../src/pipeline/illinoisFinance/illinoisBallotLookupFinanceLoader.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";

describe("illinoisBallotLookupFinanceLoader", () => {
  it("does not expose transfer-sensitive totals for a multi-committee candidate", async () => {
    vi.stubEnv("ILLINOIS_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: CANDIDATE_ID,
            election_id: ELECTION_ID,
            committee_id: null,
            election_year: 2025,
            total_receipts: null,
            direct_contribution_total: null,
            total_disbursements: null,
            cash_on_hand: "1500.00",
            debts_owed: "200.00",
            outside_support_total: null,
            outside_oppose_total: null,
            source_url: "https://www.elections.il.gov/CampaignDisclosure/",
            last_synced_at: "2025-04-01T00:00:00.000Z",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await loadIllinoisCandidateFinanceSummariesByCandidateElection(
      { query },
      [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID }],
      [{ election_id: ELECTION_ID, state: "IL", office_scope: "place", office_canonical_name: "Mayor" }]
    );

    expect(query).toHaveBeenCalledTimes(6);
    expect(String(query.mock.calls[0]?.[0])).toContain("count(DISTINCT link.committee_key) = 1");
    expect(String(query.mock.calls[0]?.[0])).toContain(
      "count(summary.cash_on_hand) = count(DISTINCT link.committee_key)"
    );
    expect(String(query.mock.calls[0]?.[0])).toContain(
      "count(summary.debts_owed) = count(DISTINCT link.committee_key)"
    );
    expect(result.get(`${CANDIDATE_ID}\u0000${ELECTION_ID}`)?.direct_campaign).toMatchObject({
      total_raised: null,
      total_spent: null,
      cash_on_hand: 1500,
      debts_owed: 200,
    });
  });

  it("exposes D-2 totals for a single-committee candidate", async () => {
    vi.stubEnv("ILLINOIS_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: CANDIDATE_ID,
            election_id: ELECTION_ID,
            committee_id: "SBE:201",
            election_year: 2025,
            total_receipts: "1200.00",
            direct_contribution_total: null,
            total_disbursements: "550.00",
            cash_on_hand: "800.00",
            debts_owed: "90.00",
            outside_support_total: null,
            outside_oppose_total: null,
            source_url: "https://www.elections.il.gov/CampaignDisclosure/",
            last_synced_at: "2025-04-01T00:00:00.000Z",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await loadIllinoisCandidateFinanceSummariesByCandidateElection(
      { query },
      [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID }],
      [{ election_id: ELECTION_ID, state: "IL", office_scope: "place", office_canonical_name: "Mayor" }]
    );

    expect(result.get(`${CANDIDATE_ID}\u0000${ELECTION_ID}`)?.direct_campaign).toMatchObject({
      total_raised: 1200,
      total_spent: 550,
      cash_on_hand: 800,
      debts_owed: 90,
    });
  });
});


const REQUESTS = [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID }];
const ELECTIONS = [{ election_id: ELECTION_ID, state: "IL", office_scope: "state_lower", office_canonical_name: "State Lower Chamber Legislator" }];
function pacDonor(overrides: Record<string, unknown> = {}) {
  return { candidate_id: CANDIDATE_ID, election_id: ELECTION_ID, committee_id: "1028", committee_name: "Community BANCPAC",
    committee_type: "Political Action", amount: "1000", contribution_count: 1,
    source_url: null, industry_slug: null, classification_source: null, confidence: null, ...overrides };
}
function dbWithPacDonors(rows: unknown[], hasSummary = true) {
  return { query: vi.fn(async (sql: string, _parameters?: unknown[]) => {
    if (sql.includes("il_candidate_finance_pac_donors")) return { rows };
    if (sql.includes("il_candidate_finance_summaries")) return { rows: hasSummary ? [{
      candidate_id: CANDIDATE_ID, election_id: ELECTION_ID, committee_id: null, election_year: 2026,
      total_receipts: "2000", direct_contribution_total: "1500", total_disbursements: "700", cash_on_hand: "300",
      debts_owed: "20", outside_support_total: null, outside_oppose_total: null,
      source_url: "https://www.elections.il.gov/CampaignDisclosure/", last_synced_at: "2026-10-11",
    }] : [] };
    return { rows: [] };
  }) };
}
async function readPacSummary(rows: unknown[]) {
  return [...(await loadIllinoisCandidateFinanceSummariesByCandidateElection(dbWithPacDonors(rows), REQUESTS, ELECTIONS)).values()][0]!;
}

describe("Illinois current Quarterly typed committee donor reader", () => {
  it("adds a donor across receiving links once without adding the donor subset to D-2 Raised", async () => {
    vi.stubEnv("ILLINOIS_CAMPAIGN_FINANCE_ENABLED", "true");
    // DB grouped result represents two receiving links, $1000+$500 from donor1028.
    const db = dbWithPacDonors([pacDonor({ amount: "1500", contribution_count: 2 })]);
    const result = [...(await loadIllinoisCandidateFinanceSummariesByCandidateElection(db, REQUESTS, ELECTIONS)).values()][0]!;
    expect(result.direct_campaign.total_raised).toBe(2000);
    expect(result.direct_campaign.pac_money_by_interest).toMatchObject([
      { interest: "unclassified", interest_name: "Not yet sorted", amount: 1500, pac_count: 1,
        pacs: [{ committee_id: "1028", amount: 1500, source_url: "https://www.elections.il.gov/CampaignDisclosure/" }] },
    ]);
    const call = db.query.mock.calls.find(([sql]) => sql.includes("il_candidate_finance_pac_donors"))!;
    const sql = call[0];
    expect(sql).toContain("link.link_status = 'active'");
    expect(sql).toContain("donor.election_year = link.election_year");
    expect(sql).toContain("donor.link_id = link.id");
    expect(sql).toContain("GROUP BY selected.candidate_id, selected.election_id, donor.committee_id");
    expect(sql).toContain("sum(donor.amount) AS amount");
    expect(sql).toContain("sum(donor.contribution_count) AS contribution_count");
    expect(sql).toContain("donor.committee_type IN ('Political Action', 'Political Party')");
    expect(sql).toContain("classification.label_type = 'committee'");
    expect(sql).toContain("public.normalize_finance_label(grouped.committee_name)");
    expect(sql).not.toMatch(/LIMIT|rn <= 5|finance_pac_interests/);
    expect(JSON.parse(String(call[1]![0]))).toEqual(REQUESTS);
    expect(result.direct_campaign.direct_coverage_note).toContain("current Quarterly itemized cash");
    expect(result.direct_campaign.direct_coverage_note).toContain("schedules 1 and 2");
    expect(result.direct_campaign.direct_coverage_note).toContain("PAC gifts are included within D-2 Raised");
    expect(result.direct_campaign.direct_coverage_note).toContain("In-kind gifts, rapid reports, loans");
    expect(result.outside_spending.support_total).toBeNull();
    expect(result.outside_spending.oppose_total).toBeNull();
    expect(result.outside_spending.outside_coverage_note).toContain("itemized Quarterly");
    expect(result.outside_spending.outside_coverage_note).toContain("Unitemized expenditures, rapid B1 and natural-person reports are excluded");
    expect(result.outside_spending.outside_coverage_note).toContain("Missing or unproven empty data preserves prior spending");
    expect(result.outside_spending.outside_coverage_note).toContain("prior rows whose provenance remains unknown");
  });

  it("hides trusted classifications after manual overrides, while retaining low-confidence unknowns and parties", async () => {
    vi.stubEnv("ILLINOIS_CAMPAIGN_FINANCE_ENABLED", "true");
    const result = await readPacSummary([
      pacDonor({ committee_name: "GOOGLE", industry_slug: "leadership_pacs", classification_source: "manual", confidence: "low" }),
      pacDonor({ committee_id: "2001", industry_slug: "candidate_committees", classification_source: "ai", confidence: "high" }),
      pacDonor({ committee_id: "2002", industry_slug: "leadership_pacs", classification_source: "rule", confidence: "high" }),
      pacDonor({ committee_id: "2003", amount: 750, industry_slug: "candidate_committees", classification_source: "rule", confidence: "low" }),
      pacDonor({ committee_id: "2004", amount: 250, industry_slug: "leadership_pacs", classification_source: "ai", confidence: "medium" }),
      pacDonor({ committee_id: "615", committee_name: "Kane County Republican Central Cmte", committee_type: "Political Party", amount: 300,
        industry_slug: "republican_party_groups", classification_source: "manual", confidence: "low" }),
    ]);
    expect(result.direct_campaign.pac_money_by_interest).toMatchObject([
      { interest: "unclassified", amount: 1000, pac_count: 2 },
      { interest: "republican_party_groups", amount: 300, pac_count: 1 },
    ]);
    expect(result.direct_campaign.pac_money_by_interest?.flatMap((entry) => entry.pacs).map((row) => row.committee_id))
      .toEqual(["2003", "2004", "615"]);
  });

  it("trusts exact high shared rules, but does not use loose keywords or candidate-looking PAC names as proof", async () => {
    vi.stubEnv("ILLINOIS_CAMPAIGN_FINANCE_ENABLED", "true");
    const result = await readPacSummary([
      pacDonor({ committee_name: "GOOGLE", amount: 250 }),
      pacDonor({ committee_id: "2002", committee_name: "Illinois Education Health PAC", amount: 500 }),
      pacDonor({ committee_id: "2003", committee_name: "Friends of Ordinary Person", amount: 300 }),
      pacDonor({ committee_id: "2004", committee_name: "Unsorted Committee", amount: 100,
        industry_slug: "healthcare", classification_source: "rule", confidence: "medium" }),
    ]);
    expect(result.direct_campaign.pac_money_by_interest).toMatchObject([
      { interest: "unclassified", amount: 900, pac_count: 3 },
      { interest: "technology", amount: 250, pac_count: 1 },
    ]);
  });

  it("counts all positive typed donors before limiting donor detail to five", async () => {
    vi.stubEnv("ILLINOIS_CAMPAIGN_FINANCE_ENABLED", "true");
    const rows = Array.from({ length: 7 }, (_, index) => pacDonor({ committee_id: String(2000 + index), amount: 100 + index }));
    rows.push(pacDonor({ committee_type: "Candidate", amount: 100000 }), pacDonor({ committee_type: "Independent Expenditure", amount: 100000 }),
      pacDonor({ committee_type: "Political-Action", amount: 100000 }), pacDonor({ amount: -100000 }),
      pacDonor({ amount: "bad" }), pacDonor({ amount: 0 }));
    const entry = (await readPacSummary(rows)).direct_campaign.pac_money_by_interest![0]!;
    expect(entry).toMatchObject({ amount: 721, pac_count: 7 });
    expect(entry.pacs.map((row) => row.amount)).toEqual([106, 105, 104, 103, 102]);
  });

  it("sorts and limits interests after their full donor sums", async () => {
    vi.stubEnv("ILLINOIS_CAMPAIGN_FINANCE_ENABLED", "true");
    const interests = ["technology", "healthcare", "finance_investment", "agriculture_and_food", "labor_unions", "environmental_group"];
    const rows = interests.flatMap((industry_slug, index) => [
      pacDonor({ committee_id: String(3000 + index * 2), amount: 100 * (index + 1), industry_slug, classification_source: "manual", confidence: "low" }),
      pacDonor({ committee_id: String(3001 + index * 2), amount: 10, industry_slug, classification_source: "manual", confidence: "low" }),
    ]);
    expect((await readPacSummary(rows)).direct_campaign.pac_money_by_interest).toMatchObject([
      { interest: "environmental_group", amount: 610, pac_count: 2 },
      { interest: "labor_unions", amount: 510, pac_count: 2 },
      { interest: "agriculture_and_food", amount: 410, pac_count: 2 },
      { interest: "finance_investment", amount: 310, pac_count: 2 },
      { interest: "healthcare", amount: 210, pac_count: 2 },
    ]);
  });

  it("does not create an empty donor list when only hidden or missing donors exist", async () => {
    vi.stubEnv("ILLINOIS_CAMPAIGN_FINANCE_ENABLED", "true");
    expect((await readPacSummary([])).direct_campaign).not.toHaveProperty("pac_money_by_interest");
    expect((await readPacSummary([pacDonor({ industry_slug: "leadership_pacs", classification_source: "manual", confidence: "low" })]))
      .direct_campaign).not.toHaveProperty("pac_money_by_interest");
  });

  it("queries only deduplicated candidate-election summaries returned by eligible requests", async () => {
    vi.stubEnv("ILLINOIS_CAMPAIGN_FINANCE_ENABLED", "true");
    const db = dbWithPacDonors([pacDonor()]);
    const missing = { candidate_id: "33333333-3333-4333-8333-333333333333", election_id: ELECTION_ID };
    await loadIllinoisCandidateFinanceSummariesByCandidateElection(db, [...REQUESTS, ...REQUESTS, missing], ELECTIONS);
    const call = db.query.mock.calls.find(([sql]) => sql.includes("il_candidate_finance_pac_donors"))!;
    expect(JSON.parse(String(call[1]![0]))).toEqual(REQUESTS);
  });

  it("skips donor queries for missing summary, disabled flag, ineligible office or different state", async () => {
    vi.stubEnv("ILLINOIS_CAMPAIGN_FINANCE_ENABLED", "true");
    const db = dbWithPacDonors([], false);
    expect((await loadIllinoisCandidateFinanceSummariesByCandidateElection(db, REQUESTS, ELECTIONS)).size).toBe(0);
    expect(db.query).toHaveBeenCalledOnce();
    vi.stubEnv("ILLINOIS_CAMPAIGN_FINANCE_ENABLED", "false");
    expect((await loadIllinoisCandidateFinanceSummariesByCandidateElection(db, REQUESTS, ELECTIONS)).size).toBe(0);
    vi.stubEnv("ILLINOIS_CAMPAIGN_FINANCE_ENABLED", "true");
    expect((await loadIllinoisCandidateFinanceSummariesByCandidateElection(db, REQUESTS,
      [{ ...ELECTIONS[0]!, office_scope: "federal", office_canonical_name: "US Senator" }])).size).toBe(0);
    expect((await loadIllinoisCandidateFinanceSummariesByCandidateElection(db, REQUESTS,
      [{ ...ELECTIONS[0]!, state: "IN" }])).size).toBe(0);
    expect(db.query).toHaveBeenCalledOnce();
  });
});
