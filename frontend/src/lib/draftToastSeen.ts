// Browser-local "already shown" marker for the election page's post-pick
// toast (DraftToast): the pill teaches where the My Draft counter lives,
// and one lesson is enough — every pick after the first would make it a
// nag (owner's rule: persistent = nag). Once per browser, shared by guests
// and every account on it, same guarantee as draftCompleteSeen. Storage
// failures (private mode) fall back to a module flag so the toast still
// shows at most once per tab life.

export const DRAFT_TOAST_SEEN_KEY = "voteapp_draft_toast_seen";

let seenInMemory = false;

export function hasDraftToastBeenSeen(): boolean {
  if (seenInMemory) {
    return true;
  }
  try {
    return window.localStorage.getItem(DRAFT_TOAST_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function markDraftToastSeen(): void {
  try {
    window.localStorage.setItem(DRAFT_TOAST_SEEN_KEY, "1");
  } catch {
    seenInMemory = true;
  }
}
