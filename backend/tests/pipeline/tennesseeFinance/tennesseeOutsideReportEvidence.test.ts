import { describe, expect, it } from "vitest";
import { mergeTennesseeOutsideReportEvidence, summarizeTennesseeOutsideReportProvenance, type TennesseeOutsideCandidateContext, type TennesseeOutsideEvidenceOccurrence, type TennesseeVerifiedOutsideReportEvidence } from "../../../src/pipeline/tennesseeFinance/tennesseeOutsideReportEvidence.js";

// Synthetic policy closures only: these fixtures do not claim a live source zero.
const hash = (character = "a") => character.repeat(64);
const context: TennesseeOutsideCandidateContext = {
  candidateId: "candidate-local", electionId: "election-local", campCandidateId: "794", electionYear: 2026,
  officeName: "State Senator", district: "03", candidateContextFingerprint: hash(),
};
function report(overrides: Partial<TennesseeVerifiedOutsideReportEvidence> = {}): TennesseeVerifiedOutsideReportEvidence {
  const id = overrides.reportId ?? "128190";
  return { candidateContextFingerprint: context.candidateContextFingerprint, payerCampId: "136", payerName: "Synthetic verified payer", stream: "ordinary", periodIdentity: "Pre Primary 2026",
    periodStart: "2026-07-01", periodEnd: "2026-07-27", reportId: id,
    sourceUrl: `https://apps.tn.gov/tncamp/search/pub/report_full.htm?reportId=${id}`,
    manifestFingerprint: hash(), fullLedgerFingerprint: hash("b"), rawHashes: { ledgerBefore: hash(), ledgerAfter: hash(), cover: hash("b") },
    occurrences: [{ occurrenceId: "row-1", targetCampId: "794", supportOppose: "support", date: "2026-07-10", amountCents: 591062 }], ...overrides };
}
function merge(verifiedReports: TennesseeVerifiedOutsideReportEvidence[], prior?: unknown) {
  return mergeTennesseeOutsideReportEvidence({ candidateContext: context, verifiedReports, prior });
}
function provenance(reports = [report()]) { return { version: 1 as const, candidateContext: context, reports }; }
function preserved(result: ReturnType<typeof merge>, message: string) {
  expect(result.update).toBeUndefined();
  expect(result.diagnostics.join(" ")).toContain(message);
}

describe("mergeTennesseeOutsideReportEvidence (synthetic provenance policy)", () => {
  it("materializes a positive report with canonical payer ID and unknown absent direction", () => {
    expect(merge([report()])).toMatchObject({ diagnostics: [], update: { supportTotal: 5910.62, opposeTotal: null,
      provenance: { version: 1, candidateContext: context }, outsideGroups: [{ committeeKey: "136", committeeName: "Synthetic verified payer", supportOppose: "support", amount: 5910.62, expenditureCount: 1, sourceUrl: report().sourceUrl }] } });
  });
  it("retains unavailable reports while adding independent evidence", () => {
    const next = report({ payerCampId: "137", payerName: "Other payer", reportId: "128191", occurrences: [{ occurrenceId: "other", targetCampId: "794", date: "2026-07-11", amountCents: 10000, supportOppose: "oppose" }] });
    const result = merge([next], provenance());
    expect(result.update?.provenance.reports).toHaveLength(2);
    expect(result.update).toMatchObject({ supportTotal: 5910.62, opposeTotal: 100 });
    preserved(merge([], provenance()), "No verified reports");
  });
  it("repeated accepted closure is idempotent", () => {
    preserved(merge([report()], merge([report()]).update!.provenance), "unchanged");
  });
  it("replaces a changed same-ID ledger without adding its old money", () => {
    const changed = report({ fullLedgerFingerprint: hash("c"), rawHashes: { ledger: hash("c") }, occurrences: [{ ...report().occurrences[0]!, amountCents: 30000 }] });
    const result = merge([changed], provenance());
    expect(result.update?.provenance.reports).toHaveLength(1);
    expect(result.update?.supportTotal).toBe(300);
    expect(result.update?.provenance.reports[0]?.fullLedgerFingerprint).toBe(hash("c"));
  });
  it("replaces a uniquely current amendment of the exact same period", () => {
    const result = merge([report({ reportId: "128200", fullLedgerFingerprint: hash("d") })], provenance());
    expect(result.update?.provenance.reports.map((entry) => entry.reportId)).toEqual(["128200"]);
    expect(result.update?.supportTotal).toBe(5910.62);
  });
  it("synthetic zero replacement removes only that report and yields NULL", () => {
    const other = report({ payerCampId: "137", payerName: "Other payer", reportId: "128191", occurrences: [{ occurrenceId: "other", targetCampId: "794", date: "2026-07-11", amountCents: 10000, supportOppose: "oppose" }] });
    const result = merge([report({ occurrences: [], fullLedgerFingerprint: hash("c") })], provenance([report(), other]));
    expect(result.update).toMatchObject({ supportTotal: null, opposeTotal: 100 });
    expect(result.update?.outsideGroups).toHaveLength(1);
    expect(result.update?.provenance.reports.find((entry) => entry.reportId === "128190")?.occurrences).toEqual([]);
    preserved(merge([report({ occurrences: [] })]), "does not establish candidate zero");
  });
  it("synthetic sole-report zero explicitly clears groups and both scalar directions", () => {
    const result = merge([report({ occurrences: [], fullLedgerFingerprint: hash("c") })], provenance());
    expect(result.update).toMatchObject({ supportTotal: null, opposeTotal: null, outsideGroups: [] });
    expect(result.update?.provenance.reports).toHaveLength(1);
  });
  it("uses actual report period authority rather than inferred source-report year", () => {
    const result = merge([report({ periodIdentity: "Actual cross-year report", periodStart: "2024-12-15", periodEnd: "2025-01-15",
      occurrences: [{ occurrenceId: "january", targetCampId: "794", date: "2025-01-06", amountCents: 10001, supportOppose: "support" }] })]);
    expect(result.update?.supportTotal).toBe(100.01);
  });
  it("counts separate nonoverlapping reports for one payer without duplicate groups", () => {
    const next = report({ periodIdentity: "Next report", periodStart: "2026-08-01", periodEnd: "2026-08-31", reportId: "128202",
      occurrences: [{ ...report().occurrences[0]!, date: "2026-08-10" }] });
    const result = merge([next], provenance());
    expect(result.update?.outsideGroups).toHaveLength(1);
    expect(result.update).toMatchObject({ supportTotal: 11821.24, outsideGroups: [{ expenditureCount: 2 }] });
  });
  it("cannot claim supersession of another supplied current report", () => {
    const other = report({ payerCampId: "137", payerName: "Other payer", reportId: "128202" });
    preserved(merge([report({ supersededReportIds: ["128202"] }), other]), "conflicts with current report");
  });
  it("equal economic rows retain distinct occurrence multiplicity", () => {
    const row = report().occurrences[0]!;
    expect(merge([report({ occurrences: [row, { ...row, occurrenceId: "row-2" }] })]).update).toMatchObject({ supportTotal: 11821.24, outsideGroups: [{ expenditureCount: 2 }] });
    preserved(merge([report({ occurrences: [row, row] })]), "Duplicate occurrence");
  });
  it("sums all groups before any downstream cap", () => {
    const reports = Array.from({ length: 60 }, (_, i) => report({ payerCampId: String(i + 1), payerName: `Payer ${i}`, reportId: String(10000 + i), occurrences: [{ occurrenceId: "row", targetCampId: "794", date: "2026-07-11", amountCents: 101, supportOppose: "support" }] }));
    expect(merge(reports).update?.outsideGroups).toHaveLength(60);
    expect(merge(reports).update?.supportTotal).toBe(60.6);
  });
  it("preserves retained interval overlap unless verified supersession replaces it", () => {
    const overlapping = report({ periodStart: "2026-07-02", reportId: "128201" });
    preserved(merge([overlapping], provenance()), "Unresolved report overlap");
    expect(merge([{ ...overlapping, supersededReportIds: ["128190"] }], provenance()).update?.provenance.reports.map((r) => r.reportId)).toEqual(["128201"]);
  });
  it("does not guess altered bounds under reused ID or period identity", () => {
    preserved(merge([report({ periodStart: "2026-07-02" })], provenance()), "changed period/payer");
    preserved(merge([report({ reportId: "128202", periodStart: "2026-08-01", periodEnd: "2026-08-31", occurrences: [] })], provenance()), "Unresolved report overlap");
  });
  it("cannot supersede another payer or period", () => {
    preserved(merge([report({ payerCampId: "137", payerName: "Other payer", reportId: "128202", supersededReportIds: ["128190"] })], provenance()), "Incompatible supersession");
    preserved(merge([report({ periodIdentity: "Other authority", reportId: "128202", supersededReportIds: ["128190"] })], provenance()), "Incompatible supersession");
  });
  it("allows adjacent periods but rejects a shared civil boundary", () => {
    const old = report({ periodEnd: "2026-07-09", occurrences: [] });
    const next = report({ periodIdentity: "Next report", periodStart: "2026-07-10", reportId: "128202" });
    expect(merge([next], provenance([old])).update?.supportTotal).toBe(5910.62);
    preserved(merge([{ ...next, periodStart: "2026-07-09" }], provenance([old])), "Unresolved report overlap");
  });
  it("rejects competing current incoming versions instead of selecting newest", () => {
    preserved(merge([report(), report({ reportId: "128202" })]), "Unresolved report overlap");
    preserved(merge([report(), report()]), "duplicate current report");
  });
  it("refreshes a compatible identity while retaining each report's old proof generation", () => {
    const old = merge([report()]).update!.provenance;
    const freshContext = { ...context, candidateContextFingerprint: hash("c") };
    const fresh = report({ payerCampId: "137", payerName: "Other payer", reportId: "128202", candidateContextFingerprint: undefined });
    const result = mergeTennesseeOutsideReportEvidence({ candidateContext: freshContext, prior: old, verifiedReports: [fresh] });
    expect(result.update?.provenance.candidateContext.candidateContextFingerprint).toBe(hash("c"));
    expect(result.update?.provenance.reports.find(r => r.reportId === "128190")?.candidateContextFingerprint).toBe(hash());
    expect(result.update?.provenance.reports.find(r => r.reportId === "128202")?.candidateContextFingerprint).toBe(hash("c"));
    expect(result.update?.supportTotal).toBe(11821.24);
  });
  it("requires stored per-report proofs and rejects fresh mismatched proofs", () => {
    preserved(merge([report()], provenance([report({ candidateContextFingerprint: undefined })])), "report candidateContextFingerprint");
    preserved(merge([report({ candidateContextFingerprint: hash("c") })]), "Fresh report candidate proof mismatch");
  });
  it("preserves incompatible, malformed and legacy provenance", () => {
    preserved(merge([report()], { version: 0, reports: [] }), "version/schema");
    preserved(merge([report()], "legacy-positive"), "Invalid stored provenance");
    preserved(merge([report()], { ...provenance(), candidateContext: { ...context, electionId: "other" } }), "context mismatch");
    preserved(merge([report()], provenance([report(), report({ reportId: "128202" })])), "Unresolved report overlap");
  });
  it.each([
    ["payerCampId", "0136", "canonical"], ["reportId", "9007199254740992", "canonical"],
    ["sourceUrl", "https://apps.tn.gov/tncamp/search/pub/report_full.htm?reportId=1", "source URL"],
    ["manifestFingerprint", "A".repeat(64), "SHA256"], ["fullLedgerFingerprint", "abc", "SHA256"],
    ["periodStart", "2026-02-30", "calendar"], ["periodEnd", "2026-06-30", "Reversed"],
    ["stream", "interim", "Unsupported"], ["rawHashes", {}, "raw hashes"],
  ])("preserves invalid report %s", (field, value, message) => {
    preserved(merge([report({ [field]: value } as Partial<TennesseeVerifiedOutsideReportEvidence>)]), String(message));
  });
  it.each([
    [{ targetCampId: "795" }, "Wrong candidate"], [{ supportOppose: "unknown" }, "Unknown outside direction"],
    [{ date: "2026-07-28" }, "outside verified period"], [{ date: "2026-02-30" }, "calendar"],
    [{ amountCents: 0 }, "positive"], [{ amountCents: -1 }, "positive"], [{ amountCents: 100.5 }, "Unsafe"],
    [{ amountCents: Number.MAX_SAFE_INTEGER }, "round-trip"],
  ])("preserves invalid occurrence %j", (override, message) => {
    preserved(merge([report({ occurrences: [{ ...report().occurrences[0]!, ...override } as TennesseeOutsideEvidenceOccurrence] })]), message);
  });
  it("preserves aggregate overflow despite safe individual dollar amounts", () => {
    const row = { ...report().occurrences[0]!, amountCents: 5_000_000_000_000_000 };
    preserved(merge([report({ occurrences: [row, { ...row, occurrenceId: "row-2" }] })]), "Unsafe cents");
  });
  it("does not mutate supplied or stored evidence", () => {
    const old = provenance(), next = report({ reportId: "128202" });
    const before = JSON.stringify({ old, next });
    merge([next], old);
    expect(JSON.stringify({ old, next })).toBe(before);
  });
});


describe("summarizeTennesseeOutsideReportProvenance (synthetic stored authority)", () => {
  it("rebuilds all uncapped groups and retains historical per-report proof generations", () => {
    const reports = Array.from({ length: 60 }, (_, i) => report({ payerCampId: String(i + 1), payerName: `Payer ${i}`, reportId: String(10000 + i),
      candidateContextFingerprint: hash(i % 2 ? "b" : "c"), occurrences: [{ occurrenceId: "row", targetCampId: "794", date: "2026-07-11", amountCents: 101, supportOppose: "support" }] }));
    const result = summarizeTennesseeOutsideReportProvenance(provenance(reports));
    expect(result.diagnostics).toEqual([]);
    expect(result.result?.outsideGroups).toHaveLength(60);
    expect(result.result?.supportTotal).toBe(60.6);
    expect(result.result?.opposeTotal).toBeNull();
    expect(result.result?.provenance.reports.find(r => r.reportId === "10001")?.candidateContextFingerprint).toBe(hash("b"));
  });
  it("rejects missing/invalid stored authority, missing report proofs and conflicting money", () => {
    for (const value of [null, { version: 0 }, provenance([report({ candidateContextFingerprint: undefined })]), provenance([report(), report({ reportId: "128202" })])]) {
      const result = summarizeTennesseeOutsideReportProvenance(value);
      expect(result.result).toBeUndefined();
      expect(result.diagnostics).not.toEqual([]);
    }
    const loss = summarizeTennesseeOutsideReportProvenance(provenance([report({ occurrences: [{ ...report().occurrences[0]!, amountCents: Number.MAX_SAFE_INTEGER }] })]));
    expect(loss.result).toBeUndefined();
    expect(loss.diagnostics.join(" ")).toContain("round-trip");
  });
  it("retained synthetic empty report authority has no groups and NULL directions", () => {
    expect(summarizeTennesseeOutsideReportProvenance(provenance([report({ occurrences: [] })]))).toMatchObject({
      diagnostics: [], result: { outsideGroups: [], supportTotal: null, opposeTotal: null, provenance: { version: 1 } },
    });
  });
});
