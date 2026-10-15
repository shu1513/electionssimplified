import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { syncDueMissouriCandidateFinance } from "../../../src/pipeline/missouriFinance/missouriCandidateFinanceBatchSync.js";

beforeEach(() => { vi.spyOn(console,"warn").mockImplementation(()=>{}); });
afterEach(() => vi.unstubAllEnvs());

function due(candidate: string, committee: string) {
  return {
    link_id: `10000000-0000-4000-8000-${String(Number(candidate.slice(1))).padStart(12,"0")}`,
    candidate_id: `20000000-0000-4000-8000-${String(Number(candidate.slice(1))).padStart(12,"0")}`,
    election_id: `30000000-0000-4000-8000-${String(Number(candidate.slice(1))).padStart(12,"0")}`, candidate_name: `Candidate ${candidate}`,
    election_year: 2026, election_date: "2026-11-03", office_scope: "state_lower",
    office_name: "State Lower Chamber Legislator", district: "1", committee_id: committee,
    committee_name: `Committee ${committee}`, link_source: "mec_portal", source_url: "https://example.test",
    last_synced_at: null, total_due_rows: "2",
  };
}

describe("syncDueMissouriCandidateFinance", () => {
  it("keeps export-snapshot availability separate from legacy grid and funders", async () => {
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED", "true");
    vi.stubEnv("MISSOURI_REGISTERED_IE_ENABLED", "true");
    const sync = vi.fn().mockResolvedValue({ registeredIeGroupsWritten: 1 });
    const result = await syncDueMissouriCandidateFinance({
      db: { query: vi.fn().mockResolvedValue({ rows: [due("c1", "C263985")] }), connect: vi.fn() } as never,
      now: new Date("2026-10-15T00:00:00Z"), autoLinkMissingLinks: false,
      acquireArtifactsFn: vi.fn().mockResolvedValue({}) as never,
      acquireOutsideArtifactsFn: vi.fn().mockResolvedValue({ year: 2026, rowCount: 1,
        sourceKind: "native_export_snapshot", registeredIeArtifactsAvailable: true, legacyOutsideArtifactsAvailable: false }) as never,
      syncCandidateFn: sync as never, session: {} as never,
    });
    const supplied = sync.mock.calls[0]![0];
    expect(supplied.outsideArtifacts).toBeNull();
    expect(supplied).not.toHaveProperty("registeredIeArtifacts");
    expect(supplied.refreshOutsideSpenderArtifacts).toBeUndefined();
    expect(result).toMatchObject({ outsideArtifactYearCount: 1, failedOutsideArtifactYearCount: 0, registeredIeArtifactYearCount: 1 });
  });

  it("continues independent IE after recipient exports fail without refreshing old cash", async () => {
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED", "true");
    vi.stubEnv("MISSOURI_REGISTERED_IE_ENABLED", "true");
    const sync = vi.fn().mockResolvedValue({ summaryWritten: false, registeredIeGroupsWritten: 1 });
    const result = await syncDueMissouriCandidateFinance({
      db: { query: vi.fn().mockResolvedValue({ rows: [due("c1", "C263985")] }), connect: vi.fn() } as never,
      now: new Date("2026-10-15T00:00:00Z"), autoLinkMissingLinks: false,
      acquireArtifactsFn: vi.fn().mockRejectedValue(new Error("recipient export unavailable")),
      acquireOutsideArtifactsFn: vi.fn().mockResolvedValue({}) as never,
      syncCandidateFn: sync as never, session: {} as never,
    });
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ directArtifactsUnavailable: true, receiptArtifacts: null }));
    expect(result).toMatchObject({ syncedCandidateCount: 1, failedCandidateCount: 0 });
  });

  it("marks both outside readers unavailable after a failed fresh annual acquisition", async () => {
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED", "true");
    vi.stubEnv("MISSOURI_REGISTERED_IE_ENABLED", "true");
    const sync = vi.fn().mockResolvedValue({});
    await syncDueMissouriCandidateFinance({
      db: { query: vi.fn().mockResolvedValue({ rows: [due("c1", "C263985")] }), connect: vi.fn() } as never,
      now: new Date("2026-10-15T00:00:00Z"), autoLinkMissingLinks: false,
      acquireArtifactsFn: vi.fn().mockResolvedValue({}) as never,
      acquireOutsideArtifactsFn: vi.fn().mockRejectedValue(new Error("annual source unavailable")),
      syncCandidateFn: sync as never, session: {} as never,
    });
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ outsideArtifacts: null, registeredIeArtifacts: null }));
  });

  it("passes independent receipt availability through when explicitly enabled", async () => {
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED", "true");
    vi.stubEnv("MISSOURI_COMMITTEE_RECEIPTS_ENABLED", "true");
    const sync = vi.fn().mockResolvedValue({ summaryWritten: false, committeeReceiptGroupsWritten: 1 });
    const result = await syncDueMissouriCandidateFinance({
      db: { query: vi.fn().mockResolvedValue({ rows: [due("c1", "C263985")] }), connect: vi.fn() } as never,
      now: new Date("2026-10-15T00:00:00Z"), autoLinkMissingLinks: false,
      acquireArtifactsFn: vi.fn().mockResolvedValue({ receiptArtifactsAvailable: true, directArtifactsAvailable: false,
        expenditureCount: null, directArtifactsSkippedReason: "Missouri MEC direct artifacts unavailable after receipt capture" }) as never,
      acquireOutsideArtifactsFn: vi.fn().mockResolvedValue({}) as never,
      syncCandidateFn: sync as never, session: {} as never,
    });
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ directArtifactsUnavailable: true }));
    expect(result).toMatchObject({ syncedCandidateCount: 1, failedCandidateCount: 0 });
  });

  it("does not refresh a stale direct snapshot after only receipts were captured", async () => {
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED", "true");
    const query = vi.fn().mockResolvedValue({ rows: [due("c1", "C263985")] });
    const sync = vi.fn();
    const result = await syncDueMissouriCandidateFinance({
      db: { query, connect: vi.fn() } as never,
      now: new Date("2026-10-15T00:00:00Z"), autoLinkMissingLinks: false,
      acquireArtifactsFn: vi.fn().mockResolvedValue({ receiptArtifactsAvailable: true,
        directArtifactsAvailable: false, expenditureCount: null,
        directArtifactsSkippedReason: "Missouri MEC direct artifacts unavailable after receipt capture" }) as never,
      acquireOutsideArtifactsFn: vi.fn().mockResolvedValue({}) as never,
      syncCandidateFn: sync as never, session: {} as never,
    });
    expect(sync).not.toHaveBeenCalled();
    expect(result).toMatchObject({ syncedCandidateCount: 0, failedCandidateCount: 1 });
  });

  it("refreshes then syncs each due candidate independently", async () => {
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED", "true");
    const query = vi.fn().mockResolvedValue({ rows: [due("c1", "C263985"), due("c2", "A233052")] });
    const acquire = vi.fn().mockResolvedValue({});
    const acquireOutside = vi.fn().mockResolvedValue({});
    const sync = vi.fn()
      .mockResolvedValueOnce({ candidateId: "c1" })
      .mockRejectedValueOnce(new Error("bad amendment lineage"));
    const result = await syncDueMissouriCandidateFinance({
      db: { query, connect: vi.fn() } as never,
      now: new Date("2026-08-19T00:00:00Z"),
      autoLinkMissingLinks: false,
      acquireArtifactsFn: acquire as never,
      acquireOutsideArtifactsFn: acquireOutside as never,
      syncCandidateFn: sync as never,
      session: {} as never,
    });
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(acquireOutside).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[1]?.[3]).toBe(38);
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ officeScope: "state_lower" }));
    expect(result).toMatchObject({
      dueCandidateCount: 2, selectedCandidateCount: 2, syncedCandidateCount: 1, failedCandidateCount: 1,
      outsideArtifactYearCount: 1, failedOutsideArtifactYearCount: 0,
    });
    expect(result.results[1]).toMatchObject({ ok: false, error: "bad amendment lineage" });
  });

  it("continues direct candidate sync when the yearly outside refresh fails", async () => {
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED", "true");
    vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED", "true");
    const query = vi.fn().mockResolvedValue({ rows: [due("c1", "C263985")] });
    const sync = vi.fn().mockResolvedValue({ candidateId: "c1" });
    const result = await syncDueMissouriCandidateFinance({
      db: { query, connect: vi.fn() } as never,
      now: new Date("2026-08-19T00:00:00Z"), autoLinkMissingLinks: false,
      acquireArtifactsFn: vi.fn().mockResolvedValue({}) as never,
      acquireOutsideArtifactsFn: vi.fn().mockRejectedValue(new Error("portal unavailable")) as never,
      syncCandidateFn: sync as never, session: {} as never,
    });
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ outsideArtifacts: null }));
    expect(result).toMatchObject({
      syncedCandidateCount: 1, failedCandidateCount: 0,
      outsideArtifactYearCount: 0, failedOutsideArtifactYearCount: 1,
    });
  });
});


describe("Missouri ordinary batch attempt boundary",()=>{
  function enabled(){vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_ENABLED","true");vi.stubEnv("MISSOURI_REGISTERED_IE_ENABLED","true");}
  it("records an exact active-link attempt before recipient work and retains it across sync failure",async()=>{
    enabled();vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED","true");
    const events:string[]=[],row=due("c1","C123456");
    const query=vi.fn().mockImplementation(async(sql:string)=>{
      if(sql.includes("INSERT INTO public.mo_candidate_finance_sync_attempts")){events.push("attempt");return{rows:[{link_id:row.link_id}]};}
      return{rows:[row]};
    });
    const result=await syncDueMissouriCandidateFinance({db:{query,connect:vi.fn()} as never,autoLinkMissingLinks:false,now:new Date("2026-10-15T12:00:00Z"),
      session:{} as never,acquireOutsideArtifactsFn:vi.fn().mockResolvedValue({}) as never,
      acquireArtifactsFn:vi.fn().mockImplementation(async()=>{events.push("recipient");return{};}) as never,
      syncCandidateFn:vi.fn().mockImplementation(async()=>{events.push("sync");throw new Error("missing window");}) as never});
    expect(events).toEqual(["attempt","recipient","sync"]);expect(result.failedCandidateCount).toBe(1);
    expect(query.mock.calls.filter(([sql])=>sql.includes("INSERT INTO public.mo_candidate_finance_sync_attempts"))).toHaveLength(1);
    expect(query.mock.calls.some(([sql])=>/DELETE|UPDATE public.mo_candidate_finance_summaries/.test(sql))).toBe(false);
  });
  it.each(["missing_active_context","database_failure"])("prevents recipient acquisition and sync on attempt %s",async mode=>{
    enabled();vi.stubEnv("MISSOURI_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED","true");
    const row=due("c1","C123456"),query=vi.fn().mockImplementation(async(sql:string)=>{
      if(sql.includes("INSERT INTO public.mo_candidate_finance_sync_attempts")){
        if(mode==="database_failure")throw new Error("private database detail");return{rows:[]};
      }return{rows:[row]};
    }),acquire=vi.fn(),sync=vi.fn();
    const result=await syncDueMissouriCandidateFinance({db:{query,connect:vi.fn()} as never,autoLinkMissingLinks:false,
      session:{} as never,acquireOutsideArtifactsFn:vi.fn().mockResolvedValue({}) as never,acquireArtifactsFn:acquire as never,syncCandidateFn:sync as never});
    expect(acquire).not.toHaveBeenCalled();expect(sync).not.toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({ok:false,error:"Missouri finance scheduling attempt unavailable"});
  });
  it.each([true,false])("never records attempts in dry-run=%s when components are disabled or dry-run enabled",async dryRun=>{
    if(dryRun)enabled();
    const query=vi.fn().mockResolvedValue({rows:[due("c1","C123456")]});
    await syncDueMissouriCandidateFinance({db:{query,connect:vi.fn()} as never,autoLinkMissingLinks:false,dryRun,
      syncCandidateFn:vi.fn().mockResolvedValue({summaryWritten:false}) as never});
    expect(query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO public.mo_candidate_finance_sync_attempts"))).toBe(false);
  });
  it("records independent-only success without fabricating a direct summary update",async()=>{
    enabled();const row=due("c1","C123456"),query=vi.fn().mockImplementation(async(sql:string)=>({rows:sql.includes("INSERT INTO")?[{link_id:row.link_id}]:[row]}));
    const sync=vi.fn().mockResolvedValue({summaryWritten:false,registeredIeGroupsWritten:0});
    const result=await syncDueMissouriCandidateFinance({db:{query,connect:vi.fn()} as never,autoLinkMissingLinks:false,syncCandidateFn:sync as never});
    expect(result.syncedCandidateCount).toBe(1);expect(result.results[0]?.result?.summaryWritten).toBe(false);
    expect(query.mock.calls.filter(([sql])=>sql.includes("INSERT INTO public.mo_candidate_finance_sync_attempts"))).toHaveLength(1);
    expect(query.mock.calls.every(([sql])=>!sql.includes("UPDATE public.mo_candidate_finance_summaries"))).toBe(true);
  });
});
