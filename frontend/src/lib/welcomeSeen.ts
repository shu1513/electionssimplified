// Remembers that a user has been through the post-signup welcome step —
// whether they saved preferences or skipped — so login never routes them
// back to it. Saving alone isn't enough of a record: a user who later
// clears every preference in settings would otherwise look brand-new to
// the login redirect. Deliberately localStorage, not a backend flag: the
// cost of forgetting (one extra, still skippable screen on a new browser)
// is too small to justify an account field. The key is the account id, not
// the email: an email can be deleted and registered again as a new account,
// and that new account has not seen the step. It also keeps shared browsers
// from leaking the flag across accounts.

const KEY_PREFIX = "voteapp:welcome-seen-account:";

export function hasSeenWelcome(accountId: string): boolean {
  // SSR-safe and private-mode-safe: any storage failure counts as "not
  // seen", which only risks showing the (skippable) step again.
  try {
    return window.localStorage.getItem(KEY_PREFIX + accountId) === "1";
  } catch {
    return false;
  }
}

export function markWelcomeSeen(accountId: string): void {
  try {
    window.localStorage.setItem(KEY_PREFIX + accountId, "1");
  } catch {
    // Best effort — see above.
  }
}
