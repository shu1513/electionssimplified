import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNewHampshireReportedSourceProducer } from "../../../src/pipeline/newHampshireFinance/newHampshireReportedSourceCache.js";
import { syncDueNewHampshireReportedFinance as sync } from "../../../src/pipeline/newHampshireFinance/newHampshireReportedFinanceBatchSync.js";
import { parseNewHampshireReportedFinanceArgs } from "../../../src/scripts/syncDueNewHampshireReportedFinance.js";
import { guid,nativeFixture } from "./newHampshireReportedTestFixtures.js";

let cacheDir:string;
beforeEach(async()=>{cacheDir=await mkdtemp(join(tmpdir(),"nh-reported-batch-test-"));
  for(const name of["NEW_HAMPSHIRE_CAMPAIGN_FINANCE_ENABLED","NEW_HAMPSHIRE_REPORTED_IE_ENABLED","NEW_HAMPSHIRE_REPORTED_COMMITTEE_RECEIPTS_ENABLED"])vi.stubEnv(name,"true");
  vi.stubEnv("NEW_HAMPSHIRE_CFS_RAW_DATA_REFRESH_ENABLED","false");});
afterEach(async()=>{vi.unstubAllEnvs();await rm(cacheDir,{recursive:true,force:true});});
function db(){const query=vi.fn(async()=>({rows:[{link_id:guid(500),candidate_id:guid(501),election_id:guid(502),election_year:2026,election_date:"2026-11-03",
  candidate_name:"Synthetic Candidate",display_name:"Synthetic Candidate",structured_name:"Synthetic Candidate",candidate_name_normalized:"Synthetic Candidate",
  office_scope:"statewide",office_name:"Governor",district:null,filing_entity_id:"1000",filer_name:"Synthetic filer 1000",link_source:"cfs_registration",
  last_attempted_at:null,component_mask:null,ie_clock:null,ie_manifest:null,ie_receiver:null,committee_clock:null,committee_manifest:null,committee_receiver:null,total_rows:"1"}]}));
  return{query,connect:vi.fn()};}
describe("New Hampshire ordinary independent reported-finance batch",()=>{
  it("stays inert behind either the master or both component gates",async()=>{
    const database=db();vi.stubEnv("NEW_HAMPSHIRE_CAMPAIGN_FINANCE_ENABLED","false");
    expect((await sync({db:database as unknown as Pool,cacheDir})).enabled).toBe(false);expect(database.query).not.toHaveBeenCalled();
    vi.stubEnv("NEW_HAMPSHIRE_CAMPAIGN_FINANCE_ENABLED","true");vi.stubEnv("NEW_HAMPSHIRE_REPORTED_IE_ENABLED","false");vi.stubEnv("NEW_HAMPSHIRE_REPORTED_COMMITTEE_RECEIPTS_ENABLED","false");
    expect((await sync({db:database as unknown as Pool,cacheDir})).enabled).toBe(false);expect(database.query).not.toHaveBeenCalled();
  });
  it("uses saved verified IE even when direct finance is unavailable, without a network or DB write",async()=>{
    const fixture=nativeFixture(),producer=createNewHampshireReportedSourceProducer({cacheDir,fetchImpl:fixture.fetchImpl,minimumGapMs:0});
    const base=await producer.refreshBase(2026);await producer.refreshComponent({kind:"ie",electionYear:2026,base:base!.reference});
    const fetch=vi.spyOn(globalThis,"fetch"),database=db(),result=await sync({db:database as unknown as Pool,cacheDir,dryRun:true});
    expect(result).toMatchObject({eligibleCount:1,selectedCount:1,ieQualifiedCount:1,iePositiveCandidateCount:1,committeeHeldCount:1,attemptedCount:0,ieWrittenCount:0,failedCount:0});
    expect(fetch).not.toHaveBeenCalled();expect(database.connect).not.toHaveBeenCalled();
    expect(database.query.mock.calls.every(([sql])=>!sql.includes("nh_candidate_finance_summaries"))).toBe(true);
  });
  it("parses ordinary bounded CLI options without an identity override or publication force switch",()=>{
    expect(parseNewHampshireReportedFinanceArgs(["--dry-run","--refresh","--max-candidates=25"])).toMatchObject({dryRun:true,refresh:true,maxCandidates:25});
    expect(()=>parseNewHampshireReportedFinanceArgs(["--force"])).toThrow();
    expect(()=>parseNewHampshireReportedFinanceArgs(["--candidate-id",guid(501)])).toThrow();
    expect(()=>parseNewHampshireReportedFinanceArgs(["--max-candidates","0"])).toThrow();
  });
});
