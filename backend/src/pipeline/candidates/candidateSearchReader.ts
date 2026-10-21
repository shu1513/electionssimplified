import type { Pool, PoolClient } from "pg";
import { US_LATEST_LOCAL_DATE_SQL } from "../../utils/usLocalDate.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type CandidateSearchMatch = {
  candidate_id: string;
  display_name: string;
  party: string;
  state: string;
  current_office: string | null;
};

export type CandidateSearchResult = {
  candidates: CandidateSearchMatch[];
};

export const CANDIDATE_SEARCH_LIMIT = 10;

/** Literal text → safe ILIKE pattern fragment: the caller wraps it in its own
 * wildcards, so any %/_ (and the \ escape itself) in user input must match
 * literally instead of acting as metacharacters. */
export function escapeIlikePattern(text: string): string {
  return text.replace(/[\\%_]/g, "\\$&");
}

type CandidateSearchRow = {
  candidate_id: string;
  display_name: string;
  party: string;
  state: string;
  current_office: string | null;
};

/**
 * Name typeahead: case-insensitive match on the same coalesced display name
 * the candidate detail endpoint serves. Every typed word must appear in the
 * name, in any order, so "John Smith" finds "John A. Smith". Ranking:
 * candidates running in an upcoming election in `districtIds` (the caller's
 * ballot) first, then names containing the whole typed phrase, then prefix
 * matches, so "Hilar" ranks "Hilary …" above "Ann Hilary …".
 *
 * Deliberately unindexed: the leading-wildcard ILIKE seq-scans the table,
 * measured at ~7ms over 9.2k candidates (EXPLAIN ANALYZE, 2026-07), behind a
 * debounced client and the global rate limiter. If the table grows enough to
 * hurt, add a pg_trgm GIN expression index on the exact COALESCE expression
 * below rather than reaching for a heavier search stack.
 */
export async function searchCandidatesByName(
  db: Queryable,
  query: string,
  districtIds: string[] = []
): Promise<CandidateSearchResult> {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return { candidates: [] };
  }
  const escaped = escapeIlikePattern(trimmed);
  const words = trimmed.split(/\s+/).map(escapeIlikePattern);

  const result = await db.query<CandidateSearchRow>(
    `
      WITH named AS (
        SELECT
          candidate.id,
          COALESCE(
            NULLIF(trim(candidate.display_name), ''),
            trim(concat_ws(' ', candidate.first_name, candidate.last_name))
          ) AS display_name,
          candidate.party,
          candidate.state,
          candidate.current_office
        FROM public.candidates AS candidate
        WHERE candidate.deleted_at IS NULL
          AND candidate.merged_into_candidate_id IS NULL
      )
      SELECT
        named.id::text AS candidate_id,
        named.display_name,
        named.party,
        named.state,
        named.current_office
      FROM named
      WHERE NOT EXISTS (
        SELECT 1 FROM unnest($4::text[]) AS word
        WHERE named.display_name NOT ILIKE '%' || word || '%'
      )
      ORDER BY
        EXISTS (
          SELECT 1
          FROM public.candidate_elections AS candidate_election
          JOIN public.elections AS election ON election.id = candidate_election.election_id
          WHERE candidate_election.candidate_id = named.id
            AND election.district_id = ANY($3::uuid[])
            AND election.election_date >= ${US_LATEST_LOCAL_DATE_SQL}
        ) DESC,
        named.display_name ILIKE '%' || $1 || '%' DESC,
        named.display_name ILIKE $1 || '%' DESC,
        named.display_name ASC
      LIMIT $2
    `,
    [escaped, CANDIDATE_SEARCH_LIMIT, districtIds, words]
  );

  return { candidates: result.rows };
}
