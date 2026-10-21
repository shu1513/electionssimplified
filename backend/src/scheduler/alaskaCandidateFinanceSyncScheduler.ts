import { Queue, Worker, type JobsOptions, type Processor } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import { toConnectionOptions } from "../utils/redisConnection.js";
import { Pool } from "pg";

import { getPipelineEnv } from "../config/env.js";
import { isAlaskaCampaignFinanceEnabled, isAlaskaCampaignFinanceSyncEnabled, isAlaskaReportedCommitteeEnabled, isAlaskaReportedIeEnabled } from "../config/featureFlags.js";
import {
  loadAlaskaApocFinanceData,
  type AlaskaApocDataSourceMetadata,
  type AlaskaApocDataSourceMode,
} from "../pipeline/alaskaFinance/alaskaApocDataSource.js";
import {
  syncDueAlaskaCandidateFinance,
  type AlaskaCandidateFinanceBatchSyncResult,
} from "../pipeline/alaskaFinance/alaskaCandidateFinanceBatchSync.js";

export const ALASKA_CANDIDATE_FINANCE_SYNC_JOB_NAME = "alaska_candidate_finance_sync_due";
export const ALASKA_CANDIDATE_FINANCE_SYNC_DAILY_SCHEDULER_ID = "alaska_candidate_finance_sync_daily";

export type AlaskaCandidateFinanceSyncJobData = {
  dryRun?: boolean;
  force?: boolean;
  autoLinkMissingLinks?: boolean;
  maxCandidates?: number;
  staleAfterDays?: number;
  electionLookbackDays?: number;
  electionLookaheadDays?: number;
  dataSourceMode?: AlaskaApocDataSourceMode;
  incomeCsvPath?: string;
  independentExpendituresCsvPath?: string;
  independentContributionsCsvPath?: string;
  incomeUrl?: string;
  independentExpendituresUrl?: string;
  independentContributionsUrl?: string;
  timeoutMs?: number;
  retryCount?: number;
  retryDelayMs?: number;
  requestSpacingMs?: number;
  triggeredBy?: "daily" | "manual" | "unknown";
  requestedAt?: string;
};

export type AlaskaCandidateFinanceSyncJobResult = AlaskaCandidateFinanceBatchSyncResult & {
  enabled: boolean;
  force: boolean;
  triggeredBy: NonNullable<AlaskaCandidateFinanceSyncJobData["triggeredBy"]>;
  dataSource: AlaskaApocDataSourceMetadata | null;
};

export type AlaskaCandidateFinanceSyncEnqueueOptions = {
  jobId?: string;
};

type AlaskaCandidateFinanceSyncSchedulerRuntimeConfig = {
  queueName: string;
  dailyCron: string;
  dailyTz: string;
};

const DISABLED_RESULT_DEFAULT_MAX_CANDIDATES = 0;
const DISABLED_RESULT_DEFAULT_STALE_AFTER_DAYS = 0;

function readSchedulerRuntimeConfig(): AlaskaCandidateFinanceSyncSchedulerRuntimeConfig {
  return {
    queueName:
      process.env.ALASKA_CAMPAIGN_FINANCE_SYNC_SCHEDULER_QUEUE?.trim() ||
      "alaska_candidate_finance_sync_maintenance",
    dailyCron: process.env.ALASKA_CAMPAIGN_FINANCE_SYNC_DAILY_CRON?.trim() || "35 9 * * *",
    dailyTz: process.env.ALASKA_CAMPAIGN_FINANCE_SYNC_DAILY_TZ?.trim() || "UTC",
  };
}

function assertPositiveInteger(value: number | undefined, label: string): void {
  // isSafeInteger, not isInteger: Number("9007199254740993") silently rounds
  // to 2^53 and still passes isInteger.
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new Error(`Invalid Alaska finance sync scheduler ${label}: ${value}`);
  }
}

function assertNonNegativeInteger(value: number | undefined, label: string): void {
  // isSafeInteger, not isInteger: Number("9007199254740993") silently rounds
  // to 2^53 and still passes isInteger.
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`Invalid Alaska finance sync scheduler ${label}: ${value}`);
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
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 60_000,
    },
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
    throw new Error("Alaska finance sync scheduler jobId must not contain ':'");
  }
  return trimmed;
}

function jobOptionsWithId(jobId: string | undefined): JobsOptions {
  const normalizedJobId = normalizeOptionalJobId(jobId);
  return normalizedJobId ? { ...defaultJobOptions(), jobId: normalizedJobId } : defaultJobOptions();
}

function assertValidJobOptions(data: AlaskaCandidateFinanceSyncJobData): void {
  assertPositiveInteger(data.maxCandidates, "maxCandidates");
  assertPositiveInteger(data.staleAfterDays, "staleAfterDays");
  assertPositiveInteger(data.electionLookbackDays, "electionLookbackDays");
  assertPositiveInteger(data.electionLookaheadDays, "electionLookaheadDays");
  assertPositiveInteger(data.timeoutMs, "timeoutMs");
  assertNonNegativeInteger(data.retryCount, "retryCount");
  assertNonNegativeInteger(data.retryDelayMs, "retryDelayMs");
  assertNonNegativeInteger(data.requestSpacingMs, "requestSpacingMs");
  if (data.dataSourceMode !== undefined && data.dataSourceMode !== "csv" && data.dataSourceMode !== "live") {
    throw new Error(`Invalid Alaska finance sync scheduler dataSourceMode: ${data.dataSourceMode}`);
  }
}

export function createAlaskaCandidateFinanceSyncSchedulerQueue(): Queue<AlaskaCandidateFinanceSyncJobData> {
  return new Queue<AlaskaCandidateFinanceSyncJobData>(getQueueName(), {
    connection: getQueueConnection(),
    defaultJobOptions: defaultJobOptions(),
  });
}

export function buildAlaskaCandidateFinanceLinkedElectionSyncJobId(now = new Date()): string {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("Invalid Alaska finance linked-election sync job date");
  }
  return `alaska-candidate-finance-linked-election-sync-${now.toISOString().slice(0, 10)}`;
}

function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function readDataSourceMode(dataMode: AlaskaApocDataSourceMode | undefined): AlaskaApocDataSourceMode {
  if (dataMode) {
    return dataMode;
  }
  const rawMode = readOptionalEnv("ALASKA_APOC_DATA_SOURCE");
  if (!rawMode) {
    return "csv";
  }
  if (rawMode !== "csv" && rawMode !== "live") {
    throw new Error(`Invalid ALASKA_APOC_DATA_SOURCE value: ${rawMode}`);
  }
  return rawMode;
}

function readDataSourceConfig(data: AlaskaCandidateFinanceSyncJobData) {
  const mode = readDataSourceMode(data.dataSourceMode);
  return {
    mode,
    incomeCsvPath: data.incomeCsvPath ?? readOptionalEnv("ALASKA_APOC_INCOME_CSV_PATH"),
    independentExpendituresCsvPath:
      data.independentExpendituresCsvPath ?? readOptionalEnv("ALASKA_APOC_IE_EXPENDITURES_CSV_PATH"),
    independentContributionsCsvPath:
      data.independentContributionsCsvPath ?? readOptionalEnv("ALASKA_APOC_IE_CONTRIBUTIONS_CSV_PATH"),
    incomeUrl: data.incomeUrl ?? readOptionalEnv("ALASKA_APOC_CAMPAIGN_INCOME_URL"),
    independentExpendituresUrl:
      data.independentExpendituresUrl ?? readOptionalEnv("ALASKA_APOC_IE_EXPENDITURES_URL"),
    independentContributionsUrl:
      data.independentContributionsUrl ?? readOptionalEnv("ALASKA_APOC_IE_CONTRIBUTIONS_URL"),
    timeoutMs: data.timeoutMs,
    retryCount: data.retryCount,
    retryDelayMs: data.retryDelayMs,
    requestSpacingMs: data.requestSpacingMs,
  };
}

function assertUsableDataSourceConfig(config: ReturnType<typeof readDataSourceConfig>): void {
  if (config.mode === "csv" && !config.incomeCsvPath && !isAlaskaReportedCommitteeEnabled() && !isAlaskaReportedIeEnabled()) {
    throw new Error(
      "Alaska finance sync scheduler CSV data source requires incomeCsvPath or ALASKA_APOC_INCOME_CSV_PATH"
    );
  }
}

export async function upsertRecurringAlaskaCandidateFinanceSyncJobs(
  jobData: AlaskaCandidateFinanceSyncJobData = {}
): Promise<void> {
  assertValidJobOptions(jobData);
  if (!isAlaskaCampaignFinanceEnabled()) {
    const queue = createAlaskaCandidateFinanceSyncSchedulerQueue();
    try {
      await queue.removeJobScheduler(ALASKA_CANDIDATE_FINANCE_SYNC_DAILY_SCHEDULER_ID);
    } finally {
      await queue.close();
    }
    return;
  }

  const config = readSchedulerRuntimeConfig();
  assertUsableDataSourceConfig(readDataSourceConfig(jobData));
  const queue = createAlaskaCandidateFinanceSyncSchedulerQueue();
  const dryRun = jobData.dryRun !== false;

  try {
    await queue.upsertJobScheduler(
      ALASKA_CANDIDATE_FINANCE_SYNC_DAILY_SCHEDULER_ID,
      {
        pattern: config.dailyCron,
        tz: config.dailyTz,
      },
      {
        name: ALASKA_CANDIDATE_FINANCE_SYNC_JOB_NAME,
        data: {
          ...jobData,
          dryRun,
          force: Boolean(jobData.force),
          autoLinkMissingLinks: !dryRun && Boolean(jobData.autoLinkMissingLinks),
          triggeredBy: "daily",
        },
        opts: defaultJobOptions(),
      }
    );
  } finally {
    await queue.close();
  }
}

export async function enqueueManualAlaskaCandidateFinanceSyncJob(
  jobData: AlaskaCandidateFinanceSyncJobData = {},
  options: AlaskaCandidateFinanceSyncEnqueueOptions = {}
): Promise<string> {
  assertValidJobOptions(jobData);
  if (!isAlaskaCampaignFinanceSyncEnabled(Boolean(jobData.force))) {
    return "disabled";
  }
  assertUsableDataSourceConfig(readDataSourceConfig(jobData));

  const queue = createAlaskaCandidateFinanceSyncSchedulerQueue();
  const dryRun = jobData.dryRun !== false;

  try {
    const job = await queue.add(
      ALASKA_CANDIDATE_FINANCE_SYNC_JOB_NAME,
      {
        ...jobData,
        dryRun,
        force: Boolean(jobData.force),
        autoLinkMissingLinks: !dryRun && Boolean(jobData.autoLinkMissingLinks),
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

export async function runAlaskaCandidateFinanceSyncJob(
  data: AlaskaCandidateFinanceSyncJobData = {}
): Promise<AlaskaCandidateFinanceSyncJobResult> {
  assertValidJobOptions(data);
  const force = Boolean(data.force);
  const dryRun = data.dryRun !== false;
  const triggeredBy = data.triggeredBy ?? "unknown";
  const now = new Date();
  const enabled = isAlaskaCampaignFinanceSyncEnabled(force);

  if (!data.triggeredBy) {
    console.warn("Alaska finance sync job missing triggeredBy; recording as unknown");
  }

  if (!enabled) {
    return {
      enabled: false,
      force,
      triggeredBy,
      dataSource: null,
      dryRun,
      now: now.toISOString(),
      staleAfterDays: data.staleAfterDays ?? DISABLED_RESULT_DEFAULT_STALE_AFTER_DAYS,
      maxCandidates: data.maxCandidates ?? DISABLED_RESULT_DEFAULT_MAX_CANDIDATES,
      dueCandidateCount: 0,
      selectedCandidateCount: 0,
      syncedCandidateCount: 0,
      identityConflictCandidateCount: 0,
      failedCandidateCount: 0,
      autoLinkAttemptedCount: 0,
      autoLinkLinkedCount: 0,
      autoLinkResults: [],
      results: [],
    };
  }

  const env = getPipelineEnv();
  const dataSourceConfig = readDataSourceConfig(data);
  assertUsableDataSourceConfig(dataSourceConfig);
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  try {
    let metadata: AlaskaApocDataSourceMetadata | null = null;
    const result = await syncDueAlaskaCandidateFinance({
      db: pool,
      now,
      dryRun,
      maxCandidates: data.maxCandidates,
      staleAfterDays: data.staleAfterDays,
      electionLookbackDays: data.electionLookbackDays,
      electionLookaheadDays: data.electionLookaheadDays,
      autoLinkMissingLinks: !dryRun && Boolean(data.autoLinkMissingLinks),
      loadApocData: async () => {
        const loaded = await loadAlaskaApocFinanceData(dataSourceConfig, { logger: { warn() {} } });
        metadata = loaded.metadata;
        return loaded.apocData;
      },
    });

    return {
      enabled: true,
      force,
      triggeredBy,
      dataSource: metadata,
      ...result,
    };
  } finally {
    await pool.end();
  }
}

export function createAlaskaCandidateFinanceSyncSchedulerWorker(): Worker<
  AlaskaCandidateFinanceSyncJobData,
  AlaskaCandidateFinanceSyncJobResult
> {
  const connection = getQueueConnection();
  const queueName = getQueueName();

  const processor: Processor<AlaskaCandidateFinanceSyncJobData, AlaskaCandidateFinanceSyncJobResult> = async (job) => {
    return runAlaskaCandidateFinanceSyncJob(job.data ?? {});
  };

  return new Worker<AlaskaCandidateFinanceSyncJobData, AlaskaCandidateFinanceSyncJobResult>(queueName, processor, {
    connection,
    concurrency: 1,
  });
}
