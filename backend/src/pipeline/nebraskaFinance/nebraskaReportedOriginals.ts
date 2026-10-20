import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  NEBRASKA_NATIVE_URLS,
  neCheck,
  neHold,
  type NebraskaSourceKind,
} from "./nebraskaReportedNative.js";

export type NebraskaOriginal = {
  role: string;
  url: string;
  method: "GET" | "POST";
  requestFile: string | null;
  requestSha256: string | null;
  file: string;
  sha256: string;
  status: number;
  contentType: string | null;
  contentEncoding: string | null;
  declaredLength: string | null;
  serverDate: string | null;
  startedAt: string;
  completedAt: string;
  bytes: number;
  eof: boolean;
};
export type NebraskaOriginalManifest = {
  version: 1;
  kind: NebraskaSourceKind;
  year: number;
  records: NebraskaOriginal[];
};
export type NebraskaOriginalTransport = typeof fetch;
export const NEBRASKA_REPORTED_CACHE = resolve(
  "scratch/nebraska-reported-finance",
);
export const neSha = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");
const MAX_BODY = 64 * 1024 * 1024;
export async function nePrivateDirectory(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(path);
  neCheck(
    stat.isDirectory() && !stat.isSymbolicLink() && !(stat.mode & 0o077),
    "private_cache_directory",
  );
}
export async function nePrivateRead(
  path: string,
  maxBytes = MAX_BODY,
): Promise<Buffer> {
  const stat = await fs.lstat(path);
  neCheck(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      !(stat.mode & 0o077) &&
      stat.size <= maxBytes,
    "private_original_file",
  );
  return fs.readFile(path);
}

/** Original request bodies and fetch-decoded response bytes stay private and
 * unchanged. Anonymous session cookies live only in memory. */
export class NebraskaOriginalSequence {
  readonly records: NebraskaOriginal[];
  readonly directory: string;
  private cursor = 0;
  private readonly cookies = new Map<string, string>();
  private constructor(
    readonly kind: NebraskaSourceKind,
    readonly year: number,
    directory: string,
    private readonly replay: boolean,
    records: NebraskaOriginal[],
    private readonly transport: NebraskaOriginalTransport,
  ) {
    this.directory = directory;
    this.records = records;
  }
  static async capture(
    kind: NebraskaSourceKind,
    year: number,
    root: string,
    transport: NebraskaOriginalTransport = fetch,
  ): Promise<NebraskaOriginalSequence> {
    await nePrivateDirectory(root);
    const directory = resolve(root, `packet-${randomUUID()}`);
    await nePrivateDirectory(directory);
    return new NebraskaOriginalSequence(
      kind,
      year,
      directory,
      false,
      [],
      transport,
    );
  }
  static async reopen(
    directory: string,
    manifest: NebraskaOriginalManifest,
  ): Promise<NebraskaOriginalSequence> {
    const stat = await fs.lstat(directory);
    neCheck(
      stat.isDirectory() && !stat.isSymbolicLink() && !(stat.mode & 0o077),
      "private_packet_directory",
    );
    neCheck(
      manifest.version === 1 &&
        Object.hasOwn(NEBRASKA_NATIVE_URLS, manifest.kind) &&
        Number.isSafeInteger(manifest.year) &&
        manifest.year >= 2021 &&
        manifest.year <= 2100 &&
        Array.isArray(manifest.records) &&
        manifest.records.length > 0 &&
        manifest.records.length <= 5000,
      "source_manifest_schema",
    );
    return new NebraskaOriginalSequence(
      manifest.kind,
      manifest.year,
      directory,
      true,
      manifest.records,
      fetch,
    );
  }
  resetAnonymousSession(): void {
    this.cookies.clear();
  }
  async request(role: string, fields?: URLSearchParams): Promise<Buffer> {
    const url = NEBRASKA_NATIVE_URLS[this.kind],
      method = fields ? "POST" : "GET",
      body = fields?.toString();
    neCheck(
      typeof url === "string" &&
        /^[a-z0-9:_-]+$/.test(role) &&
        role.length <= 150,
      "source_request_scope",
    );
    if (this.replay) {
      const record = this.records[this.cursor++];
      const index = String(this.cursor).padStart(6, "0");
      neCheck(
        record &&
          record.role === role &&
          record.url === url &&
          record.method === method &&
          record.status === 200 &&
          record.eof === true &&
          Number.isSafeInteger(record.bytes) &&
          record.bytes >= 0 &&
          record.bytes <= MAX_BODY &&
          record.file === `${index}.original` &&
          /^[a-f0-9]{64}$/.test(record.sha256),
        "original_request_binding",
      );
      const start = Date.parse(record.startedAt),
        end = Date.parse(record.completedAt);
      neCheck(
        Number.isFinite(start) &&
          Number.isFinite(end) &&
          new Date(start).toISOString() === record.startedAt &&
          new Date(end).toISOString() === record.completedAt &&
          start <= end &&
          end <= Date.now() &&
          (this.cursor === 1 ||
            Date.parse(this.records[this.cursor - 2]!.completedAt) <= start),
        "original_clock",
      );
      if (body !== undefined) {
        neCheck(
          record.requestFile === `${index}.request` &&
            record.requestSha256 === neSha(body),
          "original_post_binding",
        );
        const request = await nePrivateRead(
          resolve(this.directory, record.requestFile),
        );
        neCheck(
          neSha(request) === record.requestSha256 &&
            request.toString("utf8") === body,
          "original_post_integrity",
        );
      } else
        neCheck(
          record.requestFile === null && record.requestSha256 === null,
          "original_get_binding",
        );
      const raw = await nePrivateRead(resolve(this.directory, record.file));
      neCheck(
        raw.length === record.bytes && neSha(raw) === record.sha256,
        "original_body_integrity",
      );
      neCheck(
        typeof record.contentType === "string" &&
          /^(?:text\/|application\/(?:octet-stream|csv|vnd\.ms-excel))/i.test(
            record.contentType,
          ),
        "original_content_type",
      );
      if (!record.contentEncoding || record.contentEncoding === "identity")
        neCheck(
          record.declaredLength === null ||
            (/^\d+$/.test(record.declaredLength) &&
              Number(record.declaredLength) === raw.length),
          "original_declared_length",
        );
      return raw;
    }
    neCheck(this.records.length < 5000, "source_request_limit");
    const index = String(this.records.length + 1).padStart(6, "0"),
      requestFile = body === undefined ? null : `${index}.request`;
    if (requestFile)
      await fs.writeFile(resolve(this.directory, requestFile), body!, {
        mode: 0o600,
        flag: "wx",
      });
    const startedAt = new Date().toISOString(),
      headers: Record<string, string> = {
        accept: "*/*",
        "user-agent": "Mozilla/5.0 VoteApp public campaign finance",
      };
    if (body !== undefined)
      headers["content-type"] = "application/x-www-form-urlencoded";
    if (this.cookies.size)
      headers.cookie = [...this.cookies.values()].join("; ");
    let response: Response;
    try {
      response = await this.transport(url, {
        method,
        body,
        headers,
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(45000),
      });
    } catch {
      await fs.appendFile(
        resolve(this.directory, "failed-requests.ndjson"),
        JSON.stringify({
          role,
          url,
          method,
          requestFile,
          startedAt,
          completedAt: new Date().toISOString(),
          status: null,
          eof: false,
          reason: "public_fetch_failed",
        }) + "\n",
        { mode: 0o600 },
      );
      return neHold("public_fetch_failed");
    }
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const pair = cookie.split(";")[0]!,
        name = pair.split("=")[0]!;
      if (["ASP.NET_SessionId", ".AspNetCore.Session"].includes(name))
        this.cookies.set(name, pair);
    }
    const chunks: Uint8Array[] = [];
    let eof = false,
      size = 0;
    try {
      neCheck(response.body, "source_response_body");
      const reader = response.body.getReader();
      while (true) {
        const next = await reader.read();
        if (next.done) {
          eof = true;
          break;
        }
        size += next.value.length;
        if (size > MAX_BODY) {
          await reader.cancel();
          break;
        }
        chunks.push(next.value);
      }
    } catch {
      /* Preserve the actual partial bytes and failed EOF below. */
    }
    const raw = Buffer.concat(chunks),
      record: NebraskaOriginal = {
        role,
        url,
        method,
        requestFile,
        requestSha256: body === undefined ? null : neSha(body),
        file: `${index}.original`,
        sha256: neSha(raw),
        status: response.status,
        contentType: response.headers.get("content-type"),
        contentEncoding: response.headers.get("content-encoding"),
        declaredLength: response.headers.get("content-length"),
        serverDate: response.headers.get("date"),
        startedAt,
        completedAt: new Date().toISOString(),
        bytes: raw.length,
        eof,
      };
    await fs.writeFile(resolve(this.directory, record.file), raw, {
      mode: 0o600,
      flag: "wx",
    });
    await fs.appendFile(
      resolve(this.directory, "observations.ndjson"),
      JSON.stringify(record) + "\n",
      { mode: 0o600 },
    );
    this.records.push(record);
    neCheck(
      record.status === 200 && record.eof && size <= MAX_BODY,
      "incomplete_public_response",
    );
    return raw;
  }
  finish(): NebraskaOriginalManifest {
    neCheck(
      !this.replay || this.cursor === this.records.length,
      "unconsumed_source_originals",
    );
    return {
      version: 1,
      kind: this.kind,
      year: this.year,
      records: this.records,
    };
  }
}
