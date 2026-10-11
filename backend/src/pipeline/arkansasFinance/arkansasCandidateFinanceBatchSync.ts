// Arkansas finance batch sync: optional auto-link pass, then the due list,
// then a per-candidate sync. One full CFIS registration sweep is shared by
// auto-link and every sync in the batch (the memoizing loader); each
// candidate then costs one windowed receipt pull. Per-candidate failures are
// recorded and the batch continues (fail-visible, never fail-silent). Every
// step is injectable for tests.

import type { Pool, PoolClient } from "pg";

import {
  autoLinkMissingArkansasCandidateFinanceLinks,
  createArkansasRegistrationSweepLoader,
  type ArkansasFinanceAutoLinkResult,
} from "./arkansasCandidateFinanceAutoLink.js";
import {
  listDueArkansasCandidateFinanceSyncRows,
  type ArkansasCandidateFinanceDueRow,
} from "./arkansasCandidateFinanceDueList.js";
import {
  syncArkansasCandidateFinance,
  type ArkansasCandidateFinanceSyncResult,
} from "./arkansasCandidateFinanceSync.js";
import type { ArkansasCfisClientOptions } from "./arkansasCfisClient.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & { connect: () => Promise<PoolClient> };

const DEFAULT_MAX_CANDIDATES = 10;
const DEFAULT_STALE_AFTER_DAYS = 7;
const SCOPED_DUE_ROW_LIMIT = 10_000;
// The ordinary candidate final report is due January 20 after November's
// election. Keep the election eligible through that report and fresh retries.
const DEFAULT_ELECTION_LOOKBACK_DAYS = 100;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

export type ArkansasCandidateFinanceBatchSyncInput = {
  db: ConnectableQueryable;
  now?: Date;
  maxCandidates?: number;
  staleAfterDays?: number;
  /** Bypass staleness while retaining election and office eligibility. */
  refresh?: boolean;
  candidateId?: string;
  electionYear?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  dryRun?: boolean;
  autoLinkMissingLinks?: boolean;
  clientOptions?: ArkansasCfisClientOptions;
  log?: (message: string) => void;
  autoLinkFn?: typeof autoLinkMissingArkansasCandidateFinanceLinks;
  listDueRowsFn?: typeof listDueArkansasCandidateFinanceSyncRows;
  syncCandidateFn?: typeof syncArkansasCandidateFinance;
};

export type ArkansasCandidateFinanceBatchSyncResult = {
  dryRun: boolean;
  autoLinkResults: ArkansasFinanceAutoLinkResult[];
  totalDueRows: number;
  attempted: number;
  succeeded: number;
  failed: number;
  candidates: {
    row: ArkansasCandidateFinanceDueRow;
    ok: boolean;
    result?: ArkansasCandidateFinanceSyncResult;
    error?: string;
  }[];
};

export async function syncDueArkansasCandidateFinance(
  input: ArkansasCandidateFinanceBatchSyncInput
): Promise<ArkansasCandidateFinanceBatchSyncResult> {
  const now = input.now ?? new Date();
  const log = input.log ?? ((message: string) => console.log(message));
  const maxCandidates = input.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1) throw new Error("Invalid Arkansas maxCandidates");
  if (input.candidateId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.candidateId)) {
    throw new Error("Invalid Arkansas candidateId");
  }
  if (input.electionYear !== undefined && (!Number.isSafeInteger(input.electionYear)
    || input.electionYear < 2026 || input.electionYear > 2100)) throw new Error("Invalid Arkansas electionYear");
  const scoped = input.candidateId !== undefined || input.electionYear !== undefined;
  const staleAfterDays = input.refresh ? 0 : input.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  const electionLookbackDays =
    input.electionLookbackDays ?? DEFAULT_ELECTION_LOOKBACK_DAYS;
  const electionLookaheadDays = input.electionLookaheadDays ?? DEFAULT_ELECTION_LOOKAHEAD_DAYS;
  const dryRun = input.dryRun === true;

  // Shared across auto-link AND sync so the registry is swept once per batch.
  const loadRegistrations = createArkansasRegistrationSweepLoader({ clientOptions: input.clientOptions });

  let autoLinkResults: ArkansasFinanceAutoLinkResult[] = [];
  if (!dryRun && !scoped && input.autoLinkMissingLinks !== false) {
    const autoLink = input.autoLinkFn ?? autoLinkMissingArkansasCandidateFinanceLinks;
    try {
      autoLinkResults = await autoLink({
        db: input.db,
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
        loadRegistrations,
        clientOptions: input.clientOptions,
      });
    } catch (error) {
      log(
        `Arkansas auto-link pass failed (continuing with existing links): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const listDueRows = input.listDueRowsFn ?? listDueArkansasCandidateFinanceSyncRows;
  const due = await listDueRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates: scoped ? SCOPED_DUE_ROW_LIMIT : maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
  });
  if (scoped && due.totalDueRows > due.rows.length) {
    throw new Error("Arkansas scoped due list exceeded its complete-row bound");
  }
  const scopedRows = scoped ? due.rows.filter(row =>
    (input.candidateId === undefined || row.candidateId.toLowerCase() === input.candidateId.toLowerCase())
    && (input.electionYear === undefined || row.electionYear === input.electionYear)) : due.rows;
  const rows = scopedRows.slice(0, maxCandidates);

  const syncCandidate = input.syncCandidateFn ?? syncArkansasCandidateFinance;
  const candidates: ArkansasCandidateFinanceBatchSyncResult["candidates"] = [];
  let succeeded = 0;
  for (const row of rows) {
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
          filingEntityId: row.filingEntityId,
          filerName: row.filerName,
          linkSource: row.linkSource,
          sourceUrl: row.sourceUrl,
        },
        now,
        dryRun,
        clientOptions: input.clientOptions,
        loadRegistrations,
      });
      succeeded += 1;
      candidates.push({ row, ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Arkansas finance sync failed for ${row.candidateName} (filer entity ${row.filingEntityId}): ${message}`);
      candidates.push({ row, ok: false, error: message });
    }
  }

  return {
    dryRun,
    autoLinkResults,
    totalDueRows: scoped ? scopedRows.length : due.totalDueRows,
    attempted: rows.length,
    succeeded,
    failed: rows.length - succeeded,
    candidates,
  };
}
