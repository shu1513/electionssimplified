import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { acquireMarylandPublicContributionCensus } from "./marylandPublicContributionCensus.js";
import {
  buildMarylandPublicContributionRequest, decodeMarylandPublicContributionPage,
  fetchMarylandPublicContributionPage, marylandPublicContributionOccurrenceKey,
  type MarylandPublicContributionCapture,
} from "./marylandPublicContributionClient.js";

type Scope = {fromDate: string | null; toDate: string | null};
export class MarylandPartitionedContributionError extends Error {
  constructor(public readonly code: "invalid_request" | "count_drift" | "date_scope" |
    "duplicate_occurrence" | "page_limit" | "byte_limit" | "timeout" | "changed_original") {
    super(`Maryland partitioned receipt census: ${code}`);
  }
}
const fail = (code: ConstructorParameters<typeof MarylandPartitionedContributionError>[0]): never => {
  throw new MarylandPartitionedContributionError(code);
};
const dayMs = 86_400_000;
function day(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T00:00:00$/.test(value)) return fail("date_scope");
  const result = value.slice(0, 10);
  if (result.startsWith("0000") || !Number.isFinite(Date.parse(result)) ||
    new Date(result).toISOString().slice(0, 10) !== result) return fail("date_scope");
  return result;
}

/** Complete disjoint date scopes around the observed 10,000-row paging window.
 * Outer tails remain unbounded. This grants acquisition, never financial or
 * report-currentness authority. Every original is retained, including failure. */
export async function acquireMarylandPartitionedContributionCensus(input: {
  filerRegistrationGuid: string; electionCycle: string; outputDirectory: string;
  fetchImpl?: typeof fetch; totalTimeoutMs?: number; maxRequests?: number;
  maxTotalBytes?: number;
  onProgress?: (facts: {completedScopes: number; physicalRows: number; declaredRows: number}) => void | Promise<void>;
}) {
  const base = buildMarylandPublicContributionRequest({...input, pageNumber: 1, pageSize: 100});
  const directory = resolve(input.outputDirectory);
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.totalTimeoutMs ?? 60 * 60 * 1000;
  const maxRequests = input.maxRequests ?? 1500;
  const maxTotalBytes = input.maxTotalBytes ?? 512 * 1024 * 1024;
  const onProgress = input.onProgress;
  if (!input.outputDirectory?.trim() || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000 ||
    !Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 1500 ||
    !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1 || maxTotalBytes > 1024 * 1024 * 1024)
    fail("invalid_request");
  await mkdir(directory, {mode: 0o700});
  const startedAt = new Date().toISOString(), deadlineAt = performance.now() + timeoutMs;
  const controller = new AbortController();
  let requestCount = 0, capturedBytes = 0, completedScopes = 0, physicalRows = 0, serial = 0;
  let budgetFailure: MarylandPartitionedContributionError | undefined;
  let rejectDeadline!: (error: MarylandPartitionedContributionError) => void;
  const deadline = new Promise<never>((_, reject) => {rejectDeadline = reject;});
  void deadline.catch(() => {});
  const check = () => {if (performance.now() >= deadlineAt || controller.signal.aborted) fail("timeout");};
  const timer = setTimeout(() => {
    controller.abort(); rejectDeadline(new MarylandPartitionedContributionError("timeout"));
  }, timeoutMs);
  const boundedFetch: typeof fetch = (url, init) => {
    check();
    if (requestCount >= maxRequests) {
      budgetFailure = new MarylandPartitionedContributionError("page_limit");
      throw budgetFailure;
    }
    requestCount++;
    return Promise.race([fetchImpl(url, {...init, signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])])}), deadline]);
  };
  const occurrences = new Set<string>();
  const leaves: Array<Scope & {declaredRows: number; directory: string}> = [];
  const tree: Array<Scope & {count: number; name: string}> = [];
  async function probe(scope: Scope, sortType: "asc" | "desc", name: string) {
    check();
    const request = buildMarylandPublicContributionRequest({...base, ...scope, sortType});
    const path = join(directory, `${name}.original.json`);
    const result = await fetchMarylandPublicContributionPage({...request, outputPath: path, fetchImpl: boundedFetch,
      timeoutMs: Math.max(1, Math.min(30000, Math.floor(deadlineAt - performance.now()))),
      onCapture: async capture => {
        capturedBytes += capture.byteCount;
        await writeFile(`${path}.capture.private.json`, JSON.stringify(capture), {mode: 0o600, flag: "wx"});
      }});
    check();
    if (capturedBytes > maxTotalBytes) fail("byte_limit");
    const raw = await readFile(path);
    if (raw.length !== result.capture.byteCount || createHash("sha256").update(raw).digest("hex") !== result.capture.sha256)
      fail("changed_original");
    const decoded = decodeMarylandPublicContributionPage(JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(raw)), request);
    tree.push({...scope, count: decoded.totalItems, name});
    return decoded;
  }
  try {
    const unrestricted: Scope = {fromDate: null, toDate: null};
    const opening = await probe(unrestricted, "desc", "opening-desc");
    const oldest = await probe(unrestricted, "asc", "opening-asc");
    if (opening.totalItems !== oldest.totalItems) fail("count_drift");
    const declaredRows = opening.totalItems;
    const earliest = declaredRows ? day(oldest.rows[0]?.transactionDate) : "1970-01-01";
    const latest = declaredRows ? day(opening.rows[0]?.transactionDate) : earliest;
    if (earliest > latest) fail("date_scope");
    async function visit(scope: Scope, count: number): Promise<void> {
      check();
      if (count > 10_000) {
        const lower = Date.parse(scope.fromDate ?? earliest), upper = Date.parse(scope.toDate ?? latest);
        if (lower >= upper) fail("date_scope");
        const middle = lower + Math.floor((upper - lower) / dayMs / 2) * dayMs;
        const left = {...scope, toDate: new Date(middle).toISOString().slice(0, 10)};
        const right = {...scope, fromDate: new Date(middle + dayMs).toISOString().slice(0, 10)};
        const leftPage = await probe(left, "desc", `split-${++serial}-left`);
        const rightPage = await probe(right, "desc", `split-${serial}-right`);
        if (leftPage.totalItems + rightPage.totalItems !== count) fail("count_drift");
        await visit(left, leftPage.totalItems);
        await visit(right, rightPage.totalItems);
        return;
      }
      const leafDirectory = join(directory, `scope-${String(leaves.length + 1).padStart(3, "0")}`);
      const collection = await acquireMarylandPublicContributionCensus({...base, ...scope,
        outputDirectory: leafDirectory, fetchImpl: boundedFetch, maxPages: 100, concurrency: 4,
        totalTimeoutMs: Math.max(1, Math.floor(deadlineAt - performance.now())),
        maxTotalBytes: Math.max(1, maxTotalBytes - capturedBytes)});
      capturedBytes += collection.capturedBytes;
      check();
      if (capturedBytes > maxTotalBytes) fail("byte_limit");
      if (collection.declaredRows !== count) fail("count_drift");
      const journal = (await readFile(collection.journalPath, "utf8")).trim().split("\n");
      for (const line of journal) {
        const capture = JSON.parse(line) as MarylandPublicContributionCapture;
        const raw = await readFile(capture.outputPath);
        if (raw.length !== capture.byteCount || createHash("sha256").update(raw).digest("hex") !== capture.sha256)
          fail("changed_original");
        const page = decodeMarylandPublicContributionPage(JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(raw)), capture.requestBody);
        for (const row of page.rows) {
          const key = marylandPublicContributionOccurrenceKey(row);
          if (occurrences.has(key)) fail("duplicate_occurrence");
          occurrences.add(key);
        }
      }
      leaves.push({...scope, declaredRows: count, directory: leafDirectory});
      completedScopes++; physicalRows += collection.physicalRows;
      await writeFile(join(directory, "partition-progress.private.json"), JSON.stringify({tree, leaves, physicalRows}), {mode: 0o600});
      await Promise.race([Promise.resolve().then(() => onProgress?.({completedScopes, physicalRows, declaredRows})), deadline]);
    }
    await visit(unrestricted, declaredRows);
    if (physicalRows !== declaredRows || occurrences.size !== declaredRows) fail("count_drift");
    const closing = await probe(unrestricted, "desc", "closing-desc");
    const closingOldest = await probe(unrestricted, "asc", "closing-asc");
    for (const [first, last] of [[opening, closing], [oldest, closingOldest]]) {
      if (first!.totalItems !== last!.totalItems || JSON.stringify(first!.rows) !== JSON.stringify(last!.rows)) fail("count_drift");
    }
    check();
    const result = {outputDirectory: directory, startedAt, completedAt: new Date().toISOString(),
      declaredRows, physicalRows, completedScopes, requestCount, capturedBytes};
    await writeFile(join(directory, "collection-facts.json"), JSON.stringify(result), {mode: 0o600, flag: "wx"});
    check();
    return Object.freeze(result);
  } catch (error) {
    if (performance.now() >= deadlineAt || controller.signal.aborted) fail("timeout");
    if (budgetFailure) throw budgetFailure;
    throw error;
  } finally {clearTimeout(timer); controller.abort();}
}
