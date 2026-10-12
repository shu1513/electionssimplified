// Delaware finance batch sync: optional auto-link, then scoped due links.
// Live writes use paired original source evidence for independent cash,
// PAC and outside components. Source-disabled writes preserve stored money;
// legacy cache-only computation remains available for dry runs and tests.

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
import {
  syncDelawareVerifiedCandidateFinance,
  type DelawareVerifiedCandidateFinanceSyncResult,
} from "./delawareVerifiedCandidateFinanceSync.js";

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
  verifiedSyncCandidateFn?: typeof syncDelawareVerifiedCandidateFinance;
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
    result?: DelawareCandidateFinanceSyncResult | DelawareVerifiedCandidateFinanceSyncResult;
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
      "Delaware live CFRS passes skipped: they require " +
        "DELAWARE_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED (or a per-run force); " +
        "ordinary writes preserve stored money"
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
  // One settled acquisition per CF_ID per run. Every sibling reuses its
  // success or failure; a failed refresh never authorizes stale-cache writes.
  const acquisitions = new Map<string, { ok: true } | { ok: false; error: unknown }>();
  let succeeded = 0;
  for (const row of due.rows) {
    try {
      if (!dryRun && !liveCfrsAllowed && input.syncCandidateFn === undefined) {
        throw new Error("Delaware current source refresh disabled; stored finance preserved");
      }
      // Normal live runs use the original-capture verifier, including saved
      // opening reuse. The legacy acquisition/cache path remains injectable
      // for its existing tests and available for legacy cache-only dry runs.
      if (!dryRun && liveCfrsAllowed && input.syncCandidateFn === undefined) {
        const result = await (input.verifiedSyncCandidateFn ?? syncDelawareVerifiedCandidateFinance)({
          db: input.db, row, cacheDir: input.cacheDir, refresh: input.refresh, log,
        });
        succeeded += 1;
        candidates.push({ row, ok: true, result });
        continue;
      }
      if (!dryRun && liveCfrsAllowed) {
        let acquired = acquisitions.get(row.cfId);
        if (acquired === undefined) {
          try {
            await acquireArtifacts({ cfId: row.cfId, cacheDir: input.cacheDir, log });
            acquired = { ok: true };
          } catch (error) {
            acquired = { ok: false, error };
          }
          acquisitions.set(row.cfId, acquired);
        }
        if (!acquired.ok) throw acquired.error;
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
