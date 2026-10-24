import { isAustinReportedCommitteeCashEnabled } from "../../../src/config/featureFlags.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { candidateElectionKey } from "../../../src/pipeline/address/ballotLookupFinanceShared.js";
import { loadAustinCandidateFinanceSummariesByCandidateElection } from "../../../src/pipeline/austinFinance/austinBallotLookupFinanceLoader.js";

const KEY = candidateElectionKey("c", "e");

afterEach(() => vi.unstubAllEnvs());

const AUSTIN_COUNCIL_ELECTION = {
  election_id: "e",
  state: "TX",
  district_type: "place",
  geoid_compact: "4805000",
  office_scope: "place",
  office_canonical_name: "City Council Member",
};

function summaryRow(over: Record<string, unknown> = {}) {
  return {
    candidate_id: "c",
    election_id: "e",
    committee_id: "QADRI ZOHAIB",
    election_year: 2026,
    total_receipts: "64538.00",
    direct_contribution_total: "64538.00",
    total_disbursements: "45387.62",
    cash_on_hand: "181776.50",
    outside_support_total: "12000.00",
    outside_oppose_total: "0.00",
    source_url: "https://data.austintexas.gov/d/b2pc-2s8n",
    last_synced_at: "2026-09-15",
    ...over,
  };
}

describe("Austin ballot finance loader", () => {
  it("maps a snapshot with the filer-key identity and the outside coverage note", async () => {
    vi.stubEnv("AUSTIN_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [summaryRow()] })
      .mockResolvedValue({ rows: [] });
    const result = await loadAustinCandidateFinanceSummariesByCandidateElection(
      { query } as never,
      [{ candidate_id: "c", election_id: "e" }],
      [AUSTIN_COUNCIL_ELECTION],
    );
    expect(result.get(KEY)).toMatchObject({
      source: "AUSTIN_CITY_CLERK",
      cycle: 2026,
      controlled_committee_id: "QADRI ZOHAIB",
      direct_campaign: {
        total_raised: 64538,
        total_spent: 45387.62,
        cash_on_hand: 181776.5,
      },
      outside_spending: {
        support_total: 12000,
        oppose_total: 0,
        outside_coverage_note: expect.stringContaining("declared support or opposition"),
      },
    });
    // The summary/outside SQL must run over the Austin identity columns and tables.
    const summarySql = String(query.mock.calls[0]?.[0]);
    expect(summarySql).toContain("link.filer_key");
    expect(summarySql).toContain("atx_candidate_finance_links");
    expect(String(query.mock.calls[2]?.[0])).toContain("spender_key");
  });

  it("does no DB work for a non-Austin Texas place election", async () => {
    vi.stubEnv("AUSTIN_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi.fn();
    // Houston's place row.
    const result = await loadAustinCandidateFinanceSummariesByCandidateElection(
      { query } as never,
      [{ candidate_id: "c", election_id: "e" }],
      [{ ...AUSTIN_COUNCIL_ELECTION, geoid_compact: "4835000" }],
    );
    expect(result.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("does no DB work when the master flag is off", async () => {
    vi.stubEnv("AUSTIN_CAMPAIGN_FINANCE_ENABLED", "false");
    const query = vi.fn();
    const result = await loadAustinCandidateFinanceSummariesByCandidateElection(
      { query } as never,
      [{ candidate_id: "c", election_id: "e" }],
      [AUSTIN_COUNCIL_ELECTION],
    );
    expect(result.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});


describe("Austin committee cash publication gate", () => {
  it("is default-off and remains under the source master flag", () => {
    vi.stubEnv("AUSTIN_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("AUSTIN_REPORTED_COMMITTEE_CASH_ENABLED", undefined);
    expect(isAustinReportedCommitteeCashEnabled()).toBe(false);
    vi.stubEnv("AUSTIN_REPORTED_COMMITTEE_CASH_ENABLED", "true");
    expect(isAustinReportedCommitteeCashEnabled()).toBe(true);
    vi.stubEnv("AUSTIN_CAMPAIGN_FINANCE_ENABLED", "false");
    expect(isAustinReportedCommitteeCashEnabled()).toBe(false);
  });
});
