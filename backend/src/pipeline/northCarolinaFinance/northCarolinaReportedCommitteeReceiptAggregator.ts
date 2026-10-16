import { selectNorthCarolinaDirectCycleReportRows } from "./northCarolinaDirectContributionAggregator.js";
import {
  decodeNcsbeHtmlEntities,
  isNcsbeReportYearInCycle,
  NCSBE_COVER_SECTIONS,
  NCSBE_NO_TOTAL_REPORT_TYPES,
  NCSBE_OUTSIDE_LEG_REPORT_TYPES,
  NORTH_CAROLINA_SBOEID_PATTERN,
  type NcsbeDocumentRow,
} from "./northCarolinaNcsbeParsers.js";
import { selectNcsbeCurrentFilings } from "./northCarolinaReportSelector.js";
import type { NorthCarolinaReportedReceiptSource } from "./northCarolinaReportedReceiptSource.js";

export type NorthCarolinaReportedCommitteeReceiptClass = "CPCM" | "PPTY";
export type NorthCarolinaReportedCommitteeReceiptHoldReason =
  | "receiving_committee" | "election_year" | "inventory_identity" | "inventory_period"
  | "current_lineage" | "current_image_only" | "no_current_reports" | "current_report_set"
  | "report_identity" | "typed_receipt_controls" | "receipt_shape" | "payment_type"
  | "prior_receipt" | "negative_monetary_receipt" | "reported_name" | "unsafe_integer";

export type NorthCarolinaReportedCommitteeReceiptGroup = {
  reportedClass: NorthCarolinaReportedCommitteeReceiptClass;
  displayName: string;
  normalizedName: string;
  positiveGrossCents: number;
  positiveOccurrenceCount: number;
};

export type NorthCarolinaReportedCommitteeReceiptClassControl = {
  reportedClass: NorthCarolinaReportedCommitteeReceiptClass;
  sourceOccurrenceCount: number;
  signedSourceCents: number;
  coverPeriodCents: number;
  positiveOccurrenceCount: number;
  positiveGrossCents: number;
  zeroOccurrenceCount: number;
  excludedAggregatedOccurrenceCount: number;
  excludedAggregatedSignedCents: number;
  excludedInKindOccurrenceCount: number;
  excludedInKindSignedCents: number;
};

export type NorthCarolinaReportedCommitteeReceiptResult = {
  status: "held";
  reason: NorthCarolinaReportedCommitteeReceiptHoldReason;
} | {
  status: "qualified";
  receivingCommitteeId: string;
  electionYear: number;
  metric: "reported_itemized_committee_monetary_receipts_before_returns";
  positiveGrossCents: number;
  positiveOccurrenceCount: number;
  groups: NorthCarolinaReportedCommitteeReceiptGroup[];
  classControls: NorthCarolinaReportedCommitteeReceiptClassControl[];
  coveredPeriods: Array<{
    reportId: string;
    reportType: string | null;
    periodStart: string;
    periodEnd: string;
    sourceOccurrenceCount: number;
    classControls: NorthCarolinaReportedCommitteeReceiptClassControl[];
  }>;
  diagnostics: {
    inventoryRowCount: number;
    excludedOtherReceiverInventoryRowCount: number;
    duplicateInventoryRowCount: number;
    excludedNoTotalReportRowCount: number;
    excludedOutsideLegReportRowCount: number;
    excludedUndatedOutOfCycleRowCount: number;
    reportCount: number;
    sourceOccurrenceCount: number;
    excludedOtherClassOccurrenceCount: number;
    coverIdentityMetadataDisagreementReportCount: number;
    coverPeriodDisagreementReportCount: number;
  };
};

class Held extends Error {
  constructor(readonly reason: NorthCarolinaReportedCommitteeReceiptHoldReason) { super(reason); }
}
function hold(reason: NorthCarolinaReportedCommitteeReceiptHoldReason): never { throw new Held(reason); }
function integer(value: number): number {
  if (!Number.isSafeInteger(value)) hold("unsafe_integer");
  return value;
}
function add(left: number, right: number): number {
  integer(left); integer(right);
  const result = BigInt(left) + BigInt(right);
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) hold("unsafe_integer");
  return Number(result);
}
function control(reportedClass: NorthCarolinaReportedCommitteeReceiptClass): NorthCarolinaReportedCommitteeReceiptClassControl {
  return { reportedClass, sourceOccurrenceCount: 0, signedSourceCents: 0, coverPeriodCents: 0,
    positiveOccurrenceCount: 0, positiveGrossCents: 0, zeroOccurrenceCount: 0,
    excludedAggregatedOccurrenceCount: 0, excludedAggregatedSignedCents: 0,
    excludedInKindOccurrenceCount: 0, excludedInKindSignedCents: 0 };
}
const CLASSES = ["CPCM", "PPTY"] as const;
// Exact spellings observed in native source data. An unsupported relevant
// label remains held until its monetary semantics are established.
const MONETARY_PAYMENTS: ReadonlySet<string> = new Set(["Cash", "Check", "Credit Card", "Electronic Funds Transfer"]);

function regular(row: NcsbeDocumentRow): boolean {
  return row.documentType === "Disclosure Report"
    && (row.reportType === null || (!NCSBE_NO_TOTAL_REPORT_TYPES.has(row.reportType) && !NCSBE_OUTSIDE_LEG_REPORT_TYPES.has(row.reportType)));
}
function validPeriod(row: NcsbeDocumentRow): boolean {
  return row.periodStartDate.iso !== null && row.periodEndDate.iso !== null
    && !row.periodStartDate.implausible && !row.periodEndDate.implausible
    && row.periodStartDate.iso <= row.periodEndDate.iso;
}
function reportedName(value: unknown): { displayName: string; normalizedName: string } {
  if (typeof value !== "string" || /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/.test(value)) hold("reported_name");
  const displayName = decodeNcsbeHtmlEntities(value).normalize("NFC").replace(/\s+/g, " ").trim();
  if (!/[\p{L}\p{N}]/u.test(displayName)) hold("reported_name");
  return { displayName, normalizedName: displayName.toUpperCase() };
}
function checkControl(value: NorthCarolinaReportedCommitteeReceiptClassControl): void {
  const accountedCount = add(add(value.positiveOccurrenceCount, value.zeroOccurrenceCount),
    add(value.excludedAggregatedOccurrenceCount, value.excludedInKindOccurrenceCount));
  const accountedCents = add(value.positiveGrossCents, add(value.excludedAggregatedSignedCents, value.excludedInKindSignedCents));
  if (accountedCount !== value.sourceOccurrenceCount || accountedCents !== value.signedSourceCents
    || value.signedSourceCents !== value.coverPeriodCents) hold("typed_receipt_controls");
}

/**
 * One receiving committee's itemized gross monetary CPCM/PPTY receipts on its
 * canonical current regular-report Period records in Y-1..Y, before returns.
 * Inputs must be the full inventory and every current source-validator output.
 * A qualified result does not assert cycle completeness or legal donor identity.
 */
export function aggregateNorthCarolinaReportedCommitteeReceipts(input: {
  receivingCommitteeId: string;
  electionYear: number;
  inventoryRows: readonly NcsbeDocumentRow[];
  reports: readonly NorthCarolinaReportedReceiptSource[];
}): NorthCarolinaReportedCommitteeReceiptResult {
  try {
    if (!NORTH_CAROLINA_SBOEID_PATTERN.test(input.receivingCommitteeId) || !input.receivingCommitteeId.includes("-C-")) hold("receiving_committee");
    if (!Number.isSafeInteger(input.electionYear) || input.electionYear < 2000 || input.electionYear > 2100) hold("election_year");
    const scopedRows = input.inventoryRows.filter((row) => row.sboeId === input.receivingCommitteeId || row.sboeId === null || row.sboeId.trim() === "");
    // A malformed relevant year cannot establish a safe Period or lineage;
    // unrelated historical rows and explicitly excluded report forms stay out.
    for (const row of scopedRows) {
      if (regular(row) && isNcsbeReportYearInCycle(row.reportYear, input.electionYear) && !validPeriod(row)) hold("inventory_period");
    }
    const cycle = selectNorthCarolinaDirectCycleReportRows({ rows: scopedRows, electionYear: input.electionYear });
    if (cycle.rows.some((row) => row.sboeId !== input.receivingCommitteeId)) hold("inventory_identity");
    const selection = selectNcsbeCurrentFilings({ rows: cycle.rows });
    if (selection.quarantinedGroups.length > 0) hold("current_lineage");
    if (selection.supersededUnavailable.length > 0) hold("current_image_only");
    if (selection.selected.length === 0) hold("no_current_reports");
    const start = `${input.electionYear - 1}-01-01`, end = `${input.electionYear}-12-31`;
    for (const filing of selection.selected) {
      if (filing.rows.some((row) => !validPeriod(row)) || filing.periodStartIso === null || filing.periodEndIso === null
        || filing.periodStartIso < start || filing.periodEndIso > end) hold("inventory_period");
    }
    const reports = new Map<string, NorthCarolinaReportedReceiptSource>();
    for (const report of input.reports) {
      if (reports.has(report.reportId)) hold("current_report_set");
      reports.set(report.reportId, report);
    }
    if (reports.size !== selection.selected.length || selection.selected.some((filing) => !reports.has(filing.reportId!))) hold("current_report_set");

    const groups = new Map<string, NorthCarolinaReportedCommitteeReceiptGroup>();
    const classControls = CLASSES.map(control);
    const coveredPeriods: Extract<NorthCarolinaReportedCommitteeReceiptResult, { status: "qualified" }>["coveredPeriods"] = [];
    const diagnostics = {
      inventoryRowCount: input.inventoryRows.length,
      excludedOtherReceiverInventoryRowCount: input.inventoryRows.length - scopedRows.length,
      duplicateInventoryRowCount: selection.duplicateRowCount,
      excludedNoTotalReportRowCount: cycle.excludedNoTotalReportRowCount,
      excludedOutsideLegReportRowCount: cycle.excludedOutsideLegReportRowCount,
      excludedUndatedOutOfCycleRowCount: cycle.excludedUndatedOutOfCycleRowCount,
      reportCount: selection.selected.length,
      sourceOccurrenceCount: 0,
      excludedOtherClassOccurrenceCount: 0,
      coverIdentityMetadataDisagreementReportCount: 0,
      coverPeriodDisagreementReportCount: 0,
    };
    for (const filing of selection.selected) {
      const report = reports.get(filing.reportId!)!;
      if (report.detail.cover.reportId !== report.reportId) hold("report_identity");
      const cover = report.detail.cover;
      if (cover.boeId !== input.receivingCommitteeId || cover.orgName !== filing.committeeName) diagnostics.coverIdentityMetadataDisagreementReportCount += 1;
      if (cover.beginDate.iso !== filing.periodStartIso || cover.endDate.iso !== filing.periodEndIso) diagnostics.coverPeriodDisagreementReportCount += 1;
      const reportControls = CLASSES.map(control);
      for (const value of reportControls) {
        const sequence = value.reportedClass === "CPCM" ? 35 : 30;
        const sections = report.detail.summarySections.filter((section) => section.sequence === sequence);
        if (sections.length !== 1 || sections[0]!.section !== NCSBE_COVER_SECTIONS.get(sequence)) hold("typed_receipt_controls");
        value.coverPeriodCents = integer(sections[0]!.periodCents);
      }
      diagnostics.sourceOccurrenceCount = add(diagnostics.sourceOccurrenceCount, report.receipts.length);
      for (const row of report.receipts) {
        const value = reportControls.find((item) => item.reportedClass === row.receiptTypeCode);
        if (!value) { diagnostics.excludedOtherClassOccurrenceCount = add(diagnostics.excludedOtherClassOccurrenceCount, 1); continue; }
        const amount = integer(row.amountCents);
        value.sourceOccurrenceCount = add(value.sourceOccurrenceCount, 1);
        value.signedSourceCents = add(value.signedSourceCents, amount);
        if (row.isAggregated === true) {
          value.excludedAggregatedOccurrenceCount = add(value.excludedAggregatedOccurrenceCount, 1);
          value.excludedAggregatedSignedCents = add(value.excludedAggregatedSignedCents, amount);
          continue;
        }
        const payment = row.sourceFields.FormOfPaymentDesc;
        if (payment === "In Kind") {
          value.excludedInKindOccurrenceCount = add(value.excludedInKindOccurrenceCount, 1);
          value.excludedInKindSignedCents = add(value.excludedInKindSignedCents, amount);
          continue;
        }
        if (row.isAggregated !== false) hold("receipt_shape");
        if (typeof payment !== "string" || !MONETARY_PAYMENTS.has(payment)) hold("payment_type");
        const prior = row.sourceFields.IsPrior;
        if (typeof prior !== "string" || prior.trim() !== "") hold("prior_receipt");
        if (amount < 0) hold("negative_monetary_receipt");
        if (amount === 0) { value.zeroOccurrenceCount = add(value.zeroOccurrenceCount, 1); continue; }
        const name = reportedName(row.sourceFields.OrgName);
        value.positiveOccurrenceCount = add(value.positiveOccurrenceCount, 1);
        value.positiveGrossCents = add(value.positiveGrossCents, amount);
        const key = JSON.stringify([value.reportedClass, name.normalizedName]);
        const group = groups.get(key);
        if (group) {
          group.positiveOccurrenceCount = add(group.positiveOccurrenceCount, 1);
          group.positiveGrossCents = add(group.positiveGrossCents, amount);
        } else groups.set(key, { reportedClass: value.reportedClass, ...name, positiveGrossCents: amount, positiveOccurrenceCount: 1 });
      }
      for (const value of reportControls) {
        checkControl(value);
        const aggregate = classControls.find((item) => item.reportedClass === value.reportedClass)!;
        for (const key of Object.keys(value) as Array<keyof typeof value>) {
          if (key !== "reportedClass") aggregate[key] = add(aggregate[key], value[key]);
        }
      }
      coveredPeriods.push({ reportId: report.reportId, reportType: filing.reportType,
        periodStart: filing.periodStartIso!, periodEnd: filing.periodEndIso!, sourceOccurrenceCount: report.receipts.length, classControls: reportControls });
    }
    for (const value of classControls) checkControl(value);
    const resultGroups = [...groups.values()].sort((left, right) => right.positiveGrossCents - left.positiveGrossCents
      || left.reportedClass.localeCompare(right.reportedClass) || left.normalizedName.localeCompare(right.normalizedName));
    let positiveGrossCents = 0, positiveOccurrenceCount = 0;
    for (const group of resultGroups) {
      positiveGrossCents = add(positiveGrossCents, group.positiveGrossCents);
      positiveOccurrenceCount = add(positiveOccurrenceCount, group.positiveOccurrenceCount);
    }
    if (positiveGrossCents !== add(classControls[0]!.positiveGrossCents, classControls[1]!.positiveGrossCents)
      || positiveOccurrenceCount !== add(classControls[0]!.positiveOccurrenceCount, classControls[1]!.positiveOccurrenceCount)) hold("typed_receipt_controls");
    return { status: "qualified", receivingCommitteeId: input.receivingCommitteeId, electionYear: input.electionYear,
      metric: "reported_itemized_committee_monetary_receipts_before_returns", positiveGrossCents, positiveOccurrenceCount,
      groups: resultGroups, classControls, coveredPeriods, diagnostics };
  } catch (error) {
    if (error instanceof Held) return { status: "held", reason: error.reason };
    throw error;
  }
}
