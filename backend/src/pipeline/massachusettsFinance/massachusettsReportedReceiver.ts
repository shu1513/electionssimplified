import type { Pool, PoolClient } from "pg";
import { MASSACHUSETTS_FINANCE_ELIGIBLE_OFFICE_KEYS, normalizeMassachusettsOcpfDistrict } from "./massachusettsFinanceEligibleOffices.js";
import { resolveMassachusettsCandidateCommittee } from "./massachusettsCandidateCommitteeResolver.js";
import { maCanonical, maHold } from "./massachusettsReportedCore.js";
import { maId } from "./massachusettsReportedNative.js";

export type MassachusettsReportedReceiver = {
  linkId: string; candidateId: string; electionId: string; electionYear: number; electionDate: string;
  candidateName: string; fullName: string; officeScope: string; canonicalOffice: string; canonicalDistrict: string | null;
  entityId: string; committeeName: string; linkSource: string; linkOffice: string; linkDistrict: string | null;
};
export const MA_REPORTED_RECEIVER_SELECT = `SELECT l.id::text "linkId",l.candidate_id::text "candidateId",l.election_id::text "electionId",
 l.election_year "electionYear",e.election_date::text "electionDate",
 COALESCE(NULLIF(trim(c.display_name),''),NULLIF(trim(c.first_name||' '||c.last_name),'')) "candidateName",
 trim(c.first_name||' '||c.last_name) "fullName",o.scope "officeScope",o.canonical_name "canonicalOffice",
 CASE WHEN d.district_type IN ('state_lower','state_upper') THEN NULLIF(trim(d.name),'') END "canonicalDistrict",
 l.candidate_cpf_id "entityId",l.committee_name "committeeName",l.link_source "linkSource",l.office_name "linkOffice",l.district "linkDistrict"
 FROM public.ma_candidate_finance_links l JOIN public.candidates c ON c.id=l.candidate_id
 JOIN public.candidate_elections ce ON ce.candidate_id=c.id AND ce.election_id=l.election_id
 JOIN public.elections e ON e.id=ce.election_id JOIN public.districts d ON d.id=e.district_id JOIN public.offices o ON o.id=e.office_id
 WHERE l.link_status='active' AND c.deleted_at IS NULL AND ce.status<>'withdrawn'
 AND (ce.status<>'lost' OR e.election_date<(now() AT TIME ZONE 'UTC')::date)
 AND (SELECT count(*) FROM public.ma_candidate_finance_links a WHERE a.candidate_id=l.candidate_id AND a.election_id=l.election_id AND a.link_status='active')=1
 AND NOT EXISTS(SELECT 1 FROM public.ma_candidate_finance_links a WHERE a.id<>l.id AND a.candidate_cpf_id=l.candidate_cpf_id AND a.election_year=l.election_year AND a.link_status='active')
 AND d.state='MA' AND e.race_type='office' AND e.election_stage='general' AND l.election_year=2026 AND e.election_date='2026-11-03'::date
 AND (o.scope||'::'||o.canonical_name)=ANY($1::text[])`;
const keys = [...MASSACHUSETTS_FINANCE_ELIGIBLE_OFFICE_KEYS];
export async function listMassachusettsReportedReceivers(db: Pick<Pool | PoolClient, "query">): Promise<MassachusettsReportedReceiver[]> {
  return (await db.query<MassachusettsReportedReceiver>(MA_REPORTED_RECEIVER_SELECT + " ORDER BY l.candidate_name_normalized,l.id", [keys])).rows;
}
export async function lockMassachusettsReportedReceiver(db: PoolClient, receiver: MassachusettsReportedReceiver): Promise<void> {
  const links = (await db.query(`SELECT id::text FROM public.ma_candidate_finance_links WHERE candidate_id=$1::uuid AND election_id=$2::uuid AND link_status='active' ORDER BY id FOR UPDATE`, [receiver.candidateId, receiver.electionId])).rows;
  const rows = (await db.query<MassachusettsReportedReceiver>(MA_REPORTED_RECEIVER_SELECT + " AND l.id=$2::uuid FOR UPDATE OF l,c,ce,e,d,o", [keys, receiver.linkId])).rows;
  if (links.length !== 1 || links[0]!.id !== receiver.linkId || rows.length !== 1 || maCanonical(rows[0]) !== maCanonical(receiver)) maHold("canonical_receiver_changed");
}
/** Resolve the native candidate person and office/seat using the existing
 * middle-evidence veto. A receiving CPF is not inferred from a donor name. */
export function validateMassachusettsReportedReceiver(receiver: MassachusettsReportedReceiver, registry: any[], profile: any): void {
  if (receiver.electionYear !== 2026 || receiver.electionDate !== "2026-11-03" ||
    String(maId(profile?.cpfId)) !== receiver.entityId || profile.isCandidate !== true ||
    typeof profile.candidate?.fullName !== "string") maHold("native_receiving_profile");
  const filers = registry.map(r => ({ ...r, cpfId: String(r.cpfId) }));
  const input = { candidateName: receiver.candidateName, officeScope: receiver.officeScope,
    officeName: receiver.canonicalOffice, electionYear: 2026, district: normalizeMassachusettsOcpfDistrict(receiver.canonicalDistrict) };
  for (const name of [receiver.candidateName, receiver.fullName]) {
    if (!name) maHold("canonical_person");
    const match = resolveMassachusettsCandidateCommittee({ ...input, candidateName: name, filers });
    if (match.status !== "matched" || match.candidateCpfId !== receiver.entityId) maHold("native_receiving_registry");
  }
  const offices = [profile.officeSought?.officeDistrict, profile.officeSoughtDescription];
  if (offices.some(x => typeof x !== "string" || !x.trim())) maHold("native_profile_office");
  for (const office of offices) {
    const match = resolveMassachusettsCandidateCommittee({ ...input, filers: [{ cpfId: receiver.entityId,
      filerName: profile.candidate.fullName, filerNameReverse: profile.candidate.fullNameReverse,
      officeSought: office, isCandidate: true, isActive: profile.isActive }] });
    if (match.status !== "matched" || match.candidateCpfId !== receiver.entityId) maHold("native_profile_person_office");
  }
}
