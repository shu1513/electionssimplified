import { randomBytes } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { isUuid } from "../../utils/uuid.js";
import { displayElectionTitle } from "../../utils/displayElectionTitle.js";
import { loadCanonicalElectionResults } from "../electionResults/canonicalElectionResults.js";
import type { CanonicalElectionResultWinner } from "../electionResults/canonicalElectionResults.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type TransactionalDb = Pick<Pool, "connect">;
type TransactionClient = Pick<PoolClient, "query" | "release">;

export type UserPickCardShare = {
  token: string;
  election_date: string;
};

export type PublicPickCardWinner = CanonicalElectionResultWinner;

export type PublicPickCardEntry = {
  election_id: string;
  official_ballot_title: string;
  race_type: "office" | "ballot_measure";
  district_name: string;
  picks: { candidate_id: string; display_name: string; candidacy_status: string }[];
  measure_position: "yes" | "no" | null;
  /** ballot_measures.result at read time ("passed"/"failed" once certified
   * results land, null before) — the measure counterpart of the won/lost
   * candidacy_status on picks. */
  measure_result: string | null;
  /** The election's canonical result (same precedence as the ballot summary:
   * certified over election_night, then freshest), so the card can flag a
   * pick that won/advanced on election night — candidacy_status only flips
   * at certification. null / empty when no decisive result is recorded. */
  current_result_outcome: string | null;
  current_result_winners: PublicPickCardWinner[];
};

/** The public payload behind /picks/<token>. Everything here is public
 * information (races, candidate names, results) except one identity field:
 * the owner's FIRST name, so the page can say whose card this is — the
 * owner mints and posts the link themselves, and a card that names nobody
 * reads as anonymous data, not a friend's picks. First name only,
 * deliberately: no last name, email, or user id ever enters this payload.
 *
 * null for shares whose row has show_owner_name=false: tokens minted
 * before the named page existed (migration 207) stay anonymous — they are
 * stable, non-expiring URLs the owner may have posted precisely because
 * the page showed no identity — until the owner clicks Share again. */
export type PublicPickCard = {
  first_name: string | null;
  election_date: string;
  entries: PublicPickCardEntry[];
};

export type UserPickCardSharesErrorCode =
  | "invalid_user_id"
  | "invalid_election_date"
  | "user_not_found"
  | "no_picks_to_share";

export class UserPickCardSharesError extends Error {
  constructor(
    readonly code: UserPickCardSharesErrorCode,
    message: string
  ) {
    super(message);
    this.name = "UserPickCardSharesError";
  }
}

const ELECTION_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function normalizeUserId(userId: string): string {
  const normalized = userId.trim();
  if (!isUuid(normalized)) {
    throw new UserPickCardSharesError("invalid_user_id", "User ID must be a valid UUID");
  }
  return normalized;
}

function normalizeElectionDate(electionDate: string): string {
  const normalized = electionDate.trim();
  // Round-trip through UTC instead of trusting Date.parse alone: V8 rolls
  // impossible days over ("2026-02-30" parses as March 2), which would pass
  // a NaN check here and then blow up as a 500 on Postgres's ::date cast.
  // Year 0000 round-trips unchanged in JS (it means 1 BC there) but does
  // not exist in Postgres's calendar, so it needs its own rejection.
  const parsed = new Date(`${normalized}T00:00:00Z`);
  const isRealDate =
    ELECTION_DATE_PATTERN.test(normalized) &&
    !normalized.startsWith("0000") &&
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === normalized;
  if (!isRealDate) {
    throw new UserPickCardSharesError("invalid_election_date", "election_date must be a valid YYYY-MM-DD date");
  }
  return normalized;
}

async function rollbackQuietly(client: TransactionClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}

/**
 * Create (or return the existing) share link for one date's pick card.
 * Idempotent per (user, election_date): the first click mints a token, every
 * later click returns the same one, so a re-share never invalidates a link
 * already posted somewhere.
 */
export async function getOrCreateUserPickCardShare(
  db: TransactionalDb,
  userId: string,
  electionDate: string
): Promise<{ share: UserPickCardShare }> {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedDate = normalizeElectionDate(electionDate);
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    const user = await client.query<{ id: string }>(
      `
        SELECT id FROM public.users
        WHERE id = $1::uuid AND deleted_at IS NULL
        FOR UPDATE
      `,
      [normalizedUserId]
    );
    if (user.rows.length === 0) {
      throw new UserPickCardSharesError("user_not_found", "User not found");
    }

    // An empty card is not shareable: a public page with zero picks says
    // nothing, and minting tokens for every date a user glances at would
    // scatter live capability URLs nobody asked for. Mirrors the public
    // lookup's rules exactly, or the mint could succeed while the card
    // renders empty:
    // - current-district scope (see lookupPublicPickCard on why);
    // - a candidate pick counts only while its candidate survives
    //   (deleted/merged candidates drop out of the rendered card).
    const anyPick = await client.query<{ one: number }>(
      `
        SELECT 1 AS one
        FROM public.user_election_choices AS choice
        JOIN public.elections AS election
          ON election.id = choice.election_id
        JOIN public.user_districts AS user_district
          ON user_district.user_id = choice.user_id
         AND user_district.district_id = election.district_id
        LEFT JOIN public.candidates AS candidate
          ON candidate.id = choice.candidate_id
         AND candidate.deleted_at IS NULL
         AND candidate.merged_into_candidate_id IS NULL
        WHERE choice.user_id = $1::uuid
          AND election.election_date = $2::date
          AND (choice.measure_position IS NOT NULL OR candidate.id IS NOT NULL)
        LIMIT 1
      `,
      [normalizedUserId, normalizedDate]
    );
    if (anyPick.rows.length === 0) {
      throw new UserPickCardSharesError("no_picks_to_share", "No picks recorded for that election date");
    }

    // 256-bit random capability. ON CONFLICT keeps the FIRST token: the
    // update lets RETURNING hand back the existing row instead of burning
    // the fresh token into it (which would silently break links already
    // shared). show_owner_name upgrades to true on conflict, deliberately:
    // rows minted before the named page existed default to anonymous
    // (see migration 207), and the owner clicking Share under the UI that
    // shows their name IS the consent to name that link from now on.
    const token = randomBytes(32).toString("base64url");
    const saved = await client.query<{ token: string; election_date: string }>(
      `
        INSERT INTO public.user_pick_card_shares (user_id, election_date, token, show_owner_name)
        VALUES ($1::uuid, $2::date, $3, true)
        ON CONFLICT (user_id, election_date)
        DO UPDATE SET show_owner_name = true
        RETURNING token, election_date::text AS election_date
      `,
      [normalizedUserId, normalizedDate, token]
    );

    await client.query("COMMIT");
    const row = saved.rows[0];
    if (!row) {
      throw new Error("pick card share upsert returned no row");
    }
    return { share: { token: row.token, election_date: row.election_date } };
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Every live share link the user holds, newest first. Lets the picks page
 * show "Stop sharing" for a date whose link already exists (after a reload,
 * or on another device) instead of only for links minted in this session.
 */
export async function listUserPickCardShares(
  db: Queryable,
  userId: string
): Promise<{ shares: UserPickCardShare[] }> {
  const normalizedUserId = normalizeUserId(userId);
  const result = await db.query<{ token: string; election_date: string }>(
    `
      SELECT token, election_date::text AS election_date
      FROM public.user_pick_card_shares
      WHERE user_id = $1::uuid
      ORDER BY election_date DESC
    `,
    [normalizedUserId]
  );
  return { shares: result.rows.map((row) => ({ token: row.token, election_date: row.election_date })) };
}

/**
 * Revoke one date's share link. The row goes away, so /picks/<token> 404s
 * from the next request on; a later Share click mints a fresh token rather
 * than reviving the old URL. Idempotent: deleting a share that does not
 * exist reports deleted=false instead of failing, so a double click or a
 * stale second tab cannot surface an error for an outcome that already
 * holds.
 */
export async function deleteUserPickCardShare(
  db: Queryable,
  userId: string,
  electionDate: string
): Promise<{ deleted: boolean }> {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedDate = normalizeElectionDate(electionDate);
  const result = await db.query(
    `
      DELETE FROM public.user_pick_card_shares
      WHERE user_id = $1::uuid AND election_date = $2::date
    `,
    [normalizedUserId, normalizedDate]
  );
  return { deleted: (result.rowCount ?? 0) > 0 };
}

type PickCardRow = {
  first_name: string | null;
  election_date: string;
  election_id: string;
  official_ballot_title: string;
  race_type: "office" | "ballot_measure";
  district_name: string;
  candidate_id: string | null;
  display_name: string | null;
  candidacy_status: string | null;
  measure_position: "yes" | "no" | null;
  measure_result: string | null;
};

/**
 * The live public view behind a share token. Null when the token matches no
 * share (or its owner was deleted) — the API turns that into a 404. Picks
 * whose candidate has since been deleted or merged drop out, mirroring the
 * owner's own list read (userElectionChoices).
 */
export async function lookupPublicPickCard(db: Queryable, token: string): Promise<PublicPickCard | null> {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const result = await db.query<PickCardRow>(
    `
      SELECT
        CASE WHEN share.show_owner_name THEN user_row.first_name END AS first_name,
        share.election_date::text AS election_date,
        election.id::text AS election_id,
        election.official_ballot_title,
        election.race_type,
        district.name AS district_name,
        choice.candidate_id::text AS candidate_id,
        COALESCE(
          NULLIF(trim(candidate.display_name), ''),
          trim(concat_ws(' ', candidate.first_name, candidate.last_name))
        ) AS display_name,
        candidate_election.status AS candidacy_status,
        choice.measure_position,
        measure.result AS measure_result
      FROM public.user_pick_card_shares AS share
      JOIN public.users AS user_row
        ON user_row.id = share.user_id
       AND user_row.deleted_at IS NULL
      JOIN public.user_election_choices AS choice
        ON choice.user_id = share.user_id
      JOIN public.elections AS election
        ON election.id = choice.election_id
       AND election.election_date = share.election_date
      -- Current-district scope: the owner's private card is built from their
      -- saved ballot, so this keeps the public card a subset of what the
      -- owner can SEE when deciding to share. Without it, picks made under a
      -- previous address would surface here — races the owner's own page no
      -- longer shows, revealing where they used to live. Live by design:
      -- moving updates (and can empty) an already-shared card.
      JOIN public.user_districts AS user_district
        ON user_district.user_id = share.user_id
       AND user_district.district_id = election.district_id
      JOIN public.districts AS district
        ON district.id = election.district_id
      LEFT JOIN public.candidates AS candidate
        ON candidate.id = choice.candidate_id
       AND candidate.deleted_at IS NULL
       AND candidate.merged_into_candidate_id IS NULL
      LEFT JOIN public.candidate_elections AS candidate_election
        ON candidate_election.candidate_id = choice.candidate_id
       AND candidate_election.election_id = choice.election_id
      LEFT JOIN public.ballot_measures AS measure
        ON measure.election_id = election.id
      WHERE share.token = $1
      ORDER BY election.official_ballot_title ASC, election.id ASC, choice.created_at ASC, choice.id ASC
    `,
    [trimmed]
  );
  if (result.rows.length === 0) {
    // Distinguish "no such share" from "share with zero surviving picks":
    // the latter still renders a (bare) card rather than a 404, so a link
    // someone posted keeps resolving even if its picks were since cleared.
    const share = await db.query<{ first_name: string | null; election_date: string }>(
      `
        SELECT
          CASE WHEN share.show_owner_name THEN user_row.first_name END AS first_name,
          share.election_date::text AS election_date
        FROM public.user_pick_card_shares AS share
        JOIN public.users AS user_row
          ON user_row.id = share.user_id
         AND user_row.deleted_at IS NULL
        WHERE share.token = $1
      `,
      [trimmed]
    );
    const bare = share.rows[0];
    return bare ? { first_name: bare.first_name, election_date: bare.election_date, entries: [] } : null;
  }

  const byElection = new Map<string, PublicPickCardEntry>();
  for (const row of result.rows) {
    let entry = byElection.get(row.election_id);
    if (!entry) {
      entry = {
        election_id: row.election_id,
        official_ballot_title: displayElectionTitle(row.official_ballot_title),
        race_type: row.race_type,
        district_name: row.district_name,
        picks: [],
        measure_position: null,
        measure_result: row.measure_result,
        current_result_outcome: null,
        current_result_winners: [],
      };
      byElection.set(row.election_id, entry);
    }
    if (row.measure_position !== null) {
      entry.measure_position = row.measure_position;
    } else if (row.candidate_id && row.display_name && row.candidacy_status) {
      entry.picks.push({
        candidate_id: row.candidate_id,
        display_name: row.display_name,
        candidacy_status: row.candidacy_status,
      });
    }
  }
  const entries = [...byElection.values()].filter(
    (entry) => entry.picks.length > 0 || entry.measure_position !== null
  );

  if (entries.length > 0) {
    // One canonical result per election, so the public card can flag a pick
    // that won/advanced before certification flips candidacy_status.
    const canonical = await loadCanonicalElectionResults(
      db,
      entries.map((entry) => entry.election_id)
    );
    for (const entry of entries) {
      const canonicalResult = canonical.get(entry.election_id);
      if (canonicalResult) {
        entry.current_result_outcome = canonicalResult.outcome;
        entry.current_result_winners = canonicalResult.winners;
      }
    }
  }

  return {
    first_name: result.rows[0].first_name,
    election_date: result.rows[0].election_date,
    entries,
  };
}
