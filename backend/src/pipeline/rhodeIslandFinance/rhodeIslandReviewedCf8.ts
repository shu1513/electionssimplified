import { isDeepStrictEqual } from "node:util";

/** Operator-reviewed scanned CF-8s. This validates a transcription, not the
 * scan's contents or a canonical candidate mapping. Only the cache-backed
 * source loader may mint the packet accepted by the financial writer.
 *
 * Amounts are reported covered disbursements: IE is made on first public
 * dissemination. Covered transfers and donations never enter this component.
 */
export type RhodeIslandReviewedCf8Line = {
  lineNumber: number;
  disbursementDate: string;
  amountCents: number;
};
export type RhodeIslandReviewedCf8Report = {
  filingGuid: string;
  sourceUrl: string;
  sourceSha256: string;
  filedDate: string;
  reportedSpenderName: string;
  reportedCandidateName: string;
  supportOppose: "support" | "oppose";
  review: {
    purpose: "independent_expenditure";
    candidateCount: 1;
    referendumCount: 0;
    wholeReportRead: true;
    completeDisbursements: true;
    payerIdentityVerified: true;
    candidateElectionVerified: true;
  };
  lines: readonly RhodeIslandReviewedCf8Line[];
  /** Component control, never another expenditure or an amount to allocate. */
  reportedYearToDateCents: number;
};
export type RhodeIslandCf8FamilyRow = {
  filedDate: string;
  filingType: string;
  organizationName: string;
  sourceUrl: string;
};
export type RhodeIslandReviewedCf8Draft = {
  electionYear: number;
  spenderName: string;
  reports: readonly RhodeIslandReviewedCf8Report[];
  excludedNonIeReportCount: number;
  occurrenceCount: number;
  supportCents: number;
  opposeCents: number;
};

const GUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const NON_IE_CLASSES = new Set([
  "COVERED TRANSFER", "ELECTIONEERING COMMUNICATION", "BALLOT QUESTION ADVOCACY", "REFERENDUM",
]);
const NAME = (s: string) => s.trim().replace(/\s+/gu, " ").toUpperCase();
const REVIEW = {
  purpose: "independent_expenditure", candidateCount: 1, referendumCount: 0,
  wholeReportRead: true, completeDisbursements: true, payerIdentityVerified: true,
  candidateElectionVerified: true,
} as const;
function check(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Rhode Island reviewed CF8: ${reason}`);
}
function text(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= 500 && !/[\x00-\x1f\x7f]/u.test(value);
}
function date(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}
function positiveCents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function add(a: number, b: number): number {
  const result = a + b;
  check(Number.isSafeInteger(result), "unsafe_cent_sum");
  return result;
}

/** The exact published scan path binds native class and GUID. Never accept a
 * generic PDF, an invented selector, a fragment, or a redirect destination.
 */
export function parseRhodeIslandCf8ScanUrl(value: string): { filingGuid: string; filingType: string } {
  const url = new URL(value);
  check(url.protocol === "https:" && /^(www\.|secure\.)?ricampaignfinance\.com$/u.test(url.hostname) &&
    !url.username && !url.password && !url.port && !url.search && !url.hash, "scan_origin_or_selector");
  const match = new RegExp(`^/ReportsScanned/Public-([A-Z ]+)-(${GUID})\\.pdf$`, "u").exec(decodeURIComponent(url.pathname));
  check(match, "scan_native_path");
  return { filingType: match[1]!, filingGuid: match[2]! };
}

/** Complete one current native filer family before validating its IE subset.
 * v1 deliberately rejects amendment labels rather than guessing parentage.
 * This is a draft only: no source/currentness/candidate authority is minted.
 */
export function validateRhodeIslandReviewedCf8(input: {
  electionYear: number;
  spenderName: string;
  asOfDate: string;
  family: readonly RhodeIslandCf8FamilyRow[];
  reports: readonly RhodeIslandReviewedCf8Report[];
}): RhodeIslandReviewedCf8Draft {
  check(Number.isInteger(input.electionYear) && input.electionYear >= 2000 && input.electionYear <= 2100 &&
    input.electionYear % 2 === 0 && date(input.asOfDate) &&
    input.asOfDate >= `${input.electionYear - 1}-01-01` && input.asOfDate <= `${input.electionYear}-12-31`, "cycle_or_observation_date");
  check(text(input.spenderName) && !/\(amended\)\s*$/iu.test(input.spenderName), "spender_identity");
  check(Array.isArray(input.family) && input.family.length > 0 && input.family.length <= 100 &&
    Array.isArray(input.reports) && input.reports.length > 0 && input.reports.length <= 100, "complete_nonempty_family");
  const native = new Map<string, RhodeIslandCf8FamilyRow>();
  for (const row of input.family) {
    check(text(row.organizationName) && !/\(amended\)\s*$/iu.test(row.organizationName), "amendment_lineage_requires_review");
    check(NAME(row.organizationName) === NAME(input.spenderName), "mixed_native_filer_family");
    check(date(row.filedDate) && row.filedDate >= `${input.electionYear - 1}-01-01` && row.filedDate <= input.asOfDate,
      "native_filing_date");
    const scan = parseRhodeIslandCf8ScanUrl(row.sourceUrl);
    check(scan.filingType === row.filingType && (row.filingType === "INDEPENDENT EXPENDITURE" ||
      NON_IE_CLASSES.has(row.filingType)), "native_class_binding");
    check(!native.has(scan.filingGuid), "duplicate_native_scan");
    native.set(scan.filingGuid, row);
  }
  const expected = [...native.entries()].filter(([, r]) => r.filingType === "INDEPENDENT EXPENDITURE");
  check(expected.length === input.reports.length, "incomplete_current_ie_report_set");
  const seen = new Set<string>();
  let supportCents = 0, opposeCents = 0, occurrenceCount = 0;
  const reports: RhodeIslandReviewedCf8Report[] = input.reports.map((report: RhodeIslandReviewedCf8Report) => {
    check(report && typeof report === "object" && new RegExp(`^${GUID}$`, "u").test(report.filingGuid), "reviewed_filing_guid");
    const row = native.get(report.filingGuid);
    const scan = parseRhodeIslandCf8ScanUrl(report.sourceUrl);
    check(row && row.filingType === "INDEPENDENT EXPENDITURE" && scan.filingGuid === report.filingGuid &&
      scan.filingType === row.filingType && row.sourceUrl === report.sourceUrl && row.filedDate === report.filedDate,
      "reviewed_native_filing_binding");
    check(!seen.has(report.filingGuid), "duplicate_reviewed_report");
    seen.add(report.filingGuid);
    check(/^[0-9a-f]{64}$/u.test(report.sourceSha256), "whole_original_hash");
    check(text(report.reportedSpenderName) && text(report.reportedCandidateName) &&
      (report.supportOppose === "support" || report.supportOppose === "oppose") &&
      isDeepStrictEqual(report.review, REVIEW), "single_target_whole_report_review");
    // Body spelling variants require explicit source-loader identity review;
    // normalizing a label here must never merge legal payer accounts.
    check(positiveCents(report.reportedYearToDateCents) && Array.isArray(report.lines) &&
      report.lines.length > 0 && report.lines.length <= 1000, "report_money_controls");
    const lineNumbers = new Set<number>();
    const lines = report.lines.map((line: RhodeIslandReviewedCf8Line) => {
      check(Number.isSafeInteger(line.lineNumber) && line.lineNumber >= 1 && line.lineNumber <= 10000 &&
        !lineNumbers.has(line.lineNumber), "duplicate_or_invalid_source_line");
      lineNumbers.add(line.lineNumber);
      check(date(line.disbursementDate) && line.disbursementDate >= `${input.electionYear}-01-01` &&
        line.disbursementDate <= report.filedDate && positiveCents(line.amountCents), "line_date_or_exact_cents");
      if (report.supportOppose === "support") supportCents = add(supportCents, line.amountCents);
      else opposeCents = add(opposeCents, line.amountCents);
      occurrenceCount++;
      return { lineNumber: line.lineNumber, disbursementDate: line.disbursementDate, amountCents: line.amountCents };
    });
    return { ...report, review: { ...report.review }, lines };
  });
  check(expected.every(([guid]) => seen.has(guid)), "incomplete_current_ie_report_set");
  // Controls belong to the reviewed IE series, not the transfer/donation
  // tables. Incomplete histories, duplicate editions and conflicting YTDs
  // cannot silently become a replacement snapshot.
  let cumulative = 0;
  const chronological = [...reports].sort((a, b) => a.filedDate.localeCompare(b.filedDate) || a.filingGuid.localeCompare(b.filingGuid));
  for (let i = 0; i < chronological.length; i++) {
    const report = chronological[i]!;
    check(i === 0 || report.filedDate !== chronological[i - 1]!.filedDate, "same_day_report_order_requires_review");
    cumulative = report.lines.reduce((sum, line) => add(sum, line.amountCents), cumulative);
    check(cumulative === report.reportedYearToDateCents, "ie_cumulative_control_conflict");
  }
  return { electionYear: input.electionYear, spenderName: input.spenderName, reports,
    excludedNonIeReportCount: native.size - expected.length, occurrenceCount, supportCents, opposeCents };
}
