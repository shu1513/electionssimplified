import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { isVirginiaCampaignFinanceSyncEnabled } from "../config/featureFlags.js";
import {
  syncDueVirginiaCandidateFinance,
  type VirginiaCandidateFinanceBatchSyncResult,
} from "../pipeline/virginiaFinance/virginiaCandidateFinanceBatchSync.js";
import { readStrictPositiveIntegerFlag } from "../utils/cliFlags.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";

export type SyncDueVirginiaCandidateFinanceScriptOptions = {
  dryRun: boolean;
  force: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
};

const KNOWN_BOOLEAN_FLAGS = new Set(["--dry-run", "--force"]);
const KNOWN_VALUE_FLAGS = new Set(["--lookahead-days", "--lookback-days", "--max-candidates", "--stale-after-days"]);

export function parseSyncDueVirginiaCandidateFinanceScriptArgs(
  args: readonly string[]
): SyncDueVirginiaCandidateFinanceScriptOptions {
  assertKnownCliFlags(args, "Virginia candidate finance due sync", KNOWN_BOOLEAN_FLAGS, KNOWN_VALUE_FLAGS);
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
    throw new Error("DATABASE_URL is required for Virginia candidate finance due sync");
  }
  return databaseUrl;
}

export function toSyncDueVirginiaCandidateFinanceScriptOutput(input: {
  startedAt: Date;
  options: SyncDueVirginiaCandidateFinanceScriptOptions;
  result: VirginiaCandidateFinanceBatchSyncResult;
}) {
  return {
    type: "virginia_candidate_finance_due_sync",
    ts: new Date().toISOString(),
    started_at: input.startedAt.toISOString(),
    dry_run: input.options.dryRun,
    result: input.result,
  };
}

async function main(): Promise<void> {
  const startedAt = new Date();
  if (!process.env.DATABASE_URL?.trim()) loadProjectEnv();
  const options = parseSyncDueVirginiaCandidateFinanceScriptArgs(process.argv.slice(2));

  if (!isVirginiaCampaignFinanceSyncEnabled(options.force)) {
    console.log("Virginia campaign finance due sync disabled; no Virginia data loaded");
    return;
  }

  const pool = new Pool({ connectionString: getDatabaseUrl() });

  try {
    const result = await runVirginiaCandidateFinanceDueSync(pool, process.argv.slice(2), startedAt);

    console.log(JSON.stringify(toSyncDueVirginiaCandidateFinanceScriptOutput({ startedAt, options, result }), null, 2));
  } finally {
    await pool.end();
  }
}

/** Same ordinary CLI selection and write default; explicit DB callers need no
 * project environment file and no candidate, cycle or financial overrides. */
export async function runVirginiaCandidateFinanceDueSync(
  db: Pool,
  args: readonly string[] = [],
  now = new Date(),
): Promise<VirginiaCandidateFinanceBatchSyncResult> {
  const options = parseSyncDueVirginiaCandidateFinanceScriptArgs(args);
  if (!isVirginiaCampaignFinanceSyncEnabled(options.force)) throw new Error("Virginia finance sync disabled");
  return syncDueVirginiaCandidateFinance({ db, now, dryRun: options.dryRun,
    maxCandidates: options.maxCandidates, staleAfterDays: options.staleAfterDays,
    electionLookbackDays: options.electionLookbackDays, electionLookaheadDays: options.electionLookaheadDays });
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Virginia candidate finance due sync failed:", message);
    process.exitCode = 1;
  });
}
