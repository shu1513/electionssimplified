import { personNamesMatchWithMiddleEvidence } from "../finance/personNameMiddleEvidence.js";
import { normalizeMissouriMecPoliticalDistrict, normalizeMissouriMecText } from "./missouriFinanceEligibleOffices.js";
import type { MissouriMecOutsideSpendingRow } from "./missouriMecParsers.js";

export type MissouriReportedRegisteredIeGroup = {
  reportedCommitteeName: string;
  reportedNameKey: string;
  reportedCommitteeId?: string | null;
  supportOppose: "support" | "oppose";
  amountCents: number;
  expenditureCount: number;
};
export type MissouriReportedRegisteredIeDiagnostics = {
  sourceRowCount: number;
  candidateNameRowCount: number;
  candidateOfficeMismatchRowCount: number;
  outsideCycleRowCount: number;
  matchedRowCount: number;
  zeroAmountRowCount: number;
  includedExpenditureRowCount: number;
  negativeAmountRowCount: number;
  ambiguousLineageRowCount: number;
  timelyOverlapRowCount: number;
};
export type MissouriReportedRegisteredIeHoldReason = "invalid_cycle" | "invalid_target" | "invalid_source_row" |
  "negative_eligible_adjustment" | "unresolved_report_lineage" | "timely_overlap_unresolved" | "unsafe_cent_total";
export type MissouriReportedRegisteredIeAggregation = MissouriReportedRegisteredIeDiagnostics & (
  | { status: "qualified"; groups: MissouriReportedRegisteredIeGroup[]; supportAmountCents: number; opposeAmountCents: number }
  | { status: "held"; reason: MissouriReportedRegisteredIeHoldReason }
);
const clean = (value: string) => value.normalize("NFC").trim().replace(/\s+/gu, " ");
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
function isoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
function validRow(value: unknown): value is MissouriMecOutsideSpendingRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return text(row.candidateNameAndAddress) && text(row.officeSought) && text(row.reportingCommittee) && text(row.report) &&
    (row.supportOppose === "Support" || row.supportOppose === "Oppose") && isoDate(row.expenditureDate) && Number.isSafeInteger(row.amountCents);
}

// Keep the established bounded name/middle-evidence and office/district matching
// local to this new component; the legacy aggregator's off-gate behavior is unchanged.
function candidateNameMatches(candidateName: string, sourceNameAndAddress: string): boolean {
  const candidateTokens = normalizeMissouriMecText(candidateName).split(" ").filter(Boolean);
  const sourceTokens = normalizeMissouriMecText(sourceNameAndAddress).split(" ").filter(Boolean);
  if (candidateTokens.length < 2 || sourceTokens.length < candidateTokens.length) return false;

  // MEC concatenates candidate name and street address without a delimiter.
  // A numeric address token is the only source-proven boundary. Try the
  // bounded name prefixes before it; never scan the address for a fuzzy hit.
  const firstNumeric = sourceTokens.findIndex((token) => /\d/.test(token));
  const upperBound = Math.min(
    firstNumeric >= 2 ? firstNumeric : candidateTokens.length + 2,
    candidateTokens.length + 2,
    sourceTokens.length
  );
  const rowNames: string[] = [];
  for (let length = 2; length <= upperBound; length += 1) {
    rowNames.push(sourceTokens.slice(0, length).join(" "));
  }
  return personNamesMatchWithMiddleEvidence({
    candidateName,
    rowNames,
    normalizePersonName: normalizeMissouriMecText,
  });
}

function expectedOfficeTerms(officeName: string): readonly string[] {
  switch (officeName) {
    case "State Auditor": return ["STATE AUDITOR", "MISSOURI AUDITOR"];
    case "Collector of Revenue": return ["COLLECTOR OF REVENUE", "COUNTY COLLECTOR"];
    case "County Assessor": return ["ASSESSOR"];
    case "County Auditor": return ["AUDITOR"];
    case "County Clerk": return ["COUNTY CLERK"];
    case "County Clerk and Recorder": return ["CIRCUIT CLERK AND RECORDER OF DEEDS", "CIRCUIT CLERK"];
    case "County Commissioner": return ["COMMISSIONER", "COMMISIONER", "COMMISSIER"];
    case "County Executive": return ["COUNTY EXECUTIVE", "COUNTY EXEC"];
    case "County Level Judge": return ["CIRCUIT JUDGE"];
    case "County Recorder":
    case "Recorder of Deeds": return ["RECORDER OF DEEDS", "COUNTY RECORDER"];
    case "County Supervisor": return ["COUNTY COUNCIL", "COUNTY LEGISLATURE", "COUNTY LEGISLATOR"];
    case "County Treasurer": return ["TREASURER"];
    case "District Attorney": return ["PROSECUTING ATTORNEY", "PROSECUTOR"];
    case "License Collector": return ["LICENSE COLLECTOR"];
    case "Sheriff": return ["SHERIFF"];
    case "City Council Member": return ["COUNCIL", "ALDERMAN", "ALDERPERSON", "ALDERWOMAN"];
    case "City Treasurer": return ["TREASURER"];
    case "Mayor": return ["MAYOR"];
    case "Municipal Assessor": return ["ASSESSOR"];
    case "Place Level Judge": return ["MUNICIPAL JUDGE"];
    case "School Board Member": return ["SCHOOL BOARD", "BOARDMEMBER", "BOARD MEMBER", "SCHOOL DIRECTOR"];
    default: return [];
  }
}

function legislativeFamilyMatches(officeName: string, source: string): boolean {
  if (/\b(?:US|U S|CONGRESS|CONGRESSIONAL)\b/.test(source)) return false;
  if (officeName === "State Lower Chamber Legislator") {
    return /\bSTATE REP(?:RESENTATIVE)?\b|\bMISSOURI HOUSE\b|\bMO HOUSE\b|\bMO STATE (?:HOUSE|REP)\b|\bST REP\b|\bHD ?\d+\b|^HOUSE ?\d|^HOUSE (?:OF )?REP(?:RESENTATIVE|RESENTATIVES)?\b|^MO \d+ REPRESENTATIVE\b/.test(source);
  }
  if (officeName === "State Senator") {
    return /\bSTATE SENAT(?:E|OR)\b|\bMISSOURI SENATE\b|\bMO SENATE\b|\bST SENATE\b|\bSD ?\d+\b|^SENATE(?: |$)/.test(source);
  }
  return false;
}

function sourceLegislativeDistrict(officeName: string, source: string): string | null {
  const generic = normalizeMissouriMecPoliticalDistrict(source);
  if (generic) return generic;
  const patterns = officeName === "State Lower Chamber Legislator"
    ? [
        /\bHD ?0*(\d+)\b/,
        /\bHOUSE ?0*(\d+)\b/,
        /\bMO 0*(\d+) REPRESENTATIVE\b/,
        /\bREPRESENTATIVES? 0*(\d+)(?:ST|ND|RD|TH)?\b/,
      ]
    : [
        /\bSD ?0*(\d+)\b/,
        /\bSENATE 0*(\d+)\b/,
        /\bSENATOR 0*(\d+) DISTRICT\b/,
      ];
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (match?.[1]) return `DISTRICT ${Number.parseInt(match[1], 10)}`;
  }
  return null;
}

function officeMatches(input: { officeName: string; district: string | null | undefined; sourceOffice: string }): boolean {
  const source = normalizeMissouriMecText(input.sourceOffice);
  const isLegislative = input.officeName === "State Lower Chamber Legislator" || input.officeName === "State Senator";
  if (isLegislative) {
    if (!legislativeFamilyMatches(input.officeName, source)) return false;
  } else {
    const terms = expectedOfficeTerms(input.officeName);
    if (terms.length === 0 || !terms.some((term) => source.includes(term))) return false;
  }
  const expectedDistrict = normalizeMissouriMecPoliticalDistrict(`District ${input.district ?? ""}`);
  const sourceDistrict = isLegislative
    ? sourceLegislativeDistrict(input.officeName, source)
    : normalizeMissouriMecPoliticalDistrict(source);
  return expectedDistrict === null || sourceDistrict === null || expectedDistrict === sourceDistrict;
}

function timely(report: string): boolean { return /\b(?:24|48)\s*-?\s*HOUR\b|\bTIMELY\b/i.test(report); }

/** Uncapped reported-name expenditures from the qualified registered-committee
 * publication. No MECID lookup is needed for this source's monetary claim.
 * The caller independently qualifies the whole annual source and cycle boundary.
 * Native occurrences remain occurrences, including equal repeated expenditures.
 */
export function aggregateMissouriReportedRegisteredIe(input: {
  rows: readonly MissouriMecOutsideSpendingRow[];
  candidateName: string;
  officeName: string;
  district?: string | null;
  cycleStart: string;
  cycleEnd: string;
}): MissouriReportedRegisteredIeAggregation {
  const diagnostics: MissouriReportedRegisteredIeDiagnostics = {
    sourceRowCount: Array.isArray(input.rows) ? input.rows.length : 0,
    candidateNameRowCount: 0, candidateOfficeMismatchRowCount: 0, outsideCycleRowCount: 0, matchedRowCount: 0,
    zeroAmountRowCount: 0, includedExpenditureRowCount: 0, negativeAmountRowCount: 0,
    ambiguousLineageRowCount: 0, timelyOverlapRowCount: 0,
  };
  const held = (reason: MissouriReportedRegisteredIeHoldReason): MissouriReportedRegisteredIeAggregation =>
    ({ ...diagnostics, status: "held", reason });
  if (!isoDate(input.cycleStart) || !isoDate(input.cycleEnd) || input.cycleStart > input.cycleEnd) return held("invalid_cycle");
  if (!text(input.candidateName) || normalizeMissouriMecText(input.candidateName).split(" ").filter(Boolean).length < 2 ||
    !text(input.officeName) || (input.district !== undefined && input.district !== null && typeof input.district !== "string")) return held("invalid_target");
  const officeName = clean(input.officeName);
  if (officeName !== "State Lower Chamber Legislator" && officeName !== "State Senator" && expectedOfficeTerms(officeName).length === 0) return held("invalid_target");
  if (!Array.isArray(input.rows) || !input.rows.every(validRow)) return held("invalid_source_row");
  const matched: MissouriMecOutsideSpendingRow[] = [];
  const sameOffice: MissouriMecOutsideSpendingRow[] = [];
  for (const row of input.rows) {
    if (!candidateNameMatches(input.candidateName, row.candidateNameAndAddress)) continue;
    diagnostics.candidateNameRowCount++;
    if (!officeMatches({ officeName, district: input.district, sourceOffice: row.officeSought })) {
      diagnostics.candidateOfficeMismatchRowCount++; continue;
    }
    sameOffice.push(row);
    if (row.expenditureDate < input.cycleStart || row.expenditureDate > input.cycleEnd) {
      diagnostics.outsideCycleRowCount++; continue;
    }
    diagnostics.matchedRowCount++; matched.push(row);
    if (row.amountCents < 0) diagnostics.negativeAmountRowCount++;
    else if (row.amountCents === 0) diagnostics.zeroAmountRowCount++;
  }
  if (diagnostics.negativeAmountRowCount > 0) return held("negative_eligible_adjustment");
  const bySpender = new Map<string, MissouriMecOutsideSpendingRow[]>();
  const relevantSpenders = new Set(matched.map(row => clean(row.reportingCommittee).toUpperCase()));
  for (const row of sameOffice) {
    const key = clean(row.reportingCommittee).toUpperCase();
    if (!relevantSpenders.has(key)) continue;
    const list = bySpender.get(key) ?? []; list.push(row); bySpender.set(key, list);
  }
  for (const rows of bySpender.values()) {
    const inWindow = rows.filter(row => row.expenditureDate >= input.cycleStart && row.expenditureDate <= input.cycleEnd);
    const relevantBases = new Set(inWindow.map(row => clean(row.report).toUpperCase().replace(/^AMENDED\s+/, "")));
    const versions = new Map<string, Set<string>>();
    let invalidVersion = false;
    for (const row of rows) {
      const report = clean(row.report).toUpperCase();
      // A sole native AMENDED caption is one visible version, not an invented
      // latest filing. Multiple visible versions of its base are unresolved.
      const amended = /^AMENDED\s+/.test(report), base = report.replace(/^AMENDED\s+/, "");
      if (relevantBases.has(base) && (/\bAMEND(?:ED|MENT|MENTS)?\b|\bCORRECTED\b|\bSUPERSEDED\b/.test(base) ||
        (!amended && /\bAMEND(?:ED|MENT|MENTS)?\b/.test(report)))) invalidVersion = true;
      const labels = versions.get(base) ?? new Set<string>(); labels.add(report); versions.set(base, labels);
    }
    const reportsByDate = new Map<string, Set<string>>();
    for (const row of inWindow) {
      const report = clean(row.report).toUpperCase();
      if (timely(report)) continue; // Timely/periodic uncertainty is counted separately below.
      const labels = reportsByDate.get(row.expenditureDate) ?? new Set<string>();
      labels.add(report); reportsByDate.set(row.expenditureDate, labels);
    }
    // Distinct periodic reports on the same spender/date can restate an expense;
    // amount or stance changes do not prove separate events. Never guess splits.
    if (invalidVersion || [...versions].some(([base, labels]) => relevantBases.has(base) && labels.size > 1) ||
      [...reportsByDate.values()].some(labels => labels.size > 1)) diagnostics.ambiguousLineageRowCount += inWindow.length;
    const reports = new Set(inWindow.map(row => clean(row.report).toUpperCase()));
    if (reports.size > 1 && [...reports].some(timely)) diagnostics.timelyOverlapRowCount += inWindow.length;
  }
  if (diagnostics.ambiguousLineageRowCount > 0) return held("unresolved_report_lineage");
  if (diagnostics.timelyOverlapRowCount > 0) return held("timely_overlap_unresolved");
  const groups = new Map<string, MissouriReportedRegisteredIeGroup>();
  let supportAmountCents = 0, opposeAmountCents = 0;
  for (const row of matched) {
    if (row.amountCents === 0) continue;
    const name = clean(row.reportingCommittee), key = name.toUpperCase(), stance = row.supportOppose === "Support" ? "support" : "oppose";
    const groupKey = `${key}\u0000${stance}`, old = groups.get(groupKey);
    const amount = (old?.amountCents ?? 0) + row.amountCents;
    const total = (stance === "support" ? supportAmountCents : opposeAmountCents) + row.amountCents;
    if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(total) || !Number.isSafeInteger(supportAmountCents + opposeAmountCents + row.amountCents)) return held("unsafe_cent_total");
    groups.set(groupKey, { reportedCommitteeName: old?.reportedCommitteeName ?? name, reportedNameKey: key,
      supportOppose: stance, amountCents: amount, expenditureCount: (old?.expenditureCount ?? 0) + 1 });
    if (stance === "support") supportAmountCents = total; else opposeAmountCents = total;
    diagnostics.includedExpenditureRowCount++;
  }
  return { ...diagnostics, status: "qualified", supportAmountCents, opposeAmountCents,
    groups: [...groups.values()].sort((a,b) => b.amountCents-a.amountCents || a.reportedNameKey.localeCompare(b.reportedNameKey) || a.supportOppose.localeCompare(b.supportOppose)) };
}
