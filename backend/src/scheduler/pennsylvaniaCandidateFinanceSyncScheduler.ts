import { Queue, Worker, type JobsOptions, type Processor } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import { toConnectionOptions } from "../utils/redisConnection.js";
import { Pool } from "pg";

import { getPipelineEnv } from "../config/env.js";
import {
  isPennsylvaniaCampaignFinanceEnabled,
  isPennsylvaniaCampaignFinanceSyncEnabled,
} from "../config/featureFlags.js";
import {
  syncDuePennsylvaniaCandidateFinance,
  type PennsylvaniaCandidateFinanceBatchSyncResult,
} from "../pipeline/pennsylvaniaFinance/pennsylvaniaCandidateFinanceBatchSync.js";

export const PENNSYLVANIA_CANDIDATE_FINANCE_SYNC_JOB_NAME = "pennsylvania_candidate_finance_sync_due";
export const PENNSYLVANIA_CANDIDATE_FINANCE_SYNC_DAILY_SCHEDULER_ID =
  "pennsylvania_candidate_finance_sync_daily";

export type PennsylvaniaCandidateFinanceSyncJobData = {
  dryRun?: boolean;
  force?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  rawDataExtractedDir?: string;
  rawDataCacheDir?: string;
  triggeredBy?: "daily" | "manual" | "unknown";
  requestedAt?: string;
};

export type PennsylvaniaCandidateFinanceSyncJobResult = PennsylvaniaCandidateFinanceBatchSyncResult & {
  enabled: boolean;
  force: boolean;
  triggeredBy: NonNullable<PennsylvaniaCandidateFinanceSyncJobData["triggeredBy"]>;
};

export type PennsylvaniaCandidateFinanceSyncEnqueueOptions = {
  jobId?: string;
};

type PennsylvaniaCandidateFinanceSyncSchedulerRuntimeConfig = {
  queueName: string;
  dailyCron: string;
  dailyTz: string;
};

const DISABLED_RESULT_DEFAULT_MAX_CANDIDATES = 0;
const DISABLED_RESULT_DEFAULT_STALE_AFTER_DAYS = 0;

function readSchedulerRuntimeConfig(): PennsylvaniaCandidateFinanceSyncSchedulerRuntimeConfig {
  return {
    queueName:
      process.env.PENNSYLVANIA_CAMPAIGN_FINANCE_SYNC_SCHEDULER_QUEUE?.trim() ||
      "pennsylvania_candidate_finance_sync_maintenance",
    dailyCron: process.env.PENNSYLVANIA_CAMPAIGN_FINANCE_SYNC_DAILY_CRON?.trim() || "30 9 * * *",
    dailyTz: process.env.PENNSYLVANIA_CAMPAIGN_FINANCE_SYNC_DAILY_TZ?.trim() || "UTC",
  };
}

function assertPositiveInteger(value: number | undefined, label: string): void {
  // isSafeInteger, not isInteger: Number("9007199254740993") silently rounds
  // to 2^53 and still passes isInteger.
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new Error(`Invalid Pennsylvania finance sync scheduler ${label}: ${value}`);
  }
}

function getQueueConnection(): ConnectionOptions {
  const env = getPipelineEnv();
  return toConnectionOptions(env.REDIS_URL);
}

function getQueueName(): string {
  return readSchedulerRuntimeConfig().queueName;
}

function defaultJobOptions(): JobsOptions {
  return {
    removeOnComplete: 1000,
    removeOnFail: 1000,
  };
}

function normalizeOptionalJobId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.includes(":")) {
    throw new Error("Pennsylvania finance sync scheduler jobId must not contain ':'");
  }
  return trimmed;
}

function jobOptionsWithId(jobId: string | undefined): JobsOptions {
  const normalizedJobId = normalizeOptionalJobId(jobId);
  return normalizedJobId ? { ...defaultJobOptions(), jobId: normalizedJobId } : defaultJobOptions();
}

function assertValidJobOptions(data: PennsylvaniaCandidateFinanceSyncJobData): void {
  assertPositiveInteger(data.maxCandidates, "maxCandidates");
  assertPositiveInteger(data.staleAfterDays, "staleAfterDays");
  assertPositiveInteger(data.electionLookbackDays, "electionLookbackDays");
  assertPositiveInteger(data.electionLookaheadDays, "electionLookaheadDays");
}

export function createPennsylvaniaCandidateFinanceSyncSchedulerQueue(): Queue<PennsylvaniaCandidateFinanceSyncJobData> {
  return new Queue<PennsylvaniaCandidateFinanceSyncJobData>(getQueueName(), {
    connection: getQueueConnection(),
    defaultJobOptions: defaultJobOptions(),
  });
}

export function buildPennsylvaniaCandidateFinanceLinkedElectionSyncJobId(now = new Date()): string {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("Invalid Pennsylvania finance linked-election sync job date");
  }
  return `pennsylvania-candidate-finance-linked-election-sync-${now.toISOString().slice(0, 10)}`;
}

export async function upsertRecurringPennsylvaniaCandidateFinanceSyncJobs(
  jobData: PennsylvaniaCandidateFinanceSyncJobData = {}
): Promise<void> {
  assertValidJobOptions(jobData);
  if (!isPennsylvaniaCampaignFinanceEnabled()) {
    const queue = createPennsylvaniaCandidateFinanceSyncSchedulerQueue();
    try {
      await queue.removeJobScheduler(PENNSYLVANIA_CANDIDATE_FINANCE_SYNC_DAILY_SCHEDULER_ID);
    } finally {
      await queue.close();
    }
    return;
  }

  const config = readSchedulerRuntimeConfig();
  const queue = createPennsylvaniaCandidateFinanceSyncSchedulerQueue();

  try {
    await queue.upsertJobScheduler(
      PENNSYLVANIA_CANDIDATE_FINANCE_SYNC_DAILY_SCHEDULER_ID,
      {
        pattern: config.dailyCron,
        tz: config.dailyTz,
      },
      {
        name: PENNSYLVANIA_CANDIDATE_FINANCE_SYNC_JOB_NAME,
        data: {
          dryRun: Boolean(jobData.dryRun),
          force: Boolean(jobData.force),
          maxCandidates: jobData.maxCandidates,
          staleAfterDays: jobData.staleAfterDays,
          electionLookbackDays: jobData.electionLookbackDays,
          electionLookaheadDays: jobData.electionLookaheadDays,
          rawDataExtractedDir: jobData.rawDataExtractedDir,
          rawDataCacheDir: jobData.rawDataCacheDir,
          triggeredBy: "daily",
        },
        opts: defaultJobOptions(),
      }
    );
  } finally {
    await queue.close();
  }
}

export async function enqueueManualPennsylvaniaCandidateFinanceSyncJob(
  jobData: PennsylvaniaCandidateFinanceSyncJobData = {},
  options: PennsylvaniaCandidateFinanceSyncEnqueueOptions = {}
): Promise<string> {
  assertValidJobOptions(jobData);
  if (!isPennsylvaniaCampaignFinanceSyncEnabled(Boolean(jobData.force))) {
    return "disabled";
  }

  const queue = createPennsylvaniaCandidateFinanceSyncSchedulerQueue();

  try {
    const job = await queue.add(
      PENNSYLVANIA_CANDIDATE_FINANCE_SYNC_JOB_NAME,
      {
        dryRun: Boolean(jobData.dryRun),
        force: Boolean(jobData.force),
        maxCandidates: jobData.maxCandidates,
        staleAfterDays: jobData.staleAfterDays,
        electionLookbackDays: jobData.electionLookbackDays,
        electionLookaheadDays: jobData.electionLookaheadDays,
        rawDataExtractedDir: jobData.rawDataExtractedDir,
        rawDataCacheDir: jobData.rawDataCacheDir,
        triggeredBy: "manual",
        requestedAt: new Date().toISOString(),
      },
      jobOptionsWithId(options.jobId)
    );
    return job.id ?? "unknown";
  } finally {
    await queue.close();
  }
}

export async function runPennsylvaniaCandidateFinanceSyncJob(
  data: PennsylvaniaCandidateFinanceSyncJobData = {}
): Promise<PennsylvaniaCandidateFinanceSyncJobResult> {
  assertValidJobOptions(data);
  const force = Boolean(data.force);
  const dryRun = Boolean(data.dryRun);
  const triggeredBy = data.triggeredBy ?? "unknown";
  const now = new Date();
  const enabled = isPennsylvaniaCampaignFinanceSyncEnabled(force);

  if (!data.triggeredBy) {
    console.warn("Pennsylvania finance sync job missing triggeredBy; recording as unknown");
  }

  if (!enabled) {
    return {
      enabled: false,
      force,
      triggeredBy,
      dryRun,
      now: now.toISOString(),
      staleAfterDays: data.staleAfterDays ?? DISABLED_RESULT_DEFAULT_STALE_AFTER_DAYS,
      maxCandidates: data.maxCandidates ?? DISABLED_RESULT_DEFAULT_MAX_CANDIDATES,
      autoLinkAttemptedCount: 0,
      autoLinkLinkedCount: 0,
      dueCandidateCount: 0,
      selectedCandidateCount: 0,
      syncedCandidateCount: 0,
      failedCandidateCount: 0,
      outsideSpendingFetchedYears: [],
      outsideSpendingFetchErrors: {},
      results: [],
    };
  }

  const env = getPipelineEnv();
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  try {
    const result = await syncDuePennsylvaniaCandidateFinance({
      db: pool,
      now,
      dryRun,
      maxCandidates: data.maxCandidates,
      staleAfterDays: data.staleAfterDays,
      electionLookbackDays: data.electionLookbackDays,
      electionLookaheadDays: data.electionLookaheadDays,
      rawDataExtractedDir: data.rawDataExtractedDir,
      rawDataCacheDir: data.rawDataCacheDir,
    });

    return {
      enabled: true,
      force,
      triggeredBy,
      ...result,
    };
  } finally {
    await pool.end();
  }
}

export function createPennsylvaniaCandidateFinanceSyncSchedulerWorker(): Worker<
  PennsylvaniaCandidateFinanceSyncJobData,
  PennsylvaniaCandidateFinanceSyncJobResult
> {
  const connection = getQueueConnection();
  const queueName = getQueueName();

  const processor: Processor<
    PennsylvaniaCandidateFinanceSyncJobData,
    PennsylvaniaCandidateFinanceSyncJobResult
  > = async (job) => {
    return runPennsylvaniaCandidateFinanceSyncJob(job.data ?? {});
  };

  return new Worker<PennsylvaniaCandidateFinanceSyncJobData, PennsylvaniaCandidateFinanceSyncJobResult>(
    queueName,
    processor,
    {
      connection,
      concurrency: 1,
    }
  );
}
