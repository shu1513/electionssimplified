import { Queue, Worker, type JobsOptions, type Processor } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import { toConnectionOptions } from "../utils/redisConnection.js";
import { Pool } from "pg";

import { getPipelineEnv } from "../config/env.js";
import { isMarylandCampaignFinanceEnabled, isMarylandCampaignFinanceSyncEnabled } from "../config/featureFlags.js";
import {
  syncDueMarylandCandidateFinance,
  type MarylandCandidateFinanceBatchSyncResult,
} from "../pipeline/marylandFinance/marylandCandidateFinanceBatchSync.js";

export const MARYLAND_CANDIDATE_FINANCE_SYNC_JOB_NAME = "maryland_candidate_finance_sync_due";
export const MARYLAND_CANDIDATE_FINANCE_SYNC_DAILY_SCHEDULER_ID = "maryland_candidate_finance_sync_daily";

export type MarylandCandidateFinanceSyncJobData = {
  dryRun?: boolean;
  force?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  rawDataCacheDir?: string;
  triggeredBy?: "daily" | "manual" | "unknown";
  requestedAt?: string;
};

export type MarylandCandidateFinanceSyncJobResult = MarylandCandidateFinanceBatchSyncResult & {
  enabled: boolean;
  force: boolean;
  triggeredBy: NonNullable<MarylandCandidateFinanceSyncJobData["triggeredBy"]>;
};

export type MarylandCandidateFinanceSyncEnqueueOptions = {
  jobId?: string;
};

type MarylandCandidateFinanceSyncSchedulerRuntimeConfig = {
  queueName: string;
  dailyCron: string;
  dailyTz: string;
};

const DISABLED_RESULT_DEFAULT_MAX_CANDIDATES = 0;
const DISABLED_RESULT_DEFAULT_STALE_AFTER_DAYS = 0;

function readSchedulerRuntimeConfig(): MarylandCandidateFinanceSyncSchedulerRuntimeConfig {
  return {
    queueName:
      process.env.MARYLAND_CAMPAIGN_FINANCE_SYNC_SCHEDULER_QUEUE?.trim() ||
      "maryland_candidate_finance_sync_maintenance",
    dailyCron: process.env.MARYLAND_CAMPAIGN_FINANCE_SYNC_DAILY_CRON?.trim() || "50 9 * * *",
    dailyTz: process.env.MARYLAND_CAMPAIGN_FINANCE_SYNC_DAILY_TZ?.trim() || "UTC",
  };
}

function assertPositiveInteger(value: number | undefined, label: string): void {
  // isSafeInteger, not isInteger: Number("9007199254740993") silently rounds
  // to 2^53 and still passes isInteger.
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new Error(`Invalid Maryland finance sync scheduler ${label}: ${value}`);
  }
}

function getQueueConnection(): ConnectionOptions {
  return toConnectionOptions(getPipelineEnv().REDIS_URL);
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
    throw new Error("Maryland finance sync scheduler jobId must not contain ':'");
  }
  if (trimmed === "disabled" || trimmed === "unknown") {
    throw new Error("Maryland finance sync scheduler jobId uses a reserved value");
  }
  return trimmed;
}

function jobOptionsWithId(jobId: string | undefined): JobsOptions {
  const normalizedJobId = normalizeOptionalJobId(jobId);
  return normalizedJobId ? { ...defaultJobOptions(), jobId: normalizedJobId } : defaultJobOptions();
}

function assertValidJobOptions(data: MarylandCandidateFinanceSyncJobData): void {
  assertPositiveInteger(data.maxCandidates, "maxCandidates");
  assertPositiveInteger(data.staleAfterDays, "staleAfterDays");
  assertPositiveInteger(data.electionLookbackDays, "electionLookbackDays");
  assertPositiveInteger(data.electionLookaheadDays, "electionLookaheadDays");
}

export function createMarylandCandidateFinanceSyncSchedulerQueue(): Queue<MarylandCandidateFinanceSyncJobData> {
  return new Queue<MarylandCandidateFinanceSyncJobData>(getQueueName(), {
    connection: getQueueConnection(),
    defaultJobOptions: defaultJobOptions(),
  });
}

export async function upsertRecurringMarylandCandidateFinanceSyncJobs(
  jobData: MarylandCandidateFinanceSyncJobData = {}
): Promise<void> {
  assertValidJobOptions(jobData);
  if (!isMarylandCampaignFinanceEnabled()) {
    const queue = createMarylandCandidateFinanceSyncSchedulerQueue();
    try {
      await queue.removeJobScheduler(MARYLAND_CANDIDATE_FINANCE_SYNC_DAILY_SCHEDULER_ID);
    } finally {
      await queue.close();
    }
    return;
  }

  const config = readSchedulerRuntimeConfig();
  const queue = createMarylandCandidateFinanceSyncSchedulerQueue();

  try {
    await queue.upsertJobScheduler(
      MARYLAND_CANDIDATE_FINANCE_SYNC_DAILY_SCHEDULER_ID,
      {
        pattern: config.dailyCron,
        tz: config.dailyTz,
      },
      {
        name: MARYLAND_CANDIDATE_FINANCE_SYNC_JOB_NAME,
        data: {
          dryRun: Boolean(jobData.dryRun),
          force: Boolean(jobData.force),
          maxCandidates: jobData.maxCandidates,
          staleAfterDays: jobData.staleAfterDays,
          electionLookbackDays: jobData.electionLookbackDays,
          electionLookaheadDays: jobData.electionLookaheadDays,
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

export async function enqueueManualMarylandCandidateFinanceSyncJob(
  jobData: MarylandCandidateFinanceSyncJobData = {},
  options: MarylandCandidateFinanceSyncEnqueueOptions = {}
): Promise<string> {
  assertValidJobOptions(jobData);
  if (!isMarylandCampaignFinanceSyncEnabled(Boolean(jobData.force))) {
    return "disabled";
  }

  const queue = createMarylandCandidateFinanceSyncSchedulerQueue();

  try {
    const job = await queue.add(
      MARYLAND_CANDIDATE_FINANCE_SYNC_JOB_NAME,
      {
        dryRun: Boolean(jobData.dryRun),
        force: Boolean(jobData.force),
        maxCandidates: jobData.maxCandidates,
        staleAfterDays: jobData.staleAfterDays,
        electionLookbackDays: jobData.electionLookbackDays,
        electionLookaheadDays: jobData.electionLookaheadDays,
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

export async function runMarylandCandidateFinanceSyncJob(
  data: MarylandCandidateFinanceSyncJobData = {}
): Promise<MarylandCandidateFinanceSyncJobResult> {
  assertValidJobOptions(data);
  const force = Boolean(data.force);
  const dryRun = Boolean(data.dryRun);
  const triggeredBy = data.triggeredBy ?? "unknown";
  const now = new Date();
  const enabled = isMarylandCampaignFinanceSyncEnabled(force);

  if (!data.triggeredBy) {
    console.warn("Maryland finance sync job missing triggeredBy; recording as unknown");
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
      results: [],
      nativeOutsideObservation: { status: "preserve", diagnostics: ["finance_sync_disabled"] },
    };
  }

  const env = getPipelineEnv();
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  try {
    const result = await syncDueMarylandCandidateFinance({
      db: pool,
      now,
      dryRun,
      maxCandidates: data.maxCandidates,
      staleAfterDays: data.staleAfterDays,
      electionLookbackDays: data.electionLookbackDays,
      electionLookaheadDays: data.electionLookaheadDays,
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

export function createMarylandCandidateFinanceSyncSchedulerWorker(): Worker<
  MarylandCandidateFinanceSyncJobData,
  MarylandCandidateFinanceSyncJobResult
> {
  const connection = getQueueConnection();
  const queueName = getQueueName();

  const processor: Processor<MarylandCandidateFinanceSyncJobData, MarylandCandidateFinanceSyncJobResult> = async (
    job
  ) => {
    return runMarylandCandidateFinanceSyncJob(job.data ?? {});
  };

  return new Worker<MarylandCandidateFinanceSyncJobData, MarylandCandidateFinanceSyncJobResult>(
    queueName,
    processor,
    {
      connection,
      concurrency: 1,
    }
  );
}
