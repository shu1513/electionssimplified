import { isColoradoCampaignFinanceSyncEnabled, isColoradoReportedIeEnabled, isColoradoNativeReceiptsEnabled } from "../../config/featureFlags.js";
import { syncDueColoradoReportedIe } from "./coloradoReportedIeBatchSync.js";
import { syncDueColoradoNativeReceipts } from "./coloradoNativeReceiptBatchSync.js";
import { stat } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";

import { mergeCycleArtifactRows } from "../finance/cycleArtifactRows.js";
import {
  DEFAULT_COLORADO_TRACER_CONTRIBUTION_CACHE_DIR,
  buildColoradoTracerContributionZipUrl,
  getColoradoTracerContributionArtifactCachePaths,
  readColoradoTracerContributionArtifactCacheMetadata
} from "./coloradoTracerContributionArtifactCache.js";
import {
  readColoradoTracerContributionRows,
  type ColoradoTracerContributionRow
} from "./coloradoTracerContributionReader.js";
import {
  syncColoradoCandidateFinance,
  type ColoradoCandidateFinanceSyncResult
} from "./coloradoCandidateFinanceSync.js";
import {
  autoLinkMissingColoradoCandidateFinanceLinks,
  buildColoradoCandidateNamePredicate,
  listColoradoCandidateElectionsMissingFinanceLinks,
  type ColoradoFinanceAutoLinkCandidateElection
} from "./coloradoCandidateFinanceAutoLink.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type ColoradoCandidateFinanceDueRow = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeName: string;
  committeeId: string;
  committeeName: string;
  tracerCandidateId: string | null;
  sourceUrl: string | null;
  lastSyncedAt: string | null;
};

export type ColoradoContributionDataForYear = {
  year: number;
  zipPath: string;
  sourceUrl: string;
  rowsByCommitteeId: Map<string, ColoradoTracerContributionRow[]>;
};

export type ColoradoCandidateFinanceBatchSyncInput = {
  db: Queryable & Partial<Pick<Pool, "connect">>;
  ieOnly?: boolean;
  ieCacheDir?: string;
  ieLinkId?: string;
  refreshIe?: boolean;
  receiptsOnly?: boolean;
  receiptsCacheDir?: string;
  receiptsLinkId?: string;
  refreshReceipts?: boolean;
  now?: Date;
  dryRun?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  rawDataZipPath?: string;
  rawDataCacheDir?: string;
  autoLinkMissingLinks?: boolean;
  contributionDataByYear?: ReadonlyMap<number, ColoradoContributionDataForYear>;
  syncColoradoCandidateFinanceFn?: typeof syncColoradoCandidateFinance;
};

export type ColoradoCandidateFinanceBatchSyncItemResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  committeeId: string;
  ok: boolean;
  result?: ColoradoCandidateFinanceSyncResult;
  error?: string;
};

export type ColoradoCandidateFinanceBatchSyncResult = {
  reportedIe?: Awaited<ReturnType<typeof syncDueColoradoReportedIe>>;
  /** Set when the reported IE component failed in an ordinary run; the direct sync still ran. */
  reportedIeError?: string;
  nativeReceipts?: Awaited<ReturnType<typeof syncDueColoradoNativeReceipts>>;
  /** Set when the native receipt component failed in an ordinary run; the direct sync still ran. */
  nativeReceiptsError?: string;
  dryRun: boolean;
  now: string;
  staleAfterDays: number;
  maxCandidates: number;
  dueCandidateCount: number;
  selectedCandidateCount: number;
  syncedCandidateCount: number;
  failedCandidateCount: number;
  results: ColoradoCandidateFinanceBatchSyncItemResult[];
};

type ColoradoCandidateFinanceDueQueryRow = {
  candidate_id: string;
  election_id: string;
  candidate_name: string;
  election_year: number;
  office_name: string;
  committee_id: string;
  committee_name: string;
  tracer_candidate_id: string | null;
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
    throw new Error(`Invalid Colorado finance batch sync ${label}`);
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Colorado finance batch sync ${label}: ${value}`);
  }
  return normalized;
}

function normalizeCommitteeId(value: string): string {
  return value.trim().toUpperCase();
}

function parseTotalDueRows(value: string | number | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function mapDueRow(row: ColoradoCandidateFinanceDueQueryRow): ColoradoCandidateFinanceDueRow {
  return {
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    officeName: row.office_name,
    committeeId: row.committee_id,
    committeeName: row.committee_name,
    tracerCandidateId: row.tracer_candidate_id,
    sourceUrl: row.source_url,
    lastSyncedAt: row.last_synced_at
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const fileStat = await stat(path);
    return fileStat.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function groupDueRowsByYear(
  rows: readonly ColoradoCandidateFinanceDueRow[]
): Map<number, ColoradoCandidateFinanceDueRow[]> {
  const byYear = new Map<number, ColoradoCandidateFinanceDueRow[]>();
  for (const row of rows) {
    const yearRows = byYear.get(row.electionYear) ?? [];
    yearRows.push(row);
    byYear.set(row.electionYear, yearRows);
  }
  return byYear;
}

function groupAutoLinkCandidatesByYear(
  rows: readonly ColoradoFinanceAutoLinkCandidateElection[]
): Map<number, ColoradoFinanceAutoLinkCandidateElection[]> {
  const byYear = new Map<number, ColoradoFinanceAutoLinkCandidateElection[]>();
  for (const row of rows) {
    const yearRows = byYear.get(row.electionYear) ?? [];
    yearRows.push(row);
    byYear.set(row.electionYear, yearRows);
  }
  return byYear;
}

function groupContributionRowsByCommittee(
  rows: readonly ColoradoTracerContributionRow[]
): Map<string, ColoradoTracerContributionRow[]> {
  const byCommittee = new Map<string, ColoradoTracerContributionRow[]>();
  for (const row of rows) {
    const committeeId = normalizeCommitteeId(row.CO_ID);
    if (!committeeId) {
      continue;
    }
    const existing = byCommittee.get(committeeId) ?? [];
    existing.push(row);
    byCommittee.set(committeeId, existing);
  }
  return byCommittee;
}

function coloradoCycleFilingYears(electionYear: number, rawDataZipPath?: string): number[] {
  return rawDataZipPath ? [electionYear] : [electionYear - 1, electionYear];
}

function coloradoContributionRowIdentity(row: ColoradoTracerContributionRow): string {
  const recordId = row.RecordID.trim().toUpperCase();
  return recordId ? `${normalizeCommitteeId(row.CO_ID)}\u0000${recordId}` : "";
}

async function readCycleContributionRows(input: {
  electionYear: number;
  rawDataZipPath?: string;
  rawDataCacheDir?: string;
  predicate: (row: ColoradoTracerContributionRow) => boolean;
}): Promise<{
  rows: ColoradoTracerContributionRow[];
  zipPath: string;
  sourceUrl: string;
}> {
  const cacheDir =
    input.rawDataCacheDir ??
    (process.env.COLORADO_TRACER_CONTRIBUTION_CACHE_DIR?.trim() || DEFAULT_COLORADO_TRACER_CONTRIBUTION_CACHE_DIR);
  const artifactRowsByYear: ColoradoTracerContributionRow[][] = [];
  let zipPath = "";
  let sourceUrl = "";
  let foundMatchingRows = false;
  for (const filingYear of coloradoCycleFilingYears(input.electionYear, input.rawDataZipPath)) {
    const paths = getColoradoTracerContributionArtifactCachePaths({
      cacheDir,
      year: filingYear
    });
    const artifactZipPath = input.rawDataZipPath ?? paths.zipPath;
    if (!(await fileExists(artifactZipPath))) {
      throw new Error(`Colorado TRACER contribution ZIP not found for ${filingYear}: ${artifactZipPath}`);
    }
    const metadata = input.rawDataZipPath
      ? null
      : await readColoradoTracerContributionArtifactCacheMetadata(paths.metadataPath);
    const artifactRows = await readColoradoTracerContributionRows({
      zipPath: artifactZipPath,
      year: filingYear,
      predicate: input.predicate
    });
    artifactRowsByYear.push(artifactRows);
    if (!foundMatchingRows) {
      zipPath = artifactZipPath;
      sourceUrl = metadata?.remote.url ?? buildColoradoTracerContributionZipUrl({ year: filingYear });
      foundMatchingRows = artifactRows.length > 0;
    }
  }
  return {
    rows: mergeCycleArtifactRows({
      artifacts: artifactRowsByYear,
      rowIdentity: coloradoContributionRowIdentity
    }),
    zipPath,
    sourceUrl
  };
}

async function loadContributionDataForYear(input: {
  year: number;
  committeeIds: readonly string[];
  rawDataZipPath?: string;
  rawDataCacheDir?: string;
}): Promise<ColoradoContributionDataForYear> {
  const normalizedCommitteeIds = new Set(input.committeeIds.map(normalizeCommitteeId).filter(Boolean));
  const data = await readCycleContributionRows({
    electionYear: input.year,
    rawDataZipPath: input.rawDataZipPath,
    rawDataCacheDir: input.rawDataCacheDir,
    predicate: (row) => normalizedCommitteeIds.has(normalizeCommitteeId(row.CO_ID))
  });

  return {
    year: input.year,
    zipPath: data.zipPath,
    sourceUrl: data.sourceUrl,
    rowsByCommitteeId: groupContributionRowsByCommittee(data.rows)
  };
}

async function loadAutoLinkContributionRowsForYear(input: {
  year: number;
  candidates: readonly ColoradoFinanceAutoLinkCandidateElection[];
  rawDataZipPath?: string;
  rawDataCacheDir?: string;
}): Promise<{ rows: ColoradoTracerContributionRow[]; sourceUrl: string }> {
  const data = await readCycleContributionRows({
    electionYear: input.year,
    rawDataZipPath: input.rawDataZipPath,
    rawDataCacheDir: input.rawDataCacheDir,
    predicate: buildColoradoCandidateNamePredicate(input.candidates)
  });
  return { rows: data.rows, sourceUrl: data.sourceUrl };
}

export async function listDueColoradoCandidateFinanceSyncRows(
  db: Queryable,
  input: {
    now: Date;
    staleAfterDays: number;
    maxCandidates: number;
    electionLookbackDays: number;
    electionLookaheadDays: number;
  }
): Promise<{ rows: ColoradoCandidateFinanceDueRow[]; totalDueRows: number }> {
  const result = await db.query<ColoradoCandidateFinanceDueQueryRow>(
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
          link.committee_id,
          link.committee_name,
          link.tracer_candidate_id,
          link.source_url,
          summary.last_synced_at::text AS last_synced_at,
          COUNT(*) OVER () AS total_due_rows
        FROM public.co_candidate_finance_links AS link
        JOIN public.candidates AS candidate
          ON candidate.id = link.candidate_id
        JOIN public.candidate_elections AS candidate_election
          ON candidate_election.candidate_id = link.candidate_id
         AND candidate_election.election_id = link.election_id
        JOIN public.elections AS election
          ON election.id = link.election_id
        JOIN public.districts AS district
          ON district.id = election.district_id
        LEFT JOIN public.co_candidate_finance_summaries AS summary
          ON summary.link_id = link.id
         AND summary.election_year = link.election_year
        WHERE link.link_status = 'active'
          AND candidate.deleted_at IS NULL
          AND district.state = 'CO'
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
        committee_id,
        committee_name,
        tracer_candidate_id,
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
      input.electionLookaheadDays
    ]
  );

  return {
    rows: result.rows.map(mapDueRow),
    totalDueRows: result.rows.length > 0 ? parseTotalDueRows(result.rows[0]?.total_due_rows) : 0
  };
}

export async function syncDueColoradoCandidateFinance(
  input: ColoradoCandidateFinanceBatchSyncInput
): Promise<ColoradoCandidateFinanceBatchSyncResult> {
  const now = input.now ?? new Date();
  assertValidDate(now, "now");
  if (input.ieOnly && input.receiptsOnly) throw new Error("Select only one Colorado finance component");

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
  const syncFn = input.syncColoradoCandidateFinanceFn ?? syncColoradoCandidateFinance;

  // IE acquisition runs before legacy file discovery and direct freshness.
  // Each component is fault-isolated from the legacy direct sync: the
  // component keeps its own tables, clocks and retry state, so a failure
  // outside its per-receiver handling (receiver listing, source/attempt
  // queries, option validation, a non-pool caller) is recorded on the batch
  // result and the direct sync still runs. Component-only runs rethrow so
  // the CLI exits non-zero.
  let reportedIe: Awaited<ReturnType<typeof syncDueColoradoReportedIe>> | undefined;
  let reportedIeError: string | undefined;
  if (!input.receiptsOnly && isColoradoReportedIeEnabled() && isColoradoCampaignFinanceSyncEnabled()) {
    try {
      if (!input.db.connect) throw new Error("Colorado IE sync requires a pool");
      reportedIe = await syncDueColoradoReportedIe({
        db: {
          query: input.db.query.bind(input.db),
          connect: input.db.connect.bind(input.db)
        },
        now,
        maxCandidates,
        staleAfterDays,
        electionLookbackDays: input.electionLookbackDays,
        electionLookaheadDays,
        dryRun,
        cacheDir: input.ieCacheDir,
        linkId: input.ieLinkId,
        refresh: input.refreshIe
      });
    } catch (error) {
      if (input.ieOnly) throw error;
      reportedIeError = error instanceof Error ? error.message : String(error);
      console.warn("Colorado reported IE sync skipped; continuing with direct sync:", reportedIeError);
    }
  }
  let nativeReceipts: Awaited<ReturnType<typeof syncDueColoradoNativeReceipts>> | undefined;
  let nativeReceiptsError: string | undefined;
  if (!input.ieOnly && isColoradoNativeReceiptsEnabled() && isColoradoCampaignFinanceSyncEnabled()) {
    try {
      if (!input.db.connect) throw new Error("Colorado native receipt sync requires a pool");
      nativeReceipts = await syncDueColoradoNativeReceipts({
        db: { query: input.db.query.bind(input.db), connect: input.db.connect.bind(input.db) },
        now,
        maxCandidates,
        staleAfterDays,
        electionLookbackDays: input.electionLookbackDays,
        electionLookaheadDays,
        dryRun,
        cacheDir: input.receiptsCacheDir,
        linkId: input.receiptsLinkId,
        refresh: input.refreshReceipts
      });
    } catch (error) {
      if (input.receiptsOnly) throw error;
      nativeReceiptsError = error instanceof Error ? error.message : String(error);
      console.warn("Colorado native receipt sync skipped; continuing with direct sync:", nativeReceiptsError);
    }
  }
  const componentResults = {
    ...(reportedIe ? { reportedIe } : {}),
    ...(reportedIeError ? { reportedIeError } : {}),
    ...(nativeReceipts ? { nativeReceipts } : {}),
    ...(nativeReceiptsError ? { nativeReceiptsError } : {})
  };
  if (input.ieOnly || input.receiptsOnly)
    return {
      dryRun,
      now: now.toISOString(),
      staleAfterDays,
      maxCandidates,
      dueCandidateCount: 0,
      selectedCandidateCount: 0,
      syncedCandidateCount: 0,
      failedCandidateCount: 0,
      results: [],
      ...componentResults
    };

  if (input.autoLinkMissingLinks !== false) {
    try {
      const missingLinkCandidates = await listColoradoCandidateElectionsMissingFinanceLinks(input.db, {
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays
      });
      const contributionRowsByYear = new Map<number, ColoradoTracerContributionRow[]>();
      const sourceUrlByYear = new Map<number, string>();
      for (const [year, candidates] of groupAutoLinkCandidatesByYear(missingLinkCandidates).entries()) {
        const data = await loadAutoLinkContributionRowsForYear({
          year,
          candidates,
          rawDataZipPath: input.rawDataZipPath,
          rawDataCacheDir: input.rawDataCacheDir
        });
        contributionRowsByYear.set(year, data.rows);
        sourceUrlByYear.set(year, data.sourceUrl);
      }
      const autoLinkResults = await autoLinkMissingColoradoCandidateFinanceLinks({
        db: input.db,
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
        contributionRowsByYear,
        sourceUrlByYear,
        candidateElections: missingLinkCandidates
      });
      for (const result of autoLinkResults) {
        if (result.status !== "linked") {
          console.warn("Colorado finance auto-link did not link candidate election:", result);
        }
      }
    } catch (error) {
      console.warn(
        "Colorado finance auto-link skipped; continuing with already-linked candidate sync:",
        error instanceof Error ? error.message : error
      );
    }
  }

  const due = await listDueColoradoCandidateFinanceSyncRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays
  });
  const contributionDataByYear = new Map<number, ColoradoContributionDataForYear>(
    input.contributionDataByYear ? [...input.contributionDataByYear.entries()] : []
  );
  for (const [year, rows] of groupDueRowsByYear(due.rows).entries()) {
    if (!contributionDataByYear.has(year)) {
      contributionDataByYear.set(
        year,
        await loadContributionDataForYear({
          year,
          committeeIds: rows.map((row) => row.committeeId),
          rawDataZipPath: input.rawDataZipPath,
          rawDataCacheDir: input.rawDataCacheDir
        })
      );
    }
  }

  const results: ColoradoCandidateFinanceBatchSyncItemResult[] = [];
  for (const row of due.rows) {
    const contributionData = contributionDataByYear.get(row.electionYear);
    const committeeKey = normalizeCommitteeId(row.committeeId);
    try {
      const result = await syncFn({
        db: input.db,
        candidateId: row.candidateId,
        electionId: row.electionId,
        candidateName: row.candidateName,
        electionYear: row.electionYear,
        officeName: row.officeName,
        committeeId: row.committeeId,
        committeeName: row.committeeName,
        tracerCandidateId: row.tracerCandidateId,
        sourceUrl: row.sourceUrl,
        dryRun,
        contributionRows: contributionData?.rowsByCommitteeId.get(committeeKey) ?? [],
        contributionSourceUrl: contributionData?.sourceUrl,
        now
      });
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        committeeId: row.committeeId,
        ok: true,
        result
      });
    } catch (error) {
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        committeeId: row.committeeId,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
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
    ...componentResults,
    syncedCandidateCount,
    failedCandidateCount: results.length - syncedCandidateCount,
    results
  };
}
