import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import {
  NM_REPORTED_ORIGIN,
  NM_REPORTED_PATHS,
  NewMexicoReportedSourceError,
  nmCheck,
  parseNewMexicoReportedJson,
  type NewMexicoReportedKind,
} from "./newMexicoReportedNative.js";

export type NewMexicoReportedScope = {
  kind: NewMexicoReportedKind;
  year: number;
  selector: string | null;
  memberId?: string | null;
};
export type NewMexicoOriginal = {
  role: string;
  url: string;
  method: "GET" | "POST";
  requestFile: string | null;
  requestSha256: string | null;
  file: string;
  sha256: string;
  status: number;
  eof: boolean;
  bytes: number;
  contentType: string | null;
  contentEncoding: string | null;
  declaredLength: string | null;
  serverDate: string | null;
  startedAt: string;
  completedAt: string;
};
export type NewMexicoOriginalManifest = {
  version: 1;
  scope: NewMexicoReportedScope;
  records: NewMexicoOriginal[];
};
export const NM_REPORTED_CACHE = resolve("scratch/new-mexico-native-finance");
export const nmSha = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");
const MAX_BODY = 128 * 1024 * 1024;
export async function nmPrivateDirectory(path: string): Promise<void> {
  // Check existing ancestors before mkdir so an intermediate symlink cannot
  // redirect private financial originals into another directory.
  for (let current = resolve(path); ; current = dirname(current)) {
    try {
      const st = await fs.lstat(current);
      nmCheck(
        st.isDirectory() && !st.isSymbolicLink(),
        "private_directory_symlink",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (dirname(current) === current) break;
  }
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  const st = await fs.lstat(path);
  nmCheck(
    st.isDirectory() && !st.isSymbolicLink() && !(st.mode & 0o077),
    "private_directory_mode",
  );
}
export async function nmPrivateRead(
  path: string,
  max = MAX_BODY,
): Promise<Buffer> {
  nmCheck(
    !/^\.env(?:\.|$)/.test(path.split(/[\\/]/).at(-1) ?? ""),
    "environment_file_prohibited",
  );
  const parent = await fs.lstat(dirname(path)),
    st = await fs.lstat(path);
  nmCheck(
    parent.isDirectory() &&
      !parent.isSymbolicLink() &&
      !(parent.mode & 0o077) &&
      st.isFile() &&
      !st.isSymbolicLink() &&
      !(st.mode & 0o077) &&
      st.size <= max,
    "private_original_file",
  );
  return fs.readFile(path);
}
export function nmSourceScope(scope: NewMexicoReportedScope): void {
  nmCheck(
    ["registry", "receiver", "committee", "ie"].includes(scope.kind) &&
      Number.isSafeInteger(scope.year) &&
      scope.year >= 2021 &&
      scope.year <= 2100,
    "source_scope",
  );
  nmCheck(
    Object.keys(scope).every((key) =>
      ["kind", "year", "selector", "memberId"].includes(key),
    ),
    "source_scope_fields",
  );
  nmCheck(
    scope.kind === "registry" || scope.kind === "ie"
      ? scope.selector === null
      : typeof scope.selector === "string" &&
          scope.selector.trim().length > 0 &&
          scope.selector.length <= 4096 &&
          !/[\u0000-\u001f]/.test(scope.selector),
    "source_selector",
  );
  nmCheck(
    scope.kind === "committee"
      ? typeof scope.memberId === "string" &&
          scope.memberId.trim().length > 0 &&
          scope.memberId.length <= 4096 &&
          !/[\u0000-\u001f]/.test(scope.memberId)
      : scope.memberId === null || scope.memberId === undefined,
    "source_cycle_member_selector",
  );
}

/** Actual public requests and fetch-decoded response bytes are immutable. No
 * health envelope or caller-created aggregation can replace their contents. */
export class NewMexicoOriginalSequence {
  private cursor = 0;
  private readonly cookies = new Map<string, string>();
  readonly scope: NewMexicoReportedScope;
  private constructor(
    scope: NewMexicoReportedScope,
    readonly directory: string,
    readonly records: NewMexicoOriginal[],
    private readonly replay: boolean,
    private readonly transport: typeof fetch,
  ) {
    this.scope = Object.freeze({ ...scope });
  }
  static async capture(
    scope: NewMexicoReportedScope,
    root: string,
    transport: typeof fetch = fetch,
  ): Promise<NewMexicoOriginalSequence> {
    nmSourceScope(scope);
    await nmPrivateDirectory(root);
    const directory = resolve(root, `packet-${randomUUID()}`);
    await nmPrivateDirectory(directory);
    return new NewMexicoOriginalSequence(
      scope,
      directory,
      [],
      false,
      transport,
    );
  }
  static async reopen(
    directory: string,
    manifest: NewMexicoOriginalManifest,
  ): Promise<NewMexicoOriginalSequence> {
    nmCheck(
      manifest.version === 1 &&
        Array.isArray(manifest.records) &&
        manifest.records.length > 0 &&
        manifest.records.length <= 20000,
      "source_manifest",
    );
    nmSourceScope(manifest.scope);
    await nmPrivateDirectory(directory);
    return new NewMexicoOriginalSequence(
      manifest.scope,
      directory,
      manifest.records,
      true,
      fetch,
    );
  }
  async request(
    role: string,
    path: string,
    payload?: unknown,
  ): Promise<{ value: unknown; original: NewMexicoOriginal }> {
    const url = new URL(path, NM_REPORTED_ORIGIN),
      body = payload === undefined ? undefined : JSON.stringify(payload),
      method = body === undefined ? "GET" : "POST";
    nmCheck(
      url.origin === NM_REPORTED_ORIGIN &&
        !url.username &&
        !url.password &&
        !url.hash &&
        /^[a-z0-9_-]{1,150}$/.test(role),
      "source_request_scope",
    );
    nmCheck(
      method === "POST"
        ? [NM_REPORTED_PATHS.registry, NM_REPORTED_PATHS.transactions].includes(
            url.pathname as typeof NM_REPORTED_PATHS.registry,
          ) && !url.search
        : Object.values(NM_REPORTED_PATHS).includes(
            url.pathname as typeof NM_REPORTED_PATHS.registry,
          ) &&
            ![
              NM_REPORTED_PATHS.registry,
              NM_REPORTED_PATHS.transactions,
            ].includes(url.pathname as typeof NM_REPORTED_PATHS.registry),
      "source_request_method",
    );
    let raw: Buffer, record: NewMexicoOriginal;
    if (this.replay) {
      record = this.records[this.cursor++]!;
      const index = String(this.cursor).padStart(6, "0");
      nmCheck(
        record &&
          record.role === role &&
          record.url === url.href &&
          record.method === method &&
          record.file === `${index}.original`,
        "original_request_binding",
      );
      if (body !== undefined) {
        nmCheck(
          record.requestFile === `${index}.request` &&
            record.requestSha256 === nmSha(body),
          "original_post_binding",
        );
        const request = await nmPrivateRead(
          resolve(this.directory, record.requestFile),
        );
        nmCheck(
          nmSha(request) === record.requestSha256 &&
            request.toString("utf8") === body,
          "original_post_integrity",
        );
      } else
        nmCheck(
          record.requestFile === null && record.requestSha256 === null,
          "original_get_binding",
        );
      raw = await nmPrivateRead(resolve(this.directory, record.file));
    } else {
      nmCheck(this.records.length < 20000, "source_request_limit");
      const index = String(this.records.length + 1).padStart(6, "0"),
        requestFile = body === undefined ? null : `${index}.request`;
      if (requestFile)
        await fs.writeFile(resolve(this.directory, requestFile), body!, {
          mode: 0o600,
          flag: "wx",
        });
      const startedAt = new Date().toISOString(),
        headers: Record<string, string> = {
          accept: "application/json, text/plain",
          "user-agent": "Mozilla/5.0 VoteApp public campaign finance",
        };
      if (body !== undefined) {
        headers["content-type"] = "application/json";
        headers["x-requested-with"] = "XMLHttpRequest";
      }
      if (this.cookies.size)
        headers.cookie = [...this.cookies.values()].join("; ");
      let response: Response;
      try {
        response = await this.transport(url.href, {
          method,
          body,
          headers,
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(60000),
        });
      } catch {
        await fs.appendFile(
          resolve(this.directory, "failed-requests.ndjson"),
          JSON.stringify({
            role,
            url: url.href,
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
        throw new NewMexicoReportedSourceError("public_fetch_failed");
      }
      for (const cookie of response.headers.getSetCookie?.() ?? []) {
        const pair = cookie.split(";")[0]!,
          name = pair.split("=")[0]!;
        if (["ASP.NET_SessionId", ".AspNetCore.Session"].includes(name))
          this.cookies.set(name, pair);
      }
      const chunks: Uint8Array[] = [];
      let bytes = 0,
        eof = false;
      try {
        nmCheck(response.body, "source_response_body");
        const reader = response.body.getReader();
        while (true) {
          const next = await reader.read();
          if (next.done) {
            eof = true;
            break;
          }
          bytes += next.value.length;
          if (bytes > MAX_BODY) {
            await reader.cancel();
            break;
          }
          chunks.push(next.value);
        }
      } catch {
        /* Retain actual partial bytes and failed EOF. */
      }
      raw = Buffer.concat(chunks);
      record = {
        role,
        url: url.href,
        method,
        requestFile,
        requestSha256: body === undefined ? null : nmSha(body),
        file: `${index}.original`,
        sha256: nmSha(raw),
        status: response.status,
        eof,
        bytes: raw.length,
        contentType: response.headers.get("content-type"),
        contentEncoding: response.headers.get("content-encoding"),
        declaredLength: response.headers.get("content-length"),
        serverDate: response.headers.get("date"),
        startedAt,
        completedAt: new Date().toISOString(),
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
    }
    const start = Date.parse(record.startedAt),
      end = Date.parse(record.completedAt),
      previous =
        this.records[(this.replay ? this.cursor : this.records.length) - 2];
    nmCheck(
      record.status === 200 &&
        record.eof === true &&
        Number.isSafeInteger(record.bytes) &&
        record.bytes >= 0 &&
        record.bytes <= MAX_BODY &&
        raw.length === record.bytes &&
        /^[a-f0-9]{64}$/.test(record.sha256) &&
        nmSha(raw) === record.sha256,
      "original_integrity_or_eof",
    );
    nmCheck(
      typeof record.contentType === "string" &&
        /^(?:application\/json|text\/plain)(?:\s*;|$)/i.test(
          record.contentType,
        ),
      "original_content_type",
    );
    nmCheck(
      Number.isFinite(start) &&
        Number.isFinite(end) &&
        new Date(start).toISOString() === record.startedAt &&
        new Date(end).toISOString() === record.completedAt &&
        start <= end &&
        end <= Date.now() &&
        (!previous || Date.parse(previous.completedAt) <= start),
      "original_clock",
    );
    if (!record.contentEncoding || record.contentEncoding === "identity")
      nmCheck(
        record.declaredLength === null ||
          (/^\d+$/.test(record.declaredLength) &&
            Number(record.declaredLength) === raw.length),
        "original_declared_length",
      );
    return { value: parseNewMexicoReportedJson(raw), original: record };
  }
  finish(): NewMexicoOriginalManifest {
    nmCheck(
      this.records.length > 0 &&
        (!this.replay || this.cursor === this.records.length),
      "unconsumed_originals",
    );
    return { version: 1, scope: this.scope, records: this.records };
  }
}
