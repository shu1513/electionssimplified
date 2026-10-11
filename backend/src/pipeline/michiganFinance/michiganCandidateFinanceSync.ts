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
  normalizeMichiganCandidateNameForStorage,
  resolveMichiganCandidateCommittee,
  type MichiganCandidateCommitteeResolution,
} from "./michiganCandidateCommitteeResolver.js";
import {
  aggregateMichiganDirectContributions,
  type MichiganDirectContributionAggregationResult,
} from "./michiganDirectContributionAggregator.js";
import {
  aggregateMichiganOutsideGroupContributions,
  type MichiganFinanceOutsideGroupBreakdown,
} from "./michiganOutsideGroupContributionAggregator.js";
import {
  aggregateMichiganOutsideSpending,
  type MichiganOutsideSpendingAggregationResult,
  type MichiganOutsideSpendingGroup,
} from "./michiganOutsideSpendingAggregator.js";
import {
  deactivateMichiganFinanceLinksForCandidateElection,
  replaceMichiganCandidateFinanceSnapshot,
  type MichiganFinanceLinkInput,
  type MichiganFinanceLinkSource,
  type MichiganFinanceOutsideGroupBreakdownInput,
  type MichiganFinanceOutsideGroupInput,
  type MichiganFinanceSummaryInput,
} from "./michiganFinanceWriter.js";
import type {
  MichiganMitnLegacyContributionRow,
  MichiganMitnLegacyExpenditureRow,
} from "./michiganMitnLegacyRowTypes.js";

import type { MichiganMitnCommitteeSearchRow } from "./michiganMitnPublicSearchClient.js";

type Queryable = Pick<Pool | PoolClient, "query">;

const DEFAULT_AI_CLASSIFICATION_MIN_AMOUNT = 25_000;
// Display cap on PERSISTED donor rows per (committee, direction), applied
// AFTER classification so a >cap-donor group still gets industry totals
// built from every donor. Industry rows are naturally bounded by the slug
// set and are never capped.
const DEFAULT_MAX_DONOR_BREAKDOWNS_PER_GROUP = 50;

export type MichiganCandidateFinanceSyncInput = {
  db: Queryable;
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district?: string | null;
  currentOffice?: string | null;
  contributionRows: readonly MichiganMitnLegacyContributionRow[];
  expenditureRows?: readonly MichiganMitnLegacyExpenditureRow[];
  committeeRegistryRows?: readonly MichiganMitnCommitteeSearchRow[];
  /** A unique registry Candidate match to the trusted link, checked by batch. */
  outsideTargetCommitteeName?: string;
  outsideTargetCommitteeNames?: readonly string[];
  /** Provenance for the written link; defaults to the MiTN public search. */
  linkSource?: MichiganFinanceLinkSource;
  sourceUrl?: string | null;
  contributionSourceUrl?: string | null;
  outsideSourceUrl?: string | null;
  now?: Date;
  dryRun?: boolean;
  directMaxBreakdownsPerCategory?: number;
  outsideMaxGroups?: number;
  // Display cap on persisted donor rows per (committee, direction);
  // classification always sees every donor.
  outsideMaxBreakdownsPerCategory?: number;
  outsideMinIndustryAmount?: number;
  financeIndustryClassifier?: FinanceIndustryClassifier;
  aiClassificationMinAmount?: number;
  trustedCommittee?: {
    committeeId: string;
    committeeName: string;
    sourceUrl?: string | null;
  };
};

export type MichiganCandidateFinanceSyncResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  dryRun: boolean;
  resolution: MichiganCandidateCommitteeResolution;
  linkWritten: boolean;
  summaryWritten: boolean;
  directBreakdownsWritten: number;
  outsideGroupsWritten: number;
  pacDonorsWritten?: number;
  outsideGroupBreakdownsWritten: number;
  totalReceipts: number | null;
  directContributionTotal: number | null;
  outsideSupportTotal: number | null;
  outsideOpposeTotal: number | null;
  matchedContributionRowCount: number;
  includedContributionRowCount: number;
  skippedContributionRowCount: number;
  matchedOutsideExpenditureRowCount: number;
  includedOutsideExpenditureRowCount: number;
  skippedOutsideExpenditureRowCount: number;
  matchedOutsideContributionRowCount: number;
  includedOutsideContributionRowCount: number;
  skippedOutsideContributionRowCount: number;
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
    throw new Error(`Invalid Michigan finance election year: ${value}`);
  }
  return value;
}

function normalizeTimestamp(value: Date | undefined): Date {
  const normalized = value ?? new Date();
  if (Number.isNaN(normalized.getTime())) {
    throw new Error("Invalid Michigan finance sync timestamp");
  }
  return normalized;
}

function normalizeAiClassificationMinAmount(value: number | undefined): number {
  const normalized = value ?? DEFAULT_AI_CLASSIFICATION_MIN_AMOUNT;
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error("Michigan finance aiClassificationMinAmount must be a nonnegative number");
  }
  return normalized;
}

function normalizeMaxDonorBreakdowns(value: number | undefined): number {
  const normalized = value ?? DEFAULT_MAX_DONOR_BREAKDOWNS_PER_GROUP;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Michigan finance outsideMaxBreakdownsPerCategory: ${value}`);
  }
  return normalized;
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
  linkSource: MichiganFinanceLinkSource;
  sourceUrl?: string | null;
  verifiedAt: Date;
}): MichiganFinanceLinkInput {
  return {
    candidateId: requireNonEmpty(input.candidateId, "candidate id"),
    electionId: requireNonEmpty(input.electionId, "election id"),
    electionYear: input.electionYear,
    candidateNameNormalized: normalizeMichiganCandidateNameForStorage(input.candidateName),
    officeName: requireNonEmpty(input.officeName, "office name"),
    district: input.district ?? null,
    committeeId: requireNonEmpty(input.committeeId, "Michigan committee id"),
    committeeName: requireNonEmpty(input.committeeName, "Michigan committee name"),
    linkStatus: "active",
    linkSource: input.linkSource,
    sourceUrl: input.sourceUrl ?? null,
    lastVerifiedAt: input.verifiedAt,
  };
}

function aggregateDirect(input: {
  committeeRegistryRows?: readonly MichiganMitnCommitteeSearchRow[];
  committeeId: string;
  electionYear: number;
  contributionRows: readonly MichiganMitnLegacyContributionRow[];
  contributionSourceUrl?: string | null;
  maxBreakdownsPerCategory?: number;
}): MichiganDirectContributionAggregationResult {
  return aggregateMichiganDirectContributions({
    committeeRegistryRows: input.committeeRegistryRows,
    committeeId: input.committeeId,
    electionYear: input.electionYear,
    contributionRows: input.contributionRows,
    sourceUrl: input.contributionSourceUrl ?? null,
    maxBreakdownsPerCategory: input.maxBreakdownsPerCategory,
  });
}

function aggregateOutside(input: {
  targetCommitteeName?: string;
  targetCommitteeNames?: readonly string[];
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district?: string | null;
  expenditureRows: readonly MichiganMitnLegacyExpenditureRow[];
  outsideSourceUrl?: string | null;
  maxGroups?: number;
}): MichiganOutsideSpendingAggregationResult {
  return aggregateMichiganOutsideSpending({
    targetCommitteeName: input.targetCommitteeName,
    targetCommitteeNames: input.targetCommitteeNames,
    candidateName: input.candidateName,
    officeScope: input.officeScope,
    officeName: input.officeName,
    electionYear: input.electionYear,
    district: input.district,
    expenditureRows: input.expenditureRows,
    sourceUrl: input.outsideSourceUrl ?? null,
    maxGroups: input.maxGroups,
  });
}

function toOutsideGroups(
  outsideFinance: MichiganOutsideSpendingAggregationResult
): MichiganFinanceOutsideGroupInput[] | undefined {
  return outsideFinance.summary?.groups.map((group) => ({
    committeeId: group.committeeId,
    committeeName: group.committeeName,
    supportOppose: group.supportOppose,
    amount: group.amount,
    sourceUrl: group.sourceUrl,
  }));
}

function toWriterOutsideBreakdown(
  breakdown: MichiganFinanceOutsideGroupBreakdown
): MichiganFinanceOutsideGroupBreakdownInput {
  return {
    committeeId: breakdown.committeeId,
    supportOppose: breakdown.supportOppose,
    categoryType: breakdown.categoryType,
    categoryName: breakdown.categoryName,
    amount: breakdown.amount,
    contributorCount: breakdown.contributorCount,
    sourceUrl: breakdown.sourceUrl,
  };
}

function toOutsideGroupBreakdowns(input: {
  outsideGroups: readonly MichiganOutsideSpendingGroup[] | undefined;
  contributionRows: readonly MichiganMitnLegacyContributionRow[];
  contributionSourceUrl?: string | null;
  electionYear: number;
  minIndustryAmount?: number;
}): {
  breakdowns: MichiganFinanceOutsideGroupBreakdownInput[] | undefined;
  matchedContributionRowCount: number;
  includedContributionRowCount: number;
  skippedContributionRowCount: number;
} {
  if (!input.outsideGroups) {
    return {
      breakdowns: undefined,
      matchedContributionRowCount: 0,
      includedContributionRowCount: 0,
      skippedContributionRowCount: 0,
    };
  }

  const result = aggregateMichiganOutsideGroupContributions({
    electionYear: input.electionYear,
    outsideGroups: input.outsideGroups,
    contributionRows: input.contributionRows,
    sourceUrl: input.contributionSourceUrl ?? null,
    minIndustryAmount: input.minIndustryAmount,
  });
  return {
    breakdowns: result.outsideGroupBreakdowns.map(toWriterOutsideBreakdown),
    matchedContributionRowCount: result.matchedContributionRowCount,
    includedContributionRowCount: result.includedContributionRowCount,
    skippedContributionRowCount: result.skippedContributionRowCount,
  };
}

function outsideBreakdownKey(input: MichiganFinanceOutsideGroupBreakdownInput): string {
  const categoryKey =
    input.categoryType === "donor"
      ? normalizeFinanceLabel(input.categoryName, "donor")
      : input.categoryName.trim().toUpperCase();
  return `${input.committeeId.trim().toUpperCase()}\u0000${input.supportOppose}\u0000${input.categoryType}\u0000${categoryKey}`;
}

function addOutsideBreakdown(
  breakdowns: Map<string, MichiganFinanceOutsideGroupBreakdownInput>,
  breakdown: MichiganFinanceOutsideGroupBreakdownInput
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
  breakdowns: readonly MichiganFinanceOutsideGroupBreakdownInput[]
): Map<string, MichiganFinanceOutsideGroupBreakdownInput> {
  const result = new Map<string, MichiganFinanceOutsideGroupBreakdownInput>();
  for (const breakdown of breakdowns) {
    addOutsideBreakdown(result, breakdown);
  }
  return result;
}

function collectOutsideClassifications(
  breakdowns: Iterable<MichiganFinanceOutsideGroupBreakdownInput>,
  minAmount: number
): Map<string, FinanceLabelClassification> {
  const classifications = new Map<string, FinanceLabelClassification>();
  for (const breakdown of breakdowns) {
    if (breakdown.categoryType !== "donor" || breakdown.amount < minAmount) {
      continue;
    }
    const classification = classifyFinanceLabel({
      rawLabel: breakdown.categoryName,
      labelType: "donor",
    });
    mergeFinanceLabelClassification(classifications, classification);
  }
  return classifications;
}

function capDonorBreakdowns(
  breakdowns: readonly MichiganFinanceOutsideGroupBreakdownInput[],
  maxDonorsPerGroup: number
): MichiganFinanceOutsideGroupBreakdownInput[] {
  const donorsByGroup = new Map<string, MichiganFinanceOutsideGroupBreakdownInput[]>();
  for (const breakdown of breakdowns) {
    if (breakdown.categoryType !== "donor") {
      continue;
    }
    const key = `${breakdown.committeeId.trim().toUpperCase()}\u0000${breakdown.supportOppose}`;
    const list = donorsByGroup.get(key) ?? [];
    list.push(breakdown);
    donorsByGroup.set(key, list);
  }
  const kept = new Set<MichiganFinanceOutsideGroupBreakdownInput>();
  for (const list of donorsByGroup.values()) {
    for (const donor of list
      .sort((left, right) => right.amount - left.amount || left.categoryName.localeCompare(right.categoryName))
      .slice(0, maxDonorsPerGroup)) {
      kept.add(donor);
    }
  }
  return breakdowns.filter((breakdown) => breakdown.categoryType !== "donor" || kept.has(breakdown));
}

async function enrichOutsideGroupIndustryBreakdowns(input: {
  db: Queryable;
  outsideGroupBreakdowns: readonly MichiganFinanceOutsideGroupBreakdownInput[] | undefined;
  classifier: FinanceIndustryClassifier | undefined;
  aiClassificationMinAmount: number;
  maxDonorBreakdownsPerGroup: number;
  dryRun: boolean;
}): Promise<{
  outsideGroupBreakdowns: MichiganFinanceOutsideGroupBreakdownInput[] | undefined;
  classifications: FinanceLabelClassification[];
}> {
  if (!input.outsideGroupBreakdowns) {
    return { outsideGroupBreakdowns: undefined, classifications: [] };
  }

  const breakdowns = toOutsideBreakdownMap(input.outsideGroupBreakdowns);
  const classifications = collectOutsideClassifications(breakdowns.values(), input.aiClassificationMinAmount);
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
  for (const [key, breakdown] of breakdowns.entries()) {
    if (breakdown.categoryType === "industry") {
      breakdowns.delete(key);
    }
  }
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
  directFinance: MichiganDirectContributionAggregationResult;
  outsideFinance: MichiganOutsideSpendingAggregationResult;
  outsideDataAvailable: boolean;
  fallbackSourceUrl?: string | null;
}): MichiganFinanceSummaryInput {
  return {
    totalReceipts: input.directFinance.summary.totalReceipts,
    directContributionTotal: input.directFinance.summary.directContributionTotal,
    candidateLoanTotal: input.directFinance.summary.candidateLoanTotal,
    outsideSupportTotal: input.outsideDataAvailable ? input.outsideFinance.summary?.supportTotal ?? 0 : null,
    outsideOpposeTotal: input.outsideDataAvailable ? input.outsideFinance.summary?.opposeTotal ?? 0 : null,
    sourceUrl:
      input.directFinance.summary.sourceUrl ??
      input.outsideFinance.summary?.sourceUrl ??
      input.fallbackSourceUrl ??
      null,
  };
}

function emptyOutsideResult(): MichiganOutsideSpendingAggregationResult {
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
}): MichiganCandidateCommitteeResolution {
  const committeeId = requireNonEmpty(input.committeeId, "trusted Michigan committee id").toUpperCase();
  const committeeName = requireNonEmpty(input.committeeName, "trusted Michigan committee name");
  return {
    status: "matched",
    committeeId,
    committeeName,
    commonName: null,
    confidence: "exact",
    source: "mitn",
    sourceUrl: input.sourceUrl ?? null,
    matchedContributionRowCount: 0,
  };
}

export async function syncMichiganCandidateFinance(
  input: MichiganCandidateFinanceSyncInput
): Promise<MichiganCandidateFinanceSyncResult> {
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
    : resolveMichiganCandidateCommittee({
        candidateName,
        officeScope,
        officeName,
        electionYear,
        district: input.district,
        currentOffice: input.currentOffice,
        contributionRows: input.contributionRows,
        sourceUrl: input.sourceUrl ?? input.contributionSourceUrl ?? null,
      });

  if (resolution.status !== "matched") {
    if (!input.dryRun) {
      await deactivateMichiganFinanceLinksForCandidateElection({
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
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
      totalReceipts: null,
      directContributionTotal: null,
      outsideSupportTotal: null,
      outsideOpposeTotal: null,
      matchedContributionRowCount: 0,
      includedContributionRowCount: 0,
      skippedContributionRowCount: 0,
      matchedOutsideExpenditureRowCount: 0,
      includedOutsideExpenditureRowCount: 0,
      skippedOutsideExpenditureRowCount: 0,
      matchedOutsideContributionRowCount: 0,
      includedOutsideContributionRowCount: 0,
      skippedOutsideContributionRowCount: 0,
    };
  }

  const directFinance = aggregateDirect({
    committeeRegistryRows: input.committeeRegistryRows,
    committeeId: resolution.committeeId,
    electionYear,
    contributionRows: input.contributionRows,
    contributionSourceUrl: input.contributionSourceUrl ?? resolution.sourceUrl,
    maxBreakdownsPerCategory: input.directMaxBreakdownsPerCategory,
  });
  const expenditureRows = input.expenditureRows;
  const outsideDataAvailable = expenditureRows !== undefined;
  const outsideFinance = expenditureRows
    ? aggregateOutside({
        targetCommitteeName: input.outsideTargetCommitteeName,
        targetCommitteeNames: input.outsideTargetCommitteeNames,
        candidateName,
        electionYear,
        officeScope,
        officeName,
        district: input.district,
        expenditureRows,
        outsideSourceUrl: input.outsideSourceUrl,
        maxGroups: input.outsideMaxGroups,
      })
    : emptyOutsideResult();
  const outsideGroups = outsideDataAvailable ? toOutsideGroups(outsideFinance) ?? [] : undefined;
  const outsideGroupBreakdowns = toOutsideGroupBreakdowns({
    outsideGroups: outsideFinance.summary?.groups,
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
    committeeId: resolution.committeeId,
    committeeName: resolution.committeeName,
    linkSource: input.linkSource ?? "mitn_public_search",
    sourceUrl: resolution.sourceUrl ?? input.sourceUrl ?? input.contributionSourceUrl ?? null,
    verifiedAt: syncedAt,
  });
  const summary = toSummary({
    directFinance,
    outsideFinance,
    outsideDataAvailable,
    fallbackSourceUrl: input.sourceUrl ?? input.contributionSourceUrl ?? input.outsideSourceUrl ?? null,
  });

  if (!input.dryRun) {
    await replaceMichiganCandidateFinanceSnapshot({
      db: input.db,
      link,
      syncedAt,
      summary,
      directBreakdowns: directFinance.directBreakdowns,
      pacDonors: directFinance.pacDonors,
      candidateElectionOutsideSnapshot: outsideDataAvailable && input.outsideTargetCommitteeNames !== undefined,
      outsideGroups,
      outsideGroupBreakdowns: outsideDataAvailable ? outsideIndustryFinance.outsideGroupBreakdowns ?? [] : undefined,
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
    ...(directFinance.pacDonors !== undefined ? { pacDonorsWritten: input.dryRun ? 0 : directFinance.pacDonors.length } : {}),
    outsideGroupBreakdownsWritten: input.dryRun ? 0 : outsideIndustryFinance.outsideGroupBreakdowns?.length ?? 0,
    totalReceipts: directFinance.summary.totalReceipts,
    directContributionTotal: directFinance.summary.directContributionTotal,
    outsideSupportTotal: outsideDataAvailable ? outsideFinance.summary?.supportTotal ?? 0 : null,
    outsideOpposeTotal: outsideDataAvailable ? outsideFinance.summary?.opposeTotal ?? 0 : null,
    matchedContributionRowCount: directFinance.matchedContributionRowCount,
    includedContributionRowCount: directFinance.includedContributionRowCount,
    skippedContributionRowCount: directFinance.skippedContributionRowCount,
    matchedOutsideExpenditureRowCount: outsideFinance.matchedExpenditureRowCount,
    includedOutsideExpenditureRowCount: outsideFinance.includedExpenditureRowCount,
    skippedOutsideExpenditureRowCount: outsideFinance.skippedExpenditureRowCount,
    matchedOutsideContributionRowCount: outsideGroupBreakdowns.matchedContributionRowCount,
    includedOutsideContributionRowCount: outsideGroupBreakdowns.includedContributionRowCount,
    skippedOutsideContributionRowCount: outsideGroupBreakdowns.skippedContributionRowCount,
  };
}
