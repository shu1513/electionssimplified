import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { candidateElectionKey } from "../../../src/pipeline/address/ballotLookupFinanceShared.js";
import { loadConnecticutCandidateFinanceSummariesByCandidateElection } from "../../../src/pipeline/connecticutFinance/connecticutBallotLookupFinanceLoader.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const KEY = candidateElectionKey(CANDIDATE_ID, ELECTION_ID);

const candidateRows = [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID }];
const electionRows = [{ election_id: ELECTION_ID, state: "CT" }];

function mockDb(input: { summaries: unknown[]; direct?: unknown[]; outside?: unknown[]; donors?: unknown[] }) {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM public.ct_candidate_finance_outside_groups") || sql.includes("AS outside_group")) {
        return { rows: input.outside ?? [] };
      }
      if (sql.includes("ct_candidate_finance_pac_donors")) return { rows: input.donors ?? [] };
      if (sql.includes("AS breakdown")) {
        return { rows: input.direct ?? [] };
      }
      return { rows: input.summaries };
    }),
  };
}

describe("connecticutBallotLookupFinanceLoader", () => {
  beforeEach(() => {
    vi.stubEnv("CONNECTICUT_CAMPAIGN_FINANCE_ENABLED", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns direct totals with outside totals, ranked groups, and the coverage note", async () => {
    const db = mockDb({
      summaries: [
        {
          candidate_id: CANDIDATE_ID,
          election_id: ELECTION_ID,
          committee_id: "14376",
          election_year: 2026,
          total_receipts: "350.00",
          total_disbursements: null,
          outside_support_total: "1250.50",
          outside_oppose_total: "0.00",
          source_url: "https://seec.ct.gov/portal/ecris/CurPreYears",
          last_synced_at: "2026-09-01 12:00:00+00",
        },
      ],
      direct: [
        {
          candidate_id: CANDIDATE_ID,
          election_id: ELECTION_ID,
          category_type: "occupation",
          category_name: "Attorney",
          amount: "200.00",
          contributor_count: "2",
          source_url: null,
        },
      ],
      outside: [
        {
          candidate_id: CANDIDATE_ID,
          election_id: ELECTION_ID,
          committee_id: "NUTMEG FORWARD",
          committee_name: "Nutmeg Forward",
          support_oppose: "support",
          amount: "1250.50",
          source_url: null,
        },
      ],
    });

    const result = await loadConnecticutCandidateFinanceSummariesByCandidateElection(db, candidateRows, electionRows);

    expect(db.query).toHaveBeenCalledTimes(4);
    const outsideSql = String(db.query.mock.calls[2]?.[0]);
    expect(outsideSql).toContain("JOIN public.ct_candidate_finance_links AS link");
    expect(outsideSql).toContain("JOIN public.ct_candidate_finance_outside_groups AS outside_group");
    expect(outsideSql).toContain("WHERE rn <= 5");
    expect(db.query.mock.calls[2]?.[1]).toEqual([JSON.stringify(candidateRows)]);
    expect(String(db.query.mock.calls[0]?.[0])).toContain("max(summary.outside_support_total) AS outside_support_total");

    const summary = result.get(KEY);
    expect(summary).toMatchObject({
      source: "CONNECTICUT_ECRIS",
      cycle: 2026,
      controlled_committee_id: "14376",
      direct_campaign: { total_raised: 350, total_spent: null },
      outside_spending: {
        support_total: 1250.5,
        oppose_total: 0,
        outside_coverage_note: expect.stringContaining("SEEC Form 40"),
        top_supporting_groups: [
          {
            committee_id: "NUTMEG FORWARD",
            committee_name: "Nutmeg Forward",
            support_oppose: "support",
            amount: 1250.5,
            source_url: "https://seec.ct.gov/eCrisReporting/SearchingIndependentExpenditure.aspx",
          },
        ],
        top_opposing_groups: [],
        top_supporting_industries: [],
        top_opposing_industries: [],
      },
    });
    expect(summary?.direct_campaign.top_occupations).toEqual([
      { category_name: "Attorney", amount: 200, contributor_count: 2, source_url: "https://seec.ct.gov/portal/ecris/CurPreYears" },
    ]);
  });

  it("reports null outside totals for candidates never synced with expenditure data", async () => {
    const db = mockDb({
      summaries: [
        {
          candidate_id: CANDIDATE_ID,
          election_id: ELECTION_ID,
          committee_id: "14376",
          election_year: 2026,
          total_receipts: "350.00",
          total_disbursements: null,
          outside_support_total: null,
          outside_oppose_total: null,
          source_url: null,
          last_synced_at: "2026-09-01 12:00:00+00",
        },
      ],
    });

    const result = await loadConnecticutCandidateFinanceSummariesByCandidateElection(db, candidateRows, electionRows);

    expect(result.get(KEY)?.outside_spending).toMatchObject({
      support_total: null,
      oppose_total: null,
      top_supporting_groups: [],
      top_opposing_groups: [],
    });
  });

  it("shows unsorted committees and excludes candidate/exploratory and ambiguous transfers", async () => {
    const donor = { candidate_id: CANDIDATE_ID, election_id: ELECTION_ID, committee_id: "X", committee_name: "Nutmeg Tomorrow", committee_type: null, amount: "125.50", source_url: null };
    const db = mockDb({
      summaries: [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID, election_year: 2026, total_receipts: "25175.50", source_url: null }],
      donors: [
        donor,
        { ...donor, committee_id: "101", committee_name: "Khan 2026", committee_type: "Exploratory Committee", amount: 20000 },
        { ...donor, committee_id: "102", committee_name: "Erin 2026", committee_type: "Candidate Committee", amount: 5000 },
        { ...donor, committee_id: "103", committee_name: "Shared Name", committee_type: "Ambiguous Committee", amount: 50 },
        { ...donor, committee_id: "104", committee_name: "Shore Winds, LLC", amount: 50 },
      ],
    });
    const result = await loadConnecticutCandidateFinanceSummariesByCandidateElection(db, candidateRows, electionRows);
    expect(result.get(KEY)?.direct_campaign.pac_money_by_interest).toEqual([{
      interest: "unclassified", interest_name: "Not yet sorted", amount: 125.5, pac_count: 1,
      pacs: [{ committee_id: "X", committee_name: "Nutmeg Tomorrow", amount: 125.5, source_url: "https://seec.ct.gov/portal/ecris/CurPreYears" }],
    }]);
    expect(result.get(KEY)?.direct_campaign.total_raised).toBe(25175.5);
    const sql = String(db.query.mock.calls[3]?.[0]);
    expect(sql).toContain("sum(donor.amount)");
    expect(sql).toContain("donor.election_year = link.election_year");
    expect(sql).toContain("link.link_status = 'active'");
  });

  it("keeps positively registered PACs even when their names have a business suffix", async () => {
    const db = mockDb({
      summaries: [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID, election_year: 2026, total_receipts: 50 }],
      donors: [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID, committee_id: "PAC", committee_name: "Nutmeg LLC", committee_type: "Political Committee", amount: 50, source_url: null }],
    });
    const result = await loadConnecticutCandidateFinanceSummariesByCandidateElection(db, candidateRows, electionRows);
    expect(result.get(KEY)?.direct_campaign.pac_money_by_interest?.[0]?.pacs[0]?.committee_name).toBe("Nutmeg LLC");
  });

  it("returns nothing when the module is disabled or no Connecticut election is requested", async () => {
    const db = mockDb({ summaries: [] });

    vi.stubEnv("CONNECTICUT_CAMPAIGN_FINANCE_ENABLED", "false");
    await expect(loadConnecticutCandidateFinanceSummariesByCandidateElection(db, candidateRows, electionRows)).resolves.toEqual(new Map());
    expect(db.query).not.toHaveBeenCalled();

    vi.stubEnv("CONNECTICUT_CAMPAIGN_FINANCE_ENABLED", "true");
    await expect(
      loadConnecticutCandidateFinanceSummariesByCandidateElection(db, candidateRows, [{ election_id: ELECTION_ID, state: "MA" }])
    ).resolves.toEqual(new Map());
    expect(db.query).not.toHaveBeenCalled();
  });
});
