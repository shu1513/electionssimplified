import type { Pool, PoolClient } from "pg";

import { createStandardStateFinanceDueListQuery } from "../finance/standardStateFinanceDueListQuery.js";
import type { FinanceIndustryClassifier } from "../finance/financeIndustryClassificationService.js";
import {
  buildTennesseeCampContributionSearchUrl,
  fetchTennesseeCampContributionRecords,
  fetchTennesseeCampExpenditureRecords,
  fetchTennesseeCampPacContributionRecords,
  type TennesseeCampClientOptions,
  type TennesseeCampContributionRecord,
  type TennesseeCampExpenditureRecord,
} from "./tennesseeCampClient.js";
import {
  autoLinkMissingTennesseeCandidateFinanceLinks,
  listTennesseeCandidateElectionsMissingFinanceLinks,
  type TennesseeCandidateCommitteeResolver,
  type TennesseeFinanceAutoLinkCandidateElection,
} from "./tennesseeCandidateFinanceAutoLink.js";
import {
  syncTennesseeCandidateFinance,
  type TennesseeCandidateFinanceSyncResult,
} from "./tennesseeCandidateFinanceSync.js";
import { aggregateTennesseeOutsideSpending } from "./tennesseeOutsideSpendingAggregator.js";
import { TENNESSEE_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./tennesseeFinanceEligibleOffices.js";
import type { TennesseeFinanceLinkInput, TennesseeFinanceLinkSource } from "./tennesseeFinanceWriter.js";
import { createTennesseeVerifiedFinanceLoader, type TennesseeVerifiedFinanceRawEvent } from "./tennesseeVerifiedFinanceLoader.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type TennesseeCampContributionFetchResult = {
  sourceUrl: string | null;
  records: TennesseeCampContributionRecord[];
};
type TennesseeCampExpenditureFetchResult = {
  sourceUrl: string | null;
  records: TennesseeCampExpenditureRecord[];
};

type TennesseeCandidateFinanceExportCache = {
  independentExpendituresByReportYear: Map<string, Promise<TennesseeCampExpenditureFetchResult>>;
  pacContributionsByRecipientReportYear: Map<string, Promise<TennesseeCampContributionFetchResult>>;
};

export type TennesseeCandidateFinanceDueRow = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district: string | null;
  campCandidateId: string;
  ownerName: string;
  committeeName: string | null;
  linkSource: TennesseeFinanceLinkSource;
  sourceUrl: string | null;
  reportListUrl: string | null;
  lastSyncedAt: string | null;
};

export type TennesseeCandidateFinanceContributionData = {
  sourceUrl: string | null;
  contributions: TennesseeCampContributionRecord[];
  expenditureSourceUrl: string | null;
  expenditures: TennesseeCampExpenditureRecord[];
  outsideContributionSourceUrl: string | null;
  outsideGroupContributionRecords: TennesseeCampContributionRecord[];
};

export type TennesseeCandidateFinanceBatchSyncInput = {
  db: Queryable;
  now?: Date;
  dryRun?: boolean;
  refresh?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  autoLinkMissingLinks?: boolean;
  candidateId?: string;
  electionYear?: number;
  onRawResponse?: (event: TennesseeVerifiedFinanceRawEvent) => void | Promise<void>;
  verifiedFinanceLoader?: Pick<ReturnType<typeof createTennesseeVerifiedFinanceLoader>, "loadBatch">;
  clientOptions?: TennesseeCampClientOptions;
  financeIndustryClassifier?: FinanceIndustryClassifier;
  aiClassificationMinAmount?: number;
  syncTennesseeCandidateFinanceFn?: typeof syncTennesseeCandidateFinance;
  loadContributionDataForCandidate?: typeof loadTennesseeContributionDataForCandidate;
  resolveCandidateCommittee?: TennesseeCandidateCommitteeResolver;
};

export type TennesseeCandidateFinanceBatchSyncItemResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  campCandidateId: string;
  ok: boolean;
  result?: TennesseeCandidateFinanceSyncResult;
  error?: string;
};

export type TennesseeCandidateFinanceBatchSyncResult = {
  dryRun: boolean;
  refresh?: boolean;
  now: string;
  staleAfterDays: number;
  maxCandidates: number;
  dueCandidateCount: number;
  selectedCandidateCount: number;
  syncedCandidateCount: number;
  failedCandidateCount: number;
  autoLinkAttemptedCount: number;
  autoLinkLinkedCount: number;
  results: TennesseeCandidateFinanceBatchSyncItemResult[];
};

const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_STALE_AFTER_DAYS = 7;
const DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS = 1;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

function assertValidDate(date: Date, label: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid Tennessee finance batch sync ${label}`);
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Tennessee finance batch sync ${label}: ${value}`);
  }
  return normalized;
}

function normalizeDistrict(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeSearchToken(value: string): string {
  return value
    .replace(/\([^()]+\)/g, " ")
    .replace(/\b(JR|SR|II|III|IV|V)\.?\b/gi, " ")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function lastNameSearchToken(candidateName: string): string {
  const trimmed = candidateName.replace(/\([^()]+\)/g, " ").trim();
  if (trimmed.includes(",")) {
    const commaFirst = normalizeSearchToken(trimmed.split(",", 1)[0] ?? "");
    if (commaFirst) {
      return commaFirst;
    }
  }
  const normalized = normalizeSearchToken(trimmed);
  return normalized.split(/\s+/).filter(Boolean).at(-1) ?? trimmed;
}

function contributionRecordKey(contribution: TennesseeCampContributionRecord): string {
  return [
    contribution.electionYear,
    contribution.reportName,
    contribution.type,
    contribution.adjustment,
    contribution.amount,
    contribution.date,
    contribution.recipientName,
    contribution.contributorName,
    contribution.contributorOccupation,
    contribution.contributorEmployer,
  ].join("\u0000");
}

function expenditureRecordKey(expenditure: TennesseeCampExpenditureRecord): string {
  return [
    expenditure.electionYear,
    expenditure.reportName,
    expenditure.type,
    expenditure.adjustment,
    expenditure.amount,
    expenditure.date,
    expenditure.candidatePacName,
    expenditure.vendorName,
    expenditure.purpose,
    expenditure.candidateFor,
    expenditure.supportOpposeCode,
  ].join("\u0000");
}

function createTennesseeCandidateFinanceExportCache(): TennesseeCandidateFinanceExportCache {
  return {
    independentExpendituresByReportYear: new Map(),
    pacContributionsByRecipientReportYear: new Map(),
  };
}

function exportCacheKey(...parts: readonly (string | number | null | undefined)[]): string {
  return parts.map((part) => String(part ?? "")).join("\u0000");
}

function mergeTennesseeCampSourceUrl(existing: string | null, next: string | null): string | null {
  if (!existing) {
    return next;
  }
  if (!next || existing === next) {
    return existing;
  }
  return buildTennesseeCampContributionSearchUrl();
}

function fetchCachedIndependentExpenditures(
  input: { electionYear: number; reportYear: number },
  clientOptions: TennesseeCampClientOptions | undefined,
  exportCache: TennesseeCandidateFinanceExportCache | undefined
): Promise<TennesseeCampExpenditureFetchResult> {
  if (!exportCache) {
    return fetchTennesseeCampExpenditureRecords(
      {
        electionYear: input.electionYear,
        reportYear: input.reportYear,
        expenditureType: "independent",
      },
      clientOptions
    );
  }

  const key = exportCacheKey(input.electionYear, input.reportYear, "independent");
  const cached =
    exportCache.independentExpendituresByReportYear.get(key) ??
    fetchTennesseeCampExpenditureRecords(
      {
        electionYear: input.electionYear,
        reportYear: input.reportYear,
        expenditureType: "independent",
      },
      clientOptions
    );
  exportCache.independentExpendituresByReportYear.set(key, cached);
  return cached;
}

function fetchCachedPacContributions(
  input: { recipientName: string; electionYear: number; reportYear: number },
  clientOptions: TennesseeCampClientOptions | undefined,
  exportCache: TennesseeCandidateFinanceExportCache | undefined
): Promise<TennesseeCampContributionFetchResult> {
  if (!exportCache) {
    return fetchTennesseeCampPacContributionRecords(input, clientOptions);
  }

  const key = exportCacheKey(input.recipientName.trim().toUpperCase(), input.electionYear, input.reportYear);
  const cached =
    exportCache.pacContributionsByRecipientReportYear.get(key) ??
    fetchTennesseeCampPacContributionRecords(input, clientOptions);
  exportCache.pacContributionsByRecipientReportYear.set(key, cached);
  return cached;
}

export async function loadTennesseeContributionDataForCandidate(input: {
  candidateName: string;
  ownerName: string;
  electionYear: number;
  clientOptions?: TennesseeCampClientOptions;
  exportCache?: TennesseeCandidateFinanceExportCache;
}): Promise<TennesseeCandidateFinanceContributionData> {
  const recordsByKey = new Map<string, TennesseeCampContributionRecord>();
  const expendituresByKey = new Map<string, TennesseeCampExpenditureRecord>();
  const outsideContributionRecordsByKey = new Map<string, TennesseeCampContributionRecord>();
  let sourceUrl: string | null = null;
  let expenditureSourceUrl: string | null = null;
  let outsideContributionSourceUrl: string | null = null;
  for (const reportYear of [input.electionYear - 1, input.electionYear].filter((year) => year >= 2000)) {
    const result = await fetchTennesseeCampContributionRecords(
      {
        recipientName: lastNameSearchToken(input.ownerName || input.candidateName),
        electionYear: input.electionYear,
        reportYear,
      },
      input.clientOptions
    );
    sourceUrl = mergeTennesseeCampSourceUrl(sourceUrl, result.sourceUrl);
    for (const contribution of result.records) {
      recordsByKey.set(contributionRecordKey(contribution), contribution);
    }
    const expenditureResult = await fetchCachedIndependentExpenditures(
      {
        electionYear: input.electionYear,
        reportYear,
      },
      input.clientOptions,
      input.exportCache
    );
    expenditureSourceUrl = mergeTennesseeCampSourceUrl(expenditureSourceUrl, expenditureResult.sourceUrl);
    for (const expenditure of expenditureResult.records) {
      expendituresByKey.set(expenditureRecordKey(expenditure), expenditure);
    }
  }

  const outsideFinance = aggregateTennesseeOutsideSpending({
    candidateName: input.candidateName,
    ownerName: input.ownerName,
    electionYear: input.electionYear,
    expenditureRecords: [...expendituresByKey.values()],
    sourceUrl: expenditureSourceUrl,
  });
  const outsideCommitteeNames = [
    ...new Set((outsideFinance.summary?.groups ?? []).map((group) => group.committeeName.trim()).filter(Boolean)),
  ];
  for (const committeeName of outsideCommitteeNames) {
    for (const reportYear of [input.electionYear - 1, input.electionYear].filter((year) => year >= 2000)) {
      const result = await fetchCachedPacContributions(
        {
          recipientName: committeeName,
          electionYear: input.electionYear,
          reportYear,
        },
        input.clientOptions,
        input.exportCache
      );
      outsideContributionSourceUrl = mergeTennesseeCampSourceUrl(outsideContributionSourceUrl, result.sourceUrl);
      for (const contribution of result.records) {
        outsideContributionRecordsByKey.set(contributionRecordKey(contribution), contribution);
      }
    }
  }

  return {
    sourceUrl,
    contributions: [...recordsByKey.values()],
    expenditureSourceUrl,
    expenditures: [...expendituresByKey.values()],
    outsideContributionSourceUrl,
    outsideGroupContributionRecords: [...outsideContributionRecordsByKey.values()],
  };
}

// Tennessee's bespoke query selected report_list_url after source_url; the
// builder emits every link column in the slot before it, so the only SQL
// delta is that column-order move (rows are read by name - no behavior
// change). The mapper keeps the bespoke trim-to-null normalizeDistrict.
export const listDueTennesseeCandidateFinanceSyncRows = createStandardStateFinanceDueListQuery({
  state: "TN",
  tables: {
    links: "tn_candidate_finance_links",
    summaries: "tn_candidate_finance_summaries",
  },
  eligibleOfficeKeys: TENNESSEE_FINANCE_ELIGIBLE_OFFICE_KEYS,
  linkColumns: ["camp_candidate_id", "owner_name", "committee_name", "link_source", "report_list_url"],
  mapRow: (row): TennesseeCandidateFinanceDueRow => ({
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    district: normalizeDistrict(row.district),
    campCandidateId: row.camp_candidate_id as string,
    ownerName: row.owner_name as string,
    committeeName: row.committee_name as string | null,
    linkSource: row.link_source as TennesseeFinanceLinkSource,
    sourceUrl: row.source_url,
    reportListUrl: row.report_list_url as string | null,
    lastSyncedAt: row.last_synced_at,
  }),
});

export async function syncDueTennesseeCandidateFinance(
  input: TennesseeCandidateFinanceBatchSyncInput
): Promise<TennesseeCandidateFinanceBatchSyncResult> {
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
  if (input.candidateId !== undefined && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(input.candidateId)) {
    throw Error("Invalid Tennessee finance candidateId");
  }
  if (input.electionYear !== undefined && (!Number.isInteger(input.electionYear) || input.electionYear < 2000 || input.electionYear > 2100)) {
    throw Error("Invalid Tennessee finance electionYear");
  }
  const scoped = input.candidateId !== undefined || input.electionYear !== undefined;
  const shouldAutoLinkMissingLinks = !dryRun && !scoped && input.autoLinkMissingLinks !== false;
  const syncFn = input.syncTennesseeCandidateFinanceFn ?? syncTennesseeCandidateFinance;
  const exportCache = input.loadContributionDataForCandidate ? undefined : createTennesseeCandidateFinanceExportCache();
  const loadContributionData =
    input.loadContributionDataForCandidate ??
    ((loaderInput: {
      candidateName: string;
      ownerName: string;
      electionYear: number;
      clientOptions?: TennesseeCampClientOptions;
    }) => loadTennesseeContributionDataForCandidate({ ...loaderInput, exportCache }));
  let autoLinkAttemptedCount = 0;
  let autoLinkLinkedCount = 0;

  if (shouldAutoLinkMissingLinks) {
    try {
      const missingLinkCandidates: TennesseeFinanceAutoLinkCandidateElection[] =
        await listTennesseeCandidateElectionsMissingFinanceLinks(input.db, {
          now,
          maxCandidates,
          electionLookbackDays,
          electionLookaheadDays,
        });
      autoLinkAttemptedCount = missingLinkCandidates.length;
      const autoLinkResults = await autoLinkMissingTennesseeCandidateFinanceLinks({
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
          console.warn("Tennessee finance auto-link did not link candidate election:", result);
        }
      }
    } catch (error) {
      console.warn(
        "Tennessee finance auto-link skipped; continuing with already-linked candidate sync:",
        error instanceof Error ? error.message : error
      );
    }
  }

  const due = await listDueTennesseeCandidateFinanceSyncRows(input.db, {
    now,
    staleAfterDays: input.refresh ? 0 : staleAfterDays,
    maxCandidates: scoped ? 10_000 : maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
  });

  if (scoped && due.totalDueRows > 10_000) throw Error("Scoped Tennessee due selection exceeds acquisition bound");
  const matching = due.rows.filter(row => (input.candidateId === undefined || row.candidateId === input.candidateId)
    && (input.electionYear === undefined || row.electionYear === input.electionYear));
  const selected = matching.slice(0,maxCandidates);
  const toLink = (row: TennesseeCandidateFinanceDueRow): TennesseeFinanceLinkInput => ({
    candidateId:row.candidateId,electionId:row.electionId,electionYear:row.electionYear,
    candidateNameNormalized:row.candidateName.trim().replace(/\s+/g," ").toUpperCase(),officeName:row.officeName,district:row.district,
    campCandidateId:row.campCandidateId,ownerName:row.ownerName,committeeName:row.committeeName,
    linkSource:row.linkSource,linkStatus:"active",sourceUrl:row.sourceUrl,reportListUrl:row.reportListUrl,
  });
  // All source opening/closing rounds finish before the first candidate write.
  // The legacy adapter remains available only when a caller explicitly injects it.
  let prepared: Awaited<ReturnType<ReturnType<typeof createTennesseeVerifiedFinanceLoader>["loadBatch"]>> = [];
  if (!input.loadContributionDataForCandidate && selected.length) {
    const prior = await input.db.query<{candidate_id:string;election_id:string;camp_candidate_id:string;
      pac_source_provenance:unknown;outside_report_provenance:unknown}>(`
      SELECT link.candidate_id,link.election_id,link.camp_candidate_id,
        summary.pac_source_provenance,summary.outside_report_provenance
      FROM public.tn_candidate_finance_links link
      LEFT JOIN public.tn_candidate_finance_summaries summary ON summary.link_id=link.id AND summary.election_year=link.election_year
      WHERE link.candidate_id=ANY($1::uuid[]) AND link.election_id=ANY($2::uuid[]) AND link.link_status='active'
    `,[selected.map(row=>row.candidateId),selected.map(row=>row.electionId)]);
    const loader = input.verifiedFinanceLoader ?? createTennesseeVerifiedFinanceLoader({
      clientOptions:input.clientOptions,onRawResponse:input.onRawResponse,
    });
    prepared = await loader.loadBatch(selected.map(row => {
      const existing=prior.rows.find(p=>p.candidate_id===row.candidateId && p.election_id===row.electionId && p.camp_candidate_id===row.campCandidateId);
      return {link:toLink(row),priorPacProvenance:existing?.pac_source_provenance,priorOutsideReportProvenance:existing?.outside_report_provenance};
    }));
    if (prepared.length!==selected.length || prepared.some((p,index)=>p.link.candidateId!==selected[index]!.candidateId
      || p.link.electionId!==selected[index]!.electionId || p.link.campCandidateId!==selected[index]!.campCandidateId)) {
      throw Error("Verified Tennessee batch does not match selected links");
    }
  }
  const results: TennesseeCandidateFinanceBatchSyncItemResult[] = [];
  for (const [index,row] of selected.entries()) {
    try {
      const contributionData = input.loadContributionDataForCandidate ? await loadContributionData({
        candidateName: row.candidateName,
        ownerName: row.ownerName,
        electionYear: row.electionYear,
        clientOptions: input.clientOptions,
      }) : undefined;
      const result = await syncFn({
        db: input.db,
        candidateId: row.candidateId,
        electionId: row.electionId,
        candidateName: row.candidateName,
        electionYear: row.electionYear,
        officeName: row.officeName,
        district: row.district,
        campCandidateId: row.campCandidateId,
        ownerName: row.ownerName,
        committeeName: row.committeeName,
        linkSource: row.linkSource,
        sourceUrl: row.sourceUrl,
        reportListUrl: row.reportListUrl,
        ...(contributionData ? {
          contributions:contributionData.contributions,contributionSourceUrl:contributionData.sourceUrl,
          expenditures:contributionData.expenditures,expenditureSourceUrl:contributionData.expenditureSourceUrl,
          outsideGroupContributionRecords:contributionData.outsideGroupContributionRecords,
          outsideContributionSourceUrl:contributionData.outsideContributionSourceUrl,
        } : {verifiedFinance:prepared[index]}),
        financeIndustryClassifier: input.financeIndustryClassifier,
        aiClassificationMinAmount: input.aiClassificationMinAmount,
        now,
        dryRun,
      });
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        campCandidateId: row.campCandidateId,
        ok: true,
        result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("Tennessee finance sync failed for candidate; continuing:", {
        candidateId: row.candidateId,
        electionId: row.electionId,
        campCandidateId: row.campCandidateId,
        error: message,
      });
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        campCandidateId: row.campCandidateId,
        ok: false,
        error: message,
      });
    }
  }

  return {
    dryRun,
    ...(input.refresh ? { refresh: true } : {}),
    now: now.toISOString(),
    staleAfterDays,
    maxCandidates,
    dueCandidateCount: scoped ? matching.length : due.totalDueRows,
    selectedCandidateCount: selected.length,
    syncedCandidateCount: results.filter((result) => result.ok).length,
    failedCandidateCount: results.filter((result) => !result.ok).length,
    autoLinkAttemptedCount,
    autoLinkLinkedCount,
    results,
  };
}
