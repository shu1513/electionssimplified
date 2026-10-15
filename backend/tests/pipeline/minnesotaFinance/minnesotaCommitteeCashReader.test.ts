import { describe, expect, it, vi } from "vitest";
import { candidateElectionKey, type BallotLookupFinanceSummary } from "../../../src/pipeline/address/ballotLookupFinanceShared.js";
import { addMinnesotaCommitteeCashToSummaries, groupMinnesotaCommitteeCashByInterest } from "../../../src/pipeline/minnesotaFinance/minnesotaCommitteeCashReader.js";

const row: Parameters<typeof groupMinnesotaCommitteeCashByInterest>[0][number] = {
  candidate_id: "candidate", election_id: "general", election_year: 2026, receiving_committee_id: "1001",
  source_observed_at: "2026-10-15T12:00:00Z", excluded_unknown_class_row_count: "2",
  reported_committee_id: "3001", reported_committee_name: "Example Committee", amount: "6000.25",
  source_url: "https://register.cfb.mn.gov/downloads/contributions.csv",
  industry_slug: null, classification_source: null, confidence: null,
};
const key = candidateElectionKey(row.candidate_id, row.election_id);
const requests = [{ candidate_id: row.candidate_id, election_id: row.election_id }];
function summary(): BallotLookupFinanceSummary {
  return { source: "MINNESOTA_CFB", cycle: 2026, fec_candidate_id: null, last_synced_at: "old-summary-time",
    direct_campaign: { total_raised: 400000, total_spent: null, cash_on_hand: null, debts_owed: null,
      top_occupations: [], top_industries: [] },
    outside_spending: { support_total: 500, oppose_total: null, top_supporting_groups: [], top_opposing_groups: [],
      top_supporting_industries: [], top_opposing_industries: [] },
    backing_summary: { top_direct_donor_occupations: [], top_outside_supporting_industries: [] } };
}
describe("Minnesota reported committee cash reader", () => {
  it("keeps reported name variants as distinct groups under Not yet sorted", () => {
    const output = groupMinnesotaCommitteeCashByInterest([row, { ...row, reported_committee_name: "EXAMPLE COMMITTEE", amount: "1.00" }]);
    expect(output.get(key)).toMatchObject([{ interest_name: "Not yet sorted", amount: 6001.25, pac_count: 2 }]);
    expect(output.get(key)?.[0]?.pacs).toHaveLength(2);
  });
  it("uses stored manual interests without making provider calls", () => {
    expect(groupMinnesotaCommitteeCashByInterest([{ ...row, industry_slug: "labor_unions", classification_source: "manual", confidence: "low" }])
      .get(key)?.[0]?.interest).toBe("labor_unions");
  });
  it.each(["leadership_pacs", "candidate_committees"])("keeps native qualified gifts under Not yet sorted when interest %s is otherwise suppressed", (interest) => {
    const output = groupMinnesotaCommitteeCashByInterest([{ ...row, industry_slug: interest,
      classification_source: "manual", confidence: "high" }]).get(key)!;
    expect(output[0]).toMatchObject({ interest: "unclassified", amount: 6000.25, pac_count: 1 });
  });
  it("combines one reported donor across receiving committees before counting groups", () => {
    const output = groupMinnesotaCommitteeCashByInterest([row, { ...row, receiving_committee_id: "1002", amount: "1.00" }]).get(key)!;
    expect(output[0]).toMatchObject({ amount: 6001.25, pac_count: 1, pacs: [{ amount: 6001.25 }] });
  });
  it("caps details only after computing full interest totals/counts", () => {
    const output = groupMinnesotaCommitteeCashByInterest(Array.from({ length: 8 }, (_, i) => ({ ...row,
      reported_committee_id: String(3001 + i), reported_committee_name: `Example ${i}`, amount: "1000.00" }))).get(key)!;
    expect(output[0]).toMatchObject({ amount: 8000, pac_count: 8 });
    expect(output[0]?.pacs).toHaveLength(5);
  });
  it("leaves legacy Raised, freshness and outside amounts unchanged", async () => {
    const original = summary();
    const query = vi.fn().mockResolvedValue({ rows: [row, { ...row, reported_committee_id: "3002" }] });
    const output = (await addMinnesotaCommitteeCashToSummaries({ query } as never, requests, new Map([[key, original]]))).get(key)!;
    expect(output.direct_campaign.total_raised).toBe(400000);
    expect(output.last_synced_at).toBe("old-summary-time");
    expect(output.outside_spending.support_total).toBe(500);
    expect(output.direct_campaign.pac_money_basis).toBe("reported_itemized_committee_cash_contributions");
    expect(output.direct_campaign.pac_money_coverage_note).toBe(
      "Itemized cash from Minnesota political committees and funds reported for 2025–2026; " +
      "other donors, unitemized gifts, in-kind gifts and later returns are not included.");
    expect(query.mock.calls[0]?.[0]).toContain("donor.source_sha256=source.source_sha256");
  });
  it("loads cash without requiring a legacy financial summary", async () => {
    const output = (await addMinnesotaCommitteeCashToSummaries({ query: vi.fn().mockResolvedValue({ rows: [row] }) } as never,
      requests, new Map())).get(key)!;
    expect(output.direct_campaign).toMatchObject({ total_raised: null, pac_money_by_interest: [{ amount: 6000.25 }] });
    expect(output.last_synced_at).toBe("2026-10-15T12:00:00.000Z");
    expect(output.direct_campaign.pac_money_coverage_note).toContain("later returns are not included");
  });
  it("distinguishes complete empty typed cash from missing source coverage", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ...row, reported_committee_id: null, reported_committee_name: null, amount: null }] });
    expect((await addMinnesotaCommitteeCashToSummaries({ query } as never, requests, new Map([[key, summary()]])))
      .get(key)?.direct_campaign.pac_money_by_interest).toEqual([]);
    query.mockResolvedValue({ rows: [] });
    expect((await addMinnesotaCommitteeCashToSummaries({ query } as never, requests, new Map([[key, summary()]])))
      .get(key)?.direct_campaign.pac_money_by_interest).toBeUndefined();
  });
  it("propagates query failures without inventing cash zero", async () => {
    await expect(addMinnesotaCommitteeCashToSummaries({ query: vi.fn().mockRejectedValue(new Error("read failed")) } as never,
      requests, new Map())).rejects.toThrow("read failed");
  });
});
