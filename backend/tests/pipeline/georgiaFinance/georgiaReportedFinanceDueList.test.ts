import {describe,expect,it,vi} from "vitest";
import {GEORGIA_FINANCE_ELIGIBLE_OFFICE_KEYS} from "../../../src/pipeline/georgiaFinance/georgiaFinanceEligibleOffices.js";
import {listDueGeorgiaReportedFinance,recordGeorgiaReportedFinanceAttempt,type GeorgiaReportedFinanceDueInput}
  from "../../../src/pipeline/georgiaFinance/georgiaReportedFinanceDueList.js";
import type {GeorgiaReportedSourceFacts} from "../../../src/pipeline/georgiaFinance/georgiaReportedFinanceSourceCache.js";

const NOW=new Date("2026-10-21T12:00:00.000Z");
const OLD="2026-10-15T12:00:00.000Z",CAPTURE="2026-10-20T12:00:00.000Z";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
function source(at=CAPTURE,manifest="a".repeat(64)):GeorgiaReportedSourceFacts{return {filingYear:2026,electionYear:2026,
  sourceRetrievedAt:at,sourceCompletedAt:at,sourceManifestSha256:manifest,sourceRowCount:1,sourceByteSize:100,
  sourceUrl:"https://ethics.ga.gov/records-search-all/",sourceControls:[]};}
function eligible(n=1,extra:Record<string,unknown>={}){return {id:id(n),candidate_id:id(n+100),election_id:id(n+200),
  candidate_name:`Fixture Candidate ${n}`,election_year:2026,election_date:"2026-11-03",office_scope:"statewide",office_name:"Governor",
  district:null,committee_id:String(n+10),committee_name:`Fixture Receiver ${n}`,link_source:"manual",source_url:null,
  last_synced_at:NOW.toISOString(),total_due_rows:"1",...extra};}
function metadata(n=1,extra:Record<string,unknown>={}){return {link_id:id(n),last_attempted_at:null,component_mask:null,
  ie_clock:CAPTURE,ie_manifest:"a".repeat(64),ie_receiver:String(n+10),ie_filing_year:2026,
  contributions_clock:CAPTURE,contributions_manifest:"a".repeat(64),contributions_receiver:String(n+10),contributions_filing_year:2026,...extra};}
function database(rows=[eligible()],meta=[metadata()]){return {query:vi.fn().mockResolvedValueOnce({rows}).mockResolvedValueOnce({rows:meta})};}
const input=(extra:Partial<GeorgiaReportedFinanceDueInput>={}):GeorgiaReportedFinanceDueInput=>({now:NOW,electionYear:2026,filingYear:2026,
  maxCandidates:25,staleAfterDays:7,electionLookbackDays:30,electionLookaheadDays:550,refresh:false,
  gates:{ie:true,contributions:true},ieSource:source(),contributionSource:source(),...extra});

describe("Georgia reported finance generation-aware due selection",()=>{
  it("has no eligibility or financial query when both independent gates are disabled",async()=>{
    const db=database();expect(await listDueGeorgiaReportedFinance(db,input({gates:{ie:false,contributions:false},refresh:true})))
      .toEqual({eligibleCount:0,totalDueRows:0,rows:[]});expect(db.query).not.toHaveBeenCalled();
  });
  it.each(["ie","contributions"] as const)("selects a newer %s packet inside seven days with that source alone enabled",async kind=>{
    const db=database([eligible()],[metadata(1,{[`${kind}_clock`]:OLD})]);
    const result=await listDueGeorgiaReportedFinance(db,input({gates:{ie:kind==="ie",contributions:kind==="contributions"}}));
    expect(result.rows.map(r=>r.linkId)).toEqual([id(1)]);expect(result.totalDueRows).toBe(1);
    const sql=String(db.query.mock.calls[1]![0]);
    expect(sql).toContain(kind==="ie"?"ga_reported_ie_sources":"ga_reported_committee_sources");
    expect(sql).not.toContain(kind==="ie"?"ga_reported_committee_sources":"ga_reported_ie_sources");
  });
  it("does not depend on fresh legacy direct-summary write time to notice a newer generation",async()=>{
    const db=database([eligible(1,{last_synced_at:NOW.toISOString()})],[metadata(1,{ie_clock:OLD})]);
    expect((await listDueGeorgiaReportedFinance(db,input())).rows).toHaveLength(1);
  });
  it("does not select fresh matching components merely because the legacy direct summary is absent",async()=>{
    const db=database([eligible(1,{last_synced_at:null})]);expect((await listDueGeorgiaReportedFinance(db,input())).rows).toEqual([]);
  });
  it("never treats an older packet with another manifest as a newer DB observation",async()=>{
    const db=database([eligible()],[metadata(1,{ie_clock:"2026-10-21T10:00:00.000Z",contributions_clock:"2026-10-21T10:00:00.000Z"})]);
    expect((await listDueGeorgiaReportedFinance(db,input())).rows).toEqual([]);
  });
  it.each([
    {ie_clock:null},{ie_clock:"not-a-clock"},{ie_clock:"2026-10-22T00:00:00.000Z"},
    {ie_clock:"2026-10-01T00:00:00.000Z"},{ie_manifest:"b".repeat(64)},
    {ie_receiver:"99"},{ie_filing_year:2025},
  ])("makes missing, invalid, stale, conflicting or wrong-context stored IE due: %j",async change=>{
    expect((await listDueGeorgiaReportedFinance(database([eligible()],[metadata(1,change)]),input())).rows).toHaveLength(1);
  });
  it("suppresses same-mask retries until exactly the 24-hour boundary",async()=>{
    for(const [attempted,expected] of [["2026-10-20T12:00:00.001Z",0],["2026-10-20T12:00:00.000Z",1]] as const){
      const db=database([eligible()],[metadata(1,{ie_clock:null,last_attempted_at:attempted,component_mask:6})]);
      expect((await listDueGeorgiaReportedFinance(db,input({ieSource:null,contributionSource:null}))).rows).toHaveLength(expected);
    }
  });
  it("releases cooldown on a changed enabled mask",async()=>{
    const db=database([eligible()],[metadata(1,{ie_clock:null,last_attempted_at:NOW.toISOString(),component_mask:2})]);
    expect((await listDueGeorgiaReportedFinance(db,input({ieSource:null,contributionSource:null}))).rows).toHaveLength(1);
  });
  it("releases cooldown only when the enabled packet began after the last attempt",async()=>{
    const attempt="2026-10-21T10:30:00.000Z";
    const run=(packet:GeorgiaReportedSourceFacts)=>listDueGeorgiaReportedFinance(database([eligible()],[metadata(1,{ie_clock:OLD,last_attempted_at:attempt,component_mask:2})]),
      input({gates:{ie:true,contributions:false},ieSource:packet}));
    expect((await run({...source("2026-10-21T10:00:00.000Z"),sourceCompletedAt:"2026-10-21T11:00:00.000Z"})).rows).toHaveLength(0);
    expect((await run(source("2026-10-21T11:00:00.000Z"))).rows).toHaveLength(1);
  });
  it.each(["ie","contributions"] as const)("a newer %s packet releases cooldown when its enabled sibling packet is missing",async kind=>{
    const meta=metadata(1,{ie_clock:null,contributions_clock:null,last_attempted_at:"2026-10-21T10:30:00.000Z",component_mask:6});
    const options=input({ieSource:kind==="ie"?source("2026-10-21T11:00:00.000Z"):null,
      contributionSource:kind==="contributions"?source("2026-10-21T11:00:00.000Z"):null});
    expect((await listDueGeorgiaReportedFinance(database([eligible()],[meta]),options)).rows).toHaveLength(1);
  });
  it("does not use a disabled source's newer capture to bypass another source cooldown",async()=>{
    const db=database([eligible()],[metadata(1,{ie_clock:OLD,last_attempted_at:"2026-10-21T10:30:00.000Z",component_mask:2})]);
    expect((await listDueGeorgiaReportedFinance(db,input({gates:{ie:true,contributions:false},ieSource:source(OLD),
      contributionSource:source("2026-10-21T11:00:00.000Z")}))).rows).toHaveLength(0);
  });
  it("rotates unavailable receivers least-attempted first before applying the ordinary cap",async()=>{
    const rows=[eligible(1,{total_due_rows:"4"}),eligible(2),eligible(3),eligible(4)];
    const meta=[metadata(1,{ie_clock:null,last_attempted_at:"2026-10-19T00:00:00.000Z",component_mask:6}),
      metadata(2,{ie_clock:null}),metadata(3,{ie_clock:null,last_attempted_at:"2026-10-18T00:00:00.000Z",component_mask:6}),metadata(4,{ie_clock:null})];
    const first=await listDueGeorgiaReportedFinance(database(rows,meta),input({maxCandidates:2,ieSource:null,contributionSource:null}));
    expect(first.totalDueRows).toBe(4);expect(first.rows.map(r=>r.linkId)).toEqual([id(2),id(4)]);
    for(const n of [2,4])Object.assign(meta[n-1]!,{last_attempted_at:NOW.toISOString(),component_mask:6});
    const next=await listDueGeorgiaReportedFinance(database(rows,meta),input({maxCandidates:2,ieSource:null,contributionSource:null}));
    expect(next.rows.map(r=>r.linkId)).toEqual([id(3),id(1)]);
  });
  it("enumerates complete canonical year/office/window eligibility rather than taking the first direct-summary page",async()=>{
    const db=database();await listDueGeorgiaReportedFinance(db,input());const [sql,params]=db.query.mock.calls[0]!;
    expect(sql).toContain("district.state = 'GA'");expect(sql).toContain("candidate_election.status NOT IN ('withdrawn', 'lost')");
    expect(sql).toContain("link.link_status = 'active'");expect(sql).toContain("EXTRACT(YEAR FROM election.election_date)::int");
    expect(params).toEqual([NOW.toISOString(),7,100_000,30,550,[...GEORGIA_FINANCE_ELIGIBLE_OFFICE_KEYS],2026,true]);
  });
  it("fails closed on an incomplete ceiling result or absent per-link scheduling context",async()=>{
    const clipped=database([eligible(1,{total_due_rows:"100001"})]);
    await expect(listDueGeorgiaReportedFinance(clipped,input())).rejects.toThrow("eligibility enumeration incomplete");
    expect(clipped.query).toHaveBeenCalledTimes(1);
    await expect(listDueGeorgiaReportedFinance(database([eligible()],[]),input())).rejects.toThrow("scheduling context incomplete");
  });
  it("lets explicit refresh select young source observations under the same active gate",async()=>{
    expect((await listDueGeorgiaReportedFinance(database(),input({refresh:true}))).rows).toHaveLength(1);
  });
});

describe("Georgia reported nonfinancial attempts",()=>{
  it("does nothing with disabled gates and returns a rejected protected-link write honestly",async()=>{
    const db=database();const receiver=(await listDueGeorgiaReportedFinance(database(),input({refresh:true}))).rows[0]!;
    expect(await recordGeorgiaReportedFinanceAttempt({db,receiver,now:NOW,gates:{ie:false,contributions:false}})).toBe(false);
    expect(db.query).not.toHaveBeenCalled();db.query.mockResolvedValue({rows:[],rowCount:0} as never);
    expect(await recordGeorgiaReportedFinanceAttempt({db,receiver,now:NOW,gates:{ie:true,contributions:true}})).toBe(false);
    expect(db.query.mock.calls[0]![1]).toEqual([receiver.linkId,2026,receiver.candidateId,receiver.electionId,receiver.committeeId,"manual","2026-11-03",NOW.toISOString(),6,[...GEORGIA_FINANCE_ELIGIBLE_OFFICE_KEYS]]);
  });
});
