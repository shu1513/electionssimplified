import type { Pool, PoolClient } from "pg";

import {
  createStandardStateFinanceDueListQuery,
  type StandardStateFinanceDueRow,
} from "../finance/standardStateFinanceDueListQuery.js";
import {
  autoLinkMissingNorthCarolinaCandidateFinanceLinks,
  type NorthCarolinaCandidateSearchRowsLoader,
} from "./northCarolinaCandidateCommitteeAutoLinker.js";
import {
  syncNorthCarolinaCandidateFinance,
  type NorthCarolinaCandidateOutsideFinanceInput,
  type NorthCarolinaCandidateFinanceSyncResult,
} from "./northCarolinaCandidateFinanceSync.js";
import {
  aggregateNorthCarolinaDirectFinance,
  selectNorthCarolinaDirectCycleReportRows,
  type NorthCarolinaDirectAggregationResult,
  type NorthCarolinaDirectReportInput,
} from "./northCarolinaDirectContributionAggregator.js";
import { NORTH_CAROLINA_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./northCarolinaFinanceEligibleOffices.js";
import type { NorthCarolinaFinanceLinkSource } from "./northCarolinaFinanceWriter.js";
import { selectNcsbeCycleReportRows } from "./northCarolinaNcsbeArtifactAcquisition.js";
import {
  DEFAULT_NCSBE_CACHE_DIR,
  readNcsbeArtifact,
  type NcsbeArtifactKey,
} from "./northCarolinaNcsbeArtifactCache.js";
import { NCSBE_TRANSACTION_PAGE_SIZE } from "./northCarolinaNcsbeClient.js";
import {
  NORTH_CAROLINA_SBOEID_PATTERN,
  parseNcsbeCommitteeSearchPage,
  parseNcsbeDocumentListPage,
  parseNcsbeExpendituresPage,
  parseNcsbeReceiptsPage,
  parseNcsbeReportDetailPage,
  type NcsbeDocumentRow,
  type NcsbeReceiptRow,
  type NcsbeTransactionPage,
} from "./northCarolinaNcsbeParsers.js";
import { aggregateNorthCarolinaOutsideGroupContributions } from "./northCarolinaOutsideGroupContributionAggregator.js";
import { selectNcsbeCurrentFilings } from "./northCarolinaReportSelector.js";
import {
  aggregateNorthCarolinaOutsideSpending,
  northCarolinaOutsideGroupCommitteeId,
  type NorthCarolinaOutsideCandidateTarget,
  type NorthCarolinaOutsideReportInput,
} from "./northCarolinaOutsideSpendingAggregator.js";

// Batch sync for North Carolina candidate finance (docs/plans/north_carolina_plan.md
// PR 7), ohio pattern with the state's structural difference: instead of
// eleven bulk files there are many small per-report artifacts, all read from
// the local cache the acquisition script installs — this module NEVER touches
// the portal (decision 10: sync reads cache only). A missing or stale
// artifact fails closed per candidate (direct) or per year (outside), with
// the raw-refresh script named in the error.
//
// Identity plumbing: the sync needs no OrgGroupID — document inventories are
// cached by SBoEID alone, and OGID is a fetch-time parameter the acquisition
// derives (PR 5's SBoEID→OGID note lands there, where the portal URL is
// built). Auto-link resolves against the cached committee-search artifact for
// the candidate's name; a candidate without a cached search errors per
// candidate and is retried after the next acquisition run.
//
// Artifact failure policy (mirrors the PR 6 three-status contract):
// - Direct: a missing inventory artifact fails the candidate's due rows; a
//   missing/stale report artifact surfaces through the aggregator as
//   "incomplete_artifacts" — no write, previous snapshot kept.
// - Outside: a missing IE inventory OR any selected structured IE report
//   without readable artifacts makes the whole year's outside leg
//   unavailable (Ohio's stale-31-U-bundle precedent: a quarantined-missing
//   report's money is invisible, so any published total could be a silent
//   undercount). The sync then passes outsideFinance null and the writer's
//   preserveWhenNull policy keeps the stored outside totals. Reports
//   quarantined for PORTAL reasons (reconciliation mismatch, null IEAmount)
//   are the aggregator's own fail-closed exclusions and stay diagnostics.

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & {
  connect: () => Promise<PoolClient>;
};

// link_source rides along (ohio/alaska pattern) so a sync refresh writes the
// link back with its ORIGINAL provenance — rewriting a manual link as
// ncsbe_portal would both lose the provenance and expose the manual pin to
// auto-link supersession.
export type NorthCarolinaCandidateFinanceDueRow = StandardStateFinanceDueRow & {
  linkSource: NorthCarolinaFinanceLinkSource;
};

export type NorthCarolinaCandidateFinanceBatchSyncInput = {
  db: ConnectableQueryable;
  now?: Date;
  dryRun?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  rawDataCacheDir?: string;
  autoLinkMissingLinks?: boolean;
  // Test injection points.
  loadCandidateSearchRows?: NorthCarolinaCandidateSearchRowsLoader;
  syncNorthCarolinaCandidateFinanceFn?: typeof syncNorthCarolinaCandidateFinance;
};

export type NorthCarolinaCandidateFinanceBatchSyncItemResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  committeeId: string;
  ok: boolean;
  // Decision-3 inverse-miss cross-check: this committee's regular reports
  // carry IE-typed declared rows, but no IE-inventory report of theirs was
  // aggregated — their IEs may live only in regular reports, which the
  // single-source rule never counts. Flagged for the PR 9 audit.
  ieInverseMissSuspected?: boolean;
  result?: NorthCarolinaCandidateFinanceSyncResult;
  error?: string;
};

// Per-year outside-spending health, surfaced so a live run can report its
// reconciliation and match rates without re-deriving them.
export type NorthCarolinaOutsideAggregationYearSummary = {
  electionYear: number;
  available: boolean;
  error?: string;
  reportCount?: number;
  quarantinedReportCount?: number;
  missingReportIdCount?: number;
  coverageGapCount?: number;
  unmatchedTargetCount?: number;
  ambiguousTargetCount?: number;
  attributedRowCount?: number;
  attributedCents?: number;
  // Funder leg (PR 8): false when spender receipt artifacts were unavailable
  // and the writer preserved the stored funder breakdowns.
  fundersAvailable?: boolean;
  fundersError?: string;
  funderReceiptRowCount?: number;
  // Receipt-type codes outside the pinned donor vocabulary (decision 12):
  // every candidate whose groups carry such a code had its funder slice
  // withheld (stored breakdowns preserved) — new portal vocabulary is
  // reviewed, never published as a partial funder picture.
  funderUnknownReceiptTypeCodes?: string[];
};

export type NorthCarolinaCandidateFinanceBatchSyncResult = {
  dryRun: boolean;
  now: string;
  staleAfterDays: number;
  maxCandidates: number;
  dueCandidateCount: number;
  selectedCandidateCount: number;
  syncedCandidateCount: number;
  failedCandidateCount: number;
  outsideAggregationByYear: NorthCarolinaOutsideAggregationYearSummary[];
  results: NorthCarolinaCandidateFinanceBatchSyncItemResult[];
};

const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_STALE_AFTER_DAYS = 7;
const DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS = 1;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

function assertValidDate(date: Date, label: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid North Carolina finance batch sync ${label}`);
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid North Carolina finance batch sync ${label}: ${value}`);
  }
  return normalized;
}

function rawDataCacheDir(inputCacheDir?: string): string {
  return (
    inputCacheDir ?? (process.env.NORTH_CAROLINA_NCSBE_RAW_DATA_CACHE_DIR?.trim() || DEFAULT_NCSBE_CACHE_DIR)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function groupDueRowsByYear(
  rows: readonly NorthCarolinaCandidateFinanceDueRow[]
): Map<number, NorthCarolinaCandidateFinanceDueRow[]> {
  const byYear = new Map<number, NorthCarolinaCandidateFinanceDueRow[]>();
  for (const row of rows) {
    const yearRows = byYear.get(row.electionYear) ?? [];
    yearRows.push(row);
    byYear.set(row.electionYear, yearRows);
  }
  return byYear;
}

// The cached-search query convention: the candidate's SURNAME, exactly as the
// acquisition passes it to the portal search. One function so the cache
// writer and this reader can never disagree on the key. The portal matches
// the query as a substring of the committee/candidate names, so the full
// display name missed most filers (live 2026-10-10: "Veleria M. Levy" found
// nothing against CandName "VELERIA M LEVY"; "Tom McInnis" nothing against
// "THOMAS MOSES MCINNIS"). The resolver narrows the surname rows by name.
const NORTH_CAROLINA_SEARCH_SUFFIX_TOKENS = new Set(["JR", "SR", "II", "III", "IV", "V"]);

export function northCarolinaCommitteeSearchQueryForCandidateName(candidateName: string): string {
  const isSuffix = (token: string) => NORTH_CAROLINA_SEARCH_SUFFIX_TOKENS.has(token.replace(/\./g, "").toUpperCase());
  const segments = candidateName
    .replace(/\([^()]*\)/g, " ")
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean);
  // "Last, First" names the surname first; a comma before a bare suffix
  // ("Danny Earl Britt, Jr.") does not.
  const commaForm = segments.length >= 2 && !segments.slice(1).every(isSuffix);
  const tokens = (segments[0] ?? "").split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && isSuffix(tokens[tokens.length - 1]!)) {
    tokens.pop();
  }
  const query = commaForm ? (segments[0] ?? "") : (tokens[tokens.length - 1] ?? "").replace(/[.,]+$/, "");
  if (query.length === 0) {
    throw new Error("North Carolina committee search needs a non-empty candidate name");
  }
  return query;
}

// Auto-link evidence from the artifact cache: the committee-search page
// cached for this candidate's name. Fail-closed — a candidate without a
// cached search throws (the auto-linker records it per candidate and moves
// on), because an empty rows array would read as "searched, found nothing"
// and mask the missing acquisition.
export function createNcsbeCachedCommitteeSearchLoader(
  cacheDir: string
): NorthCarolinaCandidateSearchRowsLoader {
  return async (candidateElection) => {
    const query = northCarolinaCommitteeSearchQueryForCandidateName(candidateElection.candidateName);
    const { body, manifest } = await readNcsbeArtifact({
      cacheDir,
      key: { type: "committee_search", query },
    });
    return { rows: parseNcsbeCommitteeSearchPage(body), sourceUrl: manifest.url };
  };
}

async function readArtifactOrExplain(input: {
  cacheDir: string;
  key: NcsbeArtifactKey;
}): Promise<{ body: string; url: string }> {
  try {
    const { body, manifest } = await readNcsbeArtifact(input);
    return { body, url: manifest.url };
  } catch (error) {
    throw new Error(
      `${errorMessage(error)} — run north-carolina-candidates:finance:raw:refresh to (re)acquire it`
    );
  }
}

// Reads and reassembles one report's complete transaction row set from its
// cached pages. Every page must agree on recordCountKey and the reassembled
// row count must equal it — a partial or mixed-vintage page set fails closed
// (decision 9's completeness contract, replayed at read time).
async function readTransactionRows<Row>(input: {
  cacheDir: string;
  reportId: string;
  kind: "receipts" | "expenditures";
  parse: (body: string) => NcsbeTransactionPage<Row>;
}): Promise<Row[]> {
  const label = `NCSBE report ${input.reportId} ${input.kind}`;
  const firstPage = await readArtifactOrExplain({
    cacheDir: input.cacheDir,
    key: { type: "report_transactions", reportId: input.reportId, kind: input.kind, page: 0 },
  });
  const parsedFirst = input.parse(firstPage.body);
  const recordCount = parsedFirst.recordCount;
  const rows = [...parsedFirst.rows];
  const pageCount = Math.max(1, Math.ceil(recordCount / NCSBE_TRANSACTION_PAGE_SIZE));
  for (let page = 1; page < pageCount; page += 1) {
    const pageArtifact = await readArtifactOrExplain({
      cacheDir: input.cacheDir,
      key: { type: "report_transactions", reportId: input.reportId, kind: input.kind, page },
    });
    const parsed = input.parse(pageArtifact.body);
    if (parsed.recordCount !== recordCount) {
      throw new Error(
        `${label} page ${page} reports recordCountKey ${parsed.recordCount}, page 0 reported ${recordCount} — ` +
          "mixed-vintage cached pages; run north-carolina-candidates:finance:raw:refresh"
      );
    }
    rows.push(...parsed.rows);
  }
  if (rows.length !== recordCount) {
    throw new Error(
      `${label} cached pages hold ${rows.length} rows but recordCountKey says ${recordCount} — ` +
        "incomplete cached page set; run north-carolina-candidates:finance:raw:refresh"
    );
  }
  return rows;
}

type DirectAggregationForCommittee = {
  result: NorthCarolinaDirectAggregationResult;
  // Per-report artifact read failures — the aggregator sees these reports as
  // missing and returns incomplete_artifacts; the messages ride into the item
  // error so the operator sees WHY the report could not be supplied.
  reportReadFailures: Array<{ reportId: string; message: string }>;
};

// One committee's direct-money aggregation from cache. The inventory artifact
// is required; per-report artifacts are supplied best-effort and the
// aggregator's own missing-report accounting decides the status.
async function aggregateDirectForCommittee(input: {
  cacheDir: string;
  electionYear: number;
  sboeId: string;
}): Promise<DirectAggregationForCommittee> {
  const inventory = await readArtifactOrExplain({
    cacheDir: input.cacheDir,
    key: { type: "document_inventory", sboeId: input.sboeId },
  });
  const inventoryRows = parseNcsbeDocumentListPage(inventory.body);

  // Same selection the acquisition fetches by (period overlap incl. unusable
  // dates), so the supplied report set and the aggregator's expectations can
  // only diverge when the cache is actually missing something.
  const { selected } = selectNcsbeCycleReportRows({
    rows: inventoryRows,
    cycleYear: input.electionYear,
  });
  const reports: NorthCarolinaDirectReportInput[] = [];
  const reportReadFailures: Array<{ reportId: string; message: string }> = [];
  const seenReportIds = new Set<string>();
  for (const row of selected) {
    const reportId = row.dataLink;
    if (reportId === null || seenReportIds.has(reportId)) {
      continue;
    }
    seenReportIds.add(reportId);
    try {
      const cover = await readArtifactOrExplain({
        cacheDir: input.cacheDir,
        key: { type: "report_cover", reportId },
      });
      reports.push({
        reportId,
        cover: parseNcsbeReportDetailPage(cover.body),
        receiptRows: await readTransactionRows({
          cacheDir: input.cacheDir,
          reportId,
          kind: "receipts",
          parse: parseNcsbeReceiptsPage,
        }),
        expenditureRows: await readTransactionRows({
          cacheDir: input.cacheDir,
          reportId,
          kind: "expenditures",
          parse: parseNcsbeExpendituresPage,
        }),
      });
    } catch (error) {
      reportReadFailures.push({ reportId, message: errorMessage(error) });
    }
  }

  return {
    result: aggregateNorthCarolinaDirectFinance({
      electionYear: input.electionYear,
      inventoryRows,
      reports,
      sourceUrl: inventory.url,
    }),
    reportReadFailures,
  };
}

const SECTION_TOTAL_EXPENDITURES = 90;

function officialExpenditureTotalCents(cover: ReturnType<typeof parseNcsbeReportDetailPage>): number | null {
  const section = cover.summarySections.find((row) => row.sequence === SECTION_TOTAL_EXPENDITURES);
  return section ? section.periodCents : null;
}

// One spender's receipt rows from cache (funder leg, PR 8 #3). A registered
// spender (SBoEID) is funded through its REGULAR disclosure reports — its
// document inventory piped through the SAME selection the direct money leg
// uses (the cycle-window "Disclosure Report" filter, so IE informational
// filings never re-read IE money, then the decision-8 CURRENT-filing
// selector, so an amended report's original can never be summed alongside —
// or instead of — its amendment; review round), receipts only. A
// superseded-unavailable period (image-only current filing) or a
// quarantined lineage makes the spender's funder picture provably partial,
// so it throws — the direct leg's honest-null analogue, landing as
// funders-unavailable. An unregistered filer (`NC-IE-FILER:` key) has no
// regular filings; its disclosed funders are the Donation rows on its own
// selected, non-quarantined IE reports (decision 6) — never presented as
// full funding, never backfilled from older cycles.
async function collectSpenderReceiptRows(input: {
  cacheDir: string;
  electionYear: number;
  committeeId: string;
  ieReportIds: readonly string[];
}): Promise<NcsbeReceiptRow[]> {
  const rows: NcsbeReceiptRow[] = [];
  if (NORTH_CAROLINA_SBOEID_PATTERN.test(input.committeeId)) {
    const inventory = await readArtifactOrExplain({
      cacheDir: input.cacheDir,
      key: { type: "document_inventory", sboeId: input.committeeId },
    });
    const { rows: cycleRows } = selectNorthCarolinaDirectCycleReportRows({
      rows: parseNcsbeDocumentListPage(inventory.body),
      electionYear: input.electionYear,
    });
    const selection = selectNcsbeCurrentFilings({ rows: cycleRows });
    if (selection.supersededUnavailable.length > 0 || selection.quarantinedGroups.length > 0) {
      throw new Error(
        `NCSBE spender committee ${input.committeeId} has ` +
          `${selection.supersededUnavailable.length} superseded-unavailable period(s) and ` +
          `${selection.quarantinedGroups.length} quarantined filing lineage(s) — ` +
          "its funder picture would be partial"
      );
    }
    for (const filing of selection.selected) {
      rows.push(
        ...(await readTransactionRows({
          cacheDir: input.cacheDir,
          reportId: filing.reportId!,
          kind: "receipts",
          parse: parseNcsbeReceiptsPage,
        }))
      );
    }
    return rows;
  }
  for (const reportId of input.ieReportIds) {
    rows.push(
      ...(await readTransactionRows({
        cacheDir: input.cacheDir,
        reportId,
        kind: "receipts",
        parse: parseNcsbeReceiptsPage,
      }))
    );
  }
  return rows;
}

// Digits lose their leading zeros ("027" and "27" are one district); anything
// else is compared trimmed and case-folded. Empty means "district unknown".
function normalizeTargetDistrict(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim().toUpperCase();
  if (/^\d+$/.test(trimmed)) {
    return String(Number(trimmed));
  }
  return trimmed;
}

// Keyed by candidateId + office scope + normalized district (review round):
// one PERSON due for several elections of the same race (primary + general)
// shares a single target, while two DIFFERENT people who happen to share a
// name stay separate targets — the aggregator quarantines rows aimed at that
// shared name as ambiguous instead of paying the same money to both
// (decision 5 fail-closed). District is in the key because one person can
// contest the same office in two districts in one cycle (NC's redistricting
// churn makes that real): without it both elections would share one target
// and district-27 money would publish on the district-30 row. Office SCOPE,
// not the free-text office name, so a manually-typed office label can never
// split one person into two self-ambiguating targets.
function outsideTargetKey(
  row: Pick<NorthCarolinaCandidateFinanceDueRow, "candidateId" | "officeScope" | "district">
): string {
  return `${row.candidateId}\u0000${row.officeScope}\u0000${normalizeTargetDistrict(row.district)}`;
}

type NorthCarolinaOutsideTargetCandidateRow = {
  candidateId: string;
  candidateName: string;
  officeScope: string;
  district: string | null;
};

// The ambiguity guard is only as good as its target universe: matching
// against just the current due page (stale-filtered and capped at
// maxCandidates) would let a same-name candidate look unique whenever their
// double is not due in the same run, and attribution would then depend on
// sync timing. The universe is every NC candidate election of the year
// (review round — active links alone are NOT enough: IE targets are matched
// by NAME, so a same-name candidate with no committee link, an out-of-scope
// office, or a withdrawn candidacy still makes that name ambiguous; a
// link-only universe would silently hand their money to whoever happens to
// be linked). Extra targets can only fail closed — a universe-only target
// either absorbs nothing that was ours or forces a quarantine — and written
// rows stay limited to the due page.
async function listNorthCarolinaOutsideTargetCandidatesForYear(
  db: Queryable,
  electionYear: number
): Promise<NorthCarolinaOutsideTargetCandidateRow[]> {
  const result = await db.query<{
    candidate_id: string;
    candidate_name: string | null;
    office_scope: string | null;
    district: string | null;
  }>(
    `
      SELECT DISTINCT
        candidate.id::text AS candidate_id,
        COALESCE(
          NULLIF(trim(candidate.display_name), ''),
          NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), '')
        ) AS candidate_name,
        office.scope AS office_scope,
        CASE
          WHEN district.district_type IN ('state_upper', 'state_lower') THEN
            NULLIF(
              regexp_replace(
                substring(district.geoid_compact from char_length(district.state_fips) + 1),
                '^0+',
                ''
              ),
              ''
            )
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
        AND district.state = 'NC'
        AND election.race_type = 'office'
        AND election.election_date >= make_date($1::int, 1, 1)
        AND election.election_date < make_date($1::int + 1, 1, 1)
    `,
    [electionYear]
  );
  return result.rows
    .filter((row) => (row.candidate_name ?? "").trim().length > 0)
    .map((row) => ({
      candidateId: row.candidate_id,
      candidateName: row.candidate_name!,
      officeScope: row.office_scope ?? "",
      district: row.district,
    }));
}

type OutsideTargetSet = {
  // Canonical targets handed to the aggregator, keyed by candidateKey.
  targetsByKey: Map<string, NorthCarolinaOutsideCandidateTarget>;
  // Every key ever computed for a row -> its canonical target's key. A
  // district-less row (e.g. a manual link that never recorded one) aliases
  // into the same person's single district-bearing target instead of
  // becoming a second target that would make the person ambiguous with
  // themselves.
  canonicalKeyByAlias: Map<string, string>;
  // Keys of district-less rows whose person has two or more known districts
  // (review round): no alias can be picked without arbitrarily inheriting
  // one district's money, and a district-less TARGET would match every row
  // either district target matches — quarantining even well-discriminated
  // rows — so these keys resolve to "outside data unavailable" at write.
  ambiguousDistrictlessKeys: Set<string>;
};

function buildOutsideTargetSet(
  rows: ReadonlyArray<
    Pick<NorthCarolinaCandidateFinanceDueRow, "candidateId" | "candidateName" | "officeScope" | "district">
  >
): OutsideTargetSet {
  const targetsByKey = new Map<string, NorthCarolinaOutsideCandidateTarget>();
  const canonicalKeyByAlias = new Map<string, string>();
  const ambiguousDistrictlessKeys = new Set<string>();

  // Pass 1: every known district per person + office scope (normalized ->
  // first raw spelling), so pass 2 is order-independent. The earlier
  // single-pass fold aliased a district-less row to whichever district
  // happened to be inserted first (review round).
  const knownDistricts = new Map<string, Map<string, string | null>>();
  for (const row of rows) {
    const district = normalizeTargetDistrict(row.district);
    if (district === "") {
      continue;
    }
    const personScope = `${row.candidateId}\u0000${row.officeScope}`;
    const known = knownDistricts.get(personScope) ?? new Map<string, string | null>();
    if (!known.has(district)) {
      known.set(district, row.district);
    }
    knownDistricts.set(personScope, known);
  }

  // Pass 2: district-bearing rows key their own target (two distinct known
  // districts stay separate targets — the genuinely-two-races case); a
  // district-less row folds into the person's known district only when
  // exactly one exists.
  for (const row of rows) {
    const key = outsideTargetKey(row);
    if (canonicalKeyByAlias.has(key) || ambiguousDistrictlessKeys.has(key)) {
      continue;
    }
    let district = normalizeTargetDistrict(row.district);
    let rawDistrict = row.district;
    if (district === "") {
      const known = knownDistricts.get(`${row.candidateId}\u0000${row.officeScope}`);
      if (known !== undefined && known.size > 1) {
        ambiguousDistrictlessKeys.add(key);
        continue;
      }
      const sole = known === undefined ? undefined : [...known.entries()][0];
      if (sole !== undefined) {
        district = sole[0];
        rawDistrict = sole[1];
      }
    }
    const canonicalKey = `${row.candidateId}\u0000${row.officeScope}\u0000${district}`;
    if (!targetsByKey.has(canonicalKey)) {
      targetsByKey.set(canonicalKey, {
        candidateKey: canonicalKey,
        candidateName: row.candidateName,
        officeScope: row.officeScope,
        district: rawDistrict,
      });
    }
    canonicalKeyByAlias.set(key, canonicalKey);
  }

  return { targetsByKey, canonicalKeyByAlias, ambiguousDistrictlessKeys };
}

type OutsideAggregationForYear = {
  // Null when the outside leg was unavailable for the year.
  byTargetKey: Map<string, NorthCarolinaCandidateOutsideFinanceInput> | null;
  // Filer keys (SBoEID / NC-IE-FILER hash) whose IE reports were aggregated
  // (not quarantined) — the inverse-miss cross-check's evidence set.
  aggregatedIeFilerKeys: Set<string>;
  // Due-row keys whose outside slice is undecidable (district-less row for a
  // person with two known districts) — resolved to null at write time so the
  // writer preserves stored outside data instead of publishing a false zero
  // or an arbitrary district's money.
  ambiguousDistrictlessKeys: Set<string>;
  summary: NorthCarolinaOutsideAggregationYearSummary;
};

async function aggregateOutsideForYear(input: {
  db: Queryable;
  cacheDir: string;
  electionYear: number;
  dueRows: readonly NorthCarolinaCandidateFinanceDueRow[];
}): Promise<OutsideAggregationForYear> {
  const unavailable = (message: string): OutsideAggregationForYear => {
    console.warn(
      `North Carolina outside-spending data unavailable for ${input.electionYear}; syncing direct finance and preserving stored outside totals:`,
      message
    );
    return {
      byTargetKey: null,
      aggregatedIeFilerKeys: new Set(),
      ambiguousDistrictlessKeys: new Set(),
      summary: { electionYear: input.electionYear, available: false, error: message },
    };
  };

  try {
    // Both cycle years' IE doc-type inventories (decision 9).
    const ieInventoryRows: NcsbeDocumentRow[] = [];
    let sourceUrl: string | null = null;
    for (const year of [input.electionYear - 1, input.electionYear]) {
      const inventory = await readArtifactOrExplain({
        cacheDir: input.cacheDir,
        key: { type: "ie_doc_type_inventory", year },
      });
      ieInventoryRows.push(...parseNcsbeDocumentListPage(inventory.body));
      sourceUrl = inventory.url;
    }

    // Best-effort report inputs for every structured filing; the aggregator
    // treats an unsupplied selected report as missing_artifacts, and any
    // missing report fails the year closed below.
    const reports: NorthCarolinaOutsideReportInput[] = [];
    const seenReportIds = new Set<string>();
    const reportReadFailures = new Map<string, string>();
    for (const row of ieInventoryRows) {
      const reportId = row.dataLink;
      if (reportId === null || seenReportIds.has(reportId)) {
        continue;
      }
      seenReportIds.add(reportId);
      try {
        const cover = await readArtifactOrExplain({
          cacheDir: input.cacheDir,
          key: { type: "report_cover", reportId },
        });
        reports.push({
          reportId,
          officialExpenditureTotalCents: officialExpenditureTotalCents(parseNcsbeReportDetailPage(cover.body)),
          expenditureRows: await readTransactionRows({
            cacheDir: input.cacheDir,
            reportId,
            kind: "expenditures",
            parse: parseNcsbeExpendituresPage,
          }),
        });
      } catch (error) {
        // Left unsupplied — the aggregator's missing-report accounting (and
        // the fail-closed gate below) owns the consequence; the reason is
        // kept so the unavailable message can name it (review round).
        reportReadFailures.set(reportId, errorMessage(error));
      }
    }

    // Due rows first (their result slices are the ones written), then the
    // year's full candidate-election universe so same-name doubles are
    // visible to the ambiguity guard even when they are not due this run
    // (or were never linked at all).
    const universeRows = await listNorthCarolinaOutsideTargetCandidatesForYear(input.db, input.electionYear);
    const { targetsByKey, canonicalKeyByAlias, ambiguousDistrictlessKeys } = buildOutsideTargetSet([
      ...input.dueRows,
      ...universeRows,
    ]);

    const aggregation = aggregateNorthCarolinaOutsideSpending({
      ieInventoryRows,
      reports,
      candidates: [...targetsByKey.values()],
      sourceUrl,
    });

    // A selected structured IE report with no readable cached artifacts means
    // its money is invisible — any total published around it could be a
    // false zero or an undercount, so the whole year fails closed to
    // "unavailable" (stored outside data is preserved) until re-acquisition.
    if (aggregation.missingReportIds.length > 0) {
      return unavailable(
        `${aggregation.missingReportIds.length} selected IE report(s) have no readable cached artifacts ` +
          `(run north-carolina-candidates:finance:raw:refresh): ` +
          aggregation.missingReportIds
            .map((reportId) => `${reportId}: ${reportReadFailures.get(reportId) ?? "not cached"}`)
            .join("; ")
      );
    }

    const byTargetKey = new Map<string, NorthCarolinaCandidateOutsideFinanceInput>();
    for (const key of targetsByKey.keys()) {
      // The aggregation only lists candidates with attributed rows; every
      // other target really has zero attributed outside spending.
      byTargetKey.set(key, { supportTotal: 0, opposeTotal: 0, groups: [] });
    }
    for (const candidate of aggregation.candidates) {
      byTargetKey.set(candidate.candidateKey, {
        supportTotal: candidate.supportTotal,
        opposeTotal: candidate.opposeTotal,
        groups: candidate.groups,
      });
    }

    // Funder leg (PR 8, #3): each spender committee behind the year's
    // attributed groups is read from cache exactly once. ANY read failure
    // fails the WHOLE year's funder leg closed (funders null → the writer
    // keeps stored breakdown rows): a partial picture would publish "no
    // disclosed funders" for the unreadable spender — a silent undercount.
    // The outside totals above are unaffected; funders are enrichment.
    const spenderCommitteeIds = new Set<string>();
    for (const candidate of aggregation.candidates) {
      for (const group of candidate.groups) {
        spenderCommitteeIds.add(group.committeeId);
      }
    }
    // Selected non-quarantined IE reports per group id — the unregistered
    // filers' receipt source. The selector keys filers as SBoEID or
    // `NAME:<key>`; recomputing the group id through the same decision-6
    // function keeps both sides exact.
    const ieReportIdsByGroupCommitteeId = new Map<string, string[]>();
    for (const report of aggregation.reports) {
      if (report.quarantined) {
        continue;
      }
      const groupCommitteeId = report.filerKey.startsWith("NAME:")
        ? northCarolinaOutsideGroupCommitteeId({ sboeId: null, committeeName: report.committeeName })
        : report.filerKey;
      const list = ieReportIdsByGroupCommitteeId.get(groupCommitteeId) ?? [];
      list.push(report.reportId);
      ieReportIdsByGroupCommitteeId.set(groupCommitteeId, list);
    }
    let funderRowsByCommitteeId: Map<string, readonly NcsbeReceiptRow[]> | null = new Map();
    let fundersError: string | undefined;
    let funderReceiptRowCount = 0;
    for (const committeeId of spenderCommitteeIds) {
      try {
        const receiptRows = await collectSpenderReceiptRows({
          cacheDir: input.cacheDir,
          electionYear: input.electionYear,
          committeeId,
          ieReportIds: ieReportIdsByGroupCommitteeId.get(committeeId) ?? [],
        });
        funderRowsByCommitteeId.set(committeeId, receiptRows);
        funderReceiptRowCount += receiptRows.length;
      } catch (error) {
        funderRowsByCommitteeId = null;
        fundersError = `spender ${committeeId}: ${errorMessage(error)}`;
        console.warn(
          `North Carolina spender receipt artifacts unavailable for ${input.electionYear}; ` +
            "syncing outside totals and preserving stored funder breakdowns:",
          fundersError
        );
        break;
      }
    }
    // Enriched BEFORE the alias loop below so aliased keys share the same
    // funder-carrying slice objects.
    const funderUnknownReceiptTypeCodes = new Set<string>();
    for (const [key, slice] of byTargetKey) {
      if (funderRowsByCommitteeId === null) {
        byTargetKey.set(key, { ...slice, funders: null });
        continue;
      }
      const funderAggregation = aggregateNorthCarolinaOutsideGroupContributions({
        electionYear: input.electionYear,
        outsideGroups: slice.groups,
        receiptRowsByCommitteeId: funderRowsByCommitteeId,
        sourceUrl,
      });
      // Decision 12 (review round): a receipt code outside the pinned donor
      // vocabulary has unknown semantics — it could be entity donor money —
      // so this candidate's funder slice is withheld (writer preserves
      // stored breakdowns) instead of publishing a possibly-partial
      // picture. Precise by construction: the aggregator only counts codes
      // on spenders inside THIS candidate's groups.
      if (funderAggregation.unknownReceiptTypeCodeRowCount > 0) {
        for (const code of funderAggregation.unknownReceiptTypeCodes) {
          funderUnknownReceiptTypeCodes.add(code);
        }
        console.warn(
          `North Carolina funder receipts carry unknown receipt-type code(s) for ${input.electionYear}; ` +
            "withholding this candidate's funder slice and preserving stored breakdowns:",
          { candidateKey: key, codes: funderAggregation.unknownReceiptTypeCodes }
        );
        byTargetKey.set(key, { ...slice, funders: null });
        continue;
      }
      byTargetKey.set(key, {
        ...slice,
        funders: {
          breakdowns: funderAggregation.outsideGroupBreakdowns,
          matchedReceiptRowCount: funderAggregation.matchedReceiptRowCount,
          includedReceiptRowCount: funderAggregation.includedReceiptRowCount,
          skippedReceiptRowCount: funderAggregation.skippedReceiptRowCount,
        },
      });
    }
    // Aliased keys (a district-less row folded into its person's canonical
    // target) resolve to the canonical slice, so every due row finds its
    // money under its own key.
    for (const [alias, canonicalKey] of canonicalKeyByAlias) {
      if (alias !== canonicalKey) {
        byTargetKey.set(alias, byTargetKey.get(canonicalKey)!);
      }
    }

    const aggregatedIeFilerKeys = new Set<string>();
    for (const report of aggregation.reports) {
      if (!report.quarantined) {
        aggregatedIeFilerKeys.add(report.filerKey);
      }
    }

    return {
      byTargetKey,
      aggregatedIeFilerKeys,
      ambiguousDistrictlessKeys,
      summary: {
        electionYear: input.electionYear,
        available: true,
        reportCount: aggregation.reports.length,
        quarantinedReportCount: aggregation.quarantinedReportCount,
        missingReportIdCount: aggregation.missingReportIds.length,
        coverageGapCount: aggregation.coverageGaps.length,
        unmatchedTargetCount: aggregation.unmatchedTargets.length,
        ambiguousTargetCount: aggregation.ambiguousTargets.length,
        attributedRowCount: aggregation.attributedRowCount,
        attributedCents: aggregation.attributedCents,
        fundersAvailable: funderRowsByCommitteeId !== null,
        ...(fundersError === undefined ? {} : { fundersError }),
        ...(funderRowsByCommitteeId === null ? {} : { funderReceiptRowCount }),
        ...(funderUnknownReceiptTypeCodes.size === 0
          ? {}
          : { funderUnknownReceiptTypeCodes: [...funderUnknownReceiptTypeCodes].sort() }),
      },
    };
  } catch (error) {
    return unavailable(errorMessage(error));
  }
}

export const listDueNorthCarolinaCandidateFinanceSyncRows = createStandardStateFinanceDueListQuery({
  state: "NC",
  tables: {
    links: "nc_candidate_finance_links",
    summaries: "nc_candidate_finance_summaries",
  },
  eligibleOfficeKeys: NORTH_CAROLINA_FINANCE_ELIGIBLE_OFFICE_KEYS,
  linkColumns: ["committee_id", "committee_name", "link_source"],
  mapRow: (row): NorthCarolinaCandidateFinanceDueRow => ({
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    district: row.district,
    committeeId: row.committee_id as string,
    committeeName: row.committee_name as string,
    // The DB CHECK constraint pins link_source to this union.
    linkSource: row.link_source as NorthCarolinaFinanceLinkSource,
    sourceUrl: row.source_url,
    lastSyncedAt: row.last_synced_at,
  }),
});

export async function syncDueNorthCarolinaCandidateFinance(
  input: NorthCarolinaCandidateFinanceBatchSyncInput
): Promise<NorthCarolinaCandidateFinanceBatchSyncResult> {
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
  const cacheDir = rawDataCacheDir(input.rawDataCacheDir);
  const syncFn = input.syncNorthCarolinaCandidateFinanceFn ?? syncNorthCarolinaCandidateFinance;

  if (!dryRun && input.autoLinkMissingLinks !== false) {
    try {
      const autoLinkResults = await autoLinkMissingNorthCarolinaCandidateFinanceLinks({
        db: input.db,
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
        loadCandidateSearchRows:
          input.loadCandidateSearchRows ?? createNcsbeCachedCommitteeSearchLoader(cacheDir),
      });
      for (const result of autoLinkResults) {
        if (result.status !== "linked") {
          console.warn("North Carolina finance auto-link did not link candidate election:", result);
        }
      }
    } catch (error) {
      console.warn(
        "North Carolina finance auto-link skipped; continuing with already-linked candidate sync:",
        errorMessage(error)
      );
    }
  }

  const due = await listDueNorthCarolinaCandidateFinanceSyncRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
  });

  const directByYearAndCommittee = new Map<string, DirectAggregationForCommittee>();
  const directLoadErrors = new Map<string, string>();
  const outsideByYear = new Map<number, OutsideAggregationForYear>();

  for (const [year, yearRows] of groupDueRowsByYear(due.rows).entries()) {
    // Per-committee aggregation, isolated per committee — NC artifacts are
    // per committee, so one broken cache entry never fails the year.
    const committeeIds = new Set(yearRows.map((row) => row.committeeId.trim().toUpperCase()));
    for (const committeeId of committeeIds) {
      const key = `${year}\u0000${committeeId}`;
      try {
        directByYearAndCommittee.set(
          key,
          await aggregateDirectForCommittee({ cacheDir, electionYear: year, sboeId: committeeId })
        );
      } catch (error) {
        directLoadErrors.set(key, errorMessage(error));
      }
    }

    outsideByYear.set(
      year,
      await aggregateOutsideForYear({ db: input.db, cacheDir, electionYear: year, dueRows: yearRows })
    );
  }

  const results: NorthCarolinaCandidateFinanceBatchSyncItemResult[] = [];
  for (const row of due.rows) {
    const committeeId = row.committeeId.trim().toUpperCase();
    const base = {
      candidateId: row.candidateId,
      electionId: row.electionId,
      electionYear: row.electionYear,
      committeeId: row.committeeId,
    };
    const directKey = `${row.electionYear}\u0000${committeeId}`;

    const directLoadError = directLoadErrors.get(directKey);
    if (directLoadError) {
      results.push({ ...base, ok: false, error: directLoadError });
      continue;
    }
    const direct = directByYearAndCommittee.get(directKey);
    if (!direct) {
      results.push({ ...base, ok: false, error: "North Carolina direct finance aggregation missing for committee" });
      continue;
    }
    // The three-status contract's no-write leg, decided here so the item
    // error can carry the read failures that explain WHY reports are missing.
    if (direct.result.status === "incomplete_artifacts") {
      const details = [
        ...direct.result.missingReportIds.map((reportId) => {
          const failure = direct.reportReadFailures.find((entry) => entry.reportId === reportId);
          return failure ? `report ${reportId}: ${failure.message}` : `report ${reportId}: not cached`;
        }),
        ...direct.result.coverIdentityMismatchReportIds.map((reportId) => `report ${reportId}: mispaired cover`),
      ];
      results.push({
        ...base,
        ok: false,
        error:
          "North Carolina finance artifacts incomplete; keeping previous snapshot " +
          `(run north-carolina-candidates:finance:raw:refresh): ${details.join("; ")}`,
      });
      continue;
    }

    const outside = outsideByYear.get(row.electionYear);
    const rowTargetKey = outsideTargetKey(row);
    // A district-less due row for a person with two known districts cannot
    // name its race, so its outside slice is unavailable (the writer
    // preserves stored outside data) instead of a false zero or an
    // arbitrarily inherited district's money (review round).
    const districtlessAmbiguous = outside?.ambiguousDistrictlessKeys.has(rowTargetKey) === true;
    if (districtlessAmbiguous) {
      console.warn(
        "North Carolina outside slice undecidable for district-less due row (person has two known " +
          "districts); preserving stored outside totals:",
        { candidateId: row.candidateId, electionId: row.electionId, electionYear: row.electionYear }
      );
    }
    const outsideFinance = districtlessAmbiguous
      ? null
      : (outside?.byTargetKey?.get(rowTargetKey) ??
        (outside?.byTargetKey ? { supportTotal: 0, opposeTotal: 0, groups: [] } : null));
    const ieInverseMissSuspected =
      direct.result.ieTypedRegularReportRowCount > 0 &&
      outside?.byTargetKey != null &&
      !outside.aggregatedIeFilerKeys.has(committeeId);

    try {
      const result = await syncFn({
        db: input.db,
        candidateId: row.candidateId,
        electionId: row.electionId,
        candidateName: row.candidateName,
        electionYear: row.electionYear,
        officeName: row.officeName,
        district: row.district,
        committee: {
          committeeId: row.committeeId,
          committeeName: row.committeeName,
          linkSource: row.linkSource,
          sourceUrl: row.sourceUrl,
        },
        directFinance: direct.result,
        outsideFinance,
        now,
        dryRun,
      });
      results.push({ ...base, ok: true, ...(ieInverseMissSuspected ? { ieInverseMissSuspected } : {}), result });
      if (ieInverseMissSuspected) {
        console.warn(
          "North Carolina finance inverse-miss suspect: committee has IE-typed regular-report rows but no " +
            "aggregated IE-inventory report (decision 3 cross-check):",
          { committeeId: row.committeeId, candidateId: row.candidateId, electionYear: row.electionYear }
        );
      }
    } catch (error) {
      results.push({ ...base, ok: false, error: errorMessage(error) });
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
    outsideAggregationByYear: [...outsideByYear.values()].map((outside) => outside.summary),
    results,
  };
}
