import type { Pool, PoolClient } from "pg";
import { isHawaiiIndependentIeEnabled, isHawaiiReportedCommitteeEnabled } from "../../config/featureFlags.js";
import { candidateElectionKey, type BallotLookupFinancePacInterest, type BallotLookupFinanceSummary, type StateFinanceSummaryRequest } from "../address/ballotLookupFinanceShared.js";
import { classifyPacInterest, PAC_INTERESTS_NOT_LISTED, pacInterestDisplayName, UNCLASSIFIED_PAC_INTEREST } from "../finance/pacInterestClassifier.js";
import { hiAdd, hiHash, hiHold, HawaiiReportedHold, type HawaiiReportedKind } from "./hawaiiReportedCore.js";
import { hawaiiReportedReceiverContext, listHawaiiReportedReceivers, type HawaiiReportedReceiver } from "./hawaiiReportedReceiver.js";
import { validateHawaiiReportedClosure, type HawaiiReportedAggregation, type HawaiiReportedGroup } from "./hawaiiReportedAggregation.js";
import { validateHawaiiReportedFacts } from "./hawaiiReportedStore.js";
const sourceUrl = "https://ags.hawaii.gov/campaign/nc/view-searchable-data/";
type Row = Record<string, any>;
function iso(v: unknown): string {
  const d = new Date(v as string); if (!Number.isFinite(d.getTime())) hiHold("stored_clock"); return d.toISOString();
}
function integer(v: unknown): number {
  const n = typeof v === "string" && /^(?:0|[1-9]\d*)$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) hiHold("stored_group_integer"); return n;
}
export function readStoredHawaiiReportedComponent(row: Row, groups: Row[], receiver: HawaiiReportedReceiver): HawaiiReportedAggregation {
  const kind: HawaiiReportedKind = row.component;
  if (!["committee", "ie"].includes(kind) || row.candidate_id !== receiver.candidateId || row.election_id !== receiver.electionId
    || row.election_year !== 2026 || !row.receiver_context || hawaiiReportedReceiverContext(row.receiver_context, kind) !== hawaiiReportedReceiverContext(receiver, kind)) hiHold("stored_receiver_context");
  validateHawaiiReportedFacts(row.source_facts, kind, iso(row.last_synced_at));
  if (iso(row.source_observed_at) !== row.source_facts.sourceAt) hiHold("stored_source_clock");
  const a: HawaiiReportedAggregation = { ...row.aggregation_controls, groups: groups.map(g => {
    if (g.candidate_id !== receiver.candidateId || g.election_id !== receiver.electionId || g.election_year !== 2026 || g.component !== kind) hiHold("stored_group_scope");
    return { key: g.group_key, name: g.reported_name, sourceClass: g.source_class, evidence: g.evidence, stance: g.stance,
      cents: integer(g.amount_cents), occurrences: integer(g.occurrence_count) };
  }) };
  validateHawaiiReportedClosure(a, kind);
  if (kind === "ie" ? a.sourceRows !== row.source_facts.sourceRows
    : !receiver.linkId || !receiver.entityId || a.sourceRows > row.source_facts.sourceRows || a.totalCents > row.source_facts.nativeLedgerCents) hiHold("stored_source_count");
  return a;
}
function empty(r: HawaiiReportedReceiver, clock: string): BallotLookupFinanceSummary {
  return { source: "HAWAII_CSC", cycle: 2026, fec_candidate_id: null, controlled_committee_id: r.entityId, last_synced_at: clock,
    direct_campaign: { total_raised: null, total_spent: null, cash_on_hand: null, debts_owed: null, top_occupations: [], top_employers: [], top_industries: [], contribution_size_buckets: [] },
    outside_spending: { support_total: null, oppose_total: null, top_supporting_groups: [], top_opposing_groups: [], top_supporting_industries: [], top_opposing_industries: [] },
    backing_summary: { top_direct_donor_occupations: [], top_outside_supporting_industries: [] } };
}
export function hawaiiReportedInterests(groups: readonly HawaiiReportedGroup[]): BallotLookupFinancePacInterest[] {
  const buckets = new Map<string, { cents: number; pacs: BallotLookupFinancePacInterest["pacs"] }>();
  for (const g of groups) {
    const c = classifyPacInterest({ committeeName: g.name, committeeType: null, designation: null, organizationType: null, connectedOrganization: null });
    const interest = c.interestSlug === null || PAC_INTERESTS_NOT_LISTED.includes(c.interestSlug) ? UNCLASSIFIED_PAC_INTEREST : c.interestSlug;
    const b = buckets.get(interest) ?? { cents: 0, pacs: [] }; b.cents = hiAdd(b.cents, g.cents);
    b.pacs.push({ committee_id: `hi-reported:${hiHash(g.key)}`, committee_name: g.name, amount: g.cents / 100,
      source_url: "https://ags.hawaii.gov/campaign/cc/view-searchable-data/" }); buckets.set(interest, b);
  }
  return [...buckets].map(([interest, b]) => ({ interest, interest_name: pacInterestDisplayName(interest), amount: b.cents / 100,
    pac_count: b.pacs.length, pacs: b.pacs.sort((a, b) => b.amount - a.amount || a.committee_id.localeCompare(b.committee_id)).slice(0, 5) }))
    .sort((a, b) => b.amount - a.amount || a.interest.localeCompare(b.interest)).slice(0, 5);
}
/** Read all groups and validate closure before either top-five presentation
 * limit. Invalid/newer incomplete observations leave legacy money intact. */
export async function attachHawaiiReportedFinance(input: {
  db: Pick<Pool | PoolClient, "query">; requests: readonly StateFinanceSummaryRequest[]; summaries: Map<string, BallotLookupFinanceSummary>;
}): Promise<Map<string, BallotLookupFinanceSummary>> {
  const kinds: HawaiiReportedKind[] = [...(isHawaiiReportedCommitteeEnabled() ? ["committee" as const] : []), ...(isHawaiiIndependentIeEnabled() ? ["ie" as const] : [])];
  if (!kinds.length || !input.requests.length) return input.summaries;
  const output = new Map(input.summaries), wanted = new Set(input.requests.map(r => candidateElectionKey(r.candidate_id, r.election_id)));
  const receivers = (await listHawaiiReportedReceivers(input.db)).filter(r => wanted.has(candidateElectionKey(r.candidateId, r.electionId)));
  if (!receivers.length) return output;
  const ids = receivers.map(r => r.candidateId);
  const sources = (await input.db.query<Row>("SELECT * FROM public.hi_reported_finance_components WHERE candidate_id=ANY($1::uuid[]) AND election_year=2026 AND component=ANY($2::text[])", [ids, kinds])).rows;
  const groups = (await input.db.query<Row>("SELECT * FROM public.hi_reported_finance_groups WHERE candidate_id=ANY($1::uuid[]) AND election_year=2026 AND component=ANY($2::text[])", [ids, kinds])).rows;
  for (const r of receivers) for (const kind of kinds) {
    const rows = sources.filter(s => s.candidate_id === r.candidateId && s.election_id === r.electionId && s.component === kind);
    if (rows.length !== 1) continue;
    try {
      const s = rows[0]!, a = readStoredHawaiiReportedComponent(s, groups.filter(g => g.candidate_id === r.candidateId && g.election_id === r.electionId && g.component === kind), r);
      const key = candidateElectionKey(r.candidateId, r.electionId), current = output.get(key) ?? empty(r, s.source_facts.sourceAt);
      if (current.cycle !== 2026) hiHold("summary_cycle");
      const observed = s.source_facts.sourceAt.slice(0, 10), published = s.source_facts.publisherUpdatedAt.slice(0, 10);
      if (kind === "committee") output.set(key, { ...current, direct_campaign: { ...current.direct_campaign,
        pac_money_by_interest: hawaiiReportedInterests(a.groups), pac_money_basis: "reported_committee_itemized_contributions",
        pac_money_coverage_note: `Positive itemized cash and in-kind Schedule A contributions in the receiving ${r.electionPeriod} period, before separate expenditure-side refunds. Source-declared noncandidate committees and parties, plus political committee names or registry-and-sender-corroborated entities. Unitemized receipts, loans and other receipts are excluded. Names are reported labels; unresolved candidate-donor classes, corrections and identity conflicts are held. Published dataset updated ${published}; observed ${observed}.` } });
      else {
        const mapped = a.groups.map(g => ({ committee_id: `hi-reported-ie:${hiHash(g.key)}`, committee_name: g.name, support_oppose: g.stance as "support" | "oppose",
          amount: g.cents / 100, expenditure_count: g.occurrences, source_url: sourceUrl })).sort((a, b) => b.amount - a.amount || a.committee_id.localeCompare(b.committee_id));
        output.set(key, { ...current, outside_spending: { ...current.outside_spending,
          support_total: a.supportCents / 100, oppose_total: a.opposeCents / 100,
          top_supporting_groups: mapped.filter(g => g.support_oppose === "support").slice(0, 5),
          top_opposing_groups: mapped.filter(g => g.support_oppose === "oppose").slice(0, 5), top_supporting_industries: [], top_opposing_industries: [],
          unallocated_candidate_edges: [],
          outside_coverage_note: `Source-marked independent spending in the 2024–2026 B2 ledger, individually allocated through official legal/ballot names and regular general-election seat. Every spender parent closes to its filed cumulative B2 control. Joint targets, unresolved identities, corrections and unclosed parents are held. Dataset updated ${published}; observed ${observed}. The headline date may reflect campaign receipts.` },
          backing_summary: { ...current.backing_summary, top_outside_supporting_industries: [], top_pac_backed_industries: [], top_supporting_committee_industries: [] } });
      }
    } catch (e) { if (!(e instanceof HawaiiReportedHold)) throw e; }
  }
  return output;
}
