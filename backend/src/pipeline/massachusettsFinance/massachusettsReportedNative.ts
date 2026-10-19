import { maCanonical, maCents, maHold, maAdd } from "./massachusettsReportedCore.js";

export const maId = (v: unknown): number => {
  if (!Number.isSafeInteger(v) || (v as number) < 1) maHold("native_identity");
  return v as number;
};
export function maArray(v: any): any[] {
  if (!Array.isArray(v) || v.some(x => !x || typeof x !== "object" || Array.isArray(x))) maHold("native_array");
  return v;
}
export function maReportItems(v: any): any[] {
  const rows = maArray(v?.items);
  if (rows.length >= 1000 || v.summary?.count !== rows.length) maHold("report_list_count");
  maUniqueReports(rows);
  return rows;
}
export function maUniqueReports(rows: any[]): void {
  const ids = rows.map(r => maId(r.reportId));
  if (new Set(ids).size !== ids.length) maHold("duplicate_report");
}
export function maSameReportSet(a: any[], b: any[]): void {
  maUniqueReports(a); maUniqueReports(b);
  const ids = (v: any[]) => v.map(r => r.reportId).sort((x, y) => x - y);
  if (maCanonical(ids(a)) !== maCanonical(ids(b))) maHold("current_report_membership");
}
const iepacHeader = ["reportId", "cpfId", "reportYear", "reportTypeId", "recordTypeId", "guid", "key",
  "isIePacReport", "isDraft", "isAmended", "isAmendment", "startDate", "endDate", "dateFiled",
  "expenditureItemizedTotal", "expenditureUnitemizedTotal", "expenditureTotal", "receiptItemizedTotal",
  "receiptUnitemizedTotal", "receiptTotal", "inkindItemizedTotal", "inkindUnitemizedTotal", "inkindTotal",
  "liabilityTotal", "committeeName", "filerFullName", "filerFullNameReverse"];
const ordinaryHeader = ["reportId", "cpfId", "reportType", "reportStatus", "startDate", "endDate", "date",
  "filingDate", "expenditureTotal", "receiptTotal", "liabilityTotal", "isAmendment", "amendmentToReportId",
  "amendedByReportId", "filingEntityFull", "filingEntity", "filerType"];
export function maSameHeader(a: any, b: any, iepac: boolean): boolean {
  return (iepac ? iepacHeader : ordinaryHeader).every(k => a[k] !== undefined && maCanonical(a[k]) === maCanonical(b[k]));
}
export function maCurrentReport(v: any, iepac: boolean, year: number): void {
  maId(v?.reportId);
  if (iepac ? (v.reportYear !== year || v.isIePacReport !== true || v.isDraft !== false || v.isAmended !== false)
    : (v.reportType !== "IE" || v.reportStatus !== "C" || v.amendedByReportId !== 0)) maHold("noncurrent_report");
}
/** Source-wide receipt closure precedes any contributor-class selection. */
export function maReceiptSweep(pages: any[]): any[] {
  if (!pages.length) maHold("receipt_pages");
  const count = pages[0]?.summary?.count, total = pages[0]?.summary?.total;
  if (!Number.isSafeInteger(count) || count < 1 || count > 100000 || typeof total !== "number" || !Number.isFinite(total)) maHold("receipt_controls");
  const rows: any[] = [], seen = new Set<string>();
  for (const [i, page] of pages.entries()) {
    const items = maArray(page.items);
    if (page.summary?.count !== count || page.summary?.total !== total ||
      items.length !== Math.min(500, count - i * 500)) maHold("receipt_page_count");
    for (const row of items) {
      const id = typeof row.id === "number" ? String(maId(row.id)) : row.id;
      if (!(typeof id === "string" && id.length) || seen.has(id)) maHold("receipt_duplicate");
      seen.add(id); rows.push(row);
    }
  }
  if (rows.length !== count || pages.length !== Math.ceil(count / 500)) maHold("receipt_page_count");
  const cents = rows.reduce((s, r) => maAdd(s, maCents(r.amount)), 0);
  // JSON numeric summary is a source control only; item math uses currency strings.
  if (!Number.isSafeInteger(Math.round(total * 100)) || Math.abs(total * 100 - Math.round(total * 100)) > 0.00001 || cents !== Math.round(total * 100)) maHold("receipt_money_control");
  return rows;
}
export function maSameReceiptSweeps(a: any[], b: any[]): void {
  const sorted = (rows: any[]) => [...rows].sort((x, y) => String(x.id).localeCompare(String(y.id)));
  if (maCanonical(sorted(a)) !== maCanonical(sorted(b))) maHold("receipt_changed_during_paging");
}
