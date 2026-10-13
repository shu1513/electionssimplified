import { afterEach, describe, expect, it, vi } from "vitest";

import { loadNevadaCandidateFinanceSummariesByCandidateElection } from "../../../src/pipeline/nevadaFinance/nevadaBallotLookupFinanceLoader.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const ELECTION = {
  election_id: ELECTION_ID,
  state: "NV",
  office_scope: "statewide",
  office_canonical_name: "Governor",
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("nevadaBallotLookupFinanceLoader", () => {
  it("stays inert when disabled or the election office is out of scope", async () => {
    vi.stubEnv("NEVADA_CAMPAIGN_FINANCE_ENABLED", "false");
    const query = vi.fn();
    const candidates = [
      { candidate_id: CANDIDATE_ID, election_id: ELECTION_ID },
    ];

    expect(
      await loadNevadaCandidateFinanceSummariesByCandidateElection(
        { query },
        candidates,
        [ELECTION],
      ),
    ).toEqual(new Map());

    vi.stubEnv("NEVADA_CAMPAIGN_FINANCE_ENABLED", "true");
    expect(
      await loadNevadaCandidateFinanceSummariesByCandidateElection(
        { query },
        candidates,
        [
          {
            ...ELECTION,
            office_scope: "county",
            office_canonical_name: "Sheriff",
          },
        ],
      ),
    ).toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
  });

  it("publishes totals, organization-donor industries, and the Nevada coverage notes", async () => {
    vi.stubEnv("NEVADA_CAMPAIGN_FINANCE_ENABLED", "true");
    const queries: string[] = [];
    const query = vi.fn(async (sql: string) => {
      queries.push(sql);
      if (queries.length === 1) {
        return {
          rows: [
            {
              candidate_id: CANDIDATE_ID,
              election_id: ELECTION_ID,
              committee_id: "JOSEPH LOMBARDO",
              election_year: 2026,
              total_receipts: "9090820.60",
              direct_contribution_total: "9090820.60",
              total_disbursements: "5454661.06",
              cash_on_hand: "9197364.58",
              outside_support_total: null,
              outside_oppose_total: null,
              source_url: null,
              last_synced_at: "2026-08-26T12:00:00.000Z",
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
              category_type: "industry",
              category_name: "gaming",
              amount: "125000.00",
              contributor_count: null,
              source_url: null,
            },
            {
              candidate_id: CANDIDATE_ID,
              election_id: ELECTION_ID,
              category_type: "contribution_size",
              category_name: "$5,000+",
              amount: "8000000.00",
              contributor_count: null,
              source_url: null,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const result = await loadNevadaCandidateFinanceSummariesByCandidateElection(
      { query },
      [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID }],
      [ELECTION],
    );

    const summary = result.get(
      `${CANDIDATE_ID}${String.fromCharCode(0)}${ELECTION_ID}`,
    );
    expect(summary).toMatchObject({
      source: "NEVADA_AURORA",
      cycle: 2026,
      controlled_committee_id: "JOSEPH LOMBARDO",
      direct_campaign: {
        total_raised: 9_090_820.6,
        total_spent: 5_454_661.06,
        cash_on_hand: 9_197_364.58,
        top_occupations: [],
      },
    });
    expect(summary?.direct_campaign.direct_coverage_note).toMatch(
      /does not collect donor occupation/,
    );
    expect(summary?.direct_campaign.top_industries?.[0]).toMatchObject({
      category_name: "gaming",
      amount: 125_000,
    });
    expect(
      summary?.direct_campaign.top_contribution_sizes?.[0] ??
        summary?.direct_campaign.top_industries?.length,
    ).toBeTruthy();
    // Every SQL touches nv_ tables only.
    expect(queries.every((sql) => /nv_candidate_finance_/.test(sql))).toBe(
      true,
    );
  });
});

function summaryRow() {
  return {
    candidate_id: CANDIDATE_ID,
    election_id: ELECTION_ID,
    committee_id: "ALEXIS M HANSEN",
    election_year: 2026,
    total_receipts: "50000.00",
    direct_contribution_total: "49000.00",
    total_disbursements: "10000.00",
    cash_on_hand: "40000.00",
    outside_support_total: null,
    outside_oppose_total: null,
    source_url: null,
    last_synced_at: "2026-08-26T12:00:00Z",
  };
}
function pacRow(changes: Record<string, unknown> = {}) {
  return {
    candidate_id: CANDIDATE_ID,
    election_id: ELECTION_ID,
    election_year: 2026,
    observed_at: "2026-10-12T09:20:00.000Z",
    committee_id: "reported:AN UNPLACED PAC",
    committee_name: "An Unplaced PAC",
    amount: "500.00",
    contribution_count: "2",
    source_url: null,
    industry_slug: null,
    classification_source: null,
    confidence: null,
    ...changes,
  };
}
async function loadDonorRows(rows: unknown[], hasDirectSummary = true) {
  vi.stubEnv("NEVADA_CAMPAIGN_FINANCE_ENABLED", "true");
  let call = 0;
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("JOIN public.nv_candidate_finance_pac_sources"))
      return { rows };
    call += 1;
    return { rows: call === 1 && hasDirectSummary ? [summaryRow()] : [] };
  });
  const summaries =
    await loadNevadaCandidateFinanceSummariesByCandidateElection(
      { query },
      [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID }],
      [ELECTION],
    );
  return {
    query,
    summary: summaries.get(`${CANDIDATE_ID}\u0000${ELECTION_ID}`),
  };
}

describe("Nevada committee donor cards", () => {
  it("sums signed receiving positions before positive filtering and leaves Raised, outside and direct freshness unchanged", async () => {
    // SQL result of one donor's +600 and -100 positions across active receiving links.
    const { query, summary } = await loadDonorRows([
      pacRow({ amount: "500.00" }),
    ]);
    expect(summary?.direct_campaign.total_raised).toBe(49000);
    expect(summary?.last_synced_at).toBe("2026-08-26T12:00:00Z");
    expect(summary?.outside_spending.support_total).toBeNull();
    expect(summary?.direct_campaign.pac_money_by_interest).toMatchObject([
      {
        interest: "unclassified",
        interest_name: "Not yet sorted",
        amount: 500,
        pac_count: 1,
        pacs: [{ committee_id: "reported:AN UNPLACED PAC", amount: 500 }],
      },
    ]);
    const sql =
      query.mock.calls.find(([value]) =>
        value.includes("JOIN public.nv_candidate_finance_pac_sources"),
      )?.[0] ?? "";
    expect(sql).toContain("sum(donor.amount)");
    expect(sql).toContain("sum(donor.contribution_count)");
    expect(sql).toContain("donor.election_year = link.election_year");
    expect(sql).toContain(
      "GROUP BY requested.candidate_id, requested.election_id, donor.committee_id",
    );
    expect(sql).not.toMatch(/donor\.amount\s*>/);
  });

  it("computes amounts and distinct PAC counts before top-five detail limits", async () => {
    const rows = Array.from({ length: 7 }, (_, index) =>
      pacRow({
        committee_id: `reported:PAC ${index}`,
        committee_name: `PAC ${index}`,
        amount: 100 + index,
        industry_slug: "healthcare",
        classification_source: "manual",
        confidence: "low",
      }),
    );
    const { summary } = await loadDonorRows(rows);
    const interest = summary?.direct_campaign.pac_money_by_interest?.[0];
    expect(interest).toMatchObject({
      interest: "healthcare",
      amount: 721,
      pac_count: 7,
    });
    expect(interest?.pacs.map((row) => row.amount)).toEqual([
      106, 105, 104, 103, 102,
    ]);
  });

  it("uses trusted classifications, leaves loose matches unsorted, and hides candidate interests only after classification", async () => {
    const { summary } = await loadDonorRows([
      pacRow({
        committee_id: "reported:MANUAL PAC",
        industry_slug: "real_estate",
        classification_source: "manual",
        confidence: "low",
      }),
      pacRow({
        committee_id: "reported:HIGH PAC",
        industry_slug: "healthcare",
        classification_source: "ai",
        confidence: "high",
      }),
      pacRow({
        committee_id: "reported:LOOSE PAC",
        industry_slug: "construction",
        classification_source: "rule",
        confidence: "low",
      }),
      pacRow({
        committee_id: "reported:CANDIDATE PAC",
        industry_slug: "candidate_committees",
        classification_source: "manual",
        confidence: "high",
      }),
    ]);
    const interests = summary?.direct_campaign.pac_money_by_interest ?? [];
    expect(interests.map((row) => row.interest).sort()).toEqual([
      "healthcare",
      "real_estate",
      "unclassified",
    ]);
    expect(
      interests
        .flatMap((row) => row.pacs)
        .some((row) => row.committee_id === "reported:CANDIDATE PAC"),
    ).toBe(false);
    expect(summary?.direct_campaign.direct_coverage_note).toMatch(
      /Name recognition does not establish legal registration identity/,
    );
    expect(summary?.outside_spending.outside_coverage_note).toMatch(
      /integration has no verified/,
    );
  });

  it("distinguishes a validated complete empty marker from absent donor evidence", async () => {
    const absent = await loadDonorRows([]);
    expect(
      absent.summary?.direct_campaign.pac_money_by_interest,
    ).toBeUndefined();
    expect(absent.summary?.direct_campaign.direct_coverage_note).not.toMatch(
      /reported names/,
    );
    const empty = await loadDonorRows([
      pacRow({ committee_id: null, committee_name: null, amount: null }),
    ]);
    expect(empty.summary?.direct_campaign.pac_money_by_interest).toEqual([]);
    expect(empty.summary?.direct_campaign.direct_coverage_note).toMatch(
      /not all PAC money/,
    );
    expect(empty.summary?.direct_campaign.direct_coverage_note).toMatch(
      /accepted itemized cash/,
    );
  });

  it("returns no card when both direct summary and donor evidence are absent", async () => {
    vi.stubEnv("NEVADA_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi.fn(async () => ({ rows: [] }));
    expect(
      await loadNevadaCandidateFinanceSummariesByCandidateElection(
        { query },
        [{ candidate_id: CANDIDATE_ID, election_id: ELECTION_ID }],
        [ELECTION],
      ),
    ).toEqual(new Map());
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("publishes accepted donors without a direct summary and leaves totals unknown", async () => {
    const { summary } = await loadDonorRows([pacRow()], false);
    expect(summary).toMatchObject({
      source: "NEVADA_AURORA",
      cycle: 2026,
      last_synced_at: "2026-10-12T09:20:00.000Z",
      direct_campaign: {
        total_raised: null,
        total_spent: null,
        cash_on_hand: null,
        debts_owed: null,
        pac_money_by_interest: [{ amount: 500 }],
      },
      outside_spending: { support_total: null, oppose_total: null },
    });
  });

  it("publishes a complete empty donor component without inventing direct totals", async () => {
    const { summary } = await loadDonorRows(
      [pacRow({ committee_id: null, committee_name: null, amount: null })],
      false,
    );
    expect(summary?.direct_campaign.pac_money_by_interest).toEqual([]);
    expect(summary?.direct_campaign.total_raised).toBeNull();
  });

  it("queries eligible donor-only candidates alongside candidates with direct summaries", async () => {
    vi.stubEnv("NEVADA_CAMPAIGN_FINANCE_ENABLED", "true");
    const other = "33333333-3333-4333-8333-333333333333";
    const excluded = "44444444-4444-4444-8444-444444444444";
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("JOIN public.nv_candidate_finance_pac_sources")
        ? [pacRow({ candidate_id: other })]
        : sql.includes("JOIN public.nv_candidate_finance_summaries")
          ? [summaryRow()]
          : [],
    }));
    const result = await loadNevadaCandidateFinanceSummariesByCandidateElection(
      { query },
      [
        { candidate_id: CANDIDATE_ID, election_id: ELECTION_ID },
        { candidate_id: other, election_id: ELECTION_ID },
        { candidate_id: excluded, election_id: excluded },
      ],
      [ELECTION, { ...ELECTION, election_id: excluded, state: "CA" }],
    );
    expect(result.size).toBe(2);
    expect(
      result.get(`${other}\u0000${ELECTION_ID}`)?.direct_campaign
        .pac_money_by_interest,
    ).toMatchObject([{ amount: 500 }]);
    const call = (query.mock.calls as unknown[][]).find(([sql]) =>
      String(sql).includes("JOIN public.nv_candidate_finance_pac_sources"),
    );
    expect(call?.[1]).toEqual([
      JSON.stringify([
        { candidate_id: CANDIDATE_ID, election_id: ELECTION_ID },
        { candidate_id: other, election_id: ELECTION_ID },
      ]),
    ]);
  });

  it("filters a donor's final signed zero or negative candidate position rather than clamping its receiving positions", async () => {
    const { summary } = await loadDonorRows([
      pacRow({ amount: -100 }),
      pacRow({ committee_id: "reported:ZERO PAC", amount: 0 }),
    ]);
    expect(summary?.direct_campaign.pac_money_by_interest).toEqual([]);
  });
});
