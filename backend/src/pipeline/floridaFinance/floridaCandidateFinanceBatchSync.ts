import type { Pool, PoolClient } from "pg";

import type { FinanceIndustryClassifier } from "../finance/financeIndustryClassificationService.js";
import {
  DEFAULT_FLORIDA_CAMPAIGN_FINANCE_CACHE_DIR,
  readFloridaContributionExportArtifact,
  writeFloridaContributionExportArtifact,
} from "./floridaCampaignFinanceArtifactCache.js";
import {
  floridaElectionCycleStartYear,
  normalizeFloridaTextKey,
  parseFloridaDateYear,
  type FloridaContributionRow,
} from "./floridaCampaignFinanceRows.js";
import {
  buildFloridaContributionExportCacheKey,
  createFloridaContributionExportRateLimiter,
  exportFloridaContributionRows,
  type FloridaContributionExportQuery,
  type FloridaContributionExportRateLimiter,
  type FloridaContributionExportTransport,
} from "./floridaCampaignFinanceClient.js";
import {
  syncFloridaCandidateFinance,
  type FloridaCandidateFinanceSyncInput,
  type FloridaCandidateFinanceSyncResult,
} from "./floridaCandidateFinanceSync.js";
import {
  autoLinkMissingFloridaCandidateFinanceLinks,
  listFloridaCandidateElectionsMissingFinanceLinks,
  type FloridaFinanceAutoLinkCandidateElection,
} from "./floridaCandidateFinanceAutoLink.js";
import { FLORIDA_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./floridaFinanceEligibleOffices.js";
import { createFloridaCandidateCommitteeFinanceSource, type FloridaCandidateCommitteeFinanceSource } from "./floridaCandidateCommitteeFinanceSource.js";
import type { FloridaReviewedCommitteeDates } from "./floridaCommitteeRegistrySource.js";
import { createFloridaCandidateOutsideFinanceSource, type FloridaCandidateOutsideFinanceSource } from "./floridaCandidateOutsideFinanceSource.js";
import { writeFloridaOutsideAllocations, type FloridaOutsideAllocationWriteResult } from "./floridaOutsideAllocationWriter.js";
import { listDueFloridaOutsideFinanceSyncRows, recordFloridaOutsideFinanceAttempt } from "./floridaOutsideFinanceDue.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type FloridaContributionArtifactReference = {
  cacheDir?: string | null;
  cacheKey: string;
};

export type FloridaCandidateFinanceDueRow = {
  candidateId: string;
  candidateElectionId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeName: string;
  district: string | null;
  committeeId: string;
  committeeName: string;
  sourceUrl: string | null;
  lastSyncedAt: string | null;
};

export type FloridaCandidateFinanceBatchSyncItemInput = Omit<
  FloridaCandidateFinanceSyncInput,
  "db" | "now" | "dryRun" | "financeIndustryClassifier" | "contributionRows" | "outsideContributionRows"
> & {
  contributionRows?: readonly FloridaContributionRow[];
  contributionArtifact?: FloridaContributionArtifactReference | null;
  outsideContributionRows?: readonly FloridaContributionRow[];
  outsideContributionArtifact?: FloridaContributionArtifactReference | null;
};

export type FloridaCandidateFinanceBatchSyncInput = {
  db: Queryable;
  now?: Date;
  dryRun?: boolean;
  maxCandidates?: number;
  syncInputs?: readonly FloridaCandidateFinanceBatchSyncItemInput[];
  defaultArtifactCacheDir?: string | null;
  financeIndustryClassifier?: FinanceIndustryClassifier;
  aiClassificationMinAmount?: number;
  syncFloridaCandidateFinanceFn?: typeof syncFloridaCandidateFinance;
};

export type FloridaCandidateFinanceDueContributionData = {
  contributionRows?: readonly FloridaContributionRow[];
  contributionArtifact?: FloridaContributionArtifactReference | null;
  contributionSourceUrl?: string | null;
};

export type FloridaCandidateFinanceDueSyncInput = Omit<
  FloridaCandidateFinanceBatchSyncInput,
  "syncInputs"
> & {
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  autoLinkMissingLinks?: boolean;
  autoLinkContributionRowsByYear?: ReadonlyMap<number, readonly FloridaContributionRow[]>;
  autoLinkSourceUrlByYear?: ReadonlyMap<number, string>;
  autoLinkCandidateElections?: readonly FloridaFinanceAutoLinkCandidateElection[];
  contributionDataByCommitteeId?: ReadonlyMap<string, FloridaCandidateFinanceDueContributionData>;
  fetchMissingContributionData?: boolean;
  exportFloridaContributionRowsFn?: typeof exportFloridaContributionRows;
  exportTransport?: FloridaContributionExportTransport;
  exportRateLimiter?: FloridaContributionExportRateLimiter;
  exportMinIntervalMs?: number;
  exportRowLimit?: number;
  exportForce?: boolean;
  refreshExportArtifacts?: boolean;
  candidateId?: string;
  includeRegisteredCommitteeDonors?: boolean;
  reviewedCommitteeDates?: readonly FloridaReviewedCommitteeDates[];
  committeeFinanceSource?: FloridaCandidateCommitteeFinanceSource;
  includeIndependentExpenditures?: boolean;
  outsideDb?: Pick<Pool, "connect">;
  outsideFinanceSource?: FloridaCandidateOutsideFinanceSource;
  writeOutsideAllocationsFn?: typeof writeFloridaOutsideAllocations;
};

export type FloridaCandidateFinanceBatchSyncItemResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  committeeId: string;
  ok: boolean;
  result?: FloridaCandidateFinanceSyncResult;
  error?: string;
  outsideComponents?: readonly FloridaOutsideAllocationWriteResult[];
};

export type FloridaCandidateFinanceBatchSyncResult = {
  dryRun: boolean;
  now: string;
  maxCandidates: number;
  dueCandidateCount: number;
  selectedCandidateCount: number;
  syncedCandidateCount: number;
  failedCandidateCount: number;
  results: FloridaCandidateFinanceBatchSyncItemResult[];
};

export type FloridaCandidateFinanceDueSyncResult = FloridaCandidateFinanceBatchSyncResult & {
  staleAfterDays: number;
  outsideDueCandidateCount: number;
  outsideSelectedCandidateCount: number;
  outsideResults: { candidateId: string; electionId: string; status: "loaded" | "preserve";
    components: readonly FloridaOutsideAllocationWriteResult[]; diagnostics: readonly string[] }[];
};

type FloridaCandidateFinanceDueQueryRow = {
  candidate_id: string;
  candidate_election_id: string;
  election_id: string;
  candidate_name: string;
  election_year: number;
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
// Keep one extra calendar day so UTC scheduler timing cannot skip election-night finance syncs.
const DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS = 1;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;
const DEFAULT_FLORIDA_CONTRIBUTION_EXPORT_MIN_INTERVAL_MS = 1_000;

function assertValidDate(date: Date, label: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid Florida finance batch sync ${label}`);
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Florida finance batch sync ${label}: ${value}`);
  }
  return normalized;
}

function normalizeNonnegativeInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new Error(`Invalid Florida finance batch sync ${label}: ${value}`);
  }
  return normalized;
}

function normalizeCommitteeId(value: string): string {
  return value.trim().toUpperCase();
}

function parseTotalDueRows(value: string | number | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function mapDueRow(row: FloridaCandidateFinanceDueQueryRow): FloridaCandidateFinanceDueRow {
  return {
    candidateId: row.candidate_id,
    candidateElectionId: row.candidate_election_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    officeName: row.office_name,
    district: row.district,
    committeeId: row.committee_id,
    committeeName: row.committee_name,
    sourceUrl: row.source_url,
    lastSyncedAt: row.last_synced_at,
  };
}

function normalizeArtifactCacheDir(value: string | null | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : fallback;
}

export async function listDueFloridaCandidateFinanceSyncRows(
  db: Queryable,
  input: {
    now: Date;
    staleAfterDays: number;
    maxCandidates: number;
    electionLookbackDays: number;
    electionLookaheadDays: number;
    candidateId?: string;
  }
): Promise<{ rows: FloridaCandidateFinanceDueRow[]; totalDueRows: number }> {
  const result = await db.query<FloridaCandidateFinanceDueQueryRow>(
    `
      WITH due AS (
        SELECT
          link.candidate_id::text AS candidate_id,
          candidate_election.id::text AS candidate_election_id,
          link.election_id::text AS election_id,
          COALESCE(
            NULLIF(trim(candidate.display_name), ''),
            NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), ''),
            link.candidate_name_normalized
          ) AS candidate_name,
          link.election_year,
          link.office_name,
          link.district,
          link.committee_id,
          link.committee_name,
          link.source_url,
          summary.last_synced_at::text AS last_synced_at,
          COUNT(*) OVER () AS total_due_rows
        FROM public.fl_candidate_finance_links AS link
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
        LEFT JOIN public.fl_candidate_finance_summaries AS summary
          ON summary.link_id = link.id
         AND summary.election_year = link.election_year
        WHERE link.link_status = 'active'
          AND ${input.candidateId ? "link.candidate_id = $7::uuid" : "TRUE"}
          AND candidate.deleted_at IS NULL
          AND district.state = 'FL'
          AND election.race_type = 'office'
          AND election.election_date >= (($1::timestamptz AT TIME ZONE 'UTC')::date - make_interval(days => $4::int))
          AND election.election_date <= (($1::timestamptz AT TIME ZONE 'UTC')::date + make_interval(days => $5::int))
          AND candidate_election.status NOT IN ('withdrawn', 'lost')
          AND (office.scope || '::' || office.canonical_name) = ANY($6::text[])
          AND (
            summary.last_synced_at IS NULL
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
        candidate_election_id,
        election_id,
        candidate_name,
        election_year,
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
      [...FLORIDA_FINANCE_ELIGIBLE_OFFICE_KEYS],
      ...(input.candidateId ? [input.candidateId] : []),
    ]
  );

  return {
    rows: result.rows.map(mapDueRow),
    totalDueRows: result.rows.length > 0 ? parseTotalDueRows(result.rows[0]?.total_due_rows) : 0,
  };
}

function buildDueSyncInput(input: {
  row: FloridaCandidateFinanceDueRow;
  contributionData: FloridaCandidateFinanceDueContributionData;
}): FloridaCandidateFinanceBatchSyncItemInput {
  return {
    candidateId: input.row.candidateId,
    candidateElectionId: input.row.candidateElectionId,
    electionId: input.row.electionId,
    candidateName: input.row.candidateName,
    electionYear: input.row.electionYear,
    officeName: input.row.officeName,
    district: input.row.district,
    trustedCommittee: {
      committeeId: input.row.committeeId,
      committeeName: input.row.committeeName,
      sourceUrl: input.row.sourceUrl,
    },
    sourceUrl: input.row.sourceUrl,
    contributionRows: input.contributionData?.contributionRows,
    contributionArtifact: input.contributionData?.contributionArtifact,
    contributionSourceUrl: input.contributionData?.contributionSourceUrl ?? input.row.sourceUrl,
    includeOutsideGroupFinance: false,
  };
}

function hasDirectContributionData(
  data: FloridaCandidateFinanceDueContributionData | undefined
): data is FloridaCandidateFinanceDueContributionData {
  return data !== undefined && (data.contributionRows !== undefined || data.contributionArtifact != null);
}

function splitCandidateNameForFloridaExport(
  candidateName: string
): { candidateFirstName: string; candidateLastName: string } | null {
  const trimmed = candidateName.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return null;
  }
  const commaParts = trimmed.split(",").map((part) => part.trim()).filter(Boolean);
  if (commaParts.length >= 2) {
    const [lastName, ...firstNames] = commaParts;
    const firstName = firstNames.join(" ").trim();
    return firstName && lastName ? { candidateFirstName: firstName, candidateLastName: lastName } : null;
  }

  const parts = trimmed.split(" ").filter(Boolean);
  while (parts.length >= 2 && /^(?:JR|SR|II|III|IV|V)$/i.test(parts[parts.length - 1] ?? "")) {
    parts.pop();
  }
  if (parts.length < 2) {
    return null;
  }
  return {
    candidateFirstName: parts[0]!,
    candidateLastName: parts[parts.length - 1]!,
  };
}

function exportRateLimiterForDueSync(input: {
  rateLimiter: FloridaContributionExportRateLimiter | undefined;
  minIntervalMs: number;
}): FloridaContributionExportRateLimiter | undefined {
  return input.rateLimiter ?? createFloridaContributionExportRateLimiter({ minIntervalMs: input.minIntervalMs });
}

async function loadContributionExportWithCache(input: {
  query: FloridaContributionExportQuery;
  cacheDir: string;
  refresh: boolean;
  dryRun: boolean;
  exportRows: typeof exportFloridaContributionRows;
  transport: FloridaContributionExportTransport | undefined;
  rateLimiter: FloridaContributionExportRateLimiter | undefined;
  force: boolean;
}): Promise<FloridaCandidateFinanceDueContributionData | null> {
  const cacheKey = buildFloridaContributionExportCacheKey(input.query);
  if (!input.refresh) {
    const cached = await readFloridaContributionExportArtifact({ cacheDir: input.cacheDir, cacheKey });
    if (cached) {
      return {
        contributionRows: cached.rows,
        contributionArtifact: { cacheDir: input.cacheDir, cacheKey },
        contributionSourceUrl: cached.metadata.sourceUrl,
      };
    }
  }
  if (input.dryRun) {
    return null;
  }

  const result = await input.exportRows({
    ...input.query,
    transport: input.transport,
    rateLimiter: input.rateLimiter,
    force: input.force,
  });
  await writeFloridaContributionExportArtifact({ cacheDir: input.cacheDir, result });
  return {
    contributionRows: result.rows,
    contributionArtifact: { cacheDir: input.cacheDir, cacheKey: result.cacheKey },
    contributionSourceUrl: result.sourceUrl,
  };
}

function parseFloridaExportDate(value: string, label: string): Date {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) {
    throw new Error(`Invalid Florida export ${label}: ${value}`);
  }
  return new Date(Date.UTC(Number(match[3]), Number(match[1]) - 1, Number(match[2])));
}

function formatFloridaExportDate(date: Date): string {
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${month}/${day}/${date.getUTCFullYear()}`;
}

const MIN_EXPORT_CHUNK_DAYS = 7;

/**
 * Loads a date-bounded export, recursively halving the date range whenever a
 * response fills the row limit — DOS hard-caps exports (contrib.exe
 * overflows past ~32767 rows) and both 2026 gubernatorial candidates exceed
 * a single full-cycle export. Sub-ranges never overlap, so concatenation
 * cannot double-count (legitimate duplicate contributions are preserved).
 * Fails closed if even a one-week range fills the limit.
 */
async function loadContributionExportChunked(input: {
  query: FloridaContributionExportQuery;
  rowLimit: number;
  cacheDir: string;
  refresh: boolean;
  dryRun: boolean;
  exportRows: typeof exportFloridaContributionRows;
  transport: FloridaContributionExportTransport | undefined;
  rateLimiter: FloridaContributionExportRateLimiter | undefined;
  force: boolean;
}): Promise<FloridaCandidateFinanceDueContributionData | null> {
  const data = await loadContributionExportWithCache(input);
  if (data === null || data.contributionRows === undefined || data.contributionRows.length < input.rowLimit) {
    return data;
  }

  const dateFrom = input.query.dateFrom;
  const dateTo = input.query.dateTo;
  if (!dateFrom || !dateTo) {
    return data;
  }
  const start = parseFloridaExportDate(dateFrom, "dateFrom");
  const end = parseFloridaExportDate(dateTo, "dateTo");
  const spanDays = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  if (spanDays < MIN_EXPORT_CHUNK_DAYS) {
    throw new Error(
      `Florida contribution export fills the ${input.rowLimit}-row limit even for ${dateFrom}..${dateTo}; totals would be truncated`
    );
  }
  const mid = new Date(start.getTime() + Math.floor(spanDays / 2) * 86_400_000);
  const rightStart = new Date(mid.getTime() + 86_400_000);

  const halves: FloridaCandidateFinanceDueContributionData[] = [];
  for (const [from, to] of [
    [dateFrom, formatFloridaExportDate(mid)],
    [formatFloridaExportDate(rightStart), dateTo],
  ] as const) {
    const half = await loadContributionExportChunked({
      ...input,
      query: { ...input.query, dateFrom: from, dateTo: to },
    });
    if (half === null || half.contributionRows === undefined) {
      return null;
    }
    halves.push(half);
  }
  return {
    contributionRows: halves.flatMap((half) => half.contributionRows ?? []),
    contributionArtifact: null,
    contributionSourceUrl: halves[0]?.contributionSourceUrl ?? data.contributionSourceUrl,
  };
}

/**
 * Bounds an export to the election cycle so an all-years candidate history
 * cannot eat the DOS row limit before the cycle filter runs — Byron Donalds'
 * unbounded export returned exactly the 10,000-row cap.
 */
function cycleDateBounds(electionYear: number): { dateFrom: string; dateTo: string } {
  return {
    dateFrom: `01/01/${floridaElectionCycleStartYear(electionYear)}`,
    dateTo: `12/31/${electionYear}`,
  };
}

function buildCommitteeContributionExportQuery(input: {
  row: FloridaCandidateFinanceDueRow;
  rowLimit: number;
}): FloridaContributionExportQuery {
  // Linked committee names are DOS recipient strings ("Donalds, Byron
  // (REP)(GOV)"), which the DOS committee search does not recognize — it
  // matches registered committee names only, so the export came back empty
  // and every summary synced as $0. Query by candidate instead (the sync
  // filters rows to the linked committee's recipient names), which also
  // reuses the auto-link step's cached candidate export.
  const name = splitCandidateNameForFloridaExport(input.row.candidateName);
  if (name) {
    return {
      searchType: "candidate_detail",
      candidateFirstName: name.candidateFirstName,
      candidateLastName: name.candidateLastName,
      ...cycleDateBounds(input.row.electionYear),
      rowLimit: input.rowLimit,
    };
  }
  return {
    searchType: "committee_detail",
    committeeName: input.row.committeeName,
    ...cycleDateBounds(input.row.electionYear),
    rowLimit: input.rowLimit,
  };
}

function buildCandidateContributionExportQuery(input: {
  candidateElection: FloridaFinanceAutoLinkCandidateElection;
  rowLimit: number;
}): FloridaContributionExportQuery | null {
  const name = splitCandidateNameForFloridaExport(input.candidateElection.candidateName);
  if (!name) {
    return null;
  }
  return {
    searchType: "candidate_detail",
    candidateFirstName: name.candidateFirstName,
    candidateLastName: name.candidateLastName,
    ...cycleDateBounds(input.candidateElection.electionYear),
    rowLimit: input.rowLimit,
  };
}

function appendRowsByYear(input: {
  rowsByYear: Map<number, FloridaContributionRow[]>;
  year: number;
  rows: readonly FloridaContributionRow[];
}): void {
  const rows = input.rowsByYear.get(input.year) ?? [];
  for (const row of input.rows) {
    rows.push(row);
  }
  input.rowsByYear.set(input.year, rows);
}

function isContributionInElectionCycle(row: FloridaContributionRow, electionYear: number): boolean {
  const rowYear = parseFloridaDateYear(row.contributionDate);
  if (rowYear === null) {
    return false;
  }
  return rowYear >= floridaElectionCycleStartYear(electionYear) && rowYear <= electionYear;
}

async function buildAutoLinkExportData(input: {
  db: Queryable;
  now: Date;
  maxCandidates: number;
  electionLookbackDays: number;
  electionLookaheadDays: number;
  candidateElections?: readonly FloridaFinanceAutoLinkCandidateElection[];
  contributionRowsByYear?: ReadonlyMap<number, readonly FloridaContributionRow[]>;
  sourceUrlByYear?: ReadonlyMap<number, string>;
  cacheDir: string;
  refresh: boolean;
  dryRun: boolean;
  rowLimit: number;
  exportRows: typeof exportFloridaContributionRows;
  transport: FloridaContributionExportTransport | undefined;
  rateLimiter: FloridaContributionExportRateLimiter | undefined;
  force: boolean;
}): Promise<{
  candidateElections: readonly FloridaFinanceAutoLinkCandidateElection[];
  contributionRowsByYear: ReadonlyMap<number, readonly FloridaContributionRow[]>;
  sourceUrlByYear: ReadonlyMap<number, string>;
}> {
  const candidateElections =
    input.candidateElections ??
    (await listFloridaCandidateElectionsMissingFinanceLinks(input.db, {
      now: input.now,
      maxCandidates: input.maxCandidates,
      electionLookbackDays: input.electionLookbackDays,
      electionLookaheadDays: input.electionLookaheadDays,
    }));
  if (input.contributionRowsByYear) {
    return {
      candidateElections,
      contributionRowsByYear: input.contributionRowsByYear,
      sourceUrlByYear: input.sourceUrlByYear ?? new Map(),
    };
  }

  const contributionRowsByYear = new Map<number, FloridaContributionRow[]>();
  const sourceUrlByYear = new Map<number, string>();
  for (const candidateElection of candidateElections) {
    const query = buildCandidateContributionExportQuery({
      candidateElection,
      rowLimit: input.rowLimit,
    });
    if (!query) {
      continue;
    }
    let data: FloridaCandidateFinanceDueContributionData | null;
    try {
      data = await loadContributionExportWithCache({
        query,
        cacheDir: input.cacheDir,
        refresh: input.refresh,
        dryRun: input.dryRun,
        exportRows: input.exportRows,
        transport: input.transport,
        rateLimiter: input.rateLimiter,
        force: input.force,
      });
    } catch (error) {
      console.warn("Florida finance auto-link export failed for candidate election; continuing:", {
        candidateId: candidateElection.candidateId,
        electionId: candidateElection.electionId,
        electionYear: candidateElection.electionYear,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!data?.contributionRows) {
      continue;
    }
    if (data.contributionRows.length >= input.rowLimit) {
      console.warn("Florida auto-link export hit the row limit; committee resolution may be working from truncated data:", {
        candidateId: candidateElection.candidateId,
        electionYear: candidateElection.electionYear,
        rowLimit: input.rowLimit,
      });
    }
    const cycleRows = data.contributionRows.filter((row) =>
      isContributionInElectionCycle(row, candidateElection.electionYear)
    );
    if (cycleRows.length === 0) {
      continue;
    }
    appendRowsByYear({
      rowsByYear: contributionRowsByYear,
      year: candidateElection.electionYear,
      rows: cycleRows,
    });
    if (data.contributionSourceUrl) {
      sourceUrlByYear.set(candidateElection.electionYear, data.contributionSourceUrl);
    }
  }

  return { candidateElections, contributionRowsByYear, sourceUrlByYear };
}

async function loadRowsFromArtifact(input: {
  artifact: FloridaContributionArtifactReference | null | undefined;
  defaultArtifactCacheDir: string;
}): Promise<FloridaContributionRow[] | null> {
  if (!input.artifact) {
    return null;
  }
  const cacheKey = input.artifact.cacheKey.trim();
  if (!cacheKey) {
    throw new Error("Florida contribution artifact cacheKey is required");
  }
  const artifact = await readFloridaContributionExportArtifact({
    cacheDir: normalizeArtifactCacheDir(input.artifact.cacheDir, input.defaultArtifactCacheDir),
    cacheKey,
  });
  if (!artifact) {
    throw new Error(`Florida contribution export artifact not found: ${cacheKey}`);
  }
  return artifact.rows;
}

async function resolveContributionRows(input: {
  rows: readonly FloridaContributionRow[] | undefined;
  artifact: FloridaContributionArtifactReference | null | undefined;
  defaultArtifactCacheDir: string;
}): Promise<readonly FloridaContributionRow[]> {
  const artifactRows = await loadRowsFromArtifact({
    artifact: input.artifact,
    defaultArtifactCacheDir: input.defaultArtifactCacheDir,
  });
  return input.rows ?? artifactRows ?? [];
}

export async function syncFloridaCandidateFinanceBatch(
  input: FloridaCandidateFinanceBatchSyncInput
): Promise<FloridaCandidateFinanceBatchSyncResult> {
  const now = input.now ?? new Date();
  assertValidDate(now, "now");
  const dryRun = input.dryRun === true;
  const maxCandidates = normalizePositiveInteger(input.maxCandidates, DEFAULT_MAX_CANDIDATES, "maxCandidates");
  const dueCandidateCount = input.syncInputs?.length ?? 0;
  const selectedInputs = (input.syncInputs ?? []).slice(0, maxCandidates);
  const defaultArtifactCacheDir = normalizeArtifactCacheDir(
    input.defaultArtifactCacheDir,
    DEFAULT_FLORIDA_CAMPAIGN_FINANCE_CACHE_DIR
  );
  const syncOne = input.syncFloridaCandidateFinanceFn ?? syncFloridaCandidateFinance;
  const results: FloridaCandidateFinanceBatchSyncItemResult[] = [];

  for (const syncInput of selectedInputs) {
    try {
      const contributionRows = await resolveContributionRows({
        rows: syncInput.contributionRows,
        artifact: syncInput.contributionArtifact,
        defaultArtifactCacheDir,
      });
      const outsideContributionRows = await resolveContributionRows({
        rows: syncInput.outsideContributionRows,
        artifact: syncInput.outsideContributionArtifact,
        defaultArtifactCacheDir,
      });
      const result = await syncOne({
        ...syncInput,
        db: input.db,
        now,
        dryRun,
        contributionRows,
        outsideContributionRows,
        financeIndustryClassifier: input.financeIndustryClassifier,
        aiClassificationMinAmount: input.aiClassificationMinAmount ?? syncInput.aiClassificationMinAmount,
      });
      results.push({
        candidateId: syncInput.candidateId,
        electionId: syncInput.electionId,
        electionYear: syncInput.electionYear,
        committeeId: syncInput.trustedCommittee.committeeId,
        ok: true,
        result,
      });
    } catch (error) {
      results.push({
        candidateId: syncInput.candidateId,
        electionId: syncInput.electionId,
        electionYear: syncInput.electionYear,
        committeeId: syncInput.trustedCommittee.committeeId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const syncedCandidateCount = results.filter((result) => result.ok).length;
  return {
    dryRun,
    now: now.toISOString(),
    maxCandidates,
    dueCandidateCount,
    selectedCandidateCount: selectedInputs.length,
    syncedCandidateCount,
    failedCandidateCount: results.length - syncedCandidateCount,
    results,
  };
}

export async function syncDueFloridaCandidateFinance(
  input: FloridaCandidateFinanceDueSyncInput
): Promise<FloridaCandidateFinanceDueSyncResult> {
  const now = input.now ?? new Date();
  assertValidDate(now, "now");

  const maxCandidates = normalizePositiveInteger(input.maxCandidates, DEFAULT_MAX_CANDIDATES, "maxCandidates");
  const staleAfterDays = normalizeNonnegativeInteger(input.staleAfterDays, DEFAULT_STALE_AFTER_DAYS, "staleAfterDays");
  const electionLookbackDays = normalizeNonnegativeInteger(
    input.electionLookbackDays,
    DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS,
    "electionLookbackDays"
  );
  const electionLookaheadDays = normalizeNonnegativeInteger(
    input.electionLookaheadDays,
    DEFAULT_ELECTION_LOOKAHEAD_DAYS,
    "electionLookaheadDays"
  );
  const dryRun = input.dryRun === true;
  const defaultArtifactCacheDir = normalizeArtifactCacheDir(
    input.defaultArtifactCacheDir,
    DEFAULT_FLORIDA_CAMPAIGN_FINANCE_CACHE_DIR
  );
  const exportRows = input.exportFloridaContributionRowsFn ?? exportFloridaContributionRows;
  const exportMinIntervalMs = normalizeNonnegativeInteger(
    input.exportMinIntervalMs,
    DEFAULT_FLORIDA_CONTRIBUTION_EXPORT_MIN_INTERVAL_MS,
    "exportMinIntervalMs"
  );
  const exportRateLimiter = exportRateLimiterForDueSync({
    rateLimiter: input.exportRateLimiter,
    minIntervalMs: exportMinIntervalMs,
  });
  // Statewide candidates exceed 10k in-cycle rows (Byron Donalds' bounded
  // gubernatorial export fills it). Do not exceed ~32767: contrib.exe
  // overflows above a signed 16-bit rowlimit ("Overflow Error Number = 6").
  const exportRowLimit = normalizePositiveInteger(
    input.exportRowLimit,
    30_000,
    "exportRowLimit"
  );

  if (!dryRun && !input.candidateId && input.autoLinkMissingLinks !== false) {
    try {
      const autoLinkExportData = await buildAutoLinkExportData({
        db: input.db,
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
        candidateElections: input.autoLinkCandidateElections,
        contributionRowsByYear: input.autoLinkContributionRowsByYear,
        sourceUrlByYear: input.autoLinkSourceUrlByYear,
        cacheDir: defaultArtifactCacheDir,
        refresh: input.refreshExportArtifacts === true,
        dryRun,
        rowLimit: exportRowLimit,
        exportRows,
        transport: input.exportTransport,
        rateLimiter: exportRateLimiter,
        force: input.exportForce === true,
      });
      const autoLinkResults = await autoLinkMissingFloridaCandidateFinanceLinks({
        db: input.db,
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
        contributionRowsByYear: autoLinkExportData.contributionRowsByYear,
        sourceUrlByYear: autoLinkExportData.sourceUrlByYear,
        candidateElections: autoLinkExportData.candidateElections,
      });
      for (const result of autoLinkResults) {
        if (result.status !== "linked") {
          console.warn("Florida finance auto-link did not link candidate election:", result);
        }
      }
    } catch (error) {
      console.warn(
        "Florida finance auto-link skipped; continuing with already-linked candidate sync:",
        error instanceof Error ? error.message : error
      );
    }
  }

  const due = await listDueFloridaCandidateFinanceSyncRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
    candidateId: input.candidateId,
  });
  const contributionDataByCommitteeId = new Map(
    input.contributionDataByCommitteeId
      ? [...input.contributionDataByCommitteeId.entries()].map(([committeeId, data]) => [
          normalizeCommitteeId(committeeId),
          data,
        ])
      : []
  );
  const missingDataResults: FloridaCandidateFinanceBatchSyncItemResult[] = [];
  const syncInputs: FloridaCandidateFinanceBatchSyncItemInput[] = [];
  let committeeSource = input.committeeFinanceSource;
  for (const row of due.rows) {
    let contributionData = contributionDataByCommitteeId.get(normalizeCommitteeId(row.committeeId));
    if (!hasDirectContributionData(contributionData) && !dryRun && input.fetchMissingContributionData !== false) {
      try {
        contributionData = (await loadContributionExportChunked({
          query: buildCommitteeContributionExportQuery({ row, rowLimit: exportRowLimit }),
          rowLimit: exportRowLimit,
          cacheDir: defaultArtifactCacheDir,
          refresh: input.refreshExportArtifacts === true,
          dryRun,
          exportRows,
          transport: input.exportTransport,
          rateLimiter: exportRateLimiter,
          force: input.exportForce === true,
        })) ?? undefined;
      } catch (error) {
        missingDataResults.push({
          candidateId: row.candidateId,
          electionId: row.electionId,
          electionYear: row.electionYear,
          committeeId: row.committeeId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }
    if (!hasDirectContributionData(contributionData)) {
      missingDataResults.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        committeeId: row.committeeId,
        ok: false,
        error: `Florida contribution data not provided for committee: ${row.committeeId}`,
      });
      continue;
    }
    if (contributionData.contributionRows !== undefined) {
      // (Export truncation fails closed inside loadContributionExportChunked,
      // which recursively halves the date range and throws when even a
      // one-week range fills the DOS row limit.)
      // Fail closed on zero matching rows: writing a snapshot from an export
      // with no rows for the linked committee (header-only response, or a
      // same-named different candidate) would overwrite real totals with $0.
      const committeeKey = normalizeFloridaTextKey(row.committeeName);
      const matchingRowCount = contributionData.contributionRows.filter(
        (contributionRow) =>
          normalizeFloridaTextKey(contributionRow.recipientName) === committeeKey &&
          isContributionInElectionCycle(contributionRow, row.electionYear)
      ).length;
      if (matchingRowCount === 0) {
        missingDataResults.push({
          candidateId: row.candidateId,
          electionId: row.electionId,
          electionYear: row.electionYear,
          committeeId: row.committeeId,
          ok: false,
          error: `Florida contribution export has no in-cycle rows for linked committee "${row.committeeName}"; refusing to write a zero snapshot`,
        });
        continue;
      }
    }
    const syncInput = buildDueSyncInput({ row, contributionData });
    if (!dryRun && input.includeRegisteredCommitteeDonors !== false) {
      committeeSource ??= createFloridaCandidateCommitteeFinanceSource({ db: input.db,
        cacheDir: defaultArtifactCacheDir, refresh: input.refreshExportArtifacts === true,
        minIntervalMs: exportMinIntervalMs, reviewedDates: input.reviewedCommitteeDates });
      try {
        const committeeFinance = await committeeSource.load({ candidateId: row.candidateId,
          electionId: row.electionId, committeeId: row.committeeId });
        if (committeeFinance.status === "accepted") syncInput.pacFinance = committeeFinance.pacFinance;
        else console.warn("Florida committee donor component preserved:", {
          candidateId: row.candidateId, electionId: row.electionId, diagnostics: committeeFinance.diagnostics,
        });
      } catch (error) {
        console.warn("Florida committee donor component preserved:", {
          candidateId: row.candidateId, electionId: row.electionId,
          error: error instanceof Error ? error.message : "Committee source failed",
        });
      }
    }
    syncInputs.push(syncInput);
  }
  const result = await syncFloridaCandidateFinanceBatch({
    db: input.db,
    now,
    dryRun,
    maxCandidates,
    syncInputs,
    defaultArtifactCacheDir,
    financeIndustryClassifier: input.financeIndustryClassifier,
    aiClassificationMinAmount: input.aiClassificationMinAmount,
    syncFloridaCandidateFinanceFn: input.syncFloridaCandidateFinanceFn,
  });

  // IE has its own due selection: direct freshness, acquisition and writer
  // failures cannot suppress independently verified outside acquisition.
  const connectionProvider = input.outsideDb ??
    ("connect" in input.db && typeof input.db.connect === "function" ? input.db as Pick<Pool, "connect"> : undefined);
  let outsideDueCandidateCount = 0, outsideSelectedCandidateCount = 0;
  const outsideResults: FloridaCandidateFinanceDueSyncResult["outsideResults"] = [];
  if (!dryRun && input.includeIndependentExpenditures !== false && connectionProvider) {
    const outsideDue = await listDueFloridaOutsideFinanceSyncRows(input.db, {
      now, staleAfterDays, maxCandidates, electionLookbackDays, electionLookaheadDays, candidateId: input.candidateId,
    });
    outsideDueCandidateCount = outsideDue.totalDueRows;
    outsideSelectedCandidateCount = outsideDue.rows.length;
    const outsideSource = input.outsideFinanceSource ?? createFloridaCandidateOutsideFinanceSource({
      db: input.db, cacheDir: defaultArtifactCacheDir, refresh: input.refreshExportArtifacts === true,
      minIntervalMs: exportMinIntervalMs,
    });
    const writeOutside = input.writeOutsideAllocationsFn ?? writeFloridaOutsideAllocations;
    const visited = new Set<string>();
    for (const item of outsideDue.rows) {
      const key = `${item.candidateId}\u0000${item.electionId}`;
      if (visited.has(key)) continue;
      visited.add(key);
      try {
        const outside = await outsideSource.load({ candidateId: item.candidateId,
          electionId: item.electionId, committeeId: item.committeeId });
        if (outside.status === "preserve") {
          outsideResults.push({ candidateId: item.candidateId, electionId: item.electionId,
            status: "preserve", components: [], diagnostics: outside.diagnostics });
          console.warn("Florida independent expenditure component preserved:", { candidateId: item.candidateId,
            electionId: item.electionId, diagnostics: outside.diagnostics });
          continue;
        }
        const writes: FloridaOutsideAllocationWriteResult[] = [];
        for (const component of outside.components) writes.push(await writeOutside({ db: connectionProvider,
          localContext: outside.localContext, ...component }));
        outsideResults.push({ candidateId: item.candidateId, electionId: item.electionId,
          status: "loaded", components: writes, diagnostics: outside.diagnostics });
        const directItem = [...result.results, ...missingDataResults].find(row => row.candidateId === item.candidateId && row.electionId === item.electionId);
        if (writes.length && directItem) directItem.outsideComponents = writes;
        if (outside.diagnostics.length || writes.some(write => write.status === "preserve"))
          console.warn("Florida independent expenditure coverage remains partial:", { candidateId: item.candidateId,
            electionId: item.electionId, diagnostics: [...outside.diagnostics,
              ...writes.filter(write => write.status === "preserve").flatMap(write => write.diagnostics)] });
      } catch (error) {
        outsideResults.push({ candidateId: item.candidateId, electionId: item.electionId, status: "preserve",
          components: [], diagnostics: [error instanceof Error ? error.message : "Outside source failed"] });
        console.warn("Florida independent expenditure component preserved:", { candidateId: item.candidateId,
          electionId: item.electionId, error: error instanceof Error ? error.message : "Outside source failed" });
      } finally {
        // Separate scheduler clock: never touches accepted source timestamps,
        // financial rows or completeness. Failed attempts retry within a day;
        // explicit staleAfterDays=0 deadline runs bypass this backoff.
        await recordFloridaOutsideFinanceAttempt(input.db, item.candidateElectionId, now);
      }
    }
  }

  return {
    ...result,
    staleAfterDays,
    outsideDueCandidateCount,
    outsideSelectedCandidateCount,
    outsideResults,
    dueCandidateCount: due.totalDueRows,
    selectedCandidateCount: due.rows.length,
    syncedCandidateCount: result.syncedCandidateCount,
    failedCandidateCount: result.failedCandidateCount + missingDataResults.length,
    results: [...result.results, ...missingDataResults],
  };
}
