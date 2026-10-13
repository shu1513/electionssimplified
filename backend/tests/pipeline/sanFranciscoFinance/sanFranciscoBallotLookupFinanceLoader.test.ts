import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSanFranciscoCandidateFinanceSummariesByCandidateElection } from "../../../src/pipeline/sanFranciscoFinance/sanFranciscoBallotLookupFinanceLoader.js";

afterEach(() => vi.unstubAllEnvs());

const SF_COUNTY_ELECTION = {
  election_id: "e",
  state: "CA",
  district_type: "county",
  geoid_compact: "06075",
  office_scope: "county",
  office_canonical_name: "District Attorney",
};

describe("San Francisco ballot finance loader", () => {
  it("reads all signed committee positions before display grouping and preserves their own observation date", async () => {
    vi.stubEnv("SAN_FRANCISCO_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("summary.total_receipts"))
        return {
          rows: [
            {
              candidate_id: "c",
              election_id: "e",
              fppc_id: "1499514",
              election_year: 2026,
              direct_contribution_total: "104832",
              total_receipts: "260136",
              last_synced_at: "2026-10-12",
              source_url: "https://sfethics.org",
            },
          ],
        };
      if (sql.includes("sfc_candidate_finance_pac_donors"))
        return {
          rows: [
            {
              candidate_id: "c",
              election_id: "e",
              committee_id: "reported:COM:COMMUNITY ALLIANCE",
              committee_name: "Community Alliance",
              amount: "750",
              source_url: "https://data.sfgov.org/d/pitq-e56w",
              reported_through: "2026-09-19",
              last_synced_at: "2026-10-10T12:00:00Z",
            },
          ],
        };
      return { rows: [] };
    });
    const map =
      await loadSanFranciscoCandidateFinanceSummariesByCandidateElection(
        { query } as never,
        [{ candidate_id: "c", election_id: "e" }],
        [SF_COUNTY_ELECTION],
      );
    expect(map.get("c\u0000e")?.direct_campaign).toMatchObject({
      total_raised: 104832,
      pac_money_by_interest: [
        { interest: "unclassified", amount: 750, pac_count: 1 },
      ],
      direct_coverage_note: expect.stringContaining("last checked 2026-10-10"),
    });
    const sql = query.mock.calls.find(([sql]) =>
      sql.includes("sfc_candidate_finance_pac_donors"),
    )![0];
    expect(sql).toContain("sum(d.amount)");
    expect(sql).not.toMatch(/(?:WHERE|AND)\s+d.amount\s*>/i);
    expect(sql).not.toContain("LIMIT");
  });

  it("maps a DB snapshot and prefers donor money for total_raised", async () => {
    vi.stubEnv("SAN_FRANCISCO_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: "c",
            election_id: "e",
            fppc_id: "1499514",
            election_year: 2026,
            // Manifest funds (includes public money) vs donor-only total:
            // the card must get the donor figure so "Raised" and "Public
            // funds" stay disjoint.
            total_receipts: "260136",
            direct_contribution_total: "104832",
            total_disbursements: "90000",
            cash_on_hand: "12000",
            debts_owed: "500",
            loans_received: "5000",
            public_funds_received: "155304",
            outside_support_total: "3",
            outside_oppose_total: "1",
            source_url: "https://sfethics.org",
            last_synced_at: "2026-08-09",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: "c",
            election_id: "e",
            category_type: "occupation",
            category_name: "Attorney",
            amount: "500",
            contributor_count: "3",
            // SF breakdown rows carry no per-row URL — the summary URL must
            // ride along or the card footer loses its source link.
            source_url: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: "c",
            election_id: "e",
            spender_fppc_id: "name:example pac",
            spender_name: "Example PAC",
            support_oppose: "support",
            amount: "3",
            source_url: null,
          },
        ],
      })
      .mockResolvedValue({ rows: [] });
    const result =
      await loadSanFranciscoCandidateFinanceSummariesByCandidateElection(
        { query } as never,
        [{ candidate_id: "c", election_id: "e" }],
        [SF_COUNTY_ELECTION],
      );
    expect(result.get("c\u0000e")).toMatchObject({
      source: "SAN_FRANCISCO_ETHICS",
      cycle: 2026,
      controlled_committee_id: "1499514",
      direct_campaign: {
        total_raised: 104832,
        total_spent: 90000,
        cash_on_hand: 12000,
        debts_owed: 500,
        loans_received: 5000,
        public_funds_received: 155304,
        top_occupations: [
          {
            category_name: "Attorney",
            amount: 500,
            contributor_count: 3,
            source_url: "https://sfethics.org",
          },
        ],
      },
      outside_spending: {
        support_total: 3,
        oppose_total: 1,
        top_supporting_groups: [
          {
            committee_id: "name:example pac",
            committee_name: "Example PAC",
            support_oppose: "support",
            amount: 3,
            // Manifest discloses per-relation totals only — never a count.
            expenditure_count: null,
            source_url: null,
          },
        ],
      },
    });
    // The summary SQL must actually select the SF-specific columns — the
    // read path silently dropping columns has happened before (LA).
    const sql = String(query.mock.calls[0]?.[0]);
    for (const column of [
      "summary.direct_contribution_total",
      "summary.debts_owed",
      "summary.loans_received",
      "summary.public_funds_received",
    ]) {
      expect(sql).toContain(column);
    }
    // The five largest outside groups must also arrive largest-first — the
    // card renders them in row order without re-sorting.
    expect(String(query.mock.calls[2]?.[0])).toContain(
      "ORDER BY candidate_id,election_id,support_oppose,amount DESC,spender_name,spender_fppc_id",
    );
    // The window ORDER BY decides which tied group survives the rank-5
    // cutoff — spender_name alone is not unique, spender_fppc_id is.
    expect(String(query.mock.calls[2]?.[0])).toContain(
      "ORDER BY g.amount DESC,g.spender_name,g.spender_fppc_id) rn",
    );
  });

  it("falls back to manifest funds when no donor total is stored", async () => {
    vi.stubEnv("SAN_FRANCISCO_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            candidate_id: "c",
            election_id: "e",
            fppc_id: "1499514",
            election_year: 2026,
            total_receipts: "260136",
            direct_contribution_total: null,
            total_disbursements: null,
            cash_on_hand: null,
            debts_owed: null,
            loans_received: null,
            public_funds_received: null,
            outside_support_total: null,
            outside_oppose_total: null,
            source_url: null,
            last_synced_at: "2026-08-09",
          },
        ],
      })
      .mockResolvedValue({ rows: [] });
    const result =
      await loadSanFranciscoCandidateFinanceSummariesByCandidateElection(
        { query } as never,
        [{ candidate_id: "c", election_id: "e" }],
        [SF_COUNTY_ELECTION],
      );
    expect(result.get("c\u0000e")?.direct_campaign.total_raised).toBe(260136);
  });

  it("does no DB work for another California county", async () => {
    vi.stubEnv("SAN_FRANCISCO_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi.fn();
    const result =
      await loadSanFranciscoCandidateFinanceSummariesByCandidateElection(
        { query } as never,
        [{ candidate_id: "c", election_id: "e" }],
        [{ ...SF_COUNTY_ELECTION, geoid_compact: "06037" }],
      );
    expect(result.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("does no DB work when the master flag is off", async () => {
    vi.stubEnv("SAN_FRANCISCO_CAMPAIGN_FINANCE_ENABLED", "false");
    const query = vi.fn();
    const result =
      await loadSanFranciscoCandidateFinanceSummariesByCandidateElection(
        { query } as never,
        [{ candidate_id: "c", election_id: "e" }],
        [SF_COUNTY_ELECTION],
      );
    expect(result.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("accepts a supervisor election only with a parseable district title", async () => {
    vi.stubEnv("SAN_FRANCISCO_CAMPAIGN_FINANCE_ENABLED", "true");
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await loadSanFranciscoCandidateFinanceSummariesByCandidateElection(
      { query } as never,
      [
        { candidate_id: "district-10", election_id: "valid" },
        { candidate_id: "unknown", election_id: "invalid" },
      ],
      [
        {
          election_id: "valid",
          state: "CA",
          district_type: "county",
          geoid_compact: "06075",
          office_scope: "county",
          office_canonical_name: "County Supervisor",
          official_ballot_title: "Member, Board of Supervisors, District 10",
        },
        {
          election_id: "invalid",
          state: "CA",
          district_type: "county",
          geoid_compact: "06075",
          office_scope: "county",
          office_canonical_name: "County Supervisor",
          official_ballot_title: "County Supervisor",
        },
      ],
    );
    expect(JSON.parse(String(query.mock.calls[0]?.[1]?.[0]))).toEqual([
      { candidate_id: "district-10", election_id: "valid" },
    ]);
  });
});
