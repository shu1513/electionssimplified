import type {Pool,PoolClient} from "pg";
import {isMontanaReportedIeEnabled} from "../../config/featureFlags.js";
import {buildStateFinanceSummaryRequests,candidateElectionKey,officeInputFromElectionRow,type BallotLookupFinanceSummary,type StateFinanceRequestCandidateRow,type StateFinanceRequestElectionRow} from "../address/ballotLookupFinanceShared.js";
import {MT_COMMITTEE_SELECT,MT_COMMITTEE_FROM,MT_COMMITTEE_WHERE,type MontanaCommitteeReceiver} from "./montanaReportedCommitteeReceiver.js";
import {MONTANA_FINANCE_ELIGIBLE_OFFICE_KEYS,isMontanaFinanceEligibleOffice} from "./montanaFinanceEligibleOffices.js";
import {readStoredMontanaIePosition} from "./montanaIndependentIeWriter.js";
import {MontanaIndependentIeError} from "./montanaIndependentIeSource.js";
import {MontanaReportedCommitteeError} from "./montanaReportedCommitteeSource.js";
import {MONTANA_CERS_DASHBOARD_URL} from "./montanaCersClient.js";

export async function overlayMontanaIndependentIe(db:Pick<Pool|PoolClient,"query">,summaries:Map<string,BallotLookupFinanceSummary>,candidates:readonly StateFinanceRequestCandidateRow[],elections:readonly StateFinanceRequestElectionRow[],coverageNote:string){
  if(!isMontanaReportedIeEnabled())return summaries;const requests=buildStateFinanceSummaryRequests("MT",candidates,elections,e=>isMontanaFinanceEligibleOffice(officeInputFromElectionRow(e)));if(!requests.length)return summaries;
  type Row=MontanaCommitteeReceiver&{ie_source:Record<string,unknown>;ie_groups:Record<string,unknown>[]};
  const rows=(await db.query<Row>(`SELECT ${MT_COMMITTEE_SELECT},to_jsonb(s) ie_source,
    COALESCE((SELECT jsonb_agg(to_jsonb(g)) FROM public.mt_reported_ie_groups g WHERE g.link_id=s.link_id AND g.election_year=s.election_year),'[]'::jsonb) ie_groups
    ${MT_COMMITTEE_FROM} JOIN jsonb_to_recordset($2::jsonb) requested(candidate_id uuid,election_id uuid) ON requested.candidate_id=l.candidate_id AND requested.election_id=l.election_id
    JOIN public.mt_reported_ie_sources s ON s.link_id=l.id AND s.election_year=l.election_year WHERE ${MT_COMMITTEE_WHERE}`,
  [[...MONTANA_FINANCE_ELIGIBLE_OFFICE_KEYS],JSON.stringify(requests)])).rows;
  const duplicates=new Set<string>(),seen=new Set<string>();for(const r of rows){const key=candidateElectionKey(r.candidate_id,r.election_id);if(seen.has(key))duplicates.add(key);seen.add(key);}
  for(const row of rows){const key=candidateElectionKey(row.candidate_id,row.election_id);if(duplicates.has(key))continue;try{
    const {ie_source,ie_groups,...r}=row,{position:a,retrievedAt,completedAt}=readStoredMontanaIePosition(ie_source,ie_groups,r);
    const summary:BallotLookupFinanceSummary=summaries.get(key)??{source:"MONTANA_COPP",cycle:r.election_year,fec_candidate_id:null,controlled_committee_id:r.committee_id,last_synced_at:retrievedAt,
      direct_campaign:{total_raised:null,total_spent:null,cash_on_hand:null,debts_owed:null,top_occupations:[],top_employers:[],top_industries:[],contribution_size_buckets:[]},
      outside_spending:{support_total:null,oppose_total:null,top_supporting_groups:[],top_opposing_groups:[],top_supporting_industries:[],top_opposing_industries:[]},
      backing_summary:{top_direct_donor_occupations:[],top_outside_supporting_industries:[]}};
    const groups=(stance:"support"|"oppose")=>a.groups.filter(g=>g.stance===stance).slice(0,5).map(g=>({committee_id:g.committeeId,committee_name:g.name,support_oppose:g.stance,amount:g.cents/100,source_url:MONTANA_CERS_DASHBOARD_URL}));
    summary.outside_spending={support_total:a.supportCents===null?null:a.supportCents/100,oppose_total:a.opposeCents===null?null:a.opposeCents/100,
      top_supporting_groups:groups("support"),top_opposing_groups:groups("oppose"),top_supporting_industries:[],top_opposing_industries:[],
      outside_coverage_note:coverageNote+` Independent-expenditure originals observed ${retrievedAt.slice(0,10)}–${completedAt.slice(0,10)} UTC.`};
    summary.backing_summary={...summary.backing_summary,top_outside_supporting_industries:[]};summaries.set(key,summary);
  }catch(e){if(!(e instanceof MontanaIndependentIeError)&&!(e instanceof MontanaReportedCommitteeError))throw e;/* Legacy display survives unavailable new components. */}}
  return summaries;
}
