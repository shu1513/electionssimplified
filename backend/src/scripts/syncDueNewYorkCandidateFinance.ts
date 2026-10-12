import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { isNewYorkCampaignFinanceSyncEnabled } from "../config/featureFlags.js";
import {
  syncDueNewYorkCandidateFinance,
  type NewYorkCandidateFinanceBatchSyncResult,
} from "../pipeline/newYorkFinance/newYorkCandidateFinanceBatchSync.js";
import {
  readStrictFlagValue,
  readStrictPositiveIntegerFlag,
} from "../utils/cliFlags.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";

export type SyncDueNewYorkCandidateFinanceScriptOptions = {
  dryRun: boolean;
  force: boolean;
  candidateId?: string;
  electionYear?: number;
  refresh: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
};

const KNOWN_BOOLEAN_FLAGS = new Set(["--dry-run", "--force", "--refresh"]);
const KNOWN_VALUE_FLAGS = new Set([
  "--lookahead-days",
  "--lookback-days",
  "--max-candidates",
  "--stale-after-days",
  "--candidate-id",
  "--year",
]);

export function parseSyncDueNewYorkCandidateFinanceScriptArgs(
  args: readonly string[],
): SyncDueNewYorkCandidateFinanceScriptOptions {
  assertKnownCliFlags(
    args,
    "New York candidate finance due sync",
    KNOWN_BOOLEAN_FLAGS,
    KNOWN_VALUE_FLAGS,
  );
  const candidateId = readStrictFlagValue(args, "--candidate-id") ?? undefined;
  if (
    candidateId !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      candidateId,
    )
  ) {
    throw new Error("--candidate-id must be a UUID");
  }
  const electionYear = readStrictPositiveIntegerFlag(args, "--year");
  if (
    electionYear !== undefined &&
    (electionYear < 2000 || electionYear > 2100)
  ) {
    throw new Error("--year must be between 2000 and 2100");
  }
  return {
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
    refresh: args.includes("--refresh"),
    candidateId,
    electionYear,
    maxCandidates: readStrictPositiveIntegerFlag(args, "--max-candidates"),
    staleAfterDays: readStrictPositiveIntegerFlag(args, "--stale-after-days"),
    electionLookbackDays: readStrictPositiveIntegerFlag(
      args,
      "--lookback-days",
    ),
    electionLookaheadDays: readStrictPositiveIntegerFlag(
      args,
      "--lookahead-days",
    ),
  };
}

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required for New York candidate finance due sync",
    );
  }
  return databaseUrl;
}

export function toSyncDueNewYorkCandidateFinanceScriptOutput(input: {
  startedAt: Date;
  options: SyncDueNewYorkCandidateFinanceScriptOptions;
  result: NewYorkCandidateFinanceBatchSyncResult;
}) {
  return {
    type: "new_york_candidate_finance_due_sync",
    ts: new Date().toISOString(),
    started_at: input.startedAt.toISOString(),
    dry_run: input.options.dryRun,
    result: input.result,
  };
}

async function main(): Promise<void> {
  const startedAt = new Date();
  loadProjectEnv();
  const options = parseSyncDueNewYorkCandidateFinanceScriptArgs(
    process.argv.slice(2),
  );

  if (!isNewYorkCampaignFinanceSyncEnabled(options.force)) {
    console.log(
      "New York campaign finance due sync disabled; no NewYork data loaded",
    );
    return;
  }

  const pool = new Pool({ connectionString: getDatabaseUrl() });

  try {
    const result = await syncDueNewYorkCandidateFinance({
      db: pool,
      now: startedAt,
      dryRun: options.dryRun,
      candidateId: options.candidateId,
      electionYear: options.electionYear,
      refresh: options.refresh,
      maxCandidates: options.maxCandidates,
      staleAfterDays: options.staleAfterDays,
      electionLookbackDays: options.electionLookbackDays,
      electionLookaheadDays: options.electionLookaheadDays,
    });

    console.log(
      JSON.stringify(
        toSyncDueNewYorkCandidateFinanceScriptOutput({
          startedAt,
          options,
          result,
        }),
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("New York candidate finance due sync failed:", message);
    process.exitCode = 1;
  });
}
