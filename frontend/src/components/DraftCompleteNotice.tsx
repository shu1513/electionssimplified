import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { formatElectionDate, useMe } from "@voteapp/api-client";
import { hasDraftCompleteBeenSeen, markDraftCompleteSeen } from "../lib/draftCompleteSeen";
import { useGuestPickProgress, useMyPicksProgress } from "../lib/usePickProgress";
import { track } from "../lib/usage";

// The draft's finish line (docs/plans/draft-completion-moment.md): one
// notice, shown once per election day, when every race on the nearest
// upcoming day has a pick. Driven by the SAME progress value the header
// counter reads, not by the click that made the last pick — the last pick
// can come from the election page's auto pick, the picks page's batch fill,
// or another tab, and none of those pass through a pick card. Rendered as a
// row of the sticky header, in flow: nothing floats over the candidate
// page's bottom pick card (and its undo control), and no z-index contest
// with the chatbot launcher or the terms gate, which all sit at z-30.
//
// Wording (user decision 2026-09-04): "You have completed your {day}
// draft." plus the link — no count line, no "review and change" sentence.
// "Completed" leans on the counting rule (isDecidedChoice: one pick decides
// a race, even a multi-seat one; a withdrawn pick still counts; ZIP/city
// partial ballots reach 100%), which the owner accepted for the sake of a
// shorter message. No share mention — guests can't share, and signed-in
// users find Share on the date card.
//
// Status message, not a dialog (WCAG 4.1.3): role="status" announces it
// politely, focus stays where the user is — including when completion
// arrives from another tab — and the actions are an ordinary link and a
// dismiss button. The live region container is always in the DOM (empty
// until it fires) so screen readers pick up the insertion.

// Routes where the draft itself is on screen (or nothing is): the notice
// never renders there, and a completion that happens there (batch auto
// fill on /me/picks) counts as seen — it is not queued for the next page.
const SUPPRESSED_PATHS = new Set(["/", "/draft", "/me/picks"]);

export function DraftCompleteNotice() {
  const { me } = useMe();
  const { pathname } = useLocation();
  const guestProgress = useGuestPickProgress();
  const accountProgress = useMyPicksProgress();

  // Nothing while identity is unresolved (me undefined): reading the guest
  // draft then would let a signed-in user's stale localStorage draft speak
  // for the account. Both hooks are cheap and already mounted by the header.
  const identity = me === undefined ? null : me === null ? "guest" : me.email;
  const progress = me === undefined ? null : me === null ? guestProgress : accountProgress;
  // One tracked ballot = one identity + one election day + that day's race
  // list (ids sorted: /ballot and /draft can deliver the same races in
  // different orders). Null progress is "unknown", never "incomplete": the
  // signed-in hook starts at null and resolves later, and treating that as
  // false would congratulate every returning user whose first resolved
  // value is already complete.
  const trackedDate = identity !== null && progress !== null ? progress.election_date : null;
  const trackedKey =
    progress !== null && trackedDate !== null
      ? `${identity}|${trackedDate}|${[...progress.election_ids].sort().join(",")}`
      : null;
  const complete = progress?.complete ?? null;
  const suppressed = SUPPRESSED_PATHS.has(pathname);

  // Baseline: the last KNOWN value for the tracked ballot. Only a later
  // known incomplete → known complete for the SAME ballot fires; a new
  // identity, a new nearest day, or a changed race list starts a fresh
  // baseline instead (an address change or a retired race can turn 1/2
  // into 1/1 with no new pick — that is not a completion). Unknown breaks
  // the chain too: a pick made while progress was unknown is not observed.
  const baseline = useRef<{ key: string; complete: boolean } | null>(null);
  const [shown, setShown] = useState<{ date: string } | null>(null);

  useEffect(() => {
    if (trackedKey === null || trackedDate === null || complete === null) {
      // Nothing confirms the message any more (draft cleared, ballot with no
      // upcoming races, identity unresolved): drop it rather than let a
      // stale "every race has a pick" sit in the header.
      baseline.current = null;
      setShown(null);
      return;
    }
    const previous = baseline.current;
    baseline.current = { key: trackedKey, complete };
    if (previous === null) {
      return;
    }
    if (previous.key !== trackedKey) {
      // A different ballot is tracked now; an open notice about the old one
      // would be stale.
      setShown(null);
      return;
    }
    if (previous.complete === complete) {
      return;
    }
    if (!complete) {
      // Unpick: the message no longer holds.
      setShown(null);
      return;
    }
    if (hasDraftCompleteBeenSeen(trackedDate)) {
      return;
    }
    markDraftCompleteSeen(trackedDate);
    if (!suppressed) {
      track("draft_complete_notice", { action: "shown" });
      setShown({ date: trackedDate });
    }
  }, [trackedKey, trackedDate, complete, suppressed]);

  // Arriving on a page that shows the draft (via the header link, or the
  // notice's own link) retires the notice: the destination speaks for
  // itself, and it should not reappear on the way back out. The render
  // below also checks `suppressed` directly — effects run after paint, so
  // state alone would let the notice flash for one frame on arrival.
  useEffect(() => {
    if (suppressed) {
      setShown(null);
    }
  }, [suppressed]);

  const reviewPath = me === null ? "/draft" : "/me/picks";

  return (
    <div role="status">
      {shown && !suppressed ? (
        <div className="border-t border-line bg-green-50">
          <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-sm text-green-900">
            <p className="min-w-0 flex-1 font-semibold">
              You have completed your {formatElectionDate(shown.date)} election draft.
              {progress?.hasOpenRetention ? " Retention races are still open on your draft." : null}
            </p>
            <Link
              to={reviewPath}
              onClick={() => {
                track("draft_complete_notice", { action: "review" });
                setShown(null);
              }}
              className="whitespace-nowrap font-semibold text-green-800 hover:underline"
            >
              Review my picks
            </Link>
            <button
              type="button"
              onClick={() => {
                track("draft_complete_notice", { action: "dismiss" });
                setShown(null);
              }}
              aria-label="Dismiss"
              className="rounded px-1.5 text-lg leading-none text-green-900 hover:bg-green-100"
            >
              ×
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
