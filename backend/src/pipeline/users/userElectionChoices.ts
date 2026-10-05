import type { Pool, PoolClient } from "pg";

import { isUuid } from "../../utils/uuid.js";
import { displayElectionTitle } from "../../utils/displayElectionTitle.js";
import { US_LATEST_LOCAL_DATE_SQL } from "../../utils/usLocalDate.js";
import { isJudicialRetentionTitle } from "../../ai/electionPartisanshipPolicy.js";
import { loadCanonicalElectionResults } from "../electionResults/canonicalElectionResults.js";
import type { CanonicalElectionResultWinner } from "../electionResults/canonicalElectionResults.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type TransactionalDb = Pick<Pool, "connect">;
type TransactionClient = Pick<PoolClient, "query" | "release">;

export type UserElectionChoicePick = {
  candidate_id: string;
  display_name: string;
  /** candidate_elections.status at read time — a pick made before a
   * withdrawal stays visible so the UI can flag it, not silently vanish. */
  candidacy_status: string;
  /** 'auto' while the row is auto-pick's; any manual re-pick flips it back
   * to 'manual'. Lets the UI badge auto picks and clear only those rows. */
  origin: "manual" | "auto";
};

export type UserElectionChoice = {
  election_id: string;
  race_type: "office" | "ballot_measure";
  official_ballot_title: string;
  election_date: string;
  seats_to_fill: number | null;
  picks: UserElectionChoicePick[];
  measure_position: "yes" | "no" | null;
  /** The measure row's origin (measures have no picks array to carry it);
   * null when there is no measure position. */
  measure_origin: "manual" | "auto" | null;
  /** ballot_measures.result at read time ("passed"/"failed" once certified
   * results land, null before) — lets a measure pick show its outcome the
   * way candidacy_status lets a candidate pick show won/lost. */
  measure_result: string | null;
  /** The election's canonical result (certified over election_night, then
   * freshest), attached on the LIST read only: picks history outlives the
   * ballot's just-finished window, and without this an election-night call
   * would vanish from history until certification flips candidacy_status —
   * weeks later. The post-write read-back leaves these empty (null / [])
   * because writes are gated to races the ballot still cards, where the
   * ballot summary carries the same fields. */
  current_result_outcome: string | null;
  current_result_winners: CanonicalElectionResultWinner[];
  updated_at: string;
};

export type UserElectionChoicesResult = {
  choices: UserElectionChoice[];
};

export type UserElectionChoiceInput =
  | { electionId: string; candidateId: string; chosen: boolean }
  | { electionId: string; measurePosition: "yes" | "no" | null };

export type UserElectionChoiceUpdateResult = {
  choice: UserElectionChoice;
};

export type UserElectionChoicesErrorCode =
  | "invalid_user_id"
  | "invalid_election_id"
  | "invalid_candidate_id"
  | "invalid_choice_input"
  | "user_not_found"
  | "election_not_found"
  | "election_closed"
  | "candidacy_not_available"
  | "choice_limit_reached";

export class UserElectionChoicesError extends Error {
  constructor(
    readonly code: UserElectionChoicesErrorCode,
    message: string
  ) {
    super(message);
    this.name = "UserElectionChoicesError";
  }
}

type ChoiceRow = {
  election_id: string;
  race_type: "office" | "ballot_measure";
  official_ballot_title: string;
  election_date: string;
  seats_to_fill: number | null;
  candidate_id: string | null;
  display_name: string | null;
  candidacy_status: string | null;
  measure_position: "yes" | "no" | null;
  origin: "manual" | "auto";
  measure_result: string | null;
  updated_at: string | Date;
};

type ElectionRow = {
  id: string;
  race_type: "office" | "ballot_measure";
  official_ballot_title: string;
  election_date: string;
  seats_to_fill: number | null;
  is_upcoming: boolean;
};

/**
 * Judicial retention races are catalogued as office races with the judge as
 * the single candidate, but the ballot asks Yes/No ("Shall Judge X be
 * retained?"). Voters answer them with measure_position: "yes" keeps the
 * judge, "no" removes them. A candidate pick from an older client is
 * translated to "yes" (that is what the printed preview always showed for
 * it) so exactly one representation exists per retention race.
 */
function isRetentionRace(election: Pick<ElectionRow, "race_type" | "official_ballot_title">): boolean {
  return (
    election.race_type === "office" &&
    typeof election.official_ballot_title === "string" &&
    isJudicialRetentionTitle(election.official_ballot_title)
  );
}

type ChoiceRowKind = "candidate" | "measure" | "all";

async function deleteChoiceRows(
  client: Queryable,
  normalizedUserId: string,
  normalizedElectionId: string,
  kind: ChoiceRowKind
): Promise<void> {
  const kindClause =
    kind === "candidate"
      ? "AND candidate_id IS NOT NULL"
      : kind === "measure"
        ? "AND measure_position IS NOT NULL"
        : "";
  await client.query(
    `
      DELETE FROM public.user_election_choices
      WHERE user_id = $1::uuid
        AND election_id = $2::uuid
        ${kindClause}
    `,
    [normalizedUserId, normalizedElectionId]
  );
}

function normalizeUserId(userId: string): string {
  const normalized = userId.trim();
  if (!isUuid(normalized)) {
    throw new UserElectionChoicesError("invalid_user_id", "User ID must be a valid UUID");
  }
  return normalized;
}

function normalizeElectionId(electionId: string): string {
  const normalized = electionId.trim();
  if (!isUuid(normalized)) {
    throw new UserElectionChoicesError("invalid_election_id", "Election ID must be a valid UUID");
  }
  return normalized;
}

function normalizeCandidateId(candidateId: string): string {
  const normalized = candidateId.trim();
  if (!isUuid(normalized)) {
    throw new UserElectionChoicesError("invalid_candidate_id", "Candidate ID must be a valid UUID");
  }
  return normalized;
}

function formatTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
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
    throw new UserElectionChoicesError("user_not_found", "User not found");
  }
}

// Shared by the list read and the post-write read-back so both return the
// same shape. Rows whose candidate has since been deleted or merged drop
// out (display_name join fails); withdrawn candidacies stay, flagged by
// candidacy_status, so a user's pick never silently disappears.
const CHOICE_ROWS_SQL = `
  SELECT
    choice.election_id::text AS election_id,
    election.race_type,
    election.official_ballot_title,
    election.election_date::text AS election_date,
    election.seats_to_fill,
    choice.candidate_id::text AS candidate_id,
    COALESCE(
      NULLIF(trim(candidate.display_name), ''),
      trim(concat_ws(' ', candidate.first_name, candidate.last_name))
    ) AS display_name,
    candidate_election.status AS candidacy_status,
    choice.measure_position,
    choice.origin,
    measure.result AS measure_result,
    choice.updated_at
  FROM public.user_election_choices AS choice
  JOIN public.elections AS election
    ON election.id = choice.election_id
  LEFT JOIN public.candidates AS candidate
    ON candidate.id = choice.candidate_id
   AND candidate.deleted_at IS NULL
   AND candidate.merged_into_candidate_id IS NULL
  LEFT JOIN public.candidate_elections AS candidate_election
    ON candidate_election.candidate_id = choice.candidate_id
   AND candidate_election.election_id = choice.election_id
  LEFT JOIN public.ballot_measures AS measure
    ON measure.election_id = election.id
  WHERE choice.user_id = $1::uuid
`;

function rowsToChoices(rows: ChoiceRow[]): UserElectionChoice[] {
  const byElection = new Map<string, UserElectionChoice>();
  for (const row of rows) {
    let choice = byElection.get(row.election_id);
    if (!choice) {
      choice = {
        election_id: row.election_id,
        race_type: row.race_type,
        official_ballot_title: displayElectionTitle(row.official_ballot_title),
        election_date: row.election_date,
        seats_to_fill: row.seats_to_fill,
        picks: [],
        measure_position: null,
        measure_origin: null,
        measure_result: row.measure_result,
        current_result_outcome: null,
        current_result_winners: [],
        updated_at: formatTimestamp(row.updated_at),
      };
      byElection.set(row.election_id, choice);
    }
    const rowUpdatedAt = formatTimestamp(row.updated_at);
    if (rowUpdatedAt > choice.updated_at) {
      choice.updated_at = rowUpdatedAt;
    }
    if (row.measure_position !== null) {
      choice.measure_position = row.measure_position;
      choice.measure_origin = row.origin;
    } else if (row.candidate_id && row.display_name && row.candidacy_status) {
      choice.picks.push({
        candidate_id: row.candidate_id,
        display_name: row.display_name,
        candidacy_status: row.candidacy_status,
        origin: row.origin,
      });
    }
  }
  // A measure row always renders; an office election whose only picked
  // candidate has been deleted has nothing left to show.
  return [...byElection.values()].filter(
    (choice) => choice.picks.length > 0 || choice.measure_position !== null
  );
}

export async function listUserElectionChoices(db: Queryable, userId: string): Promise<UserElectionChoicesResult> {
  const normalizedUserId = normalizeUserId(userId);
  await assertActiveUser(db, normalizedUserId, false);
  const result = await db.query<ChoiceRow>(
    `
      ${CHOICE_ROWS_SQL}
      ORDER BY election.election_date ASC, election.id ASC, choice.created_at ASC, choice.id ASC
    `,
    [normalizedUserId]
  );
  const choices = rowsToChoices(result.rows);
  if (choices.length > 0) {
    // See current_result_outcome on UserElectionChoice for why the list read
    // alone carries the canonical result.
    const canonical = await loadCanonicalElectionResults(
      db,
      choices.map((choice) => choice.election_id)
    );
    for (const choice of choices) {
      const canonicalResult = canonical.get(choice.election_id);
      if (canonicalResult) {
        choice.current_result_outcome = canonicalResult.outcome;
        choice.current_result_winners = canonicalResult.winners;
      }
    }
  }
  return { choices };
}

async function readElectionChoice(
  db: Queryable,
  normalizedUserId: string,
  normalizedElectionId: string,
  election: ElectionRow
): Promise<UserElectionChoice> {
  const result = await db.query<ChoiceRow>(
    `
      ${CHOICE_ROWS_SQL}
        AND choice.election_id = $2::uuid
      ORDER BY choice.created_at ASC, choice.id ASC
    `,
    [normalizedUserId, normalizedElectionId]
  );
  const choices = rowsToChoices(result.rows);
  if (choices[0]) {
    return choices[0];
  }
  // Everything cleared: return the empty state so the caller can render it.
  return {
    election_id: normalizedElectionId,
    race_type: election.race_type,
    official_ballot_title: "",
    election_date: election.election_date,
    seats_to_fill: election.seats_to_fill,
    picks: [],
    measure_position: null,
    measure_origin: null,
    measure_result: null,
    current_result_outcome: null,
    current_result_winners: [],
    updated_at: new Date().toISOString(),
  };
}

async function readElection(db: Queryable, normalizedElectionId: string): Promise<ElectionRow> {
  const result = await db.query<ElectionRow>(
    `
      SELECT
        id::text AS id,
        race_type,
        official_ballot_title,
        election_date::text AS election_date,
        seats_to_fill,
        election_date >= ${US_LATEST_LOCAL_DATE_SQL} AS is_upcoming
      FROM public.elections
      WHERE id = $1::uuid
      -- Do not add a row-locking clause here. PostgreSQL requires UPDATE
      -- privilege for locking SELECTs, while the API role intentionally has
      -- SELECT-only access to election catalog tables.
    `,
    [normalizedElectionId]
  );
  const election = result.rows[0];
  if (!election) {
    throw new UserElectionChoicesError("election_not_found", "Election not found");
  }
  if (!election.is_upcoming) {
    throw new UserElectionChoicesError("election_closed", "Choices can only be changed for upcoming elections");
  }
  return election;
}

async function assertCandidacyAvailable(
  client: Queryable,
  normalizedCandidateId: string,
  normalizedElectionId: string
): Promise<void> {
  const candidacy = await client.query<{ candidate_id: string }>(
    `
      SELECT candidate_election.candidate_id::text AS candidate_id
      FROM public.candidate_elections AS candidate_election
      JOIN public.candidates AS candidate
        ON candidate.id = candidate_election.candidate_id
       AND candidate.deleted_at IS NULL
       AND candidate.merged_into_candidate_id IS NULL
      WHERE candidate_election.candidate_id = $1::uuid
        AND candidate_election.election_id = $2::uuid
        AND candidate_election.status NOT IN ('withdrawn', 'lost')
    `,
    [normalizedCandidateId, normalizedElectionId]
  );
  if (candidacy.rows.length === 0) {
    throw new UserElectionChoicesError("candidacy_not_available", "Candidate is not an active candidate in this election");
  }
}

/**
 * Upserts the user's Yes/No answer. Same-statement gate as the candidate
 * pick insert: the election window and race type are re-asserted under the
 * INSERT's own snapshot. `retention` widens the race-type gate to office
 * rows (the title check happened in this transaction) and first removes
 * any candidate row for the race, because the two partial unique indexes
 * are independent and would otherwise let a judge pick and a No answer
 * coexist.
 */
async function writeMeasurePosition(
  client: Queryable,
  normalizedUserId: string,
  normalizedElectionId: string,
  position: "yes" | "no",
  retention: boolean
): Promise<void> {
  if (retention) {
    await deleteChoiceRows(client, normalizedUserId, normalizedElectionId, "candidate");
  }
  const inserted = await client.query(
    `
      INSERT INTO public.user_election_choices (user_id, election_id, measure_position)
      SELECT $1::uuid, election.id, $3
      FROM public.elections AS election
      WHERE election.id = $2::uuid
        AND election.race_type = ANY($4::text[])
        AND election.election_date >= ${US_LATEST_LOCAL_DATE_SQL}
      ON CONFLICT (user_id, election_id) WHERE measure_position IS NOT NULL
      DO UPDATE SET measure_position = EXCLUDED.measure_position, origin = 'manual', updated_at = now()
    `,
    [normalizedUserId, normalizedElectionId, position, retention ? ["office"] : ["ballot_measure"]]
  );
  if ((inserted.rowCount ?? 0) === 0) {
    // readElection throws election_not_found / election_closed as
    // appropriate; a same-transaction race_type flip is the only other way
    // through, and the closed-window error is the honest fallback.
    await readElection(client, normalizedElectionId);
    throw new UserElectionChoicesError("election_closed", "Choices can only be changed for upcoming elections");
  }
}

export async function setUserElectionChoice(
  db: TransactionalDb,
  userId: string,
  input: UserElectionChoiceInput
): Promise<UserElectionChoiceUpdateResult> {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedElectionId = normalizeElectionId(input.electionId);
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    // FOR UPDATE on the user row serializes this user's choice writes, which
    // makes the count-then-insert seat cap below race-safe.
    await assertActiveUser(client, normalizedUserId, true);
    const election = await readElection(client, normalizedElectionId);

    const retention = isRetentionRace(election);

    if ("candidateId" in input) {
      if (election.race_type !== "office") {
        throw new UserElectionChoicesError(
          "invalid_choice_input",
          "Candidate choices apply to office elections; use measure_position for ballot measures"
        );
      }
      const normalizedCandidateId = normalizeCandidateId(input.candidateId);
      if (typeof input.chosen !== "boolean") {
        throw new UserElectionChoicesError("invalid_choice_input", "chosen must be a boolean");
      }

      if (retention) {
        // Older clients and guest-draft sync still send candidate picks for
        // retention races. Keep accepting them, but store the answer the
        // way the UI now asks it: picking the judge = "yes", unpicking =
        // cleared. Never reject an old client.
        if (!input.chosen) {
          await deleteChoiceRows(client, normalizedUserId, normalizedElectionId, "all");
        } else {
          await assertCandidacyAvailable(client, normalizedCandidateId, normalizedElectionId);
          await writeMeasurePosition(client, normalizedUserId, normalizedElectionId, "yes", true);
        }
      } else if (!input.chosen) {
        await client.query(
          `
            DELETE FROM public.user_election_choices
            WHERE user_id = $1::uuid
              AND election_id = $2::uuid
              AND candidate_id = $3::uuid
          `,
          [normalizedUserId, normalizedElectionId, normalizedCandidateId]
        );
      } else {
        // Plain read (the SELECT-only API role cannot take row locks). This
        // pre-check only exists to fail fast with a specific error before the
        // seat-cap work below; the INSERT further down re-asserts the same
        // eligibility predicate in its own statement, which is the enforced
        // boundary if the candidacy changes between here and there.
        await assertCandidacyAvailable(client, normalizedCandidateId, normalizedElectionId);

        // NULL seats_to_fill means "seat count never recorded", which the
        // product renders as a single seat everywhere; the cap follows suit.
        const seatCap = election.seats_to_fill ?? 1;
        const existing = await client.query<{ count: string }>(
          `
            SELECT count(*)::text AS count
            FROM public.user_election_choices
            WHERE user_id = $1::uuid
              AND election_id = $2::uuid
              AND candidate_id IS NOT NULL
              AND candidate_id <> $3::uuid
          `,
          [normalizedUserId, normalizedElectionId, normalizedCandidateId]
        );
        const otherPickCount = Number(existing.rows[0]?.count ?? "0");
        if (otherPickCount >= seatCap) {
          if (seatCap === 1) {
            // Single-seat races behave like a radio button: picking a new
            // candidate replaces the old pick instead of erroring.
            await client.query(
              `
                DELETE FROM public.user_election_choices
                WHERE user_id = $1::uuid
                  AND election_id = $2::uuid
                  AND candidate_id IS NOT NULL
              `,
              [normalizedUserId, normalizedElectionId]
            );
          } else {
            throw new UserElectionChoicesError(
              "choice_limit_reached",
              `This election fills ${seatCap} seats; remove a pick before adding another`
            );
          }
        }

        // Check-and-write in ONE statement: the SELECT re-asserts candidacy
        // eligibility and the election window under the same snapshot the
        // INSERT writes with, so a catalog change COMMITTED after the
        // pre-checks above is caught here. A catalog transaction still open
        // when this statement takes its snapshot is NOT caught (MVCC reads
        // lock nothing) — accepted, deliberately: a pick on a since-withdrawn
        // candidacy is also the normal product of time (pick first,
        // withdrawal later), so the read path renders candidacy_status
        // truthfully rather than pretending the state can't exist, and a
        // lock here would only remove this one rare entry path at the cost
        // of UPDATE privilege the API role must not hold. Do not "fix" this
        // with advisory locks either: prod catalog writes are operator-run
        // SQL that would not participate.
        //
        // origin: this is the manual write path, so a re-pick of a row that
        // auto-pick wrote (origin = 'auto') becomes the user's own — the
        // column default covers fresh rows.
        const inserted = await client.query(
          `
            INSERT INTO public.user_election_choices (user_id, election_id, candidate_id)
            SELECT $1::uuid, candidate_election.election_id, candidate_election.candidate_id
            FROM public.candidate_elections AS candidate_election
            JOIN public.candidates AS candidate
              ON candidate.id = candidate_election.candidate_id
             AND candidate.deleted_at IS NULL
             AND candidate.merged_into_candidate_id IS NULL
            JOIN public.elections AS election
              ON election.id = candidate_election.election_id
             AND election.election_date >= ${US_LATEST_LOCAL_DATE_SQL}
            WHERE candidate_election.candidate_id = $3::uuid
              AND candidate_election.election_id = $2::uuid
              AND candidate_election.status NOT IN ('withdrawn', 'lost')
            ON CONFLICT (user_id, election_id, candidate_id) WHERE candidate_id IS NOT NULL
            DO UPDATE SET origin = 'manual', updated_at = now()
          `,
          [normalizedUserId, normalizedElectionId, normalizedCandidateId]
        );
        if ((inserted.rowCount ?? 0) === 0) {
          // The gate refused: the catalog moved under us. Re-read the
          // election to surface election_closed when the window is what
          // changed; otherwise it was the candidacy.
          await readElection(client, normalizedElectionId);
          throw new UserElectionChoicesError(
            "candidacy_not_available",
            "Candidate is not an active candidate in this election"
          );
        }
      }
    } else {
      if (election.race_type !== "ballot_measure" && !retention) {
        throw new UserElectionChoicesError(
          "invalid_choice_input",
          "measure_position applies to ballot-measure elections; use candidate_id for office races"
        );
      }
      if (input.measurePosition === null) {
        // A retention race may still hold a candidate row from an older
        // client; clearing means clearing the whole answer.
        await deleteChoiceRows(client, normalizedUserId, normalizedElectionId, retention ? "all" : "measure");
      } else {
        if (input.measurePosition !== "yes" && input.measurePosition !== "no") {
          throw new UserElectionChoicesError("invalid_choice_input", "measure_position must be 'yes', 'no', or null");
        }
        await writeMeasurePosition(client, normalizedUserId, normalizedElectionId, input.measurePosition, retention);
      }
    }

    const choice = await readElectionChoice(client, normalizedUserId, normalizedElectionId, election);
    await client.query("COMMIT");
    return { choice };
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}
