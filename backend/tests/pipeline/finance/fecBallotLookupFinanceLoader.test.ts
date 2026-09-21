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
  return { candidate_id: CANDIDATE_ID, election_id: ELECTION_ID, contribution_count: 2, total_rows: "74", ...extra };
}

describe("loadFecCandidateFinanceSummariesByCandidateElection committee donors and conduits", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("adds capped donor and conduit lists with their full counts once the lists were loaded", async () => {
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
            committee_id: "C00000011",
            committee_name: "UNITED WORKERS UNION PAC",
            connected_organization: "UNITED WORKERS UNION",
            amount: "10000.00",
            source_url: "https://www.fec.gov/data/disbursements/?committee_id=C00000011",
          }),
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          contributorRow({
            committee_id: "C00000031",
            committee_name: "DONATION PLATFORM",
            is_payment_platform: true,
            amount: "250000.00",
            source_url: null,
            total_rows: "1",
          }),
        ],
      });

    const result = await loadFecCandidateFinanceSummariesByCandidateElection({ query }, candidateRows, electionRows);
    const direct = [...result.values()][0]?.direct_campaign;

    expect(String(query.mock.calls[5]?.[0])).toContain("public.candidate_finance_pac_donors");
    expect(String(query.mock.calls[6]?.[0])).toContain("public.candidate_finance_conduit_totals");
    expect(query.mock.calls[5]?.[1]?.[1]).toBe(50);
    expect(direct?.pac_donors).toEqual([
      {
        committee_id: "C00000011",
        committee_name: "UNITED WORKERS UNION PAC",
        connected_organization: "UNITED WORKERS UNION",
        amount: 10000,
        contribution_count: 2,
        source_url: "https://www.fec.gov/data/disbursements/?committee_id=C00000011",
      },
    ]);
    expect(direct?.pac_donor_count).toBe(74);
    expect(direct?.conduit_donations).toEqual([
      {
        committee_id: "C00000031",
        committee_name: "DONATION PLATFORM",
        is_payment_platform: true,
        amount: 250000,
        contribution_count: 2,
        source_url: "https://www.fec.gov/data/",
      },
    ]);
    expect(direct?.conduit_donation_count).toBe(1);
  });

  it("leaves the lists out, and runs no extra queries, until they were loaded", async () => {
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED", "true");
    const query = vi.fn().mockResolvedValueOnce({ rows: [summaryRow(null)] }).mockResolvedValue({ rows: [] });

    const result = await loadFecCandidateFinanceSummariesByCandidateElection({ query }, candidateRows, electionRows);
    const direct = [...result.values()][0]?.direct_campaign;

    expect(query).toHaveBeenCalledTimes(5);
    expect(direct).toBeDefined();
    expect(direct).not.toHaveProperty("pac_donors");
    expect(direct).not.toHaveProperty("conduit_donations");
  });
});
