import type { Pool, PoolClient } from "pg";
import type { BallotLookupFinanceSummary, BallotLookupFinancePacInterest } from "../address/ballotLookupFinanceShared.js";
import { classifyPacInterest, isPacInterestSlug, pacInterestDisplayName, UNCLASSIFIED_PAC_INTEREST, PAC_INTERESTS_NOT_LISTED } from "../finance/pacInterestClassifier.js";

type Row = {
  candidate_id:string; election_id:string; election_year:number; observed_at:string;
  committee_id:string|null; committee_name:string|null; amount_cents:string|null; source_url:string;
  industry_slug:string|null; classification_source:string|null; confidence:string|null;
};
export const UTAH_OUTSIDE_CASH_NOTE = "Candidate-specific Utah outside-spending targets, support/opposition and allocations have not been verified; outside spending remains unknown.";
export async function appendUtahCommitteeCashSummaries(
  db:Pick<Pool|PoolClient,"query">, requests:readonly {candidate_id:string;election_id:string}[],
  summaries:Map<string,BallotLookupFinanceSummary>,
):Promise<void>{
  const result=await db.query<Row>(`WITH requested AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(candidate_id uuid,election_id uuid)
    ), grouped AS (
      SELECT requested.candidate_id::text,requested.election_id::text,max(l.election_year) election_year,
        max(max(s.last_synced_at)) OVER(PARTITION BY requested.candidate_id,requested.election_id)::text observed_at,
        donor.committee_id,min(donor.committee_name) committee_name,sum(donor.amount_cents)::text amount_cents,
        min(s.source_url) source_url
      FROM requested JOIN public.ut_candidate_finance_links l ON l.candidate_id=requested.candidate_id
        AND l.election_id=requested.election_id AND l.link_status='active'
      JOIN public.ut_candidate_finance_pac_sources s ON s.link_id=l.id AND s.election_year=l.election_year AND s.folder_id=l.folder_id
      LEFT JOIN public.ut_candidate_finance_pac_donors donor ON donor.link_id=s.link_id AND donor.election_year=s.election_year
      GROUP BY requested.candidate_id,requested.election_id,donor.committee_id
    ) SELECT grouped.*,label.industry_slug,label.classification_source,label.confidence
      FROM grouped LEFT JOIN public.finance_label_classifications label ON label.label_type='committee'
        AND label.normalized_label=public.normalize_finance_label(grouped.committee_name)
      ORDER BY candidate_id,election_id,amount_cents::numeric DESC,committee_name`,[JSON.stringify(requests)]);
  const groups=new Map<string,Map<string,BallotLookupFinancePacInterest>>(),clocks=new Map<string,string>();
  for(const row of result.rows){
    const key=`${row.candidate_id}\u0000${row.election_id}`;
    if(!summaries.has(key))summaries.set(key,{
      source:"UTAH_DISCLOSURES",cycle:row.election_year,fec_candidate_id:null,last_synced_at:row.observed_at,
      direct_campaign:{total_raised:null,total_spent:null,cash_on_hand:null,debts_owed:null,top_occupations:[],top_employers:[],top_industries:[]},
      outside_spending:{support_total:null,oppose_total:null,top_supporting_groups:[],top_opposing_groups:[],top_supporting_industries:[],top_opposing_industries:[],outside_coverage_note:UTAH_OUTSIDE_CASH_NOTE},
      backing_summary:{top_direct_donor_occupations:[],top_outside_supporting_industries:[]},
    });
    clocks.set(key,row.observed_at);
    if(!row.committee_id||!row.committee_name||row.amount_cents===null)continue;
    const cents=Number(row.amount_cents);if(!Number.isSafeInteger(cents)||cents<=0)continue;
    const trusted=row.industry_slug && isPacInterestSlug(row.industry_slug) && (row.classification_source==="manual" || (row.confidence==="high" && ["rule","ai"].includes(row.classification_source??"")))?row.industry_slug:null;
    const interest=trusted??classifyPacInterest({committeeName:row.committee_name,committeeType:null,designation:null,organizationType:null,connectedOrganization:null}).interestSlug??UNCLASSIFIED_PAC_INTEREST;
    if((PAC_INTERESTS_NOT_LISTED as readonly string[]).includes(interest))continue;
    const candidateGroups=groups.get(key)??new Map<string,BallotLookupFinancePacInterest>();
    const group=candidateGroups.get(interest)??{interest,interest_name:pacInterestDisplayName(interest),amount:0,pac_count:0,pacs:[]};
    group.amount=Math.round((group.amount+cents/100)*100)/100;group.pac_count++;
    group.pacs.push({committee_id:row.committee_id,committee_name:row.committee_name,amount:cents/100,source_url:row.source_url});
    candidateGroups.set(interest,group);groups.set(key,candidateGroups);
  }
  for(const [key,clock] of clocks){
    const summary=summaries.get(key)!;
    summary.direct_campaign.pac_money_by_interest=[...(groups.get(key)?.values()??[])].map(g=>({...g,pacs:g.pacs.slice(0,5)})).sort((a,b)=>b.amount-a.amount||a.interest.localeCompare(b.interest)).slice(0,5);
    summary.direct_campaign.pac_money_basis="reported_itemized_committee_cash_contributions";
    summary.direct_campaign.pac_money_coverage_note=`Filed ${summary.cycle} itemized cash contributions with exact reported-name matches in Utah's PAC-class export. This is a limited recognized subset, not all PAC money or proof of registration identity. Loans, in-kind gifts, unfiled entries and separately reported returns are excluded. Committee data observed ${new Date(clock).toISOString().slice(0,10)}; direct totals may cover different reports.`;
    summary.outside_spending.outside_coverage_note=UTAH_OUTSIDE_CASH_NOTE;
  }
}
