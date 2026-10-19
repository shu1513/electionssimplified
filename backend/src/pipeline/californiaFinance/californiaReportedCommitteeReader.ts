import type {Pool,PoolClient} from "pg";
import {isCaliforniaReportedCommitteeReceiptsEnabled} from "../../config/featureFlags.js";
import {buildStateFinanceSummaryRequests,candidateElectionKey,officeInputFromElectionRow,type BallotLookupFinanceSummary,type BallotLookupFinancePacInterest,type StateFinanceRequestCandidateRow,type StateFinanceRequestElectionRow} from "../address/ballotLookupFinanceShared.js";
import {classifyPacInterest,pacInterestDisplayName,UNCLASSIFIED_PAC_INTEREST} from "../finance/pacInterestClassifier.js";
import {CALIFORNIA_FINANCE_ELIGIBLE_OFFICE_KEYS,isCaliforniaFinanceEligibleOffice} from "./californiaFinanceEligibleOffices.js";
import {CA_COMMITTEE_SELECT,CA_COMMITTEE_FROM,CA_COMMITTEE_WHERE,CA_COMMITTEE_UNIQUE,type CaliforniaCommitteeReceiver} from "./californiaReportedCommitteeReceiver.js";
import {readStoredCaliforniaCommitteeComponent} from "./californiaReportedCommitteeWriter.js";
import {CaliforniaCommitteeError} from "./californiaReportedCommitteeSource.js";
export const CALIFORNIA_REPORTED_COMMITTEE_SOURCE_URL="https://cal-access.sos.ca.gov/Campaign/";
export async function overlayCaliforniaCommitteeReceipts(db:Pick<Pool|PoolClient,"query">,summaries:Map<string,BallotLookupFinanceSummary>,candidates:readonly StateFinanceRequestCandidateRow[],elections:readonly StateFinanceRequestElectionRow[]){
  if(!isCaliforniaReportedCommitteeReceiptsEnabled())return summaries;const requests=buildStateFinanceSummaryRequests("CA",candidates,elections,e=>isCaliforniaFinanceEligibleOffice(officeInputFromElectionRow(e)));if(!requests.length)return summaries;
  type Row=CaliforniaCommitteeReceiver&{committee_source:Record<string,unknown>;committee_groups:Record<string,unknown>[]};
  const rows=(await db.query<Row>(`SELECT ${CA_COMMITTEE_SELECT},to_jsonb(s) committee_source,COALESCE((SELECT jsonb_agg(to_jsonb(g)) FROM public.ca_reported_committee_groups g WHERE g.link_id=s.link_id AND g.election_year=s.election_year),'[]'::jsonb) committee_groups
    ${CA_COMMITTEE_FROM} JOIN jsonb_to_recordset($2::jsonb) requested(candidate_id uuid,election_id uuid) ON requested.candidate_id=l.candidate_id AND requested.election_id=l.election_id
    JOIN public.ca_reported_committee_sources s ON s.link_id=l.id AND s.election_year=l.election_year WHERE ${CA_COMMITTEE_WHERE} AND ${CA_COMMITTEE_UNIQUE}`,[[...CALIFORNIA_FINANCE_ELIGIBLE_OFFICE_KEYS],JSON.stringify(requests)])).rows;
  const seen=new Set<string>(),duplicates=new Set<string>();for(const r of rows){const key=candidateElectionKey(r.candidate_id,r.election_id);if(seen.has(key))duplicates.add(key);seen.add(key);}
  for(const row of rows){const key=candidateElectionKey(row.candidate_id,row.election_id);if(duplicates.has(key))continue;try{
    const {committee_source,committee_groups,...r}=row,{aggregation:a,retrievedAt}=readStoredCaliforniaCommitteeComponent(committee_source,committee_groups,r),interests=new Map<string,BallotLookupFinancePacInterest>();
    for(const g of a.groups){const interest=classifyPacInterest({committeeName:g.name,committeeType:null,designation:null,organizationType:null,connectedOrganization:null}).interestSlug??UNCLASSIFIED_PAC_INTEREST,item=interests.get(interest)??{interest,interest_name:pacInterestDisplayName(interest),amount:0,pac_count:0,pacs:[]};item.amount+=g.cents;item.pac_count++;item.pacs.push({committee_id:"ca-reported:"+g.key,committee_name:g.name,amount:g.cents/100,source_url:CALIFORNIA_REPORTED_COMMITTEE_SOURCE_URL});interests.set(interest,item);}
    const money=[...interests.values()].sort((a,b)=>b.amount-a.amount||a.interest.localeCompare(b.interest)).map(i=>({...i,amount:i.amount/100,pacs:i.pacs.slice(0,5)}));
    const summary:BallotLookupFinanceSummary=summaries.get(key)??{source:"CALIFORNIA_SOS",cycle:r.election_year,fec_candidate_id:null,controlled_committee_id:r.committee_id,last_synced_at:retrievedAt,
      direct_campaign:{total_raised:null,total_spent:null,cash_on_hand:null,debts_owed:null,top_occupations:[],top_employers:[],top_industries:[],contribution_size_buckets:[]},outside_spending:{support_total:null,oppose_total:null,top_supporting_groups:[],top_opposing_groups:[],top_supporting_industries:[],top_opposing_industries:[]},backing_summary:{top_direct_donor_occupations:[],top_outside_supporting_industries:[]}};
    summary.direct_campaign={...summary.direct_campaign,pac_money_by_interest:money,pac_money_basis:"reported_committee_itemized_contributions",pac_money_coverage_note:`Current filed Schedule A cash and Schedule C in-kind receipts dated ${r.election_year-1}–${r.election_year}, net of signed receipt corrections, before separate expenditure-side returns. Includes source-declared recipient, small-contributor and party committees; generic Other entities, transfers, forgiven loans and third-party repayments are excluded. Reported entities are not all resolved legal PAC registrations. Bulk snapshot downloaded ${retrievedAt.slice(0,10)} UTC.`};summaries.set(key,summary);
  }catch(e){if(!(e instanceof CaliforniaCommitteeError))throw e;}}
  return summaries;
}
