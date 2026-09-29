import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import { useState } from "react";
import { ApiError, useFollowSaving, useSetFollow } from "@voteapp/api-client";
import { trackSettled } from "../lib/usage";

// Follow/unfollow toggle. Rendered only for verified users (callers gate on
// useFollows().canFollow); new follows default to both notification kinds on,
// matching the backend's defaults.
//
// X's pattern once following: the button reads "Following", turns into a
// red "Unfollow" on hover, and a click asks before it unfollows — one
// accidental tap should not undo a follow.

type FollowButtonProps = {
  candidateId: string;
  candidateName: string;
  isFollowing: boolean;
  size?: "sm" | "md";
};

export function FollowButton({ candidateId, candidateName, isFollowing, size = "md" }: FollowButtonProps) {
  const setFollow = useSetFollow();
  const saving = useFollowSaving();
  const [confirming, setConfirming] = useState(false);
  // Hover/focus swaps the label in state rather than CSS so the button's
  // accessible name is always exactly what it shows.
  const [previewUnfollow, setPreviewUnfollow] = useState(false);
  const base =
    size === "sm"
      ? "rounded-lg px-3 py-1 text-xs font-semibold transition"
      : "rounded-lg px-4 py-2 text-sm font-semibold transition";

  // Surface follow failures (notably the follow limit, a 4xx with a
  // user-readable server message) instead of a button that silently does
  // nothing. Cleared implicitly: the next mutate resets isError.
  const errorMessage = setFollow.isError
    ? setFollow.error instanceof ApiError && setFollow.error.status < 500
      ? setFollow.error.message
      : "Something went wrong. Please try again."
    : null;

  function submit(following: boolean) {
    // mutateAsync (not mutate + per-call callbacks): the usage outcome must
    // land even if this button unmounts before the server answers. The
    // rejection is observed by the hook's own isError; swallow it here.
    const request = setFollow.mutateAsync({ candidate_id: candidateId, following });
    trackSettled(request, "follow_result", { change: following ? "follow" : "unfollow" });
    request.catch(() => undefined);
  }

  return (
    <div>
      <button
        type="button"
        disabled={saving}
        onClick={() => (isFollowing ? setConfirming(true) : submit(true))}
        onMouseEnter={() => setPreviewUnfollow(true)}
        onMouseLeave={() => setPreviewUnfollow(false)}
        onFocus={() => setPreviewUnfollow(true)}
        onBlur={() => setPreviewUnfollow(false)}
        // Instagram blue to follow, not the brand red — the header's Sign up
        // already owns it, and two red buttons dilute both. The following
        // state is quiet grey until hovered, when the swap to a red
        // "Unfollow" previews what the click will ask.
        className={
          isFollowing
            ? `${base} border border-line bg-gray-100 text-ink hover:border-red-700 hover:bg-red-50 hover:text-red-900`
            : `${base} bg-rausch text-white hover:bg-rausch-dark`
        }
      >
        {setFollow.isPending ? "…" : isFollowing ? (previewUnfollow ? "Unfollow" : "Following") : "Follow"}
      </button>
      {errorMessage ? (
        // role="alert": announced to assistive technology when it appears.
        <p role="alert" className="mt-1 max-w-56 text-xs text-rausch-dark">
          {errorMessage}
        </p>
      ) : null}
      <Dialog open={confirming} onClose={() => setConfirming(false)} className="relative z-50">
        <DialogBackdrop className="fixed inset-0 bg-ink/30" />
        <div className="fixed inset-0 flex items-center justify-center px-4 py-6">
          <DialogPanel className="w-full max-w-sm rounded-2xl border border-line bg-white p-5 shadow-xl">
            <DialogTitle className="text-lg font-semibold text-ink">Unfollow {candidateName}?</DialogTitle>
            <p className="mt-2 text-sm text-ink">You'll stop getting updates about them.</p>
            <div className="mt-4 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="text-sm text-ink-soft underline underline-offset-2 hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  submit(false);
                }}
                className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-800"
              >
                Unfollow
              </button>
            </div>
          </DialogPanel>
        </div>
      </Dialog>
    </div>
  );
}
