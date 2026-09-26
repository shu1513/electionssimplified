import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { MetaFunction } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { APP_NAME, apiRequest, purgeAccountScopedQueries } from "@voteapp/api-client";
import { LegalGate } from "../components/LegalGate";
import { ErrorNotice } from "../components/Status";
import { GoogleSignInButton } from "../components/GoogleSignInButton";
import { SIGNUP_CHECKBOX_LABEL, TERMS_VERSION } from "@voteapp/api-client";
import { useAdoptPreHydrationValue } from "../lib/preHydrationInput";
import { draftPickCount, useBallotDraft } from "../lib/ballotDraft";
import { safeInternalPath } from "../lib/safeInternalPath";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { postLoginDestination } from "../lib/postLoginDestination";
import { trackSettled } from "../lib/usage";

export const meta: MetaFunction = () => [
  { title: `Create your account · ${APP_NAME}` },
  // Account pages carry no search value; without this Google indexes
  // every ?next= variant as a duplicate.
  { name: "robots", content: "noindex" },
];

export function RegisterPage() {
  useDocumentTitle("Create your account");
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  // One toggle reveals both fields: the point of "Show" is checking what you
  // typed, and revealing only one of a pair defeats the comparison.
  const [showPassword, setShowPassword] = useState(false);
  const [accepted, setAccepted] = useState(false);
  // The page is prerendered: text entered (or autofilled) before hydration
  // exists only in the DOM. Fold it into state or the submit drops it.
  useAdoptPreHydrationValue("register-email", setEmail);
  useAdoptPreHydrationValue("register-first-name", setFirstName);
  useAdoptPreHydrationValue("register-password", setPassword);
  useAdoptPreHydrationValue("register-confirm-password", setConfirmPassword);
  // Return path forwarded to the login links so a visitor who arrived
  // mid-task (e.g. the register-to-follow prompt) can get back after they
  // log in. The email-verification hop can't carry it — a verification link
  // may be opened on another device — so only the same-tab path keeps it.
  // A guest's draft (made here or carried over from the newsroom box) is
  // replayed into the new account; say so, since it is why most arrive.
  const draftPicks = draftPickCount(useBallotDraft());
  const [searchParams] = useSearchParams();
  const next = safeInternalPath(searchParams.get("next"));
  const loginHref = next ? `/login?next=${encodeURIComponent(next)}` : "/login";
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const register = useMutation({
    mutationFn: () => {
      const request = apiRequest<{ status: string }>("/api/auth/register", {
        method: "POST",
        body: {
          email: email.trim(),
          password,
          // Clickwrap record: the backend rejects registration without the
          // current terms version and stores it with a timestamp.
          accepted_terms_version: TERMS_VERSION,
          ...(firstName.trim() ? { first_name: firstName.trim() } : {}),
        },
      });
      trackSettled(request, "auth_result", { action: "register", has_next: next !== null });
      return request;
    },
  });

  const resend = useMutation({
    mutationFn: () =>
      apiRequest<{ status: string }>("/api/auth/resend-verification", {
        method: "POST",
        body: { email: email.trim() },
      }),
  });

  // Google signup skips the email-verification round-trip entirely: the
  // account is created verified and logged in, so this follows the login
  // page's success path instead of the "check your email" screen.
  const googleSignup = useMutation({
    mutationFn: (credential: string) => {
      const request = apiRequest<{ status: string }>("/api/auth/google", {
        method: "POST",
        body: { credential, intent: "signup", accepted_terms_version: TERMS_VERSION },
      });
      trackSettled(request, "auth_result", { action: "google_signup", has_next: next !== null });
      return request;
    },
    onSuccess: async () => {
      purgeAccountScopedQueries(queryClient);
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      navigate(next ?? (await postLoginDestination(queryClient)));
    },
  });

  // The mismatch message waits until both fields have input — flagging a
  // half-typed confirmation as wrong would nag on every keystroke.
  const passwordsMismatch =
    password.length > 0 && confirmPassword.length > 0 && password !== confirmPassword;
  // One flag across both signup paths: a password registration and a Google
  // signup racing each other could create/log in different accounts with the
  // outcome decided by response order.
  const authPending = register.isPending || googleSignup.isPending;
  const canSubmit =
    accepted &&
    email.trim().length > 0 &&
    password.length > 0 &&
    password === confirmPassword &&
    !authPending;

  if (register.isSuccess) {
    return (
      <div className="mx-auto max-w-md px-4 py-10">
        <h1 className="text-title font-bold">Check your email</h1>
        <p className="mt-3 text-ink-soft">
          We sent a verification link to <strong className="text-ink">{email.trim()}</strong>. Open it to
          verify your account, then log in.
        </p>
        <div className="mt-6 flex items-center gap-4 text-sm">
          <Link to={loginHref} className="rounded-lg bg-rausch px-4 py-2 font-semibold text-white transition hover:bg-rausch-dark">
            Go to login
          </Link>
          <button
            type="button"
            onClick={() => resend.mutate()}
            disabled={resend.isPending}
            className="text-ink-soft underline hover:text-ink disabled:opacity-50"
          >
            {resend.isSuccess ? "Sent again" : "Resend email"}
          </button>
        </div>
        {resend.isError ? (
          <div className="mt-4">
            <ErrorNotice error={resend.error} />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md px-4 py-10">
      <h1 className="text-title font-bold">Create your account</h1>
      {draftPicks > 0 ? (
        <p className="mt-2 text-sm text-ink-soft">
          Your {draftPicks} {draftPicks === 1 ? "pick" : "picks"} will be saved to your account.
        </p>
      ) : null}

      {/* The clickwrap checkbox leads the page because it gates BOTH signup
          paths below it — Google directly underneath and the email form
          after the divider. */}
      <div className="mt-6">
        <LegalGate
          inputId="signup-terms"
          label={SIGNUP_CHECKBOX_LABEL}
          checked={accepted}
          onChange={setAccepted}
        />
      </div>

      <div className="mt-4">
        <GoogleSignInButton
          text="signup_with"
          disabled={!accepted || authPending}
          onCredential={(credential) => {
            if (accepted && !authPending) {
              googleSignup.mutate(credential);
            }
          }}
        >
          {/* Always explain the greyed-out button while unchecked — works
              identically for keyboard and mouse users, no interaction
              needed to discover why it's inactive. */}
          {!accepted ? (
            <p className="mt-2 text-center text-sm text-ink-soft">
              Check the box above to enable sign-up with Google.
            </p>
          ) : null}
          {googleSignup.isError ? (
            <div className="mt-3">
              <ErrorNotice error={googleSignup.error} />
            </div>
          ) : null}
        </GoogleSignInButton>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) {
            register.mutate();
          }
        }}
        className="mt-6 space-y-4"
      >
        <div>
          <label htmlFor="register-email" className="block text-sm font-medium text-ink">
            Email
          </label>
          <input
            id="register-email"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            className="mt-1 w-full rounded-md border border-line px-3 py-3 shadow-sm focus:border-ink focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="register-first-name" className="block text-sm font-medium text-ink">
            First Name <span className="font-normal text-ink-soft">(optional)</span>
          </label>
          <input
            id="register-first-name"
            type="text"
            value={firstName}
            onChange={(event) => setFirstName(event.target.value)}
            autoComplete="given-name"
            className="mt-1 w-full rounded-md border border-line px-3 py-3 shadow-sm focus:border-ink focus:outline-none"
          />
        </div>
        <div>
          <div className="flex items-baseline justify-between">
            <label htmlFor="register-password" className="block text-sm font-medium text-ink">
              Password
            </label>
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              className="text-xs text-ink-soft underline hover:text-ink"
            >
              {showPassword ? "Hide password" : "Show password"}
            </button>
          </div>
          <input
            id="register-password"
            type={showPassword ? "text" : "password"}
            required
            minLength={12}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            className="mt-1 w-full rounded-md border border-line px-3 py-3 shadow-sm focus:border-ink focus:outline-none"
          />
          <p className="mt-1 text-xs text-ink-soft">At least 12 characters.</p>
        </div>
        <div>
          <label htmlFor="register-confirm-password" className="block text-sm font-medium text-ink">
            Confirm password
          </label>
          <input
            id="register-confirm-password"
            type={showPassword ? "text" : "password"}
            required
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            autoComplete="new-password"
            className="mt-1 w-full rounded-md border border-line px-3 py-3 shadow-sm focus:border-ink focus:outline-none"
          />
          {passwordsMismatch ? (
            <p className="mt-1 text-xs text-red-700">Passwords don't match.</p>
          ) : null}
        </div>

        <button
          type="submit"
          disabled={!canSubmit}
          className="w-full rounded-md bg-rausch px-4 py-3 font-semibold text-white transition hover:bg-rausch-dark disabled:cursor-not-allowed disabled:bg-line"
        >
          {register.isPending ? "Creating account…" : "Create account"}
        </button>
      </form>

      {register.isError ? (
        <div className="mt-4">
          <ErrorNotice error={register.error} />
        </div>
      ) : null}

      <p className="mt-6 text-sm text-ink-soft">
        Already have an account?{" "}
        <Link to={loginHref} className="underline hover:text-ink">
          Log in
        </Link>
      </p>
    </div>
  );
}

export default RegisterPage;
