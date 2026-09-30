import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse as parsePostgresConnectionString } from "pg-connection-string";
import { Pool, type PoolClient } from "pg";

import { loadProjectEnv } from "../config/env.js";
import {
  buildCandidateRecordIdentityKey,
  DESCRIPTION_SIMILARITY_UPDATE_THRESHOLD,
  normalizeUrlForIdentity,
  scoreCandidateRecordDescriptionSimilarity,
} from "../pipeline/candidates/candidateRecordStore.js";
import { assertKnownCliFlags } from "./manualCliFlags.js";

// Promotes manually researched rows from the local database to another
// database (production), inserting what is missing and updating what changed.
// Never touches user/account tables, and is safe to re-run: a second
// consecutive run must be a pure no-op.
//
// It never deletes records or labels. The ONE bounded exception is opt-in tag
// reconciliation (--reconcile-tags): for a target record whose local
// counterpart is known by EXACT identity — the same record_identity_key, or
// reached through the identity-transition ledger — area tags the local record
// no longer carries are removed from the target record. Records with no local
// counterpart, and records matched only by the similarity heuristic, are never
// touched. See planTagReconciliation for why that boundary is where it is.
//
// This is deliberately NOT built on the manual research writers. Those are
// correct for research ingestion and wrong for promotion:
//   - candidateRecordStore fuzzy-matches records by description similarity
//     (0.86); promotion identity must be the database's declared natural key.
//   - writeManualCandidateRecords creates follow-notification events; promoted
//     rows are a backfill and must never notify anyone.
//   - the same writer deletes stale tags by record id on every write;
//     promotion only does so by natural key, on request, for exact matches.

/** Connection details safe to print — a DSN carries a password, so never log one. */
export type EndpointFingerprint = {
  host: string;
  port: number;
  database: string;
  user: string;
};

export function describeEndpoint(fingerprint: EndpointFingerprint): string {
  // A URL may omit the user, in which case libpq authenticates as PGUSER or the
  // OS user. Printing a bare "@host" would imply we know the user when we do
  // not, so say so instead. (The confirmation token deliberately does not
  // include the user — see confirmationTokenFor.)
  const user = fingerprint.user.length > 0 ? fingerprint.user : "<environment default>";
  return `${user}@${fingerprint.host}:${fingerprint.port}/${fingerprint.database}`;
}

/**
 * Parses a postgres URL into its effective connection target. Uses
 * pg-connection-string rather than URL parsing alone because libpq accepts a
 * `?host=` parameter that overrides the URL authority — the same reason
 * localDatabaseGuard parses it this way.
 */
export function parseEndpoint(label: string, databaseUrl: string): EndpointFingerprint {
  const trimmed = databaseUrl.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} is required`);
  }

  let protocol: string;
  try {
    protocol = new URL(trimmed).protocol;
  } catch {
    throw new Error(`${label} must be a postgres:// or postgresql:// URL`);
  }
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new Error(`${label} has unsupported protocol ${protocol}`);
  }

  const parsed = parsePostgresConnectionString(trimmed);
  const host = String(parsed.host ?? "").trim().toLowerCase();
  const database = String(parsed.database ?? "").trim();
  if (host.length === 0) {
    throw new Error(`${label} does not name a host`);
  }
  if (database.length === 0) {
    throw new Error(`${label} does not name a database`);
  }

  // pg parses the port with parseInt, so "5432.5" would connect on 5432 while
  // fingerprinting as 5432.5 — the fingerprint must describe the connection
  // that will actually be made, so reject anything that is not an integer.
  // An omitted port comes back as "" from pg-connection-string, not null.
  const suppliedPort = String(parsed.port ?? "").trim();
  const rawPort = suppliedPort.length === 0 ? "5432" : suppliedPort;
  if (!/^\d+$/.test(rawPort)) {
    throw new Error(`${label} has a non-integer port "${rawPort}"`);
  }

  return {
    host,
    port: Number(rawPort),
    database,
    user: String(parsed.user ?? "").trim(),
  };
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLocalHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized.startsWith("/") || LOCAL_HOSTS.has(normalized);
}

export type PromotionEndpoints = {
  source: EndpointFingerprint;
  target: EndpointFingerprint;
};

/**
 * Validates the endpoint pair before any connection is opened.
 *
 * Deliberately does NOT require the target to be remote: rehearsing a
 * promotion against a local scratch database is good practice and is how the
 * integration test runs. The human gate is --confirm-target, not host shape.
 */
export function assertPromotionEndpoints(input: {
  sourceUrl: string;
  targetUrl: string;
  env?: NodeJS.ProcessEnv;
}): PromotionEndpoints {
  const env = input.env ?? process.env;

  // Fail closed. A shell configured to bypass the manual-writer localhost
  // guard must not silently also relax this command, which writes to
  // production by design.
  if (env.ALLOW_REMOTE_DB_WRITES !== undefined && env.ALLOW_REMOTE_DB_WRITES.trim().length > 0) {
    throw new Error(
      "Refusing to run with ALLOW_REMOTE_DB_WRITES set. That variable exists to relax the " +
        "manual-writer localhost guard; this command has its own endpoint checks and must not " +
        "inherit a loosened shell. Unset it and re-run."
    );
  }

  const source = parseEndpoint("source database URL", input.sourceUrl);
  const target = parseEndpoint("target database URL", input.targetUrl);

  if (!isLocalHost(source.host)) {
    throw new Error(
      `Refusing to promote FROM a non-local source (${source.host}). The source is the local ` +
        "research database; promoting out of a remote database is not what this tool does."
    );
  }

  // localhost and 127.0.0.1 name the same server, so compare on a normalised
  // host: without this, promoting localhost/voteapp into 127.0.0.1/voteapp
  // would read and write the same database and could write stale rows back.
  const sameServer = (a: EndpointFingerprint, b: EndpointFingerprint): boolean =>
    (isLocalHost(a.host) && isLocalHost(b.host) ? true : a.host === b.host) && a.port === b.port;

  if (sameServer(source, target) && source.database === target.database) {
    throw new Error(
      `Refusing to promote a database into itself (${describeEndpoint(source)}).`
    );
  }

  return { source, target };
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/**
 * A row's classification against the target. `unchanged` rows must issue no
 * UPDATE at all: both record tables carry an updated_at trigger, so an
 * unconditional ON CONFLICT DO UPDATE would rewrite every row on every run and
 * destroy the "second run is a no-op" property this tool is built around.
 */
export type RowPlan<T> = {
  inserts: T[];
  updates: T[];
  unchangedCount: number;
  /**
   * Rows present on the target and absent from source. Reported, never
   * deleted — except area tags of an exactly-matched record under
   * --reconcile-tags (see planTagReconciliation).
   */
  targetOnlyCount: number;
  /**
   * The target-only rows themselves, not just their count: record promotion
   * matches them against planned inserts to recognize a locally re-keyed row
   * (see planRecordRekeys) instead of inserting a duplicate sibling.
   */
  targetOnlyRows: T[];
};

export function planRows<T>(input: {
  sourceRows: readonly T[];
  targetRows: readonly T[];
  keyOf: (row: T) => string;
  isEqual: (source: T, target: T) => boolean;
}): RowPlan<T> {
  const targetByKey = new Map<string, T>();
  for (const row of input.targetRows) {
    targetByKey.set(input.keyOf(row), row);
  }

  const inserts: T[] = [];
  const updates: T[] = [];
  let unchangedCount = 0;
  const seenSourceKeys = new Set<string>();

  for (const sourceRow of input.sourceRows) {
    const key = input.keyOf(sourceRow);
    seenSourceKeys.add(key);
    const targetRow = targetByKey.get(key);
    if (targetRow === undefined) {
      inserts.push(sourceRow);
    } else if (input.isEqual(sourceRow, targetRow)) {
      unchangedCount += 1;
    } else {
      updates.push(sourceRow);
    }
  }

  const targetOnlyRows: T[] = [];
  for (const [key, row] of targetByKey.entries()) {
    if (!seenSourceKeys.has(key)) {
      targetOnlyRows.push(row);
    }
  }

  return { inserts, updates, unchangedCount, targetOnlyCount: targetOnlyRows.length, targetOnlyRows };
}

/** Null-safe scalar comparison, mirroring SQL's IS DISTINCT FROM. */
export function sameScalar(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

/** Order-sensitive array comparison — source_urls is an ordered evidence list. */
export function sameStringArray(a: readonly string[] | null, b: readonly string[] | null): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

// ---------------------------------------------------------------------------
// Projections
//
// The same query runs against both databases, so source and target rows are
// directly comparable. Every date and timestamp is rendered with an explicit
// to_char format rather than ::text, because ::text honours the session's
// DateStyle: under DateStyle='SQL, DMY' the same row projects as "08/06/2022"
// instead of "2022-06-08" (verified). Two servers with different DateStyle
// settings would then see a false diff AND write each other's dates back with
// the day and month swapped. to_char is style-independent.
//
// researched_at is additionally rendered AT TIME ZONE 'UTC' so differing
// session timezones cannot produce a false diff either; microsecond precision
// is preserved by the .US format.
// ---------------------------------------------------------------------------

export type PromotionClient = {
  query: (text: string, values?: readonly unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
};

export type RecordRow = {
  candidate_id: string;
  record_identity_key: string;
  description: string;
  source_url: string;
  event_date: string;
  /**
   * Carried because it is reader-visible, not just bookkeeping: the candidate
   * page renders it as "researched {date}" (SourceLine), the detail reader
   * sorts on it, and candidateRecordSourceAudit uses it for newly-seen-domain
   * timing. Letting the target default it to now() would restamp every
   * promoted record with the promotion date and falsify all three.
   */
  created_at_utc: string;
  origin: string | null;
  origin_run_id: string | null;
  /**
   * Retirement travels with the record. A row folded, retired as a position
   * statement, or retired as unverifiable locally must stop rendering in
   * production too; before this the promoter never carried retired_at, so a
   * local retirement left the production row live (2026-09-30 fact-check
   * sweep: 1,100+ retirements).
   */
  retired_at_utc: string | null;
  retired_reason: string | null;
};

export type TagRow = {
  candidate_id: string;
  record_identity_key: string;
  research_area_slug: string;
  stance: string | null;
};

export type LabelRow = {
  source: string;
  committee_id: string;
  cycle: number;
  committee_name: string;
  label: string;
  source_urls: string[];
  researched_at_utc: string;
  /** Shape guards — see assertTransportableArrays. */
  source_urls_ndims: number | null;
  source_urls_lower: number | null;
};

/**
 * source_urls is transported as JSON, which can only faithfully carry a
 * one-dimensional, one-based array. Postgres permits multidimensional and
 * non-one-based arrays, and JSON round-tripping one would silently flatten it
 * into a single text element that looks like JSON. No such row exists today
 * (verified: 0 of 92), so this is a guard against a future writer rather than
 * a live defect — but it aborts instead of corrupting.
 */
export function assertTransportableArrays(rows: readonly LabelRow[]): void {
  const bad = rows.filter(
    (row) => (row.source_urls_ndims ?? 1) !== 1 || (row.source_urls_lower ?? 1) !== 1
  );
  if (bad.length > 0) {
    const shown = bad.slice(0, 5).map((row) => labelKey(row)).join(", ");
    throw new Error(
      `Refusing to promote ${bad.length} finance_committee_labels row(s) whose source_urls is not a ` +
        `one-dimensional, one-based array; JSON transport would silently flatten it. Keys: ${shown}`
    );
  }
}

export const RECORD_PROJECTION_SQL = `
  SELECT
    candidate_id::text AS candidate_id,
    record_identity_key,
    description,
    source_url,
    to_char(event_date, 'YYYY-MM-DD') AS event_date,
    to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS created_at_utc,
    origin,
    origin_run_id,
    to_char(retired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS retired_at_utc,
    retired_reason
  FROM public.candidate_records
`;

// Tags are carried by logical reference — candidate + record identity key +
// area slug — never by candidate_record_id. A record that exists on both sides
// can hold a different id on the target, so a transported id would attach the
// tag to the wrong record or to nothing.
export const TAG_PROJECTION_SQL = `
  SELECT
    r.candidate_id::text AS candidate_id,
    r.record_identity_key,
    a.slug AS research_area_slug,
    t.stance
  FROM public.candidate_record_area_tags AS t
  JOIN public.candidate_records AS r ON r.id = t.candidate_record_id
  JOIN public.research_areas AS a ON a.id = t.research_area_id
`;

export const LABEL_PROJECTION_SQL = `
  SELECT
    source,
    committee_id,
    cycle,
    committee_name,
    label,
    source_urls,
    to_char(researched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS researched_at_utc,
    array_ndims(source_urls) AS source_urls_ndims,
    array_lower(source_urls, 1) AS source_urls_lower
  FROM public.finance_committee_labels
`;

const KEY_SEPARATOR = "\u0000";

export function recordKey(row: Pick<RecordRow, "candidate_id" | "record_identity_key">): string {
  return [row.candidate_id, row.record_identity_key].join(KEY_SEPARATOR);
}

export function tagKey(row: Pick<TagRow, "candidate_id" | "record_identity_key" | "research_area_slug">): string {
  return [row.candidate_id, row.record_identity_key, row.research_area_slug].join(KEY_SEPARATOR);
}

export function labelKey(row: Pick<LabelRow, "source" | "committee_id" | "cycle">): string {
  return [row.source, row.committee_id, String(row.cycle)].join(KEY_SEPARATOR);
}

/**
 * Content equality for a record. Provenance (origin, origin_run_id) is
 * deliberately excluded: it rides along on an update, but a difference in it
 * alone must not trigger one, or promoting rows whose local pipeline metadata
 * differs would rewrite target history for no reader-visible gain.
 *
 * created_at is likewise excluded, and must stay excluded: the upsert never
 * updates it, so comparing it would mark a row changed on every single run and
 * fire a no-op UPDATE forever — destroying idempotency without changing data.
 *
 * Note this update path is narrow by construction — record_identity_key is
 * derived from the normalised description, URL and date, so an update only
 * fires when the raw text differs while normalising to the same key.
 */
export function sameRecord(a: RecordRow, b: RecordRow): boolean {
  return (
    sameScalar(a.description, b.description) &&
    sameScalar(a.source_url, b.source_url) &&
    sameScalar(a.event_date, b.event_date) &&
    sameScalar(a.retired_at_utc ?? null, b.retired_at_utc ?? null) &&
    sameScalar(a.retired_reason ?? null, b.retired_reason ?? null)
  );
}

export function sameTag(a: TagRow, b: TagRow): boolean {
  return sameScalar(a.stance, b.stance);
}

// ---------------------------------------------------------------------------
// Re-keyed rows
//
// record_identity_key hashes (description, url, date), so any sanctioned local
// edit of a promoted row's description — the plain-language rewrite is the
// live example — gives it a NEW key. A pure key-based diff then classifies the
// edited row as an insert and the target's old-key row as target-only, and the
// "never deletes" rule keeps that old row forever: the reader sees the same
// fact twice, in two phrasings (817 rewrites were exposed to exactly this in
// the 2026-08-02 promotion). The planner below closes the gap by re-attaching
// a planned insert to the target-only row it re-keys, using the SAME identity
// semantics as the ingest writer (candidate + event date + normalized URL +
// description similarity >= the writer's own update threshold), so the row is
// updated in place instead of duplicated.
// ---------------------------------------------------------------------------

export type TransitionRow = {
  candidate_id: string;
  old_record_identity_key: string;
  new_record_identity_key: string;
  /** Orders multi-successor histories; see resolveIdentityTransitions. */
  created_at_utc: string;
  /** Tiebreak for same-timestamp rows — arbitrary but deterministic. */
  id: string;
};

export const TRANSITION_PROJECTION_SQL = `
  SELECT
    id::text AS id,
    candidate_id::text AS candidate_id,
    old_record_identity_key,
    new_record_identity_key,
    to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS created_at_utc
  FROM public.candidate_record_identity_transitions
`;

/**
 * Flattens the transition ledger into old-key -> TERMINAL-key, following
 * chains (a row rewritten, then date-repaired, holds neither intermediate
 * key). A cycle — impossible unless the ledger is hand-corrupted — resolves
 * to the last key before the repeat rather than looping.
 *
 * The unique constraint is on the (candidate, old, new) TRIPLE, so an
 * edit -> revert -> re-edit history legally leaves one old key with several
 * successors (k1->k2, k2->k1, k1->k3). Only the NEWEST edit describes where
 * the row actually went, so rows are ordered here — by created_at, then id
 * for same-timestamp determinism — and the map keeps the last write. Sorting
 * inside the function (not in the SQL) makes resolution deterministic no
 * matter how the caller obtained the rows.
 */
export function resolveIdentityTransitions(rows: readonly TransitionRow[]): Map<string, string> {
  const ordered = [...rows].sort(
    (a, b) =>
      a.created_at_utc.localeCompare(b.created_at_utc) || a.id.localeCompare(b.id)
  );
  const direct = new Map<string, string>();
  for (const row of ordered) {
    direct.set([row.candidate_id, row.old_record_identity_key].join(KEY_SEPARATOR), row.new_record_identity_key);
  }
  const resolved = new Map<string, string>();
  for (const row of ordered) {
    const start = [row.candidate_id, row.old_record_identity_key].join(KEY_SEPARATOR);
    const seen = new Set<string>([row.old_record_identity_key]);
    // Walk from the NEWEST successor (the direct map), never from this row's
    // own — a superseded row (k1->k2 after a later k1->k3) must resolve the
    // same way as its newer sibling, or iteration order would decide.
    let current = direct.get(start)!;
    for (;;) {
      const next = direct.get([row.candidate_id, current].join(KEY_SEPARATOR));
      if (next === undefined || seen.has(next)) {
        break;
      }
      seen.add(next);
      current = next;
    }
    resolved.set(start, current);
  }
  return resolved;
}

export type RecordRekey = {
  /** The local row, carrying the new key and the new content. */
  sourceRow: RecordRow;
  /** The key the target row currently holds — how the UPDATE addresses it. */
  oldKey: string;
  /**
   * How the pair was matched: 'transition' is exact provenance from the
   * identity ledger; 'similarity' is the ingest writer's same-slot heuristic,
   * kept as a backstop for edits made before the ledger existed.
   */
  via: "transition" | "similarity";
};

export type RecordRekeyPlan = {
  rekeys: RecordRekey[];
  /** Planned inserts that matched no target-only row; still genuinely new. */
  inserts: RecordRow[];
  /**
   * Target-only rows that look like a re-DATED copy of a planned insert (same
   * candidate + URL, similar description, different event date). Reported for
   * manual review, never auto-merged: two real records legitimately share a
   * candidate and URL across dates (two votes on one meeting document), and
   * similarity alone cannot tell a date repair from that.
   */
  redatedSuspects: { sourceRow: RecordRow; targetRow: RecordRow; similarity: number }[];
};

export function planRecordRekeys(input: {
  inserts: readonly RecordRow[];
  targetOnlyRows: readonly RecordRow[];
  normalizeUrl: (url: string) => string;
  similarityOf: (left: string, right: string) => number;
  threshold: number;
  /** Chain-resolved ledger from resolveIdentityTransitions; empty disables the exact pass. */
  transitions?: ReadonlyMap<string, string>;
}): RecordRekeyPlan {
  const transitions = input.transitions ?? new Map<string, string>();
  const exactBucketOf = (row: RecordRow): string =>
    [row.candidate_id, row.event_date, input.normalizeUrl(row.source_url)].join(KEY_SEPARATOR);
  const urlBucketOf = (row: RecordRow): string =>
    [row.candidate_id, input.normalizeUrl(row.source_url)].join(KEY_SEPARATOR);

  const rekeys: RecordRekey[] = [];
  const inserts: RecordRow[] = [];
  const redatedSuspects: RecordRekeyPlan["redatedSuspects"] = [];
  // A target row may be re-keyed by at most one insert. Two inserts claiming
  // the same row means local research holds two similar records for one
  // target slot — resolving that by similarity rank would silently guess
  // which one is "the" successor, so refuse instead.
  const claimedBy = new Map<string, string>();

  // Exact pass first: the ledger says precisely which old key became which
  // new key, with no date/URL/similarity conditions — it survives edits the
  // heuristic below cannot see (a rewrite that rephrased beyond the
  // similarity threshold, a repair that changed the date or URL itself).
  const insertByCandKey = new Map(input.inserts.map((row) => [recordKey(row), row]));
  const rekeyedSourceKeys = new Set<string>();
  const rekeyedTargetKeys = new Set<string>();
  for (const targetRow of input.targetOnlyRows) {
    const finalKey = transitions.get(recordKey(targetRow));
    if (finalKey === undefined) {
      continue;
    }
    const sourceRow = insertByCandKey.get([targetRow.candidate_id, finalKey].join(KEY_SEPARATOR));
    if (sourceRow === undefined) {
      continue;
    }
    const claimKey = [targetRow.candidate_id, finalKey].join(KEY_SEPARATOR);
    const claimant = claimedBy.get(claimKey);
    if (claimant !== undefined) {
      throw new Error(
        `Refusing to promote: target rows ${claimant} and ${targetRow.record_identity_key} both ` +
          `transition to local key ${finalKey} (candidate ${targetRow.candidate_id}); the ledger ` +
          "maps two target rows onto one local record. Clean the target up with " +
          "research:promote:dedupe first."
      );
    }
    claimedBy.set(claimKey, targetRow.record_identity_key);
    rekeys.push({ sourceRow, oldKey: targetRow.record_identity_key, via: "transition" });
    rekeyedSourceKeys.add(recordKey(sourceRow));
    rekeyedTargetKeys.add(recordKey(targetRow));
  }

  const exactBuckets = new Map<string, RecordRow[]>();
  const urlBuckets = new Map<string, RecordRow[]>();
  for (const row of input.targetOnlyRows) {
    if (rekeyedTargetKeys.has(recordKey(row))) {
      continue;
    }
    const exact = exactBucketOf(row);
    exactBuckets.set(exact, [...(exactBuckets.get(exact) ?? []), row]);
    const byUrl = urlBucketOf(row);
    urlBuckets.set(byUrl, [...(urlBuckets.get(byUrl) ?? []), row]);
  }

  for (const sourceRow of input.inserts) {
    if (rekeyedSourceKeys.has(recordKey(sourceRow))) {
      continue;
    }
    const bucket = exactBuckets.get(exactBucketOf(sourceRow)) ?? [];
    let best: { row: RecordRow; similarity: number } | null = null;
    let runnerUpSimilarity = 0;
    for (const targetRow of bucket) {
      const similarity = input.similarityOf(sourceRow.description, targetRow.description);
      if (best === null || similarity > best.similarity) {
        runnerUpSimilarity = best?.similarity ?? 0;
        best = { row: targetRow, similarity };
      } else if (similarity > runnerUpSimilarity) {
        runnerUpSimilarity = similarity;
      }
    }

    if (best !== null && best.similarity >= input.threshold) {
      if (runnerUpSimilarity >= input.threshold) {
        throw new Error(
          `Refusing to promote: two target rows for candidate ${sourceRow.candidate_id} on ` +
            `${sourceRow.event_date} both match one local record above the similarity threshold; ` +
            "cannot tell which the local edit re-keyed. Repair the target rows first."
        );
      }
      const claimKey = [best.row.candidate_id, best.row.record_identity_key].join(KEY_SEPARATOR);
      const claimant = claimedBy.get(claimKey);
      if (claimant !== undefined) {
        throw new Error(
          `Refusing to promote: two local records (${claimant} and ${sourceRow.record_identity_key}) ` +
            `both match the same target row for candidate ${sourceRow.candidate_id} on ` +
            `${sourceRow.event_date}. Deduplicate the local rows first.`
        );
      }
      claimedBy.set(claimKey, sourceRow.record_identity_key);
      rekeys.push({ sourceRow, oldKey: best.row.record_identity_key, via: "similarity" });
      continue;
    }

    for (const targetRow of urlBuckets.get(urlBucketOf(sourceRow)) ?? []) {
      if (targetRow.event_date === sourceRow.event_date) {
        continue; // the exact bucket already judged this row
      }
      const similarity = input.similarityOf(sourceRow.description, targetRow.description);
      if (similarity >= input.threshold) {
        redatedSuspects.push({ sourceRow, targetRow, similarity });
      }
    }
    inserts.push(sourceRow);
  }

  return { rekeys, inserts, redatedSuspects };
}

/**
 * Moves a target row onto its new identity in place. Addressed by the OLD
 * key, so the row keeps its id — and with it its tags and notification
 * events. created_at is untouched for the same reason it is absent from
 * UPSERT_RECORDS_SQL's update list. No distinctness guard: a planned rekey
 * changes the key by construction, so the row always really changes.
 *
 * Provenance is copied unconditionally, and that is NOT the ingest writer's
 * keep-on-no-op rule being skipped: that rule exists for re-imports of
 * IDENTICAL normalized content, and a rekey can never be one — the keys
 * differ, and the key IS the normalized (description, url, date). Every
 * rekey is therefore a real content change, where UPSERT_RECORDS_SQL's DO
 * UPDATE also copies the source row's provenance. The local edits that
 * cause rekeys (plain-language rewrite, URL/date repairs) deliberately do
 * not re-stamp origin locally, so what is copied is still the introducing
 * run's attribution — preserved, not rotated.
 */
export const REKEY_RECORDS_SQL = `
  UPDATE public.candidate_records AS t
  SET
    record_identity_key = s.record_identity_key,
    description = s.description,
    source_url = s.source_url,
    event_date = s.event_date::date,
    origin = s.origin,
    origin_run_id = s.origin_run_id,
    retired_at = CASE WHEN s.retired_at_utc IS NULL THEN NULL ELSE (s.retired_at_utc)::timestamp AT TIME ZONE 'UTC' END,
    retired_reason = s.retired_reason
  FROM jsonb_to_recordset($1::jsonb) AS s(
    candidate_id uuid, old_key text, record_identity_key text, description text,
    source_url text, event_date text, origin text, origin_run_id text,
    retired_at_utc text, retired_reason text)
  WHERE t.candidate_id = s.candidate_id
    AND t.record_identity_key = s.old_key
`;

/** Rekey rows in the wire shape REKEY_RECORDS_SQL expects. */
export function rekeyWireRows(rekeys: readonly RecordRekey[]): Record<string, unknown>[] {
  return rekeys.map((rekey) => ({
    candidate_id: rekey.sourceRow.candidate_id,
    old_key: rekey.oldKey,
    record_identity_key: rekey.sourceRow.record_identity_key,
    description: rekey.sourceRow.description,
    source_url: rekey.sourceRow.source_url,
    event_date: rekey.sourceRow.event_date,
    origin: rekey.sourceRow.origin,
    origin_run_id: rekey.sourceRow.origin_run_id,
    // A row edited AND retired locally is rekeyed, not upserted, so the
    // rekey must carry the retirement too or the target row stays live.
    retired_at_utc: rekey.sourceRow.retired_at_utc ?? null,
    retired_reason: rekey.sourceRow.retired_reason ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Tag reconciliation
//
// Every local writer that replaces a record's tag set — the manual records
// writer's stale-tag delete, manual:records:untag, the roll-call importer's
// per-side sync — deletes locally, and the upsert-only promotion then leaves
// the removed tag on the target forever: the candidate page keeps rendering a
// stance chip that local research withdrew (production carried ~2,507 such
// target-only tags on 2026-08-23). Nothing in production writes these tables,
// so a target-only tag on a record that local still holds is stale by
// construction, not a production-side correction.
//
// The boundary is exact identity, and deliberately no wider. A target tag is
// reconcilable only when its record's local counterpart is certain: the same
// (candidate, record_identity_key) exists locally, or the record is being
// rekeyed in this run through the transition ledger (the ledger is exact
// provenance, so the tag is re-addressed to the new key and judged there).
// A record matched only by the similarity heuristic is skipped: the heuristic
// is good enough to avoid inserting a duplicate, but not good enough to
// justify deleting data on its say-so. A target-only record is skipped too —
// it is either a stale duplicate (research:promote:dedupe's job, which removes
// its tags by cascade) or something local never held, and promotion must not
// guess which.
// ---------------------------------------------------------------------------

export type TagRemoval = {
  candidate_id: string;
  /**
   * The key the target record holds when the DELETE runs: its current key, or
   * — for a record rekeyed in the same transaction — the rekey's NEW key.
   * Rekeys are written first, so the delete always addresses the final key.
   */
  record_identity_key: string;
  research_area_slug: string;
};

export type TagReconciliationRecord = {
  candidate_id: string;
  /** The key the target record held when the plan was computed. */
  target_record_identity_key: string;
  /** The local record's key; equals the target key unless matched via the ledger. */
  local_record_identity_key: string;
  matched_via: "same_key" | "transition";
  /** Slugs the target holds and the local record no longer does — to be removed. */
  remove: string[];
  /** Slugs the local record still carries, for the operator's context. */
  keep: string[];
};

export type TagReconciliationPlan = {
  /** One entry per affected record, ordered by candidate then key. */
  records: TagReconciliationRecord[];
  /** The flat wire rows for RECONCILE_TAGS_DELETE_SQL, one per removed tag. */
  removals: TagRemoval[];
  /** Target-only tags left alone, by reason. */
  skipped: {
    /** The target record has no local counterpart at all. */
    noLocalRecord: number;
    /** The target record is matched only by the similarity heuristic. */
    similarityRekeyOnly: number;
    /**
     * The record is being rekeyed and the local record still carries this tag
     * under its new key: the tag survives the rekey and is a planned upsert,
     * not a removal. Counted so the numbers add up, never acted on.
     */
    carriedByRekey: number;
  };
};

export function planTagReconciliation(input: {
  targetOnlyTags: readonly TagRow[];
  sourceTags: readonly TagRow[];
  sourceRecords: readonly RecordRow[];
  rekeys: readonly RecordRekey[];
}): TagReconciliationPlan {
  const sourceRecordKeys = new Set(input.sourceRecords.map(recordKey));
  const sourceTagKeys = new Set(input.sourceTags.map(tagKey));
  const sourceSlugsByRecord = new Map<string, string[]>();
  for (const tag of input.sourceTags) {
    const key = recordKey(tag);
    sourceSlugsByRecord.set(key, [...(sourceSlugsByRecord.get(key) ?? []), tag.research_area_slug]);
  }
  const newKeyByTransitionedOldKey = new Map<string, string>();
  const similarityOldKeys = new Set<string>();
  for (const rekey of input.rekeys) {
    const oldKey = [rekey.sourceRow.candidate_id, rekey.oldKey].join(KEY_SEPARATOR);
    if (rekey.via === "transition") {
      newKeyByTransitionedOldKey.set(oldKey, rekey.sourceRow.record_identity_key);
    } else {
      similarityOldKeys.add(oldKey);
    }
  }

  const skipped = { noLocalRecord: 0, similarityRekeyOnly: 0, carriedByRekey: 0 };
  const byRecord = new Map<string, TagReconciliationRecord>();
  for (const tag of input.targetOnlyTags) {
    const targetRecordKey = recordKey(tag);
    let localKey: string;
    let via: TagReconciliationRecord["matched_via"];
    if (sourceRecordKeys.has(targetRecordKey)) {
      localKey = tag.record_identity_key;
      via = "same_key";
    } else {
      const transitioned = newKeyByTransitionedOldKey.get(targetRecordKey);
      if (transitioned !== undefined) {
        localKey = transitioned;
        via = "transition";
      } else if (similarityOldKeys.has(targetRecordKey)) {
        skipped.similarityRekeyOnly += 1;
        continue;
      } else {
        skipped.noLocalRecord += 1;
        continue;
      }
    }

    const localRecordKey = [tag.candidate_id, localKey].join(KEY_SEPARATOR);
    if (sourceTagKeys.has([localRecordKey, tag.research_area_slug].join(KEY_SEPARATOR))) {
      // Only reachable via a rekey: under the same key the tag would not have
      // been target-only in the first place.
      skipped.carriedByRekey += 1;
      continue;
    }

    const entry = byRecord.get(targetRecordKey) ?? {
      candidate_id: tag.candidate_id,
      target_record_identity_key: tag.record_identity_key,
      local_record_identity_key: localKey,
      matched_via: via,
      remove: [],
      keep: [...(sourceSlugsByRecord.get(localRecordKey) ?? [])].sort(),
    };
    entry.remove.push(tag.research_area_slug);
    byRecord.set(targetRecordKey, entry);
  }

  const records = [...byRecord.values()]
    .map((entry) => ({ ...entry, remove: [...entry.remove].sort() }))
    .sort(
      (a, b) =>
        a.candidate_id.localeCompare(b.candidate_id) ||
        a.target_record_identity_key.localeCompare(b.target_record_identity_key)
    );
  const removals: TagRemoval[] = records.flatMap((entry) =>
    entry.remove.map((slug) => ({
      candidate_id: entry.candidate_id,
      record_identity_key: entry.local_record_identity_key,
      research_area_slug: slug,
    }))
  );
  return { records, removals, skipped };
}

/**
 * The only statement in this file that removes anything, and it removes only
 * area tags. Parents are resolved on the target by natural key at write time
 * — the same two joins UPSERT_TAGS_SQL uses, for the same reason: a record id
 * never crosses the wire. A wire row whose record or slug does not resolve
 * deletes nothing, which the apply path treats as drift and refuses to commit.
 */
export const RECONCILE_TAGS_DELETE_SQL = `
  DELETE FROM public.candidate_record_area_tags AS t
  USING
    jsonb_to_recordset($1::jsonb) AS s(
      candidate_id uuid, record_identity_key text, research_area_slug text),
    public.candidate_records AS r,
    public.research_areas AS a
  WHERE r.candidate_id = s.candidate_id
    AND r.record_identity_key = s.record_identity_key
    AND a.slug = s.research_area_slug
    AND t.candidate_record_id = r.id
    AND t.research_area_id = a.id
`;

export function sameLabel(a: LabelRow, b: LabelRow): boolean {
  return (
    sameScalar(a.committee_name, b.committee_name) &&
    sameScalar(a.label, b.label) &&
    sameStringArray(a.source_urls, b.source_urls) &&
    sameScalar(a.researched_at_utc, b.researched_at_utc)
  );
}

export async function loadProjection<T>(client: PromotionClient, sql: string): Promise<T[]> {
  const result = await client.query(sql);
  return result.rows as T[];
}

// ---------------------------------------------------------------------------
// Upserts
//
// Every statement below is an INSERT with a conditional ON CONFLICT DO UPDATE.
// There is no TRUNCATE or DDL anywhere in this file, and the only DELETE is
// RECONCILE_TAGS_DELETE_SQL above — opt-in, tags only, exact matches only. A
// test asserts exactly that, because "never deletes beyond that one bounded
// case" is the property that makes this tool safe to point at production.
//
// The DO UPDATE ... WHERE clause is load-bearing, not defensive noise: both
// record tables have an updated_at trigger, so an unconditional update would
// rewrite every row on every run and the second-run-is-a-no-op guarantee would
// be false.
// ---------------------------------------------------------------------------

// created_at is carried on INSERT so a promoted record keeps the date it was
// actually researched — it is displayed to readers as "researched {date}" and
// drives source audits. It is deliberately absent from the DO UPDATE list: an
// existing target row keeps its own created_at, which is why a differing
// created_at alone must never count as a content change (see sameRecord).
export const UPSERT_RECORDS_SQL = `
  INSERT INTO public.candidate_records
    (candidate_id, record_identity_key, description, source_url, event_date,
     created_at, origin, origin_run_id, retired_at, retired_reason)
  SELECT
    s.candidate_id, s.record_identity_key, s.description, s.source_url,
    s.event_date::date,
    (s.created_at_utc)::timestamp AT TIME ZONE 'UTC',
    s.origin, s.origin_run_id,
    CASE WHEN s.retired_at_utc IS NULL THEN NULL ELSE (s.retired_at_utc)::timestamp AT TIME ZONE 'UTC' END,
    s.retired_reason
  FROM jsonb_to_recordset($1::jsonb) AS s(
    candidate_id uuid, record_identity_key text, description text,
    source_url text, event_date text, created_at_utc text,
    origin text, origin_run_id text, retired_at_utc text, retired_reason text)
  ON CONFLICT (candidate_id, record_identity_key) DO UPDATE SET
    description = EXCLUDED.description,
    source_url = EXCLUDED.source_url,
    event_date = EXCLUDED.event_date,
    origin = EXCLUDED.origin,
    origin_run_id = EXCLUDED.origin_run_id,
    retired_at = EXCLUDED.retired_at,
    retired_reason = EXCLUDED.retired_reason
  WHERE public.candidate_records.description IS DISTINCT FROM EXCLUDED.description
     OR public.candidate_records.source_url IS DISTINCT FROM EXCLUDED.source_url
     OR public.candidate_records.event_date IS DISTINCT FROM EXCLUDED.event_date
     OR public.candidate_records.retired_at IS DISTINCT FROM EXCLUDED.retired_at
     OR public.candidate_records.retired_reason IS DISTINCT FROM EXCLUDED.retired_reason
`;

// The two joins are the fix for the central hazard: they resolve the TARGET's
// record id and research-area id at write time, so a tag never carries a
// source id across the wire. A row whose parents do not resolve is dropped by
// the join, which is why preflight must prove resolvability first.
export const UPSERT_TAGS_SQL = `
  INSERT INTO public.candidate_record_area_tags (candidate_record_id, research_area_id, stance)
  SELECT r.id, a.id, s.stance
  FROM jsonb_to_recordset($1::jsonb) AS s(
    candidate_id uuid, record_identity_key text, research_area_slug text, stance text)
  JOIN public.candidate_records AS r
    ON r.candidate_id = s.candidate_id
   AND r.record_identity_key = s.record_identity_key
  JOIN public.research_areas AS a ON a.slug = s.research_area_slug
  ON CONFLICT (candidate_record_id, research_area_id) DO UPDATE SET
    stance = EXCLUDED.stance
  WHERE public.candidate_record_area_tags.stance IS DISTINCT FROM EXCLUDED.stance
`;

// researched_at is copied verbatim, never set to now(): it is research
// provenance the reader sees, and rewriting it would both falsify history and
// make every run look changed.
export const UPSERT_LABELS_SQL = `
  INSERT INTO public.finance_committee_labels
    (source, committee_id, cycle, committee_name, label, source_urls, researched_at)
  SELECT
    s.source, s.committee_id, s.cycle, s.committee_name, s.label,
    ARRAY(SELECT jsonb_array_elements_text(s.source_urls)),
    (s.researched_at_utc)::timestamp AT TIME ZONE 'UTC'
  FROM jsonb_to_recordset($1::jsonb) AS s(
    source text, committee_id text, cycle int, committee_name text,
    label text, source_urls jsonb, researched_at_utc text)
  ON CONFLICT (source, committee_id, cycle) DO UPDATE SET
    committee_name = EXCLUDED.committee_name,
    label = EXCLUDED.label,
    source_urls = EXCLUDED.source_urls,
    researched_at = EXCLUDED.researched_at
  WHERE public.finance_committee_labels.committee_name IS DISTINCT FROM EXCLUDED.committee_name
     OR public.finance_committee_labels.label IS DISTINCT FROM EXCLUDED.label
     OR public.finance_committee_labels.source_urls IS DISTINCT FROM EXCLUDED.source_urls
     OR public.finance_committee_labels.researched_at IS DISTINCT FROM EXCLUDED.researched_at
`;

export const UPSERT_BATCH_SIZE = 500;

export function chunk<T>(rows: readonly T[], size = UPSERT_BATCH_SIZE): T[][] {
  if (size <= 0) {
    throw new Error("chunk size must be positive");
  }
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

/**
 * Counts transported tags whose parents do not resolve on the target.
 *
 * UPSERT_TAGS_SQL resolves parents with inner joins, so an unresolved tag is
 * silently dropped rather than erroring — the run would commit and report
 * success having written fewer tags than it carried. Preflight cannot rule
 * this out on its own either, because a slug can be renamed between preflight
 * and apply. Running this INSIDE the apply transaction closes that window.
 */
export const UNRESOLVED_TAGS_SQL = `
  SELECT count(*)::int AS unresolved
  FROM jsonb_to_recordset($1::jsonb) AS s(
    candidate_id uuid, record_identity_key text, research_area_slug text, stance text)
  LEFT JOIN public.candidate_records AS r
    ON r.candidate_id = s.candidate_id
   AND r.record_identity_key = s.record_identity_key
  LEFT JOIN public.research_areas AS a ON a.slug = s.research_area_slug
  WHERE r.id IS NULL OR a.id IS NULL
`;

export async function countUnresolvedTags(
  client: PromotionClient,
  rows: readonly TagRow[]
): Promise<number> {
  let unresolved = 0;
  for (const batch of chunk(rows)) {
    const result = await client.query(UNRESOLVED_TAGS_SQL, [JSON.stringify(batch)]);
    unresolved += (result.rows as { unresolved: number }[])[0]?.unresolved ?? 0;
  }
  return unresolved;
}

/**
 * record_identity_key is derived from the normalised description, URL and
 * date. A row whose stored key does not match its own content means the source
 * was edited without going through the writer; promoting it would carry a
 * stale key, and a later sanctioned write would then insert a second record
 * for the same fact that never-delete semantics would keep forever.
 */
export function findIdentityKeyMismatches(
  rows: readonly RecordRow[],
  buildKey: (input: { description: string; sourceUrl: string; eventDate: string }) => string
): { candidateId: string; stored: string; computed: string }[] {
  const mismatches: { candidateId: string; stored: string; computed: string }[] = [];
  for (const row of rows) {
    const computed = buildKey({
      description: row.description,
      sourceUrl: row.source_url,
      eventDate: row.event_date,
    });
    if (computed !== row.record_identity_key) {
      mismatches.push({
        candidateId: row.candidate_id,
        stored: row.record_identity_key,
        computed,
      });
    }
  }
  return mismatches;
}

/** Runs one upsert statement over the rows in batches. Returns rows written. */
export async function upsertBatched(
  client: PromotionClient,
  sql: string,
  rows: readonly unknown[],
  batchSize = UPSERT_BATCH_SIZE
): Promise<number> {
  let written = 0;
  for (const batch of chunk(rows, batchSize)) {
    const result = await client.query(sql, [JSON.stringify(batch)]);
    written += result.rowCount ?? 0;
  }
  return written;
}

// ---------------------------------------------------------------------------
// Preflight resolution
// ---------------------------------------------------------------------------

/**
 * Candidate UUIDs that the target cannot accept as a record parent. A UUID
 * that is absent, soft-deleted or merged away is reported rather than skipped:
 * silently dropping a record is how a promotion reports success while leaving
 * a candidate half-populated.
 */
export async function findUnresolvableCandidates(
  target: PromotionClient,
  candidateIds: readonly string[]
): Promise<string[]> {
  if (candidateIds.length === 0) {
    return [];
  }
  const result = await target.query(
    `
      SELECT s.candidate_id::text AS candidate_id
      FROM unnest($1::uuid[]) AS s(candidate_id)
      LEFT JOIN public.candidates AS c ON c.id = s.candidate_id
      WHERE c.id IS NULL
         OR c.deleted_at IS NOT NULL
         OR c.merged_into_candidate_id IS NOT NULL
    `,
    [candidateIds]
  );
  return (result.rows as { candidate_id: string }[]).map((row) => row.candidate_id);
}

export const CANDIDATE_FINGERPRINT_SQL = `
  SELECT
    id::text AS candidate_id,
    lower(btrim(coalesce(display_name, ''))) AS display_name,
    upper(btrim(coalesce(state, ''))) AS state
  FROM public.candidates
  WHERE id = ANY($1::uuid[])
`;

export type CandidateFingerprint = { candidate_id: string; display_name: string; state: string };

/**
 * A shared UUID is not proof of shared identity. Both databases descend from
 * one snapshot today, but a UUID that exists on the target while naming a
 * different person would pass every FK and uniqueness check and quietly file
 * this candidate's records — and, through the tag remap, their tags — under
 * someone else. Nothing downstream could detect that.
 *
 * So compare a cheap identity fingerprint (normalised display name + state)
 * and refuse on disagreement rather than trusting the id.
 */
export function diffCandidateFingerprints(
  sourceRows: readonly CandidateFingerprint[],
  targetRows: readonly CandidateFingerprint[]
): { candidateId: string; source: string; target: string }[] {
  const targetById = new Map(targetRows.map((row) => [row.candidate_id, row]));
  const conflicts: { candidateId: string; source: string; target: string }[] = [];
  for (const sourceRow of sourceRows) {
    const targetRow = targetById.get(sourceRow.candidate_id);
    if (targetRow === undefined) {
      continue; // absence is findUnresolvableCandidates' job, not this one
    }
    if (
      sourceRow.display_name !== targetRow.display_name ||
      sourceRow.state !== targetRow.state
    ) {
      conflicts.push({
        candidateId: sourceRow.candidate_id,
        source: `${sourceRow.display_name} (${sourceRow.state})`,
        target: `${targetRow.display_name} (${targetRow.state})`,
      });
    }
  }
  return conflicts;
}

/**
 * Every candidate the run will WRITE under, for the two guards above. A tag
 * removal is a write too, and most removals sit on records that are otherwise
 * unchanged — their candidates would never reach the guards through the
 * record plan alone. That matters because record_identity_key hashes only
 * (description, url, date): roll-call records share all three across members,
 * so a drifted target where a shared UUID names a different person would hold
 * a same-key record for that person, and the delete would take their tag.
 * Removal candidates are included only when reconciliation is enabled; without
 * it nothing is deleted, and the default run must not gain an abort reason
 * for candidates it will not touch.
 */
export function guardedCandidateIds(input: {
  preflightRecords: readonly Pick<RecordRow, "candidate_id">[];
  removals: readonly Pick<TagRemoval, "candidate_id">[];
  reconcileTags: boolean;
}): string[] {
  const ids = new Set(input.preflightRecords.map((row) => row.candidate_id));
  if (input.reconcileTags) {
    for (const removal of input.removals) {
      ids.add(removal.candidate_id);
    }
  }
  return [...ids];
}

export async function findUnresolvableAreaSlugs(
  target: PromotionClient,
  slugs: readonly string[]
): Promise<string[]> {
  if (slugs.length === 0) {
    return [];
  }
  const result = await target.query(
    `
      SELECT s.slug
      FROM unnest($1::text[]) AS s(slug)
      LEFT JOIN public.research_areas AS a ON a.slug = s.slug
      WHERE a.slug IS NULL
    `,
    [slugs]
  );
  return (result.rows as { slug: string }[]).map((row) => row.slug);
}

/**
 * Schema parity. Equal migration sets do not prove equal seed data, but an
 * unequal set means the two databases disagree about table shape and no
 * promotion should be attempted. This tool never runs migrations itself.
 */
export async function readMigrationSet(client: PromotionClient): Promise<Map<string, string>> {
  const result = await client.query(
    "SELECT filename, checksum FROM public.schema_migrations ORDER BY filename"
  );
  return new Map((result.rows as { filename: string; checksum: string }[]).map((row) => [row.filename, row.checksum]));
}

/**
 * Compares migration state, scoped to the migration FILES that currently exist
 * on disk.
 *
 * Scoping matters. A long-lived database keeps schema_migrations rows for
 * migrations that were later renamed, and those files no longer exist — the
 * local database carries 9 such rows (e.g. 196_add_county_council_chairman_alias.sql,
 * renamed to ..._chair_alias.sql) that a freshly migrated database will never
 * have. A naive set-equality check therefore reports a mismatch forever and
 * blocks every promotion. Only files on disk are authoritative; rows without a
 * file are historical residue on either side and are ignored.
 */
export function diffMigrationSets(input: {
  source: ReadonlyMap<string, string>;
  target: ReadonlyMap<string, string>;
  knownFilenames: readonly string[];
}): { missingOnSource: string[]; missingOnTarget: string[]; checksumMismatch: string[] } {
  const missingOnSource: string[] = [];
  const missingOnTarget: string[] = [];
  const checksumMismatch: string[] = [];

  for (const filename of input.knownFilenames) {
    const sourceChecksum = input.source.get(filename);
    const targetChecksum = input.target.get(filename);
    if (sourceChecksum === undefined) {
      missingOnSource.push(filename);
    }
    if (targetChecksum === undefined) {
      missingOnTarget.push(filename);
    }
    if (
      sourceChecksum !== undefined &&
      targetChecksum !== undefined &&
      sourceChecksum !== targetChecksum
    ) {
      checksumMismatch.push(filename);
    }
  }

  return { missingOnSource, missingOnTarget, checksumMismatch };
}

/**
 * Apply mode requires the operator to retype the target host, so a promotion
 * can never commit to a database nobody looked at. Compared against the parsed
 * effective host, not the raw URL text.
 */
export function confirmationTokenFor(target: EndpointFingerprint): string {
  // host:port/database — the port matters because two servers can share a host
  // (a direct connection and a pooler, or staging and production on one box),
  // and confirming the host alone would let a promotion land in the wrong one.
  return `${target.host}:${target.port}/${target.database}`;
}

export function assertConfirmedTarget(target: EndpointFingerprint, confirmTarget: string): void {
  // host/database, not host alone: two databases commonly share a host, and
  // confirming only the host would let a promotion land in the wrong one while
  // the operator believed they had named it.
  const expected = confirmationTokenFor(target);
  const supplied = confirmTarget.trim().toLowerCase();
  if (supplied.length === 0) {
    throw new Error(
      `--apply requires --confirm-target <host>:<port>/<database>. Target is ${describeEndpoint(target)}; ` +
        `re-run with --confirm-target ${expected}`
    );
  }
  if (supplied !== expected) {
    throw new Error(
      `--confirm-target "${supplied}" does not match the target "${expected}". ` +
        "Refusing to write to a database the operator did not name."
    );
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const SCRIPT_LABEL = "promote research data";

function usage(): string {
  return [
    "Usage:",
    "  npm run research:promote                       # dry run, writes nothing",
    "  npm run research:promote:apply -- --confirm-target <host>:<port>/<database>",
    "",
    "Flags:",
    "  --reconcile-tags   also remove area tags the local record no longer has,",
    "                     for target records matched by exact identity only",
    "                     (same key or the transition ledger). Dry run prints",
    "                     one line per affected record; apply deletes them.",
    "  --report-file <p>  write the JSON report to a file",
    "",
    "Endpoints:",
    "  source  DATABASE_URL                     (must be local; read-only)",
    "  target  PROMOTION_TARGET_DATABASE_URL    (env only — never a flag, so a",
    "                                            password cannot land in shell",
    "                                            history or the process list)",
  ].join("\n");
}

export function readFlagValue(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index < 0) {
    return null;
  }
  const value = argv[index + 1];
  return value !== undefined && !value.startsWith("--") ? value : null;
}

export async function listMigrationFilenames(): Promise<string[]> {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");
  const names = await readdir(dir);
  return names.filter((name) => name.endsWith(".sql")).sort();
}

export type PromotionReport = {
  mode: "dry_run" | "apply";
  source: string;
  target: string;
  tables: Record<
    string,
    {
      inserts: number;
      updates: number;
      unchanged: number;
      targetOnly: number;
      /** candidate_records only: target rows updated in place onto a new identity key. */
      rekeys?: number;
      written?: number;
      rekeysWritten?: number;
      /** candidate_record_area_tags only, apply + --reconcile-tags: tags deleted. */
      removed?: number;
    }
  >;
  tagReconciliation: {
    /** Whether --reconcile-tags was passed; the plan is computed regardless. */
    enabled: boolean;
    /** Tags that would be (or were) removed, and the records they sit on. */
    plannedRemovals: number;
    recordsAffected: number;
    skipped: TagReconciliationPlan["skipped"];
    /** Per-record detail; only filled in when enabled, to keep the default report small. */
    records?: TagReconciliationRecord[];
  };
};

/**
 * One candidate uuid per line (blank lines and # comments ignored). Scopes a
 * promotion to those candidates so one repair campaign can go out without
 * carrying every other pending local campaign with it.
 */
export async function readCandidateScope(path: string): Promise<Set<string>> {
  const text = await readFile(path, "utf8");
  const ids = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const bad = ids.filter((id) => !uuid.test(id));
  if (ids.length === 0 || bad.length > 0) {
    throw new Error(
      `--candidate-ids-file ${path}: expected one candidate uuid per line; ` +
        (ids.length === 0 ? "the file is empty" : `not a uuid: ${bad.slice(0, 3).join(", ")}`)
    );
  }
  return new Set(ids.map((id) => id.toLowerCase()));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  assertKnownCliFlags(SCRIPT_LABEL, argv, [
    { name: "--apply", value: "none" },
    { name: "--confirm-target", value: "space" },
    { name: "--report-file", value: "space" },
    { name: "--reconcile-tags", value: "none" },
    { name: "--candidate-ids-file", value: "space" },
  ]);

  loadProjectEnv();
  const apply = argv.includes("--apply");
  const reconcileTags = argv.includes("--reconcile-tags");
  const candidateIdsFile = readFlagValue(argv, "--candidate-ids-file");
  if (argv.includes("--candidate-ids-file") && !candidateIdsFile) {
    // Fail closed: a scope flag with no path must not quietly become "every candidate".
    throw new Error("--candidate-ids-file requires a file path");
  }
  const scope = candidateIdsFile ? await readCandidateScope(candidateIdsFile) : null;
  const endpoints = assertPromotionEndpoints({
    sourceUrl: process.env.DATABASE_URL ?? "",
    targetUrl: process.env.PROMOTION_TARGET_DATABASE_URL ?? "",
  });
  if (apply) {
    assertConfirmedTarget(endpoints.target, readFlagValue(argv, "--confirm-target") ?? "");
  }

  console.log(`source: ${describeEndpoint(endpoints.source)}`);
  console.log(`target: ${describeEndpoint(endpoints.target)}`);
  console.log(`mode:   ${apply ? "APPLY (writes)" : "dry run (writes nothing)"}`);
  console.log(`tags:   ${reconcileTags ? "reconcile (remove stale tags of exactly-matched records)" : "upsert only"}`);
  console.log(`scope:  ${scope ? `${scope.size} candidate(s) from ${candidateIdsFile}; finance labels skipped` : "every candidate"}`);

  const sourcePool = new Pool({ connectionString: process.env.DATABASE_URL });
  // Bounded timeouts on the target: the apply path holds one transaction across
  // three batched upserts, so a hung remote would otherwise block indefinitely
  // while holding row locks on candidate_records. Fail predictably instead.
  const targetPool = new Pool({
    connectionString: process.env.PROMOTION_TARGET_DATABASE_URL,
    connectionTimeoutMillis: 30_000,
    statement_timeout: 300_000,
  });
  const source: PromotionClient = { query: (text, values) => sourcePool.query(text, values as unknown[]) };
  const target: PromotionClient = { query: (text, values) => targetPool.query(text, values as unknown[]) };

  try {
    const migrationDiff = diffMigrationSets({
      source: await readMigrationSet(source),
      target: await readMigrationSet(target),
      knownFilenames: await listMigrationFilenames(),
    });
    if (
      migrationDiff.missingOnSource.length > 0 ||
      migrationDiff.missingOnTarget.length > 0 ||
      migrationDiff.checksumMismatch.length > 0
    ) {
      throw new Error(
        `Refusing to promote across differing schemas: ${JSON.stringify(migrationDiff)}. ` +
          "Run db:migrate on the lagging database first; this tool never migrates."
      );
    }

    // With --candidate-ids-file every projection is cut to those candidates on
    // BOTH sides, so "target-only" (rekey and reconciliation input) means
    // target-only within the scope, and nothing outside it is read or
    // written. Finance labels have no candidate and are skipped when scoped.
    const inScope = <T extends { candidate_id: string }>(rows: T[]): T[] =>
      scope ? rows.filter((row) => scope.has(row.candidate_id)) : rows;
    const [sourceRecords, targetRecords] = (
      await Promise.all([
        loadProjection<RecordRow>(source, RECORD_PROJECTION_SQL),
        loadProjection<RecordRow>(target, RECORD_PROJECTION_SQL),
      ])
    ).map(inScope) as [RecordRow[], RecordRow[]];
    const [sourceTags, targetTags] = (
      await Promise.all([
        loadProjection<TagRow>(source, TAG_PROJECTION_SQL),
        loadProjection<TagRow>(target, TAG_PROJECTION_SQL),
      ])
    ).map(inScope) as [TagRow[], TagRow[]];
    const [sourceLabels, targetLabels] = scope
      ? [[], []]
      : await Promise.all([
          loadProjection<LabelRow>(source, LABEL_PROJECTION_SQL),
          loadProjection<LabelRow>(target, LABEL_PROJECTION_SQL),
        ]);
    // Source only: transitions describe local edit history. The migration
    // parity check above guarantees the table exists on both sides.
    const transitions = resolveIdentityTransitions(
      inScope(await loadProjection<TransitionRow>(source, TRANSITION_PROJECTION_SQL))
    );

    const recordPlan = planRows({ sourceRows: sourceRecords, targetRows: targetRecords, keyOf: recordKey, isEqual: sameRecord });
    const tagPlan = planRows({ sourceRows: sourceTags, targetRows: targetTags, keyOf: tagKey, isEqual: sameTag });
    const labelPlan = planRows({ sourceRows: sourceLabels, targetRows: targetLabels, keyOf: labelKey, isEqual: sameLabel });

    // A local description edit re-keys its row, so the key diff sees an
    // insert + a target-only orphan. Recognize that pair and update the
    // target row in place instead of inserting a duplicate sibling.
    const rekeyPlan = planRecordRekeys({
      inserts: recordPlan.inserts,
      targetOnlyRows: recordPlan.targetOnlyRows,
      normalizeUrl: normalizeUrlForIdentity,
      similarityOf: scoreCandidateRecordDescriptionSimilarity,
      threshold: DESCRIPTION_SIMILARITY_UPDATE_THRESHOLD,
      transitions,
    });
    for (const suspect of rekeyPlan.redatedSuspects) {
      console.warn(
        `WARNING: target-only row for candidate ${suspect.targetRow.candidate_id} on ` +
          `${suspect.targetRow.event_date} closely matches a new local record dated ` +
          `${suspect.sourceRow.event_date} (similarity ${suspect.similarity.toFixed(2)}, same URL). ` +
          "If a local date repair re-dated this record, the target row is a stale duplicate — " +
          "review and clean it up with research:promote:dedupe; this run will INSERT the new date."
      );
    }

    // pendingRecords feeds the INSERT ... ON CONFLICT upsert, so rekeyed rows
    // must stay out of it — they are written by the rekey UPDATE, and letting
    // the upsert see them too would re-insert the very sibling the rekey
    // exists to prevent. Preflight, by contrast, must see every row any
    // statement will write.
    const pendingRecords = [...rekeyPlan.inserts, ...recordPlan.updates];
    const preflightRecords = [...pendingRecords, ...rekeyPlan.rekeys.map((rekey) => rekey.sourceRow)];
    const pendingTags = [...tagPlan.inserts, ...tagPlan.updates];
    // Computed on every run so the dry run can say how many target-only tags
    // are reconcilable; acted on only under --reconcile-tags.
    const tagReconciliation = planTagReconciliation({
      targetOnlyTags: tagPlan.targetOnlyRows,
      sourceTags,
      sourceRecords,
      rekeys: rekeyPlan.rekeys,
    });
    // A stored key that disagrees with its own content means the source row
    // was edited outside the writer; promoting it would carry a stale key.
    const keyMismatches = findIdentityKeyMismatches(preflightRecords, (input) =>
      buildCandidateRecordIdentityKey(input)
    );
    if (keyMismatches.length > 0) {
      throw new Error(
        `Refusing to promote ${keyMismatches.length} record(s) whose stored record_identity_key does ` +
          "not match their own description/url/date. Re-run the sanctioned writer for those rows first. " +
          `First: candidate ${keyMismatches[0]!.candidateId}, stored ${keyMismatches[0]!.stored}, ` +
          `computed ${keyMismatches[0]!.computed}`
      );
    }

    assertTransportableArrays([...labelPlan.inserts, ...labelPlan.updates]);

    const pendingCandidateIds = guardedCandidateIds({
      preflightRecords,
      removals: tagReconciliation.removals,
      reconcileTags,
    });
    const missingCandidates = await findUnresolvableCandidates(target, pendingCandidateIds);
    const missingSlugs = await findUnresolvableAreaSlugs(
      target,
      [...new Set(pendingTags.map((row) => row.research_area_slug))]
    );
    if (missingCandidates.length > 0 || missingSlugs.length > 0) {
      throw new Error(
        "Refusing to promote: the target is missing parents these rows depend on. " +
          `Unresolvable candidates: ${missingCandidates.slice(0, 10).join(", ") || "none"}. ` +
          `Unresolvable research areas: ${missingSlugs.slice(0, 10).join(", ") || "none"}. ` +
          "Promote or repair those first; this tool never invents a parent."
      );
    }

    // A shared UUID is not shared identity — see diffCandidateFingerprints.
    const [sourceFingerprints, targetFingerprints] = await Promise.all([
      source.query(CANDIDATE_FINGERPRINT_SQL, [pendingCandidateIds]),
      target.query(CANDIDATE_FINGERPRINT_SQL, [pendingCandidateIds]),
    ]);
    const identityConflicts = diffCandidateFingerprints(
      sourceFingerprints.rows as CandidateFingerprint[],
      targetFingerprints.rows as CandidateFingerprint[]
    );
    if (identityConflicts.length > 0) {
      const first = identityConflicts[0]!;
      throw new Error(
        `Refusing to promote: ${identityConflicts.length} candidate id(s) name a different person on ` +
          `the target. Promoting would file records under the wrong candidate. First: ${first.candidateId} ` +
          `is "${first.source}" locally but "${first.target}" on the target.`
      );
    }

    const report: PromotionReport = {
      mode: apply ? "apply" : "dry_run",
      source: describeEndpoint(endpoints.source),
      target: describeEndpoint(endpoints.target),
      tables: {
        candidate_records: {
          inserts: rekeyPlan.inserts.length,
          updates: recordPlan.updates.length,
          unchanged: recordPlan.unchangedCount,
          // Rekeyed rows leave the target-only bucket: they are matched, not
          // orphaned. What remains is genuinely target-only.
          targetOnly: recordPlan.targetOnlyCount - rekeyPlan.rekeys.length,
          rekeys: rekeyPlan.rekeys.length,
        },
        candidate_record_area_tags: {
          inserts: tagPlan.inserts.length,
          updates: tagPlan.updates.length,
          unchanged: tagPlan.unchangedCount,
          targetOnly: tagPlan.targetOnlyCount,
        },
        finance_committee_labels: {
          inserts: labelPlan.inserts.length,
          updates: labelPlan.updates.length,
          unchanged: labelPlan.unchangedCount,
          targetOnly: labelPlan.targetOnlyCount,
        },
      },
      tagReconciliation: {
        enabled: reconcileTags,
        plannedRemovals: tagReconciliation.removals.length,
        recordsAffected: tagReconciliation.records.length,
        skipped: tagReconciliation.skipped,
        ...(reconcileTags ? { records: tagReconciliation.records } : {}),
      },
    };

    if (reconcileTags) {
      console.log(
        `\ntag reconciliation: ${tagReconciliation.removals.length} tag(s) on ` +
          `${tagReconciliation.records.length} exactly-matched record(s) ${apply ? "will be" : "would be"} removed; ` +
          `skipped ${tagReconciliation.skipped.noLocalRecord} with no local record, ` +
          `${tagReconciliation.skipped.similarityRekeyOnly} matched only by similarity, ` +
          `${tagReconciliation.skipped.carriedByRekey} carried through a rekey.`
      );
      for (const entry of tagReconciliation.records) {
        const how =
          entry.matched_via === "same_key"
            ? "same key"
            : `ledger: was ${entry.target_record_identity_key}`;
        console.log(
          `  candidate ${entry.candidate_id} record ${entry.local_record_identity_key} (${how}): ` +
            `remove [${entry.remove.join(", ")}]; keep [${entry.keep.join(", ")}]`
        );
      }
    } else if (tagReconciliation.removals.length > 0) {
      console.log(
        `\nnote: ${tagReconciliation.removals.length} target-only tag(s) sit on exactly-matched records ` +
          "and would be removed under --reconcile-tags (not enabled; nothing is deleted)."
      );
    }

    if (apply) {
      const client: PoolClient = await targetPool.connect();
      try {
        await client.query("BEGIN");
        const wrapped: PromotionClient = { query: (text, values) => client.query(text, values as unknown[]) };
        // Rekeys before the record upsert: they move existing target rows
        // onto their new keys, and must land before anything else references
        // those keys. Every planned rekey must hit its row — a shortfall
        // means the target changed under us, and committing would leave the
        // old-key duplicate the rekey exists to prevent.
        const rekeysWritten = await upsertBatched(wrapped, REKEY_RECORDS_SQL, rekeyWireRows(rekeyPlan.rekeys));
        if (rekeysWritten !== rekeyPlan.rekeys.length) {
          throw new Error(
            `Refusing to commit: planned ${rekeyPlan.rekeys.length} record rekey(s) but the target ` +
              `matched ${rekeysWritten}. The target changed since the plan was computed; re-run.`
          );
        }
        report.tables.candidate_records!.rekeysWritten = rekeysWritten;
        // Records before tags: a tag resolves its parent by natural key, so
        // the record must already exist on the target.
        report.tables.candidate_records!.written = await upsertBatched(wrapped, UPSERT_RECORDS_SQL, pendingRecords);

        // Inside the transaction, after the records exist: the tag upsert uses
        // inner joins, so an unresolved tag would be dropped and the run would
        // still commit and report success. Preflight alone cannot rule this
        // out because a slug can be renamed in between.
        const unresolvedTags = await countUnresolvedTags(wrapped, pendingTags);
        if (unresolvedTags > 0) {
          throw new Error(
            `Refusing to commit: ${unresolvedTags} tag(s) do not resolve to a target record and ` +
              "research area, and would be silently dropped by the insert."
          );
        }

        report.tables.candidate_record_area_tags!.written = await upsertBatched(wrapped, UPSERT_TAGS_SQL, pendingTags);

        // After the rekeys (so every removal addresses the record's final
        // key) and after the tag upsert (so a run reads as "write, then
        // reconcile"). The two never overlap: a removal is a (record, slug)
        // the local side lacks, an upsert is one it has. Every planned
        // removal must hit exactly one row — the natural keys resolve to at
        // most one tag, so a shortfall means the target changed under us.
        if (reconcileTags) {
          const removed = await upsertBatched(wrapped, RECONCILE_TAGS_DELETE_SQL, tagReconciliation.removals);
          if (removed !== tagReconciliation.removals.length) {
            throw new Error(
              `Refusing to commit: planned ${tagReconciliation.removals.length} tag removal(s) but the ` +
                `target matched ${removed}. The target changed since the plan was computed; re-run.`
            );
          }
          report.tables.candidate_record_area_tags!.removed = removed;
        }
        report.tables.finance_committee_labels!.written = await upsertBatched(
          wrapped,
          UPSERT_LABELS_SQL,
          [...labelPlan.inserts, ...labelPlan.updates]
        );
        await client.query("COMMIT");
      } catch (error) {
        // Best-effort rollback: if the connection is already gone, ROLLBACK
        // throws too, and letting that propagate would replace the error that
        // actually explains the failure. Report it rather than swallowing it —
        // a rollback that did not run leaves the transaction's fate unknown,
        // which is exactly what an operator needs to hear.
        await client.query("ROLLBACK").catch((rollbackError: unknown) => {
          console.error(
            `ROLLBACK failed after the error below; the transaction's state on the target is unknown: ${
              rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
            }`
          );
        });
        throw error;
      } finally {
        client.release();
      }
    }

    const reportFile = readFlagValue(argv, "--report-file");
    if (reportFile) {
      await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    console.log(JSON.stringify(report, null, 2));
    if (!apply) {
      // Print the exact token rather than a placeholder: the operator can copy
      // it, and it cannot drift out of step with assertConfirmedTarget.
      console.log(
        "\nDry run only — nothing was written. Re-run with:\n" +
          `  npm run research:promote:apply -- --confirm-target ${confirmationTokenFor(endpoints.target)}` +
          // The hint must carry the scope, or a copied command promotes every candidate.
          (candidateIdsFile ? ` --candidate-ids-file '${candidateIdsFile.replace(/'/g, "'\\''")}'` : "") +
          (reconcileTags ? " --reconcile-tags" : "")
      );
    }
  } finally {
    // allSettled: a failure closing one pool must not leave the other open.
    await Promise.allSettled([sourcePool.end(), targetPool.end()]);
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint && import.meta.url === entrypoint) {
  main().catch((error: unknown) => {
    console.error(`${SCRIPT_LABEL} failed: ${error instanceof Error ? error.message : String(error)}`);
    console.error(usage());
    process.exit(1);
  });
}
