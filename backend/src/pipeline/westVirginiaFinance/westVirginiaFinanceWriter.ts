// West Virginia finance snapshot writer (docs/plans/plan-west-virginia-finance.md,
// Phase 1). Thin wrapper over the standard state-finance writer. Identity:
// the registry `entityId` (10 digits, == bulk-CSV RegistrantID) in
// committee_id; the internal orgID is an acquisition key only.
//
// Missing outside acquisition preserves accepted totals/groups. Electronic
// regular-report IE uses explicit source provenance; paper coverage is separate.

import type { Pool, PoolClient } from "pg";

import {
  createStandardStateFinanceSnapshotWriter,
  type StandardStateFinanceDirectBreakdownInput,
  type StandardStateFinanceLinkStatus,
  type StandardStateFinanceSnapshotWriteResult,
  type StandardStateFinanceOutsideGroupInput,
} from "../finance/standardStateFinanceSnapshotWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & {
  connect: () => Promise<PoolClient>;
};

export const WEST_VIRGINIA_CFRS_SOURCE_URL = "https://cfrs.wvsos.gov/";

export type WestVirginiaFinanceLinkStatus = StandardStateFinanceLinkStatus;
export type WestVirginiaFinanceLinkSource = "manual" | "cfrs_registry";
export type WestVirginiaFinanceDirectCategoryType = "occupation" | "industry" | "contribution_size";

export type WestVirginiaFinanceLinkInput = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  candidateNameNormalized: string;
  officeName: string;
  district?: string | null;
  /** Registry entityId == bulk-CSV RegistrantID (10 digits). */
  entityId: string;
  committeeName: string;
  linkStatus?: WestVirginiaFinanceLinkStatus;
  linkSource?: WestVirginiaFinanceLinkSource;
  sourceUrl?: string | null;
  lastVerifiedAt?: Date | null;
};

export type WestVirginiaFinanceSummaryInput = {
  totalReceipts: number | null;
  directContributionTotal: number | null;
  totalDisbursements: number | null;
  sourceUrl: string | null;
  outsideSupportTotal?: number | null;
  outsideOpposeTotal?: number | null;
};

export type WestVirginiaFinanceDirectBreakdownInput =
  StandardStateFinanceDirectBreakdownInput<WestVirginiaFinanceDirectCategoryType>;

export type WestVirginiaFinancePacDonorInput = {
  committeeId: string;
  committeeName: string;
  committeeType: string;
  totalAmount: number;
  contributionCount: number;
  sourceUrl?: string | null;
};

export type WestVirginiaFinanceOutsideGroupInput = StandardStateFinanceOutsideGroupInput & {
  sourceTransactions: readonly Record<string, unknown>[];
};

export type WestVirginiaFinanceSnapshotInput = {
  db: ConnectableQueryable;
  link: WestVirginiaFinanceLinkInput;
  syncedAt?: Date;
  summary?: WestVirginiaFinanceSummaryInput;
  /** Omit to leave stored breakdowns alone; pass [] to clear them. */
  directBreakdowns?: readonly WestVirginiaFinanceDirectBreakdownInput[];
  /** Omitted preserves rows; complete validated [] clears them. */
  pacDonors?: readonly WestVirginiaFinancePacDonorInput[];
  /** Electronic scope only; missing/unproven empty acquisition stays omitted. */
  outsideGroups?: readonly WestVirginiaFinanceOutsideGroupInput[];
};

export type WestVirginiaFinanceSnapshotWriteResult = StandardStateFinanceSnapshotWriteResult & { pacDonorsWritten?: number };

/** Registry entityId / bulk RegistrantID: exactly ten digits ("1010003610"). */
export function normalizeWestVirginiaEntityId(value: string): string {
  const normalized = value.trim();
  if (!/^\d{10}$/.test(normalized)) {
    throw new Error(`Invalid West Virginia CFRS entityId: ${value}`);
  }
  return normalized;
}

const writer = createStandardStateFinanceSnapshotWriter<WestVirginiaFinanceDirectCategoryType>({
  label: "West Virginia",
  // Migration 267 constrains election_year to 2026+ (Nov-2026 scope).
  minElectionYear: 2026,
  directCategoryTypes: ["occupation", "industry", "contribution_size"],
  summaryUpdatePolicy: {
    // Direct totals are fully recomputed from reconciled cached artifacts.
    // Missing outside acquisition cannot displace an accepted snapshot.
    total_receipts: "replace",
    direct_contribution_total: "replace",
    total_disbursements: "replace",
    cash_on_hand: "replace",
    outside_support_total: "preserveWhenNull",
    outside_oppose_total: "preserveWhenNull",
    source_url: "replace",
  },
  normalizeCommitteeId: normalizeWestVirginiaEntityId,
  manualLinkProtection: true,
  supersededLinkSource: "cfrs_registry",
  tables: {
    links: "wv_candidate_finance_links",
    summaries: "wv_candidate_finance_summaries",
    directBreakdowns: "wv_candidate_finance_direct_breakdowns",
    outsideGroups: "wv_candidate_finance_outside_groups",
    outsideGroupBreakdowns: "wv_candidate_finance_outside_group_breakdowns",
  },
});

function toStandardLink(link: WestVirginiaFinanceLinkInput) {
  return {
    candidateId: link.candidateId,
    electionId: link.electionId,
    electionYear: link.electionYear,
    candidateNameNormalized: link.candidateNameNormalized,
    officeName: link.officeName,
    district: link.district,
    committeeId: normalizeWestVirginiaEntityId(link.entityId),
    committeeName: link.committeeName,
    linkStatus: link.linkStatus,
    linkSource: link.linkSource,
    sourceUrl: link.sourceUrl,
    lastVerifiedAt: link.lastVerifiedAt,
  };
}

export async function upsertWestVirginiaFinanceLink(input: {
  db: Queryable;
  link: WestVirginiaFinanceLinkInput;
}): Promise<{ linkId: string }> {
  return writer.upsertLink({ db: input.db, link: toStandardLink(input.link) });
}

export async function replaceWestVirginiaCandidateFinanceSnapshot(
  input: WestVirginiaFinanceSnapshotInput
): Promise<WestVirginiaFinanceSnapshotWriteResult> {
  const donors = input.pacDonors?.map((donor) => {
    const committeeId = normalizeWestVirginiaEntityId(donor.committeeId);
    const committeeName = donor.committeeName.trim();
    const committeeType = donor.committeeType.trim();
    if (!["102", "103"].includes(committeeType) || !committeeId.startsWith(committeeType)) {
      throw new Error("West Virginia committee donor must have a matching 102 or 103 source type");
    }
    if (!committeeName) throw new Error("West Virginia committee donor name is required");
    if (!Number.isFinite(donor.totalAmount) || donor.totalAmount <= 0 ||
        !Number.isSafeInteger(Math.round(donor.totalAmount * 100))) {
      throw new Error("West Virginia committee donor amount must be positive");
    }
    if (!Number.isSafeInteger(donor.contributionCount) || donor.contributionCount <= 0) {
      throw new Error("West Virginia committee donor count must be a positive integer");
    }
    return { ...donor, committeeId, committeeName, committeeType, sourceUrl: donor.sourceUrl?.trim() || null };
  });
  if (donors && new Set(donors.map((donor) => donor.committeeId)).size !== donors.length) {
    throw new Error("West Virginia committee donor snapshot contains duplicate ids");
  }
  if (input.outsideGroups?.length === 0) {
    throw new Error("West Virginia empty IE snapshot requires independent current-report proof");
  }
  for (const group of input.outsideGroups ?? []) {
    if (!Array.isArray(group.sourceTransactions) || group.sourceTransactions.length === 0) {
      throw new Error("West Virginia electronic outside groups require source transaction provenance");
    }
  }
  const result = await writer.replaceSnapshot({
    db: input.db,
    link: toStandardLink(input.link),
    syncedAt: input.syncedAt,
    summary: input.summary === undefined ? undefined : {
      ...input.summary,
      cashOnHand: null,
      outsideSupportTotal: input.summary.outsideSupportTotal ?? null,
      outsideOpposeTotal: input.summary.outsideOpposeTotal ?? null,
    },
    directBreakdowns: input.directBreakdowns,
    outsideGroups: input.outsideGroups,
    // No funding-donor extraction has been accepted for electronic IE.
    ...(input.outsideGroups === undefined ? {} : { outsideGroupBreakdowns: [] }),
    afterSnapshotWrite: async ({ db, linkId, electionYear, syncedAt }) => {
      for (const donor of donors ?? []) {
        await db.query(`
          INSERT INTO public.wv_candidate_finance_pac_donors (
            link_id, election_year, committee_id, committee_name, committee_type,
            amount, contribution_count, source_url, last_synced_at
          ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)
          ON CONFLICT (link_id, election_year, committee_id)
          DO UPDATE SET committee_name = EXCLUDED.committee_name,
            committee_type = EXCLUDED.committee_type, amount = EXCLUDED.amount,
            contribution_count = EXCLUDED.contribution_count, source_url = EXCLUDED.source_url,
            last_synced_at = EXCLUDED.last_synced_at
        `, [linkId, electionYear, donor.committeeId, donor.committeeName, donor.committeeType,
          donor.totalAmount, donor.contributionCount, donor.sourceUrl, syncedAt.toISOString()]);
      }
      if (donors !== undefined) {
        await db.query(`
          DELETE FROM public.wv_candidate_finance_pac_donors
          WHERE link_id = $1::uuid AND election_year = $2
            AND NOT (committee_id = ANY($3::text[]))
        `, [linkId, electionYear, donors.map((donor) => donor.committeeId)]);
      }
      if (input.outsideGroups !== undefined) {
        // IE belongs to the candidate/election. Keep one canonical receiving
        // link, atomically clearing sibling copies without touching receipts.
        await db.query(`
          DELETE FROM public.wv_candidate_finance_outside_group_breakdowns
          WHERE link_id IN (
            SELECT id FROM public.wv_candidate_finance_links
            WHERE candidate_id = $1::uuid AND election_id = $2::uuid
              AND link_status = 'active' AND id <> $3::uuid
          ) AND election_year = $4
        `, [input.link.candidateId, input.link.electionId, linkId, electionYear]);
        await db.query(`
          DELETE FROM public.wv_candidate_finance_outside_groups
          WHERE link_id IN (
            SELECT id FROM public.wv_candidate_finance_links
            WHERE candidate_id = $1::uuid AND election_id = $2::uuid
              AND link_status = 'active' AND id <> $3::uuid
          ) AND election_year = $4
        `, [input.link.candidateId, input.link.electionId, linkId, electionYear]);
        await db.query(`
          UPDATE public.wv_candidate_finance_summaries
          SET outside_support_total = NULL, outside_oppose_total = NULL
          WHERE link_id IN (
            SELECT id FROM public.wv_candidate_finance_links
            WHERE candidate_id = $1::uuid AND election_id = $2::uuid
              AND link_status = 'active' AND id <> $3::uuid
          ) AND election_year = $4
        `, [input.link.candidateId, input.link.electionId, linkId, electionYear]);
      }
      for (const group of input.outsideGroups ?? []) {
        await db.query(`
          UPDATE public.wv_candidate_finance_outside_groups
          SET source_transactions = $5::jsonb
          WHERE link_id = $1::uuid AND election_year = $2
            AND committee_id = $3 AND support_oppose = $4
        `, [linkId, electionYear, group.committeeId, group.supportOppose, JSON.stringify(group.sourceTransactions)]);
      }
    },
  });
  return { ...result, ...(donors === undefined ? {} : { pacDonorsWritten: donors.length }) };
}
