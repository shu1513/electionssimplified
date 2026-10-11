// Arkansas finance snapshot writer (docs/plans/plan-arkansas-finance.md, Phase 1). Thin
// wrapper over the standard state-finance writer, mirroring New Hampshire
// (same Civix CFIS build) on identity and Alabama on the direct-only shape.
//
// Identity: the CFIS filer entity ID (registration-row filerEntityID = bulk
// CSV "Filing Entity ID") in filing_entity_id, with the filer display name in
// filer_name. Direct breakdowns are occupations or size buckets (migration
// 266). cash_on_hand is a signed balance (CFIS reports negative balances for
// indebted campaigns).
//
// Direct-only acquisitions do not establish outside-spending availability.
// Preserve existing outside totals and rows until a verified outside component
// is supplied through its own acquisition path.

import type { Pool, PoolClient } from "pg";
import { validateArkansasVerifiedOutsideEvidence, type ArkansasVerifiedOutsideEvidence } from "./arkansasVerifiedOutsideEvidence.js";
import { writeArkansasOutsideEvidence } from "./arkansasOutsideEvidenceWriter.js";
import {
  assertArkansasPacPriorAuthorityRetained,
  validateArkansasPacSnapshot,
  type ArkansasFinancePacDonor,
  type ArkansasPacSourceProvenance,
} from "./arkansasPacSourceEvidence.js";

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

export type ArkansasFinanceLinkStatus = StandardStateFinanceLinkStatus;
export type ArkansasFinanceLinkSource = "manual" | "cfis_registration";
export type ArkansasFinanceDirectCategoryType = StandardStateFinanceDirectCategoryType;

export const ARKANSAS_FINANCE_AUTOMATIC_LINK_SOURCE: ArkansasFinanceLinkSource = "cfis_registration";

export type ArkansasFinanceLinkInput = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  candidateNameNormalized: string;
  officeName: string;
  district?: string | null;
  /** CFIS filer entity ID (registration-row filerEntityID). */
  filingEntityId: number;
  filerName: string;
  linkStatus?: ArkansasFinanceLinkStatus;
  linkSource?: ArkansasFinanceLinkSource;
  sourceUrl?: string | null;
  lastVerifiedAt?: Date | null;
};

/** NULL amounts preserve stored data; zero means a successful empty result. */
export type ArkansasFinanceSummaryInput = {
  totalReceipts: number | null;
  directContributionTotal: number | null;
  totalDisbursements: number | null;
  /** Signed balance; negative means the campaign is indebted. */
  cashOnHand: number | null;
  sourceUrl: string | null;
};

export type ArkansasFinanceDirectBreakdownInput =
  StandardStateFinanceDirectBreakdownInput<ArkansasFinanceDirectCategoryType>;

export type ArkansasFinanceSnapshotInput = {
  db: ConnectableQueryable;
  link: ArkansasFinanceLinkInput;
  syncedAt?: Date;
  summary?: ArkansasFinanceSummaryInput;
  /** Omit when unavailable; pass [] after a successful fetch with no breakdowns. */
  directBreakdowns?: readonly ArkansasFinanceDirectBreakdownInput[];
  /** A paired verified snapshot; omit both fields to preserve stored PACs. */
  pacDonors?: readonly ArkansasFinancePacDonor[];
  pacSourceProvenance?: ArkansasPacSourceProvenance;
  /** Positive verified payer scopes; omitted/empty never clears outside data. */
  outsideEvidence?: readonly ArkansasVerifiedOutsideEvidence[];
};

export type ArkansasFinanceSnapshotWriteResult = StandardStateFinanceSnapshotWriteResult & {
  pacDonorsWritten: number;
  outsideDiagnostics?: readonly string[];
};

function normalizeFilingEntityId(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid Arkansas filing entity ID: ${value}`);
  }
  return String(value);
}

function normalizeStoredFilingEntityId(value: string): string {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`Invalid Arkansas filing entity ID: ${value}`);
  }
  return value;
}

const writer = createStandardStateFinanceSnapshotWriter({
  label: "Arkansas",
  // Migration 266 constrains election_year to 2026+ (Nov-2026 scope).
  minElectionYear: 2026,
  allowNegativeCashOnHand: true,
  normalizeCommitteeId: normalizeStoredFilingEntityId,
  manualLinkProtection: true,
  supersededLinkSource: ARKANSAS_FINANCE_AUTOMATIC_LINK_SOURCE,
  linkIdentityColumns: {
    id: "filing_entity_id",
    name: "filer_name",
  },
  outsideGroupIdentityColumns: {
    id: "filing_entity_id",
    name: "filer_name",
  },
  tables: {
    links: "ar_candidate_finance_links",
    summaries: "ar_candidate_finance_summaries",
    directBreakdowns: "ar_candidate_finance_direct_breakdowns",
    outsideGroups: "ar_candidate_finance_outside_groups",
    outsideGroupBreakdowns: "ar_candidate_finance_outside_group_breakdowns",
  },
});

function toStandardLink(link: ArkansasFinanceLinkInput) {
  return {
    candidateId: link.candidateId,
    electionId: link.electionId,
    electionYear: link.electionYear,
    candidateNameNormalized: link.candidateNameNormalized,
    officeName: link.officeName,
    district: link.district,
    committeeId: normalizeFilingEntityId(link.filingEntityId),
    committeeName: link.filerName,
    linkStatus: link.linkStatus,
    linkSource: link.linkSource,
    sourceUrl: link.sourceUrl,
    lastVerifiedAt: link.lastVerifiedAt,
  };
}

export async function upsertArkansasFinanceLink(input: {
  db: Queryable;
  link: ArkansasFinanceLinkInput;
}): Promise<{ linkId: string }> {
  return writer.upsertLink({ db: input.db, link: toStandardLink(input.link) });
}

export async function replaceArkansasCandidateFinanceSnapshot(
  input: ArkansasFinanceSnapshotInput
): Promise<ArkansasFinanceSnapshotWriteResult> {
  // Retain the validated source generation across asynchronous database work.
  const link = structuredClone(input.link);
  const pacDonors = input.pacDonors === undefined ? undefined : structuredClone(input.pacDonors);
  const pacSourceProvenance = input.pacSourceProvenance === undefined ? undefined : structuredClone(input.pacSourceProvenance);
  const outsideEvidence = input.outsideEvidence === undefined ? [] : structuredClone(input.outsideEvidence);
  outsideEvidence.forEach(evidence => validateArkansasVerifiedOutsideEvidence(evidence, link));
  if ((input.pacDonors === undefined) !== (input.pacSourceProvenance === undefined)) {
    throw new Error("Arkansas PAC donors require paired source provenance");
  }
  const pac = pacDonors === undefined ? undefined : validateArkansasPacSnapshot({
    link, pacDonors, pacSourceProvenance,
  });
  const summary = input.summary ?? (pac || outsideEvidence.length ? {
    totalReceipts: null, directContributionTotal: null, totalDisbursements: null, cashOnHand: null, sourceUrl: null,
  } : undefined);
  const syncedAt = input.syncedAt ?? new Date();
  let outsideGroupsWritten = 0;
  let outsideDiagnostics: readonly string[] = [];
  const result = await writer.replaceSnapshot({
    db: input.db,
    link: toStandardLink(link),
    syncedAt,
    summary:
      summary === undefined
        ? undefined
        : { ...summary, outsideSupportTotal: null, outsideOpposeTotal: null },
    directBreakdowns: input.directBreakdowns,
    ...(pac || outsideEvidence.length ? { afterSummaryWrite: async ({ db, linkId, electionYear }: {
      db: Queryable; linkId: string; electionYear: number;
    }) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
        `arkansas-finance:${link.filingEntityId}:${electionYear}`,
      ]);
      const owners = await db.query(`SELECT id FROM public.ar_candidate_finance_links
        WHERE filing_entity_id = $1::text AND election_year = $2::integer
          AND link_status = 'active' AND candidate_id <> $3::uuid LIMIT 1`,
      [String(link.filingEntityId), electionYear, link.candidateId]);
      if (owners.rows.length) throw new Error("Arkansas finance filer has another active candidate owner");
      const prior = await db.query<{ pac_source_provenance: unknown; outside_report_provenance: unknown }>(`
        SELECT pac_source_provenance, outside_report_provenance FROM public.ar_candidate_finance_summaries
        WHERE link_id = $1::uuid AND election_year = $2::integer FOR UPDATE`, [linkId, electionYear]);
      if (prior.rows.length !== 1) throw new Error("Arkansas finance summary authority is missing");
      if (pac) {
      assertArkansasPacPriorAuthorityRetained(pac, prior.rows[0]!.pac_source_provenance);
      await db.query(`INSERT INTO public.ar_candidate_finance_pac_donors
        (link_id, election_year, committee_id, committee_name, committee_type, amount,
          contribution_count, source_url, last_synced_at, updated_at)
        SELECT $1::uuid, $2::integer, donor.committee_id, donor.committee_name, donor.committee_type,
          donor.amount, donor.contribution_count, donor.source_url, $4::timestamptz, $4::timestamptz
        FROM jsonb_to_recordset($3::jsonb) AS donor(committee_id text, committee_name text,
          committee_type text, amount numeric, contribution_count integer, source_url text)
        ON CONFLICT (link_id, election_year, committee_id) DO UPDATE SET
          committee_name = EXCLUDED.committee_name, committee_type = EXCLUDED.committee_type,
          amount = EXCLUDED.amount, contribution_count = EXCLUDED.contribution_count,
          source_url = EXCLUDED.source_url, last_synced_at = EXCLUDED.last_synced_at, updated_at = EXCLUDED.updated_at`,
      [linkId, electionYear, JSON.stringify(pacDonors!.map(donor => ({
        committee_id: donor.committeeId, committee_name: donor.committeeName, committee_type: donor.committeeType,
        amount: donor.amount, contribution_count: donor.contributionCount, source_url: donor.sourceUrl,
      }))), syncedAt]);
      await db.query(`DELETE FROM public.ar_candidate_finance_pac_donors
        WHERE link_id = $1::uuid AND election_year = $2::integer
          AND NOT (committee_id = ANY($3::text[]))`,
      [linkId, electionYear, pacDonors!.map(donor => donor.committeeId)]);
      await db.query(`UPDATE public.ar_candidate_finance_summaries SET pac_source_provenance = $3::jsonb
        WHERE link_id = $1::uuid AND election_year = $2::integer`, [linkId, electionYear, JSON.stringify(pac)]);
      }
      if (outsideEvidence.length) {
        const outside = await writeArkansasOutsideEvidence({ db, linkId, link, syncedAt,
          prior: prior.rows[0]!.outside_report_provenance, incoming: outsideEvidence });
        outsideGroupsWritten = outside.groupsWritten;
        outsideDiagnostics = outside.diagnostics;
      }
    } } : {}),
  });
  return { ...result, outsideGroupsWritten, pacDonorsWritten: pacDonors?.length ?? 0,
    ...(outsideDiagnostics.length ? { outsideDiagnostics } : {}) };
}
