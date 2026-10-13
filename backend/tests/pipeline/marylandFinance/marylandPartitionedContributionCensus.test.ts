import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { acquireMarylandPartitionedContributionCensus } from "../../../src/pipeline/marylandFinance/marylandPartitionedContributionCensus.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const REPORT = "22222222-2222-4222-8222-222222222222";
const directories: string[] = [];
async function directory() {
  const parent = await mkdtemp(join(tmpdir(), "md-partitions-")); directories.push(parent);
  return join(parent, "originals");
}
afterEach(async () => {await Promise.all(directories.splice(0).map(path => rm(path, {recursive: true, force: true})));});
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
    await expect(acquireMarylandPartitionedContributionCensus({...scope, outputDirectory: path,
      fetchImpl: source([row(1, "2026-08-18")]) as typeof fetch, totalTimeoutMs: 100,
      onProgress: () => new Promise(() => {})})).rejects.toMatchObject({code: "timeout"});
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
