import type {Pool,PoolClient} from "pg";
import {CALIFORNIA_FINANCE_ELIGIBLE_OFFICE_KEYS} from "./californiaFinanceEligibleOffices.js";
import {resolveCaliforniaCandidateCommittee} from "./californiaCandidateCommitteeResolver.js";
import {caCommitteeHold as hold,caCommitteeDate} from "./californiaReportedCommitteeSource.js";
export type CaliforniaCommitteeReceiver={link_id:string;candidate_id:string;election_id:string;election_year:number;committee_id:string;link_source:string;
  link_candidate_name:string;link_committee_name:string;link_office_name:string;candidate_name:string;full_name:string;office_scope:string;office_name:string;district:string|null;election_date:string};
export const CA_COMMITTEE_SELECT=`l.id::text link_id,l.candidate_id::text,l.election_id::text,l.election_year,l.controlled_committee_id committee_id,l.link_source,
  l.candidate_name_normalized link_candidate_name,l.controlled_committee_name link_committee_name,l.office_name link_office_name,
  COALESCE(NULLIF(trim(c.display_name),''),trim(c.first_name||' '||c.last_name)) candidate_name,trim(c.first_name||' '||c.last_name) full_name,
  o.scope office_scope,o.canonical_name office_name,e.election_date::text,
  CASE WHEN d.district_type IN('state_upper','state_lower') THEN NULLIF(regexp_replace(substring(d.geoid_compact from char_length(d.state_fips)+1),'^0+',''),'') END district`;
export const CA_COMMITTEE_FROM=`FROM public.ca_candidate_finance_links l JOIN public.candidates c ON c.id=l.candidate_id
  JOIN public.candidate_elections ce ON ce.candidate_id=l.candidate_id AND ce.election_id=l.election_id
  JOIN public.elections e ON e.id=l.election_id JOIN public.districts d ON d.id=e.district_id JOIN public.offices o ON o.id=e.office_id`;
export const CA_COMMITTEE_WHERE=`l.link_status='active' AND c.deleted_at IS NULL AND ce.status NOT IN('lost','withdrawn') AND d.state='CA'
  AND e.race_type='office' AND e.election_stage='general' AND extract(year from e.election_date)::int=l.election_year
  AND (o.scope||'::'||o.canonical_name)=ANY($1::text[])`;
export const CA_COMMITTEE_UNIQUE=`(SELECT count(*) FROM public.ca_candidate_finance_links sibling WHERE sibling.link_status='active' AND
  ((sibling.candidate_id=l.candidate_id AND sibling.election_id=l.election_id) OR (sibling.controlled_committee_id=l.controlled_committee_id AND sibling.election_year=l.election_year)))=1`;
export async function loadCaliforniaCommitteeReceiver(db:Pick<Pool|PoolClient,"query">,id:string,lock=false){
  const rows=(await db.query<CaliforniaCommitteeReceiver>(`SELECT ${CA_COMMITTEE_SELECT} ${CA_COMMITTEE_FROM} WHERE ${CA_COMMITTEE_WHERE} AND l.id=$2::uuid ${lock?"FOR UPDATE OF c,ce,e,d,o,l":""}`,[[...CALIFORNIA_FINANCE_ELIGIBLE_OFFICE_KEYS],id])).rows;if(rows.length!==1)return null;const r=rows[0]!;
  const siblings=(await db.query<{id:string;link_status:string}>(`SELECT id::text,link_status FROM public.ca_candidate_finance_links WHERE
    (candidate_id=$1::uuid AND election_id=$2::uuid) OR (controlled_committee_id=$3 AND election_year=$4) ORDER BY id ${lock?"FOR UPDATE":""}`,[r.candidate_id,r.election_id,r.committee_id,r.election_year])).rows;
  return siblings.filter(s=>s.link_status==="active").length===1?r:null;
}
export function qualifyCaliforniaCommitteeReceiver(r:CaliforniaCommitteeReceiver,covers:readonly Record<string,string>[]){
  const normalize=(s:string)=>s.trim().replace(/\s+/g," ").toUpperCase();
  if(r.link_office_name!==r.office_name||r.link_candidate_name!==normalize(r.candidate_name)||!r.full_name?.trim()||!covers.length||covers.some(c=>c.FILER_ID!==r.committee_id||c.CONTROL_YN!=="Y"))hold("canonical_receiving_context_mismatch");
  const scoped=covers.filter(c=>{try{return caCommitteeDate(c.ELECT_DATE??"").startsWith(String(r.election_year)+"-")&&(r.district===null||/^\d+$/.test(c.DIST_NO??"")&&Number(c.DIST_NO)===Number(r.district));}catch{return false;}});
  if(!scoped.length)hold("native_receiving_office_cycle_mismatch");
  for(const candidateName of new Set([r.candidate_name,r.full_name])){const match=resolveCaliforniaCandidateCommittee({candidateName,officeName:r.office_name,electionYear:r.election_year,campaignCoverRows:scoped});if(match.status!=="matched"||match.controlledCommitteeId!==r.committee_id)hold("canonical_native_receiver_mismatch");}
}
