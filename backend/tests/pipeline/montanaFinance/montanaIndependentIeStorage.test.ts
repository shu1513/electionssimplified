import {afterEach,describe,expect,it,vi} from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {acquireMontanaCersOutsideSpendingArtifacts} from "../../../src/pipeline/montanaFinance/montanaOutsideSpendingAcquisition.js";
import {readMontanaIndependentIeSource} from "../../../src/pipeline/montanaFinance/montanaIndependentIeSource.js";
import {writeMontanaIndependentIe,readStoredMontanaIePosition} from "../../../src/pipeline/montanaFinance/montanaIndependentIeWriter.js";
import {overlayMontanaIndependentIe} from "../../../src/pipeline/montanaFinance/montanaIndependentIeReader.js";
import {listDueMontanaIndependentIe,syncDueMontanaIndependentIe} from "../../../src/pipeline/montanaFinance/montanaIndependentIeBatchSync.js";
import {parseMontanaIndependentIeArgs} from "../../../src/scripts/syncDueMontanaIndependentIe.js";
import type {MontanaCommitteeReceiver} from "../../../src/pipeline/montanaFinance/montanaReportedCommitteeReceiver.js";
const dirs:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();for(const d of dirs)await fs.rm(d,{recursive:true,force:true});dirs.length=0;});
const r:MontanaCommitteeReceiver={link_id:"11111111-1111-4111-8111-111111111111",candidate_id:"22222222-2222-4222-8222-222222222222",election_id:"33333333-3333-4333-8333-333333333333",
  election_year:2026,committee_id:"100",link_source:"cers_portal",link_candidate_name:"SYNTHETIC Q CANDIDATE",link_committee_name:"Candidate, Synthetic Q",link_office_name:"State Lower Chamber Legislator",link_district:"12",
  candidate_name:"Synthetic Q Candidate",full_name:"Synthetic Candidate",office_scope:"state_lower",office_name:"State Lower Chamber Legislator",district:"12",district_name:"District 12",ballot_title:null,election_date:"2026-11-03"};
const table=(rows:unknown[])=>({iTotalRecords:rows.length,iTotalDisplayRecords:rows.length,aaData:rows});
async function fixture(){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"mt-ie-storage-"));dirs.push(dir);
  await acquireMontanaCersOutsideSpendingArtifacts({year:2026,cacheDir:dir,sessionOptions:{spacingMs:0,sleep:async()=>{},fetchImpl:async(input)=>{
    const name=new URL(input).pathname.split("/").at(-1);let v:unknown='<title>CERS (searchResults)</title>';
    if(name==="listFinancialCommitteeResults")v=table(Array.from({length:7},(_,i)=>({committeeId:200+i,committeeName:`Synthetic committee ${i}`,committeeTypeCode:"PA",electionYear:"2026"})));
    if(name==="viewFinancialEntities")v={resultCount:1};
    if(name==="listViewFinancialEntityResults")v=table([{transId:++counter,transTypeDesr:"Independent Expenditure",amountTypeDescr:"General",cashAmt:100,inKindAmt:0,totalAmt:100,
      datePaid:Date.UTC(2026,5,1),candidateIssue:"Synthetic Q Candidate (HD-12)",purposeDescr:"Synthetic mailing",electioneeringInd:"N",previousTransactionInd:"N"}]);
    if(name==="listCandidateResults")v=table([{candidateId:100,electionYear:"2026",personDTO:{firstName:"Synthetic",middleInitial:"Q",lastName:"Candidate"},officeTitle:"House District No. 12"}]);
    return new Response(typeof v==="string"?v:JSON.stringify(v));
  }}});const packet=(await readMontanaIndependentIeSource(2026,dir))!;expect(packet).not.toBeNull();return {packet,dir};
}
let counter=0;
function database(){
  let stored:Record<string,unknown>|null=null,groups:Record<string,unknown>[]=[];
  const query=vi.fn(async(sql:string,args:unknown[]=[])=>{
    if(sql.includes("SELECT * FROM mt_reported_ie_sources"))return {rows:stored?[stored]:[]};
    if(sql.includes("SELECT * FROM mt_reported_ie_groups"))return {rows:groups};
    if(sql.includes("SELECT id::text,link_status"))return {rows:[{id:r.link_id,link_status:"active"}]};
    if(sql.includes("FOR UPDATE OF"))return {rows:[r]};
    if(sql.includes("INSERT INTO public.mt_reported_ie_sources")){
      const names=["link_id","election_year","candidate_id","election_id","receiving_candidate_id","support_cents","oppose_cents","total_cents","group_count","attributed_row_count","source_retrieved_at","source_completed_at","source_manifest_sha256","source_byte_size","source_original_count","source_facts","last_synced_at"];
      stored=Object.fromEntries(names.map((n,i)=>[n,n==="source_facts"?JSON.parse(args[i] as string):args[i]]));
    }
    if(sql.includes("DELETE FROM public.mt_reported_ie_groups"))groups=[];
    if(sql.includes("INSERT INTO public.mt_reported_ie_groups"))groups=JSON.parse(args[2] as string).map((g:{committeeId:string;name:string;stance:string;cents:number})=>({link_id:r.link_id,election_year:2026,committee_id:g.committeeId,committee_name:g.name,support_oppose:g.stance,amount_cents:g.cents}));
    return {rows:[]};
  });const release=vi.fn(),connect=vi.fn(async()=>({query,release}));return {db:{query,connect} as never,query,connect,stored:()=>stored!,groups:()=>groups};
}
function enable(){vi.stubEnv("CANDIDATE_FINANCE_ENABLED","true");vi.stubEnv("MONTANA_CAMPAIGN_FINANCE_ENABLED","true");vi.stubEnv("MONTANA_REPORTED_IE_ENABLED","true");vi.stubEnv("MONTANA_REPORTED_COMMITTEE_RECEIPTS_ENABLED","false");}
describe("Montana independent IE storage and scheduling",()=>{
  it("writes only its own component under canonical locks, with exact source clocks and idempotency",async()=>{
    const {packet}=await fixture(),d=database();expect(await writeMontanaIndependentIe({db:d.db,receiver:r,source:packet})).toEqual({totalCents:70000,groups:7,idempotent:false});
    expect(d.query.mock.calls.filter(([sql])=>/INSERT|DELETE|UPDATE public/.test(sql)).every(([sql])=>sql.includes("mt_reported_ie_"))).toBe(true);
    expect(d.stored()).toMatchObject({source_retrieved_at:packet.sourceRetrievedAt,source_completed_at:packet.sourceCompletedAt,total_cents:70000,oppose_cents:null});
    expect(await writeMontanaIndependentIe({db:d.db,receiver:r,source:packet})).toMatchObject({idempotent:true});
    d.stored().total_cents=1;await expect(writeMontanaIndependentIe({db:d.db,receiver:r,source:packet})).rejects.toThrow(/closure/);expect(d.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });
  it("rejects caller-created packets before connection and changed receiving context before money writes",async()=>{
    const {packet}=await fixture(),d=database();await expect(writeMontanaIndependentIe({db:d.db,receiver:r,source:{...packet}})).rejects.toThrow(/unverified_original_packet/);expect(d.connect).not.toHaveBeenCalled();
    await expect(writeMontanaIndependentIe({db:d.db,receiver:{...r,committee_id:"101"},source:packet})).rejects.toThrow(/receiver_mismatch/);expect(d.connect).not.toHaveBeenCalled();
  });
  it("preserves source ordering and rolls back if the canonical lock or a group write fails",async()=>{
    const {packet}=await fixture(),d=database();await writeMontanaIndependentIe({db:d.db,receiver:r,source:packet});
    d.stored().source_completed_at=new Date(Date.parse(packet.sourceCompletedAt)+1).toISOString();
    await expect(writeMontanaIndependentIe({db:d.db,receiver:r,source:packet})).rejects.toThrow(/older_source/);
    const bad={query:vi.fn(async(sql:string)=>{if(sql.includes("FOR UPDATE OF"))return {rows:[{...r,candidate_name:"Changed candidate"}]};if(sql.includes("SELECT id::text"))return {rows:[{id:r.link_id,link_status:"active"}]};return {rows:[]};}),release:vi.fn()};
    await expect(writeMontanaIndependentIe({db:{connect:async()=>bad} as never,receiver:r,source:packet})).rejects.toThrow(/context_changed/);expect(bad.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    const groupFailure=database(),normal=groupFailure.query.getMockImplementation()!;groupFailure.query.mockImplementation(async(sql,args)=>{if(sql.includes("INSERT INTO public.mt_reported_ie_groups"))throw new Error("synthetic storage failure");return normal(sql,args);});
    await expect(writeMontanaIndependentIe({db:groupFailure.db,receiver:r,source:packet})).rejects.toThrow("synthetic storage failure");expect(groupFailure.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });
  it("validates all groups before display caps and can publish outside with unknown direct finance",async()=>{
    enable();const {packet}=await fixture(),d=database();await writeMontanaIndependentIe({db:d.db,receiver:r,source:packet});
    const query=vi.fn(async()=>({rows:[{...r,ie_source:d.stored(),ie_groups:d.groups()}]})),summaries=new Map(),candidates=[{candidate_id:r.candidate_id,election_id:r.election_id}],elections=[{election_id:r.election_id,state:"MT",office_scope:"state_lower",office_canonical_name:"State Lower Chamber Legislator"}];
    await overlayMontanaIndependentIe({query},summaries,candidates,elections,"Filer-declared stance.");const a=[...summaries.values()][0];expect(a.direct_campaign.total_raised).toBeNull();expect(a.outside_spending.support_total).toBe(700);expect(a.outside_spending.oppose_total).toBeNull();expect(a.outside_spending.top_supporting_groups).toHaveLength(5);
    expect(a.last_synced_at).toBe(packet.sourceRetrievedAt);expect(a.outside_spending.outside_coverage_note).toContain("originals observed");
    const old=structuredClone(a);old.direct_campaign.total_raised=42;old.last_synced_at="2026-01-01T00:00:00.000Z";summaries.set([...summaries.keys()][0],old);
    await overlayMontanaIndependentIe({query},summaries,candidates,elections,"Filer-declared stance.");expect([...summaries.values()][0]).toMatchObject({last_synced_at:old.last_synced_at,direct_campaign:{total_raised:42}});
    d.groups()[6]!.amount_cents=1;const prior=structuredClone([...summaries.values()][0]);await overlayMontanaIndependentIe({query},summaries,candidates,elections,"note");expect([...summaries.values()][0]).toEqual(prior);
    expect(()=>readStoredMontanaIePosition(d.stored(),d.groups(),r)).toThrow(/closure/);
  });
  it("schedules from its own source clock with default ten and never needs receipt/direct summaries",async()=>{
    enable();const rows=Array.from({length:12},()=>r),query=vi.fn(async()=>({rows:rows.map((v,i)=>({...v,link_id:String(i)}))})),connect=vi.fn();
    const result=await listDueMontanaIndependentIe({db:{query,connect} as never});expect(result.rows).toHaveLength(10);expect(result.totalDueRows).toBe(12);
    const [sql,args]=query.mock.calls[0] as unknown as [string,unknown[]];expect(sql).toContain("s.source_retrieved_at");expect(sql).toContain("interval '24 hours'");expect(sql).toContain("NOT EXISTS (SELECT 1 FROM public.mt_candidate_finance_links sibling");expect(sql).not.toContain("mt_candidate_finance_summaries");expect(sql).not.toContain("mt_reported_committee");expect(args.slice(2,5)).toEqual([98,730,7]);
    expect(await syncDueMontanaIndependentIe({db:{query,connect} as never,dryRun:true})).toMatchObject({enabled:true,totalDueRows:12,attemptedCount:0});expect(connect).not.toHaveBeenCalled();
    vi.stubEnv("MONTANA_CAMPAIGN_FINANCE_ENABLED","false");query.mockClear();expect(await syncDueMontanaIndependentIe({db:{query,connect} as never})).toMatchObject({enabled:false});expect(query).not.toHaveBeenCalled();
  });
  it("CLI accepts deadline staleness without identity or source-clock overrides",()=>{
    expect(parseMontanaIndependentIeArgs(["--dry-run","--stale-after-days=1"])).toEqual({dryRun:true,staleAfterDays:1});
    for(const args of [["--candidate-id","100"],["--year","2026"],["--source-date","2026-01-01"],["--stale-after-days=0"],["--stale-after-days=1.5"],["--dry-run","--dry-run"]])expect(()=>parseMontanaIndependentIeArgs(args)).toThrow();
  });
});
