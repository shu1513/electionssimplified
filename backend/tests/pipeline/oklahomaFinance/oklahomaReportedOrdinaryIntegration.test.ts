import type {Pool} from "pg";
import {describe,it,expect,vi,afterEach} from "vitest";
const h=vi.hoisted(()=>({sync:vi.fn()}));
vi.mock("../../../src/pipeline/oklahomaFinance/oklahomaReportedBatchSync.js",()=>({syncDueOklahomaReportedFinance:h.sync}));
import {syncDueOklahomaCandidateFinance} from "../../../src/pipeline/oklahomaFinance/oklahomaCandidateFinanceBatchSync.js";
import {parseOklahomaReportedArgs} from "../../../src/scripts/syncDueOklahomaReportedFinance.js";
import {isOklahomaReportedCommitteeEnabled,isOklahomaIndependentIeEnabled,isOklahomaReportedRawRefreshEnabled} from "../../../src/config/featureFlags.js";
afterEach(()=>vi.unstubAllEnvs());
describe("Oklahoma ordinary component wiring",()=>{
 it("runs reported acquisition before a legacy no-due return and forwards forced refresh",async()=>{
  vi.stubEnv("OKLAHOMA_CAMPAIGN_FINANCE_ENABLED","true");vi.stubEnv("OKLAHOMA_INDEPENDENT_IE_ENABLED","true");
  const order:string[]=[],query=vi.fn(async()=>{order.push("legacy");return {rows:[]};});h.sync.mockImplementation(async()=>{order.push("reported");return {enabled:true,writtenCount:1};});
  const db={query,connect:vi.fn()} as unknown as Pool,r=await syncDueOklahomaCandidateFinance({db,autoLinkMissingLinks:false,forceRawDataRefresh:true,rawDataCacheDir:"example-cache",electionLookbackDays:1,maxCandidates:5000});
  expect(order[0]).toBe("reported");expect(r.selectedCandidateCount).toBe(0);expect(r.reportedFinance?.writtenCount).toBe(1);expect(r.reportedFinanceError).toBeUndefined();
  // The legacy one-day grace never narrows the reported cohort; operational caps are forwarded.
  expect(h.sync).toHaveBeenCalledWith(expect.objectContaining({refresh:true,cacheDir:"example-cache",maxCandidates:5000}));expect(h.sync.mock.calls[0]![0]).not.toHaveProperty("electionLookbackDays");
 });
 it("a reported-component failure is recorded and the legacy sync still runs",async()=>{
  vi.stubEnv("OKLAHOMA_CAMPAIGN_FINANCE_ENABLED","true");vi.stubEnv("OKLAHOMA_INDEPENDENT_IE_ENABLED","true");
  const query=vi.fn(async()=>({rows:[]})),error=vi.spyOn(console,"error").mockImplementation(()=>{});h.sync.mockRejectedValueOnce(new Error("Invalid Oklahoma reported batch option"));
  const r=await syncDueOklahomaCandidateFinance({db:{query,connect:vi.fn()} as unknown as Pool,autoLinkMissingLinks:false,maxCandidates:5000});
  expect(r.reportedFinance).toBeUndefined();expect(r.reportedFinanceError).toBe("Invalid Oklahoma reported batch option");expect(r.selectedCandidateCount).toBe(0);expect(query).toHaveBeenCalled();
  const noPool=await syncDueOklahomaCandidateFinance({db:{query} as unknown as Pool,autoLinkMissingLinks:false});
  expect(noPool.reportedFinanceError).toMatch(/requires a pool/);expect(noPool.selectedCandidateCount).toBe(0);error.mockRestore();
 });
 it("force cannot enable publication or acquisition gates",()=>{for(const name of ["OKLAHOMA_CAMPAIGN_FINANCE_ENABLED","OKLAHOMA_REPORTED_COMMITTEE_ENABLED","OKLAHOMA_INDEPENDENT_IE_ENABLED","OKLAHOMA_REPORTED_RAW_REFRESH_ENABLED"])vi.stubEnv(name,"false");expect([isOklahomaReportedCommitteeEnabled(),isOklahomaIndependentIeEnabled(),isOklahomaReportedRawRefreshEnabled()]).toEqual([false,false,false]);vi.stubEnv("OKLAHOMA_CAMPAIGN_FINANCE_ENABLED","true");expect([isOklahomaReportedCommitteeEnabled(),isOklahomaIndependentIeEnabled(),isOklahomaReportedRawRefreshEnabled()]).toEqual([false,false,false]);});
 it("CLI accepts operational options and rejects financial/candidate overrides",()=>{expect(parseOklahomaReportedArgs([])).toMatchObject({dryRun:false,refresh:false,maxCandidates:undefined});expect(parseOklahomaReportedArgs(["--refresh","--cache-dir=example","--max-candidates","25"])).toMatchObject({refresh:true,cacheDir:"example",maxCandidates:25});for(const args of [["--candidate-id","x"],["--year","2026"],["--amount","100"],["--source-json","x"],["--max-candidates=0"]])expect(()=>parseOklahomaReportedArgs(args)).toThrow();});
});
