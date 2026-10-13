import { createHash } from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  buildMarylandPublicContributionRequest,
  decodeMarylandPublicContributionPage,
  fetchMarylandPublicContributionPage,
  marylandPublicContributionOccurrenceKey,
  type MarylandPublicContributionCapture,
} from "./marylandPublicContributionClient.js";

type PageInput = Parameters<typeof fetchMarylandPublicContributionPage>[0];
export class MarylandPublicContributionCensusError extends Error {
  constructor(public readonly code: "invalid_request" | "page_limit" | "count_drift" |
    "duplicate_occurrence" | "total_byte_limit" | "census_timeout" | "changed_original" | "invalid_capture") {
    super(`Maryland native receipt census: ${code}`);
    this.name = "MarylandPublicContributionCensusError";
  }
}

/** Reads an ordinary saved leaf census, not a caller's success manifest. Every
 * original must match its closed scope and sequential requested page. Rows are
 * transient private source facts; never log or persist their derivatives. This
 * grants no report-currentness, full-partition or financial authority. */
export async function readMarylandPublicContributionCensus(input:
  Pick<PageInput, "filerRegistrationGuid" | "electionCycle" | "fromDate" | "toDate" | "isReturn" | "sortType"> &
  { outputDirectory: string },
) {
  const scope = buildMarylandPublicContributionRequest({ ...input, pageNumber: 1, pageSize: 100 });
  if (typeof input.outputDirectory !== "string" || !input.outputDirectory.trim())
    throw new MarylandPublicContributionCensusError("invalid_request");
  const directory = resolve(input.outputDirectory), journalPath = join(directory, "captures.private.jsonl");
  let journalText: string;
  try {
    const journalStat = await stat(journalPath);
    if (!journalStat.isFile() || journalStat.size < 1 || journalStat.size > 16 * 1024 * 1024)
      throw new Error();
    const bytes = await readFile(journalPath);
    if (bytes.length !== journalStat.size) throw new Error();
    journalText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch { throw new MarylandPublicContributionCensusError("invalid_capture"); }
  if (!journalText.endsWith("\n")) throw new MarylandPublicContributionCensusError("invalid_capture");
  const lines = journalText.slice(0, -1).split("\n");
  if (!lines.length || lines.length > 1500 || lines.some(line => !line))
    throw new MarylandPublicContributionCensusError("invalid_capture");
  const captures: MarylandPublicContributionCapture[] = [];
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const instant = (v: unknown): v is string => typeof v === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && !v.startsWith("0000") &&
    Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
  for (const line of lines) {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { throw new MarylandPublicContributionCensusError("invalid_capture"); }
    if (!object(raw) || !object(raw.requestBody)) throw new MarylandPublicContributionCensusError("invalid_capture");
    const body = raw.requestBody;
    if (!Number.isSafeInteger(body.pageNumber) || (body.pageNumber as number) < 1 ||
      (body.pageNumber as number) > 1500) throw new MarylandPublicContributionCensusError("invalid_capture");
    const expected = { ...scope, pageNumber: body.pageNumber };
    if (Object.keys(body).length !== Object.keys(expected).length || Object.keys(body).some(key =>
      !Object.hasOwn(expected, key) || body[key] !== expected[key as keyof typeof expected]) ||
      raw.url !== "https://api-campaignfinance.maryland.gov/api/PublicGrid/GetContributionList" || raw.method !== "POST" ||
      raw.outputPath !== join(directory, `page-${String(body.pageNumber).padStart(4, "0")}.original.json`) ||
      raw.httpStatus !== 200 || raw.bodyComplete !== true || raw.errorCode !== null ||
      !Number.isSafeInteger(raw.byteCount) || (raw.byteCount as number) < 1 || (raw.byteCount as number) > 4 * 1024 * 1024 ||
      typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.sha256) ||
      !instant(raw.startedAt) || !instant(raw.completedAt) || raw.startedAt > raw.completedAt)
      throw new MarylandPublicContributionCensusError("invalid_capture");
    // Unknown capture extras (including headers) do not enter projected refs.
    captures.push(Object.freeze({ url: raw.url, method: "POST", requestBody: Object.freeze(expected) as typeof scope,
      outputPath: raw.outputPath as string, httpStatus: 200, bodyComplete: true, errorCode: null,
      byteCount: raw.byteCount as number, sha256: raw.sha256, startedAt: raw.startedAt, completedAt: raw.completedAt }));
  }
  captures.sort((a, b) => a.requestBody.pageNumber - b.requestBody.pageNumber);
  const rows: Readonly<Record<string, unknown>>[] = [], identities = new Set<string>();
  let declaredRows: number | undefined, capturedBytes = 0;
  for (const [index, capture] of captures.entries()) {
    if (capture.requestBody.pageNumber !== index + 1) throw new MarylandPublicContributionCensusError("invalid_capture");
    capturedBytes += capture.byteCount;
    if (capturedBytes > 1024 * 1024 * 1024) throw new MarylandPublicContributionCensusError("total_byte_limit");
    let raw: Buffer;
    try {
      const originalStat = await stat(capture.outputPath);
      if (!originalStat.isFile() || originalStat.size !== capture.byteCount) throw new Error();
      raw = await readFile(capture.outputPath);
    } catch { throw new MarylandPublicContributionCensusError("changed_original"); }
    if (raw.length !== capture.byteCount || createHash("sha256").update(raw).digest("hex") !== capture.sha256)
      throw new MarylandPublicContributionCensusError("changed_original");
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
    catch { throw new MarylandPublicContributionCensusError("invalid_capture"); }
    const page = decodeMarylandPublicContributionPage(value, capture.requestBody);
    if (declaredRows === undefined) {
      declaredRows = page.totalItems;
      if (Math.max(1, Math.ceil(declaredRows / 100)) !== captures.length)
        throw new MarylandPublicContributionCensusError("count_drift");
    } else if (declaredRows !== page.totalItems) throw new MarylandPublicContributionCensusError("count_drift");
    for (const row of page.rows) {
      const key = marylandPublicContributionOccurrenceKey(row);
      if (identities.has(key)) throw new MarylandPublicContributionCensusError("duplicate_occurrence");
      identities.add(key); rows.push(row);
    }
  }
  if (rows.length !== declaredRows) throw new MarylandPublicContributionCensusError("count_drift");
  return Object.freeze({ rows: Object.freeze(rows), captures: Object.freeze(captures), declaredRows: declaredRows!,
    physicalRows: rows.length, capturedBytes });
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
