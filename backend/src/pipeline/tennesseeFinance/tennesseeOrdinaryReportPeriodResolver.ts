import type {
  TennesseeAuthoritativeReportPeriod,
  TennesseeCurrentReportManifestRow,
} from "./tennesseeCurrentReportClient.js";

/** The acquiring factory must establish this from a complete same-CAMP manifest
 * and authoritative preceding-report interval; this is not source acceptance. */
export type TennesseeContinuingReportProof = {
  reportId: string;
  previousReportId: string;
  previousPeriodEnd: string;
  completeManifestFingerprint: string;
};
export type TennesseeOrdinaryReportPeriodContext =
  | { filerType: "candidate"; candidateElectionYear: number;
      electionSchedule: "august-primary-november-general" | "may-primary-august-general" | "november-general-only";
      participatesInAugustPrimary?: boolean; participatesInNovemberGeneral?: boolean }
  | { filerType: "pac" };
export type TennesseeOrdinaryReportPeriodInput = {
  manifestRow: TennesseeCurrentReportManifestRow;
  context: TennesseeOrdinaryReportPeriodContext;
  continuingReportProof?: TennesseeContinuingReportProof;
  isFirstReport?: boolean;
};

const ROOT = "https://www.tn.gov/content/dam/tn/tref/documents/";
const CANDIDATE_2026 = ROOT + "filing-deadlines/2026/2026%20Filing%20Dates%20Aug%20Primary%20Nov%20General.pdf";
const PAC_2026 = ROOT + "filing-deadlines/2026/2026%20PAC%20Filing%20Dates.pdf";
const PAC_2025 = ROOT + "filing-deadlines/2025/2025%20PAC%20Filing%20Dates.pdf";
const CANDIDATE_EARLY_INSTRUCTIONS = "https://www.tn.gov/tref/tref-candidates/tref-candidate-faqs.html";
const CANDIDATE_SUPPLEMENTAL: Record<number, string> = {
  2024: ROOT + "2024-filing-deadlines/2024%20Open%20Candidate%20Campaign%20Filing%20Dates.pdf",
  2025: ROOT + "filing-deadlines/2025/2025%20Open%20Candidate%20Campaign%20Filing%20Dates.pdf",
};
function canonicalId(value: string): boolean {
  return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
}
function previousDay(date: string): string {
  return new Date(Date.parse(date + "T00:00:00Z") - 86_400_000).toISOString().slice(0, 10);
}
function canonicalReportUrl(row: TennesseeCurrentReportManifestRow): boolean {
  return row.sourceUrl === "https://apps.tn.gov/tncamp/search/pub/report_full.htm?reportId=" + row.reportId;
}

/** Resolve only reviewed ordinary calendars with explicit source context.
 * Unknown/initial periods stay unavailable. This never selects an amendment,
 * proves completeness, assigns a beneficiary, or accepts a monetary snapshot. */
function qualifiedCalendarPeriod(
  input: Pick<TennesseeOrdinaryReportPeriodInput, "manifestRow" | "context">,
): TennesseeAuthoritativeReportPeriod | null {
  const { manifestRow: row, context } = input;
  if (!canonicalId(row.campId) || !canonicalId(row.reportId) || !canonicalReportUrl(row)) return null;
  if (context.filerType === "candidate" &&
      (context.candidateElectionYear !== 2026 || row.electionYear !== context.candidateElectionYear ||
       context.electionSchedule !== "august-primary-november-general")) return null;
  if (context.filerType !== "candidate" && context.filerType !== "pac") return null;
  let start: string, end: string, sourceUrl: string, qualification: string;
  const early = /^(Early Mid Year Supplemental|Early Year End Supplemental) (2024|2025)$/.exec(row.reportName);
  const pacSupplement = /^(Annual Mid Year Supplemental|Annual Year End Supplemental) (2025)$/.exec(row.reportName);
  const ordinary = /^(1st Quarter|2nd Quarter|Pre-Primary|3rd Quarter|Pre-General|4th Quarter) (2026)$/.exec(row.reportName);
  if (early) {
    if (context.filerType !== "candidate" || row.reportYear !== Number(early[2])) return null;
    const year = Number(early[2]);
    const mid = early[1] === "Early Mid Year Supplemental";
    start = year + (mid ? "-01-16" : "-07-01");
    end = (mid ? year + "-06-30" : (year + 1) + "-01-15");
    sourceUrl = CANDIDATE_SUPPLEMENTAL[year];
    qualification = "Prospective 2026 candidate Early supplemental; coverage calendar joined with Early instructions " +
      CANDIDATE_EARLY_INSTRUCTIONS + " question 8; filing due dates are not equated";
  } else if (pacSupplement) {
    if (context.filerType !== "pac" || row.reportYear !== 2025) return null;
    const mid = pacSupplement[1] === "Annual Mid Year Supplemental";
    start = mid ? "2025-01-16" : "2025-07-01";
    end = mid ? "2025-06-30" : "2026-01-15";
    sourceUrl = PAC_2025;
    qualification = "Registered PAC ordinary non-election-year semiannual schedule";
  } else if (ordinary && row.reportYear === 2026) {
    const kind = ordinary[1];
    if (context.filerType === "candidate") {
      if ((kind === "Pre-Primary" || kind === "3rd Quarter") &&
          context.participatesInAugustPrimary !== true) return null;
      if (kind === "Pre-General" && context.participatesInNovemberGeneral !== true) return null;
      if (kind === "4th Quarter" && typeof context.participatesInNovemberGeneral !== "boolean") return null;
    }
    const periods: Record<string, [string, string]> = {
      "1st Quarter": ["2026-01-16", "2026-03-31"],
      "2nd Quarter": ["2026-04-01", "2026-06-30"],
      "Pre-Primary": ["2026-07-01", "2026-07-27"],
      "3rd Quarter": ["2026-07-28", "2026-09-30"],
      "Pre-General": ["2026-10-01", "2026-10-24"],
      "4th Quarter": [
        context.filerType === "candidate" && !context.participatesInNovemberGeneral ? "2026-10-01" : "2026-10-25",
        "2027-01-15"],
    };
    [start, end] = periods[kind];
    sourceUrl = context.filerType === "pac" ? PAC_2026 : CANDIDATE_2026;
    qualification = context.filerType === "pac" ? "Registered PAC ordinary 2026 state-election schedule" :
      "2026 state candidate August 6 primary / November 3 general schedule; " +
      (kind === "4th Quarter" ? "November participation=" + context.participatesInNovemberGeneral :
       kind === "Pre-Primary" || kind === "3rd Quarter" ? "proven August participation" :
       kind === "Pre-General" ? "proven November participation" : "candidate calendar; initial starting date requires separate proof");
  } else return null;
  return { start, end, sourceUrl, sourceContext: qualification };
}

export type TennesseeOrdinaryReportPeriodEnd = Pick<TennesseeAuthoritativeReportPeriod, "end" | "sourceUrl" | "sourceContext">;

/** An official endpoint remains known for a first report whose start is unknown.
 * Endpoint evidence alone cannot accept a whole interval, unitemized cash or IE. */
export function resolveTennesseeOrdinaryReportPeriodEnd(
  input: Pick<TennesseeOrdinaryReportPeriodInput, "manifestRow" | "context">,
): TennesseeOrdinaryReportPeriodEnd | null {
  const period = qualifiedCalendarPeriod(input);
  return period ? { end: period.end, sourceUrl: period.sourceUrl,
    sourceContext: period.sourceContext + "; calendar endpoint only; first-report start unresolved; no full-interval acceptance" } : null;
}

/** Full intervals require per-report proof from a complete same-CAMP manifest and
 * the distinct immediately preceding ordinary period, not a generic account flag. */
export function resolveTennesseeOrdinaryReportPeriod(
  input: TennesseeOrdinaryReportPeriodInput,
): TennesseeAuthoritativeReportPeriod | null {
  const { manifestRow: row, continuingReportProof: proof } = input;
  if (input.isFirstReport || !proof || proof.reportId !== row.reportId ||
      !canonicalId(proof.previousReportId) || proof.previousReportId === row.reportId ||
      !/^[a-f0-9]{64}$/.test(proof.completeManifestFingerprint)) return null;
  const period = qualifiedCalendarPeriod(input);
  if (!period || proof.previousPeriodEnd !== previousDay(period.start)) return null;
  return { ...period, sourceContext: period.sourceContext +
    "; same-CAMP " + row.campId + " per-report continuity " + proof.previousReportId + " through " +
    proof.previousPeriodEnd + " -> " + row.reportId + "; complete manifest SHA256 " + proof.completeManifestFingerprint };
}
