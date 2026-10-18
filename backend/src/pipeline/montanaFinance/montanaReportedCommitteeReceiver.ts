import type { Pool, PoolClient } from "pg";
import { normalizeMontanaCandidateNameForStorage, resolveMontanaCersCandidate } from "./montanaCandidateCersResolver.js";
import { MONTANA_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./montanaFinanceEligibleOffices.js";
import { mtCommitteeHold as hold } from "./montanaReportedCommitteeSource.js";
import type { MontanaCersCandidateSearchRow } from "./montanaCersParsers.js";

export type MontanaCommitteeReceiver = {
  link_id:string;candidate_id:string;election_id:string;election_year:number;committee_id:string;link_source:string;
  link_candidate_name:string;link_committee_name:string;link_office_name:string;link_district:string|null;
  candidate_name:string;full_name:string;office_scope:string;office_name:string;district:string|null;
  district_name:string|null;ballot_title:string|null;election_date:string;
};
export const MT_COMMITTEE_SELECT=`l.id::text link_id,l.candidate_id::text,l.election_id::text,l.election_year,l.committee_id,l.link_source,
  l.candidate_name_normalized link_candidate_name,l.committee_name link_committee_name,l.office_name link_office_name,l.district link_district,
  COALESCE(NULLIF(trim(c.display_name),''),trim(c.first_name||' '||c.last_name)) candidate_name,
  trim(c.first_name||' '||c.last_name) full_name,o.scope office_scope,o.canonical_name office_name,d.name district_name,
  e.official_ballot_title ballot_title,e.election_date::text,
  CASE WHEN d.district_type IN ('state_upper','state_lower') THEN
  NULLIF(regexp_replace(substring(d.geoid_compact from char_length(d.state_fips)+1),'^0+',''),'') END district`;
export const MT_COMMITTEE_FROM=`FROM public.mt_candidate_finance_links l JOIN public.candidates c ON c.id=l.candidate_id
  JOIN public.candidate_elections ce ON ce.candidate_id=l.candidate_id AND ce.election_id=l.election_id
  JOIN public.elections e ON e.id=l.election_id JOIN public.districts d ON d.id=e.district_id JOIN public.offices o ON o.id=e.office_id`;
export const MT_COMMITTEE_WHERE=`l.link_status='active' AND c.deleted_at IS NULL AND ce.status NOT IN ('lost','withdrawn')
  AND d.state='MT' AND e.race_type='office' AND e.election_stage='general'
  AND extract(year from e.election_date)::int=l.election_year AND (o.scope||'::'||o.canonical_name)=ANY($1::text[])`;
export async function loadMontanaCommitteeReceiver(db:Pick<Pool|PoolClient,"query">,id:string,lock=false):Promise<MontanaCommitteeReceiver|null>{
  const rows=await db.query<MontanaCommitteeReceiver>(`SELECT ${MT_COMMITTEE_SELECT} ${MT_COMMITTEE_FROM}
    WHERE ${MT_COMMITTEE_WHERE} AND l.id=$2::uuid ${lock?"FOR UPDATE OF c,ce,e,d,o,l":""}`,[[...MONTANA_FINANCE_ELIGIBLE_OFFICE_KEYS],id]);
  if(rows.rows.length!==1)return null;const row=rows.rows[0]!;
  const siblings=await db.query<{id:string;link_status:string}>(`SELECT id::text,link_status FROM public.mt_candidate_finance_links
    WHERE (candidate_id=$1::uuid AND election_id=$2::uuid) OR (committee_id=$3 AND election_year=$4)
    ORDER BY id ${lock?"FOR UPDATE":""}`,[row.candidate_id,row.election_id,row.committee_id,row.election_year]);
  return siblings.rows.filter(r=>r.link_status==='active').length===1?row:null;
}
export function qualifyMontanaCommitteeReceiver(r:MontanaCommitteeReceiver,rows:readonly MontanaCersCandidateSearchRow[]){
  if(r.link_office_name!==r.office_name || r.link_district!==(r.district??r.district_name) ||
    r.link_candidate_name!==normalizeMontanaCandidateNameForStorage(r.candidate_name) || !r.full_name?.trim())hold("canonical_receiving_context_mismatch");
  for(const candidateName of new Set([r.candidate_name,r.full_name])){
    const match=resolveMontanaCersCandidate({candidateName,electionYear:r.election_year,officeScope:r.office_scope,officeName:r.office_name,
      districtName:r.district_name,legislativeDistrict:r.district,ballotTitle:r.ballot_title,rows});
    if(match.status!=="matched" || String(match.cersCandidateId)!==r.committee_id || match.cersCandidateName!==r.link_committee_name)hold("canonical_native_receiver_mismatch");
  }
}
