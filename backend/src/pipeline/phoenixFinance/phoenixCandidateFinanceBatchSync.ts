// Phase 3 batch sync (the SD Phase 3 module reshaped for a live-portal
// source): the run-level context — canonical registration index + the
// city-filing IE PACs' parsed Schedule B(6) pool — is loaded ONCE per run
// and threaded through both legs:
//
//   1. Auto-link candidates missing active links (warn-and-continue — a
//      linking failure must not stop existing links from syncing). The
//      Phase 3 report parser now feeds the resolver's name tier: for
//      candidates without a curated COP id, the covers of their
//      name-matching candidate-committee registrations are parsed so the
//      cover-corroboration gate can actually pass.
//   2. The stalest-first candidate loop over active links.
//
// A context load failure fails the WHOLE run (every result errored): the
// registration index is the committee-presence authority and the B(6) pool
// feeds every candidate's outside totals — syncing without either would
// publish from a half-loaded source.

import type { Pool, PoolClient } from "pg";
import {
  autoLinkMissingPhoenixCandidateFinanceLinks,
  listPhoenixCandidateElectionsMissingFinanceLinks,
} from "./phoenixCandidateFinanceAutoLink.js";
import {
  buildPhoenixCoverOfficeSoughtIndex,
  loadPhoenixFinanceRunContext,
  syncPhoenixCandidateFinance,
  type PhoenixCandidateFinanceSyncResult,
  type PhoenixFinanceRunContext,
} from "./phoenixCandidateFinanceSync.js";
import {
  phoenixPersonNameMatchesCandidate,
} from "./phoenixCandidateCommitteeResolver.js";
import { PHOENIX_CANDIDATE_COMMITTEE_TYPE } from "./phoenixCandidateCommitteeResolver.js";
import { parsePhoenixCityCouncilDistrictNumber, PHOENIX_CITY_GEOID } from "./phoenixFinanceEligibleOffices.js";
import { PHOENIX_TEST_COMMITTEE_PATTERN } from "./phoenixEfilingClient.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type PoolLike = Queryable & { connect: () => Promise<PoolClient> };

const PHOENIX_DISTRICT_PREDICATE = `district.state='AZ' AND district.district_type='place' AND district.geoid_compact='${PHOENIX_CITY_GEOID}'`;

type DueRow = {
  candidate_id: string;
  election_id: string;
  election_year: number;
  candidate_name: string;
  office_name: string;
  official_ballot_title: string | null;
  election_date: string;
  cop_id: string;
  portal_cycle_start: string;
  portal_cycle_end: string;
  last_synced_at: string | null;
  total_due_rows: string | number;
};

export type PhoenixCandidateFinanceBatchSyncResult = {
  dryRun: boolean;
  dueCandidateCount: number;
  selectedCandidateCount: number;
  syncedCandidateCount: number;
  failedCandidateCount: number;
  autoLinkAttemptedCount: number;
  autoLinkLinkedCount: number;
  /** Run-context diagnostics (IE census + B(6) pool size); null when the
   * context load itself failed. */
  contextDiagnostics: PhoenixFinanceRunContext["diagnostics"] | null;
  results: Array<{
    candidateId: string;
    electionId: string;
    ok: boolean;
    error?: string;
    result?: PhoenixCandidateFinanceSyncResult;
  }>;
};

const integer = (
  value: number | undefined,
  fallback: number,
  label: string,
): number => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0)
    throw new Error(`Invalid Phoenix finance ${label}: ${result}`);
  return result;
};

// Validated up front so a mistyped backfill target fails loudly here instead
// of as a Postgres cast error after the auto-link leg already ran.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function syncDuePhoenixCandidateFinance(input: {
  db: PoolLike;
  now?: Date;
  dryRun?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  /**
   * Historical-backfill targeting: sync ONLY this election's active links.
   * Replaces the election-date window, drops the withdrawn/lost exclusion
   * (in a decided election the losers are the point of the backfill), drops
   * the staleness filter, and skips the auto-link leg.
   */
  electionId?: string;
  autoLinkMissingLinks?: boolean;
  bypassAnomalyCheck?: boolean;
  /** Test seams; default to the real implementations. */
  loadRunContext?: typeof loadPhoenixFinanceRunContext;
  buildCoverIndex?: typeof buildPhoenixCoverOfficeSoughtIndex;
  syncCandidateFn?: typeof syncPhoenixCandidateFinance;
  seams?: Parameters<typeof loadPhoenixFinanceRunContext>[0];
}): Promise<PhoenixCandidateFinanceBatchSyncResult> {
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime()))
    throw new Error("Invalid Phoenix finance batch timestamp");
  const max = integer(input.maxCandidates, 25, "maxCandidates"),
    stale = integer(input.staleAfterDays, 1, "staleAfterDays"),
    lookback = integer(input.electionLookbackDays, 45, "electionLookbackDays"),
    lookahead = integer(
      input.electionLookaheadDays,
      730,
      "electionLookaheadDays",
    );
  const electionId = input.electionId?.trim() || undefined;
  if (electionId !== undefined && !UUID_PATTERN.test(electionId))
    throw new Error(`Invalid Phoenix finance electionId: ${electionId}`);
  const loadRunContext = input.loadRunContext ?? loadPhoenixFinanceRunContext;
  const buildCoverIndex = input.buildCoverIndex ?? buildPhoenixCoverOfficeSoughtIndex;
  const syncCandidateFn = input.syncCandidateFn ?? syncPhoenixCandidateFinance;

  // --- Due selection FIRST (cheap, DB-only) so a run with nothing to do
  // never touches the portal. ---
  const dueScope =
    electionId === undefined
      ? {
          where: `election.election_date>=(($1::timestamptz AT TIME ZONE 'UTC')::date-make_interval(days=>$4::int)) AND election.election_date<=(($1::timestamptz AT TIME ZONE 'UTC')::date+make_interval(days=>$5::int)) AND ce.status NOT IN ('withdrawn','lost') AND (summary.last_synced_at IS NULL OR summary.last_synced_at<($1::timestamptz-make_interval(days=>$2::int)))`,
          limit: "$3::int",
          params: [now.toISOString(), stale, max, lookback, lookahead],
        }
      : {
          where: `election.id=$1::uuid`,
          limit: "$2::int",
          params: [electionId, max],
        };
  // The outer ORDER BY repeats the CTE's keys on purpose: Postgres happens
  // to preserve CTE order for this shape, but the standard does not
  // guarantee it, and the stalest-first contract must not rest on luck.
  const due = await input.db.query<DueRow>(
    `WITH due AS (SELECT link.candidate_id::text candidate_id,link.election_id::text election_id,link.election_year,COALESCE(NULLIF(trim(candidate.display_name),''),link.candidate_name_normalized) candidate_name,office.canonical_name office_name,election.official_ballot_title,election.election_date::text election_date,link.cop_id,link.portal_cycle_start::text portal_cycle_start,link.portal_cycle_end::text portal_cycle_end,link.candidate_name_normalized,summary.last_synced_at last_synced_at_ts,summary.last_synced_at::text last_synced_at,count(*) OVER() total_due_rows FROM public.phx_candidate_finance_links link JOIN public.candidates candidate ON candidate.id=link.candidate_id JOIN public.candidate_elections ce ON ce.candidate_id=link.candidate_id AND ce.election_id=link.election_id JOIN public.elections election ON election.id=link.election_id JOIN public.districts district ON district.id=election.district_id JOIN public.offices office ON office.id=election.office_id LEFT JOIN public.phx_candidate_finance_summaries summary ON summary.link_id=link.id AND summary.election_year=link.election_year WHERE link.link_status='active' AND candidate.deleted_at IS NULL AND ${PHOENIX_DISTRICT_PREDICATE} AND ${dueScope.where} ORDER BY summary.last_synced_at NULLS FIRST,election.election_date,link.candidate_name_normalized LIMIT ${dueScope.limit}) SELECT * FROM due ORDER BY last_synced_at_ts NULLS FIRST,election_date,candidate_name_normalized`,
    dueScope.params,
  );

  // --- Missing-link selection (auto-link leg input). ---
  const missing =
    !input.dryRun && electionId === undefined && input.autoLinkMissingLinks !== false
      ? await listPhoenixCandidateElectionsMissingFinanceLinks(input.db, {
          now,
          maxCandidates: max,
          electionLookbackDays: lookback,
          electionLookaheadDays: lookahead,
        }).catch((error) => {
          console.warn(
            "Phoenix finance auto-link selection failed; continuing existing links",
            error instanceof Error ? error.message : error,
          );
          return [];
        })
      : [];

  if (due.rows.length === 0 && missing.length === 0) {
    return {
      dryRun: Boolean(input.dryRun),
      dueCandidateCount: 0,
      selectedCandidateCount: 0,
      syncedCandidateCount: 0,
      failedCandidateCount: 0,
      autoLinkAttemptedCount: 0,
      autoLinkLinkedCount: 0,
      contextDiagnostics: null,
      results: [],
    };
  }

  // --- Run context (portal fetch + B(6) pool). Failure fails the run. ---
  let context: PhoenixFinanceRunContext;
  try {
    context = await loadRunContext(input.seams ?? {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      dryRun: Boolean(input.dryRun),
      dueCandidateCount: due.rows.length ? Number(due.rows[0]!.total_due_rows) : 0,
      selectedCandidateCount: due.rows.length,
      syncedCandidateCount: 0,
      failedCandidateCount: due.rows.length,
      autoLinkAttemptedCount: 0,
      autoLinkLinkedCount: 0,
      contextDiagnostics: null,
      results: due.rows.map((row) => ({
        candidateId: row.candidate_id,
        electionId: row.election_id,
        ok: false,
        error: `run context load failed: ${message}`,
      })),
    };
  }

  // --- Leg 1: auto-link. Covers are parsed only for the name-tier
  // candidates' name-matching candidate-committee registrations (candidates
  // WITH a curated COP-shaped id resolve on the id tier and need none). ---
  let attempted = 0,
    linked = 0;
  if (missing.length > 0) {
    try {
      attempted = missing.length;
      const COP_SHAPED = /^(?:CAN|PAC|IE|MC)-\d{2}-\d+$/;
      const nameTierCandidates = missing.filter(
        (candidate) =>
          !candidate.stateFilingIds.some((id) =>
            COP_SHAPED.test(id.trim().toUpperCase()),
          ),
      );
      const coverCopIds: string[] = [];
      for (const candidate of nameTierCandidates) {
        for (const committee of context.registrations) {
          if (committee.committeeType !== PHOENIX_CANDIDATE_COMMITTEE_TYPE) continue;
          if (PHOENIX_TEST_COMMITTEE_PATTERN.test(committee.committeeName)) continue;
          if (committee.terminated) continue;
          if (
            committee.candidateName !== null &&
            phoenixPersonNameMatchesCandidate(
              committee.candidateName,
              candidate.candidateName,
            )
          ) {
            coverCopIds.push(committee.copId);
          }
        }
      }
      const covers =
        coverCopIds.length > 0
          ? await buildCoverIndex({ copIds: coverCopIds, seams: input.seams })
          : new Map<string, readonly string[]>();
      const linkResults = await autoLinkMissingPhoenixCandidateFinanceLinks({
        db: input.db,
        now,
        candidates: missing,
        committees: context.registrations,
        coverOfficeSoughtByCopId: covers,
      });
      linked = linkResults.filter((row) => row.status === "linked").length;
      for (const row of linkResults)
        if (row.status !== "linked" && row.status !== "no_committee")
          console.warn(
            "Phoenix finance auto-link did not link candidate election:",
            row,
          );
    } catch (error) {
      console.warn(
        "Phoenix finance auto-link skipped; continuing existing links",
        error instanceof Error ? error.message : error,
      );
    }
  }

  // --- Candidate loop: stalest first (never-synced links lead via NULLS
  // FIRST, so reruns resume partial failures before touching synced rows).
  const results: PhoenixCandidateFinanceBatchSyncResult["results"] = [];
  for (const row of due.rows) {
    try {
      const officeName = row.office_name.trim();
      if (officeName !== "Mayor" && officeName !== "City Council Member")
        throw new Error(
          `Linked election office "${officeName}" is not a Phoenix finance office`,
        );
      const districtNumber =
        officeName === "Mayor"
          ? null
          : parsePhoenixCityCouncilDistrictNumber(row.official_ballot_title);
      if (officeName === "City Council Member" && districtNumber === null)
        throw new Error(
          `Cannot parse a council district from ballot title "${row.official_ballot_title}"`,
        );
      const result = await syncCandidateFn({
        db: input.db,
        candidateId: row.candidate_id,
        electionId: row.election_id,
        electionYear: row.election_year,
        candidateDisplayName: row.candidate_name,
        officeName,
        districtNumber,
        electionDate: row.election_date,
        copId: row.cop_id,
        portalCycleStart: row.portal_cycle_start,
        portalCycleEnd: row.portal_cycle_end,
        context,
        bypassAnomalyCheck: input.bypassAnomalyCheck,
        seams: input.seams,
        dryRun: input.dryRun,
        now,
      });
      results.push({
        candidateId: row.candidate_id,
        electionId: row.election_id,
        ok: true,
        result,
      });
    } catch (error) {
      results.push({
        candidateId: row.candidate_id,
        electionId: row.election_id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const synced = results.filter((row) => row.ok).length;
  return {
    dryRun: Boolean(input.dryRun),
    dueCandidateCount: due.rows.length ? Number(due.rows[0]!.total_due_rows) : 0,
    selectedCandidateCount: due.rows.length,
    syncedCandidateCount: synced,
    failedCandidateCount: results.length - synced,
    autoLinkAttemptedCount: attempted,
    autoLinkLinkedCount: linked,
    contextDiagnostics: context.diagnostics,
    results,
  };
}
