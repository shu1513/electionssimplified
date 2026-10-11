import { normalizePennsylvaniaCampaignFinanceExportYear } from "./pennsylvaniaCampaignFinanceArtifactCache.js";
import type {
  PennsylvaniaCampaignFinanceContributionRow,
  PennsylvaniaCampaignFinanceFilerRow,
} from "./pennsylvaniaCampaignFinanceReader.js";

export type PennsylvaniaDirectContributionAggregationInput = {
  filerId: string;
  electionYear: number;
  contributionRows: readonly PennsylvaniaCampaignFinanceContributionRow[];
  // The filer registry (both cycle years); contributors named exactly like a
  // registered committee are reported as committee donors.
  filerRows?: readonly PennsylvaniaCampaignFinanceFilerRow[];
  sourceUrl?: string | null;
  maxBreakdownsPerCategory?: number;
};

// A political committee that gave to the candidate's committee.
export type PennsylvaniaFinancePacDonor = {
  // Registry filer id when the name matched exactly one registered
  // committee, otherwise the normalized contributor name.
  committeeId: string;
  committeeName: string;
  amount: number;
  contributionCount: number;
  sourceUrl: string | null;
};

export type PennsylvaniaDirectFinanceSummary = {
  totalReceipts: number;
  directContributionTotal: number;
  sourceUrl: string | null;
};

export type PennsylvaniaFinanceDirectBreakdown = {
  categoryType: "occupation" | "contribution_size";
  categoryName: string;
  amount: number;
  contributorCount: number;
  sourceUrl: string | null;
};

export type PennsylvaniaDirectContributionAggregationResult = {
  summary: PennsylvaniaDirectFinanceSummary;
  directBreakdowns: PennsylvaniaFinanceDirectBreakdown[];
  // Largest first. Their money is already inside the totals and breakdowns
  // above; this is a second view of the same contribution events.
  pacDonors: PennsylvaniaFinancePacDonor[];
  matchedContributionRowCount: number;
  includedContributionEventCount: number;
  skippedContributionEventCount: number;
};

export type PennsylvaniaContributionEvent = {
  rawDate: string;
  rawAmount: string;
};

type Aggregate = {
  categoryType: PennsylvaniaFinanceDirectBreakdown["categoryType"];
  categoryName: string;
  amountCents: number;
  contributorKeys: Set<string>;
};

type PacDonorAggregate = {
  committeeId: string;
  committeeName: string;
  amountCents: number;
  contributionCount: number;
};

const DEFAULT_MAX_BREAKDOWNS_PER_CATEGORY = 50;
// PA registry FILERTYPE: 1 = candidate, 2 = political committee, 3 = lobbyist.
const PENNSYLVANIA_COMMITTEE_FILER_TYPE = "2";
// A contributor with no occupation and one of these words in its name is a
// committee even when the registry does not list it (out-of-state PACs,
// national party groups, union political funds named differently).
const COMMITTEE_NAME_PATTERN = /\b(PAC|POLITICAL|COMMITTEE|COPE|UNION|ASSOCIATION|LEAGUE|COUNCIL)\b/;

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
    throw new Error(`Invalid Pennsylvania direct contribution aggregation ${fieldName}: ${normalized}`);
  }
  return normalized;
}

function normalizeId(value: string): string {
  return value.trim().toUpperCase();
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

function parsePennsylvaniaContributionDateYear(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const compactMatch = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
  if (compactMatch) {
    return Number(compactMatch[1]);
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

export function pennsylvaniaElectionCycleStartYear(electionYear: number): number {
  return normalizePennsylvaniaCampaignFinanceExportYear(electionYear) - 1;
}

function isCycleYear(input: { rawDate: string; electionYear: number }): boolean {
  const year = parsePennsylvaniaContributionDateYear(input.rawDate);
  if (year === null) {
    return false;
  }
  return year >= pennsylvaniaElectionCycleStartYear(input.electionYear) && year <= input.electionYear;
}

function contributionEventsFromRow(row: PennsylvaniaCampaignFinanceContributionRow): PennsylvaniaContributionEvent[] {
  return [
    { rawDate: row.CONTDATE1, rawAmount: row.CONTAMT1 },
    { rawDate: row.CONTDATE2, rawAmount: row.CONTAMT2 },
    { rawDate: row.CONTDATE3, rawAmount: row.CONTAMT3 },
  ].filter((event) => event.rawDate.trim().length > 0 || event.rawAmount.trim().length > 0);
}

export function isPennsylvaniaDirectContributionEvent(input: {
  event: PennsylvaniaContributionEvent;
  electionYear: number;
}): boolean {
  const amountCents = parseAmountCents(input.event.rawAmount);
  return amountCents !== null && amountCents > 0 && isCycleYear({ rawDate: input.event.rawDate, electionYear: input.electionYear });
}

function contributorIdentityKey(row: PennsylvaniaCampaignFinanceContributionRow): string {
  const parts = [
    row.CONTRIBUTOR,
    row.ADDRESS1,
    row.ADDRESS2,
    row.CITY,
    row.STATE,
    row.ZIPCODE,
    row.OCCUPATION,
    row.ENAME,
  ]
    .map(normalizeTextKey)
    .filter(Boolean);
  if (parts.length > 0) {
    return parts.join("\u0000");
  }
  return normalizeTextKey(row.CampaignFinanceID) || "unknown";
}

// Registered committees by normalized name -> their filer ids.
function indexRegisteredCommittees(filerRows: readonly PennsylvaniaCampaignFinanceFilerRow[]): Map<string, Set<string>> {
  const byNameKey = new Map<string, Set<string>>();
  for (const row of filerRows) {
    if (row.FILERTYPE.trim() !== PENNSYLVANIA_COMMITTEE_FILER_TYPE) {
      continue;
    }
    const nameKey = normalizeTextKey(row.FILERNAME);
    const filerId = normalizeId(row.FILERID);
    if (!nameKey || !filerId) {
      continue;
    }
    const filerIds = byNameKey.get(nameKey) ?? new Set<string>();
    filerIds.add(filerId);
    byNameKey.set(nameKey, filerIds);
  }
  return byNameKey;
}

// null when the contributor is not a committee.
function pacDonorIdentity(input: {
  row: PennsylvaniaCampaignFinanceContributionRow;
  registeredCommittees: Map<string, Set<string>>;
}): { committeeId: string; committeeName: string } | null {
  const committeeName = input.row.CONTRIBUTOR.trim().replace(/\s+/g, " ");
  const nameKey = normalizeTextKey(committeeName);
  if (!nameKey) {
    return null;
  }
  const filerIds = input.registeredCommittees.get(nameKey);
  if (filerIds) {
    // Two registrations sharing a name cannot be told apart: key by name.
    return { committeeId: filerIds.size === 1 ? [...filerIds][0] ?? nameKey : nameKey, committeeName };
  }
  if (!input.row.OCCUPATION.trim() && COMMITTEE_NAME_PATTERN.test(nameKey)) {
    return { committeeId: nameKey, committeeName };
  }
  return null;
}

function toPacDonors(input: { aggregates: Iterable<PacDonorAggregate>; sourceUrl: string | null }): PennsylvaniaFinancePacDonor[] {
  return [...input.aggregates]
    .sort((left, right) => right.amountCents - left.amountCents || left.committeeName.localeCompare(right.committeeName))
    .map((aggregate) => ({
      committeeId: aggregate.committeeId,
      committeeName: aggregate.committeeName,
      amount: centsToDollars(aggregate.amountCents),
      contributionCount: aggregate.contributionCount,
      sourceUrl: input.sourceUrl,
    }));
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
}): PennsylvaniaFinanceDirectBreakdown[] {
  const byCategory = new Map<Aggregate["categoryType"], Aggregate[]>();
  for (const aggregate of input.aggregates) {
    const list = byCategory.get(aggregate.categoryType) ?? [];
    list.push(aggregate);
    byCategory.set(aggregate.categoryType, list);
  }

  const result: PennsylvaniaFinanceDirectBreakdown[] = [];
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

export function aggregatePennsylvaniaDirectContributions(
  input: PennsylvaniaDirectContributionAggregationInput
): PennsylvaniaDirectContributionAggregationResult {
  const filerId = normalizeId(requireNonEmpty(input.filerId, "Pennsylvania filer id"));
  const electionYear = normalizePennsylvaniaCampaignFinanceExportYear(input.electionYear);
  const maxBreakdownsPerCategory = normalizePositiveInteger(
    input.maxBreakdownsPerCategory,
    DEFAULT_MAX_BREAKDOWNS_PER_CATEGORY,
    "maxBreakdownsPerCategory"
  );
  const sourceUrl = input.sourceUrl ?? null;
  const aggregates = new Map<string, Aggregate>();
  const registeredCommittees = indexRegisteredCommittees(input.filerRows ?? []);
  const pacDonors = new Map<string, PacDonorAggregate>();
  let matchedContributionRowCount = 0;
  let includedContributionEventCount = 0;
  let skippedContributionEventCount = 0;
  let totalReceiptsCents = 0;
  let directContributionTotalCents = 0;

  for (const row of input.contributionRows) {
    if (normalizeId(row.FilerID) !== filerId) {
      continue;
    }
    matchedContributionRowCount += 1;
    const contributorKey = contributorIdentityKey(row);
    const pacDonor = pacDonorIdentity({ row, registeredCommittees });

    for (const event of contributionEventsFromRow(row)) {
      const amountCents = parseAmountCents(event.rawAmount);
      if (
        amountCents === null ||
        amountCents <= 0 ||
        !isCycleYear({ rawDate: event.rawDate, electionYear })
      ) {
        skippedContributionEventCount += 1;
        continue;
      }

      includedContributionEventCount += 1;
      totalReceiptsCents += amountCents;
      directContributionTotalCents += amountCents;
      addAggregate(aggregates, {
        categoryType: "occupation",
        categoryName: row.OCCUPATION,
        amountCents,
        contributorKey,
      });
      addAggregate(aggregates, {
        categoryType: "contribution_size",
        categoryName: contributionSizeBucket(centsToDollars(amountCents)),
        amountCents,
        contributorKey,
      });
      if (pacDonor) {
        const existing = pacDonors.get(pacDonor.committeeId);
        if (existing) {
          existing.amountCents += amountCents;
          existing.contributionCount += 1;
        } else {
          pacDonors.set(pacDonor.committeeId, { ...pacDonor, amountCents, contributionCount: 1 });
        }
      }
    }
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
    pacDonors: toPacDonors({ aggregates: pacDonors.values(), sourceUrl }),
    matchedContributionRowCount,
    includedContributionEventCount,
    skippedContributionEventCount,
  };
}
