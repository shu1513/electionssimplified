import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrationTableColumns } from "../../helpers/migrationTableColumns.js";
import { loadAlabamaCandidateFinanceSummariesByCandidateElection } from "../../../src/pipeline/alabamaFinance/alabamaBallotLookupFinanceLoader.js";

afterEach(() => vi.unstubAllEnvs());
const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_URL = "https://fcpa.alabamavotes.gov/";
const candidates = [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID }];
const elections = [{ election_id: ELECTION_ID, state: "AL",
  office_scope: "statewide", office_canonical_name: "Governor" }];

function donor(overrides: Record<string, unknown> = {}) {
  return { candidate_id: CANDIDATE_ID, election_id: ELECTION_ID, committee_id: "24906",
    committee_name: "Electric Cooperatives of Alabama PAC", committee_type: "Political Action Committee",
    amount: "1500.00", source_url: SOURCE_URL, industry_slug: null,
    classification_source: null, confidence: null, ...overrides };
}
function dbWithDonors(rows: unknown[]) {
  return { query: vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes("al_candidate_finance_pac_donors")) return { rows };
    if (sql.includes("al_candidate_finance_summaries")) return { rows: [{
      candidate_id: CANDIDATE_ID, election_id: ELECTION_ID, election_year: 2026,
      committee_id: "206", total_receipts: "38000.00", direct_contribution_total: "38000.00",
      total_disbursements: "1000.00", cash_on_hand: "37000.00",
      outside_support_total: null, outside_oppose_total: null,
      last_synced_at: "2026-10-11T12:00:00.000Z",
    }] };
    return { rows: [] };
  }) };
}
describe("Alabama typed PAC interest reader", () => {
  it("reads exact active-link/year donor sums without adding PAC money to Raised", async () => {
    vi.stubEnv("ALABAMA_CAMPAIGN_FINANCE_ENABLED", "true");
    const db = dbWithDonors([
      donor({ amount: "2000.00", industry_slug: "oil_gas_energy",
        classification_source: "manual", confidence: "low" }),
      donor({ committee_id: "25000", committee_name: "Unknown Source PAC", amount: "500.00",
        industry_slug: "technology", classification_source: "ai", confidence: "medium", source_url: null }),
      donor({ committee_id: "25100", committee_type: "Principal Campaign Committee", amount: "99999.00" }),
    ]);
    const summary = [...(await loadAlabamaCandidateFinanceSummariesByCandidateElection(db, candidates, elections)).values()][0]!;
    expect(summary.direct_campaign.total_raised).toBe(38000);
    expect(summary.outside_spending.support_total).toBeNull();
    expect(summary.direct_campaign.pac_money_by_interest).toEqual([
      { interest: "oil_gas_energy", interest_name: "Oil, gas, and energy", amount: 2000, pac_count: 1,
        pacs: [{ committee_id: "24906", committee_name: "Electric Cooperatives of Alabama PAC",
          amount: 2000, source_url: SOURCE_URL }] },
      { interest: "unclassified", interest_name: "Not yet sorted", amount: 500, pac_count: 1,
        pacs: [{ committee_id: "25000", committee_name: "Unknown Source PAC", amount: 500, source_url: SOURCE_URL }] },
    ]);
    const call = db.query.mock.calls.find(([sql]) => sql.includes("al_candidate_finance_pac_donors"))!;
    for (const fragment of ["link.link_status = 'active'", "donor.election_year = link.election_year",
      "sum(donor.amount) AS amount", "GROUP BY selected.candidate_id, selected.election_id, donor.committee_id",
      "classification.label_type = 'committee'", "public.normalize_finance_label(grouped.committee_name)"]) {
      expect(call[0]).toContain(fragment);
    }
    expect(call[0]).not.toContain("LIMIT");
    expect(JSON.parse(String(call[1]?.[0]))).toEqual(candidates);
  });

  it("uses trusted hidden-interest classifications while retaining unknowns and party groups", async () => {
    vi.stubEnv("ALABAMA_CAMPAIGN_FINANCE_ENABLED", "true");
    const db = dbWithDonors([
      donor({ committee_id: "101", committee_name: "Source Alpha", industry_slug: "leadership_pacs",
        classification_source: "manual", confidence: "low" }),
      donor({ committee_id: "102", committee_name: "Source Beta", industry_slug: "candidate_committees",
        classification_source: "ai", confidence: "high" }),
      donor({ committee_id: "103", committee_name: "Source Gamma", industry_slug: "leadership_pacs",
        classification_source: "rule", confidence: "high" }),
      donor({ committee_id: "104", committee_name: "Source Delta", amount: "500.00",
        industry_slug: "candidate_committees", classification_source: "rule", confidence: "low" }),
      donor({ committee_id: "105", committee_name: "Source Epsilon", amount: "300.00",
        industry_slug: "democratic_party_groups", classification_source: "manual", confidence: "high" }),
    ]);
    const summary = [...(await loadAlabamaCandidateFinanceSummariesByCandidateElection(db, candidates, elections)).values()][0]!;
    expect(summary.direct_campaign.pac_money_by_interest?.map(x => [x.interest, x.amount, x.pac_count])).toEqual([
      ["unclassified", 500, 1], ["democratic_party_groups", 300, 1],
    ]);
    expect(summary.direct_campaign.total_raised).toBe(38000);
  });

  it("totals every unique donor before applying the five-donor display cap", async () => {
    vi.stubEnv("ALABAMA_CAMPAIGN_FINANCE_ENABLED", "true");
    const db = dbWithDonors(Array.from({ length: 7 }, (_, i) => donor({
      committee_id: String(30000+i), committee_name: "Unsorted source "+i, amount: String(100+i),
    })));
    const summary = [...(await loadAlabamaCandidateFinanceSummariesByCandidateElection(db, candidates, elections)).values()][0]!;
    expect(summary.direct_campaign.pac_money_by_interest?.[0]).toMatchObject({
      interest: "unclassified", amount: 721, pac_count: 7,
    });
    expect(summary.direct_campaign.pac_money_by_interest?.[0]?.pacs.map(x => x.amount)).toEqual([106,105,104,103,102]);
  });

  it("ranks complete interest totals before showing the five largest interests", async () => {
    vi.stubEnv("ALABAMA_CAMPAIGN_FINANCE_ENABLED", "true");
    const interests = ["technology", "healthcare", "finance_investment", "construction",
      "education", "agriculture_and_food", "labor_unions"];
    const db = dbWithDonors(interests.map((interest, i) => donor({
      committee_id: String(40000+i), committee_name: "Source sector "+i,
      amount: String(100+i), industry_slug: interest, classification_source: "manual", confidence: "high",
    })));
    const summary = [...(await loadAlabamaCandidateFinanceSummariesByCandidateElection(db, candidates, elections)).values()][0]!;
    expect(summary.direct_campaign.pac_money_by_interest?.map(x => x.amount)).toEqual([106,105,104,103,102]);
    expect(summary.direct_campaign.pac_money_by_interest?.[0]?.interest).toBe("labor_unions");
    expect(summary.direct_campaign.total_raised).toBe(38000);
  });

  it("does not display an empty, nonpositive or wrongly typed donor card", async () => {
    vi.stubEnv("ALABAMA_CAMPAIGN_FINANCE_ENABLED", "true");
    const db = dbWithDonors([donor({amount:"0.00"}),donor({amount:"-1.00"}),donor({amount:"bad"}),
      donor({committee_type:"Individual"})]);
    const summary = [...(await loadAlabamaCandidateFinanceSummariesByCandidateElection(db, candidates, elections)).values()][0]!;
    expect(summary.direct_campaign).not.toHaveProperty("pac_money_by_interest");
  });

  it.each(["disabled", "ineligible"])("does not query donors for %s requests", async mode => {
    vi.stubEnv("ALABAMA_CAMPAIGN_FINANCE_ENABLED", mode==="disabled"?"false":"true");
    const db = dbWithDonors([donor()]);
    const selected = mode==="ineligible" ? [{...elections[0]!,office_scope:"federal",office_canonical_name:"United States Senator"}] : elections;
    expect((await loadAlabamaCandidateFinanceSummariesByCandidateElection(db,candidates,selected)).size).toBe(0);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("reads reported donor groups without altering Raised and explains identity limits", async () => {
    vi.stubEnv("ALABAMA_CAMPAIGN_FINANCE_ENABLED", "true");
    const db = dbWithDonors([donor({ committee_id: "reported:REPORTED SOURCE PAC", committee_name: "Reported Source PAC" })]);
    const summary = [...(await loadAlabamaCandidateFinanceSummariesByCandidateElection(db, candidates, elections)).values()][0]!;
    expect(summary.direct_campaign.total_raised).toBe(38000);
    expect(summary.direct_campaign.pac_money_by_interest?.[0]?.pac_count).toBe(1);
    expect(summary.direct_campaign.direct_coverage_note).toContain("source-reported donor groups");
    expect(summary.direct_campaign.direct_coverage_note).toContain("identical reported names");
  });

  it("keeps migration identifiers bounded and enforces donor type/link-year/positive constraints", () => {
    const sql = readFileSync(new URL("../../../../db/migrations/328_add_alabama_finance_pac_donors.sql",import.meta.url),"utf8");
    for (const [,name] of sql.matchAll(/(?:CONSTRAINT|CREATE TRIGGER|CREATE INDEX IF NOT EXISTS)\s+([a-z_]+)/g)) {
      expect(Buffer.byteLength(name!,"utf8")).toBeLessThanOrEqual(63);
    }
    expect(sql).toContain("FOREIGN KEY (link_id, election_year)");
    expect(sql).toContain("REFERENCES public.al_candidate_finance_links(id, election_year)");
    expect(sql).toContain("committee_type = 'Political Action Committee'");
    expect(sql).toContain("CHECK (amount > 0)");
    expect(sql).toContain("CHECK (contribution_count > 0)");
    expect(sql).toContain("committee_id::numeric <= 9007199254740991");
    expect(sql).toContain("^reported:[[:alnum:]]+( [[:alnum:]]+)*$");
    expect(sql).toContain("committee_id NOT LIKE 'reported:%' OR source_url IS NOT NULL");
    const columns = migrationTableColumns("al_candidate_finance_pac_donors");
    for (const column of ["link_id","election_year","committee_id","committee_name","committee_type",
      "amount","contribution_count","source_url","last_synced_at"]) expect(columns.has(column)).toBe(true);
  });
});
