import { afterEach, describe, expect, it, vi } from "vitest";
import { candidateElectionKey } from "../../../src/pipeline/address/ballotLookupFinanceShared.js";
import { loadPhoenixCandidateFinanceSummariesByCandidateElection } from "../../../src/pipeline/phoenixFinance/phoenixBallotLookupFinanceLoader.js";

const KEY = candidateElectionKey("c", "e");

afterEach(() => vi.unstubAllEnvs());

const PHOENIX_COUNCIL_ELECTION = {
  election_id: "e",
  state: "AZ",
  district_type: "place",
  geoid_compact: "0455000",
  office_scope: "place",
  office_canonical_name: "City Council Member",
  official_ballot_title: "Phoenix City Council, District 4",
};

function summaryRow(over: Record<string, unknown> = {}) {
  return {
    candidate_id: "c",
    election_id: "e",
    cop_id: "CAN-25-4",
    election_year: 2026,
    total_raised: "316139.10",
    total_spent: "108905.71",
    cash_on_hand: "231095.51",
    debts_owed: null,
    loans_received: "0",
    outside_support_total: "0",
    outside_oppose_total: "0",
    direct_coverage_note:
      "Totals come from the committee's reports filed in the city's e-filing system.",
    outside_coverage_note:
      "Outside spending totals cover independent expenditures reported to the Phoenix City Clerk by city-registered committees.",
    source_url: "https://apps-secure.phoenix.gov/CampaignFinance",
    last_synced_at: "2026-08-12",
    ...over,
  };
}

describe("Phoenix ballot finance loader", () => {
  it("maps a DB snapshot with both always-on notes and empty size buckets", async () => {
    vi.stubEnv("PHOENIX_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [summaryRow()] })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: "c",
            election_id: "e",
            category_type: "employer",
            category_name: "Desert Law LLP",
            amount: "500",
            contributor_count: "3",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: "c",
            election_id: "e",
            spender_filer_id: "PAC-22-14",
            spender_name: "Some IE PAC",
            support_oppose: "oppose",
            amount: "6500",
            expenditure_count: "1",
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const result =
      await loadPhoenixCandidateFinanceSummariesByCandidateElection(
        { query } as never,
        [{ candidate_id: "c", election_id: "e" }],
        [PHOENIX_COUNCIL_ELECTION],
      );
    expect(result.get(KEY)).toMatchObject({
      source: "PHOENIX_CITY_CLERK",
      cycle: 2026,
      controlled_committee_id: "CAN-25-4",
      direct_campaign: {
        total_raised: 316139.1,
        total_spent: 108905.71,
        cash_on_hand: 231095.51,
        debts_owed: null,
        loans_received: 0,
        direct_coverage_note: expect.stringContaining("e-filing system"),
        contribution_size_buckets: [],
        top_employers: [
          {
            category_name: "Desert Law LLP",
            amount: 500,
            contributor_count: 3,
            // Breakdown rows without their own URL inherit the summary's.
            source_url: "https://apps-secure.phoenix.gov/CampaignFinance",
          },
        ],
      },
      outside_spending: {
        support_total: null,
        oppose_total: null,
        outside_coverage_note: expect.stringContaining("Phoenix City Clerk"),
        top_opposing_groups: [
          expect.objectContaining({
            committee_id: "PAC-22-14",
            committee_name: "Some IE PAC",
            amount: 6500,
            expenditure_count: 1,
          }),
        ],
      },
    });
    const sql = String(query.mock.calls[0]?.[0]);
    for (const column of [
      "link.cop_id",
      "summary.loans_received",
      "summary.direct_coverage_note",
      "summary.outside_coverage_note",
    ]) {
      expect(sql).toContain(column);
    }
  });

  function pacRow(over: Record<string, unknown> = {}) {
    return {
      candidate_id: "c",
      election_id: "e",
      observed_at: "2026-10-12T20:00:00Z",
      reported_through: "2026-06-30",
      committee_id: "reported:CIVIC FUTURE PAC",
      committee_name: "Civic Future PAC",
      amount: "1250",
      source_url:
        "https://apps-secure.phoenix.gov/CampaignFinance/Reports/PrintReport/11111111-1111-4111-8111-111111111111",
      industry_slug: null,
      classification_source: null,
      confidence: null,
      ...over,
    };
  }
  async function loadPac(rows: Record<string, unknown>[]) {
    vi.stubEnv("PHOENIX_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [summaryRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows });
    const result =
      await loadPhoenixCandidateFinanceSummariesByCandidateElection(
        { query } as never,
        [{ candidate_id: "c", election_id: "e" }],
        [PHOENIX_COUNCIL_ELECTION],
      );
    return { query, summary: result.get(KEY)! };
  }

  it("omits unavailable PAC evidence and distinguishes an accepted empty generation", async () => {
    const absent = await loadPac([]);
    expect(absent.summary.direct_campaign).not.toHaveProperty(
      "pac_money_by_interest",
    );
    const empty = await loadPac([
      pacRow({ committee_id: null, committee_name: null, amount: null }),
    ]);
    expect(empty.summary.direct_campaign.pac_money_by_interest).toEqual([]);
    expect(empty.summary.direct_campaign.direct_coverage_note).toContain(
      "Reported PAC monetary receipts net",
    );
    expect(empty.summary.last_synced_at).toBe("2026-08-12");
    expect(empty.summary.direct_campaign.total_raised).toBe(316139.1);
  });

  it("shows unknown reported groups as Not yet sorted with separate source freshness", async () => {
    const { summary } = await loadPac([pacRow()]);
    expect(summary.direct_campaign.pac_money_by_interest).toEqual([
      {
        interest: "unclassified",
        interest_name: "Not yet sorted",
        amount: 1250,
        pac_count: 1,
        pacs: [
          expect.objectContaining({
            committee_id: "reported:CIVIC FUTURE PAC",
            committee_name: "Civic Future PAC",
            amount: 1250,
          }),
        ],
      },
    ]);
    expect(summary.direct_campaign.direct_coverage_note).toContain(
      "through 2026-06-30",
    );
    expect(summary.direct_campaign.direct_coverage_note).toContain(
      "observed 2026-10-12T20:00:00Z",
    );
    expect(summary.direct_campaign.direct_coverage_note).toContain(
      "In-kind, candidate committees and parties are excluded",
    );
    expect(summary.last_synced_at).toBe("2026-08-12");
  });

  it("uses only trusted classifications and excludes known hidden political buckets", async () => {
    const { summary } = await loadPac([
      pacRow({
        committee_id: "reported:MANUAL",
        committee_name: "Opaque Fund One",
        industry_slug: "healthcare",
        classification_source: "manual",
        confidence: "low",
      }),
      pacRow({
        committee_id: "reported:UNTRUSTED",
        committee_name: "Opaque Fund Two",
        industry_slug: "pharmaceuticals",
        classification_source: "ai",
        confidence: "low",
        amount: "500",
      }),
      pacRow({
        committee_id: "reported:HIDDEN",
        committee_name: "Opaque Fund Three",
        industry_slug: "leadership_pacs",
        classification_source: "manual",
      }),
    ]);
    const interests = summary.direct_campaign.pac_money_by_interest!;
    expect(interests.map((r) => r.interest)).toEqual([
      "healthcare",
      "unclassified",
    ]);
    expect(interests[1].amount).toBe(500);
    expect(
      interests
        .flatMap((r) => r.pacs)
        .some((r) => r.committee_id === "reported:HIDDEN"),
    ).toBe(false);
  });

  it("filters nonpositive net positions only after the full signed SQL aggregation", async () => {
    const { query, summary } = await loadPac([
      pacRow({ amount: "-50" }),
      pacRow({ committee_id: "reported:ZERO", amount: "0" }),
      pacRow({ committee_id: "reported:POSITIVE", amount: "25" }),
    ]);
    expect(summary.direct_campaign.pac_money_by_interest?.[0].amount).toBe(25);
    expect(summary.direct_campaign.pac_money_by_interest?.[0].pac_count).toBe(
      1,
    );
    const sql = String(query.mock.calls[3][0]);
    expect(sql).toContain("sum(donor.amount)");
    expect(sql).not.toMatch(/donor\.amount\s*>\s*0/i);
    expect(sql).not.toContain("LIMIT");
    expect(sql).toContain("donor.capture_digest=source.capture_digest");
    expect(sql).toContain("donor.recognition_method='reported_type'");
    expect(sql).toContain("source.election_year=link.election_year");
    expect(sql).toContain("link.link_status='active'");
  });

  it("sums every donor before the five-name cap and retains Not yet sorted", async () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      pacRow({
        committee_id: `reported:OPAQUE ${i}`,
        committee_name: `Opaque Fund ${i}`,
        amount: String(100 + i),
      }),
    );
    const { summary } = await loadPac(rows);
    const group = summary.direct_campaign.pac_money_by_interest![0];
    expect(group.amount).toBe(721);
    expect(group.pac_count).toBe(7);
    expect(group.pacs).toHaveLength(5);
    expect(group.pacs[0].committee_id).toBe("reported:OPAQUE 6");
  });

  it("never exposes stored outside totals as whole coverage while keeping known groups", async () => {
    const { summary } = await loadPac([]);
    expect(summary.outside_spending.support_total).toBeNull();
    expect(summary.outside_spending.oppose_total).toBeNull();
    expect(summary.outside_spending.outside_coverage_note).toContain(
      "overall outside totals remain unknown",
    );
  });

  it("does no DB work when the master flag is off or the election is not Phoenix", async () => {
    vi.stubEnv("PHOENIX_CAMPAIGN_FINANCE_ENABLED", "false");
    const query = vi.fn();
    expect(
      (
        await loadPhoenixCandidateFinanceSummariesByCandidateElection(
          { query } as never,
          [{ candidate_id: "c", election_id: "e" }],
          [PHOENIX_COUNCIL_ELECTION],
        )
      ).size,
    ).toBe(0);
    vi.stubEnv("PHOENIX_CAMPAIGN_FINANCE_ENABLED", "true");
    expect(
      (
        await loadPhoenixCandidateFinanceSummariesByCandidateElection(
          { query } as never,
          [{ candidate_id: "c", election_id: "e" }],
          // Tucson, not Phoenix.
          [{ ...PHOENIX_COUNCIL_ELECTION, geoid_compact: "0477000" }],
        )
      ).size,
    ).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});
