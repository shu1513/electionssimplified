import type { Pool, PoolClient } from "pg";
import { isWashingtonReportedPacReceiptsEnabled } from "../../config/featureFlags.js";
import { buildStateFinanceSummaryRequests, candidateElectionKey, type BallotLookupFinancePacInterest, type BallotLookupFinanceSummary,
  type StateFinanceRequestCandidateRow, type StateFinanceRequestElectionRow } from "../address/ballotLookupFinanceShared.js";
import { classifyPacInterest, pacInterestDisplayName, UNCLASSIFIED_PAC_INTEREST } from "../finance/pacInterestClassifier.js";
import { WASHINGTON_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./washingtonFinanceEligibleOffices.js";
import { WA_PAC_CONTEXT_FROM, WA_PAC_CONTEXT_SELECT, WA_PAC_CONTEXT_WHERE, type WashingtonPacReceiver } from "./washingtonReportedPacReceiver.js";
import { WashingtonPacSourceError, WASHINGTON_REPORTED_PAC_SOURCE_URL } from "./washingtonReportedPacSource.js";
import { readStoredWashingtonPacComponent } from "./washingtonReportedPacWriter.js";

export const WASHINGTON_C6_COVERAGE_NOTE = "Outside spending reflects PDC C6 candidate allocations. Committee C4 independent-expenditure reporting is not included in this source.";
export async function overlayWashingtonReportedPacReceipts(db: Pick<Pool | PoolClient, "query">,
  summaries: Map<string, BallotLookupFinanceSummary>, candidates: readonly StateFinanceRequestCandidateRow[], elections: readonly StateFinanceRequestElectionRow[]) {
  if (!isWashingtonReportedPacReceiptsEnabled()) return summaries;
  const requests = buildStateFinanceSummaryRequests("WA", candidates, elections);
  if (!requests.length) return summaries;
  type Row = WashingtonPacReceiver & { pac_source: Record<string, unknown>; pac_groups: Record<string, unknown>[] };
  // Source, complete groups, current canonical context and uniqueness are read
  // in one PostgreSQL snapshot; display limits are applied only after closure.
  const result = await db.query<Row>(`SELECT ${WA_PAC_CONTEXT_SELECT},to_jsonb(s) pac_source,
    COALESCE((SELECT jsonb_agg(to_jsonb(g)) FROM public.wa_reported_pac_groups g
      WHERE g.link_id=s.link_id AND g.election_year=s.election_year),'[]'::jsonb) pac_groups
    ${WA_PAC_CONTEXT_FROM}
    JOIN jsonb_to_recordset($2::jsonb) AS requested(candidate_id uuid,election_id uuid)
      ON requested.candidate_id=l.candidate_id AND requested.election_id=l.election_id
    JOIN public.wa_reported_pac_sources s ON s.link_id=l.id AND s.election_year=l.election_year
    WHERE ${WA_PAC_CONTEXT_WHERE}
      AND (SELECT count(*) FROM public.wa_candidate_finance_links sibling
        WHERE sibling.candidate_id=l.candidate_id AND sibling.election_id=l.election_id AND sibling.link_status='active')=1`,
  [[...WASHINGTON_FINANCE_ELIGIBLE_OFFICE_KEYS], JSON.stringify(requests)]);
  for (const summary of summaries.values()) summary.outside_spending.outside_coverage_note = WASHINGTON_C6_COVERAGE_NOTE;
  const seen = new Set<string>(), duplicate = new Set<string>();
  for (const row of result.rows) { const key = candidateElectionKey(row.candidate_id, row.election_id); if (seen.has(key)) duplicate.add(key); seen.add(key); }
  for (const row of result.rows) {
    const key = candidateElectionKey(row.candidate_id, row.election_id); if (duplicate.has(key)) continue;
    try {
      const { pac_source, pac_groups, ...receiver } = row;
      const { aggregation, sourceRetrievedAt } = readStoredWashingtonPacComponent(pac_source, pac_groups, receiver);
      const interests = new Map<string, BallotLookupFinancePacInterest>();
      for (const group of aggregation.groups) {
        const interest = classifyPacInterest({ committeeName: group.name, committeeType: null, designation: null, organizationType: null,
          connectedOrganization: null }).interestSlug ?? UNCLASSIFIED_PAC_INTEREST;
        const item = interests.get(interest) ?? { interest, interest_name: pacInterestDisplayName(interest), amount: 0, pac_count: 0, pacs: [] };
        item.amount += group.cents; item.pac_count++;
        item.pacs.push({ committee_id: group.key, committee_name: group.name, amount: group.cents / 100, source_url: WASHINGTON_REPORTED_PAC_SOURCE_URL });
        interests.set(interest, item);
      }
      const pacMoney = [...interests.values()].sort((a, b) => b.amount - a.amount || a.interest.localeCompare(b.interest))
        .map(item => ({ ...item, amount: item.amount / 100, pacs: item.pacs.slice(0, 5) }));
      const existing = summaries.get(key);
      const summary: BallotLookupFinanceSummary = existing ?? { source: "WASHINGTON_PDC", cycle: receiver.election_year, fec_candidate_id: null,
        controlled_committee_id: receiver.committee_id, last_synced_at: sourceRetrievedAt,
        direct_campaign: { total_raised: null, total_spent: null, cash_on_hand: null, debts_owed: null,
          top_occupations: [], top_employers: [], top_industries: [], contribution_size_buckets: [] },
        outside_spending: { support_total: null, oppose_total: null, top_supporting_groups: [], top_opposing_groups: [],
          top_supporting_industries: [], top_opposing_industries: [], outside_coverage_note: WASHINGTON_C6_COVERAGE_NOTE },
        backing_summary: { top_direct_donor_occupations: [], top_outside_supporting_industries: [] } };
      summary.direct_campaign = { ...summary.direct_campaign, pac_money_by_interest: pacMoney,
        pac_money_basis: "reported_committee_itemized_contributions", pac_money_coverage_note:
          `Current reported PAC receipts, including signed corrections, cash, in-kind contributions and unpaid loans as published. Separate expenditure refunds are excluded. Groups use reported names, not resolved legal committee identities. Observed ${sourceRetrievedAt.slice(0, 10)}.` };
      summaries.set(key, summary);
    } catch (e) { if (!(e instanceof WashingtonPacSourceError)) throw e; /* Invalid component stays unavailable; legacy money survives. */ }
  }
  return summaries;
}
