import type { Pool, PoolClient } from "pg";

import type { FinanceIndustryClassifier } from "../finance/financeIndustryClassificationService.js";
import {
  autoLinkMissingWashingtonCandidateFinanceLinks,
  listWashingtonCandidateElectionsMissingFinanceLinks,
  type WashingtonFinanceAutoLinkCandidateElection,
  type WashingtonCandidateCommitteeResolver,
} from "./washingtonCandidateFinanceAutoLink.js";
import {
  syncWashingtonCandidateFinance,
  type WashingtonCandidateFinanceSyncResult,
} from "./washingtonCandidateFinanceSync.js";
import { WASHINGTON_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./washingtonFinanceEligibleOffices.js";
import type { WashingtonPdcClientOptions } from "./washingtonPdcClient.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & Pick<Pool, "connect">;

export type WashingtonCandidateFinanceDueRow = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  legislativeDistrict: string | null;
  filerId: string;
  committeeId: string;
  committeeName: string;
  candidacyId: string | null;
  sourceUrl: string | null;
  lastSyncedAt: string | null;
};

export type WashingtonCandidateFinanceBatchSyncInput = {
  db: ConnectableQueryable;
  now?: Date;
  dryRun?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  autoLinkMissingLinks?: boolean;
  pdcClientOptions?: WashingtonPdcClientOptions;
  financeIndustryClassifier?: FinanceIndustryClassifier;
  aiClassificationMinAmount?: number;
  syncWashingtonCandidateFinanceFn?: typeof syncWashingtonCandidateFinance;
  resolveCandidateCommittee?: WashingtonCandidateCommitteeResolver;
};

export type WashingtonCandidateFinanceBatchSyncItemResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  filerId: string;
  committeeId: string;
  ok: boolean;
  result?: WashingtonCandidateFinanceSyncResult;
  error?: string;
};

export type WashingtonCandidateFinanceBatchSyncResult = {
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
  results: WashingtonCandidateFinanceBatchSyncItemResult[];
};

type WashingtonCandidateFinanceDueQueryRow = {
  candidate_id: string;
  election_id: string;
  candidate_name: string;
  election_year: number;
  office_scope: string;
  office_name: string;
  legislative_district: string | null;
  filer_id: string;
  committee_id: string;
  committee_name: string;
  candidacy_id: string | null;
  source_url: string | null;
  last_synced_at: string | null;
  total_due_rows: string | number;
};

const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_STALE_AFTER_DAYS = 7;
// Keep one extra calendar day so UTC scheduler timing cannot skip election-night finance syncs.
const DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS = 1;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

function assertValidDate(date: Date, label: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid Washington finance batch sync ${label}`);
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Washington finance batch sync ${label}: ${value}`);
  }
  return normalized;
}

function parseTotalDueRows(value: string | number | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function mapDueRow(row: WashingtonCandidateFinanceDueQueryRow): WashingtonCandidateFinanceDueRow {
  return {
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    legislativeDistrict: row.legislative_district,
    filerId: row.filer_id,
    committeeId: row.committee_id,
    committeeName: row.committee_name,
    candidacyId: row.candidacy_id,
    sourceUrl: row.source_url,
    lastSyncedAt: row.last_synced_at,
  };
}

export async function listDueWashingtonCandidateFinanceSyncRows(
  db: Queryable,
  input: {
    now: Date;
    staleAfterDays: number;
    maxCandidates: number;
    electionLookbackDays: number;
    electionLookaheadDays: number;
  }
): Promise<{ rows: WashingtonCandidateFinanceDueRow[]; totalDueRows: number }> {
  // Race-mates ride along (same rule as the shared standard due list): every
  // other eligible candidate of a due row's election joins the batch, so
  // opponents' outside groups always come from the same source snapshot.
  const result = await db.query<WashingtonCandidateFinanceDueQueryRow>(
    `
      WITH eligible AS (
        SELECT
          link.candidate_id::text AS candidate_id,
          link.election_id::text AS election_id,
          COALESCE(
            NULLIF(trim(candidate.display_name), ''),
            NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), ''),
            link.candidate_name_normalized
          ) AS candidate_name,
          link.election_year,
          office.scope AS office_scope,
          link.office_name,
          link.district AS legislative_district,
          link.filer_id,
          link.committee_id,
          link.committee_name,
          link.candidacy_id,
          link.source_url,
          summary.last_synced_at::text AS last_synced_at,
          link.id AS sort_link_id,
          link.candidate_name_normalized AS sort_name,
          election.election_date AS sort_election_date,
          summary.last_synced_at AS sort_synced_at,
          (
            summary.last_synced_at IS NULL
            OR summary.last_synced_at < ($1::timestamptz - make_interval(days => $2::int))
          ) AS is_stale
        FROM public.wa_candidate_finance_links AS link
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
        LEFT JOIN public.wa_candidate_finance_summaries AS summary
          ON summary.link_id = link.id
         AND summary.election_year = link.election_year
        WHERE link.link_status = 'active'
          AND candidate.deleted_at IS NULL
          AND district.state = 'WA'
          AND election.race_type = 'office'
          AND election.election_date >= (($1::timestamptz AT TIME ZONE 'UTC')::date - make_interval(days => $4::int))
          AND election.election_date <= (($1::timestamptz AT TIME ZONE 'UTC')::date + make_interval(days => $5::int))
          AND candidate_election.status NOT IN ('withdrawn', 'lost')
          AND (office.scope || '::' || office.canonical_name) = ANY($6::text[])
      ),
      due AS (
        SELECT eligible.*, COUNT(*) OVER () AS total_due_rows
        FROM eligible
        WHERE eligible.is_stale
        ORDER BY eligible.sort_synced_at ASC NULLS FIRST,
                 eligible.sort_election_date ASC,
                 eligible.sort_name ASC,
                 eligible.sort_link_id ASC
        LIMIT $3::int
      ),
      batch AS (
        SELECT due.*, 0 AS race_mate
        FROM due
        UNION ALL
        SELECT eligible.*, (SELECT MAX(due.total_due_rows) FROM due), 1 AS race_mate
        FROM eligible
        WHERE eligible.election_id IN (SELECT due.election_id FROM due)
          AND eligible.sort_link_id NOT IN (SELECT due.sort_link_id FROM due)
      )
      SELECT
        candidate_id,
        election_id,
        candidate_name,
        election_year,
        office_scope,
        office_name,
        legislative_district,
        filer_id,
        committee_id,
        committee_name,
        candidacy_id,
        source_url,
        last_synced_at,
        total_due_rows
      FROM batch
      ORDER BY race_mate ASC,
               sort_synced_at ASC NULLS FIRST,
               sort_election_date ASC,
               sort_name ASC,
               sort_link_id ASC
    `,
    [
      input.now.toISOString(),
      input.staleAfterDays,
      input.maxCandidates,
      input.electionLookbackDays,
      input.electionLookaheadDays,
      [...WASHINGTON_FINANCE_ELIGIBLE_OFFICE_KEYS],
    ]
  );

  return {
    rows: result.rows.map(mapDueRow),
    totalDueRows: result.rows.length > 0 ? parseTotalDueRows(result.rows[0]?.total_due_rows) : 0,
  };
}

export async function syncDueWashingtonCandidateFinance(
  input: WashingtonCandidateFinanceBatchSyncInput
): Promise<WashingtonCandidateFinanceBatchSyncResult> {
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
  const syncFn = input.syncWashingtonCandidateFinanceFn ?? syncWashingtonCandidateFinance;
  let autoLinkAttemptedCount = 0;
  let autoLinkLinkedCount = 0;

  if (!dryRun && input.autoLinkMissingLinks !== false) {
    try {
      const missingLinkCandidates: WashingtonFinanceAutoLinkCandidateElection[] =
        await listWashingtonCandidateElectionsMissingFinanceLinks(input.db, {
          now,
          maxCandidates,
          electionLookbackDays,
          electionLookaheadDays,
        });
      autoLinkAttemptedCount = missingLinkCandidates.length;
      const autoLinkResults = await autoLinkMissingWashingtonCandidateFinanceLinks({
        db: input.db,
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
        candidateElections: missingLinkCandidates,
        pdcClientOptions: input.pdcClientOptions,
        resolveCandidateCommittee: input.resolveCandidateCommittee,
      });
      autoLinkLinkedCount = autoLinkResults.filter((result) => result.status === "linked").length;
      for (const result of autoLinkResults) {
        if (result.status !== "linked") {
          console.warn("Washington finance auto-link did not link candidate election:", result);
        }
      }
    } catch (error) {
      console.warn(
        "Washington finance auto-link skipped; continuing with already-linked candidate sync:",
        error instanceof Error ? error.message : error
      );
    }
  }

  const due = await listDueWashingtonCandidateFinanceSyncRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
  });

  const results: WashingtonCandidateFinanceBatchSyncItemResult[] = [];
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
        legislativeDistrict: row.legislativeDistrict,
        sourceUrl: row.sourceUrl,
        trustedCommittee: {
          filerId: row.filerId,
          committeeId: row.committeeId,
          committeeName: row.committeeName,
          candidacyId: row.candidacyId,
          sourceUrl: row.sourceUrl,
        },
        pdcClientOptions: input.pdcClientOptions,
        financeIndustryClassifier: input.financeIndustryClassifier,
        aiClassificationMinAmount: input.aiClassificationMinAmount,
        dryRun,
        now,
      });
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        filerId: row.filerId,
        committeeId: row.committeeId,
        ok: true,
        result,
      });
    } catch (error) {
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        filerId: row.filerId,
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
    selectedCandidateCount: due.rows.length,
    syncedCandidateCount,
    failedCandidateCount: results.length - syncedCandidateCount,
    autoLinkAttemptedCount,
    autoLinkLinkedCount,
    results,
  };
}
