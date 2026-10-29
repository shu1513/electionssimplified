import { syncDueUtahReportedIe } from "./utahReportedIeSync.js";
import { syncDueUtahCommitteeCash } from "./utahCommitteeCashSync.js";
import type { Pool, PoolClient } from "pg";

import type { FinanceIndustryClassifier } from "../finance/financeIndustryClassificationService.js";
import {
  buildUtahGenerateReportUrl,
  UTAH_DISCLOSURES_BASE_URL,
  type UtahDisclosuresClientOptions,
  type UtahDisclosuresGenerateReportInput,
  type UtahDisclosuresTransactionRow,
} from "./utahDisclosuresClient.js";
import {
  downloadUtahGeneratedReportRowsWithCache,
  type UtahDisclosuresCachedRows,
} from "./utahDisclosuresCsvCache.js";
import { createStandardStateFinanceDueListQuery } from "../finance/standardStateFinanceDueListQuery.js";
import { UTAH_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./utahFinanceEligibleOffices.js";
import {
  autoLinkMissingUtahCandidateFinanceLinks,
  listUtahCandidateElectionsMissingFinanceLinks,
  type UtahCandidateCommitteeSearchResolver,
} from "./utahCandidateFinanceAutoLink.js";
import {
  syncUtahCandidateFinance,
  type UtahCandidateFinanceSyncResult,
} from "./utahCandidateFinanceSync.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type UtahCandidateFinanceDueRow = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district: string | null;
  folderId: string;
  committeeName: string;
  sourceUrl: string | null;
  lastSyncedAt: string | null;
};

export type UtahGeneratedReportRowsLoader = (
  input: UtahDisclosuresGenerateReportInput
) => Promise<UtahDisclosuresCachedRows>;

export type UtahCandidateFinanceBatchSyncInput = {
  db: Queryable;
  ieOnly?: boolean;
  refreshIe?: boolean;
  ieNetwork?: boolean;
  syncDueUtahReportedIeFn?: typeof syncDueUtahReportedIe;
  committeeCashOnly?: boolean;
  candidateId?: string;
  electionYear?: number;
  refreshCommitteeCash?: boolean;
  committeeCashNetwork?: boolean;
  syncDueUtahCommitteeCashFn?: typeof syncDueUtahCommitteeCash;
  now?: Date;
  dryRun?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  rawDataCacheDir?: string;
  refreshCache?: boolean;
  disclosuresClientOptions?: UtahDisclosuresClientOptions;
  financeIndustryClassifier?: FinanceIndustryClassifier;
  classifySupportingCommitteeIndustriesWithAi?: boolean;
  supportingCommitteeIndustryMinAmount?: number;
  loadGeneratedReportRowsFn?: UtahGeneratedReportRowsLoader;
  syncUtahCandidateFinanceFn?: typeof syncUtahCandidateFinance;
  autoLinkMissingLinks?: boolean;
  resolveCandidateCommittee?: UtahCandidateCommitteeSearchResolver;
};

export type UtahCandidateFinanceBatchSyncItemResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  folderId: string;
  ok: boolean;
  result?: UtahCandidateFinanceSyncResult;
  supportingCommitteeLoadError?: string;
  error?: string;
};

export type UtahCandidateFinanceBatchSyncResult = {
  reportedIe?: Awaited<ReturnType<typeof syncDueUtahReportedIe>>;
  reportedIeError?: string;
  committeeCash?: Awaited<ReturnType<typeof syncDueUtahCommitteeCash>>;
  committeeCashError?: string;
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
  results: UtahCandidateFinanceBatchSyncItemResult[];
};

const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_STALE_AFTER_DAYS = 7;
const DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS = 1;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

function assertValidDate(date: Date, label: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid Utah finance batch sync ${label}`);
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Utah finance batch sync ${label}: ${value}`);
  }
  return normalized;
}

function buildFolderDetailsUrl(folderId: string): string {
  return new URL(`/Search/AdvancedSearch/FolderDetails/${folderId}`, UTAH_DISCLOSURES_BASE_URL).toString();
}

function buildDefaultRowsLoader(
  input: Pick<
    UtahCandidateFinanceBatchSyncInput,
    "rawDataCacheDir" | "refreshCache" | "disclosuresClientOptions"
  >
): UtahGeneratedReportRowsLoader {
  return async (reportInput) =>
    downloadUtahGeneratedReportRowsWithCache(
      {
        ...reportInput,
        cacheDir: input.rawDataCacheDir,
      },
      {
        ...input.disclosuresClientOptions,
        refreshCache: input.refreshCache,
      }
    );
}

async function loadPacRowsForYear(input: {
  year: number;
  loadGeneratedReportRows: UtahGeneratedReportRowsLoader;
  cache: Map<number, Promise<UtahDisclosuresCachedRows>>;
}): Promise<UtahDisclosuresCachedRows> {
  const existing = input.cache.get(input.year);
  if (existing) {
    return existing;
  }
  const load = input.loadGeneratedReportRows({ reportYear: input.year, entityType: "PAC" });
  input.cache.set(input.year, load);
  return load;
}

export const listDueUtahCandidateFinanceSyncRows = createStandardStateFinanceDueListQuery({
  state: "UT",
  tables: {
    links: "ut_candidate_finance_links",
    summaries: "ut_candidate_finance_summaries",
  },
  eligibleOfficeKeys: UTAH_FINANCE_ELIGIBLE_OFFICE_KEYS,
  linkColumns: ["folder_id", "committee_name"],
  mapRow: (row): UtahCandidateFinanceDueRow => ({
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    district: row.district,
    folderId: row.folder_id as string,
    committeeName: row.committee_name as string,
    sourceUrl: row.source_url,
    lastSyncedAt: row.last_synced_at,
  }),
});

export async function syncDueUtahCandidateFinance(
  input: UtahCandidateFinanceBatchSyncInput
): Promise<UtahCandidateFinanceBatchSyncResult> {
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
  const syncFn = input.syncUtahCandidateFinanceFn ?? syncUtahCandidateFinance;
  const loadGeneratedReportRows = input.loadGeneratedReportRowsFn ?? buildDefaultRowsLoader(input);
  const pacRowsByYear = new Map<number, Promise<UtahDisclosuresCachedRows>>();
  let autoLinkAttemptedCount = 0;
  let autoLinkLinkedCount = 0;

  let reportedIe: UtahCandidateFinanceBatchSyncResult["reportedIe"];
  let reportedIeError: string | undefined;
  if (!input.committeeCashOnly) {
    try {
      reportedIe = await (input.syncDueUtahReportedIeFn ?? syncDueUtahReportedIe)({
        db: input.db, now, maxCandidates, staleAfterDays, electionLookbackDays, electionLookaheadDays,
        rawDataCacheDir: input.rawDataCacheDir, candidateId: input.candidateId, electionYear: input.electionYear,
        dryRun, refreshIe: input.refreshIe, ieNetwork: input.ieNetwork, refreshCache: input.refreshCache,
      });
    } catch (error) {
      console.warn(input.ieOnly
        ? "Utah reported IE sync failed:"
        : "Utah reported IE sync skipped; continuing with committee cash and direct sync:",
        error instanceof Error ? error.message : String(error));
      if (input.ieOnly) throw new Error("Utah reported IE component failed", { cause: error });
      reportedIeError = "component_failed";
    }
  }
  if (input.ieOnly) return { dryRun, now:now.toISOString(), staleAfterDays, maxCandidates,
    dueCandidateCount:0,selectedCandidateCount:0,syncedCandidateCount:0,failedCandidateCount:0,
    autoLinkAttemptedCount:0,autoLinkLinkedCount:0,results:[],reportedIe };

  // Independently due: a fresh direct summary or a failed legacy CSV must not
  // prevent acquisition of the verified filed committee-cash component.
  // The reverse holds too: a committee-cash failure must not stop the legacy sync.
  let committeeCash: UtahCandidateFinanceBatchSyncResult["committeeCash"];
  let committeeCashError: string | undefined;
  try {
    committeeCash = await (input.syncDueUtahCommitteeCashFn ?? syncDueUtahCommitteeCash)({
      db: input.db, now, maxCandidates, staleAfterDays, electionLookbackDays, electionLookaheadDays,
      rawDataCacheDir: input.rawDataCacheDir, candidateId: input.candidateId, electionYear: input.electionYear,
      dryRun, refreshCommitteeCash: input.refreshCommitteeCash, refreshCache: input.refreshCache,
      committeeCashNetwork: input.committeeCashNetwork,
    });
  } catch (error) {
    if (input.committeeCashOnly) throw error;
    committeeCashError = error instanceof Error ? error.message : String(error);
    console.warn("Utah committee cash sync skipped; continuing with legacy direct sync:", committeeCashError);
  }
  if (input.committeeCashOnly) return {
    dryRun, now: now.toISOString(), staleAfterDays, maxCandidates, dueCandidateCount: 0,
    selectedCandidateCount: 0, syncedCandidateCount: 0, failedCandidateCount: 0,
    autoLinkAttemptedCount: 0, autoLinkLinkedCount: 0, results: [], committeeCash,
  };

  // Create missing links first; the due list below only syncs linked rows.
  if (!dryRun && !input.candidateId && input.electionYear === undefined && input.autoLinkMissingLinks !== false) {
    try {
      const missingLinkCandidates = await listUtahCandidateElectionsMissingFinanceLinks(input.db, {
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
      });
      autoLinkAttemptedCount = missingLinkCandidates.length;
      const autoLinkResults = await autoLinkMissingUtahCandidateFinanceLinks({
        db: input.db,
        now,
        candidateElections: missingLinkCandidates,
        resolveCandidateCommittee: input.resolveCandidateCommittee,
        disclosuresClientOptions: input.disclosuresClientOptions,
      });
      autoLinkLinkedCount = autoLinkResults.filter((result) => result.status === "linked").length;
      for (const result of autoLinkResults) {
        if (result.status !== "linked") {
          console.warn("Utah finance auto-link did not link candidate election:", result);
        }
      }
    } catch (error) {
      console.warn(
        "Utah finance auto-link skipped; continuing with already-linked candidate sync:",
        error instanceof Error ? error.message : error
      );
    }
  }

  const due = await listDueUtahCandidateFinanceSyncRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
    candidateId: input.candidateId, electionYear: input.electionYear,
  });

  const results: UtahCandidateFinanceBatchSyncItemResult[] = [];
  for (const row of due.rows) {
    try {
      const candidateReport = await loadGeneratedReportRows({
        reportYear: row.electionYear,
        folderId: row.folderId,
      });
      let supportingCommitteeTransactions: readonly UtahDisclosuresTransactionRow[] | undefined;
      let supportingCommitteeSourceUrl: string | undefined;
      let supportingCommitteeLoadError: string | undefined;

      try {
        const pacReport = await loadPacRowsForYear({
          year: row.electionYear,
          loadGeneratedReportRows,
          cache: pacRowsByYear,
        });
        supportingCommitteeTransactions = pacReport.rows;
        supportingCommitteeSourceUrl = pacReport.sourceUrl;
      } catch (error) {
        supportingCommitteeLoadError = error instanceof Error ? error.message : String(error);
      }

      const folderSourceUrl = row.sourceUrl ?? buildFolderDetailsUrl(row.folderId);
      const result = await syncFn({
        db: input.db,
        candidateId: row.candidateId,
        electionId: row.electionId,
        candidateName: row.candidateName,
        electionYear: row.electionYear,
        officeScope: row.officeScope,
        officeName: row.officeName,
        district: row.district,
        sourceUrl: folderSourceUrl,
        transactionSourceUrl:
          candidateReport.sourceUrl ??
          buildUtahGenerateReportUrl({ reportYear: row.electionYear, folderId: row.folderId }),
        supportingCommitteeSourceUrl,
        entityRows: [
          {
            folderId: row.folderId,
            entityName: row.committeeName,
            reportYears: [row.electionYear],
            sourceUrl: folderSourceUrl,
          },
        ],
        trustedCommittee: {
          folderId: row.folderId,
          committeeName: row.committeeName,
          reportYears: [row.electionYear],
          sourceUrl: folderSourceUrl,
        },
        transactions: candidateReport.rows,
        supportingCommitteeTransactions,
        financeIndustryClassifier: input.financeIndustryClassifier,
        classifySupportingCommitteeIndustriesWithAi: input.classifySupportingCommitteeIndustriesWithAi,
        supportingCommitteeIndustryMinAmount: input.supportingCommitteeIndustryMinAmount,
        dryRun,
        now,
      });
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        folderId: row.folderId,
        ok: true,
        result,
        ...(supportingCommitteeLoadError ? { supportingCommitteeLoadError } : {}),
      });
    } catch (error) {
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        folderId: row.folderId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const syncedCandidateCount = results.filter((result) => result.ok).length;
  return {
    reportedIe,
    ...(reportedIeError === undefined ? {} : {reportedIeError}),
    committeeCash,
    ...(committeeCashError === undefined ? {} : { committeeCashError }),
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
