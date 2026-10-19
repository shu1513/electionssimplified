import type { Pool, PoolClient } from "pg";
import { OKLAHOMA_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./oklahomaFinanceEligibleOffices.js";
import { okCanonical,okHold } from "./oklahomaReportedCore.js";
export type OklahomaReportedReceiver = {
  linkId: string; candidateId: string; electionId: string; electionYear: number; electionDate: string;
  candidateName: string; fullName: string; officeScope: string; canonicalOffice: string; canonicalDistrict: string | null;
  entityId: string; committeeName: string; linkSource: string; linkOffice: string; linkDistrict: string | null;
};
export const OK_REPORTED_RECEIVER_SELECT = `SELECT l.id::text "linkId",l.candidate_id::text "candidateId",l.election_id::text "electionId",
  l.election_year "electionYear",e.election_date::text "electionDate",
  COALESCE(NULLIF(trim(c.display_name),''),NULLIF(trim(c.first_name||' '||c.last_name),'')) "candidateName",
  trim(c.first_name||' '||c.last_name) "fullName",o.scope "officeScope",o.canonical_name "canonicalOffice",
  CASE WHEN o.scope='statewide' THEN NULL WHEN d.district_type IN ('state_lower','state_upper') THEN
    NULLIF(regexp_replace(substring(d.geoid_compact from char_length(d.state_fips)+1),'^0+',''),'') END "canonicalDistrict",
  l.committee_id "entityId",l.committee_name "committeeName",l.link_source "linkSource",l.office_name "linkOffice",l.district "linkDistrict"
  FROM public.ok_candidate_finance_links l JOIN public.candidates c ON c.id=l.candidate_id
  JOIN public.candidate_elections ce ON ce.candidate_id=c.id AND ce.election_id=l.election_id
  JOIN public.elections e ON e.id=ce.election_id JOIN public.districts d ON d.id=e.district_id JOIN public.offices o ON o.id=e.office_id
  WHERE l.link_status='active' AND c.deleted_at IS NULL AND ce.status NOT IN ('withdrawn','lost')
    AND (SELECT count(*) FROM public.ok_candidate_finance_links a WHERE a.candidate_id=l.candidate_id AND a.election_id=l.election_id AND a.link_status='active')=1
    AND NOT EXISTS (SELECT 1 FROM public.ok_candidate_finance_links s WHERE s.id<>l.id AND s.committee_id=l.committee_id AND s.election_year=l.election_year AND s.link_status='active')
    -- The IE form prints name and office together, without a district. Hold
    -- homonyms in that office/year even when the other candidate is unlinked.
    AND NOT EXISTS (SELECT 1 FROM public.candidates c2
      JOIN public.candidate_elections ce2 ON ce2.candidate_id=c2.id
      JOIN public.elections e2 ON e2.id=ce2.election_id JOIN public.districts d2 ON d2.id=e2.district_id
      WHERE c2.id<>c.id AND c2.deleted_at IS NULL
      AND d2.state='OK' AND e2.office_id=e.office_id AND extract(year from e2.election_date) BETWEEN 2025 AND 2026
      AND (upper(trim(c2.display_name))=upper(trim(c.display_name)) OR
        (upper(split_part(trim(c2.first_name),' ',1))=upper(split_part(trim(c.first_name),' ',1)) AND upper(trim(c2.last_name))=upper(trim(c.last_name)))))
    AND d.state='OK' AND e.race_type='office' AND e.election_stage='general' AND l.election_year=2026 AND e.election_date='2026-11-03'::date
    AND (o.scope||'::'||o.canonical_name)=ANY($1::text[])`;
export const okReportedOfficeKeys = [...OKLAHOMA_FINANCE_ELIGIBLE_OFFICE_KEYS];
export async function listOklahomaReportedReceivers(db: Pick<Pool, "query">): Promise<OklahomaReportedReceiver[]> {
  const rows = (await db.query<OklahomaReportedReceiver>(OK_REPORTED_RECEIVER_SELECT + " ORDER BY l.candidate_name_normalized,l.id", [okReportedOfficeKeys])).rows;
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.entityId, (counts.get(r.entityId) ?? 0) + 1);
  return rows.filter(r => counts.get(r.entityId) === 1);
}
export async function lockOklahomaReportedReceiver(db: PoolClient, receiver: OklahomaReportedReceiver): Promise<void> {
  const links = (await db.query(`SELECT id::text FROM public.ok_candidate_finance_links WHERE candidate_id=$1::uuid AND election_id=$2::uuid AND link_status='active' ORDER BY id FOR UPDATE`, [receiver.candidateId, receiver.electionId])).rows;
  const rows = (await db.query<OklahomaReportedReceiver>(OK_REPORTED_RECEIVER_SELECT + " AND l.candidate_id=$2::uuid AND l.election_id=$3::uuid FOR UPDATE OF l,c,ce,e,d,o", [okReportedOfficeKeys, receiver.candidateId, receiver.electionId])).rows;
  if (links.length !== 1 || links[0]!.id !== receiver.linkId || rows.length !== 1 || okCanonical(rows[0]) !== okCanonical(receiver)) okHold("canonical_receiver_changed");
  if (!(await listOklahomaReportedReceivers(db)).some(r => okCanonical(r) === okCanonical(receiver))) okHold("canonical_receiving_identity_ambiguous");
}

