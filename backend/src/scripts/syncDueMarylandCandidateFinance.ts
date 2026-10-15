import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { isMarylandCampaignFinanceSyncEnabled } from "../config/featureFlags.js";
import {
  syncDueMarylandCandidateFinance,
  type MarylandCandidateFinanceBatchSyncResult,
} from "../pipeline/marylandFinance/marylandCandidateFinanceBatchSync.js";
import { readStrictFlagValue, readStrictPositiveIntegerFlag } from "../utils/cliFlags.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";
import {readMarylandCommitteePacketConfiguration} from "../pipeline/marylandFinance/marylandCommitteePacketConfiguration.js";

export type SyncDueMarylandCandidateFinanceScriptOptions = {
  dryRun: boolean;
  force: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  rawCacheDir?: string;
  committeePacketsFile?:string;
};

const KNOWN_BOOLEAN_FLAGS = new Set(["--dry-run", "--force"]);
const KNOWN_VALUE_FLAGS = new Set([
  "--max-candidates",
  "--stale-after-days",
  "--lookback-days",
  "--lookahead-days",
  "--raw-cache-dir",
  "--committee-packets-file",
]);

function validateKnownFlags(args: readonly string[]): void {
  assertKnownCliFlags(args, "Maryland candidate finance due sync", KNOWN_BOOLEAN_FLAGS, KNOWN_VALUE_FLAGS);
}

export function parseSyncDueMarylandCandidateFinanceScriptArgs(
  args: readonly string[]
): SyncDueMarylandCandidateFinanceScriptOptions {
  validateKnownFlags(args);
  return {
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
    maxCandidates: readStrictPositiveIntegerFlag(args, "--max-candidates"),
    staleAfterDays: readStrictPositiveIntegerFlag(args, "--stale-after-days"),
    electionLookbackDays: readStrictPositiveIntegerFlag(args, "--lookback-days"),
    electionLookaheadDays: readStrictPositiveIntegerFlag(args, "--lookahead-days"),
    rawCacheDir: readStrictFlagValue(args, "--raw-cache-dir") || undefined,
    committeePacketsFile:readStrictFlagValue(args,"--committee-packets-file")||undefined,
  };
}

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Maryland candidate finance due sync");
  }
  return databaseUrl;
}

export function toSyncDueMarylandCandidateFinanceScriptOutput(input: {
  startedAt: Date;
  options: SyncDueMarylandCandidateFinanceScriptOptions;
  result: MarylandCandidateFinanceBatchSyncResult;
}) {
  return {
    type: "maryland_candidate_finance_due_sync",
    ts: new Date().toISOString(),
    started_at: input.startedAt.toISOString(),
    dry_run: input.options.dryRun,
    result: input.result,
  };
}

async function main(): Promise<void> {
  const startedAt = new Date();
  loadProjectEnv();
  const options = parseSyncDueMarylandCandidateFinanceScriptArgs(process.argv.slice(2));

  if (!isMarylandCampaignFinanceSyncEnabled(options.force)) {
    console.log("Maryland campaign finance due sync disabled; no Maryland data loaded");
    return;
  }

  const pool = new Pool({ connectionString: getDatabaseUrl() });

  try {
    const result = await syncDueMarylandCandidateFinance({
      db: pool,
      now: startedAt,
      dryRun: options.dryRun,
      maxCandidates: options.maxCandidates,
      staleAfterDays: options.staleAfterDays,
      electionLookbackDays: options.electionLookbackDays,
      electionLookaheadDays: options.electionLookaheadDays,
      rawDataCacheDir: options.rawCacheDir,
      committeeMonetaryPackets:options.committeePacketsFile?await readMarylandCommitteePacketConfiguration(options.committeePacketsFile):undefined,
    });

    console.log(JSON.stringify(toSyncDueMarylandCandidateFinanceScriptOutput({ startedAt, options, result }), null, 2));
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Maryland candidate finance due sync failed:", message);
    process.exitCode = 1;
  });
}
