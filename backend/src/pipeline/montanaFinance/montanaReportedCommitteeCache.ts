import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createMontanaCersSession, buildMontanaCersUrl as url, buildMontanaCersDataTablesQuery,
  assertMontanaCersPageTitle, type MontanaCersResponse } from "./montanaCersClient.js";
import { parseMontanaCersCandidateSearchResults, type MontanaCersCandidateSearchRow } from "./montanaCersParsers.js";
import { aggregateMontanaReportedCommitteeReceipts, selectMontanaCommitteeReceiptReports, mtCommitteeCanonical as canonical,
  mtCommitteeHold as hold, mtCommitteeTable, mtCommitteeObject, type MontanaCommitteeScope, type MontanaReportedCommitteeAggregation } from "./montanaReportedCommitteeSource.js";

const DEFAULT_CACHE = fileURLToPath(new URL("../../../scratch/montana-campaign-finance/reported-committees/", import.meta.url));
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
type Capture = { role: string; method: "GET" | "POST"; url: string; form: Record<string,string> | null;
  context: Record<string,string> | null;
  status: number; capturedAt: string; bytes: number; sha256: string };
type Manifest = { version: 1; scope: MontanaCommitteeScope; captures: Capture[] };
export type MontanaCommitteePacket = Readonly<{ scope: MontanaCommitteeScope; sourceRetrievedAt: string; sourceCompletedAt: string;
  sourceManifestSha256: string; sourceByteSize: number }>;
type PrivatePacket = { aggregation: MontanaReportedCommitteeAggregation; candidates: MontanaCersCandidateSearchRow[]; manifest: Manifest };
const packets = new WeakMap<MontanaCommitteePacket, PrivatePacket>();
export function montanaCommitteePacketData(packet: MontanaCommitteePacket): PrivatePacket {
  const data = packets.get(packet); if (!data) hold("unverified_original_packet"); return structuredClone(data);
}
function scopeKey(scope: MontanaCommitteeScope) {
  if (!Number.isSafeInteger(scope.nativeCandidateId) || scope.nativeCandidateId <= 0 || !Number.isSafeInteger(scope.electionYear) || scope.electionYear < 2020 || scope.electionYear > 2100) hold("invalid_cache_scope");
  return `${scope.electionYear}-${scope.nativeCandidateId}`;
}
async function directory(dir: string) { await fs.mkdir(dir, {recursive:true,mode:0o700}); await fs.chmod(dir,0o700); }
async function immutable(file: string, bytes: Buffer | string) {
  try { await fs.writeFile(file,bytes,{flag:"wx",mode:0o600}); }
  catch(e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    if (!Buffer.from(await fs.readFile(file)).equals(Buffer.from(bytes))) hold("immutable_source_conflict"); }
  await fs.chmod(file,0o600);
}
const query = (start=0) => ({...buildMontanaCersDataTablesQuery(1000),iDisplayStart:String(start)});
/** Contact-array order is immaterial; preserve every original byte and value. */
export function montanaCommitteeInventoryProjection(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(montanaCommitteeInventoryProjection);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(Object.entries(v).map(([k,value]) => [k,
    ["addressList","phoneList"].includes(k) && Array.isArray(value)
      ? value.map(montanaCommitteeInventoryProjection).sort((a,b)=>canonical(a).localeCompare(canonical(b)))
      : montanaCommitteeInventoryProjection(value)]));
}
const graph = (value: unknown) => {
  const t=mtCommitteeTable(value); if(t.filtered!==t.rows.length || t.total!==t.filtered) hold("incomplete_candidate_identity_graph");
  const rows=parseMontanaCersCandidateSearchResults(JSON.stringify(value));
  if(new Set(rows.map(r=>r.candidateId)).size!==rows.length) hold("duplicate_native_candidate");
  return rows.sort((a,b)=>a.candidateId-b.candidateId);
};
function replay(manifest: Manifest, bodies: Buffer[], digest: string): MontanaCommitteePacket {
  if(manifest.version!==1 || manifest.captures.length!==bodies.length || bodies.length<12 || bodies.length>400) hold("invalid_original_manifest");
  scopeKey(manifest.scope); const records=manifest.captures;
  let byteSize=0;
  records.forEach((c,i)=>{
    const u=new URL(c.url); if(u.origin!=="https://cers-ext.mt.gov" || !u.pathname.startsWith("/CampaignTracker/public/") || u.username || u.password || u.hash ||
      !["GET","POST"].includes(c.method) || ![200,302].includes(c.status) || !Number.isFinite(Date.parse(c.capturedAt)) || Date.parse(c.capturedAt)>Date.now() ||
      c.bytes!==bodies[i]!.length || c.sha256!==hash(bodies[i]!)) hold("invalid_original_capture");
    if(i && Date.parse(c.capturedAt)<Date.parse(records[i-1]!.capturedAt)) hold("unordered_source_clocks");
    byteSize+=c.bytes;
  });
  if(byteSize<1 || byteSize>256*1024*1024) hold("original_byte_budget");
  const role=(name:string)=>records.flatMap((c,i)=>c.role===name?[{c,body:bodies[i]!}]:[]);
  const one=(name:string)=>{const rows=role(name);if(rows.length!==1)hold("original_role_membership");return rows[0]!;};
  const json=(entry:{body:Buffer})=>{try{return JSON.parse(entry.body.toString("utf8")) as unknown;}catch{hold("invalid_original_json");}};
  const opening=graph(json(one("candidate_open"))),closing=graph(json(one("candidate_close")));
  if(canonical(opening)!==canonical(closing) || !opening.some(r=>r.candidateId===manifest.scope.nativeCandidateId && r.electionYear===manifest.scope.electionYear)) hold("candidate_identity_changed");
  const inventory=json(one("inventory_open")),end=json(one("inventory_close"));
  if(canonical(montanaCommitteeInventoryProjection(inventory))!==canonical(montanaCommitteeInventoryProjection(end))) hold("native_report_inventory_changed");
  const reports=selectMontanaCommitteeReceiptReports(inventory,manifest.scope);
  // No genuine standalone C7 detail sample has been verified yet. Preserve the
  // component until its parent/detail semantics are established, never omit it.
  if(reports.some(r=>r.form==="C7")) hold("standalone_rapid_report_unverified");
  const details=role("committee_detail").map(e=>{
    const c=mtCommitteeObject(e.c.context),reportId=Number(c.reportId);
    if(!Number.isSafeInteger(reportId)||c.candidateId!==String(manifest.scope.nativeCandidateId)||e.c.form?.listName!=="committee"||
      e.c.method!=="POST"||new URL(e.c.url).pathname!=="/CampaignTracker/public/viewFinanceReport/financeRepDetailList"||e.c.status!==200)hold("invalid_detail_request_binding");
    return {reportId,rows:json(e)};
  });
  const pages=(name:string)=>role(name).map(e=>({start:Number(new URL(e.c.url).searchParams.get("iDisplayStart")),body:json(e)}));
  const count=(name:string)=>{const e=one(name);
    if(e.c.form?.candidateId!==String(manifest.scope.nativeCandidateId)||e.c.form?.committeeId!=="0"||e.c.method!=="POST"||
      new URL(e.c.url).pathname!=="/CampaignTracker/public/searchResults/viewFinancialEntities"||e.c.status!==200)hold("invalid_receiving_request_binding");
    return mtCommitteeObject(json(e)).resultCount;};
  const a=aggregateMontanaReportedCommitteeReceipts({scope:manifest.scope,inventory,details,pages:pages("receiving_open"),resultCount:count("count_open")});
  const b=aggregateMontanaReportedCommitteeReceipts({scope:manifest.scope,inventory:end,details,pages:pages("receiving_close"),resultCount:count("count_close")});
  const ledger=(name:string)=>pages(name).flatMap(p=>mtCommitteeTable(p.body).rows).map(montanaCommitteeInventoryProjection).map(canonical).sort();
  if(canonical(a)!==canonical(b) || canonical(ledger("receiving_open"))!==canonical(ledger("receiving_close"))) hold("receiving_ledger_changed");
  const packet=Object.freeze({scope:Object.freeze({...manifest.scope}),sourceRetrievedAt:records[0]!.capturedAt,
    sourceCompletedAt:records.at(-1)!.capturedAt,sourceManifestSha256:digest,sourceByteSize:byteSize});
  packets.set(packet,{aggregation:a,candidates:opening,manifest:structuredClone(manifest)});return packet;
}
/** Saved originals are replayed before network; a failed refresh leaves the
 * qualified pointer and its original observation times untouched. */
export async function readMontanaCommitteePacket(scope: MontanaCommitteeScope, cacheDir=DEFAULT_CACHE): Promise<MontanaCommitteePacket|null> {
  const key=scopeKey(scope);let pointer:string;
  try{pointer=(await fs.readFile(path.join(cacheDir,`${key}.latest`),"utf8")).trim();}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw e;}
  if(!/^[a-f0-9]{64}$/.test(pointer))hold("invalid_cache_pointer");
  const raw=await fs.readFile(path.join(cacheDir,"manifests",pointer+".json"));if(hash(raw)!==pointer)hold("manifest_hash_mismatch");
  const manifest=JSON.parse(raw.toString("utf8")) as Manifest;if(canonical(manifest.scope)!==canonical(scope))hold("wrong_cached_receiver");
  const bodies=[];for(const c of manifest.captures){if(!/^[a-f0-9]{64}$/.test(c.sha256))hold("invalid_original_hash");bodies.push(await fs.readFile(path.join(cacheDir,"objects",c.sha256)));}
  return replay(manifest,bodies,pointer);
}
export async function acquireMontanaCommitteePacket(scope: MontanaCommitteeScope, cacheDir=DEFAULT_CACHE): Promise<MontanaCommitteePacket> {
  const key=scopeKey(scope);await directory(cacheDir);await directory(path.join(cacheDir,"objects"));await directory(path.join(cacheDir,"manifests"));
  await directory(path.join(cacheDir,"runs"));const journal=path.join(cacheDir,"runs",randomUUID()+".ndjson");
  await fs.writeFile(journal,JSON.stringify({version:1,scope})+"\n",{flag:"wx",mode:0o600});await fs.chmod(journal,0o600);
  const manifest:Manifest={version:1,scope:{...scope},captures:[]},bodies:Buffer[]=[];let bytes=0,last=0,role="navigation",binding:Record<string,string>|null=null;
  const started=Date.now();
  const session=()=>createMontanaCersSession({maxAttempts:1,spacingMs:1000,timeoutMs:60000,maxResponseBytes:16*1024*1024,
    userAgent:"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
    fetchImpl:async(input,init)=>{
      if(manifest.captures.length>=400 || Date.now()-started>20*60000)hold("acquisition_request_budget");
      if(last)await new Promise(r=>setTimeout(r,Math.max(0,1000-(Date.now()-last))));last=Date.now();
      const response=await fetch(input,init),consume=response.arrayBuffer.bind(response);
      response.arrayBuffer=async()=>{
        const buffer=await consume(),body=Buffer.from(buffer);bytes+=body.length;
        if(body.length>16*1024*1024 || bytes>256*1024*1024)hold("original_byte_budget");
        const c:Capture={role,method:init.method,url:input,form:init.body?Object.fromEntries(new URLSearchParams(init.body)):null,context:binding?{...binding}:null,
          status:response.status,capturedAt:new Date().toISOString(),bytes:body.length,sha256:hash(body)};
        await immutable(path.join(cacheDir,"objects",c.sha256),body);
        await fs.appendFile(journal,JSON.stringify(c)+"\n",{mode:0o600});manifest.captures.push(c);bodies.push(body);return buffer;
      };return response;
    }});
  const parse=(r:MontanaCersResponse)=>{if(r.status!==200)hold("unexpected_native_status");try{return JSON.parse(r.text()) as unknown;}catch{hold("invalid_native_json");}};
  async function candidateGraph(name:string){
    role="navigation";const s=session();await s.get(url("search/candidateSearch"));
    const r=await s.postForm(url("searchResults/searchCandidates"),{lastName:"",firstName:"",middleInitial:"",candidateTypeCode:"",officeCode:"",countyCode:"",partyCode:"",electionYear:String(scope.electionYear)});
    assertMontanaCersPageTitle(r.text(),"searchResults","candidate registry");role=name;
    return graph(parse(await s.get(url("searchResults/listCandidateResults",buildMontanaCersDataTablesQuery(5000)))));
  }
  await candidateGraph("candidate_open");
  const s=session();role="navigation";await s.get(url("search/candidateSearch"));
  const redirect=await s.postForm(url("publicReportList/retrieveCampaignReports"),{candidateId:String(scope.nativeCandidateId),searchType:"",searchPage:"public"});
  if(redirect.status!==302)hold("invalid_inventory_redirect");await s.get(url("publicReportList"));
  role="inventory_open";const inventory=parse(await s.get(url("publicReportList/listFinanceReports",buildMontanaCersDataTablesQuery(5000))));
  const reports=selectMontanaCommitteeReceiptReports(inventory,scope);if(reports.some(r=>r.form==="C7"))hold("standalone_rapid_report_unverified");
  for(const report of reports){
    role="navigation";const r=await s.postForm(url("viewFinanceReport/retrieveReport"),{candidateId:String(scope.nativeCandidateId),reportId:String(report.reportId),searchPage:"public"});
    if(![200,302].includes(r.status))hold("invalid_report_redirect");
    if(r.status===302){if(!r.redirectLocation)hold("missing_report_location");await s.get(new URL(r.redirectLocation,url("viewFinanceReport/retrieveReport")).href);}
    role="committee_detail";binding={candidateId:String(scope.nativeCandidateId),reportId:String(report.reportId)};
    parse(await s.postForm(url("viewFinanceReport/financeRepDetailList"),{listName:"committee"}));binding=null;
  }
  async function receiving(suffix:string){
    role="navigation";const f=session();await f.get(url("search/candidateSearch"));
    const r=await f.postForm(url("searchResults/searchFinancials"),{financialSearchType:"CONTR",contrSearchTypeCode:"CANDIDATE",lastName:"",firstName:"",contrSearchFromDate:"",contrSearchToDate:"",electionYear:String(scope.electionYear)});
    assertMontanaCersPageTitle(r.text(),"searchResults","committee receipts");role="count_"+suffix;
    parse(await f.postForm(url("searchResults/viewFinancialEntities"),{candidateId:String(scope.nativeCandidateId),committeeId:"0"}));
    let start=0,total=0;do{role="receiving_"+suffix;const t=mtCommitteeTable(parse(await f.get(url("searchResults/listViewFinancialEntityResults",query(start)))));
      if(start && t.filtered!==total || !t.rows.length && t.filtered!==0)hold("incomplete_receiving_page");total=t.filtered;start+=t.rows.length;if(start>total)hold("receiving_page_overrun");
    }while(start<total);
  }
  await receiving("open");await receiving("close");
  // A separate fresh report session avoids financial-search session state.
  role="navigation";const close=session();await close.get(url("search/candidateSearch"));
  const r=await close.postForm(url("publicReportList/retrieveCampaignReports"),{candidateId:String(scope.nativeCandidateId),searchType:"",searchPage:"public"});
  if(r.status!==302)hold("invalid_inventory_redirect");await close.get(url("publicReportList"));role="inventory_close";
  parse(await close.get(url("publicReportList/listFinanceReports",buildMontanaCersDataTablesQuery(5000))));await candidateGraph("candidate_close");
  const raw=Buffer.from(JSON.stringify(manifest)),digest=hash(raw);
  // Retain a complete acquisition even when qualification holds. It must
  // still pass ordinary replay before a qualified pointer can reference it.
  await immutable(path.join(cacheDir,"manifests",digest+".json"),raw);
  const packet=replay(manifest,bodies,digest);
  const temp=path.join(cacheDir,`${key}.${randomUUID()}.tmp`);await fs.writeFile(temp,digest+"\n",{flag:"wx",mode:0o600});await fs.chmod(temp,0o600);
  await fs.rename(temp,path.join(cacheDir,`${key}.latest`));return packet;
}
