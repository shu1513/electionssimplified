// Alabama finance batch sync: optional auto-link pass, then the due list,
// then a per-candidate sync. One office-scoped race/committee fetch and one
// per-year artifact parse are shared across the whole batch (the memoizing
// loaders). Per-candidate failures are recorded and the batch continues
// (fail-visible, never fail-silent). Every step is injectable for tests.

import type { Pool, PoolClient } from "pg";

import {
  autoLinkMissingAlabamaCandidateFinanceLinks,
  createAlabamaOfficeRaceContextLoader,
  type AlabamaFinanceAutoLinkResult,
} from "./alabamaCandidateFinanceAutoLink.js";
import {
  listDueAlabamaCandidateFinanceSyncRows,
  type AlabamaCandidateFinanceDueRow,
} from "./alabamaCandidateFinanceDueList.js";
import {
  createAlabamaCashRowsLoader,
  syncAlabamaCandidateFinance,
  type AlabamaCandidateFinanceSyncResult,
} from "./alabamaCandidateFinanceSync.js";
import type { AlabamaFcpaClientOptions } from "./alabamaFcpaClient.js";
import { createAlabamaVerifiedPacLoader } from "./alabamaVerifiedPacLoader.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & { connect: () => Promise<PoolClient> };

const DEFAULT_MAX_CANDIDATES = 10;
const DEFAULT_STALE_AFTER_DAYS = 7;
// The annual FCPA report for an election year is due January 31 of the next
// year; the earliest statutory general is November 2, and Nov 2 -> Jan 31 =
// 90 days, so the lookback keeps a just-finished election in scope until
// that report has been picked up.
const ALABAMA_POST_ELECTION_REPORT_DUE_DAYS = 90;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

export type AlabamaCandidateFinanceBatchSyncInput = {
  db: ConnectableQueryable;
  now?: Date;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  dryRun?: boolean;
  autoLinkMissingLinks?: boolean;
  cacheDir?: string;
  clientOptions?: AlabamaFcpaClientOptions;
  log?: (message: string) => void;
  autoLinkFn?: typeof autoLinkMissingAlabamaCandidateFinanceLinks;
  listDueRowsFn?: typeof listDueAlabamaCandidateFinanceSyncRows;
  syncCandidateFn?: typeof syncAlabamaCandidateFinance;
  loadPacDonors?: ReturnType<typeof createAlabamaVerifiedPacLoader>;
};

export type AlabamaCandidateFinanceBatchSyncResult = {
  dryRun: boolean;
  autoLinkResults: AlabamaFinanceAutoLinkResult[];
  totalDueRows: number;
  attempted: number;
  succeeded: number;
  failed: number;
  candidates: {
    row: AlabamaCandidateFinanceDueRow;
    ok: boolean;
    result?: AlabamaCandidateFinanceSyncResult;
    error?: string;
  }[];
};

export async function syncDueAlabamaCandidateFinance(
  input: AlabamaCandidateFinanceBatchSyncInput
): Promise<AlabamaCandidateFinanceBatchSyncResult> {
  const now = input.now ?? new Date();
  const log = input.log ?? ((message: string) => console.log(message));
  const maxCandidates = input.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const staleAfterDays = input.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  const electionLookbackDays =
    input.electionLookbackDays ?? ALABAMA_POST_ELECTION_REPORT_DUE_DAYS + staleAfterDays + 1;
  const electionLookaheadDays = input.electionLookaheadDays ?? DEFAULT_ELECTION_LOOKAHEAD_DAYS;
  const dryRun = input.dryRun === true;

  // Shared across auto-link AND sync so each (cycle, office) is fetched once
  // per batch, and each cash artifact is parsed once per batch.
  const loadOfficeRaceContext = createAlabamaOfficeRaceContextLoader({
    clientOptions: input.clientOptions,
  });
  const loadCashRows = createAlabamaCashRowsLoader(input.cacheDir);
  const loadPacDonors = input.loadPacDonors ?? createAlabamaVerifiedPacLoader({
    loadCashRows, clientOptions: input.clientOptions,
  });

  let autoLinkResults: AlabamaFinanceAutoLinkResult[] = [];
  if (!dryRun && input.autoLinkMissingLinks !== false) {
    const autoLink = input.autoLinkFn ?? autoLinkMissingAlabamaCandidateFinanceLinks;
    try {
      autoLinkResults = await autoLink({
        db: input.db,
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
        loadOfficeRaceContext,
        clientOptions: input.clientOptions,
      });
    } catch (error) {
      log(
        `Alabama auto-link pass failed (continuing with existing links): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const listDueRows = input.listDueRowsFn ?? listDueAlabamaCandidateFinanceSyncRows;
  const due = await listDueRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
  });

  const syncCandidate = input.syncCandidateFn ?? syncAlabamaCandidateFinance;
  const candidates: AlabamaCandidateFinanceBatchSyncResult["candidates"] = [];
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
        ballotTitle: row.ballotTitle,
        district: row.district,
        link: {
          internalCommitteeId: row.internalCommitteeId,
          committeeName: row.committeeName,
          fcpaCommitteeNumber: row.fcpaCommitteeNumber,
          linkSource: row.linkSource,
          sourceUrl: row.sourceUrl,
        },
        now,
        dryRun,
        clientOptions: input.clientOptions,
        loadOfficeRaceContext,
        loadCashRows,
        loadPacDonors,
      });
      succeeded += 1;
      candidates.push({ row, ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(
        `Alabama finance sync failed for ${row.candidateName} (internal committee ${row.internalCommitteeId}): ${message}`
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
