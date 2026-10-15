import { describe, expect, it, vi } from "vitest";
import { recordMissouriCandidateFinanceAttempt as record } from "../../../src/pipeline/missouriFinance/missouriCandidateFinanceAttempts.js";

const linkId="10000000-0000-4000-8000-000000000001";
const input={linkId,electionYear:2026,candidateId:"20000000-0000-4000-8000-000000000001",
  electionId:"30000000-0000-4000-8000-000000000001",committeeId:"C123456",
  attemptedAt:new Date("2026-10-15T12:00:00Z"),componentMask:6 as const};

describe("Missouri finance attempt recording",()=>{
  it("stores only retry context while requiring the exact active receiving link",async()=>{
    const query=vi.fn().mockResolvedValue({rows:[{link_id:linkId}]});await record({...input,db:{query} as never});
    const [sql,parameters]=query.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO public.mo_candidate_finance_sync_attempts");
    expect(sql).toContain("(link_id, election_year, last_attempted_at, component_mask)");
    expect(sql).toContain("SELECT link.id, link.election_year");
    expect(sql).toContain("link.id=$1::uuid AND link.election_year=$2::int");
    expect(sql).toContain("link.candidate_id=$3::uuid AND link.election_id=$4::uuid");
    expect(sql).toContain("link.committee_id=$5 AND link.link_status='active'");
    expect(sql).toContain("attempt.last_attempted_at < EXCLUDED.last_attempted_at");
    expect(sql).toContain("attempt.last_attempted_at=EXCLUDED.last_attempted_at AND attempt.component_mask=EXCLUDED.component_mask");
    expect(sql).not.toContain("attempt.last_attempted_at <=");
    expect(sql).not.toMatch(/UPDATE public\.mo_candidate_finance_links|source_retrieved_at|last_synced_at|amount|reason|candidate_name/);
    expect(parameters).toEqual([linkId,2026,input.candidateId,input.electionId,"C123456",input.attemptedAt.toISOString(),6]);
  });
  it.each([[],[{link_id:"10000000-0000-4000-8000-000000000002"}]])("rejects disabled/replaced/older context with no accepted row",async rows=>{
    await expect(record({...input,db:{query:vi.fn().mockResolvedValue({rows})} as never}))
      .rejects.toThrow("Missouri finance scheduling attempt unavailable");
  });
  it("fails closed when an equal-clock different-mask update is not accepted",async()=>{
    const query=vi.fn().mockResolvedValue({rows:[]});
    await expect(record({...input,componentMask:4,db:{query} as never})).rejects.toThrow("Missouri finance scheduling attempt unavailable");
    expect(query.mock.calls[0]![0]).toContain("attempt.last_attempted_at=EXCLUDED.last_attempted_at AND attempt.component_mask=EXCLUDED.component_mask");
    expect(query.mock.calls[0]![1]![6]).toBe(4);
  });
  it("does not expose a database error or its source details",async()=>{
    await expect(record({...input,db:{query:vi.fn().mockRejectedValue(new Error("private database detail"))} as never}))
      .rejects.toThrow(/^Missouri finance scheduling attempt unavailable$/);
  });
  it.each(["link","candidate","election","year","receiver","time","mask"])("rejects invalid %s before querying",async mode=>{
    const query=vi.fn(),bad={...input,db:{query} as never};
    if(mode==="link")bad.linkId="bad";
    if(mode==="candidate")bad.candidateId="bad";
    if(mode==="election")bad.electionId="bad";
    if(mode==="year")bad.electionYear=2023;
    if(mode==="receiver")bad.committeeId="bad";
    if(mode==="time")bad.attemptedAt=new Date(NaN);
    if(mode==="mask")(bad as {componentMask:number}).componentMask=1;
    await expect(record(bad)).rejects.toThrow("Missouri finance scheduling attempt unavailable");
    expect(query).not.toHaveBeenCalled();
  });
});
