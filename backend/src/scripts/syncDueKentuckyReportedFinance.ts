import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { loadProjectEnv } from "../config/env.js";
import { syncDueKentuckyReportedFinance } from "../pipeline/kentuckyFinance/kentuckyReportedBatchSync.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";
import { readStrictPositiveIntegerFlag } from "../utils/cliFlags.js";

export function parseKentuckyReportedFinanceArgs(args: readonly string[]) {
  assertKnownCliFlags(
    args,
    "Kentucky reported finance",
    new Set(["--dry-run", "--refresh"]),
    new Set([
      "--max-candidates",
      "--stale-after-days",
      "--lookback-days",
      "--lookahead-days",
    ]),
  );
  return {
    dryRun: args.includes("--dry-run"),
    refresh: args.includes("--refresh"),
    maxCandidates: readStrictPositiveIntegerFlag(args, "--max-candidates"),
    staleAfterDays: readStrictPositiveIntegerFlag(args, "--stale-after-days"),
    electionLookbackDays: readStrictPositiveIntegerFlag(
      args,
      "--lookback-days",
    ),
    electionLookaheadDays: readStrictPositiveIntegerFlag(
      args,
      "--lookahead-days",
    ),
  };
}
async function main() {
  loadProjectEnv();
  const options = parseKentuckyReportedFinanceArgs(process.argv.slice(2)),
    db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    console.log(
      JSON.stringify(await syncDueKentuckyReportedFinance({ db, ...options })),
    );
  } finally {
    await db.end();
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main().catch(() => {
    console.error("Kentucky reported finance sync failed");
    process.exitCode = 1;
  });
