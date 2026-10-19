import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireNorthDakotaReportedPacket, isNorthDakotaReportedPacket, loadNorthDakotaReportedPacket, ND_REPORTED_RAW_RETENTION_MS, readNorthDakotaReportedPacket } from "../../../src/pipeline/northDakotaFinance/northDakotaReportedSource.js";

import { aggregateNorthDakotaReportedCommittees } from "../../../src/pipeline/northDakotaFinance/northDakotaReportedAggregation.js";
import { northDakotaReportedIeFixture as source, northDakotaReportedCommitteeFixture } from "./northDakotaReportedFixture.js";
let cacheDir: string;
beforeEach(async () => {
  vi.stubEnv("AI_API_CALLS_ALLOWED", "false"); vi.stubEnv("NORTH_DAKOTA_CAMPAIGN_FINANCE_ENABLED", "true"); vi.stubEnv("NORTH_DAKOTA_CFRS_RAW_DATA_REFRESH_ENABLED", "true");
  cacheDir = await mkdtemp(resolve(tmpdir(), "nd-reported-test-"));
});
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(cacheDir, { recursive: true, force: true }); });
const directory = async () => resolve(cacheDir, "reported-components", (await readdir(resolve(cacheDir, "reported-components"))).find(n => n.startsWith("ie-") && !n.endsWith(".pointer"))!);

describe("North Dakota independent native source graph", () => {
  it("closes both contribution years and binds downloaded originals to native catalog/mint responses", async () => {
    const packet = await acquireNorthDakotaReportedPacket("committee", { cacheDir, clientOptions: northDakotaReportedCommitteeFixture() });
    expect(packet).toMatchObject({ kind: "committee", sourceRows: 1, sourceCents: 10000, windowStart: "2025-01-01", windowEnd: "2026-12-31" });
    const name = await readFile(resolve(cacheDir, "reported-components", "committee.latest"), "utf8");
    const manifest = await readFile(resolve(cacheDir, "reported-components", name, "manifest.json"), "utf8");
    expect(manifest).not.toContain("temporary=secret");
    expect(packet.contributions[0]!.contributorName).toBe("Example PAC");
  });
  it("covers every catalog year so all-years charts still close once next-year money appears", async () => {
    const packet = await acquireNorthDakotaReportedPacket("committee", { cacheDir, clientOptions: northDakotaReportedCommitteeFixture({ nextYear: true }) });
    expect(packet).toMatchObject({ sourceRows: 2, sourceCents: 15000, windowEnd: "2026-12-31" });
    const name = await readFile(resolve(cacheDir, "reported-components", "committee.latest"), "utf8");
    expect(JSON.parse(await readFile(resolve(cacheDir, "reported-components", name, "manifest.json"), "utf8")).years).toEqual([2025, 2026, 2027]);
    // Published receipts stay inside the candidacy window.
    expect(aggregateNorthDakotaReportedCommittees({ entityId: "1010000002", windowStart: packet.windowStart, windowEnd: packet.windowEnd, rows: packet.contributions })).toMatchObject({ cents: 10000, occurrences: 1 });
  });
  it("rejects named contribution drift and incomplete download EOF", async () => {
    await expect(acquireNorthDakotaReportedPacket("committee", { cacheDir, clientOptions: northDakotaReportedCommitteeFixture({ badDonor: true }) })).rejects.toThrow(/named_committee_multiset/);
    await expect(acquireNorthDakotaReportedPacket("committee", { cacheDir, clientOptions: northDakotaReportedCommitteeFixture({ truncatedFile: true }) })).rejects.toThrow(/invalid artifact/);
  });
  it("captures complete original bodies, closes native counts/charts and requires no direct files", async () => {
    const s = source(), packet = await acquireNorthDakotaReportedPacket("ie", { cacheDir, clientOptions: { fetchImpl: s.fetchImpl } });
    expect(packet).toMatchObject({ kind: "ie", sourceRows: 1, sourceCents: 10000, excludedIeRows: 0 });
    expect(isNorthDakotaReportedPacket(packet)).toBe(true); expect(isNorthDakotaReportedPacket({ ...packet })).toBe(false);
    expect(Object.isFrozen(packet.ie[0])).toBe(true); expect(s.calls).toHaveLength(7);
    const raw = await readFile(resolve(await directory(), "0003.original"), "utf8");
    expect(raw.startsWith(" ")).toBe(true); expect(raw.endsWith("\n")).toBe(true); expect(raw).toContain("untouchedNativeField");
  });
  it("replays genuine cached originals without changing their clock or reaching HTTP", async () => {
    const s = source(), packet = await acquireNorthDakotaReportedPacket("ie", { cacheDir, clientOptions: { fetchImpl: s.fetchImpl } });
    vi.stubEnv("NORTH_DAKOTA_CFRS_RAW_DATA_REFRESH_ENABLED", "false");
    const replay = await loadNorthDakotaReportedPacket("ie", { cacheDir });
    expect(replay.sourceAt).toBe(packet.sourceAt); expect(replay.sourceHash).toBe(packet.sourceHash); expect(replay.ie).toEqual(packet.ie);
  });
  it("holds a native field changed between complete opening and closing responses", async () => {
    const s = source({ changeClosing: true });
    await expect(acquireNorthDakotaReportedPacket("ie", { cacheDir, clientOptions: { fetchImpl: s.fetchImpl } })).rejects.toThrow(/transactions_changed/);
    expect(await readFile(resolve(await directory(), "0005.original"), "utf8")).toContain('"untouchedNativeField":"changed"');
  });
  it("holds official chart and duplicate transaction failures", async () => {
    await expect(acquireNorthDakotaReportedPacket("ie", { cacheDir, clientOptions: { fetchImpl: source({ chartCents: 9999 }).fetchImpl } })).rejects.toThrow(/chart_closure/);
    await expect(acquireNorthDakotaReportedPacket("ie", { cacheDir, clientOptions: { fetchImpl: source({ duplicate: true }).fetchImpl } })).rejects.toThrow(/transaction_identity/);
  });
  it("archives native incomplete paging before rejecting it", async () => {
    const s = source({ nativeCount: 0 });
    await expect(acquireNorthDakotaReportedPacket("ie", { cacheDir, clientOptions: { fetchImpl: s.fetchImpl } })).rejects.toThrow(/pagination/);
    expect(await readFile(resolve(await directory(), "0003.original"), "utf8")).toContain('"totalRecords":0');
  });
  it("does not replace last good pointer when a subsequent source fails", async () => {
    await acquireNorthDakotaReportedPacket("ie", { cacheDir, clientOptions: { fetchImpl: source().fetchImpl } });
    const pointer = resolve(cacheDir, "reported-components", "ie.latest"), before = await readFile(pointer, "utf8");
    await expect(acquireNorthDakotaReportedPacket("ie", { cacheDir, clientOptions: { fetchImpl: source({ changeClosing: true }).fetchImpl } })).rejects.toThrow();
    expect(await readFile(pointer, "utf8")).toBe(before);
  });
  it("replays the last qualified packet when a routine refresh fails, but not an explicit one", async () => {
    const packet = await acquireNorthDakotaReportedPacket("ie", { cacheDir, clientOptions: { fetchImpl: source().fetchImpl } });
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(packet.sourceAt) + 2 * 86400000);
    const failing = { fetchImpl: async () => { throw Error("portal down"); } }, onRefreshError = vi.fn();
    const replay = await loadNorthDakotaReportedPacket("ie", { cacheDir, clientOptions: failing, onRefreshError });
    expect(replay.sourceAt).toBe(packet.sourceAt); expect(onRefreshError).toHaveBeenCalledTimes(1);
    await expect(loadNorthDakotaReportedPacket("ie", { cacheDir, clientOptions: failing, refresh: true })).rejects.toThrow();
    await rm(resolve(cacheDir, "reported-components"), { recursive: true, force: true });
    await expect(loadNorthDakotaReportedPacket("ie", { cacheDir, clientOptions: failing })).rejects.toThrow();
  });
  it("prunes raw originals outside the retention window but keeps hash metadata and the latest packet", async () => {
    await expect(acquireNorthDakotaReportedPacket("ie", { cacheDir, clientOptions: { fetchImpl: source({ chartCents: 9999 }).fetchImpl } })).rejects.toThrow();
    const failed = await directory(), old = new Date(Date.now() - ND_REPORTED_RAW_RETENTION_MS - 60000);
    await acquireNorthDakotaReportedPacket("ie", { cacheDir, clientOptions: { fetchImpl: source().fetchImpl } });
    const latest = resolve(cacheDir, "reported-components", await readFile(resolve(cacheDir, "reported-components", "ie.latest"), "utf8"));
    await utimes(failed, old, old); await utimes(latest, old, old);
    await acquireNorthDakotaReportedPacket("ie", { cacheDir, clientOptions: { fetchImpl: source().fetchImpl } });
    expect((await readdir(failed)).sort()).toEqual(["captures.ndjson", "manifest.json"]);
    expect((await readdir(latest)).filter(n => n.endsWith(".original"))).toHaveLength(7);
  });
  it("rejects tampering, permissive originals and escaped paths", async () => {
    await acquireNorthDakotaReportedPacket("ie", { cacheDir, clientOptions: { fetchImpl: source().fetchImpl } });
    const dir = await directory(); await writeFile(resolve(dir, "0001.original"), "changed", { mode: 0o600 });
    await expect(readNorthDakotaReportedPacket(dir)).rejects.toThrow(/original_integrity/);
    const manifest = JSON.parse(await readFile(resolve(dir, "manifest.json"), "utf8")); manifest.captures[0].file = "../outside";
    await writeFile(resolve(dir, "manifest.json"), JSON.stringify(manifest));
    await expect(readNorthDakotaReportedPacket(dir)).rejects.toThrow(/capture_metadata/);
  });
  it("checks raw acquisition gate before any HTTP or filesystem write", async () => {
    vi.stubEnv("NORTH_DAKOTA_CFRS_RAW_DATA_REFRESH_ENABLED", "false"); const s = source();
    await expect(acquireNorthDakotaReportedPacket("ie", { cacheDir, clientOptions: { fetchImpl: s.fetchImpl } })).rejects.toThrow(/raw_refresh_disabled/);
    expect(s.fetchImpl).not.toHaveBeenCalled(); expect(await readdir(cacheDir)).toEqual([]);
  });
});
