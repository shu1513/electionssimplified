import type { Pool, PoolClient } from "pg";
import { normalizeOhioCandidateNameForStorage, resolveOhioCandidateCommittee } from "./ohioCandidateCommitteeResolver.js";
import { OHIO_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./ohioFinanceEligibleOffices.js";
import { ohioCommitteeHold } from "./ohioCommitteeReceipts.js";
import type { OhioSosCandidateCommitteeListRow } from "./ohioSosBulkFiles.js";

export type OhioCommitteeReceiver = {
  link_id: string; candidate_id: string; election_id: string; election_year: number; committee_id: string; link_source: string;
  link_candidate_name: string; link_committee_name: string; link_district: string | null; link_office_name: string;
  candidate_name: string; full_name: string; office_scope: string; office_name: string; district: string | null; election_date: string;
};
export const OH_COMMITTEE_CONTEXT_SELECT = `l.id::text link_id,l.candidate_id::text,l.election_id::text,l.election_year,l.committee_id,l.link_source,
  l.candidate_name_normalized link_candidate_name,l.committee_name link_committee_name,l.district link_district,l.office_name link_office_name,
  COALESCE(NULLIF(trim(c.display_name),''),trim(c.first_name||' '||c.last_name)) candidate_name,
  trim(c.first_name||' '||c.last_name) full_name,o.scope office_scope,o.canonical_name office_name,
  CASE WHEN d.district_type IN ('state_upper','state_lower') THEN
    NULLIF(regexp_replace(substring(d.geoid_compact from char_length(d.state_fips)+1),'^0+',''),'') END district,e.election_date::text`;
export const OH_COMMITTEE_CONTEXT_FROM = `FROM public.oh_candidate_finance_links l JOIN public.candidates c ON c.id=l.candidate_id
  JOIN public.candidate_elections ce ON ce.candidate_id=l.candidate_id AND ce.election_id=l.election_id
  JOIN public.elections e ON e.id=l.election_id JOIN public.districts d ON d.id=e.district_id JOIN public.offices o ON o.id=e.office_id`;
export const OH_COMMITTEE_CONTEXT_WHERE = `l.link_status='active' AND c.deleted_at IS NULL AND ce.status NOT IN ('lost','withdrawn')
  AND d.state='OH' AND e.race_type='office' AND e.election_stage='general'
  AND extract(year from e.election_date)::int=l.election_year AND (o.scope||'::'||o.canonical_name)=ANY($1::text[])`;
export async function loadOhioCommitteeReceiver(db: Pick<Pool | PoolClient, "query">, linkId: string, lock = false): Promise<OhioCommitteeReceiver | null> {
  const result = await db.query<OhioCommitteeReceiver>(`SELECT ${OH_COMMITTEE_CONTEXT_SELECT} ${OH_COMMITTEE_CONTEXT_FROM}
    WHERE ${OH_COMMITTEE_CONTEXT_WHERE} AND l.id=$2::uuid ${lock ? "FOR UPDATE OF c,ce,e,d,o,l" : ""}`, [[...OHIO_FINANCE_ELIGIBLE_OFFICE_KEYS],linkId]);
  if (result.rows.length !== 1) return null; const row = result.rows[0]!;
  const siblings = await db.query<{ link_status: string }>(`SELECT id::text,link_status FROM public.oh_candidate_finance_links
    WHERE candidate_id=$1::uuid AND election_id=$2::uuid ORDER BY id ${lock ? "FOR UPDATE" : ""}`,[row.candidate_id,row.election_id]);
  return siblings.rows.filter(r => r.link_status === "active").length === 1 ? row : null;
}
/** Require both preferred and underlying person evidence against the complete
 * current native roster. A display alias cannot hide conflicting middles. */
export function qualifyOhioCommitteeReceiver(r: OhioCommitteeReceiver, cycleYear: number, rows: readonly OhioSosCandidateCommitteeListRow[]) {
  if (cycleYear !== r.election_year || r.link_office_name !== r.office_name || r.link_district !== r.district ||
    r.link_candidate_name !== normalizeOhioCandidateNameForStorage(r.candidate_name || r.full_name)) ohioCommitteeHold("receiving_context_mismatch");
  for (const name of new Set([r.candidate_name,r.full_name].filter(Boolean))) {
    const resolved = resolveOhioCandidateCommittee({ candidateName:name,officeScope:r.office_scope,officeName:r.office_name,
      district:r.district,electionYear:r.election_year,candidateListRows:rows });
    if (resolved.status !== "matched" || resolved.committeeId !== r.committee_id || resolved.committeeName !== r.link_committee_name)
      ohioCommitteeHold("canonical_person_committee_mismatch");
  }
  if (!r.full_name?.trim()) ohioCommitteeHold("canonical_person_unavailable");
}
