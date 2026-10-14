import { randomUUID } from "node:crypto";
import { mkdir, chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { VermontCommitteeCashResponseCapture } from "../pipeline/vermontFinance/vermontCommitteeCashAcquisition.js";
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { isVermontCampaignFinanceSyncEnabled } from "../config/featureFlags.js";
import {
  syncDueVermontCandidateFinance,
  type VermontCandidateFinanceBatchSyncResult,
} from "../pipeline/vermontFinance/vermontCandidateFinanceBatchSync.js";
import {
  readStrictFlagValue,
  readStrictPositiveIntegerFlag,
} from "../utils/cliFlags.js";
import { assertKnownCliFlags } from "./financeCliFlagGuard.js";

export type SyncDueVermontCandidateFinanceScriptOptions = {
  dryRun: boolean;
  force: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  committeeCashOnly?: boolean;
  candidateId?: string;
  refresh?: boolean;
  rawCacheDir?: string;
};

const KNOWN_BOOLEAN_FLAGS = new Set([
  "--dry-run",
  "--force",
  "--committee-cash-only",
  "--refresh",
]);
const KNOWN_VALUE_FLAGS = new Set([
  "--lookahead-days",
  "--lookback-days",
  "--max-candidates",
  "--stale-after-days",
  "--candidate-id",
  "--raw-cache-dir",
]);

export function parseSyncDueVermontCandidateFinanceScriptArgs(
  args: readonly string[],
): SyncDueVermontCandidateFinanceScriptOptions {
  assertKnownCliFlags(
    args,
    "Vermont candidate finance due sync",
    KNOWN_BOOLEAN_FLAGS,
    KNOWN_VALUE_FLAGS,
  );
  const committeeCashOnly = args.includes("--committee-cash-only");
  const candidateId = readStrictFlagValue(args, "--candidate-id");
  const rawCacheDir = readStrictFlagValue(args, "--raw-cache-dir");
  const refresh = args.includes("--refresh");
  if (
    candidateId !== null &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      candidateId,
    )
  )
    throw new Error("Invalid --candidate-id: expected UUID");
  if (rawCacheDir !== null && !rawCacheDir.trim())
    throw new Error("Invalid --raw-cache-dir");
  if (
    !committeeCashOnly &&
    (candidateId !== null || rawCacheDir !== null || refresh)
  )
    throw new Error(
      "Vermont source scope/cache/refresh flags require --committee-cash-only",
    );
  return {
    ...(committeeCashOnly ? { committeeCashOnly: true } : {}),
    ...(candidateId === null ? {} : { candidateId }),
    ...(rawCacheDir === null ? {} : { rawCacheDir }),
    ...(refresh ? { refresh: true } : {}),
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
  };
}

/** Store untouched public bodies and safe original request metadata, never headers. */
export async function createVermontCommitteeCashCaptureSink(
  rawCacheDir: string,
): Promise<(capture: VermontCommitteeCashResponseCapture) => Promise<void>> {
  await mkdir(rawCacheDir, { recursive: true, mode: 0o700 });
  await chmod(rawCacheDir, 0o700);
  const generationDir = join(rawCacheDir, `vermont-${randomUUID()}`);
  await mkdir(generationDir, { mode: 0o700 });
  let index = 0;
  return async (capture) => {
    const detached = structuredClone(capture);
    const ordinal = String(++index).padStart(6, "0");
    await writeFile(join(generationDir, `${ordinal}.raw`), detached.body, {
      mode: 0o600,
      flag: "wx",
    });
    const metadata = {
      url: detached.url,
      method: detached.method,
      requestFields: detached.requestFields,
      httpStatus: detached.httpStatus,
      startedAt: detached.startedAt,
      completedAt: detached.completedAt,
      sha256: detached.sha256,
      byteCount: detached.byteCount,
      ...(detached.error ? { error: detached.error } : {}),
      rawPath: `${ordinal}.raw`,
    };
    await writeFile(
      join(generationDir, `${ordinal}.json`),
      JSON.stringify(metadata, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
  };
}

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required for Vermont candidate finance due sync",
    );
  }
  return databaseUrl;
}

export function toSyncDueVermontCandidateFinanceScriptOutput(input: {
  startedAt: Date;
  options: SyncDueVermontCandidateFinanceScriptOptions;
  result: VermontCandidateFinanceBatchSyncResult;
}) {
  return {
    type: "vermont_candidate_finance_due_sync",
    ts: new Date().toISOString(),
    started_at: input.startedAt.toISOString(),
    dry_run: input.options.dryRun,
    committee_cash_only: input.result.committeeCashOnly,
    result: input.result,
  };
}

async function main(): Promise<void> {
  const startedAt = new Date();
  loadProjectEnv();
  const options = parseSyncDueVermontCandidateFinanceScriptArgs(
    process.argv.slice(2),
  );

  if (!isVermontCampaignFinanceSyncEnabled(options.force)) {
    console.log(
      "Vermont campaign finance due sync disabled; no Vermont data loaded",
    );
    return;
  }

  const pool = new Pool({ connectionString: getDatabaseUrl() });

  try {
    const onCapture = options.rawCacheDir
      ? await createVermontCommitteeCashCaptureSink(options.rawCacheDir)
      : undefined;
    const result = await syncDueVermontCandidateFinance({
      db: pool,
      now: startedAt,
      dryRun: options.dryRun,
      committeeCashOnly: options.committeeCashOnly,
      candidateId: options.candidateId,
      refresh: options.refresh,
      committeeCashOnCapture: onCapture,
      maxCandidates: options.maxCandidates,
      staleAfterDays: options.staleAfterDays,
      electionLookbackDays: options.electionLookbackDays,
      electionLookaheadDays: options.electionLookaheadDays,
    });

    console.log(
      JSON.stringify(
        toSyncDueVermontCandidateFinanceScriptOutput({
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
    console.error("Vermont candidate finance due sync failed:", message);
    process.exitCode = 1;
  });
}
