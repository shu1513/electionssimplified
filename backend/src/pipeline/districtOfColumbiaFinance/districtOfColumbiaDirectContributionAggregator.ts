import type { DistrictOfColumbiaOcfContributionRecord } from "./districtOfColumbiaOcfClient.js";

export type DistrictOfColumbiaDirectContributionAggregationInput = {
  committeeKey: string;
  electionYear: number;
  contributionRecords: readonly DistrictOfColumbiaOcfContributionRecord[];
  sourceUrl?: string | null;
  maxBreakdownsPerCategory?: number;
};

export type DistrictOfColumbiaDirectFinanceSummary = {
  totalReceipts: number;
  directContributionTotal: number;
  // Fair Elections base and matching payments. Null when no matched row
  // carries a receipt kind (OCF export committees are not in the program).
  publicFundsReceived: number | null;
  sourceUrl: string | null;
};

export type DistrictOfColumbiaFinanceDirectBreakdown = {
  categoryType: "occupation" | "contribution_size";
  categoryName: string;
  amount: number;
  contributorCount: number;
  sourceUrl: string | null;
};

export type DistrictOfColumbiaDirectContributionAggregationResult = {
  summary: DistrictOfColumbiaDirectFinanceSummary;
  directBreakdowns: DistrictOfColumbiaFinanceDirectBreakdown[];
  matchedContributionRowCount: number;
  includedContributionRowCount: number;
  skippedContributionRowCount: number;
};

type Aggregate = {
  categoryType: DistrictOfColumbiaFinanceDirectBreakdown["categoryType"];
  categoryName: string;
  amountCents: number;
  contributorKeys: Set<string>;
};

const DEFAULT_MAX_BREAKDOWNS_PER_CATEGORY = 50;

function requireNonEmpty(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmed;
}

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new Error(`Invalid D.C. direct contribution aggregation election year: ${value}`);
  }
  return value;
}

function normalizePositiveInteger(value: number | undefined, fallback: number, fieldName: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid D.C. direct contribution aggregation ${fieldName}: ${value}`);
  }
  return normalized;
}

function normalizeCommitteeKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

function normalizeTextKey(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function parseDistrictOfColumbiaOcfDateYear(raw: string | undefined): number | null {
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

export function districtOfColumbiaElectionCycleStartYear(electionYear: number): number {
  return normalizeElectionYear(electionYear) - 1;
}

function isCycleRecord(input: { record: DistrictOfColumbiaOcfContributionRecord; electionYear: number }): boolean {
  if (input.record.electionYear !== undefined) {
    return input.record.electionYear === input.electionYear;
  }

  const year = parseDistrictOfColumbiaOcfDateYear(input.record.date);
  if (year === null) {
    return false;
  }
  return year >= districtOfColumbiaElectionCycleStartYear(input.electionYear) && year <= input.electionYear;
}

function recordCommitteeKey(record: DistrictOfColumbiaOcfContributionRecord): string {
  return normalizeCommitteeKey(record.committeeKey ?? record.committeeName ?? "");
}

export function isDistrictOfColumbiaTotalReceipt(input: {
  record: DistrictOfColumbiaOcfContributionRecord;
  electionYear: number;
}): boolean {
  const amountCents = amountToCents(input.record.amount);
  return amountCents !== null && amountCents > 0 && isCycleRecord(input);
}

export function isDistrictOfColumbiaDirectDonorSupportReceipt(input: {
  record: DistrictOfColumbiaOcfContributionRecord;
  electionYear: number;
}): boolean {
  const receiptKind = input.record.receiptKind ?? "contribution";
  return receiptKind === "contribution" && isDistrictOfColumbiaTotalReceipt(input);
}

function contributorIdentityKey(record: DistrictOfColumbiaOcfContributionRecord): string {
  const parts = [
    record.contributorType,
    record.contributorName,
    record.employer,
    record.occupation,
  ]
    .map(normalizeTextKey)
    .filter(Boolean);
  if (parts.length > 0) {
    return parts.join("\u0000");
  }
  return "unknown";
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

function aggregateKey(categoryType: Aggregate["categoryType"], categoryName: string): string {
  return `${categoryType}\u0000${categoryName.trim().toUpperCase()}`;
}

function addAggregate(
  aggregates: Map<string, Aggregate>,
  input: { categoryType: Aggregate["categoryType"]; categoryName: string | undefined; amountCents: number; contributorKey: string }
): void {
  const categoryName = input.categoryName?.trim().replace(/\s+/g, " ") ?? "";
  if (categoryName.length === 0) {
    return;
  }

  const key = aggregateKey(input.categoryType, categoryName);
  const existing = aggregates.get(key);
  if (!existing) {
    aggregates.set(key, {
      categoryType: input.categoryType,
      categoryName,
      amountCents: input.amountCents,
      contributorKeys: new Set([input.contributorKey]),
    });
    return;
  }

  existing.amountCents += input.amountCents;
  existing.contributorKeys.add(input.contributorKey);
}

function toDirectBreakdowns(input: {
  aggregates: Iterable<Aggregate>;
  sourceUrl: string | null;
  maxBreakdownsPerCategory: number;
}): DistrictOfColumbiaFinanceDirectBreakdown[] {
  const byCategory = new Map<Aggregate["categoryType"], Aggregate[]>();
  for (const aggregate of input.aggregates) {
    const list = byCategory.get(aggregate.categoryType) ?? [];
    list.push(aggregate);
    byCategory.set(aggregate.categoryType, list);
  }

  const result: DistrictOfColumbiaFinanceDirectBreakdown[] = [];
  const categoryOrder: Aggregate["categoryType"][] = ["occupation", "contribution_size"];
  for (const categoryType of categoryOrder) {
    const limit = categoryType === "contribution_size" ? Number.POSITIVE_INFINITY : input.maxBreakdownsPerCategory;
    for (const aggregate of (byCategory.get(categoryType) ?? [])
      .sort((left, right) => right.amountCents - left.amountCents || left.categoryName.localeCompare(right.categoryName))
      .slice(0, limit)) {
      result.push({
        categoryType: aggregate.categoryType,
        categoryName: aggregate.categoryName,
        amount: centsToDollars(aggregate.amountCents),
        contributorCount: aggregate.contributorKeys.size,
        sourceUrl: input.sourceUrl,
      });
    }
  }

  return result;
}

export function aggregateDistrictOfColumbiaDirectContributions(
  input: DistrictOfColumbiaDirectContributionAggregationInput
): DistrictOfColumbiaDirectContributionAggregationResult {
  const committeeKey = normalizeCommitteeKey(requireNonEmpty(input.committeeKey, "D.C. committee key"));
  const electionYear = normalizeElectionYear(input.electionYear);
  const maxBreakdownsPerCategory = normalizePositiveInteger(
    input.maxBreakdownsPerCategory,
    DEFAULT_MAX_BREAKDOWNS_PER_CATEGORY,
    "maxBreakdownsPerCategory"
  );
  const sourceUrl = input.sourceUrl ?? null;
  const aggregates = new Map<string, Aggregate>();
  let matchedContributionRowCount = 0;
  let includedContributionRowCount = 0;
  let skippedContributionRowCount = 0;
  let totalReceiptsCents = 0;
  let directContributionTotalCents = 0;
  let publicFundsCents = 0;
  let hasReceiptKinds = false;

  for (const record of input.contributionRecords) {
    if (recordCommitteeKey(record) !== committeeKey) {
      continue;
    }
    matchedContributionRowCount += 1;
    if (record.receiptKind !== undefined) {
      hasReceiptKinds = true;
    }

    const amountCents = amountToCents(record.amount);
    if (amountCents === null || amountCents <= 0 || !isCycleRecord({ record, electionYear })) {
      skippedContributionRowCount += 1;
      continue;
    }

    totalReceiptsCents += amountCents;
    if (record.receiptKind === "public_funds") {
      publicFundsCents += amountCents;
    }
    if (!isDistrictOfColumbiaDirectDonorSupportReceipt({ record, electionYear })) {
      skippedContributionRowCount += 1;
      continue;
    }

    includedContributionRowCount += 1;
    directContributionTotalCents += amountCents;
    const contributorKey = contributorIdentityKey(record);
    addAggregate(aggregates, {
      categoryType: "occupation",
      categoryName: record.occupation,
      amountCents,
      contributorKey,
    });
    addAggregate(aggregates, {
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
      publicFundsReceived: hasReceiptKinds ? centsToDollars(publicFundsCents) : null,
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
