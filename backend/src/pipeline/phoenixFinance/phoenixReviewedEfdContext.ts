import type { Pool, PoolClient } from "pg";
import { isDeepStrictEqual } from "node:util";
import { efdCheck } from "./phoenixReviewedEfd.js";
import { isPhoenixCityFinanceEligibleElection, parsePhoenixCityCouncilDistrictNumber } from "./phoenixFinanceEligibleOffices.js";

export type PhoenixEfdContext = {
  candidateId: string; electionId: string; candidateName: string; electionDate: string;
  electionYear: number; officeName: string; officeScope: string; districtNumber: number;
  state: string; districtType: string; geoidCompact: string; officialBallotTitle: string;
};
export async function loadPhoenixEfdContext(db: Pick<Pool | PoolClient, "query">,
  candidateId: string, electionId: string, lock = false): Promise<PhoenixEfdContext> {
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
  efdCheck(uuid.test(candidateId) && uuid.test(electionId), "canonical_identity");
  const result = await db.query<{
    candidate_name: string; election_date: string; office_name: string; office_scope: string;
    state: string; district_type: string; geoid_compact: string; official_ballot_title: string;
  }>(`SELECT coalesce(nullif(trim(c.display_name),''),trim(c.first_name||' '||c.last_name)) candidate_name,
      e.election_date::text, o.canonical_name office_name,o.scope office_scope,
      d.state,d.district_type,d.geoid_compact,e.official_ballot_title
    FROM public.candidates c JOIN public.candidate_elections ce ON ce.candidate_id=c.id
    JOIN public.elections e ON e.id=ce.election_id JOIN public.districts d ON d.id=e.district_id
    JOIN public.offices o ON o.id=e.office_id
    WHERE c.id=$1::uuid AND e.id=$2::uuid AND c.deleted_at IS NULL AND ce.status<>'withdrawn'
      AND e.race_type='office' AND e.election_stage='general'
    ${lock ? "FOR SHARE OF c,ce,e,d,o" : ""}`, [candidateId, electionId]);
  efdCheck(result.rows.length === 1, "canonical_context_not_unique");
  const row = result.rows[0]!;
  const districtNumber = parsePhoenixCityCouncilDistrictNumber(row.official_ballot_title);
  efdCheck(row.election_date === "2026-11-03" && districtNumber !== null &&
    row.office_name === "City Council Member" && isPhoenixCityFinanceEligibleElection({
      state: row.state, districtType: row.district_type, geoidCompact: row.geoid_compact,
      officeScope: row.office_scope, officeCanonicalName: row.office_name, officialBallotTitle: row.official_ballot_title,
    }), "canonical_council_contest");
  return { candidateId: candidateId.toLowerCase(), electionId: electionId.toLowerCase(),
    candidateName: row.candidate_name, electionDate: row.election_date, electionYear: 2026,
    officeName: row.office_name, officeScope: row.office_scope, districtNumber,
    state: row.state, districtType: row.district_type, geoidCompact: row.geoid_compact,
    officialBallotTitle: row.official_ballot_title };
}
export const phoenixEfdContextMatches = (a: PhoenixEfdContext, b: PhoenixEfdContext): boolean => isDeepStrictEqual(a, b);
