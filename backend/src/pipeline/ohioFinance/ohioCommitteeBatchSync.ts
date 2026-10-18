import type { Pool } from "pg";
import { isOhioReportedCommitteeReceiptsEnabled, isOhioSosRawDataRefreshEnabled } from "../../config/featureFlags.js";
import { OhioCommitteeReceiptError, ohioCommitteeHold } from "./ohioCommitteeReceipts.js";
import { captureOhioCommitteeSource, ohioCommitteeCanonical, readOhioCommitteeNativeHint, readOhioCommitteeSource, readOhioCommitteeSourceHint,
  type OhioCommitteeSourcePacket } from "./ohioCommitteeSource.js";
import { OH_COMMITTEE_CONTEXT_FROM, OH_COMMITTEE_CONTEXT_SELECT, OH_COMMITTEE_CONTEXT_WHERE, loadOhioCommitteeReceiver, type OhioCommitteeReceiver } from "./ohioCommitteeReceiver.js";
import { OHIO_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./ohioFinanceEligibleOffices.js";
import { writeOhioCommitteeReceipts } from "./ohioCommitteeWriter.js";

export type OhioCommitteeBatchOptions = {db:Pool;now?:Date;maxCandidates?:number;staleAfterDays?:number;
  electionLookbackDays?:number;electionLookaheadDays?:number;refresh?:boolean;dryRun?:boolean;cacheDir?:string};
type Meta={source_clock:string|null;source_manifest:string|null;source_native:string|null;source_committee:string|null;
  source_candidate:string|null;source_election:string|null;last_attempted_at:string|null;attempt_committee:string|null;
  attempt_candidate:string|null;attempt_election:string|null;attempt_revision:string|null};
const DAY=86400000,clock=(s:string|null)=>s?Date.parse(s):NaN;
const integer=(n:number,min:number,max=100000)=>{if(!Number.isSafeInteger(n)||n<min||n>max)ohioCommitteeHold("invalid_batch_option");return n;};
async function revision(year:number,cacheDir?:string){
  let saved=null;try{saved=await readOhioCommitteeSourceHint({cycleYear:year,cacheDir});}catch(e){if(!(e instanceof OhioCommitteeReceiptError))throw e;}
  const native=isOhioSosRawDataRefreshEnabled()?await readOhioCommitteeNativeHint(year):null;
  return {manifest:saved?.manifestSha256??null,native:native??saved?.nativeFingerprint??null,
    revision:`${saved?.manifestSha256??"none"}:${native??saved?.nativeFingerprint??"none"}`};
}
/** Own missing/source-clock schedule and durable hold rotation. No legacy join. */
export async function listDueOhioCommitteeReceipts(options:OhioCommitteeBatchOptions){
  const now=options.now??new Date();if(!Number.isFinite(now.getTime()))ohioCommitteeHold("invalid_batch_clock");
  const max=integer(options.maxCandidates??25,1),stale=integer(options.staleAfterDays??7,1),
    back=integer(options.electionLookbackDays??98,0),ahead=integer(options.electionLookaheadDays??730,0);
  const result=await options.db.query<OhioCommitteeReceiver&Meta>(`SELECT ${OH_COMMITTEE_CONTEXT_SELECT},
    s.source_retrieved_at::text source_clock,s.source_manifest_sha256 source_manifest,s.source_facts->>'nativeFingerprint' source_native,
    s.receiving_committee_id source_committee,s.candidate_id::text source_candidate,s.election_id::text source_election,
    a.last_attempted_at::text,a.receiving_committee_id attempt_committee,a.candidate_id::text attempt_candidate,a.election_id::text attempt_election,a.source_revision attempt_revision
    ${OH_COMMITTEE_CONTEXT_FROM}
    LEFT JOIN public.oh_reported_committee_sources s ON s.link_id=l.id AND s.election_year=l.election_year
    LEFT JOIN public.oh_reported_committee_attempts a ON a.link_id=l.id AND a.election_year=l.election_year
    WHERE ${OH_COMMITTEE_CONTEXT_WHERE}
      AND e.election_date >= (($2::timestamptz AT TIME ZONE 'UTC')::date-make_interval(days=>$3::int))
      AND e.election_date <= (($2::timestamptz AT TIME ZONE 'UTC')::date+make_interval(days=>$4::int))
    ORDER BY a.last_attempted_at ASC NULLS FIRST,e.election_date,l.candidate_name_normalized,l.id LIMIT 100001`,
  [[...OHIO_FINANCE_ELIGIBLE_OFFICE_KEYS],now.toISOString(),back,ahead]);
  if(result.rows.length>100000||new Set(result.rows.map(r=>r.link_id)).size!==result.rows.length)ohioCommitteeHold("incomplete_eligible_scope");
  const hints=new Map<number,Awaited<ReturnType<typeof revision>>>(),rows:OhioCommitteeReceiver[]=[];
  for(const row of result.rows){
    if(!hints.has(row.election_year))hints.set(row.election_year,await revision(row.election_year,options.cacheDir));
    const h=hints.get(row.election_year)!,at=clock(row.source_clock),attempted=clock(row.last_attempted_at),time=now.getTime();
    const needs=options.refresh===true||row.source_committee!==row.committee_id||row.source_candidate!==row.candidate_id||row.source_election!==row.election_id||
      !Number.isFinite(at)||at>time||at<time-stale*DAY||!!h.manifest&&row.source_manifest!==h.manifest||!!h.native&&row.source_native!==h.native;
    const retry=options.refresh===true||!Number.isFinite(attempted)||attempted>time||attempted<=time-DAY||row.attempt_committee!==row.committee_id||
      row.attempt_candidate!==row.candidate_id||row.attempt_election!==row.election_id||row.attempt_revision!==h.revision;
    if(needs&&retry){
      const {source_clock:_sc,source_manifest:_sm,source_native:_sn,source_committee:_so,source_candidate:_sca,source_election:_se,
        last_attempted_at:_la,attempt_committee:_ao,attempt_candidate:_aca,attempt_election:_ae,attempt_revision:_ar,...receiver}=row;
      rows.push(receiver);
    }
  }
  return {eligibleCount:result.rows.length,totalDueRows:rows.length,rows:rows.slice(0,max)};
}
async function attempt(db:Pool,expected:OhioCommitteeReceiver,sourceRevision:string){
  const c=await db.connect();try{
    await c.query("BEGIN");const current=await loadOhioCommitteeReceiver(c,expected.link_id,true);
    if(!current||ohioCommitteeCanonical(current)!==ohioCommitteeCanonical(expected))ohioCommitteeHold("receiving_context_changed");
    await c.query(`INSERT INTO public.oh_reported_committee_attempts
      (link_id,election_year,receiving_committee_id,candidate_id,election_id,source_revision,last_attempted_at)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(link_id,election_year) DO UPDATE SET receiving_committee_id=EXCLUDED.receiving_committee_id,
      candidate_id=EXCLUDED.candidate_id,election_id=EXCLUDED.election_id,source_revision=EXCLUDED.source_revision,last_attempted_at=EXCLUDED.last_attempted_at`,
    [current.link_id,current.election_year,current.committee_id,current.candidate_id,current.election_id,sourceRevision,new Date().toISOString()]);
    await c.query("COMMIT");
  }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
}
export async function syncDueOhioCommitteeReceipts(options:OhioCommitteeBatchOptions){
  const result={enabled:isOhioReportedCommitteeReceiptsEnabled(),dryRun:options.dryRun===true,eligibleCount:0,totalDueRows:0,
    attemptedCount:0,writtenCount:0,heldCount:0,savedSourceCount:0,capturedSourceCount:0,sourceRefreshFailures:0,holds:{} as Record<string,number>};
  if(!result.enabled)return result;
  const due=await listDueOhioCommitteeReceipts(options);result.eligibleCount=due.eligibleCount;result.totalDueRows=due.totalDueRows;
  if(result.dryRun)return result;
  const sources=new Map<number,Promise<OhioCommitteeSourcePacket|null>>();
  const source=(year:number)=>{
    if(!sources.has(year))sources.set(year,(async()=>{
      // capture() itself replays an unchanged saved generation exactly once.
      // Do not parse both annual ledgers a second time before calling it.
      if(isOhioSosRawDataRefreshEnabled())try{
        const before=await revision(year,options.cacheDir);
        const next=await captureOhioCommitteeSource({cycleYear:year,cacheDir:options.cacheDir});
        if(next.sourceManifestSha256!==before.manifest)result.capturedSourceCount++;else result.savedSourceCount++;
        return next;
      }catch{result.sourceRefreshFailures++;/* Prior qualified pointer stays intact; dates are not advanced. */}
      const saved=await readOhioCommitteeSource({cycleYear:year,cacheDir:options.cacheDir});
      if(saved)result.savedSourceCount++;return saved;
    })());return sources.get(year)!;
  };
  for(const receiver of due.rows){
    result.attemptedCount++;let rev=(await revision(receiver.election_year,options.cacheDir)).revision;
    try{
      await attempt(options.db,receiver,rev);const p=await source(receiver.election_year);if(!p)ohioCommitteeHold("source_unavailable");
      rev=(await revision(receiver.election_year,options.cacheDir)).revision;
      await writeOhioCommitteeReceipts({db:options.db,receiver,source:p});result.writtenCount++;
    }catch(e){result.heldCount++;const code=e instanceof OhioCommitteeReceiptError?e.code:"storage_unavailable";result.holds[code]=(result.holds[code]??0)+1;}
    finally{try{await attempt(options.db,receiver,rev);}catch{/* Canonical changes also prevent nonfinancial attempt writes. */}}
  }
  return result;
}
