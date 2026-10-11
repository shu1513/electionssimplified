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
  normalizeDistrictOfColumbiaCandidateNameKeys,
  resolveDistrictOfColumbiaCandidateCommittee,
  type DistrictOfColumbiaCandidateCommitteeResolution,
} from "./districtOfColumbiaCandidateCommitteeResolver.js";
import { aggregateDistrictOfColumbiaDirectContributions } from "./districtOfColumbiaDirectContributionAggregator.js";
import {
  aggregateDistrictOfColumbiaOutsideGroupContributions,
  type DistrictOfColumbiaFinanceOutsideGroupBreakdown,
} from "./districtOfColumbiaOutsideGroupContributionAggregator.js";
import { aggregateDistrictOfColumbiaOutsideSpending } from "./districtOfColumbiaOutsideSpendingAggregator.js";
import { isDistrictOfColumbiaFairElectionsCommitteeKey } from "./districtOfColumbiaFairElectionsClient.js";
import type {
  DistrictOfColumbiaOcfContributionRecord,
  DistrictOfColumbiaOcfExpenditureRecord,
} from "./districtOfColumbiaOcfClient.js";
import {
  replaceDistrictOfColumbiaCandidateFinanceSnapshot,
  type DistrictOfColumbiaFinanceDirectBreakdownInput,
  type DistrictOfColumbiaFinanceLinkInput,
  type DistrictOfColumbiaFinanceOutsideGroupBreakdownInput,
  type DistrictOfColumbiaFinanceOutsideGroupInput,
  type DistrictOfColumbiaFinanceSummaryInput,
} from "./districtOfColumbiaFinanceWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & Pick<Pool, "connect">;

type MatchedDistrictOfColumbiaCommitteeResolution = Extract<
  DistrictOfColumbiaCandidateCommitteeResolution,
  { status: "matched" }
>;

export type DistrictOfColumbiaCandidateFinanceSyncInput = {
  db: ConnectableQueryable;
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district?: string | null;
  sourceUrl?: string | null;
  contributionRecords?: readonly DistrictOfColumbiaOcfContributionRecord[];
  expenditureRecords?: readonly DistrictOfColumbiaOcfExpenditureRecord[];
  outsideContributionRecords?: readonly DistrictOfColumbiaOcfContributionRecord[];
  // The candidate committee's own spending. Only the Fair Elections source
  // publishes it in bulk; OCF export committees keep total_disbursements null.
  committeeExpenditureRecords?: readonly DistrictOfColumbiaOcfExpenditureRecord[];
  now?: Date;
  dryRun?: boolean;
  directMaxBreakdownsPerCategory?: number;
  outsideMaxGroups?: number;
  // Display cap on persisted donor rows per (committee, direction);
  // classification always sees every donor.
  outsideMaxBreakdownsPerCategory?: number;
  financeIndustryClassifier?: FinanceIndustryClassifier;
  aiClassificationMinAmount?: number;
  trustedCommittee?: {
    committeeKey: string;
    committeeName: string;
    sourceUrl?: string | null;
  };
};

export type DistrictOfColumbiaCandidateFinanceSyncResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  dryRun: boolean;
  resolution: DistrictOfColumbiaCandidateCommitteeResolution;
  linkWritten: boolean;
  summaryWritten: boolean;
  directBreakdownsWritten: number;
  outsideGroupsWritten: number;
  outsideGroupBreakdownsWritten: number;
  totalReceipts: number | null;
  directContributionTotal: number | null;
  totalDisbursements: number | null;
  publicFundsReceived: number | null;
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
  outsideGroupCount: number;
};

const DEFAULT_AI_CLASSIFICATION_MIN_AMOUNT = 25_000;
// For outside groups this is a display cap on PERSISTED donor rows per
// (committee, direction), applied AFTER classification so a >cap-donor group
// still gets industry totals built from every donor. Industry rows are
// bounded by the slug set and are never capped.
const DEFAULT_MAX_BREAKDOWNS_PER_CATEGORY = 20;
const DEFAULT_OUTSIDE_MAX_GROUPS = 20;

function requireNonEmpty(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmed;
}

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new Error(`Invalid D.C. finance election year: ${value}`);
  }
  return value;
}

function normalizeTimestamp(value: Date | undefined): Date {
  const normalized = value ?? new Date();
  if (Number.isNaN(normalized.getTime())) {
    throw new Error("Invalid D.C. finance sync timestamp");
  }
  return normalized;
}

function normalizeAiClassificationMinAmount(value: number | undefined): number {
  const normalized = value ?? DEFAULT_AI_CLASSIFICATION_MIN_AMOUNT;
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`Invalid D.C. finance AI classification minimum amount: ${value}`);
  }
  return normalized;
}

function normalizeMaxDonorBreakdowns(value: number | undefined): number {
  const normalized = value ?? DEFAULT_MAX_BREAKDOWNS_PER_CATEGORY;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid D.C. finance outsideMaxBreakdownsPerCategory: ${value}`);
  }
  return normalized;
}

function normalizeCandidateNameForStorage(value: string): string {
  return [...normalizeDistrictOfColumbiaCandidateNameKeys(value)][0] ?? requireNonEmpty(value, "candidate name").replace(/\s+/g, " ").toUpperCase();
}

function toMatchedTrustedCommittee(
  input: NonNullable<DistrictOfColumbiaCandidateFinanceSyncInput["trustedCommittee"]>
): MatchedDistrictOfColumbiaCommitteeResolution {
  return {
    status: "matched",
    committeeKey: requireNonEmpty(input.committeeKey, "trusted D.C. committee key"),
    committeeName: requireNonEmpty(input.committeeName, "trusted D.C. committee name"),
    confidence: "exact",
    source: "ocf_export",
    sourceUrl: input.sourceUrl ?? null,
    matchedContributionRowCount: 0,
  };
}

function normalizeCommitteeKeyForMatch(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toUpperCase();
}

function sumCommitteeDisbursements(input: {
  committeeKey: string;
  expenditureRecords: readonly DistrictOfColumbiaOcfExpenditureRecord[] | undefined;
}): number | null {
  if (!input.expenditureRecords || !isDistrictOfColumbiaFairElectionsCommitteeKey(input.committeeKey)) {
    return null;
  }
  const committeeKey = normalizeCommitteeKeyForMatch(input.committeeKey);
  let cents = 0;
  for (const record of input.expenditureRecords) {
    if (normalizeCommitteeKeyForMatch(record.committeeKey ?? record.committeeName) === committeeKey && record.amount > 0) {
      cents += Math.round(record.amount * 100);
    }
  }
  return cents / 100;
}

function toFinanceLink(input: {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeName: string;
  district?: string | null;
  resolution: MatchedDistrictOfColumbiaCommitteeResolution;
  sourceUrl?: string | null;
  verifiedAt: Date;
}): DistrictOfColumbiaFinanceLinkInput {
  return {
    candidateId: requireNonEmpty(input.candidateId, "candidate id"),
    electionId: requireNonEmpty(input.electionId, "election id"),
    electionYear: input.electionYear,
    candidateNameNormalized: normalizeCandidateNameForStorage(input.candidateName),
    officeName: requireNonEmpty(input.officeName, "office name"),
    district: input.district ?? null,
    committeeKey: requireNonEmpty(input.resolution.committeeKey, "D.C. committee key"),
    committeeName: requireNonEmpty(input.resolution.committeeName, "D.C. committee name"),
    linkStatus: "active",
    linkSource: "ocf_export",
    sourceUrl: input.resolution.sourceUrl ?? input.sourceUrl ?? null,
    lastVerifiedAt: input.verifiedAt,
  };
}

function toDirectBreakdowns(
  breakdowns: ReturnType<typeof aggregateDistrictOfColumbiaDirectContributions>["directBreakdowns"]
): DistrictOfColumbiaFinanceDirectBreakdownInput[] {
  return breakdowns.map((row) => ({
    categoryType: row.categoryType,
    categoryName: row.categoryName,
    amount: row.amount,
    contributorCount: row.contributorCount,
    sourceUrl: row.sourceUrl,
  }));
}

function toOutsideGroups(
  groups: NonNullable<ReturnType<typeof aggregateDistrictOfColumbiaOutsideSpending>["summary"]>["groups"]
): DistrictOfColumbiaFinanceOutsideGroupInput[] {
  return groups.map((group) => ({
    committeeKey: group.committeeKey,
    committeeName: group.committeeName,
    supportOppose: group.supportOppose,
    amount: group.amount,
    sourceUrl: group.sourceUrl,
  }));
}

function outsideBreakdownKey(input: DistrictOfColumbiaFinanceOutsideGroupBreakdownInput): string {
  const categoryKey =
    input.categoryType === "donor"
      ? normalizeFinanceLabel(input.categoryName, "donor")
      : input.categoryName.trim().toUpperCase();
  return `${input.committeeKey.trim().toUpperCase()}\u0000${input.supportOppose}\u0000${input.categoryType}\u0000${categoryKey}`;
}

function addOutsideBreakdown(
  breakdowns: Map<string, DistrictOfColumbiaFinanceOutsideGroupBreakdownInput>,
  breakdown: DistrictOfColumbiaFinanceOutsideGroupBreakdownInput
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

function toWriterOutsideBreakdown(
  breakdown: DistrictOfColumbiaFinanceOutsideGroupBreakdown
): DistrictOfColumbiaFinanceOutsideGroupBreakdownInput {
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

function collectOutsideClassifications(
  breakdowns: Iterable<DistrictOfColumbiaFinanceOutsideGroupBreakdownInput>,
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

function asClassifiableOutsideBreakdowns(breakdowns: Iterable<DistrictOfColumbiaFinanceOutsideGroupBreakdownInput>) {
  return [...breakdowns].map((breakdown) => ({
    committeeId: breakdown.committeeKey,
    supportOppose: breakdown.supportOppose,
    categoryType: breakdown.categoryType,
    categoryName: breakdown.categoryName,
    amount: breakdown.amount,
    contributorCount: breakdown.contributorCount,
    sourceUrl: breakdown.sourceUrl,
  }));
}

function capDonorBreakdowns(
  breakdowns: readonly DistrictOfColumbiaFinanceOutsideGroupBreakdownInput[],
  maxDonorsPerGroup: number
): DistrictOfColumbiaFinanceOutsideGroupBreakdownInput[] {
  const donorsByGroup = new Map<string, DistrictOfColumbiaFinanceOutsideGroupBreakdownInput[]>();
  for (const breakdown of breakdowns) {
    if (breakdown.categoryType !== "donor") {
      continue;
    }
    const key = `${breakdown.committeeKey.trim().toUpperCase()}\u0000${breakdown.supportOppose}`;
    const list = donorsByGroup.get(key) ?? [];
    list.push(breakdown);
    donorsByGroup.set(key, list);
  }
  const kept = new Set<DistrictOfColumbiaFinanceOutsideGroupBreakdownInput>();
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
  outsideGroupBreakdowns: readonly DistrictOfColumbiaFinanceOutsideGroupBreakdownInput[] | undefined;
  classifier: FinanceIndustryClassifier | undefined;
  aiClassificationMinAmount: number;
  maxDonorBreakdownsPerGroup: number;
  dryRun: boolean;
}): Promise<{
  outsideGroupBreakdowns: DistrictOfColumbiaFinanceOutsideGroupBreakdownInput[] | undefined;
  classifications: FinanceLabelClassification[];
}> {
  if (!input.outsideGroupBreakdowns) {
    return { outsideGroupBreakdowns: undefined, classifications: [] };
  }

  const breakdowns = new Map<string, DistrictOfColumbiaFinanceOutsideGroupBreakdownInput>();
  for (const breakdown of input.outsideGroupBreakdowns) {
    if (breakdown.categoryType !== "industry") {
      addOutsideBreakdown(breakdowns, breakdown);
    }
  }

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
  for (const breakdown of industryBreakdowns.outsideIndustryBreakdowns) {
    addOutsideBreakdown(breakdowns, {
      committeeKey: breakdown.committeeId,
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

function emptyResult(input: {
  candidateId: string;
  electionId: string;
  electionYear: number;
  dryRun: boolean;
  resolution: DistrictOfColumbiaCandidateCommitteeResolution;
}): DistrictOfColumbiaCandidateFinanceSyncResult {
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
    totalDisbursements: null,
    publicFundsReceived: null,
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
    outsideGroupCount: 0,
  };
}

export async function syncDistrictOfColumbiaCandidateFinance(
  input: DistrictOfColumbiaCandidateFinanceSyncInput
): Promise<DistrictOfColumbiaCandidateFinanceSyncResult> {
  const candidateId = requireNonEmpty(input.candidateId, "candidate id");
  const electionId = requireNonEmpty(input.electionId, "election id");
  const candidateName = requireNonEmpty(input.candidateName, "candidate name");
  const officeScope = requireNonEmpty(input.officeScope, "office scope");
  const officeName = requireNonEmpty(input.officeName, "office name");
  const electionYear = normalizeElectionYear(input.electionYear);
  const syncedAt = normalizeTimestamp(input.now);
  const dryRun = input.dryRun === true;
  const aiClassificationMinAmount = normalizeAiClassificationMinAmount(input.aiClassificationMinAmount);

  const resolution = input.trustedCommittee
    ? toMatchedTrustedCommittee(input.trustedCommittee)
    : resolveDistrictOfColumbiaCandidateCommittee({
        candidateName,
        officeScope,
        officeName,
        electionYear,
        seat: input.district,
        contributionRecords: input.contributionRecords ?? [],
        sourceUrl: input.sourceUrl ?? null,
      });

  if (resolution.status !== "matched") {
    return emptyResult({ candidateId, electionId, electionYear, dryRun, resolution });
  }

  const directFinance = input.contributionRecords
    ? aggregateDistrictOfColumbiaDirectContributions({
        committeeKey: resolution.committeeKey,
        electionYear,
        contributionRecords: input.contributionRecords,
        sourceUrl: resolution.sourceUrl ?? input.sourceUrl ?? null,
        maxBreakdownsPerCategory: input.directMaxBreakdownsPerCategory ?? DEFAULT_MAX_BREAKDOWNS_PER_CATEGORY,
      })
    : null;
  const directBreakdowns = directFinance ? toDirectBreakdowns(directFinance.directBreakdowns) : undefined;

  const outsideFinance = input.expenditureRecords
    ? aggregateDistrictOfColumbiaOutsideSpending({
        candidateName,
        electionYear,
        expenditureRecords: input.expenditureRecords,
        sourceUrl: input.sourceUrl ?? null,
        maxGroups: input.outsideMaxGroups ?? DEFAULT_OUTSIDE_MAX_GROUPS,
      })
    : null;
  const outsideGroups = input.expenditureRecords ? toOutsideGroups(outsideFinance?.summary?.groups ?? []) : undefined;
  const rawOutsideGroupBreakdowns =
    outsideGroups && input.outsideContributionRecords
      ? aggregateDistrictOfColumbiaOutsideGroupContributions({
          electionYear,
          outsideGroups: outsideGroups.map((group) => ({
            committeeKey: group.committeeKey,
            committeeName: group.committeeName,
            supportOppose: group.supportOppose,
            amount: group.amount,
            sourceUrl: group.sourceUrl ?? null,
          })),
          contributionRecords: input.outsideContributionRecords,
          sourceUrl: input.sourceUrl ?? null,
          minIndustryAmount: aiClassificationMinAmount,
        })
      : null;
  const outsideGroupBreakdowns = rawOutsideGroupBreakdowns
    ? rawOutsideGroupBreakdowns.outsideGroupBreakdowns.map(toWriterOutsideBreakdown)
    : undefined;
  const outsideIndustryFinance = await enrichOutsideGroupIndustryBreakdowns({
    db: input.db,
    outsideGroupBreakdowns,
    classifier: input.financeIndustryClassifier,
    aiClassificationMinAmount,
    maxDonorBreakdownsPerGroup: normalizeMaxDonorBreakdowns(input.outsideMaxBreakdownsPerCategory),
    dryRun,
  });

  const summary: DistrictOfColumbiaFinanceSummaryInput | undefined =
    directFinance || outsideGroups
      ? {
          totalReceipts: directFinance?.summary.totalReceipts ?? null,
          directContributionTotal: directFinance?.summary.directContributionTotal ?? null,
          totalDisbursements: sumCommitteeDisbursements({
            committeeKey: resolution.committeeKey,
            expenditureRecords: input.committeeExpenditureRecords,
          }),
          publicFundsReceived: directFinance?.summary.publicFundsReceived ?? null,
          outsideSupportTotal: input.expenditureRecords ? outsideFinance?.summary?.supportTotal ?? 0 : null,
          outsideOpposeTotal: input.expenditureRecords ? outsideFinance?.summary?.opposeTotal ?? 0 : null,
          sourceUrl: directFinance?.summary.sourceUrl ?? outsideFinance?.summary?.sourceUrl ?? input.sourceUrl ?? null,
        }
      : undefined;

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
    await replaceDistrictOfColumbiaCandidateFinanceSnapshot({
      db: input.db,
      link,
      syncedAt,
      summary,
      directBreakdowns,
      outsideGroups,
      outsideGroupBreakdowns: outsideIndustryFinance.outsideGroupBreakdowns,
      classifications: outsideIndustryFinance.classifications,
    });
  }

  return {
    candidateId,
    electionId,
    electionYear,
    dryRun,
    resolution,
    linkWritten: !dryRun,
    summaryWritten: !dryRun && Boolean(summary),
    directBreakdownsWritten: dryRun ? 0 : directBreakdowns?.length ?? 0,
    outsideGroupsWritten: dryRun ? 0 : outsideGroups?.length ?? 0,
    outsideGroupBreakdownsWritten: dryRun ? 0 : outsideIndustryFinance.outsideGroupBreakdowns?.length ?? 0,
    totalReceipts: summary?.totalReceipts ?? null,
    directContributionTotal: summary?.directContributionTotal ?? null,
    totalDisbursements: summary?.totalDisbursements ?? null,
    publicFundsReceived: summary?.publicFundsReceived ?? null,
    outsideSupportTotal: summary?.outsideSupportTotal ?? null,
    outsideOpposeTotal: summary?.outsideOpposeTotal ?? null,
    matchedContributionRowCount: directFinance?.matchedContributionRowCount ?? 0,
    includedContributionRowCount: directFinance?.includedContributionRowCount ?? 0,
    skippedContributionRowCount: directFinance?.skippedContributionRowCount ?? 0,
    matchedExpenditureRowCount: outsideFinance?.matchedExpenditureRowCount ?? 0,
    includedExpenditureRowCount: outsideFinance?.includedExpenditureRowCount ?? 0,
    skippedExpenditureRowCount: outsideFinance?.skippedExpenditureRowCount ?? 0,
    matchedOutsideContributionRowCount: rawOutsideGroupBreakdowns?.matchedContributionRowCount ?? 0,
    includedOutsideContributionRowCount: rawOutsideGroupBreakdowns?.includedContributionRowCount ?? 0,
    skippedOutsideContributionRowCount: rawOutsideGroupBreakdowns?.skippedContributionRowCount ?? 0,
    outsideGroupCount: outsideGroups?.length ?? 0,
  };
}
