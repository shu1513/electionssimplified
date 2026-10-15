import type { Pool, PoolClient } from "pg";

import {
  autoLinkMissingMinnesotaCandidateFinanceLinks,
  buildMinnesotaCandidateNamePredicate,
  listMinnesotaCandidateElectionsMissingFinanceLinks,
  type MinnesotaFinanceAutoLinkCandidateElection,
} from "./minnesotaCandidateFinanceAutoLink.js";
import {
  DEFAULT_MINNESOTA_CAMPAIGN_FINANCE_CACHE_DIR,
  getMinnesotaCampaignFinanceArtifactCachePaths,
  readMinnesotaCampaignFinanceArtifactCacheMetadata,
  resolveMinnesotaCampaignFinanceCachedDownload,
  type MinnesotaCampaignFinanceArtifactCacheMetadata,
  type MinnesotaCampaignFinanceDownloadKey,
} from "./minnesotaCampaignFinanceArtifactCache.js";
import {
  readMinnesotaCampaignFinanceNativeRows,
  type MinnesotaCampaignFinanceSourceFacts,
  type MinnesotaCampaignFinanceCsvRow,
} from "./minnesotaCampaignFinanceArtifactReader.js";
import {
  createStandardStateFinanceDueListQuery,
  type StandardStateFinanceDueRow,
} from "../finance/standardStateFinanceDueListQuery.js";
import { MINNESOTA_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./minnesotaFinanceEligibleOffices.js";
import {
  syncMinnesotaCandidateFinance,
  type MinnesotaCandidateFinanceSyncResult,
} from "./minnesotaCandidateFinanceSync.js";
import {
  fetchMinnesotaCandidateFinancialSummary,
  type MinnesotaCandidateFinancialSummary,
} from "./minnesotaCandidateFinancialSummaryClient.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & Pick<Pool, "connect">;

export type MinnesotaCandidateFinanceDueRow = StandardStateFinanceDueRow;

export type MinnesotaCandidateFinanceBatchSyncInput = {
  db: ConnectableQueryable;
  now?: Date;
  dryRun?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  rawDataCacheDir?: string;
  autoLinkMissingLinks?: boolean;
  contributionRows?: readonly MinnesotaCampaignFinanceCsvRow[];
  expenditureRows?: readonly MinnesotaCampaignFinanceCsvRow[];
  outsideContributionRows?: readonly MinnesotaCampaignFinanceCsvRow[];
  contributionSourceUrl?: string | null;
  expenditureSourceUrl?: string | null;
  outsideSourceUrl?: string | null;
  syncMinnesotaCandidateFinanceFn?: typeof syncMinnesotaCandidateFinance;
  fetchMinnesotaCandidateFinancialSummaryFn?: typeof fetchMinnesotaCandidateFinancialSummary;
};

export type MinnesotaCandidateFinanceBatchSyncItemResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  committeeId: string;
  ok: boolean;
  result?: MinnesotaCandidateFinanceSyncResult;
  error?: string;
};

export type MinnesotaCandidateFinanceBatchSyncResult = {
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
  results: MinnesotaCandidateFinanceBatchSyncItemResult[];
};

const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_STALE_AFTER_DAYS = 7;
const DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS = 1;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

function assertValidDate(date: Date, label: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid Minnesota finance batch sync ${label}`);
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Minnesota finance batch sync ${label}: ${value}`);
  }
  return normalized;
}

function normalizeCommitteeId(value: string): string {
  return value.trim().toUpperCase();
}

function groupDueRowsByElectionYear(rows: readonly MinnesotaCandidateFinanceDueRow[]): Map<number, MinnesotaCandidateFinanceDueRow[]> {
  const byYear = new Map<number, MinnesotaCandidateFinanceDueRow[]>();
  for (const row of rows) {
    const existing = byYear.get(row.electionYear) ?? [];
    existing.push(row);
    byYear.set(row.electionYear, existing);
  }
  return byYear;
}

function collectCommitteeIds(rows: readonly MinnesotaCandidateFinanceDueRow[]): string[] {
  const committeeIds = new Set<string>();
  for (const row of rows) {
    const committeeId = normalizeCommitteeId(row.committeeId);
    if (committeeId) {
      committeeIds.add(committeeId);
    }
  }
  return [...committeeIds];
}

function collectOutsideSpenderCommitteeIds(rows: readonly MinnesotaCampaignFinanceCsvRow[]): string[] {
  const committeeIds = new Set<string>();
  for (const row of rows) {
    const committeeId = normalizeCommitteeId(
      row["Spender Reg Num"] ?? row["Spender reg num"] ?? row["Spender ID"] ?? ""
    );
    if (committeeId) {
      committeeIds.add(committeeId);
    }
  }
  return [...committeeIds];
}

type PinnedMinnesotaCache = {
  cacheDir: string;
  metadata: MinnesotaCampaignFinanceArtifactCacheMetadata | null;
};

type LoadedMinnesotaRows = {
  rows: readonly MinnesotaCampaignFinanceCsvRow[];
  sourceUrl: string;
  observedAt: string;
  sourceFacts: MinnesotaCampaignFinanceSourceFacts;
};

async function loadMinnesotaNativeRows(input: {
  cache: PinnedMinnesotaCache;
  key: MinnesotaCampaignFinanceDownloadKey;
  predicate: (row: MinnesotaCampaignFinanceCsvRow) => boolean;
}): Promise<LoadedMinnesotaRows> {
  if (!input.cache.metadata) throw new Error("Minnesota campaign finance cache metadata unavailable");
  const entry = resolveMinnesotaCampaignFinanceCachedDownload({
    cacheDir: input.cache.cacheDir, metadata: input.cache.metadata, key: input.key,
  });
  const loaded = await readMinnesotaCampaignFinanceNativeRows({
    filePath: entry.outputPath, key: input.key, expectedSha256: entry.sha256,
    expectedBytes: entry.bytesWritten, predicate: input.predicate,
  });
  return { ...loaded, sourceUrl: entry.remote.url,
    observedAt: entry.completedAt ?? input.cache.metadata.downloadedAt };
}

export const listDueMinnesotaCandidateFinanceSyncRows = createStandardStateFinanceDueListQuery({
  state: "MN",
  tables: {
    links: "mn_candidate_finance_links",
    summaries: "mn_candidate_finance_summaries",
  },
  eligibleOfficeKeys: MINNESOTA_FINANCE_ELIGIBLE_OFFICE_KEYS,
});

export async function syncDueMinnesotaCandidateFinance(
  input: MinnesotaCandidateFinanceBatchSyncInput
): Promise<MinnesotaCandidateFinanceBatchSyncResult> {
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
  const syncFn = input.syncMinnesotaCandidateFinanceFn ?? syncMinnesotaCandidateFinance;
  const fetchFinancialSummaryFn =
    input.fetchMinnesotaCandidateFinancialSummaryFn ?? fetchMinnesotaCandidateFinancialSummary;
  let autoLinkAttemptedCount = 0;
  let autoLinkLinkedCount = 0;

  // One publication pointer for the entire batch. A refresh may publish another
  // generation, but cannot mix this batch's receipt, IE and funder originals.
  const cachePaths = getMinnesotaCampaignFinanceArtifactCachePaths(input.rawDataCacheDir ??
    (process.env.MINNESOTA_CAMPAIGN_FINANCE_CACHE_DIR?.trim() || DEFAULT_MINNESOTA_CAMPAIGN_FINANCE_CACHE_DIR));
  let cacheMetadata: MinnesotaCampaignFinanceArtifactCacheMetadata | null = null;
  if (input.contributionRows === undefined || input.expenditureRows === undefined || input.outsideContributionRows === undefined) {
    try { cacheMetadata = await readMinnesotaCampaignFinanceArtifactCacheMetadata(cachePaths.metadataPath); }
    catch { /* Each unavailable component preserves its existing snapshot. */ }
  }
  const cache: PinnedMinnesotaCache = { cacheDir: cachePaths.cacheDir, metadata: cacheMetadata };

  let contributionRowsForAutoLink = input.contributionRows;
  let contributionSourceUrl = input.contributionSourceUrl ?? null;

  if (input.contributionRows === undefined && !dryRun && input.autoLinkMissingLinks !== false) {
    try {
      const missingLinkCandidates = await listMinnesotaCandidateElectionsMissingFinanceLinks(input.db, {
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
      });
      autoLinkAttemptedCount = missingLinkCandidates.length;
      if (missingLinkCandidates.length > 0) {
        const loaded = await loadMinnesotaNativeRows({
          cache, key: "contributions_received", predicate: buildMinnesotaCandidateNamePredicate(missingLinkCandidates),
        });
        contributionRowsForAutoLink = loaded.rows;
        contributionSourceUrl = loaded.sourceUrl;
      } else {
        contributionRowsForAutoLink = [];
      }

      const autoLinkResults = await autoLinkMissingMinnesotaCandidateFinanceLinks({
        db: input.db,
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
        candidateElections: missingLinkCandidates,
        contributionRows: contributionRowsForAutoLink ?? [],
        sourceUrl: contributionSourceUrl,
      });
      autoLinkLinkedCount = autoLinkResults.filter((result) => result.status === "linked").length;
      for (const result of autoLinkResults) {
        if (result.status !== "linked") {
          console.warn("Minnesota finance auto-link did not link candidate election:", result);
        }
      }
    } catch (error) {
      console.warn(
        "Minnesota finance auto-link skipped; continuing with already-linked candidate sync:",
        error instanceof Error ? error.message : error
      );
    }
  }

  const due = await listDueMinnesotaCandidateFinanceSyncRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
  });

  // Already linked candidates need their own recipient-ID load even when no
  // missing candidate names required auto-linking.
  let contributionRowsForBatch = input.contributionRows;
  let contributionOriginal: LoadedMinnesotaRows | undefined;
  if (contributionRowsForBatch === undefined && due.rows.length > 0) {
    try {
      const committeeIds = new Set(collectCommitteeIds(due.rows));
      contributionOriginal = await loadMinnesotaNativeRows({
        cache, key: "contributions_received",
        predicate: (row) => committeeIds.has(normalizeCommitteeId(row["Recipient reg num"] ?? "")),
      });
      contributionRowsForBatch = contributionOriginal.rows;
      contributionSourceUrl = contributionOriginal.sourceUrl;
    } catch {
      console.warn("Minnesota campaign finance receipts unavailable; preserving reported committee cash");
    }
  }

  let expenditureRowsForBatch = input.expenditureRows;
  let expenditureSourceUrl = input.expenditureSourceUrl ?? null;
  if (expenditureRowsForBatch === undefined) {
    try {
      if (due.rows.length > 0) {
        const committeeIds = new Set(collectCommitteeIds(due.rows));
        const loaded = await loadMinnesotaNativeRows({
          cache, key: "independent_expenditures",
          predicate: (row) => committeeIds.has(normalizeCommitteeId(row["Affected Cmte Reg Num"] ?? "")),
        });
        expenditureRowsForBatch = loaded.rows;
        expenditureSourceUrl = loaded.sourceUrl;
      } else {
        expenditureRowsForBatch = [];
      }
    } catch (error) {
      console.warn(
        "Minnesota campaign finance expenditure artifact unavailable; syncing candidate links without outside spending:",
        error instanceof Error ? error.message : error
      );
      expenditureRowsForBatch = undefined;
    }
  }

  let outsideContributionRowsForBatch = input.outsideContributionRows;
  let outsideContributionSourceUrl = input.outsideSourceUrl ?? null;
  if (outsideContributionRowsForBatch === undefined && expenditureRowsForBatch !== undefined) {
    try {
      const outsideCommitteeIds = collectOutsideSpenderCommitteeIds(expenditureRowsForBatch);
      if (outsideCommitteeIds.length > 0) {
        const committeeIds = new Set(outsideCommitteeIds);
        const loaded = await loadMinnesotaNativeRows({
          cache, key: "independent_expenditure_contributions",
          predicate: (row) => committeeIds.has(normalizeCommitteeId(row["Recipient reg num"] ?? "")),
        });
        outsideContributionRowsForBatch = loaded.rows;
        outsideContributionSourceUrl = loaded.sourceUrl;
      } else {
        outsideContributionRowsForBatch = [];
      }
    } catch (error) {
      console.warn(
        "Minnesota campaign finance IE contributor artifact unavailable; syncing candidate links without industry backtrace:",
        error instanceof Error ? error.message : error
      );
      outsideContributionRowsForBatch = undefined;
    }
  }

  const results: MinnesotaCandidateFinanceBatchSyncItemResult[] = [];
  const financialSummaryRequests = new Map<string, Promise<MinnesotaCandidateFinancialSummary | null>>();
  for (const row of due.rows) {
    let financialSummary: MinnesotaCandidateFinancialSummary | undefined;
    try {
      const requestKey = `${normalizeCommitteeId(row.committeeId)}:${row.electionYear}`;
      let financialSummaryRequest = financialSummaryRequests.get(requestKey);
      if (!financialSummaryRequest) {
        financialSummaryRequest = fetchFinancialSummaryFn({
          committeeId: row.committeeId,
          electionYear: row.electionYear,
        });
        financialSummaryRequests.set(requestKey, financialSummaryRequest);
      }
      // Explicit CFB "no data" is not deletion evidence. Passing undefined lets the
      // writer preserve previously synced totals while still refreshing other data.
      financialSummary = (await financialSummaryRequest) ?? undefined;
    } catch (error) {
      console.warn(
        `Minnesota CFB financial summary unavailable for committee ${row.committeeId}; preserving existing direct totals:`,
        error instanceof Error ? error.message : error
      );
    }

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
        contributionRows: contributionRowsForBatch ?? [],
        contributionSourceUrl,
        reportedCommitteeCashSource: contributionOriginal ? {
          observedAt: contributionOriginal.observedAt, sha256: contributionOriginal.sourceFacts.sha256,
          byteCount: contributionOriginal.sourceFacts.byteCount, rowCount: contributionOriginal.sourceFacts.rowCount,
          url: contributionOriginal.sourceUrl,
        } : undefined,
        expenditureRows: expenditureRowsForBatch,
        expenditureSourceUrl,
        outsideContributionRows: outsideContributionRowsForBatch,
        outsideSourceUrl: outsideContributionSourceUrl,
        financialSummary,
        trustedCommittee: {
          committeeId: row.committeeId,
          committeeName: row.committeeName,
          sourceUrl: row.sourceUrl,
        },
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
    autoLinkAttemptedCount,
    autoLinkLinkedCount,
    results,
  };
}
