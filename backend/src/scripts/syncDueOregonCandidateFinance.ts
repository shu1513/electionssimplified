import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { isOregonCampaignFinanceSyncEnabled } from "../config/featureFlags.js";
import {
  syncDueOregonCandidateFinance,
  type OregonCandidateFinanceBatchSyncResult,
} from "../pipeline/oregonFinance/oregonCandidateFinanceBatchSync.js";
import { readStrictFlagValue, readStrictPositiveIntegerFlag } from "../utils/cliFlags.js";
import { isUuid } from "../utils/uuid.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";

export type SyncDueOregonCandidateFinanceScriptOptions = {
  dryRun: boolean;
  force: boolean;
  refresh?: boolean;
  candidateId?: string;
  electionYear?: number;
  autoLinkMissingLinks?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  directMaxBreakdownsPerCategory?: number;
  outsideMaxGroups?: number;
  outsideMaxBreakdownsPerCategory?: number;
  minIndustryAmount?: number;
};

const KNOWN_BOOLEAN_FLAGS = new Set(["--dry-run", "--force", "--refresh", "--no-auto-link"]);
const KNOWN_VALUE_FLAGS = new Set(["--candidate-id", "--election-year", "--direct-max-breakdowns", "--lookahead-days", "--lookback-days", "--max-candidates", "--min-industry-amount", "--outside-max-breakdowns", "--outside-max-groups", "--stale-after-days"]);

export function parseSyncDueOregonCandidateFinanceScriptArgs(
  args: readonly string[]
): SyncDueOregonCandidateFinanceScriptOptions {
  assertKnownCliFlags(args, "Oregon candidate finance due sync", KNOWN_BOOLEAN_FLAGS, KNOWN_VALUE_FLAGS);
  const candidateId = readStrictFlagValue(args, "--candidate-id");
  const electionYear = readStrictPositiveIntegerFlag(args, "--election-year");
  if (candidateId !== null && !isUuid(candidateId)) throw new Error("--candidate-id must be a UUID");
  if (electionYear !== undefined && (electionYear < 2000 || electionYear > 2100)) {
    throw new Error("--election-year must be between 2000 and 2100");
  }
  return {
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
    ...(args.includes("--refresh") ? { refresh: true } : {}),
    ...(candidateId !== null ? { candidateId: candidateId.toLowerCase() } : {}),
    ...(electionYear !== undefined ? { electionYear } : {}),
    ...(args.includes("--no-auto-link") ? { autoLinkMissingLinks: false } : {}),
    maxCandidates: readStrictPositiveIntegerFlag(args, "--max-candidates"),
    staleAfterDays: readStrictPositiveIntegerFlag(args, "--stale-after-days"),
    electionLookbackDays: readStrictPositiveIntegerFlag(args, "--lookback-days"),
    electionLookaheadDays: readStrictPositiveIntegerFlag(args, "--lookahead-days"),
    directMaxBreakdownsPerCategory: readStrictPositiveIntegerFlag(args, "--direct-max-breakdowns"),
    outsideMaxGroups: readStrictPositiveIntegerFlag(args, "--outside-max-groups"),
    outsideMaxBreakdownsPerCategory: readStrictPositiveIntegerFlag(args, "--outside-max-breakdowns"),
    minIndustryAmount: readStrictPositiveIntegerFlag(args, "--min-industry-amount"),
  };
}

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Oregon candidate finance due sync");
  }
  return databaseUrl;
}

export function toSyncDueOregonCandidateFinanceScriptOutput(input: {
  startedAt: Date;
  options: SyncDueOregonCandidateFinanceScriptOptions;
  result: OregonCandidateFinanceBatchSyncResult;
}) {
  return {
    type: "oregon_candidate_finance_due_sync",
    ts: new Date().toISOString(),
    started_at: input.startedAt.toISOString(),
    dry_run: input.options.dryRun,
    result: input.result,
  };
}

async function main(): Promise<void> {
  const startedAt = new Date();
  loadProjectEnv();
  const options = parseSyncDueOregonCandidateFinanceScriptArgs(process.argv.slice(2));

  if (!isOregonCampaignFinanceSyncEnabled(options.force)) {
    console.log("Oregon campaign finance due sync disabled; no Oregon data loaded");
    return;
  }

  const pool = new Pool({ connectionString: getDatabaseUrl() });

  try {
    const result = await syncDueOregonCandidateFinance({
      db: pool,
      now: startedAt,
      dryRun: options.dryRun,
      refresh: options.refresh,
      candidateId: options.candidateId,
      electionYear: options.electionYear,
      autoLinkMissingLinks: options.autoLinkMissingLinks,
      maxCandidates: options.maxCandidates,
      staleAfterDays: options.staleAfterDays,
      electionLookbackDays: options.electionLookbackDays,
      electionLookaheadDays: options.electionLookaheadDays,
      directMaxBreakdownsPerCategory: options.directMaxBreakdownsPerCategory,
      outsideMaxGroups: options.outsideMaxGroups,
      outsideMaxBreakdownsPerCategory: options.outsideMaxBreakdownsPerCategory,
      minIndustryAmount: options.minIndustryAmount,
    });

    console.log(JSON.stringify(toSyncDueOregonCandidateFinanceScriptOutput({ startedAt, options, result }), null, 2));
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Oregon candidate finance due sync failed:", message);
    process.exitCode = 1;
  });
}
