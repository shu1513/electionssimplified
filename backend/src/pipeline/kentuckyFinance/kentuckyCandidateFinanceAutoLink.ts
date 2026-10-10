import type { Pool, PoolClient } from "pg";

import { KENTUCKY_FINANCE_ELIGIBLE_OFFICE_KEYS, normalizeKentuckyKrefLocation } from "./kentuckyFinanceEligibleOffices.js";
import { upsertKentuckyFinanceLink } from "./kentuckyFinanceWriter.js";
import { normalizeKentuckyCandidateNameKeys } from "./kentuckyOutsideSpendingAggregator.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type KentuckyFinanceAutoLinkCandidateElection = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  electionDate: string;
  officeScope: string;
  officeName: string;
  location: string | null;
};

export type KentuckyCandidateFinanceLinkResolution =
  | {
      status: "matched";
      candidateKey: string;
      committeeKey: string;
      committeeName: string;
      sourceUrl?: string | null;
    }
  | {
      status: "unmatched" | "ambiguous";
      reason: string;
      matchCount?: number;
    };

export type KentuckyCandidateFinanceAutoLinkResolver = (
  input: KentuckyFinanceAutoLinkCandidateElection
) => Promise<KentuckyCandidateFinanceLinkResolution>;

export type KentuckyFinanceAutoLinkResult =
  | {
      candidateId: string;
      electionId: string;
      status: "linked";
      candidateKey: string;
      committeeKey: string;
    }
  | {
      candidateId: string;
      electionId: string;
      status: "unmatched" | "ambiguous" | "skipped";
      reason: string;
      matchCount?: number;
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
  election_date: string;
  office_scope: string;
  office_name: string;
  location: string | null;
};

function normalizeCandidateNameForStorage(value: string): string {
  if (value.includes(",")) {
    const commaParts = value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (commaParts.length >= 2) {
      return `${commaParts.slice(1).join(" ")} ${commaParts[0]}`.replace(/\s+/g, " ").toUpperCase();
    }
  }
  const keys = normalizeKentuckyCandidateNameKeys(value);
  return [...keys][0] ?? value.trim().replace(/\s+/g, " ").toUpperCase();
}

function mapCandidateElectionRow(row: CandidateElectionQueryRow): KentuckyFinanceAutoLinkCandidateElection {
  return {
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    electionDate: row.election_date,
    officeScope: row.office_scope,
    officeName: row.office_name,
    location: normalizeKentuckyKrefLocation(row.location),
  };
}

export async function listKentuckyCandidateElectionsMissingFinanceLinks(
  db: Queryable,
  input: {
    now: Date;
    // Auto-link intentionally has NO default cap: unmatched/ambiguous
    // candidates never get a link, so a stable ORDER BY + LIMIT would retry
    // the same unmatched prefix every run and starve the tail (the
    // Pennsylvania PR #377 lesson). The window/office/state filters bound the
    // result; maxCandidates still caps the due sync.
    maxCandidates?: number;
    electionLookbackDays: number;
    electionLookaheadDays: number;
  }
): Promise<KentuckyFinanceAutoLinkCandidateElection[]> {
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
        election.election_date::text AS election_date,
        office.scope AS office_scope,
        COALESCE(NULLIF(trim(office.canonical_name), ''), election.official_ballot_title) AS office_name,
        CASE
          WHEN office.scope = 'statewide' THEN 'Statewide'
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
        END AS location
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
        AND district.state = 'KY'
        AND election.race_type = 'office'
        AND election.election_date >= ($1::date - make_interval(days => $3::int))
        AND election.election_date <= ($1::date + make_interval(days => $4::int))
        AND candidate_election.status NOT IN ('withdrawn', 'lost')
        AND (office.scope || '::' || office.canonical_name) = ANY($5::text[])
        AND COALESCE(NULLIF(trim(candidate.display_name), ''), NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.ky_candidate_finance_links AS link
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
      // NULL means LIMIT ALL in Postgres — enumerate every eligible candidate.
      input.maxCandidates ?? null,
      input.electionLookbackDays,
      input.electionLookaheadDays,
      [...KENTUCKY_FINANCE_ELIGIBLE_OFFICE_KEYS],
    ]
  );

  return result.rows.map(mapCandidateElectionRow);
}

export async function autoLinkKentuckyCandidateFinanceForCandidateElection(input: {
  db: Queryable;
  candidateElection: KentuckyFinanceAutoLinkCandidateElection;
  now: Date;
  resolveCandidateFinanceLink?: KentuckyCandidateFinanceAutoLinkResolver;
}): Promise<KentuckyFinanceAutoLinkResult> {
  if (!input.resolveCandidateFinanceLink) {
    return {
      candidateId: input.candidateElection.candidateId,
      electionId: input.candidateElection.electionId,
      status: "skipped",
      reason: "resolver_not_configured",
    };
  }

  const resolution = await input.resolveCandidateFinanceLink(input.candidateElection);
  if (resolution.status !== "matched") {
    return {
      candidateId: input.candidateElection.candidateId,
      electionId: input.candidateElection.electionId,
      status: resolution.status,
      reason: resolution.reason,
      matchCount: resolution.matchCount,
    };
  }

  await upsertKentuckyFinanceLink({
    db: input.db,
    link: {
      candidateId: input.candidateElection.candidateId,
      electionId: input.candidateElection.electionId,
      electionYear: input.candidateElection.electionYear,
      candidateNameNormalized: normalizeCandidateNameForStorage(input.candidateElection.candidateName),
      officeName: input.candidateElection.officeName,
      district: input.candidateElection.location,
      candidateKey: resolution.candidateKey,
      committeeKey: resolution.committeeKey,
      committeeName: resolution.committeeName,
      linkStatus: "active",
      linkSource: "kref_public_search",
      sourceUrl: resolution.sourceUrl ?? null,
      lastVerifiedAt: input.now,
    },
  });

  return {
    candidateId: input.candidateElection.candidateId,
    electionId: input.candidateElection.electionId,
    status: "linked",
    candidateKey: resolution.candidateKey,
    committeeKey: resolution.committeeKey,
  };
}

export async function autoLinkMissingKentuckyCandidateFinanceLinks(input: {
  db: Queryable;
  now: Date;
  maxCandidates: number;
  electionLookbackDays: number;
  electionLookaheadDays: number;
  candidateElections?: readonly KentuckyFinanceAutoLinkCandidateElection[];
  resolveCandidateFinanceLink?: KentuckyCandidateFinanceAutoLinkResolver;
}): Promise<KentuckyFinanceAutoLinkResult[]> {
  const candidates =
    input.candidateElections ??
    (await listKentuckyCandidateElectionsMissingFinanceLinks(input.db, {
      now: input.now,
      maxCandidates: input.maxCandidates,
      electionLookbackDays: input.electionLookbackDays,
      electionLookaheadDays: input.electionLookaheadDays,
    }));

  const results: KentuckyFinanceAutoLinkResult[] = [];
  for (const candidateElection of candidates) {
    try {
      results.push(
        await autoLinkKentuckyCandidateFinanceForCandidateElection({
          db: input.db,
          candidateElection,
          now: input.now,
          resolveCandidateFinanceLink: input.resolveCandidateFinanceLink,
        })
      );
    } catch (error) {
      results.push({
        candidateId: candidateElection.candidateId,
        electionId: candidateElection.electionId,
        status: "error",
        reason: "auto_link_failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
