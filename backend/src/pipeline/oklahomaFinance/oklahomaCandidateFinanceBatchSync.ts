import { stat } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import { isOklahomaReportedCommitteeEnabled,isOklahomaIndependentIeEnabled } from "../../config/featureFlags.js";
import { syncDueOklahomaReportedFinance,type OklahomaReportedBatchResult } from "./oklahomaReportedBatchSync.js";

import { mergeCycleArtifactRows } from "../finance/cycleArtifactRows.js";
import {
  autoLinkMissingOklahomaCandidateFinanceLinks,
  buildOklahomaCandidateNamePredicate,
  listOklahomaCandidateElectionsMissingFinanceLinks,
  type OklahomaFinanceAutoLinkCandidateElection,
  type OklahomaGuardianCandidateDetailFetcher,
} from "./oklahomaCandidateFinanceAutoLink.js";
import {
  syncOklahomaCandidateFinance,
  type OklahomaCandidateFinanceSyncResult,
} from "./oklahomaCandidateFinanceSync.js";
import {
  createStandardStateFinanceDueListQuery,
  type StandardStateFinanceDueRow,
} from "../finance/standardStateFinanceDueListQuery.js";
import { OKLAHOMA_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./oklahomaFinanceEligibleOffices.js";
import {
  DEFAULT_OKLAHOMA_GUARDIAN_CONTRIBUTION_CACHE_DIR,
  buildOklahomaGuardianContributionZipUrl,
  getOklahomaGuardianContributionArtifactCachePaths,
  readOklahomaGuardianContributionArtifactCacheMetadata,
} from "./oklahomaGuardianContributionArtifactCache.js";
import {
  readOklahomaGuardianContributionRows,
  type OklahomaGuardianContributionRow,
} from "./oklahomaGuardianContributionReader.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type OklahomaCandidateFinanceDueRow = StandardStateFinanceDueRow;

export type OklahomaContributionDataForYear = {
  year: number;
  zipPath: string;
  sourceUrl: string;
  rowsByCommitteeId: Map<string, OklahomaGuardianContributionRow[]>;
};

export type OklahomaCandidateFinanceBatchSyncInput = {
  db: Queryable & Partial<Pick<Pool,"connect">>;
  forceRawDataRefresh?: boolean;
  now?: Date;
  dryRun?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  rawDataZipPath?: string;
  rawDataCacheDir?: string;
  autoLinkMissingLinks?: boolean;
  contributionDataByYear?: ReadonlyMap<number, OklahomaContributionDataForYear>;
  syncOklahomaCandidateFinanceFn?: typeof syncOklahomaCandidateFinance;
  fetchOklahomaGuardianCandidateDetailFn?: OklahomaGuardianCandidateDetailFetcher;
};

export type OklahomaCandidateFinanceBatchSyncItemResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  committeeId: string;
  ok: boolean;
  result?: OklahomaCandidateFinanceSyncResult;
  error?: string;
};

export type OklahomaCandidateFinanceBatchSyncResult = {
  reportedFinance?: OklahomaReportedBatchResult;
  reportedFinanceError?: string;
  dryRun: boolean;
  now: string;
  staleAfterDays: number;
  maxCandidates: number;
  dueCandidateCount: number;
  selectedCandidateCount: number;
  syncedCandidateCount: number;
  failedCandidateCount: number;
  results: OklahomaCandidateFinanceBatchSyncItemResult[];
};

const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_STALE_AFTER_DAYS = 7;
// Keep one extra calendar day so UTC scheduler timing cannot skip election-night finance syncs.
const DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS = 1;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

function assertValidDate(date: Date, label: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid Oklahoma finance batch sync ${label}`);
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Oklahoma finance batch sync ${label}: ${value}`);
  }
  return normalized;
}

function normalizeCommitteeId(value: string): string {
  return value.trim().toUpperCase();
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

function groupDueRowsByYear(rows: readonly OklahomaCandidateFinanceDueRow[]): Map<number, OklahomaCandidateFinanceDueRow[]> {
  const byYear = new Map<number, OklahomaCandidateFinanceDueRow[]>();
  for (const row of rows) {
    const yearRows = byYear.get(row.electionYear) ?? [];
    yearRows.push(row);
    byYear.set(row.electionYear, yearRows);
  }
  return byYear;
}

function groupAutoLinkCandidatesByYear(
  rows: readonly OklahomaFinanceAutoLinkCandidateElection[]
): Map<number, OklahomaFinanceAutoLinkCandidateElection[]> {
  const byYear = new Map<number, OklahomaFinanceAutoLinkCandidateElection[]>();
  for (const row of rows) {
    const yearRows = byYear.get(row.electionYear) ?? [];
    yearRows.push(row);
    byYear.set(row.electionYear, yearRows);
  }
  return byYear;
}

function groupContributionRowsByCommittee(
  rows: readonly OklahomaGuardianContributionRow[]
): Map<string, OklahomaGuardianContributionRow[]> {
  const byCommittee = new Map<string, OklahomaGuardianContributionRow[]>();
  for (const row of rows) {
    const committeeId = normalizeCommitteeId(row["Org ID"]);
    if (!committeeId) {
      continue;
    }
    const existing = byCommittee.get(committeeId) ?? [];
    existing.push(row);
    byCommittee.set(committeeId, existing);
  }
  return byCommittee;
}

function oklahomaCycleFilingYears(electionYear: number, rawDataZipPath?: string): number[] {
  return rawDataZipPath ? [electionYear] : [electionYear - 1, electionYear];
}

function oklahomaContributionRowIdentity(row: OklahomaGuardianContributionRow): string {
  const receiptId = row["Receipt ID"].trim().toUpperCase();
  return receiptId ? `${normalizeCommitteeId(row["Org ID"])}\u0000${receiptId}` : "";
}

async function readCycleContributionRows(input: {
  electionYear: number;
  rawDataZipPath?: string;
  rawDataCacheDir?: string;
  predicate: (row: OklahomaGuardianContributionRow) => boolean;
}): Promise<{ rows: OklahomaGuardianContributionRow[]; zipPath: string; sourceUrl: string }> {
  const cacheDir =
    input.rawDataCacheDir ??
    (process.env.OKLAHOMA_GUARDIAN_CONTRIBUTION_CACHE_DIR?.trim() ||
      DEFAULT_OKLAHOMA_GUARDIAN_CONTRIBUTION_CACHE_DIR);
  const artifactRowsByYear: OklahomaGuardianContributionRow[][] = [];
  let zipPath = "";
  let sourceUrl = "";
  let foundMatchingRows = false;
  for (const filingYear of oklahomaCycleFilingYears(input.electionYear, input.rawDataZipPath)) {
    const paths = getOklahomaGuardianContributionArtifactCachePaths({ cacheDir, year: filingYear });
    const artifactZipPath = input.rawDataZipPath ?? paths.zipPath;
    if (!(await fileExists(artifactZipPath))) {
      throw new Error(`Oklahoma Guardian contribution ZIP not found for ${filingYear}: ${artifactZipPath}`);
    }
    const metadata = input.rawDataZipPath
      ? null
      : await readOklahomaGuardianContributionArtifactCacheMetadata(paths.metadataPath);
    const artifactRows = await readOklahomaGuardianContributionRows({
      zipPath: artifactZipPath,
      year: filingYear,
      predicate: input.predicate,
    });
    artifactRowsByYear.push(artifactRows);
    if (!foundMatchingRows) {
      zipPath = artifactZipPath;
      sourceUrl = metadata?.remote.url ?? buildOklahomaGuardianContributionZipUrl({ year: filingYear });
      foundMatchingRows = artifactRows.length > 0;
    }
  }
  return {
    rows: mergeCycleArtifactRows({
      artifacts: artifactRowsByYear,
      rowIdentity: oklahomaContributionRowIdentity,
    }),
    zipPath,
    sourceUrl,
  };
}

async function loadContributionDataForYear(input: {
  year: number;
  committeeIds: readonly string[];
  rawDataZipPath?: string;
  rawDataCacheDir?: string;
}): Promise<OklahomaContributionDataForYear> {
  const normalizedCommitteeIds = new Set(input.committeeIds.map(normalizeCommitteeId).filter(Boolean));
  const data = await readCycleContributionRows({
    electionYear: input.year,
    rawDataZipPath: input.rawDataZipPath,
    rawDataCacheDir: input.rawDataCacheDir,
    predicate: (row) => normalizedCommitteeIds.has(normalizeCommitteeId(row["Org ID"])),
  });

  return {
    year: input.year,
    zipPath: data.zipPath,
    sourceUrl: data.sourceUrl,
    rowsByCommitteeId: groupContributionRowsByCommittee(data.rows),
  };
}

async function loadAutoLinkContributionRowsForYear(input: {
  year: number;
  candidates: readonly OklahomaFinanceAutoLinkCandidateElection[];
  rawDataZipPath?: string;
  rawDataCacheDir?: string;
  contributionDataByYear?: ReadonlyMap<number, OklahomaContributionDataForYear>;
}): Promise<{ rows: OklahomaGuardianContributionRow[]; sourceUrl: string }> {
  const injected = input.contributionDataByYear?.get(input.year);
  if (injected) {
    return {
      rows: [...injected.rowsByCommitteeId.values()].flat(),
      sourceUrl: injected.sourceUrl,
    };
  }

  const data = await readCycleContributionRows({
    electionYear: input.year,
    rawDataZipPath: input.rawDataZipPath,
    rawDataCacheDir: input.rawDataCacheDir,
    predicate: buildOklahomaCandidateNamePredicate(input.candidates),
  });
  return { rows: data.rows, sourceUrl: data.sourceUrl };
}

export const listDueOklahomaCandidateFinanceSyncRows = createStandardStateFinanceDueListQuery({
  state: "OK",
  tables: {
    links: "ok_candidate_finance_links",
    summaries: "ok_candidate_finance_summaries",
  },
  eligibleOfficeKeys: OKLAHOMA_FINANCE_ELIGIBLE_OFFICE_KEYS,
});

export async function syncDueOklahomaCandidateFinance(
  input: OklahomaCandidateFinanceBatchSyncInput
): Promise<OklahomaCandidateFinanceBatchSyncResult> {
  const now = input.now ?? new Date();
  assertValidDate(now, "now");

  let reportedFinance:OklahomaReportedBatchResult|undefined,reportedFinanceError:string|undefined;
  if(isOklahomaReportedCommitteeEnabled()||isOklahomaIndependentIeEnabled()){
    // The reported components are independent of the legacy summaries: a
    // failure here (option caps, database, unexpected parse error) is recorded
    // and the legacy sync still runs. Prior component rows are retained.
    // The legacy lookback is a one-day post-election grace; the reported
    // cohort keeps its own lookback so January/February reruns still see
    // November receivers.
    try{
      if(!input.db.connect)throw Error("Oklahoma reported finance requires a pool");
      reportedFinance=await syncDueOklahomaReportedFinance({db:input.db as Pick<Pool,"query"|"connect">,
        now,dryRun:input.dryRun,refresh:input.forceRawDataRefresh,cacheDir:input.rawDataCacheDir,
        maxCandidates:input.maxCandidates,staleAfterDays:input.staleAfterDays,
        electionLookaheadDays:input.electionLookaheadDays});
    }catch(error){
      reportedFinanceError=error instanceof Error?error.message:String(error);
      console.error(`Oklahoma reported finance sync failed; legacy sync continues, prior component rows retained: ${reportedFinanceError}`);
    }
  }

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
  const syncFn = input.syncOklahomaCandidateFinanceFn ?? syncOklahomaCandidateFinance;

  if (!dryRun && input.autoLinkMissingLinks !== false) {
    try {
      const missingLinkCandidates = await listOklahomaCandidateElectionsMissingFinanceLinks(input.db, {
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
      });
      const contributionRowsByYear = new Map<number, readonly OklahomaGuardianContributionRow[]>();
      const sourceUrlByYear = new Map<number, string>();
      for (const [year, candidates] of groupAutoLinkCandidatesByYear(missingLinkCandidates).entries()) {
        const data = await loadAutoLinkContributionRowsForYear({
          year,
          candidates,
          rawDataZipPath: input.rawDataZipPath,
          rawDataCacheDir: input.rawDataCacheDir,
          contributionDataByYear: input.contributionDataByYear,
        });
        contributionRowsByYear.set(year, data.rows);
        sourceUrlByYear.set(year, data.sourceUrl);
      }
      const autoLinkResults = await autoLinkMissingOklahomaCandidateFinanceLinks({
        db: input.db,
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
        contributionRowsByYear,
        sourceUrlByYear,
        candidateElections: missingLinkCandidates,
        fetchCandidateDetail: input.fetchOklahomaGuardianCandidateDetailFn,
      });
      for (const result of autoLinkResults) {
        if (result.status === "unmatched" || result.status === "ambiguous") {
          console.warn("Oklahoma finance auto-link did not link candidate election:", result);
        }
      }
    } catch (error) {
      console.warn(
        "Oklahoma finance auto-link skipped; continuing with already-linked candidate sync:",
        error instanceof Error ? error.message : error
      );
    }
  }

  const due = await listDueOklahomaCandidateFinanceSyncRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
  });
  const contributionDataByYear = new Map<number, OklahomaContributionDataForYear>(
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
          rawDataCacheDir: input.rawDataCacheDir,
        })
      );
    }
  }

  const results: OklahomaCandidateFinanceBatchSyncItemResult[] = [];
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
        officeScope: row.officeScope,
        officeName: row.officeName,
        district: row.district,
        sourceUrl: row.sourceUrl,
        dryRun,
        contributionRows: contributionData?.rowsByCommitteeId.get(committeeKey) ?? [],
        contributionSourceUrl: contributionData?.sourceUrl,
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
    ...(reportedFinance?{reportedFinance}:{}),
    ...(reportedFinanceError?{reportedFinanceError}:{}),
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
