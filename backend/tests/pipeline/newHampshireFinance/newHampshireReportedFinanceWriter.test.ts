import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNewHampshireReportedSourceProducer } from "../../../src/pipeline/newHampshireFinance/newHampshireReportedSourceCache.js";
import { writeNewHampshireReportedComponent as write } from "../../../src/pipeline/newHampshireFinance/newHampshireReportedFinanceWriter.js";
import type { NewHampshireReportedReceiver } from "../../../src/pipeline/newHampshireFinance/newHampshireReportedReceiver.js";
import { guid, nativeFixture } from "./newHampshireReportedTestFixtures.js";

let cacheDir: string;
beforeEach(async()=>{cacheDir=await mkdtemp(join(tmpdir(),"nh-reported-writer-test-"));});
afterEach(async()=>{await rm(cacheDir,{recursive:true,force:true});});
const receiver:NewHampshireReportedReceiver={linkId:guid(500),candidateId:guid(501),electionId:guid(502),electionYear:2026,
  electionDate:"2026-11-03",candidateName:"Synthetic Candidate",candidateAliases:["Synthetic Candidate"],officeScope:"statewide",
  officeName:"Governor",district:null,filingEntityId:1000,filerName:"Synthetic filer 1000",linkSource:"cfs_registration"};
async function sourceSetup(){
  const fixture=nativeFixture(),producer=createNewHampshireReportedSourceProducer({cacheDir,fetchImpl:fixture.fetchImpl,minimumGapMs:0});
  const base=await producer.refreshBase(2026);if(!base)throw Error("Synthetic base missing");
  const source=await producer.refreshComponent({kind:"committee",electionYear:2026,base:base.reference,filingEntityId:1000});
  if(!source)throw Error("Synthetic source missing");return{...fixture,producer,base,source};
}
function database(){
  const state={component:null as Record<string,unknown>|null,groups:[] as Record<string,unknown>[],failGroups:false,status:"active",duplicateLinks:false};
  let backup:{component:Record<string,unknown>|null;groups:Record<string,unknown>[]}|null=null;
  const query=vi.fn(async(sql:string,values:unknown[]=[])=>{
    if(sql==="BEGIN"){backup=structuredClone({component:state.component,groups:state.groups});return{rows:[]};}
    if(sql==="ROLLBACK"){if(backup){state.component=backup.component;state.groups=backup.groups;}return{rows:[]};}
    if(sql==="COMMIT")return{rows:[]};
    if(sql.includes("SELECT c.id::text"))return{rows:[{candidate_id:receiver.candidateId,election_id:receiver.electionId,
      election_date:receiver.electionDate,election_year:2026,deleted_at:null,candidate_status:state.status,state:"NH",race_type:"office",
      election_stage:"general",office_scope:"statewide",canonical_name:"Governor",display_name:"Synthetic Candidate",structured_name:"Synthetic Candidate"}]};
    if(sql.includes("FROM public.nh_candidate_finance_links WHERE")){
      const link={link_id:receiver.linkId,filing_entity_id:"1000",filer_name:receiver.filerName,link_source:receiver.linkSource,
        office_name:"Governor",district:null,candidate_name_normalized:"Synthetic Candidate"};return{rows:state.duplicateLinks?[link,link]:[link]};
    }
    if(sql.includes("SELECT * FROM public.nh_reported_finance_components"))return{rows:state.component?[state.component]:[]};
    if(sql.includes("SELECT * FROM public.nh_reported_finance_groups"))return{rows:state.groups};
    if(sql.startsWith("INSERT INTO public.nh_reported_finance_components")){
      const columns=sql.slice(sql.indexOf("(")+1,sql.indexOf(")")).split(",");
      state.component=Object.fromEntries(columns.map((column,i)=>[column,column==="source_controls"?JSON.parse(String(values[i])):values[i]]));return{rows:[{}]};
    }
    if(sql.startsWith("DELETE FROM public.nh_reported_finance_groups")){state.groups=[];return{rows:[]};}
    if(sql.startsWith("INSERT INTO public.nh_reported_finance_groups")){
      if(state.failGroups)throw Error("Synthetic group insertion failure");state.groups=JSON.parse(String(values[0]));return{rows:[]};
    }
    if(sql.startsWith("UPDATE public.nh_reported_finance_components")){state.component!.last_synced_at=values[3];return{rows:[]};}
    throw Error("Unexpected synthetic SQL");
  });
  const release=vi.fn(),connect=vi.fn(async()=>({query,release}));
  return{state,query,release,connect,db:{connect} as unknown as Pick<Pool,"connect">};
}

describe("New Hampshire independent component writes",()=>{
  it("aggregates only a verified source and leaves every legacy money table untouched",async()=>{
    const {source}=await sourceSetup(),db=database();
    await expect(write({db:db.db,receiver,source})).resolves.toEqual({groupCount:1,idempotent:false});
    expect(db.state.component).toMatchObject({component:"committee",candidate_id:receiver.candidateId,election_id:receiver.electionId,
      total_amount_cents:10000,occurrence_count:2,source_row_count:5,current_row_count:4,historical_row_count:1,excluded_current_row_count:2});
    expect(db.state.groups).toHaveLength(1);
    expect(db.query.mock.calls.filter(([sql])=>/^(INSERT|UPDATE|DELETE)/.test(sql)).every(([sql])=>!sql.includes("nh_candidate_finance_"))).toBe(true);
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("reuses the same source idempotently without changing its financial clock",async()=>{
    const {source}=await sourceSetup(),db=database();await write({db:db.db,receiver,source});
    const clock=db.state.component!.source_retrieved_at,groups=structuredClone(db.state.groups);
    await expect(write({db:db.db,receiver,source})).resolves.toEqual({groupCount:1,idempotent:true});
    expect(db.state.component!.source_retrieved_at).toBe(clock);expect(db.state.groups).toEqual(groups);
  });

  it("rejects a conflicting equal-clock group population",async()=>{
    const {source}=await sourceSetup(),db=database();await write({db:db.db,receiver,source});
    db.state.groups[0]!.amount_cents=999;
    await expect(write({db:db.db,receiver,source})).rejects.toMatchObject({code:"equal_source_conflict"});
    expect(db.query).toHaveBeenLastCalledWith("ROLLBACK");
  });

  it("rejects a stale observation after a newer capture was written",async()=>{
    const {source,producer,base,state}=await sourceSetup(),db=database();
    state.receipts[0]!.transactionAmount=100;
    const newer=await producer.refreshComponent({kind:"committee",electionYear:2026,base:base.reference,filingEntityId:1000});
    await write({db:db.db,receiver,source:newer!});
    await expect(write({db:db.db,receiver,source})).rejects.toMatchObject({code:"stale_source"});
    expect(db.state.component!.total_amount_cents).toBe(12500);
  });

  it.each(["lost","withdrawn"])("rechecks candidate status under lock: %s",async status=>{
    const {source}=await sourceSetup(),db=database();db.state.status=status;
    await expect(write({db:db.db,receiver,source})).rejects.toMatchObject({code:"receiving_context_changed"});expect(db.state.component).toBeNull();
  });

  it("holds multiple active receiving links",async()=>{
    const {source}=await sourceSetup(),db=database();db.state.duplicateLinks=true;
    await expect(write({db:db.db,receiver,source})).rejects.toMatchObject({code:"receiving_context_changed"});
  });

  it("rejects copied packets and changed receiving registrations before connecting",async()=>{
    const {source}=await sourceSetup(),db=database();
    await expect(write({db:db.db,receiver,source:{...source}})).rejects.toMatchObject({code:"invalid_component_input"});
    await expect(write({db:db.db,receiver:{...receiver,filingEntityId:2000},source})).rejects.toMatchObject({code:"invalid_component_input"});
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("rolls back source and group replacement together",async()=>{
    const {source}=await sourceSetup(),db=database();db.state.failGroups=true;
    await expect(write({db:db.db,receiver,source})).rejects.toThrow("Synthetic group insertion failure");
    expect(db.state.component).toBeNull();expect(db.state.groups).toEqual([]);expect(db.release).toHaveBeenCalledOnce();
  });
});
