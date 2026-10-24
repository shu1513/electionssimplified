import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ColoradoReportError } from "./coloradoTracerReports.js";

export const COLORADO_TRACER_ORIGIN = "https://tracer.sos.colorado.gov";
export const COLORADO_TRACER_REPORTS = `${COLORADO_TRACER_ORIGIN}/PublicSite/Reports/Reports.aspx`;
const PATHS = new Set([
  "/PublicSite/Reports/Reports.aspx",
  "/CampaignFinance/Reports/ReportParameters.aspx",
  "/CampaignFinance/Reports/ReportViewer.aspx",
  "/CampaignFinance/Reserved.ReportViewerWebControl.axd",
  "/PublicSite/Reports/ReportViewer.aspx",
  "/PublicSite/Reserved.ReportViewerWebControl.axd",
  "/PublicSite/SearchPages/CommitteeSearch.aspx",
  "/PublicSite/SearchPages/CandidateSearch.aspx",
  "/PublicSite/SearchPages/CandidateDetail.aspx",
  "/PublicSite/SearchPages/FilingDetail.aspx",
  "/PublicSite/SearchPages/FilingAmendmentSelect.aspx",
]);
const MAX_BODY = 64 * 1024 * 1024;
const MAX_RECORDS = 256;
export type ColoradoObservation = {
  role: string;
  url: string;
  method: "GET" | "POST";
  requestFile: string;
  requestSha256: string;
  file: string;
  sha256: string;
  bytes: number;
  status: number;
  eof: boolean;
  contentType: string | null;
  contentEncoding: string | null;
  declaredLength: string | null;
  location: string | null;
  serverDate: string | null;
  startedAt: string;
  completedAt: string;
};
export type ColoradoObservationManifest = {
  version: 1;
  kind: "ie" | "candidate" | "legislative-candidate" | "committee-registry" | "named-receipts";
  year: number;
  complete: boolean;
  records: ColoradoObservation[];
};
export type ColoradoObservationReply = { bytes: Uint8Array; url: string };
const check = (value: unknown, code: string): void => {
  if (!value) throw new ColoradoReportError(code);
};
/** Native report and all-status registry dates use the agency's local day. */
export function coloradoSourceDay(observedAt: string): string {
  const fields = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(observedAt));
  const field = (kind: string) => fields.find((p) => p.type === kind)!.value;
  return `${field("year")}-${field("month")}-${field("day")}`;
}
export const coloradoOriginalSha = (raw: Uint8Array | string): string =>
  createHash("sha256").update(raw).digest("hex");
export function coloradoSourceUrl(
  value: string,
  base = COLORADO_TRACER_ORIGIN,
): URL {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new ColoradoReportError("native_source_url");
  }
  check(
    url.origin === COLORADO_TRACER_ORIGIN &&
      !url.username &&
      !url.password &&
      !url.hash &&
      PATHS.has(url.pathname),
    "native_source_url",
  );
  return url;
}
export async function coloradoPrivateDirectory(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  const st = await fs.lstat(path);
  check(
    st.isDirectory() && !st.isSymbolicLink() && !(st.mode & 0o077),
    "private_cache_directory",
  );
}
export async function coloradoPrivateOriginal(
  path: string,
  max = MAX_BODY,
): Promise<Buffer> {
  const st = await fs.lstat(path);
  check(
    st.isFile() &&
      st.nlink === 1 &&
      !st.isSymbolicLink() &&
      !(st.mode & 0o077) &&
      st.size <= max,
    "private_original_file",
  );
  return fs.readFile(path);
}
function validateManifest(manifest: ColoradoObservationManifest): void {
  check(
    manifest.version === 1 &&
      ["ie", "candidate", "legislative-candidate", "committee-registry", "named-receipts"].includes(manifest.kind) &&
      Number.isSafeInteger(manifest.year) &&
      manifest.year >= 2022 &&
      manifest.year <= 2100 &&
      manifest.complete === true,
    "native_manifest_scope",
  );
  check(
    Array.isArray(manifest.records) &&
      manifest.records.length > 0 &&
      manifest.records.length <= (manifest.kind === "named-receipts" ? 2048 : MAX_RECORDS),
    "native_manifest_population",
  );
  let prior = 0;
  for (const [i, r] of manifest.records.entries()) {
    const first = Date.parse(r.startedAt),
      last = Date.parse(r.completedAt),
      prefix = String(i + 1).padStart(4, "0");
    check(
      r.file === `${prefix}.response` &&
        r.requestFile === `${prefix}.request.json` &&
        /^[a-z0-9_]+$/u.test(r.role),
      "native_original_locator",
    );
    check(
      /^[a-f0-9]{64}$/u.test(r.sha256) &&
        /^[a-f0-9]{64}$/u.test(r.requestSha256) &&
        Number.isSafeInteger(r.bytes) &&
        r.bytes >= 0 &&
        r.bytes <= MAX_BODY,
      "native_original_integrity_metadata",
    );
    check(
      Number.isFinite(first) &&
        Number.isFinite(last) &&
        first >= prior &&
        last >= first &&
        last <= Date.now(),
      "native_observation_clock",
    );
    check(
      Date.now() - first <= 36 * 60 * 60 * 1000,
      "stale_native_observation",
    );
    check(
      ["GET", "POST"].includes(r.method) &&
        [200, 301, 302, 303].includes(r.status) &&
        r.eof === true,
      "incomplete_native_response",
    );
    check(
      r.contentEncoding ||
        r.declaredLength === null ||
        (/^\d+$/u.test(r.declaredLength) &&
          Number(r.declaredLength) === r.bytes),
      "native_declared_length",
    );
    coloradoSourceUrl(r.url);
    if (r.location) coloradoSourceUrl(r.location, r.url);
    prior = last;
  }
  check(
    prior - Date.parse(manifest.records[0]!.startedAt) <= 2 * 60 * 60 * 1000,
    "native_observation_span",
  );
}
/** Both live and saved paths execute the same source-discovered request walk.
 * Manifests contain genuine request/response provenance, never parsed records. */
export class ColoradoTracerObservations {
  readonly directory: string;
  readonly manifest: ColoradoObservationManifest;
  private cursor = 0;
  private readonly saved: boolean;
  private readonly fetcher: typeof fetch;
  private readonly cookies = new Map<string, string>();
  private constructor(
    directory: string,
    manifest: ColoradoObservationManifest,
    saved: boolean,
    fetcher: typeof fetch,
  ) {
    this.directory = directory;
    this.manifest = manifest;
    this.saved = saved;
    this.fetcher = fetcher;
  }
  static async create(
    root: string,
    kind: ColoradoObservationManifest["kind"],
    year: number,
    fetcher: typeof fetch = fetch,
  ): Promise<ColoradoTracerObservations> {
    await coloradoPrivateDirectory(root);
    const directory = resolve(root, `packet-${randomUUID()}`);
    await coloradoPrivateDirectory(directory);
    return new ColoradoTracerObservations(
      directory,
      { version: 1, kind, year, complete: false, records: [] },
      false,
      fetcher,
    );
  }
  static async reopen(
    directory: string,
    manifest: ColoradoObservationManifest,
  ): Promise<ColoradoTracerObservations> {
    await coloradoPrivateDirectory(directory);
    validateManifest(manifest);
    return new ColoradoTracerObservations(directory, manifest, true, fetch);
  }
  private async manifestFile(): Promise<void> {
    const path = resolve(this.directory, `manifest-${randomUUID()}.tmp`);
    await fs.writeFile(path, JSON.stringify(this.manifest, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(path, resolve(this.directory, "manifest.json"));
  }
  private async one(
    role: string,
    url: string,
    body?: string,
  ): Promise<{ bytes: Uint8Array; record: ColoradoObservation }> {
    check(/^[a-z0-9_]+$/u.test(role), "native_observation_role");
    const canonical = coloradoSourceUrl(url).href,
      method = body === undefined ? "GET" : "POST";
    check(this.cursor < (this.manifest.kind === "named-receipts" ? 2048 : MAX_RECORDS), "native_observation_limit");
    if (this.saved) {
      const record = this.manifest.records[this.cursor++];
      check(
        record &&
          record.role === role &&
          record.url === canonical &&
          record.method === method,
        "saved_native_request_walk",
      );
      const request = await coloradoPrivateOriginal(
        resolve(this.directory, record!.requestFile),
        4 * 1024 * 1024,
      );
      check(
        coloradoOriginalSha(request) === record!.requestSha256,
        "native_request_integrity",
      );
      let original: { url: string; method: string; body: string | null };
      try {
        original = JSON.parse(request.toString("utf8"));
      } catch {
        throw new ColoradoReportError("native_request_json");
      }
      check(
        original.url === canonical &&
          original.method === method &&
          original.body === (body ?? null),
        "saved_native_request_scope",
      );
      const bytes = await coloradoPrivateOriginal(
        resolve(this.directory, record!.file),
      );
      check(
        bytes.length === record!.bytes &&
          coloradoOriginalSha(bytes) === record!.sha256,
        "native_response_integrity",
      );
      return { bytes, record: record! };
    }
    const startedAt = new Date().toISOString(),
      prefix = String(++this.cursor).padStart(4, "0");
    const requestFile = `${prefix}.request.json`,
      file = `${prefix}.response`;
    const request = JSON.stringify({
      url: canonical,
      method,
      body: body ?? null,
    });
    await fs.writeFile(resolve(this.directory, requestFile), request, {
      mode: 0o600,
      flag: "wx",
    });
    const headers: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml,text/csv,*/*",
      Origin: COLORADO_TRACER_ORIGIN,
      Referer: COLORADO_TRACER_REPORTS,
    };
    if (body !== undefined)
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (this.cookies.size)
      headers.Cookie = [...this.cookies]
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
    let response: Response;
    try {
      response = await this.fetcher(canonical, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "manual",
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new ColoradoReportError("native_transport_unavailable");
    }
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const pair = cookie.split(";")[0]!,
        at = pair.indexOf("=");
      if (at > 0) this.cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    const declaredLength = response.headers.get("content-length"),
      contentEncoding = response.headers.get("content-encoding");
    const chunks: Uint8Array[] = [];
    let size = 0,
      eof = false;
    try {
      check(
        declaredLength === null ||
          (/^\d+$/u.test(declaredLength) && Number(declaredLength) <= MAX_BODY),
        "native_response_byte_limit",
      );
      const reader = response.body?.getReader();
      if (reader)
        for (;;) {
          const next = await reader.read();
          if (next.done) {
            eof = true;
            break;
          }
          size += next.value.length;
          if (size > MAX_BODY) {
            await reader.cancel();
            throw new ColoradoReportError("native_response_byte_limit");
          }
          chunks.push(next.value);
        }
      else eof = true;
    } catch {
      eof = false;
    }
    const bytes = Buffer.concat(chunks);
    const record: ColoradoObservation = {
      role,
      url: canonical,
      method,
      requestFile,
      requestSha256: coloradoOriginalSha(request),
      file,
      sha256: coloradoOriginalSha(bytes),
      bytes: bytes.length,
      status: response.status,
      eof,
      contentType: response.headers.get("content-type"),
      contentEncoding,
      declaredLength,
      location: response.headers.get("location"),
      serverDate: response.headers.get("date"),
      startedAt,
      completedAt: new Date().toISOString(),
    };
    await fs.writeFile(resolve(this.directory, file), bytes, {
      mode: 0o600,
      flag: "wx",
    });
    this.manifest.records.push(record);
    await this.manifestFile();
    check(
      eof &&
        (contentEncoding ||
          declaredLength === null ||
          Number(declaredLength) === bytes.length),
      "incomplete_native_response",
    );
    await new Promise<void>((done) => setTimeout(done, 250));
    return { bytes, record };
  }
  async request(
    role: string,
    url: string,
    body?: URLSearchParams,
  ): Promise<ColoradoObservationReply> {
    let current = coloradoSourceUrl(url).href;
    for (let redirects = 0; redirects <= 4; redirects++) {
      const result = await this.one(
        redirects ? `${role}_redirect_${redirects}` : role,
        current,
        redirects ? undefined : body?.toString(),
      );
      if (result.record.status === 200)
        return { bytes: result.bytes, url: current };
      check(
        [301, 302, 303].includes(result.record.status) &&
          result.record.location,
        "native_response_status",
      );
      current = coloradoSourceUrl(result.record.location!, current).href;
    }
    throw new ColoradoReportError("native_redirect_limit");
  }
  async finish(): Promise<void> {
    if (this.saved)
      check(
        this.cursor === this.manifest.records.length,
        "unconsumed_native_originals",
      );
    else {
      this.manifest.complete = true;
      await this.manifestFile();
    }
    validateManifest(this.manifest);
  }
}
