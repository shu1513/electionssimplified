// New Hampshire finance auto-link: creates missing candidate -> filing-entity
// links (links only, never summaries). Idaho/Kansas shape: list candidate
// elections in eligible offices with no active link, pull the CFS filing-entity
// registry ONCE per election cycle, resolve locally with the shared resolver,
// and write only exact office + district + full-name matches whose
// registration is Active, with linkSource "cfs_registration". The writer's
// manual-link protection guarantees operator links always win; ambiguity,
// misses, and non-Active registrations are reported, never linked.

import type { Pool, PoolClient } from "pg";

import {
  getAllNewHampshireFilingEntities,
  getNewHampshireElectionCycles,
  type NewHampshireCfsClientOptions,
  type NewHampshireElectionCycle,
  type NewHampshireFilingEntityRow,
} from "./newHampshireCfsClient.js";
import {
  isActiveNewHampshireRegistration,
  NEW_HAMPSHIRE_CFS_ACTIVE_REGISTRATION_STATUS,
  normalizeNewHampshireCandidateNameForStorage,
  resolveNewHampshireCandidateFiler,
  type NewHampshireCandidateFilerMatch,
  type NewHampshireCandidateFilerResolution,
} from "./newHampshireCandidateFilerResolver.js";
import { NEW_HAMPSHIRE_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./newHampshireFinanceEligibleOffices.js";
import {
  upsertNewHampshireFinanceLink,
  type NewHampshireFinanceLinkSource,
} from "./newHampshireFinanceWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;

/** Public portal; the same default the per-candidate sync stores as sourceUrl. */
export const NEW_HAMPSHIRE_CFS_PUBLIC_URL = "https://cfs.sos.nh.gov/";
export const NEW_HAMPSHIRE_FINANCE_AUTOMATIC_LINK_SOURCE: NewHampshireFinanceLinkSource = "cfs_registration";
export { NEW_HAMPSHIRE_CFS_ACTIVE_REGISTRATION_STATUS };

/** The registry calls shared by the auto-link and the batch sync. */
export type NewHampshireCfsRegistryClient = {
  getElectionCycles: (options?: NewHampshireCfsClientOptions) => Promise<NewHampshireElectionCycle[]>;
  getFilingEntities: (
    input: { electionCycleId: number },
    options?: NewHampshireCfsClientOptions
  ) => Promise<NewHampshireFilingEntityRow[]>;
};

export const DEFAULT_NEW_HAMPSHIRE_CFS_REGISTRY_CLIENT: NewHampshireCfsRegistryClient = {
  getElectionCycles: getNewHampshireElectionCycles,
  getFilingEntities: getAllNewHampshireFilingEntities,
};

/**
 * The CFS keys every search by a numeric election-cycle ID, not by year. The
 * cycle list names them "<year> Election Cycle" (probe precedent); exactly one
 * must match or the year cannot be searched safely.
 */
export function resolveNewHampshireElectionCycleId(input: {
  cycles: readonly NewHampshireElectionCycle[];
  electionYear: number;
}): number {
  const expectedName = `${input.electionYear} Election Cycle`;
  const matches = input.cycles.filter((cycle) => cycle.name === expectedName);
  if (matches.length !== 1) {
    throw new Error(`Expected one New Hampshire CFS cycle named ${expectedName}; found ${matches.length}`);
  }
  return matches[0]!.value;
}

export type NewHampshireFinanceAutoLinkCandidateElection = {
  candidateId: string;
  electionId: string;
  /** Display name first, then the structured "First Last" spelling. */
  candidateNames: string[];
  electionYear: number;
  officeScope: string;
  officeName: string;
  /** VoteApp district name (county-qualified for House / commissioner seats). */
  district: string | null;
};

export type NewHampshireFinanceAutoLinkMatchSummary = {
  filingEntityId: number;
  filerName: string;
  /** Distinct CFS statuses of that entity's candidate registrations in the cycle. */
  statuses: string[];
};

export type NewHampshireFinanceAutoLinkResult = {
  candidateId: string;
  electionId: string;
  status: "linked" | "ambiguous" | "unmatched" | "error";
  reason?: string;
  electionCycleId?: number;
  filingEntityId?: number;
  filerName?: string;
  district?: string | null;
  confidence?: NewHampshireCandidateFilerMatch["confidence"];
  matches?: NewHampshireFinanceAutoLinkMatchSummary[];
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
};

// No default cap: unmatched and ambiguous candidates never receive a link, so
// they stay at the front of this ordered list on every run and a fixed LIMIT
// would starve everyone behind them. maxCandidates is an operator valve,
// null = all.
export async function listNewHampshireCandidateElectionsMissingFinanceLinks(
  db: Queryable,
  input: { now: Date; maxCandidates: number | null; electionLookbackDays: number; electionLookaheadDays: number }
): Promise<NewHampshireFinanceAutoLinkCandidateElection[]> {
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
        AND district.state = 'NH'
        AND election.race_type = 'office'
        AND election.election_stage = 'general'
        AND election.election_date >= ($1::date - make_interval(days => $3::int))
        AND election.election_date <= ($1::date + make_interval(days => $4::int))
        AND candidate_election.status NOT IN ('withdrawn', 'lost')
        AND (office.scope || '::' || office.canonical_name) = ANY($5::text[])
        AND COALESCE(NULLIF(trim(candidate.display_name), ''), NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.nh_candidate_finance_links AS link
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
      [...NEW_HAMPSHIRE_FINANCE_ELIGIBLE_OFFICE_KEYS],
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
  }));
}

// The resolver takes one spelling; try the display name first, then the
// structured "First Last" one, and keep the first spelling that finds any
// registration (matched or ambiguous). All-miss returns the first miss.
function resolveAcrossNames(input: {
  candidate: NewHampshireFinanceAutoLinkCandidateElection;
  electionCycleId: number;
  filingEntityRows: readonly NewHampshireFilingEntityRow[];
}): NewHampshireCandidateFilerResolution {
  let firstMiss: NewHampshireCandidateFilerResolution | null = null;
  for (const candidateName of input.candidate.candidateNames) {
    const resolution = resolveNewHampshireCandidateFiler({
      candidateName,
      officeScope: input.candidate.officeScope,
      officeName: input.candidate.officeName,
      district: input.candidate.district,
      electionCycleId: input.electionCycleId,
      filingEntityRows: input.filingEntityRows,
      sourceUrl: NEW_HAMPSHIRE_CFS_PUBLIC_URL,
    });
    if (resolution.status !== "unmatched") return resolution;
    firstMiss ??= resolution;
  }
  return (
    firstMiss ?? {
      status: "unmatched",
      reason: "missing_candidate_name",
      candidateNameNormalized: "",
      officeNameNormalized: input.candidate.officeName,
    }
  );
}

function summarizeMatches(input: {
  matches: readonly NewHampshireCandidateFilerMatch[];
  electionCycleId: number;
  filingEntityRows: readonly NewHampshireFilingEntityRow[];
}): NewHampshireFinanceAutoLinkMatchSummary[] {
  return input.matches.map((match) => ({
    filingEntityId: match.filingEntityId,
    filerName: match.filerName,
    statuses: [
      ...new Set(
        input.filingEntityRows
          .filter((row) => row.filingEntityId === match.filingEntityId && row.electionCycleId === input.electionCycleId)
          .map((row) => row.status.trim())
      ),
    ].sort((left, right) => left.localeCompare(right)),
  }));
}

export async function autoLinkNewHampshireCandidateFinanceForCandidateElection(input: {
  db: Queryable;
  candidateElection: NewHampshireFinanceAutoLinkCandidateElection;
  electionCycleId: number;
  /** Every filing-entity row of the cycle (any status); the Active gate is applied here. */
  filingEntityRows: readonly NewHampshireFilingEntityRow[];
  now: Date;
  /** Resolve and report without writing links. */
  dryRun?: boolean;
}): Promise<NewHampshireFinanceAutoLinkResult> {
  const candidate = input.candidateElection;
  const base = { candidateId: candidate.candidateId, electionId: candidate.electionId, electionCycleId: input.electionCycleId };
  const activeRows = input.filingEntityRows.filter(isActiveNewHampshireRegistration);
  const resolution = resolveAcrossNames({ candidate, electionCycleId: input.electionCycleId, filingEntityRows: activeRows });
  if (resolution.status === "ambiguous") {
    return {
      ...base,
      status: "ambiguous",
      reason: resolution.reason,
      matches: summarizeMatches({ matches: resolution.matches, electionCycleId: input.electionCycleId, filingEntityRows: input.filingEntityRows }),
    };
  }
  if (resolution.status === "unmatched") {
    // A registration that fails only the Active gate is worth an operator's
    // look (Idaho precedent: a lone Terminated registration is reported).
    if (resolution.reason === "no_candidate_filer_match") {
      const anyStatus = resolveAcrossNames({ candidate, electionCycleId: input.electionCycleId, filingEntityRows: input.filingEntityRows });
      if (anyStatus.status !== "unmatched") {
        const matches = anyStatus.status === "matched" ? [anyStatus] : anyStatus.matches;
        return {
          ...base,
          status: "unmatched",
          reason: "no_active_registration",
          matches: summarizeMatches({ matches, electionCycleId: input.electionCycleId, filingEntityRows: input.filingEntityRows }),
        };
      }
    }
    return { ...base, status: "unmatched", reason: resolution.reason };
  }

  if (!input.dryRun) {
    await upsertNewHampshireFinanceLink({
      db: input.db,
      link: {
        candidateId: candidate.candidateId,
        electionId: candidate.electionId,
        electionYear: candidate.electionYear,
        candidateNameNormalized: normalizeNewHampshireCandidateNameForStorage(candidate.candidateNames[0] ?? ""),
        officeName: resolution.officeName,
        district: resolution.district,
        filingEntityId: resolution.filingEntityId,
        filerName: resolution.filerName,
        linkStatus: "active",
        linkSource: NEW_HAMPSHIRE_FINANCE_AUTOMATIC_LINK_SOURCE,
        sourceUrl: resolution.sourceUrl,
        lastVerifiedAt: input.now,
      },
    });
  }
  return {
    ...base,
    status: "linked",
    filingEntityId: resolution.filingEntityId,
    filerName: resolution.filerName,
    district: resolution.district,
    confidence: resolution.confidence,
  };
}

export async function autoLinkMissingNewHampshireCandidateFinanceLinks(input: {
  db: Queryable;
  now: Date;
  maxCandidates: number | null;
  electionLookbackDays: number;
  electionLookaheadDays: number;
  dryRun?: boolean;
  candidateElections?: readonly NewHampshireFinanceAutoLinkCandidateElection[];
  /** Preloaded cycle list; otherwise fetched once when a candidate needs it. */
  electionCycles?: readonly NewHampshireElectionCycle[];
  cfsClient?: Partial<NewHampshireCfsRegistryClient>;
  cfsClientOptions?: NewHampshireCfsClientOptions;
}): Promise<NewHampshireFinanceAutoLinkResult[]> {
  const candidates =
    input.candidateElections ??
    (await listNewHampshireCandidateElectionsMissingFinanceLinks(input.db, {
      now: input.now,
      maxCandidates: input.maxCandidates,
      electionLookbackDays: input.electionLookbackDays,
      electionLookaheadDays: input.electionLookaheadDays,
    }));
  if (candidates.length === 0) return [];

  const client: NewHampshireCfsRegistryClient = { ...DEFAULT_NEW_HAMPSHIRE_CFS_REGISTRY_CLIENT, ...(input.cfsClient ?? {}) };
  // Each registry pull happens at most once per run — the promises are
  // memoized, rejection included, so an outage costs one timeout, not one
  // per candidate.
  let cyclesPromise: Promise<readonly NewHampshireElectionCycle[]> | null = input.electionCycles
    ? Promise.resolve(input.electionCycles)
    : null;
  const loadCycles = () => (cyclesPromise ??= client.getElectionCycles(input.cfsClientOptions));
  const rowsByCycle = new Map<number, Promise<NewHampshireFilingEntityRow[]>>();
  const loadRows = (electionCycleId: number) => {
    let rows = rowsByCycle.get(electionCycleId);
    if (!rows) {
      rows = client.getFilingEntities({ electionCycleId }, input.cfsClientOptions);
      rowsByCycle.set(electionCycleId, rows);
    }
    return rows;
  };

  const results: NewHampshireFinanceAutoLinkResult[] = [];
  for (const candidate of candidates) {
    try {
      const electionCycleId = resolveNewHampshireElectionCycleId({
        cycles: await loadCycles(),
        electionYear: candidate.electionYear,
      });
      results.push(
        await autoLinkNewHampshireCandidateFinanceForCandidateElection({
          db: input.db,
          candidateElection: candidate,
          electionCycleId,
          filingEntityRows: await loadRows(electionCycleId),
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
