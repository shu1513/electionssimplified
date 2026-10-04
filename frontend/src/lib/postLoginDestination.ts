import type { QueryClient } from "@tanstack/react-query";
import { apiRequest } from "@voteapp/api-client";
import type { Me, ResearchAreaPreferencesResult } from "@voteapp/api-client";
import { hasSeenWelcome } from "./welcomeSeen";

// First-login onboarding hook-in, shared by password login, Google login,
// and Google signup: a verified user with no saved research areas who hasn't
// been through the welcome step gets routed there first. `next` is the
// return path of a visitor who signed in mid-task (e.g. from a prompt on
// their ballot); the welcome step carries it and continues there when done.
// Sessions are long, so waiting for a later plain login would mean most
// people who sign up from a prompt never see the step. Any lookup failure
// falls back to the return path or the ballot — login must never strand the
// user on an error because an optional step couldn't be checked.
export async function postLoginDestination(queryClient: QueryClient, next: string | null): Promise<string> {
  const destination = next ?? "/me/ballot";
  const me = queryClient.getQueryData<Me | null>(["me"]);
  if (!me?.email_verified || hasSeenWelcome(me.email)) {
    return destination;
  }
  try {
    // fetchQuery, not a bare request: it seeds the cache the welcome page
    // and settings editor read from.
    const prefs = await queryClient.fetchQuery({
      queryKey: ["me", "research-area-preferences"],
      queryFn: () => apiRequest<ResearchAreaPreferencesResult>("/api/me/research-area-preferences"),
      staleTime: 60_000,
    });
    if (prefs.preferences.length > 0) {
      return destination;
    }
    return next ? `/me/welcome?next=${encodeURIComponent(next)}` : "/me/welcome";
  } catch {
    return destination;
  }
}
