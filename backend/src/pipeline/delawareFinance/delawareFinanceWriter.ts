// Delaware finance snapshot writer (docs/plans/plan-delaware-finance.md, Phase 1).
// Thin wrapper over the standard state-finance writer. Identity: the public
// CF_ID (8 digits) is canonical — Phase 0 proved zero conflicts across the
// full registry. The portal's MemberID is an acquisition key only and never
// reaches these tables. Scoped financial-report outside proofs use the same
// snapshot transaction. Omitted outside data preserves stored totals, groups
// and breakdowns; caller-supplied outside headlines never authorize writes.

import type { Pool, PoolClient } from "pg";
import { writeDelawareOutsideEvidence } from "./delawareOutsideEvidenceWriter.js";
import type { DelawareVerifiedThirdPartyOutsideProof } from "./delawareThirdPartyOutsideSource.js";
import { writeDelawarePacEvidence, type DelawarePacEvidence } from "./delawarePacEvidenceWriter.js";

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
  outsideEvidence?: readonly DelawareVerifiedThirdPartyOutsideProof[];
  pacEvidence?: DelawarePacEvidence;
  /** A scoped cash refresh does not establish that another receiving account is obsolete. */
  linkReplacementPolicy?: "retain";
};

export type DelawareFinanceSnapshotWriteResult = StandardStateFinanceSnapshotWriteResult & {
  outsideDiagnostics?: readonly string[];
  pacDonorsWritten?: number;
  pacDiagnostics?: readonly string[];
};

/** CF_ID: exactly eight digits as issued by CFRS (e.g. "01005311"). */
export function normalizeDelawareCfId(value: string): string {
  const normalized = value.trim();
  if (!/^\d{8}$/.test(normalized)) {
    throw new Error(`Invalid Delaware CF_ID: ${value}`);
  }
  return normalized;
}

function createDelawareSnapshotWriter(supersededLinkSource?: string) {
  return createStandardStateFinanceSnapshotWriter({
    label: "Delaware",
    minElectionYear: 2026,
    summaryUpdatePolicy: {
      total_receipts: "replace",
      direct_contribution_total: "preserveWhenNull",
      total_disbursements: "replace",
      cash_on_hand: "replace",
      // A direct refresh provides no authority to replace outside amounts.
      outside_support_total: "preserveWhenNull",
      outside_oppose_total: "preserveWhenNull",
      source_url: "replace",
    },
    normalizeCommitteeId: normalizeDelawareCfId,
    supersededLinkSource,
    manualLinkProtection: true,
    tables: {
      links: "de_candidate_finance_links",
      summaries: "de_candidate_finance_summaries",
      directBreakdowns: "de_candidate_finance_direct_breakdowns",
      outsideGroups: "de_candidate_finance_outside_groups",
      outsideGroupBreakdowns: "de_candidate_finance_outside_group_breakdowns",
    },
  });
}
const writer = createDelawareSnapshotWriter("cfrs_portal");
const scopedWriter = createDelawareSnapshotWriter();

export async function upsertDelawareFinanceLink(input: {
  db: Queryable;
  link: DelawareFinanceLinkInput;
}): Promise<{ linkId: string }> {
  return writer.upsertLink(input);
}

export async function replaceDelawareCandidateFinanceSnapshot(
  input: DelawareFinanceSnapshotInput
): Promise<DelawareFinanceSnapshotWriteResult> {
  const link = structuredClone(input.link);
  const outsideEvidence = structuredClone(input.outsideEvidence ?? []);
  const pacEvidence = input.pacEvidence === undefined ? undefined : structuredClone(input.pacEvidence);
  const syncedAt = input.syncedAt ?? new Date();
  let outsideGroupsWritten = 0;
  let outsideDiagnostics: readonly string[] = [];
  let pacDonorsWritten = 0;
  let pacDiagnostics: readonly string[] = [];
  // Select only supported direct fields, including at the runtime boundary:
  // neither caller-supplied outside scalars nor extra outside arrays authorize
  // an outside write. Unknown outside components stay omitted.
  const snapshotWriter = outsideEvidence.length || pacEvidence !== undefined || input.linkReplacementPolicy === "retain"
    ? scopedWriter : writer;
  const result = await snapshotWriter.replaceSnapshot({
    db: input.db,
    link,
    syncedAt,
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
    ...(outsideEvidence.length || pacEvidence !== undefined ? { afterSnapshotWrite: async ({ db, linkId, electionYear }: {
      db: Queryable; linkId: string; electionYear: number;
    }) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
        `delaware-finance:${normalizeDelawareCfId(link.committeeId)}:${electionYear}`,
      ]);
      const owners = await db.query(`SELECT id FROM public.de_candidate_finance_links
        WHERE committee_id = $1::text AND election_year = $2::integer
          AND link_status = 'active' AND candidate_id <> $3::uuid LIMIT 1`,
      [normalizeDelawareCfId(link.committeeId), electionYear, link.candidateId]);
      if (owners.rows.length) throw new Error("Delaware finance committee has another active candidate owner");
      // An outside-only update creates no direct monetary totals and never
      // refreshes an existing direct summary's timestamp or source URL.
      await db.query(`INSERT INTO public.de_candidate_finance_summaries
        (link_id, election_year, source_url, last_synced_at)
        VALUES ($1::uuid, $2::integer, $3::text, $4::timestamptz)
        ON CONFLICT (link_id, election_year) DO NOTHING`,
      [linkId, electionYear, link.sourceUrl ?? null, syncedAt]);
      const prior = await db.query<{ pac_source_provenance: unknown; outside_report_provenance: unknown }>(`
        SELECT pac_source_provenance, outside_report_provenance FROM public.de_candidate_finance_summaries
        WHERE link_id = $1::uuid AND election_year = $2::integer FOR UPDATE`, [linkId, electionYear]);
      if (prior.rows.length !== 1) throw new Error("Delaware finance summary authority is missing");
      if (pacEvidence !== undefined) {
        const pac = await writeDelawarePacEvidence({
          db, linkId, link, syncedAt, prior: prior.rows[0]!.pac_source_provenance, incoming: pacEvidence,
        });
        pacDonorsWritten = pac.donorsWritten;
        pacDiagnostics = pac.diagnostics;
      }
      if (outsideEvidence.length) {
        const outside = await writeDelawareOutsideEvidence({
          db, linkId, link, syncedAt, prior: prior.rows[0]!.outside_report_provenance, incoming: outsideEvidence,
        });
        outsideGroupsWritten = outside.groupsWritten;
        outsideDiagnostics = outside.diagnostics;
      }
    } } : {}),
  });
  return { ...result, outsideGroupsWritten,
    ...(outsideDiagnostics.length ? { outsideDiagnostics } : {}),
    ...(pacEvidence !== undefined ? { pacDonorsWritten } : {}),
    ...(pacDiagnostics.length ? { pacDiagnostics } : {}) };
}
