export const UTAH_DISCLOSURES_BASE_URL = "https://disclosures.utah.gov";
export const UTAH_DISCLOSURES_DEFAULT_TIMEOUT_MS = 30_000;

export const UTAH_DISCLOSURES_ENTITY_TYPES = [
  "PCC",
  "PAC",
  "INDEXP",
  "CORP",
  "ELECT",
  "LABOR",
  "PIC",
  "PARTY",
  "Contributions",
  "Expenditures",
] as const;

export type UtahDisclosuresEntityType = (typeof UTAH_DISCLOSURES_ENTITY_TYPES)[number];

export type UtahDisclosuresClientErrorCode =
  | "invalid_request"
  | "network_error"
  | "http_error"
  | "bad_response";

export class UtahDisclosuresClientError extends Error {
  constructor(
    public readonly code: UtahDisclosuresClientErrorCode,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "UtahDisclosuresClientError";
  }
}

export type UtahDisclosuresClientOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
};

export type UtahDisclosuresEntitySearchInput = {
  search?: string | null;
  entityType: UtahDisclosuresEntityType;
  reportYear: number;
  hideContributions?: boolean;
  hideExpenditures?: boolean;
  pageNumber?: number;
};

export type UtahDisclosuresGenerateReportInput = {
  reportYear: number;
  entityType?: UtahDisclosuresEntityType | null;
  folderId?: string | number | null;
};

export type UtahDisclosuresEntitySearchRow = {
  folderId: string;
  entityName: string;
  entityType?: UtahDisclosuresEntityType;
  endingBalance?: number;
  reportYears: number[];
  sourceUrl: string;
};

export type UtahDisclosuresCsvRow = Record<string, string>;

export type UtahDisclosuresTransactionRow = {
  filed?: string;
  entityType?: UtahDisclosuresEntityType;
  entityName?: string;
  report?: string;
  transactionId: string;
  transactionType?: string;
  transactionDate?: string;
  amount: number;
  name?: string;
  purpose?: string;
  amends?: string;
  amendComments?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  inKind: boolean;
  inKindComments?: string;
  loan: boolean;
  comment?: string;
  psa?: string;
};

const ENTITY_TYPE_SET = new Set<string>(UTAH_DISCLOSURES_ENTITY_TYPES);
const REQUIRED_TRANSACTION_HEADERS = ["TRAN_ID", "TRAN_AMT"] as const;

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function buildUtahDisclosuresUrl(path: string, baseUrl = UTAH_DISCLOSURES_BASE_URL): URL {
  return new URL(path, baseUrl);
}

function normalizeReportYear(value: number): number {
  if (!Number.isInteger(value) || value < 1998 || value > 2100) {
    throw new UtahDisclosuresClientError("invalid_request", `Invalid Utah disclosures report year: ${value}`);
  }
  return value;
}

function normalizeEntityType(value: string | null | undefined): UtahDisclosuresEntityType {
  if (value && ENTITY_TYPE_SET.has(value)) {
    return value as UtahDisclosuresEntityType;
  }
  throw new UtahDisclosuresClientError("invalid_request", `Unsupported Utah disclosures entity type: ${value ?? ""}`);
}

function normalizePageNumber(value: number | undefined): number {
  if (value === undefined) {
    return 1;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new UtahDisclosuresClientError("invalid_request", `Invalid Utah disclosures page number: ${value}`);
  }
  return value;
}

function normalizeFolderId(value: string | number): string {
  const folderId = String(value).trim();
  if (!/^\d+$/.test(folderId)) {
    throw new UtahDisclosuresClientError("invalid_request", `Invalid Utah disclosures folder id: ${folderId}`);
  }
  return folderId;
}

export function buildUtahAdvancedSearchUrl(baseUrl = UTAH_DISCLOSURES_BASE_URL): string {
  return buildUtahDisclosuresUrl("/Search/AdvancedSearch", baseUrl).toString();
}

export function buildUtahEntityReportListUrl(baseUrl = UTAH_DISCLOSURES_BASE_URL): string {
  return buildUtahDisclosuresUrl("/Search/AdvancedSearch/GetEntityReportList", baseUrl).toString();
}

export function buildUtahGenerateReportUrl(
  input: UtahDisclosuresGenerateReportInput,
  baseUrl = UTAH_DISCLOSURES_BASE_URL
): string {
  const reportYear = normalizeReportYear(input.reportYear);
  const folderId = input.folderId === undefined || input.folderId === null ? undefined : normalizeFolderId(input.folderId);
  const url = buildUtahDisclosuresUrl(
    folderId ? `/Search/AdvancedSearch/GenerateReport/${folderId}` : "/Search/AdvancedSearch/GenerateReport",
    baseUrl
  );
  url.searchParams.set("ReportYear", String(reportYear));
  if (!folderId) {
    url.searchParams.set("EntityType", normalizeEntityType(input.entityType));
  } else if (input.entityType) {
    url.searchParams.set("EntityType", normalizeEntityType(input.entityType));
  }
  return url.toString();
}

export function buildUtahEntityReportListFormBody(input: UtahDisclosuresEntitySearchInput): string {
  const params = new URLSearchParams();
  params.set("Search", input.search?.trim() ?? "");
  params.set("EntityType", normalizeEntityType(input.entityType));
  params.set("ReportYear", String(normalizeReportYear(input.reportYear)));
  params.set("HideContributions", String(input.hideContributions ?? false));
  params.set("HideExpenditures", String(input.hideExpenditures ?? false));
  params.set("PageNumber", String(normalizePageNumber(input.pageNumber)));
  return params.toString();
}

async function fetchUtahDisclosures(
  url: string,
  init: RequestInit,
  options: UtahDisclosuresClientOptions,
  context: string
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? UTAH_DISCLOSURES_DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutMessage = `Utah disclosures request timed out after ${timeoutMs}ms for ${url}`;
  const request = (async () => {
    const response = await (options.fetchImpl ?? fetch)(url, { ...init, signal: controller.signal });
    return response;
  })();
  const timeoutReached = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new UtahDisclosuresClientError("network_error", timeoutMessage));
    }, timeoutMs);
  });
  let bodyRequest: Promise<string> | undefined;

  try {
    const response = await Promise.race([request, timeoutReached]);
    await assertOk(response, context);
    bodyRequest = response.text();
    return await Promise.race([bodyRequest, timeoutReached]);
  } catch (error) {
    if (error instanceof UtahDisclosuresClientError) {
      throw error;
    }
    if (isAbortError(error)) {
      throw new UtahDisclosuresClientError("network_error", timeoutMessage);
    }
    throw new UtahDisclosuresClientError(
      "network_error",
      `Utah disclosures request failed for ${url}: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    request.catch(() => undefined);
    bodyRequest?.catch(() => undefined);
  }
}

async function assertOk(response: Response, context: string): Promise<void> {
  if (!response.ok) {
    throw new UtahDisclosuresClientError(
      "http_error",
      `Utah disclosures ${context} failed: ${response.status} ${response.statusText}`,
      response.status
    );
  }
}

export async function fetchUtahEntityReportListHtml(
  input: UtahDisclosuresEntitySearchInput,
  options: UtahDisclosuresClientOptions = {}
): Promise<string> {
  const formBody = buildUtahEntityReportListFormBody(input);
  const response = await fetchUtahDisclosures(
    buildUtahEntityReportListUrl(options.baseUrl),
    {
      method: "POST",
      headers: new Headers({
        accept: "text/html,*/*;q=0.8",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "content-length": String(Buffer.byteLength(formBody)),
        "x-requested-with": "XMLHttpRequest",
      }),
      body: formBody,
    },
    options,
    "entity report list request"
  );
  return response;
}

export async function fetchUtahGeneratedReportCsv(
  input: UtahDisclosuresGenerateReportInput,
  options: UtahDisclosuresClientOptions = {}
): Promise<string> {
  const response = await fetchUtahDisclosures(
    buildUtahGenerateReportUrl(input, options.baseUrl),
    { headers: { accept: "text/csv,text/plain;q=0.9,*/*;q=0.1" } },
    options,
    "generated report request"
  );
  return response;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)));
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function parseHref(value: string): string | undefined {
  const hrefMatch = value.match(/\bhref\s*=\s*["']([^"']+)["']/i);
  return hrefMatch ? decodeHtmlEntities(hrefMatch[1]) : undefined;
}

function parseAmount(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  const parsed = Number(trimmed.replace(/[$,]/g, "").replace(/^\((.*)\)$/, "-$1"));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (["true", "t", "yes", "y", "1", "x"].includes(normalized)) {
    return true;
  }
  if (["false", "f", "no", "n", "0"].includes(normalized)) {
    return false;
  }
  return undefined;
}

export function parseUtahAdvancedSearchEntityRows(
  html: string,
  baseUrl = UTAH_DISCLOSURES_BASE_URL,
  entityType?: UtahDisclosuresEntityType
): UtahDisclosuresEntitySearchRow[] {
  const rows: UtahDisclosuresEntitySearchRow[] = [];
  const tableRows = html.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? [];

  for (const tableRow of tableRows) {
    const folderLinkMatch = tableRow.match(/<a\b[^>]*href\s*=\s*["'][^"']*\/FolderDetails\/(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!folderLinkMatch) {
      continue;
    }

    const href = parseHref(folderLinkMatch[0]);
    const folderId = folderLinkMatch[1];
    const entityName = stripHtml(folderLinkMatch[2]);
    if (!entityName) {
      continue;
    }

    const reportYears = [
      ...new Set(
        [...tableRow.matchAll(/GenerateReport\/\d+\?ReportYear=(\d{4})/gi)]
          .map((match) => Number.parseInt(match[1], 10))
          .filter((year) => Number.isInteger(year))
      ),
    ].sort((left, right) => right - left);
    const endingBalance = parseAmount(stripHtml(tableRow).match(/Ending Balance:\s*([$(),.\d-]+)/i)?.[1]);
    const sourceUrl = new URL(href ?? `/Search/AdvancedSearch/FolderDetails/${folderId}`, baseUrl).toString();

    rows.push({
      folderId,
      entityName,
      ...(entityType ? { entityType } : {}),
      ...(endingBalance !== undefined ? { endingBalance } : {}),
      reportYears,
      sourceUrl,
    });
  }

  return rows;
}

function normalizeHeader(value: string): string {
  return value.replace(/^\uFEFF/, "").trim();
}

function parseCsvRows(csv: string, strict = false): string[][] {
  if (strict) csv = csv.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let quoteClosed = false;
  let rowHasSyntax = false;
  const fail = () => {
    throw new UtahDisclosuresClientError("bad_response", "Utah disclosures CSV has invalid quoting");
  };

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const next = csv[index + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
        quoteClosed = true;
      } else {
        field += char;
      }
      continue;
    }
    if (strict && quoteClosed && ![",", "\r", "\n"].includes(char)) fail();
    if (char === '"') {
      if (strict && (field.length > 0 || quoteClosed)) fail();
      inQuotes = true;
      rowHasSyntax = true;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      quoteClosed = false;
      rowHasSyntax = true;
      continue;
    }
    if (char === "\n") {
      if (!strict || rowHasSyntax) {
        row.push(field);
        rows.push(row);
      }
      row = [];
      field = "";
      quoteClosed = false;
      rowHasSyntax = false;
      continue;
    }
    if (char === "\r") {
      if (strict && next !== "\n") fail();
      continue;
    }
    field += char;
    rowHasSyntax = true;
  }
  if (inQuotes) {
    throw new UtahDisclosuresClientError("bad_response", "Utah disclosures CSV has an unterminated quoted field");
  }
  if (strict ? rowHasSyntax : field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return strict ? rows : rows.filter((fields) => fields.some((value) => value.trim().length > 0));
}

function rowObjectFromCells(cells: readonly string[], headers: readonly string[]): UtahDisclosuresCsvRow {
  const row: UtahDisclosuresCsvRow = {};
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    if (header) {
      row[header] = cells[index]?.trim() ?? "";
    }
  }
  return row;
}

function parseUtahDisclosuresCsvPayload(csv: string, strict = false): { headers: string[]; rows: UtahDisclosuresCsvRow[] } {
  const rows = parseCsvRows(csv, strict);
  if (rows.length === 0) {
    return { headers: [], rows: [] };
  }
  if (rows[0].length === 1 && rows[0][0].trim().toLowerCase().startsWith("there are no recorded transactions")) {
    return { headers: [], rows: [] };
  }

  const headers = rows[0].map(normalizeHeader);
  const seen = new Set<string>();
  for (const header of headers) {
    if (!header) {
      if (strict) throw new UtahDisclosuresClientError("bad_response", "Utah disclosures CSV has an empty header");
      continue;
    }
    if (seen.has(header)) {
      throw new UtahDisclosuresClientError("bad_response", `Duplicate Utah disclosures CSV header: ${header}`);
    }
    seen.add(header);
  }
  if (seen.size === 0) {
    throw new UtahDisclosuresClientError("bad_response", "Utah disclosures CSV header row is empty");
  }

  if (strict && rows.slice(1).some((row) => row.length !== headers.length)) {
    throw new UtahDisclosuresClientError("bad_response", "Utah disclosures CSV has inconsistent record widths");
  }
  return { headers, rows: rows.slice(1).map((row) => rowObjectFromCells(row, headers)) };
}

/** Complete syntax and width validation for source-specific native readers. */
export function parseUtahDisclosuresStrictCsvPayload(csv: string): {
  headers: string[];
  rows: UtahDisclosuresCsvRow[];
} {
  return parseUtahDisclosuresCsvPayload(csv, true);
}

export function parseUtahDisclosuresCsvRows(csv: string): UtahDisclosuresCsvRow[] {
  return parseUtahDisclosuresCsvPayload(csv).rows;
}

function getString(row: UtahDisclosuresCsvRow, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function getUtahEntityFromRow(
  row: UtahDisclosuresCsvRow
): { entityType?: UtahDisclosuresEntityType; entityName?: string } {
  for (const entityType of UTAH_DISCLOSURES_ENTITY_TYPES) {
    const entityName = getString(row, entityType);
    if (entityName) {
      return { entityType, entityName };
    }
  }
  return {};
}

export function utahDisclosuresTransactionRowFromCsvRow(
  row: UtahDisclosuresCsvRow
): UtahDisclosuresTransactionRow | null {
  const transactionId = getString(row, "TRAN_ID");
  const amount = parseAmount(getString(row, "TRAN_AMT"));
  if (!transactionId || amount === undefined) {
    return null;
  }

  const entity = getUtahEntityFromRow(row);
  return {
    ...(getString(row, "FILED") ? { filed: getString(row, "FILED") } : {}),
    ...entity,
    ...(getString(row, "REPORT") ? { report: getString(row, "REPORT") } : {}),
    transactionId,
    ...(getString(row, "TRAN_TYPE") ? { transactionType: getString(row, "TRAN_TYPE") } : {}),
    ...(getString(row, "TRAN_DATE") ? { transactionDate: getString(row, "TRAN_DATE") } : {}),
    amount,
    ...(getString(row, "NAME") ? { name: getString(row, "NAME") } : {}),
    ...(getString(row, "PURPOSE") ? { purpose: getString(row, "PURPOSE") } : {}),
    ...(getString(row, "AMENDS") ? { amends: getString(row, "AMENDS") } : {}),
    ...(getString(row, "AMEND_COMMENTS") ? { amendComments: getString(row, "AMEND_COMMENTS") } : {}),
    ...(getString(row, "ADDRESS1") ? { address1: getString(row, "ADDRESS1") } : {}),
    ...(getString(row, "ADDRESS2") ? { address2: getString(row, "ADDRESS2") } : {}),
    ...(getString(row, "CITY") ? { city: getString(row, "CITY") } : {}),
    ...(getString(row, "STATE") ? { state: getString(row, "STATE") } : {}),
    ...(getString(row, "ZIP") ? { zip: getString(row, "ZIP") } : {}),
    inKind: parseBoolean(getString(row, "INKIND")) ?? false,
    ...(getString(row, "INKIND_COMMENTS") ? { inKindComments: getString(row, "INKIND_COMMENTS") } : {}),
    loan: parseBoolean(getString(row, "LOAN")) ?? false,
    ...(getString(row, "COMMENT") ? { comment: getString(row, "COMMENT") } : {}),
    ...(getString(row, "PSA") ? { psa: getString(row, "PSA") } : {}),
  };
}

export function parseUtahDisclosuresTransactionRows(csv: string): UtahDisclosuresTransactionRow[] {
  const parsed = parseUtahDisclosuresCsvPayload(csv);
  if (parsed.headers.length === 0 && parsed.rows.length === 0) {
    return [];
  }
  const headers = new Set(parsed.headers);
  for (const requiredHeader of REQUIRED_TRANSACTION_HEADERS) {
    if (!headers.has(requiredHeader)) {
      throw new UtahDisclosuresClientError(
        "bad_response",
        `Utah disclosures CSV is missing required transaction header: ${requiredHeader}`
      );
    }
  }
  return parsed.rows
    .map(utahDisclosuresTransactionRowFromCsvRow)
    .filter((row): row is UtahDisclosuresTransactionRow => row !== null);
}

export async function downloadUtahGeneratedReportRows(
  input: UtahDisclosuresGenerateReportInput,
  options: UtahDisclosuresClientOptions = {}
): Promise<UtahDisclosuresTransactionRow[]> {
  const csv = await fetchUtahGeneratedReportCsv(input, options);
  return parseUtahDisclosuresTransactionRows(csv);
}
