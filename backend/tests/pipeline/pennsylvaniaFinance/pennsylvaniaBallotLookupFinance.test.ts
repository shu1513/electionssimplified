import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isPennsylvaniaCandidateCommitteeName,
  loadPennsylvaniaCandidateFinanceSummariesByCandidateElection,
} from "../../../src/pipeline/pennsylvaniaFinance/pennsylvaniaBallotLookupFinance.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("pennsylvaniaBallotLookupFinance", () => {
  it("loads PA ballot lookup finance summaries from PA-owned tables", async () => {
    vi.stubEnv("PENNSYLVANIA_CAMPAIGN_FINANCE_ENABLED", "true");
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              candidate_id: CANDIDATE_ID,
              election_id: ELECTION_ID,
              committee_id: "PA-FILER-123",
              election_year: 2026,
              total_receipts: "12500.00",
              direct_contribution_total: "12500.00",
              total_disbursements: "3000.00",
              cash_on_hand: "9500.00",
              outside_support_total: "12000.00",
              outside_oppose_total: "7000.00",
              source_url: "https://pa.example/source",
              last_synced_at: "2026-01-02T03:04:05.000Z",
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              candidate_id: CANDIDATE_ID,
              election_id: ELECTION_ID,
              category_type: "occupation",
              category_name: "Attorney",
              amount: "5000.00",
              contributor_count: "4",
              source_url: "https://pa.example/direct",
            },
            {
              candidate_id: CANDIDATE_ID,
              election_id: ELECTION_ID,
              category_type: "contribution_size",
              category_name: "$250.01-$1,000",
              amount: "6000.00",
              contributor_count: "5",
              source_url: "https://pa.example/direct",
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              candidate_id: CANDIDATE_ID,
              election_id: ELECTION_ID,
              committee_id: "PAF-001",
              committee_name: "Pennsylvanians for Action",
              support_oppose: "support",
              amount: "12000.00",
              source_url: "https://pa.example/ie-support",
            },
            {
              candidate_id: CANDIDATE_ID,
              election_id: ELECTION_ID,
              committee_id: "PAF-002",
              committee_name: "Citizens Opposed to Keystone",
              support_oppose: "oppose",
              amount: "7000.00",
              source_url: "https://pa.example/ie-oppose",
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              candidate_id: CANDIDATE_ID,
              election_id: ELECTION_ID,
              support_oppose: "support",
              category_name: "education",
              amount: "8000.00",
              contributor_count: "2",
              source_url: "https://pa.example/outside-support",
            },
            {
              candidate_id: CANDIDATE_ID,
              election_id: ELECTION_ID,
              support_oppose: "oppose",
              category_name: "fossil_fuels",
              amount: "5000.00",
              contributor_count: "1",
              source_url: "https://pa.example/outside-oppose",
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              candidate_id: CANDIDATE_ID,
              election_id: ELECTION_ID,
              industry_name: "education",
              committee_id: "PAF-001",
              committee_name: "Pennsylvanians for Action",
              support_oppose: "support",
              organization_name: "Pennsylvania State Education Association",
              amount: "6000.00",
              contributor_count: "1",
              source_url: "https://pa.example/outside-support",
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            // One row per committee (the query merges the candidate's links), largest first.
            { candidate_id: CANDIDATE_ID, election_id: ELECTION_ID, committee_id: "7001", committee_name: "Greater PA Carpenters PAC", amount: "1500.00", source_url: null },
            { candidate_id: CANDIDATE_ID, election_id: ELECTION_ID, committee_id: "DEMOCRATIC GOVERNORS ASSOCIATION", committee_name: "Democratic Governors Association", amount: "1000.00", source_url: "https://pa.example/2026.zip" },
            { candidate_id: CANDIDATE_ID, election_id: ELECTION_ID, committee_id: "7003", committee_name: "Pennsylvania Association of Realtors PAC", amount: "500.00", source_url: null },
            // Other candidates' committees, recognised by name: never listed.
            { candidate_id: CANDIDATE_ID, election_id: ELECTION_ID, committee_id: "7002", committee_name: "Friends of Kim Ward", amount: "250.00", source_url: null },
            { candidate_id: CANDIDATE_ID, election_id: ELECTION_ID, committee_id: "7004", committee_name: "Santarsiero for State Senate", amount: "200.00", source_url: null },
          ],
        }),
    };

    const result = await loadPennsylvaniaCandidateFinanceSummariesByCandidateElection({
      db,
      candidateRows: [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID }],
      electionRows: [{ election_id: ELECTION_ID, state: "PA" }],
    });

    const summary = result.get(`${CANDIDATE_ID}\u0000${ELECTION_ID}`);
    expect(summary).toMatchObject({
      source: "PENNSYLVANIA_DOS",
      cycle: 2026,
      controlled_committee_id: "PA-FILER-123",
      direct_campaign: {
        total_raised: 12500,
        top_occupations: [{ category_name: "Attorney", amount: 5000, contributor_count: 4 }],
        contribution_size_buckets: [{ category_name: "$250.01-$1,000", amount: 6000, contributor_count: 5 }],
        // The name rules sort none of these (they only know exact
        // occupation words), so all stay under one "Not yet sorted" row.
        pac_money_by_interest: [
          {
            interest: "unclassified",
            interest_name: "Not yet sorted",
            amount: 3000,
            pac_count: 3,
            pacs: [
              {
                committee_id: "7001",
                committee_name: "Greater PA Carpenters PAC",
                amount: 1500,
                source_url: "https://www.pa.gov/agencies/dos/resources/voting-and-elections-resources/campaign-finance-data",
              },
              { committee_id: "DEMOCRATIC GOVERNORS ASSOCIATION", committee_name: "Democratic Governors Association", amount: 1000, source_url: "https://pa.example/2026.zip" },
              {
                committee_id: "7003",
                committee_name: "Pennsylvania Association of Realtors PAC",
                amount: 500,
                source_url: "https://www.pa.gov/agencies/dos/resources/voting-and-elections-resources/campaign-finance-data",
              },
            ],
          },
        ],
      },
      outside_spending: {
        support_total: 12000,
        oppose_total: 7000,
        top_supporting_groups: [{ committee_name: "Pennsylvanians for Action", amount: 12000 }],
        top_opposing_groups: [{ committee_name: "Citizens Opposed to Keystone", amount: 7000 }],
        top_supporting_industries: [{ category_name: "education", amount: 8000 }],
        top_opposing_industries: [{ category_name: "fossil_fuels", amount: 5000 }],
      },
      backing_summary: {
        top_direct_donor_occupations: [{ category_name: "Attorney", amount: 5000, contributor_count: 4 }],
        top_outside_supporting_industries: [
          {
            category_name: "education",
            supporting_organizations: [
              {
                organization_name: "Pennsylvania State Education Association",
                committee_name: "Pennsylvanians for Action",
                amount: 6000,
              },
            ],
          },
        ],
      },
    });
    expect(String(db.query.mock.calls[0]?.[0])).toContain("FROM requested");
    expect(String(db.query.mock.calls[0]?.[0])).toContain("public.pa_candidate_finance_links");
    // Committee donors are merged across the candidate's links, one row per committee.
    const pacSql = String(db.query.mock.calls[5]?.[0]);
    expect(pacSql).toContain("public.pa_candidate_finance_pac_donors");
    expect(pacSql).toContain("GROUP BY selected.candidate_id, selected.election_id, donor.committee_id");
    expect(pacSql).toContain("sum(donor.amount)");
    expect(pacSql).not.toContain("finance_pac_interests");
  });

  it("recognises other candidates' committees by name but keeps PACs named like them", () => {
    for (const name of ["Friends of Kim Ward", "COMMITTEE TO ELECT JIM BREWSTER", "Citizens for Hughes", "Santarsiero for State Senate", "WHEELER FOR PA", "Joe Khan for DA", "Rapp for Rep. Committee", "Gainey for Mayor"]) {
      expect(isPennsylvaniaCandidateCommitteeName(name), name).toBe(true);
    }
    for (const name of ["Friends of Teamsters 397 PAC Fund", "Citizens for Prosperity in America Today PAC", "Operators for Skill PAC", "Alliance for a Better Pennsylvania", "Greater PA Carpenters PAC", "Democratic Governors Association"]) {
      expect(isPennsylvaniaCandidateCommitteeName(name), name).toBe(false);
    }
  });

  it("stays quiet when PA finance is disabled", async () => {
    const db = { query: vi.fn() };

    const result = await loadPennsylvaniaCandidateFinanceSummariesByCandidateElection({
      db,
      candidateRows: [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID }],
      electionRows: [{ election_id: ELECTION_ID, state: "PA" }],
    });

    expect(result.size).toBe(0);
    expect(db.query).not.toHaveBeenCalled();
  });
});
