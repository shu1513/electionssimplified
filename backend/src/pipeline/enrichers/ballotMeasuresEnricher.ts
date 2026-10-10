import { Pool } from "pg";
import { createClient } from "redis";

import {
  buildBallotMeasureAiConfigFromEnv,
  enrichBallotMeasure,
} from "../../ai/enrichBallotMeasure.js";
import { getPipelineEnv } from "../../config/env.js";
import {
  STAGING_BALLOT_MEASURE_DRAFT_STREAM,
  STAGING_BALLOT_MEASURE_ENRICHER_GROUP,
  STAGING_BALLOT_MEASURE_REJECTED_STREAM,
  STAGING_ITEM_TYPE_BALLOT_MEASURE,
} from "../../config/electionsPipeline.js";
import {
  loadAllowedBallotMeasureResearchAreas,
  upsertBallotMeasureResearchAreaTags,
} from "../ballotMeasures/ballotMeasureResearchAreaTags.js";

type EnricherOptions = {
  once?: boolean;
  batchSize?: number;
  blockMs?: number;
};

type ElectionRow = {
  id: string;
  district_id: string;
  district_name: string;
  district_type: string;
  state: string;
  election_date: string;
  official_ballot_title: string;
  sources: unknown;
};

type BallotMeasureRow = {
  id: string;
  research_area_tags_researched_at: Date | null;
};

const RECLAIM_MIN_IDLE_MS = 240_000;
const RECLAIM_MAX_BATCHES = 20;
const MAX_SEED_URLS = 5;
const MAX_DELIVERY_ATTEMPTS = 8;

function toReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 1000 ? `${message.slice(0, 997)}...` : message;
}

function formatAiFailureWarning(electionId: string, reason: string, failureDebug?: Record<string, unknown>): string {
  if (
    failureDebug?.failure_kind === "tls_certificate_verification" &&
    typeof failureDebug.suggested_operator_action === "string"
  ) {
    return `ballot-measures enricher skipped election_id=${electionId} due to official URL TLS/certificate verification issue; ${failureDebug.suggested_operator_action}`;
  }
  return `ballot-measures enricher skipped election_id=${electionId} due to AI failure: ${reason}`;
}

function parseSeedUrls(sources: unknown): string[] {
  if (!Array.isArray(sources)) {
    return [];
  }
  const urls: string[] = [];
  for (const item of sources) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (trimmed.length === 0) {
      continue;
    }
    urls.push(trimmed);
  }
  return [...new Set(urls)].slice(0, MAX_SEED_URLS);
}

async function ensureConsumerGroup(redis: ReturnType<typeof createClient>): Promise<void> {
  try {
    await redis.xGroupCreate(
      STAGING_BALLOT_MEASURE_DRAFT_STREAM,
      STAGING_BALLOT_MEASURE_ENRICHER_GROUP,
      "0",
      { MKSTREAM: true }
    );
  } catch (error) {
    const message = toReason(error);
    if (!message.includes("BUSYGROUP")) {
      throw error;
    }
  }
}

async function reclaimPendingEntries(
  redis: ReturnType<typeof createClient>,
  consumerName: string,
  batchSize: number
): Promise<Array<{ id: string; message: Record<string, string> }>> {
  const reclaimed: Array<{ id: string; message: Record<string, string> }> = [];
  let cursor = "0-0";

  for (let i = 0; i < RECLAIM_MAX_BATCHES; i += 1) {
    const claim = await redis.xAutoClaim(
      STAGING_BALLOT_MEASURE_DRAFT_STREAM,
      STAGING_BALLOT_MEASURE_ENRICHER_GROUP,
      consumerName,
      RECLAIM_MIN_IDLE_MS,
      cursor,
      { COUNT: batchSize }
    );
    cursor = claim.nextId;
    if (!claim.messages || claim.messages.length === 0) {
      break;
    }

    reclaimed.push(
      ...claim.messages
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .map((entry) => ({ id: entry.id, message: entry.message as Record<string, string> }))
    );
  }

  return reclaimed;
}

async function getDeliveryCount(
  redis: ReturnType<typeof createClient>,
  messageId: string
): Promise<number | null> {
  try {
    const raw = await redis.sendCommand([
      "XPENDING",
      STAGING_BALLOT_MEASURE_DRAFT_STREAM,
      STAGING_BALLOT_MEASURE_ENRICHER_GROUP,
      messageId,
      messageId,
      "1",
    ]);
    if (!Array.isArray(raw) || raw.length === 0) {
      return null;
    }
    const first = raw[0];
    if (!Array.isArray(first) || first.length < 4) {
      return null;
    }
    const deliveriesValue = first[3];
    const deliveries =
      typeof deliveriesValue === "number"
        ? deliveriesValue
        : Number.parseInt(String(deliveriesValue), 10);
    return Number.isFinite(deliveries) ? deliveries : null;
  } catch {
    return null;
  }
}

async function parkMessage(
  redis: ReturnType<typeof createClient>,
  entry: { id: string; message: Record<string, string> },
  reason: string,
  deliveryCount: number | null
): Promise<void> {
  await redis.xAdd(STAGING_BALLOT_MEASURE_REJECTED_STREAM, "*", {
    reason,
    delivery_count: deliveryCount === null ? "" : String(deliveryCount),
    original_stream_id: entry.id,
    election_id: entry.message.election_id ?? "",
    item_type: entry.message.item_type ?? "",
    run_id: entry.message.run_id ?? "",
  });
  await redis.xAck(STAGING_BALLOT_MEASURE_DRAFT_STREAM, STAGING_BALLOT_MEASURE_ENRICHER_GROUP, entry.id);
}

async function getElectionRow(pool: Pool, electionId: string): Promise<ElectionRow | null> {
  const result = await pool.query<ElectionRow>(
    `
      SELECT
        e.id,
        e.district_id,
        d.name AS district_name,
        d.district_type,
        d.state,
        e.election_date::text AS election_date,
        e.official_ballot_title,
        e.sources
      FROM public.elections AS e
      JOIN public.districts AS d
        ON d.id = e.district_id
      WHERE e.id = $1
        AND e.race_type = 'ballot_measure'
      LIMIT 1
    `,
    [electionId]
  );
  return result.rows[0] ?? null;
}

async function getBallotMeasureRow(pool: Pool, electionId: string): Promise<BallotMeasureRow | null> {
  const result = await pool.query<BallotMeasureRow>(
    `
      SELECT id, research_area_tags_researched_at
      FROM public.ballot_measures
      WHERE election_id = $1
      LIMIT 1
    `,
    [electionId]
  );
  return result.rows[0] ?? null;
}

export async function runBallotMeasuresEnricher(options: EnricherOptions = {}): Promise<void> {
  const { once = false, batchSize = 25, blockMs = 5000 } = options;
  const env = getPipelineEnv();
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const redis = createClient({ url: env.REDIS_URL });
  const consumerName = `ballot_measures_enricher_${process.pid}_${Date.now()}`;
  const aiConfig = buildBallotMeasureAiConfigFromEnv();

  try {
    await redis.connect();
    await ensureConsumerGroup(redis);

    const handleEntries = async (entries: Array<{ id: string; message: Record<string, string> }>): Promise<void> => {
      for (const entry of entries) {
        const electionId = entry.message.election_id;
        const itemType = entry.message.item_type;

        try {
          const deliveryCount = await getDeliveryCount(redis, entry.id);
          if (deliveryCount !== null && deliveryCount >= MAX_DELIVERY_ATTEMPTS) {
            await parkMessage(
              redis,
              entry,
              `max delivery attempts exceeded (${MAX_DELIVERY_ATTEMPTS})`,
              deliveryCount
            );
            console.warn(
              `ballot-measures enricher parked stream_id=${entry.id} election_id=${electionId ?? "unknown"} after ${deliveryCount} deliveries`
            );
            continue;
          }

          if (!electionId || itemType !== STAGING_ITEM_TYPE_BALLOT_MEASURE) {
            await redis.xAck(STAGING_BALLOT_MEASURE_DRAFT_STREAM, STAGING_BALLOT_MEASURE_ENRICHER_GROUP, entry.id);
            continue;
          }

          const election = await getElectionRow(pool, electionId);
          if (!election) {
            await redis.xAck(STAGING_BALLOT_MEASURE_DRAFT_STREAM, STAGING_BALLOT_MEASURE_ENRICHER_GROUP, entry.id);
            continue;
          }

          const existingBallotMeasure = await getBallotMeasureRow(pool, electionId);
          if (existingBallotMeasure?.research_area_tags_researched_at) {
            await redis.xAck(STAGING_BALLOT_MEASURE_DRAFT_STREAM, STAGING_BALLOT_MEASURE_ENRICHER_GROUP, entry.id);
            continue;
          }

          const allowedResearchAreas = await loadAllowedBallotMeasureResearchAreas(pool);
          const aiResult = await enrichBallotMeasure(
            {
              districtName: election.district_name,
              districtType: election.district_type,
              state: election.state,
              electionDate: election.election_date,
              officialBallotTitle: election.official_ballot_title,
              seedUrls: parseSeedUrls(election.sources),
              allowedResearchAreaSlugs: allowedResearchAreas.map((area) => area.slug),
            },
            aiConfig
          );

          if (!aiResult.ok) {
            console.warn(formatAiFailureWarning(electionId, aiResult.reason, aiResult.failureDebug));
            // Keep unacked so reclaim can retry later.
            continue;
          }

          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            const measureResult = await client.query<{ id: string }>(
              `
                INSERT INTO public.ballot_measures (
                  district_id,
                  election_id,
                  official_ballot_title,
                  summary,
                  what_yes_means,
                  what_no_means,
                  result,
                  source_url,
                  official_measure_url,
                  last_researched,
                  research_area_tags_researched_at,
                  proposed_by,
                  proposed_by_about,
                  proposed_by_source_url,
                  proposed_by_researched_at
                )
                VALUES (
                  $1, $2, $3, $4, $5, $6, NULL, $7::jsonb, $8, now(), now(),
                  $10, $11, $12, CASE WHEN $9::boolean THEN now() ELSE NULL END
                )
                ON CONFLICT (election_id)
                DO UPDATE SET
                  official_ballot_title = EXCLUDED.official_ballot_title,
                  summary = EXCLUDED.summary,
                  what_yes_means = EXCLUDED.what_yes_means,
                  what_no_means = EXCLUDED.what_no_means,
                  source_url = EXCLUDED.source_url,
                  official_measure_url = EXCLUDED.official_measure_url,
                  last_researched = now(),
                  research_area_tags_researched_at = now(),
                  proposed_by = CASE WHEN $9::boolean THEN EXCLUDED.proposed_by ELSE ballot_measures.proposed_by END,
                  proposed_by_about = CASE WHEN $9::boolean THEN EXCLUDED.proposed_by_about ELSE ballot_measures.proposed_by_about END,
                  proposed_by_source_url = CASE WHEN $9::boolean THEN EXCLUDED.proposed_by_source_url ELSE ballot_measures.proposed_by_source_url END,
                  proposed_by_researched_at = CASE WHEN $9::boolean THEN now() ELSE ballot_measures.proposed_by_researched_at END,
                  updated_at = now()
                RETURNING id
              `,
              [
                election.district_id,
                election.id,
                election.official_ballot_title,
                aiResult.summary,
                aiResult.whatYesMeans,
                aiResult.whatNoMeans,
                JSON.stringify(aiResult.researchUrls),
                aiResult.officialMeasureUrl,
                aiResult.proposedBy !== undefined,
                aiResult.proposedBy?.name ?? null,
                aiResult.proposedBy?.about ?? null,
                aiResult.proposedBy?.source_url ?? null,
              ]
            );
            const ballotMeasureId = measureResult.rows[0]?.id;
            if (!ballotMeasureId) {
              throw new Error(`ballot measure upsert returned no id for election_id=${election.id}`);
            }
            await upsertBallotMeasureResearchAreaTags(
              client,
              ballotMeasureId,
              aiResult.researchAreaTags,
              new Map(allowedResearchAreas.map((area) => [area.slug, area.id]))
            );
            await client.query("COMMIT");
          } catch (error) {
            try {
              await client.query("ROLLBACK");
            } catch {
              // best-effort rollback; original error is more useful
            }
            throw error;
          } finally {
            client.release();
          }

          await redis.xAck(STAGING_BALLOT_MEASURE_DRAFT_STREAM, STAGING_BALLOT_MEASURE_ENRICHER_GROUP, entry.id);
        } catch (error) {
          const reason = toReason(error);
          console.warn(`ballot-measures enricher retrying election_id=${electionId ?? "unknown"}: ${reason}`);
          // Leave unacked; reclaim will retry.
        }
      }
    };

    do {
      const reclaimed = await reclaimPendingEntries(redis, consumerName, batchSize);
      if (reclaimed.length > 0) {
        await handleEntries(reclaimed);
      }

      const batches = await redis.xReadGroup(
        STAGING_BALLOT_MEASURE_ENRICHER_GROUP,
        consumerName,
        [{ key: STAGING_BALLOT_MEASURE_DRAFT_STREAM, id: ">" }],
        { COUNT: batchSize, BLOCK: blockMs }
      );

      if (!batches || batches.length === 0) {
        if (once) {
          break;
        }
        continue;
      }

      for (const batch of batches) {
        await handleEntries(
          batch.messages.map((message) => ({
            id: message.id,
            message: message.message as Record<string, string>,
          }))
        );
      }

      if (once) {
        break;
      }
    } while (true);
  } finally {
    try {
      await redis.quit();
    } catch (error) {
      console.error("ballot-measures enricher cleanup warning (redis.quit):", toReason(error));
    }
    try {
      await pool.end();
    } catch (error) {
      console.error("ballot-measures enricher cleanup warning (pool.end):", toReason(error));
    }
  }
}
