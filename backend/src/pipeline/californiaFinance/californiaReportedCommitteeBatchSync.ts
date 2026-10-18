import type {Pool} from "pg";
import {isCaliforniaReportedCommitteeReceiptsEnabled,isCaliforniaCampaignFinanceRawDataRefreshEnabled} from "../../config/featureFlags.js";
import {CA_COMMITTEE_SELECT,CA_COMMITTEE_FROM,CA_COMMITTEE_WHERE,CA_COMMITTEE_UNIQUE,confirmCaliforniaCommitteeLink,loadCaliforniaCommitteeReceiver,type CaliforniaCommitteeReceiver} from "./californiaReportedCommitteeReceiver.js";
import {loadCalAccessCommitteeResolutionData,type CalAccessCommitteeResolutionData} from "./calAccessRawDataLoader.js";
import {CALIFORNIA_FINANCE_ELIGIBLE_OFFICE_KEYS} from "./californiaFinanceEligibleOffices.js";
import {CaliforniaCommitteeError,caCommitteeHold as hold,caCommitteeInteger as integer,caCommitteeCanonical as canonical,readCaliforniaCommitteePacket} from "./californiaReportedCommitteeSource.js";
import {writeCaliforniaCommitteeComponent} from "./californiaReportedCommitteeWriter.js";
import {DEFAULT_CAL_ACCESS_RAW_DATA_CACHE_DIR,getCalAccessRawDataArtifactCachePaths,readCalAccessRawDataArtifactCacheMetadata,refreshCalAccessRawDataArtifactCache} from "./calAccessRawDataArtifactCache.js";
type Db=Pick<Pool,"query">&Partial<Pick<Pool,"connect">>;
export type CaliforniaCommitteeBatchOptions={db:Db;now?:Date;dryRun?:boolean;maxCandidates?:number;staleAfterDays?:number;electionLookbackDays?:number;electionLookaheadDays?:number;cacheDir?:string;
  /** Complete cover/filer-name tables for the stale-link gate; undefined loads them from cacheDir, null holds every receiver. */
  resolutionData?:CalAccessCommitteeResolutionData|null};
const REVISION="ca-reported-committee-v1";
const bounded=(v:number,min=1)=>{integer(v,min);if(v>100000)hold("invalid_batch_option");return v;};
export async function listDueCaliforniaCommitteeReceipts(o:CaliforniaCommitteeBatchOptions){
  const now=o.now??new Date();if(!Number.isFinite(now.getTime()))hold("invalid_batch_clock");const max=bounded(o.maxCandidates??25),stale=bounded(o.staleAfterDays??7),back=bounded(o.electionLookbackDays??98,0),ahead=bounded(o.electionLookaheadDays??730,0);
  const rows=(await o.db.query<CaliforniaCommitteeReceiver>(`SELECT ${CA_COMMITTEE_SELECT} ${CA_COMMITTEE_FROM}
    LEFT JOIN public.ca_reported_committee_sources s ON s.link_id=l.id AND s.election_year=l.election_year
    LEFT JOIN public.ca_reported_committee_attempts a ON a.link_id=l.id AND a.election_year=l.election_year
    WHERE ${CA_COMMITTEE_WHERE} AND ${CA_COMMITTEE_UNIQUE}
    AND e.election_date >= (($2::timestamptz AT TIME ZONE 'UTC')::date-make_interval(days=>$3::int))
    AND e.election_date <= (($2::timestamptz AT TIME ZONE 'UTC')::date+make_interval(days=>$4::int))
    AND(s.link_id IS NULL OR s.source_retrieved_at<($2::timestamptz-make_interval(days=>$5::int)) OR s.source_retrieved_at>$2::timestamptz OR s.receiving_committee_id<>l.controlled_committee_id OR s.candidate_id<>l.candidate_id OR s.election_id<>l.election_id)
    AND(a.link_id IS NULL OR a.last_attempted_at<=($2::timestamptz-interval '24 hours') OR a.last_attempted_at>$2::timestamptz OR a.source_revision<>$6 OR a.receiving_committee_id<>l.controlled_committee_id OR a.candidate_id<>l.candidate_id OR a.election_id<>l.election_id)
    ORDER BY a.last_attempted_at ASC NULLS FIRST,e.election_date,l.candidate_name_normalized,l.id LIMIT 100001`,[[...CALIFORNIA_FINANCE_ELIGIBLE_OFFICE_KEYS],now.toISOString(),back,ahead,stale,REVISION])).rows;
  if(rows.length>100000||new Set(rows.map(r=>r.link_id)).size!==rows.length)hold("incomplete_due_scope");return {rows:rows.slice(0,max),totalDueRows:rows.length};
}
async function attempt(db:Db,expected:CaliforniaCommitteeReceiver){
  if(!db.connect)hold("missing_transaction_pool");const c=await db.connect();try{await c.query("BEGIN");const r=await loadCaliforniaCommitteeReceiver(c,expected.link_id,true);if(!r||canonical(r)!==canonical(expected))hold("canonical_receiving_context_changed");
    await c.query(`INSERT INTO public.ca_reported_committee_attempts(link_id,election_year,candidate_id,election_id,receiving_committee_id,source_revision,last_attempted_at)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(link_id,election_year) DO UPDATE SET candidate_id=EXCLUDED.candidate_id,election_id=EXCLUDED.election_id,receiving_committee_id=EXCLUDED.receiving_committee_id,source_revision=EXCLUDED.source_revision,last_attempted_at=EXCLUDED.last_attempted_at`,[r.link_id,r.election_year,r.candidate_id,r.election_id,r.committee_id,REVISION,new Date().toISOString()]);await c.query("COMMIT");
  }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
}
export async function syncDueCaliforniaCommitteeReceipts(o:CaliforniaCommitteeBatchOptions){
  const result={enabled:isCaliforniaReportedCommitteeReceiptsEnabled(),dryRun:o.dryRun===true,totalDueRows:0,attemptedCount:0,writtenCount:0,heldCount:0,totalCents:0,groupCount:0,sourceRefreshFailures:0,holds:{} as Record<string,number>};if(!result.enabled)return result;
  const due=await listDueCaliforniaCommitteeReceipts(o);result.totalDueRows=due.totalDueRows;if(result.dryRun||!due.rows.length)return result;
  const mark=(e:unknown)=>{result.heldCount++;const code=e instanceof CaliforniaCommitteeError?e.code:"source_or_storage_unavailable";result.holds[code]=(result.holds[code]??0)+1;},ready:CaliforniaCommitteeReceiver[]=[];
  for(const r of due.rows){result.attemptedCount++;try{await attempt(o.db,r);ready.push(r);}catch(e){mark(e);}}
  if(!ready.length)return result;
  const cacheDir=o.cacheDir??(process.env.CAL_ACCESS_RAW_DATA_CACHE_DIR?.trim()||DEFAULT_CAL_ACCESS_RAW_DATA_CACHE_DIR);
  if(isCaliforniaCampaignFinanceRawDataRefreshEnabled()){const paths=getCalAccessRawDataArtifactCachePaths(cacheDir),metadata=await readCalAccessRawDataArtifactCacheMetadata(paths.metadataPath);if(!metadata||Date.parse(metadata.downloadedAt)<Date.now()-(o.staleAfterDays??7)*86400000)try{await refreshCalAccessRawDataArtifactCache({cacheDir});}catch{result.sourceRefreshFailures++;}}
  const evidence=o.resolutionData===undefined?await loadCalAccessCommitteeResolutionData({cacheDir}).catch(()=>null):o.resolutionData,confirmed:CaliforniaCommitteeReceiver[]=[];
  for(const r of ready)try{if(!evidence)hold("committee_evidence_unavailable");confirmCaliforniaCommitteeLink(r,evidence);confirmed.push(r);}catch(e){mark(e);}
  if(!confirmed.length)return result;
  let packet:Awaited<ReturnType<typeof readCaliforniaCommitteePacket>>;try{packet=await readCaliforniaCommitteePacket(confirmed.map(r=>r.committee_id),cacheDir);}catch(e){for(const _r of confirmed)mark(e);return result;}
  for(const receiver of confirmed)try{const written=await writeCaliforniaCommitteeComponent({db:o.db as Pick<Pool,"connect">,receiver,source:packet});result.writtenCount++;result.totalCents+=written.totalCents;result.groupCount+=written.groups;}catch(e){mark(e);}
  return result;
}
