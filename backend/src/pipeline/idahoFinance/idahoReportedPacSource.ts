import { idahoRegistrationSearchName, normalizeIdahoRegistrationGuid, parseIdahoCandidateRegistrationRow,
  type IdahoCandidateRegistrationRow } from "./idahoCfsClient.js";
import { idahoCandidateNameMatchConfidence, idahoRegistrationRowName } from "./idahoCandidateFilerResolver.js";

export const IDAHO_REPORTED_PAC_SOURCE_URL = "https://sunshine.voteidaho.gov/public/cf/contribution";
export type IdahoPacRow = Record<string, unknown>;
export type IdahoPacScope = { registrationGuid: string; electionYear: number };
export type IdahoPacRequest = { endpoint: "PublicFilerDetails/GetCandidateDetails" | "PublicFilerDetails/GetFilerDetailsById" |
  "PublicFilerDetails/GetFinancialSummaryDetails" | "PublicFilerDetails/GetContributionsCategoriesDetails" |
  "PublicTransactionDetails/GetContributionsDetails"; body: Record<string, unknown> };
export class IdahoPacSourceError extends Error {
  constructor(readonly code: string) { super(`Idaho reported PAC source unavailable: ${code}`); this.name = "IdahoPacSourceError"; }
}
export function idPacHold(code: string): never { throw new IdahoPacSourceError(code); }
export const idPacCanonical = (v: unknown): string => JSON.stringify(v, (_, x) => x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
export function idPacObject(v: unknown): IdahoPacRow {
  if (!v || typeof v !== "object" || Array.isArray(v)) idPacHold("invalid_native_object"); return v as IdahoPacRow;
}
export function idPacText(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || /[\u0000-\u001f\u007f]/u.test(v)) idPacHold("invalid_native_text");
  return v.normalize("NFC").trim().replace(/\s+/gu, " ");
}
export function idPacGuid(v: unknown): string {
  if (typeof v !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v) || /^0{8}(?:-0{4}){3}-0{12}$/.test(v)) idPacHold("invalid_native_guid");
  return v.toLowerCase();
}
export function idPacInteger(v: unknown, min = 0): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) idPacHold("invalid_native_integer"); return v;
}
export function idPacCents(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || !/^-?\d+(?:\.\d{1,2})?$/.test(String(v))) idPacHold("invalid_native_money");
  const [whole, fraction = ""] = String(v).replace(/^-/, "").split(".");
  const exact = (BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"))) * (v < 0 ? -1n : 1n);
  if (exact > BigInt(Number.MAX_SAFE_INTEGER) || exact < BigInt(Number.MIN_SAFE_INTEGER)) idPacHold("unsafe_native_money"); return Number(exact);
}
export function validateIdahoPacScope(s: IdahoPacScope) {
  if (idPacGuid(s.registrationGuid) !== s.registrationGuid || !Number.isSafeInteger(s.electionYear) || s.electionYear < 2026 || s.electionYear > 2100) idPacHold("invalid_receiving_scope");
}
export const idahoPacRequestUrl = (r: IdahoPacRequest) => `https://api-sunshine.voteidaho.gov/api/${r.endpoint}`;
type RequestFn = (r: IdahoPacRequest) => Promise<{ value: unknown; sha256: string }>;
const SOURCE_CODES = new Set(["TIND", "TBSN", "TPAC", "TCENC", "TCAN", "TSELF"]);
const SUBTYPES = new Set(["ITMY", "INKIND", "NITMY", "ANYMS", "ITR"]);
function envelope(value: unknown): unknown {
  const e = idPacObject(value); if (e.succeeded !== true) idPacHold("native_envelope_unavailable"); return e.data;
}
function page(value: unknown, size: number): IdahoPacRow[] {
  const p = idPacObject(envelope(value));
  // Sunshine leaves its paging echo at zero. Exact recorded request plus
  // totalItems/full-length closure, not those unused defaults, prove coverage.
  const metadata = p.pageNumber === 0 && p.pageSize === 0 || p.pageNumber === 1 && p.pageSize === size;
  if (!Array.isArray(p.items) || !metadata || idPacInteger(p.totalItems) !== p.items.length || p.items.length > size) idPacHold("incomplete_native_page");
  return p.items.map(idPacObject);
}
function profile(value: unknown, r: IdahoCandidateRegistrationRow) {
  const p = idPacObject(envelope(value));
  if (p.filerRegistrationID !== r.filerRegistrationId || p.entityID !== r.filerEntityId || p.electionYear !== r.electionYear ||
    p.filerTypeCode !== "CAN" || p.registrationStatus !== "ACTIVE" || p.officeSought !== r.office ||
    idahoCandidateNameMatchConfidence([idPacText(p.fullName)], [idahoRegistrationRowName(r)]) === null) idPacHold("receiving_profile_mismatch");
  const location = (v: string) => v.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
  const zone = ` ${location(idPacText(p.officeDistrictTypeZone))} `;
  for (const value of [r.district, r.seatZone]) if (value && !zone.includes(` ${location(value)} `)) idPacHold("receiving_profile_district_mismatch");
  idPacText(p.jurisdictionName); return p;
}
function financialSummary(value: unknown) {
  const s = idPacObject(envelope(value));
  for (const key of ["totalContributions", "totalLoansReceived", "totalExpenditures", "totalIEExpenditures", "endBalance"]) idPacCents(s[key]);
  idPacGuid(s.filerReportGuid);
  if (typeof s.lastFilingDate !== "string" || !Number.isFinite(Date.parse(s.lastFilingDate))) idPacHold("no_filed_summary");
  return s;
}
function categories(value: unknown) {
  const a = envelope(value); if (!Array.isArray(a) || a.length > 20) idPacHold("invalid_category_inventory");
  const seen = new Set<string>(), result: { code: string; cents: number }[] = [];
  for (const value of a) {
    const row = idPacObject(value), code = idPacText(row.transactionSourceTypeCode), cents = idPacCents(row.amount);
    if (!SOURCE_CODES.has(code) || seen.has(code)) idPacHold("changed_contributor_vocabulary");
    seen.add(code); idPacText(row.transactionSourceType); result.push({ code, cents });
  }
  return result.sort((a, b) => a.code.localeCompare(b.code));
}
function selectedReceipts(rows: IdahoPacRow[], r: IdahoCandidateRegistrationRow) {
  const selected = rows.filter(row => idPacGuid(row.filerRegistrationGuid) === normalizeIdahoRegistrationGuid(r.registrationGuid));
  const ids = new Set<number>(), guids = new Set<string>();
  for (const row of selected) {
    const id = idPacInteger(row.transactionId, 1), guid = idPacGuid(row.guid);
    if (ids.has(id) || guids.has(guid)) idPacHold("duplicate_current_occurrence"); ids.add(id); guids.add(guid);
    if (row.filerEntityId !== r.filerEntityId || Number(row.electionYear) !== r.electionYear || row.transactionTypeCode !== "TCON" ||
      row.isLegacyRecord !== false || !["TFIL", "TAMD"].includes(String(row.transactionStatusCode)) ||
      !SUBTYPES.has(String(row.transactionSubTypeCode)) || row.transactionSourceTypeCode !== null && !SOURCE_CODES.has(String(row.transactionSourceTypeCode))) idPacHold("receipt_scope_or_role_mismatch");
    idPacInteger(row.transactionVersionId, 1); idPacInteger(row.filerReportId, 1); idPacInteger(row.filerReportVersionId, 1);
    idPacCents(row.transactionAmount);
    if (typeof row.transactionDate !== "string" || !Number.isFinite(Date.parse(row.transactionDate))) idPacHold("invalid_receipt_date");
    if (row.transactionSourceTypeCode === "TPAC" && ["ITMY", "INKIND"].includes(String(row.transactionSubTypeCode))) {
      idPacText(row.sourceName); idPacInteger(row.sourceEntityId, 1);
      if (row.hasChild !== false || row.childCount !== 0 || row.publicChildContributionResult !== null) idPacHold("unsupported_nested_pac_receipt");
    }
  }
  return selected;
}
// The one-page query has no offset boundary. Ignore only position metadata
// when comparing complete closing contents, so date ties cannot invent drift.
const stableRows = (rows: IdahoPacRow[]) => rows.map(({ rowNo: _n, totalRows: _t, ...r }) => idPacCanonical(r)).sort();

/** Native categories independently account for itemized current TPAC money.
 * A complete HTTP page alone cannot authorize known incomplete search data. */
export async function acquireIdahoReportedPacSource(request: RequestFn, scope: IdahoPacScope) {
  validateIdahoPacScope(scope);
  const gridRequest: IdahoPacRequest = { endpoint: "PublicFilerDetails/GetCandidateDetails", body: { pageNumber: 1, pageSize: 5000, sortBy: null, sortType: null } };
  const grid = page((await request(gridRequest)).value, 5000), registrations = grid.map(parseIdahoCandidateRegistrationRow);
  const matches = registrations.filter(r => normalizeIdahoRegistrationGuid(r.registrationGuid) === scope.registrationGuid);
  if (matches.length !== 1) idPacHold("ambiguous_native_registration"); const registration = matches[0]!;
  if (registration.electionYear !== scope.electionYear || registration.isLegacyRecord || registration.status !== "Active") idPacHold("unavailable_registration");
  const key = { filerRegistrationGuid: registration.registrationGuid, isLegacy: "false" };
  const profileRequest: IdahoPacRequest = { endpoint: "PublicFilerDetails/GetFilerDetailsById", body: key };
  const summaryRequest: IdahoPacRequest = { endpoint: "PublicFilerDetails/GetFinancialSummaryDetails", body: { ...key, filingStatusCode: "FIL" } };
  const categoryRequest: IdahoPacRequest = { endpoint: "PublicFilerDetails/GetContributionsCategoriesDetails", body: { ...key, filingYear: null } };
  const receiptRequest: IdahoPacRequest = { endpoint: "PublicTransactionDetails/GetContributionsDetails", body: { pageNumber: 1, pageSize: 10000,
    sortBy: "TransactionDate", sortType: "desc", transactionTypeCode: "TCON", filerName: idahoRegistrationSearchName(registration),
    sourceName: null, transactionAmountMax: null, transactionAmountMin: null, sourceTypeCode: null, committeeType: null,
    transactionSubTypeCode: null, electionID: null, reportName: null, toDate: null, fromDate: null, electionType: null, electionYear: null, filerRegistrationGuid: null } };
  const openingProfile = profile((await request(profileRequest)).value, registration);
  const openingSummary = financialSummary((await request(summaryRequest)).value), openingCategories = categories((await request(categoryRequest)).value);
  const first = page((await request(receiptRequest)).value, 10000), closing = page((await request(receiptRequest)).value, 10000);
  const closingCategories = categories((await request(categoryRequest)).value), closingSummary = financialSummary((await request(summaryRequest)).value);
  const closingProfile = profile((await request(profileRequest)).value, registration);
  if (idPacCanonical(stableRows(first)) !== idPacCanonical(stableRows(closing)) || idPacCanonical(openingCategories) !== idPacCanonical(closingCategories) ||
    idPacCanonical(openingSummary) !== idPacCanonical(closingSummary) || idPacCanonical(openingProfile) !== idPacCanonical(closingProfile)) idPacHold("changed_native_source");
  const rows = selectedReceipts(first, registration), aggregation = aggregateIdahoPacRows(rows);
  const categoryCents = openingCategories.find(c => c.code === "TPAC")?.cents ?? 0;
  if (categoryCents !== aggregation.totalCents) idPacHold("reported_pac_category_mismatch");
  return { scope, registration, registrations, profile: openingProfile, summary: openingSummary,
    categories: openingCategories, rows, searchRowCount: first.length, categoryCents };
}

export type IdahoPacAggregation = ReturnType<typeof aggregateIdahoPacRows>;
export function aggregateIdahoPacRows(rows: readonly IdahoPacRow[]) {
  const groups = new Map<string, { key: string; name: string; cents: number; rowCount: number }>();
  let totalCents = 0, positiveCents = 0, negativeCents = 0, positiveRows = 0, negativeRows = 0, zeroRows = 0,
    selectedRowCount = 0, excludedPacUnitemizedRows = 0, excludedPacUnitemizedCents = 0;
  const add = (a: number, b: number) => { const n = a + b; if (!Number.isSafeInteger(n)) idPacHold("unsafe_receipt_sum"); return n; };
  for (const row of rows) {
    if (row.transactionSourceTypeCode !== "TPAC") continue;
    const cents = idPacCents(row.transactionAmount);
    if (["NITMY", "ANYMS"].includes(String(row.transactionSubTypeCode))) {
      excludedPacUnitemizedRows++; excludedPacUnitemizedCents = add(excludedPacUnitemizedCents, cents); continue;
    }
    if (!["ITMY", "INKIND"].includes(String(row.transactionSubTypeCode)) || row.transactionTypeCode !== "TCON") idPacHold("unsupported_pac_receipt_role");
    const key = `source:${idPacInteger(row.sourceEntityId, 1)}`, name = idPacText(row.sourceName), g = groups.get(key) ?? { key, name, cents: 0, rowCount: 0 };
    g.cents = add(g.cents, cents); g.rowCount++; if (name.localeCompare(g.name) < 0) g.name = name; groups.set(key, g);
    totalCents = add(totalCents, cents); selectedRowCount++;
    if (cents > 0) { positiveCents = add(positiveCents, cents); positiveRows++; }
    else if (cents < 0) { negativeCents = add(negativeCents, cents); negativeRows++; } else zeroRows++;
  }
  if (totalCents < 0 || [...groups.values()].some(g => g.cents < 0)) idPacHold("negative_reported_pac_balance");
  const canceled = [...groups.values()].filter(g => g.cents === 0);
  return { totalCents, positiveCents, negativeCents, positiveRows, negativeRows, zeroRows, selectedRowCount,
    receivingRowCount: rows.length, excludedPacUnitemizedRows, excludedPacUnitemizedCents,
    canceledGroupCount: canceled.length, canceledRowCount: canceled.reduce((n, g) => n + g.rowCount, 0),
    groups: [...groups.values()].filter(g => g.cents > 0).sort((a, b) => b.cents - a.cents || a.key.localeCompare(b.key)) };
}
