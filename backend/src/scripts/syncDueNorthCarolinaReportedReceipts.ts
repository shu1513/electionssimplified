import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { isNorthCarolinaReportedCommitteeReceiptsEnabled } from "../config/featureFlags.js";
import { syncDueNorthCarolinaReportedReceiptFinance, type NorthCarolinaReportedReceiptFinanceBatchOptions } from "../pipeline/northCarolinaFinance/northCarolinaReportedReceiptFinanceBatchSync.js";
import { readStrictFlagValue, readStrictPositiveIntegerFlag } from "../utils/cliFlags.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";

function nonnegativeInteger(args: readonly string[], flag: string): number | undefined {
  const value = readStrictFlagValue(args, flag);
  if (value === null) return undefined;
  if (!/^(?:0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid ${flag} value`);
  return Number(value);
}
export function parseSyncDueNorthCarolinaReportedReceiptsArgs(args: readonly string[]): Omit<NorthCarolinaReportedReceiptFinanceBatchOptions, "db"> {
  assertKnownCliFlags(args, "North Carolina reported receipts", new Set(["--dry-run", "--refresh"]),
    new Set(["--cache-dir", "--election-year", "--max-candidates", "--stale-after-days", "--lookback-days", "--lookahead-days"]));
  return { dryRun: args.includes("--dry-run"), refresh: args.includes("--refresh"),
    cacheDir: readStrictFlagValue(args, "--cache-dir") ?? undefined,
    electionYear: readStrictPositiveIntegerFlag(args, "--election-year"),
    maxCandidates: readStrictPositiveIntegerFlag(args, "--max-candidates"),
    staleAfterDays: readStrictPositiveIntegerFlag(args, "--stale-after-days"),
    electionLookbackDays: nonnegativeInteger(args, "--lookback-days"),
    electionLookaheadDays: nonnegativeInteger(args, "--lookahead-days") };
}
async function main(): Promise<void> {
  const options = parseSyncDueNorthCarolinaReportedReceiptsArgs(process.argv.slice(2));
  if (!isNorthCarolinaReportedCommitteeReceiptsEnabled()) {
    console.log(JSON.stringify({ type: "north_carolina_reported_receipts_due_sync", enabled: false })); return;
  }
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is required for North Carolina reported receipt sync");
  // Process-only configuration; the ordinary result contains aggregate counters.
  const db = new Pool({ connectionString });
  try { console.log(JSON.stringify({ type: "north_carolina_reported_receipts_due_sync", ...await syncDueNorthCarolinaReportedReceiptFinance({ db, ...options }) }, null, 2)); }
  finally { await db.end(); }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => { console.error("North Carolina reported receipt sync failed"); process.exitCode = 1; });
}
