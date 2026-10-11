import { afterEach, describe, expect, it, vi } from "vitest";

import { migrationTableColumns } from "../../helpers/migrationTableColumns.js";
import { loadArkansasCandidateFinanceSummariesByCandidateElection } from "../../../src/pipeline/arkansasFinance/arkansasBallotLookupFinanceLoader.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const ELECTION = {
  election_id: ELECTION_ID,
  state: "AR",
  office_scope: "state_lower",
  office_canonical_name: "State Lower Chamber Legislator",
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("arkansasBallotLookupFinanceLoader", () => {
  it("stays inert when disabled or the election is not an eligible office", async () => {
    const query = vi.fn();
    const candidates = [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID }];

    expect(await loadArkansasCandidateFinanceSummariesByCandidateElection({ query }, candidates, [ELECTION])).toEqual(
      new Map()
    );

    vi.stubEnv("ARKANSAS_CAMPAIGN_FINANCE_ENABLED", "true");
    expect(
      await loadArkansasCandidateFinanceSummariesByCandidateElection({ query }, candidates, [
        { ...ELECTION, office_scope: "county", office_canonical_name: "County Judge" },
      ])
    ).toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
  });

  it("publishes registration totals, occupations, size buckets, and both coverage notes", async () => {
    vi.stubEnv("ARKANSAS_CAMPAIGN_FINANCE_ENABLED", "true");
    const queries: string[] = [];
    const query = vi.fn(async (sql: string) => {
      queries.push(sql);
      if (queries.length === 1) {
        return {
          rows: [
            {
              candidate_id: CANDIDATE_ID,
              election_id: ELECTION_ID,
              committee_id: "7968",
              election_year: 2026,
              total_receipts: "15800.00",
              direct_contribution_total: "15800.00",
              total_disbursements: "32541.03",
              cash_on_hand: "-1063.11",
              outside_support_total: null,
              outside_oppose_total: null,
              source_url: "https://ethics-disclosures.sos.arkansas.gov/",
              last_synced_at: "2026-09-02T12:00:00.000Z",
            },
          ],
        };
      }
      if (queries.length === 2) {
        return {
          rows: [
            {
              candidate_id: CANDIDATE_ID,
              election_id: ELECTION_ID,
              category_type: "occupation",
              category_name: "Retired",
              amount: "1500.00",
              contributor_count: "3",
              source_url: "https://ethics-disclosures.sos.arkansas.gov/",
            },
            {
              candidate_id: CANDIDATE_ID,
              election_id: ELECTION_ID,
              category_type: "contribution_size",
              category_name: "$500-$999",
              amount: "1500.00",
              contributor_count: "3",
              source_url: "https://ethics-disclosures.sos.arkansas.gov/",
            },
          ],
        };
      }
      return { rows: [] };
    });

    const result = await loadArkansasCandidateFinanceSummariesByCandidateElection(
      { query },
      [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID }],
      [ELECTION]
    );

    expect(query).toHaveBeenCalledTimes(6);
    const summary = result.get(`${CANDIDATE_ID}\u0000${ELECTION_ID}`);
    expect(summary).toMatchObject({
      source: "ARKANSAS_CFIS",
      cycle: 2026,
      controlled_committee_id: "7968",
      direct_campaign: {
        total_raised: 15_800,
        total_spent: 32_541.03,
        cash_on_hand: -1_063.11,
        top_occupations: [
          {
            category_name: "Retired",
            amount: 1_500,
            contributor_count: 3,
            source_url: "https://ethics-disclosures.sos.arkansas.gov/",
          },
        ],
        top_employers: [],
        top_industries: [],
        contribution_size_buckets: [
          {
            category_name: "$500-$999",
            amount: 1_500,
            contributor_count: 3,
            source_url: "https://ethics-disclosures.sos.arkansas.gov/",
          },
        ],
      },
      outside_spending: {
        support_total: null,
        oppose_total: null,
        top_supporting_groups: [],
        top_opposing_groups: [],
      },
      backing_summary: {
        top_direct_donor_occupations: [{ category_name: "Retired" }],
      },
    });
    expect(summary?.direct_campaign.direct_coverage_note).toContain("registration figures");
    expect(summary?.outside_spending.outside_coverage_note).toContain("unavailable rather than zero");

    const [summarySql, directSql, outsideGroupSql] = queries;
    expect(summarySql).toContain("public.ar_candidate_finance_links");
    expect(summarySql).toContain("count(DISTINCT link.filing_entity_id)");
    expect(directSql).toContain("breakdown.category_type IN ('occupation', 'contribution_size')");
    expect(outsideGroupSql).toContain("outside_group.filing_entity_id AS committee_id");
    expect(outsideGroupSql).toContain("min(outside_group.filer_name) AS committee_name");
  });

  it("sums all typed PAC donors before display caps and keeps partial outside totals unknown", async () => {
    vi.stubEnv("ARKANSAS_CAMPAIGN_FINANCE_ENABLED", "true");
    const donor = (id: number) => ({
      candidate_id: CANDIDATE_ID, election_id: ELECTION_ID, committee_id: `reported:ZETA ${id}`,
      committee_name: `Zeta ${id}`, committee_type: "Political Action Committee", amount: "100.25",
      source_url: "https://ethics-disclosures.sos.arkansas.gov/public/cf/candidateprofile?guid=receiver&tabName=TCON",
      industry_slug: "construction", classification_source: "rule", confidence: "low",
    });
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("ar_candidate_finance_pac_donors")) {
        return { rows: [...Array.from({ length: 7 }, (_, id) => donor(id)),
          { ...donor(8), committee_type: "Business", amount: "9000" },
          { ...donor(9), amount: "0" }] };
      }
      if (sql.includes("count(DISTINCT link.filing_entity_id)")) return { rows: [{
        candidate_id: CANDIDATE_ID, election_id: ELECTION_ID, committee_id: "7243", election_year: 2026,
        total_receipts: "80412", direct_contribution_total: "80412", total_disbursements: "1000",
        cash_on_hand: "79412", outside_support_total: null, outside_oppose_total: null,
        source_url: "https://ethics-disclosures.sos.arkansas.gov/", last_synced_at: "2026-10-11T12:00:00Z",
      }] };
      if (sql.includes("outside_group.filing_entity_id AS committee_id")) return { rows: [{
        candidate_id: CANDIDATE_ID, election_id: ELECTION_ID, committee_id: "1085", committee_name: "NRA IEF",
        support_oppose: "support", amount: "145.47", expenditure_count: "2", source_url: null,
      }] };
      return { rows: [] };
    });
    const summaries = await loadArkansasCandidateFinanceSummariesByCandidateElection({ query }, [
      { candidate_id: CANDIDATE_ID, election_id: ELECTION_ID },
    ], [ELECTION]);
    const summary = summaries.get(`${CANDIDATE_ID}\u0000${ELECTION_ID}`)!;
    expect(summary.direct_campaign.total_raised).toBe(80412);
    expect(summary.direct_campaign.pac_money_by_interest).toHaveLength(1);
    expect(summary.direct_campaign.pac_money_by_interest![0]).toMatchObject({
      interest_name: "Not yet sorted", amount: 701.75, pac_count: 7,
    });
    expect(summary.direct_campaign.pac_money_by_interest![0]!.pacs).toHaveLength(5);
    expect(summary.direct_campaign.pac_money_by_interest![0]!.pacs[0]!.source_url).toContain("tabName=TCON");
    expect(summary.outside_spending).toMatchObject({ support_total: null, oppose_total: null,
      top_supporting_groups: [{ amount: 145.47, committee_id: "1085" }] });
    const pacCall = query.mock.calls.find(([sql]) => sql.includes("ar_candidate_finance_pac_donors"))!;
    expect(pacCall[0]).toContain("max(donor.amount)");
    expect(pacCall[0]).toContain("link.filing_entity_id, donor.committee_id");
    expect(pacCall[0]).toContain("donor.election_year = link.election_year");
  });

  it("honors manual classifications, rejects low-confidence stored guesses and scopes PAC queries to returned summaries", async () => {
    vi.stubEnv("ARKANSAS_CAMPAIGN_FINANCE_ENABLED", "true");
    const otherCandidate = "33333333-3333-4333-8333-333333333333";
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("ar_candidate_finance_pac_donors")) {
        expect(params).toEqual([JSON.stringify([{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID }])]);
        return { rows: [
          { candidate_id: CANDIDATE_ID, election_id: ELECTION_ID, committee_id: "registry:1",
            committee_name: "Zeta Committee", committee_type: "Political Action Committee", amount: 500,
            source_url: null, industry_slug: "construction", classification_source: "manual", confidence: "low" },
          { candidate_id: CANDIDATE_ID, election_id: ELECTION_ID, committee_id: "registry:2",
            committee_name: "Theta Committee", committee_type: "Political Action Committee", amount: 250,
            source_url: null, industry_slug: "construction", classification_source: "ai", confidence: "low" },
        ] };
      }
      if (sql.includes("count(DISTINCT link.filing_entity_id)")) return { rows: [{
        candidate_id: CANDIDATE_ID, election_id: ELECTION_ID, committee_id: "7243", election_year: 2026,
        total_receipts: "1000", outside_support_total: null, outside_oppose_total: null,
      }] };
      return { rows: [] };
    });
    const summary = (await loadArkansasCandidateFinanceSummariesByCandidateElection({ query }, [
      { candidate_id: CANDIDATE_ID, election_id: ELECTION_ID },
      { candidate_id: otherCandidate, election_id: ELECTION_ID },
    ], [ELECTION])).get(`${CANDIDATE_ID}\u0000${ELECTION_ID}`)!;
    const interests = summary.direct_campaign.pac_money_by_interest!;
    expect(interests.find(group => group.interest === "construction")).toMatchObject({ amount: 500, pac_count: 1 });
    expect(interests.find(group => group.interest_name === "Not yet sorted")).toMatchObject({ amount: 250, pac_count: 1 });
  });

  it("references only AR outside-group columns created by migrations", async () => {
    vi.stubEnv("ARKANSAS_CAMPAIGN_FINANCE_ENABLED", "true");
    const queries: string[] = [];
    const query = vi.fn(async (sql: string) => {
      queries.push(sql);
      return {
        rows: queries.length === 1 ? [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID, election_year: 2026 }] : [],
      };
    });

    await loadArkansasCandidateFinanceSummariesByCandidateElection(
      { query },
      [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID }],
      [ELECTION]
    );

    const outsideGroupSql = queries.find((sql) => sql.includes("ar_candidate_finance_outside_groups"));
    expect(outsideGroupSql).toBeDefined();
    const referencedColumns = new Set([...outsideGroupSql!.matchAll(/outside_group\.([a-z_]+)/g)].map((match) => match[1]));
    const schemaColumns = migrationTableColumns("ar_candidate_finance_outside_groups");
    expect(referencedColumns.size).toBeGreaterThan(0);
    expect(schemaColumns.size).toBeGreaterThan(0);
    for (const column of referencedColumns) {
      expect(schemaColumns.has(column!), `column ${column} missing from migrations`).toBe(true);
    }
  });
});
