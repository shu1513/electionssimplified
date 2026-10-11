import { afterEach, describe, expect, it, vi } from "vitest";

import { migrationTableColumns } from "../../helpers/migrationTableColumns.js";
import { loadTexasCandidateFinanceSummariesByCandidateElection } from "../../../src/pipeline/texasFinance/texasBallotLookupFinanceLoader.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_URL = "https://www.ethics.state.tx.us/search/cf/";
const candidates = [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID }];
const elections = [{ election_id: ELECTION_ID, state: "TX", office_scope: "statewide", office_canonical_name: "Governor" }];

function donor(overrides: Record<string, unknown> = {}) {
  return { candidate_id: CANDIDATE_ID, election_id: ELECTION_ID, committee_id: "00015672",
    committee_name: "Wholesale Beer Distributors of Texas PAC", committee_type: "MPAC", amount: "5000.00",
    source_url: SOURCE_URL, industry_slug: null, classification_source: null, confidence: null, ...overrides };
}

function dbWithDonors(rows: unknown[]) {
  return { query: vi.fn(async (sql: string) => {
    if (sql.includes("tx_candidate_finance_pac_donors")) return { rows };
    if (sql.includes("tx_candidate_finance_summaries")) return { rows: [{
      candidate_id: CANDIDATE_ID, election_id: ELECTION_ID, election_year: 2026,
      committee_id: "00020971", total_receipts: "25000.00", direct_contribution_total: "25000.00",
      total_disbursements: "10000.00", cash_on_hand: "15000.00", outside_support_total: "35000.00",
      outside_oppose_total: "0.00", last_synced_at: "2026-10-11T10:00:00.000Z",
    }] };
    return { rows: [] };
  }) };
}

describe("texasBallotLookupFinanceLoader", () => {
  it.each(["Mayor", "Municipal Controller", "City Council Member"])(
    "does not query Texas TEC tables for Houston local finance office %s",
    async (officeCanonicalName) => {
    vi.stubEnv("TEXAS_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi.fn();

    const result = await loadTexasCandidateFinanceSummariesByCandidateElection(
      { query },
      [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID }],
      [{ election_id: ELECTION_ID, state: "TX", office_scope: "place", office_canonical_name: officeCanonicalName }]
    );

    expect(result.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
    }
  );

  it("renders unique typed TEC and out-of-state donors across active links without changing campaign totals", async () => {
    vi.stubEnv("TEXAS_CAMPAIGN_FINANCE_ENABLED", "true");
    const db = dbWithDonors([
      donor({ industry_slug: "beer_wine_and_spirits", classification_source: "manual", confidence: "low" }),
      donor({ committee_id: "fec:C00032979", committee_name: "DRIVE Committee", committee_type: "OOS_PAC",
        amount: "2500.00", industry_slug: "labor_unions", classification_source: "ai", confidence: "high" }),
      donor({ committee_id: "00099999", committee_name: "Future Texas PAC", committee_type: "GPAC", amount: "750.00",
        industry_slug: "technology", classification_source: "ai", confidence: "medium", source_url: null }),
      donor({ committee_id: "00022222", committee_name: "Another Candidate", committee_type: "COH", amount: "100000.00" }),
    ]);
    const result = await loadTexasCandidateFinanceSummariesByCandidateElection(db, candidates, elections);
    const summary = [...result.values()][0]!;
    expect(summary.direct_campaign.total_raised).toBe(25000);
    expect(summary.outside_spending.support_total).toBe(35000);
    expect(summary.direct_campaign.direct_coverage_note).toBe(
      "Regular TEC reports only; late pre-election reports are not included. Committee donors require a unique typed registry match or explicit out-of-state PAC identification."
    );
    expect(summary.outside_spending.outside_coverage_note).toBe(
      "Only current regular reports with one identified beneficiary and verified support or opposition are included. Shared expenses and campaign contributions are omitted."
    );
    expect(summary.direct_campaign.pac_money_by_interest).toEqual([
      { interest: "beer_wine_and_spirits", interest_name: "Beer, wine, and liquor", amount: 5000, pac_count: 1,
        pacs: [{ committee_id: "00015672", committee_name: "Wholesale Beer Distributors of Texas PAC", amount: 5000, source_url: SOURCE_URL }] },
      { interest: "labor_unions", interest_name: "Labor unions", amount: 2500, pac_count: 1,
        pacs: [{ committee_id: "fec:C00032979", committee_name: "DRIVE Committee", amount: 2500, source_url: SOURCE_URL }] },
      { interest: "unclassified", interest_name: "Not yet sorted", amount: 750, pac_count: 1,
        pacs: [{ committee_id: "00099999", committee_name: "Future Texas PAC", amount: 750, source_url: SOURCE_URL }] },
    ]);
    const pacQuery = db.query.mock.calls.find((call) => call[0].includes("tx_candidate_finance_pac_donors"))![0];
    expect(pacQuery).toContain("link.link_status = 'active'");
    expect(pacQuery).toContain("donor.election_year = link.election_year");
    expect(pacQuery).toContain("sum(donor.amount) AS amount");
    expect(pacQuery).toContain("GROUP BY selected.candidate_id, selected.election_id, donor.committee_id");
    expect(pacQuery).toContain("classification.label_type = 'committee'");
    expect(pacQuery).toContain("public.normalize_finance_label(grouped.committee_name)");
  });

  it("hides only trusted candidate and leadership interests while retaining unknowns and party groups", async () => {
    vi.stubEnv("TEXAS_CAMPAIGN_FINANCE_ENABLED", "true");
    const db = dbWithDonors([
      donor({ committee_id: "00011111", committee_name: "Source Alpha PAC", amount: "5000.00",
        industry_slug: "leadership_pacs", classification_source: "manual", confidence: "low" }),
      donor({ committee_id: "00022222", committee_name: "Source Beta PAC", amount: "2000.00",
        industry_slug: "candidate_committees", classification_source: "ai", confidence: "high" }),
      donor({ committee_id: "00033333", committee_name: "Source Gamma PAC", amount: "1000.00",
        industry_slug: "leadership_pacs", classification_source: "rule", confidence: "high" }),
      donor({ committee_id: "00044444", committee_name: "Source Delta PAC", amount: "750.00",
        industry_slug: "candidate_committees", classification_source: "rule", confidence: "low" }),
      donor({ committee_id: "00055555", committee_name: "Source Epsilon PAC", amount: "200.00" }),
      donor({ committee_id: "00066666", committee_name: "Source Party Committee", committee_type: "PTYCORP",
        amount: "300.00", industry_slug: "democratic_party_groups", classification_source: "manual", confidence: "high" }),
    ]);
    const result = await loadTexasCandidateFinanceSummariesByCandidateElection(db, candidates, elections);
    const summary = [...result.values()][0]!;
    expect(summary.direct_campaign.total_raised).toBe(25000);
    const interests = summary.direct_campaign.pac_money_by_interest!;
    expect(interests).toHaveLength(2);
    expect(interests[0]).toMatchObject({ interest: "unclassified", interest_name: "Not yet sorted", amount: 950, pac_count: 2 });
    expect(interests[0]!.pacs.map((pac) => pac.committee_id)).toEqual(["00044444", "00055555"]);
    expect(interests[1]).toMatchObject({ interest: "democratic_party_groups", amount: 300, pac_count: 1 });
    expect(interests[1]!.pacs[0]!.committee_id).toBe("00066666");
    expect(interests.some((entry) => ["leadership_pacs", "candidate_committees"].includes(entry.interest))).toBe(false);
  });

  it("computes full interest totals and committee counts before capping displayed donors", async () => {
    vi.stubEnv("TEXAS_CAMPAIGN_FINANCE_ENABLED", "true");
    const db = dbWithDonors(Array.from({ length: 7 }, (_, index) => donor({
      committee_id: String(10000000 + index), committee_name: `Unknown ${index} PAC`, amount: String(100 + index),
    })));
    const result = await loadTexasCandidateFinanceSummariesByCandidateElection(db, candidates, elections);
    const interests = [...result.values()][0]!.direct_campaign.pac_money_by_interest!;
    expect(interests).toHaveLength(1);
    expect(interests[0]).toMatchObject({ interest: "unclassified", amount: 721, pac_count: 7 });
    expect(interests[0]!.pacs).toHaveLength(5);
    expect(interests[0]!.pacs.map((pac) => pac.amount)).toEqual([106, 105, 104, 103, 102]);
  });

  it("retains all allowed TEC classes and defensively excludes former candidates and unknown entity types", async () => {
    vi.stubEnv("TEXAS_CAMPAIGN_FINANCE_ENABLED", "true");
    const allowed = ["GPAC", "MPAC", "SPAC", "JSPC", "SCPC", "CEC", "MCEC", "PTYCORP", "LEG", "OOS_PAC"];
    const excluded = ["ASIFSPAC", "COH", "JCOH", "SCC", "SPK", "DCE", "ENTITY", "UNKNOWN"];
    const db = dbWithDonors([...allowed, ...excluded].map((type, index) => donor({
      committee_id: String(10000000 + index), committee_name: `Unknown ${index} Committee`, committee_type: type, amount: "100.00",
    })));
    const result = await loadTexasCandidateFinanceSummariesByCandidateElection(db, candidates, elections);
    expect([...result.values()][0]!.direct_campaign.pac_money_by_interest![0]).toMatchObject({ amount: 1000, pac_count: 10 });
    const sql = db.query.mock.calls.find((call) => call[0].includes("tx_candidate_finance_pac_donors"))![0];
    for (const type of allowed) expect(sql).toContain(`'${type}'`);
    for (const type of excluded) expect(sql).not.toContain(`'${type}'`);
  });

  it("omits the PAC card when no stored positive typed donors exist", async () => {
    vi.stubEnv("TEXAS_CAMPAIGN_FINANCE_ENABLED", "true");
    const db = dbWithDonors([donor({ amount: "0.00" }), donor({ amount: "-1.00" })]);
    const result = await loadTexasCandidateFinanceSummariesByCandidateElection(db, candidates, elections);
    expect([...result.values()][0]!.direct_campaign).not.toHaveProperty("pac_money_by_interest");
  });

  // Regression guard for the schema drift where the outside-groups query
  // selected outside_group.expenditure_count, a column no migration ever
  // created for Texas (only the Tennessee table has it). Unit tests mock
  // db.query, so this cross-checks every column the query references
  // against the columns the migrations actually build.
  it("only references outside-group columns that the migrations create", async () => {
    vi.stubEnv("TEXAS_CAMPAIGN_FINANCE_ENABLED", "true");
    const queries: string[] = [];
    const query = vi.fn(async (sql: string) => {
      queries.push(sql);
      if (queries.length === 1) {
        return { rows: [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID }] };
      }
      return { rows: [] };
    });

    await loadTexasCandidateFinanceSummariesByCandidateElection(
      { query },
      [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID }],
      [{ election_id: ELECTION_ID, state: "TX", office_scope: "statewide", office_canonical_name: "Governor" }]
    );

    const outsideGroupSql = queries.find((sql) => sql.includes("tx_candidate_finance_outside_groups"));
    expect(outsideGroupSql).toBeDefined();

    const referencedColumns = new Set(
      [...outsideGroupSql!.matchAll(/outside_group\.([a-z_]+)/g)].map((match) => match[1])
    );
    expect(referencedColumns.size).toBeGreaterThan(0);

    const schemaColumns = migrationTableColumns("tx_candidate_finance_outside_groups");
    expect(schemaColumns.size).toBeGreaterThan(0);
    for (const column of referencedColumns) {
      expect(
        schemaColumns.has(column),
        `outside_group.${column} is not a column of tx_candidate_finance_outside_groups`
      ).toBe(true);
    }
  });
});
