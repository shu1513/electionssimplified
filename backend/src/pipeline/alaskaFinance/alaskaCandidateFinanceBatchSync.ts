import { syncDueAlaskaReportedFinance } from "./alaskaReportedBatchSync.js";
import { isAlaskaReportedRawRefreshEnabled } from "../../config/featureFlags.js";
import type { Pool, PoolClient } from "pg";

import { createStandardStateFinanceDueListQuery } from "../finance/standardStateFinanceDueListQuery.js";
import {
  ALASKA_APOC_CAMPAIGN_INCOME_URL,
  ALASKA_APOC_IE_CONTRIBUTIONS_URL,
  ALASKA_APOC_IE_EXPENDITURES_URL,
  type AlaskaApocCampaignIncomeRow,
  type AlaskaApocIndependentContributionRow,
  type AlaskaApocIndependentExpenditureRow,
} from "./alaskaApocClient.js";
import {
  autoLinkMissingAlaskaCandidateFinanceLinks,
  listAlaskaCandidateElectionsMissingFinanceLinks,
  type AlaskaFinanceAutoLinkCandidateElection,
  type AlaskaFinanceAutoLinkResult,
} from "./alaskaCandidateFinanceAutoLink.js";
import {
  syncAlaskaCandidateFinance,
  type AlaskaCandidateFinanceResolution,
  type AlaskaCandidateFinanceSyncResult,
} from "./alaskaCandidateFinanceSync.js";
import { ALASKA_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./alaskaFinanceEligibleOffices.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & Pick<Pool, "connect">;

export type AlaskaCandidateFinanceDueRow = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district: string | null;
  candidateFilerId: string;
  candidateFilerName: string;
  linkSource: AlaskaCandidateFinanceResolution["source"];
  sourceUrl: string | null;
  lastSyncedAt: string | null;
};

export type AlaskaApocFinanceDataSet = {
  incomeRows: AlaskaApocCampaignIncomeRow[];
  independentExpenditureRows: AlaskaApocIndependentExpenditureRow[];
  independentContributionRows: AlaskaApocIndependentContributionRow[];
  incomeSourceUrl?: string | null;
  independentExpenditureSourceUrl?: string | null;
  independentContributionSourceUrl?: string | null;
};

export type AlaskaCandidateFinanceBatchSyncInput = {
  db: ConnectableQueryable;
  now?: Date;
  dryRun?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  apocData?: AlaskaApocFinanceDataSet;
  loadApocData?: () => Promise<AlaskaApocFinanceDataSet>;
  autoLinkMissingLinks?: boolean;
  syncAlaskaCandidateFinanceFn?: typeof syncAlaskaCandidateFinance;
};

export type AlaskaCandidateFinanceBatchSyncItemResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  candidateFilerId: string;
  ok: boolean;
  result?: AlaskaCandidateFinanceSyncResult;
  error?: string;
};

export type AlaskaCandidateFinanceBatchSyncResult = {
  reported?: Awaited<ReturnType<typeof syncDueAlaskaReportedFinance>>;
  legacySourceUnavailable?: boolean;
  legacySourceError?: string;
  dryRun: boolean;
  now: string;
  staleAfterDays: number;
  maxCandidates: number;
  dueCandidateCount: number;
  selectedCandidateCount: number;
  syncedCandidateCount: number;
  failedCandidateCount: number;
  // Syncs that refused to write because IE rows revealed a first-name
  // identity conflict. Not successes: nothing was written and the candidate
  // stays due until a human resolves the identity.
  identityConflictCandidateCount: number;
  autoLinkAttemptedCount: number;
  autoLinkLinkedCount: number;
  autoLinkResults: AlaskaFinanceAutoLinkResult[];
  results: AlaskaCandidateFinanceBatchSyncItemResult[];
};

const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_STALE_AFTER_DAYS = 7;
const DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS = 1;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

function assertValidDate(date: Date, label: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid Alaska finance batch sync ${label}`);
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Alaska finance batch sync ${label}: ${normalized}`);
  }
  return normalized;
}

// Alaska links identify committees by APOC filer id/name and carry the
// link_source used for supersession decisions in the sync loop.
export const listDueAlaskaCandidateFinanceSyncRows = createStandardStateFinanceDueListQuery({
  state: "AK",
  tables: {
    links: "ak_candidate_finance_links",
    summaries: "ak_candidate_finance_summaries",
  },
  eligibleOfficeKeys: ALASKA_FINANCE_ELIGIBLE_OFFICE_KEYS,
  linkColumns: ["candidate_filer_id", "candidate_filer_name", "link_source"],
  mapRow: (row): AlaskaCandidateFinanceDueRow => ({
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    district: row.district,
    candidateFilerId: row.candidate_filer_id as string,
    candidateFilerName: row.candidate_filer_name as string,
    linkSource: row.link_source as AlaskaCandidateFinanceResolution["source"],
    sourceUrl: row.source_url,
    lastSyncedAt: row.last_synced_at,
  }),
});

export async function syncDueAlaskaCandidateFinance(
  input: AlaskaCandidateFinanceBatchSyncInput
): Promise<AlaskaCandidateFinanceBatchSyncResult> {
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
  const syncFn = input.syncAlaskaCandidateFinanceFn ?? syncAlaskaCandidateFinance;
  let autoLinkResults: AlaskaFinanceAutoLinkResult[] = [];

  const reported = await syncDueAlaskaReportedFinance({
    db: input.db,
    now,
    dryRun,
    maxCandidates,
    staleAfterDays,
    electionLookbackDays: input.electionLookbackDays,
    electionLookaheadDays,
    forceRawDataRefresh: isAlaskaReportedRawRefreshEnabled(),
  });
  let apocData = input.apocData;
  let legacySourceError: string | undefined;
  try {
    apocData ??= await input.loadApocData?.();
  } catch (error) {
    // Swallow the legacy failure only when native work actually ran.
    if (!reported.enabled || reported.failure) throw error;
    legacySourceError = error instanceof Error ? error.message : String(error);
  }
  if (!apocData) {
    if (!reported.enabled)
      throw new Error("Alaska legacy finance source is required");
    return {
      dryRun,
      now: now.toISOString(),
      staleAfterDays,
      maxCandidates,
      dueCandidateCount: 0,
      selectedCandidateCount: 0,
      syncedCandidateCount: 0,
      failedCandidateCount: 0,
      identityConflictCandidateCount: 0,
      autoLinkAttemptedCount: 0,
      autoLinkLinkedCount: 0,
      autoLinkResults: [],
      results: [],
      reported,
      legacySourceUnavailable: true,
      legacySourceError,
    };
  }
  if (!dryRun && input.autoLinkMissingLinks === true) {
    try {
      const missingLinkCandidates: AlaskaFinanceAutoLinkCandidateElection[] =
        await listAlaskaCandidateElectionsMissingFinanceLinks(input.db, {
          now,
          maxCandidates,
          electionLookbackDays,
          electionLookaheadDays,
        });
      autoLinkResults = await autoLinkMissingAlaskaCandidateFinanceLinks({
        db: input.db,
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
        incomeRows: apocData.incomeRows,
        sourceUrl: apocData.incomeSourceUrl ?? ALASKA_APOC_CAMPAIGN_INCOME_URL,
        candidateElections: missingLinkCandidates,
      });
    } catch (error) {
      console.warn(
        "Alaska finance auto-link skipped; continuing with already-linked candidate sync:",
        error instanceof Error ? error.message : error
      );
    }
  }

  const due = await listDueAlaskaCandidateFinanceSyncRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
  });

  const results: AlaskaCandidateFinanceBatchSyncItemResult[] = [];
  for (const row of due.rows) {
    try {
      const result = await syncFn({
        db: input.db,
        candidateId: row.candidateId,
        electionId: row.electionId,
        candidateName: row.candidateName,
        electionYear: row.electionYear,
        officeName: row.officeName,
        district: row.district,
        sourceUrl: row.sourceUrl ?? apocData.incomeSourceUrl ?? ALASKA_APOC_CAMPAIGN_INCOME_URL,
        incomeRows: apocData.incomeRows,
        independentExpenditureRows: apocData.independentExpenditureRows,
        independentContributionRows: apocData.independentContributionRows,
        trustedCommittee: {
          candidateFilerId: row.candidateFilerId,
          candidateFilerName: row.candidateFilerName,
          source: row.linkSource,
          sourceUrl: row.sourceUrl ?? apocData.incomeSourceUrl ?? ALASKA_APOC_CAMPAIGN_INCOME_URL,
        },
        dryRun,
        now,
      });
      if (result.outsideIdentityConflict) {
        console.warn(
          "Alaska finance sync refused candidate election after conflicting first-name identities in IE rows; previous snapshot preserved:",
          { candidateId: row.candidateId, electionId: row.electionId, candidateFilerId: row.candidateFilerId }
        );
      }
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        candidateFilerId: row.candidateFilerId,
        ok: true,
        result,
      });
    } catch (error) {
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        candidateFilerId: row.candidateFilerId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const identityConflictCandidateCount = results.filter(
    (result) => result.ok && result.result?.outsideIdentityConflict === true
  ).length;
  const syncedCandidateCount =
    results.filter((result) => result.ok).length - identityConflictCandidateCount;
  return {
    ...(reported.enabled ? { reported } : {}),
    dryRun,
    now: now.toISOString(),
    staleAfterDays,
    maxCandidates,
    dueCandidateCount: due.totalDueRows,
    selectedCandidateCount: due.rows.length,
    syncedCandidateCount,
    failedCandidateCount: results.length - syncedCandidateCount - identityConflictCandidateCount,
    identityConflictCandidateCount,
    autoLinkAttemptedCount: autoLinkResults.length,
    autoLinkLinkedCount: autoLinkResults.filter((result) => result.status === "linked").length,
    autoLinkResults,
    results,
  };
}
