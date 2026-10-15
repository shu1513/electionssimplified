import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireMarylandPartitionedContributionCensus, readMarylandPartitionedContributionCensus } from "../../../src/pipeline/marylandFinance/marylandPartitionedContributionCensus.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const REPORT = "22222222-2222-4222-8222-222222222222";
const directories: string[] = [];
async function directory() {
  const parent = await mkdtemp(join(tmpdir(), "md-partitions-")); directories.push(parent);
  return join(parent, "originals");
}
afterEach(async () => {vi.useRealTimers(); await Promise.all(directories.splice(0).map(path => rm(path, {recursive: true, force: true})));});
function row(id: number, date: string) {
  return {filerRegistrationGuid: OWNER, electionCycleId: 12023,
    transactionGuid: `${String(id).padStart(8, "0")}-1111-4111-8111-111111111111`,
    transactionId: id, transactionVersionID: 1, reportGuid: REPORT, reportId: 1,
    reportVersionId: 1, isReturn: false, isActive: true, isAmended: false,
    hasChild: false, transactionTypeCode: "TCON", transactionDate: `${date}T00:00:00`, transactionAmount: 25};
}
type Request = {pageNumber: number; pageSize: number; sortType: string; fromDate: string | null; toDate: string | null};
function source(rows: ReturnType<typeof row>[], mutate?: (data: {items: typeof rows; totalItems: number}, request: Request, call: number) => void) {
  let call = 0;
  return async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(init!.body as string) as Request;
    const selected = rows.filter(r => (!request.fromDate || r.transactionDate.slice(0, 10) >= request.fromDate) &&
      (!request.toDate || r.transactionDate.slice(0, 10) <= request.toDate))
      .sort((a, b) => request.sortType === "asc" ? a.transactionDate.localeCompare(b.transactionDate) : b.transactionDate.localeCompare(a.transactionDate));
    const offset = (request.pageNumber - 1) * request.pageSize;
    const data = {items: selected.slice(offset, Math.min(offset + request.pageSize, 10000)), totalItems: selected.length};
    mutate?.(data, request, ++call);
    return new Response(JSON.stringify({succeeded: true, error: null, data}));
  };
}
const twoDays = () => Array.from({length: 10001}, (_, i) => row(i + 1, i < 5001 ? "2022-11-16" : "2026-08-18"));
const scope = {filerRegistrationGuid: OWNER, electionCycle: "12023"};
describe("Maryland complete disjoint receipt acquisition", () => {
  it("closes all occurrences around the observed paging window and keeps both outer tails unbounded", async () => {
    const path = await directory();
    const result = await acquireMarylandPartitionedContributionCensus({...scope, outputDirectory: path, fetchImpl: source(twoDays()) as typeof fetch});
    expect(result).toMatchObject({declaredRows: 10001, physicalRows: 10001, completedScopes: 2});
    const facts = JSON.parse(await readFile(join(path, "partition-progress.private.json"), "utf8"));
    expect(facts.leaves[0].fromDate).toBeNull();
    expect(facts.leaves[1].toDate).toBeNull();
    expect(result).not.toHaveProperty("qualified");
  });
  it("holds a residual excluded by date filters instead of repairing the count", async () => {
    const rows = twoDays();
    const fetchImpl = source(rows, (data, request) => {if (request.fromDate) data.totalItems--;});
    await expect(acquireMarylandPartitionedContributionCensus({...scope, outputDirectory: await directory(), fetchImpl: fetchImpl as typeof fetch}))
      .rejects.toMatchObject({code: "count_drift"});
  });
  it("holds an over-cap single calendar day without inventing another source filter", async () => {
    const rows = Array.from({length: 10001}, (_, i) => row(i + 1, "2026-08-18"));
    await expect(acquireMarylandPartitionedContributionCensus({...scope, outputDirectory: await directory(), fetchImpl: source(rows) as typeof fetch}))
      .rejects.toMatchObject({code: "date_scope"});
  });
  it("holds a changed closing source occurrence even when totals stay equal", async () => {
    const fetchImpl = source([row(1, "2026-08-18")], (data, _request, call) => {if (call >= 4) data.items = data.items.map(r => ({...r, transactionAmount: 50}));});
    await expect(acquireMarylandPartitionedContributionCensus({...scope, outputDirectory: await directory(), fetchImpl: fetchImpl as typeof fetch}))
      .rejects.toMatchObject({code: "count_drift"});
  });
  it("rejects duplicate occurrences across complete scopes without deduplication", async () => {
    const rows = twoDays(); rows[5001] = {...rows[0]!, transactionDate: "2026-08-18T00:00:00"};
    await expect(acquireMarylandPartitionedContributionCensus({...scope, outputDirectory: await directory(), fetchImpl: source(rows) as typeof fetch}))
      .rejects.toMatchObject({code: "duplicate_occurrence"});
  });
  it("bounds stalled progress after retaining genuine complete originals", async () => {
    const path = await directory();
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "performance"]});
    let progressEntered!: () => void;
    const entered = new Promise<void>(resolve => {progressEntered = resolve;});
    const held = expect(acquireMarylandPartitionedContributionCensus({...scope, outputDirectory: path,
      fetchImpl: source([row(1, "2026-08-18")]) as typeof fetch, totalTimeoutMs: 100,
      onProgress: () => {progressEntered(); return new Promise(() => {});}})).rejects.toMatchObject({code: "timeout"});
    // Advance the unchanged deadline only after this observer is actually stalled;
    // local filesystem/CPU contention cannot turn this into a pre-capture test.
    await entered;
    await vi.advanceTimersByTimeAsync(100);
    await held;
    expect(JSON.parse(await readFile(join(path, "scope-001", "page-0001.original.json"), "utf8")).data.totalItems).toBe(1);
  });
  it("reports request-budget exhaustion after preserving originals without sending another request", async () => {
    const path = await directory();
    let calls = 0;
    const response = source([row(1, "2026-08-18")]);
    const fetchImpl: typeof fetch = (...args) => {calls++; return response(...args);};
    await expect(acquireMarylandPartitionedContributionCensus({...scope, outputDirectory: path, fetchImpl, maxRequests: 1}))
      .rejects.toMatchObject({code: "page_limit"});
    expect(calls).toBe(1);
    expect(JSON.parse(await readFile(join(path, "opening-desc.original.json"), "utf8")).data.totalItems).toBe(1);
  });
  it("bounds an unresponsive fetch even if the adapter ignores abort", async () => {
    await expect(acquireMarylandPartitionedContributionCensus({...scope, outputDirectory: await directory(),
      fetchImpl: () => new Promise(() => {}), totalTimeoutMs: 50})).rejects.toMatchObject({code: "timeout"});
  });
});


async function saved(rows = [row(1, "2026-08-18"), row(2, "2026-08-18")]) {
  const path = await directory();
  const result = await acquireMarylandPartitionedContributionCensus({
    ...scope,
    outputDirectory: path,
    fetchImpl: source(rows) as typeof fetch,
  });
  return { path, result };
}
async function rewriteProbe(
  path: string,
  name: string,
  mutate: (data: Record<string, any>) => void,
) {
  const original = join(path, `${name}.original.json`),
    capture = `${original}.capture.private.json`;
  const data = JSON.parse(await readFile(original, "utf8"));
  mutate(data);
  const bytes = Buffer.from(JSON.stringify(data));
  await writeFile(original, bytes);
  const metadata = JSON.parse(await readFile(capture, "utf8"));
  metadata.sha256 = createHash("sha256").update(bytes).digest("hex");
  metadata.byteCount = bytes.length;
  await writeFile(capture, JSON.stringify(metadata));
}
async function rewriteLeaf(
  path: string,
  scopeName: string,
  pageName: string,
  mutate: (data: Record<string, any>) => void,
) {
  const dir = join(path, scopeName),
    original = join(dir, pageName),
    journal = join(dir, "captures.private.jsonl");
  const data = JSON.parse(await readFile(original, "utf8"));
  mutate(data);
  const bytes = Buffer.from(JSON.stringify(data));
  await writeFile(original, bytes);
  const captures = (await readFile(journal, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const metadata = captures.find((c) => c.outputPath === original);
  metadata.sha256 = createHash("sha256").update(bytes).digest("hex");
  metadata.byteCount = bytes.length;
  await writeFile(
    journal,
    captures.map((c) => JSON.stringify(c)).join("\n") + "\n",
  );
}
describe("Maryland saved full partition reconstruction", () => {
  it("rebuilds ordinary splits and unbounded tails without trusting advisory files", async () => {
    const { path, result } = await saved(twoDays());
    await writeFile(join(path, "collection-facts.json"), "not success JSON");
    await writeFile(
      join(path, "partition-progress.private.json"),
      JSON.stringify({ leaves: [], physicalRows: 0, success: true }),
    );
    const read = await readMarylandPartitionedContributionCensus({
      ...scope,
      outputDirectory: path,
    });
    expect(read).toMatchObject({
      declaredRows: 10001,
      physicalRows: 10001,
      completedScopes: 2,
      requestCount: result.requestCount,
      capturedBytes: result.capturedBytes,
    });
    expect(read.rows).toHaveLength(10001);
    expect(read).not.toHaveProperty("qualified");
    const leafScopes = read.captures.filter((c) =>
      c.outputPath.includes("scope-"),
    );
    expect(leafScopes.some((c) => c.requestBody.fromDate === null)).toBe(true);
    expect(leafScopes.some((c) => c.requestBody.toDate === null)).toBe(true);
    await rm(join(path, "scope-002"), { recursive: true });
    await expect(
      readMarylandPartitionedContributionCensus({
        ...scope,
        outputDirectory: path,
      }),
    ).rejects.toMatchObject({ code: "invalid_capture" });
  });
  it("accepts genuine concurrent leaf page completion without requiring page-number time order", async () => {
    const rows = Array.from({ length: 201 }, (_, i) =>
      row(i + 1, "2026-08-18"),
    );
    const path = await directory();
    const adapter = source(rows);
    await acquireMarylandPartitionedContributionCensus({
      ...scope,
      outputDirectory: path,
      fetchImpl: (async (url, init) => {
        const request = JSON.parse(init!.body as string);
        if (request.pageNumber === 2)
          await new Promise((r) => setTimeout(r, 15));
        return adapter(url, init);
      }) as typeof fetch,
    });
    const result = await readMarylandPartitionedContributionCensus({
      ...scope,
      outputDirectory: path,
    });
    expect(result.physicalRows).toBe(201);
    const leaf = result.captures.filter((c) => c.outputPath.includes("scope-"));
    expect(leaf[1]!.completedAt >= leaf[2]!.completedAt).toBe(true);
  });
  it("rejects changed original bytes and missing pages rather than trusting completed counts", async () => {
    const { path } = await saved();
    await writeFile(join(path, "scope-001", "page-0001.original.json"), "{}");
    await expect(
      readMarylandPartitionedContributionCensus({
        ...scope,
        outputDirectory: path,
      }),
    ).rejects.toMatchObject({ code: "changed_original" });
    const other = await saved();
    await rm(join(other.path, "scope-001", "page-0001.original.json"));
    await expect(
      readMarylandPartitionedContributionCensus({
        ...scope,
        outputDirectory: other.path,
      }),
    ).rejects.toMatchObject({ code: "invalid_capture" });
  });
  it.each(["closing-desc", "closing-asc"])(
    "rejects same-count changed %s financial fields through untouched-row comparisons",
    async (name) => {
      const { path } = await saved();
      await rewriteProbe(path, name, (data) => {
        data.data.items[0].transactionAmount = 50;
      });
      await expect(
        readMarylandPartitionedContributionCensus({
          ...scope,
          outputDirectory: path,
        }),
      ).rejects.toMatchObject({ code: "count_drift" });
    },
  );
  it.each([
    "bodyComplete",
    "httpStatus",
    "errorCode",
    "url",
    "method",
    "outputPath",
    "requestBody",
  ])("rejects invalid probe envelope %s", async (field) => {
    const { path } = await saved();
    const capture = join(
      path,
      "opening-desc.original.json.capture.private.json",
    );
    const data = JSON.parse(await readFile(capture, "utf8"));
    const values: Record<string, unknown> = {
      bodyComplete: false,
      httpStatus: 500,
      errorCode: "failure",
      url: "https://example.invalid/",
      method: "GET",
      outputPath: join(path, "other.json"),
      requestBody: { ...data.requestBody, pageSize: 25 },
    };
    data[field] = values[field];
    await writeFile(capture, JSON.stringify(data));
    await expect(
      readMarylandPartitionedContributionCensus({
        ...scope,
        outputDirectory: path,
      }),
    ).rejects.toMatchObject({ code: "invalid_capture" });
  });
  it("rejects backward closing chronology while keeping leaf concurrency valid", async () => {
    const { path } = await saved();
    const capture = join(
      path,
      "closing-desc.original.json.capture.private.json",
    );
    const data = JSON.parse(await readFile(capture, "utf8"));
    data.startedAt = "2020-01-01T00:00:00.000Z";
    data.completedAt = "2020-01-01T00:00:00.001Z";
    await writeFile(capture, JSON.stringify(data));
    await expect(
      readMarylandPartitionedContributionCensus({
        ...scope,
        outputDirectory: path,
      }),
    ).rejects.toMatchObject({ code: "invalid_capture" });
  });
  it("rejects omitted closing probes and extra source/scope/page files", async () => {
    for (const kind of ["closing", "probe", "scope", "page"]) {
      const { path } = await saved();
      if (kind === "closing") await rm(join(path, "closing-asc.original.json"));
      if (kind === "probe")
        await writeFile(join(path, "split-999-left.original.json"), "{}");
      if (kind === "scope") await mkdir(join(path, "scope-999"));
      if (kind === "page")
        await writeFile(
          join(path, "scope-001", "page-0002.original.json"),
          "{}",
        );
      await expect(
        readMarylandPartitionedContributionCensus({
          ...scope,
          outputDirectory: path,
        }),
      ).rejects.toMatchObject({ code: "invalid_capture" });
    }
  });
  it("rejects wrong split bounds, date gaps and cross-leaf duplicate occurrences", async () => {
    const { path } = await saved(twoDays());
    const capture = join(
      path,
      "split-1-right.original.json.capture.private.json",
    );
    const original = await readFile(capture);
    const data = JSON.parse(original.toString());
    data.requestBody.fromDate = "2025-01-01";
    await writeFile(capture, JSON.stringify(data));
    await expect(
      readMarylandPartitionedContributionCensus({
        ...scope,
        outputDirectory: path,
      }),
    ).rejects.toMatchObject({ code: "invalid_capture" });
    await writeFile(capture, original);
    const leaf = join(path, "scope-002", "page-0001.original.json");
    const first = JSON.parse(
      await readFile(
        join(path, "scope-001", "page-0001.original.json"),
        "utf8",
      ),
    ).data.items[0];
    const originalLeaf = await readFile(leaf);
    const originalJournal = await readFile(
      join(path, "scope-002", "captures.private.jsonl"),
    );
    await rewriteLeaf(path, "scope-002", "page-0001.original.json", (d) => {
      d.data.items[0].transactionDate = "2000-01-01T00:00:00";
    });
    await expect(
      readMarylandPartitionedContributionCensus({
        ...scope,
        outputDirectory: path,
      }),
    ).rejects.toThrow();
    await writeFile(leaf, originalLeaf);
    await writeFile(
      join(path, "scope-002", "captures.private.jsonl"),
      originalJournal,
    );
    await rewriteLeaf(path, "scope-002", "page-0001.original.json", (d) => {
      d.data.items[0] = {
        ...first,
        transactionDate: d.data.items[0].transactionDate,
      };
    });
    await expect(
      readMarylandPartitionedContributionCensus({
        ...scope,
        outputDirectory: path,
      }),
    ).rejects.toMatchObject({ code: "duplicate_occurrence" });
  });
  it("rejects malformed JSON/UTF8 with static safe errors", async () => {
    const { path } = await saved();
    await writeFile(
      join(path, "opening-desc.original.json.capture.private.json"),
      Buffer.from([255]),
    );
    await expect(
      readMarylandPartitionedContributionCensus({
        ...scope,
        outputDirectory: path,
      }),
    ).rejects.toMatchObject({ code: "invalid_capture" });
  });
  it("enforces total request and byte bounds instead of returning a partial union", async () => {
    const { path } = await saved();
    await expect(
      readMarylandPartitionedContributionCensus({
        ...scope,
        outputDirectory: path,
        maxRequests: 1,
      }),
    ).rejects.toMatchObject({ code: "page_limit" });
    await expect(
      readMarylandPartitionedContributionCensus({
        ...scope,
        outputDirectory: path,
        maxTotalBytes: 1,
      }),
    ).rejects.toMatchObject({ code: "byte_limit" });
  });
  it("holds a changed split sibling count instead of trusting advisory leaves", async () => {
    const { path } = await saved(twoDays());
    await rewriteProbe(path, "split-1-left", (data) => {
      data.data.totalItems++;
    });
    await expect(
      readMarylandPartitionedContributionCensus({
        ...scope,
        outputDirectory: path,
      }),
    ).rejects.toMatchObject({ code: "count_drift" });
  });
  it("projects only the closed owner/cycle contract during acquisition despite untyped extra filters", async () => {
    const path = await directory();
    const input = {
      ...scope,
      outputDirectory: path,
      fetchImpl: source([
        row(1, "2024-01-01"),
        row(2, "2026-08-18"),
      ]) as typeof fetch,
      isReturn: true,
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
      sortType: "asc",
      pageSize: 10,
    };
    const result = await acquireMarylandPartitionedContributionCensus(input);
    expect(result.physicalRows).toBe(2);
    const opening = JSON.parse(
      await readFile(
        join(path, "opening-desc.original.json.capture.private.json"),
        "utf8",
      ),
    );
    expect(opening.requestBody).toMatchObject({
      fromDate: null,
      toDate: null,
      isReturn: null,
      sortType: "desc",
      pageSize: 100,
    });
    const saved = await readMarylandPartitionedContributionCensus({
      ...scope,
      outputDirectory: path,
    });
    expect(saved.physicalRows).toBe(2);
    expect(saved.captures.every((c) => c.requestBody.isReturn === null)).toBe(
      true,
    );
    expect(
      saved.captures.every(
        (c) =>
          c.requestBody.sortType ===
          (c.outputPath.endsWith("-asc.original.json") ? "asc" : "desc"),
      ),
    ).toBe(true);
    const leaf = saved.captures.filter((c) => c.outputPath.includes("scope-"));
    expect(
      leaf.every(
        (c) =>
          c.requestBody.fromDate === null &&
          c.requestBody.toDate === null &&
          c.requestBody.sortType === "desc",
      ),
    ).toBe(true);
  });
  it("cannot reinterpret an ordinary saved partition with untyped return/date/sort overrides", async () => {
    const { path } = await saved([row(1, "2024-01-01"), row(2, "2026-08-18")]);
    const input = {
      ...scope,
      outputDirectory: path,
      isReturn: true,
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
      sortType: "asc",
      pageSize: 10,
    };
    const result = await readMarylandPartitionedContributionCensus(input);
    expect(result.physicalRows).toBe(2);
    expect(result.captures[0]!.requestBody).toMatchObject({
      fromDate: null,
      toDate: null,
      isReturn: null,
      sortType: "desc",
      pageSize: 100,
    });
  });
});
