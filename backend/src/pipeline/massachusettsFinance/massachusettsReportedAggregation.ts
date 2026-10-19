import { aggregateMassachusettsReportedCommittees } from "./massachusettsReportedCommitteeAggregator.js";
import { isMassachusettsReceiverPacket, type MassachusettsReceiverPacket } from "./massachusettsReportedSource.js";
import { maAdd, maCanonical, maCents, maDay, maHold, maLiteral, MassachusettsReportedHold, type MassachusettsReportedKind } from "./massachusettsReportedCore.js";
import type { MassachusettsReportedReceiver } from "./massachusettsReportedReceiver.js";
import { normalizeMassachusettsCandidateNameKeys } from "./massachusettsCandidateCommitteeResolver.js";
import { hasMiddleNameConflict } from "../finance/personNameMiddleEvidence.js";

export type MassachusettsReportedGroup = { key: string; name: string; sourceClass: string; stance: "direct" | "support" | "oppose"; cents: number; occurrences: number };
export type MassachusettsReportedAggregation = { totalCents: number; supportCents: number; opposeCents: number; sourceRows: number; includedRows: number; groups: MassachusettsReportedGroup[] };
const text = (v: unknown): string => typeof v === "string" ? maLiteral(v) : "";
/** A surname match only vetoes an uncertain allocation. Positive money always
 * requires the native receiving CPF, current profile, and explicit stance. */
function possibleTarget(raw: string, receiver: MassachusettsReportedReceiver): boolean {
  const tokens = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toUpperCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const compact = tokens(raw).join("");
  return [receiver.candidateName, receiver.fullName].some(n => {
    const parts = tokens(n).filter(p => !["JR", "SR", "II", "III", "IV"].includes(p));
    return !parts.length || compact.includes(parts.at(-1)!);
  });
}
export function aggregateMassachusettsReported(receiver: MassachusettsReportedReceiver, source: MassachusettsReceiverPacket): MassachusettsReportedAggregation {
  if (!isMassachusettsReceiverPacket(source) || maCanonical(receiver) !== maCanonical(source.receiver)) maHold("unverified_receiving_source");
  const p = source.packet;
  if (p.kind === "committee") {
    const a = aggregateMassachusettsReportedCommittees({ receivingCpfId: receiver.entityId, electionYear: 2026, observedDay: source.sourceAt.slice(0, 10), rows: source.rows });
    return { totalCents: a.cents, supportCents: 0, opposeCents: 0, sourceRows: source.rows.length, includedRows: a.occurrences, groups: a.groups.map(g => ({ ...g, stance: "direct" })) };
  }
  return aggregateMassachusettsNativeIe(receiver, p.reports, p.sourceAt.slice(0, 10));
}
/** Pure native fixture seam; only the branded wrapper above can reach storage. */
export function aggregateMassachusettsNativeIe(receiver: MassachusettsReportedReceiver, reports: { iepac: boolean; value: any }[], observedDay: string): MassachusettsReportedAggregation {
  const groups = new Map<string, MassachusettsReportedGroup>();
  let support = 0, oppose = 0, included = 0, sourceRows = 0;
  for (const { iepac, value: v } of reports) {
    if (!Array.isArray(v.expenditures)) maHold("expense_array");
    const rows = v.expenditures; sourceRows += rows.length;
    let closed = true, sum = 0;
    const ids = new Set<string>();
    try {
      for (const r of rows) {
        if (r.reportId !== v.reportId || !["string", "number"].includes(typeof r.id) || !String(r.id) || ids.has(String(r.id))) maHold("expense_identity");
        ids.add(String(r.id)); sum = maAdd(sum, maCents(r.amount));
      }
      if (sum !== maCents(v.expenditureTotal) || (iepac && (maCents(v.expenditureUnitemizedTotal) !== 0 || maCents(v.expenditureItemizedTotal) !== sum))) closed = false;
    } catch (e) { if (!(e instanceof MassachusettsReportedHold)) throw e; closed = false; }
    // An unallocated nonzero cover (or malformed cover) cannot establish an
    // absence for any receiver. An identified bad parent holds its targets.
    if (!rows.length && !closed) maHold("unallocated_unreconciled_report");
    for (const r of rows) {
      const target = iepac ? r.relatedCpfId : r.relatedCandidateCpfId;
      const name = text(iepac ? r.affectedCandidateName : r.relatedCandidateName);
      const validId = Number.isSafeInteger(target) && target > 0;
      if (!validId && (!name || possibleTarget(name, receiver))) maHold("unallocated_ie_target");
      if (String(target) !== receiver.entityId) {
        if (name && possibleTarget(name, receiver)) maHold("contradictory_ie_target");
        continue;
      }
      if (!closed) maHold("unreconciled_ie_parent");
      if (!name || /[;&/]|\b(?:and|or)\b/i.test(name)) maHold("joint_ie_target");
      // Identity comes from CPF. The printed target must corroborate it;
      // accepting a contradictory name would turn a source mistake into money.
      const keys = normalizeMassachusettsCandidateNameKeys(name),
        corroborates = [...normalizeMassachusettsCandidateNameKeys(receiver.candidateName)].some(k => keys.has(k));
      if (!corroborates || hasMiddleNameConflict({ candidateName: receiver.candidateName, rowNames: [name],
        normalizePersonName: n => [...normalizeMassachusettsCandidateNameKeys(n)][0] ?? "" })) maHold("contradictory_ie_target");
      const day = maDay(r.date);
      if (day > observedDay) maHold("future_ie_expense");
      if (!day.startsWith("2026-")) continue;
      const amount = maCents(r.amount);
      if (amount <= 0) maHold("unknown_or_corrected_ie_amount");
      const stance = iepac ? (r.isSupported === true ? "support" : r.isSupported === false ? "oppose" : null)
        : r.expenditurePosition === "Supported" ? "support" : r.expenditurePosition === "Opposed" ? "oppose" : null;
      if (!stance) maHold("ie_stance");
      if (iepac && r.recordTypeDescription !== "Independent Expenditure") maHold("ie_expense_type");
      const payer = text(iepac ? v.committeeName : v.filingEntityFull), sourceClass = iepac ? "IEPAC" : "reported independent spender";
      if (!payer || /[\u0000-\u001f\u007f]/.test(payer)) maHold("ie_payer");
      // Ordinary report contact IDs do not establish registered filer IDs.
      const sourceId = iepac ? String(v.cpfId) : "";
      if (iepac && (!Number.isSafeInteger(v.cpfId) || v.cpfId <= 0)) maHold("iepac_payer_identity");
      const key = JSON.stringify([sourceClass, sourceId, payer.toUpperCase(), stance]),
        g = groups.get(key) ?? { key, name: payer, sourceClass, stance, cents: 0, occurrences: 0 };
      g.cents = maAdd(g.cents, amount); g.occurrences++; groups.set(key, g); included++;
      if (stance === "support") support = maAdd(support, amount); else oppose = maAdd(oppose, amount);
    }
  }
  return { totalCents: maAdd(support, oppose), supportCents: support, opposeCents: oppose, sourceRows, includedRows: included, groups: [...groups.values()].sort((a,b) => a.key.localeCompare(b.key)) };
}
export function validateMassachusettsReportedClosure(a: MassachusettsReportedAggregation, kind: MassachusettsReportedKind): void {
  const nn = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (!a || ![a.totalCents, a.supportCents, a.opposeCents, a.sourceRows, a.includedRows].every(nn) || a.includedRows > a.sourceRows || !Array.isArray(a.groups)) maHold("stored_controls");
  let total = 0, support = 0, oppose = 0, count = 0;
  const seen = new Set<string>();
  for (const g of a.groups) {
    if (!g || ![g.key,g.name,g.sourceClass].every(v => typeof v === "string" && !!v && v === maLiteral(v) && !/[\u0000-\u001f\u007f]/.test(v)) || seen.has(g.key) || !nn(g.cents) || !g.cents || !nn(g.occurrences) || !g.occurrences) maHold("stored_group");
    let k: any; try { k = JSON.parse(g.key); } catch { maHold("stored_group_key"); }
    if (!Array.isArray(k) || k[0] !== g.sourceClass || typeof k[1] !== "string" || (k[1] !== "" && !/^[1-9]\d*$/.test(k[1])) || k[2] !== g.name.toUpperCase() ||
      (kind === "committee" ? k.length !== 3 || g.sourceClass !== "Committee" || g.stance !== "direct" : k.length !== 4 || !["IEPAC", "reported independent spender"].includes(g.sourceClass) || k[3] !== g.stance || !["support", "oppose"].includes(g.stance) || (g.sourceClass === "IEPAC" ? !k[1] : !!k[1]))) maHold("stored_group_identity");
    seen.add(g.key); total = maAdd(total,g.cents); count = maAdd(count,g.occurrences);
    if (g.stance === "support") support = maAdd(support,g.cents);
    if (g.stance === "oppose") oppose = maAdd(oppose,g.cents);
  }
  if (total !== a.totalCents || support !== a.supportCents || oppose !== a.opposeCents || count !== a.includedRows || (kind === "ie" && total !== maAdd(support,oppose))) maHold("stored_group_closure");
}
