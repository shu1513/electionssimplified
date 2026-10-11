export const DISTRICT_OF_COLUMBIA_OCF_BASE_URL = "https://efiling.ocf.dc.gov";
export const DISTRICT_OF_COLUMBIA_OCF_DEFAULT_TIMEOUT_MS = 30_000;

export const DISTRICT_OF_COLUMBIA_OCF_FILER_TYPES = {
  principalCampaignCommittee: 2,
  independentExpenditureCommittee: 14,
} as const;

export type DistrictOfColumbiaOcfFilerTypeId =
  (typeof DISTRICT_OF_COLUMBIA_OCF_FILER_TYPES)[keyof typeof DISTRICT_OF_COLUMBIA_OCF_FILER_TYPES];

export type DistrictOfColumbiaOcfSearchType = "Contributions" | "Expenditures";

export type DistrictOfColumbiaOcfClientErrorCode =
  | "invalid_request"
  | "network_error"
  | "http_error"
  | "bad_response";

export class DistrictOfColumbiaOcfClientError extends Error {
  constructor(
    public readonly code: DistrictOfColumbiaOcfClientErrorCode,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "DistrictOfColumbiaOcfClientError";
  }
}

export type DistrictOfColumbiaOcfClientOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type DistrictOfColumbiaOcfExportInput = {
  filerTypeId: DistrictOfColumbiaOcfFilerTypeId;
  searchType: DistrictOfColumbiaOcfSearchType;
  fromDate?: string | null;
  toDate?: string | null;
};

export type DistrictOfColumbiaOcfDateWindow = {
  fromDate?: string | null;
  toDate?: string | null;
};

export type DistrictOfColumbiaOcfCsvRow = Record<string, string>;

export type DistrictOfColumbiaOcfContributionRecord = {
  committeeName?: string;
  committeeKey?: string;
  candidateName?: string;
  office?: string;
  seat?: string;
  electionYear?: number;
  contributorName?: string;
  contributorType?: string;
  employer?: string;
  occupation?: string;
  amount: number;
  date?: string;
  // Set only by the Fair Elections source, which labels each receipt by
  // schedule. Unset (every OCF export row) means a donor contribution.
  receiptKind?: DistrictOfColumbiaReceiptKind;
};

// "public_funds": Fair Elections base and matching payments (schedule A3).
// "other": interest, expenditure offsets, and prohibited contributions the
// committee must return. Neither counts as money raised from donors.
export type DistrictOfColumbiaReceiptKind = "contribution" | "public_funds" | "other";

export type DistrictOfColumbiaOcfExpenditureRecord = {
  committeeName?: string;
  committeeKey?: string;
  payeeName?: string;
  purpose?: string;
  furtherExplanation?: string;
  amount: number;
  date?: string;
};

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function normalizeDate(value: string | null | undefined, fieldName: string): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(normalized)) {
    throw new DistrictOfColumbiaOcfClientError(
      "invalid_request",
      `${fieldName} must use MM/DD/YYYY format for D.C. OCF exports`
    );
  }
  return normalized;
}

function normalizeFilerTypeId(value: number): DistrictOfColumbiaOcfFilerTypeId {
  const allowed = new Set<number>(Object.values(DISTRICT_OF_COLUMBIA_OCF_FILER_TYPES));
  if (!Number.isInteger(value) || !allowed.has(value)) {
    throw new DistrictOfColumbiaOcfClientError("invalid_request", `Unsupported D.C. OCF filer type: ${value}`);
  }
  return value as DistrictOfColumbiaOcfFilerTypeId;
}

function normalizeSearchType(value: string): DistrictOfColumbiaOcfSearchType {
  if (value === "Contributions" || value === "Expenditures") {
    return value;
  }
  throw new DistrictOfColumbiaOcfClientError("invalid_request", `Unsupported D.C. OCF search type: ${value}`);
}

function normalizeExportInput(input: DistrictOfColumbiaOcfExportInput): {
  filerTypeId: DistrictOfColumbiaOcfFilerTypeId;
  searchType: DistrictOfColumbiaOcfSearchType;
  fromDate: string;
  toDate: string;
} {
  return {
    filerTypeId: normalizeFilerTypeId(input.filerTypeId),
    searchType: normalizeSearchType(input.searchType),
    fromDate: normalizeDate(input.fromDate, "fromDate") ?? "",
    toDate: normalizeDate(input.toDate, "toDate") ?? "",
  };
}

export function buildDistrictOfColumbiaOcfDataDownloadUrl(): string {
  return `${DISTRICT_OF_COLUMBIA_OCF_BASE_URL}/DataDownload`;
}

export function buildDistrictOfColumbiaOcfSubmitSearchUrl(): string {
  return `${DISTRICT_OF_COLUMBIA_OCF_BASE_URL}/DataDownload/SubmitSearch`;
}

export function buildDistrictOfColumbiaOcfExportUrl(exportType = "CSV"): string {
  const url = new URL(`${DISTRICT_OF_COLUMBIA_OCF_BASE_URL}/DataDownload/Export`);
  url.searchParams.set("exportType", exportType);
  return url.toString();
}

export function buildDistrictOfColumbiaOcfExportFormBody(input: DistrictOfColumbiaOcfExportInput): string {
  const normalized = normalizeExportInput(input);
  const params = new URLSearchParams();
  params.set("FilerTypeId", String(normalized.filerTypeId));
  params.set("SearchType", normalized.searchType);
  params.set("FromDate", normalized.fromDate);
  params.set("ToDate", normalized.toDate);
  return params.toString();
}

function getResponseSetCookies(headers: Headers): string[] {
  const maybeGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  const direct = maybeGetSetCookie.getSetCookie?.() ?? [];
  if (direct.length > 0) {
    return direct;
  }
  const combined = headers.get("set-cookie");
  return combined ? [combined] : [];
}

function mergeCookies(existingCookieHeader: string | undefined, setCookies: string[]): string | undefined {
  const cookies = new Map<string, string>();
  for (const cookie of existingCookieHeader?.split(/;\s*/) ?? []) {
    const separatorIndex = cookie.indexOf("=");
    if (separatorIndex > 0) {
      cookies.set(cookie.slice(0, separatorIndex), cookie.slice(separatorIndex + 1));
    }
  }
  for (const setCookie of setCookies) {
    const [cookie] = setCookie.split(";", 1);
    const separatorIndex = cookie?.indexOf("=") ?? -1;
    if (cookie && separatorIndex > 0) {
      cookies.set(cookie.slice(0, separatorIndex), cookie.slice(separatorIndex + 1));
    }
  }
  const cookieHeader = [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
  return cookieHeader || undefined;
}

async function fetchDistrictOfColumbiaOcf(
  url: string,
  init: RequestInit,
  options: DistrictOfColumbiaOcfClientOptions
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DISTRICT_OF_COLUMBIA_OCF_DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await (options.fetchImpl ?? fetch)(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (isAbortError(error)) {
      throw new DistrictOfColumbiaOcfClientError(
        "network_error",
        `D.C. OCF request timed out after ${timeoutMs}ms for ${url}`
      );
    }
    throw new DistrictOfColumbiaOcfClientError(
      "network_error",
      `D.C. OCF request failed for ${url}: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function assertOk(response: Response, context: string): Promise<void> {
  if (!response.ok) {
    throw new DistrictOfColumbiaOcfClientError(
      "http_error",
      `D.C. OCF ${context} failed: ${response.status} ${response.statusText}`,
      response.status
    );
  }
}

function decodeDistrictOfColumbiaOcfCsv(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  const sample = bytes.subarray(0, Math.min(bytes.length, 200));
  const nullOddCount = sample.filter((byte, index) => index % 2 === 1 && byte === 0).length;
  if (sample.length > 20 && nullOddCount > sample.length / 4) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

export async function fetchDistrictOfColumbiaOcfCsvExport(
  input: DistrictOfColumbiaOcfExportInput,
  options: DistrictOfColumbiaOcfClientOptions = {}
): Promise<string> {
  const formBody = buildDistrictOfColumbiaOcfExportFormBody(input);
  let cookieHeader: string | undefined;

  const landingResponse = await fetchDistrictOfColumbiaOcf(
    buildDistrictOfColumbiaOcfDataDownloadUrl(),
    { headers: { accept: "text/html" } },
    options
  );
  await assertOk(landingResponse, "landing page request");
  cookieHeader = mergeCookies(cookieHeader, getResponseSetCookies(landingResponse.headers));

  const submitHeaders = new Headers({
    accept: "text/html,*/*;q=0.8",
    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
    "content-length": String(Buffer.byteLength(formBody)),
    "x-requested-with": "XMLHttpRequest",
  });
  if (cookieHeader) {
    submitHeaders.set("cookie", cookieHeader);
  }
  const submitResponse = await fetchDistrictOfColumbiaOcf(
    buildDistrictOfColumbiaOcfSubmitSearchUrl(),
    {
      method: "POST",
      headers: submitHeaders,
      body: formBody,
    },
    options
  );
  await assertOk(submitResponse, "search request");
  cookieHeader = mergeCookies(cookieHeader, getResponseSetCookies(submitResponse.headers));

  const exportHeaders = new Headers({ accept: "text/csv,text/plain;q=0.9,*/*;q=0.1" });
  if (cookieHeader) {
    exportHeaders.set("cookie", cookieHeader);
  }
  const exportResponse = await fetchDistrictOfColumbiaOcf(
    buildDistrictOfColumbiaOcfExportUrl("CSV"),
    { headers: exportHeaders },
    options
  );
  await assertOk(exportResponse, "CSV export request");
  return decodeDistrictOfColumbiaOcfCsv(await exportResponse.arrayBuffer());
}

function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const next = csv[index + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (char === "\r") {
      continue;
    }
    field += char;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((fields) => fields.some((fieldValue) => fieldValue.trim().length > 0));
}

export function parseDistrictOfColumbiaOcfCsvRows(csv: string): DistrictOfColumbiaOcfCsvRow[] {
  const rows = parseCsvRows(csv);
  const headerIndex = rows.findIndex((row) => {
    const headers = new Set(row.map(normalizeHeader));
    const hasCommitteeColumn = headers.has("committee_name") || headers.has("filer_name");
    const hasAmountColumn =
      headers.has("amount") || headers.has("contribution_amount") || headers.has("receipt_amount") || headers.has("expenditure_amount");
    return hasCommitteeColumn && hasAmountColumn;
  });
  const headerRow = headerIndex >= 0 ? rows[headerIndex] : rows[0];
  const bodyRows = headerIndex >= 0 ? rows.slice(headerIndex + 1) : rows.slice(1);
  if (!headerRow || headerRow.length === 0) {
    return [];
  }
  const headers = headerRow.map(normalizeHeader);
  return bodyRows.map((fields) => {
    const row: DistrictOfColumbiaOcfCsvRow = {};
    for (let index = 0; index < headers.length; index += 1) {
      const header = headers[index];
      if (header) {
        row[header] = fields[index]?.trim() ?? "";
      }
    }
    return row;
  });
}

function getString(row: DistrictOfColumbiaOcfCsvRow, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[normalizeHeader(key)] ?? row[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function parseAmount(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value.replace(/[$,()]/g, "").trim());
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return value.includes("(") && value.includes(")") ? -parsed : parsed;
}

function parseInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function normalizeCommitteeKey(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\s+/g, " ").toUpperCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function getContributorName(row: DistrictOfColumbiaOcfCsvRow): string | undefined {
  const organizationName = getString(row, "contributor_organization_name", "organization_name");
  if (organizationName) {
    return organizationName;
  }
  const directName = getString(row, "contributor_name", "contributor", "name");
  if (directName) {
    return directName;
  }
  const nameParts = [
    getString(row, "contributor_first_name", "first_name"),
    getString(row, "contributor_middle_name", "middle_name"),
    getString(row, "contributor_last_name", "last_name"),
  ].filter((part): part is string => Boolean(part));
  const name = nameParts.join(" ").trim().replace(/\s+/g, " ");
  return name.length > 0 ? name : undefined;
}

export function districtOfColumbiaOcfContributionRecordFromRow(
  row: DistrictOfColumbiaOcfCsvRow
): DistrictOfColumbiaOcfContributionRecord | null {
  const amount = parseAmount(getString(row, "amount", "contribution_amount", "receipt_amount"));
  if (amount === undefined || amount <= 0) {
    return null;
  }
  const committeeName = getString(row, "committee_name", "filer_name", "filer");
  return {
    ...(committeeName ? { committeeName, committeeKey: normalizeCommitteeKey(committeeName) } : {}),
    ...(getString(row, "candidate_name", "candidate") ? {
      candidateName: getString(row, "candidate_name", "candidate"),
    } : {}),
    ...(getString(row, "office", "office_sought", "office_name") ? {
      office: getString(row, "office", "office_sought", "office_name"),
    } : {}),
    ...(getString(row, "seat", "ward", "district") ? { seat: getString(row, "seat", "ward", "district") } : {}),
    ...(parseInteger(getString(row, "election_year", "election")) !== undefined
      ? { electionYear: parseInteger(getString(row, "election_year", "election")) }
      : {}),
    ...(getContributorName(row) ? { contributorName: getContributorName(row) } : {}),
    ...(getString(row, "contributor_type", "contributor_type_description", "type") ? {
      contributorType: getString(row, "contributor_type", "contributor_type_description", "type"),
    } : {}),
    ...(getString(row, "employer", "employer_name") ? { employer: getString(row, "employer", "employer_name") } : {}),
    ...(getString(row, "occupation") ? { occupation: getString(row, "occupation") } : {}),
    amount,
    ...(getString(row, "date", "contribution_date", "receipt_date") ? {
      date: getString(row, "date", "contribution_date", "receipt_date"),
    } : {}),
  };
}

export function districtOfColumbiaOcfExpenditureRecordFromRow(
  row: DistrictOfColumbiaOcfCsvRow
): DistrictOfColumbiaOcfExpenditureRecord | null {
  const amount = parseAmount(getString(row, "amount", "expenditure_amount"));
  if (amount === undefined || amount <= 0) {
    return null;
  }
  const committeeName = getString(row, "committee_name", "filer_name", "filer");
  return {
    ...(committeeName ? { committeeName, committeeKey: normalizeCommitteeKey(committeeName) } : {}),
    ...(getString(row, "payee_name", "payee", "vendor_name") ? {
      payeeName: getString(row, "payee_name", "payee", "vendor_name"),
    } : {}),
    ...(getString(row, "purpose", "purpose_of_expenditure") ? {
      purpose: getString(row, "purpose", "purpose_of_expenditure"),
    } : {}),
    ...(getString(row, "further_explanation", "description", "memo") ? {
      furtherExplanation: getString(row, "further_explanation", "description", "memo"),
    } : {}),
    amount,
    ...(getString(row, "date", "expenditure_date", "payment_date") ? {
      date: getString(row, "date", "expenditure_date", "payment_date"),
    } : {}),
  };
}

export async function fetchDistrictOfColumbiaOcfContributionRecords(
  input: Omit<DistrictOfColumbiaOcfExportInput, "searchType">,
  options: DistrictOfColumbiaOcfClientOptions = {}
): Promise<DistrictOfColumbiaOcfContributionRecord[]> {
  const csv = await fetchDistrictOfColumbiaOcfCsvExport({ ...input, searchType: "Contributions" }, options);
  return parseDistrictOfColumbiaOcfCsvRows(csv)
    .map(districtOfColumbiaOcfContributionRecordFromRow)
    .filter((row): row is DistrictOfColumbiaOcfContributionRecord => row !== null);
}

export async function fetchDistrictOfColumbiaOcfExpenditureRecords(
  input: Omit<DistrictOfColumbiaOcfExportInput, "searchType">,
  options: DistrictOfColumbiaOcfClientOptions = {}
): Promise<DistrictOfColumbiaOcfExpenditureRecord[]> {
  const csv = await fetchDistrictOfColumbiaOcfCsvExport({ ...input, searchType: "Expenditures" }, options);
  return parseDistrictOfColumbiaOcfCsvRows(csv)
    .map(districtOfColumbiaOcfExpenditureRecordFromRow)
    .filter((row): row is DistrictOfColumbiaOcfExpenditureRecord => row !== null);
}

export function downloadPrincipalCampaignContributions(
  window: DistrictOfColumbiaOcfDateWindow,
  options: DistrictOfColumbiaOcfClientOptions = {}
): Promise<DistrictOfColumbiaOcfContributionRecord[]> {
  return fetchDistrictOfColumbiaOcfContributionRecords(
    {
      filerTypeId: DISTRICT_OF_COLUMBIA_OCF_FILER_TYPES.principalCampaignCommittee,
      ...window,
    },
    options
  );
}

export function downloadIndependentExpenditureContributions(
  window: DistrictOfColumbiaOcfDateWindow,
  options: DistrictOfColumbiaOcfClientOptions = {}
): Promise<DistrictOfColumbiaOcfContributionRecord[]> {
  return fetchDistrictOfColumbiaOcfContributionRecords(
    {
      filerTypeId: DISTRICT_OF_COLUMBIA_OCF_FILER_TYPES.independentExpenditureCommittee,
      ...window,
    },
    options
  );
}

export function downloadIndependentExpenditureExpenditures(
  window: DistrictOfColumbiaOcfDateWindow,
  options: DistrictOfColumbiaOcfClientOptions = {}
): Promise<DistrictOfColumbiaOcfExpenditureRecord[]> {
  return fetchDistrictOfColumbiaOcfExpenditureRecords(
    {
      filerTypeId: DISTRICT_OF_COLUMBIA_OCF_FILER_TYPES.independentExpenditureCommittee,
      ...window,
    },
    options
  );
}
