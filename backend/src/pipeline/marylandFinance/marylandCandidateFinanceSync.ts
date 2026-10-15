import type { Pool, PoolClient } from "pg";

import type { FinanceIndustryClassifier } from "../finance/financeIndustryClassificationService.js";
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
  // Retained for compatibility; legacy outside rows are diagnostic-only
  // and cannot authorize persisted donor breakdowns or classifications.
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

function toSummary(input: {
  directFinance: MarylandDirectContributionAggregationResult;
  outsideFinance: MarylandOutsideSpendingAggregationResult;
  fallbackSourceUrl?: string | null;
}): MarylandFinanceSummaryInput {
  return {
    totalReceipts: input.directFinance.summary.totalReceipts,
    directContributionTotal: input.directFinance.summary.directContributionTotal,
    outsideSupportTotal: null,
    outsideOpposeTotal: null,
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
  normalizeAiClassificationMinAmount(input.aiClassificationMinAmount);
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
  normalizeMaxDonorBreakdowns(input.outsideMaxDonorBreakdownsPerGroup);
  // Legacy export arrays have no independently qualified whole-current
  // outside authority. Keep aggregation diagnostics, but omit every outside
  // write and classification so direct refreshes preserve accepted evidence.
  const outsideGroupContributionFinance =
    outsideFinance.summary !== null
      ? aggregateMarylandOutsideGroupContributions({
          electionYear,
          outsideGroups: outsideFinance.summary.groups,
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
    fallbackSourceUrl: input.sourceUrl ?? input.contributionSourceUrl ?? input.expenditureSourceUrl ?? null,
  });

  if (!input.dryRun) {
    await replaceMarylandCandidateFinanceSnapshot({
      db: input.db,
      link,
      syncedAt,
      summary,
      directBreakdowns: directFinance.directBreakdowns,
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
    outsideGroupsWritten: 0,
    outsideGroupBreakdownsWritten: 0,
    totalReceipts: directFinance.summary.totalReceipts,
    directContributionTotal: directFinance.summary.directContributionTotal,
    outsideSupportTotal: null,
    outsideOpposeTotal: null,
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
