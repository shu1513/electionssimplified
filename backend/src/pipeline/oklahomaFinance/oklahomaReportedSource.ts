import { lstat,mkdir,readdir,readFile,writeFile,rename } from "node:fs/promises";
import { resolve,basename } from "node:path";
import { randomUUID } from "node:crypto";
import { isOklahomaReportedRawRefreshEnabled } from "../../config/featureFlags.js";
import { okHash,okHold,okIso,okFreeze,type OklahomaReportedKind } from "./oklahomaReportedCore.js";
import { acquireOklahomaIeOriginals,acquireOklahomaReceiptOriginals,createOklahomaOriginalCapture,type OklahomaOriginalCapture } from "./oklahomaReportedAcquisition.js";
import { okDocument,okInventoryRows,okInventoryContext,okNextPage,okAmendmentRows,OK_GUARDIAN_ORIGIN as origin } from "./oklahomaReportedNative.js";
import { parseOklahomaIeReportPdf,OklahomaIeReportHold,type OklahomaIeReport } from "./oklahomaIeReportPdf.js";
import { OklahomaReportedHold } from "./oklahomaReportedCore.js";
import { readOklahomaGuardianContributionRows,type OklahomaGuardianContributionRow } from "./oklahomaGuardianContributionReader.js";
import { buildOklahomaGuardianCandidateDetailUrl,parseOklahomaGuardianCandidateDetailHtml,type OklahomaGuardianCandidateDetail } from "./oklahomaGuardianCandidateDetail.js";

export type OklahomaReportedReport={filer:string;held:boolean;report:OklahomaIeReport};
export type OklahomaReportedPacket=Readonly<{
  kind:OklahomaReportedKind;electionYear:2026;sourceAt:string;acquisitionStartedAt:string;sourceHash:string;
  windowStart:string;windowEnd:string;sourceRows:number;reportCount:number;closedReportCount:number;
  receipts:readonly OklahomaGuardianContributionRow[];reports:readonly OklahomaReportedReport[];
}>;
export type OklahomaReceiverPacket=Readonly<{packet:OklahomaReportedPacket;profile:OklahomaGuardianCandidateDetail;profileAt:string;profileStartedAt:string;profileHash:string;sourceAt:string;sourceHash:string}>;
const packets=new WeakSet<object>(),receivers=new WeakSet<object>();
export const isOklahomaReportedPacket=(v:unknown):v is OklahomaReportedPacket=>!!v&&typeof v==="object"&&packets.has(v);
export const isOklahomaReceiverPacket=(v:unknown):v is OklahomaReceiverPacket=>!!v&&typeof v==="object"&&receivers.has(v);
export const oklahomaReportedCacheRoot=(cache?:string)=>resolve(cache??process.env.OKLAHOMA_REPORTED_FINANCE_CACHE_DIR??"scratch/oklahoma-reported-finance");
const decode=(b:Uint8Array)=>new TextDecoder("utf-8",{fatal:true}).decode(b);
const compact=(s:string)=>s.normalize("NFKD").toUpperCase().replace(/[^A-Z0-9]/g,"");
async function privateBytes(path:string,max=64*1024*1024):Promise<Buffer>{const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)||s.size>max)okHold("private_original");return readFile(path);}
async function manifest(directory:string):Promise<OklahomaOriginalCapture[]>{
  const s=await lstat(directory);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077))okHold("private_original_directory");
  const records=decode(await privateBytes(resolve(directory,"manifest.ndjson"),2*1024*1024)).trim().split("\n").map(s=>JSON.parse(s)) as OklahomaOriginalCapture[];
  const ordinary=records.filter(r=>r.role!=="candidate_profile");
  if(!records.length||records.length>700||new Set(ordinary.map(r=>r.role)).size!==ordinary.length)okHold("original_manifest");
  let previous="";
  for(let i=0;i<records.length;i++){
    const r=records[i]!;if(r.file!==`${String(i+1).padStart(4,"0")}.original`||r.eof!==true||r.status!==200||!["GET","POST"].includes(r.method)||!okIso(r.startedAt)||!okIso(r.completedAt)||r.startedAt>r.completedAt||r.startedAt<previous||Date.parse(r.completedAt)>Date.now()+300000||!Number.isSafeInteger(r.bytes)||r.bytes<=0||r.bytes>32*1024*1024||!/^[a-f0-9]{64}$/.test(r.sha256)||!r.contentType)okHold("original_capture_metadata");previous=r.completedAt;
  }
  return records;
}
async function original(directory:string,r:OklahomaOriginalCapture):Promise<Buffer>{const b=await privateBytes(resolve(directory,r.file));if(b.length!==r.bytes||okHash(b)!==r.sha256)okHold("original_integrity");return b;}

/** Replay only genuine complete source graphs. A diagnostic audit file never
 * supplies authority; response membership, controls and bytes are rechecked. */
export async function readOklahomaReportedPacket(directory:string,kind:OklahomaReportedKind):Promise<OklahomaReportedPacket>{
  const records=await manifest(directory),byRole=new Map(records.map(r=>[r.role,r])),used:OklahomaOriginalCapture[]=[];
  async function one(role:string,mime="text/html"){const r=byRole.get(role);if(!r||!r.contentType?.toLowerCase().includes(mime))okHold("missing_original_role_or_mime");used.push(r);return original(directory,r);}
  let receipts:OklahomaGuardianContributionRow[]=[],reports:OklahomaReportedReport[]=[],windowEnd="2026-12-31";
  if(kind==="committee"){
    const catRole=byRole.has("download_catalog")?"download_catalog":"bulk_catalog",catalog=okDocument(decode(await one(catRole)),origin+"/PublicSite/DataDownload.aspx");
    for(const year of [2025,2026]){
      const role=`${year}_ContributionLoanExtract.csv.zip`,r=byRole.get(role);
      if(!r||!Array.from(catalog.querySelectorAll<HTMLAnchorElement>("a[href]")).some(a=>new URL(a.href).pathname.endsWith("/"+role)))okHold("receipt_catalog_membership");
      const bytes=await original(directory,r);used.push(r);if(bytes.readUInt32LE(0)!==0x04034b50)okHold("receipt_zip");
      const rows=await readOklahomaGuardianContributionRows({zipPath:resolve(directory,r.file),year});if(!rows.length)okHold("empty_receipt_export");
      for(const row of rows){if(!new RegExp(`^\\d{1,2}/\\d{1,2}/${year}(?:\\s|$)`).test(row["Receipt Date"].trim()))okHold("receipt_reporting_year");}
      for(const row of rows)receipts.push(row);
    }
    const seen=new Set<string>();for(const r of receipts){const id=r["Receipt ID"].trim();if(id&&seen.has(id))okHold("cross_file_receipt_identity");if(id)seen.add(id);}
  }else{
    const catalog=okDocument(decode(await one("report_catalog")),origin+"/PublicSite/Reports/Reports.aspx");
    const link=Array.from(catalog.querySelectorAll<HTMLAnchorElement>("a[href]")).filter(a=>/Independent Expenditures/.test(a.textContent??"")&&new URL(a.href).pathname.endsWith("/Search.aspx"));if(link.length!==1)okHold("ie_catalog");
    await one("ie_search");
    const opening:string[][]=[],closing:string[][]=[],pdfHashes=new Map<string,OklahomaReportedReport[]>();let openingPages=0;
    async function report(role:string,documentRole:string,filer:string,held:boolean){
      const raw=await one(role),matches=Array.from(decode(raw).matchAll(/data:application\/pdf;base64,([A-Za-z0-9+/=]+)/g));
      let bytes:Buffer;if(matches.length===1)bytes=Buffer.from(matches[0]![1]!,"base64");else{
        if(matches.length!==0||Array.from(decode(raw).matchAll(/window\.open\(\s*["']([^"']+)["']/g)).length!==1)okHold("report_pdf_membership");
        bytes=await one(documentRole,"application/pdf");
      }
      const parsed=await parseOklahomaIeReportPdf(bytes);if(!compact(filer)||![parsed.coverText,...parsed.coverColumns].some(s=>compact(s).includes(compact(filer))))okHold("report_filer_identity");
      const r={filer,held:held||!parsed.controlsClose,report:parsed};reports.push(r);const hash=okHash(bytes),same=pdfHashes.get(hash)??[];same.push(r);pdfHashes.set(hash,same);
    }
    for(let page=1;page<=100;page++){
      const doc=okDocument(decode(await one(page===1?"ie_search_results":`ie_inventory_page_${page}`)),link[0]!.href);
      const fields=Array.from(doc.querySelectorAll<HTMLInputElement>("input[name]")),from=fields.find(e=>e.name.includes("$DateFrom$")),through=fields.find(e=>e.name.includes("$DateThrough$"));
      const kind=Array.from(doc.querySelectorAll("select")).find(e=>e.name.includes("$DisbursementCodeHook$"));
      if(from?.value!=="01/01/2025"||!through?.value||kind?.selectedOptions[0]?.textContent?.trim()!=="Independent Expenditure")okHold("ie_search_scope");
      const end=/^(\d\d)\/(\d\d)\/(\d{4})$/.exec(through.value);if(!end)okHold("ie_search_end");const iso=`${end[3]}-${end[1]}-${end[2]}`;if(iso<"2026-01-01"||iso>new Date().toISOString().slice(0,10))okHold("ie_search_end");windowEnd=iso<"2026-12-31"?iso:"2026-12-31";
      const rows=okInventoryRows(doc),contexts=rows.map(okInventoryContext);opening.push(...contexts);openingPages=page;
      for(let index=0;index<rows.length;index++){
        const a=Array.from(rows[index]!.querySelectorAll<HTMLAnchorElement>("a[href]")).find(a=>a.textContent?.trim()==="View Report");if(!a)okHold("report_inventory_link");
        if(a.href.includes("FilingAmendmentSelect.aspx?")){
          const adoc=okDocument(decode(await one(`ie_amendment_selector_${page}_${index}`)),a.href),versions=okAmendmentRows(adoc),context=versions.map(r=>r.innerHTML);
          for(let version=0;version<versions.length;version++){
            await report(`ie_family_version_${page}_${index}_${version}`,`ie_family_document_${page}_${index}_${version}`,contexts[index]![0]!,true);
            const close=okDocument(decode(await one(`ie_family_selector_${page}_${index}_${version}`)),a.href);if(JSON.stringify(okAmendmentRows(close).map(r=>r.innerHTML))!==JSON.stringify(context))okHold("amendment_inventory_changed");
          }
        }else{
          const role=`ie_current_report_${page}_${index}`;await report(role,`ie_current_report_document_${page}_${index}`,contexts[index]![0]!,false);
          const originalDoc=okDocument(decode(await original(directory,byRole.get(role)!)),link[0]!.href);if(JSON.stringify(okInventoryRows(originalDoc).map(okInventoryContext))!==JSON.stringify(contexts))okHold("report_inventory_context");
        }
      }
      const next=okNextPage(doc,page);if(!next)break;if(page===100)okHold("ie_page_limit");
    }
    for(let page=1;page<=openingPages;page++){
      const doc=okDocument(decode(await one(`ie_closing_inventory_${page}`)),link[0]!.href);closing.push(...okInventoryRows(doc).map(okInventoryContext));
      if(!!okNextPage(doc,page)!==(page<openingPages))okHold("closing_page_count");
    }
    if(JSON.stringify(opening)!==JSON.stringify(closing))okHold("closing_inventory_changed");
    for(const repeated of pdfHashes.values())if(repeated.length>1)for(const r of repeated)r.held=true;
  }
  if(!used.length)okHold("empty_source_graph");
  const packet:OklahomaReportedPacket={kind,electionYear:2026,sourceAt:used.map(r=>r.completedAt).sort()[0]!,acquisitionStartedAt:used.map(r=>r.startedAt).sort()[0]!,sourceHash:okHash(used.map(r=>r.sha256).join("\n")),windowStart:"2025-01-01",windowEnd,sourceRows:kind==="committee"?receipts.length:reports.reduce((n,r)=>n+r.report.rows.length,0),reportCount:reports.length,closedReportCount:reports.filter(r=>r.report.controlsClose).length,receipts,reports};
  okFreeze(packet);packets.add(packet);return packet;
}

async function publishLatest(cache:string,kind:string,directory:string){const file=resolve(cache,`${kind}.latest.${randomUUID()}.tmp`);await writeFile(file,basename(directory)+"\n",{mode:0o600,flag:"wx"});await rename(file,resolve(cache,`${kind}.latest`));}
export async function loadOklahomaReportedPacket(kind:OklahomaReportedKind,options:{cacheDir?:string;refresh?:boolean;onRefreshError?:(code:string)=>void}={}):Promise<OklahomaReportedPacket|null>{
  const cache=oklahomaReportedCacheRoot(options.cacheDir);await mkdir(cache,{recursive:true,mode:0o700});let saved:OklahomaReportedPacket|null=null;
  try{const name=(await privateBytes(resolve(cache,`${kind}.latest`),100)).toString().trim();if(!/^source-originals-[0-9a-f-]{36}$/.test(name))okHold("latest_pointer");saved=await readOklahomaReportedPacket(resolve(cache,name),kind);}catch{/* Failed/partial originals do not confer authority. */}
  if(!saved){
    const names=(await readdir(cache)).filter(n=>/^source-originals-[0-9a-f-]{36}$/.test(n));
    const candidates=await Promise.all(names.map(async n=>({n,mtime:(await lstat(resolve(cache,n))).mtimeMs})));candidates.sort((a,b)=>b.mtime-a.mtime);
    for(const {n} of candidates.slice(0,50)){try{saved=await readOklahomaReportedPacket(resolve(cache,n),kind);await publishLatest(cache,kind,resolve(cache,n));break;}catch{/* try the last complete native graph */}}
  }
  const stale=!saved||Date.now()-Date.parse(saved.sourceAt)>7*86400000;
  if((options.refresh||stale)&&isOklahomaReportedRawRefreshEnabled()){
    try{const dir=await(kind==="committee"?acquireOklahomaReceiptOriginals(cache):acquireOklahomaIeOriginals(cache)),fresh=await readOklahomaReportedPacket(dir,kind);await publishLatest(cache,kind,dir);return fresh;}catch(e){options.onRefreshError?.(e instanceof OklahomaReportedHold||e instanceof OklahomaIeReportHold?e.code:"source_unavailable");}
  }
  return saved;
}

export async function loadOklahomaReceiverPacket(packet:OklahomaReportedPacket,organizationId:string,options:{cacheDir?:string;refresh?:boolean}={}):Promise<OklahomaReceiverPacket>{
  if(!isOklahomaReportedPacket(packet)||!/^\d+$/.test(organizationId))okHold("unverified_source");
  const cache=oklahomaReportedCacheRoot(options.cacheDir);let profile:OklahomaGuardianCandidateDetail|null=null,at="",startedAt="",hash="";
  for(const n of await readdir(cache)){
    if(!/^profile-originals-[0-9a-f-]{36}$/.test(n))continue;const dir=resolve(cache,n);
    try{for(const r of await manifest(dir)){if(r.role!=="candidate_profile"&&!r.role.startsWith("candidate_profile_"))continue;const b=await original(dir,r);if(!r.contentType?.includes("text/html"))continue;
      try{const p=parseOklahomaGuardianCandidateDetailHtml({html:decode(b),organizationId});if(r.completedAt>at){profile=p;at=r.completedAt;startedAt=r.startedAt;hash=r.sha256;}}catch{/* a different native profile */}
    }}catch{/* incomplete capture */}
  }
  if((options.refresh||!profile||Date.now()-Date.parse(at)>7*86400000)&&isOklahomaReportedRawRefreshEnabled()){
    try{const {capture}=await createOklahomaOriginalCapture(cache,"profile-originals-"),r=await capture("candidate_profile",buildOklahomaGuardianCandidateDetailUrl(organizationId));profile=parseOklahomaGuardianCandidateDetailHtml({html:r.html(),organizationId});at=r.meta.completedAt;startedAt=r.meta.startedAt;hash=okHash(r.bytes);}catch{/* retain genuine last qualified profile */}
  }
  if(!profile)okHold("native_receiving_profile_unavailable");
  const value:OklahomaReceiverPacket={packet,profile,profileAt:at,profileStartedAt:startedAt,profileHash:hash,sourceAt:packet.sourceAt,sourceHash:okHash(packet.sourceHash+hash)};okFreeze(value);receivers.add(value);return value;
}
