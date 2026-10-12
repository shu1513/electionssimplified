import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { OregonPacRawEvidence } from "./oregonVerifiedPacSource.js";
import type { OregonVerifiedRawCapture } from "./oregonVerifiedSourceClient.js";
import { hashOregonVerifiedBytes } from "./oregonVerifiedSourceDecoders.js";

export const DEFAULT_OREGON_VERIFIED_SOURCE_CACHE_DIR = "scratch/oregon-campaign-finance/verified";
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const GENERATION = /^[0-9TZ-]+-[a-f0-9-]{36}$/;
const RECORD = /^\d{6}\.json$/;

function recoverableUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.origin !== "https://secure.sos.state.or.us" || url.username || url.password || url.hash) return false;
    const fields: Record<string, readonly string[]> = {
      "/orestar/gotoPublicTransactionDetail.do": ["tranRsn"],
      "/orestar/ceTransactionHistory.do": ["tranRsn"],
      "/orestar/sooDetail.do": ["cneCommitteeId", "sooRsn"],
    };
    const allowed = Object.hasOwn(fields, url.pathname) ? fields[url.pathname] : undefined;
    const keys = [...url.searchParams.keys()];
    return !!allowed && keys.length === 1 && allowed.includes(keys[0]!)
      && /^[1-9]\d*$/.test(url.searchParams.get(keys[0]!) ?? "");
  } catch { return false; }
}

function validEvidence(value: OregonPacRawEvidence, expectedUrl: string): boolean {
  const request = value?.request;
  return !!request && request.url === expectedUrl && recoverableUrl(expectedUrl)
    && request.method === "GET" && request.status === 200
    && request.requestFields !== null && typeof request.requestFields === "object"
    && Object.keys(request.requestFields).length === 0
    && Number.isFinite(Date.parse(request.startedAt)) && Number.isFinite(Date.parse(request.endedAt))
    && Date.parse(request.startedAt) <= Date.parse(request.endedAt)
    && value.bytes instanceof Uint8Array && value.bytes.length > 0 && value.bytes.length <= MAX_BODY_BYTES
    && request.byteCount === value.bytes.length && HASH.test(request.sha256)
    && hashOregonVerifiedBytes(value.bytes) === request.sha256;
}

/** Durable observations only: saved captures never acquire new network timestamps. */
export async function createOregonVerifiedSourceArtifactCache(cacheDir: string) {
  if (!cacheDir.trim()) throw new Error("Oregon source cache directory is required");
  const root = resolve(cacheDir);
  const generation = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const generationDir = resolve(root, "generations", generation);
  const latestDir = resolve(root, "latest");
  await mkdir(generationDir, { recursive: true });
  await mkdir(latestDir, { recursive: true });
  let sequence = 0;

  async function writeCapture(capture: OregonVerifiedRawCapture): Promise<void> {
    const number = String(++sequence).padStart(6, "0");
    if (sequence > 999999) throw new Error("Oregon source journal request limit exceeded");
    const raw = capture.kind === "public_response" ? capture.evidence : capture;
    const request = { url: raw.request.url, method: raw.request.method,
      requestFields: { ...raw.request.requestFields }, startedAt: raw.request.startedAt,
      endedAt: raw.request.endedAt, status: raw.request.status,
      byteCount: raw.request.byteCount, sha256: raw.request.sha256 };
    let safeUrl = false;
    try {
      const url = new URL(request.url);
      safeUrl = url.origin === "https://secure.sos.state.or.us" && !url.username && !url.password
        && !url.hash && !/;JSESSIONID/i.test(url.pathname)
        && ![...url.searchParams.keys()].some(key => /csrf|cookie|token|authorization|session/i.test(key));
    } catch { /* Invalid request metadata is never persisted. */ }
    if (!safeUrl || Object.keys(request.requestFields).some(key => /csrf|cookie|token|authorization|session/i.test(key))) {
      throw new Error("Oregon source journal rejects credential metadata");
    }
    const bodyFile = capture.kind === "credential_metadata" ? undefined : `${number}.body`;
    const bytes = capture.kind === "public_response" ? Buffer.from(capture.evidence.bytes)
      : capture.kind === "failed_response" ? Buffer.from(capture.bytes) : undefined;
    if (bytes && (bytes.length > MAX_BODY_BYTES || bytes.length !== request.byteCount
      || hashOregonVerifiedBytes(bytes) !== request.sha256)) {
      throw new Error("Oregon source journal body metadata mismatch");
    }
    const metadata = { version: 1, kind: capture.kind, outcome: capture.outcome,
      request, ...(bodyFile ? { bodyFile } : {}),
      ...("failureKind" in capture ? { failureKind: capture.failureKind } : {}) };
    if (bytes) await writeFile(resolve(generationDir, bodyFile!), bytes, { flag: "wx" });
    const record = `${number}.json`;
    await writeFile(resolve(generationDir, record), JSON.stringify(metadata, null, 2), { flag: "wx" });
    if (capture.kind !== "public_response" || !bytes
      || !validEvidence({ bytes, request: request as OregonPacRawEvidence["request"] }, request.url)) return;
    const pointer = resolve(latestDir, `${hashOregonVerifiedBytes(Buffer.from(request.url))}.json`);
    const temporary = `${pointer}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, generation, record }), { flag: "wx" });
    await rename(temporary, pointer);
  }

  async function readSavedPublicGet(url: string): Promise<OregonPacRawEvidence | undefined> {
    if (!recoverableUrl(url)) return undefined;
    try {
      const pointer = resolve(latestDir, `${hashOregonVerifiedBytes(Buffer.from(url))}.json`);
      if ((await stat(pointer)).size > 1024) return undefined;
      const index = JSON.parse(await readFile(pointer, "utf8"));
      if (index.version !== 1 || !GENERATION.test(index.generation) || !RECORD.test(index.record)) return undefined;
      const recordPath = resolve(root, "generations", index.generation, index.record);
      if ((await stat(recordPath)).size > 64 * 1024) return undefined;
      const metadata = JSON.parse(await readFile(recordPath, "utf8"));
      if (metadata.version !== 1 || metadata.kind !== "public_response" || metadata.outcome !== "complete"
        || metadata.bodyFile !== index.record.replace(/\.json$/, ".body")) return undefined;
      const bodyPath = resolve(root, "generations", index.generation, metadata.bodyFile);
      if ((await stat(bodyPath)).size > MAX_BODY_BYTES) return undefined;
      const evidence = { bytes: new Uint8Array(await readFile(bodyPath)), request: metadata.request };
      return validEvidence(evidence, url) ? evidence : undefined;
    } catch { return undefined; }
  }

  return { generationDir, writeCapture, readSavedPublicGet };
}
