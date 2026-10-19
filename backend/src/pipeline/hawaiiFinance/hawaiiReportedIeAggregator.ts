import { hiAdd, hiCents, hiDay, hiHold, hiNameKey, hiRequired } from "./hawaiiReportedCore.js";
import type { HawaiiPublishedRow } from "./hawaiiReportedCommitteeAggregator.js";
import { hiOfficialContest, hiPersonKey, hiPersonMatches, qualifyHawaiiOfficialReceiver,
  type HawaiiOfficialCandidate, type HawaiiReportedSeat } from "./hawaiiReportedIdentity.js";

export type HawaiiIeGroup = { key: string; name: string; stance: "support" | "oppose"; cents: number; occurrences: number };
export type HawaiiIeParentControl = { registration: string; name: string; rows: number; cents: number };
export type HawaiiReportedIeAggregation = {
  sourceRows: number; includedRows: number; supportCents: number; opposeCents: number; totalCents: number; groups: HawaiiIeGroup[];
};
const jointOrGroup = (name: string): boolean => /[;&/\n]|\b(?:AND|VERSUS|VS|CANDIDATES|SLATE|ALL|TEAM)\b/i.test(name);
// A frozen whole-source packet serves a batch. Resolve its repeated target
// labels once; mutable synthetic/caller rosters never share cached verdicts.
const rosterTargets = new WeakMap<readonly HawaiiOfficialCandidate[], Map<string, readonly HawaiiOfficialCandidate[]>>();
function targetMatches(target: string, roster: readonly HawaiiOfficialCandidate[]): readonly HawaiiOfficialCandidate[] {
  const immutable = Object.isFrozen(roster) && roster.every(Object.isFrozen);
  let cache = immutable ? rosterTargets.get(roster) : undefined;
  if (immutable && !cache) { cache = new Map(); rosterTargets.set(roster, cache); }
  const saved = cache?.get(target); if (saved) return saved;
  const matches = roster.filter(o => hiPersonMatches(target, [o.legalName, o.ballotName]));
  if (cache) cache.set(target, Object.freeze(matches)); return matches;
}
function mayRefer(name: string, aliases: readonly string[]): boolean {
  const raw = hiPersonKey(name).replace(/\s/g, "");
  return aliases.some(alias => {
    const surname = alias.includes(",") ? alias.split(",")[0]! : hiPersonKey(alias).split(" ").at(-1)!;
    const key = hiPersonKey(surname).replace(/\s/g, "");
    return !key || raw.includes(key);
  });
}

/** Pure aggregation only. Source acquisition must independently establish the
 * complete generation, native parent covers and official roster provenance. */
export function aggregateHawaiiReportedIe(input: {
  candidateName: string; fullName: string; seat: HawaiiReportedSeat;
  roster: readonly HawaiiOfficialCandidate[]; rows: readonly HawaiiPublishedRow[];
  parentControls: readonly HawaiiIeParentControl[];
  electionPeriod: string; windowStart: string; windowEnd: string; asOfDay: string;
}): HawaiiReportedIeAggregation {
  if (input.electionPeriod !== "2024-2026") hiHold("ie_election_period");
  const start = hiDay(input.windowStart), end = hiDay(input.windowEnd), asOf = hiDay(input.asOfDay);
  if (start !== "2024-11-06" || end !== "2026-11-03" || asOf < start) hiHold("ie_window");
  const official = qualifyHawaiiOfficialReceiver(input), aliases = [official.legalName, official.ballotName];
  const rows = input.rows.filter(r => r.election_period === input.electionPeriod);
  if (!rows.length) hiHold("expense_population_missing");
  const seen = new Set<string>(), ledgers = new Map<string, { rows: number; cents: number; name: string }>();
  const ieParents = new Set<string>();
  for (const r of rows) {
    const occurrence = hiRequired(r.source_row_id), id = hiRequired(r.reg_no), name = hiRequired(r.noncandidate_committee_name);
    if (seen.has(occurrence)) hiHold("published_row_identity"); seen.add(occurrence);
    const amount = hiCents(r.amount), day = hiDay(r.date), flag = hiRequired(r.independent_expenditure);
    if (amount <= 0) hiHold("expense_correction");
    if (day < start || day > end || day > asOf) hiHold("expense_window");
    if (!["N", "Y"].includes(flag)) hiHold("unknown_ie_flag");
    // B2 publishes expense amounts, not Schedule A's cash/in-kind flag.
    // Qualification closes all B2 amounts against the filed B2 control.
    const p = ledgers.get(id) ?? { rows: 0, cents: 0, name };
    if (hiNameKey(p.name) !== hiNameKey(name)) hiHold("spender_identity_changed");
    p.rows++; p.cents = hiAdd(p.cents, amount); ledgers.set(id, p);
    if (flag === "Y") ieParents.add(id);
  }
  if (input.parentControls.length !== ieParents.size || new Set(input.parentControls.map(c => c.registration)).size !== ieParents.size) hiHold("ie_parent_population");
  for (const c of input.parentControls) {
    const actual = ledgers.get(c.registration);
    if (!ieParents.has(c.registration) || !actual || c.rows !== actual.rows || c.cents !== actual.cents
      || hiNameKey(c.name) !== hiNameKey(actual.name)) hiHold("ie_parent_control");
  }
  const groups = new Map<string, HawaiiIeGroup>(); let support = 0, oppose = 0, included = 0;
  for (const r of rows) {
    if (r.independent_expenditure !== "Y") continue;
    const target = hiRequired(r.candidate_name_s), stance = hiRequired(r.support_oppose);
    if (!["Support", "Oppose"].includes(stance)) hiHold("unknown_ie_stance");
    const matches = targetMatches(target, input.roster);
    const identities = new Map(matches.map(o => [JSON.stringify([hiPersonKey(o.legalName), o.contest]), o]));
    if (jointOrGroup(target) || identities.size !== 1) {
      if (mayRefer(target, aliases) || jointOrGroup(target)) hiHold("unallocable_ie_target");
      continue;
    }
    const resolved = [...identities.values()][0]!;
    if (resolved.contest !== hiOfficialContest(input.seat)) continue;
    if (!hiPersonMatches(resolved.legalName, aliases)) {
      if (mayRefer(target, aliases)) hiHold("contradictory_ie_person");
      continue;
    }
    if (!hiPersonMatches(target, aliases)) hiHold("contradictory_ie_alias");
    const name = hiRequired(r.noncandidate_committee_name), s = stance === "Support" ? "support" : "oppose";
    const key = JSON.stringify([hiNameKey(name), s]), g = groups.get(key) ?? { key, name, stance: s, cents: 0, occurrences: 0 };
    const amount = hiCents(r.amount); g.cents = hiAdd(g.cents, amount); g.occurrences++; groups.set(key, g); included++;
    if (s === "support") support = hiAdd(support, amount); else oppose = hiAdd(oppose, amount);
  }
  return { sourceRows: rows.length, includedRows: included, supportCents: support, opposeCents: oppose,
    totalCents: hiAdd(support, oppose), groups: [...groups.values()].sort((a, b) => b.cents - a.cents || a.key.localeCompare(b.key)) };
}
