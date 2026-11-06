import type { Pool, PoolClient } from "pg";

import { isJudicialRetentionTitle } from "../../ai/electionPartisanshipPolicy.js";
import { isUuid } from "../../utils/uuid.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type ElectionResultNotificationEventCreationResult = {
  createdCount: number;
};

export class ElectionResultNotificationEventsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElectionResultNotificationEventsError";
  }
}

/**
 * Fans a batch of elections that just received a decisive result out to users
 * who live in the election's district and have the email digest on. The
 * caller (the election-result writer) passes only elections whose freshly
 * written result row has a decisive outcome (won/advanced/runoff for offices,
 * passed/failed for measures) — not_found/not_final_yet/unknown rows never
 * notify. The (user, election) unique constraint makes re-writes (the
 * certified pass after election night, corrections) no-ops, so each user is
 * notified at most once per election. Verified-email filtering happens at
 * send time, not here, so a user who verifies later still gets the alert.
 */
export async function createElectionResultNotificationEvents(
  db: Queryable,
  electionIds: readonly string[]
): Promise<ElectionResultNotificationEventCreationResult> {
  if (electionIds.length === 0) {
    return { createdCount: 0 };
  }
  const normalizedElectionIds = electionIds.map((electionId) => {
    const normalized = electionId.trim();
    if (!isUuid(normalized)) {
      throw new ElectionResultNotificationEventsError("Election IDs must be valid UUIDs");
    }
    return normalized;
  });

  // Judicial retention questions ("Shall Judge X be retained?") are left out
  // of result alerts: they are near-certain yes votes and crowd the email.
  // The title rule is the same one the partisanship policy uses.
  const titles = await db.query<{ id: string; official_ballot_title: string }>(
    `
      SELECT id, official_ballot_title
      FROM public.elections
      WHERE id = ANY($1::uuid[])
    `,
    [normalizedElectionIds]
  );
  const alertableElectionIds = titles.rows
    .filter((row) => !isJudicialRetentionTitle(row.official_ballot_title))
    .map((row) => row.id);
  if (alertableElectionIds.length === 0) {
    return { createdCount: 0 };
  }

  const result = await db.query<{ id: string }>(
    `
      WITH source_elections AS (
        SELECT
          election.id AS election_id,
          election.district_id
        FROM public.elections AS election
        WHERE election.id = ANY($1::uuid[])
      ),
      eligible_users AS (
        SELECT
          user_district.user_id,
          source_elections.election_id
        FROM source_elections
        JOIN public.user_districts AS user_district
          ON user_district.district_id = source_elections.district_id
        JOIN public.users AS user_row
          ON user_row.id = user_district.user_id
        WHERE user_row.deleted_at IS NULL
          AND user_row.email_digest = true
      )
      INSERT INTO public.user_election_result_notification_events (
        user_id,
        election_id
      )
      SELECT
        eligible_users.user_id,
        eligible_users.election_id
      FROM eligible_users
      ON CONFLICT DO NOTHING
      RETURNING id
    `,
    [alertableElectionIds]
  );

  return { createdCount: result.rowCount ?? result.rows.length };
}
