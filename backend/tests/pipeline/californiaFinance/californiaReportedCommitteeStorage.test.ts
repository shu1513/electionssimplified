import {afterEach,describe,expect,it,vi} from "vitest";
import fs from "node:fs/promises";
import {caReceiver as r,caCover,caReceipt,caSummary,californiaSourceFixture} from "./californiaReportedCommitteeFixture.js";
import {readCaliforniaCommitteePacket} from "../../../src/pipeline/californiaFinance/californiaReportedCommitteeSource.js";
import {writeCaliforniaCommitteeComponent,readStoredCaliforniaCommitteeComponent} from "../../../src/pipeline/californiaFinance/californiaReportedCommitteeWriter.js";
import {qualifyCaliforniaCommitteeReceiver} from "../../../src/pipeline/californiaFinance/californiaReportedCommitteeReceiver.js";
import {overlayCaliforniaCommitteeReceipts} from "../../../src/pipeline/californiaFinance/californiaReportedCommitteeReader.js";
import {syncDueCaliforniaCommitteeReceipts,listDueCaliforniaCommitteeReceipts} from "../../../src/pipeline/californiaFinance/californiaReportedCommitteeBatchSync.js";
import {parseCaliforniaReportedCommitteeArgs} from "../../../src/scripts/syncDueCaliforniaReportedCommitteeReceipts.js";
const dirs:string[]=[];afterEach(async()=>{vi.unstubAllEnvs();for(const d of dirs)await fs.rm(d,{recursive:true,force:true});dirs.length=0;});
function enabled(){vi.stubEnv("CANDIDATE_FINANCE_ENABLED","true");vi.stubEnv("CALIFORNIA_CAMPAIGN_FINANCE_ENABLED","true");vi.stubEnv("CALIFORNIA_REPORTED_COMMITTEE_RECEIPTS_ENABLED","true");vi.stubEnv("CALIFORNIA_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED","false");}
async function source(){const f=await californiaSourceFixture({receipts:Array.from({length:7},(_,i)=>caReceipt({LINE_ITEM:String(i+1),CMTE_ID:String(200+i),CTRIB_NAML:`Synthetic Committee ${i}`})),summaries:[caSummary({AMOUNT_A:"700.00"})]});dirs.push(f.dir);return {...f,packet:await readCaliforniaCommitteePacket(["100"],f.dir)};}
function database(){let stored:Record<string,unknown>|null=null,groups:Record<string,unknown>[]=[];
  const query=vi.fn(async(sql:string,args:unknown[]=[])=>{
    if(sql.includes("SELECT * FROM public.ca_reported_committee_sources"))return {rows:stored?[stored]:[]};
    if(sql.includes("SELECT * FROM public.ca_reported_committee_groups"))return {rows:groups};
    if(sql.includes("SELECT id::text,link_status"))return {rows:[{id:r.link_id,link_status:"active"}]};
    if(sql.includes("FOR UPDATE OF"))return {rows:[r]};
    if(sql.includes("INSERT INTO public.ca_reported_committee_sources")){const names=["link_id","election_year","candidate_id","election_id","receiving_committee_id","total_cents","group_count","selected_row_count","source_retrieved_at","source_completed_at","source_sha256","source_byte_size","source_facts","aggregation_controls","last_synced_at"];stored=Object.fromEntries(names.map((n,i)=>[n,["source_facts","aggregation_controls"].includes(n)?JSON.parse(args[i] as string):args[i]]));}
    if(sql.includes("DELETE FROM public.ca_reported_committee_groups"))groups=[];
    if(sql.includes("INSERT INTO public.ca_reported_committee_groups"))groups=JSON.parse(args[2] as string).map((g:Record<string,unknown>)=>({link_id:r.link_id,election_year:r.election_year,group_key:g.key,reported_name:g.name,entity_code:g.entityCode,native_committee_id:g.nativeCommitteeId,amount_cents:g.cents,positive_cents:g.positiveCents,negative_cents:g.negativeCents,gift_count:g.giftCount,correction_count:g.correctionCount}));
    return {rows:[]};
  }),release=vi.fn(),connect=vi.fn(async()=>({query,release}));return {db:{query,connect} as never,query,connect,stored:()=>stored!,groups:()=>groups};
}
describe("California independent reported committee storage",()=>{
  it("writes only its own tables under canonical locks with true source clocks and complete groups",async()=>{
    const {packet}=await source(),d=database();expect(await writeCaliforniaCommitteeComponent({db:d.db,receiver:r,source:packet})).toEqual({totalCents:70000,groups:7,idempotent:false});
    expect(d.query.mock.calls.filter(([sql])=>/^(INSERT|DELETE|UPDATE)/.test(sql)).every(([sql])=>sql.includes("public.ca_reported_committee_"))).toBe(true);
    expect(d.stored()).toMatchObject({source_retrieved_at:packet.sourceRetrievedAt,source_completed_at:packet.sourceCompletedAt,total_cents:70000});expect(await writeCaliforniaCommitteeComponent({db:d.db,receiver:r,source:packet})).toMatchObject({idempotent:true});
    d.groups()[6]!.amount_cents=1;await expect(writeCaliforniaCommitteeComponent({db:d.db,receiver:r,source:packet})).rejects.toThrow(/group_money_count|closure/);expect(d.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });
  it("keeps equal-source identity stable across ordinary batches with different receiving scopes",async()=>{
    const f=await californiaSourceFixture({covers:[caCover(),caCover({FILING_ID:"11",FILER_ID:"300"})],receipts:[caReceipt(),caReceipt({FILING_ID:"11"})],summaries:[caSummary(),caSummary({FILING_ID:"11"})]});dirs.push(f.dir);const d=database();
    await writeCaliforniaCommitteeComponent({db:d.db,receiver:r,source:await readCaliforniaCommitteePacket(["100"],f.dir)});
    expect(await writeCaliforniaCommitteeComponent({db:d.db,receiver:r,source:await readCaliforniaCommitteePacket(["100","300"],f.dir)})).toMatchObject({idempotent:true});
  });
  it("rejects unbranded packets and older sources and rolls back failed writes",async()=>{
    const {packet}=await source(),d=database();await expect(writeCaliforniaCommitteeComponent({db:d.db,receiver:r,source:{...packet}})).rejects.toThrow(/unverified_source_packet/);expect(d.connect).not.toHaveBeenCalled();
    await writeCaliforniaCommitteeComponent({db:d.db,receiver:r,source:packet});d.stored().source_completed_at=new Date(Date.parse(packet.sourceCompletedAt)+1).toISOString();await expect(writeCaliforniaCommitteeComponent({db:d.db,receiver:r,source:packet})).rejects.toThrow(/older_source/);
    const broken=database(),normal=broken.query.getMockImplementation()!;broken.query.mockImplementation(async(sql,args)=>{if(sql.includes("INSERT INTO public.ca_reported_committee_groups"))throw Error("synthetic storage failure");return normal(sql,args);});await expect(writeCaliforniaCommitteeComponent({db:broken.db,receiver:r,source:packet})).rejects.toThrow("synthetic storage failure");expect(broken.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });
  it("validates the entire component before five-name caps, preserving legacy money and clocks",async()=>{
    enabled();const {packet}=await source(),d=database();await writeCaliforniaCommitteeComponent({db:d.db,receiver:r,source:packet});const query=vi.fn(async()=>({rows:[{...r,committee_source:d.stored(),committee_groups:d.groups()}]})),summaries=new Map(),candidates=[{candidate_id:r.candidate_id,election_id:r.election_id}],elections=[{election_id:r.election_id,state:"CA",office_scope:r.office_scope,office_canonical_name:r.office_name}];
    await overlayCaliforniaCommitteeReceipts({query},summaries,candidates,elections);let a=[...summaries.values()][0];expect(a.direct_campaign.total_raised).toBeNull();expect(a.direct_campaign.pac_money_basis).toBe("reported_committee_itemized_contributions");expect(a.direct_campaign.pac_money_by_interest).toMatchObject([{amount:700,pac_count:7,pacs:expect.any(Array)}]);expect(a.direct_campaign.pac_money_by_interest[0].pacs).toHaveLength(5);
    a.direct_campaign.total_raised=123;a.outside_spending.support_total=456;a.last_synced_at="2026-01-01T00:00:00.000Z";await overlayCaliforniaCommitteeReceipts({query},summaries,candidates,elections);a=[...summaries.values()][0];expect(a).toMatchObject({last_synced_at:"2026-01-01T00:00:00.000Z",direct_campaign:{total_raised:123},outside_spending:{support_total:456}});
    const prior=structuredClone(a);d.groups()[6]!.amount_cents=1;await overlayCaliforniaCommitteeReceipts({query},summaries,candidates,elections);expect([...summaries.values()][0]).toEqual(prior);expect(()=>readStoredCaliforniaCommitteeComponent(d.stored(),d.groups(),r)).toThrow();
  });
  it("uses independent default-25 due/source clocks, hold rotation and process-only deadline CLI",async()=>{
    enabled();const rows=Array.from({length:27},(_,i)=>({...r,link_id:String(i)})),query=vi.fn(async()=>({rows})),connect=vi.fn(),db={query,connect} as never;
    expect((await listDueCaliforniaCommitteeReceipts({db})).rows).toHaveLength(25);const [sql,args]=query.mock.calls[0] as unknown as [string,unknown[]];expect(sql).toContain("s.source_retrieved_at");expect(sql).toContain("interval '24 hours'");expect(sql).not.toContain("ca_candidate_finance_summaries");expect(args.slice(2,5)).toEqual([98,730,7]);
    expect(await syncDueCaliforniaCommitteeReceipts({db,dryRun:true})).toMatchObject({enabled:true,totalDueRows:27,attemptedCount:0});expect(connect).not.toHaveBeenCalled();
    vi.stubEnv("CALIFORNIA_CAMPAIGN_FINANCE_ENABLED","false");query.mockClear();expect(await syncDueCaliforniaCommitteeReceipts({db})).toMatchObject({enabled:false});expect(query).not.toHaveBeenCalled();
    expect(parseCaliforniaReportedCommitteeArgs(["--dry-run","--stale-after-days=1"])).toEqual({dryRun:true,staleAfterDays:1});for(const args of [["--candidate-id","100"],["--year","2026"],["--source-date","2026-01-01"],["--stale-after-days=0"],["--dry-run","--dry-run"]])expect(()=>parseCaliforniaReportedCommitteeArgs(args)).toThrow();
  });
  it("runs the ordinary component job against actual saved-source parsing and preserves money on a later source failure",async()=>{
    enabled();const {dir,packet}=await source(),d=database(),normal=d.query.getMockImplementation()!;
    d.query.mockImplementation(async(sql,args)=>sql.includes("LEFT JOIN public.ca_reported_committee_sources")?{rows:[r]}:normal(sql,args));
    expect(await syncDueCaliforniaCommitteeReceipts({db:d.db,cacheDir:dir})).toMatchObject({enabled:true,totalDueRows:1,attemptedCount:1,writtenCount:1,heldCount:0,totalCents:70000,groupCount:7});
    const before=structuredClone(d.stored());await fs.unlink(dir+"/dbwebexport.zip");expect(await syncDueCaliforniaCommitteeReceipts({db:d.db,cacheDir:dir})).toMatchObject({attemptedCount:1,writtenCount:0,heldCount:1,holds:{committee_evidence_unavailable:1}});expect(d.stored()).toEqual(before);expect(d.stored().source_retrieved_at).toBe(packet.sourceRetrievedAt);
  });
  it("holds a stale link when complete cover evidence resolves the candidate to a newer committee",async()=>{
    enabled();const old=caCover({FILER_NAML:"Synthetic Candidate Assembly 2024"}),current=caCover({FILING_ID:"11",FILER_ID:"300"}),f=await californiaSourceFixture({covers:[old,current]});dirs.push(f.dir);
    expect(()=>qualifyCaliforniaCommitteeReceiver(r,[old])).not.toThrow();
    const d=database(),normal=d.query.getMockImplementation()!;d.query.mockImplementation(async(sql,args)=>sql.includes("LEFT JOIN public.ca_reported_committee_sources")?{rows:[r]}:normal(sql,args));
    expect(await syncDueCaliforniaCommitteeReceipts({db:d.db,cacheDir:f.dir})).toMatchObject({attemptedCount:1,writtenCount:0,heldCount:1,holds:{stale_committee_link:1}});expect(d.stored()).toBeNull();
    expect(await syncDueCaliforniaCommitteeReceipts({db:d.db,cacheDir:f.dir,resolutionData:{zipPath:"",sourceUrl:"",campaignCoverRows:[old],filerNameRows:[]}})).toMatchObject({writtenCount:1,heldCount:0});
  });
});
