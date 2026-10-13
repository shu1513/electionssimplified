import type { Pool, PoolClient } from "pg";
import {
  getVermontElectionLookup,
  getVermontOfficeSoughtLookup,
  resolveVermontElectionLookup,
  type VermontCampaignFinanceClientOptions,
  type VermontElectionLookupItem,
} from "./vermontCampaignFinanceClient.js";
import { toVermontOfficeSearchInput } from "./vermontFinanceEligibleOffices.js";

export type VermontCommitteeCashContext = {
  linkId: string;
  candidateId: string;
  electionId: string;
  electionYear: number;
  candidateName: string;
  receivingFilerName: string;
  filerRegistrationGuid: string;
  entityId: number;
  officeId: number;
  officeName: string;
  electionDate: string;
  electionType: "general" | "primary";
  sourceElectionId: number;
  sourceElection: VermontElectionLookupItem;
};

/** A local link is a receiving-account hint; native rows/PDFs must separately bind it. */
export async function loadVermontCommitteeCashContext(input: {
  db: Pick<Pool | PoolClient, "query">;
  candidateId: string;
  electionId: string;
  clientOptions?: VermontCampaignFinanceClientOptions;
}): Promise<VermontCommitteeCashContext> {
  const result = await input.db.query<{
    link_id: string; candidate_name: string; election_year: number;
    filer_registration_guid: string; entity_id: number | null; filer_name: string;
    link_office_name: string; office_scope: string; office_name: string;
    election_date: string; election_stage: string; district_type: string; geoid_compact: string;
  }>(`
    SELECT link.id::text AS link_id,
      COALESCE(NULLIF(trim(candidate.display_name), ''),
        NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')) AS candidate_name,
      link.election_year, link.filer_registration_guid, link.entity_id, link.filer_name,
      link.office_name AS link_office_name, office.scope AS office_scope,
      office.canonical_name AS office_name, election.election_date::text AS election_date,
      election.election_stage,district.district_type,district.geoid_compact
    FROM public.vt_candidate_finance_links link
    JOIN public.candidates candidate ON candidate.id=link.candidate_id
    JOIN public.candidate_elections ce ON ce.candidate_id=link.candidate_id AND ce.election_id=link.election_id
    JOIN public.elections election ON election.id=link.election_id
    JOIN public.offices office ON office.id=election.office_id
    JOIN public.districts district ON district.id=election.district_id
    WHERE link.candidate_id=$1::uuid AND link.election_id=$2::uuid
      AND link.link_status='active' AND candidate.deleted_at IS NULL AND candidate.merged_into_candidate_id IS NULL
      AND district.state='VT' AND election.race_type='office'
      AND ce.status='declared'
    ORDER BY link.id
  `, [input.candidateId, input.electionId]);
  if (result.rows.length !== 1) throw new Error("Vermont cash needs one active canonical receiving account");
  const row = result.rows[0]!;
  const office = toVermontOfficeSearchInput({ officeScope: row.office_scope, officeCanonicalName: row.office_name });
  if (row.office_scope !== "statewide" || row.district_type !== "statewide" || row.geoid_compact !== "50" || !office || row.link_office_name !== row.office_name ||
      !Number.isSafeInteger(row.entity_id) || row.entity_id! <= 0 ||
      !row.filer_registration_guid?.trim() || !row.filer_name?.trim() || !row.candidate_name?.trim() ||
      !Number.isInteger(row.election_year) || row.election_year !== Number(row.election_date.slice(0, 4)) ||
      (row.election_stage !== "general" && row.election_stage !== "primary")) {
    throw new Error("Vermont cash receiving account has unsupported or conflicting canonical context");
  }
  if (row.election_stage === "general") {
    const owners = await input.db.query(`
      SELECT link.id FROM public.vt_candidate_finance_links link
      JOIN public.candidates candidate ON candidate.id=link.candidate_id
        AND candidate.deleted_at IS NULL AND candidate.merged_into_candidate_id IS NULL
      JOIN public.candidate_elections ce ON ce.candidate_id=link.candidate_id
        AND ce.election_id=link.election_id AND ce.status='declared'
      JOIN public.elections election ON election.id=link.election_id
        AND election.race_type='office' AND election.election_stage='general'
      JOIN public.districts district ON district.id=election.district_id AND district.state='VT'
      WHERE link.link_status='active' AND lower(link.filer_registration_guid)=lower($1)
        AND link.election_year=$2 AND link.id<>$3::uuid
        AND extract(year FROM election.election_date)=link.election_year
    `,[row.filer_registration_guid,row.election_year,row.link_id]);
    if (owners.rows.length) throw new Error("Vermont cash receiving account has competing General owners");
  }
  const [elections, offices] = await Promise.all([
    getVermontElectionLookup(input.clientOptions), getVermontOfficeSoughtLookup(input.clientOptions),
  ]);
  const sourceElection = resolveVermontElectionLookup(elections, { electionDate: row.election_date, electionType: row.election_stage });
  const nativeOffice = offices.filter((entry) => entry.officeId === office.officeId);
  if (nativeOffice.length !== 1 || nativeOffice[0]!.name !== office.officeName) {
    throw new Error("Vermont cash office conflicts with the current public lookup");
  }
  return {
    linkId: row.link_id, candidateId: input.candidateId, electionId: input.electionId,
    electionYear: row.election_year, candidateName: row.candidate_name,
    receivingFilerName: row.filer_name, filerRegistrationGuid: row.filer_registration_guid,
    entityId: row.entity_id!, officeId: office.officeId, officeName: office.officeName,
    electionDate: row.election_date, electionType: row.election_stage,
    sourceElectionId: sourceElection.electionId, sourceElection,
  };
}
