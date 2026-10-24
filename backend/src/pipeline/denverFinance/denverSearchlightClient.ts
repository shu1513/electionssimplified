// SearchLight Denver JSON API client (docs/plans/plan-denver-finance.md).
//
// SearchLight (https://denver.maplight.com) is the Denver Clerk & Recorder's
// campaign finance filing system; its public dashboard rides an anonymous,
// undocumented JSON API. This client is the module's single fetch layer:
// - HTTPS to exactly denver.maplight.com; paths are built here, never taken
//   from input.
// - Amounts are converted to integer cents at the boundary; a non-finite
//   amount fails the request closed (money is load-bearing).
// - PII: transaction rows carry contributor/payee street addresses and zip
//   codes. Typed rows are built from an explicit field allowlist that
//   excludes them — address data never leaves this module in a typed row,
//   so nothing downstream can log or persist it.
// - The API is undocumented: every mapper validates the shape it needs and
//   throws bad_response on drift rather than guessing.

export const DENVER_SEARCHLIGHT_BASE_URL = "https://denver.maplight.com";
export const DENVER_SEARCHLIGHT_DEFAULT_TIMEOUT_MS = 30_000;
// An 8,000-row transaction page is ~6 MB; anything past this is drift, not data.
export const DENVER_SEARCHLIGHT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
export const DENVER_SEARCHLIGHT_DEFAULT_PAGE_SIZE = 1_000;
// Verified live 2026-08-12: a 7,978-row cycle returns in one page at 8,000.
export const DENVER_SEARCHLIGHT_MAX_PAGE_SIZE = 8_000;
export const DENVER_SEARCHLIGHT_DEFAULT_MAX_PAGES = 50;

/** Campaign finance report filings (observed filingTypeName "Campaign Finance Report"). */
export const DENVER_SEARCHLIGHT_CAMPAIGN_FINANCE_REPORT_FILING_TYPE_ID = 5;

/** positionType values for GetSupportingorOpposingIndependentSpendersByCommittee. */
export const DENVER_SEARCHLIGHT_POSITION_TYPE = { support: 1, oppose: 2 } as const;

export type DenverSearchlightClientErrorCode =
  | "invalid_request"
  | "network_error"
  | "http_error"
  | "bad_response";

export class DenverSearchlightClientError extends Error {
  constructor(
    public readonly code: DenverSearchlightClientErrorCode,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "DenverSearchlightClientError";
  }
}

export type DenverSearchlightClientOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
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

function requirePositiveInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new DenverSearchlightClientError(
      "invalid_request",
      `Denver SearchLight ${fieldName} must be a positive integer, got ${value}`
    );
  }
  return value;
}

/** JSON amounts arrive as numbers (e.g. 2016263.63) — convert to integer cents. */
function moneyToCents(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DenverSearchlightClientError(
      "bad_response",
      `Denver SearchLight ${fieldName} is not a finite number`
    );
  }
  return Math.round(value * 100);
}

function optionalTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requireString(value: unknown, fieldName: string): string {
  const normalized = optionalTrimmedString(value);
  if (normalized === null) {
    throw new DenverSearchlightClientError(
      "bad_response",
      `Denver SearchLight ${fieldName} is missing or empty`
    );
  }
  return normalized;
}

function requireInteger(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new DenverSearchlightClientError(
      "bad_response",
      `Denver SearchLight ${fieldName} is not an integer`
    );
  }
  return value;
}

function optionalInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function requireBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== "boolean") {
    throw new DenverSearchlightClientError(
      "bad_response",
      `Denver SearchLight ${fieldName} is not a boolean`
    );
  }
  return value;
}

function requireArray(value: unknown, fieldName: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new DenverSearchlightClientError(
      "bad_response",
      `Denver SearchLight ${fieldName} is not an array`
    );
  }
  return value;
}

function requireRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new DenverSearchlightClientError(
      "bad_response",
      `Denver SearchLight ${fieldName} is not an object`
    );
  }
  return value;
}

async function fetchSearchlightJson(
  path: string,
  init: { method: "GET" } | { method: "POST"; body: unknown },
  options: DenverSearchlightClientOptions
): Promise<unknown> {
  const url = `${DENVER_SEARCHLIGHT_BASE_URL}${path}`;
  const timeoutMs = options.timeoutMs ?? DENVER_SEARCHLIGHT_DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  // The timeout stays armed through the BODY read, not just the headers — a
  // stalled body would otherwise hang the caller with no clock running.
  try {
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
      if (isAbortError(error)) {
        throw new DenverSearchlightClientError(
          "network_error",
          `Denver SearchLight request timed out after ${timeoutMs}ms for ${url}`
        );
      }
      throw new DenverSearchlightClientError(
        "network_error",
        `Denver SearchLight request failed for ${url}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (!response.ok) {
      throw new DenverSearchlightClientError(
        "http_error",
        `Denver SearchLight request failed for ${url}: ${response.status} ${response.statusText}`,
        response.status
      );
    }

    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > DENVER_SEARCHLIGHT_MAX_RESPONSE_BYTES) {
      throw new DenverSearchlightClientError(
        "bad_response",
        `Denver SearchLight response for ${url} declares ${declaredLength} bytes, over the ${DENVER_SEARCHLIGHT_MAX_RESPONSE_BYTES} cap`
      );
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      if (isAbortError(error)) {
        throw new DenverSearchlightClientError(
          "network_error",
          `Denver SearchLight body read timed out after ${timeoutMs}ms for ${url}`
        );
      }
      throw new DenverSearchlightClientError(
        "network_error",
        `Denver SearchLight body read failed for ${url}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (text.length > DENVER_SEARCHLIGHT_MAX_RESPONSE_BYTES) {
      throw new DenverSearchlightClientError(
        "bad_response",
        `Denver SearchLight response for ${url} is ${text.length} characters, over the ${DENVER_SEARCHLIGHT_MAX_RESPONSE_BYTES} cap`
      );
    }

    // "No content" is a real SearchLight answer, not a broken one: verified
    // live 2026-08-13, GetCommitteeDetailsByFiler returns HTTP 204 with an
    // empty body for a registered filer that has no detail record for the
    // requested cycle (filer 1328, cycle 36). Returned as undefined so each
    // caller decides; callers that require a record or an array still fail
    // closed on it.
    if (response.status === 204 || text.trim() === "") {
      return undefined;
    }

    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new DenverSearchlightClientError(
        "bad_response",
        `Denver SearchLight response was not valid JSON for ${url}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Election cycles
// ---------------------------------------------------------------------------

export type DenverElectionCycle = {
  electionCycleId: number;
  name: string;
  electionDate: string | null;
  electionTypeName: string | null;
  electionCycleStatusName: string | null;
};

export async function getDenverElectionCycles(
  options: DenverSearchlightClientOptions = {}
): Promise<DenverElectionCycle[]> {
  const payload = await fetchSearchlightJson("/api/Calendar/getElectionCycles", { method: "GET" }, options);
  return requireArray(payload, "election cycles").map((raw, index) => {
    const row = requireRecord(raw, `election cycle ${index}`);
    return {
      electionCycleId: requireInteger(row.electionCycleId, `election cycle ${index} id`),
      name: requireString(row.name, `election cycle ${index} name`),
      electionDate: optionalTrimmedString(row.electionDate),
      electionTypeName: optionalTrimmedString(row.electionTypeName),
      electionCycleStatusName: optionalTrimmedString(row.electionCycleStatusName),
    };
  });
}

// ---------------------------------------------------------------------------
// Candidates per cycle (finance-registration list; NOT a ballot roster)
// ---------------------------------------------------------------------------

/** Raw rows carry contributor-grade PII (street address, zip) — excluded here. */
export type DenverCycleCandidate = {
  fullName: string;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  officeSoughtId: number | null;
  officeSought: string | null;
  district: string | null;
  committeeId: number;
  filerId: number;
};

export async function getDenverCandidatesByElectionCycle(
  electionCycleId: number,
  options: DenverSearchlightClientOptions = {}
): Promise<DenverCycleCandidate[]> {
  requirePositiveInteger(electionCycleId, "election cycle id");
  const payload = await fetchSearchlightJson(
    `/api/contact/GetCandidatesByElectionCycle?electionCycleId=${electionCycleId}`,
    { method: "GET" },
    options
  );
  return requireArray(payload, "cycle candidates").map((raw, index) => {
    const row = requireRecord(raw, `cycle candidate ${index}`);
    return {
      fullName: requireString(row.fullName, `cycle candidate ${index} fullName`),
      firstName: optionalTrimmedString(row.firstName),
      middleName: optionalTrimmedString(row.middleName),
      lastName: optionalTrimmedString(row.lastName),
      officeSoughtId: optionalInteger(row.officeSoughtId),
      officeSought: optionalTrimmedString(row.officeSought),
      district: optionalTrimmedString(row.district),
      committeeId: requireInteger(row.committeeId, `cycle candidate ${index} committeeId`),
      filerId: requireInteger(row.filerId, `cycle candidate ${index} filerId`),
    };
  });
}

// ---------------------------------------------------------------------------
// Filer identity (canonical id + mutable committee entity ids)
// ---------------------------------------------------------------------------

export type DenverFiler = {
  filerId: number;
  filerTypeName: string | null;
  filerStatusName: string | null;
  isTerminated: boolean;
  committeeIds: number[];
  independentExpenditureIds: number[];
};

export async function getDenverFiler(
  filerId: number,
  options: DenverSearchlightClientOptions = {}
): Promise<DenverFiler> {
  requirePositiveInteger(filerId, "filer id");
  const payload = await fetchSearchlightJson(`/api/Filer/filer/${filerId}`, { method: "GET" }, options);
  const row = requireRecord(payload, "filer");
  return {
    filerId: requireInteger(row.filerId, "filer filerId"),
    filerTypeName: optionalTrimmedString(row.filerTypeName),
    filerStatusName: optionalTrimmedString(row.filerStatusName),
    isTerminated: requireBoolean(row.isTerminated, "filer isTerminated"),
    committeeIds: requireArray(row.committeeIds, "filer committeeIds").map((value, index) =>
      requireInteger(value, `filer committeeIds[${index}]`)
    ),
    independentExpenditureIds: requireArray(
      row.independentExpenditureIds,
      "filer independentExpenditureIds"
    ).map((value, index) => requireInteger(value, `filer independentExpenditureIds[${index}]`)),
  };
}

export type DenverFilerCycle = {
  electionCycleId: number;
  name: string;
  electionDate: string | null;
};

export async function getDenverElectionCyclesByFiler(
  filerId: number,
  options: DenverSearchlightClientOptions = {}
): Promise<DenverFilerCycle[]> {
  requirePositiveInteger(filerId, "filer id");
  const payload = await fetchSearchlightJson(
    `/api/Lookup/getElectionCyclesByFiler?filerId=${filerId}`,
    { method: "GET" },
    options
  );
  return requireArray(payload, "filer cycles").map((raw, index) => {
    const row = requireRecord(raw, `filer cycle ${index}`);
    return {
      electionCycleId: requireInteger(row.id, `filer cycle ${index} id`),
      name: requireString(row.name, `filer cycle ${index} name`),
      electionDate: optionalTrimmedString(row.electionDate),
    };
  });
}

/** committeeTypeId observed for candidate-controlled committees ("Candidate Committee"). */
export const DENVER_SEARCHLIGHT_CANDIDATE_COMMITTEE_TYPE_ID = 1;

/**
 * The candidate page's committee-detail record. CAUTION (verified live
 * 2026-08-12): the response reflects the committee's LATEST registration —
 * querying Johnston (filer 658) with electionCycleId=26 answers
 * electionCycleId 33. Callers must require the response's electionCycleId to
 * echo the requested cycle before trusting committeeName/office for that
 * cycle. Raw rows carry the treasurer's name and address fields — excluded
 * here per the PII allowlist rule.
 *
 * A registered filer can have NO detail record for a cycle: the endpoint
 * answers HTTP 204 with an empty body (verified live 2026-08-13 for filer
 * 1328 at cycle 36, while its duplicate-name sibling 1322 answers normally).
 * That is source data, not a fault, so the getter returns null and the
 * resolver blocks that registrant — it must never abort a whole run, or one
 * detail-less registrant would stop every Denver link.
 */
export type DenverCommitteeDetails = {
  filerId: number;
  committeeId: number;
  committeeName: string | null;
  committeeTypeId: number | null;
  committeeType: string | null;
  candidateName: string | null;
  office: string | null;
  officeId: number | null;
  electionCycleId: number;
  electionDate: string | null;
};

export async function getDenverCommitteeDetailsByFiler(
  filerId: number,
  electionCycleId: number,
  options: DenverSearchlightClientOptions = {}
): Promise<DenverCommitteeDetails | null> {
  requirePositiveInteger(filerId, "filer id");
  requirePositiveInteger(electionCycleId, "election cycle id");
  const payload = await fetchSearchlightJson(
    `/api/Committee/GetCommitteeDetailsByFiler?filerId=${filerId}&electionCycleId=${electionCycleId}`,
    { method: "GET" },
    options
  );
  if (payload === undefined) return null;
  const row = requireRecord(payload, "committee details");
  return {
    filerId: requireInteger(row.filerId, "committee details filerId"),
    committeeId: requireInteger(row.committeeId, "committee details committeeId"),
    committeeName: optionalTrimmedString(row.committeeName),
    committeeTypeId: optionalInteger(row.committeeTypeId),
    committeeType: optionalTrimmedString(row.committeeType),
    candidateName: optionalTrimmedString(row.candidateName),
    office: optionalTrimmedString(row.office),
    officeId: optionalInteger(row.officeId),
    electionCycleId: requireInteger(row.electionCycleId, "committee details electionCycleId"),
    electionDate: optionalTrimmedString(row.electionDate),
  };
}

// ---------------------------------------------------------------------------
// Committee totals + overview
// ---------------------------------------------------------------------------

export type DenverFinancialOverview = {
  fairElectionsFundToCandidateCents: number;
  campaignContributionsToCandidateCents: number;
  independentExpendituresSupportingCandidateCents: number;
  independentExpendituresOpposingCandidateCents: number;
  fairElectionsFundToOthersCents: number;
  campaignContributionsToOthersCents: number;
  independentExpendituresSupportingOthersCents: number;
  independentExpendituresOpposingOthersCents: number;
};

export async function getDenverFinancialOverview(
  input: { filerId: number; electionCycleId: number },
  options: DenverSearchlightClientOptions = {}
): Promise<DenverFinancialOverview> {
  requirePositiveInteger(input.filerId, "filer id");
  requirePositiveInteger(input.electionCycleId, "election cycle id");
  const payload = await fetchSearchlightJson(
    `/api/committee/getFinancialOverviewByCandCommittee?filerId=${input.filerId}&electionCycleId=${input.electionCycleId}`,
    { method: "GET" },
    options
  );
  const row = requireRecord(payload, "financial overview");
  return {
    fairElectionsFundToCandidateCents: moneyToCents(row.fairElectionsFundToCandidate, "overview fairElectionsFundToCandidate"),
    campaignContributionsToCandidateCents: moneyToCents(
      row.campaignContributionsToCandidate,
      "overview campaignContributionsToCandidate"
    ),
    independentExpendituresSupportingCandidateCents: moneyToCents(
      row.independentExpendituresSupportingCandidate,
      "overview independentExpendituresSupportingCandidate"
    ),
    independentExpendituresOpposingCandidateCents: moneyToCents(
      row.independentExpendituresOpposingCandidate,
      "overview independentExpendituresOpposingCandidate"
    ),
    fairElectionsFundToOthersCents: moneyToCents(row.fairElectionsFundToOthers, "overview fairElectionsFundToOthers"),
    campaignContributionsToOthersCents: moneyToCents(
      row.campaignContributionsToOthers,
      "overview campaignContributionsToOthers"
    ),
    independentExpendituresSupportingOthersCents: moneyToCents(
      row.independentExpendituresSupportingOthers,
      "overview independentExpendituresSupportingOthers"
    ),
    independentExpendituresOpposingOthersCents: moneyToCents(
      row.independentExpendituresOpposingOthers,
      "overview independentExpendituresOpposingOthers"
    ),
  };
}

async function fetchCommitteeTotalCents(
  path: string,
  input: { filerId: number; electionCycleId: number },
  options: DenverSearchlightClientOptions
): Promise<number> {
  requirePositiveInteger(input.filerId, "filer id");
  requirePositiveInteger(input.electionCycleId, "election cycle id");
  const payload = await fetchSearchlightJson(
    `${path}?filerId=${input.filerId}&electionCycleId=${input.electionCycleId}`,
    { method: "GET" },
    options
  );
  const row = requireRecord(payload, "committee total");
  return moneyToCents(row.total, "committee total");
}

/** Includes Fair Elections Fund payments (verified live: 658/26 = private + FEF). */
export function getDenverContributionsTotalCents(
  input: { filerId: number; electionCycleId: number },
  options: DenverSearchlightClientOptions = {}
): Promise<number> {
  return fetchCommitteeTotalCents("/api/Committee/getContributionsTotalByCommittee", input, options);
}

/** Includes FEF-funded spending (verified live: FEF endpoints report subsets). */
export function getDenverExpendituresTotalCents(
  input: { filerId: number; electionCycleId: number },
  options: DenverSearchlightClientOptions = {}
): Promise<number> {
  return fetchCommitteeTotalCents("/api/Committee/getExpendituresTotalByCommittee", input, options);
}

/** FEF subset of the contributions total — reconciliation only, never additive. */
export function getDenverFefContributionsTotalCents(
  input: { filerId: number; electionCycleId: number },
  options: DenverSearchlightClientOptions = {}
): Promise<number> {
  return fetchCommitteeTotalCents("/api/Committee/GetFEFContributionTotalByCommittee", input, options);
}

/** FEF subset of the expenditures total — reconciliation only, never additive. */
export function getDenverFefExpendituresTotalCents(
  input: { filerId: number; electionCycleId: number },
  options: DenverSearchlightClientOptions = {}
): Promise<number> {
  return fetchCommitteeTotalCents("/api/Committee/getFEFExpendituresTotalByCommittee", input, options);
}

// ---------------------------------------------------------------------------
// Outside spenders (server-aggregated, direction-labeled, no ids)
// ---------------------------------------------------------------------------

export type DenverOutsideSpender = {
  name: string;
  totalCents: number;
};

export async function getDenverOutsideSpenders(
  input: { filerId: number; electionCycleId: number; direction: "support" | "oppose" },
  options: DenverSearchlightClientOptions = {}
): Promise<DenverOutsideSpender[]> {
  requirePositiveInteger(input.filerId, "filer id");
  requirePositiveInteger(input.electionCycleId, "election cycle id");
  const positionType = DENVER_SEARCHLIGHT_POSITION_TYPE[input.direction];
  const payload = await fetchSearchlightJson(
    `/api/Committee/GetSupportingorOpposingIndependentSpendersByCommittee?filerId=${input.filerId}&electionCycleId=${input.electionCycleId}&positionType=${positionType}`,
    { method: "GET" },
    options
  );
  return requireArray(payload, "outside spenders").map((raw, index) => {
    const row = requireRecord(raw, `outside spender ${index}`);
    return {
      name: requireString(row.name, `outside spender ${index} name`),
      totalCents: moneyToCents(row.total, `outside spender ${index} total`),
    };
  });
}

// ---------------------------------------------------------------------------
// Committee / candidate / IE search (spender-id resolution)
// ---------------------------------------------------------------------------

/** type: 1 = committee, 2 = candidate, 3 = independent-expenditure entity. */
export type DenverSearchEntry = {
  uniqueId: string;
  id: number;
  name: string;
  type: number;
};

export const DENVER_SEARCHLIGHT_SEARCH_TYPE_INDEPENDENT_EXPENDITURE = 3;

export async function searchDenverCommitteesAndCandidates(
  search: string,
  options: DenverSearchlightClientOptions = {}
): Promise<DenverSearchEntry[]> {
  const normalized = search.trim();
  if (normalized.length === 0) {
    throw new DenverSearchlightClientError("invalid_request", "Denver SearchLight search term is required");
  }
  const payload = await fetchSearchlightJson(
    `/api/Committee/getAllCommitteesAndCandidate?search=${encodeURIComponent(normalized)}`,
    { method: "GET" },
    options
  );
  return requireArray(payload, "search results").map((raw, index) => {
    const row = requireRecord(raw, `search result ${index}`);
    return {
      uniqueId: requireString(row.uniqueId, `search result ${index} uniqueId`),
      id: requireInteger(row.id, `search result ${index} id`),
      name: requireString(row.name, `search result ${index} name`),
      type: requireInteger(row.type, `search result ${index} type`),
    };
  });
}

// ---------------------------------------------------------------------------
// Filings (versioned) + per-filing summary
// ---------------------------------------------------------------------------

export type DenverFiling = {
  filingId: number;
  filerId: number;
  entityId: number;
  electionCycleId: number;
  /**
   * Null for event-based filings (observed live: "Major Contributions
   * Report" rows come back from the filingTypeId=5 query with no period).
   * Period selection only applies to period reports — filter first.
   */
  filingPeriodId: number | null;
  filingPeriodName: string | null;
  filingTypeName: string | null;
  filingVersion: number;
  filingStatusName: string | null;
  filingTypeId: number | null;
  submittedDate: string | null;
  startDate: string | null;
  endDate: string | null;
};

/**
 * The endpoint returns an array of amendment chains (one inner array per
 * filing period, each entry one version). This returns the flattened rows;
 * latest-version selection is the caller's job so chain shape stays visible.
 */
export async function getDenverFilingsByCommittee(
  input: { committeeEntityId: number; filingTypeId?: number },
  options: DenverSearchlightClientOptions = {}
): Promise<DenverFiling[]> {
  requirePositiveInteger(input.committeeEntityId, "committee entity id");
  const filingTypeId =
    input.filingTypeId ?? DENVER_SEARCHLIGHT_CAMPAIGN_FINANCE_REPORT_FILING_TYPE_ID;
  requirePositiveInteger(filingTypeId, "filing type id");
  const payload = await fetchSearchlightJson(
    `/api/Filing/GetCampaignFilingByCommittee/Committee/?committeeId=${input.committeeEntityId}&filingTypeId=${filingTypeId}`,
    { method: "GET" },
    options
  );
  const chains = requireArray(payload, "filing chains");
  const filings: DenverFiling[] = [];
  for (const [chainIndex, chain] of chains.entries()) {
    for (const [rowIndex, raw] of requireArray(chain, `filing chain ${chainIndex}`).entries()) {
      const row = requireRecord(raw, `filing chain ${chainIndex} row ${rowIndex}`);
      filings.push({
        filingId: requireInteger(row.filingId, `filing chain ${chainIndex} row ${rowIndex} filingId`),
        filerId: requireInteger(row.filerId, `filing chain ${chainIndex} row ${rowIndex} filerId`),
        entityId: requireInteger(row.entityId, `filing chain ${chainIndex} row ${rowIndex} entityId`),
        electionCycleId: requireInteger(
          row.electionCycleId,
          `filing chain ${chainIndex} row ${rowIndex} electionCycleId`
        ),
        filingPeriodId: optionalInteger(row.filingPeriodId),
        filingPeriodName: optionalTrimmedString(row.filingPeriodName),
        filingTypeName: optionalTrimmedString(row.filingTypeName),
        filingVersion: requireInteger(
          row.filingVersion,
          `filing chain ${chainIndex} row ${rowIndex} filingVersion`
        ),
        filingStatusName: optionalTrimmedString(row.filingStatusName),
        filingTypeId: optionalInteger(row.filingTypeId),
        submittedDate: optionalTrimmedString(row.submittedDate),
        startDate: optionalTrimmedString(row.startDate),
        endDate: optionalTrimmedString(row.endDate),
      });
    }
  }
  return filings;
}

/**
 * Latest filingVersion per filingPeriodId — the in-force period-report set.
 * Callers must filter to period reports first; an event-based filing (null
 * period) here is a programming error, not vendor drift.
 */
export function selectLatestDenverFilings(filings: readonly DenverFiling[]): DenverFiling[] {
  const byPeriod = new Map<number, DenverFiling>();
  for (const filing of filings) {
    if (filing.filingPeriodId === null) {
      throw new DenverSearchlightClientError(
        "invalid_request",
        `Denver SearchLight filing ${filing.filingId} has no filing period; filter event-based filings out before selection`
      );
    }
    const current = byPeriod.get(filing.filingPeriodId);
    if (current === undefined || filing.filingVersion > current.filingVersion) {
      byPeriod.set(filing.filingPeriodId, filing);
      continue;
    }
    if (filing.filingVersion === current.filingVersion && filing.filingId !== current.filingId) {
      throw new DenverSearchlightClientError(
        "bad_response",
        `Denver SearchLight filing period ${filing.filingPeriodId} has two filings (${current.filingId}, ${filing.filingId}) with the same version ${filing.filingVersion}`
      );
    }
  }
  return [...byPeriod.values()].sort(
    (a, b) =>
      (a.startDate ?? "").localeCompare(b.startDate ?? "") ||
      (a.filingPeriodId ?? 0) - (b.filingPeriodId ?? 0)
  );
}

export type DenverFilingSummary = {
  openingBalanceCents: number;
  totalMonetaryContributionsCents: number;
  totalFefQualifyingContributionsCents: number;
  totalInKindContributionsCents: number;
  totalRefundsCents: number;
  totalExpendituresCents: number;
  totalFairElectionExpendituresCents: number;
  totalOtherExpendituresCents: number;
  totalFairElectionsFundingCents: number;
  totalNewLoansCents: number;
  totalLoanBalanceCents: number;
  closingBalanceCents: number;
  totalNonDonorFundsCents: number;
};

export async function getDenverFilingSummary(
  filingId: number,
  options: DenverSearchlightClientOptions = {}
): Promise<DenverFilingSummary> {
  requirePositiveInteger(filingId, "filing id");
  const payload = await fetchSearchlightJson(
    `/api/filing/GetSummaryInfoByFiling?filingId=${filingId}`,
    { method: "GET" },
    options
  );
  const row = requireRecord(payload, "filing summary");
  return {
    openingBalanceCents: moneyToCents(row.openingBalance, "filing summary openingBalance"),
    totalMonetaryContributionsCents: moneyToCents(
      row.totalMonetaryContributions,
      "filing summary totalMonetaryContributions"
    ),
    totalFefQualifyingContributionsCents: moneyToCents(
      row.totalFEFQualifyingContributions,
      "filing summary totalFEFQualifyingContributions"
    ),
    totalInKindContributionsCents: moneyToCents(row.totalInKindContributions, "filing summary totalInKindContributions"),
    totalRefundsCents: moneyToCents(row.totalRefunds, "filing summary totalRefunds"),
    totalExpendituresCents: moneyToCents(row.totalExpenditures, "filing summary totalExpenditures"),
    totalFairElectionExpendituresCents: moneyToCents(
      row.totalFairElectionExpenditures,
      "filing summary totalFairElectionExpenditures"
    ),
    totalOtherExpendituresCents: moneyToCents(row.totalOtherExpenditures, "filing summary totalOtherExpenditures"),
    totalFairElectionsFundingCents: moneyToCents(
      row.totalFairElectionsFunding,
      "filing summary totalFairElectionsFunding"
    ),
    totalNewLoansCents: moneyToCents(row.totalNewLoans, "filing summary totalNewLoans"),
    totalLoanBalanceCents: moneyToCents(row.totalLoanBalance, "filing summary totalLoanBalance"),
    closingBalanceCents: moneyToCents(row.closingBalance, "filing summary closingBalance"),
    totalNonDonorFundsCents: moneyToCents(row.totalNonDonorFunds, "filing summary totalNonDonorFunds"),
  };
}

// ---------------------------------------------------------------------------
// Transaction search (POST) — contributions and expenditures
// ---------------------------------------------------------------------------

export type DenverTransactionSearchFilter = {
  candidateName?: string | null;
  electionCycleIds?: readonly number[] | null;
  /**
   * Recipient id filter. Verified live 2026-08-12: the server returns ZERO
   * rows for both filer ids and committee entity ids — the filter is broken
   * vendor-side. Exposed so the probe can pin that behavior; production
   * filtering uses candidateName + hard entity-id row checks instead.
   */
  contributionsToIds?: readonly number[] | null;
  pageNum: number;
  pageSize: number;
};

/** Body shape captured from the live site via XHR intercept (2026-08-12). */
export function buildDenverTransactionSearchBody(
  filter: DenverTransactionSearchFilter
): Record<string, unknown> {
  requirePositiveInteger(filter.pageNum, "search pageNum");
  const pageSize = requirePositiveInteger(filter.pageSize, "search pageSize");
  if (pageSize > DENVER_SEARCHLIGHT_MAX_PAGE_SIZE) {
    throw new DenverSearchlightClientError(
      "invalid_request",
      `Denver SearchLight search pageSize must be at most ${DENVER_SEARCHLIGHT_MAX_PAGE_SIZE}`
    );
  }
  const candidateName = optionalTrimmedString(filter.candidateName ?? null);
  const electionCycleIds =
    filter.electionCycleIds && filter.electionCycleIds.length > 0
      ? filter.electionCycleIds.map((id) => requirePositiveInteger(id, "search electionCycleIds entry"))
      : null;
  const contributionsToIds =
    filter.contributionsToIds && filter.contributionsToIds.length > 0
      ? filter.contributionsToIds.map((id) => requirePositiveInteger(id, "search contributionsToIds entry"))
      : null;
  return {
    ballotIssue: null,
    candidateName,
    committeeName: null,
    committeePosition: null,
    contributionsFrom: null,
    contributionsFromCityStateCode: null,
    contributionsToIds,
    electionCycleIds,
    isBallotIssue: false,
    isCandidate: false,
    ballotIssueId: null,
    candidateOfficeSoughtId: null,
    transactionFromDate: null,
    transactionToDate: null,
    transactionSubTypeId: null,
    pageNum: filter.pageNum,
    pageSize,
  };
}

/**
 * Contribution transaction row. Built from an explicit allowlist; the raw row
 * also carries address1/address2/zipCode (contributor street address) which
 * are deliberately never mapped.
 */
export type DenverContributionTransaction = {
  transactionId: number;
  transactionSubType: string;
  recipientName: string | null;
  recipientCommitteeName: string | null;
  recipientCommitteeId: number;
  officeSought: string | null;
  district: string | null;
  contributorName: string | null;
  /** Native organization label; not a registry identity. */
  organizationName?: string | null;
  contributorId: number | null;
  amountCents: number;
  date: string | null;
  contributorEmployer: string | null;
  contributorOccupation: string | null;
  contributorCity: string | null;
  contributorStateCode: string | null;
  contactTypeId: number | null;
  txnPurpose: string | null;
  fefTransaction: boolean;
};

export type DenverContributionSearchPage = {
  totalContributionAmountCents: number;
  totalContributionCount: number;
  rows: DenverContributionTransaction[];
};

function contributionRowFromRaw(raw: unknown, index: number): DenverContributionTransaction {
  const row = requireRecord(raw, `contribution transaction ${index}`);
  return {
    transactionId: requireInteger(row.transactionId, `contribution transaction ${index} transactionId`),
    transactionSubType: requireString(row.transactionSubType, `contribution transaction ${index} transactionSubType`),
    recipientName: optionalTrimmedString(row.recipientName),
    recipientCommitteeName: optionalTrimmedString(row.recipientCommitteeName),
    recipientCommitteeId: requireInteger(
      row.recipientCommitteeId,
      `contribution transaction ${index} recipientCommitteeId`
    ),
    officeSought: optionalTrimmedString(row.officeSought),
    district: optionalTrimmedString(row.district),
    contributorName: optionalTrimmedString(row.contributorName),
    organizationName: optionalTrimmedString(row.orgName),
    contributorId: optionalInteger(row.contributorId),
    amountCents: moneyToCents(row.amount, `contribution transaction ${index} amount`),
    date: optionalTrimmedString(row.date),
    contributorEmployer: optionalTrimmedString(row.contributorEmployer),
    contributorOccupation: optionalTrimmedString(row.contributorOccupation),
    contributorCity: optionalTrimmedString(row.contributorCity),
    contributorStateCode: optionalTrimmedString(row.contributorStateCode),
    contactTypeId: optionalInteger(row.contactTypeId),
    txnPurpose: optionalTrimmedString(row.txnPurpose),
    fefTransaction: requireBoolean(row.fefTransaction, `contribution transaction ${index} fefTransaction`),
  };
}

export async function searchDenverContributionTransactions(
  filter: DenverTransactionSearchFilter,
  options: DenverSearchlightClientOptions = {}
): Promise<DenverContributionSearchPage> {
  const payload = await fetchSearchlightJson(
    "/api/Transaction/SearchContributionTransactions",
    { method: "POST", body: buildDenverTransactionSearchBody(filter) },
    options
  );
  const row = requireRecord(payload, "contribution search response");
  return {
    totalContributionAmountCents: moneyToCents(row.totalContributionAmount, "contribution search totalContributionAmount"),
    totalContributionCount: requireInteger(row.totalRecords, "contribution search totalRecords"),
    rows: requireArray(row.searchContributionTransactions, "contribution search rows").map(contributionRowFromRaw),
  };
}

/**
 * Expenditure transaction row (allowlist; raw rows carry payee street
 * addresses — never mapped). NOTE: the candidate-name search returns the
 * committee's direct spending AND independent expenditures targeting the
 * candidate; the header total mixes them. Callers must post-filter by
 * transactionSubType/independentExpnFlag and must never publish the header.
 */
export type DenverExpenditureTransaction = {
  transactionId: number;
  transactionSubType: string;
  committeeName: string | null;
  committeeId: number;
  candidateName: string | null;
  candidateOffice: string | null;
  candidateDistrict: string | null;
  amountCents: number;
  date: string | null;
  purpose: string | null;
  payee: string | null;
  contactTypeId: number | null;
  fefTransaction: boolean;
  electioneeringCommFlag: boolean;
  independentExpnFlag: boolean;
};

export type DenverExpenditureSearchPage = {
  totalExpendituresAmountCents: number;
  totalExpendituresCount: number;
  rows: DenverExpenditureTransaction[];
};

function expenditureRowFromRaw(raw: unknown, index: number): DenverExpenditureTransaction {
  const row = requireRecord(raw, `expenditure transaction ${index}`);
  return {
    transactionId: requireInteger(row.transactionId, `expenditure transaction ${index} transactionId`),
    transactionSubType: requireString(row.transactionSubType, `expenditure transaction ${index} transactionSubType`),
    committeeName: optionalTrimmedString(row.committeeName),
    committeeId: requireInteger(row.committeeId, `expenditure transaction ${index} committeeId`),
    candidateName: optionalTrimmedString(row.candidateName),
    candidateOffice: optionalTrimmedString(row.candidateOffice),
    candidateDistrict: optionalTrimmedString(row.candidateDistrict),
    amountCents: moneyToCents(row.amount, `expenditure transaction ${index} amount`),
    date: optionalTrimmedString(row.date),
    purpose: optionalTrimmedString(row.purpose),
    payee: optionalTrimmedString(row.payee),
    contactTypeId: optionalInteger(row.contactTypeId),
    fefTransaction: requireBoolean(row.fefTransaction, `expenditure transaction ${index} fefTransaction`),
    electioneeringCommFlag: requireBoolean(
      row.electioneeringCommFlag,
      `expenditure transaction ${index} electioneeringCommFlag`
    ),
    independentExpnFlag: requireBoolean(
      row.independentExpnFlag,
      `expenditure transaction ${index} independentExpnFlag`
    ),
  };
}

export async function searchDenverExpenditureTransactions(
  filter: DenverTransactionSearchFilter,
  options: DenverSearchlightClientOptions = {}
): Promise<DenverExpenditureSearchPage> {
  const payload = await fetchSearchlightJson(
    "/api/Transaction/SearchExpenditureTransactions",
    { method: "POST", body: buildDenverTransactionSearchBody(filter) },
    options
  );
  const row = requireRecord(payload, "expenditure search response");
  return {
    totalExpendituresAmountCents: moneyToCents(row.totalExpendituresAmount, "expenditure search totalExpendituresAmount"),
    totalExpendituresCount: requireInteger(row.totalExpendituresCount, "expenditure search totalExpendituresCount"),
    rows: requireArray(row.searchExpendituresTransactions, "expenditure search rows").map(expenditureRowFromRaw),
  };
}

// ---------------------------------------------------------------------------
// Full sweeps (paged)
// ---------------------------------------------------------------------------

export type DenverSweepOptions = DenverSearchlightClientOptions & {
  pageSize?: number;
  maxPages?: number;
};

async function sweepPages<TPage extends { rows: unknown[] }, TRow>(
  fetchPage: (pageNum: number, pageSize: number) => Promise<TPage>,
  extractRows: (page: TPage) => TRow[],
  expectedTotal: (page: TPage) => number,
  sweepOptions: DenverSweepOptions
): Promise<{ firstPage: TPage; rows: TRow[] }> {
  const pageSize = requirePositiveInteger(
    sweepOptions.pageSize ?? DENVER_SEARCHLIGHT_DEFAULT_PAGE_SIZE,
    "sweep pageSize"
  );
  const maxPages = requirePositiveInteger(
    sweepOptions.maxPages ?? DENVER_SEARCHLIGHT_DEFAULT_MAX_PAGES,
    "sweep maxPages"
  );
  const rows: TRow[] = [];
  let firstPage: TPage | null = null;
  for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
    const page = await fetchPage(pageNum, pageSize);
    if (firstPage === null) {
      firstPage = page;
    }
    const pageRows = extractRows(page);
    rows.push(...pageRows);
    if (pageRows.length < pageSize) {
      if (rows.length !== expectedTotal(firstPage)) {
        throw new DenverSearchlightClientError(
          "bad_response",
          `Denver SearchLight sweep collected ${rows.length} rows but the header reported ${expectedTotal(firstPage)}`
        );
      }
      return { firstPage, rows };
    }
  }
  throw new DenverSearchlightClientError(
    "bad_response",
    `Denver SearchLight sweep exceeded ${maxPages} pages at page size ${pageSize}`
  );
}

export async function sweepDenverContributionTransactions(
  filter: Omit<DenverTransactionSearchFilter, "pageNum" | "pageSize">,
  options: DenverSweepOptions = {}
): Promise<{ totalContributionAmountCents: number; totalContributionCount: number; rows: DenverContributionTransaction[] }> {
  const { firstPage, rows } = await sweepPages(
    (pageNum, pageSize) => searchDenverContributionTransactions({ ...filter, pageNum, pageSize }, options),
    (page) => page.rows,
    (page) => page.totalContributionCount,
    options
  );
  return {
    totalContributionAmountCents: firstPage.totalContributionAmountCents,
    totalContributionCount: firstPage.totalContributionCount,
    rows,
  };
}

export async function sweepDenverExpenditureTransactions(
  filter: Omit<DenverTransactionSearchFilter, "pageNum" | "pageSize">,
  options: DenverSweepOptions = {}
): Promise<{ totalExpendituresAmountCents: number; totalExpendituresCount: number; rows: DenverExpenditureTransaction[] }> {
  const { firstPage, rows } = await sweepPages(
    (pageNum, pageSize) => searchDenverExpenditureTransactions({ ...filter, pageNum, pageSize }, options),
    (page) => page.rows,
    (page) => page.totalExpendituresCount,
    options
  );
  return {
    totalExpendituresAmountCents: firstPage.totalExpendituresAmountCents,
    totalExpendituresCount: firstPage.totalExpendituresCount,
    rows,
  };
}
