import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseMaineMapLightReportControls } from "./maineMapLightReportControls.js";

const sha = (body: Uint8Array | string) =>
  createHash("sha256").update(body).digest("hex");
const unavailable =
  "Maine public financial report unavailable; preserve unresolved payer allocations";

export function validateMaineMapLightReportUrl(raw: string): string {
  const url = new URL(raw);
  if (
    url.origin !== "https://www.mainecampaignfinancedisclosure.com" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    !/^\/public\/filers\/f_[a-z0-9]{26}\/filings\/d_[a-z0-9]{26}$/.test(
      url.pathname,
    )
  ) {
    throw new Error("Invalid Maine public financial report URL");
  }
  return url.href;
}

type ReportArtifact = {
  version: 1;
  sourceUrl: string;
  file: string;
  startedAt: string;
  completedAt: string;
  bytes: number;
  sha256: string;
  sourceMode?: "http" | "browser_dom";
};
export type MaineMapLightReportCapture = {
  html: string;
  sourceUrl: string;
  completedAt: string;
  sha256: string;
};

/** Register an intact, genuinely captured public report in the normal saved-page cache.
 * Capture intervals belong to the original observation, never the cache-copy time.
 */
export async function registerMaineMapLightSavedReport(input: {
  cacheDir: string;
  sourceUrl: string;
  bodyFile: string;
  metadataFile: string;
}): Promise<MaineMapLightReportCapture> {
  input = { ...input };
  const sourceUrl = validateMaineMapLightReportUrl(input.sourceUrl);
  const metadata = JSON.parse(await readFile(input.metadataFile, "utf8"));
  const browserSource =
    metadata.sourceMode === "browser_dom" &&
    metadata.sourceUrl === sourceUrl &&
    metadata.method === undefined &&
    metadata.status === undefined;
  const httpSource =
    (metadata.sourceMode === undefined || metadata.sourceMode === "http") &&
    metadata.method === "GET" &&
    metadata.status === 200;
  if (
    (!browserSource && !httpSource) ||
    metadata.complete !== true ||
    metadata.canonicalPath !== new URL(sourceUrl).pathname ||
    !Number.isSafeInteger(metadata.byteCount) ||
    metadata.byteCount <= 0 ||
    metadata.byteCount > 8 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(metadata.sha256) ||
    !Number.isFinite(Date.parse(metadata.startedAt)) ||
    !Number.isFinite(Date.parse(metadata.completedAt)) ||
    Date.parse(metadata.startedAt) > Date.parse(metadata.completedAt)
  )
    throw new Error("Invalid Maine saved public report metadata");
  const body = await readFile(input.bodyFile);
  if (body.length !== metadata.byteCount || sha(body) !== metadata.sha256)
    throw new Error(
      "Maine saved public report body does not match original capture",
    );
  const html = new TextDecoder("utf-8", { fatal: true }).decode(body);
  parseMaineMapLightReportControls(html, sourceUrl);
  const artifact: ReportArtifact = {
    version: 1,
    sourceUrl,
    file: `${randomUUID()}.html`,
    startedAt: metadata.startedAt,
    completedAt: metadata.completedAt,
    bytes: body.length,
    sha256: metadata.sha256,
    sourceMode: browserSource ? "browser_dom" : "http",
  };
  await mkdir(input.cacheDir, { recursive: true, mode: 0o700 });
  await writeFile(join(input.cacheDir, artifact.file), body, {
    mode: 0o600,
    flag: "wx",
  });
  const pointer = join(input.cacheDir, `${randomUUID()}.json`);
  await writeFile(pointer, JSON.stringify(artifact) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  await rename(pointer, join(input.cacheDir, `${sha(sourceUrl)}.json`));
  return {
    html,
    sourceUrl,
    sha256: artifact.sha256,
    completedAt: artifact.completedAt,
  };
}

/** Fetch a source-observed canonical report reference; opaque activity queries are never accepted. */
export async function captureMaineMapLightReport(input: {
  cacheDir: string;
  sourceUrl: string;
  allowNetwork: boolean;
  refresh?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<
  | { status: "captured"; report: MaineMapLightReportCapture }
  | { status: "unavailable"; diagnostic: string }
> {
  const sourceUrl = validateMaineMapLightReportUrl(input.sourceUrl);
  const cacheDir = input.cacheDir;
  const allowNetwork = input.allowNetwork;
  const refresh = input.refresh === true;
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 60_000;
  const maxBytes = input.maxBytes ?? 8 * 1024 * 1024;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  )
    throw new Error("Invalid Maine public report capture limits");
  const key = sha(sourceUrl);
  const decode = (bytes: Buffer) => {
    const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parseMaineMapLightReportControls(html, sourceUrl);
    return html;
  };
  let saved: MaineMapLightReportCapture | undefined;
  try {
    const artifact: ReportArtifact = JSON.parse(
      await readFile(join(cacheDir, `${key}.json`), "utf8"),
    );
    if (
      artifact.version !== 1 ||
      artifact.sourceUrl !== sourceUrl ||
      !/^[a-f0-9-]{36}\.html$/.test(artifact.file) ||
      !Number.isFinite(Date.parse(artifact.startedAt)) ||
      !Number.isFinite(Date.parse(artifact.completedAt)) ||
      Date.parse(artifact.startedAt) > Date.parse(artifact.completedAt) ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes <= 0 ||
      artifact.bytes > maxBytes ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256)
    )
      throw new Error(unavailable);
    const body = await readFile(join(cacheDir, artifact.file));
    if (body.length !== artifact.bytes || sha(body) !== artifact.sha256)
      throw new Error(unavailable);
    saved = {
      html: decode(body),
      sourceUrl,
      completedAt: artifact.completedAt,
      sha256: artifact.sha256,
    };
  } catch {
    /* A failed fresh acquisition never promotes stale evidence. */
  }
  if (!allowNetwork || (!refresh && saved))
    return saved
      ? { status: "captured", report: saved }
      : { status: "unavailable", diagnostic: unavailable };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const startedAt = new Date().toISOString();
    const response = await fetchImpl(sourceUrl, {
      redirect: "error",
      credentials: "omit",
      signal: controller.signal,
      headers: {
        Accept: "text/html",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      },
    });
    if (response.status !== 200 || !response.body) throw new Error(unavailable);
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          throw new Error(unavailable);
        }
        chunks.push(Buffer.from(chunk.value));
      }
    } finally {
      reader.releaseLock();
    }
    const body = Buffer.concat(chunks);
    const artifact: ReportArtifact = {
      version: 1,
      sourceUrl,
      file: `${randomUUID()}.html`,
      startedAt,
      completedAt: new Date().toISOString(),
      bytes: body.length,
      sha256: sha(body),
    };
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    await writeFile(join(cacheDir, artifact.file), body, {
      mode: 0o600,
      flag: "wx",
    });
    // Retain the HTTP original even when source markup changes. Only a parsed
    // report can advance the verified pointer below.
    await writeFile(
      join(cacheDir, artifact.file.replace(/\.html$/, ".artifact.json")),
      JSON.stringify(artifact) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    const html = decode(body);
    const temporary = join(cacheDir, `${randomUUID()}.json`);
    await writeFile(temporary, JSON.stringify(artifact) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, join(cacheDir, `${key}.json`));
    return {
      status: "captured",
      report: {
        html,
        sourceUrl,
        completedAt: artifact.completedAt,
        sha256: artifact.sha256,
      },
    };
  } catch {
    return { status: "unavailable", diagnostic: unavailable };
  } finally {
    clearTimeout(timer);
  }
}
