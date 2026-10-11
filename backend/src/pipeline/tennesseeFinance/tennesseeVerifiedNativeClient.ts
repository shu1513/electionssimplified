import { createHash } from "node:crypto";
import { TennesseeCampClientError } from "./tennesseeCampClient.js";
import { decodeTennesseeCurrentReportBytes } from "./tennesseeCurrentReportClient.js";

const ORIGIN = "https://apps.tn.gov";
const PUBLIC = "/tncamp/public/";
export const TENNESSEE_NATIVE_CONTRIBUTION_HEADERS = ["Type", "Adj", "Amount", "Date", "Election Year", "Report Name", "Recipient Name", "Contributor Name", "Contributor Address", "Contributor Occupation", "Contributor Employer", "Description"] as const;
export const TENNESSEE_NATIVE_IE_HEADERS = ["Type", "Adj", "Amount", "Date", "Election Year", "Report Name", "Candidate/PAC Name", "Vendor Name", "Vendor Address", "Purpose", "Candidate For", "S/O"] as const;
const PAC_HEADERS = ["Salutation", "First Name", "Last Name", "Committee Affiliation", "Created", "Closed"];
const CANDIDATE_HEADERS = ["Salutation", "First Name", "Last Name", "Office Sought", "District", "Election Year", "Committee Affiliation", "Created", "Closed"];
export type TennesseeNativeRawResponse = {
  url: string; method: "GET" | "POST"; fetchedAt: string; byteCount: number;
  sha256: string; encoding: "utf-8" | "windows-1252"; bytes: Uint8Array;
};
export type TennesseeNativeRequestMetadata = Omit<TennesseeNativeRawResponse, "bytes">;
export type TennesseeNativeChunk = { index: number; declaredCount: number; pages: number; more: boolean; csvSha256: string | null };
export type TennesseeNativeResult<T> = {
  rows: T[]; declaredCount: number; fingerprint: string; sourceUrl: string;
  query: Record<string, string>; requests: TennesseeNativeRequestMetadata[];
  chunks: TennesseeNativeChunk[]; complete: true;
};
export type TennesseeVerifiedNativeContributionRow = {
  occurrence: number; reportId: string; reportUrl: string; type: string; adjustment: string;
  amountCents: number; date: string; electionYear: number | null; reportName: string;
  recipientName: string; contributorName: string; contributorAddress: string;
  contributorOccupation: string; contributorEmployer: string; description: string;
  contributorAddressLines?: string[];
  rawFields: Record<string, string>;
};
export type TennesseeVerifiedNativeIndependentExpenditureRow = {
  occurrence: number; reportId: string; reportUrl: string; type: "Independent"; adjustment: string;
  amountCents: number; date: string; electionYear: number | null; reportName: string;
  payerName: string; vendorName: string; vendorAddress: string; purpose: string;
  targetName: string; supportOpposeCode: "S" | "O" | ""; vendorAddressLines?: string[]; rawFields: Record<string, string>;
};
export type TennesseeVerifiedNativePacRegistryRow = {
  campId: string; name: string; committeeType: "PAC"; committeeAffiliation: string;
  created: string | null; closed: string | null; reportListUrl: string; ownerName: string;
  rawFields: Record<string, string>;
};
export type TennesseeVerifiedNativeCandidateRow = {
  campId: string; name: string; officeSought: string; district: string; electionYear: number;
  committeeAffiliation: string; created: string | null; closed: string | null;
  reportListUrl: string; ownerName: string; rawFields: Record<string, string>;
};
export type TennesseeVerifiedNativeClientOptions = {
  fetchImpl?: typeof fetch; timeoutMs?: number; maxResponseBytes?: number;
  maxChunks?: number; maxPagesPerChunk?: number;
  onRawResponse?: (response: TennesseeNativeRawResponse) => void | Promise<void>;
};
export type TennesseeVerifiedNativeClient = {
  fetchContributions(input: { receiverName: string; recipientType: "candidate" | "pac";
    reportYear: number; donorScope: "all" | "pac"; electionYear?: number }): Promise<TennesseeNativeResult<TennesseeVerifiedNativeContributionRow>>;
  fetchIndependentExpenditures(input: { reportYear: number }): Promise<TennesseeNativeResult<TennesseeVerifiedNativeIndependentExpenditureRow>>;
  fetchPacRegistry(): Promise<TennesseeNativeResult<TennesseeVerifiedNativePacRegistryRow>>;
  fetchCandidateContext(input: { name: string; electionYear: number }): Promise<TennesseeNativeResult<TennesseeVerifiedNativeCandidateRow>>;
};
function bad(message: string): never { throw new TennesseeCampClientError("bad_response", message); }
function invalid(message: string): never { throw new TennesseeCampClientError("invalid_request", message); }
function hash(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function entities(value: string): string {
  return value.replace(/&#(x[0-9a-f]+|\d+);/gi, (_m, n: string) => {
    const code = n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n);
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return bad("Invalid Tennessee native HTML entity");
    // HTML numeric C1 references use the legacy CP1252 Unicode mapping.
    const c1 = [0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
      0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
      0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
      0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178];
    return String.fromCodePoint(code >= 0x80 && code <= 0x9f ? c1[code - 0x80] : code);
  }).replace(/&(amp|quot|apos|lt|gt|nbsp|reg|rsquo|lsquo|ndash|mdash);/g, (_m, n: string) =>
    ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", reg: "®", rsquo: "’", lsquo: "‘", ndash: "–", mdash: "—" } as Record<string, string>)[n]);
}
function normalized(value: string): string { return value.replace(/\s+/g, " ").trim(); }
function plain(value: string): string { return normalized(entities(value.replace(/<[^>]*>/g, " "))); }
function addressLines(cell: string): string[] {
  const lines = cell.split(/<br\s*\/?>/i).map(plain);
  return lines;
}
function address(value: string): string { return normalized(value).replace(/\s*,\s*/g, ","); }
function year(value: number): number { if (!Number.isInteger(value) || value < 2000 || value > 2100) return invalid("Invalid Tennessee native year"); return value; }
function nonempty(value: string): string { if (!value?.trim()) return invalid("Missing Tennessee native name"); return value.trim(); }
function date(value: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!m) return bad("Invalid Tennessee native date");
  const result = `${m[3]}-${m[1]}-${m[2]}`;
  const d = new Date(result + "T00:00:00Z");
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== result) return bad("Invalid Tennessee native calendar date");
  return result;
}
function cents(value: string): number {
  const s = value.trim();
  if (!/^-?\$?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{2})?$/.test(s)) return bad("Invalid Tennessee native signed money");
  const negative = s.startsWith("-"); const [whole, fraction = "00"] = s.replace(/[-$,]/g, "").split(".");
  const result = BigInt(whole) * 100n + BigInt(fraction);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) return bad("Unsafe Tennessee native cents");
  return Number(result) * (negative ? -1 : 1);
}
function id(value: string): string { if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) return bad("Invalid Tennessee native CAMP/report identity"); return value; }
function official(value: string, base: string, paths: readonly string[]): string {
  const u = new URL(entities(value), base);
  if (u.origin !== ORIGIN || u.username || u.password || u.port || u.hash || !paths.includes(u.pathname)) return bad("Tennessee native URL outside verified official endpoints");
  return u.toString();
}
function assertHtml(html: string): void {
  if (!/<html\b/i.test(html) || !/<\/html\s*>/i.test(html) || /<input[^>]+type\s*=\s*["']?password\b/i.test(html)
    || /(?:too many results|maximum number of results|access denied|_Incapsula_Resource)/i.test(html)) return bad("Incomplete, login, challenge or capped Tennessee native HTML");
}
/** Strict CSV preserves every original field and occurrence, including signed and non-cash rows. */
export function parseTennesseeVerifiedNativeCsv(csv: string, expectedHeaders: readonly string[]): Record<string, string>[] {
  if (!csv.endsWith("\n") || /\0/.test(csv) || /^\s*</.test(csv)) return bad("Incomplete or non-CSV Tennessee native export");
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false; let closed = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (quoted) { if (c === '"') { if (csv[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } } else field += c; continue; }
    if (c === '"') { if (field || closed) return bad("Invalid Tennessee native CSV quoting"); quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; closed = false; continue; }
    if (c === "\r" || c === "\n") {
      if (c === "\r") { if (csv[i + 1] !== "\n") return bad("Invalid Tennessee native CSV line ending"); i++; }
      row.push(field); rows.push(row); row = []; field = ""; closed = false; continue;
    }
    if (closed) return bad("Unexpected Tennessee native CSV bytes after quote");
    field += c;
  }
  if (quoted || row.length || field || closed) return bad("Unterminated Tennessee native CSV");
  const headers = rows.shift();
  if (!headers || headers.length !== expectedHeaders.length || headers.some((v, i) => v !== expectedHeaders[i]) || new Set(headers).size !== headers.length) return bad("Unexpected Tennessee native CSV headers");
  return rows.map(r => {
    if (r.length !== headers.length) return bad("Invalid Tennessee native CSV row width");
    return Object.fromEntries(headers.map((h, i) => [h, r[i]]));
  });
}
type NativePage = { rows: string[][]; total: number; start: number; end: number; next: string | null; more: string | null; exportUrl: string | null; empty: boolean };
function links(html: string): { href: string; label: string }[] { return [...html.matchAll(/<a\b[^>]*href=(["'])([\s\S]*?)\1[^>]*>([\s\S]*?)<\/a>/gi)].map(m => ({ href: m[2], label: plain(m[3]) })); }
function page(html: string, sourceUrl: string, endpoint: "cp" | "ce", expectedHeaders: readonly string[], pageNumber: number): NativePage {
  assertHtml(html);
  const resultPath = PUBLIC + endpoint + "results.htm";
  const allLinks = links(html);
  const moreLinks = allLinks.filter(l => l.label === "More");
  const moreUrls = [...new Set(moreLinks.map(l => official(l.href, sourceUrl, [PUBLIC + endpoint + "resultsnext.htm"])))];
  if (moreUrls.length > 1 || (/More records available/i.test(html) && moreUrls.length !== 1)) return bad("Unclosed Tennessee native More continuation");
  const exportLinks = allLinks.filter(l => { try { const u = new URL(entities(l.href), sourceUrl); return u.searchParams.get("6578706f7274") === "1" && u.searchParams.get("d-1341904-e") === "1"; } catch { return false; } });
  const exportUrls = [...new Set(exportLinks.map(l => official(l.href, sourceUrl, [resultPath])))];
  if (exportUrls.length > 1) return bad("Ambiguous Tennessee native CSV export");
  const table = /<table\b[^>]*id=["']results["'][^>]*>([\s\S]*?)<\/table>/i.exec(html);
  if (!table) {
    if (/No results matched your criteria\./i.test(html) && !moreUrls.length && !exportUrls.length && pageNumber === 1) return { rows: [], total: 0, start: 0, end: 0, next: null, more: null, exportUrl: null, empty: true };
    return bad("Missing Tennessee native result table");
  }
  const header = [...table[1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(m => plain(m[1]));
  if (header.length !== expectedHeaders.length || header.some((v, i) => v !== expectedHeaders[i])) return bad("Unexpected Tennessee native HTML headers");
  const rows: string[][] = [];
  for (const m of table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    if (/<th\b/i.test(m[1])) continue;
    const cells = [...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(c => c[1]);
    if (cells.length !== expectedHeaders.length) return bad("Invalid Tennessee native HTML row width");
    rows.push(cells);
  }
  const banner = plain(/<span\b[^>]*class=["']pagebanner["'][^>]*>([\s\S]*?)<\/span>/i.exec(html)?.[1] ?? "");
  let total: number; let start: number; let end: number;
  if (banner === "One result found.") { total = start = end = 1; }
  else {
    const m = /^(\d[\d,]*) results found, displaying (?:all results\.|(\d[\d,]*) to (\d[\d,]*)\.)$/.exec(banner);
    if (!m) return bad("Unknown Tennessee native declared count/range");
    total = Number(m[1].replace(/,/g, "")); start = m[2] ? Number(m[2].replace(/,/g, "")) : 1; end = m[3] ? Number(m[3].replace(/,/g, "")) : total;
  }
  if (!Number.isSafeInteger(total) || total <= 0 || start !== (pageNumber - 1) * 50 + 1 || end !== Math.min(pageNumber * 50, total) || rows.length !== end - start + 1) return bad("Incomplete or overlapping Tennessee native page range");
  const nextUrls = [...new Set(allLinks.filter(l => { try { const u = new URL(entities(l.href), sourceUrl); return Number(u.searchParams.get("d-1341904-p")) === pageNumber + 1 && !u.searchParams.has("6578706f7274"); } catch { return false; } }).map(l => official(l.href, sourceUrl, [resultPath])))];
  // DisplayTag supplies sortable header links and multiple pager anchors; use its plain page link.
  const next = nextUrls.find(u => new URL(u).searchParams.size === 1) ?? nextUrls.find(u => !new URL(u).searchParams.has("d-1341904-s")) ?? null;
  if (end < total && !next || end === total && next) return bad("Unclosed Tennessee native table pagination");
  if (!exportUrls[0]) return bad("Missing Tennessee native CSV export");
  return { rows, total, start, end, next, more: moreUrls[0] ?? null, exportUrl: exportUrls[0], empty: false };
}
function exportIdentity(value: string | null, pageNumber: number): string | null {
  if (!value) return null;
  const u = new URL(value); const page = u.searchParams.get("d-1341904-p");
  if (page !== null && page !== String(pageNumber)) return bad("Mismatched Tennessee native export page");
  // Official DisplayTag export links add the current UI page even though the CSV exports the whole chunk.
  u.searchParams.delete("d-1341904-p"); u.searchParams.sort(); return u.toString();
}
function multisetEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  const counts = new Map<string, number>(); for (const r of a) { const k = JSON.stringify(r); counts.set(k, (counts.get(k) ?? 0) + 1); }
  for (const r of b) { const k = JSON.stringify(r); const n = counts.get(k); if (!n) return false; if (n === 1) counts.delete(k); else counts.set(k, n - 1); }
  return counts.size === 0;
}
function fingerprint(rows: readonly unknown[]): string { return hash(JSON.stringify(rows.map(r => JSON.stringify(r)).sort())); }
function reportLink(cell: string): { reportId: string; reportUrl: string } {
  const candidates = links(cell); if (candidates.length !== 1) return bad("Missing/ambiguous Tennessee native report link");
  const reportUrl = official(candidates[0].href, ORIGIN, ["/tncamp/search/pub/report_full.htm"]); const u = new URL(reportUrl);
  if (u.searchParams.size !== 1 || !u.searchParams.has("reportId")) return bad("Invalid Tennessee native report URL identity");
  return { reportId: id(u.searchParams.get("reportId") ?? ""), reportUrl };
}
function registryLink(cell: string): { campId: string; ownerName: string; reportListUrl: string } {
  const candidates = links(cell); if (candidates.length !== 1) return bad("Missing/ambiguous Tennessee native registry identity");
  // CAMP emits literal '&' (and other URL punctuation) in its owner display name.
  // Treat the entire observed owner suffix as data, corroborate its name below,
  // then encode it once for a safe official report-list request.
  const href = entities(candidates[0].href);
  const m = /^(?:https:\/\/apps\.tn\.gov)?\/tncamp\/public\/replist\.htm\?id=([1-9]\d*)&owner=([\s\S]+)$/.exec(href);
  if (!m) return bad("Invalid Tennessee native registry URL identity");
  let ownerName: string;
  try { ownerName = decodeURIComponent(m[2]); } catch { return bad("Invalid Tennessee native registry owner encoding"); }
  if (!ownerName.trim()) return bad("Missing Tennessee native registry owner");
  const u = new URL(ORIGIN + PUBLIC + "replist.htm"); u.searchParams.set("id", id(m[1])); u.searchParams.set("owner", ownerName);
  return { campId: m[1], ownerName, reportListUrl: u.toString() };
}
function cookiePairs(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  return (h.getSetCookie?.() ?? [headers.get("set-cookie") ?? ""]).flatMap(v => v.split(/,(?=\s*[^;,=\s]+=)/)).map(v => v.split(";", 1)[0].trim()).filter(Boolean);
}
export function createTennesseeVerifiedNativeClient(options: TennesseeVerifiedNativeClientOptions = {}): TennesseeVerifiedNativeClient {
  const maxBytes = options.maxResponseBytes ?? 5_000_000; const maxChunks = options.maxChunks ?? 30; const maxPages = options.maxPagesPerChunk ?? 100;
  const timeoutMs = options.timeoutMs ?? 30_000;
  for (const [name, n] of Object.entries({ maxBytes, maxChunks, maxPages, timeoutMs })) if (!Number.isSafeInteger(n) || n <= 0) invalid("Invalid Tennessee native " + name);
  async function acquire<T>(input: { path: "cpsearch.htm" | "cesearch.htm"; makeForm: (landing: string) => URLSearchParams;
    csvHeaders: readonly string[]; htmlHeaders: readonly string[]; convert: (csv: Record<string, string>[], html: string[][]) => T[] }): Promise<TennesseeNativeResult<T>> {
    // Each operation has an independent public session; concurrent receiver queries cannot mutate each other's resultsets.
    const cookies = new Map<string, string>(); const requests: TennesseeNativeRequestMetadata[] = [];
    const sourceUrl = ORIGIN + PUBLIC + input.path; const endpoint = input.path === "cpsearch.htm" ? "cp" : "ce";
    async function request(url: string, body?: URLSearchParams): Promise<{ text: string; sha256: string }> {
      official(url, ORIGIN, [PUBLIC + input.path, PUBLIC + endpoint + "results.htm", PUBLIC + endpoint + "resultsnext.htm"]);
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers = new Headers({ accept: "text/html,text/csv;q=0.9,*/*;q=0.1", "user-agent": "Mozilla/5.0" });
        if (cookies.size) headers.set("cookie", [...cookies].map(([k, v]) => k + "=" + v).join("; "));
        if (body) headers.set("content-type", "application/x-www-form-urlencoded");
        const response = await (options.fetchImpl ?? fetch)(url, { method: body ? "POST" : "GET", headers, body: body?.toString(), signal: controller.signal });
        if (!response.ok) throw new TennesseeCampClientError("http_error", "Tennessee native HTTP failure", response.status);
        if (response.url) official(response.url, url, [PUBLIC + input.path, PUBLIC + endpoint + "results.htm", PUBLIC + endpoint + "resultsnext.htm"]);
        const length = response.headers.get("content-length"); if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) return bad("Tennessee native response exceeds byte bound");
        if (!response.body) return bad("Missing Tennessee native response body");
        const reader = response.body.getReader(); const pieces: Uint8Array[] = []; let count = 0;
        try { while (true) { const part = await reader.read(); if (part.done) break; count += part.value.length; if (count > maxBytes) { await reader.cancel(); return bad("Tennessee native response exceeds byte bound"); } pieces.push(part.value); } } finally { reader.releaseLock(); }
        const bytes = new Uint8Array(count); let offset = 0; for (const p of pieces) { bytes.set(p, offset); offset += p.length; }
        const decoded = decodeTennesseeCurrentReportBytes(bytes);
        for (const pair of cookiePairs(response.headers)) { const sep = pair.indexOf("="); if (sep > 0) cookies.set(pair.slice(0, sep), pair.slice(sep + 1)); }
        const raw: TennesseeNativeRawResponse = { url, method: body ? "POST" : "GET", fetchedAt: new Date().toISOString(), bytes, byteCount: count, sha256: hash(bytes), encoding: decoded.encoding };
        const { bytes: _bytes, ...metadata } = raw; requests.push(metadata); await options.onRawResponse?.(raw);
        return { text: decoded.html, sha256: raw.sha256 };
      } catch (e) {
        if (e instanceof TennesseeCampClientError) throw e;
        throw new TennesseeCampClientError("network_error", controller.signal.aborted ? "Tennessee native request timed out" : "Tennessee native request failed");
      } finally { clearTimeout(timer); }
    }
    const landing = await request(sourceUrl); assertHtml(landing.text);
    if (!new RegExp('name=["\\\']' + (endpoint === "cp" ? "searchType" : "searchType") + '["\\\']').test(landing.text)) return bad("Missing Tennessee native public search form");
    const form = input.makeForm(landing.text); const query = Object.fromEntries(form);
    let current = await request(sourceUrl, form); let currentUrl = sourceUrl; const rows: T[] = []; const chunks: TennesseeNativeChunk[] = [];
    const continuationHashes = new Set<string>();
    for (let chunk = 0; chunk < maxChunks; chunk++) {
      if (continuationHashes.has(current.sha256)) return bad("Repeated Tennessee native continuation result"); continuationHashes.add(current.sha256);
      const first = page(current.text, currentUrl, endpoint, input.htmlHeaders, 1);
      if (first.empty) {
        if (chunk !== 0) return bad("Unexpected empty Tennessee native continuation");
        chunks.push({ index: 0, declaredCount: 0, pages: 1, more: false, csvSha256: null });
        return { rows, declaredCount: 0, fingerprint: fingerprint(rows), sourceUrl, query, requests, chunks, complete: true };
      }
      const expectedPages = Math.ceil(first.total / 50); if (expectedPages > maxPages) return bad("Tennessee native page bound exceeded");
      const htmlRows = [...first.rows]; let p = first;
      for (let n = 2; n <= expectedPages; n++) {
        const nextUrl = p.next!; const response = await request(nextUrl); p = page(response.text, nextUrl, endpoint, input.htmlHeaders, n);
        if (p.total !== first.total || p.more !== first.more || exportIdentity(p.exportUrl, n) !== exportIdentity(first.exportUrl, 1)) return bad("Changed Tennessee native page/continuation generation");
        htmlRows.push(...p.rows);
      }
      const exported = await request(first.exportUrl!); const csvRows = parseTennesseeVerifiedNativeCsv(exported.text, input.csvHeaders);
      if (htmlRows.length !== first.total || csvRows.length !== first.total) return bad("Tennessee native CSV/HTML declared count mismatch");
      rows.push(...input.convert(csvRows, htmlRows));
      chunks.push({ index: chunk, declaredCount: first.total, pages: expectedPages, more: !!first.more, csvSha256: exported.sha256 });
      if (!first.more) return { rows, declaredCount: rows.length, fingerprint: fingerprint(rows), sourceUrl, query, requests, chunks, complete: true };
      currentUrl = first.more; current = await request(currentUrl);
    }
    return bad("Tennessee native More continuation bound exceeded");
  }
  function selectYear(landing: string, electionYear: number): string {
    year(electionYear); const select = /<select\b[^>]*name=["']electionYearSelection["'][^>]*>([\s\S]*?)<\/select>/i.exec(landing);
    const options = [...(select?.[1] ?? "").matchAll(/<option\b[^>]*value=["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/gi)].filter(m => plain(m[2]) === String(electionYear));
    if (options.length !== 1 || !options[0][1]) return invalid("Unavailable/ambiguous Tennessee native election year"); return entities(options[0][1]);
  }
  function fields(form: URLSearchParams, names: string[]): URLSearchParams { for (const name of names) form.set(name + "Field", "true"); form.set("_continue", "Continue"); return form; }
  return {
    fetchContributions(input) {
      nonempty(input.receiverName); year(input.reportYear);
      if (!["candidate", "pac"].includes(input.recipientType) || !["all", "pac"].includes(input.donorScope)) invalid("Invalid Tennessee native contribution scope");
      let occurrenceBase = 0;
      return acquire({ path: "cesearch.htm", csvHeaders: TENNESSEE_NATIVE_CONTRIBUTION_HEADERS, htmlHeaders: TENNESSEE_NATIVE_CONTRIBUTION_HEADERS,
        makeForm(landing) {
          const form = new URLSearchParams({ searchType: "contributions", toType: input.recipientType, recipientName: input.receiverName.trim(), yearSelection: String(input.reportYear), typeOf: "all", fromPAC: "true" });
          if (input.electionYear !== undefined) form.set("electionYearSelection", selectYear(landing, input.electionYear));
          if (input.donorScope === "all") for (const k of ["fromCandidate", "fromIndividual", "fromOrganization"]) form.set(k, "true");
          return fields(form, ["type", "adjustment", "amount", "date", "electionYear", "reportName", "recipientName", "contributorName", "contributorAddress", "contributorOccupation", "contributorEmployer", "description"]);
        },
        convert(csvRows, htmlRows) {
          const projection = (r: Record<string, string>) => TENNESSEE_NATIVE_CONTRIBUTION_HEADERS.map(h => h === "Contributor Address" ? address(r[h]) : normalized(r[h]));
          const native = htmlRows.map(cells => { const r = Object.fromEntries(TENNESSEE_NATIVE_CONTRIBUTION_HEADERS.map((h, i) => [h, h === "Contributor Address" ? plain(cells[i].replace(/<br\s*\/?>/gi, ",")) : plain(cells[i])])); return { fields: projection(r), nativeAddressLines: addressLines(cells[8]), ...reportLink(cells[5]) }; });
          if (!multisetEqual(csvRows.map(projection), native.map(r => r.fields))) return bad("Tennessee native contribution CSV/HTML identity mismatch");
          const buckets = new Map<string, typeof native>(); for (const r of native) { const k = JSON.stringify(r.fields); const b = buckets.get(k) ?? []; b.push(r); buckets.set(k, b); }
          const result = csvRows.map((r, occurrence) => {
            const same = buckets.get(JSON.stringify(projection(r)))!;
            if (new Set(same.map(x => JSON.stringify([x.reportId, x.nativeAddressLines]))).size !== 1) return bad("Ambiguous Tennessee native receipt report identity");
            const linked = same[0]; const rawYear = r["Election Year"].trim();
            if (rawYear && (!/^\d{4}$/.test(rawYear) || Number(rawYear) < 2000 || Number(rawYear) > 2100)) return bad("Invalid Tennessee native row election year");
            if (![r.Type, r["Report Name"], r["Recipient Name"], r["Contributor Name"]].every(v => v.trim())) return bad("Missing Tennessee native contribution identity");
            return { occurrence: occurrenceBase + occurrence, reportId: linked.reportId, reportUrl: linked.reportUrl, type: r.Type, adjustment: r.Adj, amountCents: cents(r.Amount), date: date(r.Date), electionYear: rawYear ? Number(rawYear) : null,
              reportName: r["Report Name"], recipientName: r["Recipient Name"], contributorName: r["Contributor Name"], contributorAddress: r["Contributor Address"], contributorOccupation: r["Contributor Occupation"], contributorEmployer: r["Contributor Employer"], description: r.Description, contributorAddressLines: [...linked.nativeAddressLines], rawFields: r };
          });
          occurrenceBase += result.length; return result;
        } });
    },
    fetchIndependentExpenditures(input) {
      year(input.reportYear); let occurrenceBase = 0;
      return acquire({ path: "cesearch.htm", csvHeaders: TENNESSEE_NATIVE_IE_HEADERS, htmlHeaders: TENNESSEE_NATIVE_IE_HEADERS,
        makeForm: () => fields(new URLSearchParams({ searchType: "expenditures", toType: "both", toCandidate: "true", toPac: "true", toOther: "true", yearSelection: String(input.reportYear), typeOf: "independent" }),
          ["type", "adjustment", "amount", "date", "electionYear", "reportName", "candidatePACName", "vendorName", "vendorAddress", "purpose", "candidateFor", "so"]),
        convert(csvRows, htmlRows) {
          const projection = (r: Record<string, string>) => TENNESSEE_NATIVE_IE_HEADERS.map(h => h === "Vendor Address" ? address(r[h]) : normalized(r[h]));
          const native = htmlRows.map(cells => {
            const r = Object.fromEntries(TENNESSEE_NATIVE_IE_HEADERS.map((h, i) => [h, h === "Vendor Address" ? plain(cells[i].replace(/<br\s*\/?>/gi, ",")) : plain(cells[i])]));
            return { fields: projection(r), nativeAddressLines: addressLines(cells[8]), ...reportLink(cells[5]) };
          });
          if (!multisetEqual(csvRows.map(projection), native.map(r => r.fields))) return bad("Tennessee native IE CSV/HTML identity mismatch");
          const buckets = new Map<string, typeof native>();
          for (const r of native) { const k = JSON.stringify(r.fields); const b = buckets.get(k) ?? []; b.push(r); buckets.set(k, b); }
          const result = csvRows.map<TennesseeVerifiedNativeIndependentExpenditureRow>((r, occurrence) => {
            const same = buckets.get(JSON.stringify(projection(r)))!;
            if (new Set(same.map(x => JSON.stringify([x.reportId, x.nativeAddressLines]))).size !== 1) return bad("Ambiguous Tennessee native IE report identity");
            const linked = same[0]; const rawYear = r["Election Year"].trim();
            if (rawYear && (!/^\d{4}$/.test(rawYear) || Number(rawYear) < 2000 || Number(rawYear) > 2100)) return bad("Invalid Tennessee native IE election year");
            if (r.Type !== "Independent" || !r["Report Name"].trim() || !r["Candidate/PAC Name"].trim() || !r["Vendor Name"].trim()) return bad("Unexpected Tennessee native independent selection/identity");
            const supportOpposeCode = r["S/O"];
            if (supportOpposeCode !== "S" && supportOpposeCode !== "O" && supportOpposeCode !== "") return bad("Invalid Tennessee native IE support/oppose");
            return { occurrence: occurrenceBase + occurrence, reportId: linked.reportId, reportUrl: linked.reportUrl,
              type: "Independent" as const, adjustment: r.Adj, amountCents: cents(r.Amount), date: date(r.Date), electionYear: rawYear ? Number(rawYear) : null,
              reportName: r["Report Name"], payerName: r["Candidate/PAC Name"], vendorName: r["Vendor Name"], vendorAddress: r["Vendor Address"],
              purpose: r.Purpose, targetName: r["Candidate For"], supportOpposeCode, vendorAddressLines: [...linked.nativeAddressLines], rawFields: r };
          });
          occurrenceBase += result.length; return result;
        } });
    },
    fetchPacRegistry() {
      return acquire({ path: "cpsearch.htm", csvHeaders: PAC_HEADERS, htmlHeaders: ["Name", "Committee Affiliation", "Created", "Closed", "Report List"],
        makeForm: () => fields(new URLSearchParams({ searchType: "pac" }), ["name", "committee", "created", "closed"]),
        convert(csvRows, htmlRows) {
          const key = (r: Record<string, string>) => [normalized([r.Salutation, r["First Name"], r["Last Name"]].filter(Boolean).join(" ")), normalized(r["Committee Affiliation"]), normalized(r.Created), normalized(r.Closed)];
          const native = htmlRows.map(cells => ({ fields: cells.slice(0, 4).map(plain), ...registryLink(cells[4]) }));
          if (!multisetEqual(csvRows.map(key), native.map(r => r.fields))) return bad("Tennessee native PAC registry CSV/HTML identity mismatch");
          const buckets = new Map<string, typeof native>(); for (const r of native) { const k = JSON.stringify(r.fields); const b = buckets.get(k) ?? []; b.push(r); buckets.set(k, b); }
          return csvRows.map(r => { const linked = buckets.get(JSON.stringify(key(r)))!.shift()!;
            if (normalized(linked.ownerName) !== key(r)[0]) return bad("Tennessee native PAC owner/name mismatch");
            return { campId: linked.campId, ownerName: linked.ownerName, reportListUrl: linked.reportListUrl, name: key(r)[0], committeeType: "PAC" as const, committeeAffiliation: r["Committee Affiliation"], created: r.Created ? date(r.Created) : null, closed: r.Closed ? date(r.Closed) : null, rawFields: r }; });
        } });
    },
    fetchCandidateContext(input) {
      nonempty(input.name); year(input.electionYear);
      return acquire({ path: "cpsearch.htm", csvHeaders: CANDIDATE_HEADERS, htmlHeaders: ["Name", "Office Sought", "District", "Election Year", "Committee Affiliation", "Created", "Closed", "Report List"],
        makeForm: landing => fields(new URLSearchParams({ searchType: "candidate", name: input.name.trim(), electionYearSelection: selectYear(landing, input.electionYear) }), ["name", "office", "district", "electionYear", "committee", "created", "closed"]),
        convert(csvRows, htmlRows) {
          const key = (r: Record<string, string>) => [normalized([r["Last Name"], r["First Name"]].filter(Boolean).join(", ")), ...["Office Sought", "District", "Election Year", "Committee Affiliation", "Created", "Closed"].map(h => normalized(r[h]))];
          const native = htmlRows.map(cells => ({ fields: cells.slice(0, 7).map(plain), ...registryLink(cells[7]) }));
          if (!multisetEqual(csvRows.map(key), native.map(r => r.fields))) return bad("Tennessee native candidate CSV/HTML identity mismatch");
          const buckets = new Map<string, typeof native>(); for (const r of native) { const k = JSON.stringify(r.fields); const b = buckets.get(k) ?? []; b.push(r); buckets.set(k, b); }
          return csvRows.map(r => { const linked = buckets.get(JSON.stringify(key(r)))!.shift()!;
            if (normalized(linked.ownerName) !== key(r)[0] || r["Election Year"] !== String(input.electionYear) || !r["Office Sought"].trim()) return bad("Tennessee native candidate identity/year mismatch");
            return { campId: linked.campId, ownerName: linked.ownerName, reportListUrl: linked.reportListUrl, name: key(r)[0], officeSought: r["Office Sought"], district: r.District, electionYear: input.electionYear, committeeAffiliation: r["Committee Affiliation"], created: r.Created ? date(r.Created) : null, closed: r.Closed ? date(r.Closed) : null, rawFields: r }; });
        } });
    },
  };
}
