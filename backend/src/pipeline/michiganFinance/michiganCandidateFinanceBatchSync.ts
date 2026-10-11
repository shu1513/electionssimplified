import type { Pool, PoolClient } from "pg";

import type { FinanceIndustryClassifier } from "../finance/financeIndustryClassificationService.js";
import {
  listMichiganCandidateElectionsMissingFinanceLinks,
  type MichiganFinanceAutoLinkCandidateElection,
} from "./michiganCandidateFinanceAutoLink.js";
import {
  syncMichiganCandidateFinance,
  type MichiganCandidateFinanceSyncResult,
} from "./michiganCandidateFinanceSync.js";
import { MICHIGAN_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./michiganFinanceEligibleOffices.js";
import {
  MICHIGAN_MITN_LEGACY_FINAL_ARCHIVE_YEAR,
  type MichiganMitnLegacyContributionRow,
  type MichiganMitnLegacyExpenditureRow,
} from "./michiganMitnLegacyRowTypes.js";
import {
  MICHIGAN_MITN_PUBLIC_SEARCH_BASE_URL,
  MICHIGAN_MITN_STATEMENT_YEAR_IDS,
  dedupeMichiganMitnExportRows,
  fetchMichiganMitnContributionExportXlsx,
  michiganMitnExportRowsToLegacyContributionRows,
  parseMichiganMitnExportXlsxRows,
  validateMichiganMitnContributionExportHeader,
  resolveMichiganMitnCommitteeViaSearch,
  type MichiganMitnFetchFn,
  type MichiganMitnCommitteeSearchRow,
} from "./michiganMitnPublicSearchClient.js";
import { toMichiganMitnOfficeSearchInput } from "./michiganFinanceEligibleOffices.js";
import { normalizeMichiganCandidateNameForStorage } from "./michiganCandidateCommitteeResolver.js";
import { upsertMichiganFinanceLink } from "./michiganFinanceWriter.js";
import { isMichiganMitnRawDataRefreshEnabled } from "../../config/featureFlags.js";

import { fetchMichiganMitnCurrentContributionRows } from "./michiganMitnContributionPolicy.js";
import { isMichiganDirectDonorSupportReceipt } from "./michiganDirectContributionAggregator.js";
import { fetchMichiganMitnIndependentExpenditureRows, fetchMichiganMitnRegistryForNames } from "./michiganMitnSupplementalData.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type MichiganCandidateFinanceDueRow = {
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

export type MichiganCandidateFinanceBatchSyncInput = {
  db: Queryable;
  now?: Date;
  dryRun?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  autoLinkMissingLinks?: boolean;
  mitnPublicSearchFetchFn?: MichiganMitnFetchFn;
  rawDataCacheDir?: string;
  refreshSupplementalData?: boolean;
  fetchOutsideSpending?: boolean;
  fetchCommitteeRegistry?: boolean;
  fetchIndependentExpenditureRowsFn?: typeof fetchMichiganMitnIndependentExpenditureRows;
  fetchCommitteeRegistryForNamesFn?: typeof fetchMichiganMitnRegistryForNames;
  currentContributionRowsFn?: typeof fetchMichiganMitnCurrentContributionRows;
  financeIndustryClassifier?: FinanceIndustryClassifier;
  aiClassificationMinAmount?: number;
  syncMichiganCandidateFinanceFn?: typeof syncMichiganCandidateFinance;
};

export type MichiganCandidateFinanceBatchSyncItemResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  committeeId: string;
  ok: boolean;
  result?: MichiganCandidateFinanceSyncResult;
  error?: string;
};

export type MichiganCandidateFinanceBatchSyncResult = {
  dryRun: boolean;
  now: string;
  staleAfterDays: number;
  maxCandidates: number;
  dueCandidateCount: number;
  selectedCandidateCount: number;
  syncedCandidateCount: number;
  failedCandidateCount: number;
  outsideSpendingFetchedYears?: number[];
  outsideSpendingFetchErrors?: Record<string, string>;
  committeeRegistryFetchErrors?: Record<string, string>;
  results: MichiganCandidateFinanceBatchSyncItemResult[];
};

type MichiganCandidateFinanceDueQueryRow = {
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
// Keep one extra calendar day so UTC scheduler timing cannot skip election-night finance syncs.
const DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS = 1;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

function assertValidDate(date: Date, label: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid Michigan finance batch sync ${label}`);
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Michigan finance batch sync ${label}: ${normalized}`);
  }
  return normalized;
}

function parseTotalDueRows(value: string | number | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function mapDueRow(row: MichiganCandidateFinanceDueQueryRow): MichiganCandidateFinanceDueRow {
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

export async function listDueMichiganCandidateFinanceSyncRows(
  db: Queryable,
  input: {
    now: Date;
    staleAfterDays: number;
    maxCandidates: number;
    electionLookbackDays: number;
    electionLookaheadDays: number;
  }
): Promise<{ rows: MichiganCandidateFinanceDueRow[]; totalDueRows: number }> {
  const result = await db.query<MichiganCandidateFinanceDueQueryRow>(
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
        FROM public.mi_candidate_finance_links AS link
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
        LEFT JOIN public.mi_candidate_finance_summaries AS summary
          ON summary.link_id = link.id
         AND summary.election_year = link.election_year
        WHERE link.link_status = 'active'
          AND candidate.deleted_at IS NULL
          AND district.state = 'MI'
          AND election.race_type = 'office'
          AND election.election_date >= (($1::timestamptz AT TIME ZONE 'UTC')::date - make_interval(days => $4::int))
          AND election.election_date <= (($1::timestamptz AT TIME ZONE 'UTC')::date + make_interval(days => $5::int))
          AND candidate_election.status NOT IN ('withdrawn', 'lost')
          AND (office.scope || '::' || office.canonical_name) = ANY($6::text[])
          -- Pre-MiTN election years can never sync (the legacy-archive path
          -- was removed), so they must not occupy limited due slots.
          AND link.election_year > $7::int
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
      [...MICHIGAN_FINANCE_ELIGIBLE_OFFICE_KEYS],
      MICHIGAN_MITN_LEGACY_FINAL_ARCHIVE_YEAR,
    ]
  );

  return {
    rows: result.rows.map(mapDueRow),
    totalDueRows: result.rows.length > 0 ? parseTotalDueRows(result.rows[0]?.total_due_rows) : 0,
  };
}


const MICHIGAN_MITN_COMMITTEE_SEARCH_SOURCE_URL = `${MICHIGAN_MITN_PUBLIC_SEARCH_BASE_URL}?page=page.miboeCommitteePublicSearch`;
const MICHIGAN_MITN_CONTRIBUTION_SEARCH_SOURCE_URL = `${MICHIGAN_MITN_PUBLIC_SEARCH_BASE_URL}?page=page.miboeContributionPublicSearch`;

// The legacy-archive ingestion path (frozen .7z bulk exports for filing years
// 2020-2025) has been removed, so only election years the MiTN public search
// serves can sync. Earlier years refuse loudly instead of guessing.
function isMitnPublicSearchYear(electionYear: number): boolean {
  return electionYear > MICHIGAN_MITN_LEGACY_FINAL_ARCHIVE_YEAR;
}

function legacyYearRefusalMessage(electionYear: number): string {
  return `Michigan election year ${electionYear} predates MiTN public-search coverage (${
    MICHIGAN_MITN_LEGACY_FINAL_ARCHIVE_YEAR + 1
  }+); the legacy-archive ingestion path was removed`;
}

const MITN_PUBLIC_SEARCH_FETCH_TIMEOUT_MS = 120_000;

function defaultMitnPublicSearchFetchFn(): MichiganMitnFetchFn {
  // One hung MiTN response must not stall the whole batch — the due loop
  // awaits each committee's exports sequentially.
  return (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(MITN_PUBLIC_SEARCH_FETCH_TIMEOUT_MS) });
}

/**
 * Auto-links candidates by asking the MiTN public committee search (candidate
 * name + office as server-side filters; exactly one ACTIVE candidate
 * committee links, anything else is refused). Network access is gated by the
 * raw-data-refresh flag.
 */
async function autoLinkMichiganCandidatesViaMitnPublicSearch(input: {
  db: Queryable;
  now: Date;
  candidates: readonly MichiganFinanceAutoLinkCandidateElection[];
  fetchFn: MichiganMitnFetchFn;
}): Promise<void> {
  for (const candidate of input.candidates) {
    try {
      const officeSearchInput = toMichiganMitnOfficeSearchInput({
        officeScope: candidate.officeScope,
        officeCanonicalName: candidate.officeName,
        district: candidate.district,
      });
      if (!officeSearchInput) {
        console.warn("Michigan MiTN public-search auto-link skipped candidate with unsupported office:", {
          candidateId: candidate.candidateId,
          officeName: candidate.officeName,
        });
        continue;
      }
      const resolution = await resolveMichiganMitnCommitteeViaSearch({
        candidateName: candidate.candidateName,
        mitnOffice: officeSearchInput.mitnOffice,
        fetchFn: input.fetchFn,
      });
      if (resolution.status !== "matched") {
        console.warn("Michigan MiTN public-search auto-link did not link candidate election:", {
          candidateId: candidate.candidateId,
          candidateName: candidate.candidateName,
          status: resolution.status,
          ...(resolution.status === "ambiguous"
            ? { matches: resolution.matches.map((match) => `${match.committeeId} ${match.committeeName}`) }
            : { reason: resolution.reason }),
        });
        continue;
      }
      await upsertMichiganFinanceLink({
        db: input.db,
        link: {
          candidateId: candidate.candidateId,
          electionId: candidate.electionId,
          electionYear: candidate.electionYear,
          candidateNameNormalized: normalizeMichiganCandidateNameForStorage(candidate.candidateName),
          officeName: candidate.officeName,
          district: candidate.district,
          committeeId: resolution.committeeId,
          committeeName: resolution.committeeName,
          linkStatus: "active",
          linkSource: "mitn_public_search",
          sourceUrl: MICHIGAN_MITN_COMMITTEE_SEARCH_SOURCE_URL,
          lastVerifiedAt: input.now,
        },
      });
    } catch (error) {
      console.warn("Michigan MiTN public-search auto-link failed for candidate election; continuing:", {
        candidateId: candidate.candidateId,
        electionId: candidate.electionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Loads a committee's contribution rows from the MiTN public-search exports
 * for the cycle's statement years, deduped ACROSS years (amendments repeat
 * receipts, and can restate a prior year's statement), then mapped onto the
 * legacy row shape. Raw exports are memoized per committee within one run.
 *
 * The cycle's own statement years (election year - 1 and the election year)
 * are REQUIRED — a missing year-id mapping throws rather than silently
 * writing a partial or zero snapshot. The following filing year (January
 * annual statements reporting election-year receipts) is included when its id
 * is known.
 */
async function loadMitnPublicSearchContributionRows(input: {
  committeeId: string;
  electionYear: number;
  fetchFn: MichiganMitnFetchFn;
  cache: Map<string, string[][]>;
  rawCacheDir?: string;
  currentContributionRowsFn?: typeof fetchMichiganMitnCurrentContributionRows;
}): Promise<MichiganMitnLegacyContributionRow[]> {
  const requiredStatementYears = [input.electionYear - 1, input.electionYear];
  for (const year of requiredStatementYears) {
    if (!MICHIGAN_MITN_STATEMENT_YEAR_IDS.has(year)) {
      throw new Error(
        `No Michigan MiTN statement-year id for ${year}; add it to MICHIGAN_MITN_STATEMENT_YEAR_IDS before syncing ${input.electionYear} elections`
      );
    }
  }
  const statementYears = [...requiredStatementYears, input.electionYear + 1].filter((year) =>
    MICHIGAN_MITN_STATEMENT_YEAR_IDS.has(year)
  );

  const combinedRows: string[][] = [];
  for (const statementYear of statementYears) {
    const cacheKey = `${input.committeeId}:${statementYear}`;
    let rawRows = input.cache.get(cacheKey);
    if (!rawRows) {
      const xlsx = await fetchMichiganMitnContributionExportXlsx({
        committeeId: input.committeeId,
        statementYear,
        fetchFn: input.fetchFn,
      });
      rawRows = parseMichiganMitnExportXlsxRows(xlsx);
      validateMichiganMitnContributionExportHeader(rawRows);
      input.cache.set(cacheKey, rawRows);
    }
    validateMichiganMitnContributionExportHeader(rawRows);
    if (combinedRows.length && JSON.stringify(combinedRows[0]) !== JSON.stringify(rawRows[0])) {
      throw new Error("Michigan MiTN contribution exports disagree on header ordering");
    }
    if (combinedRows.length === 0) {
      combinedRows.push(...rawRows.map((row) => [...row]));
    } else {
      combinedRows.push(...rawRows.slice(1).map((row) => [...row]));
    }
  }
  if (combinedRows.length === 0) {
    return [];
  }
  const currentRows = await (input.currentContributionRowsFn ?? fetchMichiganMitnCurrentContributionRows)({
    committeeId: input.committeeId, statementYears, rawRows: combinedRows,
    rawCacheDir: input.rawCacheDir, fetchFn: input.fetchFn,
  });
  return michiganMitnExportRowsToLegacyContributionRows(dedupeMichiganMitnExportRows(currentRows));
}


function registryNameKey(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase()
    .replace(/&/g, " AND ").replace(/[^A-Z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function cycleStatementYears(electionYear: number): number[] {
  const required = [electionYear - 1, electionYear];
  for (const year of required) {
    if (!MICHIGAN_MITN_STATEMENT_YEAR_IDS.has(year)) {
      throw new Error(`No Michigan MiTN statement-year id for ${year}; add it to MICHIGAN_MITN_STATEMENT_YEAR_IDS before syncing ${electionYear} elections`);
    }
  }
  return [...required, electionYear + 1].filter((year) => MICHIGAN_MITN_STATEMENT_YEAR_IDS.has(year));
}

export async function syncDueMichiganCandidateFinance(
  input: MichiganCandidateFinanceBatchSyncInput
): Promise<MichiganCandidateFinanceBatchSyncResult> {
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
  const syncFn = input.syncMichiganCandidateFinanceFn ?? syncMichiganCandidateFinance;

  if (!dryRun && input.autoLinkMissingLinks !== false) {
    try {
      const allMissingLinkCandidates = await listMichiganCandidateElectionsMissingFinanceLinks(input.db, {
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
      });
      const legacyYearCandidates = allMissingLinkCandidates.filter(
        (candidate) => !isMitnPublicSearchYear(candidate.electionYear)
      );
      if (legacyYearCandidates.length > 0) {
        console.warn("Michigan finance auto-link skipped pre-MiTN election years:", {
          skippedCandidateCount: legacyYearCandidates.length,
          reason: legacyYearRefusalMessage(legacyYearCandidates[0]!.electionYear),
        });
      }
      const publicSearchCandidates = allMissingLinkCandidates.filter((candidate) =>
        isMitnPublicSearchYear(candidate.electionYear)
      );
      if (publicSearchCandidates.length > 0) {
        if (isMichiganMitnRawDataRefreshEnabled()) {
          await autoLinkMichiganCandidatesViaMitnPublicSearch({
            db: input.db,
            now,
            candidates: publicSearchCandidates,
            fetchFn: input.mitnPublicSearchFetchFn ?? defaultMitnPublicSearchFetchFn(),
          });
        } else {
          console.warn(
            "Michigan MiTN public-search auto-link skipped: MICHIGAN_MITN_RAW_DATA_REFRESH_ENABLED is off",
            { skippedCandidateCount: publicSearchCandidates.length }
          );
        }
      }
    } catch (error) {
      console.warn(
        "Michigan finance auto-link skipped; continuing with already-linked candidate sync:",
        error instanceof Error ? error.message : error
      );
    }
  }

  const due = await listDueMichiganCandidateFinanceSyncRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
  });

  const results: MichiganCandidateFinanceBatchSyncItemResult[] = [];
  const publicSearchExportCache = new Map<string, string[][]>();
  const publicSearchFetchFn = input.mitnPublicSearchFetchFn ?? defaultMitnPublicSearchFetchFn();


  const targetsByCandidateElection = new Map<string, { committeeId: string; committeeName: string }[]>();
  let targetLinkError: string | undefined;
  if (due.rows.length && isMichiganMitnRawDataRefreshEnabled() && input.fetchOutsideSpending !== false) {
    try {
      const requested = [...new Map(due.rows.map((row) => [
        `${row.candidateId}:${row.electionId}`, { candidate_id: row.candidateId, election_id: row.electionId },
      ])).values()];
      const targetResult = await input.db.query<{
        candidate_id: string; election_id: string; committee_id: string; committee_name: string;
      }>(`
        WITH requested AS (
          SELECT candidate_id::uuid, election_id::uuid
          FROM jsonb_to_recordset($1::jsonb) AS x(candidate_id text, election_id text)
        )
        SELECT link.candidate_id::text, link.election_id::text, link.committee_id, link.committee_name
        FROM public.mi_candidate_finance_links AS link
        JOIN requested ON requested.candidate_id = link.candidate_id AND requested.election_id = link.election_id
        WHERE link.link_status = 'active'
      `, [JSON.stringify(requested)]);
      for (const target of targetResult.rows) {
        const key = `${target.candidate_id}:${target.election_id}`;
        const list = targetsByCandidateElection.get(key) ?? [];
        if (!list.some((item) => item.committeeId === target.committee_id)) {
          list.push({ committeeId: target.committee_id, committeeName: target.committee_name });
        }
        targetsByCandidateElection.set(key, list);
      }
    } catch (error) {
      targetLinkError = error instanceof Error ? error.message : String(error);
    }
  }

  const outsideRowsByElectionYear = new Map<number, MichiganMitnLegacyExpenditureRow[]>();
  const outsideSpendingFetchErrors: Record<string, string> = {};
  const committeeRegistryFetchErrors: Record<string, string> = {};
  if (isMichiganMitnRawDataRefreshEnabled() && input.fetchOutsideSpending !== false) {
    for (const year of new Set(due.rows.filter((row) => isMitnPublicSearchYear(row.electionYear)).map((row) => row.electionYear))) {
      try {
        outsideRowsByElectionYear.set(year, await (input.fetchIndependentExpenditureRowsFn ?? fetchMichiganMitnIndependentExpenditureRows)({
          statementYears: cycleStatementYears(year),
          transactionYears: [year - 1, year],
          rawCacheDir: input.rawDataCacheDir,
          refresh: input.refreshSupplementalData,
          fetchFn: publicSearchFetchFn,
        }));
      } catch (error) {
        outsideSpendingFetchErrors[String(year)] = error instanceof Error ? error.message : String(error);
      }
    }
  }
  // Names are shared across many receiving committees. Query each once per
  // run and retain source HTML for subsequent saved-page-first runs.
  const registryByName = new Map<string, Promise<MichiganMitnCommitteeSearchRow[]>>();
  const lookupRegistryNames = async (names: readonly string[]): Promise<MichiganMitnCommitteeSearchRow[]> => {
    const rows: MichiganMitnCommitteeSearchRow[] = [];
    for (const name of new Set(names.filter((name) => name.trim()))) {
      const key = registryNameKey(name);
      let pending = registryByName.get(key);
      if (!pending) {
        pending = (input.fetchCommitteeRegistryForNamesFn ?? fetchMichiganMitnRegistryForNames)({
          names: [name], rawCacheDir: input.rawDataCacheDir,
          refresh: input.refreshSupplementalData, fetchFn: publicSearchFetchFn,
        });
        registryByName.set(key, pending);
      }
      rows.push(...await pending);
    }
    return [...new Map(rows.map((row) => [row.committeeId, row])).values()];
  };

  for (const row of due.rows) {
    if (!isMitnPublicSearchYear(row.electionYear)) {
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        committeeId: row.committeeId,
        ok: false,
        error: legacyYearRefusalMessage(row.electionYear),
      });
      continue;
    }
    if (!isMichiganMitnRawDataRefreshEnabled()) {
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        committeeId: row.committeeId,
        ok: false,
        error:
          "Michigan MiTN public-search fetch disabled (MICHIGAN_MITN_RAW_DATA_REFRESH_ENABLED is off); cannot sync a post-legacy election year",
      });
      continue;
    }
    try {
      const contributionRows = await loadMitnPublicSearchContributionRows({
        committeeId: row.committeeId,
        electionYear: row.electionYear,
        fetchFn: publicSearchFetchFn,
        cache: publicSearchExportCache,
        rawCacheDir: input.rawDataCacheDir,
        currentContributionRowsFn: input.currentContributionRowsFn,
      });

      let committeeRegistryRows: MichiganMitnCommitteeSearchRow[] | undefined;
      if (input.fetchCommitteeRegistry !== false) {
        try {
          // In the verified export, organization receipts leave Contributor
          // First Name blank; people keep their first and last names apart.
          const donorNames = contributionRows
            .filter((receipt) => !receipt.f_name.trim() && isMichiganDirectDonorSupportReceipt({ row: receipt, electionYear: row.electionYear }))
            .map((receipt) => receipt.l_name_or_org);
          committeeRegistryRows = await lookupRegistryNames(donorNames);
        } catch (error) {
          committeeRegistryFetchErrors[row.committeeId] = error instanceof Error ? error.message : String(error);
        }
      }

      let expenditureRows = outsideRowsByElectionYear.get(row.electionYear);
      let outsideTargetCommitteeNames: string[] | undefined;
      if (expenditureRows !== undefined) {
        try {
          if (targetLinkError) throw new Error(targetLinkError);
          const targets = targetsByCandidateElection.get(`${row.candidateId}:${row.electionId}`);
          if (!targets?.length) throw new Error("Michigan outside spending has no active candidate committee targets");
          outsideTargetCommitteeNames = [];
          for (const target of targets) {
            if (!expenditureRows.some((expense) =>
              registryNameKey(expense.target_committee_name ?? "") === registryNameKey(target.committeeName))) continue;
            const registry = (await lookupRegistryNames([target.committeeName]))
              .filter((committee) => registryNameKey(committee.committeeName) === registryNameKey(target.committeeName));
            const expectedId = target.committeeId.replace(/^0+/, "");
            if (registry.length !== 1 || registry[0]!.committeeType.trim().toUpperCase() !== "CANDIDATE" ||
                registry[0]!.committeeId.replace(/^0+/, "") !== expectedId) {
              throw new Error(`Michigan outside target lacks a unique candidate registry match: ${target.committeeName}`);
            }
            outsideTargetCommitteeNames.push(target.committeeName);
          }
        } catch (error) {
          outsideSpendingFetchErrors[`${row.electionYear}:${row.committeeId}`] = error instanceof Error ? error.message : String(error);
          expenditureRows = undefined;
        }
      }

      const result = await syncFn({
        db: input.db,
        candidateId: row.candidateId,
        electionId: row.electionId,
        candidateName: row.candidateName,
        electionYear: row.electionYear,
        officeScope: row.officeScope,
        officeName: row.officeName,
        district: row.district,
        sourceUrl: row.sourceUrl ?? MICHIGAN_MITN_CONTRIBUTION_SEARCH_SOURCE_URL,
        contributionSourceUrl: MICHIGAN_MITN_CONTRIBUTION_SEARCH_SOURCE_URL,
        outsideSourceUrl: `${MICHIGAN_MITN_PUBLIC_SEARCH_BASE_URL}?page=page.miboeCommitteeExpenditureAnalysisPublicSearch`,
        contributionRows,
        // Missing supplemental data preserves the previous snapshot.
        ...(expenditureRows !== undefined ? {
          expenditureRows, outsideTargetCommitteeNames,
          ...(outsideTargetCommitteeNames?.length === 1 ? { outsideTargetCommitteeName: outsideTargetCommitteeNames[0] } : {}),
        } : {}),
        committeeRegistryRows,
        linkSource: "mitn_public_search",
        trustedCommittee: {
          committeeId: row.committeeId,
          committeeName: row.committeeName,
          sourceUrl: row.sourceUrl ?? MICHIGAN_MITN_CONTRIBUTION_SEARCH_SOURCE_URL,
        },
        financeIndustryClassifier: input.financeIndustryClassifier,
        aiClassificationMinAmount: input.aiClassificationMinAmount,
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
    outsideSpendingFetchedYears: [...outsideRowsByElectionYear.keys()],
    outsideSpendingFetchErrors,
    committeeRegistryFetchErrors,
    results,
  };
}
