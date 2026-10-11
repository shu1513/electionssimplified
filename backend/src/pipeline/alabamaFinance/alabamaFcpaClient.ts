// Read-only client for the Alabama FCPA public portal (Tyler entellitrak app
// at fcpa.alabamavotes.gov). Phase 0 scope: race summaries, committee search,
// bulk-extract catalog/download, filings list, filing-detail pages. See
// docs/plans/plan-alabama-finance.md and backend/docs/alabama-campaign-finance.md.

import { unzipSync } from "fflate";

import { createAlabamaFcpaDispatcher } from "./alabamaFcpaTls.js";

export const ALABAMA_FCPA_BASE_URL = "https://fcpa.alabamavotes.gov";

export type AlabamaFcpaClientErrorCode =
  | "invalid_request"
  | "network_error"
  | "http_error"
  | "bad_response";

export class AlabamaFcpaClientError extends Error {
  constructor(
    public readonly code: AlabamaFcpaClientErrorCode,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "AlabamaFcpaClientError";
  }
}

export type AlabamaFcpaClientOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_USER_AGENT = "VoteApp Alabama campaign finance research";
const MAX_PAGES = 200;

let sharedDispatcher: ReturnType<typeof createAlabamaFcpaDispatcher> | null = null;

function defaultFetch(url: string, init: RequestInit): Promise<Response> {
  sharedDispatcher ??= createAlabamaFcpaDispatcher();
  return fetch(url, { ...init, dispatcher: sharedDispatcher } as RequestInit);
}

async function requestRaw(
  path: string,
  params: Record<string, string>,
  options: AlabamaFcpaClientOptions
): Promise<Response> {
  const url = new URL(path, ALABAMA_FCPA_BASE_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: { "user-agent": options.userAgent ?? DEFAULT_USER_AGENT },
      redirect: "follow",
    });
  } catch (error) {
    throw new AlabamaFcpaClientError(
      "network_error",
      `Alabama FCPA request failed: ${url} (${error instanceof Error ? error.message : String(error)})`
    );
  }
  if (!response.ok) {
    throw new AlabamaFcpaClientError(
      "http_error",
      `Alabama FCPA request returned HTTP ${response.status}: ${url}`,
      response.status
    );
  }
  return response;
}

type AlabamaListEnvelope<TRow> = {
  data?: { totalRecords?: number; list?: TRow[] };
  success?: boolean;
};

async function requestListPage<TRow>(
  page: string,
  params: Record<string, string>,
  options: AlabamaFcpaClientOptions
): Promise<{ totalRecords: number; list: TRow[] }> {
  const response = await requestRaw("/page.request.do", { page, ...params }, options);
  let body: AlabamaListEnvelope<TRow>;
  try {
    body = (await response.json()) as AlabamaListEnvelope<TRow>;
  } catch {
    throw new AlabamaFcpaClientError("bad_response", `Alabama FCPA page ${page} did not return JSON`);
  }
  const totalRecords = body.data?.totalRecords;
  const list = body.data?.list;
  if (body.success !== true || typeof totalRecords !== "number" || !Array.isArray(list)) {
    throw new AlabamaFcpaClientError(
      "bad_response",
      `Alabama FCPA page ${page} returned an unexpected envelope`
    );
  }
  return { totalRecords, list };
}

async function requestAllPages<TRow>(
  page: string,
  params: Record<string, string>,
  pageSize: number,
  options: AlabamaFcpaClientOptions,
  strict = false
): Promise<TRow[]> {
  const rows: TRow[] = [];
  let expected: number | null = null;
  let exhausted = false;
  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
    const result = await requestListPage<TRow>(
      page,
      { ...params, pageNumber: String(pageNumber), pageSize: String(pageSize) },
      options
    );
    expected ??= result.totalRecords;
    if (strict && (!Number.isSafeInteger(result.totalRecords) || result.totalRecords < 0
      || result.list.length > pageSize || rows.length + result.list.length > result.totalRecords)) {
      throw new AlabamaFcpaClientError("bad_response", `Alabama FCPA page ${page} has invalid complete-list coverage`);
    }
    if (result.totalRecords !== expected) {
      throw new AlabamaFcpaClientError(
        "bad_response",
        `Alabama FCPA page ${page} totalRecords changed mid-pagination (${expected} -> ${result.totalRecords})`
      );
    }
    rows.push(...result.list);
    if (rows.length >= expected) break;
    if (result.list.length === 0) {
      // The portal exhausted its own list below its advertised count. Seen
      // live 2026-09-01 on committee 7460's filings (totalRecords 17, 16 rows
      // at every page size, page 3 empty) — a count that includes a row the
      // list never renders. Tolerated only for a one-row shortfall; anything
      // larger is treated as a truncated read.
      exhausted = true;
      break;
    }
  }
  const shortfall = expected === null ? 0 : expected - rows.length;
  if (shortfall > 0 && !(!strict && exhausted && shortfall === 1)) {
    throw new AlabamaFcpaClientError(
      "bad_response",
      `Alabama FCPA page ${page} returned ${rows.length} of ${expected} rows`
    );
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Race search dropdown id maps

export type AlabamaSelectOption = { id: string; label: string };

export type AlabamaRaceSearchIds = {
  elections: AlabamaSelectOption[];
  offices: AlabamaSelectOption[];
};

function parseSelectOptions(html: string, selectId: string): AlabamaSelectOption[] {
  const selectMatch = new RegExp(`<select[^>]*id="${selectId}"([\\s\\S]*?)</select>`).exec(html);
  if (!selectMatch) {
    throw new AlabamaFcpaClientError("bad_response", `Race search page has no <select id="${selectId}">`);
  }
  const options: AlabamaSelectOption[] = [];
  const optionPattern = /<option[^>]*value="([^"]*)"[^>]*>([^<]*)/g;
  for (let match = optionPattern.exec(selectMatch[1]!); match; match = optionPattern.exec(selectMatch[1]!)) {
    const id = match[1]!.trim();
    const label = match[2]!.trim();
    if (id) options.push({ id, label });
  }
  if (options.length === 0) {
    throw new AlabamaFcpaClientError("bad_response", `Race search <select id="${selectId}"> has no options`);
  }
  return options;
}

export async function getAlabamaRaceSearchIds(
  options: AlabamaFcpaClientOptions = {}
): Promise<AlabamaRaceSearchIds> {
  const response = await requestRaw(
    "/page.request.do",
    { page: "page.acfPublicPoliticalRaceSearch" },
    options
  );
  const html = await response.text();
  return {
    elections: parseSelectOptions(html, "election"),
    offices: parseSelectOptions(html, "office"),
  };
}

// ---------------------------------------------------------------------------
// Political race search (cycle summaries per candidate committee)

export type AlabamaRaceRow = {
  COMMITTEEID: number;
  CANDIDATE: string;
  CANDIDATESTATUS: string | null;
  BEGINNINGFUNDS: number;
  MONETARYCONTRIB: number;
  MONETARYEXP: number;
  NONMONETARYCONTRIB: number;
  OTHERSOURCES: number;
  ENDINGFUNDS: number;
  YEAR: number | null;
};

export async function getAlabamaRaceRows(
  input: { electionId: string; officeId: string; pageSize?: number },
  options: AlabamaFcpaClientOptions = {}
): Promise<AlabamaRaceRow[]> {
  // Never pass the year param: it takes internal option ids with a different
  // year attribution than the extracts. The no-year response is the cycle
  // aggregate (docs/plans/plan-alabama-finance.md, gotcha 1).
  return requestAllPages<AlabamaRaceRow>(
    "com.acf.common.page.politicalracesearchresults",
    {
      sortDirection: "ASC",
      sortBy: "candidate",
      election: input.electionId,
      office: input.officeId,
    },
    input.pageSize ?? 100,
    options
  );
}

// ---------------------------------------------------------------------------
// Principal campaign committee search (internal id <-> FCPA committee number)

export type AlabamaCommitteeSearchRow = {
  id: number;
  committeeId: string;
  committeeName?: string | null;
  candidateFirstName?: string | null;
  candidateMiddleName?: string | null;
  candidateLastName?: string | null;
  city?: string | null;
  committeeStatus?: string | null;
  office?: string | null;
  party?: string | null;
  jurisdiction?: string | null;
  place?: string | null;
  committeeState?: string | null;
  registeredDate?: string | null;
};

/** Type comes from the registry query: the public rows omit committeeType. */
export type AlabamaCommitteeRegistryRow = AlabamaCommitteeSearchRow & {
  committeeType: "1" | "2";
};

/**
 * Complete all-status PCC and PAC registry. Unlike the legacy filings pager,
 * identity acquisition cannot accept an advertised one-row shortfall.
 * Identical duplicates occur in the official PAC registry; conflicting public
 * or internal identities invalidate the whole registry.
 */
export async function getAlabamaCommitteeRegistry(
  options: AlabamaFcpaClientOptions = {}
): Promise<AlabamaCommitteeRegistryRow[]> {
  const rows: AlabamaCommitteeRegistryRow[] = [];
  const byInternalId = new Map<number, string>();
  const byPublicId = new Map<string, number>();
  const optionalTextFields = [
    "committeeName", "candidateFirstName", "candidateMiddleName", "candidateLastName",
    "city", "committeeStatus", "office", "party", "jurisdiction", "place",
    "committeeState", "registeredDate",
  ];
  for (const committeeType of ["1", "2"] as const) {
    let expected: number | undefined;
    let acquired = 0;
    const pageFingerprints = new Set<string>();
    for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
      const page = await requestListPage<Record<string, unknown>>(
        "com.acf.common.page.committeesearchresults",
        {
          sortDirection: "ASC",
          sortBy: "id",
          criteria: JSON.stringify([{
            field_key: "committeeType", comparison_type: "equalTo",
            comparison_value_1: committeeType,
          }]),
          pageNumber: String(pageNumber), pageSize: "1000",
        },
        options
      );
      if (!Number.isSafeInteger(page.totalRecords) || page.totalRecords < 0) {
        throw new AlabamaFcpaClientError("bad_response", "Alabama registry has an invalid totalRecords");
      }
      expected ??= page.totalRecords;
      if (page.totalRecords !== expected) {
        throw new AlabamaFcpaClientError("bad_response", "Alabama registry totalRecords changed mid-pagination");
      }
      if (page.list.length > 1000 || acquired + page.list.length > expected) {
        throw new AlabamaFcpaClientError("bad_response", "Alabama registry exceeded its advertised row count");
      }
      const normalizedPage: string[] = [];
      for (const raw of page.list) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)
          || typeof raw.id !== "number" || !Number.isSafeInteger(raw.id) || raw.id <= 0
          || typeof raw.committeeId !== "string" || !/^[1-9]\d*$/.test(raw.committeeId)
          || !Number.isSafeInteger(Number(raw.committeeId))
          || optionalTextFields.some((key) => raw[key] !== undefined && raw[key] !== null && typeof raw[key] !== "string")
          || (raw.committeeType !== undefined && raw.committeeType !== committeeType)) {
          throw new AlabamaFcpaClientError("bad_response", "Alabama registry returned an invalid committee identity");
        }
        const fingerprint = JSON.stringify(Object.fromEntries(
          Object.keys(raw).sort().map((key) => [key, raw[key]])
        ));
        normalizedPage.push(fingerprint);
        const identity = JSON.stringify([committeeType, fingerprint]);
        const prior = byInternalId.get(raw.id);
        const priorPublic = byPublicId.get(raw.committeeId);
        if ((prior !== undefined && prior !== identity)
          || (priorPublic !== undefined && priorPublic !== raw.id)) {
          throw new AlabamaFcpaClientError("bad_response", "Alabama registry returned conflicting committee identities");
        }
        if (prior === undefined) {
          byInternalId.set(raw.id, identity);
          byPublicId.set(raw.committeeId, raw.id);
          rows.push({ ...(raw as AlabamaCommitteeSearchRow), committeeType });
        }
      }
      const pageFingerprint = JSON.stringify(normalizedPage);
      if (page.list.length > 0 && pageFingerprints.has(pageFingerprint)) {
        throw new AlabamaFcpaClientError("bad_response", "Alabama registry repeated a page");
      }
      pageFingerprints.add(pageFingerprint);
      acquired += page.list.length;
      if (acquired === expected) break;
      if (page.list.length === 0 || pageNumber === MAX_PAGES) {
        throw new AlabamaFcpaClientError("bad_response", `Alabama registry returned ${acquired} of ${expected} rows`);
      }
    }
  }
  return rows;
}

export type AlabamaCommitteeSearchCriteria = {
  candidateLastName?: string;
  committeeId?: string;
  officeId?: string;
  statusId?: string;
};

export async function searchAlabamaPrincipalCampaignCommittees(
  criteria: AlabamaCommitteeSearchCriteria,
  options: AlabamaFcpaClientOptions = {}
): Promise<AlabamaCommitteeSearchRow[]> {
  const fields: Array<{ field_key: string; comparison_type: string; comparison_value_1: string }> = [];
  if (criteria.candidateLastName) {
    fields.push({
      field_key: "candidateLastName",
      comparison_type: "contains",
      comparison_value_1: criteria.candidateLastName,
    });
  }
  if (criteria.committeeId) {
    fields.push({ field_key: "committeeId", comparison_type: "equalTo", comparison_value_1: criteria.committeeId });
  }
  if (criteria.officeId) {
    fields.push({ field_key: "office", comparison_type: "equalTo", comparison_value_1: criteria.officeId });
  }
  if (criteria.statusId) {
    fields.push({ field_key: "committeeStatus", comparison_type: "equalTo", comparison_value_1: criteria.statusId });
  }
  if (fields.length === 0) {
    throw new AlabamaFcpaClientError("invalid_request", "Committee search needs at least one criterion");
  }
  // The portal requires the committee-type criterion; 1 = principal campaign
  // committee (candidate committees).
  fields.push({ field_key: "committeeType", comparison_type: "equalTo", comparison_value_1: "1" });
  return requestAllPages<AlabamaCommitteeSearchRow>(
    "com.acf.common.page.committeesearchresults",
    {
      sortDirection: "ASC",
      sortBy: "candidateLastName",
      criteria: JSON.stringify(fields),
    },
    50,
    options
  );
}

// ---------------------------------------------------------------------------
// Bulk-extract catalog + download

export type AlabamaExtractCatalogRow = {
  DATATYPE: string;
  YEAR: number;
  LASTUPDATED: string;
  LASTUPDATEDRAW: string;
  DOWNLOAD: number;
};

export async function getAlabamaExtractCatalog(
  options: AlabamaFcpaClientOptions = {}
): Promise<AlabamaExtractCatalogRow[]> {
  return requestAllPages<AlabamaExtractCatalogRow>(
    "com.acf.common.page.transactiondatadownloadsresults",
    { sortDirection: "ASC", sortBy: "state" },
    100,
    options
  );
}

export type AlabamaExtractDownload = {
  fileName: string;
  csvText: string;
  zipByteCount: number;
};

/**
 * Unzip one extract archive to its single CSV. Throws on non-zip bytes (the
 * portal serves error/login pages as HTTP-200 HTML), empty archives, and
 * multi-entry archives; `label` names the artifact in error messages.
 */
export function unzipAlabamaExtract(
  bytes: Uint8Array,
  label: string
): { fileName: string; csvText: string } {
  // Zip local-file signature "PK": anything else is not an archive — most
  // commonly an HTML error page.
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new AlabamaFcpaClientError(
      "bad_response",
      `Alabama extract ${label} is not a zip archive (HTML error page?)`
    );
  }
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new AlabamaFcpaClientError("bad_response", `Alabama extract ${label} is not a zip archive`);
  }
  const names = Object.keys(entries).filter((name) => name.toLowerCase().endsWith(".csv"));
  if (names.length !== 1) {
    throw new AlabamaFcpaClientError(
      "bad_response",
      `Alabama extract ${label} contains ${names.length} CSV entries; expected exactly 1`
    );
  }
  return {
    fileName: names[0]!,
    csvText: Buffer.from(entries[names[0]!]!).toString("utf8"),
  };
}

/** Raw zip bytes of one catalog download — the artifact the cache stores. */
export async function downloadAlabamaExtractZipBytes(
  downloadId: number,
  options: AlabamaFcpaClientOptions = {}
): Promise<Uint8Array> {
  const response = await requestRaw(
    "/page.request.do",
    { page: "getTransactionData", id: String(downloadId) },
    options
  );
  return new Uint8Array(await response.arrayBuffer());
}

export async function downloadAlabamaExtract(
  downloadId: number,
  options: AlabamaFcpaClientOptions = {}
): Promise<AlabamaExtractDownload> {
  const bytes = await downloadAlabamaExtractZipBytes(downloadId, options);
  const { fileName, csvText } = unzipAlabamaExtract(bytes, `download ${downloadId}`);
  return { fileName, csvText, zipByteCount: bytes.byteLength };
}

// ---------------------------------------------------------------------------
// Committee filings list + filing detail page

export type AlabamaCommitteeFilingRow = {
  ID: number;
  DESCRIPTION: string;
  PERIODBEGIN: string | null;
  PERIODEND: string | null;
  FILEDDATE: string | null;
  AMENDED: string | null;
};

/** Exact count and identity coverage for new authoritative source components. */
export async function getAlabamaCompleteCommitteeFilings(
  internalCommitteeId: number,
  options: AlabamaFcpaClientOptions = {}
): Promise<AlabamaCommitteeFilingRow[]> {
  if (!Number.isSafeInteger(internalCommitteeId) || internalCommitteeId <= 0) {
    throw new AlabamaFcpaClientError("invalid_request", "Invalid Alabama internal committee id");
  }
  const rows = await requestAllPages<AlabamaCommitteeFilingRow>(
    "com.acf.common.page.committeeelectronicfilingsresults",
    { sortDirection: "DESC", sortBy: "dueDate", committeeId: String(internalCommitteeId) },
    50, options, true
  );
  const ids = new Set<number>();
  for (const row of rows) {
    if (!row || !Number.isSafeInteger(row.ID) || row.ID <= 0 || ids.has(row.ID)
      || typeof row.DESCRIPTION !== "string"
      || [row.PERIODBEGIN, row.PERIODEND, row.FILEDDATE, row.AMENDED].some((v) => v !== null && typeof v !== "string")) {
      throw new AlabamaFcpaClientError("bad_response", "Alabama filing list has invalid or repeated identities");
    }
    ids.add(row.ID);
  }
  return rows;
}

export type AlabamaNativeContributionRow = {
  TRANSACTIONID: number;
  /** Internal receiving id; the request uses its public FCPA number. */
  COMMITTEEID: number;
  FILINGDATE: string;
  /** Historical non-itemized cash can omit this field or use null; retain that raw shape. */
  CONTRIBUTOR?: string | null;
  CITYSTATE?: string | null;
  ZIP?: string | null;
  CONTRIBUTIONTYPE: string;
  DESCRIPTION?: string | null;
  AMOUNT: number;
  TRANSACTIONDATE: string;
  RECIPIENTNAME: string;
};

/** Filter 4 proves PAC contributor type; the JSON rows themselves omit it. */
export async function getAlabamaNativeContributionRows(
  input: { fcpaCommitteeNumber: string; internalCommitteeId: number; pacOnly?: boolean },
  options: AlabamaFcpaClientOptions = {}
): Promise<AlabamaNativeContributionRow[]> {
  if (!/^[1-9]\d*$/.test(input.fcpaCommitteeNumber)
    || !Number.isSafeInteger(Number(input.fcpaCommitteeNumber))
    || !Number.isSafeInteger(input.internalCommitteeId) || input.internalCommitteeId <= 0) {
    throw new AlabamaFcpaClientError("invalid_request", "Invalid Alabama receipt committee identity");
  }
  const criteria = [
    { field_key: "committeeId", comparison_type: "equalTo", comparison_value_1: input.fcpaCommitteeNumber },
    ...(input.pacOnly ? [{ field_key: "contributorType", comparison_type: "equalTo", comparison_value_1: "4" }] : []),
  ];
  const rows = await requestAllPages<AlabamaNativeContributionRow>(
    "com.acf.common.page.contributionsearchresults",
    { sortDirection: "DESC", sortBy: "transactionId", criteria: JSON.stringify(criteria) },
    1000, options, true
  );
  const ids = new Set<number>();
  for (const row of rows) {
    if (!row || !Number.isSafeInteger(row.TRANSACTIONID) || row.TRANSACTIONID <= 0
      || ids.has(row.TRANSACTIONID) || row.COMMITTEEID !== input.internalCommitteeId
      || typeof row.AMOUNT !== "number" || !Number.isFinite(row.AMOUNT)
      || [row.FILINGDATE, row.CONTRIBUTIONTYPE, row.TRANSACTIONDATE, row.RECIPIENTNAME]
        .some((v) => typeof v !== "string")
      || (typeof row.CONTRIBUTOR !== "string"
        && !(row.CONTRIBUTOR == null && row.CONTRIBUTIONTYPE === "Cash (Non-Itemized)" && !input.pacOnly))
      || [row.CITYSTATE, row.ZIP, row.DESCRIPTION].some((v) => v != null && typeof v !== "string")) {
      throw new AlabamaFcpaClientError("bad_response", "Alabama receipt list has invalid or repeated identities");
    }
    ids.add(row.TRANSACTIONID);
  }
  return rows;
}

export async function getAlabamaCommitteeFilings(
  internalCommitteeId: number,
  options: AlabamaFcpaClientOptions = {}
): Promise<AlabamaCommitteeFilingRow[]> {
  return requestAllPages<AlabamaCommitteeFilingRow>(
    "com.acf.common.page.committeeelectronicfilingsresults",
    {
      sortDirection: "DESC",
      sortBy: "dueDate",
      committeeId: String(internalCommitteeId),
    },
    50,
    options
  );
}

export async function getAlabamaFilingDetailHtml(
  filingId: number,
  options: AlabamaFcpaClientOptions = {}
): Promise<string> {
  const response = await requestRaw(
    "/page.request.do",
    { page: "page.acfPublicFilingDetail", filingId: String(filingId) },
    options
  );
  const html = await response.text();
  if (html.includes("System Exception")) {
    throw new AlabamaFcpaClientError("bad_response", `Filing detail ${filingId} returned a System Exception page`);
  }
  return html;
}
