import { Queue, Worker, type JobsOptions, type Processor } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import { toConnectionOptions } from "../utils/redisConnection.js";
import { Pool } from "pg";

import { getPipelineEnv } from "../config/env.js";
import {
  isUtahCampaignFinanceEnabled,
  isUtahCampaignFinanceSyncEnabled,
} from "../config/featureFlags.js";
import {
  syncDueUtahCandidateFinance,
  type UtahCandidateFinanceBatchSyncResult,
} from "../pipeline/utahFinance/utahCandidateFinanceBatchSync.js";

export const UTAH_CANDIDATE_FINANCE_SYNC_JOB_NAME = "utah_candidate_finance_sync_due";
export const UTAH_CANDIDATE_FINANCE_SYNC_DAILY_SCHEDULER_ID = "utah_candidate_finance_sync_daily";

export type UtahCandidateFinanceSyncJobData = {
  dryRun?: boolean;
  force?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  rawDataCacheDir?: string;
  refreshCache?: boolean;
  triggeredBy?: "daily" | "manual" | "unknown";
  requestedAt?: string;
};

export type UtahCandidateFinanceSyncJobResult = UtahCandidateFinanceBatchSyncResult & {
  enabled: boolean;
  force: boolean;
  triggeredBy: NonNullable<UtahCandidateFinanceSyncJobData["triggeredBy"]>;
};

export type UtahCandidateFinanceSyncEnqueueOptions = {
  jobId?: string;
};

type UtahCandidateFinanceSyncSchedulerRuntimeConfig = {
  queueName: string;
  dailyCron: string;
  dailyTz: string;
};

const DISABLED_RESULT_DEFAULT_MAX_CANDIDATES = 0;
const DISABLED_RESULT_DEFAULT_STALE_AFTER_DAYS = 0;

function readSchedulerRuntimeConfig(): UtahCandidateFinanceSyncSchedulerRuntimeConfig {
  return {
    queueName:
      process.env.UTAH_CAMPAIGN_FINANCE_SYNC_SCHEDULER_QUEUE?.trim() ||
      "utah_candidate_finance_sync_maintenance",
    dailyCron: process.env.UTAH_CAMPAIGN_FINANCE_SYNC_DAILY_CRON?.trim() || "45 9 * * *",
    dailyTz: process.env.UTAH_CAMPAIGN_FINANCE_SYNC_DAILY_TZ?.trim() || "UTC",
  };
}

function assertPositiveInteger(value: number | undefined, label: string): void {
  // isSafeInteger, not isInteger: Number("9007199254740993") silently rounds
  // to 2^53 and still passes isInteger.
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new Error(`Invalid Utah finance sync scheduler ${label}: ${value}`);
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
    throw new Error("Utah finance sync scheduler jobId must not contain ':'");
  }
  return trimmed;
}

function jobOptionsWithId(jobId: string | undefined): JobsOptions {
  const normalizedJobId = normalizeOptionalJobId(jobId);
  return normalizedJobId ? { ...defaultJobOptions(), jobId: normalizedJobId } : defaultJobOptions();
}

function assertValidJobOptions(data: UtahCandidateFinanceSyncJobData): void {
  assertPositiveInteger(data.maxCandidates, "maxCandidates");
  assertPositiveInteger(data.staleAfterDays, "staleAfterDays");
  assertPositiveInteger(data.electionLookbackDays, "electionLookbackDays");
  assertPositiveInteger(data.electionLookaheadDays, "electionLookaheadDays");
}

export function createUtahCandidateFinanceSyncSchedulerQueue(): Queue<UtahCandidateFinanceSyncJobData> {
  return new Queue<UtahCandidateFinanceSyncJobData>(getQueueName(), {
    connection: getQueueConnection(),
    defaultJobOptions: defaultJobOptions(),
  });
}

export function buildUtahCandidateFinanceLinkedElectionSyncJobId(now = new Date()): string {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("Invalid Utah finance linked-election sync job date");
  }
  return `utah-candidate-finance-linked-election-sync-${now.toISOString().slice(0, 10)}`;
}

export async function upsertRecurringUtahCandidateFinanceSyncJobs(
  jobData: UtahCandidateFinanceSyncJobData = {}
): Promise<void> {
  assertValidJobOptions(jobData);
  if (!isUtahCampaignFinanceEnabled()) {
    const queue = createUtahCandidateFinanceSyncSchedulerQueue();
    try {
      await queue.removeJobScheduler(UTAH_CANDIDATE_FINANCE_SYNC_DAILY_SCHEDULER_ID);
    } finally {
      await queue.close();
    }
    return;
  }

  const config = readSchedulerRuntimeConfig();
  const queue = createUtahCandidateFinanceSyncSchedulerQueue();

  try {
    await queue.upsertJobScheduler(
      UTAH_CANDIDATE_FINANCE_SYNC_DAILY_SCHEDULER_ID,
      {
        pattern: config.dailyCron,
        tz: config.dailyTz,
      },
      {
        name: UTAH_CANDIDATE_FINANCE_SYNC_JOB_NAME,
        data: {
          dryRun: Boolean(jobData.dryRun),
          force: Boolean(jobData.force),
          maxCandidates: jobData.maxCandidates,
          staleAfterDays: jobData.staleAfterDays,
          electionLookbackDays: jobData.electionLookbackDays,
          electionLookaheadDays: jobData.electionLookaheadDays,
          rawDataCacheDir: jobData.rawDataCacheDir,
          refreshCache: Boolean(jobData.refreshCache),
          triggeredBy: "daily",
        },
        opts: defaultJobOptions(),
      }
    );
  } finally {
    await queue.close();
  }
}

export async function enqueueManualUtahCandidateFinanceSyncJob(
  jobData: UtahCandidateFinanceSyncJobData = {},
  options: UtahCandidateFinanceSyncEnqueueOptions = {}
): Promise<string> {
  assertValidJobOptions(jobData);
  if (!isUtahCampaignFinanceSyncEnabled(Boolean(jobData.force))) {
    return "disabled";
  }

  const queue = createUtahCandidateFinanceSyncSchedulerQueue();

  try {
    const job = await queue.add(
      UTAH_CANDIDATE_FINANCE_SYNC_JOB_NAME,
      {
        dryRun: Boolean(jobData.dryRun),
        force: Boolean(jobData.force),
        maxCandidates: jobData.maxCandidates,
        staleAfterDays: jobData.staleAfterDays,
        electionLookbackDays: jobData.electionLookbackDays,
        electionLookaheadDays: jobData.electionLookaheadDays,
        rawDataCacheDir: jobData.rawDataCacheDir,
        refreshCache: Boolean(jobData.refreshCache),
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

export async function runUtahCandidateFinanceSyncJob(
  data: UtahCandidateFinanceSyncJobData = {}
): Promise<UtahCandidateFinanceSyncJobResult> {
  assertValidJobOptions(data);
  const force = Boolean(data.force);
  const dryRun = Boolean(data.dryRun);
  const triggeredBy = data.triggeredBy ?? "unknown";
  const now = new Date();
  const enabled = isUtahCampaignFinanceSyncEnabled(force);

  if (!data.triggeredBy) {
    console.warn("Utah finance sync job missing triggeredBy; recording as unknown");
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
      dueCandidateCount: 0,
      selectedCandidateCount: 0,
      syncedCandidateCount: 0,
      failedCandidateCount: 0,
      autoLinkAttemptedCount: 0,
      autoLinkLinkedCount: 0,
      results: [],
    };
  }

  const env = getPipelineEnv();
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  try {
    const result = await syncDueUtahCandidateFinance({
      db: pool,
      now,
      dryRun,
      maxCandidates: data.maxCandidates,
      staleAfterDays: data.staleAfterDays,
      electionLookbackDays: data.electionLookbackDays,
      electionLookaheadDays: data.electionLookaheadDays,
      rawDataCacheDir: data.rawDataCacheDir,
      refreshCache: Boolean(data.refreshCache),
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

export function createUtahCandidateFinanceSyncSchedulerWorker(): Worker<
  UtahCandidateFinanceSyncJobData,
  UtahCandidateFinanceSyncJobResult
> {
  const connection = getQueueConnection();
  const queueName = getQueueName();

  const processor: Processor<UtahCandidateFinanceSyncJobData, UtahCandidateFinanceSyncJobResult> = async (job) => {
    return runUtahCandidateFinanceSyncJob(job.data ?? {});
  };

  return new Worker<UtahCandidateFinanceSyncJobData, UtahCandidateFinanceSyncJobResult>(
    queueName,
    processor,
    {
      connection,
      concurrency: 1,
    }
  );
}
