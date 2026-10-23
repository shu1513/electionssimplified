import type { Pool, PoolClient } from "pg";
import { isDeepStrictEqual } from "node:util";
import { ColoradoReportError } from "./coloradoTracerReports.js";
import {
  COLORADO_IE_STATEWIDE_OFFICES,
  coloradoIeNativeDistrict,
  coloradoIePersonMatches,
  type ColoradoIeCandidateIdentity,
  type ColoradoNativeCandidateProof,
} from "./coloradoNativeCandidateIdentity.js";
export type ColoradoIeReceiver = ColoradoIeCandidateIdentity & {
  linkId: string;
  candidateId: string;
  electionId: string;
  fullName: string;
  linkCandidateName: string;
  linkOffice: string;
  linkSource: string;
};
export const CO_IE_SELECT = `SELECT l.id::text "linkId",l.candidate_id::text "candidateId",l.election_id::text "electionId",
 l.election_year "electionYear",e.election_date::text "electionDate",
 COALESCE(NULLIF(trim(c.display_name),''),NULLIF(trim(c.first_name||' '||c.last_name),'')) "candidateName",
 trim(c.first_name||' '||c.last_name) "fullName",c.party,l.candidate_name_normalized "linkCandidateName",
 o.canonical_name "officeName",l.office_name "linkOffice",l.committee_id "receivingId",l.committee_name "receivingName",
 l.tracer_candidate_id "tracerCandidateId",l.link_source "linkSource",d.name "districtName"
 FROM public.co_candidate_finance_links l JOIN public.candidates c ON c.id=l.candidate_id
 JOIN public.candidate_elections ce ON ce.candidate_id=l.candidate_id AND ce.election_id=l.election_id
 JOIN public.elections e ON e.id=l.election_id JOIN public.districts d ON d.id=e.district_id JOIN public.offices o ON o.id=e.office_id
 WHERE l.link_status='active' AND c.deleted_at IS NULL AND c.merged_into_candidate_id IS NULL AND ce.status<>'withdrawn'
 AND (ce.status<>'lost' OR e.election_date<(now() AT TIME ZONE 'UTC')::date)
 AND d.state='CO' AND ((d.district_type='statewide' AND o.scope='statewide' AND o.canonical_name=ANY($1::text[]))
 OR (d.district_type='state_lower' AND o.scope='state_lower' AND o.canonical_name='State Lower Chamber Legislator')
 OR (d.district_type='state_upper' AND o.scope='state_upper' AND o.canonical_name='State Senator'))
 AND e.race_type='office' AND e.election_stage='general' AND l.election_year=extract(year from e.election_date)::int AND l.election_year>=2026
 AND l.office_name=o.canonical_name AND l.committee_id ~ '^[1-9][0-9]{0,19}$' AND nullif(trim(c.party),'') IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM public.co_candidate_finance_links a WHERE a.link_status='active' AND a.id<>l.id AND a.candidate_id=l.candidate_id AND a.election_id=l.election_id)
 AND NOT EXISTS(SELECT 1 FROM public.co_candidate_finance_links a WHERE a.link_status='active' AND a.committee_id=l.committee_id AND a.candidate_id<>l.candidate_id)`;
function receiverContext(row: ColoradoIeReceiver): ColoradoIeReceiver {
  if (coloradoIeNativeDistrict(row)) return row;
  // Keep existing statewide snapshots byte-for-byte comparable on lock/read.
  const { districtName: ignored, ...statewide } = row;
  void ignored;
  return statewide;
}
export async function listColoradoIeReceivers(
  db: Pick<Pool | PoolClient, "query">,
): Promise<ColoradoIeReceiver[]> {
  const rows = (
    await db.query<ColoradoIeReceiver>(
      CO_IE_SELECT +
        " ORDER BY l.election_year,l.candidate_name_normalized,l.id",
      [[...COLORADO_IE_STATEWIDE_OFFICES]],
    )
  ).rows;
  return rows.flatMap((row) => {
    try {
      return [receiverContext(row)];
    } catch {
      return [];
    }
  });
}
export async function lockColoradoIeReceiver(
  db: PoolClient,
  expected: ColoradoIeReceiver,
): Promise<void> {
  // Link additions as well as edits must wait until the component commits.
  await db.query("LOCK TABLE public.co_candidate_finance_links IN SHARE MODE");
  const rows = (
    await db.query<ColoradoIeReceiver>(
      CO_IE_SELECT + " AND l.id=$2::uuid FOR UPDATE OF l,c,ce,e,d,o",
      [[...COLORADO_IE_STATEWIDE_OFFICES], expected.linkId],
    )
  ).rows;
  if (
    rows.length !== 1 ||
    !isDeepStrictEqual(receiverContext(rows[0]!), expected)
  )
    throw new ColoradoReportError("canonical_ie_context_changed");
}
export function validateColoradoIeReceiverIdentity(
  receiver: ColoradoIeReceiver,
  proof: ColoradoNativeCandidateProof,
): void {
  if (
    ![
      receiver.fullName,
      receiver.linkCandidateName,
      receiver.candidateName,
    ].every((n) => n.trim() && coloradoIePersonMatches(n, proof.candidateName))
  )
    throw new ColoradoReportError("canonical_ie_person_conflict");
}
