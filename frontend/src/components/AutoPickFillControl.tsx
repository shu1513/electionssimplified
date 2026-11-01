import { useState } from "react";
import { Link } from "react-router";
import {
  ApiError,
  collectSuggestedIssues,
  hasClearableAutoPicks,
  isDecidedChoice,
  MIN_AUTO_PICK_ISSUES,
  reasonLabel,
  useAutoPickFill,
  useClearAutoPicks,
  useElectionChoiceSaving,
  useMyResearchAreas,
} from "@voteapp/api-client";
import type { AutoPickElectionResult, ElectionChoice, SuggestedIssueGroup } from "@voteapp/api-client";
import { ISSUES_SETTINGS_PATH } from "../lib/issuesSettingsLink";
import { countBucket, currentAttribution, errorCategoryOf, track } from "../lib/usage";
import { AddIssuesDialog } from "./AddIssuesDialog";
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
//
// When a run leaves races open that more issues could decide (their results
// carry suggested_issues), the "Add these issues?" dialog opens with the
// issues merged across those races; adding them appends to the ranked list
// and reruns the fill over whatever is still empty.

// Kept for the existing import sites (PicksPage, BallotPreview).
export { reasonLabel };

// One line for the whole fill run, instead of "auto pick: …" on every row the
// engine left open (34 races → 30 identical notes was clutter). Counts what
// landed and groups the open rows by reason; skipped_existing rows (already
// decided by hand) are not the run's story. Per-race detail stays on each
// election page's panel. Shared by the My Draft cards and the election
// page's ballot rail.
export function autoFillSummary(results: Map<string, AutoPickElectionResult>): string | null {
  const all = [...results.values()];
  const picked = all.filter((result) => result.outcome === "picked").length;
  const open = all.filter((result) => result.outcome === "no_pick");
  if (picked === 0 && open.length === 0) {
    return null;
  }
  const byReason = new Map<string, number>();
  for (const result of open) {
    const label = reasonLabel(result.reason);
    byReason.set(label, (byReason.get(label) ?? 0) + 1);
  }
  const reasons = [...byReason.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => (byReason.size > 1 ? `${label} (${count})` : label))
    .join(", ");
  const parts = [`Auto-fill picked ${picked} race${picked === 1 ? "" : "s"}`];
  if (open.length > 0) {
    parts.push(`${open.length} left open: ${reasons}`);
  }
  return parts.join(" · ");
}

// Plain-English note behind the (i) beside the fill button. Says the two
// things the label can't: it covers every undecided race on this date, and
// it never touches a pick the user made themselves.
const HOW_FILL_WORKS =
  "For each race on this date you haven’t picked, we match candidates’ records to the issues you ranked in Settings and pick the best fit. Your own picks are never changed. If there is not enough evidence, race stays empty.";

export function AutoPickFillControl({
  date,
  elections,
  choices,
  choiceByElectionId,
  onResults,
  compact = false,
}: {
  /** The election date this control owns. */
  date: string;
  /** This date's carded races only (ids are all the control reads). */
  elections: { id: string }[];
  /** Every stored choice, for the date-scoped Clear gating. */
  choices: ElectionChoice[];
  choiceByElectionId: Map<string, ElectionChoice> | undefined;
  /** Fill results for this date, keyed by election id — null after a clear.
   * The caller annotates its race rows from this; nothing renders here. */
  onResults?: (byElectionId: Map<string, AutoPickElectionResult> | null) => void;
  /** Tighter type and padding for narrow homes (the 18rem detail rail). */
  compact?: boolean;
}) {
  const { preferences, isLoading: preferencesLoading, isError: preferencesError } = useMyResearchAreas();
  const saving = useElectionChoiceSaving();
  const [prompt, setPrompt] = useState(false);
  // Non-null while the "Add these issues?" dialog is up.
  const [suggestions, setSuggestions] = useState<SuggestedIssueGroup[] | null>(null);

  const emptyElectionIds = elections
    .filter((election) => !isDecidedChoice(choiceByElectionId?.get(election.id)))
    .map((election) => election.id);
  const clearable = hasClearableAutoPicks(choices, date);
  const fillable = emptyElectionIds.length > 0 && !clearable;

  const fill = useAutoPickFill(onResults);
  const clear = useClearAutoPicks(onResults);

  function onFill() {
    const usage = { scope: "date", races_bucket: countBucket(emptyElectionIds.length) };
    // Same rule as AutoPickControl: below the floor the engine still runs,
    // answers too_few_issues per race, and names the issues those races'
    // candidates have records on — the dialog merges them into the fastest
    // way to reach three ranked issues.
    track("autopick_attempt", {
      ...usage,
      prompted_rank_issues: !preferencesError && preferences.length < MIN_AUTO_PICK_ISSUES,
    });
    setPrompt(false);
    run(usage);
  }

  // The fill call itself — after the floor check on a click, and again
  // after the dialog added issues (over whatever is still empty by then).
  function run(usage: { scope: string; races_bucket: string }) {
    // The hook's own onSuccess still delivers the results to the page; this
    // chain records the outcome, on the page the fill started from, and
    // opens the dialog when the open races have issues worth adding.
    const attribution = currentAttribution();
    fill.mutateAsync(emptyElectionIds).then(
      (all) => {
        const picked = all.filter((result) => result.outcome === "picked").length;
        track(
          "autopick_result",
          { ...usage, outcome: picked === 0 ? "no_pick" : picked === all.length ? "picked" : "mixed" },
          attribution
        );
        const open = all.filter((result) => result.outcome === "no_pick");
        const issues = collectSuggestedIssues(open);
        setSuggestions(issues.length > 0 ? issues : null);
        // Below the floor with nothing to offer anywhere on the date: the
        // linked "rank your issues" prompt is the only way forward.
        setPrompt(
          issues.length === 0 && open.length > 0 && open.every((result) => result.reason === "too_few_issues")
        );
      },
      (error: unknown) =>
        track("autopick_result", { ...usage, outcome: "error", error_category: errorCategoryOf(error) }, attribution)
    );
  }

  // The dialog outlives the fill button: once a run lands picks, the button
  // gives way to Clear, but the open races' issues are still worth adding
  // and the rerun (fill_empty) only touches what is still empty.
  const dialog =
    suggestions !== null ? (
      <AddIssuesDialog
        suggestions={suggestions}
        scope="date"
        onClose={() => setSuggestions(null)}
        onAdded={() => {
          setSuggestions(null);
          const usage = { scope: "date", races_bucket: countBucket(emptyElectionIds.length) };
          track("autopick_attempt", { ...usage, prompted_rank_issues: false });
          run(usage);
        }}
      />
    ) : null;

  if (!fillable && !clearable) {
    return dialog;
  }

  // Compact (the rail): one line, always — the (i) never drops below the
  // button and the label never wraps inside the pill. Smaller type and
  // tighter padding so pill + (i) fit the 18rem rail side by side.
  const buttonSize = compact ? "whitespace-nowrap px-2 py-1 text-[11px]" : "px-3 py-1.5 text-sm";
  return (
    <div className={`${compact ? "" : "mt-2"} print:hidden`}>
      {/* relative: HowItWorksPopover anchors its panel to this row. */}
      <div className={`relative flex items-center gap-x-1 gap-y-2 ${compact ? "flex-nowrap" : "flex-wrap"}`}>
        {fillable ? (
          <button
            type="button"
            disabled={saving || preferencesLoading}
            onClick={onFill}
            className={`rounded-full border border-autopick-border bg-autopick font-semibold text-autopick-ink transition hover:bg-autopick-dark disabled:opacity-50 ${buttonSize}`}
          >
            {fill.isPending ? "Picking…" : "Auto-fill empty picks by my issues"}
          </button>
        ) : null}
        {fillable ? (
          <span className="shrink-0">
            <HowItWorksPopover text={HOW_FILL_WORKS} compact={compact} />
          </span>
        ) : null}
        {clearable ? (
          <button
            type="button"
            disabled={saving}
            onClick={() => clear.mutate(date)}
            className={`rounded-lg border border-line bg-white font-medium text-ink transition hover:border-ink disabled:opacity-50 ${buttonSize}`}
          >
            {clear.isPending ? "Clearing…" : "Clear auto picks"}
          </button>
        ) : null}
      </div>
      {prompt ? (
        <p role="status" className="mt-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink-mid">
          Rank at least {MIN_AUTO_PICK_ISSUES} issues first, so the picks reflect what matters to you.{" "}
          <Link
            to={ISSUES_SETTINGS_PATH}
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
      {dialog}
    </div>
  );
}
