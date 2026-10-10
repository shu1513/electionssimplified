import type { Pool, PoolClient } from "pg";

import {
  normalizeDistrictOfColumbiaCandidateNameKeys,
  searchAndResolveDistrictOfColumbiaCandidateCommittee,
  type DistrictOfColumbiaCandidateCommitteeResolution,
} from "./districtOfColumbiaCandidateCommitteeResolver.js";
import {
  DISTRICT_OF_COLUMBIA_FINANCE_ELIGIBLE_OFFICE_KEYS,
  normalizeDistrictOfColumbiaOcfSeat,
} from "./districtOfColumbiaFinanceEligibleOffices.js";
import { upsertDistrictOfColumbiaFinanceLink } from "./districtOfColumbiaFinanceWriter.js";
import type { DistrictOfColumbiaOcfClientOptions } from "./districtOfColumbiaOcfClient.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type DistrictOfColumbiaFinanceAutoLinkCandidateElection = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  seat: string | null;
};

export type DistrictOfColumbiaFinanceAutoLinkResult =
  | {
      candidateId: string;
      electionId: string;
      status: DistrictOfColumbiaCandidateCommitteeResolution["status"] | "linked";
      committeeKey?: string;
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
  seat_text: string | null;
};

export type DistrictOfColumbiaCandidateCommitteeResolver = (
  input: {
    candidateName: string;
    officeScope: string;
    officeName: string;
    electionYear: number;
    seat?: string | null;
  },
  options?: DistrictOfColumbiaOcfClientOptions
) => Promise<DistrictOfColumbiaCandidateCommitteeResolution>;

function normalizeCandidateNameForStorage(value: string): string {
  const keys = normalizeDistrictOfColumbiaCandidateNameKeys(value);
  return [...keys][0] ?? value.trim().replace(/\s+/g, " ").toUpperCase();
}

function mapCandidateElectionRow(row: CandidateElectionQueryRow): DistrictOfColumbiaFinanceAutoLinkCandidateElection {
  return {
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    seat: normalizeDistrictOfColumbiaOcfSeat(row.seat_text),
  };
}

export async function listDistrictOfColumbiaCandidateElectionsMissingFinanceLinks(
  db: Queryable,
  input: {
    now: Date;
    maxCandidates: number;
    electionLookbackDays: number;
    electionLookaheadDays: number;
  }
): Promise<DistrictOfColumbiaFinanceAutoLinkCandidateElection[]> {
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
        concat_ws(' ', election.official_ballot_title, district.name) AS seat_text
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
        AND district.state = 'DC'
        AND election.race_type = 'office'
        AND election.election_date >= ($1::date - make_interval(days => $3::int))
        AND election.election_date <= ($1::date + make_interval(days => $4::int))
        AND candidate_election.status NOT IN ('withdrawn', 'lost')
        AND (office.scope || '::' || office.canonical_name) = ANY($5::text[])
        AND COALESCE(NULLIF(trim(candidate.display_name), ''), NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.dc_candidate_finance_links AS link
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
      [...DISTRICT_OF_COLUMBIA_FINANCE_ELIGIBLE_OFFICE_KEYS],
    ]
  );

  return result.rows.map(mapCandidateElectionRow);
}

export async function autoLinkDistrictOfColumbiaCandidateFinanceForCandidateElection(input: {
  db: Queryable;
  candidateElection: DistrictOfColumbiaFinanceAutoLinkCandidateElection;
  now: Date;
  resolveCandidateCommittee?: DistrictOfColumbiaCandidateCommitteeResolver;
  ocfClientOptions?: DistrictOfColumbiaOcfClientOptions;
}): Promise<DistrictOfColumbiaFinanceAutoLinkResult> {
  const resolveCandidateCommittee =
    input.resolveCandidateCommittee ?? searchAndResolveDistrictOfColumbiaCandidateCommittee;
  const resolution = await resolveCandidateCommittee(
    {
      candidateName: input.candidateElection.candidateName,
      officeScope: input.candidateElection.officeScope,
      officeName: input.candidateElection.officeName,
      electionYear: input.candidateElection.electionYear,
      seat: input.candidateElection.seat,
    },
    input.ocfClientOptions
  );

  if (resolution.status !== "matched") {
    return {
      candidateId: input.candidateElection.candidateId,
      electionId: input.candidateElection.electionId,
      status: resolution.status,
      reason: resolution.reason,
    };
  }

  await upsertDistrictOfColumbiaFinanceLink({
    db: input.db,
    link: {
      candidateId: input.candidateElection.candidateId,
      electionId: input.candidateElection.electionId,
      electionYear: input.candidateElection.electionYear,
      candidateNameNormalized: normalizeCandidateNameForStorage(input.candidateElection.candidateName),
      officeName: input.candidateElection.officeName,
      district: input.candidateElection.seat,
      committeeKey: resolution.committeeKey,
      committeeName: resolution.committeeName,
      linkStatus: "active",
      linkSource: "ocf_export",
      sourceUrl: resolution.sourceUrl,
      lastVerifiedAt: input.now,
    },
  });

  return {
    candidateId: input.candidateElection.candidateId,
    electionId: input.candidateElection.electionId,
    status: "linked",
    committeeKey: resolution.committeeKey,
  };
}

export async function autoLinkMissingDistrictOfColumbiaCandidateFinanceLinks(input: {
  db: Queryable;
  now: Date;
  maxCandidates: number;
  electionLookbackDays: number;
  electionLookaheadDays: number;
  candidateElections?: readonly DistrictOfColumbiaFinanceAutoLinkCandidateElection[];
  resolveCandidateCommittee?: DistrictOfColumbiaCandidateCommitteeResolver;
  ocfClientOptions?: DistrictOfColumbiaOcfClientOptions;
}): Promise<DistrictOfColumbiaFinanceAutoLinkResult[]> {
  const candidates =
    input.candidateElections ??
    (await listDistrictOfColumbiaCandidateElectionsMissingFinanceLinks(input.db, {
      now: input.now,
      maxCandidates: input.maxCandidates,
      electionLookbackDays: input.electionLookbackDays,
      electionLookaheadDays: input.electionLookaheadDays,
    }));

  const results: DistrictOfColumbiaFinanceAutoLinkResult[] = [];
  for (const candidateElection of candidates) {
    try {
      results.push(
        await autoLinkDistrictOfColumbiaCandidateFinanceForCandidateElection({
          db: input.db,
          candidateElection,
          now: input.now,
          resolveCandidateCommittee: input.resolveCandidateCommittee,
          ocfClientOptions: input.ocfClientOptions,
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("D.C. finance auto-link failed for candidate election; continuing:", {
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
