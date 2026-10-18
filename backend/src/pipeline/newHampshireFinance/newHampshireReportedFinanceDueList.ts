import type { Pool } from "pg";
import { NEW_HAMPSHIRE_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./newHampshireFinanceEligibleOffices.js";
import { parseStoredNewHampshireFilingEntityId } from "./newHampshireCandidateFinanceDueList.js";
import type { NewHampshireReportedReceiver } from "./newHampshireReportedReceiver.js";
import { nhSourceHold } from "./newHampshireReportedSourceGraph.js";
import type { NewHampshireFinanceLinkSource } from "./newHampshireFinanceWriter.js";

export type NewHampshireReportedGates = { ie: boolean; committee: boolean };
export const newHampshireReportedMask = (g: NewHampshireReportedGates) => (g.ie ? 2 : 0) | (g.committee ? 4 : 0);
export type NewHampshireReportedEligibleRow = NewHampshireReportedReceiver & {
  attemptedAt: string | null; componentMask: number | null;
  ieClock: string | null; ieManifest: string | null; ieReceiver: string | null;
  committeeClock: string | null; committeeManifest: string | null; committeeReceiver: string | null;
  ieContextValid: boolean; committeeContextValid: boolean;
};
export async function listEligibleNewHampshireReportedFinance(db: Pick<Pool, "query">, input: {
  now: Date; electionLookbackDays: number; electionLookaheadDays: number; electionYear?: number;
}): Promise<NewHampshireReportedEligibleRow[]> {
  const result = await db.query<Record<string, unknown>>(`SELECT link.id::text link_id,link.candidate_id::text candidate_id,
      link.election_id::text election_id,link.election_year,election.election_date::text election_date,
      COALESCE(NULLIF(trim(candidate.display_name),''),NULLIF(trim(candidate.first_name || ' ' || candidate.last_name),''),link.candidate_name_normalized) candidate_name,
      candidate.display_name,NULLIF(trim(candidate.first_name || ' ' || candidate.last_name),'') structured_name,link.candidate_name_normalized,
      office.scope office_scope,link.office_name,link.district,link.filing_entity_id,link.filer_name,link.link_source,
      attempt.last_attempted_at::text,attempt.component_mask,ie.source_retrieved_at::text ie_clock,ie.source_manifest_sha256 ie_manifest,
      ie.receiving_entity_id ie_receiver,committee.source_retrieved_at::text committee_clock,
      committee.source_manifest_sha256 committee_manifest,committee.receiving_entity_id committee_receiver,
      (ie.candidate_id=link.candidate_id AND ie.election_id=link.election_id) ie_context_valid,
      (committee.candidate_id=link.candidate_id AND committee.election_id=link.election_id) committee_context_valid,COUNT(*) OVER() total_rows
    FROM public.nh_candidate_finance_links link
    JOIN public.candidates candidate ON candidate.id=link.candidate_id
    JOIN public.candidate_elections ce ON ce.candidate_id=link.candidate_id AND ce.election_id=link.election_id
    JOIN public.elections election ON election.id=link.election_id JOIN public.districts district ON district.id=election.district_id
    JOIN public.offices office ON office.id=election.office_id
    LEFT JOIN public.nh_reported_finance_attempts attempt ON attempt.link_id=link.id AND attempt.election_year=link.election_year
    LEFT JOIN public.nh_reported_finance_components ie ON ie.link_id=link.id AND ie.election_year=link.election_year AND ie.component='ie'
    LEFT JOIN public.nh_reported_finance_components committee ON committee.link_id=link.id AND committee.election_year=link.election_year AND committee.component='committee'
    WHERE link.link_status='active' AND candidate.deleted_at IS NULL AND ce.status NOT IN ('lost','withdrawn')
      AND district.state='NH' AND election.race_type='office' AND election.election_stage='general'
      AND link.election_year=EXTRACT(YEAR FROM election.election_date)::int
      AND election.election_date >= (($1::timestamptz AT TIME ZONE 'UTC')::date - make_interval(days=>$2::int))
      AND election.election_date <= (($1::timestamptz AT TIME ZONE 'UTC')::date + make_interval(days=>$3::int))
      AND (office.scope || '::' || office.canonical_name)=ANY($4::text[]) AND ($5::int IS NULL OR link.election_year=$5::int)
    ORDER BY election.election_date,link.candidate_name_normalized,link.id LIMIT 100000`,
    [input.now.toISOString(),input.electionLookbackDays,input.electionLookaheadDays,[...NEW_HAMPSHIRE_FINANCE_ELIGIBLE_OFFICE_KEYS],input.electionYear??null]);
  if (result.rows.length && Number(result.rows[0]!.total_rows)!==result.rows.length) nhSourceHold("eligibility_enumeration_incomplete");
  return result.rows.map(r=>({linkId:String(r.link_id),candidateId:String(r.candidate_id),electionId:String(r.election_id),
    electionYear:Number(r.election_year),electionDate:String(r.election_date),candidateName:String(r.candidate_name),
    candidateAliases:[...new Set([r.display_name,r.structured_name,r.candidate_name_normalized].filter((s):s is string=>typeof s==='string'&&!!s.trim()).map(s=>s.trim()))],
    officeScope:String(r.office_scope),officeName:String(r.office_name),district:r.district as string|null,
    filingEntityId:parseStoredNewHampshireFilingEntityId(String(r.filing_entity_id)),filerName:String(r.filer_name),linkSource:r.link_source as NewHampshireFinanceLinkSource,
    attemptedAt:r.last_attempted_at as string|null,componentMask:r.component_mask as number|null,
    ieClock:r.ie_clock as string|null,ieManifest:r.ie_manifest as string|null,ieReceiver:r.ie_receiver as string|null,
    committeeClock:r.committee_clock as string|null,committeeManifest:r.committee_manifest as string|null,committeeReceiver:r.committee_receiver as string|null,
    ieContextValid:r.ie_context_valid===true,committeeContextValid:r.committee_context_valid===true}));
}
type Hint = {manifestSha256:string;retrievedAt:string}|null;
const clock=(s:string|null)=>s?Date.parse(s):NaN;
export function selectDueNewHampshireReportedFinance(input:{rows:NewHampshireReportedEligibleRow[];now:Date;staleAfterDays:number;
  maxCandidates:number;refresh:boolean;gates:NewHampshireReportedGates;hints:Map<string,{ie:Hint;committee:Hint}>}) {
  const mask=newHampshireReportedMask(input.gates),now=input.now.getTime(),stale=now-input.staleAfterDays*86_400_000;
  if(!mask)return[];
  return input.rows.filter(r=>{
    const hints=input.hints.get(r.linkId);
    const needs=(kind:"ie"|"committee")=>{
      const stored=clock(kind==='ie'?r.ieClock:r.committeeClock),manifest=kind==='ie'?r.ieManifest:r.committeeManifest,
        receiver=kind==='ie'?r.ieReceiver:r.committeeReceiver,hint=hints?.[kind];
      return !Number.isFinite(stored)||stored>now||stored<stale||receiver!==String(r.filingEntityId)||!(kind==='ie'?r.ieContextValid:r.committeeContextValid)||
        !!hint&&(clock(hint.retrievedAt)>stored||clock(hint.retrievedAt)===stored&&hint.manifestSha256!==manifest);
    };
    if(!input.refresh&&!(input.gates.ie&&needs('ie')||input.gates.committee&&needs('committee')))return false;
    const attempted=clock(r.attemptedAt),newest=Math.max(-Infinity,...[input.gates.ie?hints?.ie?.retrievedAt:null,input.gates.committee?hints?.committee?.retrievedAt:null].filter((s):s is string=>!!s).map(s=>Date.parse(s)));
    return input.refresh||!Number.isFinite(attempted)||attempted>now||attempted<=now-86_400_000||r.componentMask!==mask||newest>attempted;
  }).sort((a,b)=>{
    const attempt=(r:NewHampshireReportedEligibleRow)=>Number.isFinite(clock(r.attemptedAt))?clock(r.attemptedAt):-Infinity;
    return attempt(a)-attempt(b)||a.electionDate.localeCompare(b.electionDate)||
      input.rows.indexOf(a)-input.rows.indexOf(b);
  }).slice(0,input.maxCandidates);
}
export async function recordNewHampshireReportedAttempt(input:{db:Pick<Pool,"query">;receiver:NewHampshireReportedReceiver;now:Date;gates:NewHampshireReportedGates}) {
  const r=input.receiver,mask=newHampshireReportedMask(input.gates);
  if(!mask)return false;
  const result=await input.db.query(`INSERT INTO public.nh_reported_finance_attempts (link_id,election_year,last_attempted_at,component_mask)
    SELECT link.id,link.election_year,$8::timestamptz,$9::int FROM public.nh_candidate_finance_links link
    JOIN public.candidates c ON c.id=link.candidate_id JOIN public.candidate_elections ce ON ce.candidate_id=c.id AND ce.election_id=link.election_id
    JOIN public.elections e ON e.id=link.election_id JOIN public.districts d ON d.id=e.district_id JOIN public.offices o ON o.id=e.office_id
    WHERE link.id=$1::uuid AND link.election_year=$2 AND link.candidate_id=$3::uuid AND link.election_id=$4::uuid
      AND link.filing_entity_id=$5 AND link.link_source=$6 AND e.election_date=$7::date AND link.link_status='active'
      AND c.deleted_at IS NULL AND ce.status NOT IN ('lost','withdrawn') AND d.state='NH' AND e.race_type='office' AND e.election_stage='general'
      AND EXTRACT(YEAR FROM e.election_date)::int=$2 AND (o.scope || '::' || o.canonical_name)=ANY($10::text[])
    ON CONFLICT(link_id,election_year) DO UPDATE SET last_attempted_at=EXCLUDED.last_attempted_at,component_mask=EXCLUDED.component_mask
    WHERE nh_reported_finance_attempts.last_attempted_at<EXCLUDED.last_attempted_at OR
      (nh_reported_finance_attempts.last_attempted_at=EXCLUDED.last_attempted_at AND nh_reported_finance_attempts.component_mask=EXCLUDED.component_mask)
    RETURNING link_id`,[r.linkId,r.electionYear,r.candidateId,r.electionId,String(r.filingEntityId),r.linkSource,r.electionDate,input.now.toISOString(),mask,[...NEW_HAMPSHIRE_FINANCE_ELIGIBLE_OFFICE_KEYS]]);
  return result.rows.length===1;
}
