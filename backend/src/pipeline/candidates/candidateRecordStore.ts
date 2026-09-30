import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

// Which writer INTRODUCED the record's current (normalized) content. NULL in
// the database means "written before provenance existed"; new writes always
// carry a value — the fields below are required so the compiler forces every
// writer (present and future) to stamp them.
//
// Re-imports of identical content deliberately KEEP the original provenance:
// periodic reruns rediscover the same records, and letting each rerun
// re-stamp them would rotate a poisoned cohort out of its
// `WHERE origin_run_id = ...` cleanup query. Provenance changes only when
// the stored content actually changes.
//
// Kept as a runtime list so the migration test can pin the DB CHECK
// (migrations 197 + 252 + 289) to this union.
export const CANDIDATE_RECORD_ORIGINS = ["ai_enricher", "repair", "manual", "rollcall_import", "travel_import"] as const;
export type CandidateRecordOrigin = (typeof CANDIDATE_RECORD_ORIGINS)[number];

export type CandidateRecordUpsertInput = {
  candidateId: string;
  description: string;
  sourceUrl: string;
  eventDate: string | Date;
  origin: CandidateRecordOrigin;
  // Enricher staging-stream run_id or the manual writer's manual key; null
  // when the enricher message carried no run_id.
  originRunId: string | null;
};

export type CandidateRecordUpsertResult = {
  inserted: number;
  updated: number;
  processed: number;
  recordIdsByIdentityKey: Map<string, string>;
  insertedRecordIds: string[];
};

type ExistingRecordCandidate = {
  id: string;
  description: string;
  record_identity_key: string;
};

// Exported because promotion (promoteResearchData) and the promoted-duplicate
// cleanup must recognize "same record, reworded" with exactly the semantics
// this writer uses — a private copy of the threshold would drift.
export const DESCRIPTION_SIMILARITY_UPDATE_THRESHOLD = 0.86;

function normalizeTextForIdentity(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeUrlForIdentity(value: string): string {
  return value.trim().toLowerCase().replace(/\/+$/g, "");
}

function toEventDateKey(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return trimmed;
  }
  return parsed.toISOString().slice(0, 10);
}

export async function deleteCandidateRecordsForReplacementRefresh(
  client: Pick<PoolClient, "query">,
  candidateId: string
): Promise<{ deletedCount: number }> {
  const trimmedCandidateId = candidateId.trim();
  if (trimmedCandidateId.length === 0) {
    return { deletedCount: 0 };
  }

  // Retired rows survive the refresh: deleting a retirement tombstone would
  // cascade away its notification history and let the next research run
  // recreate the withdrawn claim as active. A refreshed row that re-derives
  // the same claim instead lands on the retired row's identity slot via the
  // upsert's ON CONFLICT and stays hidden (retired_at is never cleared).
  const result = await client.query(
    `
      DELETE FROM public.candidate_records
      WHERE candidate_id = $1
        AND retired_at IS NULL
    `,
    [trimmedCandidateId]
  );

  return { deletedCount: result.rowCount ?? 0 };
}

export type RecordIdentityTransitionReason =
  | "plain_language_rewrite"
  | "event_date_repair"
  | "source_url_repair"
  | "research_refresh"
  | "backfill"
  // Roll-call importer rewrote a hand-written duplicate of the same vote in
  // place (uniform wording + labels); see docs/plans/roll-call-vote-import.md.
  | "rollcall_normalization";

/**
 * Records that an in-place edit moved a row from one identity key to another.
 *
 * Every writer that re-keys a candidate_record MUST call this in the same
 * transaction as the edit. The ledger is what lets research:promote update a
 * mirrored row in place instead of inserting a duplicate sibling, and what
 * lets research:promote:dedupe identify stale old-key rows with provenance
 * instead of similarity guesses — the 2026-08-02 promotion duplicated 817
 * rewritten records on production precisely because no such trace existed.
 *
 * Idempotent: the unique (candidate_id, old, new) constraint absorbs re-runs.
 */
export async function recordIdentityTransition(
  client: Pick<PoolClient, "query">,
  input: {
    candidateId: string;
    oldIdentityKey: string;
    newIdentityKey: string;
    reason: RecordIdentityTransitionReason;
  }
): Promise<void> {
  if (input.oldIdentityKey === input.newIdentityKey) {
    return;
  }
  await client.query(
    `
      INSERT INTO public.candidate_record_identity_transitions
        (candidate_id, old_record_identity_key, new_record_identity_key, reason)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (candidate_id, old_record_identity_key, new_record_identity_key) DO NOTHING
    `,
    [input.candidateId, input.oldIdentityKey, input.newIdentityKey, input.reason]
  );
}

export function buildCandidateRecordIdentityKey(input: {
  description: string;
  sourceUrl: string;
  eventDate: string | Date;
}): string {
  const payload = [
    "v3",
    normalizeUrlForIdentity(input.sourceUrl),
    toEventDateKey(input.eventDate),
    normalizeTextForIdentity(input.description),
  ].join("|");

  return `v3_${createHash("md5").update(payload).digest("hex")}`;
}

function toTokenSet(value: string): Set<string> {
  return new Set(
    normalizeTextForIdentity(value)
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length > 0)
  );
}

export function scoreCandidateRecordDescriptionSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeTextForIdentity(left);
  const normalizedRight = normalizeTextForIdentity(right);
  if (normalizedLeft.length === 0 || normalizedRight.length === 0) {
    return 0;
  }
  if (normalizedLeft === normalizedRight) {
    return 1;
  }

  const leftTokens = toTokenSet(normalizedLeft);
  const rightTokens = toTokenSet(normalizedRight);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let intersectionCount = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersectionCount += 1;
    }
  }

  if (intersectionCount === 0) {
    return 0;
  }

  const precision = intersectionCount / leftTokens.size;
  const recall = intersectionCount / rightTokens.size;
  return (2 * precision * recall) / (precision + recall);
}

export type WithinPayloadRecordCollision = {
  firstIndex: number;
  secondIndex: number;
  eventDate: string;
  sourceUrl: string;
  similarity: number;
};

// Detects payload rows the upsert below would silently merge into ONE stored
// record: same event date, same normalized source URL, and descriptions at or
// above the similarity threshold (or outright identical identity). Live hits:
// adjacent bill numbers (HB 204/HB 205), same-day amendment votes, and an
// initial vote vs its same-day reconsideration all scored >= 0.86 and lost a
// genuinely distinct record. The manual writers refuse such payloads so the
// operator differentiates the descriptions (or splits the source URLs) before
// anything is written.
export function findWithinPayloadRecordCollisions(
  records: readonly { description: string; sourceUrl: string; eventDate: string | Date }[]
): WithinPayloadRecordCollision[] {
  const groups = new Map<string, number[]>();
  records.forEach((record, index) => {
    const key = `${toEventDateKey(record.eventDate)}|${normalizeUrlForIdentity(record.sourceUrl)}`;
    const group = groups.get(key);
    if (group) {
      group.push(index);
    } else {
      groups.set(key, [index]);
    }
  });

  const collisions: WithinPayloadRecordCollision[] = [];
  for (const indexes of groups.values()) {
    if (indexes.length < 2) {
      continue;
    }
    for (let left = 0; left < indexes.length; left += 1) {
      for (let right = left + 1; right < indexes.length; right += 1) {
        const firstIndex = indexes[left]!;
        const secondIndex = indexes[right]!;
        const first = records[firstIndex]!;
        const second = records[secondIndex]!;
        const similarity = scoreCandidateRecordDescriptionSimilarity(
          first.description,
          second.description
        );
        if (similarity >= DESCRIPTION_SIMILARITY_UPDATE_THRESHOLD) {
          collisions.push({
            firstIndex,
            secondIndex,
            eventDate: toEventDateKey(first.eventDate),
            // The normalized form is what actually collided; either row's raw
            // URL alone can read as a mismatch to the operator repairing the
            // other row.
            sourceUrl: normalizeUrlForIdentity(first.sourceUrl),
            similarity,
          });
        }
      }
    }
  }
  return collisions;
}

// ---------------------------------------------------------------------------
// Repeat detection: the same bill or action written again for another session,
// reading, or stage. The similarity dedupe above only merges rows that share
// an event date AND a source URL, so "Filed H.707 ... noncitizen voting" (2019),
// "Filed H.866 ..." (2025) and a first-reading amendment vote re-recorded at
// second reading all survived as separate rows (live: 1,083 such pairs across
// 278 candidates; a DC councilmember's page showed three rows for one bill).
// The skill's rule is one row per bill: fold sessions and stages into one
// description. Bill numbers, years, dates and ordinals are stripped before
// comparison so a re-filed bill with a new number still reads as the same
// action; adjacent DIFFERENT bills keep their distinct substance and pass.
// ---------------------------------------------------------------------------

const REPEAT_STRIP_PATTERNS: readonly RegExp[] = [
  // DC-style "B25-0345", "PR25-0123".
  /\b(?:b|pr|cer|ca)\d{1,2}-\d{3,4}\b/g,
  // "House Bill 4432", "Senate File 12", "Assembly Bill 5", "House Joint Resolution 3".
  /\b(?:house|senate|assembly|council)\s+(?:joint\s+|concurrent\s+)?(?:bill|file|resolution|substitute)\s+(?:no\.?\s*)?\d{1,5}\b/g,
  // "HB 4432", "S.B. 68", "H.R.1470", "HJR 3", "LB 12", "H.3568", "H3983", "S2195", "SSB 1234".
  /\b(?:h|s|a|l|c)\.?\s?(?:b|r|f|j|c|con|cr|jr|s|sb|hb)?\.?\s?\d{1,5}(?:[a-z])?\b/g,
  // Amendment / roll call numbers.
  /\b(?:amendment|amdt|roll\s?call|rc)\s+(?:no\.?\s*)?\d{1,4}\b/g,
  // Calendar dates and years.
  /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:,?\s+(?:19|20)\d\d)?\b/g,
  /\b\d{1,2}\/\d{1,2}\/(?:19|20)?\d\d\b/g,
  /\b(?:19|20)\d\d(?:\s?[-–]\s?(?:19|20)?\d\d)?\b/g,
  // "fiscal 2019", "FY19", "FY 2024-25".
  /\bfy\s?\d{2,4}(?:\s?[-–]\s?\d{2,4})?\b/g,
  // Session / reading / stage words that differ between repeats.
  /\b(?:first|second|third|final)\s+(?:reading|passage|consideration)\b/g,
  /\b(?:regular|special|extraordinary)\s+session\b/g,
  /\b(?:this|last|current|previous|next)\s+(?:session|year|cycle|term)\b/g,
  /\b\d{1,3}(?:st|nd|rd|th)\b/g,
  // Vote tallies "57-52", "8-5".
  /\b\d{1,3}\s?[-–]\s?\d{1,3}\b/g,
];

export function normalizeDescriptionForRepeatDetection(description: string): string {
  let text = description.toLowerCase();
  for (const pattern of REPEAT_STRIP_PATTERNS) {
    text = text.replace(pattern, " ");
  }
  return text
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Two descriptions are repeats when, with identifiers stripped, they are the
// SAME text. Exact equality on purpose: a fuzzy bar (tried at 0.94) also
// caught "voted for" vs "voted against" the same budget in two years and
// "elected chair" vs "elected vice chair", which are different actions. On
// the live corpus exact matching still found 1,076 of 1,362 candidate pairs;
// the reworded remainder is the researcher's call (skill rule), not the
// writer's.
export function isRepeatDescription(left: string, right: string): boolean {
  const a = normalizeDescriptionForRepeatDetection(left);
  const b = normalizeDescriptionForRepeatDetection(right);
  return a.length > 0 && a === b;
}

export type WithinPayloadRepeatRow = {
  firstIndex: number;
  secondIndex: number;
};

// Payload rows that repeat each other across different dates or sources
// (same-date, same-source pairs are the similarity collisions above).
export function findWithinPayloadRepeatRows(
  records: readonly { description: string; sourceUrl: string; eventDate: string | Date }[]
): WithinPayloadRepeatRow[] {
  const repeats: WithinPayloadRepeatRow[] = [];
  for (let first = 0; first < records.length; first += 1) {
    for (let second = first + 1; second < records.length; second += 1) {
      const a = records[first]!;
      const b = records[second]!;
      const sameSlot =
        toEventDateKey(a.eventDate) === toEventDateKey(b.eventDate) &&
        normalizeUrlForIdentity(a.sourceUrl) === normalizeUrlForIdentity(b.sourceUrl);
      if (sameSlot) {
        continue;
      }
      if (isRepeatDescription(a.description, b.description)) {
        repeats.push({ firstIndex: first, secondIndex: second });
      }
    }
  }
  return repeats;
}

export type ExistingRepeatMatch = {
  index: number;
  existingRecordId: string;
  existingEventDate: string;
  existingDescription: string;
};

// Live rows of the same candidate that a payload row would repeat. Excludes
// the row's own identity slot (same date + source) because that is the
// update path, not a repeat.
export async function findRepeatExistingRecords(
  client: Pick<PoolClient, "query">,
  candidateId: string,
  records: readonly { description: string; sourceUrl: string; eventDate: string | Date }[]
): Promise<ExistingRepeatMatch[]> {
  if (records.length === 0) {
    return [];
  }
  const existing = await client.query<{
    id: string;
    description: string;
    source_url: string;
    event_date: string;
  }>(
    `
      SELECT id, description, source_url, to_char(event_date, 'YYYY-MM-DD') AS event_date
      FROM public.candidate_records
      WHERE candidate_id = $1
        AND retired_at IS NULL
    `,
    [candidateId]
  );
  const matches: ExistingRepeatMatch[] = [];
  records.forEach((record, index) => {
    const eventDate = toEventDateKey(record.eventDate);
    const sourceUrl = normalizeUrlForIdentity(record.sourceUrl);
    for (const row of existing.rows) {
      if (row.event_date === eventDate && normalizeUrlForIdentity(row.source_url) === sourceUrl) {
        continue;
      }
      if (isRepeatDescription(record.description, row.description)) {
        matches.push({
          index,
          existingRecordId: row.id,
          existingEventDate: row.event_date,
          existingDescription: row.description,
        });
        break;
      }
    }
  });
  return matches;
}

async function findSimilarExistingRecord(
  client: Pick<PoolClient, "query">,
  input: {
    candidateId: string;
    sourceUrl: string;
    eventDate: string;
    description: string;
  }
): Promise<{ id: string; recordIdentityKey: string; confidence: number } | null> {
  const normalizedSourceUrl = normalizeUrlForIdentity(input.sourceUrl);
  const result = await client.query<ExistingRecordCandidate>(
    `
      SELECT id, description, record_identity_key
      FROM public.candidate_records
      WHERE candidate_id = $1
        AND event_date = $2::date
        AND regexp_replace(lower(btrim(source_url)), '/+$', '') = $3
    `,
    [input.candidateId, input.eventDate, normalizedSourceUrl]
  );

  let best: { id: string; recordIdentityKey: string; confidence: number } | null = null;
  for (const row of result.rows) {
    const confidence = scoreCandidateRecordDescriptionSimilarity(input.description, row.description);
    if (!best || confidence > best.confidence) {
      best = {
        id: row.id,
        recordIdentityKey: row.record_identity_key,
        confidence,
      };
    }
  }

  if (!best || best.confidence < DESCRIPTION_SIMILARITY_UPDATE_THRESHOLD) {
    return null;
  }

  return best;
}

export async function upsertCandidateRecords(
  client: Pick<PoolClient, "query">,
  records: readonly CandidateRecordUpsertInput[]
): Promise<CandidateRecordUpsertResult> {
  let inserted = 0;
  let updated = 0;
  const recordIdsByIdentityKey = new Map<string, string>();
  const insertedRecordIds: string[] = [];

  for (const record of records) {
    const identityKey = buildCandidateRecordIdentityKey({
      description: record.description,
      sourceUrl: record.sourceUrl,
      eventDate: record.eventDate,
    });

    const eventDate = toEventDateKey(record.eventDate);
    const similar = await findSimilarExistingRecord(client, {
      candidateId: record.candidateId,
      sourceUrl: record.sourceUrl,
      eventDate,
      description: record.description,
    });

    if (similar) {
      // Identical normalized content (identity key unchanged) is a no-op
      // re-import: keep the provenance of the writer that introduced the
      // content, so cleanup-by-run queries still find the introducing run
      // after later reruns rediscover the same record. Only a real content
      // change re-attributes the row to the current writer.
      const contentUnchanged = similar.recordIdentityKey === identityKey;
      await client.query(
        `
          UPDATE public.candidate_records
          SET description = $2,
              source_url = $3,
              event_date = $4::date,
              record_identity_key = $5,
              origin = CASE WHEN $8 THEN origin ELSE $6 END,
              origin_run_id = CASE WHEN $8 THEN origin_run_id ELSE $7 END,
              updated_at = now()
          WHERE id = $1
        `,
        [
          similar.id,
          record.description,
          record.sourceUrl,
          eventDate,
          identityKey,
          record.origin,
          record.originRunId,
          contentUnchanged,
        ]
      );
      if (!contentUnchanged) {
        // The row just moved identity slots; leave the trail promotion needs.
        await recordIdentityTransition(client, {
          candidateId: record.candidateId,
          oldIdentityKey: similar.recordIdentityKey,
          newIdentityKey: identityKey,
          reason: "research_refresh",
        });
      }
      recordIdsByIdentityKey.set(identityKey, similar.id);
      updated += 1;
      continue;
    }

    const result = await client.query<{ id: string; inserted: boolean }>(
      `
        INSERT INTO public.candidate_records (
          candidate_id,
          description,
          source_url,
          event_date,
          record_identity_key,
          origin,
          origin_run_id
        )
        VALUES ($1, $2, $3, $4::date, $5, $6, $7)
        ON CONFLICT (candidate_id, record_identity_key)
        DO UPDATE SET
          -- A conflict on the identity key means the normalized content is
          -- identical; origin/origin_run_id deliberately stay untouched so
          -- the introducing run keeps attribution (see CandidateRecordOrigin).
          description = EXCLUDED.description,
          source_url = EXCLUDED.source_url,
          event_date = EXCLUDED.event_date,
          updated_at = now()
        RETURNING id, (xmax = 0) AS inserted
      `,
      [
        record.candidateId,
        record.description,
        record.sourceUrl,
        eventDate,
        identityKey,
        record.origin,
        record.originRunId,
      ]
    );

    const row = result.rows[0];
    if (row?.id) {
      recordIdsByIdentityKey.set(identityKey, row.id);
    }
    if (row?.inserted) {
      inserted += 1;
      if (row.id) {
        insertedRecordIds.push(row.id);
      }
    } else {
      updated += 1;
    }
  }

  return { inserted, updated, processed: records.length, recordIdsByIdentityKey, insertedRecordIds };
}
