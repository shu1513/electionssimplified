import type { Pool, PoolClient } from "pg";

import { isMissouriCampaignFinanceRawDataRefreshEnabled, isMissouriCommitteeReceiptsEnabled } from "../../config/featureFlags.js";
import {
  autoLinkMissingMissouriCandidateFinanceLinks,
  listMissouriCandidateElectionsMissingFinanceLinks,
  type MissouriCandidateCommitteeResolver,
} from "./missouriCandidateFinanceAutoLink.js";
import { listDueMissouriCandidateFinanceSyncRows } from "./missouriCandidateFinanceDueList.js";
import { syncMissouriCandidateFinance, type MissouriCandidateFinanceSyncResult } from "./missouriCandidateFinanceSync.js";
import {
  acquireMissouriMecCandidateFinanceArtifacts,
  acquireMissouriMecOutsideSpenderContributionArtifacts,
  acquireMissouriMecOutsideSpendingArtifacts,
} from "./missouriMecArtifactAcquisition.js";
import { createMissouriMecSession, type MissouriMecSession } from "./missouriMecClient.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & { connect: () => Promise<PoolClient> };

export type MissouriCandidateFinanceBatchSyncInput = {
  db: ConnectableQueryable;
  now?: Date;
  dryRun?: boolean;
  forceRawDataRefresh?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  autoLinkMissingLinks?: boolean;
  cacheDir?: string;
  session?: MissouriMecSession;
  resolveCandidateCommittee?: MissouriCandidateCommitteeResolver;
  acquireArtifactsFn?: typeof acquireMissouriMecCandidateFinanceArtifacts;
  acquireOutsideArtifactsFn?: typeof acquireMissouriMecOutsideSpendingArtifacts;
  acquireOutsideSpenderArtifactsFn?: typeof acquireMissouriMecOutsideSpenderContributionArtifacts;
  syncCandidateFn?: typeof syncMissouriCandidateFinance;
};

export type MissouriCandidateFinanceBatchSyncResult = {
  dryRun: boolean;
  rawDataRefreshEnabled: boolean;
  now: string;
  staleAfterDays: number;
  maxCandidates: number;
  dueCandidateCount: number;
  selectedCandidateCount: number;
  syncedCandidateCount: number;
  failedCandidateCount: number;
  autoLinkAttemptedCount: number;
  autoLinkLinkedCount: number;
  outsideArtifactYearCount: number;
  failedOutsideArtifactYearCount: number;
  results: Array<{
    candidateId: string;
    electionId: string;
    committeeId: string;
    ok: boolean;
    result?: MissouriCandidateFinanceSyncResult;
    error?: string;
  }>;
};

const DEFAULT_MAX_CANDIDATES = 10;
const DEFAULT_STALE_AFTER_DAYS = 7;
const MISSOURI_POST_ELECTION_REPORT_DUE_DAYS = 30;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) throw new Error(`Invalid Missouri finance batch ${label}: ${value}`);
  return normalized;
}

export async function syncDueMissouriCandidateFinance(
  input: MissouriCandidateFinanceBatchSyncInput
): Promise<MissouriCandidateFinanceBatchSyncResult> {
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error("Invalid Missouri finance batch timestamp");
  const maxCandidates = positiveInteger(input.maxCandidates, DEFAULT_MAX_CANDIDATES, "maxCandidates");
  const staleAfterDays = positiveInteger(input.staleAfterDays, DEFAULT_STALE_AFTER_DAYS, "staleAfterDays");
  // One complete stale interval after the final election report is due
  // guarantees a daily worker gets a post-deadline refresh even if it synced
  // on the due date before the filing arrived.
  const electionLookbackDays = positiveInteger(
    input.electionLookbackDays,
    MISSOURI_POST_ELECTION_REPORT_DUE_DAYS + staleAfterDays + 1,
    "electionLookbackDays"
  );
  const electionLookaheadDays = positiveInteger(input.electionLookaheadDays, DEFAULT_ELECTION_LOOKAHEAD_DAYS, "electionLookaheadDays");
  const dryRun = input.dryRun === true;
  let autoLinkAttemptedCount = 0;
  let autoLinkLinkedCount = 0;

  if (!dryRun && input.autoLinkMissingLinks !== false) {
    try {
      const missing = await listMissouriCandidateElectionsMissingFinanceLinks(input.db, {
        now, maxCandidates, electionLookbackDays, electionLookaheadDays,
      });
      autoLinkAttemptedCount = missing.length;
      const linked = await autoLinkMissingMissouriCandidateFinanceLinks({
        db: input.db,
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
        candidateElections: missing,
        resolveCandidateCommittee: input.resolveCandidateCommittee,
      });
      autoLinkLinkedCount = linked.filter((row) => row.status === "linked").length;
    } catch (error) {
      console.warn("Missouri finance auto-link skipped; continuing with active links:", error instanceof Error ? error.message : error);
    }
  }

  const due = await listDueMissouriCandidateFinanceSyncRows(input.db, {
    now, staleAfterDays, maxCandidates, electionLookbackDays, electionLookaheadDays,
  });
  const rawDataRefreshEnabled = isMissouriCampaignFinanceRawDataRefreshEnabled(input.forceRawDataRefresh === true);
  const session = rawDataRefreshEnabled ? input.session ?? createMissouriMecSession() : undefined;
  const acquire = input.acquireArtifactsFn ?? acquireMissouriMecCandidateFinanceArtifacts;
  const acquireOutside = input.acquireOutsideArtifactsFn ?? acquireMissouriMecOutsideSpendingArtifacts;
  const acquireOutsideSpender = input.acquireOutsideSpenderArtifactsFn ?? acquireMissouriMecOutsideSpenderContributionArtifacts;
  const sync = input.syncCandidateFn ?? syncMissouriCandidateFinance;
  const outsideAvailableByYear = new Map<number, boolean>();
  if (rawDataRefreshEnabled) {
    for (const year of new Set(due.rows.map((row) => row.electionYear))) {
      try {
        await acquireOutside({ year, cacheDir: input.cacheDir, session, now });
        outsideAvailableByYear.set(year, true);
      } catch (error) {
        outsideAvailableByYear.set(year, false);
        console.warn("Missouri yearly outside-spending refresh failed; direct sync will continue:", {
          year, error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  const spenderRefreshes = new Map<string, Promise<unknown>>();
  const results: MissouriCandidateFinanceBatchSyncResult["results"] = [];
  for (const row of due.rows) {
    try {
      let directArtifactsUnavailable = false;
      if (rawDataRefreshEnabled) {
        const acquired = await acquire({ mecid: row.committeeId, year: row.electionYear, cacheDir: input.cacheDir, session, now });
        if (acquired.directArtifactsAvailable === false) {
          directArtifactsUnavailable = true;
          if (!isMissouriCommitteeReceiptsEnabled()) throw new Error(acquired.directArtifactsSkippedReason);
        }
      }
      const result = await sync({
        db: input.db,
        candidateId: row.candidateId,
        electionId: row.electionId,
        candidateName: row.candidateName,
        electionYear: row.electionYear,
        electionDate: row.electionDate,
        officeScope: row.officeScope,
        officeName: row.officeName,
        district: row.district,
        committee: {
          committeeId: row.committeeId,
          committeeName: row.committeeName,
          linkSource: row.linkSource,
          sourceUrl: row.sourceUrl,
        },
        cacheDir: input.cacheDir,
        now,
        dryRun,
        directArtifactsUnavailable,
        ...(rawDataRefreshEnabled && outsideAvailableByYear.get(row.electionYear) === false
          ? { outsideArtifacts: null }
          : {}),
        ...(rawDataRefreshEnabled && outsideAvailableByYear.get(row.electionYear) === true
          ? {
              refreshOutsideSpenderArtifacts: async (mecid: string) => {
                const key = `${row.electionYear}\u0000${mecid}`;
                let refresh = spenderRefreshes.get(key);
                if (!refresh) {
                  refresh = acquireOutsideSpender({
                    mecid, year: row.electionYear, cacheDir: input.cacheDir, session, now,
                  });
                  spenderRefreshes.set(key, refresh);
                }
                await refresh;
              },
            }
          : {}),
      });
      results.push({ candidateId: row.candidateId, electionId: row.electionId, committeeId: row.committeeId, ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("Missouri finance sync failed for candidate; continuing:", {
        candidateId: row.candidateId, electionId: row.electionId, committeeId: row.committeeId, error: message,
      });
      results.push({ candidateId: row.candidateId, electionId: row.electionId, committeeId: row.committeeId, ok: false, error: message });
    }
  }
  return {
    dryRun,
    rawDataRefreshEnabled,
    now: now.toISOString(),
    staleAfterDays,
    maxCandidates,
    dueCandidateCount: due.totalDueRows,
    selectedCandidateCount: due.rows.length,
    syncedCandidateCount: results.filter((row) => row.ok).length,
    failedCandidateCount: results.filter((row) => !row.ok).length,
    autoLinkAttemptedCount,
    autoLinkLinkedCount,
    outsideArtifactYearCount: [...outsideAvailableByYear.values()].filter(Boolean).length,
    failedOutsideArtifactYearCount: [...outsideAvailableByYear.values()].filter((available) => !available).length,
    results,
  };
}
