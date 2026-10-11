import type { Pool, PoolClient } from "pg";

import {
  type FinanceLabelClassification,
  classifyFinanceLabel,
  normalizeFinanceLabel,
} from "../finance/financeLabelClassifier.js";
import {
  buildFinanceIndustryBreakdownsFromClassifications,
  mergeFinanceLabelClassification,
  resolveFinanceIndustryClassifications,
  type FinanceIndustryClassifier,
} from "../finance/financeIndustryClassificationService.js";
import {
  normalizePennsylvaniaCandidateNameForStorage,
  resolvePennsylvaniaCandidateCommittee,
  type PennsylvaniaCandidateCommitteeResolution,
} from "./pennsylvaniaCandidateCommitteeResolver.js";
import {
  aggregatePennsylvaniaDirectContributions,
  type PennsylvaniaDirectContributionAggregationResult,
} from "./pennsylvaniaDirectContributionAggregator.js";
import {
  deactivatePennsylvaniaFinanceLinksForCandidateElection,
  replacePennsylvaniaCandidateFinanceSnapshot,
  type PennsylvaniaFinanceLinkInput,
  type PennsylvaniaFinanceOutsideGroupBreakdownInput,
  type PennsylvaniaFinanceOutsideGroupInput,
  type PennsylvaniaFinanceSummaryInput,
} from "./pennsylvaniaFinanceWriter.js";
import {
  aggregatePennsylvaniaOutsideGroupContributions,
  resolvePennsylvaniaOutsideGroupsForContributionAggregation,
  type PennsylvaniaFinanceOutsideGroupBreakdown,
  type PennsylvaniaOutsideSpendingGroup,
} from "./pennsylvaniaOutsideGroupContributionAggregator.js";
import type {
  PennsylvaniaCampaignFinanceContributionRow,
  PennsylvaniaCampaignFinanceFilerRow,
} from "./pennsylvaniaCampaignFinanceReader.js";

type Queryable = Pick<Pool | PoolClient, "query">;

const DEFAULT_AI_CLASSIFICATION_MIN_AMOUNT = 25_000;
// Display cap on PERSISTED donor rows per (group, direction), applied AFTER
// classification so a >cap-donor group still gets industry totals built from
// every donor. Industry rows are bounded by the slug set and are never capped.
const DEFAULT_MAX_BREAKDOWNS_PER_CATEGORY = 50;

export type PennsylvaniaCandidateFinanceSyncInput = {
  db: Queryable;
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district?: string | null;
  filerRows: readonly PennsylvaniaCampaignFinanceFilerRow[];
  contributionRows: readonly PennsylvaniaCampaignFinanceContributionRow[];
  sourceUrl?: string | null;
  contributionSourceUrl?: string | null;
  now?: Date;
  dryRun?: boolean;
  directMaxBreakdownsPerCategory?: number;
  outsideGroups?: readonly PennsylvaniaOutsideSpendingGroup[];
  // Display cap on persisted donor rows per (group, direction);
  // classification always sees every donor.
  outsideMaxBreakdownsPerCategory?: number;
  outsideMinIndustryAmount?: number;
  financeIndustryClassifier?: FinanceIndustryClassifier;
  aiClassificationMinAmount?: number;
  trustedFiler?: {
    filerId: string;
    filerName: string;
    sourceUrl?: string | null;
  };
};

export type PennsylvaniaCandidateFinanceSyncResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  dryRun: boolean;
  resolution: PennsylvaniaCandidateCommitteeResolution;
  linkWritten: boolean;
  summaryWritten: boolean;
  directBreakdownsWritten: number;
  pacDonorsWritten: number;
  outsideGroupsWritten: number;
  outsideGroupBreakdownsWritten: number;
  totalReceipts: number | null;
  directContributionTotal: number | null;
  outsideSupportTotal: number | null;
  outsideOpposeTotal: number | null;
  matchedContributionRowCount: number;
  includedContributionEventCount: number;
  skippedContributionEventCount: number;
  matchedOutsideContributionRowCount: number;
  includedOutsideContributionEventCount: number;
  skippedOutsideContributionEventCount: number;
};

function requireNonEmpty(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmed;
}

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new Error(`Invalid Pennsylvania finance election year: ${value}`);
  }
  return value;
}

function normalizeTimestamp(value: Date | undefined): Date {
  const normalized = value ?? new Date();
  if (Number.isNaN(normalized.getTime())) {
    throw new Error("Invalid Pennsylvania finance sync timestamp");
  }
  return normalized;
}

function normalizeAiClassificationMinAmount(value: number | undefined): number {
  const normalized = value ?? DEFAULT_AI_CLASSIFICATION_MIN_AMOUNT;
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error("Pennsylvania finance aiClassificationMinAmount must be a nonnegative number");
  }
  return normalized;
}

function normalizeMaxDonorBreakdowns(value: number | undefined): number {
  const normalized = value ?? DEFAULT_MAX_BREAKDOWNS_PER_CATEGORY;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Pennsylvania finance outsideMaxBreakdownsPerCategory: ${value}`);
  }
  return normalized;
}

function capDonorBreakdowns(
  breakdowns: readonly PennsylvaniaFinanceOutsideGroupBreakdownInput[],
  maxDonorsPerGroup: number
): PennsylvaniaFinanceOutsideGroupBreakdownInput[] {
  const donorsByGroup = new Map<string, PennsylvaniaFinanceOutsideGroupBreakdownInput[]>();
  for (const breakdown of breakdowns) {
    if (breakdown.categoryType !== "donor") {
      continue;
    }
    const key = `${breakdown.groupId.trim().toUpperCase()}\u0000${breakdown.supportOppose}`;
    const list = donorsByGroup.get(key) ?? [];
    list.push(breakdown);
    donorsByGroup.set(key, list);
  }
  const kept = new Set<PennsylvaniaFinanceOutsideGroupBreakdownInput>();
  for (const list of donorsByGroup.values()) {
    for (const donor of list
      .sort((left, right) => right.amount - left.amount || left.categoryName.localeCompare(right.categoryName))
      .slice(0, maxDonorsPerGroup)) {
      kept.add(donor);
    }
  }
  return breakdowns.filter((breakdown) => breakdown.categoryType !== "donor" || kept.has(breakdown));
}

function toFinanceLink(input: {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeName: string;
  district?: string | null;
  filerId: string;
  filerName: string;
  sourceUrl?: string | null;
  verifiedAt: Date;
}): PennsylvaniaFinanceLinkInput {
  return {
    candidateId: requireNonEmpty(input.candidateId, "candidate id"),
    electionId: requireNonEmpty(input.electionId, "election id"),
    electionYear: input.electionYear,
    candidateNameNormalized: normalizePennsylvaniaCandidateNameForStorage(input.candidateName),
    officeName: requireNonEmpty(input.officeName, "office name"),
    district: input.district ?? null,
    filerId: requireNonEmpty(input.filerId, "Pennsylvania filer id").toUpperCase(),
    filerName: requireNonEmpty(input.filerName, "Pennsylvania filer name"),
    linkStatus: "active",
    linkSource: "pa_bulk",
    sourceUrl: input.sourceUrl ?? null,
    lastVerifiedAt: input.verifiedAt,
  };
}

function aggregateDirect(input: {
  filerId: string;
  electionYear: number;
  contributionRows: readonly PennsylvaniaCampaignFinanceContributionRow[];
  filerRows: readonly PennsylvaniaCampaignFinanceFilerRow[];
  contributionSourceUrl?: string | null;
  maxBreakdownsPerCategory?: number;
}): PennsylvaniaDirectContributionAggregationResult {
  return aggregatePennsylvaniaDirectContributions({
    filerId: input.filerId,
    electionYear: input.electionYear,
    contributionRows: input.contributionRows,
    filerRows: input.filerRows,
    sourceUrl: input.contributionSourceUrl ?? null,
    maxBreakdownsPerCategory: input.maxBreakdownsPerCategory,
  });
}

function toSummary(input: {
  directFinance: PennsylvaniaDirectContributionAggregationResult;
  outsideGroups: readonly PennsylvaniaOutsideSpendingGroup[] | undefined;
  fallbackSourceUrl?: string | null;
}): PennsylvaniaFinanceSummaryInput {
  let outsideSupportTotal = 0;
  let outsideOpposeTotal = 0;
  for (const group of input.outsideGroups ?? []) {
    if (group.supportOppose === "support") {
      outsideSupportTotal += group.amount;
    } else {
      outsideOpposeTotal += group.amount;
    }
  }
  return {
    totalReceipts: input.directFinance.summary.totalReceipts,
    directContributionTotal: input.directFinance.summary.directContributionTotal,
    outsideSupportTotal: input.outsideGroups ? Math.round(outsideSupportTotal * 100) / 100 : null,
    outsideOpposeTotal: input.outsideGroups ? Math.round(outsideOpposeTotal * 100) / 100 : null,
    sourceUrl: input.directFinance.summary.sourceUrl ?? input.fallbackSourceUrl ?? null,
  };
}

function toOutsideGroups(
  outsideGroups: readonly PennsylvaniaOutsideSpendingGroup[] | undefined
): PennsylvaniaFinanceOutsideGroupInput[] | undefined {
  return outsideGroups?.map((group) => ({
    groupId: group.groupId,
    groupName: group.groupName,
    supportOppose: group.supportOppose,
    amount: group.amount,
    sourceUrl: group.sourceUrl,
  }));
}

function toWriterOutsideBreakdown(
  breakdown: PennsylvaniaFinanceOutsideGroupBreakdown
): PennsylvaniaFinanceOutsideGroupBreakdownInput {
  return {
    groupId: breakdown.groupId,
    supportOppose: breakdown.supportOppose,
    categoryType: breakdown.categoryType,
    categoryName: breakdown.categoryName,
    amount: breakdown.amount,
    contributorCount: breakdown.contributorCount,
    sourceUrl: breakdown.sourceUrl,
  };
}

function toOutsideGroupBreakdowns(input: {
  outsideGroups: readonly PennsylvaniaOutsideSpendingGroup[] | undefined;
  filerRows: readonly PennsylvaniaCampaignFinanceFilerRow[];
  contributionRows: readonly PennsylvaniaCampaignFinanceContributionRow[];
  contributionSourceUrl?: string | null;
  electionYear: number;
  minIndustryAmount?: number;
}): {
  breakdowns: PennsylvaniaFinanceOutsideGroupBreakdownInput[] | undefined;
  matchedContributionRowCount: number;
  includedContributionEventCount: number;
  skippedContributionEventCount: number;
} {
  if (!input.outsideGroups) {
    return {
      breakdowns: undefined,
      matchedContributionRowCount: 0,
      includedContributionEventCount: 0,
      skippedContributionEventCount: 0,
    };
  }

  const result = aggregatePennsylvaniaOutsideGroupContributions({
    electionYear: input.electionYear,
    outsideGroups: input.outsideGroups,
    filerRows: input.filerRows,
    contributionRows: input.contributionRows,
    sourceUrl: input.contributionSourceUrl ?? null,
    minIndustryAmount: input.minIndustryAmount,
  });
  return {
    breakdowns: result.outsideGroupBreakdowns.map(toWriterOutsideBreakdown),
    matchedContributionRowCount: result.matchedContributionRowCount,
    includedContributionEventCount: result.includedContributionEventCount,
    skippedContributionEventCount: result.skippedContributionEventCount,
  };
}

function outsideBreakdownKey(input: PennsylvaniaFinanceOutsideGroupBreakdownInput): string {
  const categoryKey =
    input.categoryType === "donor"
      ? normalizeFinanceLabel(input.categoryName, "donor")
      : input.categoryName.trim().toUpperCase();
  return `${input.groupId.trim().toUpperCase()}\u0000${input.supportOppose}\u0000${input.categoryType}\u0000${categoryKey}`;
}

function addOutsideBreakdown(
  breakdowns: Map<string, PennsylvaniaFinanceOutsideGroupBreakdownInput>,
  breakdown: PennsylvaniaFinanceOutsideGroupBreakdownInput
): void {
  const key = outsideBreakdownKey(breakdown);
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

function toOutsideBreakdownMap(
  breakdowns: readonly PennsylvaniaFinanceOutsideGroupBreakdownInput[]
): Map<string, PennsylvaniaFinanceOutsideGroupBreakdownInput> {
  const result = new Map<string, PennsylvaniaFinanceOutsideGroupBreakdownInput>();
  for (const breakdown of breakdowns) {
    addOutsideBreakdown(result, breakdown);
  }
  return result;
}

function collectOutsideClassifications(
  breakdowns: Iterable<PennsylvaniaFinanceOutsideGroupBreakdownInput>,
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

function asClassifiableOutsideBreakdowns(breakdowns: Iterable<PennsylvaniaFinanceOutsideGroupBreakdownInput>) {
  return [...breakdowns].map((breakdown) => ({
    committeeId: breakdown.groupId,
    supportOppose: breakdown.supportOppose,
    categoryType: breakdown.categoryType,
    categoryName: breakdown.categoryName,
    amount: breakdown.amount,
    contributorCount: breakdown.contributorCount,
    sourceUrl: breakdown.sourceUrl,
  }));
}

async function enrichOutsideGroupIndustryBreakdowns(input: {
  db: Queryable;
  outsideGroupBreakdowns: readonly PennsylvaniaFinanceOutsideGroupBreakdownInput[] | undefined;
  classifier: FinanceIndustryClassifier | undefined;
  aiClassificationMinAmount: number;
  maxDonorBreakdownsPerGroup: number;
  dryRun: boolean;
}): Promise<{
  outsideGroupBreakdowns: PennsylvaniaFinanceOutsideGroupBreakdownInput[] | undefined;
  classifications: FinanceLabelClassification[];
}> {
  if (!input.outsideGroupBreakdowns) {
    return { outsideGroupBreakdowns: undefined, classifications: [] };
  }

  const breakdowns = toOutsideBreakdownMap(input.outsideGroupBreakdowns);
  const classifiableOutsideBreakdowns = asClassifiableOutsideBreakdowns(breakdowns.values());
  const classifications = collectOutsideClassifications(breakdowns.values(), input.aiClassificationMinAmount);
  await resolveFinanceIndustryClassifications({
    db: input.db,
    directBreakdowns: [],
    outsideBreakdowns: classifiableOutsideBreakdowns,
    classifications,
    classifier: input.classifier,
    minAmount: input.aiClassificationMinAmount,
    dryRun: input.dryRun,
  });

  const industryBreakdowns = buildFinanceIndustryBreakdownsFromClassifications({
    directBreakdowns: [],
    outsideBreakdowns: classifiableOutsideBreakdowns,
    classifications,
  });
  for (const [key, breakdown] of breakdowns.entries()) {
    if (breakdown.categoryType === "industry") {
      breakdowns.delete(key);
    }
  }
  for (const breakdown of industryBreakdowns.outsideIndustryBreakdowns) {
    addOutsideBreakdown(breakdowns, {
      groupId: breakdown.committeeId,
      supportOppose: breakdown.supportOppose,
      categoryType: "industry",
      categoryName: breakdown.categoryName,
      amount: breakdown.amount,
      contributorCount: breakdown.contributorCount,
      sourceUrl: breakdown.sourceUrl,
    });
  }

  return {
    // Capped only HERE, after every donor fed the classifications and the
    // rebuilt industry rows above.
    outsideGroupBreakdowns: capDonorBreakdowns([...breakdowns.values()], input.maxDonorBreakdownsPerGroup),
    classifications: [...classifications.values()],
  };
}

function resolveTrustedFiler(input: {
  filerId: string;
  filerName: string;
  sourceUrl?: string | null;
}): PennsylvaniaCandidateCommitteeResolution {
  return {
    status: "matched",
    filerId: requireNonEmpty(input.filerId, "trusted Pennsylvania filer id").toUpperCase(),
    filerName: requireNonEmpty(input.filerName, "trusted Pennsylvania filer name"),
    filerType: null,
    confidence: "exact",
    source: "pa_bulk",
    sourceUrl: input.sourceUrl ?? null,
    matchedFilerRowCount: 0,
  };
}

export async function syncPennsylvaniaCandidateFinance(
  input: PennsylvaniaCandidateFinanceSyncInput
): Promise<PennsylvaniaCandidateFinanceSyncResult> {
  const candidateId = requireNonEmpty(input.candidateId, "candidate id");
  const electionId = requireNonEmpty(input.electionId, "election id");
  const candidateName = requireNonEmpty(input.candidateName, "candidate name");
  const officeScope = requireNonEmpty(input.officeScope, "office scope");
  const officeName = requireNonEmpty(input.officeName, "office name");
  const electionYear = normalizeElectionYear(input.electionYear);
  const syncedAt = normalizeTimestamp(input.now);
  const aiClassificationMinAmount = normalizeAiClassificationMinAmount(input.aiClassificationMinAmount);
  const resolution = input.trustedFiler
    ? resolveTrustedFiler(input.trustedFiler)
    : resolvePennsylvaniaCandidateCommittee({
        candidateName,
        officeScope,
        officeName,
        electionYear,
        district: input.district,
        filerRows: input.filerRows,
        sourceUrl: input.sourceUrl ?? null,
      });

  if (resolution.status !== "matched") {
    if (!input.dryRun) {
      await deactivatePennsylvaniaFinanceLinksForCandidateElection({
        db: input.db,
        candidateId,
        electionId,
        electionYear,
        verifiedAt: syncedAt,
      });
    }
    return {
      candidateId,
      electionId,
      electionYear,
      dryRun: input.dryRun === true,
      resolution,
      linkWritten: false,
      summaryWritten: false,
      directBreakdownsWritten: 0,
      pacDonorsWritten: 0,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
      totalReceipts: null,
      directContributionTotal: null,
      outsideSupportTotal: null,
      outsideOpposeTotal: null,
      matchedContributionRowCount: 0,
      includedContributionEventCount: 0,
      skippedContributionEventCount: 0,
      matchedOutsideContributionRowCount: 0,
      includedOutsideContributionEventCount: 0,
      skippedOutsideContributionEventCount: 0,
    };
  }

  const directFinance = aggregateDirect({
    filerId: resolution.filerId,
    electionYear,
    contributionRows: input.contributionRows,
    filerRows: input.filerRows,
    contributionSourceUrl: input.contributionSourceUrl ?? resolution.sourceUrl,
    maxBreakdownsPerCategory: input.directMaxBreakdownsPerCategory,
  });
  const resolvedOutsideGroups = input.outsideGroups
    ? resolvePennsylvaniaOutsideGroupsForContributionAggregation({
        outsideGroups: input.outsideGroups,
        filerRows: input.filerRows,
      })
    : undefined;
  const outsideGroups = toOutsideGroups(resolvedOutsideGroups);
  const outsideGroupBreakdowns = toOutsideGroupBreakdowns({
    outsideGroups: resolvedOutsideGroups,
    filerRows: input.filerRows,
    contributionRows: input.contributionRows,
    contributionSourceUrl: input.contributionSourceUrl,
    electionYear,
    minIndustryAmount: input.outsideMinIndustryAmount,
  });
  const outsideIndustryFinance = await enrichOutsideGroupIndustryBreakdowns({
    db: input.db,
    outsideGroupBreakdowns: outsideGroupBreakdowns.breakdowns,
    classifier: input.financeIndustryClassifier,
    aiClassificationMinAmount,
    maxDonorBreakdownsPerGroup: normalizeMaxDonorBreakdowns(input.outsideMaxBreakdownsPerCategory),
    dryRun: input.dryRun === true,
  });
  const link = toFinanceLink({
    candidateId,
    electionId,
    candidateName,
    electionYear,
    officeName,
    district: input.district,
    filerId: resolution.filerId,
    filerName: resolution.filerName,
    sourceUrl: resolution.sourceUrl ?? input.sourceUrl ?? input.contributionSourceUrl ?? null,
    verifiedAt: syncedAt,
  });
  const summary = toSummary({
    directFinance,
    outsideGroups: resolvedOutsideGroups,
    fallbackSourceUrl: input.sourceUrl ?? input.contributionSourceUrl ?? null,
  });

  if (!input.dryRun) {
    await replacePennsylvaniaCandidateFinanceSnapshot({
      db: input.db,
      link,
      syncedAt,
      summary,
      directBreakdowns: directFinance.directBreakdowns,
      pacDonors: directFinance.pacDonors,
      outsideGroups,
      outsideGroupBreakdowns: outsideIndustryFinance.outsideGroupBreakdowns,
      classifications: outsideIndustryFinance.classifications,
    });
  }

  return {
    candidateId,
    electionId,
    electionYear,
    dryRun: input.dryRun === true,
    resolution,
    linkWritten: !input.dryRun,
    summaryWritten: !input.dryRun,
    directBreakdownsWritten: input.dryRun ? 0 : directFinance.directBreakdowns.length,
    pacDonorsWritten: input.dryRun ? 0 : directFinance.pacDonors.filter((donor) => donor.amount > 0).length,
    outsideGroupsWritten: input.dryRun ? 0 : (outsideGroups?.length ?? 0),
    outsideGroupBreakdownsWritten: input.dryRun ? 0 : (outsideIndustryFinance.outsideGroupBreakdowns?.length ?? 0),
    totalReceipts: directFinance.summary.totalReceipts,
    directContributionTotal: directFinance.summary.directContributionTotal,
    outsideSupportTotal: summary.outsideSupportTotal ?? null,
    outsideOpposeTotal: summary.outsideOpposeTotal ?? null,
    matchedContributionRowCount: directFinance.matchedContributionRowCount,
    includedContributionEventCount: directFinance.includedContributionEventCount,
    skippedContributionEventCount: directFinance.skippedContributionEventCount,
    matchedOutsideContributionRowCount: outsideGroupBreakdowns.matchedContributionRowCount,
    includedOutsideContributionEventCount: outsideGroupBreakdowns.includedContributionEventCount,
    skippedOutsideContributionEventCount: outsideGroupBreakdowns.skippedContributionEventCount,
  };
}
