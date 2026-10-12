// Kansas finance batch sync: the due list, then a per-candidate sync. One
// viewer enumeration per office (the memoizing filing-pool loader) and one
// KPDC tree fetch per office family are shared by every candidate in the
// batch; each candidate then costs its own cover and schedule opens.
// Per-candidate failures are recorded and the batch continues (fail-visible,
// never fail-silent); an unpublishable candidate keeps its prior snapshot.
// No auto-link pass here: auto-link has its own CLI and gate. Every step is
// injectable for tests.

import type { Pool, PoolClient } from "pg";

import {
  listDueKansasCandidateFinanceSyncRows,
  type KansasCandidateFinanceDueRow,
} from "./kansasCandidateFinanceDueList.js";
import {
  syncKansasCandidateFinance,
  type KansasCandidateFinanceSyncResult,
} from "./kansasCandidateFinanceSync.js";
import type { KansasCfrSessionOptions } from "./kansasCfrViewerClient.js";
import { createKansasFilingPoolLoader } from "./kansasFilingSearch.js";
import { createKansasOutsideRowLoader } from "./kansasOutsideSpendingAggregator.js";
import { createKansasKpdcRowLoader } from "./kansasPaperInventory.js";
import {
  syncKansasIndependentExpenditures,
  type KansasIESyncResult,
} from "./kansasIndependentExpenditureSync.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & { connect: () => Promise<PoolClient> };

// A full pass by default: the expensive step (one viewer enumeration per
// office) is shared by every candidate, and the due list sorts never-synced
// rows first — a link that fails every run (a paper filer until the OCR
// step) never gets a last_synced_at, so a small batch would re-spend its
// slots on the same failures each run. Above the scope's link count
// (128 House + statewide + Senate specials); --max-candidates narrows it.
const DEFAULT_MAX_CANDIDATES = 200;
const DEFAULT_STALE_AFTER_DAYS = 7;
// The post-general report (period through 12/31) is due January 10 of the
// following year (K.S.A. 25-4148(a)); a November general is at most 69 days
// before that, so ~70 days keeps a just-finished election in scope until
// the report has been picked up.
const KANSAS_POST_ELECTION_REPORT_DUE_DAYS = 70;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

export type KansasCandidateFinanceBatchSyncInput = {
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
  ieObservationFile?: string;
  ieCacheDir?: string;
  sessionOptions?: KansasCfrSessionOptions;
  log?: (message: string) => void;
  listDueRowsFn?: typeof listDueKansasCandidateFinanceSyncRows;
  syncCandidateFn?: typeof syncKansasCandidateFinance;
  syncIndependentExpendituresFn?: typeof syncKansasIndependentExpenditures;
};

export type KansasCandidateFinanceBatchSyncResult = {
  dryRun: boolean;
  totalDueRows: number;
  attempted: number;
  succeeded: number;
  failed: number;
  candidates: {
    row: KansasCandidateFinanceDueRow;
    ok: boolean;
    result?: KansasCandidateFinanceSyncResult;
    error?: string;
  }[];
  independentExpenditures: KansasIESyncResult;
};

export async function syncDueKansasCandidateFinance(
  input: KansasCandidateFinanceBatchSyncInput,
): Promise<KansasCandidateFinanceBatchSyncResult> {
  const now = input.now ?? new Date();
  const log = input.log ?? ((message: string) => console.log(message));
  const maxCandidates = input.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const staleAfterDays = input.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  const electionLookbackDays =
    input.electionLookbackDays ??
    KANSAS_POST_ELECTION_REPORT_DUE_DAYS + staleAfterDays + 1;
  const electionLookaheadDays =
    input.electionLookaheadDays ?? DEFAULT_ELECTION_LOOKAHEAD_DAYS;
  const dryRun = input.dryRun === true;

  // A failed direct receipt component, missing receiving link or empty direct
  // due list cannot suppress independently disclosed expenditure evidence.
  let independentExpenditures: KansasIESyncResult;
  try {
    independentExpenditures = await (
      input.syncIndependentExpendituresFn ?? syncKansasIndependentExpenditures
    )({
      db: input.db,
      electionYear: input.electionYear ?? now.getUTCFullYear(),
      now,
      dryRun,
      observationFile: input.ieObservationFile,
      cacheDir: input.ieCacheDir,
      sessionOptions: input.sessionOptions,
    });
  } catch (error) {
    independentExpenditures = {
      status: "unavailable",
      recordCount: null,
      acquiredDocuments: 0,
      acceptedDocuments: 0,
      writtenRows: 0,
      mappedRows: 0,
      pendingDocuments: 0,
      diagnostics: [
        error instanceof Error ? error.message : "Kansas IE source unavailable",
      ],
    };
  }
  for (const diagnostic of independentExpenditures.diagnostics)
    log(`Kansas IE: ${diagnostic}`);

  const listDueRows =
    input.listDueRowsFn ?? listDueKansasCandidateFinanceSyncRows;
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

  // Shared by every candidate: one enumeration per office, one tree per office family.
  const loadFilingPool = createKansasFilingPoolLoader({
    now,
    sessionOptions: input.sessionOptions,
    onSkippedRows: (office, skipped) =>
      log(
        `Kansas finance sync: ${skipped} ${office.label} rows carried another office and were skipped`,
      ),
    onEnumerationRetry: (office, filingType) =>
      log(
        `Kansas finance sync: ${office.label} "${filingType}" enumeration changed mid-walk; rerunning it once`,
      ),
  });
  const loadKpdcRows = createKansasKpdcRowLoader({
    onOrphanLinks: (treePath, count) =>
      log(
        `Kansas finance sync: ${count} links in ${treePath} precede any candidate row`,
      ),
  });
  // The transcribed IE rows of a cycle, read once for the whole batch.
  const loadOutsideRows = createKansasOutsideRowLoader(input.db);

  const syncCandidate = input.syncCandidateFn ?? syncKansasCandidateFinance;
  const candidates: KansasCandidateFinanceBatchSyncResult["candidates"] = [];
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
          committeeId: row.committeeId,
          committeeName: row.committeeName,
          linkSource: row.linkSource,
          sourceUrl: row.sourceUrl,
        },
        now,
        dryRun,
        sessionOptions: input.sessionOptions,
        loadFilingPool,
        loadKpdcRows,
        loadOutsideRows,
      });
      succeeded += 1;
      candidates.push({ row, ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(
        `Kansas finance sync failed for ${row.candidateName} (${row.committeeId}): ${message}`,
      );
      candidates.push({ row, ok: false, error: message });
    }
  }

  return {
    dryRun,
    totalDueRows: due.totalDueRows,
    attempted: due.rows.length,
    succeeded,
    failed: due.rows.length - succeeded,
    candidates,
    independentExpenditures,
  };
}
