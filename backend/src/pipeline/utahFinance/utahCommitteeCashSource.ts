import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseUtahNativeExport, type UtahNativeExportRow } from "./utahNativeExport.js";
import { UTAH_DISCLOSURES_BASE_URL, buildUtahGenerateReportUrl } from "./utahDisclosuresClient.js";

export type UtahCashContext = {
  linkId: string; candidateId: string; electionId: string; candidateName: string;
  electionYear: number; folderId: string; officeScope: string; officeName: string; district: string | null;
};
export type UtahCashDonor = { committeeId: string; committeeName: string; amountCents: number; contributionCount: number };
export type UtahCashPacket = {
  context: UtahCashContext; observedAt: string; sourceUrl: string; reportCount: number;
  occurrenceCount: number; excludedUnfiledCount: number; donors: readonly UtahCashDonor[];
};
const accepted = new WeakSet<object>();
export function assertUtahCashPacket(packet: UtahCashPacket): void { check(accepted.has(packet), "unverified_packet"); }
export function check(value: unknown, code: string): asserts value {
  if (!value) throw new Error(`Utah committee cash held: ${code}`);
}
const text = (s: string) => s.replace(/\s+/g, " ").trim();
export const utahCashNameKey = (s: string) => text(s.normalize("NFKC")).toUpperCase();
function person(s: string): string {
  const p = s.split(",");
  return (p.length === 2 ? `${p[1]} ${p[0]}` : s).normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function document(html: string, url: string): Document {
  const { JSDOM, VirtualConsole } = createRequire(import.meta.url)("jsdom") as {
    JSDOM: new (html: string, options: { url: string; virtualConsole: unknown }) => { window: { document: Document } };
    VirtualConsole: new () => unknown;
  };
  check(!/[\u0000\uFFFD]/.test(html), "invalid_encoding");
  return new JSDOM(html, { url, virtualConsole: new VirtualConsole() }).window.document;
}
function field(doc: Document, label: string): string {
  const e = [...doc.querySelectorAll("label")].find(e => text(e.textContent ?? "") === label);
  check(e?.parentElement, "missing_native_field");
  return text([...e.parentElement.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(" "));
}
function add(a: number, b: number): number { const n = a + b; check(Number.isSafeInteger(n), "unsafe_cent_sum"); return n; }
function cents(s: string): number {
  const m = /^(-?)\$?((?:\d+|\d{1,3}(?:,\d{3})+))\.(\d{2})$/.exec(text(s));
  check(m, "invalid_native_money");
  const n = Number((BigInt(m[2]!.replaceAll(",", "")) * 100n + BigInt(m[3]!)) * (m[1] ? -1n : 1n));
  check(Number.isSafeInteger(n), "unsafe_native_money"); return n;
}
function day(s: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text(s)); check(m, "invalid_native_date");
  const d = new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2])));
  check(d.getUTCFullYear() === Number(m[3]) && d.getUTCMonth() + 1 === Number(m[1]) && d.getUTCDate() === Number(m[2]), "invalid_calendar_date");
  return d.toISOString().slice(0, 10);
}
function url(raw: string, base = UTAH_DISCLOSURES_BASE_URL): string {
  const u = new URL(raw, base);
  check(u.origin === UTAH_DISCLOSURES_BASE_URL && !u.username && !u.password && !u.hash, "invalid_origin");
  check(/^\/(?:Search\/PublicSearch\/(?:FolderDetails|Report)\/\d+|Registration\/EntityDetails\/\d+|Search\/AdvancedSearch\/GenerateReport(?:\/\d+)?)$/.test(u.pathname), "invalid_source_path");
  return u.href;
}
export function utahFiledInventory(html: string, sourceUrl: string, year: number) {
  const doc = document(html, sourceUrl);
  const frame = [...doc.querySelectorAll<HTMLIFrameElement>("iframe[src]")].filter(e => /\/Registration\/EntityDetails\/\d+$/.test(e.src));
  check(frame.length === 1, "registration_reference");
  const reports = [...doc.querySelectorAll<HTMLAnchorElement>("a[href]")].flatMap(a => {
    const title = text(a.textContent ?? "");
    if (!title.startsWith(`${year} - `)) return [];
    const m = /^javascript:openReport\('([^']+)'\);?$/.exec(a.getAttribute("href") ?? "");
    check(m, "native_report_reference");
    return [{ label: title.slice(7), url: url(m[1]!, sourceUrl) }];
  });
  check(reports.length > 0 && reports.length <= 30 && new Set(reports.map(r => r.label)).size === reports.length && new Set(reports.map(r => r.url)).size === reports.length, "ambiguous_filed_inventory");
  return { registrationUrl: url(frame[0]!.src), reports };
}
export function verifyUtahCashRegistration(html: string, sourceUrl: string, context: UtahCashContext): void {
  const d = document(html, sourceUrl);
  check(person([field(d, "First"), field(d, "Middle"), field(d, "Last")].join(" ")) === person(context.candidateName), "canonical_name");
  const offices: Record<string, string> = { state_lower: "House", state_upper: "Senate" };
  const expected = offices[context.officeScope] ?? context.officeName;
  check(utahCashNameKey(field(d, "Office")) === utahCashNameKey(expected), "canonical_office");
  if (offices[context.officeScope]) {
    const district = field(d, "District #");
    check(/^\d+$/.test(district) && /^\d+$/.test(context.district ?? "") && Number(district) === Number(context.district), "canonical_district");
  }
}
type Occurrence = [string, string, number, boolean, boolean];
function multiset(rows: Occurrence[]): Map<string, number> {
  const m = new Map<string, number>(); for (const r of rows) { const k = JSON.stringify(r); m.set(k, (m.get(k) ?? 0) + 1); } return m;
}
/** The main tables are the current statement. Amendment information popups are
 * history, not additional occurrences. No version is inferred from CSV AMENDS. */
export function verifyUtahFiledStatement(input: {
  html: string; sourceUrl: string; label: string; year: number; candidateName: string; rows: readonly UtahNativeExportRow[];
}): void {
  const d = document(input.html, input.sourceUrl), tables = [...d.querySelectorAll<HTMLTableElement>("table")];
  check(tables.length === 3, "native_statement_tables");
  check(field(d, "Report Name") === `${input.year} ${input.label} Report`, "native_statement_period");
  check(person(field(d, "Name")) === person(input.candidateName), "native_statement_receiver");
  check(day(field(d, "SubmitDate")) <= new Date().toISOString().slice(0, 10), "unfiled_statement");
  for (const [index, kind] of ["Contribution", "Expenditure"].entries()) {
    const table = tables[index + 1]!, nativeRows = [...table.rows];
    check(nativeRows.length >= 3 && text(nativeRows[0]!.textContent ?? "").startsWith(index === 0 ? "Itemized Contributions Received" : "Itemized Expenditures Made"), "native_statement_heading");
    const headers = [...nativeRows[1]!.cells].map(c => text(c.textContent ?? ""));
    check(isDeepStrictEqual(headers, index === 0 ? ["Date Received", "Name of Contributor", "Complete Mailing Address", "I", "P", "L", "A", "Contribution Amount"] : ["Exp. Date", "Name of Recipient", "Purpose", "I", "P", "L", "A", "Expenditure Amount"]), "native_detail_headers");
    let sum = 0;
    const occurrences: Occurrence[] = nativeRows.slice(2, -1).map(r => {
      const cells = [...r.cells].map(c => text(c.textContent ?? "")); check(cells.length === 8, "native_detail_width");
      check(cells[4] === "" && ["", "✓"].includes(cells[5]!) && (cells[3] === "" || /^\[I\d+\]$/.test(cells[3]!)) && (cells[6] === "" || /^A\d+$/.test(cells[6]!)), "unsupported_native_flags");
      const value = cents(cells[7]!), inKind = cells[3] !== "";
      if (!inKind) sum = add(sum, value);
      return [day(cells[0]!), utahCashNameKey(cells[1]!), value, inKind, cells[5] === "✓"];
    });
    const sourceRows = input.rows.filter(r => r.transactionType === kind);
    check(isDeepStrictEqual(multiset(occurrences), multiset(sourceRows.map(r => [day(r.transactionDate!), utahCashNameKey(r.name ?? ""), index === 0 ? r.amountCents : -r.amountCents, r.inKind, r.loan]))), "complete_occurrence_comparison");
    const footer = [...nativeRows.at(-1)!.cells].map(c => text(c.textContent ?? ""));
    check(footer.length === 2 && (index === 0 ? ["Total Contributions Received", "Total Contributions Received (In-kind amounts do not affect totals.)"].includes(footer[0]!) : footer[0] === "Total Expenditures Made") && cents(footer[1]!) === sum, "detail_cash_control");
    const parent = [...tables[0]!.rows].find(r => text(r.cells[0]?.textContent ?? "") === String(index === 0 ? 2 : 4));
    check(parent?.cells.length === 4 && cents(text(parent.cells[2]!.textContent ?? "")) === sum, "parent_cash_control");
  }
}
export type UtahCashOriginal = { url: string; observedAt: string; body: string; kind: "http" | "saved-http-body" | "browser-dom" };
export function utahCashOriginalPath(cacheDir: string, phase: string, sourceUrl: string): string {
  return join(cacheDir, "utah-committee-cash", createHash("sha256").update(JSON.stringify([phase, sourceUrl])).digest("hex") + ".json");
}
export async function loadUtahCashPacket(context: UtahCashContext, options: {
  cacheDir: string; now?: Date; refresh?: boolean; fetchImpl?: typeof fetch; allowNetwork?: boolean;
}): Promise<UtahCashPacket> {
  check(/^\d+$/.test(context.folderId) && Number.isInteger(context.electionYear), "invalid_context");
  const now = options.now ?? new Date(), times: number[] = [];
  async function original(phase: string, rawUrl: string): Promise<UtahCashOriginal> {
    const sourceUrl = url(rawUrl), path = utahCashOriginalPath(options.cacheDir, phase, sourceUrl);
    let o: UtahCashOriginal | undefined;
    if (!options.refresh) {
      try { o = JSON.parse(await readFile(path, "utf8")) as UtahCashOriginal; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") check(false, "saved_original_invalid"); }
    }
    if (!o) {
      check(options.allowNetwork, "saved_original_missing");
      let response: Response;
      try { response = await (options.fetchImpl ?? fetch)(sourceUrl, { redirect: "error", signal: AbortSignal.timeout(60_000), headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html,text/csv,*/*" } }); }
      catch { throw new Error("Utah committee cash held: source_unavailable"); }
      check(response.ok, "source_status");
      const bytes = new Uint8Array(await response.arrayBuffer()); check(bytes.length <= 16 * 1024 * 1024, "source_size");
      const length = response.headers.get("content-length");
      check(response.headers.get("content-encoding") || length === null || Number(length) === bytes.length, "source_eof");
      o = { url: sourceUrl, observedAt: new Date().toISOString(), body: new TextDecoder("utf-8", { fatal: true }).decode(bytes), kind: "http" };
      await mkdir(join(options.cacheDir, "utah-committee-cash"), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${process.pid}.tmp`; await writeFile(temporary, JSON.stringify(o), { mode: 0o600 }); await rename(temporary, path);
    }
    const time = Date.parse(o.observedAt);
    check(o.url === sourceUrl && ["http", "saved-http-body", "browser-dom"].includes(o.kind) && typeof o.body === "string" && Number.isFinite(time) && time <= Date.now() + 60_000 && now.getTime() - time <= 86_400_000, "original_identity_or_age");
    times.push(time); return o;
  }
  const sourceUrl = url(`/Search/PublicSearch/FolderDetails/${context.folderId}`);
  const opening = await original("folder-open", sourceUrl), inventory = utahFiledInventory(opening.body, sourceUrl, context.electionYear);
  const registration = await original("registration", inventory.registrationUrl);
  verifyUtahCashRegistration(registration.body, registration.url, context);
  const exportUrl = buildUtahGenerateReportUrl({ folderId: context.folderId, reportYear: context.electionYear });
  const first = await original("ledger-open", exportUrl), rows = parseUtahNativeExport(first.body, "PCC", "folder");
  check(rows.length > 0 && rows.every(r => person(r.entityName ?? "") === person(context.candidateName) && day(r.transactionDate ?? "").startsWith(String(context.electionYear)) && !r.amends), "receiving_export_scope");
  const filed = new Set(inventory.reports.map(r => r.label));
  for (const report of inventory.reports) {
    const raw = await original("statement", report.url);
    verifyUtahFiledStatement({ html: raw.body, sourceUrl: raw.url, label: report.label, year: context.electionYear, candidateName: context.candidateName, rows: rows.filter(r => r.report === report.label) });
  }
  const closing = await original("folder-close", sourceUrl);
  check(isDeepStrictEqual(inventory, utahFiledInventory(closing.body, sourceUrl, context.electionYear)), "unstable_filed_inventory");
  const last = await original("ledger-close", exportUrl), closingRows = parseUtahNativeExport(last.body, "PCC", "folder");
  const scope = rows.filter(r => filed.has(r.report ?? ""));
  check(scope.length > 0 && isDeepStrictEqual(scope, closingRows.filter(r => filed.has(r.report ?? ""))) && Date.parse(last.observedAt) >= Date.parse(first.observedAt), "unstable_filed_ledger");
  const pacUrl = buildUtahGenerateReportUrl({ entityType: "PAC", reportYear: context.electionYear });
  const pac = await original("typed-pac", pacUrl), pacRows = parseUtahNativeExport(pac.body, "PAC", "annual");
  check(pacRows.length > 0 && pacRows.every(r => r.entityName?.trim()), "typed_pac_scope");
  const known = new Set(pacRows.map(r => utahCashNameKey(r.entityName!))), donors = new Map<string, UtahCashDonor>();
  for (const r of scope) {
    const key = utahCashNameKey(r.name ?? "");
    if (r.transactionType !== "Contribution" || r.inKind || r.loan || !known.has(key)) continue;
    const donor = donors.get(key) ?? { committeeId: `reported:${key}`, committeeName: text(r.name!), amountCents: 0, contributionCount: 0 };
    donor.amountCents = add(donor.amountCents, r.amountCents); donor.contributionCount++; donors.set(key, donor);
  }
  check(Date.parse(closing.observedAt) >= Date.parse(opening.observedAt) && Math.max(...times) - Math.min(...times) <= 43_200_000, "capture_window");
  const packet: UtahCashPacket = { context: { ...context }, observedAt: new Date(Math.max(...times)).toISOString(), sourceUrl, reportCount: inventory.reports.length, occurrenceCount: scope.length, excludedUnfiledCount: closingRows.length - scope.length, donors: [...donors.values()] };
  for (const d of packet.donors) Object.freeze(d); Object.freeze(packet.donors); Object.freeze(packet.context); Object.freeze(packet); accepted.add(packet); return packet;
}
