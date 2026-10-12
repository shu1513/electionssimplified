import type { Pool, PoolClient } from "pg";
import { isFloridaFinanceEligibleOffice } from "./floridaFinanceEligibleOffices.js";

export type FloridaLocalFinanceContext = {
  candidateId: string;
  candidateElectionId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  electionDate: string;
  officeScope: string;
  officeCanonicalName: string;
  district: string | null;
  committeeId: string;
  genericRecipientName: string;
};
type Row = {
  candidate_id: string; candidate_election_id: string; election_id: string;
  candidate_name: string; candidate_status: string; election_date: string;
  election_stage: string; race_type: string; state: string;
  office_scope: string; office_canonical_name: string;
  district_type: string; geoid_compact: string;
  committee_id: string; committee_name: string; election_year: number;
};
type Result = { status: "resolved"; context: FloridaLocalFinanceContext }
  | { status: "preserve"; reason: string };

/** Source scope comes from the actual local race, never the stored link's
 * office/district label. A caller can recheck the same context under a lock.
 */
export async function loadFloridaLocalFinanceContext(input: {
  db: Pick<Pool | PoolClient, "query">;
  candidateId: string;
  electionId: string;
  committeeId: string;
  lock?: boolean;
}): Promise<Result> {
  const result = await input.db.query<Row>(`
    SELECT candidate.id::text AS candidate_id,
      candidate_election.id::text AS candidate_election_id,
      election.id::text AS election_id,
      COALESCE(NULLIF(trim(candidate.display_name), ''),
        NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')) AS candidate_name,
      candidate_election.status AS candidate_status,
      election.election_date::text AS election_date, election.election_stage,
      election.race_type, district.state, office.scope AS office_scope,
      office.canonical_name AS office_canonical_name, district.district_type,
      district.geoid_compact, link.committee_id, link.committee_name, link.election_year
    FROM public.fl_candidate_finance_links link
    JOIN public.candidates candidate ON candidate.id = link.candidate_id AND candidate.deleted_at IS NULL
    JOIN public.candidate_elections candidate_election
      ON candidate_election.candidate_id = link.candidate_id
      AND candidate_election.election_id = link.election_id
    JOIN public.elections election ON election.id = link.election_id
    JOIN public.districts district ON district.id = election.district_id
    JOIN public.offices office ON office.id = election.office_id
    WHERE link.candidate_id = $1::uuid AND link.election_id = $2::uuid
      AND link.committee_id = $3 AND link.link_status = 'active'
    ${input.lock ? "FOR SHARE OF candidate, candidate_election, election, district, office, link" : ""}
  `, [input.candidateId, input.electionId, input.committeeId]);
  if (result.rows.length !== 1) return { status: "preserve", reason: "Florida local candidate/link ownership is not unique" };
  const row = result.rows[0]!;
  if (row.candidate_id !== input.candidateId || row.election_id !== input.electionId
      || row.committee_id !== input.committeeId || !row.candidate_name?.trim()
      || !row.committee_name?.trim() || !row.candidate_election_id
      || row.state !== "FL" || row.race_type !== "office"
      || row.election_stage !== "general" || row.election_date !== "2026-11-03"
      || row.election_year !== 2026 || ["withdrawn", "lost"].includes(row.candidate_status)
      || !isFloridaFinanceEligibleOffice({ officeScope: row.office_scope, officeCanonicalName: row.office_canonical_name }))
    return { status: "preserve", reason: "Florida local race is outside the verified current General source scope" };
  let district: string | null = null;
  if (row.office_scope === "state_lower" || row.office_scope === "state_upper") {
    const match = /^12(\d{3})$/.exec(row.geoid_compact);
    const seat = match ? Number(match[1]) : 0;
    const maximum = row.office_scope === "state_lower" ? 120 : 40;
    if (row.district_type !== row.office_scope || seat < 1 || seat > maximum)
      return { status: "preserve", reason: "Florida local legislative district is not verified" };
    district = String(seat);
  } else if (row.office_scope !== "statewide" || row.district_type !== "statewide" || row.geoid_compact !== "12") {
    return { status: "preserve", reason: "Florida local statewide district is not verified" };
  }
  return { status: "resolved", context: {
    candidateId: row.candidate_id, candidateElectionId: row.candidate_election_id,
    electionId: row.election_id, candidateName: row.candidate_name.trim(),
    electionYear: row.election_year, electionDate: row.election_date,
    officeScope: row.office_scope, officeCanonicalName: row.office_canonical_name,
    district, committeeId: row.committee_id, genericRecipientName: row.committee_name,
  } };
}
