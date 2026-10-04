import { beforeAll, describe, expect, it, vi } from "vitest";

import { AuthGoogleSignInError, createAuthService } from "../../src/auth/authService.js";
import { CURRENT_TERMS_VERSION } from "../../src/constants/legal.js";
import { hashPassword } from "../../src/auth/authPrimitives.js";
import type { GoogleIdTokenPayload } from "../../src/auth/googleIdToken.js";
import { RequestValidationError } from "../../src/utils/requestValidationError.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const GOOGLE_SUB = "108256793412470351234";
let currentPasswordHash: string;

beforeAll(async () => {
  currentPasswordHash = await hashPassword("correct-password-123");
});

function createDbClientMock() {
  return {
    query: vi.fn(),
    release: vi.fn(),
  };
}

function createDbMock(client: ReturnType<typeof createDbClientMock>) {
  return {
    connect: vi.fn().mockResolvedValue(client),
    query: vi.fn(),
  };
}

function createRedisMock() {
  return {
    get: vi.fn().mockResolvedValue(null),
    setEx: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
    sAdd: vi.fn().mockResolvedValue(1),
    sRem: vi.fn().mockResolvedValue(1),
    sMembers: vi.fn().mockResolvedValue([]),
    expire: vi.fn().mockResolvedValue(1),
  };
}

function createMailerMock() {
  return {
    sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
    sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
    sendEmailChangeEmail: vi.fn().mockResolvedValue(undefined),
    sendExistingAccountEmail: vi.fn().mockResolvedValue(undefined),
  };
}

function googleUserRow(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    email: "user@gmail.com",
    first_name: "User",
    password_hash: currentPasswordHash,
    google_sub: null,
    email_verified: true,
    session_epoch: 1,
    ...overrides,
  };
}

function googlePayload(overrides: Partial<GoogleIdTokenPayload> = {}): GoogleIdTokenPayload {
  return {
    sub: GOOGLE_SUB,
    email: "user@gmail.com",
    email_verified: true,
    given_name: "Guser",
    ...overrides,
  };
}

function createService(options: {
  client: ReturnType<typeof createDbClientMock>;
  payload?: GoogleIdTokenPayload;
  verify?: ReturnType<typeof vi.fn>;
  redis?: ReturnType<typeof createRedisMock>;
  db?: ReturnType<typeof createDbMock>;
}) {
  const verify = options.verify ?? vi.fn().mockResolvedValue(options.payload ?? googlePayload());
  const redis = options.redis ?? createRedisMock();
  const db = options.db ?? createDbMock(options.client);
  const service = createAuthService({
    db: db as never,
    redis: redis as never,
    mailer: createMailerMock(),
    publicBaseUrl: "https://example.com",
    verifyGoogleIdToken: verify as never,
  });
  return { service, verify, redis, db };
}

describe("createAuthService loginWithGoogle", () => {
  it("is absent when no verifier is configured", () => {
    const service = createAuthService({
      db: createDbMock(createDbClientMock()) as never,
      redis: createRedisMock() as never,
      mailer: createMailerMock(),
      publicBaseUrl: "https://example.com",
    });
    expect(service.loginWithGoogle).toBeUndefined();
  });

  it("signup creates a verified, password-less, linked user and records terms", async () => {
    const client = createDbClientMock();
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // sub lookup: none
      .mockResolvedValueOnce({ rows: [] }) // email lookup: none
      .mockResolvedValueOnce({ rows: [{ id: USER_ID, session_epoch: 1 }] }) // INSERT user
      .mockResolvedValueOnce({ rows: [] }) // INSERT terms acceptance
      .mockResolvedValueOnce({ rows: [] }) // last_logged_in
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    const { service, redis } = createService({ client });

    const result = await service.loginWithGoogle!({
      idToken: "token",
      intent: "signup",
      acceptedTermsVersion: CURRENT_TERMS_VERSION,
    });

    expect(result.sessionId).toEqual(expect.any(String));
    const insertCall = client.query.mock.calls.find((call) => String(call[0]).includes("INSERT INTO public.users"));
    // Verified at birth, no password, linked by sub — all in one statement.
    expect(String(insertCall?.[0])).toContain("NULL, true, $3, $4");
    expect(insertCall?.[1]).toEqual(["Guser", "user@gmail.com", GOOGLE_SUB, CURRENT_TERMS_VERSION]);
    const ledgerCall = client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.user_terms_acceptances")
    );
    expect(ledgerCall?.[1]).toEqual([USER_ID, CURRENT_TERMS_VERSION, "registration"]);
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(redis.setEx).toHaveBeenCalledWith(expect.any(String), expect.any(Number), `${USER_ID}:1`);
  });

  it("signup accepts a legacy googlemail.com alias address", async () => {
    const client = createDbClientMock();
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // sub lookup
      .mockResolvedValueOnce({ rows: [] }) // email lookup
      .mockResolvedValueOnce({ rows: [{ id: USER_ID, session_epoch: 1 }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }) // terms
      .mockResolvedValueOnce({ rows: [] }) // last_logged_in
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    const { service } = createService({
      client,
      payload: googlePayload({ email: "person@googlemail.com" }),
    });

    await expect(
      service.loginWithGoogle!({ idToken: "token", intent: "signup", acceptedTermsVersion: CURRENT_TERMS_VERSION })
    ).resolves.toEqual({ sessionId: expect.any(String) });
  });

  it("signup accepts a Workspace (hd) address that is not gmail", async () => {
    const client = createDbClientMock();
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // sub lookup
      .mockResolvedValueOnce({ rows: [] }) // email lookup
      .mockResolvedValueOnce({ rows: [{ id: USER_ID, session_epoch: 1 }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }) // terms
      .mockResolvedValueOnce({ rows: [] }) // last_logged_in
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    const { service } = createService({
      client,
      payload: googlePayload({ email: "person@corp.example", hd: "corp.example" }),
    });

    await expect(
      service.loginWithGoogle!({ idToken: "token", intent: "signup", acceptedTermsVersion: CURRENT_TERMS_VERSION })
    ).resolves.toEqual({ sessionId: expect.any(String) });
  });

  it("caps an oversized given_name at 80 characters", async () => {
    const client = createDbClientMock();
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // sub lookup
      .mockResolvedValueOnce({ rows: [] }) // email lookup
      .mockResolvedValueOnce({ rows: [{ id: USER_ID, session_epoch: 1 }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }) // terms
      .mockResolvedValueOnce({ rows: [] }) // last_logged_in
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    const { service } = createService({
      client,
      payload: googlePayload({ given_name: "x".repeat(100) }),
    });

    await service.loginWithGoogle!({
      idToken: "token",
      intent: "signup",
      acceptedTermsVersion: CURRENT_TERMS_VERSION,
    });

    const insertCall = client.query.mock.calls.find((call) => String(call[0]).includes("INSERT INTO public.users"));
    expect(insertCall?.[1]?.[0]).toBe("x".repeat(80));
  });

  it("sub match is a plain login that touches no email/terms fields", async () => {
    const client = createDbClientMock();
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [googleUserRow({ google_sub: GOOGLE_SUB, session_epoch: 7 })] }) // sub lookup
      .mockResolvedValueOnce({ rows: [] }) // last_logged_in
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    const { service, redis } = createService({ client });

    const result = await service.loginWithGoogle!({ idToken: "token", intent: "login" });

    expect(result.sessionId).toEqual(expect.any(String));
    expect(redis.setEx).toHaveBeenCalledWith(expect.any(String), expect.any(Number), `${USER_ID}:7`);
    const writes = client.query.mock.calls.map((call) => String(call[0]));
    expect(writes.some((sql) => sql.includes("accepted_terms_version"))).toBe(false);
    expect(writes.some((sql) => sql.includes("SET google_sub"))).toBe(false);
  });

  it("links a verified matching-email row under login intent", async () => {
    const client = createDbClientMock();
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // sub lookup: none
      .mockResolvedValueOnce({ rows: [googleUserRow({ session_epoch: 3 })] }) // email lookup: verified, unlinked
      .mockResolvedValueOnce({ rows: [] }) // link UPDATE
      .mockResolvedValueOnce({ rows: [] }) // last_logged_in
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    const { service, redis } = createService({ client });

    await service.loginWithGoogle!({ idToken: "token", intent: "login" });

    const linkCall = client.query.mock.calls.find((call) => String(call[0]).includes("SET google_sub = $2"));
    expect(String(linkCall?.[0])).toContain("google_sub IS NULL");
    expect(linkCall?.[1]).toEqual([USER_ID, GOOGLE_SUB]);
    expect(redis.setEx).toHaveBeenCalledWith(expect.any(String), expect.any(Number), `${USER_ID}:3`);
  });

  it("signup takes over an unverified row: verify, clear password, bump epoch, replace terms", async () => {
    const client = createDbClientMock();
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // sub lookup
      .mockResolvedValueOnce({ rows: [googleUserRow({ email_verified: false, session_epoch: 4 })] }) // email lookup
      .mockResolvedValueOnce({ rows: [{ session_epoch: 5 }] }) // takeover UPDATE
      .mockResolvedValueOnce({ rows: [] }) // terms acceptance
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // void every outstanding link
      .mockResolvedValueOnce({ rows: [] }) // last_logged_in
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    const { service, redis } = createService({ client });

    await service.loginWithGoogle!({
      idToken: "token",
      intent: "signup",
      acceptedTermsVersion: CURRENT_TERMS_VERSION,
    });

    const takeoverCall = client.query.mock.calls.find((call) => String(call[0]).includes("password_hash = NULL"));
    // The pre-registrant's password AND sessions both die with the takeover.
    expect(String(takeoverCall?.[0])).toContain("email_verified = true");
    expect(String(takeoverCall?.[0])).toContain("session_epoch = session_epoch + 1");
    expect(takeoverCall?.[1]).toEqual([USER_ID, GOOGLE_SUB, "Guser", CURRENT_TERMS_VERSION]);
    const ledgerCall = client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.user_terms_acceptances")
    );
    expect(ledgerCall?.[1]).toEqual([USER_ID, CURRENT_TERMS_VERSION, "registration"]);
    // Session rides the BUMPED epoch, so pre-takeover sessions are dead.
    expect(redis.setEx).toHaveBeenCalledWith(expect.any(String), expect.any(Number), `${USER_ID}:5`);
    // ...and so is every link the pre-registrant requested (all purposes).
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("SET consumed_at = clock_timestamp()"), [
      USER_ID,
      ["email_verify", "password_reset", "email_change"],
    ]);
  });

  it("rejects an unverified-row login intent with needs_signup", async () => {
    const client = createDbClientMock();
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // sub lookup
      .mockResolvedValueOnce({ rows: [googleUserRow({ email_verified: false })] }); // email lookup
    const { service } = createService({ client });

    await expect(service.loginWithGoogle!({ idToken: "token", intent: "login" })).rejects.toMatchObject({
      name: "AuthGoogleSignInError",
      code: "needs_signup",
    });
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("rejects a new-user login intent with needs_signup", async () => {
    const client = createDbClientMock();
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // sub lookup
      .mockResolvedValueOnce({ rows: [] }); // email lookup
    const { service } = createService({ client });

    await expect(service.loginWithGoogle!({ idToken: "token", intent: "login" })).rejects.toBeInstanceOf(
      AuthGoogleSignInError
    );
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("never overwrites a row already linked to a different Google account", async () => {
    const client = createDbClientMock();
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // sub lookup (this token's sub)
      .mockResolvedValueOnce({ rows: [googleUserRow({ google_sub: "other-google-sub" })] }); // email lookup
    const { service } = createService({ client });

    await expect(
      service.loginWithGoogle!({ idToken: "token", intent: "signup", acceptedTermsVersion: CURRENT_TERMS_VERSION })
    ).rejects.toThrow(/cannot be linked/);
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    const writes = client.query.mock.calls.map((call) => String(call[0]));
    expect(writes.some((sql) => sql.includes("SET google_sub"))).toBe(false);
  });

  it("rejects non-authoritative addresses (verified but neither gmail nor Workspace) without touching the DB", async () => {
    const client = createDbClientMock();
    const db = createDbMock(client);
    const { service } = createService({
      client,
      db,
      payload: googlePayload({ email: "person@outlook.com" }),
    });

    await expect(
      service.loginWithGoogle!({ idToken: "token", intent: "signup", acceptedTermsVersion: CURRENT_TERMS_VERSION })
    ).rejects.toThrow(/Gmail and Google Workspace/);
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("rejects email_verified: false as a generic invalid credential", async () => {
    const client = createDbClientMock();
    const { service } = createService({ client, payload: googlePayload({ email_verified: false }) });

    await expect(service.loginWithGoogle!({ idToken: "token", intent: "login" })).rejects.toThrow(
      /invalid credential/
    );
  });

  it("rejects a missing sub as a generic invalid credential", async () => {
    const client = createDbClientMock();
    const { service } = createService({ client, payload: googlePayload({ sub: "  " }) });

    await expect(service.loginWithGoogle!({ idToken: "token", intent: "login" })).rejects.toThrow(
      /invalid credential/
    );
  });

  it("normalizes any verifier throw into a generic invalid-credential 400, not a 500", async () => {
    const client = createDbClientMock();
    const verify = vi.fn().mockRejectedValue(new Error("Wrong number of segments in token: abc"));
    const { service } = createService({ client, verify });

    await expect(service.loginWithGoogle!({ idToken: "token", intent: "login" })).rejects.toThrow(
      RequestValidationError
    );
  });

  it("requires an accepted terms version for signup before verifying anything", async () => {
    const client = createDbClientMock();
    const { service, verify } = createService({ client });

    await expect(
      service.loginWithGoogle!({ idToken: "token", intent: "signup", acceptedTermsVersion: "0.9" })
    ).rejects.toThrow(/accepted terms version/);
    await expect(service.loginWithGoogle!({ idToken: "token", intent: "signup" })).rejects.toThrow(
      /accepted terms version/
    );
    expect(verify).not.toHaveBeenCalled();
  });

  it("retries once on a unique-index race and resolves the committed row", async () => {
    const client = createDbClientMock();
    client.query
      // Attempt 1: no rows, INSERT loses the race.
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // sub lookup
      .mockResolvedValueOnce({ rows: [] }) // email lookup
      .mockRejectedValueOnce(Object.assign(new Error("duplicate key"), { code: "23505" })) // INSERT
      .mockResolvedValueOnce({ rows: [] }) // ROLLBACK
      // Attempt 2: the winner's row is there by sub.
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [googleUserRow({ google_sub: GOOGLE_SUB })] }) // sub lookup
      .mockResolvedValueOnce({ rows: [] }) // last_logged_in
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    const { service } = createService({ client });

    await expect(
      service.loginWithGoogle!({ idToken: "token", intent: "signup", acceptedTermsVersion: CURRENT_TERMS_VERSION })
    ).resolves.toEqual({ sessionId: expect.any(String) });
  });

  it("destroys the presented session (fixation) before creating the fresh one", async () => {
    const client = createDbClientMock();
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [googleUserRow({ google_sub: GOOGLE_SUB })] }) // sub lookup
      .mockResolvedValueOnce({ rows: [] }) // last_logged_in
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    const { service, redis } = createService({ client });

    await service.loginWithGoogle!({ idToken: "token", intent: "login", currentSessionId: "stale-session" });

    expect(redis.del).toHaveBeenCalled();
    expect(redis.setEx).toHaveBeenCalled();
  });
});

describe("NULL password_hash guards (Google-only accounts)", () => {
  it("login rejects the dummy-hash literal against a password-less account", async () => {
    const client = createDbClientMock();
    const db = createDbMock(client);
    db.query.mockResolvedValueOnce({ rows: [googleUserRow({ password_hash: null, google_sub: GOOGLE_SUB })] });
    const service = createAuthService({
      db: db as never,
      redis: createRedisMock() as never,
      mailer: createMailerMock(),
      publicBaseUrl: "https://example.com",
    });

    // The dummy hash is a real Argon2 hash of exactly this literal; without
    // the NULL guard this login would succeed.
    await expect(
      service.login({ email: "user@gmail.com", password: "auth-login-dummy-password" })
    ).rejects.toThrow("Invalid email or password");
  });

  it("changePassword rejects password-less accounts", async () => {
    const client = createDbClientMock();
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [googleUserRow({ password_hash: null })] }); // FOR UPDATE lookup
    const service = createAuthService({
      db: createDbMock(client) as never,
      redis: createRedisMock() as never,
      mailer: createMailerMock(),
      publicBaseUrl: "https://example.com",
    });

    await expect(
      service.changePassword({
        userId: USER_ID,
        currentPassword: "auth-login-dummy-password",
        newPassword: "a-long-enough-new-password",
      })
    ).rejects.toThrow("Current password is incorrect");
  });

  it("requestEmailChange rejects password-less accounts", async () => {
    const client = createDbClientMock();
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [googleUserRow({ password_hash: null })] }); // FOR UPDATE lookup
    const service = createAuthService({
      db: createDbMock(client) as never,
      redis: createRedisMock() as never,
      mailer: createMailerMock(),
      publicBaseUrl: "https://example.com",
    });

    await expect(
      service.requestEmailChange({
        userId: USER_ID,
        newEmail: "new@example.com",
        password: "auth-login-dummy-password",
      })
    ).rejects.toThrow("Password is incorrect");
  });

  it("deleteAccount rejects a password on password-less accounts", async () => {
    const client = createDbClientMock();
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [googleUserRow({ password_hash: null })] }); // FOR UPDATE lookup
    const service = createAuthService({
      db: createDbMock(client) as never,
      redis: createRedisMock() as never,
      mailer: createMailerMock(),
      publicBaseUrl: "https://example.com",
    });

    await expect(
      service.deleteAccount({ userId: USER_ID, password: "auth-login-dummy-password" })
    ).rejects.toThrow("Password is incorrect");
  });

  it("deleteAccount hard-deletes a password-less account confirmed by its linked Google account", async () => {
    const client = createDbClientMock();
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [googleUserRow({ password_hash: null, google_sub: GOOGLE_SUB })] })
      .mockResolvedValue({ rows: [] }); // scrubs, DELETE, COMMIT
    const verify = vi.fn().mockResolvedValue(googlePayload());
    const service = createAuthService({
      db: createDbMock(client) as never,
      redis: createRedisMock() as never,
      mailer: createMailerMock(),
      publicBaseUrl: "https://example.com",
      verifyGoogleIdToken: verify,
    });

    await service.deleteAccount({ userId: USER_ID, googleCredential: "google-jwt" });

    expect(verify).toHaveBeenCalledWith("google-jwt");
    const statements = client.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => /DELETE FROM public\.users\s+WHERE id = \$1::uuid/.test(sql))).toBe(true);
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("deleteAccount rejects a Google account other than the linked one", async () => {
    const client = createDbClientMock();
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [googleUserRow({ password_hash: null, google_sub: GOOGLE_SUB })] })
      .mockResolvedValue({ rows: [] });
    const service = createAuthService({
      db: createDbMock(client) as never,
      redis: createRedisMock() as never,
      mailer: createMailerMock(),
      publicBaseUrl: "https://example.com",
      verifyGoogleIdToken: vi.fn().mockResolvedValue(googlePayload({ sub: "999999999999999999999" })),
    });

    await expect(service.deleteAccount({ userId: USER_ID, googleCredential: "google-jwt" })).rejects.toThrow(
      "That Google account is not the one linked to this account"
    );
    const statements = client.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes("DELETE FROM public.users"))).toBe(false);
  });

  it("deleteAccount rejects a Google credential that fails verification", async () => {
    const client = createDbClientMock();
    const db = createDbMock(client);
    const service = createAuthService({
      db: db as never,
      redis: createRedisMock() as never,
      mailer: createMailerMock(),
      publicBaseUrl: "https://example.com",
      verifyGoogleIdToken: vi.fn().mockRejectedValue(new Error("bad signature")),
    });

    await expect(service.deleteAccount({ userId: USER_ID, googleCredential: "forged" })).rejects.toThrow(
      "Google sign-in failed: invalid credential"
    );
    expect(db.connect).not.toHaveBeenCalled();
  });
});
