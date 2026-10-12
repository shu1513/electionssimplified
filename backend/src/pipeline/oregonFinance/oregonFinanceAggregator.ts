import {
  classifyFinanceLabel,
  normalizeFinanceLabel,
} from "../finance/financeLabelClassifier.js";
import type {
  OregonOrestarSupportOppose,
  OregonOrestarTransactionDetail,
} from "./oregonOrestarParser.js";

export type OregonFinanceDirectCategoryType = "occupation" | "contribution_size";
export type OregonFinanceOutsideCategoryType = "donor" | "industry";

export type OregonFinanceDirectBreakdown = {
  categoryType: OregonFinanceDirectCategoryType;
  categoryName: string;
  amount: number;
  contributorCount: number;
  sourceUrl: string | null;
};

export type OregonDirectFinanceSummary = {
  directContributionTotal: number;
  sourceUrl: string | null;
};

export type OregonDirectContributionAggregationInput = {
  committeeId: string;
  electionYear: number;
  transactionDetails: readonly OregonOrestarTransactionDetail[];
  sourceUrl?: string | null;
  maxBreakdownsPerCategory?: number;
};

export type OregonDirectContributionAggregationResult = {
  summary: OregonDirectFinanceSummary;
  directBreakdowns: OregonFinanceDirectBreakdown[];
  matchedContributionRowCount: number;
  includedContributionRowCount: number;
  skippedContributionRowCount: number;
};

export type OregonOutsideSpendingGroup = {
  sponsorId: string;
  sponsorName: string;
  supportOppose: OregonOrestarSupportOppose;
  amount: number;
  sourceUrl: string | null;
};

export type OregonOutsideSpendingSummary = {
  outsideSupportTotal: number;
  outsideOpposeTotal: number;
  sourceUrl: string | null;
};

export type OregonOutsideSpendingAggregationInput = {
  candidateCommitteeId: string;
  electionYear: number;
  transactionDetails: readonly OregonOrestarTransactionDetail[];
  sourceUrl?: string | null;
  maxGroups?: number;
};

export type OregonOutsideSpendingAggregationResult = {
  summary: OregonOutsideSpendingSummary;
  outsideGroups: OregonOutsideSpendingGroup[];
  matchedExpenditureRowCount: number;
  includedAssociationCount: number;
  skippedAssociationCount: number;
};

export type OregonFinanceOutsideGroupBreakdown = {
  sponsorId: string;
  sponsorName: string;
  supportOppose: OregonOrestarSupportOppose;
  categoryType: OregonFinanceOutsideCategoryType;
  categoryName: string;
  amount: number;
  contributorCount: number;
  sourceUrl: string | null;
};

export type OregonOutsideGroupContributionAggregationInput = {
  electionYear: number;
  outsideGroups: readonly OregonOutsideSpendingGroup[];
  transactionDetails: readonly OregonOrestarTransactionDetail[];
  sourceUrl?: string | null;
  maxBreakdownsPerCategory?: number;
  minIndustryAmount?: number;
};

export type OregonOutsideGroupContributionAggregationResult = {
  outsideGroupBreakdowns: OregonFinanceOutsideGroupBreakdown[];
  matchedContributionRowCount: number;
  includedContributionRowCount: number;
  skippedContributionRowCount: number;
};

type DirectAggregate = {
  categoryType: OregonFinanceDirectCategoryType;
  categoryName: string;
  amountCents: number;
  contributorKeys: Set<string>;
  sourceUrl: string | null;
};

type OutsideGroupAggregate = {
  sponsorId: string;
  sponsorName: string;
  supportOppose: OregonOrestarSupportOppose;
  amountCents: number;
  sourceUrl: string | null;
};

type DonorAggregate = {
  sponsorId: string;
  sponsorName: string;
  supportOppose: OregonOrestarSupportOppose;
  displayName: string;
  normalizedName: string;
  amountCents: number;
  sourceUrl: string | null;
};

type IndustryAggregate = {
  sponsorId: string;
  sponsorName: string;
  supportOppose: OregonOrestarSupportOppose;
  industrySlug: string;
  amountCents: number;
  donorKeys: Set<string>;
  sourceUrl: string | null;
};

const DEFAULT_MAX_BREAKDOWNS_PER_CATEGORY = 50;
const DEFAULT_MAX_OUTSIDE_GROUPS = 50;
const DEFAULT_MIN_INDUSTRY_AMOUNT_CENTS = 25_000 * 100;

function requireNonEmpty(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmed;
}

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new Error(`Invalid Oregon finance aggregation election year: ${value}`);
  }
  return value;
}

function normalizePositiveInteger(value: number | undefined, fallback: number, fieldName: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Oregon finance aggregation ${fieldName}: ${value}`);
  }
  return normalized;
}

function normalizeMinAmount(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MIN_INDUSTRY_AMOUNT_CENTS;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid Oregon finance aggregation minIndustryAmount: ${value}`);
  }
  return Math.round(value * 100);
}

function normalizeId(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function normalizeDisplayText(value: string | null | undefined): string {
  return value?.trim().replace(/\s+/g, " ") ?? "";
}

function normalizeTextKey(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function outsideSponsorId(input: { committeeId: string | null | undefined; committeeName: string | null | undefined }): string {
  return normalizeId(input.committeeId) || normalizeTextKey(input.committeeName);
}

function amountToCents(amount: number | null | undefined): number | null {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) {
    return null;
  }
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

function centsToDollars(cents: number): number {
  return cents / 100;
}

export function parseOregonDateYear(raw: string | null | undefined): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  const slashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(trimmed);
  if (slashMatch?.[3]) {
    return Number(slashMatch[3]);
  }
  const isoMatch = /^(\d{4})-\d{2}-\d{2}/.exec(trimmed);
  if (isoMatch?.[1]) {
    return Number(isoMatch[1]);
  }
  return null;
}

function isElectionCycleDetail(input: { detail: OregonOrestarTransactionDetail; electionYear: number }): boolean {
  // Oregon money flows across the full two-year cycle, so accept the election
  // year and the year before it (an exact-year match silently zeroed every
  // prior-year transaction; same class of bug as Kentucky PR #379).
  const year = parseOregonDateYear(input.detail.transactionDate);
  return year !== null && (year === input.electionYear || year === input.electionYear - 1);
}

function isCommitteeDetail(input: { detail: OregonOrestarTransactionDetail; committeeId: string }): boolean {
  return normalizeId(input.detail.filerCommitteeId) === input.committeeId;
}

function transactionTypeKey(detail: OregonOrestarTransactionDetail): string {
  return normalizeTextKey(detail.transactionType);
}

function transactionSubTypeKey(detail: OregonOrestarTransactionDetail): string {
  return normalizeTextKey(detail.transactionSubType);
}

function isPositiveElectionCycleDetail(input: {
  detail: OregonOrestarTransactionDetail;
  electionYear: number;
}): boolean {
  const amountCents = amountToCents(input.detail.amount);
  return amountCents !== null && amountCents > 0 && isElectionCycleDetail(input);
}

function isContributionDetail(input: { detail: OregonOrestarTransactionDetail; electionYear: number }): boolean {
  const type = transactionTypeKey(input.detail);
  const subType = transactionSubTypeKey(input.detail);
  return (
    isPositiveElectionCycleDetail(input) &&
    /\bCONTRIBUTION\b/.test(type) &&
    !/\b(REFUND|LOAN|REVERSAL|RETURNED)\b/.test(type) &&
    !/\b(REFUND|LOAN|REVERSAL|RETURNED)\b/.test(subType)
  );
}

function isExpenditureDetail(input: { detail: OregonOrestarTransactionDetail; electionYear: number }): boolean {
  const type = transactionTypeKey(input.detail);
  const subType = transactionSubTypeKey(input.detail);
  return (
    isPositiveElectionCycleDetail(input) &&
    /\bEXPENDITURE\b/.test(type) &&
    !/\b(REFUND|REVERSAL|RETURNED)\b/.test(type) &&
    !/\b(REFUND|REVERSAL|RETURNED)\b/.test(subType)
  );
}

function contributorIdentityKey(detail: OregonOrestarTransactionDetail): string {
  const parts = [detail.contributorPayeeName, detail.occupation, detail.employerName]
    .map(normalizeTextKey)
    .filter(Boolean);
  return parts.length > 0 ? parts.join("\u0000") : normalizeTextKey(detail.transactionId) || "unknown";
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

function directAggregateKey(categoryType: OregonFinanceDirectCategoryType, categoryName: string): string {
  return `${categoryType}\u0000${normalizeTextKey(categoryName)}`;
}

function addDirectAggregate(
  aggregates: Map<string, DirectAggregate>,
  input: {
    categoryType: OregonFinanceDirectCategoryType;
    categoryName: string | null | undefined;
    amountCents: number;
    contributorKey: string;
    sourceUrl: string | null;
  }
): void {
  const categoryName = normalizeDisplayText(input.categoryName);
  if (!categoryName) {
    return;
  }
  const key = directAggregateKey(input.categoryType, categoryName);
  const existing = aggregates.get(key);
  if (existing) {
    existing.amountCents += input.amountCents;
    existing.contributorKeys.add(input.contributorKey);
    existing.sourceUrl = existing.sourceUrl ?? input.sourceUrl;
    return;
  }
  aggregates.set(key, {
    categoryType: input.categoryType,
    categoryName,
    amountCents: input.amountCents,
    contributorKeys: new Set([input.contributorKey]),
    sourceUrl: input.sourceUrl,
  });
}

function toDirectBreakdowns(input: {
  aggregates: Iterable<DirectAggregate>;
  maxBreakdownsPerCategory: number;
}): OregonFinanceDirectBreakdown[] {
  const byCategory = new Map<OregonFinanceDirectCategoryType, DirectAggregate[]>();
  for (const aggregate of input.aggregates) {
    const list = byCategory.get(aggregate.categoryType) ?? [];
    list.push(aggregate);
    byCategory.set(aggregate.categoryType, list);
  }

  const result: OregonFinanceDirectBreakdown[] = [];
  for (const categoryType of ["occupation", "contribution_size"] as const) {
    const limit = categoryType === "contribution_size" ? Number.POSITIVE_INFINITY : input.maxBreakdownsPerCategory;
    for (const aggregate of (byCategory.get(categoryType) ?? [])
      .sort((left, right) => right.amountCents - left.amountCents || left.categoryName.localeCompare(right.categoryName))
      .slice(0, limit)) {
      result.push({
        categoryType: aggregate.categoryType,
        categoryName: aggregate.categoryName,
        amount: centsToDollars(aggregate.amountCents),
        contributorCount: aggregate.contributorKeys.size,
        sourceUrl: aggregate.sourceUrl,
      });
    }
  }
  return result;
}

export function aggregateOregonDirectContributions(
  input: OregonDirectContributionAggregationInput
): OregonDirectContributionAggregationResult {
  const committeeId = requireNonEmpty(input.committeeId, "Oregon committee ID");
  const electionYear = normalizeElectionYear(input.electionYear);
  const maxBreakdownsPerCategory = normalizePositiveInteger(
    input.maxBreakdownsPerCategory,
    DEFAULT_MAX_BREAKDOWNS_PER_CATEGORY,
    "maxBreakdownsPerCategory"
  );
  const sourceUrl = input.sourceUrl ?? null;
  const aggregates = new Map<string, DirectAggregate>();
  let matchedContributionRowCount = 0;
  let includedContributionRowCount = 0;
  let skippedContributionRowCount = 0;
  let directContributionTotalCents = 0;

  for (const detail of input.transactionDetails) {
    if (!isCommitteeDetail({ detail, committeeId })) {
      continue;
    }
    matchedContributionRowCount += 1;
    const amountCents = amountToCents(detail.amount);
    if (amountCents === null || !isContributionDetail({ detail, electionYear })) {
      skippedContributionRowCount += 1;
      continue;
    }

    includedContributionRowCount += 1;
    directContributionTotalCents += amountCents;
    const contributorKey = contributorIdentityKey(detail);
    const rowSourceUrl = detail.sourceUrl ?? sourceUrl;
    addDirectAggregate(aggregates, {
      categoryType: "occupation",
      categoryName: detail.occupation,
      amountCents,
      contributorKey,
      sourceUrl: rowSourceUrl,
    });
    addDirectAggregate(aggregates, {
      categoryType: "contribution_size",
      categoryName: contributionSizeBucket(centsToDollars(amountCents)),
      amountCents,
      contributorKey,
      sourceUrl: rowSourceUrl,
    });
  }

  return {
    summary: {
      directContributionTotal: centsToDollars(directContributionTotalCents),
      sourceUrl,
    },
    directBreakdowns: toDirectBreakdowns({
      aggregates: aggregates.values(),
      maxBreakdownsPerCategory,
    }),
    matchedContributionRowCount,
    includedContributionRowCount,
    skippedContributionRowCount,
  };
}

function outsideGroupKey(input: { sponsorId: string; supportOppose: OregonOrestarSupportOppose }): string {
  return `${input.sponsorId}\u0000${input.supportOppose}`;
}

function addOutsideGroupAggregate(
  aggregates: Map<string, OutsideGroupAggregate>,
  input: {
    sponsorId: string;
    sponsorName: string;
    supportOppose: OregonOrestarSupportOppose;
    amountCents: number;
    sourceUrl: string | null;
  }
): void {
  const key = outsideGroupKey(input);
  const existing = aggregates.get(key);
  if (existing) {
    existing.amountCents += input.amountCents;
    existing.sourceUrl = existing.sourceUrl ?? input.sourceUrl;
    return;
  }
  aggregates.set(key, { ...input });
}

export function aggregateOregonOutsideSpending(
  input: OregonOutsideSpendingAggregationInput
): OregonOutsideSpendingAggregationResult {
  const candidateCommitteeId = requireNonEmpty(input.candidateCommitteeId, "Oregon candidate committee ID");
  const electionYear = normalizeElectionYear(input.electionYear);
  const maxGroups = normalizePositiveInteger(input.maxGroups, DEFAULT_MAX_OUTSIDE_GROUPS, "maxGroups");
  const sourceUrl = input.sourceUrl ?? null;
  const aggregates = new Map<string, OutsideGroupAggregate>();
  let matchedExpenditureRowCount = 0;
  let includedAssociationCount = 0;
  let skippedAssociationCount = 0;
  let outsideSupportTotalCents = 0;
  let outsideOpposeTotalCents = 0;

  for (const detail of input.transactionDetails) {
    if (!isExpenditureDetail({ detail, electionYear }) || detail.outsideAssociations.length === 0) {
      continue;
    }
    matchedExpenditureRowCount += 1;
    const sponsorName = normalizeDisplayText(detail.filerCommitteeName);
    const sponsorId = outsideSponsorId({ committeeId: detail.filerCommitteeId, committeeName: sponsorName });
    if (!sponsorId || !sponsorName) {
      skippedAssociationCount += detail.outsideAssociations.length;
      continue;
    }

    for (const association of detail.outsideAssociations) {
      if (association.associationType !== "independent_expenditure" || normalizeId(association.targetCommitteeId) !== candidateCommitteeId) {
        skippedAssociationCount += 1;
        continue;
      }
      const amountCents = amountToCents(association.amount);
      if (amountCents === null || amountCents <= 0) {
        skippedAssociationCount += 1;
        continue;
      }

      includedAssociationCount += 1;
      if (association.supportOppose === "support") {
        outsideSupportTotalCents += amountCents;
      } else {
        outsideOpposeTotalCents += amountCents;
      }
      addOutsideGroupAggregate(aggregates, {
        sponsorId,
        sponsorName,
        supportOppose: association.supportOppose,
        amountCents,
        sourceUrl: detail.sourceUrl ?? sourceUrl,
      });
    }
  }

  const outsideGroups = [...aggregates.values()]
    .sort(
      (left, right) =>
        right.amountCents - left.amountCents ||
        left.sponsorName.localeCompare(right.sponsorName) ||
        left.supportOppose.localeCompare(right.supportOppose)
    )
    .slice(0, maxGroups)
    .map((group) => ({
      sponsorId: group.sponsorId,
      sponsorName: group.sponsorName,
      supportOppose: group.supportOppose,
      amount: centsToDollars(group.amountCents),
      sourceUrl: group.sourceUrl,
    }));

  return {
    summary: {
      outsideSupportTotal: centsToDollars(outsideSupportTotalCents),
      outsideOpposeTotal: centsToDollars(outsideOpposeTotalCents),
      sourceUrl,
    },
    outsideGroups,
    matchedExpenditureRowCount,
    includedAssociationCount,
    skippedAssociationCount,
  };
}

function isOrganizationContributor(detail: OregonOrestarTransactionDetail): boolean {
  const name = normalizeTextKey(detail.contributorPayeeName);
  if (!name) {
    return false;
  }

  const type = normalizeTextKey(detail.addressBookType);
  if (/\b(INDIVIDUAL|PERSON|CANDIDATE|IMMEDIATE FAMILY|SELF)\b/.test(type)) {
    return false;
  }
  if (
    /\b(BUSINESS|ENTITY|CORPORATION|COMPANY|COMMITTEE|PAC|PARTY|ORGANIZATION|ASSOCIATION|NONPROFIT|NON PROFIT|LABOR|UNION|PARTNERSHIP|LLC|TRUST)\b/.test(
      type
    )
  ) {
    return true;
  }

  return /\b(INC|LLC|CORP|CORPORATION|COMPANY|ASSOCIATION|PAC|COMMITTEE|UNION|FOUNDATION|FUND|TRUST|LOCAL|CLUB)\b/.test(
    name
  );
}

function donorKey(input: {
  sponsorId: string;
  supportOppose: OregonOrestarSupportOppose;
  normalizedName: string;
}): string {
  return `${input.sponsorId}\u0000${input.supportOppose}\u0000${input.normalizedName}`;
}

function industryKey(input: {
  sponsorId: string;
  supportOppose: OregonOrestarSupportOppose;
  industrySlug: string;
}): string {
  return `${input.sponsorId}\u0000${input.supportOppose}\u0000${input.industrySlug}`;
}

function breakdownBucketKey(input: {
  sponsorId: string;
  supportOppose: OregonOrestarSupportOppose;
}): string {
  return `${input.sponsorId}\u0000${input.supportOppose}`;
}

function toOutsideGroupBreakdowns(input: {
  donors: Iterable<DonorAggregate>;
  industries: Iterable<IndustryAggregate>;
  maxBreakdownsPerCategory: number;
}): OregonFinanceOutsideGroupBreakdown[] {
  const donorsByBucket = new Map<string, DonorAggregate[]>();
  const industriesByBucket = new Map<string, IndustryAggregate[]>();

  for (const donor of input.donors) {
    const key = breakdownBucketKey(donor);
    const bucket = donorsByBucket.get(key) ?? [];
    bucket.push(donor);
    donorsByBucket.set(key, bucket);
  }
  for (const industry of input.industries) {
    const key = breakdownBucketKey(industry);
    const bucket = industriesByBucket.get(key) ?? [];
    bucket.push(industry);
    industriesByBucket.set(key, bucket);
  }

  const result: OregonFinanceOutsideGroupBreakdown[] = [];
  const bucketSortKey = (bucket: Array<{ sponsorId: string; supportOppose: OregonOrestarSupportOppose }>): string =>
    bucket[0] ? breakdownBucketKey(bucket[0]) : "";

  for (const bucket of [...donorsByBucket.values()].sort((left, right) =>
    bucketSortKey(left).localeCompare(bucketSortKey(right))
  )) {
    for (const donor of bucket
      .sort((left, right) => right.amountCents - left.amountCents || left.displayName.localeCompare(right.displayName))
      .slice(0, input.maxBreakdownsPerCategory)) {
      result.push({
        sponsorId: donor.sponsorId,
        sponsorName: donor.sponsorName,
        supportOppose: donor.supportOppose,
        categoryType: "donor",
        categoryName: donor.displayName,
        amount: centsToDollars(donor.amountCents),
        contributorCount: 1,
        sourceUrl: donor.sourceUrl,
      });
    }
  }

  for (const bucket of [...industriesByBucket.values()].sort((left, right) =>
    bucketSortKey(left).localeCompare(bucketSortKey(right))
  )) {
    for (const industry of bucket
      .sort((left, right) => right.amountCents - left.amountCents || left.industrySlug.localeCompare(right.industrySlug))
      .slice(0, input.maxBreakdownsPerCategory)) {
      result.push({
        sponsorId: industry.sponsorId,
        sponsorName: industry.sponsorName,
        supportOppose: industry.supportOppose,
        categoryType: "industry",
        categoryName: industry.industrySlug,
        amount: centsToDollars(industry.amountCents),
        contributorCount: industry.donorKeys.size,
        sourceUrl: industry.sourceUrl,
      });
    }
  }

  return result;
}

export function aggregateOregonOutsideGroupContributions(
  input: OregonOutsideGroupContributionAggregationInput
): OregonOutsideGroupContributionAggregationResult {
  const electionYear = normalizeElectionYear(input.electionYear);
  const maxBreakdownsPerCategory = normalizePositiveInteger(
    input.maxBreakdownsPerCategory,
    DEFAULT_MAX_BREAKDOWNS_PER_CATEGORY,
    "maxBreakdownsPerCategory"
  );
  const minIndustryAmountCents = normalizeMinAmount(input.minIndustryAmount);
  const sourceUrl = input.sourceUrl ?? null;

  const outsideGroupsBySponsorId = new Map<string, OregonOutsideSpendingGroup[]>();
  for (const group of input.outsideGroups) {
    const sponsorId = normalizeId(group.sponsorId);
    if (!sponsorId) {
      continue;
    }
    const existing = outsideGroupsBySponsorId.get(sponsorId) ?? [];
    existing.push({ ...group, sponsorId });
    outsideGroupsBySponsorId.set(sponsorId, existing);
  }

  if (outsideGroupsBySponsorId.size === 0) {
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

  for (const detail of input.transactionDetails) {
    const sponsorId = outsideSponsorId({
      committeeId: detail.filerCommitteeId,
      committeeName: detail.filerCommitteeName,
    });
    const matchingGroups = outsideGroupsBySponsorId.get(sponsorId) ?? [];
    if (matchingGroups.length === 0) {
      continue;
    }
    matchedContributionRowCount += 1;
    const supportOpposeValues = [...new Set(matchingGroups.map((group) => group.supportOppose))];
    const supportOppose = supportOpposeValues.length === 1 ? supportOpposeValues[0] ?? null : null;
    const amountCents = amountToCents(detail.amount);
    const displayName = normalizeDisplayText(detail.contributorPayeeName);
    const normalizedName = normalizeFinanceLabel(displayName, "donor");

    if (
      !supportOppose ||
      !displayName ||
      !normalizedName ||
      amountCents === null ||
      !isContributionDetail({ detail, electionYear }) ||
      !isOrganizationContributor(detail)
    ) {
      skippedContributionRowCount += 1;
      continue;
    }

    const group = matchingGroups.find((candidateGroup) => candidateGroup.supportOppose === supportOppose);
    if (!group) {
      skippedContributionRowCount += 1;
      continue;
    }
    includedContributionRowCount += 1;
    const key = donorKey({ sponsorId, supportOppose, normalizedName });
    const existing = donors.get(key);
    if (existing) {
      existing.amountCents += amountCents;
      existing.sourceUrl = existing.sourceUrl ?? detail.sourceUrl ?? group.sourceUrl ?? sourceUrl;
      continue;
    }
    donors.set(key, {
      sponsorId: group.sponsorId,
      sponsorName: group.sponsorName,
      supportOppose,
      displayName,
      normalizedName,
      amountCents,
      sourceUrl: detail.sourceUrl ?? group.sourceUrl ?? sourceUrl,
    });
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
      sponsorId: donor.sponsorId,
      supportOppose: donor.supportOppose,
      industrySlug: classification.industrySlug,
    });
    const existing = industries.get(key);
    if (existing) {
      existing.amountCents += donor.amountCents;
      existing.donorKeys.add(donor.normalizedName);
      existing.sourceUrl = existing.sourceUrl ?? donor.sourceUrl;
      continue;
    }
    industries.set(key, {
      sponsorId: donor.sponsorId,
      sponsorName: donor.sponsorName,
      supportOppose: donor.supportOppose,
      industrySlug: classification.industrySlug,
      amountCents: donor.amountCents,
      donorKeys: new Set([donor.normalizedName]),
      sourceUrl: donor.sourceUrl,
    });
  }

  return {
    outsideGroupBreakdowns: toOutsideGroupBreakdowns({
      donors: donors.values(),
      industries: industries.values(),
      maxBreakdownsPerCategory,
    }),
    matchedContributionRowCount,
    includedContributionRowCount,
    skippedContributionRowCount,
  };
}
