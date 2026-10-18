import {afterEach,describe,expect,it,vi} from "vitest";
import {listDueMontanaCommitteeReceipts,syncDueMontanaCommitteeReceipts} from "../../../src/pipeline/montanaFinance/montanaReportedCommitteeBatchSync.js";
import {isMontanaReportedCommitteeReceiptsEnabled} from "../../../src/config/featureFlags.js";
import {parseMontanaCommitteeArgs} from "../../../src/scripts/syncDueMontanaReportedCommitteeReceipts.js";
afterEach(()=>vi.unstubAllEnvs());
describe("Montana independent committee schedule and gate",()=>{
  it("defaults publication off and never lets the component flag bypass the master",async()=>{
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED","true");vi.stubEnv("MONTANA_CAMPAIGN_FINANCE_ENABLED","true");vi.stubEnv("MONTANA_REPORTED_COMMITTEE_RECEIPTS_ENABLED","");
    expect(isMontanaReportedCommitteeReceiptsEnabled()).toBe(false);const query=vi.fn();
    expect(await syncDueMontanaCommitteeReceipts({db:{query} as never})).toMatchObject({enabled:false,attemptedCount:0});expect(query).not.toHaveBeenCalled();
    vi.stubEnv("MONTANA_REPORTED_COMMITTEE_RECEIPTS_ENABLED","true");vi.stubEnv("MONTANA_CAMPAIGN_FINANCE_ENABLED","false");expect(isMontanaReportedCommitteeReceiptsEnabled()).toBe(false);
  });
  it("uses its own source clock, 24-hour hold rotation, default 10 and post-election window",async()=>{
    const rows=Array.from({length:12},(_,i)=>({link_id:String(i)})),query=vi.fn(async()=>({rows})),db={query} as never;
    const r=await listDueMontanaCommitteeReceipts({db});expect(r.totalDueRows).toBe(12);expect(r.rows).toEqual(rows.slice(0,10));
    const [sql,args]=query.mock.calls[0] as unknown as [string,unknown[]];
    expect(sql).toContain("s.source_retrieved_at");expect(sql).toContain("interval '24 hours'");expect(sql).toContain("a.last_attempted_at ASC NULLS FIRST");
    expect(sql).not.toContain("mt_candidate_finance_summaries");expect(args.slice(2,5)).toEqual([98,730,7]);expect(sql).toContain("a.source_revision<>$6");expect(args[5]).toBe("mt-reported-committee-v2-contact-order");
    await expect(listDueMontanaCommitteeReceipts({db,maxCandidates:0})).rejects.toThrow();
  });
  it("does not acquire or mutate during dry run",async()=>{
    vi.stubEnv("CANDIDATE_FINANCE_ENABLED","true");vi.stubEnv("MONTANA_CAMPAIGN_FINANCE_ENABLED","true");vi.stubEnv("MONTANA_REPORTED_COMMITTEE_RECEIPTS_ENABLED","true");
    const query=vi.fn(async()=>({rows:[{link_id:"synthetic"}]})),connect=vi.fn();
    expect(await syncDueMontanaCommitteeReceipts({db:{query,connect} as never,dryRun:true})).toMatchObject({enabled:true,dryRun:true,totalDueRows:1,attemptedCount:0});expect(connect).not.toHaveBeenCalled();
  });
  it("CLI accepts dry-run and deadline staleness; no identity, year, file, amount or source-clock overrides",()=>{
    expect(parseMontanaCommitteeArgs([])).toEqual({dryRun:false});expect(parseMontanaCommitteeArgs(["--dry-run"])).toEqual({dryRun:true});
    expect(parseMontanaCommitteeArgs(["--stale-after-days","1"])).toEqual({dryRun:false,staleAfterDays:1});
    expect(parseMontanaCommitteeArgs(["--dry-run","--stale-after-days=1"])).toEqual({dryRun:true,staleAfterDays:1});
    for(const args of [["--candidate-id","100"],["--year","2026"],["--cache-dir","x"],["--source-date","x"],["--force"],["--dry-run","--dry-run"]])expect(()=>parseMontanaCommitteeArgs(args)).toThrow();
    for(const args of [["--stale-after-days"],["--stale-after-days=0"],["--stale-after-days=-1"],["--stale-after-days=1.5"],["--stale-after-days=9007199254740992"],["--stale-after-days=1","--stale-after-days=2"]])expect(()=>parseMontanaCommitteeArgs(args)).toThrow();
  });
});
