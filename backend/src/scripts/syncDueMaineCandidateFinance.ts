import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { isMaineCampaignFinanceSyncEnabled } from "../config/featureFlags.js";
import {
  syncDueMaineCandidateFinance,
  type MaineCandidateFinanceBatchSyncResult,
} from "../pipeline/maineFinance/maineCandidateFinanceBatchSync.js";
import {
  readStrictFlagValue,
  readStrictPositiveIntegerFlag,
} from "../utils/cliFlags.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";
import { validateMaineMapLightReportUrl } from "../pipeline/maineFinance/maineMapLightReportClient.js";

export type SyncDueMaineCandidateFinanceScriptOptions = {
  dryRun: boolean;
  force: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  rawCacheDir?: string;
  sourceMode?: "maplight" | "legacy";
  candidateId?: string;
  electionYear?: number;
  refresh?: boolean;
  resync?: boolean;
  mapLightReportUrls?: readonly string[];
};

const KNOWN_BOOLEAN_FLAGS = new Set([
  "--dry-run",
  "--force",
  "--refresh",
  "--resync",
  "--legacy",
]);
const KNOWN_VALUE_FLAGS = new Set([
  "--max-candidates",
  "--stale-after-days",
  "--lookback-days",
  "--lookahead-days",
  "--raw-cache-dir",
  "--candidate-id",
  "--year",
  "--report-urls",
]);

function validateKnownFlags(args: readonly string[]): void {
  assertKnownCliFlags(
    args,
    "Maine candidate finance due sync",
    KNOWN_BOOLEAN_FLAGS,
    KNOWN_VALUE_FLAGS,
  );
}

export function parseSyncDueMaineCandidateFinanceScriptArgs(
  args: readonly string[],
): SyncDueMaineCandidateFinanceScriptOptions {
  validateKnownFlags(args);
  const candidateId = readStrictFlagValue(args, "--candidate-id");
  if (
    candidateId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      candidateId,
    )
  )
    throw new Error("Invalid --candidate-id: expected UUID");
  const electionYear = readStrictPositiveIntegerFlag(args, "--year");
  if (
    electionYear !== undefined &&
    (electionYear < 2000 || electionYear > 2100)
  )
    throw new Error("Invalid --year: expected election year");
  const reportUrls = readStrictFlagValue(args, "--report-urls");
  const mapLightReportUrls = reportUrls
    ?.split(",")
    .map(validateMaineMapLightReportUrl);
  if (args.includes("--legacy") && mapLightReportUrls)
    throw new Error("--report-urls requires the current Maine publisher");
  return {
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
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
    rawCacheDir: readStrictFlagValue(args, "--raw-cache-dir") || undefined,
    ...(args.includes("--legacy") ? { sourceMode: "legacy" as const } : {}),
    ...(args.includes("--refresh") ? { refresh: true } : {}),
    ...(args.includes("--resync") ? { resync: true } : {}),
    ...(candidateId ? { candidateId } : {}),
    ...(electionYear !== undefined ? { electionYear } : {}),
    ...(mapLightReportUrls ? { mapLightReportUrls } : {}),
  };
}

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required for Maine candidate finance due sync",
    );
  }
  return databaseUrl;
}

export function toSyncDueMaineCandidateFinanceScriptOutput(input: {
  startedAt: Date;
  options: SyncDueMaineCandidateFinanceScriptOptions;
  result: MaineCandidateFinanceBatchSyncResult;
}) {
  return {
    type: "maine_candidate_finance_due_sync",
    ts: new Date().toISOString(),
    started_at: input.startedAt.toISOString(),
    dry_run: input.options.dryRun,
    result: input.result,
  };
}

async function main(): Promise<void> {
  const startedAt = new Date();
  loadProjectEnv();
  const options = parseSyncDueMaineCandidateFinanceScriptArgs(
    process.argv.slice(2),
  );

  if (!isMaineCampaignFinanceSyncEnabled(options.force)) {
    console.log(
      "Maine campaign finance due sync disabled; no Maine data loaded",
    );
    return;
  }

  const pool = new Pool({ connectionString: getDatabaseUrl() });

  try {
    const result = await syncDueMaineCandidateFinance({
      db: pool,
      now: startedAt,
      dryRun: options.dryRun,
      maxCandidates: options.maxCandidates,
      staleAfterDays: options.staleAfterDays,
      electionLookbackDays: options.electionLookbackDays,
      electionLookaheadDays: options.electionLookaheadDays,
      rawDataCacheDir: options.rawCacheDir,
      sourceMode: options.sourceMode,
      candidateId: options.candidateId,
      electionYear: options.electionYear,
      refresh: options.refresh,
      resync: options.resync,
      mapLightReportUrls: options.mapLightReportUrls,
    });

    console.log(
      JSON.stringify(
        toSyncDueMaineCandidateFinanceScriptOutput({
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
    console.error("Maine candidate finance due sync failed:", message);
    process.exitCode = 1;
  });
}
