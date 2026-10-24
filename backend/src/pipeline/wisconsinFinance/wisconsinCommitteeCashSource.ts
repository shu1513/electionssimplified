import { createRequire } from "node:module";
import { normalizeWisconsinCandidateNameForStorage, normalizeWisconsinCandidateNameKeys } from "./wisconsinCandidateCommitteeResolver.js";
import { firstNameVariants } from "../finance/personFirstNameNicknames.js";
import { hasMiddleNameConflict } from "../finance/personNameMiddleEvidence.js";
import { normalizeWisconsinSunshineLegislativeDistrict, toWisconsinSunshineOfficeSearchInput } from "./wisconsinFinanceEligibleOffices.js";
import { WisconsinPublicSourceReader, wisconsinSourceCheck as check, type WisconsinPublicSourceOptions } from "./wisconsinSunshineArtifactCache.js";

type Row = Record<string, unknown>;
export type WisconsinCashContext = {
  candidateId: string; electionId: string; candidateName: string; candidateLastName: string;
  electionYear: number; electionDate: string; officeScope: string; officeName: string; district: string | null;
};
export type WisconsinCashDonor = {
  committeeId: string; committeeName: string; amountCents: number; contributionCount: number;
  evidence: "native_registry_class" | "reported_pac_name"; sourceUrl: string;
};
export type WisconsinCashPacket = {
  context: Readonly<WisconsinCashContext>; entityId: string; committeeId: string; committeeName: string;
  observedAt: string; sourceUrl: string; regularCoverageThrough: string;
  reportCount: number; occurrenceCount: number; monetaryReceiptCount: number;
  excludedInKindCount: number; excludedLoanCount: number; excludedOtherIncomeCount: number;
  returnedContributionCount: number; donors: readonly Readonly<WisconsinCashDonor>[];
};
const accepted = new WeakSet<object>();
const ORIGIN = "https://campaignfinance.wi.gov";
// Only the current source classes qualified for this component. A new class is
// a research gap, not permission to silently drop a registered monetary payer.
const COMMITTEE_CLASSES = new Set(["State Candidate", "Political Party", "PAC"]);
const text = (s: string) => s.replace(/\s+/g, " ").trim();
function object(v: unknown): Row { check(v !== null && typeof v === "object" && !Array.isArray(v), "object_shape"); return v as Row; }
function list(v: unknown): unknown[] { check(Array.isArray(v), "array_shape"); return v; }
function name(v: unknown): string {
  check(typeof v === "string" && text(v).length > 0 && text(v).length <= 500 && !/[\u0000\uFFFD]/.test(v), "source_name"); return text(v);
}
function id(v: unknown): number { check(Number.isSafeInteger(v) && (v as number) > 0, "native_id"); return v as number; }
function day(v: unknown): string {
  check(typeof v === "string" && /^\d{4}-\d{2}-\d{2}(?:T.*Z)?$/.test(v), "source_date");
  const d = new Date(v); check(Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v.slice(0, 10), "source_date"); return v.slice(0, 10);
}
function add(a: number, b: number): number { const n = a + b; check(Number.isSafeInteger(n), "unsafe_cent_sum"); return n; }
function cents(v: unknown): number {
  check(typeof v === "number" && Number.isFinite(v) && /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(String(v)), "source_money");
  const n = Math.round(v * 100); check(Number.isSafeInteger(n) && n > 0, "source_money"); return n;
}
function personMatches(canonical: string, source: string): boolean {
  const keys = normalizeWisconsinCandidateNameKeys(canonical, { expandNicknames: true });
  return [...normalizeWisconsinCandidateNameKeys(source)].some(k => keys.has(k)) && !hasMiddleNameConflict({
    candidateName: canonical, rowNames: [source], normalizePersonName: normalizeWisconsinCandidateNameForStorage,
    firstNamesEquivalent: (a, b) => a === b || firstNameVariants(a).includes(b),
  });
}
export function selectWisconsinCashReceiver(rows: readonly Row[], context: WisconsinCashContext): Row {
  const office = toWisconsinSunshineOfficeSearchInput({ officeScope: context.officeScope, officeCanonicalName: context.officeName, district: context.district });
  check(office && Number.isInteger(context.electionYear) && context.electionYear >= 2000 && context.electionYear <= 2100
    && day(context.electionDate).startsWith(`${context.electionYear}-`), "canonical_context");
  const matches = rows.filter(row => {
    if (object(row.committeeType).name !== "State Candidate" || object(row.committeeStatus).name !== "Approved") return false;
    const roles = list(row.entityConnections).map(object).filter(r => object(r.connectionType).isCandidate === true);
    if (roles.length !== 1 || !personMatches(context.candidateName, name(object(roles[0]!.entity).name))) return false;
    const events = list(row.eventConnections).map(object); if (events.length !== 1) return false;
    const e = events[0]!;
    if (object(e.office).name !== office.sunshineOffice || day(object(e.event).date) !== context.electionDate || e.branch !== null) return false;
    if (office.district === null) return e.district === null;
    const district = name(object(e.district).name).replace(/^District\s*/i, "");
    return normalizeWisconsinSunshineLegislativeDistrict(district) === office.district;
  });
  check(matches.length === 1, "receiver_identity_ambiguous"); id(matches[0]!.id); id(object(matches[0]!.entity).id); return matches[0]!;
}
function profileConfirmsReportedPac(body: string, url: string, reportedName: string): void {
  const { JSDOM, VirtualConsole } = createRequire(import.meta.url)("jsdom") as {
    JSDOM: new (html: string, options: { url: string; virtualConsole: unknown }) => { window: { document: Document; close(): void } };
    VirtualConsole: new () => unknown;
  };
  const window = new JSDOM(body, { url, virtualConsole: new VirtualConsole() }).window;
  try {
    const d = window.document; d.querySelectorAll("script,style").forEach(n => n.remove());
    const labels = [...d.querySelectorAll("p")].filter(n => text(n.textContent ?? "") === "Registrant Type");
    check(labels.length === 1 && labels[0]!.nextElementSibling?.tagName === "P"
      && text(labels[0]!.nextElementSibling?.textContent ?? "") === "Unregistered", "reported_pac_profile");
    check(text(d.body.textContent ?? "").toUpperCase().includes(text(reportedName).toUpperCase()), "reported_pac_profile_name");
  } finally { window.close(); }
}
/** No callers can construct a writable packet from pre-aggregated rows. */
export function assertWisconsinCashPacket(packet: WisconsinCashPacket): void { check(accepted.has(packet), "unverified_packet"); }
export async function loadWisconsinCommitteeCashPacket(context: WisconsinCashContext, options: WisconsinPublicSourceOptions): Promise<WisconsinCashPacket> {
  context = Object.freeze({ ...context });
  const reader = new WisconsinPublicSourceReader(options), start = `${context.electionYear - 1}-01-01`, end = `${context.electionYear}-12-31`;
  const registry = await reader.closedRows("publicFrontendApi.getCommittees", "publicFrontendApi.getCommitteesCount",
    { searchTerm: name(context.candidateLastName) }, "receiver", "createdAt");
  const receiver = selectWisconsinCashReceiver(registry, context), entity = object(receiver.entity), entityId = id(entity.id);
  const reports = await reader.closedRows("publicFrontendApi.getReports", "publicFrontendApi.getReportsCount",
    { committeeEntityId: [entityId] }, "reports", "latestSubmissionAt");
  check(reports.length > 0 && reports.every(r => id(object(object(r.committee).entity).id) === entityId), "report_receiver");
  const templateIds = [...new Set(reports.map(r => id(object(r.reportTemplate).id)))];
  const templates = list(await reader.trpc("reportMeta.getReportTemplates", { specificIds: templateIds }, "templates")).map(object);
  check(new Set(templates.map(t => id(t.id))).size === templates.length && templates.every(t => templateIds.includes(id(t.id))), "template_inventory");
  const selected = reports.filter(r => {
    const template = templates.find(t => t.id === object(r.reportTemplate).id);
    if (!template) { check(day(r.latestSubmissionAt) < start, "missing_current_template"); return false; }
    return day(template.transactionsEndDate) >= start && day(template.transactionsStartDate) <= end;
  });
  check(selected.length > 0, "missing_current_reports");
  const parents = new Map<number, { report: Row; template: Row; submission: Row; count: number }>();
  for (const report of selected) {
    const submissions = list(report.reportSubmissions).map(object);
    check(submissions.length === 1, "amendment_lineage_unqualified");
    const current = list(await reader.trpc("publicFrontendApi.getReportSubmissionsData", { reportId: id(report.id) }, "parent")).map(object);
    check(current.length === 1 && current[0]!.id === submissions[0]!.id && current[0]!.certified === true
      && current[0]!.reportId === report.id, "filed_parent_changed");
    const count = object(current[0]!._count).transactions;
    check(Number.isSafeInteger(count) && (count as number) >= 0, "parent_count");
    const template = templates.find(t => t.id === object(report.reportTemplate).id)!;
    check(["PERIODIC", "EVENT_TRIGGERED"].includes(String(template.templateType)), "template_type");
    parents.set(id(report.id), { report, template, submission: current[0]!, count: count as number });
  }
  const ledger = await reader.closedRows("publicFrontendApi.getTransactions", "publicFrontendApi.getTransactionsTotalCount",
    { createdByEntityId: [entityId], dateFrom: start, dateTo: end }, "ledger", "date");
  const categories = list(await reader.trpc("transactionMeta.getTransactionCategories", {}, "categories")).map(object);
  check(new Set(categories.map(c => id(c.id))).size === categories.length, "category_inventory");
  const observedDay = day(reader.observedAt()), refs = new Map<number, number>();
  const monetary: Row[] = [], returns: Row[] = []; let excludedInKindCount = 0, excludedLoanCount = 0, excludedOtherIncomeCount = 0;
  for (const row of ledger) {
    check(row.createdByEntityId === entityId && id(object(row.createdByEntity).id) === entityId, "ledger_receiver");
    const date = day(row.date); check(date >= start && date <= end && date <= observedDay, "ledger_period"); cents(row.amount);
    check(row.relatedPayer === null, "related_payer_unqualified");
    const category = categories.find(c => c.id === id(object(row.transactionCategory).id)); check(category, "unknown_category");
    const type = id(object(row.transactionType).id); check(type === category.transactionTypeId, "category_type");
    for (const key of ["isCashAdd", "isCashRemove", "isInKind", "isDebtAdd", "isDebtRemove", "isOtherIncome", "isTransactionReturn", "isRedirection"]) check(typeof category[key] === "boolean", "category_flags");
    const references = list(row.reports).map(object); check(references.length > 0 && new Set(references.map(r => id(r.id))).size === references.length, "unfiled_or_repeated_parent");
    let regular = false, notice = false;
    for (const reference of references) {
      const parent = parents.get(id(reference.id)); check(parent, "unknown_current_parent");
      check(date >= day(parent.template.transactionsStartDate) && date <= day(parent.template.transactionsEndDate), "parent_period");
      refs.set(id(reference.id), (refs.get(id(reference.id)) ?? 0) + 1);
      regular ||= parent.template.templateType === "PERIODIC"; notice ||= parent.template.templateType === "EVENT_TRIGGERED";
    }
    // A notice inside a filed regular period must reference that regular parent
    // on the same current transaction. Never deduplicate lookalike cash gifts.
    if (notice && !regular) check(![...parents.values()].some(p => p.template.templateType === "PERIODIC"
      && date >= day(p.template.transactionsStartDate) && date <= day(p.template.transactionsEndDate)), "notice_overlap_unqualified");
    if (category.isInKind) excludedInKindCount++;
    if (type === 1 && category.isDebtAdd) excludedLoanCount++;
    if (type === 1 && category.isOtherIncome) excludedOtherIncomeCount++;
    if (category.code === "MOC") {
      check(type === 1 && category.isCashAdd === true && category.isCashRemove === false && !category.isDebtAdd
        && !category.isInKind && !category.isOtherIncome && !category.isRedirection && id(object(row.to_entity).id) === entityId, "monetary_receipt_semantics"); monetary.push(row);
    } else if (type === 1 && category.isCashAdd && !category.isDebtAdd && !category.isOtherIncome) check(false, "other_cash_receipt_unqualified");
    if (category.code === "RTDC") {
      check(type === 2 && category.isCashRemove === true && category.isTransactionReturn === true && id(object(row.from_entity).id) === entityId, "returned_cash_semantics"); returns.push(row);
    } else if (category.isTransactionReturn && category.isCashRemove) check(false, "other_cash_return_unqualified");
  }
  for (const [rid, parent] of parents) check((refs.get(rid) ?? 0) === parent.count, "parent_count_mismatch");
  // Template bounds can overlap across reporting schedules. Check their date
  // union; monetary aggregation uses the one global transaction ledger above,
  // never a sum of report windows or lookalike-gift deduplication.
  const regularParents = [...parents.values()].filter(p => p.template.templateType === "PERIODIC");
  check(new Set(regularParents.map(p => p.template.id)).size === regularParents.length, "duplicate_regular_period");
  const periods = regularParents.map(p => ({
    start: day(p.template.transactionsStartDate) < start ? start : day(p.template.transactionsStartDate),
    end: day(p.template.transactionsEndDate) > end ? end : day(p.template.transactionsEndDate),
  })).sort((a, b) => a.start.localeCompare(b.start));
  check(periods.length > 0 && periods[0]!.start === start, "window_start_missing");
  let through = periods[0]!.end;
  for (const p of periods) {
    const next = new Date(`${through}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
    check(p.start <= next.toISOString().slice(0, 10) && p.end <= observedDay, "regular_coverage_gap");
    if (p.end > through) through = p.end;
  }
  const donors = new Map<number, WisconsinCashDonor>(), classifications = new Map<number, WisconsinCashDonor["evidence"] | null>();
  const payerIdentities = new Map<number, { name: string; type: unknown }>();
  const classify = async (entityValue: unknown, hasOccupation: boolean) => {
    const payer = object(entityValue), type = object(payer.entityType).entityTypeOf;
    check(["PERSON", "ANONYMOUS", "COMMITTEE", "BUSINESS_OR_ORG", "DEPOSITORY_OR_BANK"].includes(String(type)), "payer_type");
    if (["PERSON", "ANONYMOUS", "DEPOSITORY_OR_BANK"].includes(String(type))) return null;
    const key = id(payer.id), payerName = name(payer.name), prior = payerIdentities.get(key);
    check(!prior || (prior.name.toUpperCase() === payerName.toUpperCase() && prior.type === type), "donor_identity_changed");
    payerIdentities.set(key, { name: payerName, type });
    if (classifications.has(key)) {
      check(classifications.get(key) !== "reported_pac_name" || !hasOccupation, "registrant_class_unqualified");
      return classifications.get(key)!;
    }
    const found = await reader.closedRows("publicFrontendApi.getCommittees", "publicFrontendApi.getCommitteesCount",
      { searchTerm: payerName }, "donor-registry", "createdAt");
    const matched = found.filter(n => id(object(n.entity).id) === key); check(matched.length <= 1, "donor_registry_ambiguous");
    let evidence: WisconsinCashDonor["evidence"] | null = null;
    if (matched.length) { check(COMMITTEE_CLASSES.has(name(object(matched[0]!.committeeType).name)), "donor_class_unqualified"); evidence = "native_registry_class"; }
    else if (type === "COMMITTEE") {
      check(!hasOccupation && /\b(PAC|POLITICAL ACTION COMMITTEE|POLITICAL COMMITTEE)\b/i.test(payerName), "registrant_class_unqualified");
      const url = `${ORIGIN}/browse-data/registrant/${key}`;
      profileConfirmsReportedPac(await reader.read(url, "donor-profile"), url, payerName); evidence = "reported_pac_name";
    }
    classifications.set(key, evidence); return evidence;
  };
  for (const [rows, sign] of [[monetary, 1], [returns, -1]] as const) for (const row of rows) {
    const payer = object(sign === 1 ? row.from_entity : row.to_entity), evidence = await classify(payer, sign === 1 && !!row.fromOccupationTitle);
    if (!evidence) continue;
    const key = id(payer.id), reportedName = name(payer.name), current = donors.get(key) ?? {
      committeeId: String(key), committeeName: reportedName, amountCents: 0, contributionCount: 0, evidence,
      sourceUrl: `${ORIGIN}/browse-data/registrant/${key}`,
    };
    check(current.committeeName.toUpperCase() === reportedName.toUpperCase() && current.evidence === evidence, "donor_identity_changed");
    current.amountCents = add(current.amountCents, sign * cents(row.amount)); if (sign === 1) current.contributionCount++;
    donors.set(key, current);
  }
  const frozen = [...donors.values()].sort((a, b) => b.amountCents - a.amountCents || a.committeeName.localeCompare(b.committeeName)).map(d => Object.freeze(d));
  frozen.reduce((sum, d) => add(sum, d.amountCents), 0);
  const packet: WisconsinCashPacket = Object.freeze({ context: Object.freeze({ ...context }), entityId: String(entityId), committeeId: String(id(receiver.id)),
    committeeName: name(entity.name), observedAt: reader.observedAt(), sourceUrl: `${ORIGIN}/browse-data/registrant/${entityId}`,
    regularCoverageThrough: through, reportCount: parents.size, occurrenceCount: ledger.length, monetaryReceiptCount: monetary.length,
    excludedInKindCount, excludedLoanCount, excludedOtherIncomeCount, returnedContributionCount: returns.length, donors: Object.freeze(frozen) });
  accepted.add(packet); return packet;
}
