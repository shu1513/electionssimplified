import type { Pool, PoolClient } from "pg";
import { resolveWashingtonCandidateCommittee } from "./washingtonCandidateCommitteeResolver.js";
import { WASHINGTON_FINANCE_ELIGIBLE_OFFICE_KEYS, parseWashingtonPositionFromBallotTitle } from "./washingtonFinanceEligibleOffices.js";
import { waPacHold, type WashingtonPacRow, type WashingtonPacScope } from "./washingtonReportedPacSource.js";
import type { WashingtonPdcCandidateSummary } from "./washingtonPdcClient.js";

export type WashingtonPacReceiver = {
  link_id: string; candidate_id: string; election_id: string; election_year: number;
  filer_id: string; committee_id: string; candidacy_id: string | null; link_source: string;
  candidate_name: string; full_name: string; office_scope: string; office_name: string;
  district: string | null; district_name: string; ballot_title: string | null; election_date: string;
};
export const washingtonPacScope = (r: WashingtonPacReceiver): WashingtonPacScope => ({ electionYear: r.election_year, filerId: r.filer_id, committeeId: r.committee_id });
export const WA_PAC_CONTEXT_SELECT = `l.id::text link_id,l.candidate_id::text,l.election_id::text,l.election_year,
  l.filer_id,l.committee_id,l.candidacy_id,l.link_source,
  COALESCE(NULLIF(trim(c.display_name),''),trim(c.first_name||' '||c.last_name)) candidate_name,
  trim(c.first_name||' '||c.last_name) full_name,o.scope office_scope,o.canonical_name office_name,
  CASE WHEN d.district_type IN ('state_upper','state_lower') THEN
    NULLIF(regexp_replace(substring(d.geoid_compact from char_length(d.state_fips)+1),'^0+',''),'') END district,
  d.name district_name,e.official_ballot_title ballot_title,e.election_date::text`;
export const WA_PAC_CONTEXT_FROM = `FROM public.wa_candidate_finance_links l
  JOIN public.candidates c ON c.id=l.candidate_id
  JOIN public.candidate_elections ce ON ce.candidate_id=l.candidate_id AND ce.election_id=l.election_id
  JOIN public.elections e ON e.id=l.election_id JOIN public.districts d ON d.id=e.district_id
  JOIN public.offices o ON o.id=e.office_id`;
export const WA_PAC_CONTEXT_WHERE = `l.link_status='active' AND c.deleted_at IS NULL
  AND ce.status NOT IN ('lost','withdrawn') AND d.state='WA' AND e.race_type='office'
  AND e.election_stage='general' AND extract(year from e.election_date)::int=l.election_year
  AND (o.scope||'::'||o.canonical_name)=ANY($1::text[])`;

export async function loadWashingtonPacReceiver(db: Pick<Pool | PoolClient, "query">, linkId: string, lock = false): Promise<WashingtonPacReceiver | null> {
  const result = await db.query<WashingtonPacReceiver>(`SELECT ${WA_PAC_CONTEXT_SELECT} ${WA_PAC_CONTEXT_FROM}
    WHERE ${WA_PAC_CONTEXT_WHERE} AND l.id=$2::uuid ${lock ? "FOR UPDATE OF c,ce,e,d,o,l" : ""}`,
  [[...WASHINGTON_FINANCE_ELIGIBLE_OFFICE_KEYS], linkId]);
  const r = result.rows[0]; if (!r || result.rows.length !== 1) return null;
  // Lock inactive siblings too: activating a sibling must not race acceptance.
  const siblings = await db.query<{ id: string; link_status: string }>(`SELECT id::text,link_status FROM public.wa_candidate_finance_links
    WHERE candidate_id=$1::uuid AND election_id=$2::uuid ORDER BY id ${lock ? "FOR UPDATE" : ""}`, [r.candidate_id, r.election_id]);
  if (siblings.rows.filter(s => s.link_status === "active").length !== 1) return null;
  return r;
}

/** Canonical person/office/seat and native registration agree, independently
 * of a stale link name or trusted receiving IDs alone. */
export function qualifyWashingtonPacReceiver(r: WashingtonPacReceiver, scope: WashingtonPacScope, s: WashingtonPacRow): void {
  if (scope.filerId !== r.filer_id || scope.committeeId !== r.committee_id || scope.electionYear !== r.election_year ||
    s.filer_id !== r.filer_id || s.committee_id !== r.committee_id || s.election_year !== String(r.election_year) ||
    s.active_candidate !== true || s.filer_type !== "CA" || s.reporting_option !== "full" || s.has_reports !== true ||
    r.candidacy_id !== null && s.candidacy_id !== r.candidacy_id) waPacHold("receiving_context_mismatch");
  const text = (key: string) => typeof s[key] === "string" ? s[key] as string : undefined;
  const summary: WashingtonPdcCandidateSummary = { filerId: r.filer_id, committeeId: r.committee_id,
    candidacyId: text("candidacy_id"), filerName: text("filer_name") ?? "", activeCandidate: true, hasReports: true,
    electionYear: r.election_year, office: text("office"), legislativeDistrict: text("legislative_district"),
    jurisdiction: text("jurisdiction"), position: text("position"), reportingOption: "full" };
  // Prefer the current display name (including explicit middle/alias evidence).
  // A shorter first+last spelling must not bypass its middle-name conflict.
  const matches = [r.candidate_name || r.full_name].filter(Boolean).some(candidateName => {
    const match = resolveWashingtonCandidateCommittee({ candidateName, officeScope: r.office_scope, officeName: r.office_name,
      electionYear: r.election_year, legislativeDistrict: r.district, jurisdiction: r.district_name,
      position: parseWashingtonPositionFromBallotTitle(r.ballot_title), summaries: [summary] });
    return match.status === "matched" && match.filerId === r.filer_id && match.committeeId === r.committee_id;
  });
  if (!matches) waPacHold("canonical_person_office_mismatch");
}
