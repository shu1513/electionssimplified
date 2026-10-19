import type { Pool, PoolClient } from "pg";
import {syncDueCaliforniaCommitteeReceipts} from "./californiaReportedCommitteeBatchSync.js";

import {
  syncCaliforniaCandidateFinance,
  type CaliforniaCandidateFinancePowerSearchClient,
  type CaliforniaCandidateFinanceSyncResult,
} from "./californiaCandidateFinanceSync.js";
import {
  autoLinkMissingCaliforniaCandidateFinanceLinks,
} from "./californiaCandidateFinanceAutoLink.js";
import {
  loadCalAccessCommitteeResolutionData,
  loadCalAccessReceiptRowsForCommittees,
  type CalAccessCommitteeReceiptData,
  type CalAccessCommitteeResolutionData,
} from "./calAccessRawDataLoader.js";
import type { CalAccessReceiptRow } from "./californiaDirectContributionAggregator.js";
import { type CaliforniaPowerSearchClientOptions } from "./californiaPowerSearchClient.js";
import type { FinanceIndustryClassifier } from "../finance/financeIndustryClassificationService.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type CaliforniaCandidateFinanceDueRow = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeName: string;
  controlledCommitteeId: string;
  controlledCommitteeName: string;
  sourceUrl: string | null;
  lastSyncedAt: string | null;
};

export type CaliforniaCandidateFinanceBatchSyncInput = {
  db: Queryable;
  now?: Date;
  dryRun?: boolean;
  includeOutside?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  powerSearchOptions?: CaliforniaPowerSearchClientOptions;
  powerSearchClient?: CaliforniaCandidateFinancePowerSearchClient;
  rawDataZipPath?: string;
  rawDataCacheDir?: string;
  rawDataResolutionData?: CalAccessCommitteeResolutionData | null;
  rawDataReceiptData?: CalAccessCommitteeReceiptData | null;
  autoLinkMissingLinks?: boolean;
  financeIndustryClassifier?: FinanceIndustryClassifier;
  aiClassificationMinAmount?: number;
  syncCaliforniaCandidateFinanceFn?: typeof syncCaliforniaCandidateFinance;
};

export type CaliforniaCandidateFinanceBatchSyncItemResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  controlledCommitteeId: string;
  ok: boolean;
  result?: CaliforniaCandidateFinanceSyncResult;
  error?: string;
};

export type CaliforniaCandidateFinanceBatchSyncResult = {
  reportedCommittees?: Awaited<ReturnType<typeof syncDueCaliforniaCommitteeReceipts>>;
  dryRun: boolean;
  includeOutside: boolean;
  now: string;
  staleAfterDays: number;
  maxCandidates: number;
  dueCandidateCount: number;
  selectedCandidateCount: number;
  syncedCandidateCount: number;
  failedCandidateCount: number;
  results: CaliforniaCandidateFinanceBatchSyncItemResult[];
};

type CaliforniaCandidateFinanceDueQueryRow = {
  candidate_id: string;
  election_id: string;
  candidate_name: string;
  election_year: number;
  office_name: string;
  controlled_committee_id: string;
  controlled_committee_name: string;
  source_url: string | null;
  last_synced_at: string | null;
  total_due_rows: string | number;
};

type CalAccessReceiptRowsForCommitteesLoader = (
  committeeIds: readonly string[]
) => Promise<CalAccessCommitteeReceiptData | null>;

const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_STALE_AFTER_DAYS = 7;
// Keep one extra calendar day so UTC scheduler timing cannot skip election-night finance syncs.
const DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS = 1;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

function assertValidDate(date: Date, label: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid California finance batch sync ${label}`);
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid California finance batch sync ${label}: ${value}`);
  }
  return normalized;
}

function parseTotalDueRows(value: string | number | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeCommitteeId(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeCommitteeIds(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeCommitteeId).filter(Boolean))];
}

function mergeReceiptDataCache(
  target: CalAccessCommitteeReceiptData,
  source: CalAccessCommitteeReceiptData
): void {
  for (const [committeeId, rows] of source.receiptRowsByCommitteeId.entries()) {
    target.receiptRowsByCommitteeId.set(normalizeCommitteeId(committeeId), rows);
  }
  for (const [committeeId, filingIds] of source.controlledCommitteeFilingIdsByCommitteeId.entries()) {
    target.controlledCommitteeFilingIdsByCommitteeId.set(
      normalizeCommitteeId(committeeId),
      normalizeCommitteeIds(filingIds)
    );
  }
}

function subsetReceiptDataCache(
  cache: CalAccessCommitteeReceiptData,
  committeeIds: readonly string[]
): CalAccessCommitteeReceiptData | null {
  const normalizedIds = normalizeCommitteeIds(committeeIds);
  if (normalizedIds.length === 0) {
    return null;
  }

  const receiptRowsByCommitteeId = new Map<string, CalAccessReceiptRow[]>();
  const controlledCommitteeFilingIdsByCommitteeId = new Map<string, string[]>();
  for (const committeeId of normalizedIds) {
    const rows = cache.receiptRowsByCommitteeId.get(committeeId);
    if (rows) {
      receiptRowsByCommitteeId.set(committeeId, rows);
    }
    const filingIds = cache.controlledCommitteeFilingIdsByCommitteeId.get(committeeId);
    if (filingIds) {
      controlledCommitteeFilingIdsByCommitteeId.set(committeeId, filingIds);
    }
  }

  return {
    zipPath: cache.zipPath,
    sourceUrl: cache.sourceUrl,
    receiptRowsByCommitteeId,
    controlledCommitteeFilingIdsByCommitteeId,
  };
}

export function createCalAccessReceiptRowsForCommitteesCache(input: {
  initialData?: CalAccessCommitteeReceiptData | null;
  load: CalAccessReceiptRowsForCommitteesLoader;
}): CalAccessReceiptRowsForCommitteesLoader {
  let cache: CalAccessCommitteeReceiptData | null = input.initialData
    ? {
        zipPath: input.initialData.zipPath,
        sourceUrl: input.initialData.sourceUrl,
        receiptRowsByCommitteeId: new Map(
          [...input.initialData.receiptRowsByCommitteeId.entries()].map(([committeeId, rows]) => [
            normalizeCommitteeId(committeeId),
            rows,
          ])
        ),
        controlledCommitteeFilingIdsByCommitteeId: new Map(
          [...input.initialData.controlledCommitteeFilingIdsByCommitteeId.entries()].map(([committeeId, filingIds]) => [
            normalizeCommitteeId(committeeId),
            normalizeCommitteeIds(filingIds),
          ])
        ),
      }
    : null;
  const attemptedCommitteeIds = new Set<string>([
    ...(cache?.receiptRowsByCommitteeId.keys() ?? []),
    ...(cache?.controlledCommitteeFilingIdsByCommitteeId.keys() ?? []),
  ]);

  return async (committeeIds: readonly string[]) => {
    const normalizedIds = normalizeCommitteeIds(committeeIds);
    if (normalizedIds.length === 0) {
      return null;
    }

    const missingIds = normalizedIds.filter((committeeId) => !attemptedCommitteeIds.has(committeeId));
    if (missingIds.length > 0) {
      const loaded = await input.load(missingIds);
      for (const committeeId of missingIds) {
        attemptedCommitteeIds.add(committeeId);
      }
      if (loaded) {
        if (cache) {
          mergeReceiptDataCache(cache, loaded);
        } else {
          cache = {
            zipPath: loaded.zipPath,
            sourceUrl: loaded.sourceUrl,
            receiptRowsByCommitteeId: new Map(
              [...loaded.receiptRowsByCommitteeId.entries()].map(([committeeId, rows]) => [
                normalizeCommitteeId(committeeId),
                rows,
              ])
            ),
            controlledCommitteeFilingIdsByCommitteeId: new Map(
              [...loaded.controlledCommitteeFilingIdsByCommitteeId.entries()].map(([committeeId, filingIds]) => [
                normalizeCommitteeId(committeeId),
                normalizeCommitteeIds(filingIds),
              ])
            ),
          };
        }
      }
    }

    return cache ? subsetReceiptDataCache(cache, normalizedIds) : null;
  };
}

function mapDueRow(row: CaliforniaCandidateFinanceDueQueryRow): CaliforniaCandidateFinanceDueRow {
  return {
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    officeName: row.office_name,
    controlledCommitteeId: row.controlled_committee_id,
    controlledCommitteeName: row.controlled_committee_name,
    sourceUrl: row.source_url,
    lastSyncedAt: row.last_synced_at,
  };
}

export async function listDueCaliforniaCandidateFinanceSyncRows(
  db: Queryable,
  input: {
    now: Date;
    staleAfterDays: number;
    maxCandidates: number;
    electionLookbackDays: number;
    electionLookaheadDays: number;
  }
): Promise<{ rows: CaliforniaCandidateFinanceDueRow[]; totalDueRows: number }> {
  const result = await db.query<CaliforniaCandidateFinanceDueQueryRow>(
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
          link.office_name,
          link.controlled_committee_id,
          link.controlled_committee_name,
          link.source_url,
          summary.last_synced_at::text AS last_synced_at,
          COUNT(*) OVER () AS total_due_rows
        FROM public.ca_candidate_finance_links AS link
        JOIN public.candidates AS candidate
          ON candidate.id = link.candidate_id
        JOIN public.candidate_elections AS candidate_election
          ON candidate_election.candidate_id = link.candidate_id
         AND candidate_election.election_id = link.election_id
        JOIN public.elections AS election
          ON election.id = link.election_id
        JOIN public.districts AS district
          ON district.id = election.district_id
        LEFT JOIN public.ca_candidate_finance_summaries AS summary
          ON summary.link_id = link.id
         AND summary.election_year = link.election_year
        WHERE link.link_status = 'active'
          AND candidate.deleted_at IS NULL
          AND district.state = 'CA'
          AND election.race_type = 'office'
          AND election.election_date >= (($1::timestamptz AT TIME ZONE 'UTC')::date - make_interval(days => $4::int))
          AND election.election_date <= (($1::timestamptz AT TIME ZONE 'UTC')::date + make_interval(days => $5::int))
          AND candidate_election.status NOT IN ('withdrawn', 'lost')
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
        office_name,
        controlled_committee_id,
        controlled_committee_name,
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
    ]
  );

  return {
    rows: result.rows.map(mapDueRow),
    totalDueRows: result.rows.length > 0 ? parseTotalDueRows(result.rows[0]?.total_due_rows) : 0,
  };
}

export async function syncDueCaliforniaCandidateFinance(
  input: CaliforniaCandidateFinanceBatchSyncInput
): Promise<CaliforniaCandidateFinanceBatchSyncResult> {
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
  const includeOutside = input.includeOutside !== false;
  const dryRun = input.dryRun === true;
  const resolutionData =
    input.rawDataResolutionData === undefined
      ? await loadCalAccessCommitteeResolutionData({
          zipPath: input.rawDataZipPath,
          cacheDir: input.rawDataCacheDir,
        })
      : input.rawDataResolutionData;
  let reportedCommittees:CaliforniaCandidateFinanceBatchSyncResult["reportedCommittees"];
  try{reportedCommittees=await syncDueCaliforniaCommitteeReceipts({db:input.db,now,dryRun,maxCandidates,staleAfterDays,electionLookbackDays:input.electionLookbackDays??98,electionLookaheadDays,cacheDir:input.rawDataCacheDir,resolutionData});}
  catch{console.warn("California reported committee receipts unavailable; legacy sync continues");}
  const syncFn = input.syncCaliforniaCandidateFinanceFn ?? syncCaliforniaCandidateFinance;

  // Auto-link writes candidate->committee links, so it must respect dryRun —
  // Pennsylvania's batch sync applies the same guard (a live CA "--dry-run"
  // used to commit link rows while skipping only the money sync).
  if (!dryRun && input.autoLinkMissingLinks !== false && resolutionData) {
    try {
      const autoLinkResults = await autoLinkMissingCaliforniaCandidateFinanceLinks({
        db: input.db,
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
        resolutionData,
      });
      for (const result of autoLinkResults) {
        if (result.status !== "linked") {
          console.warn("California finance auto-link did not link candidate election:", result);
        }
      }
    } catch (error) {
      console.warn(
        "California finance auto-link skipped; continuing with already-linked candidate sync:",
        error instanceof Error ? error.message : error
      );
    }
  }

  const due = await listDueCaliforniaCandidateFinanceSyncRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
  });
  const receiptData =
    input.rawDataReceiptData === undefined && resolutionData && due.rows.length > 0
      ? await loadCalAccessReceiptRowsForCommittees({
          zipPath: input.rawDataZipPath ?? resolutionData.zipPath,
          cacheDir: input.rawDataCacheDir,
          sourceUrl: resolutionData.sourceUrl,
          committeeIds: due.rows.map((row) => row.controlledCommitteeId),
          campaignCoverRows: resolutionData.campaignCoverRows,
        })
      : input.rawDataReceiptData;
  const loadOutsideReceiptRowsForCommittees = resolutionData
    ? createCalAccessReceiptRowsForCommitteesCache({
        initialData: receiptData,
        load: (committeeIds: readonly string[]) =>
          loadCalAccessReceiptRowsForCommittees({
            zipPath: input.rawDataZipPath ?? resolutionData.zipPath,
            cacheDir: input.rawDataCacheDir,
            sourceUrl: resolutionData.sourceUrl,
            committeeIds,
            campaignCoverRows: resolutionData.campaignCoverRows,
          }),
      })
    : undefined;

  const results: CaliforniaCandidateFinanceBatchSyncItemResult[] = [];
  for (const row of due.rows) {
    const committeeKey = normalizeCommitteeId(row.controlledCommitteeId);
    try {
      const result = await syncFn({
        db: input.db,
        candidateId: row.candidateId,
        electionId: row.electionId,
        candidateName: row.candidateName,
        electionYear: row.electionYear,
        officeName: row.officeName,
        controlledCommitteeId: row.controlledCommitteeId,
        controlledCommitteeName: row.controlledCommitteeName,
        sourceUrl: row.sourceUrl,
        dryRun,
        includeOutside,
        powerSearchOptions: input.powerSearchOptions,
        powerSearchClient: input.powerSearchClient,
        directReceiptRows: receiptData?.receiptRowsByCommitteeId.get(committeeKey),
        controlledCommitteeFilingIds: receiptData?.controlledCommitteeFilingIdsByCommitteeId.get(committeeKey),
        directSourceUrl: receiptData?.sourceUrl ?? resolutionData?.sourceUrl,
        loadOutsideReceiptRowsForCommittees,
        financeIndustryClassifier: input.financeIndustryClassifier,
        aiClassificationMinAmount: input.aiClassificationMinAmount,
        now,
      });
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        controlledCommitteeId: row.controlledCommitteeId,
        ok: true,
        result,
      });
    } catch (error) {
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        controlledCommitteeId: row.controlledCommitteeId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const syncedCandidateCount = results.filter((result) => result.ok).length;
  return {
    reportedCommittees,
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
  };
}
