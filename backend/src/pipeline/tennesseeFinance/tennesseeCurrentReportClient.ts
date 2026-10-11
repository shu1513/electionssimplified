import { createHash } from "node:crypto";
import {
  TennesseeCampClientError,
  type TennesseeCampClientOptions,
} from "./tennesseeCampClient.js";

const ORIGIN = "https://apps.tn.gov";
const PUBLIC = "/tncamp/public/";
const REPORT_PATH = "/tncamp/search/pub/report_full.htm";
const DEFAULT_MAX_BYTES = 5_000_000;
const WINDOWS_1252_C1: (number | null)[] = [
  0x20ac, null, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, null, 0x017d, null,
  null, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, null, 0x017e, 0x0178,
];


export type TennesseeCurrentReportManifestRow = {
  campId: string;
  ownerName: string;
  reportId: string;
  electionYear: number | null;
  reportName: string;
  reportYear: number | null;
  amended: boolean;
  submittedDate: string;
  sourceUrl: string;
};
export type TennesseeCurrentReportRawSource = {
  url: string;
  bytes: Uint8Array;
  byteCount: number;
  sha256: string;
  encoding: "utf-8" | "windows-1252";
};
export type TennesseeCurrentReportManifest = {
  rows: TennesseeCurrentReportManifestRow[];
  rawPages: TennesseeCurrentReportRawSource[];
  fingerprint: string;
};
export type TennesseeAuthoritativeReportPeriod = {
  start: string;
  end: string;
  sourceUrl: string;
  sourceContext: string;
};
export type TennesseeCurrentReportCoverField = {
  section: string;
  label: string;
  rawValue: string;
  amountCents: number | null;
};
export type TennesseeCurrentReportSchedule = {
  section: string;
  tableId: string;
  headers: string[];
  /** Every published cell and occurrence, including non-cash schedules. */
  rows: string[][];
  rawHtml: string;
};
export type TennesseeCurrentCashLedgerRow = {
  occurrence: number;
  reportedName: string;
  publishedIdentityLines: string[];
  sourceClass: "" | "C" | "P";
  receivedFor: string | null;
  date: string;
  amountCents: number;
  aggregateCents: number | null;
  rawCells: string[];
};
export type TennesseeCurrentExpenseLedgerRow = {
  occurrence: number;
  vendorName: string;
  publishedIdentityLines: string[];
  sourceClass: "" | "C" | "P";
  purpose: string;
  inKind: string | null;
  independentTargetName: string | null;
  supportOppose: "" | "S" | "O";
  date: string;
  amountCents: number;
  rawCells: string[];
};
export type TennesseeCurrentReport = {
  manifestRow: TennesseeCurrentReportManifestRow;
  heading: string;
  reportedOwnerName: string;
  period: TennesseeAuthoritativeReportPeriod | null;
  covers: TennesseeCurrentReportCoverField[];
  schedules: TennesseeCurrentReportSchedule[];
  cashLedger: TennesseeCurrentCashLedgerRow[];
  expenseLedger: TennesseeCurrentExpenseLedgerRow[];
  rawSource: TennesseeCurrentReportRawSource;
  /** Whole source body, excluding only the observed navigation anchor. */
  fingerprint: string;
  completeFullReport: true;
};
export type TennesseeCurrentReportRawResponse = TennesseeCurrentReportRawSource & {
  method: "GET"; fetchedAt: string;
};
export type TennesseeCurrentReportClientOptions = TennesseeCampClientOptions & {
  maxResponseBytes?: number;
  maxPages?: number;
  onRawResponse?: (response: TennesseeCurrentReportRawResponse) => void | Promise<void>;
};
export type TennesseeCurrentReportClient = {
  fetchManifest(input: { campId: string; ownerName: string }): Promise<TennesseeCurrentReportManifest>;
  fetchReport(input: {
    manifestRow: TennesseeCurrentReportManifestRow;
    expectedPeriod?: TennesseeAuthoritativeReportPeriod;
  }): Promise<TennesseeCurrentReport>;
};

function bad(message: string): never {
  throw new TennesseeCampClientError("bad_response", message);
}
function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function id(value: string, name: string): string {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new TennesseeCampClientError("invalid_request", "Invalid Tennessee " + name);
  }
  return value;
}
function decodeEntities(value: string): string {
  return value.replace(/&#(x[0-9a-f]+|\d+);/gi, (_m, c: string) => {
    const n = c[0].toLowerCase() === "x" ? parseInt(c.slice(1), 16) : Number(c);
    if (!Number.isInteger(n) || n < 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) {
      return bad("Invalid Tennessee HTML entity");
    }
    // HTML numeric character references remap defined C1 values via Windows-1252.
    const mapped = n >= 0x80 && n <= 0x9f ? WINDOWS_1252_C1[n - 0x80] : null;
    return String.fromCodePoint(mapped ?? n);
  }).replace(/&(amp|quot|apos|lt|gt|nbsp|reg|rsquo|lsquo|ndash|mdash);/g, (_m, n: string) =>
    ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", reg: "®",
      rsquo: "’", lsquo: "‘", ndash: "–", mdash: "—" } as Record<string, string>)[n]);
}
function plain(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}
function identityLines(cell: string): string[] {
  return cell.split(/<br\s*\/?>/i).map(plain).filter(Boolean);
}
function isoDate(value: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!m) return bad("Invalid Tennessee report date: " + value);
  const iso = m[3] + "-" + m[1] + "-" + m[2];
  return validateIso(iso);
}
function validateIso(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return bad("Invalid Tennessee ISO report date");
  const date = new Date(value + "T00:00:00Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    return bad("Invalid Tennessee calendar date");
  }
  return value;
}
function money(value: string): number {
  const normalized = value.replace(/\s/g, "");
  // Source signed currency is retained; a caller decides whether returns are supported.
  if (!/^-?\$?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{2})?$/.test(normalized)) {
    return bad("Invalid Tennessee report money: " + value);
  }
  const clean = normalized.replace(/[$,]/g, "");
  const negative = clean.startsWith("-");
  const [whole, fraction = "00"] = clean.replace(/^-/, "").split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return bad("Unsafe Tennessee report cents");
  return Number(cents) * (negative ? -1 : 1);
}
function sourceClass(value: string): "" | "C" | "P" {
  if (value !== "" && value !== "C" && value !== "P") return bad("Unknown Tennessee ledger C/P");
  return value;
}
function officialUrl(value: string, base: string, path: string): URL {
  const decoded = decodeEntities(value);
  const u = new URL(decoded, base);
  if (u.origin !== ORIGIN || u.pathname !== path || u.username || u.password || u.hash ||
      u.port || /^https:\/\/[^/?#]*:/i.test(decoded)) {
    return bad("Tennessee report URL outside exact official endpoint");
  }
  return u;
}
function reportUrl(value: string, base: string, expectedId?: string): URL {
  const u = officialUrl(value, base, REPORT_PATH);
  const reportId = id(u.searchParams.get("reportId") ?? "", "report ID");
  if (u.search !== "?reportId=" + reportId || (expectedId !== undefined && reportId !== expectedId)) {
    return bad("Tennessee report URL requires one canonical reportId");
  }
  return u;
}
function assertHtml(html: string): void {
  if (!/<html\b/i.test(html) || !/<\/html\s*>/i.test(html) ||
      /<input[^>]+type\s*=\s*["']?password\b/i.test(html) ||
      /(?:too many results|maximum number of results|access denied|_Incapsula_Resource)/i.test(html)) {
    bad("Incomplete, login, challenge or capped Tennessee report response");
  }
}
function cells(row: string, tag: "td" | "th"): string[] {
  const matches = [...row.matchAll(new RegExp("<" + tag + "\\b[^>]*>([\\s\\S]*?)<\\/" + tag + "\\s*>", "gi"))];
  if ((row.match(new RegExp("<" + tag + "\\b", "gi")) ?? []).length !== matches.length) {
    return bad("Unclosed Tennessee table cell");
  }
  return matches.map(m => m[1]);
}
function closedRows(table: string): string[] {
  const matches = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)];
  if ((table.match(/<tr\b/gi) ?? []).length !== matches.length) return bad("Unclosed Tennessee table row");
  return matches.map(m => m[1]);
}
function nextHref(html: string, base: string, campId: string, expectedPage: number): string | null {
  const block = /<span\b[^>]*class=["']pagelinks["'][^>]*>([\s\S]*?)<\/span>/i.exec(html)?.[1] ?? "";
  const next = [...block.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .find(m => plain(m[2]) === "Next");
  if (!next) return null;
  const u = officialUrl(next[1], base, PUBLIC + "replist.htm");
  if (u.searchParams.get("id") !== campId ||
      u.searchParams.get("d-1341904-p") !== String(expectedPage)) {
    return bad("Invalid Tennessee manifest pagination identity");
  }
  return u.toString();
}

export function decodeTennesseeCurrentReportBytes(bytes: Uint8Array): {
  html: string; encoding: TennesseeCurrentReportRawSource["encoding"];
} {
  try {
    return { html: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    // WHATWG TextDecoder windows-1252 leaves C1 bytes unchanged in some Node versions.
    const chars = Array.from(bytes, b => {
      if (b >= 0x80 && b <= 0x9f) {
        const mapped = WINDOWS_1252_C1[b - 0x80];
        if (mapped === null) return bad("Undefined CP1252 byte in Tennessee source");
        return String.fromCodePoint(mapped);
      }
      return String.fromCharCode(b);
    });
    return { html: chars.join(""), encoding: "windows-1252" };
  }
}

export function parseTennesseeCurrentReportManifestPage(input: {
  html: string; campId: string; ownerName: string; sourceUrl: string; pageNumber: number;
}): { rows: TennesseeCurrentReportManifestRow[]; total: number; nextUrl: string | null } {
  assertHtml(input.html);
  const u = officialUrl(input.sourceUrl, ORIGIN, PUBLIC + "replist.htm");
  if (u.searchParams.get("id") !== input.campId || u.searchParams.get("owner") !== input.ownerName) {
    return bad("Tennessee manifest CAMP/owner request mismatch");
  }
  const ownerHeading = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(input.html);
  if (plain(ownerHeading?.[1] ?? "") !== "Reports for " + input.ownerName) {
    return bad("Tennessee manifest receiver heading mismatch");
  }
  const totalMatch = /([\d,]+) results found(?:, displaying ([\d,]+) to ([\d,]+))?\./i.exec(input.html);
  const one = /One result found\./i.test(input.html);
  const none = /(?:No results found|No results were found)\./i.test(input.html);
  if (!totalMatch && !one && !none) return bad("Missing Tennessee manifest complete count");
  const total = totalMatch ? Number(totalMatch[1].replace(/,/g, "")) : one ? 1 : 0;
  if (!Number.isSafeInteger(total) || total < 0) return bad("Unsafe Tennessee manifest count");
  const table = /<table\b[^>]*id=["']results["'][^>]*>([\s\S]*?)<\/table>/i.exec(input.html);
  if (!table) return bad("Missing Tennessee report manifest table");
  const allRows = closedRows(table[1]);
  const headers = cells(allRows[0] ?? "", "th").map(plain);
  if (headers.join("|") !== "Election|Report Name|A|Submitted On") return bad("Tennessee manifest schema changed");
  const rows: TennesseeCurrentReportManifestRow[] = [];
  for (const row of allRows.slice(1)) {
    const values = cells(row, "td");
    if (values.length !== 4) return bad("Tennessee manifest row width mismatch");
    const texts = values.map(plain);
    const link = /<a\b[^>]*href=["']([^"']+)["']/i.exec(values[1]);
    if (!link) return bad("Tennessee manifest report link missing");
    const report = reportUrl(link[1], input.sourceUrl);
    if ([...report.searchParams.keys()].join("|") !== "reportId") return bad("Unexpected Tennessee report parameters");
    const reportId = id(report.searchParams.get("reportId") ?? "", "report ID");
    if ((texts[0] !== "" && (!/^\d{4}$/.test(texts[0]) || Number(texts[0]) < 2000 || Number(texts[0]) > 2100)) ||
        !texts[1] || (texts[2] !== "" && texts[2] !== "Y")) return bad("Invalid Tennessee manifest fields");
    const year = /(?:^|\s)(20\d{2})$/.exec(texts[1]);
    rows.push({ campId: input.campId, ownerName: input.ownerName, reportId,
      electionYear: texts[0] === "" ? null : Number(texts[0]), reportName: texts[1], reportYear: year ? Number(year[1]) : null,
      amended: texts[2] === "Y", submittedDate: isoDate(texts[3]), sourceUrl: report.toString() });
  }
  if (totalMatch?.[2]) {
    const start = Number(totalMatch[2].replace(/,/g, ""));
    const end = Number(totalMatch[3].replace(/,/g, ""));
    if (start !== (input.pageNumber - 1) * 50 + 1 || end !== start + rows.length - 1 ||
        end > total || rows.length > 50) return bad("Tennessee manifest range/count mismatch");
  } else if (rows.length !== total) return bad("Tennessee manifest count mismatch");
  return { rows, total, nextUrl: nextHref(input.html, input.sourceUrl, input.campId, input.pageNumber + 1) };
}

function sectionBefore(html: string, index: number): string {
  const headings = [...html.slice(0, index).matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)];
  return plain(headings.at(-1)?.[1] ?? "");
}
function validatePeriod(period?: TennesseeAuthoritativeReportPeriod): TennesseeAuthoritativeReportPeriod | null {
  if (!period) return null;
  validateIso(period.start); validateIso(period.end);
  const source = new URL(period.sourceUrl);
  if (period.start > period.end || source.protocol !== "https:" || source.username || source.password || source.hash || source.port ||
      (period.sourceUrl.match(/^https:\/\/([^/?#]+)/)?.[1] ?? "").includes(":") || !(source.hostname === "tn.gov" || source.hostname.endsWith(".tn.gov")) || !period.sourceContext.trim()) {
    return bad("Invalid authoritative Tennessee calendar provenance");
  }
  return { ...period };
}

export function parseTennesseeCurrentReport(input: {
  rawSource: TennesseeCurrentReportRawSource;
  manifestRow: TennesseeCurrentReportManifestRow;
  expectedPeriod?: TennesseeAuthoritativeReportPeriod;
}): TennesseeCurrentReport {
  const { html, encoding } = decodeTennesseeCurrentReportBytes(input.rawSource.bytes);
  assertHtml(html);
  const row = input.manifestRow;
  reportUrl(row.sourceUrl, ORIGIN, row.reportId);
  const source = reportUrl(input.rawSource.url, ORIGIN, row.reportId);
  if (source.searchParams.get("reportId") !== row.reportId ||
      digest(input.rawSource.bytes) !== input.rawSource.sha256 ||
      input.rawSource.byteCount !== input.rawSource.bytes.byteLength || encoding !== input.rawSource.encoding) return bad("Tennessee raw report integrity mismatch");
  const headingMatch = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const heading = plain(headingMatch?.[1] ?? "");
  const h = /^(Amended )?(?:(\d{4}) )?(.+?) for (.+?) submitted on (\d{2}\/\d{2}\/\d{4})$/.exec(heading);
  if (!h || !!h[1] !== row.amended || (h[2] !== undefined && Number(h[2]) !== row.electionYear) ||
      isoDate(h[5]) !== row.submittedDate) return bad("Tennessee report heading/manifest mismatch");
  const parenthesizedYear = /\s*\((\d{4})\)$/.exec(h[3]);
  const reportLabel = h[3].replace(/\s*\(\d{4}\)$/, "");
  const manifestLabel = row.reportName.replace(/\s+20\d{2}$/, "");
  const publishedReportYear = parenthesizedYear ? Number(parenthesizedYear[1]) : h[2] ? Number(h[2]) : null;
  if (reportLabel !== manifestLabel || (publishedReportYear !== null && publishedReportYear !== row.reportYear)) {
    return bad("Tennessee report label differs from manifest");
  }
  const ownerParts = row.ownerName.split(",").map(part => part.trim());
  const displayOwner = ownerParts.length === 2 ? ownerParts[1] + " " + ownerParts[0] : row.ownerName;
  if (plain(h[4]) !== plain(displayOwner)) return bad("Tennessee report receiver differs from manifest");
  for (const m of html.matchAll(/href=["']([^"']*reportId=[^"']*)["']/gi)) {
    const linked = new URL(decodeEntities(m[1]), source);
    if (linked.origin !== ORIGIN || linked.searchParams.get("reportId") !== row.reportId) {
      return bad("Tennessee report contains conflicting report identity");
    }
  }
  const covers: TennesseeCurrentReportCoverField[] = [];
  for (const m of html.matchAll(/<div class=["']row control-group report-row[^"']*["']>\s*<div[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*>([\s\S]*?)<\/div>/gi)) {
    const label = plain(m[1]), rawValue = plain(m[2]);
    if (!label) return bad("Empty Tennessee cover label");
    covers.push({ section: sectionBefore(html, m.index!), label, rawValue,
      amountCents: rawValue === "" ? null : money(rawValue) });
  }
  const required = ["Beginning Balance", "Monetary Contributions, Unitemized",
    "TOTAL CONTRIBUTIONS (other than adjustments, loans, and interest)", "Contribution Adjustments",
    "Loans Received", "Interest Received This Reporting Period", "TOTAL RECEIPTS",
    "Expenditures, Unitemized", "TOTAL DISBURSEMENTS", "ENDING BALANCE"];
  for (const label of required) {
    if (covers.filter(c => c.label === label && c.amountCents !== null).length !== 1) {
      return bad("Missing/ambiguous Tennessee cover: " + label);
    }
  }
  const schedules: TennesseeCurrentReportSchedule[] = [];
  const tableMatches = [...html.matchAll(/<table\b[^>]*id=["']([^"']+)["'][^>]*>([\s\S]*?)<\/table>/gi)];
  if ((html.match(/<table\b/gi) ?? []).length !== tableMatches.length ||
      (html.match(/<\/table\s*>/gi) ?? []).length !== tableMatches.length) return bad("Incomplete Tennessee schedule table");
  const cashLedger: TennesseeCurrentCashLedgerRow[] = [];
  const expenseLedger: TennesseeCurrentExpenseLedgerRow[] = [];
  for (const m of tableMatches) {
    const section = sectionBefore(html, m.index!);
    const tableRows = closedRows(m[2]);
    const headers = cells(tableRows[0] ?? "", "th").map(plain);
    if (!headers.length) return bad("Missing Tennessee schedule headers");
    const rawRows = tableRows.slice(1).map(r => cells(r, "td"));
    if (rawRows.some(r => r.length !== headers.length)) return bad("Tennessee schedule width changed");
    const textRows = rawRows.map(r => r.map(plain));
    schedules.push({ section, tableId: m[1], headers, rows: textRows, rawHtml: m[0] });
    if (section === "Receipts" && m[1] === "contribution") {
      const candidate = headers.join("|") === "Contributor|C/P|Rec'd For|Date|Amount|Aggregate";
      const pac = headers.join("|") === "Contributor|C/P|Date|Amount";
      if (!candidate && !pac) return bad("Tennessee cash ledger schema changed");
      rawRows.forEach((r, n) => {
        const values = r.map(plain), lines = identityLines(r[0]);
        if (!lines.length) return bad("Missing Tennessee cash contributor");
        cashLedger.push({ occurrence: n + 1, reportedName: lines[0], publishedIdentityLines: lines,
          sourceClass: sourceClass(values[1]), receivedFor: candidate ? values[2] || null : null,
          date: isoDate(values[candidate ? 3 : 2]), amountCents: money(values[candidate ? 4 : 3]),
          aggregateCents: candidate ? money(values[5]) : null, rawCells: values });
      });
    } else if (section === "Disbursements" && m[1] === "expenditure") {
      const candidate = headers.join("|") === "Vendor|C/P|Purpose|Date|Amount";
      const pac = headers.join("|") === "Vendor|C/P|Purpose|In-Kind|Independent|S/O|Date|Amount";
      if (!candidate && !pac) return bad("Tennessee expense ledger schema changed");
      rawRows.forEach((r, n) => {
        const values = r.map(plain), lines = identityLines(r[0]);
        if (!lines.length) return bad("Missing Tennessee vendor");
        const stance = pac ? values[5] : "";
        if (stance !== "" && stance !== "S" && stance !== "O") return bad("Unknown Tennessee S/O");
        expenseLedger.push({ occurrence: n + 1, vendorName: lines[0], publishedIdentityLines: lines,
          sourceClass: sourceClass(values[1]), purpose: values[2], inKind: pac ? values[3] || null : null,
          independentTargetName: pac ? values[4] || null : null, supportOppose: stance,
          date: isoDate(values[pac ? 6 : 3]), amountCents: money(values[pac ? 7 : 4]), rawCells: values });
      });
    }
  }
  // Full endpoint normally renders every schedule without paging. Do not accept a partial ledger.
  if (/<span\b[^>]*class=["'](?:pagebanner|pagelinks)["'][^>]*>\s*[^<\s]/i.test(html) ||
      /<a\b[^>]*>\s*(?:Next|More)\s*<\/a>/i.test(html)) return bad("Partial Tennessee full-report schedule");
  const cashCover = covers.find(c => c.label.startsWith("TOTAL CONTRIBUTIONS "))!.amountCents!;
  const unitemized = covers.find(c => c.label === "Monetary Contributions, Unitemized")!.amountCents!;
  const cashSum = cashLedger.reduce((sum, r) => sum + BigInt(r.amountCents), BigInt(unitemized));
  if (cashSum > BigInt(Number.MAX_SAFE_INTEGER) || cashSum < -BigInt(Number.MAX_SAFE_INTEGER) ||
      cashSum !== BigInt(cashCover)) {
    return bad("Tennessee full cash schedule/cover mismatch");
  }
  // Ignore only this source-observed nonfinancial navigation anchor; preserve everything else.
  if ((html.match(/<a\b[^>]*>\s*Back to Search Results\s*<\/a>/gi) ?? []).length > 1) {
    return bad("Ambiguous Tennessee report navigation anchors");
  }
  const canonical = html.replace(/<a\b[^>]*>\s*Back to Search Results\s*<\/a>/gi, "");
  return { manifestRow: { ...row }, heading, reportedOwnerName: h[4], period: validatePeriod(input.expectedPeriod),
    covers, schedules, cashLedger, expenseLedger, rawSource: input.rawSource,
    fingerprint: digest(canonical), completeFullReport: true };
}

function mergeCookie(existing: string, headers: Headers): string {
  const getter = headers as Headers & { getSetCookie?: () => string[] };
  const set = getter.getSetCookie?.() ?? (headers.get("set-cookie")?.split(/,(?=\s*[^;,=\s]+=)/) ?? []);
  const jar = new Map(existing.split(/;\s*/).filter(Boolean).map(c => {
    const pos = c.indexOf("="); return [c.slice(0, pos), c.slice(pos + 1)] as [string, string];
  }));
  for (const cookie of set) {
    const first = cookie.split(";")[0], pos = first.indexOf("=");
    if (pos > 0) jar.set(first.slice(0, pos), first.slice(pos + 1));
  }
  return [...jar].map(([k, v]) => k + "=" + v).join("; ");
}

export function createTennesseeCurrentReportClient(
  options: TennesseeCurrentReportClientOptions = {}
): TennesseeCurrentReportClient {
  let cookie = "", bootstrapped = false;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_BYTES;
  const maxPages = options.maxPages ?? 100;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(maxPages) || maxPages <= 0) {
    throw new TennesseeCampClientError("invalid_request", "Invalid Tennessee acquisition bounds");
  }
  async function get(url: string): Promise<TennesseeCurrentReportRawSource> {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), options.timeoutMs ?? 30_000);
    try {
      const response = await (options.fetchImpl ?? fetch)(url, {
        headers: { accept: "text/html", "user-agent": "Mozilla/5.0", ...(cookie ? { cookie } : {}) },
        signal: abort.signal,
      });
      if (!response.ok) throw new TennesseeCampClientError("http_error", "Tennessee report HTTP error", response.status);
      if (response.url && new URL(response.url).origin !== ORIGIN) return bad("Tennessee report redirected outside official origin");
      const contentType = response.headers.get("content-type");
      if (contentType && !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType)) {
        return bad("Tennessee response is not HTML");
      }
      cookie = mergeCookie(cookie, response.headers);
      if (Number(response.headers.get("content-length")) > maxBytes) return bad("Tennessee source exceeds byte bound");
      const chunks: Uint8Array[] = [];
      let count = 0;
      if (!response.body) return bad("Missing Tennessee source body");
      const reader = response.body.getReader();
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          count += result.value.length;
          if (count > maxBytes) { await reader.cancel(); return bad("Tennessee source exceeds byte bound"); }
          chunks.push(result.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(count);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const decoded = decodeTennesseeCurrentReportBytes(bytes);
      const raw = { url, bytes, byteCount: count, sha256: digest(bytes), encoding: decoded.encoding };
      await options.onRawResponse?.(Object.freeze({ ...raw, bytes: bytes.slice(), method: "GET", fetchedAt: new Date().toISOString() }));
      assertHtml(decoded.html);
      return raw;
    } catch (error) {
      if (error instanceof TennesseeCampClientError) throw error;
      throw new TennesseeCampClientError("network_error", "Tennessee report acquisition failed: " +
        (error instanceof Error ? error.message : String(error)));
    } finally { clearTimeout(timeout); }
  }
  async function bootstrap(): Promise<void> {
    if (bootstrapped) return;
    const landing = await get(ORIGIN + PUBLIC + "cpsearch.htm");
    if (!/\b(?:Search Candidates|frmCandidates)\b/.test(decodeTennesseeCurrentReportBytes(landing.bytes).html)) {
      return bad("Tennessee public session bootstrap is not candidate search");
    }
    bootstrapped = true;
  }
  return {
    async fetchManifest(input) {
      id(input.campId, "CAMP ID");
      if (!input.ownerName.trim() || input.ownerName !== input.ownerName.trim()) {
        throw new TennesseeCampClientError("invalid_request", "Tennessee owner name required");
      }
      await bootstrap();
      const start = new URL(ORIGIN + PUBLIC + "replist.htm");
      start.searchParams.set("id", input.campId); start.searchParams.set("owner", input.ownerName);
      let url: string | null = start.toString(), page = 1, total: number | null = null;
      const rows: TennesseeCurrentReportManifestRow[] = [], rawPages: TennesseeCurrentReportRawSource[] = [];
      const visited = new Set<string>(), ids = new Set<string>();
      while (url) {
        if (page > maxPages || visited.has(url)) return bad("Tennessee manifest pagination exceeds bound or repeats");
        visited.add(url);
        const raw = await get(url); rawPages.push(raw);
        const parsed = parseTennesseeCurrentReportManifestPage({
          html: decodeTennesseeCurrentReportBytes(raw.bytes).html, ...input, sourceUrl: url, pageNumber: page,
        });
        if (total !== null && total !== parsed.total) return bad("Tennessee manifest total changed during pagination");
        total = parsed.total;
        for (const row of parsed.rows) {
          if (ids.has(row.reportId)) return bad("Repeated Tennessee manifest report ID");
          ids.add(row.reportId); rows.push(row);
        }
        url = parsed.nextUrl; page++;
      }
      if (rows.length !== total) return bad("Incomplete Tennessee report manifest");
      const sorted = [...rows].sort((a, b) => Number(a.reportId) - Number(b.reportId));
      return { rows, rawPages, fingerprint: digest(JSON.stringify(sorted)) };
    },
    async fetchReport(input) {
      id(input.manifestRow.reportId, "report ID"); id(input.manifestRow.campId, "CAMP ID");
      const u = reportUrl(input.manifestRow.sourceUrl, ORIGIN, input.manifestRow.reportId);
      if (u.searchParams.get("reportId") !== input.manifestRow.reportId) return bad("Report request ID mismatch");
      await bootstrap();
      const rawSource = await get(u.toString());
      return parseTennesseeCurrentReport({ ...input, rawSource });
    },
  };
}
