import fs from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import {DEFAULT_MONTANA_CERS_CACHE_DIR,readMontanaCersArtifact} from "./montanaCersArtifactCache.js";
import {parseMontanaCersCandidateSearchResults,parseMontanaCersIeSweepArtifact,type MontanaCersCandidateSearchRow} from "./montanaCersParsers.js";
import {classifyMontanaOutsideSpendingRows,aggregateMontanaOutsideSpendingForCandidate,type MontanaIeClassifiedRow} from "./montanaOutsideSpendingAggregator.js";
import {mtCommitteeCanonical as canonical,mtCommitteeTable,mtCommitteeObject,mtCommitteeInteger} from "./montanaReportedCommitteeSource.js";
import type {MontanaNativeCapture} from "./montanaNativeHttpArchive.js";
import {extractMontanaCersPageTitleMarker} from "./montanaCersClient.js";

export class MontanaIndependentIeError extends Error{constructor(readonly code:string){super(`Montana independent expenditures unavailable: ${code}`);this.name="MontanaIndependentIeError";}}
export function mtIeHold(code:string):never{throw new MontanaIndependentIeError(code);}
const hash=(b:Buffer|string)=>createHash("sha256").update(b).digest("hex");
export type MontanaIndependentIePacket=Readonly<{year:number;sourceRetrievedAt:string;sourceCompletedAt:string;sourceManifestSha256:string;
  sourceByteSize:number;sourceOriginalCount:number;sweepSha256:string;registrationSha256:string}>;
type Data={candidates:MontanaCersCandidateSearchRow[];classified:MontanaIeClassifiedRow[]};
const packets=new WeakMap<MontanaIndependentIePacket,Data>();
const data=(p:MontanaIndependentIePacket)=>{const d=packets.get(p);if(!d)mtIeHold("unverified_original_packet");return d;};
export const montanaIePacketCandidates=(p:MontanaIndependentIePacket)=>structuredClone(data(p).candidates);
export function montanaIePacketAggregation(p:MontanaIndependentIePacket,nativeCandidateId:number){
  return aggregateMontanaOutsideSpendingForCandidate({classifiedRows:data(p).classified, cersCandidateId:nativeCandidateId,
    sourceUrl:"https://cers-ext.mt.gov/CampaignTracker/dashboard",maxGroups:10000});
}
export function assertMontanaIePacket(p:MontanaIndependentIePacket){data(p);}

async function qualifyArchive(input:{directory:string;year:number;sweepBody:string;registrationBody:string;sweepSha256:string;registrationSha256:string}):Promise<MontanaIndependentIePacket>{
  if(!(await fs.lstat(input.directory)).isDirectory())mtIeHold("invalid_native_archive");
  const manifestPath=path.join(input.directory,"manifest.ndjson"),stat=await fs.lstat(manifestPath);
  if(!stat.isFile()||stat.size>5*1024*1024)mtIeHold("native_manifest_budget");const manifest=await fs.readFile(manifestPath);
  let captures:MontanaNativeCapture[];try{captures=manifest.toString("utf8").trim().split("\n").map(line=>JSON.parse(line));}catch{mtIeHold("incomplete_native_manifest");}
  if(captures.length>2000)mtIeHold("native_response_budget");
  const saved=mtCommitteeObject(JSON.parse(input.sweepBody)),expectedInventory=saved.committeeSearch,expectedTransactions=saved.committeeTransactions;
  if(saved.year!==input.year||!Array.isArray(expectedTransactions))mtIeHold("wrong_source_year");
  const expectedRegistration=JSON.parse(input.registrationBody),registry=mtCommitteeTable(expectedRegistration);
  if(registry.rows.length!==registry.filtered||registry.total!==registry.filtered||!registry.rows.length)mtIeHold("incomplete_candidate_registry");
  const candidates=parseMontanaCersCandidateSearchResults(input.registrationBody);
  if(new Set(candidates.map(r=>r.candidateId)).size!==candidates.length)mtIeHold("duplicate_native_candidate");
  let ie=false,active:number|null=null,inventory:unknown=null,registrationSeen=false,sourceBytes=0,sourceCount=0,min="",max="";
  const controls=new Map<number,number>(),ledgers=new Map<number,unknown>();
  for(const c of captures){
    const u=new URL(c.url),form=c.form;
    if(u.origin!=="https://cers-ext.mt.gov"||u.username||u.password||u.hash||!u.pathname.startsWith("/CampaignTracker/public/"))mtIeHold("unofficial_native_response");
    if(u.pathname.endsWith("/searchFinancials")){ie=form?.financialSearchType==="EXPEND"&&form?.independentExpendSearch==="true"&&form?.electionYear===String(input.year);active=null;}
    if(!ie||c.status!==200)continue;
    const kind=u.pathname.split("/").at(-1);
    if(!["searchFinancials","listFinancialCommitteeResults","viewFinancialEntities","listViewFinancialEntityResults","listCandidateResults"].includes(kind!))continue;
    mtCommitteeInteger(c.ordinal,1);mtCommitteeInteger(c.byteSize);
    if(!/^[a-f0-9]{64}$/.test(c.sha256)||!Number.isFinite(Date.parse(c.capturedAt))||new Date(c.capturedAt).toISOString()!==c.capturedAt||Date.parse(c.capturedAt)>Date.now())mtIeHold("invalid_native_capture");
    const originalPath=path.join(input.directory,String(c.ordinal).padStart(4,"0")+".original"),file=await fs.lstat(originalPath);
    if(!file.isFile()||file.size!==c.byteSize||file.size>64*1024*1024)mtIeHold("invalid_original_file");const raw=await fs.readFile(originalPath);
    if(raw.length!==c.byteSize||hash(raw)!==c.sha256)mtIeHold("original_hash_mismatch");
    sourceBytes+=raw.length;sourceCount++;if(sourceBytes>128*1024*1024)mtIeHold("native_byte_budget");min=!min||c.capturedAt<min?c.capturedAt:min;max=c.capturedAt>max?c.capturedAt:max;
    if(kind==="searchFinancials"){
      if(c.method!=="POST"||form?.expendSearchTypeCode!=="COMMITTEE"||extractMontanaCersPageTitleMarker(raw.toString("utf8"))!=="searchResults")mtIeHold("native_search_validation_bounce");continue;
    }
    let value:unknown;try{value=JSON.parse(raw.toString("utf8"));}catch{mtIeHold("invalid_native_json");}
    if(kind==="listFinancialCommitteeResults"){
      if(c.method!=="GET"||inventory!==null)mtIeHold("ambiguous_native_inventory");
      const t=mtCommitteeTable(value);if(t.rows.length!==t.filtered||t.total!==t.filtered)mtIeHold("incomplete_native_inventory");inventory=value;
    }else if(kind==="viewFinancialEntities"){
      if(c.method!=="POST"||form?.candidateId!=="0"||!/^[1-9]\d*$/.test(form?.committeeId??""))mtIeHold("wrong_native_selection");
      active=Number(form!.committeeId);mtCommitteeInteger(active,1);if(controls.has(active))mtIeHold("duplicate_native_selection");controls.set(active,mtCommitteeInteger(mtCommitteeObject(value).resultCount));
    }else if(kind==="listViewFinancialEntityResults"){
      if(c.method!=="GET"||active===null||ledgers.has(active))mtIeHold("ambiguous_native_ledger");const t=mtCommitteeTable(value);
      if(t.rows.length!==t.filtered||t.filtered!==controls.get(active)||t.rows.some(r=>r.previousTransactionInd!=="N"))mtIeHold("incomplete_or_noncurrent_native_ledger");ledgers.set(active,value);
    }else{
      if(c.method!=="GET"||registrationSeen||canonical(value)!==canonical(expectedRegistration))mtIeHold("native_registration_mismatch");registrationSeen=true;
    }
  }
  if(!inventory||canonical(inventory)!==canonical(expectedInventory)||!registrationSeen||controls.size!==expectedTransactions.length||ledgers.size!==expectedTransactions.length||!min||!max)mtIeHold("incomplete_native_source_set");
  const seen=new Set<number>();
  for(const entry of expectedTransactions){const e=mtCommitteeObject(entry),id=mtCommitteeInteger(e.committeeId,1),native=ledgers.get(id);
    if(!native||canonical(native)!==canonical(e.list)||controls.get(id)!==e.resultCount)mtIeHold("native_cache_ledger_mismatch");
    for(const r of mtCommitteeTable(native).rows){const key=mtCommitteeInteger(r.transId,1);if(seen.has(key))mtIeHold("duplicate_current_transaction");seen.add(key);}
  }
  const sweep=parseMontanaCersIeSweepArtifact(input.sweepBody);if(sweep.committees.length!==ledgers.size)mtIeHold("native_committee_set_mismatch");
  const p=Object.freeze({year:input.year,sourceRetrievedAt:min,sourceCompletedAt:max,sourceManifestSha256:hash(manifest),sourceByteSize:sourceBytes,
    sourceOriginalCount:sourceCount,sweepSha256:input.sweepSha256,registrationSha256:input.registrationSha256});
  packets.set(p,{candidates,classified:classifyMontanaOutsideSpendingRows({sweep,registrationRows:candidates,electionYear:input.year})});return p;
}
/** Qualify saved official bytes first. Older caches without an original archive
 * cannot authorize the new component; their legacy display is preserved. */
export async function readMontanaIndependentIeSource(year:number,cacheDir=DEFAULT_MONTANA_CERS_CACHE_DIR):Promise<MontanaIndependentIePacket|null>{
  if(!Number.isSafeInteger(year)||year<2020||year>2100)mtIeHold("invalid_year");
  let sweep:Awaited<ReturnType<typeof readMontanaCersArtifact>>,registration:typeof sweep;
  try{sweep=await readMontanaCersArtifact({cacheDir,key:{type:"ie_sweep",year}});registration=await readMontanaCersArtifact({cacheDir,key:{type:"ie_registration_list",year}});}catch{return null;}
  const cache=path.resolve(cacheDir),body=mtCommitteeObject(JSON.parse(sweep.body)),directories:string[]=[];
  if(typeof body.originalArchiveDirectory==="string"){
    if(!/^http-originals\/ie-\d{4}-[a-f0-9-]{36}$/.test(body.originalArchiveDirectory))mtIeHold("invalid_archive_reference");directories.push(path.resolve(cache,body.originalArchiveDirectory));
  }else if(cache===path.resolve(DEFAULT_MONTANA_CERS_CACHE_DIR)){
    // Shared real HTTP archives saved by ordinary local acquisition also
    // qualify, after every source byte and selection control is compared.
    for(const dir of[path.join(cache,"http-originals"),path.resolve(cache,"../http-originals")]){
      let names:string[]=[];try{names=await fs.readdir(dir);}catch{}
      for(const name of names.sort().reverse().slice(0,16))if(/^(?:ie-\d{4}-[a-f0-9-]{36}|ordinary-batch-\d{4}-[\dTZ-]+)$/.test(name))directories.push(path.join(dir,name));
    }
  }
  let best:MontanaIndependentIePacket|null=null;
  for(const directory of directories)try{
    const p=await qualifyArchive({directory,year,sweepBody:sweep.body,registrationBody:registration.body,sweepSha256:sweep.manifest.sha256,registrationSha256:registration.manifest.sha256});
    if(!best||p.sourceCompletedAt>best.sourceCompletedAt)best=p;
  }catch{/* An incomplete refresh cannot advance a qualified observation. */}
  return best;
}
