import { ARKANSAS_FINANCE_ELIGIBLE_OFFICE_KEYS, arkansasCfisOfficeNameForOffice } from "./arkansasFinanceEligibleOffices.js";
import { arkansasDistrictNumberFromDistrictName, arkansasRegistrationDistrictNumber } from "./arkansasCandidateFilerResolver.js";
import type { ArkansasFinanceLinkInput } from "./arkansasFinanceWriter.js";
import type { ArkansasVerifiedCurrentCashProof, ArkansasVerifiedCashOccurrence } from "./arkansasCurrentOriginalFinancialSource.js";

export type ArkansasFinancePacDonor = {
  committeeId: string; committeeName: string; committeeType: "Political Action Committee";
  amount: number; contributionCount: number; sourceUrl: string;
};
export type ArkansasPacSourceReceipt = Omit<ArkansasVerifiedCashOccurrence, "reportedAddress">;
export type ArkansasPacSourceGroup = {
  committeeId: string; committeeName: string; committeeType: "Political Action Committee";
  amountCents: number; contributionCount: number; receiptGuids: readonly string[];
};
export type ArkansasPacSourceProvenance = {
  version: 1; scope: "current_original_reported_pac_cash";
  link: { candidateId: string; electionId: string; electionYear: number; filingEntityId: string; filerName: string };
  receiver: ArkansasVerifiedCurrentCashProof["receiver"];
  windowStart: string; windowEnd: string; publishedThrough: string; sourceUrl: string;
  monetaryCashCents: number; pacCashCents: number;
  reports: ArkansasVerifiedCurrentCashProof["reports"]; cashRows: readonly ArkansasPacSourceReceipt[];
  groups: readonly ArkansasPacSourceGroup[];
  sourceFingerprints: ArkansasVerifiedCurrentCashProof["sourceFingerprints"] & { registryBefore: string; registryAfter: string };
  rawResponseHashes: readonly string[];
};
function fail(message: string): never { throw new Error("Arkansas PAC evidence: " + message); }
function object(v: unknown, name: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail("invalid " + name);
  return v as Record<string, unknown>;
}
function text(v: unknown, name: string, blank = false): string {
  if (typeof v !== "string" || (!blank && !v.trim()) || /[\u0000-\u001f\u007f]/u.test(v)) fail("invalid " + name);
  return v;
}
function integer(v: unknown, name: string, minimum = 0): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < minimum) fail("invalid " + name);
  return v;
}
function hash(v: unknown, name: string): string {
  const s = text(v, name); if (!/^[a-f0-9]{64}$/.test(s)) fail("invalid " + name); return s;
}
function guid(v: unknown, name: string): string {
  const s = text(v, name);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(s)) fail("invalid " + name);
  return s;
}
export function normalizeArkansasReportedPacName(value: string): string {
  return value.normalize("NFKC").toUpperCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
/** Only source-owner display order: every word in both comma parts is retained. */
export function arkansasExactOwnerNameEquivalent(a: string, b: string): boolean {
  const variants = (s: string): string[] => {
    const values = [normalizeArkansasReportedPacName(s)];
    const parts = s.split(",");
    if (parts.length === 2 && parts.every(p => p.trim()) && !/^(?:JR|SR|II|III|IV)\.?$/i.test(parts[1]!.trim())) values.push(normalizeArkansasReportedPacName(parts[1] + " " + parts[0]));
    return values;
  };
  return variants(a).some(v => variants(b).includes(v));
}
export function arkansasVerifiedLinkOffice(officeName: string): string | null {
  for (const key of ARKANSAS_FINANCE_ELIGIBLE_OFFICE_KEYS) {
    const [officeScope, officeCanonicalName] = key.split("::");
    const source = arkansasCfisOfficeNameForOffice({ officeScope, officeCanonicalName });
    if (officeName === officeCanonicalName || officeName === source) return source;
  }
  return null;
}
export function arkansasVerifiedLinkDistrict(value: string | null | undefined): string | null {
  if (value == null || !value.trim()) return null;
  const plain = arkansasRegistrationDistrictNumber(value);
  if (plain !== null) return plain;
  if ((value.match(/\bDistrict\s+0*\d+\b/gi) ?? []).length !== 1) return null;
  return arkansasDistrictNumberFromDistrictName(value);
}
export function arkansasPacReceivingSourceUrl(registrationGuid: string): string {
  guid(registrationGuid, "receiving registration GUID");
  return "https://ethics-disclosures.sos.arkansas.gov/public/cf/candidateprofile?guid=" + registrationGuid + "&tabName=TCON";
}
function entityId(v: unknown, name: string): string {
  const s = text(v, name);
  if (!/^[1-9]\d*$/.test(s) || !Number.isSafeInteger(Number(s))) fail("invalid " + name);
  return s;
}
function day(v: unknown, name: string): string {
  const s = text(v, name);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) fail("invalid " + name);
  const d = new Date(s + "T00:00:00Z");
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== s) fail("invalid " + name);
  return s;
}
function array(v: unknown, name: string): unknown[] { if (!Array.isArray(v)) fail("invalid " + name); return v; }
export function addArkansasPacCents(a: number, b: number): number { return integer(a + b, "money sum"); }
export function isArkansasTypedPacCash(row: Pick<ArkansasPacSourceReceipt, "transactionSource">): boolean {
  return row.transactionSource === "Political Action Committee";
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") {
    const r = v as Record<string, unknown>;
    return "{" + Object.keys(r).filter(k => r[k] !== undefined).sort().map(k => JSON.stringify(k) + ":" + canonical(r[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}
function same(a: unknown, b: unknown): boolean { return canonical(a) === canonical(b); }

/** Source binding and exact occurrence references; government acquisition is verified upstream. */
export function validateArkansasPacSourceProvenance(value: unknown, link?: ArkansasFinanceLinkInput): ArkansasPacSourceProvenance {
  const p = object(value, "provenance");
  if (p.version !== 1 || p.scope !== "current_original_reported_pac_cash") fail("unsupported provenance");
  const l = object(p.link, "link");
  guid(l.candidateId, "candidate ID"); guid(l.electionId, "election ID");
  integer(l.electionYear, "election year", 2026); entityId(l.filingEntityId, "filing entity ID"); text(l.filerName, "filer name");
  if (link && (l.candidateId !== link.candidateId || l.electionId !== link.electionId ||
    l.electionYear !== link.electionYear || l.filingEntityId !== String(link.filingEntityId) ||
    !arkansasExactOwnerNameEquivalent(String(l.filerName), link.filerName))) fail("local link mismatch");
  const receiver = object(p.receiver, "receiver");
  entityId(receiver.entityId, "receiver entity ID"); guid(receiver.registrationGuid, "receiver registration GUID");
  text(receiver.sourceName, "receiver source name"); integer(receiver.electionYear, "receiver election year", 2026);
  for (const k of ["officeName", "district"]) if (receiver[k] !== null) text(receiver[k], "receiver " + k);
  if (receiver.entityId !== l.filingEntityId || receiver.electionYear !== l.electionYear ||
    !arkansasExactOwnerNameEquivalent(String(receiver.sourceName), String(l.filerName))) fail("receiver mismatch");
  if (link) {
    const office = arkansasVerifiedLinkOffice(link.officeName);
    if (!office || receiver.officeName !== office) fail("receiver/local office mismatch");
    const legislative = office === "State Senate" || office === "State Representative";
    const localDistrict = arkansasVerifiedLinkDistrict(link.district);
    const sourceDistrict = arkansasRegistrationDistrictNumber(receiver.district as string | null);
    if (legislative ? localDistrict === null || sourceDistrict === null || localDistrict !== sourceDistrict :
      receiver.district !== null || (link.district != null && !!link.district.trim())) fail("receiver/local district mismatch");
  }
  const start = day(p.windowStart, "window start"), end = day(p.windowEnd, "window end"), through = day(p.publishedThrough, "published through");
  const year = Number(l.electionYear);
  if (start !== (year - 1) + "-01-01" || end < start || end > year + "-12-31" || through < start || through > end) fail("invalid cycle coverage");
  if (p.sourceUrl !== arkansasPacReceivingSourceUrl(String(receiver.registrationGuid))) fail("receiving source URL mismatch");
  integer(p.monetaryCashCents, "cash cents"); integer(p.pacCashCents, "PAC cents");
  const f = object(p.sourceFingerprints, "source fingerprints");
  for (const k of ["reportsBefore", "reportsAfter", "nativeBefore", "nativeAfter", "registryBefore", "registryAfter"]) hash(f[k], k);
  if (f.reportsBefore !== f.reportsAfter || f.nativeBefore !== f.nativeAfter || f.registryBefore !== f.registryAfter) fail("source generation changed");
  const rawHashes = array(p.rawResponseHashes, "raw response hashes");
  if (!rawHashes.length) fail("missing raw response hashes");
  rawHashes.forEach(h => hash(h, "raw response hash"));
  const reports = new Map<string, Record<string, unknown>>();
  let latest = "";
  for (const value of array(p.reports, "reports")) {
    const r = object(value, "report"), id = guid(r.reportGuid, "report GUID");
    if (reports.has(id)) fail("duplicate report GUID");
    if (r.reportVersion !== 1 || r.returnedCashCents !== 0 ||
      !["explicit_section19_zero", "checked_no_activity_zero"].includes(String(r.returnProof))) fail("unverified original/return authority");
    text(r.reportName, "report name");
    const rs = day(r.periodStart, "report start"), re = day(r.periodEnd, "report end");
    if (rs > re || re < start || rs > end) fail("report outside source window");
    const filed = text(r.filedAtRaw, "raw filed timestamp");
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/.test(filed)) fail("invalid raw filed timestamp");
    day(filed.slice(0, 10), "filed day");
    if (Number(filed.slice(11, 13)) > 23 || Number(filed.slice(14, 16)) > 59 || Number(filed.slice(17, 19)) > 59) fail("invalid raw filed clock");
    if (!/^Reports[\\/][a-f0-9-]{36}\.pdf$/i.test(text(r.filePath, "report file path"))) fail("invalid source PDF path");
    hash(r.pdfSha256, "PDF hash"); hash(r.reportFingerprint, "report fingerprint");
    reports.set(id, r); if (re > latest) latest = re;
  }
  if (!reports.size || latest !== through) fail("missing published report coverage");
  const receipts = new Map<string, Record<string, unknown>>(), detailIds = new Set<number>();
  let cash = 0, pac = 0;
  for (const value of array(p.cashRows, "cash rows")) {
    const r = object(value, "cash receipt"), id = guid(r.guid, "cash GUID");
    if (receipts.has(id)) fail("duplicate cash GUID");
    const report = reports.get(guid(r.reportGuid, "receipt report GUID"));
    if (!report) fail("receipt missing current report");
    const date = day(r.transactionDate, "receipt date");
    if (date < start || date > end || date < String(report.periodStart) || date > String(report.periodEnd)) fail("receipt outside verified period");
    cash = addArkansasPacCents(cash, integer(r.amountCents, "receipt cents", 1));
    text(r.reportedName, "reported name", true);
    if (!["Itemized Monetary", "Non-Itemized Monetary"].includes(String(r.transactionSubTypeDescription))) fail("noncash receipt in proof");
    text(r.transactionSource, "transaction source", r.transactionSubTypeDescription === "Non-Itemized Monetary");
    if (r.transactionSource !== "" && !["Individual", "Candidate", "Political Action Committee", "Business/Organization/Unlisted PAC"].includes(String(r.transactionSource))) fail("unknown cash source class");
    hash(r.nativeFingerprint, "native receipt fingerprint");
    const typed = isArkansasTypedPacCash(r as unknown as ArkansasPacSourceReceipt);
    if (typed && (!normalizeArkansasReportedPacName(String(r.reportedName)) ||
      r.transactionSubTypeDescription !== "Itemized Monetary" || r.transactionTypeCode !== "TCON" ||
      r.transactionSubTypeCode !== "ITMY" || r.transactionSourceTypeCode !== "TPAC")) fail("incomplete typed PAC receipt");
    if (!typed && r.transactionSourceTypeCode === "TPAC") fail("contradictory PAC classification");
    if (typed || r.transactionId !== undefined) {
      const transactionId = integer(r.transactionId, "transaction ID", 1);
      integer(r.transactionVersionId, "transaction version", 1); hash(r.detailFingerprint, "detail fingerprint");
      if (detailIds.has(transactionId)) fail("duplicate transaction ID");
      detailIds.add(transactionId);
    }
    for (const k of ["transactionTypeCode", "transactionSubTypeCode", "transactionSourceTypeCode"]) {
      if (r[k] !== undefined && !/^[A-Z0-9]+$/.test(text(r[k], k))) fail("invalid source code");
    }
    if (r.electionTypeCode !== undefined && r.electionTypeCode !== null) text(r.electionTypeCode, "source election type");
    if (r.sourceElectionYear !== undefined && r.sourceElectionYear !== null) integer(r.sourceElectionYear, "source election year", 1900);
    if (typed) pac = addArkansasPacCents(pac, Number(r.amountCents));
    receipts.set(id, r);
  }
  if (cash !== p.monetaryCashCents || pac !== p.pacCashCents || pac > cash) fail("cash occurrence total mismatch");
  const donorIds = new Set<string>(), assigned = new Set<string>();
  let groupCents = 0;
  for (const value of array(p.groups, "PAC groups")) {
    const g = object(value, "PAC group"), id = text(g.committeeId, "donor ID"), name = text(g.committeeName, "donor name");
    if (g.committeeType !== "Political Action Committee") fail("unverified donor class");
    if (id.startsWith("reported:")) {
      if (id !== "reported:" + normalizeArkansasReportedPacName(name) || id === "reported:") fail("invalid reported donor identity");
    } else entityId(id, "legal donor ID");
    const donorName = normalizeArkansasReportedPacName(name);
    const selfNames = [String(receiver.sourceName), String(l.filerName), link?.candidateNameNormalized ?? ""]
      .map(normalizeArkansasReportedPacName).filter(Boolean);
    if (id === receiver.entityId || selfNames.includes(donorName) || arkansasExactOwnerNameEquivalent(name, String(receiver.sourceName)) || donorIds.has(id)) fail("self/duplicate donor identity");
    donorIds.add(id);
    const ids = array(g.receiptGuids, "group receipt GUIDs");
    integer(g.contributionCount, "contribution count", 1);
    if (g.contributionCount !== ids.length) fail("group count mismatch");
    let cents = 0;
    for (const rawId of ids) {
      const receiptId = guid(rawId, "group receipt GUID"), r = receipts.get(receiptId);
      if (!r || !isArkansasTypedPacCash(r as unknown as ArkansasPacSourceReceipt) || assigned.has(receiptId)) fail("invalid/repeated PAC receipt reference");
      if (id.startsWith("reported:") && r.reportedName !== name) fail("reported-name collision");
      assigned.add(receiptId); cents = addArkansasPacCents(cents, Number(r.amountCents));
    }
    if (integer(g.amountCents, "group cents", 1) !== cents) fail("group amount mismatch");
    groupCents = addArkansasPacCents(groupCents, cents);
  }
  if (groupCents !== pac || assigned.size !== [...receipts.values()].filter(r => isArkansasTypedPacCash(r as unknown as ArkansasPacSourceReceipt)).length) fail("incomplete PAC groups");
  return value as ArkansasPacSourceProvenance;
}
export function validateArkansasPacSnapshot(input: {
  link: ArkansasFinanceLinkInput; pacDonors: readonly ArkansasFinancePacDonor[]; pacSourceProvenance: unknown;
}): ArkansasPacSourceProvenance {
  const p = validateArkansasPacSourceProvenance(input.pacSourceProvenance, input.link);
  if (input.pacDonors.length !== p.groups.length) fail("snapshot group count mismatch");
  const groups = new Map(p.groups.map(g => [g.committeeId, g])), seen = new Set<string>();
  for (const donor of input.pacDonors) {
    const group = groups.get(donor.committeeId);
    if (!group || seen.has(donor.committeeId) || donor.committeeName !== group.committeeName ||
      donor.committeeType !== group.committeeType || donor.sourceUrl !== p.sourceUrl ||
      !Number.isFinite(donor.amount) || donor.amount !== group.amountCents / 100 ||
      donor.contributionCount !== group.contributionCount) fail("snapshot donor mismatch");
    seen.add(donor.committeeId);
  }
  return p;
}
/** Original-only authority cannot explain removed or rewritten receipts/reports. */
export function assertArkansasPacPriorAuthorityRetained(current: ArkansasPacSourceProvenance, priorValue: unknown): void {
  if (priorValue === undefined || priorValue === null) return;
  const prior = validateArkansasPacSourceProvenance(priorValue);
  if (!same(prior.link, current.link) || !same(prior.receiver, current.receiver) ||
    prior.windowStart !== current.windowStart || prior.windowEnd > current.windowEnd ||
    prior.publishedThrough > current.publishedThrough) fail("prior scope/receiver changed");
  const reports = new Map(current.reports.map(r => [r.reportGuid, r]));
  for (const report of prior.reports) if (!same(reports.get(report.reportGuid), report)) fail("prior report disappeared or changed");
  const cash = new Map(current.cashRows.map(r => [r.guid, r]));
  for (const receipt of prior.cashRows) if (!same(cash.get(receipt.guid), receipt)) fail("prior cash receipt disappeared or changed");
  const assignments = new Map(current.groups.flatMap(g => g.receiptGuids.map(id => [id, g.committeeId] as const)));
  for (const group of prior.groups) for (const id of group.receiptGuids) if (assignments.get(id) !== group.committeeId) fail("prior donor identity reassigned");
}
