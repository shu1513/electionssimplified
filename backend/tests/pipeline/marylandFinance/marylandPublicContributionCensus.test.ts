import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireMarylandPublicContributionCensus } from "../../../src/pipeline/marylandFinance/marylandPublicContributionCensus.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const dirs: string[] = [];
async function directory() {
  const base = await mkdtemp(join(tmpdir(), "md-census-"));
  dirs.push(base);
  return join(base, "originals");
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, {recursive: true, force: true})));
});
const scope = {filerRegistrationGuid: OWNER, electionCycle: "12023"};
function rows(start: number, count: number, returns = false) {
  return Array.from({length: count}, (_, index) => ({
    filerRegistrationGuid: OWNER, electionCycleId: 12023,
    transactionGuid: `${String(start + index).padStart(8, "0")}-1111-4111-8111-111111111111`,
    transactionId: start + index, transactionVersionID: 1,
    reportGuid: "22222222-2222-4222-8222-222222222222", reportId: 1, reportVersionId: 1,
    isReturn: returns, isActive: true, isAmended: false, hasChild: false,
    transactionTypeCode: returns ? "TRCON" : "TCON", transactionAmount: 25,
    contributorName: "private raw source name",
  }));
}
function response(page: number, total: number, overrideRows?: ReturnType<typeof rows>) {
  const count = Math.min(100, Math.max(0, total - (page - 1) * 100));
  return new Response(JSON.stringify({succeeded: true, error: null,
    data: {items: overrideRows ?? rows((page - 1) * 100 + 1, count), totalItems: total, pageNumber: 0, pageSize: 0}}));
}
function fake(total: number, transform?: (page: number) => Response | Promise<Response>) {
  return vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    return transform ? await transform(body.pageNumber) : response(body.pageNumber, total);
  });
}

describe("Maryland whole public grid acquisition", () => {
  it("collects every page/remainder and retains private originals without financial acceptance", async () => {
    const outputDirectory = await directory();
    const fetchImpl = fake(205);
    const progress: number[] = [];
    const result = await acquireMarylandPublicContributionCensus({...scope, outputDirectory, fetchImpl,
      onProgress: p => {progress.push(p.completedPages);}});
    expect(result).toMatchObject({declaredRows: 205, physicalRows: 205, requestedPages: 3, completedPages: 3});
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(progress).toEqual([1, 2, 3]);
    expect(JSON.stringify(result)).not.toContain(OWNER);
    expect(JSON.stringify(result)).not.toContain("private raw source name");
    expect(result).not.toHaveProperty("current");
    expect(result).not.toHaveProperty("qualified");
    expect((await stat(outputDirectory)).mode & 0o777).toBe(0o700);
    const captures = (await readFile(result.journalPath, "utf8")).trim().split("\n").map(s => JSON.parse(s));
    expect(captures).toHaveLength(3);
    for (const capture of captures) {
      const raw = await readFile(capture.outputPath);
      expect(raw.length).toBe(capture.byteCount);
      expect(createHash("sha256").update(raw).digest("hex")).toBe(capture.sha256);
      expect(capture.bodyComplete).toBe(true);
      expect((await stat(capture.outputPath)).mode & 0o777).toBe(0o600);
    }
  });
  it("fails on declared count drift instead of publishing a partial ledger", async () => {
    const outputDirectory = await directory();
    const fetchImpl = fake(200, page => response(page, page === 1 ? 200 : 201));
    await expect(acquireMarylandPublicContributionCensus({...scope, outputDirectory, fetchImpl, concurrency: 1}))
      .rejects.toMatchObject({code: "count_drift"});
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((await readdir(outputDirectory)).filter(name => name.endsWith("original.json"))).toHaveLength(2);
  });
  it("fails cross-page repeated occurrences without deduplicating or merging equal gifts", async () => {
    const fetchImpl = fake(200, page => response(page, 200, rows(1, 100)));
    await expect(acquireMarylandPublicContributionCensus({...scope, outputDirectory: await directory(), fetchImpl}))
      .rejects.toMatchObject({code: "duplicate_occurrence"});
  });
  it("enforces declared page budget after one genuine page without further requests", async () => {
    const fetchImpl = fake(201);
    await expect(acquireMarylandPublicContributionCensus({...scope, outputDirectory: await directory(), fetchImpl, maxPages: 2}))
      .rejects.toMatchObject({code: "page_limit"});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("retains a failed raw body and propagates status instead of claiming empty coverage", async () => {
    const outputDirectory = await directory();
    const fetchImpl = fake(200, page => page === 1 ? response(page, 200) : new Response("source failure", {status: 503}));
    await expect(acquireMarylandPublicContributionCensus({...scope, outputDirectory, fetchImpl}))
      .rejects.toMatchObject({code: "http_status"});
    expect(await readFile(join(outputDirectory, "page-0002.original.json"), "utf8")).toBe("source failure");
  });
  it("records actual bytes and holds the collection once its total budget is exceeded", async () => {
    const outputDirectory = await directory();
    const fetchImpl = fake(100);
    await expect(acquireMarylandPublicContributionCensus({...scope, outputDirectory, fetchImpl, maxTotalBytes: 1}))
      .rejects.toMatchObject({code: "total_byte_limit"});
    const capture = JSON.parse((await readFile(join(outputDirectory, "captures.private.jsonl"), "utf8")).trim());
    expect(capture.byteCount).toBeGreaterThan(1);
    expect(capture.bodyComplete).toBe(true);
    expect((await readFile(capture.outputPath)).length).toBe(capture.byteCount);
  });
  it("bounds concurrency and waits for every original rather than returning after first completion", async () => {
    let active = 0, peak = 0;
    const fetchImpl = fake(501, async page => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, page === 2 ? 20 : 5));
      active--;
      return response(page, 501);
    });
    const result = await acquireMarylandPublicContributionCensus({...scope, outputDirectory: await directory(), fetchImpl, concurrency: 2});
    expect(result.completedPages).toBe(6);
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });
  it("aborts a live request on whole-census deadline and retains its failure journal", async () => {
    const outputDirectory = await directory();
    const fetchImpl: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("abort")), {once: true});
    });
    await expect(acquireMarylandPublicContributionCensus({...scope, outputDirectory, fetchImpl,
      totalTimeoutMs: 10, timeoutMs: 100})).rejects.toMatchObject({code: "census_timeout"});
    const capture = JSON.parse((await readFile(join(outputDirectory, "captures.private.jsonl"), "utf8")).trim());
    expect(capture.bodyComplete).toBe(false);
  });
  it("keeps explicit return-only scope separate from unrestricted acquisition", async () => {
    const fetchImpl = fake(1, page => response(page, 1, rows(1, 1, true)));
    const result = await acquireMarylandPublicContributionCensus({...scope, isReturn: true,
      outputDirectory: await directory(), fetchImpl});
    expect(result.physicalRows).toBe(1);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string).isReturn).toBe(true);
  });
  it("bounds a stalled progress observer after preserving the completed original", async () => {
    const outputDirectory = await directory();
    await expect(acquireMarylandPublicContributionCensus({...scope, outputDirectory, fetchImpl: fake(1),
      totalTimeoutMs: 30, onProgress: async () => new Promise(() => {}),
    })).rejects.toMatchObject({code: "census_timeout"});
    const capture = JSON.parse((await readFile(join(outputDirectory, "captures.private.jsonl"), "utf8")).trim());
    expect(capture.bodyComplete).toBe(true);
  });
  it.each([{maxPages: 1501}, {concurrency: 5}, {totalTimeoutMs: 0}, {maxTotalBytes: 0}, {timeoutMs: 30001}])(
    "rejects unbounded configuration before network work %j", async options => {
      const fetchImpl = fake(0);
      await expect(acquireMarylandPublicContributionCensus({...scope, ...options,
        outputDirectory: await directory(), fetchImpl})).rejects.toMatchObject({code: "invalid_request"});
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
});
