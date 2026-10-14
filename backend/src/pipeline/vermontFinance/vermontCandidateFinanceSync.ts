import type { Pool, PoolClient } from "pg";

import {
  getVermontContributionDetails,
  getVermontExpenditureDetails,
  type VermontCampaignFinanceClientOptions,
  type VermontContributionRow,
  type VermontExpenditureRow,
  type VermontPagedResult,
  type VermontTransactionSearchInput,
} from "./vermontCampaignFinanceClient.js";
import {
  normalizeVermontCandidateNameKeys,
  searchAndResolveVermontCandidateCommittee,
  type VermontCandidateCommitteeMatch,
  type VermontCandidateCommitteeResolution,
} from "./vermontCandidateCommitteeResolver.js";
import { aggregateVermontDirectContributions } from "./vermontDirectContributionAggregator.js";
import {
  fetchAndAggregateVermontOutsideGroupContributions,
  type VermontOutsideGroupContributionFetchAndAggregationResult,
} from "./vermontOutsideGroupContributionAggregator.js";
import { aggregateVermontOutsideSpending } from "./vermontOutsideSpendingAggregator.js";
import {
  fetchAllVermontTransactionRows as fetchAllTransactionRows,
  VermontCensusMovedError,
} from "./vermontTransactionPaging.js";
import {
  replaceVermontCandidateFinanceSnapshot,
  type VermontFinanceDirectBreakdownInput,
  type VermontFinanceLinkInput,
  type VermontFinanceOutsideGroupInput,
  type VermontFinanceSummaryInput,
} from "./vermontFinanceWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & Pick<Pool, "connect">;

type VermontCampaignFinanceDataClient = {
  searchAndResolveCandidateCommittee: (
    input: {
      candidateName: string;
      officeScope: string;
      officeName: string;
      district?: string | null;
      electionYear: number;
    },
    options?: VermontCampaignFinanceClientOptions
  ) => Promise<VermontCandidateCommitteeResolution>;
  getContributionDetails: (
    input?: VermontTransactionSearchInput,
    options?: VermontCampaignFinanceClientOptions
  ) => Promise<VermontPagedResult<VermontContributionRow>>;
  getExpenditureDetails: (
    input?: VermontTransactionSearchInput,
    options?: VermontCampaignFinanceClientOptions
  ) => Promise<VermontPagedResult<VermontExpenditureRow>>;
  fetchAndAggregateOutsideGroupContributions: typeof fetchAndAggregateVermontOutsideGroupContributions;
};

export type VermontCandidateFinanceSyncInput = {
  db: ConnectableQueryable;
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district?: string | null;
  sourceUrl?: string | null;
  vermontClientOptions?: VermontCampaignFinanceClientOptions;
  vermontClient?: Partial<VermontCampaignFinanceDataClient>;
  now?: Date;
  dryRun?: boolean;
  pageSize?: number;
  maxPages?: number;
  directMaxBreakdownsPerCategory?: number;
  outsideMaxGroups?: number;
  outsideMaxBreakdownsPerCategory?: number;
  outsideGroupMaxPagesPerGroup?: number;
  aiClassificationMinAmount?: number;
  trustedCommittee?: {
    filerRegistrationGuid: string;
    filerName: string;
    entityId?: number | null;
    sourceUrl?: string | null;
  };
};

type VermontCandidateFinanceSyncResolution =
  | VermontCandidateCommitteeResolution
  | ({ status: "matched" } & VermontCandidateCommitteeMatch);

export type VermontCandidateFinanceSyncResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  dryRun: boolean;
  resolution: VermontCandidateFinanceSyncResolution;
  linkWritten: boolean;
  summaryWritten: boolean;
  directBreakdownsWritten: number;
  outsideGroupsWritten: number;
  outsideGroupBreakdownsWritten: number;
  totalReceipts: number | null;
  directContributionTotal: number | null;
  outsideSupportTotal: number | null;
  outsideOpposeTotal: number | null;
  matchedContributionRowCount: number;
  includedContributionRowCount: number;
  skippedContributionRowCount: number;
  matchedExpenditureRowCount: number;
  includedExpenditureRowCount: number;
  skippedExpenditureRowCount: number;
  matchedOutsideContributionRowCount: number;
  includedOutsideContributionRowCount: number;
  skippedOutsideContributionRowCount: number;
  fetchedContributionRowCount: number;
  fetchedExpenditureRowCount: number;
  fetchedOutsideContributionRowCount: number;
};

const VERMONT_CAMPAIGN_FINANCE_SOURCE_URL = "https://campaignfinance.vermont.gov/";
const DEFAULT_PAGE_SIZE = 1_000;
const DEFAULT_MAX_PAGES = 25;
const DEFAULT_MAX_BREAKDOWNS_PER_CATEGORY = 20;
const DEFAULT_AI_CLASSIFICATION_MIN_AMOUNT = 25_000;

const DEFAULT_VERMONT_CLIENT: VermontCampaignFinanceDataClient = {
  searchAndResolveCandidateCommittee: searchAndResolveVermontCandidateCommittee,
  getContributionDetails: getVermontContributionDetails,
  getExpenditureDetails: getVermontExpenditureDetails,
  fetchAndAggregateOutsideGroupContributions: fetchAndAggregateVermontOutsideGroupContributions,
};

type MatchedVermontCommitteeResolution = Extract<VermontCandidateFinanceSyncResolution, { status: "matched" }>;

function requireNonEmpty(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmed;
}

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new Error(`Invalid Vermont finance election year: ${value}`);
  }
  return value;
}

function normalizeTimestamp(value: Date | undefined): Date {
  const normalized = value ?? new Date();
  if (Number.isNaN(normalized.getTime())) {
    throw new Error("Invalid Vermont finance sync timestamp");
  }
  return normalized;
}

function normalizePositiveInteger(value: number | undefined, fallback: number, fieldName: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Vermont finance ${fieldName}: ${value}`);
  }
  return normalized;
}

function normalizeNonnegativeAmount(value: number | undefined, fallback: number, fieldName: string): number {
  const normalized = value ?? fallback;
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`Invalid Vermont finance ${fieldName}: ${value}`);
  }
  return normalized;
}

function normalizeCandidateNameForStorage(value: string): string {
  return [...normalizeVermontCandidateNameKeys(value)][0] ?? requireNonEmpty(value, "candidate name").replace(/\s+/g, " ").toUpperCase();
}

function mergeVermontClient(client: Partial<VermontCampaignFinanceDataClient> | undefined): VermontCampaignFinanceDataClient {
  return { ...DEFAULT_VERMONT_CLIENT, ...(client ?? {}) };
}

/** Restart the statewide query when filings change its count; never combine attempts. */
async function fetchStableExpenditureRows(
  fetchCensus: () => Promise<VermontExpenditureRow[]>
): Promise<VermontExpenditureRow[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchCensus();
    } catch (error) {
      if (!(error instanceof VermontCensusMovedError) || attempt >= 3) throw error;
    }
  }
}

function toMatchedTrustedCommittee(
  input: NonNullable<VermontCandidateFinanceSyncInput["trustedCommittee"]>,
  electionYear: number
): MatchedVermontCommitteeResolution {
  return {
    status: "matched",
    filerRegistrationGuid: requireNonEmpty(input.filerRegistrationGuid, "trusted Vermont filer registration guid"),
    filerName: requireNonEmpty(input.filerName, "trusted Vermont filer name"),
    candidateName: null,
    officeId: 0,
    officeName: "",
    officeDisplayName: "",
    electionYear,
    electionId: null,
    entityId: input.entityId ?? null,
    reportName: null,
    confidence: "exact",
    source: "vermont_public_transactions",
    sourceUrl: input.sourceUrl ?? VERMONT_CAMPAIGN_FINANCE_SOURCE_URL,
    matchedTransactionRowCount: 0,
  };
}

function toFinanceLink(input: {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeName: string;
  district?: string | null;
  resolution: MatchedVermontCommitteeResolution;
  sourceUrl?: string | null;
  verifiedAt: Date;
}): VermontFinanceLinkInput {
  return {
    candidateId: requireNonEmpty(input.candidateId, "candidate id"),
    electionId: requireNonEmpty(input.electionId, "election id"),
    electionYear: input.electionYear,
    candidateNameNormalized: normalizeCandidateNameForStorage(input.candidateName),
    officeName: requireNonEmpty(input.officeName, "office name"),
    district: input.district ?? null,
    filerRegistrationGuid: requireNonEmpty(input.resolution.filerRegistrationGuid, "Vermont filer registration guid"),
    entityId: input.resolution.entityId ?? null,
    filerName: requireNonEmpty(input.resolution.filerName, "Vermont filer name"),
    linkStatus: "active",
    linkSource: "vermont_public_transactions",
    sourceUrl: input.resolution.sourceUrl ?? input.sourceUrl ?? VERMONT_CAMPAIGN_FINANCE_SOURCE_URL,
    lastVerifiedAt: input.verifiedAt,
  };
}

function toDirectBreakdowns(
  breakdowns: readonly VermontFinanceDirectBreakdownInput[]
): VermontFinanceDirectBreakdownInput[] {
  return breakdowns.map((breakdown) => ({
    categoryType: breakdown.categoryType,
    categoryName: breakdown.categoryName,
    amount: breakdown.amount,
    contributorCount: breakdown.contributorCount ?? null,
    sourceUrl: breakdown.sourceUrl ?? null,
  }));
}

function toOutsideGroups(groups: readonly VermontFinanceOutsideGroupInput[]): VermontFinanceOutsideGroupInput[] {
  return groups.map((group) => ({
    filerRegistrationGuid: group.filerRegistrationGuid,
    filerName: group.filerName,
    supportOppose: group.supportOppose,
    supportMechanism: group.supportMechanism ?? "vt_pac_contribution_to_registrant",
    amount: group.amount,
    sourceUrl: group.sourceUrl ?? null,
  }));
}

function toSummary(input: {
  directSummary: { totalReceipts: number; directContributionTotal: number; sourceUrl: string | null };
  outsideSummary: { outsideSupportTotal: number; outsideOpposeTotal: number; sourceUrl: string | null };
  fallbackSourceUrl?: string | null;
}): VermontFinanceSummaryInput {
  return {
    totalReceipts: input.directSummary.totalReceipts,
    directContributionTotal: input.directSummary.directContributionTotal,
    // The public transaction-detail endpoints do not expose reliable aggregate disbursement
    // or cash-on-hand values, so those summary columns intentionally remain null.
    outsideSupportTotal: input.outsideSummary.outsideSupportTotal,
    outsideOpposeTotal: input.outsideSummary.outsideOpposeTotal,
    sourceUrl: input.directSummary.sourceUrl ?? input.outsideSummary.sourceUrl ?? input.fallbackSourceUrl ?? null,
  };
}

function emptyResult(input: {
  candidateId: string;
  electionId: string;
  electionYear: number;
  dryRun: boolean;
  resolution: VermontCandidateFinanceSyncResolution;
}): VermontCandidateFinanceSyncResult {
  return {
    candidateId: input.candidateId,
    electionId: input.electionId,
    electionYear: input.electionYear,
    dryRun: input.dryRun,
    resolution: input.resolution,
    linkWritten: false,
    summaryWritten: false,
    directBreakdownsWritten: 0,
    outsideGroupsWritten: 0,
    outsideGroupBreakdownsWritten: 0,
    totalReceipts: null,
    directContributionTotal: null,
    outsideSupportTotal: null,
    outsideOpposeTotal: null,
    matchedContributionRowCount: 0,
    includedContributionRowCount: 0,
    skippedContributionRowCount: 0,
    matchedExpenditureRowCount: 0,
    includedExpenditureRowCount: 0,
    skippedExpenditureRowCount: 0,
    matchedOutsideContributionRowCount: 0,
    includedOutsideContributionRowCount: 0,
    skippedOutsideContributionRowCount: 0,
    fetchedContributionRowCount: 0,
    fetchedExpenditureRowCount: 0,
    fetchedOutsideContributionRowCount: 0,
  };
}

export async function syncVermontCandidateFinance(
  input: VermontCandidateFinanceSyncInput
): Promise<VermontCandidateFinanceSyncResult> {
  const candidateId = requireNonEmpty(input.candidateId, "candidate id");
  const electionId = requireNonEmpty(input.electionId, "election id");
  const candidateName = requireNonEmpty(input.candidateName, "candidate name");
  const officeScope = requireNonEmpty(input.officeScope, "office scope");
  const officeName = requireNonEmpty(input.officeName, "office name");
  const electionYear = normalizeElectionYear(input.electionYear);
  const syncedAt = normalizeTimestamp(input.now);
  const dryRun = input.dryRun === true;
  const pageSize = normalizePositiveInteger(input.pageSize, DEFAULT_PAGE_SIZE, "pageSize");
  const maxPages = normalizePositiveInteger(input.maxPages, DEFAULT_MAX_PAGES, "maxPages");
  const aiClassificationMinAmount = normalizeNonnegativeAmount(
    input.aiClassificationMinAmount,
    DEFAULT_AI_CLASSIFICATION_MIN_AMOUNT,
    "AI classification minimum amount"
  );
  const client = mergeVermontClient(input.vermontClient);

  const resolution = input.trustedCommittee
    ? toMatchedTrustedCommittee(input.trustedCommittee, electionYear)
    : await client.searchAndResolveCandidateCommittee(
        {
          candidateName,
          officeScope,
          officeName,
          district: input.district,
          electionYear,
        },
        input.vermontClientOptions
      );

  if (resolution.status !== "matched") {
    return emptyResult({ candidateId, electionId, electionYear, dryRun, resolution });
  }

  const contributionRows = await fetchAllTransactionRows({
    pageSize,
    maxPages,
    fetchPage: (pageNumber) =>
      client.getContributionDetails(
        {
          pageNumber,
          pageSize,
          filerRegistrationGuid: resolution.filerRegistrationGuid,
          electionYear,
          transactionTypeCode: "TCON",
        },
        input.vermontClientOptions
      ),
  });
  const expenditureRows = await fetchStableExpenditureRows(() =>
    fetchAllTransactionRows({
      pageSize,
      maxPages,
      fetchPage: (pageNumber) =>
        client.getExpenditureDetails(
          {
            pageNumber,
            pageSize,
            electionYear,
            transactionTypeCode: "TEXP",
          },
          input.vermontClientOptions
        ),
    })
  );

  const directFinance = aggregateVermontDirectContributions({
    filerRegistrationGuid: resolution.filerRegistrationGuid,
    electionYear,
    contributionRows,
    sourceUrl: input.sourceUrl ?? resolution.sourceUrl ?? VERMONT_CAMPAIGN_FINANCE_SOURCE_URL,
    maxBreakdownsPerCategory: input.directMaxBreakdownsPerCategory ?? DEFAULT_MAX_BREAKDOWNS_PER_CATEGORY,
  });
  const outsideFinance = aggregateVermontOutsideSpending({
    candidateName,
    candidateEntityId: resolution.entityId,
    electionYear,
    expenditureRows,
    sourceUrl: input.sourceUrl ?? VERMONT_CAMPAIGN_FINANCE_SOURCE_URL,
    maxGroups: input.outsideMaxGroups ?? DEFAULT_MAX_BREAKDOWNS_PER_CATEGORY,
  });
  const outsideGroupBreakdowns: VermontOutsideGroupContributionFetchAndAggregationResult =
    await client.fetchAndAggregateOutsideGroupContributions(
      {
        electionYear,
        outsideGroups: outsideFinance.summary.groups,
        sourceUrl: input.sourceUrl ?? VERMONT_CAMPAIGN_FINANCE_SOURCE_URL,
        maxBreakdownsPerCategory: input.outsideMaxBreakdownsPerCategory ?? DEFAULT_MAX_BREAKDOWNS_PER_CATEGORY,
        minIndustryAmount: aiClassificationMinAmount,
        pageSize,
        maxPagesPerGroup: input.outsideGroupMaxPagesPerGroup,
      },
      input.vermontClientOptions
    );
  const summary = toSummary({
    directSummary: directFinance.summary,
    outsideSummary: outsideFinance.summary,
    fallbackSourceUrl: input.sourceUrl ?? resolution.sourceUrl ?? VERMONT_CAMPAIGN_FINANCE_SOURCE_URL,
  });
  const directBreakdowns = toDirectBreakdowns(directFinance.directBreakdowns);
  const outsideGroups = toOutsideGroups(outsideFinance.summary.groups);
  // Pre-cap classifications from the aggregator, so donors past the display
  // cap still reach the manual label queue.
  const classifications = outsideGroupBreakdowns.outsideDonorClassifications;
  const link = toFinanceLink({
    candidateId,
    electionId,
    candidateName,
    electionYear,
    officeName,
    district: input.district,
    resolution,
    sourceUrl: input.sourceUrl,
    verifiedAt: syncedAt,
  });

  if (!dryRun) {
    await replaceVermontCandidateFinanceSnapshot({
      db: input.db,
      link,
      syncedAt,
      summary,
      directBreakdowns,
      outsideGroups,
      outsideGroupBreakdowns: outsideGroupBreakdowns.outsideGroupBreakdowns,
      classifications,
    });
  }

  return {
    candidateId,
    electionId,
    electionYear,
    dryRun,
    resolution,
    linkWritten: !dryRun,
    summaryWritten: !dryRun,
    directBreakdownsWritten: dryRun ? 0 : directBreakdowns.length,
    outsideGroupsWritten: dryRun ? 0 : outsideGroups.length,
    outsideGroupBreakdownsWritten: dryRun ? 0 : outsideGroupBreakdowns.outsideGroupBreakdowns.length,
    totalReceipts: summary.totalReceipts ?? null,
    directContributionTotal: summary.directContributionTotal ?? null,
    outsideSupportTotal: summary.outsideSupportTotal ?? null,
    outsideOpposeTotal: summary.outsideOpposeTotal ?? null,
    matchedContributionRowCount: directFinance.matchedContributionRowCount,
    includedContributionRowCount: directFinance.includedContributionRowCount,
    skippedContributionRowCount: directFinance.skippedContributionRowCount,
    matchedExpenditureRowCount: outsideFinance.matchedExpenditureRowCount,
    includedExpenditureRowCount: outsideFinance.includedExpenditureRowCount,
    skippedExpenditureRowCount: outsideFinance.skippedExpenditureRowCount,
    matchedOutsideContributionRowCount: outsideGroupBreakdowns.matchedContributionRowCount,
    includedOutsideContributionRowCount: outsideGroupBreakdowns.includedContributionRowCount,
    skippedOutsideContributionRowCount: outsideGroupBreakdowns.skippedContributionRowCount,
    fetchedContributionRowCount: contributionRows.length,
    fetchedExpenditureRowCount: expenditureRows.length,
    fetchedOutsideContributionRowCount: outsideGroupBreakdowns.fetchedContributionRowCount,
  };
}
