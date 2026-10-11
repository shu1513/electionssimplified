import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { isPennsylvaniaCampaignFinanceSyncEnabled } from "../config/featureFlags.js";
import {
  syncDuePennsylvaniaCandidateFinance,
  type PennsylvaniaCandidateFinanceBatchSyncResult,
} from "../pipeline/pennsylvaniaFinance/pennsylvaniaCandidateFinanceBatchSync.js";
import { readStrictFlagValue, readStrictPositiveIntegerFlag } from "../utils/cliFlags.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";

export type SyncDuePennsylvaniaCandidateFinanceScriptOptions = {
  dryRun: boolean;
  force: boolean;
  skipOutsideSpending: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  rawCacheDir?: string;
  rawExtractedDir?: string;
};

// --skip-outside-spending leaves the stored outside groups untouched instead
// of fetching the state's independent expenditure page.
const KNOWN_BOOLEAN_FLAGS = new Set(["--dry-run", "--force", "--skip-outside-spending"]);
const KNOWN_VALUE_FLAGS = new Set(["--lookahead-days", "--lookback-days", "--max-candidates", "--raw-cache-dir", "--raw-extracted-dir", "--stale-after-days"]);

export function parseSyncDuePennsylvaniaCandidateFinanceScriptArgs(
  args: readonly string[]
): SyncDuePennsylvaniaCandidateFinanceScriptOptions {
  assertKnownCliFlags(args, "Pennsylvania candidate finance due sync", KNOWN_BOOLEAN_FLAGS, KNOWN_VALUE_FLAGS);
  return {
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
    skipOutsideSpending: args.includes("--skip-outside-spending"),
    maxCandidates: readStrictPositiveIntegerFlag(args, "--max-candidates"),
    staleAfterDays: readStrictPositiveIntegerFlag(args, "--stale-after-days"),
    electionLookbackDays: readStrictPositiveIntegerFlag(args, "--lookback-days"),
    electionLookaheadDays: readStrictPositiveIntegerFlag(args, "--lookahead-days"),
    rawCacheDir: readStrictFlagValue(args, "--raw-cache-dir") || undefined,
    rawExtractedDir: readStrictFlagValue(args, "--raw-extracted-dir") || undefined,
  };
}

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Pennsylvania candidate finance due sync");
  }
  return databaseUrl;
}

export function toSyncDuePennsylvaniaCandidateFinanceScriptOutput(input: {
  startedAt: Date;
  options: SyncDuePennsylvaniaCandidateFinanceScriptOptions;
  result: PennsylvaniaCandidateFinanceBatchSyncResult;
}) {
  return {
    type: "pennsylvania_candidate_finance_due_sync",
    ts: new Date().toISOString(),
    started_at: input.startedAt.toISOString(),
    dry_run: input.options.dryRun,
    result: input.result,
  };
}

async function main(): Promise<void> {
  const startedAt = new Date();
  loadProjectEnv();
  const options = parseSyncDuePennsylvaniaCandidateFinanceScriptArgs(process.argv.slice(2));

  if (!isPennsylvaniaCampaignFinanceSyncEnabled(options.force)) {
    console.log("Pennsylvania campaign finance due sync disabled; no Pennsylvania data loaded");
    return;
  }

  const pool = new Pool({ connectionString: getDatabaseUrl() });

  try {
    const result = await syncDuePennsylvaniaCandidateFinance({
      db: pool,
      now: startedAt,
      dryRun: options.dryRun,
      maxCandidates: options.maxCandidates,
      staleAfterDays: options.staleAfterDays,
      electionLookbackDays: options.electionLookbackDays,
      electionLookaheadDays: options.electionLookaheadDays,
      rawDataCacheDir: options.rawCacheDir,
      rawDataExtractedDir: options.rawExtractedDir,
      fetchOutsideSpending: !options.skipOutsideSpending,
    });

    console.log(JSON.stringify(toSyncDuePennsylvaniaCandidateFinanceScriptOutput({ startedAt, options, result }), null, 2));
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Pennsylvania candidate finance due sync failed:", message);
    process.exitCode = 1;
  });
}
