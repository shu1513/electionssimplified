import type { Pool, PoolClient } from "pg";

import {
  createStandardStateFinanceSnapshotWriter,
  type StandardStateFinanceSnapshotWriteResult,
} from "../finance/standardStateFinanceSnapshotWriter.js";
import { nevadaFilerKey } from "./nevadaAuroraCsv.js";
import { nevadaDistrictNumberFromName } from "./nevadaCandidateFilerResolver.js";
import { isNevadaFinanceEligibleOffice } from "./nevadaFinanceEligibleOffices.js";
import { isNevadaReportedPacName } from "./nevadaPacDonorAggregator.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & {
  connect: () => Promise<PoolClient>;
};

export type NevadaFinanceLinkStatus = "active" | "inactive";
export type NevadaFinanceLinkSource = "manual" | "aurora_search";
export type NevadaFinanceDirectCategoryType = "industry" | "contribution_size";

export type NevadaFinanceLinkInput = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  candidateNameNormalized: string;
  officeName: string;
  district?: string | null;
  /** AURORA filer display name; the stored key is its normalized form. */
  filerName: string;
  linkStatus?: NevadaFinanceLinkStatus;
  linkSource?: NevadaFinanceLinkSource;
  sourceUrl?: string | null;
  lastVerifiedAt?: Date | null;
};

/** NULL amounts preserve stored data; zero means a successful empty result. */
export type NevadaFinanceSummaryInput = {
  totalReceipts: number | null;
  directContributionTotal: number | null;
  totalDisbursements: number | null;
  cashOnHand: number | null;
  sourceUrl: string | null;
};

export type NevadaFinanceDirectBreakdownInput = {
  categoryType: NevadaFinanceDirectCategoryType;
  categoryName: string;
  amount: number;
  contributorCount?: number | null;
  sourceUrl?: string | null;
};

export type NevadaFinancePacDonorInput = {
  committeeId: string;
  committeeName: string;
  recognitionMethod: "registry_name" | "reported_name";
  totalAmount: number;
  contributionCount: number;
  sourceUrl: string;
};

export type NevadaFinancePacDonorSource = {
  observedAt: Date;
  periodStart: string;
  periodEnd: string;
  captureDigest: string;
};

export type NevadaFinanceSnapshotInput = {
  db: ConnectableQueryable;
  link: NevadaFinanceLinkInput;
  syncedAt?: Date;
  summary?: NevadaFinanceSummaryInput;
  /** Omit when unavailable; pass [] after a successful run with no breakdowns. */
  directBreakdowns?: readonly NevadaFinanceDirectBreakdownInput[];
  /** Both omitted preserves donors; complete [] still advances its source watermark. */
  pacDonors?: readonly NevadaFinancePacDonorInput[];
  pacDonorSource?: NevadaFinancePacDonorSource;
};

export type NevadaFinanceSnapshotWriteResult =
  StandardStateFinanceSnapshotWriteResult & {
    pacDonorsWritten?: number;
  };

function normalizeStoredFilerKey(value: string): string {
  const normalized = nevadaFilerKey(value);
  if (normalized.length === 0) {
    throw new Error(`Invalid Nevada filer key ${JSON.stringify(value)}`);
  }
  return normalized;
}

// This integration has no verified allocated IE source. Outside remains omitted;
// vendor expenses or an IE filer class do not supply candidate-level spending.
const writer =
  createStandardStateFinanceSnapshotWriter<NevadaFinanceDirectCategoryType>({
    label: "Nevada",
    minElectionYear: 2004,
    directCategoryTypes: ["industry", "contribution_size"],
    summaryUpdatePolicy: {
      total_receipts: "preserveWhenNull",
      direct_contribution_total: "preserveWhenNull",
      total_disbursements: "preserveWhenNull",
      cash_on_hand: "preserveWhenNull",
      source_url: "preserveWhenNull",
    },
    normalizeCommitteeId: normalizeStoredFilerKey,
    manualLinkProtection: true,
    supersededLinkSource: "aurora_search",
    linkIdentityColumns: {
      id: "filer_key",
      name: "filer_name",
    },
    outsideGroupIdentityColumns: {
      id: "filer_key",
      name: "filer_name",
    },
    tables: {
      links: "nv_candidate_finance_links",
      summaries: "nv_candidate_finance_summaries",
      directBreakdowns: "nv_candidate_finance_direct_breakdowns",
      outsideGroups: "nv_candidate_finance_outside_groups",
      outsideGroupBreakdowns: "nv_candidate_finance_outside_group_breakdowns",
    },
  });

function toStandardLink(link: NevadaFinanceLinkInput) {
  return {
    candidateId: link.candidateId,
    electionId: link.electionId,
    electionYear: link.electionYear,
    candidateNameNormalized: link.candidateNameNormalized,
    officeName: link.officeName,
    district: link.district,
    committeeId: normalizeStoredFilerKey(link.filerName),
    committeeName: link.filerName,
    linkStatus: link.linkStatus,
    linkSource: link.linkSource,
    sourceUrl: link.sourceUrl,
    lastVerifiedAt: link.lastVerifiedAt,
  };
}

export async function upsertNevadaFinanceLink(input: {
  db: Queryable;
  link: NevadaFinanceLinkInput;
}): Promise<{ linkId: string }> {
  return writer.upsertLink({ db: input.db, link: toStandardLink(input.link) });
}

function requireCivilDate(value: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  ) {
    throw new Error("Invalid Nevada PAC source civil date");
  }
}

function normalizeReportedName(value: string): string {
  return value.normalize("NFKC").toUpperCase().replace(/\s+/g, " ").trim();
}

function validatePacDonors(
  donors: readonly NevadaFinancePacDonorInput[],
): void {
  const ids = new Set<string>();
  for (const donor of donors) {
    const reportedName = normalizeReportedName(donor.committeeName);
    const identityMatches = donor.committeeId === `reported:${reportedName}`;
    const recognized =
      donor.recognitionMethod === "registry_name" ||
      (donor.recognitionMethod === "reported_name" &&
        isNevadaReportedPacName(donor.committeeName));
    const amount = /^-?(\d+)(?:\.(\d{1,2}))?$/.exec(String(donor.totalAmount));
    const cents = amount
      ? BigInt(amount[1]!) * 100n +
        BigInt((amount[2] ?? "").padEnd(2, "0") || "0")
      : undefined;
    let url: URL;
    try {
      url = new URL(donor.sourceUrl);
    } catch {
      throw new Error("Invalid Nevada PAC source URL");
    }
    if (
      !reportedName ||
      !identityMatches ||
      !recognized ||
      ids.has(donor.committeeId) ||
      !Number.isFinite(donor.totalAmount) ||
      cents === undefined ||
      cents > BigInt(Number.MAX_SAFE_INTEGER) ||
      !Number.isSafeInteger(donor.contributionCount) ||
      donor.contributionCount < 0 ||
      url.protocol !== "https:" ||
      url.hostname !== "www.nvsos.gov" ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !==
        "/SOSCandidateServices/AnonymousAccess/CEFDSearchUU/Search.aspx" ||
      url.search
    ) {
      throw new Error(
        "Invalid Nevada committee donor identity, amount or source",
      );
    }
    ids.add(donor.committeeId);
  }
}

type PacLinkGuardRow = {
  id: string;
  election_year: number;
  candidate_name_normalized: string;
  office_name: string;
  district: string | null;
  filer_key: string;
  filer_name: string;
  source_url: string | null;
  link_source: NevadaFinanceLinkSource;
  last_verified_at: string | null;
  office_scope: string;
  canonical_office_name: string;
  district_type: string;
  geoid_compact: string;
};

export async function replaceNevadaCandidateFinanceSnapshot(
  input: NevadaFinanceSnapshotInput,
): Promise<NevadaFinanceSnapshotWriteResult> {
  if (
    (input.pacDonors === undefined) !==
    (input.pacDonorSource === undefined)
  ) {
    throw new Error(
      "Nevada PAC donors and source watermark must be supplied together",
    );
  }
  const link = {
    ...input.link,
    lastVerifiedAt:
      input.link.lastVerifiedAt == null
        ? input.link.lastVerifiedAt
        : new Date(input.link.lastVerifiedAt.getTime()),
  };
  const donors = input.pacDonors?.map((donor) => ({ ...donor }));
  const source = input.pacDonorSource && {
    ...input.pacDonorSource,
    observedAt: new Date(input.pacDonorSource.observedAt.getTime()),
  };
  if (donors !== undefined && source) {
    validatePacDonors(donors);
    requireCivilDate(source.periodStart);
    requireCivilDate(source.periodEnd);
    if (
      !Number.isFinite(source.observedAt.getTime()) ||
      !/^[a-f0-9]{64}$/.test(source.captureDigest) ||
      source.periodStart !== `${link.electionYear - 1}-01-01` ||
      source.periodEnd < source.periodStart ||
      source.periodEnd > `${link.electionYear}-12-31`
    )
      throw new Error("Invalid Nevada PAC source watermark");
  }
  let guardedLinkId: string | undefined;
  const result = await writer.replaceSnapshot({
    db: input.db,
    link: toStandardLink(link),
    syncedAt: input.syncedAt,
    summary: input.summary,
    directBreakdowns: input.directBreakdowns,
    ...(donors === undefined || !source
      ? {}
      : {
          beforeSnapshotWrite: async ({ db }: { db: Queryable }) => {
            await db.query(
              "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
              [`nv-pac:${link.candidateId}:${link.electionId}`],
            );
            const guard = await db.query<PacLinkGuardRow>(
              `
          SELECT link.id::text, link.election_year, link.candidate_name_normalized, link.office_name,
            link.district, link.filer_key, link.filer_name, link.source_url, link.link_source, link.last_verified_at::text,
            office.scope AS office_scope, office.canonical_name AS canonical_office_name,
            district.district_type, district.geoid_compact
          FROM public.nv_candidate_finance_links link
          JOIN public.candidate_elections roster ON roster.candidate_id = link.candidate_id AND roster.election_id = link.election_id
          JOIN public.candidates candidate ON candidate.id = link.candidate_id
          JOIN public.elections election ON election.id = link.election_id
          JOIN public.offices office ON office.id = election.office_id
          JOIN public.districts district ON district.id = election.district_id
          WHERE link.candidate_id = $1::uuid AND link.election_id = $2::uuid AND link.link_status = 'active'
            AND candidate.deleted_at IS NULL AND roster.status = 'declared'
            AND district.state = 'NV' AND election.race_type = 'office' AND election.election_stage = 'general'
            AND EXTRACT(YEAR FROM election.election_date)::integer = $3::integer
          FOR UPDATE OF link, roster, candidate, election, office, district`,
              [link.candidateId, link.electionId, link.electionYear],
            );
            const existing = guard.rows[0];
            if (
              guard.rows.length !== 1 ||
              !existing ||
              existing.election_year !== link.electionYear ||
              existing.filer_key !== normalizeStoredFilerKey(link.filerName) ||
              existing.filer_name !== link.filerName ||
              existing.candidate_name_normalized !==
                link.candidateNameNormalized ||
              existing.office_name !== link.officeName ||
              existing.canonical_office_name !== link.officeName ||
              existing.district !== (link.district ?? null) ||
              existing.link_source !== (link.linkSource ?? "manual") ||
              existing.source_url !== (link.sourceUrl ?? null) ||
              (existing.last_verified_at === null
                ? null
                : Date.parse(existing.last_verified_at)) !==
                (link.lastVerifiedAt?.getTime() ?? null) ||
              (link.linkStatus !== undefined && link.linkStatus !== "active") ||
              !isNevadaFinanceEligibleOffice({
                officeScope: existing.office_scope,
                officeCanonicalName: existing.canonical_office_name,
              })
            ) {
              throw new Error(
                "Nevada PAC needs one unchanged active canonical receiving link",
              );
            }
            if (existing.office_scope === "statewide") {
              if (
                existing.district_type !== "statewide" ||
                existing.geoid_compact !== "32"
              )
                throw new Error("Nevada PAC statewide ownership mismatch");
            } else {
              const seat = /^32(\d{3})$/.exec(existing.geoid_compact);
              const maximum =
                existing.office_scope === "state_lower"
                  ? 42
                  : existing.office_scope === "state_upper"
                    ? 21
                    : 0;
              if (
                existing.district_type !== existing.office_scope ||
                !seat ||
                Number(seat[1]) < 1 ||
                Number(seat[1]) > maximum ||
                nevadaDistrictNumberFromName(existing.district) !==
                  Number(seat[1])
              )
                throw new Error("Nevada PAC seat ownership mismatch");
            }
            guardedLinkId = existing.id;
            const marker = await db.query<{
              observed_at: string;
              period_start: string;
              period_end: string;
              capture_digest: string;
            }>(
              `
          SELECT observed_at::text, period_start::text, period_end::text, capture_digest
          FROM public.nv_candidate_finance_pac_sources WHERE link_id = $1::uuid AND election_year = $2::integer FOR UPDATE`,
              [existing.id, link.electionYear],
            );
            if (marker.rows.length > 1)
              throw new Error("Nevada PAC source watermark ambiguity");
            const previous = marker.rows[0];
            if (
              previous &&
              (Date.parse(previous.observed_at) > source.observedAt.getTime() ||
                source.periodStart > previous.period_start ||
                source.periodEnd < previous.period_end ||
                (Date.parse(previous.observed_at) ===
                  source.observedAt.getTime() &&
                  (previous.capture_digest !== source.captureDigest ||
                    previous.period_start !== source.periodStart ||
                    previous.period_end !== source.periodEnd)))
            ) {
              throw new Error(
                "Nevada PAC source is older, shorter or conflicts with the stored watermark",
              );
            }
          },
          afterSnapshotWrite: async ({
            db,
            linkId,
            electionYear,
            syncedAt,
          }: {
            db: Queryable;
            linkId: string;
            electionYear: number;
            syncedAt: Date;
          }) => {
            if (linkId !== guardedLinkId)
              throw new Error(
                "Nevada PAC receiving link changed during replacement",
              );
            await db.query(
              `INSERT INTO public.nv_candidate_finance_pac_sources
          (link_id, election_year, observed_at, period_start, period_end, capture_digest)
          VALUES ($1::uuid, $2::integer, $3::timestamptz, $4::date, $5::date, $6)
          ON CONFLICT (link_id, election_year) DO UPDATE SET observed_at = EXCLUDED.observed_at,
            period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end, capture_digest = EXCLUDED.capture_digest`,
              [
                linkId,
                electionYear,
                source.observedAt.toISOString(),
                source.periodStart,
                source.periodEnd,
                source.captureDigest,
              ],
            );
            for (const donor of donors) {
              await db.query(
                `INSERT INTO public.nv_candidate_finance_pac_donors
            (link_id, election_year, committee_id, committee_name, recognition_method, amount, contribution_count, source_url, last_synced_at)
            VALUES ($1::uuid, $2::integer, $3, $4, $5, $6, $7::integer, $8, $9::timestamptz)
            ON CONFLICT (link_id, election_year, committee_id) DO UPDATE SET committee_name = EXCLUDED.committee_name,
              recognition_method = EXCLUDED.recognition_method, amount = EXCLUDED.amount, contribution_count = EXCLUDED.contribution_count,
              source_url = EXCLUDED.source_url, last_synced_at = EXCLUDED.last_synced_at`,
                [
                  linkId,
                  electionYear,
                  donor.committeeId,
                  donor.committeeName,
                  donor.recognitionMethod,
                  donor.totalAmount,
                  donor.contributionCount,
                  donor.sourceUrl,
                  syncedAt.toISOString(),
                ],
              );
            }
            await db.query(
              `DELETE FROM public.nv_candidate_finance_pac_donors
          WHERE link_id = $1::uuid AND election_year = $2::integer AND NOT (committee_id = ANY($3::text[]))`,
              [linkId, electionYear, donors.map((donor) => donor.committeeId)],
            );
          },
        }),
  });
  return {
    ...result,
    ...(donors === undefined ? {} : { pacDonorsWritten: donors.length }),
  };
}
