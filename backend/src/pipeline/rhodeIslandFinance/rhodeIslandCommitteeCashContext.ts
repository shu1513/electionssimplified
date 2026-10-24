import type { Pool, PoolClient } from "pg";
import { RHODE_ISLAND_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./rhodeIslandFinanceEligibleOffices.js";

export type RhodeIslandCanonicalCashContext = {
  candidate_name: string; last_name: string; election_year: number; office_scope: string;
  office_name: string; district: string | null; district_type: string; geoid_compact: string;
};
/** Same supported canonical context at selection and inside the write lock. */
export async function loadRhodeIslandCanonicalCashContext(
  db: Pick<Pool | PoolClient, "query">, candidateId: string, electionId: string, lock = false,
): Promise<RhodeIslandCanonicalCashContext | null> {
  const current = await db.query<RhodeIslandCanonicalCashContext>(`
    SELECT COALESCE(NULLIF(trim(candidate.display_name),''),trim(candidate.first_name||' '||candidate.last_name)) candidate_name,
      candidate.last_name,extract(year FROM election.election_date)::integer election_year,
      office.scope office_scope,office.canonical_name office_name,district.district_type,district.geoid_compact,
      CASE WHEN district.district_type IN ('state_upper','state_lower') THEN
        NULLIF(regexp_replace(substring(district.geoid_compact FROM char_length(district.state_fips)+1),'^0+',''),'') END district
    FROM public.candidates candidate JOIN public.candidate_elections roster ON roster.candidate_id=candidate.id
    JOIN public.elections election ON election.id=roster.election_id JOIN public.districts district ON district.id=election.district_id
    JOIN public.offices office ON office.id=election.office_id
    WHERE candidate.id=$1::uuid AND election.id=$2::uuid AND candidate.deleted_at IS NULL
      AND roster.status NOT IN ('withdrawn','lost') AND district.state='RI'
      AND election.race_type='office' AND election.election_stage='general'
      AND election.election_date BETWEEN CURRENT_DATE-1 AND CURRENT_DATE+730
      AND (office.scope||'::'||office.canonical_name)=ANY($3::text[])
    ${lock ? "FOR UPDATE OF candidate,roster,election,district,office" : ""}`,
  [candidateId, electionId, [...RHODE_ISLAND_FINANCE_ELIGIBLE_OFFICE_KEYS]]);
  return current.rows.length === 1 ? current.rows[0]! : null;
}
