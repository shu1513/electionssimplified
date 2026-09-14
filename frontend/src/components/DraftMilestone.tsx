import { useEffect } from "react";
import { Link } from "react-router";
import { formatElectionDate } from "@voteapp/api-client";
import { track } from "../lib/usage";

// The draft pages' finish line (docs/plans/draft-completion-moment.md,
// section 2), above the List / Ballot preview toggle: "You have completed
// your {day} election draft." Shown ONCE per election day per browser — the
// caller decides via useShowDraftMilestone, which also marks the day as
// seen for the header notice. Not persistent on purpose (owner's rule:
// persistent = nag; the header already reads "My Draft ✓" and the card
// keeps its "N / M" progress bar).

export function DraftMilestone({
  show,
  date,
  signup,
  hasOpenRetention = false,
}: {
  /** From useShowDraftMilestone: complete AND first visit for this day. */
  show: boolean;
  date: string;
  /** Guest page: the milestone carries the sign-up link (and the "lives
   * only on this device" hint) because "save this" is the next step for a
   * finished draft. The page hides its own bottom CTA while this renders —
   * one button per page, never two identical ones. */
  signup: boolean;
  hasOpenRetention?: boolean;
}) {
  // Usage: the sign-up prompt counts as shown once per appearance.
  useEffect(() => {
    if (show && signup) {
      track("signup_prompt", { source: "milestone", action: "shown" });
    }
  }, [show, signup]);

  if (!show) {
    return null;
  }
  return (
    <section
      aria-label={`${formatElectionDate(date)} election draft milestone`}
      className="mt-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900"
    >
      <p className="font-semibold">
        <span aria-hidden="true">✓ </span>
        You have completed your {formatElectionDate(date)} election draft.
        {hasOpenRetention ? " Retention races are still open on your draft." : null}
      </p>
      {signup ? (
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <Link
            to={`/register?next=${encodeURIComponent("/draft")}`}
            onClick={() => track("signup_prompt", { source: "milestone", action: "click" })}
            className="inline-block rounded-lg bg-rausch px-3 py-1.5 font-semibold text-white transition hover:bg-rausch-dark"
          >
            Sign up free to save your picks
          </Link>
          <span className="text-xs">Your draft lives only on this device until you sign up.</span>
        </p>
      ) : null}
    </section>
  );
}
