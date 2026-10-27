import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireRhodeIslandCf8Filer, readRhodeIslandCf8FilerCache } from "../../../src/pipeline/rhodeIslandFinance/rhodeIslandCf8FilerCache.js";
import { getErtsArtifactPaths, getErtsArtifactStatus, readErtsTextArtifact, storeErtsArtifact } from "../../../src/pipeline/rhodeIslandFinance/rhodeIslandErtsArtifactCache.js";
import { parseRefreshRhodeIslandCf8FilerArgs } from "../../../src/scripts/refreshRhodeIslandCf8Filer.js";

import { GUID, NAME, pdf, url, portal } from "../../helpers/rhodeIslandCf8Fixtures.js";

let cacheDir: string;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
  cacheDir = await mkdtemp(join(tmpdir(), "ri-cf8-filer-"));
});
afterEach(() => vi.useRealTimers());
const input = () => ({ cacheDir, electionYear: 2026, spenderName: NAME });

describe("ordinary independent CF8 filer acquisition and cache", () => {
  it("fetches both complete indexes and all source classes without a receiving organization", async () => {
    const p = portal();
    await expect(acquireRhodeIslandCf8Filer({ ...input(), transport: p.transport }))
      .resolves.toEqual({ indexPages: 2, indexRows: 3, wholeScans: 2, wholePages: 2 });
    const actual = await readRhodeIslandCf8FilerCache(input());
    expect(actual.family.map(r => r.filingType)).toEqual(["INDEPENDENT EXPENDITURE", "COVERED TRANSFER"]);
    expect(actual.scans).toHaveLength(2);
    expect(actual.observedAt).toBe(actual.scans.map(s => s.observedAt).sort()[0]);
    expect(actual.completedAt >= actual.indexObservedAt).toBe(true);
    expect(p.calls.filter(u => u.includes("Homepage.aspx"))).toHaveLength(4);
    expect(p.calls.every(u => u.includes("Homepage.aspx") || u.includes("/ReportsScanned/"))).toBe(true);
    expect(actual).not.toHaveProperty("supportCents"); // Source retrieval is not financial admission.
  });
  it("preserves an entire accepted generation when a scan is unavailable", async () => {
    await acquireRhodeIslandCf8Filer({ ...input(), transport: portal().transport });
    const before = await readRhodeIslandCf8FilerCache(input());
    await expect(acquireRhodeIslandCf8Filer({ ...input(), transport: portal({ failScan: true }).transport })).rejects.toThrow();
    const after = await readRhodeIslandCf8FilerCache(input());
    expect(after.sourceDigest).toBe(before.sourceDigest); expect(after.observedAt).toBe(before.observedAt);
  });
  it("preserves the prior generation when a filing changes during acquisition", async () => {
    await acquireRhodeIslandCf8Filer({ ...input(), transport: portal().transport });
    const before = await readRhodeIslandCf8FilerCache(input());
    await expect(acquireRhodeIslandCf8Filer({ ...input(), transport: portal({ closingChanged: true }).transport }))
      .rejects.toThrow("current_index_changed");
    expect((await readRhodeIslandCf8FilerCache(input())).sourceDigest).toBe(before.sourceDigest);
  });
  it("holds an incomplete family and a redirected different filing", async () => {
    await expect(acquireRhodeIslandCf8Filer({ ...input(), transport: portal({ missingScan: true }).transport }))
      .rejects.toThrow("missing_family_scan");
    await expect(acquireRhodeIslandCf8Filer({ ...input(), transport: portal({ redirectWrong: true }).transport }))
      .rejects.toThrow("scan_redirect_identity");
  });
  it("never interprets an absent filer or missing cache as zero", async () => {
    await expect(acquireRhodeIslandCf8Filer({ ...input(), spenderName: "Missing Filer", transport: portal().transport }))
      .rejects.toThrow("nonempty_complete_family");
    await expect(readRhodeIslandCf8FilerCache(input())).rejects.toThrow();
  });
  it("preserves an earlier cycle when the same filer is refreshed for a different cycle", async () => {
    await acquireRhodeIslandCf8Filer({ ...input(), transport: portal().transport });
    const before = await readRhodeIslandCf8FilerCache(input());
    vi.setSystemTime(new Date("2028-10-26T12:00:00Z"));
    const old = portal().transport;
    const transport = { fetch: async (u: string, body?: URLSearchParams) => {
      const result = await old.fetch(u, body);
      if (!u.includes("Homepage.aspx")) return result;
      return { ...result, body: new TextEncoder().encode(new TextDecoder().decode(result.body).replaceAll("2026", "2028")) };
    } };
    await acquireRhodeIslandCf8Filer({ ...input(), electionYear: 2028, transport });
    expect((await readRhodeIslandCf8FilerCache({ ...input(), electionYear: 2028 })).electionYear).toBe(2028);
    const after = await readRhodeIslandCf8FilerCache(input());
    expect(after.sourceDigest).toBe(before.sourceDigest); expect(after.observedAt).toBe(before.observedAt);
  });
  it("rejects impossible civil dates and future filer records instead of normalizing or skipping them", async () => {
    await expect(acquireRhodeIslandCf8Filer({ ...input(), transport: portal({ nativeDate: "Feb 30 2026" }).transport }))
      .rejects.toThrow("invalid_native_civil_date");
    await expect(acquireRhodeIslandCf8Filer({ ...input(), transport: portal({ nativeDate: "Nov 3 2026" }).transport }))
      .rejects.toThrow("future_family_filing_date");
  });
  it("revalidates original scan bytes and does not trust a ready filename", async () => {
    await acquireRhodeIslandCf8Filer({ ...input(), transport: portal().transport });
    const { createHash } = await import("node:crypto");
    const base = join(cacheDir, "cf8-filers", createHash("sha256").update(NAME.toUpperCase()).digest("hex"));
    const ptr = JSON.parse(await readFile(join(base, "current-2026.json"), "utf8"));
    const scan = join(base, "generations", ptr.generation, "cf8-scans", `${GUID}.pdf`);
    const original = await readFile(scan); original[10] = original[10]! ^ 1; await writeFile(scan, original);
    await expect(readRhodeIslandCf8FilerCache(input())).rejects.toThrow("scan_original_or_identity");
  });
});

describe("scanned PDF artifact namespace", () => {
  it("accepts a structurally complete image-only document without weakening CF2", async () => {
    const key = { type: "cf8_scan" as const, guid: GUID };
    expect(getErtsArtifactPaths({ cacheDir, key }).filePath).toContain(`/cf8-scans/${GUID}.pdf`);
    await storeErtsArtifact({ cacheDir, key, url: url(), body: pdf });
    expect((await getErtsArtifactStatus({ cacheDir, key })).manifest?.rowCount).toBe(1);
    await expect(readErtsTextArtifact({ cacheDir, key })).rejects.toThrow("binary");
    await expect(storeErtsArtifact({ cacheDir, key: { type: "filing_pdf", filingId: "1", guid: GUID }, url: url(), body: pdf }))
      .rejects.toThrow("no text layer");
  });
  it("rejects missing EOF and malformed PDF bodies without replacing good bytes", async () => {
    const key = { type: "cf8_scan" as const, guid: GUID };
    await storeErtsArtifact({ cacheDir, key, url: url(), body: pdf });
    const before = (await getErtsArtifactStatus({ cacheDir, key })).manifest!.sha256;
    await expect(storeErtsArtifact({ cacheDir, key, url: url(), body: pdf.slice(0, -10) })).rejects.toThrow("incomplete");
    await expect(storeErtsArtifact({ cacheDir, key, url: url(), body: "%PDF-fake\n%%EOF" })).rejects.toThrow();
    expect((await getErtsArtifactStatus({ cacheDir, key })).manifest!.sha256).toBe(before);
  });
});

describe("scoped CF8 refresh arguments", () => {
  it("requires an explicit even year and one exact native filer", () => {
    expect(parseRefreshRhodeIslandCf8FilerArgs(["--cycle-year=2026", "--filer", NAME, "--cache-dir=/private/cache"]))
      .toEqual({ electionYear: 2026, spenderName: NAME, cacheDir: "/private/cache" });
    for (const args of [["--filer", NAME], ["--cycle-year=2025", "--filer", NAME],
      ["--cycle-year=2026", "--filer", NAME, "--force"], ["--cycle-year=2026", "--filer", NAME, "--filer", NAME]])
      expect(() => parseRefreshRhodeIslandCf8FilerArgs(args)).toThrow();
  });
});
