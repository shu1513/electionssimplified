import type {Pool,PoolClient} from "pg";
import {isMontanaReportedIeEnabled,isMontanaCampaignFinanceRawDataRefreshEnabled} from "../../config/featureFlags.js";
import {MT_COMMITTEE_SELECT,MT_COMMITTEE_FROM,MT_COMMITTEE_WHERE,loadMontanaCommitteeReceiver,type MontanaCommitteeReceiver} from "./montanaReportedCommitteeReceiver.js";
import {MONTANA_FINANCE_ELIGIBLE_OFFICE_KEYS} from "./montanaFinanceEligibleOffices.js";
import {mtCommitteeCanonical as canonical,MontanaReportedCommitteeError} from "./montanaReportedCommitteeSource.js";
import {readMontanaIndependentIeSource,MontanaIndependentIeError,mtIeHold as hold,type MontanaIndependentIePacket} from "./montanaIndependentIeSource.js";
import {acquireMontanaCersOutsideSpendingArtifacts} from "./montanaOutsideSpendingAcquisition.js";
import {writeMontanaIndependentIe} from "./montanaIndependentIeWriter.js";

type Db=Pick<Pool,"query">&{connect:()=>Promise<PoolClient>};
export type MontanaIndependentIeOptions={db:Db;now?:Date;maxCandidates?:number;staleAfterDays?:number;electionLookbackDays?:number;electionLookaheadDays?:number;dryRun?:boolean;cacheDir?:string};
const DAY=86400000,REVISION="mt-reported-ie-v1",integer=(n:number,min=1)=>{if(!Number.isSafeInteger(n)||n<min||n>100000)hold("invalid_batch_option");return n;};
export async function listDueMontanaIndependentIe(o:MontanaIndependentIeOptions){
  const now=o.now??new Date();if(!Number.isFinite(now.getTime()))hold("invalid_batch_clock");const max=integer(o.maxCandidates??10),stale=integer(o.staleAfterDays??7),back=integer(o.electionLookbackDays??98,0),ahead=integer(o.electionLookaheadDays??730,0);
  const result=await o.db.query<MontanaCommitteeReceiver>(`SELECT ${MT_COMMITTEE_SELECT} ${MT_COMMITTEE_FROM}
    LEFT JOIN public.mt_reported_ie_sources s ON s.link_id=l.id AND s.election_year=l.election_year
    LEFT JOIN public.mt_reported_ie_attempts a ON a.link_id=l.id AND a.election_year=l.election_year
    WHERE ${MT_COMMITTEE_WHERE}
    AND e.election_date >= (($2::timestamptz AT TIME ZONE 'UTC')::date-make_interval(days=>$3::int))
    AND e.election_date <= (($2::timestamptz AT TIME ZONE 'UTC')::date+make_interval(days=>$4::int))
    AND (s.link_id IS NULL OR s.source_retrieved_at<($2::timestamptz-make_interval(days=>$5::int)) OR s.source_retrieved_at>$2::timestamptz
      OR s.receiving_candidate_id<>l.committee_id OR s.candidate_id<>l.candidate_id OR s.election_id<>l.election_id)
    AND (a.link_id IS NULL OR a.last_attempted_at<=($2::timestamptz-interval '24 hours') OR a.last_attempted_at>$2::timestamptz
      OR a.source_revision<>$6 OR a.receiving_candidate_id<>l.committee_id OR a.candidate_id<>l.candidate_id OR a.election_id<>l.election_id)
    ORDER BY a.last_attempted_at ASC NULLS FIRST,e.election_date,l.candidate_name_normalized,l.id LIMIT 100001`,[[...MONTANA_FINANCE_ELIGIBLE_OFFICE_KEYS],now.toISOString(),back,ahead,stale,REVISION]);
  if(result.rows.length>100000||new Set(result.rows.map(r=>r.link_id)).size!==result.rows.length)hold("incomplete_eligible_scope");return {totalDueRows:result.rows.length,rows:result.rows.slice(0,max)};
}
async function attempt(db:Db,expected:MontanaCommitteeReceiver){const c=await db.connect();try{
  await c.query("BEGIN");const current=await loadMontanaCommitteeReceiver(c,expected.link_id,true);if(!current||canonical(current)!==canonical(expected))hold("canonical_receiving_context_changed");
  await c.query(`INSERT INTO public.mt_reported_ie_attempts(link_id,election_year,receiving_candidate_id,candidate_id,election_id,source_revision,last_attempted_at)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(link_id,election_year) DO UPDATE SET receiving_candidate_id=EXCLUDED.receiving_candidate_id,
    candidate_id=EXCLUDED.candidate_id,election_id=EXCLUDED.election_id,source_revision=EXCLUDED.source_revision,last_attempted_at=EXCLUDED.last_attempted_at`,
  [current.link_id,current.election_year,current.committee_id,current.candidate_id,current.election_id,REVISION,new Date().toISOString()]);await c.query("COMMIT");
}catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}}
export async function syncDueMontanaIndependentIe(o:MontanaIndependentIeOptions){
  const result={enabled:isMontanaReportedIeEnabled(),dryRun:o.dryRun===true,totalDueRows:0,attemptedCount:0,writtenCount:0,heldCount:0,savedSourceCount:0,capturedSourceCount:0,sourceRefreshFailures:0,totalCents:0,groupCount:0,holds:{} as Record<string,number>};
  if(!result.enabled)return result;const due=await listDueMontanaIndependentIe(o);result.totalDueRows=due.totalDueRows;if(result.dryRun)return result;
  const sources=new Map<number,Promise<MontanaIndependentIePacket|null>>();
  const source=(year:number)=>{if(!sources.has(year))sources.set(year,(async()=>{
    let saved:MontanaIndependentIePacket|null=null;try{saved=await readMontanaIndependentIeSource(year,o.cacheDir);}catch{}
    if((!saved||Date.parse(saved.sourceRetrievedAt)<Date.now()-(o.staleAfterDays??7)*DAY)&&isMontanaCampaignFinanceRawDataRefreshEnabled()){
      try{await acquireMontanaCersOutsideSpendingArtifacts({year,cacheDir:o.cacheDir});const fresh=await readMontanaIndependentIeSource(year,o.cacheDir);if(!fresh)hold("source_qualification_failed");saved=fresh;result.capturedSourceCount++;}
      catch{result.sourceRefreshFailures++;}
    }else if(saved)result.savedSourceCount++;
    return saved;
  })());return sources.get(year)!;};
  for(const receiver of due.rows){result.attemptedCount++;try{
    await attempt(o.db,receiver);const p=await source(receiver.election_year);if(!p)hold("source_unavailable");const written=await writeMontanaIndependentIe({db:o.db,receiver,source:p});
    result.writtenCount++;result.totalCents+=written.totalCents;result.groupCount+=written.groups;
  }catch(e){result.heldCount++;const code=e instanceof MontanaIndependentIeError||e instanceof MontanaReportedCommitteeError?e.code:"storage_unavailable";result.holds[code]=(result.holds[code]??0)+1;}}
  return result;
}
