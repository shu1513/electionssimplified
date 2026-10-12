import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { FloridaProcessedRawEvidence } from "./floridaProcessedFinanceSource.js";

export type FloridaFinanceRawRequest = {
  url: string;
  method: "GET" | "POST";
  financeFields: Readonly<Record<string, string>> | null;
};
type CachedMetadata = Omit<FloridaProcessedRawEvidence, "bytesRaw"> & {
  version: 1;
  rawPath: string;
  bytes: number;
  requestKey: string;
};

const DOS = "dos.elections.myflorida.com";
const EFS = "efs.dos.state.fl.us";
const POST_PATHS = new Set([
  "/cgi-bin/TreSel.exe", "/cgi-bin/TreFin.exe", "/cgi-bin/contrib.exe", "/cgi-bin/expend.exe",
  "/committees/ComLkupByName.asp",
  "/candidates/CanList.asp",
  "/candidates/canlist.asp", "/candidates/extractCanList.asp",
]);
const GET_PATHS = new Set([
  "/candidates/", "/candidates/downloadcanlist.asp", "/candidates/CanDetail.asp", "/committees/ComDetail.asp",
  "/campaign-docs/", "/campaign-docs/PDFHandler.ashx",
]);
const sha = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

function requestKey(request: FloridaFinanceRawRequest): string {
  const fields = request.financeFields && Object.entries(request.financeFields).sort(([a], [b]) => a.localeCompare(b));
  return sha(JSON.stringify([request.url, request.method, fields]));
}
function validateRequest(request: FloridaFinanceRawRequest): void {
  if (request.method !== "GET" && request.method !== "POST")
    throw new Error("Unsupported Florida public finance method");
  const url = new URL(request.url);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash)
    throw new Error("Florida source requires a public official HTTPS URL");
  const get = request.method === "GET";
  if (url.hostname === DOS) {
    if (get ? !GET_PATHS.has(url.pathname) : !POST_PATHS.has(url.pathname))
      throw new Error("Unsupported Florida public finance endpoint");
  } else if (!(get && url.hostname === EFS && url.pathname === "/PrintReportSubmitted.aspx")) {
    throw new Error("Unsupported Florida public finance endpoint");
  }
  const keys = [...url.searchParams.keys()];
  if (get) {
    if (url.pathname === "/campaign-docs/PDFHandler.ashx") {
      if (keys.length !== 2 || !/^\d{1,2}\/\d{1,2}\/\d{2}(?:\d{2})?$/.test(url.searchParams.get("AcctType") ?? "")
          || !/^[1-9]\d*$/.test(url.searchParams.get("TrackNum") ?? ""))
        throw new Error("Invalid Florida public document scope");
    } else {
      const expected = url.hostname === EFS ? ["AcctNum", "SeqNum"]
        : url.pathname === "/candidates/" || url.pathname === "/candidates/downloadcanlist.asp" ? [] : ["account"];
      if (keys.length !== expected.length || expected.some((key) => !/^[1-9]\d*$/.test(url.searchParams.get(key) ?? "")))
        throw new Error("Invalid Florida public finance query scope");
    }
  } else if (url.search) throw new Error("Invalid Florida public finance query scope");
  if (get ? request.financeFields !== null : !request.financeFields)
    throw new Error("Invalid Florida finance request fields");
  if (request.financeFields) {
    for (const [key, value] of Object.entries(request.financeFields)) {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.length > 500
          || /token|password|secret|cookie|authorization|viewstate|validation/i.test(key))
        throw new Error("Invalid or credential-bearing Florida finance request field");
    }
  }
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

/** Saved openings retain their genuine source times. Refresh bypasses them.
 * Closing calls omit savedFirst and always acquire new public source bytes.
 * A cache entry is evidence for a verifier, never financial acceptance itself.
 */
export function createFloridaFinanceRawSourceClient(options: {
  cacheDir: string;
  refresh?: boolean;
  fetchFn?: typeof fetch;
  minIntervalMs?: number;
  maxRequests?: number;
  maxResponseBytes?: number;
  timeoutMs?: number;
}) {
  const root = resolve(options.cacheDir);
  const generationDirectory = resolve(root, "generations", randomUUID());
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const interval = options.minIntervalMs ?? 1000;
  const budget = options.maxRequests ?? 500;
  const cap = options.maxResponseBytes ?? 4 * 1024 * 1024;
  const timeout = options.timeoutMs ?? 30000;
  if (!Number.isInteger(interval) || interval < 0 || !Number.isInteger(budget) || budget < 1
      || !Number.isInteger(cap) || cap < 1 || !Number.isInteger(timeout) || timeout < 1)
    throw new Error("Invalid Florida finance source bounds");
  let requests = 0;
  let lastStarted = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const journal: Record<string, unknown>[] = [];

  async function saveJournal(): Promise<void> {
    await mkdir(generationDirectory, { recursive: true });
    const temporary = resolve(generationDirectory, `requests.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(journal, null, 2) + "\n");
    await rename(temporary, resolve(generationDirectory, "requests.json"));
  }

  async function saved(request: FloridaFinanceRawRequest, key: string): Promise<FloridaProcessedRawEvidence | null> {
    try {
      const pointer = JSON.parse(await readFile(resolve(root, "latest", `${key}.json`), "utf8")) as { metadataPath: string };
      if (typeof pointer.metadataPath !== "string" || !contained(root, pointer.metadataPath)) return null;
      const meta = JSON.parse(await readFile(pointer.metadataPath, "utf8")) as CachedMetadata;
      if (meta.version !== 1 || meta.requestKey !== key || meta.status !== 200 || !contained(root, meta.rawPath)
          || !Number.isSafeInteger(meta.bytes) || meta.bytes < 0 || meta.bytes > cap
          || !Number.isFinite(Date.parse(meta.startedAt)) || !Number.isFinite(Date.parse(meta.completedAt))
          || Date.parse(meta.startedAt) > Date.parse(meta.completedAt)
          || requestKey(meta) !== requestKey(request) || typeof meta.contentType !== "string") return null;
      const bytesRaw = await readFile(meta.rawPath);
      if (bytesRaw.length !== meta.bytes || sha(bytesRaw) !== meta.sha256) return null;
      journal.push({ kind: "saved_opening", sourceMetadataPath: pointer.metadataPath, requestKey: key,
        sha256: meta.sha256, originalStartedAt: meta.startedAt, originalCompletedAt: meta.completedAt });
      await saveJournal();
      const { version: _version, rawPath: _path, bytes: _bytes, requestKey: _key, ...evidence } = meta;
      return { ...evidence, financeFields: evidence.financeFields && { ...evidence.financeFields }, bytesRaw };
    } catch { return null; }
  }

  async function acquire(request: FloridaFinanceRawRequest, savedFirst: boolean): Promise<FloridaProcessedRawEvidence> {
    validateRequest(request);
    const key = requestKey(request);
    if (savedFirst && !options.refresh) {
      const prior = await saved(request, key);
      if (prior) return prior;
    }
    if (requests >= budget) throw new Error("Florida finance source request budget exhausted");
    const waitMs = Math.max(0, lastStarted + interval - Date.now());
    if (waitMs) await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
    requests++;
    const startedAt = new Date().toISOString();
    lastStarted = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    timer.unref?.();
    const base = { url: request.url, method: request.method, financeFields: request.financeFields && { ...request.financeFields }, startedAt };
    let status: number | null = null;
    try {
      const response = await fetchFn(request.url, {
        method: request.method, redirect: "error", signal: controller.signal,
        headers: {
          accept: "text/html,text/tab-separated-values,text/plain,*/*",
          "user-agent": "Mozilla/5.0 (compatible; public campaign finance research)",
          ...(request.method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        },
        body: request.financeFields ? new URLSearchParams(request.financeFields).toString() : undefined,
      });
      status = response.status;
      const declaredLength = response.headers.get("content-length");
      if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > cap) {
        await response.body?.cancel();
        throw new Error("Florida finance response exceeds byte cap");
      }
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const reader = response.body?.getReader();
      if (reader) {
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.length;
            if (bytes > cap) {
              await reader.cancel();
              throw new Error("Florida finance response exceeds byte cap");
            }
            chunks.push(next.value);
          }
        } finally { reader.releaseLock(); }
      }
      const bytesRaw = Buffer.concat(chunks);
      const evidence: FloridaProcessedRawEvidence = {
        ...base, bytesRaw, sha256: sha(bytesRaw), status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        completedAt: new Date().toISOString(),
      };
      await mkdir(generationDirectory, { recursive: true });
      const prefix = String(requests).padStart(4, "0");
      const rawPath = resolve(generationDirectory, `${prefix}.raw`);
      const metadataPath = resolve(generationDirectory, `${prefix}.json`);
      await writeFile(rawPath, bytesRaw, { flag: "wx" });
      const { bytesRaw: _raw, ...metadata } = evidence;
      const meta: CachedMetadata = { version: 1, ...metadata, bytes: bytesRaw.length, rawPath, requestKey: key };
      await writeFile(metadataPath, JSON.stringify(meta, null, 2) + "\n", { flag: "wx" });
      journal.push({ kind: "fresh", ...meta, metadataPath });
      await saveJournal();
      // Errors never replace a previously successful saved opening.
      if (response.status === 200) {
        const directory = resolve(root, "latest");
        await mkdir(directory, { recursive: true });
        const temporary = resolve(directory, `${key}.${randomUUID()}.tmp`);
        await writeFile(temporary, JSON.stringify({ metadataPath }) + "\n", { flag: "wx" });
        await rename(temporary, resolve(directory, `${key}.json`));
      }
      return evidence;
    } catch (error) {
      journal.push({ kind: "failed", ...base, status, completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Unknown source acquisition error" });
      await saveJournal();
      throw error;
    } finally { clearTimeout(timer); }
  }

  return {
    generationDirectory,
    get capturedRequestCount() { return requests; },
    request(request: FloridaFinanceRawRequest, input: { savedFirst?: boolean } = {}): Promise<FloridaProcessedRawEvidence> {
      // Clone request fields before awaiting shared rate pacing.
      const captured = { ...request, financeFields: request.financeFields && { ...request.financeFields } };
      const task = queue.then(() => acquire(captured, input.savedFirst === true));
      queue = task.catch(() => undefined);
      return task;
    },
  };
}
