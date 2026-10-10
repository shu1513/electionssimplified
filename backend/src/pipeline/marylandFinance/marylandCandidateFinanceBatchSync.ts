import { stat } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";

import { mergeCycleArtifactRows } from "../finance/cycleArtifactRows.js";
import type { FinanceIndustryClassifier } from "../finance/financeIndustryClassificationService.js";
import {
  autoLinkMissingMarylandCandidateFinanceLinks,
  buildMarylandCandidateNamePredicate,
  listMarylandCandidateElectionsMissingFinanceLinks,
  type MarylandFinanceAutoLinkCandidateElection,
} from "./marylandCandidateCommitteeAutoLinker.js";
import {
  syncMarylandCandidateFinance,
  type MarylandCandidateFinanceSyncResult,
} from "./marylandCandidateFinanceSync.js";
import { normalizeMarylandCandidateNameKeys } from "./marylandCandidateCommitteeResolver.js";
import {
  DEFAULT_MARYLAND_CFS_CACHE_DIR,
  getMarylandCfsArtifactCachePaths,
  readMarylandCfsArtifactCacheMetadata,
} from "./marylandCfsArtifactCache.js";
import {
  MARYLAND_CFS_PUBLIC_EXPORT_API_URL,
} from "./marylandCfsClient.js";
import {
  MARYLAND_CFS_COMMITTEE_COLUMNS,
  MARYLAND_CFS_CONTRIBUTION_COLUMNS,
  MARYLAND_CFS_EXPENDITURE_COLUMNS,
  readMarylandCfsCommitteeRows,
  readMarylandCfsContributionRows,
  readMarylandCfsExpenditureRows,
  type MarylandCfsCommitteeRow,
  type MarylandCfsContributionRow,
  type MarylandCfsExpenditureRow,
} from "./marylandCfsArtifactReader.js";
import {
  createStandardStateFinanceDueListQuery,
  type StandardStateFinanceDueRow,
} from "../finance/standardStateFinanceDueListQuery.js";
import { MARYLAND_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./marylandFinanceEligibleOffices.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & {
  connect: () => Promise<PoolClient>;
};

export type MarylandCandidateFinanceDueRow = StandardStateFinanceDueRow;

export type MarylandCommitteeDataForYear = {
  year: number;
  filePath: string;
  sourceUrl: string;
  rows: MarylandCfsCommitteeRow[];
};

export type MarylandContributionDataForYear = {
  year: number;
  filePath: string;
  sourceUrl: string;
  rowsByCommitteeId: Map<string, MarylandCfsContributionRow[]>;
};

export type MarylandExpenditureDataForYear = {
  year: number;
  filePath: string;
  sourceUrl: string;
  rows: MarylandCfsExpenditureRow[];
};

export type MarylandCandidateFinanceBatchSyncInput = {
  db: ConnectableQueryable;
  now?: Date;
  dryRun?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  rawDataCacheDir?: string;
  autoLinkMissingLinks?: boolean;
  committeeDataByYear?: ReadonlyMap<number, MarylandCommitteeDataForYear>;
  contributionDataByYear?: ReadonlyMap<number, MarylandContributionDataForYear>;
  expenditureDataByYear?: ReadonlyMap<number, MarylandExpenditureDataForYear>;
  financeIndustryClassifier?: FinanceIndustryClassifier;
  aiClassificationMinAmount?: number;
  syncMarylandCandidateFinanceFn?: typeof syncMarylandCandidateFinance;
};

export type MarylandCandidateFinanceBatchSyncItemResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  committeeId: string;
  ok: boolean;
  result?: MarylandCandidateFinanceSyncResult;
  error?: string;
};

export type MarylandCandidateFinanceBatchSyncResult = {
  dryRun: boolean;
  now: string;
  staleAfterDays: number;
  maxCandidates: number;
  dueCandidateCount: number;
  selectedCandidateCount: number;
  syncedCandidateCount: number;
  failedCandidateCount: number;
  results: MarylandCandidateFinanceBatchSyncItemResult[];
};

const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_STALE_AFTER_DAYS = 7;
const DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS = 1;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

function assertValidDate(date: Date, label: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid Maryland finance batch sync ${label}`);
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Maryland finance batch sync ${label}: ${value}`);
  }
  return normalized;
}

function normalizeCommitteeId(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
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

function groupDueRowsByYear(rows: readonly MarylandCandidateFinanceDueRow[]): Map<number, MarylandCandidateFinanceDueRow[]> {
  const byYear = new Map<number, MarylandCandidateFinanceDueRow[]>();
  for (const row of rows) {
    const yearRows = byYear.get(row.electionYear) ?? [];
    yearRows.push(row);
    byYear.set(row.electionYear, yearRows);
  }
  return byYear;
}

function groupAutoLinkCandidatesByYear(
  rows: readonly MarylandFinanceAutoLinkCandidateElection[]
): Map<number, MarylandFinanceAutoLinkCandidateElection[]> {
  const byYear = new Map<number, MarylandFinanceAutoLinkCandidateElection[]>();
  for (const row of rows) {
    const yearRows = byYear.get(row.electionYear) ?? [];
    yearRows.push(row);
    byYear.set(row.electionYear, yearRows);
  }
  return byYear;
}

function groupContributionRowsByCommittee(
  rows: readonly MarylandCfsContributionRow[]
): Map<string, MarylandCfsContributionRow[]> {
  const byCommittee = new Map<string, MarylandCfsContributionRow[]>();
  for (const row of rows) {
    const committeeId = normalizeCommitteeId(row["Filing Entity Id"]);
    if (!committeeId) {
      continue;
    }
    const existing = byCommittee.get(committeeId) ?? [];
    existing.push(row);
    byCommittee.set(committeeId, existing);
  }
  return byCommittee;
}

function buildMarylandExpenditureCandidatePredicate(
  rows: readonly MarylandCandidateFinanceDueRow[]
): (row: MarylandCfsExpenditureRow) => boolean {
  const candidateNameKeys = new Set<string>();
  for (const candidate of rows) {
    for (const key of normalizeMarylandCandidateNameKeys(candidate.candidateName)) {
      candidateNameKeys.add(key);
    }
  }

  return (row) => {
    for (const rowKey of normalizeMarylandCandidateNameKeys(row["Candidate/Ballot Issue"])) {
      if (candidateNameKeys.has(rowKey)) {
        return true;
      }
    }
    return false;
  };
}

function collectCommitteeIdsForContributionLoad(input: {
  dueRows: readonly MarylandCandidateFinanceDueRow[];
  expenditureRows?: readonly MarylandCfsExpenditureRow[];
}): string[] {
  const committeeIds = new Set<string>();
  for (const row of input.dueRows) {
    const committeeId = normalizeCommitteeId(row.committeeId);
    if (committeeId) {
      committeeIds.add(committeeId);
    }
  }
  for (const row of input.expenditureRows ?? []) {
    const committeeId = normalizeCommitteeId(row["Filing Entity Id"]);
    if (committeeId) {
      committeeIds.add(committeeId);
    }
  }
  return [...committeeIds];
}

function flattenContributionDataRows(
  contributionData: MarylandContributionDataForYear | undefined
): MarylandCfsContributionRow[] {
  return contributionData ? [...contributionData.rowsByCommitteeId.values()].flat() : [];
}

function rawDataCacheDir(inputCacheDir?: string): string {
  return inputCacheDir ?? (process.env.MARYLAND_CFS_RAW_DATA_CACHE_DIR?.trim() || DEFAULT_MARYLAND_CFS_CACHE_DIR);
}

function sourceUrlFromMetadata(input: {
  metadataUrl?: string | null;
}): string {
  return input.metadataUrl ?? MARYLAND_CFS_PUBLIC_EXPORT_API_URL;
}

function marylandCycleFilingYears(electionYear: number): number[] {
  return [electionYear - 1, electionYear];
}

// The CFS committee export for a filing year lists only committees REGISTERED
// that year. Incumbents registered long ago ("Moore, Wes For Maryland",
// April 2021) never appear in the cycle's two files, so committee rows are
// read from every registration year since the previous cycle. Files older
// than the cycle may be absent from the cache; only the cycle's own two are
// required.
const MARYLAND_COMMITTEE_REGISTRATION_LOOKBACK_YEARS = 6;

function marylandCommitteeRegistrationYears(electionYear: number): number[] {
  const years: number[] = [];
  for (let year = electionYear - MARYLAND_COMMITTEE_REGISTRATION_LOOKBACK_YEARS; year <= electionYear; year += 1) {
    years.push(year);
  }
  return years;
}

function marylandRowIdentity<Row extends Record<string, string>>(
  row: Row,
  columns: readonly string[]
): string {
  return JSON.stringify(columns.map((column) => row[column] ?? ""));
}

async function readCycleArtifactData<Row>(input: {
  electionYear: number;
  artifactKind: "committees" | "contributions" | "expenditures";
  rawDataCacheDir?: string;
  readRows: (filePath: string) => Promise<Row[]>;
  rowIdentity: (row: Row) => string;
}): Promise<{ rows: Row[]; filePath: string; sourceUrl: string }> {
  const kindLabel = input.artifactKind === "committees" ? "committee" : input.artifactKind.slice(0, -1);
  const artifactRowsByYear: Row[][] = [];
  let filePath = "";
  let sourceUrl = MARYLAND_CFS_PUBLIC_EXPORT_API_URL;
  let foundMatchingRows = false;
  const filingYears =
    input.artifactKind === "committees"
      ? marylandCommitteeRegistrationYears(input.electionYear)
      : marylandCycleFilingYears(input.electionYear);
  const requiredYears = new Set(marylandCycleFilingYears(input.electionYear));
  for (const filingYear of filingYears) {
    const paths = getMarylandCfsArtifactCachePaths({
      cacheDir: rawDataCacheDir(input.rawDataCacheDir),
      filingYear,
      artifactKind: input.artifactKind,
    });
    if (!(await fileExists(paths.filePath))) {
      if (!requiredYears.has(filingYear)) {
        continue;
      }
      throw new Error(`Maryland CFS ${kindLabel} artifact not found for ${filingYear}: ${paths.filePath}`);
    }
    const metadata = await readMarylandCfsArtifactCacheMetadata(paths.metadataPath);
    const artifactRows = await input.readRows(paths.filePath);
    artifactRowsByYear.push(artifactRows);
    if (!foundMatchingRows) {
      filePath = paths.filePath;
      sourceUrl = sourceUrlFromMetadata({ metadataUrl: metadata?.remote.url });
      foundMatchingRows = artifactRows.length > 0;
    }
  }
  return {
    rows: mergeCycleArtifactRows({ artifacts: artifactRowsByYear, rowIdentity: input.rowIdentity }),
    filePath,
    sourceUrl,
  };
}

async function loadCommitteeDataForYear(input: {
  year: number;
  rawDataCacheDir?: string;
  predicate?: (row: MarylandCfsCommitteeRow) => boolean;
}): Promise<MarylandCommitteeDataForYear> {
  const data = await readCycleArtifactData<MarylandCfsCommitteeRow>({
    electionYear: input.year,
    artifactKind: "committees",
    rawDataCacheDir: input.rawDataCacheDir,
    rowIdentity: (row) => marylandRowIdentity(row, MARYLAND_CFS_COMMITTEE_COLUMNS),
    readRows: (filePath) => readMarylandCfsCommitteeRows({ filePath, predicate: input.predicate }),
  });
  return {
    year: input.year,
    filePath: data.filePath,
    sourceUrl: data.sourceUrl,
    rows: data.rows,
  };
}

async function loadAutoLinkCommitteeRowsForYear(input: {
  year: number;
  candidates: readonly MarylandFinanceAutoLinkCandidateElection[];
  rawDataCacheDir?: string;
  committeeDataByYear?: ReadonlyMap<number, MarylandCommitteeDataForYear>;
}): Promise<{ rows: MarylandCfsCommitteeRow[]; sourceUrl: string }> {
  const injected = input.committeeDataByYear?.get(input.year);
  if (injected) {
    return {
      rows: injected.rows,
      sourceUrl: injected.sourceUrl,
    };
  }

  const data = await loadCommitteeDataForYear({
    year: input.year,
    rawDataCacheDir: input.rawDataCacheDir,
    predicate: buildMarylandCandidateNamePredicate(input.candidates),
  });
  return { rows: data.rows, sourceUrl: data.sourceUrl };
}

async function loadContributionDataForYear(input: {
  year: number;
  committeeIds: readonly string[];
  rawDataCacheDir?: string;
}): Promise<MarylandContributionDataForYear> {
  const normalizedCommitteeIds = new Set(input.committeeIds.map(normalizeCommitteeId).filter(Boolean));
  const data = await readCycleArtifactData<MarylandCfsContributionRow>({
    electionYear: input.year,
    artifactKind: "contributions",
    rawDataCacheDir: input.rawDataCacheDir,
    rowIdentity: (row) => marylandRowIdentity(row, MARYLAND_CFS_CONTRIBUTION_COLUMNS),
    readRows: (filePath) =>
      readMarylandCfsContributionRows({
        filePath,
        predicate: (row) => normalizedCommitteeIds.has(normalizeCommitteeId(row["Filing Entity Id"])),
      }),
  });

  return {
    year: input.year,
    filePath: data.filePath,
    sourceUrl: data.sourceUrl,
    rowsByCommitteeId: groupContributionRowsByCommittee(data.rows),
  };
}

async function loadExpenditureDataForYear(input: {
  year: number;
  dueRows: readonly MarylandCandidateFinanceDueRow[];
  rawDataCacheDir?: string;
}): Promise<MarylandExpenditureDataForYear> {
  const data = await readCycleArtifactData<MarylandCfsExpenditureRow>({
    electionYear: input.year,
    artifactKind: "expenditures",
    rawDataCacheDir: input.rawDataCacheDir,
    rowIdentity: (row) => marylandRowIdentity(row, MARYLAND_CFS_EXPENDITURE_COLUMNS),
    readRows: (filePath) =>
      readMarylandCfsExpenditureRows({
        filePath,
        predicate: buildMarylandExpenditureCandidatePredicate(input.dueRows),
      }),
  });
  return {
    year: input.year,
    filePath: data.filePath,
    sourceUrl: data.sourceUrl,
    rows: data.rows,
  };
}

export const listDueMarylandCandidateFinanceSyncRows = createStandardStateFinanceDueListQuery({
  state: "MD",
  tables: {
    links: "md_candidate_finance_links",
    summaries: "md_candidate_finance_summaries",
  },
  eligibleOfficeKeys: MARYLAND_FINANCE_ELIGIBLE_OFFICE_KEYS,
});

export async function syncDueMarylandCandidateFinance(
  input: MarylandCandidateFinanceBatchSyncInput
): Promise<MarylandCandidateFinanceBatchSyncResult> {
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
  const syncFn = input.syncMarylandCandidateFinanceFn ?? syncMarylandCandidateFinance;

  if (!dryRun && input.autoLinkMissingLinks !== false) {
    try {
      const missingLinkCandidates = await listMarylandCandidateElectionsMissingFinanceLinks(input.db, {
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
      });
      const committeeRowsByYear = new Map<number, readonly MarylandCfsCommitteeRow[]>();
      const sourceUrlByYear = new Map<number, string>();
      const skippedAutoLinkYears = new Map<number, string>();
      for (const [year, candidates] of groupAutoLinkCandidatesByYear(missingLinkCandidates).entries()) {
        try {
          const data = await loadAutoLinkCommitteeRowsForYear({
            year,
            candidates,
            rawDataCacheDir: input.rawDataCacheDir,
            committeeDataByYear: input.committeeDataByYear,
          });
          committeeRowsByYear.set(year, data.rows);
          sourceUrlByYear.set(year, data.sourceUrl);
        } catch (error) {
          skippedAutoLinkYears.set(year, error instanceof Error ? error.message : String(error));
        }
      }
      const autoLinkCandidates = missingLinkCandidates.filter((candidate) =>
        committeeRowsByYear.has(candidate.electionYear)
      );
      const autoLinkResults = await autoLinkMissingMarylandCandidateFinanceLinks({
        db: input.db,
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
        committeeRowsByYear,
        sourceUrlByYear,
        candidateElections: autoLinkCandidates,
      });
      for (const result of autoLinkResults) {
        if (result.status !== "linked") {
          console.warn("Maryland finance auto-link did not link candidate election:", result);
        }
      }
      for (const [year, message] of skippedAutoLinkYears) {
        console.warn(`Maryland finance auto-link skipped year ${year}:`, message);
      }
    } catch (error) {
      console.warn(
        "Maryland finance auto-link skipped; continuing with already-linked candidate sync:",
        error instanceof Error ? error.message : error
      );
    }
  }

  const due = await listDueMarylandCandidateFinanceSyncRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
  });

  const committeeDataByYear = new Map<number, MarylandCommitteeDataForYear>(
    input.committeeDataByYear ? [...input.committeeDataByYear.entries()] : []
  );

  const expenditureDataByYear = new Map<number, MarylandExpenditureDataForYear>(
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
          "Maryland CFS expenditure artifact unavailable; syncing direct finance without outside spending:",
          error instanceof Error ? error.message : error
        );
      }
    }
  }

  const contributionDataByYear = new Map<number, MarylandContributionDataForYear>(
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

  const results: MarylandCandidateFinanceBatchSyncItemResult[] = [];
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
    const committeeData = committeeDataByYear.get(row.electionYear);
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
        committeeRows: committeeData?.rows ?? [],
        committeeSourceUrl: committeeData?.sourceUrl,
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
  };
}
