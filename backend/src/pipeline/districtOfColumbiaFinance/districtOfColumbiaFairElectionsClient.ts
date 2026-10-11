// D.C. Fair Elections Program (public financing) committees file with OCF's
// separate Fair Elections system, not the eFiling system behind
// efiling.ocf.dc.gov/DataDownload. Their receipts and expenditures never appear
// in the principal campaign committee export, so participating candidates
// (Schwalb, Lewis George, Silverman, ...) showed no money.
//
// The public dashboard at fairelections.ocf.dc.gov/public/Contributions reads
// a JSON API that needs no login. This client pages through it and maps rows
// onto the same record shapes the OCF export produces, so the existing
// resolver and aggregators work unchanged.

import {
  DistrictOfColumbiaOcfClientError,
  type DistrictOfColumbiaOcfClientOptions,
  type DistrictOfColumbiaOcfContributionRecord,
  type DistrictOfColumbiaOcfExpenditureRecord,
  type DistrictOfColumbiaReceiptKind,
} from "./districtOfColumbiaOcfClient.js";

export const DISTRICT_OF_COLUMBIA_FAIR_ELECTIONS_API_BASE_URL = "https://fairelections.ocf.dc.gov/app/api";
export const DISTRICT_OF_COLUMBIA_FAIR_ELECTIONS_SOURCE_URL = "https://fairelections.ocf.dc.gov/public/Contributions";
export const DISTRICT_OF_COLUMBIA_FAIR_ELECTIONS_COMMITTEE_KEY_PREFIX = "DC FAIR ELECTIONS ";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_PAGE_SIZE = 5_000;
const MAX_PAGES = 200;

export type DistrictOfColumbiaFairElectionsElection = {
  electionId: number;
  displayName?: string;
  electionDate: string;
  electionYear: number;
  electionTypeCode: string;
};

export type DistrictOfColumbiaFairElectionsContributionRow = {
  registrationId: number;
  candidateName?: string | null;
  candidateNameWithOffice?: string | null;
  committeeName?: string | null;
  contributorName?: string | null;
  contributorType?: string | null;
  contributionSource?: string | null;
  contributorOccupation?: string | null;
  employerName?: string | null;
  contributionDate?: string | null;
  amount: number;
};

export type DistrictOfColumbiaFairElectionsExpenditureRow = {
  registrationId: number;
  committeeName?: string | null;
  payeeName?: string | null;
  expenditureType?: string | null;
  purposeReason?: string | null;
  date?: string | null;
  amount: number;
};

export type DistrictOfColumbiaFairElectionsData = {
  sourceUrl: string;
  contributionRecords: DistrictOfColumbiaOcfContributionRecord[];
  expenditureRecords: DistrictOfColumbiaOcfExpenditureRecord[];
};

type PagedResponse<T> = { totalCount?: number; gridData?: T[] };

export function districtOfColumbiaFairElectionsCommitteeKey(registrationId: number): string {
  return `${DISTRICT_OF_COLUMBIA_FAIR_ELECTIONS_COMMITTEE_KEY_PREFIX}${registrationId}`;
}

export function isDistrictOfColumbiaFairElectionsCommitteeKey(committeeKey: string): boolean {
  return committeeKey.trim().toUpperCase().startsWith(DISTRICT_OF_COLUMBIA_FAIR_ELECTIONS_COMMITTEE_KEY_PREFIX);
}

function cleanText(value: string | null | undefined): string | undefined {
  const cleaned = value?.replace(/\s+/g, " ").trim();
  return cleaned && cleaned.toUpperCase() !== "N/A" ? cleaned : undefined;
}

// Schedule codes from /Public/GetSchedulesForContributions:
// A = D.C. residents, A1 = non-residents, A2 = candidate/family,
// A4 = other Fair Elections committees, A3 = public funds,
// A5 = prohibited contributions (must be refunded), A6 = interest,
// A7 = offsets to expenditures.
export function districtOfColumbiaFairElectionsReceiptKind(scheduleCode: string | null | undefined): DistrictOfColumbiaReceiptKind {
  const code = scheduleCode?.trim().toUpperCase() ?? "";
  if (code === "A3") {
    return "public_funds";
  }
  if (code === "A" || code === "A1" || code === "A2" || code === "A4") {
    return "contribution";
  }
  return "other";
}

// "Brian L. Schwalb (Attorney General)" -> OCF office labels the existing
// office mapper understands. Unmapped offices (State Board of Education)
// keep their raw label, which the mapper rejects.
export function parseDistrictOfColumbiaFairElectionsOffice(
  candidateNameWithOffice: string | null | undefined
): { office?: string; seat?: string } {
  const match = /\(([^()]*)\)\s*$/.exec(candidateNameWithOffice ?? "");
  const label = cleanText(match?.[1]);
  if (!label) {
    return {};
  }
  if (/^council\s+chair(?:man|person)?$/i.test(label)) {
    return { office: "Chairman of the Council" };
  }
  const council = /^council\s+(at[\s-]*large|ward\s*\d+)$/i.exec(label);
  if (council?.[1]) {
    return { office: "Councilmember", seat: council[1] };
  }
  return { office: label };
}

export function districtOfColumbiaFairElectionsContributionRecordFromRow(
  row: DistrictOfColumbiaFairElectionsContributionRow,
  electionYear: number
): DistrictOfColumbiaOcfContributionRecord | null {
  const amount = Number(row.amount);
  if (!Number.isInteger(row.registrationId) || !Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  const committeeName = cleanText(row.committeeName);
  const candidateName = cleanText(row.candidateName);
  const contributorName = cleanText(row.contributorName);
  const contributorType = cleanText(row.contributorType);
  const employer = cleanText(row.employerName);
  const occupation = cleanText(row.contributorOccupation);
  const date = cleanText(row.contributionDate);
  return {
    committeeName: committeeName ?? districtOfColumbiaFairElectionsCommitteeKey(row.registrationId),
    committeeKey: districtOfColumbiaFairElectionsCommitteeKey(row.registrationId),
    ...(candidateName ? { candidateName } : {}),
    ...parseDistrictOfColumbiaFairElectionsOffice(row.candidateNameWithOffice),
    electionYear,
    ...(contributorName ? { contributorName } : {}),
    ...(contributorType ? { contributorType } : {}),
    ...(employer ? { employer } : {}),
    ...(occupation ? { occupation } : {}),
    amount,
    ...(date ? { date } : {}),
    receiptKind: districtOfColumbiaFairElectionsReceiptKind(row.contributionSource),
  };
}

export function districtOfColumbiaFairElectionsExpenditureRecordFromRow(
  row: DistrictOfColumbiaFairElectionsExpenditureRow
): DistrictOfColumbiaOcfExpenditureRecord | null {
  const amount = Number(row.amount);
  if (!Number.isInteger(row.registrationId) || !Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  const committeeName = cleanText(row.committeeName);
  const payeeName = cleanText(row.payeeName);
  const purpose = cleanText(row.purposeReason) ?? cleanText(row.expenditureType);
  const date = cleanText(row.date);
  return {
    committeeName: committeeName ?? districtOfColumbiaFairElectionsCommitteeKey(row.registrationId),
    committeeKey: districtOfColumbiaFairElectionsCommitteeKey(row.registrationId),
    ...(payeeName ? { payeeName } : {}),
    ...(purpose ? { purpose } : {}),
    amount,
    ...(date ? { date } : {}),
  };
}

async function requestFairElectionsJson<T>(
  path: string,
  init: { method: "GET" } | { method: "POST"; body: unknown },
  options: DistrictOfColumbiaOcfClientOptions
): Promise<T> {
  const url = `${DISTRICT_OF_COLUMBIA_FAIR_ELECTIONS_API_BASE_URL}${path}`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      method: init.method,
      headers:
        init.method === "POST"
          ? { accept: "application/json", "content-type": "application/json" }
          : { accept: "application/json" },
      ...(init.method === "POST" ? { body: JSON.stringify(init.body) } : {}),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new DistrictOfColumbiaOcfClientError(
      "network_error",
      aborted
        ? `D.C. Fair Elections request timed out after ${timeoutMs}ms for ${url}`
        : `D.C. Fair Elections request failed for ${url}: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new DistrictOfColumbiaOcfClientError(
      "http_error",
      `D.C. Fair Elections request failed for ${url}: ${response.status} ${response.statusText}`,
      response.status
    );
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new DistrictOfColumbiaOcfClientError("bad_response", `D.C. Fair Elections returned non-JSON for ${url}`);
  }
}

async function fetchAllPages<T>(
  path: string,
  baseBody: Record<string, unknown>,
  options: DistrictOfColumbiaOcfClientOptions & { pageSize?: number }
): Promise<T[]> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const rows: T[] = [];
  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum += 1) {
    const page = await requestFairElectionsJson<PagedResponse<T>>(
      path,
      { method: "POST", body: { ...baseBody, recordsPerPage: pageSize, pageNum } },
      options
    );
    if (!Array.isArray(page.gridData)) {
      throw new DistrictOfColumbiaOcfClientError("bad_response", `D.C. Fair Elections ${path} returned no gridData`);
    }
    rows.push(...page.gridData);
    // A short page always ends paging. The count check only applies when the API
    // reports one; without it, a full page must be followed by another request.
    const totalCount = typeof page.totalCount === "number" ? page.totalCount : null;
    if (page.gridData.length < pageSize || (totalCount !== null && rows.length >= totalCount)) {
      return rows;
    }
  }
  throw new DistrictOfColumbiaOcfClientError("bad_response", `D.C. Fair Elections ${path} exceeded ${MAX_PAGES} pages`);
}

function contributionSearchBody(input: { electionYear: number; electionId: number }): Record<string, unknown> {
  return {
    electionYear: input.electionYear,
    filingYear: 0,
    electionId: input.electionId,
    officeId: 0,
    reportId: 0,
    startDate: null,
    endDate: null,
    minAmount: 0,
    maxAmount: 0,
    contributionTypeCode: "",
    contributionSource: [],
    registrationId: "0",
    state: "",
    city: "",
    zipcode: "",
    sortByField: "",
    sortOrderDesc: true,
    searchText: "",
  };
}

function expenditureSearchBody(input: { electionYear: number; electionId: number }): Record<string, unknown> {
  return {
    electionYear: input.electionYear,
    electionId: input.electionId,
    officeId: 0,
    startDate: null,
    endDate: null,
    minAmount: 0,
    maxAmount: 0,
    expenditureTypeCode: [],
    registrationId: "0",
    state: "",
    city: "",
    zipcode: "",
    sortByField: "",
    sortOrderDesc: true,
    searchText: "",
  };
}

export async function fetchDistrictOfColumbiaFairElectionsElections(
  electionYear: number,
  options: DistrictOfColumbiaOcfClientOptions = {}
): Promise<DistrictOfColumbiaFairElectionsElection[]> {
  const elections = await requestFairElectionsJson<DistrictOfColumbiaFairElectionsElection[]>(
    `/Public/GetElectionsByYear/${electionYear}`,
    { method: "GET" },
    options
  );
  if (!Array.isArray(elections)) {
    throw new DistrictOfColumbiaOcfClientError("bad_response", "D.C. Fair Elections election list was not an array");
  }
  return elections.filter((election) => Number.isInteger(election.electionId) && election.electionYear === electionYear);
}

// A special-election committee closes once its election is over, while a
// primary committee carries on into the general. Skipping finished specials
// keeps a candidate who ran in both (Silverman: June at-large special, then
// the November general) from matching two committees for one race.
//
// `finishedSpecialGraceDays` keeps a special for as many days past its date as
// the batch sync still treats that election as due (its election lookback).
// Dropping it sooner would sync an already-linked special-election committee
// against no rows and overwrite its stored totals with zeros.
export function selectDistrictOfColumbiaFairElectionsElections(
  elections: readonly DistrictOfColumbiaFairElectionsElection[],
  now: Date,
  finishedSpecialGraceDays = 0
): DistrictOfColumbiaFairElectionsElection[] {
  const cutoff = new Date(now.getTime() - finishedSpecialGraceDays * 86_400_000).toISOString().slice(0, 10);
  return elections.filter((election) => {
    if (election.electionTypeCode?.trim().toUpperCase() !== "SE") {
      return true;
    }
    const electionDate = election.electionDate?.slice(0, 10) ?? "";
    return electionDate >= cutoff;
  });
}

export async function downloadDistrictOfColumbiaFairElectionsData(
  input: { electionYear: number; now?: Date; finishedSpecialGraceDays?: number },
  options: DistrictOfColumbiaOcfClientOptions & { pageSize?: number } = {}
): Promise<DistrictOfColumbiaFairElectionsData> {
  const elections = selectDistrictOfColumbiaFairElectionsElections(
    await fetchDistrictOfColumbiaFairElectionsElections(input.electionYear, options),
    input.now ?? new Date(),
    input.finishedSpecialGraceDays
  );
  const contributionRecords: DistrictOfColumbiaOcfContributionRecord[] = [];
  const expenditureRecords: DistrictOfColumbiaOcfExpenditureRecord[] = [];
  for (const election of elections) {
    const filter = { electionYear: input.electionYear, electionId: election.electionId };
    const contributionRows = await fetchAllPages<DistrictOfColumbiaFairElectionsContributionRow>(
      "/Public/SearchContributions",
      contributionSearchBody(filter),
      options
    );
    for (const row of contributionRows) {
      const record = districtOfColumbiaFairElectionsContributionRecordFromRow(row, input.electionYear);
      if (record) {
        contributionRecords.push(record);
      }
    }
    const expenditureRows = await fetchAllPages<DistrictOfColumbiaFairElectionsExpenditureRow>(
      "/Public/SearchExpenditures",
      expenditureSearchBody(filter),
      options
    );
    for (const row of expenditureRows) {
      const record = districtOfColumbiaFairElectionsExpenditureRecordFromRow(row);
      if (record) {
        expenditureRecords.push(record);
      }
    }
  }
  return {
    sourceUrl: DISTRICT_OF_COLUMBIA_FAIR_ELECTIONS_SOURCE_URL,
    contributionRecords,
    expenditureRecords,
  };
}
