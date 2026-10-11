import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFloridaFinanceRawSourceClient } from "../../../src/pipeline/floridaFinance/floridaFinanceRawSourceClient.js";

const get = { url: "https://dos.elections.myflorida.com/candidates/CanDetail.asp?account=88807", method: "GET" as const, financeFields: null };
const directories: string[] = [];
async function directory() { const path = await mkdtemp(join(tmpdir(), "florida-raw-")); directories.push(path); return path; }
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const response = (text = "public report", status = 200) => new Response(text, { status, headers: { "content-type": "text/html; charset=utf-8" } });

describe("Florida bounded immutable raw-source cache", () => {
  it("retains exact bytes, hashes and actual request intervals", async () => {
    const raw = new Uint8Array([0x61, 0xa0, 0x62]);
    const fetchFn = vi.fn(async () => new Response(raw));
    const client = createFloridaFinanceRawSourceClient({ cacheDir: await directory(), fetchFn, minIntervalMs: 0 });
    const evidence = await client.request(get);
    expect([...evidence.bytesRaw]).toEqual([...raw]);
    expect(evidence.sha256).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(Date.parse(evidence.startedAt)).toBeLessThanOrEqual(Date.parse(evidence.completedAt));
    expect(await readFile(join(client.generationDirectory, "0001.raw"))).toEqual(Buffer.from(raw));
  });

  it("saved openings keep original times and closing calls remain fresh", async () => {
    const cacheDir = await directory();
    const fetchFn = vi.fn(async () => response());
    const first = createFloridaFinanceRawSourceClient({ cacheDir, fetchFn, minIntervalMs: 0 });
    const original = await first.request(get);
    const second = createFloridaFinanceRawSourceClient({ cacheDir, fetchFn, minIntervalMs: 0 });
    expect(await second.request(get, { savedFirst: true })).toEqual(original);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await second.request(get);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const journal = JSON.parse(await readFile(join(second.generationDirectory, "requests.json"), "utf8"));
    expect(journal.map((row: { kind: string }) => row.kind)).toEqual(["saved_opening", "fresh"]);
    expect(journal[0].originalCompletedAt).toBe(original.completedAt);
  });

  it("refresh bypasses saved openings", async () => {
    const cacheDir = await directory();
    const fetchFn = vi.fn(async () => response());
    await createFloridaFinanceRawSourceClient({ cacheDir, fetchFn, minIntervalMs: 0 }).request(get);
    await createFloridaFinanceRawSourceClient({ cacheDir, fetchFn, minIntervalMs: 0, refresh: true }).request(get, { savedFirst: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("a failed HTTP response cannot replace a successful saved page", async () => {
    const cacheDir = await directory();
    const fetchFn = vi.fn(async () => response());
    const first = createFloridaFinanceRawSourceClient({ cacheDir, fetchFn, minIntervalMs: 0 });
    const accepted = await first.request(get);
    fetchFn.mockImplementationOnce(async () => response("blocked", 403));
    expect((await first.request(get)).status).toBe(403);
    expect(await first.request(get, { savedFirst: true })).toEqual(accepted);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("tampered saved bytes cause a genuine acquisition, not stale acceptance", async () => {
    const cacheDir = await directory();
    const fetchFn = vi.fn(async () => response());
    const first = createFloridaFinanceRawSourceClient({ cacheDir, fetchFn, minIntervalMs: 0 });
    await first.request(get);
    await writeFile(join(first.generationDirectory, "0001.raw"), "tampered");
    const second = createFloridaFinanceRawSourceClient({ cacheDir, fetchFn, minIntervalMs: 0 });
    expect(new TextDecoder().decode((await second.request(get, { savedFirst: true })).bytesRaw)).toBe("public report");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("captures finance request fields before caller mutation", async () => {
    const fields = { account: "88807", election: "All" };
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response());
    const client = createFloridaFinanceRawSourceClient({ cacheDir: await directory(), fetchFn, minIntervalMs: 0 });
    const pending = client.request({ url: "https://dos.elections.myflorida.com/cgi-bin/TreSel.exe", method: "POST", financeFields: fields });
    fields.account = "88773";
    expect((await pending).financeFields?.account).toBe("88807");
    expect(fetchFn.mock.calls[0][1]?.body).toBe("account=88807&election=All");
  });

  it("serializes concurrent callers and enforces its request budget", async () => {
    const fetchFn = vi.fn(async () => response());
    const client = createFloridaFinanceRawSourceClient({ cacheDir: await directory(), fetchFn, minIntervalMs: 0, maxRequests: 1 });
    const outcomes = await Promise.allSettled([client.request(get), client.request(get)]);
    expect(outcomes.map((item) => item.status)).toEqual(["fulfilled", "rejected"]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(client.capturedRequestCount).toBe(1);
  });

  it("cancels oversized bodies and keeps only failure metadata", async () => {
    const cacheDir = await directory();
    const client = createFloridaFinanceRawSourceClient({ cacheDir, fetchFn: async () => response("12345"), maxResponseBytes: 4, minIntervalMs: 0 });
    await expect(client.request(get)).rejects.toThrow("byte cap");
    expect((await readdir(client.generationDirectory)).some((file) => file.endsWith(".raw"))).toBe(false);
    const [failure] = JSON.parse(await readFile(join(client.generationDirectory, "requests.json"), "utf8"));
    expect(failure).toMatchObject({ kind: "failed", status: 200 });
  });

  it.each([
    { ...get, url: "https://example.com/candidates/CanDetail.asp?account=88807" },
    { ...get, url: "https://user:pass@dos.elections.myflorida.com/candidates/CanDetail.asp?account=88807" },
    { ...get, url: "https://dos.elections.myflorida.com/private.aspx" },
    { url: "https://dos.elections.myflorida.com/cgi-bin/TreSel.exe", method: "POST" as const, financeFields: { token: "private" } },
  ])("rejects nonpublic or credential-bearing requests before transport", async (request) => {
    const fetchFn = vi.fn(async () => response());
    const client = createFloridaFinanceRawSourceClient({ cacheDir: await directory(), fetchFn, minIntervalMs: 0 });
    await expect(client.request(request)).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
