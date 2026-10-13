import type { Pool, PoolClient } from "pg";

import {
  buildFinanceIndustryBreakdownsFromClassifications,
  mergeFinanceLabelClassification,
  resolveFinanceIndustryClassifications,
  type FinanceIndustryClassifier,
} from "../finance/financeIndustryClassificationService.js";
import { classifyFinanceLabel, type FinanceLabelClassification } from "../finance/financeLabelClassifier.js";
import {
  normalizeMarylandCandidateNameForStorage,
  resolveMarylandCandidateCommittee,
  type MarylandCandidateCommitteeResolution,
} from "./marylandCandidateCommitteeResolver.js";
import {
  aggregateMarylandDirectContributions,
  type MarylandDirectContributionAggregationResult,
} from "./marylandDirectContributionAggregator.js";
import type {
  MarylandCfsCommitteeRow,
  MarylandCfsContributionRow,
  MarylandCfsExpenditureRow,
} from "./marylandCfsArtifactReader.js";
import { aggregateMarylandOutsideGroupContributions } from "./marylandOutsideGroupContributionAggregator.js";
import {
  aggregateMarylandOutsideSpending,
  type MarylandOutsideSpendingAggregationResult,
} from "./marylandOutsideSpendingAggregator.js";
import {
  replaceMarylandCandidateFinanceSnapshot,
  type MarylandFinanceLinkInput,
  type MarylandFinanceOutsideGroupBreakdownInput,
  type MarylandFinanceOutsideGroupInput,
  type MarylandFinanceSummaryInput,
} from "./marylandFinanceWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & {
  connect: () => Promise<PoolClient>;
};

export type MarylandCandidateFinanceSyncInput = {
  db: ConnectableQueryable;
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district?: string | null;
  committeeRows: readonly MarylandCfsCommitteeRow[];
  contributionRows: readonly MarylandCfsContributionRow[];
  expenditureRows?: readonly MarylandCfsExpenditureRow[];
  sourceUrl?: string | null;
  committeeSourceUrl?: string | null;
  contributionSourceUrl?: string | null;
  expenditureSourceUrl?: string | null;
  now?: Date;
  dryRun?: boolean;
  directMaxBreakdownsPerCategory?: number;
  outsideMaxGroups?: number;
  // Display cap on persisted donor rows per (committee, direction);
  // classification always sees every donor.
  outsideMaxDonorBreakdownsPerGroup?: number;
  outsideMinIndustryAmount?: number;
  financeIndustryClassifier?: FinanceIndustryClassifier;
  aiClassificationMinAmount?: number;
  trustedCommittee?: {
    committeeId: string;
    committeeName: string;
    sourceUrl?: string | null;
  };
};

export type MarylandCandidateFinanceSyncResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  dryRun: boolean;
  resolution: MarylandCandidateCommitteeResolution;
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
};

const DEFAULT_AI_CLASSIFICATION_MIN_AMOUNT = 25_000;
const STATE_MIN_OUTSIDE_INDUSTRY_AMOUNT = 0;
// Display cap on PERSISTED donor rows per (committee, direction), applied
// AFTER classification so a >cap-donor group still gets industry totals
// built from every donor. Industry rows are naturally bounded by the slug
// set and are never capped.
const DEFAULT_MAX_DONOR_BREAKDOWNS_PER_GROUP = 50;

function requireNonEmpty(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmed;
}

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new Error(`Invalid Maryland finance election year: ${value}`);
  }
  return value;
}

function normalizeTimestamp(value: Date | undefined): Date {
  const normalized = value ?? new Date();
  if (Number.isNaN(normalized.getTime())) {
    throw new Error("Invalid Maryland finance sync timestamp");
  }
  return normalized;
}

function normalizeAiClassificationMinAmount(value: number | undefined): number {
  const normalized = value ?? DEFAULT_AI_CLASSIFICATION_MIN_AMOUNT;
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`Invalid Maryland finance AI classification minimum amount: ${value}`);
  }
  return normalized;
}

function normalizeMaxDonorBreakdowns(value: number | undefined): number {
  const normalized = value ?? DEFAULT_MAX_DONOR_BREAKDOWNS_PER_GROUP;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Maryland finance outsideMaxDonorBreakdownsPerGroup: ${value}`);
  }
  return normalized;
}

function capDonorBreakdowns(
  breakdowns: readonly MarylandFinanceOutsideGroupBreakdownInput[],
  maxDonorsPerGroup: number
): MarylandFinanceOutsideGroupBreakdownInput[] {
  const donorsByGroup = new Map<string, MarylandFinanceOutsideGroupBreakdownInput[]>();
  for (const breakdown of breakdowns) {
    if (breakdown.categoryType !== "donor") {
      continue;
    }
    const key = [breakdown.committeeId.trim().toUpperCase(), breakdown.supportOppose].join("\u0000");
    const list = donorsByGroup.get(key) ?? [];
    list.push(breakdown);
    donorsByGroup.set(key, list);
  }
  const kept = new Set<MarylandFinanceOutsideGroupBreakdownInput>();
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
  committeeId: string;
  committeeName: string;
  sourceUrl?: string | null;
  verifiedAt: Date;
}): MarylandFinanceLinkInput {
  return {
    candidateId: requireNonEmpty(input.candidateId, "candidate id"),
    electionId: requireNonEmpty(input.electionId, "election id"),
    electionYear: input.electionYear,
    candidateNameNormalized: normalizeMarylandCandidateNameForStorage(input.candidateName),
    officeName: requireNonEmpty(input.officeName, "office name"),
    district: input.district ?? null,
    committeeId: requireNonEmpty(input.committeeId, "Maryland committee id"),
    committeeName: requireNonEmpty(input.committeeName, "Maryland committee name"),
    linkStatus: "active",
    linkSource: "cfs_public_export",
    sourceUrl: input.sourceUrl ?? null,
    lastVerifiedAt: input.verifiedAt,
  };
}

function aggregateDirect(input: {
  committeeId: string;
  electionYear: number;
  contributionRows: readonly MarylandCfsContributionRow[];
  contributionSourceUrl?: string | null;
  maxBreakdownsPerCategory?: number;
}): MarylandDirectContributionAggregationResult {
  return aggregateMarylandDirectContributions({
    committeeId: input.committeeId,
    electionYear: input.electionYear,
    contributionRows: input.contributionRows,
    sourceUrl: input.contributionSourceUrl ?? null,
    maxBreakdownsPerCategory: input.maxBreakdownsPerCategory,
  });
}

function aggregateOutside(input: {
  candidateName: string;
  officeName: string;
  electionYear: number;
  expenditureRows: readonly MarylandCfsExpenditureRow[];
  expenditureSourceUrl?: string | null;
  maxGroups?: number;
}): MarylandOutsideSpendingAggregationResult {
  return aggregateMarylandOutsideSpending({
    candidateName: input.candidateName,
    officeName: input.officeName,
    electionYear: input.electionYear,
    expenditureRows: input.expenditureRows,
    sourceUrl: input.expenditureSourceUrl ?? null,
    maxGroups: input.maxGroups,
  });
}

function outsideBreakdownKey(breakdown: MarylandFinanceOutsideGroupBreakdownInput): string {
  return [
    breakdown.committeeId.trim().toUpperCase(),
    breakdown.supportOppose,
    breakdown.categoryType,
    breakdown.categoryName.trim().toUpperCase(),
  ].join("\u0000");
}

function toOutsideBreakdownMap(
  breakdowns: readonly MarylandFinanceOutsideGroupBreakdownInput[] | undefined
): Map<string, MarylandFinanceOutsideGroupBreakdownInput> {
  const mapped = new Map<string, MarylandFinanceOutsideGroupBreakdownInput>();
  for (const breakdown of breakdowns ?? []) {
    if (breakdown.categoryType === "industry") {
      continue;
    }
    mapped.set(outsideBreakdownKey(breakdown), breakdown);
  }
  return mapped;
}

function collectOutsideClassifications(
  breakdowns: Iterable<MarylandFinanceOutsideGroupBreakdownInput>,
  minIndustryAmount: number
): Map<string, FinanceLabelClassification> {
  const classifications = new Map<string, FinanceLabelClassification>();
  for (const breakdown of breakdowns) {
    if (breakdown.categoryType !== "donor" || breakdown.amount < minIndustryAmount) {
      continue;
    }
    mergeFinanceLabelClassification(
      classifications,
      classifyFinanceLabel({
        rawLabel: breakdown.categoryName,
        labelType: "donor",
      })
    );
  }
  return classifications;
}

function addOutsideBreakdown(
  breakdowns: Map<string, MarylandFinanceOutsideGroupBreakdownInput>,
  breakdown: MarylandFinanceOutsideGroupBreakdownInput
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
        ? null
        : existing.contributorCount + breakdown.contributorCount,
    sourceUrl: existing.sourceUrl ?? breakdown.sourceUrl,
  });
}

async function enrichOutsideGroupIndustryBreakdowns(input: {
  db: Queryable;
  outsideGroupBreakdowns: readonly MarylandFinanceOutsideGroupBreakdownInput[] | undefined;
  classifier: FinanceIndustryClassifier | undefined;
  aiClassificationMinAmount: number;
  minIndustryAmount: number;
  maxDonorBreakdownsPerGroup: number;
  dryRun: boolean;
}): Promise<{
  outsideGroupBreakdowns: MarylandFinanceOutsideGroupBreakdownInput[] | undefined;
  classifications: FinanceLabelClassification[];
}> {
  if (!input.outsideGroupBreakdowns) {
    return { outsideGroupBreakdowns: undefined, classifications: [] };
  }

  const breakdowns = toOutsideBreakdownMap(input.outsideGroupBreakdowns);
  const classifications = collectOutsideClassifications(breakdowns.values(), input.minIndustryAmount);
  await resolveFinanceIndustryClassifications({
    db: input.db,
    directBreakdowns: [],
    outsideBreakdowns: breakdowns.values(),
    classifications,
    classifier: input.classifier,
    minAmount: input.aiClassificationMinAmount,
    dryRun: input.dryRun,
  });

  const industryBreakdowns = buildFinanceIndustryBreakdownsFromClassifications({
    directBreakdowns: [],
    outsideBreakdowns: breakdowns.values(),
    classifications,
  });
  for (const breakdown of industryBreakdowns.outsideIndustryBreakdowns) {
    addOutsideBreakdown(breakdowns, breakdown);
  }

  return {
    // Capped only HERE, after every donor fed the classifications and the
    // rebuilt industry rows above.
    outsideGroupBreakdowns: capDonorBreakdowns([...breakdowns.values()], input.maxDonorBreakdownsPerGroup),
    classifications: [...classifications.values()],
  };
}

function toSummary(input: {
  directFinance: MarylandDirectContributionAggregationResult;
  outsideFinance: MarylandOutsideSpendingAggregationResult;
  outsideDataAvailable: boolean;
  fallbackSourceUrl?: string | null;
}): MarylandFinanceSummaryInput {
  return {
    totalReceipts: input.directFinance.summary.totalReceipts,
    directContributionTotal: input.directFinance.summary.directContributionTotal,
    outsideSupportTotal: input.outsideDataAvailable ? input.outsideFinance.summary?.supportTotal ?? null : null,
    outsideOpposeTotal: input.outsideDataAvailable ? input.outsideFinance.summary?.opposeTotal ?? null : null,
    sourceUrl:
      input.directFinance.summary.sourceUrl ??
      input.outsideFinance.summary?.sourceUrl ??
      input.fallbackSourceUrl ??
      null,
  };
}

function emptyOutsideResult(): MarylandOutsideSpendingAggregationResult {
  return {
    summary: null,
    matchedExpenditureRowCount: 0,
    includedExpenditureRowCount: 0,
    skippedExpenditureRowCount: 0,
  };
}

function resolveTrustedCommittee(input: {
  committeeId: string;
  committeeName: string;
  sourceUrl?: string | null;
}): MarylandCandidateCommitteeResolution {
  return {
    status: "matched",
    committeeId: requireNonEmpty(input.committeeId, "trusted Maryland committee id"),
    committeeName: requireNonEmpty(input.committeeName, "trusted Maryland committee name"),
    confidence: "exact",
    source: "cfs_public_export",
    sourceUrl: input.sourceUrl ?? null,
    matchedCommitteeRowCount: 0,
  };
}

export async function syncMarylandCandidateFinance(
  input: MarylandCandidateFinanceSyncInput
): Promise<MarylandCandidateFinanceSyncResult> {
  const candidateId = requireNonEmpty(input.candidateId, "candidate id");
  const electionId = requireNonEmpty(input.electionId, "election id");
  const candidateName = requireNonEmpty(input.candidateName, "candidate name");
  const officeScope = requireNonEmpty(input.officeScope, "office scope");
  const officeName = requireNonEmpty(input.officeName, "office name");
  const electionYear = normalizeElectionYear(input.electionYear);
  const syncedAt = normalizeTimestamp(input.now);
  const aiClassificationMinAmount = normalizeAiClassificationMinAmount(input.aiClassificationMinAmount);
  const resolution = input.trustedCommittee
    ? resolveTrustedCommittee(input.trustedCommittee)
    : resolveMarylandCandidateCommittee({
        candidateName,
        officeScope,
        officeName,
        electionYear,
        district: input.district,
        committeeRows: input.committeeRows,
        sourceUrl: input.sourceUrl ?? input.committeeSourceUrl ?? null,
      });

  if (resolution.status !== "matched") {
    return {
      candidateId,
      electionId,
      electionYear,
      dryRun: input.dryRun === true,
      resolution,
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
    };
  }

  const directFinance = aggregateDirect({
    committeeId: resolution.committeeId,
    electionYear,
    contributionRows: input.contributionRows,
    contributionSourceUrl: input.contributionSourceUrl ?? resolution.sourceUrl,
    maxBreakdownsPerCategory: input.directMaxBreakdownsPerCategory,
  });
  const outsideFinance =
    input.expenditureRows !== undefined
      ? aggregateOutside({
          candidateName,
          officeName,
          electionYear,
          expenditureRows: input.expenditureRows,
          expenditureSourceUrl: input.expenditureSourceUrl,
          maxGroups: input.outsideMaxGroups,
        })
      : emptyOutsideResult();
  // A supplied export is not proof of candidate coverage: rejected identities,
  // missing offices and malformed allocations must not clear accepted groups.
  const outsideDataAvailable = input.expenditureRows !== undefined && outsideFinance.summary !== null;
  const outsideGroups: MarylandFinanceOutsideGroupInput[] | undefined =
    outsideDataAvailable ? outsideFinance.summary?.groups : undefined;
  const outsideGroupContributionFinance =
    outsideGroups !== undefined
      ? aggregateMarylandOutsideGroupContributions({
          electionYear,
          outsideGroups,
          contributionRows: input.contributionRows,
          sourceUrl: input.contributionSourceUrl ?? null,
          minIndustryAmount: input.outsideMinIndustryAmount ?? STATE_MIN_OUTSIDE_INDUSTRY_AMOUNT,
        })
      : {
          outsideGroupBreakdowns: undefined,
          matchedContributionRowCount: 0,
          includedContributionRowCount: 0,
          skippedContributionRowCount: 0,
        };
  const outsideIndustryFinance = await enrichOutsideGroupIndustryBreakdowns({
    db: input.db,
    outsideGroupBreakdowns: outsideGroupContributionFinance.outsideGroupBreakdowns,
    classifier: input.financeIndustryClassifier,
    aiClassificationMinAmount,
    minIndustryAmount: input.outsideMinIndustryAmount ?? STATE_MIN_OUTSIDE_INDUSTRY_AMOUNT,
    maxDonorBreakdownsPerGroup: normalizeMaxDonorBreakdowns(input.outsideMaxDonorBreakdownsPerGroup),
    dryRun: input.dryRun === true,
  });
  const link = toFinanceLink({
    candidateId,
    electionId,
    candidateName,
    electionYear,
    officeName,
    district: input.district,
    committeeId: resolution.committeeId,
    committeeName: resolution.committeeName,
    sourceUrl: resolution.sourceUrl ?? input.sourceUrl ?? input.committeeSourceUrl ?? null,
    verifiedAt: syncedAt,
  });
  const summary = toSummary({
    directFinance,
    outsideFinance,
    outsideDataAvailable,
    fallbackSourceUrl: input.sourceUrl ?? input.contributionSourceUrl ?? input.expenditureSourceUrl ?? null,
  });

  if (!input.dryRun) {
    await replaceMarylandCandidateFinanceSnapshot({
      db: input.db,
      link,
      syncedAt,
      summary,
      directBreakdowns: directFinance.directBreakdowns,
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
    outsideGroupsWritten: input.dryRun ? 0 : outsideGroups?.length ?? 0,
    outsideGroupBreakdownsWritten: input.dryRun ? 0 : outsideIndustryFinance.outsideGroupBreakdowns?.length ?? 0,
    totalReceipts: directFinance.summary.totalReceipts,
    directContributionTotal: directFinance.summary.directContributionTotal,
    outsideSupportTotal: outsideDataAvailable ? outsideFinance.summary?.supportTotal ?? null : null,
    outsideOpposeTotal: outsideDataAvailable ? outsideFinance.summary?.opposeTotal ?? null : null,
    matchedContributionRowCount: directFinance.matchedContributionRowCount,
    includedContributionRowCount: directFinance.includedContributionRowCount,
    skippedContributionRowCount: directFinance.skippedContributionRowCount,
    matchedExpenditureRowCount: outsideFinance.matchedExpenditureRowCount,
    includedExpenditureRowCount: outsideFinance.includedExpenditureRowCount,
    skippedExpenditureRowCount: outsideFinance.skippedExpenditureRowCount,
    matchedOutsideContributionRowCount: outsideGroupContributionFinance.matchedContributionRowCount,
    includedOutsideContributionRowCount: outsideGroupContributionFinance.includedContributionRowCount,
    skippedOutsideContributionRowCount: outsideGroupContributionFinance.skippedContributionRowCount,
  };
}
