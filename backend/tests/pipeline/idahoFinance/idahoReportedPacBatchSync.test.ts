import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdahoPacSourceProducer, readIdahoPacSource } from "../../../src/pipeline/idahoFinance/idahoReportedPacCache.js";
import { listDueIdahoReportedPacReceipts, syncDueIdahoReportedPacReceipts } from "../../../src/pipeline/idahoFinance/idahoReportedPacBatchSync.js";
import { idahoPacFixture, pacReceiver as receiver, pacScope } from "./idahoReportedPacFixtures.js";
const missing = { ...receiver, source_clock:null,source_manifest:null,source_registration:null,source_candidate:null,source_election:null,
  last_attempted_at:null,attempt_registration:null,attempt_candidate:null,attempt_election:null,attempt_manifest:null };
let cacheDir:string;
beforeEach(async()=>{cacheDir=await mkdtemp(join(tmpdir(),"id-pac-batch-"));vi.stubEnv("IDAHO_CAMPAIGN_FINANCE_ENABLED","true");vi.stubEnv("IDAHO_REPORTED_PAC_RECEIPTS_ENABLED","true");vi.stubEnv("IDAHO_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED","false");});
afterEach(async()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();await rm(cacheDir,{recursive:true,force:true});});
function database(rows:unknown[]=[missing]) {
  const query=vi.fn(async(sql:string)=>{
    if(sql.includes("LEFT JOIN public.id_reported_pac_sources"))return{rows};
    if(sql.includes("SELECT l.id::text link_id"))return{rows:[receiver]};
    if(sql.includes("SELECT id::text,link_status"))return{rows:[{link_status:"active"}]};return{rows:[]};
  });
  return{db:{query,connect:vi.fn(async()=>({query,release:vi.fn()}))}as unknown as Pool,query};
}
describe("independent Idaho PAC ordinary sync",()=>{
  it("selects missing components without a legacy freshness prerequisite",async()=>{
    const{db,query}=database(),due=await listDueIdahoReportedPacReceipts({db,cacheDir});expect(due.rows).toEqual([receiver]);
    const sql=query.mock.calls[0]![0];expect(sql).toContain("e.election_stage='general'");expect(sql).toContain("extract(year from e.election_date)::int=l.election_year");expect(sql).not.toMatch(/legacy\.last_synced_at\s*[<=>]/);
  });
  it("uses its own source clock when the legacy summary is stale",async()=>{
    const{db}=database([{...missing,source_clock:new Date().toISOString(),source_registration:receiver.registration_guid,source_candidate:receiver.candidate_id,source_election:receiver.election_id}]);
    expect((await listDueIdahoReportedPacReceipts({db,cacheDir})).rows).toHaveLength(0);
  });
  it("rotates held attempts; refresh retains canonical filters",async()=>{
    const{db}=database([{...missing,last_attempted_at:new Date().toISOString(),attempt_registration:receiver.registration_guid,attempt_candidate:receiver.candidate_id,attempt_election:receiver.election_id}]);
    expect((await listDueIdahoReportedPacReceipts({db,cacheDir})).rows).toHaveLength(0);
    expect((await listDueIdahoReportedPacReceipts({db,cacheDir,refresh:true})).rows).toHaveLength(1);
  });
  it("wakes a newly saved source despite a recent held attempt",async()=>{
    await createIdahoPacSourceProducer({cacheDir,fetchImpl:idahoPacFixture().fetchImpl,minimumGapMs:0}).refresh(pacScope);
    const{db}=database([{...missing,last_attempted_at:new Date().toISOString(),attempt_registration:receiver.registration_guid,attempt_candidate:receiver.candidate_id,attempt_election:receiver.election_id}]);
    expect((await listDueIdahoReportedPacReceipts({db,cacheDir})).rows).toHaveLength(1);
  });
  it("ordinary saved-source path replays originals and atomically writes money without transport",async()=>{
    await createIdahoPacSourceProducer({cacheDir,fetchImpl:idahoPacFixture().fetchImpl,minimumGapMs:0}).refresh(pacScope);
    const{db,query}=database(),result=await syncDueIdahoReportedPacReceipts({db,cacheDir});
    expect(result).toMatchObject({attemptedCount:1,savedSourceCount:1,writtenCount:1,heldCount:0});expect(query.mock.calls.some(c=>c[0].includes("INSERT INTO public.id_reported_pac_groups"))).toBe(true);
  });
  it("missing source writes only a nonfinancial attempt",async()=>{
    const{db,query}=database(),result=await syncDueIdahoReportedPacReceipts({db,cacheDir});
    expect(result).toMatchObject({writtenCount:0,heldCount:1,holds:{source_unavailable:1}});expect(query.mock.calls.filter(c=>/^(INSERT|UPDATE|DELETE)/.test(c[0])).every(c=>c[0].includes("id_reported_pac_attempts"))).toBe(true);
  });
  it("failed ordinary refresh preserves the prior source/date and financial rows",async()=>{
    const f=idahoPacFixture(),saved=(await createIdahoPacSourceProducer({cacheDir,fetchImpl:f.fetchImpl,minimumGapMs:0}).refresh(pacScope))!;
    f.state.status=503;vi.stubGlobal("fetch",f.fetchImpl);vi.stubEnv("IDAHO_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED","true");
    const{db,query}=database(),result=await syncDueIdahoReportedPacReceipts({db,cacheDir,refresh:true});
    expect(result).toMatchObject({writtenCount:0,heldCount:1,acquisitionStopped:true,holds:{native_transport_unavailable:1}});
    expect((await readIdahoPacSource({...pacScope,cacheDir}))?.sourceRetrievedAt).toBe(saved.sourceRetrievedAt);
    expect(query.mock.calls.filter(c=>/^(INSERT|UPDATE|DELETE)/.test(c[0])).every(c=>c[0].includes("id_reported_pac_attempts"))).toBe(true);
  });
  it("disabled and dry-run paths perform no financial writes",async()=>{
    const{db,query}=database();vi.stubEnv("IDAHO_REPORTED_PAC_RECEIPTS_ENABLED","false");expect((await syncDueIdahoReportedPacReceipts({db,cacheDir})).enabled).toBe(false);expect(query).not.toHaveBeenCalled();
    vi.stubEnv("IDAHO_REPORTED_PAC_RECEIPTS_ENABLED","true");await syncDueIdahoReportedPacReceipts({db,cacheDir,dryRun:true});expect(query.mock.calls.some(c=>/^(INSERT|UPDATE|DELETE)/.test(c[0]))).toBe(false);
  });
});
