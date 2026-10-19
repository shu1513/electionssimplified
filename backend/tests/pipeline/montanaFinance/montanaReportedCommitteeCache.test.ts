import {afterEach,describe,expect,it,vi} from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {acquireMontanaCommitteePacket,readMontanaCommitteePacket,montanaCommitteePacketData} from "../../../src/pipeline/montanaFinance/montanaReportedCommitteeCache.js";
import {writeMontanaCommitteeReceipts,readStoredMontanaCommitteeComponent,validateMontanaCommitteeAggregation} from "../../../src/pipeline/montanaFinance/montanaReportedCommitteeWriter.js";
import {qualifyMontanaCommitteeReceiver,type MontanaCommitteeReceiver} from "../../../src/pipeline/montanaFinance/montanaReportedCommitteeReceiver.js";
import {overlayMontanaCommitteeReceipts} from "../../../src/pipeline/montanaFinance/montanaReportedCommitteeReader.js";
import {candidateElectionKey} from "../../../src/pipeline/address/ballotLookupFinanceShared.js";

const scope={nativeCandidateId:100,electionYear:2026},table=(rows:unknown[])=>({aaData:rows,iTotalRecords:rows.length,iTotalDisplayRecords:rows.length});
const native={candidateId:100,electionYear:"2026",personDTO:{firstName:"Synthetic",middleInitial:"Q",lastName:"Candidate"},officeTitle:"House District No. 12"};
const report={reportId:10,entitySubId:100,formTypeCode:"C5",statusCode:"FILED",fromDateStr:"01/01/2026",toDateStr:"03/15/2026",receivedDate:Date.UTC(2026,2,20),amendedDate:null,primCashBeg:0,genCashBeg:0};
const detail={entityName:"Synthetic PAC",cashAmt:100,inKindAmt:25,totalAmt:125,debtAmt:0,amountTypeDescr:"Primary",datePaid:Date.UTC(2026,2,5),lineItemCompositeDescr:"Independent Committee Contributions"};
const transaction={...detail,transId:1,reportId:10,transTypeDesr:detail.lineItemCompositeDescr,transTypeCode:"5",lineItemCompositeCode:"5,C5,A",previousTransactionInd:"N",entIdFrom:200,committeeTypeCode:"PA",entityDTO:{entId:200,entityName:detail.entityName,entityTypeCode:"CM",committeeTypeCode:null}};
const receiver:MontanaCommitteeReceiver={link_id:"00000000-0000-4000-8000-000000000001",candidate_id:"00000000-0000-4000-8000-000000000002",election_id:"00000000-0000-4000-8000-000000000003",
  election_year:2026,committee_id:"100",link_source:"cers_portal",link_candidate_name:"SYNTHETIC Q CANDIDATE",link_committee_name:"Candidate, Synthetic Q",link_office_name:"State Lower Chamber Legislator",link_district:"12",
  candidate_name:"Synthetic Q Candidate",full_name:"Synthetic Q Candidate",office_scope:"state_lower",office_name:"State Lower Chamber Legislator",district:"12",district_name:"House District 12",ballot_title:null,election_date:"2026-11-03"};
let dirs:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();for(const d of dirs)await fs.rm(d,{recursive:true,force:true});dirs=[];});
async function fixture(options:{changeGraph?:boolean;changeLedger?:boolean;wrongParent?:boolean;rapid?:boolean;contactReorder?:boolean;contactChange?:boolean}={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"mt-committee-test-"));dirs.push(dir);let graphCalls=0,ledgerCalls=0;
  vi.spyOn(globalThis,"setTimeout").mockImplementation(((fn:()=>void)=>{queueMicrotask(fn);return 0;}) as typeof setTimeout);
  const fetch=vi.fn(async(input:string)=>{
    const u=new URL(input),p=u.pathname;let value:unknown="<title>CERS (searchResults)</title>",status=200,headers:Record<string,string>={};
    if(p.endsWith("retrieveCampaignReports")||p.endsWith("retrieveReport")){status=302;value=null;headers.Location="/CampaignTracker/public/viewFinanceReport";}
    if(p.endsWith("listCandidateResults")){graphCalls++;value=table([{...native,...(options.changeGraph&&graphCalls===2?{personDTO:{...native.personDTO,middleInitial:"X"}}:{})}]);}
    if(p.endsWith("listFinanceReports"))value=table([{...report,...(options.rapid?{formTypeCode:"C7"}:{})}]);
    if(p.endsWith("financeRepDetailList"))value=[detail];
    if(p.endsWith("viewFinancialEntities"))value={resultCount:1};
    if(p.endsWith("listViewFinancialEntityResults")){ledgerCalls++;value=table([{...transaction,
      ...((options.contactReorder||options.contactChange)?{entityDTO:{...transaction.entityDTO,addressList:ledgerCalls===2?[{address:"B"},{address:options.contactChange?"C":"A"}]:[{address:"A"},{address:"B"}]}}:{}),
      ...(options.changeLedger&&ledgerCalls===2?{transId:2}:{}),...(options.wrongParent?{reportId:11}:{})}]);}
    return new Response(typeof value==="string"?value:value===null?null:JSON.stringify(value),{status,headers});
  });vi.stubGlobal("fetch",fetch);return {dir,fetch};
}
describe("Montana original-byte committee cache and writer",()=>{
  it("captures, replays unchanged bytes and actual clocks; does not manufacture a legal committee ID",async()=>{
    const {dir,fetch}=await fixture(),p=await acquireMontanaCommitteePacket(scope,dir),saved=await readMontanaCommitteePacket(scope,dir);
    expect(saved).toEqual(p);expect(montanaCommitteePacketData(saved!).aggregation.totalCents).toBe(12500);
    expect(montanaCommitteePacketData(p).aggregation.groups[0]!.sourceEntityId).toBe(200);
    expect(fetch).toHaveBeenCalled();for(const entry of await fs.readdir(path.join(dir,"objects")))expect((await fs.stat(path.join(dir,"objects",entry))).mode&0o777).toBe(0o600);
    expect((await fs.stat(dir)).mode&0o777).toBe(0o700);
    const before=fetch.mock.calls.length;await readMontanaCommitteePacket(scope,dir);expect(fetch).toHaveBeenCalledTimes(before);
    expect(()=>montanaCommitteePacketData({...p})).toThrow(/unverified_original_packet/);
    const copy=montanaCommitteePacketData(p);copy.aggregation.totalCents=1;expect(montanaCommitteePacketData(p).aggregation.totalCents).toBe(12500);
  });
  it.each(["graph","ledger","parent","rapid"])("holds %s without replacing the qualified pointer",async kind=>{
    const f=await fixture(),p=await acquireMontanaCommitteePacket(scope,f.dir),next=await fixture({changeGraph:kind==="graph",changeLedger:kind==="ledger",wrongParent:kind==="parent",rapid:kind==="rapid"});
    await expect(acquireMontanaCommitteePacket(scope,f.dir)).rejects.toThrow();
    expect(await readMontanaCommitteePacket(scope,f.dir)).toEqual(p);expect(next.fetch).toHaveBeenCalled();
  });
  it("rejects corrupted saved originals before yielding a branded packet",async()=>{
    const {dir}=await fixture();await acquireMontanaCommitteePacket(scope,dir);const files=await fs.readdir(path.join(dir,"objects"));await fs.writeFile(path.join(dir,"objects",files[0]!),"corrupt");
    await expect(readMontanaCommitteePacket(scope,dir)).rejects.toThrow();
  });
  it("normalizes only contact order, preserving every changed value as a hold",async()=>{
    const a=await fixture({contactReorder:true});expect(montanaCommitteePacketData(await acquireMontanaCommitteePacket(scope,a.dir)).aggregation.totalCents).toBe(12500);
    const b=await fixture({contactChange:true});await expect(acquireMontanaCommitteePacket(scope,b.dir)).rejects.toThrow(/receiving_ledger_changed/);
    expect(await readMontanaCommitteePacket(scope,b.dir)).toBeNull();expect((await fs.readdir(path.join(b.dir,"manifests"))).length).toBe(1);
  });
  it("requires current canonical name, middle, office, district and unique native resolution",async()=>{
    const {dir}=await fixture(),p=await acquireMontanaCommitteePacket(scope,dir),rows=montanaCommitteePacketData(p).candidates;
    expect(()=>qualifyMontanaCommitteeReceiver(receiver,rows)).not.toThrow();
    for(const patch of [{full_name:"Synthetic X Candidate"},{district:"13"},{link_committee_name:"Other"},{link_candidate_name:"OTHER"}])
      expect(()=>qualifyMontanaCommitteeReceiver({...receiver,...patch},rows)).toThrow();
    expect(()=>qualifyMontanaCommitteeReceiver(receiver,[...rows,{...rows[0]!,candidateId:101}])).toThrow();
  });
  it("writes only independent tables, rolls back group failure, validates full uncapped stored closure",async()=>{
    const {dir}=await fixture(),p=await acquireMontanaCommitteePacket(scope,dir),calls:{sql:string;args:unknown[]}[]=[];let groupFailure=false;
    const query=vi.fn(async(sql:string,args:unknown[]=[])=>{
      calls.push({sql,args});if(sql.includes("FOR UPDATE OF c,ce"))return {rows:[receiver]};
      if(sql.includes("SELECT id::text,link_status"))return {rows:[{id:receiver.link_id,link_status:"active"}]};
      if(groupFailure&&sql.includes("INSERT INTO public.mt_reported_committee_groups"))throw Error("synthetic storage failure");return {rows:[]};
    }),release=vi.fn(),db={connect:async()=>({query,release})};
    expect(await writeMontanaCommitteeReceipts({db:db as never,receiver,source:p})).toMatchObject({totalCents:12500,groupCount:1});
    expect(calls.at(-1)!.sql).toBe("COMMIT");expect(calls.some(c=>/^\s*(INSERT|UPDATE|DELETE)/.test(c.sql)&&c.sql.includes("mt_candidate_finance_"))).toBe(false);
    const args=calls.find(c=>c.sql.includes("INSERT INTO public.mt_reported_committee_sources"))!.args;
    const keys=["link_id","election_year","candidate_id","election_id","receiving_committee_id","total_cents","group_count","source_row_count","source_retrieved_at","source_completed_at","source_manifest_sha256","source_byte_size","source_facts","aggregation_controls","last_synced_at"];
    const source=Object.fromEntries(keys.map((k,i)=>[k,[12,13].includes(i)?JSON.parse(args[i] as string):args[i]])),g=montanaCommitteePacketData(p).aggregation.groups[0]!,groups=[{link_id:receiver.link_id,election_year:2026,source_entity_id:200,reported_name:g.name,amount_cents:12500,source_row_count:1,committee_types:["PA"]}];
    expect(readStoredMontanaCommitteeComponent(source,groups,receiver).aggregation.totalCents).toBe(12500);
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED","true");vi.stubEnv("MONTANA_CAMPAIGN_FINANCE_ENABLED","true");vi.stubEnv("MONTANA_REPORTED_COMMITTEE_RECEIPTS_ENABLED","true");
    const summary={last_synced_at:"2020-01-01T00:00:00.000Z",direct_campaign:{total_raised:999},outside_spending:{support_total:33}},key=candidateElectionKey(receiver.candidate_id,receiver.election_id),summaries=new Map([[key,summary as never]]);
    const readDb={query:vi.fn(async()=>({rows:[{...receiver,committee_source:source,committee_groups:groups}]}))};
    const candidates=[{candidate_id:receiver.candidate_id,election_id:receiver.election_id}],elections=[{election_id:receiver.election_id,state:"MT",office_scope:"state_lower",office_canonical_name:"State Lower Chamber Legislator"}];
    const overlaid=await overlayMontanaCommitteeReceipts(readDb as never,summaries,candidates,elections);
    expect(overlaid.get(key)).toMatchObject({last_synced_at:summary.last_synced_at,outside_spending:{support_total:33},direct_campaign:{total_raised:999,pac_money_basis:"reported_committee_itemized_contributions",pac_money_by_interest:[{amount:125,pac_count:1}]}});
    expect(overlaid.get(key)!.direct_campaign.pac_money_coverage_note).toContain("before separate expenditure-side returns");
    const unchanged=new Map([[key,{...summary,direct_campaign:{total_raised:999}} as never]]);
    readDb.query.mockResolvedValueOnce({rows:[{...receiver,committee_source:{...source,total_cents:1},committee_groups:groups}]});
    expect((await overlayMontanaCommitteeReceipts(readDb as never,unchanged,candidates,elections)).get(key)!.direct_campaign).toEqual({total_raised:999});
    expect(()=>readStoredMontanaCommitteeComponent(source,[],receiver)).toThrow(/closure/);
    expect(()=>readStoredMontanaCommitteeComponent({...source,total_cents:1},groups,receiver)).toThrow(/closure/);
    const a=montanaCommitteePacketData(p).aggregation;a.groups[0]!.cents--;expect(()=>validateMontanaCommitteeAggregation(a)).toThrow();
    groupFailure=true;await expect(writeMontanaCommitteeReceipts({db:db as never,receiver,source:p})).rejects.toThrow("synthetic storage failure");expect(calls.at(-1)!.sql).toBe("ROLLBACK");expect(release).toHaveBeenCalledTimes(2);
  });
});
