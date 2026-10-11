import { firstNameVariants } from "../finance/personFirstNameNicknames.js";
import { hasMiddleNameConflict } from "../finance/personNameMiddleEvidence.js";
import type { KentuckyKrefContributionRecord } from "./kentuckyKrefClient.js";

export type KentuckyDirectContributionAggregationInput = {
  candidateName: string;
  electionDate: string;
  officeName: string;
  location?: string | null;
  contributionRecords: readonly KentuckyKrefContributionRecord[];
  sourceUrl?: string | null;
  maxBreakdownsPerCategory?: number;
  // Widen the candidate name the way link resolution does (candidateNameKeys).
  // The due sync sets it: a trusted link may have been verified through a
  // nickname ("Mike Nemes" filed as "Michael Nemes").
  expandNames?: boolean;
};

export type KentuckyDirectFinanceSummary = {
  totalReceipts: number;
  directContributionTotal: number;
  sourceUrl: string | null;
};

export type KentuckyFinanceDirectBreakdown = {
  categoryType: "occupation" | "contribution_size";
  categoryName: string;
  amount: number;
  contributorCount: number;
  sourceUrl: string | null;
};

export type KentuckyDirectContributionAggregationResult = {
  summary: KentuckyDirectFinanceSummary;
  directBreakdowns: KentuckyFinanceDirectBreakdown[];
  matchedContributionRowCount: number;
  includedContributionRowCount: number;
  skippedContributionRowCount: number;
};

type Aggregate = {
  categoryType: KentuckyFinanceDirectBreakdown["categoryType"];
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
    throw new Error(`Invalid Kentucky direct contribution aggregation ${fieldName}: ${value}`);
  }
  return normalized;
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

function officeNameKeys(value: string | null | undefined): Set<string> {
  const normalized = normalizeTextKey(value).replace(/\s*\b(EVEN|ODD)\b\s*$/, "").trim();
  const keys = new Set<string>();
  if (normalized) {
    keys.add(normalized);
  }
  if (normalized === "STATE LOWER CHAMBER LEGISLATOR" || normalized === "STATE REPRESENTATIVE") {
    keys.add("STATE LOWER CHAMBER LEGISLATOR");
    keys.add("STATE REPRESENTATIVE");
  }
  if (normalized === "STATE UPPER CHAMBER LEGISLATOR" || normalized === "STATE SENATOR") {
    keys.add("STATE UPPER CHAMBER LEGISLATOR");
    keys.add("STATE SENATOR");
  }
  return keys;
}

function locationKeys(value: string | null | undefined): Set<string> {
  const normalized = normalizeTextKey(value);
  const keys = new Set<string>();
  if (normalized) {
    keys.add(normalized);
  }
  if (normalized.includes("STATEWIDE")) {
    keys.add("STATEWIDE");
  }
  const numberMatch = /(\d+)/.exec(normalized);
  if (numberMatch?.[1]) {
    keys.add(String(Number.parseInt(numberMatch[1], 10)));
  }
  return keys;
}

function normalizePersonName(value: string | null | undefined): string {
  return normalizeTextKey(value)
    // Bare "V" is a middle initial, not a suffix (GENERATIONAL_SUFFIX_RANK in
    // finance/personNameMiddleEvidence.ts): stripping it erased middle evidence.
    .replace(/\b(JR|SR|II|III|IV)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// expandNames widens the VoteApp side only, for link resolution after the
// literal keys found nothing: KREF files the formal first name ("Michael
// Nemes" for "Mike Nemes"), the name after a leading initial ("Shane Baker"
// for "R. Shane Baker"), and joined initials ("JT Payne" for "J.T. Payne").
// KREF names are read literally (personFirstNameNicknames.ts).
function candidateNameKeys(value: string, options: { expandNames?: boolean } = {}): Set<string> {
  const trimmed = value.trim();
  const normalized = normalizePersonName(value);
  const keys = new Set<string>();
  if (normalized) {
    keys.add(normalized);
  }
  const parts = normalized.split(" ").filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1]!;
    keys.add(`${parts[0]} ${last}`);
    // A quoted call name is explicit evidence on either side:
    // KREF 'Robert "Robby" Mills' is "Robby Mills".
    for (const match of trimmed.matchAll(/["\u201c]([A-Za-z]{2,})["\u201d]/g)) {
      keys.add(`${normalizePersonName(match[1])} ${last}`);
    }
    if (options.expandNames) {
      for (const variant of firstNameVariants(parts[0]!)) {
        keys.add(`${variant} ${last}`);
      }
      const initials = parts.slice(0, -1).findIndex((part) => part.length > 1);
      const leadingInitials = initials === -1 ? parts.length - 1 : initials;
      if (leadingInitials >= 2) {
        keys.add(`${parts.slice(0, leadingInitials).join("")} ${last}`);
      } else if (leadingInitials === 1 && parts.length >= 3) {
        keys.add(`${parts[1]} ${last}`);
      }
    }
  }

  const commaParts = trimmed
    .split(",")
    .map((part) => normalizePersonName(part))
    .filter(Boolean);
  if (commaParts.length >= 2) {
    const lastName = commaParts[0] ?? "";
    const firstNames = commaParts.slice(1).join(" ").trim();
    const flipped = normalizePersonName(`${firstNames} ${lastName}`);
    if (flipped) {
      keys.add(flipped);
      const flippedParts = flipped.split(" ").filter(Boolean);
      if (flippedParts.length >= 2) {
        keys.add(`${flippedParts[0]} ${flippedParts[flippedParts.length - 1]}`);
      }
    }
  }
  return keys;
}

function nicknameFirstNamesEquivalent(candidateFirst: string, rowFirst: string): boolean {
  return candidateFirst === rowFirst || firstNameVariants(candidateFirst).includes(rowFirst);
}

function candidateNamesMatch(input: {
  candidateName: string;
  expectedKeys: ReadonlySet<string>;
  actualName: string | undefined;
  expandNames?: boolean;
}): boolean {
  let keyMatched = false;
  for (const key of candidateNameKeys(input.actualName ?? "")) {
    if (input.expectedKeys.has(key)) {
      keyMatched = true;
      break;
    }
  }
  if (!keyMatched) {
    return false;
  }
  // Key overlap collapses names to first+last, so "John A. Smith" would take
  // every contribution filed for "Smith, John B." in the same race. A
  // contradicting middle name rejects the row (georgia pattern).
  return !hasMiddleNameConflict({
    candidateName: input.candidateName,
    rowNames: [input.actualName ?? ""],
    normalizePersonName,
    firstNamesEquivalent: input.expandNames ? nicknameFirstNamesEquivalent : undefined,
  });
}

function parseDateKey(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const slashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(trimmed);
  if (slashMatch?.[1] && slashMatch[2] && slashMatch[3]) {
    return `${slashMatch[3]}-${slashMatch[1].padStart(2, "0")}-${slashMatch[2].padStart(2, "0")}`;
  }
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})\b/.exec(trimmed);
  if (isoMatch?.[1] && isoMatch[2] && isoMatch[3]) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }
  return null;
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

// Shared cycle rule for KY election-tagged rows (used by both aggregators and
// the link-resolution filter — keep it in ONE place so the copies can't
// drift): KREF tags rows to the specific election, and a Nov general
// candidate's money is mostly filed against the May PRIMARY of the same year,
// so exact-date matching zeroes out every candidate mid-cycle. Kentucky
// primaries and generals share a calendar year, so same-year rows count as
// one cycle — EXCEPT special elections, which are separate campaigns for the
// same office and only count when the target election IS that special (exact
// date match). IE records carry no electionType, so pass undefined there —
// special screening is impossible for them.
export function kentuckyElectionDateMatchesCycle(input: {
  recordElectionDate: string | undefined;
  recordElectionType: string | undefined;
  targetElectionDateKey: string;
}): boolean {
  const dateKey = parseDateKey(input.recordElectionDate);
  if (!dateKey) {
    return false;
  }
  if (dateKey === input.targetElectionDateKey) {
    return true;
  }
  if (dateKey.slice(0, 4) !== input.targetElectionDateKey.slice(0, 4)) {
    return false;
  }
  return !/SPECIAL/i.test(input.recordElectionType ?? "");
}

function recordMatchesTarget(input: {
  record: KentuckyKrefContributionRecord;
  candidateName: string;
  candidateNameKeys: ReadonlySet<string>;
  expandNames?: boolean;
  electionDateKey: string;
  officeKeys: ReadonlySet<string>;
  locationKeys: ReadonlySet<string> | null;
}): boolean {
  if (
    !candidateNamesMatch({
      candidateName: input.candidateName,
      expectedKeys: input.candidateNameKeys,
      actualName: input.record.candidateName,
      expandNames: input.expandNames,
    })
  ) {
    return false;
  }
  if (
    !kentuckyElectionDateMatchesCycle({
      recordElectionDate: input.record.electionDate,
      recordElectionType: input.record.electionType,
      targetElectionDateKey: input.electionDateKey,
    })
  ) {
    return false;
  }
  if (![...officeNameKeys(input.record.office)].some((key) => input.officeKeys.has(key))) {
    return false;
  }
  if (
    input.locationKeys !== null &&
    ![...locationKeys(input.record.location)].some((key) => input.locationKeys?.has(key))
  ) {
    return false;
  }
  return true;
}

// Cycle-scoped record filter for LINK RESOLUTION (not aggregation): matches a
// candidate's name/office/location using the same normalization the
// aggregation above uses, but accepts any election DATE within the election
// YEAR. KREF tags contributions to the specific election (a 2026 general
// candidate's money is mostly filed against the 5/19/2026 PRIMARY), so the
// aggregation's exact-date rule would see zero rows for a general-election
// candidate mid-cycle — fine for totals, wrong for identifying the candidate.
export function filterKentuckyContributionRecordsForCandidateCycle(input: {
  contributionRecords: readonly KentuckyKrefContributionRecord[];
  candidateName: string;
  electionDate: string;
  officeName: string;
  location?: string | null;
  expandNames?: boolean;
}): KentuckyKrefContributionRecord[] {
  const keys = candidateNameKeys(requireNonEmpty(input.candidateName, "Kentucky candidate name"), {
    expandNames: input.expandNames,
  });
  const officeKeys = officeNameKeys(requireNonEmpty(input.officeName, "Kentucky office name"));
  const targetLocationKeys = input.location?.trim() ? locationKeys(input.location) : null;
  const targetElectionDateKey = parseDateKey(requireNonEmpty(input.electionDate, "Kentucky election date"));
  if (!targetElectionDateKey) {
    throw new Error("Kentucky election date must use MM/DD/YYYY or YYYY-MM-DD format");
  }
  return input.contributionRecords.filter((record) => {
    if (
      !candidateNamesMatch({
        candidateName: input.candidateName,
        expectedKeys: keys,
        actualName: record.candidateName,
        expandNames: input.expandNames,
      })
    ) {
      return false;
    }
    if (
      !kentuckyElectionDateMatchesCycle({
        recordElectionDate: record.electionDate,
        recordElectionType: record.electionType,
        targetElectionDateKey,
      })
    ) {
      return false;
    }
    if (![...officeNameKeys(record.office)].some((key) => officeKeys.has(key))) {
      return false;
    }
    if (targetLocationKeys !== null && ![...locationKeys(record.location)].some((key) => targetLocationKeys.has(key))) {
      return false;
    }
    return true;
  });
}

function isIndividualDirectContribution(record: KentuckyKrefContributionRecord): boolean {
  return normalizeTextKey(record.contributorType) === "INDIVIDUAL" && normalizeTextKey(record.contributionMode) === "DIRECT";
}

function contributorIdentityKey(record: KentuckyKrefContributionRecord): string {
  const parts = [record.contributorName, record.employer, record.occupation].map(normalizeTextKey).filter(Boolean);
  return parts.length > 0 ? parts.join("\u0000") : "unknown";
}

function contributionSizeBucket(amount: number): string {
  if (amount < 1) {
    return "$0.01-$0.99";
  }
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
  input: {
    categoryType: Aggregate["categoryType"];
    categoryName: string | null | undefined;
    amountCents: number;
    contributorKey: string;
  }
): void {
  const categoryName = input.categoryName?.trim().replace(/\s+/g, " ") ?? "";
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
}): KentuckyFinanceDirectBreakdown[] {
  const byCategory = new Map<Aggregate["categoryType"], Aggregate[]>();
  for (const aggregate of input.aggregates) {
    const list = byCategory.get(aggregate.categoryType) ?? [];
    list.push(aggregate);
    byCategory.set(aggregate.categoryType, list);
  }

  const result: KentuckyFinanceDirectBreakdown[] = [];
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
        sourceUrl: input.sourceUrl,
      });
    }
  }

  return result;
}

export function aggregateKentuckyDirectContributions(
  input: KentuckyDirectContributionAggregationInput
): KentuckyDirectContributionAggregationResult {
  const keys = candidateNameKeys(requireNonEmpty(input.candidateName, "Kentucky candidate name"), {
    expandNames: input.expandNames,
  });
  const electionDateKey = parseDateKey(requireNonEmpty(input.electionDate, "Kentucky election date"));
  if (!electionDateKey) {
    throw new Error("Kentucky election date must use MM/DD/YYYY or YYYY-MM-DD format");
  }
  const officeKeys = officeNameKeys(requireNonEmpty(input.officeName, "Kentucky office name"));
  const targetLocationKeys = input.location?.trim() ? locationKeys(input.location) : null;
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

  for (const record of input.contributionRecords) {
    if (
      !recordMatchesTarget({
        record,
        candidateName: input.candidateName,
        candidateNameKeys: keys,
        expandNames: input.expandNames,
        electionDateKey,
        officeKeys,
        locationKeys: targetLocationKeys,
      })
    ) {
      continue;
    }
    matchedContributionRowCount += 1;

    const amountCents = amountToCents(record.amount);
    if (amountCents === null || amountCents <= 0) {
      skippedContributionRowCount += 1;
      continue;
    }

    totalReceiptsCents += amountCents;
    if (!isIndividualDirectContribution(record)) {
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
