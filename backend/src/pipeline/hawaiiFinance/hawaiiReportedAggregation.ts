import { hiAdd, hiCanonical, hiCents, hiDay, hiFreeze, hiHash, hiHold, hiNameKey, hiRequired, type HawaiiReportedKind } from "./hawaiiReportedCore.js";
import { aggregateHawaiiReportedCommittees } from "./hawaiiReportedCommitteeAggregator.js";
import { aggregateHawaiiReportedIe } from "./hawaiiReportedIeAggregator.js";
import { hiDirectLinkSeatMatches, hiPersonMatches, qualifyHawaiiOfficialReceiver } from "./hawaiiReportedIdentity.js";
import { isHawaiiReportedPacket, hawaiiReportedCacheRoot, hiGraphFacts, type HawaiiReportedPacket } from "./hawaiiReportedSource.js";
import { createHawaiiOriginalGraph, listHawaiiOriginalDirectories, readHawaiiOriginalGraph, type HawaiiOriginalGraph } from "./hawaiiReportedOriginals.js";
import { readHawaiiNativeFiler } from "./hawaiiReportedProtocol.js";
import { isHawaiiReportedRawRefreshEnabled } from "../../config/featureFlags.js";
import { hawaiiReportedReceiverContext, type HawaiiReportedReceiver } from "./hawaiiReportedReceiver.js";

export type HawaiiReportedGroup = { key: string; name: string; sourceClass: string; evidence: string; stance: "direct" | "support" | "oppose"; cents: number; occurrences: number };
export type HawaiiReportedAggregation = { sourceRows: number; includedRows: number; totalCents: number; supportCents: number; opposeCents: number; groups: HawaiiReportedGroup[] };
export type HawaiiReceiverPacket = Readonly<{ packet: HawaiiReportedPacket; receiverContext: string; sourceAt: string; sourceHash: string;
  profileAt: string; profileHash: string; profileStartedAt: string; nativeLedgerCents: number | null }>;
const receivers = new WeakSet<object>();
export const isHawaiiReceiverPacket = (v: unknown): v is HawaiiReceiverPacket => !!v && typeof v === "object" && receivers.has(v);
function baseReceiver(packet: HawaiiReportedPacket, receiver: HawaiiReportedReceiver): void {
  if (!isHawaiiReportedPacket(packet) || receiver.electionYear !== 2026 || receiver.electionDate !== "2026-11-03") hiHold("unverified_source_or_election");
  qualifyHawaiiOfficialReceiver({ ...receiver, seat: receiver, roster: packet.roster });
}
function directAggregation(p: HawaiiReportedPacket, receiver: HawaiiReportedReceiver) {
  const period = receiver.electionPeriod!, start = period === "2022-2026" ? "2022-11-09" : "2024-11-06", asOf = p.capturedAt.slice(0, 10);
  const senders = new Set<string>();
  for (const r of p.senderRows) {
    if (r.cc_reg_no !== receiver.entityId) continue;
    const day = hiDay(r.date); hiCents(r.amount);
    if (day >= start && day <= "2026-11-03" && day <= asOf) senders.add(hiNameKey(hiRequired(r.noncandidate_committee_name)));
  }
  return aggregateHawaiiReportedCommittees({ receivingCommitteeId: receiver.entityId!, electionPeriod: period, windowStart: start,
    windowEnd: "2026-11-03", asOfDay: asOf, rows: p.rows, registeredNoncandidateNames: new Set(p.registry.map(r => hiNameKey(r.name))), corroboratedSenderNames: senders });
}
export async function loadHawaiiReceiverPacket(packet: HawaiiReportedPacket, receiver: HawaiiReportedReceiver, options: {
  cacheDir?: string; refresh?: boolean;
} = {}): Promise<HawaiiReceiverPacket> {
  baseReceiver(packet, receiver);
  if (packet.kind === "ie") {
    const v: HawaiiReceiverPacket = { packet, receiverContext: hawaiiReportedReceiverContext(receiver, "ie"), sourceAt: packet.sourceAt, sourceHash: packet.sourceHash,
      profileAt: packet.capturedAt, profileStartedAt: packet.acquisitionStartedAt, profileHash: packet.sourceHash, nativeLedgerCents: null };
    hiFreeze(v); receivers.add(v); return v;
  }
  if (!receiver.linkId || !receiver.entityId || !["2022-2026", "2024-2026"].includes(receiver.electionPeriod ?? "")) hiHold("direct_receiving_link");
  const own = packet.rows.filter(r => r.reg_no === receiver.entityId && r.election_period === receiver.electionPeriod);
  if (!own.length) hiHold("receiving_ledger_missing");
  const official = qualifyHawaiiOfficialReceiver({ ...receiver, seat: receiver, roster: packet.roster });
  const names = [...new Set(own.map(r => hiRequired(r.candidate_name)))], offices = [...new Set(own.map(r => hiRequired(r.office)))];
  const expectedOffice = receiver.officeScope === "state_lower" ? "House" : receiver.officeScope === "state_upper" ? "Senate" : receiver.canonicalOffice === "Lieutenant Governor" ? "Lt. Governor" : "Governor";
  if (offices.length !== 1 || offices[0] !== expectedOffice || names.some(n => !hiPersonMatches(n, [official.legalName, official.ballotName]))
    || own.some(r => r.district && String(Number(r.district)) !== receiver.canonicalDistrict)
    || !hiDirectLinkSeatMatches(receiver)) hiHold("source_receiving_identity");
  const native = packet.candidateRegistry.filter(r => r.office === expectedOffice && names.every(n => hiPersonMatches(n, [r.name])));
  if (native.length !== 1) hiHold("native_receiving_identity_ambiguous");
  // Resolve ambiguous contributor classes/corrections before making an
  // unnecessary native profile request. This is not financial write authority.
  directAggregation(packet, receiver);
  const sum = own.reduce((n, r) => hiAdd(n, hiCents(r.amount)), 0), cache = hawaiiReportedCacheRoot(options.cacheDir);
  async function qualify(graph: HawaiiOriginalGraph): Promise<HawaiiReceiverPacket> {
    let reads = 0; const read: HawaiiOriginalGraph["read"] = async (...args) => { reads++; return graph.read(...args); };
    const control = await readHawaiiNativeFiler(read, { prefix: "receiver", noncandidate: false, registry: packet.candidateRegistry,
      name: native[0]!.name, office: expectedOffice, district: receiver.canonicalDistrict, electionPeriod: receiver.electionPeriod!, asOfDay: packet.capturedAt.slice(0, 10) });
    if (control.cents !== sum || reads !== graph.records.length) hiHold("native_receipt_control");
    const f = hiGraphFacts(graph);
    if (f.capturedAt < packet.publisherUpdatedAt) hiHold("native_profile_predates_ledger");
    const v: HawaiiReceiverPacket = { packet, receiverContext: hiCanonical(receiver), sourceAt: packet.sourceAt,
      sourceHash: hiHash(packet.sourceHash + f.sourceHash), profileAt: f.capturedAt, profileStartedAt: f.acquisitionStartedAt,
      profileHash: f.sourceHash, nativeLedgerCents: sum };
    hiFreeze(v); receivers.add(v); return v;
  }
  let saved: HawaiiReceiverPacket | null = null;
  for (const directory of await listHawaiiOriginalDirectories(cache)) {
    try { const g = await readHawaiiOriginalGraph(directory); if (g.records[0]?.role !== "receiver_registry_root") continue; saved = await qualify(g); break; }
    catch { /* another receiver or incomplete original graph */ }
  }
  if ((!saved || options.refresh || Date.now() - Date.parse(saved.profileAt) >= 86400000) && isHawaiiReportedRawRefreshEnabled()) {
    try { return await qualify(await createHawaiiOriginalGraph(cache)); } catch (e) { if (!saved) throw e; }
  }
  if (!saved) hiHold("native_receiving_control_unavailable"); return saved;
}

export function aggregateHawaiiReported(receiver: HawaiiReportedReceiver, source: HawaiiReceiverPacket): HawaiiReportedAggregation {
  if (!isHawaiiReceiverPacket(source) || source.receiverContext !== hawaiiReportedReceiverContext(receiver, source.packet.kind)) hiHold("unverified_receiver_source");
  const p = source.packet; baseReceiver(p, receiver);
  if (p.kind === "ie") {
    const a = aggregateHawaiiReportedIe({ ...receiver, seat: receiver, roster: p.roster, rows: p.rows, parentControls: p.parentControls,
      electionPeriod: "2024-2026", windowStart: "2024-11-06", windowEnd: "2026-11-03", asOfDay: p.capturedAt.slice(0, 10) });
    return { ...a, groups: a.groups.map(g => ({ ...g, sourceClass: "reported independent spender", evidence: "native_closed_b2" })) };
  }
  const a = directAggregation(p, receiver);
  if (a.ledgerCents !== source.nativeLedgerCents) hiHold("native_receipt_control");
  return { sourceRows: a.sourceRows, includedRows: a.includedRows, totalCents: a.totalCents, supportCents: 0, opposeCents: 0,
    groups: a.groups.map(g => ({ ...g, stance: "direct" })) };
}

export function validateHawaiiReportedClosure(a: HawaiiReportedAggregation, kind: HawaiiReportedKind): void {
  const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (!a || ![a.sourceRows, a.includedRows, a.totalCents, a.supportCents, a.opposeCents].every(count)
    || a.includedRows > a.sourceRows || !Array.isArray(a.groups)) hiHold("stored_controls");
  let total = 0, included = 0, support = 0, oppose = 0; const keys = new Set<string>();
  for (const g of a.groups) {
    if (!g || keys.has(g.key) || !count(g.cents) || g.cents === 0 || !count(g.occurrences) || g.occurrences === 0) hiHold("stored_group");
    const name = hiRequired(g.name); let key: unknown; try { key = JSON.parse(g.key); } catch { hiHold("stored_group_key"); }
    if (!Array.isArray(key) || (kind === "ie" ? key.length !== 2 || key[0] !== hiNameKey(name) || key[1] !== g.stance
      || !["support", "oppose"].includes(g.stance) || g.sourceClass !== "reported independent spender" || g.evidence !== "native_closed_b2"
      : key.length !== 3 || key[0] !== g.sourceClass || key[1] !== g.evidence || key[2] !== hiNameKey(name) || g.stance !== "direct"
      || !["Noncandidate Committee", "Political Party", "Other Entity"].includes(g.sourceClass)
      || (g.sourceClass === "Noncandidate Committee" ? g.evidence !== "declared_noncandidate"
        : g.sourceClass === "Political Party" ? g.evidence !== "declared_party"
          : !["registry_and_sender", "explicit_committee_name"].includes(g.evidence)))) hiHold("stored_group_identity");
    keys.add(g.key); total = hiAdd(total, g.cents); included = hiAdd(included, g.occurrences);
    if (g.stance === "support") support = hiAdd(support, g.cents); if (g.stance === "oppose") oppose = hiAdd(oppose, g.cents);
  }
  if (total !== a.totalCents || included !== a.includedRows || support !== a.supportCents || oppose !== a.opposeCents
    || (kind === "ie" && hiAdd(support, oppose) !== total)) hiHold("stored_group_closure");
}
