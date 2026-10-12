// Kansas finance due sync (docs/plans/plan-kansas-finance.md, Phase 4): active links
// whose snapshot is missing or stale, each rebuilt from the live SOS CFR
// viewer and written through the standard snapshot writer. Run the auto-link
// CLI first; this never creates links.

import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { isKansasCampaignFinanceSyncEnabled } from "../config/featureFlags.js";
import {
  syncDueKansasCandidateFinance,
  type KansasCandidateFinanceBatchSyncResult,
} from "../pipeline/kansasFinance/kansasCandidateFinanceBatchSync.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";

export type SyncDueKansasCandidateFinanceScriptOptions = {
  dryRun: boolean;
  force: boolean;
  refresh?: boolean;
  candidateId?: string;
  electionYear?: number;
  ieObservationFile?: string;
  ieCacheDir?: string;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
};

const BOOLEAN_FLAGS = new Set(["--dry-run", "--force", "--refresh"]);
const VALUE_FLAGS = new Set([
  "--max-candidates",
  "--stale-after-days",
  "--lookback-days",
  "--lookahead-days",
  "--candidate-id",
  "--election-year",
  "--ie-observation-file",
  "--ie-cache-dir",
]);

function readValueFlag(
  args: readonly string[],
  name: string,
): string | undefined {
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

function parseNonNegativeInteger(
  args: readonly string[],
  name: string,
): number | undefined {
  const value = readValueFlag(args, name);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`Invalid ${name} value: ${value}`);
  }
  return Number(value);
}

function parsePositiveInteger(
  args: readonly string[],
  name: string,
): number | undefined {
  const value = parseNonNegativeInteger(args, name);
  if (value === 0) throw new Error(`Invalid ${name} value: 0`);
  return value;
}

export function parseSyncDueKansasCandidateFinanceScriptArgs(
  args: readonly string[],
): SyncDueKansasCandidateFinanceScriptOptions {
  assertKnownCliFlags(
    args,
    "Kansas candidate finance due sync",
    BOOLEAN_FLAGS,
    VALUE_FLAGS,
  );
  const candidateId = readValueFlag(args, "--candidate-id");
  if (
    candidateId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      candidateId,
    )
  ) {
    throw new Error("Invalid --candidate-id UUID");
  }
  const electionYear = parsePositiveInteger(args, "--election-year");
  if (
    electionYear !== undefined &&
    (electionYear < 2024 || electionYear > 2100)
  ) {
    throw new Error("Invalid --election-year value");
  }
  return {
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
    refresh: args.includes("--refresh"),
    candidateId,
    electionYear,
    ieObservationFile: readValueFlag(args, "--ie-observation-file"),
    ieCacheDir: readValueFlag(args, "--ie-cache-dir"),
    maxCandidates: parsePositiveInteger(args, "--max-candidates"),
    // 0 is a deliberate full resync (the North Dakota convention): every
    // linked candidate in the window is due, whatever its last sync.
    staleAfterDays: parseNonNegativeInteger(args, "--stale-after-days"),
    electionLookbackDays: parsePositiveInteger(args, "--lookback-days"),
    electionLookaheadDays: parsePositiveInteger(args, "--lookahead-days"),
  };
}

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required for Kansas candidate finance due sync",
    );
  }
  return databaseUrl;
}

async function main(): Promise<void> {
  const startedAt = new Date();
  loadProjectEnv();
  const options = parseSyncDueKansasCandidateFinanceScriptArgs(
    process.argv.slice(2),
  );

  if (!isKansasCampaignFinanceSyncEnabled(options.force)) {
    console.log("Kansas campaign finance sync disabled; no Kansas data loaded");
    return;
  }

  const pool = new Pool({ connectionString: getDatabaseUrl() });
  try {
    const result: KansasCandidateFinanceBatchSyncResult =
      await syncDueKansasCandidateFinance({
        db: pool,
        now: startedAt,
        dryRun: options.dryRun,
        maxCandidates: options.maxCandidates,
        staleAfterDays: options.staleAfterDays,
        electionLookbackDays: options.electionLookbackDays,
        electionLookaheadDays: options.electionLookaheadDays,
        refresh: options.refresh,
        candidateId: options.candidateId,
        electionYear: options.electionYear,
        ieObservationFile: options.ieObservationFile,
        ieCacheDir: options.ieCacheDir,
        log: (message) => console.warn(message),
      });
    console.log(
      JSON.stringify(
        {
          type: "kansas_candidate_finance_due_sync",
          ts: new Date().toISOString(),
          started_at: startedAt.toISOString(),
          dry_run: options.dryRun,
          result,
        },
        null,
        2,
      ),
    );
    // The batch is fail-visible (per-candidate errors are recorded and the
    // run continues); the exit code still has to say so for shell callers
    // (Idaho / North Dakota convention). A paper filer fails every run until
    // the OCR step, so a non-zero exit means "incomplete", not "broken".
    if (result.failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    console.error(
      "Kansas candidate finance due sync failed:",
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  });
}
