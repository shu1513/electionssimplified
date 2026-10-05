import { pathToFileURL } from "node:url";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { readPositiveIntegerFlag } from "../utils/cliFlags.js";
import { displayElectionTitle } from "../utils/displayElectionTitle.js";
import { assertUnsubscribeLinksConfigured, buildUnsubscribeUrlBuilderFromEnv } from "./sendCandidateFollowDigests.js";
import { US_LATEST_LOCAL_DATE_SQL } from "../utils/usLocalDate.js";
import {
  createConsoleElectionReminderMailer,
  createSesElectionReminderMailer,
  formatElectionDateLabel,
  type ElectionReminderItem,
  type ElectionReminderMailer,
} from "../pipeline/users/electionReminderMailer.js";

// Day-before election reminders: one email per user covering every election
// dated tomorrow in the user's districts, deduplicated by
// user_election_reminder_sends (user_id, election_date). Unlike new-election
// alerts there is no seeded event backlog — recipients are computed live from
// prefs + districts + elections, so opt-outs and moves are naturally excluded
// and nothing lingers as forever-pending. The dedupe row is inserted only
// after a successful send, so a crash between send and insert can duplicate
// an email but never lose one.
//
// "Tomorrow" is the day after the last US local date (Pacific/Honolulu; see
// usLocalDate.ts). The scheduled run fires mid-afternoon UTC, when every US
// timezone is on the same calendar date, so "tomorrow" is unambiguous
// nationwide. The target date is computed once per run and passed to every
// query, so a run straddling a date boundary stays internally consistent.

export const DEFAULT_REMINDER_MAX_USERS = 500;
export const DEFAULT_REMINDER_MAX_ITEMS_PER_EMAIL = 20;

export type SendElectionRemindersOptions = {
  live: boolean;
  /**
   * Selection batch size, not a total cap: the run loops until every
   * eligible user is processed, because a reminder deferred to the next
   * daily run would target a different election date and silently drop.
   */
  maxUsers: number;
  maxItemsPerEmail: number;
  /** Per-user signed unsubscribe link builder; omit to send without one. */
  buildUnsubscribeUrl?: (userId: string) => string;
};

export type SendElectionRemindersResult = {
  dryRun: boolean;
  /** The election date this run reminded about (tomorrow in US-latest local time). */
  targetElectionDate: string;
  /** Users due a reminder this run examined (all of them; --max-users only sizes batches). */
  eligibleUserCount: number;
  /** Elections found across eligible users (a shared election counts once per user). */
  electionsPendingCount: number;
  /** Reminder emails actually sent (includes sends whose mark step then failed). */
  usersEmailedCount: number;
  /** Users both emailed and stamped in the dedupe log. */
  usersMarkedCount: number;
  /**
   * stage "send": the email did not go out; a re-run today retries it.
   * stage "mark_after_send": the email DID go out but the dedupe row insert
   * failed, so a re-run today would re-send (at-least-once).
   */
  failures: Array<{ userId: string; stage: "send" | "mark_after_send"; reason: string }>;
};

type Queryable = Pick<Pool, "query">;

export function parseSendElectionRemindersArgs(argv: readonly string[]): SendElectionRemindersOptions {
  return {
    live: argv.includes("--live"),
    maxUsers: readPositiveIntegerFlag(argv, "--max-users", DEFAULT_REMINDER_MAX_USERS),
    maxItemsPerEmail: readPositiveIntegerFlag(argv, "--max-items-per-email", DEFAULT_REMINDER_MAX_ITEMS_PER_EMAIL),
  };
}

async function selectTargetElectionDate(db: Queryable): Promise<string> {
  const result = await db.query<{ target_date: string }>(
    `SELECT (${US_LATEST_LOCAL_DATE_SQL} + 1)::text AS target_date`
  );
  const targetDate = result.rows[0]?.target_date;
  if (!targetDate) {
    throw new Error("Failed to compute the target election date");
  }
  return targetDate;
}

type EligibleUserRow = {
  id: string;
  email: string;
  first_name: string;
};

async function selectEligibleUsers(
  db: Queryable,
  targetDate: string,
  batchSize: number,
  excludedUserIds: readonly string[]
): Promise<EligibleUserRow[]> {
  // excludedUserIds carries the users this run already attempted. The dedupe
  // NOT EXISTS alone cannot page past them: a failed send never gets a
  // dedupe row, so without the exclusion it would be re-selected forever.
  const result = await db.query<EligibleUserRow>(
    `
      SELECT u.id, u.email, u.first_name
      FROM public.users AS u
      WHERE u.deleted_at IS NULL
        AND u.email_verified = true
        AND u.email_election_reminders = true
        AND u.id <> ALL($3::uuid[])
        AND EXISTS (
          SELECT 1
          FROM public.user_districts AS ud
          JOIN public.elections AS el
            ON el.district_id = ud.district_id
           AND el.election_date = $1::date
          WHERE ud.user_id = u.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.user_election_reminder_sends AS s
          WHERE s.user_id = u.id
            AND s.election_date = $1::date
        )
      ORDER BY u.id
      LIMIT $2::int
    `,
    [targetDate, batchSize, excludedUserIds]
  );
  return result.rows;
}

type ReminderElectionRow = {
  election_title: string;
  district_name: string;
};

async function selectReminderElections(
  db: Queryable,
  userId: string,
  targetDate: string
): Promise<ReminderElectionRow[]> {
  const result = await db.query<ReminderElectionRow>(
    `
      SELECT
        el.official_ballot_title AS election_title,
        d.name AS district_name
      FROM public.user_districts AS ud
      JOIN public.elections AS el
        ON el.district_id = ud.district_id
       AND el.election_date = $2::date
      JOIN public.districts AS d
        ON d.id = el.district_id
      WHERE ud.user_id = $1::uuid
      ORDER BY d.name, el.official_ballot_title, el.id
    `,
    [userId, targetDate]
  );
  return result.rows;
}

function toReminderItem(row: ReminderElectionRow): ElectionReminderItem {
  return {
    electionTitle: displayElectionTitle(row.election_title),
    districtName: row.district_name,
  };
}

async function markReminderSent(db: Queryable, userId: string, targetDate: string): Promise<void> {
  await db.query(
    `
      INSERT INTO public.user_election_reminder_sends (user_id, election_date)
      VALUES ($1::uuid, $2::date)
      ON CONFLICT DO NOTHING
    `,
    [userId, targetDate]
  );
}

export async function sendElectionReminders(
  db: Queryable,
  mailer: ElectionReminderMailer,
  options: SendElectionRemindersOptions
): Promise<SendElectionRemindersResult> {
  const targetDate = await selectTargetElectionDate(db);
  const result: SendElectionRemindersResult = {
    dryRun: !options.live,
    targetElectionDate: targetDate,
    eligibleUserCount: 0,
    electionsPendingCount: 0,
    usersEmailedCount: 0,
    usersMarkedCount: 0,
    failures: [],
  };
  const electionDateLabel = formatElectionDateLabel(targetDate);

  // Reminders for a date that go out late are useless, so unlike the alert
  // sender this loops through batches until every eligible user is processed
  // in this run — an overflow past one batch must not silently wait for a
  // "next run" that will already be targeting a different date. Every
  // selected user joins attemptedUserIds no matter how their send went, and
  // the selection excludes those ids, so each non-empty batch strictly
  // shrinks the remaining set and the loop always terminates.
  const attemptedUserIds: string[] = [];
  for (;;) {
    const users = await selectEligibleUsers(db, targetDate, options.maxUsers, attemptedUserIds);
    if (users.length === 0) {
      break;
    }
    for (const user of users) {
      attemptedUserIds.push(user.id);
      const elections = await selectReminderElections(db, user.id, targetDate);
      if (elections.length === 0) {
        // Eligibility guarantees at least one; defensive against a concurrent
        // election deletion between the two queries.
        continue;
      }
      result.eligibleUserCount += 1;
      result.electionsPendingCount += elections.length;
      if (!options.live) {
        continue;
      }

      try {
        const unsubscribeUrl = options.buildUnsubscribeUrl?.(user.id);
        await mailer.sendReminderEmail({
          email: user.email,
          firstName: user.first_name,
          electionDateLabel,
          items: elections.slice(0, options.maxItemsPerEmail).map(toReminderItem),
          totalElectionCount: elections.length,
          ...(unsubscribeUrl ? { unsubscribeUrl } : {}),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        result.failures.push({ userId: user.id, stage: "send", reason });
        continue;
      }
      result.usersEmailedCount += 1;

      try {
        await markReminderSent(db, user.id, targetDate);
        result.usersMarkedCount += 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        result.failures.push({ userId: user.id, stage: "mark_after_send", reason });
      }
    }
  }

  return result;
}

/**
 * App-unique advisory lock key for the live reminder run
 * (digest uses 74_310_146, new-election alerts 74_310_147).
 */
export const ELECTION_REMINDER_RUN_LOCK_KEY = 74_310_148;

/**
 * Serializes live reminder runs across processes (scheduler worker, manual
 * --live runs) with a Postgres session advisory lock. The lock must live on
 * one dedicated connection for the whole run — pool.query() hops connections —
 * so this checks out a client and holds it until fn settles. Returns null
 * without calling fn when another run already holds the lock.
 */
export async function withElectionReminderRunLock<T>(
  pool: Pick<Pool, "connect">,
  fn: () => Promise<T>
): Promise<T | null> {
  const client = await pool.connect();
  let locked = false;
  try {
    const acquired = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [ELECTION_REMINDER_RUN_LOCK_KEY]
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
        await client.query("SELECT pg_advisory_unlock($1)", [ELECTION_REMINDER_RUN_LOCK_KEY]);
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

export function buildReminderMailerFromEnv(): ElectionReminderMailer {
  // Reuses the auth mailer configuration: reminders go out from the same
  // sender identity. NOTIFICATIONS_MAILER=console overrides for local runs.
  const mailerKind = (readOptionalEnv("NOTIFICATIONS_MAILER") ?? readOptionalEnv("AUTH_MAILER") ?? "ses").toLowerCase();
  if (mailerKind === "console") {
    return createConsoleElectionReminderMailer();
  }
  if (mailerKind !== "ses") {
    throw new Error(`Unsupported notifications mailer: ${mailerKind} (expected "ses" or "console")`);
  }
  const fromEmailAddress = readOptionalEnv("AUTH_FROM_EMAIL");
  const sesRegion =
    readOptionalEnv("AUTH_SES_REGION") ?? readOptionalEnv("AWS_REGION") ?? readOptionalEnv("AWS_DEFAULT_REGION");
  if (!fromEmailAddress || !sesRegion) {
    throw new Error(
      "SES reminder mailer requires AUTH_FROM_EMAIL and AUTH_SES_REGION/AWS_REGION (or set NOTIFICATIONS_MAILER=console)"
    );
  }
  assertUnsubscribeLinksConfigured("SES reminder mailer");
  const replyToEmailAddress = readOptionalEnv("AUTH_REPLY_TO_EMAIL");
  return createSesElectionReminderMailer({
    sesClient: new SESv2Client({ region: sesRegion }),
    fromEmailAddress,
    ...(replyToEmailAddress ? { replyToEmailAddress } : {}),
  });
}

async function main(): Promise<void> {
  loadProjectEnv();
  const parsedOptions = parseSendElectionRemindersArgs(process.argv.slice(2));
  const buildUnsubscribeUrl = buildUnsubscribeUrlBuilderFromEnv("election_reminders");
  const options: SendElectionRemindersOptions = {
    ...parsedOptions,
    ...(buildUnsubscribeUrl ? { buildUnsubscribeUrl } : {}),
  };
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to send election reminders");
  }

  // The dry run never sends, so it must not require mailer configuration.
  const mailer: ElectionReminderMailer = options.live
    ? buildReminderMailerFromEnv()
    : {
        async sendReminderEmail() {
          throw new Error("Dry run must not send email");
        },
      };

  const pool = new Pool({ connectionString });
  try {
    // Dry runs read without marking, so they run unlocked.
    const result = options.live
      ? await withElectionReminderRunLock(pool, () => sendElectionReminders(pool, mailer, options))
      : await sendElectionReminders(pool, mailer, options);
    if (result === null) {
      console.log(JSON.stringify({ skipped: true, reason: "another reminder run holds the lock" }, null, 2));
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
    console.error("election reminder send failed:", message);
    process.exitCode = 1;
  });
}
