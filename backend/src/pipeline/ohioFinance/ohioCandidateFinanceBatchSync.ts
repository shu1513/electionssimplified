import type { Pool, PoolClient } from "pg";

import {
  createStandardStateFinanceDueListQuery,
  type StandardStateFinanceDueRow,
} from "../finance/standardStateFinanceDueListQuery.js";
import {
  autoLinkMissingOhioCandidateFinanceLinks,
} from "./ohioCandidateCommitteeAutoLinker.js";
import {
  syncOhioCandidateFinance,
  type OhioCandidateOutsideFinanceInput,
  type OhioCandidateFinanceSyncResult,
} from "./ohioCandidateFinanceSync.js";
import { aggregateOhioOutsideGroupContributions } from "./ohioOutsideGroupContributionAggregator.js";
import {
  createOhioDirectContributionAccumulator,
  type OhioDirectContributionAggregationResult,
} from "./ohioDirectContributionAggregator.js";
import { OHIO_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./ohioFinanceEligibleOffices.js";
import type { OhioFinanceLinkSource } from "./ohioFinanceWriter.js";
import {
  aggregateOhioOutsideSpending,
  type OhioOutsideSpendingCandidateTarget,
} from "./ohioOutsideSpendingAggregator.js";
import { readOhioSos31uDetailBundle } from "./ohioSosArtifactAcquisition.js";
import {
  DEFAULT_OHIO_SOS_CACHE_DIR,
  getOhioSosArtifactPaths,
  getOhioSosArtifactStatus,
  OHIO_SOS_FILE_TRANSFER_PAGE_URL,
  readOhioSosArtifactManifest,
  type OhioSosProductKey,
} from "./ohioSosArtifactCache.js";
import {
  isOhioSos31uExpenditureRow,
  streamOhioSosBulkFile,
  OHIO_SOS_CANDIDATE_CONTRIBUTIONS_FAMILY,
  OHIO_SOS_CANDIDATE_COVER_FAMILY,
  OHIO_SOS_CANDIDATE_EXPENDITURES_FAMILY,
  OHIO_SOS_CANDIDATE_LIST_FAMILY,
  OHIO_SOS_PAC_CONTRIBUTIONS_FAMILY,
  OHIO_SOS_PAC_COVER_FAMILY,
  OHIO_SOS_PAC_EXPENDITURES_FAMILY,
  OHIO_SOS_PARTY_CONTRIBUTIONS_FAMILY,
  OHIO_SOS_PARTY_COVER_FAMILY,
  OHIO_SOS_PARTY_EXPENDITURES_FAMILY,
  type OhioSosBulkFileFamily,
  type OhioSosCandidateCommitteeListRow,
  type OhioSosContributionRow,
  type OhioSosCoverPageRow,
  type OhioSosExpenditureRow,
} from "./ohioSosBulkFiles.js";

// Batch sync for Ohio candidate finance (docs/plans/ohio_plan.md PR 7), maryland
// pattern with one structural difference: the ~90 MB CAC_CON files are
// never materialized (decision 10). Each cycle year streams its two
// contribution files exactly once, feeding one direct accumulator per
// linked committee; the cover files and 31-U rows are small enough to hold.
//
// Outside spending is aggregated once per election year over the DEDUPED
// (candidateId, office) targets of that year's due rows — a candidate
// whose primary and general elections are both due would otherwise appear
// twice in the target list and quarantine every row aimed at them as
// ambiguous. The dedupe key is the candidate id, never the display name:
// two different people sharing a name must remain separate targets so the
// aggregator quarantines that name as ambiguous instead of paying the
// same money to both (decision 5).
//
// Artifact failure policy: missing direct artifacts (contributions or the
// candidate cover file) fail every due row of the year — receipts without
// them would be fabricated. Missing or STALE outside artifacts (expenditure
// files, PAC/party covers, the 31-U detail bundle, or a bundle missing
// report keys the annual files discovered) only disable the outside leg:
// the sync passes outsideFinance null, the writer's preserveWhenNull
// policy keeps the stored outside totals, and the group rows are left
// untouched.

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & {
  connect: () => Promise<PoolClient>;
};

// link_source rides along (alaska/tennessee/virginia pattern) so a sync
// refresh writes the link back with its ORIGINAL provenance — rewriting a
// manual link as sos_bulk_export would both lose the provenance and
// expose the manual pin to auto-link supersession.
export type OhioCandidateFinanceDueRow = StandardStateFinanceDueRow & {
  linkSource: OhioFinanceLinkSource;
};

export type OhioCandidateListData = {
  rows: OhioSosCandidateCommitteeListRow[];
  sourceUrl: string | null;
};

export type OhioCandidateFinanceBatchSyncInput = {
  db: ConnectableQueryable;
  now?: Date;
  dryRun?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  rawDataCacheDir?: string;
  autoLinkMissingLinks?: boolean;
  // Cents of slack for the 31-U reconciliation gates (default 0 — the real
  // files agree exactly).
  outsideToleranceCents?: number;
  // Test injection points.
  candidateListData?: OhioCandidateListData;
  syncOhioCandidateFinanceFn?: typeof syncOhioCandidateFinance;
};

export type OhioCandidateFinanceBatchSyncItemResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  committeeId: string;
  ok: boolean;
  result?: OhioCandidateFinanceSyncResult;
  error?: string;
};

// Per-year outside-spending health, surfaced so a live run can report its
// reconciliation and match rates without re-deriving them.
export type OhioOutsideAggregationYearSummary = {
  electionYear: number;
  available: boolean;
  error?: string;
  reportCount?: number;
  quarantinedReportCount?: number;
  missingDetailReportKeyCount?: number;
  unmatchedTargetCount?: number;
  ambiguousTargetCount?: number;
  attributedRowCount?: number;
  attributedCents?: number;
  // Outside-group funder leg (PR 8). Absent when the outside leg itself was
  // unavailable; false when the PAC/party contribution artifacts could not
  // be loaded (stored breakdown rows are then preserved).
  fundersAvailable?: boolean;
  fundersError?: string;
  // Contribution rows kept for the year's 31-U spender committees.
  funderContributionRowCount?: number;
};

export type OhioCandidateFinanceBatchSyncResult = {
  dryRun: boolean;
  now: string;
  staleAfterDays: number;
  maxCandidates: number;
  dueCandidateCount: number;
  selectedCandidateCount: number;
  syncedCandidateCount: number;
  failedCandidateCount: number;
  outsideAggregationByYear: OhioOutsideAggregationYearSummary[];
  results: OhioCandidateFinanceBatchSyncItemResult[];
};

const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_STALE_AFTER_DAYS = 7;
// Post-general is due December 11; annual is due January 29, followed by
// the portal's five-day publication window and later corrections.
const DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS = 98;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

function assertValidDate(date: Date, label: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid Ohio finance batch sync ${label}`);
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Ohio finance batch sync ${label}: ${value}`);
  }
  return normalized;
}

function rawDataCacheDir(inputCacheDir?: string): string {
  return inputCacheDir ?? (process.env.OHIO_SOS_RAW_DATA_CACHE_DIR?.trim() || DEFAULT_OHIO_SOS_CACHE_DIR);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function groupDueRowsByYear(rows: readonly OhioCandidateFinanceDueRow[]): Map<number, OhioCandidateFinanceDueRow[]> {
  const byYear = new Map<number, OhioCandidateFinanceDueRow[]>();
  for (const row of rows) {
    const yearRows = byYear.get(row.electionYear) ?? [];
    yearRows.push(row);
    byYear.set(row.electionYear, yearRows);
  }
  return byYear;
}

// Every stream goes through the manifest gate first: a cached file whose
// size no longer matches its manifest (a torn copy, an outside edit, a
// truncation that happens to land on a row boundary the parser cannot
// see) must never feed a sync. A file with NO manifest carries nothing to
// verify against — the parser's own validation is then the only defense —
// so it streams with a warning instead of bricking a hand-installed
// cache; a truly absent file still fails when the stream opens.
async function verifiedArtifactPath(input: {
  cacheDir: string;
  productKey: OhioSosProductKey;
  transactionYear?: number;
}): Promise<string> {
  const status = await getOhioSosArtifactStatus(input);
  if (status.status === "stale") {
    throw new Error(
      `Ohio SoS artifact ${status.fileName} does not match its manifest ` +
        `(expected ${status.manifest?.byteSize} bytes) — re-run ohio-candidates:finance:raw:refresh`
    );
  }
  if (status.manifest === null) {
    console.warn(`Ohio SoS artifact ${status.fileName} has no manifest; cache integrity cannot be verified`);
  }
  return status.filePath;
}

async function collectBulkFileRows<T>(input: {
  cacheDir: string;
  productKey: OhioSosProductKey;
  transactionYear?: number;
  family: OhioSosBulkFileFamily<T>;
  now?: Date;
  filter?: (row: T) => boolean;
}): Promise<T[]> {
  const filePath = await verifiedArtifactPath(input);
  const rows: T[] = [];
  await streamOhioSosBulkFile<T>({
    path: filePath,
    family: input.family,
    now: input.now,
    visit: (row) => {
      if (!input.filter || input.filter(row)) {
        rows.push(row);
      }
    },
  });
  return rows;
}

async function loadCandidateListData(input: {
  cacheDir: string;
  now?: Date;
}): Promise<OhioCandidateListData> {
  const paths = getOhioSosArtifactPaths({ cacheDir: input.cacheDir, productKey: "candidate_list" });
  const rows = await collectBulkFileRows<OhioSosCandidateCommitteeListRow>({
    cacheDir: input.cacheDir,
    productKey: "candidate_list",
    family: OHIO_SOS_CANDIDATE_LIST_FAMILY,
    now: input.now,
  });
  const manifest = await readOhioSosArtifactManifest(paths.manifestPath);
  return { rows, sourceUrl: manifest?.fileTransferPageUrl ?? OHIO_SOS_FILE_TRANSFER_PAGE_URL };
}

// The three cumulative cover files are shared by every election year, so
// they are loaded at most once per run.
type CoverRowsLoader = {
  candidateCoverRows: () => Promise<OhioSosCoverPageRow[]>;
  allCoverRows: () => Promise<OhioSosCoverPageRow[]>;
};

function createCoverRowsLoader(input: { cacheDir: string; now?: Date }): CoverRowsLoader {
  let candidatePromise: Promise<OhioSosCoverPageRow[]> | null = null;
  let pacAndPartyPromise: Promise<OhioSosCoverPageRow[]> | null = null;

  const candidateCoverRows = (): Promise<OhioSosCoverPageRow[]> => {
    candidatePromise ??= collectBulkFileRows<OhioSosCoverPageRow>({
      cacheDir: input.cacheDir,
      productKey: "candidate_cover",
      family: OHIO_SOS_CANDIDATE_COVER_FAMILY,
      now: input.now,
    });
    return candidatePromise;
  };

  const allCoverRows = async (): Promise<OhioSosCoverPageRow[]> => {
    pacAndPartyPromise ??= (async () => {
      const pacRows = await collectBulkFileRows<OhioSosCoverPageRow>({
        cacheDir: input.cacheDir,
        productKey: "pac_cover",
        family: OHIO_SOS_PAC_COVER_FAMILY,
        now: input.now,
      });
      const partyRows = await collectBulkFileRows<OhioSosCoverPageRow>({
        cacheDir: input.cacheDir,
        productKey: "party_cover",
        family: OHIO_SOS_PARTY_COVER_FAMILY,
        now: input.now,
      });
      return [...pacRows, ...partyRows];
    })();
    return [...(await candidateCoverRows()), ...(await pacAndPartyPromise)];
  };

  return { candidateCoverRows, allCoverRows };
}

// One direct-aggregation pass for a year: stream CAC_CON_{Y-1,Y} once,
// feeding one accumulator per distinct linked committee.
async function aggregateDirectForYear(input: {
  electionYear: number;
  committeeIds: readonly string[];
  cacheDir: string;
  coverRows: CoverRowsLoader;
  sourceUrl: string;
  now?: Date;
}): Promise<Map<string, OhioDirectContributionAggregationResult>> {
  const accumulators = new Map(
    input.committeeIds.map((committeeId) => [
      committeeId,
      createOhioDirectContributionAccumulator({
        committeeId,
        electionYear: input.electionYear,
        sourceUrl: input.sourceUrl,
      }),
    ])
  );
  if (accumulators.size === 0) {
    return new Map();
  }

  for (const transactionYear of [input.electionYear - 1, input.electionYear]) {
    const filePath = await verifiedArtifactPath({
      cacheDir: input.cacheDir,
      productKey: "candidate_contributions",
      transactionYear,
    });
    await streamOhioSosBulkFile({
      path: filePath,
      family: OHIO_SOS_CANDIDATE_CONTRIBUTIONS_FAMILY,
      now: input.now,
      // Rows are routed by MASTER_KEY instead of offering every row to
      // every accumulator — same result (add() ignores other committees'
      // rows anyway), without the rows × committees scan.
      visit: (row) => {
        accumulators.get(row.masterKey.trim())?.add(row);
      },
    });
  }

  const coverRows = await input.coverRows.candidateCoverRows();
  return new Map(
    [...accumulators.entries()].map(([committeeId, accumulator]) => [
      committeeId,
      accumulator.finish({ coverRows }),
    ])
  );
}

const OUTSIDE_EXPENDITURE_PRODUCTS: ReadonlyArray<{
  productKey: OhioSosProductKey;
  family: OhioSosBulkFileFamily<OhioSosExpenditureRow>;
}> = [
  { productKey: "candidate_expenditures", family: OHIO_SOS_CANDIDATE_EXPENDITURES_FAMILY },
  { productKey: "pac_expenditures", family: OHIO_SOS_PAC_EXPENDITURES_FAMILY },
  { productKey: "party_expenditures", family: OHIO_SOS_PARTY_EXPENDITURES_FAMILY },
];

// Funder-leg sources (PR 8). Candidate-committee 31-U spenders are NOT
// covered: their receipts live in the ~90 MB CAC_CON files, and on the real
// 2026-cycle files no bundle-covered spender is a candidate committee —
// their groups simply carry no funder breakdowns.
const OUTSIDE_FUNDER_CONTRIBUTION_PRODUCTS: ReadonlyArray<{
  productKey: OhioSosProductKey;
  family: OhioSosBulkFileFamily<OhioSosContributionRow>;
}> = [
  { productKey: "pac_contributions", family: OHIO_SOS_PAC_CONTRIBUTIONS_FAMILY },
  { productKey: "party_contributions", family: OHIO_SOS_PARTY_CONTRIBUTIONS_FAMILY },
];

// One filtered pass over the year's PAC/party contribution files: only rows
// whose MASTER_KEY belongs to a 31-U spender committee are kept, so the
// held slice stays small (the files themselves are 2–60 MB).
async function collectFunderContributionRows(input: {
  electionYear: number;
  spenderCommitteeIds: ReadonlySet<string>;
  cacheDir: string;
  now?: Date;
}): Promise<OhioSosContributionRow[]> {
  const rows: OhioSosContributionRow[] = [];
  for (const { productKey, family } of OUTSIDE_FUNDER_CONTRIBUTION_PRODUCTS) {
    for (const transactionYear of [input.electionYear - 1, input.electionYear]) {
      const filePath = await verifiedArtifactPath({ cacheDir: input.cacheDir, productKey, transactionYear });
      await streamOhioSosBulkFile<OhioSosContributionRow>({
        path: filePath,
        family,
        now: input.now,
        visit: (row) => {
          if (input.spenderCommitteeIds.has(row.masterKey.trim())) {
            rows.push(row);
          }
        },
      });
    }
  }
  return rows;
}

// Keyed by candidateId + office so one PERSON due for several elections
// (primary + general) shares a single target, while two DIFFERENT people
// who happen to share a name stay separate targets - the aggregator then
// quarantines rows aimed at that shared name as ambiguous instead of
// paying the same money to both (decision 5 fail-closed).
function outsideTargetKey(row: Pick<OhioCandidateFinanceDueRow, "candidateId" | "officeName">): string {
  return `${row.candidateId}\u0000${row.officeName}`;
}

type OutsideAggregationForYear = {
  // Null when the outside leg was unavailable for the year.
  byTargetKey: Map<string, OhioCandidateOutsideFinanceInput> | null;
  summary: OhioOutsideAggregationYearSummary;
};

type OhioOutsideTargetCandidateRow = {
  candidateId: string;
  candidateName: string;
  officeName: string;
};

// The ambiguity guard is only as good as its target universe: matching
// against just the current due page (stale-filtered and capped at
// maxCandidates) would let a same-name candidate look unique whenever
// their double is not due in the same run, and attribution would then
// depend on sync timing. The universe is every ACTIVE link of the
// election year — written rows stay limited to the due page. A same-name
// candidate with no link at all is still invisible here; auto-link runs
// first and links everyone the SoS list resolves.
async function listOhioOutsideTargetCandidatesForYear(
  db: Queryable,
  electionYear: number
): Promise<OhioOutsideTargetCandidateRow[]> {
  const result = await db.query<{ candidate_id: string; candidate_name: string | null; office_name: string }>(
    `
      SELECT DISTINCT
        candidate.id::text AS candidate_id,
        COALESCE(
          NULLIF(trim(candidate.display_name), ''),
          NULLIF(trim(candidate.first_name || ' ' || candidate.last_name), ''),
          link.candidate_name_normalized
        ) AS candidate_name,
        link.office_name
      FROM public.oh_candidate_finance_links AS link
      JOIN public.candidates AS candidate
        ON candidate.id = link.candidate_id
      WHERE link.link_status = 'active'
        AND link.election_year = $1::int
        AND candidate.deleted_at IS NULL
    `,
    [electionYear]
  );
  return result.rows
    .filter((row) => (row.candidate_name ?? "").trim().length > 0)
    .map((row) => ({
      candidateId: row.candidate_id,
      candidateName: row.candidate_name!,
      officeName: row.office_name,
    }));
}

async function aggregateOutsideForYear(input: {
  db: Queryable;
  electionYear: number;
  dueRows: readonly OhioCandidateFinanceDueRow[];
  cacheDir: string;
  coverRows: CoverRowsLoader;
  sourceUrl: string;
  toleranceCents?: number;
  now?: Date;
}): Promise<OutsideAggregationForYear> {
  try {
    const annualExpenditureRows: OhioSosExpenditureRow[] = [];
    for (const { productKey, family } of OUTSIDE_EXPENDITURE_PRODUCTS) {
      for (const transactionYear of [input.electionYear - 1, input.electionYear]) {
        const filePath = await verifiedArtifactPath({ cacheDir: input.cacheDir, productKey, transactionYear });
        await streamOhioSosBulkFile<OhioSosExpenditureRow>({
          path: filePath,
          family,
          now: input.now,
          visit: (row) => {
            if (isOhioSos31uExpenditureRow(row)) {
              annualExpenditureRows.push(row);
            }
          },
        });
      }
    }

    const detailReports = await readOhioSos31uDetailBundle({
      cacheDir: input.cacheDir,
      cycleYear: input.electionYear,
    });
    const coverRows = await input.coverRows.allCoverRows();

    // Due rows first (their result slices are the ones written), then the
    // year's full active-link universe so same-name doubles are visible to
    // the ambiguity guard even when they are not due this run.
    const universeRows = await listOhioOutsideTargetCandidatesForYear(input.db, input.electionYear);
    const targetsByKey = new Map<string, OhioOutsideSpendingCandidateTarget>();
    for (const row of [...input.dueRows, ...universeRows]) {
      const key = outsideTargetKey(row);
      if (!targetsByKey.has(key)) {
        targetsByKey.set(key, {
          candidateKey: key,
          candidateName: row.candidateName,
          officeName: row.officeName,
        });
      }
    }

    const aggregation = aggregateOhioOutsideSpending({
      electionYear: input.electionYear,
      annualExpenditureRows,
      detailReports,
      coverRows,
      candidates: [...targetsByKey.values()],
      toleranceCents: input.toleranceCents,
      sourceUrl: input.sourceUrl,
    });

    // A report key discovered in the annual files with no detail report
    // means the bundle predates that filing — its money is invisible, so
    // any total published from this bundle could be a false zero or an
    // undercount. The whole year fails closed to "unavailable" (stored
    // outside data is preserved) until the bundle is refreshed.
    if (aggregation.missingDetailReportKeys.length > 0) {
      const message =
        `31-U detail bundle is stale: ${aggregation.missingDetailReportKeys.length} annual report key(s) have no ` +
        `detail report (re-run ohio-candidates:finance:raw:refresh): ${aggregation.missingDetailReportKeys.join(", ")}`;
      console.warn(
        `Ohio SoS outside-spending data incomplete for ${input.electionYear}; syncing direct finance and preserving stored outside totals:`,
        message
      );
      return {
        byTargetKey: null,
        summary: {
          electionYear: input.electionYear,
          available: false,
          error: message,
          reportCount: aggregation.reports.length,
          quarantinedReportCount: aggregation.quarantinedReportCount,
          missingDetailReportKeyCount: aggregation.missingDetailReportKeys.length,
        },
      };
    }

    const byTargetKey = new Map<string, OhioCandidateOutsideFinanceInput>();
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

    // Funder leg (PR 8): one filtered pass over the PAC/party contribution
    // files for the year's 31-U spender committees, then a per-candidate
    // slice. A funder artifact failure only disables this leg (funders
    // null → the writer keeps the stored breakdown rows); the outside
    // totals above still sync.
    const spenderCommitteeIds = new Set<string>();
    for (const slice of byTargetKey.values()) {
      for (const group of slice.groups) {
        spenderCommitteeIds.add(group.committeeId.trim());
      }
    }
    let funderRows: OhioSosContributionRow[] | null = [];
    let fundersError: string | undefined;
    if (spenderCommitteeIds.size > 0) {
      try {
        funderRows = await collectFunderContributionRows({
          electionYear: input.electionYear,
          spenderCommitteeIds,
          cacheDir: input.cacheDir,
          now: input.now,
        });
      } catch (error) {
        funderRows = null;
        fundersError = errorMessage(error);
        console.warn(
          `Ohio SoS outside-group funder artifacts unavailable for ${input.electionYear}; syncing outside totals and preserving stored funder breakdowns:`,
          fundersError
        );
      }
    }
    for (const [key, slice] of byTargetKey) {
      if (funderRows === null) {
        byTargetKey.set(key, { ...slice, funders: null });
        continue;
      }
      const funderAggregation = aggregateOhioOutsideGroupContributions({
        electionYear: input.electionYear,
        outsideGroups: slice.groups,
        contributionRows: funderRows,
        sourceUrl: input.sourceUrl,
      });
      byTargetKey.set(key, {
        ...slice,
        funders: {
          breakdowns: funderAggregation.outsideGroupBreakdowns,
          matchedContributionRowCount: funderAggregation.matchedContributionRowCount,
          includedContributionRowCount: funderAggregation.includedContributionRowCount,
          skippedContributionRowCount: funderAggregation.skippedContributionRowCount,
        },
      });
    }

    return {
      byTargetKey,
      summary: {
        electionYear: input.electionYear,
        available: true,
        reportCount: aggregation.reports.length,
        quarantinedReportCount: aggregation.quarantinedReportCount,
        missingDetailReportKeyCount: aggregation.missingDetailReportKeys.length,
        unmatchedTargetCount: aggregation.unmatchedTargets.length,
        ambiguousTargetCount: aggregation.ambiguousTargets.length,
        attributedRowCount: aggregation.attributedRowCount,
        attributedCents: aggregation.attributedCents,
        fundersAvailable: funderRows !== null,
        ...(fundersError === undefined ? {} : { fundersError }),
        ...(funderRows === null ? {} : { funderContributionRowCount: funderRows.length }),
      },
    };
  } catch (error) {
    const message = errorMessage(error);
    // The message carries the real cause — this can be a missing artifact
    // OR an aggregation failure (e.g. a duplicate detail report key), so
    // the warning stays neutral about which.
    console.warn(
      `Ohio SoS outside-spending aggregation unavailable for ${input.electionYear}; syncing direct finance and preserving stored outside totals:`,
      message
    );
    return {
      byTargetKey: null,
      summary: { electionYear: input.electionYear, available: false, error: message },
    };
  }
}

export const listDueOhioCandidateFinanceSyncRows = createStandardStateFinanceDueListQuery({
  state: "OH",
  tables: {
    links: "oh_candidate_finance_links",
    summaries: "oh_candidate_finance_summaries",
  },
  eligibleOfficeKeys: OHIO_FINANCE_ELIGIBLE_OFFICE_KEYS,
  linkColumns: ["committee_id", "committee_name", "link_source"],
  mapRow: (row): OhioCandidateFinanceDueRow => ({
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
    linkSource: row.link_source as OhioFinanceLinkSource,
    sourceUrl: row.source_url,
    lastSyncedAt: row.last_synced_at,
  }),
});

export async function syncDueOhioCandidateFinance(
  input: OhioCandidateFinanceBatchSyncInput
): Promise<OhioCandidateFinanceBatchSyncResult> {
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
  const syncFn = input.syncOhioCandidateFinanceFn ?? syncOhioCandidateFinance;

  if (!dryRun && input.autoLinkMissingLinks !== false) {
    try {
      const candidateListData = input.candidateListData ?? (await loadCandidateListData({ cacheDir, now }));
      const autoLinkResults = await autoLinkMissingOhioCandidateFinanceLinks({
        db: input.db,
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
        candidateListRows: candidateListData.rows,
        sourceUrl: candidateListData.sourceUrl,
      });
      for (const result of autoLinkResults) {
        if (result.status !== "linked") {
          console.warn("Ohio finance auto-link did not link candidate election:", result);
        }
      }
    } catch (error) {
      console.warn(
        "Ohio finance auto-link skipped; continuing with already-linked candidate sync:",
        errorMessage(error)
      );
    }
  }

  const due = await listDueOhioCandidateFinanceSyncRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
  });

  const coverRows = createCoverRowsLoader({ cacheDir, now });
  const directByYear = new Map<number, Map<string, OhioDirectContributionAggregationResult>>();
  const directLoadErrorsByYear = new Map<number, string>();
  const outsideByYear = new Map<number, OutsideAggregationForYear>();
  const invalidCommitteeIdErrors = new Map<string, string>();

  for (const [year, yearRows] of groupDueRowsByYear(due.rows).entries()) {
    // A non-numeric committee id on a link is upstream damage; it fails that
    // row alone, never the year.
    const committeeIds = new Set<string>();
    for (const row of yearRows) {
      const committeeId = row.committeeId.trim();
      if (/^[0-9]+$/.test(committeeId)) {
        committeeIds.add(committeeId);
      } else {
        invalidCommitteeIdErrors.set(
          `${row.candidateId}\u0000${row.electionId}`,
          `Ohio finance link committee id is not a numeric SOS master key: ${row.committeeId}`
        );
      }
    }

    try {
      directByYear.set(
        year,
        await aggregateDirectForYear({
          electionYear: year,
          committeeIds: [...committeeIds],
          cacheDir,
          coverRows,
          sourceUrl: OHIO_SOS_FILE_TRANSFER_PAGE_URL,
          now,
        })
      );
    } catch (error) {
      directLoadErrorsByYear.set(year, errorMessage(error));
      console.warn(
        `Ohio SoS direct-finance artifacts unavailable for ${year}; failing the year's due candidates:`,
        errorMessage(error)
      );
      continue;
    }

    outsideByYear.set(
      year,
      await aggregateOutsideForYear({
        db: input.db,
        electionYear: year,
        dueRows: yearRows,
        cacheDir,
        coverRows,
        sourceUrl: OHIO_SOS_FILE_TRANSFER_PAGE_URL,
        toleranceCents: input.outsideToleranceCents,
        now,
      })
    );
  }

  const results: OhioCandidateFinanceBatchSyncItemResult[] = [];
  for (const row of due.rows) {
    const base = {
      candidateId: row.candidateId,
      electionId: row.electionId,
      electionYear: row.electionYear,
      committeeId: row.committeeId,
    };

    const invalidCommitteeIdError = invalidCommitteeIdErrors.get(`${row.candidateId}\u0000${row.electionId}`);
    if (invalidCommitteeIdError) {
      results.push({ ...base, ok: false, error: invalidCommitteeIdError });
      continue;
    }
    const directLoadError = directLoadErrorsByYear.get(row.electionYear);
    if (directLoadError) {
      results.push({ ...base, ok: false, error: directLoadError });
      continue;
    }
    const directFinance = directByYear.get(row.electionYear)?.get(row.committeeId.trim());
    if (!directFinance) {
      results.push({ ...base, ok: false, error: "Ohio direct finance aggregation missing for committee" });
      continue;
    }
    const outside = outsideByYear.get(row.electionYear);
    const outsideFinance =
      outside?.byTargetKey?.get(outsideTargetKey(row)) ??
      (outside?.byTargetKey ? { supportTotal: 0, opposeTotal: 0, groups: [] } : null);

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
        directFinance,
        outsideFinance,
        sourceUrl: OHIO_SOS_FILE_TRANSFER_PAGE_URL,
        now,
        dryRun,
      });
      results.push({ ...base, ok: true, result });
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
