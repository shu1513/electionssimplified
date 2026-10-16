import {afterEach,describe,expect,it,vi} from "vitest";
import {parseSyncDueGeorgiaReportedFinanceArgs} from "../../../src/scripts/syncDueGeorgiaReportedFinance.js";
afterEach(()=>vi.unstubAllEnvs());
describe("Georgia independent ordinary sync CLI scope",()=>{
  it("parses explicit filing/election years and normal batch bounds without a receiver selector",()=>{
    expect(parseSyncDueGeorgiaReportedFinanceArgs(["--dry-run","--refresh","--cache-dir","/private/synthetic-cache",
      "--filing-year=2026","--election-year","2026","--max-candidates=25","--stale-after-days","7","--lookback-days=30","--lookahead-days","550"]))
      .toEqual({dryRun:true,refresh:true,cacheDir:"/private/synthetic-cache",filingYear:2026,electionYear:2026,maxCandidates:25,
        staleAfterDays:7,electionLookbackDays:30,electionLookaheadDays:550});
  });
  it("supports a process-only cache directory with no env-file loader",()=>{
    vi.stubEnv("GEORGIA_REPORTED_FINANCE_CACHE_DIR"," /private/synthetic-cache ");
    expect(parseSyncDueGeorgiaReportedFinanceArgs([])).toMatchObject({dryRun:false,refresh:false,cacheDir:"/private/synthetic-cache"});
  });
  it.each(["--candidate-id","--candidate-name","--committee-id","--force","--auto-link"])("rejects nonordinary or gate-bypass flag %s",flag=>{
    expect(()=>parseSyncDueGeorgiaReportedFinanceArgs([flag,"synthetic"])).toThrow();
  });
  it.each([["--max-candidates"],["--max-candidates=0"],["--filing-year=2026.5"],["--election-year=9007199254740992"],
    ["--max-candidates=25","--max-candidates=25"]])("rejects missing, malformed, unsafe or duplicate scope values: %j",args=>{
    expect(()=>parseSyncDueGeorgiaReportedFinanceArgs(args)).toThrow();
  });
});
