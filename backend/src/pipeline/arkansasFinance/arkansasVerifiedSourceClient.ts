import { createHash } from "node:crypto";
import {
  ARKANSAS_CFIS_API_BASE_URL,
  ARKANSAS_CFIS_PUBLIC_ORIGIN,
  ArkansasCfisClientError,
  type ArkansasFilerRegistrationRow,
  type ArkansasTransactionRow,
} from "./arkansasCfisClient.js";

export type ArkansasVerifiedRawResponseMetadata = {
  url: string;
  method: "POST";
  requestBody: Readonly<Record<string, unknown>>;
  startedAt: string;
  endedAt: string;
  status: number;
  contentType: string | null;
  bytes: number;
  sha256: string;
};
export type ArkansasVerifiedRawResponse = ArkansasVerifiedRawResponseMetadata & {
  bytesRaw: Uint8Array;
};
export type ArkansasVerifiedSourceClientOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** A fresh budget is created for each public method call. */
  maxRequests?: number;
  maxRows?: number;
  onRawResponse?: (response: ArkansasVerifiedRawResponse) => void | Promise<void>;
};
export type ArkansasVerifiedCollection<T> = {
  rows: T[];
  complete: true;
  totalItems: number;
  fingerprint: string;
  requests: ArkansasVerifiedRawResponseMetadata[];
};
export type ArkansasVerifiedRegistryRow = Omit<ArkansasFilerRegistrationRow, "isPaperFiler"> & {
  isPaperFiler: boolean | null;
  rawFields: Readonly<Record<string, unknown>>;
};
export type ArkansasVerifiedTransactionRow = ArkansasTransactionRow & {
  sourceAddress: string | null;
  rawFields: Readonly<Record<string, unknown>>;
};
export type ArkansasVerifiedCurrentReportRow = {
  /** Request scope: the source report row does not contain this field. */
  registrationGuid: string;
  filerReportGuid: string;
  filerReportVersionId: number;
  reportName: string;
  reportType: string | null;
  reportStatus: string | null;
  reportVersion: string | null;
  startDate: string | null;
  endDate: string | null;
  dueDate: string | null;
  filedDate: string | null;
  filerFilingCalendarGuid: string | null;
  electionTypeCode: string | null;
  reportElectionType: string | null;
  filePath: string | null;
  isPaperFile: boolean;
  hasChild: boolean;
  rawFields: Readonly<Record<string, unknown>>;
};
export type ArkansasVerifiedTransactionDetail = {
  guid: string;
  transactionId: number;
  transactionVersionId: number;
  transactionTypeCode: string | null;
  transactionSubTypeCode: string | null;
  transactionSourceTypeCode: string | null;
  electionTypeCode: string | null;
  electionYear: number | null;
  transactionDate: string;
  contributor: string | null;
  filerName: string | null;
  comments: string | null;
  /** Actual source field; not an inferred cash amount. */
  valueOfNonMoneyItem: number | null;
  rawFields: Readonly<Record<string, unknown>>;
};

const ENDPOINTS = {
  registry: "PublicFilerDetails/GetCandidateCommitteDetails",
  transactions: "PublicTransactionDetails/GetTransactionDetails",
  reports: "PublicFilerDetails/GetPublicFilerProfileFiling",
  detail: "PublicTransactionDetails/GetTransactionDetailsByGuid",
  pdf: "PublicFiledReportAndDownload/DownloadDocument",
} as const;
const PAGE_SIZE = 1000;
const DAY_MS = 86_400_000;

function fail(message: string): never {
  throw new ArkansasCfisClientError("bad_response", `Arkansas verified source: ${message}`);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`invalid ${label}`);
  return value as Record<string, unknown>;
}
function present(row: Record<string, unknown>, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(row, key)) fail(`missing ${key}`);
  return row[key];
}
function string(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string") fail(`invalid ${label}`);
  if (!value.trim()) {
    if (nullable) return null;
    fail(`blank ${label}`);
  }
  return value;
}
function requiredString(value: unknown, label: string): string {
  return string(value, label)!;
}
function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`invalid ${label}`);
  return value;
}
function integer(value: unknown, label: string, minimum = 1): number {
  const n = number(value, label);
  if (!Number.isSafeInteger(n) || n < minimum) fail(`invalid ${label}`);
  return n;
}
function boolean(value: unknown, label: string, nullable = false): boolean | null {
  if (nullable && value === null) return null;
  if (typeof value !== "boolean") fail(`invalid ${label}`);
  return value;
}
function guid(value: unknown, label: string): string {
  const s = requiredString(value, label);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s)) fail(`invalid ${label}`);
  return s.toLowerCase();
}
function inputGuid(value: string): string {
  try { return guid(value, "request GUID"); }
  catch { throw new ArkansasCfisClientError("invalid_request", "Invalid Arkansas verified source request GUID"); }
}
function year(value: unknown, label: string): number | null {
  if (value === null || value === "") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const n = typeof value === "string" && /^\d{4}$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1900 || n > 2100) fail(`invalid ${label}`);
  return n;
}
function dateDay(value: string): number {
  const us = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?)?$/.exec(value);
  if (!us && !iso) fail("invalid source date");
  const y = Number(us ? us[3] : iso![1]);
  const m = Number(us ? us[1] : iso![2]);
  const d = Number(us ? us[2] : iso![3]);
  const ms = Date.UTC(y, m - 1, d);
  const parsed = new Date(ms);
  if (y < 1900 || y > 2100 || parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== m - 1 ||
      parsed.getUTCDate() !== d || (iso?.[4] !== undefined &&
      (Number(iso[4]) > 23 || Number(iso[5]) > 59 || Number(iso[6]) > 59))) fail("invalid source calendar date");
  return ms;
}
function date(value: unknown, label: string, nullable = false): string | null {
  const s = string(value, label, nullable);
  if (s !== null) dateDay(s);
  return s;
}
function usDate(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;
}
function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as object)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail("non-JSON raw identity");
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  }
  if (value !== null && typeof value !== "string" && typeof value !== "boolean" &&
      !(typeof value === "number" && Number.isFinite(value))) fail("non-JSON raw identity");
  return value;
}
/** Bind the complete raw identity multiset, including economic multiplicity. */
export function fingerprintArkansasVerifiedRawRows(
  rows: readonly { rawFields: Readonly<Record<string, unknown>> }[]
): string {
  const identities = rows.map(row => JSON.stringify(canonical(row.rawFields))).sort();
  return createHash("sha256").update(JSON.stringify(identities)).digest("hex");
}
function sourceRow(value: unknown): Record<string, unknown> {
  return immutable(object(value, "row"));
}
function validateFields(row: Record<string, unknown>, strings: string[], numbers: string[] = []): void {
  for (const k of strings) string(present(row, k), k, true);
  for (const k of numbers) number(present(row, k), k);
}
function registryRow(value: unknown): ArkansasVerifiedRegistryRow {
  const r = sourceRow(value);
  validateFields(r, ["filerTypeDesc", "filingTypeCode", "balanceofFundsNew", "totalRaisedNew", "totalSpentNew"]);
  integer(present(r, "totalRows"), "totalRows", 0);
  return immutable({
    registrationGuid: guid(present(r, "guid"), "registration guid"),
    filerEntityId: integer(present(r, "filerEntityID"), "filerEntityID"),
    filerEntityVersionId: integer(present(r, "filerEntityVersionID"), "filerEntityVersionID"),
    filerType: requiredString(present(r, "filerType"), "filerType"),
    filerTypeCode: requiredString(present(r, "filerTypeCode"), "filerTypeCode"),
    filerStatus: requiredString(present(r, "filerStatus"), "filerStatus"),
    filerName: string(present(r, "filerName"), "filerName", true),
    firstName: string(present(r, "firstName"), "firstName", true),
    lastName: string(present(r, "lastName"), "lastName", true),
    suffix: string(present(r, "suffix"), "suffix", true),
    committeeName: string(present(r, "committeeName"), "committeeName", true),
    office: string(present(r, "office"), "office", true),
    officeDistrictName: string(present(r, "officeDistrictName"), "officeDistrictName", true),
    jurisdictionName: string(present(r, "jurisdictionName"), "jurisdictionName", true),
    politicalParty: string(present(r, "politicalParty"), "politicalParty", true),
    electionYear: year(present(r, "electionYear"), "electionYear"),
    filingYear: year(present(r, "filingYear"), "filingYear"),
    isPaperFiler: boolean(present(r, "isPaperFiler"), "isPaperFiler", true),
    totalRaised: number(present(r, "totalRaised"), "totalRaised"),
    totalSpent: number(present(r, "totalSpent"), "totalSpent"),
    balanceOfFunds: number(present(r, "balanceofFunds"), "balanceofFunds"),
    rawFields: r,
  });
}
function transactionRow(value: unknown, registrationGuid: string): ArkansasVerifiedTransactionRow {
  const r = sourceRow(value);
  const actualRegistration = guid(present(r, "filerRegistrationGuid"), "filerRegistrationGuid");
  if (actualRegistration !== registrationGuid) fail("transaction receiver differs from requested registration");
  integer(present(r, "totalRows"), "totalRows", 0);
  return immutable({
    guid: guid(present(r, "guid"), "transaction guid"),
    filerName: requiredString(present(r, "filerName"), "filerName"),
    filerRegistrationGuid: actualRegistration,
    transactionAmount: number(present(r, "transactionAmount"), "transactionAmount"),
    transactionDate: date(present(r, "transactionDate"), "transactionDate")!,
    sourceName: string(present(r, "sourceName"), "sourceName", true),
    employerName: string(present(r, "employerName"), "employerName", true),
    occupation: string(present(r, "occupation"), "occupation", true),
    sourceAddress: string(present(r, "sourceAddress"), "sourceAddress", true),
    transactionSource: string(present(r, "transactionSource"), "transactionSource", true),
    reportName: string(present(r, "reportName"), "reportName", true),
    transactionSubTypeDescription: string(present(r, "transactionSubTypeDesc"), "transactionSubTypeDesc", true),
    transactionCategory: string(present(r, "transactionCategory"), "transactionCategory", true),
    hasChild: boolean(present(r, "hasChild"), "hasChild")!,
    rawFields: r,
  });
}
function reportRow(value: unknown, registrationGuid: string): ArkansasVerifiedCurrentReportRow {
  const r = sourceRow(value);
  integer(present(r, "totalRows"), "totalRows", 0);
  const calendar = string(present(r, "filerFilingCalendarGuid"), "filerFilingCalendarGuid", true);
  if (calendar !== null) guid(calendar, "filerFilingCalendarGuid");
  return immutable({
    registrationGuid,
    filerReportGuid: guid(present(r, "filerReportGuid"), "filerReportGuid"),
    filerReportVersionId: integer(present(r, "filerReportVersionID"), "filerReportVersionID"),
    reportName: requiredString(present(r, "reportName"), "reportName"),
    reportType: string(present(r, "reportType"), "reportType", true),
    reportStatus: string(present(r, "reportStatus"), "reportStatus", true),
    reportVersion: string(present(r, "reportVersion"), "reportVersion", true),
    startDate: date(present(r, "startDate"), "startDate", true),
    endDate: date(present(r, "endDate"), "endDate", true),
    dueDate: date(present(r, "dueDate"), "dueDate", true),
    filedDate: date(present(r, "filedDate"), "filedDate", true),
    filerFilingCalendarGuid: calendar,
    electionTypeCode: string(present(r, "electionTypeCode"), "electionTypeCode", true),
    reportElectionType: string(present(r, "reportElectionType"), "reportElectionType", true),
    filePath: string(present(r, "filePath"), "filePath", true),
    isPaperFile: boolean(present(r, "isPaperFile"), "isPaperFile")!,
    hasChild: boolean(present(r, "hasChild"), "hasChild")!,
    rawFields: r,
  });
}
function detailRow(value: unknown, requestedGuid: string): ArkansasVerifiedTransactionDetail {
  const r = sourceRow(value);
  validateFields(r, ["transactionSubTypeDesc", "electionTypeDesc", "transactionSourceTypeDesc", "transactionSource",
    "transactionTypeDescription", "otherCategory", "transactionCategoryDesc"]);
  const actualGuid = guid(present(r, "guid"), "detail guid");
  if (actualGuid !== requestedGuid) fail("transaction detail GUID differs from request");
  const nonMoney = present(r, "valueOfNonMoneyItem");
  return immutable({
    guid: actualGuid,
    transactionId: integer(present(r, "transactionID"), "transactionID"),
    transactionVersionId: integer(present(r, "transactionVersionID"), "transactionVersionID"),
    transactionTypeCode: string(present(r, "transactionTypeCode"), "transactionTypeCode", true),
    transactionSubTypeCode: string(present(r, "transactionSubTypeCode"), "transactionSubTypeCode", true),
    transactionSourceTypeCode: string(present(r, "transactionSourceTypeCode"), "transactionSourceTypeCode", true),
    electionTypeCode: string(present(r, "electionTypeCode"), "electionTypeCode", true),
    electionYear: year(present(r, "electionYear"), "electionYear"),
    transactionDate: date(present(r, "transactionDate"), "transactionDate")!,
    contributor: string(present(r, "contributor"), "contributor", true),
    filerName: string(present(r, "filerName"), "filerName", true),
    comments: string(present(r, "comments"), "comments", true),
    valueOfNonMoneyItem: nonMoney === null ? null : number(nonMoney, "valueOfNonMoneyItem"),
    rawFields: r,
  });
}

type Page<T> = { rows: T[]; total: number };
export function createArkansasVerifiedSourceClient(options: ArkansasVerifiedSourceClientOptions = {}) {
  const bounds = {
    timeout: options.timeoutMs ?? 90_000,
    bytes: options.maxResponseBytes ?? 16 * 1024 * 1024,
    requests: options.maxRequests ?? 256,
    rows: options.maxRows ?? 250_000,
  };
  for (const [key, value] of Object.entries(bounds)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new ArkansasCfisClientError("invalid_request", `Invalid Arkansas verified ${key} bound`);
  }
  const fetchImpl = options.fetchImpl ?? fetch;

  // Each public method starts a separate finite acquisition budget.
  function session() {
    const requests: ArkansasVerifiedRawResponseMetadata[] = [];
    let count = 0;
    async function request(endpoint: string, body: Record<string, unknown>, pdf = false) {
      if (++count > bounds.requests) fail("per-method request limit exceeded");
      const requestBody = immutable(JSON.parse(JSON.stringify(body)) as Record<string, unknown>);
      const url = `${ARKANSAS_CFIS_API_BASE_URL}/${endpoint}`;
      const startedAt = new Date().toISOString();
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          void reader?.cancel().catch(() => {});
          reject(new ArkansasCfisClientError("network_error", "Arkansas verified source request/body timed out"));
        }, bounds.timeout);
      });
      let response: Response;
      let bytes: Uint8Array;
      try {
        const acquired = await Promise.race([timeout, (async () => {
          const res = await fetchImpl(url, {
            method: "POST",
            headers: {
              Accept: pdf ? "application/pdf, */*" : "application/json, text/plain, */*",
              "Content-Type": "application/json",
              Origin: ARKANSAS_CFIS_PUBLIC_ORIGIN,
              Referer: `${ARKANSAS_CFIS_PUBLIC_ORIGIN}/`,
              "User-Agent": "Mozilla/5.0",
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
          });
          if (!res.body) fail("missing response body");
          reader = res.body.getReader();
          const chunks: Uint8Array[] = [];
          let total = 0;
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            total += part.value.byteLength;
            if (total > bounds.bytes) {
              controller.abort();
              void reader.cancel().catch(() => {});
              fail("streamed response exceeds byte limit");
            }
            chunks.push(part.value);
          }
          const all = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
          return { response: res, bytes: all };
        })()]);
        response = acquired.response;
        bytes = acquired.bytes;
      } catch (error) {
        if (error instanceof ArkansasCfisClientError) throw error;
        throw new ArkansasCfisClientError("network_error", `Arkansas verified source request failed: ${error instanceof Error ? error.message : "transport error"}`);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        reader?.releaseLock();
      }
      const metadata: ArkansasVerifiedRawResponseMetadata = immutable({
        url, method: "POST", requestBody, startedAt, endedAt: new Date().toISOString(),
        status: response.status, contentType: response.headers.get("content-type"),
        bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      requests.push(metadata);
      // Callback gets a copy so mutation cannot alter parsing or the exact hash.
      await options.onRawResponse?.({ ...metadata, bytesRaw: new Uint8Array(bytes) });
      if (!response.ok) throw new ArkansasCfisClientError("http_error", `Arkansas verified source HTTP ${response.status}`, response.status);
      const contentType = metadata.contentType?.split(";")[0]?.trim().toLowerCase();
      if (pdf) {
        if (contentType !== "application/pdf" && contentType !== "application/octet-stream") fail("unexpected PDF content type");
        if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-" ||
            !/%%EOF\s*$/.test(new TextDecoder().decode(bytes.subarray(Math.max(0, bytes.length - 2048))))) fail("invalid or truncated PDF bytes");
        return { bytes, metadata };
      }
      if (contentType !== "application/json") fail("unexpected JSON content type");
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { fail("invalid UTF-8 JSON"); }
      const envelope = object(parsed, "response envelope");
      if (present(envelope, "succeeded") !== true || present(envelope, "error") !== null) fail("failed or malformed success envelope");
      return { data: present(envelope, "data"), bytes, metadata };
    }
    async function page<T>(endpoint: string, body: Record<string, unknown>, parse: (value: unknown) => T): Promise<Page<T>> {
      const response = await request(endpoint, body);
      const data = object(response.data, "page data");
      const items = present(data, "items");
      if (!Array.isArray(items)) fail("missing explicit page items array");
      const total = integer(present(data, "totalItems"), "totalItems", 0);
      // Official echoes are zero. Their presence/type is validated, not equality to request.
      integer(present(data, "pageNumber"), "pageNumber echo", 0);
      integer(present(data, "pageSize"), "pageSize echo", 0);
      if (total > bounds.rows) fail("declared total exceeds row limit");
      const pageSize = body.pageSize as number;
      if (items.length > pageSize || items.length > total) fail("page exceeds declared/requested size");
      for (const item of items) {
        const r = object(item, "page row");
        if (integer(present(r, "totalRows"), "row totalRows", 0) !== total) fail("row totalRows differs from envelope");
      }
      return { rows: items.map(parse), total };
    }
    function collection<T extends { rawFields: Readonly<Record<string, unknown>> }>(rows: T[]): ArkansasVerifiedCollection<T> {
      return { rows, complete: true, totalItems: rows.length, fingerprint: fingerprintArkansasVerifiedRawRows(rows), requests };
    }
    async function allPages<T>(
      getPage: (pageNumber: number) => Promise<Page<T>>,
      identity: (row: T) => string,
      pageSize = PAGE_SIZE
    ): Promise<T[]> {
      const rows: T[] = [];
      const seen = new Set<string>();
      let total: number | undefined;
      for (let pageNumber = 1; ; pageNumber++) {
        const p = await getPage(pageNumber);
        if (total === undefined) total = p.total;
        if (p.total !== total) fail("declared total changed during pagination");
        if (p.rows.length !== Math.min(pageSize, total - rows.length)) fail("partial or inconsistent page");
        for (const row of p.rows) {
          const id = identity(row);
          if (seen.has(id)) fail("duplicate source GUID during pagination");
          seen.add(id);
          rows.push(row);
        }
        if (rows.length === total) return rows;
      }
    }
    return { request, page, collection, allPages };
  }

  return {
    async fetchRegistry(): Promise<ArkansasVerifiedCollection<ArkansasVerifiedRegistryRow>> {
      const s = session();
      const rows = await s.allPages(
        pageNumber => s.page(ENDPOINTS.registry, { pageNumber, pageSize: PAGE_SIZE }, registryRow),
        row => row.registrationGuid
      );
      if (!rows.length) fail("empty full registry cannot establish an identity universe");
      return s.collection(rows);
    },
    async fetchTransactions(input: {
      registrationGuid: string; transactionTypeCode: "TCON" | "TEXP";
    }): Promise<ArkansasVerifiedCollection<ArkansasVerifiedTransactionRow>> {
      const registrationGuid = inputGuid(input.registrationGuid);
      if (input.transactionTypeCode !== "TCON" && input.transactionTypeCode !== "TEXP") throw new ArkansasCfisClientError("invalid_request", "Only TCON/TEXP verified native queries are supported");
      const s = session();
      const base = { filerRegistrationGuid: registrationGuid, transactionTypeCode: input.transactionTypeCode };
      const page = (extra: Record<string, unknown>) => s.page(ENDPOINTS.transactions,
        { ...base, pageNumber: 1, pageSize: PAGE_SIZE, ...extra }, value => transactionRow(value, registrationGuid));
      const first = await page({});
      const unique = (rows: ArkansasVerifiedTransactionRow[]) => {
        if (new Set(rows.map(row => row.guid)).size !== rows.length) fail("duplicate native transaction GUID");
        return rows;
      };
      if (first.total <= PAGE_SIZE) {
        if (first.rows.length !== first.total) fail("incomplete native single page");
        return s.collection(unique(first.rows));
      }
      if (first.rows.length !== PAGE_SIZE) fail("incomplete native initial page");
      const earliest = await page({ pageSize: 1, sortBy: "TransactionDate", sortType: "asc" });
      const latest = await page({ pageSize: 1, sortBy: "TransactionDate", sortType: "desc" });
      if (earliest.total !== first.total || latest.total !== first.total || earliest.rows.length !== 1 || latest.rows.length !== 1) fail("unstable native date bounds");
      const min = dateDay(earliest.rows[0]!.transactionDate);
      const max = dateDay(latest.rows[0]!.transactionDate);
      if (min > max) fail("reversed native date bounds");
      async function window(from: number, to: number): Promise<ArkansasVerifiedTransactionRow[]> {
        const fields = { fromDate: usDate(from), toDate: usDate(to) };
        const p = await page(fields);
        if (p.rows.some(row => dateDay(row.transactionDate) < from || dateDay(row.transactionDate) > to)) fail("native row outside requested date window");
        if (p.total <= PAGE_SIZE) {
          if (p.rows.length !== p.total) fail("incomplete native date window");
          return unique(p.rows);
        }
        if (p.rows.length !== PAGE_SIZE) fail("incomplete native split page");
        if (from === to) {
          return s.allPages(async pageNumber => {
            const next = pageNumber === 1 ? p : await page({ ...fields, pageNumber });
            if (next.total !== p.total || next.rows.some(row => dateDay(row.transactionDate) !== from)) fail("unstable one-day native pages");
            return next;
          }, row => row.guid);
        }
        const midpoint = from + Math.floor((to - from) / DAY_MS / 2) * DAY_MS;
        const left = await window(from, midpoint);
        const right = await window(midpoint + DAY_MS, to);
        if (left.length + right.length !== p.total) fail("native child/parent totals differ");
        return unique([...left, ...right]);
      }
      const rows = await window(min, max);
      if (rows.length !== first.total) fail("native assembled total differs from initial total");
      return s.collection(unique(rows));
    },
    async fetchCurrentReports(input: {
      registrationGuid: string;
    }): Promise<ArkansasVerifiedCollection<ArkansasVerifiedCurrentReportRow>> {
      const registrationGuid = inputGuid(input.registrationGuid);
      const s = session();
      const rows = await s.allPages(
        pageNumber => s.page(ENDPOINTS.reports, { filerRegistrationGuid: registrationGuid, pageNumber, pageSize: PAGE_SIZE },
          value => reportRow(value, registrationGuid)),
        row => row.filerReportGuid
      );
      return s.collection(rows);
    },
    async fetchTransactionDetail(input: { transactionGuid: string }) {
      const requestedGuid = inputGuid(input.transactionGuid);
      const s = session();
      const response = await s.request(ENDPOINTS.detail, { transactionGuid: requestedGuid });
      const row = detailRow(response.data, requestedGuid);
      return { row, fingerprint: fingerprintArkansasVerifiedRawRows([row]), request: response.metadata };
    },
    async fetchStoredReport(input: { filerReportGuid: string; fileName: string }) {
      const filerReportGuid = inputGuid(input.filerReportGuid);
      if (typeof input.fileName !== "string" || !input.fileName.trim() || input.fileName.length > 1000 || /[\x00-\x1f]/.test(input.fileName)) {
        throw new ArkansasCfisClientError("invalid_request", "Invalid Arkansas stored report fileName");
      }
      const s = session();
      const response = await s.request(ENDPOINTS.pdf, { filerReportGuid, fileName: input.fileName, openInNewTab: true }, true);
      return { bytesRaw: response.bytes, sha256: response.metadata.sha256, request: response.metadata };
    },
  };
}
export type ArkansasVerifiedSourceClient = ReturnType<typeof createArkansasVerifiedSourceClient>;
