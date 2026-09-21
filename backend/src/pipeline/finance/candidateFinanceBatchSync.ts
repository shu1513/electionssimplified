import type { Pool, PoolClient } from "pg";

import { type OpenFecClientOptions } from "../presidential/openFecClient.js";
import {
  syncCandidateFinanceContributors,
  type CandidateFinanceContributorSyncResult,
} from "./candidateFinanceContributorSync.js";
import {
  syncCandidateFinance,
  type CandidateFinanceIndustryClassifier,
  type CandidateFinanceSyncFecClient,
  type CandidateFinanceSyncResult,
} from "./candidateFinanceSync.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type CandidateFinanceDueRow = {
  candidateId: string;
  fecCandidateId: string;
  electionYear: number;
  source: "candidate_election" | "presidential_cycle";
  lastSyncedAt: string | null;
};

export type CandidateFinanceBatchSyncInput = {
  db: Queryable;
  openFecOptions: OpenFecClientOptions;
  now?: Date;
  dryRun?: boolean;
  includeOutside?: boolean;
  /**
   * Also refresh named committee donors and conduit totals from the FEC bulk
   * files. The files answer every candidate at once, so this covers all
   * candidates in the election window, not only the ones due for an API sync.
   */
  includeContributors?: boolean;
  /** Refresh only the bulk-file lists; make no OpenFEC API calls. */
  contributorsOnly?: boolean;
  bulkDataDirectory?: string;
  /** Limit the contributor refresh to these FEC candidate ids (sample runs). */
  contributorCandidateIds?: readonly string[];
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  perPage?: number;
  outsideGroupLimit?: number;
  fecClient?: CandidateFinanceSyncFecClient;
  financeIndustryClassifier?: CandidateFinanceIndustryClassifier;
  aiClassificationMinAmount?: number;
  syncCandidateFinanceFn?: typeof syncCandidateFinance;
  syncCandidateFinanceContributorsFn?: typeof syncCandidateFinanceContributors;
};

export type CandidateFinanceBatchSyncItemResult = {
  candidateId: string;
  fecCandidateId: string;
  electionYear: number;
  source: CandidateFinanceDueRow["source"];
  ok: boolean;
  result?: CandidateFinanceSyncResult;
  error?: string;
};

export type CandidateFinanceBatchSyncResult = {
  dryRun: boolean;
  includeOutside: boolean;
  now: string;
  staleAfterDays: number;
  maxCandidates: number;
  dueCandidateCount: number;
  selectedCandidateCount: number;
  syncedCandidateCount: number;
  failedCandidateCount: number;
  results: CandidateFinanceBatchSyncItemResult[];
  /** Present only when the run refreshed the bulk-file donor and conduit lists. */
  contributors?: CandidateFinanceContributorSyncResult;
};

type CandidateFinanceDueQueryRow = {
  candidate_id: string;
  fec_candidate_id: string;
  election_year: number;
  source: CandidateFinanceDueRow["source"];
  last_synced_at: string | null;
  total_due_rows: string | number;
};

export const DEFAULT_CANDIDATE_FINANCE_BATCH_SIZE = 25;
const DEFAULT_STALE_AFTER_DAYS = 7;
// Keep one extra calendar day so UTC scheduler timing cannot skip election-night finance syncs.
const DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS = 1;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;
const ALL_WINDOW_CANDIDATES_LIMIT = 1_000_000;

function assertValidDate(date: Date, label: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid candidate finance batch sync ${label}`);
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid candidate finance batch sync ${label}: ${value}`);
  }
  return normalized;
}

function parseTotalDueRows(value: string | number | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function mapDueRow(row: CandidateFinanceDueQueryRow): CandidateFinanceDueRow {
  return {
    candidateId: row.candidate_id,
    fecCandidateId: row.fec_candidate_id,
    electionYear: row.election_year,
    source: row.source,
    lastSyncedAt: row.last_synced_at,
  };
}

export async function listDueCandidateFinanceSyncRows(
  db: Queryable,
  input: {
    now: Date;
    staleAfterDays: number;
    maxCandidates: number;
    electionLookbackDays: number;
    electionLookaheadDays: number;
    /** List every candidate in the election window, synced recently or not. */
    includeFresh?: boolean;
  }
): Promise<{ rows: CandidateFinanceDueRow[]; totalDueRows: number }> {
  const result = await db.query<CandidateFinanceDueQueryRow>(
    `
      WITH standard_candidate_fecs AS (
        SELECT
          c.id AS candidate_id,
          upper(trim(fec_id.value)) AS fec_candidate_id,
          extract(year from e.election_date)::int AS election_year,
          'candidate_election'::text AS source
        FROM public.candidate_elections AS ce
        JOIN public.candidates AS c
          ON c.id = ce.candidate_id
        JOIN public.elections AS e
          ON e.id = ce.election_id
        JOIN public.offices AS office
          ON office.id = e.office_id
        CROSS JOIN LATERAL jsonb_array_elements_text(c.fec_ids) AS fec_id(value)
        WHERE c.deleted_at IS NULL
          AND e.race_type = 'office'
          AND e.election_date >= (($1::timestamptz AT TIME ZONE 'UTC')::date - make_interval(days => $4::int))
          AND e.election_date <= (($1::timestamptz AT TIME ZONE 'UTC')::date + make_interval(days => $5::int))
          AND ce.status NOT IN ('withdrawn', 'lost')
          AND (
            (office.scope = 'statewide' AND office.canonical_name = 'United States Senator' AND upper(trim(fec_id.value)) ~ '^S[0-9A-Z]{8}$')
            OR
            (office.scope = 'us_house' AND office.canonical_name = 'United States Representative' AND upper(trim(fec_id.value)) ~ '^H[0-9A-Z]{8}$')
          )
      ),
      presidential_candidate_fecs AS (
        SELECT
          c.id AS candidate_id,
          upper(trim(fec_id.value)) AS fec_candidate_id,
          cycle.election_year,
          'presidential_cycle'::text AS source
        FROM public.presidential_cycle_candidates AS cycle_candidate
        JOIN public.presidential_cycles AS cycle
          ON cycle.id = cycle_candidate.cycle_id
        LEFT JOIN public.presidential_cycles AS general_cycle
          ON general_cycle.election_year = cycle.election_year
         AND general_cycle.stage = 'general'
        JOIN public.candidates AS c
          ON c.id = cycle_candidate.candidate_id
        CROSS JOIN LATERAL jsonb_array_elements_text(c.fec_ids) AS fec_id(value)
        WHERE c.deleted_at IS NULL
          AND cycle.status = 'active'
          AND cycle_candidate.status = 'active'
          AND cycle.election_year BETWEEN extract(year from ($1::timestamptz AT TIME ZONE 'UTC')::date)::int - 1 AND extract(year from ($1::timestamptz AT TIME ZONE 'UTC')::date)::int + 4
          AND COALESCE(
            general_cycle.election_date,
            (
              make_date(cycle.election_year, 11, 1)
              + (((1 - extract(dow from make_date(cycle.election_year, 11, 1))::int + 7) % 7) + 1)
                * interval '1 day'
            )::date
          ) >= (($1::timestamptz AT TIME ZONE 'UTC')::date - make_interval(days => $4::int))
          AND upper(trim(fec_id.value)) ~ '^P[0-9A-Z]{8}$'
      ),
      candidate_fecs AS (
        SELECT DISTINCT ON (fec_candidate_id, election_year)
          candidate_id,
          fec_candidate_id,
          election_year,
          source
        FROM (
          SELECT * FROM standard_candidate_fecs
          UNION ALL
          SELECT * FROM presidential_candidate_fecs
        ) AS combined
        ORDER BY fec_candidate_id, election_year, source, candidate_id
      ),
      due AS (
        SELECT
          candidate_fecs.candidate_id::text AS candidate_id,
          candidate_fecs.fec_candidate_id,
          candidate_fecs.election_year,
          candidate_fecs.source,
          summary.last_synced_at::text AS last_synced_at,
          COUNT(*) OVER () AS total_due_rows
        FROM candidate_fecs
        LEFT JOIN public.candidate_finance_summaries AS summary
          ON summary.fec_candidate_id = candidate_fecs.fec_candidate_id
         AND summary.election_year = candidate_fecs.election_year
        WHERE $6::boolean
           OR summary.last_synced_at IS NULL
           OR summary.last_synced_at < ($1::timestamptz - make_interval(days => $2::int))
        ORDER BY summary.last_synced_at ASC NULLS FIRST, candidate_fecs.election_year DESC, candidate_fecs.fec_candidate_id
        LIMIT $3::int
      )
      SELECT
        candidate_id,
        fec_candidate_id,
        election_year,
        source,
        last_synced_at,
        total_due_rows
      FROM due
    `,
    [
      input.now.toISOString(),
      input.staleAfterDays,
      input.maxCandidates,
      input.electionLookbackDays,
      input.electionLookaheadDays,
      input.includeFresh === true,
    ]
  );

  return {
    rows: result.rows.map(mapDueRow),
    totalDueRows: result.rows.length > 0 ? parseTotalDueRows(result.rows[0]?.total_due_rows) : 0,
  };
}

export async function syncDueCandidateFinance(
  input: CandidateFinanceBatchSyncInput
): Promise<CandidateFinanceBatchSyncResult> {
  const now = input.now ?? new Date();
  assertValidDate(now, "now");

  const maxCandidates = normalizePositiveInteger(
    input.maxCandidates,
    DEFAULT_CANDIDATE_FINANCE_BATCH_SIZE,
    "maxCandidates"
  );
  const staleAfterDays = normalizePositiveInteger(input.staleAfterDays, DEFAULT_STALE_AFTER_DAYS, "staleAfterDays");
  const electionLookbackDays = normalizePositiveInteger(
    input.electionLookbackDays,
    DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS,
    "electionLookbackDays"
  );
  const electionLookaheadDays = normalizePositiveInteger(
    input.electionLookaheadDays,
    DEFAULT_ELECTION_LOOKAHEAD_DAYS,
    "electionLookaheadDays"
  );
  const includeOutside = input.includeOutside === true;
  const dryRun = input.dryRun === true;
  const syncFn = input.syncCandidateFinanceFn ?? syncCandidateFinance;
  const contributorsOnly = input.contributorsOnly === true;
  const includeContributors = input.includeContributors === true || contributorsOnly;

  const due = await listDueCandidateFinanceSyncRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
  });

  const results: CandidateFinanceBatchSyncItemResult[] = [];
  for (const row of contributorsOnly ? [] : due.rows) {
    try {
      const result = await syncFn({
        db: input.db,
        fecCandidateId: row.fecCandidateId,
        electionYear: row.electionYear,
        openFecOptions: input.openFecOptions,
        dryRun,
        includeOutside,
        perPage: input.perPage,
        outsideGroupLimit: input.outsideGroupLimit,
        fecClient: input.fecClient,
        financeIndustryClassifier: input.financeIndustryClassifier,
        aiClassificationMinAmount: input.aiClassificationMinAmount,
        now,
      });
      results.push({
        candidateId: row.candidateId,
        fecCandidateId: row.fecCandidateId,
        electionYear: row.electionYear,
        source: row.source,
        ok: true,
        result,
      });
    } catch (error) {
      results.push({
        candidateId: row.candidateId,
        fecCandidateId: row.fecCandidateId,
        electionYear: row.electionYear,
        source: row.source,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Runs after the totals sync so new summary rows exist to carry the
  // contributors_synced_at mark.
  const contributorCandidateIds = input.contributorCandidateIds?.length
    ? new Set(input.contributorCandidateIds.map((id) => id.trim().toUpperCase()))
    : null;
  let contributors: CandidateFinanceContributorSyncResult | undefined;
  if (includeContributors) {
    const windowRows = await listDueCandidateFinanceSyncRows(input.db, {
      now,
      staleAfterDays,
      maxCandidates: ALL_WINDOW_CANDIDATES_LIMIT,
      electionLookbackDays,
      electionLookaheadDays,
      includeFresh: true,
    });
    contributors = await (input.syncCandidateFinanceContributorsFn ?? syncCandidateFinanceContributors)({
      db: input.db,
      targets: windowRows.rows
        .filter((row) => !contributorCandidateIds || contributorCandidateIds.has(row.fecCandidateId))
        .map((row) => ({ fecCandidateId: row.fecCandidateId, electionYear: row.electionYear })),
      now,
      dryRun,
      bulkDataDirectory: input.bulkDataDirectory,
    });
  }

  const syncedCandidateCount = results.filter((result) => result.ok).length;
  return {
    dryRun,
    includeOutside,
    now: now.toISOString(),
    staleAfterDays,
    maxCandidates,
    dueCandidateCount: due.totalDueRows,
    selectedCandidateCount: due.rows.length,
    syncedCandidateCount,
    failedCandidateCount: results.length - syncedCandidateCount,
    results,
    ...(contributors ? { contributors } : {}),
  };
}
