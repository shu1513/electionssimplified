import { createHash } from "node:crypto";
import type { FloridaProcessedRawEvidence } from "./floridaProcessedFinanceSource.js";
import {
  fingerprintFloridaCommitteeDonorRegistrations,
  resolveFloridaCommitteeDonorIdentity,
  type FloridaCommitteeDateEvidence,
  type FloridaCommitteeDonorIdentityResult,
  type FloridaCommitteeDonorRegistration,
} from "./floridaCommitteeDonorIdentity.js";

export type FloridaCommitteeNameRow = {
  committeeId: string; committeeName: string; committeeType: string; status: string;
  sourceUrl: string; rawFields: readonly string[];
};
export type FloridaCommitteeDetail = {
  committeeId: string; committeeName: string; committeeType: string; status: string;
  address: string; cityStateZip: string; addressLines: readonly string[];
  sourceUrl: string; fullFields: Readonly<Record<string, string>>;
};
export type FloridaCommitteeRegistryRequest = {
  url: string; method: "GET" | "POST"; financeFields: Readonly<Record<string, string>> | null;
  phase?: "opening" | "closing"; // Application instruction, never invented finance fields.
};
/** Human-reviewed account/date binding; this adapter does not infer PDF identity or dates. */
export type FloridaReviewedCommitteeDates = {
  committeeId: string;
  registration?: (
    | { effectiveDate: string; activeBy?: never }
    | { activeBy: string; effectiveDate?: never }
  ) & { document: FloridaProcessedRawEvidence };
  disbandment?: (
    | { effectiveDate: string; closedBy?: never }
    | { closedBy: string; effectiveDate?: never }
  ) & { document: FloridaProcessedRawEvidence };
};
export type FloridaCommitteeRegistryLookupResult = FloridaCommitteeDonorIdentityResult & {
  sourceHashes: readonly string[];
  registrations?: readonly FloridaCommitteeDonorRegistration[];
};
const ORIGIN = "https://dos.elections.myflorida.com";
const SEARCH = ORIGIN + "/committees/ComLkupByName.asp";
const MAX_ROWS = 80; // Application bound, not a claim about the government's undocumented cap.
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const display = (s: string) => s.trim().replace(/\s+/gu, " ");
const exact = (s: string) => display(s).toUpperCase();
function fail(s: string): never { throw new Error("Florida committee registry: " + s); }
function id(s: string): string {
  if (!/^[1-9][0-9]*$/.test(s) || !Number.isSafeInteger(Number(s))) fail("invalid public account");
  return s;
}
function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    const key = m[1]!.toLowerCase();
    if (key in out) fail("duplicate HTML attribute");
    out[key] = entities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}
function entities(s: string): string {
  const basic: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  const c1: Record<number, number> = { 128: 8364, 130: 8218, 131: 402, 132: 8222, 133: 8230,
    134: 8224, 135: 8225, 136: 710, 137: 8240, 138: 352, 139: 8249, 140: 338, 142: 381,
    145: 8216, 146: 8217, 147: 8220, 148: 8221, 149: 8226, 150: 8211, 151: 8212,
    152: 732, 153: 8482, 154: 353, 155: 8250, 156: 339, 158: 382, 159: 376 };
  return s.replace(/&([a-z]+|#\d+|#x[\da-f]+);/gi, (_, token: string) => {
    if (basic[token.toLowerCase()] !== undefined) return basic[token.toLowerCase()]!;
    if (!token.startsWith("#")) fail("unsupported HTML entity");
    const n = token.toLowerCase().startsWith("#x") ? parseInt(token.slice(2), 16) : Number(token.slice(1));
    if (!Number.isInteger(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) fail("invalid HTML entity");
    return String.fromCodePoint(c1[n] ?? n);
  });
}
const text = (s: string) => display(entities(s.replace(/<[^>]*>/g, " ")));
function checkedRaw(raw: FloridaProcessedRawEvidence, expected: FloridaCommitteeRegistryRequest, pdf = false): string {
  if (!(raw.bytesRaw instanceof Uint8Array) || !raw.bytesRaw.length || raw.bytesRaw.length > 2 * 1024 * 1024 ||
    raw.status !== 200 || raw.method !== expected.method || sha(raw.bytesRaw) !== raw.sha256 ||
    !/^[a-f0-9]{64}$/.test(raw.sha256)) fail("invalid raw response/hash/status");
  let u: URL;
  try { u = new URL(raw.url); } catch { return fail("invalid official URL"); }
  if (u.origin !== ORIGIN || u.username || u.password || u.hash || raw.url !== expected.url) fail("wrong official request URL");
  const start = Date.parse(raw.startedAt), end = Date.parse(raw.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) fail("invalid capture interval");
  const a = raw.financeFields, b = expected.financeFields;
  if ((a === null) !== (b === null) || (a !== null && b !== null &&
    JSON.stringify(Object.entries(a).sort()) !== JSON.stringify(Object.entries(b).sort()))) fail("wrong actual request fields");
  if (pdf) {
    if (!raw.contentType.toLowerCase().includes("pdf") || Buffer.from(raw.bytesRaw).subarray(0, 5).toString() !== "%PDF-") fail("invalid reviewed PDF source");
    return "";
  }
  if (!raw.contentType.toLowerCase().includes("html")) fail("wrong HTML content type");
  let html: string;
  try { html = new TextDecoder("utf-8", { fatal: true }).decode(raw.bytesRaw); } catch { return fail("unproven HTML encoding"); }
  if (!/<\/html\s*>/i.test(html) || !/<\/body\s*>/i.test(html) ||
    /internal server error|runtime error|access denied|<input[^>]+type=["']?password/i.test(html)) fail("incomplete/error/login HTML");
  return html.replace(/<!--[\s\S]*?-->/g, "");
}
function tables(html: string): string[] {
  const stack: number[] = [], out: string[] = [];
  for (const m of html.matchAll(/<table\b[^>]*>|<\/table\s*>/gi)) {
    if (!m[0].startsWith("</")) stack.push(m.index!);
    else {
      const start = stack.pop(); if (start === undefined) fail("unbalanced table");
      out.push(html.slice(start, m.index! + m[0].length));
    }
  }
  if (stack.length) fail("unclosed table");
  return out;
}
function tableRows(table: string): string[][] {
  if ((table.match(/<table\b/gi) ?? []).length !== 1) fail("nested result table");
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)];
  if (rows.length !== (table.match(/<tr\b/gi) ?? []).length ||
    rows.length !== (table.match(/<\/tr\s*>/gi) ?? []).length) fail("incomplete result row");
  return rows.map(m => {
    const cells = [...m[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td\s*>/gi)].map(x => x[1]!);
    if (cells.length !== (m[1]!.match(/<td\b/gi) ?? []).length ||
      cells.length !== (m[1]!.match(/<\/td\s*>/gi) ?? []).length) fail("incomplete result cell");
    return cells;
  });
}
function detailUrl(s: string, expectedId?: string): string {
  const u = new URL(s, SEARCH);
  if (u.origin !== ORIGIN || u.username || u.password || u.hash || u.pathname !== "/committees/ComDetail.asp" ||
    [...u.searchParams.keys()].length !== 1) fail("wrong public account href");
  const account = id(u.searchParams.get("account") ?? "");
  const canonical = ORIGIN + "/committees/ComDetail.asp?account=" + account;
  if (u.href !== canonical || (expectedId && account !== expectedId)) fail("noncanonical/wrong account href");
  return canonical;
}
const fields = (prefix: string) => ({ searchtype: "1", comName: prefix, LkupTypeName: "L", NameSearchBtn: "Search by Name" });
function prefix(s: string): string {
  if (!s || s !== display(s) || s.length >= 30 || /[\r\n\0]/.test(s)) fail("invalid bounded literal prefix");
  return s;
}
export function decodeFloridaCommitteeNameSearch(raw: FloridaProcessedRawEvidence, options: { prefix: string }): readonly FloridaCommitteeNameRow[] {
  const p = prefix(options.prefix);
  const html = checkedRaw(raw, { url: SEARCH, method: "POST", financeFields: fields(p) });
  if (!/Search for Committee by Name/i.test(text(html))) fail("wrong name search page");
  const echoes = (html.match(/<input\b[^>]*>/gi) ?? []).map(attrs).filter(a => a.name?.toLowerCase() === "comname");
  if (echoes.length !== 1 || echoes[0]!.value !== p) fail("wrong source search echo");
  if (/\b(?:results truncated|maximum results|first \d+ results|page \d+ of \d+)\b/i.test(text(html)) ||
    [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].some(a => /^(?:next|previous|prev|last|first)(?: page)?$/i.test(text(a[1]!)))) fail("unproven capped/paged search");
  const noRecords = [...html.matchAll(/<font\b[^>]*>([\s\S]*?)<\/font\s*>/gi)]
    .filter(m => text(m[1]!) === "** No records found for criteria");
  if (noRecords.length) {
    const financialHeaderCell = [...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td\s*>/gi)]
      .some(m => ["Committee", "Type", "Status"].includes(text(m[1]!)));
    if (noRecords.length !== 1 || /ComDetail\.asp/i.test(html) || financialHeaderCell)
      fail("contradictory no-record result");
    return []; // Exact source statement of this bounded query's absence, never financial zero.
  }
  const candidate = tables(html).filter(t => !/<table\b[^>]*>[\s\S]*<table\b/i.test(t))
    .filter(t => {
      const first = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/i.exec(t);
      const cells = first ? [...first[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td\s*>/gi)] : [];
      return cells.map(c => text(c[1]!)).join("|") === "Committee|Type|Status";
    });
  if (candidate.length !== 1) fail("missing/ambiguous result table");
  const rows = tableRows(candidate[0]!).slice(1);
  if (rows.length > MAX_ROWS) fail("bounded lookup row limit");
  const ids = new Set<string>();
  return rows.map(c => {
    if (c.length !== 3) fail("wrong result width");
    const links = [...c[0]!.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
    if (links.length !== 1) fail("missing/ambiguous public account");
    const sourceUrl = detailUrl(attrs(links[0]![1]!).href ?? "");
    const committeeId = new URL(sourceUrl).searchParams.get("account")!;
    if (ids.has(committeeId)) fail("repeated source account in one query");
    ids.add(committeeId);
    const committeeName = text(links[0]![2]!), committeeType = text(c[1]!), status = text(c[2]!);
    if (!committeeName || !exact(committeeName).startsWith(exact(p)) || !/^[A-Z][A-Z0-9]{1,7}$/.test(committeeType) || !status) fail("invalid result identity/scope");
    return { committeeId, committeeName, committeeType, status, sourceUrl, rawFields: c.map(text) };
  });
}
const descriptions: Readonly<Record<string, string>> = {
  "Political Committee": "PAC", "Committee of Continuous Existence": "CCE",
  "Party Executive Committee": "PTY", "Affiliated Party Committee": "PAP",
  "Electioneering Communications Organization": "ECO",
  "Electioneering Communications Individual": "ECI", "Independent Expenditures Organization": "IXO",
};
function projectPurposeContinuation(html: string): string {
  const starts = [...html.matchAll(/<tr\b/gi)].map(m => m.index!);
  const label = (part: string) => {
    const first = /<td\b[^>]*>([\s\S]*?)<\/td\s*>/i.exec(part);
    return first ? text(first[1]!) : "";
  };
  for (let i = 1; i + 1 < starts.length; i++) {
    const previous = html.slice(starts[i - 1], starts[i]);
    const part = html.slice(starts[i], starts[i + 1]);
    const next = html.slice(starts[i + 1], starts[i + 2] ?? html.length);
    // Observed Purpose continuation uses implicit HTML td/tr closure before Affiliations.
    if (label(previous) === "Purpose:" && label(next) === "Affiliations:" &&
      label(part) === "" && !/<\/tr\s*>/i.test(part) &&
      (part.match(/<td\b/gi) ?? []).length === 2 &&
      (part.match(/<\/td\s*>/gi) ?? []).length === 1 &&
      !/<table\b|<\/table\b/i.test(part)) {
      return html.slice(0, starts[i + 1]) + "</td></tr>" + html.slice(starts[i + 1]);
    }
  }
  return html;
}
export function decodeFloridaCommitteeDetail(raw: FloridaProcessedRawEvidence, options: { committeeId: string }): FloridaCommitteeDetail {
  const committeeId = id(options.committeeId), sourceUrl = detailUrl(ORIGIN + "/committees/ComDetail.asp?account=" + committeeId, committeeId);
  const html = checkedRaw(raw, { url: sourceUrl, method: "GET", financeFields: null });
  if (!/Committee Tracking System/i.test(text(html))) fail("wrong account detail page");
  const accounts = (html.match(/<input\b[^>]*>/gi) ?? []).map(attrs).filter(a => a.name?.toLowerCase() === "account");
  if (accounts.length !== 1 || accounts[0]!.value !== committeeId) fail("wrong source account field");
  const names = [...html.matchAll(/<font\b[^>]*size\s*=\s*["']?\+1["']?[^>]*>([\s\S]*?)<\/font>/gi)].map(m => text(m[1]!));
  if (names.length !== 1 || !names[0]) fail("missing/ambiguous legal name heading");
  // Observed legacy account template closes an unopened wrapper after the complete table.
  // This exact scaffold projection changes no account row/cell or retained source field.
  const accountHtml = (html.match(/<table\b/gi) ?? []).length === 1 &&
    (html.match(/<\/table\s*>/gi) ?? []).length === 2
    ? html.replace(/(<\/table\s*>)\s*<\/td\s*>\s*<\/tr\s*>\s*<\/table\s*>/i, "$1")
    : html;
  const accountTables = tables(accountHtml);
  const rows = tables(projectPurposeContinuation(accountHtml))
    .filter(t => !/<table\b[^>]*>[\s\S]*<table\b/i.test(t)).flatMap(tableRows);
  const fullFields: Record<string, string> = {__sourceAccountTables: JSON.stringify(accountTables)};
  let addressLines: string[] | undefined;
  for (const c of rows) {
    if (c.length !== 2) continue;
    const key = text(c[0]!).replace(/:$/, "");
    if (!key || !/:$/.test(text(c[0]!))) continue;
    if (key in fullFields) fail("duplicate account detail field");
    fullFields[key] = c[1]!; // All source field markup retained, including future fields.
    if (key === "Address") addressLines = c[1]!.split(/<br\s*\/?>/i).map(text).filter(Boolean);
  }
  if (!fullFields.Type || !fullFields.Status || !addressLines || addressLines.length < 2) fail("missing legal type/status/full address");
  const committeeType = descriptions[text(fullFields.Type)];
  if (!committeeType) fail("unknown legal type description");
  return { committeeId, committeeName: names[0]!, committeeType, status: text(fullFields.Status),
    address: addressLines.slice(0, -1).join(" "), cityStateZip: addressLines.at(-1)!,
    addressLines, sourceUrl, fullFields };
}

/** Source-specific application bound; shorter word prefixes avoid observed long-name500s. */
export function buildFloridaCommitteeDonorPrefixes(name: string): readonly [string, string] {
  const n = display(name);
  if (!n || n.length < 2) fail("name too short for two bounded queries");
  let longer = n.slice(0, 29);
  if (n.length > 29 && longer.includes(" ")) longer = longer.slice(0, longer.lastIndexOf(" "));
  const shorter = longer.includes(" ") ? longer.slice(0, longer.lastIndexOf(" ")) : longer.slice(0, -1);
  if (!shorter || shorter === longer) fail("cannot compose two distinct prefixes");
  return [prefix(shorter), prefix(longer)];
}
function multiset(rows: readonly FloridaCommitteeNameRow[]): string {
  return sha(rows.map(r => JSON.stringify(r)).sort().join("\n"));
}
function union(sets: readonly (readonly FloridaCommitteeNameRow[])[]): FloridaCommitteeNameRow[] {
  const rows = new Map<string, FloridaCommitteeNameRow>();
  for (const set of sets) for (const r of set) {
    if (rows.has(r.committeeId) && JSON.stringify(rows.get(r.committeeId)) !== JSON.stringify(r)) fail("conflicting overlapping query identities");
    rows.set(r.committeeId, r);
  }
  return [...rows.values()].sort((a, b) => a.committeeId.localeCompare(b.committeeId));
}
function reviewedDate(account: string, kind: "registration" | "disbandment", records: readonly FloridaReviewedCommitteeDates[]): FloridaCommitteeDateEvidence | null {
  const match = records.filter(r => r.committeeId === account && r[kind]);
  if (match.length > 1) fail("conflicting reviewed account date");
  const entry = match[0]?.[kind];
  if (!entry) return null;
  const u = new URL(entry.document.url);
  if (u.pathname !== "/campaign-docs/PDFHandler.ashx" || [...u.searchParams.keys()].length !== 2 ||
    !u.searchParams.has("AcctType") || !/^[1-9][0-9]*$/.test(u.searchParams.get("TrackNum") ?? "")) fail("wrong reviewed account PDF reference");
  checkedRaw(entry.document, { url: entry.document.url, method: "GET", financeFields: null }, true);
  const fields = ["effectiveDate", "activeBy", "closedBy"].filter(k => Object.hasOwn(entry, k));
  if (fields.length !== 1 || (kind === "registration" && fields[0] === "closedBy") ||
    (kind === "disbandment" && fields[0] === "activeBy")) fail("invalid reviewed temporal-bound kind");
  const field = fields[0]!;
  const bound = (entry as unknown as Record<string, unknown>)[field];
  if (typeof bound !== "string") fail("invalid reviewed temporal bound");
  const source = { sourceUrl: entry.document.url, sha256: entry.document.sha256 };
  if (field === "effectiveDate") return { ...source, effectiveDate: bound };
  if (field === "activeBy") return { ...source, activeBy: bound };
  return { ...source, closedBy: bound };
}
export function createFloridaCommitteeRegistrySource(options: {
  request: (request: FloridaCommitteeRegistryRequest) => Promise<FloridaProcessedRawEvidence>;
  reviewedDates?: readonly FloridaReviewedCommitteeDates[];
}) {
  return {
    async lookupDonor(receipt: {
      reportedName: string; reportedAddress: string; reportedCityStateZip: string;
      transactionDate: string; receivingCommitteeId?: string;
    }): Promise<FloridaCommitteeRegistryLookupResult> {
      const hashes: string[] = [];
      try {
        receipt = structuredClone(receipt);
        const reviewedDates = structuredClone(options.reviewedDates ?? []);
        const prefixes = buildFloridaCommitteeDonorPrefixes(receipt.reportedName);
        const opening: (readonly FloridaCommitteeNameRow[])[] = [], closing: (readonly FloridaCommitteeNameRow[])[] = [];
        let openingEnd = 0;
        async function search(p: string, isClosing: boolean) {
          const raw = await options.request({ url: SEARCH, method: "POST", financeFields: fields(p), phase: isClosing ? "closing" : "opening" });
          hashes.push(raw.sha256);
          if (isClosing && Date.parse(raw.startedAt) < openingEnd) fail("closing query predates opening generation");
          if (!isClosing) openingEnd = Math.max(openingEnd, Date.parse(raw.completedAt));
          return decodeFloridaCommitteeNameSearch(raw, { prefix: p });
        }
        for (const p of prefixes) opening.push(await search(p, false));
        const discovered = union(opening), details = new Map<string, FloridaCommitteeDetail>();
        const matches = discovered.filter(r => exact(r.committeeName) === exact(receipt.reportedName));
        for (const r of matches) {
          const raw = await options.request({ url: r.sourceUrl, method: "GET", financeFields: null, phase: "opening" });
          hashes.push(raw.sha256); openingEnd = Math.max(openingEnd, Date.parse(raw.completedAt));
          const d = decodeFloridaCommitteeDetail(raw, { committeeId: r.committeeId });
          if (d.committeeName !== r.committeeName || d.committeeType !== r.committeeType || d.status !== r.status) fail("search/detail identity mismatch");
          details.set(r.committeeId, d);
        }
        for (const r of matches) {
          const raw = await options.request({ url: r.sourceUrl, method: "GET", financeFields: null, phase: "closing" });
          hashes.push(raw.sha256);
          if (Date.parse(raw.startedAt) < openingEnd) fail("closing detail predates opening generation");
          const d = decodeFloridaCommitteeDetail(raw, { committeeId: r.committeeId });
          if (JSON.stringify(d) !== JSON.stringify(details.get(r.committeeId))) fail("changed complete account detail");
        }
        for (const p of prefixes) closing.push(await search(p, true));
        if (opening.some((r, i) => multiset(r) !== multiset(closing[i]!))) fail("changed all-status query row multiset");
        union(closing);
        const registrations: FloridaCommitteeDonorRegistration[] = discovered.map(r => {
          const d = details.get(r.committeeId);
          return { ...r, address: d?.address ?? "", cityStateZip: d?.cityStateZip ?? "",
            registration: reviewedDate(r.committeeId, "registration", reviewedDates),
            disbandment: reviewedDate(r.committeeId, "disbandment", reviewedDates),
            rawFields: { queryCells: r.rawFields, detail: d ?? null } };
        });
        const fp = fingerprintFloridaCommitteeDonorRegistrations(registrations);
        return { ...resolveFloridaCommitteeDonorIdentity({ ...receipt, registrations, queryProof: {
          prefixes, fingerprintBefore: fp, fingerprintAfter: fp,
        } }), registrations, sourceHashes: hashes };
      } catch (error) {
        return { status: "unresolved", diagnostics: [error instanceof Error ? error.message : "Registry lookup failed."], sourceHashes: hashes };
      }
    },
  };
}
