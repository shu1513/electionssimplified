import type { Pool, PoolClient } from "pg";

import {
  normalizeIllinoisCandidateNameForStorage,
  searchAndResolveIllinoisCandidateCommittee,
  type IllinoisCandidateCommitteeResolution,
} from "./illinoisCandidateCommitteeResolver.js";
import { ILLINOIS_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./illinoisFinanceEligibleOffices.js";
import {
  replaceIllinoisAutoLinkedFinanceLinks,
  type IllinoisFinanceLinkInput,
} from "./illinoisFinanceWriter.js";
import type { IllinoisSbeClientOptions } from "./illinoisSbeClient.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type IllinoisFinanceAutoLinkCandidateElection = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district: string | null;
};

export type IllinoisFinanceAutoLinkResult =
  | {
      candidateId: string;
      electionId: string;
      status: IllinoisCandidateCommitteeResolution["status"] | "linked";
      committeeKey?: string;
      committeeKeys?: string[];
      reason?: string;
    }
  | {
      candidateId: string;
      electionId: string;
      status: "error";
      reason: "auto_link_failed";
      error: string;
    };

export type IllinoisCandidateCommitteeResolver = (
  input: {
    candidateName: string;
    officeScope: string;
    officeName: string;
    electionYear: number;
    district?: string | null;
  },
  options?: IllinoisSbeClientOptions
) => Promise<IllinoisCandidateCommitteeResolution>;

type CandidateElectionQueryRow = {
  candidate_id: string;
  election_id: string;
  candidate_name: string;
  election_year: number;
  office_scope: string;
  office_name: string;
  district: string | null;
};

function mapCandidateElectionRow(row: CandidateElectionQueryRow): IllinoisFinanceAutoLinkCandidateElection {
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

export async function listIllinoisCandidateElectionsMissingFinanceLinks(
  db: Queryable,
  input: {
    now: Date;
    maxCandidates: number;
    electionLookbackDays: number;
    electionLookaheadDays: number;
  }
): Promise<IllinoisFinanceAutoLinkCandidateElection[]> {
  const result = await db.query<CandidateElectionQueryRow>(
    `
      SELECT
        candidate.id::text AS candidate_id,
        election.id::text AS election_id,
        COALESCE(
          NULLIF(trim(candidate.display_name), ''),
          NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')
        ) AS candidate_name,
        extract(year from election.election_date)::int AS election_year,
        office.scope AS office_scope,
        COALESCE(NULLIF(trim(office.canonical_name), ''), election.official_ballot_title) AS office_name,
        CASE
          WHEN district.district_type IN ('state_upper', 'state_lower') THEN
            NULLIF(
              regexp_replace(
                substring(district.geoid_compact from char_length(district.state_fips) + 1),
                '^0+',
                ''
              ),
              ''
            )
          WHEN district.district_type = 'place' THEN district.name
          ELSE NULL
        END AS district
      FROM public.candidate_elections AS candidate_election
      JOIN public.candidates AS candidate
        ON candidate.id = candidate_election.candidate_id
      JOIN public.elections AS election
        ON election.id = candidate_election.election_id
      JOIN public.districts AS district
        ON district.id = election.district_id
      LEFT JOIN public.offices AS office
        ON office.id = election.office_id
      WHERE candidate.deleted_at IS NULL
        AND district.state = 'IL'
        AND election.race_type = 'office'
        AND election.election_date >= ($1::date - make_interval(days => $3::int))
        AND election.election_date <= ($1::date + make_interval(days => $4::int))
        AND candidate_election.status NOT IN ('withdrawn', 'lost')
        AND (office.scope || '::' || office.canonical_name) = ANY($5::text[])
        AND COALESCE(NULLIF(trim(candidate.display_name), ''), NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.il_candidate_finance_links AS link
          WHERE link.candidate_id = candidate.id
            AND link.election_id = election.id
            AND link.link_status = 'active'
        )
      -- Upcoming races first, then random: unmatched candidates never get a
      -- link, so a stable order under a row cap retried the same prefix every
      -- run and starved the tail (Katie Hobbs was never attempted).
      ORDER BY (election.election_date < CURRENT_DATE) ASC, random()
      LIMIT $2::int
    `,
    [
      input.now.toISOString(),
      input.maxCandidates,
      input.electionLookbackDays,
      input.electionLookaheadDays,
      [...ILLINOIS_FINANCE_ELIGIBLE_OFFICE_KEYS],
    ]
  );

  return result.rows.map(mapCandidateElectionRow);
}

export async function autoLinkIllinoisCandidateFinanceForCandidateElection(input: {
  db: Queryable;
  candidateElection: IllinoisFinanceAutoLinkCandidateElection;
  now: Date;
  resolveCandidateCommittee?: IllinoisCandidateCommitteeResolver;
  sbeClientOptions?: IllinoisSbeClientOptions;
}): Promise<IllinoisFinanceAutoLinkResult> {
  const resolveCandidateCommittee = input.resolveCandidateCommittee ?? searchAndResolveIllinoisCandidateCommittee;
  const resolution = await resolveCandidateCommittee(
    {
      candidateName: input.candidateElection.candidateName,
      officeScope: input.candidateElection.officeScope,
      officeName: input.candidateElection.officeName,
      electionYear: input.candidateElection.electionYear,
      district: input.candidateElection.district,
    },
    input.sbeClientOptions
  );

  if (resolution.status !== "matched") {
    return {
      candidateId: input.candidateElection.candidateId,
      electionId: input.candidateElection.electionId,
      status: resolution.status,
      reason: resolution.reason,
    };
  }

  const links: IllinoisFinanceLinkInput[] = resolution.matches.map((match) => ({
    candidateId: input.candidateElection.candidateId,
    electionId: input.candidateElection.electionId,
    electionYear: input.candidateElection.electionYear,
    candidateNameNormalized: normalizeIllinoisCandidateNameForStorage(input.candidateElection.candidateName),
    officeName: input.candidateElection.officeName,
    district: match.district ?? input.candidateElection.district,
    sbeCandidateId: match.sbeCandidateId,
    sbeDistrictType: match.sbeDistrictType,
    sbeOffice: match.sbeOffice,
    isAtLarge: match.isAtLarge,
    committeeKey: match.committeeKey,
    committeeName: match.committeeName,
    linkStatus: "active",
    linkSource: "illinois_sbe",
    sourceUrl: match.sourceUrl,
    lastVerifiedAt: input.now,
  }));
  const committeeKeys = resolution.matches.map((match) => match.committeeKey);
  await replaceIllinoisAutoLinkedFinanceLinks({
    db: input.db,
    links,
    verifiedAt: input.now,
  });

  return {
    candidateId: input.candidateElection.candidateId,
    electionId: input.candidateElection.electionId,
    status: "linked",
    committeeKey: committeeKeys[0],
    committeeKeys,
  };
}

export async function autoLinkMissingIllinoisCandidateFinanceLinks(input: {
  db: Queryable;
  now: Date;
  maxCandidates: number;
  electionLookbackDays: number;
  electionLookaheadDays: number;
  candidateElections?: readonly IllinoisFinanceAutoLinkCandidateElection[];
  resolveCandidateCommittee?: IllinoisCandidateCommitteeResolver;
  sbeClientOptions?: IllinoisSbeClientOptions;
}): Promise<IllinoisFinanceAutoLinkResult[]> {
  const candidates =
    input.candidateElections ??
    (await listIllinoisCandidateElectionsMissingFinanceLinks(input.db, {
      now: input.now,
      maxCandidates: input.maxCandidates,
      electionLookbackDays: input.electionLookbackDays,
      electionLookaheadDays: input.electionLookaheadDays,
    }));

  const results: IllinoisFinanceAutoLinkResult[] = [];
  for (const candidateElection of candidates) {
    try {
      results.push(
        await autoLinkIllinoisCandidateFinanceForCandidateElection({
          db: input.db,
          candidateElection,
          now: input.now,
          resolveCandidateCommittee: input.resolveCandidateCommittee,
          sbeClientOptions: input.sbeClientOptions,
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("Illinois finance auto-link failed for candidate election; continuing:", {
        candidateId: candidateElection.candidateId,
        electionId: candidateElection.electionId,
        electionYear: candidateElection.electionYear,
        error: message,
      });
      results.push({
        candidateId: candidateElection.candidateId,
        electionId: candidateElection.electionId,
        status: "error",
        reason: "auto_link_failed",
        error: message,
      });
    }
  }
  return results;
}
