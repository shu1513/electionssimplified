import {
  buildMarylandPublicReportInventoryRequest, decodeMarylandPublishedReport,
  type MarylandPublishedReport, type MarylandPublicReportInventoryRequest,
} from "./marylandPublicReportClient.js";

type Row = Readonly<Record<string, unknown>>;
const guid = (value: unknown): value is string => typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) &&
  value !== "00000000-0000-0000-0000-000000000000";
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
export class MarylandNativeReportBindingError extends Error {
  constructor(public readonly code: "duplicate_report" | "ambiguous_lineage" | "invalid_occurrence" |
    "duplicate_occurrence" | "unresolved_report" | "period") {
    super(`Maryland native report binding: ${code}`);
  }
}
const fail = (code: ConstructorParameters<typeof MarylandNativeReportBindingError>[0]): never => {
  throw new MarylandNativeReportBindingError(code);
};

/** Transient structural grouping, not collection/currentness/financial authority.
 * Keep unchanged economic occurrences that still point to a historical edition.
 * Their date must fit both that published edition and the paired current report.
 * Callers must not persist the returned native rows or their identity derivatives. */
export function bindMarylandNativeReportOccurrences(input: {
  reports: readonly MarylandPublishedReport[];
  request: MarylandPublicReportInventoryRequest;
  nativeRows: readonly Row[];
}) {
  const request = buildMarylandPublicReportInventoryRequest(input.request);
  const reports = input.reports.map(r => decodeMarylandPublishedReport(r, request));
  const parents = new Set<string>();
  const lineage = new Map<string, { index: number; start: string; end: string; historical: boolean }>();
  reports.forEach((report, index) => {
    const parent = report.reportGuid.toLowerCase(), currentKey = `${parent}:${report.reportVersionId}`;
    if (parents.has(parent)) fail("duplicate_report");
    parents.add(parent);
    const editions = [{ key: currentKey, startDate: report.startDate, endDate: report.endDate },
      ...(report.childResults ?? []).map(c => ({ key: `${c.filerReportGuid.toLowerCase()}:${c.filerReportVersionID}`,
        startDate: c.startDate, endDate: c.endDate }))];
    const own = new Set<string>();
    for (const edition of editions) {
      if (own.has(edition.key)) continue; // Parent and its exact current child represent one edition.
      own.add(edition.key);
      if (lineage.has(edition.key)) fail("ambiguous_lineage");
      lineage.set(edition.key, { index, start: edition.startDate.slice(0, 10), end: edition.endDate.slice(0, 10),
        historical: edition.key !== currentKey });
    }
  });
  const buckets = reports.map(report => ({ report, rows: [] as Row[] }));
  const occurrences = new Set<string>();
  let historicalRowCount = 0;
  for (const row of input.nativeRows) {
    if (!row || typeof row !== "object" || Array.isArray(row) || !guid(row.filerRegistrationGuid) ||
      row.filerRegistrationGuid.toLowerCase() !== request.filerRegistrationGuid.toLowerCase() ||
      !positive(row.electionCycleId) || String(row.electionCycleId) !== request.electionCycleId ||
      !guid(row.reportGuid) || !positive(row.reportVersionId) || !guid(row.transactionGuid) ||
      !positive(row.transactionVersionID) || typeof row.isReturn !== "boolean" ||
      row.transactionTypeCode !== (row.isReturn ? "TRCON" : "TCON") ||
      typeof row.transactionDate !== "string" || !/^\d{4}-\d{2}-\d{2}T00:00:00$/.test(row.transactionDate) ||
      row.transactionDate.startsWith("0000") || !Number.isFinite(Date.parse(`${row.transactionDate}Z`)) ||
      new Date(`${row.transactionDate}Z`).toISOString().slice(0, 19) !== row.transactionDate) fail("invalid_occurrence");
    const occurrence = `${row.transactionGuid.toLowerCase()}:${row.transactionVersionID}:${row.reportGuid.toLowerCase()}:${row.reportVersionId}:${row.isReturn}`;
    if (occurrences.has(occurrence)) fail("duplicate_occurrence");
    occurrences.add(occurrence);
    const edition = lineage.get(`${row.reportGuid.toLowerCase()}:${row.reportVersionId}`);
    if (!edition) fail("unresolved_report");
    const bucket = buckets[edition.index]!, day = row.transactionDate.slice(0, 10);
    if (day < edition.start || day > edition.end ||
      day < bucket.report.startDate.slice(0, 10) || day > bucket.report.endDate.slice(0, 10)) fail("period");
    if (edition.historical) historicalRowCount++;
    bucket.rows.push(row);
  }
  return Object.freeze({ physicalCount: input.nativeRows.length, historicalRowCount,
    reports: Object.freeze(buckets.map(b => Object.freeze({ report: b.report, rows: Object.freeze(b.rows) }))) });
}
