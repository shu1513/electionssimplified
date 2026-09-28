import type { Pool } from "pg";

import { STAGING_ITEM_TYPE_CANDIDATE_ROSTER } from "../../config/electionsPipeline.js";

export type OfficeCandidateEligibilityReason =
  | "eligible"
  | "not_office_or_missing"
  | "not_upcoming"
  | "already_written"
  | "not_nearest_in_track"
  | "buffer_not_elapsed"
  | "too_far_in_future";

export type OfficeCandidateEligibilityConfig = {
  asOfDate: string;
  defaultBufferDays: number;
  shortStageGapDays: number;
  shortStageBufferDays: number;
  statewideUsHouseLookaheadDays: number;
  localOfficeLookaheadDays: number;
};

export type OfficeCandidateEligibilityRow = {
  election_id: string;
  reason: OfficeCandidateEligibilityReason;
  prior_election_date: string | null;
  stage_gap_days: number | null;
  buffer_days: number;
  eligible_after_date: string | null;
};

const ELIGIBILITY_SELECT_SQL = `
  WITH base AS (
    SELECT
      e.id,
      e.district_id,
      d.district_type,
      e.official_ballot_title_key,
      e.election_date,
      e.race_type,
      e.office_id
    FROM public.elections AS e
    LEFT JOIN public.districts AS d
      ON d.id = e.district_id
    WHERE e.id = ANY($1::uuid[])
  ),
  nearest_upcoming AS (
    SELECT
      e.district_id,
      e.official_ballot_title_key,
      min(e.election_date) AS nearest_date
    FROM public.elections AS e
    WHERE e.race_type = 'office'
      AND e.election_date >= $2::date
    GROUP BY e.district_id, e.official_ballot_title_key
  ),
  prior_stage AS (
    SELECT
      b.id,
      p.election_date AS prior_election_date,
      CASE
        WHEN p.election_date IS NULL THEN NULL
        ELSE (b.election_date - p.election_date)::int
      END AS stage_gap_days
    FROM base AS b
    LEFT JOIN LATERAL (
      SELECT e2.election_date
      FROM public.elections AS e2
      WHERE e2.race_type = 'office'
        AND e2.district_id = b.district_id
        AND e2.official_ballot_title_key = b.official_ballot_title_key
        AND e2.election_date < b.election_date
      ORDER BY e2.election_date DESC
      LIMIT 1
    ) AS p ON true
  ),
  roster_written AS (
    SELECT s.ingest_key
    FROM public.staging_items AS s
    WHERE s.item_type = $3
      -- 'no_results' counts as complete for the automated path too: a roster
      -- pass that found nobody must not be auto-retried by the rollover
      -- producer every day. Refresh is manual — manual:candidate-roster:due
      -- surfaces these and manual:candidate-roster:inject re-opens them.
      AND s.status IN ('written', 'no_results')
  )
  SELECT
    b.id AS election_id,
    CASE
      -- An office-less shell (the elections writer's record of a ballot title
      -- the office matcher could not place) has nothing for the candidate
      -- records stage to work from, so it is not roster-eligible until
      -- manual:elections:repair-office-ids backfills office_id.
      WHEN b.race_type <> 'office' OR b.district_id IS NULL OR b.district_type IS NULL OR b.office_id IS NULL THEN 'not_office_or_missing'
      WHEN b.election_date < $2::date THEN 'not_upcoming'
      WHEN rw.ingest_key IS NOT NULL THEN 'already_written'
      WHEN nu.nearest_date IS DISTINCT FROM b.election_date THEN 'not_nearest_in_track'
      WHEN ps.prior_election_date IS NOT NULL
        AND (
          ps.prior_election_date + CASE
            WHEN ps.stage_gap_days IS NOT NULL AND ps.stage_gap_days <= $4::int THEN $5::int
            ELSE $6::int
          END
        ) > $2::date
      THEN 'buffer_not_elapsed'
      WHEN (
        CASE
          WHEN b.district_type IN ('statewide', 'us_house') THEN $7::int
          WHEN b.district_type IN ('county', 'place', 'school_elementary', 'school_secondary', 'school_unified', 'local_special')
            THEN $8::int
          ELSE NULL
        END
      ) IS NOT NULL
        AND (b.election_date - $2::date)::int > (
          CASE
            WHEN b.district_type IN ('statewide', 'us_house') THEN $7::int
            WHEN b.district_type IN ('county', 'place', 'school_elementary', 'school_secondary', 'school_unified', 'local_special')
              THEN $8::int
            ELSE NULL
          END
        )
      THEN 'too_far_in_future'
      ELSE 'eligible'
    END AS reason,
    ps.prior_election_date::text AS prior_election_date,
    ps.stage_gap_days,
    CASE
      WHEN ps.stage_gap_days IS NOT NULL AND ps.stage_gap_days <= $4::int THEN $5::int
      ELSE $6::int
    END AS buffer_days,
    CASE
      WHEN ps.prior_election_date IS NULL THEN NULL
      ELSE (
        ps.prior_election_date + CASE
          WHEN ps.stage_gap_days IS NOT NULL AND ps.stage_gap_days <= $4::int THEN $5::int
          ELSE $6::int
        END
      )::text
    END AS eligible_after_date
  FROM base AS b
  LEFT JOIN nearest_upcoming AS nu
   ON nu.district_id = b.district_id
   AND nu.official_ballot_title_key = b.official_ballot_title_key
  LEFT JOIN prior_stage AS ps
    ON ps.id = b.id
  LEFT JOIN roster_written AS rw
    ON rw.ingest_key = 'candidate_roster:' || b.id::text
`;

// Note on rollover buffer semantics:
// prior_stage intentionally uses the most recent prior same-track election regardless of how old it is.
// This means the buffer gate is mostly impactful for close stage transitions (for example primary -> general),
// while multi-year gaps naturally pass the buffer check.
const ELIGIBILITY_SELECT_UPCOMING_OFFICES_SQL = `
  WITH base AS (
    SELECT
      e.id,
      e.district_id,
      d.district_type,
      e.official_ballot_title_key,
      e.election_date,
      e.race_type,
      e.office_id
    FROM public.elections AS e
    JOIN public.districts AS d
      ON d.id = e.district_id
    WHERE e.race_type = 'office'
      AND e.election_date >= $1::date
  ),
  nearest_upcoming AS (
    SELECT
      e.district_id,
      e.official_ballot_title_key,
      min(e.election_date) AS nearest_date
    FROM public.elections AS e
    WHERE e.race_type = 'office'
      AND e.election_date >= $1::date
    GROUP BY e.district_id, e.official_ballot_title_key
  ),
  prior_stage AS (
    SELECT
      b.id,
      p.election_date AS prior_election_date,
      CASE
        WHEN p.election_date IS NULL THEN NULL
        ELSE (b.election_date - p.election_date)::int
      END AS stage_gap_days
    FROM base AS b
    LEFT JOIN LATERAL (
      SELECT e2.election_date
      FROM public.elections AS e2
      WHERE e2.race_type = 'office'
        AND e2.district_id = b.district_id
        AND e2.official_ballot_title_key = b.official_ballot_title_key
        AND e2.election_date < b.election_date
      ORDER BY e2.election_date DESC
      LIMIT 1
    ) AS p ON true
  ),
  roster_written AS (
    SELECT s.ingest_key
    FROM public.staging_items AS s
    WHERE s.item_type = $2
      -- Mirrors the by-ids variant: 'no_results' is complete for the
      -- automated path; refresh happens through the manual due list.
      AND s.status IN ('written', 'no_results')
  )
  SELECT
    b.id AS election_id,
    CASE
      -- Same rule as the by-ids variant: the daily rollover must not pick up an
      -- office-less shell the elections writer deliberately held back.
      WHEN b.office_id IS NULL THEN 'not_office_or_missing'
      WHEN rw.ingest_key IS NOT NULL THEN 'already_written'
      WHEN nu.nearest_date IS DISTINCT FROM b.election_date THEN 'not_nearest_in_track'
      WHEN ps.prior_election_date IS NOT NULL
        AND (
          ps.prior_election_date + CASE
            WHEN ps.stage_gap_days IS NOT NULL AND ps.stage_gap_days <= $3::int THEN $4::int
            ELSE $5::int
          END
        ) > $1::date
      THEN 'buffer_not_elapsed'
      WHEN (
        CASE
          WHEN b.district_type IN ('statewide', 'us_house') THEN $6::int
          WHEN b.district_type IN ('county', 'place', 'school_elementary', 'school_secondary', 'school_unified', 'local_special')
            THEN $7::int
          ELSE NULL
        END
      ) IS NOT NULL
        AND (b.election_date - $1::date)::int > (
          CASE
            WHEN b.district_type IN ('statewide', 'us_house') THEN $6::int
            WHEN b.district_type IN ('county', 'place', 'school_elementary', 'school_secondary', 'school_unified', 'local_special')
              THEN $7::int
            ELSE NULL
          END
        )
      THEN 'too_far_in_future'
      ELSE 'eligible'
    END AS reason,
    ps.prior_election_date::text AS prior_election_date,
    ps.stage_gap_days,
    CASE
      WHEN ps.stage_gap_days IS NOT NULL AND ps.stage_gap_days <= $3::int THEN $4::int
      ELSE $5::int
    END AS buffer_days,
    CASE
      WHEN ps.prior_election_date IS NULL THEN NULL
      ELSE (
        ps.prior_election_date + CASE
          WHEN ps.stage_gap_days IS NOT NULL AND ps.stage_gap_days <= $3::int THEN $4::int
          ELSE $5::int
        END
      )::text
    END AS eligible_after_date
  FROM base AS b
  LEFT JOIN nearest_upcoming AS nu
   ON nu.district_id = b.district_id
   AND nu.official_ballot_title_key = b.official_ballot_title_key
  LEFT JOIN prior_stage AS ps
    ON ps.id = b.id
  LEFT JOIN roster_written AS rw
    ON rw.ingest_key = 'candidate_roster:' || b.id::text
`;

function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function defaultOfficeCandidateEligibilityConfig(): OfficeCandidateEligibilityConfig {
  return {
    asOfDate: toIsoDate(new Date()),
    defaultBufferDays: 7,
    shortStageGapDays: 60,
    shortStageBufferDays: 3,
    statewideUsHouseLookaheadDays: 90,
    localOfficeLookaheadDays: 75,
  };
}

export async function evaluateOfficeCandidateEligibilityByElectionIds(
  pool: Pool,
  electionIds: readonly string[],
  config: OfficeCandidateEligibilityConfig
): Promise<OfficeCandidateEligibilityRow[]> {
  if (electionIds.length === 0) {
    return [];
  }

  const result = await pool.query<OfficeCandidateEligibilityRow>(ELIGIBILITY_SELECT_SQL, [
    [...new Set(electionIds)],
    config.asOfDate,
    STAGING_ITEM_TYPE_CANDIDATE_ROSTER,
    config.shortStageGapDays,
    config.shortStageBufferDays,
    config.defaultBufferDays,
    config.statewideUsHouseLookaheadDays,
    config.localOfficeLookaheadDays,
  ]);

  return result.rows;
}

export async function getOfficeCandidateEligibilityForElectionId(
  pool: Pool,
  electionId: string,
  config: OfficeCandidateEligibilityConfig
): Promise<OfficeCandidateEligibilityRow> {
  const rows = await evaluateOfficeCandidateEligibilityByElectionIds(pool, [electionId], config);
  if (rows.length > 0) {
    return rows[0]!;
  }
  return {
    election_id: electionId,
    reason: "not_office_or_missing",
    prior_election_date: null,
    stage_gap_days: null,
    buffer_days: config.defaultBufferDays,
    eligible_after_date: null,
  };
}

export async function listOfficeCandidateEligibilityForUpcomingOffices(
  pool: Pool,
  config: OfficeCandidateEligibilityConfig
): Promise<OfficeCandidateEligibilityRow[]> {
  const result = await pool.query<OfficeCandidateEligibilityRow>(ELIGIBILITY_SELECT_UPCOMING_OFFICES_SQL, [
    config.asOfDate,
    STAGING_ITEM_TYPE_CANDIDATE_ROSTER,
    config.shortStageGapDays,
    config.shortStageBufferDays,
    config.defaultBufferDays,
    config.statewideUsHouseLookaheadDays,
    config.localOfficeLookaheadDays,
  ]);
  return result.rows;
}

export function summarizeOfficeCandidateEligibilityReasons(
  rows: readonly OfficeCandidateEligibilityRow[]
): Record<OfficeCandidateEligibilityReason, number> {
  const initial: Record<OfficeCandidateEligibilityReason, number> = {
    eligible: 0,
    not_office_or_missing: 0,
    not_upcoming: 0,
    already_written: 0,
    not_nearest_in_track: 0,
    buffer_not_elapsed: 0,
    too_far_in_future: 0,
  };
  for (const row of rows) {
    initial[row.reason] += 1;
  }
  return initial;
}
