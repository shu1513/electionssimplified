import { describe, expect, it, vi } from "vitest";
import { appendLosAngelesReportedCommitteeCash } from "../../../src/pipeline/losAngelesCityFinance/losAngelesReportedCommitteeCashBallotSummary.js";
import { candidateElectionKey, type BallotLookupFinanceSummary } from "../../../src/pipeline/address/ballotLookupFinanceShared.js";
const key = candidateElectionKey("c", "e");
function summaries() {
  return new Map([[key, { source: "LOS_ANGELES_CITY_ETHICS", cycle: 2026, fec_candidate_id: null, last_synced_at: "2026-10-20T00:00:00Z",
    direct_campaign: { total_raised: 20_000, total_spent: 10_000, cash_on_hand: 10_000, debts_owed: null, top_occupations: [], top_industries: [] },
    outside_spending: { support_total: null, oppose_total: null, top_supporting_groups: [], top_opposing_groups: [], top_supporting_industries: [], top_opposing_industries: [] },
    backing_summary: { top_direct_donor_occupations: [], top_outside_supporting_industries: [] } } as BallotLookupFinanceSummary]]);
}
function row(over: Record<string, unknown> = {}) {
  return { candidate_id: "c", election_id: "e", candidate_name: "Alex Example", candidate_name_normalized: "ALEX EXAMPLE",
    office_name: "City Council Member", official_ballot_title: "City Council Member, District 1", seat_number: 1, state:"CA",district_type:"place",geoid_compact:"0644000",office_scope:"place",
    amount_cents: "700000", contribution_count: 7, group_count: 7, reported_through: "2026-09-24", observed_at: "2026-10-24T12:00:00Z",
    committee_key: "EXAMPLE QUORUM PAC", committee_name: "Example Quorum PAC", donor_cents: "100000", donor_count: 1,
    industry_slug: null, classification_source: null, confidence: null, ...over };
}
const rows = () => Array.from({ length: 7 }, (_, i) => row({ committee_key: `EXAMPLE QUORUM ${i} PAC`, committee_name: `Example Quorum ${i} PAC` }));
describe("LosAngeles committee cash ballot summary", () => {
  it("closes all donors before caps and keeps unclassified names under Not yet sorted", async () => {
    const result = summaries(), query = vi.fn().mockResolvedValue({ rows: rows() });
    await appendLosAngelesReportedCommitteeCash({ query } as never, result);
    const direct = result.get(key)!.direct_campaign;
    expect(direct.pac_money_by_interest).toMatchObject([{ interest_name: "Not yet sorted", amount: 7000, pac_count: 7 }]);
    expect(direct.pac_money_by_interest![0]!.pacs).toHaveLength(5);
    expect(direct.pac_money_coverage_note).toContain("not registry identities");
    expect(direct.total_raised).toBe(20_000);
    expect(result.get(key)!.last_synced_at).toBe("2026-10-20T00:00:00Z");
  });
  it.each(["amount", "count", "duplicate", "canonical name", "seat"])("omits a broken %s component instead of returning an empty result", async kind => {
    const values = rows();
    if (kind === "amount") values[6]!.donor_cents = "1";
    if (kind === "count") values[6]!.donor_count = 2;
    if (kind === "duplicate") values[6] = values[0]!;
    if (kind === "canonical name") for (const value of values) value.candidate_name = "Different Person";
    if (kind === "seat") for (const value of values) value.official_ballot_title = "City Council Member, District 2";
    const result = summaries();
    await appendLosAngelesReportedCommitteeCash({ query: vi.fn().mockResolvedValue({ rows: values }) } as never, result);
    expect(result.get(key)!.direct_campaign.pac_money_by_interest).toBeUndefined();
  });
  it("does not turn product-excluded positive interests into a false no-donations message", async () => {
    const result = summaries();
    await appendLosAngelesReportedCommitteeCash({ query: vi.fn().mockResolvedValue({ rows: rows().map(r => ({ ...r,
      industry_slug: "candidate_committees", classification_source: "manual" })) }) } as never, result);
    expect(result.get(key)!.direct_campaign.pac_money_by_interest).toBeUndefined();
  });
  it("requires a qualified zero source before exposing an empty committee list", async () => {
    const result = summaries();
    await appendLosAngelesReportedCommitteeCash({ query: vi.fn().mockResolvedValue({ rows: [row({ amount_cents: "0", contribution_count: 0,
      group_count: 0, committee_key: null, committee_name: null, donor_cents: null, donor_count: null })] }) } as never, result);
    expect(result.get(key)!.direct_campaign.pac_money_by_interest).toEqual([]);
  });
});
