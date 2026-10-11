// Delaware finance snapshot writer (docs/plans/plan-delaware-finance.md, Phase 1).
// Thin wrapper over the standard state-finance writer. Identity: the public
// CF_ID (8 digits) is canonical — Phase 0 proved zero conflicts across the
// full registry. The portal's MemberID is an acquisition key only and never
// reaches these tables. This direct-only path has no verified outside
// component. Delaware financial reports can publish explicit candidate
// allocations; until that source proof is integrated, omitted outside data
// preserves any previously stored totals, groups and breakdowns.

import type { Pool, PoolClient } from "pg";

import {
  createStandardStateFinanceSnapshotWriter,
  type StandardStateFinanceDirectBreakdownInput,
  type StandardStateFinanceDirectCategoryType,
  type StandardStateFinanceLinkInput,
  type StandardStateFinanceLinkStatus,
  type StandardStateFinanceSnapshotWriteResult,
  type StandardStateFinanceSummaryInput,
} from "../finance/standardStateFinanceSnapshotWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & {
  connect: () => Promise<PoolClient>;
};

export type DelawareFinanceLinkStatus = StandardStateFinanceLinkStatus;
export type DelawareFinanceLinkSource = "manual" | "cfrs_portal";
export type DelawareFinanceDirectCategoryType = StandardStateFinanceDirectCategoryType;

export type DelawareFinanceLinkInput = Omit<StandardStateFinanceLinkInput, "linkSource"> & {
  linkSource?: DelawareFinanceLinkSource;
};
export type DelawareFinanceSummaryInput = StandardStateFinanceSummaryInput;
export type DelawareFinanceDirectBreakdownInput = StandardStateFinanceDirectBreakdownInput;

export type DelawareFinanceSnapshotInput = {
  db: ConnectableQueryable;
  link: DelawareFinanceLinkInput;
  syncedAt?: Date;
  summary?: DelawareFinanceSummaryInput;
  directBreakdowns?: readonly DelawareFinanceDirectBreakdownInput[];
};

export type DelawareFinanceSnapshotWriteResult = StandardStateFinanceSnapshotWriteResult;

/** CF_ID: exactly eight digits as issued by CFRS (e.g. "01005311"). */
export function normalizeDelawareCfId(value: string): string {
  const normalized = value.trim();
  if (!/^\d{8}$/.test(normalized)) {
    throw new Error(`Invalid Delaware CF_ID: ${value}`);
  }
  return normalized;
}

const writer = createStandardStateFinanceSnapshotWriter({
  label: "Delaware",
  minElectionYear: 2026,
  summaryUpdatePolicy: {
    total_receipts: "replace",
    direct_contribution_total: "replace",
    total_disbursements: "replace",
    cash_on_hand: "replace",
    // A direct refresh provides no authority to replace outside amounts.
    outside_support_total: "preserveWhenNull",
    outside_oppose_total: "preserveWhenNull",
    source_url: "replace",
  },
  normalizeCommitteeId: normalizeDelawareCfId,
  supersededLinkSource: "cfrs_portal",
  manualLinkProtection: true,
  tables: {
    links: "de_candidate_finance_links",
    summaries: "de_candidate_finance_summaries",
    directBreakdowns: "de_candidate_finance_direct_breakdowns",
    outsideGroups: "de_candidate_finance_outside_groups",
    outsideGroupBreakdowns: "de_candidate_finance_outside_group_breakdowns",
  },
});

export async function upsertDelawareFinanceLink(input: {
  db: Queryable;
  link: DelawareFinanceLinkInput;
}): Promise<{ linkId: string }> {
  return writer.upsertLink(input);
}

export async function replaceDelawareCandidateFinanceSnapshot(
  input: DelawareFinanceSnapshotInput
): Promise<DelawareFinanceSnapshotWriteResult> {
  // Select only supported direct fields, including at the runtime boundary:
  // neither caller-supplied outside scalars nor extra outside arrays authorize
  // an outside write. Unknown outside components stay omitted.
  return writer.replaceSnapshot({
    db: input.db,
    link: input.link,
    syncedAt: input.syncedAt,
    directBreakdowns: input.directBreakdowns,
    summary:
      input.summary === undefined
        ? undefined
        : {
            totalReceipts: input.summary.totalReceipts,
            directContributionTotal: input.summary.directContributionTotal,
            totalDisbursements: input.summary.totalDisbursements,
            cashOnHand: input.summary.cashOnHand,
            sourceUrl: input.summary.sourceUrl,
          },
  });
}
