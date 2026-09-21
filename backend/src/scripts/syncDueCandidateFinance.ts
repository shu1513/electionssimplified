import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { isCandidateFinanceEnabled } from "../config/featureFlags.js";
import {
  DEFAULT_CANDIDATE_FINANCE_BATCH_SIZE,
  syncDueCandidateFinance,
  type CandidateFinanceBatchSyncResult,
} from "../pipeline/finance/candidateFinanceBatchSync.js";
import {
  DEFAULT_OPEN_FEC_TIMEOUT_MS,
  createOpenFecRateLimiter,
  readOpenFecApiKeysFromEnv,
} from "../pipeline/presidential/openFecClient.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;
const OPEN_FEC_PERSONAL_KEY_REQUESTS_PER_HOUR = 1000;
const OPEN_FEC_DEFAULT_QUOTA_UTILIZATION_PERCENT = 90;

// Requests always start with key 1; extra keys are failover, not round-robin capacity.
// Use 90% of one personal key's documented 1,000-request hourly quota.
export const DEFAULT_OPEN_FEC_LARGE_DRAIN_REQUEST_INTERVAL_MS = Math.ceil(
  (MILLISECONDS_PER_HOUR * 100) /
    (OPEN_FEC_PERSONAL_KEY_REQUESTS_PER_HOUR * OPEN_FEC_DEFAULT_QUOTA_UTILIZATION_PERCENT)
);

export type SyncDueCandidateFinanceScriptOptions = {
  dryRun: boolean;
  includeOutside: boolean;
  includeContributors: boolean;
  contributorsOnly: boolean;
  bulkDataDirectory?: string;
  contributorCandidateIds?: string[];
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  perPage?: number;
  outsideGroupLimit?: number;
  timeoutMs?: number;
  requestIntervalMs?: number;
};

function parseFlagValue(args: readonly string[], name: string): string | null {
  const inlinePrefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(inlinePrefix));
  if (inline) {
    return inline.slice(inlinePrefix.length);
  }

  const index = args.indexOf(name);
  if (index >= 0) {
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      return next;
    }
  }

  return null;
}

function parseIntegerFlag(args: readonly string[], name: string, minimum: number): number | undefined {
  const value = parseFlagValue(args, name)?.trim();
  if (!value) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid ${name} value: ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`Invalid ${name} value: ${value}`);
  }
  return parsed;
}

const KNOWN_BOOLEAN_FLAGS = new Set(["--contributors-only", "--dry-run", "--include-contributors", "--include-outside"]);
const KNOWN_VALUE_FLAGS = new Set(["--bulk-data-dir", "--contributor-candidate-ids", "--lookahead-days", "--lookback-days", "--max-candidates", "--per-page", "--request-interval-ms", "--stale-after-days", "--timeout-ms", "--top-groups"]);

export function parseSyncDueCandidateFinanceScriptArgs(
  args: readonly string[]
): SyncDueCandidateFinanceScriptOptions {
  assertKnownCliFlags(args, "candidate finance due sync", KNOWN_BOOLEAN_FLAGS, KNOWN_VALUE_FLAGS);
  return {
    dryRun: args.includes("--dry-run"),
    includeOutside: args.includes("--include-outside"),
    includeContributors: args.includes("--include-contributors"),
    contributorsOnly: args.includes("--contributors-only"),
    bulkDataDirectory: parseFlagValue(args, "--bulk-data-dir")?.trim() || undefined,
    contributorCandidateIds: parseFlagValue(args, "--contributor-candidate-ids")
      ?.split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
    maxCandidates: parseIntegerFlag(args, "--max-candidates", 1),
    staleAfterDays: parseIntegerFlag(args, "--stale-after-days", 1),
    electionLookbackDays: parseIntegerFlag(args, "--lookback-days", 1),
    electionLookaheadDays: parseIntegerFlag(args, "--lookahead-days", 1),
    perPage: parseIntegerFlag(args, "--per-page", 1),
    outsideGroupLimit: parseIntegerFlag(args, "--top-groups", 1),
    timeoutMs: parseIntegerFlag(args, "--timeout-ms", 1),
    requestIntervalMs: parseIntegerFlag(args, "--request-interval-ms", 0),
  };
}

export function createOpenFecPacingPlan(options: SyncDueCandidateFinanceScriptOptions): {
  requestIntervalMs: number;
  rateLimiter?: ReturnType<typeof createOpenFecRateLimiter>;
} {
  const maxCandidates = options.maxCandidates ?? DEFAULT_CANDIDATE_FINANCE_BATCH_SIZE;
  const requestIntervalMs =
    options.requestIntervalMs ??
    (maxCandidates > DEFAULT_CANDIDATE_FINANCE_BATCH_SIZE
      ? DEFAULT_OPEN_FEC_LARGE_DRAIN_REQUEST_INTERVAL_MS
      : 0);

  return {
    requestIntervalMs,
    ...(requestIntervalMs > 0
      ? { rateLimiter: createOpenFecRateLimiter({ minIntervalMs: requestIntervalMs }) }
      : {}),
  };
}

function getDatabaseUrl(): string {
  return process.env.DATABASE_URL?.trim() || "postgresql://localhost:5432/voteapp";
}

export function toSyncDueCandidateFinanceScriptOutput(input: {
  startedAt: Date;
  options: SyncDueCandidateFinanceScriptOptions;
  requestIntervalMs: number;
  result: CandidateFinanceBatchSyncResult;
}) {
  return {
    type: "candidate_finance_due_sync",
    ts: new Date().toISOString(),
    started_at: input.startedAt.toISOString(),
    dry_run: input.options.dryRun,
    include_outside: input.options.includeOutside,
    include_contributors: input.options.includeContributors || input.options.contributorsOnly,
    contributors_only: input.options.contributorsOnly,
    request_interval_ms: input.requestIntervalMs,
    result: input.result,
  };
}

async function main(): Promise<void> {
  const startedAt = new Date();
  loadProjectEnv();
  const options = parseSyncDueCandidateFinanceScriptArgs(process.argv.slice(2));
  if (!isCandidateFinanceEnabled()) {
    console.log("candidate_finance due sync disabled; no FEC data fetched");
    return;
  }

  const apiKeys = readOpenFecApiKeysFromEnv();
  const timeoutMs = options.timeoutMs ?? DEFAULT_OPEN_FEC_TIMEOUT_MS;
  const pacing = createOpenFecPacingPlan(options);

  // The contributors-only run reads FEC bulk files and needs no API key.
  if (apiKeys.length === 0 && !options.contributorsOnly) {
    throw new Error("No OpenFEC API keys configured. Set FEC_API_KEY_1 or FEC_API_KEY.");
  }

  const pool = new Pool({ connectionString: getDatabaseUrl() });

  try {
    const result = await syncDueCandidateFinance({
      db: pool,
      openFecOptions: { apiKeys, timeoutMs, ...(pacing.rateLimiter ? { rateLimiter: pacing.rateLimiter } : {}) },
      now: startedAt,
      dryRun: options.dryRun,
      includeOutside: options.includeOutside,
      includeContributors: options.includeContributors,
      contributorsOnly: options.contributorsOnly,
      bulkDataDirectory: options.bulkDataDirectory,
      contributorCandidateIds: options.contributorCandidateIds,
      maxCandidates: options.maxCandidates,
      staleAfterDays: options.staleAfterDays,
      electionLookbackDays: options.electionLookbackDays,
      electionLookaheadDays: options.electionLookaheadDays,
      perPage: options.perPage,
      outsideGroupLimit: options.outsideGroupLimit,
    });

    console.log(
      JSON.stringify(
        toSyncDueCandidateFinanceScriptOutput({
          startedAt,
          options,
          requestIntervalMs: pacing.requestIntervalMs,
          result,
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
    console.error("candidate finance due sync failed:", message);
    process.exitCode = 1;
  });
}
