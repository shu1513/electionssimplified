import {
  classifyFinanceLabel,
  normalizeFinanceLabel,
  type FinanceIndustrySlug,
} from "../finance/financeLabelClassifier.js";
import type {
  IllinoisSbeContributionRecord,
  IllinoisSbeExpenditureRecord,
  IllinoisSbeSupportOppose,
} from "./illinoisSbeCsvReader.js";

export type IllinoisFinanceDirectBreakdown = {
  categoryType: "occupation" | "contribution_size";
  categoryName: string;
  amount: number;
  contributorCount: number;
  sourceUrl: string | null;
};

export type IllinoisDirectFinanceSummary = {
  totalReceipts: number;
  directContributionTotal: number;
  sourceUrl: string | null;
};

export type IllinoisDirectContributionAggregationInput = {
  electionYear: number;
  contributionRecords: readonly IllinoisSbeContributionRecord[];
  committeeKey?: string | null;
  committeeId?: string | null;
  sourceUrl?: string | null;
  maxBreakdownsPerCategory?: number;
};

export type IllinoisDirectContributionAggregationResult = {
  summary: IllinoisDirectFinanceSummary;
  directBreakdowns: IllinoisFinanceDirectBreakdown[];
  matchedContributionRowCount: number;
  includedContributionRowCount: number;
  skippedContributionRowCount: number;
};

export type IllinoisOutsideSpendingGroup = {
  committeeKey: string;
  committeeName: string;
  supportOppose: IllinoisSbeSupportOppose;
  amount: number;
  expenditureCount: number;
  sourceUrl: string | null;
};

export type IllinoisOutsideSpendingSummary = {
  supportTotal: number;
  opposeTotal: number;
  groups: IllinoisOutsideSpendingGroup[];
  sourceUrl: string | null;
};

export type IllinoisOutsideSpendingAggregationInput = {
  electionYear: number;
  expenditureRecords: readonly IllinoisSbeExpenditureRecord[];
  sourceUrl?: string | null;
  maxGroups?: number;
};

export type IllinoisOutsideSpendingAggregationResult = {
  summary: IllinoisOutsideSpendingSummary | null;
  matchedExpenditureRowCount: number;
  includedExpenditureRowCount: number;
  skippedExpenditureRowCount: number;
};

export type IllinoisFinanceOutsideGroupBreakdown = {
  committeeKey: string;
  supportOppose: IllinoisSbeSupportOppose;
  categoryType: "donor" | "industry";
  categoryName: string;
  amount: number;
  contributorCount: number;
  sourceUrl: string | null;
};

export type IllinoisOutsideGroupContributionAggregationInput = {
  electionYear: number;
  outsideGroups: readonly IllinoisOutsideSpendingGroup[];
  contributionRecords: readonly IllinoisSbeContributionRecord[];
  sourceUrl?: string | null;
  maxBreakdownsPerCategory?: number;
  minIndustryAmount?: number;
};

export type IllinoisOutsideGroupContributionAggregationResult = {
  outsideGroupBreakdowns: IllinoisFinanceOutsideGroupBreakdown[];
  matchedContributionRowCount: number;
  includedContributionRowCount: number;
  skippedContributionRowCount: number;
};

type DirectAggregate = {
  categoryType: IllinoisFinanceDirectBreakdown["categoryType"];
  categoryName: string;
  amountCents: number;
  contributorKeys: Set<string>;
};

type GroupAggregate = {
  committeeKey: string;
  committeeName: string;
  supportOppose: IllinoisSbeSupportOppose;
  amountCents: number;
  expenditureCount: number;
};

type DonorAggregate = {
  committeeKey: string;
  supportOppose: IllinoisSbeSupportOppose;
  displayName: string;
  normalizedName: string;
  amountCents: number;
  contributorKeys: Set<string>;
};

type IndustryAggregate = {
  committeeKey: string;
  supportOppose: IllinoisSbeSupportOppose;
  industrySlug: FinanceIndustrySlug;
  amountCents: number;
  donorKeys: Set<string>;
};

const DEFAULT_MAX_BREAKDOWNS_PER_CATEGORY = 50;
const DEFAULT_MAX_GROUPS = 50;
const DEFAULT_MIN_INDUSTRY_AMOUNT_CENTS = 25_000 * 100;

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new Error(`Invalid Illinois finance aggregation election year: ${value}`);
  }
  return value;
}

function normalizePositiveInteger(value: number | undefined, fallback: number, fieldName: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Illinois finance aggregation ${fieldName}: ${value}`);
  }
  return normalized;
}

function normalizeMinAmount(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MIN_INDUSTRY_AMOUNT_CENTS;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid Illinois outside group contribution minIndustryAmount: ${value}`);
  }
  return Math.round(value * 100);
}

export function normalizeIllinoisFinanceTextKey(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeIllinoisCommitteeKey(value: string | null | undefined): string {
  const externalId = value?.trim().toUpperCase();
  if (externalId && /^SBE:[A-Z0-9-]+$/.test(externalId)) {
    return externalId;
  }
  return normalizeIllinoisFinanceTextKey(value);
}

export function extractIllinoisSbeCommitteeId(committeeKey: string | null | undefined): string | null {
  return committeeKey?.trim().match(/^SBE:(.+)$/i)?.[1] ?? null;
}

function amountToCents(amount: number): number | null {
  if (!Number.isFinite(amount)) {
    return null;
  }
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

function centsToDollars(cents: number): number {
  return cents / 100;
}

function parseIllinoisDateYear(raw: string | null | undefined): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  const slashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(trimmed);
  if (slashMatch) {
    return Number(slashMatch[3]);
  }
  const isoMatch = /^(\d{4})-\d{2}-\d{2}/.exec(trimmed);
  if (isoMatch) {
    return Number(isoMatch[1]);
  }
  return null;
}

export function isIllinoisFinanceCycleDate(input: {
  rawDate: string | null | undefined;
  electionYear: number;
}): boolean {
  const electionYear = normalizeElectionYear(input.electionYear);
  const year = parseIllinoisDateYear(input.rawDate);
  return year !== null && year >= electionYear - 1 && year <= electionYear;
}

function contributionIsCycleRecord(input: { record: IllinoisSbeContributionRecord; electionYear: number }): boolean {
  return isIllinoisFinanceCycleDate({ rawDate: input.record.receivedDate, electionYear: input.electionYear });
}

function expenditureIsCycleRecord(input: { record: IllinoisSbeExpenditureRecord; electionYear: number }): boolean {
  return isIllinoisFinanceCycleDate({ rawDate: input.record.expendedDate, electionYear: input.electionYear });
}

function contributorIdentityKey(record: IllinoisSbeContributionRecord): string {
  const parts = [
    record.contributorName,
    record.contributorAddress,
    record.employer,
    record.occupation,
  ]
    .map(normalizeIllinoisFinanceTextKey)
    .filter(Boolean);
  return parts.length > 0 ? parts.join("\u0000") : "unknown";
}

function contributionSizeBucket(amount: number): string {
  if (amount < 100) {
    return "$1-$99";
  }
  if (amount < 250) {
    return "$100-$249";
  }
  if (amount < 500) {
    return "$250-$499";
  }
  if (amount < 1_000) {
    return "$500-$999";
  }
  if (amount < 5_000) {
    return "$1,000-$4,999";
  }
  return "$5,000+";
}

function isIndividualContribution(record: IllinoisSbeContributionRecord): boolean {
  const type = normalizeIllinoisFinanceTextKey(record.contributionType);
  return type === "INDIVIDUAL CONTRIBUTIONS" || type === "INDIVIDUAL CONTRIBUTION";
}

function directAggregateKey(categoryType: DirectAggregate["categoryType"], categoryName: string): string {
  return `${categoryType}\u0000${normalizeIllinoisFinanceTextKey(categoryName)}`;
}

function addDirectAggregate(
  aggregates: Map<string, DirectAggregate>,
  input: {
    categoryType: DirectAggregate["categoryType"];
    categoryName: string | null | undefined;
    amountCents: number;
    contributorKey: string;
  }
): void {
  const categoryName = input.categoryName?.trim().replace(/\s+/g, " ") ?? "";
  if (!categoryName) {
    return;
  }
  const key = directAggregateKey(input.categoryType, categoryName);
  const existing = aggregates.get(key);
  if (existing) {
    existing.amountCents += input.amountCents;
    existing.contributorKeys.add(input.contributorKey);
    return;
  }
  aggregates.set(key, {
    categoryType: input.categoryType,
    categoryName,
    amountCents: input.amountCents,
    contributorKeys: new Set([input.contributorKey]),
  });
}

function toDirectBreakdowns(input: {
  aggregates: Iterable<DirectAggregate>;
  sourceUrl: string | null;
  maxBreakdownsPerCategory: number;
}): IllinoisFinanceDirectBreakdown[] {
  const byCategory = new Map<DirectAggregate["categoryType"], DirectAggregate[]>();
  for (const aggregate of input.aggregates) {
    const list = byCategory.get(aggregate.categoryType) ?? [];
    list.push(aggregate);
    byCategory.set(aggregate.categoryType, list);
  }

  const result: IllinoisFinanceDirectBreakdown[] = [];
  for (const categoryType of ["occupation", "contribution_size"] as const) {
    const limit = categoryType === "contribution_size" ? Number.POSITIVE_INFINITY : input.maxBreakdownsPerCategory;
    for (const aggregate of (byCategory.get(categoryType) ?? [])
      .sort((left, right) => right.amountCents - left.amountCents || left.categoryName.localeCompare(right.categoryName))
      .slice(0, limit)) {
      result.push({
        categoryType,
        categoryName: aggregate.categoryName,
        amount: centsToDollars(aggregate.amountCents),
        contributorCount: aggregate.contributorKeys.size,
        sourceUrl: input.sourceUrl,
      });
    }
  }
  return result;
}

export function aggregateIllinoisDirectContributions(
  input: IllinoisDirectContributionAggregationInput
): IllinoisDirectContributionAggregationResult {
  const electionYear = normalizeElectionYear(input.electionYear);
  const maxBreakdownsPerCategory = normalizePositiveInteger(
    input.maxBreakdownsPerCategory,
    DEFAULT_MAX_BREAKDOWNS_PER_CATEGORY,
    "maxBreakdownsPerCategory"
  );
  const sourceUrl = input.sourceUrl ?? null;
  const targetCommitteeKey = normalizeIllinoisCommitteeKey(input.committeeKey);
  const aggregates = new Map<string, DirectAggregate>();
  let matchedContributionRowCount = 0;
  let includedContributionRowCount = 0;
  let skippedContributionRowCount = 0;
  let totalReceiptsCents = 0;
  let directContributionTotalCents = 0;

  for (const record of input.contributionRecords) {
    matchedContributionRowCount += 1;
    if (input.committeeId && record.committeeId !== input.committeeId) {
      skippedContributionRowCount += 1;
      continue;
    }
    if (targetCommitteeKey && recordCommitteeKey(record) !== targetCommitteeKey) {
      skippedContributionRowCount += 1;
      continue;
    }
    const amountCents = amountToCents(record.amount);
    if (amountCents === null || amountCents <= 0 || !contributionIsCycleRecord({ record, electionYear })) {
      skippedContributionRowCount += 1;
      continue;
    }

    totalReceiptsCents += amountCents;
    includedContributionRowCount += 1;
    if (!isIndividualContribution(record)) {
      continue;
    }
    directContributionTotalCents += amountCents;
    const contributorKey = contributorIdentityKey(record);
    addDirectAggregate(aggregates, {
      categoryType: "occupation",
      categoryName: record.occupation,
      amountCents,
      contributorKey,
    });
    addDirectAggregate(aggregates, {
      categoryType: "contribution_size",
      categoryName: contributionSizeBucket(centsToDollars(amountCents)),
      amountCents,
      contributorKey,
    });
  }

  return {
    summary: {
      totalReceipts: centsToDollars(totalReceiptsCents),
      directContributionTotal: centsToDollars(directContributionTotalCents),
      sourceUrl,
    },
    directBreakdowns: toDirectBreakdowns({
      aggregates: aggregates.values(),
      sourceUrl,
      maxBreakdownsPerCategory,
    }),
    matchedContributionRowCount,
    includedContributionRowCount,
    skippedContributionRowCount,
  };
}

function groupKey(input: { committeeKey: string; supportOppose: IllinoisSbeSupportOppose }): string {
  return `${normalizeIllinoisCommitteeKey(input.committeeKey)}\u0000${input.supportOppose}`;
}

function toOutsideGroups(input: {
  groups: Iterable<GroupAggregate>;
  maxGroups: number;
  sourceUrl: string | null;
}): IllinoisOutsideSpendingGroup[] {
  return [...input.groups]
    .sort(
      (left, right) =>
        right.amountCents - left.amountCents ||
        left.supportOppose.localeCompare(right.supportOppose) ||
        left.committeeName.localeCompare(right.committeeName)
    )
    .slice(0, input.maxGroups)
    .map((group) => ({
      committeeKey: group.committeeKey,
      committeeName: group.committeeName,
      supportOppose: group.supportOppose,
      amount: centsToDollars(group.amountCents),
      expenditureCount: group.expenditureCount,
      sourceUrl: input.sourceUrl,
    }));
}

export function aggregateIllinoisOutsideSpending(
  input: IllinoisOutsideSpendingAggregationInput
): IllinoisOutsideSpendingAggregationResult {
  const electionYear = normalizeElectionYear(input.electionYear);
  const maxGroups = normalizePositiveInteger(input.maxGroups, DEFAULT_MAX_GROUPS, "maxGroups");
  const sourceUrl = input.sourceUrl ?? null;
  const groups = new Map<string, GroupAggregate>();
  let supportTotalCents = 0;
  let opposeTotalCents = 0;
  let matchedExpenditureRowCount = 0;
  let includedExpenditureRowCount = 0;
  let skippedExpenditureRowCount = 0;

  for (const record of input.expenditureRecords) {
    if (!record.supportOppose) {
      continue;
    }
    matchedExpenditureRowCount += 1;
    const committeeName = record.expendingCommitteeName?.trim().replace(/\s+/g, " ") ?? "";
    const committeeKey = record.sourceDocumentId && record.committeeId
      ? `SBE:${record.committeeId}` : normalizeIllinoisCommitteeKey(committeeName);
    const amountCents = amountToCents(record.amount);
    if (
      !committeeName ||
      !committeeKey ||
      amountCents === null ||
      amountCents <= 0 ||
      !expenditureIsCycleRecord({ record, electionYear })
    ) {
      skippedExpenditureRowCount += 1;
      continue;
    }

    includedExpenditureRowCount += 1;
    if (record.supportOppose === "support") {
      supportTotalCents += amountCents;
    } else {
      opposeTotalCents += amountCents;
    }

    const key = groupKey({ committeeKey, supportOppose: record.supportOppose });
    const existing = groups.get(key);
    if (existing) {
      existing.amountCents += amountCents;
      existing.expenditureCount += 1;
      continue;
    }
    groups.set(key, {
      committeeKey,
      committeeName,
      supportOppose: record.supportOppose,
      amountCents,
      expenditureCount: 1,
    });
  }

  const grouped = toOutsideGroups({
    groups: groups.values(),
    maxGroups,
    sourceUrl,
  });
  return {
    summary: grouped.length
      ? {
          supportTotal: centsToDollars(supportTotalCents),
          opposeTotal: centsToDollars(opposeTotalCents),
          groups: grouped,
          sourceUrl,
        }
      : null,
    matchedExpenditureRowCount,
    includedExpenditureRowCount,
    skippedExpenditureRowCount,
  };
}

function recordCommitteeKey(record: IllinoisSbeContributionRecord): string {
  return normalizeIllinoisCommitteeKey(record.recipientCommitteeName);
}

function donorKey(input: {
  committeeKey: string;
  supportOppose: IllinoisSbeSupportOppose;
  normalizedName: string;
}): string {
  return `${normalizeIllinoisCommitteeKey(input.committeeKey)}\u0000${input.supportOppose}\u0000${input.normalizedName}`;
}

function industryKey(input: {
  committeeKey: string;
  supportOppose: IllinoisSbeSupportOppose;
  industrySlug: FinanceIndustrySlug;
}): string {
  return `${normalizeIllinoisCommitteeKey(input.committeeKey)}\u0000${input.supportOppose}\u0000${input.industrySlug}`;
}

function toOutsideGroupBreakdowns(input: {
  donors: Iterable<DonorAggregate>;
  industries: Iterable<IndustryAggregate>;
  sourceUrl: string | null;
  maxBreakdownsPerCategory: number;
}): IllinoisFinanceOutsideGroupBreakdown[] {
  const result: IllinoisFinanceOutsideGroupBreakdown[] = [];

  for (const donor of [...input.donors]
    .sort((left, right) => right.amountCents - left.amountCents || left.displayName.localeCompare(right.displayName))
    .slice(0, input.maxBreakdownsPerCategory)) {
    result.push({
      committeeKey: donor.committeeKey,
      supportOppose: donor.supportOppose,
      categoryType: "donor",
      categoryName: donor.displayName,
      amount: centsToDollars(donor.amountCents),
      contributorCount: donor.contributorKeys.size,
      sourceUrl: input.sourceUrl,
    });
  }

  for (const industry of [...input.industries]
    .sort((left, right) => right.amountCents - left.amountCents || left.industrySlug.localeCompare(right.industrySlug))
    .slice(0, input.maxBreakdownsPerCategory)) {
    result.push({
      committeeKey: industry.committeeKey,
      supportOppose: industry.supportOppose,
      categoryType: "industry",
      categoryName: industry.industrySlug,
      amount: centsToDollars(industry.amountCents),
      contributorCount: industry.donorKeys.size,
      sourceUrl: input.sourceUrl,
    });
  }

  return result;
}

export function aggregateIllinoisOutsideGroupContributions(
  input: IllinoisOutsideGroupContributionAggregationInput
): IllinoisOutsideGroupContributionAggregationResult {
  const electionYear = normalizeElectionYear(input.electionYear);
  const maxBreakdownsPerCategory = normalizePositiveInteger(
    input.maxBreakdownsPerCategory,
    DEFAULT_MAX_BREAKDOWNS_PER_CATEGORY,
    "maxBreakdownsPerCategory"
  );
  const minIndustryAmountCents = normalizeMinAmount(input.minIndustryAmount);
  const sourceUrl = input.sourceUrl ?? null;
  const ambiguousCommitteeKeys = new Set<string>();
  const outsideGroupsByCommitteeKey = new Map<string, IllinoisOutsideSpendingGroup[]>();

  for (const group of input.outsideGroups) {
    const committeeKey = normalizeIllinoisCommitteeKey(group.committeeKey || group.committeeName);
    if (!committeeKey) {
      continue;
    }
    const normalizedGroup = { ...group, committeeKey };
    const existing = outsideGroupsByCommitteeKey.get(committeeKey);
    if (existing) {
      if (existing.some((item) => item.supportOppose !== normalizedGroup.supportOppose)) {
        ambiguousCommitteeKeys.add(committeeKey);
      }
      existing.push(normalizedGroup);
    } else {
      outsideGroupsByCommitteeKey.set(committeeKey, [normalizedGroup]);
    }
  }

  if (outsideGroupsByCommitteeKey.size === 0) {
    return {
      outsideGroupBreakdowns: [],
      matchedContributionRowCount: 0,
      includedContributionRowCount: 0,
      skippedContributionRowCount: 0,
    };
  }

  const donors = new Map<string, DonorAggregate>();
  let matchedContributionRowCount = 0;
  let includedContributionRowCount = 0;
  let skippedContributionRowCount = 0;

  for (const record of input.contributionRecords) {
    const committeeKey = recordCommitteeKey(record);
    const matchingGroups = outsideGroupsByCommitteeKey.get(committeeKey) ?? [];
    if (matchingGroups.length === 0) {
      continue;
    }
    matchedContributionRowCount += 1;
    if (ambiguousCommitteeKeys.has(committeeKey)) {
      skippedContributionRowCount += 1;
      continue;
    }

    const amountCents = amountToCents(record.amount);
    const displayName = record.contributorName?.trim().replace(/\s+/g, " ") ?? "";
    const normalizedName = normalizeFinanceLabel(displayName, "donor");
    if (!displayName || !normalizedName || amountCents === null || amountCents <= 0 || !contributionIsCycleRecord({ record, electionYear })) {
      skippedContributionRowCount += 1;
      continue;
    }

    includedContributionRowCount += 1;
    const contributorKey = contributorIdentityKey(record);
    for (const group of matchingGroups) {
      const key = donorKey({ committeeKey: group.committeeKey, supportOppose: group.supportOppose, normalizedName });
      const existing = donors.get(key);
      if (existing) {
        existing.amountCents += amountCents;
        existing.contributorKeys.add(contributorKey);
        continue;
      }
      donors.set(key, {
        committeeKey: group.committeeKey,
        supportOppose: group.supportOppose,
        displayName,
        normalizedName,
        amountCents,
        contributorKeys: new Set([contributorKey]),
      });
    }
  }

  const industries = new Map<string, IndustryAggregate>();
  for (const donor of donors.values()) {
    if (donor.amountCents < minIndustryAmountCents) {
      continue;
    }
    const classification = classifyFinanceLabel({ rawLabel: donor.displayName, labelType: "donor" });
    if (!classification.industrySlug) {
      continue;
    }
    const key = industryKey({
      committeeKey: donor.committeeKey,
      supportOppose: donor.supportOppose,
      industrySlug: classification.industrySlug,
    });
    const existing = industries.get(key);
    if (existing) {
      existing.amountCents += donor.amountCents;
      existing.donorKeys.add(donor.normalizedName);
      continue;
    }
    industries.set(key, {
      committeeKey: donor.committeeKey,
      supportOppose: donor.supportOppose,
      industrySlug: classification.industrySlug,
      amountCents: donor.amountCents,
      donorKeys: new Set([donor.normalizedName]),
    });
  }

  return {
    outsideGroupBreakdowns: toOutsideGroupBreakdowns({
      donors: donors.values(),
      industries: industries.values(),
      sourceUrl,
      maxBreakdownsPerCategory,
    }),
    matchedContributionRowCount,
    includedContributionRowCount,
    skippedContributionRowCount,
  };
}
