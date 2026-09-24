import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@voteapp/api-client";
import { ErrorNotice } from "../components/Status";
import { useAdoptPreHydrationValue } from "../lib/preHydrationInput";
import { useDocumentTitle } from "../lib/useDocumentTitle";

export function ResetPasswordPage() {
  useDocumentTitle("Choose a new password");
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token")?.trim() ?? "";
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  // Prerendered page: rescue input typed or autofilled before hydration.
  useAdoptPreHydrationValue("reset-password", setPassword);
  useAdoptPreHydrationValue("reset-confirm-password", setConfirmPassword);

  const reset = useMutation({
    mutationFn: () =>
      apiRequest<{ status: string }>("/api/auth/reset-password", {
        method: "POST",
        body: { token, password },
      }),
  });

  // Same rule as sign-up: a typo here locks the reader out until they request
  // another link, so the password is typed twice. The mismatch message waits
  // until both fields have input.
  const passwordsMismatch =
    password.length > 0 && confirmPassword.length > 0 && password !== confirmPassword;
  const canSubmit = password.length > 0 && password === confirmPassword && !reset.isPending;

  if (!token) {
    return (
      <div className="mx-auto max-w-md px-4 py-10">
        <h1 className="text-title font-bold">Invalid link</h1>
        <p className="mt-3 text-ink-soft">
          This password reset link is incomplete. Request a new one from the{" "}
          <Link to="/forgot-password" className="underline hover:text-ink">
            reset page
          </Link>
          .
        </p>
      </div>
    );
  }

  if (reset.isSuccess) {
    return (
      <div className="mx-auto max-w-md px-4 py-10">
        <h1 className="text-title font-bold">Password updated</h1>
        <p className="mt-3 text-ink-soft">
          Your password has been changed and you have been logged out everywhere. Log in with the new
          password.
        </p>
        <p className="mt-6">
          <Link
            to="/login"
            className="rounded-lg bg-rausch px-4 py-2 font-semibold text-white transition hover:bg-rausch-dark"
          >
            Log in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md px-4 py-10">
      <h1 className="text-title font-bold">Choose a new password</h1>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) {
            reset.mutate();
          }
        }}
        className="mt-6 space-y-4"
      >
        <div>
          <div className="flex items-baseline justify-between">
            <label htmlFor="reset-password" className="block text-sm font-medium text-ink">
              New password
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
            id="reset-password"
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
          <label htmlFor="reset-confirm-password" className="block text-sm font-medium text-ink">
            Confirm password
          </label>
          <input
            id="reset-confirm-password"
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
          {reset.isPending ? "Saving…" : "Set new password"}
        </button>
      </form>

      {reset.isError ? (
        <div className="mt-4">
          <ErrorNotice error={reset.error} />
        </div>
      ) : null}
    </div>
  );
}

export default ResetPasswordPage;
