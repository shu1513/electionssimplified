import type { Pool, PoolClient } from "pg";

import {
  createStandardStateFinanceSnapshotWriter,
  type StandardStateFinanceLinkInput,
  type StandardStateFinanceLinkStatus,
  type StandardStateFinanceSnapshotWriteResult,
  type StandardStateFinanceSummaryInput,
} from "../finance/standardStateFinanceSnapshotWriter.js";
import type { FinanceLabelClassification } from "../finance/financeLabelClassifier.js";
import type {
  OregonFinanceDirectCategoryType,
  OregonFinanceOutsideCategoryType,
} from "./oregonFinanceAggregator.js";
import type { OregonOrestarSupportOppose } from "./oregonOrestarParser.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & {
  connect: () => Promise<PoolClient>;
};

export type OregonFinanceLinkStatus = StandardStateFinanceLinkStatus;
export type OregonFinanceLinkSource = "manual" | "orestar";

export type OregonFinanceLinkInput = Omit<StandardStateFinanceLinkInput, "linkSource"> & {
  linkSource?: OregonFinanceLinkSource;
};

export type OregonFinanceSummaryInput = StandardStateFinanceSummaryInput;

export type OregonFinanceDirectBreakdownInput = {
  categoryType: OregonFinanceDirectCategoryType;
  categoryName: string;
  amount: number;
  contributorCount?: number | null;
  sourceUrl?: string | null;
};

// Oregon's outside tables identify groups by ORESTAR sponsor, not committee:
// sponsor_id/sponsor_name columns and sponsorId/sponsorName input fields. The
// factory writes the sponsor columns via outsideGroupIdentityColumns; the
// wrapper maps the sponsor input fields onto the factory's committeeId /
// committeeName fields below.
export type OregonFinanceOutsideGroupInput = {
  sponsorId: string;
  sponsorName: string;
  supportOppose: OregonOrestarSupportOppose;
  amount: number;
  sourceUrl?: string | null;
};

export type OregonFinanceOutsideGroupBreakdownInput = {
  sponsorId: string;
  supportOppose: OregonOrestarSupportOppose;
  categoryType: OregonFinanceOutsideCategoryType;
  categoryName: string;
  amount: number;
  contributorCount?: number | null;
  sourceUrl?: string | null;
};

export type OregonFinanceSnapshotInput = {
  db: ConnectableQueryable;
  link: OregonFinanceLinkInput;
  syncedAt?: Date;
  summary?: OregonFinanceSummaryInput;
  directBreakdowns?: readonly OregonFinanceDirectBreakdownInput[];
  outsideGroups?: readonly OregonFinanceOutsideGroupInput[];
  outsideGroupBreakdowns?: readonly OregonFinanceOutsideGroupBreakdownInput[];
  classifications?: readonly FinanceLabelClassification[];
};

export type OregonFinanceSnapshotWriteResult = StandardStateFinanceSnapshotWriteResult;

const writer = createStandardStateFinanceSnapshotWriter({
  label: "Oregon",
  minElectionYear: 2000,
  // Contributions do not establish outside-spending coverage. An omitted
  // outside component preserves its last accepted totals.
  summaryUpdatePolicy: {
    total_receipts: "replace",
    direct_contribution_total: "replace",
    total_disbursements: "replace",
    cash_on_hand: "replace",
    outside_support_total: "preserveWhenNull",
    outside_oppose_total: "preserveWhenNull",
    source_url: "replace",
  },
  // Presence-only, matching the bespoke writer. The or_ breakdown table does
  // carry the ON DELETE CASCADE FK to the groups table, so the known
  // stale-group cascade window (see the capability matrix) exists here exactly
  // as it did before the migration; tightening to "pairing" would reject
  // inputs the bespoke writer accepted and is a separate behavior decision.
  outsideGroupValidation: "presence",
  outsideGroupIdentityColumns: { id: "sponsor_id", name: "sponsor_name" },
  tables: {
    links: "or_candidate_finance_links",
    summaries: "or_candidate_finance_summaries",
    directBreakdowns: "or_candidate_finance_direct_breakdowns",
    outsideGroups: "or_candidate_finance_outside_groups",
    outsideGroupBreakdowns: "or_candidate_finance_outside_group_breakdowns",
  },
});

function requireNonEmpty(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmed;
}

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new Error(`Invalid Oregon finance election year: ${value}`);
  }
  return value;
}

function validateNullableDate(value: Date | null | undefined): void {
  if (value && Number.isNaN(value.getTime())) {
    throw new Error("Invalid Oregon finance timestamp");
  }
}

// The factory's link validation covers the same fields, but the bespoke writer
// called the committee id an "ORESTAR committee ID" and the per-state test pins
// that wording — so the wrapper validates first with the legacy nouns and the
// factory's own check never fires on input that passes here.
function validateOregonFinanceLinkInput(link: OregonFinanceLinkInput): void {
  requireNonEmpty(link.candidateId, "candidate id");
  requireNonEmpty(link.electionId, "election id");
  normalizeElectionYear(link.electionYear);
  requireNonEmpty(link.candidateNameNormalized, "Oregon finance candidate name");
  requireNonEmpty(link.officeName, "Oregon finance office name");
  requireNonEmpty(link.committeeId, "Oregon ORESTAR committee ID");
  requireNonEmpty(link.committeeName, "Oregon committee name");
  validateNullableDate(link.lastVerifiedAt);
}

// Oregon snapshot writes must receive a Pool: a bare queryable without
// connect() is rejected instead of taking the factory's inline-transaction
// path. The stub throws on first use rather than up front so that input
// validation errors still surface before the transaction-contract error.
function requireOregonPool(db: Queryable): Queryable {
  const candidate = db as { connect?: unknown; release?: unknown };
  if (typeof candidate.connect === "function" || typeof candidate.release === "function") {
    return db;
  }
  const rejectQuery = () => {
    throw new Error("Oregon finance snapshot writes must receive a Pool");
  };
  return { query: rejectQuery as unknown as Queryable["query"] };
}

export async function upsertOregonFinanceLink(input: {
  db: Queryable;
  link: OregonFinanceLinkInput;
}): Promise<{ linkId: string }> {
  validateOregonFinanceLinkInput(input.link);
  return writer.upsertLink(input);
}

export async function replaceOregonCandidateFinanceSnapshot(
  input: OregonFinanceSnapshotInput
): Promise<OregonFinanceSnapshotWriteResult> {
  const syncedAt = input.syncedAt ?? new Date();
  if (Number.isNaN(syncedAt.getTime())) {
    throw new Error("Invalid Oregon finance sync timestamp");
  }
  validateOregonFinanceLinkInput(input.link);
  return writer.replaceSnapshot({
    ...input,
    syncedAt,
    db: requireOregonPool(input.db),
    outsideGroups: input.outsideGroups?.map((group) => ({
      committeeId: group.sponsorId,
      committeeName: group.sponsorName,
      supportOppose: group.supportOppose,
      amount: group.amount,
      sourceUrl: group.sourceUrl,
    })),
    outsideGroupBreakdowns: input.outsideGroupBreakdowns?.map((breakdown) => ({
      committeeId: breakdown.sponsorId,
      supportOppose: breakdown.supportOppose,
      categoryType: breakdown.categoryType,
      categoryName: breakdown.categoryName,
      amount: breakdown.amount,
      contributorCount: breakdown.contributorCount,
      sourceUrl: breakdown.sourceUrl,
    })),
  });
}
