import type { Pool, PoolClient } from "pg";
import type { FloridaCandidateFinanceDueRow } from "./floridaCandidateFinanceBatchSync.js";

/** Accepted IE source age, never receiving-summary age. A failed/empty attempt
 * cannot stamp financial freshness or assert candidate-wide absence. */
export async function listDueFloridaOutsideFinanceSyncRows(
  db: Pick<Pool | PoolClient, "query">,
  input: { now: Date; staleAfterDays: number; maxCandidates: number;
    electionLookbackDays: number; electionLookaheadDays: number; candidateId?: string },
): Promise<{ rows: FloridaCandidateFinanceDueRow[]; totalDueRows: number }> {
  const result = await db.query<{
    candidate_id: string; candidate_election_id: string; election_id: string; candidate_name: string;
    election_year: number; office_name: string; district: string | null; committee_id: string;
    committee_name: string; source_url: string | null; last_synced_at: string | null; total_due_rows: string | number;
  }>(`
    WITH contexts AS (
      SELECT DISTINCT ON (ce.id) c.id::text candidate_id, ce.id::text candidate_election_id,
        e.id::text election_id, COALESCE(NULLIF(trim(c.display_name), ''),
          NULLIF(trim(c.first_name || ' ' || c.last_name), '')) candidate_name,
        link.election_year, o.canonical_name office_name, link.district,
        link.committee_id, link.committee_name, link.source_url,
        authority.verified_source_at::text last_synced_at, attempt.last_attempted_at, e.election_date
      FROM public.fl_candidate_finance_links link
      JOIN public.candidates c ON c.id = link.candidate_id
      JOIN public.candidate_elections ce ON ce.candidate_id = link.candidate_id AND ce.election_id = link.election_id
      JOIN public.elections e ON e.id = link.election_id
      JOIN public.districts d ON d.id = e.district_id
      JOIN public.offices o ON o.id = e.office_id
      LEFT JOIN public.fl_candidate_finance_ie_attempts attempt ON attempt.candidate_election_id = ce.id
      LEFT JOIN LATERAL (
        SELECT min(source.verified_source_at) verified_source_at
        FROM public.fl_candidate_finance_ie_sources source
        WHERE source.candidate_election_id = ce.id AND source.election_year = link.election_year
      ) authority ON TRUE
      WHERE link.link_status = 'active' AND c.deleted_at IS NULL AND d.state = 'FL'
        AND ce.status NOT IN ('withdrawn', 'lost') AND e.race_type = 'office'
        AND e.election_stage = 'general' AND e.election_date = '2026-11-03' AND link.election_year = 2026
        AND ((o.scope = 'state_lower' AND o.canonical_name = 'State Lower Chamber Legislator')
          OR (o.scope = 'state_upper' AND o.canonical_name = 'State Senator'))
        AND e.election_date >= (($1::timestamptz AT TIME ZONE 'UTC')::date - make_interval(days => $4::int))
        AND e.election_date <= (($1::timestamptz AT TIME ZONE 'UTC')::date + make_interval(days => $5::int))
        AND ($6::uuid IS NULL OR link.candidate_id = $6::uuid)
        AND (authority.verified_source_at IS NULL OR authority.verified_source_at <
          ($1::timestamptz - make_interval(days => $2::int)))
        AND (attempt.last_attempted_at IS NULL OR attempt.last_attempted_at <
          ($1::timestamptz - make_interval(days => LEAST($2::int, 1))))
      ORDER BY ce.id, EXISTS (SELECT 1 FROM public.fl_candidate_finance_ie_sources prior
        WHERE prior.candidate_election_id = ce.id AND prior.election_year = link.election_year AND prior.link_id = link.id) DESC,
        link.id
    )
    SELECT *, count(*) OVER () total_due_rows FROM contexts
    ORDER BY last_attempted_at ASC NULLS FIRST, last_synced_at::timestamptz ASC NULLS FIRST,
      election_date, candidate_name, candidate_election_id
    LIMIT $3::int
  `, [input.now.toISOString(), input.staleAfterDays, input.maxCandidates,
    input.electionLookbackDays, input.electionLookaheadDays, input.candidateId ?? null]);
  return { totalDueRows: Number(result.rows[0]?.total_due_rows ?? 0), rows: result.rows.map(row => ({
    candidateId: row.candidate_id, candidateElectionId: row.candidate_election_id, electionId: row.election_id,
    candidateName: row.candidate_name, electionYear: row.election_year, officeName: row.office_name,
    district: row.district, committeeId: row.committee_id, committeeName: row.committee_name,
    sourceUrl: row.source_url, lastSyncedAt: row.last_synced_at,
  })) };
}

export async function recordFloridaOutsideFinanceAttempt(
  db: Pick<Pool | PoolClient, "query">, candidateElectionId: string, now: Date,
): Promise<void> {
  await db.query(`INSERT INTO public.fl_candidate_finance_ie_attempts (candidate_election_id, last_attempted_at)
    VALUES ($1::uuid, $2::timestamptz)
    ON CONFLICT (candidate_election_id) DO UPDATE SET last_attempted_at =
      GREATEST(fl_candidate_finance_ie_attempts.last_attempted_at, EXCLUDED.last_attempted_at)`,
    [candidateElectionId, now.toISOString()]);
}
