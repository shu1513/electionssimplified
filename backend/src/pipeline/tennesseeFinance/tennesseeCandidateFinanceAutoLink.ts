import type { Pool, PoolClient } from "pg";

import {
  searchAndResolveTennesseeCandidateCommittee,
  normalizeTennesseeCandidateNameKeys,
  type TennesseeCandidateCommitteeResolution,
} from "./tennesseeCandidateCommitteeResolver.js";
import type { TennesseeCampClientOptions } from "./tennesseeCampClient.js";
import { TENNESSEE_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./tennesseeFinanceEligibleOffices.js";
import { upsertTennesseeFinanceLink } from "./tennesseeFinanceWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type TennesseeFinanceAutoLinkCandidateElection = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district: string | null;
};

export type TennesseeFinanceAutoLinkResult =
  | {
      candidateId: string;
      electionId: string;
      status: TennesseeCandidateCommitteeResolution["status"] | "linked";
      campCandidateId?: string;
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
  district: string | null;
};

export type TennesseeCandidateCommitteeResolver = (
  input: {
    candidateName: string;
    officeScope: string;
    officeName: string;
    electionYear: number;
    district?: string | null;
  },
  options?: TennesseeCampClientOptions
) => Promise<TennesseeCandidateCommitteeResolution>;

function normalizeCandidateNameForStorage(value: string): string {
  const keys = normalizeTennesseeCandidateNameKeys(value);
  return [...keys][0] ?? value.trim().replace(/\s+/g, " ").toUpperCase();
}

function normalizeDistrict(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function mapCandidateElectionRow(row: CandidateElectionQueryRow): TennesseeFinanceAutoLinkCandidateElection {
  return {
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    district: normalizeDistrict(row.district),
  };
}

export async function listTennesseeCandidateElectionsMissingFinanceLinks(
  db: Queryable,
  input: {
    now: Date;
    maxCandidates: number;
    electionLookbackDays: number;
    electionLookaheadDays: number;
  }
): Promise<TennesseeFinanceAutoLinkCandidateElection[]> {
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
        AND district.state = 'TN'
        AND election.race_type = 'office'
        AND election.election_date >= ($1::date - make_interval(days => $3::int))
        AND election.election_date <= ($1::date + make_interval(days => $4::int))
        AND candidate_election.status NOT IN ('withdrawn', 'lost')
        AND (office.scope || '::' || office.canonical_name) = ANY($5::text[])
        AND COALESCE(NULLIF(trim(candidate.display_name), ''), NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.tn_candidate_finance_links AS link
          WHERE link.candidate_id = candidate.id
            AND link.election_id = election.id
            AND link.link_status IN ('active', 'ambiguous')
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
      [...TENNESSEE_FINANCE_ELIGIBLE_OFFICE_KEYS],
    ]
  );

  return result.rows.map(mapCandidateElectionRow);
}

export async function autoLinkTennesseeCandidateFinanceForCandidateElection(input: {
  db: Queryable;
  candidateElection: TennesseeFinanceAutoLinkCandidateElection;
  now: Date;
  resolveCandidateCommittee?: TennesseeCandidateCommitteeResolver;
  clientOptions?: TennesseeCampClientOptions;
}): Promise<TennesseeFinanceAutoLinkResult> {
  const resolveCandidateCommittee = input.resolveCandidateCommittee ?? searchAndResolveTennesseeCandidateCommittee;
  const resolution = await resolveCandidateCommittee(
    {
      candidateName: input.candidateElection.candidateName,
      officeScope: input.candidateElection.officeScope,
      officeName: input.candidateElection.officeName,
      electionYear: input.candidateElection.electionYear,
      district: input.candidateElection.district,
    },
    input.clientOptions
  );

  if (resolution.status === "ambiguous") {
    console.warn("Tennessee finance auto-link found ambiguous CAMP candidate matches:", {
      candidateId: input.candidateElection.candidateId,
      electionId: input.candidateElection.electionId,
      candidateName: input.candidateElection.candidateName,
      matches: resolution.matches.map((match) => ({
        campCandidateId: match.campCandidateId,
        ownerName: match.ownerName,
        candidateName: match.candidateName,
        officeSought: match.officeSought,
        district: match.district,
      })),
    });
    await upsertTennesseeFinanceLink({
      db: input.db,
      link: {
        candidateId: input.candidateElection.candidateId,
        electionId: input.candidateElection.electionId,
        electionYear: input.candidateElection.electionYear,
        candidateNameNormalized: normalizeCandidateNameForStorage(input.candidateElection.candidateName),
        officeName: input.candidateElection.officeName,
        district: input.candidateElection.district,
        campCandidateId: "AMBIGUOUS",
        ownerName: input.candidateElection.candidateName,
        committeeName: "Ambiguous Tennessee CAMP match",
        linkStatus: "ambiguous",
        linkSource: "tncamp_search",
        sourceUrl: resolution.matches[0]?.sourceUrl ?? null,
        reportListUrl: null,
        lastVerifiedAt: input.now,
      },
    });
    return {
      candidateId: input.candidateElection.candidateId,
      electionId: input.candidateElection.electionId,
      status: resolution.status,
      reason: resolution.reason,
    };
  }

  if (resolution.status !== "matched") {
    return {
      candidateId: input.candidateElection.candidateId,
      electionId: input.candidateElection.electionId,
      status: resolution.status,
      reason: resolution.reason,
    };
  }

  await upsertTennesseeFinanceLink({
    db: input.db,
    link: {
      candidateId: input.candidateElection.candidateId,
      electionId: input.candidateElection.electionId,
      electionYear: input.candidateElection.electionYear,
      candidateNameNormalized: normalizeCandidateNameForStorage(input.candidateElection.candidateName),
      officeName: input.candidateElection.officeName,
      district: input.candidateElection.district,
      campCandidateId: resolution.campCandidateId,
      ownerName: resolution.ownerName,
      committeeName: resolution.candidateName,
      linkStatus: "active",
      linkSource: "tncamp_search",
      sourceUrl: resolution.sourceUrl,
      reportListUrl: resolution.reportListUrl,
      lastVerifiedAt: input.now,
    },
  });

  return {
    candidateId: input.candidateElection.candidateId,
    electionId: input.candidateElection.electionId,
    status: "linked",
    campCandidateId: resolution.campCandidateId,
  };
}

export async function autoLinkMissingTennesseeCandidateFinanceLinks(input: {
  db: Queryable;
  now: Date;
  maxCandidates: number;
  electionLookbackDays: number;
  electionLookaheadDays: number;
  candidateElections?: readonly TennesseeFinanceAutoLinkCandidateElection[];
  resolveCandidateCommittee?: TennesseeCandidateCommitteeResolver;
  clientOptions?: TennesseeCampClientOptions;
}): Promise<TennesseeFinanceAutoLinkResult[]> {
  const candidates =
    input.candidateElections ??
    (await listTennesseeCandidateElectionsMissingFinanceLinks(input.db, {
      now: input.now,
      maxCandidates: input.maxCandidates,
      electionLookbackDays: input.electionLookbackDays,
      electionLookaheadDays: input.electionLookaheadDays,
    }));

  const results: TennesseeFinanceAutoLinkResult[] = [];
  for (const candidateElection of candidates) {
    try {
      results.push(
        await autoLinkTennesseeCandidateFinanceForCandidateElection({
          db: input.db,
          candidateElection,
          now: input.now,
          resolveCandidateCommittee: input.resolveCandidateCommittee,
          clientOptions: input.clientOptions,
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("Tennessee finance auto-link failed for candidate election; continuing:", {
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
