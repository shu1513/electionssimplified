import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { isNewMexicoCampaignFinanceSyncEnabled } from "../config/featureFlags.js";
import {
  syncDueNewMexicoCandidateFinance,
  type NewMexicoCandidateFinanceBatchSyncResult,
} from "../pipeline/newMexicoFinance/newMexicoCandidateFinanceBatchSync.js";
import { readStrictFlagValue, readStrictPositiveIntegerFlag } from "../utils/cliFlags.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";

export type SyncDueNewMexicoCandidateFinanceScriptOptions = {
  dryRun: boolean;
  force: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  rawCacheDir?: string;
};

const KNOWN_BOOLEAN_FLAGS = new Set(["--dry-run", "--force"]);
const KNOWN_VALUE_FLAGS = new Set(["--lookahead-days", "--lookback-days", "--max-candidates", "--raw-cache-dir", "--stale-after-days"]);

export function parseSyncDueNewMexicoCandidateFinanceScriptArgs(
  args: readonly string[]
): SyncDueNewMexicoCandidateFinanceScriptOptions {
  assertKnownCliFlags(args, "New Mexico candidate finance due sync", KNOWN_BOOLEAN_FLAGS, KNOWN_VALUE_FLAGS);
  return {
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
    maxCandidates: readStrictPositiveIntegerFlag(args, "--max-candidates"),
    staleAfterDays: readStrictPositiveIntegerFlag(args, "--stale-after-days"),
    electionLookbackDays: readStrictPositiveIntegerFlag(args, "--lookback-days"),
    electionLookaheadDays: readStrictPositiveIntegerFlag(args, "--lookahead-days"),
    rawCacheDir: readStrictFlagValue(args, "--raw-cache-dir") || undefined,
  };
}

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for New Mexico candidate finance due sync");
  }
  return databaseUrl;
}

export function toSyncDueNewMexicoCandidateFinanceScriptOutput(input: {
  startedAt: Date;
  options: SyncDueNewMexicoCandidateFinanceScriptOptions;
  result: NewMexicoCandidateFinanceBatchSyncResult;
}) {
  return {
    type: "new_mexico_candidate_finance_due_sync",
    ts: new Date().toISOString(),
    started_at: input.startedAt.toISOString(),
    dry_run: input.options.dryRun,
    result: input.result,
  };
}

/** Shared CLI boundary: injected local pools use the same parsed defaults. */
export async function runNewMexicoCandidateFinanceCli(args: readonly string[], db: Pick<Pool, "query" | "connect">) {
  const options = parseSyncDueNewMexicoCandidateFinanceScriptArgs(args);
  if (!isNewMexicoCampaignFinanceSyncEnabled(options.force)) return null;
  return syncDueNewMexicoCandidateFinance({
    db, dryRun: options.dryRun, maxCandidates: options.maxCandidates,
    staleAfterDays: options.staleAfterDays, electionLookbackDays: options.electionLookbackDays,
    electionLookaheadDays: options.electionLookaheadDays, rawDataCacheDir: options.rawCacheDir,
    forceRawDataRefresh: options.force,
  });
}

async function main(): Promise<void> {
  const startedAt = new Date();
  loadProjectEnv();
  const options = parseSyncDueNewMexicoCandidateFinanceScriptArgs(process.argv.slice(2));

  if (!isNewMexicoCampaignFinanceSyncEnabled(options.force)) {
    console.log("New Mexico campaign finance due sync disabled; no New Mexico data loaded");
    return;
  }

  const pool = new Pool({ connectionString: getDatabaseUrl() });

  try {
    const result = await runNewMexicoCandidateFinanceCli(process.argv.slice(2), pool);
    if (result) console.log(JSON.stringify(toSyncDueNewMexicoCandidateFinanceScriptOutput({ startedAt, options, result }), null, 2));
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("New Mexico candidate finance due sync failed:", message);
    process.exitCode = 1;
  });
}
