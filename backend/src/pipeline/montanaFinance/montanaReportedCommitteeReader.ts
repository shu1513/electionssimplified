import type { Pool,PoolClient } from "pg";
import { isMontanaReportedCommitteeReceiptsEnabled } from "../../config/featureFlags.js";
import { buildStateFinanceSummaryRequests,candidateElectionKey,officeInputFromElectionRow,type BallotLookupFinancePacInterest,
  type BallotLookupFinanceSummary,type StateFinanceRequestCandidateRow,type StateFinanceRequestElectionRow } from "../address/ballotLookupFinanceShared.js";
import { classifyPacInterest,pacInterestDisplayName,UNCLASSIFIED_PAC_INTEREST } from "../finance/pacInterestClassifier.js";
import { MONTANA_FINANCE_ELIGIBLE_OFFICE_KEYS,isMontanaFinanceEligibleOffice } from "./montanaFinanceEligibleOffices.js";
import { MONTANA_CERS_DASHBOARD_URL } from "./montanaCersClient.js";
import { MT_COMMITTEE_FROM,MT_COMMITTEE_SELECT,MT_COMMITTEE_WHERE,type MontanaCommitteeReceiver } from "./montanaReportedCommitteeReceiver.js";
import { readStoredMontanaCommitteeComponent } from "./montanaReportedCommitteeWriter.js";
import { MontanaReportedCommitteeError } from "./montanaReportedCommitteeSource.js";

export async function overlayMontanaCommitteeReceipts(db:Pick<Pool|PoolClient,"query">,summaries:Map<string,BallotLookupFinanceSummary>,
  candidates:readonly StateFinanceRequestCandidateRow[],elections:readonly StateFinanceRequestElectionRow[]){
  if(!isMontanaReportedCommitteeReceiptsEnabled())return summaries;
  const requests=buildStateFinanceSummaryRequests("MT",candidates,elections,r=>isMontanaFinanceEligibleOffice(officeInputFromElectionRow(r)));
  if(!requests.length)return summaries;
  type Row=MontanaCommitteeReceiver&{committee_source:Record<string,unknown>;committee_groups:Record<string,unknown>[]};
  const result=await db.query<Row>(`SELECT ${MT_COMMITTEE_SELECT},to_jsonb(s) committee_source,
    COALESCE((SELECT jsonb_agg(to_jsonb(g)) FROM public.mt_reported_committee_groups g
      WHERE g.link_id=s.link_id AND g.election_year=s.election_year),'[]'::jsonb) committee_groups
    ${MT_COMMITTEE_FROM} JOIN jsonb_to_recordset($2::jsonb) AS requested(candidate_id uuid,election_id uuid)
    ON requested.candidate_id=l.candidate_id AND requested.election_id=l.election_id
    JOIN public.mt_reported_committee_sources s ON s.link_id=l.id AND s.election_year=l.election_year
    WHERE ${MT_COMMITTEE_WHERE} AND (SELECT count(*) FROM public.mt_candidate_finance_links sibling
      WHERE sibling.link_status='active' AND ((sibling.candidate_id=l.candidate_id AND sibling.election_id=l.election_id)
        OR (sibling.committee_id=l.committee_id AND sibling.election_year=l.election_year)))=1`,
  [[...MONTANA_FINANCE_ELIGIBLE_OFFICE_KEYS],JSON.stringify(requests)]);
  const duplicates=new Set<string>(),seen=new Set<string>();for(const r of result.rows){const k=candidateElectionKey(r.candidate_id,r.election_id);if(seen.has(k))duplicates.add(k);seen.add(k);}
  for(const row of result.rows){
    const key=candidateElectionKey(row.candidate_id,row.election_id);if(duplicates.has(key))continue;
    try{
      const {committee_source,committee_groups,...receiver}=row,{aggregation,sourceRetrievedAt,sourceCompletedAt}=readStoredMontanaCommitteeComponent(committee_source,committee_groups,receiver);
      const interests=new Map<string,BallotLookupFinancePacInterest>();
      for(const g of aggregation.groups){
        const interest=classifyPacInterest({committeeName:g.name,committeeType:null,designation:null,organizationType:null,connectedOrganization:null}).interestSlug??UNCLASSIFIED_PAC_INTEREST;
        const item=interests.get(interest)??{interest,interest_name:pacInterestDisplayName(interest),amount:0,pac_count:0,pacs:[]};
        item.amount+=g.cents;item.pac_count++;item.pacs.push({committee_id:`mt-reported:${g.sourceEntityId}`,committee_name:g.name,amount:g.cents/100,source_url:MONTANA_CERS_DASHBOARD_URL});interests.set(interest,item);
      }
      // Reconcile all rows before the existing five-name display cap.
      const money=[...interests.values()].sort((a,b)=>b.amount-a.amount||a.interest.localeCompare(b.interest)).map(i=>({...i,amount:i.amount/100,pacs:i.pacs.slice(0,5)}));
      const summary:BallotLookupFinanceSummary=summaries.get(key)??{source:"MONTANA_COPP",cycle:receiver.election_year,fec_candidate_id:null,
        controlled_committee_id:receiver.committee_id,last_synced_at:sourceRetrievedAt,
        direct_campaign:{total_raised:null,total_spent:null,cash_on_hand:null,debts_owed:null,top_occupations:[],top_employers:[],top_industries:[],contribution_size_buckets:[]},
        outside_spending:{support_total:null,oppose_total:null,top_supporting_groups:[],top_opposing_groups:[],top_supporting_industries:[],top_opposing_industries:[]},
        backing_summary:{top_direct_donor_occupations:[],top_outside_supporting_industries:[]}};
      summary.direct_campaign={...summary.direct_campaign,pac_money_by_interest:money,pac_money_basis:"reported_committee_itemized_contributions",
        pac_money_coverage_note:`Reported Montana committee receipts for ${receiver.election_year}, both election sides, cash plus in-kind, before separate expenditure-side returns. Groups use reported source entities; legal PAC registrations are not inferred. Originals observed ${sourceRetrievedAt.slice(0,10)}–${sourceCompletedAt.slice(0,10)}.`};
      summaries.set(key,summary);
    }catch(e){if(!(e instanceof MontanaReportedCommitteeError))throw e;/* Preserve legacy figures when component closure fails. */}
  }
  return summaries;
}
