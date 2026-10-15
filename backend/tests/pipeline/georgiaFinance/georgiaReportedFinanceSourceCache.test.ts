import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createGeorgiaReportedFinanceSourceProducer,
  GeorgiaReportedFinanceSourceCacheError,
  readGeorgiaReportedContributionSource,
  readGeorgiaReportedIeSource,
} from "../../../src/pipeline/georgiaFinance/georgiaReportedFinanceSourceCache.js";
import { GEORGIA_REPORTED_CONTRIBUTION_EXPORT_HEADER as HEADER } from "../../../src/pipeline/georgiaFinance/georgiaReportedContributionExport.js";

const faults = vi.hoisted(() => ({ pointerRename: false, lockCleanup: false }));
vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original,
    rename: async (from: Parameters<typeof original.rename>[0], to: Parameters<typeof original.rename>[1]) => {
      if (faults.pointerRename && String(to).endsWith("current.json")) throw new Error("Fixture atomic publish failure");
      return original.rename(from, to);
    },
    unlink: async (path: Parameters<typeof original.unlink>[0]) => {
      if (faults.lockCleanup && String(path).endsWith(".lock")) throw new Error("Fixture cleanup failure");
      return original.unlink(path);
    },
  };
});
const directories: string[] = [];
const scope = { filingYear: 2026, electionYear: 2026 };
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function directory() {
  const cacheDir = await mkdtemp(join(tmpdir(), "ga-reported-cache-test-"));
  directories.push(cacheDir);
  return cacheDir;
}
function item(amountApplied = 125.25) {
  return {
    guid: "fixture-transaction", transactionId: 1, amountApplied,
    filerRegistrationGuid: "fixture-spender", filerName: "Fixture reporting committee",
    filerReportGuid: null, timedFiledReportGuid: "fixture-timed-report", filerReportVersionId: null,
    transactionDate: "2001-01-01", transactionStatusCode: "TPEN", transactionTypeCode: "TIE", electionYear: 2026,
    candidateMeasures: [{ candidateMeasureTitle: "Fixture target", stance: "Support", reasonTypeCode: "CAN", filerRegistrationGuid: "fixture-target" }],
  };
}
function body(rows: unknown[] = [item()], count: number | undefined = rows.length) {
  return JSON.stringify({ succeeded: true, error: null, data: { items: rows, totalItems: count } });
}
function response(bytes: string | Uint8Array, headers: Record<string, string> = {}, status = 200) {
  return new Response(bytes as BodyInit, { status, headers: { "content-type": "application/json", ...headers } });
}
function ieFetch(bytes = body()): typeof fetch {
  return vi.fn(async () => response(bytes)) as unknown as typeof fetch;
}
function csvRow(overrides: Record<string, string> = {}) {
  const fields: Record<string, string> = {
    "Filing Entity ID": "101", "Filing Entity Name": "Fixture receiver", "Campaign Committee Name": "Fixture campaign",
    "Registration Type": "Candidate/Candidate Campaign Committee", "Registration Subtype": "Candidate Committee",
    "Transaction Id": "7001", "Transaction Type": "Contribution", "Transaction Sub Type": "Itemized Contribution",
    "Contributor Type": "Non-Candidate Committee", "Contributor Last Name": "Fixture reported committee",
    "Transaction Amount": "$125.25", "Election Year": "2026", "Amended": "N", "Timed Report Name": "Fixture timed report",
    ...overrides,
  };
  return HEADER.map(key => fields[key] ?? "").join(",");
}
function csv(rows = [csvRow()]) { return `${HEADER.join(",")}\r\n${rows.join("\r\n")}\r\n`; }
function csvFetch(bytes = csv()): typeof fetch {
  return vi.fn(async () => response(bytes, { "content-type": "text/csv; charset=windows-1252" })) as unknown as typeof fetch;
}
async function pointer(cacheDir: string, kind = "ie") {
  const path = join(cacheDir, `${kind}-2026-2026`, "current.json");
  const bytes = await readFile(path);
  const parsed = JSON.parse(bytes.toString());
  const generation = join(cacheDir, `${kind}-2026-2026`, parsed.generation);
  return { path, bytes, parsed, generation };
}
async function rehashManifest(p: Awaited<ReturnType<typeof pointer>>, mutate: (m: any) => Promise<void> | void) {
  const path = join(p.generation, "manifest.json");
  const m = JSON.parse(await readFile(path, "utf8"));
  await mutate(m);
  const bytes = Buffer.from(JSON.stringify(m));
  await writeFile(path, bytes);
  await writeFile(p.path, JSON.stringify({ ...p.parsed, manifestSha256: sha(bytes) }));
}

afterEach(async () => {
  faults.pointerRename = false;
  faults.lockCleanup = false;
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("Georgia immutable reported-finance sources", () => {
  it("returns null only for an absent pointer and rejects invalid scope safely", async () => {
    const cacheDir = await directory();
    expect(await readGeorgiaReportedIeSource({ cacheDir, ...scope })).toBeNull();
    expect(await readGeorgiaReportedContributionSource({ cacheDir, ...scope })).toBeNull();
    await expect(readGeorgiaReportedIeSource({ cacheDir, ...scope, electionYear: 2025 })).rejects.toMatchObject({ code: "invalid_scope" });
    await writeFile(join(cacheDir, "ie-2026-2026"), "not a directory");
    await expect(readGeorgiaReportedIeSource({ cacheDir, ...scope })).rejects.toThrow("Georgia reported finance source cache unavailable");
  });

  it("uses the real two-pass client with native counts, fixed route/manual redirects, and original clocks", async () => {
    const cacheDir = await directory();
    const fetchImpl = ieFetch();
    const before = Date.now();
    const packet = await createGeorgiaReportedFinanceSourceProducer({ cacheDir, fetchImpl }).refreshIe(scope);
    expect(packet.rows).toHaveLength(1);
    expect(packet).toMatchObject({ nativeTotal: 1, passCount: 2, sourceRowCount: 1, sourceUrl: "https://ethics.ga.gov/records-search-all/" });
    expect(packet.sourceByteSize).toBe(Buffer.byteLength(body()) * 2);
    expect(packet.sourceControls).toHaveLength(2);
    expect(Date.parse(packet.sourceRetrievedAt)).toBeGreaterThanOrEqual(before);
    expect(packet.sourceRetrievedAt).toBe(packet.sourceControls[0]!.startedAt);
    expect(Date.parse(packet.sourceControls[1]!.startedAt) - Date.parse(packet.sourceRetrievedAt)).toBeGreaterThanOrEqual(1900);
    for (const [url, options] of vi.mocked(fetchImpl).mock.calls) {
      expect(url).toBe("https://api-peachfile.ethics.ga.gov/api/PublicIndependentExpenditureDetails/GetIndependentExpenditureDetails");
      expect(options).toMatchObject({ method: "POST", redirect: "manual" });
      expect(options!.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.parse(String(options!.body))).toMatchObject({ pageSize: 100, filerName: null, candidateMeasure: null, electionYear: null });
    }
    const saved = await readGeorgiaReportedIeSource({ cacheDir, ...scope });
    expect(saved).toEqual(packet);
    expect(packet.rows[0]!.transactionDate).toBe("2001-01-01"); // no invented date cutoff
    const p = await pointer(cacheDir);
    expect((await stat(p.path)).mode & 0o777).toBe(0o600);
    expect((await stat(p.generation)).mode & 0o777).toBe(0o700);
    expect((await stat(join(p.generation, "0001.raw"))).mode & 0o777).toBe(0o600);
    const manifest = await readFile(join(p.generation, "manifest.json"), "utf8");
    expect(manifest).not.toContain("fixture-spender");
    expect(manifest).not.toContain("Fixture reporting committee");
    expect(manifest).not.toContain("requestBody");
  });

  it("retains the committed generation and a pinned packet after a subsequent successful refresh", async () => {
    const cacheDir = await directory();
    const first = await createGeorgiaReportedFinanceSourceProducer({ cacheDir, fetchImpl: ieFetch() }).refreshIe(scope);
    const old = await pointer(cacheDir);
    const next = await createGeorgiaReportedFinanceSourceProducer({ cacheDir, fetchImpl: ieFetch(body([item(200)])) }).refreshIe(scope);
    expect((await pointer(cacheDir)).parsed.generation).not.toBe(old.parsed.generation);
    expect(first.rows[0]!.amountApplied).toBe(125.25);
    expect(next.rows[0]!.amountApplied).toBe(200);
    expect(await readFile(join(old.generation, "0001.raw"), "utf8")).toBe(body());
    expect((await readGeorgiaReportedIeSource({ cacheDir, ...scope }))!.sourceRetrievedAt).toBe(next.sourceRetrievedAt);
  });

  it.each([
    ["missing native count", body([item()], undefined).replace(',"totalItems":1', '')],
    ["contradictory native count", body([item()], 2)],
    ["lost target schema", body([{ ...item(), candidateMeasures: null }])],
    ["unsafe amount", body([item(1.001)])],
    ["invalid JSON", '{"data":'],
    ["stable empty whole store", body([], 0)],
  ])("rejects %s without publishing financial zero", async (_label, raw) => {
    const cacheDir = await directory();
    await expect(createGeorgiaReportedFinanceSourceProducer({ cacheDir, fetchImpl: ieFetch(raw) }).refreshIe(scope))
      .rejects.toThrow("Georgia reported finance source cache unavailable");
    expect(await readGeorgiaReportedIeSource({ cacheDir, ...scope })).toBeNull();
  });

  it("rejects same IDs with changed money between passes and preserves the old pointer/clock", async () => {
    const cacheDir = await directory();
    const previous = await createGeorgiaReportedFinanceSourceProducer({ cacheDir, fetchImpl: ieFetch() }).refreshIe(scope);
    const p = await pointer(cacheDir);
    let call = 0;
    const fetchImpl = vi.fn(async () => response(body([item(++call === 1 ? 300 : 301)]))) as unknown as typeof fetch;
    await expect(createGeorgiaReportedFinanceSourceProducer({ cacheDir, fetchImpl }).refreshIe(scope)).rejects.toBeInstanceOf(GeorgiaReportedFinanceSourceCacheError);
    expect(await readFile(p.path)).toEqual(p.bytes);
    expect((await readGeorgiaReportedIeSource({ cacheDir, ...scope }))!.sourceRetrievedAt).toBe(previous.sourceRetrievedAt);
    expect((await readdir(join(cacheDir, "ie-2026-2026"))).filter(name => name.startsWith("generation-"))).toHaveLength(2);
  });

  it("rejects an HTTP failure/short body/redirect without replacing the old CSV source", async () => {
    const cacheDir = await directory();
    await createGeorgiaReportedFinanceSourceProducer({ cacheDir, fetchImpl: csvFetch() }).refreshContributions(scope);
    const p = await pointer(cacheDir, "contributions");
    for (const fetchImpl of [
      vi.fn(async () => response("upstream unavailable", { "content-type": "text/plain" }, 503)),
      vi.fn(async () => response(csv(), { "content-type": "text/csv", "content-length": String(Buffer.byteLength(csv()) + 5) })),
      vi.fn(async () => response("redirect", { location: "https://example.invalid", "content-type": "text/plain" }, 302)),
    ]) {
      await expect(createGeorgiaReportedFinanceSourceProducer({ cacheDir, fetchImpl: fetchImpl as unknown as typeof fetch }).refreshContributions(scope)).rejects.toThrow("Georgia reported finance source cache unavailable");
      expect(await readFile(p.path)).toEqual(p.bytes);
    }
  });

  it("keeps the previous pointer when atomic publication fails after all new originals validate", async () => {
    const cacheDir = await directory();
    const old = await createGeorgiaReportedFinanceSourceProducer({ cacheDir, fetchImpl: csvFetch() }).refreshContributions(scope);
    const p = await pointer(cacheDir, "contributions");
    faults.pointerRename = true;
    await expect(createGeorgiaReportedFinanceSourceProducer({ cacheDir, fetchImpl: csvFetch(csv([csvRow({ "Transaction Amount": "$500.00" })])) }).refreshContributions(scope))
      .rejects.toThrow("Georgia reported finance source cache unavailable");
    expect(await readFile(p.path)).toEqual(p.bytes);
    expect((await readGeorgiaReportedContributionSource({ cacheDir, ...scope }))!.sourceManifestSha256).toBe(old.sourceManifestSha256);
    expect(await readFile(join(p.generation, "0001.raw"), "utf8")).toBe(csv());
  });

  it("does not report a committed publication as failed when later lock cleanup fails", async () => {
    const cacheDir = await directory();
    faults.lockCleanup = true;
    const saved = await createGeorgiaReportedFinanceSourceProducer({ cacheDir, fetchImpl: csvFetch() }).refreshContributions(scope);
    expect((await readGeorgiaReportedContributionSource({ cacheDir, ...scope }))!.sourceManifestSha256).toBe(saved.sourceManifestSha256);
    await expect(createGeorgiaReportedFinanceSourceProducer({ cacheDir, fetchImpl: csvFetch() }).refreshContributions(scope)).rejects.toMatchObject({ code: "locked" });
  });

  it("rejects a 3 MiB IE body below the separate 32 MiB total bound", async () => {
    const cacheDir = await directory();
    // Valid JSON plus legal trailing whitespace would pass the native client
    // and both complete passes if only the whole-source limit were enforced.
    const native = body();
    const raw = native + " ".repeat(3 * 1024 * 1024 - Buffer.byteLength(native));
    const fetchImpl = ieFetch(raw);
    await expect(createGeorgiaReportedFinanceSourceProducer({ cacheDir, fetchImpl }).refreshIe(scope))
      .rejects.toThrow("Georgia reported finance source cache unavailable");
    expect(await readGeorgiaReportedIeSource({ cacheDir, ...scope })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("aborts a body above the IE byte bound without publishing a pointer", async () => {
    const cacheDir = await directory();
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(32 * 1024 * 1024 + 1)); controller.close();
    } }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await expect(createGeorgiaReportedFinanceSourceProducer({ cacheDir, fetchImpl }).refreshIe(scope)).rejects.toThrow("Georgia reported finance source cache unavailable");
    expect(await readGeorgiaReportedIeSource({ cacheDir, ...scope })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reconstructs CSV owner quarantine from original bytes on every read, with no identities in its manifest", async () => {
    const cacheDir = await directory();
    const raw = csv([csvRow(), csvRow({ "Filing Entity ID": "202", "Transaction Id": "7002", "Transaction Amount": "bad amount" })]);
    const fetchImpl = csvFetch(raw);
    const packet = await createGeorgiaReportedFinanceSourceProducer({ cacheDir, fetchImpl }).refreshContributions(scope);
    expect(packet.rowsByReceivingCommitteeId.get("101")).toHaveLength(1);
    expect(packet.heldReceivingCommitteeIds.has("202")).toBe(true);
    expect(packet.rowsByReceivingCommitteeId.has("202")).toBe(false);
    expect(packet.sourceRowCount).toBe(2);
    expect((await readGeorgiaReportedContributionSource({ cacheDir, ...scope }))!.heldReceivingCommitteeIds).toEqual(packet.heldReceivingCommitteeIds);
    const p = await pointer(cacheDir, "contributions");
    const manifest = await readFile(join(p.generation, "manifest.json"), "utf8");
    expect(manifest).not.toContain("7001");
    expect(manifest).not.toContain("Fixture reported committee");
    expect(JSON.parse(String(vi.mocked(fetchImpl).mock.calls[0]![1]!.body))).toEqual({ transactionTypeCode: "TCON", type: "CSV", filingYear: "2026" });
  });

  it("keeps IE and CSV publication independent when CSV has unassignable fragments", async () => {
    const cacheDir = await directory();
    const producer = createGeorgiaReportedFinanceSourceProducer({ cacheDir, fetchImpl: vi.fn(async url =>
      String(url).includes("ExportPublicData") ? response(`${csv()}ownerless fragment\r\n`, { "content-type": "text/csv" }) : response(body())) as unknown as typeof fetch });
    const packet = await producer.refreshIe(scope);
    await expect(producer.refreshContributions(scope)).rejects.toThrow("Georgia reported finance source cache unavailable");
    expect((await readGeorgiaReportedIeSource({ cacheDir, ...scope }))!.sourceManifestSha256).toBe(packet.sourceManifestSha256);
    expect(await readGeorgiaReportedContributionSource({ cacheDir, ...scope })).toBeNull();
  });

  it("serializes an exclusive kind/filing-year refresh without issuing another request", async () => {
    const cacheDir = await directory();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const requestStarted = new Promise<void>(resolve => { started = resolve; });
    let calls = 0;
    const fetchImpl = vi.fn(async () => { if (++calls === 1) { started(); await gate; } return response(body()); }) as unknown as typeof fetch;
    const pending = createGeorgiaReportedFinanceSourceProducer({ cacheDir, fetchImpl }).refreshIe(scope);
    await requestStarted;
    const secondFetch = ieFetch();
    await expect(createGeorgiaReportedFinanceSourceProducer({ cacheDir, fetchImpl: secondFetch }).refreshIe({ ...scope, electionYear: 2028 })).rejects.toMatchObject({ code: "locked" });
    expect(secondFetch).not.toHaveBeenCalled();
    release();
    await pending;
    await expect(stat(join(cacheDir, "ie-2026.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on a present corrupt pointer, missing manifest or altered original", async () => {
    const cacheDir = await directory();
    await createGeorgiaReportedFinanceSourceProducer({ cacheDir, fetchImpl: csvFetch() }).refreshContributions(scope);
    const p = await pointer(cacheDir, "contributions");
    await writeFile(p.path, JSON.stringify({ ...p.parsed, generation: "../../elsewhere" }));
    await expect(readGeorgiaReportedContributionSource({ cacheDir, ...scope })).rejects.toThrow("Georgia reported finance source cache unavailable");
    await writeFile(p.path, p.bytes);
    const original = await readFile(join(p.generation, "0001.raw"));
    await writeFile(join(p.generation, "0001.raw"), Buffer.from(original.toString().replace("125.25", "999.99")));
    await expect(readGeorgiaReportedContributionSource({ cacheDir, ...scope })).rejects.toThrow("Georgia reported finance source cache unavailable");
    await writeFile(join(p.generation, "0001.raw"), original);
    await rm(join(p.generation, "manifest.json"));
    await expect(readGeorgiaReportedContributionSource({ cacheDir, ...scope })).rejects.toThrow("Georgia reported finance source cache unavailable");
  });

  it("rechecks native count/schema/full payload even if corrupt originals are rehashed in the manifest", async () => {
    const cacheDir = await directory();
    await createGeorgiaReportedFinanceSourceProducer({ cacheDir, fetchImpl: ieFetch() }).refreshIe(scope);
    const p = await pointer(cacheDir);
    await rehashManifest(p, async m => {
      const changed = Buffer.from(body([item(900)]));
      await writeFile(join(p.generation, "0002.raw"), changed);
      m.captures[1].sha256 = sha(changed); m.captures[1].byteSize = changed.length;
    });
    await expect(readGeorgiaReportedIeSource({ cacheDir, ...scope })).rejects.toThrow("Georgia reported finance source cache unavailable");
  });

  it("rejects counterfeit source row counts and impossible source clocks even with matching manifest SHA", async () => {
    const cacheDir = await directory();
    await createGeorgiaReportedFinanceSourceProducer({ cacheDir, fetchImpl: csvFetch() }).refreshContributions(scope);
    const p = await pointer(cacheDir, "contributions");
    await rehashManifest(p, m => { m.sourceRowCount += 1; });
    await expect(readGeorgiaReportedContributionSource({ cacheDir, ...scope })).rejects.toThrow("Georgia reported finance source cache unavailable");
    await rehashManifest(p, m => { m.sourceRowCount = 1; m.captures[0].completedAt = "2000-01-01T00:00:00.000Z"; });
    await expect(readGeorgiaReportedContributionSource({ cacheDir, ...scope })).rejects.toThrow("Georgia reported finance source cache unavailable");
  });
});
