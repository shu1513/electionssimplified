import type { Pool, PoolClient } from "pg";
import { NEW_MEXICO_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./newMexicoFinanceEligibleOffices.js";
import type { NewMexicoReportedReceiver } from "./newMexicoReportedReceiver.js";

export const NM_REPORTED_SELECT = `l.id::text "linkId",l.candidate_id::text "candidateId",l.election_id::text "electionId",
 l.election_year "electionYear",e.election_date::text "electionDate",l.committee_id "receivingId",l.committee_name "legacyCommitteeName",
 array_remove(ARRAY[trim(c.first_name||' '||c.last_name),c.display_name,l.candidate_name_normalized],NULL) "candidateAliases",
 o.scope "officeScope",o.canonical_name "officeName",l.office_name "linkOfficeName",l.district,
 d.name "canonicalDistrictName",d.district_type "canonicalDistrictType",
 (SELECT count(DISTINCT owner.candidate_id)::int FROM public.nm_candidate_finance_links owner
  WHERE owner.committee_id=l.committee_id AND owner.link_status='active') "activeCandidateOwnerCount"`;
export const NM_REPORTED_FROM = `FROM public.nm_candidate_finance_links l
 JOIN public.candidates c ON c.id=l.candidate_id
 JOIN public.candidate_elections ce ON ce.candidate_id=l.candidate_id AND ce.election_id=l.election_id
 JOIN public.elections e ON e.id=l.election_id JOIN public.districts d ON d.id=e.district_id
 JOIN public.offices o ON o.id=e.office_id`;
export const NM_REPORTED_WHERE = `l.link_status='active' AND c.deleted_at IS NULL AND ce.status<>'withdrawn'
 AND d.state='NM' AND e.race_type='office' AND e.election_stage='general'
 AND l.election_year=extract(year from e.election_date)::int AND (o.scope||'::'||o.canonical_name)=ANY($1::text[])
 AND NOT EXISTS (SELECT 1 FROM public.nm_candidate_finance_links sibling WHERE sibling.link_status='active'
 AND sibling.id<>l.id AND sibling.candidate_id=l.candidate_id AND sibling.election_id=l.election_id)`;
export const NM_REPORTED_OFFICES = [...NEW_MEXICO_FINANCE_ELIGIBLE_OFFICE_KEYS];
export async function loadNewMexicoReportedReceiver(
  db: Pick<Pool | PoolClient, "query">,
  linkId: string,
  lock = false,
): Promise<NewMexicoReportedReceiver | null> {
  const result = await db.query<NewMexicoReportedReceiver>(
    `SELECT ${NM_REPORTED_SELECT} ${NM_REPORTED_FROM}
    WHERE ${NM_REPORTED_WHERE} AND l.id=$2::uuid ${lock ? "FOR UPDATE OF l,c,ce,e,d,o" : ""}`,
    [NM_REPORTED_OFFICES, linkId],
  );
  if (result.rows.length !== 1) return null;
  if (lock) {
    // Include inactive siblings while locking: an existing link cannot be
    // activated concurrently and silently make the receiver nonexclusive.
    const owners = await db.query<{
      candidate_id: string;
      link_status: string;
    }>(
      `SELECT candidate_id::text,link_status FROM public.nm_candidate_finance_links
      WHERE committee_id=$1 OR (candidate_id=$2::uuid AND election_id=$3::uuid) ORDER BY id FOR UPDATE`,
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
