import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MINNESOTA_CAMPAIGN_FINANCE_CACHE_DIR,
  MINNESOTA_CAMPAIGN_FINANCE_DOWNLOAD_PAGE_URL,
  MINNESOTA_CAMPAIGN_FINANCE_MAX_DOWNLOAD_BYTES,
  discoverMinnesotaCampaignFinanceDownloadUrls,
  getMinnesotaCampaignFinanceArtifactCachePaths,
  readMinnesotaCampaignFinanceArtifactCacheMetadata,
  refreshMinnesotaCampaignFinanceArtifactCache,
  resolveMinnesotaCampaignFinanceCachedDownload,
  type MinnesotaCampaignFinanceArtifactCacheMetadata,
  type MinnesotaCampaignFinanceDownloadKey,
} from "../../../src/pipeline/minnesotaFinance/minnesotaCampaignFinanceArtifactCache.js";

vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(),
  rename: vi.fn(async (...args: Parameters<typeof rename>) => {
    const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    return real.rename(...args);
  }),
}));
const dirs: string[] = [];
const keys: MinnesotaCampaignFinanceDownloadKey[] = ["contributions_received", "independent_expenditures", "independent_expenditure_contributions"];
const receiptHeaders = "Recipient reg num|Recipient|Recipient type|Recipient subtype|Amount|Receipt date|Year|Contributor|Contrib Reg Num|Contrib type|Receipt type|In kind?|In-kind descr|Contrib zip|Contrib Employer name".split("|");
const ieHeaders = "Spender|Spender Reg Num|Spender type|Spender sub-type|Affected Comte Name|Affected Cmte Reg Num|For /Against|Year|Date|Type|Amount|Unpaid amount|In kind?|In kind descr|Purpose|Vendor name|Vendor city|Vendor State|Vendor zip".split("|");
function csv(key: MinnesotaCampaignFinanceDownloadKey, amount = "1.0000") {
  const headers = key === "independent_expenditures" ? ieHeaders : receiptHeaders;
  const values: Record<string, string> = { Amount: amount, Year: "2026", "Recipient reg num": "1001",
    Recipient: "Example candidate", "Recipient type": "PCC", "Receipt date": "2026-01-01",
    Contributor: "Example committee", "Contrib Reg Num": "2001", "Contrib type": "Political Committee/Fund",
    "Receipt type": "Contribution", "In kind?": "N", "Spender Reg Num": "2001", Spender: "Example committee",
    "Affected Cmte Reg Num": "1001", "For /Against": "For", Type: "Independent Expenditure", Date: "2026-01-01" };
  return `${headers.join(",")}\n${headers.map((header) => values[header] ?? "").join(",")}\n`;
}
const labels = ["All Contributions received by all entities - 2015 to present",
  "All Independent expenditures by all entities - 2015 to present",
  "Independent expenditure committees and funds Contributions received by independent expenditure committees and funds only - 2015 to present"];
const urls = keys.map((key) => `https://register.cfb.mn.gov/downloads/${key}.csv`);
const page = `<table>${keys.map((_, index) => `<tr><td><a href="${urls[index]}">${labels[index]} Download</a></td></tr>`).join("")}</table>`;
const bodyResponse = (body: string) => new Response(body, { headers: { "content-type": "text/csv", "content-length": String(Buffer.byteLength(body)) } });
function fetcher(options: { amount?: string; failKey?: MinnesotaCampaignFinanceDownloadKey; badLengthKey?: MinnesotaCampaignFinanceDownloadKey; badCsvKey?: MinnesotaCampaignFinanceDownloadKey; hangingKey?: MinnesotaCampaignFinanceDownloadKey; oversizedKey?: MinnesotaCampaignFinanceDownloadKey } = {}) {
  return vi.fn<typeof fetch>(async (url) => {
    if (String(url) === MINNESOTA_CAMPAIGN_FINANCE_DOWNLOAD_PAGE_URL) return new Response(page);
    const index = urls.indexOf(String(url));
    if (index < 0) throw new Error("Unexpected test route");
    const key = keys[index]!;
    if (key === options.failKey) throw new Error("Synthetic download failure");
    if (key === options.hangingKey) return new Response(new ReadableStream({ start() {} }));
    const result = bodyResponse(key === options.badCsvKey ? "wrong,header\n1,2\n" : csv(key, options.amount));
    if (key === options.badLengthKey) result.headers.set("content-length", "1");
    if (key === options.oversizedKey) result.headers.set("content-length", String(MINNESOTA_CAMPAIGN_FINANCE_MAX_DOWNLOAD_BYTES + 1));
    return result;
  });
}
async function cacheDir() { const dir = await mkdtemp(join(tmpdir(), "voteapp-mn-cache-")); dirs.push(dir); return dir; }
async function committed(dir: string, amount = "1.0000") {
  return refreshMinnesotaCampaignFinanceArtifactCache({ cacheDir: dir, fetchImpl: fetcher({ amount }), now: new Date("2026-06-25T12:00:00Z"), force: true });
}
async function preserved(before: Awaited<ReturnType<typeof committed>>) {
  expect(await readFile(before.metadataPath, "utf8")).toBe(`${JSON.stringify(before.current, null, 2)}\n`);
  for (const key of keys) {
    const entry = resolveMinnesotaCampaignFinanceCachedDownload({ cacheDir: before.cacheDir, metadata: before.current, key });
    const bytes = await readFile(entry.outputPath);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
    expect(bytes.length).toBe(entry.bytesWritten);
  }
}
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Minnesota campaign finance immutable cache", () => {
  it("keeps public discovery and legacy canonical paths", async () => {
    const dir = await cacheDir();
    const paths = getMinnesotaCampaignFinanceArtifactCachePaths(dir);
    expect(DEFAULT_MINNESOTA_CAMPAIGN_FINANCE_CACHE_DIR).toBe("scratch/minnesota-campaign-finance");
    expect(paths.downloads.contributions_received).toBe(join(dir, "all_contributions_received.csv"));
    expect(paths.metadataPath).toBe(join(dir, "minnesota_campaign_finance.metadata.json"));
    const fetchImpl = fetcher();
    expect(await discoverMinnesotaCampaignFinanceDownloadUrls({ fetchImpl })).toEqual(Object.fromEntries(keys.map((key, i) => [key, urls[i]])));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("publishes all validated files through one v2 metadata pointer", async () => {
    const result = await committed(await cacheDir());
    expect(result.current.version).toBe(2);
    expect(result.current.generation).toMatch(/^[a-f0-9-]{36}$/);
    expect(await readMinnesotaCampaignFinanceArtifactCacheMetadata(result.metadataPath)).toEqual(result.current);
    for (const key of keys) {
      const entry = resolveMinnesotaCampaignFinanceCachedDownload({ cacheDir: result.cacheDir, metadata: result.current, key });
      expect(entry.outputPath).toContain(`/generations/${result.current.generation}/`);
      expect(await readFile(entry.outputPath, "utf8")).toBe(csv(key));
      expect(Date.parse(entry.completedAt!)).toBeGreaterThanOrEqual(Date.parse(entry.startedAt!));
    }
    await preserved(result);
  });

  it.each(["independent_expenditures", "independent_expenditure_contributions"] as const)("preserves complete prior cache when %s fails", async (failKey) => {
    const before = await committed(await cacheDir());
    await expect(refreshMinnesotaCampaignFinanceArtifactCache({ cacheDir: before.cacheDir, fetchImpl: fetcher({ amount: "2.0000", failKey }) })).rejects.toThrow("Synthetic download failure");
    await preserved(before);
  });

  it.each(["badLengthKey", "badCsvKey", "oversizedKey"] as const)("preserves prior cache on %s", async (kind) => {
    const before = await committed(await cacheDir());
    await expect(refreshMinnesotaCampaignFinanceArtifactCache({ cacheDir: before.cacheDir, fetchImpl: fetcher({ amount: "2.0000", [kind]: "independent_expenditures" }) })).rejects.toThrow();
    await preserved(before);
  });

  it("preserves prior cache when response body exceeds timeout after headers", async () => {
    const before = await committed(await cacheDir());
    await expect(refreshMinnesotaCampaignFinanceArtifactCache({ cacheDir: before.cacheDir, fetchImpl: fetcher({ hangingKey: "independent_expenditures" }), timeoutMs: 25 })).rejects.toThrow();
    await preserved(before);
  });

  it("preserves prior pointer if atomic manifest replacement fails", async () => {
    const before = await committed(await cacheDir());
    const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (String(to) === before.metadataPath) throw new Error("Synthetic manifest failure");
      return real.rename(from, to);
    });
    try {
      await expect(refreshMinnesotaCampaignFinanceArtifactCache({ cacheDir: before.cacheDir, fetchImpl: fetcher({ amount: "2.0000" }) })).rejects.toThrow("Synthetic manifest failure");
      await preserved(before);
    } finally { vi.mocked(rename).mockImplementation(real.rename); }
  });

  it("retains a pinned prior generation across successful pointer replacement", async () => {
    const before = await committed(await cacheDir());
    const after = await committed(before.cacheDir, "2.0000");
    expect(after.current.generation).not.toBe(before.current.generation);
    for (const key of keys) {
      expect(await readFile(before.current.downloads[key].outputPath, "utf8")).toBe(csv(key));
      expect(await readFile(after.current.downloads[key].outputPath, "utf8")).toBe(csv(key, "2.0000"));
    }
  });

  it("keeps original observation for unchanged complete bytes", async () => {
    const before = await committed(await cacheDir());
    const after = await refreshMinnesotaCampaignFinanceArtifactCache({ cacheDir: before.cacheDir, fetchImpl: fetcher(), now: new Date("2026-06-26T12:00:00Z") });
    expect(after.status).toBe("unchanged");
    expect(after.current).toEqual(before.current);
    await preserved(before);
  });

  it("repairs corrupted committed bytes instead of reporting unchanged", async () => {
    const before = await committed(await cacheDir());
    await writeFile(before.current.downloads.independent_expenditures.outputPath, csv("independent_expenditures", "9.0000"));
    const after = await refreshMinnesotaCampaignFinanceArtifactCache({ cacheDir: before.cacheDir, fetchImpl: fetcher() });
    expect(after.status).toBe("downloaded");
    expect(after.current.generation).not.toBe(before.current.generation);
    expect(await readFile(after.current.downloads.independent_expenditures.outputPath, "utf8")).toBe(csv("independent_expenditures"));
  });

  it("resolves canonical v1 files and isolates invalid unrelated entries", async () => {
    const before = await committed(await cacheDir());
    const paths = getMinnesotaCampaignFinanceArtifactCachePaths(before.cacheDir);
    const legacy: MinnesotaCampaignFinanceArtifactCacheMetadata = structuredClone(before.current);
    legacy.version = 1; delete legacy.generation;
    for (const key of keys) { legacy.downloads[key].outputPath = paths.downloads[key]; await writeFile(paths.downloads[key], csv(key)); }
    // A malformed funder entry must not prevent envelope or IE qualification.
    (legacy.downloads as unknown as Record<string, unknown>).independent_expenditure_contributions = { broken: true };
    await writeFile(paths.metadataPath, JSON.stringify(legacy));
    const loaded = await readMinnesotaCampaignFinanceArtifactCacheMetadata(paths.metadataPath);
    expect(loaded).not.toBeNull();
    expect(resolveMinnesotaCampaignFinanceCachedDownload({ cacheDir: before.cacheDir, metadata: loaded, key: "independent_expenditures" }).outputPath).toBe(paths.downloads.independent_expenditures);
    expect(() => resolveMinnesotaCampaignFinanceCachedDownload({ cacheDir: before.cacheDir, metadata: loaded, key: "independent_expenditure_contributions" })).toThrow("Invalid Minnesota campaign finance cached component");
  });

  it.each(["path", "hash", "bytes", "key", "url"])("rejects invalid requested metadata %s", async (kind) => {
    const before = await committed(await cacheDir());
    const bad = structuredClone(before.current);
    const entry = bad.downloads.independent_expenditures;
    if (kind === "path") entry.outputPath = join(before.cacheDir, "outside.csv");
    if (kind === "hash") entry.sha256 = "invalid";
    if (kind === "bytes") entry.bytesWritten = -1;
    if (kind === "key") entry.remote.key = "contributions_received";
    if (kind === "url") entry.remote.url = "https://example.com/csv";
    expect(() => resolveMinnesotaCampaignFinanceCachedDownload({ cacheDir: before.cacheDir, metadata: bad, key: "independent_expenditures" })).toThrow("Invalid Minnesota campaign finance cached component");
  });
});
