import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { createClient } from "redis";

import { loadProjectEnv } from "../config/env.js";
import { requireLocalDatabaseTarget } from "./localDatabaseGuard.js";
import {
  STAGING_ITEM_TYPE_ELECTION,
  STAGING_PENDING_STREAM,
} from "../config/electionsPipeline.js";
import {
  ELECTION_ENRICHMENT_SCHEMA_VERSION,
  ELECTION_PROMPT_VERSION,
} from "../contracts/electionEnrichmentContract.js";
import {
  parseCanonicalElectionPayload,
  parseFamilySourceUrls,
} from "../contracts/electionPayloadContract.js";

import { assertKnownCliFlags } from "./manualCliFlags.js";
import { REINSTATE_RETIRED_APPROVED_FLAG } from "../pipeline/elections/retiredElectionIdentities.js";

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index >= 0) {
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--") || value.trim().length === 0) {
      throw new Error(`Missing value for ${name}.\n${usage()}`);
    }
    return value;
  }
  const prefix = `${name}=`;
  const match = process.argv.find((token) => token.startsWith(prefix));
  if (!match) {
    return null;
  }
  const value = match.slice(prefix.length);
  if (value.trim().length === 0) {
    throw new Error(`Missing value for ${name}.\n${usage()}`);
  }
  return value;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function toReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 1000 ? `${message.slice(0, 997)}...` : message;
}

function usage(): string {
  return [
    "Usage:",
    "  npm run manual:elections:inject -- --file payload.json [--ingest-key key] [--run-id id] [--review-approve] [--historical] [--reinstate-retired] [--dry-run]",
    "",
    "Payload must match ElectionEnrichedPayload and will be staged for the existing elections validator.",
    "",
    "--review-approve is the manual equivalent of the AI review retry for validator soft-fails:",
    "the payload must carry review_decision: \"approve\" and a review_reason, and the row is staged",
    "with soft_retry_count already set so the validator's existing review-approve branch applies.",
    "Use it only after a previous inject soft-failed and the reason was researched and found acceptable.",
    "It applies only to scope-validation soft-fails. A payload whose entries were all filtered as",
    "presidential is still rejected regardless of review_decision: presidential contests belong to",
    "presidential_cycles, never district elections, and approval cannot override that.",
    "--historical is a separate, review-gated path for verified past elections. It requires",
    "review_decision: \"approve\" plus a non-empty review_reason and only relaxes the date guard,",
    "for every entry in the payload. Its default ingest key is namespaced by the earliest entry's",
    "election year (manual:elections:<district>:historical:<year>) so a historical import never",
    "overwrites the district's current-year staging row.",
    "--reinstate-retired writes a contest that manual:elections:retire-spurious or",
    "manual:elections:supersede retired (the writer otherwise skips it and records why). The",
    "payload must carry reinstate_retired: true and a review_reason citing the source that shows",
    "the contest is real; the matching ledger rows are closed when the contest is written.",
  ].join("\n");
}

async function readJsonFile(path: string): Promise<unknown> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as unknown;
}

// The validator only honors payload review_decision on a retry pass
// (soft_retry_count > 0), so a manual review approval must stage the row as if
// the retry already happened. This is the manual equivalent of the AI review
// pass for validator soft-fails.
export function resolveReviewApproveFailureDebugJson(
  payload: { review_decision?: "approve" | "reject"; review_reason?: string },
  reviewApprove: boolean
): string | null {
  if (!reviewApprove) {
    return null;
  }
  if (payload.review_decision !== "approve") {
    throw new Error(
      `--review-approve requires the payload to carry review_decision: "approve".\n${usage()}`
    );
  }
  if (!payload.review_reason?.trim()) {
    throw new Error(
      `--review-approve requires a non-empty payload review_reason documenting why the soft-fail is acceptable.\n${usage()}`
    );
  }
  return JSON.stringify({
    soft_retry_count: 1,
    manual_review_approved: true,
    manual_approve_at: new Date().toISOString(),
  });
}

export function resolveHistoricalImportDebugJson(
  payload: { review_decision?: "approve" | "reject"; review_reason?: string },
  historical: boolean
): string | null {
  if (!historical) {
    return null;
  }
  if (payload.review_decision !== "approve") {
    throw new Error(
      `--historical requires the payload to carry review_decision: "approve".\n${usage()}`
    );
  }
  if (!payload.review_reason?.trim()) {
    throw new Error(
      `--historical requires a non-empty payload review_reason documenting why the historical election is verified.\n${usage()}`
    );
  }
  return JSON.stringify({
    historical_import_approved: true,
    historical_import_approved_at: new Date().toISOString(),
  });
}

// A retired identity is skipped by the writer unless the staging row carries
// this marker (manual rows only). The CLI flag and the payload field must
// agree, so a file that still says reinstate_retired: true cannot reinstate
// by accident on a routine re-inject.
export function resolveReinstateRetiredDebugJson(
  payload: { reinstate_retired?: boolean; review_reason?: string },
  reinstateRetired: boolean
): string | null {
  if (!reinstateRetired) {
    if (payload.reinstate_retired === true) {
      throw new Error(
        `The payload carries reinstate_retired: true; re-run with --reinstate-retired to confirm the reinstatement, or remove the field.\n${usage()}`
      );
    }
    return null;
  }
  if (payload.reinstate_retired !== true) {
    throw new Error(`--reinstate-retired requires the payload to carry reinstate_retired: true.\n${usage()}`);
  }
  if (!payload.review_reason?.trim()) {
    throw new Error(
      `--reinstate-retired requires a non-empty payload review_reason citing the source that shows the contest is real.\n${usage()}`
    );
  }
  return JSON.stringify({
    [REINSTATE_RETIRED_APPROVED_FLAG]: true,
    reinstate_retired_approved_at: new Date().toISOString(),
  });
}

export function extractFamilySourceUrls(payload: unknown): Record<string, string[]> | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const parsed = parseFamilySourceUrls((payload as Record<string, unknown>).family_source_urls);
  if (!parsed.ok) {
    throw new Error(`Election payload failed validation: ${parsed.reason}\n${usage()}`);
  }
  return parsed.familySourceUrls ?? null;
}

function defaultIngestKey(districtId: string): string {
  const runYear = new Date().getUTCFullYear();
  return `manual:elections:${districtId}:${runYear}`;
}

// A historical import must never default onto the district's current-year key:
// staging is an upsert by ingest_key, so reusing the run-year key would
// overwrite a pending/validated current-election row (and its audit trail).
export function historicalDefaultIngestKey(
  districtId: string,
  payload: { entries: ReadonlyArray<{ election_date: string }> }
): string {
  const years = payload.entries
    .map((entry) => Number.parseInt(entry.election_date.slice(0, 4), 10))
    .filter((year) => Number.isFinite(year));
  const year = years.length > 0 ? Math.min(...years) : new Date().getUTCFullYear();
  return `manual:elections:${districtId}:historical:${year}`;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for manual election injection`);
  }
  return value;
}

// Shared with the bulk no-results injector: stage one manual election payload
// and publish its pending-stream message, exactly as a single inject does.
export type StageManualElectionPayloadResult =
  | { staged: true; redisMessageId: string }
  | { staged: false };

export async function stageManualElectionPayload(
  pool: Pool,
  redis: ReturnType<typeof createClient>,
  options: {
    ingestKey: string;
    runId: string;
    payloadJson: string;
    failureDebugJson: string | null;
    aiRawDebugJson: string;
    overwriteExisting?: boolean;
  }
): Promise<StageManualElectionPayloadResult> {
  const {
    ingestKey,
    runId,
    payloadJson,
    failureDebugJson,
    aiRawDebugJson,
    overwriteExisting = true,
  } = options;
  const upsert = await pool.query(
    `
      INSERT INTO staging_items (
        ingest_key,
        item_type,
        payload,
        status,
        reason,
        run_id,
        model,
        schema_version,
        prompt_version,
        validated_at,
        written_at,
        failure_debug,
        ai_raw_debug
      )
      VALUES ($1, $2, $3::jsonb, 'pending', NULL, $4, $5, $6, $7, NULL, NULL, $8::jsonb, $9::jsonb)
      ON CONFLICT (ingest_key) DO UPDATE SET
        item_type = EXCLUDED.item_type,
        payload = EXCLUDED.payload,
        status = 'pending',
        reason = NULL,
        run_id = EXCLUDED.run_id,
        model = EXCLUDED.model,
        schema_version = EXCLUDED.schema_version,
        prompt_version = EXCLUDED.prompt_version,
        validated_at = NULL,
        written_at = NULL,
        failure_debug = EXCLUDED.failure_debug,
        ai_raw_debug = EXCLUDED.ai_raw_debug,
        updated_at = now()
      WHERE $10::boolean
         OR staging_items.status IN ('failed', 'rejected', 'no_results')
      RETURNING ingest_key
    `,
    [
      ingestKey,
      STAGING_ITEM_TYPE_ELECTION,
      payloadJson,
      runId,
      "manual-research:codex",
      ELECTION_ENRICHMENT_SCHEMA_VERSION,
      ELECTION_PROMPT_VERSION,
      failureDebugJson,
      aiRawDebugJson,
      overwriteExisting,
    ]
  );

  if (!upsert.rowCount) {
    return { staged: false };
  }

  try {
    const redisMessageId = await redis.xAdd(STAGING_PENDING_STREAM, "*", {
      ingest_key: ingestKey,
      item_type: STAGING_ITEM_TYPE_ELECTION,
      run_id: runId,
    });
    return { staged: true, redisMessageId };
  } catch (error) {
    await pool.query(
      `
        UPDATE staging_items
        SET status = 'failed',
            reason = $2,
            updated_at = now()
        WHERE ingest_key = $1
          AND item_type = $3
          AND run_id = $4
      `,
      [
        ingestKey,
        `manual inject redis publish failed: ${toReason(error)}`,
        STAGING_ITEM_TYPE_ELECTION,
        runId,
      ]
    );
    throw error;
  }
}

async function main(): Promise<void> {
  assertKnownCliFlags("manual:elections:inject", process.argv.slice(2), [
    { name: "--file", value: "space" },
    { name: "--ingest-key", value: "space" },
    { name: "--run-id", value: "space" },
    { name: "--review-approve", value: "none" },
    { name: "--historical", value: "none" },
    { name: "--reinstate-retired", value: "none" },
    { name: "--dry-run", value: "none" },
  ]);
  loadProjectEnv();

  const file = readFlag("--file");
  if (!file) {
    throw new Error(`Missing --file.\n${usage()}`);
  }

  const rawPayload = await readJsonFile(file);
  const parsed = parseCanonicalElectionPayload(rawPayload);
  if (!parsed.ok) {
    throw new Error(`Election payload failed validation: ${parsed.reason}`);
  }

  const dryRun = hasFlag("--dry-run");
  const reviewApprove = hasFlag("--review-approve");
  const historical = hasFlag("--historical");
  const reinstateRetired = hasFlag("--reinstate-retired");
  const failureDebugJson = resolveReviewApproveFailureDebugJson(parsed.payload, reviewApprove);
  const historicalImportDebugJson = resolveHistoricalImportDebugJson(parsed.payload, historical);
  const reinstateRetiredDebugJson = resolveReinstateRetiredDebugJson(parsed.payload, reinstateRetired);
  const ingestKey =
    readFlag("--ingest-key") ??
    (historical
      ? historicalDefaultIngestKey(parsed.payload.district_id, parsed.payload)
      : defaultIngestKey(parsed.payload.district_id));
  const runId = readFlag("--run-id") ?? `manual_elections_${new Date().toISOString()}`;
  const payloadJson = JSON.stringify(parsed.payload);
  const familySourceUrls = extractFamilySourceUrls(rawPayload);
  const aiRawDebug = {
    manual_research: true,
    ...(familySourceUrls ? { family_source_urls: familySourceUrls } : {}),
    ...(reviewApprove ? { manual_review_approved: true } : {}),
    ...(historicalImportDebugJson ? JSON.parse(historicalImportDebugJson) : {}),
    ...(reinstateRetiredDebugJson ? JSON.parse(reinstateRetiredDebugJson) : {}),
  };

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          ingestKey,
          runId,
          districtId: parsed.payload.district_id,
          entryCount: parsed.payload.entries.length,
          familySourceUrlFamilies: familySourceUrls ? Object.keys(familySourceUrls) : [],
          reviewApprove,
          historical,
          reinstateRetired,
        },
        null,
        2
      )
    );
    return;
  }

  const databaseUrl = requireEnv("DATABASE_URL");
  requireLocalDatabaseTarget(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  const redis = createClient({ url: requireEnv("REDIS_URL") });

  try {
    await redis.connect();

    const staged = await stageManualElectionPayload(pool, redis, {
      ingestKey,
      runId,
      payloadJson,
      failureDebugJson,
      aiRawDebugJson: JSON.stringify(aiRawDebug),
    });
    if (!staged.staged) {
      throw new Error(`Manual election staging unexpectedly skipped existing ingest key ${ingestKey}`);
    }

    console.log(
      JSON.stringify(
        {
          ingestKey,
          runId,
          redisMessageId: staged.redisMessageId,
          districtId: parsed.payload.district_id,
          entryCount: parsed.payload.entries.length,
          familySourceUrlFamilies: familySourceUrls ? Object.keys(familySourceUrls) : [],
          reviewApprove,
          historical,
          reinstateRetired,
          // Targeted mode is the manual-run default: bare --once consumes the
          // shared stream and starves on stale local-Redis backlog (live, many
          // runs followed this output verbatim into unrelated queued work).
          next: [
            `npm run elections:validate -- --once --ingest-key ${ingestKey}`,
            `npm run elections:write -- --once --ingest-key ${ingestKey}`,
          ],
        },
        null,
        2
      )
    );
  } finally {
    await redis.quit().catch(() => undefined);
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("manual elections inject failed:", message);
    process.exitCode = 1;
  });
}
