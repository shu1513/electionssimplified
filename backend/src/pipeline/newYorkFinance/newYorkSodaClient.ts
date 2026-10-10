// NY Open Data (Socrata) client for the NYSBOE campaign finance mirrors.
//
// The NYSBOE Public Reporting hosts block backend clients behind a Cloudflare
// challenge, so this module must never fetch from them; data.ny.gov is the
// production path (docs/plans/plan-new-york-finance.md, verified from Render on
// 2026-07-11). Queries stay narrow: filtered $where, stable $order, bounded
// paging — never a bulk download of the ~18M-row disclosure dataset.
export const NEW_YORK_SODA_BASE_URL = "https://data.ny.gov/resource";
export const NEW_YORK_SODA_DISCLOSURES_DATASET = "e9ss-239a";
export const NEW_YORK_SODA_FILERS_DATASET = "7x2g-h32p";
export const NEW_YORK_SODA_DISCLOSURES_PAGE_URL = "https://data.ny.gov/d/e9ss-239a";
export const NEW_YORK_SODA_FILERS_PAGE_URL = "https://data.ny.gov/d/7x2g-h32p";
export const NEW_YORK_SODA_DEFAULT_TIMEOUT_MS = 30_000;
export const NEW_YORK_SODA_DEFAULT_PAGE_LIMIT = 1_000;
export const NEW_YORK_SODA_MAX_PAGE_LIMIT = 50_000;
export const NEW_YORK_SODA_DEFAULT_MAX_PAGES = 25;
export const NEW_YORK_INDEPENDENT_EXPENDITURE_COMMITTEE_TYPE = "Independent Expenditure Committee";
export const NEW_YORK_AUTHORIZED_SINGLE_CANDIDATE_COMMITTEE_TYPE = "Authorized Single Candidate Committee";
export const NEW_YORK_PUBLIC_CAMPAIGN_FINANCE_COMMITTEE_TYPE = "Public Campaign Finance Committee";

const FILER_ID_CHUNK_SIZE = 50;
const TRANS_NUMBER_CHUNK_SIZE = 50;
const RECEIPT_SCHEDULE_ABBREVS = ["A", "B", "C", "D"] as const;

export type NewYorkSodaClientErrorCode = "invalid_request" | "network_error" | "http_error" | "bad_response";

export class NewYorkSodaClientError extends Error {
  constructor(
    public readonly code: NewYorkSodaClientErrorCode,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "NewYorkSodaClientError";
  }
}

export type NewYorkSodaClientOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  appToken?: string;
  pageLimit?: number;
  maxPages?: number;
};

// Socrata rate-limits unauthenticated calls by shared IP pool; production
// should always set NEW_YORK_SODA_APP_TOKEN (free, not a user credential).
export function defaultNewYorkSodaClientOptions(): NewYorkSodaClientOptions {
  const appToken = process.env.NEW_YORK_SODA_APP_TOKEN?.trim();
  return appToken ? { appToken } : {};
}

export type NewYorkFilerRecord = {
  filerId: string;
  filerName: string;
  complianceType: string | null;
  committeeType: string | null;
  filerStatus: string | null;
  filerType: string | null;
  officeDesc: string | null;
  district: string | null;
  countyDesc: string | null;
};

export type NewYorkScheduleRAllocationRow = {
  filerId: string;
  committeeName: string;
  candidateFirstName: string;
  candidateMiddleName: string;
  candidateLastName: string;
  officeDesc: string;
  district: string | null;
  electionYear: string;
  supportOppose: "S" | "O";
  amount: number;
  transNumber: string;
  transMapping: string | null;
  filingTransId: string;
};

export type NewYorkParentExpenditureRow = {
  transNumber: string;
  scheduleAbbrev: string;
  amount: number | null;
};

export type NewYorkCommitteeReceiptRow = {
  entityName: string;
  entityFirstName: string;
  entityLastName: string;
  contributorType: string | null;
  scheduleAbbrev: string;
  amount: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new NewYorkSodaClientError("invalid_request", `Invalid New York SODA election year: ${value}`);
  }
  return value;
}

// Statewide races run on four-year cycles, legislative races on two-year
// cycles; the caller derives this from the office scope.
export type NewYorkCycleYears = 2 | 4;

function normalizeCycleYears(value: number): NewYorkCycleYears {
  if (value !== 2 && value !== 4) {
    throw new NewYorkSodaClientError("invalid_request", `Invalid New York SODA cycle years: ${value}`);
  }
  return value;
}

function isoDate(utcMs: number): string {
  return new Date(utcMs).toISOString().slice(0, 10);
}

// New York general election day: first Tuesday after the first Monday in
// November.
export function newYorkGeneralElectionDay(year: number): string {
  const firstOfNovember = Date.UTC(year, 10, 1);
  const dayOfWeek = new Date(firstOfNovember).getUTCDay();
  const firstMonday = 1 + ((8 - dayOfWeek) % 7);
  return isoDate(Date.UTC(year, 10, firstMonday + 1));
}

// Transaction-date window covering one race's fundraising cycle: the day
// after the previous general election through election day. On non-Schedule-R
// disclosure rows, election_year is the *disclosure report year* (dataset
// metadata: "Disclosure Report Year"), not the race year, so cycle queries
// must filter on sched_date instead of election_year.
export function newYorkCycleSchedDateWindow(
  electionYear: number,
  cycleYears: NewYorkCycleYears
): { startDate: string; endDateExclusive: string } {
  const year = normalizeElectionYear(electionYear);
  const normalizedCycleYears = normalizeCycleYears(cycleYears);
  const dayAfter = (date: string): string => isoDate(Date.parse(`${date}T00:00:00Z`) + 24 * 60 * 60 * 1_000);
  return {
    startDate: dayAfter(newYorkGeneralElectionDay(year - normalizedCycleYears)),
    endDateExclusive: dayAfter(newYorkGeneralElectionDay(year)),
  };
}

function normalizePageLimit(value: number | undefined): number {
  const normalized = value ?? NEW_YORK_SODA_DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(normalized) || normalized <= 0 || normalized > NEW_YORK_SODA_MAX_PAGE_LIMIT) {
    throw new NewYorkSodaClientError(
      "invalid_request",
      `New York SODA page limit must be an integer between 1 and ${NEW_YORK_SODA_MAX_PAGE_LIMIT}`
    );
  }
  return normalized;
}

function normalizeMaxPages(value: number | undefined): number {
  const normalized = value ?? NEW_YORK_SODA_DEFAULT_MAX_PAGES;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new NewYorkSodaClientError("invalid_request", "New York SODA maxPages must be a positive integer");
  }
  return normalized;
}

function requireFilerId(value: string, fieldName = "New York filer id"): string {
  const trimmed = value.trim();
  if (!/^\d{1,12}$/.test(trimmed)) {
    throw new NewYorkSodaClientError("invalid_request", `Invalid ${fieldName}: ${value}`);
  }
  return trimmed;
}

// SoQL string literals escape single quotes by doubling them.
export function soqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function soqlInList(values: readonly string[]): string {
  return `(${values.map(soqlString).join(",")})`;
}

function getString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value.trim() : "";
}

function getNullableString(row: Record<string, unknown>, key: string): string | null {
  const value = getString(row, key);
  return value.length > 0 ? value : null;
}

function getAmount(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.replace(/[$,]/g, ""));
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export function buildNewYorkSodaDatasetUrl(datasetId: string, params: Record<string, string | number | undefined>): string {
  if (!/^[a-z0-9]{4}-[a-z0-9]{4}$/i.test(datasetId)) {
    throw new NewYorkSodaClientError("invalid_request", `Invalid New York SODA dataset ID: ${datasetId}`);
  }
  const url = new URL(`${NEW_YORK_SODA_BASE_URL}/${datasetId}.json`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function fetchNewYorkSodaJson(url: string, options: NewYorkSodaClientOptions): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? NEW_YORK_SODA_DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers({ accept: "application/json" });
  if (options.appToken?.trim()) {
    headers.set("X-App-Token", options.appToken.trim());
  }

  // The timeout must cover the body read too, so it is cleared only after
  // response.json() settles; a stalled body would otherwise hang forever.
  try {
    let response: Response;
    try {
      response = await (options.fetchImpl ?? fetch)(url, { headers, signal: controller.signal });
    } catch (error) {
      if (isAbortError(error)) {
        throw new NewYorkSodaClientError(
          "network_error",
          `New York SODA request timed out after ${timeoutMs}ms for ${url}`
        );
      }
      throw new NewYorkSodaClientError(
        "network_error",
        `New York SODA request failed for ${url}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (!response.ok) {
      throw new NewYorkSodaClientError(
        "http_error",
        `New York SODA request failed: ${response.status} ${response.statusText}`,
        response.status
      );
    }

    try {
      return await response.json();
    } catch (error) {
      if (isAbortError(error)) {
        throw new NewYorkSodaClientError(
          "network_error",
          `New York SODA request timed out after ${timeoutMs}ms for ${url}`
        );
      }
      throw new NewYorkSodaClientError(
        "bad_response",
        `New York SODA response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchNewYorkSodaRows(
  datasetId: string,
  params: Record<string, string | number | undefined>,
  options: NewYorkSodaClientOptions
): Promise<Record<string, unknown>[]> {
  const payload = await fetchNewYorkSodaJson(buildNewYorkSodaDatasetUrl(datasetId, params), options);
  if (!Array.isArray(payload)) {
    throw new NewYorkSodaClientError("bad_response", "New York SODA response is missing the result array");
  }
  return payload.filter(isRecord);
}

// Socrata paging requires a stable $order; callers must pass one.
async function fetchNewYorkSodaPagedRows(
  datasetId: string,
  params: Record<string, string | number | undefined> & { $order: string },
  options: NewYorkSodaClientOptions
): Promise<Record<string, unknown>[]> {
  const limit = normalizePageLimit(options.pageLimit);
  const maxPages = normalizeMaxPages(options.maxPages);
  const rows: Record<string, unknown>[] = [];
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await fetchNewYorkSodaRows(
      datasetId,
      { ...params, $limit: limit, $offset: pageIndex * limit },
      options
    );
    rows.push(...page);
    if (page.length < limit) {
      return rows;
    }
  }
  throw new NewYorkSodaClientError(
    "bad_response",
    `New York SODA paged query exceeded ${maxPages} pages for dataset ${datasetId}`
  );
}

function filerRecordFromRow(row: Record<string, unknown>): NewYorkFilerRecord | null {
  const filerId = getString(row, "filer_id");
  const filerName = getString(row, "filer_name");
  if (!filerId || !filerName) {
    return null;
  }
  return {
    filerId,
    filerName,
    complianceType: getNullableString(row, "compliance_type_desc"),
    committeeType: getNullableString(row, "committee_type_desc"),
    filerStatus: getNullableString(row, "filer_status"),
    filerType: getNullableString(row, "filer_type_desc"),
    officeDesc: getNullableString(row, "office_desc"),
    district: getNullableString(row, "district"),
    countyDesc: getNullableString(row, "county_desc"),
  };
}

export async function getNewYorkFilerRecords(
  input: { filerIds: readonly string[] },
  options: NewYorkSodaClientOptions = {}
): Promise<Map<string, NewYorkFilerRecord>> {
  const filerIds = [...new Set(input.filerIds.map((filerId) => requireFilerId(filerId)))];
  const records = new Map<string, NewYorkFilerRecord>();
  const duplicateFilerIds = new Set<string>();
  for (const filerIdChunk of chunk(filerIds, FILER_ID_CHUNK_SIZE)) {
    const rows = await fetchNewYorkSodaRows(
      NEW_YORK_SODA_FILERS_DATASET,
      {
        $where: `filer_id IN ${soqlInList(filerIdChunk)}`,
        $order: "filer_id",
        $limit: filerIdChunk.length * 2,
      },
      options
    );
    for (const row of rows) {
      const record = filerRecordFromRow(row);
      if (!record) {
        continue;
      }
      // A filer id appearing more than once in the registry is unexpected;
      // drop it entirely rather than trusting any copy.
      if (duplicateFilerIds.has(record.filerId)) {
        continue;
      }
      if (records.has(record.filerId)) {
        records.delete(record.filerId);
        duplicateFilerIds.add(record.filerId);
        continue;
      }
      records.set(record.filerId, record);
    }
  }
  return records;
}

export async function searchNewYorkActiveCandidateFilers(
  input: {
    boeOfficeLabels: readonly string[];
    district: string | null;
  },
  options: NewYorkSodaClientOptions = {}
): Promise<NewYorkFilerRecord[]> {
  if (input.boeOfficeLabels.length === 0) {
    throw new NewYorkSodaClientError("invalid_request", "New York candidate filer search requires office labels");
  }
  const where = [
    "compliance_type_desc='CANDIDATE'",
    "filer_status='ACTIVE'",
    "filer_type_desc='State'",
    `office_desc IN ${soqlInList([...input.boeOfficeLabels])}`,
  ];
  if (input.district !== null) {
    where.push(`district=${soqlString(input.district)}`);
  }
  const rows = await fetchNewYorkSodaPagedRows(
    NEW_YORK_SODA_FILERS_DATASET,
    { $where: where.join(" AND "), $order: "filer_id" },
    options
  );
  return rows.map(filerRecordFromRow).filter((record): record is NewYorkFilerRecord => record !== null);
}

export async function searchNewYorkActiveAuthorizedCommitteeFilers(
  input: { nameContains: string },
  options: NewYorkSodaClientOptions = {}
): Promise<NewYorkFilerRecord[]> {
  const nameContains = input.nameContains.trim().toUpperCase().replace(/[%_]/g, "");
  if (nameContains.length < 2) {
    throw new NewYorkSodaClientError("invalid_request", "New York committee filer search requires a name fragment");
  }
  const rows = await fetchNewYorkSodaPagedRows(
    NEW_YORK_SODA_FILERS_DATASET,
    {
      // filer_type_desc='State' matters: ~80% of active authorized committees
      // are county-level filers, and a county candidate with the same name
      // must never be linked to a state candidate (verified 2026-07-11).
      // 2026 statewide and legislative candidates in the public matching
      // program file as "Public Campaign Finance Committee" ("Blakeman for
      // New York", "James for NY 2026"); the authorized-committee type alone
      // missed every one of them.
      $where: [
        "compliance_type_desc='COMMITTEE'",
        `committee_type_desc IN ${soqlInList([
          NEW_YORK_AUTHORIZED_SINGLE_CANDIDATE_COMMITTEE_TYPE,
          NEW_YORK_PUBLIC_CAMPAIGN_FINANCE_COMMITTEE_TYPE,
        ])}`,
        "filer_status='ACTIVE'",
        "filer_type_desc='State'",
        `upper(filer_name) like ${soqlString(`%${nameContains}%`)}`,
      ].join(" AND "),
      $order: "filer_id",
    },
    options
  );
  return rows.map(filerRecordFromRow).filter((record): record is NewYorkFilerRecord => record !== null);
}

function scheduleRAllocationFromRow(row: Record<string, unknown>): NewYorkScheduleRAllocationRow | null {
  const filerId = getString(row, "filer_id");
  const committeeName = getString(row, "cand_comm_name");
  const supportOppose = getString(row, "r_support_oppose");
  const amount = getAmount(row, "org_amt");
  const transNumber = getString(row, "trans_number");
  const filingTransId = getString(row, "filing_trans_id");
  const officeDesc = getString(row, "office_desc");
  if (
    !filerId ||
    !committeeName ||
    (supportOppose !== "S" && supportOppose !== "O") ||
    amount === null ||
    !transNumber ||
    !filingTransId ||
    !officeDesc
  ) {
    return null;
  }
  return {
    filerId,
    committeeName,
    candidateFirstName: getString(row, "flng_ent_first_name"),
    candidateMiddleName: getString(row, "flng_ent_middle_name"),
    candidateLastName: getString(row, "flng_ent_last_name"),
    officeDesc,
    district: getNullableString(row, "district"),
    electionYear: getString(row, "election_year_r"),
    supportOppose,
    amount,
    transNumber,
    transMapping: getNullableString(row, "trans_mapping"),
    filingTransId,
  };
}

export async function getNewYorkScheduleRAllocations(
  input: {
    electionYear: number;
    boeOfficeLabels: readonly string[];
    district: string | null;
  },
  options: NewYorkSodaClientOptions = {}
): Promise<NewYorkScheduleRAllocationRow[]> {
  const electionYear = normalizeElectionYear(input.electionYear);
  if (input.boeOfficeLabels.length === 0) {
    throw new NewYorkSodaClientError("invalid_request", "New York Schedule R search requires office labels");
  }
  const where = [
    "filing_sched_abbrev='R'",
    `election_year_r=${soqlString(String(electionYear))}`,
    "r_support_oppose IS NOT NULL",
    `office_desc IN ${soqlInList([...input.boeOfficeLabels])}`,
  ];
  if (input.district !== null) {
    where.push(`district=${soqlString(input.district)}`);
  }
  const rows = await fetchNewYorkSodaPagedRows(
    NEW_YORK_SODA_DISCLOSURES_DATASET,
    {
      $select:
        "filer_id,cand_comm_name,flng_ent_first_name,flng_ent_middle_name,flng_ent_last_name,office_desc,district,election_year_r,r_support_oppose,org_amt,trans_number,trans_mapping,filing_trans_id",
      $where: where.join(" AND "),
      $order: "filing_trans_id",
    },
    options
  );
  return rows
    .map(scheduleRAllocationFromRow)
    .filter((row): row is NewYorkScheduleRAllocationRow => row !== null);
}

export async function getNewYorkParentExpenditures(
  input: { filerId: string; transNumbers: readonly string[] },
  options: NewYorkSodaClientOptions = {}
): Promise<Map<string, NewYorkParentExpenditureRow[]>> {
  const filerId = requireFilerId(input.filerId);
  const transNumbers = [...new Set(input.transNumbers.map((value) => value.trim()).filter((value) => value.length > 0))];
  const rowsByTransNumber = new Map<string, NewYorkParentExpenditureRow[]>();
  for (const transNumberChunk of chunk(transNumbers, TRANS_NUMBER_CHUNK_SIZE)) {
    const rows = await fetchNewYorkSodaPagedRows(
      NEW_YORK_SODA_DISCLOSURES_DATASET,
      {
        $select: "trans_number,filing_sched_abbrev,org_amt",
        $where: `filer_id=${soqlString(filerId)} AND trans_number IN ${soqlInList(transNumberChunk)}`,
        $order: "filing_trans_id",
      },
      options
    );
    for (const row of rows) {
      const transNumber = getString(row, "trans_number");
      if (!transNumber) {
        continue;
      }
      const list = rowsByTransNumber.get(transNumber) ?? [];
      list.push({
        transNumber,
        scheduleAbbrev: getString(row, "filing_sched_abbrev"),
        amount: getAmount(row, "org_amt"),
      });
      rowsByTransNumber.set(transNumber, list);
    }
  }
  return rowsByTransNumber;
}

function committeeReceiptFromRow(row: Record<string, unknown>): NewYorkCommitteeReceiptRow | null {
  const amount = getAmount(row, "org_amt");
  const scheduleAbbrev = getString(row, "filing_sched_abbrev");
  if (amount === null || amount <= 0 || !scheduleAbbrev) {
    return null;
  }
  return {
    entityName: getString(row, "flng_ent_name"),
    entityFirstName: getString(row, "flng_ent_first_name"),
    entityLastName: getString(row, "flng_ent_last_name"),
    contributorType: getNullableString(row, "cntrbr_type_desc"),
    scheduleAbbrev,
    amount,
  };
}

export async function getNewYorkCommitteeItemizedReceipts(
  input: { filerId: string; electionYear: number; cycleYears: NewYorkCycleYears },
  options: NewYorkSodaClientOptions = {}
): Promise<NewYorkCommitteeReceiptRow[]> {
  const filerId = requireFilerId(input.filerId);
  const window = newYorkCycleSchedDateWindow(input.electionYear, input.cycleYears);
  const rows = await fetchNewYorkSodaPagedRows(
    NEW_YORK_SODA_DISCLOSURES_DATASET,
    {
      $select: "flng_ent_name,flng_ent_first_name,flng_ent_last_name,cntrbr_type_desc,filing_sched_abbrev,org_amt",
      $where: [
        `filer_id=${soqlString(filerId)}`,
        `filing_sched_abbrev IN ${soqlInList([...RECEIPT_SCHEDULE_ABBREVS])}`,
        "filing_cat_desc='Itemized'",
        `sched_date>=${soqlString(window.startDate)}`,
        `sched_date<${soqlString(window.endDateExclusive)}`,
      ].join(" AND "),
      $order: "filing_trans_id",
    },
    options
  );
  return rows.map(committeeReceiptFromRow).filter((row): row is NewYorkCommitteeReceiptRow => row !== null);
}

// Total itemized Schedule F spending for one committee and cycle, computed
// server-side; NULL when the committee has no matching rows. The window ends
// on election day, so post-election spending (debt retirement, wind-down) is
// deliberately excluded.
export async function getNewYorkCommitteeExpenditureTotal(
  input: { filerId: string; electionYear: number; cycleYears: NewYorkCycleYears },
  options: NewYorkSodaClientOptions = {}
): Promise<number | null> {
  const filerId = requireFilerId(input.filerId);
  const window = newYorkCycleSchedDateWindow(input.electionYear, input.cycleYears);
  const rows = await fetchNewYorkSodaRows(
    NEW_YORK_SODA_DISCLOSURES_DATASET,
    {
      $select: "sum(org_amt) AS total",
      $where: [
        `filer_id=${soqlString(filerId)}`,
        "filing_sched_abbrev='F'",
        "filing_cat_desc='Itemized'",
        `sched_date>=${soqlString(window.startDate)}`,
        `sched_date<${soqlString(window.endDateExclusive)}`,
      ].join(" AND "),
    },
    options
  );
  const total = rows.length === 1 ? getAmount(rows[0], "total") : null;
  return total !== null && total >= 0 ? total : null;
}
