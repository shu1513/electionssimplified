import type { Pool, PoolClient } from "pg";
import { STATE_NAME_BY_ABBREVIATION } from "../constants/usStates.js";

type Queryable = Pick<Pool | PoolClient, "query">;

/**
 * Coverage statistics behind /stats (and GET /api/stats): how many races,
 * candidates, and measures the site holds, per state and in total. The
 * numbers nobody else assembles — uncontested races per state, candidates
 * by party across every level — are the kind of dated, sourced fact that
 * journalists and answer engines quote ("according to Elections
 * Simplified, N races are uncontested"). Anonymous, identical for everyone,
 * and cached like the browse catalog.
 *
 * "Upcoming" = election_date today or later. A race is uncontested when
 * every non-withdrawn candidate wins a seat (the vote-power rule in
 * votePower.ts: candidates <= seats, seats defaulting to 1); a race with no
 * known candidates is neither contested nor uncontested and is counted only
 * in the election total.
 */

export type SiteStatsCounts = {
  /** Districts holding at least one election (any date). */
  districts: number;
  upcoming_elections: number;
  /** Office races with more candidates than seats. */
  upcoming_contested: number;
  /** Office races where every known candidate wins a seat. */
  upcoming_uncontested: number;
  upcoming_measures: number;
  /** Distinct candidates in an upcoming race, not withdrawn. */
  upcoming_candidates: number;
  upcoming_democratic: number;
  upcoming_republican: number;
  upcoming_other: number;
  /** Soonest upcoming election date, YYYY-MM-DD; null when none. */
  next_election_date: string | null;
};

export type SiteStatsState = SiteStatsCounts & { state: string; name: string };

export type SiteStatsResult = {
  /** The date the numbers were computed, YYYY-MM-DD (UTC). */
  as_of: string;
  totals: SiteStatsCounts & { states: number; candidate_records: number };
  states: SiteStatsState[];
};

type StateRow = {
  state: string;
  districts: string | number;
  upcoming_elections: string | number;
  upcoming_contested: string | number;
  upcoming_uncontested: string | number;
  upcoming_measures: string | number;
  next_election_date: string | null;
};

type PartyRow = {
  state: string;
  democratic: string | number;
  republican: string | number;
  other: string | number;
};

type RecordsRow = { candidate_records: string | number };

// Mirrors partyBucket in the api-client: the labels that count as the two
// major parties; everything else (independents, minor parties, nonpartisan,
// unknown) is "other".
const DEMOCRATIC_LABELS = ["democratic", "democratic-farmer-labor", "democratic-npl", "registered democrat", "dem", "democrat", "democratic party"];
const REPUBLICAN_LABELS = ["republican", "registered republican", "rep", "republican party"];

export const DEFAULT_SITE_STATS_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * getSiteStats behind an in-process cache, like the sitemap: the three
 * queries walk every election row with a per-row roster subquery, so a
 * crawler (or a bot) hitting /api/stats past the 60s edge cache must not
 * re-run them each time. One DB pass per TTL; concurrent misses share one
 * in-flight load; a failed refresh serves the last good result.
 */
export function createCachedSiteStats(options: { db: Queryable; ttlMs?: number; now?: () => Date }): () => Promise<SiteStatsResult> {
  const ttlMs = options.ttlMs ?? DEFAULT_SITE_STATS_CACHE_TTL_MS;
  const now = options.now ?? (() => new Date());
  let cached: SiteStatsResult | null = null;
  let cachedUntil = 0;
  let inFlight: Promise<SiteStatsResult> | null = null;
  return async () => {
    const currentTime = now().getTime();
    if (cached && currentTime < cachedUntil) {
      return cached;
    }
    if (inFlight) {
      return inFlight;
    }
    inFlight = (async () => {
      const result = await getSiteStats(options.db, now);
      cached = result;
      cachedUntil = now().getTime() + ttlMs;
      return result;
    })();
    try {
      return await inFlight;
    } catch (error) {
      if (cached) {
        return cached;
      }
      throw error;
    } finally {
      inFlight = null;
    }
  };
}

export async function getSiteStats(db: Queryable, now: () => Date = () => new Date()): Promise<SiteStatsResult> {
  const [electionResult, partyResult, recordsResult] = await Promise.all([
    db.query<StateRow>(
      `
        SELECT
          d.state,
          COUNT(DISTINCT d.id) AS districts,
          COUNT(e.id) FILTER (WHERE e.election_date >= CURRENT_DATE) AS upcoming_elections,
          COUNT(e.id) FILTER (
            WHERE e.election_date >= CURRENT_DATE
              AND e.race_type = 'office'
              AND roster.active_count > GREATEST(COALESCE(e.seats_to_fill, 1), 1)
          ) AS upcoming_contested,
          COUNT(e.id) FILTER (
            WHERE e.election_date >= CURRENT_DATE
              AND e.race_type = 'office'
              AND roster.active_count >= 1
              AND roster.active_count <= GREATEST(COALESCE(e.seats_to_fill, 1), 1)
          ) AS upcoming_uncontested,
          COUNT(e.id) FILTER (
            WHERE e.election_date >= CURRENT_DATE AND e.race_type = 'ballot_measure'
          ) AS upcoming_measures,
          (MIN(e.election_date) FILTER (WHERE e.election_date >= CURRENT_DATE))::text AS next_election_date
        FROM public.districts d
        JOIN public.elections e ON e.district_id = d.id
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS active_count
          FROM public.candidate_elections ce
          JOIN public.candidates c ON c.id = ce.candidate_id
          WHERE ce.election_id = e.id
            AND ce.status <> 'withdrawn'
            AND c.deleted_at IS NULL
            AND c.merged_into_candidate_id IS NULL
        ) roster ON TRUE
        GROUP BY d.state
        ORDER BY d.state ASC
      `
    ),
    db.query<PartyRow>(
      `
        SELECT
          people.state,
          COUNT(*) FILTER (WHERE people.bucket = 'democratic') AS democratic,
          COUNT(*) FILTER (WHERE people.bucket = 'republican') AS republican,
          COUNT(*) FILTER (WHERE people.bucket = 'other') AS other
        FROM (
          SELECT DISTINCT
            d.state,
            c.id,
            CASE
              WHEN lower(trim(c.party)) = ANY($1) THEN 'democratic'
              WHEN lower(trim(c.party)) = ANY($2) THEN 'republican'
              ELSE 'other'
            END AS bucket
          FROM public.candidate_elections ce
          JOIN public.elections e ON e.id = ce.election_id
          JOIN public.districts d ON d.id = e.district_id
          JOIN public.candidates c ON c.id = ce.candidate_id
          WHERE e.election_date >= CURRENT_DATE
            AND ce.status <> 'withdrawn'
            AND c.deleted_at IS NULL
            AND c.merged_into_candidate_id IS NULL
        ) people
        GROUP BY people.state
      `,
      [DEMOCRATIC_LABELS, REPUBLICAN_LABELS]
    ),
    db.query<RecordsRow>(`SELECT COUNT(*) AS candidate_records FROM public.candidate_records`),
  ]);

  const partyByState = new Map(partyResult.rows.map((row) => [row.state, row]));
  const states: SiteStatsState[] = [];
  for (const row of electionResult.rows) {
    // Same rule as the browse catalog: a code we cannot name gets no row.
    const name = STATE_NAME_BY_ABBREVIATION[row.state];
    if (!name) {
      continue;
    }
    const party = partyByState.get(row.state);
    const democratic = Number(party?.democratic ?? 0);
    const republican = Number(party?.republican ?? 0);
    const other = Number(party?.other ?? 0);
    states.push({
      state: row.state,
      name,
      districts: Number(row.districts),
      upcoming_elections: Number(row.upcoming_elections),
      upcoming_contested: Number(row.upcoming_contested),
      upcoming_uncontested: Number(row.upcoming_uncontested),
      upcoming_measures: Number(row.upcoming_measures),
      upcoming_candidates: democratic + republican + other,
      upcoming_democratic: democratic,
      upcoming_republican: republican,
      upcoming_other: other,
      next_election_date: row.next_election_date,
    });
  }

  const sum = (key: keyof SiteStatsCounts) => states.reduce((total, state) => total + Number(state[key] ?? 0), 0);
  const nextDates = states.map((state) => state.next_election_date).filter((date): date is string => date !== null).sort();
  return {
    as_of: now().toISOString().slice(0, 10),
    totals: {
      states: states.length,
      districts: sum("districts"),
      upcoming_elections: sum("upcoming_elections"),
      upcoming_contested: sum("upcoming_contested"),
      upcoming_uncontested: sum("upcoming_uncontested"),
      upcoming_measures: sum("upcoming_measures"),
      upcoming_candidates: sum("upcoming_candidates"),
      upcoming_democratic: sum("upcoming_democratic"),
      upcoming_republican: sum("upcoming_republican"),
      upcoming_other: sum("upcoming_other"),
      next_election_date: nextDates[0] ?? null,
      candidate_records: Number(recordsResult.rows[0]?.candidate_records ?? 0),
    },
    states,
  };
}
