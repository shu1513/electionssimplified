import { useState } from "react";
import { Link } from "react-router";
import {
  ApiError,
  joinNames,
  MIN_AUTO_PICK_ISSUES,
  summarizeAutoPick,
  useAutoPick,
  useElectionChoiceSaving,
  useMe,
  useMyResearchAreas,
} from "@voteapp/api-client";
import type { AutoPickCandidateReport, AutoPickElectionResult } from "@voteapp/api-client";
import { currentAttribution, errorCategoryOf, track } from "../lib/usage";
import { HowItWorksPopover } from "./HowItWorksPopover";
import { RegisterPromptDialog } from "./RegisterPromptDialog";

// "Pick by my issues": one button that runs the auto-pick engine for this election
// (POST /api/me/auto-picks, mode replace) and opens a "Why this pick" panel
// built from the response — winner, per-issue alignment, vetoed and
// unresearched candidates, and the honest "no pick" reason when nothing
// qualified. Spec: docs/plans/auto-pick-by-issues.md. The issue floor and
// the headline copy live in @voteapp/api-client (shared with the mobile
// port); this file keeps the web widgets.
//
// Below the issue floor the button explains what to do instead of calling
// the API. Guests get a teaser pill in the button's place — "Which
// candidate best matches my values?" — that opens the shared log in /
// sign up dialog (same as the follow button), with this page as the
// post-auth return path: issue preferences are account-only, and the
// question is the pitch for an account. Plain words on purpose: a first
// visit has no idea the app keeps "my issues".
export { MIN_AUTO_PICK_ISSUES };

type AutoPickControlProps = {
  electionId: string;
  /** elections.seats_to_fill — null renders as a single seat (office races);
   * pass null for measures. Lets the panel flag a partial fill: "picked"
   * with fewer names than seats must not read as a finished race. */
  seatsToFill: number | null;
  /** Smaller pill (measure section's mid-page placement) — the Yes/No pair
   * on the sticky card stays the page's loud control. */
  compact?: boolean;
  /** Ballot measure: the guest teaser asks about "this measure", not a
   * candidate. */
  measure?: boolean;
  /** Judicial retention: the engine answers Yes/No on keeping the one
   * judge, so the teaser asks whether "this candidate" aligns. */
  retention?: boolean;
  /** Fires after a run that made a pick. The engine scores the whole
   * roster, not the party-filtered view the button sits under — the page
   * uses this to clear its filter so the picked card is never hidden. */
  onPicked?: () => void;
};

export function AutoPickControl({
  electionId,
  seatsToFill,
  compact = false,
  measure = false,
  retention = false,
  onPicked,
}: AutoPickControlProps) {
  const { me } = useMe();
  const { preferences, isLoading: preferencesLoading, isError: preferencesError } = useMyResearchAreas();
  const autoPick = useAutoPick();
  const saving = useElectionChoiceSaving();
  const [prompt, setPrompt] = useState<"rank_issues" | null>(null);
  const [result, setResult] = useState<AutoPickElectionResult | null>(null);
  const [teaserOpen, setTeaserOpen] = useState(false);

  const areaNames = new Map(preferences.map((preference) => [preference.research_area_id, preference.name]));
  const areaName = (researchAreaId: string) => areaNames.get(researchAreaId) ?? "one of your issues";
  // Highest priority first (explicit ranks, then legacy unranked) — the
  // same order the engine scores in.
  const issueOrder = [...preferences]
    .sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER))
    .map((preference) => preference.research_area_id);

  // Still-resolving (undefined) sessions render nothing, so neither the
  // button nor the teaser flashes at a user who is about to be signed in.
  if (me === undefined) {
    return null;
  }
  // Signed-out: the teaser instead of the button, styled exactly like it
  // (same orange pill, same size) so it reads as the one action here. The
  // click opens the shared dialog (the dialog owns the signup_prompt usage
  // events), which explains the two-step deal: pick issues, then see the
  // match.
  if (me === null) {
    const question = measure
      ? "Does this measure match my values?"
      : retention
        ? "Does this candidate align with my values?"
        : "Which candidate best matches my values?";
    return (
      <>
        <button
          type="button"
          onClick={() => setTeaserOpen(true)}
          className={`rounded-full border border-autopick-border bg-autopick font-semibold text-autopick-ink transition hover:bg-autopick-dark ${
            compact ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm"
          }`}
        >
          {question}
        </button>
        <RegisterPromptDialog
          open={teaserOpen}
          onClose={() => setTeaserOpen(false)}
          source="autopick"
          title={question}
          description={
            measure
              ? "Sign up or log in to pick the issues you care about, and see whether this measure matches what you believe. Signing up is free."
              : retention
                ? "Sign up or log in to pick the issues you care about, and see whether this candidate aligns with what you believe. Signing up is free."
                : "Sign up or log in to pick the issues you care about, and see which candidate best matches what you believe. Signing up is free."
          }
        />
      </>
    );
  }

  function onClick() {
    setResult(null);
    const usage = { scope: "election", races_bucket: "1-3" };
    // The issue-floor prompt only fires on a LOADED list: a failed fetch
    // returns the same empty array, and telling a user with five ranked
    // issues to go rank issues would be wrong — on error the backend's
    // per-result too_few_issues is the authority (the panel renders it).
    if (!preferencesError && preferences.length < MIN_AUTO_PICK_ISSUES) {
      track("autopick_attempt", { ...usage, prompted_rank_issues: true });
      setPrompt("rank_issues");
      return;
    }
    track("autopick_attempt", { ...usage, prompted_rank_issues: false });
    setPrompt(null);
    // UI work stays in the per-call onSuccess: react-query skips it once
    // this control has unmounted, so a run started on election A can't
    // clear election B's party filter through a stale onPicked. The usage
    // outcome rides the promise instead — it must land even after unmount.
    // The rejection is observed by the hook's own isError.
    const attribution = currentAttribution();
    const request = autoPick.mutateAsync(
      { election_ids: [electionId], mode: "replace" },
      {
        onSuccess: (response) => {
          const first = response.results[0] ?? null;
          setResult(first);
          if (first?.outcome === "picked") {
            onPicked?.();
          }
        },
      }
    );
    request.then(
      (response) => {
        const first = response.results[0] ?? null;
        track(
          "autopick_result",
          {
            ...usage,
            outcome: first?.outcome === "picked" ? "picked" : "no_pick",
            ...(first?.reason ? { reason: first.reason } : {}),
          },
          attribution
        );
      },
      (error: unknown) =>
        track("autopick_result", { ...usage, outcome: "error", error_category: errorCategoryOf(error) }, attribution)
    );
  }

  // Plain-English "how does this work?" beside the button (HowItWorksPopover):
  // the "Why this pick" panel only explains after a click, so a first visit
  // needs this before pressing. The row is `relative` so the popover's
  // left edge lines up with the pill.
  const howItWorks = measure
    ? "You rank the issues you care about in Settings. We compare what this measure would do against those issues, weighting your top issues most, and answer Yes or No. If there isn't enough evidence, we don't give an answer and tell you why."
    : retention
      ? "You rank the issues you care about in Settings. We check this judge's record on those issues, weighting your top issues most, and answer Yes or No on keeping them. If there isn't enough evidence, we don't give an answer and tell you why."
      : "You rank the issues you care about in Settings. We compare each candidate's record on those issues, weighting your top issues most, and pick the best match. If there isn't enough evidence, we don't make a pick and tell you why.";

  return (
    <div className="flex flex-col gap-2">
      <span className="relative flex flex-wrap items-center gap-x-1 gap-y-1">
        <button
          type="button"
          // Disabled while the preferences load: clicking then would hit the
          // issue-floor check against a still-empty list and misdirect a
          // ready user to the issue editor.
          disabled={saving || preferencesLoading}
          onClick={onClick}
          className={`rounded-full border border-autopick-border bg-autopick font-semibold text-autopick-ink transition hover:bg-autopick-dark disabled:opacity-50 ${
            compact ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm"
          }`}
        >
          {autoPick.isPending ? "Picking…" : "Auto-pick by my issues"}
        </button>
        <HowItWorksPopover text={howItWorks} compact={compact} />
      </span>
      {prompt === "rank_issues" ? (
        <p role="status" className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink-mid">
          Rank at least {MIN_AUTO_PICK_ISSUES} issues first, so the pick reflects what matters to you.{" "}
          <Link
            to="/me/settings"
            className="font-medium underline decoration-dotted underline-offset-2 hover:text-ink"
          >
            Rank your issues
          </Link>
        </p>
      ) : null}
      {autoPick.isError && !autoPick.isPending ? (
        <p role="alert" className="w-full text-sm font-medium text-red-800">
          {autoPick.error instanceof ApiError
            ? autoPick.error.message
            : "Couldn't run the pick — check your connection and try again."}
        </p>
      ) : null}
      {result !== null ? (
        <WhyThisPickPanel
          result={result}
          seatsToFill={seatsToFill}
          areaName={areaName}
          issueOrder={issueOrder}
          onDismiss={() => setResult(null)}
        />
      ) : null}
    </div>
  );
}

type WhyThisPickPanelProps = {
  result: AutoPickElectionResult;
  seatsToFill: number | null;
  areaName: (researchAreaId: string) => string;
  /** The user's ranked issue ids, highest priority first. Orders every
   * list below and supplies the "of your N issues" denominator. */
  issueOrder: string[];
  onDismiss: () => void;
};

/** Up to this many aligned issues are named in the headline itself. */
const INLINE_ISSUE_LIMIT = 3;

// Per-issue alignment, summarized: "aligned on 13 of your 16 issues", the
// exceptions (conflicts / mixed) named right away because that is what a
// voter needs to check, and the full grouped list behind a toggle. The old
// form listed every issue with its own "· aligned" — sixteen repeats of the
// same word was a wall. Every list keeps the user's priority order.
function IssueAlignment({
  perIssue,
  issueOrder,
  areaName,
}: {
  perIssue: { research_area_id: string; net: number }[];
  issueOrder: string[];
  areaName: (id: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const rank = new Map(issueOrder.map((id, index) => [id, index]));
  const byRank = (a: { research_area_id: string }, b: { research_area_id: string }) =>
    (rank.get(a.research_area_id) ?? issueOrder.length) - (rank.get(b.research_area_id) ?? issueOrder.length);
  const names = (issues: { research_area_id: string }[]) =>
    [...issues].sort(byRank).map((issue) => areaName(issue.research_area_id));
  const aligned = names(perIssue.filter((issue) => issue.net > 0));
  const conflicts = names(perIssue.filter((issue) => issue.net < 0));
  const mixed = names(perIssue.filter((issue) => issue.net === 0));
  const total = issueOrder.length;
  // Few aligned issues (1–3): name them in the headline — shorter than a
  // count, and nothing is left to expand since conflicts/mixed are always
  // named below. More: the count, with the names behind the chevron.
  const nameInline = aligned.length > 0 && aligned.length <= INLINE_ISSUE_LIMIT;
  const headline = nameInline
    ? `aligned on ${joinNames(aligned)}`
    : total === 0
      ? `aligned on ${aligned.length} issue${aligned.length === 1 ? "" : "s"}`
      : aligned.length === total
        ? `aligned on all ${total} of your issues`
        : `aligned on ${aligned.length} of your ${total} issues`;
  // Same rule for the exceptions: a short list is named, a long one is
  // counted with the names behind the chevron.
  const inline = (label: string, names: string[]) =>
    names.length <= INLINE_ISSUE_LIMIT ? `${label}: ${joinNames(names)}` : `${label} on ${names.length} issues`;
  const expandable = [aligned, conflicts, mixed].some((names) => names.length > INLINE_ISSUE_LIMIT);
  return (
    <>
      {/* The headline is the toggle: click it (or the chevron) to see the
          issue names. One target, no orphan "Show issues" link line. */}
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((previous) => !previous)}
          className="inline-flex items-center gap-1 font-semibold text-green-900 hover:underline decoration-dotted underline-offset-2"
        >
          {headline}
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            className={`h-4 w-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 8l5 5 5-5" />
          </svg>
        </button>
      ) : (
        <span className="font-semibold text-green-900">{headline}</span>
      )}
      {conflicts.length > 0 || mixed.length > 0 ? (
        <span className="mt-1 block">
          {conflicts.length > 0 ? (
            <span className="font-medium text-red-900">{inline("Conflicts", conflicts)}</span>
          ) : null}
          {conflicts.length > 0 && mixed.length > 0 ? <span className="text-ink-soft"> · </span> : null}
          {mixed.length > 0 ? <span className="font-medium text-amber-900">{inline("Mixed", mixed)}</span> : null}
        </span>
      ) : null}
      {expandable && open ? (
        // Each group in its own color, same tier as the headline — the names
        // are the payload here, not a footnote.
        <span className="mt-1 block text-sm font-medium leading-relaxed">
          {aligned.length > 0 ? (
            <span className="block text-green-700">
              <span className="font-semibold text-green-900">Aligned:</span> {aligned.join(", ")}
            </span>
          ) : null}
          {conflicts.length > 0 ? (
            <span className="block text-red-700">
              <span className="font-semibold text-red-900">Conflicts:</span> {conflicts.join(", ")}
            </span>
          ) : null}
          {mixed.length > 0 ? (
            <span className="block text-amber-700">
              <span className="font-semibold text-amber-900">Mixed:</span> {mixed.join(", ")}
            </span>
          ) : null}
        </span>
      ) : null}
    </>
  );
}

function WhyThisPickPanel({ result, seatsToFill, areaName, issueOrder, onDismiss }: WhyThisPickPanelProps) {
  const pickedReports = result.picked_candidate_ids
    .map((id) => result.candidates.find((report) => report.candidate_id === id))
    .filter((report): report is AutoPickCandidateReport => report !== undefined);
  const vetoedReports = result.candidates.filter((report) => report.vetoed_by.length > 0);

  return (
    <section
      aria-label="Why this pick"
      className="w-full rounded-xl border border-line bg-surface/50 p-4 text-sm text-ink"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium">{summarizeAutoPick(result, seatsToFill)}</p>
        <button
          type="button"
          onClick={onDismiss}
          className="text-xs font-medium text-ink-soft underline decoration-dotted underline-offset-2 hover:text-ink"
        >
          Hide
        </button>
      </div>
      {/* Measures and retention Yes/No answers both carry the per-issue
          list here (a retention judge is never in picked_candidate_ids). */}
      {result.measure_per_issue.length > 0 ? (
        <p className="mt-2">
          <span className="font-medium text-ink-soft">On your issues:</span>{" "}
          <IssueAlignment perIssue={result.measure_per_issue} issueOrder={issueOrder} areaName={areaName} />
        </p>
      ) : null}
      {pickedReports.map((report) => (
        <p key={report.candidate_id} className="mt-2">
          <span className="font-medium">{report.display_name}</span>
          {report.per_issue.length > 0 ? (
            <>
              {" — "}
              <IssueAlignment perIssue={report.per_issue} issueOrder={issueOrder} areaName={areaName} />
            </>
          ) : (
            <span className="text-ink-soft"> — no records on your issues (picked by elimination)</span>
          )}
        </p>
      ))}
      {vetoedReports.map((report) => (
        <p key={report.candidate_id} className="mt-2 text-red-900">
          {/* A retention veto is a No answer, not an exclusion from a field. */}
          <span className="font-medium">{report.display_name}</span>
          {result.measure_position === null ? " excluded" : ""} — crossed your line on{" "}
          {joinNames([...new Set(report.vetoed_by.map((veto) => areaName(veto.research_area_id)))])}:{" "}
          <span className="text-ink-soft">
            {report.vetoed_by[0]?.description}
            {report.vetoed_by.length > 1 ? ` (and ${report.vetoed_by.length - 1} more)` : ""}
          </span>
        </p>
      ))}
      {result.unresearched.length > 0 ? (
        // Transparency requirement: the comparison was partial, and the user
        // must see who was missing and why (never researched vs researched
        // with nothing found on their issues).
        <p className="mt-2 text-ink-soft">
          <span className="font-medium">Not compared:</span>{" "}
          {result.unresearched.map((entry, index) => (
            <span key={entry.candidate_id}>
              {entry.display_name} ({entry.never_researched ? "not researched yet" : "no records on your issues"})
              {index < result.unresearched.length - 1 ? ", " : null}
            </span>
          ))}
        </p>
      ) : null}
    </section>
  );
}
