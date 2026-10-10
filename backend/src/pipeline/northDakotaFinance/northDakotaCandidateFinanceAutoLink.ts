// North Dakota finance auto-link: creates missing candidate -> committee
// links (links only, never summaries). Lists candidate elections in eligible
// offices with no active link, resolves each against the committee registry
// (fetched live once per batch — a portal call, so the CLI shares the
// raw-data-refresh gate), and writes only exact office (+ seat) + full-name
// matches with linkSource "cfrs_registry" — the writer's manual-link
// protection guarantees operator links always win. Ambiguity and
// unparseable districts are reported, never linked.

import type { Pool, PoolClient } from "pg";

import {
  getAllNorthDakotaCommittees,
  type NorthDakotaCfrsClientOptions,
  type NorthDakotaCommitteeRow,
} from "./northDakotaCfrsClient.js";
import {
  normalizeNorthDakotaCandidateNameForStorage,
  resolveNorthDakotaCandidateCommittee,
  type NorthDakotaCommitteeMatch,
} from "./northDakotaCandidateCommitteeResolver.js";
import {
  NORTH_DAKOTA_FINANCE_ELIGIBLE_OFFICE_KEYS,
  northDakotaDistrictNumberFromDistrictName,
  northDakotaEligibleOfficeForRace,
} from "./northDakotaFinanceEligibleOffices.js";
import {
  NORTH_DAKOTA_CFRS_SOURCE_URL,
  NORTH_DAKOTA_FINANCE_AUTOMATIC_LINK_SOURCE,
  upsertNorthDakotaFinanceLink,
} from "./northDakotaFinanceWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type NorthDakotaFinanceAutoLinkCandidateElection = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district: string | null;
};

export type NorthDakotaFinanceAutoLinkResult = {
  candidateId: string;
  electionId: string;
  status: "linked" | "ambiguous" | "unmatched" | "error";
  reason?: string;
  entityId?: string;
  committeeName?: string;
  /** Registry status of the linked committee ("Active" / "Inactive") for the operator log. */
  orgStatus?: string;
  candidates?: NorthDakotaCommitteeMatch[];
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

export async function listNorthDakotaCandidateElectionsMissingFinanceLinks(
  db: Queryable,
  input: { now: Date; maxCandidates: number; electionLookbackDays: number; electionLookaheadDays: number }
): Promise<NorthDakotaFinanceAutoLinkCandidateElection[]> {
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
        AND district.state = 'ND'
        AND election.race_type = 'office'
        AND election.election_stage = 'general'
        AND election.election_date >= ($1::date - make_interval(days => $3::int))
        AND election.election_date <= ($1::date + make_interval(days => $4::int))
        AND candidate_election.status NOT IN ('withdrawn', 'lost')
        AND (office.scope || '::' || office.canonical_name) = ANY($5::text[])
        AND COALESCE(NULLIF(trim(candidate.display_name), ''), NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.nd_candidate_finance_links AS link
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
      [...NORTH_DAKOTA_FINANCE_ELIGIBLE_OFFICE_KEYS],
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

export type NorthDakotaCommitteeRegistryLoader = () => Promise<NorthDakotaCommitteeRow[]>;

/** One live registry fetch per batch (601 rows live 2026-09-01; one page). */
export function createNorthDakotaCommitteeRegistryLoader(input: {
  clientOptions?: NorthDakotaCfrsClientOptions;
  fetchCommittees?: typeof getAllNorthDakotaCommittees;
}): NorthDakotaCommitteeRegistryLoader {
  const fetchCommittees = input.fetchCommittees ?? getAllNorthDakotaCommittees;
  let registry: Promise<NorthDakotaCommitteeRow[]> | null = null;
  return () => {
    registry ??= fetchCommittees({ pageSize: 1_000 }, input.clientOptions);
    return registry;
  };
}

export async function autoLinkNorthDakotaCandidateFinanceForCandidateElection(input: {
  db: Queryable;
  candidateElection: NorthDakotaFinanceAutoLinkCandidateElection;
  now: Date;
  loadRegistry: NorthDakotaCommitteeRegistryLoader;
}): Promise<NorthDakotaFinanceAutoLinkResult> {
  const candidate = input.candidateElection;
  const office = northDakotaEligibleOfficeForRace({
    officeScope: candidate.officeScope,
    officeCanonicalName: candidate.officeName,
  });
  if (office === null) {
    return { candidateId: candidate.candidateId, electionId: candidate.electionId, status: "unmatched", reason: "office_unmapped" };
  }
  const districtNumber = office.districted ? northDakotaDistrictNumberFromDistrictName(candidate.district) : null;
  if (office.districted && districtNumber === null) {
    return { candidateId: candidate.candidateId, electionId: candidate.electionId, status: "unmatched", reason: "district_unparseable" };
  }

  const resolution = resolveNorthDakotaCandidateCommittee({
    candidateName: candidate.candidateName,
    electionYear: candidate.electionYear,
    office,
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

  await upsertNorthDakotaFinanceLink({
    db: input.db,
    link: {
      candidateId: candidate.candidateId,
      electionId: candidate.electionId,
      electionYear: candidate.electionYear,
      candidateNameNormalized: normalizeNorthDakotaCandidateNameForStorage(candidate.candidateName),
      officeName: candidate.officeName,
      district: candidate.district,
      entityId: resolution.entityId,
      committeeName: resolution.committeeName,
      linkStatus: "active",
      linkSource: NORTH_DAKOTA_FINANCE_AUTOMATIC_LINK_SOURCE,
      sourceUrl: NORTH_DAKOTA_CFRS_SOURCE_URL,
      lastVerifiedAt: input.now,
    },
  });
  return {
    candidateId: candidate.candidateId,
    electionId: candidate.electionId,
    status: "linked",
    entityId: resolution.entityId,
    committeeName: resolution.committeeName,
    orgStatus: resolution.orgStatus,
  };
}

export async function autoLinkMissingNorthDakotaCandidateFinanceLinks(input: {
  db: Queryable;
  now: Date;
  maxCandidates: number;
  electionLookbackDays: number;
  electionLookaheadDays: number;
  candidateElections?: readonly NorthDakotaFinanceAutoLinkCandidateElection[];
  loadRegistry?: NorthDakotaCommitteeRegistryLoader;
  clientOptions?: NorthDakotaCfrsClientOptions;
}): Promise<NorthDakotaFinanceAutoLinkResult[]> {
  const candidates =
    input.candidateElections ??
    (await listNorthDakotaCandidateElectionsMissingFinanceLinks(input.db, {
      now: input.now,
      maxCandidates: input.maxCandidates,
      electionLookbackDays: input.electionLookbackDays,
      electionLookaheadDays: input.electionLookaheadDays,
    }));
  const loadRegistry =
    input.loadRegistry ?? createNorthDakotaCommitteeRegistryLoader({ clientOptions: input.clientOptions });
  const results: NorthDakotaFinanceAutoLinkResult[] = [];
  for (const candidate of candidates) {
    try {
      results.push(
        await autoLinkNorthDakotaCandidateFinanceForCandidateElection({
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
