import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { isDistrictOfColumbiaCampaignFinanceSyncEnabled } from "../config/featureFlags.js";
import { syncDueDcCommitteeFinance } from "../pipeline/districtOfColumbiaFinance/dcCommitteeBatchSync.js";
import { readStrictPositiveIntegerFlag } from "../utils/cliFlags.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";
export async function runDcCommitteeFinanceCli(
  args: readonly string[],
  db: Pick<Pool, "query" | "connect">,
) {
  assertKnownCliFlags(
    args,
    "DC reported committee finance",
    new Set(["--dry-run", "--force", "--refresh"]),
    new Set(["--max-candidates", "--stale-after-days"]),
  );
  if (!isDistrictOfColumbiaCampaignFinanceSyncEnabled(args.includes("--force")))
    return { enabled: false };
  return syncDueDcCommitteeFinance({
    db,
    dryRun: args.includes("--dry-run"),
    forceRawDataRefresh: args.includes("--refresh"),
    maxCandidates: readStrictPositiveIntegerFlag(args, "--max-candidates"),
    staleAfterDays: readStrictPositiveIntegerFlag(args, "--stale-after-days"),
  });
}
// Explicit process environment only. Never loads an environment file.
async function main() {
  if (!process.env.DATABASE_URL?.trim())
    throw new Error("DATABASE_URL is required");
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    console.log(
      JSON.stringify(await runDcCommitteeFinanceCli(process.argv.slice(2), db)),
    );
  } finally {
    await db.end();
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main().catch((error) => {
    console.error(
      "DC reported committee sync failed:",
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  });
