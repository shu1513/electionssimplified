import { personNamesMatchWithMiddleEvidence } from "../finance/personNameMiddleEvidence.js";

export const HAWAII_CSC_DATA_BASE_URL = "https://hicscdata.hawaii.gov/resource";
export const HAWAII_CSC_CANDIDATE_CONTRIBUTIONS_DATASET = "jexd-xbcg";
export const HAWAII_CSC_NONCANDIDATE_CONTRIBUTIONS_DATASET = "rajm-32md";
export const HAWAII_CSC_NONCANDIDATE_EXPENDITURES_DATASET = "riiu-7d4b";
export const HAWAII_CSC_DEFAULT_TIMEOUT_MS = 30_000;
export const HAWAII_CSC_DEFAULT_PAGE_LIMIT = 5_000;
export const HAWAII_CSC_MAX_PAGE_LIMIT = 50_000;
export const HAWAII_CSC_DEFAULT_MAX_PAGES = 50;

export type HawaiiCscClientErrorCode = "invalid_request" | "network_error" | "http_error" | "bad_response";

export class HawaiiCscClientError extends Error {
  constructor(
    public readonly code: HawaiiCscClientErrorCode,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "HawaiiCscClientError";
  }
}

export type HawaiiCscClientOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  appToken?: string;
  pageLimit?: number;
  maxPages?: number;
};

export type HawaiiCscCandidateCommitteeSummary = {
  candidateName: string;
  committeeId: string;
  electionPeriod: string;
  office?: string;
  district?: string;
  county?: string;
  party?: string;
  totalAmount: number;
  contributionCount: number;
};

export type HawaiiCscCandidateCommitteeSearchInput = {
  candidateName: string;
  electionYear: number;
  office?: string | null;
  district?: string | null;
  limit?: number;
};

export type HawaiiCscCandidateCommitteeInput = {
  committeeId: string;
  electionPeriod: string;
  limit?: number;
};

export type HawaiiCscAggregate = {
  categoryName: string;
  amount: number;
  count: number;
};

export type HawaiiCscIndependentSpendingGroup = {
  committeeId: string;
  committeeName: string;
  supportOppose: "support" | "oppose";
  amount: number;
  expenditureCount: number;
  electionPeriod: string;
};

export type HawaiiCscIndependentSpendingGroupInput = {
  candidateName: string;
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
    throw new HawaiiCscClientError("invalid_request", `${fieldName} is required`);
  }
  return normalized;
}

function optionalString(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().replace(/\s+/g, " ");
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new HawaiiCscClientError("invalid_request", `Invalid Hawaii CSC election year: ${value}`);
  }
  return value;
}

function normalizeLimit(value: number | undefined, defaultValue: number): number {
  const normalized = value ?? defaultValue;
  if (!Number.isInteger(normalized) || normalized <= 0 || normalized > HAWAII_CSC_MAX_PAGE_LIMIT) {
    throw new HawaiiCscClientError(
      "invalid_request",
      `Hawaii CSC limit must be an integer between 1 and ${HAWAII_CSC_MAX_PAGE_LIMIT}`
    );
  }
  return normalized;
}

function normalizePageLimit(value: number | undefined): number {
  return normalizeLimit(value, HAWAII_CSC_DEFAULT_PAGE_LIMIT);
}

function normalizeMaxPages(value: number | undefined): number {
  const normalized = value ?? HAWAII_CSC_DEFAULT_MAX_PAGES;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new HawaiiCscClientError("invalid_request", "Hawaii CSC maxPages must be a positive integer");
  }
  return normalized;
}

function soqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function soqlLikeContains(value: string): string {
  return soqlString(`%${value.toLowerCase().replace(/[%_]/g, "")}%`);
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

function normalizePersonName(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[*]/g, " ")
    // Apostrophes and the okina stay inside the name ("Pa'ele" -> PAELE).
    .replace(/['\u2018\u2019\u02bb`]/g, "")
    .replace(/[^a-zA-Z0-9,]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

export function normalizeHawaiiCscPersonNameKeys(value: string | null | undefined): Set<string> {
  const normalized = normalizePersonName(value ?? undefined);
  const keys = new Set<string>();
  const plain = normalized.replace(/,/g, " ").replace(/\s+/g, " ").trim();
  if (plain) {
    keys.add(plain);
  }
  const commaParts = normalized.split(",").map((part) => part.trim()).filter(Boolean);
  if (commaParts.length >= 2) {
    const [last, ...rest] = commaParts;
    const first = rest.join(" ").replace(/\s+/g, " ").trim();
    if (first && last) {
      keys.add(`${first} ${last}`.replace(/\s+/g, " ").trim());
    }
  }
  return keys;
}

// Suffix-stripping normalizer for the middle-evidence gate. Bare "V" stays:
// it is a middle initial, not a suffix (GENERATIONAL_SUFFIX_RANK in
// finance/personNameMiddleEvidence.ts).
function normalizePersonNameForMiddleEvidence(value: string): string {
  return normalizePersonName(value)
    .replace(/,/g, " ")
    .replace(/\b(JR|SR|II|III|IV)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The key sets above carry no first+last collapse, so "John Smith" never keys
// to a committee-entered "Smith, John B." (nor "John B. Smith" to "Smith, John").
// After the exact-key miss, fall back to first+last alignment under the middle
// gate (colorado pattern) — a contradicting middle still rejects the row.
function expenditureRowNamesCandidate(input: {
  candidateName: string;
  candidateNameKeys: ReadonlySet<string>;
  rowCandidateName: string | undefined;
}): boolean {
  const rowKeys = normalizeHawaiiCscPersonNameKeys(input.rowCandidateName);
  if ([...rowKeys].some((key) => input.candidateNameKeys.has(key))) {
    return true;
  }
  if (!input.rowCandidateName) {
    return false;
  }
  return personNamesMatchWithMiddleEvidence({
    candidateName: input.candidateName,
    rowNames: [input.rowCandidateName],
    normalizePersonName: normalizePersonNameForMiddleEvidence,
  });
}

function candidateSearchToken(candidateName: string): string {
  const normalized = normalizeNonEmptyString(candidateName, "Hawaii CSC candidate name");
  const commaParts = normalized.split(",").map((part) => part.trim()).filter(Boolean);
  const tokenSource = commaParts.length > 1 ? commaParts[0] : normalized.split(/\s+/).at(-1);
  const token = tokenSource?.replace(/[^a-zA-Z0-9'-]/g, "").trim();
  if (!token) {
    throw new HawaiiCscClientError("invalid_request", "Hawaii CSC candidate name must include a searchable token");
  }
  return token;
}

function supportOpposeFromCsc(value: string | undefined): "support" | "oppose" | null {
  const normalized = value?.trim().toUpperCase();
  if (normalized === "SUPPORT" || normalized === "FOR") {
    return "support";
  }
  if (normalized === "OPPOSE" || normalized === "AGAINST") {
    return "oppose";
  }
  return null;
}

function isNonMonetaryNoPredicate(fieldName: string): string {
  return `(${fieldName} IS NULL OR upper(${fieldName}) = 'N' OR upper(${fieldName}) = 'NO')`;
}

function isOrganizationContributorType(value: string | undefined): boolean {
  const normalized = value?.trim().toUpperCase();
  if (!normalized) {
    return false;
  }
  if (["INDIVIDUAL", "CANDIDATE", "IMMEDIATE FAMILY"].includes(normalized)) {
    return false;
  }
  return true;
}

export function buildHawaiiCscDatasetUrl(
  datasetId: string,
  params: Record<string, string | number | undefined>
): string {
  if (!/^[a-z0-9]{4}-[a-z0-9]{4}$/i.test(datasetId)) {
    throw new HawaiiCscClientError("invalid_request", `Invalid Hawaii CSC dataset ID: ${datasetId}`);
  }

  const url = new URL(`${HAWAII_CSC_DATA_BASE_URL}/${datasetId}.json`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function fetchHawaiiCscJson(url: string, options: HawaiiCscClientOptions): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? HAWAII_CSC_DEFAULT_TIMEOUT_MS;
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
      throw new HawaiiCscClientError("network_error", `Hawaii CSC request timed out after ${timeoutMs}ms for ${url}`);
    }
    throw new HawaiiCscClientError(
      "network_error",
      `Hawaii CSC request failed for ${url}: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new HawaiiCscClientError(
      "http_error",
      `Hawaii CSC request failed: ${response.status} ${response.statusText}`,
      response.status
    );
  }

  try {
    return await response.json();
  } catch (error) {
    throw new HawaiiCscClientError(
      "bad_response",
      `Hawaii CSC response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function fetchHawaiiCscRows<T = Record<string, unknown>>(
  datasetId: string,
  params: Record<string, string | number | undefined>,
  options: HawaiiCscClientOptions = {}
): Promise<T[]> {
  const payload = await fetchHawaiiCscJson(buildHawaiiCscDatasetUrl(datasetId, params), options);
  if (!Array.isArray(payload)) {
    throw new HawaiiCscClientError("bad_response", "Hawaii CSC response is missing result array");
  }
  return payload as T[];
}

async function fetchHawaiiCscPagedRows<T = Record<string, unknown>>(
  datasetId: string,
  params: Record<string, string | number | undefined>,
  options: HawaiiCscClientOptions = {}
): Promise<T[]> {
  const limit = normalizePageLimit(options.pageLimit);
  const maxPages = normalizeMaxPages(options.maxPages);
  const rows: T[] = [];
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await fetchHawaiiCscRows<T>(
      datasetId,
      {
        ...params,
        $limit: limit,
        $offset: pageIndex * limit,
      },
      options
    );
    rows.push(...page);
    if (page.length < limit) {
      return rows;
    }
  }
  throw new HawaiiCscClientError(
    "bad_response",
    `Hawaii CSC paged query exceeded ${maxPages} pages for dataset ${datasetId}`
  );
}

function candidateCommitteeSummaryFromRow(row: unknown): HawaiiCscCandidateCommitteeSummary | null {
  if (!isRecord(row)) {
    return null;
  }
  const candidateName = getString(row, "candidate_name");
  const committeeId = getString(row, "reg_no");
  const electionPeriod = getString(row, "election_period");
  const totalAmount = getNumber(row, "total_amount", "amount");
  if (!candidateName || !committeeId || !electionPeriod || totalAmount === undefined || totalAmount < 0) {
    return null;
  }
  return {
    candidateName,
    committeeId,
    electionPeriod,
    ...(getString(row, "office") ? { office: getString(row, "office") } : {}),
    ...(getString(row, "district") ? { district: getString(row, "district") } : {}),
    ...(getString(row, "county") ? { county: getString(row, "county") } : {}),
    ...(getString(row, "party") ? { party: getString(row, "party") } : {}),
    totalAmount,
    contributionCount: getNumber(row, "total_count", "count") ?? 0,
  };
}

export function buildHawaiiCscCandidateCommitteeSearchUrl(input: HawaiiCscCandidateCommitteeSearchInput): string {
  const electionYear = normalizeElectionYear(input.electionYear);
  const where = [
    `election_period like ${soqlLikeContains(String(electionYear))}`,
    whereLikeText("candidate_name", candidateSearchToken(input.candidateName)),
    "amount > 0",
  ];
  const office = optionalString(input.office);
  const district = optionalString(input.district);
  if (office) {
    where.push(whereEqualText("office", office));
  }
  if (district) {
    // Current-cycle CSC rows mostly leave district blank (2024-2026 House:
    // 9 of ~6,000 rows carry one), so a strict district filter returned
    // nothing for every 2026 legislator. Blank-district rows come back too;
    // the resolver still rejects rows whose district disagrees.
    where.push(`(${whereEqualText("district", district)} OR district IS NULL)`);
  }

  return buildHawaiiCscDatasetUrl(HAWAII_CSC_CANDIDATE_CONTRIBUTIONS_DATASET, {
    $select:
      "candidate_name,office,district,county,party,reg_no,election_period,sum(amount) as total_amount,count(*) as total_count",
    $where: where.join(" AND "),
    $group: "candidate_name,office,district,county,party,reg_no,election_period",
    $order: "total_amount DESC, candidate_name ASC",
    $limit: normalizeLimit(input.limit, 50),
  });
}

export async function searchHawaiiCscCandidateCommittees(
  input: HawaiiCscCandidateCommitteeSearchInput,
  options: HawaiiCscClientOptions = {}
): Promise<HawaiiCscCandidateCommitteeSummary[]> {
  const url = new URL(buildHawaiiCscCandidateCommitteeSearchUrl(input));
  const rows = await fetchHawaiiCscRows(
    HAWAII_CSC_CANDIDATE_CONTRIBUTIONS_DATASET,
    Object.fromEntries(url.searchParams.entries()),
    options
  );
  return rows.map(candidateCommitteeSummaryFromRow).filter((row): row is HawaiiCscCandidateCommitteeSummary => row !== null);
}

function committeeWhere(input: HawaiiCscCandidateCommitteeInput): string {
  const committeeId = normalizeNonEmptyString(input.committeeId, "Hawaii CSC committee id");
  const electionPeriod = normalizeNonEmptyString(input.electionPeriod, "Hawaii CSC election period");
  return `reg_no = ${soqlString(committeeId)} AND election_period = ${soqlString(electionPeriod)} AND amount > 0`;
}

function aggregateFromRow(row: unknown, defaultCategoryName?: string): HawaiiCscAggregate | null {
  if (!isRecord(row)) {
    return null;
  }
  const categoryName = getString(row, "category_name", "donor_name") ?? defaultCategoryName;
  const amount = getNumber(row, "amount", "total_amount");
  if (!categoryName || amount === undefined || amount <= 0) {
    return null;
  }
  return {
    categoryName,
    amount,
    count: getNumber(row, "count", "total_count") ?? 0,
  };
}

export function buildHawaiiCscDirectOccupationAggregatesUrl(input: HawaiiCscCandidateCommitteeInput): string {
  return buildHawaiiCscDatasetUrl(HAWAII_CSC_CANDIDATE_CONTRIBUTIONS_DATASET, {
    $select: "occupation as category_name,sum(amount) as total_amount,count(*) as total_count",
    $where: `${committeeWhere(input)} AND occupation IS NOT NULL AND occupation != '' AND ${isNonMonetaryNoPredicate("non_monetary_yes_or_no")}`,
    $group: "occupation",
    $order: "total_amount DESC, category_name ASC",
    $limit: normalizeLimit(input.limit, 20),
  });
}

export async function getHawaiiCscDirectOccupationAggregates(
  input: HawaiiCscCandidateCommitteeInput,
  options: HawaiiCscClientOptions = {}
): Promise<HawaiiCscAggregate[]> {
  const url = new URL(buildHawaiiCscDirectOccupationAggregatesUrl(input));
  const rows = await fetchHawaiiCscRows(
    HAWAII_CSC_CANDIDATE_CONTRIBUTIONS_DATASET,
    Object.fromEntries(url.searchParams.entries()),
    options
  );
  return rows.map((row) => aggregateFromRow(row)).filter((row): row is HawaiiCscAggregate => row !== null);
}

export function buildHawaiiCscContributionSizeRowsUrl(input: HawaiiCscCandidateCommitteeInput): string {
  return buildHawaiiCscDatasetUrl(HAWAII_CSC_CANDIDATE_CONTRIBUTIONS_DATASET, {
    $select: "amount",
    $where: `${committeeWhere(input)} AND ${isNonMonetaryNoPredicate("non_monetary_yes_or_no")}`,
    $order: "amount DESC, :id ASC",
    $limit: normalizePageLimit(undefined),
  });
}

export const buildHawaiiCscContributionSizeAggregatesUrl = buildHawaiiCscContributionSizeRowsUrl;

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

function aggregateContributionSizeRows(rows: unknown[], limit: number): HawaiiCscAggregate[] {
  const buckets = new Map<string, HawaiiCscAggregate>();
  for (const row of rows) {
    if (!isRecord(row)) {
      continue;
    }
    const amount = getNumber(row, "amount");
    if (amount === undefined || amount <= 0) {
      continue;
    }
    const categoryName = contributionSizeBucket(amount);
    const existing = buckets.get(categoryName);
    if (existing) {
      existing.amount += amount;
      existing.count += 1;
      continue;
    }
    buckets.set(categoryName, { categoryName, amount, count: 1 });
  }
  return [...buckets.values()]
    .map((bucket) => ({ ...bucket, amount: roundCurrency(bucket.amount) }))
    .sort((left, right) => right.amount - left.amount)
    .slice(0, limit);
}

export async function getHawaiiCscContributionSizeAggregates(
  input: HawaiiCscCandidateCommitteeInput,
  options: HawaiiCscClientOptions = {}
): Promise<HawaiiCscAggregate[]> {
  const url = new URL(buildHawaiiCscContributionSizeRowsUrl(input));
  const rows = await fetchHawaiiCscPagedRows(
    HAWAII_CSC_CANDIDATE_CONTRIBUTIONS_DATASET,
    Object.fromEntries(url.searchParams.entries()),
    options
  );
  return aggregateContributionSizeRows(rows, normalizeLimit(input.limit, 10));
}

export function buildHawaiiCscIndependentExpenditureGroupsUrl(input: HawaiiCscIndependentSpendingGroupInput): string {
  const electionYear = normalizeElectionYear(input.electionYear);
  const where = [
    `election_period like ${soqlLikeContains(String(electionYear))}`,
    whereLikeText("candidate_name_s", candidateSearchToken(input.candidateName)),
    "amount > 0",
    "upper(independent_expenditure) = 'Y'",
    "support_oppose in('Support','Oppose')",
  ];

  return buildHawaiiCscDatasetUrl(HAWAII_CSC_NONCANDIDATE_EXPENDITURES_DATASET, {
    $select: "noncandidate_committee_name,reg_no,election_period,candidate_name_s,support_oppose,independent_expenditure,amount",
    $where: where.join(" AND "),
    $order: "amount DESC, noncandidate_committee_name ASC, :id ASC",
    $limit: normalizePageLimit(undefined),
  });
}

function hasMultipleCandidateNames(value: string | undefined): boolean {
  const normalized = value?.trim();
  if (!normalized) {
    return false;
  }
  return /\s+(?:AND|&|\/|;)\s+/i.test(normalized) || normalized.split(/\n|\r/).filter((part) => part.trim()).length > 1;
}

function aggregateIndependentExpenditureRows(
  rows: unknown[],
  limit: number,
  candidateName: string
): HawaiiCscIndependentSpendingGroup[] {
  const expectedCandidateKeys = normalizeHawaiiCscPersonNameKeys(candidateName);
  const groups = new Map<string, HawaiiCscIndependentSpendingGroup>();
  for (const row of rows) {
    if (!isRecord(row)) {
      continue;
    }
    const candidateNameValue = getString(row, "candidate_name_s");
    if (hasMultipleCandidateNames(candidateNameValue)) {
      continue;
    }
    if (
      !expenditureRowNamesCandidate({
        candidateName,
        candidateNameKeys: expectedCandidateKeys,
        rowCandidateName: candidateNameValue,
      })
    ) {
      continue;
    }
    const committeeId = getString(row, "reg_no");
    const committeeName = getString(row, "noncandidate_committee_name");
    const electionPeriod = getString(row, "election_period");
    const supportOppose = supportOpposeFromCsc(getString(row, "support_oppose"));
    const amount = getNumber(row, "amount");
    if (!committeeId || !committeeName || !electionPeriod || !supportOppose || amount === undefined || amount <= 0) {
      continue;
    }
    const key = `${committeeId}\u0000${electionPeriod}\u0000${supportOppose}`;
    const existing = groups.get(key);
    if (existing) {
      existing.amount += amount;
      existing.expenditureCount += 1;
      continue;
    }
    groups.set(key, {
      committeeId,
      committeeName,
      supportOppose,
      amount,
      expenditureCount: 1,
      electionPeriod,
    });
  }
  return [...groups.values()]
    .map((group) => ({ ...group, amount: roundCurrency(group.amount) }))
    .sort((left, right) => right.amount - left.amount)
    .slice(0, limit);
}

export async function getHawaiiCscIndependentExpenditureGroups(
  input: HawaiiCscIndependentSpendingGroupInput,
  options: HawaiiCscClientOptions = {}
): Promise<HawaiiCscIndependentSpendingGroup[]> {
  const url = new URL(buildHawaiiCscIndependentExpenditureGroupsUrl(input));
  const rows = await fetchHawaiiCscPagedRows(
    HAWAII_CSC_NONCANDIDATE_EXPENDITURES_DATASET,
    Object.fromEntries(url.searchParams.entries()),
    options
  );
  return aggregateIndependentExpenditureRows(rows, normalizeLimit(input.limit, 20), input.candidateName);
}

export function buildHawaiiCscNoncandidateCommitteeFundersUrl(input: HawaiiCscCandidateCommitteeInput): string {
  return buildHawaiiCscDatasetUrl(HAWAII_CSC_NONCANDIDATE_CONTRIBUTIONS_DATASET, {
    $select: "contributor_type,contributor_name,amount",
    $where: `${committeeWhere(input)} AND ${isNonMonetaryNoPredicate("non_monetary_yes_or_no")}`,
    $order: "amount DESC, contributor_name ASC, :id ASC",
    $limit: normalizePageLimit(undefined),
  });
}

// An undefined limit returns every aggregated funder: callers that rebuild
// industry totals from these rows must not lose the tail.
function aggregateNoncandidateCommitteeFunders(rows: unknown[], limit: number | undefined): HawaiiCscAggregate[] {
  const funders = new Map<string, HawaiiCscAggregate>();
  for (const row of rows) {
    if (!isRecord(row) || !isOrganizationContributorType(getString(row, "contributor_type"))) {
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
    funders.set(key, { categoryName: donorName, amount, count: 1 });
  }
  const aggregates = [...funders.values()]
    .map((funder) => ({ ...funder, amount: roundCurrency(funder.amount) }))
    .sort((left, right) => right.amount - left.amount);
  return limit === undefined ? aggregates : aggregates.slice(0, limit);
}

export async function getHawaiiCscNoncandidateCommitteeFunders(
  input: HawaiiCscCandidateCommitteeInput,
  options: HawaiiCscClientOptions = {}
): Promise<HawaiiCscAggregate[]> {
  const url = new URL(buildHawaiiCscNoncandidateCommitteeFundersUrl(input));
  const rows = await fetchHawaiiCscPagedRows(
    HAWAII_CSC_NONCANDIDATE_CONTRIBUTIONS_DATASET,
    Object.fromEntries(url.searchParams.entries()),
    options
  );
  return aggregateNoncandidateCommitteeFunders(
    rows,
    input.limit === undefined ? undefined : normalizeLimit(input.limit, 20)
  );
}
