import type { Pool, PoolClient } from "pg";
import { isIdahoReportedPacReceiptsEnabled } from "../../config/featureFlags.js";
import { buildStateFinanceSummaryRequests, candidateElectionKey, officeInputFromElectionRow,
  type BallotLookupFinancePacInterest, type BallotLookupFinanceSummary, type StateFinanceRequestCandidateRow, type StateFinanceRequestElectionRow } from "../address/ballotLookupFinanceShared.js";
import { classifyPacInterest, pacInterestDisplayName, UNCLASSIFIED_PAC_INTEREST } from "../finance/pacInterestClassifier.js";
import { IDAHO_FINANCE_ELIGIBLE_OFFICE_KEYS, isIdahoFinanceEligibleOffice } from "./idahoFinanceEligibleOffices.js";
import { ID_PAC_CONTEXT_FROM, ID_PAC_CONTEXT_SELECT, ID_PAC_CONTEXT_WHERE, type IdahoPacReceiver } from "./idahoReportedPacReceiver.js";
import { IdahoPacSourceError, IDAHO_REPORTED_PAC_SOURCE_URL } from "./idahoReportedPacSource.js";
import { readStoredIdahoPacComponent } from "./idahoReportedPacWriter.js";

export const IDAHO_IE_COVERAGE_NOTE = "Outside spending reflects Sunshine independent-expenditure candidate allocations. Electioneering communications are reported separately and are not included in this source.";
export async function overlayIdahoReportedPacReceipts(db: Pick<Pool | PoolClient, "query">, summaries: Map<string, BallotLookupFinanceSummary>,
  candidates: readonly StateFinanceRequestCandidateRow[], elections: readonly StateFinanceRequestElectionRow[]) {
  if (!isIdahoReportedPacReceiptsEnabled()) return summaries;
  const requests = buildStateFinanceSummaryRequests("ID", candidates, elections, r => isIdahoFinanceEligibleOffice(officeInputFromElectionRow(r)));
  if (!requests.length) return summaries;
  type Row = IdahoPacReceiver & { pac_source: Record<string, unknown>; pac_groups: Record<string, unknown>[] };
  const result = await db.query<Row>(`SELECT ${ID_PAC_CONTEXT_SELECT},to_jsonb(s) pac_source,
    COALESCE((SELECT jsonb_agg(to_jsonb(g)) FROM public.id_reported_pac_groups g
      WHERE g.link_id=s.link_id AND g.election_year=s.election_year),'[]'::jsonb) pac_groups
    ${ID_PAC_CONTEXT_FROM} JOIN jsonb_to_recordset($2::jsonb) AS requested(candidate_id uuid,election_id uuid)
      ON requested.candidate_id=l.candidate_id AND requested.election_id=l.election_id
    JOIN public.id_reported_pac_sources s ON s.link_id=l.id AND s.election_year=l.election_year
    WHERE ${ID_PAC_CONTEXT_WHERE} AND (SELECT count(*) FROM public.id_candidate_finance_links sibling
      WHERE sibling.candidate_id=l.candidate_id AND sibling.election_id=l.election_id AND sibling.link_status='active')=1`,
  [[...IDAHO_FINANCE_ELIGIBLE_OFFICE_KEYS], JSON.stringify(requests)]);
  for (const summary of summaries.values()) summary.outside_spending.outside_coverage_note = IDAHO_IE_COVERAGE_NOTE;
  const seen = new Set<string>(), duplicates = new Set<string>();
  for (const row of result.rows) { const key = candidateElectionKey(row.candidate_id,row.election_id); if (seen.has(key)) duplicates.add(key); seen.add(key); }
  for (const row of result.rows) {
    const key = candidateElectionKey(row.candidate_id,row.election_id); if (duplicates.has(key)) continue;
    try {
      const { pac_source, pac_groups, ...receiver } = row, { aggregation, sourceRetrievedAt } = readStoredIdahoPacComponent(pac_source,pac_groups,receiver);
      const interests = new Map<string,BallotLookupFinancePacInterest>();
      for (const g of aggregation.groups) {
        const interest = classifyPacInterest({ committeeName:g.name,committeeType:null,designation:null,organizationType:null,connectedOrganization:null }).interestSlug ?? UNCLASSIFIED_PAC_INTEREST;
        const item = interests.get(interest) ?? { interest,interest_name:pacInterestDisplayName(interest),amount:0,pac_count:0,pacs:[] };
        item.amount += g.cents; item.pac_count++;
        item.pacs.push({ committee_id:`id-reported:${g.key}`,committee_name:g.name,amount:g.cents/100,source_url:IDAHO_REPORTED_PAC_SOURCE_URL }); interests.set(interest,item);
      }
      const money = [...interests.values()].sort((a,b)=>b.amount-a.amount||a.interest.localeCompare(b.interest)).map(i=>({...i,amount:i.amount/100,pacs:i.pacs.slice(0,5)}));
      const summary: BallotLookupFinanceSummary = summaries.get(key) ?? { source:"IDAHO_SUNSHINE",cycle:receiver.election_year,fec_candidate_id:null,
        controlled_committee_id:receiver.registration_guid,last_synced_at:sourceRetrievedAt,
        direct_campaign:{total_raised:null,total_spent:null,cash_on_hand:null,debts_owed:null,top_occupations:[],top_employers:[],top_industries:[],contribution_size_buckets:[]},
        outside_spending:{support_total:null,oppose_total:null,top_supporting_groups:[],top_opposing_groups:[],top_supporting_industries:[],top_opposing_industries:[],outside_coverage_note:IDAHO_IE_COVERAGE_NOTE},
        backing_summary:{top_direct_donor_occupations:[],top_outside_supporting_industries:[]} };
      summary.direct_campaign = { ...summary.direct_campaign,pac_money_by_interest:money,pac_money_basis:"reported_committee_itemized_contributions",
        pac_money_coverage_note:`Current itemized receipts reported as Political Committee (TPAC), including cash and in-kind. Separate contribution returns are not subtracted. Unitemized and other source types are excluded. Groups use reported source entities, not resolved PAC registrations. Observed ${sourceRetrievedAt.slice(0,10)}.` };
      summaries.set(key,summary);
    } catch (e) { if (!(e instanceof IdahoPacSourceError)) throw e; /* Unavailable component never replaces legacy money. */ }
  }
  return summaries;
}
