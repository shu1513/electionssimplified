import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNorthCarolinaReportedReceiptDiscoveryTransport } from "../../../src/pipeline/northCarolinaFinance/northCarolinaReportedReceiptDiscoveryTransport.js";
import { discoverNcsbeAcquisitionCommittees } from "../../../src/pipeline/northCarolinaFinance/northCarolinaNcsbeAcquisitionDiscovery.js";
import { ncsbeCommitteeSearchUrl } from "../../../src/pipeline/northCarolinaFinance/northCarolinaNcsbeClient.js";
import { NORTH_CAROLINA_REPORTED_RECEIPT_LIMITS as LIMITS } from "../../../src/pipeline/northCarolinaFinance/northCarolinaReportedReceiptSourceCache.js";

// Synthetic HTTP responses and a fake test clock never establish source money.
// The production factory exposes no fetch/sleep/clock/qualification overrides.
const NOW = new Date("2028-10-21T12:00:00.000Z");
const EMPTY = "<script>var data = [];</script>";
const roots: string[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(async () => {
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "nc-discovery-transport-")); roots.push(root); return root;
}
async function journal(root: string) {
  return JSON.parse(await readFile(join(root, "recorded-source", "capture-journal.json"), "utf8"));
}
const raw = (root: string, ordinal = 1) => readFile(join(root, "recorded-source", "originals", `${String(ordinal).padStart(4, "0")}.raw`));

describe("North Carolina bounded discovery transport", () => {
  it("uses exact native GETs, manual redirects, real transport pacing, immutable originals and memory-only cookies", async () => {
    const root = await directory();
    const fetch = vi.fn().mockImplementation(async () => new Response(EMPTY, { headers: { "Set-Cookie": "SyntheticSession=synthetic-cookie; Path=/; Secure; HttpOnly" } }));
    vi.stubGlobal("fetch", fetch);
    const transport = createNorthCarolinaReportedReceiptDiscoveryTransport({ cacheDir: root });
    expect(await transport.fetchText(ncsbeCommitteeSearchUrl("Synthetic One"))).toBe(EMPTY);
    const second = transport.fetchText(ncsbeCommitteeSearchUrl("Synthetic Two"));
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await second).toBe(EMPTY);
    expect(fetch).toHaveBeenCalledTimes(2);
    const request = fetch.mock.calls[1]![1] as RequestInit;
    expect(request).toMatchObject({ method: "GET", redirect: "manual", headers: { Cookie: "SyntheticSession=synthetic-cookie" } });
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(request.body).toBeUndefined();
    const saved = await journal(root);
    expect(saved.originals).toHaveLength(2);
    expect(saved.originals[0]).toMatchObject({ ordinal: 1, file: "originals/0001.raw", status: 200, eof: true,
      byteSize: Buffer.byteLength(EMPTY), sha256: createHash("sha256").update(EMPTY).digest("hex"), startedAt: NOW.toISOString(), completedAt: NOW.toISOString() });
    expect(saved.originals[1].startedAt).toBe(new Date(NOW.getTime() + 2000).toISOString());
    expect(JSON.stringify(saved)).not.toContain("synthetic-cookie");
    expect((await raw(root)).toString("utf8")).toBe(EMPTY);
    for (const path of [root, join(root, "recorded-source"), join(root, "recorded-source", "originals")]) expect((await stat(path)).mode & 0o777).toBe(0o700);
    for (const path of [join(root, "recorded-source", "originals", "0001.raw"), join(root, "recorded-source", "capture-journal.json")]) expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("stops the real discovery function's committee-name fallback after one native 503", async () => {
    const root = await directory();
    const fetch = vi.fn().mockResolvedValue(new Response("Synthetic unavailable response", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const transport = createNorthCarolinaReportedReceiptDiscoveryTransport({ cacheDir: root });
    const result = await discoverNcsbeAcquisitionCommittees({ transport, cacheDir: root, force: true, roster: [{
      candidateId: "00000000-0000-4000-8000-000000000001", electionId: "00000000-0000-4000-8000-000000000002",
      candidateName: "Synthetic Candidate", electionYear: 2028, officeScope: "state_upper", officeName: "State Senator", district: "Synthetic District",
      linkedCommitteeId: "STA-AA11BB-C-001", linkedCommitteeName: "Synthetic Committee",
    }] });
    expect(result.searchFailures).toHaveLength(2); // Legacy discovery still tries both logical searches.
    expect(result.committees).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1); // The fallback makes no second HTTP request.
    expect((await journal(root)).originals[0]).toMatchObject({ status: 503, eof: true });
    expect((await raw(root)).toString("utf8")).toBe("Synthetic unavailable response");
  });

  it.each([
    ["redirect", () => new Response("Synthetic redirect body", { status: 302, headers: { Location: "https://other.invalid/" } })],
    ["invalid UTF-8", () => new Response(new Uint8Array([0xff, 0xfe, 0xff]))],
    ["invalid native shape", () => new Response("Synthetic unrelated HTML")],
    ["truncated declared body", () => new Response(EMPTY, { headers: { "Content-Length": "9999" } })],
  ] as const)("retains %s bytes before rejecting, then latches the whole pass", async (_kind, response) => {
    const root = await directory();
    const fetch = vi.fn().mockImplementation(async () => response());
    vi.stubGlobal("fetch", fetch);
    const transport = createNorthCarolinaReportedReceiptDiscoveryTransport({ cacheDir: root });
    await expect(transport.fetchText(ncsbeCommitteeSearchUrl("Synthetic One"))).rejects.toMatchObject({ code: "unavailable", message: "North Carolina reported receipt source unavailable" });
    await expect(transport.fetchText(ncsbeCommitteeSearchUrl("Synthetic Two"))).rejects.toMatchObject({ code: "unavailable" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const saved = await journal(root), bytes = await raw(root);
    expect(saved.originals).toHaveLength(1);
    expect(saved.originals[0]).toMatchObject({ eof: true, byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("preserves a fatal-decode-safe BOM without silently changing original HTML", async () => {
    const root = await directory();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("\ufeff" + EMPTY)));
    const result = await createNorthCarolinaReportedReceiptDiscoveryTransport({ cacheDir: root }).fetchText(ncsbeCommitteeSearchUrl("Synthetic One"));
    expect(result).toBe("\ufeff" + EMPTY);
    expect((await raw(root)).equals(Buffer.from(result, "utf8"))).toBe(true);
  });

  it("retains the exact received stream prefix and EOF false on interruption", async () => {
    const root = await directory();
    let reads = 0;
    const fetch = vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (reads++ === 0) controller.enqueue(new TextEncoder().encode("Synthetic partial prefix"));
      else controller.error(new Error("Synthetic stream failure"));
    } })));
    vi.stubGlobal("fetch", fetch);
    const transport = createNorthCarolinaReportedReceiptDiscoveryTransport({ cacheDir: root });
    await expect(transport.fetchText(ncsbeCommitteeSearchUrl("Synthetic One"))).rejects.toMatchObject({ code: "unavailable" });
    expect((await raw(root)).toString("utf8")).toBe("Synthetic partial prefix");
    expect((await journal(root)).originals[0]).toMatchObject({ eof: false, byteSize: 24 });
    await expect(transport.fetchText(ncsbeCommitteeSearchUrl("Synthetic Two"))).rejects.toMatchObject({ code: "unavailable" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retains at most 16 MiB from an oversized chunked stream and awaits cancellation", async () => {
    const root = await directory();
    let sent = 0;
    const cancel = vi.fn();
    const fetch = vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      const size = Math.min(1024 * 1024, LIMITS.maxBodyBytes + 1 - sent);
      if (size === 0) return; // Stay open so the bounded consumer must cancel.
      controller.enqueue(new Uint8Array(size)); sent += size;
    }, cancel })));
    vi.stubGlobal("fetch", fetch);
    const transport = createNorthCarolinaReportedReceiptDiscoveryTransport({ cacheDir: root });
    await expect(transport.fetchText(ncsbeCommitteeSearchUrl("Synthetic One"))).rejects.toMatchObject({ code: "unavailable" });
    expect(cancel).toHaveBeenCalledOnce();
    expect((await raw(root)).length).toBe(LIMITS.maxBodyBytes);
    expect((await journal(root)).originals[0]).toMatchObject({ eof: false, byteSize: LIMITS.maxBodyBytes });
    await expect(transport.fetchText(ncsbeCommitteeSearchUrl("Synthetic Two"))).rejects.toMatchObject({ code: "unavailable" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("records a failed network attempt safely without retry or a fabricated response", async () => {
    const root = await directory();
    const fetch = vi.fn().mockRejectedValue(new Error("Synthetic network error with private request context"));
    vi.stubGlobal("fetch", fetch);
    const transport = createNorthCarolinaReportedReceiptDiscoveryTransport({ cacheDir: root });
    await expect(transport.fetchText(ncsbeCommitteeSearchUrl("Synthetic One"))).rejects.toMatchObject({ code: "unavailable", message: "North Carolina reported receipt source unavailable" });
    expect((await journal(root)).originals[0]).toMatchObject({ status: 0, eof: false, byteSize: 0 });
    expect((await raw(root)).length).toBe(0);
    await expect(transport.fetchText(ncsbeCommitteeSearchUrl("Synthetic Two"))).rejects.toMatchObject({ code: "unavailable" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stops before another HTTP request once the actual pass duration is exhausted", async () => {
    const root = await directory();
    const fetch = vi.fn().mockImplementation(async () => new Response(EMPTY));
    vi.stubGlobal("fetch", fetch);
    const transport = createNorthCarolinaReportedReceiptDiscoveryTransport({ cacheDir: root });
    await transport.fetchText(ncsbeCommitteeSearchUrl("Synthetic One"));
    vi.setSystemTime(NOW.getTime() + LIMITS.maxCaptureMs + 1);
    const second = expect(transport.fetchText(ncsbeCommitteeSearchUrl("Synthetic Two"))).rejects.toMatchObject({ code: "unavailable" });
    await vi.advanceTimersByTimeAsync(LIMITS.requestSpacingMs);
    await second;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    "https://other.invalid/CFOrgLkup/CommitteeGeneralResult/?name=Synthetic",
    "https://cf.ncsbe.gov/CFOrgLkup/ReportDetail/?RID=11&TP=ALL",
    ncsbeCommitteeSearchUrl("Synthetic") + "&extra=1",
    ncsbeCommitteeSearchUrl("Synthetic") + "#",
    ncsbeCommitteeSearchUrl("Synthetic").replace("useOrgName=True", "useOrgName=False"),
  ])("rejects changed route, origin, form scope, or ambiguity before HTTP: %s", async (url) => {
    const root = await directory(), fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(createNorthCarolinaReportedReceiptDiscoveryTransport({ cacheDir: root }).fetchText(url)).rejects.toMatchObject({ code: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects POST forms and refuses to reuse another factory's immutable originals", async () => {
    const root = await directory(), fetch = vi.fn().mockImplementation(async () => new Response(EMPTY)); vi.stubGlobal("fetch", fetch);
    await expect(createNorthCarolinaReportedReceiptDiscoveryTransport({ cacheDir: root }).fetchText(ncsbeCommitteeSearchUrl("Synthetic"), {})).rejects.toMatchObject({ code: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
    await createNorthCarolinaReportedReceiptDiscoveryTransport({ cacheDir: root }).fetchText(ncsbeCommitteeSearchUrl("Synthetic"));
    const saved = await raw(root), originalJournal = await journal(root);
    await expect(createNorthCarolinaReportedReceiptDiscoveryTransport({ cacheDir: root }).fetchText(ncsbeCommitteeSearchUrl("Synthetic Two"))).rejects.toMatchObject({ code: "unavailable" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await raw(root)).equals(saved)).toBe(true);
    expect(await journal(root)).toEqual(originalJournal);
  });
});
