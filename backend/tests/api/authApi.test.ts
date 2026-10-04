import { type IncomingMessage, ServerResponse } from "node:http";
import { Readable, Writable } from "node:stream";
import type { Express } from "express";
import { describe, expect, it, vi } from "vitest";

import { createApiApp } from "../../src/api/apiServer.js";
import { AUTH_SESSION_COOKIE_NAME } from "../../src/auth/authCookies.js";
import { CURRENT_TERMS_VERSION } from "../../src/constants/legal.js";
import type { AuthService } from "../../src/auth/authService.js";

async function invokeExpressApp(
  app: Express,
  input: {
    method: string;
    path: string;
    body?: string;
    headers?: Record<string, string>;
    remoteAddress?: string;
  }
): Promise<{ statusCode: number; headers: Record<string, string>; body: unknown; rawBody: string }> {
  const requestBody = input.body ?? "";
  const headers = {
    ...(input.headers ?? {}),
    ...(requestBody.length > 0 && !input.headers?.["content-length"]
      ? { "content-length": Buffer.byteLength(requestBody).toString() }
      : {}),
  };
  const request = Readable.from(requestBody.length > 0 ? [requestBody] : []) as IncomingMessage;
  Object.assign(request, {
    method: input.method,
    url: input.path,
    headers,
    socket: {
      remoteAddress: input.remoteAddress ?? "127.0.0.1",
    },
  });

  const response = new ServerResponse(request);
  const responseChunks: Buffer[] = [];
  const socket = new Writable({
    write(chunk, _encoding, callback) {
      responseChunks.push(Buffer.from(chunk));
      callback();
    },
  });
  response.assignSocket(socket as never);

  return await new Promise((resolve, reject) => {
    response.on("finish", () => {
      const rawResponse = Buffer.concat(responseChunks).toString("utf8");
      const [, rawBody = ""] = rawResponse.split("\r\n\r\n");
      const body =
        rawBody.length > 0 && String(response.getHeader("content-type") ?? "").includes("application/json")
          ? JSON.parse(rawBody)
          : rawBody;
      const headers = Object.fromEntries(
        Object.entries(response.getHeaders()).map(([key, value]) => [key, String(value)])
      );
      resolve({
        statusCode: response.statusCode,
        headers,
        body,
        rawBody,
      });
    });
    response.on("error", reject);
    app(request, response);
  });
}

function createAuthServiceMock(overrides: Partial<AuthService> = {}): AuthService {
  return {
    register: vi.fn().mockResolvedValue(undefined),
    verifyEmail: vi.fn().mockResolvedValue(undefined),
    login: vi.fn().mockResolvedValue({ sessionId: "session-abc" }),
    logout: vi.fn().mockResolvedValue(undefined),
    forgotPassword: vi.fn().mockResolvedValue(undefined),
    resendVerification: vi.fn().mockResolvedValue(undefined),
    resetPassword: vi.fn().mockResolvedValue(undefined),
    changePassword: vi.fn().mockResolvedValue({ sessionId: "session-rotated" }),
    requestEmailChange: vi.fn().mockResolvedValue(undefined),
    verifyEmailChange: vi.fn().mockResolvedValue(undefined),
    deleteAccount: vi.fn().mockResolvedValue(undefined),
    logoutAll: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const SESSION_USER_ID = "99999999-9999-4999-8999-999999999999";

describe("public auth API endpoints", () => {
  it("registers users through the auth service", async () => {
    const resolveAddress = vi.fn();
    const authService = createAuthServiceMock();

    const response = await invokeExpressApp(createApiApp({ resolveAddress, authService }), {
      method: "POST",
      path: "/api/auth/register",
      body: JSON.stringify({
        email: "user@example.com",
        password: "correct horse battery staple",
        first_name: "Alice",
        accepted_terms_version: CURRENT_TERMS_VERSION,
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(authService.register).toHaveBeenCalledWith({
      email: "user@example.com",
      password: "correct horse battery staple",
      firstName: "Alice",
      acceptedTermsVersion: CURRENT_TERMS_VERSION,
    });
  });

  it("rejects registration without terms acceptance or with a stale version", async () => {
    const resolveAddress = vi.fn();
    const authService = createAuthServiceMock();
    const app = createApiApp({ resolveAddress, authService });

    const missing = await invokeExpressApp(app, {
      method: "POST",
      path: "/api/auth/register",
      body: JSON.stringify({ email: "user@example.com", password: "correct horse battery staple" }),
      headers: { "content-type": "application/json" },
    });
    expect(missing.statusCode).toBe(400);

    const stale = await invokeExpressApp(app, {
      method: "POST",
      path: "/api/auth/register",
      body: JSON.stringify({
        email: "user@example.com",
        password: "correct horse battery staple",
        accepted_terms_version: "0.9",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(stale.statusCode).toBe(400);
    expect(String((stale.body as { error: { message: string } }).error.message)).toContain(
      CURRENT_TERMS_VERSION
    );
    expect(authService.register).not.toHaveBeenCalled();
  });

  it("verifies emails through the auth service", async () => {
    const resolveAddress = vi.fn();
    const authService = createAuthServiceMock();

    const response = await invokeExpressApp(createApiApp({ resolveAddress, authService }), {
      method: "POST",
      path: "/api/auth/verify-email",
      body: JSON.stringify({ token: "verify-token" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(authService.verifyEmail).toHaveBeenCalledWith({ token: "verify-token" });
  });

  it("logs users in and sets the auth session cookie", async () => {
    const resolveAddress = vi.fn();
    const authService = createAuthServiceMock({
      login: vi.fn().mockResolvedValue({ sessionId: "session-abc" }),
    });

    const response = await invokeExpressApp(createApiApp({ resolveAddress, authService }), {
      method: "POST",
      path: "/api/auth/login",
      body: JSON.stringify({ email: "user@example.com", password: "correct horse battery staple" }),
      headers: { "content-type": "application/json", cookie: `${AUTH_SESSION_COOKIE_NAME}=old-session` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(authService.login).toHaveBeenCalledWith({
      email: "user@example.com",
      password: "correct horse battery staple",
      currentSessionId: "old-session",
    });
    expect(response.headers["set-cookie"]).toContain(`${AUTH_SESSION_COOKIE_NAME}=session-abc`);
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
  });

  it("returns the session id in the body only for mobile-client logins", async () => {
    const resolveAddress = vi.fn();
    const authService = createAuthServiceMock({
      login: vi.fn().mockResolvedValue({ sessionId: "session-abc" }),
    });
    const app = createApiApp({ resolveAddress, authService });
    const loginInput = {
      method: "POST",
      path: "/api/auth/login",
      body: JSON.stringify({ email: "user@example.com", password: "correct horse battery staple" }),
    };

    const mobile = await invokeExpressApp(app, {
      ...loginInput,
      headers: { "content-type": "application/json", "x-voteapp-client": "mobile" },
    });
    expect(mobile.statusCode).toBe(200);
    expect(mobile.body).toEqual({ status: "ok", session_id: "session-abc" });
    // No Set-Cookie for mobile: a native cookie jar copy of the session
    // would later be replayed alongside the Bearer header and diverge.
    expect(mobile.headers["set-cookie"]).toBeUndefined();

    const web = await invokeExpressApp(app, {
      ...loginInput,
      headers: { "content-type": "application/json" },
    });
    expect(web.body).toEqual({ status: "ok" });
    expect(web.headers["set-cookie"]).toContain(`${AUTH_SESSION_COOKIE_NAME}=session-abc`);

    const otherClient = await invokeExpressApp(app, {
      ...loginInput,
      headers: { "content-type": "application/json", "x-voteapp-client": "kiosk" },
    });
    expect(otherClient.body).toEqual({ status: "ok" });
  });

  it("refuses the mobile session transport for requests with browser provenance", async () => {
    // Browser JS can spoof x-voteapp-client, but it cannot remove the
    // forbidden Origin/Sec-Fetch-* headers the browser attaches. An XSS
    // wrapping the user's own login must never receive the session id.
    const resolveAddress = vi.fn();
    const authService = createAuthServiceMock({
      login: vi.fn().mockResolvedValue({ sessionId: "session-abc" }),
    });
    const app = createApiApp({ resolveAddress, authService });
    const loginInput = {
      method: "POST",
      path: "/api/auth/login",
      body: JSON.stringify({ email: "user@example.com", password: "correct horse battery staple" }),
    };

    const withSecFetch = await invokeExpressApp(app, {
      ...loginInput,
      headers: {
        "content-type": "application/json",
        "x-voteapp-client": "mobile",
        "sec-fetch-site": "same-origin",
      },
    });
    expect(withSecFetch.statusCode).toBe(200);
    expect(withSecFetch.body).toEqual({ status: "ok" });
    expect(withSecFetch.headers["set-cookie"]).toContain(`${AUTH_SESSION_COOKIE_NAME}=session-abc`);

    // Origin-bearing requests only pass CORS when the origin is allowed;
    // even then the body must stay cookie-only.
    const origin = "https://frontend.example";
    const originApp = createApiApp({ resolveAddress, authService, allowedOrigins: [origin] });
    const withOrigin = await invokeExpressApp(originApp, {
      ...loginInput,
      headers: { "content-type": "application/json", "x-voteapp-client": "mobile", origin },
    });
    expect(withOrigin.statusCode).toBe(200);
    expect(withOrigin.body).toEqual({ status: "ok" });
    expect(withOrigin.headers["set-cookie"]).toContain(`${AUTH_SESSION_COOKIE_NAME}=session-abc`);
  });

  it("accepts the current session as a Bearer header on login (mobile re-login)", async () => {
    const resolveAddress = vi.fn();
    const authService = createAuthServiceMock({
      login: vi.fn().mockResolvedValue({ sessionId: "session-new" }),
    });

    await invokeExpressApp(createApiApp({ resolveAddress, authService }), {
      method: "POST",
      path: "/api/auth/login",
      body: JSON.stringify({ email: "user@example.com", password: "correct horse battery staple" }),
      headers: { "content-type": "application/json", authorization: "Bearer old-session" },
    });

    expect(authService.login).toHaveBeenCalledWith({
      email: "user@example.com",
      password: "correct horse battery staple",
      currentSessionId: "old-session",
    });
  });

  it("supports cross-origin cookie auth when an explicit origin is allowed", async () => {
    const resolveAddress = vi.fn();
    const authService = createAuthServiceMock({
      login: vi.fn().mockResolvedValue({ sessionId: "session-abc" }),
    });
    const origin = "https://frontend.example";

    const response = await invokeExpressApp(
      createApiApp({
        resolveAddress,
        authService,
        allowedOrigins: [origin],
        authSessionCookieOptions: { sameSite: "none", secure: true },
      }),
      {
        method: "POST",
        path: "/api/auth/login",
        body: JSON.stringify({ email: "user@example.com", password: "correct horse battery staple" }),
        headers: { "content-type": "application/json", origin },
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
    });
    expect(response.headers["set-cookie"]).toContain("SameSite=None");
    expect(response.headers["set-cookie"]).toContain("Secure");
  });

  it("logs users out and clears the auth session cookie", async () => {
    const resolveAddress = vi.fn();
    const authService = createAuthServiceMock();

    const response = await invokeExpressApp(createApiApp({ resolveAddress, authService }), {
      method: "POST",
      path: "/api/auth/logout",
      headers: {
        cookie: `${AUTH_SESSION_COOKIE_NAME}=old-session`,
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(authService.logout).toHaveBeenCalledWith({
      currentSessionId: "old-session",
    });
    expect(response.headers["set-cookie"]).toContain(`${AUTH_SESSION_COOKIE_NAME}=;`);
    expect(response.headers["set-cookie"]).toContain("Max-Age=0");
  });

  it("logs out a Bearer-authenticated session (mobile logout)", async () => {
    const resolveAddress = vi.fn();
    const authService = createAuthServiceMock();

    const response = await invokeExpressApp(createApiApp({ resolveAddress, authService }), {
      method: "POST",
      path: "/api/auth/logout",
      headers: {
        authorization: "Bearer mobile-session",
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(response.statusCode).toBe(200);
    expect(authService.logout).toHaveBeenCalledWith({
      currentSessionId: "mobile-session",
    });
  });

  it("rejects logout without a JSON content type so cross-site form POSTs cannot log users out", async () => {
    const resolveAddress = vi.fn();
    const authService = createAuthServiceMock();

    const response = await invokeExpressApp(createApiApp({ resolveAddress, authService }), {
      method: "POST",
      path: "/api/auth/logout",
      headers: {
        cookie: `${AUTH_SESSION_COOKIE_NAME}=old-session`,
        "content-type": "application/x-www-form-urlencoded",
      },
    });

    expect(response.statusCode).toBe(415);
    expect(authService.logout).not.toHaveBeenCalled();
  });

  it("forgets passwords through the auth service", async () => {
    const resolveAddress = vi.fn();
    const authService = createAuthServiceMock();

    const response = await invokeExpressApp(createApiApp({ resolveAddress, authService }), {
      method: "POST",
      path: "/api/auth/forgot-password",
      body: JSON.stringify({ email: "user@example.com" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(authService.forgotPassword).toHaveBeenCalledWith({ email: "user@example.com" });
  });

  it("resends verification emails through the auth service", async () => {
    const resolveAddress = vi.fn();
    const authService = createAuthServiceMock();

    const response = await invokeExpressApp(createApiApp({ resolveAddress, authService }), {
      method: "POST",
      path: "/api/auth/resend-verification",
      body: JSON.stringify({ email: "user@example.com" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(authService.resendVerification).toHaveBeenCalledWith({ email: "user@example.com" });
  });

  it("resets passwords through the auth service", async () => {
    const resolveAddress = vi.fn();
    const authService = createAuthServiceMock();

    const response = await invokeExpressApp(createApiApp({ resolveAddress, authService }), {
      method: "POST",
      path: "/api/auth/reset-password",
      body: JSON.stringify({ token: "reset-token", password: "new password 123" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(authService.resetPassword).toHaveBeenCalledWith({
      token: "reset-token",
      password: "new password 123",
    });
  });

  it("returns 500 when auth is not configured", async () => {
    const resolveAddress = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress }), {
      method: "POST",
      path: "/api/auth/register",
      body: JSON.stringify({ email: "user@example.com", password: "correct horse battery staple" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: "internal_error",
        message: "Authentication is not configured",
      },
    });
  });

  it("rate limits register requests using the auth limiter", async () => {
    const resolveAddress = vi.fn();
    const authService = createAuthServiceMock();
    const authRateLimit = vi.fn().mockReturnValue({ allowed: false, retryAfterSeconds: 17 });

    const response = await invokeExpressApp(createApiApp({ resolveAddress, authService, authRateLimit }), {
      method: "POST",
      path: "/api/auth/register",
      body: JSON.stringify({
        email: "user@example.com",
        password: "correct horse battery staple",
        accepted_terms_version: CURRENT_TERMS_VERSION,
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("17");
    expect(response.body).toEqual({
      error: {
        code: "rate_limited",
        message: "Too many requests. Try again later.",
      },
    });
    expect(authRateLimit).toHaveBeenCalledWith({
      clientIp: expect.any(String),
      email: "user@example.com",
      method: "POST",
      pathname: "/api/auth/register",
    });
    expect(authService.register).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/google", () => {
  function googleBody(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      credential: "google-id-token",
      intent: "login",
      ...overrides,
    });
  }

  it("rejects non-POST methods", async () => {
    const authService = createAuthServiceMock({ loginWithGoogle: vi.fn() });
    const response = await invokeExpressApp(createApiApp({ resolveAddress: vi.fn(), authService }), {
      method: "GET",
      path: "/api/auth/google",
    });
    expect(response.statusCode).toBe(405);
  });

  it("returns 500 not-configured when the service has no loginWithGoogle", async () => {
    const response = await invokeExpressApp(
      createApiApp({ resolveAddress: vi.fn(), authService: createAuthServiceMock() }),
      {
        method: "POST",
        path: "/api/auth/google",
        body: googleBody(),
        headers: { "content-type": "application/json" },
      }
    );
    expect(response.statusCode).toBe(500);
    expect((response.body as { error: { message: string } }).error.message).toBe(
      "Google sign-in is not configured"
    );
  });

  it("requires the JSON content type (CSRF guard)", async () => {
    const authService = createAuthServiceMock({ loginWithGoogle: vi.fn() });
    const response = await invokeExpressApp(createApiApp({ resolveAddress: vi.fn(), authService }), {
      method: "POST",
      path: "/api/auth/google",
      body: "credential=x&intent=login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(response.statusCode).toBe(415);
    expect(authService.loginWithGoogle).not.toHaveBeenCalled();
  });

  it("rejects an unknown intent", async () => {
    const authService = createAuthServiceMock({ loginWithGoogle: vi.fn() });
    const response = await invokeExpressApp(createApiApp({ resolveAddress: vi.fn(), authService }), {
      method: "POST",
      path: "/api/auth/google",
      body: googleBody({ intent: "link" }),
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(400);
    expect(authService.loginWithGoogle).not.toHaveBeenCalled();
  });

  it("rejects signup with a stale or missing terms version before calling the service", async () => {
    const authService = createAuthServiceMock({ loginWithGoogle: vi.fn() });
    const app = createApiApp({ resolveAddress: vi.fn(), authService });

    for (const body of [
      googleBody({ intent: "signup" }),
      googleBody({ intent: "signup", accepted_terms_version: "0.9" }),
    ]) {
      const response = await invokeExpressApp(app, {
        method: "POST",
        path: "/api/auth/google",
        body,
        headers: { "content-type": "application/json" },
      });
      expect(response.statusCode).toBe(400);
      expect(String((response.body as { error: { message: string } }).error.message)).toContain(
        CURRENT_TERMS_VERSION
      );
    }
    expect(authService.loginWithGoogle).not.toHaveBeenCalled();
  });

  it("logs in on the web transport with a session cookie only", async () => {
    const loginWithGoogle = vi.fn().mockResolvedValue({ sessionId: "session-google" });
    const authService = createAuthServiceMock({ loginWithGoogle });

    const response = await invokeExpressApp(createApiApp({ resolveAddress: vi.fn(), authService }), {
      method: "POST",
      path: "/api/auth/google",
      body: googleBody(),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(response.headers["set-cookie"]).toContain(`${AUTH_SESSION_COOKIE_NAME}=session-google`);
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(loginWithGoogle).toHaveBeenCalledWith({
      idToken: "google-id-token",
      intent: "login",
      currentSessionId: null,
    });
  });

  it("passes the signup intent and terms version through", async () => {
    const loginWithGoogle = vi.fn().mockResolvedValue({ sessionId: "session-google" });
    const authService = createAuthServiceMock({ loginWithGoogle });

    const response = await invokeExpressApp(createApiApp({ resolveAddress: vi.fn(), authService }), {
      method: "POST",
      path: "/api/auth/google",
      body: googleBody({ intent: "signup", accepted_terms_version: CURRENT_TERMS_VERSION }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    expect(loginWithGoogle).toHaveBeenCalledWith({
      idToken: "google-id-token",
      intent: "signup",
      acceptedTermsVersion: CURRENT_TERMS_VERSION,
      currentSessionId: null,
    });
  });

  it("returns the session id in the body for the mobile transport", async () => {
    const loginWithGoogle = vi.fn().mockResolvedValue({ sessionId: "session-google" });
    const authService = createAuthServiceMock({ loginWithGoogle });

    const response = await invokeExpressApp(createApiApp({ resolveAddress: vi.fn(), authService }), {
      method: "POST",
      path: "/api/auth/google",
      body: googleBody(),
      headers: { "content-type": "application/json", "x-voteapp-client": "mobile" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ status: "ok", session_id: "session-google" });
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("maps the needs_signup service error to its distinct code", async () => {
    const { AuthGoogleSignInError } = await import("../../src/auth/authService.js");
    const loginWithGoogle = vi
      .fn()
      .mockRejectedValue(new AuthGoogleSignInError("needs_signup", "No account uses this Google account yet."));
    const authService = createAuthServiceMock({ loginWithGoogle });

    const response = await invokeExpressApp(createApiApp({ resolveAddress: vi.fn(), authService }), {
      method: "POST",
      path: "/api/auth/google",
      body: googleBody(),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(400);
    expect((response.body as { error: { code: string } }).error.code).toBe("needs_signup");
  });

  it("rate limits per client IP through the shared auth limiter", async () => {
    const loginWithGoogle = vi.fn();
    const authService = createAuthServiceMock({ loginWithGoogle });
    const authRateLimit = vi.fn().mockReturnValue({ allowed: false, retryAfterSeconds: 9 });

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress: vi.fn(), authService, authRateLimit }),
      {
        method: "POST",
        path: "/api/auth/google",
        body: googleBody(),
        headers: { "content-type": "application/json" },
      }
    );

    expect(response.statusCode).toBe(429);
    expect(authRateLimit).toHaveBeenCalledWith({
      clientIp: expect.any(String),
      // No password to brute-force behind this endpoint: null skips the
      // (stricter) per-identity bucket so only the per-IP quota governs.
      email: null,
      method: "POST",
      pathname: "/api/auth/google",
    });
    expect(loginWithGoogle).not.toHaveBeenCalled();
  });
});

describe("account management endpoints", () => {
  it("changes the password and sets the rotated session cookie", async () => {
    const authService = createAuthServiceMock();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(SESSION_USER_ID);

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress: vi.fn(), authService, resolveAuthenticatedUserId }),
      {
        method: "POST",
        path: "/api/me/password",
        body: JSON.stringify({ current_password: "old-password-123", new_password: "new-password-456" }),
        headers: { "content-type": "application/json", "x-user-id": SESSION_USER_ID },
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(authService.changePassword).toHaveBeenCalledWith({
      userId: SESSION_USER_ID,
      currentPassword: "old-password-123",
      newPassword: "new-password-456",
    });
    expect(response.headers["set-cookie"]).toContain(`${AUTH_SESSION_COOKIE_NAME}=session-rotated`);
  });

  it("returns the rotated session id in the body for mobile-client password changes", async () => {
    const authService = createAuthServiceMock();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(SESSION_USER_ID);

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress: vi.fn(), authService, resolveAuthenticatedUserId }),
      {
        method: "POST",
        path: "/api/me/password",
        body: JSON.stringify({ current_password: "old-password-123", new_password: "new-password-456" }),
        headers: {
          "content-type": "application/json",
          authorization: "Bearer mobile-session",
          "x-voteapp-client": "mobile",
        },
      }
    );

    // The rotation just revoked the caller's Bearer session; without the new
    // id in the body the mobile client would be logged out by its own change.
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ status: "ok", session_id: "session-rotated" });
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("requires a session for password change", async () => {
    const authService = createAuthServiceMock();

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress: vi.fn(), authService, resolveAuthenticatedUserId: () => null }),
      {
        method: "POST",
        path: "/api/me/password",
        body: JSON.stringify({ current_password: "a", new_password: "b" }),
        headers: { "content-type": "application/json" },
      }
    );

    expect(response.statusCode).toBe(401);
    expect(authService.changePassword).not.toHaveBeenCalled();
  });

  it("rejects password change without a JSON content type (CSRF guard)", async () => {
    const authService = createAuthServiceMock();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(SESSION_USER_ID);

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress: vi.fn(), authService, resolveAuthenticatedUserId }),
      {
        method: "POST",
        path: "/api/me/password",
        body: "current_password=a&new_password=b",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-user-id": SESSION_USER_ID },
      }
    );

    expect(response.statusCode).toBe(415);
    expect(authService.changePassword).not.toHaveBeenCalled();
  });

  it("requests an email change through the auth service", async () => {
    const authService = createAuthServiceMock();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(SESSION_USER_ID);

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress: vi.fn(), authService, resolveAuthenticatedUserId }),
      {
        method: "POST",
        path: "/api/me/email",
        body: JSON.stringify({ new_email: "new@example.com", password: "password-123" }),
        headers: { "content-type": "application/json", "x-user-id": SESSION_USER_ID },
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(authService.requestEmailChange).toHaveBeenCalledWith({
      userId: SESSION_USER_ID,
      newEmail: "new@example.com",
      password: "password-123",
    });
  });

  it("verifies an email change without a session", async () => {
    const authService = createAuthServiceMock();

    const response = await invokeExpressApp(createApiApp({ resolveAddress: vi.fn(), authService }), {
      method: "POST",
      path: "/api/auth/verify-email-change",
      body: JSON.stringify({ token: "change-token" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    expect(authService.verifyEmailChange).toHaveBeenCalledWith({ token: "change-token" });
  });

  it("updates first_name via PUT /api/me", async () => {
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(SESSION_USER_ID);
    const identity = { email: "user@example.com", first_name: "Nova", email_verified: true, has_password: true };
    const updateAuthenticatedUserFirstName = vi.fn().mockResolvedValue(identity);

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress: vi.fn(), resolveAuthenticatedUserId, updateAuthenticatedUserFirstName }),
      {
        method: "PUT",
        path: "/api/me",
        body: JSON.stringify({ first_name: "Nova" }),
        headers: { "content-type": "application/json", "x-user-id": SESSION_USER_ID },
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ user: identity });
    expect(updateAuthenticatedUserFirstName).toHaveBeenCalledWith(SESSION_USER_ID, "Nova");
  });

  it("deletes the account and clears the session cookie", async () => {
    const authService = createAuthServiceMock();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(SESSION_USER_ID);

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress: vi.fn(), authService, resolveAuthenticatedUserId }),
      {
        method: "DELETE",
        path: "/api/me",
        body: JSON.stringify({ password: "password-123" }),
        headers: { "content-type": "application/json", "x-user-id": SESSION_USER_ID },
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(authService.deleteAccount).toHaveBeenCalledWith({
      userId: SESSION_USER_ID,
      password: "password-123",
    });
    expect(response.headers["set-cookie"]).toContain(`${AUTH_SESSION_COOKIE_NAME}=;`);
  });

  it("deletes the account on a Google confirmation", async () => {
    const authService = createAuthServiceMock();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(SESSION_USER_ID);

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress: vi.fn(), authService, resolveAuthenticatedUserId }),
      {
        method: "DELETE",
        path: "/api/me",
        body: JSON.stringify({ google_credential: "google-jwt" }),
        headers: { "content-type": "application/json", "x-user-id": SESSION_USER_ID },
      }
    );

    expect(response.statusCode).toBe(200);
    expect(authService.deleteAccount).toHaveBeenCalledWith({
      userId: SESSION_USER_ID,
      googleCredential: "google-jwt",
    });
  });

  it("refuses an account delete that carries both confirmations", async () => {
    const authService = createAuthServiceMock();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(SESSION_USER_ID);

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress: vi.fn(), authService, resolveAuthenticatedUserId }),
      {
        method: "DELETE",
        path: "/api/me",
        body: JSON.stringify({ password: "password-123", google_credential: "google-jwt" }),
        headers: { "content-type": "application/json", "x-user-id": SESSION_USER_ID },
      }
    );

    expect(response.statusCode).toBe(400);
    expect(authService.deleteAccount).not.toHaveBeenCalled();
  });

  it("logs out everywhere and clears the session cookie", async () => {
    const authService = createAuthServiceMock();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(SESSION_USER_ID);

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress: vi.fn(), authService, resolveAuthenticatedUserId }),
      {
        method: "POST",
        path: "/api/auth/logout-all",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json", "x-user-id": SESSION_USER_ID },
      }
    );

    expect(response.statusCode).toBe(200);
    expect(authService.logoutAll).toHaveBeenCalledWith({ userId: SESSION_USER_ID });
    expect(response.headers["set-cookie"]).toContain(`${AUTH_SESSION_COOKIE_NAME}=;`);
  });

  it("throttles password-verifying endpoints per account via the auth rate limiter", async () => {
    const authService = createAuthServiceMock();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(SESSION_USER_ID);
    const authRateLimit = vi.fn().mockReturnValue({ allowed: false, retryAfterSeconds: 42 });

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress: vi.fn(), authService, resolveAuthenticatedUserId, authRateLimit }),
      {
        method: "POST",
        path: "/api/me/password",
        body: JSON.stringify({ current_password: "guess-1", new_password: "new-password-456" }),
        headers: { "content-type": "application/json", "x-user-id": SESSION_USER_ID },
      }
    );

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("42");
    // Keyed by the session holder's userId, not an email: a hijacked session
    // burns the account's bucket no matter which IP it rotates through.
    expect(authRateLimit).toHaveBeenCalledWith({
      clientIp: expect.any(String),
      email: SESSION_USER_ID,
      method: "POST",
      pathname: "/api/me/password",
    });
    expect(authService.changePassword).not.toHaveBeenCalled();
  });

  it("requires a session for logout-all", async () => {
    const authService = createAuthServiceMock();

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress: vi.fn(), authService, resolveAuthenticatedUserId: () => null }),
      {
        method: "POST",
        path: "/api/auth/logout-all",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      }
    );

    expect(response.statusCode).toBe(401);
    expect(authService.logoutAll).not.toHaveBeenCalled();
  });
});
