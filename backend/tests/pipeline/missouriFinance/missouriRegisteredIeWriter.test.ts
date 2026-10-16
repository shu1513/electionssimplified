import { describe,expect,it,vi } from "vitest";
import {
  prepareMissouriRegisteredIeComponent as prepare,
  replaceMissouriRegisteredIeRows as replace,
  type MissouriRegisteredIeComponent,
} from "../../../src/pipeline/missouriFinance/missouriRegisteredIeWriter.js";
import { createStandardStateFinanceSnapshotWriter } from "../../../src/pipeline/finance/standardStateFinanceSnapshotWriter.js";

const candidateId="11111111-1111-4111-8111-111111111111";
const electionId="22222222-2222-4222-8222-222222222222";
const linkId="33333333-3333-4333-8333-333333333333";
const secondLinkId="44444444-4444-4444-8444-444444444444";
const syncedAt=new Date("2026-10-15T12:00:00Z");
function component(groups=2):MissouriRegisteredIeComponent {
  return {
    candidateId,electionId,receivingCommitteeId:"A123456",cycleStart:"2026-08-04",cycleEnd:"2026-11-03",
    sourceRetrievedAt:new Date("2026-10-14T12:00:00Z"),
    sourceUrl:"https://www.mec.mo.gov/MEC/Campaign_Finance/CF_SearchDirExp.aspx",
    sourceSha256:"a".repeat(64),sourceByteSize:1234,sourcePageCount:2,sourceRowCount:groups+3,
    aggregation:{
      status:"qualified",sourceRowCount:groups+3,candidateNameRowCount:groups+2,
      candidateOfficeMismatchRowCount:1,outsideCycleRowCount:1,matchedRowCount:groups,
      zeroAmountRowCount:0,includedExpenditureRowCount:groups,negativeAmountRowCount:0,
      ambiguousLineageRowCount:0,timelyOverlapRowCount:0,
      supportAmountCents:Math.ceil(groups/2)*101,opposeAmountCents:Math.floor(groups/2)*101,
      groups:Array.from({length:groups},(_,i)=>({reportedCommitteeName:"Example Committee "+i,
        reportedNameKey:"EXAMPLE COMMITTEE "+i,supportOppose:i%2===0?"support" as const:"oppose" as const,
        amountCents:101,expenditureCount:1})),
    },
  };
}
const q=(c:MissouriRegisteredIeComponent)=>c.aggregation as Extract<typeof c.aggregation,{status:"qualified"}>;
const prepared=(c=component())=>prepare({component:c,candidateId,electionId,electionYear:2026,
  receivingCommitteeId:" a123456 ",syncedAt})!;
function dbWith(options:{prior?:Date;priorHash?:string;inactive?:boolean;rejectUpsert?:boolean;failGroup?:boolean}={}) {
  const state:{source:({source_retrieved_at:Date|string;source_sha256:string}&Record<string,unknown>)|null;groups:unknown[][]}={
    source:options.prior?{source_retrieved_at:options.prior,source_sha256:options.priorHash??"a".repeat(64)}:null,
    groups:[["previous independent group"]],
  };
  let rollbackState=structuredClone(state);
  const query=vi.fn(async(sql:unknown,values?:unknown[])=>{
    const s=String(sql);
    if(s==="BEGIN"){rollbackState=structuredClone(state);return{rows:[],rowCount:0};}
    if(s==="ROLLBACK"){state.source=rollbackState.source;state.groups=rollbackState.groups;return{rows:[],rowCount:0};}
    if(s.startsWith("SELECT id FROM public.mo_candidate_finance_links")) {
      return{rows:options.inactive?[]:[{id:linkId}],rowCount:options.inactive?0:1};
    }
    if(s.startsWith("SELECT source_retrieved_at,source_sha256"))return{rows:state.source?[state.source]:[],rowCount:state.source?1:0};
    if(s.startsWith("INSERT INTO public.mo_candidate_finance_registered_ie_sources")){
      if(options.rejectUpsert)return{rows:[],rowCount:0};
      const columns=s.match(/\(([^)]+)\) VALUES/)![1]!.split(",");
      state.source={...Object.fromEntries(columns.map((key,i)=>[key,values?.[i]])),
        source_retrieved_at:String(values?.[23]),source_sha256:String(values?.[24])};
      return{rows:[{candidate_id:candidateId}],rowCount:1};
    }
    if(s.startsWith("DELETE FROM public.mo_candidate_finance_registered_ie_groups")){state.groups=[];return{rows:[],rowCount:1};}
    if(s.startsWith("INSERT INTO public.mo_candidate_finance_registered_ie_groups")){
      if(options.failGroup)throw new Error("synthetic private database payload");
      state.groups.push([...(values??[])]);return{rows:[],rowCount:1};
    }
    if(s.includes("INSERT INTO public.mo_candidate_finance_links"))return{rows:[{id:linkId,link_status:"active",link_source:"mec_portal",election_year:2026}],rowCount:1};
    return{rows:[],rowCount:0};
  });
  const release=vi.fn();
  return{query,release,connect:vi.fn(async()=>({query,release})),state};
}
const tables={links:"mo_candidate_finance_links",summaries:"mo_candidate_finance_summaries",
  directBreakdowns:"mo_candidate_finance_direct_breakdowns",outsideGroups:"mo_candidate_finance_outside_groups",
  outsideGroupBreakdowns:"mo_candidate_finance_outside_group_breakdowns"};
const protectedWriter=createStandardStateFinanceSnapshotWriter({label:"Missouri",minElectionYear:2024,
  normalizeCommitteeId:id=>id,supersededLinkSource:"mec_portal",manualLinkProtection:true,tables});
function protectedWrite(db:ReturnType<typeof dbWith>,c?:ReturnType<typeof prepared>) {
  return protectedWriter.replaceSnapshot({db:{query:db.query,connect:db.connect} as never,syncedAt,
    link:{candidateId,electionId,electionYear:2026,candidateNameNormalized:"JANE EXAMPLE",
      officeName:"State Representative",committeeId:"A123456",committeeName:"Example Receiving Committee",
      linkSource:"mec_portal"},
    ...(c?{afterSnapshotWrite:async(ctx)=>replace({...ctx,component:c})}:{}),
  });
}

describe("Missouri independent registered IE storage",()=>{
  it("omits absent/held observations without manufacturing zero or write time",()=>{
    expect(prepare({candidateId,electionId,electionYear:2026,receivingCommitteeId:"A123456",syncedAt})).toBeUndefined();
    const c=component();c.aggregation={...q(c),status:"held",reason:"unresolved_report_lineage"};
    expect(prepare({component:c,candidateId,electionId,electionYear:2026,receivingCommitteeId:"A123456",syncedAt})).toBeUndefined();
  });
  it.each([
    ["wrong candidate",(c:MissouriRegisteredIeComponent)=>{c.candidateId=electionId;}],
    ["wrong election",(c:MissouriRegisteredIeComponent)=>{c.electionId=candidateId;}],
    ["wrong receiver",(c:MissouriRegisteredIeComponent)=>{c.receivingCommitteeId="A999999";}],
    ["invalid cycle date",(c:MissouriRegisteredIeComponent)=>{c.cycleStart="2026-02-30";}],
    ["wrong cycle year",(c:MissouriRegisteredIeComponent)=>{c.cycleEnd="2025-11-03";}],
    ["future source",(c:MissouriRegisteredIeComponent)=>{c.sourceRetrievedAt=new Date("2027-01-01");}],
    ["invalid source clock",(c:MissouriRegisteredIeComponent)=>{c.sourceRetrievedAt=new Date(NaN);}],
    ["wrong publication",(c:MissouriRegisteredIeComponent)=>{c.sourceUrl="https://www.mec.mo.gov/MEC/Campaign_Finance/CF12_ContrExpend.aspx";}],
    ["source credentials",(c:MissouriRegisteredIeComponent)=>{c.sourceUrl="https://user@www.mec.mo.gov/MEC/Campaign_Finance/CF_SearchDirExp.aspx";}],
    ["missing raw original",(c:MissouriRegisteredIeComponent)=>{c.sourceByteSize=0;}],
    ["invalid hash",(c:MissouriRegisteredIeComponent)=>{c.sourceSha256="private detail";}],
    ["wrong native row count",(c:MissouriRegisteredIeComponent)=>{c.sourceRowCount=(c.sourceRowCount??0)+1;}],
    ["invalid page count",(c:MissouriRegisteredIeComponent)=>{c.sourcePageCount=-1;}],
    ["zero pages for positive source",(c:MissouriRegisteredIeComponent)=>{c.sourcePageCount=0;}],
    ["wrong candidate count",(c:MissouriRegisteredIeComponent)=>{q(c).candidateNameRowCount++;}],
    ["wrong occurrence count",(c:MissouriRegisteredIeComponent)=>{q(c).includedExpenditureRowCount++;}],
    ["wrong stance total",(c:MissouriRegisteredIeComponent)=>{q(c).opposeAmountCents++;}],
    ["fractional cents",(c:MissouriRegisteredIeComponent)=>{q(c).groups[0]!.amountCents=1.5;}],
    ["unsafe cents",(c:MissouriRegisteredIeComponent)=>{q(c).groups[0]!.amountCents=Number.MAX_SAFE_INTEGER+1;}],
    ["nonfinite count",(c:MissouriRegisteredIeComponent)=>{q(c).sourceRowCount=Infinity;}],
    ["negative eligible adjustment",(c:MissouriRegisteredIeComponent)=>{q(c).negativeAmountRowCount=1;}],
    ["unresolved lineage",(c:MissouriRegisteredIeComponent)=>{q(c).ambiguousLineageRowCount=1;}],
    ["late report overlap",(c:MissouriRegisteredIeComponent)=>{q(c).timelyOverlapRowCount=1;}],
    ["duplicate name/stance group",(c:MissouriRegisteredIeComponent)=>{q(c).groups[1]={...q(c).groups[0]!};}],
    ["nonliteral name key",(c:MissouriRegisteredIeComponent)=>{q(c).groups[0]!.reportedNameKey="ALIAS";}],
  ])("rejects %s before SQL",(_label,mutate)=>{
    const c=component();mutate(c);const db=dbWith();
    expect(()=>prepared(c)).toThrow("Missouri registered IE invalid_component");
    expect(db.query).not.toHaveBeenCalled();
  });
  it("rejects combined stance overflow even when both stance totals are individually safe",()=>{
    const c=component();for(const g of q(c).groups)g.amountCents=Number.MAX_SAFE_INTEGER;
    q(c).supportAmountCents=q(c).opposeAmountCents=Number.MAX_SAFE_INTEGER;
    expect(()=>prepared(c)).toThrow("invalid_component");
  });
  it("copies source clocks and uncapped groups before later caller mutations",()=>{
    const c=component();const safe=prepared(c);q(c).groups[0]!.amountCents=999;c.sourceRetrievedAt.setUTCFullYear(2099);
    expect(safe.aggregation.groups[0]!.amountCents).toBe(101);
    expect(safe.sourceRetrievedAt.toISOString()).toBe("2026-10-14T12:00:00.000Z");
  });
  it("stores all groups and independent observation/write clocks without requiring MECIDs",async()=>{
    const db=dbWith();await replace({db:db as never,linkId,electionYear:2026,syncedAt,component:prepared(component(125))});
    const source=db.query.mock.calls.find(([sql])=>String(sql).startsWith("INSERT INTO public.mo_candidate_finance_registered_ie_sources"));
    expect(source?.[1]?.slice(0,5)).toEqual([candidateId,electionId,2026,linkId,"A123456"]);
    expect(source?.[1]?.slice(7,11)).toEqual(["6363","6262",125,125]);
    expect(source?.[1]?.[23]).toBe("2026-10-14T12:00:00.000Z");
    expect(source?.[1]?.[26]).toBe(syncedAt.toISOString());
    expect(db.state.groups).toHaveLength(125);
    expect(db.state.groups.every(g=>g[6]===null)).toBe(true);
    expect(db.query.mock.calls.some(([sql])=>["BEGIN","COMMIT"].includes(String(sql)))).toBe(false);
  });
  it("keeps the same reported name distinct by stance and preserves expenditure occurrences",async()=>{
    const c=component();q(c).groups[1]!.reportedCommitteeName=q(c).groups[0]!.reportedCommitteeName;
    q(c).groups[1]!.reportedNameKey=q(c).groups[0]!.reportedNameKey;
    q(c).groups[0]!.expenditureCount=2;q(c).groups[0]!.amountCents=202;q(c).supportAmountCents=202;
    q(c).includedExpenditureRowCount++;q(c).matchedRowCount++;q(c).candidateNameRowCount++;q(c).sourceRowCount++;c.sourceRowCount=(c.sourceRowCount??0)+1;
    const db=dbWith();await replace({db:db as never,linkId,electionYear:2026,syncedAt,component:prepared(c)});
    expect(db.state.groups.map(g=>[g[5],g[7],g[8]])).toEqual([["support","202",2],["oppose","101",1]]);
  });
  it("allows qualified zero and real empty source counts, clearing only independent groups",async()=>{
    const c=component(0);Object.assign(q(c),{sourceRowCount:0,candidateNameRowCount:0,candidateOfficeMismatchRowCount:0,outsideCycleRowCount:0});
    c.sourceRowCount=0;c.sourcePageCount=0;const db=dbWith();
    await replace({db:db as never,linkId,electionYear:2026,syncedAt,component:prepared(c)});
    expect(db.state.groups).toEqual([]);
    const source=db.query.mock.calls.find(([sql])=>String(sql).startsWith("INSERT INTO public.mo_candidate_finance_registered_ie_sources"));
    expect(source?.[1]?.slice(7,11)).toEqual(["0","0",0,0]);
    expect(db.query.mock.calls.some(([sql])=>String(sql).includes("mo_candidate_finance_outside"))).toBe(false);
  });
  it("stores one candidate allocation when qualifying receiving links change",async()=>{
    const db=dbWith();const c=prepared();
    await replace({db:db as never,linkId,electionYear:2026,syncedAt,component:c});
    c.receivingCommitteeId="A999999";
    await replace({db:db as never,linkId:secondLinkId,electionYear:2026,syncedAt,component:c});
    expect(db.state.groups).toHaveLength(2);
    const deletes=db.query.mock.calls.filter(([sql])=>String(sql).startsWith("DELETE"));
    expect(deletes.map(call=>call[1])).toEqual([[candidateId,electionId,2026],[candidateId,electionId,2026]]);
  });
  it("rechecks the active protected receiver/candidate/election/year before deleting groups",async()=>{
    const db=dbWith({inactive:true});
    await expect(replace({db:db as never,linkId,electionYear:2026,syncedAt,component:prepared()})).rejects.toMatchObject({code:"receiving_link_changed"});
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0]?.[0]).toContain("candidate_id=$3::uuid AND election_id=$4::uuid");
    expect(db.query.mock.calls[0]?.[0]).toContain("link_status='active' FOR UPDATE");
    expect(db.state.groups).toEqual([["previous independent group"]]);
  });
  it.each([
    ["older_source",new Date("2026-10-15T00:00:00Z"),"a".repeat(64)],
    ["source_conflict",new Date("2026-10-14T12:00:00Z"),"b".repeat(64)],
  ])("rejects %s before group deletion",async(code,prior,priorHash)=>{
    const db=dbWith({prior:prior as Date,priorHash});
    await expect(replace({db:db as never,linkId,electionYear:2026,syncedAt,component:prepared()})).rejects.toMatchObject({code});
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.state.groups).toEqual([["previous independent group"]]);
  });
  it.each([
    ["cycle start",(c:MissouriRegisteredIeComponent)=>{c.cycleStart="2026-08-05";}],
    ["cycle end",(c:MissouriRegisteredIeComponent)=>{c.cycleEnd="2026-11-02";}],
    ["stance cents",(c:MissouriRegisteredIeComponent)=>{q(c).groups[0]!.amountCents=102;q(c).supportAmountCents=102;}],
    ["group count",(c:MissouriRegisteredIeComponent)=>{Object.assign(c,component(3));}],
    ["expenditure count",(c:MissouriRegisteredIeComponent)=>{q(c).groups[0]!.expenditureCount=2;
      q(c).includedExpenditureRowCount++;q(c).matchedRowCount++;q(c).candidateNameRowCount++;}],
    ["source controls",(c:MissouriRegisteredIeComponent)=>{q(c).sourceRowCount++;c.sourceRowCount=(c.sourceRowCount??0)+1;}],
  ])("holds equal clock/hash with changed %s before deleting prior groups",async(_label,mutate)=>{
    const db=dbWith();await replace({db:db as never,linkId,electionYear:2026,syncedAt,component:prepared()});
    const before=structuredClone(db.state);const previousCalls=db.query.mock.calls.length;
    const c=component();mutate(c);
    await expect(replace({db:db as never,linkId:secondLinkId,electionYear:2026,syncedAt,component:prepared(c)}))
      .rejects.toMatchObject({code:"source_conflict"});
    expect(db.query.mock.calls.length-previousCalls).toBe(2);
    expect(db.state).toEqual(before);
  });
  it("permits a newer observation to re-evaluate a changed window and amount",async()=>{
    const db=dbWith();await replace({db:db as never,linkId,electionYear:2026,syncedAt,component:prepared()});
    const c=component();c.sourceRetrievedAt=new Date("2026-10-14T18:00:00Z");c.cycleStart="2026-08-05";
    q(c).groups[0]!.amountCents=102;q(c).supportAmountCents=102;
    await replace({db:db as never,linkId:secondLinkId,electionYear:2026,syncedAt,component:prepared(c)});
    expect(db.state.groups).toHaveLength(2);expect(db.state.groups[0]?.[7]).toBe("102");
  });
  it("guards the concurrent missing-prior-source race inside conditional upsert",async()=>{
    const db=dbWith({rejectUpsert:true});
    await expect(replace({db:db as never,linkId,electionYear:2026,syncedAt,component:prepared()})).rejects.toMatchObject({code:"source_not_current"});
    expect(db.query.mock.calls.some(([sql])=>String(sql).startsWith("DELETE"))).toBe(false);
    const insert=db.query.mock.calls.find(([sql])=>String(sql).startsWith("INSERT INTO public.mo_candidate_finance_registered_ie_sources"));
    expect(insert?.[0]).toContain("WHERE mo_candidate_finance_registered_ie_sources.source_retrieved_at");
    expect(insert?.[0]).toContain("cycle_start IS NOT DISTINCT FROM EXCLUDED.cycle_start");
    expect(insert?.[0]).toContain("expenditure_count IS NOT DISTINCT FROM EXCLUDED.expenditure_count");
  });
  it("rolls source/group changes back through the actual protected parent transaction",async()=>{
    const db=dbWith({failGroup:true});const before=structuredClone(db.state);
    await expect(protectedWrite(db,prepared())).rejects.toThrow("Missouri registered IE write_failed");
    expect(db.state).toEqual(before);
    expect(db.query.mock.calls.map(([sql])=>sql)).toContain("ROLLBACK");
    expect(db.query.mock.calls.map(([sql])=>sql)).not.toContain("COMMIT");
    expect(db.release).toHaveBeenCalledTimes(1);
  });
  it("omitted component leaves new sources and every legacy money table untouched",async()=>{
    const db=dbWith();const before=structuredClone(db.state);await protectedWrite(db);
    expect(db.state).toEqual(before);
    expect(db.query.mock.calls.some(([sql])=>String(sql).includes("registered_ie"))).toBe(false);
    expect(db.query.mock.calls.some(([sql])=>/mo_candidate_finance_(?:summaries|outside|direct)/.test(String(sql)))).toBe(false);
    expect(db.query.mock.calls.map(([sql])=>sql)).toContain("COMMIT");
  });
  it("masks native DB failures with a safe constant",async()=>{
    const db=dbWith();db.query.mockRejectedValue(new Error("synthetic private database payload"));
    await expect(replace({db:db as never,linkId,electionYear:2026,syncedAt,component:prepared()})).rejects.toThrow("Missouri registered IE write_failed");
  });
});
