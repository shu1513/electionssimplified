import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { isHawaiiCampaignFinanceSyncEnabled } from "../config/featureFlags.js";
import {
  syncDueHawaiiCandidateFinance,
  type HawaiiCandidateFinanceBatchSyncResult,
} from "../pipeline/hawaiiFinance/hawaiiCandidateFinanceBatchSync.js";
import { readStrictPositiveIntegerFlag } from "../utils/cliFlags.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";

export type SyncDueHawaiiCandidateFinanceScriptOptions = {
  dryRun: boolean;
  force: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
};

const KNOWN_BOOLEAN_FLAGS = new Set(["--dry-run", "--force"]);
const KNOWN_VALUE_FLAGS = new Set(["--lookahead-days", "--lookback-days", "--max-candidates", "--stale-after-days"]);

export function parseSyncDueHawaiiCandidateFinanceScriptArgs(
  args: readonly string[]
): SyncDueHawaiiCandidateFinanceScriptOptions {
  assertKnownCliFlags(args, "Hawaii candidate finance due sync", KNOWN_BOOLEAN_FLAGS, KNOWN_VALUE_FLAGS);
  return {
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
    maxCandidates: readStrictPositiveIntegerFlag(args, "--max-candidates"),
    staleAfterDays: readStrictPositiveIntegerFlag(args, "--stale-after-days"),
    electionLookbackDays: readStrictPositiveIntegerFlag(args, "--lookback-days"),
    electionLookaheadDays: readStrictPositiveIntegerFlag(args, "--lookahead-days"),
  };
}

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Hawaii candidate finance due sync");
  }
  return databaseUrl;
}

export function toSyncDueHawaiiCandidateFinanceScriptOutput(input: {
  startedAt: Date;
  options: SyncDueHawaiiCandidateFinanceScriptOptions;
  result: HawaiiCandidateFinanceBatchSyncResult;
}) {
  return {
    type: "hawaii_candidate_finance_due_sync",
    ts: new Date().toISOString(),
    started_at: input.startedAt.toISOString(),
    dry_run: input.options.dryRun,
    result: input.result,
  };
}

async function main(): Promise<void> {
  const startedAt = new Date();
  loadProjectEnv();
  const options = parseSyncDueHawaiiCandidateFinanceScriptArgs(process.argv.slice(2));

  if (!isHawaiiCampaignFinanceSyncEnabled(options.force)) {
    console.log("Hawaii campaign finance due sync disabled; no Hawaii data loaded");
    return;
  }

  const pool = new Pool({ connectionString: getDatabaseUrl() });

  try {
    const result = await syncDueHawaiiCandidateFinance({
      db: pool,
      now: startedAt,
      dryRun: options.dryRun,
      maxCandidates: options.maxCandidates,
      staleAfterDays: options.staleAfterDays,
      electionLookbackDays: options.electionLookbackDays,
      electionLookaheadDays: options.electionLookaheadDays,
      reportedRefresh: options.force,
    });

    console.log(JSON.stringify(toSyncDueHawaiiCandidateFinanceScriptOutput({ startedAt, options, result }), null, 2));
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Hawaii candidate finance due sync failed:", message);
    process.exitCode = 1;
  });
}
