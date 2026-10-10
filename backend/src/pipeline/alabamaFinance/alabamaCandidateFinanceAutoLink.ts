// Alabama finance auto-link: creates missing candidate → race-row links
// (links only, never summaries). SC/Missouri shape: list candidate elections
// in eligible offices with no active link, resolve each against the office's
// FCPA race rows + committee-search district join, and write only full-name,
// district-confirmed matches with linkSource "fcpa_race_search" — the
// writer's manual-link protection guarantees operator links always win.
// Ambiguity, missing jurisdiction, and district conflicts are reported,
// never linked (docs/plans/plan-alabama-finance.md, Phase 3).

import type { Pool, PoolClient } from "pg";

import {
  ALABAMA_FCPA_BASE_URL,
  getAlabamaRaceRows,
  getAlabamaRaceSearchIds,
  searchAlabamaPrincipalCampaignCommittees,
  type AlabamaCommitteeSearchRow,
  type AlabamaFcpaClientOptions,
  type AlabamaRaceRow,
} from "./alabamaFcpaClient.js";
import {
  alabamaDistrictNumberFromDistrictName,
  normalizeAlabamaCandidateNameForStorage,
  resolveAlabamaCandidateRace,
  type AlabamaCandidateRaceMatch,
  type AlabamaDistrictChamber,
} from "./alabamaCandidateRaceResolver.js";
import {
  ALABAMA_FINANCE_ELIGIBLE_OFFICE_KEYS,
  alabamaFcpaElectionCycleIdForYear,
  alabamaFcpaOfficeIdForLabel,
  alabamaFcpaOfficeLabelForRace,
} from "./alabamaFinanceEligibleOffices.js";
import {
  updateAlabamaFinanceLinkFcpaCommitteeNumber,
  upsertAlabamaFinanceLink,
} from "./alabamaFinanceWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export const ALABAMA_FCPA_RACE_SEARCH_URL = `${ALABAMA_FCPA_BASE_URL}/page.request.do?page=page.acfPublicPoliticalRaceSearch`;

export type AlabamaFinanceAutoLinkCandidateElection = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  ballotTitle: string;
  district: string | null;
};

export type AlabamaFinanceAutoLinkResult = {
  candidateId: string;
  electionId: string;
  status: "linked" | "manual_confirm_required" | "ambiguous" | "unmatched" | "error";
  reason?: string;
  internalCommitteeId?: number;
  fcpaCommitteeNumber?: string | null;
  candidates?: AlabamaCandidateRaceMatch[];
  error?: string;
};

type CandidateElectionQueryRow = {
  candidate_id: string;
  election_id: string;
  candidate_name: string;
  election_year: number;
  office_scope: string;
  office_name: string;
  ballot_title: string;
  district_name: string | null;
};

export async function listAlabamaCandidateElectionsMissingFinanceLinks(
  db: Queryable,
  input: { now: Date; maxCandidates: number; electionLookbackDays: number; electionLookaheadDays: number }
): Promise<AlabamaFinanceAutoLinkCandidateElection[]> {
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
        election.official_ballot_title AS ballot_title,
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
        AND district.state = 'AL'
        AND election.race_type = 'office'
        AND election.election_stage = 'general'
        AND election.election_date >= ($1::date - make_interval(days => $3::int))
        AND election.election_date <= ($1::date + make_interval(days => $4::int))
        AND candidate_election.status NOT IN ('withdrawn', 'lost')
        AND (office.scope || '::' || office.canonical_name) = ANY($5::text[])
        AND COALESCE(NULLIF(trim(candidate.display_name), ''), NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.al_candidate_finance_links AS link
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
      [...ALABAMA_FINANCE_ELIGIBLE_OFFICE_KEYS],
    ]
  );
  return result.rows.map((row) => ({
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    ballotTitle: row.ballot_title,
    district: row.district_name,
  }));
}

export type AlabamaOfficeRaceContext = {
  raceRows: AlabamaRaceRow[];
  committeeRowsByInternalId: Map<number, AlabamaCommitteeSearchRow>;
};

/**
 * One live fetch per (cycle, office label) per run: race rows plus the
 * office-scoped committee search that carries the district jurisdiction and
 * the extract-side FCPA committee number.
 */
export function createAlabamaOfficeRaceContextLoader(input: {
  clientOptions?: AlabamaFcpaClientOptions;
  fetchRaceSearchIds?: typeof getAlabamaRaceSearchIds;
  fetchRaceRows?: typeof getAlabamaRaceRows;
  fetchCommittees?: typeof searchAlabamaPrincipalCampaignCommittees;
}): (electionYear: number, officeLabel: string) => Promise<AlabamaOfficeRaceContext> {
  const fetchIds = input.fetchRaceSearchIds ?? getAlabamaRaceSearchIds;
  const fetchRaceRows = input.fetchRaceRows ?? getAlabamaRaceRows;
  const fetchCommittees = input.fetchCommittees ?? searchAlabamaPrincipalCampaignCommittees;
  let idsPromise: ReturnType<typeof getAlabamaRaceSearchIds> | null = null;
  const contexts = new Map<string, Promise<AlabamaOfficeRaceContext>>();
  return (electionYear, officeLabel) => {
    const key = `${electionYear}|${officeLabel}`;
    let context = contexts.get(key);
    if (context === undefined) {
      context = (async () => {
        idsPromise ??= fetchIds(input.clientOptions);
        const ids = await idsPromise;
        const cycleId = alabamaFcpaElectionCycleIdForYear(electionYear, ids.elections);
        if (cycleId === null) {
          throw new Error(`Alabama FCPA has no "${electionYear} ELECTION CYCLE" election option`);
        }
        const officeId = alabamaFcpaOfficeIdForLabel(officeLabel, ids.offices);
        if (officeId === null) {
          throw new Error(`Alabama FCPA office dropdown has no "${officeLabel}" option`);
        }
        // Sequential on purpose — the plan caps portal concurrency at 1-2.
        const raceRows = await fetchRaceRows({ electionId: cycleId, officeId }, input.clientOptions);
        const committees = await fetchCommittees({ officeId }, input.clientOptions);
        const committeeRowsByInternalId = new Map<number, AlabamaCommitteeSearchRow>();
        for (const committee of committees) {
          committeeRowsByInternalId.set(committee.id, committee);
        }
        return { raceRows, committeeRowsByInternalId };
      })();
      contexts.set(key, context);
    }
    return context;
  };
}

function districtRequirementFor(
  candidate: AlabamaFinanceAutoLinkCandidateElection
): { chamber: AlabamaDistrictChamber; district: number } | null | "unparseable" {
  const chamber: AlabamaDistrictChamber | null =
    candidate.officeScope === "state_lower"
      ? "HOUSE"
      : candidate.officeScope === "state_upper"
        ? "SENATE"
        : null;
  if (chamber === null) {
    return null;
  }
  const district = alabamaDistrictNumberFromDistrictName(candidate.district);
  if (district === null) {
    return "unparseable";
  }
  return { chamber, district };
}

export async function autoLinkAlabamaCandidateFinanceForCandidateElection(input: {
  db: Queryable;
  candidateElection: AlabamaFinanceAutoLinkCandidateElection;
  now: Date;
  loadOfficeRaceContext: (electionYear: number, officeLabel: string) => Promise<AlabamaOfficeRaceContext>;
}): Promise<AlabamaFinanceAutoLinkResult> {
  const candidate = input.candidateElection;
  const officeLabel = alabamaFcpaOfficeLabelForRace({
    officeScope: candidate.officeScope,
    officeCanonicalName: candidate.officeName,
    ballotTitle: candidate.ballotTitle,
  });
  if (officeLabel === null) {
    return {
      candidateId: candidate.candidateId,
      electionId: candidate.electionId,
      status: "unmatched",
      reason: "office_unmapped",
    };
  }
  const district = districtRequirementFor(candidate);
  if (district === "unparseable") {
    return {
      candidateId: candidate.candidateId,
      electionId: candidate.electionId,
      status: "unmatched",
      reason: "district_unparseable",
    };
  }

  const context = await input.loadOfficeRaceContext(candidate.electionYear, officeLabel);
  const resolution = resolveAlabamaCandidateRace({
    candidateName: candidate.candidateName,
    raceRows: context.raceRows,
    committeeRowsByInternalId: context.committeeRowsByInternalId,
    district,
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
  if (resolution.status === "manual_confirm_required") {
    return {
      candidateId: candidate.candidateId,
      electionId: candidate.electionId,
      status: "manual_confirm_required",
      reason: resolution.reason,
      candidates: resolution.candidates,
    };
  }

  await upsertAlabamaFinanceLink({
    db: input.db,
    link: {
      candidateId: candidate.candidateId,
      electionId: candidate.electionId,
      electionYear: candidate.electionYear,
      candidateNameNormalized: normalizeAlabamaCandidateNameForStorage(candidate.candidateName),
      officeName: candidate.officeName,
      district: candidate.district,
      internalCommitteeId: resolution.internalCommitteeId,
      committeeName: resolution.committeeName ?? resolution.raceCandidateName,
      linkStatus: "active",
      linkSource: "fcpa_race_search",
      sourceUrl: ALABAMA_FCPA_RACE_SEARCH_URL,
      lastVerifiedAt: input.now,
    },
  });
  // Not atomic with the upsert; a crash here leaves fcpa_committee_number
  // NULL, and the sync self-heals it from the same committee-search join.
  if (resolution.fcpaCommitteeNumber !== null) {
    await updateAlabamaFinanceLinkFcpaCommitteeNumber({
      db: input.db,
      candidateId: candidate.candidateId,
      electionId: candidate.electionId,
      internalCommitteeId: resolution.internalCommitteeId,
      fcpaCommitteeNumber: resolution.fcpaCommitteeNumber,
    });
  }
  return {
    candidateId: candidate.candidateId,
    electionId: candidate.electionId,
    status: "linked",
    internalCommitteeId: resolution.internalCommitteeId,
    fcpaCommitteeNumber: resolution.fcpaCommitteeNumber,
  };
}

export async function autoLinkMissingAlabamaCandidateFinanceLinks(input: {
  db: Queryable;
  now: Date;
  maxCandidates: number;
  electionLookbackDays: number;
  electionLookaheadDays: number;
  candidateElections?: readonly AlabamaFinanceAutoLinkCandidateElection[];
  loadOfficeRaceContext?: (electionYear: number, officeLabel: string) => Promise<AlabamaOfficeRaceContext>;
  clientOptions?: AlabamaFcpaClientOptions;
}): Promise<AlabamaFinanceAutoLinkResult[]> {
  const candidates =
    input.candidateElections ??
    (await listAlabamaCandidateElectionsMissingFinanceLinks(input.db, {
      now: input.now,
      maxCandidates: input.maxCandidates,
      electionLookbackDays: input.electionLookbackDays,
      electionLookaheadDays: input.electionLookaheadDays,
    }));
  const loadOfficeRaceContext =
    input.loadOfficeRaceContext ??
    createAlabamaOfficeRaceContextLoader({ clientOptions: input.clientOptions });
  const results: AlabamaFinanceAutoLinkResult[] = [];
  for (const candidate of candidates) {
    try {
      results.push(
        await autoLinkAlabamaCandidateFinanceForCandidateElection({
          db: input.db,
          candidateElection: candidate,
          now: input.now,
          loadOfficeRaceContext,
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
