import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { isDelawareCampaignFinanceSyncEnabled } from "../config/featureFlags.js";
import { syncDueDelawareCandidateFinance } from "../pipeline/delawareFinance/delawareCandidateFinanceBatchSync.js";
import { validateDelawareFinanceSyncScope } from "../pipeline/delawareFinance/delawareCandidateFinanceDueList.js";
import { requireLocalDatabaseTarget } from "./localDatabaseGuard.js";
import { assertKnownCliFlags } from "./manualCliFlags.js";

const SCRIPT_LABEL = "delaware-candidates:finance:sync-due";

function usage(): string {
  return [
    "Usage:",
    "  npm run delaware-candidates:finance:sync-due -- [--max N] [--stale-days N] [--cache-dir DIR] [--no-auto-link] [--write] [--force] [--candidate-id UUID] [--election-year YYYY] [--refresh] [--lookback-days N]",
    "",
    "Syncs due Delaware candidates from paired public CFRS source evidence.",
    "Dry-run is the default and computes legacy unindexed cached data only.",
    "--write persists accepted components in a local database and requires",
    "DELAWARE_CAMPAIGN_FINANCE_ENABLED + DELAWARE_CAMPAIGN_FINANCE_SYNC_ENABLED",
    "(--force stands in for the sync flag, per-run). Auto-link and current",
    "source acquisition additionally need the raw-data-refresh flag or",
    "--force; source-disabled writes preserve stored money. Saved openings",
    "retain original times and require fresh closings. --refresh bypasses",
    "staleness and saved opening reuse, not source/write flags.",
    "Candidate/year scope is applied before LIMIT and disables auto-link.",
    "Use --lookback-days 100 for the January year-end filing rerun.",
  ].join("\n");
}

export function parseDelawareSyncDueArgs(argv: readonly string[]): {
  maxCandidates: number;
  staleAfterDays: number | undefined;
  cacheDir: string | undefined;
  autoLinkMissingLinks: boolean;
  write: boolean;
  force: boolean;
  candidateId: string | undefined;
  electionYear: number | undefined;
  refresh: boolean;
  electionLookbackDays: number | undefined;
} {
  assertKnownCliFlags(SCRIPT_LABEL, argv, [
    { name: "--max", value: "space" },
    { name: "--stale-days", value: "space" },
    { name: "--cache-dir", value: "space" },
    { name: "--no-auto-link", value: "none" },
    { name: "--write", value: "none" },
    { name: "--force", value: "none" },
    { name: "--candidate-id", value: "space" },
    { name: "--election-year", value: "space" },
    { name: "--refresh", value: "none" },
    { name: "--lookback-days", value: "space" },
  ]);
  let maxCandidates = 10;
  let staleAfterDays: number | undefined;
  let cacheDir: string | undefined;
  let autoLinkMissingLinks = true;
  let write = false;
  let force = false;
  let candidateId: string | undefined;
  let electionYear: number | undefined;
  let refresh = false;
  let electionLookbackDays: number | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") continue;
    if (seen.has(token!)) throw new Error(`Provide ${token} at most once`);
    seen.add(token!);
    if (token === "--refresh") {
      refresh = true;
      continue;
    }
    if (token === "--candidate-id") {
      candidateId = argv[++index];
      if (candidateId === undefined) throw new Error("Missing value for --candidate-id");
      validateDelawareFinanceSyncScope({ candidateId });
      continue;
    }
    if (token === "--write") {
      write = true;
      continue;
    }
    if (token === "--force") {
      force = true;
      continue;
    }
    if (token === "--no-auto-link") {
      autoLinkMissingLinks = false;
      continue;
    }
    if (
      token === "--max" ||
      token === "--stale-days" ||
      token === "--lookback-days" ||
      token === "--election-year"
    ) {
      const raw = argv[index + 1] ?? "";
      const value = Number(raw);
      if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
        throw new Error(`Invalid value for ${token}.\n${usage()}`);
      }
      if (token === "--max") maxCandidates = value;
      else if (token === "--stale-days") staleAfterDays = value;
      else if (token === "--lookback-days") electionLookbackDays = value;
      else {
        electionYear = value;
        validateDelawareFinanceSyncScope({ electionYear });
      }
      index += 1;
      continue;
    }
    if (token === "--cache-dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for --cache-dir.\n${usage()}`);
      }
      cacheDir = value;
      index += 1;
      continue;
    }
    throw new Error(`Unexpected argument: ${token}`);
  }
  return {
    maxCandidates,
    staleAfterDays,
    cacheDir,
    autoLinkMissingLinks,
    write,
    force,
    candidateId,
    electionYear,
    refresh,
    electionLookbackDays,
  };
}

export async function runSyncDueDelawareCandidateFinance(argv: readonly string[]): Promise<void> {
  const args = parseDelawareSyncDueArgs(argv);
  loadProjectEnv();
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Delaware candidate-finance sync");
  }
  if (args.write) {
    requireLocalDatabaseTarget(databaseUrl);
    if (!isDelawareCampaignFinanceSyncEnabled(args.force)) {
      throw new Error(
        "Delaware finance sync writes are disabled: set DELAWARE_CAMPAIGN_FINANCE_ENABLED=true plus " +
          "DELAWARE_CAMPAIGN_FINANCE_SYNC_ENABLED=true (or pass --force for this run)"
      );
    }
  }
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await syncDueDelawareCandidateFinance({
      db: pool,
      maxCandidates: args.maxCandidates,
      staleAfterDays: args.staleAfterDays,
      candidateId: args.candidateId,
      electionYear: args.electionYear,
      refresh: args.refresh,
      electionLookbackDays: args.electionLookbackDays,
      cacheDir: args.cacheDir,
      autoLinkMissingLinks: args.autoLinkMissingLinks,
      forceRawDataRefresh: args.force,
      dryRun: !args.write,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  runSyncDueDelawareCandidateFinance(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
