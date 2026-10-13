import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  buildMarylandPublicContributionRequest,
  decodeMarylandPublicContributionPage,
  fetchMarylandPublicContributionPage,
  marylandPublicContributionOccurrenceKey,
} from "./marylandPublicContributionClient.js";

type PageInput = Parameters<typeof fetchMarylandPublicContributionPage>[0];
export class MarylandPublicContributionCensusError extends Error {
  constructor(public readonly code: "invalid_request" | "page_limit" | "count_drift" |
    "duplicate_occurrence" | "total_byte_limit" | "census_timeout" | "changed_original") {
    super(`Maryland native receipt census: ${code}`);
    this.name = "MarylandPublicContributionCensusError";
  }
}
const fail = (code: ConstructorParameters<typeof MarylandPublicContributionCensusError>[0]): never => {
  throw new MarylandPublicContributionCensusError(code);
};

/** A complete observed grid collection, not a current financial ledger. All
 * old/active/amended source rows remain in private originals for qualification. */
export async function acquireMarylandPublicContributionCensus(input:
  Omit<PageInput, "outputPath" | "pageNumber" | "pageSize" | "onCapture"> & {
    outputDirectory: string;
    maxPages?: number;
    concurrency?: number;
    totalTimeoutMs?: number;
    maxTotalBytes?: number;
    onProgress?: (progress: {completedPages: number; requestedPages: number; physicalRows: number; declaredRows: number}) => void | Promise<void>;
  },
) {
  const scope = buildMarylandPublicContributionRequest({...input, pageNumber: 1, pageSize: 100});
  const maxPages = input.maxPages ?? 1500;
  const concurrency = input.concurrency ?? 4;
  const totalTimeoutMs = input.totalTimeoutMs ?? 60 * 60 * 1000;
  const maxTotalBytes = input.maxTotalBytes ?? 512 * 1024 * 1024;
  const timeoutMs = input.timeoutMs ?? 30_000;
  const maxBytes = input.maxBytes ?? 4 * 1024 * 1024;
  const fetchImpl = input.fetchImpl ?? fetch;
  const onProgress = input.onProgress;
  if (
    !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1500 ||
    !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4 ||
    !Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs < 1 || totalTimeoutMs > 60 * 60 * 1000 ||
    !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1 || maxTotalBytes > 1024 * 1024 * 1024 ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 ||
    !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 * 1024 ||
    typeof input.outputDirectory !== "string" || !input.outputDirectory.trim()
  ) fail("invalid_request");
  const directory = resolve(input.outputDirectory);
  await mkdir(directory, {mode: 0o700});
  const journalPath = join(directory, "captures.private.jsonl");
  const journal = await open(journalPath, "wx", 0o600);
  await journal.chmod(0o600);
  const controller = new AbortController();
  let timedOut = false;
  let capturedBytes = 0, completedPages = 0, physicalRows = 0;
  let declaredRows: number | undefined, requestedPages = 1;
  let nextPage = 2;
  const identities = new Set<string>();
  const startedAt = new Date().toISOString();
  const deadlineAt = performance.now() + totalTimeoutMs;
  const expired = () => timedOut || performance.now() >= deadlineAt;
  let failure: unknown;
  let journalQueue: Promise<unknown> = Promise.resolve();
  let rejectDeadline!: (error: MarylandPublicContributionCensusError) => void;
  const deadline = new Promise<never>((_, reject) => {rejectDeadline = reject;});
  // The timer can fire during file sync, where no progress race is pending.
  void deadline.catch(() => {});
  const timer = setTimeout(() => {
    timedOut = true; controller.abort();
    rejectDeadline(new MarylandPublicContributionCensusError("census_timeout"));
  }, totalTimeoutMs);
  const boundedFetch: typeof fetch = (url, init) => fetchImpl(url, {
    ...init, signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]),
  });
  async function page(pageNumber: number) {
    if (expired()) fail("census_timeout");
    const request = Object.freeze({...scope, pageNumber});
    const result = await fetchMarylandPublicContributionPage({
      ...request, outputPath: join(directory, `page-${String(pageNumber).padStart(4, "0")}.original.json`),
      timeoutMs: Math.min(timeoutMs, Math.max(1, Math.floor(deadlineAt - performance.now()))),
      maxBytes, fetchImpl: boundedFetch,
      onCapture: capture => {
        capturedBytes += capture.byteCount;
        journalQueue = journalQueue.then(() => journal.appendFile(`${JSON.stringify(capture)}\n`));
        return journalQueue.then(() => {});
      },
    });
    if (expired()) fail("census_timeout");
    // In-flight originals settle after the limit; every actual byte is
    // journaled, and the whole collection fails rather than truncating.
    if (capturedBytes > maxTotalBytes) fail("total_byte_limit");
    if (declaredRows === undefined) {
      declaredRows = result.totalItems;
      requestedPages = Math.max(1, Math.ceil(declaredRows / 100));
      if (requestedPages > maxPages) fail("page_limit");
    } else if (result.totalItems !== declaredRows) fail("count_drift");
    const raw = await readFile(result.capture.outputPath);
    if (raw.length !== result.capture.byteCount || createHash("sha256").update(raw).digest("hex") !== result.capture.sha256)
      fail("changed_original");
    const decoded = decodeMarylandPublicContributionPage(JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(raw)), request);
    for (const row of decoded.rows) {
      const key = marylandPublicContributionOccurrenceKey(row);
      if (identities.has(key)) fail("duplicate_occurrence");
      identities.add(key);
    }
    physicalRows += decoded.rows.length;
    completedPages++;
    await Promise.race([
      Promise.resolve().then(() => onProgress?.({completedPages, requestedPages, physicalRows, declaredRows: declaredRows!})),
      deadline,
    ]);
    if (expired()) fail("census_timeout");
  }
  async function worker() {
    while (!failure && nextPage <= requestedPages) {
      const selected = nextPage++;
      try {await page(selected);} catch (error) {failure ??= error; controller.abort();}
    }
  }
  try {
    await page(1);
    await Promise.all(Array.from({length: concurrency}, worker));
    if (failure) throw failure;
    if (expired()) fail("census_timeout");
    if (physicalRows !== declaredRows || completedPages !== requestedPages) fail("count_drift");
    await journalQueue;
    await journal.sync();
    if (expired()) fail("census_timeout");
    return Object.freeze({outputDirectory: directory, journalPath, startedAt,
      completedAt: new Date().toISOString(), declaredRows, physicalRows,
      requestedPages, completedPages, capturedBytes});
  } catch (error) {
    controller.abort();
    if (expired()) fail("census_timeout");
    throw error;
  } finally {
    clearTimeout(timer);
    await journalQueue.catch(() => {});
    await journal.close();
  }
}
