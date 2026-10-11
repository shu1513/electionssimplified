// Alabama finance snapshot writer (docs/plans/plan-alabama-finance.md, Phase 3). Thin
// wrapper over the standard state-finance writer. Identity: the FCPA
// portal's internal numeric committee id (race-row COMMITTEEID) in
// committee_id. The public FCPA committee number (extract CommitteeId) lives
// in the links table's extra fcpa_committee_number column, which the
// standard writer never touches — the auto-link backfills it after the link
// upsert (updateAlabamaFinanceLinkFcpaCommitteeNumber below) and the sync
// skips size buckets with a diagnostic while it is NULL.
//
// Official attachments can identify candidate support, but the acquired
// expenditure contract lacks verified candidate-specific outside dollar coverage.
// Omit unknown outside components so direct syncs preserve stored evidence.

import type { Pool, PoolClient } from "pg";

import {
  createStandardStateFinanceSnapshotWriter,
  type StandardStateFinanceDirectBreakdownInput,
  type StandardStateFinanceLinkStatus,
  type StandardStateFinanceSnapshotWriteResult,
} from "../finance/standardStateFinanceSnapshotWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & {
  connect: () => Promise<PoolClient>;
};

export type AlabamaFinanceLinkStatus = StandardStateFinanceLinkStatus;
export type AlabamaFinanceLinkSource = "manual" | "fcpa_race_search";

export type AlabamaFinanceLinkInput = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  candidateNameNormalized: string;
  officeName: string;
  district?: string | null;
  /** FCPA portal internal committee id (race-row COMMITTEEID). */
  internalCommitteeId: number;
  committeeName: string;
  linkStatus?: AlabamaFinanceLinkStatus;
  linkSource?: AlabamaFinanceLinkSource;
  sourceUrl?: string | null;
  lastVerifiedAt?: Date | null;
};

// NULL amounts preserve stored data; zero means a filed-zero race row.
export type AlabamaFinanceSummaryInput = {
  totalReceipts: number | null;
  directContributionTotal: number | null;
  totalDisbursements: number | null;
  cashOnHand: number | null;
  sourceUrl: string | null;
};

export type AlabamaFinanceDirectBreakdownInput =
  StandardStateFinanceDirectBreakdownInput<"contribution_size">;

export type AlabamaFinanceSnapshotInput = {
  db: ConnectableQueryable;
  link: AlabamaFinanceLinkInput;
  syncedAt?: Date;
  summary?: AlabamaFinanceSummaryInput;
  /** Omit when buckets are gated off; pass [] to clear stored buckets. */
  directBreakdowns?: readonly AlabamaFinanceDirectBreakdownInput[];
};

export type AlabamaFinanceSnapshotWriteResult = StandardStateFinanceSnapshotWriteResult;

function normalizeInternalCommitteeId(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid Alabama internal committee id: ${value}`);
  }
  return String(value);
}

function normalizeStoredCommitteeId(value: string): string {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`Invalid Alabama internal committee id: ${value}`);
  }
  return value;
}

const writer = createStandardStateFinanceSnapshotWriter({
  label: "Alabama",
  // Migration 263 constrains election_year to 2024+ (Nov-2026 scope).
  minElectionYear: 2024,
  summaryUpdatePolicy: {
    // The sync stores null cash on hand only for an overdrawn committee; the
    // default preserve-when-null would keep a stale positive balance showing.
    cash_on_hand: "replace",
  },
  normalizeCommitteeId: normalizeStoredCommitteeId,
  manualLinkProtection: true,
  supersededLinkSource: "fcpa_race_search",
  tables: {
    links: "al_candidate_finance_links",
    summaries: "al_candidate_finance_summaries",
    directBreakdowns: "al_candidate_finance_direct_breakdowns",
    outsideGroups: "al_candidate_finance_outside_groups",
    outsideGroupBreakdowns: "al_candidate_finance_outside_group_breakdowns",
  },
});

function toStandardLink(link: AlabamaFinanceLinkInput) {
  return {
    candidateId: link.candidateId,
    electionId: link.electionId,
    electionYear: link.electionYear,
    candidateNameNormalized: link.candidateNameNormalized,
    officeName: link.officeName,
    district: link.district,
    committeeId: normalizeInternalCommitteeId(link.internalCommitteeId),
    committeeName: link.committeeName,
    linkStatus: link.linkStatus,
    linkSource: link.linkSource,
    sourceUrl: link.sourceUrl,
    lastVerifiedAt: link.lastVerifiedAt,
  };
}

export async function upsertAlabamaFinanceLink(input: {
  db: Queryable;
  link: AlabamaFinanceLinkInput;
}): Promise<{ linkId: string }> {
  return writer.upsertLink({ db: input.db, link: toStandardLink(input.link) });
}

/**
 * Backfill the extract-side FCPA committee number onto an existing link. The
 * standard writer's fixed column list cannot carry it, so this is the one
 * place the column is written. Keyed by the link's natural identity so both
 * the auto-link (right after its upsert) and the sync (self-healing a NULL
 * left by a crashed backfill or a manual link) can call it.
 */
export async function updateAlabamaFinanceLinkFcpaCommitteeNumber(input: {
  db: Queryable;
  candidateId: string;
  electionId: string;
  internalCommitteeId: number;
  fcpaCommitteeNumber: string;
}): Promise<void> {
  if (!/^[1-9]\d*$/.test(input.fcpaCommitteeNumber)) {
    throw new Error(`Invalid Alabama FCPA committee number: ${input.fcpaCommitteeNumber}`);
  }
  await input.db.query(
    `UPDATE public.al_candidate_finance_links
     SET fcpa_committee_number = $4
     WHERE candidate_id = $1::uuid AND election_id = $2::uuid AND committee_id = $3`,
    [
      input.candidateId,
      input.electionId,
      normalizeInternalCommitteeId(input.internalCommitteeId),
      input.fcpaCommitteeNumber,
    ]
  );
}

export async function replaceAlabamaCandidateFinanceSnapshot(
  input: AlabamaFinanceSnapshotInput
): Promise<AlabamaFinanceSnapshotWriteResult> {
  return writer.replaceSnapshot({
    db: input.db,
    link: toStandardLink(input.link),
    syncedAt: input.syncedAt,
    summary: input.summary,
    directBreakdowns: input.directBreakdowns,
  });
}
