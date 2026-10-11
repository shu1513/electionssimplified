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
  type FinanceIndustryClassifiableOutsideBreakdown,
  type FinanceIndustryClassifier,
} from "../finance/financeIndustryClassificationService.js";
import {
  aggregateIllinoisDirectContributions,
  extractIllinoisSbeCommitteeId,
  aggregateIllinoisOutsideGroupContributions,
  aggregateIllinoisOutsideSpending,
  normalizeIllinoisCommitteeKey,
  normalizeIllinoisFinanceTextKey,
  type IllinoisFinanceOutsideGroupBreakdown,
  type IllinoisOutsideSpendingAggregationResult,
  type IllinoisOutsideSpendingGroup,
} from "./illinoisFinanceAggregators.js";
import {
  replaceIllinoisCandidateFinanceSnapshot,
  type IllinoisFinanceDirectBreakdownInput,
  type IllinoisFinanceLinkInput,
  type IllinoisFinanceOutsideGroupBreakdownInput,
  type IllinoisFinanceOutsideGroupInput,
  type IllinoisFinanceSummaryInput,
  type IllinoisFinancePacDonorInput,
  type IllinoisFinanceOutsideReportEvidence,
  type IllinoisFinanceSnapshotWriteResult,
} from "./illinoisFinanceWriter.js";
import {
  ILLINOIS_SBE_CONTRIBUTION_CANDIDATE_SEARCH_URL,
  ILLINOIS_SBE_CONTRIBUTION_COMMITTEE_SEARCH_URL,
  ILLINOIS_SBE_EXPENDITURE_ALL_SEARCH_URL,
  type IllinoisSbeContributionRecord,
  type IllinoisSbeExpenditureRecord,
} from "./illinoisSbeClient.js";
import { aggregateIllinoisD2Summaries } from "./illinoisD2SummaryAggregator.js";
import type { IllinoisSbeD2ReportSummary } from "./illinoisSbeNormalizedArtifact.js";

type Queryable = Pick<Pool | PoolClient, "query">;

const DEFAULT_AI_CLASSIFICATION_MIN_AMOUNT = 25_000;

export type IllinoisCandidateFinanceSyncInput = {
  verifiedQuarterly?: boolean;
  pacDonors?: readonly IllinoisFinancePacDonorInput[];
  outsideReportEvidence?: readonly IllinoisFinanceOutsideReportEvidence[];
  db: Queryable;
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope?: string | null;
  officeName: string;
  district?: string | null;
  sbeCandidateId?: string | null;
  sbeDistrictType?: string | null;
  sbeOffice?: string | null;
  isAtLarge?: boolean | null;
  sbeCommitteeId?: string | null;
  committeeKey: string;
  committeeName: string;
  // Undefined means no itemized contribution source was loaded at all, which
  // is not the same as a source that reported nothing: the first must leave
  // stored breakdowns alone, the second must replace them.
  directContributionRecords?: readonly IllinoisSbeContributionRecord[];
  outsideExpenditureRecords?: readonly IllinoisSbeExpenditureRecord[];
  outsideGroupContributionRecords?: readonly IllinoisSbeContributionRecord[];
  d2ReportSummaries?: readonly IllinoisSbeD2ReportSummary[];
  sourceUrl?: string | null;
  directContributionSourceUrl?: string | null;
  outsideExpenditureSourceUrl?: string | null;
  outsideGroupContributionSourceUrl?: string | null;
  now?: Date;
  dryRun?: boolean;
  directMaxBreakdownsPerCategory?: number;
  outsideMaxGroups?: number;
  outsideMaxBreakdownsPerCategory?: number;
  outsideMinIndustryAmount?: number;
  financeIndustryClassifier?: FinanceIndustryClassifier;
  aiClassificationMinAmount?: number;
};

export type IllinoisCandidateFinanceSyncResult = {
  pacDonorsWritten?: number;
  outsidePreserved?: boolean;
  candidateId: string;
  electionId: string;
  electionYear: number;
  dryRun: boolean;
  linkWritten: boolean;
  summaryWritten: boolean;
  directBreakdownsWritten: number;
  outsideGroupsWritten: number;
  outsideGroupBreakdownsWritten: number;
  totalReceipts: number | null;
  directContributionTotal: number | null;
  totalDisbursements: number | null;
  cashOnHand: number | null;
  debtsOwed: number | null;
  outsideExpenditureDataAvailable: boolean;
  outsideGroupContributionDataAvailable: boolean;
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
    throw new Error(`Invalid Illinois finance election year: ${value}`);
  }
  return value;
}

function normalizeTimestamp(value: Date | undefined): Date {
  const normalized = value ?? new Date();
  if (Number.isNaN(normalized.getTime())) {
    throw new Error("Invalid Illinois finance sync timestamp");
  }
  return normalized;
}

function normalizeAiClassificationMinAmount(value: number | undefined): number {
  const normalized = value ?? DEFAULT_AI_CLASSIFICATION_MIN_AMOUNT;
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error("Illinois finance aiClassificationMinAmount must be a nonnegative number");
  }
  return normalized;
}

function normalizeCandidateNameForStorage(value: string): string {
  return normalizeIllinoisFinanceTextKey(value);
}

function toFinanceLink(input: {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeName: string;
  district?: string | null;
  sbeCandidateId?: string | null;
  sbeDistrictType?: string | null;
  sbeOffice?: string | null;
  isAtLarge?: boolean | null;
  committeeKey: string;
  committeeName: string;
  sourceUrl?: string | null;
  verifiedAt: Date;
}): IllinoisFinanceLinkInput {
  return {
    candidateId: requireNonEmpty(input.candidateId, "candidate id"),
    electionId: requireNonEmpty(input.electionId, "election id"),
    electionYear: input.electionYear,
    candidateNameNormalized: normalizeCandidateNameForStorage(input.candidateName),
    officeName: requireNonEmpty(input.officeName, "office name"),
    district: input.district ?? null,
    sbeCandidateId: input.sbeCandidateId ?? null,
    sbeDistrictType: input.sbeDistrictType ?? null,
    sbeOffice: input.sbeOffice ?? null,
    isAtLarge: input.isAtLarge ?? null,
    committeeKey: normalizeIllinoisCommitteeKey(requireNonEmpty(input.committeeKey, "Illinois committee key")),
    committeeName: requireNonEmpty(input.committeeName, "Illinois committee name"),
    linkStatus: "active",
    linkSource: "illinois_sbe",
    sourceUrl: input.sourceUrl ?? null,
    lastVerifiedAt: input.verifiedAt,
  };
}

function toDirectBreakdown(input: {
  categoryType: IllinoisFinanceDirectBreakdownInput["categoryType"];
  categoryName: string;
  amount: number;
  contributorCount: number;
  sourceUrl: string | null;
}): IllinoisFinanceDirectBreakdownInput {
  return {
    categoryType: input.categoryType,
    categoryName: input.categoryName,
    amount: input.amount,
    contributorCount: input.contributorCount,
    sourceUrl: input.sourceUrl,
  };
}

function toOutsideGroups(
  outsideFinance: IllinoisOutsideSpendingAggregationResult
): IllinoisFinanceOutsideGroupInput[] | undefined {
  return outsideFinance.summary?.groups.map((group) => ({
    committeeKey: group.committeeKey,
    committeeName: group.committeeName,
    supportOppose: group.supportOppose,
    amount: group.amount,
    sourceUrl: group.sourceUrl,
  }));
}

function toWriterOutsideBreakdown(
  breakdown: IllinoisFinanceOutsideGroupBreakdown
): IllinoisFinanceOutsideGroupBreakdownInput {
  return {
    committeeKey: breakdown.committeeKey,
    supportOppose: breakdown.supportOppose,
    categoryType: breakdown.categoryType,
    categoryName: breakdown.categoryName,
    amount: breakdown.amount,
    contributorCount: breakdown.contributorCount,
    sourceUrl: breakdown.sourceUrl,
  };
}

function toOutsideGroupBreakdowns(input: {
  outsideGroups: readonly IllinoisOutsideSpendingGroup[] | undefined;
  contributionRecords: readonly IllinoisSbeContributionRecord[] | undefined;
  sourceUrl?: string | null;
  electionYear: number;
  maxBreakdownsPerCategory?: number;
  minIndustryAmount?: number;
}): {
  breakdowns: IllinoisFinanceOutsideGroupBreakdownInput[] | undefined;
  matchedContributionRowCount: number;
  includedContributionRowCount: number;
  skippedContributionRowCount: number;
} {
  if (!input.outsideGroups || input.contributionRecords === undefined) {
    return {
      breakdowns: undefined,
      matchedContributionRowCount: 0,
      includedContributionRowCount: 0,
      skippedContributionRowCount: 0,
    };
  }

  const result = aggregateIllinoisOutsideGroupContributions({
    electionYear: input.electionYear,
    outsideGroups: input.outsideGroups,
    contributionRecords: input.contributionRecords,
    sourceUrl: input.sourceUrl ?? null,
    maxBreakdownsPerCategory: input.maxBreakdownsPerCategory,
    minIndustryAmount: input.minIndustryAmount,
  });
  return {
    breakdowns: result.outsideGroupBreakdowns.map(toWriterOutsideBreakdown),
    matchedContributionRowCount: result.matchedContributionRowCount,
    includedContributionRowCount: result.includedContributionRowCount,
    skippedContributionRowCount: result.skippedContributionRowCount,
  };
}

function outsideBreakdownKey(input: IllinoisFinanceOutsideGroupBreakdownInput): string {
  const categoryKey =
    input.categoryType === "donor"
      ? normalizeFinanceLabel(input.categoryName, "donor")
      : input.categoryName.trim().toUpperCase();
  return `${normalizeIllinoisCommitteeKey(input.committeeKey)}\u0000${input.supportOppose}\u0000${input.categoryType}\u0000${categoryKey}`;
}

function addOutsideBreakdown(
  breakdowns: Map<string, IllinoisFinanceOutsideGroupBreakdownInput>,
  breakdown: IllinoisFinanceOutsideGroupBreakdownInput
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

function toOutsideBreakdownMap(
  breakdowns: readonly IllinoisFinanceOutsideGroupBreakdownInput[]
): Map<string, IllinoisFinanceOutsideGroupBreakdownInput> {
  const result = new Map<string, IllinoisFinanceOutsideGroupBreakdownInput>();
  for (const breakdown of breakdowns) {
    addOutsideBreakdown(result, breakdown);
  }
  return result;
}

function collectOutsideClassifications(
  breakdowns: Iterable<IllinoisFinanceOutsideGroupBreakdownInput>,
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

function toClassifiableOutsideBreakdown(
  breakdown: IllinoisFinanceOutsideGroupBreakdownInput
): FinanceIndustryClassifiableOutsideBreakdown {
  return {
    committeeId: breakdown.committeeKey,
    supportOppose: breakdown.supportOppose,
    categoryType: breakdown.categoryType,
    categoryName: breakdown.categoryName,
    amount: breakdown.amount,
    contributorCount: breakdown.contributorCount,
    sourceUrl: breakdown.sourceUrl,
  };
}

async function enrichOutsideGroupIndustryBreakdowns(input: {
  db: Queryable;
  outsideGroupBreakdowns: readonly IllinoisFinanceOutsideGroupBreakdownInput[] | undefined;
  classifier: FinanceIndustryClassifier | undefined;
  aiClassificationMinAmount: number;
  dryRun: boolean;
}): Promise<{
  outsideGroupBreakdowns: IllinoisFinanceOutsideGroupBreakdownInput[] | undefined;
  classifications: FinanceLabelClassification[];
}> {
  if (!input.outsideGroupBreakdowns) {
    return { outsideGroupBreakdowns: undefined, classifications: [] };
  }

  const breakdowns = toOutsideBreakdownMap(input.outsideGroupBreakdowns);
  const classifications = collectOutsideClassifications(breakdowns.values(), input.aiClassificationMinAmount);
  const classifiableOutsideBreakdowns = [...breakdowns.values()].map(toClassifiableOutsideBreakdown);
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
      committeeKey: breakdown.committeeId,
      supportOppose: breakdown.supportOppose,
      categoryType: breakdown.categoryType,
      categoryName: breakdown.categoryName,
      amount: breakdown.amount,
      contributorCount: breakdown.contributorCount,
      sourceUrl: breakdown.sourceUrl,
    });
  }

  return {
    outsideGroupBreakdowns: [...breakdowns.values()],
    classifications: [...classifications.values()],
  };
}

function toSummary(input: {
  totalReceipts: number | null;
  directContributionTotal: number | null;
  totalDisbursements: number | null;
  cashOnHand: number | null;
  debtsOwed: number | null;
  outsideFinance: IllinoisOutsideSpendingAggregationResult;
  outsideDataAvailable: boolean;
  fallbackSourceUrl?: string | null;
}): IllinoisFinanceSummaryInput {
  return {
    totalReceipts: input.totalReceipts,
    directContributionTotal: input.directContributionTotal,
    totalDisbursements: input.totalDisbursements,
    cashOnHand: input.cashOnHand,
    debtsOwed: input.debtsOwed,
    outsideSupportTotal: input.outsideDataAvailable ? input.outsideFinance.summary?.supportTotal ?? 0 : null,
    outsideOpposeTotal: input.outsideDataAvailable ? input.outsideFinance.summary?.opposeTotal ?? 0 : null,
    sourceUrl: input.fallbackSourceUrl ?? null,
  };
}

function emptyOutsideResult(): IllinoisOutsideSpendingAggregationResult {
  return {
    summary: null,
    matchedExpenditureRowCount: 0,
    includedExpenditureRowCount: 0,
    skippedExpenditureRowCount: 0,
  };
}

export async function syncIllinoisCandidateFinance(
  input: IllinoisCandidateFinanceSyncInput
): Promise<IllinoisCandidateFinanceSyncResult> {
  const candidateId = requireNonEmpty(input.candidateId, "candidate id");
  const electionId = requireNonEmpty(input.electionId, "election id");
  const candidateName = requireNonEmpty(input.candidateName, "candidate name");
  const officeName = requireNonEmpty(input.officeName, "office name");
  const electionYear = normalizeElectionYear(input.electionYear);
  const syncedAt = normalizeTimestamp(input.now);
  const aiClassificationMinAmount = normalizeAiClassificationMinAmount(input.aiClassificationMinAmount);
  const directSourceUrl = input.directContributionSourceUrl ?? ILLINOIS_SBE_CONTRIBUTION_CANDIDATE_SEARCH_URL;
  const outsideSourceUrl = input.outsideExpenditureSourceUrl ?? ILLINOIS_SBE_EXPENDITURE_ALL_SEARCH_URL;
  const outsideGroupSourceUrl =
    input.outsideGroupContributionSourceUrl ?? ILLINOIS_SBE_CONTRIBUTION_COMMITTEE_SEARCH_URL;
  const sbeCommitteeId = input.sbeCommitteeId?.trim() || extractIllinoisSbeCommitteeId(input.committeeKey);

  const modernDirectNeedsProof = input.directContributionRecords?.some((row) => row.documentName !== undefined) === true;
  const directContributionDataAvailable = input.directContributionRecords !== undefined &&
    (!modernDirectNeedsProof || input.verifiedQuarterly === true);
  const directFinance = aggregateIllinoisDirectContributions({
    electionYear,
    contributionRecords: directContributionDataAvailable ? input.directContributionRecords ?? [] : [],
    // Verified modern rows carry the exact receiving ID; stored labels may be older aliases.
    committeeKey: input.verifiedQuarterly ? null : input.committeeName,
    committeeId: input.verifiedQuarterly ? sbeCommitteeId : null,
    sourceUrl: directSourceUrl,
    maxBreakdownsPerCategory: input.directMaxBreakdownsPerCategory,
  });
  const outsideDataAvailable = input.outsideExpenditureRecords !== undefined &&
    (!input.outsideExpenditureRecords.some((row) => row.documentName !== undefined) ||
      input.outsideReportEvidence !== undefined);
  const outsideGroupContributionDataAvailable = input.outsideGroupContributionRecords !== undefined;
  const outsideFinance = outsideDataAvailable && input.outsideExpenditureRecords
    ? aggregateIllinoisOutsideSpending({
        electionYear,
        expenditureRecords: input.outsideExpenditureRecords,
        sourceUrl: outsideSourceUrl,
        maxGroups: input.outsideReportEvidence ? Math.max(1, input.outsideExpenditureRecords.length) : input.outsideMaxGroups,
      })
    : emptyOutsideResult();
  const outsideGroups = outsideDataAvailable ? toOutsideGroups(outsideFinance) ?? [] : undefined;
  if (input.outsideReportEvidence && outsideGroups) {
    for (const group of outsideGroups) {
      const ids = new Set(input.outsideExpenditureRecords?.filter((row) =>
        `SBE:${row.committeeId}` === group.committeeKey && row.supportOppose === group.supportOppose)
        .map((row) => row.sourceDocumentId));
      group.sourceReports = input.outsideReportEvidence.filter((report) => ids.has(report.filedDocId));
    }
  }
  const outsideGroupBreakdowns = toOutsideGroupBreakdowns({
    outsideGroups: outsideFinance.summary?.groups,
    contributionRecords: input.outsideGroupContributionRecords,
    sourceUrl: outsideGroupSourceUrl,
    electionYear,
    maxBreakdownsPerCategory: input.outsideMaxBreakdownsPerCategory,
    minIndustryAmount: input.outsideMinIndustryAmount,
  });
  const outsideIndustryFinance = await enrichOutsideGroupIndustryBreakdowns({
    db: input.db,
    outsideGroupBreakdowns: outsideGroupBreakdowns.breakdowns,
    classifier: input.financeIndustryClassifier,
    aiClassificationMinAmount,
    dryRun: input.dryRun === true,
  });
  const link = toFinanceLink({
    candidateId,
    electionId,
    candidateName,
    electionYear,
    officeName,
    district: input.district,
    sbeCandidateId: input.sbeCandidateId,
    sbeDistrictType: input.sbeDistrictType,
    sbeOffice: input.sbeOffice,
    isAtLarge: input.isAtLarge,
    committeeKey: input.committeeKey,
    committeeName: input.committeeName,
    sourceUrl: input.sourceUrl ?? directSourceUrl,
    verifiedAt: syncedAt,
  });
  const d2Finance =
    input.d2ReportSummaries !== undefined && sbeCommitteeId
      ? aggregateIllinoisD2Summaries({
          electionYear,
          committeeId: sbeCommitteeId,
          reports: input.d2ReportSummaries,
        })
      : null;
  const requiresD2Totals = input.verifiedQuarterly || modernDirectNeedsProof ||
    input.directContributionRecords === undefined || input.officeScope === "place" || input.d2ReportSummaries !== undefined;
  const summary = toSummary({
    totalReceipts: d2Finance?.totalReceipts ?? (requiresD2Totals ? null : directFinance.summary.totalReceipts),
    directContributionTotal: requiresD2Totals ? null : directFinance.summary.directContributionTotal,
    totalDisbursements: d2Finance?.totalDisbursements ?? null,
    cashOnHand: d2Finance?.cashOnHand ?? null,
    debtsOwed: d2Finance?.debtsOwed ?? null,
    outsideFinance,
    outsideDataAvailable,
    fallbackSourceUrl: d2Finance?.sourceUrl ?? input.sourceUrl ?? directSourceUrl ?? outsideSourceUrl ?? outsideGroupSourceUrl,
  });
  const summaryAvailable = input.verifiedQuarterly
    ? input.d2ReportSummaries !== undefined || outsideDataAvailable
    : input.officeScope !== "place" || input.d2ReportSummaries !== undefined;

  let written: IllinoisFinanceSnapshotWriteResult | undefined;
  if (!input.dryRun) {
    written = await replaceIllinoisCandidateFinanceSnapshot({
      db: input.db,
      link,
      syncedAt,
      summary: summaryAvailable ? summary : undefined,
      // Omitted, not emptied, when nothing itemized was loaded: the writer
      // deletes stored breakdowns for any list it is given, so a
      // summaries-only refresh would otherwise erase them.
      directBreakdowns: directContributionDataAvailable
        ? directFinance.directBreakdowns.map(toDirectBreakdown)
        : undefined,
      outsideGroups,
      pacDonors: input.pacDonors,
      outsideReportEvidence: input.outsideReportEvidence,
      outsideGroupBreakdowns: outsideIndustryFinance.outsideGroupBreakdowns,
      classifications: outsideIndustryFinance.classifications,
    });
  }

  return {
    candidateId,
    electionId,
    electionYear,
    dryRun: input.dryRun === true,
    linkWritten: !input.dryRun,
    summaryWritten: !input.dryRun && summaryAvailable,
    directBreakdownsWritten:
      input.dryRun || !directContributionDataAvailable ? 0 : directFinance.directBreakdowns.length,
    pacDonorsWritten: written?.pacDonorsWritten ?? 0,
    outsidePreserved: written?.outsidePreserved,
    outsideGroupsWritten: written?.outsideGroupsWritten ?? 0,
    outsideGroupBreakdownsWritten: written?.outsideGroupBreakdownsWritten ?? 0,
    totalReceipts: summary.totalReceipts ?? null,
    directContributionTotal: summary.directContributionTotal ?? null,
    totalDisbursements: summary.totalDisbursements ?? null,
    cashOnHand: summary.cashOnHand ?? null,
    debtsOwed: summary.debtsOwed ?? null,
    outsideExpenditureDataAvailable: outsideDataAvailable,
    outsideGroupContributionDataAvailable,
    outsideSupportTotal: outsideDataAvailable && !written?.outsidePreserved ? outsideFinance.summary?.supportTotal ?? 0 : null,
    outsideOpposeTotal: outsideDataAvailable && !written?.outsidePreserved ? outsideFinance.summary?.opposeTotal ?? 0 : null,
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
