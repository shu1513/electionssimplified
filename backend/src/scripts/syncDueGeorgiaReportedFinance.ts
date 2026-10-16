import {pathToFileURL} from "node:url";
import {Pool} from "pg";
import {isGeorgiaReportedIeEnabled, isGeorgiaReportedCommitteeContributionsEnabled} from "../config/featureFlags.js";
import {syncDueGeorgiaReportedFinance, type GeorgiaReportedFinanceBatchOptions} from "../pipeline/georgiaFinance/georgiaReportedFinanceBatchSync.js";
import {readStrictFlagValue, readStrictPositiveIntegerFlag} from "../utils/cliFlags.js";
import {assertKnownCliFlags} from "./financeCliFlagGuard.js";

export function parseSyncDueGeorgiaReportedFinanceArgs(args: readonly string[]): Omit<GeorgiaReportedFinanceBatchOptions, "db"> {
  assertKnownCliFlags(args, "Georgia reported finance", new Set(["--dry-run", "--refresh"]),
    new Set(["--cache-dir", "--filing-year", "--election-year", "--max-candidates", "--stale-after-days", "--lookback-days", "--lookahead-days"]));
  return {dryRun: args.includes("--dry-run"), refresh: args.includes("--refresh"),
    cacheDir: readStrictFlagValue(args, "--cache-dir") || undefined,
    filingYear: readStrictPositiveIntegerFlag(args, "--filing-year"), electionYear: readStrictPositiveIntegerFlag(args, "--election-year"),
    maxCandidates: readStrictPositiveIntegerFlag(args, "--max-candidates"), staleAfterDays: readStrictPositiveIntegerFlag(args, "--stale-after-days"),
    electionLookbackDays: readStrictPositiveIntegerFlag(args, "--lookback-days"), electionLookaheadDays: readStrictPositiveIntegerFlag(args, "--lookahead-days")};
}
async function main(): Promise<void> {
  const options = parseSyncDueGeorgiaReportedFinanceArgs(process.argv.slice(2));
  if (!isGeorgiaReportedIeEnabled() && !isGeorgiaReportedCommitteeContributionsEnabled()) {
    console.log(JSON.stringify({type: "georgia_reported_finance_due_sync", enabled: false})); return;
  }
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is required for Georgia reported finance sync");
  // Configuration is process-only. Financial originals and donor rows never
  // appear in CLI output; the ordinary batch returns aggregate counters.
  const db = new Pool({connectionString});
  try { console.log(JSON.stringify({type: "georgia_reported_finance_due_sync", ...await syncDueGeorgiaReportedFinance({db, ...options})}, null, 2)); }
  finally { await db.end(); }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => {console.error("Georgia reported finance sync failed"); process.exitCode = 1;});
}
