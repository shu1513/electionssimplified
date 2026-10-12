import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadNewYorkCandidateFinanceSummariesByCandidateElection as load,
  NEW_YORK_PAC_COVERAGE_NOTE as NOTE,
  NEW_YORK_OUTSIDE_COVERAGE_NOTE as OUTSIDE_NOTE,
} from "../../../src/pipeline/newYorkFinance/newYorkBallotLookupFinanceLoader.js";
const C = "11111111-1111-4111-8111-111111111111",
  E = "22222222-2222-4222-8222-222222222222",
  SOURCE = "https://data.ny.gov/d/e9ss-239a";
const candidates = [{ candidate_id: C, election_id: E }],
  elections = [
    {
      election_id: E,
      state: "NY",
      office_scope: "state_upper",
      office_canonical_name: "State Senator",
      district_type: "state_upper",
      geoid_compact: "36037",
    },
  ];
const summary = {
  candidate_id: C,
  election_id: E,
  committee_id: "445903",
  election_year: 2026,
  total_receipts: "10000",
  direct_contribution_total: "9000",
  total_disbursements: "2000",
  cash_on_hand: null,
  outside_support_total: null,
  outside_oppose_total: null,
  last_synced_at: "2026-10-12T20:00:00Z",
};
function donor(change: Record<string, unknown> = {}) {
  return {
    candidate_id: C,
    election_id: E,
    committee_id: "reported:UNPLACED GROUP",
    committee_name: "Unplaced group",
    source_reported_class: "Political Action Committee (PAC)",
    amount: "500",
    source_url: SOURCE,
    industry_slug: null,
    classification_source: null,
    confidence: null,
    ...change,
  };
}
function database(rows: unknown[], summaries: unknown[] = [summary]) {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("ny_candidate_finance_pac_donors")) return { rows };
      if (sql.includes("ny_candidate_finance_summaries"))
        return { rows: summaries };
      return { rows: [] };
    }),
  };
}
async function card(db: ReturnType<typeof database>) {
  return [...(await load(db, candidates, elections)).values()][0]!;
}
afterEach(() => vi.unstubAllEnvs());
describe("New York literal PAC monetary-receipt reader", () => {
  it("sums all unique source donor positions across active exact-year links before display and leaves Raised unchanged", async () => {
    vi.stubEnv("NEW_YORK_CAMPAIGN_FINANCE_ENABLED", "true");
    const db = database([donor({ amount: "1200" })]);
    const r = await card(db);
    expect(r.direct_campaign.total_raised).toBe(9000);
    expect(r.direct_campaign.pac_money_by_interest).toEqual([
      {
        interest: "unclassified",
        interest_name: "Not yet sorted",
        amount: 1200,
        pac_count: 1,
        pacs: [
          {
            committee_id: "reported:UNPLACED GROUP",
            committee_name: "Unplaced group",
            amount: 1200,
            source_url: SOURCE,
          },
        ],
      },
    ]);
    expect(r.direct_campaign.direct_coverage_note).toBe(NOTE);
    expect(r.direct_campaign).not.toHaveProperty("coverage_note");
    const sql = String(
      db.query.mock.calls.find((c) =>
        String(c[0]).includes("ny_candidate_finance_pac_donors"),
      )![0],
    );
    expect(sql).toContain("sum(donor.amount)");
    expect(sql).toContain("donor.election_year=link.election_year");
    expect(sql).toContain("link.link_status='active'");
    expect(sql).toContain(
      "GROUP BY selected.candidate_id,selected.election_id,donor.committee_id",
    );
    expect(sql).not.toMatch(/\bLIMIT\b|donor\.amount\s*>\s*0/i);
  });
  it("counts and totals every unknown donor before capping the five visible names", async () => {
    vi.stubEnv("NEW_YORK_CAMPAIGN_FINANCE_ENABLED", "true");
    const rows = Array.from({ length: 7 }, (_, i) =>
      donor({
        committee_id: `reported:UNPLACED GROUP ${i}`,
        committee_name: `Unplaced group ${i}`,
        amount: String(100 + i),
      }),
    );
    const r = await card(database(rows));
    const interest = r.direct_campaign.pac_money_by_interest![0];
    expect(interest.amount).toBe(721);
    expect(interest.pac_count).toBe(7);
    expect(interest.pacs).toHaveLength(5);
    expect(interest.pacs[0].amount).toBe(106);
  });
  it("keeps Not yet sorted even after six larger classified interests", async () => {
    vi.stubEnv("NEW_YORK_CAMPAIGN_FINANCE_ENABLED", "true");
    const interests = [
      "technology",
      "healthcare",
      "construction",
      "finance_investment",
      "transportation",
      "labor_unions",
    ];
    const rows = interests.map((industry, i) =>
      donor({
        committee_id: `reported:GROUP ${i}`,
        committee_name: `Group ${i}`,
        amount: "1000",
        industry_slug: industry,
        classification_source: "manual",
        confidence: "high",
      }),
    );
    rows.push(donor({ amount: "5" }));
    const r = await card(database(rows));
    expect(r.direct_campaign.pac_money_by_interest).toHaveLength(7);
    expect(r.direct_campaign.pac_money_by_interest!.at(-1)).toMatchObject({
      interest: "unclassified",
      amount: 5,
      pac_count: 1,
    });
  });
  it("uses trusted manual/high source rules while low or medium automatic confidence remains unsorted", async () => {
    vi.stubEnv("NEW_YORK_CAMPAIGN_FINANCE_ENABLED", "true");
    const r = await card(
      database([
        donor({
          committee_id: "reported:MANUAL GROUP",
          committee_name: "Manual group",
          amount: "10",
          industry_slug: "technology",
          classification_source: "manual",
          confidence: "low",
        }),
        donor({
          committee_id: "reported:LOW GROUP",
          committee_name: "Low group",
          amount: "20",
          industry_slug: "healthcare",
          classification_source: "ai",
          confidence: "medium",
        }),
        donor({
          committee_id: "reported:HIGH GROUP",
          committee_name: "High group",
          amount: "30",
          industry_slug: "construction",
          classification_source: "rule",
          confidence: "high",
        }),
      ]),
    );
    expect(
      r.direct_campaign.pac_money_by_interest!.map((g) => [
        g.interest,
        g.amount,
      ]),
    ).toEqual([
      ["construction", 30],
      ["unclassified", 20],
      ["technology", 10],
    ]);
  });
  it.each(["leadership_pacs", "candidate_committees"])(
    "skips a known %s classification rather than relabeling it unknown",
    async (industry) => {
      vi.stubEnv("NEW_YORK_CAMPAIGN_FINANCE_ENABLED", "true");
      const r = await card(
        database([
          donor({
            industry_slug: industry,
            classification_source: "manual",
            confidence: "high",
          }),
          donor({
            committee_id: "reported:STILL UNKNOWN",
            committee_name: "Still unknown",
            amount: "10",
          }),
        ]),
      );
      expect(r.direct_campaign.pac_money_by_interest).toHaveLength(1);
      expect(r.direct_campaign.pac_money_by_interest![0]).toMatchObject({
        interest: "unclassified",
        amount: 10,
        pac_count: 1,
      });
    },
  );
  it("does not promote generic organizations, Political Committee, blank classes or nonpositive/malformed amounts", async () => {
    vi.stubEnv("NEW_YORK_CAMPAIGN_FINANCE_ENABLED", "true");
    const r = await card(
      database([
        donor({ source_reported_class: "Political Committee" }),
        donor({ source_reported_class: "Corporation" }),
        donor({ source_reported_class: "" }),
        donor({ amount: "0" }),
        donor({ amount: "-100" }),
        donor({ amount: "NaN" }),
      ]),
    );
    expect(r.direct_campaign).not.toHaveProperty("pac_money_by_interest");
    expect(r.direct_campaign.total_raised).toBe(9000);
  });
  it("uses the public dataset entry point if source URL is absent", async () => {
    vi.stubEnv("NEW_YORK_CAMPAIGN_FINANCE_ENABLED", "true");
    const r = await card(database([donor({ source_url: null })]));
    expect(r.direct_campaign.pac_money_by_interest![0].pacs[0].source_url).toBe(
      SOURCE,
    );
  });
  it("unknown or omitted donor rows remain absent rather than a fabricated zero", async () => {
    vi.stubEnv("NEW_YORK_CAMPAIGN_FINANCE_ENABLED", "true");
    const r = await card(database([]));
    expect(r.direct_campaign).not.toHaveProperty("pac_money_by_interest");
    expect(r.outside_spending.support_total).toBeNull();
    expect(r.outside_spending.oppose_total).toBeNull();
  });
  it("preserves independent supporting groups and scalar amounts", async () => {
    vi.stubEnv("NEW_YORK_CAMPAIGN_FINANCE_ENABLED", "true");
    const db = database(
      [donor()],
      [{ ...summary, outside_support_total: "2500" }],
    );
    const r = await card(db);
    expect(r.outside_spending.support_total).toBeNull();
    expect(r.outside_spending.outside_coverage_note).toBe(OUTSIDE_NOTE);
    expect(r.direct_campaign.total_raised).toBe(9000);
  });
  it("legacy stored outside zero pairs remain unknown rather than current absence", async () => {
    vi.stubEnv("NEW_YORK_CAMPAIGN_FINANCE_ENABLED", "true");
    const r = await card(
      database(
        [],
        [{ ...summary, outside_support_total: "0", outside_oppose_total: "0" }],
      ),
    );
    expect(r.outside_spending).toMatchObject({
      support_total: null,
      oppose_total: null,
      outside_coverage_note: OUTSIDE_NOTE,
    });
  });
  it("retains actual known positive payer groups while withholding aggregate headlines", async () => {
    vi.stubEnv("NEW_YORK_CAMPAIGN_FINANCE_ENABLED", "true");
    const db = database(
      [],
      [
        {
          ...summary,
          outside_support_total: "2500",
          outside_oppose_total: "0",
        },
      ],
    );
    const base = db.query.getMockImplementation()!;
    db.query.mockImplementation(async (sql) => {
      if (sql.includes("max(outside_group.amount) AS amount"))
        return {
          rows: [
            {
              candidate_id: C,
              election_id: E,
              committee_id: "590891",
              committee_name: "Source IE committee",
              support_oppose: "support",
              amount: "2500",
              source_url: SOURCE,
            },
          ],
        };
      return base(sql);
    });
    const r = await card(db);
    expect(r.outside_spending.support_total).toBeNull();
    expect(r.outside_spending.oppose_total).toBeNull();
    expect(r.outside_spending.top_supporting_groups).toEqual([
      expect.objectContaining({
        committee_id: "590891",
        committee_name: "Source IE committee",
        amount: 2500,
      }),
    ]);
  });
  it("disabled/other-state/no-summary requests do not query the new donor relation", async () => {
    const db = database([donor()]);
    vi.stubEnv("NEW_YORK_CAMPAIGN_FINANCE_ENABLED", "false");
    expect((await load(db, candidates, elections)).size).toBe(0);
    expect(db.query).not.toHaveBeenCalled();
    vi.stubEnv("NEW_YORK_CAMPAIGN_FINANCE_ENABLED", "true");
    await load(db, candidates, [{ ...elections[0], state: "NJ" }]);
    expect(db.query).not.toHaveBeenCalled();
    const missing = database([donor()], []);
    expect((await load(missing, candidates, elections)).size).toBe(0);
    expect(missing.query).toHaveBeenCalledOnce();
  });
});
