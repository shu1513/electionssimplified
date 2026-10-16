import { Queue, Worker, type JobsOptions, type Processor } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import { toConnectionOptions } from "../utils/redisConnection.js";
import { Pool } from "pg";

import { getPipelineEnv } from "../config/env.js";
import {
  isGeorgiaCampaignFinanceEnabled,
  isGeorgiaCampaignFinanceSyncEnabled,
  isGeorgiaReportedIeEnabled,
  isGeorgiaReportedCommitteeContributionsEnabled,
} from "../config/featureFlags.js";
import {
  syncDueGeorgiaCandidateFinance,
  type GeorgiaCandidateFinanceBatchSyncResult,
} from "../pipeline/georgiaFinance/georgiaCandidateFinanceBatchSync.js";
import {syncDueGeorgiaReportedFinance, type GeorgiaReportedFinanceBatchResult} from "../pipeline/georgiaFinance/georgiaReportedFinanceBatchSync.js";

export const GEORGIA_CANDIDATE_FINANCE_SYNC_JOB_NAME = "georgia_candidate_finance_sync_due";
export const GEORGIA_CANDIDATE_FINANCE_SYNC_DAILY_SCHEDULER_ID = "georgia_candidate_finance_sync_daily";
export const GEORGIA_REPORTED_FINANCE_SYNC_JOB_NAME = "georgia_reported_finance_sync_due";
export const GEORGIA_REPORTED_FINANCE_DAILY_SCHEDULER_ID = "georgia_reported_finance_sync_daily";

export type GeorgiaCandidateFinanceSyncJobData = {
  dryRun?: boolean;
  force?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  // Stability passes for the windowed transaction pulls (client minimum 2 —
  // stability means two consecutive equal id-sets).
  maxPasses?: number;
  triggeredBy?: "daily" | "manual" | "unknown";
  requestedAt?: string;
  refresh?: boolean;
  cacheDir?: string;
  filingYear?: number;
  electionYear?: number;
};

export type GeorgiaCandidateFinanceSyncJobResult = GeorgiaCandidateFinanceBatchSyncResult & {
  enabled: boolean;
  force: boolean;
  triggeredBy: NonNullable<GeorgiaCandidateFinanceSyncJobData["triggeredBy"]>;
};

export type GeorgiaCandidateFinanceSyncEnqueueOptions = {
  jobId?: string;
};

type GeorgiaCandidateFinanceSyncSchedulerRuntimeConfig = {
  queueName: string;
  dailyCron: string;
  dailyTz: string;
};

const DISABLED_RESULT_DEFAULT_MAX_CANDIDATES = 0;
const DISABLED_RESULT_DEFAULT_STALE_AFTER_DAYS = 0;

function readSchedulerRuntimeConfig(): GeorgiaCandidateFinanceSyncSchedulerRuntimeConfig {
  return {
    queueName:
      process.env.GEORGIA_CAMPAIGN_FINANCE_SYNC_SCHEDULER_QUEUE?.trim() ||
      "georgia_candidate_finance_sync_maintenance",
    // Offset from Ohio's 09:55 and North Carolina's 10:25 so the state syncs
    // never stack on one worker host.
    dailyCron: process.env.GEORGIA_CAMPAIGN_FINANCE_SYNC_DAILY_CRON?.trim() || "55 10 * * *",
    dailyTz: process.env.GEORGIA_CAMPAIGN_FINANCE_SYNC_DAILY_TZ?.trim() || "UTC",
  };
}

function assertPositiveInteger(value: number | undefined, label: string): void {
  // isSafeInteger, not isInteger: Number("9007199254740993") silently rounds
  // to 2^53 and still passes isInteger.
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new Error(`Invalid Georgia finance sync scheduler ${label}: ${value}`);
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
    throw new Error("Georgia finance sync scheduler jobId must not contain ':'");
  }
  if (trimmed === "disabled" || trimmed === "unknown") {
    throw new Error("Georgia finance sync scheduler jobId uses a reserved value");
  }
  return trimmed;
}

function jobOptionsWithId(jobId: string | undefined): JobsOptions {
  const normalizedJobId = normalizeOptionalJobId(jobId);
  return normalizedJobId ? { ...defaultJobOptions(), jobId: normalizedJobId } : defaultJobOptions();
}

function assertValidJobOptions(data: GeorgiaCandidateFinanceSyncJobData): void {
  assertPositiveInteger(data.maxCandidates, "maxCandidates");
  assertPositiveInteger(data.staleAfterDays, "staleAfterDays");
  assertPositiveInteger(data.electionLookbackDays, "electionLookbackDays");
  assertPositiveInteger(data.electionLookaheadDays, "electionLookaheadDays");
  assertPositiveInteger(data.maxPasses, "maxPasses");
  if (data.maxPasses !== undefined && data.maxPasses < 2) {
    throw new Error(`Invalid Georgia finance sync scheduler maxPasses: ${data.maxPasses} (stability needs at least 2)`);
  }
}

export function createGeorgiaCandidateFinanceSyncSchedulerQueue(): Queue<GeorgiaCandidateFinanceSyncJobData> {
  return new Queue<GeorgiaCandidateFinanceSyncJobData>(getQueueName(), {
    connection: getQueueConnection(),
    defaultJobOptions: defaultJobOptions(),
  });
}

export async function upsertRecurringGeorgiaCandidateFinanceSyncJobs(
  jobData: GeorgiaCandidateFinanceSyncJobData = {}
): Promise<void> {
  assertValidJobOptions(jobData);
  if (!isGeorgiaCampaignFinanceEnabled()) {
    const queue = createGeorgiaCandidateFinanceSyncSchedulerQueue();
    try {
      await queue.removeJobScheduler(GEORGIA_CANDIDATE_FINANCE_SYNC_DAILY_SCHEDULER_ID);
      await queue.removeJobScheduler(GEORGIA_REPORTED_FINANCE_DAILY_SCHEDULER_ID);
    } finally {
      await queue.close();
    }
    return;
  }

  const config = readSchedulerRuntimeConfig();
  const queue = createGeorgiaCandidateFinanceSyncSchedulerQueue();

  try {
    await queue.upsertJobScheduler(
      GEORGIA_CANDIDATE_FINANCE_SYNC_DAILY_SCHEDULER_ID,
      {
        pattern: config.dailyCron,
        tz: config.dailyTz,
      },
      {
        name: GEORGIA_CANDIDATE_FINANCE_SYNC_JOB_NAME,
        data: {
          dryRun: Boolean(jobData.dryRun),
          force: Boolean(jobData.force),
          maxCandidates: jobData.maxCandidates,
          staleAfterDays: jobData.staleAfterDays,
          electionLookbackDays: jobData.electionLookbackDays,
          electionLookaheadDays: jobData.electionLookaheadDays,
          maxPasses: jobData.maxPasses,
          triggeredBy: "daily",
        },
        opts: defaultJobOptions(),
      }
    );
    if (isGeorgiaReportedIeEnabled() || isGeorgiaReportedCommitteeContributionsEnabled()) {
      await queue.upsertJobScheduler(GEORGIA_REPORTED_FINANCE_DAILY_SCHEDULER_ID,
        {pattern: config.dailyCron, tz: config.dailyTz},
        {name: GEORGIA_REPORTED_FINANCE_SYNC_JOB_NAME, data: {triggeredBy: "daily", dryRun: Boolean(jobData.dryRun),
          refresh: Boolean(jobData.refresh), cacheDir: jobData.cacheDir, filingYear: jobData.filingYear,
          electionYear: jobData.electionYear, maxCandidates: jobData.maxCandidates, staleAfterDays: jobData.staleAfterDays,
          electionLookbackDays: jobData.electionLookbackDays, electionLookaheadDays: jobData.electionLookaheadDays}, opts: defaultJobOptions()});
    } else {
      await queue.removeJobScheduler(GEORGIA_REPORTED_FINANCE_DAILY_SCHEDULER_ID);
    }
  } finally {
    await queue.close();
  }
}

export async function enqueueManualGeorgiaCandidateFinanceSyncJob(
  jobData: GeorgiaCandidateFinanceSyncJobData = {},
  options: GeorgiaCandidateFinanceSyncEnqueueOptions = {}
): Promise<string> {
  assertValidJobOptions(jobData);
  if (!isGeorgiaCampaignFinanceSyncEnabled(Boolean(jobData.force))) {
    return "disabled";
  }

  const queue = createGeorgiaCandidateFinanceSyncSchedulerQueue();

  try {
    const job = await queue.add(
      GEORGIA_CANDIDATE_FINANCE_SYNC_JOB_NAME,
      {
        dryRun: Boolean(jobData.dryRun),
        force: Boolean(jobData.force),
        maxCandidates: jobData.maxCandidates,
        staleAfterDays: jobData.staleAfterDays,
        electionLookbackDays: jobData.electionLookbackDays,
        electionLookaheadDays: jobData.electionLookaheadDays,
        maxPasses: jobData.maxPasses,
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

export async function runGeorgiaCandidateFinanceSyncJob(
  data: GeorgiaCandidateFinanceSyncJobData = {}
): Promise<GeorgiaCandidateFinanceSyncJobResult> {
  assertValidJobOptions(data);
  const force = Boolean(data.force);
  const dryRun = Boolean(data.dryRun);
  const triggeredBy = data.triggeredBy ?? "unknown";
  const now = new Date();
  const enabled = isGeorgiaCampaignFinanceSyncEnabled(force);

  if (!data.triggeredBy) {
    console.warn("Georgia finance sync job missing triggeredBy; recording as unknown");
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
      independentExpenditureStoreError: null,
      results: [],
    };
  }

  const env = getPipelineEnv();
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  try {
    const result = await syncDueGeorgiaCandidateFinance({
      db: pool,
      now,
      dryRun,
      maxCandidates: data.maxCandidates,
      staleAfterDays: data.staleAfterDays,
      electionLookbackDays: data.electionLookbackDays,
      electionLookaheadDays: data.electionLookaheadDays,
      maxPasses: data.maxPasses,
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

export function createGeorgiaCandidateFinanceSyncSchedulerWorker(): Worker<
  GeorgiaCandidateFinanceSyncJobData,
  GeorgiaCandidateFinanceSyncJobResult | GeorgiaReportedFinanceBatchResult | {enabled: false}
> {
  const connection = getQueueConnection();
  const queueName = getQueueName();

  const processor: Processor<GeorgiaCandidateFinanceSyncJobData, GeorgiaCandidateFinanceSyncJobResult | GeorgiaReportedFinanceBatchResult | {enabled: false}> = async (
    job
  ) => {
    if (job.name === GEORGIA_REPORTED_FINANCE_SYNC_JOB_NAME) {
      if (!isGeorgiaReportedIeEnabled() && !isGeorgiaReportedCommitteeContributionsEnabled()) return {enabled: false};
      const connectionString = process.env.DATABASE_URL?.trim();
      if (!connectionString) throw new Error("DATABASE_URL is required for Georgia reported finance sync");
      const db = new Pool({connectionString});
      try {
        const {dryRun, refresh, cacheDir, filingYear, electionYear, maxCandidates, staleAfterDays,
          electionLookbackDays, electionLookaheadDays} = job.data ?? {};
        return await syncDueGeorgiaReportedFinance({db, dryRun, refresh, cacheDir, filingYear, electionYear,
          maxCandidates, staleAfterDays, electionLookbackDays, electionLookaheadDays});
      } finally {await db.end();}
    }
    if (job.name !== GEORGIA_CANDIDATE_FINANCE_SYNC_JOB_NAME) throw new Error("Unknown Georgia finance sync job name");
    return runGeorgiaCandidateFinanceSyncJob(job.data ?? {});
  };

  return new Worker<GeorgiaCandidateFinanceSyncJobData, GeorgiaCandidateFinanceSyncJobResult | GeorgiaReportedFinanceBatchResult | {enabled: false}>(
    queueName,
    processor,
    {
      connection,
      concurrency: 1,
    }
  );
}
