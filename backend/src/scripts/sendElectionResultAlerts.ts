import { pathToFileURL } from "node:url";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { readPositiveIntegerFlag } from "../utils/cliFlags.js";
import { displayElectionTitle } from "../utils/displayElectionTitle.js";
import { assertUnsubscribeLinksConfigured, buildUnsubscribeUrlBuilderFromEnv } from "./sendCandidateFollowDigests.js";
import {
  createConsoleElectionResultAlertMailer,
  createSesElectionResultAlertMailer,
  type ElectionResultAlertItem,
  type ElectionResultAlertMailer,
} from "../pipeline/users/electionResultAlertMailer.js";

// Delivery consumer for user_election_result_notification_events: sends one
// results email per user covering all their unsent decisive-result events,
// then stamps notified_at. Events that are no longer deliverable (user moved
// out of the district, turned the digest off, or the election's decisive
// result was corrected away) are resolved without email so they do not
// linger as forever-pending. Marking happens only after a successful send,
// so a crash between send and mark can duplicate an email but never lose
// one. Email-only by design; there is no push channel for results.
//
// Result alerts ride the email_digest opt-in ("subscribed with digest"), so
// the unsubscribe link is the digest unsubscribe.

export const DEFAULT_RESULT_ALERT_MAX_USERS = 500;
export const DEFAULT_RESULT_ALERT_MAX_ITEMS_PER_EMAIL = 20;

export const DECISIVE_RESULT_OUTCOMES_SQL = "('won', 'advanced', 'runoff', 'passed', 'failed')";

export type SendElectionResultAlertsOptions = {
  live: boolean;
  maxUsers: number;
  maxItemsPerEmail: number;
  /** Per-user signed unsubscribe link builder; omit to send without one. */
  buildUnsubscribeUrl?: (userId: string) => string;
};

export type SendElectionResultAlertsResult = {
  dryRun: boolean;
  /**
   * Events resolved (or countable as resolvable in dry run) without email.
   * Always table-wide: orphan cleanup is global housekeeping, deliberately
   * independent of --max-users, which caps only the email batch below.
   */
  resolvedWithoutEmailCount: number;
  /** Users with at least one valid pending event this run examined (capped by --max-users). */
  eligibleUserCount: number;
  /** Valid pending events found across eligible users. */
  eventsPendingCount: number;
  /** Result emails actually sent (includes sends whose mark step then failed). */
  usersEmailedCount: number;
  /** Events both sent and marked notified. */
  eventsDeliveredCount: number;
  /**
   * stage "send": the email did not go out; the next run retries it.
   * stage "mark_after_send": the email DID go out but stamping notified_at
   * failed, so the next run will re-send those events (at-least-once).
   */
  failures: Array<{ userId: string; stage: "send" | "mark_after_send"; reason: string }>;
};

type Queryable = Pick<Pool, "query">;

export function parseSendElectionResultAlertsArgs(argv: readonly string[]): SendElectionResultAlertsOptions {
  return {
    live: argv.includes("--live"),
    maxUsers: readPositiveIntegerFlag(argv, "--max-users", DEFAULT_RESULT_ALERT_MAX_USERS),
    maxItemsPerEmail: readPositiveIntegerFlag(
      argv,
      "--max-items-per-email",
      DEFAULT_RESULT_ALERT_MAX_ITEMS_PER_EMAIL
    ),
  };
}

// All result rows (office and ballot measure) that carry information.
// not_found / not_final_yet rows mean "the source had nothing yet" (the
// contract forces outcome=unknown on them) — they never mask an earlier
// decisive row. Rows with a real status (projected/unofficial/certified) do
// participate in canonical precedence: a non-decisive one there (too_close,
// unknown) is an authoritative correction that must suppress the alert
// instead of letting an older, retracted winner go out.
const INFORMATIVE_RESULT_ROWS_SQL = `
  SELECT election_id, outcome, winners, pass_type, retrieved_at
  FROM public.election_results
  WHERE result_status NOT IN ('not_found', 'not_final_yet')

  UNION ALL

  SELECT
    bm.election_id,
    bmr.outcome,
    '[]'::jsonb AS winners,
    bmr.pass_type,
    bmr.retrieved_at
  FROM public.ballot_measure_results AS bmr
  JOIN public.ballot_measures AS bm
    ON bm.id = bmr.ballot_measure_id
  WHERE bmr.result_status NOT IN ('not_found', 'not_final_yet')
`;

// An election "has a deliverable result" when its most authoritative
// informative row (certified over election_night, then freshest) is
// decisive. Selecting the top row FIRST and then requiring decisiveness is
// what lets a certified too_close/unknown correction override an older
// election-night winner.
const ELECTION_HAS_DELIVERABLE_RESULT_CONDITION = `
  COALESCE((
    SELECT r.outcome IN ${DECISIVE_RESULT_OUTCOMES_SQL}
    FROM (${INFORMATIVE_RESULT_ROWS_SQL}) AS r
    WHERE r.election_id = e.election_id
    ORDER BY
      CASE r.pass_type WHEN 'certified' THEN 1 ELSE 2 END,
      r.retrieved_at DESC
    LIMIT 1
  ), false)
`;

// An unsent event is orphaned when the user has turned the digest off, no
// longer lives in the election's district (moved), or the election's most
// authoritative result is no longer decisive (a correction downgraded it).
// A deleted election removes its events via ON DELETE CASCADE.
const ORPHANED_EVENT_CONDITION = `
  e.notified_at IS NULL
  AND (
    NOT EXISTS (
      SELECT 1
      FROM public.users AS u
      WHERE u.id = e.user_id
        AND u.deleted_at IS NULL
        AND u.email_digest = true
    )
    OR NOT EXISTS (
      SELECT 1
      FROM public.elections AS el
      JOIN public.user_districts AS ud
        ON ud.district_id = el.district_id
       AND ud.user_id = e.user_id
      WHERE el.id = e.election_id
    )
    OR NOT (${ELECTION_HAS_DELIVERABLE_RESULT_CONDITION})
  )
`;

async function resolveOrphanedEvents(db: Queryable, live: boolean): Promise<number> {
  if (!live) {
    const counted = await db.query<{ matched: string }>(
      `
        SELECT count(*)::text AS matched
        FROM public.user_election_result_notification_events AS e
        WHERE ${ORPHANED_EVENT_CONDITION}
      `
    );
    return Number(counted.rows[0]?.matched ?? 0);
  }
  const resolved = await db.query(
    `
      UPDATE public.user_election_result_notification_events AS e
      SET notified_at = now()
      WHERE ${ORPHANED_EVENT_CONDITION}
    `
  );
  return resolved.rowCount ?? 0;
}

type EligibleUserRow = {
  id: string;
  email: string;
  first_name: string;
};

async function selectEligibleUsers(db: Queryable, maxUsers: number): Promise<EligibleUserRow[]> {
  const result = await db.query<EligibleUserRow>(
    `
      SELECT u.id, u.email, u.first_name
      FROM public.users AS u
      WHERE u.deleted_at IS NULL
        AND u.email_verified = true
        AND u.email_digest = true
        AND EXISTS (
          -- Mirrors the deliverability conditions in selectPendingEvents so a
          -- user whose only unsent events are orphaned (moved away, result
          -- corrected away) cannot consume a --max-users slot. Matters in dry
          -- runs, where orphans are counted but not yet stamped.
          SELECT 1
          FROM public.user_election_result_notification_events AS e
          JOIN public.elections AS el
            ON el.id = e.election_id
          JOIN public.user_districts AS ud
            ON ud.user_id = e.user_id
           AND ud.district_id = el.district_id
          WHERE e.user_id = u.id
            AND e.notified_at IS NULL
            AND (${ELECTION_HAS_DELIVERABLE_RESULT_CONDITION})
        )
      ORDER BY u.id
      LIMIT $1::int
    `,
    [maxUsers]
  );
  return result.rows;
}

type PendingEventRow = {
  id: string;
  election_title: string;
  election_date: string;
  district_name: string;
  outcome: string;
  winners: unknown;
};

async function selectPendingEvents(db: Queryable, userId: string): Promise<PendingEventRow[]> {
  // ranked_results ranks every informative row (certified over
  // election_night, then freshest) and only THEN requires the selected row to
  // be decisive — so a certified too_close/unknown correction suppresses an
  // older election-night winner instead of letting it go out, while
  // not_found/not_final_yet rows (excluded upstream as information-free)
  // never mask a legitimate unofficial result awaiting certification.
  const result = await db.query<PendingEventRow>(
    `
      WITH ranked_results AS (
        SELECT
          er.election_id,
          er.outcome,
          er.winners,
          row_number() OVER (
            PARTITION BY er.election_id
            ORDER BY
              CASE er.pass_type WHEN 'certified' THEN 1 ELSE 2 END,
              er.retrieved_at DESC
          ) AS rn
        FROM (${INFORMATIVE_RESULT_ROWS_SQL}) AS er
      )
      SELECT
        e.id,
        el.official_ballot_title AS election_title,
        el.election_date::text AS election_date,
        d.name AS district_name,
        r.outcome,
        r.winners
      FROM public.user_election_result_notification_events AS e
      JOIN public.elections AS el
        ON el.id = e.election_id
      JOIN public.user_districts AS ud
        ON ud.user_id = e.user_id
       AND ud.district_id = el.district_id
      JOIN public.districts AS d
        ON d.id = el.district_id
      JOIN ranked_results AS r
        ON r.election_id = e.election_id
       AND r.rn = 1
       AND r.outcome IN ${DECISIVE_RESULT_OUTCOMES_SQL}
      WHERE e.user_id = $1::uuid
        AND e.notified_at IS NULL
      ORDER BY d.name, el.election_date, e.id
    `,
    [userId]
  );
  return result.rows;
}

function parseWinnerNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const winner = entry as Record<string, unknown>;
    const name = typeof winner.candidate_name === "string" ? winner.candidate_name.trim() : "";
    if (name.length === 0) {
      continue;
    }
    const party = typeof winner.party === "string" ? winner.party.trim() : "";
    names.push(party.length > 0 ? `${name} (${party})` : name);
  }
  return names;
}

function toAlertItem(row: PendingEventRow): ElectionResultAlertItem {
  return {
    electionTitle: displayElectionTitle(row.election_title),
    electionDate: row.election_date,
    districtName: row.district_name,
    outcome: row.outcome,
    winnerNames: parseWinnerNames(row.winners),
  };
}

async function markEventsNotified(db: Queryable, eventIds: readonly string[]): Promise<void> {
  await db.query(
    `
      UPDATE public.user_election_result_notification_events
      SET notified_at = now()
      WHERE id = ANY($1::uuid[])
        AND notified_at IS NULL
    `,
    [eventIds]
  );
}

export async function sendElectionResultAlerts(
  db: Queryable,
  mailer: ElectionResultAlertMailer,
  options: SendElectionResultAlertsOptions
): Promise<SendElectionResultAlertsResult> {
  const result: SendElectionResultAlertsResult = {
    dryRun: !options.live,
    resolvedWithoutEmailCount: 0,
    eligibleUserCount: 0,
    eventsPendingCount: 0,
    usersEmailedCount: 0,
    eventsDeliveredCount: 0,
    failures: [],
  };

  // Resolve orphans first so the send loop below only ever sees deliverable
  // events (in live mode; the dry run only counts them).
  result.resolvedWithoutEmailCount = await resolveOrphanedEvents(db, options.live);

  const users = await selectEligibleUsers(db, options.maxUsers);
  for (const user of users) {
    const pendingEvents = await selectPendingEvents(db, user.id);
    if (pendingEvents.length === 0) {
      // Only orphaned events (dry run) or nothing left; no email due.
      continue;
    }
    result.eligibleUserCount += 1;
    result.eventsPendingCount += pendingEvents.length;
    if (!options.live) {
      continue;
    }

    try {
      const unsubscribeUrl = options.buildUnsubscribeUrl?.(user.id);
      await mailer.sendResultAlertEmail({
        email: user.email,
        firstName: user.first_name,
        items: pendingEvents.slice(0, options.maxItemsPerEmail).map(toAlertItem),
        totalEventCount: pendingEvents.length,
        ...(unsubscribeUrl ? { unsubscribeUrl } : {}),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      result.failures.push({ userId: user.id, stage: "send", reason });
      continue;
    }
    result.usersEmailedCount += 1;

    try {
      await markEventsNotified(
        db,
        pendingEvents.map((event) => event.id)
      );
      result.eventsDeliveredCount += pendingEvents.length;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      result.failures.push({ userId: user.id, stage: "mark_after_send", reason });
    }
  }

  return result;
}

/**
 * App-unique advisory lock key for the live result-alert run (digest uses
 * 74_310_146, new-election alerts 74_310_147).
 */
export const ELECTION_RESULT_ALERT_RUN_LOCK_KEY = 74_310_148;

/**
 * Serializes live result-alert runs across processes with a Postgres session
 * advisory lock. The lock must live on one dedicated connection for the whole
 * run — pool.query() hops connections — so this checks out a client and holds
 * it until fn settles. Returns null without calling fn when another run
 * already holds the lock.
 */
export async function withElectionResultAlertRunLock<T>(
  pool: Pick<Pool, "connect">,
  fn: () => Promise<T>
): Promise<T | null> {
  const client = await pool.connect();
  let locked = false;
  try {
    const acquired = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [ELECTION_RESULT_ALERT_RUN_LOCK_KEY]
    );
    locked = acquired.rows[0]?.locked === true;
    if (!locked) {
      return null;
    }
    return await fn();
  } finally {
    // release() must survive an unlock failure (e.g. the connection died
    // mid-run): leaking the client would pin a pool slot for the process
    // lifetime in a long-lived worker.
    try {
      if (locked) {
        await client.query("SELECT pg_advisory_unlock($1)", [ELECTION_RESULT_ALERT_RUN_LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  }
}

function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

export function buildResultAlertMailerFromEnv(): ElectionResultAlertMailer {
  // Reuses the auth mailer configuration: result alerts go out from the same
  // sender identity. NOTIFICATIONS_MAILER=console overrides for local runs.
  const mailerKind = (readOptionalEnv("NOTIFICATIONS_MAILER") ?? readOptionalEnv("AUTH_MAILER") ?? "ses").toLowerCase();
  if (mailerKind === "console") {
    return createConsoleElectionResultAlertMailer();
  }
  if (mailerKind !== "ses") {
    throw new Error(`Unsupported notifications mailer: ${mailerKind} (expected "ses" or "console")`);
  }
  const fromEmailAddress = readOptionalEnv("AUTH_FROM_EMAIL");
  const sesRegion =
    readOptionalEnv("AUTH_SES_REGION") ?? readOptionalEnv("AWS_REGION") ?? readOptionalEnv("AWS_DEFAULT_REGION");
  if (!fromEmailAddress || !sesRegion) {
    throw new Error(
      "SES result alert mailer requires AUTH_FROM_EMAIL and AUTH_SES_REGION/AWS_REGION (or set NOTIFICATIONS_MAILER=console)"
    );
  }
  assertUnsubscribeLinksConfigured("SES result alert mailer");
  const replyToEmailAddress = readOptionalEnv("AUTH_REPLY_TO_EMAIL");
  return createSesElectionResultAlertMailer({
    sesClient: new SESv2Client({ region: sesRegion }),
    fromEmailAddress,
    ...(replyToEmailAddress ? { replyToEmailAddress } : {}),
  });
}

async function main(): Promise<void> {
  loadProjectEnv();
  const parsedOptions = parseSendElectionResultAlertsArgs(process.argv.slice(2));
  // Result alerts ride the digest opt-in, so the digest unsubscribe applies.
  const buildUnsubscribeUrl = buildUnsubscribeUrlBuilderFromEnv("digest");
  const options: SendElectionResultAlertsOptions = {
    ...parsedOptions,
    ...(buildUnsubscribeUrl ? { buildUnsubscribeUrl } : {}),
  };
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to send election result alerts");
  }

  // The dry run never sends, so it must not require mailer configuration.
  const mailer: ElectionResultAlertMailer = options.live
    ? buildResultAlertMailerFromEnv()
    : {
        async sendResultAlertEmail() {
          throw new Error("Dry run must not send email");
        },
      };

  const pool = new Pool({ connectionString });
  try {
    // Dry runs read without marking, so they run unlocked.
    const result = options.live
      ? await withElectionResultAlertRunLock(pool, () => sendElectionResultAlerts(pool, mailer, options))
      : await sendElectionResultAlerts(pool, mailer, options);
    if (result === null) {
      console.log(JSON.stringify({ skipped: true, reason: "another result alert run holds the lock" }, null, 2));
      return;
    }
    console.log(
      JSON.stringify(
        {
          ...result,
          ...(options.live ? {} : { next: "re-run with --live to send" }),
        },
        null,
        2
      )
    );
    if (result.failures.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("election result alert send failed:", message);
    process.exitCode = 1;
  });
}
