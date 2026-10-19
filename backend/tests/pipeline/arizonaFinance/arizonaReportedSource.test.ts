import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeRow, capturedAt } from "./arizonaReportedFixtures.js";
import { azHash, parseArizonaReportedRow } from "../../../src/pipeline/arizonaFinance/arizonaReportedCore.js";
import { type ArizonaReportedReceiver, validateArizonaReportedReceiver } from "../../../src/pipeline/arizonaFinance/arizonaReportedReceiver.js";
const harness=vi.hoisted(()=>({capture:vi.fn(),saved:vi.fn()}));
vi.mock("../../../src/pipeline/arizonaFinance/arizonaReportedOriginals.js",()=>({
  AZ_NATIVE_ORIGIN:"https://seethemoney.az.gov",azReportedCache:()=>"unused-private-test-cache",
  savedArizonaOriginals:harness.saved,createArizonaOriginalCapture:async()=>({capture:harness.capture}),
}));
import { createArizonaReportedSource, aggregateArizonaReported, isArizonaReportedPacket, reconcileArizonaReportedParents } from "../../../src/pipeline/arizonaFinance/arizonaReportedSource.js";
import { writeArizonaReportedComponent } from "../../../src/pipeline/arizonaFinance/arizonaReportedStore.js";
import { attachArizonaReportedFinance, readStoredArizonaReportedComponent } from "../../../src/pipeline/arizonaFinance/arizonaReportedReader.js";
import { aggregateArizonaReportedCommittee } from "../../../src/pipeline/arizonaFinance/arizonaReportedAggregation.js";

export const receiver:ArizonaReportedReceiver={linkId:"00000000-0000-4000-8000-000000000001",candidateId:"00000000-0000-4000-8000-000000000002",electionId:"00000000-0000-4000-8000-000000000003",electionYear:2026,electionDate:"2026-11-03",candidateName:"Alex Q Example",fullName:"Alex Quinn Example",officeScope:"state_upper",canonicalOffice:"State Senator",canonicalDistrict:"3",entityId:"101",committeeName:"Former Example Committee",linkSource:"manual",linkOffice:"State Senator",linkDistrict:"3"};
const context=()=>({ReportFilerInfo:{CommitteeName:"Example Candidate Committee",Candidate:"Example, Alex Q",CommitteeTypeName:"Candidate (participating in Clean Elections)",Status:"Active",OfficeName:"State Senator - District No. 3"}});
const ie=()=>nativeRow({CommitteeID:"501",CommitteeName:"Example Outside Committee",TransactionTypeId:"215",TransactionType:"Ind. Expend. (Non-Recall) - cash"});
const original=(value:any,role="test")=>({value,meta:{role,file:"0001.original",method:"POST" as const,status:200,contentType:"application/json",startedAt:capturedAt,completedAt:capturedAt,bytes:JSON.stringify(value).length,sha256:azHash(JSON.stringify(value)),eof:true}});
const table=(rows:any[])=>({data:rows,draw:"1",recordsTotal:String(rows.length),recordsFiltered:String(rows.length)});
const report=(id:string)=>({FilerId:id,FilerName:id==="101"?"Example Candidate Committee":"Example Outside Committee",CommitteeReportId:id==="101"?"1001":"5001",CycleYear:"2026",ReportInstanceName:"Synthetic report",ReportingPeriod:"2025–2026",OriginalFilingDate:"2026-01-10T00:00:00",LastAmendedDate:"2026-01-10T00:00:00",Status:"On Time",ReportFileUrl:"/synthetic.pdf"});
let incomeFails=false,changeCatalog=false,closingTargetChanges=false;
beforeEach(()=>{
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime("2026-10-19T18:05:00.000Z");
  incomeFails=false;changeCatalog=false;closingTargetChanges=false;harness.saved.mockResolvedValue([]);
  harness.capture.mockReset().mockImplementation(async(role:string,input:string)=>{
    const u=new URL(input),id=u.searchParams.get("FilerId")??"101",category=u.searchParams.get("CategoryType");
    if(u.pathname.endsWith("GetDetailedInformation"))return original(context(),role);
    if(u.pathname.endsWith("ReportSearch/"))return original(table([{...report(id),...(changeCatalog&&role==="report_catalog_closing"?{LastAmendedDate:"2026-02-01T00:00:00"}:{})}]),role);
    if(category==="Income"){if(incomeFails)throw new Error("synthetic_income_failure");return original(table([nativeRow()]),role);}
    if(category==="Reports")return original(table([{...(id==="101"?nativeRow():ie()),CommitteeID:"0",CommitteeName:report(id).FilerName,TransactionType:null}]),role);
    if(category==="IndependentExpenditures")return original(table(u.searchParams.get("Position")==="Oppose"?[]:closingTargetChanges&&role==="target_ie_closing"?[]:[ie()]),role);
    throw Error("unexpected_synthetic_request");
  });
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
describe("Arizona source authority and canonical receiving context",()=>{
  it("qualifies live native target scope, all direction occurrences and full payer parents independently of income",async()=>{
    incomeFails=true;const source=await createArizonaReportedSource({allowLive:true}),p=await source.load(receiver,"ie");
    expect(isArizonaReportedPacket(p)).toBe(true);expect(Object.isFrozen(p)).toBe(true);expect(Object.isFrozen(p.support[0]!.raw)).toBe(true);
    expect(aggregateArizonaReported(receiver,p).supportCents).toBe(1000);
    expect(harness.capture.mock.calls.some(([,u])=>new URL(u).searchParams.get("CategoryType")==="Income")).toBe(false);
    expect(p.facts.reportCount).toBe(1);expect(p.facts.parentRows).toBe(1);
  });
  it("uses saved receiving-ID-bound receipts first, with current parent closure and their original clocks",async()=>{
    const saved=original(table([nativeRow()]),"saved_receiving_income");saved.meta.startedAt="2026-10-18T18:00:00.000Z";saved.meta.completedAt=saved.meta.startedAt;
    harness.saved.mockResolvedValue([saved]);incomeFails=true;
    const p=await(await createArizonaReportedSource({allowLive:true})).load(receiver,"committee");
    expect(p.facts.oldestBodyAt).toBe(saved.meta.startedAt);expect(aggregateArizonaReported(receiver,p).totalCents).toBe(1000);
    expect(harness.capture.mock.calls.some(([,u])=>new URL(u).searchParams.get("CategoryType")==="Income")).toBe(false);
  });
  it("does not infer target scope from cached bodies, even a matching reported candidate label",async()=>{
    harness.saved.mockResolvedValue([original(table([ie()]),"target_ie_opening")]);
    const p=await(await createArizonaReportedSource({allowLive:true})).load(receiver,"ie");
    const roles=harness.capture.mock.calls.map(([r])=>r);
    expect(roles).toEqual(expect.arrayContaining(["target_ie_opening","target_ie_support","target_ie_oppose","target_ie_closing"]));
    expect(p.facts.sourceRows).toBe(1);
  });
  it("holds missing live scope, changing catalog versions and changing target populations",async()=>{
    await expect((await createArizonaReportedSource({allowLive:false})).load(receiver,"ie")).rejects.toThrow("live_scope_unavailable");
    changeCatalog=true;await expect((await createArizonaReportedSource({allowLive:true})).load(receiver,"committee")).rejects.toThrow("report_catalog_changed");
    changeCatalog=false;closingTargetChanges=true;await expect((await createArizonaReportedSource({allowLive:true})).load(receiver,"ie")).rejects.toThrow("target_ie_changed");
  });
  it("preserves repeated parent occurrences and compares full financial context",()=>{
    const r=parseArizonaReportedRow(nativeRow(),capturedAt),p=parseArizonaReportedRow(nativeRow({CommitteeID:"0",TransactionType:null}),capturedAt);
    expect(()=>reconcileArizonaReportedParents([r,r],[p,p],"committee")).not.toThrow();
    expect(()=>reconcileArizonaReportedParents([r,r],[p],"committee")).toThrow("parent_occurrence_closure");
    const changed=parseArizonaReportedRow(nativeRow({CommitteeID:"0",Memo:"different context",TransactionType:null}),capturedAt);
    expect(()=>reconcileArizonaReportedParents([r],[changed],"committee")).toThrow("parent_occurrence_closure");
    const negativeGift=parseArizonaReportedRow(nativeRow({CommitteeID:"0",Amount:"-10.0000",TransactionType:null}),capturedAt);
    expect(()=>reconcileArizonaReportedParents([r],[negativeGift],"committee")).toThrow("parent_occurrence_closure");
  });
  it("accepts current Clean Elections registration and District No. without trusting old link labels",()=>{
    expect(()=>validateArizonaReportedReceiver(receiver,context())).not.toThrow();
    expect(()=>validateArizonaReportedReceiver({...receiver,canonicalDistrict:"State Senate District 3 (00003); Arizona"},context())).not.toThrow();
    expect(()=>validateArizonaReportedReceiver({...receiver,canonicalDistrict:"State House District 3 (00003); Arizona"},context())).toThrow("native_receiving_office");
  });
  it.each([
    {Candidate:"Example, Alex B"},{OfficeName:"State Senator - District No. 4"},
    {CommitteeTypeName:"PAC"},{Status:"Terminated"},
  ])("holds conflicting native person, generation, seat, type or status: %j",change=>{
    const c=context();Object.assign(c.ReportFilerInfo,change);expect(()=>validateArizonaReportedReceiver(receiver,c)).toThrow();
  });
  it("rejects explicitly conflicting generations even with a corroborating middle",()=>{
    const c=context();c.ReportFilerInfo.Candidate="Example, Alex Q Jr";
    expect(()=>validateArizonaReportedReceiver({...receiver,candidateName:"Alex Q Example Sr",fullName:"Alex Quinn Example Sr"},c)).toThrow("native_receiving_person");
  });
  it("rejects caller-constructed source packets before a DB connection",async()=>{
    const db={connect:vi.fn()};await expect(writeArizonaReportedComponent({db:db as any,receiver,source:{receiver,kind:"ie"} as any})).rejects.toThrow("unverified_source");expect(db.connect).not.toHaveBeenCalled();
  });
  it("atomically rolls back failed group replacement and changed canonical receiving context",async()=>{
    const p=await(await createArizonaReportedSource({allowLive:true})).load(receiver,"ie"),sql:string[]=[];
    let changed=false;
    const client={release:vi.fn(),query:vi.fn(async(s:string)=>{
      sql.push(s);
      if(s.startsWith("SELECT id::text"))return{rows:[{id:receiver.linkId}]};
      if(s.startsWith("SELECT l.id::text"))return{rows:[{...receiver,...(changed?{canonicalDistrict:"4"}:{})}]};
      if(s.startsWith("INSERT INTO public.az_reported_finance_groups"))throw Error("synthetic_storage_failure");
      return{rows:[]};
    })},db={connect:async()=>client};
    await expect(writeArizonaReportedComponent({db:db as any,receiver,source:p})).rejects.toThrow("synthetic_storage_failure");
    expect(sql.at(-1)).toBe("ROLLBACK");expect(sql).not.toContain("COMMIT");expect(client.release).toHaveBeenCalledOnce();
    sql.length=0;changed=true;
    await expect(writeArizonaReportedComponent({db:db as any,receiver,source:p})).rejects.toThrow("canonical_receiver_changed");
    expect(sql.some(s=>s.startsWith("INSERT"))).toBe(false);expect(sql.at(-1)).toBe("ROLLBACK");
  });
  it("holds older sources, admits equal-clock idempotence and rejects equal-clock money conflicts",async()=>{
    const p=await(await createArizonaReportedSource({allowLive:true})).load(receiver,"ie"),a=aggregateArizonaReported(receiver,p),{groups,...controls}=a;
    let clock=capturedAt,conflict=false;const sql:string[]=[];
    const client={release:vi.fn(),query:vi.fn(async(s:string)=>{
      sql.push(s);
      if(s.startsWith("SELECT id::text"))return{rows:[{id:receiver.linkId}]};
      if(s.startsWith("SELECT l.id::text"))return{rows:[receiver]};
      if(s.startsWith("SELECT * FROM public.az_reported_finance_components"))return{rows:[{source_observed_at:clock,receiver_context:receiver,source_facts:p.facts,aggregation_controls:controls}]};
      if(s.startsWith("SELECT group_key"))return{rows:groups.map(g=>({...g,cents:g.cents+Number(conflict)}))};
      return{rows:[]};
    })},db={connect:async()=>client};
    await expect(writeArizonaReportedComponent({db:db as any,receiver,source:p})).resolves.toEqual({groups:1,idempotent:true});
    expect(sql.some(s=>s.startsWith("INSERT")||s.startsWith("DELETE"))).toBe(false);
    conflict=true;await expect(writeArizonaReportedComponent({db:db as any,receiver,source:p})).rejects.toThrow("equal_source_conflict");
    conflict=false;clock="2026-10-19T18:01:00.000Z";await expect(writeArizonaReportedComponent({db:db as any,receiver,source:p})).rejects.toThrow("older_source");
  });
  it("validates every persisted name, amount, count, source clock and canonical context before presentation",async()=>{
    const p=await(await createArizonaReportedSource({allowLive:true})).load(receiver,"ie"),a=aggregateArizonaReported(receiver,p),{groups,...controls}=a;
    const row={link_id:receiver.linkId,candidate_id:receiver.candidateId,election_id:receiver.electionId,election_year:2026,component:"ie",receiver_context:receiver,source_facts:p.facts,source_observed_at:capturedAt,last_synced_at:capturedAt,aggregation_controls:controls};
    const stored=groups.map(g=>({link_id:receiver.linkId,election_year:2026,component:"ie",group_key:g.key,reported_name:g.name,source_class:g.sourceClass,stance:g.stance,amount_cents:String(g.cents),occurrence_count:g.occurrences}));
    expect(readStoredArizonaReportedComponent(row,stored,receiver)).toEqual(a);
    for(const changed of [{reported_name:"Different Example Committee"},{amount_cents:"1001"},{occurrence_count:2},{component:"committee"}])
      expect(()=>readStoredArizonaReportedComponent(row,[{...stored[0],...changed}],receiver)).toThrow();
    expect(()=>readStoredArizonaReportedComponent({...row,source_observed_at:"2026-10-18T18:00:00.000Z"},stored,receiver)).toThrow("stored_source_clock");
    expect(()=>readStoredArizonaReportedComponent({...row,receiver_context:{...receiver,canonicalDistrict:"4"}},stored,receiver)).toThrow("stored_receiver_context");
  });
  it("retains fully returned reported groups in the API instead of asserting that no contributions were reported",async()=>{
    for(const key of["CANDIDATE_FINANCE_ENABLED","ARIZONA_CAMPAIGN_FINANCE_ENABLED","ARIZONA_REPORTED_COMMITTEE_ENABLED"])vi.stubEnv(key,"true");
    vi.stubEnv("ARIZONA_INDEPENDENT_IE_ENABLED","false");
    const rows=[
      parseArizonaReportedRow(nativeRow({TransactionTypeId:"114",TransactionType:"Contributions from Candidate Committees",TransactionName:"Example Donor Committee",Amount:"100.0000"}),capturedAt),
      parseArizonaReportedRow(nativeRow({TransactionTypeId:"128",TransactionType:"Refund Contributions from Candidate Committees",TransactionName:"Example Donor Committee",Amount:"-100.0000"}),capturedAt),
    ],a=aggregateArizonaReportedCommittee(rows),{groups,...controls}=a;
    const facts={revision:"az-native-cycle-components-1",kind:"committee",electionYear:2026,sourceAt:capturedAt,oldestBodyAt:capturedAt,newestBodyAt:capturedAt,sourceHash:"f".repeat(64),sourceRows:2,reportCount:1,parentRows:2,windowStart:"2025-01-01",windowEnd:"2026-12-31"};
    const component={link_id:receiver.linkId,candidate_id:receiver.candidateId,election_id:receiver.electionId,election_year:2026,component:"committee",receiver_context:receiver,source_facts:facts,source_observed_at:capturedAt,last_synced_at:capturedAt,aggregation_controls:controls};
    const stored=groups.map(g=>({link_id:receiver.linkId,election_year:2026,component:"committee",group_key:g.key,reported_name:g.name,source_class:g.sourceClass,stance:g.stance,amount_cents:String(g.cents),occurrence_count:g.occurrences}));
    const db={query:vi.fn(async(s:string)=>({rows:s.startsWith("SELECT l.id")?[receiver]:s.includes("az_reported_finance_components")?[component]:stored}))};
    const output=await attachArizonaReportedFinance({db:db as any,requests:[{candidate_id:receiver.candidateId,election_id:receiver.electionId}],summaries:new Map()});
    const summary=[...output.values()][0]!;expect(summary.direct_campaign.pac_money_by_interest).toHaveLength(1);
    expect(summary.direct_campaign.pac_money_by_interest![0]).toMatchObject({amount:0,pac_count:1,pacs:[{committee_name:"Example Donor Committee",amount:0}]});
  });
});
