import {
  decodeOregonVerifiedHtmlBytes, decodeOregonVerifiedTransactionWorkbook,
  decodeOregonVerifiedTransactionSearch, decodeOregonVerifiedTransactionDetail,
  decodeOregonVerifiedTransactionHistory, decodeOregonVerifiedSoo,
  decodeOregonVerifiedCandidateDirectory, fingerprintOregonVerifiedRows, hashOregonVerifiedBytes,
  type OregonVerifiedDetail, type OregonVerifiedTransactionRow, type OregonVerifiedSoo,
} from "./oregonVerifiedSourceDecoders.js";
import type { OregonPacRawEvidence, OregonPacCandidateContext } from "./oregonVerifiedPacSource.js";
import { oregonVerifiedCandidateOfficeLine } from "./oregonVerifiedCandidateContext.js";

export type OregonOutsideRawEvidence = OregonPacRawEvidence;
export type OregonOutsideSourceSnapshot = {
  independent: { pages: readonly OregonOutsideRawEvidence[]; workbook: OregonOutsideRawEvidence };
  financialDetails: readonly OregonOutsideRawEvidence[];
  histories: readonly OregonOutsideRawEvidence[];
  payerSoo: OregonOutsideRawEvidence;
  candidateDirectory: readonly OregonOutsideRawEvidence[];
  receivingSoo: OregonOutsideRawEvidence;
  qualifiedTargetSoo: OregonOutsideRawEvidence;
};
export type OregonOutsideSourceTransaction = {
  transactionId: string; originalId: string; date: string; amountCents: number; identityFingerprint: string;
};
export type OregonOutsideSourceAllocation = {
  transactionId: string; occurrence: number; targetName: string; targetCommitteeId: string | null;
  supportOppose: "support" | "oppose"; amountCents: number; mechanism: "independent"; sourceUrl: string;
};
export type OregonVerifiedOutsideEvidence = {
  version: 1; scope: "current_original_cash_ie_allocations";
  candidateContext: OregonPacCandidateContext; payer: { committeeId: string; committeeName: string };
  windowStart: string; windowEnd: string;
  allocationPolicy: "2026_general_rolling_window_2026-09-22_2026-11-03";
  contextFingerprint: string; payerSooFingerprint: string;
  transactions: readonly OregonOutsideSourceTransaction[];
  allocations: readonly OregonOutsideSourceAllocation[];
  supportCents: number; opposeCents: number; sourceHashes: readonly string[];
};
export type OregonVerifiedOutsideInput = {
  candidateContext: OregonPacCandidateContext; payerCommitteeId: string; windowStart: string; windowEnd: string;
  before: OregonOutsideSourceSnapshot; after: OregonOutsideSourceSnapshot; priorProvenance?: unknown;
};
const ORIGIN = "https://secure.sos.state.or.us";
const POLICY = "2026_general_rolling_window_2026-09-22_2026-11-03" as const;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fingerprint = (v: unknown): string => fingerprintOregonVerifiedRows([v]);
const norm = (s: string): string => s.normalize("NFKC").toUpperCase().replace(/\s+/g, " ").trim();
function person(s: string): string {
  const p = s.split(",");
  return p.length === 2 ? norm(p[1] + " " + p[0]) : norm(s);
}
function fail(s: string): never { throw new Error("Oregon outside source: " + s); }
function id(v: unknown): v is string {
  return typeof v === "string" && /^[1-9]\d*$/.test(v) && Number.isSafeInteger(Number(v));
}
function iso(s: string): string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) fail("invalid scope date");
  const d = new Date(s + "T00:00:00Z");
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== s) fail("invalid scope calendar date");
  return s;
}
const us = (s: string): string => s.slice(5, 7) + "/" + s.slice(8, 10) + "/" + s.slice(0, 4);
function checked(e: OregonOutsideRawEvidence, path: string, method: "GET" | "POST", query: Record<string, string> = {}): void {
  if (!e || !(e.bytes instanceof Uint8Array) || !e.request) fail("missing raw evidence");
  const r = e.request, u = new URL(r.url);
  if (u.origin !== ORIGIN || u.username || u.password || u.hash || u.port || u.pathname !== "/orestar/" + path ||
      r.method !== method || r.status !== 200 || !HASH.test(r.sha256) || r.sha256 !== hashOregonVerifiedBytes(e.bytes) ||
      r.byteCount !== e.bytes.byteLength || r.byteCount < 1 || r.byteCount > 64 * 1024 * 1024) fail("invalid request-bound raw evidence");
  if (!r.requestFields || Object.entries(r.requestFields).some(([k, v]) => /cookie|token|authorization/i.test(k) || typeof v !== "string")) fail("unsafe request scope");
  if (Array.from(u.searchParams.keys()).length !== Object.keys(query).length ||
      Object.entries(query).some(([k, v]) => u.searchParams.getAll(k).length !== 1 || u.searchParams.get(k) !== v)) fail("wrong exact source URL identity");
  if (!Number.isFinite(Date.parse(r.startedAt)) || !Number.isFinite(Date.parse(r.endedAt)) ||
      Date.parse(r.startedAt) > Date.parse(r.endedAt)) fail("invalid capture interval");
}
function html(e: OregonOutsideRawEvidence, path: string, query: Record<string, string> = {}): string {
  checked(e, path, "GET", query); return decodeOregonVerifiedHtmlBytes(e.bytes);
}
function requestScope(fields: Readonly<Record<string, string>>, expected: Record<string, string>, optional: Record<string, string> = {}): void {
  if (Object.entries(expected).some(([k, v]) => fields[k] !== v)) fail("wrong complete request scope");
  for (const [k, v] of Object.entries(fields)) {
    if (k in expected) continue;
    if (k in optional && optional[k] === v) continue;
    if (v !== "") fail("unproved restrictive request field " + k);
  }
}
function allRaw(s: OregonOutsideSourceSnapshot): OregonOutsideRawEvidence[] {
  return [...s.independent.pages, s.independent.workbook, ...s.financialDetails, ...s.histories,
    s.payerSoo, ...s.candidateDirectory, s.receivingSoo, s.qualifiedTargetSoo];
}
function withoutOrdinal<T extends { occurrence: number }>(r: T): Omit<T, "occurrence"> {
  const { occurrence: _ordinal, ...identity } = r; return identity;
}
function semanticSoo(s: OregonVerifiedSoo): string {
  const { sha256: _raw, ...identity } = s; return fingerprint(identity);
}
function semanticDetail(s: OregonVerifiedDetail): unknown {
  const { sha256: _raw, mechanisms, rawFields, ...identity } = s;
  // The observed mechanism list can change display order. Preserve full tuples and every occurrence.
  return { ...identity, mechanismsFingerprint: fingerprintOregonVerifiedRows(mechanisms.map(withoutOrdinal)),
    rawFields: { ...rawFields, "In-Kind/Independent Expenditures": [...(rawFields["In-Kind/Independent Expenditures"] ?? [])].sort() } };
}
function soa(e: OregonOutsideRawEvidence, committeeId: string, sourceSooRsn?: string): OregonVerifiedSoo {
  const s = decodeOregonVerifiedSoo(html(e, "sooDetail.do", sourceSooRsn ? { sooRsn: sourceSooRsn } : { cneCommitteeId: committeeId }));
  if (s.committeeId !== committeeId || sourceSooRsn && s.sourceSooRsn !== null && s.sourceSooRsn !== sourceSooRsn) fail("SOO identity mismatch");
  return s;
}
function sourceOffice(c: OregonPacCandidateContext): string {
  const office = oregonVerifiedCandidateOfficeLine(c);
  if (office === null) fail("unsupported local office/seat context");
  return office;
}
function receiving(s: OregonVerifiedSoo, c: OregonPacCandidateContext): void {
  if (s.committeeType !== "Candidate Committee" || !s.candidateName || person(s.candidateName) !== person(c.candidateName) ||
      norm(s.electionOfficeLines.join(" ")) !== norm("2026 General Election " + sourceOffice(c))) fail("receiving election/office/person mismatch");
}
function targetContext(s: OregonOutsideSourceSnapshot, c: OregonPacCandidateContext) {
  // Initial source contract has a complete single native results page. Continuation is unknown, never truncated acceptance.
  if (s.candidateDirectory.length !== 1) fail("missing/unsupported native directory pagination");
  const e = s.candidateDirectory[0];
  checked(e, "CommitteeSearchSecondPage.do", "POST");
  requestScope(e.request.requestFields, {
    yearActive: "2026", filerType: "CANDALL", discontinuedSOO: "on", approvedSOO: "on",
    pendingApprovalSOO: "on", insufficientSOO: "on", resolvedSOO: "on", rejectedSOO: "on",
  }, { buttonName: "electionSearch", search: "Submit" });
  const d = decodeOregonVerifiedCandidateDirectory(decodeOregonVerifiedHtmlBytes(e.bytes));
  if (d.hasNextPage || d.rows.length !== d.declaredCount ||
      !/Election Year\s*=\s*2026/.test(d.criteria) || !/Candidate Committee \(All\)/.test(d.criteria) ||
      ["Discontinued", "Approved", "Pending Approval", "Pending Insufficient", "Pending Resolved", "Rejected"].some(x => !d.criteria.includes(x))) fail("incomplete all-status target directory");
  const matches = d.rows.filter(r => person(r.candidateName) === person(c.candidateName));
  if (matches.length !== 1 || matches[0].committeeId !== c.committeeId) fail("ambiguous/missing full target context");
  const selected = matches[0];
  const current = soa(s.receivingSoo, c.committeeId), qualified = soa(s.qualifiedTargetSoo, c.committeeId, selected.sourceSooRsn);
  receiving(current, c); receiving(qualified, c);
  if (norm(current.committeeName) !== norm(selected.committeeName) || norm(qualified.committeeName) !== norm(selected.committeeName) ||
      person(qualified.candidateName ?? "") !== person(selected.candidateName) ||
      norm(selected.officePartyLines[0] ?? "") !== norm(sourceOffice(c))) fail("directory/qualified SOO mismatch");
  return { directoryFingerprint: fingerprintOregonVerifiedRows(d.rows.map(withoutOrdinal)),
    fingerprint: fingerprint([withoutOrdinal(selected), semanticSoo(current), semanticSoo(qualified)]) };
}
function lookupDetails(rows: readonly OregonOutsideRawEvidence[]) {
  const result = new Map<string, OregonVerifiedDetail>();
  for (const e of rows) {
    const key = new URL(e.request.url).searchParams.get("tranRsn");
    if (!id(key) || result.has(key)) fail("duplicate/invalid detail ID");
    const d = decodeOregonVerifiedTransactionDetail(html(e, "gotoPublicTransactionDetail.do", { tranRsn: key }));
    if (d.transactionId !== key) fail("detail source ID mismatch");
    result.set(key, d);
  }
  return result;
}
function lookupHistories(rows: readonly OregonOutsideRawEvidence[]) {
  const result = new Map<string, ReturnType<typeof decodeOregonVerifiedTransactionHistory>>();
  for (const e of rows) {
    const key = new URL(e.request.url).searchParams.get("tranRsn");
    if (!id(key) || result.has(key)) fail("duplicate/invalid history ID");
    const h = decodeOregonVerifiedTransactionHistory(html(e, "ceTransactionHistory.do", { tranRsn: key }));
    if (h.transactionId !== key) fail("history source ID mismatch");
    result.set(key, h);
  }
  return result;
}
function address(w: OregonVerifiedTransactionRow): readonly string[] {
  const r = w.rawFields, format = (v: unknown): string => String(v ?? "").normalize("NFKC").toUpperCase().replace(/\s+/g, " ").trim();
  const country = format(r.Country);
  if (country !== "" && country !== "UNITED STATES" || format(r["Foreign Postal Code"]) !== "") fail("unsupported foreign address projection");
  const zip = String(r.Zip ?? "").trim(), plus = String(r["Zip Plus Four"] ?? "").trim();
  if (!/^\d{1,5}$/.test(zip) || plus && !/^\d{4}$/.test(plus)) fail("unsupported source ZIP projection");
  // Both exact locality presentations are published. Keep every component's
  // punctuation and words; only the source's City/State separator differs.
  const locality = String(r.State ?? "") + " " + zip.padStart(5, "0") + (plus ? "-" + plus : "");
  return [", ", " "].map(separator => format([r["Addr Line1"], r["Addr Line2"],
    String(r.City ?? "") + separator + locality].map(v => String(v ?? "")).join(" ")));
}
function addressText(lines: readonly string[]): string {
  return lines.join(" ").normalize("NFKC").toUpperCase().replace(/\s+/g, " ").trim();
}
function ledger(s: OregonOutsideSourceSnapshot, input: OregonVerifiedOutsideInput) {
  if (!s.independent.pages.length) fail("missing Independent native pages");
  const base = { cneSearchFilerCommitteeId: input.payerCommitteeId, cneSearchTranType: "E", cneSearchIndependentInd: "I",
    cneSearchTranStartDate: us(input.windowStart), cneSearchTranEndDate: us(input.windowEnd) };
  let count: number | undefined, criteria: string | undefined, financeCriteria: string | undefined;
  const native: ReturnType<typeof decodeOregonVerifiedTransactionSearch>["rows"] = [];
  for (let i = 0; i < s.independent.pages.length; i++) {
    const e = s.independent.pages[i];
    requestScope(e.request.requestFields, { ...base, cneSearchPageIdx: String(i), cneSearchButtonName: i ? "next" : "search" },
      { cneSearchFilerCommitteeTxtSearchType: "C", cneSearchContributorTxtSearchType: "C" });
    checked(e, "gotoPublicTransactionSearchResults.do", "POST");
    const p = decodeOregonVerifiedTransactionSearch(decodeOregonVerifiedHtmlBytes(e.bytes));
    if (p.declaredCount >= 5000 || p.displayedLimit !== null && p.declaredCount >= p.displayedLimit ||
        (i < s.independent.pages.length - 1 && !p.hasNextPage)) fail("capped/partial Independent query");
    if (count !== undefined && (count !== p.declaredCount || criteria !== p.criteria || financeCriteria !== p.projectedCriteria)) fail("changing native Independent pages");
    count = p.declaredCount; criteria = p.criteria; financeCriteria = p.projectedCriteria; native.push(...p.rows);
  }
  if (native.length !== count || new Set(native.map(r => r.transactionId)).size !== native.length) fail("duplicate/incomplete current transaction IDs");
  const publishedCriteria = new Map((financeCriteria ?? "").split(",").map(v => v.trim()).filter(Boolean).map(v => {
    const split = v.indexOf("="); return [v.slice(0, split).trim(), v.slice(split + 1).trim()];
  }));
  if (publishedCriteria.size !== 3 || publishedCriteria.get("Tran Start Date") !== us(input.windowStart) ||
      publishedCriteria.get("Tran End Date") !== us(input.windowEnd) ||
      publishedCriteria.get("Filer/Committee ID") !== input.payerCommitteeId) fail("native response query mismatch");
  checked(s.independent.workbook, "XcelCNESearch", "GET");
  // XcelCNESearch is a session-bound GET, with no financial request body.
  // Its complete financial membership is bound below to the independently scoped native ledger.
  requestScope(s.independent.workbook.request.requestFields, {});
  const workbook = decodeOregonVerifiedTransactionWorkbook(s.independent.workbook.bytes, { mode: "current", expectedCommitteeId: input.payerCommitteeId });
  if (workbook.rows.length !== native.length || new Set(workbook.rows.map(r => r.transactionId)).size !== workbook.rows.length) fail("workbook/native complete count mismatch");
  const details = lookupDetails(s.financialDetails), histories = lookupHistories(s.histories);
  if (details.size !== workbook.rows.length || histories.size !== workbook.rows.length) fail("missing complete closing detail/history scope");
  const nativeById = new Map(native.map(r => [r.transactionId, r]));
  const identities: OregonOutsideSourceTransaction[] = [];
  const payer = soa(s.payerSoo, input.payerCommitteeId);
  if (payer.committeeType !== "Political Action Committee" || !payer.committeeName) fail("unsupported known payer identity");
  for (const w of workbook.rows) {
    const n = nativeById.get(w.transactionId), d = details.get(w.transactionId), h = histories.get(w.transactionId);
    if (!n || !d || !h) fail("missing full financial identity");
    if (w.status !== "Original" || w.originalId !== w.transactionId || w.expired || w.deleted ||
        w.subType !== "Cash Expenditure" || w.amountCents < 1 || w.date < input.windowStart || w.date > input.windowEnd ||
        d.versionStatus !== "Original" || d.expired || d.deleted || d.transactionType !== "Expenditure" ||
        d.subType !== w.subType || !["Filed", "Complete"].includes(d.processStatus) ||
        d.filerCommitteeId !== input.payerCommitteeId || d.transactionId !== w.transactionId ||
        d.amountCents !== w.amountCents || d.date !== w.date || norm(d.filerName) !== norm(payer.committeeName) ||
        norm(String(w.rawFields.Filer ?? "")) !== norm(payer.committeeName) ||
        d.bookType !== w.bookType || norm(d.name ?? "") !== norm(String(w.rawFields["Contributor/Payee"] ?? "")) ||
        !address(w).includes(addressText(d.addressLines))) fail("unsupported/current detail-workbook identity " + w.transactionId);
    if (n.date !== w.date || n.status !== w.status || n.amountCents !== w.amountCents || n.subType !== w.subType ||
        n.expired || n.deleted || norm(n.filerName) !== norm(payer.committeeName) ||
        norm(n.projectedName) !== norm(String(w.rawFields["Contributor/Payee"] ?? "")) ||
        n.sourceFilerReference.kind === "public_committee" && n.filerCommitteeId !== input.payerCommitteeId ||
        n.sourceFilerReference.kind === "internal_filer" && !id(n.sourceFilerReference.id)) fail("native/detail public payer identity mismatch");
    if (h.rows.length !== 1 || h.rows[0].transactionId !== w.transactionId || h.rows[0].status !== "Original" ||
        h.rows[0].date !== w.date || h.rows[0].subType !== w.subType || h.rows[0].amountCents !== w.amountCents ||
        norm(h.rows[0].name) !== norm(n.projectedName)) fail("unsupported original public history " + w.transactionId);
    const independent = d.mechanisms.filter(m => m.mechanism === "independent");
    if (!independent.length || independent.some(m => !m.supportOppose || m.amountCents < 1 || m.amountCents > w.amountCents) ||
        independent.reduce((sum, m) => sum + m.amountCents, 0) > w.amountCents) fail("unproved/overallocated Independent cash transaction");
    identities.push({ transactionId: w.transactionId, originalId: w.originalId, date: w.date, amountCents: w.amountCents,
      identityFingerprint: fingerprint([w.rawFields, withoutOrdinal(n), semanticDetail(d),
        h.rows.map(withoutOrdinal)]) });
  }
  return { rows: workbook.rows, details, identities, payer,
    ledgerFingerprint: fingerprintOregonVerifiedRows(identities),
    payerSooFingerprint: semanticSoo(payer) };
}
function sum(allocations: readonly OregonOutsideSourceAllocation[], stance: "support" | "oppose"): number {
  const n = allocations.filter(a => a.supportOppose === stance).reduce((v, a) => v + a.amountCents, 0);
  if (!Number.isSafeInteger(n) || n < 0) fail("unsafe allocation total"); return n;
}
/** Runtime persistence contract; legacy/malformed authority never authorizes replacement. */
export function validateOregonVerifiedOutsideEvidence(value: unknown, expectedContext?: OregonPacCandidateContext): value is OregonVerifiedOutsideEvidence {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const e = value as OregonVerifiedOutsideEvidence, c = e.candidateContext;
    if (expectedContext && fingerprint(c) !== fingerprint(expectedContext)) return false;
    if (e.version !== 1 || e.scope !== "current_original_cash_ie_allocations" || e.allocationPolicy !== POLICY ||
        !c || !UUID.test(c.candidateId) || !UUID.test(c.electionId) || !id(c.committeeId) ||
        typeof c.candidateName !== "string" || !person(c.candidateName) || c.electionYear !== 2026 ||
        c.electionType !== "General" || !sourceOffice(c) || !id(e.payer?.committeeId) ||
        typeof e.payer.committeeName !== "string" || !e.payer.committeeName.trim() ||
        !HASH.test(e.contextFingerprint) || !HASH.test(e.payerSooFingerprint) ||
        iso(e.windowStart) > iso(e.windowEnd) || !Array.isArray(e.transactions) || !e.transactions.length ||
        !Array.isArray(e.allocations) || !e.allocations.length || !Array.isArray(e.sourceHashes) ||
        !e.sourceHashes.length || e.sourceHashes.some(h => !HASH.test(h))) return false;
    const tx = new Map<string, OregonOutsideSourceTransaction>(), keys = new Set<string>();
    for (const t of e.transactions) {
      if (!id(t.transactionId) || t.originalId !== t.transactionId || tx.has(t.transactionId) || !HASH.test(t.identityFingerprint) ||
          !Number.isSafeInteger(t.amountCents) || t.amountCents < 1 || iso(t.date) < e.windowStart || t.date > e.windowEnd) return false;
      tx.set(t.transactionId, t);
    }
    const totals = new Map<string, number>();
    for (const a of e.allocations) {
      const t = tx.get(a.transactionId), key = a.transactionId + ":" + a.occurrence;
      if (!t || !Number.isSafeInteger(a.occurrence) || a.occurrence < 0 || keys.has(key) || a.mechanism !== "independent" ||
          !["support", "oppose"].includes(a.supportOppose) || typeof a.targetName !== "string" ||
          person(a.targetName) !== person(c.candidateName) || a.targetCommitteeId !== null && a.targetCommitteeId !== c.committeeId ||
          !Number.isSafeInteger(a.amountCents) || a.amountCents < 1 || t.date < "2026-09-22" || t.date > "2026-11-03" ||
          a.sourceUrl !== ORIGIN + "/orestar/gotoPublicTransactionDetail.do?tranRsn=" + a.transactionId) return false;
      keys.add(key); totals.set(a.transactionId, (totals.get(a.transactionId) ?? 0) + a.amountCents);
      if (totals.get(a.transactionId)! > t.amountCents) return false;
    }
    return e.supportCents === sum(e.allocations, "support") && e.opposeCents === sum(e.allocations, "oppose");
  } catch { return false; }
}
function prior(previous: unknown, next: OregonVerifiedOutsideEvidence): void {
  if (previous === undefined || previous === null) return;
  if (!validateOregonVerifiedOutsideEvidence(previous) ||
      fingerprint(previous.candidateContext) !== fingerprint(next.candidateContext) ||
      fingerprint(previous.payer) !== fingerprint(next.payer) || previous.windowStart !== next.windowStart ||
      previous.windowEnd !== next.windowEnd || previous.contextFingerprint !== next.contextFingerprint ||
      previous.payerSooFingerprint !== next.payerSooFingerprint) fail("invalid/incompatible prior outside authority");
  const current = new Map(next.transactions.map(t => [t.transactionId, t]));
  for (const t of previous.transactions) if (fingerprint(current.get(t.transactionId)) !== fingerprint(t)) fail("prior original transaction disappeared/changed " + t.transactionId);
  // Ordinals are display positions only. Full allocation tuple multiplicities must remain.
  const currentAllocations = next.allocations.map(a => fingerprint(withoutOrdinal(a)));
  for (const a of previous.allocations) {
    const key = fingerprint(withoutOrdinal(a)), index = currentAllocations.indexOf(key);
    if (index < 0) fail("prior accepted allocation disappeared/changed");
    currentAllocations.splice(index, 1);
  }
}
export function verifyOregonVerifiedOutsideSource(input: OregonVerifiedOutsideInput): { evidence?: OregonVerifiedOutsideEvidence; diagnostics: readonly string[] } {
  try {
    const c = input.candidateContext;
    if (!UUID.test(c.candidateId) || !UUID.test(c.electionId) || !id(c.committeeId) ||
        typeof c.candidateName !== "string" || !person(c.candidateName) || c.electionYear !== 2026 ||
        c.electionType !== "General" || !id(input.payerCommitteeId) || input.payerCommitteeId === c.committeeId) fail("invalid local/payer context");
    sourceOffice(c); iso(input.windowStart); iso(input.windowEnd);
    if (input.windowStart > input.windowEnd) fail("reversed Independent window");
    const b = ledger(input.before, input), a = ledger(input.after, input);
    if (!b.rows.length) fail("empty source is not outside zero authority");
    if (b.ledgerFingerprint !== a.ledgerFingerprint || b.payerSooFingerprint !== a.payerSooFingerprint) fail("current full payer identity changed");
    const cb = targetContext(input.before, c), ca = targetContext(input.after, c);
    if (cb.directoryFingerprint !== ca.directoryFingerprint || cb.fingerprint !== ca.fingerprint) fail("complete target authority changed");
    const opening = allRaw(input.before), closing = allRaw(input.after);
    if (Math.max(...opening.map(e => Date.parse(e.request.endedAt))) >= Math.min(...closing.map(e => Date.parse(e.request.startedAt)))) fail("source opening/closing bracket overlaps");
    const allocations: OregonOutsideSourceAllocation[] = [], diagnostics: string[] = [];
    for (const w of b.rows) {
      const d = b.details.get(w.transactionId)!;
      for (const m of d.mechanisms) {
        if (m.mechanism !== "independent" || person(m.targetName) !== person(c.candidateName)) continue;
        if (m.targetCommitteeId !== null && m.targetCommitteeId !== c.committeeId) fail("contradictory explicit target ID");
        if (w.date < "2026-09-22" || w.date > "2026-11-03") { diagnostics.push("Outside allocation omitted: date outside bounded 2026 General application policy"); continue; }
        allocations.push({ transactionId: w.transactionId, occurrence: m.occurrence, targetName: m.targetName,
          targetCommitteeId: m.targetCommitteeId, supportOppose: m.supportOppose!, amountCents: m.amountCents,
          mechanism: "independent", sourceUrl: ORIGIN + "/orestar/gotoPublicTransactionDetail.do?tranRsn=" + w.transactionId });
      }
    }
    if (!allocations.length) return { diagnostics: [...diagnostics, "No positively verified target allocations; outside remains unknown"] };
    const evidence: OregonVerifiedOutsideEvidence = {
      version: 1, scope: "current_original_cash_ie_allocations", candidateContext: { ...c },
      payer: { committeeId: input.payerCommitteeId, committeeName: b.payer.committeeName },
      windowStart: input.windowStart, windowEnd: input.windowEnd, allocationPolicy: POLICY,
      contextFingerprint: cb.fingerprint, payerSooFingerprint: b.payerSooFingerprint,
      transactions: b.identities, allocations, supportCents: sum(allocations, "support"), opposeCents: sum(allocations, "oppose"),
      sourceHashes: [...new Set([...opening, ...closing].map(e => e.request.sha256))],
    };
    if (!validateOregonVerifiedOutsideEvidence(evidence)) fail("invalid constructed allocation evidence");
    prior(input.priorProvenance, evidence);
    return { evidence, diagnostics };
  } catch (error) { return { diagnostics: [error instanceof Error ? error.message : String(error)] }; }
}
