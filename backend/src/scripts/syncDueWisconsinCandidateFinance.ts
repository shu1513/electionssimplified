import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { isWisconsinCampaignFinanceSyncEnabled } from "../config/featureFlags.js";
import {
  syncDueWisconsinCandidateFinance,
  type WisconsinCandidateFinanceBatchSyncResult,
} from "../pipeline/wisconsinFinance/wisconsinCandidateFinanceBatchSync.js";
import { readStrictFlagValue, readStrictPositiveIntegerFlag } from "../utils/cliFlags.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";

export type SyncDueWisconsinCandidateFinanceScriptOptions = {
  dryRun: boolean;
  force: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  candidateId?: string;
  electionYear?: number;
  committeeCashOnly?: boolean;
  refreshCommitteeCash?: boolean;
  rawDataCacheDir?: string;
  refreshCache?: boolean;
};

const KNOWN_BOOLEAN_FLAGS = new Set(["--dry-run", "--force", "--committee-cash-only", "--refresh-committee-cash", "--refresh-cache"]);
const KNOWN_VALUE_FLAGS = new Set(["--lookahead-days", "--lookback-days", "--max-candidates", "--stale-after-days", "--candidate-id", "--election-year", "--raw-cache-dir"]);

export function parseSyncDueWisconsinCandidateFinanceScriptArgs(
  args: readonly string[]
): SyncDueWisconsinCandidateFinanceScriptOptions {
  assertKnownCliFlags(args, "Wisconsin candidate finance due sync", KNOWN_BOOLEAN_FLAGS, KNOWN_VALUE_FLAGS);
  const candidateId = readStrictFlagValue(args, "--candidate-id");
  const electionYear = readStrictPositiveIntegerFlag(args, "--election-year");
  const rawDataCacheDir = readStrictFlagValue(args, "--raw-cache-dir");
  const committeeCashOnly = args.includes("--committee-cash-only");
  if (candidateId && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(candidateId)) {
    throw new Error("Invalid --candidate-id UUID");
  }
  if (electionYear !== undefined && (electionYear < 2000 || electionYear > 2100)) throw new Error("Invalid --election-year range");
  if ((candidateId || electionYear !== undefined) && !committeeCashOnly) {
    throw new Error("Wisconsin candidate/year targeting requires --committee-cash-only");
  }
  return {
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
    maxCandidates: readStrictPositiveIntegerFlag(args, "--max-candidates"),
    staleAfterDays: readStrictPositiveIntegerFlag(args, "--stale-after-days"),
    electionLookbackDays: readStrictPositiveIntegerFlag(args, "--lookback-days"),
    electionLookaheadDays: readStrictPositiveIntegerFlag(args, "--lookahead-days"),
    ...(candidateId ? { candidateId } : {}),...(electionYear !== undefined ? { electionYear } : {}),
    ...(rawDataCacheDir ? { rawDataCacheDir } : {}),...(committeeCashOnly ? { committeeCashOnly: true } : {}),
    ...(args.includes("--refresh-committee-cash") ? { refreshCommitteeCash: true } : {}),
    ...(args.includes("--refresh-cache") ? { refreshCache: true } : {}),
  };
}

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Wisconsin candidate finance due sync");
  }
  return databaseUrl;
}

export function toSyncDueWisconsinCandidateFinanceScriptOutput(input: {
  startedAt: Date;
  options: SyncDueWisconsinCandidateFinanceScriptOptions;
  result: WisconsinCandidateFinanceBatchSyncResult;
}) {
  return {
    type: "wisconsin_candidate_finance_due_sync",
    ts: new Date().toISOString(),
    started_at: input.startedAt.toISOString(),
    dry_run: input.options.dryRun,
    result: input.result,
  };
}

export async function runSyncDueWisconsinCandidateFinanceScript(input: {
  startedAt: Date;
  options: SyncDueWisconsinCandidateFinanceScriptOptions;
}): Promise<ReturnType<typeof toSyncDueWisconsinCandidateFinanceScriptOutput> | null> {
  const { startedAt, options } = input;
  if (!isWisconsinCampaignFinanceSyncEnabled(options.force)) return null;
  const pool = new Pool({ connectionString: getDatabaseUrl() });
  try {
    const result = await syncDueWisconsinCandidateFinance({
      db: pool,now: startedAt,dryRun: options.dryRun,
      maxCandidates: options.maxCandidates,staleAfterDays: options.staleAfterDays,
      electionLookbackDays: options.electionLookbackDays,electionLookaheadDays: options.electionLookaheadDays,
      candidateId: options.candidateId,electionYear: options.electionYear,committeeCashOnly: options.committeeCashOnly,
      refreshCommitteeCash: options.refreshCommitteeCash,rawDataCacheDir: options.rawDataCacheDir,refreshCache: options.refreshCache,
    });
    return toSyncDueWisconsinCandidateFinanceScriptOutput({ startedAt, options, result });
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const startedAt = new Date();
  loadProjectEnv();
  const options = parseSyncDueWisconsinCandidateFinanceScriptArgs(process.argv.slice(2));
  const output = await runSyncDueWisconsinCandidateFinanceScript({ startedAt, options });
  if (!output) {
    console.log("Wisconsin campaign finance due sync disabled; no Wisconsin data loaded");
    return;
  }
  console.log(JSON.stringify(output, null, 2));
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Wisconsin candidate finance due sync failed:", message);
    process.exitCode = 1;
  });
}
