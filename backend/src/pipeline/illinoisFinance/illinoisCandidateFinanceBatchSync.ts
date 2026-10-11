import type { Pool, PoolClient } from "pg";

import { createStandardStateFinanceDueListQuery } from "../finance/standardStateFinanceDueListQuery.js";
import type { FinanceIndustryClassifier } from "../finance/financeIndustryClassificationService.js";
import {
  aggregateIllinoisOutsideSpending,
  extractIllinoisSbeCommitteeId,
} from "./illinoisFinanceAggregators.js";
import {
  autoLinkMissingIllinoisCandidateFinanceLinks,
  listIllinoisCandidateElectionsMissingFinanceLinks,
  type IllinoisCandidateCommitteeResolver,
} from "./illinoisCandidateFinanceAutoLink.js";
import {
  syncIllinoisCandidateFinance,
  type IllinoisCandidateFinanceSyncResult,
} from "./syncIllinoisCandidateFinance.js";
import {
  ILLINOIS_FINANCE_ELIGIBLE_OFFICE_KEYS,
  toIllinoisSbeOfficeSearchInput,
} from "./illinoisFinanceEligibleOffices.js";
import {
  fetchIllinoisSbeCommitteeContributionRecords,
  fetchIllinoisSbeIndependentExpenditureRecords,
  getIllinoisSbeExportCapStatus,
  ILLINOIS_SBE_CONTRIBUTION_COMMITTEE_SEARCH_URL,
  ILLINOIS_SBE_EXPENDITURE_ALL_SEARCH_URL,
  type IllinoisSbeClientOptions,
  type IllinoisSbeContributionRecord,
  type IllinoisSbeExpenditureRecord,
} from "./illinoisSbeClient.js";
import type { IllinoisSbeD2ReportSummary } from "./illinoisSbeNormalizedArtifact.js";
import type { IllinoisFinancePacDonorInput, IllinoisFinanceOutsideReportEvidence } from "./illinoisFinanceWriter.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & Pick<Pool, "connect">;

export type IllinoisCandidateFinanceDueRow = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district: string | null;
  sbeCandidateId: string | null;
  sbeDistrictType: string | null;
  sbeOffice: string | null;
  isAtLarge: boolean | null;
  committeeKey: string;
  committeeName: string;
  sourceUrl: string | null;
  lastSyncedAt: string | null;
};

export type IllinoisCandidateFinanceData = {
  verifiedQuarterly?: boolean;
  sourceDiagnostics?: readonly string[];
  pacDonors?: readonly IllinoisFinancePacDonorInput[];
  outsideReportEvidence?: readonly IllinoisFinanceOutsideReportEvidence[];
  // Undefined when no itemized contribution source was loaded, which keeps
  // stored breakdowns instead of replacing them with nothing.
  directContributionRecords?: readonly IllinoisSbeContributionRecord[];
  outsideExpenditureRecords?: readonly IllinoisSbeExpenditureRecord[];
  outsideGroupContributionRecords?: readonly IllinoisSbeContributionRecord[];
  d2ReportSummaries?: readonly IllinoisSbeD2ReportSummary[];
  directContributionSourceUrl?: string | null;
  outsideExpenditureSourceUrl?: string | null;
  outsideGroupContributionSourceUrl?: string | null;
};

export type IllinoisCandidateFinanceBatchSyncInput = {
  db: ConnectableQueryable;
  now?: Date;
  dryRun?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  sbeClientOptions?: IllinoisSbeClientOptions;
  autoLinkMissingLinks?: boolean;
  financeIndustryClassifier?: FinanceIndustryClassifier;
  aiClassificationMinAmount?: number;
  syncIllinoisCandidateFinanceFn?: typeof syncIllinoisCandidateFinance;
  loadIllinoisFinanceDataFn?: (
    row: IllinoisCandidateFinanceDueRow,
    options?: IllinoisSbeClientOptions
  ) => Promise<IllinoisCandidateFinanceData>;
  resolveCandidateCommittee?: IllinoisCandidateCommitteeResolver;
};

export type IllinoisCandidateFinanceBatchSyncItemResult = {
  sourceDiagnostics?: readonly string[];
  candidateId: string;
  electionId: string;
  electionYear: number;
  committeeKey: string;
  ok: boolean;
  result?: IllinoisCandidateFinanceSyncResult;
  error?: string;
};

export type IllinoisCandidateFinanceBatchSyncResult = {
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
  results: IllinoisCandidateFinanceBatchSyncItemResult[];
};

const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_STALE_AFTER_DAYS = 7;
const DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS = 1;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;
const DEFAULT_OUTSIDE_GROUP_FETCH_LIMIT = 50;

function assertValidDate(date: Date, label: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid Illinois finance batch sync ${label}`);
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid Illinois finance batch sync ${label}: ${value}`);
  }
  return normalized;
}

function cycleStartDate(electionYear: number): string {
  return `1/1/${electionYear - 1}`;
}

function cycleEndDate(electionYear: number): string {
  return `12/31/${electionYear}`;
}

function uniqueOutsideGroupNames(records: readonly IllinoisSbeExpenditureRecord[], electionYear: number): string[] {
  const outsideGroups = aggregateIllinoisOutsideSpending({
    electionYear,
    expenditureRecords: records,
    sourceUrl: ILLINOIS_SBE_EXPENDITURE_ALL_SEARCH_URL,
    maxGroups: DEFAULT_OUTSIDE_GROUP_FETCH_LIMIT,
  }).summary?.groups;

  const names = new Map<string, string>();
  for (const group of outsideGroups ?? []) {
    const name = group.committeeName.trim().replace(/\s+/g, " ");
    const key = group.committeeKey.trim().replace(/\s+/g, " ").toUpperCase();
    if (name && key && !names.has(key)) {
      names.set(key, name);
    }
  }
  return [...names.values()];
}

function officeSearchText(input: { sbeOffice: string; district: string | null } | null, fallback: string): string {
  if (!input) {
    return fallback;
  }
  return input.district ? `${input.sbeOffice} ${input.district}` : input.sbeOffice;
}

function warnIfIllinoisSbeExportLooksCapped(input: {
  context: string;
  row: IllinoisCandidateFinanceDueRow;
  records: readonly unknown[];
}): void {
  const status = getIllinoisSbeExportCapStatus({ csvRowCount: input.records.length });
  if (!status.capped) {
    return;
  }
  console.warn(
    `Illinois SBE export may be capped for ${input.context} ` +
      `(candidateId=${input.row.candidateId} electionId=${input.row.electionId} ` +
      `committeeKey=${input.row.committeeKey} rows=${status.rowCount} cap=${status.cap} reason=${status.reason})`
  );
}

export async function loadIllinoisFinanceDataForDueRow(
  row: IllinoisCandidateFinanceDueRow,
  options?: IllinoisSbeClientOptions
): Promise<IllinoisCandidateFinanceData> {
  const fromDate = cycleStartDate(row.electionYear);
  const toDate = cycleEndDate(row.electionYear);
  const officeSearch = toIllinoisSbeOfficeSearchInput({
    officeScope: row.officeScope,
    officeCanonicalName: row.officeName,
    district: row.district,
    districtType: row.sbeDistrictType,
    sbeOffice: row.sbeOffice,
    isAtLarge: row.isAtLarge,
  });
  if (!officeSearch) {
    throw new Error(
      `Illinois finance due row cannot be mapped to an SBE office search ` +
        `(candidateId=${row.candidateId} electionId=${row.electionId})`
    );
  }
  const office = officeSearchText(officeSearch, row.officeName);
  const sbeCommitteeId = extractIllinoisSbeCommitteeId(row.committeeKey);
  const directContributionRecords = await fetchIllinoisSbeCommitteeContributionRecords(
    {
      committeeName: sbeCommitteeId ? undefined : row.committeeName,
      committeeId: sbeCommitteeId,
      contributionType: "All Types",
    },
    options
  );
  warnIfIllinoisSbeExportLooksCapped({
    context: "direct committee contributions",
    row,
    records: directContributionRecords,
  });
  const [supportExpenditureRecords, opposeExpenditureRecords] = await Promise.all([
    fetchIllinoisSbeIndependentExpenditureRecords(
      {
        candidateName: row.candidateName,
        office,
        supportOppose: "support",
        fromDate,
        toDate,
      },
      options
    ),
    fetchIllinoisSbeIndependentExpenditureRecords(
      {
        candidateName: row.candidateName,
        office,
        supportOppose: "oppose",
        fromDate,
        toDate,
      },
      options
    ),
  ]);
  warnIfIllinoisSbeExportLooksCapped({
    context: "independent expenditures (support)",
    row,
    records: supportExpenditureRecords,
  });
  warnIfIllinoisSbeExportLooksCapped({
    context: "independent expenditures (oppose)",
    row,
    records: opposeExpenditureRecords,
  });
  const outsideExpenditureRecords = [...supportExpenditureRecords, ...opposeExpenditureRecords];
  const outsideGroupContributionRecords: IllinoisSbeContributionRecord[] = [];

  for (const committeeName of uniqueOutsideGroupNames(outsideExpenditureRecords, row.electionYear)) {
    const records = await fetchIllinoisSbeCommitteeContributionRecords(
      {
        committeeName,
        contributionType: "All Types",
      },
      options
    );
    warnIfIllinoisSbeExportLooksCapped({
      context: `outside group contributions for ${committeeName}`,
      row,
      records,
    });
    for (const record of records) {
      outsideGroupContributionRecords.push(record);
    }
  }

  return {
    directContributionRecords,
    outsideExpenditureRecords,
    outsideGroupContributionRecords,
    directContributionSourceUrl: ILLINOIS_SBE_CONTRIBUTION_COMMITTEE_SEARCH_URL,
    outsideExpenditureSourceUrl: ILLINOIS_SBE_EXPENDITURE_ALL_SEARCH_URL,
    outsideGroupContributionSourceUrl: ILLINOIS_SBE_CONTRIBUTION_COMMITTEE_SEARCH_URL,
  };
}

// Illinois links carry the SBE candidate identity columns alongside the
// committee_key identity used by the sync loop.
export const listDueIllinoisCandidateFinanceSyncRows = createStandardStateFinanceDueListQuery({
  state: "IL",
  tables: {
    links: "il_candidate_finance_links",
    summaries: "il_candidate_finance_summaries",
  },
  eligibleOfficeKeys: ILLINOIS_FINANCE_ELIGIBLE_OFFICE_KEYS,
  linkColumns: ["sbe_candidate_id", "sbe_district_type", "sbe_office", "is_at_large", "committee_key", "committee_name"],
  mapRow: (row): IllinoisCandidateFinanceDueRow => ({
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    district: row.district,
    sbeCandidateId: row.sbe_candidate_id as string | null,
    sbeDistrictType: row.sbe_district_type as string | null,
    sbeOffice: row.sbe_office as string | null,
    isAtLarge: row.is_at_large as boolean | null,
    committeeKey: row.committee_key as string,
    committeeName: row.committee_name as string,
    sourceUrl: row.source_url,
    lastSyncedAt: row.last_synced_at,
  }),
});

export async function syncDueIllinoisCandidateFinance(
  input: IllinoisCandidateFinanceBatchSyncInput
): Promise<IllinoisCandidateFinanceBatchSyncResult> {
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
  const syncFn = input.syncIllinoisCandidateFinanceFn ?? syncIllinoisCandidateFinance;
  const loadDataFn = input.loadIllinoisFinanceDataFn ?? loadIllinoisFinanceDataForDueRow;
  let autoLinkAttemptedCount = 0;
  let autoLinkLinkedCount = 0;

  if (!dryRun && input.autoLinkMissingLinks !== false) {
    try {
      const missingLinkCandidates = await listIllinoisCandidateElectionsMissingFinanceLinks(input.db, {
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
      });
      autoLinkAttemptedCount = missingLinkCandidates.length;
      const autoLinkResults = await autoLinkMissingIllinoisCandidateFinanceLinks({
        db: input.db,
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
        candidateElections: missingLinkCandidates,
        resolveCandidateCommittee: input.resolveCandidateCommittee,
        sbeClientOptions: input.sbeClientOptions,
      });
      autoLinkLinkedCount = autoLinkResults.filter((result) => result.status === "linked").length;
      for (const result of autoLinkResults) {
        if (result.status !== "linked") {
          console.warn("Illinois finance auto-link did not link candidate election:", result);
        }
      }
    } catch (error) {
      console.warn(
        "Illinois finance auto-link skipped; continuing with already-linked candidate sync:",
        error instanceof Error ? error.message : error
      );
    }
  }

  const due = await listDueIllinoisCandidateFinanceSyncRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
  });

  const results: IllinoisCandidateFinanceBatchSyncItemResult[] = [];
  const outsideOwners = new Set<string>();
  for (const row of due.rows) {
    try {
      const data = await loadDataFn(row, input.sbeClientOptions);
      if (data.verifiedQuarterly && data.d2ReportSummaries === undefined &&
          data.pacDonors === undefined && data.outsideExpenditureRecords === undefined) {
        throw new Error(["No accepted current Quarterly component; stored finance preserved",
          ...(data.sourceDiagnostics ?? [])].join("; "));
      }
      const outsideOwnerKey = `${row.candidateId}:${row.electionId}:${row.electionYear}`;
      const ownsOutside = !data.outsideReportEvidence || !outsideOwners.has(outsideOwnerKey);
      const result = await syncFn({
        db: input.db,
        candidateId: row.candidateId,
        electionId: row.electionId,
        candidateName: row.candidateName,
        electionYear: row.electionYear,
        officeScope: row.officeScope,
        officeName: row.officeName,
        district: row.district,
        sbeCandidateId: row.sbeCandidateId,
        sbeDistrictType: row.sbeDistrictType,
        sbeOffice: row.sbeOffice,
        isAtLarge: row.isAtLarge,
        sbeCommitteeId: extractIllinoisSbeCommitteeId(row.committeeKey),
        committeeKey: row.committeeKey,
        committeeName: row.committeeName,
        directContributionRecords: data.directContributionRecords,
        verifiedQuarterly: data.verifiedQuarterly,
        pacDonors: data.pacDonors,
        outsideReportEvidence: ownsOutside ? data.outsideReportEvidence : undefined,
        outsideExpenditureRecords: ownsOutside ? data.outsideExpenditureRecords : undefined,
        outsideGroupContributionRecords: data.outsideGroupContributionRecords,
        d2ReportSummaries: data.d2ReportSummaries,
        sourceUrl: row.sourceUrl ?? data.directContributionSourceUrl,
        directContributionSourceUrl: data.directContributionSourceUrl,
        outsideExpenditureSourceUrl: data.outsideExpenditureSourceUrl,
        outsideGroupContributionSourceUrl: data.outsideGroupContributionSourceUrl,
        financeIndustryClassifier: input.financeIndustryClassifier,
        aiClassificationMinAmount: input.aiClassificationMinAmount,
        dryRun,
        now,
      });
      if (data.outsideReportEvidence && ownsOutside && !result.outsidePreserved) outsideOwners.add(outsideOwnerKey);
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        committeeKey: row.committeeKey,
        ok: true,
        sourceDiagnostics: data.sourceDiagnostics,
        result,
      });
    } catch (error) {
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        committeeKey: row.committeeKey,
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
