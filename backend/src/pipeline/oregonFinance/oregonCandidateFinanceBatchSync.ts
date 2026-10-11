import type { Pool, PoolClient } from "pg";
import { isUuid } from "../../utils/uuid.js";

import {
  autoLinkMissingOregonCandidateFinanceLinks,
  listOregonCandidateElectionsMissingFinanceLinks,
  type OregonCandidateSearchRowsLoader,
  type OregonFinanceAutoLinkResult,
} from "./oregonCandidateFinanceAutoLink.js";
import type { OregonCandidateCommitteeResolver } from "./oregonCandidateCommitteeResolver.js";
import {
  syncOregonCandidateFinance,
  type OregonCandidateFinanceSyncResult,
} from "./oregonCandidateFinanceSync.js";
import { OREGON_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./oregonFinanceEligibleOffices.js";
import {
  getOregonOrestarCandidateCommitteeDirectory,
  getOregonOrestarCommitteeContributionDetailsFromExport,
  getOregonOrestarTransactionDetailsFromSourceUrl,
  type OregonOrestarClientOptions,
} from "./oregonOrestarClient.js";
import type { OregonOrestarTransactionDetail } from "./oregonOrestarParser.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & Pick<Pool, "connect">;

export type OregonCandidateFinanceDueRow = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district: string | null;
  committeeId: string;
  committeeName: string;
  sourceUrl: string | null;
  lastSyncedAt: string | null;
};

export type OregonTransactionDetailsLoader = (
  row: OregonCandidateFinanceDueRow
) => Promise<readonly OregonOrestarTransactionDetail[]>;

export type OregonCandidateFinanceBatchSyncInput = {
  db: ConnectableQueryable;
  now?: Date;
  dryRun?: boolean;
  refresh?: boolean;
  candidateId?: string;
  electionYear?: number;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  directMaxBreakdownsPerCategory?: number;
  outsideMaxGroups?: number;
  outsideMaxBreakdownsPerCategory?: number;
  minIndustryAmount?: number;
  autoLinkMissingLinks?: boolean;
  orestarClientOptions?: OregonOrestarClientOptions;
  loadCandidateSearchRows?: OregonCandidateSearchRowsLoader;
  resolveCandidateCommittee?: OregonCandidateCommitteeResolver;
  loadTransactionDetails?: OregonTransactionDetailsLoader;
  syncOregonCandidateFinanceFn?: typeof syncOregonCandidateFinance;
};

export type OregonCandidateFinanceBatchSyncItemResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  committeeId: string;
  ok: boolean;
  result?: OregonCandidateFinanceSyncResult;
  error?: string;
};

export type OregonCandidateFinanceBatchSyncResult = {
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
  results: OregonCandidateFinanceBatchSyncItemResult[];
};

type OregonCandidateFinanceDueQueryRow = {
  candidate_id: string;
  election_id: string;
  candidate_name: string;
  election_year: number;
  office_scope: string;
  office_name: string;
  district: string | null;
  committee_id: string;
  committee_name: string;
  source_url: string | null;
  last_synced_at: string | null;
  total_due_rows: string | number;
};

const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_STALE_AFTER_DAYS = 7;
// Rolling reports and later amendments remain due after election day.
const DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS = 100;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;
// A batch crawls hundreds of sequential ORESTAR pages; without a pause the
// portal starts answering 403 partway through (seen live 2026-07-21).
const DEFAULT_ORESTAR_REQUEST_DELAY_MS = 250;

function assertValidDate(date: Date, label: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid Oregon finance batch sync ${label}`);
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Oregon finance batch sync ${label}: ${normalized}`);
  }
  return normalized;
}

function parseTotalDueRows(value: string | number | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function mapDueRow(row: OregonCandidateFinanceDueQueryRow): OregonCandidateFinanceDueRow {
  return {
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    district: row.district,
    committeeId: row.committee_id,
    committeeName: row.committee_name,
    sourceUrl: row.source_url,
    lastSyncedAt: row.last_synced_at,
  };
}

async function defaultLoadTransactionDetails(
  row: OregonCandidateFinanceDueRow,
  options?: OregonOrestarClientOptions
): Promise<readonly OregonOrestarTransactionDetail[]> {
  // Link source URLs point at the committee's sooDetail.do page, which lists
  // no transactions — scraping it always produced zero rows and $0 summaries.
  // Load the committee's contributions through the ORESTAR XcelCNESearch
  // export instead (3 requests per candidate regardless of committee size;
  // the per-detail crawl tripped the portal's WAF on large filers). The
  // stored source URL is only a fallback for legacy links without a
  // committee ID.
  //
  // KNOWN LIMITATION: this search filters on the candidate committee as the
  // FILER, so it only sees the committee's own transactions. Independent
  // expenditures are filed by outside committees (the candidate appears only
  // as the association target). Without a separate verified IE component,
  // outside totals remain unavailable and stored outside groups are preserved.
  const committeeId = row.committeeId?.trim();
  if (committeeId && /^\d+$/.test(committeeId)) {
    return getOregonOrestarCommitteeContributionDetailsFromExport({
      committeeId,
      electionYear: row.electionYear,
      options,
    });
  }
  return getOregonOrestarTransactionDetailsFromSourceUrl({ sourceUrl: row.sourceUrl, options });
}

async function defaultLoadCandidateSearchRows(
  candidateElection: Parameters<OregonCandidateSearchRowsLoader>[0],
  options?: OregonOrestarClientOptions
) {
  return getOregonOrestarCandidateCommitteeDirectory({ yearActive: candidateElection.electionYear, options });
}

export async function listDueOregonCandidateFinanceSyncRows(
  db: Queryable,
  input: {
    now: Date;
    staleAfterDays: number;
    maxCandidates: number;
    electionLookbackDays: number;
    electionLookaheadDays: number;
    refresh?: boolean;
    candidateId?: string;
    electionYear?: number;
  }
): Promise<{ rows: OregonCandidateFinanceDueRow[]; totalDueRows: number }> {
  const candidateId = input.candidateId?.trim().toLowerCase() ?? null;
  if (candidateId !== null && !isUuid(candidateId)) {
    throw new Error("Oregon finance candidateId must be a UUID");
  }
  if (input.electionYear !== undefined && (!Number.isInteger(input.electionYear) || input.electionYear < 2000 || input.electionYear > 2100)) {
    throw new Error("Oregon finance electionYear must be between 2000 and 2100");
  }
  const result = await db.query<OregonCandidateFinanceDueQueryRow>(
    `
      WITH due AS (
        SELECT
          link.candidate_id::text AS candidate_id,
          link.election_id::text AS election_id,
          COALESCE(
            NULLIF(trim(candidate.display_name), ''),
            NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), ''),
            link.candidate_name_normalized
          ) AS candidate_name,
          link.election_year,
          office.scope AS office_scope,
          link.office_name,
          link.district,
          link.committee_id,
          link.committee_name,
          link.source_url,
          summary.last_synced_at::text AS last_synced_at,
          COUNT(*) OVER () AS total_due_rows
        FROM public.or_candidate_finance_links AS link
        JOIN public.candidates AS candidate
          ON candidate.id = link.candidate_id
        JOIN public.candidate_elections AS candidate_election
          ON candidate_election.candidate_id = link.candidate_id
         AND candidate_election.election_id = link.election_id
        JOIN public.elections AS election
          ON election.id = link.election_id
        JOIN public.districts AS district
          ON district.id = election.district_id
        LEFT JOIN public.offices AS office
          ON office.id = election.office_id
        LEFT JOIN public.or_candidate_finance_summaries AS summary
          ON summary.link_id = link.id
         AND summary.election_year = link.election_year
        WHERE link.link_status = 'active'
          AND candidate.deleted_at IS NULL
          AND district.state = 'OR'
          AND election.race_type = 'office'
          AND election.election_date >= (($1::timestamptz AT TIME ZONE 'UTC')::date - make_interval(days => $4::int))
          AND election.election_date <= (($1::timestamptz AT TIME ZONE 'UTC')::date + make_interval(days => $5::int))
          AND candidate_election.status NOT IN ('withdrawn', 'lost')
          AND (office.scope || '::' || office.canonical_name) = ANY($6::text[])
          AND nullif(trim(link.source_url), '') IS NOT NULL
          AND ($8::uuid IS NULL OR link.candidate_id = $8::uuid)
          AND ($9::int IS NULL OR link.election_year = $9::int)
          AND (
            $7::boolean
            OR summary.last_synced_at IS NULL
            OR summary.last_synced_at < ($1::timestamptz - make_interval(days => $2::int))
          )
        ORDER BY summary.last_synced_at ASC NULLS FIRST,
                 election.election_date ASC,
                 link.candidate_name_normalized ASC,
                 link.id ASC
        LIMIT $3::int
      )
      SELECT
        candidate_id,
        election_id,
        candidate_name,
        election_year,
        office_scope,
        office_name,
        district,
        committee_id,
        committee_name,
        source_url,
        last_synced_at,
        total_due_rows
      FROM due
    `,
    [
      input.now.toISOString(),
      input.staleAfterDays,
      input.maxCandidates,
      input.electionLookbackDays,
      input.electionLookaheadDays,
      [...OREGON_FINANCE_ELIGIBLE_OFFICE_KEYS],
      input.refresh === true,
      candidateId,
      input.electionYear ?? null,
    ]
  );

  return {
    rows: result.rows.map(mapDueRow),
    totalDueRows: result.rows.length > 0 ? parseTotalDueRows(result.rows[0]?.total_due_rows) : 0,
  };
}

export async function syncDueOregonCandidateFinance(
  input: OregonCandidateFinanceBatchSyncInput
): Promise<OregonCandidateFinanceBatchSyncResult> {
  const now = input.now ?? new Date();
  assertValidDate(now, "now");
  if (input.candidateId !== undefined && !isUuid(input.candidateId.trim())) {
    throw new Error("Oregon finance candidateId must be a UUID");
  }
  if (input.electionYear !== undefined && (!Number.isInteger(input.electionYear) || input.electionYear < 2000 || input.electionYear > 2100)) {
    throw new Error("Oregon finance electionYear must be between 2000 and 2100");
  }

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
  const syncFn = input.syncOregonCandidateFinanceFn ?? syncOregonCandidateFinance;
  const orestarClientOptions: OregonOrestarClientOptions = {
    requestDelayMs: DEFAULT_ORESTAR_REQUEST_DELAY_MS,
    ...input.orestarClientOptions,
  };
  const loadTransactionDetails =
    input.loadTransactionDetails ?? ((row) => defaultLoadTransactionDetails(row, orestarClientOptions));
  const loadCandidateSearchRows =
    input.loadCandidateSearchRows ??
    ((candidateElection) => defaultLoadCandidateSearchRows(candidateElection, orestarClientOptions));
  let autoLinkAttemptedCount = 0;
  let autoLinkLinkedCount = 0;

  if (!dryRun && input.autoLinkMissingLinks !== false && input.candidateId === undefined && input.electionYear === undefined) {
    try {
      const missingLinkCandidates = await listOregonCandidateElectionsMissingFinanceLinks(input.db, {
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
      });
      autoLinkAttemptedCount = missingLinkCandidates.length;
      // The directory is searched by active year, so load it once per
      // election year among the candidates. A year whose directory does not
      // load (portal blocked, or the search hit ORESTAR's 999-row cap) only
      // skips that year's candidates; the other years still link.
      const directoryRowsByYear = new Map<number, Awaited<ReturnType<OregonCandidateSearchRowsLoader>>>();
      const directoryFailureByYear = new Map<number, string>();
      for (const candidateElection of missingLinkCandidates) {
        const year = candidateElection.electionYear;
        if (directoryRowsByYear.has(year) || directoryFailureByYear.has(year)) {
          continue;
        }
        try {
          directoryRowsByYear.set(year, await loadCandidateSearchRows(candidateElection));
        } catch (error) {
          directoryFailureByYear.set(year, error instanceof Error ? error.message : String(error));
        }
      }
      const autoLinkResults: OregonFinanceAutoLinkResult[] = missingLinkCandidates
        .filter((candidateElection) => directoryFailureByYear.has(candidateElection.electionYear))
        .map((candidateElection) => ({
          candidateId: candidateElection.candidateId,
          electionId: candidateElection.electionId,
          status: "skipped",
          reason: `Oregon committee directory for ${candidateElection.electionYear} did not load: ${
            directoryFailureByYear.get(candidateElection.electionYear) ?? "unknown error"
          }`,
        }));
      autoLinkResults.push(
        ...(await autoLinkMissingOregonCandidateFinanceLinks({
          db: input.db,
          now,
          candidateElections: missingLinkCandidates.filter((candidateElection) =>
            directoryRowsByYear.has(candidateElection.electionYear)
          ),
          loadCandidateSearchRows: (candidateElection) => directoryRowsByYear.get(candidateElection.electionYear) ?? [],
          resolveCandidateCommittee: input.resolveCandidateCommittee,
        }))
      );
      autoLinkLinkedCount = autoLinkResults.filter((result) => result.status === "linked").length;
      for (const result of autoLinkResults) {
        if (result.status !== "linked") {
          console.warn("Oregon finance auto-link did not link candidate election:", result);
        }
      }
    } catch (error) {
      console.warn(
        "Oregon finance auto-link skipped; continuing with already-linked candidate sync:",
        error instanceof Error ? error.message : error
      );
    }
  }

  const due = await listDueOregonCandidateFinanceSyncRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
    refresh: input.refresh,
    candidateId: input.candidateId,
    electionYear: input.electionYear,
  });

  const results: OregonCandidateFinanceBatchSyncItemResult[] = [];
  for (const row of due.rows) {
    try {
      const transactionDetails = await loadTransactionDetails(row);
      const result = await syncFn({
        db: input.db,
        candidateId: row.candidateId,
        electionId: row.electionId,
        candidateName: row.candidateName,
        electionYear: row.electionYear,
        officeName: row.officeName,
        district: row.district,
        committeeId: row.committeeId,
        committeeName: row.committeeName,
        sourceUrl: row.sourceUrl,
        transactionDetails,
        directMaxBreakdownsPerCategory: input.directMaxBreakdownsPerCategory,
        outsideMaxGroups: input.outsideMaxGroups,
        outsideMaxBreakdownsPerCategory: input.outsideMaxBreakdownsPerCategory,
        minIndustryAmount: input.minIndustryAmount,
        dryRun,
        now,
      });
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        committeeId: row.committeeId,
        ok: true,
        result,
      });
    } catch (error) {
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        committeeId: row.committeeId,
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
    results,
  };
}
