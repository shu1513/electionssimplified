import { reconcileNewHampshireCurrentReports, type NewHampshireReportHistory } from "./newHampshireCurrentReportAuthority.js";
import type { NewHampshirePublicJsonEndpoint } from "./newHampshireCfsClient.js";

export type NewHampshireNativeRow = Record<string, unknown>;
export type NewHampshireNativeRequest = { endpoint: NewHampshirePublicJsonEndpoint; body: NewHampshireNativeRow };
export type NewHampshireCapturedEnvelope = { envelope: NewHampshireNativeRow; sha256: string };
export type NewHampshireSourceRequest = (request: NewHampshireNativeRequest) => Promise<NewHampshireCapturedEnvelope>;
export type NewHampshireReportedBase = { electionYear: number; electionCycleId: number; registry: NewHampshireNativeRow[] };
export type NewHampshireReportedRows = {
  sourceRowCount: number;
  historicalRowCount: number;
  currentRows: NewHampshireNativeRow[];
};

export class NewHampshireReportedSourceError extends Error {
  constructor(readonly code: string) {
    super(`New Hampshire reported source unavailable: ${code}`);
    this.name = "NewHampshireReportedSourceError";
  }
}
export function nhSourceHold(code: string): never { throw new NewHampshireReportedSourceError(code); }
export function nhSourceObject(value: unknown): NewHampshireNativeRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) nhSourceHold("invalid_native_shape");
  return value as NewHampshireNativeRow;
}
export function nhSourceInteger(value: unknown, minimum = 1): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) nhSourceHold("invalid_native_integer");
  return value;
}
export function nhSourceText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) nhSourceHold("invalid_native_text");
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}
export function nhSourceGuid(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) nhSourceHold("invalid_native_guid");
  return value.toLowerCase();
}
export function nhSourceCents(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !/^-?\d+(?:\.\d{1,2})?$/.test(String(value))) nhSourceHold("invalid_native_money");
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents)) nhSourceHold("invalid_native_money");
  return cents;
}

const PAGE_SIZE = 1000;
type Closed = { pages: NewHampshireNativeRow[]; rows: NewHampshireNativeRow[]; hashes: string[] };
async function closed(request: NewHampshireSourceRequest, endpoint: NewHampshirePublicJsonEndpoint, body: NewHampshireNativeRow): Promise<Closed> {
  const result: Closed = { pages: [], rows: [], hashes: [] };
  let total: number | undefined;
  for (let pageNumber = 1; pageNumber <= 200; pageNumber++) {
    const response = await request({ endpoint, body: { ...body, pageNumber, pageSize: PAGE_SIZE } });
    const envelope = response.envelope;
    if (envelope.succeeded !== true) nhSourceHold("native_response_failed");
    const data = nhSourceObject(envelope.data);
    const count = nhSourceInteger(data.totalItems, 0);
    if (total !== undefined && total !== count) nhSourceHold("pagination_changed");
    total = count;
    if (!Array.isArray(data.items) || data.items.length > PAGE_SIZE) nhSourceHold("invalid_native_page");
    result.pages.push(envelope); result.hashes.push(response.sha256);
    result.rows.push(...data.items.map(nhSourceObject));
    if (result.rows.length === total) return result;
    if (result.rows.length > total || data.items.length === 0) nhSourceHold("incomplete_native_pages");
  }
  return nhSourceHold("source_page_budget");
}
function same(a: Closed, b: Closed): void {
  if (JSON.stringify(a.hashes) !== JSON.stringify(b.hashes)) nhSourceHold("closing_inventory_changed");
}
function registryBody(cycle: number): NewHampshireNativeRow {
  return { sortBy: "FilerName", sortType: "asc", filerTypeCode: "", filerName: null, filingEntityId: null,
    politicalPartyCode: null, OfficeSought: null, CommitteeMakingIE: null, filerSubTypeCode: null,
    totalRaisedMax: null, totalRaisedMin: null, totalSpentMax: null, totalSpentMin: null,
    balanceFundsMax: null, balanceFundsMin: null, accountStatus: null, filerSearchTypeCode: null,
    transactionSourceTypeCode: null, electionCycle: String(cycle), county: null, officeType: null };
}
function validateRegistry(base: NewHampshireReportedBase): void {
  if (base.registry.length === 0) nhSourceHold("empty_registry");
  const ids = new Set<number>();
  for (const row of base.registry) {
    const id = nhSourceInteger(row.filerEntityId);
    if (ids.has(id)) nhSourceHold("duplicate_registry_identity");
    ids.add(id); nhSourceGuid(row.guid); nhSourceText(row.filerName);
    if (row.electionId !== base.electionCycleId || row.electionYear !== base.electionYear ||
      row.electionCycle !== `${base.electionYear} Election Cycle`) nhSourceHold("registry_cycle_mismatch");
  }
}
function registrationIdentity(row: NewHampshireNativeRow): unknown[] {
  // Financial rollups can change during acquisition. Only fields which bind
  // receipt search, candidate aliases and receiving context are compared.
  return [row.filerEntityId,nhSourceGuid(row.guid),row.filerName,row.firstnameLastname,row.firstName,row.lastName,
    row.filerTypeCode,row.filerSubTypeCode,row.officeSoughtName,row.districtName,row.town,row.electionId,row.electionYear,row.electionCycle];
}
async function closingRegistration(request: NewHampshireSourceRequest, base: NewHampshireReportedBase, filingEntityId?: number): Promise<void> {
  const closing = await closed(request,"filingEntities",registryBody(base.electionCycleId));
  const latest = {...base,registry:closing.rows}; validateRegistry(latest);
  if(filingEntityId!==undefined){
    const before=newHampshireReportedRegistration(base,filingEntityId),after=newHampshireReportedRegistration(latest,filingEntityId);
    if(JSON.stringify(registrationIdentity(before))!==JSON.stringify(registrationIdentity(after)))nhSourceHold("registration_inventory_changed");
  }else{
    const identities=(rows:NewHampshireNativeRow[])=>rows.map(registrationIdentity).sort((a,b)=>Number(a[0])-Number(b[0]));
    if(JSON.stringify(identities(base.registry))!==JSON.stringify(identities(latest.registry)))nhSourceHold("registration_inventory_changed");
  }
}

export async function acquireNewHampshireReportedBase(request: NewHampshireSourceRequest, electionYear: number): Promise<NewHampshireReportedBase> {
  if (!Number.isSafeInteger(electionYear) || electionYear < 2016 || electionYear > 2100) nhSourceHold("invalid_cycle_scope");
  const opening = await request({ endpoint: "electionCycles", body: { key: "" } });
  if (opening.envelope.succeeded !== true || !Array.isArray(opening.envelope.data)) nhSourceHold("invalid_cycle_lookup");
  const cycles = opening.envelope.data.map(nhSourceObject).filter(r => r.name === `${electionYear} Election Cycle`);
  if (cycles.length !== 1) nhSourceHold("ambiguous_cycle_lookup");
  const electionCycleId = nhSourceInteger(cycles[0]!.value);
  const registry = await closed(request, "filingEntities", registryBody(electionCycleId));
  same(registry, await closed(request, "filingEntities", registryBody(electionCycleId)));
  const closing = await request({ endpoint: "electionCycles", body: { key: "" } });
  if (opening.sha256 !== closing.sha256) nhSourceHold("closing_cycle_changed");
  const base = { electionYear, electionCycleId, registry: registry.rows };
  validateRegistry(base);
  return base;
}

export function newHampshireReportedRegistration(base: NewHampshireReportedBase, filingEntityId: number): NewHampshireNativeRow {
  nhSourceInteger(filingEntityId);
  const matches = base.registry.filter(r => r.filerEntityId === filingEntityId);
  if (matches.length !== 1) nhSourceHold("receiving_registration_unavailable");
  return matches[0]!;
}
const profileBody = (registrationGuid: string) => ({ filerRegistrationGuid: registrationGuid, sortBy: "", sortType: "" });
async function histories(request: NewHampshireSourceRequest, parents: Closed): Promise<NewHampshireReportHistory[]> {
  const result: NewHampshireReportHistory[] = [];
  for (const row of parents.rows) {
    if (typeof row.hasChild !== "boolean") nhSourceHold("invalid_history_flag");
    if (!row.hasChild) continue;
    const parentReportGuid = nhSourceGuid(row.filerReportGuid);
    const history = await closed(request, "publicFilingHistory", { filerReportGuid: parentReportGuid, sortBy: null, sortType: null, showFilingHistory: true });
    result.push({ parentReportGuid, pages: history.pages });
  }
  return result;
}
function reconcile(rows: NewHampshireNativeRow[], parents: Closed, history: NewHampshireReportHistory[]): NewHampshireReportedRows {
  const result = reconcileNewHampshireCurrentReports({ currentPages: parents.pages, histories: history,
    transactions: rows.map(row => ({ ...row, filerReportGuid: row.filerReportGuid, filerReportVersionId: row.filerReportVersionId })) });
  if (result.status !== "reconciled") nhSourceHold(result.reason);
  const key=(guid:unknown,version:unknown)=>`${nhSourceGuid(guid)}:${nhSourceInteger(version)}`;
  const observed=new Set(rows.map(row=>key(row.filerReportGuid,row.filerReportVersionId)));
  for(const parent of parents.rows){
    if(typeof parent.isPaperFile!=="boolean")nhSourceHold("invalid_paper_report_marker");
    if(!parent.isPaperFile||observed.has(key(parent.filerReportGuid,parent.filerReportVersionID)))continue;
    const older=history.find(h=>nhSourceGuid(h.parentReportGuid)===nhSourceGuid(parent.filerReportGuid));
    if(older&&older.pages.some(page=>{
      const data=nhSourceObject(nhSourceObject(page).data);
      return (data.items as NewHampshireNativeRow[]).some(row=>observed.has(key(row.filerReportGuid,row.filerReportVersionID)));
    }))nhSourceHold("paper_amendment_requires_review");
  }
  return { sourceRowCount: rows.length, historicalRowCount: result.historicalRowCount, currentRows: result.currentRows };
}
function validateTransactions(base: NewHampshireReportedBase, rows: NewHampshireNativeRow[], expectedReceiver?: number): void {
  const identities = new Set<string>();
  for (const row of rows) {
    const id = nhSourceInteger(row.transactionId), v = nhSourceInteger(row.transactionVersionId), guid = nhSourceGuid(row.guid);
    const key = `${id}:${v}:${guid}`;
    if (identities.has(key)) nhSourceHold("duplicate_native_transaction");
    identities.add(key);
    const receiver = nhSourceInteger(row.filerEntityId);
    if (expectedReceiver !== undefined && receiver !== expectedReceiver) nhSourceHold("receiver_scope_mismatch");
    const registration = newHampshireReportedRegistration(base, receiver);
    if (nhSourceGuid(row.filerRegistrationGuid) !== nhSourceGuid(registration.guid) ||
      row.electionCycle !== `${base.electionYear} Election Cycle`) nhSourceHold("transaction_cycle_or_registration_mismatch");
    nhSourceGuid(row.filerReportGuid); nhSourceInteger(row.filerReportVersionId); nhSourceCents(row.transactionAmount);
    if (typeof row.transactionDate !== "string" || !Number.isFinite(Date.parse(row.transactionDate))) nhSourceHold("invalid_transaction_date");
  }
}
function validateCurrentIdentities(rows: NewHampshireNativeRow[]): void {
  const ids = new Set<number>();
  for (const row of rows) {
    const id = nhSourceInteger(row.transactionId);
    if (ids.has(id)) nhSourceHold("ambiguous_current_transaction_version");
    ids.add(id);
  }
}

export async function acquireNewHampshireReportedReceipts(request: NewHampshireSourceRequest, base: NewHampshireReportedBase,
  filingEntityId: number): Promise<NewHampshireReportedRows> {
  const registration = newHampshireReportedRegistration(base, filingEntityId);
  const profile = profileBody(nhSourceGuid(registration.guid));
  const parents = await closed(request, "publicFilingProfile", profile);
  if (parents.rows.length === 0) nhSourceHold("empty_current_inventory");
  const body = { sortBy: "TransactionDate", sortType: "desc", transactionTypeCode: "TCON",
    filerName: nhSourceText(registration.filerName), electionCycle: String(base.electionCycleId) };
  // The public Elasticsearch receipt API ignores its numeric-ID and GUID
  // filters. Native name filtering is followed by exact returned identities.
  const receipts = await closed(request, "receipts", body);
  // A name filter can silently return no rows after a filer rename. Report
  // existence alone does not prove that such an empty search is a money zero.
  if(receipts.rows.length===0)nhSourceHold("empty_receipt_inventory");
  validateTransactions(base, receipts.rows, filingEntityId);
  const history = await histories(request, parents);
  same(receipts, await closed(request, "receipts", body));
  same(parents, await closed(request, "publicFilingProfile", profile));
  await closingRegistration(request,base,filingEntityId);
  const result = reconcile(receipts.rows, parents, history);
  validateCurrentIdentities(result.currentRows);
  for (const row of result.currentRows) {
    nhSourceText(row.transactionSourceTypeCode); nhSourceText(row.transactionSubTypeCode);
    if (!Array.isArray(row.returnContributions)) nhSourceHold("invalid_receipt_return_shape");
    if (row.transactionSourceTypeCode === "TPAC" && ["MTCB", "INKIND"].includes(String(row.transactionSubTypeCode)) &&
      !(typeof row.transactionSubType === "string" && /unitemized/i.test(row.transactionSubType))) {
      nhSourceText(row.sourceName);
      if (nhSourceCents(row.transactionAmount) < 0) nhSourceHold("negative_reported_committee_receipt");
    }
  }
  return result;
}

export async function acquireNewHampshireReportedIe(request: NewHampshireSourceRequest, base: NewHampshireReportedBase): Promise<NewHampshireReportedRows> {
  const body = { sortBy: "TransactionDate", sortType: "desc", transactionTypeCode: "TEXP", transactionSearch: "TIE",
    electionCycle: String(base.electionCycleId) };
  const source = await closed(request, "expenditures", body);
  // No payer is observable in an empty search. It cannot establish that every
  // amendment/report has no IE, so retain prior figures rather than assert zero.
  if (source.rows.length === 0) nhSourceHold("empty_ie_inventory");
  validateTransactions(base, source.rows);
  const currentRows: NewHampshireNativeRow[] = [];
  let historicalRowCount = 0;
  for (const payer of new Set(source.rows.map(r => nhSourceInteger(r.filerEntityId)))) {
    const registration = newHampshireReportedRegistration(base, payer), profile = profileBody(nhSourceGuid(registration.guid));
    const parents = await closed(request, "publicFilingProfile", profile);
    const history = await histories(request, parents);
    same(parents, await closed(request, "publicFilingProfile", profile));
    const result = reconcile(source.rows.filter(r => r.filerEntityId === payer), parents, history);
    currentRows.push(...result.currentRows); historicalRowCount += result.historicalRowCount;
  }
  same(source, await closed(request, "expenditures", body));
  await closingRegistration(request,base);
  validateCurrentIdentities(currentRows);
  for (const row of currentRows) {
    if (row.transactionTypeCode !== "TIE" || row.transactionSubTypeCode !== "TIE" || row.transactionStatusCode !== "TFIL" ||
      row.hasChild !== false || row.childCount !== 0 || !Array.isArray(row.returnExpenditures) || row.returnExpenditures.length !== 0) nhSourceHold("unsupported_ie_role_or_allocation");
    if (row.stance !== "Support" && row.stance !== "Oppose") nhSourceHold("unsupported_ie_stance");
    nhSourceText(row.candidateMeasure); nhSourceText(row.filerName);
    if (nhSourceCents(row.transactionAmount) < 0) nhSourceHold("negative_reported_ie");
  }
  return { sourceRowCount: source.rows.length, historicalRowCount, currentRows };
}
