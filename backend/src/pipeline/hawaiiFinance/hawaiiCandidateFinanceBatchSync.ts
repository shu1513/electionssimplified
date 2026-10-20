import type { Pool, PoolClient } from "pg";

import type { FinanceIndustryClassifier } from "../finance/financeIndustryClassificationService.js";
import { createStandardStateFinanceDueListQuery } from "../finance/standardStateFinanceDueListQuery.js";
import {
  autoLinkMissingHawaiiCandidateFinanceLinks,
  listHawaiiCandidateElectionsMissingFinanceLinks,
  type HawaiiCandidateCommitteeResolver,
  type HawaiiFinanceAutoLinkCandidateElection,
} from "./hawaiiCandidateFinanceAutoLink.js";
import {
  syncHawaiiCandidateFinance,
  type HawaiiCandidateFinanceSyncResult,
} from "./hawaiiCandidateFinanceSync.js";
import { HAWAII_FINANCE_ELIGIBLE_OFFICE_KEYS, normalizeHawaiiCscDistrict } from "./hawaiiFinanceEligibleOffices.js";
import type { HawaiiCscClientOptions } from "./hawaiiCscClient.js";
import { syncDueHawaiiReportedFinance, type HawaiiReportedBatchResult } from "./hawaiiReportedBatchSync.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & Pick<Pool, "connect">;

export type HawaiiCandidateFinanceDueRow = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district: string | null;
  committeeId: string;
  committeeName: string;
  electionPeriod: string;
  sourceUrl: string | null;
  lastSyncedAt: string | null;
};

export type HawaiiCandidateFinanceBatchSyncInput = {
  db: ConnectableQueryable;
  now?: Date;
  dryRun?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  autoLinkMissingLinks?: boolean;
  cscClientOptions?: HawaiiCscClientOptions;
  financeIndustryClassifier?: FinanceIndustryClassifier;
  aiClassificationMinAmount?: number;
  syncHawaiiCandidateFinanceFn?: typeof syncHawaiiCandidateFinance;
  resolveCandidateCommittee?: HawaiiCandidateCommitteeResolver;
  reportedCacheDir?: string;
  reportedRefresh?: boolean;
};

export type HawaiiCandidateFinanceBatchSyncItemResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  committeeId: string;
  ok: boolean;
  result?: HawaiiCandidateFinanceSyncResult;
  error?: string;
};

export type HawaiiCandidateFinanceBatchSyncResult = {
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
  results: HawaiiCandidateFinanceBatchSyncItemResult[];
  reportedFinance?: HawaiiReportedBatchResult;
  reportedFinanceError?: string;
};

const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_STALE_AFTER_DAYS = 7;
// Keep one extra calendar day so UTC scheduler timing cannot skip election-night finance syncs.
const DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS = 1;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

function assertValidDate(date: Date, label: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid Hawaii finance batch sync ${label}`);
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Hawaii finance batch sync ${label}: ${value}`);
  }
  return normalized;
}

// Hawaii links carry the extra election_period column, and the bespoke mapper
// normalized the district through normalizeHawaiiCscDistrict — both preserved.
export const listDueHawaiiCandidateFinanceSyncRows = createStandardStateFinanceDueListQuery({
  state: "HI",
  tables: {
    links: "hi_candidate_finance_links",
    summaries: "hi_candidate_finance_summaries",
  },
  eligibleOfficeKeys: HAWAII_FINANCE_ELIGIBLE_OFFICE_KEYS,
  linkColumns: ["committee_id", "committee_name", "election_period"],
  mapRow: (row): HawaiiCandidateFinanceDueRow => ({
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    district: normalizeHawaiiCscDistrict(row.district),
    committeeId: row.committee_id as string,
    committeeName: row.committee_name as string,
    electionPeriod: row.election_period as string,
    sourceUrl: row.source_url,
    lastSyncedAt: row.last_synced_at,
  }),
});

export async function syncDueHawaiiCandidateFinance(
  input: HawaiiCandidateFinanceBatchSyncInput
): Promise<HawaiiCandidateFinanceBatchSyncResult> {
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
  // Reported components are additive. Their failure (option caps, a missing
  // migration, a transient DB error) must not stop legacy auto-link and sync.
  let reportedFinance: HawaiiReportedBatchResult | undefined, reportedFinanceError: string | undefined;
  try {
    reportedFinance = await syncDueHawaiiReportedFinance({ db: input.db, now, dryRun,
      cacheDir: input.reportedCacheDir, refresh: input.reportedRefresh, maxCandidates: input.maxCandidates,
      staleAfterDays: input.staleAfterDays, electionLookbackDays: input.electionLookbackDays,
      electionLookaheadDays: input.electionLookaheadDays });
  } catch (error) {
    reportedFinanceError = error instanceof Error ? error.message : String(error);
    console.error(`Hawaii reported finance failed; legacy sync continues: ${reportedFinanceError}`);
  }
  // Daily syncs intentionally auto-link eligible Hawaii candidates unless explicitly disabled.
  const shouldAutoLinkMissingLinks = !dryRun && input.autoLinkMissingLinks !== false;
  const syncFn = input.syncHawaiiCandidateFinanceFn ?? syncHawaiiCandidateFinance;
  let autoLinkAttemptedCount = 0;
  let autoLinkLinkedCount = 0;

  if (shouldAutoLinkMissingLinks) {
    try {
      const missingLinkCandidates: HawaiiFinanceAutoLinkCandidateElection[] =
        await listHawaiiCandidateElectionsMissingFinanceLinks(input.db, {
          now,
          maxCandidates,
          electionLookbackDays,
          electionLookaheadDays,
        });
      autoLinkAttemptedCount = missingLinkCandidates.length;
      const autoLinkResults = await autoLinkMissingHawaiiCandidateFinanceLinks({
        db: input.db,
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
        candidateElections: missingLinkCandidates,
        cscClientOptions: input.cscClientOptions,
        resolveCandidateCommittee: input.resolveCandidateCommittee,
      });
      autoLinkLinkedCount = autoLinkResults.filter((result) => result.status === "linked").length;
      for (const result of autoLinkResults) {
        if (result.status !== "linked") {
          console.warn("Hawaii finance auto-link did not link candidate election:", result);
        }
      }
    } catch (error) {
      console.warn(
        "Hawaii finance auto-link skipped; continuing with already-linked candidate sync:",
        error instanceof Error ? error.message : error
      );
    }
  }

  const due = await listDueHawaiiCandidateFinanceSyncRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
  });

  const results: HawaiiCandidateFinanceBatchSyncItemResult[] = [];
  for (const row of due.rows) {
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
        trustedCommittee: {
          committeeId: row.committeeId,
          committeeName: row.committeeName,
          electionPeriod: row.electionPeriod,
          sourceUrl: row.sourceUrl,
        },
        cscClientOptions: input.cscClientOptions,
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
    autoLinkAttemptedCount,
    autoLinkLinkedCount,
    results,
    reportedFinance,
    reportedFinanceError,
  };
}
