import { buildWashingtonPdcDatasetUrl } from "./washingtonPdcClient.js";

export const WASHINGTON_REPORTED_PAC_SOURCE_URL = "https://data.wa.gov/d/kv7h-kjye";
export const WASHINGTON_REPORTED_PAC_CODE = "Political Action Committee";
export type WashingtonPacRow = Record<string, unknown>;
export type WashingtonPacScope = { electionYear: number; filerId: string; committeeId: string };
export type WashingtonPacRequest = { dataset: "3h9x-7bvm" | "kv7h-kjye"; params: Record<string, string | number> };
export type WashingtonPacRequestFn = (request: WashingtonPacRequest) => Promise<{ rows: unknown[]; sha256: string }>;
export class WashingtonPacSourceError extends Error {
  constructor(readonly code: string) { super(`Washington PAC source unavailable: ${code}`); this.name = "WashingtonPacSourceError"; }
}
export function waPacHold(code: string): never { throw new WashingtonPacSourceError(code); }
export function waPacText(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || /[\u0000-\u001f\u007f]/u.test(v)) waPacHold("invalid_native_text");
  return v.normalize("NFC").trim().replace(/\s+/gu, " ");
}
export function waPacObject(v: unknown): WashingtonPacRow {
  if (!v || typeof v !== "object" || Array.isArray(v)) waPacHold("invalid_native_row");
  return v as WashingtonPacRow;
}
export function waPacCents(v: unknown): number {
  if (typeof v !== "string" || !/^-?\d+(?:\.\d{1,2})?$/.test(v)) waPacHold("invalid_native_money");
  const n = Math.round(Number(v) * 100); if (!Number.isSafeInteger(n)) waPacHold("unsafe_native_money"); return n;
}
export function validateWashingtonPacScope(s: WashingtonPacScope): void {
  if (!Number.isSafeInteger(s.electionYear) || s.electionYear < 2000 || s.electionYear > 2100 ||
    typeof s.filerId !== "string" || !s.filerId.trim() || /[\u0000-\u001f\u007f]/u.test(s.filerId) ||
    !/^[1-9]\d*$/.test(s.committeeId) || !Number.isSafeInteger(Number(s.committeeId))) waPacHold("invalid_receiving_scope");
}
export const washingtonPacRequestUrl = (r: WashingtonPacRequest) => buildWashingtonPdcDatasetUrl(r.dataset, r.params);
const literal = (s: string | number) => `'${String(s).replaceAll("'", "''")}'`;
const RECEIPT_SELECT = "id,report_number,origin,committee_id,filer_id,election_year,amount,cash_or_in_kind,receipt_date,code,contributor_category,contributor_name,url,row_checksum";
const SUMMARY_SELECT = "id,filer_id,filer_type,committee_id,candidacy_id,filer_name,election_year,office,legislative_district,jurisdiction,position,reporting_option,has_reports,active_candidate";
const CODE_CATEGORIES = new Map<string, readonly string[]>([
  ["Business", ["Organization"]], ["Caucus", ["Organization"]], ["Individual", ["Individual"]],
  ["Low-cost Fundraiser", ["Individual"]], ["Other", ["Individual", "Organization"]], ["Party", ["Organization"]],
  [WASHINGTON_REPORTED_PAC_CODE, ["Organization"]], ["Self", ["Individual"]], ["Union", ["Organization"]],
]);
function count(rows: unknown[]): number {
  const v = rows.length === 1 ? waPacObject(rows[0]).row_count : null;
  if (typeof v !== "string" || !/^(?:0|[1-9]\d*)$/.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) > 10_000) waPacHold("incomplete_native_count");
  return Number(v);
}
function vocabulary(rows: unknown[]): string[] {
  if (rows.length === 0 || rows.length >= 100) waPacHold("unavailable_contributor_vocabulary");
  const seen = new Set<string>();
  for (const value of rows) {
    const r = waPacObject(value), code = waPacText(r.code), category = waPacText(r.contributor_category), key = `${code}:${category}`;
    if (!CODE_CATEGORIES.get(code)?.includes(category) || seen.has(key) || typeof r.row_count !== "string" || !/^[1-9]\d*$/.test(r.row_count)) waPacHold("changed_contributor_vocabulary");
    seen.add(key);
  }
  return [...seen].sort();
}
function receivingSummary(rows: unknown[], scope: WashingtonPacScope): WashingtonPacRow {
  if (rows.length !== 1) waPacHold("ambiguous_receiving_summary");
  const r = waPacObject(rows[0]);
  if (r.filer_id !== scope.filerId || r.committee_id !== scope.committeeId || r.election_year !== String(scope.electionYear) || r.filer_type !== "CA") waPacHold("receiving_summary_mismatch");
  if (r.reporting_option !== "full" || r.has_reports !== true) waPacHold("itemized_receipts_unavailable");
  waPacText(r.filer_name); waPacText(r.office); waPacText(r.candidacy_id);
  return r;
}
async function pages(request: WashingtonPacRequestFn, where: string) {
  const rows: WashingtonPacRow[] = [], hashes: string[] = [];
  for (let page = 0; page < 20; page++) {
    const result = await request({ dataset: "kv7h-kjye", params: { $select: RECEIPT_SELECT, $where: where,
      $order: "id ASC,origin ASC", $limit: 500, $offset: page * 500 } });
    if (result.rows.length > 500) waPacHold("invalid_page_size");
    rows.push(...result.rows.map(waPacObject)); hashes.push(result.sha256);
    if (result.rows.length < 500) return { rows, hashes };
  }
  return waPacHold("source_page_budget");
}

/** The publisher's current view excludes superseded amended reports. Native
 * code identifies PACs; broad Organization and name-word guesses do not. */
export async function acquireWashingtonReportedPacSource(request: WashingtonPacRequestFn, scope: WashingtonPacScope) {
  validateWashingtonPacScope(scope);
  const cycle = `election_year=${literal(scope.electionYear)}`;
  const receiving = `${cycle} AND filer_id=${literal(scope.filerId)} AND committee_id=${literal(scope.committeeId)}`;
  const summaryRequest: WashingtonPacRequest = { dataset: "3h9x-7bvm", params: { $select: SUMMARY_SELECT, $where: receiving, $limit: 5 } };
  const catalogRequest: WashingtonPacRequest = { dataset: "kv7h-kjye", params: { $select: "code,contributor_category,count(*) as row_count",
    $where: cycle, $group: "code,contributor_category", $order: "code,contributor_category", $limit: 100 } };
  const where = `${receiving} AND code=${literal(WASHINGTON_REPORTED_PAC_CODE)} AND contributor_category='Organization'`;
  const countRequest: WashingtonPacRequest = { dataset: "kv7h-kjye", params: { $select: "count(*) as row_count", $where: where } };
  const opening = await request(summaryRequest), summary = receivingSummary(opening.rows, scope);
  const codes = vocabulary((await request(catalogRequest)).rows);
  const expected = count((await request(countRequest)).rows);
  const first = await pages(request, where), closing = await pages(request, where);
  if (first.rows.length !== expected || count((await request(countRequest)).rows) !== expected || JSON.stringify(first.hashes) !== JSON.stringify(closing.hashes)) waPacHold("changed_receipt_inventory");
  if (JSON.stringify(codes) !== JSON.stringify(vocabulary((await request(catalogRequest)).rows))) waPacHold("changed_contributor_vocabulary");
  const last = await request(summaryRequest); receivingSummary(last.rows, scope);
  if (opening.sha256 !== last.sha256) waPacHold("changed_receiving_summary");
  const seen = new Set<string>();
  for (const r of first.rows) {
    if (r.filer_id !== scope.filerId || r.committee_id !== scope.committeeId || r.election_year !== String(scope.electionYear) ||
      r.code !== WASHINGTON_REPORTED_PAC_CODE || r.contributor_category !== "Organization") waPacHold("receipt_scope_mismatch");
    const id = waPacText(r.id), origin = waPacText(r.origin), key = JSON.stringify([id, origin]);
    if (seen.has(key)) waPacHold("duplicate_native_occurrence"); seen.add(key);
    waPacText(r.report_number); waPacText(r.contributor_name);
    if (typeof r.receipt_date !== "string" || !Number.isFinite(Date.parse(r.receipt_date))) waPacHold("invalid_receipt_date");
    const cents = waPacCents(r.amount);
    if (!(origin === "C3" || origin === "AU" || origin === "C.1" ? r.cash_or_in_kind === "Cash" : origin === "B.1" && r.cash_or_in_kind === "In-kind") ||
      cents < 0 && origin !== "C.1") waPacHold("unsupported_pac_receipt_role");
  }
  return { scope, summary, rows: first.rows };
}

export type WashingtonPacAggregation = ReturnType<typeof aggregateWashingtonPacRows>;
/** Signed adjustments participate before any grouping/display cap. Unpaid
 * loans remain in the publisher's receipt scope; separate refunds do not. */
export function aggregateWashingtonPacRows(rows: readonly WashingtonPacRow[]) {
  const groups = new Map<string, { key: string; name: string; cents: number; rowCount: number }>();
  let totalCents = 0, positiveCents = 0, negativeCents = 0, positiveRows = 0, negativeRows = 0, zeroRows = 0;
  const safeAdd = (a: number, b: number) => { const n = a + b; if (!Number.isSafeInteger(n)) waPacHold("unsafe_receipt_sum"); return n; };
  for (const row of rows) {
    if (row.code !== WASHINGTON_REPORTED_PAC_CODE || row.contributor_category !== "Organization") waPacHold("aggregation_scope_mismatch");
    const cents = waPacCents(row.amount), name = waPacText(row.contributor_name), key = name.toUpperCase();
    if (cents < 0 && row.origin !== "C.1") waPacHold("unsupported_pac_receipt_role");
    const g = groups.get(key) ?? { key, name, cents: 0, rowCount: 0 };
    g.cents = safeAdd(g.cents, cents); g.rowCount++; if (name.localeCompare(g.name) < 0) g.name = name; groups.set(key, g);
    totalCents = safeAdd(totalCents, cents);
    if (cents > 0) { positiveCents = safeAdd(positiveCents, cents); positiveRows++; }
    else if (cents < 0) { negativeCents = safeAdd(negativeCents, cents); negativeRows++; } else zeroRows++;
  }
  if ([...groups.values()].some(g => g.cents < 0) || totalCents < 0) waPacHold("negative_reported_pac_balance");
  const canceled = [...groups.values()].filter(g => g.cents === 0);
  return { totalCents, positiveCents, negativeCents, positiveRows, negativeRows, zeroRows, sourceRowCount: rows.length,
    canceledGroupCount: canceled.length, canceledRowCount: canceled.reduce((n, g) => n + g.rowCount, 0),
    groups: [...groups.values()].filter(g => g.cents > 0).sort((a, b) => b.cents - a.cents || a.key.localeCompare(b.key)) };
}
