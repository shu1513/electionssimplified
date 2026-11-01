import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  MIN_AUTO_PICK_ISSUES,
  toRankedResearchAreas,
  useMyResearchAreas,
  useReplaceResearchAreaPreferences,
} from "@voteapp/api-client";
import type { RankedResearchArea, SuggestedIssueGroup } from "@voteapp/api-client";
import { countBucket, track } from "../lib/usage";
import { ResearchAreaPicker, type ResearchAreaOption } from "./ResearchAreaPicker";

// "Filter candidates by choosing your stances on these issues" — opens after an auto-pick run that the
// user's ranked issues could not decide (or that ran below the three-issue
// floor), offering ONLY the unranked issues the undecided candidates (or the
// measure) actually have records on (the backend's suggested_issues, merged
// across the run by collectSuggestedIssues). The body is the same ranked
// editor as Settings (ResearchAreaPicker) with its pool restricted to those
// issues, shown first: tapping one appends it to the user's list, and
// everything the editor allows applies here too — drag a new issue up the
// priority order, set Support/Oppose, mark it a Must, or tap it off. Save is
// one full-list PUT (same as the settings editor) and the caller reruns the
// pick. The caller mounts this only while it should be open, so every
// opening starts fresh.
//
// Honest about the limit: adding issues helps when records exist on them —
// a race nobody has researched yields no suggestions and never opens this.

type AddIssuesDialogProps = {
  suggestions: SuggestedIssueGroup[];
  /** Which control opened it, for the autopick_suggest usage event. */
  scope: "election" | "date";
  onClose: () => void;
  /** Fires once the issues are saved; the caller runs the pick again. */
  onAdded: () => void;
};

export function AddIssuesDialog({ suggestions, scope, onClose, onAdded }: AddIssuesDialogProps) {
  // The PUT replaces the whole list, so the existing ranked issues must be
  // in hand before anything is edited: the editor waits for the fetch (in
  // practice it is cached — the control that opened this read it).
  // A FAILED fetch must not read as an empty list either: the hook returns
  // [] then, and an editor built on it would PUT a one-issue list over the
  // user's whole ranking. No editor until the list really loaded.
  const {
    preferences,
    savedAreaIds,
    isLoading: preferencesLoading,
    isError: preferencesError,
    refetch: refetchPreferences,
  } = useMyResearchAreas();
  const save = useReplaceResearchAreaPreferences();
  const [draft, setDraft] = useState<RankedResearchArea[] | null>(null);
  // The pool sits above a list that can run below the fold, so a tap would
  // otherwise land invisibly: the new row scrolls into view and flashes.
  const [landedId, setLandedId] = useState<string | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (landedId === null) {
      return;
    }
    const row = editorRef.current?.querySelector<HTMLElement>(`[data-research-area-id="${landedId}"]`);
    if (row && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    // Outlasts the smooth scroll, so the tint is still there when the row
    // arrives in view.
    const timer = window.setTimeout(() => setLandedId(null), 2500);
    return () => window.clearTimeout(timer);
  }, [landedId]);

  useEffect(() => {
    track("autopick_suggest", { scope, action: "shown", issues_bucket: countBucket(suggestions.length) });
  }, [scope, suggestions.length]);

  // A suggestion the user ranked meanwhile (another tab, a quick Settings
  // trip) is not offered twice — the PUT would reject the duplicate anyway.
  const offered = suggestions.filter((issue) => !savedAreaIds.has(issue.research_area_id));
  const pool: ResearchAreaOption[] = offered.map((issue) => ({
    id: issue.research_area_id,
    slug: issue.slug,
    name: issue.name,
    description: issue.description,
  }));
  // The ranked rows need names for the user's existing issues too.
  const areas: ResearchAreaOption[] = [
    ...preferences.map((preference) => ({
      id: preference.research_area_id,
      slug: preference.slug,
      name: preference.name,
      description: preference.description,
    })),
    ...pool,
  ];
  // Nothing offered starts chosen (owner, 2026-10-31): the list opens as
  // the user's current priorities, and each race issue is a deliberate tap
  // — the pool sits above the list so that choice is the first thing seen.
  const ranked: RankedResearchArea[] | null =
    draft ?? (preferencesLoading || preferencesError ? null : toRankedResearchAreas(preferences));
  const added = ranked ? ranked.filter((row) => !savedAreaIds.has(row.research_area_id)).length : 0;

  function onEditorChange(next: RankedResearchArea[]) {
    const before = new Set((ranked ?? []).map((row) => row.research_area_id));
    const landed = next.find((row) => !before.has(row.research_area_id));
    setDraft(next);
    setLandedId(landed ? landed.research_area_id : null);
  }

  function dismiss() {
    track("autopick_suggest", { scope, action: "dismissed", issues_bucket: countBucket(offered.length) });
    onClose();
  }

  function add() {
    if (!ranked || added === 0 || save.isPending) {
      return;
    }
    save.mutate(ranked, {
      onSuccess: () => {
        track("autopick_suggest", { scope, action: "added", issues_bucket: countBucket(added) });
        onAdded();
      },
    });
  }

  // Owner's heading (2026-10-31): says what the popup is for. The intro
  // under it is the Settings section's, verbatim — this IS that editor,
  // scoped to one race's issues.
  const title = "Filter candidates by choosing your stances on these issues";
  // The button promises the rerun only once the list would reach the floor.
  const reachesFloor = (ranked?.length ?? 0) >= MIN_AUTO_PICK_ISSUES;

  return (
    <Dialog open onClose={dismiss} className="relative z-50">
      <DialogBackdrop className="fixed inset-0 bg-ink/30" />
      <div className="fixed inset-0 flex items-center justify-center px-4 py-6">
        <DialogPanel className="flex max-h-full w-full max-w-2xl flex-col rounded-2xl border border-line bg-white p-5 shadow-xl">
          <div className="flex items-start justify-between gap-4">
            <DialogTitle className="text-lg font-semibold text-ink">{title}</DialogTitle>
            <button type="button" onClick={dismiss} className="text-sm text-ink-soft hover:text-ink">
              Close
            </button>
          </div>
          {/* The Settings intro verbatim, and nothing else (owner: no status
              line): it explains drag-to-rank and the "Must" button, which
              otherwise explains itself only on hover. */}
          <p className="mt-1 text-sm text-ink">
            Choose the issues that matter most to you and drag to arrange them into priority order. Choose
            &ldquo;Must&rdquo; if you will absolutely not accept a candidate or ballot measure that takes the
            opposite stance from yours.
          </p>
          <div ref={editorRef} className="min-h-0 flex-1 overflow-y-auto">
            {preferencesError ? (
              <p role="alert" className="mt-3 text-sm font-medium text-red-800">
                Couldn&apos;t load your issues.{" "}
                <button
                  type="button"
                  onClick={refetchPreferences}
                  className="font-medium underline decoration-dotted underline-offset-2 hover:text-ink"
                >
                  Try again
                </button>
              </p>
            ) : null}
            {ranked ? (
              <ResearchAreaPicker
                areas={areas}
                poolAreas={pool}
                poolFirst
                poolTitle={
                  scope === "election" ? "Choose and rank issues related to this race" : "Choose and rank issues related to these races"
                }
                ranked={ranked}
                highlightedId={landedId}
                disabled={save.isPending}
                onChange={onEditorChange}
              />
            ) : null}
          </div>
          {save.isError ? (
            <p role="alert" className="mt-2 text-sm font-medium text-red-800">
              {save.error instanceof ApiError ? save.error.message : "Couldn't save your issues — try again."}
            </p>
          ) : null}
          <div className="mt-4 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={dismiss}
              className="text-sm text-ink-soft underline underline-offset-2 hover:text-ink"
            >
              Not now
            </button>
            <button
              type="button"
              disabled={added === 0 || save.isPending}
              onClick={add}
              className="rounded-lg bg-rausch px-4 py-2 text-sm font-semibold text-white hover:bg-rausch-dark disabled:opacity-50"
            >
              {save.isPending
                ? "Saving…"
                : `Add ${added} issue${added === 1 ? "" : "s"}${reachesFloor ? " and pick again" : ""}`}
            </button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
