import type { Pool, PoolClient } from "pg";

import {
  prepareMissouriCommitteeMonetaryReceiptComponent,
  replaceMissouriCommitteeMonetaryReceiptRows,
  type MissouriCommitteeMonetaryReceiptComponent,
} from "./missouriCommitteeMonetaryReceiptWriter.js";

import type { FinanceLabelClassification } from "../finance/financeLabelClassifier.js";
import {
  createStandardStateFinanceSnapshotWriter,
  type StandardStateFinanceDirectBreakdownInput,
  type StandardStateFinanceDirectCategoryType,
  type StandardStateFinanceLinkInput,
  type StandardStateFinanceLinkStatus,
  type StandardStateFinanceOutsideCategoryType,
  type StandardStateFinanceOutsideGroupBreakdownInput,
  type StandardStateFinanceOutsideGroupInput,
  type StandardStateFinanceSnapshotWriteResult,
  type StandardStateFinanceSummaryInput,
  type StandardStateFinanceSupportOppose,
} from "../finance/standardStateFinanceSnapshotWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & {
  connect: () => Promise<PoolClient>;
};

export type MissouriFinanceLinkStatus = StandardStateFinanceLinkStatus;
export type MissouriFinanceLinkSource = "manual" | "mec_portal";
export type MissouriFinanceDirectCategoryType = StandardStateFinanceDirectCategoryType;
export type MissouriFinanceOutsideCategoryType = StandardStateFinanceOutsideCategoryType;
export type MissouriFinanceSupportOppose = StandardStateFinanceSupportOppose;

export type MissouriFinanceLinkInput = Omit<StandardStateFinanceLinkInput, "linkSource"> & {
  linkSource?: MissouriFinanceLinkSource;
};
export type MissouriFinanceSummaryInput = StandardStateFinanceSummaryInput;
export type MissouriFinanceDirectBreakdownInput = StandardStateFinanceDirectBreakdownInput;
export type MissouriFinanceOutsideGroupInput = StandardStateFinanceOutsideGroupInput;
export type MissouriFinanceOutsideGroupBreakdownInput = StandardStateFinanceOutsideGroupBreakdownInput;

export type MissouriFinanceSnapshotInput = {
  db: ConnectableQueryable;
  link: MissouriFinanceLinkInput;
  syncedAt?: Date;
  summary?: MissouriFinanceSummaryInput;
  directBreakdowns?: readonly MissouriFinanceDirectBreakdownInput[];
  outsideGroups?: readonly MissouriFinanceOutsideGroupInput[];
  outsideGroupBreakdowns?: readonly MissouriFinanceOutsideGroupBreakdownInput[];
  classifications?: readonly FinanceLabelClassification[];
  committeeMonetaryReceipts?: MissouriCommitteeMonetaryReceiptComponent;
};

export type MissouriFinanceSnapshotWriteResult = StandardStateFinanceSnapshotWriteResult;

function normalizeMissouriMecId(value: string): string {
  const normalized = value.toUpperCase();
  if (!/^[A-Z]\d{6}$/.test(normalized)) {
    throw new Error(`Invalid Missouri MECID: ${value}`);
  }
  return normalized;
}

const writer = createStandardStateFinanceSnapshotWriter({
  label: "Missouri",
  minElectionYear: 2024,
  summaryUpdatePolicy: {
    total_receipts: "replace",
    direct_contribution_total: "replace",
    total_disbursements: "replace",
    cash_on_hand: "replace",
    // A direct-only run must not erase a previously good outside snapshot
    // when the yearly portal export or spender acquisition is unavailable.
    outside_support_total: "preserveWhenNull",
    outside_oppose_total: "preserveWhenNull",
    source_url: "replace",
  },
  outsideGroupValidation: "pairing",
  normalizeCommitteeId: normalizeMissouriMecId,
  supersededLinkSource: "mec_portal",
  manualLinkProtection: true,
  tables: {
    links: "mo_candidate_finance_links",
    summaries: "mo_candidate_finance_summaries",
    directBreakdowns: "mo_candidate_finance_direct_breakdowns",
    outsideGroups: "mo_candidate_finance_outside_groups",
    outsideGroupBreakdowns: "mo_candidate_finance_outside_group_breakdowns",
  },
});

export async function upsertMissouriFinanceLink(input: {
  db: Queryable;
  link: MissouriFinanceLinkInput;
}): Promise<{ linkId: string }> {
  return writer.upsertLink(input);
}

export async function replaceMissouriCandidateFinanceSnapshot(
  input: MissouriFinanceSnapshotInput
): Promise<MissouriFinanceSnapshotWriteResult> {
  const syncedAt = new Date(input.syncedAt?.getTime() ?? Date.now());
  const component = prepareMissouriCommitteeMonetaryReceiptComponent({
    component: input.committeeMonetaryReceipts, receivingCommitteeId: input.link.committeeId,
    electionYear: input.link.electionYear, syncedAt,
  });
  return writer.replaceSnapshot({ ...input, syncedAt,
    ...(component ? { afterSnapshotWrite: async ({ db, linkId, electionYear, syncedAt }) => {
      await replaceMissouriCommitteeMonetaryReceiptRows({ db, linkId, electionYear, syncedAt, component });
    } } : {}),
  });
}
