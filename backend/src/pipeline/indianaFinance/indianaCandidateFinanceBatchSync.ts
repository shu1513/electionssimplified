import { isIndianaNativePacEnabled } from "../../config/featureFlags.js";
import { syncDueIndianaNativePac } from "./indianaNativePacBatchSync.js";
import { stat } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";

import { mergeCycleArtifactRows } from "../finance/cycleArtifactRows.js";
import {
  autoLinkMissingIndianaCandidateFinanceLinks,
  buildIndianaCandidateNamePredicate,
  listIndianaCandidateElectionsMissingFinanceLinks,
  type IndianaFinanceAutoLinkCandidateElection,
} from "./indianaCandidateFinanceAutoLink.js";
import {
  syncIndianaCandidateFinance,
  type IndianaCandidateFinanceSyncResult,
} from "./indianaCandidateFinanceSync.js";
import {
  createStandardStateFinanceDueListQuery,
  type StandardStateFinanceDueRow,
} from "../finance/standardStateFinanceDueListQuery.js";
import { INDIANA_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./indianaFinanceEligibleOffices.js";
import {
  DEFAULT_INDIANA_CAMPAIGN_FINANCE_CACHE_DIR,
  buildIndianaCampaignFinanceArtifactUrl,
  getIndianaCampaignFinanceArtifactCachePaths,
  readIndianaCampaignFinanceArtifactCacheMetadata,
} from "./indianaCampaignFinanceArtifactCache.js";
import {
  INDIANA_CAMPAIGN_FINANCE_CONTRIBUTION_COLUMNS,
  readIndianaCampaignFinanceContributionRows,
  type IndianaCampaignFinanceContributionRow,
} from "./indianaCampaignFinanceReader.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type IndianaCandidateFinanceDueRow = StandardStateFinanceDueRow;

export type IndianaContributionDataForYear = {
  year: number;
  zipPath: string;
  sourceUrl: string;
  rows: IndianaCampaignFinanceContributionRow[];
  rowsByCommitteeId: Map<string, IndianaCampaignFinanceContributionRow[]>;
};

export type IndianaCandidateFinanceBatchSyncInput = {
  db: Queryable;
  nativePacOnly?: boolean;
  nativePacLinkId?: string;
  now?: Date;
  dryRun?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  rawDataZipPath?: string;
  rawDataCacheDir?: string;
  autoLinkMissingLinks?: boolean;
  contributionDataByYear?: ReadonlyMap<number, IndianaContributionDataForYear>;
  syncIndianaCandidateFinanceFn?: typeof syncIndianaCandidateFinance;
};

export type IndianaCandidateFinanceBatchSyncItemResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  committeeId: string;
  ok: boolean;
  result?: IndianaCandidateFinanceSyncResult;
  error?: string;
};

export type IndianaCandidateFinanceBatchSyncResult = {
  nativePac?: Awaited<ReturnType<typeof syncDueIndianaNativePac>>;
  dryRun: boolean;
  now: string;
  staleAfterDays: number;
  maxCandidates: number;
  dueCandidateCount: number;
  selectedCandidateCount: number;
  syncedCandidateCount: number;
  failedCandidateCount: number;
  results: IndianaCandidateFinanceBatchSyncItemResult[];
};

const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_STALE_AFTER_DAYS = 7;
const DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS = 1;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

function assertValidDate(date: Date, label: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid Indiana finance batch sync ${label}`);
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Indiana finance batch sync ${label}: ${value}`);
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

function groupDueRowsByYear(rows: readonly IndianaCandidateFinanceDueRow[]): Map<number, IndianaCandidateFinanceDueRow[]> {
  const byYear = new Map<number, IndianaCandidateFinanceDueRow[]>();
  for (const row of rows) {
    const yearRows = byYear.get(row.electionYear) ?? [];
    yearRows.push(row);
    byYear.set(row.electionYear, yearRows);
  }
  return byYear;
}

function groupAutoLinkCandidatesByYear(
  rows: readonly IndianaFinanceAutoLinkCandidateElection[]
): Map<number, IndianaFinanceAutoLinkCandidateElection[]> {
  const byYear = new Map<number, IndianaFinanceAutoLinkCandidateElection[]>();
  for (const row of rows) {
    const yearRows = byYear.get(row.electionYear) ?? [];
    yearRows.push(row);
    byYear.set(row.electionYear, yearRows);
  }
  return byYear;
}

function groupContributionRowsByCommittee(
  rows: readonly IndianaCampaignFinanceContributionRow[]
): Map<string, IndianaCampaignFinanceContributionRow[]> {
  const byCommittee = new Map<string, IndianaCampaignFinanceContributionRow[]>();
  for (const row of rows) {
    const committeeId = normalizeCommitteeId(row.FileNumber);
    if (!committeeId) {
      continue;
    }
    const existing = byCommittee.get(committeeId) ?? [];
    existing.push(row);
    byCommittee.set(committeeId, existing);
  }
  return byCommittee;
}

function indianaCycleFilingYears(electionYear: number, rawDataZipPath?: string): number[] {
  return rawDataZipPath ? [electionYear] : [electionYear - 1, electionYear];
}

function indianaContributionRowIdentity(row: IndianaCampaignFinanceContributionRow): string {
  // Indiana exposes no transaction id. Exact official row content is the
  // narrowest identity that avoids conflating distinct same-day receipts.
  return JSON.stringify(INDIANA_CAMPAIGN_FINANCE_CONTRIBUTION_COLUMNS.map((column) => row[column]));
}

async function readCycleContributionRows(input: {
  electionYear: number;
  rawDataZipPath?: string;
  rawDataCacheDir?: string;
  predicate?: (row: IndianaCampaignFinanceContributionRow) => boolean;
}): Promise<{ rows: IndianaCampaignFinanceContributionRow[]; zipPath: string; sourceUrl: string }> {
  const cacheDir =
    input.rawDataCacheDir ??
    (process.env.INDIANA_CAMPAIGN_FINANCE_CACHE_DIR?.trim() ||
      DEFAULT_INDIANA_CAMPAIGN_FINANCE_CACHE_DIR);
  const artifactRowsByYear: IndianaCampaignFinanceContributionRow[][] = [];
  let zipPath = "";
  let sourceUrl = "";
  let foundMatchingRows = false;
  for (const filingYear of indianaCycleFilingYears(input.electionYear, input.rawDataZipPath)) {
    const paths = getIndianaCampaignFinanceArtifactCachePaths({
      cacheDir,
      year: filingYear,
      artifactKind: "contribution",
    });
    const artifactZipPath = input.rawDataZipPath ?? paths.zipPath;
    if (!(await fileExists(artifactZipPath))) {
      throw new Error(`Indiana campaign finance contribution ZIP not found for ${filingYear}: ${artifactZipPath}`);
    }
    const metadata = input.rawDataZipPath
      ? null
      : await readIndianaCampaignFinanceArtifactCacheMetadata(paths.metadataPath);
    const artifactRows = await readIndianaCampaignFinanceContributionRows({
      zipPath: artifactZipPath,
      year: filingYear,
      predicate: input.predicate,
    });
    artifactRowsByYear.push(artifactRows);
    if (!foundMatchingRows) {
      zipPath = artifactZipPath;
      sourceUrl =
        metadata?.remote.url ??
        buildIndianaCampaignFinanceArtifactUrl({ year: filingYear, artifactKind: "contribution" });
      foundMatchingRows = artifactRows.length > 0;
    }
  }
  return {
    rows: mergeCycleArtifactRows({
      artifacts: artifactRowsByYear,
      rowIdentity: indianaContributionRowIdentity,
    }),
    zipPath,
    sourceUrl,
  };
}

async function loadContributionDataForYear(input: {
  year: number;
  rawDataZipPath?: string;
  rawDataCacheDir?: string;
}): Promise<IndianaContributionDataForYear> {
  const data = await readCycleContributionRows({
    electionYear: input.year,
    rawDataZipPath: input.rawDataZipPath,
    rawDataCacheDir: input.rawDataCacheDir,
  });

  return {
    year: input.year,
    zipPath: data.zipPath,
    sourceUrl: data.sourceUrl,
    rows: data.rows,
    rowsByCommitteeId: groupContributionRowsByCommittee(data.rows),
  };
}

async function loadAutoLinkContributionRowsForYear(input: {
  year: number;
  candidates: readonly IndianaFinanceAutoLinkCandidateElection[];
  rawDataZipPath?: string;
  rawDataCacheDir?: string;
  contributionDataByYear?: ReadonlyMap<number, IndianaContributionDataForYear>;
}): Promise<{ rows: IndianaCampaignFinanceContributionRow[]; sourceUrl: string }> {
  const injected = input.contributionDataByYear?.get(input.year);
  if (injected) {
    return {
      rows: injected.rows,
      sourceUrl: injected.sourceUrl,
    };
  }

  const data = await readCycleContributionRows({
    electionYear: input.year,
    rawDataZipPath: input.rawDataZipPath,
    rawDataCacheDir: input.rawDataCacheDir,
    predicate: buildIndianaCandidateNamePredicate(input.candidates),
  });
  return { rows: data.rows, sourceUrl: data.sourceUrl };
}

export const listDueIndianaCandidateFinanceSyncRows = createStandardStateFinanceDueListQuery({
  state: "IN",
  tables: {
    links: "in_candidate_finance_links",
    summaries: "in_candidate_finance_summaries",
  },
  eligibleOfficeKeys: INDIANA_FINANCE_ELIGIBLE_OFFICE_KEYS,
});

export async function syncDueIndianaCandidateFinance(
  input: IndianaCandidateFinanceBatchSyncInput
): Promise<IndianaCandidateFinanceBatchSyncResult> {
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
  const syncFn = input.syncIndianaCandidateFinanceFn ?? syncIndianaCandidateFinance;

  let nativePac: Awaited<ReturnType<typeof syncDueIndianaNativePac>> | undefined;
  if (isIndianaNativePacEnabled()) {
    if (!("connect" in input.db) || typeof input.db.connect !== "function") {
      throw new Error("native_pac_pool_required");
    }
    nativePac = await syncDueIndianaNativePac({
      db: input.db as Pick<Pool, "query" | "connect">,
      now, dryRun, maxCandidates, staleAfterDays,
      electionLookbackDays: input.electionLookbackDays,
      electionLookaheadDays, linkId: input.nativePacLinkId,
    });
  }
  if (input.nativePacOnly) return {
    nativePac, dryRun, now: now.toISOString(), staleAfterDays, maxCandidates,
    dueCandidateCount: 0, selectedCandidateCount: 0,
    syncedCandidateCount: 0, failedCandidateCount: 0, results: [],
  };

  if (!dryRun && input.autoLinkMissingLinks !== false) {
    try {
      const missingLinkCandidates = await listIndianaCandidateElectionsMissingFinanceLinks(input.db, {
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
      });
      const contributionRowsByYear = new Map<number, readonly IndianaCampaignFinanceContributionRow[]>();
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
      const autoLinkResults = await autoLinkMissingIndianaCandidateFinanceLinks({
        db: input.db,
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
        contributionRowsByYear,
        sourceUrlByYear,
        candidateElections: missingLinkCandidates,
      });
      for (const result of autoLinkResults) {
        if (result.status !== "linked") {
          console.warn("Indiana finance auto-link did not link candidate election:", result);
        }
      }
    } catch (error) {
      console.warn(
        "Indiana finance auto-link skipped; continuing with already-linked candidate sync:",
        error instanceof Error ? error.message : error
      );
    }
  }

  const due = await listDueIndianaCandidateFinanceSyncRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
  });
  const contributionDataByYear = new Map<number, IndianaContributionDataForYear>(
    input.contributionDataByYear ? [...input.contributionDataByYear.entries()] : []
  );
  const contributionDataLoadErrorsByYear = new Map<number, string>();
  for (const year of groupDueRowsByYear(due.rows).keys()) {
    if (!contributionDataByYear.has(year)) {
      try {
        contributionDataByYear.set(
          year,
          await loadContributionDataForYear({
            year,
            rawDataZipPath: input.rawDataZipPath,
            rawDataCacheDir: input.rawDataCacheDir,
          })
        );
      } catch (error) {
        contributionDataLoadErrorsByYear.set(year, error instanceof Error ? error.message : String(error));
      }
    }
  }

  const results: IndianaCandidateFinanceBatchSyncItemResult[] = [];
  for (const row of due.rows) {
    const contributionDataLoadError = contributionDataLoadErrorsByYear.get(row.electionYear);
    if (contributionDataLoadError) {
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        committeeId: row.committeeId,
        ok: false,
        error: contributionDataLoadError,
      });
      continue;
    }

    const contributionData = contributionDataByYear.get(row.electionYear);
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
        linkedCommittee: {
          committeeId: row.committeeId,
          committeeName: row.committeeName,
        },
        sourceUrl: row.sourceUrl,
        contributionRows: contributionData?.rows ?? [],
        contributionSourceUrl: contributionData?.sourceUrl,
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
    ...(nativePac ? { nativePac } : {}),
    dueCandidateCount: due.totalDueRows,
    selectedCandidateCount: due.rows.length,
    syncedCandidateCount,
    failedCandidateCount: results.length - syncedCandidateCount,
    results,
  };
}
