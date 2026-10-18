import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ohioSos31uDetailUrl, parseOhioSos31uDetailCsv, type OhioSos31uDetailRow } from "./ohioSos31uDetail.js";

const unavailable = (): never => { throw new Error("Ohio native 31-U originals unavailable"); };
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
async function directory(path: string) {
  const s = await lstat(path); if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o777) !== 0o700) unavailable();
}
async function original(path: string, max: number) {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o777) !== 0o600 || s.size < 1 || s.size > max) unavailable();
  const b = await readFile(path); if (b.length !== s.size) unavailable(); return b;
}

/** Completed native Browser-pane downloads, preserved unchanged. A bad new
 * capture never falls back to an older parsed bundle. Annual discovery and
 * detail/cover reconciliation still run in the ordinary batch. */
export async function readOhioSos31uOriginals(input: { cacheDir: string; cycleYear: number }): Promise<{
  reportKey: string; rows: OhioSos31uDetailRow[];
}[] | null> {
  if (!Number.isInteger(input.cycleYear) || input.cycleYear < 2000 || input.cycleYear > 2100) return unavailable();
  const parent = join(input.cacheDir, "original-details"), root = join(parent, String(input.cycleYear));
  try { await lstat(root); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  await directory(parent); await directory(root);
  const raw = await original(join(root, "manifest.json"), 4 * 1024 * 1024);
  const m = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  if (m?.version !== 1 || m.cycleYear !== input.cycleYear || !Array.isArray(m.entries) || m.entries.length > 2000) return unavailable();
  const keys = new Set<string>(), reports = []; let bytes = 0;
  for (const entry of m.entries) {
    if (!entry || typeof entry.reportKey !== "string" || !/^[1-9]\d*$/.test(entry.reportKey) || keys.has(entry.reportKey) ||
      entry.file !== `${entry.reportKey}.csv` || entry.sourceUrl !== ohioSos31uDetailUrl(entry.reportKey) ||
      entry.captureMethod !== "native-browser-completed-download" || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 ||
      typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256) || typeof entry.sourceRetrievedAt !== "string" ||
      !Number.isFinite(Date.parse(entry.sourceRetrievedAt)) || new Date(entry.sourceRetrievedAt).toISOString() !== entry.sourceRetrievedAt ||
      Date.parse(entry.sourceRetrievedAt) > Date.now()) return unavailable();
    keys.add(entry.reportKey); const body = await original(join(root, entry.file), 16 * 1024 * 1024); bytes += body.length;
    if (bytes > 128 * 1024 * 1024 || body.length !== entry.bytes || hash(body) !== entry.sha256) return unavailable();
    const rows = parseOhioSos31uDetailCsv(new TextDecoder("utf-8", { fatal: true }).decode(body), { reportKey: entry.reportKey });
    if (rows.some(row => !Number.isSafeInteger(row.amountCents) || !row.spenderCommitteeName.trim() ||
      row.year !== input.cycleYear && row.year !== input.cycleYear - 1)) return unavailable();
    reports.push({ reportKey: entry.reportKey, rows });
  }
  return reports;
}
