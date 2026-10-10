import type { Pool, PoolClient } from "pg";

import {
  normalizeOregonCandidateNameForStorage,
  resolveOregonCandidateCommitteeFromSearchRows,
  type OregonCandidateCommitteeSearchRow,
  type OregonCandidateCommitteeResolver,
} from "./oregonCandidateCommitteeResolver.js";
import { OREGON_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./oregonFinanceEligibleOffices.js";
import { upsertOregonFinanceLink } from "./oregonFinanceWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type OregonFinanceAutoLinkCandidateElection = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeName: string;
  officeScope: string;
  district: string | null;
};

export type OregonCandidateSearchRowsLoader = (
  candidateElection: OregonFinanceAutoLinkCandidateElection
) => Promise<readonly OregonCandidateCommitteeSearchRow[]> | readonly OregonCandidateCommitteeSearchRow[];

export type OregonFinanceAutoLinkResult =
  | {
      candidateId: string;
      electionId: string;
      status: "linked";
      committeeId: string;
      committeeName: string;
      linkId: string;
    }
  | {
      candidateId: string;
      electionId: string;
      status: "skipped";
      reason: string;
    };

type OregonMissingFinanceLinkQueryRow = {
  candidate_id: string;
  election_id: string;
  candidate_name: string;
  election_year: number;
  office_scope: string;
  office_name: string;
  district: string | null;
};

function mapCandidateElection(row: OregonMissingFinanceLinkQueryRow): OregonFinanceAutoLinkCandidateElection {
  return {
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    district: row.district,
  };
}

export async function listOregonCandidateElectionsMissingFinanceLinks(
  db: Queryable,
  input: {
    now: Date;
    maxCandidates: number;
    electionLookbackDays: number;
    electionLookaheadDays: number;
  }
): Promise<OregonFinanceAutoLinkCandidateElection[]> {
  const result = await db.query<OregonMissingFinanceLinkQueryRow>(
    `
      SELECT
        candidate.id::text AS candidate_id,
        election.id::text AS election_id,
        COALESCE(
          NULLIF(trim(candidate.display_name), ''),
          NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')
        ) AS candidate_name,
        EXTRACT(YEAR FROM election.election_date)::int AS election_year,
        office.scope AS office_scope,
        office.canonical_name AS office_name,
        district.name AS district
      FROM public.candidate_elections AS candidate_election
      JOIN public.candidates AS candidate
        ON candidate.id = candidate_election.candidate_id
      JOIN public.elections AS election
        ON election.id = candidate_election.election_id
      JOIN public.districts AS district
        ON district.id = election.district_id
      LEFT JOIN public.offices AS office
        ON office.id = election.office_id
      LEFT JOIN public.or_candidate_finance_links AS link
        ON link.candidate_id = candidate.id
       AND link.election_id = election.id
       AND link.link_status = 'active'
      WHERE link.id IS NULL
        AND candidate.deleted_at IS NULL
        AND district.state = 'OR'
        AND election.race_type = 'office'
        AND election.election_date >= ($1::date - make_interval(days => $2::int))
        AND election.election_date <= ($1::date + make_interval(days => $3::int))
        AND candidate_election.status NOT IN ('withdrawn', 'lost')
        AND (office.scope || '::' || office.canonical_name) = ANY($4::text[])
      -- Upcoming races first, then random: unmatched candidates never get a
      -- link, so a stable order under a row cap retried the same prefix every
      -- run and starved the tail (Katie Hobbs was never attempted).
      ORDER BY (election.election_date < CURRENT_DATE) ASC, random()
      LIMIT $5::int
    `,
    [
      input.now.toISOString(),
      input.electionLookbackDays,
      input.electionLookaheadDays,
      [...OREGON_FINANCE_ELIGIBLE_OFFICE_KEYS],
      input.maxCandidates,
    ]
  );
  return result.rows.map(mapCandidateElection);
}

export async function autoLinkMissingOregonCandidateFinanceLinks(input: {
  db: Queryable;
  now: Date;
  candidateElections: readonly OregonFinanceAutoLinkCandidateElection[];
  resolveCandidateCommittee?: OregonCandidateCommitteeResolver;
  loadCandidateSearchRows?: OregonCandidateSearchRowsLoader;
}): Promise<OregonFinanceAutoLinkResult[]> {
  const resolveCandidateCommittee =
    input.resolveCandidateCommittee ?? resolveOregonCandidateCommitteeFromSearchRows;
  const results: OregonFinanceAutoLinkResult[] = [];
  for (const candidateElection of input.candidateElections) {
    if (!input.loadCandidateSearchRows && !input.resolveCandidateCommittee) {
      results.push({
        candidateId: candidateElection.candidateId,
        electionId: candidateElection.electionId,
        status: "skipped",
        reason: "Oregon auto-link search rows were not provided",
      });
      continue;
    }
    const searchRows = input.loadCandidateSearchRows
      ? await input.loadCandidateSearchRows(candidateElection)
      : [];
    const resolution = await resolveCandidateCommittee({
      candidateName: candidateElection.candidateName,
      searchRows,
      electionYear: candidateElection.electionYear,
      officeName: candidateElection.officeName,
      officeScope: candidateElection.officeScope,
      district: candidateElection.district,
    });
    if (resolution.status !== "matched") {
      results.push({
        candidateId: candidateElection.candidateId,
        electionId: candidateElection.electionId,
        status: "skipped",
        reason: resolution.reason,
      });
      continue;
    }

    const { linkId } = await upsertOregonFinanceLink({
      db: input.db,
      link: {
        candidateId: candidateElection.candidateId,
        electionId: candidateElection.electionId,
        electionYear: candidateElection.electionYear,
        candidateNameNormalized: normalizeOregonCandidateNameForStorage(candidateElection.candidateName),
        officeName: candidateElection.officeName,
        district: candidateElection.district,
        committeeId: resolution.committeeId,
        committeeName: resolution.committeeName,
        linkStatus: "active",
        linkSource: "orestar",
        sourceUrl: resolution.sourceUrl,
        lastVerifiedAt: input.now,
      },
    });
    results.push({
      candidateId: candidateElection.candidateId,
      electionId: candidateElection.electionId,
      status: "linked",
      committeeId: resolution.committeeId,
      committeeName: resolution.committeeName,
      linkId,
    });
  }
  return results;
}
