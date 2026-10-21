import type { Pool, PoolClient } from "pg";
import { firstNameVariants, firstNamesConflict } from "../finance/personFirstNameNicknames.js";
import { hasMiddleNameConflict, personNameParseVariants, personNamesMatchWithMiddleEvidence } from "../finance/personNameMiddleEvidence.js";
import { inCheck, inKey, type IndianaNativeCommittee } from "./indianaNativeProtocol.js";

export type IndianaNativeReceiver = {
  linkId:string; candidateId:string; electionId:string; electionYear:number; electionDate:string;
  firstName:string; lastName:string; candidateAliases:string[];
  receivingId:string; committeeName:string; officeScope:string; officeName:string; linkOfficeName:string;
  district:string|null; canonicalDistrictName:string; canonicalDistrictType:string; activeOwnerCount:number;
};
export const IN_NATIVE_SELECT=`l.id::text "linkId",l.candidate_id::text "candidateId",l.election_id::text "electionId",
 l.election_year "electionYear",e.election_date::text "electionDate",c.first_name "firstName",c.last_name "lastName",
 array_remove(ARRAY[trim(c.first_name||' '||c.last_name),c.display_name,l.candidate_name_normalized],NULL) "candidateAliases",
 l.committee_id "receivingId",l.committee_name "committeeName",o.scope "officeScope",o.canonical_name "officeName",l.office_name "linkOfficeName",l.district,
 d.name "canonicalDistrictName",d.district_type "canonicalDistrictType",
 (SELECT count(DISTINCT candidate_id)::int FROM public.in_candidate_finance_links owner WHERE owner.committee_id=l.committee_id AND owner.link_status='active') "activeOwnerCount"`;
export const IN_NATIVE_FROM=`FROM public.in_candidate_finance_links l JOIN public.candidates c ON c.id=l.candidate_id
 JOIN public.candidate_elections ce ON ce.candidate_id=l.candidate_id AND ce.election_id=l.election_id
 JOIN public.elections e ON e.id=l.election_id JOIN public.districts d ON d.id=e.district_id JOIN public.offices o ON o.id=e.office_id`;
export const IN_NATIVE_WHERE=`l.link_status='active' AND c.deleted_at IS NULL AND c.merged_into_candidate_id IS NULL AND ce.status<>'withdrawn'
 AND d.state='IN' AND e.race_type='office' AND e.election_stage='general' AND l.election_year=extract(year from e.election_date)::int
 AND ((o.scope='state_lower' AND o.canonical_name='State Lower Chamber Legislator') OR (o.scope='state_upper' AND o.canonical_name='State Senator'))
 AND NOT EXISTS(SELECT 1 FROM public.in_candidate_finance_links sibling WHERE sibling.link_status='active' AND sibling.id<>l.id AND sibling.candidate_id=l.candidate_id AND sibling.election_id=l.election_id)`;
export async function loadIndianaNativeReceiver(db:Pick<Pool|PoolClient,"query">,linkId:string,lock=false):Promise<IndianaNativeReceiver|null> {
  const q=await db.query<IndianaNativeReceiver>(`SELECT ${IN_NATIVE_SELECT} ${IN_NATIVE_FROM} WHERE ${IN_NATIVE_WHERE} AND l.id=$1::uuid ${lock?"FOR UPDATE OF l,c,ce,e,d,o":""}`,[linkId]);
  if(q.rows.length!==1)return null;const r=q.rows[0]!;
  if(lock){
    const owners=await db.query<{candidate_id:string;link_status:string}>(`SELECT candidate_id::text,link_status FROM public.in_candidate_finance_links WHERE committee_id=$1 OR(candidate_id=$2::uuid AND election_id=$3::uuid) ORDER BY id FOR UPDATE`,[r.receivingId,r.candidateId,r.electionId]);
    if(new Set(owners.rows.filter(o=>o.link_status==='active').map(o=>o.candidate_id)).size!==1)return null;
  }
  return r;
}
const personKey=(v:string)=>v.replace(/^(?:Mr|Mrs|Ms|Miss|Dr)\.?\s+/i,"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toUpperCase().replace(/\b(?:JR|SR|II|III|IV)\b/g," ").replace(/[^A-Z0-9]+/g," ").trim().replace(/\s+/g," ");
export function qualifyIndianaNativeReceiver(r:IndianaNativeReceiver,c:IndianaNativeCommittee):void {
  inCheck(r.activeOwnerCount===1&&r.electionDate.slice(0,4)===String(r.electionYear)&&/^\d+$/.test(r.receivingId),"native_canonical_context");
  inCheck(c.file===r.receivingId&&c.committeeClass==='Candidate'&&inKey(c.name)===inKey(r.committeeName),"native_receiving_identity");
  const expected=r.officeScope==='state_lower'?['State Lower Chamber Legislator','State Representative','House',100] as const:r.officeScope==='state_upper'?['State Senator','State Senator','Senate',50] as const:null;
  inCheck(expected&&r.officeName===expected[0]&&r.linkOfficeName===r.officeName&&c.office===expected[1]&&r.canonicalDistrictType===r.officeScope,"native_receiving_office");
  const district=new RegExp(`^State ${expected[2]} District ([1-9][0-9]*)(?: \\((?:19|20)[0-9]{2}\\))?; Indiana$`).exec(r.canonicalDistrictName);
  inCheck(district&&Number(district[1])<=expected[3]&&/^\d+$/.test(c.district)&&String(Number(c.district))===district[1]&&(!r.district||r.district===r.canonicalDistrictName||/^\d+$/.test(r.district)&&String(Number(r.district))===district[1]),"native_receiving_district");
  const firsts=personNameParseVariants(c.candidate,personKey).map(n=>n.first),aliases=r.candidateAliases.filter(s=>s.trim()),equivalent=(a:string,b:string)=>a===b||firstNameVariants(a).includes(b);
  inCheck(firsts.length>0&&aliases.length>0&&firsts.every(n=>!firstNamesConflict(personKey(r.firstName).split(' ')[0]??'',n))
    &&aliases.every(candidateName=>!hasMiddleNameConflict({candidateName,rowNames:[c.candidate],normalizePersonName:personKey,firstNamesEquivalent:equivalent}))
    &&aliases.some(candidateName=>personNamesMatchWithMiddleEvidence({candidateName,rowNames:[c.candidate],normalizePersonName:personKey,firstNamesEquivalent:equivalent})),"native_receiving_person");
}
