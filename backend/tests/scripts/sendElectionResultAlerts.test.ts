import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_RESULT_ALERT_MAX_ITEMS_PER_EMAIL,
  DEFAULT_RESULT_ALERT_MAX_USERS,
  ELECTION_RESULT_ALERT_RUN_LOCK_KEY,
  parseSendElectionResultAlertsArgs,
  sendElectionResultAlerts,
  withElectionResultAlertRunLock,
} from "../../src/scripts/sendElectionResultAlerts.js";
import { DIGEST_RUN_LOCK_KEY } from "../../src/scripts/sendCandidateFollowDigests.js";
import { NEW_ELECTION_ALERT_RUN_LOCK_KEY } from "../../src/scripts/sendNewElectionAlerts.js";
import type { ElectionResultAlertEmailInput } from "../../src/pipeline/users/electionResultAlertMailer.js";

const USER_ALPHA = "11111111-1111-4111-8111-111111111111";
const USER_BETA = "22222222-2222-4222-8222-222222222222";

type PendingRow = {
  id: string;
  election_title: string;
  election_date: string;
  district_name: string;
  outcome: string;
  winners: unknown;
  result_status: string;
};

function pendingRow(id: string, district: string, overrides: Partial<PendingRow> = {}): PendingRow {
  return {
    id,
    election_title: "County Assessor",
    election_date: "2026-11-03",
    district_name: district,
    outcome: "won",
    winners: [{ candidate_name: "Jane Doe", party: "Democratic" }],
    result_status: "unofficial",
    ...overrides,
  };
}

// Routes the sender's statements by their distinguishing SQL fragments.
function createDbMock(fixtures: {
  orphanCount?: number;
  users: Array<{ id: string; email: string; first_name: string }>;
  pendingByUser: Record<string, PendingRow[]>;
  failMark?: boolean;
}) {
  const markedEventIds: string[][] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes("count(*)")) {
      return { rows: [{ matched: String(fixtures.orphanCount ?? 0) }], rowCount: 1 };
    }
    if (sql.includes("ANY($1::uuid[])")) {
      if (fixtures.failMark) {
        throw new Error("mark update failed");
      }
      markedEventIds.push([...(params?.[0] as string[])]);
      return { rows: [], rowCount: (params?.[0] as string[]).length };
    }
    if (sql.includes("SET notified_at = now()")) {
      return { rows: [], rowCount: fixtures.orphanCount ?? 0 };
    }
    if (sql.includes("FROM public.users AS u")) {
      return { rows: fixtures.users, rowCount: fixtures.users.length };
    }
    if (sql.includes("district_name")) {
      const userId = params?.[0] as string;
      const rows = fixtures.pendingByUser[userId] ?? [];
      return { rows, rowCount: rows.length };
    }
    throw new Error(`Unexpected SQL in test: ${sql.slice(0, 80)}`);
  });
  return { query, markedEventIds };
}

function createMailerMock(failFor?: string) {
  const sent: ElectionResultAlertEmailInput[] = [];
  return {
    sent,
    sendResultAlertEmail: vi.fn(async (input: ElectionResultAlertEmailInput) => {
      if (failFor && input.email === failFor) {
        throw new Error("SES exploded");
      }
      sent.push(input);
    }),
  };
}

describe("parseSendElectionResultAlertsArgs", () => {
  it("defaults to a dry run with default caps", () => {
    expect(parseSendElectionResultAlertsArgs([])).toEqual({
      live: false,
      maxUsers: DEFAULT_RESULT_ALERT_MAX_USERS,
      maxItemsPerEmail: DEFAULT_RESULT_ALERT_MAX_ITEMS_PER_EMAIL,
    });
  });

  it("parses --live and both flag forms", () => {
    expect(
      parseSendElectionResultAlertsArgs(["--live", "--max-users", "25", "--max-items-per-email=5"])
    ).toEqual({ live: true, maxUsers: 25, maxItemsPerEmail: 5 });
  });
});

describe("sendElectionResultAlerts", () => {
  const options = { live: true, maxUsers: 10, maxItemsPerEmail: 20 };

  it("dry run counts orphans and pending events without sending or marking", async () => {
    const db = createDbMock({
      orphanCount: 4,
      users: [{ id: USER_ALPHA, email: "a@example.com", first_name: "Ada" }],
      pendingByUser: { [USER_ALPHA]: [pendingRow("e1", "Los Angeles County")] },
    });
    const mailer = createMailerMock();

    const result = await sendElectionResultAlerts(db as never, mailer, { ...options, live: false });

    expect(result).toMatchObject({
      dryRun: true,
      resolvedWithoutEmailCount: 4,
      eligibleUserCount: 1,
      eventsPendingCount: 1,
      usersEmailedCount: 0,
      eventsDeliveredCount: 0,
      failures: [],
    });
    expect(mailer.sendResultAlertEmail).not.toHaveBeenCalled();
    expect(db.markedEventIds).toEqual([]);
    // Dry run counts orphans via SELECT; it must never run the orphan UPDATE.
    const sqls = db.query.mock.calls.map((call) => String(call[0]));
    expect(sqls.some((sql) => sql.includes("count(*)"))).toBe(true);
    expect(sqls.some((sql) => sql.includes("UPDATE public.user_election_result_notification_events"))).toBe(
      false
    );
  });

  it("live run sends one results email per user and marks exactly the sent events", async () => {
    const db = createDbMock({
      users: [
        { id: USER_ALPHA, email: "a@example.com", first_name: "Ada" },
        { id: USER_BETA, email: "b@example.com", first_name: "Bea" },
      ],
      pendingByUser: {
        [USER_ALPHA]: [
          pendingRow("e1", "Los Angeles County"),
          pendingRow("e2", "Los Angeles County", {
            election_title: "Measure A",
            outcome: "passed",
            winners: [],
          }),
        ],
        [USER_BETA]: [pendingRow("e3", "Texas Senate District 19", { result_status: "certified" })],
      },
    });
    const mailer = createMailerMock();

    const result = await sendElectionResultAlerts(db as never, mailer, options);

    expect(result).toMatchObject({
      dryRun: false,
      eligibleUserCount: 2,
      eventsPendingCount: 3,
      usersEmailedCount: 2,
      eventsDeliveredCount: 3,
      failures: [],
    });
    expect(mailer.sent).toHaveLength(2);
    expect(mailer.sent[0]).toMatchObject({
      email: "a@example.com",
      firstName: "Ada",
      totalEventCount: 2,
    });
    // Winner jsonb becomes display names; measures carry no winners.
    expect(mailer.sent[0]?.items[0]).toMatchObject({
      outcome: "won",
      winnerNames: ["Jane Doe (Democratic)"],
    });
    expect(mailer.sent[0]?.items[1]).toMatchObject({ outcome: "passed", winnerNames: [] });
    // Any result short of certified flags the whole email as unofficial.
    expect(mailer.sent[0]?.hasUnofficialResults).toBe(true);
    expect(mailer.sent[1]?.hasUnofficialResults).toBe(false);
    expect(db.markedEventIds).toEqual([["e1", "e2"], ["e3"]]);
  });

  it("isolates a failed send: records the failure, does not mark, continues", async () => {
    const db = createDbMock({
      users: [
        { id: USER_ALPHA, email: "fail@example.com", first_name: "Ada" },
        { id: USER_BETA, email: "b@example.com", first_name: "Bea" },
      ],
      pendingByUser: {
        [USER_ALPHA]: [pendingRow("e1", "Los Angeles County")],
        [USER_BETA]: [pendingRow("e2", "Texas Senate District 19")],
      },
    });
    const mailer = createMailerMock("fail@example.com");

    const result = await sendElectionResultAlerts(db as never, mailer, options);

    expect(result.usersEmailedCount).toBe(1);
    expect(result.eventsDeliveredCount).toBe(1);
    expect(result.failures).toEqual([
      { userId: USER_ALPHA, stage: "send", reason: "SES exploded" },
    ]);
    expect(db.markedEventIds).toEqual([["e2"]]);
  });

  it("records a mark_after_send failure when the email went out but stamping failed", async () => {
    const db = createDbMock({
      users: [{ id: USER_ALPHA, email: "a@example.com", first_name: "Ada" }],
      pendingByUser: { [USER_ALPHA]: [pendingRow("e1", "Los Angeles County")] },
      failMark: true,
    });
    const mailer = createMailerMock();

    const result = await sendElectionResultAlerts(db as never, mailer, options);

    expect(result.usersEmailedCount).toBe(1);
    expect(result.eventsDeliveredCount).toBe(0);
    expect(result.failures).toEqual([
      { userId: USER_ALPHA, stage: "mark_after_send", reason: "mark update failed" },
    ]);
  });

  it("caps rendered items per email while marking and counting every event", async () => {
    const db = createDbMock({
      users: [{ id: USER_ALPHA, email: "a@example.com", first_name: "Ada" }],
      pendingByUser: {
        [USER_ALPHA]: [
          pendingRow("e1", "Los Angeles County"),
          pendingRow("e2", "Los Angeles County"),
          pendingRow("e3", "Los Angeles County"),
        ],
      },
    });
    const mailer = createMailerMock();

    await sendElectionResultAlerts(db as never, mailer, { ...options, maxItemsPerEmail: 2 });

    expect(mailer.sent[0]?.items).toHaveLength(2);
    expect(mailer.sent[0]?.totalEventCount).toBe(3);
    expect(db.markedEventIds).toEqual([["e1", "e2", "e3"]]);
  });

  it("passes the built per-user unsubscribe URL to the mailer", async () => {
    const db = createDbMock({
      users: [{ id: USER_ALPHA, email: "a@example.com", first_name: "Ada" }],
      pendingByUser: { [USER_ALPHA]: [pendingRow("e1", "Los Angeles County")] },
    });
    const mailer = createMailerMock();

    await sendElectionResultAlerts(db as never, mailer, {
      ...options,
      buildUnsubscribeUrl: (userId) => `https://api.example.com/unsub?u=${userId}`,
    });

    expect(mailer.sent[0]?.unsubscribeUrl).toBe(`https://api.example.com/unsub?u=${USER_ALPHA}`);
  });
});

describe("withElectionResultAlertRunLock", () => {
  it("uses its own lock key, distinct from the digest and new-election locks", () => {
    expect(ELECTION_RESULT_ALERT_RUN_LOCK_KEY).not.toBe(DIGEST_RUN_LOCK_KEY);
    expect(ELECTION_RESULT_ALERT_RUN_LOCK_KEY).not.toBe(NEW_ELECTION_ALERT_RUN_LOCK_KEY);
  });

  it("skips the run when another process holds the lock", async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [{ locked: false }], rowCount: 1 }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const fn = vi.fn();

    await expect(withElectionResultAlertRunLock(pool as never, fn)).resolves.toBeNull();
    expect(fn).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("runs and unlocks when the lock is acquired", async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ locked: true }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) };

    await expect(withElectionResultAlertRunLock(pool as never, async () => "ran")).resolves.toBe("ran");
    expect(client.query).toHaveBeenCalledWith("SELECT pg_advisory_unlock($1)", [
      ELECTION_RESULT_ALERT_RUN_LOCK_KEY,
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
