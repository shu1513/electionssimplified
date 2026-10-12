// South Carolina finance batch sync: optional auto-link pass, then the due
// list, then a per-candidate live sync. Both passes hit the same open Ethics
// JSON API and are gated together by the sync flag at the script/scheduler
// layer — there is no separate raw-data-refresh flag (no bulk artifacts).
// Per-candidate failures are recorded and the batch continues (fail-visible,
// never fail-silent). Every step is injectable for tests.

import type { Pool, PoolClient } from "pg";

import {
  autoLinkMissingSouthCarolinaCandidateFinanceLinks,
  type SouthCarolinaFinanceAutoLinkResult,
} from "./southCarolinaCandidateFinanceAutoLink.js";
import {
  listDueSouthCarolinaCandidateFinanceSyncRows,
  type SouthCarolinaCandidateFinanceDueRow,
} from "./southCarolinaCandidateFinanceDueList.js";
import {
  syncSouthCarolinaCandidateFinance,
  type SouthCarolinaCandidateFinanceSyncResult,
} from "./southCarolinaCandidateFinanceSync.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & { connect: () => Promise<PoolClient> };

const DEFAULT_MAX_CANDIDATES = 10;
const DEFAULT_STALE_AFTER_DAYS = 7;
// The post-general filing lands with the Quarter 4 report due January 10.
// The earliest statutory general is November 2 (first Monday November 1),
// and Nov 2 -> Jan 10 = 69 days, so the lookback keeps a just-finished
// election in scope until that report has been picked up.
const SOUTH_CAROLINA_POST_ELECTION_REPORT_DUE_DAYS = 69;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

export type SouthCarolinaCandidateFinanceBatchSyncInput = {
  db: ConnectableQueryable;
  now?: Date;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  dryRun?: boolean;
  refresh?: boolean;
  candidateId?: string;
  electionYear?: number;
  sourceCacheDir?: string;
  autoLinkMissingLinks?: boolean;
  log?: (message: string) => void;
  autoLinkFn?: typeof autoLinkMissingSouthCarolinaCandidateFinanceLinks;
  listDueRowsFn?: typeof listDueSouthCarolinaCandidateFinanceSyncRows;
  syncCandidateFn?: typeof syncSouthCarolinaCandidateFinance;
};

export type SouthCarolinaCandidateFinanceBatchSyncResult = {
  dryRun: boolean;
  autoLinkResults: SouthCarolinaFinanceAutoLinkResult[];
  totalDueRows: number;
  attempted: number;
  succeeded: number;
  failed: number;
  candidates: {
    row: SouthCarolinaCandidateFinanceDueRow;
    ok: boolean;
    result?: SouthCarolinaCandidateFinanceSyncResult;
    error?: string;
  }[];
};

export async function syncDueSouthCarolinaCandidateFinance(
  input: SouthCarolinaCandidateFinanceBatchSyncInput
): Promise<SouthCarolinaCandidateFinanceBatchSyncResult> {
  const now = input.now ?? new Date();
  const log = input.log ?? ((message: string) => console.log(message));
  const maxCandidates = input.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const staleAfterDays = input.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  const electionLookbackDays =
    input.electionLookbackDays ?? SOUTH_CAROLINA_POST_ELECTION_REPORT_DUE_DAYS + staleAfterDays + 1;
  const electionLookaheadDays = input.electionLookaheadDays ?? DEFAULT_ELECTION_LOOKAHEAD_DAYS;
  const dryRun = input.dryRun === true;

  let autoLinkResults: SouthCarolinaFinanceAutoLinkResult[] = [];
  if (!dryRun && input.autoLinkMissingLinks !== false && !input.candidateId && !input.electionYear) {
    const autoLink = input.autoLinkFn ?? autoLinkMissingSouthCarolinaCandidateFinanceLinks;
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
        `South Carolina auto-link pass failed (continuing with existing links): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const listDueRows = input.listDueRowsFn ?? listDueSouthCarolinaCandidateFinanceSyncRows;
  const due = await listDueRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
    refresh: input.refresh,
    candidateId: input.candidateId,
    electionYear: input.electionYear,
  });

  const syncCandidate = input.syncCandidateFn ?? syncSouthCarolinaCandidateFinance;
  const candidates: SouthCarolinaCandidateFinanceBatchSyncResult["candidates"] = [];
  let succeeded = 0;
  for (const row of due.rows) {
    try {
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
        filer: {
          candidateFilerId: row.candidateFilerId,
          filerName: row.filerName,
          linkSource: row.linkSource,
          sourceUrl: row.sourceUrl,
        },
        now,
        dryRun,
        sourceCacheDir: input.sourceCacheDir,
      });
      succeeded += 1;
      candidates.push({ row, ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(
        `South Carolina finance sync failed for ${row.candidateName} (filer ${row.candidateFilerId}): ${message}`
      );
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
