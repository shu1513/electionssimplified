import type { Pool, PoolClient } from "pg";

import {
  autoLinkMissingKentuckyCandidateFinanceLinks,
  listKentuckyCandidateElectionsMissingFinanceLinks,
  type KentuckyCandidateFinanceAutoLinkResolver,
  type KentuckyFinanceAutoLinkCandidateElection,
} from "./kentuckyCandidateFinanceAutoLink.js";
import {
  syncKentuckyCandidateFinance,
  type KentuckyCandidateFinanceSyncResult,
} from "./kentuckyCandidateFinanceSync.js";
import { createKentuckyKrefCandidateFinanceLinkResolver } from "./kentuckyCandidateFinanceLinkResolver.js";
import { KENTUCKY_FINANCE_ELIGIBLE_OFFICE_KEYS, normalizeKentuckyKrefLocation } from "./kentuckyFinanceEligibleOffices.js";
import type { KentuckyKrefClientOptions } from "./kentuckyKrefClient.js";
import { isKentuckyReportedCommitteeEnabled, isKentuckyReportedIeEnabled } from "../../config/featureFlags.js";
import { syncDueKentuckyReportedFinance, type KentuckyReportedBatchResult } from "./kentuckyReportedBatchSync.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & Pick<Pool, "connect">;

export type KentuckyCandidateFinanceDueRow = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  electionDate: string;
  officeScope: string;
  officeName: string;
  location: string | null;
  candidateKey: string;
  committeeKey: string;
  committeeName: string;
  sourceUrl: string | null;
  lastSyncedAt: string | null;
};

export type KentuckyCandidateFinanceBatchSyncInput = {
  db: ConnectableQueryable;
  now?: Date;
  dryRun?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  autoLinkMissingLinks?: boolean;
  krefClientOptions?: KentuckyKrefClientOptions;
  syncKentuckyCandidateFinanceFn?: typeof syncKentuckyCandidateFinance;
  resolveCandidateFinanceLink?: KentuckyCandidateFinanceAutoLinkResolver;
};

export type KentuckyCandidateFinanceBatchSyncItemResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  candidateKey: string;
  committeeKey: string;
  ok: boolean;
  result?: KentuckyCandidateFinanceSyncResult;
  error?: string;
};

export type KentuckyCandidateFinanceBatchSyncResult = {
  reported?: KentuckyReportedBatchResult;
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
  autoLinkFailedCount: number;
  results: KentuckyCandidateFinanceBatchSyncItemResult[];
};

type KentuckyCandidateFinanceDueQueryRow = {
  candidate_id: string;
  election_id: string;
  candidate_name: string;
  election_year: number;
  election_date: string;
  office_scope: string;
  office_name: string;
  location: string | null;
  candidate_key: string;
  committee_key: string;
  committee_name: string;
  source_url: string | null;
  last_synced_at: string | null;
  total_due_rows: string | number;
};

const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_STALE_AFTER_DAYS = 7;
const DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS = 1;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

function assertValidDate(date: Date, label: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid Kentucky finance batch sync ${label}`);
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Kentucky finance batch sync ${label}: ${value}`);
  }
  return normalized;
}

function parseTotalDueRows(value: string | number | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function mapDueRow(row: KentuckyCandidateFinanceDueQueryRow): KentuckyCandidateFinanceDueRow {
  return {
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    electionDate: row.election_date,
    officeScope: row.office_scope,
    officeName: row.office_name,
    location: normalizeKentuckyKrefLocation(row.location),
    candidateKey: row.candidate_key,
    committeeKey: row.committee_key,
    committeeName: row.committee_name,
    sourceUrl: row.source_url,
    lastSyncedAt: row.last_synced_at,
  };
}

export async function listDueKentuckyCandidateFinanceSyncRows(
  db: Queryable,
  input: {
    now: Date;
    staleAfterDays: number;
    maxCandidates: number;
    electionLookbackDays: number;
    electionLookaheadDays: number;
  }
): Promise<{ rows: KentuckyCandidateFinanceDueRow[]; totalDueRows: number }> {
  const result = await db.query<KentuckyCandidateFinanceDueQueryRow>(
    `
      WITH due AS (
        SELECT
          link.candidate_id::text AS candidate_id,
          link.election_id::text AS election_id,
          COALESCE(
            NULLIF(trim(candidate.display_name), ''),
            NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), ''),
            link.candidate_name_normalized
          ) AS candidate_name,
          link.election_year,
          election.election_date::text AS election_date,
          office.scope AS office_scope,
          link.office_name,
          link.district AS location,
          link.candidate_key,
          link.committee_key,
          link.committee_name,
          link.source_url,
          summary.last_synced_at::text AS last_synced_at,
          COUNT(*) OVER () AS total_due_rows
        FROM public.ky_candidate_finance_links AS link
        JOIN public.candidates AS candidate
          ON candidate.id = link.candidate_id
        JOIN public.candidate_elections AS candidate_election
          ON candidate_election.candidate_id = link.candidate_id
         AND candidate_election.election_id = link.election_id
        JOIN public.elections AS election
          ON election.id = link.election_id
        JOIN public.districts AS district
          ON district.id = election.district_id
        LEFT JOIN public.offices AS office
          ON office.id = election.office_id
        LEFT JOIN public.ky_candidate_finance_summaries AS summary
          ON summary.link_id = link.id
         AND summary.election_year = link.election_year
        WHERE link.link_status = 'active'
          AND candidate.deleted_at IS NULL
          AND district.state = 'KY'
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
        election_date,
        office_scope,
        office_name,
        location,
        candidate_key,
        committee_key,
        committee_name,
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
      [...KENTUCKY_FINANCE_ELIGIBLE_OFFICE_KEYS],
    ]
  );

  return {
    rows: result.rows.map(mapDueRow),
    totalDueRows: result.rows.length > 0 ? parseTotalDueRows(result.rows[0]?.total_due_rows) : 0,
  };
}

export async function syncDueKentuckyCandidateFinance(
  input: KentuckyCandidateFinanceBatchSyncInput
): Promise<KentuckyCandidateFinanceBatchSyncResult> {
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
  const reported = isKentuckyReportedCommitteeEnabled() || isKentuckyReportedIeEnabled()
    ? await syncDueKentuckyReportedFinance({db:input.db as Pool,now,dryRun,maxCandidates:input.maxCandidates,
      staleAfterDays:input.staleAfterDays,electionLookbackDays:input.electionLookbackDays,electionLookaheadDays:input.electionLookaheadDays}) : undefined;
  const syncFn = input.syncKentuckyCandidateFinanceFn ?? syncKentuckyCandidateFinance;
  let autoLinkAttemptedCount = 0;
  let autoLinkLinkedCount = 0;
  let autoLinkFailedCount = 0;

  if (!dryRun && input.autoLinkMissingLinks !== false) {
    try {
      // No maxCandidates here: unmatched candidates would otherwise occupy a
      // capped, stably-ordered prefix forever and starve the tail (PR #377
      // lesson). The cap still applies to the per-candidate sync below.
      const missingLinkCandidates: KentuckyFinanceAutoLinkCandidateElection[] =
        await listKentuckyCandidateElectionsMissingFinanceLinks(input.db, {
          now,
          electionLookbackDays,
          electionLookaheadDays,
        });
      autoLinkAttemptedCount = missingLinkCandidates.length;
      const autoLinkResults = await autoLinkMissingKentuckyCandidateFinanceLinks({
        db: input.db,
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
        candidateElections: missingLinkCandidates,
        resolveCandidateFinanceLink:
          input.resolveCandidateFinanceLink ??
          createKentuckyKrefCandidateFinanceLinkResolver({ krefClientOptions: input.krefClientOptions }),
      });
      autoLinkLinkedCount = autoLinkResults.filter((result) => result.status === "linked").length;
      autoLinkFailedCount = autoLinkResults.filter((result) => result.status === "error").length;
      for (const result of autoLinkResults) {
        if (result.status !== "linked") {
          console.warn("Kentucky finance auto-link did not link candidate election:", result);
        }
      }
    } catch (error) {
      console.warn(
        "Kentucky finance auto-link skipped; continuing with already-linked candidate sync:",
        error instanceof Error ? error.message : error
      );
    }
  }

  const due = await listDueKentuckyCandidateFinanceSyncRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
  });

  const results: KentuckyCandidateFinanceBatchSyncItemResult[] = [];
  for (const row of due.rows) {
    try {
      const result = await syncFn({
        db: input.db,
        candidateId: row.candidateId,
        electionId: row.electionId,
        candidateName: row.candidateName,
        electionYear: row.electionYear,
        electionDate: row.electionDate,
        officeName: row.officeName,
        location: row.location,
        district: row.location,
        sourceUrl: row.sourceUrl,
        trustedLink: {
          candidateKey: row.candidateKey,
          committeeKey: row.committeeKey,
          committeeName: row.committeeName,
          sourceUrl: row.sourceUrl,
        },
        krefClientOptions: input.krefClientOptions,
        dryRun,
        now,
      });
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        candidateKey: row.candidateKey,
        committeeKey: row.committeeKey,
        ok: true,
        result,
      });
    } catch (error) {
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        candidateKey: row.candidateKey,
        committeeKey: row.committeeKey,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const syncedCandidateCount = results.filter((result) => result.ok).length;
  return {
    dryRun,
    now: now.toISOString(),
    ...(reported ? {reported} : {}),
    staleAfterDays,
    maxCandidates,
    dueCandidateCount: due.totalDueRows,
    selectedCandidateCount: due.rows.length,
    syncedCandidateCount,
    failedCandidateCount: results.length - syncedCandidateCount,
    autoLinkAttemptedCount,
    autoLinkLinkedCount,
    autoLinkFailedCount,
    results,
  };
}
