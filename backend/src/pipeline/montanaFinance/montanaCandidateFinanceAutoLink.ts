// Montana finance auto-link: creates missing candidate -> CERS links (links
// only, never summaries). Mirrors the Missouri/South Carolina shape: list
// candidate elections in eligible offices with no active link, resolve each
// against the year's CERS registration list (fetched ONCE per batch — the
// full list is a single DataTables page), and write only full-name +
// office-title + year matches with linkSource "cers_portal". The writer's
// manual-link protection guarantees operator links always win; ambiguity and
// partial matches are reported, never linked.

import type { Pool, PoolClient } from "pg";

import type { MontanaCersSessionOptions } from "./montanaCersClient.js";
import type { MontanaCersCandidateSearchRow } from "./montanaCersParsers.js";
import {
  normalizeMontanaCandidateNameForStorage,
  resolveMontanaCersCandidate,
  searchMontanaCersCandidatesByYear,
  type MontanaCersCandidateMatch,
  type MontanaCersCandidateResolution,
} from "./montanaCandidateCersResolver.js";
import { MONTANA_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./montanaFinanceEligibleOffices.js";
import { upsertMontanaFinanceLink } from "./montanaFinanceWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type MontanaFinanceAutoLinkCandidateElection = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionDate: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district: string | null;
  legislativeDistrict: string | null;
  /** PSC seat numbers live here — statewide elections use the "Montana" district. */
  ballotTitle: string | null;
};

export type MontanaFinanceAutoLinkResult = {
  candidateId: string;
  electionId: string;
  status: "linked" | "ambiguous" | "unmatched" | "error";
  reason?: string;
  cersCandidateId?: number;
  cersCandidateName?: string;
  candidates?: MontanaCersCandidateMatch[];
  error?: string;
};

type CandidateElectionQueryRow = {
  candidate_id: string;
  election_id: string;
  candidate_name: string;
  election_date: string | Date;
  election_year: number;
  office_scope: string;
  office_name: string;
  district_name: string | null;
  legislative_district: string | null;
  ballot_title: string | null;
};

function toIsoDate(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  if (match?.[1]) {
    return match[1];
  }
  throw new Error(`Invalid Montana candidate election date from database: ${value}`);
}

export async function listMontanaCandidateElectionsMissingFinanceLinks(
  db: Queryable,
  input: { now: Date; maxCandidates: number; electionLookbackDays: number; electionLookaheadDays: number }
): Promise<MontanaFinanceAutoLinkCandidateElection[]> {
  const result = await db.query<CandidateElectionQueryRow>(
    `
      SELECT
        candidate.id::text AS candidate_id,
        election.id::text AS election_id,
        COALESCE(
          NULLIF(trim(candidate.display_name), ''),
          NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')
        ) AS candidate_name,
        election.election_date,
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
        AND district.state = 'MT'
        AND election.race_type = 'office'
        AND election.election_stage = 'general'
        AND election.election_date >= ($1::date - make_interval(days => $3::int))
        AND election.election_date <= ($1::date + make_interval(days => $4::int))
        AND candidate_election.status NOT IN ('withdrawn', 'lost')
        AND (office.scope || '::' || office.canonical_name) = ANY($5::text[])
        AND COALESCE(NULLIF(trim(candidate.display_name), ''), NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.mt_candidate_finance_links AS link
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
      [...MONTANA_FINANCE_ELIGIBLE_OFFICE_KEYS],
    ]
  );
  return result.rows.map((row) => ({
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionDate: toIsoDate(row.election_date),
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    district: row.district_name,
    legislativeDistrict: row.legislative_district,
    ballotTitle: row.ballot_title,
  }));
}

export type MontanaCersYearSearch = (
  electionYear: number,
  options?: MontanaCersSessionOptions
) => Promise<MontanaCersCandidateSearchRow[]>;

export async function autoLinkMontanaCandidateFinanceForCandidateElection(input: {
  db: Queryable;
  candidateElection: MontanaFinanceAutoLinkCandidateElection;
  now: Date;
  cersRows: readonly MontanaCersCandidateSearchRow[];
}): Promise<MontanaFinanceAutoLinkResult> {
  const candidate = input.candidateElection;
  const resolution: MontanaCersCandidateResolution = resolveMontanaCersCandidate({
    candidateName: candidate.candidateName,
    electionYear: candidate.electionYear,
    officeScope: candidate.officeScope,
    officeName: candidate.officeName,
    districtName: candidate.district,
    legislativeDistrict: candidate.legislativeDistrict,
    ballotTitle: candidate.ballotTitle,
    rows: input.cersRows,
  });
  if (resolution.status === "unmatched") {
    return {
      candidateId: candidate.candidateId,
      electionId: candidate.electionId,
      status: "unmatched",
      reason: resolution.reason,
    };
  }
  if (resolution.status === "ambiguous") {
    return {
      candidateId: candidate.candidateId,
      electionId: candidate.electionId,
      status: "ambiguous",
      reason: resolution.reason,
      candidates: resolution.matches,
    };
  }

  await upsertMontanaFinanceLink({
    db: input.db,
    link: {
      candidateId: candidate.candidateId,
      electionId: candidate.electionId,
      electionYear: candidate.electionYear,
      candidateNameNormalized: normalizeMontanaCandidateNameForStorage(candidate.candidateName),
      officeName: candidate.officeName,
      district: candidate.legislativeDistrict ?? candidate.district,
      committeeId: String(resolution.cersCandidateId),
      committeeName: resolution.cersCandidateName,
      linkStatus: "active",
      linkSource: "cers_portal",
      sourceUrl: resolution.sourceUrl,
      lastVerifiedAt: input.now,
    },
  });
  return {
    candidateId: candidate.candidateId,
    electionId: candidate.electionId,
    status: "linked",
    cersCandidateId: resolution.cersCandidateId,
    cersCandidateName: resolution.cersCandidateName,
  };
}

export async function autoLinkMissingMontanaCandidateFinanceLinks(input: {
  db: Queryable;
  now: Date;
  maxCandidates: number;
  electionLookbackDays: number;
  electionLookaheadDays: number;
  candidateElections?: readonly MontanaFinanceAutoLinkCandidateElection[];
  searchCandidatesByYear?: MontanaCersYearSearch;
  cersClientOptions?: MontanaCersSessionOptions;
}): Promise<MontanaFinanceAutoLinkResult[]> {
  const candidates =
    input.candidateElections ??
    (await listMontanaCandidateElectionsMissingFinanceLinks(input.db, {
      now: input.now,
      maxCandidates: input.maxCandidates,
      electionLookbackDays: input.electionLookbackDays,
      electionLookaheadDays: input.electionLookaheadDays,
    }));

  const search = input.searchCandidatesByYear ?? searchMontanaCersCandidatesByYear;
  const rowsByYear = new Map<number, Promise<MontanaCersCandidateSearchRow[]>>();
  const results: MontanaFinanceAutoLinkResult[] = [];
  for (const candidate of candidates) {
    try {
      let rows = rowsByYear.get(candidate.electionYear);
      if (rows === undefined) {
        rows = search(candidate.electionYear, input.cersClientOptions);
        rowsByYear.set(candidate.electionYear, rows);
      }
      results.push(
        await autoLinkMontanaCandidateFinanceForCandidateElection({
          db: input.db,
          candidateElection: candidate,
          now: input.now,
          cersRows: await rows,
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("Montana finance auto-link failed for candidate election; continuing:", {
        candidateId: candidate.candidateId,
        electionId: candidate.electionId,
        error: message,
      });
      results.push({
        candidateId: candidate.candidateId,
        electionId: candidate.electionId,
        status: "error",
        reason: "auto_link_failed",
        error: message,
      });
    }
  }
  return results;
}
