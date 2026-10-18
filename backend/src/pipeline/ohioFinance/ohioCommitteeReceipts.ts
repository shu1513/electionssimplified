import { isBlankOhioSosCoverPageRow, type OhioSosCandidateCommitteeListRow, type OhioSosPacCommitteeListRow,
  type OhioSosContributionRow, type OhioSosCoverPageRow } from "./ohioSosBulkFiles.js";

export class OhioCommitteeReceiptError extends Error {
  constructor(readonly code: string) { super(`Ohio committee receipts unavailable: ${code}`); this.name = "OhioCommitteeReceiptError"; }
}
export function ohioCommitteeHold(code: string): never { throw new OhioCommitteeReceiptError(code); }
export const ohioCommitteeTextKey = (v: string | null | undefined) => (v ?? "").normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/&/g, " AND ").replace(/[^A-Z0-9]+/g, " ").trim().replace(/\s+/g, " ");
const upper = (v: string | null | undefined) => (v ?? "").toUpperCase().trim().replace(/\s+/g, " ");
const text = (v: string | null | undefined) => {
  if (!v?.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(v)) ohioCommitteeHold("invalid_reported_name");
  return v.normalize("NFC").trim().replace(/\s+/g, " ");
};
const id = (v: string) => { if (!/^[1-9]\d*$/.test(v)) ohioCommitteeHold("invalid_native_key"); return v; };
const add = (a: number, b: number) => { const n = a + b; if (!Number.isSafeInteger(n)) ohioCommitteeHold("unsafe_receipt_sum"); return n; };

/** Unlike the legacy parser, this component never rounds fractional cents.
 * Extra zero decimal places in the native numeric export are harmless. */
export function strictOhioCommitteeCents(raw: string | undefined): number | null {
  const s = (raw ?? "").trim().replace(/[$,]/g, ""); if (!s) return null;
  const m = /^(-?)(\d*)(?:\.(\d+))?$/.exec(s);
  if (!m || !(m[2] || m[3]) || m[3]?.slice(2).replace(/0/g, "")) ohioCommitteeHold("invalid_native_money");
  const exact = (BigInt(m[2] || "0") * 100n + BigInt((m[3] ?? "").slice(0, 2).padEnd(2, "0"))) * (m[1] ? -1n : 1n);
  if (exact > BigInt(Number.MAX_SAFE_INTEGER) || exact < BigInt(Number.MIN_SAFE_INTEGER)) ohioCommitteeHold("unsafe_native_money");
  return Number(exact);
}
export function normalizeOhioReportedRegistration(raw: string | null | undefined): string {
  return upper(raw).replace(/^FEC\s*ID\s*/, "").replace(/^PAC\s*=\s*/, "")
    .replace(/^(OH|CP|LA|BI|PAC)\s*[- ]\s*(\d+)$/, "$1$2");
}
type CommitteeIdentity = { key: string; nativeCommitteeId: string | null; name: string;
  registration: string; evidence: "registry_name" | "registry_registration" | "reported_marker" | "reported_registration" };
type RegistryInput = { candidateListRows: readonly OhioSosCandidateCommitteeListRow[]; pacListRows: readonly OhioSosPacCommitteeListRow[];
  candidateCoverRows: readonly OhioSosCoverPageRow[]; pacCoverRows: readonly OhioSosCoverPageRow[]; partyCoverRows: readonly OhioSosCoverPageRow[] };

export function createOhioCommitteeRegistry(input: RegistryInput) {
  const names = new Map<string, Set<string>>(), registrations = new Map<string, Set<string>>();
  const insert = (map: Map<string, Set<string>>, key: string, value: string) => {
    if (!key) return; const set = map.get(key) ?? new Set<string>(); set.add(value); map.set(key, set);
  };
  for (const row of [...input.candidateListRows, ...input.pacListRows, ...input.candidateCoverRows, ...input.pacCoverRows, ...input.partyCoverRows]) {
    const nativeId = id(row.masterKey), name = ohioCommitteeTextKey(row.committeeName);
    if (!name) ohioCommitteeHold("invalid_registry_name"); insert(names, name, nativeId);
    if ("pacRegNo" in row && row.pacRegNo) insert(registrations, normalizeOhioReportedRegistration(row.pacRegNo), nativeId);
  }
  return { classify(row: OhioSosContributionRow): CommitteeIdentity | null {
    const label = ohioCommitteeTextKey(row.nonIndividual), nameIds = names.get(label) ?? new Set<string>(),
      registration = normalizeOhioReportedRegistration(row.pacRegNo), regIds = registrations.get(registration) ?? new Set<string>(),
      marker = /^(?:PCE(?: ACCOUNT| #\d+)?|LOCAL(?: PAC)?|FEDERAL PAC|PAC)$/.test(registration);
    const result = (nativeId: string | null, evidence: CommitteeIdentity["evidence"]): CommitteeIdentity => {
      const name = text(row.nonIndividual);
      return { key: nativeId ? `committee:${nativeId}` : `reported:${registration}|${label}`, nativeCommitteeId: nativeId, name, registration, evidence };
    };
    if (nameIds.size === 1) {
      const nativeId = [...nameIds][0]!;
      if (!marker && regIds.size && !regIds.has(nativeId)) ohioCommitteeHold("contradictory_committee_evidence");
      return result(nativeId, "registry_name");
    }
    if (!marker && regIds.size === 1 && nameIds.size === 0 && label) return result([...regIds][0]!, "registry_registration");
    // Form 31-A explicitly permits PCE/local labels instead of a registration
    // number. Keep a reported group, never assign an invented native identity.
    if (label && (marker || /^(?:C\d{8}|(?:OH|CP|LA|BI|PAC)\d+|[1-9]\d*)$/.test(registration)))
      return result(null, marker ? "reported_marker" : "reported_registration");
    if (nameIds.size > 1 || !marker && regIds.size > 1) ohioCommitteeHold("ambiguous_committee_evidence");
    if (registration && !["N/A", "NA", "NONE", "0", "NOT APPLICABLE"].includes(registration)) ohioCommitteeHold("unknown_committee_evidence");
    return null;
  } };
}

type Group = { key: string; name: string; nativeCommitteeId: string | null; cents: number; rowCount: number };
type Report = { reportKey: string; year: number; description: string; cashCents: number; inKindCents: number;
  receiptRows: number; selectedRows: number; positiveCents: number; negativeCents: number; groups: Map<string, Group>; holds: Set<string> };
export type OhioCommitteeReportCover = OhioSosCoverPageRow & { invalidCommitteeMoney?: boolean };

/** Streams the complete current annual view once. Identical occurrences stay
 * separate; native report membership and cover totals establish completeness. */
export function createOhioCommitteeReceiptAccumulator(input: RegistryInput & { electionYear: number }) {
  if (!Number.isInteger(input.electionYear) || input.electionYear < 2000 || input.electionYear > 2100) ohioCommitteeHold("invalid_cycle");
  const registry = createOhioCommitteeRegistry(input), reports = new Map<string, Map<string, Report>>(); let finished = false;
  const years = [input.electionYear - 1, input.electionYear];
  return {
    add(row: OhioSosContributionRow, transactionYear: number) {
      if (finished) ohioCommitteeHold("finished_source_accumulator");
      if (!years.includes(transactionYear)) ohioCommitteeHold("wrong_source_year");
      const master = id(row.masterKey), reportKey = id(row.reportKey), byReport = reports.get(master) ?? new Map<string, Report>();
      reports.set(master, byReport);
      const report = byReport.get(reportKey) ?? { reportKey, year: transactionYear, description: upper(row.reportDescription), cashCents: 0,
        inKindCents: 0, receiptRows: 0, selectedRows: 0, positiveCents: 0, negativeCents: 0, groups: new Map<string, Group>(), holds: new Set<string>() };
      byReport.set(reportKey, report); report.receiptRows++;
      if (row.reportYear !== transactionYear || report.year !== transactionYear || report.description !== upper(row.reportDescription)) report.holds.add("receipt_report_context_mismatch");
      const form = upper(row.shortDescription);
      if (form === "31-A-2 OTHER INCOME") return;
      if (!["31-A STMT OF CONTRIBUTION", "31-E FR CONTRIBUTIONS", "31-J-1 IN-KIND CONT RCVD"].includes(form)) { report.holds.add("unsupported_receipt_role"); return; }
      if (row.amountCents === null || !Number.isSafeInteger(row.amountCents)) { report.holds.add("invalid_receipt_money"); return; }
      if (form === "31-J-1 IN-KIND CONT RCVD") report.inKindCents = add(report.inKindCents, row.amountCents);
      else report.cashCents = add(report.cashCents, row.amountCents);
      try {
        const donor = registry.classify(row); if (!donor) return;
        const group = report.groups.get(donor.key) ?? { key: donor.key, name: donor.name, nativeCommitteeId: donor.nativeCommitteeId, cents: 0, rowCount: 0 };
        group.cents = add(group.cents, row.amountCents); group.rowCount++;
        if (donor.name.localeCompare(group.name) < 0) group.name = donor.name; report.groups.set(donor.key, group);
        report.selectedRows++; if (row.amountCents >= 0) report.positiveCents = add(report.positiveCents, row.amountCents);
        else report.negativeCents = add(report.negativeCents, row.amountCents);
      } catch (e) { if (!(e instanceof OhioCommitteeReceiptError)) throw e; report.holds.add(e.code); }
    },
    finish() {
      if (finished) ohioCommitteeHold("finished_source_accumulator"); finished = true;
      return { component(committeeId: string) {
        id(committeeId); const selected = reports.get(committeeId) ?? new Map<string, Report>(),
          covers = input.candidateCoverRows.filter(c => c.masterKey === committeeId && c.reportYear !== null && years.includes(c.reportYear));
        if (!covers.length) ohioCommitteeHold("no_filed_reports");
        if (input.candidateCoverRows.some(c => c.masterKey === committeeId && c.reportYear === null)) ohioCommitteeHold("unavailable_report_scope");
        const keys = new Set<string>(), periods = new Set<string>(), groups = new Map<string, Group>(), controls = [];
        let selectedRows = 0, receivingRows = 0, positiveCents = 0, negativeCents = 0;
        for (const cover of covers as OhioCommitteeReportCover[]) {
          id(cover.reportKey); const period = `${cover.reportYear}|${upper(cover.reportDescription)}`;
          if (keys.has(cover.reportKey) || periods.has(period)) ohioCommitteeHold("ambiguous_report_period"); keys.add(cover.reportKey); periods.add(period);
          if (isBlankOhioSosCoverPageRow(cover) || !cover.dateReportFiledIso || !upper(cover.reportDescription) || cover.invalidCommitteeMoney) ohioCommitteeHold("unavailable_report_cover");
          const report = selected.get(cover.reportKey), cash = cover.totalContributionsCents ?? 0, inKind = cover.valueInkindReceivedCents ?? 0;
          if (!Number.isSafeInteger(cash) || !Number.isSafeInteger(inKind) || (report?.cashCents ?? 0) !== cash || (report?.inKindCents ?? 0) !== inKind) ohioCommitteeHold("report_reconciliation_mismatch");
          if (report && (report.year !== cover.reportYear || report.description !== upper(cover.reportDescription))) ohioCommitteeHold("receipt_report_context_mismatch");
          if (report?.holds.size) ohioCommitteeHold([...report.holds].sort()[0]!);
          controls.push({ reportKey: cover.reportKey, year: cover.reportYear, description: upper(cover.reportDescription),
            filedAt: cover.dateReportFiledIso, cashCents: cash, inKindCents: inKind, receiptRows: report?.receiptRows ?? 0, selectedRows: report?.selectedRows ?? 0 });
          if (!report) continue; receivingRows = add(receivingRows, report.receiptRows); selectedRows = add(selectedRows, report.selectedRows);
          positiveCents = add(positiveCents, report.positiveCents); negativeCents = add(negativeCents, report.negativeCents);
          for (const group of report.groups.values()) {
            const existing = groups.get(group.key); if (!existing) groups.set(group.key, { ...group });
            else { existing.cents = add(existing.cents, group.cents); existing.rowCount = add(existing.rowCount, group.rowCount);
              if (group.name.localeCompare(existing.name) < 0) existing.name = group.name; }
          }
        }
        if ([...selected.keys()].some(k => !keys.has(k))) ohioCommitteeHold("receipt_report_missing_from_cover");
        if ([...groups.values()].some(g => g.cents < 0)) ohioCommitteeHold("negative_committee_balance");
        const canceled = [...groups.values()].filter(g => g.cents === 0), positive = [...groups.values()].filter(g => g.cents > 0), totalCents = add(positiveCents, negativeCents);
        if (positive.reduce((n, g) => add(n, g.cents), 0) !== totalCents) ohioCommitteeHold("committee_group_closure");
        return { totalCents, selectedRows, receivingRows, positiveCents, negativeCents, canceledGroupCount: canceled.length,
          canceledRowCount: canceled.reduce((n, g) => add(n, g.rowCount), 0), reports: controls.sort((a, b) => a.reportKey.localeCompare(b.reportKey)),
          groups: positive.sort((a, b) => b.cents - a.cents || a.key.localeCompare(b.key)) };
      } };
    },
  };
}
