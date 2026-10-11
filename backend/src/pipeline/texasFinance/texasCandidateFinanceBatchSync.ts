import { stat } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";

import type { FinanceIndustryClassifier } from "../finance/financeIndustryClassificationService.js";
import {
  createStandardStateFinanceDueListQuery,
  type StandardStateFinanceDueRow,
} from "../finance/standardStateFinanceDueListQuery.js";
import {
  autoLinkMissingTexasCandidateFinanceLinks,
  listTexasCandidateElectionsMissingFinanceLinks,
} from "./texasCandidateFinanceAutoLink.js";
import {
  syncTexasCandidateFinance,
  type TexasCandidateFinanceSyncResult,
} from "./texasCandidateFinanceSync.js";
import {
  normalizeTexasCandidateNameKeys,
  resolveTexasCandidateCommittee,
} from "./texasCandidateCommitteeResolver.js";
import { TEXAS_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./texasFinanceEligibleOffices.js";
import {
  DEFAULT_TEXAS_TEC_CSV_DATABASE_CACHE_DIR,
  TEXAS_TEC_CSV_DATABASE_URL,
  getTexasTecCsvDatabaseArtifactCachePaths,
  readTexasTecCsvDatabaseArtifactCacheMetadata,
} from "./texasTecCsvDatabaseArtifactCache.js";
import {
  listTexasTecContributionCsvFileNames,
  listTexasTecExpenditureCsvFileNames,
  readTexasTecCandidateRows,
  readTexasTecContributionRows,
  readTexasTecExpenditureRows,
  readTexasTecFilerRows,
  readTexasTecPurposeRows,
  readTexasTecSpacRows,
  type TexasTecCandidateRow,
  type TexasTecContributionRow,
  type TexasTecExpenditureRow,
  type TexasTecFilerRow,
  type TexasTecPurposeRow,
  type TexasTecSpacRow,
} from "./texasTecCsvDatabaseReader.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type TexasCandidateFinanceDueRow = StandardStateFinanceDueRow;

export type TexasTecDataForBatchSync = {
  zipPath: string;
  sourceUrl: string;
  contributionRows: TexasTecContributionRow[];
  candidateRows: TexasTecCandidateRow[];
  expenditureRows: TexasTecExpenditureRow[];
  filerRows: TexasTecFilerRow[];
  spacRows: TexasTecSpacRow[];
  purposeRows?: TexasTecPurposeRow[];
  receiptCommitteeIdsByCandidateElectionKey: Map<string, string[]>;
};

export type TexasCandidateFinanceBatchSyncInput = {
  db: Queryable;
  now?: Date;
  dryRun?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  rawDataZipPath?: string;
  rawDataCacheDir?: string;
  tecData?: TexasTecDataForBatchSync;
  autoLinkMissingLinks?: boolean;
  financeIndustryClassifier?: FinanceIndustryClassifier;
  aiClassificationMinAmount?: number;
  syncTexasCandidateFinanceFn?: typeof syncTexasCandidateFinance;
};

export type TexasCandidateFinanceBatchSyncItemResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  committeeId: string;
  ok: boolean;
  result?: TexasCandidateFinanceSyncResult;
  error?: string;
};

export type TexasCandidateFinanceBatchSyncResult = {
  dryRun: boolean;
  now: string;
  staleAfterDays: number;
  maxCandidates: number;
  dueCandidateCount: number;
  selectedCandidateCount: number;
  syncedCandidateCount: number;
  failedCandidateCount: number;
  results: TexasCandidateFinanceBatchSyncItemResult[];
};

const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_STALE_AFTER_DAYS = 7;
// Keep one extra calendar day so UTC scheduler timing cannot skip election-night finance syncs.
const DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS = 1;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

function assertValidDate(date: Date, label: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid Texas finance batch sync ${label}`);
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Texas finance batch sync ${label}: ${value}`);
  }
  return normalized;
}

function normalizeId(value: string): string {
  return value.trim().toUpperCase();
}

function parseTexasTecDateYear(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const compactMatch = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
  if (compactMatch) {
    return Number(compactMatch[1]);
  }
  const isoMatch = /^(\d{4})-\d{2}-\d{2}/.exec(trimmed);
  if (isoMatch) {
    return Number(isoMatch[1]);
  }
  const slashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(trimmed);
  if (slashMatch) {
    return Number(slashMatch[3]);
  }
  return null;
}

function buildElectionCycleYearSet(rows: readonly TexasCandidateFinanceDueRow[]): Set<number> {
  const years = new Set<number>();
  for (const row of rows) {
    years.add(row.electionYear - 1);
    years.add(row.electionYear);
  }
  return years;
}

function isDateInAnyElectionCycle(rawDate: string, electionCycleYears: ReadonlySet<number>): boolean {
  const year = parseTexasTecDateYear(rawDate);
  return year !== null && electionCycleYears.has(year);
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

function candidateRowNameKeys(row: TexasTecCandidateRow): Set<string> {
  const keys = new Set<string>();
  const structuredName = [row.candidateNameFirst, row.candidateNameLast].filter(Boolean).join(" ");
  for (const key of normalizeTexasCandidateNameKeys(structuredName)) {
    keys.add(key);
  }
  for (const key of normalizeTexasCandidateNameKeys(row.candidateNameOrganization)) {
    keys.add(key);
  }
  return keys;
}

function buildTexasCandidateRowPredicate(rows: readonly TexasCandidateFinanceDueRow[]): (row: TexasTecCandidateRow) => boolean {
  const dueCandidateNameKeys = new Set<string>();
  const electionCycleYears = buildElectionCycleYearSet(rows);
  for (const candidate of rows) {
    // VoteApp side of the prefilter expands nicknames; TEC row names stay literal.
    for (const key of normalizeTexasCandidateNameKeys(candidate.candidateName, { expandNicknames: true })) {
      dueCandidateNameKeys.add(key);
    }
  }

  return (row) => {
    if (!isDateInAnyElectionCycle(row.expendDt, electionCycleYears)) {
      return false;
    }
    for (const rowKey of candidateRowNameKeys(row)) {
      if (dueCandidateNameKeys.has(rowKey)) {
        return true;
      }
    }
    return false;
  };
}

function collectCommitteeIdsForContributionLoad(input: {
  dueRows: readonly TexasCandidateFinanceDueRow[];
  candidateRows: readonly TexasTecCandidateRow[];
  receiptCommitteeIdsByCandidateElectionKey?: ReadonlyMap<string, readonly string[]>;
}): string[] {
  const committeeIds = new Set<string>();
  for (const row of input.dueRows) {
    const receiptCommitteeIds = input.receiptCommitteeIdsByCandidateElectionKey?.get(candidateElectionKey(row)) ?? [
      row.committeeId,
    ];
    for (const receiptCommitteeId of receiptCommitteeIds) {
      const committeeId = normalizeId(receiptCommitteeId);
      if (committeeId) {
        committeeIds.add(committeeId);
      }
    }
  }
  for (const row of input.candidateRows) {
    const committeeId = normalizeId(row.filerIdent);
    if (committeeId) {
      committeeIds.add(committeeId);
    }
  }
  return [...committeeIds];
}

function candidateElectionKey(row: Pick<TexasCandidateFinanceDueRow, "candidateId" | "electionId">): string {
  return `${row.candidateId}\u0000${row.electionId}`;
}

function resolveReceiptCommitteeIdsForDueRows(input: {
  dueRows: readonly TexasCandidateFinanceDueRow[];
  filerRows: readonly TexasTecFilerRow[];
  sourceUrl: string;
}): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of input.dueRows) {
    const resolution = resolveTexasCandidateCommittee({
      candidateName: row.candidateName,
      officeScope: row.officeScope,
      officeName: row.officeName,
      electionYear: row.electionYear,
      district: row.district,
      filerRows: input.filerRows,
      sourceUrl: row.sourceUrl ?? input.sourceUrl,
    });
    result.set(
      candidateElectionKey(row),
      resolution.status === "matched" && normalizeId(resolution.committeeId) === normalizeId(row.committeeId)
        ? resolution.receiptCommitteeIds
        : [row.committeeId]
    );
  }
  return result;
}

function collectCommitteeIdsForExpenditureLoad(candidateRows: readonly TexasTecCandidateRow[]): string[] {
  return [...new Set(candidateRows.map((row) => normalizeId(row.filerIdent)).filter(Boolean))];
}

async function loadContributionRows(input: {
  zipPath: string;
  committeeIds: readonly string[];
  dueRows: readonly TexasCandidateFinanceDueRow[];
}): Promise<TexasTecContributionRow[]> {
  const committeeIds = new Set(input.committeeIds.map(normalizeId).filter(Boolean));
  const electionCycleYears = buildElectionCycleYearSet(input.dueRows);
  const rows: TexasTecContributionRow[] = [];
  for (const fileName of await listTexasTecContributionCsvFileNames(input.zipPath)) {
    const fileRows = await readTexasTecContributionRows({
      zipPath: input.zipPath,
      fileName,
      predicate: (row) =>
        committeeIds.has(normalizeId(row.filerIdent)) &&
        isDateInAnyElectionCycle(row.contributionDt, electionCycleYears),
    });
    for (const row of fileRows) {
      rows.push(row);
    }
  }
  return rows;
}

async function loadExpenditureRows(input: {
  zipPath: string;
  committeeIds: readonly string[];
  dueRows: readonly TexasCandidateFinanceDueRow[];
}): Promise<TexasTecExpenditureRow[]> {
  const committeeIds = new Set(input.committeeIds.map(normalizeId).filter(Boolean));
  const electionCycleYears = buildElectionCycleYearSet(input.dueRows);
  const rows: TexasTecExpenditureRow[] = [];
  for (const fileName of await listTexasTecExpenditureCsvFileNames(input.zipPath)) {
    const fileRows = await readTexasTecExpenditureRows({
      zipPath: input.zipPath,
      fileName,
      predicate: (row) =>
        committeeIds.has(normalizeId(row.filerIdent)) &&
        isDateInAnyElectionCycle(row.expendDt, electionCycleYears),
    });
    for (const row of fileRows) {
      rows.push(row);
    }
  }
  return rows;
}

async function loadTexasTecDataForDueRows(input: {
  dueRows: readonly TexasCandidateFinanceDueRow[];
  rawDataZipPath?: string;
  rawDataCacheDir?: string;
}): Promise<TexasTecDataForBatchSync> {
  const cacheDir =
    input.rawDataCacheDir ??
    (process.env.TEXAS_TEC_CSV_DATABASE_CACHE_DIR?.trim() ||
      DEFAULT_TEXAS_TEC_CSV_DATABASE_CACHE_DIR);
  const paths = getTexasTecCsvDatabaseArtifactCachePaths(cacheDir);
  const zipPath = input.rawDataZipPath ?? paths.zipPath;
  if (!(await fileExists(zipPath))) {
    throw new Error(`Texas TEC CSV database ZIP not found: ${zipPath}`);
  }

  const metadata = input.rawDataZipPath
    ? null
    : await readTexasTecCsvDatabaseArtifactCacheMetadata(paths.metadataPath);
  const sourceUrl = metadata?.remote.url ?? TEXAS_TEC_CSV_DATABASE_URL;
  const filerRows = await readTexasTecFilerRows({ zipPath });
  const receiptCommitteeIdsByCandidateElectionKey = resolveReceiptCommitteeIdsForDueRows({
    dueRows: input.dueRows,
    filerRows,
    sourceUrl,
  });
  const targetCandidateRows = await readTexasTecCandidateRows({
    zipPath,
    predicate: buildTexasCandidateRowPredicate(input.dueRows),
  });
  // CAND repeats the full expense for every beneficiary. Retain all siblings
  // of target expenses, including candidates outside this batch, so an
  // unallocated shared expense cannot look like single-candidate support.
  const expenseKey = (row: TexasTecCandidateRow) =>
    [row.filerIdent, row.reportInfoIdent ?? "", row.expendInfoId].map(normalizeId).join("\0");
  const targetExpenseKeys = new Set(targetCandidateRows.map(expenseKey));
  const candidateRows = targetExpenseKeys.size
    ? await readTexasTecCandidateRows({
        zipPath, predicate: (row) => targetExpenseKeys.has(expenseKey(row)),
      })
    : [];
  const reportKeys = new Set(candidateRows.map((row) =>
    [row.filerIdent, row.reportInfoIdent ?? ""].map(normalizeId).join("\0")
  ));
  const purposeRows = await readTexasTecPurposeRows({
    zipPath,
    predicate: (row) => reportKeys.has([row.filerIdent, row.reportInfoIdent].map(normalizeId).join("\0")),
  });
  const spacCandidateCommitteeIds = new Set<string>();
  for (const row of input.dueRows) {
    const committeeIds = receiptCommitteeIdsByCandidateElectionKey.get(candidateElectionKey(row)) ?? [
      row.committeeId,
    ];
    for (const committeeId of committeeIds) {
      const normalizedCommitteeId = normalizeId(committeeId);
      if (normalizedCommitteeId) {
        spacCandidateCommitteeIds.add(normalizedCommitteeId);
      }
    }
  }
  const spacRows = await readTexasTecSpacRows({
    zipPath,
    predicate: (row) => spacCandidateCommitteeIds.has(normalizeId(row.candidateFilerIdent)),
  });
  const expenditureRows = await loadExpenditureRows({
    zipPath,
    committeeIds: collectCommitteeIdsForExpenditureLoad(candidateRows),
    dueRows: input.dueRows,
  });
  const contributionRows = await loadContributionRows({
    zipPath,
    committeeIds: collectCommitteeIdsForContributionLoad({
      dueRows: input.dueRows,
      candidateRows,
      receiptCommitteeIdsByCandidateElectionKey,
    }),
    dueRows: input.dueRows,
  });

  return {
    zipPath,
    sourceUrl,
    contributionRows,
    candidateRows,
    expenditureRows,
    filerRows,
    spacRows,
    purposeRows,
    receiptCommitteeIdsByCandidateElectionKey,
  };
}

async function loadTexasTecFilerData(input: {
  rawDataZipPath?: string;
  rawDataCacheDir?: string;
  tecData?: TexasTecDataForBatchSync;
}): Promise<{ filerRows: TexasTecFilerRow[]; sourceUrl: string }> {
  if (input.tecData) {
    return {
      filerRows: input.tecData.filerRows,
      sourceUrl: input.tecData.sourceUrl,
    };
  }

  const cacheDir =
    input.rawDataCacheDir ??
    (process.env.TEXAS_TEC_CSV_DATABASE_CACHE_DIR?.trim() ||
      DEFAULT_TEXAS_TEC_CSV_DATABASE_CACHE_DIR);
  const paths = getTexasTecCsvDatabaseArtifactCachePaths(cacheDir);
  const zipPath = input.rawDataZipPath ?? paths.zipPath;
  if (!(await fileExists(zipPath))) {
    throw new Error(`Texas TEC CSV database ZIP not found: ${zipPath}`);
  }

  const metadata = input.rawDataZipPath
    ? null
    : await readTexasTecCsvDatabaseArtifactCacheMetadata(paths.metadataPath);
  return {
    filerRows: await readTexasTecFilerRows({ zipPath }),
    sourceUrl: metadata?.remote.url ?? TEXAS_TEC_CSV_DATABASE_URL,
  };
}

export const listDueTexasCandidateFinanceSyncRows = createStandardStateFinanceDueListQuery({
  state: "TX",
  tables: {
    links: "tx_candidate_finance_links",
    summaries: "tx_candidate_finance_summaries",
  },
  eligibleOfficeKeys: TEXAS_FINANCE_ELIGIBLE_OFFICE_KEYS,
});

export async function syncDueTexasCandidateFinance(
  input: TexasCandidateFinanceBatchSyncInput
): Promise<TexasCandidateFinanceBatchSyncResult> {
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
  const syncFn = input.syncTexasCandidateFinanceFn ?? syncTexasCandidateFinance;

  if (!dryRun && input.autoLinkMissingLinks !== false) {
    try {
      const missingLinkCandidates = await listTexasCandidateElectionsMissingFinanceLinks(input.db, {
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
      });
      if (missingLinkCandidates.length > 0) {
        const filerData = await loadTexasTecFilerData({
          rawDataZipPath: input.rawDataZipPath,
          rawDataCacheDir: input.rawDataCacheDir,
          tecData: input.tecData,
        });
        const autoLinkResults = await autoLinkMissingTexasCandidateFinanceLinks({
          db: input.db,
          now,
          maxCandidates,
          electionLookbackDays,
          electionLookaheadDays,
          filerRows: filerData.filerRows,
          sourceUrl: filerData.sourceUrl,
          candidateElections: missingLinkCandidates,
        });
        for (const result of autoLinkResults) {
          if (result.status !== "linked") {
            console.warn("Texas finance auto-link did not link candidate election:", result);
          }
        }
      }
    } catch (error) {
      console.warn(
        "Texas finance auto-link skipped; continuing with already-linked candidate sync:",
        error instanceof Error ? error.message : error
      );
    }
  }

  const due = await listDueTexasCandidateFinanceSyncRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
  });

  let tecData: TexasTecDataForBatchSync | null = null;
  let loadError: string | null = null;
  if (due.rows.length > 0) {
    try {
      tecData =
        input.tecData ??
        (await loadTexasTecDataForDueRows({
          dueRows: due.rows,
          rawDataZipPath: input.rawDataZipPath,
          rawDataCacheDir: input.rawDataCacheDir,
        }));
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    }
  }

  const results: TexasCandidateFinanceBatchSyncItemResult[] = [];
  for (const row of due.rows) {
    if (loadError || !tecData) {
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        committeeId: row.committeeId,
        ok: false,
        error: loadError ?? "Texas TEC data was not loaded",
      });
      continue;
    }

    try {
      const receiptCommitteeIds = tecData.receiptCommitteeIdsByCandidateElectionKey.get(candidateElectionKey(row));
      const result = await syncFn({
        db: input.db,
        candidateId: row.candidateId,
        electionId: row.electionId,
        candidateName: row.candidateName,
        electionYear: row.electionYear,
        officeScope: row.officeScope,
        officeName: row.officeName,
        district: row.district,
        sourceUrl: row.sourceUrl ?? tecData.sourceUrl,
        contributionSourceUrl: tecData.sourceUrl,
        outsideSourceUrl: tecData.sourceUrl,
        filerRows: [],
        committeeRegistryRows: tecData.filerRows,
        purposeRows: tecData.purposeRows,
        contributionRows: tecData.contributionRows,
        candidateRows: tecData.candidateRows,
        expenditureRows: tecData.expenditureRows,
        spacRows: tecData.spacRows,
        trustedCommittee: {
          committeeId: row.committeeId,
          committeeName: row.committeeName,
          ...(receiptCommitteeIds ? { receiptCommitteeIds } : {}),
          sourceUrl: row.sourceUrl ?? tecData.sourceUrl,
        },
        financeIndustryClassifier: input.financeIndustryClassifier,
        aiClassificationMinAmount: input.aiClassificationMinAmount,
        dryRun,
        now,
      });
      if (result.outsideIdentityConflict) {
        console.warn(
          "Texas finance sync refused candidate election after conflicting first-name identities in outside-spending rows; previous snapshot preserved:",
          { candidateId: row.candidateId, electionId: row.electionId, committeeId: row.committeeId }
        );
      }
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
