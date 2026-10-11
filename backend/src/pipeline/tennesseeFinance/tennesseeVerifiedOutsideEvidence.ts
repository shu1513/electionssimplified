import { createHash } from "node:crypto";
import type { TennesseeFinanceLinkInput } from "./tennesseeFinanceWriter.js";
import type { TennesseeCurrentReport, TennesseeCurrentReportManifest } from "./tennesseeCurrentReportClient.js";
import type { TennesseeNativeResult, TennesseeVerifiedNativeCandidateRow,
  TennesseeVerifiedNativeIndependentExpenditureRow, TennesseeVerifiedNativePacRegistryRow } from "./tennesseeVerifiedNativeClient.js";
import type { TennesseeOutsideCandidateContext, TennesseeVerifiedOutsideReportEvidence } from "./tennesseeOutsideReportEvidence.js";
import { normalizeTennesseeFullPersonName,resolveTennesseeLocalNameAuthority } from "./tennesseeVerifiedLocalName.js";
import { tennesseeCampOfficeLabelsForLinkOffice } from "./tennesseeFinanceEligibleOffices.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (value: string) => value.replace(/\s+/g, " ").trim();
const comparableName = normalizeTennesseeFullPersonName;
const district = (value: string | null | undefined) => value && /^\d+$/.test(value.trim()) ? String(Number(value)) : text(value ?? "").toUpperCase();
function addressKey(lines: readonly string[] | undefined, native: boolean): string | undefined {
  if (!lines || (native ? lines.length !== 2 && lines.length !== 3 : lines.length !== 2)) return undefined;
  const street = text(lines[0]!);
  const cityLine = text(lines[lines.length - 1]!);
  // The official city line separates city/state with a comma, state/ZIP with
  // either a comma (native table) or whitespace (full statement).
  const city = /^(.*?),\s*([A-Z]{2})[\s,]+(\d{5}(?:-\d{4})?)$/.exec(cityLine);
  if (!street || !city || !text(city[1]!)) return undefined;
  return JSON.stringify([street,text(city[1]!),city[2],city[3]]);
}

/** Exact full-name contextual inference, not a beneficiary ID published on an expense. */
export function resolveTennesseeVerifiedCandidateContext(input: {
  link: TennesseeFinanceLinkInput;
  nativeContext: TennesseeNativeResult<TennesseeVerifiedNativeCandidateRow>;
  reportedTargetName: string;
}): TennesseeOutsideCandidateContext | undefined {
  const { link, nativeContext, reportedTargetName } = input;
  if (!nativeContext.complete || nativeContext.declaredCount !== nativeContext.rows.length
    || nativeContext.query.searchType !== "candidate" || !nativeContext.query.electionYearSelection
    || nativeContext.rows.some(row => row.electionYear !== link.electionYear)) return undefined;
  const exact = nativeContext.rows.filter(row => comparableName(row.name) === comparableName(reportedTargetName));
  // Equal repeated metadata is harmless; distinct office, year, status or campaign is ambiguous.
  const identities = new Set(exact.map(row => JSON.stringify([row.campId,row.officeSought,row.district,row.electionYear,row.closed])));
  if (identities.size !== 1 || !exact.length) return undefined;
  const row = exact[0]!;
  const expected = tennesseeCampOfficeLabelsForLinkOffice(link.officeName);
  if (!expected.includes(text(row.officeSought).toUpperCase()) || row.campId !== link.campCandidateId
    || row.electionYear !== link.electionYear || district(row.district) !== district(link.district)
    || row.closed !== null || link.linkStatus === "inactive" || link.linkStatus === "ambiguous"
    || comparableName(row.name) !== comparableName(link.ownerName)) return undefined;
  const localNameAuthority = resolveTennesseeLocalNameAuthority(link,row.name);
  if (!localNameAuthority) return undefined;
  return { candidateId: link.candidateId, electionId: link.electionId, campCandidateId: link.campCandidateId,
    electionYear: link.electionYear, officeName: link.officeName, district: link.district ?? null,
    candidateContextFingerprint: digest([nativeContext.fingerprint,localNameAuthority]),localNameAuthority };
}

export type TennesseeOutsideReportVerificationInput = {
  link: TennesseeFinanceLinkInput;
  candidateContextBefore: TennesseeNativeResult<TennesseeVerifiedNativeCandidateRow>;
  candidateContextAfter: TennesseeNativeResult<TennesseeVerifiedNativeCandidateRow>;
  registryBefore: TennesseeNativeResult<TennesseeVerifiedNativePacRegistryRow>;
  registryAfter: TennesseeNativeResult<TennesseeVerifiedNativePacRegistryRow>;
  manifestBefore: TennesseeCurrentReportManifest;
  manifestAfter: TennesseeCurrentReportManifest;
  reportBefore: TennesseeCurrentReport;
  reportAfter: TennesseeCurrentReport;
  nativeBefore: readonly TennesseeNativeResult<TennesseeVerifiedNativeIndependentExpenditureRow>[];
  nativeAfter: readonly TennesseeNativeResult<TennesseeVerifiedNativeIndependentExpenditureRow>[];
};

/** A report-wide source closure. Failures emit no deletion authority. */
export function verifyTennesseeOutsideReport(input: TennesseeOutsideReportVerificationInput): {
  evidence?: TennesseeVerifiedOutsideReportEvidence; diagnostics: string[];
} {
  const preserve = (reason: string) => ({ diagnostics: ["Outside report preserved: " + reason] });
  const before = input.reportBefore, after = input.reportAfter, row = before.manifestRow;
  const candidateContext = resolveTennesseeVerifiedCandidateContext({ link: input.link,
    nativeContext: input.candidateContextBefore,reportedTargetName: input.link.ownerName });
  if (!candidateContext || input.candidateContextBefore.fingerprint !== input.candidateContextAfter.fingerprint
    || !resolveTennesseeVerifiedCandidateContext({ link: input.link,nativeContext: input.candidateContextAfter,
      reportedTargetName: input.link.ownerName })) return preserve("candidate context changed or ambiguous");
  if (input.registryBefore.fingerprint !== input.registryAfter.fingerprint
    || !input.registryBefore.complete || !input.registryAfter.complete) return preserve("PAC registry changed or incomplete");
  const payers = input.registryBefore.rows.filter(payer => payer.campId === row.campId);
  if (!payers.length || payers.some(payer => text(payer.ownerName) !== text(row.ownerName) || payer.committeeType !== "PAC")) {
    return preserve("payer identity lacks exact PAC registry authority");
  }
  if (input.manifestBefore.fingerprint !== input.manifestAfter.fingerprint
    || JSON.stringify(row) !== JSON.stringify(after.manifestRow)) return preserve("current manifest changed");
  for (const manifest of [input.manifestBefore,input.manifestAfter]) {
    const current = manifest.rows.filter(entry => entry.reportId === row.reportId);
    const samePeriod = manifest.rows.filter(entry => entry.campId === row.campId && entry.reportName === row.reportName);
    if (current.length !== 1 || samePeriod.length !== 1 || JSON.stringify(current[0]) !== JSON.stringify(row)) {
      return preserve("report is not uniquely current for this payer and ordinary period");
    }
  }
  if (!before.completeFullReport || !after.completeFullReport || before.fingerprint !== after.fingerprint
    || !before.period || !after.period || JSON.stringify(before.period) !== JSON.stringify(after.period)) {
    return preserve("full report or qualified interval changed or unavailable");
  }
  if (input.nativeBefore.length !== 3 || input.nativeAfter.length !== 3) return preserve("native source years incomplete");
  const years = new Set<number>();
  for (let i = 0; i < input.nativeBefore.length; i++) {
    const native = input.nativeBefore[i]!, closing = input.nativeAfter[i]!;
    const sourceYear = Number(native.query.yearSelection);
    if (!native.complete || !closing.complete || native.declaredCount !== native.rows.length
      || closing.declaredCount !== closing.rows.length || native.query.typeOf !== "independent"
      || Object.hasOwn(native.query,"electionYearSelection") || JSON.stringify(native.query) !== JSON.stringify(closing.query)
      || native.fingerprint !== closing.fingerprint || ![candidateContext.electionYear-2,candidateContext.electionYear-1,candidateContext.electionYear].includes(sourceYear)
      || years.has(sourceYear)) return preserve("native IE generation changed, filtered or incomplete");
    years.add(sourceYear);
  }
  const nativeRows = input.nativeBefore.flatMap(result => result.rows).filter(entry => entry.reportId === row.reportId);
  if (nativeRows.some(entry => entry.type !== "Independent" || entry.adjustment !== "N" || entry.amountCents <= 0
    || (entry.supportOpposeCode !== "S" && entry.supportOpposeCode !== "O")
    || text(entry.payerName) !== text(row.ownerName) || entry.reportUrl !== row.sourceUrl
    || text(entry.reportName) !== row.reportName.replace(/ \d{4}$/, "")
    || entry.date < before.period!.start || entry.date > before.period!.end
    || (entry.electionYear !== null && entry.electionYear !== candidateContext.electionYear))) {
    return preserve("native report identity, date, adjustment or election context unresolved");
  }
  const reportRows = before.expenseLedger.filter(entry => entry.independentTargetName !== null || entry.supportOppose !== "");
  if (reportRows.some(entry => !entry.independentTargetName || !entry.supportOppose || entry.inKind !== null
    || entry.amountCents <= 0 || entry.date < before.period!.start || entry.date > before.period!.end)) {
    return preserve("independent schedule has unresolved target, direction, in-kind or date");
  }
  if (nativeRows.some(entry => !addressKey(entry.vendorAddressLines,true))
    || reportRows.some(entry => !addressKey(entry.publishedIdentityLines.slice(1),false))) {
    return preserve("published vendor address identity unresolved");
  }
  const nativeKey = (entry: TennesseeVerifiedNativeIndependentExpenditureRow) => JSON.stringify([
    text(entry.vendorName),addressKey(entry.vendorAddressLines,true),text(entry.purpose),text(entry.targetName),
    entry.supportOpposeCode,entry.date,entry.amountCents,
  ]);
  const reportKey = (entry: typeof reportRows[number]) => JSON.stringify([
    text(entry.vendorName),addressKey(entry.publishedIdentityLines.slice(1),false),
    text(entry.purpose),text(entry.independentTargetName!),entry.supportOppose,entry.date,entry.amountCents,
  ]);
  const nativeKeys = nativeRows.map(nativeKey).sort(), reportKeys = reportRows.map(reportKey).sort();
  if (JSON.stringify(nativeKeys) !== JSON.stringify(reportKeys)) return preserve("whole-report native independent occurrences disagree");
  const occurrences = reportRows.filter(entry => comparableName(entry.independentTargetName!) === comparableName(input.link.ownerName))
    .filter(entry => entry.date >= `${candidateContext.electionYear-1}-01-01` && entry.date <= `${candidateContext.electionYear}-12-31`)
    .map(entry => ({ occurrenceId: String(entry.occurrence),targetCampId: candidateContext.campCandidateId,
      reportedTargetName: text(entry.independentTargetName!),resolutionMethod: "contextual_exact_name" as const,
      supportOppose: entry.supportOppose === "S" ? "support" as const : "oppose" as const,
      date: entry.date,amountCents: entry.amountCents }));
  return { diagnostics: [],evidence: {
    candidateContextFingerprint: candidateContext.candidateContextFingerprint,
    payerCampId: row.campId,payerName: text(row.ownerName),stream: "ordinary",periodIdentity: row.reportName,
    periodStart: before.period.start,periodEnd: before.period.end,reportId: row.reportId,sourceUrl: row.sourceUrl,
    manifestFingerprint: input.manifestBefore.fingerprint,fullLedgerFingerprint: before.fingerprint,
    rawHashes: { reportBefore: before.rawSource.sha256,reportAfter: after.rawSource.sha256,
      nativeBefore: digest(input.nativeBefore.map(result => result.fingerprint)),nativeAfter: digest(input.nativeAfter.map(result => result.fingerprint)),
      registryBefore: input.registryBefore.fingerprint,registryAfter: input.registryAfter.fingerprint,
      calendar: digest(before.period),manifestBefore: digest(input.manifestBefore.rawPages.map(page => page.sha256)),
      manifestAfter: digest(input.manifestAfter.rawPages.map(page => page.sha256)) },occurrences,
  } };
}
