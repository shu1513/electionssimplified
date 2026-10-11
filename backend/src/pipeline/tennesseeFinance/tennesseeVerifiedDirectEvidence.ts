import { createHash } from "node:crypto";
import { resolveTennesseeOrdinaryReportPeriodEnd } from "./tennesseeOrdinaryReportPeriodResolver.js";
import { normalizeTennesseeFullPersonName, resolveTennesseeLocalNameAuthority, tennesseeCandidateSearchToken } from "./tennesseeVerifiedLocalName.js";
import type { TennesseeFinanceLinkInput } from "./tennesseeFinanceWriter.js";
import { tennesseeCampOfficeLabelsForLinkOffice } from "./tennesseeFinanceEligibleOffices.js";
import { parseTennesseeCurrentReport, type TennesseeCurrentReport, type TennesseeCurrentReportManifest } from "./tennesseeCurrentReportClient.js";
import type { TennesseeNativeResult, TennesseeVerifiedNativeCandidateRow, TennesseeVerifiedNativeContributionRow, TennesseeVerifiedNativePacRegistryRow } from "./tennesseeVerifiedNativeClient.js";
import type { TennesseeFinanceDirectBreakdown } from "./tennesseeDirectContributionAggregator.js";
import { aggregateTennesseePacDonors, isTennesseeCampId, normalizeTennesseeReportedDonorName, tennesseeReportIdFromSourceUrl, validateTennesseePacSourceProvenance,
  type TennesseeFinancePacDonor, type TennesseePacSourceProvenance } from "./tennesseePacDonorAggregator.js";

export type TennesseeDirectSourceSnapshot = {
  manifest: TennesseeCurrentReportManifest; reports: readonly TennesseeCurrentReport[];
  nativeAll: ReadonlyMap<number, TennesseeNativeResult<TennesseeVerifiedNativeContributionRow>>;
  nativePac: ReadonlyMap<number, TennesseeNativeResult<TennesseeVerifiedNativeContributionRow>>;
  registry: TennesseeNativeResult<TennesseeVerifiedNativePacRegistryRow>;
};
export type TennesseeDirectEvidenceVerificationInput = {
  link: TennesseeFinanceLinkInput;
  candidateContextBefore: TennesseeNativeResult<TennesseeVerifiedNativeCandidateRow>;
  candidateContextAfter: TennesseeNativeResult<TennesseeVerifiedNativeCandidateRow>;
  before: TennesseeDirectSourceSnapshot; after: TennesseeDirectSourceSnapshot;
  priorPacSourceProvenance?: unknown;
};
export type TennesseeVerifiedCashReceipt = {
  reportId: string; occurrence: number; contributorName: string; contributorClass: string;
  date: string; amountCents: number; sourceUrl: string; nativeRow: TennesseeVerifiedNativeContributionRow;
};
export type TennesseeVerifiedDirectEvidence = {
  grossCashRaisedCents?: number; itemizedCashCents: number; unitemizedInWindowCents?: number;
  cashReceipts: TennesseeVerifiedCashReceipt[]; directBreakdowns: TennesseeFinanceDirectBreakdown[];
  pacDonors?: TennesseeFinancePacDonor[]; pacProvenance?: TennesseePacSourceProvenance;
  coverage: { windowStart: string; windowEnd: string; publishedThrough: string; reportIds: string[]; sourceUrl: string };
};
const text = (v: string) => v.replace(/\s+/g, " ").trim();
const name = (v: string) => text(v).toUpperCase();
// Observed HTML LAST , FIRST and CSV LAST, FIRST differ only at comma whitespace.
const donorName = (v: string) => name(v).replace(/\s*,\s*/g, ",");
const person = normalizeTennesseeFullPersonName;
const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const digest = (v: unknown) => hash(JSON.stringify(v));
// JSONB preserves values and array order but may reorder object keys.
function orderedJson(value: unknown): string {
  const ordered = (v: unknown): unknown => Array.isArray(v) ? v.map(ordered) : v !== null && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, ordered(x)])) : v;
  return JSON.stringify(ordered(value));
}
const fingerprint = (rows: readonly unknown[]) => digest(rows.map(r => JSON.stringify(r)).sort());
function validDate(v: string): boolean { const d = new Date(v + "T00:00:00Z"); return /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v; }
function nextDay(v: string): string { return new Date(Date.parse(v + "T00:00:00Z") + 86400000).toISOString().slice(0, 10); }
function cents(n: number): boolean { return Number.isSafeInteger(n); }
function sum(values: readonly number[]): number { const result = values.reduce((s, n) => s + BigInt(n), 0n); if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < -BigInt(Number.MAX_SAFE_INTEGER)) throw Error("unsafe cents sum"); return Number(result); }
function complete<T>(r: TennesseeNativeResult<T>): boolean { return r.complete === true && r.declaredCount === r.rows.length && r.fingerprint === fingerprint(r.rows); }
function stable<T>(a: TennesseeNativeResult<T>, b: TennesseeNativeResult<T>): boolean { return complete(a) && complete(b) && a.fingerprint === b.fingerprint && JSON.stringify(a.query) === JSON.stringify(b.query); }
export type TennesseePublishedAddress = { street: string; city: string; state: string; zip: string };
/** Native HTML publishes Address1, optional Address2, and City/State/ZIP as distinct lines.
 * The statement publishes Address1 and City/State/ZIP; never strip suites from Address1. */
export function projectTennesseeNativePublishedAddress(lines: readonly string[] | undefined): TennesseePublishedAddress | undefined {
  if (!lines || (lines.length !== 2 && lines.length !== 3)) return undefined;
  const last = /^(.+?)\s*,\s*([A-Za-z]{2})\s*,\s*(\d{5}(?:-\d{4})?)$/.exec(text(lines[lines.length - 1]));
  if (!last || !text(lines[0])) return undefined;
  return { street: text(lines[0]), city: text(last[1]), state: last[2].toUpperCase(), zip: last[3] };
}
export function projectTennesseeStatementPublishedAddress(lines: readonly string[]): TennesseePublishedAddress | undefined {
  if (lines.length !== 2) return undefined;
  const last = /^(.+?)\s*,?\s+([A-Za-z]{2})\s*,?\s+(\d{5}(?:-\d{4})?)$/.exec(text(lines[1]));
  if (!last || !text(lines[0])) return undefined;
  return { street: text(lines[0]), city: text(last[1]).replace(/,$/, ""), state: last[2].toUpperCase(), zip: last[3] };
}
function identity(row: TennesseeVerifiedNativeContributionRow): string {
  const address = projectTennesseeNativePublishedAddress(row.contributorAddressLines);
  if (!address) throw Error("native published address layout unresolved");
  return JSON.stringify([row.reportId, name(row.recipientName), donorName(row.contributorName), row.date, row.amountCents,
    address, text(row.contributorOccupation), text(row.contributorEmployer)]);
}
function statementIdentity(report: TennesseeCurrentReport, row: TennesseeCurrentReport["cashLedger"][number]): string {
  const lines = row.publishedIdentityLines;
  const address = projectTennesseeStatementPublishedAddress(lines.slice(1, 3));
  if (!address || name(lines[0] ?? "") !== name(row.reportedName)) throw Error("statement published address/identity unresolved");
  // HTML prints occupation then employer and omits empty identity lines.
  return JSON.stringify([report.manifestRow.reportId, name(report.manifestRow.ownerName), donorName(row.reportedName), row.date, row.amountCents, address, lines.slice(3).map(text)]);
}
function nativeStatementIdentity(row: TennesseeVerifiedNativeContributionRow): string {
  const tuple = JSON.parse(identity(row)) as unknown[];
  return JSON.stringify([...tuple.slice(0, 6), [text(row.contributorOccupation), text(row.contributorEmployer)].filter(Boolean)]);
}
function identical(a: readonly string[], b: readonly string[]): boolean { return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort()); }
function candidateContext(input: TennesseeDirectEvidenceVerificationInput): boolean {
  const a = input.candidateContextBefore, b = input.candidateContextAfter, link = input.link;
  if (!stable(a, b) || a.query.searchType !== "candidate" || !a.query.electionYearSelection || link.linkStatus === "inactive" || link.linkStatus === "ambiguous") return false;
  const matches = a.rows.filter(r => person(r.name) === person(link.ownerName));
  if (!matches.length || new Set(matches.map(r => JSON.stringify([r.campId, r.officeSought, r.district, r.electionYear, r.closed]))).size !== 1) return false;
  const row = matches[0]; const office = name(link.officeName);
  const expected = tennesseeCampOfficeLabelsForLinkOffice(link.officeName);
  const district = (v: string | null | undefined) => /^\d+$/.test(text(v ?? "")) ? String(Number(v)) : text(v ?? "");
  return a.rows.every(r => r.electionYear === link.electionYear) && row.campId === link.campCandidateId && row.closed === null
    && resolveTennesseeLocalNameAuthority(link, row.name) !== undefined
    && JSON.stringify(resolveTennesseeLocalNameAuthority(link, row.name)) === JSON.stringify(resolveTennesseeLocalNameAuthority(link, b.rows.find(r => r.campId === row.campId)!.name))
    && person(row.ownerName) === person(link.ownerName)
    && expected.includes(name(row.officeSought)) && district(row.district) === district(link.district)
    && (office === "GOVERNOR" ? district(row.district) === "" : /^\d+$/.test(district(row.district)));
}
function priorPacCompatible(prior: unknown, current: TennesseePacSourceProvenance): boolean {
  if (prior === undefined || prior === null) return true;
  if (!prior || typeof prior !== "object") return false;
  const p = prior as TennesseePacSourceProvenance;
  if (p.version !== 1 || ["candidateId", "electionId", "campCandidateId", "electionYear", "windowStart", "windowEnd"].some(k => p[k as keyof typeof p] !== current[k as keyof typeof current])
    || ![p.registryFingerprint, p.currentManifestFingerprint, p.nativeAllFingerprint, p.nativePacFingerprint,p.candidateContextFingerprint].every(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v))
    || !Array.isArray(p.reports) || !p.reports.length || !Array.isArray(p.receipts)
    || (p.localNameAuthority !== undefined && orderedJson(p.localNameAuthority) !== orderedJson(current.localNameAuthority))) return false;
  const ids = new Set<string>(), periods = new Set<string>();
  for (const report of p.reports) {
    if (!isTennesseeCampId(report.reportId) || ids.has(report.reportId) || typeof report.periodIdentity !== "string" || !report.periodIdentity || periods.has(report.periodIdentity)
      || !validDate(report.periodStart) || !validDate(report.periodEnd) || report.periodStart > report.periodEnd
      || tennesseeReportIdFromSourceUrl(report.sourceUrl) !== report.reportId || ![report.rawSha256, report.semanticFingerprint].every(v => /^[a-f0-9]{64}$/.test(v))) return false;
    ids.add(report.reportId); periods.add(report.periodIdentity);
    // Only a complete verified report for the exact same ordinary period can replace old evidence.
    const replacement = current.reports.filter(r => r.periodIdentity === report.periodIdentity && r.periodStart === report.periodStart && r.periodEnd === report.periodEnd);
    if (replacement.length !== 1) return false;
    if (replacement[0].rawSha256 === report.rawSha256 && replacement[0].semanticFingerprint === report.semanticFingerprint
      && !p.receipts.filter(r => r.reportId === report.reportId).every(r => current.receipts.some(c => c.reportId === replacement[0].reportId && c.occurrence === r.occurrence && c.donorId === r.donorId && c.date === r.date && c.amountCents === r.amountCents && c.dateRelation === r.dateRelation))) return false;
  }
  const occurrences = new Set<string>();
  for (const r of p.receipts) {
    const report = p.reports.find(x => x.reportId === r.reportId), k = r.reportId + ":" + r.occurrence;
    if (!report || !Number.isSafeInteger(r.occurrence) || r.occurrence < 0 || occurrences.has(k) || !validDate(r.date) || r.date < p.windowStart || r.date > p.windowEnd
      || r.date > report.periodEnd || r.dateRelation !== (r.date < report.periodStart ? "predates_report_period" : undefined) || !cents(r.amountCents) || r.amountCents <= 0 || typeof r.donorId !== "string"
      || (!isTennesseeCampId(r.donorId) && !/^reported:[\p{L}\p{N}]+(?: [\p{L}\p{N}]+)*$/u.test(r.donorId))) return false;
    occurrences.add(k);
  }
  return true;
}
function breakdowns(rows: readonly TennesseeVerifiedCashReceipt[], sourceUrl: string): TennesseeFinanceDirectBreakdown[] {
  const groups = new Map<string, { categoryType: "occupation" | "contribution_size"; categoryName: string; values: number[]; donors: Set<string> }>();
  for (const r of rows) {
    const amount = r.amountCents; const bucket = amount < 10000 ? "$1-$99" : amount < 25000 ? "$100-$249" : amount < 50000 ? "$250-$499" : amount < 100000 ? "$500-$999" : amount < 500000 ? "$1,000-$4,999" : "$5,000+";
    const labels: ["occupation" | "contribution_size", string][] = [["occupation", text(r.nativeRow.contributorOccupation)], ["contribution_size", bucket]];
    for (const [categoryType, categoryName] of labels) {
      if (!categoryName) continue; const key = categoryType + ":" + name(categoryName); const g = groups.get(key) ?? { categoryType, categoryName, values: [], donors: new Set<string>() };
      g.values.push(amount); g.donors.add(name(r.contributorName)); groups.set(key, g);
    }
  }
  return [...groups.values()].map(g => ({ categoryType: g.categoryType, categoryName: g.categoryName, amount: sum(g.values) / 100, contributorCount: g.donors.size, sourceUrl }))
    .sort((a, b) => a.categoryType.localeCompare(b.categoryType) || b.amount - a.amount || a.categoryName.localeCompare(b.categoryName));
}
/** Whole-current ordinary cash/PAC verification. No network, AI, DB, or IE dependency. */
export function verifyTennesseeDirectEvidence(input: TennesseeDirectEvidenceVerificationInput): { evidence?: TennesseeVerifiedDirectEvidence; diagnostics: string[] } {
  const preserve = (why: string) => ({ diagnostics: ["Direct/PAC preserved: " + why] });
  try {
    const { link, before, after } = input;
    if (!candidateContext(input)) return preserve("candidate context or exact local ownership changed/ambiguous");
    const start = `${link.electionYear - 1}-01-01`, end = `${link.electionYear}-12-31`;
    if (!stable(before.registry, after.registry) || before.registry.query.searchType !== "pac" || before.registry.rows.some(r => r.committeeType !== "PAC")) return preserve("PAC registry incomplete/changed/wrong class");
    const manifestHash = (m: TennesseeCurrentReportManifest) => digest([...m.rows].sort((a, b) => Number(a.reportId) - Number(b.reportId)));
    if (!before.manifest.rows.length || before.manifest.fingerprint !== after.manifest.fingerprint || before.manifest.fingerprint !== manifestHash(before.manifest)
      || after.manifest.fingerprint !== manifestHash(after.manifest) || !before.manifest.rawPages.length || !after.manifest.rawPages.length) return preserve("current manifest changed/incomplete");
    const reports = new Map<string, TennesseeCurrentReport>(), closing = new Map(after.reports.map(r => [r.manifestRow.reportId, r]));
    if (closing.size !== after.reports.length) return preserve("duplicate closing reports");
    const applicable = before.manifest.rows.filter(r => r.electionYear === link.electionYear && (r.reportYear === null ? r.submittedDate >= start : r.reportYear >= link.electionYear - 2 && r.reportYear <= link.electionYear));
    for (const row of applicable) {
      if (row.campId !== link.campCandidateId || person(row.ownerName) !== person(link.ownerName)
        || before.manifest.rows.filter(r => r.electionYear === row.electionYear && r.reportName === row.reportName).length !== 1) return preserve("manifest campaign/current period identity ambiguous");
      const endpoint = resolveTennesseeOrdinaryReportPeriodEnd({ manifestRow: row, context: { filerType: "candidate", candidateElectionYear: link.electionYear, electionSchedule: "august-primary-november-general" } });
      // An authoritative endpoint wholly before the window is enough to exclude an old report;
      // it cannot establish any intersecting report start or current financial zero.
      if (endpoint && endpoint.end < start) continue;
      const r = before.reports.filter(r => r.manifestRow.reportId === row.reportId), c = closing.get(row.reportId);
      if (r.length !== 1 || !c || JSON.stringify(r[0].manifestRow) !== JSON.stringify(row) || JSON.stringify(c.manifestRow) !== JSON.stringify(row)
        || !r[0].period || !c.period || JSON.stringify(r[0].period) !== JSON.stringify(c.period) || !r[0].period.sourceUrl.startsWith("https://www.tn.gov/")
        || !r[0].period.sourceContext.trim() || !validDate(r[0].period.start) || !validDate(r[0].period.end) || r[0].period.start > r[0].period.end) return preserve("full current report or qualified period unavailable");
      const parsed = parseTennesseeCurrentReport({ rawSource: r[0].rawSource, manifestRow: row, expectedPeriod: r[0].period });
      const parsedAfter = parseTennesseeCurrentReport({ rawSource: c.rawSource, manifestRow: row, expectedPeriod: c.period });
      if (!r[0].completeFullReport || !c.completeFullReport || parsed.fingerprint !== r[0].fingerprint || parsedAfter.fingerprint !== c.fingerprint || parsed.fingerprint !== parsedAfter.fingerprint
        || JSON.stringify(parsed.cashLedger) !== JSON.stringify(r[0].cashLedger) || JSON.stringify(parsed.covers) !== JSON.stringify(r[0].covers)) return preserve("full current ledger changed/corrupt");
      if (parsed.period!.start <= end && parsed.period!.end >= start) reports.set(row.reportId, parsed);
    }
    const ordered = [...reports.values()].sort((a, b) => a.period!.start.localeCompare(b.period!.start));
    if (!ordered.length || ordered[0].period!.start > start || ordered.some((r, i) => i > 0 && nextDay(ordered[i - 1].period!.end) !== r.period!.start)) return preserve("ordinary period start/continuity hole");
    const allRows: TennesseeVerifiedNativeContributionRow[] = [], pacRows: TennesseeVerifiedNativeContributionRow[] = [];
    for (const scope of ["all", "pac"] as const) {
      const a = scope === "all" ? before.nativeAll : before.nativePac, b = scope === "all" ? after.nativeAll : after.nativePac;
      if (a.size !== 3 || b.size !== 3) return preserve("native source years incomplete");
      for (const y of [link.electionYear - 2, link.electionYear - 1, link.electionYear]) {
        const native = a.get(y), current = b.get(y);
        if (!native || !current || !stable(native, current) || native.query.searchType !== "contributions" || native.query.toType !== "candidate" || native.query.typeOf !== "all"
          || native.query.yearSelection !== String(y) || ![name(link.ownerName), name(tennesseeCandidateSearchToken(link.ownerName))].includes(name(native.query.recipientName ?? "")) || !native.query.electionYearSelection || native.query.fromPAC !== "true"
          || ["fromCandidate", "fromIndividual", "fromOrganization"].some(k => scope === "all" ? native.query[k] !== "true" : Object.hasOwn(native.query, k))) return preserve("native cash/PAC query changed/filtered/incomplete");
        for (const row of native.rows) {
          if (row.type !== "Monetary") continue;
          // The surname search token also returns other same-surname candidates' receipts.
          // Skip them unless they cite one of this owner's selected reports, which still fails below.
          if (name(row.recipientName) !== name(link.ownerName) && !reports.has(row.reportId)) continue;
          const relevant = reports.has(row.reportId) || row.date >= start && row.date <= end;
          if (!relevant) continue;
          const report = reports.get(row.reportId);
          if (!report || row.reportUrl !== report.manifestRow.sourceUrl || name(row.recipientName) !== name(link.ownerName) || row.electionYear !== link.electionYear
            || text(row.reportName) !== report.manifestRow.reportName.replace(/\s+\d{4}$/, "") || row.adjustment !== "N" || !cents(row.amountCents) || row.amountCents <= 0
            || !validDate(row.date) || row.date > report.period!.end) return preserve("unexplained native current/superseded receipt or adjustment");
          (scope === "all" ? allRows : pacRows).push(row);
        }
      }
    }
    const cashReceipts: TennesseeVerifiedCashReceipt[] = []; let unitemized = 0; let headlineAvailable = true;
    const diagnostics: string[] = [];
    const crossReportIdentities = new Map<string, { reportId: string; occurrence: number }[]>();
    for (const report of ordered) {
      const a = allRows.filter(r => r.reportId === report.manifestRow.reportId), p = pacRows.filter(r => r.reportId === report.manifestRow.reportId);
      if (!identical(a.map(nativeStatementIdentity), report.cashLedger.map(r => statementIdentity(report, r)))
        || !identical(p.map(nativeStatementIdentity), report.cashLedger.filter(r => r.sourceClass === "P").map(r => statementIdentity(report, r)))) return preserve("full cash/PAC occurrence and published identity mismatch");
      const adjustment = report.covers.find(c => c.label === "Contribution Adjustments")?.amountCents;
      const ui = report.covers.find(c => c.label === "Monetary Contributions, Unitemized")?.amountCents;
      if (adjustment !== 0 || ui === undefined || ui === null || !cents(ui) || ui < 0 || report.cashLedger.some(r => !cents(r.amountCents) || r.amountCents <= 0 || r.date > report.period!.end)) return preserve("signed cash/adjustment/cover unresolved");
      if (report.expenseLedger.some(r => r.date >= start && r.date <= end && /\b(?:RETURN|REFUND)\b/i.test(r.purpose))
        || report.schedules.some(s => /\b(?:return|refund)/i.test(s.section) && s.rows.length > 0)) return preserve("relevant return/refund interaction unresolved");
      for (const row of report.cashLedger) {
        if (row.date < report.period!.start) diagnostics.push(`Published receipt predates report period: ${report.manifestRow.reportId}:${row.occurrence} ${row.date} (retained as filed${row.date < start || row.date > end ? "; outside candidate date window" : ""})`);
        const tuple = JSON.parse(statementIdentity(report, row)) as unknown[];
        const key = JSON.stringify([...tuple.slice(1), row.sourceClass]);
        const occurrences = crossReportIdentities.get(key) ?? [];
        occurrences.push({ reportId: report.manifestRow.reportId, occurrence: row.occurrence }); crossReportIdentities.set(key, occurrences);
      }
      if (ui && (report.period!.start < start || report.period!.end > end)) headlineAvailable = false; else unitemized = sum([unitemized, ui]);
      const buckets = new Map<string, TennesseeVerifiedNativeContributionRow[]>();
      for (const r of a) { const k = nativeStatementIdentity(r), list = buckets.get(k) ?? []; list.push(r); buckets.set(k, list); }
      for (const r of report.cashLedger) {
        const nativeRow = buckets.get(statementIdentity(report, r))!.shift()!;
        if (r.date >= start && r.date <= end) cashReceipts.push({ reportId: report.manifestRow.reportId, occurrence: r.occurrence, contributorName: r.reportedName, contributorClass: r.sourceClass, date: r.date, amountCents: r.amountCents, sourceUrl: report.manifestRow.sourceUrl, nativeRow });
      }
    }
    const itemized = sum(cashReceipts.map(r => r.amountCents)), sourceUrl = ordered[ordered.length - 1].manifestRow.sourceUrl;
    const evidence: TennesseeVerifiedDirectEvidence = { itemizedCashCents: itemized, ...(headlineAvailable ? { grossCashRaisedCents: sum([itemized, unitemized]), unitemizedInWindowCents: unitemized } : {}), cashReceipts,
      directBreakdowns: breakdowns(cashReceipts, sourceUrl), coverage: { windowStart: start, windowEnd: end, publishedThrough: ordered[ordered.length - 1].period!.end, reportIds: ordered.map(r => r.manifestRow.reportId), sourceUrl } };
    if (!headlineAvailable) diagnostics.push("Raised preserved: boundary unitemized cash has no dated allocation");
    for (const occurrences of crossReportIdentities.values()) if (new Set(occurrences.map(r => r.reportId)).size > 1)
      diagnostics.push("Repeated published cash identity across current reports retained as filed occurrences: " + occurrences.map(r => `${r.reportId}:${r.occurrence}`).join(", ") + "; no unique economic gift claim");
    const donors = aggregateTennesseePacDonors({ receipts: cashReceipts, registry: before.registry.rows, windowStart: start, windowEnd: end });
    if (!donors.donors) return { evidence, diagnostics: [...diagnostics, ...donors.diagnostics] };
    const byName = new Map<string, Set<string>>();
    for (const r of before.registry.rows) { const k = normalizeTennesseeReportedDonorName(r.name), ids = byName.get(k) ?? new Set<string>(); ids.add(r.campId); byName.set(k, ids); }
    const provenance: TennesseePacSourceProvenance = { version: 1, candidateId: link.candidateId, electionId: link.electionId, campCandidateId: link.campCandidateId, electionYear: link.electionYear,
      windowStart: start, windowEnd: end, candidateContextFingerprint: digest([input.candidateContextBefore.fingerprint, resolveTennesseeLocalNameAuthority(link, input.candidateContextBefore.rows.find(r => r.campId === link.campCandidateId)!.name)]),
      localNameAuthority: resolveTennesseeLocalNameAuthority(link, input.candidateContextBefore.rows.find(r => r.campId === link.campCandidateId)!.name), registryFingerprint: before.registry.fingerprint, currentManifestFingerprint: before.manifest.fingerprint,
      nativeAllFingerprint: digest([...before.nativeAll].map(([y, r]) => [y, r.fingerprint]).sort()), nativePacFingerprint: digest([...before.nativePac].map(([y, r]) => [y, r.fingerprint]).sort()),
      reports: ordered.map(r => ({ reportId: r.manifestRow.reportId, periodIdentity: r.manifestRow.reportName, periodStart: r.period!.start, periodEnd: r.period!.end, rawSha256: r.rawSource.sha256, semanticFingerprint: r.fingerprint, sourceUrl: r.manifestRow.sourceUrl })),
      receipts: cashReceipts.filter(r => r.contributorClass === "P").map(r => { const normalized = normalizeTennesseeReportedDonorName(r.contributorName), ids = byName.get(normalized);
        return { reportId: r.reportId, occurrence: r.occurrence, donorId: ids?.size === 1 ? [...ids][0] : "reported:" + normalized, date: r.date, amountCents: r.amountCents,
          ...(r.date < reports.get(r.reportId)!.period!.start ? { dateRelation: "predates_report_period" as const } : {}) }; }) };
    validateTennesseePacSourceProvenance({ ...link, provenance, donors: donors.donors });
    if (!priorPacCompatible(input.priorPacSourceProvenance, provenance)) return { evidence, diagnostics: [...diagnostics, "PAC preserved: malformed/incompatible prior proof or unexplained prior ordinary period disappearance"] };
    evidence.pacDonors = donors.donors; evidence.pacProvenance = provenance; return { evidence, diagnostics };
  } catch (e) { return preserve(e instanceof Error ? e.message : "source evidence invalid"); }
}
