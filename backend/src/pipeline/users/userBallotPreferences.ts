import type { Pool, PoolClient } from "pg";

import {
  DEFAULT_BALLOT_SUMMARY_SORT,
  isSaveableBallotPreferenceSort,
  type BallotSummarySort,
} from "../address/ballotElectionOrdering.js";
import { isUuid } from "../../utils/uuid.js";

type Queryable = Pick<Pool | PoolClient, "query">;

// Application defaults, applied whenever the user has no saved row. The sort
// is the same default the anonymous ballot gets (DEFAULT_BALLOT_SUMMARY_SORT).
export const DEFAULT_BALLOT_PREFERENCES: UserBallotPreferences = {
  sort: DEFAULT_BALLOT_SUMMARY_SORT,
  followed_first: true,
};

export type UserBallotPreferences = {
  sort: BallotSummarySort;
  followed_first: boolean;
};

export type UserBallotPreferencesErrorCode = "invalid_user_id" | "user_not_found" | "invalid_preferences";

export class UserBallotPreferencesError extends Error {
  constructor(
    readonly code: UserBallotPreferencesErrorCode,
    message: string
  ) {
    super(message);
    this.name = "UserBallotPreferencesError";
  }
}

function normalizeUserId(userId: string): string {
  const normalized = userId.trim();
  if (!isUuid(normalized)) {
    throw new UserBallotPreferencesError("invalid_user_id", "userId must be a UUID");
  }
  return normalized;
}

type BallotPreferencesRow = {
  user_exists: boolean;
  sort: string | null;
  followed_first: boolean | null;
};

// Returns the saved preferences, or the application defaults when the user has
// never saved any. Throws user_not_found for unknown/deleted users so the API
// keeps the same contract as the other /api/me preference readers.
//
// The default is ballot order for everyone, saved research areas or not: a
// user who wants their issues to order the list picks "My issues" (saved
// here). The earlier my_areas auto-default for users with saved areas is
// gone — the list opens the way the paper ballot reads.
export async function getUserBallotPreferences(db: Queryable, userId: string): Promise<UserBallotPreferences> {
  const normalizedUserId = normalizeUserId(userId);

  const result = await db.query<BallotPreferencesRow>(
    `
      SELECT
        true AS user_exists,
        preference.sort,
        preference.followed_first
      FROM public.users AS u
      LEFT JOIN public.user_ballot_preferences AS preference
        ON preference.user_id = u.id
      WHERE u.id = $1::uuid
        AND u.deleted_at IS NULL
    `,
    [normalizedUserId]
  );

  const row = result.rows[0];
  if (!row) {
    throw new UserBallotPreferencesError("user_not_found", "User not found");
  }
  if (row.sort === null || row.followed_first === null || !isSaveableBallotPreferenceSort(row.sort)) {
    return { ...DEFAULT_BALLOT_PREFERENCES };
  }
  return { sort: row.sort, followed_first: row.followed_first };
}

export async function setUserBallotPreferences(
  db: Queryable,
  userId: string,
  preferences: UserBallotPreferences
): Promise<UserBallotPreferences> {
  const normalizedUserId = normalizeUserId(userId);
  if (!isSaveableBallotPreferenceSort(preferences.sort) || typeof preferences.followed_first !== "boolean") {
    throw new UserBallotPreferencesError(
      "invalid_preferences",
      "preferences must include a valid sort and a boolean followed_first"
    );
  }

  const result = await db.query<{ sort: BallotSummarySort; followed_first: boolean }>(
    `
      INSERT INTO public.user_ballot_preferences (user_id, sort, followed_first)
      SELECT u.id, $2, $3
      FROM public.users AS u
      WHERE u.id = $1::uuid
        AND u.deleted_at IS NULL
      ON CONFLICT (user_id) DO UPDATE SET
        sort = EXCLUDED.sort,
        followed_first = EXCLUDED.followed_first,
        updated_at = now()
      RETURNING sort, followed_first
    `,
    [normalizedUserId, preferences.sort, preferences.followed_first]
  );

  const row = result.rows[0];
  if (!row) {
    throw new UserBallotPreferencesError("user_not_found", "User not found");
  }
  return { sort: row.sort, followed_first: row.followed_first };
}
