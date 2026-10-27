import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { traverseErtsCf8Index, type ErtsTransport, type ErtsCf8Traversal } from "./rhodeIslandErtsClient.js";
import { getErtsArtifactStatus, storeErtsArtifact, validateErtsArtifactBody } from "./rhodeIslandErtsArtifactCache.js";
import { parseErtsCf8FiledDate, parseErtsCf8IndexPage, parseErtsCf8Pager } from "./rhodeIslandErtsParsers.js";
import { parseRhodeIslandCf8ScanUrl, type RhodeIslandCf8FamilyRow } from "./rhodeIslandReviewedCf8.js";

const KEY = (s: string) => s.trim().replace(/\s+/gu, " ").toUpperCase();
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const HOME = "https://www.ricampaignfinance.com/RIPublic/Homepage.aspx";
const MAX_BYTES = 64 * 1024 * 1024;
function check(v: unknown, reason: string): asserts v { if (!v) throw new Error(`Rhode Island CF8 cache: ${reason}`); }
function nativeDay(value: string): string {
  const m = /^([A-Z][a-z]{2}) (\d{1,2}) (\d{4})$/u.exec(value), ms = parseErtsCf8FiledDate(value);
  const d = new Date(ms), months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  check(m && Number.isFinite(ms) && d.getUTCFullYear() === Number(m[3]) && months[d.getUTCMonth()] === m[1] &&
    d.getUTCDate() === Number(m[2]), "invalid_native_civil_date");
  return d.toISOString().slice(0, 10);
}
function yearCheck(year: number): void { check(Number.isInteger(year) && year >= 2000 && year <= 2100 && year % 2 === 0, "cycle_year"); }
function root(cacheDir: string, spenderName: string): string {
  check(typeof spenderName === "string" && Boolean(spenderName.trim()) && spenderName.length <= 500 &&
    !/[\x00-\x1f\x7f]/u.test(spenderName), "filer_name");
  return join(resolve(cacheDir), "cf8-filers", sha(KEY(spenderName)));
}
function nativeUrl(value: string): string {
  const u = new URL(value);
  if (u.protocol === "http:") u.protocol = "https:";
  parseRhodeIslandCf8ScanUrl(u.href);
  return u.href;
}
function readRows(pages: readonly { html: string; url: string; page: number }[], electionYear: number) {
  check(pages.length > 0 && pages.length <= 25, "complete_index_page_count");
  const rows = pages.flatMap((page, i) => {
    check(page.url === HOME && page.page === i + 1 && parseErtsCf8Pager(page.html).currentPage === i + 1, "native_index_page_identity");
    return parseErtsCf8IndexPage(page.html);
  });
  const days = rows.map(r => Date.parse(`${nativeDay(r.filedDate)}T00:00:00Z`));
  check(days.length > 0 && days.every((d, i) => Number.isFinite(d) && (i === 0 || d <= days[i - 1]!)), "index_date_order");
  const last = parseErtsCf8IndexPage(pages.at(-1)!.html);
  check(last.length > 0 && last.every(r => nativeDay(r.filedDate) < `${electionYear - 1}-01-01`), "index_cycle_boundary");
  return rows;
}
function familyFromRows(rows: ReturnType<typeof readRows>, spenderName: string, electionYear: number, asOf: string): RhodeIslandCf8FamilyRow[] {
  const family = rows.filter(r => {
    const day = nativeDay(r.filedDate), selected = KEY(r.organizationName.replace(/\s*\(amended\)\s*$/iu, "")) === KEY(spenderName) &&
      day >= `${electionYear}-01-01` && day <= `${electionYear}-12-31`;
    if (selected) check(day <= asOf, "future_family_filing_date");
    return selected;
  }).map(r => {
    check(r.scannedUrl, "missing_family_scan");
    const sourceUrl = nativeUrl(r.scannedUrl), scan = parseRhodeIslandCf8ScanUrl(sourceUrl);
    check(scan.filingType === r.filingType, "native_scan_class");
    return { filedDate: nativeDay(r.filedDate),
      filingType: r.filingType, organizationName: r.organizationName, sourceUrl };
  });
  check(family.length > 0 && family.length <= 100 && new Set(family.map(r => r.sourceUrl)).size === family.length,
    "nonempty_complete_family");
  return family;
}
type Bundle = {
  version: 1; generation: string; electionYear: number; spenderName: string;
  beforeObservedAt: string; beforeCompletedAt: string; afterObservedAt: string; completedAt: string;
  beforePages: number; afterPages: number; scanCount: number;
};
type Scan = { row: RhodeIslandCf8FamilyRow; guid: string; sha256: string; pageCount: number; observedAt: string; bytes: Uint8Array };
export type RhodeIslandCf8FilerCache = {
  family: readonly RhodeIslandCf8FamilyRow[]; scans: readonly Scan[]; electionYear: number; spenderName: string;
  /** Actual oldest scan observation; a new index alone cannot re-date scans. */
  observedAt: string; completedAt: string; indexObservedAt: string; sourceDigest: string;
};

async function privateArtifact(input: Parameters<typeof storeErtsArtifact>[0]) {
  const m = await storeErtsArtifact(input);
  await chmod(dirname(m.filePath), 0o700); await chmod(m.filePath, 0o600); await chmod(m.manifestPath, 0o600);
  return m;
}

/** Ordinary retrieval only, independent of receiving organizations/finance.
 * Fetch and validate the entire selected annual filer family between two full
 * cycle indexes. Publish a single generation pointer last: failed retrieval,
 * changed editions or interrupted installation leave the prior cache intact.
 */
export async function acquireRhodeIslandCf8Filer(input: {
  cacheDir: string; electionYear: number; spenderName: string; transport: ErtsTransport;
}): Promise<{ indexPages: number; indexRows: number; wholeScans: number; wholePages: number }> {
  yearCheck(input.electionYear);
  const base = root(input.cacheDir, input.spenderName), generation = randomUUID();
  const generationDir = join(base, "generations", generation), start = new Date();
  const traverse = () => traverseErtsCf8Index(input.transport, { cycleStartMs: Date.parse(`${input.electionYear - 1}-01-01T00:00:00Z`) });
  const before = await traverse(), beforeCompletedAt = new Date();
  check(before.descending && before.reachedBoundary, "opening_index_incomplete");
  const beforeRows = readRows(before.pages, input.electionYear);
  const family = familyFromRows(beforeRows, input.spenderName, input.electionYear, start.toISOString().slice(0, 10));
  let totalBytes = before.pages.reduce((n, p) => n + Buffer.byteLength(p.html), 0);
  const scans: Scan[] = [];
  for (const row of family) {
    const observedAt = new Date().toISOString(), result = await input.transport.fetch(row.sourceUrl);
    check(result.status === 200 && result.body.byteLength <= 32 * 1024 * 1024, "whole_scan_unavailable");
    const expected = parseRhodeIslandCf8ScanUrl(row.sourceUrl), actual = parseRhodeIslandCf8ScanUrl(result.finalUrl);
    check(isDeepStrictEqual(expected, actual), "scan_redirect_identity");
    totalBytes += result.body.byteLength; check(totalBytes <= MAX_BYTES, "whole_family_byte_bound");
    const pageCount = await validateErtsArtifactBody({ type: "cf8_scan", guid: expected.filingGuid }, result.body);
    scans.push({ row, guid: expected.filingGuid, observedAt, sha256: sha(result.body), pageCount, bytes: result.body });
  }
  const afterObservedAt = new Date(), after = await traverse(), completedAt = new Date();
  check(after.descending && after.reachedBoundary, "closing_index_incomplete");
  const afterRows = readRows(after.pages, input.electionYear);
  check(isDeepStrictEqual(beforeRows, afterRows), "current_index_changed");
  totalBytes += after.pages.reduce((n, p) => n + Buffer.byteLength(p.html), 0);
  check(totalBytes <= MAX_BYTES, "whole_family_byte_bound");
  check(completedAt.getTime() - start.getTime() <= 60 * 60 * 1000, "acquisition_interval_bound");
  await mkdir(generationDir, { recursive: true, mode: 0o700 });
  for (const [label, snapshot, clock] of [["before", before, start], ["after", after, afterObservedAt]] as const) {
    const cacheDir = join(generationDir, label); await mkdir(cacheDir, { mode: 0o700 });
    for (const page of snapshot.pages) await privateArtifact({ cacheDir,
      key: { type: "cf8_index_page", page: page.page }, url: page.url, body: page.html,
      source: { cf8PageCount: snapshot.pages.length }, retrievedAt: clock });
  }
  for (const scan of scans) await privateArtifact({ cacheDir: generationDir, key: { type: "cf8_scan", guid: scan.guid },
    url: scan.row.sourceUrl, body: scan.bytes, retrievedAt: new Date(scan.observedAt) });
  const bundle: Bundle = { version: 1, generation, electionYear: input.electionYear, spenderName: input.spenderName,
    beforeObservedAt: start.toISOString(), beforeCompletedAt: beforeCompletedAt.toISOString(),
    afterObservedAt: afterObservedAt.toISOString(), completedAt: completedAt.toISOString(),
    beforePages: before.pages.length, afterPages: after.pages.length, scanCount: scans.length };
  await writeFile(join(generationDir, "bundle.json"), JSON.stringify(bundle), { mode: 0o600 });
  const tmp = join(base, `current-${generation}.tmp`);
  await writeFile(tmp, JSON.stringify({ version: 1, generation }), { mode: 0o600 });
  await rename(tmp, join(base, `current-${input.electionYear}.json`));
  return { indexPages: before.pages.length, indexRows: beforeRows.length, wholeScans: scans.length,
    wholePages: scans.reduce((n, s) => n + s.pageCount, 0) };
}

/** Re-check whole originals and one acquisition vintage; no network, OCR,
 * transcriptions or money writes. A readable PDF is not financial authority.
 */
export async function readRhodeIslandCf8FilerCache(input: {
  cacheDir: string; electionYear: number; spenderName: string;
}): Promise<RhodeIslandCf8FilerCache> {
  yearCheck(input.electionYear);
  const base = root(input.cacheDir, input.spenderName);
  const pointer = JSON.parse(await readFile(join(base, `current-${input.electionYear}.json`), "utf8"));
  check(pointer.version === 1 && typeof pointer.generation === "string" && UUID.test(pointer.generation), "generation_pointer");
  const dir = join(base, "generations", pointer.generation), b = JSON.parse(await readFile(join(dir, "bundle.json"), "utf8")) as Bundle;
  check(b.version === 1 && b.generation === pointer.generation && b.electionYear === input.electionYear &&
    b.spenderName === input.spenderName, "bundle_scope");
  const times = [b.beforeObservedAt, b.beforeCompletedAt, b.afterObservedAt, b.completedAt].map(Date.parse);
  check(times.every((t, i) => Number.isFinite(t) && (i === 0 || t >= times[i - 1]!)) && times[3]! <= Date.now() &&
    times[3]! - times[0]! <= 60 * 60 * 1000, "original_observation_interval");
  const snapshot = async (label: string, count: number, observedAt: string) => {
    check(Number.isInteger(count) && count >= 1 && count <= 25, "complete_index_page_count");
    const pages: ErtsCf8Traversal["pages"] = [];
    for (let i = 1; i <= count; i++) {
      const a = await getErtsArtifactStatus({ cacheDir: join(dir, label), key: { type: "cf8_index_page", page: i } });
      check(a.status === "ready" && a.bytes && a.manifest && a.manifest.url === HOME &&
        a.manifest.retrievedAt === observedAt && a.manifest.source?.cf8PageCount === count, "index_original_or_vintage");
      const html = new TextDecoder("utf-8", { fatal: true }).decode(a.bytes);
      check(a.manifest.rowCount === parseErtsCf8IndexPage(html).length, "index_row_count");
      pages.push({ page: i, url: HOME, html });
    }
    return readRows(pages, input.electionYear);
  };
  const before = await snapshot("before", b.beforePages, b.beforeObservedAt), after = await snapshot("after", b.afterPages, b.afterObservedAt);
  check(isDeepStrictEqual(before, after), "current_index_changed");
  const family = familyFromRows(before, input.spenderName, input.electionYear, b.beforeObservedAt.slice(0, 10));
  check(b.scanCount === family.length, "complete_scan_family");
  const scans: Scan[] = []; let totalBytes = 0;
  for (const row of family) {
    const guid = parseRhodeIslandCf8ScanUrl(row.sourceUrl).filingGuid;
    const a = await getErtsArtifactStatus({ cacheDir: dir, key: { type: "cf8_scan", guid } });
    check(a.status === "ready" && a.bytes && a.manifest && a.manifest.url === row.sourceUrl, "scan_original_or_identity");
    const observed = Date.parse(a.manifest.retrievedAt);
    check(Number.isFinite(observed) && observed >= times[1]! && observed <= times[2]!, "scan_original_clock");
    totalBytes += a.bytes.byteLength; check(a.bytes.byteLength <= 32 * 1024 * 1024 && totalBytes <= MAX_BYTES, "whole_family_byte_bound");
    const pageCount = await validateErtsArtifactBody({ type: "cf8_scan", guid }, a.bytes);
    check(pageCount === a.manifest.rowCount, "scan_page_count");
    scans.push({ row, guid, sha256: a.manifest.sha256, pageCount, observedAt: a.manifest.retrievedAt, bytes: a.bytes });
  }
  const digest = sha(JSON.stringify({ bundle: b, family, scans: scans.map(({ bytes: _bytes, ...s }) => s) }));
  return { family, scans, electionYear: b.electionYear, spenderName: b.spenderName,
    observedAt: scans.map(s => s.observedAt).sort()[0]!, completedAt: b.completedAt,
    indexObservedAt: b.afterObservedAt, sourceDigest: digest };
}
