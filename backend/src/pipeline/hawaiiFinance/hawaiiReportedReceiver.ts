import type { Pool, PoolClient } from "pg";
import { HAWAII_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./hawaiiFinanceEligibleOffices.js";
import { hiCanonical, hiHold, type HawaiiReportedKind } from "./hawaiiReportedCore.js";
export type HawaiiReportedReceiver = {
  candidateId: string; electionId: string; electionYear: number; electionDate: string;
  candidateName: string; fullName: string; officeScope: string; canonicalOffice: string; canonicalDistrict: string | null;
  linkId: string | null; entityId: string | null; committeeName: string | null; electionPeriod: string | null;
  linkOffice: string | null; linkDistrict: string | null;
};
export function hawaiiReportedReceiverContext(r: HawaiiReportedReceiver, kind: HawaiiReportedKind): string {
  if (kind === "committee") return hiCanonical(r);
  // A direct link may be created or corrected after IE acquisition. Only
  // canonical person/election/seat changes invalidate an IE observation.
  const { candidateId, electionId, electionYear, electionDate, candidateName, fullName, officeScope, canonicalOffice, canonicalDistrict } = r;
  return hiCanonical({ candidateId, electionId, electionYear, electionDate, candidateName, fullName, officeScope, canonicalOffice, canonicalDistrict });
}
// IE starts from canonical candidate elections. Missing, ambiguous or stale
// direct finance links cannot suppress an otherwise qualified IE component.
export const HI_REPORTED_RECEIVER_SELECT = `SELECT c.id::text "candidateId",e.id::text "electionId",2026 "electionYear",e.election_date::text "electionDate",
  COALESCE(NULLIF(trim(c.display_name),''),trim(c.first_name||' '||c.last_name)) "candidateName",trim(c.first_name||' '||c.last_name) "fullName",
  o.scope "officeScope",o.canonical_name "canonicalOffice",
  CASE WHEN o.scope='statewide' THEN NULL WHEN d.district_type IN ('state_lower','state_upper') THEN
    NULLIF(regexp_replace(substring(d.geoid_compact from char_length(d.state_fips)+1),'^0+',''),'') END "canonicalDistrict",
  l.id::text "linkId",l.committee_id "entityId",l.committee_name "committeeName",l.election_period "electionPeriod",
  l.office_name "linkOffice",l.district "linkDistrict"
  FROM public.candidates c JOIN public.candidate_elections ce ON ce.candidate_id=c.id
  JOIN public.elections e ON e.id=ce.election_id JOIN public.districts d ON d.id=e.district_id JOIN public.offices o ON o.id=e.office_id
  LEFT JOIN public.hi_candidate_finance_links l ON l.candidate_id=c.id AND l.election_id=e.id AND l.link_status='active'
    AND (SELECT count(*) FROM public.hi_candidate_finance_links a WHERE a.candidate_id=c.id AND a.election_id=e.id AND a.link_status='active')=1
    AND NOT EXISTS(SELECT 1 FROM public.hi_candidate_finance_links a WHERE a.id<>l.id AND a.committee_id=l.committee_id AND a.election_period=l.election_period AND a.link_status='active')
  WHERE c.deleted_at IS NULL AND ce.status NOT IN ('withdrawn','lost') AND d.state='HI' AND e.race_type='office'
    AND e.election_stage='general' AND e.election_date='2026-11-03'::date AND (o.scope||'::'||o.canonical_name)=ANY($1::text[])`;
export const hiReportedOfficeKeys = [...HAWAII_FINANCE_ELIGIBLE_OFFICE_KEYS];
export async function listHawaiiReportedReceivers(db: Pick<Pool, "query">): Promise<HawaiiReportedReceiver[]> {
  const rows = (await db.query<HawaiiReportedReceiver>(HI_REPORTED_RECEIVER_SELECT + " ORDER BY c.id,e.id", [hiReportedOfficeKeys])).rows;
  const counts = new Map<string, number>();
  for (const r of rows) { const key = `${r.candidateId}:${r.electionId}`; counts.set(key, (counts.get(key) ?? 0) + 1); }
  return rows.filter(r => counts.get(`${r.candidateId}:${r.electionId}`) === 1);
}
export async function lockHawaiiReportedReceiver(db: PoolClient, receiver: HawaiiReportedReceiver, kind: HawaiiReportedKind = "committee"): Promise<void> {
  if (kind === "committee") await db.query("SELECT id FROM public.hi_candidate_finance_links WHERE candidate_id=$1::uuid AND election_id=$2::uuid ORDER BY id FOR UPDATE", [receiver.candidateId, receiver.electionId]);
  const rows = (await db.query<HawaiiReportedReceiver>(HI_REPORTED_RECEIVER_SELECT + " AND c.id=$2::uuid AND e.id=$3::uuid FOR UPDATE OF c,ce,e,d,o", [hiReportedOfficeKeys, receiver.candidateId, receiver.electionId])).rows;
  if (rows.length !== 1 || hawaiiReportedReceiverContext(rows[0]!, kind) !== hawaiiReportedReceiverContext(receiver, kind)) hiHold("canonical_receiver_changed");
}
