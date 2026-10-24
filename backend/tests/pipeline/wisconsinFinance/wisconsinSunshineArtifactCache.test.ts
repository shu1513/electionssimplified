import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WisconsinPublicSourceReader, wisconsinOriginalPath, wisconsinPublicTrpcUrl } from "../../../src/pipeline/wisconsinFinance/wisconsinSunshineArtifactCache.js";

const paths: string[] = [];
async function cache() { const dir = await mkdtemp(join(tmpdir(), "wi-source-test-")); paths.push(dir); return dir; }
afterEach(async () => { await Promise.all(paths.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); vi.restoreAllMocks(); });
const procedure = "publicFrontendApi.getTransactions", countProcedure = "publicFrontendApi.getTransactionsTotalCount";
const date = "2026-10-01T00:00:00.000Z";
const response = (data: unknown) => new Response(JSON.stringify([{ result: { data: { json: data } } }]), { headers: { "content-type": "application/json" } });
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, date, amount: 100 + i }));
function nativeApi(data = rows(147), change?: (page: number, result: { results: typeof data; nextCursor: unknown }) => unknown) {
  let page = 0;
  return vi.fn(async (url: string | URL | Request) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith(countProcedure)) return response(data.length);
    expect(u.pathname.endsWith(procedure)).toBe(true);
    const envelope = JSON.parse(u.searchParams.get("input")!)["0"], input = envelope.json;
    expect(input.skip).toBeUndefined();
    if (input.cursor) expect(envelope.meta.values["cursor.date"]).toEqual(["Date"]);
    const start = input.cursor ? data.findIndex(r => r.id === input.cursor.id) + 1 : 0;
    const selected = data.slice(start, start + input.take), last = selected.at(-1);
    const result = { results: selected, nextCursor: last ? { id: last.id, date: last.date } : null };
    return response(change ? change(page++, result) : result);
  }) as unknown as typeof fetch;
}
const filter = { createdByEntityId: [77], dateFrom: "2025-01-01", dateTo: "2026-12-31" };
const load = (reader: WisconsinPublicSourceReader) => reader.closedRows(procedure, countProcedure, filter, "ledger", "date");

describe("Wisconsin native public-source acquisition", () => {
  it("serializes the native date cursor as a SuperJSON Date and rejects private procedures", () => {
    const u = new URL(wisconsinPublicTrpcUrl(procedure, { cursor: { id: 5, date } }));
    expect(JSON.parse(u.searchParams.get("input")!)).toEqual({ "0": { json: { cursor: { id: 5, date } }, meta: { values: { "cursor.date": ["Date"] }, v: 1 } } });
    expect(() => wisconsinPublicTrpcUrl("committee.getCommitteeFromEntityId", { entityId: 5 })).toThrow("nonpublic_procedure");
    for (const invalid of ["invalid", "2026-02-30T00:00:00.000Z", "2026-99-01T00:00:00.000Z"]) {
      expect(() => wisconsinPublicTrpcUrl(procedure, { cursor: { id: 5, date: invalid } })).toThrow("cursor_date");
    }
  });
  it("closes all 147 rows with counts, typed cursors and two empty terminals; replays saved-first offline", async () => {
    const cacheDir = await cache(), fetchImpl = nativeApi(), reader = new WisconsinPublicSourceReader({ cacheDir, allowNetwork: true, fetchImpl });
    expect(await load(reader)).toEqual(rows(147));
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(8);
    expect(vi.mocked(fetchImpl).mock.calls.every(c => c[1]?.credentials === "omit" && c[1]?.redirect === "error")).toBe(true);
    const offline = vi.fn(() => { throw new Error("unexpected network"); }) as unknown as typeof fetch;
    expect(await load(new WisconsinPublicSourceReader({ cacheDir, fetchImpl: offline }))).toEqual(rows(147));
    expect(offline).not.toHaveBeenCalled();
    expect(Number.isFinite(Date.parse(reader.observedAt()))).toBe(true);
  });
  it("does not mistake a short page for a terminal", async () => {
    const fetchImpl = nativeApi(rows(3));
    expect(await load(new WisconsinPublicSourceReader({ cacheDir: await cache(), allowNetwork: true, fetchImpl }))).toHaveLength(3);
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(6);
  });
  it("rejects a server that ignores its cursor instead of adding the first page twice", async () => {
    const data = rows(147), fetchImpl = nativeApi(data, () => ({ results: data.slice(0, 100), nextCursor: { id: 100, date } }));
    await expect(load(new WisconsinPublicSourceReader({ cacheDir: await cache(), allowNetwork: true, fetchImpl }))).rejects.toThrow("duplicate_or_invalid_row_id");
  });
  it("rejects omitted rows even when the server returns an empty terminal", async () => {
    const fetchImpl = nativeApi(rows(147), (_, page) => ({ ...page, results: page.results.filter(r => r.id !== 12) }));
    await expect(load(new WisconsinPublicSourceReader({ cacheDir: await cache(), allowNetwork: true, fetchImpl }))).rejects.toThrow("count_mismatch");
  });
  it("rejects an amount edit between complete scans", async () => {
    const fetchImpl = nativeApi(rows(3), (page, result) => page === 2 ? { ...result, results: result.results.map(r => ({ ...r, amount: r.amount + 1 })) } : result);
    await expect(load(new WisconsinPublicSourceReader({ cacheDir: await cache(), allowNetwork: true, fetchImpl }))).rejects.toThrow("source_changed");
  });
  it("rejects a cursor that is not the last returned native row", async () => {
    const fetchImpl = nativeApi(rows(3), (_, result) => ({ ...result, nextCursor: { id: 999, date } }));
    await expect(load(new WisconsinPublicSourceReader({ cacheDir: await cache(), allowNetwork: true, fetchImpl }))).rejects.toThrow("native_cursor");
  });
  it("holds a page bound instead of admitting its prefix", async () => {
    await expect(load(new WisconsinPublicSourceReader({ cacheDir: await cache(), allowNetwork: true, fetchImpl: nativeApi(), maxPages: 1 }))).rejects.toThrow("page_overflow");
  });
  it("requires an explicit empty page and two count observations for zero rows", async () => {
    const fetchImpl = nativeApi([]);
    expect(await load(new WisconsinPublicSourceReader({ cacheDir: await cache(), allowNetwork: true, fetchImpl }))).toEqual([]);
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(4);
  });
  it("neither a miss nor refresh grants network access", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch, cacheDir = await cache();
    await expect(load(new WisconsinPublicSourceReader({ cacheDir, fetchImpl }))).rejects.toThrow("saved_original_missing");
    await expect(load(new WisconsinPublicSourceReader({ cacheDir, fetchImpl, refresh: true }))).rejects.toThrow("network_refresh_not_allowed");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("holds a failed refresh and leaves the prior saved body usable", async () => {
    const cacheDir = await cache(), url = wisconsinPublicTrpcUrl(countProcedure, filter);
    const reader = new WisconsinPublicSourceReader({ cacheDir, allowNetwork: true, fetchImpl: nativeApi() });
    expect(await reader.trpc(countProcedure, filter, "count")).toBe(147);
    const before = await readFile(wisconsinOriginalPath(cacheDir, "count", url), "utf8");
    const failed = vi.fn(async () => new Response("Unavailable", { status: 503 })) as unknown as typeof fetch;
    await expect(new WisconsinPublicSourceReader({ cacheDir, allowNetwork: true, refresh: true, fetchImpl: failed }).trpc(countProcedure, filter, "count")).rejects.toThrow("source_status");
    expect(await readFile(wisconsinOriginalPath(cacheDir, "count", url), "utf8")).toBe(before);
    expect(await new WisconsinPublicSourceReader({ cacheDir }).trpc(countProcedure, filter, "count")).toBe(147);
  });
  it("rejects edited body hashes and future cache clocks", async () => {
    const cacheDir = await cache(), url = wisconsinPublicTrpcUrl(countProcedure, filter), path = wisconsinOriginalPath(cacheDir, "count", url);
    await new WisconsinPublicSourceReader({ cacheDir, allowNetwork: true, fetchImpl: nativeApi() }).trpc(countProcedure, filter, "count");
    const original = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...original, body: "[]" }));
    await expect(new WisconsinPublicSourceReader({ cacheDir }).trpc(countProcedure, filter, "count")).rejects.toThrow("original_integrity");
    await writeFile(path, JSON.stringify({ ...original, observedAt: new Date(Date.now() + 86_400_000).toISOString() }));
    await expect(new WisconsinPublicSourceReader({ cacheDir }).trpc(countProcedure, filter, "count")).rejects.toThrow("original_clock");
  });
  it("rejects a saved original readable by other users", async () => {
    const cacheDir = await cache(), url = wisconsinPublicTrpcUrl(countProcedure, filter), path = wisconsinOriginalPath(cacheDir, "count", url);
    await new WisconsinPublicSourceReader({ cacheDir, allowNetwork: true, fetchImpl: nativeApi() }).trpc(countProcedure, filter, "count");
    await chmod(path, 0o644);
    await expect(new WisconsinPublicSourceReader({ cacheDir }).trpc(countProcedure, filter, "count")).rejects.toThrow("original_permissions");
  });
  it("rejects incomplete response streams without admitting an original", async () => {
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("[{")); controller.error(new Error("partial")); } }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await expect(load(new WisconsinPublicSourceReader({ cacheDir: await cache(), allowNetwork: true, fetchImpl }))).rejects.toThrow("source_read_failed");
  });
  it("scrubs malformed JSON rather than echoing source text", async () => {
    const fetchImpl = vi.fn(async () => new Response("untrusted source text")) as unknown as typeof fetch;
    await expect(load(new WisconsinPublicSourceReader({ cacheDir: await cache(), allowNetwork: true, fetchImpl }))).rejects.toThrow(/^Wisconsin reported finance held: source_json$/);
  });
  it("restricts source hosts, profile paths and phases before reading or fetching", () => {
    expect(() => wisconsinOriginalPath("/tmp", "profile", "https://example.com/browse-data/registrant/7")).toThrow("source_origin");
    expect(() => wisconsinOriginalPath("/tmp", "../profile", "https://campaignfinance.wi.gov/browse-data/registrant/7")).toThrow("cache_phase");
    expect(() => wisconsinOriginalPath("/tmp", "profile", "https://campaignfinance.wi.gov/auth/sign-in")).toThrow("source_path");
  });
});
