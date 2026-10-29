import { describe, expect, it } from "vitest";
import { parseRhodeIslandCf8ScanUrl, validateRhodeIslandReviewedCf8,
  type RhodeIslandReviewedCf8Report } from "../../src/pipeline/rhodeIslandFinance/rhodeIslandReviewedCf8.js";

const first = "00000000-0000-0000-0000-000000000001";
const second = "00000000-0000-0000-0000-000000000002";
const transfer = "00000000-0000-0000-0000-000000000003";
const url = (guid: string, kind = "INDEPENDENT EXPENDITURE") =>
  `https://www.ricampaignfinance.com/ReportsScanned/Public-${encodeURIComponent(kind)}-${guid}.pdf`;
function report(guid: string, filedDate: string, cents: number, yearToDateCents: number): RhodeIslandReviewedCf8Report {
  return { filingGuid: guid, sourceUrl: url(guid), sourceSha256: "a".repeat(64), filedDate,
    reportedSpenderName: "Example Independent Spender", reportedCandidateName: "Example Person", supportOppose: "support",
    review: { purpose: "independent_expenditure", candidateCount: 1, referendumCount: 0,
      wholeReportRead: true, completeDisbursements: true, payerIdentityVerified: true, candidateElectionVerified: true },
    lines: [{ lineNumber: 1, disbursementDate: filedDate, amountCents: cents }], reportedYearToDateCents: yearToDateCents };
}
function fixture() {
  return { electionYear: 2026, asOfDate: "2026-10-26", spenderName: "Example Independent Spender",
    family: [
      { filedDate: "2026-10-12", filingType: "INDEPENDENT EXPENDITURE", organizationName: "Example Independent Spender", sourceUrl: url(second) },
      { filedDate: "2026-10-10", filingType: "INDEPENDENT EXPENDITURE", organizationName: "Example Independent Spender", sourceUrl: url(first) },
      { filedDate: "2026-08-12", filingType: "COVERED TRANSFER", organizationName: "Example Independent Spender", sourceUrl: url(transfer, "COVERED TRANSFER") },
    ], reports: [report(second, "2026-10-12", 300, 500), report(first, "2026-10-10", 200, 200)] };
}

describe("reviewed scanned CF8 transcription draft", () => {
  it("closes the whole current IE series and excludes the distinct transfer class", () => {
    const value = validateRhodeIslandReviewedCf8(fixture());
    expect(value).toMatchObject({ supportCents: 500, opposeCents: 0, occurrenceCount: 2, excludedNonIeReportCount: 1 });
    // Zero here is an internal component sum, not permission to publish a
    // candidate-wide zero or a financial snapshot.
    expect(value).not.toHaveProperty("candidateId");
    expect(value).not.toHaveProperty("sourceObservedAt");
  });
  it("preserves equal occurrences on different native lines without mutating the input", () => {
    const input = fixture();
    input.reports[1]!.lines = [{ lineNumber: 1, disbursementDate: "2026-10-10", amountCents: 100 },
      { lineNumber: 2, disbursementDate: "2026-10-10", amountCents: 100 }];
    const value = validateRhodeIslandReviewedCf8(input);
    expect(value.occurrenceCount).toBe(3);
    expect(value.supportCents).toBe(500);
    value.reports[0]!.lines[0]!.amountCents = 900;
    expect(input.reports[0]!.lines[0]!.amountCents).toBe(300);
  });
  it("handles explicit opposition without reallocating the control total", () => {
    const input = fixture(); input.reports[0]!.supportOppose = "oppose";
    expect(validateRhodeIslandReviewedCf8(input)).toMatchObject({ supportCents: 200, opposeCents: 300 });
  });
  it("holds a new unreviewed native IE report", () => {
    const input = fixture(); input.reports.pop();
    expect(() => validateRhodeIslandReviewedCf8(input)).toThrow("incomplete_current_ie_report_set");
  });
  it("holds removal/replacement rather than retaining a stale scan as current", () => {
    const input = fixture(); input.family[0]!.sourceUrl = url("00000000-0000-0000-0000-000000000004");
    expect(() => validateRhodeIslandReviewedCf8(input)).toThrow("reviewed_native_filing_binding");
  });
  it("requires explicit amendment lineage work", () => {
    const input = fixture(); input.family[0]!.organizationName += " (amended)";
    expect(() => validateRhodeIslandReviewedCf8(input)).toThrow("amendment_lineage_requires_review");
  });
  it("rejects a mixed native payer family", () => {
    const input = fixture(); input.family[0]!.organizationName = "Different Spender";
    expect(() => validateRhodeIslandReviewedCf8(input)).toThrow("mixed_native_filer_family");
  });
  it("does not upgrade a covered transfer to IE", () => {
    const input = fixture(); input.reports[0]!.sourceUrl = url(transfer, "COVERED TRANSFER"); input.reports[0]!.filingGuid = transfer;
    expect(() => validateRhodeIslandReviewedCf8(input)).toThrow("reviewed_native_filing_binding");
  });
  it("requires complete single-target review without a referendum or implicit split", () => {
    for (const change of [{ candidateCount: 2 }, { referendumCount: 1 }, { completeDisbursements: false },
      { wholeReportRead: false }, { payerIdentityVerified: false }, { candidateElectionVerified: false },
      { purpose: "electioneering_communication" }]) {
      const input = fixture(); Object.assign(input.reports[0]!.review, change);
      expect(() => validateRhodeIslandReviewedCf8(input)).toThrow("single_target_whole_report_review");
    }
  });
  it("rejects an internal gap or conflicting cumulative edition", () => {
    const input = fixture(); input.reports[0]!.reportedYearToDateCents++;
    expect(() => validateRhodeIslandReviewedCf8(input)).toThrow("ie_cumulative_control_conflict");
  });
  it("rejects an incomplete earlier IE history instead of inventing an opening balance", () => {
    const input = fixture(); input.reports[1]!.reportedYearToDateCents = 201;
    expect(() => validateRhodeIslandReviewedCf8(input)).toThrow("ie_cumulative_control_conflict");
  });
  it("does not infer the order of same-day cumulative reports from GUIDs", () => {
    const input = fixture(); input.family[0]!.filedDate = "2026-10-10"; input.reports[0]!.filedDate = "2026-10-10";
    input.reports[0]!.lines[0]!.disbursementDate = "2026-10-10";
    expect(() => validateRhodeIslandReviewedCf8(input)).toThrow("same_day_report_order_requires_review");
  });
  it("rejects duplicate report and native line identities", () => {
    const input = fixture(); input.reports[1] = structuredClone(input.reports[0]!);
    expect(() => validateRhodeIslandReviewedCf8(input)).toThrow("duplicate_reviewed_report");
    const duplicateLine = fixture(); duplicateLine.reports[0]!.lines = [duplicateLine.reports[0]!.lines[0]!, duplicateLine.reports[0]!.lines[0]!];
    expect(() => validateRhodeIslandReviewedCf8(duplicateLine)).toThrow("duplicate_or_invalid_source_line");
  });
  it("rejects duplicate native scan links", () => {
    const input = fixture(); input.family.push(structuredClone(input.family[0]!));
    expect(() => validateRhodeIslandReviewedCf8(input)).toThrow("duplicate_native_scan");
  });
  it("requires positive exact safe cents and real dates", () => {
    for (const amount of [0, -1, 0.1, Number.MAX_SAFE_INTEGER + 1, NaN]) {
      const input = fixture(); input.reports[0]!.lines[0]!.amountCents = amount;
      expect(() => validateRhodeIslandReviewedCf8(input)).toThrow("line_date_or_exact_cents");
    }
    for (const day of ["2026-02-30", "10/12/2026", "2027-01-01", "2025-12-31"]) {
      const input = fixture(); input.reports[0]!.lines[0]!.disbursementDate = day;
      expect(() => validateRhodeIslandReviewedCf8(input)).toThrow("line_date_or_exact_cents");
    }
  });
  it("rejects a bound GUID with changed hash/identity/control shape", () => {
    const input = fixture(); input.reports[0]!.sourceSha256 = "missing";
    expect(() => validateRhodeIslandReviewedCf8(input)).toThrow("whole_original_hash");
    input.reports[0]!.sourceSha256 = "a".repeat(64); input.reports[0]!.reportedCandidateName = "";
    expect(() => validateRhodeIslandReviewedCf8(input)).toThrow("single_target_whole_report_review");
  });
  it("rejects unsafe accumulated money", () => {
    const input = fixture(); input.reports[1]!.lines[0]!.amountCents = Number.MAX_SAFE_INTEGER;
    expect(() => validateRhodeIslandReviewedCf8(input)).toThrow("unsafe_cent_sum");
  });
});

describe("native CF8 scan URL binding", () => {
  it("reads the published IE class and GUID", () => {
    expect(parseRhodeIslandCf8ScanUrl(url(first))).toEqual({ filingGuid: first, filingType: "INDEPENDENT EXPENDITURE" });
  });
  it.each([
    `https://example.com/ReportsScanned/Public-INDEPENDENT%20EXPENDITURE-${first}.pdf`,
    `http://www.ricampaignfinance.com/ReportsScanned/Public-INDEPENDENT%20EXPENDITURE-${first}.pdf`,
    `${url(first)}?selector=1`, `${url(first)}#page=2`,
    "https://www.ricampaignfinance.com/ReportsScanned/invented.pdf",
  ])("rejects a non-native or modified source URL", value => {
    expect(() => parseRhodeIslandCf8ScanUrl(value)).toThrow();
  });
});
