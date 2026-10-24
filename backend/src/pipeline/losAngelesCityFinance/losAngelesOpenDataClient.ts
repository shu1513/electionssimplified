export const LOS_ANGELES_OPEN_DATA_BASE_URL =
  "https://data.lacity.org/resource";
export const LOS_ANGELES_CONTRIBUTIONS_DATASET_ID = "m6g2-gc6c";
export const LOS_ANGELES_CONTRIBUTIONS_SOURCE_URL =
  "https://data.lacity.org/Administration-Finance/City-Campaign-Contributions-and-Misc-Increases-to-/m6g2-gc6c";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PAGE_LIMIT = 1_000;
const DEFAULT_MAX_PAGES = 100;

export type LosAngelesOpenDataClientOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  appToken?: string;
  pageLimit?: number;
  maxPages?: number;
  retryCount?: number;
};

export type LosAngelesContributionRecord = {
  /** Native publication-row identity; not an invented transaction hash. */
  sourceRowId?: string | null;
  periodBeginDate?: string | null;
  memo?: string | null;
  contributionDate: string | null;
  contributorName: string;
  occupation: string | null;
  employer: string | null;
  committeeName: string;
  committeeId: string;
  candidateName: string | null;
  seatDescription: string | null;
  contributionType: string | null;
  amount: number;
  amountPaidOrForgiven: number;
  schedule: string;
  periodEndDate: string | null;
  electionDate: string | null;
};

export function defaultLosAngelesOpenDataClientOptions(): LosAngelesOpenDataClientOptions {
  const appToken = process.env.LOS_ANGELES_OPEN_DATA_APP_TOKEN?.trim();
  return appToken ? { appToken } : {};
}

function soqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result <= 0) {
    throw new Error(`Invalid Los Angeles Open Data ${label}: ${value}`);
  }
  return result;
}

function stringValue(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value.trim() : "";
}

function nullableString(
  row: Record<string, unknown>,
  key: string,
): string | null {
  return stringValue(row, key) || null;
}

function amountValue(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const parsed =
    typeof value === "number"
      ? value
      : Number(String(value ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function mapContribution(
  row: Record<string, unknown>,
): LosAngelesContributionRecord | null {
  const committeeId = stringValue(row, "cmt_id");
  const committeeName = stringValue(row, "cmt_nm");
  const schedule = stringValue(row, "schedule").toUpperCase();
  const amount = amountValue(row, "con_amount");
  const rawPaid = row.con_amount_pd_forgiven;
  const paid = rawPaid === undefined || rawPaid === null || String(rawPaid).trim() === "" ? 0 : amountValue(row, "con_amount_pd_forgiven");
  if (
    !/^\d{4,12}$/.test(committeeId) ||
    !committeeName ||
    !schedule ||
    amount === null || paid === null
  ) {
    return null;
  }
  return {
    sourceRowId: nullableString(row, "source_row_id"),
    periodBeginDate: nullableString(row, "per_beg_date"),
    memo: nullableString(row, "memo"),
    contributionDate: nullableString(row, "con_date"),
    contributorName: stringValue(row, "con_name"),
    occupation: nullableString(row, "con_occp"),
    employer: nullableString(row, "con_empr"),
    committeeName,
    committeeId,
    candidateName: nullableString(row, "cand_name"),
    seatDescription: nullableString(row, "seat_desc"),
    contributionType: nullableString(row, "con_type"),
    amount,
    amountPaidOrForgiven: paid,
    schedule,
    periodEndDate: nullableString(row, "per_end_date"),
    electionDate: nullableString(row, "election_date"),
  };
}

async function fetchPage(
  url: string,
  options: LosAngelesOpenDataClientOptions,
): Promise<Record<string, unknown>[]> {
  const retries = options.retryCount ?? 2;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = new Headers({ accept: "application/json" });
    if (options.appToken?.trim())
      headers.set("X-App-Token", options.appToken.trim());
    try {
      const response = await (options.fetchImpl ?? fetch)(url, {
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        if (
          (response.status === 429 || response.status >= 500) &&
          attempt < retries
        )
          continue;
        throw new Error(
          `Los Angeles Open Data request failed: ${response.status} ${response.statusText}`,
        );
      }
      const payload: unknown = await response.json();
      if (!Array.isArray(payload))
        throw new Error("Los Angeles Open Data response is not an array");
      if (payload.some(row => typeof row !== "object" || row === null || Array.isArray(row)))
        throw new Error("Los Angeles Open Data page contains an invalid record");
      return payload as Record<string, unknown>[];
    } catch (error) {
      if (
        attempt < retries &&
        (error instanceof TypeError ||
          (error instanceof Error && error.name === "AbortError"))
      )
        continue;
      if (error instanceof Error && error.name === "AbortError")
        throw new Error(
          `Los Angeles Open Data request timed out after ${timeoutMs}ms`,
        );
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Los Angeles Open Data request exhausted retries");
}

export async function getLosAngelesCommitteeContributions(
  input: { committeeId: string; electionYear: number },
  options: LosAngelesOpenDataClientOptions = {},
): Promise<LosAngelesContributionRecord[]> {
  const committeeId = input.committeeId.trim();
  if (!/^\d{4,12}$/.test(committeeId))
    throw new Error(
      `Invalid Los Angeles FPPC committee id: ${input.committeeId}`,
    );
  if (
    !Number.isInteger(input.electionYear) ||
    input.electionYear < 2000 ||
    input.electionYear > 2100
  )
    throw new Error(`Invalid Los Angeles election year: ${input.electionYear}`);
  const pageLimit = positiveInteger(
    options.pageLimit,
    DEFAULT_PAGE_LIMIT,
    "pageLimit",
  );
  const maxPages = positiveInteger(
    options.maxPages,
    DEFAULT_MAX_PAGES,
    "maxPages",
  );
  const results: LosAngelesContributionRecord[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(
      `${LOS_ANGELES_OPEN_DATA_BASE_URL}/${LOS_ANGELES_CONTRIBUTIONS_DATASET_ID}.json`,
    );
    url.searchParams.set(
      "$where",
      `cmt_id=${soqlString(committeeId)} AND election_date>=${soqlString(`${input.electionYear}-01-01T00:00:00.000`)} AND election_date<${soqlString(`${input.electionYear + 1}-01-01T00:00:00.000`)}`,
    );
    url.searchParams.set("$select", "*, :id as source_row_id");
    url.searchParams.set("$order", "con_date,cmt_id,con_name,con_amount,:id");
    url.searchParams.set("$limit", String(pageLimit));
    url.searchParams.set("$offset", String(page * pageLimit));
    const rows = await fetchPage(url.toString(), options);
    for (const raw of rows) {
      const row = mapContribution(raw);
      if (!row || row.committeeId !== committeeId || !row.sourceRowId || seen.has(row.sourceRowId))
        throw new Error("Los Angeles Open Data has an invalid, foreign or duplicate publication row");
      seen.add(row.sourceRowId);
      results.push(row);
    }
    if (rows.length < pageLimit) {
      const sourceElectionDates = new Set(
        results
          .map((row) => row.electionDate)
          .filter((value): value is string => value !== null),
      );
      if (results.length > 0 && sourceElectionDates.size === 0)
        throw new Error(
          `Los Angeles committee ${committeeId} returned contributions without a source election date in ${input.electionYear}`,
        );
      if (sourceElectionDates.size > 1)
        throw new Error(
          `Los Angeles committee ${committeeId} has multiple source election dates in ${input.electionYear}: ${[...sourceElectionDates].sort().join(", ")}`,
        );
      return results;
    }
  }
  throw new Error(`Los Angeles Open Data query exceeded ${maxPages} pages`);
}
