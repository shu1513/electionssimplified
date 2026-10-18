import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { syncDueMontanaCommitteeReceipts } from "../pipeline/montanaFinance/montanaReportedCommitteeBatchSync.js";
import { isMontanaReportedCommitteeReceiptsEnabled } from "../config/featureFlags.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";
import { readStrictPositiveIntegerFlag } from "../utils/cliFlags.js";

// Process configuration only: no environment-file loading or identity selectors.
export function parseMontanaCommitteeArgs(args:readonly string[]){
  assertKnownCliFlags(args,"Montana committee receipts",new Set(["--dry-run"]),new Set(["--stale-after-days"]));
  if(args.filter(a=>a==="--dry-run").length>1)throw new Error("Provide --dry-run at most once");
  const staleAfterDays=readStrictPositiveIntegerFlag(args,"--stale-after-days");
  return {dryRun:args.includes("--dry-run"),...(staleAfterDays===undefined?{}:{staleAfterDays})};
}
async function main(){
  const options=parseMontanaCommitteeArgs(process.argv.slice(2));
  if(!isMontanaReportedCommitteeReceiptsEnabled()){console.log(JSON.stringify({enabled:false}));return;}
  const connectionString=process.env.DATABASE_URL?.trim(),db=new Pool(connectionString?{connectionString}:undefined);
  try{console.log(JSON.stringify(await syncDueMontanaCommitteeReceipts({db,...options})));}finally{await db.end();}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)main().catch(()=>{console.error("Montana reported committee sync unavailable");process.exitCode=1;});
