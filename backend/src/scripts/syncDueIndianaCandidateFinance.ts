import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { isIndianaCampaignFinanceSyncEnabled } from "../config/featureFlags.js";
import {
  syncDueIndianaCandidateFinance,
  type IndianaCandidateFinanceBatchSyncResult,
} from "../pipeline/indianaFinance/indianaCandidateFinanceBatchSync.js";
import { readStrictFlagValue, readStrictPositiveIntegerFlag } from "../utils/cliFlags.js";
import { assertKnownIndianaCampaignFinanceCliArgs } from "./indianaCampaignFinanceCliArgs.js";

export type SyncDueIndianaCandidateFinanceScriptOptions = {
  dryRun: boolean;
  force: boolean;
  nativePacOnly?: boolean;
  nativePacLinkId?: string;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  rawCacheDir?: string;
  rawZipPath?: string;
};

export function parseSyncDueIndianaCandidateFinanceScriptArgs(
  args: readonly string[]
): SyncDueIndianaCandidateFinanceScriptOptions {
  assertKnownIndianaCampaignFinanceCliArgs(args, [
    { name: "--native-pac-only", takesValue: false },
    { name: "--native-pac-link-id", takesValue: true },
    { name: "--dry-run", takesValue: false },
    { name: "--force", takesValue: false },
    { name: "--max-candidates", takesValue: true },
    { name: "--stale-after-days", takesValue: true },
    { name: "--lookback-days", takesValue: true },
    { name: "--lookahead-days", takesValue: true },
    { name: "--raw-cache-dir", takesValue: true },
    { name: "--raw-zip", takesValue: true },
  ]);
  return {
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
    nativePacOnly: args.includes("--native-pac-only"),
    nativePacLinkId: readStrictFlagValue(args, "--native-pac-link-id") || undefined,
    maxCandidates: readStrictPositiveIntegerFlag(args, "--max-candidates"),
    staleAfterDays: readStrictPositiveIntegerFlag(args, "--stale-after-days"),
    electionLookbackDays: readStrictPositiveIntegerFlag(args, "--lookback-days"),
    electionLookaheadDays: readStrictPositiveIntegerFlag(args, "--lookahead-days"),
    rawCacheDir: readStrictFlagValue(args, "--raw-cache-dir") || undefined,
    rawZipPath: readStrictFlagValue(args, "--raw-zip") || undefined,
  };
}

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Indiana candidate finance due sync");
  }
  return databaseUrl;
}

export function toSyncDueIndianaCandidateFinanceScriptOutput(input: {
  startedAt: Date;
  options: SyncDueIndianaCandidateFinanceScriptOptions;
  result: IndianaCandidateFinanceBatchSyncResult;
}) {
  return {
    type: "indiana_candidate_finance_due_sync",
    ts: new Date().toISOString(),
    started_at: input.startedAt.toISOString(),
    dry_run: input.options.dryRun,
    result: input.result,
  };
}

async function main(): Promise<void> {
  const startedAt = new Date();
  loadProjectEnv();
  const options = parseSyncDueIndianaCandidateFinanceScriptArgs(process.argv.slice(2));

  if (!isIndianaCampaignFinanceSyncEnabled(options.force)) {
    console.log("Indiana campaign finance due sync disabled; no Indiana data loaded");
    return;
  }

  const pool = new Pool({ connectionString: getDatabaseUrl() });

  try {
    const result = await syncDueIndianaCandidateFinance({
      db: pool,
      nativePacOnly: options.nativePacOnly,
      nativePacLinkId: options.nativePacLinkId,
      now: startedAt,
      dryRun: options.dryRun,
      maxCandidates: options.maxCandidates,
      staleAfterDays: options.staleAfterDays,
      electionLookbackDays: options.electionLookbackDays,
      electionLookaheadDays: options.electionLookaheadDays,
      rawDataCacheDir: options.rawCacheDir,
      rawDataZipPath: options.rawZipPath,
    });

    console.log(JSON.stringify(toSyncDueIndianaCandidateFinanceScriptOutput({ startedAt, options, result }), null, 2));
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Indiana candidate finance due sync failed:", message);
    process.exitCode = 1;
  });
}
