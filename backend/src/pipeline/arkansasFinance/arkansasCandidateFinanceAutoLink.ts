// Arkansas finance auto-link: creates missing candidate → CFIS registration
// links (links only, never summaries). Alabama/NH shape: list rostered
// candidate elections in eligible offices with no active link, resolve each
// against one full registration sweep per run, and write only exact matches
// with linkSource "cfis_registration" — the writer's manual-link protection
// guarantees operator links always win. Ambiguity and misses are reported,
// never linked (docs/plans/plan-arkansas-finance.md, Phase 2).

import type { Pool, PoolClient } from "pg";

import {
  ARKANSAS_CFIS_API_BASE_URL,
  ARKANSAS_CFIS_ENDPOINTS,
  getAllArkansasFilerRegistrations,
  type ArkansasCfisClientOptions,
  type ArkansasFilerRegistrationRow,
} from "./arkansasCfisClient.js";
import {
  normalizeArkansasCandidateNameForStorage,
  resolveArkansasCandidateFiler,
  type ArkansasCandidateFilerMatch,
} from "./arkansasCandidateFilerResolver.js";
import { ARKANSAS_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./arkansasFinanceEligibleOffices.js";
import { ARKANSAS_FINANCE_AUTOMATIC_LINK_SOURCE, upsertArkansasFinanceLink } from "./arkansasFinanceWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export const ARKANSAS_CFIS_REGISTRATION_SEARCH_URL = `${ARKANSAS_CFIS_API_BASE_URL}/${ARKANSAS_CFIS_ENDPOINTS.filerRegistrations}`;

const REGISTRATION_SWEEP_PAGE_SIZE = 1_000;

export type ArkansasFinanceAutoLinkCandidateElection = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  candidateParty: string | null;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district: string | null;
};

export type ArkansasFinanceAutoLinkResult = {
  candidateId: string;
  electionId: string;
  status: "linked" | "ambiguous" | "unmatched" | "error";
  reason?: string;
  filingEntityId?: number;
  filerName?: string;
  candidates?: ArkansasCandidateFilerMatch[];
  error?: string;
};

type CandidateElectionQueryRow = {
  candidate_id: string;
  election_id: string;
  candidate_name: string;
  candidate_party: string | null;
  election_year: number;
  office_scope: string;
  office_name: string;
  district_name: string | null;
};

export async function listArkansasCandidateElectionsMissingFinanceLinks(
  db: Queryable,
  input: { now: Date; maxCandidates: number; electionLookbackDays: number; electionLookaheadDays: number }
): Promise<ArkansasFinanceAutoLinkCandidateElection[]> {
  const result = await db.query<CandidateElectionQueryRow>(
    `
      SELECT
        candidate.id::text AS candidate_id,
        election.id::text AS election_id,
        COALESCE(
          NULLIF(trim(candidate.display_name), ''),
          NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')
        ) AS candidate_name,
        NULLIF(trim(candidate.party), '') AS candidate_party,
        extract(year from election.election_date)::int AS election_year,
        office.scope AS office_scope,
        office.canonical_name AS office_name,
        district.name AS district_name
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
        AND district.state = 'AR'
        AND election.race_type = 'office'
        AND election.election_stage = 'general'
        AND election.election_date >= ($1::date - make_interval(days => $3::int))
        AND election.election_date <= ($1::date + make_interval(days => $4::int))
        AND candidate_election.status NOT IN ('withdrawn', 'lost')
        AND (office.scope || '::' || office.canonical_name) = ANY($5::text[])
        AND COALESCE(NULLIF(trim(candidate.display_name), ''), NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.ar_candidate_finance_links AS link
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
      [...ARKANSAS_FINANCE_ELIGIBLE_OFFICE_KEYS],
    ]
  );
  return result.rows.map((row) => ({
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    candidateParty: row.candidate_party,
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    district: row.district_name,
  }));
}

/** One full registration sweep per run (11 pages live), shared by every candidate. */
export function createArkansasRegistrationSweepLoader(input: {
  clientOptions?: ArkansasCfisClientOptions;
  fetchRegistrations?: typeof getAllArkansasFilerRegistrations;
}): () => Promise<ArkansasFilerRegistrationRow[]> {
  const fetchRegistrations = input.fetchRegistrations ?? getAllArkansasFilerRegistrations;
  let sweep: Promise<ArkansasFilerRegistrationRow[]> | null = null;
  return () => {
    sweep ??= fetchRegistrations({ pageSize: REGISTRATION_SWEEP_PAGE_SIZE }, input.clientOptions);
    return sweep;
  };
}

export async function autoLinkArkansasCandidateFinanceForCandidateElection(input: {
  db: Queryable;
  candidateElection: ArkansasFinanceAutoLinkCandidateElection;
  now: Date;
  loadRegistrations: () => Promise<ArkansasFilerRegistrationRow[]>;
}): Promise<ArkansasFinanceAutoLinkResult> {
  const candidate = input.candidateElection;
  const registrationRows = await input.loadRegistrations();
  const resolution = resolveArkansasCandidateFiler({
    candidateName: candidate.candidateName,
    candidateParty: candidate.candidateParty,
    officeScope: candidate.officeScope,
    officeName: candidate.officeName,
    district: candidate.district,
    electionYear: candidate.electionYear,
    registrationRows,
    sourceUrl: ARKANSAS_CFIS_REGISTRATION_SEARCH_URL,
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

  await upsertArkansasFinanceLink({
    db: input.db,
    link: {
      candidateId: candidate.candidateId,
      electionId: candidate.electionId,
      electionYear: candidate.electionYear,
      candidateNameNormalized: normalizeArkansasCandidateNameForStorage(candidate.candidateName),
      officeName: candidate.officeName,
      district: candidate.district,
      filingEntityId: resolution.filingEntityId,
      filerName: resolution.filerName,
      linkStatus: "active",
      linkSource: ARKANSAS_FINANCE_AUTOMATIC_LINK_SOURCE,
      sourceUrl: ARKANSAS_CFIS_REGISTRATION_SEARCH_URL,
      lastVerifiedAt: input.now,
    },
  });
  return {
    candidateId: candidate.candidateId,
    electionId: candidate.electionId,
    status: "linked",
    filingEntityId: resolution.filingEntityId,
    filerName: resolution.filerName,
  };
}

export async function autoLinkMissingArkansasCandidateFinanceLinks(input: {
  db: Queryable;
  now: Date;
  maxCandidates: number;
  electionLookbackDays: number;
  electionLookaheadDays: number;
  candidateElections?: readonly ArkansasFinanceAutoLinkCandidateElection[];
  loadRegistrations?: () => Promise<ArkansasFilerRegistrationRow[]>;
  clientOptions?: ArkansasCfisClientOptions;
}): Promise<ArkansasFinanceAutoLinkResult[]> {
  const candidates =
    input.candidateElections ??
    (await listArkansasCandidateElectionsMissingFinanceLinks(input.db, {
      now: input.now,
      maxCandidates: input.maxCandidates,
      electionLookbackDays: input.electionLookbackDays,
      electionLookaheadDays: input.electionLookaheadDays,
    }));
  const loadRegistrations =
    input.loadRegistrations ?? createArkansasRegistrationSweepLoader({ clientOptions: input.clientOptions });
  const results: ArkansasFinanceAutoLinkResult[] = [];
  for (const candidate of candidates) {
    try {
      results.push(
        await autoLinkArkansasCandidateFinanceForCandidateElection({
          db: input.db,
          candidateElection: candidate,
          now: input.now,
          loadRegistrations,
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
