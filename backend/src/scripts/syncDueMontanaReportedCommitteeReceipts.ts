import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { syncDueMontanaCommitteeReceipts } from "../pipeline/montanaFinance/montanaReportedCommitteeBatchSync.js";
import { isMontanaReportedCommitteeReceiptsEnabled } from "../config/featureFlags.js";

// Process configuration only: no environment-file loading or identity selectors.
export function parseMontanaCommitteeArgs(args:readonly string[]){
  if(args.some(a=>a!=="--dry-run")||new Set(args).size!==args.length)throw new Error("Only --dry-run is supported");
  return {dryRun:args.includes("--dry-run")};
}
async function main(){
  const options=parseMontanaCommitteeArgs(process.argv.slice(2));
  if(!isMontanaReportedCommitteeReceiptsEnabled()){console.log(JSON.stringify({enabled:false}));return;}
  const connectionString=process.env.DATABASE_URL?.trim(),db=new Pool(connectionString?{connectionString}:undefined);
  try{console.log(JSON.stringify(await syncDueMontanaCommitteeReceipts({db,...options})));}finally{await db.end();}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)main().catch(()=>{console.error("Montana reported committee sync unavailable");process.exitCode=1;});
