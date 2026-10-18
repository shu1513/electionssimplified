import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { candidateElectionKey, type BallotLookupFinanceSummary } from "../../../src/pipeline/address/ballotLookupFinanceShared.js";
import { createNewHampshireReportedSourceProducer, type NewHampshireReportedSourcePacket } from "../../../src/pipeline/newHampshireFinance/newHampshireReportedSourceCache.js";
import { aggregateNewHampshireReportedCommitteeReceipts, aggregateNewHampshireReportedIe } from "../../../src/pipeline/newHampshireFinance/newHampshireReportedFinanceAggregation.js";
import { attachNewHampshireReportedFinance as attach } from "../../../src/pipeline/newHampshireFinance/newHampshireReportedFinanceReader.js";
import { guid, nativeFixture } from "./newHampshireReportedTestFixtures.js";

let cacheDir:string;
const request={candidate_id:guid(501),election_id:guid(502)},key=candidateElectionKey(request.candidate_id,request.election_id);
beforeEach(async()=>{cacheDir=await mkdtemp(join(tmpdir(),"nh-reported-reader-test-"));
  for(const name of["NEW_HAMPSHIRE_CAMPAIGN_FINANCE_ENABLED","NEW_HAMPSHIRE_REPORTED_IE_ENABLED","NEW_HAMPSHIRE_REPORTED_COMMITTEE_RECEIPTS_ENABLED"])vi.stubEnv(name,"true");});
afterEach(async()=>{vi.unstubAllEnvs();await rm(cacheDir,{recursive:true,force:true});});
function legacy():BallotLookupFinanceSummary{return{source:"NEW_HAMPSHIRE_CFS",cycle:2026,fec_candidate_id:null,controlled_committee_id:"1000",last_synced_at:"2026-01-01T00:00:00.000Z",
  direct_campaign:{total_raised:12345,total_spent:null,cash_on_hand:null,debts_owed:null,top_occupations:[],top_employers:[],top_industries:[],contribution_size_buckets:[]},
  outside_spending:{support_total:10,oppose_total:20,top_supporting_groups:[],top_opposing_groups:[],top_supporting_industries:[],top_opposing_industries:[]},
  backing_summary:{top_direct_donor_occupations:[],top_outside_supporting_industries:[]}};}
async function setup(kind:"committee"|"ie",change?:(state:ReturnType<typeof nativeFixture>["state"])=>void){
  const fixture=nativeFixture();change?.(fixture.state);
  const producer=createNewHampshireReportedSourceProducer({cacheDir,fetchImpl:fixture.fetchImpl,minimumGapMs:0}),base=await producer.refreshBase(2026);
  const source=await producer.refreshComponent({kind,electionYear:2026,base:base!.reference,...(kind==="committee"?{filingEntityId:1000}:{})});
  return source!;
}
function rows(source:NewHampshireReportedSourcePacket):Record<string,unknown>[] {
  const committee=source.kind==="committee"?aggregateNewHampshireReportedCommitteeReceipts(source):null,
    ie=source.kind==="ie"?aggregateNewHampshireReportedIe({source,candidateAliases:["Synthetic Candidate"]}):null;
  const groups=committee?committee.groups.map(g=>({grp_key:g.reportedNameKey,grp_id:null,grp_name:g.reportedName,grp_stance:"direct",grp_cents:String(g.amountCents),grp_count:g.contributionCount})):
    ie!.groups.map(g=>({grp_key:g.reportedSpenderId,grp_id:g.reportedSpenderId,grp_name:g.reportedSpenderName,grp_stance:g.supportOppose,grp_cents:String(g.amountCents),grp_count:g.expenditureCount}));
  const meta={...request,source_candidate_id:request.candidate_id,source_election_id:request.election_id,link_id:guid(500),current_link_id:guid(500),
    active_link_count:"1",link_source:"cfs_registration",link_year:2026,calendar_year:2026,election_year:2026,current_receiver:"1000",receiving_entity_id:"1000",registration_guid:guid(1000),component:source.kind,
    source_row_count:source.sourceRowCount,current_row_count:source.currentRows.length,historical_row_count:source.historicalRowCount,
    occurrence_count:committee?.contributionCount??ie!.expenditureCount,group_count:groups.length,
    excluded_current_row_count:committee?.excludedCurrentRowCount??source.currentRows.length-ie!.matchedTargetRowCount,nonpositive_row_count:ie?.nonPositiveRowCount??0,
    total_amount_cents:String(committee?.totalAmountCents??ie!.supportTotalCents+ie!.opposeTotalCents),support_total_cents:String(ie?.supportTotalCents??0),oppose_total_cents:String(ie?.opposeTotalCents??0),
    source_url:source.sourceUrl,source_retrieved_at:source.sourceRetrievedAt,source_completed_at:source.sourceCompletedAt,source_base_retrieved_at:source.sourceBaseRetrievedAt,
    source_manifest_sha256:source.sourceManifestSha256,source_byte_size:String(source.sourceByteSize),source_controls:structuredClone(source.sourceControls),last_synced_at:new Date().toISOString()};
  return groups.length?groups.map(group=>({...meta,...group})):[{...meta,grp_key:null,grp_id:null,grp_name:null,grp_stance:null,grp_cents:null,grp_count:null}];
}
async function read(inputRows:Record<string,unknown>[],summaries=new Map([[key,legacy()]])){
  const query=vi.fn(async()=>({rows:inputRows}));
  return{output:await attach({db:{query},requests:[request],summaries}),query};
}

describe("New Hampshire reported components in the real finance loader",()=>{
  it("adds committee groups with their source date without changing legacy headlines or their clock",async()=>{
    const source=await setup("committee"),result=(await read(rows(source))).output.get(key)!;
    expect(result.direct_campaign.total_raised).toBe(12345);expect(result.last_synced_at).toBe(legacy().last_synced_at);
    expect(result.direct_campaign.pac_money_basis).toBe("reported_committee_itemized_contributions");
    expect(result.direct_campaign.pac_money_by_interest?.[0]).toMatchObject({amount:100,pac_count:1});
    expect(result.direct_campaign.pac_money_coverage_note).toContain("in-kind");expect(result.direct_campaign.pac_money_coverage_note).toContain(source.sourceRetrievedAt.slice(0,10));
  });

  it("replaces outside amounts from independent IE while preserving direct money",async()=>{
    const source=await setup("ie"),result=(await read(rows(source))).output.get(key)!;
    expect(result.direct_campaign).toEqual(legacy().direct_campaign);expect(result.last_synced_at).toBe(legacy().last_synced_at);
    expect(result.outside_spending).toMatchObject({support_total:12000,oppose_total:0,top_supporting_groups:[{amount:12000,expenditure_count:1}]});
    expect(result.outside_spending.outside_coverage_note).toContain(source.sourceRetrievedAt.slice(0,10));
  });

  it("builds an IE-only card with campaign receipts unknown",async()=>{
    const source=await setup("ie"),result=(await read(rows(source),new Map())).output.get(key)!;
    expect(result.direct_campaign.total_raised).toBeNull();expect(result.outside_spending.support_total).toBe(12000);
    expect(result.last_synced_at).toBe(source.sourceRetrievedAt);
  });

  it("retains full group totals/counts before applying display limits",async()=>{
    const source=await setup("committee",state=>{
      for(let i=0;i<15;i++)state.receipts.push({...state.receipts[0]!,transactionId:800+i,guid:guid(10800+i),sourceName:`Synthetic Committee ${i}`,transactionAmount:50+i});
    });
    const aggregation=aggregateNewHampshireReportedCommitteeReceipts(source),result=(await read(rows(source))).output.get(key)!;
    const interests=result.direct_campaign.pac_money_by_interest!;
    expect(interests.reduce((s,g)=>s+g.amount,0)).toBe(aggregation.totalAmountCents/100);
    expect(interests.reduce((s,g)=>s+g.pac_count,0)).toBe(16);
    expect(interests[0]!.pacs.length).toBe(5);
  });

  it("distinguishes a qualified committee zero from an unavailable component",async()=>{
    const source=await setup("committee",state=>{for(const row of state.receipts)row.transactionSourceTypeCode="TIND";});
    expect((await read(rows(source))).output.get(key)!.direct_campaign.pac_money_by_interest).toEqual([]);
    expect((await read([])).output.get(key)!.direct_campaign.pac_money_by_interest).toBeUndefined();
  });

  it.each(["source_controls","group_count","receiving_entity_id","source_candidate_id","source_election_id"])("holds an invalid stored %s without replacing prior money",async field=>{
    const source=await setup("ie"),input=rows(source);
    input[0]![field]=field==="source_controls"?null:field==="group_count"?2:"invalid";
    const result=(await read(input)).output.get(key)!;
    expect(result.outside_spending.support_total).toBe(10);expect(result.outside_spending.oppose_total).toBe(20);
    expect(result.direct_campaign.total_raised).toBe(12345);expect(result.last_synced_at).toBe(legacy().last_synced_at);
  });

  it("holds an incomplete uncapped group population",async()=>{
    const source=await setup("committee"),input=rows(source);input[0]!.grp_cents="1";
    expect((await read(input)).output.get(key)!.direct_campaign.pac_money_by_interest).toBeUndefined();
  });

  it("does not query disabled components",async()=>{
    vi.stubEnv("NEW_HAMPSHIRE_REPORTED_IE_ENABLED","false");vi.stubEnv("NEW_HAMPSHIRE_REPORTED_COMMITTEE_RECEIPTS_ENABLED","false");
    const result=await read([]);expect(result.query).not.toHaveBeenCalled();expect(result.output.get(key)).toEqual(legacy());
  });
});
