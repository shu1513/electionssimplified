import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { syncDueHawaiiReportedFinance } from "../pipeline/hawaiiFinance/hawaiiReportedBatchSync.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";
import { readStrictPositiveIntegerFlag } from "../utils/cliFlags.js";

/** Explicit process environment only; never load .env or call legacy AI work. */
export async function runHawaiiReportedFinance(args: readonly string[], db: Pool) {
  assertKnownCliFlags(args, "Hawaii reported finance", new Set(["--dry-run", "--force"]), new Set(["--max-candidates", "--stale-after-days", "--lookback-days", "--lookahead-days"]));
  return syncDueHawaiiReportedFinance({ db, dryRun: args.includes("--dry-run"), refresh: args.includes("--force"),
    maxCandidates: readStrictPositiveIntegerFlag(args, "--max-candidates"), staleAfterDays: readStrictPositiveIntegerFlag(args, "--stale-after-days"),
    electionLookbackDays: readStrictPositiveIntegerFlag(args, "--lookback-days"), electionLookaheadDays: readStrictPositiveIntegerFlag(args, "--lookahead-days") });
}
async function main() {
  if (!process.env.DATABASE_URL?.trim()) throw Error("DATABASE_URL required");
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try { console.log(JSON.stringify(await runHawaiiReportedFinance(process.argv.slice(2), db))); } finally { await db.end(); }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(() => {
  console.error("Hawaii reported finance failed; existing observations retained"); process.exitCode = 1;
});
