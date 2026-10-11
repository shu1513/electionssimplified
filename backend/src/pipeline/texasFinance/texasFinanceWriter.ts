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
  type StandardStateFinanceSummaryInput,
  type StandardStateFinanceSupportOppose,
} from "../finance/standardStateFinanceSnapshotWriter.js";
import type { FinanceLabelClassification } from "../finance/financeLabelClassifier.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type TexasFinanceLinkStatus = StandardStateFinanceLinkStatus;
export type TexasFinanceLinkSource = "manual" | "tec_bulk";
export type TexasFinanceDirectCategoryType = StandardStateFinanceDirectCategoryType;
export type TexasFinanceOutsideCategoryType = StandardStateFinanceOutsideCategoryType;
export type TexasFinanceSupportOppose = StandardStateFinanceSupportOppose;

export type TexasFinanceLinkInput = Omit<StandardStateFinanceLinkInput, "linkSource"> & {
  linkSource?: TexasFinanceLinkSource;
};

export type TexasFinanceSummaryInput = StandardStateFinanceSummaryInput;
export type TexasFinanceDirectBreakdownInput = StandardStateFinanceDirectBreakdownInput;
export type TexasFinanceOutsideGroupInput = StandardStateFinanceOutsideGroupInput;
export type TexasFinanceOutsideGroupBreakdownInput = StandardStateFinanceOutsideGroupBreakdownInput;

export type TexasFinancePacDonorInput = {
  committeeId: string;
  committeeName: string;
  committeeType: string;
  totalAmount: number;
  contributionCount: number;
  sourceUrl?: string | null;
};

export type TexasFinanceSnapshotInput = {
  db: Queryable;
  link: TexasFinanceLinkInput;
  syncedAt?: Date;
  summary?: TexasFinanceSummaryInput;
  directBreakdowns?: readonly TexasFinanceDirectBreakdownInput[];
  outsideGroups?: readonly TexasFinanceOutsideGroupInput[];
  outsideGroupBreakdowns?: readonly TexasFinanceOutsideGroupBreakdownInput[];
  classifications?: readonly FinanceLabelClassification[];
  /** Omitted preserves existing rows; an explicit empty list clears them. */
  pacDonors?: readonly TexasFinancePacDonorInput[];
};

export type TexasFinanceSnapshotWriteResult = StandardStateFinanceSnapshotWriteResult & {
  pacDonorsWritten?: number;
};

const writer = createStandardStateFinanceSnapshotWriter({
  label: "Texas",
  minElectionYear: 2014,
  tables: {
    links: "tx_candidate_finance_links",
    summaries: "tx_candidate_finance_summaries",
    directBreakdowns: "tx_candidate_finance_direct_breakdowns",
    outsideGroups: "tx_candidate_finance_outside_groups",
    outsideGroupBreakdowns: "tx_candidate_finance_outside_group_breakdowns",
  },
});

export async function upsertTexasFinanceLink(input: {
  db: Queryable;
  link: TexasFinanceLinkInput;
}): Promise<{ linkId: string }> {
  return writer.upsertLink(input);
}

export async function replaceTexasCandidateFinanceSnapshot(
  input: TexasFinanceSnapshotInput
): Promise<TexasFinanceSnapshotWriteResult> {
  const donors = input.pacDonors?.map((donor) => {
    const committeeId = requireDonorText(donor.committeeId, "committee id");
    const committeeName = requireDonorText(donor.committeeName, "committee name");
    const committeeType = requireDonorText(donor.committeeType, "committee type");
    if (!Number.isFinite(donor.totalAmount) || donor.totalAmount <= 0) {
      throw new Error("Texas PAC donor amount must be a positive number");
    }
    if (!Number.isInteger(donor.contributionCount) || donor.contributionCount <= 0) {
      throw new Error("Texas PAC donor contribution count must be a positive integer");
    }
    return { ...donor, committeeId, committeeName, committeeType, sourceUrl: donor.sourceUrl?.trim() || null };
  });
  if (donors && new Set(donors.map((donor) => donor.committeeId)).size !== donors.length) {
    throw new Error("Texas PAC donor snapshot contains duplicate committee ids");
  }
  const result = await writer.replaceSnapshot({
    ...input,
    ...(donors === undefined ? {} : {
      afterSnapshotWrite: async ({ db, linkId, electionYear, syncedAt }) => {
        for (const donor of donors) {
          await db.query(`
            INSERT INTO public.tx_candidate_finance_pac_donors (
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
            donor.totalAmount, donor.contributionCount, donor.sourceUrl, syncedAt.toISOString()]);
        }
        await db.query(`
          DELETE FROM public.tx_candidate_finance_pac_donors AS donor
          WHERE donor.link_id = $1::uuid AND donor.election_year = $2
            AND NOT (donor.committee_id = ANY($3::text[]))
        `, [linkId, electionYear, donors.map((donor) => donor.committeeId)]);
      },
    }),
  });
  return { ...result, ...(donors === undefined ? {} : { pacDonorsWritten: donors.length }) };
}

function requireDonorText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Texas PAC donor ${field} is required`);
  return trimmed;
}
