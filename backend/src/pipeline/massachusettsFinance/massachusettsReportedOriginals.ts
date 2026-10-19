import { appendFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { maHash, maHold, maIso } from "./massachusettsReportedCore.js";

export const MA_NATIVE_ORIGIN = "https://api.ocpf.us";
export type MassachusettsOriginalCapture = {
  role: string; file: string; method: "GET"; status: number; contentType: string | null;
  startedAt: string; completedAt: string; bytes: number; sha256: string; eof: boolean;
};
export const maReportedCache = (cache?: string): string => resolve(cache ??
  process.env.MASSACHUSETTS_REPORTED_FINANCE_CACHE_DIR ?? "scratch/massachusetts-reported-finance");
export function maNativeUrl(path: string): string {
  const u = new URL(path, MA_NATIVE_ORIGIN);
  if (u.origin !== MA_NATIVE_ORIGIN || u.username || u.password || u.hash) maHold("source_origin");
  return u.href;
}
export async function maPrivateBytes(path: string, max = 32 * 1024 * 1024): Promise<Buffer> {
  const st = await lstat(path);
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) || st.size > max) maHold("private_original");
  return readFile(path);
}
export async function maOriginalDirectories(cache: string): Promise<string[]> {
  await mkdir(cache, { recursive: true, mode: 0o700 });
  return (await readdir(cache)).filter(n => /^(?:source|ie|profile|receipt)-originals-[0-9a-f-]{36}$/.test(n));
}

/** No URLs, selectors or credentials are copied into derived metadata.
 * Untouched bodies are written before decoding; partial bodies never acquire EOF. */
export async function createMassachusettsOriginalCapture(cache: string, prefix: "ie" | "profile" | "receipt") {
  const directory = resolve(cache, `${prefix}-originals-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let count = 0, total = 0;
  async function capture(role: string, path: string) {
    if (!/^[a-z0-9_]{1,90}$/.test(role) || count >= 350) maHold("source_request_limit");
    const startedAt = new Date().toISOString();
    const response = await fetch(maNativeUrl(path), {
      method: "GET", redirect: "error", credentials: "omit",
      headers: { Accept: "application/json", "User-Agent": "VoteApp public campaign finance source sync" },
      signal: AbortSignal.timeout(45000),
    });
    const chunks: Uint8Array[] = [], stream = response.body?.getReader();
    let bytesRead = 0, eof = false;
    try {
      if (!stream) maHold("source_body");
      while (true) {
        const next = await stream.read();
        if (next.done) { eof = true; break; }
        bytesRead += next.value.byteLength;
        if (bytesRead > 32 * 1024 * 1024 || total + bytesRead > 128 * 1024 * 1024) {
          await stream.cancel();
          maHold("source_byte_limit");
        }
        chunks.push(next.value);
      }
    } catch { /* Persist the actual partial body and refuse it below. */ }
    const bytes = Buffer.concat(chunks), completedAt = new Date().toISOString();
    total += bytes.length;
    const file = String(++count).padStart(4, "0") + ".original";
    const meta: MassachusettsOriginalCapture = { role, file, method: "GET", status: response.status,
      contentType: response.headers.get("content-type"), startedAt, completedAt,
      bytes: bytes.length, sha256: maHash(bytes), eof };
    await writeFile(resolve(directory, file), bytes, { mode: 0o600, flag: "wx" });
    await appendFile(resolve(directory, "manifest.ndjson"), JSON.stringify(meta) + "\n", { mode: 0o600 });
    const length = response.headers.get("content-length");
    if (!eof || !bytes.length || response.status !== 200 ||
      (!response.headers.get("content-encoding") && length !== null && Number(length) !== bytes.length))
      maHold("source_status_or_eof");
    if (!meta.contentType?.toLowerCase().includes("application/json")) maHold("source_not_json");
    await new Promise(r => setTimeout(r, 1000));
    let value: any;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { maHold("source_json"); }
    return { value, meta, bytes };
  }
  return { directory, capture };
}

export type MassachusettsOriginalDirectory = {
  directory: string;
  records: MassachusettsOriginalCapture[];
  json(role: string): Promise<any>;
  bytes(record: MassachusettsOriginalCapture): Promise<Buffer>;
};
export async function readMassachusettsOriginalDirectory(directory: string): Promise<MassachusettsOriginalDirectory> {
  const st = await lstat(directory);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077)) maHold("private_original_directory");
  let records: MassachusettsOriginalCapture[];
  try { records = (await maPrivateBytes(resolve(directory, "manifest.ndjson"), 2 * 1024 * 1024))
    .toString("utf8").trim().split("\n").map(s => JSON.parse(s)); }
  catch { return maHold("original_manifest"); }
  if (!records.length || records.length > 350 || new Set(records.map(r => r.role)).size !== records.length)
    maHold("original_manifest");
  let previous = "";
  for (const [i, r] of records.entries()) {
    if (r.file !== String(i + 1).padStart(4, "0") + ".original" || r.method !== "GET" ||
      !/^[a-z0-9_]{1,90}$/.test(r.role) || r.status !== 200 || r.eof !== true ||
      !r.contentType?.toLowerCase().includes("application/json") || !maIso(r.startedAt) || !maIso(r.completedAt) ||
      r.startedAt < previous || r.startedAt > r.completedAt || Date.parse(r.completedAt) > Date.now() + 300000 ||
      !Number.isSafeInteger(r.bytes) || r.bytes <= 0 || r.bytes > 32 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(r.sha256))
      maHold("capture_metadata");
    previous = r.completedAt;
  }
  async function bytes(record: MassachusettsOriginalCapture) {
    const value = await maPrivateBytes(resolve(directory, record.file));
    if (value.length !== record.bytes || maHash(value) !== record.sha256) maHold("original_integrity");
    return value;
  }
  return { directory, records, bytes, async json(role: string) {
    const r = records.find(r => r.role === role);
    if (!r) maHold("missing_original_role");
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await bytes(r))); }
    catch (e) { if (e instanceof SyntaxError) maHold("source_json"); throw e; }
  } };
}
