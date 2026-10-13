export const SAN_FRANCISCO_OPEN_DATA_BASE_URL =
  "https://data.sfgov.org/resource";
export const SAN_FRANCISCO_SUMMARY_TOTALS_DATASET_ID = "9ggq-m8hp";
export const SAN_FRANCISCO_TRANSACTIONS_DATASET_ID = "pitq-e56w";
export const SAN_FRANCISCO_PUBLIC_FUNDS_DATASET_ID = "dbak-p2fq";
export const SAN_FRANCISCO_FILERS_DATASET_ID = "4c8t-ngau";
export const SAN_FRANCISCO_FILINGS_DATASET_ID = "qizs-bwft";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PAGE_LIMIT = 1_000;
const DEFAULT_MAX_PAGES = 100;

export type SanFranciscoOpenDataClientOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  appToken?: string;
  pageLimit?: number;
  maxPages?: number;
  retryCount?: number;
  /** Qualified cash calls reject malformed physical elements rather than skip them. */
  strictRows?: boolean;
};

export function defaultSanFranciscoOpenDataClientOptions(): SanFranciscoOpenDataClientOptions {
  const appToken = process.env.SAN_FRANCISCO_OPEN_DATA_APP_TOKEN?.trim();
  return appToken ? { appToken } : {};
}

// DataSF money values are decimal strings ("4841006.0", "92.4"). Convert to
// integer cents without ever passing through binary floating point so that
// to-the-cent reconciliation is exact.
export function moneyStringToCents(value: unknown): number | null {
  const text =
    typeof value === "string"
      ? value.trim()
      : typeof value === "number"
        ? String(value)
        : "";
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const whole = Number(match[2]);
  const fractionText = (match[3] ?? "").padEnd(2, "0");
  // A third decimal digit would mean sub-cent data; round half up on the
  // magnitude, which matches how the source rounds published figures.
  const cents = Number(fractionText.slice(0, 2));
  const roundUp = Number(fractionText[2] ?? "0") >= 5 ? 1 : 0;
  if (!Number.isSafeInteger(whole)) return null;
  return sign * (whole * 100 + cents + roundUp);
}

export function exactSanFranciscoCashCents(value: unknown): number {
  const text =
    typeof value === "string"
      ? value.trim()
      : typeof value === "number"
        ? String(value)
        : "";
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(text))
    throw new Error("SF qualified cash requires exact cents");
  const cents = moneyStringToCents(text);
  if (cents === null || !Number.isSafeInteger(cents))
    throw new Error("SF qualified cash requires safe cents");
  return cents;
}

function soqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
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

function nullableBoolean(
  row: Record<string, unknown>,
  key: string,
): boolean | null {
  const value = row[key];
  return typeof value === "boolean" ? value : null;
}

// Transaction rows carry no election_date on late filings (verified live:
// all 2024 mayoral F496 rows have it null), so every transaction query
// bounds contests by transaction date instead. The bounds are mandatory:
// committees keep filing across cycles under the same FPPC id (verified
// live: the 2024 Lurie mayoral committee has 2026 Schedule A rows, incl.
// $165,000 on 2026-01-21), so an unbounded query silently mixes elections.
// Shape check plus a UTC round-trip so impossible calendar dates fail here
// with a clear message instead of as an opaque Socrata 400 — and because V8
// silently normalizes ISO overflow ("2026-02-31" parses to March 3), any
// caller that computed a window through Date arithmetic could otherwise
// smuggle a shifted date into the query.
function assertRealIsoDate(value: string, label: string): void {
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(time) ||
    new Date(time).toISOString().slice(0, 10) !== value
  )
    throw new Error(`Invalid San Francisco ${label}: ${value}`);
}

function transactionDateConditions(
  transactionDateFrom: string,
  transactionDateTo: string,
): string[] {
  for (const value of [transactionDateFrom, transactionDateTo])
    assertRealIsoDate(value, "transaction date");
  // Half-open window [from, to); ISO dates compare correctly as strings.
  if (transactionDateFrom >= transactionDateTo)
    throw new Error(
      `Empty San Francisco transaction-date window: ${transactionDateFrom} to ${transactionDateTo}`,
    );
  return [
    `transaction_date>=${soqlString(`${transactionDateFrom}T00:00:00.000`)}`,
    `transaction_date<${soqlString(`${transactionDateTo}T00:00:00.000`)}`,
  ];
}

async function fetchRows(
  url: string,
  options: SanFranciscoOpenDataClientOptions,
): Promise<{ rows: Record<string, unknown>[]; rawCount: number }> {
  const retries = options.retryCount ?? 2;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Avoid the empty HTTP 428 observed after earlier successful requests on
    // reused connections. Fresh connections passed the same six-request
    // source probe and the ordinary four-candidate batch without query changes.
    const headers = new Headers({
      accept: "application/json",
      connection: "close",
    });
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
          `San Francisco Open Data request failed: ${response.status} ${response.statusText}`,
        );
      }
      const payload: unknown = await response.json();
      if (!Array.isArray(payload))
        throw new Error("San Francisco Open Data response is not an array");
      if (
        options.strictRows &&
        payload.some(
          (row) =>
            typeof row !== "object" || row === null || Array.isArray(row),
        )
      )
        throw new Error(
          "SF qualified cash response has a malformed physical row",
        );
      // rawCount (pre-filter) is what pagination must compare against the
      // page limit: dropping a malformed element from a full page must not
      // end pagination early and silently lose the remaining pages.
      return {
        rawCount: payload.length,
        rows: payload.filter(
          (row): row is Record<string, unknown> =>
            typeof row === "object" && row !== null && !Array.isArray(row),
        ),
      };
    } catch (error) {
      if (
        attempt < retries &&
        (error instanceof TypeError ||
          (error instanceof Error && error.name === "AbortError"))
      )
        continue;
      if (error instanceof Error && error.name === "AbortError")
        throw new Error(
          `San Francisco Open Data request timed out after ${timeoutMs}ms`,
        );
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("San Francisco Open Data request exhausted retries");
}

async function fetchAllPages(
  datasetId: string,
  params: Record<string, string>,
  options: SanFranciscoOpenDataClientOptions,
): Promise<Record<string, unknown>[]> {
  const pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  if (!Number.isInteger(pageLimit) || pageLimit <= 0)
    throw new Error(`Invalid San Francisco Open Data pageLimit: ${pageLimit}`);
  if (!Number.isInteger(maxPages) || maxPages <= 0)
    throw new Error(`Invalid San Francisco Open Data maxPages: ${maxPages}`);
  const results: Record<string, unknown>[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(
      `${SAN_FRANCISCO_OPEN_DATA_BASE_URL}/${datasetId}.json`,
    );
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value);
    url.searchParams.set("$limit", String(pageLimit));
    url.searchParams.set("$offset", String(page * pageLimit));
    const { rows, rawCount } = await fetchRows(url.toString(), options);
    results.push(...rows);
    if (rawCount < pageLimit) return results;
  }
  throw new Error(
    `San Francisco Open Data query exceeded ${maxPages} pages: ${datasetId}`,
  );
}

export type SanFranciscoSummaryRow = {
  filingActivityNid?: string;
  fppcId?: string;
  scheduleAItemizedCents?: number;
  scheduleEItemizedCents?: number;
  filingNid: string;
  filingIdNumber: string;
  filingType: string;
  formType: string;
  periodStart: string | null;
  periodEnd: string | null;
  /**
   * Form 460 line 1 column A — monetary contributions for the period, cents.
   * Phase 4 gate identity (proven to the cent on three committees): this
   * equals the non-memo Schedule A rows plus the F460ALine2 unitemized
   * pseudo-rows for the same filings.
   */
  monetaryContributionsCents: number | null;
  /**
   * Form 460 line 2 column A, cents. Empirically NOT the Schedule B loan
   * principal (a committee with $200,000 of B1 loans shows $29.38 here);
   * carried so the line-5 identity closes exactly:
   * line 5 = line 1 + line 2 + line 4.
   */
  line2Cents: number | null;
  /** Form 460 line 5 column A — total contributions for the period, cents. */
  contributionsCents: number | null;
  /** Form 460 line 11 column A — total expenditures for the period, cents. */
  expendituresCents: number | null;
  /** Form 460 line 16 — ending cash balance at period end, cents. */
  endingCashCents: number | null;
  /** Form 460 line 19 — outstanding debts at period end, cents. */
  outstandingDebtsCents: number | null;
  /**
   * Schedule B1 line 1 — new loans received this period, cents. Gross new
   * borrowing only; repayments/forgiveness live on B1 line 2, so summing
   * this across filings gives total loans received (verified live: committee
   * 1467508 sums to the $200,000 the Phase 4 gate found on Schedule B1).
   */
  loansReceivedCents: number | null;
  /**
   * True when the filing's itemized transactions are synced into the
   * transactions dataset. Null only on pre-2008 legacy rows upstream
   * (verified live: 129 null rows, all 2002-2007 filings) — the Phase 6
   * source-health gate requires true on every row of a synced committee.
   */
  syncFlag: boolean | null;
};

/**
 * Form 460 summary rows for one committee, ordered by period start. The
 * published dataset carries only the current version of each filing
 * (amendments replace originals upstream); that guarantee is asserted here
 * so silent duplicates can never inflate a reconciliation.
 */
export async function getSanFranciscoCommitteeSummaryRows(
  input: { fppcId: string; strictCommitteeCash?: boolean },
  options: SanFranciscoOpenDataClientOptions = {},
): Promise<SanFranciscoSummaryRow[]> {
  const fppcId = input.fppcId.trim();
  if (!/^\d{4,12}$/.test(fppcId))
    throw new Error(`Invalid San Francisco FPPC id: ${input.fppcId}`);
  const rows = await fetchAllPages(
    SAN_FRANCISCO_SUMMARY_TOTALS_DATASET_ID,
    {
      $where:
        `fppc_id=${soqlString(fppcId)}` +
        (input.strictCommitteeCash ? " AND form_type='FPPC460'" : ""),
      $order: "start_date,filing_id_number,:id",
    },
    input.strictCommitteeCash ? { ...options, strictRows: true } : options,
  );
  const seenFilingNids = new Set<string>();
  const results: SanFranciscoSummaryRow[] = [];
  for (const row of rows) {
    const filingNid = stringValue(row, "filing_nid");
    if (!filingNid)
      throw new Error(
        `San Francisco summary row for committee ${fppcId} is missing filing_nid`,
      );
    if (seenFilingNids.has(filingNid))
      throw new Error(
        `San Francisco summary rows for committee ${fppcId} contain duplicate filing_nid ${filingNid}; the current-version-only source guarantee is broken`,
      );
    seenFilingNids.add(filingNid);
    if (
      input.strictCommitteeCash &&
      (!stringValue(row, "filing_activity_nid") ||
        stringValue(row, "fppc_id") !== fppcId)
    )
      throw new Error(
        "SF qualified cash summary edition/receiver is unavailable",
      );
    results.push({
      ...(input.strictCommitteeCash
        ? {
            filingActivityNid: stringValue(row, "filing_activity_nid"),
            fppcId,
            scheduleAItemizedCents: exactSanFranciscoCashCents(
              row["schedulea_line_1"],
            ),
            scheduleEItemizedCents: exactSanFranciscoCashCents(
              row["schedulee_line_1"],
            ),
          }
        : {}),
      filingNid,
      filingIdNumber: stringValue(row, "filing_id_number"),
      filingType: stringValue(row, "filing_type"),
      formType: stringValue(row, "form_type"),
      periodStart: stringValue(row, "start_date") || null,
      periodEnd: stringValue(row, "end_date") || null,
      monetaryContributionsCents: moneyStringToCents(row["line_1_col_a"]),
      line2Cents: moneyStringToCents(row["line_2_col_a"]),
      contributionsCents: moneyStringToCents(row["line_5_col_a"]),
      expendituresCents: moneyStringToCents(row["line_11_col_a"]),
      endingCashCents: moneyStringToCents(row["line_16_col_a"]),
      outstandingDebtsCents: moneyStringToCents(row["line_19_col_a"]),
      loansReceivedCents: moneyStringToCents(row["scheduleb1_line_1"]),
      syncFlag: nullableBoolean(row, "sync_flag"),
    });
  }
  return results;
}

export type SanFranciscoDatasetFreshness = {
  /** Latest data_as_of across the dataset (raw timestamp string). */
  dataAsOf: string | null;
  /** Latest data_loaded_at across the dataset (raw timestamp string). */
  dataLoadedAt: string | null;
};

/**
 * Dataset-level freshness metadata via a single server-side aggregate. Every
 * campaign-finance dataset carries per-row data_as_of / data_loaded_at
 * columns. Official metadata defines them as when a record was added to its
 * source and uploaded to the portal, respectively. Their maxima describe
 * observed record activity, not a shared complete refresh generation.
 * Latest per-filing coverage and financial controls are checked separately.
 */
export async function getSanFranciscoDatasetFreshness(
  datasetId: string,
  options: SanFranciscoOpenDataClientOptions = {},
): Promise<SanFranciscoDatasetFreshness> {
  if (!/^[a-z0-9]{4}-[a-z0-9]{4}$/.test(datasetId))
    throw new Error(`Invalid San Francisco dataset id: ${datasetId}`);
  const rows = await fetchAllPages(
    datasetId,
    {
      $select:
        "max(data_as_of) AS data_as_of,max(data_loaded_at) AS data_loaded_at",
    },
    options,
  );
  const row = rows[0] ?? {};
  return {
    dataAsOf: stringValue(row, "data_as_of") || null,
    dataLoadedAt: stringValue(row, "data_loaded_at") || null,
  };
}

export type SanFranciscoFilingIndexRow = {
  filingActivityNid?: string;
  fppcId?: string;
  periodStart?: string;
  periodEnd?: string;
  currentStatus?: string;
  hasEfileContent?: boolean;
  rejected?: boolean;
  filingNid: string;
  /** Raw filing_date timestamp string ("2024-08-01T00:00:00.000"). */
  filingDate: string | null;
};

/**
 * The filings-received index's CURRENT Form 460 filings for one committee:
 * one row per filing chain (amendments share the original's filing_nid),
 * keeping only versions marked "Most Recent", not rejected, and e-filed.
 * Paper filings (has_efile_content=false) never reach the summary/
 * transactions datasets, so they are excluded from the coverage contract.
 * Verified live (committee 1467508): this set's filing_nids exactly equal
 * the summary dataset's — the identity the Phase 6 source-health coverage
 * check relies on.
 */
export async function getSanFranciscoCommitteeCurrentForm460Filings(
  input: { fppcId: string; strictCommitteeCash?: boolean },
  options: SanFranciscoOpenDataClientOptions = {},
): Promise<SanFranciscoFilingIndexRow[]> {
  const fppcId = input.fppcId.trim();
  if (!/^\d{4,12}$/.test(fppcId))
    throw new Error(`Invalid San Francisco FPPC id: ${input.fppcId}`);
  const rows = await fetchAllPages(
    SAN_FRANCISCO_FILINGS_DATASET_ID,
    {
      $select: input.strictCommitteeCash
        ? "filing_nid,filing_date,filing_activity_nid,fppc_id,start_date,end_date,current_status,has_efile_content,rejected"
        : "filing_nid,filing_date",
      $where: [
        `fppc_id=${soqlString(fppcId)}`,
        `form_type='FPPC460'`,
        `current_status like 'Most Recent%'`,
        // Strict replacement must see paper/unknown/rejected current
        // versions and refuse incomplete authority rather than hiding them.
        ...(input.strictCommitteeCash
          ? []
          : [`rejected=false`, `has_efile_content=true`]),
      ].join(" AND "),
      $order: "filing_nid,:id",
    },
    input.strictCommitteeCash ? { ...options, strictRows: true } : options,
  );
  // Defensive dedupe: one chain should have exactly one Most Recent version,
  // but a duplicate here must not double-report a missing-coverage nid.
  const byNid = new Map<string, SanFranciscoFilingIndexRow>();
  for (const row of rows) {
    const filingNid = stringValue(row, "filing_nid");
    if (
      input.strictCommitteeCash &&
      (!filingNid ||
        byNid.has(filingNid) ||
        !stringValue(row, "filing_activity_nid") ||
        stringValue(row, "fppc_id") !== fppcId ||
        row["has_efile_content"] !== true ||
        row["rejected"] !== false ||
        !stringValue(row, "current_status").startsWith("Most Recent"))
    )
      throw new Error(
        "SF qualified cash current filing identity is unavailable or ambiguous",
      );
    if (!filingNid || byNid.has(filingNid)) continue;
    byNid.set(filingNid, {
      ...(input.strictCommitteeCash
        ? {
            filingActivityNid: stringValue(row, "filing_activity_nid"),
            fppcId,
            periodStart: stringValue(row, "start_date"),
            periodEnd: stringValue(row, "end_date"),
            currentStatus: stringValue(row, "current_status"),
            hasEfileContent: true,
            rejected: false,
          }
        : {}),
      filingNid,
      filingDate: stringValue(row, "filing_date") || null,
    });
  }
  return [...byNid.values()];
}

export type SanFranciscoTargetedSpendingRow = {
  spenderFppcId: string | null;
  spenderName: string;
  formType: string;
  supportOpposeCode: string | null;
  amountCents: number;
  transactionCount: number;
};

/**
 * Server-side aggregation of transactions that name a target candidate,
 * grouped by spender committee, form type, and disclosed direction. Used by
 * the Phase 0 probe to quantify how much of the dashboard's outside money is
 * visible through candidate-tagged rows alone (F496 vs Schedule D overlap,
 * primarily-formed committee spending that carries no candidate tag, …).
 */
export async function getSanFranciscoCandidateTargetedSpending(
  input: {
    candidateLastName: string;
    candidateFirstName?: string;
    // Required cycle window — see transactionDateConditions. Name filters
    // alone mix same-surname candidates and same-committee activity across
    // election cycles.
    transactionDateFrom: string;
    transactionDateTo: string;
  },
  options: SanFranciscoOpenDataClientOptions = {},
): Promise<SanFranciscoTargetedSpendingRow[]> {
  const lastName = input.candidateLastName.trim().toUpperCase();
  if (!lastName)
    throw new Error("San Francisco targeted-spending query needs a last name");
  const conditions = [`upper(candidate_last_name)=${soqlString(lastName)}`];
  const firstName = input.candidateFirstName?.trim().toUpperCase();
  if (firstName)
    conditions.push(`upper(candidate_first_name)=${soqlString(firstName)}`);
  conditions.push(
    ...transactionDateConditions(
      input.transactionDateFrom,
      input.transactionDateTo,
    ),
  );
  const rows = await fetchAllPages(
    SAN_FRANCISCO_TRANSACTIONS_DATASET_ID,
    {
      $select:
        "fppc_id,filer_name,form_type,support_oppose_code,sum(calculated_amount) AS amount,count(*) AS transaction_count",
      $where: conditions.join(" AND "),
      $group: "fppc_id,filer_name,form_type,support_oppose_code",
      // Offset pagination needs a total order; ":id" is unavailable on
      // aggregate queries, so the group keys are the tiebreakers.
      $order: "amount DESC,fppc_id,filer_name,form_type,support_oppose_code",
    },
    options,
  );
  const results: SanFranciscoTargetedSpendingRow[] = [];
  for (const row of rows) {
    const amountCents = moneyStringToCents(row["amount"]);
    if (amountCents === null) continue;
    const fppcId = stringValue(row, "fppc_id");
    results.push({
      spenderFppcId: /^\d{4,12}$/.test(fppcId) ? fppcId : null,
      spenderName: stringValue(row, "filer_name"),
      formType: stringValue(row, "form_type"),
      supportOpposeCode: stringValue(row, "support_oppose_code") || null,
      amountCents,
      transactionCount: Number(row["transaction_count"] ?? 0) || 0,
    });
  }
  return results;
}

export type SanFranciscoPublicFundsRow = {
  /** "Last, First" as disclosed. */
  candidateName: string;
  /** "Mayor" or a supervisor district number. */
  district: string;
  /**
   * Diagnostic only: the source stopped populating this column (verified
   * live: 152 valid approved rows carry it blank). Never gate approval on
   * it — every published funds_approved row is an approval.
   */
  pendingCompleted: string | null;
  fundsApprovedCents: number;
};

/**
 * Public-financing approvals for one election. The dataset has no committee
 * id — rows carry only election date, district ("Mayor" or a supervisor
 * district number), candidate name, and approved amount — so callers match
 * by normalized candidate name and district, failing closed on ambiguity.
 * Verified live: per-candidate sums explain the dashboard "funds" figure
 * exactly (funds = Form 460 line-5 contributions + public funds approved).
 */
export async function getSanFranciscoPublicFundsApproved(
  input: {
    electionDate: string;
    /** Optional server-side scope: "Mayor" or a supervisor district number. */
    district?: string;
  },
  options: SanFranciscoOpenDataClientOptions = {},
): Promise<SanFranciscoPublicFundsRow[]> {
  assertRealIsoDate(input.electionDate, "election date");
  const conditions = [
    `election_date=${soqlString(`${input.electionDate}T00:00:00.000`)}`,
  ];
  const district = input.district?.trim();
  if (district) conditions.push(`district=${soqlString(district)}`);
  const rows = await fetchAllPages(
    SAN_FRANCISCO_PUBLIC_FUNDS_DATASET_ID,
    {
      $where: conditions.join(" AND "),
      $order: "candidate,date_of_submission,:id",
    },
    options,
  );
  const results: SanFranciscoPublicFundsRow[] = [];
  for (const row of rows) {
    const candidateName = stringValue(row, "candidate");
    const fundsApprovedCents = moneyStringToCents(row["funds_approved"]);
    if (!candidateName || fundsApprovedCents === null) continue;
    results.push({
      candidateName,
      district: stringValue(row, "district"),
      pendingCompleted: stringValue(row, "pending_completed") || null,
      fundsApprovedCents,
    });
  }
  return results;
}

export type SanFranciscoFilerRow = {
  filerNid: string;
  /** FPPC committee id; null while the registry still says "pending". */
  fppcId: string | null;
  filerName: string;
  /** "Candidate or Officeholder" / "Primarily Formed Candidate" / "General Purpose" / … */
  filerType: string;
  /** "Last, First" as disclosed; null for non-candidate filers. */
  candidateName: string | null;
  status: string;
  isTerminated: boolean | null;
};

/**
 * Filer-registry lookup, by FPPC id and/or candidate-name fragment. Used by
 * the Phase 3 resolver to cross-check that a manifest committee really is
 * the candidate's controlled committee (filer_type) and still active. The
 * name filter is a case-insensitive contains-match because the registry
 * discloses "Last, First" with inconsistent middle names.
 */
export async function getSanFranciscoFilers(
  input: { fppcId?: string; candidateName?: string },
  options: SanFranciscoOpenDataClientOptions = {},
): Promise<SanFranciscoFilerRow[]> {
  const conditions: string[] = [];
  if (input.fppcId !== undefined) {
    const fppcId = input.fppcId.trim();
    if (!/^\d{4,12}$/.test(fppcId))
      throw new Error(`Invalid San Francisco FPPC id: ${input.fppcId}`);
    conditions.push(`fppc_id=${soqlString(fppcId)}`);
  }
  const candidateName = input.candidateName?.trim().toUpperCase();
  if (candidateName)
    conditions.push(
      `upper(candidate_name) like ${soqlString(`%${candidateName}%`)}`,
    );
  if (conditions.length === 0)
    throw new Error(
      "San Francisco filer lookup needs an FPPC id or a candidate name",
    );
  const rows = await fetchAllPages(
    SAN_FRANCISCO_FILERS_DATASET_ID,
    {
      $where: conditions.join(" AND "),
      $order: "filer_nid,:id",
    },
    options,
  );
  const results: SanFranciscoFilerRow[] = [];
  for (const row of rows) {
    const filerNid = stringValue(row, "filer_nid");
    const filerName = stringValue(row, "filer_name");
    const filerType = stringValue(row, "filer_type");
    if (!filerNid || !filerName || !filerType) continue;
    const fppcId = stringValue(row, "fppc_id");
    results.push({
      filerNid,
      fppcId: /^\d{4,12}$/.test(fppcId) ? fppcId : null,
      filerName,
      filerType,
      candidateName: nullableString(row, "candidate_name"),
      status: stringValue(row, "status"),
      isTerminated: nullableBoolean(row, "is_terminated"),
    });
  }
  return results;
}

export type SanFranciscoItemizedTransactionRow = {
  elementNid?: string;
  filingActivityNid?: string;
  fppcId?: string;
  reportedCommitteeId?: string | null;
  transactionDescription?: string | null;
  filingNid: string;
  /** Filer-assigned id ("INC139"); unique within a filing, not globally. */
  transactionId: string | null;
  formType: string;
  transactionDate: string | null;
  contributorFirstName: string | null;
  /** Individuals' last name; organizations disclose their full name here. */
  contributorLastName: string | null;
  occupation: string | null;
  employer: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  /** "IND" for individuals; the Phase 4 occupation/employer filter key. */
  entityCode: string | null;
  /** DataSF's canonical amount column — all aggregation uses this. Cents. */
  calculatedAmountCents: number;
  /** Raw form amount, kept for diagnostics only. Cents. */
  transactionAmount1Cents: number | null;
  memoCode: boolean | null;
  isItemized: boolean | null;
  /**
   * Both cross-reference columns are 100% null upstream today (verified
   * 2026-08-06 across all 971k rows), so Phase 4's late-filing dedupe
   * cannot rely on them; carried so repopulation becomes visible.
   */
  crossReferenceMatch: string | null;
  crossReferenceSchedule: string | null;
  supportOpposeCode: string | null;
  transactionCode: string | null;
};

const ITEMIZED_TRANSACTION_SELECT = [
  "filing_nid",
  "transaction_id",
  "form_type",
  "transaction_date",
  "transaction_first_name",
  "transaction_last_name",
  "transaction_occupation",
  "transaction_employer",
  "transaction_city",
  "transaction_state",
  "transaction_zip",
  "entity_code",
  "calculated_amount",
  "transaction_amount_1",
  "memo_code",
  "cross_reference_match",
  "cross_reference_schedule",
  "is_itemized",
  "support_oppose_code",
  "transaction_code",
].join(",");

/**
 * Itemized transaction rows for one committee, filtered to explicit form
 * types (e.g. ["A", "C"] for Schedule A/C contributions, ["F496"] for late
 * independent expenditures). Raw fetch only: the contributor-formula
 * composition rules stay in the Phase 4 aggregator behind its entry gate.
 * Rows whose canonical amount cannot be parsed are dropped, never thrown.
 * The transaction-date window is mandatory — committees file across cycles
 * under one FPPC id, so an unbounded fetch would silently mix elections;
 * a diagnostic that truly wants all history passes a wide explicit window.
 */
export async function getSanFranciscoCommitteeItemizedTransactions(
  input: {
    fppcId: string;
    formTypes: string[];
    transactionDateFrom: string;
    transactionDateTo: string;
    /**
     * Also return rows with NO transaction_date. Schedule B1 loan rows are
     * undated (verified live), so a strict date window silently excludes
     * the whole schedule; SF committees are per-election, which keeps
     * undated rows inside one contest.
     */
    includeUndatedTransactions?: boolean;
    strictCommitteeCash?: boolean;
  },
  options: SanFranciscoOpenDataClientOptions = {},
): Promise<SanFranciscoItemizedTransactionRow[]> {
  const fppcId = input.fppcId.trim();
  if (!/^\d{4,12}$/.test(fppcId))
    throw new Error(`Invalid San Francisco FPPC id: ${input.fppcId}`);
  if (input.formTypes.length === 0)
    throw new Error(
      "San Francisco itemized-transaction query needs at least one form type",
    );
  // Form-type values are matched exactly: Socrata string equality is
  // case-sensitive and the dataset mixes cases ("A", "F497P1", but the
  // summary pseudo-rows are "F460ALine2"), so folding case here would
  // silently match nothing.
  const formTypes = input.formTypes.map((formType) => {
    const trimmed = formType.trim();
    if (!/^[A-Za-z0-9]{1,16}$/.test(trimmed))
      throw new Error(`Invalid San Francisco form type: ${formType}`);
    return trimmed;
  });
  const dateConditions = transactionDateConditions(
    input.transactionDateFrom,
    input.transactionDateTo,
  );
  const conditions = [
    `fppc_id=${soqlString(fppcId)}`,
    `form_type in (${formTypes.map(soqlString).join(",")})`,
    ...(!input.strictCommitteeCash
      ? [
          input.includeUndatedTransactions
            ? `(transaction_date IS NULL OR (${dateConditions.join(" AND ")}))`
            : dateConditions.join(" AND "),
        ]
      : []),
  ];
  const rows = await fetchAllPages(
    SAN_FRANCISCO_TRANSACTIONS_DATASET_ID,
    {
      $select:
        ITEMIZED_TRANSACTION_SELECT +
        (input.strictCommitteeCash
          ? ",element_nid,filing_activity_nid,fppc_id,committee_id,transaction_description"
          : ""),
      $where: conditions.join(" AND "),
      $order: input.strictCommitteeCash
        ? "element_nid,:id"
        : "transaction_date,transaction_id,:id",
    },
    input.strictCommitteeCash ? { ...options, strictRows: true } : options,
  );
  const results: SanFranciscoItemizedTransactionRow[] = [];
  const seenElements = new Set<string>();
  for (const row of rows) {
    const filingNid = stringValue(row, "filing_nid");
    const formType = stringValue(row, "form_type");
    const calculatedAmountCents = input.strictCommitteeCash
      ? exactSanFranciscoCashCents(row["calculated_amount"])
      : moneyStringToCents(row["calculated_amount"]);
    if (input.strictCommitteeCash) {
      const element = stringValue(row, "element_nid");
      if (
        !filingNid ||
        !formTypes.includes(formType) ||
        !element ||
        seenElements.has(element) ||
        !stringValue(row, "filing_activity_nid") ||
        stringValue(row, "fppc_id") !== fppcId
      )
        throw new Error(
          "SF qualified cash transaction identity is unavailable or ambiguous",
        );
      seenElements.add(element);
    }
    if (!filingNid || !formType || calculatedAmountCents === null) continue;
    results.push({
      ...(input.strictCommitteeCash
        ? {
            elementNid: stringValue(row, "element_nid"),
            filingActivityNid: stringValue(row, "filing_activity_nid"),
            fppcId,
            reportedCommitteeId:
              row["committee_id"] == null
                ? null
                : typeof row["committee_id"] === "string"
                  ? row["committee_id"]
                  : (() => {
                      throw new Error(
                        "SF qualified cash reported committee ID has unsupported source type",
                      );
                    })(),
            transactionDescription: nullableString(
              row,
              "transaction_description",
            ),
          }
        : {}),
      filingNid,
      transactionId: nullableString(row, "transaction_id"),
      formType,
      transactionDate: nullableString(row, "transaction_date"),
      contributorFirstName: nullableString(row, "transaction_first_name"),
      contributorLastName: nullableString(row, "transaction_last_name"),
      occupation: nullableString(row, "transaction_occupation"),
      employer: nullableString(row, "transaction_employer"),
      city: nullableString(row, "transaction_city"),
      state: nullableString(row, "transaction_state"),
      zip: nullableString(row, "transaction_zip"),
      entityCode: nullableString(row, "entity_code"),
      calculatedAmountCents,
      transactionAmount1Cents: moneyStringToCents(row["transaction_amount_1"]),
      memoCode: nullableBoolean(row, "memo_code"),
      isItemized: nullableBoolean(row, "is_itemized"),
      crossReferenceMatch:
        row["cross_reference_match"] == null
          ? null
          : String(row["cross_reference_match"]),
      crossReferenceSchedule:
        row["cross_reference_schedule"] == null
          ? null
          : String(row["cross_reference_schedule"]),
      supportOpposeCode: nullableString(row, "support_oppose_code"),
      transactionCode: nullableString(row, "transaction_code"),
    });
  }
  return results;
}

/**
 * Full receiving-FPPC current-published financial scope. Strict mode does not
 * filter dates: the qualifier must see offsetting outside-window facts and
 * reject them, rather than accept a falsely matching aggregate control.
 * The supplied window is still validated; legacy getter filtering is unchanged.
 */
export function getSanFranciscoCommitteeCashTransactions(
  input: {
    fppcId: string;
    transactionDateFrom: string;
    transactionDateTo: string;
  },
  options: SanFranciscoOpenDataClientOptions = {},
): Promise<SanFranciscoItemizedTransactionRow[]> {
  return getSanFranciscoCommitteeItemizedTransactions(
    {
      ...input,
      formTypes: ["A", "E", "B1", "F497P1"],
      includeUndatedTransactions: true,
      strictCommitteeCash: true,
    },
    options,
  );
}
