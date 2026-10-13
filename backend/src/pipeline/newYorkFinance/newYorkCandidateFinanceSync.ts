import type { Pool, PoolClient } from "pg";

import {
  classifyFinanceLabel,
  normalizeFinanceLabel,
  type FinanceLabelClassification,
} from "../finance/financeLabelClassifier.js";
import {
  buildFinanceIndustryBreakdownsFromClassifications,
  mergeFinanceLabelClassification,
  resolveFinanceIndustryClassifications,
  type FinanceIndustryClassifier,
} from "../finance/financeIndustryClassificationService.js";
import {
  normalizeNewYorkCandidateNameKeys,
  searchAndResolveNewYorkCandidateCommittee,
  type NewYorkCandidateCommitteeResolution,
} from "./newYorkCandidateCommitteeResolver.js";
import {
  collectNewYorkOutsideSpending,
  type NewYorkOutsideSpendingCounters,
  type NewYorkOutsideSpendingGroup,
} from "./newYorkOutsideSpendingAggregator.js";
import { getNewYorkOutsideGroupFunderBreakdowns } from "./newYorkOutsideGroupContributionAggregator.js";
import {
  collectNewYorkDirectCampaign,
  type NewYorkDirectBreakdown,
} from "./newYorkDirectContributionAggregator.js";
import {
  defaultNewYorkSodaClientOptions,
  type NewYorkCycleYears,
  type NewYorkSodaClientOptions,
} from "./newYorkSodaClient.js";
import {
  replaceNewYorkCandidateFinanceSnapshot,
  type NewYorkFinanceDirectBreakdownInput,
  type NewYorkFinanceLinkInput,
  type NewYorkFinanceOutsideGroupBreakdownInput,
  type NewYorkFinanceOutsideGroupInput,
  type NewYorkFinanceSummaryInput,
} from "./newYorkFinanceWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & Pick<Pool, "connect">;

type NewYorkFinanceDataClient = {
  searchAndResolveCandidateCommittee: typeof searchAndResolveNewYorkCandidateCommittee;
  collectOutsideSpending: typeof collectNewYorkOutsideSpending;
  getOutsideGroupFunderBreakdowns: typeof getNewYorkOutsideGroupFunderBreakdowns;
  collectDirectCampaign: typeof collectNewYorkDirectCampaign;
};

export type NewYorkCandidateFinanceSyncInput = {
  db: ConnectableQueryable;
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district?: string | null;
  sourceUrl?: string | null;
  sodaClientOptions?: NewYorkSodaClientOptions;
  nyClient?: Partial<NewYorkFinanceDataClient>;
  now?: Date;
  dryRun?: boolean;
  outsideMaxGroups?: number;
  outsideMaxFundersPerGroup?: number;
  directMaxBreakdownsPerCategory?: number;
  financeIndustryClassifier?: FinanceIndustryClassifier;
  aiClassificationMinAmount?: number;
  trustedCommittee?: {
    filerId: string;
    filerName: string;
    sourceUrl?: string | null;
  };
};

export type NewYorkCandidateFinanceSyncResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  dryRun: boolean;
  resolution: NewYorkCandidateCommitteeResolution;
  linkWritten: boolean;
  summaryWritten: boolean;
  directBreakdownsWritten: number;
  directContributionTotal: number | null;
  totalDisbursements: number | null;
  directReceiptRowCount: number;
  pacDonorsWritten: number;
  pacReceiptTotal: number | null;
  outsideGroupsWritten: number;
  outsideGroupBreakdownsWritten: number;
  outsideSupportTotal: number | null;
  outsideOpposeTotal: number | null;
  knownOutsideSupportTotal: number | null;
  knownOutsideOpposeTotal: number | null;
  outsideGroupCount: number;
  outsideFunderRowCount: number;
  outsideCounters: NewYorkOutsideSpendingCounters | null;
};

const DEFAULT_AI_CLASSIFICATION_MIN_AMOUNT = 25_000;
const DEFAULT_OUTSIDE_MAX_GROUPS = 20;
const DEFAULT_OUTSIDE_MAX_FUNDERS_PER_GROUP = 20;

const DEFAULT_NY_CLIENT: NewYorkFinanceDataClient = {
  searchAndResolveCandidateCommittee: searchAndResolveNewYorkCandidateCommittee,
  collectOutsideSpending: collectNewYorkOutsideSpending,
  getOutsideGroupFunderBreakdowns: getNewYorkOutsideGroupFunderBreakdowns,
  collectDirectCampaign: collectNewYorkDirectCampaign,
};

type MatchedNewYorkCommitteeResolution = Extract<NewYorkCandidateCommitteeResolution, { status: "matched" }>;

function requireNonEmpty(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmed;
}

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new Error(`Invalid New York finance election year: ${value}`);
  }
  return value;
}

// Statewide offices (Governor, Lieutenant Governor, Attorney General,
// Comptroller) run four-year cycles; Senate and Assembly run two-year cycles.
function toCycleYears(officeScope: string): NewYorkCycleYears {
  return officeScope === "statewide" ? 4 : 2;
}

function normalizeTimestamp(value: Date | undefined): Date {
  const normalized = value ?? new Date();
  if (Number.isNaN(normalized.getTime())) {
    throw new Error("Invalid New York finance sync timestamp");
  }
  return normalized;
}

function normalizeAiClassificationMinAmount(value: number | undefined): number {
  const normalized = value ?? DEFAULT_AI_CLASSIFICATION_MIN_AMOUNT;
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`Invalid New York finance AI classification minimum amount: ${value}`);
  }
  return normalized;
}

function normalizeCandidateNameForStorage(value: string): string {
  return (
    [...normalizeNewYorkCandidateNameKeys(value)][0] ??
    requireNonEmpty(value, "candidate name").replace(/\s+/g, " ").toUpperCase()
  );
}

function toMatchedTrustedCommittee(
  input: NonNullable<NewYorkCandidateFinanceSyncInput["trustedCommittee"]>
): MatchedNewYorkCommitteeResolution {
  return {
    status: "matched",
    filerId: requireNonEmpty(input.filerId, "trusted New York filer id"),
    filerName: requireNonEmpty(input.filerName, "trusted New York filer name"),
    candidateFilerId: "",
    confidence: "exact",
    source: "ny_soda_api",
    sourceUrl: input.sourceUrl ?? null,
  };
}

function toFinanceLink(input: {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeName: string;
  district?: string | null;
  resolution: MatchedNewYorkCommitteeResolution;
  sourceUrl?: string | null;
  verifiedAt: Date;
}): NewYorkFinanceLinkInput {
  return {
    candidateId: requireNonEmpty(input.candidateId, "candidate id"),
    electionId: requireNonEmpty(input.electionId, "election id"),
    electionYear: input.electionYear,
    candidateNameNormalized: normalizeCandidateNameForStorage(input.candidateName),
    officeName: requireNonEmpty(input.officeName, "office name"),
    district: input.district ?? null,
    filerId: requireNonEmpty(input.resolution.filerId, "New York filer id"),
    filerName: requireNonEmpty(input.resolution.filerName, "New York filer name"),
    linkStatus: "active",
    linkSource: "ny_soda_api",
    sourceUrl: input.resolution.sourceUrl ?? input.sourceUrl ?? null,
    lastVerifiedAt: input.verifiedAt,
  };
}

function toOutsideGroups(groups: readonly NewYorkOutsideSpendingGroup[]): NewYorkFinanceOutsideGroupInput[] {
  return groups.map((group) => ({
    filerId: group.filerId,
    filerName: group.filerName,
    supportOppose: group.supportOppose,
    amount: group.amount,
    sourceUrl: group.sourceUrl,
  }));
}

function donorBreakdownKey(input: NewYorkFinanceOutsideGroupBreakdownInput): string {
  const categoryKey =
    input.categoryType === "donor"
      ? normalizeFinanceLabel(input.categoryName, "donor")
      : input.categoryName.trim().toUpperCase();
  return `${input.filerId.trim()}\u0000${input.supportOppose}\u0000${input.categoryType}\u0000${categoryKey}`;
}

function addOutsideBreakdown(
  breakdowns: Map<string, NewYorkFinanceOutsideGroupBreakdownInput>,
  breakdown: NewYorkFinanceOutsideGroupBreakdownInput
): void {
  const key = donorBreakdownKey(breakdown);
  const existing = breakdowns.get(key);
  if (!existing) {
    breakdowns.set(key, breakdown);
    return;
  }
  breakdowns.set(key, {
    ...existing,
    amount: Math.round((existing.amount + breakdown.amount) * 100) / 100,
    contributorCount:
      existing.contributorCount === null ||
      existing.contributorCount === undefined ||
      breakdown.contributorCount === null ||
      breakdown.contributorCount === undefined
        ? existing.contributorCount ?? breakdown.contributorCount ?? null
        : existing.contributorCount + breakdown.contributorCount,
    sourceUrl: existing.sourceUrl ?? breakdown.sourceUrl,
  });
}

function collectOutsideClassifications(
  breakdowns: Iterable<NewYorkFinanceOutsideGroupBreakdownInput>,
  minAmount: number
): Map<string, FinanceLabelClassification> {
  const classifications = new Map<string, FinanceLabelClassification>();
  for (const breakdown of breakdowns) {
    if (breakdown.categoryType !== "donor" || breakdown.amount < minAmount) {
      continue;
    }
    mergeFinanceLabelClassification(
      classifications,
      classifyFinanceLabel({ rawLabel: breakdown.categoryName, labelType: "donor" })
    );
  }
  return classifications;
}

function asClassifiableOutsideBreakdowns(breakdowns: Iterable<NewYorkFinanceOutsideGroupBreakdownInput>) {
  return [...breakdowns].map((breakdown) => ({
    committeeId: breakdown.filerId,
    supportOppose: breakdown.supportOppose,
    categoryType: breakdown.categoryType,
    categoryName: breakdown.categoryName,
    amount: breakdown.amount,
    contributorCount: breakdown.contributorCount,
    sourceUrl: breakdown.sourceUrl,
  }));
}

function collectDirectDonorClassifications(
  breakdowns: readonly NewYorkFinanceDirectBreakdownInput[],
  classifications: Map<string, FinanceLabelClassification>,
  minAmount: number
): void {
  for (const breakdown of breakdowns) {
    if (breakdown.categoryType !== "donor" || breakdown.amount < minAmount) {
      continue;
    }
    mergeFinanceLabelClassification(
      classifications,
      classifyFinanceLabel({ rawLabel: breakdown.categoryName, labelType: "donor" })
    );
  }
}

async function enrichIndustryBreakdowns(input: {
  db: Queryable;
  directBreakdowns: readonly NewYorkFinanceDirectBreakdownInput[];
  outsideGroupBreakdowns: readonly NewYorkFinanceOutsideGroupBreakdownInput[];
  classifier: FinanceIndustryClassifier | undefined;
  aiClassificationMinAmount: number;
  dryRun: boolean;
}): Promise<{
  directBreakdowns: NewYorkFinanceDirectBreakdownInput[];
  outsideGroupBreakdowns: NewYorkFinanceOutsideGroupBreakdownInput[];
  classifications: FinanceLabelClassification[];
}> {
  const breakdowns = new Map<string, NewYorkFinanceOutsideGroupBreakdownInput>();
  for (const breakdown of input.outsideGroupBreakdowns) {
    if (breakdown.categoryType !== "industry") {
      addOutsideBreakdown(breakdowns, breakdown);
    }
  }
  const directBreakdowns = input.directBreakdowns.filter((breakdown) => breakdown.categoryType !== "industry");

  const classifiableOutsideBreakdowns = asClassifiableOutsideBreakdowns(breakdowns.values());
  const classifications = collectOutsideClassifications(breakdowns.values(), input.aiClassificationMinAmount);
  collectDirectDonorClassifications(directBreakdowns, classifications, input.aiClassificationMinAmount);
  await resolveFinanceIndustryClassifications({
    db: input.db,
    directBreakdowns,
    outsideBreakdowns: classifiableOutsideBreakdowns,
    classifications,
    classifier: input.classifier,
    minAmount: input.aiClassificationMinAmount,
    dryRun: input.dryRun,
  });

  const industryBreakdowns = buildFinanceIndustryBreakdownsFromClassifications({
    directBreakdowns,
    outsideBreakdowns: classifiableOutsideBreakdowns,
    classifications,
  });
  for (const breakdown of industryBreakdowns.outsideIndustryBreakdowns) {
    addOutsideBreakdown(breakdowns, {
      filerId: breakdown.committeeId,
      supportOppose: breakdown.supportOppose,
      categoryType: "industry",
      categoryName: breakdown.categoryName,
      amount: breakdown.amount,
      contributorCount: breakdown.contributorCount,
      sourceUrl: breakdown.sourceUrl,
    });
  }

  // Merge classified direct donors into per-industry rows.
  const directIndustryByName = new Map<string, NewYorkFinanceDirectBreakdownInput>();
  for (const breakdown of industryBreakdowns.directIndustryBreakdowns) {
    const existing = directIndustryByName.get(breakdown.categoryName);
    if (existing) {
      existing.amount = Math.round((existing.amount + breakdown.amount) * 100) / 100;
      existing.contributorCount =
        existing.contributorCount === null ||
        existing.contributorCount === undefined ||
        breakdown.contributorCount === null
          ? existing.contributorCount ?? breakdown.contributorCount ?? null
          : existing.contributorCount + breakdown.contributorCount;
      continue;
    }
    directIndustryByName.set(breakdown.categoryName, {
      categoryType: "industry",
      categoryName: breakdown.categoryName,
      amount: breakdown.amount,
      contributorCount: breakdown.contributorCount,
      sourceUrl: breakdown.sourceUrl,
    });
  }

  // Raw "donor" rows stay in the output on purpose: the snapshot writer
  // replaces all rows per sync, and stored donor rows are the classification
  // anchors for industry rows. Ballot lookup only reads contribution_size and
  // industry rows, so donor (and contributor_type) rows never reach clients.
  return {
    directBreakdowns: [...directBreakdowns, ...directIndustryByName.values()],
    outsideGroupBreakdowns: [...breakdowns.values()],
    classifications: [...classifications.values()],
  };
}

function toSummary(input: {
  // Uncapped totals from the aggregator: the groups array may be capped at
  // maxGroups, and a field named "total" must cover every accepted group.
  supportTotal: number | null;
  opposeTotal: number | null;
  directContributionTotal: number;
  totalDisbursements: number | null;
  sourceUrl?: string | null;
}): NewYorkFinanceSummaryInput {
  // total_receipts mirrors the schedule A-D contribution sum; NYSBOE has no
  // separate receipts rollup in this dataset. cash_on_hand needs opening
  // balances the transaction data does not carry, so it stays null.
  return {
    totalReceipts: input.directContributionTotal,
    directContributionTotal: input.directContributionTotal,
    totalDisbursements: input.totalDisbursements,
    outsideSupportTotal: input.supportTotal,
    outsideOpposeTotal: input.opposeTotal,
    sourceUrl: input.sourceUrl ?? null,
  };
}

function emptyResult(input: {
  candidateId: string;
  electionId: string;
  electionYear: number;
  dryRun: boolean;
  resolution: NewYorkCandidateCommitteeResolution;
}): NewYorkCandidateFinanceSyncResult {
  return {
    candidateId: input.candidateId,
    electionId: input.electionId,
    electionYear: input.electionYear,
    dryRun: input.dryRun,
    resolution: input.resolution,
    linkWritten: false,
    summaryWritten: false,
    directBreakdownsWritten: 0,
    directContributionTotal: null,
    totalDisbursements: null,
    directReceiptRowCount: 0,
    pacDonorsWritten: 0,
    pacReceiptTotal: null,
    outsideGroupsWritten: 0,
    outsideGroupBreakdownsWritten: 0,
    outsideSupportTotal: null,
    outsideOpposeTotal: null,
    knownOutsideSupportTotal: null,
    knownOutsideOpposeTotal: null,
    outsideGroupCount: 0,
    outsideFunderRowCount: 0,
    outsideCounters: null,
  };
}

export async function syncNewYorkCandidateFinance(
  input: NewYorkCandidateFinanceSyncInput
): Promise<NewYorkCandidateFinanceSyncResult> {
  const candidateId = requireNonEmpty(input.candidateId, "candidate id");
  const electionId = requireNonEmpty(input.electionId, "election id");
  const candidateName = requireNonEmpty(input.candidateName, "candidate name");
  const officeScope = requireNonEmpty(input.officeScope, "office scope");
  const officeName = requireNonEmpty(input.officeName, "office name");
  const electionYear = normalizeElectionYear(input.electionYear);
  const syncedAt = normalizeTimestamp(input.now);
  const dryRun = input.dryRun === true;
  const cycleYears = toCycleYears(officeScope);
  const nyClient: NewYorkFinanceDataClient = { ...DEFAULT_NY_CLIENT, ...(input.nyClient ?? {}) };
  const sodaClientOptions = input.sodaClientOptions ?? defaultNewYorkSodaClientOptions();
  const aiClassificationMinAmount = normalizeAiClassificationMinAmount(input.aiClassificationMinAmount);

  const resolution = input.trustedCommittee
    ? toMatchedTrustedCommittee(input.trustedCommittee)
    : await nyClient.searchAndResolveCandidateCommittee(
        {
          candidateName,
          officeScope,
          officeName,
          electionYear,
          district: input.district,
        },
        sodaClientOptions
      );

  if (resolution.status !== "matched") {
    return emptyResult({ candidateId, electionId, electionYear, dryRun, resolution });
  }

  const outside = await nyClient.collectOutsideSpending(
    {
      candidateName,
      officeScope,
      officeName,
      electionYear,
      district: input.district,
      maxGroups: input.outsideMaxGroups ?? DEFAULT_OUTSIDE_MAX_GROUPS,
    },
    sodaClientOptions
  );

  // A group's own receipts are fetched once per filer even when the same
  // committee appears on both the support and oppose side.
  const funderResultsByFiler = new Map<string, Awaited<ReturnType<typeof getNewYorkOutsideGroupFunderBreakdowns>>>();
  let outsideFunderRowCount = 0;
  const rawOutsideBreakdowns: NewYorkFinanceOutsideGroupBreakdownInput[] = [];
  for (const group of outside.groups) {
    let funderResult = funderResultsByFiler.get(group.filerId);
    if (!funderResult) {
      funderResult = await nyClient.getOutsideGroupFunderBreakdowns(
        {
          filerId: group.filerId,
          electionYear,
          cycleYears,
          maxFunders: input.outsideMaxFundersPerGroup ?? DEFAULT_OUTSIDE_MAX_FUNDERS_PER_GROUP,
        },
        sodaClientOptions
      );
      funderResultsByFiler.set(group.filerId, funderResult);
      outsideFunderRowCount += funderResult.organizationRowCount;
    }
    for (const funder of funderResult.funders) {
      rawOutsideBreakdowns.push({
        filerId: group.filerId,
        supportOppose: group.supportOppose,
        categoryType: funder.categoryType,
        categoryName: funder.categoryName,
        amount: funder.amount,
        contributorCount: funder.contributorCount,
        sourceUrl: funder.sourceUrl ?? group.sourceUrl ?? null,
      });
    }
  }

  const direct = await nyClient.collectDirectCampaign(
    {
      filerId: resolution.filerId,
      electionYear,
      cycleYears,
      maxBreakdownsPerCategory: input.directMaxBreakdownsPerCategory,
    },
    sodaClientOptions
  );
  const rawDirectBreakdowns: NewYorkFinanceDirectBreakdownInput[] = direct.breakdowns.map((breakdown) => ({
    categoryType: breakdown.categoryType,
    categoryName: breakdown.categoryName,
    amount: breakdown.amount,
    contributorCount: breakdown.contributorCount,
    sourceUrl: breakdown.sourceUrl,
  }));

  const industryFinance = await enrichIndustryBreakdowns({
    db: input.db,
    directBreakdowns: rawDirectBreakdowns,
    outsideGroupBreakdowns: rawOutsideBreakdowns,
    classifier: input.financeIndustryClassifier,
    aiClassificationMinAmount,
    dryRun,
  });
  const summary = toSummary({
    // Regular Schedule R's accepted allocations are a known subset, not
    // complete overall outside spending (unresolved parents/rapid reports).
    supportTotal: null,
    opposeTotal: null,
    directContributionTotal: direct.directContributionTotal,
    totalDisbursements: direct.totalDisbursements,
    sourceUrl: input.sourceUrl ?? resolution.sourceUrl,
  });
  const writerOutsideGroups = toOutsideGroups(outside.groups);
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
    await replaceNewYorkCandidateFinanceSnapshot({
      db: input.db,
      link,
      syncedAt,
      summary,
      directBreakdowns: industryFinance.directBreakdowns,
      pacDonors: direct.pacDonors,
      outsideGroups: writerOutsideGroups.length > 0 ? writerOutsideGroups : undefined,
      outsideGroupBreakdowns: writerOutsideGroups.length > 0 ? industryFinance.outsideGroupBreakdowns : undefined,
      outsideWriteMode: "upsert",
      classifications: industryFinance.classifications,
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
    directBreakdownsWritten: dryRun ? 0 : industryFinance.directBreakdowns.length,
    directContributionTotal: direct.directContributionTotal,
    totalDisbursements: direct.totalDisbursements,
    directReceiptRowCount: direct.receiptRowCount,
    pacDonorsWritten: dryRun ? 0 : direct.pacDonors.length,
    pacReceiptTotal: Math.round(direct.pacDonors.reduce((sum, donor) => sum + Math.round(donor.amount * 100), 0)) / 100,
    outsideGroupsWritten: dryRun ? 0 : writerOutsideGroups.length,
    outsideGroupBreakdownsWritten: dryRun ? 0 : industryFinance.outsideGroupBreakdowns.length,
    outsideSupportTotal: summary.outsideSupportTotal ?? null,
    outsideOpposeTotal: summary.outsideOpposeTotal ?? null,
    knownOutsideSupportTotal: outside.supportTotal > 0 ? outside.supportTotal : null,
    knownOutsideOpposeTotal: outside.opposeTotal > 0 ? outside.opposeTotal : null,
    outsideGroupCount: outside.groups.length,
    outsideFunderRowCount,
    outsideCounters: outside.counters,
  };
}
