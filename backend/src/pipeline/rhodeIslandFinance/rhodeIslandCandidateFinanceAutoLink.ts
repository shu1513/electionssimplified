import type { Pool, PoolClient } from "pg";

import {
  normalizeRhodeIslandCandidateNameForStorage,
  searchAndResolveRhodeIslandCandidateCommittee,
  type RhodeIslandCandidateCommitteeResolution,
  type RhodeIslandCandidateCommitteeSearchInput,
} from "./rhodeIslandCandidateCommitteeResolver.js";
import { ertsCycleWindowForYear } from "./rhodeIslandErtsArtifactAcquisition.js";
import type { ErtsTransport } from "./rhodeIslandErtsClient.js";
import { RHODE_ISLAND_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./rhodeIslandFinanceEligibleOffices.js";
import { upsertRhodeIslandFinanceLink } from "./rhodeIslandFinanceWriter.js";

// Auto-link for Rhode Island candidate finance, georgia pattern (per-candidate
// live portal search — ERTS has no bulk registry, so each unlinked candidate
// costs 3–5 paced requests) with one addition: a duplicate-claim guard. The
// search grid carries no office, district, or year, so the candidate's name is
// the ONLY matching evidence; two same-named candidates in different districts
// would otherwise both resolve to the one registered organization. Before any
// write, an OrgID already actively linked to a DIFFERENT candidate in the same
// election year blocks the link into manual review — the backstop that the
// office/district columns give other states' resolvers.
//
// Ambiguous and unmatched resolutions are reported but never written
// (fail-closed D3 rule); the ri_candidate_finance_links status vocabulary is
// active/inactive only (migration 236).

type Queryable = Pick<Pool | PoolClient, "query">;

export const RHODE_ISLAND_FINANCE_AUTO_LINK_SOURCE_URL =
  "https://www.ricampaignfinance.com/RIPublic/Contributions.aspx";

export type RhodeIslandFinanceAutoLinkCandidateElection = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district: string | null;
};

export type RhodeIslandFinanceAutoLinkResult =
  | {
      candidateId: string;
      electionId: string;
      status: RhodeIslandCandidateCommitteeResolution["status"] | "linked" | "needs_review";
      committeeId?: string;
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

export type RhodeIslandCandidateCommitteeResolver = (
  input: RhodeIslandCandidateCommitteeSearchInput,
  transport: ErtsTransport
) => Promise<RhodeIslandCandidateCommitteeResolution>;

function normalizeDistrict(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function mapCandidateElectionRow(row: CandidateElectionQueryRow): RhodeIslandFinanceAutoLinkCandidateElection {
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

// The eligible-population body shared VERBATIM by the selector and the
// coverage counter, so "eligible" cannot drift between them (the completeness
// report's whole premise). Placeholders: $1 = now, $2 = lookback days,
// $3 = lookahead days, $4 = eligible office keys.
const ELIGIBLE_CANDIDATE_ELECTIONS_SQL = `
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
        AND district.state = 'RI'
        AND election.race_type = 'office'
        AND election.election_date >= ($1::date - make_interval(days => $2::int))
        AND election.election_date <= ($1::date + make_interval(days => $3::int))
        AND candidate_election.status NOT IN ('withdrawn', 'lost')
        AND (office.scope || '::' || office.canonical_name) = ANY($4::text[])
        AND COALESCE(NULLIF(trim(candidate.display_name), ''), NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')) IS NOT NULL
`;

export async function listRhodeIslandCandidateElectionsMissingFinanceLinks(
  db: Queryable,
  input: {
    now: Date;
    maxCandidates: number;
    electionLookbackDays: number;
    electionLookaheadDays: number;
  }
): Promise<RhodeIslandFinanceAutoLinkCandidateElection[]> {
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
      ${ELIGIBLE_CANDIDATE_ELECTIONS_SQL}
        AND NOT EXISTS (
          SELECT 1
          FROM public.ri_candidate_finance_links AS link
          WHERE link.candidate_id = candidate.id
            AND link.election_id = election.id
            AND link.link_status = 'active'
        )
      -- Upcoming races first, then random: unmatched candidates never get a
      -- link, so a stable order under a row cap retried the same prefix every
      -- run and starved the tail (Katie Hobbs was never attempted).
      ORDER BY (election.election_date < CURRENT_DATE) ASC, random()
      LIMIT $5::int
    `,
    [
      input.now.toISOString(),
      input.electionLookbackDays,
      input.electionLookaheadDays,
      [...RHODE_ISLAND_FINANCE_ELIGIBLE_OFFICE_KEYS],
      input.maxCandidates,
    ]
  );

  return result.rows.map(mapCandidateElectionRow);
}

// The duplicate-claim guard's read; exported for the guard's own test.
//
// Read-then-write, like the rest of the auto-link fleet: the invariant ("one
// distinct candidate per committee-year among active links") is not
// expressible as a unique index — a candidate legitimately holds active links
// for BOTH the September primary and November general election rows of one
// cycle, same committee, same election_year. Concurrent runs are therefore
// not serialized here; runs are operator-serialized (one scheduler, paced
// portal requests), and an overlapping manual run is operator error.
export async function findRhodeIslandCommitteeClaim(
  db: Queryable,
  input: { committeeId: string; electionYear: number; candidateId: string }
): Promise<{ candidateId: string; electionId: string } | null> {
  const result = await db.query<{ candidate_id: string; election_id: string }>(
    `
      SELECT link.candidate_id::text AS candidate_id, link.election_id::text AS election_id
      FROM public.ri_candidate_finance_links AS link
      WHERE link.committee_id = $1
        AND link.election_year = $2
        AND link.candidate_id <> $3::uuid
        AND link.link_status = 'active'
      LIMIT 1
    `,
    [input.committeeId, input.electionYear, input.candidateId]
  );
  const row = result.rows[0];
  return row ? { candidateId: row.candidate_id, electionId: row.election_id } : null;
}

// The manual-disabled guard's read; exported for the guard's own test.
export async function findRhodeIslandDisabledManualLink(
  db: Queryable,
  input: { candidateId: string; electionId: string; committeeId: string }
): Promise<boolean> {
  const result = await db.query(
    `
      SELECT 1
      FROM public.ri_candidate_finance_links AS link
      WHERE link.candidate_id = $1::uuid
        AND link.election_id = $2::uuid
        AND link.committee_id = $3
        AND link.link_source = 'manual'
        AND link.link_status = 'inactive'
      LIMIT 1
    `,
    [input.candidateId, input.electionId, input.committeeId]
  );
  return result.rows.length > 0;
}

export async function autoLinkRhodeIslandCandidateFinanceForCandidateElection(input: {
  db: Queryable;
  candidateElection: RhodeIslandFinanceAutoLinkCandidateElection;
  transport: ErtsTransport;
  now: Date;
  resolveCandidateCommittee?: RhodeIslandCandidateCommitteeResolver;
}): Promise<RhodeIslandFinanceAutoLinkResult> {
  const { candidateElection } = input;
  const resolveCandidateCommittee = input.resolveCandidateCommittee ?? searchAndResolveRhodeIslandCandidateCommittee;
  // Throws on an odd election year — RI cycles end on even years, and a
  // special-election row outside that shape belongs in manual review, which
  // is where the per-candidate error isolation sends it.
  const cycle = ertsCycleWindowForYear(candidateElection.electionYear);
  const resolution = await resolveCandidateCommittee(
    {
      candidateName: candidateElection.candidateName,
      officeScope: candidateElection.officeScope,
      officeName: candidateElection.officeName,
      cycleBeginUs: cycle.beginUs,
      cycleEndUs: cycle.endUs,
    },
    input.transport
  );

  if (resolution.status === "ambiguous") {
    console.warn("Rhode Island finance auto-link found ambiguous ERTS organizations; leaving for manual review:", {
      candidateId: candidateElection.candidateId,
      electionId: candidateElection.electionId,
      candidateName: candidateElection.candidateName,
      matches: resolution.matches.map((match) => ({
        organizationName: match.organizationName,
        status: match.status,
      })),
    });
    return {
      candidateId: candidateElection.candidateId,
      electionId: candidateElection.electionId,
      status: resolution.status,
      reason: resolution.reason,
    };
  }
  if (resolution.status !== "matched") {
    return {
      candidateId: candidateElection.candidateId,
      electionId: candidateElection.electionId,
      status: resolution.status,
      reason: resolution.reason,
    };
  }

  // An operator-disabled manual row (manual + inactive) for this exact
  // pairing means "reviewed and switched off". The shared writer preserves a
  // manual row's status and source on upsert (the #667 anti-resurrection
  // rule), so writing here would be a silent no-op reported as "linked".
  // Surface it for review instead of writing.
  const disabledManual = await findRhodeIslandDisabledManualLink(input.db, {
    candidateId: candidateElection.candidateId,
    electionId: candidateElection.electionId,
    committeeId: resolution.orgId,
  });
  if (disabledManual) {
    return {
      candidateId: candidateElection.candidateId,
      electionId: candidateElection.electionId,
      status: "needs_review",
      reason: "manual_link_disabled",
      committeeId: resolution.orgId,
    };
  }

  const claim = await findRhodeIslandCommitteeClaim(input.db, {
    committeeId: resolution.orgId,
    electionYear: candidateElection.electionYear,
    candidateId: candidateElection.candidateId,
  });
  if (claim) {
    console.warn("Rhode Island finance auto-link refused a committee already linked to another candidate:", {
      candidateId: candidateElection.candidateId,
      electionId: candidateElection.electionId,
      candidateName: candidateElection.candidateName,
      committeeId: resolution.orgId,
      claimedByCandidateId: claim.candidateId,
    });
    return {
      candidateId: candidateElection.candidateId,
      electionId: candidateElection.electionId,
      status: "needs_review",
      reason: "committee_linked_to_another_candidate",
      committeeId: resolution.orgId,
    };
  }

  await upsertRhodeIslandFinanceLink({
    db: input.db,
    link: {
      candidateId: candidateElection.candidateId,
      electionId: candidateElection.electionId,
      electionYear: candidateElection.electionYear,
      candidateNameNormalized: normalizeRhodeIslandCandidateNameForStorage(candidateElection.candidateName),
      officeName: candidateElection.officeName,
      district: candidateElection.district,
      committeeId: resolution.orgId,
      committeeName: resolution.organizationName,
      linkStatus: "active",
      linkSource: "erts_portal",
      sourceUrl: resolution.sourceUrl,
      lastVerifiedAt: input.now,
    },
  });

  return {
    candidateId: candidateElection.candidateId,
    electionId: candidateElection.electionId,
    status: "linked",
    committeeId: resolution.orgId,
  };
}

export async function autoLinkMissingRhodeIslandCandidateFinanceLinks(input: {
  db: Queryable;
  transport: ErtsTransport;
  now: Date;
  maxCandidates: number;
  electionLookbackDays: number;
  electionLookaheadDays: number;
  candidateElections?: readonly RhodeIslandFinanceAutoLinkCandidateElection[];
  resolveCandidateCommittee?: RhodeIslandCandidateCommitteeResolver;
}): Promise<RhodeIslandFinanceAutoLinkResult[]> {
  const candidates =
    input.candidateElections ??
    (await listRhodeIslandCandidateElectionsMissingFinanceLinks(input.db, {
      now: input.now,
      maxCandidates: input.maxCandidates,
      electionLookbackDays: input.electionLookbackDays,
      electionLookaheadDays: input.electionLookaheadDays,
    }));

  const results: RhodeIslandFinanceAutoLinkResult[] = [];
  for (const candidateElection of candidates) {
    try {
      results.push(
        await autoLinkRhodeIslandCandidateFinanceForCandidateElection({
          db: input.db,
          candidateElection,
          transport: input.transport,
          now: input.now,
          resolveCandidateCommittee: input.resolveCandidateCommittee,
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("Rhode Island finance auto-link failed for candidate election; continuing:", {
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

// --- Roster completeness report ----------------------------------------------

export type RhodeIslandFinanceLinkCoverage = {
  eligibleCandidateElectionCount: number;
  activeLinkedCandidateElectionCount: number;
};

/**
 * Coverage over the SAME population the auto-link selector works from
 * (eligible offices, RI, election window, live candidacies) — so "eligible"
 * and "linked" cannot drift apart from the selector's own definition.
 */
export async function countRhodeIslandFinanceLinkCoverage(
  db: Queryable,
  input: {
    now: Date;
    electionLookbackDays: number;
    electionLookaheadDays: number;
  }
): Promise<RhodeIslandFinanceLinkCoverage> {
  const result = await db.query<{ eligible_count: string; linked_count: string }>(
    `
      SELECT
        count(*) AS eligible_count,
        count(*) FILTER (
          WHERE EXISTS (
            SELECT 1
            FROM public.ri_candidate_finance_links AS link
            WHERE link.candidate_id = candidate.id
              AND link.election_id = election.id
              AND link.link_status = 'active'
          )
        ) AS linked_count
      ${ELIGIBLE_CANDIDATE_ELECTIONS_SQL}
    `,
    [
      input.now.toISOString(),
      input.electionLookbackDays,
      input.electionLookaheadDays,
      [...RHODE_ISLAND_FINANCE_ELIGIBLE_OFFICE_KEYS],
    ]
  );
  const row = result.rows[0];
  return {
    eligibleCandidateElectionCount: Number(row?.eligible_count ?? 0),
    activeLinkedCandidateElectionCount: Number(row?.linked_count ?? 0),
  };
}

export type RhodeIslandFinanceAutoLinkTally = {
  attempted: number;
  linked: number;
  ambiguous: number;
  needsReview: number;
  errors: number;
  unmatchedByReason: Record<string, number>;
};

/** Pure tally of a run's results (the report's zero/one/multi-match split). */
export function tallyRhodeIslandFinanceAutoLinkResults(
  results: readonly RhodeIslandFinanceAutoLinkResult[]
): RhodeIslandFinanceAutoLinkTally {
  const tally: RhodeIslandFinanceAutoLinkTally = {
    attempted: results.length,
    linked: 0,
    ambiguous: 0,
    needsReview: 0,
    errors: 0,
    unmatchedByReason: {},
  };
  for (const result of results) {
    if (result.status === "linked") tally.linked += 1;
    else if (result.status === "ambiguous") tally.ambiguous += 1;
    else if (result.status === "needs_review") tally.needsReview += 1;
    else if (result.status === "error") tally.errors += 1;
    else {
      const reason = result.reason ?? "unknown";
      tally.unmatchedByReason[reason] = (tally.unmatchedByReason[reason] ?? 0) + 1;
    }
  }
  return tally;
}

export type RhodeIslandFinanceLinkCompletenessReport = RhodeIslandFinanceLinkCoverage & {
  linkedPercentage: number | null;
  autoLink: RhodeIslandFinanceAutoLinkTally;
};

/**
 * The PR 5 roster completeness report: coverage counts read AFTER the run
 * (so this run's links are included) plus the run's own tally. Consumed by
 * the sync CLI (PR 7) and the live-run report (PR 9).
 */
export async function buildRhodeIslandFinanceLinkCompletenessReport(
  db: Queryable,
  input: {
    now: Date;
    electionLookbackDays: number;
    electionLookaheadDays: number;
    autoLinkResults: readonly RhodeIslandFinanceAutoLinkResult[];
  }
): Promise<RhodeIslandFinanceLinkCompletenessReport> {
  const coverage = await countRhodeIslandFinanceLinkCoverage(db, {
    now: input.now,
    electionLookbackDays: input.electionLookbackDays,
    electionLookaheadDays: input.electionLookaheadDays,
  });
  return {
    ...coverage,
    linkedPercentage:
      coverage.eligibleCandidateElectionCount === 0
        ? null
        : Math.round(
            (coverage.activeLinkedCandidateElectionCount / coverage.eligibleCandidateElectionCount) * 1000
          ) / 10,
    autoLink: tallyRhodeIslandFinanceAutoLinkResults(input.autoLinkResults),
  };
}
