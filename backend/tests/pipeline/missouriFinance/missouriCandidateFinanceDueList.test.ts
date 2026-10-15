import { afterEach, describe, expect, it, vi } from "vitest";

import { listDueMissouriCandidateFinanceSyncRows } from "../../../src/pipeline/missouriFinance/missouriCandidateFinanceDueList.js";

afterEach(()=>vi.unstubAllEnvs());

describe("listDueMissouriCandidateFinanceSyncRows", () => {
  it("returns exact election dates needed for cycle boundaries", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      candidate_id: "c1", election_id: "e1", candidate_name: "Jane Doe", election_year: 2026,
      election_date: "2026-11-03 00:00:00+00", office_scope: "state_lower", office_name: "State Lower Chamber Legislator",
      district: "1", committee_id: "C263985", committee_name: "Jane for Missouri", link_source: "mec_portal",
      source_url: "https://example.test", last_synced_at: null, total_due_rows: "3",
    }] });
    const result = await listDueMissouriCandidateFinanceSyncRows({ query } as never, {
      now: new Date("2026-08-19T00:00:00Z"), staleAfterDays: 7, maxCandidates: 10,
      electionLookbackDays: 1, electionLookaheadDays: 730,
    });
    expect(result.totalDueRows).toBe(3);
    expect(result.rows[0]).toMatchObject({ electionDate: "2026-11-03", linkSource: "mec_portal" });
    // Builder wording (the bespoke query wrote these without AS/spaces); same select + predicate.
    expect(query.mock.calls[0]![0]).toContain("election.election_date::text AS election_date");
    expect(query.mock.calls[0]![0]).toContain("election.election_stage = 'general'");
    expect(query.mock.calls[0]![1]).toHaveLength(6);
    expect(query.mock.calls[0]![1][5]).toEqual(expect.arrayContaining([
      "state_lower::State Lower Chamber Legislator",
      "county::County Executive",
    ]));
    expect(query.mock.calls[0]![1][5]).not.toEqual(expect.arrayContaining([
      "place::City Council Member",
      "school_unified::School Board Member",
    ]));
  });
});


const options={now:new Date("2026-10-15T12:00:00Z"),staleAfterDays:7,maxCandidates:10,electionLookbackDays:38,electionLookaheadDays:730};
function enable(receipts:boolean,ie:boolean){
  vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED","true");
  vi.stubEnv("MISSOURI_COMMITTEE_RECEIPTS_ENABLED",String(receipts));
  vi.stubEnv("MISSOURI_REGISTERED_IE_ENABLED",String(ie));
}
async function capture(){const query=vi.fn().mockResolvedValue({rows:[]});await listDueMissouriCandidateFinanceSyncRows({query} as never,options);return query.mock.calls[0]!;}
describe("gated Missouri component scheduling",()=>{
  it("uses the identical legacy query and parameters with both components off or parent off",async()=>{
    enable(false,false);const legacy=await capture();
    expect(legacy[0]).not.toMatch(/sync_attempts|committee_receipt_sources|registered_ie_sources/);
    expect(legacy[1]).toHaveLength(6);
    expect(legacy[0]).toMatch(/ORDER BY summary.last_synced_at ASC NULLS FIRST/);
    enable(true,true);vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED","false");
    expect(await capture()).toEqual(legacy);
  });
  it.each([[true,false,2],[false,true,4],[true,true,6]] as const)("only joins enabled source tables receipts=%s IE=%s",async(receipts,ie,mask)=>{
    enable(receipts,ie);const [sql,parameters]=await capture();
    expect(sql.includes("mo_candidate_finance_committee_receipt_sources")).toBe(receipts);
    expect(sql.includes("mo_candidate_finance_registered_ie_sources")).toBe(ie);
    expect(parameters.slice(6)).toEqual([mask,24]);
    expect(sql).toContain("mo_candidate_finance_sync_attempts");
  });
  it("admits missing or stale independent sources despite a recent direct write using actual observation dates",async()=>{
    enable(true,true);const [sql]=await capture();
    const due=sql.slice(sql.indexOf("AND (summary.last_synced_at"),sql.indexOf("AND (attempt.last_attempted_at"));
    expect(due).toContain("OR receipt.link_id IS NULL OR receipt.source_retrieved_at <");
    expect(due).toContain("OR ie_link.id IS NULL OR ie.source_retrieved_at <");
    expect(due).not.toContain("receipt.last_synced_at");expect(due).not.toContain("ie.last_synced_at");
    expect(sql).not.toMatch(/amount|group_count|expenditure_count|receipt_count/);
  });
  it("moves attempted failure/null-direct prefixes behind never-attempted work before LIMIT",async()=>{
    enable(false,true);const [sql,parameters]=await capture();
    const order=sql.slice(sql.indexOf("ORDER BY"));
    expect(order).toMatch(/^ORDER BY CASE WHEN attempt.component_mask=\$7::smallint THEN attempt.last_attempted_at ELSE NULL END ASC NULLS FIRST, summary.last_synced_at ASC NULLS FIRST/);
    expect(order.indexOf("attempt.last_attempted_at")).toBeLessThan(order.indexOf("summary.last_synced_at"));
    expect(sql.indexOf("attempt.last_attempted_at <=")).toBeLessThan(sql.indexOf("LIMIT $3::int"));
    expect(sql).toContain("attempt.component_mask<>$7::smallint");
    expect(sql).toContain("make_interval(hours => $8::int)");expect(parameters[2]).toBe(10);expect(parameters[7]).toBe(24);
  });
  it("uses the single candidate/election IE source and requires its active protected context",async()=>{
    enable(false,true);const [sql]=await capture();
    expect(sql).toContain("ie.candidate_id=link.candidate_id AND ie.election_id=link.election_id AND ie.election_year=link.election_year");
    expect(sql).toContain("ie_link.id=ie.qualifying_link_id");expect(sql).toContain("ie_link.link_status='active'");
    expect(sql).toContain("ie_link.committee_id=ie.receiving_committee_id");
    expect(sql).not.toMatch(/ie.qualifying_link_id=link.id|SUM\(/i);
  });
  it("retains normal election, candidate, geography and office filters without a money predicate",async()=>{
    enable(true,true);const [sql,parameters]=await capture();
    for(const expected of ["link.link_status='active'","candidate.deleted_at IS NULL","district.state='MO'", "election.race_type='office'",
      "election.election_stage = 'general'","candidate_election.status NOT IN ('withdrawn', 'lost')","office.canonical_name) = ANY($6::text[])",
      "make_interval(days => $4::int)","make_interval(days => $5::int)","link.candidate_name_normalized ASC, link.id ASC"])
      expect(sql).toContain(expected);
    expect(parameters.slice(0,6)).toEqual([options.now.toISOString(),7,10,38,730,expect.arrayContaining(["county::County Executive"])]);
  });
  it("carries only gate-on internal protected context with the actual query mask",async()=>{
    enable(true,false);const query=vi.fn().mockResolvedValue({rows:[{link_id:"link",candidate_id:"candidate",election_id:"election",
      candidate_name:"Example candidate",election_year:2026,election_date:"2026-11-03",office_scope:"county",office_name:"County Executive",
      district:null,committee_id:"C123456",committee_name:"Example committee",link_source:"manual",source_url:null,last_synced_at:null,total_due_rows:"12"}]});
    const result=await listDueMissouriCandidateFinanceSyncRows({query} as never,options);
    expect(result.rows[0]).toMatchObject({linkId:"link",attemptComponentMask:2,linkSource:"manual"});expect(result.totalDueRows).toBe(12);
  });
});
