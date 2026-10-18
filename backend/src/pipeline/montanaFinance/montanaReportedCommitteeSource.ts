/** Current native committee receipts. No CSV/name heuristic, legal-filer
 * identity inference, expenditure-side return subtraction or display cap. */
export class MontanaReportedCommitteeError extends Error {
  constructor(readonly code: string) { super(`Montana committee receipts unavailable: ${code}`); this.name = "MontanaReportedCommitteeError"; }
}
export function mtCommitteeHold(code: string): never { throw new MontanaReportedCommitteeError(code); }
export type MontanaCommitteeScope = { nativeCandidateId: number; electionYear: number };
type Row = Record<string, unknown>;
export const mtCommitteeCanonical = (value: unknown): string => JSON.stringify(value, (_, v) => v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
export function mtCommitteeObject(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) mtCommitteeHold("invalid_native_object"); return value as Row;
}
export function mtCommitteeInteger(value: unknown, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) mtCommitteeHold("invalid_native_integer"); return value;
}
export function mtCommitteeText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) mtCommitteeHold("invalid_native_text");
  return value.normalize("NFC").trim().replace(/\s+/g, " ");
}
export function mtCommitteeCents(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) mtCommitteeHold("invalid_native_money");
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value)); if (!m) mtCommitteeHold("fractional_native_cents");
  const exact = (BigInt(m[2]!) * 100n + BigInt((m[3] ?? "").padEnd(2, "0"))) * (m[1] ? -1n : 1n);
  if (exact > BigInt(Number.MAX_SAFE_INTEGER) || exact < BigInt(Number.MIN_SAFE_INTEGER) || Math.round(value * 100) !== Number(exact)) mtCommitteeHold("unsafe_native_money");
  return Number(exact);
}
const add = (a: number, b: number) => { const n = a + b; if (!Number.isSafeInteger(n)) mtCommitteeHold("unsafe_money_sum"); return n; };
export function validateMontanaCommitteeScope(scope: MontanaCommitteeScope) {
  mtCommitteeInteger(scope.nativeCandidateId, 1); mtCommitteeInteger(scope.electionYear, 2020); if (scope.electionYear > 2100) mtCommitteeHold("invalid_cycle");
}
function period(value: unknown) {
  if (typeof value !== "string" || !/^\d{2}\/\d{2}\/\d{4}$/.test(value)) mtCommitteeHold("invalid_report_period");
  const [m, d, y] = value.split("/").map(Number), at = new Date(Date.UTC(y!, m! - 1, d!));
  if (at.getUTCFullYear() !== y || at.getUTCMonth() + 1 !== m || at.getUTCDate() !== d) mtCommitteeHold("invalid_report_period"); return at.getTime();
}
export function mtCommitteeTable(value: unknown) {
  const v = mtCommitteeObject(value), total = mtCommitteeInteger(v.iTotalRecords), filtered = mtCommitteeInteger(v.iTotalDisplayRecords);
  if (filtered > total || filtered > 100000 || !Array.isArray(v.aaData)) mtCommitteeHold("invalid_native_table");
  return { total, filtered, rows: v.aaData.map(mtCommitteeObject) };
}
export type MontanaCommitteeReport = { reportId: number; form: string; from: string; to: string; status: string;
  receivedAt: number; amendedAt: number | null; primaryCashBeginningCents: number | null; generalCashBeginningCents: number | null };
export function selectMontanaCommitteeReceiptReports(value: unknown, scope: MontanaCommitteeScope): MontanaCommitteeReport[] {
  validateMontanaCommitteeScope(scope); const t = mtCommitteeTable(value); if (t.rows.length !== t.filtered) mtCommitteeHold("incomplete_report_inventory");
  const ids = new Set<number>(), periods = new Set<string>(), reports: MontanaCommitteeReport[] = [];
  for (const r of t.rows) {
    const id = mtCommitteeInteger(r.reportId, 1); if (ids.has(id)) mtCommitteeHold("duplicate_native_report"); ids.add(id);
    if (mtCommitteeInteger(r.entitySubId, 1) !== scope.nativeCandidateId) mtCommitteeHold("wrong_receiving_report");
    const form = mtCommitteeText(r.formTypeCode), status = mtCommitteeText(r.statusCode);
    if (status === "INCRP" || !["C5", "C7"].includes(form)) continue;
    if (!["FILED", "AMEND", "PENDA"].includes(status)) mtCommitteeHold("unsupported_receipt_report_status");
    const from = mtCommitteeText(r.fromDateStr), to = mtCommitteeText(r.toDateStr); if (period(from) > period(to)) mtCommitteeHold("invalid_report_period");
    if (form === "C5") { const key = `${from}|${to}`; if (periods.has(key)) mtCommitteeHold("ambiguous_current_report"); periods.add(key); }
    reports.push({ reportId: id, form, from, to, status, receivedAt: mtCommitteeInteger(r.receivedDate, 1),
      amendedAt: r.amendedDate === null ? null : mtCommitteeInteger(r.amendedDate, 1),
      primaryCashBeginningCents: r.primCashBeg === null ? null : mtCommitteeCents(r.primCashBeg),
      generalCashBeginningCents: r.genCashBeg === null ? null : mtCommitteeCents(r.genCashBeg) });
  }
  if (!reports.length) mtCommitteeHold("no_filed_receipt_reports");
  reports.sort((a, b) => period(a.from) - period(b.from) || period(a.to) - period(b.to) || a.reportId - b.reportId);
  const regular = reports.filter(r => r.form === "C5"); for (let i = 1; i < regular.length; i++)
    if (period(regular[i]!.from) <= period(regular[i - 1]!.to)) mtCommitteeHold("overlapping_current_reports");
  return reports;
}
const COMMITTEE_LABELS = new Set(["Independent Committee Contributions", "Political Party Committee Contributions", "Incidental Committee Contributions"]);
const COMMITTEE_TYPES = new Set(["PA", "FA", "PP", "FP", "IN", "IL", "JF", "BI", "DB", "DP", "MP", "UN"]);
type Receipt = { side: string; cashCents: number; inKindCents: number; cents: number; name: string; paidAt: number | null; label: string };
function receipt(row: Row, reportedName: unknown, surface: "report" | "search" = "report"): Receipt {
  const label = mtCommitteeText(row.lineItemCompositeDescr); if (!COMMITTEE_LABELS.has(label)) mtCommitteeHold("unknown_committee_receipt_type");
  const cashCents = mtCommitteeCents(row.cashAmt), inKindCents = mtCommitteeCents(row.inKindAmt), cents = mtCommitteeCents(row.totalAmt);
  // The public search represents non-applicable debt as null; report-detail
  // lists use numeric zero. Principal cash/in-kind/total fields stay strict.
  const debt = surface === "search" && row.debtAmt === null ? 0 : mtCommitteeCents(row.debtAmt);
  if (add(cashCents, inKindCents) !== cents || debt !== 0) mtCommitteeHold("committee_money_composition");
  const side = mtCommitteeText(row.amountTypeDescr); if (!["Primary", "General"].includes(side)) mtCommitteeHold("unknown_election_side");
  return { side, cashCents, inKindCents, cents, name: mtCommitteeText(reportedName), paidAt: row.datePaid === null ? null : mtCommitteeInteger(row.datePaid, 1), label };
}
type Group = { key: string; name: string; sourceEntityId: number; cents: number; rowCount: number; committeeTypes: string[] };
export type MontanaReportedCommitteeAggregation = ReturnType<typeof aggregateMontanaReportedCommitteeReceipts>;

/** Pages and details are pure inputs for replay/tests. The financial writer
 * only accepts packets branded by a verified original-response cache. */
export function aggregateMontanaReportedCommitteeReceipts(input: { scope: MontanaCommitteeScope; inventory: unknown;
  details: readonly { reportId: number; rows: unknown }[]; pages: readonly { start: number; body: unknown }[]; resultCount: unknown }) {
  const reports = selectMontanaCommitteeReceiptReports(input.inventory, input.scope), expected = mtCommitteeInteger(input.resultCount);
  const detailMap = new Map<number, Receipt[]>();
  if (input.details.length !== reports.length) mtCommitteeHold("incomplete_report_details");
  for (const d of input.details) {
    mtCommitteeInteger(d.reportId, 1); if (detailMap.has(d.reportId) || !reports.some(r => r.reportId === d.reportId) || !Array.isArray(d.rows)) mtCommitteeHold("wrong_report_detail_membership");
    detailMap.set(d.reportId, d.rows.map(r => { const raw = mtCommitteeObject(r); return receipt(raw, raw.entityName); }));
  }
  if (!input.pages.length || expected > 100000) mtCommitteeHold("incomplete_receiving_pages");
  const reportKeys = new Set(reports.map(r => r.reportId)), transactions = new Set<number>(), byReport = new Map<number, Receipt[]>(), groups = new Map<number, Group>();
  let receivingRows = 0, selectedRows = 0, positiveCents = 0, negativeCents = 0;
  for (const page of input.pages) {
    if (mtCommitteeInteger(page.start) !== receivingRows) mtCommitteeHold("non_contiguous_receiving_pages"); const t = mtCommitteeTable(page.body);
    if (t.filtered !== expected || t.rows.length === 0 && expected !== 0 || receivingRows + t.rows.length > expected) mtCommitteeHold("receiving_count_mismatch");
    for (const row of t.rows) {
      receivingRows++; const transaction = mtCommitteeInteger(row.transId, 1), reportId = mtCommitteeInteger(row.reportId, 1);
      if (transactions.has(transaction)) mtCommitteeHold("duplicate_current_transaction"); transactions.add(transaction);
      if (!reportKeys.has(reportId)) mtCommitteeHold("unsupported_or_unfiled_parent");
      const type = mtCommitteeText(row.transTypeDesr); if (!COMMITTEE_LABELS.has(type)) continue;
      if (row.lineItemCompositeDescr !== type || row.previousTransactionInd !== "N") mtCommitteeHold("unresolved_committee_version");
      const code = mtCommitteeText(row.transTypeCode), composite = mtCommitteeText(row.lineItemCompositeCode).split(",");
      if (!/^[1-9]\d*$/.test(code) || composite.length !== 3 || composite[0] !== code || !["C5", "C7"].includes(composite[1]!) || composite[2] !== "A" ||
        type === "Independent Committee Contributions" && code !== "5" || type === "Political Party Committee Contributions" && code !== "6") mtCommitteeHold("contradictory_committee_receipt_code");
      const entity = mtCommitteeObject(row.entityDTO), entityId = mtCommitteeInteger(row.entIdFrom, 1), kind = mtCommitteeText(row.committeeTypeCode);
      if (entity.entityTypeCode !== "CM" || mtCommitteeInteger(entity.entId, 1) !== entityId || !COMMITTEE_TYPES.has(kind) ||
        entity.committeeTypeCode !== null && entity.committeeTypeCode !== undefined && entity.committeeTypeCode !== kind) mtCommitteeHold("contradictory_reported_committee_identity");
      const selected = receipt(row, entity.entityName, "search"), list = byReport.get(reportId) ?? []; list.push(selected); byReport.set(reportId, list);
      selectedRows++; if (selected.cents >= 0) positiveCents = add(positiveCents, selected.cents); else negativeCents = add(negativeCents, selected.cents);
      const group = groups.get(entityId) ?? { key: `entity:${entityId}`, name: selected.name, sourceEntityId: entityId, cents: 0, rowCount: 0, committeeTypes: [] };
      group.cents = add(group.cents, selected.cents); group.rowCount++; if (!group.committeeTypes.includes(kind)) group.committeeTypes.push(kind);
      if (selected.name.localeCompare(group.name) < 0) group.name = selected.name; groups.set(entityId, group);
    }
  }
  if (receivingRows !== expected) mtCommitteeHold("incomplete_receiving_pages");
  const controls = reports.map(report => {
    const details = detailMap.get(report.reportId)!, financial = byReport.get(report.reportId) ?? [];
    const sorted = (rows: Receipt[]) => rows.map(mtCommitteeCanonical).sort(); if (mtCommitteeCanonical(sorted(details)) !== mtCommitteeCanonical(sorted(financial))) mtCommitteeHold("report_committee_multiset_mismatch");
    return { ...report, committeeRows: details.length, cashCents: details.reduce((n, r) => add(n, r.cashCents), 0),
      inKindCents: details.reduce((n, r) => add(n, r.inKindCents), 0), totalCents: details.reduce((n, r) => add(n, r.cents), 0) };
  });
  if ([...groups.values()].some(g => g.cents < 0)) mtCommitteeHold("negative_reported_entity_balance");
  const canceled = [...groups.values()].filter(g => g.cents === 0), positive = [...groups.values()].filter(g => g.cents > 0)
    .map(g => ({ ...g, committeeTypes: g.committeeTypes.sort() })).sort((a, b) => b.cents - a.cents || a.key.localeCompare(b.key));
  const totalCents = add(positiveCents, negativeCents); if (positive.reduce((n, g) => add(n, g.cents), 0) !== totalCents) mtCommitteeHold("reported_group_closure");
  return { totalCents, receivingRows, selectedRows, positiveCents, negativeCents, canceledGroupCount: canceled.length,
    canceledRowCount: canceled.reduce((n, g) => n + g.rowCount, 0), reports: controls, groups: positive };
}
