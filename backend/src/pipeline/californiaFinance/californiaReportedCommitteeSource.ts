import fs from "node:fs/promises";
import {createReadStream} from "node:fs";
import {createHash} from "node:crypto";
import {scanCalAccessCompleteTable} from "./calAccessCompleteTableScan.js";
import {CAL_ACCESS_RAW_DATA_ZIP_URL,DEFAULT_CAL_ACCESS_RAW_DATA_CACHE_DIR,getCalAccessRawDataArtifactCachePaths,readCalAccessRawDataArtifactCacheMetadata} from "./calAccessRawDataArtifactCache.js";

type Row=Record<string,string>;
export class CaliforniaCommitteeError extends Error{constructor(readonly code:string){super(`California committee receipts unavailable: ${code}`);}}
export function caCommitteeHold(code:string):never{throw new CaliforniaCommitteeError(code);}
export const caCommitteeCanonical=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==="object"&&!Array.isArray(x)&&!(x instanceof Date)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
export function caCommitteeInteger(v:unknown,min=0){const n=typeof v==="number"?v:typeof v==="string"&&/^-?\d+$/.test(v)?Number(v):NaN;if(!Number.isSafeInteger(n)||n<min)caCommitteeHold("invalid_integer");return n;}
export function caCommitteeCents(s:string){if(!/^-?\d+(?:\.\d{1,2})?$/.test(s))caCommitteeHold("invalid_money");const [a,b=""]=s.split("."),n=BigInt(a!)*100n+(s.startsWith("-")?-1n:1n)*BigInt(b.padEnd(2,"0"));return caCommitteeInteger(Number(n),Number.MIN_SAFE_INTEGER);}
export function caCommitteeDate(s:string){const m=/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T].*)?$/.exec(s),i=/^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/.exec(s);if(!m&&!i)caCommitteeHold("invalid_native_date");const y=Number(m?.[3]??i?.[1]),month=Number(m?.[1]??i?.[2]),d=Number(m?.[2]??i?.[3]),date=new Date(Date.UTC(y,month-1,d));if(date.getUTCFullYear()!==y||date.getUTCMonth()!==month-1||date.getUTCDate()!==d)caCommitteeHold("invalid_native_date");return date.toISOString().slice(0,10);}
const sum=(ns:number[])=>caCommitteeInteger(Number(ns.reduce((a,b)=>a+BigInt(b),0n)),Number.MIN_SAFE_INTEGER),hash=(s:string)=>createHash("sha256").update(s).digest("hex");
export type CaliforniaCommitteeGroup={key:string;name:string;entityCode:string;nativeCommitteeId:string|null;cents:number;positiveCents:number;negativeCents:number;giftCount:number;correctionCount:number};
export type CaliforniaCommitteeAggregation={totalCents:number;positiveCents:number;negativeCents:number;selectedRows:number;receivingRows:number;canceledGroupCount:number;canceledRowCount:number;groups:CaliforniaCommitteeGroup[]};
export type CaliforniaCommitteePacket=Readonly<{sourceRetrievedAt:string;sourceCompletedAt:string;sourceSha256:string;sourceByteSize:number}>;
type Data={covers:Row[];receipts:Row[];summaries:Row[];tableControls:Record<string,unknown>};const packets=new WeakMap<CaliforniaCommitteePacket,Data>();
const data=(p:CaliforniaCommitteePacket)=>{const d=packets.get(p);if(!d)caCommitteeHold("unverified_source_packet");return d;};
export function assertCaliforniaCommitteePacket(p:CaliforniaCommitteePacket){data(p);}
export function californiaCommitteeReports(p:CaliforniaCommitteePacket,committeeId:string,year:number){
  caCommitteeInteger(year,2001);const rows=data(p).covers.filter(r=>r.FILER_ID===committeeId&&r.FORM_TYPE==="F460"),byId=new Map<string,Row>();
  for(const r of rows){if(!/^[1-9]\d*$/.test(r.FILING_ID!))caCommitteeHold("invalid_report_id");const n=caCommitteeInteger(r.AMEND_ID),old=byId.get(r.FILING_ID!);if(!old||n>caCommitteeInteger(old.AMEND_ID))byId.set(r.FILING_ID!,r);}
  for(const r of byId.values())if(rows.filter(x=>x.FILING_ID===r.FILING_ID&&x.AMEND_ID===r.AMEND_ID).length!==1)caCommitteeHold("duplicate_current_cover");
  const selected=[...byId.values()].filter(r=>caCommitteeDate(r.THRU_DATE!)>=`${year-1}-01-01`&&caCommitteeDate(r.FROM_DATE!)<=`${year}-12-31`).sort((a,b)=>caCommitteeDate(a.FROM_DATE!).localeCompare(caCommitteeDate(b.FROM_DATE!)));
  if(!selected.length)caCommitteeHold("missing_current_reports");let prior="";
  for(const r of selected){const from=caCommitteeDate(r.FROM_DATE!),through=caCommitteeDate(r.THRU_DATE!);if(from>through||prior&&from<=prior)caCommitteeHold("overlapping_report_periods");if(through>p.sourceRetrievedAt.slice(0,10))caCommitteeHold("future_report_period");prior=through;if(r.CONTROL_YN!=="Y")caCommitteeHold("uncontrolled_receiving_account");}
  return structuredClone(selected);
}
export function californiaCommitteeComponent(p:CaliforniaCommitteePacket,committeeId:string,year:number){
  const d=data(p),reports=californiaCommitteeReports(p,committeeId,year),groups=new Map<string,CaliforniaCommitteeGroup>();let receivingRows=0,selectedRows=0;
  for(const cover of reports){const id=cover.FILING_ID!,amendment=cover.AMEND_ID!,rows=d.receipts.filter(r=>r.FILING_ID===id&&r.AMEND_ID===amendment),seen=new Set<string>(),totals={A:0,C:0};
    for(const r of rows){const key=caCommitteeCanonical([r.LINE_ITEM,r.REC_TYPE,r.FORM_TYPE]);if(seen.has(key)||r.REC_TYPE!=="RCPT")caCommitteeHold("duplicate_or_invalid_receipt");seen.add(key);
      if(!["A","C"].includes(r.FORM_TYPE!))continue;receivingRows++;if(!["","X"].includes(r.MEMO_CODE??""))caCommitteeHold("unknown_memo_code");if(r.MEMO_CODE==="X"||r.BAKREF_TID)continue;
      const cents=caCommitteeCents(r.AMOUNT!),form=r.FORM_TYPE as "A"|"C";totals[form]=sum([totals[form],cents]);
      if(!["COM","RCP","PTY","SCC"].includes(r.ENTITY_CD!))continue;
      if(!["","I","R","X","F","T"].includes(r.TRAN_TYPE??""))caCommitteeHold("unknown_committee_transaction_type");
      if(["X","F","T"].includes(r.TRAN_TYPE! )||r.CMTE_ID===committeeId)continue;
      const date=caCommitteeDate(r.RCPT_DATE!);if(date<caCommitteeDate(cover.FROM_DATE!)||date>caCommitteeDate(cover.THRU_DATE!))caCommitteeHold("receipt_outside_report_period");if(date<`${year-1}-01-01`||date>`${year}-12-31`||cents===0)continue;
      const name=[r.CTRIB_NAMF,r.CTRIB_NAML].filter(Boolean).join(" ").trim();if(!name)caCommitteeHold("missing_committee_name");
      const native=r.CMTE_ID?.trim()||null;if(native&&native.length>100)caCommitteeHold("invalid_donor_committee_id");
      const groupKey=hash(caCommitteeCanonical([r.ENTITY_CD,r.CMTE_ID,r.CTRIB_NAML,r.CTRIB_NAMF,r.CTRIB_NAMT,r.CTRIB_NAMS,r.CTRIB_CITY,r.CTRIB_ST,r.CTRIB_ZIP4]));
      const g=groups.get(groupKey)??{key:groupKey,name,entityCode:r.ENTITY_CD!,nativeCommitteeId:native,cents:0,positiveCents:0,negativeCents:0,giftCount:0,correctionCount:0};g.cents=sum([g.cents,cents]);if(cents>0){g.positiveCents=sum([g.positiveCents,cents]);g.giftCount++;}else{g.negativeCents=sum([g.negativeCents,cents]);g.correctionCount++;}groups.set(groupKey,g);selectedRows++;
    }
    for(const form of["A","C"] as const){const controls=d.summaries.filter(r=>r.FILING_ID===id&&r.AMEND_ID===amendment&&r.FORM_TYPE===form&&r.LINE_ITEM==="1");if(controls.length>1)caCommitteeHold("duplicate_schedule_control");const control=controls[0]?.AMOUNT_A?.trim();if(totals[form]!==(!control?0:caCommitteeCents(control)))caCommitteeHold("itemized_schedule_does_not_close");}
  }
  const all=[...groups.values()];if(all.some(g=>g.cents<0))caCommitteeHold("negative_committee_balance");const positive=all.filter(g=>g.cents>0).sort((a,b)=>b.cents-a.cents||a.key.localeCompare(b.key)),canceled=all.filter(g=>g.cents===0);
  return {totalCents:sum(all.map(g=>g.cents)),positiveCents:sum(all.map(g=>g.positiveCents)),negativeCents:sum(all.map(g=>g.negativeCents)),selectedRows,receivingRows,
    canceledGroupCount:canceled.length,canceledRowCount:canceled.reduce((n,g)=>n+g.giftCount+g.correctionCount,0),groups:positive} satisfies CaliforniaCommitteeAggregation;
}
export function californiaCommitteeFacts(p:CaliforniaCommitteePacket,committeeId:string,year:number){
  const keys=["FILING_ID","AMEND_ID","FORM_TYPE","FILER_ID","FILER_NAML","CONTROL_YN","CMTTE_TYPE","FROM_DATE","THRU_DATE","ELECT_DATE","CAND_NAML","CAND_NAMF","CAND_NAMT","CAND_NAMS","OFFICE_CD","OFFIC_DSCR","JURIS_CD","DIST_NO"];
  const tableControls=Object.fromEntries(Object.entries(data(p).tableControls).map(([name,value])=>{const t=value as {bytes:number;rows:number;sha256:string};return [name,{bytes:t.bytes,rows:t.rows,sha256:t.sha256}];}));
  return {reports:californiaCommitteeReports(p,committeeId,year).map(r=>Object.fromEntries(keys.map(k=>[k,r[k]??""]))),tableControls};
}
/** Source data can only enter through the complete actual saved ZIP. */
export async function readCaliforniaCommitteePacket(committeeIds:readonly string[],cacheDir=process.env.CAL_ACCESS_RAW_DATA_CACHE_DIR?.trim()||DEFAULT_CAL_ACCESS_RAW_DATA_CACHE_DIR):Promise<CaliforniaCommitteePacket>{
  const ids=new Set(committeeIds);if(!ids.size||ids.size>1000||[...ids].some(id=>!/^[1-9]\d*$/.test(id)))caCommitteeHold("invalid_source_scope");
  const paths=getCalAccessRawDataArtifactCachePaths(cacheDir),metadata=await readCalAccessRawDataArtifactCacheMetadata(paths.metadataPath),before=await fs.lstat(paths.zipPath);
  if(!metadata||metadata.remote.url!==CAL_ACCESS_RAW_DATA_ZIP_URL||!before.isFile()||metadata.bytesWritten!==before.size||metadata.remote.contentLength!==before.size||before.size>3*1024**3||!Number.isFinite(Date.parse(metadata.downloadedAt))||new Date(metadata.downloadedAt).toISOString()!==metadata.downloadedAt||Date.parse(metadata.downloadedAt)>Date.now())caCommitteeHold("invalid_saved_source");
  const sha=createHash("sha256");for await(const b of createReadStream(paths.zipPath))sha.update(b);const sourceSha256=sha.digest("hex"),covers:Row[]=[],receipts:Row[]=[],summaries:Row[]=[],tableControls:Record<string,unknown>={};
  const first=await scanCalAccessCompleteTable({zipPath:paths.zipPath,fileName:"CalAccess/DATA/CVR_CAMPAIGN_DISCLOSURE_CD.TSV",columnValues:{column:"FILER_ID",values:ids},onRow:r=>{if(r.FORM_TYPE==="F460")covers.push(r);if(covers.length>100000)caCommitteeHold("source_report_budget");}});
  const wanted=new Set(covers.map(r=>r.FILING_ID!));covers.length=0;
  tableControls.covers=await scanCalAccessCompleteTable({zipPath:paths.zipPath,fileName:"CalAccess/DATA/CVR_CAMPAIGN_DISCLOSURE_CD.TSV",firstColumnValues:wanted,onRow:r=>{if(!ids.has(r.FILER_ID!))caCommitteeHold("changed_report_owner");covers.push(r);}});
  if(caCommitteeCanonical(tableControls.covers)!==caCommitteeCanonical(first)){
    const second=tableControls.covers as typeof first;if(second.sha256!==first.sha256||second.bytes!==first.bytes||second.rows!==first.rows)caCommitteeHold("source_changed_during_scan");
  }
  const packet=Object.freeze({sourceRetrievedAt:metadata.downloadedAt,sourceCompletedAt:metadata.downloadedAt,sourceSha256,sourceByteSize:before.size});packets.set(packet,{covers,receipts,summaries,tableControls});
  // Select complete report versions in memory; a receiver's semantic hold must
  // not suppress other receivers in the ordinary batch.
  const filingIds=new Set<string>();for(const id of ids){const max=new Map<string,Row>();for(const r of covers.filter(c=>c.FILER_ID===id)){const old=max.get(r.FILING_ID!);if(!old||caCommitteeInteger(r.AMEND_ID)>caCommitteeInteger(old.AMEND_ID))max.set(r.FILING_ID!,r);}for(const r of max.values())filingIds.add(r.FILING_ID!);}
  tableControls.receipts=await scanCalAccessCompleteTable({zipPath:paths.zipPath,fileName:"CalAccess/DATA/RCPT_CD.TSV",firstColumnValues:filingIds,onRow:r=>{receipts.push(r);if(receipts.length>3000000)caCommitteeHold("source_receipt_budget");}});
  tableControls.summaries=await scanCalAccessCompleteTable({zipPath:paths.zipPath,fileName:"CalAccess/DATA/SMRY_CD.TSV",firstColumnValues:filingIds,onRow:r=>{summaries.push(r);if(summaries.length>1000000)caCommitteeHold("source_summary_budget");}});
  const after=await fs.lstat(paths.zipPath),closing=await readCalAccessRawDataArtifactCacheMetadata(paths.metadataPath);
  if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||caCommitteeCanonical(metadata)!==caCommitteeCanonical(closing))caCommitteeHold("source_changed_during_scan");
  return packet;
}
