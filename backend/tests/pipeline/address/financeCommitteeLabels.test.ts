import { describe, expect, it, vi } from "vitest";

import { applyFinanceCommitteeLabels } from "../../../src/pipeline/address/financeCommitteeLabels.js";
import type { BallotLookupFinanceSummary } from "../../../src/pipeline/address/ballotLookupFinanceShared.js";

function summary(overrides: Partial<BallotLookupFinanceSummary> = {}): BallotLookupFinanceSummary {
  return {
    source: "LOS_ANGELES_CITY_ETHICS",
    cycle: 2026,
    fec_candidate_id: null,
    last_synced_at: "2026-07-12T00:00:00Z",
    direct_campaign: {
      total_raised: null,
      total_spent: null,
      cash_on_hand: null,
      debts_owed: null,
      top_occupations: [],
      top_industries: [],
    },
    outside_spending: {
      support_total: 88019,
      oppose_total: null,
      top_supporting_groups: [
        {
          committee_id: "1461461",
          committee_name: "Streets for All Los Angeles PAC",
          support_oppose: "support",
          amount: 88019,
          source_url: null,
        },
      ],
      top_opposing_groups: [],
      top_supporting_industries: [],
      top_opposing_industries: [],
    },
    backing_summary: {
      top_direct_donor_occupations: [],
      top_outside_supporting_industries: [],
    },
    ...overrides,
  };
}

describe("applyFinanceCommitteeLabels", () => {
  it("labels matching groups and leaves unmatched groups untouched", async () => {
    const target = summary();
    const other = summary();
    other.outside_spending.top_opposing_groups = [
      {
        committee_id: "999",
        committee_name: "Some Other PAC",
        support_oppose: "oppose",
        amount: 100,
        source_url: null,
      },
    ];
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          source: "LOS_ANGELES_CITY_ETHICS",
          committee_id: "1461461",
          cycle: 2026,
          label: "Transportation-advocacy PAC focused on bike and bus infrastructure",
          source_urls: ["https://ethics.lacity.org/data/campaigns/"],
        },
      ],
    });

    await applyFinanceCommitteeLabels({ query }, [target, null, other]);

    expect(target.outside_spending.top_supporting_groups[0].label).toBe(
      "Transportation-advocacy PAC focused on bike and bus infrastructure"
    );
    // The label's evidence rides along with it.
    expect(target.outside_spending.top_supporting_groups[0].label_source_urls).toEqual([
      "https://ethics.lacity.org/data/campaigns/",
    ]);
    // The same committee in a second summary is labeled too…
    expect(other.outside_spending.top_supporting_groups[0].label).toBe(
      "Transportation-advocacy PAC focused on bike and bus infrastructure"
    );
    // …while a committee with no researched label stays untouched.
    expect(other.outside_spending.top_opposing_groups[0].label).toBeUndefined();
    // One batched query with paired arrays (cycle-scoped), deduplicated
    // across summaries.
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual([
      ["LOS_ANGELES_CITY_ETHICS", "LOS_ANGELES_CITY_ETHICS"],
      ["1461461", "999"],
      [2026, 2026],
    ]);
  });

  it("does not apply a label researched for a different cycle", async () => {
    const target = summary({ cycle: 2028 });
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await applyFinanceCommitteeLabels({ query }, [target]);

    // The lookup itself asks for the summary's own cycle…
    expect(query.mock.calls[0]?.[1]).toEqual([["LOS_ANGELES_CITY_ETHICS"], ["1461461"], [2028]]);
    // …and nothing matches, so the group stays unlabeled.
    expect(target.outside_spending.top_supporting_groups[0].label).toBeUndefined();
  });

  it("issues no query when the summaries carry no outside groups", async () => {
    const empty = summary();
    empty.outside_spending.top_supporting_groups = [];
    const query = vi.fn();

    await applyFinanceCommitteeLabels({ query }, [empty, null, undefined]);

    expect(query).not.toHaveBeenCalled();
  });

  it("is fault-isolated: a failing query leaves the groups unlabeled", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const target = summary();
    const query = vi.fn().mockRejectedValue(new Error("relation does not exist"));

    await expect(applyFinanceCommitteeLabels({ query }, [target])).resolves.toBeUndefined();

    expect(target.outside_spending.top_supporting_groups[0].label).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("labels conduit groups the same way as outside groups", async () => {
    const target = summary({ source: "FEC" });
    target.outside_spending.top_supporting_groups = [];
    target.direct_campaign.conduit_donations = [
      { committee_id: "C00000021", committee_name: "CONDUIT GROUP A PAC", amount: 40000, contribution_count: 12, source_url: null },
      { committee_id: "C00000022", committee_name: "CONDUIT GROUP B PAC", amount: 40000, contribution_count: 9, source_url: null },
    ];
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          source: "FEC",
          committee_id: "C00000021",
          cycle: 2026,
          label: "A group that backs candidates who support stricter gun laws.",
          source_urls: ["https://example.org/about-a"],
        },
      ],
    });

    await applyFinanceCommitteeLabels({ query }, [target]);

    expect(query.mock.calls[0]?.[1]).toEqual([["FEC", "FEC"], ["C00000021", "C00000022"], [2026, 2026]]);
    expect(target.direct_campaign.conduit_donations?.[0]).toMatchObject({
      label: "A group that backs candidates who support stricter gun laws.",
      label_source_urls: ["https://example.org/about-a"],
    });
    expect(target.direct_campaign.conduit_donations?.[1]).not.toHaveProperty("label");
  });
});
