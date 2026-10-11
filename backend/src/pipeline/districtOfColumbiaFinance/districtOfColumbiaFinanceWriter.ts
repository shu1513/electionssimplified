import type { Pool, PoolClient } from "pg";

import {
  createStandardStateFinanceSnapshotWriter,
  type StandardStateFinanceDirectCategoryType,
  type StandardStateFinanceLinkInput,
  type StandardStateFinanceLinkStatus,
  type StandardStateFinanceOutsideCategoryType,
  type StandardStateFinanceSnapshotWriteResult,
  type StandardStateFinanceSummaryInput,
  type StandardStateFinanceSupportOppose,
} from "../finance/standardStateFinanceSnapshotWriter.js";
import type { FinanceLabelClassification } from "../finance/financeLabelClassifier.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & {
  connect: () => Promise<PoolClient>;
};

export type DistrictOfColumbiaFinanceLinkStatus = StandardStateFinanceLinkStatus;
export type DistrictOfColumbiaFinanceLinkSource = "manual" | "ocf_export";
export type DistrictOfColumbiaFinanceDirectCategoryType = StandardStateFinanceDirectCategoryType;
export type DistrictOfColumbiaFinanceOutsideCategoryType = StandardStateFinanceOutsideCategoryType;
export type DistrictOfColumbiaFinanceSupportOppose = StandardStateFinanceSupportOppose;

// D.C. identifies committees by OCF committee key in the links table and the
// outside tables alike: committee_key columns and committeeKey input fields.
// The factory writes the renamed columns via linkIdentityColumns /
// outsideGroupIdentityColumns; the wrapper maps the committeeKey input fields
// onto the factory's committeeId/committeeName fields below.
export type DistrictOfColumbiaFinanceLinkInput = Omit<StandardStateFinanceLinkInput, "committeeId" | "linkSource"> & {
  committeeKey: string;
  linkSource?: DistrictOfColumbiaFinanceLinkSource;
};

export type DistrictOfColumbiaFinanceSummaryInput = StandardStateFinanceSummaryInput & {
  // Fair Elections public funds (migration 321). Not one of the shared
  // writer's columns, so it is written in the same transaction below.
  publicFundsReceived?: number | null;
};

export type DistrictOfColumbiaFinanceDirectBreakdownInput = {
  categoryType: DistrictOfColumbiaFinanceDirectCategoryType;
  categoryName: string;
  amount: number;
  contributorCount?: number | null;
  sourceUrl?: string | null;
};

export type DistrictOfColumbiaFinanceOutsideGroupInput = {
  committeeKey: string;
  committeeName: string;
  supportOppose: DistrictOfColumbiaFinanceSupportOppose;
  amount: number;
  sourceUrl?: string | null;
};

export type DistrictOfColumbiaFinanceOutsideGroupBreakdownInput = {
  committeeKey: string;
  supportOppose: DistrictOfColumbiaFinanceSupportOppose;
  categoryType: DistrictOfColumbiaFinanceOutsideCategoryType;
  categoryName: string;
  amount: number;
  contributorCount?: number | null;
  sourceUrl?: string | null;
};

export type DistrictOfColumbiaFinanceSnapshotInput = {
  db: ConnectableQueryable;
  link: DistrictOfColumbiaFinanceLinkInput;
  syncedAt?: Date;
  summary?: DistrictOfColumbiaFinanceSummaryInput;
  directBreakdowns?: readonly DistrictOfColumbiaFinanceDirectBreakdownInput[];
  outsideGroups?: readonly DistrictOfColumbiaFinanceOutsideGroupInput[];
  outsideGroupBreakdowns?: readonly DistrictOfColumbiaFinanceOutsideGroupBreakdownInput[];
  classifications?: readonly FinanceLabelClassification[];
};

export type DistrictOfColumbiaFinanceSnapshotWriteResult = StandardStateFinanceSnapshotWriteResult;

const writer = createStandardStateFinanceSnapshotWriter({
  label: "D.C.",
  minElectionYear: 2000,
  // COALESCE-every-column is the factory default, matching the bespoke writer.
  outsideGroupValidation: "pairing",
  linkIdentityColumns: { id: "committee_key" },
  outsideGroupIdentityColumns: { id: "committee_key" },
  tables: {
    links: "dc_candidate_finance_links",
    summaries: "dc_candidate_finance_summaries",
    directBreakdowns: "dc_candidate_finance_direct_breakdowns",
    outsideGroups: "dc_candidate_finance_outside_groups",
    outsideGroupBreakdowns: "dc_candidate_finance_outside_group_breakdowns",
  },
});

// The bespoke writer normalized committee keys in the OUTSIDE tables only —
// the link's committee key is written raw-trimmed. That is why the factory's
// normalizeCommitteeId option (which would also normalize the link key) is not
// used; the wrapper normalizes the outside keys itself in the field mapping.
function normalizeCommitteeKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

function requireNonEmpty(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmed;
}

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new Error(`Invalid D.C. finance election year: ${value}`);
  }
  return value;
}

function normalizePublicFundsReceived(value: number | null | undefined): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("D.C. public funds received must be a nonnegative number");
  }
  return value;
}

function validateNullableDate(value: Date | null | undefined): void {
  if (value && Number.isNaN(value.getTime())) {
    throw new Error("Invalid D.C. finance timestamp");
  }
}

// The factory's link validation covers the same fields, but the bespoke writer
// called the identity a "committee key" where the factory says "committee id"
// — so the wrapper validates first with the legacy nouns and the factory's own
// check never fires on input that passes here.
function validateDistrictOfColumbiaFinanceLinkInput(link: DistrictOfColumbiaFinanceLinkInput): void {
  requireNonEmpty(link.candidateId, "candidate id");
  requireNonEmpty(link.electionId, "election id");
  normalizeElectionYear(link.electionYear);
  requireNonEmpty(link.candidateNameNormalized, "D.C. finance candidate name");
  requireNonEmpty(link.officeName, "D.C. finance office name");
  requireNonEmpty(link.committeeKey, "D.C. committee key");
  requireNonEmpty(link.committeeName, "D.C. committee name");
  validateNullableDate(link.lastVerifiedAt);
}

function outsideGroupKey(
  group: Pick<DistrictOfColumbiaFinanceOutsideGroupInput, "committeeKey" | "supportOppose">
): string {
  return `${normalizeCommitteeKey(group.committeeKey)}\u0000${group.supportOppose}`;
}

// The factory's pairing validation covers the same inputs, but the bespoke
// writer phrased its errors differently ("require matching...") and — unlike
// the factory — throws the pairing message, not the presence message, when the
// groups list is present but empty. Per-state tests pin that, so the wrapper
// validates first with the legacy semantics; the factory's pairing check then
// acts as a backstop and never fires on input that passes here.
function validateDistrictOfColumbiaFinanceSnapshotInput(input: DistrictOfColumbiaFinanceSnapshotInput): void {
  validateDistrictOfColumbiaFinanceLinkInput(input.link);
  if (input.outsideGroupBreakdowns && !input.outsideGroups) {
    throw new Error("D.C. outside group breakdowns require outside groups in the same snapshot");
  }
  if (input.outsideGroupBreakdowns?.length) {
    const groupKeys = new Set((input.outsideGroups ?? []).map(outsideGroupKey));
    for (const breakdown of input.outsideGroupBreakdowns) {
      if (!groupKeys.has(outsideGroupKey(breakdown))) {
        throw new Error("D.C. outside group breakdowns require matching outside groups in the same snapshot");
      }
    }
  }
}

// D.C. snapshot writes must receive a Pool: a bare queryable without connect()
// is rejected instead of taking the factory's inline-transaction path. The
// stub throws on first use rather than up front so that input validation
// errors still surface before the transaction-contract error.
function requireDistrictOfColumbiaPool(db: Queryable): Queryable {
  const candidate = db as { connect?: unknown; release?: unknown };
  if (typeof candidate.connect === "function" || typeof candidate.release === "function") {
    return db;
  }
  const rejectQuery = () => {
    throw new Error("D.C. finance snapshot writes must receive a Pool");
  };
  return { query: rejectQuery as unknown as Queryable["query"] };
}

function toFactoryLink(link: DistrictOfColumbiaFinanceLinkInput): StandardStateFinanceLinkInput {
  const { committeeKey, ...rest } = link;
  return { ...rest, committeeId: committeeKey };
}

export async function upsertDistrictOfColumbiaFinanceLink(input: {
  db: Queryable;
  link: DistrictOfColumbiaFinanceLinkInput;
}): Promise<{ linkId: string }> {
  validateDistrictOfColumbiaFinanceLinkInput(input.link);
  return writer.upsertLink({ db: input.db, link: toFactoryLink(input.link) });
}

export async function replaceDistrictOfColumbiaCandidateFinanceSnapshot(
  input: DistrictOfColumbiaFinanceSnapshotInput
): Promise<DistrictOfColumbiaFinanceSnapshotWriteResult> {
  const syncedAt = input.syncedAt ?? new Date();
  if (Number.isNaN(syncedAt.getTime())) {
    throw new Error("Invalid D.C. finance sync timestamp");
  }
  validateDistrictOfColumbiaFinanceSnapshotInput(input);
  const publicFundsReceived = normalizePublicFundsReceived(input.summary?.publicFundsReceived);
  return writer.replaceSnapshot({
    ...input,
    afterSummaryWrite: async ({ db, linkId, electionYear }) => {
      await db.query(
        `UPDATE public.dc_candidate_finance_summaries
            SET public_funds_received = $3
          WHERE link_id = $1::uuid AND election_year = $2`,
        [linkId, electionYear, publicFundsReceived]
      );
    },
    syncedAt,
    db: requireDistrictOfColumbiaPool(input.db),
    link: toFactoryLink(input.link),
    outsideGroups: input.outsideGroups?.map((group) => ({
      committeeId: normalizeCommitteeKey(group.committeeKey),
      committeeName: group.committeeName,
      supportOppose: group.supportOppose,
      amount: group.amount,
      sourceUrl: group.sourceUrl,
    })),
    outsideGroupBreakdowns: input.outsideGroupBreakdowns?.map((breakdown) => ({
      committeeId: normalizeCommitteeKey(breakdown.committeeKey),
      supportOppose: breakdown.supportOppose,
      categoryType: breakdown.categoryType,
      categoryName: breakdown.categoryName,
      amount: breakdown.amount,
      contributorCount: breakdown.contributorCount,
      sourceUrl: breakdown.sourceUrl,
    })),
  });
}
