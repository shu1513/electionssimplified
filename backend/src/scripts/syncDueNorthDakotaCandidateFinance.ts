// Cache-only batch sync for North Dakota candidate finance. Reads the
// artifact cache the refresh CLI filled (never the live portal) and writes
// snapshots for due links. Gated on the master flag alone: the plan's v1 has
// no recurring sync and therefore no sync sub-gate to bypass, so there is no
// --force here — run it with NORTH_DAKOTA_CAMPAIGN_FINANCE_ENABLED=true.

import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { isNorthDakotaCampaignFinanceEnabled } from "../config/featureFlags.js";
import {
  syncDueNorthDakotaCandidateFinance,
  type NorthDakotaCandidateFinanceBatchSyncResult,
} from "../pipeline/northDakotaFinance/northDakotaCandidateFinanceBatchSync.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";

export type SyncDueNorthDakotaCandidateFinanceScriptOptions = {
  dryRun: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  cacheDir?: string;
};

const BOOLEAN_FLAGS = new Set(["--dry-run"]);
const VALUE_FLAGS = new Set(["--max-candidates", "--stale-after-days", "--lookback-days", "--lookahead-days", "--cache-dir"]);

function readValueFlag(args: readonly string[], name: string): string | undefined {
  const values: string[] = [];
  const prefix = `${name}=`;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith(prefix)) {
      values.push(arg.slice(prefix.length).trim());
    } else if (arg === name) {
      values.push(args[index + 1]!.trim());
      index += 1;
    }
  }
  if (values.length > 1) throw new Error(`Provide ${name} at most once`);
  return values[0];
}

function parseNonNegativeInteger(args: readonly string[], name: string): number | undefined {
  const value = readValueFlag(args, name);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`Invalid ${name} value: ${value}`);
  }
  return Number(value);
}

function parsePositiveInteger(args: readonly string[], name: string): number | undefined {
  const value = parseNonNegativeInteger(args, name);
  if (value === 0) throw new Error(`Invalid ${name} value: 0`);
  return value;
}

export function parseSyncDueNorthDakotaCandidateFinanceScriptArgs(
  args: readonly string[]
): SyncDueNorthDakotaCandidateFinanceScriptOptions {
  assertKnownCliFlags(args, "North Dakota candidate finance due sync", BOOLEAN_FLAGS, VALUE_FLAGS);
  return {
    dryRun: args.includes("--dry-run"),
    maxCandidates: parsePositiveInteger(args, "--max-candidates"),
    // 0 re-syncs every active link (an operator's deliberate full pass).
    staleAfterDays: parseNonNegativeInteger(args, "--stale-after-days"),
    electionLookbackDays: parsePositiveInteger(args, "--lookback-days"),
    electionLookaheadDays: parsePositiveInteger(args, "--lookahead-days"),
    cacheDir: readValueFlag(args, "--cache-dir"),
  };
}

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for North Dakota candidate finance due sync");
  }
  return databaseUrl;
}

async function main(): Promise<void> {
  const startedAt = new Date();
  loadProjectEnv();
  const options = parseSyncDueNorthDakotaCandidateFinanceScriptArgs(process.argv.slice(2));

  if (!isNorthDakotaCampaignFinanceEnabled()) {
    console.log("North Dakota campaign finance disabled; no North Dakota data loaded");
    return;
  }

  const pool = new Pool({ connectionString: getDatabaseUrl() });
  try {
    const result: NorthDakotaCandidateFinanceBatchSyncResult = await syncDueNorthDakotaCandidateFinance({
      db: pool,
      now: startedAt,
      dryRun: options.dryRun,
      maxCandidates: options.maxCandidates,
      staleAfterDays: options.staleAfterDays,
      electionLookbackDays: options.electionLookbackDays,
      electionLookaheadDays: options.electionLookaheadDays,
      cacheDir: options.cacheDir,
    });
    console.log(
      JSON.stringify(
        {
          type: "north_dakota_candidate_finance_due_sync",
          ts: new Date().toISOString(),
          started_at: startedAt.toISOString(),
          dry_run: options.dryRun,
          result,
        },
        null,
        2
      )
    );
    // The batch is fail-visible (per-candidate errors are recorded and the
    // run continues); the exit code still has to say so for shell callers.
    if (result.failed > 0 || result.reportedError !== undefined) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    console.error("North Dakota candidate finance due sync failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
