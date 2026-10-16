import type { Pool, PoolClient } from "pg";
import { isMissouriRegisteredIeEnabled } from "../../config/featureFlags.js";
import { candidateElectionKey, type BallotLookupFinanceOutsideGroup, type BallotLookupFinanceSummary,
  type StateFinanceSummaryRequest } from "../address/ballotLookupFinanceShared.js";

export type MissouriRegisteredIeReaderRow = {
  candidate_id: string; election_id: string; election_year: number; basis: string; qualifying_link_id: string; receiving_committee_id: string;
  link_candidate_id: string | null; link_election_id: string | null; link_election_year: number | null;
  link_committee_id: string | null; link_status: string | null;
  cycle_start: string; cycle_end: string; support_amount_cents: string; oppose_amount_cents: string;
  group_count: number; expenditure_count: number; source_year: number; source_row_count: number; source_page_count: number | null;
  candidate_name_row_count: number; candidate_office_mismatch_row_count: number; outside_cycle_row_count: number;
  matched_row_count: number; zero_amount_row_count: number; negative_amount_row_count: number;
  ambiguous_lineage_row_count: number; timely_overlap_row_count: number;
  source_url: string; source_retrieved_at: string; source_sha256: string; source_byte_size: string; last_synced_at: string;
  reported_committee_name: string | null; reported_name_key: string | null; reported_committee_id: string | null;
  support_oppose: string | null; amount_cents: string | null; group_expenditure_count: number | null;
};
type Row = MissouriRegisteredIeReaderRow;
const SOURCE_URL = "https://www.mec.mo.gov/MEC/Campaign_Finance/CF_SearchDirExp.aspx";
const fail = (): never => { throw new Error("invalid_missouri_stored_registered_ie_component"); };
const count = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 2_147_483_647;
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const name = (value: unknown): value is string => typeof value === "string" && value.trim() !== "" && !/[\u0000-\u001f\u007f]/u.test(value);
const clean = (value: string) => value.normalize("NFC").trim().replace(/\s+/gu, " ");
function integer(value: string | null): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return fail();
  const n=Number(value); return Number.isSafeInteger(n) ? n : fail();
}
function add(a: number,b: number): number { const n=a+b;return Number.isSafeInteger(n) ? n : fail(); }
function instant(value: string): number { const n=typeof value === "string" ? Date.parse(value) : NaN;return Number.isFinite(n) ? n : fail(); }
function date(value: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    new Date(instant(`${value}T00:00:00.000Z`)).toISOString().slice(0,10) !== value) return fail();
  return value;
}
function officialSource(value: string): boolean {
  try {const u=new URL(value);return u.protocol === "https:" && ["www.mec.mo.gov","mec.mo.gov"].includes(u.hostname) && !u.port && !u.username && !u.password && !u.hash && !u.search &&
    u.pathname.toLowerCase() === "/mec/campaign_finance/cf_searchdirexp.aspx";}catch{return false;}
}
const metadata = ["candidate_id","election_id","election_year","basis","qualifying_link_id","receiving_committee_id",
  "link_candidate_id","link_election_id","link_election_year","link_committee_id","link_status","cycle_start","cycle_end",
  "support_amount_cents","oppose_amount_cents","group_count","expenditure_count","source_year","source_row_count","source_page_count",
  "candidate_name_row_count","candidate_office_mismatch_row_count","outside_cycle_row_count","matched_row_count","zero_amount_row_count",
  "negative_amount_row_count","ambiguous_lineage_row_count","timely_overlap_row_count","source_url","source_retrieved_at","source_sha256",
  "source_byte_size","last_synced_at"] as const;
function emptySummary(src: Row): BallotLookupFinanceSummary {
  return {source:"MISSOURI_MEC",cycle:src.election_year,fec_candidate_id:null,controlled_committee_id:null,
    last_synced_at:new Date(instant(src.source_retrieved_at)).toISOString(),
    direct_campaign:{total_raised:null,total_spent:null,cash_on_hand:null,debts_owed:null,top_occupations:[],top_employers:[],
      top_industries:[],contribution_size_buckets:[]},
    outside_spending:{support_total:null,oppose_total:null,top_supporting_groups:[],top_opposing_groups:[],
      top_supporting_industries:[],top_opposing_industries:[]},
    backing_summary:{top_direct_donor_occupations:[],top_outside_supporting_industries:[]}};
}
function attach(rows: Row[], existing?: BallotLookupFinanceSummary): BallotLookupFinanceSummary {
  const src=rows[0]!;
  if (!Number.isInteger(src.election_year) || src.election_year<2024 || src.election_year>2100 || src.source_year!==src.election_year ||
    src.basis!=="reported_registered_committee_independent_expenditures" ||
    (existing && (existing.cycle!==src.election_year || existing.source!=="MISSOURI_MEC")) ||
    src.link_candidate_id!==src.candidate_id || src.link_election_id!==src.election_id || src.link_election_year!==src.election_year ||
    src.link_status!=="active" || !/^[A-Z]\d{6}$/.test(src.receiving_committee_id) || src.link_committee_id!==src.receiving_committee_id ||
    rows.some(row=>metadata.some(key=>row[key]!==src[key]))) return fail();
  const start=date(src.cycle_start),end=date(src.cycle_end);
  if (start>end || Number(start.slice(0,4))!==src.election_year || Number(end.slice(0,4))!==src.election_year ||
    !officialSource(src.source_url) || !hash(src.source_sha256) || integer(src.source_byte_size)===0 ||
    instant(src.source_retrieved_at)>instant(src.last_synced_at)) return fail();
  if (![src.group_count,src.expenditure_count,src.source_row_count,src.candidate_name_row_count,src.candidate_office_mismatch_row_count,
    src.outside_cycle_row_count,src.matched_row_count,src.zero_amount_row_count,src.negative_amount_row_count,
    src.ambiguous_lineage_row_count,src.timely_overlap_row_count].every(count) ||
    (src.source_page_count!==null && (!count(src.source_page_count) || (src.source_row_count>0 && src.source_page_count===0))) ||
    src.candidate_name_row_count>src.source_row_count ||
    src.candidate_name_row_count!==src.candidate_office_mismatch_row_count+src.outside_cycle_row_count+src.matched_row_count ||
    src.matched_row_count!==src.zero_amount_row_count+src.expenditure_count ||
    src.negative_amount_row_count!==0 || src.ambiguous_lineage_row_count!==0 || src.timely_overlap_row_count!==0 ||
    src.group_count>src.expenditure_count) return fail();
  const groups: BallotLookupFinanceOutsideGroup[]=[];const seen=new Set<string>();
  let support=0,oppose=0,expenditures=0;
  for (const row of rows) {
    if (row.reported_name_key===null) {
      if (rows.length!==1 || src.group_count!==0 || row.reported_committee_name!==null || row.reported_committee_id!==null ||
        row.support_oppose!==null || row.amount_cents!==null || row.group_expenditure_count!==null) return fail();
      continue;
    }
    if (!name(row.reported_committee_name) || clean(row.reported_committee_name)!==row.reported_committee_name ||
      row.reported_name_key!==row.reported_committee_name.toUpperCase() ||
      (row.reported_committee_id!==null && !/^[A-Z]\d{6}$/.test(row.reported_committee_id)) ||
      (row.support_oppose!=="support" && row.support_oppose!=="oppose") ||
      !count(row.group_expenditure_count) || row.group_expenditure_count===0) return fail();
    const key=`${row.reported_name_key}\u0000${row.support_oppose}`,amount=integer(row.amount_cents);
    if (seen.has(key) || amount===0) return fail();seen.add(key);expenditures=add(expenditures,row.group_expenditure_count);
    if(row.support_oppose==="support")support=add(support,amount);else oppose=add(oppose,amount);
    groups.push({committee_id:`mo-reported-ie:${row.reported_name_key}`,committee_name:row.reported_committee_name,
      support_oppose:row.support_oppose,amount:amount/100,expenditure_count:row.group_expenditure_count,source_url:SOURCE_URL});
  }
  if (groups.length!==src.group_count || expenditures!==src.expenditure_count ||
    support!==integer(src.support_amount_cents) || oppose!==integer(src.oppose_amount_cents) ||
    (groups.length===0)!==(expenditures===0) || (groups.length===0)!==(add(support,oppose)===0)) return fail();
  const top=(stance:"support"|"oppose")=>groups.filter(g=>g.support_oppose===stance)
    .sort((a,b)=>b.amount-a.amount || a.committee_id.localeCompare(b.committee_id)).slice(0,5);
  const summary=existing ?? emptySummary(src);
  const note=`Registered-committee reported itemized independent expenditures in the official export snapshot during ${start} through ${end}; source observed ${new Date(instant(src.source_retrieved_at)).toISOString().slice(0,10)}. Grouped by reported committee name. Non-committee CF14 reports (§ 130.047) are excluded. Committee-cycle funder details were not refreshed with this IE observation.`;
  return {...summary,outside_spending:{...summary.outside_spending,support_total:support/100,oppose_total:oppose/100,
    top_supporting_groups:top("support"),top_opposing_groups:top("oppose"),top_supporting_industries:[],top_opposing_industries:[],outside_coverage_note:note},
    backing_summary:{...summary.backing_summary,top_outside_supporting_industries:[],
      ...(summary.backing_summary.top_pac_backed_industries ? {top_pac_backed_industries:[]} : {}),
      ...(summary.backing_summary.top_supporting_committee_industries ? {top_supporting_committee_industries:[]} : {})}};
}

function retainPreviouslyStoredOutside(existing?: BallotLookupFinanceSummary): BallotLookupFinanceSummary | undefined {
  if (!existing || existing.source !== "MISSOURI_MEC") return existing;
  const outside = existing.outside_spending;
  const backing = existing.backing_summary;
  if (outside.support_total === null && outside.oppose_total === null &&
    outside.top_supporting_groups.length === 0 && outside.top_opposing_groups.length === 0 &&
    outside.top_supporting_industries.length === 0 && outside.top_opposing_industries.length === 0 &&
    backing.top_outside_supporting_industries.length === 0 &&
    !backing.top_pac_backed_industries?.length && !backing.top_supporting_committee_industries?.length) return existing;
  const note = "Previously stored registered-committee spending is retained; its acquisition date is unavailable. The update date may reflect campaign receipts. Non-committee CF14 reports (§ 130.047) are excluded. Committee funder details are not shown.";
  return {...existing, outside_spending: {...outside, outside_coverage_note: note,
    top_supporting_industries: [], top_opposing_industries: []},
    backing_summary: {...backing, top_outside_supporting_industries: [],
      ...(backing.top_pac_backed_industries ? {top_pac_backed_industries: []} : {}),
      ...(backing.top_supporting_committee_industries ? {top_supporting_committee_industries: []} : {})}};
}

/** A single source per candidate/election is universal across receiving links.
 * The qualifying link proves protected context; it never multiplies IE money.
 */
export async function attachMissouriRegisteredIeFinance(input: {
  db: Pick<Pool|PoolClient,"query">;requests:readonly StateFinanceSummaryRequest[];summaries:Map<string,BallotLookupFinanceSummary>;
}): Promise<Map<string,BallotLookupFinanceSummary>> {
  if(!isMissouriRegisteredIeEnabled() || !input.requests.length)return input.summaries;
  const result=await input.db.query<Row>(`WITH selected AS (
    SELECT candidate_id,election_id FROM jsonb_to_recordset($1::jsonb) AS req(candidate_id uuid,election_id uuid)
  ) SELECT src.candidate_id::text,src.election_id::text,src.election_year,src.basis,src.qualifying_link_id::text,src.receiving_committee_id,
    link.candidate_id::text AS link_candidate_id,link.election_id::text AS link_election_id,link.election_year AS link_election_year,
    link.committee_id AS link_committee_id,link.link_status,src.cycle_start::text,src.cycle_end::text,
    src.support_amount_cents::text,src.oppose_amount_cents::text,src.group_count,src.expenditure_count,
    src.source_year,src.source_row_count,src.source_page_count,src.candidate_name_row_count,src.candidate_office_mismatch_row_count,
    src.outside_cycle_row_count,src.matched_row_count,src.zero_amount_row_count,src.negative_amount_row_count,
    src.ambiguous_lineage_row_count,src.timely_overlap_row_count,src.source_url,src.source_retrieved_at::text,
    src.source_sha256,src.source_byte_size::text,src.last_synced_at::text,
    grp.reported_committee_name,grp.reported_name_key,grp.reported_committee_id,grp.support_oppose,grp.amount_cents::text,
    grp.expenditure_count AS group_expenditure_count
    FROM selected JOIN public.mo_candidate_finance_registered_ie_sources src USING(candidate_id,election_id)
    LEFT JOIN public.mo_candidate_finance_links link ON link.id=src.qualifying_link_id AND link.election_year=src.election_year
    LEFT JOIN public.mo_candidate_finance_registered_ie_groups grp ON grp.candidate_id=src.candidate_id AND grp.election_id=src.election_id
      AND grp.election_year=src.election_year
    ORDER BY src.candidate_id,src.election_id,grp.amount_cents DESC,grp.reported_name_key,grp.support_oppose`,[JSON.stringify(input.requests)]);
  const requested=new Set(input.requests.map(row=>candidateElectionKey(row.candidate_id,row.election_id)));
  const candidates=new Map<string,Row[]>();
  for(const row of result.rows){const key=candidateElectionKey(row.candidate_id,row.election_id);if(!requested.has(key))continue;
    const rows=candidates.get(key)??[];rows.push(row);candidates.set(key,rows);}
  const output=new Map(input.summaries);
  for (const key of requested) {
    const rows = candidates.get(key);
    if (rows) {
      try { output.set(key, attach(rows, output.get(key))); continue; }
      catch { /* Retain prior money and age without presenting stale funder details as current. */ }
    }
    const retained = retainPreviouslyStoredOutside(output.get(key));
    if (retained) output.set(key, retained);
  }
  return output;
}
