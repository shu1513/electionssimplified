import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { isUtahCampaignFinanceSyncEnabled } from "../config/featureFlags.js";
import {
  syncDueUtahCandidateFinance,
  type UtahCandidateFinanceBatchSyncResult,
} from "../pipeline/utahFinance/utahCandidateFinanceBatchSync.js";
import { readStrictFlagValue, readStrictPositiveIntegerFlag } from "../utils/cliFlags.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";

export type SyncDueUtahCandidateFinanceScriptOptions = {
  ieOnly?: boolean;
  refreshIe?: boolean;
  ieNetwork?: boolean;
  committeeCashOnly?: boolean;
  candidateId?: string;
  electionYear?: number;
  refreshCommitteeCash?: boolean;
  committeeCashNetwork?: boolean;
  dryRun: boolean;
  force: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  rawCacheDir?: string;
  refreshCache: boolean;
};

const KNOWN_BOOLEAN_FLAGS = new Set(["--ie-only", "--refresh-ie", "--ie-network", "--dry-run", "--force", "--refresh-cache", "--committee-cash-only", "--refresh-committee-cash", "--committee-cash-network"]);
const KNOWN_VALUE_FLAGS = new Set(["--lookahead-days", "--lookback-days", "--max-candidates", "--raw-cache-dir", "--stale-after-days", "--candidate-id", "--year"]);

export function parseSyncDueUtahCandidateFinanceScriptArgs(
  args: readonly string[]
): SyncDueUtahCandidateFinanceScriptOptions {
  assertKnownCliFlags(args, "Utah candidate finance due sync", KNOWN_BOOLEAN_FLAGS, KNOWN_VALUE_FLAGS);
  const candidateId = readStrictFlagValue(args, "--candidate-id") ?? undefined;
  if (candidateId && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(candidateId)) throw new Error("Invalid --candidate-id");
  const electionYear = readStrictPositiveIntegerFlag(args, "--year");
  if (electionYear !== undefined && (electionYear < 1998 || electionYear > 2100)) throw new Error("Invalid --year");
  if (args.includes("--ie-only") && args.includes("--committee-cash-only")) throw new Error("Component-only flags are mutually exclusive");
  return {
    ...(args.includes("--ie-only") ? {ieOnly:true} : {}),
    ...(args.includes("--refresh-ie") ? {refreshIe:true} : {}),
    ...(args.includes("--ie-network") ? {ieNetwork:true} : {}),
    ...(args.includes("--committee-cash-only") ? {committeeCashOnly:true} : {}),
    ...(args.includes("--refresh-committee-cash") ? {refreshCommitteeCash:true} : {}),
    ...(args.includes("--committee-cash-network") ? {committeeCashNetwork:true} : {}),
    ...(candidateId ? {candidateId} : {}),
    ...(electionYear ? {electionYear} : {}),
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
    maxCandidates: readStrictPositiveIntegerFlag(args, "--max-candidates"),
    staleAfterDays: readStrictPositiveIntegerFlag(args, "--stale-after-days"),
    electionLookbackDays: readStrictPositiveIntegerFlag(args, "--lookback-days"),
    electionLookaheadDays: readStrictPositiveIntegerFlag(args, "--lookahead-days"),
    rawCacheDir: readStrictFlagValue(args, "--raw-cache-dir") || undefined,
    refreshCache: args.includes("--refresh-cache"),
  };
}

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Utah candidate finance due sync");
  }
  return databaseUrl;
}

export function toSyncDueUtahCandidateFinanceScriptOutput(input: {
  startedAt: Date;
  options: SyncDueUtahCandidateFinanceScriptOptions;
  result: UtahCandidateFinanceBatchSyncResult;
}) {
  return {
    type: "utah_candidate_finance_due_sync",
    ts: new Date().toISOString(),
    started_at: input.startedAt.toISOString(),
    dry_run: input.options.dryRun,
    refresh_cache: input.options.refreshCache,
    result: input.result,
  };
}

export async function runSyncDueUtahCandidateFinanceScript(input: {
  startedAt: Date;
  options: SyncDueUtahCandidateFinanceScriptOptions;
}): Promise<ReturnType<typeof toSyncDueUtahCandidateFinanceScriptOutput> | null> {
  if (!isUtahCampaignFinanceSyncEnabled(input.options.force)) {
    return null;
  }

  const pool = new Pool({ connectionString: getDatabaseUrl() });
  try {
    const result = await syncDueUtahCandidateFinance({
      db: pool,
      ieOnly:input.options.ieOnly,refreshIe:input.options.refreshIe,ieNetwork:input.options.ieNetwork,
      committeeCashOnly: input.options.committeeCashOnly, candidateId: input.options.candidateId,
      electionYear: input.options.electionYear, refreshCommitteeCash: input.options.refreshCommitteeCash,
      committeeCashNetwork: input.options.committeeCashNetwork,
      now: input.startedAt,
      dryRun: input.options.dryRun,
      maxCandidates: input.options.maxCandidates,
      staleAfterDays: input.options.staleAfterDays,
      electionLookbackDays: input.options.electionLookbackDays,
      electionLookaheadDays: input.options.electionLookaheadDays,
      rawDataCacheDir: input.options.rawCacheDir,
      refreshCache: input.options.refreshCache,
    });
    return toSyncDueUtahCandidateFinanceScriptOutput({ startedAt: input.startedAt, options: input.options, result });
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const startedAt = new Date();
  loadProjectEnv();
  const options = parseSyncDueUtahCandidateFinanceScriptArgs(process.argv.slice(2));
  const output = await runSyncDueUtahCandidateFinanceScript({ startedAt, options });
  if (!output) {
    console.log("Utah campaign finance due sync disabled; no Utah data loaded");
    return;
  }
  console.log(JSON.stringify(output, null, 2));
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Utah candidate finance due sync failed:", message);
    process.exitCode = 1;
  });
}
