import type { Pool, PoolClient } from "pg";

import { createStandardStateFinanceDueListQuery } from "../finance/standardStateFinanceDueListQuery.js";
import {
  syncVermontCandidateFinance,
  type VermontCandidateFinanceSyncResult,
} from "./vermontCandidateFinanceSync.js";
import { VERMONT_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./vermontFinanceEligibleOffices.js";
import type { VermontCampaignFinanceClientOptions } from "./vermontCampaignFinanceClient.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & Pick<Pool, "connect">;

export type VermontCandidateFinanceDueRow = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district: string | null;
  filerRegistrationGuid: string;
  entityId: number | null;
  filerName: string;
  sourceUrl: string | null;
  lastSyncedAt: string | null;
};

export type VermontCandidateFinanceBatchSyncInput = {
  db: ConnectableQueryable;
  now?: Date;
  dryRun?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  vermontClientOptions?: VermontCampaignFinanceClientOptions;
  autoLinkMissingLinks?: boolean;
  syncVermontCandidateFinanceFn?: typeof syncVermontCandidateFinance;
};

export type VermontCandidateFinanceBatchSyncItemResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  filerRegistrationGuid: string;
  ok: boolean;
  result?: VermontCandidateFinanceSyncResult;
  error?: string;
};

export type VermontCandidateFinanceBatchSyncResult = {
  dryRun: boolean;
  now: string;
  staleAfterDays: number;
  maxCandidates: number;
  dueCandidateCount: number;
  selectedCandidateCount: number;
  syncedCandidateCount: number;
  failedCandidateCount: number;
  autoLinkAttemptedCount: number;
  autoLinkLinkedCount: number;
  autoLinkFailedCount: number;
  // Auto-link outcomes are reported separately so the due-sync counters
  // (selectedCandidateCount / syncedCandidateCount / failedCandidateCount)
  // stay internally consistent with `results`.
  autoLinkResults: VermontCandidateFinanceBatchSyncItemResult[];
  results: VermontCandidateFinanceBatchSyncItemResult[];
};

const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_STALE_AFTER_DAYS = 7;
// Keep one extra calendar day so UTC scheduler timing cannot skip election-night finance syncs.
const DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS = 1;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

function assertValidDate(date: Date, label: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid Vermont finance batch sync ${label}`);
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Vermont finance batch sync ${label}: ${value}`);
  }
  return normalized;
}

// Vermont links identify filers by registration GUID plus the numeric
// entity_id its auto-link path resolves.
export const listDueVermontCandidateFinanceSyncRows = createStandardStateFinanceDueListQuery({
  state: "VT",
  tables: {
    links: "vt_candidate_finance_links",
    summaries: "vt_candidate_finance_summaries",
  },
  eligibleOfficeKeys: VERMONT_FINANCE_ELIGIBLE_OFFICE_KEYS,
  linkColumns: ["filer_registration_guid", "entity_id", "filer_name"],
  mapRow: (row): VermontCandidateFinanceDueRow => ({
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    district: row.district,
    filerRegistrationGuid: row.filer_registration_guid as string,
    entityId: row.entity_id as number | null,
    filerName: row.filer_name as string,
    sourceUrl: row.source_url,
    lastSyncedAt: row.last_synced_at,
  }),
});

export type VermontFinanceAutoLinkCandidateElection = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district: string | null;
};

type VermontMissingFinanceLinkQueryRow = {
  candidate_id: string;
  election_id: string;
  candidate_name: string;
  election_year: number;
  office_scope: string;
  office_name: string;
  district: string | null;
};

// Auto-link is restricted to STATEWIDE offices: Vermont's transaction rows
// carry no district field and its office ids are flat per office type
// (State Senator = 6 for every district), so two same-name legislative
// candidates in different districts cannot be told apart — auto-linking them
// risks attaching another candidate's money. Legislative links need a
// district-aware source (or manual links) before they can be automated.
const VERMONT_AUTO_LINK_OFFICE_KEYS = VERMONT_FINANCE_ELIGIBLE_OFFICE_KEYS.filter((key) =>
  key.startsWith("statewide::")
);

// Deliberately uncapped: unmatched candidates never get a link, so a stable
// ORDER BY + LIMIT would retry the same unmatched prefix every run and starve
// the tail (the Pennsylvania PR #377 lesson). The statewide-office/window
// filters bound the result; maxCandidates still caps the due sync.
export async function listVermontCandidateElectionsMissingFinanceLinks(
  db: Queryable,
  input: {
    now: Date;
    electionLookbackDays: number;
    electionLookaheadDays: number;
  }
): Promise<VermontFinanceAutoLinkCandidateElection[]> {
  const result = await db.query<VermontMissingFinanceLinkQueryRow>(
    `
      SELECT
        candidate.id::text AS candidate_id,
        election.id::text AS election_id,
        COALESCE(
          NULLIF(trim(candidate.display_name), ''),
          NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')
        ) AS candidate_name,
        extract(year from election.election_date)::int AS election_year,
        office.scope AS office_scope,
        COALESCE(NULLIF(trim(office.canonical_name), ''), election.official_ballot_title) AS office_name,
        CASE
          WHEN district.district_type IN ('state_upper', 'state_lower') THEN NULLIF(trim(district.name), '')
          ELSE NULL
        END AS district
      FROM public.candidate_elections AS candidate_election
      JOIN public.candidates AS candidate
        ON candidate.id = candidate_election.candidate_id
      JOIN public.elections AS election
        ON election.id = candidate_election.election_id
      JOIN public.districts AS district
        ON district.id = election.district_id
      LEFT JOIN public.offices AS office
        ON office.id = election.office_id
      WHERE candidate.deleted_at IS NULL
        AND district.state = 'VT'
        AND election.race_type = 'office'
        AND election.election_date >= ($1::date - make_interval(days => $2::int))
        AND election.election_date <= ($1::date + make_interval(days => $3::int))
        AND candidate_election.status NOT IN ('withdrawn', 'lost')
        AND (office.scope || '::' || office.canonical_name) = ANY($4::text[])
        AND COALESCE(NULLIF(trim(candidate.display_name), ''), NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.vt_candidate_finance_links AS link
          WHERE link.candidate_id = candidate.id
            AND link.election_id = election.id
            AND link.link_status = 'active'
        )
      -- Upcoming races first, then random: unmatched candidates never get a
      -- link, so a stable order under a row cap retried the same prefix every
      -- run and starved the tail (Katie Hobbs was never attempted).
      ORDER BY (election.election_date < CURRENT_DATE) ASC, random()
    `,
    [
      input.now.toISOString(),
      input.electionLookbackDays,
      input.electionLookaheadDays,
      [...VERMONT_AUTO_LINK_OFFICE_KEYS],
    ]
  );

  return result.rows.map((row) => ({
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    district: row.district,
  }));
}

export async function syncDueVermontCandidateFinance(
  input: VermontCandidateFinanceBatchSyncInput
): Promise<VermontCandidateFinanceBatchSyncResult> {
  const now = input.now ?? new Date();
  assertValidDate(now, "now");

  const maxCandidates = normalizePositiveInteger(input.maxCandidates, DEFAULT_MAX_CANDIDATES, "maxCandidates");
  const staleAfterDays = normalizePositiveInteger(input.staleAfterDays, DEFAULT_STALE_AFTER_DAYS, "staleAfterDays");
  const electionLookbackDays = normalizePositiveInteger(
    input.electionLookbackDays,
    DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS,
    "electionLookbackDays"
  );
  const electionLookaheadDays = normalizePositiveInteger(
    input.electionLookaheadDays,
    DEFAULT_ELECTION_LOOKAHEAD_DAYS,
    "electionLookaheadDays"
  );
  const dryRun = input.dryRun === true;
  const syncFn = input.syncVermontCandidateFinanceFn ?? syncVermontCandidateFinance;
  const autoLinkResults: VermontCandidateFinanceBatchSyncItemResult[] = [];

  // Auto-link: the per-candidate sync self-resolves against the live Vermont
  // API when called WITHOUT a trustedCommittee and writes the link plus the
  // full snapshot on match, so bootstrapping a never-linked candidate is just
  // running the sync for it. Freshly-synced candidates are excluded from the
  // due query below by their new last_synced_at.
  let autoLinkAttemptedCount = 0;
  let autoLinkLinkedCount = 0;
  let autoLinkFailedCount = 0;
  if (!dryRun && input.autoLinkMissingLinks !== false) {
    try {
      const missingLinkCandidates = await listVermontCandidateElectionsMissingFinanceLinks(input.db, {
        now,
        electionLookbackDays,
        electionLookaheadDays,
      });
      autoLinkAttemptedCount = missingLinkCandidates.length;
      for (const candidate of missingLinkCandidates) {
        try {
          const result = await syncFn({
            db: input.db,
            candidateId: candidate.candidateId,
            electionId: candidate.electionId,
            candidateName: candidate.candidateName,
            electionYear: candidate.electionYear,
            officeScope: candidate.officeScope,
            officeName: candidate.officeName,
            district: candidate.district,
            vermontClientOptions: input.vermontClientOptions,
            dryRun,
            now,
          });
          if (result.resolution.status === "matched") {
            autoLinkLinkedCount += 1;
            autoLinkResults.push({
              candidateId: candidate.candidateId,
              electionId: candidate.electionId,
              electionYear: candidate.electionYear,
              filerRegistrationGuid: result.resolution.filerRegistrationGuid,
              ok: true,
              result,
            });
          } else {
            console.warn("Vermont finance auto-link did not link candidate election:", {
              candidateId: candidate.candidateId,
              electionId: candidate.electionId,
              status: result.resolution.status,
            });
          }
        } catch (error) {
          autoLinkFailedCount += 1;
          autoLinkResults.push({
            candidateId: candidate.candidateId,
            electionId: candidate.electionId,
            electionYear: candidate.electionYear,
            filerRegistrationGuid: "",
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
          console.warn("Vermont finance auto-link failed for candidate election; continuing:", {
            candidateId: candidate.candidateId,
            electionId: candidate.electionId,
            electionYear: candidate.electionYear,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      console.warn(
        "Vermont finance auto-link skipped; continuing with already-linked candidate sync:",
        error instanceof Error ? error.message : error
      );
    }
  }

  const due = await listDueVermontCandidateFinanceSyncRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
  });

  const results: VermontCandidateFinanceBatchSyncItemResult[] = [];
  for (const row of due.rows) {
    try {
      const result = await syncFn({
        db: input.db,
        candidateId: row.candidateId,
        electionId: row.electionId,
        candidateName: row.candidateName,
        electionYear: row.electionYear,
        officeScope: row.officeScope,
        officeName: row.officeName,
        district: row.district,
        sourceUrl: row.sourceUrl,
        trustedCommittee: {
          filerRegistrationGuid: row.filerRegistrationGuid,
          filerName: row.filerName,
          entityId: row.entityId,
          sourceUrl: row.sourceUrl,
        },
        vermontClientOptions: input.vermontClientOptions,
        dryRun,
        now,
      });
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        filerRegistrationGuid: row.filerRegistrationGuid,
        ok: true,
        result,
      });
    } catch (error) {
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        filerRegistrationGuid: row.filerRegistrationGuid,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const syncedCandidateCount = results.filter((result) => result.ok).length;
  return {
    dryRun,
    now: now.toISOString(),
    staleAfterDays,
    maxCandidates,
    dueCandidateCount: due.totalDueRows,
    selectedCandidateCount: due.rows.length,
    syncedCandidateCount,
    failedCandidateCount: results.length - syncedCandidateCount,
    autoLinkAttemptedCount,
    autoLinkLinkedCount,
    autoLinkFailedCount,
    autoLinkResults,
    results,
  };
}
