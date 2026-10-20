import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { isNebraskaCampaignFinanceSyncEnabled } from "../config/featureFlags.js";
import { syncDueNebraskaReportedFinance } from "../pipeline/nebraskaFinance/nebraskaReportedBatchSync.js";
import { readStrictPositiveIntegerFlag } from "../utils/cliFlags.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";
export async function runNebraskaReportedFinanceCli(
  args: readonly string[],
  db: Pick<Pool, "query" | "connect">,
) {
  assertKnownCliFlags(
    args,
    "Nebraska reported finance",
    new Set(["--dry-run", "--force", "--refresh"]),
    new Set(["--max-candidates", "--stale-after-days"]),
  );
  if (!isNebraskaCampaignFinanceSyncEnabled(args.includes("--force")))
    return { enabled: false };
  return syncDueNebraskaReportedFinance({
    db,
    dryRun: args.includes("--dry-run"),
    forceRawDataRefresh: args.includes("--refresh"),
    maxCandidates: readStrictPositiveIntegerFlag(args, "--max-candidates"),
    staleAfterDays: readStrictPositiveIntegerFlag(args, "--stale-after-days"),
  });
}
// Deliberately uses explicit process environment only; never loads an env file.
async function main() {
  if (!process.env.DATABASE_URL?.trim())
    throw new Error("DATABASE_URL is required");
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    console.log(
      JSON.stringify(
        await runNebraskaReportedFinanceCli(process.argv.slice(2), db),
      ),
    );
  } finally {
    await db.end();
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main().catch(() => {
    console.error("Nebraska reported finance sync failed");
    process.exitCode = 1;
  });
