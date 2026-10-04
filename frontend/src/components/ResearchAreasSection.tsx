import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@voteapp/api-client";
import type { ResearchAreaCatalog, ResearchAreaPreferencesResult } from "@voteapp/api-client";
import { ErrorNotice, LoadingNotice } from "./Status";
import { ResearchAreaPicker } from "./ResearchAreaPicker";
import { ISSUES_SECTION_ID } from "../lib/issuesSettingsLink";
import {
  toPreferenceInputs,
  toRankedResearchAreas,
  type RankedResearchArea,
} from "../lib/rankedResearchAreas";

// The ranked "issues you care about" editor, back on SettingsPage after a
// stint on My Picks. Callers gate on a verified session — the preferences
// endpoint is verification-gated.

export function ResearchAreasSection() {
  const queryClient = useQueryClient();
  // Optimistic overlay: the PUT replaces the whole ranked list, so quick
  // consecutive edits (reorder, add, remove, toggle) must merge from the
  // latest view.
  const [pending, setPending] = useState<RankedResearchArea[] | null>(null);
  const catalog = useQuery({
    queryKey: ["research-areas"],
    queryFn: () => apiRequest<ResearchAreaCatalog>("/api/research-areas"),
    staleTime: 5 * 60_000,
  });
  const prefs = useQuery({
    queryKey: ["me", "research-area-preferences"],
    queryFn: () => apiRequest<ResearchAreaPreferencesResult>("/api/me/research-area-preferences"),
    staleTime: 60_000,
  });
  const update = useMutation({
    mutationKey: ["put-research-area-preferences"],
    // List position is the rank: first = rank 1.
    mutationFn: (ranked: RankedResearchArea[]) =>
      apiRequest<ResearchAreaPreferencesResult>("/api/me/research-area-preferences", {
        method: "PUT",
        body: { preferences: toPreferenceInputs(ranked) },
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(["me", "research-area-preferences"], saved);
      // The saved ballot is server-sorted by these preferences (my_areas),
      // and the ballot-preferences default can flip to my_areas when the
      // first area is saved — both must refetch, not wait out staleTime.
      void queryClient.invalidateQueries({ queryKey: ["me", "ballot"] });
      void queryClient.invalidateQueries({ queryKey: ["me", "ballot-preferences"] });
    },
    onSettled: () => {
      setPending(null);
    },
  });
  // Cross-mount in-flight guard, same as the other full-replace preference
  // writes: controls stay locked until the older PUT settles. (Render value —
  // save() re-checks the mutation cache imperatively to close the gap before
  // this re-renders.)
  const saving = useIsMutating({ mutationKey: ["put-research-area-preferences"] }) > 0;

  // Links that carry this section's hash ("Rank your issues") open the page
  // scrolled to it. The router's own hash scroll can miss: this section
  // mounts after the session loads, and grows once its queries settle — so
  // it scrolls itself on mount and again when the editor appears. Guarded
  // because jsdom elements have no scrollIntoView.
  const { hash } = useLocation();
  const loaded = !catalog.isPending && !prefs.isPending;
  useEffect(() => {
    if (hash !== `#${ISSUES_SECTION_ID}`) {
      return;
    }
    const section = document.getElementById(ISSUES_SECTION_ID);
    if (section && typeof section.scrollIntoView === "function") {
      section.scrollIntoView({ block: "start" });
    }
  }, [hash, loaded]);

  if (catalog.isPending || prefs.isPending) {
    return (
      <Section title="My most important issues">
        <LoadingNotice text="Loading…" />
      </Section>
    );
  }
  if (catalog.isError || prefs.isError) {
    return (
      <Section title="My most important issues">
        <div className="mt-2">
          <ErrorNotice error={catalog.error ?? prefs.error} />
        </div>
      </Section>
    );
  }

  // Server order is rank ASC NULLS LAST, so it is the editor order directly.
  const ranked = pending ?? toRankedResearchAreas(prefs.data.preferences);

  function save(next: RankedResearchArea[]) {
    // Controls disable while a PUT is in flight, but a drag that was already
    // in progress when the save started can still drop; committing it would
    // race the full-list replace, so it is discarded like any other locked
    // edit. Checked against the mutation cache, not the rendered `saving`
    // value: a handler created before the disabling re-render could otherwise
    // slip through in the same tick as another edit's mutate().
    if (queryClient.isMutating({ mutationKey: ["put-research-area-preferences"] }) > 0) {
      return;
    }
    setPending(next);
    update.mutate(next);
  }

  return (
    <Section title="My most important issues">
      {/* Choose-then-drag, matching the actual interaction: grid cards
          select on click; only the ranked rows above the grid drag. */}
      <p className="mt-1 text-sm text-ink">
        Choose the issues that matter most to you and drag to arrange them into priority order. Choose
        &ldquo;Must&rdquo; if you will absolutely not accept a candidate or ballot measure that
        takes the opposite stance from yours.
      </p>
      <ResearchAreaPicker areas={catalog.data.research_areas} ranked={ranked} disabled={saving} onChange={save} />
      {update.isError ? (
        <div className="mt-2">
          <ErrorNotice error={update.error} />
        </div>
      ) : null}
    </Section>
  );
}

// Same card shell SettingsPage wraps its sections in; duplicated (8 lines)
// rather than imported so a component does not reach into a page module.
// The id is the scroll target for links into this section; the scroll margin
// leaves a little air above the heading when it lands at the top.
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section id={ISSUES_SECTION_ID} className="scroll-mt-4 rounded-xl border border-line bg-surface p-4">
      <h2 className="text-heading font-semibold">{title}</h2>
      {children}
    </section>
  );
}
