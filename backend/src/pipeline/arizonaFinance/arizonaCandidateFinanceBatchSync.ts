import type { Pool, PoolClient } from "pg";

import {
  syncArizonaCandidateFinance,
  type ArizonaCandidateFinanceSyncResult,
} from "./arizonaCandidateFinanceSync.js";
import { ARIZONA_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./arizonaFinanceEligibleOffices.js";
import type { ArizonaFinanceLinkSource } from "./arizonaFinanceWriter.js";
import type { ArizonaSpotlightClientOptions } from "./arizonaSpotlightClient.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type ArizonaCandidateFinanceDueRow = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district: string | null;
  committeeId: string;
  committeeName: string;
  linkSource: ArizonaFinanceLinkSource;
  sourceUrl: string | null;
  lastSyncedAt: string | null;
};

export type ArizonaFinanceAutoLinkCandidateElection = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district: string | null;
};

export type ArizonaCandidateFinanceBatchSyncInput = {
  db: Queryable;
  now?: Date;
  dryRun?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  autoLinkMissingLinks?: boolean;
  spotlightClientOptions?: ArizonaSpotlightClientOptions;
  directIncomeLimit?: number;
  independentExpenditureLimitPerPosition?: number;
  outsideGroupIncomeLimitPerGroup?: number;
  outsideMaxGroups?: number;
  directMaxBreakdownsPerCategory?: number;
  outsideMaxBreakdownsPerCategory?: number;
  minIndustryAmount?: number;
  syncArizonaCandidateFinanceFn?: typeof syncArizonaCandidateFinance;
};

export type ArizonaCandidateFinanceBatchSyncItemResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  committeeId: string | null;
  ok: boolean;
  result?: ArizonaCandidateFinanceSyncResult;
  error?: string;
};

export type ArizonaCandidateFinanceBatchSyncResult = {
  dryRun: boolean;
  now: string;
  staleAfterDays: number;
  maxCandidates: number;
  dueCandidateCount: number;
  selectedCandidateCount: number;
  syncedCandidateCount: number;
  failedCandidateCount: number;
  autoLinkAttemptedCount: number;
  autoLinkLinkedCount: number;
  results: ArizonaCandidateFinanceBatchSyncItemResult[];
};

type ArizonaCandidateFinanceDueQueryRow = {
  candidate_id: string;
  election_id: string;
  candidate_name: string;
  election_year: number;
  office_scope: string;
  office_name: string;
  district: string | null;
  committee_id: string;
  committee_name: string;
  link_source: ArizonaFinanceLinkSource;
  source_url: string | null;
  last_synced_at: string | null;
  total_due_rows: string | number;
};

type ArizonaMissingFinanceLinkQueryRow = {
  candidate_id: string;
  election_id: string;
  candidate_name: string;
  election_year: number;
  office_scope: string;
  office_name: string;
  district: string | null;
};

const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_STALE_AFTER_DAYS = 7;
const DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS = 1;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

function assertValidDate(date: Date, label: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid Arizona finance batch sync ${label}`);
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Arizona finance batch sync ${label}: ${value}`);
  }
  return normalized;
}

function parseTotalDueRows(value: string | number | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function mapDueRow(row: ArizonaCandidateFinanceDueQueryRow): ArizonaCandidateFinanceDueRow {
  return {
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    district: row.district,
    committeeId: row.committee_id,
    committeeName: row.committee_name,
    linkSource: row.link_source,
    sourceUrl: row.source_url,
    lastSyncedAt: row.last_synced_at,
  };
}

function mapMissingRow(row: ArizonaMissingFinanceLinkQueryRow): ArizonaFinanceAutoLinkCandidateElection {
  return {
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name ?? "",
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    district: row.district,
  };
}

export async function listArizonaCandidateElectionsMissingFinanceLinks(
  db: Queryable,
  input: {
    now: Date;
    maxCandidates: number;
    electionLookbackDays: number;
    electionLookaheadDays: number;
  }
): Promise<ArizonaFinanceAutoLinkCandidateElection[]> {
  const result = await db.query<ArizonaMissingFinanceLinkQueryRow>(
    `
      SELECT
        candidate.id::text AS candidate_id,
        election.id::text AS election_id,
        COALESCE(
          NULLIF(trim(candidate.display_name), ''),
          NULLIF(trim(concat_ws(' ', candidate.first_name, candidate.last_name)), ''),
          ''
        ) AS candidate_name,
        extract(year from election.election_date)::int AS election_year,
        office.scope AS office_scope,
        office.canonical_name AS office_name,
        district.name AS district
      FROM public.candidate_elections AS candidate_election
      JOIN public.candidates AS candidate
        ON candidate.id = candidate_election.candidate_id
      JOIN public.elections AS election
        ON election.id = candidate_election.election_id
      JOIN public.districts AS district
        ON district.id = election.district_id
      JOIN public.offices AS office
        ON office.id = election.office_id
      LEFT JOIN public.az_candidate_finance_links AS link
        ON link.candidate_id = candidate.id
       AND link.election_id = election.id
       AND link.link_status = 'active'
      WHERE candidate.deleted_at IS NULL
        AND district.state = 'AZ'
        AND election.race_type = 'office'
        AND election.election_date >= ($1::date - make_interval(days => $2::int))
        AND election.election_date <= ($1::date + make_interval(days => $3::int))
        AND candidate_election.status NOT IN ('withdrawn', 'lost')
        AND (office.scope || '::' || office.canonical_name) = ANY($5::text[])
        AND link.id IS NULL
      -- Upcoming races first, then random: unmatched candidates never get a
      -- link, so a stable order under a row cap retried the same prefix every
      -- run and starved the tail (Katie Hobbs was never attempted).
      ORDER BY (election.election_date < CURRENT_DATE) ASC, random()
      LIMIT $4::int
    `,
    [
      input.now.toISOString(),
      input.electionLookbackDays,
      input.electionLookaheadDays,
      input.maxCandidates,
      [...ARIZONA_FINANCE_ELIGIBLE_OFFICE_KEYS],
    ]
  );
  return result.rows.map(mapMissingRow).filter((row) => row.candidateName.trim().length > 0);
}

export async function listDueArizonaCandidateFinanceSyncRows(
  db: Queryable,
  input: {
    now: Date;
    staleAfterDays: number;
    maxCandidates: number;
    electionLookbackDays: number;
    electionLookaheadDays: number;
  }
): Promise<{ rows: ArizonaCandidateFinanceDueRow[]; totalDueRows: number }> {
  const result = await db.query<ArizonaCandidateFinanceDueQueryRow>(
    `
      WITH due AS (
        SELECT
          link.candidate_id::text AS candidate_id,
          link.election_id::text AS election_id,
          COALESCE(
            NULLIF(trim(candidate.display_name), ''),
            NULLIF(trim(concat_ws(' ', candidate.first_name, candidate.last_name)), ''),
            link.candidate_name_normalized
          ) AS candidate_name,
          link.election_year,
          office.scope AS office_scope,
          link.office_name,
          link.district,
          link.committee_id,
          link.committee_name,
          link.link_source,
          link.source_url,
          summary.last_synced_at::text AS last_synced_at,
          COUNT(*) OVER () AS total_due_rows
        FROM public.az_candidate_finance_links AS link
        JOIN public.candidates AS candidate
          ON candidate.id = link.candidate_id
        JOIN public.candidate_elections AS candidate_election
          ON candidate_election.candidate_id = link.candidate_id
         AND candidate_election.election_id = link.election_id
        JOIN public.elections AS election
          ON election.id = link.election_id
        JOIN public.districts AS district
          ON district.id = election.district_id
        JOIN public.offices AS office
          ON office.id = election.office_id
        LEFT JOIN public.az_candidate_finance_summaries AS summary
          ON summary.link_id = link.id
         AND summary.election_year = link.election_year
        WHERE link.link_status = 'active'
          AND candidate.deleted_at IS NULL
          AND district.state = 'AZ'
          AND election.race_type = 'office'
          AND election.election_date >= (($1::timestamptz AT TIME ZONE 'UTC')::date - make_interval(days => $4::int))
          AND election.election_date <= (($1::timestamptz AT TIME ZONE 'UTC')::date + make_interval(days => $5::int))
          AND candidate_election.status NOT IN ('withdrawn', 'lost')
          AND (office.scope || '::' || office.canonical_name) = ANY($6::text[])
          AND (
            summary.last_synced_at IS NULL
            OR summary.last_synced_at < ($1::timestamptz - make_interval(days => $2::int))
          )
        ORDER BY summary.last_synced_at ASC NULLS FIRST,
                 election.election_date ASC,
                 link.candidate_name_normalized ASC,
                 link.id ASC
        LIMIT $3::int
      )
      SELECT
        candidate_id,
        election_id,
        candidate_name,
        election_year,
        office_scope,
        office_name,
        district,
        committee_id,
        committee_name,
        link_source,
        source_url,
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
      [...ARIZONA_FINANCE_ELIGIBLE_OFFICE_KEYS],
    ]
  );
  return {
    rows: result.rows.map(mapDueRow),
    totalDueRows: result.rows.length > 0 ? parseTotalDueRows(result.rows[0]?.total_due_rows) : 0,
  };
}

export async function syncDueArizonaCandidateFinance(
  input: ArizonaCandidateFinanceBatchSyncInput
): Promise<ArizonaCandidateFinanceBatchSyncResult> {
  const now = input.now ?? new Date();
  assertValidDate(now, "now");
  const maxCandidates = normalizePositiveInteger(input.maxCandidates, DEFAULT_MAX_CANDIDATES, "maxCandidates");
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
  const dryRun = input.dryRun === true;
  const syncFn = input.syncArizonaCandidateFinanceFn ?? syncArizonaCandidateFinance;
  const results: ArizonaCandidateFinanceBatchSyncItemResult[] = [];
  let autoLinkAttemptedCount = 0;
  let autoLinkLinkedCount = 0;

  if (!dryRun && input.autoLinkMissingLinks !== false) {
    const missing = await listArizonaCandidateElectionsMissingFinanceLinks(input.db, {
      now,
      maxCandidates,
      electionLookbackDays,
      electionLookaheadDays,
    });
    autoLinkAttemptedCount = missing.length;
    for (const row of missing) {
      try {
        const result = await syncFn({
          db: input.db,
          candidateId: row.candidateId,
          electionId: row.electionId,
          candidateName: row.candidateName,
          electionYear: row.electionYear,
          officeScope: row.officeScope,
          officeName: row.officeName,
          district: row.district,
          spotlightClientOptions: input.spotlightClientOptions,
          directIncomeLimit: input.directIncomeLimit,
          independentExpenditureLimitPerPosition: input.independentExpenditureLimitPerPosition,
          outsideGroupIncomeLimitPerGroup: input.outsideGroupIncomeLimitPerGroup,
          outsideMaxGroups: input.outsideMaxGroups,
          directMaxBreakdownsPerCategory: input.directMaxBreakdownsPerCategory,
          outsideMaxBreakdownsPerCategory: input.outsideMaxBreakdownsPerCategory,
          minIndustryAmount: input.minIndustryAmount,
          dryRun,
          now,
        });
        if (result.linkWritten) {
          autoLinkLinkedCount += 1;
        }
        results.push({
          candidateId: row.candidateId,
          electionId: row.electionId,
          electionYear: row.electionYear,
          committeeId: result.resolution.status === "matched" ? result.resolution.committeeId : null,
          ok: true,
          result,
        });
      } catch (error) {
        results.push({
          candidateId: row.candidateId,
          electionId: row.electionId,
          electionYear: row.electionYear,
          committeeId: null,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (results.length >= maxCandidates) {
        break;
      }
    }
  }

  const remainingCandidateBudget = Math.max(0, maxCandidates - results.length);

  const due = await listDueArizonaCandidateFinanceSyncRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates: remainingCandidateBudget,
    electionLookbackDays,
    electionLookaheadDays,
  });

  for (const row of due.rows) {
    try {
      const result = await syncFn({
        db: input.db,
        candidateId: row.candidateId,
        electionId: row.electionId,
        candidateName: row.candidateName,
        electionYear: row.electionYear,
        officeScope: row.officeScope,
        officeName: row.officeName,
        district: row.district,
        sourceUrl: row.sourceUrl,
        spotlightClientOptions: input.spotlightClientOptions,
        directIncomeLimit: input.directIncomeLimit,
        independentExpenditureLimitPerPosition: input.independentExpenditureLimitPerPosition,
        outsideGroupIncomeLimitPerGroup: input.outsideGroupIncomeLimitPerGroup,
        outsideMaxGroups: input.outsideMaxGroups,
        directMaxBreakdownsPerCategory: input.directMaxBreakdownsPerCategory,
        outsideMaxBreakdownsPerCategory: input.outsideMaxBreakdownsPerCategory,
        minIndustryAmount: input.minIndustryAmount,
        trustedCommittee: {
          committeeId: row.committeeId,
          committeeName: row.committeeName,
          candidateFilerId: row.committeeId,
          linkSource: row.linkSource,
          sourceUrl: row.sourceUrl,
        },
        dryRun,
        now,
      });
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        committeeId: row.committeeId,
        ok: true,
        result,
      });
    } catch (error) {
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        committeeId: row.committeeId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const syncedCandidateCount = results.filter((result) => result.ok).length;
  return {
    dryRun,
    now: now.toISOString(),
    staleAfterDays,
    maxCandidates,
    dueCandidateCount: due.totalDueRows,
    selectedCandidateCount: results.length,
    syncedCandidateCount,
    failedCandidateCount: results.length - syncedCandidateCount,
    autoLinkAttemptedCount,
    autoLinkLinkedCount,
    results,
  };
}
