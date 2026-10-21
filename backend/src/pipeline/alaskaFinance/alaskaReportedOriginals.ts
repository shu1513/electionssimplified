import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  akCheck,
  akPublicUrl,
  ALASKA_REPORTED_ORIGIN,
  ALASKA_REPORTED_URLS,
} from "./alaskaReportedNative.js";

export const ALASKA_REPORTED_CACHE_DIR = fileURLToPath(
  new URL("../../../scratch/alaska-apoc-reported/", import.meta.url),
);
export const akHash = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
const LIMIT = 128 * 1024 * 1024;
export type AlaskaOriginalMeta = {
  role?: string;
  url: string;
  file: string;
  requestFile: string | null;
  requestSha256: string | null;
  method: "GET" | "POST";
  status: number;
  contentType: string | null;
  contentEncoding?: string | null;
  declaredLength?: string | null;
  serverDate?: string | null;
  location?: string | null;
  startedAt: string;
  completedAt: string;
  bytes: number;
  sha256: string;
  eof: boolean;
};
/** JSONB reorders object properties; provenance hashes must survive that
 * representation change while still binding every original metadata value. */
export const akManifestHash = (
  observations: readonly AlaskaOriginalMeta[],
): string =>
  akHash(
    JSON.stringify(
      observations.map((observation) =>
        Object.fromEntries(
          Object.entries(observation).sort(([a], [b]) => a.localeCompare(b)),
        ),
      ),
    ),
  );
export type AlaskaOriginal = Readonly<{
  meta: Readonly<AlaskaOriginalMeta>;
  raw: Uint8Array;
  request: string | null;
  directory: string;
}>;
const iso = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT";

function sourceUrl(value: string, method: "GET" | "POST"): string {
  const href = akPublicUrl(value, value),
    url = new URL(href),
    pages = Object.values(ALASKA_REPORTED_URLS)
      .filter((u) => u.startsWith(ALASKA_REPORTED_ORIGIN))
      .map((u) => new URL(u).pathname);
  if (url.origin !== ALASKA_REPORTED_ORIGIN) {
    akCheck(
      method === "GET" &&
        url.pathname === "/candidates/" &&
        [...url.searchParams].every(([key, value]) =>
          key === "election"
            ? /^[a-z0-9]{1,20}$/.test(value)
            : /^frm-page-\d+$/.test(key) && /^[1-9]\d*$/.test(value),
        ),
      "roster_url_scope",
    );
  } else if (url.pathname === "/ApocReports/Common/View.aspx") {
    akCheck(
      method === "GET" &&
        url.searchParams.size === 2 &&
        /^[1-9]\d*$/.test(url.searchParams.get("ID") ?? "") &&
        /^[A-Z]{1,12}$/.test(url.searchParams.get("ViewType") ?? ""),
      "report_url_scope",
    );
  } else {
    akCheck(pages.includes(url.pathname), "source_path_scope");
    if (url.search)
      akCheck(
        method === "GET" &&
          url.searchParams.get("exportAll") === "True" &&
          url.searchParams.get("exportFormat") === "CSV" &&
          [...url.searchParams.keys()].every((key) =>
            [
              "exportAll",
              "exportFormat",
              "isExport",
              "pageSize",
              "pageIndex",
            ].includes(key),
          ),
        "source_export_scope",
      );
  }
  return href;
}
function validateMeta(value: unknown): asserts value is AlaskaOriginalMeta {
  const m = value as AlaskaOriginalMeta;
  akCheck(
    m &&
      typeof m.url === "string" &&
      ["GET", "POST"].includes(m.method) &&
      /^\d{5,6}\.original$/.test(m.file) &&
      Number.isInteger(m.status) &&
      m.status >= 100 &&
      m.status <= 599 &&
      typeof m.eof === "boolean" &&
      Number.isSafeInteger(m.bytes) &&
      m.bytes >= 0 &&
      m.bytes <= LIMIT &&
      /^[a-f0-9]{64}$/.test(m.sha256),
    "source_metadata",
  );
  akPublicUrl(m.url, m.url);
  akCheck(
    iso(m.startedAt) &&
      iso(m.completedAt) &&
      m.completedAt >= m.startedAt &&
      Date.parse(m.completedAt) <= Date.now(),
    "source_observation_clock",
  );
  akCheck(
    m.contentType === null || typeof m.contentType === "string",
    "source_content_type",
  );
  akCheck(
    m.method === "POST"
      ? /^\d{5,6}\.request$/.test(m.requestFile ?? "") &&
          /^[a-f0-9]{64}$/.test(m.requestSha256 ?? "")
      : !m.requestFile && !m.requestSha256,
    "source_request_metadata",
  );
}
async function privateDirectory(path: string): Promise<void> {
  const stat = await fs.lstat(path);
  akCheck(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (stat.mode & 0o777) === 0o700,
    "source_directory_privacy",
  );
}
async function privateFile(path: string): Promise<Uint8Array> {
  const stat = await fs.lstat(path);
  akCheck(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      (stat.mode & 0o777) === 0o600 &&
      stat.size <= LIMIT,
    "source_file_privacy",
  );
  return fs.readFile(path);
}
export function akSuccessfulOriginal(
  record: AlaskaOriginal,
  mime: "html" | "csv",
): boolean {
  const length = record.meta.declaredLength;
  const lengthMatches =
    (record.meta.contentEncoding &&
      record.meta.contentEncoding !== "identity") ||
    length === null ||
    length === undefined ||
    (/^\d+$/.test(length) &&
      Number.isSafeInteger(Number(length)) &&
      Number(length) === record.meta.bytes);
  return (
    !!lengthMatches &&
    record.meta.status === 200 &&
    record.meta.eof &&
    (mime === "html" ? /text\/html/i : /csv|comma-separated/i).test(
      record.meta.contentType ?? "",
    )
  );
}
export function akFreshOriginal(
  record: AlaskaOriginal,
  now = new Date(),
  maxAgeDays = 7,
): boolean {
  return (
    Date.parse(record.meta.startedAt) >=
      now.getTime() - maxAgeDays * 86400000 &&
    Date.parse(record.meta.completedAt) <= now.getTime()
  );
}

/** Append genuine observations; failures never become empty financial data. */
export class AlaskaOriginalArchive {
  readonly cacheDir: string;
  private directory: string | null = null;
  private sequence = 0;
  private cookies = new Map<string, Map<string, string>>();
  constructor(cacheDir = ALASKA_REPORTED_CACHE_DIR) {
    this.cacheDir = resolve(cacheDir);
  }

  async read(): Promise<AlaskaOriginal[]> {
    try {
      await privateDirectory(this.cacheDir);
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
    const out: AlaskaOriginal[] = [];
    for (const name of await fs.readdir(this.cacheDir)) {
      if (!/^source-originals-[a-f0-9-]{36}$/.test(name)) continue;
      const directory = resolve(this.cacheDir, name),
        stat = await fs.lstat(directory);
      if (stat.isSymbolicLink()) continue;
      await privateDirectory(directory);
      let bytes: Uint8Array;
      try {
        bytes = await privateFile(resolve(directory, "manifest.ndjson"));
      } catch (error) {
        if (missing(error)) continue;
        throw error;
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      akCheck(
        text.length === 0 || text.endsWith("\n"),
        "source_manifest_partial",
      );
      for (const line of text.split("\n").filter(Boolean)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          akCheck(false, "source_manifest_json");
        }
        validateMeta(parsed);
        const meta = parsed,
          raw = await privateFile(resolve(directory, meta.file));
        akCheck(
          raw.byteLength === meta.bytes && akHash(raw) === meta.sha256,
          "source_original_integrity",
        );
        let request: string | null = null;
        if (meta.requestFile) {
          const body = await privateFile(resolve(directory, meta.requestFile));
          akCheck(
            akHash(body) === meta.requestSha256,
            "source_request_integrity",
          );
          request = new TextDecoder("utf-8", { fatal: true }).decode(body);
        }
        out.push(
          Object.freeze({ meta: Object.freeze(meta), raw, request, directory }),
        );
        akCheck(out.length <= 50000, "source_archive_resource_limit");
      }
    }
    return out.sort((a, b) => a.meta.startedAt.localeCompare(b.meta.startedAt));
  }

  private async ensureDirectory(): Promise<string> {
    if (this.directory) return this.directory;
    await fs.mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    await privateDirectory(this.cacheDir);
    this.directory = resolve(this.cacheDir, `source-originals-${randomUUID()}`);
    await fs.mkdir(this.directory, { mode: 0o700 });
    return this.directory;
  }

  async observe(
    value: string,
    body?: URLSearchParams,
    accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  ): Promise<AlaskaOriginal> {
    const method = body === undefined ? "GET" : "POST",
      url = sourceUrl(value, method),
      directory = await this.ensureDirectory();
    await new Promise((done) => setTimeout(done, 2000));
    const index = String(++this.sequence).padStart(5, "0"),
      request = body?.toString() ?? null,
      requestFile = request === null ? null : `${index}.request`;
    if (requestFile)
      await fs.writeFile(resolve(directory, requestFile), request!, {
        mode: 0o600,
        flag: "wx",
      });
    const headers = new Headers({
      "user-agent": "Mozilla/5.0 VoteApp public finance source research",
      accept,
      "accept-language": "en-US,en;q=0.9",
      referer:
        new URL(url).origin === ALASKA_REPORTED_ORIGIN
          ? new URL(url).origin + new URL(url).pathname
          : url,
    });
    const jar = this.cookies.get(new URL(url).origin);
    if (jar?.size) headers.set("cookie", [...jar.values()].join("; "));
    if (body) {
      headers.set("origin", new URL(url).origin);
      headers.set("content-type", "application/x-www-form-urlencoded");
    }
    const startedAt = new Date().toISOString();
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        body: request ?? undefined,
        headers,
        credentials: "omit",
        redirect: "manual",
        signal: AbortSignal.timeout(180000),
      });
    } catch {
      await fs.appendFile(
        resolve(directory, "failed-requests.ndjson"),
        JSON.stringify({
          url,
          method,
          requestFile,
          startedAt,
          completedAt: new Date().toISOString(),
          status: null,
          eof: false,
          reason: "source_transport_failed",
        }) + "\n",
        { mode: 0o600 },
      );
      akCheck(false, "source_transport_failed");
    }
    const cookies =
      this.cookies.get(new URL(url).origin) ?? new Map<string, string>();
    for (const set of response.headers.getSetCookie()) {
      const pair = set.split(";")[0]!,
        equals = pair.indexOf("=");
      if (equals > 0) cookies.set(pair.slice(0, equals), pair);
    }
    this.cookies.set(new URL(url).origin, cookies);
    const chunks: Uint8Array[] = [];
    let bytes = 0,
      eof = false;
    try {
      akCheck(response.body, "source_body_missing");
      const reader = response.body.getReader();
      while (true) {
        const result = await reader.read();
        if (result.done) {
          eof = true;
          break;
        }
        chunks.push(result.value);
        bytes += result.value.byteLength;
        if (bytes > LIMIT) {
          await reader.cancel();
          break;
        }
      }
    } catch {
      /* Keep the exact partial bytes and EOF=false. */
    }
    const raw = Buffer.concat(chunks),
      file = `${index}.original`,
      meta: AlaskaOriginalMeta = {
        role: "public_observation",
        url,
        method,
        file,
        requestFile,
        requestSha256: request === null ? null : akHash(request),
        status: response.status,
        contentType: response.headers.get("content-type"),
        contentEncoding: response.headers.get("content-encoding"),
        declaredLength: response.headers.get("content-length"),
        serverDate: response.headers.get("date"),
        location: response.headers.get("location"),
        startedAt,
        completedAt: new Date().toISOString(),
        bytes: raw.byteLength,
        sha256: akHash(raw),
        eof,
      };
    await fs.writeFile(resolve(directory, file), raw, {
      mode: 0o600,
      flag: "wx",
    });
    await fs.appendFile(
      resolve(directory, "manifest.ndjson"),
      JSON.stringify(meta) + "\n",
      { mode: 0o600 },
    );
    return Object.freeze({
      meta: Object.freeze(meta),
      raw,
      request,
      directory,
    });
  }
}
