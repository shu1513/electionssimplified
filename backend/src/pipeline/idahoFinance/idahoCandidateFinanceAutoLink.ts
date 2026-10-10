// Idaho finance auto-link: creates missing candidate -> registration links
// (links only, never summaries). Kansas/Montana shape: list candidate
// elections in eligible offices with no active link, pull the Sunshine
// candidate grid ONCE per run, resolve locally, and write only full-name +
// office + district matches with linkSource "sunshine_grid". The writer's
// manual-link protection guarantees operator links always win; ambiguity and
// misses are reported, never linked.

import type { Pool, PoolClient } from "pg";

import {
  getAllIdahoCandidateRegistrations,
  type IdahoCandidateRegistrationRow,
  type IdahoCfsClientOptions,
} from "./idahoCfsClient.js";
import {
  resolveIdahoCandidateFiler,
  type IdahoCandidateFilerMatch,
  type IdahoCandidateFilerResolution,
} from "./idahoCandidateFilerResolver.js";
import { IDAHO_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./idahoFinanceEligibleOffices.js";
import {
  IDAHO_FINANCE_AUTOMATIC_LINK_SOURCE,
  normalizeIdahoCandidateNameForStorage,
  upsertIdahoFinanceLink,
} from "./idahoFinanceWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;

// The grid holds ~2,050 rows all-time (live 2026-09-01); one page covers it.
export const IDAHO_CFS_GRID_PAGE_SIZE = 5_000;

export type IdahoFinanceAutoLinkCandidateElection = {
  candidateId: string;
  electionId: string;
  /** Display name first, then the structured "First Last" spelling. */
  candidateNames: string[];
  electionYear: number;
  officeScope: string;
  officeName: string;
  district: string | null;
  ballotTitle: string | null;
  /** Legislative district number from the district geoid; null otherwise. */
  legislativeDistrict: number | null;
};

export type IdahoFinanceAutoLinkResult = {
  candidateId: string;
  electionId: string;
  status: "linked" | "ambiguous" | "unmatched" | "error";
  reason?: string;
  registrationGuid?: string;
  filerName?: string;
  district?: string | null;
  confidence?: IdahoCandidateFilerMatch["confidence"];
  matches?: Array<Pick<IdahoCandidateFilerMatch, "registrationGuid" | "filerName" | "status">>;
  error?: string;
};

type CandidateElectionQueryRow = {
  candidate_id: string;
  election_id: string;
  display_name: string | null;
  structured_name: string | null;
  election_year: number;
  office_scope: string;
  office_name: string;
  district_name: string | null;
  ballot_title: string | null;
  legislative_district: string | null;
};

function parseLegislativeDistrict(value: string | null): number | null {
  const match = /^\s*(\d+)\s*$/.exec(value ?? "");
  if (!match) return null;
  const parsed = Number.parseInt(match[1]!, 10);
  return parsed > 0 ? parsed : null;
}

// No default cap: unmatched and ambiguous candidates never receive a link, so
// they stay at the front of this ordered list on every run and a fixed LIMIT
// would starve everyone behind them. The roster is small and the grid is one
// request either way; maxCandidates is an operator valve, null = all.
export async function listIdahoCandidateElectionsMissingFinanceLinks(
  db: Queryable,
  input: { now: Date; maxCandidates: number | null; electionLookbackDays: number; electionLookaheadDays: number }
): Promise<IdahoFinanceAutoLinkCandidateElection[]> {
  const result = await db.query<CandidateElectionQueryRow>(
    `
      SELECT
        candidate.id::text AS candidate_id,
        election.id::text AS election_id,
        NULLIF(trim(candidate.display_name), '') AS display_name,
        NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '') AS structured_name,
        extract(year from election.election_date)::int AS election_year,
        office.scope AS office_scope,
        office.canonical_name AS office_name,
        district.name AS district_name,
        election.official_ballot_title AS ballot_title,
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
        END AS legislative_district
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
        AND district.state = 'ID'
        AND election.race_type = 'office'
        AND election.election_stage = 'general'
        AND election.election_date >= ($1::date - make_interval(days => $3::int))
        AND election.election_date <= ($1::date + make_interval(days => $4::int))
        AND candidate_election.status NOT IN ('withdrawn', 'lost')
        AND (office.scope || '::' || office.canonical_name) = ANY($5::text[])
        AND COALESCE(NULLIF(trim(candidate.display_name), ''), NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.id_candidate_finance_links AS link
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
      [...IDAHO_FINANCE_ELIGIBLE_OFFICE_KEYS],
    ]
  );
  return result.rows.map((row) => ({
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateNames: [row.display_name, row.structured_name].filter((name): name is string => name !== null),
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    district: row.district_name,
    ballotTitle: row.ballot_title,
    legislativeDistrict: parseLegislativeDistrict(row.legislative_district),
  }));
}

function summarizeMatches(resolution: Extract<IdahoCandidateFilerResolution, { status: "ambiguous" }>) {
  return resolution.matches.map((match) => ({
    registrationGuid: match.registrationGuid,
    filerName: match.filerName,
    status: match.status,
  }));
}

export async function autoLinkIdahoCandidateFinanceForCandidateElection(input: {
  db: Queryable;
  candidateElection: IdahoFinanceAutoLinkCandidateElection;
  registrations: readonly IdahoCandidateRegistrationRow[];
  now: Date;
  /** Resolve and report without writing links. */
  dryRun?: boolean;
}): Promise<IdahoFinanceAutoLinkResult> {
  const candidate = input.candidateElection;
  const base = { candidateId: candidate.candidateId, electionId: candidate.electionId };
  const resolution = resolveIdahoCandidateFiler({
    candidateNames: candidate.candidateNames,
    officeScope: candidate.officeScope,
    officeName: candidate.officeName,
    district: candidate.district,
    legislativeDistrict: candidate.legislativeDistrict,
    ballotTitle: candidate.ballotTitle,
    electionYear: candidate.electionYear,
    registrations: input.registrations,
  });
  if (resolution.status === "unmatched") {
    return { ...base, status: "unmatched", reason: resolution.reason };
  }
  if (resolution.status === "ambiguous") {
    return { ...base, status: "ambiguous", reason: resolution.reason, matches: summarizeMatches(resolution) };
  }

  const match = resolution.match;
  if (!input.dryRun) {
    await upsertIdahoFinanceLink({
      db: input.db,
      link: {
        candidateId: candidate.candidateId,
        electionId: candidate.electionId,
        electionYear: candidate.electionYear,
        candidateNameNormalized: normalizeIdahoCandidateNameForStorage(candidate.candidateNames[0] ?? ""),
        officeName: candidate.officeName,
        district: match.district,
        registrationGuid: match.registrationGuid,
        filerName: match.filerName,
        linkStatus: "active",
        linkSource: IDAHO_FINANCE_AUTOMATIC_LINK_SOURCE,
        sourceUrl: match.sourceUrl,
        lastVerifiedAt: input.now,
      },
    });
  }
  return {
    ...base,
    status: "linked",
    registrationGuid: match.registrationGuid,
    filerName: match.filerName,
    district: match.district,
    confidence: match.confidence,
  };
}

export async function autoLinkMissingIdahoCandidateFinanceLinks(input: {
  db: Queryable;
  now: Date;
  maxCandidates: number | null;
  electionLookbackDays: number;
  electionLookaheadDays: number;
  dryRun?: boolean;
  candidateElections?: readonly IdahoFinanceAutoLinkCandidateElection[];
  registrations?: readonly IdahoCandidateRegistrationRow[];
  clientOptions?: IdahoCfsClientOptions;
}): Promise<IdahoFinanceAutoLinkResult[]> {
  const candidates =
    input.candidateElections ??
    (await listIdahoCandidateElectionsMissingFinanceLinks(input.db, {
      now: input.now,
      maxCandidates: input.maxCandidates,
      electionLookbackDays: input.electionLookbackDays,
      electionLookaheadDays: input.electionLookaheadDays,
    }));
  if (candidates.length === 0) return [];
  const registrations =
    input.registrations ??
    (await getAllIdahoCandidateRegistrations({ pageSize: IDAHO_CFS_GRID_PAGE_SIZE }, input.clientOptions));
  const results: IdahoFinanceAutoLinkResult[] = [];
  for (const candidate of candidates) {
    try {
      results.push(
        await autoLinkIdahoCandidateFinanceForCandidateElection({
          db: input.db,
          candidateElection: candidate,
          registrations,
          now: input.now,
          dryRun: input.dryRun,
        })
      );
    } catch (error) {
      results.push({
        candidateId: candidate.candidateId,
        electionId: candidate.electionId,
        status: "error",
        reason: "auto_link_failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
