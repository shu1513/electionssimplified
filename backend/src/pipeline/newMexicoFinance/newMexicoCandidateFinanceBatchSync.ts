import { syncDueNewMexicoReportedFinance } from "./newMexicoReportedBatchSync.js";
import { isNewMexicoReportedCommitteeEnabled, isNewMexicoReportedIeEnabled } from "../../config/featureFlags.js";
import { stat } from "node:fs/promises";
import { describeError } from "../../observability/scrubText.js";
import type { Pool, PoolClient } from "pg";

import type { FinanceIndustryClassifier } from "../finance/financeIndustryClassificationService.js";
import { mergeCycleArtifactRows } from "../finance/cycleArtifactRows.js";
import {
  autoLinkMissingNewMexicoCandidateFinanceLinks,
  buildNewMexicoCandidateNamePredicate,
  listNewMexicoCandidateElectionsMissingFinanceLinks,
  type NewMexicoFinanceAutoLinkCandidateElection,
} from "./newMexicoCandidateFinanceAutoLink.js";
import {
  syncNewMexicoCandidateFinance,
  type NewMexicoCandidateFinanceSyncResult,
} from "./newMexicoCandidateFinanceSync.js";
import {
  createStandardStateFinanceDueListQuery,
  type StandardStateFinanceDueRow,
} from "../finance/standardStateFinanceDueListQuery.js";
import { NEW_MEXICO_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./newMexicoFinanceEligibleOffices.js";
import {
  DEFAULT_NEW_MEXICO_CFIS_CACHE_DIR,
  buildNewMexicoCfisArtifactUrl,
  getNewMexicoCfisArtifactCachePaths,
  readNewMexicoCfisArtifactCacheMetadata,
} from "./newMexicoCfisArtifactCache.js";
import {
  readNewMexicoCfisContributionRows,
  readNewMexicoCfisExpenditureRows,
  type NewMexicoCfisContributionRow,
  type NewMexicoCfisExpenditureRow,
} from "./newMexicoCfisArtifactReader.js";
import { normalizeNewMexicoCandidateNameKeys } from "./newMexicoCandidateCommitteeResolver.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type NewMexicoCandidateFinanceDueRow = StandardStateFinanceDueRow;

export type NewMexicoContributionDataForYear = {
  year: number;
  filePath: string;
  sourceUrl: string;
  rowsByCommitteeId: Map<string, NewMexicoCfisContributionRow[]>;
};

export type NewMexicoExpenditureDataForYear = {
  year: number;
  filePath: string;
  sourceUrl: string;
  rows: NewMexicoCfisExpenditureRow[];
};

export type NewMexicoCandidateFinanceBatchSyncInput = {
  db: Queryable;
  now?: Date;
  dryRun?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  forceRawDataRefresh?: boolean;
  rawDataCacheDir?: string;
  autoLinkMissingLinks?: boolean;
  contributionDataByYear?: ReadonlyMap<number, NewMexicoContributionDataForYear>;
  expenditureDataByYear?: ReadonlyMap<number, NewMexicoExpenditureDataForYear>;
  financeIndustryClassifier?: FinanceIndustryClassifier;
  aiClassificationMinAmount?: number;
  syncNewMexicoCandidateFinanceFn?: typeof syncNewMexicoCandidateFinance;
};

export type NewMexicoCandidateFinanceBatchSyncItemResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  committeeId: string;
  ok: boolean;
  result?: NewMexicoCandidateFinanceSyncResult;
  error?: string;
};

export type NewMexicoCandidateFinanceBatchSyncResult = {
  reportedFinance?: Awaited<ReturnType<typeof syncDueNewMexicoReportedFinance>>;
  dryRun: boolean;
  now: string;
  staleAfterDays: number;
  maxCandidates: number;
  dueCandidateCount: number;
  selectedCandidateCount: number;
  syncedCandidateCount: number;
  failedCandidateCount: number;
  results: NewMexicoCandidateFinanceBatchSyncItemResult[];
};

const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_STALE_AFTER_DAYS = 7;
// Keep one extra calendar day so UTC scheduler timing cannot skip election-night finance syncs.
const DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS = 1;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

function assertValidDate(date: Date, label: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid New Mexico finance batch sync ${label}`);
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid New Mexico finance batch sync ${label}: ${value}`);
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

function groupDueRowsByYear(rows: readonly NewMexicoCandidateFinanceDueRow[]): Map<number, NewMexicoCandidateFinanceDueRow[]> {
  const byYear = new Map<number, NewMexicoCandidateFinanceDueRow[]>();
  for (const row of rows) {
    const yearRows = byYear.get(row.electionYear) ?? [];
    yearRows.push(row);
    byYear.set(row.electionYear, yearRows);
  }
  return byYear;
}

function groupAutoLinkCandidatesByYear(
  rows: readonly NewMexicoFinanceAutoLinkCandidateElection[]
): Map<number, NewMexicoFinanceAutoLinkCandidateElection[]> {
  const byYear = new Map<number, NewMexicoFinanceAutoLinkCandidateElection[]>();
  for (const row of rows) {
    const yearRows = byYear.get(row.electionYear) ?? [];
    yearRows.push(row);
    byYear.set(row.electionYear, yearRows);
  }
  return byYear;
}

function groupContributionRowsByCommittee(
  rows: readonly NewMexicoCfisContributionRow[]
): Map<string, NewMexicoCfisContributionRow[]> {
  const byCommittee = new Map<string, NewMexicoCfisContributionRow[]>();
  for (const row of rows) {
    const committeeId = normalizeCommitteeId(row.OrgID);
    if (!committeeId) {
      continue;
    }
    const existing = byCommittee.get(committeeId) ?? [];
    existing.push(row);
    byCommittee.set(committeeId, existing);
  }
  return byCommittee;
}

function buildNewMexicoExpenditureCandidatePredicate(
  rows: readonly NewMexicoCandidateFinanceDueRow[]
): (row: NewMexicoCfisExpenditureRow) => boolean {
  const candidateNameKeys = new Set<string>();
  for (const candidate of rows) {
    for (const key of normalizeNewMexicoCandidateNameKeys(candidate.candidateName)) {
      candidateNameKeys.add(key);
    }
  }

  return (row) => {
    for (const rowKey of normalizeNewMexicoCandidateNameKeys(row.Reason)) {
      if (candidateNameKeys.has(rowKey)) {
        return true;
      }
    }
    return false;
  };
}

function collectCommitteeIdsForContributionLoad(input: {
  dueRows: readonly NewMexicoCandidateFinanceDueRow[];
  expenditureRows?: readonly NewMexicoCfisExpenditureRow[];
}): string[] {
  const committeeIds = new Set<string>();
  for (const row of input.dueRows) {
    const committeeId = normalizeCommitteeId(row.committeeId);
    if (committeeId) {
      committeeIds.add(committeeId);
    }
  }
  for (const row of input.expenditureRows ?? []) {
    const committeeId = normalizeCommitteeId(row.OrgID);
    if (committeeId) {
      committeeIds.add(committeeId);
    }
  }
  return [...committeeIds];
}

function flattenContributionDataRows(
  contributionData: NewMexicoContributionDataForYear | undefined
): NewMexicoCfisContributionRow[] {
  return contributionData ? [...contributionData.rowsByCommitteeId.values()].flat() : [];
}

function newMexicoCycleFilingYears(electionYear: number): number[] {
  return [electionYear - 1, electionYear];
}

function newMexicoContributionRowIdentity(row: NewMexicoCfisContributionRow): string {
  const transactionId = row["Transaction ID"].trim().toUpperCase();
  return transactionId ? `${normalizeCommitteeId(row.OrgID)}\u0000${transactionId}` : "";
}

function newMexicoExpenditureRowIdentity(row: NewMexicoCfisExpenditureRow): string {
  const expenditureId = row["Expenditure ID"].trim().toUpperCase();
  return expenditureId ? `${normalizeCommitteeId(row.OrgID)}\u0000${expenditureId}` : "";
}

async function readCycleArtifactData<Row>(input: {
  electionYear: number;
  artifactKind: "contributions" | "expenditures";
  rawDataCacheDir?: string;
  readRows: (filePath: string) => Promise<Row[]>;
  rowIdentity: (row: Row) => string;
}): Promise<{ rows: Row[]; filePath: string; sourceUrl: string }> {
  const kindLabel = input.artifactKind === "contributions" ? "contribution" : "expenditure";
  const artifactRowsByYear: Row[][] = [];
  let filePath = "";
  let sourceUrl = "";
  let foundMatchingRows = false;
  for (const filingYear of newMexicoCycleFilingYears(input.electionYear)) {
    const paths = getNewMexicoCfisArtifactCachePaths({
      cacheDir:
        input.rawDataCacheDir ??
        (process.env.NEW_MEXICO_CFIS_CACHE_DIR?.trim() || DEFAULT_NEW_MEXICO_CFIS_CACHE_DIR),
      year: filingYear,
      artifactKind: input.artifactKind,
    });
    if (!(await fileExists(paths.filePath))) {
      throw new Error(`New Mexico CFIS ${kindLabel} artifact not found for ${filingYear}: ${paths.filePath}`);
    }
    const metadata = await readNewMexicoCfisArtifactCacheMetadata(paths.metadataPath);
    const artifactRows = await input.readRows(paths.filePath);
    artifactRowsByYear.push(artifactRows);
    if (!foundMatchingRows) {
      filePath = paths.filePath;
      sourceUrl =
        metadata?.remote.url ?? buildNewMexicoCfisArtifactUrl({ year: filingYear, artifactKind: input.artifactKind });
      foundMatchingRows = artifactRows.length > 0;
    }
  }
  return {
    rows: mergeCycleArtifactRows({ artifacts: artifactRowsByYear, rowIdentity: input.rowIdentity }),
    filePath,
    sourceUrl,
  };
}

async function loadContributionDataForYear(input: {
  year: number;
  committeeIds: readonly string[];
  rawDataCacheDir?: string;
}): Promise<NewMexicoContributionDataForYear> {
  const normalizedCommitteeIds = new Set(input.committeeIds.map(normalizeCommitteeId).filter(Boolean));
  const data = await readCycleArtifactData({
    electionYear: input.year,
    artifactKind: "contributions",
    rawDataCacheDir: input.rawDataCacheDir,
    rowIdentity: newMexicoContributionRowIdentity,
    readRows: (filePath) =>
      readNewMexicoCfisContributionRows({
        filePath,
        predicate: (row) => normalizedCommitteeIds.has(normalizeCommitteeId(row.OrgID)),
      }),
  });

  return {
    year: input.year,
    filePath: data.filePath,
    sourceUrl: data.sourceUrl,
    rowsByCommitteeId: groupContributionRowsByCommittee(data.rows),
  };
}

async function loadAutoLinkContributionRowsForYear(input: {
  year: number;
  candidates: readonly NewMexicoFinanceAutoLinkCandidateElection[];
  rawDataCacheDir?: string;
  contributionDataByYear?: ReadonlyMap<number, NewMexicoContributionDataForYear>;
}): Promise<{ rows: NewMexicoCfisContributionRow[]; sourceUrl: string }> {
  const injected = input.contributionDataByYear?.get(input.year);
  if (injected) {
    return {
      rows: [...injected.rowsByCommitteeId.values()].flat(),
      sourceUrl: injected.sourceUrl,
    };
  }

  const data = await readCycleArtifactData({
    electionYear: input.year,
    artifactKind: "contributions",
    rawDataCacheDir: input.rawDataCacheDir,
    rowIdentity: newMexicoContributionRowIdentity,
    readRows: (filePath) =>
      readNewMexicoCfisContributionRows({
        filePath,
        predicate: buildNewMexicoCandidateNamePredicate(input.candidates),
      }),
  });
  return { rows: data.rows, sourceUrl: data.sourceUrl };
}

async function loadExpenditureDataForYear(input: {
  year: number;
  dueRows: readonly NewMexicoCandidateFinanceDueRow[];
  rawDataCacheDir?: string;
}): Promise<NewMexicoExpenditureDataForYear> {
  const data = await readCycleArtifactData({
    electionYear: input.year,
    artifactKind: "expenditures",
    rawDataCacheDir: input.rawDataCacheDir,
    rowIdentity: newMexicoExpenditureRowIdentity,
    readRows: (filePath) =>
      readNewMexicoCfisExpenditureRows({
        filePath,
        predicate: buildNewMexicoExpenditureCandidatePredicate(input.dueRows),
      }),
  });
  return {
    year: input.year,
    filePath: data.filePath,
    sourceUrl: data.sourceUrl,
    rows: data.rows,
  };
}

export const listDueNewMexicoCandidateFinanceSyncRows = createStandardStateFinanceDueListQuery({
  state: "NM",
  tables: {
    links: "nm_candidate_finance_links",
    summaries: "nm_candidate_finance_summaries",
  },
  eligibleOfficeKeys: NEW_MEXICO_FINANCE_ELIGIBLE_OFFICE_KEYS,
});

export async function syncDueNewMexicoCandidateFinance(
  input: NewMexicoCandidateFinanceBatchSyncInput
): Promise<NewMexicoCandidateFinanceBatchSyncResult> {
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
  const syncFn = input.syncNewMexicoCandidateFinanceFn ?? syncNewMexicoCandidateFinance;

  // Native IE and committee receipts progress independently of annual CSV data.
  let reportedFinance: NewMexicoCandidateFinanceBatchSyncResult["reportedFinance"];
  if (isNewMexicoReportedCommitteeEnabled() || isNewMexicoReportedIeEnabled()) {
    try {
      const db = input.db as Pick<Pool, "query" | "connect">;
      if (typeof db.connect !== "function") throw new Error("New Mexico reported finance requires a connection pool");
      reportedFinance = await syncDueNewMexicoReportedFinance({ db, now, dryRun, maxCandidates, staleAfterDays,
        electionLookaheadDays, electionLookbackDays: input.electionLookbackDays, forceRawDataRefresh: input.forceRawDataRefresh });
    } catch (error) {
      console.warn("New Mexico reported finance batch unavailable; continuing annual direct sync:", describeError(error));
    }
  }

  if (!dryRun && input.autoLinkMissingLinks !== false) {
    try {
      const missingLinkCandidates = await listNewMexicoCandidateElectionsMissingFinanceLinks(input.db, {
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
      });
      const contributionRowsByYear = new Map<number, readonly NewMexicoCfisContributionRow[]>();
      const sourceUrlByYear = new Map<number, string>();
      const skippedAutoLinkYears = new Map<number, string>();
      for (const [year, candidates] of groupAutoLinkCandidatesByYear(missingLinkCandidates).entries()) {
        try {
          const data = await loadAutoLinkContributionRowsForYear({
            year,
            candidates,
            rawDataCacheDir: input.rawDataCacheDir,
            contributionDataByYear: input.contributionDataByYear,
          });
          contributionRowsByYear.set(year, data.rows);
          sourceUrlByYear.set(year, data.sourceUrl);
        } catch (error) {
          skippedAutoLinkYears.set(year, error instanceof Error ? error.message : String(error));
        }
      }
      const autoLinkCandidates = missingLinkCandidates.filter((candidate) =>
        contributionRowsByYear.has(candidate.electionYear)
      );
      const autoLinkResults = await autoLinkMissingNewMexicoCandidateFinanceLinks({
        db: input.db,
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
        contributionRowsByYear,
        sourceUrlByYear,
        candidateElections: autoLinkCandidates,
      });
      for (const result of autoLinkResults) {
        if (result.status !== "linked") {
          console.warn("New Mexico finance auto-link did not link candidate election:", result);
        }
      }
      for (const [year, message] of skippedAutoLinkYears) {
        console.warn(`New Mexico finance auto-link skipped year ${year}:`, message);
      }
    } catch (error) {
      console.warn(
        "New Mexico finance auto-link skipped; continuing with already-linked candidate sync:",
        error instanceof Error ? error.message : error
      );
    }
  }

  const due = await listDueNewMexicoCandidateFinanceSyncRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
  });
  const expenditureDataByYear = new Map<number, NewMexicoExpenditureDataForYear>(
    input.expenditureDataByYear ? [...input.expenditureDataByYear.entries()] : []
  );
  const expenditureDataLoadErrorsByYear = new Map<number, string>();
  for (const [year, rows] of groupDueRowsByYear(due.rows).entries()) {
    if (!expenditureDataByYear.has(year)) {
      try {
        expenditureDataByYear.set(
          year,
          await loadExpenditureDataForYear({
            year,
            dueRows: rows,
            rawDataCacheDir: input.rawDataCacheDir,
          })
        );
      } catch (error) {
        expenditureDataLoadErrorsByYear.set(year, error instanceof Error ? error.message : String(error));
        console.warn(
          "New Mexico CFIS expenditure artifact unavailable; syncing direct finance without outside spending:",
          error instanceof Error ? error.message : error
        );
      }
    }
  }

  const contributionDataByYear = new Map<number, NewMexicoContributionDataForYear>(
    input.contributionDataByYear ? [...input.contributionDataByYear.entries()] : []
  );
  const contributionDataLoadErrorsByYear = new Map<number, string>();
  for (const [year, rows] of groupDueRowsByYear(due.rows).entries()) {
    if (!contributionDataByYear.has(year)) {
      try {
        contributionDataByYear.set(
          year,
          await loadContributionDataForYear({
            year,
            committeeIds: collectCommitteeIdsForContributionLoad({
              dueRows: rows,
              expenditureRows: expenditureDataByYear.get(year)?.rows,
            }),
            rawDataCacheDir: input.rawDataCacheDir,
          })
        );
      } catch (error) {
        contributionDataLoadErrorsByYear.set(year, error instanceof Error ? error.message : String(error));
      }
    }
  }

  const results: NewMexicoCandidateFinanceBatchSyncItemResult[] = [];
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
    const expenditureData = expenditureDataByYear.get(row.electionYear);
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
        contributionRows: flattenContributionDataRows(contributionData),
        contributionSourceUrl: contributionData?.sourceUrl,
        expenditureRows: expenditureDataLoadErrorsByYear.has(row.electionYear) ? undefined : expenditureData?.rows ?? [],
        expenditureSourceUrl: expenditureData?.sourceUrl,
        trustedCommittee: {
          committeeId: row.committeeId,
          committeeName: row.committeeName,
          sourceUrl: row.sourceUrl,
        },
        financeIndustryClassifier: input.financeIndustryClassifier,
        aiClassificationMinAmount: input.aiClassificationMinAmount,
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
    ...(reportedFinance ? { reportedFinance } : {}),
  };
}
