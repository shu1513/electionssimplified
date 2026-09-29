import { useState } from "react";
import { Link } from "react-router";
import {
  ApiError,
  hasClearableAutoPicks,
  isDecidedChoice,
  MIN_AUTO_PICK_ISSUES,
  reasonLabel,
  useAutoPickFill,
  useClearAutoPicks,
  useElectionChoiceSaving,
  useMyResearchAreas,
} from "@voteapp/api-client";
import type { AutoPickElectionResult, ElectionChoice, ElectionSummary } from "@voteapp/api-client";
import { countBucket, currentAttribution, errorCategoryOf, track } from "../lib/usage";
import { HowItWorksPopover } from "./HowItWorksPopover";

// Per-date auto-pick controls for the My Picks page
// (docs/plans/auto-pick-by-issues.md): each election-date card (list view
// only — the ballot preview imitates a paper ballot and stays free of app
// machinery) gets its own "Auto-fill empty picks by my issues" button that
// runs POST /api/me/auto-picks in fill_empty mode over THAT date's undecided
// races only. Once that date has engine-owned rows the fill button gives way
// to a "Clear auto picks" button that DELETEs with ?election_date= so other
// dates' auto picks survive: the two never show together, because a rerun
// over the races the engine already left open returns the same "not enough
// evidence" (same issues, same data), so the only useful next step is Clear
// → fill again, which also recomputes the earlier auto picks after the user
// re-ranks issues. The mutations, chunking, and reason copy live in
// @voteapp/api-client (shared with the mobile port). No result list here:
// the caller gets the per-election results via onResults and renders its
// own one-line run summary; per-race "why" details live on each election
// page's panel.

// Kept for the existing import sites (PicksPage, BallotPreview).
export { reasonLabel };

// Plain-English note behind the (i) beside the fill button. Says the two
// things the label can't: it covers every undecided race on this date, and
// it never touches a pick the user made themselves.
const HOW_FILL_WORKS =
  "You rank the issues you care about in Settings. For each race on this date you haven't decided, we compare the candidates' records on those issues and pick the best match. Picks you made yourself are not changed. If there isn't enough evidence in a race, we leave it.";

export function AutoPickFillControl({
  date,
  elections,
  choices,
  choiceByElectionId,
  onResults,
}: {
  /** The election date this control owns. */
  date: string;
  /** This date's carded races only. */
  elections: ElectionSummary[];
  /** Every stored choice, for the date-scoped Clear gating. */
  choices: ElectionChoice[];
  choiceByElectionId: Map<string, ElectionChoice> | undefined;
  /** Fill results for this date, keyed by election id — null after a clear.
   * The caller annotates its race rows from this; nothing renders here. */
  onResults?: (byElectionId: Map<string, AutoPickElectionResult> | null) => void;
}) {
  const { preferences, isLoading: preferencesLoading, isError: preferencesError } = useMyResearchAreas();
  const saving = useElectionChoiceSaving();
  const [prompt, setPrompt] = useState(false);

  const emptyElectionIds = elections
    .filter((election) => !isDecidedChoice(choiceByElectionId?.get(election.id)))
    .map((election) => election.id);
  const clearable = hasClearableAutoPicks(choices, date);
  const fillable = emptyElectionIds.length > 0 && !clearable;

  const fill = useAutoPickFill(onResults);
  const clear = useClearAutoPicks(onResults);

  function onFill() {
    const usage = { scope: "date", races_bucket: countBucket(emptyElectionIds.length) };
    // Same rule as AutoPickControl: the issue-floor prompt only fires on a
    // LOADED list — on a failed fetch the backend's per-result
    // too_few_issues is the authority.
    if (!preferencesError && preferences.length < MIN_AUTO_PICK_ISSUES) {
      track("autopick_attempt", { ...usage, prompted_rank_issues: true });
      setPrompt(true);
      return;
    }
    track("autopick_attempt", { ...usage, prompted_rank_issues: false });
    setPrompt(false);
    // The hook's own onSuccess still delivers the results to the page; this
    // chain only records the outcome, on the page the fill started from.
    const attribution = currentAttribution();
    fill.mutateAsync(emptyElectionIds).then(
      (all) => {
        const picked = all.filter((result) => result.outcome === "picked").length;
        track(
          "autopick_result",
          { ...usage, outcome: picked === 0 ? "no_pick" : picked === all.length ? "picked" : "mixed" },
          attribution
        );
      },
      (error: unknown) =>
        track("autopick_result", { ...usage, outcome: "error", error_category: errorCategoryOf(error) }, attribution)
    );
  }

  if (!fillable && !clearable) {
    return null;
  }

  return (
    <div className="mt-2 print:hidden">
      {/* relative: HowItWorksPopover anchors its panel to this row. */}
      <div className="relative flex flex-wrap items-center gap-x-1 gap-y-2">
        {fillable ? (
          <button
            type="button"
            disabled={saving || preferencesLoading}
            onClick={onFill}
            className="rounded-full border border-autopick-border bg-autopick px-3 py-1.5 text-sm font-semibold text-autopick-ink transition hover:bg-autopick-dark disabled:opacity-50"
          >
            {fill.isPending ? "Picking…" : "Auto-fill empty picks by my issues"}
          </button>
        ) : null}
        {fillable ? <HowItWorksPopover text={HOW_FILL_WORKS} /> : null}
        {clearable ? (
          <button
            type="button"
            disabled={saving}
            onClick={() => clear.mutate(date)}
            className="rounded-lg border border-line bg-white px-3 py-1.5 text-sm font-medium text-ink transition hover:border-ink disabled:opacity-50"
          >
            {clear.isPending ? "Clearing…" : "Clear auto picks"}
          </button>
        ) : null}
      </div>
      {prompt ? (
        <p role="status" className="mt-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink-mid">
          Rank at least {MIN_AUTO_PICK_ISSUES} issues first, so the picks reflect what matters to you.{" "}
          <Link
            to="/me/settings"
            className="font-medium underline decoration-dotted underline-offset-2 hover:text-ink"
          >
            Rank your issues
          </Link>
        </p>
      ) : null}
      {fill.isError && !fill.isPending ? (
        // The partial-write warning applies to API errors too: the server
        // commits election by election (and the client sends chunks), so a
        // 429 or 500 partway through follows real writes. The rows below
        // were refetched onSettled and show the truth.
        <p role="alert" className="mt-2 text-sm font-medium text-red-800">
          {fill.error instanceof ApiError ? fill.error.message : "Couldn't finish filling."}{" "}
          Some races may already be filled — check the rows below.
        </p>
      ) : null}
      {clear.isError && !clear.isPending ? (
        // One atomic server-side DELETE: it either cleared everything or
        // nothing, so no partial-state warning here.
        <p role="alert" className="mt-2 text-sm font-medium text-red-800">
          Couldn't clear your auto picks — try again.
        </p>
      ) : null}
    </div>
  );
}
