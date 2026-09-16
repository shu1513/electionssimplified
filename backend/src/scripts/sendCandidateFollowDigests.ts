import { pathToFileURL } from "node:url";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { Pool } from "pg";

import { APP_NAME } from "../constants/brand.js";
import { loadProjectEnv } from "../config/env.js";
import { readPositiveIntegerFlag } from "../utils/cliFlags.js";
import { createEmailUnsubscribeToken } from "../pipeline/users/emailUnsubscribeToken.js";
import {
  createConsoleCandidateFollowDigestMailer,
  createSesCandidateFollowDigestMailer,
  type CandidateFollowDigestItem,
  type CandidateFollowDigestMailer,
} from "../pipeline/users/candidateFollowDigestMailer.js";
import {
  buildPushClientFromEnv,
  processMaturePushReceipts,
  sendUserPushNotification,
  type PushNotificationClient,
} from "../pipeline/users/pushNotificationSender.js";

// Delivery consumer for user_candidate_follow_notification_events: sends one
// digest email per user covering all their unsent events, then stamps
// notified_at. Events whose follow no longer exists (unfollowed, notify flag
// turned off, candidate deleted/merged) are resolved without email so they do
// not linger as forever-pending. Marking happens only after a successful send,
// so a crash between send and mark can duplicate an email but never lose one.
//
// Push is a best-effort second channel on the same events: after the email
// goes out (the durable, at-least-once channel), a summary push goes to the
// user's registered devices. Push failures never block marking — the email
// already delivered the content — and a run also checks the mature Expo
// receipts stored by earlier runs so dead device tokens get revoked.

export const DEFAULT_DIGEST_MAX_USERS = 500;
export const DEFAULT_DIGEST_MAX_ITEMS_PER_EMAIL = 20;

export type SendCandidateFollowDigestsOptions = {
  live: boolean;
  /**
   * Selection batch size, not a total cap: the run loops until every
   * eligible user is processed. The job runs monthly, so a user deferred to
   * the "next run" would wait a month, and with steady new events the same
   * first batch would fill up every time.
   */
  maxUsers: number;
  maxItemsPerEmail: number;
  /** Per-user signed unsubscribe link builder; omit to send without one. */
  buildUnsubscribeUrl?: (userId: string) => string;
  /** Expo push client; omit to skip the push channel entirely. */
  pushClient?: PushNotificationClient;
};

export type SendCandidateFollowDigestsResult = {
  dryRun: boolean;
  /**
   * Events resolved (or countable as resolvable in dry run) without email.
   * Always table-wide: orphan cleanup is global housekeeping, deliberately
   * independent of --max-users, which only sizes the email batches below.
   */
  resolvedWithoutEmailCount: number;
  /** Users with at least one valid pending event this run examined. */
  eligibleUserCount: number;
  /** Valid pending events found across eligible users. */
  eventsPendingCount: number;
  /** Digest emails actually sent (includes sends whose mark step then failed). */
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


export function parseSendCandidateFollowDigestsArgs(
  argv: readonly string[]
): SendCandidateFollowDigestsOptions {
  return {
    live: argv.includes("--live"),
    maxUsers: readPositiveIntegerFlag(argv, "--max-users", DEFAULT_DIGEST_MAX_USERS),
    maxItemsPerEmail: readPositiveIntegerFlag(
      argv,
      "--max-items-per-email",
      DEFAULT_DIGEST_MAX_ITEMS_PER_EMAIL
    ),
  };
}

// An unsent event is orphaned when its follow no longer opts into this event
// type, the candidate has been deleted/merged since the event was created, or
// its record has been retired (the claim was withdrawn — the event will never
// be sendable again). Without the retirement branch such events stay
// unresolved forever and their users consume a --max-users slot every run
// while receiving nothing.
const ORPHANED_EVENT_CONDITION = `
  e.notified_at IS NULL
  AND (
    NOT EXISTS (
      SELECT 1
      FROM public.user_candidate_follows AS f
      WHERE f.user_id = e.user_id
        AND f.candidate_id = e.candidate_id
        AND (
          (e.event_type = 'candidate_record_update' AND f.notify_updates)
          OR (e.event_type IN ('candidate_future_election', 'candidate_election_withdrawal') AND f.notify_elections)
        )
    )
    OR NOT EXISTS (
      SELECT 1
      FROM public.candidates AS c
      WHERE c.id = e.candidate_id
        AND c.deleted_at IS NULL
        AND c.merged_into_candidate_id IS NULL
    )
    OR EXISTS (
      SELECT 1
      FROM public.candidate_records AS r
      WHERE r.id = e.candidate_record_id
        AND r.retired_at IS NOT NULL
    )
  )
`;

async function resolveOrphanedEvents(db: Queryable, live: boolean): Promise<number> {
  if (!live) {
    const counted = await db.query<{ matched: string }>(
      `
        SELECT count(*)::text AS matched
        FROM public.user_candidate_follow_notification_events AS e
        WHERE ${ORPHANED_EVENT_CONDITION}
      `
    );
    return Number(counted.rows[0]?.matched ?? 0);
  }
  const resolved = await db.query(
    `
      UPDATE public.user_candidate_follow_notification_events AS e
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

async function selectEligibleUsers(
  db: Queryable,
  batchSize: number,
  excludedUserIds: readonly string[]
): Promise<EligibleUserRow[]> {
  // excludedUserIds carries the users this run already attempted. Marking
  // alone cannot page past them: a failed send (or any dry run) leaves the
  // events unmarked, so without the exclusion the same users would be
  // re-selected forever.
  const result = await db.query<EligibleUserRow>(
    `
      SELECT u.id, u.email, u.first_name
      FROM public.users AS u
      WHERE u.deleted_at IS NULL
        AND u.email_verified = true
        AND u.email_digest = true
        AND u.id <> ALL($2::uuid[])
        AND EXISTS (
          -- Mirrors the deliverability joins in selectPendingEvents so a user
          -- whose only unsent events are orphaned (unfollowed, notify flag
          -- off, candidate gone, record retired) cannot consume a --max-users
          -- slot. Matters in dry runs, where orphans are counted but not yet
          -- stamped.
          SELECT 1
          FROM public.user_candidate_follow_notification_events AS e
          JOIN public.candidates AS c
            ON c.id = e.candidate_id
           AND c.deleted_at IS NULL
           AND c.merged_into_candidate_id IS NULL
          JOIN public.user_candidate_follows AS f
            ON f.user_id = e.user_id
           AND f.candidate_id = e.candidate_id
           AND (
             (e.event_type = 'candidate_record_update' AND f.notify_updates)
             OR (e.event_type IN ('candidate_future_election', 'candidate_election_withdrawal') AND f.notify_elections)
           )
          LEFT JOIN public.candidate_records AS r
            ON r.id = e.candidate_record_id
          WHERE e.user_id = u.id
            AND e.notified_at IS NULL
            AND NOT (e.event_type = 'candidate_record_update' AND r.retired_at IS NOT NULL)
        )
      ORDER BY u.id
      LIMIT $1::int
    `,
    [batchSize, excludedUserIds]
  );
  return result.rows;
}

type PendingEventRow = {
  id: string;
  event_type: "candidate_record_update" | "candidate_future_election" | "candidate_election_withdrawal";
  candidate_display_name: string;
  record_description: string | null;
  election_title: string | null;
  election_date: string | null;
};

async function selectPendingEvents(db: Queryable, userId: string): Promise<PendingEventRow[]> {
  const result = await db.query<PendingEventRow>(
    `
      SELECT
        e.id,
        e.event_type,
        COALESCE(NULLIF(trim(c.display_name), ''), trim(c.first_name || ' ' || c.last_name)) AS candidate_display_name,
        r.description AS record_description,
        el.official_ballot_title AS election_title,
        el.election_date::text AS election_date
      FROM public.user_candidate_follow_notification_events AS e
      JOIN public.candidates AS c
        ON c.id = e.candidate_id
       AND c.deleted_at IS NULL
       AND c.merged_into_candidate_id IS NULL
      JOIN public.user_candidate_follows AS f
        ON f.user_id = e.user_id
       AND f.candidate_id = e.candidate_id
       AND (
         (e.event_type = 'candidate_record_update' AND f.notify_updates)
         OR (e.event_type IN ('candidate_future_election', 'candidate_election_withdrawal') AND f.notify_elections)
       )
      LEFT JOIN public.candidate_records AS r
        ON r.id = e.candidate_record_id
      LEFT JOIN public.elections AS el
        ON el.id = e.election_id
      WHERE e.user_id = $1::uuid
        AND e.notified_at IS NULL
        -- A record retired after its event was created is a withdrawn claim;
        -- never surface it in a digest. Election events are unaffected.
        AND NOT (e.event_type = 'candidate_record_update' AND r.retired_at IS NOT NULL)
      ORDER BY candidate_display_name, e.created_at, e.id
    `,
    [userId]
  );
  return result.rows;
}

function toDigestItem(row: PendingEventRow): CandidateFollowDigestItem {
  return {
    candidateDisplayName: row.candidate_display_name,
    eventType: row.event_type,
    recordDescription: row.record_description,
    electionTitle: row.election_title,
    electionDate: row.election_date,
  };
}

async function markEventsNotified(db: Queryable, eventIds: readonly string[]): Promise<void> {
  await db.query(
    `
      UPDATE public.user_candidate_follow_notification_events
      SET notified_at = now()
      WHERE id = ANY($1::uuid[])
        AND notified_at IS NULL
    `,
    [eventIds]
  );
}

export async function sendCandidateFollowDigests(
  db: Queryable,
  mailer: CandidateFollowDigestMailer,
  options: SendCandidateFollowDigestsOptions
): Promise<SendCandidateFollowDigestsResult> {
  const result: SendCandidateFollowDigestsResult = {
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

  // Every selected user joins attemptedUserIds no matter how their send
  // went, and the selection excludes those ids, so each non-empty batch
  // strictly shrinks the remaining set and the loop always terminates.
  const attemptedUserIds: string[] = [];
  for (;;) {
    const users = await selectEligibleUsers(db, options.maxUsers, attemptedUserIds);
    if (users.length === 0) {
      break;
    }
    for (const user of users) {
      attemptedUserIds.push(user.id);
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
        await mailer.sendDigestEmail({
          email: user.email,
          firstName: user.first_name,
          items: pendingEvents.slice(0, options.maxItemsPerEmail).map(toDigestItem),
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
            body: buildDigestSubjectLine(pendingEvents.length),
            url: "/follows",
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
  }

  return result;
}

/** Push body: the email subject's copy without the bracketed brand prefix. */
function buildDigestSubjectLine(totalEventCount: number): string {
  const noun = totalEventCount === 1 ? "update" : "updates";
  return `${totalEventCount} ${noun} on candidates you follow`;
}

/**
 * Builds the per-user signed unsubscribe link when both envs are set:
 * NOTIFICATIONS_UNSUBSCRIBE_URL (the public GET/POST /api/email/unsubscribe
 * endpoint, e.g. https://api.example.com/api/email/unsubscribe) and
 * NOTIFICATIONS_UNSUBSCRIBE_SECRET (shared with the API server, which
 * verifies the token). Returns null when unconfigured so digests still send,
 * just without the footer link and one-click headers.
 *
 * preference picks which opt-in the link disables; "digest" is omitted from
 * the URL so existing digest links keep their exact shape.
 */
export function buildUnsubscribeUrlBuilderFromEnv(
  preference: "digest" | "new_election_alerts" | "election_reminders" | "issue_updates" | "member_newsletter" = "digest"
): ((userId: string) => string) | null {
  const baseUrl = readOptionalEnv("NOTIFICATIONS_UNSUBSCRIBE_URL");
  const secret = readOptionalEnv("NOTIFICATIONS_UNSUBSCRIBE_SECRET");
  if (!baseUrl || !secret) {
    return null;
  }
  // Fail fast at construction, mirroring the API server's startup guard: a
  // weak secret must abort the run, not surface as a per-user send failure
  // for every digest.
  if (secret.length < 32) {
    throw new Error("NOTIFICATIONS_UNSUBSCRIBE_SECRET must be at least 32 characters");
  }
  const parsed = new URL(baseUrl);
  return (userId: string) => {
    const url = new URL(parsed.toString());
    url.searchParams.set("token", createEmailUnsubscribeToken(userId, secret));
    if (preference !== "digest") {
      url.searchParams.set("pref", preference);
    }
    return url.toString();
  };
}

/**
 * Guard for every SES mailer builder: a real send must carry the footer link
 * and RFC 8058 headers, so refuse to build the mailer when the unsubscribe
 * pair is missing instead of quietly sending without them. Console mailers
 * and dry runs never reach real inboxes and stay unaffected.
 */
export function assertUnsubscribeLinksConfigured(mailerLabel: string): void {
  if (!readOptionalEnv("NOTIFICATIONS_UNSUBSCRIBE_URL") || !readOptionalEnv("NOTIFICATIONS_UNSUBSCRIBE_SECRET")) {
    throw new Error(
      `${mailerLabel} requires NOTIFICATIONS_UNSUBSCRIBE_URL and NOTIFICATIONS_UNSUBSCRIBE_SECRET so every email carries an unsubscribe link (or set NOTIFICATIONS_MAILER=console)`
    );
  }
}

/**
 * Bulk senders that can carry promotional content (issue broadcasts, member
 * newsletters) are commercial email under CAN-SPAM and must show a valid
 * physical postal address (16 CFR 316.5 allows a registered P.O. box or
 * private mailbox). Fail the run rather than send without one.
 */
export function requirePostalAddress(mailerLabel: string): string {
  const postalAddress = readOptionalEnv("EMAIL_POSTAL_ADDRESS");
  if (!postalAddress) {
    throw new Error(
      `${mailerLabel} requires EMAIL_POSTAL_ADDRESS (the sender's physical postal address, CAN-SPAM 16 CFR 316.5) in every footer (or set NOTIFICATIONS_MAILER=console)`
    );
  }
  return postalAddress;
}

/** App-unique advisory lock key for the live digest run. */
export const DIGEST_RUN_LOCK_KEY = 74_310_146;

/**
 * Serializes live digest runs across processes (scheduler worker, manual
 * --live runs) with a Postgres session advisory lock. The lock must live on
 * one dedicated connection for the whole run — pool.query() hops connections —
 * so this checks out a client and holds it until fn settles. Returns null
 * without calling fn when another run already holds the lock.
 */
export async function withDigestRunLock<T>(
  pool: Pick<Pool, "connect">,
  fn: () => Promise<T>
): Promise<T | null> {
  const client = await pool.connect();
  let locked = false;
  try {
    const acquired = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [DIGEST_RUN_LOCK_KEY]
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
        await client.query("SELECT pg_advisory_unlock($1)", [DIGEST_RUN_LOCK_KEY]);
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

export function buildDigestMailerFromEnv(): CandidateFollowDigestMailer {
  // Reuses the auth mailer configuration: the digest goes out from the same
  // sender identity. NOTIFICATIONS_MAILER=console overrides for local runs.
  const mailerKind = (readOptionalEnv("NOTIFICATIONS_MAILER") ?? readOptionalEnv("AUTH_MAILER") ?? "ses").toLowerCase();
  if (mailerKind === "console") {
    return createConsoleCandidateFollowDigestMailer();
  }
  if (mailerKind !== "ses") {
    throw new Error(`Unsupported notifications mailer: ${mailerKind} (expected "ses" or "console")`);
  }
  const fromEmailAddress = readOptionalEnv("AUTH_FROM_EMAIL");
  const sesRegion =
    readOptionalEnv("AUTH_SES_REGION") ?? readOptionalEnv("AWS_REGION") ?? readOptionalEnv("AWS_DEFAULT_REGION");
  if (!fromEmailAddress || !sesRegion) {
    throw new Error(
      "SES digest mailer requires AUTH_FROM_EMAIL and AUTH_SES_REGION/AWS_REGION (or set NOTIFICATIONS_MAILER=console)"
    );
  }
  assertUnsubscribeLinksConfigured("SES digest mailer");
  const replyToEmailAddress = readOptionalEnv("AUTH_REPLY_TO_EMAIL");
  return createSesCandidateFollowDigestMailer({
    sesClient: new SESv2Client({ region: sesRegion }),
    fromEmailAddress,
    ...(replyToEmailAddress ? { replyToEmailAddress } : {}),
  });
}

async function main(): Promise<void> {
  loadProjectEnv();
  const parsedOptions = parseSendCandidateFollowDigestsArgs(process.argv.slice(2));
  const buildUnsubscribeUrl = buildUnsubscribeUrlBuilderFromEnv();
  // The dry run never touches the push channel, so it needs no client.
  const pushClient = parsedOptions.live ? buildPushClientFromEnv() : null;
  const options: SendCandidateFollowDigestsOptions = {
    ...parsedOptions,
    ...(buildUnsubscribeUrl ? { buildUnsubscribeUrl } : {}),
    ...(pushClient ? { pushClient } : {}),
  };
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to send candidate follow digests");
  }

  // The dry run never sends, so it must not require mailer configuration.
  const mailer: CandidateFollowDigestMailer = options.live
    ? buildDigestMailerFromEnv()
    : {
        async sendDigestEmail() {
          throw new Error("Dry run must not send email");
        },
      };

  const pool = new Pool({ connectionString });
  try {
    // Dry runs read without marking, so they run unlocked.
    const result = options.live
      ? await withDigestRunLock(pool, () => sendCandidateFollowDigests(pool, mailer, options))
      : await sendCandidateFollowDigests(pool, mailer, options);
    if (result === null) {
      console.log(JSON.stringify({ skipped: true, reason: "another digest run holds the lock" }, null, 2));
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
    console.error("candidate follow digest send failed:", message);
    process.exitCode = 1;
  });
}
