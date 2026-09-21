import { afterEach, describe, expect, it, vi } from "vitest";

import { loadFecCandidateFinanceSummariesByCandidateElection } from "../../../src/pipeline/finance/fecBallotLookupFinanceLoader.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";

const candidateRows = [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID, fec_ids: ["H0XX01234"] }];
const electionRows = [
  {
    election_id: ELECTION_ID,
    election_date: "2026-11-03",
    race_type: "office" as const,
    district_type: "us_house" as const,
    discovery_contest_family: null,
  },
];

function summaryRow(contributorsSyncedAt: string | null) {
  return {
    candidate_id: CANDIDATE_ID,
    election_id: ELECTION_ID,
    fec_candidate_id: "H0XX01234",
    election_year: 2026,
    total_receipts: "100000.00",
    total_disbursements: "50000.00",
    cash_on_hand: "50000.00",
    debts_owed: "0.00",
    outside_support_total: null,
    outside_oppose_total: null,
    source_url: "https://www.fec.gov/data/candidate/H0XX01234/?cycle=2026",
    last_synced_at: "2026-09-20 00:00:00+00",
    contributors_synced_at: contributorsSyncedAt,
  };
}

function contributorRow(extra: Record<string, unknown>) {
  return { candidate_id: CANDIDATE_ID, election_id: ELECTION_ID, contribution_count: 2, ...extra };
}

describe("loadFecCandidateFinanceSummariesByCandidateElection conduit groups", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("adds the top conduit groups, without payment platforms, once the list was loaded", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [summaryRow("2026-09-20 00:00:00+00")] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          contributorRow({
            committee_id: "C00000021",
            committee_name: "CONDUIT GROUP A PAC",
            amount: "40000.00",
            source_url: "https://www.fec.gov/data/receipts/?contributor_name=C00000021",
          }),
          contributorRow({ committee_id: "C00000022", committee_name: "CONDUIT GROUP B PAC", amount: "40000.00", source_url: null }),
        ],
      });

    const result = await loadFecCandidateFinanceSummariesByCandidateElection({ query }, candidateRows, electionRows);
    const direct = [...result.values()][0]?.direct_campaign;

    expect(query).toHaveBeenCalledTimes(6);
    expect(String(query.mock.calls[5]?.[0])).toContain("public.candidate_finance_conduit_totals");
    expect(String(query.mock.calls[5]?.[0])).toContain("WHERE NOT conduit.is_payment_platform");
    expect(query.mock.calls[5]?.[1]?.[1]).toBe(5);
    expect(direct?.conduit_donations).toEqual([
      {
        committee_id: "C00000021",
        committee_name: "CONDUIT GROUP A PAC",
        amount: 40000,
        contribution_count: 2,
        source_url: "https://www.fec.gov/data/receipts/?contributor_name=C00000021",
      },
      {
        committee_id: "C00000022",
        committee_name: "CONDUIT GROUP B PAC",
        amount: 40000,
        contribution_count: 2,
        source_url: "https://www.fec.gov/data/",
      },
    ]);
    expect(direct).not.toHaveProperty("pac_donors");
  });

  it("leaves the lists out, and runs no extra queries, until they were loaded", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "true");
    const query = vi.fn().mockResolvedValueOnce({ rows: [summaryRow(null)] }).mockResolvedValue({ rows: [] });

    const result = await loadFecCandidateFinanceSummariesByCandidateElection({ query }, candidateRows, electionRows);
    const direct = [...result.values()][0]?.direct_campaign;

    expect(query).toHaveBeenCalledTimes(5);
    expect(direct).toBeDefined();
    expect(direct).not.toHaveProperty("conduit_donations");
  });
});
