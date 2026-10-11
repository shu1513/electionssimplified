import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { isMichiganCampaignFinanceSyncEnabled } from "../config/featureFlags.js";
import {
  syncDueMichiganCandidateFinance,
  type MichiganCandidateFinanceBatchSyncResult,
} from "../pipeline/michiganFinance/michiganCandidateFinanceBatchSync.js";
import { readStrictFlagValue, readStrictPositiveIntegerFlag } from "../utils/cliFlags.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";

export type SyncDueMichiganCandidateFinanceScriptOptions = {
  dryRun: boolean;
  force: boolean;
  rawDataCacheDir?: string;
  refreshSupplementalData?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
};

const KNOWN_BOOLEAN_FLAGS = new Set(["--dry-run", "--force", "--refresh-supplemental-data"]);
const KNOWN_VALUE_FLAGS = new Set(["--raw-cache-dir", "--lookahead-days", "--lookback-days", "--max-candidates", "--stale-after-days"]);

export function parseSyncDueMichiganCandidateFinanceScriptArgs(
  args: readonly string[]
): SyncDueMichiganCandidateFinanceScriptOptions {
  assertKnownCliFlags(args, "Michigan candidate finance due sync", KNOWN_BOOLEAN_FLAGS, KNOWN_VALUE_FLAGS);
  return {
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
    ...(readStrictFlagValue(args, "--raw-cache-dir") ? { rawDataCacheDir: readStrictFlagValue(args, "--raw-cache-dir")! } : {}),
    ...(args.includes("--refresh-supplemental-data") ? { refreshSupplementalData: true } : {}),
    maxCandidates: readStrictPositiveIntegerFlag(args, "--max-candidates"),
    staleAfterDays: readStrictPositiveIntegerFlag(args, "--stale-after-days"),
    electionLookbackDays: readStrictPositiveIntegerFlag(args, "--lookback-days"),
    electionLookaheadDays: readStrictPositiveIntegerFlag(args, "--lookahead-days"),
  };
}

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Michigan candidate finance due sync");
  }
  return databaseUrl;
}

export function toSyncDueMichiganCandidateFinanceScriptOutput(input: {
  startedAt: Date;
  options: SyncDueMichiganCandidateFinanceScriptOptions;
  result: MichiganCandidateFinanceBatchSyncResult;
}) {
  return {
    type: "michigan_candidate_finance_due_sync",
    ts: new Date().toISOString(),
    started_at: input.startedAt.toISOString(),
    dry_run: input.options.dryRun,
    result: input.result,
  };
}

async function main(): Promise<void> {
  const startedAt = new Date();
  loadProjectEnv();
  const options = parseSyncDueMichiganCandidateFinanceScriptArgs(process.argv.slice(2));

  if (!isMichiganCampaignFinanceSyncEnabled(options.force)) {
    console.log("Michigan campaign finance due sync disabled; no Michigan data loaded");
    return;
  }

  const pool = new Pool({ connectionString: getDatabaseUrl() });

  try {
    const result = await syncDueMichiganCandidateFinance({
      db: pool,
      now: startedAt,
      dryRun: options.dryRun,
      rawDataCacheDir: options.rawDataCacheDir,
      refreshSupplementalData: options.refreshSupplementalData,
      maxCandidates: options.maxCandidates,
      staleAfterDays: options.staleAfterDays,
      electionLookbackDays: options.electionLookbackDays,
      electionLookaheadDays: options.electionLookaheadDays,
    });

    console.log(JSON.stringify(toSyncDueMichiganCandidateFinanceScriptOutput({ startedAt, options, result }), null, 2));
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Michigan candidate finance due sync failed:", message);
    process.exitCode = 1;
  });
}
