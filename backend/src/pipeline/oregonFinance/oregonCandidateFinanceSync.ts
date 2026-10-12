import type { Pool, PoolClient } from "pg";

import {
  classifyFinanceLabel,
  type FinanceLabelClassification,
} from "../finance/financeLabelClassifier.js";
import { mergeFinanceLabelClassification } from "../finance/financeIndustryClassificationService.js";
import { normalizeOregonCandidateNameForStorage } from "./oregonCandidateCommitteeResolver.js";
import {
  aggregateOregonDirectContributions,
  aggregateOregonOutsideGroupContributions,
  aggregateOregonOutsideSpending,
  type OregonFinanceOutsideGroupBreakdown,
} from "./oregonFinanceAggregator.js";
import {
  replaceOregonCandidateFinanceSnapshot,
  type OregonFinanceDirectBreakdownInput,
  type OregonFinanceLinkInput,
  type OregonFinanceOutsideGroupBreakdownInput,
  type OregonFinanceOutsideGroupInput,
  type OregonFinanceSummaryInput,
  type OregonFinanceSnapshotWriteResult,
} from "./oregonFinanceWriter.js";
import type { OregonVerifiedFinanceComponents } from "./oregonVerifiedFinancePersistence.js";
import {
  OREGON_ORESTAR_TRANSACTION_SEARCH_URL,
  type OregonOrestarTransactionDetail,
} from "./oregonOrestarParser.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & Pick<Pool, "connect">;

export type OregonCandidateFinanceSyncInput = {
  db: ConnectableQueryable;
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeName: string;
  district?: string | null;
  committeeId: string;
  committeeName: string;
  sourceUrl?: string | null;
  now?: Date;
  dryRun?: boolean;
  transactionDetails: readonly OregonOrestarTransactionDetail[];
  /** Separate outside-source coverage; a candidate's receipts prove no outside total. */
  outsideTransactionDetails?: readonly OregonOrestarTransactionDetail[];
  verifiedFinance?: OregonVerifiedFinanceComponents;
  verifiedFinanceDiagnostics?: readonly string[];
  verifiedSourceGenerationDir?: string;
  directMaxBreakdownsPerCategory?: number;
  outsideMaxGroups?: number;
  outsideMaxBreakdownsPerCategory?: number;
  minIndustryAmount?: number;
};

export type OregonCandidateFinanceSyncResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  dryRun: boolean;
  linkWritten: boolean;
  summaryWritten: boolean;
  directBreakdownsWritten: number;
  outsideGroupsWritten: number;
  outsideGroupBreakdownsWritten: number;
  pacDonorsWritten?: number;
  verifiedFinanceDiagnostics?: readonly string[];
  verifiedSourceGenerationDir?: string;
  directContributionTotal: number | null;
  outsideSupportTotal: number | null;
  outsideOpposeTotal: number | null;
  transactionDetailCount: number;
  matchedDirectContributionRowCount: number;
  includedDirectContributionRowCount: number;
  skippedDirectContributionRowCount: number;
  matchedExpenditureRowCount: number;
  includedOutsideAssociationCount: number;
  skippedOutsideAssociationCount: number;
  matchedOutsideGroupContributionRowCount: number;
  includedOutsideGroupContributionRowCount: number;
  skippedOutsideGroupContributionRowCount: number;
};

const DEFAULT_MAX_BREAKDOWNS_PER_CATEGORY = 20;
const DEFAULT_OUTSIDE_MAX_GROUPS = 20;
const DEFAULT_MIN_INDUSTRY_AMOUNT = 25_000;

function requireNonEmpty(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmed;
}

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new Error(`Invalid Oregon finance election year: ${value}`);
  }
  return value;
}

function normalizeTimestamp(value: Date | undefined): Date {
  const normalized = value ?? new Date();
  if (Number.isNaN(normalized.getTime())) {
    throw new Error("Invalid Oregon finance sync timestamp");
  }
  return normalized;
}

function normalizePositiveInteger(value: number | undefined, fallback: number, fieldName: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Oregon finance ${fieldName}: ${value}`);
  }
  return normalized;
}

function normalizeMinIndustryAmount(value: number | undefined): number {
  const normalized = value ?? DEFAULT_MIN_INDUSTRY_AMOUNT;
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`Invalid Oregon finance minIndustryAmount: ${value}`);
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
}): OregonFinanceLinkInput {
  return {
    candidateId: requireNonEmpty(input.candidateId, "candidate id"),
    electionId: requireNonEmpty(input.electionId, "election id"),
    electionYear: input.electionYear,
    candidateNameNormalized: normalizeOregonCandidateNameForStorage(requireNonEmpty(input.candidateName, "candidate name")),
    officeName: requireNonEmpty(input.officeName, "office name"),
    district: input.district ?? null,
    committeeId: requireNonEmpty(input.committeeId, "Oregon ORESTAR committee ID"),
    committeeName: requireNonEmpty(input.committeeName, "Oregon committee name"),
    linkStatus: "active",
    linkSource: "orestar",
    sourceUrl: input.sourceUrl ?? OREGON_ORESTAR_TRANSACTION_SEARCH_URL,
    lastVerifiedAt: input.verifiedAt,
  };
}

function toSummary(input: {
  directContributionTotal: number;
  outsideSupportTotal: number | null;
  outsideOpposeTotal: number | null;
  sourceUrl?: string | null;
}): OregonFinanceSummaryInput {
  return {
    directContributionTotal: input.directContributionTotal,
    outsideSupportTotal: input.outsideSupportTotal,
    outsideOpposeTotal: input.outsideOpposeTotal,
    sourceUrl: input.sourceUrl ?? OREGON_ORESTAR_TRANSACTION_SEARCH_URL,
  };
}

function toDirectBreakdowns(
  breakdowns: readonly OregonFinanceDirectBreakdownInput[]
): OregonFinanceDirectBreakdownInput[] {
  return breakdowns.map((breakdown) => ({
    categoryType: breakdown.categoryType,
    categoryName: breakdown.categoryName,
    amount: breakdown.amount,
    contributorCount: breakdown.contributorCount ?? null,
    sourceUrl: breakdown.sourceUrl ?? null,
  }));
}

function toOutsideGroups(groups: readonly OregonFinanceOutsideGroupInput[]): OregonFinanceOutsideGroupInput[] {
  return groups.map((group) => ({
    sponsorId: group.sponsorId,
    sponsorName: group.sponsorName,
    supportOppose: group.supportOppose,
    amount: group.amount,
    sourceUrl: group.sourceUrl ?? null,
  }));
}

function toOutsideGroupBreakdowns(
  breakdowns: readonly OregonFinanceOutsideGroupBreakdown[]
): OregonFinanceOutsideGroupBreakdownInput[] {
  return breakdowns.map((breakdown) => ({
    sponsorId: breakdown.sponsorId,
    supportOppose: breakdown.supportOppose,
    categoryType: breakdown.categoryType,
    categoryName: breakdown.categoryName,
    amount: breakdown.amount,
    contributorCount: breakdown.contributorCount ?? null,
    sourceUrl: breakdown.sourceUrl ?? null,
  }));
}

function isOregonContributionTransaction(detail: OregonOrestarTransactionDetail): boolean {
  return /\bCONTRIBUTION\b/i.test(detail.transactionType ?? "");
}

function collectOutsideClassifications(input: {
  breakdowns: Iterable<OregonFinanceOutsideGroupBreakdownInput>;
  minIndustryAmount: number;
}): FinanceLabelClassification[] {
  const classifications = new Map<string, FinanceLabelClassification>();
  for (const breakdown of input.breakdowns) {
    if (breakdown.categoryType !== "donor" || breakdown.amount < input.minIndustryAmount) {
      continue;
    }
    mergeFinanceLabelClassification(
      classifications,
      classifyFinanceLabel({ rawLabel: breakdown.categoryName, labelType: "donor" })
    );
  }
  return [...classifications.values()];
}

export async function syncOregonCandidateFinance(
  input: OregonCandidateFinanceSyncInput
): Promise<OregonCandidateFinanceSyncResult> {
  const candidateId = requireNonEmpty(input.candidateId, "candidate id");
  const electionId = requireNonEmpty(input.electionId, "election id");
  const candidateName = requireNonEmpty(input.candidateName, "candidate name");
  const officeName = requireNonEmpty(input.officeName, "office name");
  const committeeId = requireNonEmpty(input.committeeId, "Oregon ORESTAR committee ID");
  const committeeName = requireNonEmpty(input.committeeName, "Oregon committee name");
  const electionYear = normalizeElectionYear(input.electionYear);
  const syncedAt = normalizeTimestamp(input.now);
  const dryRun = input.dryRun === true;
  const directMaxBreakdownsPerCategory = normalizePositiveInteger(
    input.directMaxBreakdownsPerCategory,
    DEFAULT_MAX_BREAKDOWNS_PER_CATEGORY,
    "directMaxBreakdownsPerCategory"
  );
  const outsideMaxGroups = normalizePositiveInteger(
    input.outsideMaxGroups,
    DEFAULT_OUTSIDE_MAX_GROUPS,
    "outsideMaxGroups"
  );
  const outsideMaxBreakdownsPerCategory = normalizePositiveInteger(
    input.outsideMaxBreakdownsPerCategory,
    DEFAULT_MAX_BREAKDOWNS_PER_CATEGORY,
    "outsideMaxBreakdownsPerCategory"
  );
  const minIndustryAmount = normalizeMinIndustryAmount(input.minIndustryAmount);
  const sourceUrl = input.sourceUrl ?? OREGON_ORESTAR_TRANSACTION_SEARCH_URL;

  const directFinance = aggregateOregonDirectContributions({
    committeeId,
    electionYear,
    transactionDetails: input.transactionDetails,
    sourceUrl,
    maxBreakdownsPerCategory: directMaxBreakdownsPerCategory,
  });
  const outsideFinance = aggregateOregonOutsideSpending({
    candidateCommitteeId: committeeId,
    electionYear,
    transactionDetails: input.outsideTransactionDetails ?? [],
    sourceUrl,
    maxGroups: outsideMaxGroups,
  });
  const outsideGroupFinance = aggregateOregonOutsideGroupContributions({
    electionYear,
    outsideGroups: outsideFinance.outsideGroups,
    transactionDetails: (input.outsideTransactionDetails ?? []).filter(isOregonContributionTransaction),
    sourceUrl,
    maxBreakdownsPerCategory: outsideMaxBreakdownsPerCategory,
    minIndustryAmount,
  });

  const summary = toSummary({
    directContributionTotal: directFinance.summary.directContributionTotal,
    outsideSupportTotal: input.outsideTransactionDetails === undefined ? null : outsideFinance.summary.outsideSupportTotal,
    outsideOpposeTotal: input.outsideTransactionDetails === undefined ? null : outsideFinance.summary.outsideOpposeTotal,
    sourceUrl,
  });
  const directBreakdowns = toDirectBreakdowns(directFinance.directBreakdowns);
  const outsideGroups = input.outsideTransactionDetails === undefined ? undefined : toOutsideGroups(outsideFinance.outsideGroups);
  const outsideGroupBreakdowns = input.outsideTransactionDetails === undefined
    ? undefined
    : toOutsideGroupBreakdowns(outsideGroupFinance.outsideGroupBreakdowns);
  const classifications = collectOutsideClassifications({
    breakdowns: outsideGroupBreakdowns ?? [],
    minIndustryAmount,
  });
  const link = toFinanceLink({
    candidateId,
    electionId,
    candidateName,
    electionYear,
    officeName,
    district: input.district,
    committeeId,
    committeeName,
    sourceUrl,
    verifiedAt: syncedAt,
  });

  let writeResult: OregonFinanceSnapshotWriteResult | undefined;
  if (!dryRun) {
    writeResult = await replaceOregonCandidateFinanceSnapshot({
      db: input.db,
      link,
      syncedAt,
      summary,
      directBreakdowns,
      outsideGroups,
      outsideGroupBreakdowns,
      classifications,
      verifiedFinance: input.verifiedFinance,
    });
  }

  return {
    candidateId,
    electionId,
    electionYear,
    dryRun,
    linkWritten: !dryRun,
    summaryWritten: !dryRun,
    directBreakdownsWritten: dryRun ? 0 : directBreakdowns.length,
    outsideGroupsWritten: dryRun ? 0 : writeResult?.outsideGroupsWritten ?? outsideGroups?.length ?? 0,
    outsideGroupBreakdownsWritten: dryRun ? 0 : outsideGroupBreakdowns?.length ?? 0,
    ...(input.verifiedFinance || input.verifiedFinanceDiagnostics || input.verifiedSourceGenerationDir ? {
      pacDonorsWritten: writeResult?.pacDonorsWritten ?? 0,
      verifiedFinanceDiagnostics: [...input.verifiedFinanceDiagnostics ?? [], ...writeResult?.verifiedFinanceDiagnostics ?? []],
      ...(input.verifiedSourceGenerationDir ? { verifiedSourceGenerationDir: input.verifiedSourceGenerationDir } : {}),
    } : {}),
    directContributionTotal: summary.directContributionTotal ?? null,
    outsideSupportTotal: summary.outsideSupportTotal ?? null,
    outsideOpposeTotal: summary.outsideOpposeTotal ?? null,
    transactionDetailCount: input.transactionDetails.length,
    matchedDirectContributionRowCount: directFinance.matchedContributionRowCount,
    includedDirectContributionRowCount: directFinance.includedContributionRowCount,
    skippedDirectContributionRowCount: directFinance.skippedContributionRowCount,
    matchedExpenditureRowCount: outsideFinance.matchedExpenditureRowCount,
    includedOutsideAssociationCount: outsideFinance.includedAssociationCount,
    skippedOutsideAssociationCount: outsideFinance.skippedAssociationCount,
    matchedOutsideGroupContributionRowCount: outsideGroupFinance.matchedContributionRowCount,
    includedOutsideGroupContributionRowCount: outsideGroupFinance.includedContributionRowCount,
    skippedOutsideGroupContributionRowCount: outsideGroupFinance.skippedContributionRowCount,
  };
}
