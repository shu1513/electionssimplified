import type { Pool, PoolClient } from "pg";

import { createAuthSession, destroyAuthSession, destroyAuthSessionsByUserId, type AuthSessionRedisClient } from "./authSessionStore.js";
import {
  AUTH_TOKEN_PURPOSES,
  generateAuthToken,
  hashPassword,
  validatePasswordPolicy,
  verifyPassword,
  type AuthTokenPurpose,
} from "./authPrimitives.js";
import {
  issueUserAuthToken,
  consumeUserAuthToken,
  peekUserAuthToken,
  voidUserAuthTokens,
} from "./authTokenStore.js";
import type { AuthMailer } from "./authMailer.js";
import { isUuid } from "../utils/uuid.js";
import { CURRENT_TERMS_VERSION, isAcceptableTermsVersion } from "../constants/legal.js";
import { recordTermsAcceptance } from "../pipeline/users/userTermsAcceptances.js";
import { revokeAllUserPushTokens } from "../pipeline/users/userPushTokens.js";
import type { VerifyGoogleIdToken } from "./googleIdToken.js";
import { RequestValidationError } from "../utils/requestValidationError.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type TransactionalDb = Pick<Pool, "connect" | "query">;
type TransactionClient = Pick<PoolClient, "query" | "release">;

export const DEFAULT_AUTH_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
export const DEFAULT_AUTH_EMAIL_VERIFICATION_TTL_SECONDS = 60 * 60 * 24 * 3;
export const DEFAULT_AUTH_PASSWORD_RESET_TTL_SECONDS = 60 * 60 * 24;
export const DEFAULT_AUTH_EMAIL_CHANGE_TTL_SECONDS = 60 * 60 * 24;

export type AuthServiceOptions = {
  db: TransactionalDb;
  redis: AuthSessionRedisClient;
  mailer: AuthMailer;
  publicBaseUrl: string;
  sessionTtlSeconds?: number;
  emailVerificationTtlSeconds?: number;
  passwordResetTtlSeconds?: number;
  emailChangeTtlSeconds?: number;
  /** Present only when GOOGLE_OAUTH_CLIENT_ID is configured; its presence is
   * what enables loginWithGoogle on the returned service. Injected (rather
   * than constructed here) so tests stub it — no network in vitest. */
  verifyGoogleIdToken?: VerifyGoogleIdToken;
  /** Present only when Stripe is configured
   * (docs/plans/membership-contributions.md): cancels any live paid
   * membership at Stripe, returning true when one was actually canceled.
   * Deletion PRECONDITION — a throw here fails the delete request with
   * nothing deleted; cancel is idempotent, so the user simply retries. */
  cancelMembershipForAccountDeletion?: (userId: string) => Promise<boolean>;
  /** Present only when Stripe is configured: pushes the account's new email
   * onto the Stripe customer after a verified email change (Stripe otherwise
   * keeps prefilling Checkout and sending receipts to the old address).
   * Best-effort — a Stripe failure never fails the email change. */
  syncMembershipCustomerEmail?: (userId: string) => Promise<void>;
};

export type AuthRegisterInput = {
  email: string;
  password: string;
  firstName?: string;
  /** Terms/disclaimer version the user accepted at signup (clickwrap record). */
  acceptedTermsVersion: string;
};

export type AuthLoginInput = {
  email: string;
  password: string;
  currentSessionId?: string | null;
};

export type AuthLogoutInput = {
  currentSessionId?: string | null;
};

export type AuthForgotPasswordInput = {
  email: string;
};

export type AuthResetPasswordInput = {
  token: string;
  password: string;
};

export type AuthLoginResult = {
  sessionId: string;
};

export type AuthGoogleLoginInput = {
  idToken: string;
  /** Which page the button sat on. Only "signup" (the register page, behind
   * the LegalGate checkbox) may create or take over an account; the login
   * page's button can only sign in to accounts that already exist. */
  intent: "login" | "signup";
  /** Required for intent "signup" (clickwrap record, like register). */
  acceptedTermsVersion?: string;
  currentSessionId?: string | null;
};

/** Google sign-in outcomes the frontend routes on (vs. generic 400s). */
export class AuthGoogleSignInError extends Error {
  constructor(
    readonly code: "needs_signup",
    message: string
  ) {
    super(message);
    this.name = "AuthGoogleSignInError";
  }
}

export type AuthChangePasswordInput = {
  userId: string;
  currentPassword: string;
  newPassword: string;
};

/** Confirmed by exactly one of: the account password, or a fresh Google ID
 * token for the Google account linked to this user (the only confirmation a
 * Google-created account without a password can give). */
export type AuthDeleteAccountInput = {
  userId: string;
  password?: string;
  googleCredential?: string;
};

export type AuthRequestEmailChangeInput = {
  userId: string;
  newEmail: string;
  password: string;
};

export type AuthLogoutAllInput = {
  userId: string;
};

export type AuthService = {
  register(input: AuthRegisterInput): Promise<void>;
  verifyEmail(input: { token: string }): Promise<void>;
  login(input: AuthLoginInput): Promise<AuthLoginResult>;
  logout(input: AuthLogoutInput): Promise<void>;
  logoutAll(input: AuthLogoutAllInput): Promise<void>;
  forgotPassword(input: AuthForgotPasswordInput): Promise<void>;
  resendVerification(input: AuthForgotPasswordInput): Promise<void>;
  resetPassword(input: AuthResetPasswordInput): Promise<void>;
  /** Logged-in password change; rotates every session, returns the fresh one. */
  changePassword(input: AuthChangePasswordInput): Promise<AuthLoginResult>;
  /** Present only when the service was created with verifyGoogleIdToken. */
  loginWithGoogle?(input: AuthGoogleLoginInput): Promise<AuthLoginResult>;
  requestEmailChange(input: AuthRequestEmailChangeInput): Promise<void>;
  verifyEmailChange(input: { token: string }): Promise<void>;
  deleteAccount(input: AuthDeleteAccountInput): Promise<void>;
};

type AuthUserRow = {
  id: string;
  email: string;
  first_name: string;
  /** NULL on Google-created accounts that never set a password. */
  password_hash: string | null;
  email_verified: boolean;
  session_epoch: number;
};

function normalizeEmail(email: string): string {
  if (typeof email !== "string") {
    throw new RequestValidationError("Email must be a string");
  }
  const normalized = email.trim();
  if (normalized.length === 0) {
    throw new RequestValidationError("Email must be a non-empty string");
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    throw new RequestValidationError("Email must be a valid email address");
  }
  return normalized;
}

function normalizeOptionalFirstName(firstName: string | undefined): string | null {
  if (firstName === undefined) {
    return null;
  }
  if (typeof firstName !== "string") {
    throw new RequestValidationError("firstName must be a string");
  }
  const normalized = firstName.trim();
  return normalized.length > 0 ? normalized : null;
}

function deriveFirstName(email: string, providedFirstName: string | null): string {
  if (providedFirstName) {
    return providedFirstName;
  }
  const localPart = email.split("@", 1)[0]?.trim() ?? "";
  const collapsed = localPart.replace(/[._+-]+/g, " ").replace(/\s+/g, " ").trim();
  return collapsed.length > 0 ? collapsed.slice(0, 80) : "User";
}

function normalizePublicBaseUrl(publicBaseUrl: string): URL {
  if (typeof publicBaseUrl !== "string") {
    throw new Error("publicBaseUrl must be a string");
  }
  const normalized = publicBaseUrl.trim();
  if (normalized.length === 0) {
    throw new Error("publicBaseUrl must be a non-empty string");
  }
  const parsed = new URL(normalized);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("publicBaseUrl must use http or https");
  }
  return parsed;
}

function buildEmailLink(baseUrl: URL, path: string, token: string): string {
  const url = new URL(path, baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

async function rollbackQuietly(client: TransactionClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}

async function findActiveUserByEmail(db: Queryable, email: string): Promise<AuthUserRow | null> {
  const result = await db.query<AuthUserRow>(
    `
      SELECT
        id::text AS id,
        email::text AS email,
        first_name,
        password_hash,
        email_verified,
        session_epoch
      FROM public.users
      WHERE email = $1::citext
        AND deleted_at IS NULL
    `,
    [email]
  );
  return result.rows[0] ?? null;
}

async function findActiveUserByEmailForUpdate(db: Queryable, email: string): Promise<AuthUserRow | null> {
  const result = await db.query<AuthUserRow>(
    `
      SELECT
        id::text AS id,
        email::text AS email,
        first_name,
        password_hash,
        email_verified,
        session_epoch
      FROM public.users
      WHERE email = $1::citext
        AND deleted_at IS NULL
      FOR UPDATE
    `,
    [email]
  );
  return result.rows[0] ?? null;
}

function toEmailVerificationLink(baseUrl: URL, token: string): string {
  return buildEmailLink(baseUrl, "/verify-email", token);
}

function toEmailChangeLink(baseUrl: URL, token: string): string {
  return buildEmailLink(baseUrl, "/verify-email-change", token);
}

function toLoginLink(baseUrl: URL): string {
  return new URL("/login", baseUrl).toString();
}

function normalizeUserId(userId: string): string {
  const normalized = typeof userId === "string" ? userId.trim() : "";
  if (!isUuid(normalized)) {
    throw new RequestValidationError("userId must be a UUID");
  }
  return normalized;
}

async function findActiveUserByIdForUpdate(db: Queryable, userId: string): Promise<GoogleAuthUserRow | null> {
  const result = await db.query<GoogleAuthUserRow>(
    `
      SELECT
        id::text AS id,
        email::text AS email,
        first_name,
        password_hash,
        google_sub,
        email_verified,
        session_epoch
      FROM public.users
      WHERE id = $1::uuid
        AND deleted_at IS NULL
      FOR UPDATE
    `,
    [userId]
  );
  return result.rows[0] ?? null;
}

function toPasswordResetLink(baseUrl: URL, token: string): string {
  return buildEmailLink(baseUrl, "/reset-password", token);
}

/**
 * Token consumption in the same lock order as issuance and voiding (user row
 * first, then token rows): resolve the token's owner without consuming, lock
 * the user row FOR UPDATE, then consume atomically. The consume re-checks
 * validity after the lock wait, so a token voided by an ownership change
 * that committed in between (re-registration, Google takeover, password
 * change) is rejected. Consuming first and locking second would deadlock
 * against those user-first transactions.
 */
async function lockUserAndConsumeToken(
  client: Queryable,
  input: { token: string; purpose: AuthTokenPurpose; invalidMessage: string }
): Promise<NonNullable<Awaited<ReturnType<typeof consumeUserAuthToken>>>> {
  const now = new Date();
  const peeked = await peekUserAuthToken(client, { token: input.token, purpose: input.purpose, now });
  if (!peeked) {
    throw new RequestValidationError(input.invalidMessage);
  }
  const user = await findActiveUserByIdForUpdate(client, peeked.userId);
  if (!user) {
    throw new RequestValidationError(input.invalidMessage);
  }
  // Fresh clock for the consume: the lock wait may have crossed expires_at.
  const consumed = await consumeUserAuthToken(client, { token: input.token, purpose: input.purpose });
  if (!consumed) {
    throw new RequestValidationError(input.invalidMessage);
  }
  return consumed;
}

const DUMMY_PASSWORD_HASH_PROMISE = hashPassword("auth-login-dummy-password");

function normalizeSessionId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

async function updateLastLoggedIn(client: Queryable, userId: string): Promise<void> {
  await client.query(
    `
      UPDATE public.users
      SET last_logged_in = now()
      WHERE id = $1::uuid
        AND deleted_at IS NULL
    `,
    [userId]
  );
}

async function createOrRefreshAuthUser(
  client: Queryable,
  input: {
    email: string;
    firstName: string;
    passwordHash: string;
    acceptedTermsVersion: string;
  }
): Promise<AuthUserRow> {
  const existing = await findActiveUserByEmailForUpdate(client, input.email);
  if (existing && existing.email_verified) {
    // Registering an address that already belongs to a verified account is a
    // silent no-op (it must not reveal that the address is taken). Nothing is
    // written, and no acceptance is recorded either: whoever submitted this
    // form has not been shown to control the account, so attributing an
    // acceptance to it would put someone else's assent in their history.
    return existing;
  }

  if (existing) {
    // Re-registering an unverified address replaces its password, so it must
    // also revoke existing sessions (epoch bump). Otherwise an attacker who
    // pre-registered the victim's email and logged in would keep a live
    // session across the victim's registration — and inherit the account the
    // moment the victim verifies.
    const updated = await client.query<AuthUserRow>(
      `
        UPDATE public.users
        SET
          first_name = $2,
          password_hash = $3,
          accepted_terms_version = $4,
          accepted_terms_at = now(),
          session_epoch = session_epoch + 1,
          updated_at = now()
        WHERE id = $1::uuid
          AND deleted_at IS NULL
        RETURNING
          id::text AS id,
          email::text AS email,
          first_name,
          password_hash,
          email_verified,
          session_epoch
      `,
      [existing.id, input.firstName, input.passwordHash, input.acceptedTermsVersion]
    );
    const row = updated.rows[0];
    if (!row) {
      throw new Error("Failed to update auth user");
    }
    // Same transaction as the users write above, so the account cannot end up
    // claiming a version with no history behind it.
    await recordTermsAcceptance(client, {
      userId: row.id,
      termsVersion: input.acceptedTermsVersion,
      context: "registration",
    });
    // Ownership changes hands here, so links the pre-registrant requested
    // must die with their password and sessions: an outstanding email_change
    // link in THEIR inbox would otherwise still move this account's address
    // to them after the real owner verifies. (email_verify is re-issued by
    // the caller, which voids the old one.)
    await voidUserAuthTokens(client, { userId: row.id, purposes: ["password_reset", "email_change"] });
    return row;
  }

  const inserted = await client.query<AuthUserRow>(
    `
      INSERT INTO public.users (
        first_name,
        email,
        password_hash,
        email_verified,
        accepted_terms_version,
        accepted_terms_at
      )
      VALUES ($1, $2::citext, $3, false, $4, now())
      RETURNING
        id::text AS id,
        email::text AS email,
        first_name,
        password_hash,
        email_verified,
        session_epoch
    `,
    [input.firstName, input.email, input.passwordHash, input.acceptedTermsVersion]
  );
  const row = inserted.rows[0];
  if (!row) {
    throw new Error("Failed to create auth user");
  }
  await recordTermsAcceptance(client, {
    userId: row.id,
    termsVersion: input.acceptedTermsVersion,
    context: "registration",
  });
  return row;
}

type GoogleAuthUserRow = AuthUserRow & { google_sub: string | null };

const GOOGLE_AUTH_USER_COLUMNS = `
  id::text AS id,
  email::text AS email,
  first_name,
  password_hash,
  google_sub,
  email_verified,
  session_epoch
`;

/** Validated identity claims from a verified Google ID token. */
type GoogleIdentity = {
  sub: string;
  email: string;
  hd: string | null;
  givenName: string | null;
};

/** Strictly validates the claims loginWithGoogle relies on. Every rejection
 * is the same generic TypeError (→ 400): claim-level detail would only help
 * someone probing the endpoint with forged tokens. */
function validateGoogleClaims(payload: {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  hd?: string;
  given_name?: string;
}): GoogleIdentity {
  const invalid = () => new RequestValidationError("Google sign-in failed: invalid credential");
  const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (sub.length === 0) {
    throw invalid();
  }
  let email: string;
  try {
    email = normalizeEmail(payload.email ?? "");
  } catch {
    throw invalid();
  }
  // Matches the API layer's cap on registration emails (RFC 5321 path limit).
  if (email.length > 254 || payload.email_verified !== true) {
    throw invalid();
  }
  const hd = typeof payload.hd === "string" && payload.hd.trim().length > 0 ? payload.hd.trim() : null;
  // Google's own guidance on when its email claim is authoritative: gmail.com
  // addresses (including the legacy googlemail.com alias domain Google issued
  // in the UK/Germany — same inbox, Google-controlled), or Workspace accounts
  // (hd set). For anything else the address may have changed hands while
  // email_verified stays true, so auto-linking could hand an old
  // Google-account holder someone else's VoteApp account.
  const lowerEmail = email.toLowerCase();
  if (!lowerEmail.endsWith("@gmail.com") && !lowerEmail.endsWith("@googlemail.com") && hd === null) {
    throw new RequestValidationError(
      "Google sign-in is only available for Gmail and Google Workspace addresses. Use email signup or login instead."
    );
  }
  const givenName =
    typeof payload.given_name === "string" && payload.given_name.trim().length > 0
      ? payload.given_name.trim().slice(0, 80)
      : null;
  return { sub, email, hd, givenName };
}

function createLoginWithGoogle(deps: {
  verifyGoogleIdToken: VerifyGoogleIdToken;
  db: TransactionalDb;
  redis: AuthSessionRedisClient;
  sessionTtlSeconds: number;
}): (input: AuthGoogleLoginInput) => Promise<AuthLoginResult> {
  async function findActiveUserByGoogleSubForUpdate(
    client: Queryable,
    sub: string
  ): Promise<GoogleAuthUserRow | null> {
    const result = await client.query<GoogleAuthUserRow>(
      `
        SELECT ${GOOGLE_AUTH_USER_COLUMNS}
        FROM public.users
        WHERE google_sub = $1
          AND deleted_at IS NULL
        FOR UPDATE
      `,
      [sub]
    );
    return result.rows[0] ?? null;
  }

  async function findActiveGoogleUserByEmailForUpdate(
    client: Queryable,
    email: string
  ): Promise<GoogleAuthUserRow | null> {
    const result = await client.query<GoogleAuthUserRow>(
      `
        SELECT ${GOOGLE_AUTH_USER_COLUMNS}
        FROM public.users
        WHERE email = $1::citext
          AND deleted_at IS NULL
        FOR UPDATE
      `,
      [email]
    );
    return result.rows[0] ?? null;
  }

  /** One transaction: resolve the Google identity to a user row (creating,
   * linking, or taking over per the decision table in
   * docs/plans/google-sign-in.md) and return the id + epoch the session is
   * created under. Throws with the transaction rolled back on any rejection. */
  async function resolveUserOnce(
    identity: GoogleIdentity,
    input: AuthGoogleLoginInput
  ): Promise<{ userId: string; sessionEpoch: number }> {
    // Signup paths stamp the version the client's bundle actually presented
    // (already validated in loginWithGoogle — current or grace). Login paths
    // never touch terms fields, so the fallback is defensive only.
    const signupTermsVersion =
      typeof input.acceptedTermsVersion === "string" && input.acceptedTermsVersion.trim().length > 0
        ? input.acceptedTermsVersion.trim()
        : CURRENT_TERMS_VERSION;
    const client = await deps.db.connect();
    try {
      await client.query("BEGIN");

      // Sub match = returning Google user: plain login under either intent.
      // The stored email/name/terms are deliberately not touched — our email
      // is the contact channel and follows our email-change flow, not
      // Google's.
      const bySub = await findActiveUserByGoogleSubForUpdate(client, identity.sub);
      if (bySub) {
        await updateLastLoggedIn(client, bySub.id);
        await client.query("COMMIT");
        return { userId: bySub.id, sessionEpoch: bySub.session_epoch };
      }

      const byEmail = await findActiveGoogleUserByEmailForUpdate(client, identity.email);
      if (byEmail) {
        if (byEmail.google_sub !== null) {
          // The row is linked to a DIFFERENT Google account (a matching sub
          // would have been found above). Never overwrite the link: the
          // stored email deliberately does not follow Google email changes,
          // so an overwrite here would let a token holding a recycled email
          // steal the account. Generic message — detail only helps probing.
          throw new RequestValidationError("Google sign-in failed: this email cannot be linked to this Google account");
        }
        if (byEmail.email_verified) {
          // Both sides verified + authoritative: link (either intent).
          await client.query(
            `
              UPDATE public.users
              SET google_sub = $2,
                  updated_at = now()
              WHERE id = $1::uuid
                AND deleted_at IS NULL
                AND google_sub IS NULL
            `,
            [byEmail.id, identity.sub]
          );
          await updateLastLoggedIn(client, byEmail.id);
          await client.query("COMMIT");
          return { userId: byEmail.id, sessionEpoch: byEmail.session_epoch };
        }
        // Unverified row. Google login proves inbox control (the token's
        // verified email), so a SIGNUP takes the row over — mirroring the
        // password flow's re-register-unverified semantics, with the same
        // defenses against whoever pre-registered the address:
        //   - password_hash = NULL kills the pre-registrant's password,
        //   - the epoch bump kills their sessions,
        //   - terms fields are replaced and a fresh acceptance is recorded
        //     (the old acceptance may be the attacker's, so it must not be
        //     inherited).
        if (input.intent !== "signup") {
          throw new AuthGoogleSignInError(
            "needs_signup",
            "No account uses this Google account yet. Create your account from the signup page."
          );
        }
        const takeover = await client.query<{ session_epoch: number }>(
          `
            UPDATE public.users
            SET google_sub = $2,
                email_verified = true,
                password_hash = NULL,
                first_name = $3,
                accepted_terms_version = $4,
                accepted_terms_at = now(),
                session_epoch = session_epoch + 1,
                updated_at = now()
            WHERE id = $1::uuid
              AND deleted_at IS NULL
            RETURNING session_epoch
          `,
          [byEmail.id, identity.sub, identity.givenName ?? deriveFirstName(identity.email, null), signupTermsVersion]
        );
        const takeoverEpoch = takeover.rows[0]?.session_epoch;
        if (typeof takeoverEpoch !== "number") {
          throw new Error("Failed to link Google account");
        }
        await recordTermsAcceptance(client, {
          userId: byEmail.id,
          termsVersion: signupTermsVersion,
          context: "registration",
        });
        //   - every outstanding link the pre-registrant requested dies too
        //     (an email_change link in their inbox could otherwise still
        //     move this account's address to them).
        await voidUserAuthTokens(client, { userId: byEmail.id, purposes: [...AUTH_TOKEN_PURPOSES] });
        await updateLastLoggedIn(client, byEmail.id);
        await client.query("COMMIT");
        return { userId: byEmail.id, sessionEpoch: takeoverEpoch };
      }

      // No row at all: only a signup may create one.
      if (input.intent !== "signup") {
        throw new AuthGoogleSignInError(
          "needs_signup",
          "No account uses this Google account yet. Create your account from the signup page."
        );
      }
      const inserted = await client.query<{ id: string; session_epoch: number }>(
        `
          INSERT INTO public.users (
            first_name,
            email,
            password_hash,
            email_verified,
            google_sub,
            accepted_terms_version,
            accepted_terms_at
          )
          VALUES ($1, $2::citext, NULL, true, $3, $4, now())
          RETURNING id::text AS id, session_epoch
        `,
        [identity.givenName ?? deriveFirstName(identity.email, null), identity.email, identity.sub, signupTermsVersion]
      );
      const row = inserted.rows[0];
      if (!row) {
        throw new Error("Failed to create auth user");
      }
      await recordTermsAcceptance(client, {
        userId: row.id,
        termsVersion: signupTermsVersion,
        context: "registration",
      });
      await updateLastLoggedIn(client, row.id);
      await client.query("COMMIT");
      return { userId: row.id, sessionEpoch: row.session_epoch };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  return async function loginWithGoogle(input) {
    if (typeof input.idToken !== "string" || input.idToken.trim().length === 0) {
      throw new RequestValidationError("idToken must be a non-empty string");
    }
    if (input.intent !== "login" && input.intent !== "signup") {
      throw new RequestValidationError('intent must be "login" or "signup"');
    }
    if (input.intent === "signup") {
      const acceptedTermsVersion =
        typeof input.acceptedTermsVersion === "string" ? input.acceptedTermsVersion.trim() : "";
      // Same dual-layer rule as register: no caller may persist acceptance
      // of anything but the current version or a listed grace version.
      if (!isAcceptableTermsVersion(acceptedTermsVersion)) {
        throw new RequestValidationError(
          `acceptedTermsVersion must be an accepted terms version (current: ${CURRENT_TERMS_VERSION})`
        );
      }
    }

    let payload;
    try {
      payload = await deps.verifyGoogleIdToken(input.idToken);
    } catch {
      // Library errors (bad signature, wrong audience, expired, malformed)
      // must all surface as one generic 400, never a 500.
      throw new RequestValidationError("Google sign-in failed: invalid credential");
    }
    const identity = validateGoogleClaims(payload);

    let resolved: { userId: string; sessionEpoch: number };
    try {
      resolved = await resolveUserOnce(identity, input);
    } catch (error) {
      // Concurrent first sign-in for the same person can race the INSERT (or
      // the link UPDATE) into a unique-index violation; the loser retries
      // once in a fresh transaction and finds the committed row by sub/email.
      if ((error as { code?: string }).code === "23505") {
        resolved = await resolveUserOnce(identity, input);
      } else {
        throw error;
      }
    }

    // Same post-commit sequence as password login: best-effort fixation
    // cleanup of the presented session, then a fresh session under the epoch
    // read in the transaction (a concurrent bump makes the stale-epoch
    // session fail per-request validation — see login()).
    const currentSessionId = normalizeSessionId(input.currentSessionId);
    if (currentSessionId) {
      try {
        await destroyAuthSession(deps.redis, currentSessionId);
      } catch {
        // Best-effort fixation cleanup. The fresh session below is the source of truth.
      }
    }
    const session = await createAuthSession(deps.redis, {
      userId: resolved.userId,
      ttlSeconds: deps.sessionTtlSeconds,
      sessionEpoch: resolved.sessionEpoch,
    });
    return { sessionId: session.sessionId };
  };
}

async function issueEmailVerificationToken(
  client: Queryable,
  input: {
    userId: string;
    ttlSeconds: number;
  }
): Promise<{ rawToken: string; tokenHash: string }> {
  const token = generateAuthToken();
  await issueUserAuthToken(client, {
    userId: input.userId,
    tokenHash: token.tokenHash,
    purpose: "email_verify",
    expiresAt: new Date(Date.now() + input.ttlSeconds * 1000),
  });
  return token;
}

export function createAuthService(options: AuthServiceOptions): AuthService {
  const publicBaseUrl = normalizePublicBaseUrl(options.publicBaseUrl);
  const sessionTtlSeconds = options.sessionTtlSeconds ?? DEFAULT_AUTH_SESSION_TTL_SECONDS;
  const emailVerificationTtlSeconds = options.emailVerificationTtlSeconds ?? DEFAULT_AUTH_EMAIL_VERIFICATION_TTL_SECONDS;
  const passwordResetTtlSeconds = options.passwordResetTtlSeconds ?? DEFAULT_AUTH_PASSWORD_RESET_TTL_SECONDS;
  const emailChangeTtlSeconds = options.emailChangeTtlSeconds ?? DEFAULT_AUTH_EMAIL_CHANGE_TTL_SECONDS;
  // Configured-if-present: without a verifier the method itself is absent,
  // and the API layer answers "Google sign-in is not configured".
  const loginWithGoogle = options.verifyGoogleIdToken
    ? createLoginWithGoogle({
        verifyGoogleIdToken: options.verifyGoogleIdToken,
        db: options.db,
        redis: options.redis,
        sessionTtlSeconds,
      })
    : undefined;

  return {
    ...(loginWithGoogle ? { loginWithGoogle } : {}),
    async register(input) {
      const email = normalizeEmail(input.email);
      const firstName = deriveFirstName(email, normalizeOptionalFirstName(input.firstName));
      validatePasswordPolicy(input.password);
      const acceptedTermsVersion =
        typeof input.acceptedTermsVersion === "string" ? input.acceptedTermsVersion.trim() : "";
      // Enforced here as well as at the API layer: no caller (script, admin
      // tooling, future route) may persist acceptance of anything but the
      // current version or a listed grace version — the stored value is the
      // evidentiary record of what the visitor's bundle actually showed.
      if (!isAcceptableTermsVersion(acceptedTermsVersion)) {
        throw new RequestValidationError(
          `acceptedTermsVersion must be an accepted terms version (current: ${CURRENT_TERMS_VERSION})`
        );
      }
      const passwordHash = await hashPassword(input.password);
      const client = await options.db.connect();
      let token: Awaited<ReturnType<typeof issueEmailVerificationToken>> | null = null;

      try {
        await client.query("BEGIN");
        const user = await createOrRefreshAuthUser(client, {
          email,
          firstName,
          passwordHash,
          acceptedTermsVersion,
        });

        if (!user.email_verified) {
          token = await issueEmailVerificationToken(client, {
            userId: user.id,
            ttlSeconds: emailVerificationTtlSeconds,
          });
        }

        await client.query("COMMIT");
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      } finally {
        client.release();
      }

      // After the client is released (like forgotPassword): an SES call must
      // not hold a pool slot, and a mail failure must not run ROLLBACK on a
      // committed transaction. If the send fails the account still exists;
      // retrying the form re-registers the unverified address and resends.
      if (token === null) {
        // Address already has a verified account. The response is identical
        // to a fresh signup (no enumeration), so the only way the account
        // holder learns why no verification link arrives is this email —
        // which goes to the address itself, revealing nothing to the form.
        await options.mailer.sendExistingAccountEmail({ email, linkUrl: toLoginLink(publicBaseUrl) });
        return;
      }
      await options.mailer.sendVerificationEmail({
        email,
        linkUrl: toEmailVerificationLink(publicBaseUrl, token.rawToken),
      });
    },

    async resendVerification(input) {
      const email = normalizeEmail(input.email);
      const client = await options.db.connect();
      let token: Awaited<ReturnType<typeof issueEmailVerificationToken>> | null = null;

      try {
        await client.query("BEGIN");
        const user = await findActiveUserByEmailForUpdate(client, email);
        if (!user || user.email_verified) {
          await client.query("COMMIT");
          return;
        }

        token = await issueEmailVerificationToken(client, {
          userId: user.id,
          ttlSeconds: emailVerificationTtlSeconds,
        });

        await client.query("COMMIT");
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      } finally {
        client.release();
      }

      // Send after release — see register.
      await options.mailer.sendVerificationEmail({
        email,
        linkUrl: toEmailVerificationLink(publicBaseUrl, token.rawToken),
      });
    },

    async verifyEmail(input) {
      if (typeof input.token !== "string" || input.token.trim().length === 0) {
        throw new RequestValidationError("token must be a non-empty string");
      }

      const client = await options.db.connect();
      try {
        await client.query("BEGIN");
        const consumed = await lockUserAndConsumeToken(client, {
          token: input.token,
          purpose: "email_verify",
          invalidMessage: "Verification token is invalid or expired",
        });

        // Verification upgrades every session's privileges, so revoke the
        // pre-verification ones (epoch bump): a session created against the
        // unverified account — e.g. by whoever registered the address first —
        // must not silently become a verified-account session. The frontend
        // already tells the user to log in after verifying.
        const updated = await client.query(
          `
            UPDATE public.users
            SET email_verified = true,
                session_epoch = session_epoch + 1,
                updated_at = now()
            WHERE id = $1::uuid
              AND deleted_at IS NULL
          `,
          [consumed.userId]
        );
        if (updated.rowCount !== 1) {
          throw new Error("Failed to verify user email");
        }
        // Links requested before verification may sit in a pre-registrant's
        // inbox; verification settles ownership, so they die here.
        await voidUserAuthTokens(client, {
          userId: consumed.userId,
          purposes: ["password_reset", "email_change"],
        });

        await client.query("COMMIT");
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      } finally {
        client.release();
      }
    },

    async login(input) {
      const email = normalizeEmail(input.email);
      const user = await findActiveUserByEmail(options.db, email);
      // A NULL hash (Google-only account) still verifies against the dummy
      // hash for constant-time behavior, but must NEVER authenticate: the
      // dummy is a real Argon2 hash of a fixed literal, so without the
      // explicit NULL check below, typing that literal would log into any
      // password-less account.
      const passwordHash = user?.password_hash ?? (await DUMMY_PASSWORD_HASH_PROMISE);
      const passwordMatches = await verifyPassword(passwordHash, input.password);
      if (!user || user.password_hash === null || !passwordMatches) {
        throw new RequestValidationError("Invalid email or password");
      }

      const client = await options.db.connect();
      try {
        await client.query("BEGIN");
        await updateLastLoggedIn(client, user.id);
        await client.query("COMMIT");
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      } finally {
        client.release();
      }

      const currentSessionId = normalizeSessionId(input.currentSessionId);
      if (currentSessionId) {
        try {
          await destroyAuthSession(options.redis, currentSessionId);
        } catch {
          // Best-effort fixation cleanup. The fresh session below is the source of truth.
        }
      }

      // The epoch was read together with the password hash. If a concurrent
      // reset committed (and bumped the epoch) between the verify above and
      // this create, the session carries the stale epoch and fails the
      // per-request epoch check — an old-password login cannot outlive a
      // reset even though this code never re-reads the row.
      const session = await createAuthSession(options.redis, {
        userId: user.id,
        ttlSeconds: sessionTtlSeconds,
        sessionEpoch: user.session_epoch,
      });
      return { sessionId: session.sessionId };
    },

    async logout(input) {
      const currentSessionId = normalizeSessionId(input.currentSessionId);
      if (!currentSessionId) {
        return;
      }
      // Best-effort: without this guard a Redis error would propagate to the
      // API handler, causing it to return 500 before the Set-Cookie clear —
      // the browser would keep its cookie for a session Redis never deleted,
      // and the logout would silently undo itself once Redis recovered.
      // Clearing the cookie is the user-visible logout; unlike logoutAll
      // there is no durable revocation behind it, so an undeleted session
      // stays valid server-side until its TTL (unusable while Redis is down,
      // since every request's session lookup needs Redis).
      try {
        await destroyAuthSession(options.redis, currentSessionId);
      } catch (error) {
        console.warn(
          "auth logout session cleanup failed (cookie still cleared; orphaned session expires by TTL):",
          error instanceof Error ? error.message : String(error)
        );
      }
    },

    async forgotPassword(input) {
      const email = normalizeEmail(input.email);
      const client = await options.db.connect();
      let token: ReturnType<typeof generateAuthToken> | null = null;
      try {
        await client.query("BEGIN");
        // Lock the user row like the verification flow does: token issuance
        // relies on this lock to serialize concurrent requests so the
        // void-then-insert in issueUserAuthToken leaves exactly one live token.
        const user = await findActiveUserByEmailForUpdate(client, email);
        if (!user) {
          await client.query("COMMIT");
          return;
        }

        token = generateAuthToken();
        await issueUserAuthToken(client, {
          userId: user.id,
          tokenHash: token.tokenHash,
          purpose: "password_reset",
          expiresAt: new Date(Date.now() + passwordResetTtlSeconds * 1000),
        });
        await client.query("COMMIT");
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      } finally {
        client.release();
      }

      await options.mailer.sendPasswordResetEmail({
        email,
        linkUrl: toPasswordResetLink(publicBaseUrl, token.rawToken),
      });
    },

    async resetPassword(input) {
      if (typeof input.token !== "string" || input.token.trim().length === 0) {
        throw new RequestValidationError("token must be a non-empty string");
      }
      validatePasswordPolicy(input.password);
      const client = await options.db.connect();
      let userIdToInvalidate: string | null = null;

      try {
        await client.query("BEGIN");
        const consumed = await lockUserAndConsumeToken(client, {
          token: input.token,
          purpose: "password_reset",
          invalidMessage: "Password reset token is invalid or expired",
        });

        // Hash only after the token is proven valid: bogus-token requests
        // must not be able to burn Argon2 work. Hashing inside the
        // transaction means a hashing failure rolls back the consumption,
        // so the token is not wasted.
        const passwordHash = await hashPassword(input.password);

        // Bumping session_epoch in the same transaction is the guaranteed
        // revocation: every session created under the old epoch fails the
        // per-request check the moment this commits, regardless of Redis.
        const updated = await client.query(
          `
            UPDATE public.users
            SET password_hash = $2,
                session_epoch = session_epoch + 1,
                updated_at = now()
            WHERE id = $1::uuid
              AND deleted_at IS NULL
          `,
          [consumed.userId, passwordHash]
        );
        if (updated.rowCount !== 1) {
          throw new Error("Failed to update user password");
        }
        // A new credential invalidates links issued under the old one: an
        // email_change link requested by whoever held the old password must
        // not still be able to move the address.
        await voidUserAuthTokens(client, { userId: consumed.userId, purposes: ["email_change"] });

        userIdToInvalidate = consumed.userId;
        await client.query("COMMIT");
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      } finally {
        client.release();
      }

      // Best-effort immediate cleanup after commit: the epoch bump above is
      // what revokes access, so a Redis failure here must not fail a reset
      // that already succeeded (the token is consumed and unrepeatable).
      if (userIdToInvalidate) {
        try {
          await destroyAuthSessionsByUserId(options.redis, { userId: userIdToInvalidate });
        } catch (error) {
          console.warn(
            "auth resetPassword session cleanup failed (epoch bump already revoked access):",
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    },

    async changePassword(input) {
      const userId = normalizeUserId(input.userId);
      if (typeof input.currentPassword !== "string" || input.currentPassword.length === 0) {
        throw new RequestValidationError("currentPassword must be a non-empty string");
      }
      validatePasswordPolicy(input.newPassword);

      const client = await options.db.connect();
      let newSessionEpoch: number;
      try {
        await client.query("BEGIN");
        const user = await findActiveUserByIdForUpdate(client, userId);
        // NULL hash (Google-only account) never matches: Settings points
        // those users at the password-reset flow to add a password first.
        if (!user || user.password_hash === null || !(await verifyPassword(user.password_hash, input.currentPassword))) {
          // Same message for missing user and wrong password, like login.
          throw new RequestValidationError("Current password is incorrect");
        }

        const passwordHash = await hashPassword(input.newPassword);
        // Same-transaction epoch bump: guaranteed revocation of every
        // existing session (see resetPassword). RETURNING feeds the fresh
        // session below so the caller stays logged in under the new epoch.
        const updated = await client.query<{ session_epoch: number }>(
          `
            UPDATE public.users
            SET password_hash = $2,
                session_epoch = session_epoch + 1,
                updated_at = now()
            WHERE id = $1::uuid
              AND deleted_at IS NULL
            RETURNING session_epoch
          `,
          [userId, passwordHash]
        );
        const bumpedEpoch = updated.rows[0]?.session_epoch;
        if (typeof bumpedEpoch !== "number") {
          throw new Error("Failed to update user password");
        }
        newSessionEpoch = bumpedEpoch;
        // Same rule as resetPassword: links issued under the old credential
        // (a reset link, an email-change link) die with it.
        await voidUserAuthTokens(client, { userId, purposes: ["password_reset", "email_change"] });
        await client.query("COMMIT");
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      } finally {
        client.release();
      }

      // Rotate every session (including the caller's) after commit, then hand
      // back a fresh one so the caller stays logged in: any session an
      // attacker may hold dies with the old password. The destroy is
      // best-effort cleanup — the epoch bump already revoked those sessions —
      // but the fresh session must be created, so its failure still throws.
      try {
        await destroyAuthSessionsByUserId(options.redis, { userId });
      } catch (error) {
        console.warn(
          "auth changePassword session cleanup failed (epoch bump already revoked access):",
          error instanceof Error ? error.message : String(error)
        );
      }
      const session = await createAuthSession(options.redis, {
        userId,
        ttlSeconds: sessionTtlSeconds,
        sessionEpoch: newSessionEpoch,
      });
      return { sessionId: session.sessionId };
    },

    async requestEmailChange(input) {
      const userId = normalizeUserId(input.userId);
      const newEmail = normalizeEmail(input.newEmail);
      if (typeof input.password !== "string" || input.password.length === 0) {
        throw new RequestValidationError("password must be a non-empty string");
      }

      const client = await options.db.connect();
      let token: ReturnType<typeof generateAuthToken> | null = null;
      try {
        await client.query("BEGIN");
        // FOR UPDATE lock serializes token issuance per user (see
        // issueUserAuthToken's void-then-insert invariant).
        const user = await findActiveUserByIdForUpdate(client, userId);
        // NULL hash (Google-only account) never matches — add a password first.
        if (!user || user.password_hash === null || !(await verifyPassword(user.password_hash, input.password))) {
          throw new RequestValidationError("Password is incorrect");
        }
        if (user.email.toLowerCase() === newEmail.toLowerCase()) {
          throw new RequestValidationError("New email must be different from the current email");
        }

        // Void outstanding change links up front, not only inside
        // issueUserAuthToken: the newest request must kill older links even
        // when it ends on the silent taken-address path below. Otherwise a
        // user recovering from a typoed address (whose link sits in a
        // stranger's inbox) would believe the retry disarmed it when the
        // retry hit a taken address.
        await client.query(
          `
            UPDATE public.user_auth_tokens
            SET consumed_at = clock_timestamp()
            WHERE user_id = $1::uuid
              AND purpose = 'email_change'
              AND consumed_at IS NULL
          `,
          [userId]
        );

        const taken = await client.query(
          `
            SELECT 1
            FROM public.users
            WHERE email = $1::citext
              AND deleted_at IS NULL
          `,
          [newEmail]
        );
        if ((taken.rowCount ?? 0) > 0) {
          // Do not reveal that the address belongs to another account: report
          // success and send nothing, mirroring forgot-password's
          // no-enumeration behavior.
          await client.query("COMMIT");
          return;
        }

        token = generateAuthToken();
        await issueUserAuthToken(client, {
          userId,
          tokenHash: token.tokenHash,
          purpose: "email_change",
          newEmail,
          expiresAt: new Date(Date.now() + emailChangeTtlSeconds * 1000),
        });
        await client.query("COMMIT");
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      } finally {
        client.release();
      }

      // Mail the NEW address: consuming the link proves control of it.
      await options.mailer.sendEmailChangeEmail({
        email: newEmail,
        linkUrl: toEmailChangeLink(publicBaseUrl, token.rawToken),
      });
    },

    async verifyEmailChange(input) {
      if (typeof input.token !== "string" || input.token.trim().length === 0) {
        throw new RequestValidationError("token must be a non-empty string");
      }

      let changedUserId: string | null = null;
      const client = await options.db.connect();
      try {
        await client.query("BEGIN");
        const consumed = await lockUserAndConsumeToken(client, {
          token: input.token,
          purpose: "email_change",
          invalidMessage: "Email change token is invalid or expired",
        });
        if (!consumed.newEmail) {
          throw new RequestValidationError("Email change token is invalid or expired");
        }

        // The link landed in the new inbox, so the new address is verified.
        const updated = await client.query(
          `
            UPDATE public.users
            SET email = $2::citext,
                email_verified = true,
                updated_at = now()
            WHERE id = $1::uuid
              AND deleted_at IS NULL
          `,
          [consumed.userId, consumed.newEmail]
        );
        if (updated.rowCount !== 1) {
          throw new Error("Failed to update user email");
        }
        // Links mailed to the OLD address (verify, reset) must not stay
        // actionable from a mailbox the account no longer uses.
        await voidUserAuthTokens(client, {
          userId: consumed.userId,
          purposes: ["email_verify", "password_reset"],
        });

        await client.query("COMMIT");
        changedUserId = consumed.userId;
      } catch (error) {
        await rollbackQuietly(client);
        // Another account claimed the address between request and confirm.
        if ((error as { code?: string }).code === "23505") {
          throw new RequestValidationError("Email change token is invalid or expired");
        }
        throw error;
      } finally {
        client.release();
      }

      // Best-effort: Stripe keeps prefilling Checkout with, and sending
      // receipts to, the customer object's stored email — track the change.
      // A Stripe failure must not fail an email change that already
      // committed; checkout/portal keep working and the operator can fix the
      // address in the dashboard.
      if (options.syncMembershipCustomerEmail && changedUserId) {
        try {
          await options.syncMembershipCustomerEmail(changedUserId);
        } catch (error) {
          console.warn(
            "membership customer email sync failed after email change (Stripe keeps the old address until fixed):",
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    },

    async deleteAccount(input) {
      const userId = normalizeUserId(input.userId);
      // Re-authentication, checked against the locked user row: the account
      // password, or a Google ID token whose subject is the Google account
      // linked to this user. The token is verified once, here, so no network
      // call runs while the row is locked.
      let isConfirmedBy: (user: GoogleAuthUserRow | null) => Promise<boolean>;
      let rejectionMessage: string;
      if (input.googleCredential !== undefined) {
        if (input.password !== undefined) {
          throw new RequestValidationError("Provide either password or googleCredential, not both");
        }
        if (typeof input.googleCredential !== "string" || input.googleCredential.trim().length === 0) {
          throw new RequestValidationError("googleCredential must be a non-empty string");
        }
        if (!options.verifyGoogleIdToken) {
          throw new RequestValidationError("Google sign-in is not configured");
        }
        let googleSub = "";
        try {
          const payload = await options.verifyGoogleIdToken(input.googleCredential);
          googleSub = typeof payload.sub === "string" ? payload.sub.trim() : "";
        } catch {
          // Same generic 400 as loginWithGoogle for every library error.
        }
        if (googleSub.length === 0) {
          throw new RequestValidationError("Google sign-in failed: invalid credential");
        }
        isConfirmedBy = async (user) => user !== null && user.google_sub === googleSub;
        rejectionMessage = "That Google account is not the one linked to this account";
      } else {
        const password = input.password;
        if (typeof password !== "string" || password.length === 0) {
          throw new RequestValidationError("password must be a non-empty string");
        }
        // NULL hash (Google-only account) never matches — those confirm with Google.
        isConfirmedBy = async (user) =>
          user !== null && user.password_hash !== null && (await verifyPassword(user.password_hash, password));
        rejectionMessage = "Password is incorrect";
      }

      // Membership cancellation is a precondition (Terms §14.3: deleting the
      // account cancels the membership) with its own confirmation check
      // first: an unconfirmed request must not be able to cancel a paid
      // membership, and the Stripe network call must not run inside the
      // delete transaction below, where it would hold the user row lock for
      // up to a Stripe timeout. The delete transaction re-checks the
      // confirmation; if the password or Google link changed in between, the
      // delete fails and all that happened is a cancel the
      // (then-)authenticated request asked for.
      let membershipWasCanceled = false;
      if (options.cancelMembershipForAccountDeletion) {
        const precheckClient = await options.db.connect();
        try {
          await precheckClient.query("BEGIN");
          const user = await findActiveUserByIdForUpdate(precheckClient, userId);
          if (!(await isConfirmedBy(user))) {
            throw new RequestValidationError(rejectionMessage);
          }
          // Pure check — release the row lock before any network call.
          await precheckClient.query("ROLLBACK");
        } catch (error) {
          await rollbackQuietly(precheckClient);
          throw error;
        } finally {
          precheckClient.release();
        }
        // Throws a retryable error when Stripe is unreachable; the delete
        // request then fails with nothing deleted.
        membershipWasCanceled = (await options.cancelMembershipForAccountDeletion(userId)) === true;
      }

      const client = await options.db.connect();
      try {
        await client.query("BEGIN");
        const user = await findActiveUserByIdForUpdate(client, userId);
        if (!(await isConfirmedBy(user))) {
          throw new RequestValidationError(rejectionMessage);
        }

        // Two tables outlive the user row and need explicit scrubbing before
        // it goes (afterwards the linking rows are gone or nulled):
        // content_reports survives with user_id set NULL for moderation, but
        // the web form pre-fills reporter_email with the account email, so
        // clear it; and user_push_notification_receipts stores the device's
        // expo_push_token with no FK, so pending receipt rows would keep the
        // token up to the prune window. Dropping them only skips a receipt
        // check whose sole effect — revoking a dead token — is moot once the
        // token rows cascade away.
        await client.query(
          `
            UPDATE public.content_reports
            SET reporter_email = NULL
            WHERE user_id = $1::uuid
              AND reporter_email IS NOT NULL
          `,
          [userId]
        );
        await client.query(
          `
            DELETE FROM public.user_push_notification_receipts
            WHERE expo_push_token IN (
              SELECT expo_push_token
              FROM public.user_push_tokens
              WHERE user_id = $1::uuid
            )
          `,
          [userId]
        );

        // Hard delete. The UI and privacy policy promise permanent removal
        // of the account, districts, follows, and preferences, so the row
        // goes away for real: every user-owned table (districts, follows,
        // preferences, auth tokens, push tokens, notification history)
        // references users(id) ON DELETE CASCADE — which also voids any
        // outstanding reset/verify links — and content_reports keeps its
        // reports with user_id set NULL. The partial unique index on
        // users(email) already released the address for re-signup; with the
        // row gone that stays true.
        await client.query(
          `
            DELETE FROM public.users
            WHERE id = $1::uuid
          `,
          [userId]
        );
        await client.query("COMMIT");
      } catch (error) {
        await rollbackQuietly(client);
        // The Stripe cancellation already committed but the account survives
        // (DB failure, or the password or Google link changed between
        // precheck and the re-check above). Retrying the delete self-heals — re-cancel
        // is a no-op — but if the user never retries, their membership is
        // silently gone; this line is the operator's signal to reinstate or
        // reach out.
        if (membershipWasCanceled) {
          console.error(
            `auth deleteAccount failed AFTER the membership was canceled at Stripe for user ${userId}; the account survives without its membership — reinstate manually if the user does not retry:`,
            error instanceof Error ? error.message : String(error)
          );
        }
        throw error;
      } finally {
        client.release();
      }

      // Best-effort: a deleted user already fails the per-request epoch
      // lookup (the row is gone), so a Redis failure here must not surface
      // an error for an account that is already gone.
      try {
        await destroyAuthSessionsByUserId(options.redis, { userId });
      } catch (error) {
        console.warn(
          "auth deleteAccount session cleanup failed (deleted user already fails per-request auth):",
          error instanceof Error ? error.message : String(error)
        );
      }
    },

    async logoutAll(input) {
      const userId = normalizeUserId(input.userId);
      // Epoch bump and push-token revocation in ONE transaction: revocation
      // must not depend on Redis, and the two durable halves must land
      // together. Sessions are not the only channel that reaches a device —
      // push notifications carry personalized content too — and once the
      // epoch bump commits the caller's own session is dead, so a failed
      // second statement could not be retried by the same session; the
      // signed-out device would keep receiving pushes. The caller's session
      // dying is intended: logout-all means everywhere, and the API clears
      // the cookie in the same response. Re-login re-registers the token.
      const client = await options.db.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `
            UPDATE public.users
            SET session_epoch = session_epoch + 1,
                updated_at = now()
            WHERE id = $1::uuid
              AND deleted_at IS NULL
          `,
          [userId]
        );
        await revokeAllUserPushTokens(client, userId);
        await client.query("COMMIT");
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      } finally {
        client.release();
      }
      // Best-effort, like the other credential flows: the bump above already
      // revoked every session, so a Redis failure must not fail a logout-all
      // that succeeded from a security standpoint.
      try {
        await destroyAuthSessionsByUserId(options.redis, { userId });
      } catch (error) {
        console.warn(
          "auth logoutAll session cleanup failed (epoch bump already revoked access):",
          error instanceof Error ? error.message : String(error)
        );
      }
    },
  };
}
