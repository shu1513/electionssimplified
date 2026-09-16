import { pathToFileURL } from "node:url";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { readPositiveIntegerFlag } from "../utils/cliFlags.js";
import {
  createConsoleMembershipAnnualReminderSender,
  createSesMembershipAnnualReminderSender,
  type SendMembershipAnnualReminderEmail,
} from "../api/membership/membershipMailer.js";

// Annual membership reminders — Cal. Bus. & Prof. Code §17602(b)(2) as
// amended by AB 2863 (effective 2025-07-01): a continuous-service offer,
// month-to-month included, owes each consumer a reminder at least once a
// year naming the product, the charge amount and frequency, and how to
// cancel. A monthly Stripe receipt is a payment record, not that reminder.
// docs/plans/membership-contributions.md deferred this as "must ship within
// 12 months of the first membership"; this script is that sender.
//
// Cadence: one reminder per subscription per anniversary year, sent in the
// LEAD_DAYS window before each anniversary of started_at. A run that comes
// late (cron gap) still sends — the due year is computed from the calendar,
// not from the run date — so the gap between reminders never exceeds a year
// plus the outage. Dedupe is billing_subscription_annual_reminders
// (subscription, anniversary_year), inserted only after a successful send:
// a crash between send and insert can duplicate a reminder, never lose one.
//
// Only currently billable subscriptions (active / past_due, not canceled)
// on a live account get one: a canceled membership has nothing to renew,
// and a deleted account has already had its membership canceled (Terms 14.3).

export const MEMBERSHIP_ANNUAL_REMINDER_RUN_LOCK_KEY = 74_310_149;
export const DEFAULT_ANNUAL_REMINDER_LEAD_DAYS = 30;
export const DEFAULT_ANNUAL_REMINDER_MAX_SENDS = 500;

export type SendMembershipAnnualRemindersOptions = {
  live: boolean;
  /** Days before the anniversary at which the reminder becomes due. */
  leadDays: number;
  /** Cap on sends per run; the rest are picked up by the next run. */
  maxSends: number;
};

export type SendMembershipAnnualRemindersResult = {
  dryRun: boolean;
  /** Subscriptions due a reminder this run examined (capped by --max-sends). */
  dueCount: number;
  /** Reminder emails actually sent (includes sends whose record step then failed). */
  sentCount: number;
  /** Sends both delivered and recorded in billing_subscription_annual_reminders. */
  recordedCount: number;
  /** Dry run only: what a live run would send. */
  preview: Array<{ stripeSubscriptionId: string; anniversaryYear: number; monthlyAmountCents: number }>;
  /**
   * stage "send": the email did not go out; the next run retries it.
   * stage "record_after_send": the email DID go out but the dedupe row
   * insert failed, so the next run would re-send (at-least-once).
   */
  failures: Array<{ stripeSubscriptionId: string; stage: "send" | "record_after_send"; reason: string }>;
};

type Queryable = Pick<Pool, "query">;

export function parseSendMembershipAnnualRemindersArgs(argv: readonly string[]): SendMembershipAnnualRemindersOptions {
  return {
    live: argv.includes("--live"),
    leadDays: readPositiveIntegerFlag(argv, "--lead-days", DEFAULT_ANNUAL_REMINDER_LEAD_DAYS),
    maxSends: readPositiveIntegerFlag(argv, "--max-sends", DEFAULT_ANNUAL_REMINDER_MAX_SENDS),
  };
}

export type DueReminderRow = {
  stripe_subscription_id: string;
  email: string;
  monthly_amount_cents: number;
  started_at: Date;
  anniversary_year: number;
};

/**
 * Billable subscriptions whose next anniversary falls within leadDays (or
 * has already passed) and that have no reminder recorded for that
 * anniversary year. The due year is the whole years in
 * age(now + lead, started_at): inside the lead window before anniversary N
 * that expression is N, and it stays N until the window before N+1 opens,
 * so each anniversary maps to exactly one (subscription, year) key.
 */
export async function selectDueReminders(db: Queryable, leadDays: number, limit: number): Promise<DueReminderRow[]> {
  const result = await db.query<DueReminderRow>(
    `
      WITH due AS (
        SELECT
          s.stripe_subscription_id,
          u.email::text AS email,
          s.monthly_amount_cents,
          s.started_at,
          EXTRACT(YEAR FROM age(now() + make_interval(days => $1::int), s.started_at))::int AS anniversary_year
        FROM public.billing_subscriptions AS s
        JOIN public.billing_customers AS c ON c.id = s.billing_customer_id
        JOIN public.users AS u ON u.id = c.user_id
        WHERE s.stripe_status IN ('active', 'past_due')
          AND s.canceled_at IS NULL
          AND u.deleted_at IS NULL
      )
      SELECT d.*
      FROM due AS d
      WHERE d.anniversary_year >= 1
        AND NOT EXISTS (
          SELECT 1
          FROM public.billing_subscription_annual_reminders AS r
          WHERE r.stripe_subscription_id = d.stripe_subscription_id
            AND r.anniversary_year = d.anniversary_year
        )
      ORDER BY d.started_at, d.stripe_subscription_id
      LIMIT $2::int
    `,
    [leadDays, limit]
  );
  return result.rows;
}

async function recordReminder(db: Queryable, row: DueReminderRow): Promise<void> {
  await db.query(
    `
      INSERT INTO public.billing_subscription_annual_reminders
        (stripe_subscription_id, anniversary_year, monthly_amount_cents)
      VALUES ($1, $2, $3)
      ON CONFLICT (stripe_subscription_id, anniversary_year) DO NOTHING
    `,
    [row.stripe_subscription_id, row.anniversary_year, row.monthly_amount_cents]
  );
}

export async function sendMembershipAnnualReminders(
  db: Queryable,
  sendReminder: SendMembershipAnnualReminderEmail,
  options: SendMembershipAnnualRemindersOptions
): Promise<SendMembershipAnnualRemindersResult> {
  const due = await selectDueReminders(db, options.leadDays, options.maxSends);
  const result: SendMembershipAnnualRemindersResult = {
    dryRun: !options.live,
    dueCount: due.length,
    sentCount: 0,
    recordedCount: 0,
    preview: [],
    failures: [],
  };
  if (!options.live) {
    result.preview = due.map((row) => ({
      stripeSubscriptionId: row.stripe_subscription_id,
      anniversaryYear: row.anniversary_year,
      monthlyAmountCents: row.monthly_amount_cents,
    }));
    return result;
  }
  for (const row of due) {
    try {
      await sendReminder({
        email: row.email,
        monthlyAmountCents: row.monthly_amount_cents,
        startedAt: row.started_at,
      });
    } catch (error) {
      result.failures.push({
        stripeSubscriptionId: row.stripe_subscription_id,
        stage: "send",
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    result.sentCount += 1;
    try {
      await recordReminder(db, row);
      result.recordedCount += 1;
    } catch (error) {
      result.failures.push({
        stripeSubscriptionId: row.stripe_subscription_id,
        stage: "record_after_send",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

export async function withMembershipAnnualReminderRunLock<T>(
  pool: Pick<Pool, "connect">,
  fn: () => Promise<T>
): Promise<T | null> {
  const client = await pool.connect();
  let locked = false;
  try {
    const acquired = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [
      MEMBERSHIP_ANNUAL_REMINDER_RUN_LOCK_KEY,
    ]);
    locked = acquired.rows[0]?.locked === true;
    if (!locked) {
      return null;
    }
    return await fn();
  } finally {
    try {
      if (locked) {
        await client.query("SELECT pg_advisory_unlock($1)", [MEMBERSHIP_ANNUAL_REMINDER_RUN_LOCK_KEY]);
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

export function buildAnnualReminderSenderFromEnv(): SendMembershipAnnualReminderEmail {
  // Same base-URL rule as the API server's membership mailer
  // (runAddressApiServer.ts): SITE_ORIGIN, else AUTH_PUBLIC_BASE_URL.
  const publicBaseUrl = (readOptionalEnv("SITE_ORIGIN") ?? readOptionalEnv("AUTH_PUBLIC_BASE_URL"))?.replace(/\/+$/, "");
  if (!publicBaseUrl) {
    throw new Error("SES membership reminder mailer requires SITE_ORIGIN (or AUTH_PUBLIC_BASE_URL) for the Manage membership link");
  }
  const urls = { manageMembershipUrl: `${publicBaseUrl}/me/membership`, termsUrl: `${publicBaseUrl}/terms` };
  const mailerKind = (readOptionalEnv("NOTIFICATIONS_MAILER") ?? readOptionalEnv("AUTH_MAILER") ?? "ses").toLowerCase();
  if (mailerKind === "console") {
    return createConsoleMembershipAnnualReminderSender(urls);
  }
  if (mailerKind !== "ses") {
    throw new Error(`Unsupported notifications mailer: ${mailerKind} (expected "ses" or "console")`);
  }
  const fromEmailAddress = readOptionalEnv("AUTH_FROM_EMAIL");
  const sesRegion =
    readOptionalEnv("AUTH_SES_REGION") ?? readOptionalEnv("AWS_REGION") ?? readOptionalEnv("AWS_DEFAULT_REGION");
  if (!fromEmailAddress || !sesRegion) {
    throw new Error(
      "SES membership reminder mailer requires AUTH_FROM_EMAIL and AUTH_SES_REGION/AWS_REGION (or set NOTIFICATIONS_MAILER=console)"
    );
  }
  const replyToEmailAddress = readOptionalEnv("AUTH_REPLY_TO_EMAIL");
  return createSesMembershipAnnualReminderSender({
    sesClient: new SESv2Client({ region: sesRegion }),
    fromEmailAddress,
    ...(replyToEmailAddress ? { replyToEmailAddress } : {}),
    ...urls,
  });
}

async function main(): Promise<void> {
  loadProjectEnv();
  const options = parseSendMembershipAnnualRemindersArgs(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to send membership reminders");
  }
  // The dry run never sends, so it must not require mailer configuration.
  const sendReminder: SendMembershipAnnualReminderEmail = options.live
    ? buildAnnualReminderSenderFromEnv()
    : async () => {
        throw new Error("Dry run must not send email");
      };
  const pool = new Pool({ connectionString });
  try {
    const result = options.live
      ? await withMembershipAnnualReminderRunLock(pool, () => sendMembershipAnnualReminders(pool, sendReminder, options))
      : await sendMembershipAnnualReminders(pool, sendReminder, options);
    if (result === null) {
      console.log(JSON.stringify({ skipped: true, reason: "another reminder run holds the lock" }, null, 2));
      return;
    }
    console.log(
      JSON.stringify({ ...result, ...(options.live ? {} : { next: "re-run with --live to send" }) }, null, 2)
    );
    if (result.failures.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
