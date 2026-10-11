// Arkansas finance snapshot writer (docs/plans/plan-arkansas-finance.md, Phase 1). Thin
// wrapper over the standard state-finance writer, mirroring New Hampshire
// (same Civix CFIS build) on identity and Alabama on the direct-only shape.
//
// Identity: the CFIS filer entity ID (registration-row filerEntityID = bulk
// CSV "Filing Entity ID") in filing_entity_id, with the filer display name in
// filer_name. Direct breakdowns are occupations or size buckets (migration
// 266). cash_on_hand is a signed balance (CFIS reports negative balances for
// indebted campaigns).
//
// Direct-only acquisitions do not establish outside-spending availability.
// Preserve existing outside totals and rows until a verified outside component
// is supplied through its own acquisition path.

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

export type ArkansasFinanceLinkStatus = StandardStateFinanceLinkStatus;
export type ArkansasFinanceLinkSource = "manual" | "cfis_registration";
export type ArkansasFinanceDirectCategoryType = StandardStateFinanceDirectCategoryType;

export const ARKANSAS_FINANCE_AUTOMATIC_LINK_SOURCE: ArkansasFinanceLinkSource = "cfis_registration";

export type ArkansasFinanceLinkInput = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  candidateNameNormalized: string;
  officeName: string;
  district?: string | null;
  /** CFIS filer entity ID (registration-row filerEntityID). */
  filingEntityId: number;
  filerName: string;
  linkStatus?: ArkansasFinanceLinkStatus;
  linkSource?: ArkansasFinanceLinkSource;
  sourceUrl?: string | null;
  lastVerifiedAt?: Date | null;
};

/** NULL amounts preserve stored data; zero means a successful empty result. */
export type ArkansasFinanceSummaryInput = {
  totalReceipts: number | null;
  directContributionTotal: number | null;
  totalDisbursements: number | null;
  /** Signed balance; negative means the campaign is indebted. */
  cashOnHand: number | null;
  sourceUrl: string | null;
};

export type ArkansasFinanceDirectBreakdownInput =
  StandardStateFinanceDirectBreakdownInput<ArkansasFinanceDirectCategoryType>;

export type ArkansasFinanceSnapshotInput = {
  db: ConnectableQueryable;
  link: ArkansasFinanceLinkInput;
  syncedAt?: Date;
  summary?: ArkansasFinanceSummaryInput;
  /** Omit when unavailable; pass [] after a successful fetch with no breakdowns. */
  directBreakdowns?: readonly ArkansasFinanceDirectBreakdownInput[];
};

export type ArkansasFinanceSnapshotWriteResult = StandardStateFinanceSnapshotWriteResult;

function normalizeFilingEntityId(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid Arkansas filing entity ID: ${value}`);
  }
  return String(value);
}

function normalizeStoredFilingEntityId(value: string): string {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`Invalid Arkansas filing entity ID: ${value}`);
  }
  return value;
}

const writer = createStandardStateFinanceSnapshotWriter({
  label: "Arkansas",
  // Migration 266 constrains election_year to 2026+ (Nov-2026 scope).
  minElectionYear: 2026,
  allowNegativeCashOnHand: true,
  normalizeCommitteeId: normalizeStoredFilingEntityId,
  manualLinkProtection: true,
  supersededLinkSource: ARKANSAS_FINANCE_AUTOMATIC_LINK_SOURCE,
  linkIdentityColumns: {
    id: "filing_entity_id",
    name: "filer_name",
  },
  outsideGroupIdentityColumns: {
    id: "filing_entity_id",
    name: "filer_name",
  },
  tables: {
    links: "ar_candidate_finance_links",
    summaries: "ar_candidate_finance_summaries",
    directBreakdowns: "ar_candidate_finance_direct_breakdowns",
    outsideGroups: "ar_candidate_finance_outside_groups",
    outsideGroupBreakdowns: "ar_candidate_finance_outside_group_breakdowns",
  },
});

function toStandardLink(link: ArkansasFinanceLinkInput) {
  return {
    candidateId: link.candidateId,
    electionId: link.electionId,
    electionYear: link.electionYear,
    candidateNameNormalized: link.candidateNameNormalized,
    officeName: link.officeName,
    district: link.district,
    committeeId: normalizeFilingEntityId(link.filingEntityId),
    committeeName: link.filerName,
    linkStatus: link.linkStatus,
    linkSource: link.linkSource,
    sourceUrl: link.sourceUrl,
    lastVerifiedAt: link.lastVerifiedAt,
  };
}

export async function upsertArkansasFinanceLink(input: {
  db: Queryable;
  link: ArkansasFinanceLinkInput;
}): Promise<{ linkId: string }> {
  return writer.upsertLink({ db: input.db, link: toStandardLink(input.link) });
}

export async function replaceArkansasCandidateFinanceSnapshot(
  input: ArkansasFinanceSnapshotInput
): Promise<ArkansasFinanceSnapshotWriteResult> {
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
