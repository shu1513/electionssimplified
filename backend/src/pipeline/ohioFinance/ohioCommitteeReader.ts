import type { Pool, PoolClient } from "pg";
import { isOhioReportedCommitteeReceiptsEnabled } from "../../config/featureFlags.js";
import { buildStateFinanceSummaryRequests,candidateElectionKey,officeInputFromElectionRow,
  type BallotLookupFinancePacInterest,type BallotLookupFinanceSummary,type StateFinanceRequestCandidateRow,type StateFinanceRequestElectionRow } from "../address/ballotLookupFinanceShared.js";
import { classifyPacInterest,pacInterestDisplayName,UNCLASSIFIED_PAC_INTEREST } from "../finance/pacInterestClassifier.js";
import { OHIO_FINANCE_ELIGIBLE_OFFICE_KEYS,isOhioFinanceEligibleOffice } from "./ohioFinanceEligibleOffices.js";
import { OH_COMMITTEE_CONTEXT_FROM,OH_COMMITTEE_CONTEXT_SELECT,OH_COMMITTEE_CONTEXT_WHERE,OH_COMMITTEE_UNIQUE_ACTIVE_LINK_WHERE,type OhioCommitteeReceiver } from "./ohioCommitteeReceiver.js";
import { OhioCommitteeReceiptError } from "./ohioCommitteeReceipts.js";
import { readStoredOhioCommitteeComponent } from "./ohioCommitteeWriter.js";

export const OHIO_REPORTED_COMMITTEE_SOURCE_URL="https://www.ohiosos.gov/campaign-finance/search/";
export async function overlayOhioCommitteeReceipts(db:Pick<Pool|PoolClient,"query">,summaries:Map<string,BallotLookupFinanceSummary>,
  candidates:readonly StateFinanceRequestCandidateRow[],elections:readonly StateFinanceRequestElectionRow[]){
  if(!isOhioReportedCommitteeReceiptsEnabled())return summaries;
  const requests=buildStateFinanceSummaryRequests("OH",candidates,elections,r=>isOhioFinanceEligibleOffice(officeInputFromElectionRow(r)));
  if(!requests.length)return summaries;
  type Row=OhioCommitteeReceiver&{committee_source:Record<string,unknown>;committee_groups:Record<string,unknown>[]};
  const result=await db.query<Row>(`SELECT ${OH_COMMITTEE_CONTEXT_SELECT},to_jsonb(s) committee_source,
    COALESCE((SELECT jsonb_agg(to_jsonb(g)) FROM public.oh_reported_committee_groups g
      WHERE g.link_id=s.link_id AND g.election_year=s.election_year),'[]'::jsonb) committee_groups
    ${OH_COMMITTEE_CONTEXT_FROM} JOIN jsonb_to_recordset($2::jsonb) AS requested(candidate_id uuid,election_id uuid)
      ON requested.candidate_id=l.candidate_id AND requested.election_id=l.election_id
    JOIN public.oh_reported_committee_sources s ON s.link_id=l.id AND s.election_year=l.election_year
    WHERE ${OH_COMMITTEE_CONTEXT_WHERE} AND ${OH_COMMITTEE_UNIQUE_ACTIVE_LINK_WHERE}`,
  [[...OHIO_FINANCE_ELIGIBLE_OFFICE_KEYS],JSON.stringify(requests)]);
  const seen=new Set<string>(),duplicates=new Set<string>();for(const r of result.rows){const key=candidateElectionKey(r.candidate_id,r.election_id);if(seen.has(key))duplicates.add(key);seen.add(key);}
  for(const row of result.rows){
    const key=candidateElectionKey(row.candidate_id,row.election_id);if(duplicates.has(key))continue;
    try{
      const {committee_source,committee_groups,...receiver}=row,{aggregation,sourceRetrievedAt,sourceCompletedAt}=readStoredOhioCommitteeComponent(committee_source,committee_groups,receiver);
      const interests=new Map<string,BallotLookupFinancePacInterest>();
      for(const g of aggregation.groups){
        const interest=classifyPacInterest({committeeName:g.name,committeeType:null,designation:null,organizationType:null,connectedOrganization:null}).interestSlug??UNCLASSIFIED_PAC_INTEREST;
        const item=interests.get(interest)??{interest,interest_name:pacInterestDisplayName(interest),amount:0,pac_count:0,pacs:[]};
        item.amount+=g.cents;item.pac_count++;item.pacs.push({committee_id:`oh-reported:${g.key}`,committee_name:g.name,amount:g.cents/100,source_url:OHIO_REPORTED_COMMITTEE_SOURCE_URL});interests.set(interest,item);
      }
      // Complete source/group closure above precedes all named-detail limits.
      const money=[...interests.values()].sort((a,b)=>b.amount-a.amount||a.interest.localeCompare(b.interest)).map(i=>({...i,amount:i.amount/100,pacs:i.pacs.slice(0,5)}));
      const summary:BallotLookupFinanceSummary=summaries.get(key)??{source:"OHIO_SOS",cycle:receiver.election_year,fec_candidate_id:null,
        controlled_committee_id:receiver.committee_id,last_synced_at:sourceRetrievedAt,
        direct_campaign:{total_raised:null,total_spent:null,cash_on_hand:null,debts_owed:null,top_occupations:[],top_employers:[],top_industries:[],contribution_size_buckets:[]},
        outside_spending:{support_total:null,oppose_total:null,top_supporting_groups:[],top_opposing_groups:[],top_supporting_industries:[],top_opposing_industries:[],
          outside_coverage_note:"Covers registered-committee outside spending with an explicit target and stance. Separate unregistered-spender and electioneering filings are excluded."},
        backing_summary:{top_direct_donor_occupations:[],top_outside_supporting_industries:[]}};
      summary.direct_campaign={...summary.direct_campaign,pac_money_by_interest:money,pac_money_basis:"reported_committee_itemized_contributions",
        pac_money_coverage_note:`Cash and in-kind committee receipts in report years ${receiver.election_year-1}–${receiver.election_year}, before separate expenditure-side contribution returns. Committees include registry matches and explicit PAC/PCE declarations; reported groups are not all resolved legal PAC registrations. Original files observed ${sourceRetrievedAt.slice(0,10)}–${sourceCompletedAt.slice(0,10)}.`};
      summaries.set(key,summary);
    }catch(e){if(!(e instanceof OhioCommitteeReceiptError))throw e;/* Unavailable components preserve legacy money. */}
  }
  return summaries;
}
