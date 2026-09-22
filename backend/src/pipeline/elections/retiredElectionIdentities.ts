// Ledger of retired election identities (migration 296).
//
// manual:elections:retire-spurious and manual:elections:supersede delete the
// elections row outright. This module records the deleted identity —
// (district_id, official_ballot_title_key, election_date), the same key the
// writer upserts on — so a later discovery for the district cannot write the
// contest back silently. The writer reads the ledger before every upsert
// and skips matching entries with a visible reason; a manual inject staged
// with --reinstate-retired writes the contest and closes the ledger row.
import { normalizeElectionTitleKey } from "../../utils/normalizeElectionTitleKey.js";

type QueryResultLike<T> = { rows: T[]; rowCount?: number | null };

export type RetiredIdentityClient = {
  query<T = unknown>(text: string, values?: unknown[]): Promise<QueryResultLike<T>>;
};

export type RetiredElectionAction = "retired_spurious" | "superseded" | "backfilled";

export const RETIRED_ELECTION_ACTIONS: readonly RetiredElectionAction[] = [
  "retired_spurious",
  "superseded",
  "backfilled",
];

/** Marker the manual injector stamps on ai_raw_debug for --reinstate-retired. */
export const REINSTATE_RETIRED_APPROVED_FLAG = "reinstate_retired_approved";

export type RetiredElectionIdentityRow = {
  id: string;
  district_id: string;
  election_date: string;
  official_ballot_title_key: string;
  official_ballot_title: string;
  race_type: string | null;
  /** Null only on a backfilled row whose original id survived as a log prefix. */
  election_id: string | null;
  action: RetiredElectionAction;
  reason: string;
  source_url: string | null;
  superseded_by_election_ids: string[];
  /** YYYY-MM-DD */
  retired_on: string;
};

export type InsertRetiredElectionIdentityInput = {
  districtId: string;
  electionDate: string;
  officialBallotTitle: string;
  /** Defaults to normalizeElectionTitleKey(officialBallotTitle). Pass the stored key when the row still exists. */
  officialBallotTitleKey?: string;
  raceType: string | null;
  electionId: string | null;
  action: RetiredElectionAction;
  reason: string;
  sourceUrl?: string | null;
  supersededByElectionIds?: readonly string[];
  stagingIngestKey?: string | null;
  /** Defaults to now(); the backfill passes the original deletion date when known. */
  retiredAt?: string | null;
};

const RETIRED_IDENTITY_COLUMNS = `
  id, district_id, election_date::text AS election_date, official_ballot_title_key,
  official_ballot_title, race_type, election_id, action, reason, source_url,
  superseded_by_election_ids, to_char(retired_at, 'YYYY-MM-DD') AS retired_on
`;

export async function insertRetiredElectionIdentity(
  client: RetiredIdentityClient,
  input: InsertRetiredElectionIdentityInput
): Promise<{ id: string }> {
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO public.retired_election_identities (
        district_id, election_date, official_ballot_title_key, official_ballot_title, race_type,
        election_id, action, reason, source_url, superseded_by_election_ids, staging_ingest_key, retired_at
      ) VALUES (
        $1::uuid, $2::date, $3, $4, $5, $6::uuid, $7, $8, $9, $10::uuid[], $11, COALESCE($12::timestamptz, now())
      )
      RETURNING id
    `,
    [
      input.districtId,
      input.electionDate,
      input.officialBallotTitleKey ?? normalizeElectionTitleKey(input.officialBallotTitle),
      input.officialBallotTitle,
      input.raceType,
      input.electionId,
      input.action,
      input.reason,
      input.sourceUrl ?? null,
      [...(input.supersededByElectionIds ?? [])],
      input.stagingIngestKey ?? null,
      input.retiredAt ?? null,
    ]
  );
  return { id: result.rows[0]?.id ?? "" };
}

/**
 * Conservative near-duplicate form of a title key: the key with spaces
 * removed, so "U.S. Senate" ("u s senate") and "US Senate" ("us senate")
 * meet. Nothing else is folded — a genuinely different seat number or ward
 * keeps a different compact key.
 */
export function compactTitleKey(titleKey: string): string {
  return titleKey.replace(/\s+/g, "");
}

export type RetiredIdentityMatch = {
  entryIndex: number;
  row: RetiredElectionIdentityRow;
  matchedBy: "title_key" | "compact_title_key";
};

/**
 * Open ledger rows that match payload entries for one district. Exact key
 * match first, then the compact-key match; each entry matches at most once.
 */
export async function findRetiredElectionIdentities(
  client: RetiredIdentityClient,
  districtId: string,
  entries: ReadonlyArray<{ official_ballot_title: string; election_date: string }>
): Promise<RetiredIdentityMatch[]> {
  if (entries.length === 0) {
    return [];
  }
  const dates = [...new Set(entries.map((entry) => entry.election_date))];
  const result = await client.query<RetiredElectionIdentityRow>(
    `
      SELECT ${RETIRED_IDENTITY_COLUMNS}
      FROM public.retired_election_identities
      WHERE district_id = $1::uuid
        AND election_date = ANY($2::date[])
        AND reinstated_at IS NULL
      ORDER BY retired_at DESC
    `,
    [districtId, dates]
  );
  const rows = result.rows;
  if (rows.length === 0) {
    return [];
  }

  const matches: RetiredIdentityMatch[] = [];
  for (const [entryIndex, entry] of entries.entries()) {
    const key = normalizeElectionTitleKey(entry.official_ballot_title);
    const exact = rows.find(
      (row) => row.election_date === entry.election_date && row.official_ballot_title_key === key
    );
    if (exact) {
      matches.push({ entryIndex, row: exact, matchedBy: "title_key" });
      continue;
    }
    const compact = compactTitleKey(key);
    const near = rows.find(
      (row) =>
        row.election_date === entry.election_date && compactTitleKey(row.official_ballot_title_key) === compact
    );
    if (near) {
      matches.push({ entryIndex, row: near, matchedBy: "compact_title_key" });
    }
  }
  return matches;
}

/** One-line operator-facing description of why an entry was skipped. */
export function describeRetiredElectionIdentity(match: RetiredIdentityMatch): string {
  const { row, matchedBy } = match;
  const nearNote =
    matchedBy === "compact_title_key"
      ? ` (near-duplicate of retired title ${JSON.stringify(row.official_ballot_title)})`
      : "";
  const source = row.source_url ? ` [source ${row.source_url}]` : "";
  const retiredId = row.election_id ? ` [retired election ${row.election_id}]` : "";
  if (row.superseded_by_election_ids.length > 0) {
    return (
      `contest superseded on ${row.retired_on} by election id(s) ${row.superseded_by_election_ids.join(", ")}` +
      ` — write to the replacement instead: ${row.reason}${nearNote}${retiredId}`
    );
  }
  return `contest retired on ${row.retired_on}: ${row.reason}${source}${nearNote}${retiredId}`;
}

export async function markRetiredElectionIdentityReinstated(
  client: RetiredIdentityClient,
  ledgerId: string,
  reinstatedElectionId: string,
  reinstateReason: string
): Promise<void> {
  await client.query(
    `
      UPDATE public.retired_election_identities
      SET reinstated_at = now(),
          reinstated_election_id = $2::uuid,
          reinstate_reason = $3,
          updated_at = now()
      WHERE id = $1::uuid
        AND reinstated_at IS NULL
    `,
    [ledgerId, reinstatedElectionId, reinstateReason]
  );
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True only for a manual-research staging row stamped by inject --reinstate-retired. */
export function isReinstateRetiredApproved(aiRawDebug: unknown): boolean {
  return (
    isObjectRecord(aiRawDebug) &&
    aiRawDebug.manual_research === true &&
    aiRawDebug[REINSTATE_RETIRED_APPROVED_FLAG] === true
  );
}

/**
 * The 'written' staging rows whose payload carries this identity, newest
 * first. Recorded on the ledger row so the stale copy can be found later.
 */
export async function findStagingIngestKeysForIdentity(
  client: RetiredIdentityClient,
  districtId: string,
  officialBallotTitleKey: string,
  electionDate: string
): Promise<string[]> {
  const result = await client.query<{ ingest_key: string; entries: unknown }>(
    `
      SELECT ingest_key, payload->'entries' AS entries
      FROM public.staging_items
      WHERE item_type = 'election'
        AND status = 'written'
        AND payload->>'district_id' = $1
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(payload->'entries') AS e
          WHERE e->>'election_date' = $2
        )
      ORDER BY written_at DESC NULLS LAST
    `,
    [districtId, electionDate]
  );
  const keys: string[] = [];
  for (const row of result.rows) {
    if (!Array.isArray(row.entries)) continue;
    const hit = row.entries.some(
      (entry) =>
        isObjectRecord(entry) &&
        typeof entry.official_ballot_title === "string" &&
        entry.election_date === electionDate &&
        normalizeElectionTitleKey(entry.official_ballot_title) === officialBallotTitleKey
    );
    if (hit) keys.push(row.ingest_key);
  }
  return keys;
}
