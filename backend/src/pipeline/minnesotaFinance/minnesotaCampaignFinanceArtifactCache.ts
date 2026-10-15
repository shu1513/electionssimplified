import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { Transform } from "node:stream";

export const MINNESOTA_CAMPAIGN_FINANCE_SOURCE = "MINNESOTA_CFB" as const;
export const MINNESOTA_CAMPAIGN_FINANCE_DOWNLOAD_PAGE_URL =
  "https://register.cfb.mn.gov/reports-and-data/self-help/data-downloads/campaign-finance/";
export const MINNESOTA_CAMPAIGN_FINANCE_FETCH_TIMEOUT_MS = 900_000;
export const DEFAULT_MINNESOTA_CAMPAIGN_FINANCE_CACHE_DIR =
  "scratch/minnesota-campaign-finance";

export const MINNESOTA_CAMPAIGN_FINANCE_CONTRIBUTIONS_CSV_FILE_NAME =
  "all_contributions_received.csv";
export const MINNESOTA_CAMPAIGN_FINANCE_INDEPENDENT_EXPENDITURES_CSV_FILE_NAME =
  "all_independent_expenditures.csv";
export const MINNESOTA_CAMPAIGN_FINANCE_IE_CONTRIBUTORS_CSV_FILE_NAME =
  "ie_committee_contributions.csv";

export type MinnesotaCampaignFinanceDownloadKey =
  | "contributions_received"
  | "independent_expenditures"
  | "independent_expenditure_contributions";

export type MinnesotaCampaignFinanceRemoteDownloadMetadata = {
  key: MinnesotaCampaignFinanceDownloadKey;
  label: string;
  sourcePageUrl: string;
  url: string;
  filename: string | null;
  contentLength: number | null;
  contentType: string | null;
  contentDisposition: string | null;
};

export type MinnesotaCampaignFinanceDownloadResult = MinnesotaCampaignFinanceRemoteDownloadMetadata & {
  outputPath: string;
  bytesWritten: number;
  sha256: string;
};

export type MinnesotaCampaignFinanceArtifactCacheDownloadMetadata = {
  outputPath: string;
  bytesWritten: number;
  sha256: string;
  startedAt?: string;
  completedAt?: string;
  remote: MinnesotaCampaignFinanceRemoteDownloadMetadata;
};

export type MinnesotaCampaignFinanceArtifactCacheMetadata = {
  version: 1 | 2;
  generation?: string;
  cacheDir: string;
  metadataPath: string;
  downloadedAt: string;
  sourcePageUrl: string;
  downloads: Record<MinnesotaCampaignFinanceDownloadKey, MinnesotaCampaignFinanceArtifactCacheDownloadMetadata>;
};

export type MinnesotaCampaignFinanceArtifactRefreshResult = {
  status: "downloaded" | "unchanged";
  cacheDir: string;
  metadataPath: string;
  previous: MinnesotaCampaignFinanceArtifactCacheMetadata | null;
  current: MinnesotaCampaignFinanceArtifactCacheMetadata;
};

export type MinnesotaCampaignFinanceDownloadDescriptor = {
  key: MinnesotaCampaignFinanceDownloadKey;
  label: string;
};

export type MinnesotaCampaignFinanceArtifactCachePaths = {
  cacheDir: string;
  metadataPath: string;
  downloads: Record<MinnesotaCampaignFinanceDownloadKey, string>;
};

type FetchOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const MINNESOTA_CAMPAIGN_FINANCE_DOWNLOAD_DESCRIPTORS: readonly MinnesotaCampaignFinanceDownloadDescriptor[] = [
  {
    key: "contributions_received",
    label: "All Contributions received by all entities - 2015 to present",
  },
  {
    key: "independent_expenditures",
    label: "All Independent expenditures by all entities - 2015 to present",
  },
  {
    key: "independent_expenditure_contributions",
    label: "Independent expenditure committees and funds Contributions received by independent expenditure committees and funds only - 2015 to present",
  },
];

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function normalizeNonEmptyText(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) {
    throw new Error("Minnesota campaign finance label is required");
  }
  return normalized;
}

function normalizeHttpsUrl(value: string, fieldName = "Minnesota campaign finance URL"): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid ${fieldName}: ${value}`);
  }

  if (parsed.protocol !== "https:") {
    throw new Error(`Invalid ${fieldName} protocol: ${parsed.protocol}. Only https is allowed.`);
  }

  return parsed.toString();
}

async function fetchWithTimeout(url: string, init: RequestInit, options: FetchOptions): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? MINNESOTA_CAMPAIGN_FINANCE_FETCH_TIMEOUT_MS;
  const headers = new Headers(init.headers);
  if (!headers.has("accept")) {
    headers.set("accept", "text/html,application/xhtml+xml,application/octet-stream,text/csv;q=0.9,*/*;q=0.1");
  }
  try {
    // The signal remains live after headers arrive, including response-body reads.
    return await (options.fetchImpl ?? fetch)(url, {
      ...init, headers, signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`Minnesota campaign finance request timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}

function parseContentDispositionFilename(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const filenameMatch = /filename\*=UTF-8''([^;]+)|filename="([^"]+)"|filename=([^;]+)/i.exec(value);
  const rawFilename = filenameMatch?.[1] ?? filenameMatch?.[2] ?? filenameMatch?.[3];
  if (!rawFilename) {
    return null;
  }

  try {
    return decodeURIComponent(rawFilename.trim());
  } catch {
    return rawFilename.trim();
  }
}

function htmlDecode(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripHtmlTags(value: string): string {
  return value.replace(/<[^>]*>/g, " ");
}

function normalizeHtmlText(value: string): string {
  return htmlDecode(stripHtmlTags(value)).replace(/\s+/g, " ").trim().toLowerCase();
}

function findDownloadUrlsByLabel(input: {
  html: string;
  pageUrl: string;
  descriptors: readonly MinnesotaCampaignFinanceDownloadDescriptor[];
}): Record<MinnesotaCampaignFinanceDownloadKey, string> {
  const normalizedDescriptors = input.descriptors.map((descriptor) => ({
    ...descriptor,
    normalizedLabel: normalizeNonEmptyText(descriptor.label).toLowerCase(),
  }));

  const matches = new Map<MinnesotaCampaignFinanceDownloadKey, string>();
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  for (const rowHtml of input.html.matchAll(rowPattern)) {
    const row = rowHtml[1] ?? "";
    const rowText = normalizeHtmlText(row);
    const hrefMatch = /<a\b[^>]*href="([^"]+)"/i.exec(row);
    if (!hrefMatch) {
      continue;
    }

    for (const descriptor of normalizedDescriptors) {
      if (!rowText.includes(descriptor.normalizedLabel)) {
        continue;
      }
      const resolvedUrl = normalizeHttpsUrl(new URL(htmlDecode(hrefMatch[1]), input.pageUrl).toString());
      const previous = matches.get(descriptor.key);
      if (previous && previous !== resolvedUrl) {
        throw new Error(
          `Ambiguous Minnesota campaign finance download link for ${descriptor.key}: ${previous} vs ${resolvedUrl}`
        );
      }
      matches.set(descriptor.key, resolvedUrl);
    }
  }

  const resolved: Partial<Record<MinnesotaCampaignFinanceDownloadKey, string>> = {};
  for (const descriptor of normalizedDescriptors) {
    const url = matches.get(descriptor.key);
    if (!url) {
      throw new Error(`Missing Minnesota campaign finance download link for ${descriptor.key}`);
    }
    resolved[descriptor.key] = url;
  }

  return resolved as Record<MinnesotaCampaignFinanceDownloadKey, string>;
}

async function fetchMinnesotaCampaignFinanceDownloadPage(input: FetchOptions): Promise<{ pageUrl: string; html: string }> {
  const pageUrl = normalizeHttpsUrl(MINNESOTA_CAMPAIGN_FINANCE_DOWNLOAD_PAGE_URL, "Minnesota campaign finance page URL");
  const response = await fetchWithTimeout(
    pageUrl,
    {
      method: "GET",
      headers: {
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
      },
    },
    input
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch Minnesota campaign finance download page: ${response.status} ${response.statusText}`);
  }

  const responseUrl = normalizeHttpsUrl(response.url || pageUrl, "Minnesota campaign finance page response URL");
  if (new URL(responseUrl).host !== new URL(pageUrl).host) {
    throw new Error(
      `Invalid Minnesota campaign finance page response host: ${new URL(responseUrl).host}. Expected ${new URL(pageUrl).host}.`
    );
  }

  return {
    pageUrl: responseUrl,
    html: await response.text(),
  };
}

export function getMinnesotaCampaignFinanceArtifactCachePaths(cacheDir: string): MinnesotaCampaignFinanceArtifactCachePaths {
  const normalizedCacheDir = resolve(cacheDir);
  return {
    cacheDir: normalizedCacheDir,
    metadataPath: resolve(normalizedCacheDir, "minnesota_campaign_finance.metadata.json"),
    downloads: {
      contributions_received: resolve(normalizedCacheDir, MINNESOTA_CAMPAIGN_FINANCE_CONTRIBUTIONS_CSV_FILE_NAME),
      independent_expenditures: resolve(normalizedCacheDir, MINNESOTA_CAMPAIGN_FINANCE_INDEPENDENT_EXPENDITURES_CSV_FILE_NAME),
      independent_expenditure_contributions: resolve(
        normalizedCacheDir,
        MINNESOTA_CAMPAIGN_FINANCE_IE_CONTRIBUTORS_CSV_FILE_NAME
      ),
    },
  };
}

function parseBytesCount(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 0 || parsed > MINNESOTA_CAMPAIGN_FINANCE_MAX_DOWNLOAD_BYTES) {
    throw new Error("Invalid Minnesota campaign finance download length");
  }
  return parsed;
}

export const MINNESOTA_CAMPAIGN_FINANCE_MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;

async function downloadMinnesotaCampaignFinanceAttachment(input: {
  key: MinnesotaCampaignFinanceDownloadKey;
  label: string;
  sourcePageUrl: string;
  url: string;
  outputPath: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<MinnesotaCampaignFinanceDownloadResult> {
  const requestedUrl = normalizeHttpsUrl(input.url, `Minnesota campaign finance ${input.key} download URL`);
  const response = await fetchWithTimeout(
    requestedUrl,
    {
      method: "GET",
      headers: {
        accept: "application/octet-stream,text/csv;q=0.9,*/*;q=0.1",
      },
    },
    input
  );

  if (!response.ok) {
    throw new Error(
      `Failed to download Minnesota campaign finance ${input.key}: ${response.status} ${response.statusText}`
    );
  }
  if (!response.body) {
    throw new Error(`Minnesota campaign finance ${input.key} response did not include a body`);
  }

  const responseUrl = normalizeHttpsUrl(
    response.url || requestedUrl,
    `Minnesota campaign finance ${input.key} response URL`
  );
  if (new URL(responseUrl).host !== new URL(requestedUrl).host) {
    throw new Error(
      `Invalid Minnesota campaign finance ${input.key} response host: ${new URL(responseUrl).host}. Expected ${new URL(requestedUrl).host}.`
    );
  }

  const outputPath = resolve(input.outputPath);
  await mkdir(resolve(outputPath, ".."), { recursive: true });
  const tmpPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  let contentLength: number | null;
  try { contentLength = parseBytesCount(response.headers.get("content-length")); }
  catch (error) { await response.body.cancel().catch(() => {}); throw error; }
  const hash = createHash("sha256");
  let bytesWritten = 0;
  const hashSink = new Transform({
    transform(chunk, _encoding, callback) {
      bytesWritten += chunk.length;
      if (bytesWritten > MINNESOTA_CAMPAIGN_FINANCE_MAX_DOWNLOAD_BYTES) {
        callback(new Error("Minnesota campaign finance download exceeds byte limit"));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  let fileStat;
  try {
    const source = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);
    await pipeline(source, hashSink, createWriteStream(tmpPath, { flags: "wx", mode: 0o600 }), {
      signal: AbortSignal.timeout(input.timeoutMs ?? MINNESOTA_CAMPAIGN_FINANCE_FETCH_TIMEOUT_MS),
    });
    fileStat = await stat(tmpPath);
    if (contentLength !== null && fileStat.size !== contentLength) {
      throw new Error("Minnesota campaign finance download size mismatch");
    }
    await rename(tmpPath, outputPath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }

  const sha256 = hash.digest("hex");
  const contentDisposition = response.headers.get("content-disposition");
  const contentType = response.headers.get("content-type");

  return {
    key: input.key,
    label: input.label,
    sourcePageUrl: input.sourcePageUrl,
    url: responseUrl,
    filename: parseContentDispositionFilename(contentDisposition),
    contentLength,
    contentType,
    contentDisposition,
    outputPath,
    bytesWritten: fileStat.size,
    sha256,
  };
}

function normalizeRefreshTimestamp(value: Date | undefined): Date {
  const normalized = value ?? new Date();
  if (Number.isNaN(normalized.getTime())) {
    throw new Error("Invalid Minnesota campaign finance artifact refresh timestamp");
  }
  return normalized;
}

const INVALID_CACHE = "Invalid Minnesota campaign finance cached component";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const validInstant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const validBytes = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MINNESOTA_CAMPAIGN_FINANCE_MAX_DOWNLOAD_BYTES;
function officialHttps(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      (url.hostname === "cfb.mn.gov" || url.hostname.endsWith(".cfb.mn.gov"));
  } catch { return false; }
}

export async function readMinnesotaCampaignFinanceArtifactCacheMetadata(
  metadataPath: string
): Promise<MinnesotaCampaignFinanceArtifactCacheMetadata | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(metadataPath, "utf8"));
    // Entries qualify independently, so one corrupt funder entry cannot hide valid IE.
    if (!isRecord(parsed) || (parsed.version !== 1 && parsed.version !== 2) ||
      typeof parsed.cacheDir !== "string" || typeof parsed.metadataPath !== "string" ||
      !validInstant(parsed.downloadedAt) || !officialHttps(parsed.sourcePageUrl) ||
      !isRecord(parsed.downloads) ||
      (parsed.version === 2 && (typeof parsed.generation !== "string" || !/^[a-f0-9-]{36}$/.test(parsed.generation)))) return null;
    return parsed as MinnesotaCampaignFinanceArtifactCacheMetadata;
  } catch { return null; }
}

export function resolveMinnesotaCampaignFinanceCachedDownload(input: {
  cacheDir: string;
  metadata: MinnesotaCampaignFinanceArtifactCacheMetadata | null;
  key: MinnesotaCampaignFinanceDownloadKey;
}): MinnesotaCampaignFinanceArtifactCacheDownloadMetadata {
  const { metadata, key } = input;
  const paths = getMinnesotaCampaignFinanceArtifactCachePaths(input.cacheDir);
  const descriptor = MINNESOTA_CAMPAIGN_FINANCE_DOWNLOAD_DESCRIPTORS.find((item) => item.key === key);
  if (!metadata || !descriptor || (metadata.version !== 1 && metadata.version !== 2) ||
    metadata.cacheDir !== paths.cacheDir || metadata.metadataPath !== paths.metadataPath ||
    !validInstant(metadata.downloadedAt) || !officialHttps(metadata.sourcePageUrl)) throw new Error(INVALID_CACHE);
  if (metadata.version === 2 && (typeof metadata.generation !== "string" || !/^[a-f0-9-]{36}$/.test(metadata.generation))) throw new Error(INVALID_CACHE);
  const expectedPath = metadata.version === 1 ? paths.downloads[key] :
    resolve(paths.cacheDir, "generations", metadata.generation!, basename(paths.downloads[key]));
  const entry = metadata.downloads?.[key];
  if (!entry || entry.outputPath !== expectedPath || !validBytes(entry.bytesWritten) ||
    typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
    !isRecord(entry.remote) || entry.remote.key !== key || entry.remote.label !== descriptor.label ||
    entry.remote.sourcePageUrl !== metadata.sourcePageUrl || !officialHttps(entry.remote.url) ||
    (entry.remote.contentLength !== null && (!validBytes(entry.remote.contentLength) || entry.remote.contentLength !== entry.bytesWritten)) ||
    (entry.startedAt !== undefined && !validInstant(entry.startedAt)) ||
    (entry.completedAt !== undefined && !validInstant(entry.completedAt)) ||
    (entry.startedAt !== undefined && entry.completedAt !== undefined && Date.parse(entry.startedAt) > Date.parse(entry.completedAt))) throw new Error(INVALID_CACHE);
  return entry;
}

function metadataMatches(
  previous: MinnesotaCampaignFinanceArtifactCacheMetadata | null,
  nextDownloads: Record<MinnesotaCampaignFinanceDownloadKey, MinnesotaCampaignFinanceArtifactCacheDownloadMetadata>,
  sourcePageUrl: string
): boolean {
  if (!previous || previous.sourcePageUrl !== sourcePageUrl) {
    return false;
  }

  return (Object.keys(nextDownloads) as MinnesotaCampaignFinanceDownloadKey[]).every((key) => {
    const prior = previous.downloads[key];
    const next = nextDownloads[key];
    return (
      prior &&
      prior.sha256 === next.sha256 &&
      prior.bytesWritten === next.bytesWritten &&
      prior.remote?.url === next.remote.url
    );
  });
}

export async function refreshMinnesotaCampaignFinanceArtifactCache(input: {
  cacheDir: string;
  force?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: Date;
}): Promise<MinnesotaCampaignFinanceArtifactRefreshResult> {
  const downloadedAt = normalizeRefreshTimestamp(input.now);
  const paths = getMinnesotaCampaignFinanceArtifactCachePaths(input.cacheDir);
  await mkdir(paths.cacheDir, { recursive: true });

  const previous = await readMinnesotaCampaignFinanceArtifactCacheMetadata(paths.metadataPath);
  const discovered = await fetchMinnesotaCampaignFinanceDownloadPage({
    fetchImpl: input.fetchImpl,
    timeoutMs: input.timeoutMs,
  });
  const resolvedUrls = findDownloadUrlsByLabel({
    html: discovered.html,
    pageUrl: discovered.pageUrl,
    descriptors: MINNESOTA_CAMPAIGN_FINANCE_DOWNLOAD_DESCRIPTORS,
  });

  const generation = randomUUID();
  const generationDir = resolve(paths.cacheDir, "generations", generation);
  const manifestTmp = `${paths.metadataPath}.tmp-${generation}`;
  await mkdir(generationDir, { recursive: true, mode: 0o700 });
  let published = false;
  try {
    const { readMinnesotaCampaignFinanceNativeRows } = await import("./minnesotaCampaignFinanceArtifactReader.js");
    const downloads = {} as MinnesotaCampaignFinanceArtifactCacheMetadata["downloads"];
    for (const descriptor of MINNESOTA_CAMPAIGN_FINANCE_DOWNLOAD_DESCRIPTORS) {
      const startedAt = new Date().toISOString();
      const downloaded = await downloadMinnesotaCampaignFinanceAttachment({
        key: descriptor.key, label: descriptor.label, sourcePageUrl: discovered.pageUrl,
        url: resolvedUrls[descriptor.key],
        outputPath: resolve(generationDir, basename(paths.downloads[descriptor.key])),
        fetchImpl: input.fetchImpl, timeoutMs: input.timeoutMs,
      });
      await readMinnesotaCampaignFinanceNativeRows({
        filePath: downloaded.outputPath, key: descriptor.key,
        expectedSha256: downloaded.sha256, expectedBytes: downloaded.bytesWritten,
        predicate: () => false,
      });
      const { outputPath, bytesWritten, sha256, ...remote } = downloaded;
      downloads[descriptor.key] = { outputPath, bytesWritten, sha256, remote,
        startedAt, completedAt: new Date().toISOString() };
    }
    const current: MinnesotaCampaignFinanceArtifactCacheMetadata = {
      version: 2, generation, cacheDir: paths.cacheDir, metadataPath: paths.metadataPath,
      downloadedAt: downloadedAt.toISOString(), sourcePageUrl: discovered.pageUrl, downloads,
    };
    for (const descriptor of MINNESOTA_CAMPAIGN_FINANCE_DOWNLOAD_DESCRIPTORS) {
      resolveMinnesotaCampaignFinanceCachedDownload({ cacheDir: paths.cacheDir, metadata: current, key: descriptor.key });
    }
    // An unchanged result is safe only when the previous referenced bytes remain complete.
    if (!input.force && previous && metadataMatches(previous, downloads, current.sourcePageUrl)) {
      let previousComplete = true;
      for (const descriptor of MINNESOTA_CAMPAIGN_FINANCE_DOWNLOAD_DESCRIPTORS) {
        try {
          const entry = resolveMinnesotaCampaignFinanceCachedDownload({ cacheDir: paths.cacheDir, metadata: previous, key: descriptor.key });
          await readMinnesotaCampaignFinanceNativeRows({ filePath: entry.outputPath, key: descriptor.key,
            expectedSha256: entry.sha256, expectedBytes: entry.bytesWritten, predicate: () => false });
        } catch { previousComplete = false; break; }
      }
      if (previousComplete) return { status: "unchanged", cacheDir: paths.cacheDir,
        metadataPath: paths.metadataPath, previous, current: previous };
    }
    await writeFile(manifestTmp, `${JSON.stringify(current, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(manifestTmp, paths.metadataPath);
    published = true;
    return { status: "downloaded", cacheDir: paths.cacheDir, metadataPath: paths.metadataPath, previous, current };
  } finally {
    await rm(manifestTmp, { force: true }).catch(() => {});
    // Committed generations stay available to callers that pinned earlier metadata.
    if (!published) await rm(generationDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function discoverMinnesotaCampaignFinanceDownloadDescriptors(): readonly MinnesotaCampaignFinanceDownloadDescriptor[] {
  return MINNESOTA_CAMPAIGN_FINANCE_DOWNLOAD_DESCRIPTORS;
}

export async function discoverMinnesotaCampaignFinanceDownloadUrls(input: FetchOptions = {}): Promise<
  Record<MinnesotaCampaignFinanceDownloadKey, string>
> {
  const discovered = await fetchMinnesotaCampaignFinanceDownloadPage(input);
  return findDownloadUrlsByLabel({
    html: discovered.html,
    pageUrl: discovered.pageUrl,
    descriptors: MINNESOTA_CAMPAIGN_FINANCE_DOWNLOAD_DESCRIPTORS,
  });
}
