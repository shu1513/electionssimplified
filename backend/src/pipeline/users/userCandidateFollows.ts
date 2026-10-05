import type { Pool, PoolClient } from "pg";

import { isUuid } from "../../utils/uuid.js";
import { displayElectionTitle } from "../../utils/displayElectionTitle.js";
import { US_LATEST_LOCAL_DATE_SQL } from "../../utils/usLocalDate.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type TransactionalDb = Pick<Pool, "connect">;
type TransactionClient = Pick<PoolClient, "query" | "release">;

export type UserCandidateFollowRecordPreview = {
  description: string;
  event_date: string;
};

export type UserCandidateFollowElectionPreview = {
  election_id: string;
  official_ballot_title: string;
  election_date: string;
};

export type UserCandidateFollow = {
  candidate_id: string;
  display_name: string;
  party: string;
  state: string;
  current_office: string | null;
  latest_record: UserCandidateFollowRecordPreview | null;
  active_election: UserCandidateFollowElectionPreview | null;
  notify_elections: boolean;
  notify_updates: boolean;
  created_at: string;
};

export type UserCandidateFollowsResult = {
  follows: UserCandidateFollow[];
};

export type UserCandidateFollowInput = {
  candidateId: string;
  following: boolean;
  notifyElections?: boolean;
  notifyUpdates?: boolean;
};

export type UserCandidateFollowState = {
  candidate_id: string;
  following: boolean;
  notify_elections: boolean;
  notify_updates: boolean;
  created_at: string | null;
};

export type UserCandidateFollowUpdateResult = {
  follow: UserCandidateFollowState;
};

/** Hard cap on follows per user: keeps the My Picks list, digest emails, and
 * the monthly manual records refresh bounded. Raising it later is safe;
 * lowering it would strand existing follows. */
export const USER_CANDIDATE_FOLLOW_LIMIT = 25;

export type UserCandidateFollowsErrorCode =
  | "invalid_user_id"
  | "invalid_candidate_id"
  | "invalid_follow_input"
  | "user_not_found"
  | "candidate_not_found"
  | "follow_limit_reached";

export class UserCandidateFollowsError extends Error {
  constructor(
    readonly code: UserCandidateFollowsErrorCode,
    message: string
  ) {
    super(message);
    this.name = "UserCandidateFollowsError";
  }
}

type CandidateFollowRow = {
  candidate_id: string | null;
  display_name: string | null;
  party: string | null;
  state: string | null;
  current_office: string | null;
  latest_record_description: string | null;
  latest_record_event_date: string | null;
  active_election_id: string | null;
  active_election_title: string | null;
  active_election_date: string | null;
  notify_elections: boolean | null;
  notify_updates: boolean | null;
  created_at: string | Date | null;
};

type CandidateFollowStateRow = {
  candidate_id: string;
  notify_elections: boolean;
  notify_updates: boolean;
  created_at: string | Date;
};

type NormalizedUserCandidateFollowInput = {
  candidateId: string;
  following: boolean;
  notifyElections?: boolean;
  notifyUpdates?: boolean;
};

function normalizeUserId(userId: string): string {
  const normalized = userId.trim();
  if (!isUuid(normalized)) {
    throw new UserCandidateFollowsError("invalid_user_id", "User ID must be a valid UUID");
  }
  return normalized;
}

function normalizeCandidateId(candidateId: string): string {
  const normalized = candidateId.trim();
  if (!isUuid(normalized)) {
    throw new UserCandidateFollowsError("invalid_candidate_id", "Candidate ID must be a valid UUID");
  }
  return normalized;
}

function normalizeFollowInput(input: UserCandidateFollowInput): NormalizedUserCandidateFollowInput {
  if (typeof input.following !== "boolean") {
    throw new UserCandidateFollowsError("invalid_follow_input", "following must be a boolean");
  }
  if (input.notifyElections !== undefined && typeof input.notifyElections !== "boolean") {
    throw new UserCandidateFollowsError("invalid_follow_input", "notifyElections must be a boolean");
  }
  if (input.notifyUpdates !== undefined && typeof input.notifyUpdates !== "boolean") {
    throw new UserCandidateFollowsError("invalid_follow_input", "notifyUpdates must be a boolean");
  }

  return {
    candidateId: normalizeCandidateId(input.candidateId),
    following: input.following,
    ...(input.notifyElections === undefined ? {} : { notifyElections: input.notifyElections }),
    ...(input.notifyUpdates === undefined ? {} : { notifyUpdates: input.notifyUpdates }),
  };
}

function formatTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function rowToFollow(row: CandidateFollowRow): UserCandidateFollow | null {
  if (!row.candidate_id || !row.display_name || !row.party || !row.state || !row.created_at) {
    return null;
  }
  return {
    candidate_id: row.candidate_id,
    display_name: row.display_name,
    party: row.party,
    state: row.state,
    current_office: row.current_office,
    latest_record:
      row.latest_record_description && row.latest_record_event_date
        ? {
            description: row.latest_record_description,
            event_date: row.latest_record_event_date,
          }
        : null,
    active_election:
      row.active_election_id && row.active_election_title && row.active_election_date
        ? {
            election_id: row.active_election_id,
            official_ballot_title: displayElectionTitle(row.active_election_title),
            election_date: row.active_election_date,
          }
        : null,
    notify_elections: row.notify_elections ?? true,
    notify_updates: row.notify_updates ?? true,
    created_at: formatTimestamp(row.created_at),
  };
}

async function rollbackQuietly(client: TransactionClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}

async function assertActiveUser(db: Queryable, normalizedUserId: string, lock: boolean): Promise<void> {
  const user = await db.query<{ id: string }>(
    `
      SELECT id
      FROM public.users
      WHERE id = $1::uuid
        AND deleted_at IS NULL
      ${lock ? "FOR UPDATE" : ""}
    `,
    [normalizedUserId]
  );
  if (user.rows.length === 0) {
    throw new UserCandidateFollowsError("user_not_found", "User not found");
  }
}

export async function listUserCandidateFollows(db: Queryable, userId: string): Promise<UserCandidateFollowsResult> {
  const normalizedUserId = normalizeUserId(userId);
  const result = await db.query<CandidateFollowRow>(
    `
      SELECT
        follow.candidate_id::text AS candidate_id,
        COALESCE(
          NULLIF(trim(candidate.display_name), ''),
          trim(concat_ws(' ', candidate.first_name, candidate.last_name))
        ) AS display_name,
        candidate.party,
        candidate.state,
        candidate.current_office,
        latest_record.description AS latest_record_description,
        latest_record.event_date AS latest_record_event_date,
        active_election.election_id AS active_election_id,
        active_election.official_ballot_title AS active_election_title,
        active_election.election_date AS active_election_date,
        follow.notify_elections,
        follow.notify_updates,
        follow.created_at
      FROM public.users AS user_row
      LEFT JOIN public.user_candidate_follows AS follow
        ON follow.user_id = user_row.id
      LEFT JOIN public.candidates AS candidate
        ON candidate.id = follow.candidate_id
       AND candidate.deleted_at IS NULL
       AND candidate.merged_into_candidate_id IS NULL
      LEFT JOIN LATERAL (
        SELECT
          record.description,
          record.event_date::text AS event_date
        FROM public.candidate_records AS record
        WHERE record.candidate_id = candidate.id
          AND record.retired_at IS NULL
        ORDER BY record.event_date DESC, record.created_at DESC, record.id ASC
        LIMIT 1
      ) AS latest_record ON true
      LEFT JOIN LATERAL (
        SELECT
          election.id::text AS election_id,
          election.official_ballot_title,
          election.election_date::text AS election_date
        FROM public.candidate_elections AS candidate_election
        JOIN public.elections AS election
          ON election.id = candidate_election.election_id
        WHERE candidate_election.candidate_id = candidate.id
          AND candidate_election.status NOT IN ('withdrawn', 'lost')
          AND election.election_date >= ${US_LATEST_LOCAL_DATE_SQL}
        ORDER BY election.election_date ASC, election.official_ballot_title ASC, candidate_election.id ASC
        LIMIT 1
      ) AS active_election ON true
      WHERE user_row.id = $1::uuid
        AND user_row.deleted_at IS NULL
      ORDER BY follow.created_at ASC NULLS LAST, follow.id ASC NULLS LAST
    `,
    [normalizedUserId]
  );
  if (result.rows.length === 0) {
    throw new UserCandidateFollowsError("user_not_found", "User not found");
  }

  return {
    follows: result.rows.flatMap((row) => {
      const follow = rowToFollow(row);
      return follow ? [follow] : [];
    }),
  };
}

export async function setUserCandidateFollow(
  db: TransactionalDb,
  userId: string,
  input: UserCandidateFollowInput
): Promise<UserCandidateFollowUpdateResult> {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedInput = normalizeFollowInput(input);
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    await assertActiveUser(client, normalizedUserId, true);

    if (!normalizedInput.following) {
      await client.query(
        `
          DELETE FROM public.user_candidate_follows
          WHERE user_id = $1::uuid
            AND candidate_id = $2::uuid
        `,
        [normalizedUserId, normalizedInput.candidateId]
      );
      await client.query("COMMIT");
      return {
        follow: {
          candidate_id: normalizedInput.candidateId,
          following: false,
          notify_elections: false,
          notify_updates: false,
          created_at: null,
        },
      };
    }

    // Enforce the follow cap inside the transaction: assertActiveUser locked
    // the user row FOR UPDATE, so concurrent follows for the same user
    // serialize and cannot both pass this count. The cap applies only to
    // genuinely NEW follows — already_followed bypasses it, so notification-
    // flag updates (the UI sends following: true for those) keep working for
    // users at or grandfathered above the limit. Only follows the user can
    // see count: the join mirrors listUserCandidateFollows' visibility rule,
    // so a stale follow whose candidate was soft-deleted or merged (hidden
    // from the list, thus impossible to unfollow from it) cannot consume
    // quota.
    const existing = await client.query<{ count: string; already_followed: boolean }>(
      `
        SELECT
          count(*) AS count,
          EXISTS (
            SELECT 1
            FROM public.user_candidate_follows
            WHERE user_id = $1::uuid
              AND candidate_id = $2::uuid
          ) AS already_followed
        FROM public.user_candidate_follows AS follow
        JOIN public.candidates AS candidate
          ON candidate.id = follow.candidate_id
         AND candidate.deleted_at IS NULL
         AND candidate.merged_into_candidate_id IS NULL
        WHERE follow.user_id = $1::uuid
          AND follow.candidate_id <> $2::uuid
      `,
      [normalizedUserId, normalizedInput.candidateId]
    );
    if (
      !existing.rows[0]?.already_followed &&
      Number(existing.rows[0]?.count ?? 0) >= USER_CANDIDATE_FOLLOW_LIMIT
    ) {
      throw new UserCandidateFollowsError(
        "follow_limit_reached",
        `You can follow up to ${USER_CANDIDATE_FOLLOW_LIMIT} candidates. Unfollow one to add another.`
      );
    }

    const saved = await client.query<CandidateFollowStateRow>(
      `
        WITH followable_candidate AS (
          SELECT id
          FROM public.candidates
          WHERE id = $2::uuid
            AND deleted_at IS NULL
            AND merged_into_candidate_id IS NULL
          -- A locking SELECT would require UPDATE on candidates, which the
          -- API role must not hold. This CTE gates the INSERT below in the
          -- same statement, so a soft-delete or merge COMMITTED before the
          -- statement's snapshot refuses the follow; the foreign key covers
          -- hard deletes. An overlapping uncommitted soft-delete can still
          -- land a follow — accepted: candidates are also deleted or merged
          -- AFTER legitimate follows, so read paths and notification
          -- creators re-check eligibility rather than assuming this state
          -- cannot exist.
        )
        INSERT INTO public.user_candidate_follows (
          user_id,
          candidate_id,
          notify_elections,
          notify_updates
        )
        SELECT
          $1::uuid,
          followable_candidate.id,
          COALESCE($3::boolean, true),
          COALESCE($4::boolean, true)
        FROM followable_candidate
        ON CONFLICT (user_id, candidate_id)
        DO UPDATE SET
          notify_elections = COALESCE($3::boolean, user_candidate_follows.notify_elections),
          notify_updates = COALESCE($4::boolean, user_candidate_follows.notify_updates)
        RETURNING candidate_id::text, notify_elections, notify_updates, created_at
      `,
      [
        normalizedUserId,
        normalizedInput.candidateId,
        normalizedInput.notifyElections ?? null,
        normalizedInput.notifyUpdates ?? null,
      ]
    );
    const row = saved.rows[0];
    if (!row) {
      throw new UserCandidateFollowsError("candidate_not_found", "Candidate not found");
    }

    await client.query("COMMIT");
    return {
      follow: {
        candidate_id: row.candidate_id,
        following: true,
        notify_elections: row.notify_elections,
        notify_updates: row.notify_updates,
        created_at: formatTimestamp(row.created_at),
      },
    };
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}
