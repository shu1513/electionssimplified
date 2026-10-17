import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { isNewHampshireReportedCommitteeReceiptsEnabled, isNewHampshireReportedIeEnabled } from "../config/featureFlags.js";
import { syncDueNewHampshireReportedFinance, type NewHampshireReportedFinanceBatchResult } from "../pipeline/newHampshireFinance/newHampshireReportedFinanceBatchSync.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";
import { parseNewHampshireFinancePositiveIntegerFlag, readNewHampshireFinanceFlagValue } from "./newHampshireCandidateFinanceCliArgs.js";

export function parseNewHampshireReportedFinanceArgs(args: readonly string[]) {
  assertKnownCliFlags(args,"New Hampshire reported finance",new Set(["--dry-run","--refresh"]),
    new Set(["--max-candidates","--stale-after-days","--lookback-days","--lookahead-days","--election-year","--cache-dir"]));
  const number=(name:string)=>parseNewHampshireFinancePositiveIntegerFlag(args,name,undefined);
  return {dryRun:args.includes("--dry-run"),refresh:args.includes("--refresh"),maxCandidates:number("--max-candidates"),
    staleAfterDays:number("--stale-after-days"),electionLookbackDays:number("--lookback-days"),
    electionLookaheadDays:number("--lookahead-days"),electionYear:number("--election-year"),cacheDir:readNewHampshireFinanceFlagValue(args,"--cache-dir")};
}
export function newHampshireReportedFinanceExitCode(result:NewHampshireReportedFinanceBatchResult):0|1 {
  return result.failedCount>0||result.enabled&&result.selectedCount>0&&result.ieQualifiedCount+result.committeeQualifiedCount===0?1:0;
}
async function main(){
  const options=parseNewHampshireReportedFinanceArgs(process.argv.slice(2));
  if(!isNewHampshireReportedIeEnabled()&&!isNewHampshireReportedCommitteeReceiptsEnabled()){
    console.log("New Hampshire reported finance disabled; no sources or database loaded");return;
  }
  // Runtime environment is injected by the caller/job. This independent job
  // never loads .env files or delegates to the legacy direct-finance command.
  const connectionString=process.env.DATABASE_URL?.trim();
  if(!connectionString)throw Error("DATABASE_URL is required");
  const db=new Pool({connectionString});
  try{
    const result=await syncDueNewHampshireReportedFinance({...options,db});
    console.log(JSON.stringify({type:"new_hampshire_reported_finance_due_sync",result},null,2));
    process.exitCode=newHampshireReportedFinanceExitCode(result);
  }finally{await db.end();}
}
if((process.argv[1]?pathToFileURL(process.argv[1]).href:null)===import.meta.url){
  main().catch(()=>{console.error("New Hampshire reported finance sync failed");process.exitCode=1;});
}
