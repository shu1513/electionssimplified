import { stat } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";

import { mergeCycleArtifactRows } from "../finance/cycleArtifactRows.js";
import type { FinanceIndustryClassifier } from "../finance/financeIndustryClassificationService.js";
import {
  autoLinkMissingMaineCandidateFinanceLinks,
  buildMaineCandidateNamePredicate,
  listMaineCandidateElectionsMissingFinanceLinks,
  type MaineFinanceAutoLinkCandidateElection,
} from "./maineCandidateFinanceAutoLink.js";
import {
  syncMaineCandidateFinance,
  type MaineCandidateFinanceSyncResult,
} from "./maineCandidateFinanceSync.js";
import { normalizeMaineCandidateNameKeys } from "./maineCandidateCommitteeResolver.js";
import {
  DEFAULT_MAINE_CFIS_CACHE_DIR,
  getMaineCfisArtifactCachePaths,
  readMaineCfisArtifactCacheMetadata,
} from "./maineCfisArtifactCache.js";
import { MAINE_CFIS_CSV_DOWNLOAD_API_URL } from "./maineCfisClient.js";
import {
  readMaineCfisContributionRows,
  readMaineCfisExpenditureRows,
  type MaineCfisContributionRow,
  type MaineCfisExpenditureRow,
} from "./maineCfisArtifactReader.js";
import {
  createStandardStateFinanceDueListQuery,
  type StandardStateFinanceDueRow,
} from "../finance/standardStateFinanceDueListQuery.js";
import { MAINE_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./maineFinanceEligibleOffices.js";
import { syncDueMaineMapLightFinance } from "./maineMapLightCandidateFinanceSync.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & {
  connect: () => Promise<PoolClient>;
};

export type MaineCandidateFinanceDueRow = StandardStateFinanceDueRow;

export type MaineContributionDataForYear = {
  year: number;
  filePath: string;
  sourceUrl: string;
  rowsByCommitteeId: Map<string, MaineCfisContributionRow[]>;
};

export type MaineExpenditureDataForYear = {
  year: number;
  filePath: string;
  sourceUrl: string;
  rows: MaineCfisExpenditureRow[];
};

export type MaineCandidateFinanceBatchSyncInput = {
  db: ConnectableQueryable;
  now?: Date;
  dryRun?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  rawDataCacheDir?: string;
  autoLinkMissingLinks?: boolean;
  contributionDataByYear?: ReadonlyMap<number, MaineContributionDataForYear>;
  expenditureDataByYear?: ReadonlyMap<number, MaineExpenditureDataForYear>;
  financeIndustryClassifier?: FinanceIndustryClassifier;
  aiClassificationMinAmount?: number;
  syncMaineCandidateFinanceFn?: typeof syncMaineCandidateFinance;
  /** Legacy replay is explicit; ordinary production runs use the current publisher. */
  sourceMode?: "maplight" | "legacy";
  candidateId?: string;
  electionYear?: number;
  refresh?: boolean;
  /** Reprocess due scope with verified saved-first acquisition, without forcing new bodies. */
  resync?: boolean;
  mapLightReportUrls?: readonly string[];
};

export type MaineCandidateFinanceBatchSyncItemResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  committeeId: string;
  ok: boolean;
  result?: MaineCandidateFinanceSyncResult;
  mapLight?: {
    sourceFilerId: string;
    committeeDonorCount: number;
    committeeDonorAmount: number | null;
    outsideAllocationCount: number;
    knownSupportAmount: number | null;
    knownOpposeAmount: number | null;
    sourceThrough: string;
    omittedPayerCount: number;
    written: boolean;
  };
  error?: string;
};

export type MaineCandidateFinanceBatchSyncResult = {
  dryRun: boolean;
  now: string;
  staleAfterDays: number;
  maxCandidates: number;
  dueCandidateCount: number;
  selectedCandidateCount: number;
  syncedCandidateCount: number;
  failedCandidateCount: number;
  results: MaineCandidateFinanceBatchSyncItemResult[];
};

const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_STALE_AFTER_DAYS = 7;
const DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS = 1;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

function assertValidDate(date: Date, label: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid Maine finance batch sync ${label}`);
  }
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Maine finance batch sync ${label}: ${value}`);
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

function groupDueRowsByYear(
  rows: readonly MaineCandidateFinanceDueRow[],
): Map<number, MaineCandidateFinanceDueRow[]> {
  const byYear = new Map<number, MaineCandidateFinanceDueRow[]>();
  for (const row of rows) {
    const yearRows = byYear.get(row.electionYear) ?? [];
    yearRows.push(row);
    byYear.set(row.electionYear, yearRows);
  }
  return byYear;
}

function groupAutoLinkCandidatesByYear(
  rows: readonly MaineFinanceAutoLinkCandidateElection[],
): Map<number, MaineFinanceAutoLinkCandidateElection[]> {
  const byYear = new Map<number, MaineFinanceAutoLinkCandidateElection[]>();
  for (const row of rows) {
    const yearRows = byYear.get(row.electionYear) ?? [];
    yearRows.push(row);
    byYear.set(row.electionYear, yearRows);
  }
  return byYear;
}

function groupContributionRowsByCommittee(
  rows: readonly MaineCfisContributionRow[],
): Map<string, MaineCfisContributionRow[]> {
  const byCommittee = new Map<string, MaineCfisContributionRow[]>();
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

function buildMaineExpenditureCandidatePredicate(
  rows: readonly MaineCandidateFinanceDueRow[],
): (row: MaineCfisExpenditureRow) => boolean {
  const candidateNameKeys = new Set<string>();
  for (const candidate of rows) {
    for (const key of normalizeMaineCandidateNameKeys(
      candidate.candidateName,
    )) {
      candidateNameKeys.add(key);
    }
  }

  return (row) => {
    for (const rowKey of normalizeMaineCandidateNameKeys(row.Candidate)) {
      if (candidateNameKeys.has(rowKey)) {
        return true;
      }
    }
    return false;
  };
}

function collectCommitteeIdsForContributionLoad(input: {
  dueRows: readonly MaineCandidateFinanceDueRow[];
  expenditureRows?: readonly MaineCfisExpenditureRow[];
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
  contributionData: MaineContributionDataForYear | undefined,
): MaineCfisContributionRow[] {
  return contributionData
    ? [...contributionData.rowsByCommitteeId.values()].flat()
    : [];
}

function rawDataCacheDir(inputCacheDir?: string): string {
  return (
    inputCacheDir ??
    (process.env.MAINE_CFIS_RAW_DATA_CACHE_DIR?.trim() ||
      DEFAULT_MAINE_CFIS_CACHE_DIR)
  );
}

function sourceUrlFromMetadata(input: { metadataUrl?: string | null }): string {
  return input.metadataUrl ?? MAINE_CFIS_CSV_DOWNLOAD_API_URL;
}

async function readValidCacheMetadata(input: {
  year: number;
  artifactKind: "contributions" | "expenditures";
  filePath: string;
  metadataPath: string;
}) {
  const metadata = await readMaineCfisArtifactCacheMetadata(input.metadataPath);
  if (
    !metadata ||
    metadata.artifact.filingYear !== input.year ||
    metadata.artifact.artifactKind !== input.artifactKind ||
    metadata.filePath !== input.filePath ||
    metadata.metadataPath !== input.metadataPath
  ) {
    throw new Error(
      `Maine CFIS ${input.artifactKind} artifact metadata missing or invalid for ${input.year}: ${input.metadataPath}`,
    );
  }
  const fileStat = await stat(input.filePath);
  if (!fileStat.isFile() || fileStat.size !== metadata.bytesWritten) {
    throw new Error(
      `Maine CFIS ${input.artifactKind} artifact does not match metadata for ${input.year}: ${input.filePath}`,
    );
  }
  return metadata;
}

// Maine CFIS bulk files are keyed by RECEIPT year, but a Maine election cycle
// spans [electionYear - 1, electionYear] (the resolver and aggregators already
// filter to that window), so every cache load must read both filing years.
function maineCycleFilingYears(electionYear: number): number[] {
  return [electionYear - 1, electionYear];
}

function maineContributionRowIdentity(row: MaineCfisContributionRow): string {
  const receiptId = row["Receipt ID"].trim().toUpperCase();
  return receiptId
    ? `${normalizeCommitteeId(row.OrgID)}\u0000${receiptId}`
    : "";
}

function maineExpenditureRowIdentity(row: MaineCfisExpenditureRow): string {
  const expenditureId = row["Expenditure ID"].trim().toUpperCase();
  return expenditureId
    ? `${normalizeCommitteeId(row.OrgID)}\u0000${expenditureId}`
    : "";
}

async function readCycleArtifactData<Row>(input: {
  electionYear: number;
  artifactKind: "contributions" | "expenditures";
  rawDataCacheDir?: string;
  readRows: (filePath: string) => Promise<Row[]>;
  rowIdentity: (row: Row) => string;
}): Promise<{ rows: Row[]; filePath: string; sourceUrl: string }> {
  const kindLabel =
    input.artifactKind === "contributions" ? "contribution" : "expenditure";
  const artifactRowsByYear: Row[][] = [];
  let filePath = "";
  let sourceUrl = MAINE_CFIS_CSV_DOWNLOAD_API_URL;
  for (const filingYear of maineCycleFilingYears(input.electionYear)) {
    const paths = getMaineCfisArtifactCachePaths({
      cacheDir: rawDataCacheDir(input.rawDataCacheDir),
      filingYear,
      artifactKind: input.artifactKind,
    });
    if (!(await fileExists(paths.filePath))) {
      throw new Error(
        `Maine CFIS ${kindLabel} artifact not found for ${filingYear}: ${paths.filePath}`,
      );
    }
    const metadata = await readValidCacheMetadata({
      year: filingYear,
      artifactKind: input.artifactKind,
      ...paths,
    });
    artifactRowsByYear.push(await input.readRows(paths.filePath));
    filePath = paths.filePath;
    sourceUrl = sourceUrlFromMetadata({ metadataUrl: metadata?.remote.url });
  }
  return {
    rows: mergeCycleArtifactRows({
      artifacts: artifactRowsByYear,
      rowIdentity: input.rowIdentity,
    }),
    filePath,
    sourceUrl,
  };
}

async function loadContributionDataForYear(input: {
  year: number;
  committeeIds: readonly string[];
  rawDataCacheDir?: string;
}): Promise<MaineContributionDataForYear> {
  const normalizedCommitteeIds = new Set(
    input.committeeIds.map(normalizeCommitteeId).filter(Boolean),
  );
  const data = await readCycleArtifactData({
    electionYear: input.year,
    artifactKind: "contributions",
    rawDataCacheDir: input.rawDataCacheDir,
    rowIdentity: maineContributionRowIdentity,
    readRows: (filePath) =>
      readMaineCfisContributionRows({
        filePath,
        predicate: (row) =>
          normalizedCommitteeIds.has(normalizeCommitteeId(row.OrgID)),
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
  candidates: readonly MaineFinanceAutoLinkCandidateElection[];
  rawDataCacheDir?: string;
  contributionDataByYear?: ReadonlyMap<number, MaineContributionDataForYear>;
}): Promise<{ rows: MaineCfisContributionRow[]; sourceUrl: string }> {
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
    rowIdentity: maineContributionRowIdentity,
    readRows: (filePath) =>
      readMaineCfisContributionRows({
        filePath,
        predicate: buildMaineCandidateNamePredicate(input.candidates),
      }),
  });
  return { rows: data.rows, sourceUrl: data.sourceUrl };
}

async function loadExpenditureDataForYear(input: {
  year: number;
  dueRows: readonly MaineCandidateFinanceDueRow[];
  rawDataCacheDir?: string;
}): Promise<MaineExpenditureDataForYear> {
  const data = await readCycleArtifactData({
    electionYear: input.year,
    artifactKind: "expenditures",
    rawDataCacheDir: input.rawDataCacheDir,
    rowIdentity: maineExpenditureRowIdentity,
    readRows: (filePath) =>
      readMaineCfisExpenditureRows({
        filePath,
        predicate: buildMaineExpenditureCandidatePredicate(input.dueRows),
      }),
  });
  return {
    year: input.year,
    filePath: data.filePath,
    sourceUrl: data.sourceUrl,
    rows: data.rows,
  };
}

export const listDueMaineCandidateFinanceSyncRows =
  createStandardStateFinanceDueListQuery({
    state: "ME",
    tables: {
      links: "me_candidate_finance_links",
      summaries: "me_candidate_finance_summaries",
    },
    eligibleOfficeKeys: MAINE_FINANCE_ELIGIBLE_OFFICE_KEYS,
  });

export async function syncDueMaineCandidateFinance(
  input: MaineCandidateFinanceBatchSyncInput,
): Promise<MaineCandidateFinanceBatchSyncResult> {
  if (input.sourceMode !== "legacy") return syncDueMaineMapLightFinance(input);
  const now = input.now ?? new Date();
  assertValidDate(now, "now");

  const maxCandidates = normalizePositiveInteger(
    input.maxCandidates,
    DEFAULT_MAX_CANDIDATES,
    "maxCandidates",
  );
  const staleAfterDays = normalizePositiveInteger(
    input.staleAfterDays,
    DEFAULT_STALE_AFTER_DAYS,
    "staleAfterDays",
  );
  const electionLookbackDays = normalizePositiveInteger(
    input.electionLookbackDays,
    DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS,
    "electionLookbackDays",
  );
  const electionLookaheadDays = normalizePositiveInteger(
    input.electionLookaheadDays,
    DEFAULT_ELECTION_LOOKAHEAD_DAYS,
    "electionLookaheadDays",
  );
  const dryRun = input.dryRun === true;
  const syncFn = input.syncMaineCandidateFinanceFn ?? syncMaineCandidateFinance;

  if (!dryRun && input.autoLinkMissingLinks !== false) {
    try {
      const missingLinkCandidates =
        await listMaineCandidateElectionsMissingFinanceLinks(input.db, {
          now,
          maxCandidates,
          electionLookbackDays,
          electionLookaheadDays,
        });
      const contributionRowsByYear = new Map<
        number,
        readonly MaineCfisContributionRow[]
      >();
      const sourceUrlByYear = new Map<number, string>();
      const skippedAutoLinkYears = new Map<number, string>();
      for (const [year, candidates] of groupAutoLinkCandidatesByYear(
        missingLinkCandidates,
      ).entries()) {
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
          skippedAutoLinkYears.set(
            year,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      const autoLinkCandidates = missingLinkCandidates.filter((candidate) =>
        contributionRowsByYear.has(candidate.electionYear),
      );
      const autoLinkResults = await autoLinkMissingMaineCandidateFinanceLinks({
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
          console.warn(
            "Maine finance auto-link did not link candidate election:",
            result,
          );
        }
      }
      for (const [year, message] of skippedAutoLinkYears) {
        console.warn(`Maine finance auto-link skipped year ${year}:`, message);
      }
    } catch (error) {
      console.warn(
        "Maine finance auto-link skipped; continuing with already-linked candidate sync:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  const due = await listDueMaineCandidateFinanceSyncRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
    candidateId: input.candidateId,
    electionYear: input.electionYear,
    refresh: input.refresh === true || input.resync === true,
  });
  const expenditureDataByYear = new Map<number, MaineExpenditureDataForYear>(
    input.expenditureDataByYear
      ? [...input.expenditureDataByYear.entries()]
      : [],
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
          }),
        );
      } catch (error) {
        expenditureDataLoadErrorsByYear.set(
          year,
          error instanceof Error ? error.message : String(error),
        );
        console.warn(
          "Maine CFIS expenditure artifact unavailable; syncing direct finance without outside spending:",
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  const contributionDataByYear = new Map<number, MaineContributionDataForYear>(
    input.contributionDataByYear
      ? [...input.contributionDataByYear.entries()]
      : [],
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
          }),
        );
      } catch (error) {
        contributionDataLoadErrorsByYear.set(
          year,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  const results: MaineCandidateFinanceBatchSyncItemResult[] = [];
  for (const row of due.rows) {
    const contributionDataLoadError = contributionDataLoadErrorsByYear.get(
      row.electionYear,
    );
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
        expenditureRows: expenditureDataLoadErrorsByYear.has(row.electionYear)
          ? undefined
          : (expenditureData?.rows ?? []),
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
