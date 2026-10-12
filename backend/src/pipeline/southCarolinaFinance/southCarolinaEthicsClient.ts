export const SOUTH_CAROLINA_ETHICS_API_BASE_URL = "https://ethicsfiling.sc.gov/api";
export const SOUTH_CAROLINA_ETHICS_PUBLIC_REPORTING_URL = "https://ethicsfiling.sc.gov/public";

export const SOUTH_CAROLINA_ETHICS_ENDPOINTS = {
  filerSearch: "Ethics/Get/Public/Search/By/Filer/Name/",
  candidateReports: "Ethics/Get/Public/Candidate/Reports",
  reportDetails: "Ethics/Get/Public/Candidate/Report/Details",
  contributionSearch: "Candidate/Contribution/Search/",
} as const;

export type SouthCarolinaEthicsClientErrorCode =
  | "invalid_request"
  | "network_error"
  | "http_error"
  | "bad_response";

export class SouthCarolinaEthicsClientError extends Error {
  constructor(
    public readonly code: SouthCarolinaEthicsClientErrorCode,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "SouthCarolinaEthicsClientError";
  }
}

export type SouthCarolinaEthicsClientOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type SouthCarolinaFilerSearchRow = {
  candidate: string;
  candidateFilerId: number;
  officeName: string | null;
  lastCampaignDisclosureReport: string | null;
};

export type SouthCarolinaCandidateReportRow = {
  reportId: number;
  reportName: string;
  reportType: string;
  // M/D/YYYY as served; identifies the election run together with campaignId.
  electionDate: string;
  // Cumulative for the report's election run, not period amounts.
  contributions: number;
  expenses: number;
  balance: number;
  dateSubmitted: string | null;
  campaignId: number;
  candidateFilerId: number;
  filingStartDate: string;
  filingEndDate: string;
  isPrimary: boolean;
  isGeneral: boolean;
  isPreElection: boolean;
  isFinal: boolean;
};

export type SouthCarolinaReportSummaryLine = {
  type: string;
  filingPeriod: number;
  electionCycleTotal: number;
};

export type SouthCarolinaReportBalanceLine = {
  totalType: string;
  startingBalance: number;
  endingBalance: number;
};

export type SouthCarolinaReportVersion = {
  id: number;
  name: string;
};

export type SouthCarolinaItemizedContribution = {
  /** Profile identity; reused across separate receipt occurrences. */
  contributorId: number;
  name: string;
  civilDate: string;
  amountCents: number;
  occupation: string | null;
  description: string | null;
  sourceDate: string;
  sourceDateSort?: string;
};

export type SouthCarolinaItemizedExpenditure = {
  /** Payee profile identity, not a receipt or expenditure transaction ID. */
  paidToId: number;
  name: string;
  civilDate: string;
  amountCents: number;
  description: string | null;
  sourceDate: string;
  sourceDateSort?: string;
};

export type SouthCarolinaReportDetails = {
  filerName: string;
  electionDate: string;
  electionType: string;
  reportType: string;
  filingPeriod: string;
  isAmendment: boolean;
  reportSequenceNumber: number;
  contributionsTotal: number;
  expendituresTotal: number;
  income: SouthCarolinaReportSummaryLine[];
  expenditures: SouthCarolinaReportSummaryLine[];
  totals: SouthCarolinaReportBalanceLine[];
  // Newest first as served; the first entry is the current version.
  versions: SouthCarolinaReportVersion[];
  // Absent legacy fields remain unavailable, distinct from a source empty list.
  itemizedContributions?: SouthCarolinaItemizedContribution[];
  itemizedExpenditures?: SouthCarolinaItemizedExpenditure[];
  itemizedUnavailable?: true;
};

export type SouthCarolinaContributionSearchRow = {
  contributionId: number;
  candidateId: number;
  officeRunId: number;
  candidateName: string;
  // Literal "4" for current-cycle statewide runs — never match on this.
  officeName: string;
  electionDate: string;
  date: string;
  amount: number;
  contributorName: string;
  contributorOccupation: string | null;
  group: "Yes" | "No";
  description: string | null;
};

export const SOUTH_CAROLINA_ETHICS_FETCH_TIMEOUT_MS = 120_000;
const MAX_JSON_RESPONSE_BYTES = 64 * 1024 * 1024;
// Two-character surnames are real SC filers (verified live: "Wu" returns House and
// Senate filers). The server accepts even shorter text, but an empty search dumps
// the full statewide filer index, so keep a floor of 2.
const MIN_FILER_SEARCH_LENGTH = 2;

function invalid(message: string): never {
  throw new SouthCarolinaEthicsClientError("invalid_request", message);
}

function badResponse(message: string): never {
  throw new SouthCarolinaEthicsClientError("bad_response", message);
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    badResponse(`Invalid South Carolina ethics ${label}`);
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    badResponse(`Invalid South Carolina ethics ${label}`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    badResponse(`Invalid South Carolina ethics ${label}`);
  }
  return value.trim();
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    badResponse(`Invalid South Carolina ethics ${label}`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  const parsed = requiredNumber(value, label);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    badResponse(`Invalid South Carolina ethics ${label}`);
  }
  return parsed;
}

function requiredNonNegativeInteger(value: unknown, label: string): number {
  const parsed = requiredNumber(value, label);
  if (!Number.isInteger(parsed) || parsed < 0) {
    badResponse(`Invalid South Carolina ethics ${label}`);
  }
  return parsed;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    badResponse(`Invalid South Carolina ethics ${label}`);
  }
  return value;
}

async function request(input: {
  method: "GET" | "POST";
  endpointPath: string;
  body?: unknown;
  options?: SouthCarolinaEthicsClientOptions;
}): Promise<unknown> {
  const fetchImpl = input.options?.fetchImpl ?? fetch;
  const timeoutMs = input.options?.timeoutMs ?? SOUTH_CAROLINA_ETHICS_FETCH_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    invalid(`Invalid South Carolina ethics timeout: ${timeoutMs}`);
  }
  const url = `${SOUTH_CAROLINA_ETHICS_API_BASE_URL}/${input.endpointPath}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: input.method,
      headers: {
        Accept: "application/json, text/plain, */*",
        ...(input.method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      body: input.method === "POST" ? JSON.stringify(input.body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SouthCarolinaEthicsClientError(
      "network_error",
      `South Carolina ethics request failed: ${message}`
    );
  }

  if (!response.ok) {
    throw new SouthCarolinaEthicsClientError(
      "http_error",
      `South Carolina ethics request returned HTTP ${response.status}: ${input.endpointPath}`,
      response.status
    );
  }

  // The SPA serves an HTML fallback page for unknown GET routes; only JSON is data.
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    badResponse(
      `South Carolina ethics ${input.endpointPath} returned unexpected content type: ${contentType || "missing"}`
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SouthCarolinaEthicsClientError(
      "network_error",
      `South Carolina ethics response read failed: ${message}`
    );
  }
  if (bytes.byteLength > MAX_JSON_RESPONSE_BYTES) {
    badResponse(`South Carolina ethics ${input.endpointPath} exceeded ${MAX_JSON_RESPONSE_BYTES} bytes`);
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    badResponse(`South Carolina ethics ${input.endpointPath} returned invalid JSON`);
  }
}

function parseFilerSearchRow(value: unknown): SouthCarolinaFilerSearchRow {
  const row = objectValue(value, "filer-search row");
  return {
    candidate: requiredString(row.candidate, "filer-search candidate"),
    // 0 occurs for SEI-only filers with no candidate account.
    candidateFilerId: requiredNonNegativeInteger(row.candidateFilerId, "filer-search candidateFilerId"),
    officeName: nullableString(row.officeName),
    lastCampaignDisclosureReport: nullableString(row.lastCampaignDisclosureReport),
  };
}

const ELECTION_DATE_PATTERN = /^\d{1,2}\/\d{1,2}\/\d{4}$/;

function parseCandidateReportRow(value: unknown, expectedCandidateFilerId: number): SouthCarolinaCandidateReportRow {
  const row = objectValue(value, "report row");
  const dates = objectValue(row.reportWithDates, "report row reportWithDates");
  const electionDate = requiredString(row.electionDate, "report row electionDate");
  if (!ELECTION_DATE_PATTERN.test(electionDate)) {
    badResponse(`Invalid South Carolina ethics report row electionDate: ${electionDate}`);
  }
  const candidateFilerId = requiredPositiveInteger(dates.candidateFilerId, "report row candidateFilerId");
  if (candidateFilerId !== expectedCandidateFilerId) {
    badResponse(
      `South Carolina ethics report row candidateFilerId mismatch: expected ${expectedCandidateFilerId}, got ${candidateFilerId}`
    );
  }
  return {
    reportId: requiredPositiveInteger(row.reportId, "report row reportId"),
    reportName: requiredString(row.report, "report row report"),
    reportType: requiredString(row.reportType, "report row reportType"),
    electionDate,
    contributions: requiredNumber(row.contributions, "report row contributions"),
    expenses: requiredNumber(row.expenses, "report row expenses"),
    balance: requiredNumber(row.balance, "report row balance"),
    dateSubmitted: nullableString(row.dateSubmitted),
    campaignId: requiredPositiveInteger(dates.campaignId, "report row campaignId"),
    candidateFilerId,
    filingStartDate: requiredString(dates.filingStartDate, "report row filingStartDate"),
    filingEndDate: requiredString(dates.filingEndDate, "report row filingEndDate"),
    isPrimary: requiredBoolean(dates.isPrimary, "report row isPrimary"),
    isGeneral: requiredBoolean(dates.isGeneral, "report row isGeneral"),
    isPreElection: requiredBoolean(dates.isPreElection, "report row isPreElection"),
    isFinal: requiredBoolean(dates.isFinal, "report row isFinal"),
  };
}

function parseSummaryLine(value: unknown, label: string): SouthCarolinaReportSummaryLine {
  const row = objectValue(value, label);
  return {
    type: requiredString(row.type, `${label} type`),
    filingPeriod: requiredNumber(row.filingPeriod, `${label} filingPeriod`),
    electionCycleTotal: requiredNumber(row.electionCycleTotal, `${label} electionCycleTotal`),
  };
}

function parseBalanceLine(value: unknown): SouthCarolinaReportBalanceLine {
  const row = objectValue(value, "balance line");
  return {
    totalType: requiredString(row.totalType, "balance line totalType"),
    startingBalance: requiredNumber(row.startingBalance, "balance line startingBalance"),
    endingBalance: requiredNumber(row.endingBalance, "balance line endingBalance"),
  };
}

/** Parse only published civil-date shapes; zero-date sort fields are not dates. */
export function parseSouthCarolinaCivilDate(value: string): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  let iso: string;
  const numeric = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  const printed = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(value);
  if (numeric) {
    iso = `${numeric[3]}-${numeric[1]!.padStart(2, "0")}-${numeric[2]!.padStart(2, "0")}`;
  } else if (printed && months.includes(printed[1]!)) {
    iso = `${printed[3]}-${String(months.indexOf(printed[1]!) + 1).padStart(2, "0")}-${printed[2]!.padStart(2, "0")}`;
  } else if (/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value)) {
    iso = value.slice(0, 10);
  } else {
    return badResponse("Invalid South Carolina published civil date");
  }
  const date = new Date(iso + "T00:00:00Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso || iso.startsWith("0000")) {
    return badResponse("Invalid South Carolina published civil day");
  }
  return iso;
}

function itemizedCents(value: unknown): number {
  const amount = requiredNumber(value, "itemized amount");
  const cents = Math.round(amount * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(amount * 100 - cents) > 1e-6) {
    return badResponse("South Carolina itemized amount is not cent-exact");
  }
  return cents;
}
function financialText(value: unknown, field: string): string | null {
  if (value !== null && typeof value !== "string") return badResponse(`Invalid South Carolina itemized ${field}`);
  return value as string | null;
}
function itemizedName(value: unknown): string {
  requiredString(value, "itemized name");
  return value as string;
}
function parseItemizedContribution(value: unknown): SouthCarolinaItemizedContribution {
  const row = objectValue(value, "itemized contribution");
  const sourceDate = requiredString(row.date, "itemized date");
  return {
    contributorId: requiredPositiveInteger(row.contributorId, "contributor profile ID"),
    name: itemizedName(row.contributor),
    civilDate: parseSouthCarolinaCivilDate(sourceDate),
    amountCents: itemizedCents(row.amount),
    occupation: financialText(row.occupation, "occupation"),
    description: financialText(row.description, "description"),
    sourceDate,
    ...(Object.hasOwn(row, "dateSort") ? { sourceDateSort: requiredString(row.dateSort, "itemized dateSort") } : {}),
  };
}
function parseItemizedExpenditure(value: unknown): SouthCarolinaItemizedExpenditure {
  const row = objectValue(value, "itemized expenditure");
  const sourceDate = requiredString(row.date, "itemized date");
  return {
    paidToId: requiredPositiveInteger(row.paidToId, "payee profile ID"),
    name: itemizedName(row.paidTo),
    civilDate: parseSouthCarolinaCivilDate(sourceDate),
    amountCents: itemizedCents(row.amount),
    description: financialText(row.description, "description"),
    sourceDate,
    ...(Object.hasOwn(row, "dateSort") ? { sourceDateSort: requiredString(row.dateSort, "itemized dateSort") } : {}),
  };
}

function parseReportItemization(
  contributions: Record<string, unknown>,
  expenditures: Record<string, unknown>,
): Pick<SouthCarolinaReportDetails, "itemizedContributions" | "itemizedExpenditures" | "itemizedUnavailable"> {
  try {
    return {
      ...(Object.hasOwn(contributions, "details")
        ? {
            itemizedContributions: arrayValue(contributions.details, "itemized contributions").map(
              parseItemizedContribution,
            ),
          }
        : {}),
      ...(Object.hasOwn(expenditures, "details")
        ? {
            itemizedExpenditures: arrayValue(expenditures.details, "itemized expenditures").map(
              parseItemizedExpenditure,
            ),
          }
        : {}),
    };
  } catch (error) {
    // Invalid optional itemization cannot certify donors, but does not erase
    // independently validated summary controls used by existing direct sync.
    if (error instanceof SouthCarolinaEthicsClientError && error.code === "bad_response") {
      return { itemizedUnavailable: true };
    }
    throw error;
  }
}

function parseReportVersion(value: unknown): SouthCarolinaReportVersion {
  const row = objectValue(value, "report version");
  return {
    id: requiredPositiveInteger(row.id, "report version id"),
    name: requiredString(row.name, "report version name"),
  };
}

function parseContributionSearchRow(value: unknown): SouthCarolinaContributionSearchRow {
  const row = objectValue(value, "contribution row");
  const group = row.group;
  if (group !== "Yes" && group !== "No") {
    badResponse(`Invalid South Carolina ethics contribution row group: ${String(group)}`);
  }
  const occupation = row.contributorOccupation;
  if (occupation !== undefined && occupation !== null && typeof occupation !== "string") {
    badResponse("Invalid South Carolina ethics contribution row contributorOccupation");
  }
  return {
    contributionId: requiredPositiveInteger(row.contributionId, "contribution row contributionId"),
    candidateId: requiredPositiveInteger(row.candidateId, "contribution row candidateId"),
    officeRunId: requiredPositiveInteger(row.officeRunId, "contribution row officeRunId"),
    candidateName: requiredString(row.candidateName, "contribution row candidateName"),
    officeName: requiredString(row.officeName, "contribution row officeName"),
    electionDate: requiredString(row.electionDate, "contribution row electionDate"),
    date: requiredString(row.date, "contribution row date"),
    amount: requiredNumber(row.amount, "contribution row amount"),
    contributorName: requiredString(row.contributorName, "contribution row contributorName"),
    contributorOccupation: nullableString(occupation),
    group,
    description: nullableString(row.description),
  };
}

export async function searchSouthCarolinaFilersByName(
  name: string,
  options?: SouthCarolinaEthicsClientOptions
): Promise<SouthCarolinaFilerSearchRow[]> {
  const normalized = name.trim();
  if (normalized.length < MIN_FILER_SEARCH_LENGTH) {
    invalid(`South Carolina filer search requires at least ${MIN_FILER_SEARCH_LENGTH} characters`);
  }
  const parsed = await request({
    method: "POST",
    endpointPath: SOUTH_CAROLINA_ETHICS_ENDPOINTS.filerSearch,
    // The endpoint takes the search text as a bare JSON string, not an object.
    body: normalized,
    options,
  });
  const envelope = objectValue(parsed, "filer-search response");
  const rows = arrayValue(envelope.result, "filer-search result").map(parseFilerSearchRow);
  // The server can list the same filer twice (duplicate address records share one
  // candidateFilerId); keep one row per filer id so callers see one row per source
  // identity. Id 0 is shared by all SEI-only filers — distinct people — so those
  // rows dedupe on their full parsed content instead.
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = row.candidateFilerId > 0 ? `id:${row.candidateFilerId}` : JSON.stringify(row);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export async function getSouthCarolinaCandidateReports(
  candidateFilerId: number,
  options?: SouthCarolinaEthicsClientOptions
): Promise<SouthCarolinaCandidateReportRow[]> {
  if (!Number.isInteger(candidateFilerId) || candidateFilerId <= 0) {
    invalid(`Invalid South Carolina candidateFilerId: ${candidateFilerId}`);
  }
  const parsed = await request({
    method: "POST",
    endpointPath: SOUTH_CAROLINA_ETHICS_ENDPOINTS.candidateReports,
    body: { candidateFilerId },
    options,
  });
  const envelope = objectValue(parsed, "candidate-reports response");
  return arrayValue(envelope.results, "candidate-reports results").map((row) =>
    parseCandidateReportRow(row, candidateFilerId)
  );
}

export function southCarolinaReportDetailsUrl(reportId: number): string {
  if (!Number.isInteger(reportId) || reportId <= 0) {
    invalid(`Invalid South Carolina reportId: ${reportId}`);
  }
  return `${SOUTH_CAROLINA_ETHICS_API_BASE_URL}/${SOUTH_CAROLINA_ETHICS_ENDPOINTS.reportDetails}/${reportId}`;
}

export async function getSouthCarolinaReportDetails(
  reportId: number,
  options?: SouthCarolinaEthicsClientOptions
): Promise<SouthCarolinaReportDetails> {
  if (!Number.isInteger(reportId) || reportId <= 0) {
    invalid(`Invalid South Carolina reportId: ${reportId}`);
  }
  const parsed = await request({
    method: "GET",
    endpointPath: `${SOUTH_CAROLINA_ETHICS_ENDPOINTS.reportDetails}/${reportId}`,
    options,
  });
  const detail = objectValue(parsed, "report-details response");
  const overview = objectValue(detail.overview, "report-details overview");
  const contributions = objectValue(detail.contributions, "report-details contributions");
  const expenditures = objectValue(detail.expenditures, "report-details expenditures");
  const versions = arrayValue(detail.versions, "report-details versions").map(parseReportVersion);
  if (versions.length === 0) {
    badResponse("South Carolina ethics report details returned no versions");
  }
  return {
    filerName: requiredString(detail.filerName, "report-details filerName"),
    electionDate: requiredString(detail.electionDate, "report-details electionDate"),
    electionType: requiredString(detail.electionType, "report-details electionType"),
    reportType: requiredString(detail.reportType, "report-details reportType"),
    filingPeriod: requiredString(detail.filingPeriod, "report-details filingPeriod"),
    isAmendment: requiredBoolean(detail.isAmendment, "report-details isAmendment"),
    reportSequenceNumber: requiredNonNegativeInteger(
      overview.reportSequenceNumber,
      "report-details reportSequenceNumber"
    ),
    contributionsTotal: requiredNumber(contributions.contributionsTotal, "report-details contributionsTotal"),
    expendituresTotal: requiredNumber(expenditures.expendituresTotal, "report-details expendituresTotal"),
    income: arrayValue(overview.income, "report-details income").map((line) =>
      parseSummaryLine(line, "income line")
    ),
    expenditures: arrayValue(overview.expenditures, "report-details expenditure lines").map((line) =>
      parseSummaryLine(line, "expenditure line")
    ),
    totals: arrayValue(overview.totals, "report-details totals").map(parseBalanceLine),
    versions,
    ...parseReportItemization(contributions, expenditures),
  };
}

export async function searchSouthCarolinaContributions(
  input: { candidate: string; contributionYear: number },
  options?: SouthCarolinaEthicsClientOptions
): Promise<SouthCarolinaContributionSearchRow[]> {
  // The API has no candidateId filter and errors on a body with no recognized
  // field, so candidate text plus year is the required server-side filter;
  // callers narrow the rows locally by candidateId / officeRunId.
  const candidate = input.candidate.trim();
  if (!candidate) {
    invalid("South Carolina contribution search requires candidate text");
  }
  if (
    !Number.isInteger(input.contributionYear) ||
    input.contributionYear < 2000 ||
    input.contributionYear > 2100
  ) {
    invalid(`Invalid South Carolina contribution year: ${input.contributionYear}`);
  }
  const parsed = await request({
    method: "POST",
    endpointPath: SOUTH_CAROLINA_ETHICS_ENDPOINTS.contributionSearch,
    body: { candidate, contributionYear: input.contributionYear },
    options,
  });
  return arrayValue(parsed, "contribution-search response").map(parseContributionSearchRow);
}
