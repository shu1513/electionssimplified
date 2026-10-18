// North Dakota finance batch sync: the due list, then a per-candidate
// cache-only sync. One parse per cached artifact is shared across the whole
// batch (the memoizing loader). Per-candidate failures are recorded and the
// batch continues (fail-visible, never fail-silent). No auto-link pass here:
// auto-link fetches the live registry and has its own CLI and gate. The
// separately gated reported components may acquire original portal data
// before the legacy cache-only work. Every legacy step is injectable.

import type { Pool, PoolClient } from "pg";
import { syncDueNorthDakotaReportedFinance, type NorthDakotaReportedBatchResult } from "./northDakotaReportedBatchSync.js";

import {
  listDueNorthDakotaCandidateFinanceSyncRows,
  type NorthDakotaCandidateFinanceDueRow,
} from "./northDakotaCandidateFinanceDueList.js";
import {
  createNorthDakotaFinanceArtifactLoader,
  syncNorthDakotaCandidateFinance,
  type NorthDakotaCandidateFinanceSyncResult,
} from "./northDakotaCandidateFinanceSync.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & { connect: () => Promise<PoolClient> };

const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_STALE_AFTER_DAYS = 7;
// The election year's year-end statement is due January 31 of the following
// year and the daily file for it lands a day later; ~95 days after a
// November general keeps a just-finished election in scope until then.
const NORTH_DAKOTA_POST_ELECTION_REPORT_DUE_DAYS = 95;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

export type NorthDakotaCandidateFinanceBatchSyncInput = {
  db: ConnectableQueryable;
  now?: Date;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  dryRun?: boolean;
  cacheDir?: string;
  log?: (message: string) => void;
  listDueRowsFn?: typeof listDueNorthDakotaCandidateFinanceSyncRows;
  syncCandidateFn?: typeof syncNorthDakotaCandidateFinance;
};

export type NorthDakotaCandidateFinanceBatchSyncResult = {
  reported?: NorthDakotaReportedBatchResult;
  dryRun: boolean;
  totalDueRows: number;
  attempted: number;
  succeeded: number;
  failed: number;
  candidates: {
    row: NorthDakotaCandidateFinanceDueRow;
    ok: boolean;
    result?: NorthDakotaCandidateFinanceSyncResult;
    error?: string;
  }[];
};

export async function syncDueNorthDakotaCandidateFinance(
  input: NorthDakotaCandidateFinanceBatchSyncInput
): Promise<NorthDakotaCandidateFinanceBatchSyncResult> {
  const now = input.now ?? new Date();
  const log = input.log ?? ((message: string) => console.log(message));
  const maxCandidates = input.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const staleAfterDays = input.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  const electionLookbackDays =
    input.electionLookbackDays ?? NORTH_DAKOTA_POST_ELECTION_REPORT_DUE_DAYS + staleAfterDays + 1;
  const electionLookaheadDays = input.electionLookaheadDays ?? DEFAULT_ELECTION_LOOKAHEAD_DAYS;
  const dryRun = input.dryRun === true;
  // Independent component work runs even when legacy summaries are fresh or
  // legacy direct artifacts later fail. Each source retains its own clock.
  const reported = await syncDueNorthDakotaReportedFinance({ db: input.db, now, dryRun, cacheDir: input.cacheDir,
    maxCandidates, staleAfterDays, electionLookbackDays, electionLookaheadDays });

  const listDueRows = input.listDueRowsFn ?? listDueNorthDakotaCandidateFinanceSyncRows;
  const due = await listDueRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
  });

  // One parse per cached artifact for the whole batch.
  const loadArtifacts = createNorthDakotaFinanceArtifactLoader(input.cacheDir);
  const syncCandidate = input.syncCandidateFn ?? syncNorthDakotaCandidateFinance;
  const candidates: NorthDakotaCandidateFinanceBatchSyncResult["candidates"] = [];
  let succeeded = 0;
  for (const row of due.rows) {
    try {
      const result = await syncCandidate({
        db: input.db,
        candidateId: row.candidateId,
        electionId: row.electionId,
        candidateName: row.candidateName,
        electionYear: row.electionYear,
        officeScope: row.officeScope,
        officeName: row.officeName,
        district: row.district,
        link: {
          entityId: row.entityId,
          committeeName: row.committeeName,
          linkSource: row.linkSource,
          sourceUrl: row.sourceUrl,
        },
        now,
        dryRun,
        loadArtifacts,
      });
      succeeded += 1;
      if (result.outside.status === "skipped") {
        log(`North Dakota outside spending skipped for ${row.candidateName} (entityId ${row.entityId}): ${result.outside.reason}`);
      }
      candidates.push({ row, ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`North Dakota finance sync failed for ${row.candidateName} (entityId ${row.entityId}): ${message}`);
      candidates.push({ row, ok: false, error: message });
    }
  }

  return {
    ...(reported.enabled ? { reported } : {}),
    dryRun,
    totalDueRows: due.totalDueRows,
    attempted: due.rows.length,
    succeeded,
    failed: due.rows.length - succeeded,
    candidates,
  };
}
