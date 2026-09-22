import { Pool, type PoolClient } from "pg";
import { createClient } from "redis";

import { getPipelineEnv } from "../../config/env.js";
import {
  STAGING_BALLOT_MEASURE_DRAFT_STREAM,
  STAGING_ITEM_TYPE_CANDIDATE_ROSTER,
  STAGING_ITEM_TYPE_BALLOT_MEASURE,
  STAGING_ELECTIONS_WRITER_GROUP,
  STAGING_ITEM_TYPE_ELECTION,
  STAGING_VALIDATED_STREAM,
  STAGING_WRITTEN_STREAM,
} from "../../config/electionsPipeline.js";
import { parseCanonicalElectionPayload } from "../../contracts/electionPayloadContract.js";
import type { ElectionContestScope, ElectionEnrichedPayload } from "../../types/election.js";
import { normalizeHttpUrl } from "../../utils/normalizeHttpUrl.js";
import { normalizeElectionTitleKey } from "../../utils/normalizeElectionTitleKey.js";
import { isUsSenateOfficeTitle } from "../../utils/senateOffice.js";
import { enqueueCandidateRosterDrafts } from "../candidates/candidateRosterDraftEmitter.js";
import {
  defaultOfficeCandidateEligibilityConfig,
  evaluateOfficeCandidateEligibilityByElectionIds,
  summarizeOfficeCandidateEligibilityReasons,
} from "../candidates/officeCandidateEligibility.js";
import {
  isNonJudicialOfficeTitle,
  isStateNonJudicialOfficeTitle,
} from "../../ai/electionPartisanshipPolicy.js";
import {
  isArkansasQuorumCourtTitle,
  OfficeMatcher,
  type OfficeMatchResult,
} from "../elections/officeMatcher.js";
import { createDistrictNewElectionNotificationEvents } from "../users/districtNotificationEvents.js";
import {
  describeRetiredElectionIdentity,
  findRetiredElectionIdentities,
  isReinstateRetiredApproved,
  markRetiredElectionIdentityReinstated,
  type RetiredIdentityMatch,
} from "../elections/retiredElectionIdentities.js";

const JUDICIAL_JUSTICE_OF_THE_PEACE_STATES = new Set(["tx", "texas", "la", "louisiana"]);

function isJudicialJusticeOfThePeaceTitle(state: string, title: string): boolean {
  if (!JUDICIAL_JUSTICE_OF_THE_PEACE_STATES.has(state.trim().toLowerCase())) {
    return false;
  }
  return /\bjustice of the peace\b/i.test(title) && !/\bconstable\b/i.test(title);
}

type WriterOptions = {
  once?: boolean;
  batchSize?: number;
  blockMs?: number;
  // Targeted mode: write ONE validated staging row by ingest_key directly,
  // without reading the validated stream (see the validator's option of the
  // same name for the stale-backlog rationale).
  ingestKey?: string;
};

type StagingRow = {
  ingest_key: string;
  payload: unknown;
  status: string;
  run_id: string | null;
  ai_raw_debug: unknown;
};

type WriteResult = {
  wrote: boolean;
  ballotMeasureElectionIds: string[];
  officeElectionIds: string[];
  /** Entries skipped because their identity sits in retired_election_identities. */
  skippedRetiredCount: number;
};

type WriteOptions = {
  /**
   * True only for a manual-research staging row stamped by
   * manual:elections:inject --reinstate-retired. Together with the payload's
   * reinstate_retired flag and review_reason it lets a retired identity be
   * written again and closes the ledger row.
   */
  reinstateRetiredApproved: boolean;
};

type UnresolvedOfficeEntry = {
  method: OfficeMatchResult["method"];
  confidence: number;
  officialBallotTitle: string;
  normalizedAlias: string;
};

function describeUnresolvedOffices(input: {
  districtId: string;
  scope: string;
  unresolved: readonly UnresolvedOfficeEntry[];
}): string {
  const entries = input.unresolved
    .map(
      (entry) =>
        `method=${entry.method} confidence=${entry.confidence.toFixed(3)} ` +
        `title=${JSON.stringify(entry.officialBallotTitle)} ` +
        `normalized_alias=${JSON.stringify(entry.normalizedAlias)}`
    )
    .join("; ");
  return (
    `writer office match unresolved: district_id=${input.districtId} scope=${input.scope} ` +
    `unresolved=${input.unresolved.length} ${entries}`
  );
}

/**
 * Some `districts` rows are not governments at all: `Arlington CDP, Virginia`
 * is a Census statistical geography coextensive with, and named like, Arlington
 * County, which is the row that actually holds the elections.
 * `districts.canonical_district_id` names that owner, and contests written
 * under the alias would sit where no ballot reader reaches them.
 *
 * Like an unresolved office match this is a permanent fault in the payload, not
 * a transient one, so the writer parks the staging item instead of retrying it
 * forever. Re-run the research against the district id named in the message.
 */
class NonGovernmentDistrictWriteError extends Error {
  constructor(input: {
    districtId: string;
    districtName: string;
    canonicalDistrictId: string;
    canonicalDistrictName: string;
  }) {
    super(
      `writer refused non-government district: district_id=${input.districtId} ` +
        `name=${JSON.stringify(input.districtName)} is a Census statistical row, not a district; ` +
        `contests belong to canonical_district_id=${input.canonicalDistrictId} ` +
        `name=${JSON.stringify(input.canonicalDistrictName)}`
    );
    this.name = "NonGovernmentDistrictWriteError";
  }
}

// Writing elections + downstream publish can take time; only reclaim clearly stale pending entries.
const RECLAIM_MIN_IDLE_MS = 240_000;
const RECLAIM_MAX_BATCHES = 20;
const BALLOT_MEASURE_EMIT_MARKER_PREFIX = "staging:ballot_measure_emitted:";
const ENABLE_CANDIDATE_ROSTER_WRITER_ELIGIBILITY_FILTER =
  process.env.CANDIDATE_ROSTER_ENABLE_WRITER_ELIGIBILITY_FILTER === "true";
const EMIT_BALLOT_MEASURE_DRAFT_IF_NEEDED_LUA = `
if redis.call("EXISTS", KEYS[2]) == 1 then
  return 0
end
redis.call(
  "XADD",
  KEYS[1],
  "*",
  "election_id",
  ARGV[1],
  "item_type",
  ARGV[2],
  "run_id",
  ARGV[3]
)
redis.call("SET", KEYS[2], ARGV[4])
return 1
`;

function toReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 1000 ? `${message.slice(0, 997)}...` : message;
}

async function ensureConsumerGroup(redis: ReturnType<typeof createClient>): Promise<void> {
  try {
    await redis.xGroupCreate(STAGING_VALIDATED_STREAM, STAGING_ELECTIONS_WRITER_GROUP, "0", { MKSTREAM: true });
  } catch (error) {
    const message = toReason(error);
    if (!message.includes("BUSYGROUP")) {
      throw error;
    }
  }
}

async function getStagingRow(pool: Pool, ingestKey: string): Promise<StagingRow | null> {
  const result = await pool.query<StagingRow>(
    `
      SELECT ingest_key, payload, status, run_id
           , ai_raw_debug
      FROM staging_items
      WHERE ingest_key = $1
        AND item_type = $2
    `,
    [ingestKey, STAGING_ITEM_TYPE_ELECTION]
  );
  return result.rows[0] ?? null;
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
      STAGING_VALIDATED_STREAM,
      STAGING_ELECTIONS_WRITER_GROUP,
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

function extractFamilySeedUrls(aiRawDebug: unknown): Partial<Record<ElectionContestScope, string[]>> {
  if (typeof aiRawDebug !== "object" || aiRawDebug === null || Array.isArray(aiRawDebug)) {
    return {};
  }
  const record = aiRawDebug as Record<string, unknown>;
  const raw = record.family_source_urls;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }

  const families: ElectionContestScope[] = [
    "all",
    "non_judicial_office",
    "judicial_office",
    "ballot_measure",
    "us_senate",
  ];
  const result: Partial<Record<ElectionContestScope, string[]>> = {};
  const sourceRecord = raw as Record<string, unknown>;

  for (const family of families) {
    const list = sourceRecord[family];
    if (list === undefined || list === null) {
      continue;
    }
    // The contract rejects these shapes on the way in, but rows staged before
    // that check exist: warn instead of dropping the family in silence, which
    // is how districts reached election_seed_urls with nothing at all.
    if (!Array.isArray(list) || list.length === 0) {
      console.warn(
        `elections writer ignoring family_source_urls.${family}: expected a non-empty array of URL strings, got ${
          Array.isArray(list) ? "an empty array" : typeof list
        }`
      );
      continue;
    }
    const urls = [
      ...new Set(
        list
          .filter((item): item is string => typeof item === "string")
          .map((item) => normalizeHttpUrl(item))
          .filter((item): item is string => Boolean(item))
      ),
    ];
    if (urls.length === 0) {
      console.warn(
        `elections writer ignoring family_source_urls.${family}: no entry normalized to an http(s) URL`
      );
      continue;
    }
    result[family] = urls;
  }

  return result;
}

async function resolveBallotMeasureElectionIds(
  pool: Pool,
  payload: ElectionEnrichedPayload
): Promise<string[]> {
  const ballotEntries = payload.entries.filter((entry) => entry.race_type === "ballot_measure");
  if (ballotEntries.length === 0) {
    return [];
  }

  const titleKeys = ballotEntries.map((entry) => normalizeElectionTitleKey(entry.official_ballot_title));
  const dates = ballotEntries.map((entry) => entry.election_date);

  const result = await pool.query<{ id: string }>(
    `
      SELECT e.id
      FROM public.elections AS e
      JOIN unnest($2::text[], $3::date[]) AS m(official_ballot_title_key, election_date)
        ON e.official_ballot_title_key = m.official_ballot_title_key
       AND e.election_date = m.election_date
      WHERE e.district_id = $1
        AND e.race_type = 'ballot_measure'
    `,
    [payload.district_id, titleKeys, dates]
  );

  return [...new Set(result.rows.map((row) => row.id))];
}

async function resolveOfficeElectionIds(
  pool: Pool,
  payload: ElectionEnrichedPayload
): Promise<string[]> {
  const officeEntries = payload.entries.filter((entry) => entry.race_type === "office");
  if (officeEntries.length === 0) {
    return [];
  }

  const titleKeys = officeEntries.map((entry) => normalizeElectionTitleKey(entry.official_ballot_title));
  const dates = officeEntries.map((entry) => entry.election_date);

  const result = await pool.query<{ id: string }>(
    `
      SELECT e.id
      FROM public.elections AS e
      JOIN unnest($2::text[], $3::date[]) AS o(official_ballot_title_key, election_date)
        ON e.official_ballot_title_key = o.official_ballot_title_key
       AND e.election_date = o.election_date
      WHERE e.district_id = $1
        AND e.race_type = 'office'
        -- Same rule as the fresh-write handoff: an office-less shell has no
        -- office for the candidate-records stage to work from, so the replay
        -- and recovery paths must not enqueue rosters for one either.
        AND e.office_id IS NOT NULL
    `,
    [payload.district_id, titleKeys, dates]
  );

  return [...new Set(result.rows.map((row) => row.id))];
}

async function enqueueBallotMeasureDrafts(
  redis: ReturnType<typeof createClient>,
  electionIds: readonly string[],
  runId: string | null
): Promise<void> {
  const emittedAt = new Date().toISOString();
  const uniqueElectionIds = [...new Set(electionIds)];
  for (const electionId of uniqueElectionIds) {
    const markerKey = `${BALLOT_MEASURE_EMIT_MARKER_PREFIX}${electionId}`;
    await redis.sendCommand([
      "EVAL",
      EMIT_BALLOT_MEASURE_DRAFT_IF_NEEDED_LUA,
      "2",
      STAGING_BALLOT_MEASURE_DRAFT_STREAM,
      markerKey,
      electionId,
      STAGING_ITEM_TYPE_BALLOT_MEASURE,
      runId ?? "",
      emittedAt,
    ]);
  }
}

async function selectWriterEligibleOfficeElectionIds(
  pool: Pool,
  officeElectionIds: readonly string[],
  context: string
): Promise<string[]> {
  if (!ENABLE_CANDIDATE_ROSTER_WRITER_ELIGIBILITY_FILTER || officeElectionIds.length === 0) {
    return [...new Set(officeElectionIds)];
  }

  const config = defaultOfficeCandidateEligibilityConfig();
  const rows = await evaluateOfficeCandidateEligibilityByElectionIds(pool, officeElectionIds, config);
  const counts = summarizeOfficeCandidateEligibilityReasons(rows);
  const eligibleIds = rows.filter((row) => row.reason === "eligible").map((row) => row.election_id);

  console.log(
    `candidate-roster writer eligibility (${context}) as_of=${config.asOfDate}: ` +
      `input=${officeElectionIds.length} eligible=${eligibleIds.length} ` +
      `already_written=${counts.already_written} not_nearest=${counts.not_nearest_in_track} ` +
      `buffer_blocked=${counts.buffer_not_elapsed} too_far_in_future=${counts.too_far_in_future} ` +
      `not_upcoming=${counts.not_upcoming}`
  );

  return eligibleIds;
}

async function writeElectionsForDistrict(
  client: PoolClient,
  ingestKey: string,
  payload: ElectionEnrichedPayload,
  familySeedUrls: Partial<Record<ElectionContestScope, string[]>>,
  runId: string | null,
  writeOptions: WriteOptions = { reinstateRetiredApproved: false }
): Promise<WriteResult> {
  // Checked before the transaction opens so the payload parks as failed rather
  // than half-writing a district that no reader will ever reach.
  const canonicalCheck = await client.query<{
    name: string;
    canonical_district_id: string | null;
    canonical_name: string | null;
  }>(
    `
      SELECT d.name, d.canonical_district_id, owner.name AS canonical_name
      FROM public.districts AS d
      LEFT JOIN public.districts AS owner ON owner.id = d.canonical_district_id
      WHERE d.id = $1
    `,
    [payload.district_id]
  );
  const canonicalRow = canonicalCheck.rows[0];
  if (canonicalRow?.canonical_district_id) {
    throw new NonGovernmentDistrictWriteError({
      districtId: payload.district_id,
      districtName: canonicalRow.name,
      canonicalDistrictId: canonicalRow.canonical_district_id,
      canonicalDistrictName: canonicalRow.canonical_name ?? "unknown",
    });
  }

  await client.query("BEGIN");
  try {
    const nextStatus = payload.entries.length === 0 ? "no_results" : "written";
    const statusUpdate = await client.query(
      `
        UPDATE staging_items
        SET status = $3,
            reason = NULL,
            written_at = now(),
            updated_at = now()
        WHERE ingest_key = $1
          AND item_type = $2
          AND status = 'validated'
      `,
      [ingestKey, STAGING_ITEM_TYPE_ELECTION, nextStatus]
    );
    if (statusUpdate.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { wrote: false, ballotMeasureElectionIds: [], officeElectionIds: [], skippedRetiredCount: 0 };
    }

    await client.query(
      `
        UPDATE public.districts
        SET last_elections_searched_at = now()
        WHERE id = $1
      `,
      [payload.district_id]
    );

    const ballotMeasureElectionIds: string[] = [];
    const officeElectionIds: string[] = [];
    const officeMatcher = new OfficeMatcher(client);
    const officeMatchCounts: Record<"alias_exact" | "deterministic_fallback", number> = {
      alias_exact: 0,
      deterministic_fallback: 0,
    };
    const aliasRowsToInsert: Array<{
      office_id: string;
      scope: string;
      alias_text: string;
      normalized_alias: string;
    }> = [];
    const seenAliasKeys = new Set<string>();
    const senateMetadataRows: Array<{
      election_id: string;
      senate_class: string | null;
      term_end_year: string | null;
    }> = [];
    const insertedElectionIds: string[] = [];
    const matchedOfficeIds: Array<string | null> = [];
    const unresolvedOffices: UnresolvedOfficeEntry[] = [];
    const officeLessShellElectionIds: string[] = [];

    // Retired-identity gate. A contest that manual:elections:retire-spurious
    // or manual:elections:supersede deleted leaves its identity in
    // retired_election_identities; any later payload carrying the same
    // (title key, date) for this district — a manual re-inject of the old
    // file, or the AI rollover rediscovering the same seat — must not write
    // it back silently. The entry is skipped and the reason lands on the
    // staging row. The one way through is a manual inject staged with
    // --reinstate-retired, whose payload also says reinstate_retired: true
    // and carries a review_reason; that writes the contest and closes the
    // ledger row.
    const retiredMatches = await findRetiredElectionIdentities(client, payload.district_id, payload.entries);
    const reinstating =
      writeOptions.reinstateRetiredApproved &&
      payload.reinstate_retired === true &&
      typeof payload.review_reason === "string" &&
      payload.review_reason.trim().length > 0;
    const blockedEntryIndexes = new Set<number>();
    const blockedReasons: string[] = [];
    const reinstateByEntryIndex = new Map<number, RetiredIdentityMatch>();
    for (const match of retiredMatches) {
      const entry = payload.entries[match.entryIndex]!;
      if (reinstating) {
        reinstateByEntryIndex.set(match.entryIndex, match);
        continue;
      }
      blockedEntryIndexes.add(match.entryIndex);
      blockedReasons.push(
        `${JSON.stringify(entry.official_ballot_title)} ${entry.election_date}: ${describeRetiredElectionIdentity(match)}`
      );
    }

    // Resolve every office before inserting any election. An entry the matcher
    // cannot place is written as an office-less shell and reported, not thrown:
    // aborting the payload took down every other contest in the district (one
    // Indiana prosecutor title killed a 15-entry Elkhart County payload) while
    // producing no protection — the operator's only recovery was to delete the
    // entry and re-inject, which lands the same partial write by hand and loses
    // the record of what went missing. The shell keeps the contest visible,
    // `manual:elections:repair-office-ids` backfills office_id once a matcher
    // or catalog fix lands, and the roster handoff below skips these ids so no
    // downstream stage starts work it cannot finish.
    for (const [entryIndex, entry] of payload.entries.entries()) {
      if (entry.race_type !== "office" || blockedEntryIndexes.has(entryIndex)) {
        matchedOfficeIds.push(null);
        continue;
      }

      // The title outranks a discovery family that contradicts it, because the
      // family picks the records question list. A title carrying a non-judicial
      // office marker (clerk, prosecutor, district attorney, solicitor,
      // constable...) or a state carve-out (Arkansas justice of the peace and
      // county judge, Kentucky magistrate, Texas county judge) is never a
      // judicial contest (live 2026-09-11: 47 Louisiana constables, 36 Texas
      // clerks and 31 prosecutors were filed judicial). The reverse is narrow
      // on purpose: Kentucky's justices of the peace are fiscal-court members,
      // so only the Texas and Louisiana seats, judicial under Article V of each
      // constitution and filed non-judicial 79 times, are flipped. The Arkansas
      // quorum-court rule stays alongside the state carve-out: it reads the
      // matcher key and the state as the matcher does, so a title that names
      // the court ("..., Quorum Court") or a spelled-out state still files
      // non-judicial there where the carve-out's court veto would refuse it.
      if (
        entry.discovery_contest_family === "judicial_office" &&
        (isNonJudicialOfficeTitle(entry.official_ballot_title) ||
          isStateNonJudicialOfficeTitle(payload.state, entry.official_ballot_title) ||
          isArkansasQuorumCourtTitle({
            scope: payload.district_type,
            state: payload.state,
            districtName: payload.district_name,
            officialBallotTitle: entry.official_ballot_title,
          }))
      ) {
        entry.discovery_contest_family = "non_judicial_office";
      } else if (
        entry.discovery_contest_family === "non_judicial_office" &&
        isJudicialJusticeOfThePeaceTitle(payload.state, entry.official_ballot_title)
      ) {
        entry.discovery_contest_family = "judicial_office";
      }

      const officeMatch = await officeMatcher.resolve({
        scope: payload.district_type,
        districtName: payload.district_name,
        state: payload.state,
        officialBallotTitle: entry.official_ballot_title,
        discoveryContestFamily: entry.discovery_contest_family,
      });
      if (
        officeMatch.method === "none" ||
        officeMatch.method === "ambiguous" ||
        !officeMatch.officeId
      ) {
        unresolvedOffices.push({
          method: officeMatch.method,
          confidence: officeMatch.confidence,
          officialBallotTitle: entry.official_ballot_title,
          normalizedAlias: officeMatch.normalizedAlias,
        });
        matchedOfficeIds.push(null);
        continue;
      }
      officeMatchCounts[officeMatch.method] += 1;
      matchedOfficeIds.push(officeMatch.officeId);

      if (officeMatch.shouldPersistAlias && officeMatch.aliasMemoryKey.length > 0) {
        const aliasKey = `${payload.district_type}::${officeMatch.aliasMemoryKey}`;
        if (!seenAliasKeys.has(aliasKey)) {
          seenAliasKeys.add(aliasKey);
          aliasRowsToInsert.push({
            office_id: officeMatch.officeId,
            scope: payload.district_type,
            alias_text: entry.official_ballot_title,
            normalized_alias: officeMatch.aliasMemoryKey,
          });
        }
      }
    }

    for (const [entryIndex, entry] of payload.entries.entries()) {
      if (blockedEntryIndexes.has(entryIndex)) {
        continue;
      }
      const matchedOfficeId = matchedOfficeIds[entryIndex] ?? null;
      const upsertResult = await client.query<{
        id: string;
        race_type: string;
        office_id: string | null;
        inserted: boolean;
      }>(
        `
          INSERT INTO public.elections (
            district_id,
            official_ballot_title,
            official_ballot_title_key,
            election_date,
            race_type,
            is_partisan,
            seats_to_fill,
            election_stage,
            sources,
            office_id,
            discovery_contest_family
          ) VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9::jsonb, $10::uuid, $11)
          ON CONFLICT (district_id, official_ballot_title_key, election_date) DO UPDATE SET
            race_type = EXCLUDED.race_type,
            -- Keep prior partisanship when a subsequent run omits it (e.g., mixed-state school contests).
            is_partisan = COALESCE(EXCLUDED.is_partisan, elections.is_partisan),
            -- A reclassification to ballot_measure must drop any stored seat
            -- count: the contract rejects seats_to_fill on measure entries,
            -- so a preserved office-era value could never be corrected.
            seats_to_fill = CASE
              WHEN EXCLUDED.race_type = 'ballot_measure' THEN NULL
              ELSE COALESCE(EXCLUDED.seats_to_fill, elections.seats_to_fill)
            END,
            election_stage = COALESCE(EXCLUDED.election_stage, elections.election_stage),
            office_id = COALESCE(EXCLUDED.office_id, elections.office_id),
            discovery_contest_family = CASE
              WHEN elections.discovery_contest_family IS NULL THEN EXCLUDED.discovery_contest_family
              WHEN EXCLUDED.discovery_contest_family IS NULL THEN elections.discovery_contest_family
              WHEN elections.discovery_contest_family = EXCLUDED.discovery_contest_family
                THEN elections.discovery_contest_family
              WHEN elections.discovery_contest_family = 'us_senate'
                AND EXCLUDED.discovery_contest_family = 'non_judicial_office'
                THEN 'us_senate'
              WHEN elections.discovery_contest_family = 'non_judicial_office'
                AND EXCLUDED.discovery_contest_family = 'us_senate'
                THEN 'us_senate'
              ELSE elections.discovery_contest_family
            END,
            sources = EXCLUDED.sources,
            updated_at = now()
          RETURNING id, race_type, office_id, (xmax = 0) AS inserted
        `,
        [
          payload.district_id,
          entry.official_ballot_title,
          normalizeElectionTitleKey(entry.official_ballot_title),
          entry.election_date,
          entry.race_type,
          entry.is_partisan ?? null,
          entry.seats_to_fill ?? null,
          entry.election_stage ?? null,
          JSON.stringify(entry.sources),
          matchedOfficeId,
          entry.discovery_contest_family ?? null,
        ]
      );
      const row = upsertResult.rows?.[0];
      if (row?.inserted) {
        insertedElectionIds.push(row.id);
      }
      const reinstated = reinstateByEntryIndex.get(entryIndex);
      if (row && reinstated) {
        await markRetiredElectionIdentityReinstated(client, reinstated.row.id, row.id, payload.review_reason!);
        console.warn(
          `elections writer reinstated retired contest ingest_key=${ingestKey} election_id=${row.id} ` +
            `ledger_id=${reinstated.row.id} title=${JSON.stringify(entry.official_ballot_title)} date=${entry.election_date}`
        );
      }
      if (row?.race_type === "ballot_measure") {
        ballotMeasureElectionIds.push(row.id);
      } else if (row?.race_type === "office") {
        // An office-less shell is held back from the roster handoff: the
        // candidate-records stage is hard-blocked without an office_id, so
        // enqueueing it would only queue work that cannot complete. The upsert
        // COALESCEs office_id, so a shell whose office was resolved by an
        // earlier write still hands off normally.
        if (row.office_id) {
          officeElectionIds.push(row.id);
        } else {
          officeLessShellElectionIds.push(row.id);
        }
        if (entry.discovery_contest_family === "us_senate" || isUsSenateOfficeTitle(entry.official_ballot_title)) {
          senateMetadataRows.push({
            election_id: row.id,
            senate_class: entry.senate_class ?? null,
            term_end_year: entry.term_end_year ?? null,
          });
        }
      }
    }

    // Same transaction as the election inserts: events commit atomically with
    // the rows they announce. Only fresh inserts fan out — upsert updates on
    // re-runs never re-notify — and the creator re-checks future-datedness.
    if (insertedElectionIds.length > 0) {
      const notification = await createDistrictNewElectionNotificationEvents(client, insertedElectionIds);
      if (notification.createdCount > 0) {
        console.log(
          `district-notification events ingest_key=${ingestKey} district_id=${payload.district_id} ` +
            `new_elections=${insertedElectionIds.length} events_created=${notification.createdCount}`
        );
      }
    }

    // The staging row stays `written` — the district was researched and its
    // resolvable contests are in — but the reason field carries every title the
    // matcher could not place and every contest the retired-identity gate
    // skipped, so a partial write is never silently complete.
    const stagingReasons: string[] = [];
    if (blockedReasons.length > 0) {
      const reason =
        `writer skipped ${blockedReasons.length} retired contest(s) for district_id=${payload.district_id} ` +
        `(reinstate with manual:elections:inject --reinstate-retired): ${blockedReasons.join("; ")}`;
      stagingReasons.push(reason);
      console.warn(`elections writer skipped retired contests ingest_key=${ingestKey}: ${reason}`);
    }
    if (unresolvedOffices.length > 0) {
      const reason = describeUnresolvedOffices({
        districtId: payload.district_id,
        scope: payload.district_type,
        unresolved: unresolvedOffices,
      });
      stagingReasons.push(reason);
      console.warn(
        `elections writer wrote office-less shells ingest_key=${ingestKey} ` +
          `shells=${officeLessShellElectionIds.length} ` +
          `(repair with: npm run manual:elections:repair-office-ids): ${toReason(reason)}`
      );
    }
    if (stagingReasons.length > 0) {
      await client.query(
        `
          UPDATE staging_items
          SET reason = $2,
              updated_at = now()
          WHERE ingest_key = $1
            AND item_type = $3
        `,
        [ingestKey, toReason(stagingReasons.join(" | ")), STAGING_ITEM_TYPE_ELECTION]
      );
    }

    if (officeMatchCounts.alias_exact + officeMatchCounts.deterministic_fallback > 0) {
      console.log(
        `office-matcher summary ingest_key=${ingestKey} district_id=${payload.district_id} scope=${payload.district_type} ` +
          `alias_exact=${officeMatchCounts.alias_exact} fallback=${officeMatchCounts.deterministic_fallback}`
      );
    }

    if (aliasRowsToInsert.length > 0) {
      await client.query(
        `
          INSERT INTO public.office_title_aliases (
            office_id,
            scope,
            alias_text,
            normalized_alias
          )
          SELECT
            a.office_id,
            a.scope,
            a.alias_text,
            a.normalized_alias
          FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[]) AS a(
            office_id,
            scope,
            alias_text,
            normalized_alias
          )
          ON CONFLICT (scope, normalized_alias) DO NOTHING
        `,
        [
          aliasRowsToInsert.map((row) => row.office_id),
          aliasRowsToInsert.map((row) => row.scope),
          aliasRowsToInsert.map((row) => row.alias_text),
          aliasRowsToInsert.map((row) => row.normalized_alias),
        ]
      );
    }

    if (senateMetadataRows.length > 0) {
      await client.query(
        `
          INSERT INTO public.election_senate_metadata (
            election_id,
            senate_class,
            term_end_year
          )
          SELECT
            m.election_id,
            m.senate_class,
            m.term_end_year
          FROM unnest($1::uuid[], $2::text[], $3::text[]) AS m(election_id, senate_class, term_end_year)
          ON CONFLICT (election_id) DO UPDATE
          SET senate_class = EXCLUDED.senate_class,
              term_end_year = EXCLUDED.term_end_year,
              updated_at = now()
        `,
        [
          senateMetadataRows.map((row) => row.election_id),
          senateMetadataRows.map((row) => row.senate_class),
          senateMetadataRows.map((row) => row.term_end_year),
        ]
      );
    }

    const seedRows: Array<{ family: string; url: string }> = [];
    const seenSeedKeys = new Set<string>();
    for (const [family, urls] of Object.entries(familySeedUrls)) {
      for (const url of urls ?? []) {
        const key = `${family}::${url}`;
        if (seenSeedKeys.has(key)) {
          continue;
        }
        seenSeedKeys.add(key);
        seedRows.push({ family, url });
      }
    }

    if (seedRows.length > 0) {
      await client.query(
        `
          INSERT INTO election_seed_urls (district_id, contest_family, url, last_seen_at)
          SELECT
            $1::uuid,
            seed.contest_family,
            seed.url,
            now()
          FROM unnest($2::text[], $3::text[]) AS seed(contest_family, url)
          ON CONFLICT (district_id, contest_family, url) DO UPDATE
          SET last_seen_at = EXCLUDED.last_seen_at,
              updated_at = now()
        `,
        [
          payload.district_id,
          seedRows.map((row) => row.family),
          seedRows.map((row) => row.url),
        ]
      );
    }

    if (officeElectionIds.length > 0) {
      await client.query(
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
            prompt_version
          )
          SELECT
            'candidate_roster:' || office_id::text AS ingest_key,
            $1::text AS item_type,
            jsonb_build_object('election_id', office_id::text) AS payload,
            'pending' AS status,
            NULL::text AS reason,
            $2::text AS run_id,
            NULL::text AS model,
            NULL::text AS schema_version,
            NULL::text AS prompt_version
          FROM unnest($3::uuid[]) AS office_ids(office_id)
          ON CONFLICT (ingest_key) DO NOTHING
        `,
        [STAGING_ITEM_TYPE_CANDIDATE_ROSTER, runId ?? "", officeElectionIds]
      );
    }

    await client.query("COMMIT");
    return {
      wrote: true,
      ballotMeasureElectionIds,
      officeElectionIds,
      skippedRetiredCount: blockedReasons.length,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function runElectionsWriter(options: WriterOptions = {}): Promise<void> {
  const { once = false, batchSize = 25, blockMs = 5000, ingestKey: targetIngestKey } = options;
  const env = getPipelineEnv();
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const redis = createClient({ url: env.REDIS_URL });
  const consumerName = `elections_writer_${process.pid}_${Date.now()}`;

  try {
    await redis.connect();
    await ensureConsumerGroup(redis);

    // Targeted-mode entries carry no stream id; skip the ack for them.
    const ack = async (entryId: string): Promise<void> => {
      if (entryId) {
        await redis.xAck(STAGING_VALIDATED_STREAM, STAGING_ELECTIONS_WRITER_GROUP, entryId);
      }
    };

    const handleEntries = async (entries: Array<{ id: string; message: Record<string, string> }>): Promise<void> => {
      for (const entry of entries) {
        const ingestKey = entry.message.ingest_key;
        const itemType = entry.message.item_type;

        try {
          if (!ingestKey || itemType !== STAGING_ITEM_TYPE_ELECTION) {
            await ack(entry.id);
            continue;
          }

          const row = await getStagingRow(pool, ingestKey);
          if (!row) {
            await ack(entry.id);
            continue;
          }

          const parsed = parseCanonicalElectionPayload(row.payload);
          if (!parsed.ok) {
            await pool.query(
              `
                UPDATE staging_items
                SET status = 'failed',
                    reason = $2,
                    updated_at = now()
                WHERE ingest_key = $1
                  AND item_type = $3
              `,
              [ingestKey, `writer parse error: ${parsed.reason}`, STAGING_ITEM_TYPE_ELECTION]
            );
            await ack(entry.id);
            continue;
          }

          if (row.status === "validated") {
            const familySeedUrls = extractFamilySeedUrls(row.ai_raw_debug);
            let ballotMeasureElectionIds: string[] = [];
            let officeElectionIds: string[] = [];
            const client = await pool.connect();
            try {
              const writeResult = await writeElectionsForDistrict(
                client,
                ingestKey,
                parsed.payload,
                familySeedUrls,
                row.run_id,
                { reinstateRetiredApproved: isReinstateRetiredApproved(row.ai_raw_debug) }
              );
              if (!writeResult.wrote) {
                const latestRow = await getStagingRow(pool, ingestKey);
                if (latestRow?.status === "written" || latestRow?.status === "no_results") {
                  const recoveredBallotMeasureIds = await resolveBallotMeasureElectionIds(pool, parsed.payload);
                  const recoveredOfficeIds = await resolveOfficeElectionIds(pool, parsed.payload);
                  const recoveredEligibleOfficeIds = await selectWriterEligibleOfficeElectionIds(
                    pool,
                    recoveredOfficeIds,
                    "recovery"
                  );
                  await enqueueBallotMeasureDrafts(redis, recoveredBallotMeasureIds, latestRow.run_id);
                  await enqueueCandidateRosterDrafts(redis, recoveredEligibleOfficeIds, latestRow.run_id);
                  await redis.xAdd(STAGING_WRITTEN_STREAM, "*", {
                    ingest_key: ingestKey,
                    item_type: STAGING_ITEM_TYPE_ELECTION,
                    run_id: latestRow.run_id ?? "",
                    payload: JSON.stringify(parsed.payload),
                  });
                }
                await ack(entry.id);
                continue;
              }
              ballotMeasureElectionIds = writeResult.ballotMeasureElectionIds;
              officeElectionIds = writeResult.officeElectionIds;
            } finally {
              client.release();
            }
            const eligibleOfficeElectionIds = await selectWriterEligibleOfficeElectionIds(
              pool,
              officeElectionIds,
              "validated-write"
            );
            await enqueueBallotMeasureDrafts(redis, ballotMeasureElectionIds, row.run_id);
            await enqueueCandidateRosterDrafts(redis, eligibleOfficeElectionIds, row.run_id);
          } else if (row.status !== "written" && row.status !== "no_results") {
            await ack(entry.id);
            continue;
          } else {
            const ballotMeasureElectionIds = await resolveBallotMeasureElectionIds(pool, parsed.payload);
            const officeElectionIds = await resolveOfficeElectionIds(pool, parsed.payload);
            const eligibleOfficeElectionIds = await selectWriterEligibleOfficeElectionIds(
              pool,
              officeElectionIds,
              "replay-written"
            );
            await enqueueBallotMeasureDrafts(redis, ballotMeasureElectionIds, row.run_id);
            await enqueueCandidateRosterDrafts(redis, eligibleOfficeElectionIds, row.run_id);
          }

          // If DB is already persisted (including reclaimed post-commit failures), re-emit handoff and ack.
          await redis.xAdd(STAGING_WRITTEN_STREAM, "*", {
            ingest_key: ingestKey,
            item_type: STAGING_ITEM_TYPE_ELECTION,
            run_id: row.run_id ?? "",
            payload: JSON.stringify(parsed.payload),
          });
          await ack(entry.id);
        } catch (error) {
          const reason = toReason(error);
          // An unresolved office no longer aborts — it writes an office-less
          // shell, because the rest of the district's contests are still good.
          // A non-government district row is the opposite case: there is no
          // salvageable part, since every entry targets a row no reader
          // reaches. Park it like a parse error rather than retrying forever.
          if (error instanceof NonGovernmentDistrictWriteError) {
            await pool.query(
              `
                UPDATE staging_items
                SET status = 'failed',
                    reason = $2,
                    updated_at = now()
                WHERE ingest_key = $1
                  AND item_type = $3
                  AND status = 'validated'
              `,
              [ingestKey, reason, STAGING_ITEM_TYPE_ELECTION]
            );
            console.error(`elections writer failed ingest_key=${ingestKey}: ${reason}`);
            await ack(entry.id);
            continue;
          }
          if (ingestKey) {
            console.warn(`elections writer retrying ingest_key=${ingestKey}: ${reason}`);
          } else {
            console.warn(`elections writer retrying message without ingest key: ${reason}`);
          }
          // Leave unacked; reclaim will pick it up.
        }
      }
    };

    if (targetIngestKey) {
      await handleEntries([
        { id: "", message: { ingest_key: targetIngestKey, item_type: STAGING_ITEM_TYPE_ELECTION } },
      ]);
      const finalRow = await getStagingRow(pool, targetIngestKey);
      console.log(
        JSON.stringify({ targeted: true, ingest_key: targetIngestKey, status: finalRow?.status ?? null })
      );
      return;
    }

    do {
      const reclaimed = await reclaimPendingEntries(redis, consumerName, batchSize);
      if (reclaimed.length > 0) {
        await handleEntries(reclaimed);
      }

      const batches = await redis.xReadGroup(
        STAGING_ELECTIONS_WRITER_GROUP,
        consumerName,
        [{ key: STAGING_VALIDATED_STREAM, id: ">" }],
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
      console.error("elections writer cleanup warning (redis.quit):", toReason(error));
    }
    try {
      await pool.end();
    } catch (error) {
      console.error("elections writer cleanup warning (pool.end):", toReason(error));
    }
  }
}
