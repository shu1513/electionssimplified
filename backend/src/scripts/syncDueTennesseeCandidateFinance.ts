import { pathToFileURL } from "node:url";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { isTennesseeCampaignFinanceSyncEnabled } from "../config/featureFlags.js";
import {
  syncDueTennesseeCandidateFinance,
  type TennesseeCandidateFinanceBatchSyncResult,
} from "../pipeline/tennesseeFinance/tennesseeCandidateFinanceBatchSync.js";
import {
  assertNoUnknownTennesseeFinanceFlags,
  parseTennesseeFinancePositiveIntegerFlag,
  parseTennesseeFinanceFlagValue,
} from "./tennesseeCandidateFinanceCliArgs.js";

export type SyncDueTennesseeCandidateFinanceScriptOptions = {
  dryRun: boolean;
  force: boolean;
  refresh?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  candidateId?: string;
  electionYear?: number;
  rawCacheDir?: string;
  autoLinkMissingLinks?: boolean;
};

export function parseSyncDueTennesseeCandidateFinanceScriptArgs(
  args: readonly string[]
): SyncDueTennesseeCandidateFinanceScriptOptions {
  assertNoUnknownTennesseeFinanceFlags(args);
  const candidateId=parseTennesseeFinanceFlagValue(args,"--candidate-id");
  if(candidateId!==null && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(candidateId)) throw Error("Invalid --candidate-id value");
  const electionYear=parseTennesseeFinancePositiveIntegerFlag(args,"--election-year");
  if(electionYear!==undefined && (electionYear<2000 || electionYear>2100)) throw Error("Invalid --election-year value");
  const rawCacheDir=parseTennesseeFinanceFlagValue(args,"--raw-cache-dir");
  if(rawCacheDir!==null && !isAbsolute(rawCacheDir)) throw Error("--raw-cache-dir must be absolute");
  return {
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
    ...(args.includes("--refresh") ? { refresh: true } : {}),
    maxCandidates: parseTennesseeFinancePositiveIntegerFlag(args, "--max-candidates"),
    staleAfterDays: parseTennesseeFinancePositiveIntegerFlag(args, "--stale-after-days"),
    electionLookbackDays: parseTennesseeFinancePositiveIntegerFlag(args, "--lookback-days"),
    electionLookaheadDays: parseTennesseeFinancePositiveIntegerFlag(args, "--lookahead-days"),
    ...(candidateId!==null ? {candidateId:candidateId.toLowerCase()} : {}),
    ...(electionYear!==undefined ? {electionYear} : {}),
    ...(rawCacheDir!==null ? {rawCacheDir} : {}),
    ...(args.includes("--no-auto-link") ? {autoLinkMissingLinks:false} : {}),
  };
}

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Tennessee candidate finance due sync");
  }
  return databaseUrl;
}

export function toSyncDueTennesseeCandidateFinanceScriptOutput(input: {
  startedAt: Date;
  options: SyncDueTennesseeCandidateFinanceScriptOptions;
  result: TennesseeCandidateFinanceBatchSyncResult;
}) {
  return {
    type: "tennessee_candidate_finance_due_sync",
    ts: new Date().toISOString(),
    started_at: input.startedAt.toISOString(),
    dry_run: input.options.dryRun,
    result: input.result,
  };
}

async function main(): Promise<void> {
  const startedAt = new Date();
  loadProjectEnv();
  const options = parseSyncDueTennesseeCandidateFinanceScriptArgs(process.argv.slice(2));

  if (!isTennesseeCampaignFinanceSyncEnabled(options.force)) {
    console.log("Tennessee campaign finance due sync disabled; no Tennessee data loaded");
    return;
  }

  const pool = new Pool({ connectionString: getDatabaseUrl() });

  try {
    let rawRunDirectory:string|undefined;
    if(options.rawCacheDir) {
      await mkdir(options.rawCacheDir,{recursive:true});
      rawRunDirectory=await mkdtemp(join(options.rawCacheDir,"tn-sync-"));
    }
    let rawSequence=0;
    const result = await syncDueTennesseeCandidateFinance({
      db: pool,
      now: startedAt,
      dryRun: options.dryRun,
      refresh: options.refresh,
      maxCandidates: options.maxCandidates,
      staleAfterDays: options.staleAfterDays,
      electionLookbackDays: options.electionLookbackDays,
      electionLookaheadDays: options.electionLookaheadDays,
      candidateId:options.candidateId,electionYear:options.electionYear,autoLinkMissingLinks:options.autoLinkMissingLinks,
      ...(rawRunDirectory ? {onRawResponse:async (event) => {
        const {bytes,...metadata}=event.raw;
        const stem=String(++rawSequence).padStart(5,"0")+"-"+event.phase+"-"+event.scope;
        await writeFile(join(rawRunDirectory!,stem+".body"),bytes,{flag:"wx"});
        await writeFile(join(rawRunDirectory!,stem+".json"),JSON.stringify({...event,raw:metadata},null,2),{flag:"wx"});
      }} : {}),
    });

    console.log(JSON.stringify({...toSyncDueTennesseeCandidateFinanceScriptOutput({ startedAt, options, result }),
      ...(rawRunDirectory ? {raw_cache_directory:rawRunDirectory,raw_response_count:rawSequence} : {})}, null, 2));
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Tennessee candidate finance due sync failed:", message);
    process.exitCode = 1;
  });
}
