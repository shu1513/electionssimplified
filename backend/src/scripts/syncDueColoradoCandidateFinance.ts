import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { isColoradoCampaignFinanceSyncEnabled } from "../config/featureFlags.js";
import {
  syncDueColoradoCandidateFinance,
  type ColoradoCandidateFinanceBatchSyncResult
} from "../pipeline/coloradoFinance/coloradoCandidateFinanceBatchSync.js";
import { readStrictFlagValue, readStrictPositiveIntegerFlag } from "../utils/cliFlags.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";

export type SyncDueColoradoCandidateFinanceScriptOptions = {
  dryRun: boolean;
  force: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  rawCacheDir?: string;
  rawZipPath?: string;
  ieOnly?: boolean;
  ieCacheDir?: string;
  ieLinkId?: string;
  refreshIe?: boolean;
};

const KNOWN_BOOLEAN_FLAGS = new Set(["--dry-run", "--force", "--ie-only", "--refresh-ie"]);
const KNOWN_VALUE_FLAGS = new Set([
  "--max-candidates",
  "--stale-after-days",
  "--lookback-days",
  "--lookahead-days",
  "--raw-cache-dir",
  "--raw-zip",
  "--ie-cache-dir",
  "--ie-link-id"
]);

function assertNoUnknownColoradoCandidateFinanceArgs(args: readonly string[]): void {
  assertKnownCliFlags(args, "Colorado candidate finance due sync", KNOWN_BOOLEAN_FLAGS, KNOWN_VALUE_FLAGS);
}

export function parseSyncDueColoradoCandidateFinanceScriptArgs(
  args: readonly string[]
): SyncDueColoradoCandidateFinanceScriptOptions {
  assertNoUnknownColoradoCandidateFinanceArgs(args);
  const ieCacheDir = readStrictFlagValue(args, "--ie-cache-dir") || undefined;
  const ieLinkId = readStrictFlagValue(args, "--ie-link-id") || undefined;
  return {
    ...(args.includes("--ie-only") ? { ieOnly: true } : {}),
    ...(args.includes("--refresh-ie") ? { refreshIe: true } : {}),
    ...(ieCacheDir ? { ieCacheDir } : {}),
    ...(ieLinkId ? { ieLinkId } : {}),
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
    maxCandidates: readStrictPositiveIntegerFlag(args, "--max-candidates"),
    staleAfterDays: readStrictPositiveIntegerFlag(args, "--stale-after-days"),
    electionLookbackDays: readStrictPositiveIntegerFlag(args, "--lookback-days"),
    electionLookaheadDays: readStrictPositiveIntegerFlag(args, "--lookahead-days"),
    rawCacheDir: readStrictFlagValue(args, "--raw-cache-dir") || undefined,
    rawZipPath: readStrictFlagValue(args, "--raw-zip") || undefined
  };
}

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Colorado candidate finance due sync");
  }
  return databaseUrl;
}

export function toSyncDueColoradoCandidateFinanceScriptOutput(input: {
  startedAt: Date;
  options: SyncDueColoradoCandidateFinanceScriptOptions;
  result: ColoradoCandidateFinanceBatchSyncResult;
}) {
  return {
    type: "colorado_candidate_finance_due_sync",
    ts: new Date().toISOString(),
    started_at: input.startedAt.toISOString(),
    dry_run: input.options.dryRun,
    force: input.options.force,
    result: input.result
  };
}

async function main(): Promise<void> {
  const startedAt = new Date();
  loadProjectEnv();
  const options = parseSyncDueColoradoCandidateFinanceScriptArgs(process.argv.slice(2));

  if (!isColoradoCampaignFinanceSyncEnabled(options.force)) {
    console.log("Colorado campaign finance due sync disabled; no Colorado data loaded");
    return;
  }

  const pool = new Pool({ connectionString: getDatabaseUrl() });

  try {
    const result = await syncDueColoradoCandidateFinance({
      db: pool,
      now: startedAt,
      dryRun: options.dryRun,
      maxCandidates: options.maxCandidates,
      staleAfterDays: options.staleAfterDays,
      electionLookbackDays: options.electionLookbackDays,
      electionLookaheadDays: options.electionLookaheadDays,
      rawDataCacheDir: options.rawCacheDir,
      rawDataZipPath: options.rawZipPath,
      ieOnly: options.ieOnly,
      ieCacheDir: options.ieCacheDir,
      ieLinkId: options.ieLinkId,
      refreshIe: options.refreshIe
    });

    console.log(
      JSON.stringify(
        toSyncDueColoradoCandidateFinanceScriptOutput({
          startedAt,
          options,
          result
        }),
        null,
        2
      )
    );
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Colorado candidate finance due sync failed:", message);
    process.exitCode = 1;
  });
}
