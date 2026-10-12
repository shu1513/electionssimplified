import { afterEach, describe, expect, it, vi } from "vitest";

import { loadKansasCandidateFinanceSummariesByCandidateElection } from "../../../src/pipeline/kansasFinance/kansasBallotLookupFinanceLoader.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const FILER_KEY = "2026::SMITH JANE:GOVERNOR";
const ELECTION = {
  election_id: ELECTION_ID,
  state: "KS",
  office_scope: "statewide",
  office_canonical_name: "Governor",
} as const;

function summaryRow(overrides: Record<string, unknown>) {
  return {
    candidate_id: CANDIDATE_ID,
    election_id: ELECTION_ID,
    committee_id: FILER_KEY,
    election_year: 2026,
    total_receipts: "125000.00",
    direct_contribution_total: "120000.00",
    total_disbursements: "40000.00",
    cash_on_hand: "85000.00",
    outside_support_total: null,
    outside_oppose_total: null,
    source_url:
      "https://sos.ks.gov/elections/cfr_viewer/cfr_examiner_entry.aspx",
    last_synced_at: "2026-09-05T12:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("kansasBallotLookupFinanceLoader", () => {
  it("stays inert when disabled or the election office is out of scope", async () => {
    vi.stubEnv("KANSAS_CAMPAIGN_FINANCE_ENABLED", "false");
    const query = vi.fn();
    const candidates = [
      { candidate_id: CANDIDATE_ID, election_id: ELECTION_ID },
    ];

    expect(
      await loadKansasCandidateFinanceSummariesByCandidateElection(
        { query },
        candidates,
        [ELECTION],
      ),
    ).toEqual(new Map());

    vi.stubEnv("KANSAS_CAMPAIGN_FINANCE_ENABLED", "true");
    expect(
      await loadKansasCandidateFinanceSummariesByCandidateElection(
        { query },
        candidates,
        [
          {
            ...ELECTION,
            office_scope: "county",
            office_canonical_name: "County Commissioner",
          },
        ],
      ),
    ).toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
  });

  it("publishes cover totals, occupations, size buckets, and the coverage note from ks_ tables", async () => {
    vi.stubEnv("KANSAS_CAMPAIGN_FINANCE_ENABLED", "true");
    const queries: string[] = [];
    const query = vi.fn(async (sql: string) => {
      queries.push(sql);
      if (queries.length === 1) {
        return { rows: [summaryRow({})] };
      }
      if (queries.length === 2) {
        return {
          rows: [
            {
              candidate_id: CANDIDATE_ID,
              election_id: ELECTION_ID,
              category_type: "occupation",
              category_name: "Attorney",
              amount: "5000.00",
              contributor_count: 4,
              source_url: null,
            },
            {
              candidate_id: CANDIDATE_ID,
              election_id: ELECTION_ID,
              category_type: "contribution_size",
              category_name: "$1,000+",
              amount: "60000.00",
              contributor_count: null,
              source_url: null,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const result = await loadKansasCandidateFinanceSummariesByCandidateElection(
      { query },
      [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID }],
      [ELECTION],
    );

    const summary = result.get(
      `${CANDIDATE_ID}${String.fromCharCode(0)}${ELECTION_ID}`,
    );
    expect(summary).toMatchObject({
      source: "KANSAS_SOS",
      cycle: 2026,
      controlled_committee_id: FILER_KEY,
      // "Raised" is the donor-only figure (direct_contribution_total), as in every standard-loader state.
      direct_campaign: {
        total_raised: 120000,
        total_spent: 40000,
        cash_on_hand: 85000,
      },
    });
    expect(summary?.direct_campaign.top_occupations[0]).toMatchObject({
      category_name: "Attorney",
      amount: 5000,
    });
    expect(
      summary?.direct_campaign.contribution_size_buckets?.[0],
    ).toMatchObject({ category_name: "$1,000+", amount: 60000 });
    expect(summary?.direct_campaign.direct_coverage_note).toMatch(/itemized/);
    // No independent-expenditure statement names this candidate: null totals, never $0.
    expect(summary?.outside_spending.support_total).toBeNull();
    expect(summary?.outside_spending.oppose_total).toBeNull();
    // Every SQL touches ks_ tables only and reads the standard committee_id identity.
    expect(
      queries.every((sql) =>
        /ks_(?:candidate_finance_|independent_expenditure_)/.test(sql),
      ),
    ).toBe(true);
    expect(queries[0]).toContain("committee_id");
  });

  it("keeps Raised unknown for a transcribed paper cover with receipts but no donor total", async () => {
    vi.stubEnv("KANSAS_CAMPAIGN_FINANCE_ENABLED", "true");
    let calls = 0;
    const query = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          rows: [
            summaryRow({
              total_receipts: "100000.00",
              direct_contribution_total: null,
              total_disbursements: "30000.00",
              cash_on_hand: "70000.00",
            }),
          ],
        };
      }
      return { rows: [] };
    });

    const result = await loadKansasCandidateFinanceSummariesByCandidateElection(
      { query },
      [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID }],
      [ELECTION],
    );

    const summary = result.get(
      `${CANDIDATE_ID}${String.fromCharCode(0)}${ELECTION_ID}`,
    );
    // Receipts include loans and refunds, so they must not stand in for donor money.
    expect(summary?.direct_campaign.total_raised).toBeNull();
    expect(summary?.direct_campaign.total_spent).toBe(30000);
    expect(summary?.direct_campaign.cash_on_hand).toBe(70000);
  });
});

const HOUSE_ELECTION = {
  ...ELECTION,
  office_scope: "state_lower",
  office_canonical_name: "State Lower Chamber Legislator",
  district_type: "state_lower",
  geoid_compact: "20102",
};
function ieRow(overrides: Record<string, unknown> = {}) {
  return {
    candidate_id: CANDIDATE_ID,
    election_id: ELECTION_ID,
    election_year: 2026,
    payer_name: "A Reported Payer",
    support_oppose: "support",
    amount_cents: "109855",
    source_url:
      "https://sos.ks.gov/srvimages/campaignfinance/filings/cy2026/cm09/65555.pdf",
    observed_at: "2026-10-12T10:00:00Z",
    candidate_name: "Kyler Sweely",
    local_candidate_name: "Kyler Sweely",
    house_district: 102,
    ...overrides,
  };
}
describe("independent Kansas IE reader", () => {
  it("creates an outside-only card without a receiving filer or direct summary", async () => {
    vi.stubEnv("KANSAS_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("JOIN public.ks_independent_expenditure_evidence")
        ? [ieRow()]
        : [],
    }));
    const result = await loadKansasCandidateFinanceSummariesByCandidateElection(
      { query },
      [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID }],
      [HOUSE_ELECTION],
    );
    const card = result.get(`${CANDIDATE_ID}\u0000${ELECTION_ID}`);
    expect(card).toMatchObject({
      controlled_committee_id: null,
      last_synced_at: "2026-10-12T10:00:00Z",
      direct_campaign: {
        total_raised: null,
        total_spent: null,
        cash_on_hand: null,
        debts_owed: null,
      },
      outside_spending: {
        support_total: null,
        oppose_total: null,
        top_supporting_groups: [
          {
            committee_id: "reported:A REPORTED PAYER",
            amount: 1098.55,
            expenditure_count: 1,
          },
        ],
      },
    });
    expect(card?.outside_spending.outside_coverage_note).toMatch(
      /Overall outside-spending totals are unknown/,
    );
    const sql = query.mock.calls.find(([value]) =>
      value.includes("JOIN public.ks_independent_expenditure_evidence"),
    )?.[0];
    expect(sql).toContain("election.election_stage = 'general'");
    expect(sql).toContain("substring(district.geoid_compact FROM 3)");
    expect(sql).not.toMatch(
      /ks_candidate_finance_links|ks_candidate_finance_summaries/,
    );
  });

  it("replaces the legacy outside view without double-adding while retaining every direct field and freshness", async () => {
    vi.stubEnv("KANSAS_CAMPAIGN_FINANCE_ENABLED", "true");
    let normalCalls = 0;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("JOIN public.ks_independent_expenditure_evidence"))
        return { rows: [ieRow(), ieRow({ amount_cents: "20955" })] };
      normalCalls += 1;
      return {
        rows:
          normalCalls === 1
            ? [summaryRow({ outside_support_total: "999999.00" })]
            : [],
      };
    });
    const result = await loadKansasCandidateFinanceSummariesByCandidateElection(
      { query },
      [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID }],
      [HOUSE_ELECTION],
    );
    const card = result.get(`${CANDIDATE_ID}\u0000${ELECTION_ID}`);
    expect(card?.last_synced_at).toBe("2026-09-05T12:00:00.000Z");
    expect(card?.direct_campaign.total_raised).toBe(120000);
    expect(card?.controlled_committee_id).toBe(FILER_KEY);
    expect(card?.outside_spending.support_total).toBeNull();
    expect(card?.outside_spending.top_supporting_groups).toHaveLength(1);
    expect(card?.outside_spending.top_supporting_groups[0]?.amount).toBe(
      1308.1,
    );
  });

  it("keeps distinct payer/direction rows and applies the display cap after full reported-name grouping", async () => {
    vi.stubEnv("KANSAS_CAMPAIGN_FINANCE_ENABLED", "true");
    const rows = Array.from({ length: 7 }, (_, index) =>
      ieRow({
        payer_name: `Payer ${index}`,
        amount_cents: (index + 1) * 100000,
      }),
    );
    rows.push(
      ieRow({
        payer_name: "Payer 0",
        support_oppose: "oppose",
        amount_cents: "120000",
      }),
    );
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("JOIN public.ks_independent_expenditure_evidence")
        ? rows
        : [],
    }));
    const result = await loadKansasCandidateFinanceSummariesByCandidateElection(
      { query },
      [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID }],
      [HOUSE_ELECTION],
    );
    const card = result.get(`${CANDIDATE_ID}\u0000${ELECTION_ID}`);
    expect(
      card?.outside_spending.top_supporting_groups.map((group) => group.amount),
    ).toEqual([7000, 6000, 5000, 4000, 3000]);
    expect(card?.outside_spending.top_opposing_groups[0]?.amount).toBe(1200);
  });

  it("does not publish stale target mappings after a candidate-name change", async () => {
    vi.stubEnv("KANSAS_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("JOIN public.ks_independent_expenditure_evidence")
        ? [ieRow({ local_candidate_name: "Kyler James Sweely" })]
        : [],
    }));
    const result = await loadKansasCandidateFinanceSummariesByCandidateElection(
      { query },
      [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID }],
      [HOUSE_ELECTION],
    );
    expect(result.size).toBe(0);
  });
});
