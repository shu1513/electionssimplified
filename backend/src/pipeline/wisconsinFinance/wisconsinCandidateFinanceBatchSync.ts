import { isWisconsinCampaignFinanceRawDataRefreshEnabled, isWisconsinReportedCommitteeCashEnabled } from "../../config/featureFlags.js";
import { syncDueWisconsinCommitteeCash } from "./wisconsinCommitteeCashSync.js";
import type { Pool, PoolClient } from "pg";

import type { FinanceIndustryClassifier } from "../finance/financeIndustryClassificationService.js";
import {
  autoLinkMissingWisconsinCandidateFinanceLinks,
  listWisconsinCandidateElectionsMissingFinanceLinks,
  type WisconsinCandidateCommitteeResolver,
  type WisconsinFinanceAutoLinkCandidateElection,
} from "./wisconsinCandidateFinanceAutoLink.js";
import {
  syncWisconsinCandidateFinance,
  type WisconsinCandidateFinanceSyncResult,
} from "./wisconsinCandidateFinanceSync.js";
import { createStandardStateFinanceDueListQuery } from "../finance/standardStateFinanceDueListQuery.js";
import { WISCONSIN_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./wisconsinFinanceEligibleOffices.js";
import type { WisconsinSunshineClientOptions } from "./wisconsinSunshineClient.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & Pick<Pool, "connect">;

export type WisconsinCandidateFinanceDueRow = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district: string | null;
  entityId: string;
  committeeId: string;
  committeeName: string;
  assignedCommitteeId: string | null;
  sourceUrl: string | null;
  lastSyncedAt: string | null;
};

export type WisconsinCandidateFinanceBatchSyncInput = {
  db: ConnectableQueryable;
  now?: Date;
  dryRun?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  autoLinkMissingLinks?: boolean;
  sunshineClientOptions?: WisconsinSunshineClientOptions;
  financeIndustryClassifier?: FinanceIndustryClassifier;
  aiClassificationMinAmount?: number;
  syncWisconsinCandidateFinanceFn?: typeof syncWisconsinCandidateFinance;
  resolveCandidateCommittee?: WisconsinCandidateCommitteeResolver;
  candidateId?: string;
  electionYear?: number;
  committeeCashOnly?: boolean;
  refreshCommitteeCash?: boolean;
  rawDataCacheDir?: string;
  refreshCache?: boolean;
  syncDueWisconsinCommitteeCashFn?: typeof syncDueWisconsinCommitteeCash;
};

export type WisconsinCandidateFinanceBatchSyncItemResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  entityId: string;
  committeeId: string;
  ok: boolean;
  result?: WisconsinCandidateFinanceSyncResult;
  error?: string;
};

export type WisconsinCandidateFinanceBatchSyncResult = {
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
  results: WisconsinCandidateFinanceBatchSyncItemResult[];
  committeeCash?: Awaited<ReturnType<typeof syncDueWisconsinCommitteeCash>>;
};

const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_STALE_AFTER_DAYS = 7;
// Keep one extra calendar day so UTC scheduler timing cannot skip election-night finance syncs.
const DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS = 1;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

function assertValidDate(date: Date, label: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid Wisconsin finance batch sync ${label}`);
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Wisconsin finance batch sync ${label}: ${value}`);
  }
  return normalized;
}

export const listDueWisconsinCandidateFinanceSyncRows = createStandardStateFinanceDueListQuery({
  state: "WI",
  tables: {
    links: "wi_candidate_finance_links",
    summaries: "wi_candidate_finance_summaries",
  },
  eligibleOfficeKeys: WISCONSIN_FINANCE_ELIGIBLE_OFFICE_KEYS,
  linkColumns: ["entity_id", "committee_id", "committee_name", "assigned_committee_id"],
  mapRow: (row): WisconsinCandidateFinanceDueRow => ({
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    district: row.district,
    entityId: row.entity_id as string,
    committeeId: row.committee_id as string,
    committeeName: row.committee_name as string,
    assignedCommitteeId: row.assigned_committee_id as string | null,
    sourceUrl: row.source_url,
    lastSyncedAt: row.last_synced_at,
  }),
});

export async function syncDueWisconsinCandidateFinance(
  input: WisconsinCandidateFinanceBatchSyncInput
): Promise<WisconsinCandidateFinanceBatchSyncResult> {
  const now = input.now ?? new Date();
  assertValidDate(now, "now");
  if ((input.candidateId || input.electionYear !== undefined) && !input.committeeCashOnly) {
    throw new Error("Wisconsin candidate/year targeting requires committeeCashOnly");
  }

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
  const syncFn = input.syncWisconsinCandidateFinanceFn ?? syncWisconsinCandidateFinance;
  let autoLinkAttemptedCount = 0;
  let autoLinkLinkedCount = 0;
  let committeeCash: Awaited<ReturnType<typeof syncDueWisconsinCommitteeCash>> | undefined;
  if (input.committeeCashOnly || input.refreshCommitteeCash || isWisconsinReportedCommitteeCashEnabled()) {
    try {
      committeeCash = await (input.syncDueWisconsinCommitteeCashFn ?? syncDueWisconsinCommitteeCash)({
        db: input.db,now,maxCandidates,staleAfterDays,electionLookbackDays,electionLookaheadDays,
        candidateId: input.candidateId,electionYear: input.electionYear,dryRun,
        refreshCommitteeCash: input.refreshCommitteeCash,rawDataCacheDir: input.rawDataCacheDir,
        refreshCache: input.refreshCache,allowNetwork: isWisconsinCampaignFinanceRawDataRefreshEnabled(),
      });
    } catch (e) {
      if (input.committeeCashOnly) throw e;
      // A component infrastructure failure must not stop the existing path.
      committeeCash = { due: 0,selected: 0,accepted: 0,written: 0,held: 1,failures: ["component_unavailable"] };
    }
  }
  if (input.committeeCashOnly) return {
    dryRun,now: now.toISOString(),staleAfterDays,maxCandidates,dueCandidateCount: 0,selectedCandidateCount: 0,
    syncedCandidateCount: 0,failedCandidateCount: 0,autoLinkAttemptedCount: 0,autoLinkLinkedCount: 0,results: [],committeeCash,
  };

  if (!dryRun && input.autoLinkMissingLinks !== false) {
    try {
      const missingLinkCandidates: WisconsinFinanceAutoLinkCandidateElection[] =
        await listWisconsinCandidateElectionsMissingFinanceLinks(input.db, {
          now,
          maxCandidates,
          electionLookbackDays,
          electionLookaheadDays,
        });
      autoLinkAttemptedCount = missingLinkCandidates.length;
      const autoLinkResults = await autoLinkMissingWisconsinCandidateFinanceLinks({
        db: input.db,
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
        candidateElections: missingLinkCandidates,
        sunshineClientOptions: input.sunshineClientOptions,
        resolveCandidateCommittee: input.resolveCandidateCommittee,
      });
      autoLinkLinkedCount = autoLinkResults.filter((result) => result.status === "linked").length;
      for (const result of autoLinkResults) {
        if (result.status !== "linked") {
          console.warn("Wisconsin finance auto-link did not link candidate election:", result);
        }
      }
    } catch (error) {
      console.warn(
        "Wisconsin finance auto-link skipped; continuing with already-linked candidate sync:",
        error instanceof Error ? error.message : error
      );
    }
  }

  const due = await listDueWisconsinCandidateFinanceSyncRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
  });

  const results: WisconsinCandidateFinanceBatchSyncItemResult[] = [];
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
          entityId: row.entityId,
          committeeId: row.committeeId,
          committeeName: row.committeeName,
          assignedCommitteeId: row.assignedCommitteeId,
          sourceUrl: row.sourceUrl,
        },
        sunshineClientOptions: input.sunshineClientOptions,
        financeIndustryClassifier: input.financeIndustryClassifier,
        aiClassificationMinAmount: input.aiClassificationMinAmount,
        dryRun,
        now,
      });
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        entityId: row.entityId,
        committeeId: row.committeeId,
        ok: true,
        result,
      });
    } catch (error) {
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        entityId: row.entityId,
        committeeId: row.committeeId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const syncedCandidateCount = results.filter((result) => result.ok).length;
  return {
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
    ...(committeeCash ? { committeeCash } : {}),
  };
}
