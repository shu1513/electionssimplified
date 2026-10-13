import type { Pool, PoolClient } from "pg";

import type { FinanceIndustryClassifier } from "../finance/financeIndustryClassificationService.js";
import {
  autoLinkMissingNewYorkCandidateFinanceLinks,
  listNewYorkCandidateElectionsMissingFinanceLinks,
  type NewYorkFinanceAutoLinkCandidateElection,
  type NewYorkCandidateCommitteeResolver,
} from "./newYorkCandidateFinanceAutoLink.js";
import {
  syncNewYorkCandidateFinance,
  type NewYorkCandidateFinanceSyncResult,
} from "./newYorkCandidateFinanceSync.js";
import { createStandardStateFinanceDueListQuery } from "../finance/standardStateFinanceDueListQuery.js";
import { NEW_YORK_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./newYorkFinanceEligibleOffices.js";
import type { NewYorkSodaClientOptions } from "./newYorkSodaClient.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & Pick<Pool, "connect">;

export type NewYorkCandidateFinanceDueRow = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district: string | null;
  filerId: string;
  filerName: string;
  sourceUrl: string | null;
  lastSyncedAt: string | null;
};

export type NewYorkCandidateFinanceBatchSyncInput = {
  db: ConnectableQueryable;
  now?: Date;
  dryRun?: boolean;
  candidateId?: string;
  electionYear?: number;
  /** Re-query the source even when this linked candidate was recently synced. */
  refresh?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  autoLinkMissingLinks?: boolean;
  sodaClientOptions?: NewYorkSodaClientOptions;
  financeIndustryClassifier?: FinanceIndustryClassifier;
  aiClassificationMinAmount?: number;
  syncNewYorkCandidateFinanceFn?: typeof syncNewYorkCandidateFinance;
  resolveCandidateCommittee?: NewYorkCandidateCommitteeResolver;
};

export type NewYorkCandidateFinanceBatchSyncItemResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  filerId: string;
  ok: boolean;
  result?: NewYorkCandidateFinanceSyncResult;
  error?: string;
};

export type NewYorkCandidateFinanceBatchSyncResult = {
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
  results: NewYorkCandidateFinanceBatchSyncItemResult[];
};

const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_STALE_AFTER_DAYS = 7;
// Keep one extra calendar day so UTC scheduler timing cannot skip election-night finance syncs.
const DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS = 1;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

function assertValidDate(date: Date, label: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid New York finance batch sync ${label}`);
  }
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid New York finance batch sync ${label}: ${value}`);
  }
  return normalized;
}

export const listDueNewYorkCandidateFinanceSyncRows =
  createStandardStateFinanceDueListQuery({
    state: "NY",
    tables: {
      links: "ny_candidate_finance_links",
      summaries: "ny_candidate_finance_summaries",
    },
    eligibleOfficeKeys: NEW_YORK_FINANCE_ELIGIBLE_OFFICE_KEYS,
    linkColumns: ["filer_id", "filer_name"],
    mapRow: (row): NewYorkCandidateFinanceDueRow => ({
      candidateId: row.candidate_id,
      electionId: row.election_id,
      candidateName: row.candidate_name,
      electionYear: row.election_year,
      officeScope: row.office_scope,
      officeName: row.office_name,
      district: row.district,
      filerId: row.filer_id as string,
      filerName: row.filer_name as string,
      sourceUrl: row.source_url,
      lastSyncedAt: row.last_synced_at,
    }),
  });

export async function syncDueNewYorkCandidateFinance(
  input: NewYorkCandidateFinanceBatchSyncInput,
): Promise<NewYorkCandidateFinanceBatchSyncResult> {
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
  const syncFn =
    input.syncNewYorkCandidateFinanceFn ?? syncNewYorkCandidateFinance;
  let autoLinkAttemptedCount = 0;
  let autoLinkLinkedCount = 0;

  // Explicit scope refreshes existing links only; never auto-link unrelated
  // candidates before a targeted proof or post-deadline rerun.
  if (
    !dryRun &&
    input.autoLinkMissingLinks !== false &&
    input.candidateId === undefined &&
    input.electionYear === undefined
  ) {
    try {
      const missingLinkCandidates: NewYorkFinanceAutoLinkCandidateElection[] =
        await listNewYorkCandidateElectionsMissingFinanceLinks(input.db, {
          now,
          maxCandidates,
          electionLookbackDays,
          electionLookaheadDays,
        });
      autoLinkAttemptedCount = missingLinkCandidates.length;
      const autoLinkResults = await autoLinkMissingNewYorkCandidateFinanceLinks(
        {
          db: input.db,
          now,
          maxCandidates,
          electionLookbackDays,
          electionLookaheadDays,
          candidateElections: missingLinkCandidates,
          sodaClientOptions: input.sodaClientOptions,
          resolveCandidateCommittee: input.resolveCandidateCommittee,
        },
      );
      autoLinkLinkedCount = autoLinkResults.filter(
        (result) => result.status === "linked",
      ).length;
      for (const result of autoLinkResults) {
        if (result.status !== "linked") {
          console.warn(
            "New York finance auto-link did not link candidate election:",
            result,
          );
        }
      }
    } catch (error) {
      console.warn(
        "New York finance auto-link skipped; continuing with already-linked candidate sync:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  const due = await listDueNewYorkCandidateFinanceSyncRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
    candidateId: input.candidateId,
    electionYear: input.electionYear,
    refresh: input.refresh,
  });

  const results: NewYorkCandidateFinanceBatchSyncItemResult[] = [];
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
          filerId: row.filerId,
          filerName: row.filerName,
          sourceUrl: row.sourceUrl,
        },
        sodaClientOptions: input.sodaClientOptions,
        financeIndustryClassifier: input.financeIndustryClassifier,
        aiClassificationMinAmount: input.aiClassificationMinAmount,
        dryRun,
        now,
      });
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        filerId: row.filerId,
        ok: true,
        result,
      });
    } catch (error) {
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        filerId: row.filerId,
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
