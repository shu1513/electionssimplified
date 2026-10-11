/** Report-scoped authority only; source completeness must be verified upstream. */
export type TennesseeOutsideCandidateContext = {
  candidateId: string;
  electionId: string;
  campCandidateId: string;
  electionYear: number;
  officeName: string;
  district: string | null;
  candidateContextFingerprint: string;
};

export type TennesseeOutsideEvidenceOccurrence = {
  occurrenceId: string;
  targetCampId: string;
  reportedTargetName: string;
  resolutionMethod: "contextual_exact_name";
  supportOppose: "support" | "oppose";
  date: string;
  amountCents: number;
};

export type TennesseeVerifiedOutsideReportEvidence = {
  /** Fresh closures may omit this; normalized stored authority always includes it. */
  candidateContextFingerprint?: string;
  payerCampId: string;
  payerName: string;
  stream: "ordinary";
  periodIdentity: string;
  periodStart: string;
  periodEnd: string;
  reportId: string;
  sourceUrl: string;
  manifestFingerprint: string;
  fullLedgerFingerprint: string;
  rawHashes: Readonly<Record<string, string>>;
  occurrences: readonly TennesseeOutsideEvidenceOccurrence[];
  /** Actual source-verified supersession, never inferred from report date/order. */
  supersededReportIds?: readonly string[];
};

export type TennesseeStoredOutsideReportEvidence = TennesseeVerifiedOutsideReportEvidence & { candidateContextFingerprint: string };

export type TennesseeOutsideReportProvenance = {
  version: 1;
  candidateContext: TennesseeOutsideCandidateContext;
  reports: readonly TennesseeStoredOutsideReportEvidence[];
};

export type TennesseeOutsideEvidenceGroup = {
  committeeKey: string;
  committeeName: string;
  supportOppose: "support" | "oppose";
  amount: number;
  expenditureCount: number;
  sourceUrl: string;
};

export type TennesseeOutsideEvidenceUpdate = {
  provenance: TennesseeOutsideReportProvenance;
  outsideGroups: TennesseeOutsideEvidenceGroup[];
  supportTotal: number | null;
  opposeTotal: number | null;
};

const HASH = /^[a-f0-9]{64}$/;
function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) throw new Error(`${label}: invalid text`);
}
function requireId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${label}: expected canonical safe positive source ID`);
  }
}
function requireHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label}: invalid SHA256`);
}
function requireDate(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label}: invalid civil date`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error(`${label}: invalid calendar date`);
}
function dollars(cents: number): number {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("Unsafe cents or dollar round-trip loss");
  const amount = cents / 100;
  // JSON/pg serialize numbers through their decimal string, not binary * 100.
  const decimal = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(amount));
  if (!decimal || BigInt(decimal[1]!) * 100n + BigInt((decimal[2] ?? "").padEnd(2, "0")) !== BigInt(cents)) {
    throw new Error("Unsafe cents or dollar round-trip loss");
  }
  return amount;
}
function addCents(left: number, right: number): number {
  const sum = left + right;
  dollars(sum);
  return sum;
}
function validateContext(context: TennesseeOutsideCandidateContext): void {
  requireText(context.candidateId, "candidateId");
  requireText(context.electionId, "electionId");
  requireId(context.campCandidateId, "campCandidateId");
  requireText(context.officeName, "officeName");
  if (context.district !== null) requireText(context.district, "district");
  if (!Number.isInteger(context.electionYear) || context.electionYear < 2000 || context.electionYear > 2100) throw new Error("Invalid electionYear");
  requireHash(context.candidateContextFingerprint, "candidateContextFingerprint");
}
function sameContext(left: TennesseeOutsideCandidateContext, right: TennesseeOutsideCandidateContext): boolean {
  return left.candidateId === right.candidateId && left.electionId === right.electionId && left.campCandidateId === right.campCandidateId
    && left.electionYear === right.electionYear && left.officeName === right.officeName && left.district === right.district;
}
function normalizeReport(report: TennesseeVerifiedOutsideReportEvidence, context: TennesseeOutsideCandidateContext, stored = false): TennesseeStoredOutsideReportEvidence {
  const candidateContextFingerprint = stored ? report.candidateContextFingerprint : report.candidateContextFingerprint ?? context.candidateContextFingerprint;
  requireHash(candidateContextFingerprint, "report candidateContextFingerprint");
  if (!stored && candidateContextFingerprint !== context.candidateContextFingerprint) throw new Error("Fresh report candidate proof mismatch");
  requireId(report.payerCampId, "payerCampId");
  requireText(report.payerName, "payerName");
  if (report.stream !== "ordinary") throw new Error("Unsupported report stream");
  requireText(report.periodIdentity, "periodIdentity");
  requireDate(report.periodStart, "periodStart");
  requireDate(report.periodEnd, "periodEnd");
  if (report.periodStart > report.periodEnd) throw new Error("Reversed report period");
  requireId(report.reportId, "reportId");
  if (report.sourceUrl !== `https://apps.tn.gov/tncamp/search/pub/report_full.htm?reportId=${report.reportId}`) throw new Error("Report source URL does not match reportId");
  requireHash(report.manifestFingerprint, "manifestFingerprint");
  requireHash(report.fullLedgerFingerprint, "fullLedgerFingerprint");
  if (!report.rawHashes || typeof report.rawHashes !== "object" || Array.isArray(report.rawHashes) || !Object.keys(report.rawHashes).length) throw new Error("Missing immutable raw hashes");
  const rawHashes: Record<string, string> = {};
  for (const key of Object.keys(report.rawHashes).sort()) {
    requireText(key, "raw hash key");
    requireHash(report.rawHashes[key], `rawHashes.${key}`);
    Object.defineProperty(rawHashes, key, { value: report.rawHashes[key], enumerable: true });
  }
  if (!Array.isArray(report.occurrences)) throw new Error("Missing occurrences");
  const ids = new Set<string>();
  const occurrences = report.occurrences.map((row) => {
    requireText(row.occurrenceId, "occurrenceId");
    if (ids.has(row.occurrenceId)) throw new Error(`Duplicate occurrence ${row.occurrenceId} in report ${report.reportId}`);
    ids.add(row.occurrenceId);
    requireId(row.targetCampId, "targetCampId");
    requireText(row.reportedTargetName, "reportedTargetName");
    if (row.resolutionMethod !== "contextual_exact_name") throw new Error("Unsupported target resolution method");
    if (row.targetCampId !== context.campCandidateId) throw new Error(`Wrong candidate target in report ${report.reportId}`);
    if (row.supportOppose !== "support" && row.supportOppose !== "oppose") throw new Error("Unknown outside direction");
    requireDate(row.date, "occurrence date");
    if (row.date < report.periodStart || row.date > report.periodEnd || row.date < `${context.electionYear - 1}-01-01` || row.date > `${context.electionYear}-12-31`) throw new Error("Occurrence outside verified period/candidate cycle");
    if (row.amountCents <= 0) throw new Error("Occurrence amount must be positive");
    dollars(row.amountCents);
    return { occurrenceId: row.occurrenceId, targetCampId: row.targetCampId, reportedTargetName: row.reportedTargetName, resolutionMethod: row.resolutionMethod, supportOppose: row.supportOppose, date: row.date, amountCents: row.amountCents };
  }).sort((a, b) => a.occurrenceId.localeCompare(b.occurrenceId));
  const supersededReportIds = [...(report.supersededReportIds ?? [])].sort();
  const superseded = new Set<string>();
  for (const id of supersededReportIds) {
    requireId(id, "supersededReportId");
    if (id === report.reportId || superseded.has(id)) throw new Error("Invalid duplicate/self supersession");
    superseded.add(id);
  }
  return { candidateContextFingerprint, payerCampId: report.payerCampId, payerName: report.payerName, stream: report.stream, periodIdentity: report.periodIdentity,
    periodStart: report.periodStart, periodEnd: report.periodEnd, reportId: report.reportId, sourceUrl: report.sourceUrl,
    manifestFingerprint: report.manifestFingerprint, fullLedgerFingerprint: report.fullLedgerFingerprint, rawHashes, occurrences,
    ...(supersededReportIds.length ? { supersededReportIds } : {}) };
}
function slot(report: TennesseeVerifiedOutsideReportEvidence): string {
  return JSON.stringify([report.payerCampId, report.stream, report.periodIdentity, report.periodStart, report.periodEnd]);
}
function conflict(left: TennesseeVerifiedOutsideReportEvidence, right: TennesseeVerifiedOutsideReportEvidence): boolean {
  return left.payerCampId === right.payerCampId && left.stream === right.stream
    && (left.periodIdentity === right.periodIdentity || (left.periodStart <= right.periodEnd && right.periodStart <= left.periodEnd));
}
function validateReportSet(reports: readonly TennesseeVerifiedOutsideReportEvidence[]): void {
  const ids = new Set<string>();
  for (let index = 0; index < reports.length; index += 1) {
    const report = reports[index]!;
    if (ids.has(report.reportId)) throw new Error(`Conflicting/duplicate current report ${report.reportId}`);
    ids.add(report.reportId);
    for (const earlier of reports.slice(0, index)) if (conflict(earlier, report)) throw new Error(`Unresolved report overlap ${earlier.reportId}/${report.reportId}`);
  }
}
function normalizeStoredProvenance(value: unknown): TennesseeOutsideReportProvenance {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid stored provenance");
  const prior = value as TennesseeOutsideReportProvenance;
  if (prior.version !== 1 || !prior.candidateContext || !Array.isArray(prior.reports)) throw new Error("Invalid stored provenance version/schema");
  validateContext(prior.candidateContext);
  const reports = prior.reports.map((report) => normalizeReport(report, prior.candidateContext, true))
    .sort((a, b) => slot(a).localeCompare(slot(b)) || a.reportId.localeCompare(b.reportId));
  validateReportSet(reports);
  return { version: 1, candidateContext: { ...prior.candidateContext }, reports };
}
function materialize(provenance: TennesseeOutsideReportProvenance): TennesseeOutsideEvidenceUpdate {
  const reports = provenance.reports;
  const groups = new Map<string, { committeeKey: string; committeeName: string; supportOppose: "support" | "oppose"; cents: number; expenditureCount: number; sourceUrl: string }>();
  let supportCents = 0;
  let opposeCents = 0;
  for (const report of reports) for (const occurrence of report.occurrences) {
    const key = `${report.payerCampId}:${occurrence.supportOppose}`;
    const existing = groups.get(key);
    if (existing && existing.committeeName !== report.payerName) throw new Error(`Conflicting payer name ${report.payerCampId}`);
    const group = existing ?? { committeeKey: report.payerCampId, committeeName: report.payerName, supportOppose: occurrence.supportOppose, cents: 0, expenditureCount: 0, sourceUrl: report.sourceUrl };
    group.cents = addCents(group.cents, occurrence.amountCents);
    group.expenditureCount += 1;
    if (!Number.isSafeInteger(group.expenditureCount) || group.expenditureCount > 2147483647) throw new Error("Occurrence count exceeds int32 storage");
    groups.set(key, group);
    if (occurrence.supportOppose === "support") supportCents = addCents(supportCents, occurrence.amountCents);
    else opposeCents = addCents(opposeCents, occurrence.amountCents);
  }
  return { provenance, outsideGroups: [...groups.values()].map(({ cents, ...group }) => ({ ...group, amount: dollars(cents) }))
    .sort((a, b) => b.amount - a.amount || a.committeeKey.localeCompare(b.committeeKey) || a.supportOppose.localeCompare(b.supportOppose)),
    supportTotal: supportCents > 0 ? dollars(supportCents) : null, opposeTotal: opposeCents > 0 ? dollars(opposeCents) : null };
}
/** Validate stored report authority without rebinding its historical proof hashes. */
export function summarizeTennesseeOutsideReportProvenance(provenance: unknown): {
  result?: TennesseeOutsideEvidenceUpdate;
  diagnostics: string[];
} {
  try {
    return { result: materialize(normalizeStoredProvenance(provenance)), diagnostics: [] };
  } catch (error) {
    return { diagnostics: [`Stored outside authority unavailable: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
/** Undefined update means preserve. Legacy/owner eligibility is independently enforced by the writer. */
export function mergeTennesseeOutsideReportEvidence(input: {
  candidateContext: TennesseeOutsideCandidateContext;
  prior?: unknown;
  verifiedReports: readonly TennesseeVerifiedOutsideReportEvidence[];
}): { update?: TennesseeOutsideEvidenceUpdate; diagnostics: string[] } {
  try {
    validateContext(input.candidateContext);
    let priorReports: TennesseeStoredOutsideReportEvidence[] = [];
    if (input.prior !== undefined && input.prior !== null) {
      const prior = normalizeStoredProvenance(input.prior);
      if (!sameContext(prior.candidateContext, input.candidateContext)) throw new Error("Stored candidate context mismatch");
      priorReports = [...prior.reports];
    }
    if (!Array.isArray(input.verifiedReports)) throw new Error("Missing verified report closures");
    const incoming = input.verifiedReports.map((report) => normalizeReport(report, input.candidateContext));
    validateReportSet(incoming);
    if (!incoming.length) return { diagnostics: ["No verified reports supplied; outside evidence preserved"] };
    const incomingIds = new Set(incoming.map((report) => report.reportId));
    const removals = new Set<string>();
    for (const report of incoming) {
      for (const id of report.supersededReportIds ?? []) {
        if (incomingIds.has(id)) throw new Error(`Supersession conflicts with current report ${id}`);
        const previous = priorReports.find((entry) => entry.reportId === id);
        // A source-verified archived ID need not have contributed stored evidence.
        if (!previous) continue;
        if (previous.payerCampId !== report.payerCampId || previous.stream !== report.stream || previous.periodIdentity !== report.periodIdentity) throw new Error(`Incompatible supersession ${id}/${report.reportId}`);
        removals.add(id);
      }
      for (const previous of priorReports) {
        if (slot(previous) === slot(report)) removals.add(previous.reportId);
        else if (previous.reportId === report.reportId) throw new Error(`Report ${report.reportId} changed period/payer without verified supersession`);
      }
    }
    const reports = [...priorReports.filter((report) => !removals.has(report.reportId)), ...incoming]
      .sort((a, b) => slot(a).localeCompare(slot(b)) || a.reportId.localeCompare(b.reportId));
    validateReportSet(reports);
    if (!priorReports.length && !reports.some((report) => report.occurrences.length)) return { diagnostics: ["Initial empty report scope does not establish candidate zero; outside preserved"] };
    const provenance: TennesseeOutsideReportProvenance = { version: 1, candidateContext: { ...input.candidateContext }, reports };
    const previousNormalized = { version: 1, candidateContext: input.candidateContext, reports: [...priorReports].sort((a, b) => slot(a).localeCompare(slot(b)) || a.reportId.localeCompare(b.reportId)) };
    if (input.prior != null && JSON.stringify(provenance) === JSON.stringify(previousNormalized)) return { diagnostics: ["Verified evidence unchanged; outside preserved"] };
    return { update: materialize(provenance), diagnostics: [] };
  } catch (error) {
    return { diagnostics: [`Outside evidence preserved: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
