// Delaware finance batch sync: optional auto-link pass, then the due list,
// then per due candidate an artifact-acquisition pass (live, flag-gated,
// deduped by CF_ID) followed by the CACHE-ONLY sync. When live fetches are
// not allowed the sync runs against whatever the cache holds, and a due
// candidate with no cached bundle records a per-candidate failure — the
// batch continues (fail-visible, never fail-silent). Every step is
// injectable for tests.

import type { Pool, PoolClient } from "pg";

import { isDelawareCampaignFinanceRawDataRefreshEnabled } from "../../config/featureFlags.js";
import { acquireDelawareCfrsCommitteeArtifacts } from "./delawareCfrsArtifactAcquisition.js";
import {
  autoLinkMissingDelawareCandidateFinanceLinks,
  type DelawareFinanceAutoLinkResult,
} from "./delawareCandidateFinanceAutoLink.js";
import {
  listDueDelawareCandidateFinanceSyncRows,
  validateDelawareFinanceSyncScope,
  type DelawareCandidateFinanceDueRow,
} from "./delawareCandidateFinanceDueList.js";
import {
  syncDelawareCandidateFinance,
  type DelawareCandidateFinanceSyncResult,
} from "./delawareCandidateFinanceSync.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & { connect: () => Promise<PoolClient> };

const DEFAULT_MAX_CANDIDATES = 10;
const DEFAULT_STALE_AFTER_DAYS = 7;
const DELAWARE_POST_ELECTION_REPORT_DUE_DAYS = 31;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

export type DelawareCandidateFinanceBatchSyncInput = {
  db: ConnectableQueryable;
  now?: Date;
  maxCandidates?: number;
  staleAfterDays?: number;
  candidateId?: string;
  electionYear?: number;
  /** Select recently synced eligible links too; does not authorize live fetches. */
  refresh?: boolean;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  dryRun?: boolean;
  autoLinkMissingLinks?: boolean;
  /**
   * The auto-link and artifact-acquisition passes contact the live CFRS
   * portal, so they additionally require
   * DELAWARE_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED (or this per-run
   * force, the flag's established escape hatch).
   */
  forceRawDataRefresh?: boolean;
  cacheDir?: string;
  log?: (message: string) => void;
  autoLinkFn?: typeof autoLinkMissingDelawareCandidateFinanceLinks;
  listDueRowsFn?: typeof listDueDelawareCandidateFinanceSyncRows;
  acquireArtifactsFn?: typeof acquireDelawareCfrsCommitteeArtifacts;
  syncCandidateFn?: typeof syncDelawareCandidateFinance;
};

export type DelawareCandidateFinanceBatchSyncResult = {
  dryRun: boolean;
  autoLinkResults: DelawareFinanceAutoLinkResult[];
  totalDueRows: number;
  attempted: number;
  succeeded: number;
  failed: number;
  candidates: {
    row: DelawareCandidateFinanceDueRow;
    ok: boolean;
    result?: DelawareCandidateFinanceSyncResult;
    error?: string;
  }[];
};

export async function syncDueDelawareCandidateFinance(
  input: DelawareCandidateFinanceBatchSyncInput
): Promise<DelawareCandidateFinanceBatchSyncResult> {
  validateDelawareFinanceSyncScope(input);
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error("Invalid Delaware finance sync timestamp");
  const log = input.log ?? ((message: string) => console.log(message));
  const maxCandidates = input.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const staleAfterDays = input.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  const electionLookbackDays =
    input.electionLookbackDays ?? DELAWARE_POST_ELECTION_REPORT_DUE_DAYS + staleAfterDays + 1;
  const electionLookaheadDays = input.electionLookaheadDays ?? DEFAULT_ELECTION_LOOKAHEAD_DAYS;
  for (const [name, value] of Object.entries({
    maxCandidates,
    staleAfterDays,
    electionLookbackDays,
    electionLookaheadDays,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
      throw new Error(`Invalid Delaware finance ${name}`);
  }
  const scoped = input.candidateId !== undefined || input.electionYear !== undefined;
  const dryRun = input.dryRun === true;

  let autoLinkResults: DelawareFinanceAutoLinkResult[] = [];
  const liveCfrsAllowed = isDelawareCampaignFinanceRawDataRefreshEnabled(input.forceRawDataRefresh === true);
  if (!dryRun && !liveCfrsAllowed) {
    log(
      "Delaware live CFRS passes (auto-link, artifact acquisition) skipped: they require " +
        "DELAWARE_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED (or a per-run force) — syncing cache-only"
    );
  }
  if (!dryRun && !scoped && input.autoLinkMissingLinks !== false && liveCfrsAllowed) {
    const autoLink = input.autoLinkFn ?? autoLinkMissingDelawareCandidateFinanceLinks;
    try {
      autoLinkResults = await autoLink({
        db: input.db,
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
      });
    } catch (error) {
      log(
        `Delaware auto-link pass failed (continuing with existing links): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const listDueRows = input.listDueRowsFn ?? listDueDelawareCandidateFinanceSyncRows;
  const due = await listDueRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
    ...(input.candidateId === undefined ? {} : { candidateId: input.candidateId }),
    ...(input.electionYear === undefined ? {} : { electionYear: input.electionYear }),
    ...(input.refresh === true ? { refresh: true } : {}),
  });

  const acquireArtifacts = input.acquireArtifactsFn ?? acquireDelawareCfrsCommitteeArtifacts;
  const syncCandidate = input.syncCandidateFn ?? syncDelawareCandidateFinance;
  const candidates: DelawareCandidateFinanceBatchSyncResult["candidates"] = [];
  // One live acquisition attempt per CF_ID per run — a failed fetch is not
  // re-hammered when two due rows share a committee; the second row then
  // syncs against whatever the cache holds and fails visibly on its own.
  const acquisitionAttempted = new Set<string>();
  let succeeded = 0;
  for (const row of due.rows) {
    try {
      if (!dryRun && liveCfrsAllowed && !acquisitionAttempted.has(row.cfId)) {
        acquisitionAttempted.add(row.cfId);
        await acquireArtifacts({ cfId: row.cfId, cacheDir: input.cacheDir, log });
      }
      const result = await syncCandidate({
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
          cfId: row.cfId,
          committeeName: row.committeeName,
          linkSource: row.linkSource,
          sourceUrl: row.sourceUrl,
        },
        cacheDir: input.cacheDir,
        now,
        dryRun,
      });
      succeeded += 1;
      candidates.push({ row, ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Delaware finance sync failed for ${row.candidateName} (CF_ID ${row.cfId}): ${message}`);
      candidates.push({ row, ok: false, error: message });
    }
  }

  return {
    dryRun,
    autoLinkResults,
    totalDueRows: due.totalDueRows,
    attempted: due.rows.length,
    succeeded,
    failed: due.rows.length - succeeded,
    candidates,
  };
}
