import { normalizePennsylvaniaCampaignFinanceExportYear } from "./pennsylvaniaCampaignFinanceArtifactCache.js";
import { normalizePennsylvaniaCandidateNameKeys } from "./pennsylvaniaCandidateCommitteeResolver.js";
import type { PennsylvaniaCampaignFinanceFilerRow } from "./pennsylvaniaCampaignFinanceReader.js";
import type { PennsylvaniaIndependentExpenditureRow } from "./pennsylvaniaIndependentExpenditureClient.js";
import type { PennsylvaniaOutsideSpendingGroup, PennsylvaniaSupportOppose } from "./pennsylvaniaOutsideGroupContributionAggregator.js";
import {
  resolvePennsylvaniaOutsideGroupFiler,
  type PennsylvaniaOutsideGroupFilerAlias,
} from "./pennsylvaniaOutsideGroupFilerResolver.js";

export type PennsylvaniaOutsideSpendingSummary = {
  supportTotal: number;
  opposeTotal: number;
  groups: PennsylvaniaOutsideSpendingGroup[];
  sourceUrl: string | null;
  electionId: string | null;
};

export type PennsylvaniaOutsideSpendingAggregationInput = {
  candidateName: string;
  electionYear: number;
  expenditureRows: readonly PennsylvaniaIndependentExpenditureRow[];
  sourceUrl?: string | null;
  electionId?: string | null;
  maxGroups?: number;
  filerRows?: readonly PennsylvaniaCampaignFinanceFilerRow[];
  aliases?: readonly PennsylvaniaOutsideGroupFilerAlias[];
};

export type PennsylvaniaOutsideSpendingAggregationResult = {
  summary: PennsylvaniaOutsideSpendingSummary | null;
  matchedExpenditureRowCount: number;
  includedExpenditureRowCount: number;
  skippedExpenditureRowCount: number;
};

type GroupAccumulator = {
  groupId: string;
  groupName: string;
  supportOppose: PennsylvaniaSupportOppose;
  amountCents: number;
};

const DEFAULT_MAX_GROUPS = 50;

function normalizePositiveInteger(value: number | undefined, fallback: number, fieldName: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Pennsylvania outside spending aggregation ${fieldName}: ${normalized}`);
  }
  return normalized;
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

function parseAmountCents(value: unknown): number | null {
  const raw = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
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

function truthyFlag(value: unknown): boolean {
  if (value === true || value === 1) {
    return true;
  }
  if (typeof value === "string") {
    return ["1", "Y", "YES", "TRUE", "T"].includes(value.trim().toUpperCase());
  }
  return false;
}

export function supportOpposeFromPennsylvaniaIndependentExpenditureRow(
  row: PennsylvaniaIndependentExpenditureRow
): PennsylvaniaSupportOppose | null {
  const supported = truthyFlag(row.IsSupported);
  const opposed = truthyFlag(row.IsOpposed);
  if (supported === opposed) {
    return null;
  }
  return supported ? "support" : "oppose";
}

function rowCandidateQuestion(row: PennsylvaniaIndependentExpenditureRow): string {
  return String(row.CandidateQuestion ?? "").trim();
}

function rowOrganization(row: PennsylvaniaIndependentExpenditureRow): string {
  return String(row.Organization ?? "").trim().replace(/\s+/g, " ");
}

// Filers write the target as "JOSH SHAPIRO", "Joshua D. Shapiro", "JOSH D
// SHAPIRO", "Josh Shapiro and Austin Davis", ... A two-token key (first +
// last) therefore also matches with one token between the names (2022:
// $1.8M of filings carried a middle initial). A surname alone never matches.
function targetMatchesCandidate(input: {
  candidateQuestion: string;
  candidateNameKeys: ReadonlySet<string>;
}): boolean {
  const target = ` ${normalizeTextKey(input.candidateQuestion)} `;
  if (!target.trim()) {
    return false;
  }
  for (const key of input.candidateNameKeys) {
    const normalizedKey = normalizeTextKey(key);
    if (!normalizedKey) {
      continue;
    }
    if (target.includes(` ${normalizedKey} `)) {
      return true;
    }
    const tokens = normalizedKey.split(" ");
    if (tokens.length === 2 && new RegExp(` ${tokens[0]} [A-Z0-9]+ ${tokens[1]} `).test(target)) {
      return true;
    }
  }
  return false;
}

function groupIdForOrganization(input: {
  organization: string;
  filerRows: readonly PennsylvaniaCampaignFinanceFilerRow[];
  aliases?: readonly PennsylvaniaOutsideGroupFilerAlias[];
}): string {
  if (input.filerRows.length > 0) {
    const resolution = resolvePennsylvaniaOutsideGroupFiler({
      organizationName: input.organization,
      filerRows: input.filerRows,
      aliases: input.aliases,
    });
    if (resolution.status === "matched") {
      return resolution.filerId;
    }
  }
  return normalizeTextKey(input.organization);
}

function groupKey(input: { groupId: string; supportOppose: PennsylvaniaSupportOppose }): string {
  return `${input.groupId.trim().toUpperCase()}\u0000${input.supportOppose}`;
}

function toGroups(input: {
  groups: Iterable<GroupAccumulator>;
  maxGroups: number;
  sourceUrl: string | null;
  electionId: string | null;
}): PennsylvaniaOutsideSpendingGroup[] {
  return [...input.groups]
    .sort(
      (left, right) =>
        right.amountCents - left.amountCents ||
        left.supportOppose.localeCompare(right.supportOppose) ||
        left.groupName.localeCompare(right.groupName)
    )
    .slice(0, input.maxGroups)
    .map((group) => ({
      groupId: group.groupId,
      groupName: group.groupName,
      supportOppose: group.supportOppose,
      amount: centsToDollars(group.amountCents),
      sourceUrl: input.sourceUrl,
      electionId: input.electionId,
    }));
}

export function aggregatePennsylvaniaOutsideSpending(
  input: PennsylvaniaOutsideSpendingAggregationInput
): PennsylvaniaOutsideSpendingAggregationResult {
  normalizePennsylvaniaCampaignFinanceExportYear(input.electionYear);
  const maxGroups = normalizePositiveInteger(input.maxGroups, DEFAULT_MAX_GROUPS, "maxGroups");
  // Filers write the target as they please ("JOSH SHAPIRO FOR GOVERNOR",
  // "JOSHUA SHAPIRO"), so VoteApp-side nickname keys are matched too.
  const candidateNameKeys = normalizePennsylvaniaCandidateNameKeys(input.candidateName, { expandNicknames: true });
  if (candidateNameKeys.size === 0) {
    return {
      summary: null,
      matchedExpenditureRowCount: 0,
      includedExpenditureRowCount: 0,
      skippedExpenditureRowCount: 0,
    };
  }

  const groups = new Map<string, GroupAccumulator>();
  const filerRows = input.filerRows ?? [];
  const sourceUrl = input.sourceUrl ?? null;
  const electionId = input.electionId?.trim() || null;
  let supportTotalCents = 0;
  let opposeTotalCents = 0;
  let matchedExpenditureRowCount = 0;
  let includedExpenditureRowCount = 0;
  let skippedExpenditureRowCount = 0;

  for (const row of input.expenditureRows) {
    if (
      !targetMatchesCandidate({
        candidateQuestion: rowCandidateQuestion(row),
        candidateNameKeys,
      })
    ) {
      continue;
    }
    matchedExpenditureRowCount += 1;

    const supportOppose = supportOpposeFromPennsylvaniaIndependentExpenditureRow(row);
    const organization = rowOrganization(row);
    const amountCents = parseAmountCents(row.Amount);
    if (!supportOppose || !organization || amountCents === null || amountCents <= 0) {
      skippedExpenditureRowCount += 1;
      continue;
    }

    const groupId = groupIdForOrganization({
      organization,
      filerRows,
      aliases: input.aliases,
    });
    if (!groupId) {
      skippedExpenditureRowCount += 1;
      continue;
    }

    includedExpenditureRowCount += 1;
    if (supportOppose === "support") {
      supportTotalCents += amountCents;
    } else {
      opposeTotalCents += amountCents;
    }

    const key = groupKey({ groupId, supportOppose });
    const existing = groups.get(key);
    if (existing) {
      existing.amountCents += amountCents;
      continue;
    }
    groups.set(key, {
      groupId,
      groupName: organization,
      supportOppose,
      amountCents,
    });
  }

  const grouped = toGroups({
    groups: groups.values(),
    maxGroups,
    sourceUrl,
    electionId,
  });
  if (grouped.length === 0) {
    return {
      summary: null,
      matchedExpenditureRowCount,
      includedExpenditureRowCount,
      skippedExpenditureRowCount,
    };
  }

  return {
    summary: {
      supportTotal: centsToDollars(supportTotalCents),
      opposeTotal: centsToDollars(opposeTotalCents),
      groups: grouped,
      sourceUrl,
      electionId,
    },
    matchedExpenditureRowCount,
    includedExpenditureRowCount,
    skippedExpenditureRowCount,
  };
}
