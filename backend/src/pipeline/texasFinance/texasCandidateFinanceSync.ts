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
  normalizeTexasCandidateNameKeys,
  resolveTexasCandidateCommittee,
  type TexasCandidateCommitteeResolution,
} from "./texasCandidateCommitteeResolver.js";
import {
  aggregateTexasDirectContributions,
  type TexasDirectContributionAggregationResult,
} from "./texasDirectContributionAggregator.js";
import {
  aggregateTexasOutsideGroupContributions,
  type TexasFinanceOutsideGroupBreakdown,
} from "./texasOutsideGroupContributionAggregator.js";
import {
  aggregateTexasOutsideSpending,
  type TexasOutsideSpendingAggregationResult,
  type TexasOutsideSpendingGroup,
} from "./texasOutsideSpendingAggregator.js";
import {
  replaceTexasCandidateFinanceSnapshot,
  type TexasFinanceLinkInput,
  type TexasFinanceOutsideGroupBreakdownInput,
  type TexasFinanceOutsideGroupInput,
  type TexasFinanceSummaryInput,
} from "./texasFinanceWriter.js";
import type {
  TexasTecCandidateRow,
  TexasTecContributionRow,
  TexasTecExpenditureRow,
  TexasTecFilerRow,
  TexasTecPurposeRow,
  TexasTecSpacRow,
} from "./texasTecCsvDatabaseReader.js";

type Queryable = Pick<Pool | PoolClient, "query">;

const DEFAULT_AI_CLASSIFICATION_MIN_AMOUNT = 25_000;
// Display cap on PERSISTED donor rows per (committee, direction), applied
// AFTER classification so a >cap-donor group still gets industry totals built
// from every donor. Industry rows are bounded by the slug set and never capped.
const DEFAULT_MAX_BREAKDOWNS_PER_CATEGORY = 50;

export type TexasCandidateFinanceSyncInput = {
  db: Queryable;
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district?: string | null;
  filerRows: readonly TexasTecFilerRow[];
  contributionRows: readonly TexasTecContributionRow[];
  committeeRegistryRows?: readonly TexasTecFilerRow[];
  purposeRows?: readonly TexasTecPurposeRow[];
  candidateRows?: readonly TexasTecCandidateRow[];
  expenditureRows?: readonly TexasTecExpenditureRow[];
  spacRows?: readonly TexasTecSpacRow[];
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
    receiptCommitteeIds?: readonly string[];
    sourceUrl?: string | null;
  };
};

export type TexasCandidateFinanceSyncResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  dryRun: boolean;
  resolution: TexasCandidateCommitteeResolution;
  // True when outside-spending aggregation saw includable purpose rows for
  // two conflicting formal first names behind the candidate's nickname. The
  // sync refuses to write anything so the previously stored snapshot is
  // preserved; the candidate needs a human identity check.
  outsideIdentityConflict: boolean;
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
  matchedCandidateExpenditureRowCount: number;
  includedCandidateExpenditureRowCount: number;
  skippedCandidateExpenditureRowCount: number;
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
  if (!Number.isInteger(value) || value < 2014 || value > 2100) {
    throw new Error(`Invalid Texas finance election year: ${value}`);
  }
  return value;
}

function normalizeCandidateNameForStorage(value: string): string {
  const keys = normalizeTexasCandidateNameKeys(value);
  return [...keys][0] ?? requireNonEmpty(value, "candidate name").replace(/\s+/g, " ").toUpperCase();
}

function normalizeTimestamp(value: Date | undefined): Date {
  const normalized = value ?? new Date();
  if (Number.isNaN(normalized.getTime())) {
    throw new Error("Invalid Texas finance sync timestamp");
  }
  return normalized;
}

function normalizeAiClassificationMinAmount(value: number | undefined): number {
  const normalized = value ?? DEFAULT_AI_CLASSIFICATION_MIN_AMOUNT;
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error("Texas finance aiClassificationMinAmount must be a nonnegative number");
  }
  return normalized;
}

function normalizeMaxDonorBreakdowns(value: number | undefined): number {
  const normalized = value ?? DEFAULT_MAX_BREAKDOWNS_PER_CATEGORY;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Texas finance outsideMaxBreakdownsPerCategory: ${value}`);
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
  sourceUrl?: string | null;
  verifiedAt: Date;
}): TexasFinanceLinkInput {
  return {
    candidateId: requireNonEmpty(input.candidateId, "candidate id"),
    electionId: requireNonEmpty(input.electionId, "election id"),
    electionYear: input.electionYear,
    candidateNameNormalized: normalizeCandidateNameForStorage(input.candidateName),
    officeName: requireNonEmpty(input.officeName, "office name"),
    district: input.district ?? null,
    committeeId: requireNonEmpty(input.committeeId, "Texas committee id"),
    committeeName: requireNonEmpty(input.committeeName, "Texas committee name"),
    linkStatus: "active",
    linkSource: "tec_bulk",
    sourceUrl: input.sourceUrl ?? null,
    lastVerifiedAt: input.verifiedAt,
  };
}

function aggregateDirect(input: {
  committeeId: string;
  committeeIds?: readonly string[];
  electionYear: number;
  contributionRows: readonly TexasTecContributionRow[];
  committeeRegistryRows?: readonly TexasTecFilerRow[];
  contributionSourceUrl?: string | null;
  maxBreakdownsPerCategory?: number;
}): TexasDirectContributionAggregationResult {
  return aggregateTexasDirectContributions({
    committeeId: input.committeeId,
    committeeIds: input.committeeIds,
    electionYear: input.electionYear,
    contributionRows: input.contributionRows,
    committeeRegistryRows: input.committeeRegistryRows,
    sourceUrl: input.contributionSourceUrl ?? null,
    maxBreakdownsPerCategory: input.maxBreakdownsPerCategory,
  });
}

function aggregateOutside(input: {
  candidateName: string;
  candidateCommitteeId: string;
  candidateCommitteeIds?: readonly string[];
  electionYear: number;
  officeScope: string;
  officeName: string;
  district?: string | null;
  candidateRows: readonly TexasTecCandidateRow[];
  expenditureRows: readonly TexasTecExpenditureRow[];
  spacRows: readonly TexasTecSpacRow[];
  purposeRows: readonly TexasTecPurposeRow[];
  outsideSourceUrl?: string | null;
  maxGroups?: number;
}): TexasOutsideSpendingAggregationResult {
  return aggregateTexasOutsideSpending({
    candidateName: input.candidateName,
    candidateCommitteeId: input.candidateCommitteeId,
    candidateCommitteeIds: input.candidateCommitteeIds,
    officeScope: input.officeScope,
    officeName: input.officeName,
    electionYear: input.electionYear,
    district: input.district,
    candidateRows: input.candidateRows,
    expenditureRows: input.expenditureRows,
    spacRows: input.spacRows,
    purposeRows: input.purposeRows,
    sourceUrl: input.outsideSourceUrl ?? null,
    maxGroups: input.maxGroups,
  });
}

function toOutsideGroups(
  outsideFinance: TexasOutsideSpendingAggregationResult
): TexasFinanceOutsideGroupInput[] | undefined {
  return outsideFinance.summary?.groups.map((group) => ({
    committeeId: group.committeeId,
    committeeName: group.committeeName,
    supportOppose: group.supportOppose,
    amount: group.amount,
    sourceUrl: group.sourceUrl,
  }));
}

function toOutsideGroupBreakdowns(input: {
  outsideGroups: readonly TexasOutsideSpendingGroup[] | undefined;
  contributionRows: readonly TexasTecContributionRow[];
  contributionSourceUrl?: string | null;
  electionYear: number;
  minIndustryAmount?: number;
}): {
  breakdowns: TexasFinanceOutsideGroupBreakdownInput[] | undefined;
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

  const result = aggregateTexasOutsideGroupContributions({
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

function toWriterOutsideBreakdown(
  breakdown: TexasFinanceOutsideGroupBreakdown
): TexasFinanceOutsideGroupBreakdownInput {
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

function outsideBreakdownKey(input: TexasFinanceOutsideGroupBreakdownInput): string {
  const categoryKey =
    input.categoryType === "donor"
      ? normalizeFinanceLabel(input.categoryName, "donor")
      : input.categoryName.trim().toUpperCase();
  return `${input.committeeId.trim().toUpperCase()}\u0000${input.supportOppose}\u0000${input.categoryType}\u0000${categoryKey}`;
}

function toOutsideBreakdownMap(
  breakdowns: readonly TexasFinanceOutsideGroupBreakdownInput[]
): Map<string, TexasFinanceOutsideGroupBreakdownInput> {
  const result = new Map<string, TexasFinanceOutsideGroupBreakdownInput>();
  for (const breakdown of breakdowns) {
    addOutsideBreakdown(result, breakdown);
  }
  return result;
}

function collectOutsideClassifications(
  breakdowns: Iterable<TexasFinanceOutsideGroupBreakdownInput>,
  minAmount: number
): Map<string, FinanceLabelClassification> {
  const classifications = new Map<string, FinanceLabelClassification>();
  for (const breakdown of breakdowns) {
    if (breakdown.categoryType !== "donor") {
      continue;
    }
    if (breakdown.amount < minAmount) {
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

function addOutsideBreakdown(
  breakdowns: Map<string, TexasFinanceOutsideGroupBreakdownInput>,
  breakdown: TexasFinanceOutsideGroupBreakdownInput
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

function capDonorBreakdowns(
  breakdowns: readonly TexasFinanceOutsideGroupBreakdownInput[],
  maxDonorsPerGroup: number
): TexasFinanceOutsideGroupBreakdownInput[] {
  const donorsByGroup = new Map<string, TexasFinanceOutsideGroupBreakdownInput[]>();
  for (const breakdown of breakdowns) {
    if (breakdown.categoryType !== "donor") {
      continue;
    }
    const key = `${breakdown.committeeId.trim().toUpperCase()}\u0000${breakdown.supportOppose}`;
    const list = donorsByGroup.get(key) ?? [];
    list.push(breakdown);
    donorsByGroup.set(key, list);
  }
  const kept = new Set<TexasFinanceOutsideGroupBreakdownInput>();
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
  outsideGroupBreakdowns: readonly TexasFinanceOutsideGroupBreakdownInput[] | undefined;
  classifier: FinanceIndustryClassifier | undefined;
  aiClassificationMinAmount: number;
  maxDonorBreakdownsPerGroup: number;
  dryRun: boolean;
}): Promise<{
  outsideGroupBreakdowns: TexasFinanceOutsideGroupBreakdownInput[] | undefined;
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
  directFinance: TexasDirectContributionAggregationResult;
  outsideFinance: TexasOutsideSpendingAggregationResult;
  outsideDataAvailable: boolean;
  fallbackSourceUrl?: string | null;
}): TexasFinanceSummaryInput {
  return {
    totalReceipts: input.directFinance.summary.totalReceipts,
    directContributionTotal: input.directFinance.summary.directContributionTotal,
    outsideSupportTotal: input.outsideDataAvailable ? input.outsideFinance.summary?.supportTotal ?? 0 : null,
    outsideOpposeTotal: input.outsideDataAvailable ? input.outsideFinance.summary?.opposeTotal ?? 0 : null,
    sourceUrl:
      input.directFinance.summary.sourceUrl ??
      input.outsideFinance.summary?.sourceUrl ??
      input.fallbackSourceUrl ??
      null,
  };
}

function emptyOutsideResult(): TexasOutsideSpendingAggregationResult {
  return {
    summary: null,
    firstNameConflict: false,
    matchedCandidateExpenditureRowCount: 0,
    includedCandidateExpenditureRowCount: 0,
    skippedCandidateExpenditureRowCount: 0,
  };
}

function resolveTrustedCommittee(input: {
  committeeId: string;
  committeeName: string;
  receiptCommitteeIds?: readonly string[];
  sourceUrl?: string | null;
}): TexasCandidateCommitteeResolution {
  const committeeId = requireNonEmpty(input.committeeId, "trusted Texas committee id");
  const committeeName = requireNonEmpty(input.committeeName, "trusted Texas committee name");
  const receiptCommitteeIds = [
    ...new Set(
      [committeeId, ...(input.receiptCommitteeIds ?? [])]
        .map((id) => id.trim().toUpperCase())
        .filter(Boolean)
    ),
  ];
  return {
    status: "matched",
    committeeId,
    committeeName,
    receiptCommitteeIds,
    receiptCommittees: receiptCommitteeIds.map((receiptCommitteeId) => ({
      committeeId: receiptCommitteeId,
      committeeName: receiptCommitteeId === committeeId ? committeeName : receiptCommitteeId,
      relationship: receiptCommitteeId === committeeId ? "candidate_filer" : "campaign_named_committee",
    })),
    confidence: "exact",
    source: "tec_bulk",
    sourceUrl: input.sourceUrl ?? null,
    matchedFilerRowCount: 0,
  };
}

function hasOutsideRows(input: TexasCandidateFinanceSyncInput): input is TexasCandidateFinanceSyncInput & {
  candidateRows: readonly TexasTecCandidateRow[];
  expenditureRows: readonly TexasTecExpenditureRow[];
  spacRows: readonly TexasTecSpacRow[];
  purposeRows: readonly TexasTecPurposeRow[];
} {
  return input.candidateRows !== undefined && input.expenditureRows !== undefined && input.spacRows !== undefined
    && input.purposeRows !== undefined;
}

export async function syncTexasCandidateFinance(
  input: TexasCandidateFinanceSyncInput
): Promise<TexasCandidateFinanceSyncResult> {
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
    : resolveTexasCandidateCommittee({
        candidateName,
        officeScope,
        officeName,
        electionYear,
        district: input.district,
        filerRows: input.filerRows,
        sourceUrl: input.sourceUrl ?? null,
      });

  if (resolution.status !== "matched") {
    return {
      candidateId,
      electionId,
      electionYear,
      dryRun: input.dryRun === true,
      resolution,
      outsideIdentityConflict: false,
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
      matchedCandidateExpenditureRowCount: 0,
      includedCandidateExpenditureRowCount: 0,
      skippedCandidateExpenditureRowCount: 0,
      matchedOutsideContributionRowCount: 0,
      includedOutsideContributionRowCount: 0,
      skippedOutsideContributionRowCount: 0,
    };
  }

  const directFinance = aggregateDirect({
    committeeId: resolution.committeeId,
    committeeIds: resolution.receiptCommitteeIds,
    electionYear,
    contributionRows: input.contributionRows,
    committeeRegistryRows: input.committeeRegistryRows,
    contributionSourceUrl: input.contributionSourceUrl ?? resolution.sourceUrl,
    maxBreakdownsPerCategory: input.directMaxBreakdownsPerCategory,
  });
  const outsideFinance = hasOutsideRows(input)
    ? aggregateOutside({
        candidateName,
        candidateCommitteeId: resolution.committeeId,
        candidateCommitteeIds: resolution.receiptCommitteeIds,
        electionYear,
        officeScope,
        officeName,
        district: input.district,
        candidateRows: input.candidateRows,
        expenditureRows: input.expenditureRows,
        spacRows: input.spacRows,
        purposeRows: input.purposeRows,
        outsideSourceUrl: input.outsideSourceUrl,
        maxGroups: input.outsideMaxGroups,
      })
    : emptyOutsideResult();
  const outsideDataAvailable = hasOutsideRows(input);

  // Includable purpose rows named two conflicting formal first names behind
  // this candidate's nickname: the stored committee link's identity is now in
  // doubt, so write nothing and keep the previously stored snapshot intact
  // rather than persisting zeroed outside totals and an empty group set.
  if (outsideFinance.firstNameConflict) {
    return {
      candidateId,
      electionId,
      electionYear,
      dryRun: input.dryRun === true,
      resolution,
      outsideIdentityConflict: true,
      linkWritten: false,
      summaryWritten: false,
      directBreakdownsWritten: 0,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
      totalReceipts: null,
      directContributionTotal: null,
      outsideSupportTotal: null,
      outsideOpposeTotal: null,
      matchedContributionRowCount: directFinance.matchedContributionRowCount,
      includedContributionRowCount: directFinance.includedContributionRowCount,
      skippedContributionRowCount: directFinance.skippedContributionRowCount,
      matchedCandidateExpenditureRowCount: outsideFinance.matchedCandidateExpenditureRowCount,
      includedCandidateExpenditureRowCount: outsideFinance.includedCandidateExpenditureRowCount,
      skippedCandidateExpenditureRowCount: outsideFinance.skippedCandidateExpenditureRowCount,
      matchedOutsideContributionRowCount: 0,
      includedOutsideContributionRowCount: 0,
      skippedOutsideContributionRowCount: 0,
    };
  }

  const outsideGroups = hasOutsideRows(input) ? toOutsideGroups(outsideFinance) ?? [] : undefined;
  const outsideGroupBreakdowns = toOutsideGroupBreakdowns({
    outsideGroups: outsideDataAvailable ? outsideFinance.summary?.groups ?? [] : undefined,
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
    await replaceTexasCandidateFinanceSnapshot({
      db: input.db,
      link,
      syncedAt,
      summary,
      directBreakdowns: directFinance.directBreakdowns,
      ...(directFinance.pacDonors !== undefined ? { pacDonors: directFinance.pacDonors } : {}),
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
    outsideIdentityConflict: false,
    linkWritten: !input.dryRun,
    summaryWritten: !input.dryRun,
    directBreakdownsWritten: input.dryRun ? 0 : directFinance.directBreakdowns.length,
    outsideGroupsWritten: input.dryRun ? 0 : outsideGroups?.length ?? 0,
    outsideGroupBreakdownsWritten: input.dryRun ? 0 : outsideIndustryFinance.outsideGroupBreakdowns?.length ?? 0,
    totalReceipts: directFinance.summary.totalReceipts,
    directContributionTotal: directFinance.summary.directContributionTotal,
    outsideSupportTotal: outsideDataAvailable ? outsideFinance.summary?.supportTotal ?? 0 : null,
    outsideOpposeTotal: outsideDataAvailable ? outsideFinance.summary?.opposeTotal ?? 0 : null,
    matchedContributionRowCount: directFinance.matchedContributionRowCount,
    includedContributionRowCount: directFinance.includedContributionRowCount,
    skippedContributionRowCount: directFinance.skippedContributionRowCount,
    matchedCandidateExpenditureRowCount: outsideFinance.matchedCandidateExpenditureRowCount,
    includedCandidateExpenditureRowCount: outsideFinance.includedCandidateExpenditureRowCount,
    skippedCandidateExpenditureRowCount: outsideFinance.skippedCandidateExpenditureRowCount,
    matchedOutsideContributionRowCount: outsideGroupBreakdowns.matchedContributionRowCount,
    includedOutsideContributionRowCount: outsideGroupBreakdowns.includedContributionRowCount,
    skippedOutsideContributionRowCount: outsideGroupBreakdowns.skippedContributionRowCount,
  };
}
