import { readFile } from "node:fs/promises";

import {
  illinoisCandidateNameMiddleConflicts,
  normalizeIllinoisCandidateNameKeys,
  resolveIllinoisCandidateCommittee,
  resolveIllinoisCandidateCommitteesFromRelations,
} from "./illinoisCandidateCommitteeResolver.js";
import type { IllinoisCandidateCommitteeResolver } from "./illinoisCandidateFinanceAutoLink.js";
import type {
  IllinoisCandidateFinanceData,
  IllinoisCandidateFinanceDueRow,
} from "./illinoisCandidateFinanceBatchSync.js";
import {
  extractIllinoisSbeCommitteeId,
  isIllinoisFinanceCycleDate,
  normalizeIllinoisCommitteeKey,
  normalizeIllinoisFinanceTextKey,
} from "./illinoisFinanceAggregators.js";
import {
  illinoisMunicipalityMatches,
  toIllinoisSbeOfficeSearchInput,
} from "./illinoisFinanceEligibleOffices.js";
import {
  ILLINOIS_SBE_CONTRIBUTION_COMMITTEE_SEARCH_URL,
  ILLINOIS_SBE_EXPENDITURE_ALL_SEARCH_URL,
} from "./illinoisSbeClient.js";
import {
  parseIllinoisSbeContributionRecordsCsv,
  parseIllinoisSbeExpenditureRecordsCsv,
  type IllinoisSbeContributionRecord,
  type IllinoisSbeExpenditureRecord,
} from "./illinoisSbeCsvReader.js";
import {
  loadIllinoisSbeNormalizedArtifact,
  type IllinoisSbeNormalizedArtifact,
} from "./illinoisSbeNormalizedArtifact.js";
import { ILLINOIS_SBE_BULK_DOWNLOAD_URL } from "./illinoisSbeBulkDataProducer.js";
import {
  loadIllinoisSbeReceiptsByCommitteeId,
  toIllinoisSbeContributionRecordFromReceipt,
  type IllinoisSbeReceiptRecord,
} from "./illinoisSbeReceiptsReader.js";

export type IllinoisSbeArtifactDataSet = {
  contributionRecords: IllinoisSbeContributionRecord[];
  // Whether contribution CSVs were configured at all. A configured CSV that
  // parsed to zero records is a loaded-but-empty source (replace breakdowns);
  // no CSVs configured is no source (preserve them). Record count alone
  // cannot tell those apart.
  contributionCsvsLoaded: boolean;
  expenditureRecords?: IllinoisSbeExpenditureRecord[];
  contributionSourceUrl: string;
  expenditureSourceUrl?: string | null;
  normalizedArtifact?: IllinoisSbeNormalizedArtifact;
  receiptsByCommitteeId?: Map<string, IllinoisSbeReceiptRecord[]>;
  // The committee ids the receipts load actually scanned for. Absence from
  // this set means the committee's receipts were never read (preserve stored
  // breakdowns); presence with no map entry means a real zero (clear them).
  receiptsCommitteeIds?: ReadonlySet<string>;
  receiptsSourceUrl?: string;
};

export type IllinoisSbeArtifactDataSourceConfig = {
  contributionCsvPaths: readonly string[];
  expenditureCsvPaths?: readonly string[];
  contributionSourceUrl?: string | null;
  expenditureSourceUrl?: string | null;
  normalizedArtifactPath?: string | null;
  receiptsTsvPath?: string | null;
  receiptsSourceUrl?: string | null;
  minReceiptYear?: number;
};

/**
 * The oldest receipt year a run can need: the earliest selectable election
 * (now minus the lookback window) starts its cycle the year before its
 * election year. Never later than two years back, so the short default
 * lookback keeps the generous floor it has always had.
 */
export function illinoisMinReceiptYearForLookback(input: {
  now: Date;
  electionLookbackDays: number;
}): number {
  const earliestElectionYear = new Date(
    input.now.getTime() - input.electionLookbackDays * 24 * 60 * 60 * 1000
  ).getUTCFullYear();
  return Math.min(input.now.getUTCFullYear() - 2, earliestElectionYear - 1);
}

function normalizePathList(paths: readonly string[] | undefined, label: string, required: boolean): string[] {
  const normalized = (paths ?? []).map((path) => path.trim()).filter(Boolean);
  if (required && normalized.length === 0) {
    throw new Error(`Illinois SBE ${label} artifact requires at least one CSV path`);
  }
  return normalized;
}

async function loadContributionRecords(input: {
  paths: readonly string[];
  sourceUrl: string;
}): Promise<IllinoisSbeContributionRecord[]> {
  const records: IllinoisSbeContributionRecord[] = [];
  for (const path of input.paths) {
    // The current Illinois parser materializes each CSV, so keep reads sequential to cap peak memory.
    const csv = await readFile(path, "utf8");
    for (const record of parseIllinoisSbeContributionRecordsCsv(csv, input.sourceUrl)) {
      records.push(record);
    }
  }
  return records;
}

async function loadExpenditureRecords(input: {
  paths: readonly string[];
  sourceUrl: string;
}): Promise<IllinoisSbeExpenditureRecord[]> {
  const records: IllinoisSbeExpenditureRecord[] = [];
  for (const path of input.paths) {
    // The current Illinois parser materializes each CSV, so keep reads sequential to cap peak memory.
    const csv = await readFile(path, "utf8");
    for (const record of parseIllinoisSbeExpenditureRecordsCsv(csv, input.sourceUrl)) {
      records.push(record);
    }
  }
  return records;
}

export async function loadIllinoisSbeArtifactDataSet(
  config: IllinoisSbeArtifactDataSourceConfig
): Promise<IllinoisSbeArtifactDataSet> {
  const normalizedArtifactPath = config.normalizedArtifactPath?.trim() || null;
  if (config.receiptsTsvPath?.trim() && !normalizedArtifactPath) {
    // Checked before the CSV requirement so a receipts-only configuration
    // gets the error naming its actual missing piece.
    throw new Error("Illinois SBE receipts require the normalized artifact for the committee allow-list");
  }
  const contributionCsvPaths = normalizePathList(
    config.contributionCsvPaths,
    "contribution",
    normalizedArtifactPath === null
  );
  const expenditureCsvPaths = normalizePathList(config.expenditureCsvPaths, "expenditure", false);
  const contributionSourceUrl = config.contributionSourceUrl?.trim() || ILLINOIS_SBE_CONTRIBUTION_COMMITTEE_SEARCH_URL;
  const expenditureSourceUrl = config.expenditureSourceUrl?.trim() || ILLINOIS_SBE_EXPENDITURE_ALL_SEARCH_URL;
  const dataSet: IllinoisSbeArtifactDataSet = {
    contributionRecords: await loadContributionRecords({
      paths: contributionCsvPaths,
      sourceUrl: contributionSourceUrl,
    }),
    contributionCsvsLoaded: contributionCsvPaths.length > 0,
    contributionSourceUrl,
  };

  if (normalizedArtifactPath) {
    dataSet.normalizedArtifact = await loadIllinoisSbeNormalizedArtifact(normalizedArtifactPath);
  }

  const receiptsTsvPath = config.receiptsTsvPath?.trim() || null;
  if (receiptsTsvPath) {
    if (!dataSet.normalizedArtifact) {
      // The committee allow-list comes from the artifact's relations; without
      // it the whole multi-decade file would have to be kept in memory.
      throw new Error("Illinois SBE receipts require the normalized artifact for the committee allow-list");
    }
    const committeeIds = new Set(
      dataSet.normalizedArtifact.candidateCommitteeRelations.map((relation) => relation.committeeId)
    );
    // The due window looks ahead, never far back: a cycle needs receipts from
    // the year before its election year at the earliest.
    const minReceiptYear =
      config.minReceiptYear ??
      illinoisMinReceiptYearForLookback({ now: new Date(), electionLookbackDays: 1 });
    const { receiptsByCommitteeId, visitedRowCount, keptRowCount, malformedRowCount } =
      await loadIllinoisSbeReceiptsByCommitteeId({
        path: receiptsTsvPath,
        committeeIds,
        minReceiptYear,
      });
    // Always leave a trace of what the multi-million-row scan kept — the first
    // question when breakdowns come back empty.
    const scannedRowCount = visitedRowCount + malformedRowCount;
    const receiptsStats =
      `Illinois SBE Receipts.txt kept ${keptRowCount} of ${scannedRowCount} rows ` +
      `for ${committeeIds.size} allow-listed committees since ${minReceiptYear}` +
      (malformedRowCount > 0 ? `; skipped ${malformedRowCount} malformed rows` : "");
    if (malformedRowCount > 0) {
      console.warn(receiptsStats);
    } else {
      console.log(receiptsStats);
    }
    dataSet.receiptsByCommitteeId = receiptsByCommitteeId;
    dataSet.receiptsCommitteeIds = committeeIds;
    dataSet.receiptsSourceUrl = config.receiptsSourceUrl?.trim() || ILLINOIS_SBE_BULK_DOWNLOAD_URL;
  }

  if (expenditureCsvPaths.length > 0) {
    dataSet.expenditureRecords = await loadExpenditureRecords({
      paths: expenditureCsvPaths,
      sourceUrl: expenditureSourceUrl,
    });
    dataSet.expenditureSourceUrl = expenditureSourceUrl;
  }

  return dataSet;
}

function directContributionMatchesDueRow(input: {
  record: IllinoisSbeContributionRecord;
  row: IllinoisCandidateFinanceDueRow;
}): boolean {
  return (
    normalizeIllinoisCommitteeKey(input.record.recipientCommitteeName) ===
    normalizeIllinoisCommitteeKey(input.row.committeeName)
  );
}

function candidateNameMatches(input: {
  record: IllinoisSbeExpenditureRecord;
  row: IllinoisCandidateFinanceDueRow;
}): boolean {
  const recordName = input.record.candidateName?.trim();
  if (!recordName) {
    return false;
  }
  // One-sided nickname expansion: the VoteApp row may expand, the SBE record
  // keys stay literal so distinct formal names cannot meet at a shared
  // nickname key.
  const rowKeys = normalizeIllinoisCandidateNameKeys(input.row.candidateName, { expandNicknames: true });
  const recordKeys = normalizeIllinoisCandidateNameKeys(recordName);
  let keyMatched = false;
  for (const key of recordKeys) {
    if (rowKeys.has(key)) {
      keyMatched = true;
      break;
    }
  }
  if (!keyMatched) {
    return false;
  }
  // Key overlap collapses names to first+last, so an IE naming
  // "Smith, John B" would count toward "John A. Smith". A contradicting
  // middle name rejects the record.
  return !illinoisCandidateNameMiddleConflicts({
    candidateName: input.row.candidateName,
    rowNames: [recordName],
  });
}

function officeDistrictMatches(input: {
  record: IllinoisSbeExpenditureRecord;
  row: IllinoisCandidateFinanceDueRow;
}): boolean {
  const officeSearch = toIllinoisSbeOfficeSearchInput({
    officeScope: input.row.officeScope,
    officeCanonicalName: input.row.officeName,
    district: input.row.district,
    districtType: input.row.sbeDistrictType,
    sbeOffice: input.row.sbeOffice,
    isAtLarge: input.row.isAtLarge,
  });
  if (!officeSearch) {
    return false;
  }
  const recordOffice = normalizeIllinoisFinanceTextKey(input.record.officeDistrict);
  const targetOffice = normalizeIllinoisFinanceTextKey(officeSearch.sbeOffice);
  if (!recordOffice || !targetOffice) {
    return false;
  }
  const district = officeSearch.district?.trim();
  if (!district) {
    // Preserve the existing statewide matcher: SBE exports may append
    // statewide text after the office label. Place offices take the exact
    // jurisdiction-aware path below.
    return recordOffice.includes(targetOffice);
  }
  if (officeSearch.sbeDistrictType) {
    if (!recordOffice.startsWith(`${targetOffice} `)) {
      return false;
    }
    const recordMunicipality = recordOffice.slice(targetOffice.length).trim().replace(/^OF\s+/, "");
    return illinoisMunicipalityMatches({
      voteAppDistrictName: district,
      sbeDistrictName: recordMunicipality,
      sbeDistrictType: officeSearch.sbeDistrictType,
    });
  }
  if (!recordOffice.includes(targetOffice)) {
    return false;
  }
  const districtKey = normalizeIllinoisFinanceTextKey(district).replace(/^0+/, "");
  const recordDistrictTokens = recordOffice
    .split(" ")
    .map((token) => token.replace(/(?:ST|ND|RD|TH)$/i, "").replace(/^0+/, ""))
    .filter(Boolean);
  return recordDistrictTokens.includes(districtKey);
}

function outsideExpenditureMatchesDueRow(input: {
  record: IllinoisSbeExpenditureRecord;
  row: IllinoisCandidateFinanceDueRow;
}): boolean {
  return (
    input.record.supportOppose !== null &&
    candidateNameMatches(input) &&
    officeDistrictMatches(input) &&
    isIllinoisFinanceCycleDate({
      rawDate: input.record.expendedDate,
      electionYear: input.row.electionYear,
    })
  );
}

function outsideGroupContributionMatches(input: {
  record: IllinoisSbeContributionRecord;
  outsideCommitteeKeys: ReadonlySet<string>;
}): boolean {
  return input.outsideCommitteeKeys.has(normalizeIllinoisCommitteeKey(input.record.recipientCommitteeName));
}

export function loadIllinoisFinanceDataForDueRowFromArtifacts(input: {
  row: IllinoisCandidateFinanceDueRow;
  artifacts: IllinoisSbeArtifactDataSet;
}): IllinoisCandidateFinanceData {
  const committeeId = extractIllinoisSbeCommitteeId(input.row.committeeKey);
  const receipts =
    committeeId !== null ? input.artifacts.receiptsByCommitteeId?.get(committeeId) : undefined;
  const data: IllinoisCandidateFinanceData = {
    directContributionSourceUrl: input.artifacts.contributionSourceUrl,
  };
  if (
    input.artifacts.receiptsByCommitteeId !== undefined &&
    committeeId !== null &&
    input.artifacts.receiptsCommitteeIds?.has(committeeId)
  ) {
    // Bulk receipts are keyed by the SBE committee id, so an allow-listed
    // id-keyed link takes the exact path; an empty list is an honest "no
    // itemized receipts". A committee OUTSIDE the allow-list was never
    // scanned, so it must not receive this authoritative empty — it falls
    // through to the CSV path or, with no CSVs, preserves stored breakdowns.
    const sourceUrl = input.artifacts.receiptsSourceUrl ?? ILLINOIS_SBE_BULK_DOWNLOAD_URL;
    data.directContributionRecords = (receipts ?? []).map((receipt) =>
      toIllinoisSbeContributionRecordFromReceipt({
        receipt,
        recipientCommitteeName: input.row.committeeName,
        sourceUrl,
      })
    );
    data.directContributionSourceUrl = sourceUrl;
  } else if (input.artifacts.contributionCsvsLoaded &&
      !input.artifacts.contributionRecords.some((record) => record.documentName !== undefined)) {
    // Modern discovery exports include rapid/amended filings. Only the verified
    // Quarterly path may turn those rows (including a filtered empty) into a snapshot.
    data.directContributionRecords = input.artifacts.contributionRecords.filter((record) =>
      directContributionMatchesDueRow({ record, row: input.row })
    );
  }
  // Otherwise no itemized source was loaded at all — a D-2 summaries-only
  // refresh — so the field stays undefined and stored breakdowns survive.

  if (input.artifacts.normalizedArtifact && committeeId) {
    data.d2ReportSummaries = input.artifacts.normalizedArtifact.d2ReportSummaries.filter(
      (report) => report.committeeId === committeeId
    );
  }

  if (input.artifacts.expenditureRecords !== undefined &&
      !input.artifacts.expenditureRecords.some((record) => record.documentName !== undefined)) {
    const outsideExpenditureRecords = input.artifacts.expenditureRecords.filter((record) =>
      outsideExpenditureMatchesDueRow({ record, row: input.row })
    );
    const outsideCommitteeKeys = new Set(
      outsideExpenditureRecords
        .map((record) => normalizeIllinoisCommitteeKey(record.expendingCommitteeName))
        .filter(Boolean)
    );
    data.outsideExpenditureRecords = outsideExpenditureRecords;
    data.outsideExpenditureSourceUrl = input.artifacts.expenditureSourceUrl;
    data.outsideGroupContributionRecords = input.artifacts.contributionRecords.filter((record) =>
      outsideGroupContributionMatches({ record, outsideCommitteeKeys })
    );
    data.outsideGroupContributionSourceUrl = input.artifacts.contributionSourceUrl;
  }

  return data;
}

export function createIllinoisSbeArtifactCandidateCommitteeResolver(
  artifacts: IllinoisSbeArtifactDataSet
): IllinoisCandidateCommitteeResolver {
  if (artifacts.normalizedArtifact) {
    return async (input) =>
      resolveIllinoisCandidateCommitteesFromRelations({
        ...input,
        relations: artifacts.normalizedArtifact!.candidateCommitteeRelations,
      });
  }
  return async (input) =>
    resolveIllinoisCandidateCommittee({
      ...input,
      contributionRecords: artifacts.contributionRecords,
      sourceUrl: artifacts.contributionSourceUrl,
    });
}
