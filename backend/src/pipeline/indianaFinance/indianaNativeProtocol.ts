import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";

const { JSDOM, VirtualConsole } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string, options: { url: string; virtualConsole: unknown }) => { window: { document: Document } };
  VirtualConsole: new () => unknown;
};

export const INDIANA_NATIVE_ORIGIN = "https://campaignfinance.in.gov";
export class IndianaNativeSourceError extends Error {
  constructor(readonly code: string) { super(`Indiana native source: ${code}`); }
}
export function inCheck(value: unknown, code: string): asserts value {
  if (!value) throw new IndianaNativeSourceError(code);
}
export const inKey = (s: string): string => s.replace(/\s+/g, " ").trim().toUpperCase();
export function inText(n: Node | null | undefined): string {
  inCheck(n, "missing_native_control");
  return (n.textContent ?? "").replace(/\s+/g, " ").trim();
}
export function inHtml(raw: Uint8Array, url: string): Document {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(raw); }
  catch { throw new IndianaNativeSourceError("invalid_utf8"); }
  inCheck(!/[\u0000\uFFFD]/u.test(text), "invalid_document_characters");
  return new JSDOM(text, { url, virtualConsole: new VirtualConsole() }).window.document;
}
export function inAdd(a: number, b: number): number {
  const n = a + b;
  inCheck(Number.isSafeInteger(a) && Number.isSafeInteger(b) && Number.isSafeInteger(n), "unsafe_cent_sum");
  return n;
}
/** Source HTML uses signed currency. Four-place representations are accepted
 * only when they represent exact cents; no rounding or positive-only filter. */
export function inCents(value: string): number {
  let s = value.trim(), sign = 1n;
  if (s.startsWith("(") && s.endsWith(")")) { sign = -1n; s = s.slice(1, -1); }
  s = s.replace(/^\$\s*/, "");
  if (s.startsWith("-")) {
    inCheck(sign === 1n, "ambiguous_money_sign");
    sign = -1n; s = s.slice(1).replace(/^\$\s*/, "");
  }
  inCheck(/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,4})?$/.test(s), "invalid_money");
  const [whole, fraction = ""] = s.replaceAll(",", "").split(".");
  inCheck(/^0*$/.test(fraction.slice(2)), "fractional_cent");
  const n = Number((BigInt(whole!) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, "0"))) * sign);
  inCheck(Number.isSafeInteger(n), "unsafe_money");
  return n;
}
export function inDay(value: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  inCheck(m, "invalid_native_date");
  const y = Number(m[3]), month = Number(m[1]), day = Number(m[2]), d = new Date(Date.UTC(y, month - 1, day));
  inCheck(d.getUTCFullYear() === y && d.getUTCMonth() + 1 === month && d.getUTCDate() === day, "invalid_calendar_date");
  return d.toISOString().slice(0, 10);
}
/** A sortable native wall clock; this does not assign a source timezone. */
export function inFiledClock(value: string): string {
  const m = /^([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i.exec(value)
    ?? /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i.exec(value);
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  inCheck(m && (/^\d{1,2}$/.test(m[1]!) || months.includes(m[1]!.toLowerCase())), "invalid_filed_clock");
  const month = /^\d{1,2}$/.test(m[1]!) ? Number(m[1]) : months.indexOf(m[1]!.toLowerCase()) + 1;
  let hour = Number(m[4] ?? 0);
  if (m[7]) {
    inCheck(hour >= 1 && hour <= 12, "invalid_filed_hour");
    hour = hour % 12 + (m[7].toUpperCase() === "PM" ? 12 : 0);
  }
  const minute = Number(m[5] ?? 0), second = Number(m[6] ?? 0);
  inCheck(hour < 24 && minute < 60 && second < 60, "invalid_filed_time");
  const date = inDay(`${month}/${m[2]}/${m[3]}`);
  return `${date}T${[hour, minute, second].map(n => String(n).padStart(2, "0")).join(":")}`;
}
export function inPublicUrl(value: string, base: string): string {
  let u: URL;
  try { u = new URL(value, base); } catch { throw new IndianaNativeSourceError("invalid_public_url"); }
  inCheck(u.hostname === "campaignfinance.in.gov" && ["https:", "http:"].includes(u.protocol) && !u.port && !u.username && !u.password && !u.hash, "invalid_public_origin");
  inCheck(/^\/(?:PublicSite\/SearchPages\/(?:CommitteeSearch|CommitteeDetail|ContributionSearch|ContributionDetail|ExpenditureSearch|ExpenditureDetail|FilingAmendmentSelect|FilingDetail)\.aspx|PublicSite\/Filings\/Schedules\/View(?:Contribution|Expenditure|Returns)Schedule\.aspx|INCF\/Reports\/ReportExporter\.aspx|INCF\/TempDocs\/[a-f0-9-]{36}\.pdf)$/.test(u.pathname), "invalid_public_path");
  inCheck(new Set(u.searchParams.keys()).size === u.searchParams.size, "duplicate_source_selector");
  return u.href;
}
export function inForm(d: Document): URLSearchParams {
  const forms = d.querySelectorAll("form"); inCheck(forms.length === 1, "native_form_count");
  const fields = new URLSearchParams();
  for (const n of forms[0]!.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input,select,textarea")) {
    if (!n.name || n.disabled || ["submit", "button", "reset", "image"].includes(n.type)) continue;
    if (["checkbox", "radio"].includes(n.type) && !(n as HTMLInputElement).checked) continue;
    inCheck(!fields.has(n.name), "duplicate_form_field"); fields.set(n.name, n.value);
  }
  inCheck(fields.has("__VIEWSTATE") && fields.has("__EVENTVALIDATION"), "native_form_state");
  return fields;
}
export function inCallback(code: string): [string, string] {
  const matches = [...code.replace(/\\'/g, "'").matchAll(/__doPostBack\('([^']*)','([^']*)'\)/g)];
  inCheck(matches.length === 1, "native_postback_callback");
  return [matches[0]![1]!, matches[0]![2]!];
}
export type IndianaNativePager = {
  page: number; sizeName: string; size50Value: string;
  resize: [string, string]; next: [string, string] | null;
};
export function inPager(grid: HTMLTableElement, width: number): IndianaNativePager {
  const pagers = [...grid.rows].filter(r => r.children.length === 1 && Number(r.children[0]!.getAttribute("colspan")) >= width);
  inCheck(pagers.length === 1, "native_pager_count"); const p = pagers[0]!;
  const marks = [...new Set([...p.querySelectorAll("span,font,b,strong")].filter(n => !n.closest("a") && !n.querySelector("select") && /^\d+$/.test(inText(n))).map(n => Number(inText(n))))];
  inCheck(marks.length === 1 && marks[0]! >= 1, "native_page_number");
  const sizes = [...p.querySelectorAll("select")].filter(n => [...n.options].map(inText).join("|") === "10|25|50");
  inCheck(sizes.length === 1 && sizes[0]!.name, "native_page_size");
  const links = [...p.querySelectorAll("a[href]")], next = links.find(n => inText(n) === String(marks[0]! + 1)) ?? links.filter(n => inText(n) === "...").at(-1);
  return { page: marks[0]!, sizeName: sizes[0]!.name, size50Value: [...sizes[0]!.options].find(n => inText(n) === "50")!.value,
    resize: inCallback(sizes[0]!.getAttribute("onchange") ?? ""), next: next ? inCallback(next.getAttribute("href") ?? "") : null };
}
function oneTable(d: Document, id: string): HTMLTableElement {
  const tables = d.querySelectorAll<HTMLTableElement>(`#${id}`); inCheck(tables.length === 1, "native_table_count"); return tables[0]!;
}
function headers(g: HTMLTableElement, expected: string[]): void {
  const actual = [...g.rows[0]!.children].map(inText);
  inCheck(isDeepStrictEqual(actual, expected), "native_table_schema");
}
function field(d: Document, id: string): string {
  const n = d.querySelectorAll(`#${id}`); inCheck(n.length === 1, "native_field_count"); return inText(n[0]!);
}
export type IndianaNativeReceipt = { url: string; cells: string[]; name: string; committee: string; kind: string; day: string; cents: number };
export type IndianaNativeReceiptPage = { count: number; totalCents: number; rows: IndianaNativeReceipt[]; pager: IndianaNativePager };
/** Type in the search grid is contribution kind, never contributor class. */
export function parseIndianaNativeReceiptPage(d: Document, url: string): IndianaNativeReceiptPage {
  const g = oneTable(d, "_ctl0_Content_dgdSearchResults");
  headers(g, ["Contributor", "City, State", "Type", "Amount", "Date", "Candidate/Committee Name", "In Kind?", "Large?", ""]);
  const countText = field(d, "_ctl0_Content_lblRecordsFound"), nums = countText.match(/\d[\d,]*/g);
  inCheck(nums?.length === 1, "native_receipt_count"); const count = Number(nums[0]!.replaceAll(",", ""));
  inCheck(Number.isSafeInteger(count) && count > 0 && count <= 100000, "unqualified_receipt_count");
  const rows = [...g.rows].filter(r => r.children.length === 9 && r.children[0]!.tagName === "TD").map(r => {
    const cells = [...r.children].map(inText), views = [...r.querySelectorAll("a")].filter(n => inText(n) === "View");
    inCheck(views.length === 1 && cells[0] && cells[5], "native_receipt_fields");
    const links = [...(views[0]!.getAttribute("onclick") ?? "").matchAll(/['"]([^'"]+)['"]/g)].map(m => new URL(m[1]!, url)).filter(u => u.origin === INDIANA_NATIVE_ORIGIN && u.pathname === "/PublicSite/SearchPages/ContributionDetail.aspx");
    inCheck(links.length === 1, "native_receipt_event_link");
    return { url: inPublicUrl(links[0]!.href, url), cells, name: cells[0]!, committee: cells[5]!, kind: cells[2]!, day: inDay(cells[4]!), cents: inCents(cells[3]!) };
  });
  inCheck(rows.length > 0 && rows.length <= 50, "native_receipt_page_rows");
  return { count, totalCents: inCents(field(d, "_ctl0_Content_lblTotalContributions")), rows, pager: inPager(g, 9) };
}
export type IndianaNativeReceiptDetail = { file: string; committee: string; committeeClass: string; donorClass: string; name: string; kind: string; day: string; cents: number };
export function parseIndianaNativeReceiptDetail(d: Document): IndianaNativeReceiptDetail {
  return { file: field(d, "lblCommID"), committee: field(d, "lblCommitteeName"), committeeClass: field(d, "lblCommitteeType"),
    donorClass: field(d, "lblContributorType"), name: field(d, "lblContributorName"), kind: field(d, "lblContributionType"),
    day: inDay(field(d, "lblReceiptDate")), cents: inCents(field(d, "lblAmount")) };
}
export function closeIndianaNativeReceiptPages(opening: readonly IndianaNativeReceiptPage[], closing: readonly IndianaNativeReceiptPage[], committee: string): IndianaNativeReceipt[] {
  inCheck(opening.length > 0 && isDeepStrictEqual(opening, closing), "native_receipt_closing_changed");
  const first = opening[0]!, rows: IndianaNativeReceipt[] = [], seen = new Set<string>();
  for (let i = 0; i < opening.length; i++) {
    const p = opening[i]!;
    inCheck(p.count === first.count && p.totalCents === first.totalCents && p.pager.page === i + 1, "native_receipt_scope_changed");
    for (const r of p.rows) {
      inCheck(inKey(r.committee) === inKey(committee) && !seen.has(r.url), "native_receipt_identity_conflict"); seen.add(r.url); rows.push(r);
    }
  }
  inCheck(rows.length === first.count && rows.reduce((n, r) => inAdd(n, r.cents), 0) === first.totalCents, "native_receipt_full_closure");
  return rows;
}
export type IndianaNativePacGift = IndianaNativeReceipt & { donorClass: "Political Action Committee" };
export function qualifyIndianaNativePacSubset(input: { all: readonly IndianaNativeReceipt[]; pac: readonly IndianaNativeReceipt[]; details: ReadonlyMap<string, IndianaNativeReceiptDetail>; file: string; committee: string }): { gifts: IndianaNativePacGift[]; excludedNonGiftRows: number; inKindCents: number; cashCents: number } {
  const all = new Map(input.all.map(r => [r.url, r]));
  inCheck(all.size === input.all.length && new Set(input.pac.map(r => r.url)).size === input.pac.length, "duplicate_native_receipt");
  const gifts: IndianaNativePacGift[] = []; let excludedNonGiftRows = 0, inKindCents = 0, cashCents = 0;
  for (const r of input.pac) {
    const a = all.get(r.url), d = input.details.get(r.url);
    inCheck(a && isDeepStrictEqual(a, r) && d, "pac_not_exact_native_subset");
    inCheck(d.file === input.file && inKey(d.committee) === inKey(input.committee) && d.committeeClass === "Candidate", "pac_recipient_identity_conflict");
    inCheck(d.donorClass === "Political Action Committee" && inKey(d.name) === inKey(r.name) && d.day === r.day && d.cents === r.cents && d.kind === r.kind, "pac_detail_conflict");
    inCheck(["Direct", "In-Kind", "Interest", "Loan", "Misc", "Missing", "Unitemized"].includes(d.kind), "unknown_pac_receipt_kind");
    if (d.kind === "Direct") cashCents = inAdd(cashCents, d.cents);
    else if (d.kind === "In-Kind") inKindCents = inAdd(inKindCents, d.cents);
    else { excludedNonGiftRows++; continue; }
    gifts.push({ ...r, donorClass: "Political Action Committee" });
  }
  return { gifts, excludedNonGiftRows, inKindCents, cashCents };
}
export type IndianaNativeFiling = { cells: string[]; kind: string; begin: string; end: string; amended: boolean; callback: [string, string] };
export function parseIndianaNativeFilingPage(d: Document): { rows: IndianaNativeFiling[]; pager: IndianaNativePager } {
  const g = oneTable(d, "_ctl0_Content_dgdFilingHistory");
  headers(g, ["Description", "Period Begin", "Period End", "Due Date", "Filed Date", "Amended?", "Status"]);
  const rows = [...g.rows].filter(r => r.children.length === 7 && r.children[0]!.tagName === "TD").map(r => {
    const cells = [...r.children].map(inText), links = r.querySelectorAll("a[href]");
    inCheck(links.length === 1 && ["Yes", "No"].includes(cells[5]!) && cells[6] === "Filed", "native_filing_status");
    return { cells, kind: cells[0]!, begin: cells[1]!, end: cells[2]!, amended: cells[5] === "Yes", callback: inCallback(links[0]!.getAttribute("href") ?? "") };
  });
  inCheck(rows.length > 0 && rows.length <= 50, "native_filing_rows");
  return { rows, pager: inPager(g, 7) };
}
/** Latest unique native filed clock selects the replacement. The source's
 * blank/Amended labels are markers, not numeric version ordinals. */
export function selectIndianaNativeFilingVersion(d: Document, kind: string, amended: boolean): { filed: string; amended: boolean; callback: [string, string] } {
  for (const n of d.querySelectorAll("br")) n.replaceWith(d.createTextNode(" "));
  const g = oneTable(d, "_ctl0_Content_grdAmendments");
  const versions = [...g.rows].filter(r => r.children.length === 4 && r.children[0]!.tagName === "TD").map(r => {
    const caption = inText(r.querySelector('span[id*="lblAmendment"]')), report = inText(r.children[1]), links = r.querySelectorAll("a[href]");
    inCheck(["", "Amended"].includes(caption) && report === kind && links.length === 1, "native_version_fields");
    return { filed: inFiledClock(inText(r.querySelector('span[id*="lblFiledDate"]'))), amended: caption === "Amended", callback: inCallback(links[0]!.getAttribute("href") ?? "") };
  }).sort((a, b) => a.filed.localeCompare(b.filed));
  inCheck(versions.length > 0 && versions.filter(v => !v.amended).length === 1, "native_version_family");
  const last = versions.at(-1)!;
  inCheck(amended ? versions.length > 1 && last.amended && last.filed > versions.at(-2)!.filed : versions.length === 1 && !last.amended, "ambiguous_native_replacement");
  return last;
}

export type IndianaNativeCommittee = { file: string; name: string; candidate: string; office: string; district: string; committeeClass: string; status: string };
export function parseIndianaNativeCommittee(d: Document): IndianaNativeCommittee {
  return { file: field(d, "_ctl0_Content_lblCommitteeID"), name: field(d, "_ctl0_Content_lblCommName"),
    candidate: field(d, "_ctl0_Content_lblCandidateName"), office: field(d, "_ctl0_Content_lblCandidateOffice"),
    district: field(d, "_ctl0_Content_lblDistrict"), committeeClass: field(d, "_ctl0_Content_lblCommitteeType"), status: field(d, "_ctl0_Content_lblCommStatus") };
}
export type IndianaNativeMonetaryReport = {
  file: string; committee: string; committeeClass: string; reportingPeriod: string;
  itemizedReceipts: number; unitemizedReceipts: number; itemizedExpenses: number; unitemizedExpenses: number;
  contributionsUrl: string; expendituresUrl: string; returnsUrl: string;
};
function scheduleLink(d: Document, id: string, url: string, path: string): string {
  const controls = d.querySelectorAll(`#_ctl0_Content_${id}`); inCheck(controls.length === 1, "native_schedule_action");
  const links = [...(controls[0]!.getAttribute("onclick") ?? "").matchAll(/['"]([^'"]+)['"]/g)]
    .map(m => new URL(m[1]!, url)).filter(u => u.hostname === "campaignfinance.in.gov" && u.pathname === path);
  inCheck(links.length === 1, "native_schedule_url"); return inPublicUrl(links[0]!.href, url);
}
export function parseIndianaNativeMonetaryReport(d: Document, url: string): IndianaNativeMonetaryReport {
  const value = (suffix: string) => field(d, `_ctl0_Content_${suffix}`);
  // The source's overall-total labels are empty. Only these published itemized
  // and unitemized controls are authoritative; no invented grand-total field.
  return { file: value("lblSOSID"), committee: value("lblCommName"), committeeClass: value("lblCommType"), reportingPeriod: value("lblReportingPeriod"),
    itemizedReceipts: inCents(value("lblItemContributionsTotal")), unitemizedReceipts: inCents(value("lblNonItemContributionsTotal")),
    itemizedExpenses: inCents(value("lblItemExpendituresTotal")), unitemizedExpenses: inCents(value("lblNonItemExpendituresTotal")),
    contributionsUrl: scheduleLink(d,"lnkContributionsTotal",url,"/PublicSite/Filings/Schedules/ViewContributionSchedule.aspx"),
    expendituresUrl: scheduleLink(d,"lnkExpendituresTotal",url,"/PublicSite/Filings/Schedules/ViewExpenditureSchedule.aspx"),
    returnsUrl: scheduleLink(d,"lnkContributionsRetTotal",url,"/PublicSite/Filings/Schedules/ViewReturnsSchedule.aspx") };
}
export type IndianaNativeContributionSchedule = { cells: string[]; day: string; kind: string; name: string; cents: number }[];
export function parseIndianaNativeContributionSchedule(d: Document): IndianaNativeContributionSchedule {
  const g = oneTable(d, "grdContributions");
  headers(g,["Date", "Type", "Contributor", "Address", "Occupation", "Amount", "Aggregate", "Elec Comm", "Explanation"]);
  const rows = [...g.rows].filter(r => r.children[0]?.tagName === "TD");
  return rows.map(r => {
    const amounts = r.querySelectorAll('span[id$="_lblAmount"]'), cells = [...r.children].map(inText);
    inCheck(cells.length === 9 && amounts.length === 1 && cells[2], "native_schedule_row");
    const cents = inCents(inText(amounts[0]!)); inCheck(cents === inCents(cells[5]!), "native_schedule_amount");
    return { cells, day: inDay(cells[0]!), kind: cells[1]!, name: cells[2]!, cents };
  });
}
export function closeIndianaNativeContributionSchedule(opening: IndianaNativeContributionSchedule, closing: IndianaNativeContributionSchedule, report: IndianaNativeMonetaryReport): void {
  inCheck(isDeepStrictEqual(opening, closing), "native_schedule_closing_changed");
  inCheck(opening.reduce((n,r) => inAdd(n,r.cents),0) === report.itemizedReceipts, "native_itemized_parent_closure");
}
export function requireIndianaNativeNoReturns(d: Document): void {
  const controls = d.querySelectorAll<HTMLElement>("#lblNoContributionRecords"), n = controls[0];
  inCheck(controls.length === 1 && n && !n.hidden && n.style.display !== "none" && /\bno\b.*\b(?:contribution|return|record)/i.test(inText(n)) && d.querySelectorAll("table[id]").length === 0, "unqualified_return_schedule");
}
export type IndianaNativePeriod = { begin: string; end: string; filed: string };
/** A covered CFA11 is not additive: the official manual requires its receipts
 * on the following regular CFA4. An uncovered or later-corrected supplement
 * holds this component until its complete native ledger is qualified. */
export function qualifyIndianaNativePeriods(regular: readonly IndianaNativePeriod[], supplements: readonly IndianaNativePeriod[], start: string, through: string): void {
  const validDay = (value: string): void => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    inCheck(m && inDay(`${m[2]}/${m[3]}/${m[1]}`) === value, "invalid_period_date");
  };
  validDay(start); validDay(through);
  for (const p of [...regular, ...supplements]) {
    validDay(p.begin); validDay(p.end);
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(p.filed);
    inCheck(m && Number(m[2]) < 24 && Number(m[3]) < 60 && Number(m[4]) < 60, "invalid_period_clock");
    validDay(m[1]!);
  }
  const periods = [...regular].sort((a,b) => a.begin.localeCompare(b.begin));
  inCheck(periods.length > 0 && periods[0]!.begin === start, "native_cycle_start_missing");
  for (let i=0;i<periods.length;i++) {
    const p=periods[i]!;
    inCheck(p.begin <= p.end && p.end <= through, "native_period_bounds");
    if (i) {
      const previous = new Date(`${periods[i-1]!.end}T00:00:00Z`);
      previous.setUTCDate(previous.getUTCDate()+1);
      inCheck(previous.toISOString().slice(0,10) === p.begin, "native_period_gap_or_overlap");
    }
  }
  for (const s of supplements) inCheck(s.begin <= s.end && periods.some(p => s.begin >= p.begin && s.end <= p.end && s.filed < p.filed), "unqualified_uncovered_supplement");
}
