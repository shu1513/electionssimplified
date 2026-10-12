import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { isFloridaCampaignFinanceSyncEnabled } from "../config/featureFlags.js";
import {
  syncDueFloridaCandidateFinance,
  type FloridaCandidateFinanceDueSyncResult,
} from "../pipeline/floridaFinance/floridaCandidateFinanceBatchSync.js";
import { loadFloridaReviewedCommitteeDates } from "../pipeline/floridaFinance/floridaReviewedCommitteeDates.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";

export type SyncDueFloridaCandidateFinanceScriptOptions = {
  dryRun: boolean;
  force: boolean;
  refreshExportArtifacts: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  artifactCacheDir?: string;
  exportMinIntervalMs?: number;
  exportRowLimit?: number;
  candidateId?: string;
  reviewedCommitteeDatesPath?: string;
};

const KNOWN_BOOLEAN_FLAGS = new Set(["--dry-run", "--force", "--refresh-export-artifacts"]);
const KNOWN_VALUE_FLAGS = new Set([
  "--max-candidates",
  "--stale-after-days",
  "--lookback-days",
  "--lookahead-days",
  "--artifact-cache-dir",
  "--export-min-interval-ms",
  "--export-row-limit",
  "--candidate-id",
  "--reviewed-committee-dates",
]);

function assertNoUnknownFloridaCandidateFinanceArgs(args: readonly string[]): void {
  assertKnownCliFlags(args, "Florida candidate finance due sync", KNOWN_BOOLEAN_FLAGS, KNOWN_VALUE_FLAGS);
}

function parseFlagValue(args: readonly string[], name: string): string | null {
  const inlinePrefix = `${name}=`;
  const values: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith(inlinePrefix)) {
      const value = arg.slice(inlinePrefix.length).trim();
      if (value.length === 0) {
        throw new Error(`Missing ${name} value`);
      }
      values.push(value);
      continue;
    }
    if (arg === name) {
      const next = args[index + 1];
      if (!next || next.startsWith("--") || next.trim().length === 0) {
        throw new Error(`Missing ${name} value`);
      }
      values.push(next.trim());
      index += 1;
    }
  }

  if (values.length > 1) {
    throw new Error(`Provide ${name} at most once`);
  }
  return values[0] ?? null;
}

function parseIntegerFlag(input: { args: readonly string[]; name: string; allowZero?: boolean }): number | undefined {
  const raw = parseFlagValue(input.args, input.name);
  if (raw === null) {
    return undefined;
  }
  const pattern = input.allowZero === true ? /^(?:0|[1-9]\d*)$/ : /^[1-9]\d*$/;
  if (!pattern.test(raw)) {
    throw new Error(`Invalid ${input.name} value: ${raw}`);
  }
  return Number(raw);
}

export function parseSyncDueFloridaCandidateFinanceScriptArgs(
  args: readonly string[]
): SyncDueFloridaCandidateFinanceScriptOptions {
  assertNoUnknownFloridaCandidateFinanceArgs(args);
  const candidateId = parseFlagValue(args, "--candidate-id") ?? undefined;
  if (candidateId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidateId)) {
    throw new Error("Invalid --candidate-id value: expected UUID");
  }
  return {
    candidateId,
    reviewedCommitteeDatesPath: parseFlagValue(args, "--reviewed-committee-dates") ?? undefined,
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
    refreshExportArtifacts: args.includes("--refresh-export-artifacts"),
    maxCandidates: parseIntegerFlag({ args, name: "--max-candidates" }),
    staleAfterDays: parseIntegerFlag({ args, name: "--stale-after-days", allowZero: true }),
    electionLookbackDays: parseIntegerFlag({ args, name: "--lookback-days", allowZero: true }),
    electionLookaheadDays: parseIntegerFlag({ args, name: "--lookahead-days", allowZero: true }),
    artifactCacheDir: parseFlagValue(args, "--artifact-cache-dir") || undefined,
    exportMinIntervalMs: parseIntegerFlag({ args, name: "--export-min-interval-ms", allowZero: true }),
    exportRowLimit: parseIntegerFlag({ args, name: "--export-row-limit" }),
  };
}

/** Load human-reviewed artifacts before creating a database pool or invoking sync. */
export async function prepareFloridaCandidateFinanceSourceOptions(
  options: SyncDueFloridaCandidateFinanceScriptOptions
) {
  const reviewedCommitteeDates = options.reviewedCommitteeDatesPath
    ? await loadFloridaReviewedCommitteeDates(options.reviewedCommitteeDatesPath)
    : undefined;
  return {
    candidateId: options.candidateId,
    autoLinkMissingLinks: options.candidateId ? false : undefined,
    reviewedCommitteeDates,
  };
}

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Florida candidate finance due sync");
  }
  return databaseUrl;
}

export function toSyncDueFloridaCandidateFinanceScriptOutput(input: {
  startedAt: Date;
  options: SyncDueFloridaCandidateFinanceScriptOptions;
  result: FloridaCandidateFinanceDueSyncResult;
}) {
  return {
    type: "florida_candidate_finance_due_sync",
    ts: new Date().toISOString(),
    started_at: input.startedAt.toISOString(),
    dry_run: input.options.dryRun,
    force: input.options.force,
    refresh_export_artifacts: input.options.refreshExportArtifacts,
    result: input.result,
  };
}

async function main(): Promise<void> {
  const startedAt = new Date();
  loadProjectEnv();
  const options = parseSyncDueFloridaCandidateFinanceScriptArgs(process.argv.slice(2));

  if (!isFloridaCampaignFinanceSyncEnabled(options.force)) {
    console.log("Florida campaign finance due sync disabled; no Florida data loaded");
    return;
  }

  const sourceOptions = await prepareFloridaCandidateFinanceSourceOptions(options);
  const pool = new Pool({ connectionString: getDatabaseUrl() });
  try {
    const result = await syncDueFloridaCandidateFinance({
      db: pool,
      ...sourceOptions,
      now: startedAt,
      dryRun: options.dryRun,
      maxCandidates: options.maxCandidates,
      staleAfterDays: options.staleAfterDays,
      electionLookbackDays: options.electionLookbackDays,
      electionLookaheadDays: options.electionLookaheadDays,
      defaultArtifactCacheDir: options.artifactCacheDir,
      exportMinIntervalMs: options.exportMinIntervalMs,
      exportRowLimit: options.exportRowLimit,
      exportForce: options.force,
      refreshExportArtifacts: options.refreshExportArtifacts,
    });
    console.log(JSON.stringify(toSyncDueFloridaCandidateFinanceScriptOutput({ startedAt, options, result }), null, 2));
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    console.error("Florida candidate finance due sync failed:", error);
    process.exitCode = 1;
  });
}
