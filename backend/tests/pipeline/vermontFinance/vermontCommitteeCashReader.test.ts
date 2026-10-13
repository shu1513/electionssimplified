import { describe, expect, it, vi } from "vitest";
import { candidateElectionKey, type BallotLookupFinanceSummary } from "../../../src/pipeline/address/ballotLookupFinanceShared.js";
import {
  addVermontCommitteeCashToSummaries, groupVermontCommitteeCashByInterest,
  type VermontCommitteeCashReaderRow,
} from "../../../src/pipeline/vermontFinance/vermontCommitteeCashReader.js";

const row: VermontCommitteeCashReaderRow = {
  candidate_id: "candidate", election_id: "general", election_year: 2026,
  receiving_filer_guid: "receiver", observed_at: "2026-10-12T12:00:00Z",
  period_start: "2024-12-13", period_end: "2026-09-28",
  committee_id: "reported:VERMONT REALTORS PAC", committee_name: "VERMONT REALTORS PAC",
  amount: "5180.00", source_url: "https://campaignfinance.vermont.gov/",
  industry_slug: null, classification_source: null, confidence: null,
};
const key = candidateElectionKey(row.candidate_id,row.election_id);
const requests = [{ candidate_id: row.candidate_id,election_id: row.election_id }];
function summary(): BallotLookupFinanceSummary {
  return { source: "VERMONT_CFD",cycle: 2026,fec_candidate_id: null,last_synced_at: "old-direct-observation",
    direct_campaign: { total_raised: 400000,total_spent: null,cash_on_hand: null,debts_owed: null,
      top_occupations: [],top_industries: [],contribution_size_buckets: [{ category_name: "small",amount: 123,contributor_count: 3,source_url: "direct" }] },
    outside_spending: { support_total: 0,oppose_total: 0,top_supporting_groups: [{ committee_id: "stored",committee_name: "Stored transfer",amount: 99,support_oppose: "support",source_url: "outside" }],
      top_opposing_groups: [],top_supporting_industries: [],top_opposing_industries: [] },
    backing_summary: { top_direct_donor_occupations: [],top_outside_supporting_industries: [] } };
}

describe("Vermont accepted committee cash reader", () => {
  it("puts unknown named PACs in Not yet sorted without promoting them by name", () => {
    const groups = groupVermontCommitteeCashByInterest([{ ...row,committee_id: "reported:MYSTERY",committee_name: "Mystery",amount: 6000 }]).get(key)!;
    expect(groups).toMatchObject([{ interest: "unclassified",interest_name: "Not yet sorted",amount: 6000,pac_count: 1 }]);
  });
  it("uses cached manual classifications and high-confidence rules without provider calls", () => {
    const groups = groupVermontCommitteeCashByInterest([{ ...row,industry_slug: "labor_unions",classification_source: "manual",confidence: "low" }]).get(key)!;
    expect(groups[0]?.interest).toBe("labor_unions");
  });
  it("ignores zero, negative and invalid net positions", () => {
    expect(groupVermontCommitteeCashByInterest(["0", "-6000", "NaN"].map(amount => ({ ...row,amount }))).size).toBe(0);
  });
  it("caps donor detail only after full interest amount and count", () => {
    const groups = groupVermontCommitteeCashByInterest(Array.from({ length: 8 },(_,i) => ({ ...row,committee_id: `reported:${i}`,committee_name: `Unknown ${i}`,amount: 1000 }))).get(key)!;
    expect(groups[0]).toMatchObject({ amount: 8000,pac_count: 8 });
    expect(groups[0]?.pacs).toHaveLength(5);
  });
  it("keeps separate direct freshness, numbers and stored transfer groups", async () => {
    const original = summary();
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    const output = await addVermontCommitteeCashToSummaries({ query } as never,requests,new Map([[key,original]]));
    expect(output.get(key)?.last_synced_at).toBe("old-direct-observation");
    expect(output.get(key)?.direct_campaign.total_raised).toBe(400000);
    expect(output.get(key)?.direct_campaign.contribution_size_buckets?.[0]?.amount).toBe(123);
    expect(output.get(key)?.direct_campaign.pac_money_by_interest?.[0]?.amount).toBe(5180);
    expect(output.get(key)?.direct_campaign.direct_coverage_note).toContain("through 2026-09-28");
    expect(output.get(key)?.outside_spending).toMatchObject({ support_total: null,oppose_total: null,top_supporting_groups: [{ committee_id: "stored",amount: 99 }] });
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain("donor.capture_digest=source.capture_digest");
    expect(sql).toContain("sum(donor.amount)");
    expect(sql).not.toMatch(/donor.amount\s*>/);
    expect(sql).toContain("source.receiving_context=jsonb_build_object");
    expect(sql).toContain("sibling.candidate_id=link.candidate_id AND sibling.election_id=link.election_id");
    expect(sql).toContain("lower(other.filer_registration_guid)=lower(link.filer_registration_guid)");
  });
  it("loads cash independently when no legacy direct summary exists", async () => {
    const output = await addVermontCommitteeCashToSummaries({ query: vi.fn().mockResolvedValue({ rows: [row] }) } as never,requests,new Map());
    expect(output.get(key)?.direct_campaign).toMatchObject({ total_raised: null,pac_money_by_interest: [{ amount: 5180 }] });
  });
  it("distinguishes accepted empty PAC positions from absent source coverage", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ...row,committee_id: null,committee_name: null,amount: null }] });
    const output = await addVermontCommitteeCashToSummaries({ query } as never,requests,new Map([[key,summary()]]));
    expect(output.get(key)?.direct_campaign.pac_money_by_interest).toEqual([]);
    query.mockResolvedValue({ rows: [] });
    const absent = await addVermontCommitteeCashToSummaries({ query } as never,requests,new Map([[key,summary()]]));
    expect(absent.get(key)?.direct_campaign.pac_money_by_interest).toBeUndefined();
    expect(absent.get(key)?.last_synced_at).toBe("old-direct-observation");
  });
  it("propagates read failures instead of manufacturing an empty PAC generation", async () => {
    await expect(addVermontCommitteeCashToSummaries({ query: vi.fn().mockRejectedValue(new Error("read failed")) } as never,requests,new Map([[key,summary()]]))).rejects.toThrow("read failed");
  });
});
