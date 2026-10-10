import type { Pool, PoolClient } from "pg";

import {
  normalizeWashingtonCandidateNameKeys,
  searchAndResolveWashingtonCandidateCommittee,
  type WashingtonCandidateCommitteeResolution,
} from "./washingtonCandidateCommitteeResolver.js";
import {
  normalizeWashingtonPdcJurisdiction,
  normalizeWashingtonPdcLegislativeDistrict,
  parseWashingtonPositionFromBallotTitle,
  WASHINGTON_FINANCE_ELIGIBLE_OFFICE_KEYS,
} from "./washingtonFinanceEligibleOffices.js";
import { upsertWashingtonFinanceLink } from "./washingtonFinanceWriter.js";
import type { WashingtonPdcClientOptions } from "./washingtonPdcClient.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type WashingtonFinanceAutoLinkCandidateElection = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  legislativeDistrict: string | null;
  // Place-scope resolution inputs: the city from the district name and the
  // seat parsed from the ballot title. Both null for state-level offices.
  jurisdiction: string | null;
  position: string | null;
};

export type WashingtonFinanceAutoLinkResult =
  | {
      candidateId: string;
      electionId: string;
      status: WashingtonCandidateCommitteeResolution["status"] | "linked";
      filerId?: string;
      committeeId?: string;
      reason?: string;
    }
  | {
      candidateId: string;
      electionId: string;
      status: "error";
      reason: "auto_link_failed";
      error: string;
    };

type CandidateElectionQueryRow = {
  candidate_id: string;
  election_id: string;
  candidate_name: string;
  election_year: number;
  office_scope: string;
  office_name: string;
  legislative_district: string | null;
  district_name: string | null;
  ballot_title: string | null;
};

export type WashingtonCandidateCommitteeResolver = (
  input: {
    candidateName: string;
    officeScope: string;
    officeName: string;
    electionYear: number;
    legislativeDistrict?: string | null;
    jurisdiction?: string | null;
    position?: string | null;
  },
  options?: WashingtonPdcClientOptions
) => Promise<WashingtonCandidateCommitteeResolution>;

function normalizeCandidateNameForStorage(value: string): string {
  const keys = normalizeWashingtonCandidateNameKeys(value);
  return [...keys][0] ?? value.trim().replace(/\s+/g, " ").toUpperCase();
}

function mapCandidateElectionRow(row: CandidateElectionQueryRow): WashingtonFinanceAutoLinkCandidateElection {
  const isPlaceScope = row.office_scope === "place";
  return {
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    legislativeDistrict: normalizeWashingtonPdcLegislativeDistrict(row.legislative_district),
    jurisdiction: isPlaceScope ? normalizeWashingtonPdcJurisdiction(row.district_name) : null,
    position: isPlaceScope ? parseWashingtonPositionFromBallotTitle(row.ballot_title) : null,
  };
}

export async function listWashingtonCandidateElectionsMissingFinanceLinks(
  db: Queryable,
  input: {
    now: Date;
    maxCandidates: number;
    electionLookbackDays: number;
    electionLookaheadDays: number;
  }
): Promise<WashingtonFinanceAutoLinkCandidateElection[]> {
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
          ELSE NULL
        END AS legislative_district,
        district.name AS district_name,
        election.official_ballot_title AS ballot_title
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
        AND district.state = 'WA'
        AND election.race_type = 'office'
        AND election.election_date >= ($1::date - make_interval(days => $3::int))
        AND election.election_date <= ($1::date + make_interval(days => $4::int))
        AND candidate_election.status NOT IN ('withdrawn', 'lost')
        AND (office.scope || '::' || office.canonical_name) = ANY($5::text[])
        AND COALESCE(NULLIF(trim(candidate.display_name), ''), NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.wa_candidate_finance_links AS link
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
      [...WASHINGTON_FINANCE_ELIGIBLE_OFFICE_KEYS],
    ]
  );

  return result.rows.map(mapCandidateElectionRow);
}

export async function autoLinkWashingtonCandidateFinanceForCandidateElection(input: {
  db: Queryable;
  candidateElection: WashingtonFinanceAutoLinkCandidateElection;
  now: Date;
  resolveCandidateCommittee?: WashingtonCandidateCommitteeResolver;
  pdcClientOptions?: WashingtonPdcClientOptions;
}): Promise<WashingtonFinanceAutoLinkResult> {
  const resolveCandidateCommittee = input.resolveCandidateCommittee ?? searchAndResolveWashingtonCandidateCommittee;
  const resolution = await resolveCandidateCommittee(
    {
      candidateName: input.candidateElection.candidateName,
      officeScope: input.candidateElection.officeScope,
      officeName: input.candidateElection.officeName,
      electionYear: input.candidateElection.electionYear,
      legislativeDistrict: input.candidateElection.legislativeDistrict,
      jurisdiction: input.candidateElection.jurisdiction,
      position: input.candidateElection.position,
    },
    input.pdcClientOptions
  );

  if (resolution.status !== "matched") {
    return {
      candidateId: input.candidateElection.candidateId,
      electionId: input.candidateElection.electionId,
      status: resolution.status,
      reason: resolution.reason,
    };
  }

  await upsertWashingtonFinanceLink({
    db: input.db,
    link: {
      candidateId: input.candidateElection.candidateId,
      electionId: input.candidateElection.electionId,
      electionYear: input.candidateElection.electionYear,
      candidateNameNormalized: normalizeCandidateNameForStorage(input.candidateElection.candidateName),
      officeName: input.candidateElection.officeName,
      // Legislative offices store the LD number; place offices store the
      // normalized city so the link row stays self-describing.
      district: input.candidateElection.legislativeDistrict ?? input.candidateElection.jurisdiction,
      filerId: resolution.filerId,
      committeeId: resolution.committeeId,
      committeeName: resolution.committeeName,
      candidacyId: resolution.candidacyId ?? null,
      linkStatus: "active",
      linkSource: "pdc_api",
      sourceUrl: resolution.sourceUrl,
      lastVerifiedAt: input.now,
    },
  });

  return {
    candidateId: input.candidateElection.candidateId,
    electionId: input.candidateElection.electionId,
    status: "linked",
    filerId: resolution.filerId,
    committeeId: resolution.committeeId,
  };
}

export async function autoLinkMissingWashingtonCandidateFinanceLinks(input: {
  db: Queryable;
  now: Date;
  maxCandidates: number;
  electionLookbackDays: number;
  electionLookaheadDays: number;
  candidateElections?: readonly WashingtonFinanceAutoLinkCandidateElection[];
  resolveCandidateCommittee?: WashingtonCandidateCommitteeResolver;
  pdcClientOptions?: WashingtonPdcClientOptions;
}): Promise<WashingtonFinanceAutoLinkResult[]> {
  const candidates =
    input.candidateElections ??
    (await listWashingtonCandidateElectionsMissingFinanceLinks(input.db, {
      now: input.now,
      maxCandidates: input.maxCandidates,
      electionLookbackDays: input.electionLookbackDays,
      electionLookaheadDays: input.electionLookaheadDays,
    }));

  const results: WashingtonFinanceAutoLinkResult[] = [];
  for (const candidateElection of candidates) {
    try {
      results.push(
        await autoLinkWashingtonCandidateFinanceForCandidateElection({
          db: input.db,
          candidateElection,
          now: input.now,
          resolveCandidateCommittee: input.resolveCandidateCommittee,
          pdcClientOptions: input.pdcClientOptions,
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("Washington finance auto-link failed for candidate election; continuing:", {
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
