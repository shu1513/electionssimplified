import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { MetaFunction } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { APP_NAME, ApiError, apiRequest } from "@voteapp/api-client";
import { ErrorNotice } from "../components/Status";
import { GoogleSignInButton } from "../components/GoogleSignInButton";
import { purgeAccountScopedQueries } from "@voteapp/api-client";
import { useAdoptPreHydrationValue } from "../lib/preHydrationInput";
import { safeInternalPath } from "../lib/safeInternalPath";
import { postLoginDestination } from "../lib/postLoginDestination";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { trackSettled } from "../lib/usage";

export const meta: MetaFunction = () => [
  { title: `Log in · ${APP_NAME}` },
  // Account pages carry no search value; without this Google indexes
  // every ?next= variant as a duplicate.
  { name: "robots", content: "noindex" },
];

export function LoginPage() {
  useDocumentTitle("Log in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Prerendered page: rescue input typed or autofilled before hydration.
  useAdoptPreHydrationValue("login-email", setEmail);
  useAdoptPreHydrationValue("login-password", setPassword);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Return path for flows that send visitors here mid-task (e.g. the
  // register-to-follow prompt on a candidate page). Internal paths only —
  // anything else falls back to the ballot.
  const [searchParams] = useSearchParams();
  const next = safeInternalPath(searchParams.get("next"));

  const login = useMutation({
    mutationFn: () => {
      const request = apiRequest<{ status: string }>("/api/auth/login", {
        method: "POST",
        body: { email: email.trim(), password },
      });
      trackSettled(request, "auth_result", { action: "login", has_next: next !== null });
      return request;
    },
    onSuccess: async () => {
      // A previous session may have ended without a clean logout; cached
      // account data (e.g. ["me","ballot"]) must not bleed into this one.
      purgeAccountScopedQueries(queryClient);
      // Login returns only the session cookie; identity comes from /api/me.
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      // An explicit return path wins over the onboarding detour: the user
      // logged in mid-task (e.g. to follow a candidate), so finish that —
      // the welcome step catches them on a future plain login. ?? also
      // short-circuits the preferences lookup when next is set.
      navigate(next ?? (await postLoginDestination(queryClient)));
    },
  });

  // Same success path as password login. This button never creates an
  // account (intent: "login"): a Google user without one is routed to the
  // register page, where the clickwrap checkbox gates the signup.
  const googleLogin = useMutation({
    mutationFn: (credential: string) => {
      const request = apiRequest<{ status: string }>("/api/auth/google", {
        method: "POST",
        body: { credential, intent: "login" },
      });
      trackSettled(request, "auth_result", { action: "google_login", has_next: next !== null });
      return request;
    },
    onSuccess: async () => {
      purgeAccountScopedQueries(queryClient);
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      navigate(next ?? (await postLoginDestination(queryClient)));
    },
  });
  const googleNeedsSignup =
    googleLogin.error instanceof ApiError && googleLogin.error.code === "needs_signup";

  // One flag across both auth paths: a password login and a Google login
  // racing each other would both purge caches and navigate, with the outcome
  // decided by response order.
  const authPending = login.isPending || googleLogin.isPending;
  const canSubmit = email.trim().length > 0 && password.length > 0 && !authPending;

  return (
    <div className="mx-auto max-w-md px-4 py-10">
      <h1 className="text-title font-bold">Log in</h1>

      <div className="mt-6">
        <GoogleSignInButton
          text="signin_with"
          disabled={authPending}
          onCredential={(credential) => {
            if (!authPending) {
              googleLogin.mutate(credential);
            }
          }}
        >
          {googleLogin.isError ? (
            <div className="mt-3">
              {googleNeedsSignup ? (
                <p className="rounded-lg border border-line bg-surface p-3 text-sm text-ink">
                  No account uses that Google account yet.{" "}
                  <Link
                    to={next ? `/register?next=${encodeURIComponent(next)}` : "/register"}
                    className="font-semibold underline hover:text-rausch"
                  >
                    Create your account
                  </Link>{" "}
                  to get started.
                </p>
              ) : (
                <ErrorNotice error={googleLogin.error} />
              )}
            </div>
          ) : null}
        </GoogleSignInButton>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) {
            login.mutate();
          }
        }}
        className="mt-6 space-y-4"
      >
        <div>
          <label htmlFor="login-email" className="block text-sm font-medium text-ink">
            Email
          </label>
          <input
            id="login-email"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            className="mt-1 w-full rounded-md border border-line px-3 py-3 shadow-sm focus:border-ink focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="login-password" className="block text-sm font-medium text-ink">
            Password
          </label>
          <input
            id="login-password"
            type="password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            className="mt-1 w-full rounded-md border border-line px-3 py-3 shadow-sm focus:border-ink focus:outline-none"
          />
        </div>
        <button
          type="submit"
          disabled={!canSubmit}
          className="w-full rounded-md bg-rausch px-4 py-3 font-semibold text-white transition hover:bg-rausch-dark disabled:cursor-not-allowed disabled:bg-line"
        >
          {login.isPending ? "Logging in…" : "Log in"}
        </button>
      </form>

      {login.isError ? (
        <div className="mt-4">
          <ErrorNotice error={login.error} />
        </div>
      ) : null}

      <div className="mt-6 space-y-1 text-sm text-ink-soft">
        <p>
          <Link to="/forgot-password" className="underline hover:text-ink">
            Forgot your password?
          </Link>
        </p>
        <p>
          New here?{" "}
          <Link
            to={next ? `/register?next=${encodeURIComponent(next)}` : "/register"}
            className="underline hover:text-ink"
          >
            Create an account
          </Link>
        </p>
      </div>
    </div>
  );
}

export default LoginPage;
