import { pathToFileURL } from "node:url";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { Pool } from "pg";

import { APP_NAME } from "../constants/brand.js";
import { loadProjectEnv } from "../config/env.js";
import { readPositiveIntegerFlag } from "../utils/cliFlags.js";
import { displayElectionTitle } from "../utils/displayElectionTitle.js";
import { assertUnsubscribeLinksConfigured, buildUnsubscribeUrlBuilderFromEnv } from "./sendCandidateFollowDigests.js";
import { US_LATEST_LOCAL_DATE_SQL } from "../utils/usLocalDate.js";
import {
  createConsoleNewElectionAlertMailer,
  createSesNewElectionAlertMailer,
  type NewElectionAlertItem,
  type NewElectionAlertMailer,
} from "../pipeline/users/newElectionAlertMailer.js";
import {
  buildPushClientFromEnv,
  processMaturePushReceipts,
  sendUserPushNotification,
  type PushNotificationClient,
} from "../pipeline/users/pushNotificationSender.js";

// Delivery consumer for user_district_notification_events: sends one alert
// email per user covering all their unsent new-election events, then stamps
// notified_at. Events that are no longer deliverable (user moved out of the
// district, turned alerts off, or the election date has passed) are resolved
// without email so they do not linger as forever-pending. Marking happens
// only after a successful send, so a crash between send and mark can
// duplicate an email but never lose one.
//
// Push is a best-effort second channel on the same events: after the email
// goes out (the durable, at-least-once channel), a summary push goes to the
// user's registered devices. Push failures never block marking — the email
// already delivered the content — and a run also checks the mature Expo
// receipts stored by earlier runs so dead device tokens get revoked.

export const DEFAULT_ALERT_MAX_USERS = 500;
export const DEFAULT_ALERT_MAX_ITEMS_PER_EMAIL = 20;

export type SendNewElectionAlertsOptions = {
  live: boolean;
  maxUsers: number;
  maxItemsPerEmail: number;
  /** Per-user signed unsubscribe link builder; omit to send without one. */
  buildUnsubscribeUrl?: (userId: string) => string;
  /** Expo push client; omit to skip the push channel entirely. */
  pushClient?: PushNotificationClient;
};

export type SendNewElectionAlertsResult = {
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
  /** Alert emails actually sent (includes sends whose mark step then failed). */
  usersEmailedCount: number;
  /** Events both sent and marked notified. */
  eventsDeliveredCount: number;
  /** Users who received at least one summary push (best-effort channel). */
  usersPushedCount: number;
  /** Device tokens revoked this run (invalid, or Expo said DeviceNotRegistered). */
  pushTokensRevokedCount: number;
  /** Mature Expo receipts from earlier runs checked at run start. */
  pushReceiptsCheckedCount: number;
  /**
   * stage "send": the email did not go out; the next run retries it.
   * stage "mark_after_send": the email DID go out but stamping notified_at
   * failed, so the next run will re-send those events (at-least-once).
   * stage "push_send": the email went out but the summary push did not;
   * events are still marked (push is best-effort).
   */
  failures: Array<{ userId: string; stage: "send" | "mark_after_send" | "push_send"; reason: string }>;
};

type Queryable = Pick<Pool, "query">;

export function parseSendNewElectionAlertsArgs(argv: readonly string[]): SendNewElectionAlertsOptions {
  return {
    live: argv.includes("--live"),
    maxUsers: readPositiveIntegerFlag(argv, "--max-users", DEFAULT_ALERT_MAX_USERS),
    maxItemsPerEmail: readPositiveIntegerFlag(argv, "--max-items-per-email", DEFAULT_ALERT_MAX_ITEMS_PER_EMAIL),
  };
}

// An unsent event is orphaned when the user has turned alerts off, no longer
// lives in the election's district (moved), or the election date has passed.
// A deleted election removes its events via ON DELETE CASCADE.
const ORPHANED_EVENT_CONDITION = `
  e.notified_at IS NULL
  AND (
    NOT EXISTS (
      SELECT 1
      FROM public.users AS u
      WHERE u.id = e.user_id
        AND u.deleted_at IS NULL
        AND u.email_new_election_alerts = true
    )
    OR NOT EXISTS (
      SELECT 1
      FROM public.elections AS el
      JOIN public.user_districts AS ud
        ON ud.district_id = el.district_id
       AND ud.user_id = e.user_id
      WHERE el.id = e.election_id
        AND el.election_date >= ${US_LATEST_LOCAL_DATE_SQL}
    )
  )
`;

async function resolveOrphanedEvents(db: Queryable, live: boolean): Promise<number> {
  if (!live) {
    const counted = await db.query<{ matched: string }>(
      `
        SELECT count(*)::text AS matched
        FROM public.user_district_notification_events AS e
        WHERE ${ORPHANED_EVENT_CONDITION}
      `
    );
    return Number(counted.rows[0]?.matched ?? 0);
  }
  const resolved = await db.query(
    `
      UPDATE public.user_district_notification_events AS e
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
        AND u.email_new_election_alerts = true
        AND EXISTS (
          -- Mirrors the deliverability joins in selectPendingEvents so a user
          -- whose only unsent events are orphaned (moved away, election past)
          -- cannot consume a --max-users slot. Matters in dry runs, where
          -- orphans are counted but not yet stamped.
          SELECT 1
          FROM public.user_district_notification_events AS e
          JOIN public.elections AS el
            ON el.id = e.election_id
           AND el.election_date >= ${US_LATEST_LOCAL_DATE_SQL}
          JOIN public.user_districts AS ud
            ON ud.user_id = e.user_id
           AND ud.district_id = el.district_id
          WHERE e.user_id = u.id
            AND e.notified_at IS NULL
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
};

async function selectPendingEvents(db: Queryable, userId: string): Promise<PendingEventRow[]> {
  const result = await db.query<PendingEventRow>(
    `
      SELECT
        e.id,
        el.official_ballot_title AS election_title,
        el.election_date::text AS election_date,
        d.name AS district_name
      FROM public.user_district_notification_events AS e
      JOIN public.elections AS el
        ON el.id = e.election_id
       AND el.election_date >= ${US_LATEST_LOCAL_DATE_SQL}
      JOIN public.user_districts AS ud
        ON ud.user_id = e.user_id
       AND ud.district_id = el.district_id
      JOIN public.districts AS d
        ON d.id = el.district_id
      WHERE e.user_id = $1::uuid
        AND e.notified_at IS NULL
      ORDER BY d.name, el.election_date, e.id
    `,
    [userId]
  );
  return result.rows;
}

function toAlertItem(row: PendingEventRow): NewElectionAlertItem {
  return {
    electionTitle: displayElectionTitle(row.election_title),
    electionDate: row.election_date,
    districtName: row.district_name,
  };
}

async function markEventsNotified(db: Queryable, eventIds: readonly string[]): Promise<void> {
  await db.query(
    `
      UPDATE public.user_district_notification_events
      SET notified_at = now()
      WHERE id = ANY($1::uuid[])
        AND notified_at IS NULL
    `,
    [eventIds]
  );
}

export async function sendNewElectionAlerts(
  db: Queryable,
  mailer: NewElectionAlertMailer,
  options: SendNewElectionAlertsOptions
): Promise<SendNewElectionAlertsResult> {
  const result: SendNewElectionAlertsResult = {
    dryRun: !options.live,
    resolvedWithoutEmailCount: 0,
    eligibleUserCount: 0,
    eventsPendingCount: 0,
    usersEmailedCount: 0,
    eventsDeliveredCount: 0,
    usersPushedCount: 0,
    pushTokensRevokedCount: 0,
    pushReceiptsCheckedCount: 0,
    failures: [],
  };

  // Follow up on earlier runs' push sends before producing new ones, so dead
  // tokens stop receiving before this run's fan-out. Live only: receipt
  // processing mutates (revokes tokens, deletes checked rows). Best-effort
  // like every other push step: a transient Expo/DB failure here must not
  // abort the run before any email goes out — the unchecked receipts stay
  // stored and the next run picks them up.
  if (options.live && options.pushClient) {
    try {
      const receipts = await processMaturePushReceipts(db, options.pushClient);
      result.pushReceiptsCheckedCount = receipts.checkedCount;
      result.pushTokensRevokedCount += receipts.revokedTokenCount;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`push receipt processing failed; continuing the run: ${reason}`);
    }
  }

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
      await mailer.sendAlertEmail({
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

    // Summary push to the user's registered devices. After the email (the
    // durable channel) and before marking: a crash here re-sends both next
    // run (at-least-once), and a push failure never blocks marking.
    if (options.pushClient) {
      try {
        const pushed = await sendUserPushNotification(db, options.pushClient, user.id, {
          title: APP_NAME,
          body: buildAlertSubjectLine(pendingEvents.length),
          url: "/my-ballot",
        });
        result.pushTokensRevokedCount += pushed.revokedTokenCount;
        if (pushed.sentCount > 0) {
          result.usersPushedCount += 1;
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        result.failures.push({ userId: user.id, stage: "push_send", reason });
      }
    }

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

/** Push body: the email subject's copy without the bracketed brand prefix. */
function buildAlertSubjectLine(totalEventCount: number): string {
  const noun = totalEventCount === 1 ? "election" : "elections";
  return `${totalEventCount} new ${noun} in your districts`;
}

/** App-unique advisory lock key for the live alert run (digest uses 74_310_146). */
export const NEW_ELECTION_ALERT_RUN_LOCK_KEY = 74_310_147;

/**
 * Serializes live alert runs across processes (scheduler worker, manual
 * --live runs) with a Postgres session advisory lock. The lock must live on
 * one dedicated connection for the whole run — pool.query() hops connections —
 * so this checks out a client and holds it until fn settles. Returns null
 * without calling fn when another run already holds the lock.
 */
export async function withNewElectionAlertRunLock<T>(
  pool: Pick<Pool, "connect">,
  fn: () => Promise<T>
): Promise<T | null> {
  const client = await pool.connect();
  let locked = false;
  try {
    const acquired = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [NEW_ELECTION_ALERT_RUN_LOCK_KEY]
    );
    locked = acquired.rows[0]?.locked === true;
    if (!locked) {
      return null;
    }
    return await fn();
  } finally {
    // release() must survive an unlock failure (e.g. the connection died
    // mid-run): leaking the client would pin a pool slot for the process
    // lifetime in the long-lived scheduler worker.
    try {
      if (locked) {
        await client.query("SELECT pg_advisory_unlock($1)", [NEW_ELECTION_ALERT_RUN_LOCK_KEY]);
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

export function buildAlertMailerFromEnv(): NewElectionAlertMailer {
  // Reuses the auth mailer configuration: alerts go out from the same sender
  // identity. NOTIFICATIONS_MAILER=console overrides for local runs.
  const mailerKind = (readOptionalEnv("NOTIFICATIONS_MAILER") ?? readOptionalEnv("AUTH_MAILER") ?? "ses").toLowerCase();
  if (mailerKind === "console") {
    return createConsoleNewElectionAlertMailer();
  }
  if (mailerKind !== "ses") {
    throw new Error(`Unsupported notifications mailer: ${mailerKind} (expected "ses" or "console")`);
  }
  const fromEmailAddress = readOptionalEnv("AUTH_FROM_EMAIL");
  const sesRegion =
    readOptionalEnv("AUTH_SES_REGION") ?? readOptionalEnv("AWS_REGION") ?? readOptionalEnv("AWS_DEFAULT_REGION");
  if (!fromEmailAddress || !sesRegion) {
    throw new Error(
      "SES alert mailer requires AUTH_FROM_EMAIL and AUTH_SES_REGION/AWS_REGION (or set NOTIFICATIONS_MAILER=console)"
    );
  }
  assertUnsubscribeLinksConfigured("SES alert mailer");
  const replyToEmailAddress = readOptionalEnv("AUTH_REPLY_TO_EMAIL");
  return createSesNewElectionAlertMailer({
    sesClient: new SESv2Client({ region: sesRegion }),
    fromEmailAddress,
    ...(replyToEmailAddress ? { replyToEmailAddress } : {}),
  });
}

async function main(): Promise<void> {
  loadProjectEnv();
  const parsedOptions = parseSendNewElectionAlertsArgs(process.argv.slice(2));
  const buildUnsubscribeUrl = buildUnsubscribeUrlBuilderFromEnv("new_election_alerts");
  // The dry run never touches the push channel, so it needs no client.
  const pushClient = parsedOptions.live ? buildPushClientFromEnv() : null;
  const options: SendNewElectionAlertsOptions = {
    ...parsedOptions,
    ...(buildUnsubscribeUrl ? { buildUnsubscribeUrl } : {}),
    ...(pushClient ? { pushClient } : {}),
  };
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to send new election alerts");
  }

  // The dry run never sends, so it must not require mailer configuration.
  const mailer: NewElectionAlertMailer = options.live
    ? buildAlertMailerFromEnv()
    : {
        async sendAlertEmail() {
          throw new Error("Dry run must not send email");
        },
      };

  const pool = new Pool({ connectionString });
  try {
    // Dry runs read without marking, so they run unlocked.
    const result = options.live
      ? await withNewElectionAlertRunLock(pool, () => sendNewElectionAlerts(pool, mailer, options))
      : await sendNewElectionAlerts(pool, mailer, options);
    if (result === null) {
      console.log(JSON.stringify({ skipped: true, reason: "another alert run holds the lock" }, null, 2));
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
    console.error("new election alert send failed:", message);
    process.exitCode = 1;
  });
}
