import {pathToFileURL} from "node:url";
import {Pool} from "pg";
import {syncDueMontanaIndependentIe} from "../pipeline/montanaFinance/montanaIndependentIeBatchSync.js";
import {isMontanaReportedIeEnabled} from "../config/featureFlags.js";
import {assertKnownCliFlags} from "./financeCliFlagGuard.js";
import {readStrictPositiveIntegerFlag} from "../utils/cliFlags.js";

// Process configuration only; the ordinary due queue chooses receivers.
export function parseMontanaIndependentIeArgs(args:readonly string[]){
  assertKnownCliFlags(args,"Montana independent IE",new Set(["--dry-run"]),new Set(["--stale-after-days"]));
  if(args.filter(a=>a==="--dry-run").length>1)throw new Error("Provide --dry-run at most once");
  const staleAfterDays=readStrictPositiveIntegerFlag(args,"--stale-after-days");
  return {dryRun:args.includes("--dry-run"),...(staleAfterDays===undefined?{}:{staleAfterDays})};
}
async function main(){
  const options=parseMontanaIndependentIeArgs(process.argv.slice(2));
  if(!isMontanaReportedIeEnabled()){console.log(JSON.stringify({enabled:false}));return;}
  const connectionString=process.env.DATABASE_URL?.trim(),db=new Pool(connectionString?{connectionString}:undefined);
  try{console.log(JSON.stringify(await syncDueMontanaIndependentIe({db,...options})));}finally{await db.end();}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)main().catch(()=>{console.error("Montana independent IE sync unavailable");process.exitCode=1;});
