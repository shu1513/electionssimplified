import { appendFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { hiHash, hiHold } from "./hawaiiReportedCore.js";

export type HawaiiOriginal = { role: string; file: string; method: "GET" | "POST"; status: number; contentType: string | null;
  startedAt: string; completedAt: string; bytes: number; sha256: string; eof: true };
export type HawaiiSourceRead = (role: string, url: string, body?: URLSearchParams) => Promise<string>;
export type HawaiiOriginalGraph = { readonly directory: string; readonly records: readonly Readonly<HawaiiOriginal>[]; readonly read: HawaiiSourceRead };
const originalGraphs = new WeakSet<object>();
export const isHawaiiOriginalGraph = (value: unknown): value is HawaiiOriginalGraph => !!value && typeof value === "object" && originalGraphs.has(value);
function originalGraph(directory: string, records: HawaiiOriginal[], read: HawaiiSourceRead): HawaiiOriginalGraph {
  // Keep response metadata and transport closures private. A caller cannot
  // replace the reader or mutate a manifest into financial write authority.
  const value: HawaiiOriginalGraph = Object.freeze({ directory, get records() { return Object.freeze(records.map(r => Object.freeze({ ...r }))); }, read });
  originalGraphs.add(value); return value;
}
export const HI_SOURCE_HOSTS = ["https://hicscdata.hawaii.gov", "https://csc.hawaii.gov", "https://olvr.hawaii.gov"];
const ROOT_ROUTES = ["/CFSPublic/", "/NCFSPublic/"];
const iso = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
export async function hiPrivateBytes(path: string, max = 64 * 1024 ** 2): Promise<Buffer> {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o077) || s.size > max) hiHold("private_original");
  return readFile(path);
}
function scope(url: string, post: boolean): URL {
  const u = new URL(url);
  if (!HI_SOURCE_HOSTS.includes(u.origin) || u.username || u.password || u.hash) hiHold("source_origin");
  if (post && !(u.origin === HI_SOURCE_HOSTS[1] && ROOT_ROUTES.some(p => u.pathname.startsWith(p))
    || u.href === "https://olvr.hawaii.gov/Controls/CandidateFiling.aspx?elid=94")) hiHold("source_post_scope");
  return u;
}
export async function createHawaiiOriginalGraph(cache: string): Promise<HawaiiOriginalGraph> {
  const directory = resolve(cache, `source-originals-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const records: HawaiiOriginal[] = [], cookies = new Map<string, string>(); let total = 0;
  const read: HawaiiSourceRead = async (role, url, body) => {
    const u = scope(url, !!body);
    if (!/^[a-z0-9_]+$/.test(role) || records.some(r => r.role === role) || records.length >= 1000) hiHold("source_role_limit");
    const headers: Record<string, string> = { Accept: "application/json,text/html,text/csv,*/*", "User-Agent": "Mozilla/5.0 VoteApp public campaign finance" };
    if (body) { headers["Content-Type"] = "application/x-www-form-urlencoded"; headers.Origin = u.origin; headers.Referer = url; }
    // Only the anonymous source PHP session is retained, in memory, per origin.
    if (u.origin === HI_SOURCE_HOSTS[1] && cookies.has("PHPSESSID")) headers.Cookie = `PHPSESSID=${cookies.get("PHPSESSID")}`;
    const startedAt = new Date().toISOString();
    const response = await fetch(url, { method: body ? "POST" : "GET", ...(body ? { body: body.toString() } : {}), headers,
      credentials: "omit", redirect: "error", signal: AbortSignal.timeout(45000) });
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const m = /^PHPSESSID=([^;\s]+);/.exec(cookie);
      if (u.origin === HI_SOURCE_HOSTS[1] && m) cookies.set("PHPSESSID", m[1]!);
    }
    const raw = Buffer.from(await response.arrayBuffer()), completedAt = new Date().toISOString(); total += raw.length;
    if (raw.length > 32 * 1024 ** 2 || total > 256 * 1024 ** 2) hiHold("source_byte_limit");
    const file = `${String(records.length + 1).padStart(4, "0")}.original`;
    await writeFile(resolve(directory, file), raw, { mode: 0o600, flag: "wx" });
    const record: HawaiiOriginal = { role, file, method: body ? "POST" : "GET", status: response.status, contentType: response.headers.get("content-type"),
      startedAt, completedAt, bytes: raw.length, sha256: hiHash(raw), eof: true };
    records.push(record); await appendFile(resolve(directory, "manifest.ndjson"), JSON.stringify(record) + "\n", { mode: 0o600 });
    const length = response.headers.get("content-length");
    if (response.status !== 200 || (!response.headers.get("content-encoding") && length !== null && Number(length) !== raw.length)) hiHold("source_status_or_eof");
    await new Promise(r => setTimeout(r, 1000));
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  };
  return originalGraph(directory, records, read);
}
export async function readHawaiiOriginalGraph(directory: string): Promise<HawaiiOriginalGraph> {
  const s = await lstat(directory);
  if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077)) hiHold("private_original_directory");
  const raw = (await hiPrivateBytes(resolve(directory, "manifest.ndjson"), 4 * 1024 ** 2)).toString("utf8");
  if (!raw.endsWith("\n")) hiHold("original_manifest_eof");
  const records: HawaiiOriginal[] = raw.trim().split("\n").map(s => JSON.parse(s));
  if (!records.length || records.length > 1000 || new Set(records.map(r => r.role)).size !== records.length) hiHold("original_manifest");
  let previous = "";
  for (const [i, r] of records.entries()) {
    if (!/^[a-z0-9_]+$/.test(r.role) || r.file !== `${String(i + 1).padStart(4, "0")}.original` || !["GET", "POST"].includes(r.method)
      || r.eof !== true || r.status !== 200 || !iso(r.startedAt) || !iso(r.completedAt) || r.startedAt > r.completedAt
      || r.startedAt < previous || Date.parse(r.completedAt) > Date.now() + 300000 || !Number.isSafeInteger(r.bytes)
      || r.bytes < 1 || r.bytes > 32 * 1024 ** 2 || !/^[a-f0-9]{64}$/.test(r.sha256) || !r.contentType) hiHold("original_metadata");
    previous = r.completedAt;
  }
  let cursor = 0;
  const read: HawaiiSourceRead = async (role, url, body) => {
    scope(url, !!body); const r = records[cursor++];
    if (!r || r.role !== role || r.method !== (body ? "POST" : "GET")) hiHold("original_graph_membership");
    const bytes = await hiPrivateBytes(resolve(directory, r.file));
    if (bytes.length !== r.bytes || hiHash(bytes) !== r.sha256) hiHold("original_integrity");
    const mime = new URL(url).origin === HI_SOURCE_HOSTS[0] ? "json" : role.includes("roster_csv") ? "csv" : "html";
    if (!r.contentType?.toLowerCase().includes(mime) && !(mime === "html" && r.contentType?.includes("json"))) hiHold("original_mime");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  };
  return originalGraph(directory, records, read);
}
export async function listHawaiiOriginalDirectories(cache: string): Promise<string[]> {
  const names = await readdir(cache).catch(() => [] as string[]), eligible: { path: string; clock: number }[] = [];
  for (const name of names) {
    if (!/^source-originals-[a-f0-9-]{36}$/.test(name)) continue;
    const path = resolve(cache, name), s = await lstat(path);
    if (s.isDirectory() && !s.isSymbolicLink() && !(s.mode & 0o077)) eligible.push({ path, clock: s.mtimeMs });
  }
  return eligible.sort((a, b) => b.clock - a.clock).map(v => v.path);
}
