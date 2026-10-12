// South Carolina finance snapshot writer (docs/plans/plan-south-carolina-finance.md,
// Phase 4). Thin wrapper over the standard state-finance writer. Identity:
// the Ethics API's positive integer candidateFilerId, stored as text in
// candidate_filer_id (id 0 marks SEI-only filers with no candidate account
// and must never be linked). This candidate-only path acquires no outside
// evidence. Omitted outside components preserve stored totals and groups.
//
// Presence semantics live in the caller (Phase 5 sync): the writer is only
// called with filed data or a filed-zero snapshot; source-unavailable and
// no-filing-yet outcomes skip the write entirely so the prior snapshot is
// preserved.

import type { Pool, PoolClient } from "pg";

import {
  createStandardStateFinanceSnapshotWriter,
  type StandardStateFinanceDirectBreakdownInput,
  type StandardStateFinanceDirectCategoryType,
  type StandardStateFinanceLinkStatus,
  type StandardStateFinanceSnapshotWriteResult,
} from "../finance/standardStateFinanceSnapshotWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & {
  connect: () => Promise<PoolClient>;
};

export type SouthCarolinaFinanceLinkStatus = StandardStateFinanceLinkStatus;
export type SouthCarolinaFinanceLinkSource = "manual" | "ethics_filer_search";
export type SouthCarolinaFinanceDirectCategoryType = StandardStateFinanceDirectCategoryType;

export type SouthCarolinaFinanceLinkInput = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  candidateNameNormalized: string;
  officeName: string;
  district?: string | null;
  candidateFilerId: number;
  filerName: string;
  linkStatus?: SouthCarolinaFinanceLinkStatus;
  linkSource?: SouthCarolinaFinanceLinkSource;
  sourceUrl?: string | null;
  lastVerifiedAt?: Date | null;
};

// NULL amounts preserve stored data; zero means a filed-zero snapshot.
//
// The aggregator's per-candidate directCoverageNote is deliberately not
// persisted: the standard table family carries no note column, and display
// uses a static source-wide directCoverageNote declared in the Phase 6
// ballot-lookup loader (the Missouri/New Hampshire pattern — the SC note copy
// is worded to hold for every candidate). The per-candidate note remains a
// Phase 5 sync diagnostic only.
export type SouthCarolinaFinanceSummaryInput = {
  totalReceipts: number | null;
  directContributionTotal: number | null;
  totalDisbursements: number | null;
  /** Signed ending balance — an indebted campaign can report negative cash. */
  cashOnHand: number | null;
  sourceUrl: string | null;
};

export type SouthCarolinaFinanceDirectBreakdownInput = StandardStateFinanceDirectBreakdownInput;

export type SouthCarolinaFinanceSnapshotInput = {
  db: ConnectableQueryable;
  link: SouthCarolinaFinanceLinkInput;
  syncedAt?: Date;
  summary?: SouthCarolinaFinanceSummaryInput;
  /** Omit when unavailable; pass [] after a successful run with no breakdowns. */
  directBreakdowns?: readonly SouthCarolinaFinanceDirectBreakdownInput[];
};

export type SouthCarolinaFinanceSnapshotWriteResult = StandardStateFinanceSnapshotWriteResult;

function normalizeCandidateFilerId(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid South Carolina candidate filer ID: ${value}`);
  }
  return String(value);
}

function normalizeStoredCandidateFilerId(value: string): string {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`Invalid South Carolina candidate filer ID: ${value}`);
  }
  return value;
}

const writer = createStandardStateFinanceSnapshotWriter({
  label: "South Carolina",
  // Oldest election run observed live on the Ethics API (2008 primaries).
  minElectionYear: 2008,
  // The ending "Campaign Funds" balance is report-cover arithmetic; an
  // indebted campaign can legitimately report negative cash (migration 260
  // leaves cash_on_hand unconstrained).
  allowNegativeCashOnHand: true,
  normalizeCommitteeId: normalizeStoredCandidateFilerId,
  manualLinkProtection: true,
  supersededLinkSource: "ethics_filer_search",
  linkIdentityColumns: {
    id: "candidate_filer_id",
    name: "candidate_filer_name",
  },
  tables: {
    links: "sc_candidate_finance_links",
    summaries: "sc_candidate_finance_summaries",
    directBreakdowns: "sc_candidate_finance_direct_breakdowns",
    outsideGroups: "sc_candidate_finance_outside_groups",
    outsideGroupBreakdowns: "sc_candidate_finance_outside_group_breakdowns",
  },
});

function toStandardLink(link: SouthCarolinaFinanceLinkInput) {
  return {
    candidateId: link.candidateId,
    electionId: link.electionId,
    electionYear: link.electionYear,
    candidateNameNormalized: link.candidateNameNormalized,
    officeName: link.officeName,
    district: link.district,
    committeeId: normalizeCandidateFilerId(link.candidateFilerId),
    committeeName: link.filerName,
    linkStatus: link.linkStatus,
    linkSource: link.linkSource,
    sourceUrl: link.sourceUrl,
    lastVerifiedAt: link.lastVerifiedAt,
  };
}

export async function upsertSouthCarolinaFinanceLink(input: {
  db: Queryable;
  link: SouthCarolinaFinanceLinkInput;
}): Promise<{ linkId: string }> {
  return writer.upsertLink({ db: input.db, link: toStandardLink(input.link) });
}

export async function replaceSouthCarolinaCandidateFinanceSnapshot(
  input: SouthCarolinaFinanceSnapshotInput
): Promise<SouthCarolinaFinanceSnapshotWriteResult> {
  // Unavailable outside amounts use the shared preserveWhenNull policy.
  // Omit groups entirely: [] would claim verified absence and delete rows.
  return writer.replaceSnapshot({
    db: input.db,
    link: toStandardLink(input.link),
    syncedAt: input.syncedAt,
    summary:
      input.summary === undefined
        ? undefined
        : { ...input.summary, outsideSupportTotal: null, outsideOpposeTotal: null },
    directBreakdowns: input.directBreakdowns,
  });
}
