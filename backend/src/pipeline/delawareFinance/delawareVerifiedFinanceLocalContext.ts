import type { Pool, PoolClient } from "pg";
import type { DelawareCandidateFinanceDueRow } from "./delawareCandidateFinanceDueList.js";
import { toDelawareCfrsOfficeSearch } from "./delawareFinanceEligibleOffices.js";
import type { DelawareOutsideCandidateScope } from "./delawareThirdPartyOutsideSource.js";

export type DelawareVerifiedFinanceLocalContext = Omit<DelawareOutsideCandidateScope, "receivingMemberId">;
type ContextRow = {
  party: string | null;
  office_scope: string;
  office_name: string;
  district_type: string;
  geoid_compact: string;
  linked_office_name: string;
  linked_district: string | null;
  committee_name: string;
  election_date: string;
};

/** Local roster authority only. The source registry must independently bind MemberID. */
export async function loadDelawareVerifiedFinanceLocalContext(input: {
  db: Pick<Pool | PoolClient, "query">;
  row: DelawareCandidateFinanceDueRow;
}): Promise<DelawareVerifiedFinanceLocalContext> {
  const { row } = input;
  const result = await input.db.query<ContextRow>(`
    SELECT candidate.party, office.scope AS office_scope, office.canonical_name AS office_name,
      district.district_type, district.geoid_compact, link.office_name AS linked_office_name,
      link.district AS linked_district, link.committee_name, election.election_date::text AS election_date
    FROM public.de_candidate_finance_links link
    JOIN public.candidates candidate ON candidate.id = link.candidate_id
    JOIN public.candidate_elections roster ON roster.candidate_id = link.candidate_id
      AND roster.election_id = link.election_id
    JOIN public.elections election ON election.id = link.election_id
    JOIN public.offices office ON office.id = election.office_id
    JOIN public.districts district ON district.id = election.district_id
    WHERE link.candidate_id = $1::uuid AND link.election_id = $2::uuid
      AND link.committee_id = $3::text AND link.election_year = $4::integer
      AND link.link_status = 'active' AND candidate.deleted_at IS NULL
      AND roster.status NOT IN ('withdrawn', 'lost')
      AND district.state = 'DE' AND election.race_type = 'office'
      AND election.election_stage = 'general'`,
  [row.candidateId, row.electionId, row.cfId, row.electionYear]);
  if (result.rows.length !== 1) throw new Error("Delaware verified finance needs one active local roster/link context");
  const local = result.rows[0]!;
  if (!local.party?.trim() || local.office_scope !== row.officeScope ||
    local.linked_office_name !== row.officeName || local.linked_district !== row.district ||
    local.committee_name !== row.committeeName || local.election_date !== row.electionDate ||
    local.election_date.slice(0, 4) !== String(row.electionYear)) {
    throw new Error("Delaware local finance scope changed or lacks party authority");
  }
  let district: string | null = null;
  if (local.office_scope === "statewide") {
    if (local.district_type !== "statewide" || local.geoid_compact !== "10")
      throw new Error("Delaware statewide finance scope has conflicting district authority");
  } else {
    const match = /^10(\d{3})$/.exec(local.geoid_compact);
    const maximum = local.office_scope === "state_lower" ? 41 : local.office_scope === "state_upper" ? 21 : 0;
    const seat = match ? Number(match[1]) : 0;
    if (local.district_type !== local.office_scope || seat < 1 || seat > maximum ||
      !/^(?:District )?0*[1-9]\d*$/.test(local.linked_district ?? "") ||
      Number((local.linked_district ?? "").replace(/^District /, "")) !== seat) {
      throw new Error("Delaware legislative finance scope has conflicting seat authority");
    }
    district = String(seat);
  }
  const sourceOffice = toDelawareCfrsOfficeSearch({
    officeScope: local.office_scope, officeName: local.office_name, district,
  });
  if (!sourceOffice) throw new Error("Unsupported canonical Delaware finance office");
  if (![local.office_name, sourceOffice.officeLabel].includes(local.linked_office_name))
    throw new Error("Delaware linked office conflicts with canonical election office");
  return {
    candidateId: row.candidateId, electionId: row.electionId, electionYear: row.electionYear,
    electionDate: local.election_date, electionStage: "general", candidateName: row.candidateName,
    officeName: sourceOffice.officeLabel, district, party: local.party.trim(),
    receivingCfId: row.cfId, receivingCommitteeName: row.committeeName,
  };
}
