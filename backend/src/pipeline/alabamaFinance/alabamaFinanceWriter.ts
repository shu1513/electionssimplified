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

export type AlabamaFinancePacDonorInput = {
  /** Public FCPA committee number, not the portal internal committee id. */
  committeeId: string;
  committeeName: string;
  committeeType: "Political Action Committee";
  amount: number;
  contributionCount: number;
  sourceUrl?: string | null;
};

export type AlabamaFinanceSnapshotInput = {
  db: ConnectableQueryable;
  link: AlabamaFinanceLinkInput;
  syncedAt?: Date;
  summary?: AlabamaFinanceSummaryInput;
  /** Omit when buckets are gated off; pass [] to clear stored buckets. */
  directBreakdowns?: readonly AlabamaFinanceDirectBreakdownInput[];
  /** Omitted preserves donors; [] clears only a complete accepted source snapshot. */
  pacDonors?: readonly AlabamaFinancePacDonorInput[];
};

export type AlabamaFinanceSnapshotWriteResult = StandardStateFinanceSnapshotWriteResult & {
  pacDonorsWritten?: number;
};

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
  const donors = input.pacDonors?.map((donor) => {
    const committeeId = donor.committeeId.trim();
    if (!/^[1-9]\d*$/.test(committeeId) || !Number.isSafeInteger(Number(committeeId))) {
      throw new Error("Invalid Alabama PAC donor public committee id");
    }
    const committeeName = donor.committeeName.trim();
    if (!committeeName) throw new Error("Alabama PAC donor committee name is required");
    if (donor.committeeType !== "Political Action Committee") {
      throw new Error("Alabama PAC donor must have an explicit Political Action Committee source type");
    }
    // Decimal text accepts cent values such as 0.29 without binary rounding.
    const money = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(donor.amount));
    const cents = money
      ? BigInt(money[1]!) * 100n + BigInt((money[2] ?? "").padEnd(2, "0") || "0")
      : 0n;
    if (!Number.isFinite(donor.amount) || cents <= 0n || cents > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Alabama PAC donor amount must be positive exact safe cents");
    }
    if (!Number.isSafeInteger(donor.contributionCount) ||
        donor.contributionCount <= 0 || donor.contributionCount > 2_147_483_647) {
      throw new Error("Alabama PAC donor contribution count must be a positive database integer");
    }
    return { ...donor, committeeId, committeeName, sourceUrl: donor.sourceUrl?.trim() || null };
  });
  if (donors && new Set(donors.map((donor) => donor.committeeId)).size !== donors.length) {
    throw new Error("Alabama PAC donor snapshot contains duplicate public committee ids");
  }
  const result = await writer.replaceSnapshot({
    db: input.db,
    link: toStandardLink(input.link),
    syncedAt: input.syncedAt,
    summary: input.summary,
    directBreakdowns: input.directBreakdowns,
    ...(donors === undefined ? {} : {
      afterSnapshotWrite: async ({ db, linkId, electionYear, syncedAt }) => {
        for (const donor of donors) {
          await db.query(`
            INSERT INTO public.al_candidate_finance_pac_donors (
              link_id, election_year, committee_id, committee_name, committee_type,
              amount, contribution_count, source_url, last_synced_at
            )
            VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)
            ON CONFLICT (link_id, election_year, committee_id)
            DO UPDATE SET committee_name = EXCLUDED.committee_name,
              committee_type = EXCLUDED.committee_type, amount = EXCLUDED.amount,
              contribution_count = EXCLUDED.contribution_count, source_url = EXCLUDED.source_url,
              last_synced_at = EXCLUDED.last_synced_at
          `, [linkId, electionYear, donor.committeeId, donor.committeeName, donor.committeeType,
            donor.amount, donor.contributionCount, donor.sourceUrl, syncedAt.toISOString()]);
        }
        await db.query(`
          DELETE FROM public.al_candidate_finance_pac_donors AS donor
          WHERE donor.link_id = $1::uuid AND donor.election_year = $2
            AND NOT (donor.committee_id = ANY($3::text[]))
        `, [linkId, electionYear, donors.map((donor) => donor.committeeId)]);
      },
    }),
  });
  return { ...result, ...(donors === undefined ? {} : { pacDonorsWritten: donors.length }) };
}
