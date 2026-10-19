import {pathToFileURL} from "node:url";
import {Pool} from "pg";
import {syncDueCaliforniaCommitteeReceipts} from "../pipeline/californiaFinance/californiaReportedCommitteeBatchSync.js";
import {isCaliforniaReportedCommitteeReceiptsEnabled} from "../config/featureFlags.js";
import {assertKnownCliFlags} from "./financeCliFlagGuard.js";
import {readStrictPositiveIntegerFlag} from "../utils/cliFlags.js";
export function parseCaliforniaReportedCommitteeArgs(args:readonly string[]){
  assertKnownCliFlags(args,"California reported committees",new Set(["--dry-run"]),new Set(["--stale-after-days"]));if(args.filter(a=>a==="--dry-run").length>1)throw new Error("Provide --dry-run at most once");
  const staleAfterDays=readStrictPositiveIntegerFlag(args,"--stale-after-days");return {dryRun:args.includes("--dry-run"),...(staleAfterDays===undefined?{}:{staleAfterDays})};
}
async function main(){const options=parseCaliforniaReportedCommitteeArgs(process.argv.slice(2));if(!isCaliforniaReportedCommitteeReceiptsEnabled()){console.log(JSON.stringify({enabled:false}));return;}
  const connectionString=process.env.DATABASE_URL?.trim(),db=new Pool(connectionString?{connectionString}:undefined);try{console.log(JSON.stringify(await syncDueCaliforniaCommitteeReceipts({db,...options})));}finally{await db.end();}}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)main().catch((e:unknown)=>{console.error("California reported committee sync unavailable:",e instanceof Error?e.message:String(e));process.exitCode=1;});
