import {createHash} from "node:crypto";
import {lstat,readFile} from "node:fs/promises";
import {dirname,resolve} from "node:path";
import {
  buildMarylandPublicReportInventoryRequest,buildMarylandPublishedReportPdfRequest,
  decodeMarylandPublishedReport,decodeMarylandPublicReportInventory,type MarylandPublishedReport,
} from "./marylandPublicReportClient.js";

const fail=():never=>{throw new Error("invalid_maryland_saved_report_document");};
const object=(v:unknown):v is Record<string,unknown>=>Boolean(v)&&typeof v==="object"&&!Array.isArray(v);
const sha=(b:Uint8Array)=>createHash("sha256").update(b).digest("hex");
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>0;
const same=(a:unknown,b:unknown):boolean=>{
  if(object(a)&&object(b))return Object.keys(a).length===Object.keys(b).length&&Object.entries(a).every(([k,v])=>Object.hasOwn(b,k)&&same(v,b[k]));
  if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((v,i)=>same(v,b[i]));
  return a===b;
};
// Retain the original timestamp and compare all observed microseconds. Replays
// must not rewrite Python six-digit captures into JavaScript milliseconds.
function instant(value:unknown):bigint {
  if(typeof value!=="string")return fail();
  const m=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)$/.exec(value);
  if(!m||m[1]!.startsWith("0000"))return fail();
  const milliseconds=Date.parse(`${m[1]}Z`);
  if(!Number.isFinite(milliseconds)||new Date(milliseconds).toISOString().slice(0,19)!==m[1])return fail();
  return BigInt(milliseconds)*1000n+BigInt((m[2]??"").padEnd(6,"0"));
}
async function privateFile(path:string,maximum:number) {
  if(typeof path!=="string"||resolve(path)!==path)return fail();
  const parent=await lstat(dirname(path)),info=await lstat(path);
  if(!parent.isDirectory()||parent.isSymbolicLink()||(parent.mode&0o777)!==0o700||
    !info.isFile()||info.isSymbolicLink()||(info.mode&0o777)!==0o600||info.size<1||info.size>maximum)return fail();
  const bytes=await readFile(path);
  if(bytes.length!==info.size)return fail();
  return bytes;
}

/** Reopens a genuine original and its retained capture journal, never a text
 * derivative or caller's success flag. Both historical journal shapes remain
 * explicit; neither is rewritten or assigned a new source observation time.
 * Current inventory, complete report coverage and financial acceptance belong
 * to the ordinary packet loader. Private bytes/metadata stay transient. */
export async function readMarylandSavedReportDocument(input:{
  report:MarylandPublishedReport;originalPath:string;captureJournalPath:string;
}) {
  try {
    const retained=structuredClone(input);
    const request=buildMarylandPublicReportInventoryRequest({filerRegistrationGuid:retained.report.filerRegistrationGuid,
      electionCycleId:String(retained.report.reportingCycleId),pageNumber:1});
    const report=decodeMarylandPublishedReport(retained.report,request),expected=buildMarylandPublishedReportPdfRequest(report);
    const journal:unknown=JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(await privateFile(retained.captureJournalPath,2*1024*1024)));
    const entries=Array.isArray(journal)?journal:[journal];
    if(!entries.length||entries.length>1000||entries.some(e=>!object(e)))return fail();
    const matches=entries.filter(e=>e.outputPath===retained.originalPath||e.rawPath===retained.originalPath);
    if(matches.length!==1)return fail();
    const capture=matches[0]!;
    const current=Object.hasOwn(capture,"outputPath");
    if(current?Object.hasOwn(capture,"rawPath"):Object.hasOwn(capture,"outputPath"))return fail();
    if(capture.url!=="https://api-campaignfinance.maryland.gov/api/PublicFiledReportAndDownload/DownloadDocument"||capture.method!=="POST"||
      (current?capture.httpStatus:capture.status)!==200||(current?capture.bodyComplete:capture.eof)!==true||
      (current?capture.errorCode:capture.error)!==null||!same(current?capture.requestBody:capture.requestFields,expected)||
      !positive(capture.byteCount)||capture.byteCount>64*1024*1024||typeof capture.sha256!=="string"||!/^[a-f0-9]{64}$/.test(capture.sha256)||
      instant(capture.completedAt)<instant(capture.startedAt))return fail();
    if(current) {
      const keys=["dueDate","endDate","filedDate","filerRegistrationGuid","reportGuid","reportName","reportVersionId","startDate"];
      const parent=capture.sourceParent;
      if(!object(parent)||Object.keys(parent).length!==keys.length||
        keys.some(k=>parent[k]!==report[k as keyof MarylandPublishedReport]))return fail();
    } else {
      // This older download captured its complete source inventory separately.
      // Reopen that original; the filename alone is never a report association.
      if(typeof capture.sourceInventoryPath!=="string"||typeof capture.sourceInventorySha256!=="string")return fail();
      const inventory=await privateFile(capture.sourceInventoryPath,4*1024*1024);
      if(sha(inventory)!==capture.sourceInventorySha256)return fail();
      const published=decodeMarylandPublicReportInventory(JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(inventory)),request);
      const parents=published.reports.filter(r=>r.reportGuid.toLowerCase()===report.reportGuid.toLowerCase());
      if(parents.length!==1||!same(parents[0],report))return fail();
    }
    const bytes=await privateFile(retained.originalPath,64*1024*1024);
    if(bytes.length!==capture.byteCount||sha(bytes)!==capture.sha256||bytes.subarray(0,5).toString("ascii")!=="%PDF-"||
      !/%%EOF\s*$/.test(bytes.subarray(-1024).toString("latin1")))return fail();
    return Object.freeze({privateBytes:bytes,privateReport:report,sourceFacts:Object.freeze({
      byteCount:bytes.length,sha256:capture.sha256,startedAt:capture.startedAt as string,completedAt:capture.completedAt as string,
    })});
  } catch {return fail();}
}
