import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_ANNUAL_REMINDER_LEAD_DAYS,
  DEFAULT_ANNUAL_REMINDER_MAX_SENDS,
  MEMBERSHIP_ANNUAL_REMINDER_RUN_LOCK_KEY,
  buildAnnualReminderSenderFromEnv,
  parseSendMembershipAnnualRemindersArgs,
  sendMembershipAnnualReminders,
  type DueReminderRow,
} from "../../src/scripts/sendMembershipAnnualReminders.js";
import { ELECTION_REMINDER_RUN_LOCK_KEY } from "../../src/scripts/sendElectionReminders.js";
import { DIGEST_RUN_LOCK_KEY } from "../../src/scripts/sendCandidateFollowDigests.js";
import { NEW_ELECTION_ALERT_RUN_LOCK_KEY } from "../../src/scripts/sendNewElectionAlerts.js";
import {
  buildAnnualReminderHtmlBody,
  buildAnnualReminderTextBody,
  type MembershipAnnualReminderEmailInput,
} from "../../src/api/membership/membershipMailer.js";

const SUB_A = "sub_A";
const SUB_B = "sub_B";

function dueRow(id: string, year = 1): DueReminderRow {
  return {
    stripe_subscription_id: id,
    email: `${id}@example.com`,
    monthly_amount_cents: 700,
    started_at: new Date("2025-10-01T00:00:00Z"),
    anniversary_year: year,
  };
}

function createDbMock(due: DueReminderRow[], failRecord = false) {
  const recorded: Array<{ id: string; year: number; amount: number }> = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes("INSERT INTO public.billing_subscription_annual_reminders")) {
      if (failRecord) {
        throw new Error("insert failed");
      }
      recorded.push({ id: params![0] as string, year: params![1] as number, amount: params![2] as number });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM public.billing_subscriptions")) {
      expect(params).toEqual([DEFAULT_ANNUAL_REMINDER_LEAD_DAYS, DEFAULT_ANNUAL_REMINDER_MAX_SENDS]);
      return { rows: due, rowCount: due.length };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  return { db: { query }, recorded };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseSendMembershipAnnualRemindersArgs", () => {
  it("defaults to a dry run with a 30-day lead", () => {
    expect(parseSendMembershipAnnualRemindersArgs([])).toEqual({
      live: false,
      leadDays: DEFAULT_ANNUAL_REMINDER_LEAD_DAYS,
      maxSends: DEFAULT_ANNUAL_REMINDER_MAX_SENDS,
    });
    expect(parseSendMembershipAnnualRemindersArgs(["--live", "--lead-days", "14", "--max-sends", "5"])).toEqual({
      live: true,
      leadDays: 14,
      maxSends: 5,
    });
  });

  it("uses an advisory lock key no other sender uses", () => {
    expect(
      new Set([
        MEMBERSHIP_ANNUAL_REMINDER_RUN_LOCK_KEY,
        ELECTION_REMINDER_RUN_LOCK_KEY,
        DIGEST_RUN_LOCK_KEY,
        NEW_ELECTION_ALERT_RUN_LOCK_KEY,
      ]).size
    ).toBe(4);
  });
});

describe("sendMembershipAnnualReminders", () => {
  it("previews without sending on a dry run", async () => {
    const { db, recorded } = createDbMock([dueRow(SUB_A), dueRow(SUB_B, 2)]);
    const send = vi.fn(async () => {});
    const result = await sendMembershipAnnualReminders(db, send, parseSendMembershipAnnualRemindersArgs([]));
    expect(send).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
    expect(result).toMatchObject({
      dryRun: true,
      dueCount: 2,
      sentCount: 0,
      preview: [
        { stripeSubscriptionId: SUB_A, anniversaryYear: 1, monthlyAmountCents: 700 },
        { stripeSubscriptionId: SUB_B, anniversaryYear: 2, monthlyAmountCents: 700 },
      ],
    });
  });

  it("sends each due reminder and records the anniversary year after the send", async () => {
    const { db, recorded } = createDbMock([dueRow(SUB_A), dueRow(SUB_B, 2)]);
    const send = vi.fn(async (_input: MembershipAnnualReminderEmailInput) => {});
    const result = await sendMembershipAnnualReminders(db, send, parseSendMembershipAnnualRemindersArgs(["--live"]));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toEqual({
      email: "sub_A@example.com",
      monthlyAmountCents: 700,
      startedAt: new Date("2025-10-01T00:00:00Z"),
    });
    expect(recorded).toEqual([
      { id: SUB_A, year: 1, amount: 700 },
      { id: SUB_B, year: 2, amount: 700 },
    ]);
    expect(result).toMatchObject({ dryRun: false, dueCount: 2, sentCount: 2, recordedCount: 2, failures: [] });
  });

  it("keeps going past a failed send and reports it for the next run", async () => {
    const { db, recorded } = createDbMock([dueRow(SUB_A), dueRow(SUB_B)]);
    const send = vi.fn(async (input: MembershipAnnualReminderEmailInput) => {
      if (input.email.startsWith(SUB_A)) {
        throw new Error("SES down");
      }
    });
    const result = await sendMembershipAnnualReminders(db, send, parseSendMembershipAnnualRemindersArgs(["--live"]));
    expect(recorded).toEqual([{ id: SUB_B, year: 1, amount: 700 }]);
    expect(result.sentCount).toBe(1);
    expect(result.failures).toEqual([{ stripeSubscriptionId: SUB_A, stage: "send", reason: "SES down" }]);
  });

  it("flags a send whose record step failed as at-least-once", async () => {
    const { db } = createDbMock([dueRow(SUB_A)], true);
    const send = vi.fn(async () => {});
    const result = await sendMembershipAnnualReminders(db, send, parseSendMembershipAnnualRemindersArgs(["--live"]));
    expect(result).toMatchObject({ sentCount: 1, recordedCount: 0 });
    expect(result.failures).toEqual([
      { stripeSubscriptionId: SUB_A, stage: "record_after_send", reason: "insert failed" },
    ]);
  });
});

describe("annual reminder email", () => {
  const input: MembershipAnnualReminderEmailInput = {
    email: "member@example.com",
    monthlyAmountCents: 1250,
    startedAt: new Date("2025-10-01T12:00:00Z"),
  };

  it("states the amount, monthly frequency, start date, and how to cancel (§17602 contents)", () => {
    const text = buildAnnualReminderTextBody(input, "https://example.com/me/membership", "https://example.com/terms");
    expect(text).toContain("since October 1, 2025");
    expect(text).toContain("$12.50 is charged to your payment method each month until you cancel");
    expect(text).toContain("https://example.com/me/membership");
    expect(text).toContain("end of the current billing period");
    expect(text).not.toContain("Unsubscribe");
    const html = buildAnnualReminderHtmlBody(input, "https://example.com/me/membership?a=<b>", "https://example.com/terms");
    expect(html).toContain('href="https://example.com/me/membership?a=&lt;b&gt;"');
    expect(html).toContain("<strong>$12.50</strong>");
  });
});

describe("buildAnnualReminderSenderFromEnv", () => {
  it("needs a site origin for the Manage membership link, then honors the console mailer", () => {
    vi.stubEnv("SITE_ORIGIN", "");
    vi.stubEnv("AUTH_PUBLIC_BASE_URL", "");
    vi.stubEnv("NOTIFICATIONS_MAILER", "console");
    expect(() => buildAnnualReminderSenderFromEnv()).toThrow("SITE_ORIGIN");

    vi.stubEnv("SITE_ORIGIN", "https://example.com/");
    expect(typeof buildAnnualReminderSenderFromEnv()).toBe("function");
  });
});
