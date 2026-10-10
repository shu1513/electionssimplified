// West Virginia finance auto-link: creates missing candidate -> committee
// links (links only, never summaries). Lists candidate elections in eligible
// offices with no active link, resolves each against the committee registry
// (fetched live once per batch — the only portal call outside the refresh
// CLI, so it shares the sync flag), and writes only exact office + district
// + full-name matches with linkSource "cfrs_registry" — the writer's
// manual-link protection guarantees operator links always win. Ambiguity
// and unparseable districts are reported, never linked.

import type { Pool, PoolClient } from "pg";

import {
  getAllWestVirginiaCommittees,
  type WestVirginiaCfrsClientOptions,
  type WestVirginiaCommitteeRow,
} from "./westVirginiaCfrsClient.js";
import {
  normalizeWestVirginiaCandidateNameForStorage,
  resolveWestVirginiaCandidateCommittee,
  type WestVirginiaCommitteeMatch,
} from "./westVirginiaCandidateCommitteeResolver.js";
import {
  WEST_VIRGINIA_FINANCE_ELIGIBLE_OFFICE_KEYS,
  westVirginiaDistrictNumberFromDistrictName,
  westVirginiaRegistryOfficeForRace,
} from "./westVirginiaFinanceEligibleOffices.js";
import { WEST_VIRGINIA_CFRS_SOURCE_URL, upsertWestVirginiaFinanceLink } from "./westVirginiaFinanceWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type WestVirginiaFinanceAutoLinkCandidateElection = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district: string | null;
};

export type WestVirginiaFinanceAutoLinkResult = {
  candidateId: string;
  electionId: string;
  status: "linked" | "ambiguous" | "unmatched" | "error";
  reason?: string;
  entityId?: string;
  committeeName?: string;
  candidates?: WestVirginiaCommitteeMatch[];
  error?: string;
};

type CandidateElectionQueryRow = {
  candidate_id: string;
  election_id: string;
  candidate_name: string;
  election_year: number;
  office_scope: string;
  office_name: string;
  district_name: string | null;
};

export async function listWestVirginiaCandidateElectionsMissingFinanceLinks(
  db: Queryable,
  input: { now: Date; maxCandidates: number; electionLookbackDays: number; electionLookaheadDays: number }
): Promise<WestVirginiaFinanceAutoLinkCandidateElection[]> {
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
        AND district.state = 'WV'
        AND election.race_type = 'office'
        AND election.election_stage = 'general'
        AND election.election_date >= ($1::date - make_interval(days => $3::int))
        AND election.election_date <= ($1::date + make_interval(days => $4::int))
        AND candidate_election.status NOT IN ('withdrawn', 'lost')
        AND (office.scope || '::' || office.canonical_name) = ANY($5::text[])
        AND COALESCE(NULLIF(trim(candidate.display_name), ''), NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.wv_candidate_finance_links AS link
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
      [...WEST_VIRGINIA_FINANCE_ELIGIBLE_OFFICE_KEYS],
    ]
  );
  return result.rows.map((row) => ({
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    district: row.district_name,
  }));
}

export type WestVirginiaCommitteeRegistryLoader = () => Promise<WestVirginiaCommitteeRow[]>;

/** One live registry fetch per batch (2,967 rows in one page-set). */
export function createWestVirginiaCommitteeRegistryLoader(input: {
  clientOptions?: WestVirginiaCfrsClientOptions;
  fetchCommittees?: typeof getAllWestVirginiaCommittees;
}): WestVirginiaCommitteeRegistryLoader {
  const fetchCommittees = input.fetchCommittees ?? getAllWestVirginiaCommittees;
  let registry: Promise<WestVirginiaCommitteeRow[]> | null = null;
  return () => {
    registry ??= fetchCommittees({ pageSize: 5_000 }, input.clientOptions);
    return registry;
  };
}

export async function autoLinkWestVirginiaCandidateFinanceForCandidateElection(input: {
  db: Queryable;
  candidateElection: WestVirginiaFinanceAutoLinkCandidateElection;
  now: Date;
  loadRegistry: WestVirginiaCommitteeRegistryLoader;
}): Promise<WestVirginiaFinanceAutoLinkResult> {
  const candidate = input.candidateElection;
  const registryOffice = westVirginiaRegistryOfficeForRace({
    officeScope: candidate.officeScope,
    officeCanonicalName: candidate.officeName,
  });
  if (registryOffice === null) {
    return { candidateId: candidate.candidateId, electionId: candidate.electionId, status: "unmatched", reason: "office_unmapped" };
  }
  const districtNumber = westVirginiaDistrictNumberFromDistrictName(candidate.district);
  if (districtNumber === null) {
    return { candidateId: candidate.candidateId, electionId: candidate.electionId, status: "unmatched", reason: "district_unparseable" };
  }

  const resolution = resolveWestVirginiaCandidateCommittee({
    candidateName: candidate.candidateName,
    electionYear: candidate.electionYear,
    registryOffice,
    districtNumber,
    committees: await input.loadRegistry(),
  });
  if (resolution.status === "unmatched") {
    return { candidateId: candidate.candidateId, electionId: candidate.electionId, status: "unmatched", reason: resolution.reason };
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

  await upsertWestVirginiaFinanceLink({
    db: input.db,
    link: {
      candidateId: candidate.candidateId,
      electionId: candidate.electionId,
      electionYear: candidate.electionYear,
      candidateNameNormalized: normalizeWestVirginiaCandidateNameForStorage(candidate.candidateName),
      officeName: candidate.officeName,
      district: candidate.district,
      entityId: resolution.entityId,
      committeeName: resolution.committeeName,
      linkStatus: "active",
      linkSource: "cfrs_registry",
      sourceUrl: WEST_VIRGINIA_CFRS_SOURCE_URL,
      lastVerifiedAt: input.now,
    },
  });
  return {
    candidateId: candidate.candidateId,
    electionId: candidate.electionId,
    status: "linked",
    entityId: resolution.entityId,
    committeeName: resolution.committeeName,
  };
}

export async function autoLinkMissingWestVirginiaCandidateFinanceLinks(input: {
  db: Queryable;
  now: Date;
  maxCandidates: number;
  electionLookbackDays: number;
  electionLookaheadDays: number;
  candidateElections?: readonly WestVirginiaFinanceAutoLinkCandidateElection[];
  loadRegistry?: WestVirginiaCommitteeRegistryLoader;
  clientOptions?: WestVirginiaCfrsClientOptions;
}): Promise<WestVirginiaFinanceAutoLinkResult[]> {
  const candidates =
    input.candidateElections ??
    (await listWestVirginiaCandidateElectionsMissingFinanceLinks(input.db, {
      now: input.now,
      maxCandidates: input.maxCandidates,
      electionLookbackDays: input.electionLookbackDays,
      electionLookaheadDays: input.electionLookaheadDays,
    }));
  const loadRegistry =
    input.loadRegistry ?? createWestVirginiaCommitteeRegistryLoader({ clientOptions: input.clientOptions });
  const results: WestVirginiaFinanceAutoLinkResult[] = [];
  for (const candidate of candidates) {
    try {
      results.push(
        await autoLinkWestVirginiaCandidateFinanceForCandidateElection({
          db: input.db,
          candidateElection: candidate,
          now: input.now,
          loadRegistry,
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
