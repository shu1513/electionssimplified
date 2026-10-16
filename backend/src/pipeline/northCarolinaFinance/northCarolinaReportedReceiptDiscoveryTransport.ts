import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createNcsbeTransport,
  DEFAULT_NCSBE_USER_AGENT,
  ncsbeCommitteeSearchUrl,
  type NcsbeTransport,
} from "./northCarolinaNcsbeClient.js";
import { parseNcsbeCommitteeSearchPage } from "./northCarolinaNcsbeParsers.js";
import {
  NORTH_CAROLINA_REPORTED_RECEIPT_LIMITS as LIMITS,
  NorthCarolinaReportedReceiptSourceError,
} from "./northCarolinaReportedReceiptSourceCache.js";

type Original = {
  ordinal: number;
  file: string;
  url: string;
  status: number;
  eof: boolean;
  byteSize: number;
  sha256: string;
  startedAt: string;
  completedAt: string;
};

/** A bounded transport for one receiver-year discovery by the real discovery
 * function; its request, byte and duration limits cover that one capture.
 * Failed responses remain private diagnostics, never financial acceptance. A
 * first failure latches before legacy discovery can make its committee-name
 * fallback call.
 */
export function createNorthCarolinaReportedReceiptDiscoveryTransport(input: { cacheDir: string }): NcsbeTransport {
  if (!input || typeof input.cacheDir !== "string" || input.cacheDir.trim() === "") throw new NorthCarolinaReportedReceiptSourceError("invalid_scope");
  const cacheDir = resolve(input.cacheDir), recorded = join(cacheDir, "recorded-source"), originalsDir = join(recorded, "originals");
  const originals: Original[] = [];
  const cookies = new Map<string, string>();
  let initialization: Promise<void> | undefined;
  let stopped = false, requests = 0, totalBytes = 0;
  let captureStart: number | undefined;
  function unavailable(): never { stopped = true; throw new NorthCarolinaReportedReceiptSourceError(); }
  async function initialize(): Promise<void> {
    initialization ??= (async () => {
      await mkdir(cacheDir, { recursive: true, mode: 0o700 });
      const stat = await lstat(cacheDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) unavailable();
      await chmod(cacheDir, 0o700);
      // This factory belongs to one unique ordinary pass directory. Existing
      // originals and journals are never overwritten by a later factory.
      await mkdir(recorded, { mode: 0o700 });
      await mkdir(originalsDir, { mode: 0o700 });
    })();
    await initialization;
  }
  function validateUrl(url: string): void {
    if (typeof url !== "string" || url.length > 8192 || /[\u0000-\u0020\\#]/.test(url)) unavailable();
    const parsed = new URL(url), name = parsed.searchParams.get("name");
    if (name === null || url !== ncsbeCommitteeSearchUrl(name)) unavailable();
  }
  async function retain(input: { url: string; status: number; eof: boolean; bytes: Buffer; startedAt: Date; completedAt: Date }): Promise<void> {
    const ordinal = originals.length + 1;
    const original: Original = { ordinal, file: `originals/${String(ordinal).padStart(4, "0")}.raw`,
      url: input.url, status: input.status, eof: input.eof, byteSize: input.bytes.length,
      sha256: createHash("sha256").update(input.bytes).digest("hex"),
      startedAt: input.startedAt.toISOString(), completedAt: input.completedAt.toISOString() };
    await writeFile(join(recorded, original.file), input.bytes, { flag: "wx", mode: 0o600 });
    originals.push(original);
    const temporary = join(recorded, `journal-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify({ version: 1, originals }), { flag: "wx", mode: 0o600 });
    await rename(temporary, join(recorded, "capture-journal.json"));
  }
  const paced = createNcsbeTransport({
    maxAttempts: 1, spacingMs: LIMITS.requestSpacingMs,
    fetch: async (url) => {
      if (stopped) return unavailable();
      try {
        if (++requests > LIMITS.maxRequests) unavailable();
        const now = Date.now(); captureStart ??= now;
        const remaining = LIMITS.maxCaptureMs - (now - captureStart);
        if (remaining <= 0) unavailable();
        const startedAt = new Date(now);
        const headers: Record<string, string> = { "User-Agent": DEFAULT_NCSBE_USER_AGENT, Accept: "*/*" };
        if (cookies.size) headers.Cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
        let response: Response;
        try {
          response = await fetch(url, { method: "GET", redirect: "manual", headers,
            signal: AbortSignal.timeout(Math.min(remaining, LIMITS.requestTimeoutMs)) });
        } catch {
          await retain({ url, status: 0, eof: false, bytes: Buffer.alloc(0), startedAt, completedAt: new Date() });
          return unavailable();
        }
        const reader = response.body?.getReader(), chunks: Buffer[] = [];
        let eof = !reader, failed = false, byteSize = 0;
        if (reader) {
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) { eof = true; break; }
              const retained = Math.max(0, Math.min(next.value.byteLength, LIMITS.maxBodyBytes - byteSize, LIMITS.maxTotalBytes - totalBytes));
              if (retained) {
                chunks.push(Buffer.from(next.value.subarray(0, retained)));
                byteSize += retained; totalBytes += retained;
              }
              if (retained !== next.value.byteLength || Date.now() - captureStart > LIMITS.maxCaptureMs) { failed = true; break; }
            }
          } catch { failed = true; }
          if (!eof) await reader.cancel().catch(() => {});
        }
        const completedAt = new Date(), bytes = Buffer.concat(chunks);
        // Persist bytes before status, redirect, UTF-8 or parser rejection.
        await retain({ url, status: response.status, eof, bytes, startedAt, completedAt });
        const declaredLength = response.headers.get("content-length");
        if (failed || !eof || response.status !== 200 || response.redirected || (response.url !== "" && response.url !== url)
          || bytes.length === 0 || completedAt.getTime() - startedAt.getTime() > LIMITS.requestTimeoutMs
          || completedAt.getTime() - captureStart > LIMITS.maxCaptureMs
          || (declaredLength !== null && !response.headers.get("content-encoding")
            && (!/^\d+$/.test(declaredLength) || Number(declaredLength) !== bytes.length))) unavailable();
        const body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        parseNcsbeCommitteeSearchPage(body);
        for (const setCookie of response.headers.getSetCookie()) {
          const pair = setCookie.split(";", 1)[0]!, separator = pair.indexOf("=");
          if (separator > 0) cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
        }
        return { status: response.status, body };
      } catch { return unavailable(); }
    },
  });
  return {
    fetchText: async (url, form) => {
      if (stopped) return unavailable();
      try {
        if (form !== undefined) unavailable();
        validateUrl(url);
        await initialize();
        return await paced.fetchText(url);
      } catch { return unavailable(); }
    },
  };
}
