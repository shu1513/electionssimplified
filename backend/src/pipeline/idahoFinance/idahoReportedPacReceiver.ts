import type { Pool, PoolClient } from "pg";
import { idahoCandidateNameMatchConfidence, idahoRegistrationDistrictLabelForRace, resolveIdahoCandidateFiler } from "./idahoCandidateFilerResolver.js";
import { normalizeIdahoRegistrationGuid, type IdahoCandidateRegistrationRow } from "./idahoCfsClient.js";
import { IDAHO_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./idahoFinanceEligibleOffices.js";
import { normalizeIdahoCandidateNameForStorage } from "./idahoFinanceWriter.js";
import { idPacHold, type IdahoPacScope } from "./idahoReportedPacSource.js";

export type IdahoPacReceiver = {
  link_id: string; candidate_id: string; election_id: string; election_year: number; registration_guid: string; link_source: string;
  link_candidate_name: string; link_filer_name: string; link_district: string | null; link_office_name: string;
  candidate_name: string; full_name: string; office_scope: string; office_name: string; district_name: string;
  legislative_district: number | null; ballot_title: string | null; election_date: string;
};
export const idahoPacScope = (r: IdahoPacReceiver): IdahoPacScope => ({ registrationGuid: r.registration_guid, electionYear: r.election_year });
export const ID_PAC_CONTEXT_SELECT = `l.id::text link_id,l.candidate_id::text,l.election_id::text,l.election_year,l.registration_guid,l.link_source,
  l.candidate_name_normalized link_candidate_name,l.filer_name link_filer_name,l.district link_district,l.office_name link_office_name,
  COALESCE(NULLIF(trim(c.display_name),''),trim(c.first_name||' '||c.last_name)) candidate_name,
  trim(c.first_name||' '||c.last_name) full_name,o.scope office_scope,o.canonical_name office_name,d.name district_name,
  CASE WHEN d.district_type IN ('state_upper','state_lower') THEN
    NULLIF(regexp_replace(substring(d.geoid_compact from char_length(d.state_fips)+1),'^0+',''),'')::int END legislative_district,
  e.official_ballot_title ballot_title,e.election_date::text`;
export const ID_PAC_CONTEXT_FROM = `FROM public.id_candidate_finance_links l JOIN public.candidates c ON c.id=l.candidate_id
  JOIN public.candidate_elections ce ON ce.candidate_id=l.candidate_id AND ce.election_id=l.election_id
  JOIN public.elections e ON e.id=l.election_id JOIN public.districts d ON d.id=e.district_id JOIN public.offices o ON o.id=e.office_id`;
export const ID_PAC_CONTEXT_WHERE = `l.link_status='active' AND c.deleted_at IS NULL AND ce.status NOT IN ('lost','withdrawn')
  AND d.state='ID' AND e.race_type='office' AND e.election_stage='general'
  AND extract(year from e.election_date)::int=l.election_year AND (o.scope||'::'||o.canonical_name)=ANY($1::text[])`;
export async function loadIdahoPacReceiver(db: Pick<Pool | PoolClient, "query">, linkId: string, lock = false): Promise<IdahoPacReceiver | null> {
  const result = await db.query<IdahoPacReceiver>(`SELECT ${ID_PAC_CONTEXT_SELECT} ${ID_PAC_CONTEXT_FROM}
    WHERE ${ID_PAC_CONTEXT_WHERE} AND l.id=$2::uuid ${lock ? "FOR UPDATE OF c,ce,e,d,o,l" : ""}`, [[...IDAHO_FINANCE_ELIGIBLE_OFFICE_KEYS], linkId]);
  const row = result.rows[0]; if (!row || result.rows.length !== 1) return null;
  const siblings = await db.query<{ link_status: string }>(`SELECT id::text,link_status FROM public.id_candidate_finance_links
    WHERE candidate_id=$1::uuid AND election_id=$2::uuid ORDER BY id ${lock ? "FOR UPDATE" : ""}`, [row.candidate_id, row.election_id]);
  return siblings.rows.filter(s => s.link_status === "active").length === 1 ? row : null;
}

/** Reuse native office/district/seat and person evidence. Existing operator
 * links keep their reviewed alias decision only while both stored names and
 * the canonical context still agree; current native identity remains required. */
export function qualifyIdahoPacReceiver(r: IdahoPacReceiver, scope: IdahoPacScope, registration: IdahoCandidateRegistrationRow,
  registrations: readonly IdahoCandidateRegistrationRow[] = [registration]): void {
  if (scope.registrationGuid !== r.registration_guid || scope.electionYear !== r.election_year ||
    normalizeIdahoRegistrationGuid(registration.registrationGuid) !== r.registration_guid || registration.electionYear !== r.election_year ||
    registration.status !== "Active" || registration.isLegacyRecord || r.link_office_name !== r.office_name) idPacHold("receiving_context_mismatch");
  const context = { candidateNames: [r.candidate_name || r.full_name], officeScope: r.office_scope, officeName: r.office_name,
    district: r.district_name, legislativeDistrict: r.legislative_district, ballotTitle: r.ballot_title, electionYear: r.election_year };
  const district = idahoRegistrationDistrictLabelForRace(registration, context);
  if (district === undefined || district !== r.link_district) idPacHold("canonical_office_district_mismatch");
  const resolved = resolveIdahoCandidateFiler({ ...context, registrations });
  if (resolved.status === "matched" && normalizeIdahoRegistrationGuid(resolved.match.registrationGuid) === r.registration_guid) return;
  const reviewedNames = r.link_source === "manual" && r.link_candidate_name === normalizeIdahoCandidateNameForStorage(r.candidate_name || r.full_name) &&
    (r.link_filer_name === registration.filerName || idahoCandidateNameMatchConfidence([r.link_filer_name], [registration.filerName]) !== null);
  if (!reviewedNames) idPacHold("canonical_person_registration_mismatch");
}
