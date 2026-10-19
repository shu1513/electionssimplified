import type { Pool, PoolClient } from "pg";
import { ARIZONA_FINANCE_ELIGIBLE_OFFICE_KEYS, normalizeArizonaFinanceOffice } from "./arizonaFinanceEligibleOffices.js";
import { personNamesMatchWithMiddleEvidence } from "../finance/personNameMiddleEvidence.js";
import { azCanonical, azHold, azId } from "./arizonaReportedCore.js";

export type ArizonaReportedReceiver = {
  linkId:string;candidateId:string;electionId:string;electionYear:number;electionDate:string;
  candidateName:string;fullName:string;officeScope:string;canonicalOffice:string;canonicalDistrict:string|null;
  entityId:string;committeeName:string;linkSource:string;linkOffice:string;linkDistrict:string|null;
};
export const AZ_REPORTED_RECEIVER_SELECT = `SELECT l.id::text "linkId",l.candidate_id::text "candidateId",l.election_id::text "electionId",
 l.election_year "electionYear",e.election_date::text "electionDate",
 COALESCE(NULLIF(trim(c.display_name),''),NULLIF(trim(c.first_name||' '||c.last_name),'')) "candidateName",
 trim(c.first_name||' '||c.last_name) "fullName",o.scope "officeScope",o.canonical_name "canonicalOffice",
 CASE WHEN d.district_type IN ('state_lower','state_upper') THEN NULLIF(trim(d.name),'') END "canonicalDistrict",
 l.committee_id "entityId",l.committee_name "committeeName",l.link_source "linkSource",l.office_name "linkOffice",l.district "linkDistrict"
 FROM public.az_candidate_finance_links l JOIN public.candidates c ON c.id=l.candidate_id
 JOIN public.candidate_elections ce ON ce.candidate_id=c.id AND ce.election_id=l.election_id
 JOIN public.elections e ON e.id=ce.election_id JOIN public.districts d ON d.id=e.district_id JOIN public.offices o ON o.id=e.office_id
 WHERE l.link_status='active' AND c.deleted_at IS NULL AND ce.status<>'withdrawn'
 AND (ce.status<>'lost' OR e.election_date<(now() AT TIME ZONE 'UTC')::date)
 AND (SELECT count(*) FROM public.az_candidate_finance_links a WHERE a.candidate_id=l.candidate_id AND a.election_id=l.election_id AND a.link_status='active')=1
 AND NOT EXISTS(SELECT 1 FROM public.az_candidate_finance_links a WHERE a.candidate_id<>l.candidate_id AND a.committee_id=l.committee_id AND a.election_year=l.election_year AND a.link_status='active')
 AND d.state='AZ' AND e.race_type='office' AND e.election_stage='general' AND l.election_year=2026 AND e.election_date='2026-11-03'::date
 AND (o.scope||'::'||o.canonical_name)=ANY($1::text[])`;
const keys=[...ARIZONA_FINANCE_ELIGIBLE_OFFICE_KEYS];
export async function listArizonaReportedReceivers(db:Pick<Pool|PoolClient,"query">):Promise<ArizonaReportedReceiver[]> {
  return (await db.query<ArizonaReportedReceiver>(AZ_REPORTED_RECEIVER_SELECT+" ORDER BY l.candidate_name_normalized,l.id",[keys])).rows;
}
export async function lockArizonaReportedReceiver(db:PoolClient,r:ArizonaReportedReceiver):Promise<void> {
  const links=(await db.query(`SELECT id::text FROM public.az_candidate_finance_links WHERE candidate_id=$1::uuid AND election_id=$2::uuid AND link_status='active' ORDER BY id FOR UPDATE`,[r.candidateId,r.electionId])).rows;
  const rows=(await db.query<ArizonaReportedReceiver>(AZ_REPORTED_RECEIVER_SELECT+" AND l.id=$2::uuid FOR UPDATE OF l,c,ce,e,d,o",[keys,r.linkId])).rows;
  if(links.length!==1 || links[0]!.id!==r.linkId || rows.length!==1 || azCanonical(rows[0])!==azCanonical(r)) azHold("canonical_receiver_changed");
}
export const azNormalizeLabel=(s:string):string=>s.normalize("NFKC").replace(/\s+/g," ").trim().toUpperCase();
const person=(s:string)=>s.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toUpperCase().replace(/[^A-Z0-9]+/g," ").trim().replace(/\s+(?:JR|SR|II|III|IV|V)$/g,"");
export function validateArizonaReportedReceiver(r:ArizonaReportedReceiver,value:any):Readonly<Record<string,any>> {
  azId(r.entityId);
  const p=value?.ReportFilerInfo;
  if(r.electionYear!==2026 || r.electionDate!=="2026-11-03" || !p ||
    !["Candidate","Candidate (participating in Clean Elections)"].includes(p.CommitteeTypeName) ||
    !["Active","Registered"].includes(p.Status) || typeof p.CommitteeName!=="string" || !p.CommitteeName.trim() ||
    typeof p.Candidate!=="string" || typeof p.OfficeName!=="string") azHold("native_receiving_profile");
  for(const name of [r.candidateName,r.fullName]) if(!name || !personNamesMatchWithMiddleEvidence({candidateName:name,rowNames:[p.Candidate],normalizePersonName:person})) azHold("native_receiving_person");
  const district=p.OfficeName.match(/\s*-\s*District\s+(?:No\.\s*)?(\d+)\s*$/i),
    office=normalizeArizonaFinanceOffice({officeScope:r.officeScope,officeName:p.OfficeName.replace(/\s*-\s*District\s+(?:No\.\s*)?\d+\s*$/i,"")});
  const bare=r.canonicalDistrict?.match(/^(?:District\s+)?0*(\d+)$/i),
    named=r.canonicalDistrict?.match(/^State (Senate|House) District (\d+) \(\d+\); Arizona$/i),
    expected=bare?.[1]??(named && named[1]!.toLowerCase()===(r.officeScope==="state_upper"?"senate":"house")?named[2]:undefined);
  if(office?.officeCanonicalName!==r.canonicalOffice ||
    (r.officeScope==="statewide" ? district!==null : !district || !expected || Number(district[1])!==Number(expected))) azHold("native_receiving_office");
  return p;
}
