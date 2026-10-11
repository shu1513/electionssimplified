import { stat } from "node:fs/promises";
import type { ConnecticutFinanceCommitteeRegistryEntry } from "./connecticutDirectContributionAggregator.js";
import type { Pool, PoolClient } from "pg";

import {
  DEFAULT_CONNECTICUT_ECRIS_CACHE_DIR,
  buildConnecticutEcrisArtifactUrl,
  getConnecticutEcrisArtifactCachePaths,
  readConnecticutEcrisArtifactCacheMetadata,
} from "./connecticutEcrisArtifactCache.js";
import {
  readConnecticutEcrisArtifactRows,
  type ConnecticutEcrisArtifactRow,
} from "./connecticutEcrisArtifactReader.js";
import {
  getConnecticutEcrisIndependentExpenditureCachePath,
  readConnecticutEcrisIndependentExpenditureCache,
} from "./connecticutEcrisIndependentExpenditureCache.js";
import type { ConnecticutEcrisIndependentExpenditureRow } from "./connecticutEcrisIndependentExpenditureParsers.js";
import {
  connecticutOutsideSpendingIdentityKey,
  findConnecticutAmbiguousOutsideSpendingIdentities,
} from "./connecticutOutsideSpendingAggregator.js";
import {
  syncConnecticutCandidateFinance,
  type ConnecticutCandidateFinanceSyncResult,
} from "./connecticutCandidateFinanceSync.js";
import {
  autoLinkMissingConnecticutCandidateFinanceLinks,
  buildConnecticutCandidateNamePredicate,
  listConnecticutCandidateElectionsMissingFinanceLinks,
  type ConnecticutFinanceAutoLinkCandidateElection,
} from "./connecticutCandidateFinanceAutoLink.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type ConnecticutCandidateFinanceDueRow = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeName: string;
  district: string | null;
  committeeId: string;
  committeeName: string;
  sourceUrl: string | null;
  lastSyncedAt: string | null;
};

export type ConnecticutEcrisReceiptDataForYear = {
  year: number;
  filePath: string;
  sourceUrl: string;
  rowsByCommitteeId: Map<string, ConnecticutEcrisArtifactRow[]>;
  committeeRegistry?: readonly ConnecticutFinanceCommitteeRegistryEntry[];
};

export type ConnecticutEcrisIndependentExpenditureDataForYear = {
  year: number;
  filePath: string;
  sourceUrl: string;
  rows: readonly ConnecticutEcrisIndependentExpenditureRow[];
};

export type ConnecticutCandidateFinanceBatchSyncInput = {
  db: Queryable;
  now?: Date;
  dryRun?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  rawDataCacheDir?: string;
  receiptDataByYear?: ReadonlyMap<number, ConnecticutEcrisReceiptDataForYear>;
  independentExpenditureDataByYear?: ReadonlyMap<number, ConnecticutEcrisIndependentExpenditureDataForYear>;
  autoLinkMissingLinks?: boolean;
  syncConnecticutCandidateFinanceFn?: typeof syncConnecticutCandidateFinance;
};

export type ConnecticutCandidateFinanceBatchSyncItemResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  committeeId: string;
  ok: boolean;
  result?: ConnecticutCandidateFinanceSyncResult;
  error?: string;
};

export type ConnecticutCandidateFinanceBatchSyncResult = {
  dryRun: boolean;
  now: string;
  staleAfterDays: number;
  maxCandidates: number;
  dueCandidateCount: number;
  selectedCandidateCount: number;
  syncedCandidateCount: number;
  failedCandidateCount: number;
  results: ConnecticutCandidateFinanceBatchSyncItemResult[];
};

type ConnecticutCandidateFinanceDueQueryRow = {
  candidate_id: string;
  election_id: string;
  candidate_name: string;
  election_year: number;
  office_name: string;
  district: string | null;
  committee_id: string;
  committee_name: string;
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
    throw new Error(`Invalid Connecticut finance batch sync ${label}`);
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Connecticut finance batch sync ${label}: ${value}`);
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

function mapDueRow(row: ConnecticutCandidateFinanceDueQueryRow): ConnecticutCandidateFinanceDueRow {
  return {
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    officeName: row.office_name,
    district: row.district,
    committeeId: row.committee_id,
    committeeName: row.committee_name,
    sourceUrl: row.source_url,
    lastSyncedAt: row.last_synced_at,
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
  rows: readonly ConnecticutCandidateFinanceDueRow[]
): Map<number, ConnecticutCandidateFinanceDueRow[]> {
  const byYear = new Map<number, ConnecticutCandidateFinanceDueRow[]>();
  for (const row of rows) {
    const yearRows = byYear.get(row.electionYear) ?? [];
    yearRows.push(row);
    byYear.set(row.electionYear, yearRows);
  }
  return byYear;
}

function groupAutoLinkCandidatesByYear(
  rows: readonly ConnecticutFinanceAutoLinkCandidateElection[]
): Map<number, ConnecticutFinanceAutoLinkCandidateElection[]> {
  const byYear = new Map<number, ConnecticutFinanceAutoLinkCandidateElection[]>();
  for (const row of rows) {
    const yearRows = byYear.get(row.electionYear) ?? [];
    yearRows.push(row);
    byYear.set(row.electionYear, yearRows);
  }
  return byYear;
}

function groupReceiptRowsByCommittee(
  rows: readonly ConnecticutEcrisArtifactRow[]
): Map<string, ConnecticutEcrisArtifactRow[]> {
  const byCommittee = new Map<string, ConnecticutEcrisArtifactRow[]>();
  for (const row of rows) {
    const committeeId = normalizeCommitteeId(row["Committee ID"] ?? "");
    if (!committeeId) {
      continue;
    }
    const existing = byCommittee.get(committeeId) ?? [];
    existing.push(row);
    byCommittee.set(committeeId, existing);
  }
  return byCommittee;
}

async function loadReceiptDataForYear(input: {
  year: number;
  committeeIds: readonly string[];
  rawDataCacheDir?: string;
}): Promise<ConnecticutEcrisReceiptDataForYear> {
  const normalizedCommitteeIds = new Set(input.committeeIds.map(normalizeCommitteeId).filter(Boolean));
  const paths = getConnecticutEcrisArtifactCachePaths({
    cacheDir:
      input.rawDataCacheDir ??
      (process.env.CONNECTICUT_ECRIS_CACHE_DIR?.trim() || DEFAULT_CONNECTICUT_ECRIS_CACHE_DIR),
    year: input.year,
    transactionType: "receipts",
    committeeType: "candidate_exploratory",
    period: "election",
    format: "csv",
  });
  if (!(await fileExists(paths.filePath))) {
    throw new Error(`Connecticut eCRIS candidate receipt artifact not found for ${input.year}: ${paths.filePath}`);
  }

  const metadata = await readConnecticutEcrisArtifactCacheMetadata(paths.metadataPath);
  const registry = new Map<string, ConnecticutFinanceCommitteeRegistryEntry>();
  const rows = await readConnecticutEcrisArtifactRows({
    filePath: paths.filePath,
    format: metadata?.artifact.format ?? "csv",
    predicate: (row) => {
      // Collect registry evidence from the whole export before filtering to
      // due recipients; an exploratory donor need not itself have a due link.
      const committeeId = normalizeCommitteeId(row["Committee ID"] ?? "");
      const committeeName = row["Committee"]?.trim() ?? "";
      const committeeType = row["Committee Type"]?.trim() ?? "";
      if (committeeId && committeeName && committeeType) {
        registry.set(JSON.stringify([committeeId, committeeName, committeeType]), { committeeId, committeeName, committeeType });
      }
      return normalizedCommitteeIds.has(committeeId);
    },
  });

  return {
    year: input.year,
    filePath: paths.filePath,
    sourceUrl:
      metadata?.remote.url ??
      buildConnecticutEcrisArtifactUrl({
        year: input.year,
        transactionType: "receipts",
        committeeType: "candidate_exploratory",
        period: "election",
        format: "csv",
      }),
    rowsByCommitteeId: groupReceiptRowsByCommittee(rows),
    committeeRegistry: [...registry.values()],
  };
}

function resolveRawDataCacheDir(rawDataCacheDir: string | undefined): string {
  return rawDataCacheDir ?? (process.env.CONNECTICUT_ECRIS_CACHE_DIR?.trim() || DEFAULT_CONNECTICUT_ECRIS_CACHE_DIR);
}

/**
 * The year's cached independent-expenditure artifact, or null when none has
 * been refreshed yet. A missing artifact is not an error: direct receipts
 * still sync and stored outside-spending data is left untouched.
 */
async function loadIndependentExpenditureDataForYear(input: {
  year: number;
  rawDataCacheDir?: string;
}): Promise<ConnecticutEcrisIndependentExpenditureDataForYear | null> {
  const cacheDir = resolveRawDataCacheDir(input.rawDataCacheDir);
  const artifact = await readConnecticutEcrisIndependentExpenditureCache({ cacheDir, year: input.year });
  if (!artifact) {
    return null;
  }
  return {
    year: input.year,
    filePath: getConnecticutEcrisIndependentExpenditureCachePath({ cacheDir, year: input.year }),
    sourceUrl: artifact.sourceUrl,
    rows: artifact.rows,
  };
}

type ConnecticutRosterIdentityRow = {
  election_year: number;
  candidate_name: string;
  office_name: string;
};

/**
 * Per election year, the outside-spending identities (office + name) that
 * two or more Connecticut candidates share. Every candidate of the year is
 * considered, whatever their link or status: a namesake who lost a primary
 * is still a valid eCRIS target and would otherwise receive this candidate's
 * spending.
 */
async function listAmbiguousOutsideSpendingIdentitiesByYear(
  db: Queryable,
  years: readonly number[]
): Promise<Map<number, Set<string>>> {
  const result = await db.query<ConnecticutRosterIdentityRow>(
    `
      SELECT
        date_part('year', election.election_date)::int AS election_year,
        COALESCE(
          NULLIF(trim(candidate.display_name), ''),
          NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')
        ) AS candidate_name,
        office.canonical_name AS office_name
      FROM public.candidate_elections AS candidate_election
      JOIN public.candidates AS candidate
        ON candidate.id = candidate_election.candidate_id
      JOIN public.elections AS election
        ON election.id = candidate_election.election_id
      JOIN public.districts AS district
        ON district.id = election.district_id
      JOIN public.offices AS office
        ON office.id = election.office_id
      WHERE district.state = 'CT'
        AND election.race_type = 'office'
        AND candidate.deleted_at IS NULL
        AND date_part('year', election.election_date)::int = ANY($1::int[])
    `,
    [years]
  );
  const rowsByYear = new Map<number, ConnecticutRosterIdentityRow[]>();
  for (const row of result.rows) {
    if (!row.candidate_name || !row.office_name) continue;
    const rows = rowsByYear.get(row.election_year) ?? [];
    rows.push(row);
    rowsByYear.set(row.election_year, rows);
  }
  return new Map(
    [...rowsByYear.entries()].map(([year, rows]) => [
      year,
      findConnecticutAmbiguousOutsideSpendingIdentities(
        rows.map((row) => ({ officeName: row.office_name, candidateName: row.candidate_name }))
      ),
    ])
  );
}

async function loadAutoLinkReceiptRowsForYear(input: {
  year: number;
  candidates: readonly ConnecticutFinanceAutoLinkCandidateElection[];
  rawDataCacheDir?: string;
  receiptDataByYear?: ReadonlyMap<number, ConnecticutEcrisReceiptDataForYear>;
}): Promise<{ rows: ConnecticutEcrisArtifactRow[]; sourceUrl: string }> {
  const injected = input.receiptDataByYear?.get(input.year);
  if (injected) {
    return {
      rows: [...injected.rowsByCommitteeId.values()].flat(),
      sourceUrl: injected.sourceUrl,
    };
  }

  const paths = getConnecticutEcrisArtifactCachePaths({
    cacheDir:
      input.rawDataCacheDir ??
      (process.env.CONNECTICUT_ECRIS_CACHE_DIR?.trim() || DEFAULT_CONNECTICUT_ECRIS_CACHE_DIR),
    year: input.year,
    transactionType: "receipts",
    committeeType: "candidate_exploratory",
    period: "election",
    format: "csv",
  });
  if (!(await fileExists(paths.filePath))) {
    throw new Error(`Connecticut eCRIS candidate receipt artifact not found for ${input.year}: ${paths.filePath}`);
  }

  const metadata = await readConnecticutEcrisArtifactCacheMetadata(paths.metadataPath);
  return {
    rows: await readConnecticutEcrisArtifactRows({
      filePath: paths.filePath,
      format: metadata?.artifact.format ?? "csv",
      predicate: buildConnecticutCandidateNamePredicate(input.candidates),
    }),
    sourceUrl:
      metadata?.remote.url ??
      buildConnecticutEcrisArtifactUrl({
        year: input.year,
        transactionType: "receipts",
        committeeType: "candidate_exploratory",
        period: "election",
        format: "csv",
      }),
  };
}

export async function listDueConnecticutCandidateFinanceSyncRows(
  db: Queryable,
  input: {
    now: Date;
    staleAfterDays: number;
    maxCandidates: number;
    electionLookbackDays: number;
    electionLookaheadDays: number;
  }
): Promise<{ rows: ConnecticutCandidateFinanceDueRow[]; totalDueRows: number }> {
  const result = await db.query<ConnecticutCandidateFinanceDueQueryRow>(
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
          link.district,
          link.committee_id,
          link.committee_name,
          link.source_url,
          summary.last_synced_at::text AS last_synced_at,
          COUNT(*) OVER () AS total_due_rows
        FROM public.ct_candidate_finance_links AS link
        JOIN public.candidates AS candidate
          ON candidate.id = link.candidate_id
        JOIN public.candidate_elections AS candidate_election
          ON candidate_election.candidate_id = link.candidate_id
         AND candidate_election.election_id = link.election_id
        JOIN public.elections AS election
          ON election.id = link.election_id
        JOIN public.districts AS district
          ON district.id = election.district_id
        LEFT JOIN public.ct_candidate_finance_summaries AS summary
          ON summary.link_id = link.id
         AND summary.election_year = link.election_year
        WHERE link.link_status = 'active'
          AND candidate.deleted_at IS NULL
          AND district.state = 'CT'
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
        district,
        committee_id,
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
    ]
  );

  return {
    rows: result.rows.map(mapDueRow),
    totalDueRows: result.rows.length > 0 ? parseTotalDueRows(result.rows[0]?.total_due_rows) : 0,
  };
}

export async function syncDueConnecticutCandidateFinance(
  input: ConnecticutCandidateFinanceBatchSyncInput
): Promise<ConnecticutCandidateFinanceBatchSyncResult> {
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
  const syncFn = input.syncConnecticutCandidateFinanceFn ?? syncConnecticutCandidateFinance;

  if (!dryRun && input.autoLinkMissingLinks !== false) {
    try {
      const missingLinkCandidates = await listConnecticutCandidateElectionsMissingFinanceLinks(input.db, {
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
      });
      const receiptRowsByYear = new Map<number, readonly ConnecticutEcrisArtifactRow[]>();
      const sourceUrlByYear = new Map<number, string>();
      for (const [year, candidates] of groupAutoLinkCandidatesByYear(missingLinkCandidates).entries()) {
        const data = await loadAutoLinkReceiptRowsForYear({
          year,
          candidates,
          rawDataCacheDir: input.rawDataCacheDir,
          receiptDataByYear: input.receiptDataByYear,
        });
        receiptRowsByYear.set(year, data.rows);
        sourceUrlByYear.set(year, data.sourceUrl);
      }
      const autoLinkResults = await autoLinkMissingConnecticutCandidateFinanceLinks({
        db: input.db,
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
        receiptRowsByYear,
        sourceUrlByYear,
        candidateElections: missingLinkCandidates,
      });
      for (const result of autoLinkResults) {
        if (result.status !== "linked") {
          console.warn("Connecticut finance auto-link did not link candidate election:", result);
        }
      }
    } catch (error) {
      console.warn(
        "Connecticut finance auto-link skipped; continuing with already-linked candidate sync:",
        error instanceof Error ? error.message : error
      );
    }
  }

  const due = await listDueConnecticutCandidateFinanceSyncRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
  });
  const receiptDataByYear = new Map<number, ConnecticutEcrisReceiptDataForYear>(
    input.receiptDataByYear ? [...input.receiptDataByYear.entries()] : []
  );
  const receiptDataLoadErrorsByYear = new Map<number, string>();
  const independentExpenditureDataByYear = new Map<number, ConnecticutEcrisIndependentExpenditureDataForYear>(
    input.independentExpenditureDataByYear ? [...input.independentExpenditureDataByYear.entries()] : []
  );
  for (const [year, rows] of groupDueRowsByYear(due.rows).entries()) {
    if (!receiptDataByYear.has(year)) {
      try {
        receiptDataByYear.set(
          year,
          await loadReceiptDataForYear({
            year,
            committeeIds: rows.map((row) => row.committeeId),
            rawDataCacheDir: input.rawDataCacheDir,
          })
        );
      } catch (error) {
        receiptDataLoadErrorsByYear.set(year, error instanceof Error ? error.message : String(error));
      }
    }
    if (!independentExpenditureDataByYear.has(year)) {
      try {
        const data = await loadIndependentExpenditureDataForYear({ year, rawDataCacheDir: input.rawDataCacheDir });
        if (data) {
          independentExpenditureDataByYear.set(year, data);
        } else {
          console.warn(
            `Connecticut eCRIS independent expenditure artifact not found for ${year}; outside spending left untouched`
          );
        }
      } catch (error) {
        console.warn(
          `Connecticut eCRIS independent expenditure artifact unreadable for ${year}; outside spending left untouched:`,
          error instanceof Error ? error.message : error
        );
      }
    }
  }

  const ambiguousIdentitiesByYear =
    independentExpenditureDataByYear.size > 0
      ? await listAmbiguousOutsideSpendingIdentitiesByYear(input.db, [...independentExpenditureDataByYear.keys()])
      : new Map<number, Set<string>>();

  const results: ConnecticutCandidateFinanceBatchSyncItemResult[] = [];
  for (const row of due.rows) {
    const receiptDataLoadError = receiptDataLoadErrorsByYear.get(row.electionYear);
    if (receiptDataLoadError) {
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        committeeId: row.committeeId,
        ok: false,
        error: receiptDataLoadError,
      });
      continue;
    }

    const receiptData = receiptDataByYear.get(row.electionYear);
    let independentExpenditureData = independentExpenditureDataByYear.get(row.electionYear);
    if (
      independentExpenditureData &&
      ambiguousIdentitiesByYear
        .get(row.electionYear)
        ?.has(connecticutOutsideSpendingIdentityKey({ officeName: row.officeName, candidateName: row.candidateName }))
    ) {
      console.warn(
        `Connecticut outside spending skipped for ${row.candidateName} (${row.officeName}, ${row.electionYear}): ` +
          `another ${row.electionYear} candidate for that office shares the name and eCRIS names no district`
      );
      independentExpenditureData = undefined;
    }
    const committeeKey = normalizeCommitteeId(row.committeeId);
    try {
      const result = await syncFn({
        db: input.db,
        candidateId: row.candidateId,
        electionId: row.electionId,
        candidateName: row.candidateName,
        electionYear: row.electionYear,
        officeName: row.officeName,
        district: row.district,
        sourceUrl: row.sourceUrl,
        receiptRows: receiptData?.rowsByCommitteeId.get(committeeKey) ?? [],
        receiptSourceUrl: receiptData?.sourceUrl,
        committeeRegistry: receiptData?.committeeRegistry,
        independentExpenditureRows: independentExpenditureData?.rows,
        independentExpenditureSourceUrl: independentExpenditureData?.sourceUrl,
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
    selectedCandidateCount: due.rows.length,
    syncedCandidateCount,
    failedCandidateCount: results.length - syncedCandidateCount,
    results,
  };
}
