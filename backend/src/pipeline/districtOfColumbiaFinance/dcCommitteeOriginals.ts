import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { DC_COMMITTEE_ORIGIN, dcCheck, dcHold } from "./dcCommitteeNative.js";

export type DcCommitteeOriginal = {
  role: string;
  url: string;
  method: "GET" | "POST";
  requestFile: string | null;
  requestSha256: string | null;
  file: string;
  sha256: string;
  status: number;
  location: string | null;
  contentType: string | null;
  contentEncoding: string | null;
  declaredLength: string | null;
  serverDate: string | null;
  startedAt: string;
  completedAt: string;
  bytes: number;
  eof: boolean;
};
export type DcCommitteeManifest = {
  version: 1;
  year: number;
  records: DcCommitteeOriginal[];
};
export const DC_COMMITTEE_CACHE = resolve("scratch/dc-committee-finance");
const MAX_BODY = 64 * 1024 * 1024;
export const dcSha = (raw: Uint8Array | string): string =>
  createHash("sha256").update(raw).digest("hex");
export const dcIso = (v: unknown): v is string =>
  typeof v === "string" &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const PATHS: Record<string, "GET" | "POST"> = {
  "/ContributionExpenditure/SearchRecipients/2": "POST",
  "/DataDownload": "GET",
  "/DataDownload/SubmitSearch": "POST",
  "/DataDownload/SearchResults": "GET",
  "/DataDownload/Search": "POST",
  "/DataDownload/Export?exportType=CSV": "GET",
  "/FinancialReports": "GET",
  "/FinancialReports/SubmitSearch": "POST",
  "/FinancialReports/SearchResults": "GET",
  "/FinancialReports/Search": "POST",
};
export function dcOriginalScope(url: string, method: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.origin === DC_COMMITTEE_ORIGIN &&
      !u.username &&
      !u.password &&
      !u.hash &&
      PATHS[u.pathname + u.search] === method
    );
  } catch {
    return false;
  }
}
export async function dcPrivateDirectory(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  const s = await fs.lstat(path);
  dcCheck(
    s.isDirectory() && !s.isSymbolicLink() && !(s.mode & 0o077),
    "private_cache_directory",
  );
}
export async function dcPrivateRead(
  path: string,
  limit = MAX_BODY,
): Promise<Buffer> {
  const s = await fs.lstat(path);
  dcCheck(
    s.isFile() && !s.isSymbolicLink() && !(s.mode & 0o077) && s.size <= limit,
    "private_original_file",
  );
  return fs.readFile(path);
}
export function dcObservationValid(
  r: DcCommitteeOriginal,
  previous?: string,
): boolean {
  return (
    !!r &&
    /^[a-z0-9:_-]{1,150}$/.test(r.role) &&
    dcOriginalScope(r.url, r.method) &&
    [200, 302].includes(r.status) &&
    r.eof === true &&
    Number.isSafeInteger(r.bytes) &&
    r.bytes >= 0 &&
    r.bytes <= MAX_BODY &&
    /^[a-f0-9]{64}$/.test(r.sha256) &&
    typeof r.contentType === "string" &&
    /^(?:text\/|application\/(?:text|json|octet-stream|csv|vnd\.ms-excel))/i.test(
      r.contentType,
    ) &&
    dcIso(r.startedAt) &&
    dcIso(r.completedAt) &&
    r.completedAt >= r.startedAt &&
    (!previous || r.startedAt >= previous) &&
    Date.parse(r.completedAt) <= Date.now() &&
    (r.status === 302 ? typeof r.location === "string" : r.location === null)
  );
}
/** Only genuine unchanged response/request bytes are cached. Cookies are
 * anonymous, in-memory and never included in a manifest. */
export class DcCommitteeOriginalSequence {
  private cursor = 0;
  private cookies = new Map<string, string>();
  private constructor(
    readonly year: number,
    readonly directory: string,
    readonly records: DcCommitteeOriginal[],
    private replay: boolean,
    private transport: typeof fetch,
  ) {}
  static async capture(
    year: number,
    root: string,
    transport: typeof fetch = fetch,
  ): Promise<DcCommitteeOriginalSequence> {
    await dcPrivateDirectory(root);
    const directory = resolve(root, `packet-${randomUUID()}`);
    await dcPrivateDirectory(directory);
    return new DcCommitteeOriginalSequence(
      year,
      directory,
      [],
      false,
      transport,
    );
  }
  static async reopen(
    directory: string,
    manifest: DcCommitteeManifest,
  ): Promise<DcCommitteeOriginalSequence> {
    const s = await fs.lstat(directory);
    dcCheck(
      s.isDirectory() && !s.isSymbolicLink() && !(s.mode & 0o077),
      "private_packet_directory",
    );
    dcCheck(
      manifest.version === 1 &&
        Number.isSafeInteger(manifest.year) &&
        manifest.year >= 2021 &&
        manifest.year <= 2100 &&
        Array.isArray(manifest.records) &&
        manifest.records.length > 0 &&
        manifest.records.length <= 5000,
      "source_manifest",
    );
    return new DcCommitteeOriginalSequence(
      manifest.year,
      directory,
      manifest.records,
      true,
      fetch,
    );
  }
  resetAnonymousSession(): void {
    this.cookies.clear();
  }
  get lastOriginal(): DcCommitteeOriginal | undefined {
    return this.replay ? this.records[this.cursor - 1] : this.records.at(-1);
  }
  async request(
    role: string,
    path: string,
    body?: string,
    status = 200,
  ): Promise<Buffer> {
    const url = new URL(path, DC_COMMITTEE_ORIGIN).href,
      method = body === undefined ? "GET" : "POST";
    dcCheck(
      dcOriginalScope(url, method) && /^[a-z0-9:_-]{1,150}$/.test(role),
      "source_request_scope",
    );
    if (this.replay) {
      const r = this.records[this.cursor++],
        index = String(this.cursor).padStart(6, "0");
      dcCheck(
        r &&
          dcObservationValid(
            r,
            this.cursor > 1
              ? this.records[this.cursor - 2]!.completedAt
              : undefined,
          ) &&
          r.role === role &&
          r.url === url &&
          r.method === method &&
          r.status === status &&
          r.file === `${index}.original`,
        "original_request_binding",
      );
      if (body === undefined)
        dcCheck(
          r.requestFile === null && r.requestSha256 === null,
          "original_get_binding",
        );
      else {
        dcCheck(
          r.requestFile === `${index}.request` &&
            r.requestSha256 === dcSha(body),
          "original_post_binding",
        );
        const req = await dcPrivateRead(resolve(this.directory, r.requestFile));
        dcCheck(
          dcSha(req) === r.requestSha256 && req.toString("utf8") === body,
          "original_post_integrity",
        );
      }
      const raw = await dcPrivateRead(resolve(this.directory, r.file));
      dcCheck(
        raw.length === r.bytes && dcSha(raw) === r.sha256,
        "original_body_integrity",
      );
      if (!r.contentEncoding || r.contentEncoding === "identity")
        dcCheck(
          r.declaredLength === null ||
            (/^\d+$/.test(r.declaredLength) &&
              Number(r.declaredLength) === raw.length),
          "original_declared_length",
        );
      return raw;
    }
    dcCheck(this.records.length < 5000, "source_request_limit");
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
    if (body !== undefined) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      headers["x-requested-with"] = "XMLHttpRequest";
    }
    if (this.cookies.size)
      headers.cookie = [...this.cookies.values()].join("; ");
    let response: Response;
    try {
      response = await this.transport(url, {
        method,
        body,
        headers,
        redirect: "manual",
        credentials: "omit",
        signal: AbortSignal.timeout(60000),
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
      return dcHold("public_fetch_failed");
    }
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const pair = raw.split(";")[0]!,
        name = pair.split("=")[0]!;
      if (["ASP.NET_SessionId", ".AspNetCore.Session"].includes(name))
        this.cookies.set(name, pair);
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0,
      eof = !response.body;
    try {
      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const n = await reader.read();
          if (n.done) {
            eof = true;
            break;
          }
          bytes += n.value.length;
          if (bytes > MAX_BODY) {
            await reader.cancel();
            break;
          }
          chunks.push(n.value);
        }
      }
    } catch {
      /* Keep partial bytes and failed EOF. */
    }
    const raw = Buffer.concat(chunks),
      r: DcCommitteeOriginal = {
        role,
        url,
        method,
        requestFile,
        requestSha256: body === undefined ? null : dcSha(body),
        file: `${index}.original`,
        sha256: dcSha(raw),
        status: response.status,
        location: response.headers.get("location"),
        contentType: response.headers.get("content-type"),
        contentEncoding: response.headers.get("content-encoding"),
        declaredLength: response.headers.get("content-length"),
        serverDate: response.headers.get("date"),
        startedAt,
        completedAt: new Date().toISOString(),
        bytes: raw.length,
        eof,
      };
    await fs.writeFile(resolve(this.directory, r.file), raw, {
      mode: 0o600,
      flag: "wx",
    });
    await fs.appendFile(
      resolve(this.directory, "observations.ndjson"),
      JSON.stringify(r) + "\n",
      { mode: 0o600 },
    );
    this.records.push(r);
    dcCheck(
      r.status === status && eof && bytes <= MAX_BODY,
      "incomplete_public_response",
    );
    return raw;
  }
  finish(): DcCommitteeManifest {
    dcCheck(
      !this.replay || this.cursor === this.records.length,
      "unconsumed_originals",
    );
    return { version: 1, year: this.year, records: this.records };
  }
}
