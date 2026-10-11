import { normalizeMichiganMitnLegacyArchiveYear } from "./michiganMitnLegacyRowTypes.js";
import type { MichiganMitnLegacyContributionRow } from "./michiganMitnLegacyRowTypes.js";
import type { MichiganMitnCommitteeSearchRow } from "./michiganMitnPublicSearchClient.js";

export type MichiganDirectContributionAggregationInput = {
  committeeId: string;
  electionYear: number;
  contributionRows: readonly MichiganMitnLegacyContributionRow[];
  committeeRegistryRows?: readonly MichiganMitnCommitteeSearchRow[];
  sourceUrl?: string | null;
  maxBreakdownsPerCategory?: number;
};

export type MichiganDirectFinanceSummary = {
  totalReceipts: number;
  directContributionTotal: number;
  // Loan receipts only (a strict subset of totalReceipts, disjoint from
  // directContributionTotal): the number that makes self-funded campaigns
  // visible on a card whose "Raised" deliberately excludes loans.
  candidateLoanTotal: number;
  sourceUrl: string | null;
};

export type MichiganFinanceDirectBreakdown = {
  categoryType: "occupation" | "contribution_size";
  categoryName: string;
  amount: number;
  contributorCount: number;
  sourceUrl: string | null;
};

export type MichiganFinancePacDonor = {
  committeeId: string;
  committeeName: string;
  committeeType: string;
  amount: number;
  contributionCount: number;
  sourceUrl: string | null;
};

export type MichiganDirectContributionAggregationResult = {
  summary: MichiganDirectFinanceSummary;
  directBreakdowns: MichiganFinanceDirectBreakdown[];
  pacDonors?: MichiganFinancePacDonor[];
  matchedContributionRowCount: number;
  includedContributionRowCount: number;
  skippedContributionRowCount: number;
};

type Aggregate = {
  categoryType: MichiganFinanceDirectBreakdown["categoryType"];
  categoryName: string;
  amountCents: number;
  contributorKeys: Set<string>;
};

const DEFAULT_MAX_BREAKDOWNS_PER_CATEGORY = 50;

function requireNonEmpty(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmed;
}

function normalizePositiveInteger(value: number | undefined, fallback: number, fieldName: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Michigan direct contribution aggregation ${fieldName}: ${normalized}`);
  }
  return normalized;
}

function normalizeId(value: string): string {
  const normalized = value.trim().toUpperCase();
  return /^\d+$/.test(normalized) ? normalized.replace(/^0+(?=\d)/, "") : normalized;
}

function normalizeTextKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Exact labels from the official MiTN committee search's committeeTypes.
// The contribution export's "Individual" means an itemized receipt, not an
// individual person; only a unique typed registry identity establishes a PAC.
const PAC_DONOR_COMMITTEE_TYPES = new Set([
  "INDEPENDENT",
  "INDEPENDENT EXPENDITURE",
  "POLITICAL",
  "CAUCUS",
  "QUALIFYING POLITICAL PARTY",
  "STATE POLITICAL PARTY",
  "COUNTY POLITICAL PARTY",
  "DISTRICT POLITICAL PARTY",
]);

function committeeRegistryByName(
  rows: readonly MichiganMitnCommitteeSearchRow[]
): Map<string, MichiganMitnCommitteeSearchRow | null> {
  const byName = new Map<string, MichiganMitnCommitteeSearchRow | null>();
  for (const row of rows) {
    const name = normalizeTextKey(row.committeeName);
    const committeeId = normalizeId(row.committeeId);
    if (!name || !committeeId) {
      continue;
    }
    const existing = byName.get(name);
    if (existing === undefined) {
      byName.set(name, row);
    } else if (
      existing !== null &&
      (normalizeId(existing.committeeId) !== committeeId ||
        normalizeTextKey(existing.committeeType) !== normalizeTextKey(row.committeeType))
    ) {
      // Include excluded types in ambiguity checks: a same-name candidate or
      // ballot committee must not silently fall through to an allowed PAC.
      byName.set(name, null);
    }
  }
  return byName;
}

type PacDonorAggregate = Omit<MichiganFinancePacDonor, "amount"> & { amountCents: number };

function parseAmountCents(raw: string): number | null {
  const normalized = raw.replace(/[$,]/g, "").trim();
  if (!normalized || !/^-?\d+(?:\.\d{1,4})?$/.test(normalized)) {
    return null;
  }
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) {
    return null;
  }
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

function centsToDollars(cents: number): number {
  return cents / 100;
}

function parseMichiganMitnDateYear(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const isoMatch = /^(\d{4})-\d{2}-\d{2}/.exec(trimmed);
  if (isoMatch) {
    return Number(isoMatch[1]);
  }
  const slashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(trimmed);
  if (slashMatch) {
    return Number(slashMatch[3]);
  }
  return null;
}

export function michiganElectionCycleStartYear(electionYear: number): number {
  return normalizeMichiganMitnLegacyArchiveYear(electionYear) - 1;
}

function isCycleYear(input: { rawDate: string; electionYear: number }): boolean {
  const year = parseMichiganMitnDateYear(input.rawDate);
  if (year === null) {
    return false;
  }
  return year >= michiganElectionCycleStartYear(input.electionYear) && year <= input.electionYear;
}

function isExcludedContributionType(raw: string): boolean {
  const normalized = normalizeTextKey(raw);
  if (!normalized) {
    return false;
  }
  return /\b(?:LOAN|REFUND|REBATE|INTEREST|DIVIDEND|TRANSFER|DISBURSEMENT|EXPENDITURE|DEBT|REPAYMENT|RETURNED|REVERSAL)\b/.test(
    normalized
  );
}

export function isMichiganTotalReceipt(input: {
  row: MichiganMitnLegacyContributionRow;
  electionYear: number;
}): boolean {
  const amountCents = parseAmountCents(input.row.amount);
  return (
    amountCents !== null &&
    amountCents > 0 &&
    normalizeId(input.row.cfr_com_id).length > 0 &&
    isCycleYear({ rawDate: input.row.received_date, electionYear: normalizeMichiganMitnLegacyArchiveYear(input.electionYear) })
  );
}

export function isMichiganDirectDonorSupportReceipt(input: {
  row: MichiganMitnLegacyContributionRow;
  electionYear: number;
}): boolean {
  return isMichiganTotalReceipt(input) && !isExcludedContributionType(input.row.contribtype);
}

// LOAN must match the same word-boundary term the exclusion regex uses, so a
// loan row can never be counted in both directContributionTotal and
// candidateLoanTotal ("Direct Contributions - Loan", "In-Kind Contributions -
// Loan" in the MiTN export).
export function isMichiganLoanReceipt(input: {
  row: MichiganMitnLegacyContributionRow;
  electionYear: number;
}): boolean {
  return isMichiganTotalReceipt(input) && /\bLOAN\b/.test(normalizeTextKey(input.row.contribtype));
}

function contributorIdentityKey(row: MichiganMitnLegacyContributionRow): string {
  const parts = [
    row.contribtype,
    row.f_name,
    row.l_name_or_org,
    row.address,
    row.city,
    row.state,
    row.zip,
  ]
    .map(normalizeTextKey)
    .filter(Boolean);
  if (parts.length > 0) {
    return parts.join("\u0000");
  }
  return normalizeTextKey(row.cont_detail_id || row.contribution_id) || "unknown";
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
  input: { categoryType: Aggregate["categoryType"]; categoryName: string; amountCents: number; contributorKey: string }
): void {
  const categoryName = input.categoryName.trim().replace(/\s+/g, " ");
  if (!categoryName) {
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
}): MichiganFinanceDirectBreakdown[] {
  const byCategory = new Map<Aggregate["categoryType"], Aggregate[]>();
  for (const aggregate of input.aggregates) {
    const list = byCategory.get(aggregate.categoryType) ?? [];
    list.push(aggregate);
    byCategory.set(aggregate.categoryType, list);
  }

  const result: MichiganFinanceDirectBreakdown[] = [];
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

export function aggregateMichiganDirectContributions(
  input: MichiganDirectContributionAggregationInput
): MichiganDirectContributionAggregationResult {
  const committeeId = normalizeId(requireNonEmpty(input.committeeId, "Michigan committee id"));
  const electionYear = normalizeMichiganMitnLegacyArchiveYear(input.electionYear);
  const maxBreakdownsPerCategory = normalizePositiveInteger(
    input.maxBreakdownsPerCategory,
    DEFAULT_MAX_BREAKDOWNS_PER_CATEGORY,
    "maxBreakdownsPerCategory"
  );
  const sourceUrl = input.sourceUrl ?? null;
  const aggregates = new Map<string, Aggregate>();
  const registryByName = input.committeeRegistryRows === undefined
    ? undefined
    : committeeRegistryByName(input.committeeRegistryRows);
  const pacDonors = new Map<string, PacDonorAggregate>();
  let matchedContributionRowCount = 0;
  let includedContributionRowCount = 0;
  let skippedContributionRowCount = 0;
  let totalReceiptsCents = 0;
  let directContributionTotalCents = 0;
  let candidateLoanTotalCents = 0;

  for (const row of input.contributionRows) {
    if (normalizeId(row.cfr_com_id) !== committeeId) {
      continue;
    }
    matchedContributionRowCount += 1;

    const amountCents = parseAmountCents(row.amount);
    if (amountCents === null || amountCents <= 0 || !isCycleYear({ rawDate: row.received_date, electionYear })) {
      skippedContributionRowCount += 1;
      continue;
    }

    totalReceiptsCents += amountCents;
    if (isMichiganLoanReceipt({ row, electionYear })) {
      candidateLoanTotalCents += amountCents;
    }
    if (!isMichiganDirectDonorSupportReceipt({ row, electionYear })) {
      skippedContributionRowCount += 1;
      continue;
    }

    includedContributionRowCount += 1;
    directContributionTotalCents += amountCents;
    const donorCommittee = registryByName?.get(normalizeTextKey([row.f_name, row.l_name_or_org].join(" ")));
    if (donorCommittee && PAC_DONOR_COMMITTEE_TYPES.has(normalizeTextKey(donorCommittee.committeeType))) {
      const donorCommitteeId = normalizeId(donorCommittee.committeeId);
      const existing = pacDonors.get(donorCommitteeId);
      if (existing) {
        existing.amountCents += amountCents;
        existing.contributionCount += 1;
      } else {
        pacDonors.set(donorCommitteeId, {
          committeeId: donorCommitteeId,
          committeeName: donorCommittee.committeeName.trim().replace(/\s+/g, " "),
          committeeType: donorCommittee.committeeType.trim().replace(/\s+/g, " "),
          amountCents,
          contributionCount: 1,
          sourceUrl,
        });
      }
    }
    const contributorKey = contributorIdentityKey(row);
    addAggregate(aggregates, {
      categoryType: "occupation",
      categoryName: row.occupation,
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
      candidateLoanTotal: centsToDollars(candidateLoanTotalCents),
      sourceUrl,
    },
    directBreakdowns: toDirectBreakdowns({
      aggregates: aggregates.values(),
      sourceUrl,
      maxBreakdownsPerCategory,
    }),
    ...(registryByName ? {
      pacDonors: [...pacDonors.values()]
        .sort((left, right) => right.amountCents - left.amountCents ||
          left.committeeName.localeCompare(right.committeeName) || left.committeeId.localeCompare(right.committeeId))
        .map(({ amountCents, ...donor }) => ({ ...donor, amount: centsToDollars(amountCents) })),
    } : {}),
    matchedContributionRowCount,
    includedContributionRowCount,
    skippedContributionRowCount,
  };
}
