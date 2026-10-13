import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireMarylandPublicContributionCensus, readMarylandPublicContributionCensus } from "../../../src/pipeline/marylandFinance/marylandPublicContributionCensus.js";

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

describe("Maryland saved whole leaf census", () => {
  async function saved(total = 101) {
    const outputDirectory = await directory();
    const result = await acquireMarylandPublicContributionCensus({...scope, outputDirectory, fetchImpl: fake(total)});
    const captures = (await readFile(result.journalPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    async function journal() {
      await writeFile(result.journalPath, `${captures.map(capture => JSON.stringify(capture)).join("\n")}\n`);
    }
    async function original(index: number, value: unknown | Uint8Array) {
      const bytes = value instanceof Uint8Array ? value : Buffer.from(JSON.stringify(value));
      await writeFile(captures[index].outputPath, bytes);
      captures[index].byteCount = bytes.length;
      captures[index].sha256 = createHash("sha256").update(bytes).digest("hex");
      await journal();
    }
    return {outputDirectory, result, captures, journal, original};
  }
  it("replays normal capture journals offline, including out-of-order completion and original times", async () => {
    const fixture = await saved(205);
    fixture.captures.reverse();
    const thirdPage = fixture.captures.find(capture => capture.requestBody.pageNumber === 3)!;
    thirdPage.headers = {ignored: "private metadata"};
    await fixture.journal();
    const replay = await readMarylandPublicContributionCensus({...scope, outputDirectory: fixture.outputDirectory});
    expect(replay).toMatchObject({declaredRows: 205, physicalRows: 205, capturedBytes: fixture.result.capturedBytes});
    expect(replay.captures.map(capture => capture.requestBody.pageNumber)).toEqual([1, 2, 3]);
    expect(replay.captures[2].startedAt).toBe(thirdPage.startedAt);
    expect(replay.captures[2]).not.toHaveProperty("headers");
    expect(replay.rows[0].contributorName).toBe("private raw source name");
    expect(replay).not.toHaveProperty("qualified");
    expect(replay).not.toHaveProperty("current");
    expect(Object.isFrozen(replay.rows)).toBe(true);
  });
  it("replays a genuine empty page without claiming financial absence", async () => {
    const fixture = await saved(0);
    expect(await readMarylandPublicContributionCensus({...scope, outputDirectory: fixture.outputDirectory}))
      .toMatchObject({declaredRows: 0, physicalRows: 0});
  });
  it.each([
    ["wrong owner", (c: any) => {c.requestBody.filerRegistrationGuid = "33333333-3333-4333-8333-333333333333";}],
    ["wrong cycle", (c: any) => {c.requestBody.electionCycle = "12019";}],
    ["restricted donor filter", (c: any) => {c.requestBody.contributorName = "changed";}],
    ["missing null filter", (c: any) => {delete c.requestBody.officeSought;}],
    ["extra request field", (c: any) => {c.requestBody.extra = true;}],
    ["wrong date scope", (c: any) => {c.requestBody.fromDate = "2023-01-01";}],
    ["wrong method", (c: any) => {c.method = "GET";}],
    ["wrong endpoint", (c: any) => {c.url += "?extra=true";}],
    ["wrong path", (c: any) => {c.outputPath = join(fixtureOutsidePath, "outside.json");}],
    ["failure status", (c: any) => {c.httpStatus = 503;}],
    ["partial body", (c: any) => {c.bodyComplete = false;}],
    ["source error", (c: any) => {c.errorCode = "http_status";}],
    ["invalid SHA", (c: any) => {c.sha256 = "broken";}],
    ["excessive bytes", (c: any) => {c.byteCount = 4 * 1024 * 1024 + 1;}],
    ["noncalendar timestamp", (c: any) => {c.startedAt = "2026-02-30T00:00:00.000Z";}],
    ["inverted timestamps", (c: any) => {c.startedAt = "9999-12-31T23:59:59.999Z";}],
    ["fractional page", (c: any) => {c.requestBody.pageNumber = 1.5;}],
    ["missing requested page", (c: any) => {c.requestBody.pageNumber = 3;}],
  ])("holds %s metadata", async (_label, mutate) => {
    const fixture = await saved();
    mutate(fixture.captures[0]); await fixture.journal();
    await expect(readMarylandPublicContributionCensus({...scope, outputDirectory: fixture.outputDirectory}))
      .rejects.toMatchObject({code: "invalid_capture"});
  });
  it("holds repeated journal pages", async () => {
    const fixture = await saved();
    fixture.captures[1] = fixture.captures[0]; await fixture.journal();
    await expect(readMarylandPublicContributionCensus({...scope, outputDirectory: fixture.outputDirectory}))
      .rejects.toMatchObject({code: "invalid_capture"});
  });
  it.each(["missing", "changed"])("holds %s originals", async kind => {
    const fixture = await saved();
    if (kind === "missing") await rm(fixture.captures[0].outputPath);
    else {
      const bytes = await readFile(fixture.captures[0].outputPath);
      bytes[0] = 32; await writeFile(fixture.captures[0].outputPath, bytes);
    }
    await expect(readMarylandPublicContributionCensus({...scope, outputDirectory: fixture.outputDirectory}))
      .rejects.toMatchObject({code: "changed_original"});
  });
  it.each(["UTF8", "JSON"])("holds malformed %s without exposing source text", async kind => {
    const fixture = await saved();
    await fixture.original(0, kind === "UTF8" ? Buffer.from([0xff]) : Buffer.from("private source invalid JSON"));
    await expect(readMarylandPublicContributionCensus({...scope, outputDirectory: fixture.outputDirectory}))
      .rejects.toThrow("Maryland native receipt census: invalid_capture");
  });
  it.each(["missing page", "extra page", "drifting total"])("holds %s", async kind => {
    const fixture = await saved();
    if (kind === "missing page") {fixture.captures.pop(); await fixture.journal();}
    else if (kind === "extra page") {
      const last = {...fixture.captures[1], requestBody: {...fixture.captures[1].requestBody, pageNumber: 3},
        outputPath: join(fixture.outputDirectory, "page-0003.original.json")};
      fixture.captures.push(last); await fixture.journal();
    } else {
      const value = JSON.parse(await readFile(fixture.captures[1].outputPath, "utf8"));
      value.data.totalItems = 100; value.data.items = []; await fixture.original(1, value);
    }
    await expect(readMarylandPublicContributionCensus({...scope, outputDirectory: fixture.outputDirectory}))
      .rejects.toMatchObject({code: "count_drift"});
  });
  it("holds a duplicate occurrence across separately captured pages", async () => {
    const fixture = await saved();
    const first = JSON.parse(await readFile(fixture.captures[0].outputPath, "utf8"));
    const last = JSON.parse(await readFile(fixture.captures[1].outputPath, "utf8"));
    last.data.items = [first.data.items[0]]; await fixture.original(1, last);
    await expect(readMarylandPublicContributionCensus({...scope, outputDirectory: fixture.outputDirectory}))
      .rejects.toMatchObject({code: "duplicate_occurrence"});
  });
  it.each(["missing EOF", "blank line", "invalid JSON", "invalid UTF8"])("holds journal %s", async kind => {
    const fixture = await saved();
    const text = await readFile(fixture.result.journalPath, "utf8");
    await writeFile(fixture.result.journalPath, kind === "missing EOF" ? text.trimEnd() : kind === "blank line" ? `${text}\n` :
      kind === "invalid JSON" ? "private metadata broken JSON\n" : Buffer.from([0xff, 0x0a]));
    await expect(readMarylandPublicContributionCensus({...scope, outputDirectory: fixture.outputDirectory}))
      .rejects.toMatchObject({code: "invalid_capture"});
  });
});
const fixtureOutsidePath = tmpdir();
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
