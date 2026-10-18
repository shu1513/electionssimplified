import type { Pool, PoolClient } from "pg";
import { isMontanaReportedCommitteeReceiptsEnabled, isMontanaCampaignFinanceRawDataRefreshEnabled } from "../../config/featureFlags.js";
import { MontanaReportedCommitteeError, mtCommitteeCanonical as canonical, mtCommitteeHold as hold } from "./montanaReportedCommitteeSource.js";
import { acquireMontanaCommitteePacket, readMontanaCommitteePacket } from "./montanaReportedCommitteeCache.js";
import { MT_COMMITTEE_FROM, MT_COMMITTEE_SELECT, MT_COMMITTEE_WHERE, loadMontanaCommitteeReceiver, type MontanaCommitteeReceiver } from "./montanaReportedCommitteeReceiver.js";
import { MONTANA_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./montanaFinanceEligibleOffices.js";
import { writeMontanaCommitteeReceipts } from "./montanaReportedCommitteeWriter.js";

type Db=Pick<Pool,"query">&{connect:()=>Promise<PoolClient>};
export type MontanaCommitteeBatchOptions={db:Db;now?:Date;maxCandidates?:number;staleAfterDays?:number;electionLookbackDays?:number;electionLookaheadDays?:number;dryRun?:boolean;cacheDir?:string};
const DAY=86400000,integer=(n:number,min=1)=>{if(!Number.isSafeInteger(n)||n<min||n>100000)hold("invalid_batch_option");return n;};
// Bump when native qualification semantics change; holds must not wait a full
// day after a correction to the source parser. No monetary refresh is implied.
const SOURCE_REVISION="mt-reported-committee-v2-contact-order";
export async function listDueMontanaCommitteeReceipts(input:MontanaCommitteeBatchOptions){
  const now=input.now??new Date();if(!Number.isFinite(now.getTime()))hold("invalid_batch_clock");
  const max=integer(input.maxCandidates??10),stale=integer(input.staleAfterDays??7),back=integer(input.electionLookbackDays??98,0),ahead=integer(input.electionLookaheadDays??730,0);
  const r=await input.db.query<MontanaCommitteeReceiver>(`SELECT ${MT_COMMITTEE_SELECT} ${MT_COMMITTEE_FROM}
    LEFT JOIN public.mt_reported_committee_sources s ON s.link_id=l.id AND s.election_year=l.election_year
    LEFT JOIN public.mt_reported_committee_attempts a ON a.link_id=l.id AND a.election_year=l.election_year
    WHERE ${MT_COMMITTEE_WHERE}
    AND e.election_date >= (($2::timestamptz AT TIME ZONE 'UTC')::date-make_interval(days=>$3::int))
    AND e.election_date <= (($2::timestamptz AT TIME ZONE 'UTC')::date+make_interval(days=>$4::int))
    AND (s.link_id IS NULL OR s.source_retrieved_at<($2::timestamptz-make_interval(days=>$5::int)) OR s.source_retrieved_at>$2::timestamptz
      OR s.receiving_committee_id<>l.committee_id OR s.candidate_id<>l.candidate_id OR s.election_id<>l.election_id)
    AND (a.link_id IS NULL OR a.last_attempted_at<=($2::timestamptz-interval '24 hours') OR a.last_attempted_at>$2::timestamptz
      OR a.source_revision<>$6
      OR a.receiving_committee_id<>l.committee_id OR a.candidate_id<>l.candidate_id OR a.election_id<>l.election_id)
    ORDER BY a.last_attempted_at ASC NULLS FIRST,e.election_date,l.candidate_name_normalized,l.id LIMIT 100001`,
  [[...MONTANA_FINANCE_ELIGIBLE_OFFICE_KEYS],now.toISOString(),back,ahead,stale,SOURCE_REVISION]);
  if(r.rows.length>100000||new Set(r.rows.map(r=>r.link_id)).size!==r.rows.length)hold("incomplete_eligible_scope");
  return {totalDueRows:r.rows.length,rows:r.rows.slice(0,max)};
}
async function attempt(db:Db,expected:MontanaCommitteeReceiver){
  const c=await db.connect();try{
    await c.query("BEGIN");const current=await loadMontanaCommitteeReceiver(c,expected.link_id,true);
    if(!current||canonical(current)!==canonical(expected))hold("canonical_receiving_context_changed");
    await c.query(`INSERT INTO public.mt_reported_committee_attempts
      (link_id,election_year,candidate_id,election_id,receiving_committee_id,last_attempted_at,source_revision) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(link_id,election_year) DO UPDATE SET candidate_id=EXCLUDED.candidate_id,election_id=EXCLUDED.election_id,
      receiving_committee_id=EXCLUDED.receiving_committee_id,last_attempted_at=EXCLUDED.last_attempted_at,source_revision=EXCLUDED.source_revision`,
    [current.link_id,current.election_year,current.candidate_id,current.election_id,current.committee_id,new Date().toISOString(),SOURCE_REVISION]);
    await c.query("COMMIT");
  }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
}
export async function syncDueMontanaCommitteeReceipts(input:MontanaCommitteeBatchOptions){
  const result={enabled:isMontanaReportedCommitteeReceiptsEnabled(),dryRun:input.dryRun===true,totalDueRows:0,attemptedCount:0,writtenCount:0,
    heldCount:0,savedSourceCount:0,capturedSourceCount:0,sourceRefreshFailures:0,sourceCacheFailures:0,totalCents:0,groupCount:0,holds:{} as Record<string,number>};
  if(!result.enabled)return result;const due=await listDueMontanaCommitteeReceipts(input);result.totalDueRows=due.totalDueRows;if(result.dryRun)return result;
  for(const receiver of due.rows){
    result.attemptedCount++;
    try{
      await attempt(input.db,receiver);const scope={nativeCandidateId:Number(receiver.committee_id),electionYear:receiver.election_year};
      let saved:Awaited<ReturnType<typeof readMontanaCommitteePacket>>=null;
      try{saved=await readMontanaCommitteePacket(scope,input.cacheDir);}catch{result.sourceCacheFailures++;}
      const stale=!saved||Date.parse(saved.sourceRetrievedAt)<Date.now()-(input.staleAfterDays??7)*DAY;
      if(stale&&isMontanaCampaignFinanceRawDataRefreshEnabled()){
        try{saved=await acquireMontanaCommitteePacket(scope,input.cacheDir);result.capturedSourceCount++;}
        catch{result.sourceRefreshFailures++;/* A qualified saved source keeps its genuine date. */}
      }else if(saved)result.savedSourceCount++;
      if(!saved)hold("source_unavailable");const written=await writeMontanaCommitteeReceipts({db:input.db,receiver,source:saved});
      result.writtenCount++;result.totalCents+=written.totalCents;result.groupCount+=written.groupCount;
    }catch(e){result.heldCount++;const code=e instanceof MontanaReportedCommitteeError?e.code:"storage_unavailable";result.holds[code]=(result.holds[code]??0)+1;}
  }
  return result;
}
