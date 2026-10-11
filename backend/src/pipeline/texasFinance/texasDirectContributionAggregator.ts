import type { TexasTecContributionRow, TexasTecFilerRow } from "./texasTecCsvDatabaseReader.js";

export type TexasDirectContributionAggregationInput = {
  committeeId: string;
  committeeIds?: readonly string[];
  electionYear: number;
  contributionRows: readonly TexasTecContributionRow[];
  committeeRegistryRows?: readonly TexasTecFilerRow[];
  sourceUrl?: string | null;
  maxBreakdownsPerCategory?: number;
};

export type TexasDirectFinanceSummary = {
  totalReceipts: number;
  directContributionTotal: number;
  sourceUrl: string | null;
};

export type TexasFinanceDirectBreakdown = {
  categoryType: "occupation" | "contribution_size";
  categoryName: string;
  amount: number;
  contributorCount: number;
  sourceUrl: string | null;
};

export type TexasDirectContributionAggregationResult = {
  summary: TexasDirectFinanceSummary;
  pacDonors?: TexasFinancePacDonor[];
  directBreakdowns: TexasFinanceDirectBreakdown[];
  matchedContributionRowCount: number;
  includedContributionRowCount: number;
  skippedContributionRowCount: number;
};


export type TexasFinancePacDonor = {
  committeeId: string;
  committeeName: string;
  committeeType: string;
  totalAmount: number;
  contributionCount: number;
  sourceUrl: string | null;
};

const PAC_COMMITTEE_TYPES = new Set(["GPAC", "MPAC", "SPAC", "JSPC", "SCPC", "CEC", "MCEC", "PTYCORP", "LEG"]);

function committeeRegistryByName(rows: readonly TexasTecFilerRow[]): Map<string, Map<string, TexasTecFilerRow>> {
  const names = new Map<string, Map<string, TexasTecFilerRow>>();
  for (const row of rows) {
    // Preserve excluded and historical identities while establishing uniqueness.
    const identity = JSON.stringify([normalizeId(row.filerIdent), normalizeId(row.filerTypeCd)]);
    for (const alias of [row.filerName, row.filerNameOrganization]) {
      const key = normalizeTextKey(alias);
      if (!key) continue;
      const identities = names.get(key) ?? new Map<string, TexasTecFilerRow>();
      if (!identities.has(identity)) identities.set(identity, row);
      names.set(key, identities);
    }
  }
  return names;
}

function pacDonorIdentity(row: TexasTecContributionRow, names: ReturnType<typeof committeeRegistryByName>): {
  committeeId: string; committeeName: string; committeeType: string;
} | null {
  const donorName = row.contributorNameOrganization.trim() ||
    [row.contributorNameFirst, row.contributorNameLast].map((name) => name.trim()).filter(Boolean).join(" ");
  if (!donorName) return null;
  const flag = (row.contributorOosPacFlag ?? "").trim().toUpperCase();
  const fecId = (row.contributorPacFein ?? "").trim().toUpperCase();
  if (flag === "Y" && /^C[0-9]{8}$/.test(fecId)) {
    return { committeeId: `fec:${fecId}`, committeeName: donorName, committeeType: "OOS_PAC" };
  }
  // Contradictory/incomplete explicit OOS evidence must remain unresolved.
  if (fecId || (flag && flag !== "N")) return null;
  const identities = names.get(normalizeTextKey(donorName));
  if (identities?.size !== 1) return null;
  const committee = identities.values().next().value as TexasTecFilerRow;
  const committeeId = committee.filerIdent.trim();
  const committeeType = committee.filerTypeCd.trim().toUpperCase();
  if (!committeeId || !PAC_COMMITTEE_TYPES.has(committeeType)) return null;
  return { committeeId, committeeName: committee.filerNameOrganization.trim() || committee.filerName.trim(), committeeType };
}

function currentReceiptFingerprint(row: TexasTecContributionRow, amountCents: number): string {
  // IDs persist across report copies. Filing metadata does not create new money.
  const economicFields = Object.entries(row)
    .filter(([field]) => !["reportInfoIdent", "receivedDt", "infoOnlyFlag", "contributionAmount"].includes(field))
    .filter(([, value]) => value?.trim())
    .map(([field, value]) => [field, value.trim()])
    .sort(([left], [right]) => left!.localeCompare(right!));
  return JSON.stringify([amountCents, economicFields]);
}

type Aggregate = {
  categoryType: TexasFinanceDirectBreakdown["categoryType"];
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
  if (!Number.isInteger(value) || value < 2014 || value > 2100) {
    throw new Error(`Invalid Texas direct contribution aggregation election year: ${value}`);
  }
  return value;
}

function normalizePositiveInteger(value: number | undefined, fallback: number, fieldName: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Texas direct contribution aggregation ${fieldName}: ${value}`);
  }
  return normalized;
}

function normalizeId(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeCommitteeIds(input: { committeeId: string; committeeIds?: readonly string[] }): {
  primaryCommitteeId: string;
  committeeIds: Set<string>;
} {
  const primaryCommitteeId = normalizeId(requireNonEmpty(input.committeeId, "Texas committee id"));
  const committeeIds = new Set<string>();
  committeeIds.add(primaryCommitteeId);
  for (const committeeId of input.committeeIds ?? []) {
    const normalized = normalizeId(committeeId);
    if (normalized) {
      committeeIds.add(normalized);
    }
  }
  return { primaryCommitteeId, committeeIds };
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
  if (normalized.length === 0 || !/^-?\d+(?:\.\d{1,4})?$/.test(normalized)) {
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

function parseTexasTecDateYear(raw: string): number | null {
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

export function texasElectionCycleStartYear(electionYear: number): number {
  return normalizeElectionYear(electionYear) - 1;
}

function isCycleYear(input: { rawDate: string; electionYear: number }): boolean {
  const year = parseTexasTecDateYear(input.rawDate);
  if (year === null) {
    return false;
  }
  return year >= texasElectionCycleStartYear(input.electionYear) && year <= input.electionYear;
}

function isCandidateOfficeholderContribution(row: TexasTecContributionRow): boolean {
  return normalizeTextKey(row.filerTypeCd) === "COH";
}

function isInfoOnly(row: TexasTecContributionRow): boolean {
  const normalized = normalizeTextKey(row.infoOnlyFlag);
  return normalized === "Y" || normalized === "YES" || normalized === "TRUE" || normalized === "1";
}

export function isTexasTotalReceipt(input: { row: TexasTecContributionRow; electionYear: number }): boolean {
  const amountCents = parseAmountCents(input.row.contributionAmount);
  return (
    amountCents !== null &&
    amountCents > 0 &&
    !isInfoOnly(input.row) &&
    isCandidateOfficeholderContribution(input.row) &&
    isCycleYear({
      rawDate: input.row.contributionDt,
      electionYear: normalizeElectionYear(input.electionYear),
    })
  );
}

export function isTexasDirectDonorSupportReceipt(input: {
  row: TexasTecContributionRow;
  electionYear: number;
}): boolean {
  return isTexasTotalReceipt(input);
}

function contributorIdentityKey(row: TexasTecContributionRow): string {
  const parts = [
    row.contributorPersentTypeCd,
    row.contributorNameOrganization,
    row.contributorNameLast,
    row.contributorNameFirst,
    row.contributorStreetStateCd,
    row.contributorEmployer,
    row.contributorOccupation,
  ]
    .map(normalizeTextKey)
    .filter(Boolean);
  if (parts.length > 0) {
    return parts.join("\u0000");
  }
  return normalizeTextKey(row.contributionInfoId) || "unknown";
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
}): TexasFinanceDirectBreakdown[] {
  const byCategory = new Map<Aggregate["categoryType"], Aggregate[]>();
  for (const aggregate of input.aggregates) {
    const list = byCategory.get(aggregate.categoryType) ?? [];
    list.push(aggregate);
    byCategory.set(aggregate.categoryType, list);
  }

  const result: TexasFinanceDirectBreakdown[] = [];
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

export function aggregateTexasDirectContributions(
  input: TexasDirectContributionAggregationInput
): TexasDirectContributionAggregationResult {
  const { primaryCommitteeId, committeeIds } = normalizeCommitteeIds({
    committeeId: input.committeeId,
    committeeIds: input.committeeIds,
  });
  const electionYear = normalizeElectionYear(input.electionYear);
  const maxBreakdownsPerCategory = normalizePositiveInteger(
    input.maxBreakdownsPerCategory,
    DEFAULT_MAX_BREAKDOWNS_PER_CATEGORY,
    "maxBreakdownsPerCategory"
  );
  const sourceUrl = input.sourceUrl ?? null;
  const aggregates = new Map<string, Aggregate>();
  const registryNames = input.committeeRegistryRows === undefined ? undefined : committeeRegistryByName(input.committeeRegistryRows);
  const pacDonors = new Map<string, TexasFinancePacDonor & { amountCents: number }>();
  const currentReceipts = new Map<string, string>();
  let matchedContributionRowCount = 0;
  let includedContributionRowCount = 0;
  let skippedContributionRowCount = 0;
  let totalReceiptsCents = 0;
  let directContributionTotalCents = 0;

  for (const row of input.contributionRows) {
    const rowCommitteeId = normalizeId(row.filerIdent);
    if (!committeeIds.has(rowCommitteeId)) {
      continue;
    }
    matchedContributionRowCount += 1;

    const amountCents = parseAmountCents(row.contributionAmount);
    if (
      amountCents === null ||
      amountCents <= 0 ||
      (rowCommitteeId === primaryCommitteeId && !isCandidateOfficeholderContribution(row)) ||
      isInfoOnly(row) ||
      !isCycleYear({ rawDate: row.contributionDt, electionYear })
    ) {
      skippedContributionRowCount += 1;
      continue;
    }

    const receiptId = requireNonEmpty(row.contributionInfoId, "Texas current contribution id");
    const receiptKey = JSON.stringify([rowCommitteeId, receiptId]);
    const fingerprint = currentReceiptFingerprint(row, amountCents);
    const previous = currentReceipts.get(receiptKey);
    if (previous !== undefined) {
      if (previous !== fingerprint) throw new Error(`Conflicting current Texas receipt: ${rowCommitteeId}:${receiptId}`);
      skippedContributionRowCount += 1;
      continue;
    }
    currentReceipts.set(receiptKey, fingerprint);
    totalReceiptsCents += amountCents;
    if (rowCommitteeId === primaryCommitteeId && !isTexasDirectDonorSupportReceipt({ row, electionYear })) {
      skippedContributionRowCount += 1;
      continue;
    }

    includedContributionRowCount += 1;
    directContributionTotalCents += amountCents;
    if (registryNames !== undefined) {
      const donor = pacDonorIdentity(row, registryNames);
      if (donor) {
        const key = JSON.stringify([donor.committeeId, donor.committeeType]);
        const existing = pacDonors.get(key);
        if (existing) {
          existing.amountCents += amountCents;
          existing.contributionCount += 1;
        } else pacDonors.set(key, { ...donor, totalAmount: 0, amountCents, contributionCount: 1, sourceUrl });
      }
    }
    const contributorKey = contributorIdentityKey(row);
    addAggregate(aggregates, {
      categoryType: "occupation",
      categoryName: row.contributorOccupation,
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
    ...(registryNames !== undefined ? { pacDonors: [...pacDonors.values()]
      .map(({ amountCents, ...donor }) => ({ ...donor, totalAmount: centsToDollars(amountCents) }))
      .sort((left, right) => right.totalAmount - left.totalAmount || left.committeeId.localeCompare(right.committeeId)) } : {}),
    matchedContributionRowCount,
    includedContributionRowCount,
    skippedContributionRowCount,
  };
}
