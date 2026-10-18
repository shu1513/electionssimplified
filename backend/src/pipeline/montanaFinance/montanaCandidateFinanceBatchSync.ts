// Montana finance batch sync: optional auto-link pass, then the due list,
// then per-candidate acquisition + sync. Raw-refresh semantics follow
// Missouri: when MONTANA_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED is off,
// the batch consumes cached artifacts only. Acquisition creates its own
// FRESH CERS sessions per candidate (the stale-session gotcha forbids a
// shared session across entities). Per-candidate failures are recorded and
// the batch continues (fail-visible, never fail-silent).

import type { Pool, PoolClient } from "pg";

import { isMontanaCampaignFinanceRawDataRefreshEnabled, isMontanaReportedIeEnabled } from "../../config/featureFlags.js";
import {
  autoLinkMissingMontanaCandidateFinanceLinks,
  type MontanaFinanceAutoLinkResult,
} from "./montanaCandidateFinanceAutoLink.js";
import {
  listDueMontanaCandidateFinanceSyncRows,
  type MontanaCandidateFinanceDueRow,
} from "./montanaCandidateFinanceDueList.js";
import {
  syncMontanaCandidateFinance,
  type MontanaCandidateFinanceSyncResult,
} from "./montanaCandidateFinanceSync.js";
import { acquireMontanaCersCandidateFinanceArtifacts } from "./montanaCersArtifactAcquisition.js";
import { acquireMontanaCersOutsideSpendingArtifacts } from "./montanaOutsideSpendingAcquisition.js";
import { syncDueMontanaCommitteeReceipts } from "./montanaReportedCommitteeBatchSync.js";
import { syncDueMontanaIndependentIe } from "./montanaIndependentIeBatchSync.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & { connect: () => Promise<PoolClient> };

const DEFAULT_MAX_CANDIDATES = 10;
const DEFAULT_STALE_AFTER_DAYS = 7;
// Include post-general reports and later amendments beyond November's deadlines.
const DEFAULT_ELECTION_LOOKBACK_DAYS = 98;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

export type MontanaCandidateFinanceBatchSyncInput = {
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
  log?: (message: string) => void;
  autoLinkFn?: typeof autoLinkMissingMontanaCandidateFinanceLinks;
  listDueRowsFn?: typeof listDueMontanaCandidateFinanceSyncRows;
  acquireArtifactsFn?: typeof acquireMontanaCersCandidateFinanceArtifacts;
  acquireOutsideArtifactsFn?: typeof acquireMontanaCersOutsideSpendingArtifacts;
  syncCandidateFn?: typeof syncMontanaCandidateFinance;
};

export type MontanaCandidateFinanceBatchSyncResult = {
  independentIe?: Awaited<ReturnType<typeof syncDueMontanaIndependentIe>>;
  committeeReceipts?: Awaited<ReturnType<typeof syncDueMontanaCommitteeReceipts>>;
  dryRun: boolean;
  rawDataRefreshEnabled: boolean;
  autoLinkResults: MontanaFinanceAutoLinkResult[];
  totalDueRows: number;
  attempted: number;
  succeeded: number;
  failed: number;
  outsideSweepYearCount: number;
  failedOutsideSweepYearCount: number;
  candidates: {
    row: MontanaCandidateFinanceDueRow;
    ok: boolean;
    result?: MontanaCandidateFinanceSyncResult;
    error?: string;
  }[];
};

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Montana finance batch ${label}: ${value}`);
  }
  return normalized;
}

export async function syncDueMontanaCandidateFinance(
  input: MontanaCandidateFinanceBatchSyncInput
): Promise<MontanaCandidateFinanceBatchSyncResult> {
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime())) {
    throw new Error("Invalid Montana finance batch timestamp");
  }
  const log = input.log ?? ((message: string) => console.log(message));
  const maxCandidates = positiveInteger(input.maxCandidates, DEFAULT_MAX_CANDIDATES, "maxCandidates");
  const staleAfterDays = positiveInteger(input.staleAfterDays, DEFAULT_STALE_AFTER_DAYS, "staleAfterDays");
  const electionLookbackDays = positiveInteger(
    input.electionLookbackDays,
    DEFAULT_ELECTION_LOOKBACK_DAYS,
    "electionLookbackDays"
  );
  const electionLookaheadDays = positiveInteger(
    input.electionLookaheadDays,
    DEFAULT_ELECTION_LOOKAHEAD_DAYS,
    "electionLookaheadDays"
  );
  const dryRun = input.dryRun === true;
  const rawDataRefreshEnabled = isMontanaCampaignFinanceRawDataRefreshEnabled(input.forceRawDataRefresh === true);
  // Independent missing/source-clock schedule runs even if no legacy summary is due.
  // Failure of this optional component cannot suppress legacy acquisition.
  let committeeReceipts: MontanaCandidateFinanceBatchSyncResult["committeeReceipts"];
  try { committeeReceipts=await syncDueMontanaCommitteeReceipts({db:input.db,now,dryRun,maxCandidates,staleAfterDays,
    electionLookbackDays,electionLookaheadDays,cacheDir:input.cacheDir}); } catch { log("Montana reported committee receipts unavailable; legacy sync continues"); }
  let independentIe: MontanaCandidateFinanceBatchSyncResult["independentIe"];
  const independentIeEnabled=isMontanaReportedIeEnabled();
  try { independentIe=await syncDueMontanaIndependentIe({db:input.db,now,dryRun,maxCandidates,staleAfterDays,
    electionLookbackDays,electionLookaheadDays,cacheDir:input.cacheDir}); } catch { log("Montana independent IE unavailable; direct sync continues"); }

  let autoLinkResults: MontanaFinanceAutoLinkResult[] = [];
  if (!dryRun && input.autoLinkMissingLinks !== false) {
    const autoLink = input.autoLinkFn ?? autoLinkMissingMontanaCandidateFinanceLinks;
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
        `Montana auto-link pass failed (continuing with existing links): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  const listDueRows = input.listDueRowsFn ?? listDueMontanaCandidateFinanceSyncRows;
  const due = await listDueRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
  });

  const acquire = input.acquireArtifactsFn ?? acquireMontanaCersCandidateFinanceArtifacts;
  const acquireOutside = input.acquireOutsideArtifactsFn ?? acquireMontanaCersOutsideSpendingArtifacts;
  const syncCandidate = input.syncCandidateFn ?? syncMontanaCandidateFinance;

  // One IE sweep per distinct election year per batch (MO pattern): the
  // sweep is year-scoped, so refreshing it per candidate would repeat a
  // ~50-committee harvest ten times. A failed sweep never blocks the direct
  // leg — those candidates sync with outsideArtifacts: null, which
  // preserves any prior outside snapshot.
  const outsideSweepOkByYear = new Map<number, boolean>();
  if (rawDataRefreshEnabled && !independentIeEnabled) {
    for (const year of new Set(due.rows.map((row) => row.electionYear))) {
      try {
        await acquireOutside({ year, cacheDir: input.cacheDir, now });
        outsideSweepOkByYear.set(year, true);
      } catch (error) {
        outsideSweepOkByYear.set(year, false);
        log(
          `Montana IE sweep failed for ${year} (direct sync continues, outside leg skipped): ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  const candidates: MontanaCandidateFinanceBatchSyncResult["candidates"] = [];
  let succeeded = 0;
  for (const row of due.rows) {
    try {
      if (rawDataRefreshEnabled) {
        await acquire({
          candidateId: Number(row.committeeId),
          year: row.electionYear,
          cacheDir: input.cacheDir,
          now,
        });
      }
      const result = await syncCandidate({
        ...(independentIeEnabled || outsideSweepOkByYear.get(row.electionYear) === false ? { outsideArtifacts: null } : {}),
        db: input.db,
        candidateId: row.candidateId,
        electionId: row.electionId,
        candidateName: row.candidateName,
        electionYear: row.electionYear,
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
      });
      succeeded += 1;
      // Surface demoted CSV discrepancies in worker logs — the scheduler
      // path otherwise reports only aggregate counts and the drift would
      // be invisible outside the full batch JSON.
      const warnings = result.aggregation?.csvCrossCheckWarnings ?? [];
      if (warnings.length > 0) {
        log(
          `Montana CSV cross-check warnings for ${row.candidateName} (CERS ${row.committeeId}): ${warnings.join(" | ")}`
        );
      }
      candidates.push({ row, ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Montana finance sync failed for ${row.candidateName} (CERS ${row.committeeId}): ${message}`);
      candidates.push({ row, ok: false, error: message });
    }
  }

  return {
    independentIe,
    committeeReceipts,
    dryRun,
    rawDataRefreshEnabled,
    autoLinkResults,
    totalDueRows: due.totalDueRows,
    attempted: due.rows.length,
    succeeded,
    failed: due.rows.length - succeeded,
    outsideSweepYearCount: [...outsideSweepOkByYear.values()].filter(Boolean).length,
    failedOutsideSweepYearCount: [...outsideSweepOkByYear.values()].filter((ok) => !ok).length,
    candidates,
  };
}
