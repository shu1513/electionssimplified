import type {Pool,PoolClient} from "pg";
import type {MarylandOutsideReceivingContextInput} from "./marylandOutsideReceivingContext.js";

type Scope={candidateId:string;electionId:string;electionYear:number;committeeId:string};
type Context=MarylandOutsideReceivingContextInput["canonical"];
const uuid=(value:unknown)=>typeof value==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)&&
  value!=="00000000-0000-0000-0000-000000000000";

/** Re-read the actual canonical receiving link for this due row. The source
 * binder separately checks official membership, account and cycle semantics;
 * the writer checks this exact active link again inside its transaction. */
export async function loadMarylandCommitteeMonetaryContext(db:Pick<Pool|PoolClient,"query">,scope:Scope):Promise<Context|null> {
  const retained={...scope};
  if(!uuid(retained.candidateId)||!uuid(retained.electionId)||!Number.isInteger(retained.electionYear)||
    retained.electionYear<2000||retained.electionYear>2100||typeof retained.committeeId!=="string"||
    !/^[1-9]\d*$/.test(retained.committeeId)||!Number.isSafeInteger(Number(retained.committeeId)))
    throw new Error("invalid_maryland_committee_context");
  const result=await db.query<Context>(`SELECT
    l.id::text AS "linkId",l.candidate_id::text AS "candidateId",l.election_id::text AS "electionId",
    l.election_year AS "electionYear",l.committee_id AS "committeeId",l.committee_name AS "committeeName",
    c.display_name AS "candidateName",c.party,c.deleted_at IS NOT NULL AS "candidateDeleted",
    c.merged_into_candidate_id IS NOT NULL AS "candidateMerged",ce.status='declared' AS declared,
    l.link_status='active' AS "linkActive",e.election_date::text AS "electionDate",e.election_stage AS "electionStage",
    d.state,d.id::text AS "districtId",d.canonical_district_id::text AS "canonicalDistrictId",
    d.district_type AS "districtType",d.geoid_compact AS "districtGeoidCompact",o.scope AS "officeScope",o.canonical_name AS "officeName",
    (SELECT count(*)::int FROM public.md_candidate_finance_links a
      WHERE a.candidate_id=l.candidate_id AND a.election_id=l.election_id AND a.link_status='active') AS "activeReceivingLinkCount"
    FROM public.md_candidate_finance_links l JOIN public.candidates c ON c.id=l.candidate_id
    JOIN public.candidate_elections ce ON ce.candidate_id=l.candidate_id AND ce.election_id=l.election_id
    JOIN public.elections e ON e.id=l.election_id JOIN public.districts d ON d.id=e.district_id
    JOIN public.offices o ON o.id=e.office_id
    WHERE l.candidate_id=$1::uuid AND l.election_id=$2::uuid AND l.election_year=$3
      AND l.committee_id=$4 AND l.link_status='active' AND d.state='MD'`,
    [retained.candidateId,retained.electionId,retained.electionYear,retained.committeeId]);
  if(result.rows.length!==1)return null;
  return Object.freeze({...result.rows[0]!});
}
