import type { ArkansasFinanceLinkInput } from "./arkansasFinanceWriter.js";
import { fingerprintArkansasFinancialRawRow } from "./arkansasCurrentOriginalFinancialSource.js";
import type {
  ArkansasFinancialSourceIdentity, ArkansasFinancialPdfSource, ArkansasVerifiedCurrentIeProof,
} from "./arkansasCurrentOriginalFinancialSource.js";
import type {
  ArkansasVerifiedCollection, ArkansasVerifiedRegistryRow, ArkansasVerifiedCurrentReportRow,
} from "./arkansasVerifiedSourceClient.js";
import { fingerprintArkansasVerifiedRawRows } from "./arkansasVerifiedSourceClient.js";
import { validateArkansasVerifiedFullRegistry } from "./arkansasVerifiedPacDonorAggregator.js";
import { addArkansasPacCents, arkansasExactOwnerNameEquivalent, arkansasVerifiedLinkOffice, arkansasVerifiedLinkDistrict, normalizeArkansasReportedPacName } from "./arkansasPacSourceEvidence.js";

export type ArkansasOutsideIdentityCoverProof = {
  identity: ArkansasFinancialSourceIdentity;
  registryBefore: ArkansasVerifiedCollection<ArkansasVerifiedRegistryRow>;
  registryAfter: ArkansasVerifiedCollection<ArkansasVerifiedRegistryRow>;
  reportsBefore: ArkansasVerifiedCollection<ArkansasVerifiedCurrentReportRow>;
  reportsAfter: ArkansasVerifiedCollection<ArkansasVerifiedCurrentReportRow>;
  pdf: ArkansasFinancialPdfSource;
};
export type ArkansasOutsideAllocation = {
  expenseGuid: string; reportGuid: string; amountCents: number;
  stance: "support" | "oppose"; targetName: string;
  officeName: "State Senate" | "State Representative"; district: string;
  electionYear: 2026;
};
export type ArkansasOutsideIdentityAuthority = {
  entityId: "8277"; electionYear: 2026; officeName: "State Representative"; district: "24";
  ownerName: "Edna Charlene Fite"; reportGuid: string; reportVersion: number;
  periodStart: string; periodEnd: string; filedAtRaw: string; filePath: string;
  pdfSha256: string; reportFingerprint: string;
  reportsBeforeFingerprint: string; reportsAfterFingerprint: string;
  registryBeforeFingerprint: string; registryAfterFingerprint: string;
};
export type ArkansasVerifiedOutsideEvidence = {
  version: 1; scope: "positive_current_original_report_allocations";
  link: { candidateId: string; electionId: string; electionYear: number; filingEntityId: string; filerName: string };
  target: ArkansasFinancialSourceIdentity;
  payer: ArkansasFinancialSourceIdentity;
  windowStart: string; windowEnd: string; sourceUrl: string;
  expenditureCents: number;
  reports: ArkansasVerifiedCurrentIeProof["reports"];
  expenseRows: readonly Omit<ArkansasVerifiedCurrentIeProof["expenseRows"][number], "reportedAddress">[];
  allocations: readonly ArkansasOutsideAllocation[];
  reportGroups: readonly { reportGuid: string; supportCents?: number; opposeCents?: number }[];
  sourceFingerprints: ArkansasVerifiedCurrentIeProof["sourceFingerprints"] & { registryBefore: string; registryAfter: string };
  rawResponseHashes: readonly string[];
  coverElectionConflicts: ArkansasVerifiedCurrentIeProof["coverElectionConflicts"];
  identityCover?: ArkansasOutsideIdentityAuthority;
};
export type ArkansasOutsideEvidenceResult = { evidence?: ArkansasVerifiedOutsideEvidence; diagnostics: readonly string[] };
function fail(s: string): never { throw new Error("Arkansas outside evidence: " + s); }
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail("invalid object"); return v as Record<string, unknown>;
}
function text(v: unknown, label: string): string {
  if (typeof v !== "string" || !v.trim() || /[\u0000-\u001f\u007f]/u.test(v)) fail("invalid " + label); return v;
}
function guid(v: unknown): string {
  const s = text(v, "GUID"); if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(s)) fail("invalid GUID"); return s;
}
function hash(v: unknown): string { const s = text(v, "hash"); if (!/^[a-f0-9]{64}$/.test(s)) fail("invalid hash"); return s; }
function integer(v: unknown, minimum = 0): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < minimum) fail("invalid integer/cents"); return v;
}
function day(v: unknown): string {
  const s = text(v, "date"), d = new Date(s + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== s) fail("invalid civil date"); return s;
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") { const o = v as Record<string, unknown>; return "{" + Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}"; }
  return JSON.stringify(v);
}
function identical(a: unknown, b: unknown): boolean { return canonical(a) === canonical(b); }
function entity(v: unknown): string {
  const s = text(v, "entity ID"); if (!/^[1-9]\d*$/.test(s) || !Number.isSafeInteger(Number(s))) fail("invalid entity ID"); return s;
}
function payerUrl(registrationGuid: string): string {
  return "https://ethics-disclosures.sos.arkansas.gov/public/cf/candidateprofile?guid=" + guid(registrationGuid) + "&tabName=TEXP";
}
function identity(v: unknown): ArkansasFinancialSourceIdentity {
  const i = object(v); entity(i.entityId); guid(i.registrationGuid); text(i.sourceName, "source owner"); integer(i.electionYear, 1900);
  if (i.officeName !== null) text(i.officeName, "office"); if (i.district !== null) text(i.district, "district");
  return v as ArkansasFinancialSourceIdentity;
}
function fullReportCollection(c: ArkansasVerifiedCollection<ArkansasVerifiedCurrentReportRow>, registrationGuid: string): void {
  if (c.complete !== true || c.totalItems !== c.rows.length || !c.rows.length || !c.requests.length ||
    c.fingerprint !== fingerprintArkansasVerifiedRawRows(c.rows) ||
    new Set(c.rows.map(r => r.filerReportGuid)).size !== c.rows.length ||
    c.rows.some(r => r.registrationGuid !== registrationGuid)) fail("incomplete identity manifest");
}
function identityAuthority(input: ArkansasOutsideIdentityCoverProof): ArkansasOutsideIdentityAuthority {
  validateArkansasVerifiedFullRegistry(input.registryBefore); validateArkansasVerifiedFullRegistry(input.registryAfter);
  if (input.registryBefore.fingerprint !== input.registryAfter.fingerprint) fail("identity registry changed");
  const id = input.identity;
  if (id.entityId !== "8277" || id.electionYear !== 2026 || id.officeName !== "State Representative" || id.district !== "24") fail("finite Fite identity scope mismatch");
  const registered = input.registryBefore.rows.filter(r => r.registrationGuid === id.registrationGuid);
  if (registered.length !== 1 || registered[0]!.filerEntityId !== 8277 || registered[0]!.filerTypeCode !== "CAN" ||
    registered[0]!.electionYear !== 2026 || registered[0]!.office !== "State Representative" ||
    registered[0]!.officeDistrictName !== "24") fail("finite Fite registry identity mismatch");
  fullReportCollection(input.reportsBefore, id.registrationGuid); fullReportCollection(input.reportsAfter, id.registrationGuid);
  if (input.reportsBefore.fingerprint !== input.reportsAfter.fingerprint) fail("identity current manifest changed");
  const rows = input.reportsBefore.rows.filter(r => r.filerReportGuid === input.pdf.reportGuid);
  if (rows.length !== 1) fail("identity cover missing current report");
  const r = rows[0]!, p = input.pdf.parsed, request = input.pdf.request;
  integer(p.byteCount, 1); integer(request.bytes, 1);
  if (r.isPaperFile !== false || typeof r.hasChild !== "boolean" || !["Original", "Amended"].includes(String(r.reportStatus)) || !Number.isSafeInteger(r.filerReportVersionId) || r.filerReportVersionId < 1 ||
    p.kind !== "candidate" || (p.filerId !== null && p.filerId !== "8277") || p.ownerName !== "Edna Charlene Fite" || p.officeName !== "State Representative" ||
    p.district !== "24" || p.electionYear !== 2026 || !r.startDate || !r.endDate || !r.filedDate || !r.filePath ||
    r.startDate.slice(0, 10) !== p.periodStart || r.endDate.slice(0, 10) !== p.periodEnd ||
    r.filedDate.slice(0, 19) !== p.filedAt || p.sha256 !== request.sha256 || p.byteCount !== request.bytes ||
    request.method !== "POST" || request.status !== 200 ||
    request.url !== "https://api-ethics-disclosures.sos.arkansas.gov/api/PublicFiledReportAndDownload/DownloadDocument" ||
    request.requestBody.filerReportGuid !== r.filerReportGuid ||
    request.requestBody.fileName !== r.reportName + " V" + r.filerReportVersionId ||
    request.requestBody.openInNewTab !== true) fail("finite Fite current cover binding mismatch");
  return {
    entityId: "8277", electionYear: 2026, officeName: "State Representative", district: "24", ownerName: "Edna Charlene Fite",
    reportGuid: r.filerReportGuid, reportVersion: r.filerReportVersionId,
    periodStart: p.periodStart, periodEnd: p.periodEnd, filedAtRaw: r.filedDate, filePath: r.filePath,
    pdfSha256: p.sha256, reportFingerprint: fingerprintArkansasFinancialRawRow(r),
    reportsBeforeFingerprint: input.reportsBefore.fingerprint, reportsAfterFingerprint: input.reportsAfter.fingerprint,
    registryBeforeFingerprint: input.registryBefore.fingerprint, registryAfterFingerprint: input.registryAfter.fingerprint,
  };
}
function purpose(value: string): Omit<ArkansasOutsideAllocation, "expenseGuid" | "reportGuid" | "amountCents" | "electionYear"> | null {
  const s = value.normalize("NFKC").toUpperCase().replace(/\s+/gu, " ").trim();
  const m = /^(?:SMS MESSAGING|CREATIVE DESIGN SERVICES) IN (SUPPORT OF|OPPOSITION TO) ([\p{L}\p{N} .'\u2019-]+?)(?:,)? AR(?:\s*-\s*|\s+)(SD|HD)(?:\s*-\s*|\s+)([1-9]\d*)$/u.exec(s);
  if (!m) return null;
  const targetName = normalizeArkansasReportedPacName(m[2]!);
  if (!targetName) return null;
  return { stance: m[1] === "SUPPORT OF" ? "support" : "oppose", targetName,
    officeName: m[3] === "SD" ? "State Senate" : "State Representative", district: m[4]! };
}
function naturalNames(r: ArkansasVerifiedRegistryRow): string[] {
  const full = r.firstName && r.lastName ? [r.firstName, r.lastName, r.suffix].filter(Boolean).join(" ") : "";
  return [full, r.filerName, r.committeeName].filter((s): s is string => !!s).map(normalizeArkansasReportedPacName);
}
function reportGroups(allocations: readonly ArkansasOutsideAllocation[]): ArkansasVerifiedOutsideEvidence["reportGroups"] {
  const groups = new Map<string, { reportGuid: string; supportCents?: number; opposeCents?: number }>();
  for (const a of allocations) {
    const g = groups.get(a.reportGuid) ?? { reportGuid: a.reportGuid }, k = a.stance === "support" ? "supportCents" : "opposeCents";
    g[k] = addArkansasPacCents(g[k] ?? 0, a.amountCents); groups.set(a.reportGuid, g);
  }
  return [...groups.values()].sort((a, b) => a.reportGuid.localeCompare(b.reportGuid));
}
export function aggregateArkansasVerifiedOutsideEvidence(input: {
  link: ArkansasFinanceLinkInput; financialEvidence: ArkansasVerifiedCurrentIeProof;
  registryBefore: ArkansasVerifiedCollection<ArkansasVerifiedRegistryRow>;
  registryAfter: ArkansasVerifiedCollection<ArkansasVerifiedRegistryRow>;
  candidateIdentityCover?: ArkansasOutsideIdentityCoverProof;
}): ArkansasOutsideEvidenceResult {
  try {
    validateArkansasVerifiedFullRegistry(input.registryBefore); validateArkansasVerifiedFullRegistry(input.registryAfter);
    if (input.registryBefore.fingerprint !== input.registryAfter.fingerprint) fail("registry generation changed");
    const proof = input.financialEvidence;
    if (!proof || proof.version !== 1 || input.link.electionYear !== 2026) fail("unsupported financial scope");
    const allocations: ArkansasOutsideAllocation[] = [];
    let target: ArkansasFinancialSourceIdentity | undefined, cover: ArkansasOutsideIdentityAuthority | undefined;
    for (const r of proof.expenseRows) {
      const parsed = purpose(r.purpose); if (!parsed) continue;
      // Only source-backed 2026 primary row authority. No report-year target substitution.
      if (r.sourceElectionYear !== 2026 || r.electionTypeCode !== "PRMELEC") continue;
      const context = input.registryBefore.rows.filter(c => c.filerTypeCode === "CAN" && c.filerType === "Candidate" &&
        c.electionYear === 2026 && c.office === parsed.officeName && c.officeDistrictName === parsed.district);
      let matches = context.filter(c => naturalNames(c).includes(parsed.targetName));
      if (parsed.targetName === "CHARLENE FITE" && parsed.officeName === "State Representative" && parsed.district === "24") {
        if (input.link.filingEntityId !== 8277 || !input.candidateIdentityCover) continue;
        cover = identityAuthority(input.candidateIdentityCover);
        matches = [...matches, ...context.filter(c => String(c.filerEntityId) === cover!.entityId)];
      }
      const ids = new Set(matches.map(c => c.filerEntityId));
      if (ids.size !== 1) continue;
      const c = matches[0]!;
      if (String(c.filerEntityId) !== String(input.link.filingEntityId) || arkansasVerifiedLinkOffice(input.link.officeName) !== parsed.officeName ||
        arkansasVerifiedLinkDistrict(input.link.district) !== parsed.district ||
        (parsed.targetName !== "CHARLENE FITE" && !arkansasExactOwnerNameEquivalent(input.link.filerName, c.filerName ?? "")) ||
        normalizeArkansasReportedPacName(input.link.candidateNameNormalized) !== parsed.targetName) continue;
      if (matches.some(m => m.office !== c.office || m.officeDistrictName !== c.officeDistrictName ||
        !arkansasExactOwnerNameEquivalent(m.filerName ?? "", c.filerName ?? ""))) fail("ambiguous annual target identity");
      target = { entityId: String(c.filerEntityId), registrationGuid: c.registrationGuid, sourceName: c.filerName!,
        electionYear: 2026, officeName: parsed.officeName, district: parsed.district };
      allocations.push({ ...parsed, expenseGuid: r.guid, reportGuid: r.reportGuid, amountCents: r.amountCents, electionYear: 2026 });
    }
    if (!allocations.length || !target) return { diagnostics: ["Outside preserved: no independently resolved positive allocation"] };
    const evidence: ArkansasVerifiedOutsideEvidence = {
      version: 1, scope: "positive_current_original_report_allocations",
      link: { candidateId: input.link.candidateId, electionId: input.link.electionId, electionYear: input.link.electionYear,
        filingEntityId: String(input.link.filingEntityId), filerName: input.link.filerName },
      target, payer: { ...proof.payer }, windowStart: proof.windowStart, windowEnd: proof.windowEnd,
      sourceUrl: payerUrl(proof.payer.registrationGuid), expenditureCents: proof.expenditureCents,
      reports: proof.reports.map(r => ({ ...r })),
      expenseRows: proof.expenseRows.map(({ reportedAddress: _address, ...r }) => ({ ...r })),
      allocations, reportGroups: reportGroups(allocations),
      sourceFingerprints: { ...proof.sourceFingerprints, registryBefore: input.registryBefore.fingerprint, registryAfter: input.registryAfter.fingerprint },
      rawResponseHashes: [...proof.rawResponseHashes, ...input.registryBefore.requests.map(r => r.sha256), ...input.registryAfter.requests.map(r => r.sha256)],
      coverElectionConflicts: proof.coverElectionConflicts.map(r => ({ ...r })), ...(cover ? { identityCover: cover } : {}),
    };
    validateArkansasVerifiedOutsideEvidence(evidence, input.link);
    return { evidence, diagnostics: proof.coverElectionConflicts.length ? ["Outside positive allocations use explicit PRMELEC/2026 row authority; contradictory payer cover election metadata retained"] : [] };
  } catch (error) { return { diagnostics: ["Outside preserved: " + (error instanceof Error ? error.message : String(error))] }; }
}

export function validateArkansasVerifiedOutsideEvidence(value: unknown, link?: ArkansasFinanceLinkInput): ArkansasVerifiedOutsideEvidence {
  const e = object(value);
  if (e.version !== 1 || e.scope !== "positive_current_original_report_allocations") fail("unsupported provenance");
  const l = object(e.link), t = identity(e.target), p = identity(e.payer);
  guid(l.candidateId); guid(l.electionId); entity(l.filingEntityId); text(l.filerName, "local filer"); integer(l.electionYear, 2026);
  if (t.entityId !== l.filingEntityId || t.electionYear !== l.electionYear || e.sourceUrl !== payerUrl(p.registrationGuid)) fail("target/payer source binding mismatch");
  if (link && (l.candidateId !== link.candidateId || l.electionId !== link.electionId || l.electionYear !== link.electionYear ||
    l.filingEntityId !== String(link.filingEntityId) || !arkansasExactOwnerNameEquivalent(String(l.filerName), link.filerName) ||
    arkansasVerifiedLinkOffice(link.officeName) !== t.officeName || arkansasVerifiedLinkDistrict(link.district) !== t.district)) fail("local target link mismatch");
  const start = day(e.windowStart), end = day(e.windowEnd);
  if (l.electionYear !== 2026 || start !== "2025-01-01" || end < start || end > "2026-12-31") fail("unsupported cycle scope");
  const f = object(e.sourceFingerprints);
  for (const k of ["reportsBefore", "reportsAfter", "nativeBefore", "nativeAfter", "registryBefore", "registryAfter"]) hash(f[k]);
  if (f.reportsBefore !== f.reportsAfter || f.nativeBefore !== f.nativeAfter || f.registryBefore !== f.registryAfter) fail("source generation changed");
  if (!Array.isArray(e.rawResponseHashes) || !e.rawResponseHashes.length) fail("missing raw response hashes"); e.rawResponseHashes.forEach(hash);
  if (!Array.isArray(e.reports) || !e.reports.length || !Array.isArray(e.expenseRows) || !Array.isArray(e.allocations) ||
    !e.allocations.length || !Array.isArray(e.reportGroups) || !Array.isArray(e.coverElectionConflicts)) fail("missing full positive source scope");
  const reports = new Map<string, Record<string, unknown>>();
  for (const v of e.reports) {
    const r = object(v), id = guid(r.reportGuid);
    if (reports.has(id) || r.reportVersion !== 1) fail("duplicate/non-original report");
    text(r.reportName, "report name"); const rs = day(r.periodStart), re = day(r.periodEnd);
    if (rs > re || re < start || rs > end) fail("report outside source scope");
    text(r.filedAtRaw, "filed timestamp"); text(r.filePath, "source PDF path"); hash(r.pdfSha256); hash(r.reportFingerprint);
    reports.set(id, r);
  }
  const expenses = new Map<string, Record<string, unknown>>(), transactionIds = new Set<number>();
  let total = 0;
  for (const v of e.expenseRows) {
    const r = object(v), id = guid(r.guid), report = reports.get(guid(r.reportGuid)), date = day(r.transactionDate);
    const numeric = integer(r.transactionId, 1);
    if (!report || expenses.has(id) || transactionIds.has(numeric) || date < String(report.periodStart) || date > String(report.periodEnd) ||
      date < start || date > end || r.transactionTypeCode !== "TEXP" || r.transactionSubTypeCode !== "ITMY") fail("invalid complete expense occurrence");
    integer(r.transactionVersionId, 1); hash(r.nativeFingerprint); hash(r.detailFingerprint);
    text(r.reportedName, "payee");
    if (typeof r.purpose !== "string" || /[\u0000-\u001f\u007f]/u.test(r.purpose)) fail("invalid raw expense purpose");
    for (const k of ["nativeCategory", "detailOtherCategory"]) if (r[k] !== null) text(r[k], "expense category");
    if (!r.purpose.trim() && (normalizeArkansasReportedPacName(String(r.nativeCategory)) !== "OTHER LIST BANK FEE" ||
      normalizeArkansasReportedPacName(String(r.detailOtherCategory)) !== "BANK FEE")) fail("unproved blank expense purpose");
    if (r.sourceElectionYear !== null) integer(r.sourceElectionYear, 1900);
    if (r.electionTypeCode !== null) text(r.electionTypeCode, "row election type");
    total = addArkansasPacCents(total, integer(r.amountCents, 1)); expenses.set(id, r); transactionIds.add(numeric);
  }
  if (total !== integer(e.expenditureCents)) fail("complete expense sum mismatch");
  const seen = new Set<string>();
  for (const v of e.allocations) {
    const a = object(v), id = guid(a.expenseGuid), r = expenses.get(id), parsed = r && purpose(String(r.purpose));
    if (!r || !parsed || seen.has(id) || a.reportGuid !== r.reportGuid || a.amountCents !== r.amountCents ||
      a.electionYear !== 2026 || r.sourceElectionYear !== 2026 || r.electionTypeCode !== "PRMELEC" ||
      a.stance !== parsed.stance || a.targetName !== parsed.targetName || a.officeName !== parsed.officeName ||
      a.district !== parsed.district || a.officeName !== t.officeName || a.district !== t.district) fail("allocation source binding mismatch");
    if (link && normalizeArkansasReportedPacName(link.candidateNameNormalized) !== a.targetName) fail("local full target name mismatch");
    const fite = a.targetName === "CHARLENE FITE";
    if (fite) {
      const c = object(e.identityCover);
      if (t.entityId !== "8277" || t.officeName !== "State Representative" || t.district !== "24" ||
        c.entityId !== "8277" || c.electionYear !== 2026 || c.officeName !== "State Representative" ||
        c.district !== "24" || c.ownerName !== "Edna Charlene Fite") fail("finite Fite identity authority mismatch");
      guid(c.reportGuid); integer(c.reportVersion, 1); day(c.periodStart); day(c.periodEnd); text(c.filedAtRaw, "identity filed timestamp"); text(c.filePath, "identity PDF path");
      for (const k of ["pdfSha256", "reportFingerprint", "reportsBeforeFingerprint", "reportsAfterFingerprint", "registryBeforeFingerprint", "registryAfterFingerprint"]) hash(c[k]);
      if (c.reportsBeforeFingerprint !== c.reportsAfterFingerprint || c.registryBeforeFingerprint !== c.registryAfterFingerprint) fail("identity cover generation changed");
    }
    seen.add(id);
  }
  const typed = value as ArkansasVerifiedOutsideEvidence;
  if (!identical(typed.reportGroups, reportGroups(typed.allocations))) fail("positive per-report totals mismatch");
  for (const v of e.coverElectionConflicts) {
    const c = object(v); if (!reports.has(guid(c.reportGuid))) fail("cover conflict missing current report");
    for (const k of ["electionTypeRaw", "electionDateRaw"]) if (c[k] !== null) text(c[k], "cover conflict");
  }
  return typed;
}
function retainedAuthority(current: ArkansasVerifiedOutsideEvidence, prior: ArkansasVerifiedOutsideEvidence): void {
  if (!identical(current.link, prior.link) || !identical(current.target, prior.target) || !identical(current.payer, prior.payer) ||
    current.windowStart !== prior.windowStart || current.windowEnd < prior.windowEnd) fail("prior payer/target scope changed");
  const reports = new Map(current.reports.map(r => [r.reportGuid, r])), expenses = new Map(current.expenseRows.map(r => [r.guid, r]));
  for (const r of prior.reports) if (!identical(reports.get(r.reportGuid), r)) fail("prior report disappeared or changed");
  for (const r of prior.expenseRows) if (!identical(expenses.get(r.guid), r)) fail("prior expense disappeared or changed");
  const allocations = new Map(current.allocations.map(a => [a.expenseGuid, a]));
  for (const a of prior.allocations) if (!identical(allocations.get(a.expenseGuid), a)) fail("prior allocation disappeared or changed");
  if (prior.identityCover) {
    if (!current.identityCover) fail("prior identity cover disappeared");
    const semantic = (c: ArkansasOutsideIdentityAuthority) => {
      const { reportsBeforeFingerprint: _a, reportsAfterFingerprint: _b, registryBeforeFingerprint: _c, registryAfterFingerprint: _d, ...authority } = c;
      return authority;
    };
    if (!identical(semantic(prior.identityCover), semantic(current.identityCover))) fail("prior identity cover changed");
  }
}
export function mergeArkansasVerifiedOutsideEvidence(input: {
  link: ArkansasFinanceLinkInput; retained: readonly unknown[]; incoming: readonly ArkansasVerifiedOutsideEvidence[];
}): { evidence: readonly unknown[]; acceptedRegistrationGuids: readonly string[]; diagnostics: readonly string[] } {
  const evidence: unknown[] = [], byPayer = new Map<string, ArkansasVerifiedOutsideEvidence>(), diagnostics: string[] = [], accepted = new Set<string>();
  for (const prior of input.retained) {
    try {
      const p = validateArkansasVerifiedOutsideEvidence(prior, input.link);
      if (byPayer.has(p.payer.registrationGuid)) fail("duplicate retained payer scope");
      byPayer.set(p.payer.registrationGuid, p);
    } catch (error) {
      evidence.push(prior); diagnostics.push("Outside retained unknown prior authority: " + (error instanceof Error ? error.message : String(error)));
    }
  }
  for (const incoming of input.incoming) {
    try {
      const e = validateArkansasVerifiedOutsideEvidence(incoming, input.link), prior = byPayer.get(e.payer.registrationGuid);
      if (prior) retainedAuthority(e, prior);
      byPayer.set(e.payer.registrationGuid, e); accepted.add(e.payer.registrationGuid);
    } catch (error) { diagnostics.push("Outside payer preserved: " + (error instanceof Error ? error.message : String(error))); }
  }
  evidence.push(...byPayer.values());
  return { evidence, acceptedRegistrationGuids: [...accepted], diagnostics };
}
