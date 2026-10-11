import type { ConnecticutEcrisArtifactRow } from "./connecticutEcrisArtifactReader.js";

export type ConnecticutDirectContributionAggregationInput = {
  committeeId: string;
  electionYear: number;
  receiptRows: readonly ConnecticutEcrisArtifactRow[];
  committeeRegistry?: readonly ConnecticutFinanceCommitteeRegistryEntry[];
  sourceUrl?: string | null;
  maxBreakdownsPerCategory?: number;
};

export type ConnecticutFinanceCommitteeRegistryEntry = {
  committeeId: string;
  committeeName: string;
  committeeType: string;
};

export type ConnecticutFinancePacDonor = {
  committeeId: string;
  committeeName: string;
  committeeType: string | null;
  amount: number;
  contributionCount: number;
  sourceUrl: string | null;
};

export type ConnecticutDirectFinanceSummary = {
  totalReceipts: number;
  sourceUrl: string | null;
};

export type ConnecticutFinanceDirectBreakdown = {
  categoryType: "occupation" | "contribution_size";
  categoryName: string;
  amount: number;
  contributorCount: number;
  sourceUrl: string | null;
};

export type ConnecticutDirectContributionAggregationResult = {
  summary: ConnecticutDirectFinanceSummary;
  directBreakdowns: ConnecticutFinanceDirectBreakdown[];
  pacDonors: ConnecticutFinancePacDonor[];
  matchedReceiptRowCount: number;
  includedReceiptRowCount: number;
  skippedReceiptRowCount: number;
};

type Aggregate = {
  categoryType: ConnecticutFinanceDirectBreakdown["categoryType"];
  categoryName: string;
  amountCents: number;
  contributorCount: number;
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
  if (!Number.isInteger(value) || value < 2008 || value > 2100) {
    throw new Error(`Invalid Connecticut direct contribution aggregation election year: ${value}`);
  }
  return value;
}

function normalizePositiveInteger(value: number | undefined, fallback: number, fieldName: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Connecticut direct contribution aggregation ${fieldName}: ${value}`);
  }
  return normalized;
}

function value(row: ConnecticutEcrisArtifactRow, key: string): string {
  return row[key]?.trim() ?? "";
}

function normalizeId(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeTextKey(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseAmountCents(raw: string): number | null {
  const normalized = raw.replace(/[$,]/g, "").trim();
  if (normalized.length === 0 || !/^-?\d+(?:\.\d{1,2})?$/.test(normalized)) {
    return null;
  }

  const sign = normalized.startsWith("-") ? -1 : 1;
  const unsigned = sign === -1 ? normalized.slice(1) : normalized;
  const [dollarsPart, centsPart = ""] = unsigned.split(".");
  const dollars = Number.parseInt(dollarsPart, 10);
  if (!Number.isSafeInteger(dollars)) {
    return null;
  }
  const cents = Number.parseInt(centsPart.padEnd(2, "0"), 10) || 0;
  const total = dollars * 100 + cents;
  return Number.isSafeInteger(total) ? sign * total : null;
}

function centsToDollars(cents: number): number {
  return cents / 100;
}

function parseElectionYear(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isInteger(parsed) && String(parsed) === trimmed ? parsed : null;
}

function isCandidateCommittee(row: ConnecticutEcrisArtifactRow): boolean {
  return normalizeTextKey(value(row, "Committee Type")) === "CANDIDATE COMMITTEE";
}

function rowElectionYearMatches(row: ConnecticutEcrisArtifactRow, electionYear: number): boolean {
  return parseElectionYear(value(row, "ElectionYear")) === electionYear;
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
  input: { categoryType: Aggregate["categoryType"]; categoryName: string; amountCents: number }
): void {
  const categoryName = input.categoryName.trim().replace(/\s+/g, " ");
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
      contributorCount: 1,
    });
    return;
  }

  existing.amountCents += input.amountCents;
  existing.contributorCount += 1;
}

function toDirectBreakdowns(input: {
  aggregates: Iterable<Aggregate>;
  sourceUrl: string | null;
  maxBreakdownsPerCategory: number;
}): ConnecticutFinanceDirectBreakdown[] {
  const byCategory = new Map<Aggregate["categoryType"], Aggregate[]>();
  for (const aggregate of input.aggregates) {
    const list = byCategory.get(aggregate.categoryType) ?? [];
    list.push(aggregate);
    byCategory.set(aggregate.categoryType, list);
  }

  const result: ConnecticutFinanceDirectBreakdown[] = [];
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
        contributorCount: aggregate.contributorCount,
        sourceUrl: input.sourceUrl,
      });
    }
  }

  return result;
}

function donorNameKey(name: string): string {
  return normalizeTextKey(name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, " AND "));
}

function committeeRegistryByName(entries: readonly ConnecticutFinanceCommitteeRegistryEntry[], candidateAliases = false) {
  const registry = new Map<string, Map<string, ConnecticutFinanceCommitteeRegistryEntry>>();
  for (const entry of entries) {
    let key = donorNameKey(entry.committeeName);
    if (candidateAliases) {
      if (!["CANDIDATE COMMITTEE", "EXPLORATORY COMMITTEE"].includes(normalizeTextKey(entry.committeeType)) || !key.startsWith("ELECT ")) continue;
      key = key.slice("ELECT ".length);
    }
    if (!key || !entry.committeeId.trim()) continue;
    const matches = registry.get(key) ?? new Map<string, ConnecticutFinanceCommitteeRegistryEntry>();
    matches.set(normalizeId(entry.committeeId) + "\u0000" + entry.committeeType, entry);
    registry.set(key, matches);
  }
  return registry;
}

export function aggregateConnecticutDirectContributions(
  input: ConnecticutDirectContributionAggregationInput
): ConnecticutDirectContributionAggregationResult {
  const committeeId = normalizeId(requireNonEmpty(input.committeeId, "Connecticut committee id"));
  const electionYear = normalizeElectionYear(input.electionYear);
  const maxBreakdownsPerCategory = normalizePositiveInteger(
    input.maxBreakdownsPerCategory,
    DEFAULT_MAX_BREAKDOWNS_PER_CATEGORY,
    "maxBreakdownsPerCategory"
  );
  const aggregates = new Map<string, Aggregate>();
  const registry = committeeRegistryByName(input.committeeRegistry ?? []);
  // A filing may shorten "Elect Cheryl 79" to "Cheryl 79". Only a unique
  // registered campaign alias is usable, and an exact registration wins.
  const campaignAliases = committeeRegistryByName(input.committeeRegistry ?? [], true);
  const pacDonors = new Map<string, ConnecticutFinancePacDonor>();
  let matchedReceiptRowCount = 0;
  let includedReceiptRowCount = 0;
  let skippedReceiptRowCount = 0;
  let totalReceiptsCents = 0;

  for (const row of input.receiptRows) {
    if (normalizeId(value(row, "Committee ID")) !== committeeId) {
      continue;
    }
    matchedReceiptRowCount += 1;

    const amountCents = parseAmountCents(value(row, "Amount"));
    if (
      amountCents === null ||
      amountCents <= 0 ||
      !isCandidateCommittee(row) ||
      !rowElectionYearMatches(row, electionYear)
    ) {
      skippedReceiptRowCount += 1;
      continue;
    }

    // C1 explicitly identifies committee-source receipts. Individual names,
    // organizations in other sections, grants and loans are not PAC evidence.
    const donorName = value(row, "Contributor Name");
    if (normalizeTextKey(value(row, "Receipt Type")) === "CONTRIBUTIONS FROM OTHER COMMITTEES" && donorName) {
      const nameKey = donorNameKey(donorName);
      const matches = registry.get(nameKey) ?? campaignAliases.get(nameKey);
      const entry = matches?.size === 1 ? [...matches.values()][0] : undefined;
      const donorId = entry ? normalizeId(entry.committeeId) : nameKey;
      if (donorId) {
        const existing = pacDonors.get(donorId);
        pacDonors.set(donorId, {
          committeeId: donorId,
          committeeName: existing?.committeeName ?? entry?.committeeName ?? donorName,
          // Ambiguous registry names are withheld from the PAC card as well.
          committeeType: entry?.committeeType ?? (matches && matches.size > 1 ? "Ambiguous Committee" : null),
          amount: centsToDollars(Math.round((existing?.amount ?? 0) * 100) + amountCents),
          contributionCount: (existing?.contributionCount ?? 0) + 1,
          sourceUrl: input.sourceUrl ?? null,
        });
      }
    }

    includedReceiptRowCount += 1;
    totalReceiptsCents += amountCents;
    addAggregate(aggregates, {
      categoryType: "occupation",
      categoryName: value(row, "Occupation"),
      amountCents,
    });
    addAggregate(aggregates, {
      categoryType: "contribution_size",
      categoryName: contributionSizeBucket(centsToDollars(amountCents)),
      amountCents,
    });
  }

  return {
    summary: {
      totalReceipts: centsToDollars(totalReceiptsCents),
      sourceUrl: input.sourceUrl ?? null,
    },
    directBreakdowns: toDirectBreakdowns({
      aggregates: aggregates.values(),
      sourceUrl: input.sourceUrl ?? null,
      maxBreakdownsPerCategory,
    }),
    pacDonors: [...pacDonors.values()].sort((a, b) => b.amount - a.amount || a.committeeName.localeCompare(b.committeeName)),
    matchedReceiptRowCount,
    includedReceiptRowCount,
    skippedReceiptRowCount,
  };
}
