import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const ORIGIN = "https://campaignfinance.wi.gov";
const PUBLIC_READS = new Set([
  "publicFrontendApi.getCommittees", "publicFrontendApi.getCommitteesCount",
  "publicFrontendApi.getTransactions", "publicFrontendApi.getTransactionsTotalCount",
  "publicFrontendApi.getReports", "publicFrontendApi.getReportsCount",
  "publicFrontendApi.getReportSubmissionsData", "transactionMeta.getTransactionCategories",
  "reportMeta.getReportTemplates",
]);
const COUNTS: Readonly<Record<string, string>> = {
  "publicFrontendApi.getCommittees": "publicFrontendApi.getCommitteesCount",
  "publicFrontendApi.getReports": "publicFrontendApi.getReportsCount",
  "publicFrontendApi.getTransactions": "publicFrontendApi.getTransactionsTotalCount",
};
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_AGE_MS = 7 * 86_400_000;
export type WisconsinPublicSourceOptions = {
  cacheDir: string; allowNetwork?: boolean; refresh?: boolean; fetchImpl?: typeof fetch;
  timeoutMs?: number; maxPages?: number;
};
type RecordValue = Record<string, unknown>;
type Original = {
  url: string; phase: string; httpStatus: number; eof: boolean; startedAt: string;
  observedAt: string; serverDate: string | null; contentType: string; body: string; sha256: string;
};
export function wisconsinSourceCheck(value: unknown, code: string): asserts value {
  if (!value) throw new Error(`Wisconsin reported finance held: ${code}`);
}
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hash(body: string): string { return createHash("sha256").update(body).digest("hex"); }
function json(body: string): unknown {
  try { return JSON.parse(body); } catch { throw new Error("Wisconsin reported finance held: source_json"); }
}
export function wisconsinPublicTrpcUrl(procedure: string, input: RecordValue): string {
  wisconsinSourceCheck(PUBLIC_READS.has(procedure), "nonpublic_procedure");
  const cursor = input.cursor;
  let meta: { values: Record<string, [string]>; v: number } | undefined;
  if (record(cursor) && "date" in cursor) {
    const date = cursor.date, parsed = typeof date === "string" ? new Date(date) : null;
    wisconsinSourceCheck(typeof date === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(date)
      && parsed !== null && Number.isFinite(parsed.getTime()) && parsed.toISOString() === date, "cursor_date");
    meta = { values: { "cursor.date": ["Date"] }, v: 1 };
  }
  const url = new URL(`/api/trpc/${procedure}`, ORIGIN);
  url.searchParams.set("batch", "1");
  url.searchParams.set("input", JSON.stringify({ "0": { json: input, ...(meta ? { meta } : {}) } }));
  return url.href;
}
function sourceUrl(raw: string): string {
  const u = new URL(raw);
  wisconsinSourceCheck(u.origin === ORIGIN && !u.username && !u.password && !u.hash, "source_origin");
  if (/^\/browse-data\/registrant\/[1-9]\d*$/.test(u.pathname)) {
    wisconsinSourceCheck(!u.search, "profile_query");
  } else {
    wisconsinSourceCheck(u.pathname.startsWith("/api/trpc/") && PUBLIC_READS.has(u.pathname.slice(10))
      && u.searchParams.get("batch") === "1" && [...u.searchParams.keys()].sort().join(",") === "batch,input", "source_path");
  }
  return u.href;
}
export function wisconsinOriginalPath(cacheDir: string, phase: string, url: string): string {
  wisconsinSourceCheck(/^[a-z][a-z0-9-]{0,79}$/.test(phase), "cache_phase");
  return join(cacheDir, `${phase}-${hash(sourceUrl(url))}.json`);
}
function validateOriginal(value: unknown, url: string, phase: string): Original {
  wisconsinSourceCheck(record(value), "original_shape");
  wisconsinSourceCheck(value.url === url && value.phase === phase && value.httpStatus === 200 && value.eof === true,
    "original_identity_or_status");
  wisconsinSourceCheck(typeof value.body === "string" && Buffer.byteLength(value.body) <= MAX_BODY_BYTES
    && typeof value.sha256 === "string" && hash(value.body) === value.sha256, "original_integrity");
  const start = Date.parse(String(value.startedAt)), end = Date.parse(String(value.observedAt)), now = Date.now();
  wisconsinSourceCheck(Number.isFinite(start) && Number.isFinite(end) && start <= end && end <= now && now - end <= MAX_AGE_MS,
    "original_clock");
  wisconsinSourceCheck(typeof value.contentType === "string" && (value.serverDate === null || typeof value.serverDate === "string"),
    "original_headers");
  return value as Original;
}
function trpcResult(body: string): unknown {
  const payload = json(body);
  wisconsinSourceCheck(Array.isArray(payload) && payload.length === 1 && record(payload[0]) && !payload[0].error, "source_api_error");
  const result = payload[0].result;
  wisconsinSourceCheck(record(result) && record(result.data) && "json" in result.data, "source_api_shape");
  return result.data.json;
}
/**
 * Cached bodies remain exact UTF-8 HTTP originals. A refresh never grants network access.
 * Only a body that `accept` admits is saved, so a challenge page or malformed response never replaces a usable original.
 */
export class WisconsinPublicSourceReader {
  private observed: string[] = [];
  constructor(private readonly options: WisconsinPublicSourceOptions) {}
  observedAt(): string {
    wisconsinSourceCheck(this.observed.length > 0, "missing_observation");
    return [...this.observed].sort()[0]!;
  }
  /** `accept` parses a body; it runs before a fetched body can replace the saved original. */
  async read<T>(rawUrl: string, phase: string, accept: (body: string) => T): Promise<T> {
    const url = sourceUrl(rawUrl), path = wisconsinOriginalPath(this.options.cacheDir, phase, url);
    if (!this.options.refresh) {
      try {
        wisconsinSourceCheck(((await stat(path)).mode & 0o077) === 0, "original_permissions");
        const original = validateOriginal(json(await readFile(path, "utf8")), url, phase), value = accept(original.body);
        this.observed.push(original.observedAt); return value;
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    wisconsinSourceCheck(this.options.allowNetwork === true, this.options.refresh ? "network_refresh_not_allowed" : "saved_original_missing");
    const startedAt = new Date().toISOString(), controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
    try {
      const response = await (this.options.fetchImpl ?? fetch)(url, {
        redirect: "error", credentials: "omit", headers: { accept: "application/json,text/html;q=0.9" }, signal: controller.signal,
      });
      if (response.status !== 200) { await response.body?.cancel(); wisconsinSourceCheck(false, "source_status"); }
      wisconsinSourceCheck(response.body, "source_body_missing");
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          bytes += part.value.byteLength;
          wisconsinSourceCheck(bytes <= MAX_BODY_BYTES, "source_body_bound"); chunks.push(part.value);
        }
      } catch (e) { await reader.cancel().catch(() => {}); throw e; }
      finally { reader.releaseLock(); }
      const body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
      const original = validateOriginal({ url, phase, httpStatus: response.status, eof: true, startedAt,
        observedAt: new Date().toISOString(), serverDate: response.headers.get("date"),
        contentType: response.headers.get("content-type") ?? "", body, sha256: hash(body) }, url, phase);
      const value = accept(body);
      await mkdir(this.options.cacheDir, { recursive: true, mode: 0o700 });
      wisconsinSourceCheck(((await stat(this.options.cacheDir)).mode & 0o077) === 0, "cache_permissions");
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(original)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
      this.observed.push(original.observedAt); return value;
    } catch (e) {
      if (e instanceof Error && /^Wisconsin reported finance held: [a-z_]+$/.test(e.message)) throw e;
      throw new Error("Wisconsin reported finance held: source_read_failed");
    } finally { clearTimeout(timer); }
  }
  async trpc(procedure: string, input: RecordValue, phase: string): Promise<unknown> {
    return this.read(wisconsinPublicTrpcUrl(procedure, input), phase, trpcResult);
  }
  /** Two full scans, exact source counts and an empty terminal; display limits never enter acquisition. */
  async closedRows(procedure: string, countProcedure: string, filter: RecordValue, phase: string,
    sortBy: string): Promise<RecordValue[]> {
    wisconsinSourceCheck(COUNTS[procedure] === countProcedure, "count_procedure");
    wisconsinSourceCheck(!["take", "skip", "cursor", "sortBy", "sortDirection"].some(k => k in filter), "paging_filter");
    const maxPages = this.options.maxPages ?? 1_000;
    wisconsinSourceCheck(Number.isInteger(maxPages) && maxPages > 0 && maxPages <= 10_000, "max_pages");
    const count = await this.trpc(countProcedure, filter, `${phase}-count-open`);
    wisconsinSourceCheck(Number.isSafeInteger(count) && (count as number) >= 0, "source_count");
    const scan = async (side: string) => {
      const rows: RecordValue[] = [], ids = new Set<number>(); let cursor: unknown;
      for (let page = 0; page < maxPages; page++) {
        const result = await this.trpc(procedure, { ...filter, take: 100, sortBy, sortDirection: "desc",
          ...(cursor ? { cursor } : {}) }, `${phase}-page-${side}`);
        wisconsinSourceCheck(record(result) && Array.isArray(result.results), "page_shape");
        if (!result.results.length) {
          wisconsinSourceCheck(rows.length === count, "count_mismatch"); return rows;
        }
        for (const row of result.results) {
          wisconsinSourceCheck(record(row) && Number.isSafeInteger(row.id) && (row.id as number) > 0 && !ids.has(row.id as number), "duplicate_or_invalid_row_id");
          ids.add(row.id as number); rows.push(row);
        }
        wisconsinSourceCheck(rows.length <= (count as number), "count_mismatch");
        cursor = result.nextCursor;
        wisconsinSourceCheck(record(cursor) && cursor.id === rows.at(-1)!.id
          && Object.keys(cursor).every(k => k === "id" || k === "date"), "native_cursor");
      }
      throw new Error("Wisconsin reported finance held: page_overflow");
    };
    const open = await scan("open"), close = await scan("close");
    const finalCount = await this.trpc(countProcedure, filter, `${phase}-count-close`);
    wisconsinSourceCheck(finalCount === count && isDeepStrictEqual(open, close), "source_changed");
    return open;
  }
}
