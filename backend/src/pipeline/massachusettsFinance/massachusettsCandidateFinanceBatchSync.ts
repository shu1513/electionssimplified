import type { Pool, PoolClient } from "pg";
import { syncDueMassachusettsReportedFinance, type MassachusettsReportedBatchResult } from "./massachusettsReportedBatchSync.js";

import { createStandardStateFinanceDueListQuery } from "../finance/standardStateFinanceDueListQuery.js";
import type { FinanceIndustryClassifier } from "../finance/financeIndustryClassificationService.js";
import {
  autoLinkMissingMassachusettsCandidateFinanceLinks,
  listMassachusettsCandidateElectionsMissingFinanceLinks,
  type MassachusettsCandidateCommitteeResolver,
  type MassachusettsFinanceAutoLinkCandidateElection,
} from "./massachusettsCandidateFinanceAutoLink.js";
import {
  syncMassachusettsCandidateFinance,
  type MassachusettsCandidateFinanceSyncResult,
} from "./massachusettsCandidateFinanceSync.js";
import {
  MASSACHUSETTS_FINANCE_ELIGIBLE_OFFICE_KEYS,
  normalizeMassachusettsOcpfDistrict,
} from "./massachusettsFinanceEligibleOffices.js";
import type { MassachusettsOcpfClientOptions } from "./massachusettsOcpfClient.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & Pick<Pool, "connect">;

export type MassachusettsCandidateFinanceDueRow = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district: string | null;
  candidateCpfId: string;
  filerName: string;
  committeeName: string;
  sourceUrl: string | null;
  lastSyncedAt: string | null;
};

export type MassachusettsCandidateFinanceBatchSyncInput = {
  db: ConnectableQueryable;
  now?: Date;
  dryRun?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  autoLinkMissingLinks?: boolean;
  ocpfClientOptions?: MassachusettsOcpfClientOptions;
  financeIndustryClassifier?: FinanceIndustryClassifier;
  aiClassificationMinAmount?: number;
  syncMassachusettsCandidateFinanceFn?: typeof syncMassachusettsCandidateFinance;
  resolveCandidateCommittee?: MassachusettsCandidateCommitteeResolver;
  reportedCacheDir?: string;
  reportedRefresh?: boolean;
};

export type MassachusettsCandidateFinanceBatchSyncItemResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  candidateCpfId: string;
  ok: boolean;
  result?: MassachusettsCandidateFinanceSyncResult;
  error?: string;
};

export type MassachusettsCandidateFinanceBatchSyncResult = {
  reportedFinance?: MassachusettsReportedBatchResult;
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
  results: MassachusettsCandidateFinanceBatchSyncItemResult[];
};

const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_STALE_AFTER_DAYS = 7;
// Keep one extra calendar day so UTC scheduler timing cannot skip election-night finance syncs.
const DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS = 1;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

function assertValidDate(date: Date, label: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid Massachusetts finance batch sync ${label}`);
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Massachusetts finance batch sync ${label}: ${value}`);
  }
  return normalized;
}

// Massachusetts links identify filers by OCPF candidate CPF id + filer name;
// the mapper keeps the bespoke normalizeMassachusettsOcpfDistrict call.
export const listDueMassachusettsCandidateFinanceSyncRows = createStandardStateFinanceDueListQuery({
  state: "MA",
  tables: {
    links: "ma_candidate_finance_links",
    summaries: "ma_candidate_finance_summaries",
  },
  eligibleOfficeKeys: MASSACHUSETTS_FINANCE_ELIGIBLE_OFFICE_KEYS,
  linkColumns: ["candidate_cpf_id", "filer_name", "committee_name"],
  mapRow: (row): MassachusettsCandidateFinanceDueRow => ({
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    district: normalizeMassachusettsOcpfDistrict(row.district),
    candidateCpfId: row.candidate_cpf_id as string,
    filerName: row.filer_name as string,
    committeeName: row.committee_name as string,
    sourceUrl: row.source_url,
    lastSyncedAt: row.last_synced_at,
  }),
});

export async function syncDueMassachusettsCandidateFinance(
  input: MassachusettsCandidateFinanceBatchSyncInput
): Promise<MassachusettsCandidateFinanceBatchSyncResult> {
  const now = input.now ?? new Date();
  assertValidDate(now, "now");

  const maxCandidates = normalizePositiveInteger(input.maxCandidates, DEFAULT_MAX_CANDIDATES, "maxCandidates");
  const staleAfterDays = normalizePositiveInteger(input.staleAfterDays, DEFAULT_STALE_AFTER_DAYS, "staleAfterDays");
  const electionLookbackDays = normalizePositiveInteger(
    input.electionLookbackDays,
    DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS,
    "electionLookbackDays"
  );
  const electionLookaheadDays = normalizePositiveInteger(
    input.electionLookaheadDays,
    DEFAULT_ELECTION_LOOKAHEAD_DAYS,
    "electionLookaheadDays"
  );
  const dryRun = input.dryRun === true;
  // Own due selection, source and failure preservation before legacy finance.
  const reportedFinance = await syncDueMassachusettsReportedFinance({ db: input.db, now, dryRun,
    cacheDir: input.reportedCacheDir, refresh: input.reportedRefresh, maxCandidates: input.maxCandidates,
    staleAfterDays: input.staleAfterDays, electionLookbackDays: input.electionLookbackDays,
    electionLookaheadDays: input.electionLookaheadDays });
  // Daily syncs intentionally auto-link eligible Massachusetts candidates unless explicitly disabled.
  const shouldAutoLinkMissingLinks = !dryRun && input.autoLinkMissingLinks !== false;
  const syncFn = input.syncMassachusettsCandidateFinanceFn ?? syncMassachusettsCandidateFinance;
  let autoLinkAttemptedCount = 0;
  let autoLinkLinkedCount = 0;

  if (shouldAutoLinkMissingLinks) {
    try {
      const missingLinkCandidates: MassachusettsFinanceAutoLinkCandidateElection[] =
        await listMassachusettsCandidateElectionsMissingFinanceLinks(input.db, {
          now,
          maxCandidates,
          electionLookbackDays,
          electionLookaheadDays,
        });
      autoLinkAttemptedCount = missingLinkCandidates.length;
      const autoLinkResults = await autoLinkMissingMassachusettsCandidateFinanceLinks({
        db: input.db,
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
        candidateElections: missingLinkCandidates,
        ocpfClientOptions: input.ocpfClientOptions,
        resolveCandidateCommittee: input.resolveCandidateCommittee,
      });
      autoLinkLinkedCount = autoLinkResults.filter((result) => result.status === "linked").length;
      for (const result of autoLinkResults) {
        if (result.status !== "linked") {
          console.warn("Massachusetts finance auto-link did not link candidate election:", result);
        }
      }
    } catch (error) {
      console.warn(
        "Massachusetts finance auto-link skipped; continuing with already-linked candidate sync:",
        error instanceof Error ? error.message : error
      );
    }
  }

  const due = await listDueMassachusettsCandidateFinanceSyncRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
  });

  const results: MassachusettsCandidateFinanceBatchSyncItemResult[] = [];
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
          candidateCpfId: row.candidateCpfId,
          filerName: row.filerName,
          committeeName: row.committeeName,
          sourceUrl: row.sourceUrl,
        },
        ocpfClientOptions: input.ocpfClientOptions,
        financeIndustryClassifier: input.financeIndustryClassifier,
        aiClassificationMinAmount: input.aiClassificationMinAmount,
        dryRun,
        now,
      });
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        candidateCpfId: row.candidateCpfId,
        ok: true,
        result,
      });
    } catch (error) {
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        candidateCpfId: row.candidateCpfId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const syncedCandidateCount = results.filter((result) => result.ok).length;
  return {
    reportedFinance,
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
