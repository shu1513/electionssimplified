import type { Pool, PoolClient } from "pg";

import {
  aggregateConnecticutDirectContributions,
  type ConnecticutDirectContributionAggregationResult,
  type ConnecticutFinanceCommitteeRegistryEntry,
} from "./connecticutDirectContributionAggregator.js";
import type { ConnecticutEcrisArtifactRow } from "./connecticutEcrisArtifactReader.js";
import type { ConnecticutEcrisIndependentExpenditureRow } from "./connecticutEcrisIndependentExpenditureParsers.js";
import {
  normalizeConnecticutCandidateNameKeys,
  resolveConnecticutCandidateCommittee,
  type ConnecticutCandidateCommitteeResolution,
} from "./connecticutCandidateCommitteeResolver.js";
import {
  replaceConnecticutCandidateFinanceSnapshot,
  type ConnecticutFinanceLinkInput,
} from "./connecticutFinanceWriter.js";
import {
  aggregateConnecticutOutsideSpending,
  type ConnecticutOutsideSpendingAggregationResult,
} from "./connecticutOutsideSpendingAggregator.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type ConnecticutCandidateFinanceSyncInput = {
  db: Queryable;
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeName: string;
  district?: string | null;
  receiptRows: readonly ConnecticutEcrisArtifactRow[];
  committeeRegistry?: readonly ConnecticutFinanceCommitteeRegistryEntry[];
  sourceUrl?: string | null;
  receiptSourceUrl?: string | null;
  /**
   * The year's SEEC Form 40 independent-expenditure lines. Omit when the
   * yearly artifact is unavailable: stored outside-spending data is then left
   * untouched. Pass the full year (even []) after a successful fetch: that is
   * authoritative and clears superseded groups and totals.
   */
  independentExpenditureRows?: readonly ConnecticutEcrisIndependentExpenditureRow[];
  independentExpenditureSourceUrl?: string | null;
  now?: Date;
  dryRun?: boolean;
  directMaxBreakdownsPerCategory?: number;
  maxOutsideGroupsPerStance?: number;
};

export type ConnecticutCandidateFinanceSyncResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  dryRun: boolean;
  resolution: ConnecticutCandidateCommitteeResolution;
  linkWritten: boolean;
  summaryWritten: boolean;
  directBreakdownsWritten: number;
  outsideGroupsWritten: number;
  pacDonorsWritten: number;
  totalReceipts: number | null;
  outsideSupportTotal: number | null;
  outsideOpposeTotal: number | null;
  matchedReceiptRowCount: number;
  includedReceiptRowCount: number;
  skippedReceiptRowCount: number;
  outsideAggregation: ConnecticutOutsideSpendingAggregationResult | null;
};

function requireNonEmpty(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmed;
}

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2008 || value > 2100) {
    throw new Error(`Invalid Connecticut finance election year: ${value}`);
  }
  return value;
}

function normalizeCandidateNameForStorage(value: string): string {
  const keys = normalizeConnecticutCandidateNameKeys(value);
  return [...keys][0] ?? requireNonEmpty(value, "candidate name").replace(/\s+/g, " ").toUpperCase();
}

function normalizeTimestamp(value: Date | undefined): Date {
  const normalized = value ?? new Date();
  if (Number.isNaN(normalized.getTime())) {
    throw new Error("Invalid Connecticut finance sync timestamp");
  }
  return normalized;
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
}): ConnecticutFinanceLinkInput {
  return {
    candidateId: requireNonEmpty(input.candidateId, "candidate id"),
    electionId: requireNonEmpty(input.electionId, "election id"),
    electionYear: input.electionYear,
    candidateNameNormalized: normalizeCandidateNameForStorage(input.candidateName),
    officeName: requireNonEmpty(input.officeName, "office name"),
    district: input.district ?? null,
    committeeId: requireNonEmpty(input.committeeId, "Connecticut committee id"),
    committeeName: requireNonEmpty(input.committeeName, "Connecticut committee name"),
    linkStatus: "active",
    linkSource: "ecris_bulk",
    sourceUrl: input.sourceUrl ?? null,
    lastVerifiedAt: input.verifiedAt,
  };
}

function aggregateDirect(input: {
  committeeId: string;
  electionYear: number;
  receiptRows: readonly ConnecticutEcrisArtifactRow[];
  committeeRegistry?: readonly ConnecticutFinanceCommitteeRegistryEntry[];
  receiptSourceUrl?: string | null;
  maxBreakdownsPerCategory?: number;
}): ConnecticutDirectContributionAggregationResult {
  return aggregateConnecticutDirectContributions({
    committeeId: input.committeeId,
    electionYear: input.electionYear,
    receiptRows: input.receiptRows,
    committeeRegistry: input.committeeRegistry,
    sourceUrl: input.receiptSourceUrl ?? null,
    maxBreakdownsPerCategory: input.maxBreakdownsPerCategory,
  });
}

export async function syncConnecticutCandidateFinance(
  input: ConnecticutCandidateFinanceSyncInput
): Promise<ConnecticutCandidateFinanceSyncResult> {
  const candidateId = requireNonEmpty(input.candidateId, "candidate id");
  const electionId = requireNonEmpty(input.electionId, "election id");
  const candidateName = requireNonEmpty(input.candidateName, "candidate name");
  const officeName = requireNonEmpty(input.officeName, "office name");
  const electionYear = normalizeElectionYear(input.electionYear);
  const syncedAt = normalizeTimestamp(input.now);
  const resolution = resolveConnecticutCandidateCommittee({
    candidateName,
    officeName,
    electionYear,
    district: input.district,
    receiptRows: input.receiptRows,
    sourceUrl: input.sourceUrl ?? input.receiptSourceUrl ?? null,
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
      pacDonorsWritten: 0,
      totalReceipts: null,
      outsideSupportTotal: null,
      outsideOpposeTotal: null,
      matchedReceiptRowCount: 0,
      includedReceiptRowCount: 0,
      skippedReceiptRowCount: 0,
      outsideAggregation: null,
    };
  }

  const directFinance = aggregateDirect({
    committeeId: resolution.committeeId,
    electionYear,
    receiptRows: input.receiptRows,
    receiptSourceUrl: input.receiptSourceUrl ?? resolution.sourceUrl,
    committeeRegistry: input.committeeRegistry,
    maxBreakdownsPerCategory: input.directMaxBreakdownsPerCategory,
  });
  const outsideAggregation = input.independentExpenditureRows
    ? aggregateConnecticutOutsideSpending({
        candidateName,
        officeName,
        electionYear,
        expenditureRows: input.independentExpenditureRows,
        sourceUrl: input.independentExpenditureSourceUrl ?? null,
        maxGroupsPerStance: input.maxOutsideGroupsPerStance,
      })
    : null;
  const outsideGroups = outsideAggregation
    ? outsideAggregation.summary.groups.map((group) => ({
        committeeId: group.committeeId,
        committeeName: group.committeeName,
        supportOppose: group.supportOppose,
        amount: group.amount,
        sourceUrl: group.sourceUrl,
      }))
    : undefined;
  const link = toFinanceLink({
    candidateId,
    electionId,
    candidateName,
    electionYear,
    officeName,
    district: input.district,
    committeeId: resolution.committeeId,
    committeeName: resolution.committeeName,
    sourceUrl: resolution.sourceUrl ?? input.sourceUrl ?? input.receiptSourceUrl ?? null,
    verifiedAt: syncedAt,
  });

  if (!input.dryRun) {
    await replaceConnecticutCandidateFinanceSnapshot({
      db: input.db,
      link,
      syncedAt,
      summary: {
        ...directFinance.summary,
        outsideSupportTotal: outsideAggregation?.summary.supportTotal ?? null,
        outsideOpposeTotal: outsideAggregation?.summary.opposeTotal ?? null,
      },
      directBreakdowns: directFinance.directBreakdowns,
      pacDonors: directFinance.pacDonors,
      outsideGroups,
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
    directBreakdownsWritten: input.dryRun ? 0 : directFinance.directBreakdowns.length,
    outsideGroupsWritten: input.dryRun ? 0 : outsideGroups?.length ?? 0,
    pacDonorsWritten: input.dryRun ? 0 : directFinance.pacDonors.length,
    totalReceipts: directFinance.summary.totalReceipts,
    outsideSupportTotal: outsideAggregation?.summary.supportTotal ?? null,
    outsideOpposeTotal: outsideAggregation?.summary.opposeTotal ?? null,
    matchedReceiptRowCount: directFinance.matchedReceiptRowCount,
    includedReceiptRowCount: directFinance.includedReceiptRowCount,
    skippedReceiptRowCount: directFinance.skippedReceiptRowCount,
    outsideAggregation,
  };
}
