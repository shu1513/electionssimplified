import {
  aggregateSanFranciscoCommitteeCash,
  type SanFranciscoCommitteeCashOccurrence,
  type SanFranciscoCommitteeCashResult,
} from "./sanFranciscoCommitteeCashAggregator.js";
import type {
  SanFranciscoFilingIndexRow,
  SanFranciscoItemizedTransactionRow,
  SanFranciscoSummaryRow,
} from "./sanFranciscoOpenDataClient.js";

export type SanFranciscoCommitteeCashReportEvidence = {
  filingNid: string;
  filingActivityNid: string;
  periodStart: string;
  periodEnd: string;
  scheduleAItemizedCents: number;
  scheduleEItemizedCents: number;
  aOccurrenceIds: string[];
  eOccurrenceIds: string[];
};
export type SanFranciscoQualifiedCommitteeCash =
  SanFranciscoCommitteeCashResult & {
    electionYear: number;
    fppcId: string;
    windowStart: string;
    windowEnd: string;
    reports: SanFranciscoCommitteeCashReportEvidence[];
  };
const KNOWN_ENTITY_CODES = new Set(["IND", "COM", "SCC", "PTY", "OTH"]);

function date(value: string | null | undefined): string {
  if (
    !value ||
    !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?Z?)?$/.test(
      value,
    )
  )
    throw new Error("SF committee cash date is unavailable or invalid");
  const day = value.slice(0, 10);
  const time = Date.parse(`${day}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !Number.isFinite(time) ||
    new Date(time).toISOString().slice(0, 10) !== day
  )
    throw new Error("SF committee cash date is unavailable or invalid");
  return day;
}
function sum(a: number, b: number) {
  if (!Number.isSafeInteger(b) || !Number.isSafeInteger(a + b))
    throw new Error("SF committee cash control exceeds safe cents");
  return a + b;
}

/** Caller independently establishes receiving candidate/election ownership and the source window. */
export function qualifySanFranciscoCommitteeCash(input: {
  fppcId: string;
  electionYear: number;
  windowStart: string;
  windowEnd: string;
  currentFilings: readonly SanFranciscoFilingIndexRow[];
  summaryRows: readonly SanFranciscoSummaryRow[];
  transactions: readonly SanFranciscoItemizedTransactionRow[];
}): SanFranciscoQualifiedCommitteeCash {
  if (
    !/^\d{4,12}$/.test(input.fppcId) ||
    !Number.isSafeInteger(input.electionYear) ||
    input.electionYear < 1900 ||
    input.electionYear > 2100
  )
    throw new Error("SF committee cash receiving/election context is invalid");
  const start = date(input.windowStart),
    end = date(input.windowEnd);
  if (start > end || end.slice(0, 4) > String(input.electionYear))
    throw new Error("SF committee cash election window is invalid");
  if (!input.currentFilings.length)
    throw new Error("SF committee cash has no current filing authority");
  const current = new Map<string, SanFranciscoFilingIndexRow>();
  for (const filing of input.currentFilings) {
    if (
      !filing.filingNid ||
      current.has(filing.filingNid) ||
      !filing.filingActivityNid ||
      filing.fppcId !== input.fppcId ||
      !filing.currentStatus?.startsWith("Most Recent") ||
      filing.hasEfileContent !== true ||
      filing.rejected !== false
    )
      throw new Error(
        "SF committee cash current filing authority is ambiguous",
      );
    const a = date(filing.periodStart),
      b = date(filing.periodEnd);
    if (a > b || a < start || b > end)
      throw new Error(
        "SF committee cash current period exceeds qualified window",
      );
    current.set(filing.filingNid, filing);
  }
  const reports = new Map<string, SanFranciscoCommitteeCashReportEvidence>();
  for (const summary of input.summaryRows) {
    const filing = current.get(summary.filingNid);
    if (
      !filing ||
      reports.has(summary.filingNid) ||
      summary.formType !== "FPPC460" ||
      summary.fppcId !== input.fppcId ||
      summary.filingActivityNid !== filing.filingActivityNid ||
      summary.syncFlag !== true ||
      date(summary.periodStart) !== date(filing.periodStart) ||
      date(summary.periodEnd) !== date(filing.periodEnd)
    )
      throw new Error("SF committee cash summary/current edition mismatch");
    if (
      !Number.isSafeInteger(summary.scheduleAItemizedCents) ||
      !Number.isSafeInteger(summary.scheduleEItemizedCents)
    )
      throw new Error(
        "SF committee cash complete itemized controls are unavailable",
      );
    reports.set(summary.filingNid, {
      filingNid: summary.filingNid,
      filingActivityNid: filing.filingActivityNid!,
      periodStart: date(filing.periodStart),
      periodEnd: date(filing.periodEnd),
      scheduleAItemizedCents: summary.scheduleAItemizedCents!,
      scheduleEItemizedCents: summary.scheduleEItemizedCents!,
      aOccurrenceIds: [],
      eOccurrenceIds: [],
    });
  }
  if (reports.size !== current.size)
    throw new Error("SF committee cash missing current summary coverage");
  const totals = new Map<string, { a: number; e: number }>();
  const seen = new Set<string>();
  const aRows: SanFranciscoCommitteeCashOccurrence[] = [],
    returns: SanFranciscoCommitteeCashOccurrence[] = [];
  for (const row of input.transactions) {
    if (
      !row.elementNid ||
      seen.has(row.elementNid) ||
      row.fppcId !== input.fppcId ||
      !row.filingActivityNid ||
      !Number.isSafeInteger(row.calculatedAmountCents)
    )
      throw new Error(
        "SF committee cash full transaction identity is unavailable or duplicated",
      );
    seen.add(row.elementNid);
    if (row.formType === "F497P1") {
      if (
        row.memoCode !== true &&
        (row.entityCode === "COM" || row.entityCode === "SCC")
      )
        throw new Error(
          "SF committee cash late occurrence needs exact independent cash association",
        );
      continue;
    }
    const report = reports.get(row.filingNid);
    if (!report || row.filingActivityNid !== report.filingActivityNid)
      throw new Error(
        "SF committee cash transaction does not belong to current edition",
      );
    if (row.formType === "B1") continue;
    if (row.formType !== "A" && row.formType !== "E")
      throw new Error("SF committee cash unexpected financial schedule");
    const day = date(row.transactionDate);
    if (
      day < report.periodStart ||
      day > report.periodEnd ||
      day < start ||
      day > end
    )
      throw new Error(
        "SF committee cash transaction date exceeds qualified period",
      );
    if (row.memoCode !== true && row.memoCode !== false)
      throw new Error("SF committee cash memo role unavailable");
    if (row.isItemized !== true)
      throw new Error("SF committee cash itemized/source role unavailable");
    if (
      (row.formType === "A" || row.transactionCode === "RFD") &&
      (!row.entityCode || !KNOWN_ENTITY_CODES.has(row.entityCode))
    )
      throw new Error("SF committee cash donor/return class unavailable");
    if (row.memoCode === true) continue;
    const total = totals.get(row.filingNid) ?? { a: 0, e: 0 };
    if (row.formType === "A") {
      total.a = sum(total.a, row.calculatedAmountCents);
      report.aOccurrenceIds.push(row.elementNid);
    } else {
      total.e = sum(total.e, row.calculatedAmountCents);
      report.eOccurrenceIds.push(row.elementNid);
    }
    totals.set(row.filingNid, total);
    const occurrence: SanFranciscoCommitteeCashOccurrence = {
      occurrenceId: row.elementNid,
      formType: row.formType,
      transactionCode: row.transactionCode,
      entityCode: row.entityCode,
      reportedName: row.contributorLastName,
      reportedCommitteeId: row.reportedCommitteeId ?? null,
      amountCents: row.calculatedAmountCents,
      memoCode: row.memoCode,
    };
    if (row.formType === "A") aRows.push(occurrence);
    else if (row.transactionCode === "RFD") returns.push(occurrence);
    else if (
      /refund|return(?:ed)?\s+contribut/i.test(row.transactionDescription ?? "")
    )
      throw new Error(
        "SF committee cash possible return has unresolved source category",
      );
  }
  const committeeNames = new Set(
    aRows
      .filter((r) => r.entityCode === "COM" || r.entityCode === "SCC")
      .map((r) =>
        (r.reportedName ?? "")
          .normalize("NFKC")
          .toUpperCase()
          .replace(/\s+/g, " ")
          .trim(),
      ),
  );
  for (const returned of returns) {
    const key = (returned.reportedName ?? "")
      .normalize("NFKC")
      .toUpperCase()
      .replace(/\s+/g, " ")
      .trim();
    if (
      returned.entityCode !== "COM" &&
      returned.entityCode !== "SCC" &&
      committeeNames.has(key)
    )
      throw new Error(
        "SF committee cash return class contradicts reported donor ownership",
      );
  }
  for (const report of reports.values()) {
    const total = totals.get(report.filingNid) ?? { a: 0, e: 0 };
    if (
      total.a !== report.scheduleAItemizedCents ||
      total.e !== report.scheduleEItemizedCents
    )
      throw new Error(
        "SF committee cash whole A/E itemized controls do not reconcile",
      );
    report.aOccurrenceIds.sort();
    report.eOccurrenceIds.sort();
  }
  return {
    ...aggregateSanFranciscoCommitteeCash({
      scheduleARows: aRows,
      unpairedCashF497Rows: [],
      scheduleEReturnRows: returns,
    }),
    electionYear: input.electionYear,
    fppcId: input.fppcId,
    windowStart: start,
    windowEnd: end,
    reports: [...reports.values()].sort((a, b) =>
      a.filingNid.localeCompare(b.filingNid),
    ),
  };
}
