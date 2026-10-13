// South Carolina finance snapshot writer (docs/plans/plan-south-carolina-finance.md,
// Phase 4). Thin wrapper over the standard state-finance writer. Identity:
// the Ethics API's positive integer candidateFilerId, stored as text in
// candidate_filer_id (id 0 marks SEI-only filers with no candidate account
// and must never be linked). This candidate-only path acquires no outside
// evidence. Omitted outside components preserve stored totals and groups.
//
// Presence semantics live in the caller (Phase 5 sync): the writer is only
// called with filed data or a filed-zero snapshot; source-unavailable and
// no-filing-yet outcomes skip the write entirely so the prior snapshot is
// preserved.

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

export type SouthCarolinaFinanceLinkStatus = StandardStateFinanceLinkStatus;
export type SouthCarolinaFinanceLinkSource = "manual" | "ethics_filer_search";
export type SouthCarolinaFinanceDirectCategoryType =
  StandardStateFinanceDirectCategoryType;

export type SouthCarolinaFinanceLinkInput = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  candidateNameNormalized: string;
  officeName: string;
  district?: string | null;
  candidateFilerId: number;
  filerName: string;
  linkStatus?: SouthCarolinaFinanceLinkStatus;
  linkSource?: SouthCarolinaFinanceLinkSource;
  sourceUrl?: string | null;
  lastVerifiedAt?: Date | null;
};

// NULL amounts preserve stored data; zero means a filed-zero snapshot.
//
// The aggregator's per-candidate directCoverageNote is deliberately not
// persisted: the standard table family carries no note column, and display
// uses a static source-wide directCoverageNote declared in the Phase 6
// ballot-lookup loader (the Missouri/New Hampshire pattern — the SC note copy
// is worded to hold for every candidate). The per-candidate note remains a
// Phase 5 sync diagnostic only.
export type SouthCarolinaFinanceSummaryInput = {
  totalReceipts: number | null;
  directContributionTotal: number | null;
  totalDisbursements: number | null;
  /** Signed ending balance — an indebted campaign can report negative cash. */
  cashOnHand: number | null;
  sourceUrl: string | null;
};

export type SouthCarolinaFinanceDirectBreakdownInput =
  StandardStateFinanceDirectBreakdownInput;

/** Source-reported organization group; the reported namespace is not a legal PAC ID. */
export type SouthCarolinaFinancePacDonorInput = {
  committeeId: string;
  committeeName: string;
  amount: number;
  contributionCount: number;
  sourceUrl?: string | null;
  recognitionMethod: "political_name_hint";
  sourceReportedClass: "group_yes";
};

export type SouthCarolinaFinanceSnapshotInput = {
  db: ConnectableQueryable;
  link: SouthCarolinaFinanceLinkInput;
  syncedAt?: Date;
  summary?: SouthCarolinaFinanceSummaryInput;
  /** Omit when unavailable; pass [] after a successful run with no breakdowns. */
  directBreakdowns?: readonly SouthCarolinaFinanceDirectBreakdownInput[];
  /** Omitted preserves; [] replaces only after a complete verified source run. */
  pacDonors?: readonly SouthCarolinaFinancePacDonorInput[];
};

export type SouthCarolinaFinanceSnapshotWriteResult =
  StandardStateFinanceSnapshotWriteResult & {
    pacDonorsWritten?: number;
  };

function normalizeCandidateFilerId(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid South Carolina candidate filer ID: ${value}`);
  }
  return String(value);
}

function normalizeStoredCandidateFilerId(value: string): string {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`Invalid South Carolina candidate filer ID: ${value}`);
  }
  return value;
}

const writer = createStandardStateFinanceSnapshotWriter({
  label: "South Carolina",
  // Oldest election run observed live on the Ethics API (2008 primaries).
  minElectionYear: 2008,
  // The ending "Campaign Funds" balance is report-cover arithmetic; an
  // indebted campaign can legitimately report negative cash (migration 260
  // leaves cash_on_hand unconstrained).
  allowNegativeCashOnHand: true,
  normalizeCommitteeId: normalizeStoredCandidateFilerId,
  manualLinkProtection: true,
  supersededLinkSource: "ethics_filer_search",
  linkIdentityColumns: {
    id: "candidate_filer_id",
    name: "candidate_filer_name",
  },
  tables: {
    links: "sc_candidate_finance_links",
    summaries: "sc_candidate_finance_summaries",
    directBreakdowns: "sc_candidate_finance_direct_breakdowns",
    outsideGroups: "sc_candidate_finance_outside_groups",
    outsideGroupBreakdowns: "sc_candidate_finance_outside_group_breakdowns",
  },
});

function toStandardLink(link: SouthCarolinaFinanceLinkInput) {
  return {
    candidateId: link.candidateId,
    electionId: link.electionId,
    electionYear: link.electionYear,
    candidateNameNormalized: link.candidateNameNormalized,
    officeName: link.officeName,
    district: link.district,
    committeeId: normalizeCandidateFilerId(link.candidateFilerId),
    committeeName: link.filerName,
    linkStatus: link.linkStatus,
    linkSource: link.linkSource,
    sourceUrl: link.sourceUrl,
    lastVerifiedAt: link.lastVerifiedAt,
  };
}

export async function upsertSouthCarolinaFinanceLink(input: {
  db: Queryable;
  link: SouthCarolinaFinanceLinkInput;
}): Promise<{ linkId: string }> {
  return writer.upsertLink({ db: input.db, link: toStandardLink(input.link) });
}

export async function replaceSouthCarolinaCandidateFinanceSnapshot(
  input: SouthCarolinaFinanceSnapshotInput,
): Promise<SouthCarolinaFinanceSnapshotWriteResult> {
  // Snapshot every mutable caller field before the transaction's first await.
  const link = toStandardLink(structuredClone(input.link));
  const summary =
    input.summary === undefined ? undefined : structuredClone(input.summary);
  const directBreakdowns =
    input.directBreakdowns === undefined
      ? undefined
      : structuredClone(input.directBreakdowns);
  const syncedAt =
    input.syncedAt === undefined ? new Date() : new Date(input.syncedAt);
  const donors = input.pacDonors?.map((donor) => {
    const committeeName = donor.committeeName.trim();
    const key = committeeName
      .normalize("NFKC")
      .toUpperCase()
      .replace(/\s+/gu, " ")
      .trim();
    if (
      !key ||
      key.includes("\u0000") ||
      donor.committeeId !== "reported:" + key
    )
      throw new Error("Invalid South Carolina reported donor identity");
    if (
      donor.recognitionMethod !== "political_name_hint" ||
      donor.sourceReportedClass !== "group_yes"
    )
      throw new Error("Invalid South Carolina donor recognition source");
    const money = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(donor.amount));
    const cents = money
      ? BigInt(money[2]!) * 100n +
        BigInt((money[3] ?? "").padEnd(2, "0") || "0")
      : null;
    if (
      !Number.isFinite(donor.amount) ||
      cents === null ||
      cents > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new Error(
        "South Carolina donor amount must be signed exact safe cents",
      );
    if (
      !Number.isInteger(donor.contributionCount) ||
      donor.contributionCount <= 0 ||
      donor.contributionCount > 2147483647
    )
      throw new Error(
        "South Carolina donor contribution count must be a positive database integer",
      );
    return {
      committeeId: donor.committeeId,
      committeeName,
      amount: donor.amount,
      contributionCount: donor.contributionCount,
      sourceUrl: donor.sourceUrl?.trim() || null,
      recognitionMethod: donor.recognitionMethod,
      sourceReportedClass: donor.sourceReportedClass,
    };
  });
  if (
    donors &&
    new Set(donors.map((d) => d.committeeId)).size !== donors.length
  )
    throw new Error("Duplicate South Carolina reported donor identities");
  // Unavailable outside amounts preserve stored values; omitted arrays skip deletion.
  const result = await writer.replaceSnapshot({
    db: input.db,
    link,
    syncedAt,
    summary:
      summary === undefined
        ? undefined
        : { ...summary, outsideSupportTotal: null, outsideOpposeTotal: null },
    directBreakdowns,
    ...(donors === undefined
      ? {}
      : {
          afterSnapshotWrite: async ({
            db,
            linkId,
            electionYear,
            syncedAt,
          }) => {
            for (const donor of donors) {
              await db.query(
                `
            INSERT INTO public.sc_candidate_finance_pac_donors (
              link_id, election_year, committee_id, committee_name, amount,
              contribution_count, source_url, recognition_method, source_reported_class, last_synced_at
            ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)
            ON CONFLICT (link_id, election_year, committee_id) DO UPDATE SET
              committee_name = EXCLUDED.committee_name, amount = EXCLUDED.amount,
              contribution_count = EXCLUDED.contribution_count, source_url = EXCLUDED.source_url,
              recognition_method = EXCLUDED.recognition_method, source_reported_class = EXCLUDED.source_reported_class,
              last_synced_at = EXCLUDED.last_synced_at
          `,
                [
                  linkId,
                  electionYear,
                  donor.committeeId,
                  donor.committeeName,
                  donor.amount,
                  donor.contributionCount,
                  donor.sourceUrl,
                  donor.recognitionMethod,
                  donor.sourceReportedClass,
                  syncedAt.toISOString(),
                ],
              );
            }
            await db.query(
              `
          DELETE FROM public.sc_candidate_finance_pac_donors AS donor
          WHERE donor.link_id = $1::uuid AND donor.election_year = $2
            AND NOT (donor.committee_id = ANY($3::text[]))
        `,
              [linkId, electionYear, donors.map((d) => d.committeeId)],
            );
          },
        }),
  });
  return {
    ...result,
    ...(donors === undefined ? {} : { pacDonorsWritten: donors.length }),
  };
}
