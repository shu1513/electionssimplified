import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { isAlaskaCampaignFinanceSyncEnabled } from "../config/featureFlags.js";
import {
  loadAlaskaApocFinanceData,
  type AlaskaApocDataSourceMode,
  type AlaskaApocDataSourceMetadata,
} from "../pipeline/alaskaFinance/alaskaApocDataSource.js";
import {
  syncDueAlaskaCandidateFinance,
  type AlaskaCandidateFinanceBatchSyncResult,
} from "../pipeline/alaskaFinance/alaskaCandidateFinanceBatchSync.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";

export type SyncDueAlaskaCandidateFinanceScriptOptions = {
  dryRun: boolean;
  force: boolean;
  autoLinkMissingLinks: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  dataSourceMode: AlaskaApocDataSourceMode;
  incomeCsvPath?: string;
  independentExpendituresCsvPath?: string;
  independentContributionsCsvPath?: string;
  incomeUrl?: string;
  independentExpendituresUrl?: string;
  independentContributionsUrl?: string;
  timeoutMs?: number;
  exportTimeoutMs?: number;
  retryCount?: number;
  retryDelayMs?: number;
  requestSpacingMs?: number;
  reportYear?: number;
};

function parseFlagValue(args: readonly string[], name: string): string | null {
  const inlinePrefix = `${name}=`;
  const values: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith(inlinePrefix)) {
      const value = arg.slice(inlinePrefix.length).trim();
      if (!value) {
        throw new Error(`Missing ${name} value`);
      }
      values.push(value);
      continue;
    }
    if (arg === name) {
      const next = args[index + 1];
      if (!next || next.startsWith("--") || !next.trim()) {
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

function parsePositiveIntegerFlag(args: readonly string[], name: string): number | undefined {
  const raw = parseFlagValue(args, name);
  if (raw === null) {
    return undefined;
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`Invalid ${name} value: ${raw}`);
  }
  return Number(raw);
}

function parseNonNegativeIntegerFlag(args: readonly string[], name: string): number | undefined {
  const raw = parseFlagValue(args, name);
  if (raw === null) {
    return undefined;
  }
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) {
    throw new Error(`Invalid ${name} value: ${raw}`);
  }
  return Number(raw);
}

function parseDataSourceMode(args: readonly string[]): AlaskaApocDataSourceMode {
  const liveFlag = args.includes("--live");
  const csvFlag = args.includes("--csv");
  if (liveFlag && csvFlag) {
    throw new Error("Provide either --live or --csv, not both");
  }
  const rawMode = parseFlagValue(args, "--data-source");
  if (rawMode !== null) {
    if (liveFlag || csvFlag) {
      throw new Error("Provide --data-source or --live/--csv, not both");
    }
    if (rawMode !== "csv" && rawMode !== "live") {
      throw new Error(`Invalid --data-source value: ${rawMode}`);
    }
    return rawMode;
  }
  return liveFlag ? "live" : "csv";
}

const KNOWN_BOOLEAN_FLAGS = new Set(["--auto-link", "--csv", "--dry-run", "--force", "--live", "--no-auto-link", "--write"]);
const KNOWN_VALUE_FLAGS = new Set(["--data-source", "--export-timeout-ms", "--ie-contributions-csv", "--ie-contributions-url", "--ie-expenditures-csv", "--ie-expenditures-url", "--income-csv", "--income-url", "--lookahead-days", "--lookback-days", "--max-candidates", "--report-year", "--request-spacing-ms", "--retry-count", "--retry-delay-ms", "--stale-after-days", "--timeout-ms"]);

export function parseSyncDueAlaskaCandidateFinanceScriptArgs(
  args: readonly string[]
): SyncDueAlaskaCandidateFinanceScriptOptions {
  assertKnownCliFlags(args, "Alaska candidate finance due sync", KNOWN_BOOLEAN_FLAGS, KNOWN_VALUE_FLAGS);
  const dryRunFlag = args.includes("--dry-run");
  const writeFlag = args.includes("--write");
  if (dryRunFlag && writeFlag) {
    throw new Error("Provide either --dry-run or --write, not both");
  }
  const autoLinkFlag = args.includes("--auto-link");
  const noAutoLinkFlag = args.includes("--no-auto-link");
  if (autoLinkFlag && noAutoLinkFlag) {
    throw new Error("Provide either --auto-link or --no-auto-link, not both");
  }
  const dataSourceMode = parseDataSourceMode(args);
  const incomeCsvPath = parseFlagValue(args, "--income-csv") || undefined;
  const independentExpendituresCsvPath = parseFlagValue(args, "--ie-expenditures-csv") || undefined;
  const independentContributionsCsvPath = parseFlagValue(args, "--ie-contributions-csv") || undefined;
  if (
    dataSourceMode === "live" &&
    (incomeCsvPath || independentExpendituresCsvPath || independentContributionsCsvPath)
  ) {
    throw new Error("Do not provide --income-csv, --ie-expenditures-csv, or --ie-contributions-csv when using live mode");
  }

  return {
    dryRun: !writeFlag,
    force: args.includes("--force"),
    autoLinkMissingLinks: autoLinkFlag,
    maxCandidates: parsePositiveIntegerFlag(args, "--max-candidates"),
    staleAfterDays: parsePositiveIntegerFlag(args, "--stale-after-days"),
    electionLookbackDays: parsePositiveIntegerFlag(args, "--lookback-days"),
    electionLookaheadDays: parsePositiveIntegerFlag(args, "--lookahead-days"),
    dataSourceMode,
    incomeCsvPath,
    independentExpendituresCsvPath,
    independentContributionsCsvPath,
    incomeUrl: parseFlagValue(args, "--income-url") || undefined,
    independentExpendituresUrl: parseFlagValue(args, "--ie-expenditures-url") || undefined,
    independentContributionsUrl: parseFlagValue(args, "--ie-contributions-url") || undefined,
    timeoutMs: parsePositiveIntegerFlag(args, "--timeout-ms"),
    exportTimeoutMs: parsePositiveIntegerFlag(args, "--export-timeout-ms"),
    retryCount: parseNonNegativeIntegerFlag(args, "--retry-count"),
    retryDelayMs: parseNonNegativeIntegerFlag(args, "--retry-delay-ms"),
    requestSpacingMs: parseNonNegativeIntegerFlag(args, "--request-spacing-ms"),
    reportYear: parsePositiveIntegerFlag(args, "--report-year"),
  };
}

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Alaska candidate finance due sync");
  }
  return databaseUrl;
}

export function toSyncDueAlaskaCandidateFinanceScriptOutput(input: {
  startedAt: Date;
  options: SyncDueAlaskaCandidateFinanceScriptOptions;
  dataSource: AlaskaApocDataSourceMetadata;
  result: AlaskaCandidateFinanceBatchSyncResult;
}) {
  return {
    type: "alaska_candidate_finance_due_sync",
    ts: new Date().toISOString(),
    started_at: input.startedAt.toISOString(),
    dry_run: input.options.dryRun,
    auto_link_missing_links: input.options.autoLinkMissingLinks,
    data_source: input.dataSource,
    result: input.result,
  };
}

export async function runAlaskaCandidateFinanceCli(
  args: readonly string[],
  db?: Pool,
): Promise<AlaskaCandidateFinanceBatchSyncResult | undefined> {
  const startedAt = new Date();
  if (!db && !process.env.DATABASE_URL) loadProjectEnv();
  const options = parseSyncDueAlaskaCandidateFinanceScriptArgs(args);

  if (!isAlaskaCampaignFinanceSyncEnabled(options.force)) {
    console.log(
      "Alaska campaign finance due sync disabled; no Alaska data loaded",
    );
    return;
  }

  let metadata: AlaskaApocDataSourceMetadata | null = null;
  const loadApocData = async () => {
    const loaded = await loadAlaskaApocFinanceData(
      {
        mode: options.dataSourceMode,
        incomeCsvPath: options.incomeCsvPath,
        independentExpendituresCsvPath: options.independentExpendituresCsvPath,
        independentContributionsCsvPath:
          options.independentContributionsCsvPath,
        incomeUrl: options.incomeUrl,
        independentExpendituresUrl: options.independentExpendituresUrl,
        independentContributionsUrl: options.independentContributionsUrl,
        timeoutMs: options.timeoutMs,
        exportTimeoutMs: options.exportTimeoutMs,
        retryCount: options.retryCount,
        retryDelayMs: options.retryDelayMs,
        requestSpacingMs: options.requestSpacingMs,
        reportYear: options.reportYear,
      },
      { logger: { warn() {} } },
    );
    metadata = loaded.metadata;
    return loaded.apocData;
  };
  const pool = db ?? new Pool({ connectionString: getDatabaseUrl() });

  try {
    const result = await syncDueAlaskaCandidateFinance({
      db: pool,
      now: startedAt,
      dryRun: options.dryRun,
      maxCandidates: options.maxCandidates,
      staleAfterDays: options.staleAfterDays,
      electionLookbackDays: options.electionLookbackDays,
      electionLookaheadDays: options.electionLookaheadDays,
      autoLinkMissingLinks: options.autoLinkMissingLinks,
      loadApocData,
    });

    if (!metadata) {
      console.log(
        JSON.stringify({
          type: "alaska_candidate_finance_due_sync",
          legacy_source_unavailable: true,
          reported: result.reported,
        }),
      );
      return result;
    }
    console.log(
      JSON.stringify(
        toSyncDueAlaskaCandidateFinanceScriptOutput({
          startedAt,
          options,
          dataSource: metadata,
          result,
        }),
        null,
        2,
      ),
    );
    return result;
  } finally {
    if (!db) await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  runAlaskaCandidateFinanceCli(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Alaska candidate finance due sync failed:", message);
    process.exitCode = 1;
  });
}
