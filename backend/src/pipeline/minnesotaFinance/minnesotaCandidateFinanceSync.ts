import type { Pool, PoolClient } from "pg";

import { resolveMinnesotaCandidateCommittee, normalizeMinnesotaCandidateNameForStorage } from "./minnesotaCandidateCommitteeResolver.js";
import {
  aggregateMinnesotaOutsideGroupContributions,
  type MinnesotaFinanceOutsideGroupInput,
} from "./minnesotaOutsideGroupContributionAggregator.js";
import {
  replaceMinnesotaCandidateFinanceSnapshot,
  type MinnesotaFinanceLinkInput,
  type MinnesotaFinanceSummaryInput,
} from "./minnesotaFinanceWriter.js";
import type { MinnesotaCandidateFinancialSummary } from "./minnesotaCandidateFinancialSummaryClient.js";
import type { MinnesotaCampaignFinanceCsvRow } from "./minnesotaCampaignFinanceArtifactReader.js";
import { aggregateMinnesotaReportedCommitteeCash, MinnesotaReportedCommitteeCashHoldError } from "./minnesotaReportedCommitteeCashAggregator.js";
import type { MinnesotaCommitteeCashSnapshot } from "./minnesotaCommitteeCashWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type MinnesotaCandidateFinanceSyncInput = {
  db: Queryable;
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district?: string | null;
  contributionRows: readonly MinnesotaCampaignFinanceCsvRow[];
  expenditureRows?: readonly MinnesotaCampaignFinanceCsvRow[];
  outsideContributionRows?: readonly MinnesotaCampaignFinanceCsvRow[];
  sourceUrl?: string | null;
  contributionSourceUrl?: string | null;
  reportedCommitteeCashSource?: MinnesotaCommitteeCashSnapshot["source"];
  expenditureSourceUrl?: string | null;
  outsideSourceUrl?: string | null;
  financialSummary?: MinnesotaCandidateFinancialSummary;
  now?: Date;
  dryRun?: boolean;
  outsideMaxGroups?: number;
  outsideMaxBreakdownsPerCategory?: number;
  trustedCommittee?: {
    committeeId: string;
    committeeName: string;
    sourceUrl?: string | null;
  };
};

export type MinnesotaCandidateFinanceSyncResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  dryRun: boolean;
  resolution:
    | ReturnType<typeof resolveMinnesotaCandidateCommittee>
    | {
        status: "matched";
        committeeId: string;
        committeeName: string;
        confidence: "exact";
        source: "mn_board_viewer";
        sourceUrl: string | null;
        matchedCandidateRowCount: number;
      };
  linkWritten: boolean;
  summaryWritten: boolean;
  directBreakdownsWritten: number;
  outsideGroupsWritten: number;
  outsideGroupBreakdownsWritten: number;
  totalReceipts: number | null;
  directContributionTotal: number | null;
  totalDisbursements: number | null;
  outsideSupportTotal: number | null;
  outsideOpposeTotal: number | null;
  matchedContributionRowCount: number;
  includedContributionRowCount: number;
  skippedContributionRowCount: number;
  matchedOutsideExpenditureRowCount: number;
  includedOutsideExpenditureRowCount: number;
  skippedOutsideExpenditureRowCount: number;
  matchedOutsideContributionRowCount: number;
  includedOutsideContributionRowCount: number;
  skippedOutsideContributionRowCount: number;
  reportedCommitteeCashStatus: "unavailable" | "held" | "ready";
  reportedCommitteeCashDonorsWritten: number;
  reportedCommitteeCashTotal: number | null;
  excludedUnknownClassRowCount: number;
};

function requireNonEmpty(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmed;
}

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new Error(`Invalid Minnesota finance election year: ${value}`);
  }
  return value;
}

function normalizePositiveInteger(value: number | undefined, fallback: number, fieldName: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Minnesota finance ${fieldName}: ${normalized}`);
  }
  return normalized;
}

function normalizeTimestamp(value: Date | undefined): Date {
  const normalized = value ?? new Date();
  if (Number.isNaN(normalized.getTime())) {
    throw new Error("Invalid Minnesota finance sync timestamp");
  }
  return normalized;
}

function firstNonEmpty(row: MinnesotaCampaignFinanceCsvRow, keys: readonly string[]): string {
  for (const key of keys) {
    const value = row[key]?.trim() ?? "";
    if (value) {
      return value;
    }
  }
  return "";
}

function parseAmountCents(raw: string): number | null {
  const normalized = raw.replace(/[$,]/g, "").trim();
  if (!normalized || !/^-?(?:\d+|\d*\.\d{1,4})$/.test(normalized)) {
    return null;
  }
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) {
    return null;
  }
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

function parseYearFromText(raw: string): number | null {
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
  const yearMatch = /^(\d{4})$/.exec(trimmed);
  if (yearMatch) {
    return Number(yearMatch[1]);
  }
  return null;
}

function isCycleYear(input: { row: MinnesotaCampaignFinanceCsvRow; electionYear: number }): boolean {
  const rawYear = firstNonEmpty(input.row, ["Year", "Election Year", "electionYear", "election_year"]);
  const parsedYear = rawYear
    ? Number(rawYear)
    : parseYearFromText(firstNonEmpty(input.row, ["Receipt date", "Date", "Received date"]));
  return (
    parsedYear !== null &&
    Number.isInteger(parsedYear) &&
    parsedYear >= input.electionYear - 1 &&
    parsedYear <= input.electionYear
  );
}

function resolveTrustedCommittee(input: {
  committeeId: string;
  committeeName: string;
  sourceUrl?: string | null;
}): ReturnType<typeof resolveMinnesotaCandidateCommittee> {
  return {
    status: "matched",
    committeeId: requireNonEmpty(input.committeeId, "trusted Minnesota committee id"),
    committeeName: requireNonEmpty(input.committeeName, "trusted Minnesota committee name"),
    confidence: "exact",
    source: "mn_board_viewer",
    sourceUrl: input.sourceUrl ?? null,
    matchedCandidateRowCount: 0,
  };
}

function toFinanceLink(input: {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeName: string;
  district?: string | null;
  committeeId: string;
  committeeName: string;
  sourceUrl?: string | null;
  verifiedAt: Date;
}): MinnesotaFinanceLinkInput {
  return {
    candidateId: requireNonEmpty(input.candidateId, "candidate id"),
    electionId: requireNonEmpty(input.electionId, "election id"),
    electionYear: input.electionYear,
    candidateNameNormalized: normalizeMinnesotaCandidateNameForStorage(input.candidateName),
    officeName: requireNonEmpty(input.officeName, "office name"),
    district: input.district ?? null,
    committeeId: requireNonEmpty(input.committeeId, "Minnesota committee id"),
    committeeName: requireNonEmpty(input.committeeName, "Minnesota committee name"),
    linkStatus: "active",
    linkSource: "mn_board",
    sourceUrl: input.sourceUrl ?? null,
    lastVerifiedAt: input.verifiedAt,
  };
}

function supportOpposeFromForAgainst(value: string): "support" | "oppose" | null {
  const normalized = value.trim().toUpperCase();
  if (normalized.startsWith("FOR")) {
    return "support";
  }
  if (normalized.startsWith("AGAINST") || normalized.startsWith("OPPOSE")) {
    return "oppose";
  }
  return null;
}

function isMinnesotaIndependentExpenditureRow(row: MinnesotaCampaignFinanceCsvRow): boolean {
  const kind = [
    firstNonEmpty(row, ["Type", "Spender sub-type"]),
    firstNonEmpty(row, ["Purpose"]),
  ]
    .filter(Boolean)
    .join(" ")
    .toUpperCase();
  return kind.includes("INDEPENDENT EXPENDITURE");
}

function buildMinnesotaOutsideGroupsFromExpenditures(input: {
  expenditureRows: readonly MinnesotaCampaignFinanceCsvRow[];
  committeeId: string;
  electionYear: number;
  sourceUrl?: string | null;
}): {
  outsideGroups: MinnesotaFinanceOutsideGroupInput[];
  matchedOutsideExpenditureRowCount: number;
  includedOutsideExpenditureRowCount: number;
  skippedOutsideExpenditureRowCount: number;
} {
  const normalizedCommitteeId = input.committeeId.trim().toUpperCase();
  const groups = new Map<string, { committeeId: string; committeeName: string; supportOppose: "support" | "oppose"; amountCents: number; sourceUrl: string | null }>();
  let matchedOutsideExpenditureRowCount = 0;
  let includedOutsideExpenditureRowCount = 0;
  let skippedOutsideExpenditureRowCount = 0;

  for (const row of input.expenditureRows) {
    const affectedCommitteeId = firstNonEmpty(row, ["Affected Cmte Reg Num", "Affected Committee Reg Num", "Affected Cmte ID"]);
    if (!affectedCommitteeId || affectedCommitteeId.trim().toUpperCase() !== normalizedCommitteeId) {
      continue;
    }
    matchedOutsideExpenditureRowCount += 1;

    if (!isCycleYear({ row, electionYear: input.electionYear }) || !isMinnesotaIndependentExpenditureRow(row)) {
      skippedOutsideExpenditureRowCount += 1;
      continue;
    }

    const supportOppose = supportOpposeFromForAgainst(firstNonEmpty(row, ["For /Against", "For/Against", "For Against"]));
    const committeeKey = firstNonEmpty(row, ["Spender Reg Num", "Spender reg num", "Spender ID"]);
    const committeeName = firstNonEmpty(row, ["Spender", "Spender Name"]);
    const amountCents = parseAmountCents(firstNonEmpty(row, ["Amount", "amount", "Transaction Amount"]));

    if (!supportOppose || !committeeKey || !committeeName || amountCents === null || amountCents <= 0) {
      skippedOutsideExpenditureRowCount += 1;
      continue;
    }

    includedOutsideExpenditureRowCount += 1;
    const key = `${committeeKey.trim().toUpperCase()}\u0000${supportOppose}`;
    const existing = groups.get(key);
    if (existing) {
      existing.amountCents += amountCents;
      continue;
    }

    groups.set(key, {
      committeeId: committeeKey.trim(),
      committeeName,
      supportOppose,
      amountCents,
      sourceUrl: input.sourceUrl ?? null,
    });
  }

  return {
    outsideGroups: [...groups.values()].map(({ amountCents, ...group }) => ({
      committeeId: group.committeeId,
      committeeName: group.committeeName,
      supportOppose: group.supportOppose,
      amount: amountCents / 100,
      sourceUrl: group.sourceUrl,
    })),
    matchedOutsideExpenditureRowCount,
    includedOutsideExpenditureRowCount,
    skippedOutsideExpenditureRowCount,
  };
}

export async function syncMinnesotaCandidateFinance(
  input: MinnesotaCandidateFinanceSyncInput
): Promise<MinnesotaCandidateFinanceSyncResult> {
  const candidateId = requireNonEmpty(input.candidateId, "candidate id");
  const electionId = requireNonEmpty(input.electionId, "election id");
  const candidateName = requireNonEmpty(input.candidateName, "candidate name");
  const officeScope = requireNonEmpty(input.officeScope, "office scope");
  const officeName = requireNonEmpty(input.officeName, "office name");
  const electionYear = normalizeElectionYear(input.electionYear);
  const syncedAt = normalizeTimestamp(input.now);

  const resolution = input.trustedCommittee
    ? resolveTrustedCommittee(input.trustedCommittee)
    : resolveMinnesotaCandidateCommittee({
        candidateName,
        officeScope,
        officeName,
        electionYear,
        district: input.district,
        candidateRows: input.contributionRows,
        sourceUrl: input.sourceUrl ?? input.contributionSourceUrl ?? null,
      });

  if (resolution.status !== "matched") {
    return {
      candidateId,
      electionId,
      electionYear,
      dryRun: input.dryRun === true,
      resolution,
      linkWritten: false,
      summaryWritten: false,
      directBreakdownsWritten: 0,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
      totalReceipts: null,
      directContributionTotal: null,
      totalDisbursements: null,
      outsideSupportTotal: null,
      outsideOpposeTotal: null,
      matchedContributionRowCount: 0,
      includedContributionRowCount: 0,
      skippedContributionRowCount: 0,
      matchedOutsideExpenditureRowCount: 0,
      includedOutsideExpenditureRowCount: 0,
      skippedOutsideExpenditureRowCount: 0,
      matchedOutsideContributionRowCount: 0,
      includedOutsideContributionRowCount: 0,
      skippedOutsideContributionRowCount: 0,
      reportedCommitteeCashStatus: "unavailable",
      reportedCommitteeCashDonorsWritten: 0,
      reportedCommitteeCashTotal: null,
      excludedUnknownClassRowCount: 0,
    };
  }

  if (
    input.financialSummary &&
    (input.financialSummary.committeeId.trim().toUpperCase() !== resolution.committeeId.trim().toUpperCase() ||
      input.financialSummary.electionYear !== electionYear)
  ) {
    throw new Error(
      `Minnesota financial summary identity mismatch for committee ${resolution.committeeId} and election ${electionYear}`
    );
  }

  const outsideGroupCandidateData =
    input.expenditureRows !== undefined
      ? buildMinnesotaOutsideGroupsFromExpenditures({
          expenditureRows: input.expenditureRows,
          committeeId: resolution.committeeId,
          electionYear,
          sourceUrl: input.expenditureSourceUrl ?? input.sourceUrl ?? resolution.sourceUrl ?? null,
        })
      : {
          outsideGroups: [] as MinnesotaFinanceOutsideGroupInput[],
          matchedOutsideExpenditureRowCount: 0,
          includedOutsideExpenditureRowCount: 0,
          skippedOutsideExpenditureRowCount: 0,
        };

  const maxOutsideGroups = normalizePositiveInteger(input.outsideMaxGroups, 20, "outside max groups");
  const selectedOutsideGroups = [...outsideGroupCandidateData.outsideGroups]
    .sort((left, right) => right.amount - left.amount || left.committeeId.localeCompare(right.committeeId))
    .slice(0, maxOutsideGroups);

  const outsideFinance =
    input.outsideContributionRows !== undefined
      ? aggregateMinnesotaOutsideGroupContributions({
          electionYear,
          outsideGroups: selectedOutsideGroups,
          contributionRows: input.outsideContributionRows,
          sourceUrl: input.outsideSourceUrl ?? input.sourceUrl ?? null,
          maxBreakdownsPerCategory: input.outsideMaxBreakdownsPerCategory,
        })
      : {
          outsideGroupBreakdowns: [],
          matchedContributionRowCount: 0,
          includedContributionRowCount: 0,
          skippedContributionRowCount: 0,
        };

  const outsideGroups =
    input.expenditureRows !== undefined ? selectedOutsideGroups : undefined;
  const outsideGroupBreakdowns =
    input.outsideContributionRows !== undefined ? outsideFinance.outsideGroupBreakdowns : undefined;

  const outsideSupportTotal =
    input.expenditureRows !== undefined
      ? outsideGroupCandidateData.outsideGroups
          .filter((group) => group.supportOppose === "support")
          .reduce((sum, group) => sum + group.amount, 0)
      : null;
  const outsideOpposeTotal =
    input.expenditureRows !== undefined
      ? outsideGroupCandidateData.outsideGroups
          .filter((group) => group.supportOppose === "oppose")
          .reduce((sum, group) => sum + group.amount, 0)
      : null;
  const summary: MinnesotaFinanceSummaryInput = {
    totalReceipts: input.financialSummary?.totalReceipts ?? null,
    directContributionTotal: input.financialSummary?.directContributionTotal ?? null,
    totalDisbursements: input.financialSummary?.totalDisbursements ?? null,
    outsideSupportTotal,
    outsideOpposeTotal,
    sourceUrl:
      input.financialSummary?.sourceUrl ??
      input.expenditureSourceUrl ??
      input.sourceUrl ??
      resolution.sourceUrl ??
      null,
  };

  let reportedCommitteeCash: MinnesotaCommitteeCashSnapshot | undefined;
  let reportedCommitteeCashStatus: MinnesotaCandidateFinanceSyncResult["reportedCommitteeCashStatus"] = "unavailable";
  if (input.reportedCommitteeCashSource) {
    try {
      reportedCommitteeCash = {
        aggregate: aggregateMinnesotaReportedCommitteeCash({
          rows: input.contributionRows, committeeId: resolution.committeeId, electionYear,
        }),
        source: input.reportedCommitteeCashSource,
      };
      reportedCommitteeCashStatus = "ready";
    } catch (error) {
      if (!(error instanceof MinnesotaReportedCommitteeCashHoldError)) throw error;
      reportedCommitteeCashStatus = "held";
      console.warn(error.message);
    }
  }

  if (!input.dryRun) {
    await replaceMinnesotaCandidateFinanceSnapshot({
      db: input.db,
      link: toFinanceLink({
        candidateId,
        electionId,
        candidateName,
        electionYear,
        officeName,
        district: input.district,
        committeeId: resolution.committeeId,
        committeeName: resolution.committeeName,
        sourceUrl: summary.sourceUrl,
        verifiedAt: syncedAt,
      }),
      syncedAt,
      summary,
      outsideGroups,
      outsideGroupBreakdowns,
      reportedCommitteeCash,
    });
  }

  return {
    candidateId,
    electionId,
    electionYear,
    dryRun: input.dryRun === true,
    resolution,
    linkWritten: !input.dryRun,
    summaryWritten: !input.dryRun,
    directBreakdownsWritten: 0,
    outsideGroupsWritten: input.dryRun ? 0 : outsideGroups?.length ?? 0,
    outsideGroupBreakdownsWritten: input.dryRun ? 0 : outsideGroupBreakdowns?.length ?? 0,
    totalReceipts: summary.totalReceipts ?? null,
    directContributionTotal: summary.directContributionTotal ?? null,
    totalDisbursements: summary.totalDisbursements ?? null,
    outsideSupportTotal,
    outsideOpposeTotal,
    matchedContributionRowCount: reportedCommitteeCash?.aggregate.matchedContributionRowCount ?? 0,
    includedContributionRowCount: reportedCommitteeCash?.aggregate.includedContributionRowCount ?? 0,
    skippedContributionRowCount: reportedCommitteeCash?.aggregate.excludedContributionRowCount ?? 0,
    matchedOutsideExpenditureRowCount: outsideGroupCandidateData.matchedOutsideExpenditureRowCount,
    includedOutsideExpenditureRowCount: outsideGroupCandidateData.includedOutsideExpenditureRowCount,
    skippedOutsideExpenditureRowCount: outsideGroupCandidateData.skippedOutsideExpenditureRowCount,
    matchedOutsideContributionRowCount: outsideFinance.matchedContributionRowCount,
    includedOutsideContributionRowCount: outsideFinance.includedContributionRowCount,
    skippedOutsideContributionRowCount: outsideFinance.skippedContributionRowCount,
    reportedCommitteeCashStatus,
    reportedCommitteeCashDonorsWritten: input.dryRun ? 0 : reportedCommitteeCash?.aggregate.donors.length ?? 0,
    reportedCommitteeCashTotal: reportedCommitteeCash ? reportedCommitteeCash.aggregate.totalAmountCents / 100 : null,
    excludedUnknownClassRowCount: reportedCommitteeCash?.aggregate.excludedUnknownClassRowCount ?? 0,
  };
}
