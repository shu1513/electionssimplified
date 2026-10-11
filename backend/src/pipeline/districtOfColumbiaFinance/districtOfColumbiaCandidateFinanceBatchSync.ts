import type { Pool, PoolClient } from "pg";

import type { FinanceIndustryClassifier } from "../finance/financeIndustryClassificationService.js";
import { createStandardStateFinanceDueListQuery } from "../finance/standardStateFinanceDueListQuery.js";
import {
  autoLinkMissingDistrictOfColumbiaCandidateFinanceLinks,
  listDistrictOfColumbiaCandidateElectionsMissingFinanceLinks,
  type DistrictOfColumbiaCandidateCommitteeResolver,
  type DistrictOfColumbiaFinanceAutoLinkCandidateElection,
} from "./districtOfColumbiaCandidateFinanceAutoLink.js";
import {
  syncDistrictOfColumbiaCandidateFinance,
  type DistrictOfColumbiaCandidateFinanceSyncResult,
} from "./districtOfColumbiaCandidateFinanceSync.js";
import {
  resolveDistrictOfColumbiaCandidateCommittee,
  type DistrictOfColumbiaCandidateCommitteeResolution,
} from "./districtOfColumbiaCandidateCommitteeResolver.js";
import { DISTRICT_OF_COLUMBIA_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./districtOfColumbiaFinanceEligibleOffices.js";
import {
  DISTRICT_OF_COLUMBIA_FAIR_ELECTIONS_SOURCE_URL,
  downloadDistrictOfColumbiaFairElectionsData,
  isDistrictOfColumbiaFairElectionsCommitteeKey,
} from "./districtOfColumbiaFairElectionsClient.js";
import {
  buildDistrictOfColumbiaOcfDataDownloadUrl,
  downloadIndependentExpenditureContributions,
  downloadIndependentExpenditureExpenditures,
  downloadPrincipalCampaignContributions,
  type DistrictOfColumbiaOcfClientOptions,
  type DistrictOfColumbiaOcfContributionRecord,
  type DistrictOfColumbiaOcfExpenditureRecord,
} from "./districtOfColumbiaOcfClient.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & Pick<Pool, "connect">;

export type DistrictOfColumbiaCandidateFinanceDueRow = {
  candidateId: string;
  electionId: string;
  candidateName: string;
  electionYear: number;
  officeScope: string;
  officeName: string;
  district: string | null;
  committeeKey: string;
  committeeName: string;
  sourceUrl: string | null;
  lastSyncedAt: string | null;
};

export type DistrictOfColumbiaOcfDataForYear = {
  year: number;
  sourceUrl: string;
  principalContributionRecords: readonly DistrictOfColumbiaOcfContributionRecord[];
  independentExpenditureRecords: readonly DistrictOfColumbiaOcfExpenditureRecord[];
  independentExpenditureContributionRecords: readonly DistrictOfColumbiaOcfContributionRecord[];
  // Fair Elections (public financing) committees report outside the OCF
  // export. Optional so preloaded data without them still works.
  fairElectionsContributionRecords?: readonly DistrictOfColumbiaOcfContributionRecord[];
  fairElectionsExpenditureRecords?: readonly DistrictOfColumbiaOcfExpenditureRecord[];
  // Set when the Fair Elections download failed: only Fair Elections links
  // fail, so OCF export candidates still sync.
  fairElectionsLoadError?: string;
};

type DistrictOfColumbiaContributionDataForYear = Pick<
  DistrictOfColumbiaOcfDataForYear,
  | "year"
  | "sourceUrl"
  | "principalContributionRecords"
  | "fairElectionsContributionRecords"
  | "fairElectionsExpenditureRecords"
  | "fairElectionsLoadError"
>;

export type DistrictOfColumbiaCandidateFinanceBatchSyncInput = {
  db: ConnectableQueryable;
  now?: Date;
  dryRun?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  ocfClientOptions?: DistrictOfColumbiaOcfClientOptions;
  ocfDataByYear?: ReadonlyMap<number, DistrictOfColumbiaOcfDataForYear>;
  autoLinkMissingLinks?: boolean;
  financeIndustryClassifier?: FinanceIndustryClassifier;
  aiClassificationMinAmount?: number;
  syncDistrictOfColumbiaCandidateFinanceFn?: typeof syncDistrictOfColumbiaCandidateFinance;
  resolveCandidateCommittee?: DistrictOfColumbiaCandidateCommitteeResolver;
};

export type DistrictOfColumbiaCandidateFinanceBatchSyncItemResult = {
  candidateId: string;
  electionId: string;
  electionYear: number;
  committeeKey: string;
  ok: boolean;
  result?: DistrictOfColumbiaCandidateFinanceSyncResult;
  error?: string;
};

export type DistrictOfColumbiaCandidateFinanceBatchSyncResult = {
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
  results: DistrictOfColumbiaCandidateFinanceBatchSyncItemResult[];
};

const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_STALE_AFTER_DAYS = 7;
// Keep one extra calendar day so UTC scheduler timing cannot skip election-night finance syncs.
const DEFAULT_POST_ELECTION_FINANCE_SYNC_GRACE_DAYS = 1;
const DEFAULT_ELECTION_LOOKAHEAD_DAYS = 730;

function assertValidDate(date: Date, label: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid D.C. finance batch sync ${label}`);
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid D.C. finance batch sync ${label}: ${value}`);
  }
  return normalized;
}

function normalizeCommitteeKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

function cycleStartDate(electionYear: number): string {
  return `01/01/${electionYear - 1}`;
}

function cycleEndDate(electionYear: number): string {
  return `12/31/${electionYear}`;
}

function groupDueRowsByYear(
  rows: readonly DistrictOfColumbiaCandidateFinanceDueRow[]
): Map<number, DistrictOfColumbiaCandidateFinanceDueRow[]> {
  const byYear = new Map<number, DistrictOfColumbiaCandidateFinanceDueRow[]>();
  for (const row of rows) {
    const yearRows = byYear.get(row.electionYear) ?? [];
    yearRows.push(row);
    byYear.set(row.electionYear, yearRows);
  }
  return byYear;
}

function groupAutoLinkCandidatesByYear(
  rows: readonly DistrictOfColumbiaFinanceAutoLinkCandidateElection[]
): Map<number, DistrictOfColumbiaFinanceAutoLinkCandidateElection[]> {
  const byYear = new Map<number, DistrictOfColumbiaFinanceAutoLinkCandidateElection[]>();
  for (const row of rows) {
    const yearRows = byYear.get(row.electionYear) ?? [];
    yearRows.push(row);
    byYear.set(row.electionYear, yearRows);
  }
  return byYear;
}

async function loadFairElectionsDataForYear(input: {
  year: number;
  now: Date;
  ocfClientOptions?: DistrictOfColumbiaOcfClientOptions;
}): Promise<
  Pick<
    DistrictOfColumbiaOcfDataForYear,
    "fairElectionsContributionRecords" | "fairElectionsExpenditureRecords" | "fairElectionsLoadError"
  >
> {
  try {
    const data = await downloadDistrictOfColumbiaFairElectionsData(
      { electionYear: input.year, now: input.now },
      input.ocfClientOptions
    );
    return {
      fairElectionsContributionRecords: data.contributionRecords,
      fairElectionsExpenditureRecords: data.expenditureRecords,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("D.C. Fair Elections download failed; Fair Elections committees will not sync:", message);
    return { fairElectionsContributionRecords: [], fairElectionsExpenditureRecords: [], fairElectionsLoadError: message };
  }
}

async function loadPrincipalContributionDataForYear(input: {
  year: number;
  now: Date;
  ocfClientOptions?: DistrictOfColumbiaOcfClientOptions;
}): Promise<DistrictOfColumbiaContributionDataForYear> {
  const [principalContributionRecords, fairElectionsData] = await Promise.all([
    downloadPrincipalCampaignContributions(
      { fromDate: cycleStartDate(input.year), toDate: cycleEndDate(input.year) },
      input.ocfClientOptions
    ),
    loadFairElectionsDataForYear(input),
  ]);
  return {
    year: input.year,
    sourceUrl: buildDistrictOfColumbiaOcfDataDownloadUrl(),
    principalContributionRecords,
    ...fairElectionsData,
  };
}

function allContributionRecords(data: DistrictOfColumbiaContributionDataForYear | undefined): DistrictOfColumbiaOcfContributionRecord[] {
  return [...(data?.principalContributionRecords ?? []), ...(data?.fairElectionsContributionRecords ?? [])];
}

async function loadOcfDataForYear(input: {
  year: number;
  now: Date;
  // Contribution data the auto-link pass already downloaded this run.
  principalData?: DistrictOfColumbiaContributionDataForYear;
  ocfClientOptions?: DistrictOfColumbiaOcfClientOptions;
}): Promise<DistrictOfColumbiaOcfDataForYear> {
  const [principalContributionData, independentExpenditureRecords, independentExpenditureContributionRecords] =
    await Promise.all([
      input.principalData ?? loadPrincipalContributionDataForYear(input),
      downloadIndependentExpenditureExpenditures(
        { fromDate: cycleStartDate(input.year), toDate: cycleEndDate(input.year) },
        input.ocfClientOptions
      ),
      downloadIndependentExpenditureContributions(
        { fromDate: cycleStartDate(input.year), toDate: cycleEndDate(input.year) },
        input.ocfClientOptions
      ),
    ]);

  return {
    ...principalContributionData,
    independentExpenditureRecords,
    independentExpenditureContributionRecords,
  };
}

async function getOrLoadOcfDataForYear(input: {
  year: number;
  now: Date;
  dataByYear: Map<number, DistrictOfColumbiaOcfDataForYear>;
  principalDataByYear: Map<number, DistrictOfColumbiaContributionDataForYear>;
  ocfClientOptions?: DistrictOfColumbiaOcfClientOptions;
}): Promise<DistrictOfColumbiaOcfDataForYear> {
  const existing = input.dataByYear.get(input.year);
  if (existing) {
    return existing;
  }
  const loaded = await loadOcfDataForYear({
    year: input.year,
    now: input.now,
    principalData: input.principalDataByYear.get(input.year),
    ocfClientOptions: input.ocfClientOptions,
  });
  input.dataByYear.set(input.year, loaded);
  return loaded;
}

async function getOrLoadPrincipalContributionDataForYear(input: {
  year: number;
  now: Date;
  dataByYear: Map<number, DistrictOfColumbiaOcfDataForYear>;
  principalDataByYear: Map<number, DistrictOfColumbiaContributionDataForYear>;
  ocfClientOptions?: DistrictOfColumbiaOcfClientOptions;
}): Promise<DistrictOfColumbiaContributionDataForYear> {
  const fullData = input.dataByYear.get(input.year);
  if (fullData) {
    return fullData;
  }
  const principalData = input.principalDataByYear.get(input.year);
  if (principalData) {
    return principalData;
  }
  const loaded = await loadPrincipalContributionDataForYear({
    year: input.year,
    now: input.now,
    ocfClientOptions: input.ocfClientOptions,
  });
  input.principalDataByYear.set(input.year, loaded);
  return loaded;
}

// D.C. links carry committee_key instead of the canonical committee_id, so the
// builder selects the renamed column and the mapper reads it off the raw row.
export const listDueDistrictOfColumbiaCandidateFinanceSyncRows = createStandardStateFinanceDueListQuery({
  state: "DC",
  tables: {
    links: "dc_candidate_finance_links",
    summaries: "dc_candidate_finance_summaries",
  },
  eligibleOfficeKeys: DISTRICT_OF_COLUMBIA_FINANCE_ELIGIBLE_OFFICE_KEYS,
  linkColumns: ["committee_key", "committee_name"],
  mapRow: (row): DistrictOfColumbiaCandidateFinanceDueRow => ({
    candidateId: row.candidate_id,
    electionId: row.election_id,
    candidateName: row.candidate_name,
    electionYear: row.election_year,
    officeScope: row.office_scope,
    officeName: row.office_name,
    district: row.district,
    committeeKey: row.committee_key as string,
    committeeName: row.committee_name as string,
    sourceUrl: row.source_url,
    lastSyncedAt: row.last_synced_at,
  }),
});

export async function syncDueDistrictOfColumbiaCandidateFinance(
  input: DistrictOfColumbiaCandidateFinanceBatchSyncInput
): Promise<DistrictOfColumbiaCandidateFinanceBatchSyncResult> {
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
  const syncFn = input.syncDistrictOfColumbiaCandidateFinanceFn ?? syncDistrictOfColumbiaCandidateFinance;
  const ocfDataByYear = new Map<number, DistrictOfColumbiaOcfDataForYear>(
    input.ocfDataByYear ? [...input.ocfDataByYear.entries()] : []
  );
  const principalDataByYear = new Map<number, DistrictOfColumbiaContributionDataForYear>();
  let autoLinkAttemptedCount = 0;
  let autoLinkLinkedCount = 0;

  if (!dryRun && input.autoLinkMissingLinks !== false) {
    try {
      const missingLinkCandidates = await listDistrictOfColumbiaCandidateElectionsMissingFinanceLinks(input.db, {
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
      });
      autoLinkAttemptedCount = missingLinkCandidates.length;

      let resolveCandidateCommittee = input.resolveCandidateCommittee;
      if (!resolveCandidateCommittee) {
        const contributionRowsByYear = new Map<number, readonly DistrictOfColumbiaOcfContributionRecord[]>();
        const sourceUrlByYear = new Map<number, string>();
        for (const [year] of groupAutoLinkCandidatesByYear(missingLinkCandidates).entries()) {
          const data = await getOrLoadPrincipalContributionDataForYear({
            year,
            now,
            dataByYear: ocfDataByYear,
            principalDataByYear,
            ocfClientOptions: input.ocfClientOptions,
          });
          contributionRowsByYear.set(year, allContributionRecords(data));
          sourceUrlByYear.set(year, data.sourceUrl);
        }
        resolveCandidateCommittee = async (candidateInput): Promise<DistrictOfColumbiaCandidateCommitteeResolution> => {
          const resolution = resolveDistrictOfColumbiaCandidateCommittee({
            ...candidateInput,
            contributionRecords: contributionRowsByYear.get(candidateInput.electionYear) ?? [],
            sourceUrl: sourceUrlByYear.get(candidateInput.electionYear) ?? buildDistrictOfColumbiaOcfDataDownloadUrl(),
          });
          return resolution.status === "matched" && isDistrictOfColumbiaFairElectionsCommitteeKey(resolution.committeeKey)
            ? { ...resolution, sourceUrl: DISTRICT_OF_COLUMBIA_FAIR_ELECTIONS_SOURCE_URL }
            : resolution;
        };
      }

      const autoLinkResults = await autoLinkMissingDistrictOfColumbiaCandidateFinanceLinks({
        db: input.db,
        now,
        maxCandidates,
        electionLookbackDays,
        electionLookaheadDays,
        candidateElections: missingLinkCandidates,
        resolveCandidateCommittee,
        ocfClientOptions: input.ocfClientOptions,
      });
      autoLinkLinkedCount = autoLinkResults.filter((result) => result.status === "linked").length;
      for (const result of autoLinkResults) {
        if (result.status === "error") {
          console.warn("D.C. finance auto-link did not link candidate election:", result);
        }
      }
    } catch (error) {
      console.warn(
        "D.C. finance auto-link skipped; continuing with already-linked candidate sync:",
        error instanceof Error ? error.message : error
      );
    }
  }

  const due = await listDueDistrictOfColumbiaCandidateFinanceSyncRows(input.db, {
    now,
    staleAfterDays,
    maxCandidates,
    electionLookbackDays,
    electionLookaheadDays,
  });

  const dataLoadErrorsByYear = new Map<number, string>();
  for (const [year] of groupDueRowsByYear(due.rows).entries()) {
    if (!ocfDataByYear.has(year)) {
      try {
        await getOrLoadOcfDataForYear({
          year,
          now,
          dataByYear: ocfDataByYear,
          principalDataByYear,
          ocfClientOptions: input.ocfClientOptions,
        });
      } catch (error) {
        dataLoadErrorsByYear.set(year, error instanceof Error ? error.message : String(error));
      }
    }
  }

  const results: DistrictOfColumbiaCandidateFinanceBatchSyncItemResult[] = [];
  for (const row of due.rows) {
    const dataLoadError = dataLoadErrorsByYear.get(row.electionYear);
    if (dataLoadError) {
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        committeeKey: row.committeeKey,
        ok: false,
        error: dataLoadError,
      });
      continue;
    }

    const ocfData = ocfDataByYear.get(row.electionYear);
    if (ocfData?.fairElectionsLoadError && isDistrictOfColumbiaFairElectionsCommitteeKey(row.committeeKey)) {
      results.push({
        candidateId: row.candidateId,
        electionId: row.electionId,
        electionYear: row.electionYear,
        committeeKey: row.committeeKey,
        ok: false,
        error: ocfData.fairElectionsLoadError,
      });
      continue;
    }
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
        sourceUrl: row.sourceUrl ?? ocfData?.sourceUrl,
        contributionRecords: allContributionRecords(ocfData),
        committeeExpenditureRecords: ocfData?.fairElectionsExpenditureRecords ?? [],
        expenditureRecords: ocfData?.independentExpenditureRecords ?? [],
        outsideContributionRecords: ocfData?.independentExpenditureContributionRecords ?? [],
        trustedCommittee: {
          committeeKey: normalizeCommitteeKey(row.committeeKey),
          committeeName: row.committeeName,
          sourceUrl: row.sourceUrl ?? ocfData?.sourceUrl,
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
        committeeKey: row.committeeKey,
        ok: true,
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
