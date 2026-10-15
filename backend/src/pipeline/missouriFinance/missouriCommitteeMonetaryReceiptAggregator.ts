import {
  normalizeMissouriMecReportLineage,
  type MissouriMecContributionRow,
  type MissouriMecReportInventoryRow,
} from "./missouriMecParsers.js";
import { selectMissouriCanonicalReportRows, type MissouriReportSelectionDiagnostic } from "./missouriReportInventory.js";

export type MissouriCommitteeMonetaryReceiptHoldReason =
  | "invalid_cycle"
  | "invalid_source_row"
  | "invalid_report_inventory"
  | "unresolved_receipt_lineage"
  | "unknown_eligible_kind"
  | "negative_eligible_adjustment"
  | "unsafe_cent_total";

export type MissouriCommitteeMonetaryReceiptDiagnostics = {
  sourceRowCount: number;
  inCycleRowCount: number;
  outsideCycleRowCount: number;
  canonicalRowCount: number;
  matchedCommitteeRowCount: number;
  excludedNonCommitteeRowCount: number;
  inKindRowCount: number;
  zeroMonetaryRowCount: number;
  includedReceiptRowCount: number;
  relevantUnresolvedLineageCount: number;
  excludedLineageRowCount: number;
  excludedLineageAmountCents: number;
  lineageDiagnosticCodes: MissouriReportSelectionDiagnostic["reason"][];
};

export type MissouriReportedCommitteeMonetaryReceipts = {
  reportedCommitteeName: string;
  reportedNameKey: string;
  amountCents: number;
  receiptCount: number;
};

export type MissouriCommitteeMonetaryReceiptAggregation = MissouriCommitteeMonetaryReceiptDiagnostics & (
  | { status: "qualified"; committees: MissouriReportedCommitteeMonetaryReceipts[]; totalAmountCents: number }
  | { status: "held"; reason: MissouriCommitteeMonetaryReceiptHoldReason }
);

const clean = (value: string) => value.normalize("NFC").trim().replace(/\s+/gu, " ");
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && !/[\u0000-\u001f\u007f]/u.test(value);
const nonempty = (value: unknown): value is string => text(value) && value.trim().length > 0;
const nullableText = (value: unknown) => value === null || text(value);
function isoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validReceipt(value: unknown): value is MissouriMecContributionRow {
  return record(value) && typeof value.mecid === "string" && /^[A-Z]\d{6}$/.test(value.mecid) &&
    nonempty(value.committeeName) && nonempty(value.report) && nonempty(value.contributionKind) &&
    ["contributorCommittee", "contributorCompany", "contributorLastName", "contributorFirstName", "employer", "occupation"]
      .every((key) => nullableText(value[key])) &&
    isoDate(value.contributionDate) && Number.isSafeInteger(value.amountCents);
}
function validReport(value: unknown): value is MissouriMecReportInventoryRow {
  return record(value) && typeof value.reportId === "string" && /^\d+$/.test(value.reportId) &&
    nonempty(value.report) && isoDate(value.dateFiled) && typeof value.isAmended === "boolean" &&
    value.isAmended === /^AMENDED\s+/i.test(value.report.trim()) &&
    value.lineageKey === normalizeMissouriMecReportLineage(value.report);
}
function fingerprint(row: MissouriMecContributionRow): string {
  return JSON.stringify([row.mecid, row.committeeName, row.contributorCommittee, row.contributorCompany,
    row.contributorLastName, row.contributorFirstName, row.employer, row.occupation,
    row.contributionDate, row.amountCents, row.contributionKind]);
}

/** Gross itemized Monetary receipts explicitly reported in Contributor-Committee.
 * This does not establish legal PAC identity, exclude loans, or subtract later
 * separately reported returns. Equal source occurrences remain separate receipts.
 * Zero Monetary rows are counted separately, without inflating positive groups.
 * The caller must independently qualify the complete source capture; this pure
 * aggregation result does not grant acquisition or publication authority.
 */
export function aggregateMissouriCommitteeMonetaryReceipts(input: {
  inventory: readonly MissouriMecReportInventoryRow[];
  contributionRows: readonly MissouriMecContributionRow[];
  cycleStart: string;
  cycleEnd: string;
}): MissouriCommitteeMonetaryReceiptAggregation {
  const diagnostics: MissouriCommitteeMonetaryReceiptDiagnostics = {
    sourceRowCount: Array.isArray(input.contributionRows) ? input.contributionRows.length : 0,
    inCycleRowCount: 0, outsideCycleRowCount: 0, canonicalRowCount: 0,
    matchedCommitteeRowCount: 0, excludedNonCommitteeRowCount: 0, inKindRowCount: 0,
    zeroMonetaryRowCount: 0, includedReceiptRowCount: 0, relevantUnresolvedLineageCount: 0,
    excludedLineageRowCount: 0, excludedLineageAmountCents: 0, lineageDiagnosticCodes: [],
  };
  const held = (reason: MissouriCommitteeMonetaryReceiptHoldReason): MissouriCommitteeMonetaryReceiptAggregation =>
    ({ ...diagnostics, status: "held", reason });
  if (!isoDate(input.cycleStart) || !isoDate(input.cycleEnd) || input.cycleStart > input.cycleEnd) return held("invalid_cycle");
  // Validate the complete source representation before any cycle/class filter.
  if (!Array.isArray(input.contributionRows) || !input.contributionRows.every(validReceipt) ||
    new Set(input.contributionRows.map((row) => row.mecid)).size > 1) return held("invalid_source_row");
  if (!Array.isArray(input.inventory) || input.inventory.length === 0 || !input.inventory.every(validReport)) {
    return held("invalid_report_inventory");
  }
  const inCycle = input.contributionRows.filter((row) => row.contributionDate >= input.cycleStart && row.contributionDate <= input.cycleEnd);
  diagnostics.inCycleRowCount = inCycle.length;
  diagnostics.outsideCycleRowCount = input.contributionRows.length - inCycle.length;
  const committeeLineages = new Set(inCycle.filter((row) => clean(row.contributorCommittee ?? "") !== "" &&
    clean(row.contributionKind).toUpperCase() !== "IN-KIND")
    .map((row) => normalizeMissouriMecReportLineage(row.report)));
  const selected = selectMissouriCanonicalReportRows({ inventory: input.inventory, rows: inCycle,
    reportName: (row) => row.report, amountCents: (row) => row.amountCents, safeFingerprint: fingerprint });
  const relevant = selected.diagnostics.filter((diagnostic) => committeeLineages.has(diagnostic.lineageKey));
  diagnostics.canonicalRowCount = selected.rows.length;
  diagnostics.relevantUnresolvedLineageCount = relevant.length;
  diagnostics.lineageDiagnosticCodes = [...new Set(relevant.map((diagnostic) => diagnostic.reason))].sort();
  for (const diagnostic of relevant) {
    const next = diagnostics.excludedLineageAmountCents + diagnostic.excludedAmountCents;
    if (!Number.isSafeInteger(diagnostic.excludedAmountCents) || !Number.isSafeInteger(next)) return held("unsafe_cent_total");
    diagnostics.excludedLineageAmountCents = next;
    diagnostics.excludedLineageRowCount += diagnostic.excludedRowCount;
  }
  if (relevant.length > 0) return held("unresolved_receipt_lineage");

  const committees = new Map<string, MissouriReportedCommitteeMonetaryReceipts>();
  let totalAmountCents = 0;
  for (const row of selected.rows) {
    const name = clean(row.contributorCommittee ?? "");
    if (!name) { diagnostics.excludedNonCommitteeRowCount += 1; continue; }
    diagnostics.matchedCommitteeRowCount += 1;
    const kind = clean(row.contributionKind).toUpperCase();
    if (kind === "IN-KIND") { diagnostics.inKindRowCount += 1; continue; }
    if (kind !== "MONETARY") return held("unknown_eligible_kind");
    if (row.amountCents < 0) return held("negative_eligible_adjustment");
    if (row.amountCents === 0) { diagnostics.zeroMonetaryRowCount += 1; continue; }
    const key = name.toUpperCase();
    const existing = committees.get(key);
    const groupCents = (existing?.amountCents ?? 0) + row.amountCents;
    const nextTotal = totalAmountCents + row.amountCents;
    if (!Number.isSafeInteger(groupCents) || !Number.isSafeInteger(nextTotal)) return held("unsafe_cent_total");
    committees.set(key, { reportedCommitteeName: existing?.reportedCommitteeName ?? name, reportedNameKey: key,
      amountCents: groupCents, receiptCount: (existing?.receiptCount ?? 0) + 1 });
    totalAmountCents = nextTotal;
    diagnostics.includedReceiptRowCount += 1;
  }
  return { ...diagnostics, status: "qualified", totalAmountCents,
    committees: [...committees.values()].sort((a, b) => b.amountCents - a.amountCents || a.reportedNameKey.localeCompare(b.reportedNameKey)) };
}
