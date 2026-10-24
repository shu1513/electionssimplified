import { describe, expect, it, vi } from "vitest";
import { appendWisconsinCommitteeCashSummaries } from "../../../src/pipeline/wisconsinFinance/wisconsinCommitteeCashBallotSummary.js";
import type { BallotLookupFinanceSummary } from "../../../src/pipeline/address/ballotLookupFinanceShared.js";
const key = "candidate\u0000election";
const requests = [{candidate_id:"candidate",election_id:"election"}];
function row(overrides: Record<string,unknown> = {}) { return {
  candidate_id:"candidate",election_id:"election",election_year:2026,observed_at:"2026-10-23T12:00:00.000Z",
  regular_coverage_through:"2026-09-23",group_count:1,cash_cents:"95000",committee_id:"77",committee_name:"Example Labor PAC",
  amount_cents:"95000",contribution_count:2,evidence_type:"native_registry_class",source_url:"https://campaignfinance.wi.gov/",
  industry_slug:null,classification_source:null,confidence:null,...overrides
}; }
async function load(rows: ReturnType<typeof row>[], map = new Map<string,BallotLookupFinanceSummary>()) {
  const db = {query:vi.fn(async()=>({rows}))}; await appendWisconsinCommitteeCashSummaries(db as never,requests,map); return {map,db};
}
describe("Wisconsin complete stored cash admission",()=>{
  it("exposes signed cash separately while keeping unverified direct totals and IE unknown",async()=>{
    const {map,db}=await load([row()]);const s=map.get(key)!;
    expect(s.direct_campaign).toMatchObject({total_raised:null,pac_money_basis:"reported_committee_monetary_positions"});
    expect(s.direct_campaign.pac_money_by_interest?.[0]?.amount).toBe(950);
    expect(s.outside_spending).toMatchObject({support_total:null,oppose_total:null});
    expect(s.direct_campaign.pac_money_coverage_note).toContain("limited subset");
    expect(db.query.mock.calls[0]?.[0]).toContain("s.candidate_name");
  });
  it.each([
    {group_count:2},{cash_cents:"95001"},{amount_cents:"1.5"},{amount_cents:"9007199254740993"},
    {contribution_count:-1},{evidence_type:"inferred"},{observed_at:"bad-date"}
  ])("rejects an incomplete or invalid snapshot %o",async bad=>{
    expect((await load([row(bad)])).map.size).toBe(0);
  });
  it("rejects repeated native identity rather than double counting",async()=>{
    expect((await load([row({group_count:2,cash_cents:"190000"}),row({group_count:2,cash_cents:"190000"})])).map.size).toBe(0);
  });
  it("accepts refund-only negative positions",async()=>{
    const {map}=await load([row({cash_cents:"-5000",amount_cents:"-5000",contribution_count:0})]);
    expect(map.get(key)?.direct_campaign.pac_money_by_interest?.[0]?.amount).toBe(-50);
  });
  it("checks the uncapped snapshot before taking five displayed committees",async()=>{
    const rows=Array.from({length:7},(_,i)=>row({committee_id:String(i),group_count:7,cash_cents:"665000"}));
    const {map}=await load(rows); const group=map.get(key)!.direct_campaign.pac_money_by_interest![0]!;
    expect(group).toMatchObject({amount:6650,pac_count:7});expect(group.pacs).toHaveLength(5);
    rows[6]!.amount_cents="94999";expect((await load(rows)).map.size).toBe(0);
  });
  it("preserves existing money and source clock, and invalid snapshots do not mutate it",async()=>{
    const {map}=await load([row()]);const s=map.get(key)!;
    s.last_synced_at="2026-01-01T00:00:00.000Z";s.direct_campaign.total_raised=123;
    s.outside_spending.support_total=45;
    await load([row({cash_cents:"999"})],map);expect(map.get(key)).toBe(s);
    await load([row()],map);expect(s.last_synced_at).toBe("2026-01-01T00:00:00.000Z");
    expect(s.direct_campaign.total_raised).toBe(123);expect(s.outside_spending.support_total).toBe(45);
  });
  it("admits an explicitly empty snapshot without inventing outside totals",async()=>{
    const {map}=await load([row({group_count:0,cash_cents:"0",committee_id:null,committee_name:null,amount_cents:null,contribution_count:null,evidence_type:null})]);
    expect(map.get(key)?.direct_campaign.pac_money_by_interest).toEqual([]);
    expect(map.get(key)?.outside_spending.support_total).toBeNull();
  });
});
