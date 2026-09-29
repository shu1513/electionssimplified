import { Link } from "react-router";
import { useMe } from "@voteapp/api-client";
import { myDraftLabel, useGuestDraftNav, useMyPicksProgress } from "../lib/usePickProgress";
import { track } from "../lib/usage";

// Post-pick confirmation actions — the "added to cart" moment, shared by the
// candidate page's sticky pick card and the measure page's sticky Yes/No
// card. Links, never an auto-redirect: navigating on a save's success would
// break multi-seat races (pick 2 of 3 here) and take the undo (re-click the
// control) away. The draft link wears the header nav's exact label so the
// card teaches the header item; both hooks are cheap (the guest one reads
// the local draft store, the signed-in one shares the header's own cached
// ballot query). Callers gate rendering on "the viewer's pick is recorded".

type PostPickActionsProps = {
  /** Optional "Back to {label}" hop. Callers pass it only when it isn't the
   * same place as the draft link (e.g. a My-Picks arrival gets no back link
   * or it would point beside a draft link to the same page). */
  back: { path: string; state?: unknown; label: string } | null;
};

export function PostPickActions({ back }: PostPickActionsProps) {
  return (
    <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-sm">
      {back ? (
        <Link
          to={back.path}
          state={back.state}
          onClick={() => track("post_pick_click", { target: "back" })}
          className="whitespace-nowrap text-ink-soft underline hover:text-ink"
        >
          Back to {back.label}
        </Link>
      ) : null}
      <DraftLink />
    </div>
  );
}

/** The post-pick draft link on its own — the election page's toast
 * (DraftToast) shows just this, since there the reader is already on the
 * election. Same label and destination as the header item, and the
 * header's color rule too: green is the "done" color, so the link only
 * wears it once the draft is complete ("My Draft ✓"); "My Draft 4/34" is
 * still homework and takes the header greeting's navy instead. */
export function DraftLink() {
  const { me } = useMe();
  const isGuest = me === null;
  const guestDraftNav = useGuestDraftNav();
  const picksProgress = useMyPicksProgress();
  const complete = isGuest ? (guestDraftNav?.complete ?? false) : (picksProgress?.complete ?? false);
  const className = complete
    ? "whitespace-nowrap font-semibold text-green-800 hover:underline"
    : "whitespace-nowrap font-semibold text-navy hover:underline";
  const onClick = () => track("post_pick_click", { target: "draft" });
  if (isGuest) {
    return guestDraftNav ? (
      <Link to={guestDraftNav.to} onClick={onClick} className={className}>
        {guestDraftNav.label}
      </Link>
    ) : null;
  }
  return (
    <Link to="/me/picks" onClick={onClick} className={className}>
      {myDraftLabel(picksProgress)}
    </Link>
  );
}
