import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { captureOhioCommitteeSource } from "../../../src/pipeline/ohioFinance/ohioCommitteeSource.js";
import { qualifyOhioCommitteeReceiver,type OhioCommitteeReceiver } from "../../../src/pipeline/ohioFinance/ohioCommitteeReceiver.js";
import { readStoredOhioCommitteeComponent,writeOhioCommitteeReceipts } from "../../../src/pipeline/ohioFinance/ohioCommitteeWriter.js";
import { listDueOhioCommitteeReceipts,syncDueOhioCommitteeReceipts } from "../../../src/pipeline/ohioFinance/ohioCommitteeBatchSync.js";
import { overlayOhioCommitteeReceipts } from "../../../src/pipeline/ohioFinance/ohioCommitteeReader.js";
import { parseSyncDueOhioCommitteeReceiptsArgs } from "../../../src/scripts/syncDueOhioCommitteeReceipts.js";
import { isOhioReportedCommitteeReceiptsEnabled } from "../../../src/config/featureFlags.js";
import { makeOhioCommitteeNativeFixture } from "./ohioCommitteeSourceFixtures.js";
import type { StateFinanceRequestCandidateRow,StateFinanceRequestElectionRow } from "../../../src/pipeline/address/ballotLookupFinanceShared.js";

const receiver:OhioCommitteeReceiver={link_id:"10000000-0000-4000-8000-000000000001",candidate_id:"10000000-0000-4000-8000-000000000002",
  election_id:"10000000-0000-4000-8000-000000000003",election_year:2026,committee_id:"100",link_source:"sos_bulk_export",
  link_candidate_name:"SYNTHETIC CANDIDATE",link_committee_name:"Synthetic Candidate Committee",link_district:"1",link_office_name:"State Lower Chamber Legislator",
  candidate_name:"Synthetic Candidate",full_name:"Synthetic Candidate",office_scope:"state_lower",office_name:"State Lower Chamber Legislator",district:"1",election_date:"2026-11-03"};
type Row=Record<string,unknown>;
function storage(){
  let source:Row|null=null,groups:Row[]=[],snapshot:{source:Row|null;groups:Row[]}|null=null;
  const state={receiver:{...receiver},siblings:1,failGroups:false,sql:[] as string[],due:[] as Row[]};
  const query=vi.fn(async(sql:string,p:unknown[]=[])=>{
    state.sql.push(sql);
    if(sql==="BEGIN")snapshot=structuredClone({source,groups});
    else if(sql==="ROLLBACK"){source=snapshot!.source;groups=snapshot!.groups;}
    else if(sql.includes("a.source_revision attempt_revision"))return {rows:state.due};
    else if(sql.includes("to_jsonb(s) committee_source"))return {rows:source?[{...state.receiver,committee_source:source,committee_groups:groups}]:[]};
    else if(sql.includes("FOR UPDATE OF c,ce,e,d,o,l"))return {rows:[state.receiver]};
    else if(sql.startsWith("SELECT id::text,link_status"))return {rows:Array.from({length:state.siblings},()=>({link_status:"active"}))};
    else if(sql.startsWith("SELECT * FROM public.oh_reported_committee_sources"))return {rows:source?[source]:[]};
    else if(sql.startsWith("SELECT * FROM public.oh_reported_committee_groups"))return {rows:groups};
    else if(sql.startsWith("INSERT INTO public.oh_reported_committee_sources")){
      const keys=["link_id","election_year","candidate_id","election_id","receiving_committee_id","total_cents","group_count","source_row_count","source_retrieved_at","source_completed_at","source_manifest_sha256","source_byte_size","source_facts","aggregation_controls","last_synced_at"];
      source=Object.fromEntries(keys.map((k,i)=>[k,["source_facts","aggregation_controls"].includes(k)?JSON.parse(p[i] as string):p[i]]));
    }else if(sql.startsWith("DELETE FROM public.oh_reported_committee_groups"))groups=[];
    else if(sql.startsWith("INSERT INTO public.oh_reported_committee_groups")){
      if(state.failGroups)throw Error("synthetic group failure");
      groups=JSON.parse(p[2] as string).map((g:Row)=>({link_id:p[0],election_year:p[1],reported_source_key:g.key,reported_name:g.name,native_committee_id:g.nativeCommitteeId,amount_cents:g.cents,source_row_count:g.rowCount}));
    }
    return {rows:[]};
  });
  return {state,query,db:{query,connect:async()=>({query,release:vi.fn()})} as unknown as Pool,get source(){return source!;},get groups(){return groups;}};
}
let root:string,cacheDir:string,fixture:Awaited<ReturnType<typeof makeOhioCommitteeNativeFixture>>;
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),"oh-finance-"));cacheDir=join(root,"capture");fixture=await makeOhioCommitteeNativeFixture(root);
  vi.stubEnv("CANDIDATE_FINANCE_ENABLED","true");vi.stubEnv("OHIO_CAMPAIGN_FINANCE_ENABLED","true");vi.stubEnv("OHIO_REPORTED_COMMITTEE_RECEIPTS_ENABLED","true");vi.stubEnv("OHIO_SOS_RAW_DATA_REFRESH_ENABLED","false");});
afterEach(async()=>{vi.unstubAllEnvs();await rm(root,{recursive:true,force:true});});
const capture=()=>captureOhioCommitteeSource({cycleYear:2026,cacheDir,nativeCacheDir:fixture.nativeRoot});
async function saved(){const s=storage(),p=await capture();await writeOhioCommitteeReceipts({db:s.db,receiver,source:p});return {s,p};}
function metadata(changes:Row={}){return {...receiver,source_clock:null,source_manifest:null,source_native:null,source_committee:null,source_candidate:null,source_election:null,
  last_attempted_at:null,attempt_committee:null,attempt_candidate:null,attempt_election:null,attempt_revision:null,...changes};}
describe("Ohio pinned committee persistence",()=>{
  it("writes full source and groups without touching legacy tables",async()=>{const {s}=await saved();expect(s.source.total_cents).toBe(11000);expect(s.groups).toHaveLength(1);
    expect(readStoredOhioCommitteeComponent(s.source,s.groups,receiver).aggregation.selectedRows).toBe(2);
    expect(s.state.sql.some(x=>/\b(?:INSERT INTO|UPDATE|DELETE FROM) public\.oh_candidate_finance_/.test(x))).toBe(false);});
  it("rejects a cloned packet before opening a financial transaction",async()=>{const s=storage(),p=await capture();await expect(writeOhioCommitteeReceipts({db:s.db,receiver,source:{...p}})).rejects.toThrow(/unverified_source_packet/);expect(s.query).not.toHaveBeenCalled();});
  it("replays an equal source idempotently",async()=>{const {s,p}=await saved();expect(await writeOhioCommitteeReceipts({db:s.db,receiver,source:p})).toMatchObject({idempotent:true,totalCents:11000});});
  it("orders partial refreshes by newest original clock, not oldest freshness clock",async()=>{const {s,p}=await saved();await fixture.install(20000,true);const next=await capture();
    expect(next.sourceRetrievedAt).toBe(p.sourceRetrievedAt);expect(await writeOhioCommitteeReceipts({db:s.db,receiver,source:next})).toMatchObject({totalCents:21000,idempotent:false});
    await expect(writeOhioCommitteeReceipts({db:s.db,receiver,source:p})).rejects.toThrow(/stale_source/);});
  it("rejects changed source at an equal version clock",async()=>{const {s}=await saved();await fixture.install(20000,true);const next=await capture();await writeOhioCommitteeReceipts({db:s.db,receiver,source:next});
    await fixture.install(30000,true);await expect(writeOhioCommitteeReceipts({db:s.db,receiver,source:await capture()})).rejects.toThrow(/equal_source_conflict/);expect(s.source.total_cents).toBe(21000);});
  it("rolls source and groups back together",async()=>{const {s}=await saved();await fixture.install(20000,true);s.state.failGroups=true;
    await expect(writeOhioCommitteeReceipts({db:s.db,receiver,source:await capture()})).rejects.toThrow(/synthetic group failure/);expect(s.source.total_cents).toBe(11000);expect(s.groups[0]!.amount_cents).toBe(11000);});
  it("rejects canonical changes under transaction locks",async()=>{const s=storage(),p=await capture();s.state.receiver={...receiver,full_name:"Different Candidate"};
    await expect(writeOhioCommitteeReceipts({db:s.db,receiver,source:p})).rejects.toThrow(/receiving_context_changed/);expect(s.source).toBeNull();});
  it("rejects duplicate active links",async()=>{const s=storage(),p=await capture();s.state.siblings=2;await expect(writeOhioCommitteeReceipts({db:s.db,receiver,source:p})).rejects.toThrow(/receiving_context_changed/);});
  it("does not let a preferred name hide conflicting middle evidence",()=>{const rows=[{masterKey:"100",committeeName:"Synthetic Candidate Committee",candidateFirstName:"Synthetic Ann",candidateLastName:"Candidate",office:"HOUSE",district:"1"}];
    expect(()=>qualifyOhioCommitteeReceiver({...receiver,full_name:"Synthetic Beth Candidate"},2026,rows as never)).toThrow(/canonical_person_committee_mismatch/);});
  it.each(["district","office_name","link_committee_name"])("rejects changed canonical %s",async field=>{const {s}=await saved();expect(()=>readStoredOhioCommitteeComponent(s.source,s.groups,{...receiver,[field]:"Changed"})).toThrow();});
  it.each(["total_cents","group_count","source_row_count"])("checks stored %s",async field=>{const {s}=await saved();expect(()=>readStoredOhioCommitteeComponent({...s.source,[field]:999},s.groups,receiver)).toThrow();});
  it("checks all groups before a UI cap could conceal corruption",async()=>{const {s}=await saved();const groups=[...s.groups,...Array.from({length:6},(_,i)=>({...s.groups[0],reported_source_key:`committee:${i+700}`,native_committee_id:String(i+700),amount_cents:1}))];
    expect(()=>readStoredOhioCommitteeComponent(s.source,groups,receiver)).toThrow(/closure/);});
  it("checks report membership/count controls",async()=>{const {s}=await saved(),controls=structuredClone(s.source.aggregation_controls) as Row;controls.reports=[];
    expect(()=>readStoredOhioCommitteeComponent({...s.source,aggregation_controls:controls},s.groups,receiver)).toThrow();});
});
describe("Ohio independent scheduling and ordinary job",()=>{
  it("defaults the new gate off and respects the Ohio master",()=>{
    vi.stubEnv("OHIO_REPORTED_COMMITTEE_RECEIPTS_ENABLED",undefined);expect(isOhioReportedCommitteeReceiptsEnabled()).toBe(false);
    vi.stubEnv("OHIO_REPORTED_COMMITTEE_RECEIPTS_ENABLED","true");vi.stubEnv("OHIO_CAMPAIGN_FINANCE_ENABLED","false");expect(isOhioReportedCommitteeReceiptsEnabled()).toBe(false);
  });
  it("finds missing receipts independently of legacy summaries",async()=>{const s=storage();s.state.due=[metadata()];const r=await listDueOhioCommitteeReceipts({db:s.db,cacheDir});expect(r.rows).toHaveLength(1);
    expect(s.state.sql[0]).not.toContain("oh_candidate_finance_summaries");expect(s.state.sql[0]).toContain("make_interval");});
  it("defaults to 25 and retains the full due count",async()=>{const s=storage();s.state.due=Array.from({length:30},(_,i)=>metadata({link_id:`10000000-0000-4000-8000-${String(i).padStart(12,"0")}`}));
    const r=await listDueOhioCommitteeReceipts({db:s.db,cacheDir});expect(r.totalDueRows).toBe(30);expect(r.rows).toHaveLength(25);});
  it("rotates a held source for 24 hours",async()=>{const s=storage();s.state.due=[metadata({last_attempted_at:"2026-10-18T00:00:00Z",attempt_committee:receiver.committee_id,attempt_candidate:receiver.candidate_id,attempt_election:receiver.election_id,attempt_revision:"none:none"})];
    expect((await listDueOhioCommitteeReceipts({db:s.db,cacheDir,now:new Date("2026-10-18T01:00:00Z")})).rows).toHaveLength(0);
    expect((await listDueOhioCommitteeReceipts({db:s.db,cacheDir,now:new Date("2026-10-19T01:00:00Z")})).rows).toHaveLength(1);});
  it("new source wakes a recent held attempt",async()=>{const s=storage();await capture();s.state.due=[metadata({last_attempted_at:new Date().toISOString(),attempt_committee:receiver.committee_id,attempt_candidate:receiver.candidate_id,attempt_election:receiver.election_id,attempt_revision:"none:none"})];
    expect((await listDueOhioCommitteeReceipts({db:s.db,cacheDir})).rows).toHaveLength(1);});
  it("uses source acquisition freshness instead of a later write or attempt time",async()=>{
    const s=storage(),p=await capture();s.state.due=[metadata({source_clock:p.sourceRetrievedAt,source_manifest:p.sourceManifestSha256,source_native:p.nativeFingerprint,
      source_committee:receiver.committee_id,source_candidate:receiver.candidate_id,source_election:receiver.election_id})];
    expect((await listDueOhioCommitteeReceipts({db:s.db,cacheDir,now:new Date("2026-01-04T00:00:00Z")})).rows).toHaveLength(0);
    expect((await listDueOhioCommitteeReceipts({db:s.db,cacheDir,now:new Date("2026-01-12T00:00:00Z")})).rows).toHaveLength(1);
  });
  it("new native originals wake a held attempt before the saved pointer is replaced",async()=>{
    const s=storage(),p=await capture();vi.stubEnv("OHIO_SOS_RAW_DATA_REFRESH_ENABLED","true");vi.stubEnv("OHIO_SOS_RAW_DATA_CACHE_DIR",fixture.nativeRoot);
    s.state.due=[metadata({last_attempted_at:new Date().toISOString(),attempt_committee:receiver.committee_id,attempt_candidate:receiver.candidate_id,
      attempt_election:receiver.election_id,attempt_revision:`${p.sourceManifestSha256}:${p.nativeFingerprint}`})];
    expect((await listDueOhioCommitteeReceipts({db:s.db,cacheDir})).rows).toHaveLength(0);await fixture.install(20000,true);
    expect((await listDueOhioCommitteeReceipts({db:s.db,cacheDir})).rows).toHaveLength(1);
  });
  it("writes an ordinary saved-source job",async()=>{const s=storage();await capture();s.state.due=[metadata()];const r=await syncDueOhioCommitteeReceipts({db:s.db,cacheDir});
    expect(r).toMatchObject({attemptedCount:1,writtenCount:1,heldCount:0,savedSourceCount:1,capturedSourceCount:0});});
  it("holds missing originals instead of writing zero",async()=>{const s=storage();s.state.due=[metadata()];const r=await syncDueOhioCommitteeReceipts({db:s.db,cacheDir});expect(r.holds).toEqual({source_unavailable:1});expect(s.source).toBeNull();});
  it("dry run and disabled flags perform no writes",async()=>{const s=storage();s.state.due=[metadata()];expect((await syncDueOhioCommitteeReceipts({db:s.db,cacheDir,dryRun:true})).attemptedCount).toBe(0);
    vi.stubEnv("OHIO_REPORTED_COMMITTEE_RECEIPTS_ENABLED","false");expect((await syncDueOhioCommitteeReceipts({db:s.db})).enabled).toBe(false);expect(s.state.sql.some(x=>x==="BEGIN")).toBe(false);});
  it.each(["--candidate-id","--election-year","--cache-dir","--amount","--source-url"])("CLI rejects financial/source selector %s",flag=>{expect(()=>parseSyncDueOhioCommitteeReceiptsArgs([flag,"x"])).toThrow();});
});
describe("Ohio production receipt overlay",()=>{
  const candidates=[{candidate_id:receiver.candidate_id,election_id:receiver.election_id,state:"OH"}] as StateFinanceRequestCandidateRow[];
  const elections=[{election_id:receiver.election_id,state:"OH",office_scope:"state_lower",office_canonical_name:receiver.office_name}] as StateFinanceRequestElectionRow[];
  it("keeps unknown legacy totals unknown and shows reported committee scope",async()=>{const {s}=await saved(),map=await overlayOhioCommitteeReceipts(s.db,new Map(),candidates,elections);
    const value=[...map.values()][0]!;expect(value).toBeDefined();expect(value.direct_campaign.total_raised).toBeNull();expect(value.outside_spending.support_total).toBeNull();
    expect(value.direct_campaign.pac_money_by_interest?.[0]).toMatchObject({amount:110,pac_count:1,interest_name:"Not yet sorted"});expect(value.direct_campaign.pac_money_coverage_note).toContain("before separate expenditure-side");});
  it("rejects corrupted money without inventing a summary",async()=>{const {s}=await saved();s.groups[0]!.amount_cents=900;expect((await overlayOhioCommitteeReceipts(s.db,new Map(),candidates,elections)).size).toBe(0);});
});
