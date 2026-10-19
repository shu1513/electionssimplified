import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { syncDueMassachusettsReportedFinance } from "../pipeline/massachusettsFinance/massachusettsReportedBatchSync.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";
import { readStrictPositiveIntegerFlag } from "../utils/cliFlags.js";

/** Component-only operational entrypoint. Uses explicit process environment;
 * it never loads an environment file or invokes legacy receipt/YTD work. */
export async function runMassachusettsReportedFinance(args: readonly string[], db: Pool) {
  assertKnownCliFlags(args,"Massachusetts reported finance",new Set(["--dry-run","--force"]),new Set(["--max-candidates","--stale-after-days","--lookback-days","--lookahead-days"]));
  return syncDueMassachusettsReportedFinance({ db, dryRun: args.includes("--dry-run"), refresh: args.includes("--force"),
    maxCandidates: readStrictPositiveIntegerFlag(args,"--max-candidates"), staleAfterDays: readStrictPositiveIntegerFlag(args,"--stale-after-days"),
    electionLookbackDays: readStrictPositiveIntegerFlag(args,"--lookback-days"), electionLookaheadDays: readStrictPositiveIntegerFlag(args,"--lookahead-days") });
}
async function main() {
  if (!process.env.DATABASE_URL?.trim()) throw Error("DATABASE_URL required");
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try { console.log(JSON.stringify(await runMassachusettsReportedFinance(process.argv.slice(2),db))); }
  finally { await db.end(); }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(() => {
  console.error("Massachusetts reported finance failed; existing observations retained"); process.exitCode = 1;
});
