import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { syncDueArizonaReportedFinance } from "../pipeline/arizonaFinance/arizonaReportedBatchSync.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";
import { readStrictPositiveIntegerFlag } from "../utils/cliFlags.js";

/** Component-only operational entrypoint. Uses explicit process environment;
 * it never loads an environment file or invokes legacy receipt/YTD work. */
export async function runArizonaReportedFinance(args: readonly string[], db: Pool) {
  assertKnownCliFlags(args,"Arizona reported finance",new Set(["--dry-run","--force"]),new Set(["--max-candidates","--stale-after-days","--lookback-days","--lookahead-days"]));
  return syncDueArizonaReportedFinance({ db, dryRun: args.includes("--dry-run"), refresh: args.includes("--force"),
    maxCandidates: readStrictPositiveIntegerFlag(args,"--max-candidates"), staleAfterDays: readStrictPositiveIntegerFlag(args,"--stale-after-days"),
    electionLookbackDays: readStrictPositiveIntegerFlag(args,"--lookback-days"), electionLookaheadDays: readStrictPositiveIntegerFlag(args,"--lookahead-days") });
}
async function main() {
  if (!process.env.DATABASE_URL?.trim()) throw Error("DATABASE_URL required");
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try { console.log(JSON.stringify(await runArizonaReportedFinance(process.argv.slice(2),db))); }
  finally { await db.end(); }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch((error: unknown) => {
  const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(`Arizona reported finance failed; existing observations retained (${cause})`); process.exitCode = 1;
});
