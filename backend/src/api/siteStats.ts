import type { Pool, PoolClient } from "pg";
import { isJudicialRetentionTitle } from "../ai/electionPartisanshipPolicy.js";
import { STATE_NAME_BY_ABBREVIATION } from "../constants/usStates.js";
import { effectiveSeatsToFill, isUncontestedOfficeRace } from "../pipeline/address/votePower.js";

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
 * "Upcoming" = election_date today or later. Contested / uncontested use
 * the vote-power rules (votePower.ts): a race is uncontested when every
 * non-withdrawn candidate wins a seat (candidates <= seats, seats
 * defaulting to 1), contested when there are more candidates than seats.
 * A judicial retention question (one judge, yes/no) is neither — the judge
 * can lose — so it counts as an election only, exactly as vote power gives
 * it no contested rating. A race with no known candidates is also neither.
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
  upcoming_measures: string | number;
  next_election_date: string | null;
};

type OfficeRaceRow = {
  state: string;
  official_ballot_title: string;
  seats_to_fill: number | null;
  active_count: string | number;
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
 * getSiteStats behind an in-process cache, like the sitemap: the queries
 * walk every election row, so a crawler (or a bot) hitting /api/stats past
 * the 60s edge cache must not re-run them each time. One DB pass per TTL;
 * concurrent misses share one in-flight load; a failed refresh serves the
 * last good result to every waiter, not only the one that started it.
 */
export function createCachedSiteStats(options: { db: Queryable; ttlMs?: number; now?: () => Date }): () => Promise<SiteStatsResult> {
  const ttlMs = options.ttlMs ?? DEFAULT_SITE_STATS_CACHE_TTL_MS;
  const now = options.now ?? (() => new Date());
  let cached: SiteStatsResult | null = null;
  let cachedUntil = 0;
  let inFlight: Promise<SiteStatsResult> | null = null;
  return () => {
    if (cached && now().getTime() < cachedUntil) {
      return Promise.resolve(cached);
    }
    if (!inFlight) {
      inFlight = (async () => {
        try {
          const result = await getSiteStats(options.db, now);
          cached = result;
          cachedUntil = now().getTime() + ttlMs;
          return result;
        } catch (error) {
          if (cached) {
            return cached;
          }
          throw error;
        } finally {
          inFlight = null;
        }
      })();
    }
    return inFlight;
  };
}

// Contested/uncontested per office race, in TypeScript rather than SQL so
// the seat rule and the retention exception are the vote-power code itself,
// not a second copy of it. One row per upcoming office race (~30k): fine
// for an hourly pass.
function classifyOfficeRace(row: OfficeRaceRow): "contested" | "uncontested" | null {
  if (isJudicialRetentionTitle(row.official_ballot_title)) {
    return null;
  }
  const candidateCount = Number(row.active_count);
  if (isUncontestedOfficeRace({ raceType: "office", candidateCount, seatsToFill: row.seats_to_fill })) {
    return "uncontested";
  }
  return candidateCount > effectiveSeatsToFill(row.seats_to_fill) ? "contested" : null;
}

export async function getSiteStats(db: Queryable, now: () => Date = () => new Date()): Promise<SiteStatsResult> {
  const [electionResult, officeResult, partyResult, recordsResult] = await Promise.all([
    db.query<StateRow>(
      `
        SELECT
          d.state,
          COUNT(DISTINCT d.id) AS districts,
          COUNT(e.id) FILTER (WHERE e.election_date >= CURRENT_DATE) AS upcoming_elections,
          COUNT(e.id) FILTER (
            WHERE e.election_date >= CURRENT_DATE AND e.race_type = 'ballot_measure'
          ) AS upcoming_measures,
          (MIN(e.election_date) FILTER (WHERE e.election_date >= CURRENT_DATE))::text AS next_election_date
        FROM public.districts d
        JOIN public.elections e ON e.district_id = d.id
        GROUP BY d.state
        ORDER BY d.state ASC
      `
    ),
    db.query<OfficeRaceRow>(
      `
        SELECT
          d.state,
          e.official_ballot_title,
          e.seats_to_fill,
          -- Same effective roster size as the election detail (ballotLookup
          -- loadElectionRowById): the larger of the linked profiles and the
          -- roster the staging row promises, minus withdrawals. Profiles
          -- link one per write, so between the first and last write a
          -- contested race shows fewer links than it has candidates —
          -- counting links alone would call it uncontested for an hour.
          GREATEST(
            (
              SELECT COUNT(*)::int
              FROM public.candidate_elections ce
              JOIN public.candidates c ON c.id = ce.candidate_id
              WHERE ce.election_id = e.id
                AND ce.status <> 'withdrawn'
                AND c.deleted_at IS NULL
                AND c.merged_into_candidate_id IS NULL
            ),
            COALESCE(
              (
                SELECT GREATEST(
                  0,
                  CASE
                    WHEN jsonb_typeof(s.payload->'candidates') = 'array'
                      THEN jsonb_array_length(s.payload->'candidates')
                    ELSE 0
                  END
                  - (
                    SELECT count(*)::int
                    FROM public.candidate_elections AS withdrawn
                    WHERE withdrawn.election_id = e.id
                      AND withdrawn.status = 'withdrawn'
                  )
                )
                FROM public.staging_items AS s
                WHERE s.item_type = 'candidate_roster'
                  AND s.ingest_key = 'candidate_roster:' || e.id::text
                  AND s.status IN ('validated', 'written')
                LIMIT 1
              ),
              0
            )
          ) AS active_count
        FROM public.elections e
        JOIN public.districts d ON d.id = e.district_id
        WHERE e.election_date >= CURRENT_DATE
          AND e.race_type = 'office'
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

  const contestedByState = new Map<string, { contested: number; uncontested: number }>();
  for (const row of officeResult.rows) {
    const kind = classifyOfficeRace(row);
    if (!kind) {
      continue;
    }
    const counts = contestedByState.get(row.state) ?? { contested: 0, uncontested: 0 };
    counts[kind] += 1;
    contestedByState.set(row.state, counts);
  }

  const partyByState = new Map(partyResult.rows.map((row) => [row.state, row]));
  const states: SiteStatsState[] = [];
  for (const row of electionResult.rows) {
    // Same rule as the browse catalog: a code we cannot name gets no row.
    const name = STATE_NAME_BY_ABBREVIATION[row.state];
    if (!name) {
      continue;
    }
    const party = partyByState.get(row.state);
    const contested = contestedByState.get(row.state) ?? { contested: 0, uncontested: 0 };
    const democratic = Number(party?.democratic ?? 0);
    const republican = Number(party?.republican ?? 0);
    const other = Number(party?.other ?? 0);
    states.push({
      state: row.state,
      name,
      districts: Number(row.districts),
      upcoming_elections: Number(row.upcoming_elections),
      upcoming_contested: contested.contested,
      upcoming_uncontested: contested.uncontested,
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
