import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { isOhioReportedCommitteeReceiptsEnabled } from "../config/featureFlags.js";
import { syncDueOhioCommitteeReceipts, type OhioCommitteeBatchOptions } from "../pipeline/ohioFinance/ohioCommitteeBatchSync.js";
import { readStrictFlagValue, readStrictPositiveIntegerFlag } from "../utils/cliFlags.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";
export function parseSyncDueOhioCommitteeReceiptsArgs(args:readonly string[]):Omit<OhioCommitteeBatchOptions,"db">{
  assertKnownCliFlags(args,"Ohio committee receipts",new Set(["--dry-run","--refresh"]),
    new Set(["--max-candidates","--stale-after-days","--lookback-days","--lookahead-days"]));
  const nonnegative=(flag:string)=>{const v=readStrictFlagValue(args,flag);if(v===null)return undefined;
    if(!/^(?:0|[1-9]\d*)$/.test(v)||!Number.isSafeInteger(Number(v)))throw new Error(`Invalid ${flag} value`);return Number(v);};
  return {dryRun:args.includes("--dry-run"),refresh:args.includes("--refresh"),maxCandidates:readStrictPositiveIntegerFlag(args,"--max-candidates"),
    staleAfterDays:readStrictPositiveIntegerFlag(args,"--stale-after-days"),electionLookbackDays:nonnegative("--lookback-days"),electionLookaheadDays:nonnegative("--lookahead-days")};
}
async function main(){
  const options=parseSyncDueOhioCommitteeReceiptsArgs(process.argv.slice(2));
  if(!isOhioReportedCommitteeReceiptsEnabled()){console.log(JSON.stringify({type:"ohio_committee_receipts_due_sync",enabled:false}));return;}
  const connectionString=process.env.DATABASE_URL?.trim();if(!connectionString)throw new Error("DATABASE_URL is required for Ohio committee receipts");
  const db=new Pool({connectionString});try{console.log(JSON.stringify({type:"ohio_committee_receipts_due_sync",...await syncDueOhioCommitteeReceipts({db,...options})}));}finally{await db.end();}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)main().catch((e:unknown)=>{console.error("Ohio committee receipt sync failed:",e instanceof Error?e.message:String(e));process.exitCode=1;});
