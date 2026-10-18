import type { Pool, PoolClient } from "pg";
import { isNewHampshireReportedCommitteeReceiptsEnabled, isNewHampshireReportedIeEnabled } from "../../config/featureFlags.js";
import { candidateElectionKey, type BallotLookupFinanceSummary, type BallotLookupFinancePacInterest,
  type StateFinanceSummaryRequest } from "../address/ballotLookupFinanceShared.js";
import { classifyPacInterest, PAC_INTERESTS_NOT_LISTED, pacInterestDisplayName, UNCLASSIFIED_PAC_INTEREST } from "../finance/pacInterestClassifier.js";
import { NEW_HAMPSHIRE_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./newHampshireFinanceEligibleOffices.js";
import { nhReportedIso, validateNewHampshireReportedCounts, validateNewHampshireReportedSourceFacts } from "./newHampshireReportedSourceFacts.js";
import { nhSourceGuid, nhSourceHold, nhSourceText, NewHampshireReportedSourceError } from "./newHampshireReportedSourceGraph.js";
import { NEW_HAMPSHIRE_REPORTED_SOURCE_URL as SOURCE, type NewHampshireSourceControl } from "./newHampshireReportedSourceCache.js";

type Row = Record<string, unknown>;
const MAX_DISPLAY = 5;
function integer(v: unknown, minimum = 0): number {
  if (typeof v !== "number" && (typeof v !== "string" || !/^(?:0|[1-9]\d*)$/.test(v))) nhSourceHold("invalid_stored_count");
  const n = Number(v); if (!Number.isSafeInteger(n) || n < minimum) nhSourceHold("invalid_stored_count"); return n;
}
function sum(a: number, b: number): number {
  const n = a + b; if (!Number.isSafeInteger(n)) nhSourceHold("invalid_stored_sum"); return n;
}
const canonical = (v: unknown): string => JSON.stringify(v, (_, x) => x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
function component(rows: Row[]) {
  const first = rows[0]; if (!first) nhSourceHold("missing_component");
  const fields = Object.keys(first).filter(key => !key.startsWith("grp_"));
  for (const row of rows) for (const key of fields) if (canonical(row[key]) !== canonical(first[key])) nhSourceHold("inconsistent_stored_source");
  if (integer(first.active_link_count, 1) !== 1 || first.current_link_id !== first.link_id ||
    first.candidate_id !== first.source_candidate_id || first.election_id !== first.source_election_id ||
    !["manual", "cfs_registration"].includes(String(first.link_source))) nhSourceHold("stored_context_changed");
  const year = integer(first.calendar_year, 2016);
  if (year > 2100 || integer(first.link_year) !== year || integer(first.election_year) !== year ||
    typeof first.current_receiver !== "string" || !/^[1-9]\d*$/.test(first.current_receiver) ||
    !Number.isSafeInteger(Number(first.current_receiver)) || first.receiving_entity_id !== first.current_receiver) nhSourceHold("stored_context_changed");
  const guid = nhSourceGuid(first.registration_guid);
  if (guid === "00000000-0000-0000-0000-000000000000") nhSourceHold("invalid_stored_registration");
  const kind = first.component;
  if (kind !== "committee" && kind !== "ie") nhSourceHold("invalid_stored_kind");
  const retrievedAt = nhReportedIso(first.source_retrieved_at), completedAt = nhReportedIso(first.source_completed_at), syncedAt = nhReportedIso(first.last_synced_at);
  if (Date.parse(completedAt) > Date.parse(syncedAt) || Date.parse(syncedAt) > Date.now() + 300_000) nhSourceHold("invalid_stored_clock");
  validateNewHampshireReportedSourceFacts({ sourceUrl: String(first.source_url), sourceRetrievedAt: retrievedAt,
    sourceCompletedAt: completedAt, sourceBaseRetrievedAt: nhReportedIso(first.source_base_retrieved_at),
    sourceManifestSha256: String(first.source_manifest_sha256), sourceByteSize: integer(first.source_byte_size, 1),
    sourceControls: first.source_controls as NewHampshireSourceControl[] }, Date.now() + 300_000);
  const totals: Parameters<typeof validateNewHampshireReportedCounts>[0] = { component: kind, sourceRows: integer(first.source_row_count), currentRows: integer(first.current_row_count),
    historicalRows: integer(first.historical_row_count), occurrenceCount: integer(first.occurrence_count), groupCount: integer(first.group_count),
    excludedCurrentRows: integer(first.excluded_current_row_count), nonpositiveRows: integer(first.nonpositive_row_count),
    totalCents: integer(first.total_amount_cents), supportCents: integer(first.support_total_cents), opposeCents: integer(first.oppose_total_cents) };
  validateNewHampshireReportedCounts(totals);
  let total = 0, support = 0, oppose = 0, occurrences = 0;
  const seen = new Set<string>(), groups: { key: string; id: string | null; name: string; stance: "direct" | "support" | "oppose"; cents: number; count: number }[] = [];
  for (const row of rows) {
    if (row.grp_key === null) {
      if (rows.length !== 1 || totals.groupCount !== 0 || [row.grp_id,row.grp_name,row.grp_stance,row.grp_cents,row.grp_count].some(v => v !== null)) nhSourceHold("invalid_empty_component");
      continue;
    }
    const key = nhSourceText(row.grp_key), name = nhSourceText(row.grp_name), stance = row.grp_stance;
    if (name !== row.grp_name || key !== row.grp_key || seen.has(`${key}:${stance}`)) nhSourceHold("invalid_stored_group");
    seen.add(`${key}:${stance}`);
    if (kind === "committee" ? stance !== "direct" || row.grp_id !== null || key !== name.toUpperCase() :
      (stance !== "support" && stance !== "oppose") || !/^[1-9]\d*$/.test(String(row.grp_id)) || key !== row.grp_id || !Number.isSafeInteger(Number(row.grp_id))) nhSourceHold("invalid_stored_group");
    const cents = integer(row.grp_cents, 1), count = integer(row.grp_count, 1);
    total = sum(total,cents); occurrences = sum(occurrences,count);
    if (stance === "support") support = sum(support,cents); else if (stance === "oppose") oppose = sum(oppose,cents);
    groups.push({key,id:row.grp_id as string|null,name,stance:stance as "direct"|"support"|"oppose",cents,count});
  }
  if (groups.length !== totals.groupCount || total !== totals.totalCents || occurrences !== totals.occurrenceCount ||
    support !== totals.supportCents || oppose !== totals.opposeCents) nhSourceHold("stored_group_total_mismatch");
  groups.sort((a,b)=>b.cents-a.cents||a.key.localeCompare(b.key)||a.stance.localeCompare(b.stance));
  return { first, year, kind, retrievedAt, groups, ...totals };
}
function emptySummary(row: Row, year: number, retrievedAt: string): BallotLookupFinanceSummary {
  return {source:"NEW_HAMPSHIRE_CFS",cycle:year,fec_candidate_id:null,controlled_committee_id:String(row.current_receiver),last_synced_at:retrievedAt,
    direct_campaign:{total_raised:null,total_spent:null,cash_on_hand:null,debts_owed:null,top_occupations:[],top_employers:[],top_industries:[],contribution_size_buckets:[]},
    outside_spending:{support_total:null,oppose_total:null,top_supporting_groups:[],top_opposing_groups:[],top_supporting_industries:[],top_opposing_industries:[]},
    backing_summary:{top_direct_donor_occupations:[],top_outside_supporting_industries:[]}};
}
function clearOutsideBacking(summary:BallotLookupFinanceSummary):BallotLookupFinanceSummary {
  return {...summary,outside_spending:{...summary.outside_spending,top_supporting_industries:[],top_opposing_industries:[]},
    backing_summary:{...summary.backing_summary,top_outside_supporting_industries:[],
      ...(summary.backing_summary.top_pac_backed_industries===undefined?{}:{top_pac_backed_industries:[]}),
      ...(summary.backing_summary.top_supporting_committee_industries===undefined?{}:{top_supporting_committee_industries:[]})}};
}
function interests(groups:ReturnType<typeof component>["groups"]):BallotLookupFinancePacInterest[] {
  const result=new Map<string,{cents:number;pacs:BallotLookupFinancePacInterest["pacs"]}>();
  for(const g of groups){
    const classified=classifyPacInterest({committeeName:g.name,committeeType:null,designation:null,organizationType:null,connectedOrganization:null});
    const interest=classified.interestSlug===null||PAC_INTERESTS_NOT_LISTED.includes(classified.interestSlug)?UNCLASSIFIED_PAC_INTEREST:classified.interestSlug;
    const group=result.get(interest)??{cents:0,pacs:[]};group.cents=sum(group.cents,g.cents);
    group.pacs.push({committee_id:`nh-reported:${g.key}`,committee_name:g.name,amount:g.cents/100,source_url:SOURCE});result.set(interest,group);
  }
  return [...result].map(([interest,g])=>({interest,interest_name:pacInterestDisplayName(interest),amount:g.cents/100,pac_count:g.pacs.length,
    pacs:g.pacs.slice(0,MAX_DISPLAY)})).sort((a,b)=>b.amount-a.amount||a.interest.localeCompare(b.interest));
}
export async function attachNewHampshireReportedFinance(input:{db:Pick<Pool|PoolClient,"query">;requests:readonly StateFinanceSummaryRequest[];
  summaries:Map<string,BallotLookupFinanceSummary>}):Promise<Map<string,BallotLookupFinanceSummary>> {
  const kinds=[...(isNewHampshireReportedIeEnabled()?["ie"]:[]),...(isNewHampshireReportedCommitteeReceiptsEnabled()?["committee"]:[])];
  if(!kinds.length||!input.requests.length)return input.summaries;
  const selected=new Map(input.requests.map(r=>[candidateElectionKey(r.candidate_id,r.election_id),r])),output=new Map(input.summaries);
  if(kinds.includes('ie'))for(const [key,summary]of output){
    if(!selected.has(key))continue;
    output.set(key,{...summary,outside_spending:{...summary.outside_spending,
      outside_coverage_note:"Previously stored New Hampshire outside spending is retained. Its acquisition date is unavailable; the headline date may reflect campaign receipts. Paper-only filings are excluded."}});
  }
  const result=await input.db.query<Row>(`WITH requested AS (SELECT candidate_id,election_id FROM jsonb_to_recordset($1::jsonb) AS req(candidate_id uuid,election_id uuid)),active AS (
    SELECT link.*,EXTRACT(YEAR FROM e.election_date)::int calendar_year,COUNT(*) OVER(PARTITION BY link.candidate_id,link.election_id) active_link_count
    FROM requested JOIN public.nh_candidate_finance_links link USING(candidate_id,election_id)
    JOIN public.candidates c ON c.id=link.candidate_id JOIN public.candidate_elections ce ON ce.candidate_id=c.id AND ce.election_id=link.election_id
    JOIN public.elections e ON e.id=link.election_id JOIN public.districts d ON d.id=e.district_id JOIN public.offices o ON o.id=e.office_id
    WHERE link.link_status='active' AND c.deleted_at IS NULL AND ce.status NOT IN ('lost','withdrawn') AND d.state='NH'
      AND e.race_type='office' AND e.election_stage='general' AND link.election_year=EXTRACT(YEAR FROM e.election_date)::int
      AND (o.scope || '::' || o.canonical_name)=ANY($2::text[]))
    SELECT src.*,link.candidate_id::text candidate_id,link.election_id::text election_id,
      src.candidate_id::text source_candidate_id,src.election_id::text source_election_id,
      link.id::text current_link_id,link.election_year link_year,link.calendar_year,
      link.filing_entity_id current_receiver,link.link_source,link.active_link_count,
      grp.reported_group_key grp_key,grp.reported_group_id grp_id,grp.reported_name grp_name,grp.support_oppose grp_stance,
      grp.amount_cents::text grp_cents,grp.occurrence_count grp_count
    FROM active link LEFT JOIN public.nh_reported_finance_components src ON src.link_id=link.id AND src.election_year=link.election_year AND src.component=ANY($3::text[])
    LEFT JOIN public.nh_reported_finance_groups grp ON grp.link_id=src.link_id AND grp.election_year=src.election_year AND grp.component=src.component
    ORDER BY link.candidate_id,link.election_id,src.component`,[JSON.stringify([...selected.values()]),[...NEW_HAMPSHIRE_FINANCE_ELIGIBLE_OFFICE_KEYS],kinds]);
  const grouped=new Map<string,Row[]>();
  for(const row of result.rows){
    if((row.component!=='ie'&&row.component!=='committee')||!kinds.includes(row.component))continue;
    const key=candidateElectionKey(String(row.candidate_id),String(row.election_id));if(!selected.has(key))continue;
    const groupKey=`${key}:${row.component}`,rows=grouped.get(groupKey)??[];rows.push(row);grouped.set(groupKey,rows);
  }
  for(const rows of grouped.values())try{
    const c=component(rows),key=candidateElectionKey(String(c.first.candidate_id),String(c.first.election_id));
    const existing=output.get(key);if(existing&&existing.cycle!==c.year)nhSourceHold("stored_summary_cycle_mismatch");
    let summary=existing??emptySummary(c.first,c.year,c.retrievedAt);
    if(!input.summaries.has(key))summary={...summary,last_synced_at:new Date(Math.min(Date.parse(summary.last_synced_at),Date.parse(c.retrievedAt))).toISOString()};
    if(c.kind==='committee')output.set(key,{...summary,direct_campaign:{...summary.direct_campaign,pac_money_by_interest:interests(c.groups),
      pac_money_basis:"reported_committee_itemized_contributions",
      pac_money_coverage_note:`Gross current itemized monetary and in-kind receipts coded Political Committee in New Hampshire CFS for the ${c.year} cycle, grouped by reported name. Later returns are not subtracted. Excludes individual/self/business contributors, loans, unitemized receipts, superseded filings and paper-only records. Data observed ${c.retrievedAt.slice(0,10)}.`}});
    else{
      const clean=clearOutsideBacking(summary),visible=(stance:"support"|"oppose")=>c.groups.filter(g=>g.stance===stance).slice(0,MAX_DISPLAY).map(g=>({committee_id:g.id!,committee_name:g.name,support_oppose:stance,amount:g.cents/100,expenditure_count:g.count,source_url:SOURCE}));
      output.set(key,{...clean,outside_spending:{...clean.outside_spending,support_total:c.supportCents/100,oppose_total:c.opposeCents/100,
        top_supporting_groups:visible('support'),top_opposing_groups:visible('oppose'),
        outside_coverage_note:`Current electronically reported New Hampshire CFS single-target independent expenditures for the ${c.year} cycle. Superseded filings, ambiguous or unsupported allocations and paper-only records are excluded. Data observed ${c.retrievedAt.slice(0,10)}; the headline update date may reflect campaign receipts.`}});
    }
  }catch(error){if(!(error instanceof NewHampshireReportedSourceError))throw error;}
  return output;
}
