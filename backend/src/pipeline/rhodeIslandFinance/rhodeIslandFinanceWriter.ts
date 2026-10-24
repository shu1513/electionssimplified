import type { Pool, PoolClient } from "pg";

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
  type StandardStateFinanceSnapshotInput,
  type StandardStateFinanceSummaryInput,
  type StandardStateFinanceSupportOppose,
} from "../finance/standardStateFinanceSnapshotWriter.js";
import type { FinanceLabelClassification } from "../finance/financeLabelClassifier.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & {
  connect: () => Promise<PoolClient>;
};

export type RhodeIslandFinanceLinkStatus = StandardStateFinanceLinkStatus;
export type RhodeIslandFinanceLinkSource = "manual" | "erts_portal";
export type RhodeIslandFinanceDirectCategoryType = StandardStateFinanceDirectCategoryType;
export type RhodeIslandFinanceOutsideCategoryType = StandardStateFinanceOutsideCategoryType;
export type RhodeIslandFinanceSupportOppose = StandardStateFinanceSupportOppose;

export type RhodeIslandFinanceLinkInput = Omit<StandardStateFinanceLinkInput, "linkSource"> & {
  linkSource?: RhodeIslandFinanceLinkSource;
};

export type RhodeIslandFinanceSummaryInput = StandardStateFinanceSummaryInput;
export type RhodeIslandFinanceDirectBreakdownInput = StandardStateFinanceDirectBreakdownInput;
export type RhodeIslandFinanceOutsideGroupInput = StandardStateFinanceOutsideGroupInput;
export type RhodeIslandFinanceOutsideGroupBreakdownInput = StandardStateFinanceOutsideGroupBreakdownInput;

export type RhodeIslandFinanceSnapshotInput = {
  db: ConnectableQueryable;
  link: RhodeIslandFinanceLinkInput;
  syncedAt?: Date;
  summary?: RhodeIslandFinanceSummaryInput;
  directBreakdowns?: readonly RhodeIslandFinanceDirectBreakdownInput[];
  outsideGroups?: readonly RhodeIslandFinanceOutsideGroupInput[];
  outsideGroupBreakdowns?: readonly RhodeIslandFinanceOutsideGroupBreakdownInput[];
  classifications?: readonly FinanceLabelClassification[];
  beforeSnapshotWrite?: StandardStateFinanceSnapshotInput["beforeSnapshotWrite"];
  afterSnapshotWrite?: StandardStateFinanceSnapshotInput["afterSnapshotWrite"];
};

export type RhodeIslandFinanceSnapshotWriteResult = StandardStateFinanceSnapshotWriteResult;

// A candidate link's committee_id is the ERTS organization key — a stable
// numeric Board key (e.g. McKee is 2235). Anything non-numeric is a scrape
// defect, never a valid identity. Outside-group committee ids are not held
// to this: curated CF-8 supplement spenders keep whatever identity the
// filing discloses.
function requireErtsOrganizationKey(value: string): string {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid Rhode Island ERTS organization key: ${value}`);
  }
  return trimmed;
}

const writer = createStandardStateFinanceSnapshotWriter({
  label: "Rhode Island",
  // Current (2026) cycle only: ERTS has no statewide export, so every cycle
  // is a fresh per-organization crawl — historical expansion is a separate,
  // separately tested decision (docs/plans/rhode_island_plan.md).
  minElectionYear: 2026,
  // Migration 236 ships the relaxed amounts CHECK from day one: cash on hand
  // is a signed balance, RI CF-2s carry liabilities, and an official negative
  // ending balance must never be written as NULL (Georgia 231 /
  // Massachusetts 232 precedent).
  allowNegativeCashOnHand: true,
  // Rhode Island replaces every summary column except the outside totals,
  // which keep the stored value when the incoming value is NULL
  // (preserveWhenNull default): direct and outside are built from different
  // artifact sets, so a direct-only refresh must not wipe outside totals.
  summaryUpdatePolicy: {
    total_receipts: "replace",
    direct_contribution_total: "replace",
    total_disbursements: "replace",
    cash_on_hand: "replace",
    source_url: "replace",
  },
  outsideGroupValidation: "pairing",
  supersededLinkSource: "erts_portal",
  tables: {
    links: "ri_candidate_finance_links",
    summaries: "ri_candidate_finance_summaries",
    directBreakdowns: "ri_candidate_finance_direct_breakdowns",
    outsideGroups: "ri_candidate_finance_outside_groups",
    outsideGroupBreakdowns: "ri_candidate_finance_outside_group_breakdowns",
  },
});

function withValidatedLink(link: RhodeIslandFinanceLinkInput): RhodeIslandFinanceLinkInput {
  return { ...link, committeeId: requireErtsOrganizationKey(link.committeeId) };
}

export async function upsertRhodeIslandFinanceLink(input: {
  db: Queryable;
  link: RhodeIslandFinanceLinkInput;
}): Promise<{ linkId: string }> {
  return writer.upsertLink({ ...input, link: withValidatedLink(input.link) });
}

export async function replaceRhodeIslandCandidateFinanceSnapshot(
  input: RhodeIslandFinanceSnapshotInput
): Promise<RhodeIslandFinanceSnapshotWriteResult> {
  return writer.replaceSnapshot({ ...input, link: withValidatedLink(input.link) });
}
