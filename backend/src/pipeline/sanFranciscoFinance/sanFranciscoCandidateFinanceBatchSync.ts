// Phase 6 batch sync, LA due-query pattern with two SF-specific legs before
// the candidate loop:
//
//   1. Auto-link candidates missing active links (warn-and-continue — a
//      linking failure must not stop existing links from syncing).
//   2. Wholesale manifest refresh of elections whose ACTIVE links have gone
//      stale by last_verified_at. The missing-links selector alone never
//      revisits a fully linked election (Phase 3 review finding), so outside
//      relations and manifest-disappearance flags would go stale without
//      this leg; it reuses the auto-link's per-election refresh machinery.
//
// Then one dataset-freshness check for the whole batch and the stalest-first
// candidate loop, with contest manifests cached per (election date, contest).

import type { Pool, PoolClient } from "pg";
import {
  autoLinkMissingSanFranciscoCandidateFinanceLinks,
  listSanFranciscoCandidateElectionsMissingFinanceLinks,
  type SanFranciscoFinanceAutoLinkCandidate,
} from "./sanFranciscoCandidateFinanceAutoLink.js";
import {
  checkSanFranciscoSourceFreshness,
  syncSanFranciscoCandidateFinance,
  type SanFranciscoSourceFreshness,
  type SanFranciscoCandidateFinanceSyncResult,
} from "./sanFranciscoCandidateFinanceSync.js";
import {
  getSanFranciscoContestManifest,
  type SanFranciscoContestManifest,
  type SanFranciscoDashboardManifestClientOptions,
} from "./sanFranciscoDashboardManifestClient.js";
import type { SanFranciscoOpenDataClientOptions } from "./sanFranciscoOpenDataClient.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type PoolLike = Queryable & { connect: () => Promise<PoolClient> };

// District-level SF geography (the Phase 2 predicates); the office-level
// gate is already encoded in the link's contest_code, so no offices join.
const SF_DISTRICT_PREDICATE = `district.state='CA' AND ((district.district_type='county' AND district.geoid_compact='06075') OR (district.district_type='place' AND district.geoid_compact='0667000') OR (district.district_type='school_unified' AND district.geoid_compact='0634410'))`;

type DueRow = {
  candidate_id: string;
  election_id: string;
  election_year: number;
  election_date: string;
  contest_code: string;
  fppc_id: string;
  last_synced_at: string | null;
  total_due_rows: string | number;
};

type StaleElectionRow = {
  candidate_id: string;
  election_id: string;
  candidate_name: string;
  election_date: string;
  contest_code: string;
};

export type SanFranciscoCandidateFinanceBatchSyncResult = {
  dryRun: boolean;
  dueCandidateCount: number;
  selectedCandidateCount: number;
  syncedCandidateCount: number;
  failedCandidateCount: number;
  autoLinkAttemptedCount: number;
  autoLinkLinkedCount: number;
  /** Elections wholesale-refreshed because their active links went stale. */
  staleElectionRefreshCount: number;
  results: Array<{
    candidateId: string;
    electionId: string;
    ok: boolean;
    error?: string;
    result?: SanFranciscoCandidateFinanceSyncResult;
  }>;
};

const integer = (
  value: number | undefined,
  fallback: number,
  label: string,
): number => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0)
    throw new Error(`Invalid San Francisco finance ${label}: ${value}`);
  return result;
};

// Validated up front so a mistyped backfill target fails loudly here instead
// of as a Postgres cast error after the pre-sync legs already ran.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function listStaleLinkElections(
  db: Queryable,
  input: {
    now: Date;
    staleAfterDays: number;
    electionLookbackDays: number;
    electionLookaheadDays: number;
  },
): Promise<SanFranciscoFinanceAutoLinkCandidate[]> {
  // One representative stale link per election; the auto-link refresh it
  // feeds re-reads the election's full candidate list regardless.
  const result = await db.query<StaleElectionRow>(
    `SELECT DISTINCT ON (election.id) link.candidate_id::text candidate_id,election.id::text election_id,COALESCE(NULLIF(trim(candidate.display_name),''),link.candidate_name_normalized) candidate_name,election.election_date::text election_date,link.contest_code FROM public.sfc_candidate_finance_links link JOIN public.candidates candidate ON candidate.id=link.candidate_id JOIN public.elections election ON election.id=link.election_id JOIN public.districts district ON district.id=election.district_id WHERE link.link_status='active' AND candidate.deleted_at IS NULL AND ${SF_DISTRICT_PREDICATE} AND election.election_date>=(($1::timestamptz AT TIME ZONE 'UTC')::date-make_interval(days=>$3::int)) AND election.election_date<=(($1::timestamptz AT TIME ZONE 'UTC')::date+make_interval(days=>$4::int)) AND (link.last_verified_at IS NULL OR link.last_verified_at<($1::timestamptz-make_interval(days=>$2::int))) ORDER BY election.id,link.last_verified_at NULLS FIRST`,
    [
      input.now.toISOString(),
      input.staleAfterDays,
      input.electionLookbackDays,
      input.electionLookaheadDays,
    ],
  );
  return result.rows.map((row) => {
    const electionDate = row.election_date.slice(0, 10);
    return {
      candidateId: row.candidate_id,
      electionId: row.election_id,
      candidateName: row.candidate_name,
      electionDate,
      electionYear: Number(electionDate.slice(0, 4)),
      contestCode: row.contest_code,
    };
  });
}

export async function syncDueSanFranciscoCandidateFinance(input: {
  db: PoolLike;
  now?: Date;
  dryRun?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  /**
   * Historical-backfill targeting (Phase 7): sync ONLY this election's active
   * links. Replaces the election-date window (a 2024 election is outside any
   * sane daily window), drops the withdrawn/lost exclusion (in a decided
   * election the losers are the point of the backfill), drops the staleness
   * filter (an explicitly targeted rerun must select the election even right
   * after a previous run — nothing else can override that filter), and skips
   * both pre-sync legs — backfill requires the links to exist already, and a
   * targeted run must not do unrelated daily maintenance work.
   */
  electionId?: string;
  autoLinkMissingLinks?: boolean;
  manifestClientOptions?: SanFranciscoDashboardManifestClientOptions;
  openDataClientOptions?: SanFranciscoOpenDataClientOptions;
  bypassAnomalyCheck?: boolean;
}): Promise<SanFranciscoCandidateFinanceBatchSyncResult> {
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime()))
    throw new Error("Invalid San Francisco finance batch timestamp");
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
    throw new Error(`Invalid San Francisco finance electionId: ${electionId}`);

  // --- Leg 1: link candidates that have no active link yet. ---
  let attempted = 0,
    linked = 0;
  const refreshedElectionIds = new Set<string>();
  if (!input.dryRun && electionId === undefined && input.autoLinkMissingLinks !== false) {
    try {
      const candidates =
        await listSanFranciscoCandidateElectionsMissingFinanceLinks(input.db, {
          now,
          maxCandidates: max,
          electionLookbackDays: lookback,
          electionLookaheadDays: lookahead,
        });
      attempted = candidates.length;
      const { results: linkResults } =
        await autoLinkMissingSanFranciscoCandidateFinanceLinks({
          db: input.db,
          now,
          candidates,
          manifestClientOptions: input.manifestClientOptions,
          openDataClientOptions: input.openDataClientOptions,
        });
      for (const candidate of candidates)
        refreshedElectionIds.add(candidate.electionId);
      linked = linkResults.filter((row) => row.status === "linked").length;
      for (const row of linkResults)
        if (row.status !== "linked" && row.status !== "no_committee")
          console.warn(
            "San Francisco finance auto-link did not link candidate election:",
            row,
          );
    } catch (error) {
      console.warn(
        "San Francisco finance auto-link skipped; continuing existing links",
        error instanceof Error ? error.message : error,
      );
    }
  }

  // --- Leg 2: wholesale refresh of elections with stale active links. ---
  let staleElectionRefreshCount = 0;
  if (!input.dryRun && electionId === undefined) {
    try {
      const staleElections = (
        await listStaleLinkElections(input.db, {
          now,
          staleAfterDays: stale,
          electionLookbackDays: lookback,
          electionLookaheadDays: lookahead,
        })
      ).filter((row) => !refreshedElectionIds.has(row.electionId));
      if (staleElections.length > 0) {
        const { results: refreshResults, diagnostics } =
          await autoLinkMissingSanFranciscoCandidateFinanceLinks({
            db: input.db,
            now,
            candidates: staleElections,
            manifestClientOptions: input.manifestClientOptions,
            openDataClientOptions: input.openDataClientOptions,
          });
        staleElectionRefreshCount = staleElections.length;
        for (const row of refreshResults)
          if (row.status === "error")
            console.warn(
              "San Francisco finance stale-election refresh error:",
              row,
            );
        for (const electionError of diagnostics.electionErrors)
          console.warn(
            "San Francisco finance stale-election refresh rolled back:",
            electionError,
          );
      }
    } catch (error) {
      console.warn(
        "San Francisco finance stale-election refresh skipped",
        error instanceof Error ? error.message : error,
      );
    }
  }

  // --- Candidate loop: stalest first. ---
  // Ordinary runs are ALWAYS bounded by the election-date window and the
  // staleness filter — history is reachable only through explicit electionId
  // targeting. Targeting swaps the window for an id match, drops the
  // withdrawn/lost exclusion (a decided election's losers are exactly what a
  // backfill is for), and drops the staleness filter too: "sync this
  // election" must select it even minutes after the last run (a rerun after
  // a code fix would otherwise silently pick zero candidates, and nothing —
  // force bypasses only flags, staleAfterDays floors at one day — could
  // override that). Reruns still resume partial failures first because the
  // NULLS FIRST ordering puts never-synced links ahead of synced ones.
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
  const due = await input.db.query<DueRow>(
    `WITH due AS (SELECT link.candidate_id::text candidate_id,link.election_id::text election_id,link.election_year,election.election_date::text election_date,link.contest_code,link.fppc_id,summary.last_synced_at::text last_synced_at,count(*) OVER() total_due_rows FROM public.sfc_candidate_finance_links link JOIN public.candidates candidate ON candidate.id=link.candidate_id JOIN public.candidate_elections ce ON ce.candidate_id=link.candidate_id AND ce.election_id=link.election_id JOIN public.elections election ON election.id=link.election_id JOIN public.districts district ON district.id=election.district_id LEFT JOIN public.sfc_candidate_finance_summaries summary ON summary.link_id=link.id AND summary.election_year=link.election_year WHERE link.link_status='active' AND candidate.deleted_at IS NULL AND ${SF_DISTRICT_PREDICATE} AND ${dueScope.where} ORDER BY summary.last_synced_at NULLS FIRST,election.election_date,link.candidate_name_normalized LIMIT ${dueScope.limit}) SELECT * FROM due`,
    dueScope.params,
  );
  const results: SanFranciscoCandidateFinanceBatchSyncResult["results"] = [];
  let sourceFreshness: SanFranciscoSourceFreshness | null = null;
  let freshnessError: string | null = null;
  if (due.rows.length > 0) {
    // One dataset-level health check covers the whole batch; a stalled or
    // incoherent nightly refresh fails every candidate with the same reason
    // instead of hammering the API once per candidate.
    try {
      sourceFreshness = await checkSanFranciscoSourceFreshness({
        now,
        openDataClientOptions: input.openDataClientOptions,
      });
    } catch (error) {
      freshnessError = error instanceof Error ? error.message : String(error);
    }
  }
  const manifestCache = new Map<string, SanFranciscoContestManifest>();
  for (const row of due.rows) {
    if (freshnessError !== null) {
      results.push({
        candidateId: row.candidate_id,
        electionId: row.election_id,
        ok: false,
        error: freshnessError,
      });
      continue;
    }
    try {
      const electionDate = row.election_date.slice(0, 10);
      const manifestKey = `${electionDate}:${row.contest_code}`;
      let manifest = manifestCache.get(manifestKey);
      if (!manifest) {
        manifest = await getSanFranciscoContestManifest(
          { electionDate, contestCode: row.contest_code },
          input.manifestClientOptions,
        );
        manifestCache.set(manifestKey, manifest);
      }
      const result = await syncSanFranciscoCandidateFinance({
        db: input.db,
        candidateId: row.candidate_id,
        electionId: row.election_id,
        electionYear: row.election_year,
        electionDate,
        contestCode: row.contest_code,
        fppcId: row.fppc_id,
        manifest,
        sourceFreshness: sourceFreshness ?? undefined,
        manifestClientOptions: input.manifestClientOptions,
        openDataClientOptions: input.openDataClientOptions,
        bypassAnomalyCheck: input.bypassAnomalyCheck,
        dryRun: input.dryRun,
        now,
      });
      results.push({
        candidateId: row.candidate_id,
        electionId: row.election_id,
        ok: true,
        ...(result ? { result } : {}),
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
    dueCandidateCount: due.rows.length
      ? Number(due.rows[0]!.total_due_rows)
      : 0,
    selectedCandidateCount: due.rows.length,
    syncedCandidateCount: synced,
    failedCandidateCount: results.length - synced,
    autoLinkAttemptedCount: attempted,
    autoLinkLinkedCount: linked,
    staleElectionRefreshCount,
    results,
  };
}
