import { afterEach, describe, expect, it, vi } from "vitest";

import { candidateElectionKey } from "../../../src/pipeline/address/ballotLookupFinanceShared.js";
import { loadDenverCandidateFinanceSummariesByCandidateElection } from "../../../src/pipeline/denverFinance/denverBallotLookupFinanceLoader.js";

const KEY = candidateElectionKey("c", "e");

afterEach(() => vi.unstubAllEnvs());

const DENVER_ATLARGE_ELECTION = {
  election_id: "e",
  state: "CO",
  district_type: "place",
  geoid_compact: "0820000",
  office_scope: "place",
  office_canonical_name: "City Council Member",
};

function summaryRow(over: Record<string, unknown> = {}) {
  return {
    candidate_id: "c",
    election_id: "e",
    committee_id: "658",
    election_year: 2026,
    total_receipts: "200.00",
    direct_contribution_total: "150.00",
    total_disbursements: "120.00",
    cash_on_hand: "-7.38",
    loans_received: "5.00",
    public_funds_received: "50.00",
    outside_support_total: "30.00",
    outside_oppose_total: "10.00",
    source_url: "https://denver.maplight.com",
    last_synced_at: "2026-09-15",
    ...over,
  };
}

describe("Denver ballot finance loader", () => {
  it("publishes loans and Fair Elections Fund matching as their own stats", async () => {
    vi.stubEnv("DENVER_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [summaryRow()] })
      .mockResolvedValue({ rows: [] });
    const result = await loadDenverCandidateFinanceSummariesByCandidateElection(
      { query } as never,
      [{ candidate_id: "c", election_id: "e" }],
      [DENVER_ATLARGE_ELECTION],
    );
    expect(result.get(KEY)?.direct_campaign).toMatchObject({
      total_raised: 150,
      loans_received: 5,
      public_funds_received: 50,
    });
    // Both columns must be selected, or the payload silently reads null.
    const summarySql = String(query.mock.calls[0]?.[0]);
    expect(summarySql).toContain("AS loans_received");
    expect(summarySql).toContain("AS public_funds_received");
  });

  it("maps a snapshot with the filer identity and the always-on FEF note", async () => {
    vi.stubEnv("DENVER_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [summaryRow()] })
      .mockResolvedValue({ rows: [] });
    const result = await loadDenverCandidateFinanceSummariesByCandidateElection(
      { query } as never,
      [{ candidate_id: "c", election_id: "e" }],
      [DENVER_ATLARGE_ELECTION],
    );
    expect(result.get(KEY)).toMatchObject({
      source: "DENVER_CLERK_RECORDER",
      cycle: 2026,
      controlled_committee_id: "658",
      direct_campaign: {
        // The standard loader prefers the private-only direct figure; the
        // note explains why spending can exceed it (FEF public matching).
        total_raised: 150,
        total_spent: 120,
        cash_on_hand: -7.38,
        direct_coverage_note: expect.stringContaining("Fair Elections Fund"),
      },
      outside_spending: {
        support_total: 30,
        oppose_total: 10,
      },
    });
    // The summary/outside SQL must run over the Denver identity columns.
    expect(String(query.mock.calls[0]?.[0])).toContain("link.filer_id");
    expect(String(query.mock.calls[2]?.[0])).toContain("spender_id");
  });

  it("does no DB work for a non-Denver Colorado election", async () => {
    vi.stubEnv("DENVER_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi.fn();
    const result = await loadDenverCandidateFinanceSummariesByCandidateElection(
      { query } as never,
      [{ candidate_id: "c", election_id: "e" }],
      [{ ...DENVER_ATLARGE_ELECTION, geoid_compact: "0801090" }],
    );
    expect(result.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("does no DB work when the master flag is off", async () => {
    vi.stubEnv("DENVER_CAMPAIGN_FINANCE_ENABLED", "false");
    const query = vi.fn();
    const result = await loadDenverCandidateFinanceSummariesByCandidateElection(
      { query } as never,
      [{ candidate_id: "c", election_id: "e" }],
      [DENVER_ATLARGE_ELECTION],
    );
    expect(result.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

it("requires the explicit committee reader gate under the Denver master flag", async () => {
 vi.stubEnv("DENVER_CAMPAIGN_FINANCE_ENABLED","true");vi.stubEnv("DENVER_REPORTED_COMMITTEE_CASH_ENABLED","true");
 const query=vi.fn().mockResolvedValueOnce({rows:[summaryRow()]}).mockResolvedValue({rows:[]});
 await loadDenverCandidateFinanceSummariesByCandidateElection({query} as never,[{candidate_id:"c",election_id:"e"}],[DENVER_ATLARGE_ELECTION]);
 expect(query.mock.calls.filter(c=>String(c[0]).includes("JOIN public.denver_candidate_finance_pac_sources"))).toHaveLength(1);
 query.mockClear();vi.stubEnv("DENVER_CAMPAIGN_FINANCE_ENABLED","false");await loadDenverCandidateFinanceSummariesByCandidateElection({query} as never,[{candidate_id:"c",election_id:"e"}],[DENVER_ATLARGE_ELECTION]);expect(query).not.toHaveBeenCalled();
});
