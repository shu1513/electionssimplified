import type { Pool, PoolClient } from "pg";
import { ALASKA_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./alaskaFinanceEligibleOffices.js";
import type { AlaskaReportedReceiver } from "./alaskaReportedReceiver.js";

export const AK_REPORTED_SELECT = `l.id::text "linkId",l.candidate_id::text "candidateId",l.election_id::text "electionId",
 c.first_name "firstName",c.last_name "lastName",l.election_year "electionYear",e.election_date::text "electionDate",l.candidate_filer_id "receivingId",l.candidate_filer_name "legacyCommitteeName",
 array_remove(ARRAY[trim(c.first_name||' '||c.last_name),c.display_name,l.candidate_name_normalized],NULL) "candidateAliases",
 o.scope "officeScope",o.canonical_name "officeName",l.office_name "linkOfficeName",l.district,
 d.name "canonicalDistrictName",d.district_type "canonicalDistrictType",
 (SELECT count(DISTINCT owner.candidate_id)::int FROM public.ak_candidate_finance_links owner
  WHERE owner.candidate_filer_id=l.candidate_filer_id AND owner.link_status='active') "activeCandidateOwnerCount"`;
export const AK_REPORTED_FROM = `FROM public.ak_candidate_finance_links l
 JOIN public.candidates c ON c.id=l.candidate_id
 JOIN public.candidate_elections ce ON ce.candidate_id=l.candidate_id AND ce.election_id=l.election_id
 JOIN public.elections e ON e.id=l.election_id JOIN public.districts d ON d.id=e.district_id
 JOIN public.offices o ON o.id=e.office_id`;
export const AK_REPORTED_WHERE = `l.link_status='active' AND c.deleted_at IS NULL AND ce.status<>'withdrawn'
 AND d.state='AK' AND e.race_type='office' AND e.election_stage='general'
 AND l.election_year=extract(year from e.election_date)::int AND (o.scope||'::'||o.canonical_name)=ANY($1::text[])
 AND NOT EXISTS (SELECT 1 FROM public.ak_candidate_finance_links sibling WHERE sibling.link_status='active'
 AND sibling.id<>l.id AND sibling.candidate_id=l.candidate_id AND sibling.election_id=l.election_id)`;
// Native acquisition qualifies State House seats only (akCanonicalHouseDistrict);
// other legacy offices would take attempt slots and hold on every run.
export const AK_REPORTED_OFFICES = ALASKA_FINANCE_ELIGIBLE_OFFICE_KEYS.filter(
  (key) => key === "state_lower::State Lower Chamber Legislator",
);
export async function loadAlaskaReportedReceiver(
  db: Pick<Pool | PoolClient, "query">,
  linkId: string,
  lock = false,
): Promise<AlaskaReportedReceiver | null> {
  const result = await db.query<AlaskaReportedReceiver>(
    `SELECT ${AK_REPORTED_SELECT} ${AK_REPORTED_FROM}
    WHERE ${AK_REPORTED_WHERE} AND l.id=$2::uuid ${lock ? "FOR UPDATE OF l,c,ce,e,d,o" : ""}`,
    [AK_REPORTED_OFFICES, linkId],
  );
  if (result.rows.length !== 1) return null;
  if (lock) {
    // Include inactive siblings while locking: an existing link cannot be
    // activated concurrently and silently make the receiver nonexclusive.
    const owners = await db.query<{
      candidate_id: string;
      link_status: string;
    }>(
      `SELECT candidate_id::text,link_status FROM public.ak_candidate_finance_links
      WHERE candidate_filer_id=$1 OR (candidate_id=$2::uuid AND election_id=$3::uuid) ORDER BY id FOR UPDATE`,
      [
        result.rows[0]!.receivingId,
        result.rows[0]!.candidateId,
        result.rows[0]!.electionId,
      ],
    );
    if (
      new Set(
        owners.rows
          .filter((r) => r.link_status === "active")
          .map((r) => r.candidate_id),
      ).size !== 1
    )
      return null;
  }
  return result.rows[0]!;
}
