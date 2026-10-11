export const WASHINGTON_PDC_DATA_BASE_URL = "https://data.wa.gov/resource";
export const WASHINGTON_PDC_CAMPAIGN_FINANCE_SUMMARY_DATASET = "3h9x-7bvm";
export const WASHINGTON_PDC_CONTRIBUTIONS_DATASET = "kv7h-kjye";
export const WASHINGTON_PDC_INDEPENDENT_EXPENDITURES_DATASET = "67cp-h962";
export const WASHINGTON_PDC_DEFAULT_TIMEOUT_MS = 30_000;
export const WASHINGTON_PDC_DEFAULT_PAGE_LIMIT = 5_000;
export const WASHINGTON_PDC_MAX_PAGE_LIMIT = 50_000;
export const WASHINGTON_PDC_DEFAULT_MAX_PAGES = 50;

export type WashingtonPdcClientErrorCode = "invalid_request" | "network_error" | "http_error" | "bad_response";

export class WashingtonPdcClientError extends Error {
  constructor(
    public readonly code: WashingtonPdcClientErrorCode,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "WashingtonPdcClientError";
  }
}

export type WashingtonPdcClientOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  appToken?: string;
  pageLimit?: number;
  maxPages?: number;
};

export type WashingtonPdcCandidateSummary = {
  filerId: string;
  committeeId?: string;
  candidacyId?: string;
  filerName: string;
  committeeCategory?: string;
  politicalCommitteeType?: string;
  candidateCommitteeStatus?: string;
  activeCandidate: boolean | null;
  hasReports: boolean | null;
  office?: string;
  legislativeDistrict?: string;
  jurisdiction?: string;
  jurisdictionType?: string;
  position?: string;
  reportingOption?: string;
  filingType?: string;
  electionYear: number;
  contributionsAmount?: number;
  expendituresAmount?: number;
  independentExpendituresForAmount?: number;
  independentExpendituresAgainstAmount?: number;
  sourceUrl?: string;
};

export type WashingtonPdcCandidateSummarySearchInput = {
  candidateName: string;
  electionYear: number;
  office?: string | null;
  legislativeDistrict?: string | null;
  limit?: number;
};

export type WashingtonPdcCommitteeInput = {
  filerId?: string | null;
  committeeId?: string | null;
  electionYear: number;
  limit?: number;
};

export type WashingtonPdcAggregate = {
  categoryName: string;
  amount: number;
  count: number;
  sourceUrl?: string;
};

export type WashingtonPdcIndependentSpendingGroup = {
  sponsorId: string;
  sponsorName: string;
  supportOppose: "support" | "oppose";
  amount: number;
  expenditureCount: number;
  sourceUrl?: string;
};

export type WashingtonPdcIndependentSpendingGroupInput = {
  candidateName: string;
  electionYear: number;
  office?: string | null;
  legislativeDistrict?: string | null;
  // Hard candidate identity from the campaign-finance summary dataset. Hard-ID
  // mode needs BOTH: a filer can run two races in one year under different
  // committees (filer EWINS  258 in 2025), so a filer-only filter would mix
  // races. With both present the C6 rows are filtered by the IDs and the
  // name/office predicates are skipped entirely; otherwise name matching is
  // the unlinked fallback.
  candidateFilerId?: string | null;
  candidateCommitteeId?: string | null;
  limit?: number;
};

export type WashingtonPdcSponsorSummaryInput = {
  sponsorName: string;
  electionYear: number;
  limit?: number;
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

function normalizeNonEmptyString(value: string, fieldName: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) {
    throw new WashingtonPdcClientError("invalid_request", `${fieldName} is required`);
  }
  return normalized;
}

function optionalString(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().replace(/\s+/g, " ");
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function optionalIdentifier(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new WashingtonPdcClientError("invalid_request", `Invalid Washington PDC election year: ${value}`);
  }
  return value;
}

function normalizeLimit(value: number | undefined, defaultValue: number): number {
  const normalized = value ?? defaultValue;
  if (!Number.isInteger(normalized) || normalized <= 0 || normalized > WASHINGTON_PDC_MAX_PAGE_LIMIT) {
    throw new WashingtonPdcClientError(
      "invalid_request",
      `Washington PDC limit must be an integer between 1 and ${WASHINGTON_PDC_MAX_PAGE_LIMIT}`
    );
  }
  return normalized;
}

function normalizePageLimit(value: number | undefined): number {
  return normalizeLimit(value, WASHINGTON_PDC_DEFAULT_PAGE_LIMIT);
}

function normalizeMaxPages(value: number | undefined): number {
  const normalized = value ?? WASHINGTON_PDC_DEFAULT_MAX_PAGES;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new WashingtonPdcClientError("invalid_request", `Washington PDC maxPages must be a positive integer`);
  }
  return normalized;
}

function soqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// Name words are joined with "%" so extra spaces in a PDC filer name still
// match (live 2026: "DEBRA Jean  ENTENMAN" with two spaces missed the
// candidate "Debra Jean Entenman"). The resolver checks the name strictly.
function soqlLikeContains(value: string): string {
  const words = value.toLowerCase().replace(/[%_]/g, "").trim().split(/\s+/).filter(Boolean);
  return soqlString(`%${words.join("%")}%`);
}

function whereEqualText(field: string, value: string): string {
  return `upper(${field}) = upper(${soqlString(value)})`;
}

function whereLikeText(field: string, value: string): string {
  return `lower(${field}) like ${soqlLikeContains(value)}`;
}

function getString(row: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function getNumber(row: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
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
  }
  return undefined;
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function getBoolean(row: Record<string, unknown>, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "yes", "y", "1"].includes(normalized)) {
        return true;
      }
      if (["false", "no", "n", "0"].includes(normalized)) {
        return false;
      }
    }
  }
  return null;
}

function extractUrl(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (isRecord(value)) {
    const url = value.url;
    if (typeof url === "string" && url.trim().length > 0) {
      return url.trim();
    }
  }
  return undefined;
}

function supportOpposeFromPdc(value: string | undefined): "support" | "oppose" | null {
  const normalized = value?.trim().toUpperCase();
  if (normalized === "FOR" || normalized === "SUPPORT") {
    return "support";
  }
  if (normalized === "AGAINST" || normalized === "OPPOSE") {
    return "oppose";
  }
  return null;
}

function normalizePdcPersonName(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

export function buildWashingtonPdcDatasetUrl(
  datasetId: string,
  params: Record<string, string | number | undefined>
): string {
  if (!/^[a-z0-9]{4}-[a-z0-9]{4}$/i.test(datasetId)) {
    throw new WashingtonPdcClientError("invalid_request", `Invalid Washington PDC dataset ID: ${datasetId}`);
  }

  const url = new URL(`${WASHINGTON_PDC_DATA_BASE_URL}/${datasetId}.json`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function fetchWashingtonPdcJson(url: string, options: WashingtonPdcClientOptions): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? WASHINGTON_PDC_DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers({ accept: "application/json" });
  if (options.appToken?.trim()) {
    headers.set("X-App-Token", options.appToken.trim());
  }

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, { headers, signal: controller.signal });
  } catch (error) {
    if (isAbortError(error)) {
      throw new WashingtonPdcClientError(
        "network_error",
        `Washington PDC request timed out after ${timeoutMs}ms for ${url}`
      );
    }
    throw new WashingtonPdcClientError(
      "network_error",
      `Washington PDC request failed for ${url}: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new WashingtonPdcClientError(
      "http_error",
      `Washington PDC request failed: ${response.status} ${response.statusText}`,
      response.status
    );
  }

  try {
    return await response.json();
  } catch (error) {
    throw new WashingtonPdcClientError(
      "bad_response",
      `Washington PDC response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function fetchWashingtonPdcRows<T = Record<string, unknown>>(
  datasetId: string,
  params: Record<string, string | number | undefined>,
  options: WashingtonPdcClientOptions = {}
): Promise<T[]> {
  const payload = await fetchWashingtonPdcJson(buildWashingtonPdcDatasetUrl(datasetId, params), options);
  if (!Array.isArray(payload)) {
    throw new WashingtonPdcClientError("bad_response", "Washington PDC response is missing result array");
  }
  return payload as T[];
}

async function fetchWashingtonPdcPagedRows<T = Record<string, unknown>>(
  datasetId: string,
  params: Record<string, string | number | undefined>,
  options: WashingtonPdcClientOptions = {}
): Promise<T[]> {
  const limit = normalizePageLimit(options.pageLimit);
  const maxPages = normalizeMaxPages(options.maxPages);
  const rows: T[] = [];
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const offset = pageIndex * limit;
    const page = await fetchWashingtonPdcRows<T>(
      datasetId,
      {
        ...params,
        $limit: limit,
        $offset: offset,
      },
      options
    );
    rows.push(...page);
    if (page.length < limit) {
      return rows;
    }
  }
  throw new WashingtonPdcClientError(
    "bad_response",
    `Washington PDC paged query exceeded ${maxPages} pages for dataset ${datasetId}`
  );
}

function candidateSummaryFromRow(row: unknown): WashingtonPdcCandidateSummary | null {
  if (!isRecord(row)) {
    return null;
  }
  const filerId = getString(row, "filer_id");
  const filerName = getString(row, "filer_name");
  const electionYear = getNumber(row, "election_year");
  if (!filerId || !filerName || electionYear === undefined || !Number.isInteger(electionYear)) {
    return null;
  }
  const normalizedElectionYear = electionYear;

  return {
    filerId,
    ...(getString(row, "committee_id") ? { committeeId: getString(row, "committee_id") } : {}),
    ...(getString(row, "candidacy_id") ? { candidacyId: getString(row, "candidacy_id") } : {}),
    filerName,
    ...(getString(row, "committee_category") ? { committeeCategory: getString(row, "committee_category") } : {}),
    ...(getString(row, "political_committee_type")
      ? { politicalCommitteeType: getString(row, "political_committee_type") }
      : {}),
    ...(getString(row, "candidate_committee_status")
      ? { candidateCommitteeStatus: getString(row, "candidate_committee_status") }
      : {}),
    activeCandidate: getBoolean(row, "active_candidate"),
    hasReports: getBoolean(row, "has_reports"),
    ...(getString(row, "office") ? { office: getString(row, "office") } : {}),
    ...(getString(row, "legislative_district") ? { legislativeDistrict: getString(row, "legislative_district") } : {}),
    ...(getString(row, "jurisdiction") ? { jurisdiction: getString(row, "jurisdiction") } : {}),
    ...(getString(row, "jurisdiction_type") ? { jurisdictionType: getString(row, "jurisdiction_type") } : {}),
    ...(getString(row, "position") ? { position: getString(row, "position") } : {}),
    ...(getString(row, "reporting_option") ? { reportingOption: getString(row, "reporting_option") } : {}),
    ...(getString(row, "filing_type") ? { filingType: getString(row, "filing_type") } : {}),
    electionYear: normalizedElectionYear,
    ...(getNumber(row, "contributions_amount") !== undefined
      ? { contributionsAmount: getNumber(row, "contributions_amount") }
      : {}),
    ...(getNumber(row, "expenditures_amount") !== undefined
      ? { expendituresAmount: getNumber(row, "expenditures_amount") }
      : {}),
    ...(getNumber(row, "independent_expenditures_for_amount") !== undefined
      ? { independentExpendituresForAmount: getNumber(row, "independent_expenditures_for_amount") }
      : {}),
    ...(getNumber(row, "independent_expenditures_against_amount") !== undefined
      ? { independentExpendituresAgainstAmount: getNumber(row, "independent_expenditures_against_amount") }
      : {}),
    ...(extractUrl(row.url) ? { sourceUrl: extractUrl(row.url) } : {}),
  };
}

const WASHINGTON_PDC_CANDIDATE_SUMMARY_SELECT =
  "filer_id,committee_id,candidacy_id,filer_name,committee_category,political_committee_type,candidate_committee_status,active_candidate,has_reports,office,legislative_district,jurisdiction,jurisdiction_type,position,reporting_option,filing_type,election_year,contributions_amount,expenditures_amount,independent_expenditures_for_amount,independent_expenditures_against_amount,url";

export function buildWashingtonPdcCandidateSummarySearchUrl(input: WashingtonPdcCandidateSummarySearchInput): string {
  const candidateName = normalizeNonEmptyString(input.candidateName, "Washington PDC candidate name");
  const electionYear = normalizeElectionYear(input.electionYear);
  const limit = normalizeLimit(input.limit, 50);
  const where: string[] = [`election_year = ${soqlString(String(electionYear))}`, whereLikeText("filer_name", candidateName)];
  const office = optionalString(input.office);
  const legislativeDistrict = optionalString(input.legislativeDistrict);
  if (office) {
    where.push(whereEqualText("office", office));
  }
  if (legislativeDistrict) {
    where.push(whereEqualText("legislative_district", legislativeDistrict));
  }

  return buildWashingtonPdcDatasetUrl(WASHINGTON_PDC_CAMPAIGN_FINANCE_SUMMARY_DATASET, {
    $select: WASHINGTON_PDC_CANDIDATE_SUMMARY_SELECT,
    $where: where.join(" AND "),
    $order: "contributions_amount DESC, filer_name ASC",
    $limit: limit,
  });
}

export async function searchWashingtonPdcCandidateSummaries(
  input: WashingtonPdcCandidateSummarySearchInput,
  options: WashingtonPdcClientOptions = {}
): Promise<WashingtonPdcCandidateSummary[]> {
  const url = new URL(buildWashingtonPdcCandidateSummarySearchUrl(input));
  const params = Object.fromEntries(url.searchParams.entries());
  const payloadRows = await fetchWashingtonPdcRows(WASHINGTON_PDC_CAMPAIGN_FINANCE_SUMMARY_DATASET, params, options);
  return payloadRows.map(candidateSummaryFromRow).filter((row): row is WashingtonPdcCandidateSummary => row !== null);
}

// Exact summary-row lookup for an already-linked committee: no name/office
// matching involved, so it works for withdrawn candidates and renamed
// committees where the name search would miss.
export function buildWashingtonPdcCandidateSummaryByCommitteeUrl(input: WashingtonPdcCommitteeInput): string {
  const electionYear = normalizeElectionYear(input.electionYear);
  const filerId = optionalIdentifier(input.filerId);
  const committeeId = optionalIdentifier(input.committeeId);
  if (!filerId || !committeeId) {
    throw new WashingtonPdcClientError(
      "invalid_request",
      "Washington PDC filerId and committeeId are both required for a committee summary lookup"
    );
  }
  return buildWashingtonPdcDatasetUrl(WASHINGTON_PDC_CAMPAIGN_FINANCE_SUMMARY_DATASET, {
    $select: WASHINGTON_PDC_CANDIDATE_SUMMARY_SELECT,
    $where: `election_year = ${soqlString(String(electionYear))} AND filer_id = ${soqlString(filerId)} AND committee_id = ${soqlString(committeeId)}`,
    $limit: normalizeLimit(input.limit, 5),
  });
}

export async function getWashingtonPdcCandidateSummariesByCommittee(
  input: WashingtonPdcCommitteeInput,
  options: WashingtonPdcClientOptions = {}
): Promise<WashingtonPdcCandidateSummary[]> {
  const url = new URL(buildWashingtonPdcCandidateSummaryByCommitteeUrl(input));
  const params = Object.fromEntries(url.searchParams.entries());
  const payloadRows = await fetchWashingtonPdcRows(WASHINGTON_PDC_CAMPAIGN_FINANCE_SUMMARY_DATASET, params, options);
  return payloadRows.map(candidateSummaryFromRow).filter((row): row is WashingtonPdcCandidateSummary => row !== null);
}

function committeeWhere(input: WashingtonPdcCommitteeInput): string {
  const electionYear = normalizeElectionYear(input.electionYear);
  const filerId = optionalIdentifier(input.filerId);
  const committeeId = optionalIdentifier(input.committeeId);
  if (!filerId && !committeeId) {
    throw new WashingtonPdcClientError("invalid_request", "Washington PDC filerId or committeeId is required");
  }

  const idPredicate =
    filerId && committeeId
      ? `filer_id = ${soqlString(filerId)} AND committee_id = ${soqlString(committeeId)}`
      : filerId
        ? `filer_id = ${soqlString(filerId)}`
        : `committee_id = ${soqlString(committeeId!)}`;
  return `election_year = ${soqlString(String(electionYear))} AND amount > 0 AND (${idPredicate})`;
}

function aggregateFromRow(row: unknown): WashingtonPdcAggregate | null {
  if (!isRecord(row)) {
    return null;
  }
  const categoryName = getString(row, "category_name", "donor_name");
  const amount = getNumber(row, "amount", "total_amount");
  if (!categoryName || amount === undefined || amount <= 0) {
    return null;
  }
  return {
    categoryName,
    amount,
    count: getNumber(row, "count", "contributor_count", "total_count") ?? 0,
    ...(extractUrl(row.url) || getString(row, "source_url") ? { sourceUrl: extractUrl(row.url) ?? getString(row, "source_url") } : {}),
  };
}

// Grouped occupation rows fetched per committee before the client-side
// whitespace merge. Must exceed any display limit: internal-whitespace
// variants ("NOT  EMPLOYED") merge after the fetch, and slicing to the display
// limit server-side would let a merged variant crowd out a real category
// (verified live: Franz 2024 top-20 lost PHYSICIAN).
export const WASHINGTON_PDC_OCCUPATION_GROUP_FETCH_LIMIT = 500;

export function buildWashingtonPdcDirectOccupationAggregatesUrl(input: WashingtonPdcCommitteeInput): string {
  const limit = normalizeLimit(input.limit, 20);
  // Occupations are free-text: normalize case/whitespace server-side so
  // "Retired"/"RETIRED"/"retired" aggregate as one category, and exclude
  // blank/NULL rows entirely (occupation is only disclosed above the $250
  // aggregate threshold — missing is expected, not a category). total_count
  // counts contribution rows, not distinct donors.
  return buildWashingtonPdcDatasetUrl(WASHINGTON_PDC_CONTRIBUTIONS_DATASET, {
    $select: "upper(trim(contributor_occupation)) as category_name,sum(amount) as total_amount,count(*) as total_count",
    $where: `${committeeWhere(input)} AND contributor_category = 'Individual' AND contributor_occupation IS NOT NULL AND trim(contributor_occupation) != ''`,
    $group: "category_name",
    $order: "total_amount DESC, category_name ASC",
    $limit: Math.max(WASHINGTON_PDC_OCCUPATION_GROUP_FETCH_LIMIT, limit),
  });
}

export async function getWashingtonPdcDirectOccupationAggregates(
  input: WashingtonPdcCommitteeInput,
  options: WashingtonPdcClientOptions = {}
): Promise<WashingtonPdcAggregate[]> {
  const url = new URL(buildWashingtonPdcDirectOccupationAggregatesUrl(input));
  const rows = await fetchWashingtonPdcRows(
    WASHINGTON_PDC_CONTRIBUTIONS_DATASET,
    Object.fromEntries(url.searchParams.entries()),
    options
  );
  // No default category: a row without a name (blank occupation) is dropped
  // rather than surfacing as an "UNKNOWN" bucket. SoQL trim() only strips
  // surrounding whitespace, so internal runs ("NOT  EMPLOYED") come back as
  // separate server-side buckets — collapse and merge them here.
  const merged = new Map<string, WashingtonPdcAggregate>();
  for (const row of rows.map((raw) => aggregateFromRow(raw))) {
    if (!row) {
      continue;
    }
    const categoryName = row.categoryName.replace(/\s+/g, " ");
    const existing = merged.get(categoryName);
    if (!existing) {
      merged.set(categoryName, { ...row, categoryName });
      continue;
    }
    existing.amount = roundCurrency(existing.amount + row.amount);
    existing.count += row.count;
  }
  return [...merged.values()]
    .sort((left, right) => right.amount - left.amount || left.categoryName.localeCompare(right.categoryName))
    .slice(0, normalizeLimit(input.limit, 20));
}

export function buildWashingtonPdcContributionSizeRowsUrl(input: WashingtonPdcCommitteeInput): string {
  return buildWashingtonPdcDatasetUrl(WASHINGTON_PDC_CONTRIBUTIONS_DATASET, {
    $select: "amount",
    $where: committeeWhere(input),
    $order: "amount DESC",
    $limit: normalizePageLimit(undefined),
  });
}

export const buildWashingtonPdcContributionSizeAggregatesUrl = buildWashingtonPdcContributionSizeRowsUrl;

function contributionSizeBucket(amount: number): string {
  if (amount < 100) {
    return "under_100";
  }
  if (amount < 250) {
    return "100_249";
  }
  if (amount < 1_000) {
    return "250_999";
  }
  if (amount < 5_000) {
    return "1000_4999";
  }
  return "5000_plus";
}

function aggregateContributionSizeRows(rows: unknown[], limit: number): WashingtonPdcAggregate[] {
  const buckets = new Map<string, WashingtonPdcAggregate>();
  for (const row of rows) {
    if (!isRecord(row)) {
      continue;
    }
    const amount = getNumber(row, "amount");
    if (amount === undefined || amount <= 0) {
      continue;
    }
    const bucket = contributionSizeBucket(amount);
    const existing = buckets.get(bucket);
    if (existing) {
      existing.amount += amount;
      existing.count += 1;
      continue;
    }
    buckets.set(bucket, { categoryName: bucket, amount, count: 1 });
  }
  return [...buckets.values()]
    .map((bucket) => ({ ...bucket, amount: roundCurrency(bucket.amount) }))
    .sort((left, right) => right.amount - left.amount)
    .slice(0, limit);
}

export async function getWashingtonPdcContributionSizeAggregates(
  input: WashingtonPdcCommitteeInput,
  options: WashingtonPdcClientOptions = {}
): Promise<WashingtonPdcAggregate[]> {
  const url = new URL(buildWashingtonPdcContributionSizeRowsUrl(input));
  const rows = await fetchWashingtonPdcPagedRows(
    WASHINGTON_PDC_CONTRIBUTIONS_DATASET,
    Object.fromEntries(url.searchParams.entries()),
    options
  );
  return aggregateContributionSizeRows(rows, normalizeLimit(input.limit, 10));
}

// All three C6 report types are additive components of PDC's own per-candidate
// IE totals (verified against the summary dataset's
// independent_expenditures_for_amount/_against_amount, Wilson/Harrell 2025).
const WASHINGTON_PDC_INDEPENDENT_EXPENDITURE_REPORT_TYPES =
  "report_type in('Independent Expenditure','Independent Expenditure Ad','Electioneering Communication')";

export function buildWashingtonPdcIndependentExpenditureGroupsUrl(
  input: WashingtonPdcIndependentSpendingGroupInput
): string {
  const candidateName = normalizeNonEmptyString(input.candidateName, "Washington PDC candidate name");
  const electionYear = normalizeElectionYear(input.electionYear);
  const where = [
    `election_year = ${soqlString(String(electionYear))}`,
    "portion_of_amount > 0",
    "for_or_against in('For','Against')",
    WASHINGTON_PDC_INDEPENDENT_EXPENDITURE_REPORT_TYPES,
  ];
  const candidateFilerId = optionalIdentifier(input.candidateFilerId);
  const candidateCommitteeId = optionalIdentifier(input.candidateCommitteeId);
  if (candidateFilerId && candidateCommitteeId) {
    where.push(`candidate_filer_id = ${soqlString(candidateFilerId)}`);
    where.push(`candidate_committee_id = ${soqlString(candidateCommitteeId)}`);
  } else {
    where.push(whereLikeText("candidate_name", candidateName));
    const office = optionalString(input.office);
    const legislativeDistrict = optionalString(input.legislativeDistrict);
    if (office) {
      where.push(whereEqualText("candidate_office", office));
    }
    if (legislativeDistrict) {
      where.push(whereEqualText("candidate_jurisdiction", legislativeDistrict));
    }
  }

  return buildWashingtonPdcDatasetUrl(WASHINGTON_PDC_INDEPENDENT_EXPENDITURES_DATASET, {
    $select: "candidate_name,sponsor_id,sponsor_name,for_or_against,report_type,portion_of_amount,url",
    $where: where.join(" AND "),
    $order: "portion_of_amount DESC, sponsor_name ASC",
    $limit: normalizePageLimit(undefined),
  });
}

function aggregateIndependentSpendingRows(
  rows: unknown[],
  limit: number,
  // null = rows were already filtered by hard candidate IDs; casing variants of
  // the candidate name in C6 filings must not drop rows in that mode.
  candidateName: string | null
): WashingtonPdcIndependentSpendingGroup[] {
  const groups = new Map<string, WashingtonPdcIndependentSpendingGroup>();
  const expectedCandidateName = candidateName === null ? null : normalizePdcPersonName(candidateName);
  for (const row of rows) {
    if (!isRecord(row)) {
      continue;
    }
    if (
      expectedCandidateName !== null &&
      normalizePdcPersonName(getString(row, "candidate_name")) !== expectedCandidateName
    ) {
      continue;
    }
    const sponsorId = getString(row, "sponsor_id");
    const sponsorName = getString(row, "sponsor_name");
    const supportOppose = supportOpposeFromPdc(getString(row, "for_or_against"));
    const amount = getNumber(row, "portion_of_amount");
    if (!sponsorId || !sponsorName || !supportOppose || amount === undefined || amount <= 0) {
      continue;
    }

    const key = `${sponsorId}\u0000${supportOppose}`;
    const existing = groups.get(key);
    if (existing) {
      existing.amount += amount;
      existing.expenditureCount += 1;
      continue;
    }
    groups.set(key, {
      sponsorId,
      sponsorName,
      supportOppose,
      amount,
      expenditureCount: 1,
      ...(extractUrl(row.url) ? { sourceUrl: extractUrl(row.url) } : {}),
    });
  }
  return [...groups.values()]
    .map((group) => ({ ...group, amount: roundCurrency(group.amount) }))
    .sort((left, right) => right.amount - left.amount)
    .slice(0, limit);
}

export async function getWashingtonPdcIndependentExpenditureGroups(
  input: WashingtonPdcIndependentSpendingGroupInput,
  options: WashingtonPdcClientOptions = {}
): Promise<WashingtonPdcIndependentSpendingGroup[]> {
  const url = new URL(buildWashingtonPdcIndependentExpenditureGroupsUrl(input));
  const rows = await fetchWashingtonPdcPagedRows(
    WASHINGTON_PDC_INDEPENDENT_EXPENDITURES_DATASET,
    Object.fromEntries(url.searchParams.entries()),
    options
  );
  const hardIdMode =
    optionalIdentifier(input.candidateFilerId) !== undefined &&
    optionalIdentifier(input.candidateCommitteeId) !== undefined;
  return aggregateIndependentSpendingRows(rows, normalizeLimit(input.limit, 20), hardIdMode ? null : input.candidateName);
}

export function buildWashingtonPdcSponsorSummarySearchUrl(input: WashingtonPdcSponsorSummaryInput): string {
  const sponsorName = normalizeNonEmptyString(input.sponsorName, "Washington PDC sponsor name");
  const electionYear = normalizeElectionYear(input.electionYear);
  return buildWashingtonPdcDatasetUrl(WASHINGTON_PDC_CAMPAIGN_FINANCE_SUMMARY_DATASET, {
    $select: WASHINGTON_PDC_CANDIDATE_SUMMARY_SELECT,
    $where: `election_year = ${soqlString(String(electionYear))} AND ${whereEqualText("filer_name", sponsorName)}`,
    $order: "contributions_amount DESC, filer_name ASC",
    $limit: normalizeLimit(input.limit, 20),
  });
}

export async function getWashingtonPdcSponsorSummaryByName(
  input: WashingtonPdcSponsorSummaryInput,
  options: WashingtonPdcClientOptions = {}
): Promise<WashingtonPdcCandidateSummary[]> {
  const url = new URL(buildWashingtonPdcSponsorSummarySearchUrl(input));
  const rows = await fetchWashingtonPdcRows(
    WASHINGTON_PDC_CAMPAIGN_FINANCE_SUMMARY_DATASET,
    Object.fromEntries(url.searchParams.entries()),
    options
  );
  return rows.map(candidateSummaryFromRow).filter((row): row is WashingtonPdcCandidateSummary => row !== null);
}

export function buildWashingtonPdcSponsorOrganizationFundersUrl(input: WashingtonPdcCommitteeInput): string {
  return buildWashingtonPdcDatasetUrl(WASHINGTON_PDC_CONTRIBUTIONS_DATASET, {
    $select: "contributor_name,amount,url",
    $where: `${committeeWhere(input)} AND contributor_category = 'Organization'`,
    $order: "amount DESC, contributor_name ASC",
    $limit: normalizePageLimit(undefined),
  });
}

// An undefined limit returns every aggregated funder: callers that rebuild
// industry totals from these rows must not lose the tail.
function aggregateSponsorFunders(rows: unknown[], limit: number | undefined): WashingtonPdcAggregate[] {
  const funders = new Map<string, WashingtonPdcAggregate>();
  for (const row of rows) {
    if (!isRecord(row)) {
      continue;
    }
    const donorName = getString(row, "contributor_name");
    const amount = getNumber(row, "amount");
    if (!donorName || amount === undefined || amount <= 0) {
      continue;
    }
    const key = donorName.toUpperCase().replace(/\s+/g, " ").trim();
    const existing = funders.get(key);
    if (existing) {
      existing.amount += amount;
      existing.count += 1;
      continue;
    }
    funders.set(key, {
      categoryName: donorName,
      amount,
      count: 1,
      ...(extractUrl(row.url) ? { sourceUrl: extractUrl(row.url) } : {}),
    });
  }
  const aggregates = [...funders.values()]
    .map((funder) => ({ ...funder, amount: roundCurrency(funder.amount) }))
    .sort((left, right) => right.amount - left.amount);
  return limit === undefined ? aggregates : aggregates.slice(0, limit);
}

export async function getWashingtonPdcSponsorOrganizationFunders(
  input: WashingtonPdcCommitteeInput,
  options: WashingtonPdcClientOptions = {}
): Promise<WashingtonPdcAggregate[]> {
  const url = new URL(buildWashingtonPdcSponsorOrganizationFundersUrl(input));
  const rows = await fetchWashingtonPdcPagedRows(
    WASHINGTON_PDC_CONTRIBUTIONS_DATASET,
    Object.fromEntries(url.searchParams.entries()),
    options
  );
  return aggregateSponsorFunders(rows, input.limit === undefined ? undefined : normalizeLimit(input.limit, 20));
}
