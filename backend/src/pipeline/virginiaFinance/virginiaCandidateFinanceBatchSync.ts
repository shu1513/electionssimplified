import type { Pool, PoolClient } from "pg";
import { syncDueVirginiaReportedFinance } from "./virginiaReportedBatchSync.js";

import { createStandardStateFinanceDueListQuery } from "../finance/standardStateFinanceDueListQuery.js";
import {
  fetchVirginiaCampaignFinanceReport,
  fetchVirginiaCommitteeReportList,
  type VirginiaCampaignFinanceClientOptions,
  type VirginiaScheduleAContribution,
} from "./virginiaCampaignFinanceClient.js";
import {
  autoLinkMissingVirginiaCandidateFinanceLinks,
  listVirginiaCandidateElectionsMissingFinanceLinks,
  type VirginiaCandidateCommitteeResolver,
  type VirginiaFinanceAutoLinkCandidateElection,
} from "./virginiaCandidateFinanceAutoLink.js";
import {
  syncVirginiaCandidateFinance,
  type VirginiaCandidateFinanceSyncResult,
} from "./virginiaCandidateFinanceSync.js";
import { VIRGINIA_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./virginiaFinanceEligibleOffices.js";
import type { VirginiaFinanceLinkSource } from "./virginiaFinanceWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type VirginiaCandidateFinanceDueRow = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district: string | null;
  committeeId: string;
  committeeCode: string | null;
  committeeName: string;
  linkSource: VirginiaFinanceLinkSource;
  sourceUrl: string | null;
  lastSyncedAt: string | null;
};

export type VirginiaCandidateFinanceReportData = {
  committeeId: string;
  sourceUrl: string | null;
  contributions: VirginiaScheduleAContribution[];
  scheduledReportCount: number;
};

export type VirginiaCandidateFinanceBatchSyncInput = {
  db: Queryable;
  now?: Date;
  dryRun?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  autoLinkMissingLinks?: boolean;
  clientOptions?: VirginiaCampaignFinanceClientOptions;
  syncVirginiaCandidateFinanceFn?: typeof syncVirginiaCandidateFinance;
  loadReportDataForCommittee?: typeof loadVirginiaReportDataForCommittee;
  resolveCandidateCommittee?: VirginiaCandidateCommitteeResolver;
};

export type VirginiaCandidateFinanceBatchSyncItemResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  committeeId: string;
  ok: boolean;
  result?: VirginiaCandidateFinanceSyncResult;
  error?: string;
};

export type VirginiaCandidateFinanceBatchSyncResult = {
  reported?: Awaited<ReturnType<typeof syncDueVirginiaReportedFinance>>;
  reportedError?: string;
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
  results: VirginiaCandidateFinanceBatchSyncItemResult[];
};

const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_STALE_AFTER_DAYS = 7;
// Keep one extra calendar day so UTC scheduler timing cannot skip election-night finance syncs.
const DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS = 1;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

function assertValidDate(date: Date, label: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid Virginia finance batch sync ${label}`);
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Virginia finance batch sync ${label}: ${value}`);
  }
  return normalized;
}

function normalizeDistrict(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function loadVirginiaReportDataForCommittee(input: {
  committeeId: string;
  clientOptions?: VirginiaCampaignFinanceClientOptions;
}): Promise<VirginiaCandidateFinanceReportData> {
  const reportList = await fetchVirginiaCommitteeReportList(input.committeeId, input.clientOptions);
  const contributions: VirginiaScheduleAContribution[] = [];
  for (const reportId of reportList.scheduledReportIds) {
    const report = await fetchVirginiaCampaignFinanceReport(reportId, input.clientOptions);
    contributions.push(...report.scheduleA);
  }

  return {
    committeeId: input.committeeId,
    sourceUrl: reportList.sourceUrl,
    contributions,
    scheduledReportCount: reportList.scheduledReportIds.length,
  };
}

// Virginia links add committee_code and link_source, and the bespoke mapper
// trimmed the district to null through normalizeDistrict — both preserved.
export const listDueVirginiaCandidateFinanceSyncRows = createStandardStateFinanceDueListQuery({
  state: "VA",
  tables: {
    links: "va_candidate_finance_links",
    summaries: "va_candidate_finance_summaries",
  },
  eligibleOfficeKeys: VIRGINIA_FINANCE_ELIGIBLE_OFFICE_KEYS,
  linkColumns: ["committee_id", "committee_code", "committee_name", "link_source"],
  mapRow: (row): VirginiaCandidateFinanceDueRow => ({
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    district: normalizeDistrict(row.district),
    committeeId: row.committee_id as string,
    committeeCode: row.committee_code as string | null,
    committeeName: row.committee_name as string,
    linkSource: row.link_source as VirginiaFinanceLinkSource,
    sourceUrl: row.source_url,
    lastSyncedAt: row.last_synced_at,
  }),
});

export async function syncDueVirginiaCandidateFinance(
  input: VirginiaCandidateFinanceBatchSyncInput
): Promise<VirginiaCandidateFinanceBatchSyncResult> {
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
  // Native components run before legacy acquisition and have independent due,
  // retry and success clocks. Neither job's failure (unapplied migration, cache
  // permissions, option bounds) may stop the other.
  let reported: Awaited<ReturnType<typeof syncDueVirginiaReportedFinance>> | undefined;
  let reportedError: string | undefined;
  try {
    reported = await syncDueVirginiaReportedFinance({
      db: input.db as Pick<Pool, "query" | "connect">,
      now,
      dryRun,
      maxCandidates: input.maxCandidates,
      staleAfterDays: input.staleAfterDays,
      electionLookbackDays: input.electionLookbackDays,
      electionLookaheadDays: input.electionLookaheadDays,
    });
  } catch (error) {
    reportedError = error instanceof Error ? error.message : String(error);
    console.error("Virginia reported components failed; continuing with legacy sync:", reportedError);
  }
  // Daily syncs intentionally auto-link eligible Virginia candidates unless explicitly disabled.
  const shouldAutoLinkMissingLinks = !dryRun && input.autoLinkMissingLinks !== false;
  const syncFn = input.syncVirginiaCandidateFinanceFn ?? syncVirginiaCandidateFinance;
  const loadReportData = input.loadReportDataForCommittee ?? loadVirginiaReportDataForCommittee;
  let autoLinkAttemptedCount = 0;
  let autoLinkLinkedCount = 0;

  if (shouldAutoLinkMissingLinks) {
    try {
      const missingLinkCandidates: VirginiaFinanceAutoLinkCandidateElection[] =
        await listVirginiaCandidateElectionsMissingFinanceLinks(input.db, {
          now,
          maxCandidates,
          electionLookbackDays,
          electionLookaheadDays,
        });
      autoLinkAttemptedCount = missingLinkCandidates.length;
      const autoLinkResults = await autoLinkMissingVirginiaCandidateFinanceLinks({
        db: input.db,
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
        candidateElections: missingLinkCandidates,
        resolveCandidateCommittee: input.resolveCandidateCommittee,
        clientOptions: input.clientOptions,
      });
      autoLinkLinkedCount = autoLinkResults.filter((result) => result.status === "linked").length;
      for (const result of autoLinkResults) {
        if (result.status !== "linked") {
          console.warn("Virginia finance auto-link did not link candidate election:", result);
        }
      }
    } catch (error) {
      console.warn(
        "Virginia finance auto-link skipped; continuing with already-linked candidate sync:",
        error instanceof Error ? error.message : error
      );
    }
  }

  const due = await listDueVirginiaCandidateFinanceSyncRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
  });

  const results: VirginiaCandidateFinanceBatchSyncItemResult[] = [];
  const reportDataByCommitteeId = new Map<string, Promise<VirginiaCandidateFinanceReportData>>();
  for (const row of due.rows) {
    try {
      let reportDataPromise = reportDataByCommitteeId.get(row.committeeId);
      if (!reportDataPromise) {
        reportDataPromise = loadReportData({
          committeeId: row.committeeId,
          clientOptions: input.clientOptions,
        }).catch((error) => {
          reportDataByCommitteeId.delete(row.committeeId);
          throw error;
        });
        reportDataByCommitteeId.set(row.committeeId, reportDataPromise);
      }
      const reportData = await reportDataPromise;
      const result = await syncFn({
        db: input.db,
        candidateId: row.candidateId,
        electionId: row.electionId,
        candidateName: row.candidateName,
        electionYear: row.electionYear,
        officeName: row.officeName,
        district: row.district,
        committeeId: row.committeeId,
        committeeCode: row.committeeCode,
        committeeName: row.committeeName,
        linkSource: row.linkSource,
        sourceUrl: row.sourceUrl,
        contributions: reportData.contributions,
        contributionSourceUrl: reportData.sourceUrl,
        dryRun,
        now,
      });
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        committeeId: row.committeeId,
        ok: true,
        result,
      });
    } catch (error) {
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        committeeId: row.committeeId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const syncedCandidateCount = results.filter((result) => result.ok).length;
  return {
    reported,
    ...(reportedError ? { reportedError } : {}),
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
