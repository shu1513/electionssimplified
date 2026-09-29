import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, isDecidedChoice, myDraftLabel, nearestDayDraftProgress, useElectionChoices, useMe } from "@voteapp/api-client";
import type { BallotSummary, DraftProgress, PickProgress } from "@voteapp/api-client";
import { draftPickCount, draftProgress, useBallotDraft } from "./ballotDraft";
import { usLatestLocalDate } from "./usLatestLocalDate";

// Label rules and the date grouping live in @voteapp/api-client
// (pickProgress.ts), shared with the mobile app; re-exported so this stays
// the web's one import site for pick-progress vocabulary.
export { myDraftLabel };
export type { PickProgress };

type WebPickProgress = DraftProgress;

/**
 * The signed-in header's pick counter ("My Draft 4/13" → "My Draft ✓"):
 * progress over the nearest upcoming election day on the user's saved
 * ballot — the same denominator as that day's PickDateCard. Null hides the
 * counter (logged out, unverified, ballot not loaded, no upcoming races, or
 * choices still loading) and the nav shows plain "My Picks".
 */
export function useMyPicksProgress(): WebPickProgress | null {
  const { me } = useMe();
  const verified = me?.email_verified === true;
  // Same key AND url as PicksPage's query, so a cold load of /me/picks is
  // ONE ballot request shared by header and page. Progress only counts
  // races, so the preview sort is irrelevant here — and the preview extra
  // is cheap (two batched queries server-side), which is why every page's
  // header riding it beats route-gating this hook. Deliberately NOT the
  // ["me", "ballot"] key: the saved ballot page owns that one with the
  // user's saved sort. staleTime keeps route changes from refetching.
  const ballot = useQuery({
    queryKey: ["me", "ballot", "preview"],
    queryFn: () =>
      apiRequest<BallotSummary>("/api/me/ballot?include=preview&sort=state_baseline&followed_first=false"),
    enabled: verified,
    retry: false,
    staleTime: 60_000,
  });
  const { choiceByElectionId } = useElectionChoices();
  if (!verified) {
    return null;
  }
  return nearestDayDraftProgress(ballot.data?.elections, choiceByElectionId, usLatestLocalDate());
}

/**
 * The guest counterpart of useMyPicksProgress: progress over the draft's
 * stored target day. Null until the guest has seen a ballot with an
 * upcoming date, and again once that day has passed (draftProgress). Same
 * shape as the signed-in value so the completion notice reads either one.
 */
export function useGuestPickProgress(): WebPickProgress | null {
  const draft = useBallotDraft();
  const progress = draftProgress(draft, usLatestLocalDate());
  return progress ? {
    ...progress,
    hasOpenRetention: (draft.target?.retention_ids ?? []).some((id) => !isDecidedChoice(draft.choices[id])),
  } : null;
}

/**
 * The logged-out header's draft link (the guest counterpart of "My Picks"),
 * pointing at /draft. Null — no link at all — until the guest has looked at
 * a ballot or made a pick: a first-time visitor on the address search has no
 * draft to speak of, and a dead-end nav item there is noise. Null is also
 * what the SSR pass returns (server snapshot is an empty draft), so the
 * edge-cached anonymous document stays draft-free and identical for every
 * visitor. Once live, the label shows the day's goal from the start
 * ("My Draft 0/20"), counts up, and finally takes the earned name,
 * "My Draft ✓". Same short vocabulary as the signed-in labels
 * (myDraftLabel) so the header fits one line on a 375px phone.
 */
export function useGuestDraftNav(): { to: string; label: string; complete: boolean } | null {
  const draft = useBallotDraft();
  const progress = useGuestPickProgress();
  // A loaded target owns the counter even at zero contested picks. Falling
  // through would count retention answers again in the generic pick badge.
  if (progress || (draft.target && draft.target.election_date >= usLatestLocalDate())) {
    return {
      to: "/draft",
      label: myDraftLabel(progress),
      complete: progress?.complete ?? false,
    };
  }
  // Deep-link entry: picks made on an election or candidate page without
  // ever seeing /ballot have no race denominator, so count picks instead of
  // progress. /draft handles the missing district list with its own
  // address-search fallback.
  const pickCount = draftPickCount(draft);
  if (pickCount > 0) {
    return { to: "/draft", label: `My Draft (${pickCount})`, complete: false };
  }
  // Ballot seen but no target day stored and nothing picked yet: plain
  // label, since there is no race denominator to count against.
  if (draft.district_ids.length > 0) {
    return { to: "/draft", label: "My Draft", complete: false };
  }
  return null;
}

/**
 * The guest's picked count behind the header link's label: the target
 * day's progress when there is one, else the deep-link pick count. Feeds
 * useDraftPulse, which only cares whether the number went up.
 */
export function useGuestPickedCount(): number {
  const draft = useBallotDraft();
  const progress = useGuestPickProgress();
  return progress ? progress.picked : draftPickCount(draft);
}

/**
 * The header counter's "something landed" beat: a serial that advances
 * each time the picked count RISES (a pick, an auto-fill), so the link can
 * replay a short pulse and teach where the running total lives. Never on
 * first load (no previous number to rise from), never on a removal, and a
 * null gap (choices refetching) neither pulses nor resets the baseline.
 */
export function useDraftPulse(picked: number | null): number {
  const [pulse, setPulse] = useState(0);
  const previous = useRef<number | null>(null);
  useEffect(() => {
    if (picked === null) {
      return;
    }
    if (previous.current !== null && picked > previous.current) {
      setPulse((n) => n + 1);
    }
    previous.current = picked;
  }, [picked]);
  return pulse;
}
