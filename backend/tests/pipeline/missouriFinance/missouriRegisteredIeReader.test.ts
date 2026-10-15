import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { candidateElectionKey,type BallotLookupFinanceSummary } from "../../../src/pipeline/address/ballotLookupFinanceShared.js";
import { attachMissouriRegisteredIeFinance as attach,type MissouriRegisteredIeReaderRow as Row } from "../../../src/pipeline/missouriFinance/missouriRegisteredIeReader.js";
const candidate_id="11111111-1111-4111-8111-111111111111",election_id="22222222-2222-4222-8222-222222222222";
const requests=[{candidate_id,election_id}],key=candidateElectionKey(candidate_id,election_id);
const sourceUrl="https://www.mec.mo.gov/MEC/Campaign_Finance/CF_SearchDirExp.aspx";
function rows(amounts:number[],stances=amounts.map(()=>"support")):Row[]{
  const source={candidate_id,election_id,election_year:2026,basis:"reported_registered_committee_independent_expenditures",qualifying_link_id:"33333333-3333-4333-8333-333333333333",receiving_committee_id:"C123456",
    link_candidate_id:candidate_id,link_election_id:election_id,link_election_year:2026,link_committee_id:"C123456",link_status:"active",
    cycle_start:"2026-08-05",cycle_end:"2026-11-03",support_amount_cents:String(amounts.reduce((sum,n,i)=>sum+(stances[i]==="support"?n:0),0)),
    oppose_amount_cents:String(amounts.reduce((sum,n,i)=>sum+(stances[i]==="oppose"?n:0),0)),group_count:amounts.length,expenditure_count:amounts.length*2,
    source_year:2026,source_row_count:amounts.length*2+4,source_page_count:1,candidate_name_row_count:amounts.length*2+3,
    candidate_office_mismatch_row_count:1,outside_cycle_row_count:1,matched_row_count:amounts.length*2+1,zero_amount_row_count:1,
    negative_amount_row_count:0,ambiguous_lineage_row_count:0,timely_overlap_row_count:0,source_url:sourceUrl,
    source_retrieved_at:"2026-10-13T11:00:00Z",source_sha256:"a".repeat(64),source_byte_size:"1234",last_synced_at:"2026-10-15T12:00:00Z"};
  return amounts.length?amounts.map((amount,i)=>({...source,reported_committee_name:`Example committee ${i}`,reported_name_key:`EXAMPLE COMMITTEE ${i}`,
    reported_committee_id:null,support_oppose:stances[i]!,amount_cents:String(amount),group_expenditure_count:2})):
    [{...source,reported_committee_name:null,reported_name_key:null,reported_committee_id:null,support_oppose:null,amount_cents:null,group_expenditure_count:null}];
}
function db(data:Row[]){return{query:vi.fn().mockResolvedValue({rows:data})};}
function read(data:Row[],summaries=new Map<string,BallotLookupFinanceSummary>()){return attach({db:db(data),requests,summaries});}
async function existing(){
  const summary=(await read(rows([100]))).get(key)!;
  summary.last_synced_at="2026-09-01T00:00:00Z";
  summary.direct_campaign.total_raised=999;summary.direct_campaign.direct_coverage_note="Old direct coverage";
  summary.direct_campaign.pac_money_by_interest=[{interest:"unclassified",interest_name:"Not yet sorted",amount:7,pac_count:1,pacs:[]}];
  summary.direct_campaign.pac_money_basis="reported_committee_monetary_receipts";
  summary.direct_campaign.pac_money_coverage_note="Old cash source observation";
  summary.outside_spending.top_supporting_industries=[{category_name:"Old industry",amount:9,contributor_count:1,source_url:null}];
  summary.backing_summary.top_outside_supporting_industries=[{category_name:"Old industry",amount:9,contributor_count:1,source_url:null,
    explanation:"Old funder observation",supporting_organizations:[]}];
  return summary;
}
beforeEach(()=>{vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED","true");vi.stubEnv("MISSOURI_REGISTERED_IE_ENABLED","true");});
afterEach(()=>vi.unstubAllEnvs());
describe("independent registered IE reader",()=>{
  it.each(["","false"])("makes no new-table query with independent gate %s",async flag=>{
    vi.stubEnv("MISSOURI_REGISTERED_IE_ENABLED",flag);const database=db(rows([100])),summaries=new Map<string,BallotLookupFinanceSummary>();
    expect(await attach({db:database,requests,summaries})).toBe(summaries);expect(database.query).not.toHaveBeenCalled();
  });
  it("honors parent gate and empty request set",async()=>{
    const database=db(rows([100]));vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED","false");
    await attach({db:database,requests,summaries:new Map()});vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED","true");
    await attach({db:database,requests:[],summaries:new Map()});expect(database.query).not.toHaveBeenCalled();
  });
  it("checks uncapped stance totals and occurrences before displaying five groups",async()=>{
    const database=db(rows([700,600,500,400,300,200,100],["support","support","support","support","support","support","oppose"]));
    const output=await attach({db:database,requests,summaries:new Map()}),summary=output.get(key)!;
    expect(summary.outside_spending).toMatchObject({support_total:27,oppose_total:1});
    expect(summary.outside_spending.top_supporting_groups.map(g=>g.amount)).toEqual([7,6,5,4,3]);
    expect(summary.outside_spending.top_supporting_groups.every(g=>g.expenditure_count===2 && g.committee_id.startsWith("mo-reported-ie:") && g.source_url===sourceUrl)).toBe(true);
    expect(summary.direct_campaign.total_raised).toBeNull();expect(summary.last_synced_at).toBe("2026-10-13T11:00:00.000Z");
    expect(summary.outside_spending.outside_coverage_note).toContain("2026-08-05 through 2026-11-03");
    expect(summary.outside_spending.outside_coverage_note).toContain("2026-10-13");
    expect(summary.outside_spending.outside_coverage_note).toContain("CF14");
    expect(String(database.query.mock.calls[0]?.[0])).not.toMatch(/\bLIMIT\b|amount_cents\s*>\s*0/i);
  });
  it("uses one candidate allocation rather than summing active receiving links",async()=>{
    const database=db(rows([12345]));
    expect((await attach({db:database,requests,summaries:new Map()})).get(key)?.outside_spending.support_total).toBe(123.45);
    const sql=String(database.query.mock.calls[0]?.[0]);
    expect(sql).toContain("link.id=src.qualifying_link_id");
    expect(sql).not.toContain("count(*) OVER");
    expect(sql).not.toMatch(/link\.candidate_id\s*=\s*src\.candidate_id/);
  });
  it("does not require optional spender MECIDs to include native reported spending",async()=>{
    expect((await read(rows([100]))).get(key)?.outside_spending.support_total).toBe(1);
    const data=rows([100]);data[0]!.reported_committee_id="C654321";
    expect((await read(data)).get(key)?.outside_spending.top_supporting_groups[0]?.committee_id).toBe("mo-reported-ie:EXAMPLE COMMITTEE 0");
  });
  it("preserves explicit source-qualified zero without Raised or cash zero claims",async()=>{
    const summary=(await read(rows([]))).get(key)!;
    expect(summary.outside_spending.support_total).toBe(0);expect(summary.outside_spending.oppose_total).toBe(0);
    expect(summary.outside_spending.top_supporting_groups).toEqual([]);
    expect(summary.direct_campaign.total_raised).toBeNull();expect(summary.direct_campaign.cash_on_hand).toBeNull();
  });
  it("preserves headline/direct/cash data and hides old funder presentation without mutating it",async()=>{
    const original=await existing();const result=(await read(rows([900]),new Map([[key,original]]))).get(key)!;
    expect(result.last_synced_at).toBe(original.last_synced_at);expect(result.direct_campaign).toBe(original.direct_campaign);
    expect(result.direct_campaign.pac_money_by_interest?.[0]?.amount).toBe(7);
    expect(result.outside_spending.top_supporting_industries).toEqual([]);
    expect(result.backing_summary.top_outside_supporting_industries).toEqual([]);
    expect(original.outside_spending.top_supporting_industries).toHaveLength(1);
    expect(original.backing_summary.top_outside_supporting_industries).toHaveLength(1);
    expect(result.outside_spending.outside_coverage_note).toContain("funder details were not refreshed");
  });
  it("retains prior amounts, groups, headline and cash while explaining missing acquisition age",async()=>{
    const original=await existing();
    original.backing_summary.top_pac_backed_industries=[{category_name:"Old industry",amount:9,contributor_count:1,source_url:null}];
    original.backing_summary.top_supporting_committee_industries=[{category_name:"Old industry",amount:9,contributor_count:1,source_url:null,supporting_committee_name:"Example committee"}];
    const result=(await read([],new Map([[key,original]]))).get(key)!;
    expect(result.last_synced_at).toBe(original.last_synced_at);
    expect(result.direct_campaign).toBe(original.direct_campaign);
    expect(result.outside_spending.support_total).toBe(original.outside_spending.support_total);
    expect(result.outside_spending.oppose_total).toBe(original.outside_spending.oppose_total);
    expect(result.outside_spending.top_supporting_groups).toBe(original.outside_spending.top_supporting_groups);
    expect(result.outside_spending.top_opposing_groups).toBe(original.outside_spending.top_opposing_groups);
    expect(result.outside_spending.top_supporting_industries).toEqual([]);
    expect(result.outside_spending.top_opposing_industries).toEqual([]);
    expect(result.backing_summary.top_outside_supporting_industries).toEqual([]);
    expect(result.backing_summary.top_pac_backed_industries).toEqual([]);
    expect(result.backing_summary.top_supporting_committee_industries).toEqual([]);
    expect(result.outside_spending.outside_coverage_note).toContain("Previously stored registered-committee spending is retained");
    expect(result.outside_spending.outside_coverage_note).toContain("acquisition date is unavailable");
    expect(result.outside_spending.outside_coverage_note).toContain("update date may reflect campaign receipts");
    expect(result.outside_spending.outside_coverage_note).toContain("CF14");
    expect(original.outside_spending.top_supporting_industries).toHaveLength(1);
    expect(original.backing_summary.top_pac_backed_industries).toHaveLength(1);
  });
  it("does not fabricate a summary or outside zero when no stored outside content exists",async()=>{
    expect((await read([])).size).toBe(0);
    const original=await existing();original.outside_spending={support_total:null,oppose_total:null,
      top_supporting_groups:[],top_opposing_groups:[],top_supporting_industries:[],top_opposing_industries:[]};
    original.backing_summary.top_outside_supporting_industries=[];
    expect((await read([],new Map([[key,original]]))).get(key)).toBe(original);
  });
  it("leaves existing outside presentation exactly unchanged when the independent gate is off",async()=>{
    const original=await existing(),summaries=new Map([[key,original]]),database=db([]);
    vi.stubEnv("MISSOURI_REGISTERED_IE_ENABLED","false");
    expect(await attach({db:database,requests,summaries})).toBe(summaries);
    expect(summaries.get(key)).toBe(original);expect(original.outside_spending.top_supporting_industries).toHaveLength(1);
    expect(database.query).not.toHaveBeenCalled();
  });
  it.each(["total","count","occurrences","duplicate","key","stance","receiver","foreign_candidate","foreign_election","link_year","inactive",
    "source_year","basis","cycle","hash","bytes","time","source_url","source_counts","matched_counts","negative","lineage","timely","pages","unsafe","repeated_metadata"] as const)(
    "holds corrupt complete %s controls while preserving prior money",async mode=>{
      const original=await existing(),data=rows([200,100]);
      const all=(key:keyof Row,value:unknown)=>data.forEach(row=>(row as unknown as Record<string,unknown>)[key]=value);
      if(mode==="total")all("support_amount_cents","301");
      if(mode==="count")all("group_count",1);
      if(mode==="occurrences")data[1]!.group_expenditure_count=3;
      if(mode==="duplicate")data[1]={...data[0]!};
      if(mode==="key")data[1]!.reported_name_key="other";
      if(mode==="stance")data[1]!.support_oppose="unknown";
      if(mode==="receiver")all("receiving_committee_id","C000001");
      if(mode==="foreign_candidate")all("link_candidate_id","another candidate");
      if(mode==="foreign_election")all("link_election_id","another election");
      if(mode==="link_year")all("link_election_year",2024);
      if(mode==="inactive")all("link_status","inactive");
      if(mode==="source_year")all("source_year",2024);
      if(mode==="basis")all("basis","unqualified");
      if(mode==="cycle")all("cycle_start","2026-02-30");
      if(mode==="hash")all("source_sha256","bad");
      if(mode==="bytes")all("source_byte_size","0");
      if(mode==="time")all("source_retrieved_at","2026-10-16T00:00:00Z");
      if(mode==="source_url")all("source_url","https://example.invalid");
      if(mode==="source_counts")all("candidate_name_row_count",999);
      if(mode==="matched_counts")all("matched_row_count",999);
      if(mode==="negative")all("negative_amount_row_count",1);
      if(mode==="lineage")all("ambiguous_lineage_row_count",1);
      if(mode==="timely")all("timely_overlap_row_count",1);
      if(mode==="pages")all("source_page_count",0);
      if(mode==="unsafe")data[1]!.amount_cents="9007199254740992";
      if(mode==="repeated_metadata")data[1]!.source_byte_size="1235";
      const retained=(await read(data,new Map([[key,original]]))).get(key)!;
      expect(retained.last_synced_at).toBe(original.last_synced_at);expect(retained.direct_campaign).toBe(original.direct_campaign);
      expect(retained.outside_spending.support_total).toBe(original.outside_spending.support_total);
      expect(retained.outside_spending.oppose_total).toBe(original.outside_spending.oppose_total);
      expect(retained.outside_spending.top_supporting_groups).toBe(original.outside_spending.top_supporting_groups);
      expect(retained.outside_spending.top_supporting_industries).toEqual([]);
      expect(retained.backing_summary.top_outside_supporting_industries).toEqual([]);
      expect(retained.outside_spending.outside_coverage_note).toContain("acquisition date is unavailable");
      expect((await read(data)).size).toBe(0);
    });
  it("rejects a corrupt group beyond the display cap and keeps other candidates available",async()=>{
    const bad=rows([600,500,400,300,200,100]);bad[5]!.amount_cents="101";
    const otherId="55555555-5555-4555-8555-555555555555",other=rows([100]).map(row=>({...row,candidate_id:otherId,link_candidate_id:otherId}));
    const result=await attach({db:db([...bad,...other]),requests:[...requests,{candidate_id:otherId,election_id}],summaries:new Map()});
    expect(result.has(key)).toBe(false);expect(result.get(candidateElectionKey(otherId,election_id))?.outside_spending.support_total).toBe(1);
  });
});
